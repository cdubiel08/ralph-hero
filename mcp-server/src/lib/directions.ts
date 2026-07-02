/**
 * Pure ranker library for the `ralph_hero__next_actions` MCP tool.
 *
 * Computes up to N deterministic directions for a session-briefing
 * companion. All functions are side-effect free: time is injected via
 * `RankConfig.now`, no Date.now() / Math.random() are called inside the
 * module. Inputs are arrays of `DashboardItem` (already fetched + shaped
 * by `tools/dashboard-tools.ts`) plus an optional list of open PRs.
 *
 * Ranking algorithm (lower score wins):
 *
 *   score(item) =
 *       priorityScore(item.priority)       // P0=0, P1=10, P2=20, P3=30, none=99
 *     + phaseScore(item.workflowState)     // Plan in Review=0, In Review=1, Ready for Plan=2, Research Needed=3
 *     + staleBoost(item, now)              // -50 if non-lock state with updatedAt > stuckThresholdHours
 *     + lockStaleBoost(item, now)          // -100 if lock state with updatedAt > lockStaleHours
 *     + treeContinueBoost(item, allItems)  // -75 if tree-continue criteria match
 *
 *   candidates = items
 *     .filter(actionable phase OR lock-stale)
 *     .filter(no open trackedIssues blocking)        // unless candidate would be empty
 *     .sort(by score ascending)
 *     .promote(tree-continue from top-5 to slot 2 if not slot 1)
 *     .merge(open PR scores)
 *     .slice(config.limit)
 *
 * Kind precedence per item: lock-stale > tree-continue > issue.
 * PRs are scored separately and only merged into the final ranking.
 */

import type { DashboardItem } from "./dashboard.js";
import { LOCK_STATES, STATE_ORDER } from "./workflow-states.js";
import {
  AGENT_BACKLOG_FALLBACK_PENALTY,
  HUMAN_TRIAGE_DIRECTION_SCORE,
  LOCK_STALE_HOURS,
  PR_STALE_HOURS,
  RECENT_WINDOW_DAYS,
  STUCK_THRESHOLD_HOURS,
} from "./thresholds.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface OpenPR {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  /** "REVIEW_REQUIRED" | "APPROVED" | "CHANGES_REQUESTED" | null */
  reviewDecision: string | null;
  headRefName: string;
  createdAt: string;
  /** Computed at the boundary (tool entry point), not derived inside the lib. */
  ageHours: number;
}

/**
 * Structured signals describing why a direction was ranked where it was.
 * Skills should synthesize per-direction prose from these fields plus the
 * issue/PR title and any memory context — never render the legacy `reason`
 * string verbatim.
 *
 * Determinism: every field is derived from the same inputs that produced
 * the legacy `reason` template. No new wall-clock reads, no randomness.
 */
export interface DirectionSignals {
  /** Mirrors the top-level `tags` field during the deprecation window. */
  tags: string[];
  /** Days since `updatedAt` for stale issues / lock-stale items. */
  staleDays?: number;
  /**
   * Threshold (in days) used to decide whether the item is stale.
   * `config.stuckThresholdHours / 24` for non-lock items;
   * `config.lockStaleHours / 24` for lock-stale items.
   */
  staleThresholdDays?: number;
  /**
   * Number of directions sharing the top score. Set on every tied entry
   * when the top-score tie has more than one member; omitted otherwise.
   */
  tiedAtScore?: number;
  /**
   * Audience-aware estimate penalty applied to the score. Only set when
   * non-zero (i.e. `audience === "agent"` and the estimate is M / L / XL
   * / unknown).
   */
  estimateWeight?: number;
  /**
   * For `kind: "tree-continue"`: a short structured note describing why
   * the candidate participates in an active tree. Two shapes:
   *   - "sibling #NNN closed N days ago"
   *   - "candidate moved N days ago; M open siblings"
   */
  parentChainNote?: string;
  /** For `kind: "pr"`: days since the PR was created. */
  prAgeDays?: number;
  /** For `kind: "pr"`: mirrors `direction.pr.reviewDecision`. */
  prReviewDecision?: string | null;
  /** For `kind: "pr"`: issue number parsed from `feature/GH-NNNN` head-ref. */
  linkedIssueNumber?: number;
  /**
   * For `kind: "human-needed-unblock"`: age of the most recent
   * `## Unblock Request` comment, in days, rounded down (min 0).
   */
  unblockRequestAgeDays?: number;
  /**
   * For `kind: "human-needed-unblock"`: count of numbered question lines
   * (`^\d+\.\s`) in the most recent `## Unblock Request` comment body.
   */
  questionCount?: number;
  /**
   * For `kind: "triage"` aggregate directions only: count of items on the
   * board with a null `workflowState`.
   */
  statelessCount?: number;
}

export interface Direction {
  rank: number;
  /**
   * Exactly one entry has `true` (rank-1 by default). Both modes use this
   * flag for selection: interactive picker pre-selects it; headless
   * orchestrators dispatch on it.
   */
  recommended: boolean;
  kind:
    | "issue"
    | "pr"
    | "tree-continue"
    | "lock-stale"
    | "human-needed-unblock"
    | "triage";
  issue: {
    number: number;
    title: string;
    workflowState: string | null;
    priority: string | null;
    estimate: string | null;
  } | null;
  pr: {
    number: number;
    title: string;
    url: string;
    ageHours: number;
    reviewDecision: string | null;
  } | null;
  /**
   * Structured signals describing why this direction was ranked. Always
   * present. Skills consume this to synthesize prose; headless callers
   * may ignore it.
   */
  signals: DirectionSignals;
  /**
   * @deprecated Derived from signals. Removed in 2.7.0. Skills should
   * synthesize prose from signals + title + memory.
   */
  reason: string;
  /**
   * @deprecated Use signals.tags. Removed in 2.7.0.
   */
  tags: string[];
  score: number;
}

/**
 * Consumer kind for ranking. "human" (default) keeps the existing
 * presentation-friendly ordering. "agent" tilts scoring to honor the
 * autonomous-loop XS/S preference, penalizing larger estimates so
 * agent loops dispatch on bite-sized items first.
 */
export type Audience = "human" | "agent";

/**
 * Per-issue unblock signal derived from the most recent `## Unblock Request`
 * comment on a Human Needed issue. The tool layer (`directions-tools.ts`)
 * fetches issue comments for Human Needed candidates and computes these
 * signals at the boundary so the ranker stays pure.
 *
 * `unblockRequestAgeDays`: Days since the comment was posted, rounded down.
 * `questionCount`: Number of lines matching `^\d+\.\s` in the comment body.
 *
 * Only present for issues whose most recent `## Unblock Request` is newer
 * than their most recent `## Escalation`. The tool layer is responsible
 * for the newness check.
 */
export interface UnblockSignal {
  unblockRequestAgeDays: number;
  questionCount: number;
}

/**
 * Map of issue number -> unblock signal, populated for Human Needed
 * candidates that have a fresh `## Unblock Request` comment.
 */
export type UnblockSignalMap = Readonly<Record<number, UnblockSignal>>;

export interface RankConfig {
  /** Max directions to return. Default 3. */
  limit: number;
  /** Hours before a non-lock issue is considered stale. Default 48. */
  stuckThresholdHours: number;
  /** Hours before a lock-state issue is considered stalled. Default 24. */
  lockStaleHours: number;
  /** Days within which a sibling Done event still pulls a tree forward. Default 7. */
  treeRecentDoneDays: number;
  /** Hours before an open PR is considered stale (older PRs rank higher). Default 24. */
  prStaleHours: number;
  /**
   * Tilts scoring per consumer kind. "human" (default) keeps existing
   * behavior; "agent" penalizes large estimates to honor autonomous-loop
   * XS/S preference.
   */
  audience: Audience;
  /** Injected for testability — never read from the wall clock inside the lib. */
  now: Date;
  /**
   * Optional per-issue unblock signals (number -> UnblockSignal) computed by
   * the tool layer for Human Needed candidates. When an entry is present,
   * the corresponding issue surfaces as a `human-needed-unblock` direction.
   * Default: empty (no Human Needed issue produces an unblock direction).
   */
  unblockSignals?: UnblockSignalMap;
}

export const DEFAULT_RANK_CONFIG: Omit<RankConfig, "now"> = {
  limit: 3,
  stuckThresholdHours: STUCK_THRESHOLD_HOURS,
  lockStaleHours: LOCK_STALE_HOURS,
  treeRecentDoneDays: RECENT_WINDOW_DAYS,
  prStaleHours: PR_STALE_HOURS,
  audience: "human",
};

// ---------------------------------------------------------------------------
// Internal scoring constants
// ---------------------------------------------------------------------------

const ACTIONABLE_PHASES: ReadonlySet<string> = new Set([
  "Plan in Review",
  "In Review",
  "Ready for Plan",
  "Research Needed",
]);

const PHASE_RANK: Readonly<Record<string, number>> = {
  "Plan in Review": 0,
  "In Review": 1,
  "Ready for Plan": 2,
  "Research Needed": 3,
};

const PRIORITY_RANK: Readonly<Record<string, number>> = {
  P0: 0,
  P1: 10,
  P2: 20,
  P3: 30,
};

const STALE_BOOST = -50;
const LOCK_STALE_BOOST = -100;
const TREE_CONTINUE_BOOST = -75;
const PR_REVIEW_REQUIRED_BOOST = -200;
/**
 * Boost applied to a Human Needed issue carrying a fresh `## Unblock Request`
 * comment. Must be more negative than `LOCK_STALE_BOOST` so the unblock
 * direction outranks any lock-stale entry — these issues are explicitly
 * waiting for the human's attention.
 */
const HUMAN_NEEDED_UNBLOCK_BOOST = -150;

/**
 * Per-estimate penalty applied when audience === "agent". Larger items
 * cost more (positive score), pushing them down the ranking so agent
 * loops dispatch on XS/S items first.
 */
const ESTIMATE_PENALTY: Readonly<Record<string, number>> = {
  XS: 0,
  S: 0,
  M: 20,
  L: 40,
  XL: 60,
};

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function priorityScore(p: string | null): number {
  if (p === null) return 99;
  return PRIORITY_RANK[p] ?? 99;
}

function phaseScore(state: string | null): number {
  if (state === null) return 99;
  const explicit = PHASE_RANK[state];
  if (explicit !== undefined) return explicit;
  // Fallback: for actionable phases not in the explicit table, use their
  // STATE_ORDER position as a coarse tiebreaker so newly-added states
  // still rank reasonably without code changes.
  const idx = STATE_ORDER.indexOf(state);
  return idx >= 0 ? 50 + idx : 99;
}

function ageHours(updatedAt: string, now: Date): number {
  const t = new Date(updatedAt).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, (now.getTime() - t) / HOUR_MS);
}

function ageDays(updatedAt: string, now: Date): number {
  const t = new Date(updatedAt).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, (now.getTime() - t) / DAY_MS);
}

function hasOpenBlockers(item: DashboardItem): boolean {
  return item.blockedBy.some(
    (b) => b.workflowState !== "Done" && b.workflowState !== "Canceled",
  );
}

function isLockState(state: string | null): boolean {
  return state !== null && LOCK_STATES.includes(state);
}

/**
 * Returns a positive score adjustment when audience === "agent" so larger
 * estimates get pushed down the ranking. Returns 0 for human audience
 * (existing behavior). Items with unknown estimate get a mid-tier penalty
 * (30) so unestimated work doesn't accidentally outrank XS/S items.
 */
function audiencePenalty(item: DashboardItem, audience: Audience): number {
  if (audience !== "agent") return 0;
  const est = item.estimate;
  if (est === null || est === undefined) return 30; // unknown: mid penalty
  return ESTIMATE_PENALTY[est] ?? 30;
}

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when the candidate is in a lock state and its updatedAt
 * timestamp is older than `config.lockStaleHours`. These items are surfaced
 * as `kind: "lock-stale"` so the user is reminded to unstick them.
 */
export function detectLockStale(item: DashboardItem, config: RankConfig): boolean {
  if (!isLockState(item.workflowState)) return false;
  return ageHours(item.updatedAt, config.now) >= config.lockStaleHours;
}

/**
 * Returns true when the candidate participates in an "active tree" — i.e.
 * something in its sibling group recently moved or it itself moved while
 * other siblings remain open. False when there is no parent edge or the
 * parent is closed (CLOSED state means tree is finished).
 *
 * Criteria (any one positive):
 *   (a) A sibling has closedAt within `treeRecentDoneDays`.
 *   (b) The candidate itself has updatedAt within `treeRecentDoneDays`,
 *       its parent is open, and at least one other open sibling exists.
 */
export function detectTreeContinue(
  item: DashboardItem,
  allItems: DashboardItem[],
  config: RankConfig,
): boolean {
  const parent = item.parentNumber ?? null;
  if (parent === null || parent === undefined) return false;

  // Parent done -> tree is finished, do not surface.
  // GitHub raw state arrives as "OPEN" / "CLOSED"; defensively also accept
  // workflow-state strings.
  const parentState = item.parentState ?? null;
  if (
    parentState === "CLOSED" ||
    parentState === "Done" ||
    parentState === "Canceled"
  ) {
    return false;
  }

  const siblings = allItems.filter(
    (other) =>
      other.number !== item.number && other.parentNumber === parent,
  );

  // (a) sibling closed within window
  for (const sib of siblings) {
    if (sib.closedAt) {
      const days = ageDays(sib.closedAt, config.now);
      if (days <= config.treeRecentDoneDays) return true;
    }
  }

  // (b) candidate moved recently AND has open siblings
  const candidateRecentlyMoved =
    ageDays(item.updatedAt, config.now) <= config.treeRecentDoneDays;
  if (!candidateRecentlyMoved) return false;

  const openSiblings = siblings.filter(
    (sib) =>
      sib.closedAt === null &&
      sib.workflowState !== "Done" &&
      sib.workflowState !== "Canceled",
  );
  return openSiblings.length > 0;
}

/**
 * Compute a structured note describing which `detectTreeContinue` branch
 * fired and the supporting evidence. Returns `null` if the candidate is
 * not actually a tree-continue match (caller should not have called this).
 *
 * Two shapes (matching `detectTreeContinue`'s rule order):
 *   - rule (a): "sibling #NNN closed N day(s) ago"
 *   - rule (b): "candidate moved N day(s) ago; M open sibling(s)"
 */
function buildParentChainNote(
  item: DashboardItem,
  allItems: DashboardItem[],
  config: RankConfig,
): string | null {
  const parent = item.parentNumber ?? null;
  if (parent === null || parent === undefined) return null;

  const siblings = allItems.filter(
    (other) =>
      other.number !== item.number && other.parentNumber === parent,
  );

  // Rule (a): find the most-recently-closed sibling within the window
  // (deterministic: pick the one with the smallest sibling number among
  // those tied on closedAt, matching the natural source order).
  let closestSibling: { number: number; days: number } | null = null;
  for (const sib of siblings) {
    if (!sib.closedAt) continue;
    const days = ageDays(sib.closedAt, config.now);
    if (days > config.treeRecentDoneDays) continue;
    const dayInt = Math.max(1, Math.floor(days));
    if (
      closestSibling === null ||
      dayInt < closestSibling.days ||
      (dayInt === closestSibling.days && sib.number < closestSibling.number)
    ) {
      closestSibling = { number: sib.number, days: dayInt };
    }
  }
  if (closestSibling !== null) {
    const dayLabel = closestSibling.days === 1 ? "day" : "days";
    return `sibling #${closestSibling.number} closed ${closestSibling.days} ${dayLabel} ago`;
  }

  // Rule (b): candidate-moved branch
  const candidateDays = Math.max(
    1,
    Math.floor(ageDays(item.updatedAt, config.now)),
  );
  const openSiblings = siblings.filter(
    (sib) =>
      sib.closedAt === null &&
      sib.workflowState !== "Done" &&
      sib.workflowState !== "Canceled",
  );
  if (openSiblings.length === 0) return null;
  const dayLabel = candidateDays === 1 ? "day" : "days";
  const sibLabel = openSiblings.length === 1 ? "sibling" : "siblings";
  return `candidate moved ${candidateDays} ${dayLabel} ago; ${openSiblings.length} open ${sibLabel}`;
}

// ---------------------------------------------------------------------------
// scoreIssue
// ---------------------------------------------------------------------------

/**
 * Score a single dashboard item. Returns the winning kind for this candidate
 * in precedence order:
 *
 *   has unblock signal (Human Needed) -> kind: "human-needed-unblock"
 *   else detectLockStale(item) -> kind: "lock-stale"
 *   else detectTreeContinue(item) -> kind: "tree-continue"
 *   else -> kind: "issue"
 *
 * `tags[]` carries descriptive signals (e.g. "stale", "high-priority",
 * "blocked"). `signals` carries the structured per-direction explanation
 * (staleDays, parentChainNote, estimateWeight, etc.) that skills use to
 * synthesize prose without rendering the legacy `reason` template
 * verbatim.
 *
 * PR ranking is handled separately by `rankDirections` — this function
 * never returns kind "pr".
 */
export function scoreIssue(
  item: DashboardItem,
  allItems: DashboardItem[],
  config: RankConfig,
): {
  score: number;
  kind: Exclude<Direction["kind"], "pr">;
  tags: string[];
  signals: DirectionSignals;
} {
  const tags: string[] = [];

  let score = priorityScore(item.priority) + phaseScore(item.workflowState);

  // Audience-aware estimate penalty (no-op for "human"; pushes XL items
  // down for "agent" so autonomous loops favor XS/S work).
  const estPenalty = audiencePenalty(item, config.audience);
  score += estPenalty;

  // Human Needed + fresh `## Unblock Request` comment takes precedence over
  // every other detection. The signal is computed at the tool boundary.
  const unblockSignal =
    item.workflowState === "Human Needed"
      ? config.unblockSignals?.[item.number]
      : undefined;

  if (unblockSignal !== undefined) {
    score += HUMAN_NEEDED_UNBLOCK_BOOST;
    tags.push("unblock-requested");
    if (item.priority === "P0" || item.priority === "P1") {
      tags.push("high-priority");
    }
    if (hasOpenBlockers(item)) {
      tags.push("blocked");
    }
    const signals: DirectionSignals = {
      tags: [...tags],
      unblockRequestAgeDays: unblockSignal.unblockRequestAgeDays,
      questionCount: unblockSignal.questionCount,
    };
    if (estPenalty > 0) {
      signals.estimateWeight = estPenalty;
    }
    return { score, kind: "human-needed-unblock", tags, signals };
  }

  const lockStale = detectLockStale(item, config);
  const treeContinue = detectTreeContinue(item, allItems, config);

  // Stale boost (non-lock states only)
  const isStale =
    !isLockState(item.workflowState) &&
    ageHours(item.updatedAt, config.now) >= config.stuckThresholdHours;
  if (isStale) {
    score += STALE_BOOST;
    tags.push("stale");
  }

  if (lockStale) {
    score += LOCK_STALE_BOOST;
    tags.push("stalled");
  }

  if (treeContinue) {
    score += TREE_CONTINUE_BOOST;
    tags.push("tree");
  }

  // Descriptive-only tags
  if (item.priority === "P0" || item.priority === "P1") {
    tags.push("high-priority");
  }
  if (hasOpenBlockers(item)) {
    tags.push("blocked");
  }

  // Pick winning kind in precedence order
  let kind: Exclude<Direction["kind"], "pr">;
  if (lockStale) {
    kind = "lock-stale";
  } else if (treeContinue) {
    kind = "tree-continue";
  } else {
    kind = "issue";
  }

  // Compute structured signals for skills to synthesize prose. tiedAtScore
  // is added later by rankDirections after the post-sort pass.
  const signals: DirectionSignals = { tags: [...tags] };

  if (kind === "lock-stale") {
    const days = Math.max(
      1,
      Math.floor(ageHours(item.updatedAt, config.now) / 24),
    );
    signals.staleDays = days;
    signals.staleThresholdDays = config.lockStaleHours / 24;
  } else {
    // For non-lock items, surface the threshold informationally and
    // populate staleDays only when the stale tag fired.
    signals.staleThresholdDays = config.stuckThresholdHours / 24;
    if (isStale) {
      const days = Math.max(
        1,
        Math.floor(ageHours(item.updatedAt, config.now) / 24),
      );
      signals.staleDays = days;
    }
  }

  if (estPenalty > 0) {
    signals.estimateWeight = estPenalty;
  }

  if (kind === "tree-continue") {
    const note = buildParentChainNote(item, allItems, config);
    if (note !== null) {
      signals.parentChainNote = note;
    }
  }

  return { score, kind, tags, signals };
}

// ---------------------------------------------------------------------------
// PR scoring
// ---------------------------------------------------------------------------

interface PRScored {
  pr: OpenPR;
  score: number;
  reason: string;
  tags: string[];
  /** Issue number parsed from a `feature/GH-NNNN` head-ref, if present. */
  linkedIssueNumber: number | null;
  /** Structured signals for the skill to synthesize prose. */
  signals: DirectionSignals;
}

function parseIssueNumberFromHeadRef(headRefName: string): number | null {
  // Match "GH-42" or "GH-0042" anywhere in the ref.
  const m = headRefName.match(/GH-0*(\d+)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function scorePR(pr: OpenPR, config: RankConfig): PRScored | null {
  // Drafts are excluded from ranking entirely.
  if (pr.isDraft) return null;

  // APPROVED PRs are not surfaced — they are waiting on merge, not user
  // attention. CHANGES_REQUESTED also skipped (author needs to push fixes,
  // not the briefing user).
  if (pr.reviewDecision === "APPROVED") return null;

  const tags: string[] = [];
  let score = 0;

  if (pr.reviewDecision === "REVIEW_REQUIRED") {
    score += PR_REVIEW_REQUIRED_BOOST;
    tags.push("needs-review");
  }

  // Older PRs rank slightly higher (more negative) than fresher ones.
  // 1 point per hour beyond prStaleHours, capped at -50 to keep them from
  // dominating REVIEW_REQUIRED items already at -200.
  if (pr.ageHours > config.prStaleHours) {
    const extra = Math.min(50, pr.ageHours - config.prStaleHours);
    score -= extra;
    tags.push("stale");
  }

  // PRs that did not pick up a boost (no review required, fresh) should
  // not surface — they are work-in-progress noise.
  if (score === 0) return null;

  const linkedIssueNumber = parseIssueNumberFromHeadRef(pr.headRefName);

  const signals: DirectionSignals = {
    tags: [...tags],
    prAgeDays: Math.max(1, Math.floor(pr.ageHours / 24)),
    prReviewDecision: pr.reviewDecision,
  };
  if (linkedIssueNumber !== null) {
    signals.linkedIssueNumber = linkedIssueNumber;
  }

  return {
    pr,
    score,
    reason: "", // filled in by buildReason at finalization time
    tags,
    linkedIssueNumber,
    signals,
  };
}

// ---------------------------------------------------------------------------
// buildReason
// ---------------------------------------------------------------------------

/**
 * Render a single-sentence prose reason for a direction. Distinct shapes
 * per kind so the output reads as natural English rather than
 * template-y. No trailing period — the consumer wraps the sentence into
 * a paragraph at presentation time.
 *
 * @deprecated Reason strings are derived from signals for back-compat.
 * Skills should synthesize prose from signals directly. Removed in 2.7.0.
 */
export function buildReason(
  kind: Direction["kind"],
  issue: DashboardItem | null,
  pr: OpenPR | null,
  signals: DirectionSignals,
  config: RankConfig,
  linkedIssueNumber: number | null = null,
): string {
  const tags = signals.tags;

  if (kind === "pr" && pr) {
    const days = Math.max(1, Math.floor(pr.ageHours / 24));
    const dayLabel = days === 1 ? "day" : "days";
    if (pr.reviewDecision === "REVIEW_REQUIRED") {
      const linkClause =
        linkedIssueNumber !== null
          ? ` (issue #${linkedIssueNumber})`
          : "";
      return `PR #${pr.number} needs review${linkClause} — open ${days} ${dayLabel}`;
    }
    return `PR #${pr.number} has been open ${days} ${dayLabel} without movement`;
  }

  if (!issue) return "Unknown direction";

  if (kind === "human-needed-unblock") {
    const days = signals.unblockRequestAgeDays ?? 0;
    const dayLabel = days === 1 ? "day" : "days";
    const qCount = signals.questionCount ?? 0;
    const qLabel = qCount === 1 ? "question" : "questions";
    if (days === 0) {
      return `Human Needed — ${qCount} unblock ${qLabel} waiting (posted today)`;
    }
    return `Human Needed — ${qCount} unblock ${qLabel} waiting since ${days} ${dayLabel} ago`;
  }

  if (kind === "lock-stale") {
    const hours = Math.round(ageHours(issue.updatedAt, config.now));
    const days = Math.max(1, Math.floor(hours / 24));
    const dayLabel = days === 1 ? "day" : "days";
    return `Stuck in ${issue.workflowState} for ${days} ${dayLabel} — may be blocked`;
  }

  if (kind === "tree-continue") {
    return `#${issue.number} is part of an active tree — keep it moving before starting something new`;
  }

  // kind === "issue"
  const phase = issue.workflowState ?? "Backlog";
  if (tags.includes("stale")) {
    const hours = Math.round(ageHours(issue.updatedAt, config.now));
    const days = Math.max(1, Math.floor(hours / 24));
    const dayLabel = days === 1 ? "day" : "days";
    const priority = issue.priority;
    if (priority === "P0") {
      return `P0 stalled in ${phase} for ${days} ${dayLabel} — top of the queue`;
    }
    if (priority === "P1") {
      return `P1 stalled in ${phase} for ${days} ${dayLabel} — likely the most unblocking thing`;
    }
    if (priority === "P2") {
      return `Sitting in ${phase} for ${days} ${dayLabel} — small unblock if you have a moment`;
    }
    if (priority === "P3") {
      return `Low-priority item in ${phase} for ${days} ${dayLabel}`;
    }
    return `Unprioritized in ${phase} for ${days} ${dayLabel}`;
  }
  if (issue.priority === "P0") {
    return `P0 in ${phase} — top of the queue`;
  }
  if (issue.priority === "P1") {
    return `P1 in ${phase} — worth a look`;
  }
  return `${phase} — next in line`;
}

// ---------------------------------------------------------------------------
// rankDirections — main entry point
// ---------------------------------------------------------------------------

interface ScoredCandidate {
  item: DashboardItem;
  score: number;
  kind: Exclude<Direction["kind"], "pr">;
  tags: string[];
  signals: DirectionSignals;
}

function isCandidatePhase(state: string | null): boolean {
  if (state === null) return false;
  return ACTIONABLE_PHASES.has(state);
}

function toDirectionIssue(item: DashboardItem): Direction["issue"] {
  return {
    number: item.number,
    title: item.title,
    workflowState: item.workflowState,
    priority: item.priority,
    estimate: item.estimate,
  };
}

function toDirectionPR(pr: OpenPR): Direction["pr"] {
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    ageHours: pr.ageHours,
    reviewDecision: pr.reviewDecision,
  };
}

/**
 * Main entry point. Filters, scores, sorts, and slices a candidate set
 * into up to `config.limit` deterministically-ranked directions.
 *
 * Determinism contract: same input + same `config.now` -> byte-identical
 * output across calls. Achieved by:
 *   - never reading `Date.now()` inside the lib
 *   - using stable secondary sort keys (issue number / PR number)
 *   - never iterating Sets/Maps for ordered work
 */
export function rankDirections(
  items: DashboardItem[],
  openPRs: OpenPR[],
  config: RankConfig,
): Direction[] {
  // 1. Score all items first so we know which ones lock-stale (those go in
  //    the candidate set even if their phase is not actionable). Human
  //    Needed items also pass the filter when an unblock signal exists for
  //    them — surfacing them as `human-needed-unblock` directions.
  const scored: ScoredCandidate[] = [];
  for (const item of items) {
    const isLockStale = detectLockStale(item, config);
    const hasUnblockSignal =
      item.workflowState === "Human Needed" &&
      config.unblockSignals !== undefined &&
      config.unblockSignals[item.number] !== undefined;
    const passesPhaseFilter =
      isCandidatePhase(item.workflowState) || isLockStale || hasUnblockSignal;
    if (!passesPhaseFilter) continue;

    const { score, kind, tags, signals } = scoreIssue(item, items, config);
    scored.push({ item, score, kind, tags, signals });
  }

  // 1b. Phase fallback for autonomous audience: when no items passed the
  //     standard phase filter, widen the candidate set to include items in
  //     `Backlog` and items with a null `workflowState`. This restores
  //     autopilot's ability to clear a Backlog-heavy board. Fallback items
  //     get +AGENT_BACKLOG_FALLBACK_PENALTY so they always rank below any
  //     actionable-phase item — they surface only when the actionable pool
  //     is empty. Mirrors the blocker fallback in step 2.
  if (config.audience === "agent" && scored.length === 0) {
    for (const item of items) {
      if (item.workflowState !== "Backlog" && item.workflowState !== null) {
        continue;
      }
      // Defense-in-depth: skip blocked items in the fallback loop so a
      // dependency-blocked Backlog issue never enters scored even when the
      // primary filter (step 2 below) would catch it anyway.
      if (hasOpenBlockers(item)) {
        continue;
      }
      const { score, kind, tags, signals } = scoreIssue(item, items, config);
      scored.push({
        item,
        score: score + AGENT_BACKLOG_FALLBACK_PENALTY,
        kind,
        tags,
        signals,
      });
    }
  }

  // 2. Drop blocked items unless that would empty the candidate set.
  const unblocked = scored.filter((s) => !hasOpenBlockers(s.item));
  let candidates: ScoredCandidate[];
  if (unblocked.length > 0) {
    candidates = unblocked;
  } else if (scored.length > 0) {
    // Surface the blocked candidates so the briefing isn't silent. Tags
    // already include "blocked" via scoreIssue.
    candidates = scored;
  } else {
    candidates = [];
  }

  // 3. Score PRs.
  const prScored: PRScored[] = [];
  for (const pr of openPRs) {
    const s = scorePR(pr, config);
    if (s) prScored.push(s);
  }

  // 4. Merge issues + PRs into a single ordered list (stable sort:
  //    score asc, then a kind tiebreaker, then number asc).
  type Entry =
    | { kind: "issueRow"; payload: ScoredCandidate }
    | { kind: "prRow"; payload: PRScored };

  const merged: Entry[] = [];
  for (const c of candidates) merged.push({ kind: "issueRow", payload: c });
  // Filter unlinkable PRs (no linked issue) so they don't appear in next_actions.
  // These are handled by the pr-drain Routine (out of band of Director).
  // See: thoughts/shared/research/2026-05-22-pr-drain-routine-design.md
  for (const p of prScored) {
    if (p.linkedIssueNumber === null) continue;
    merged.push({ kind: "prRow", payload: p });
  }

  merged.sort((a, b) => {
    const scoreA = a.kind === "issueRow" ? a.payload.score : a.payload.score;
    const scoreB = b.kind === "issueRow" ? b.payload.score : b.payload.score;
    if (scoreA !== scoreB) return scoreA - scoreB;
    // Secondary: PRs before issues at the same score (PRs are usually
    // higher-urgency action items: "merge or reply" beats "consider").
    if (a.kind !== b.kind) return a.kind === "prRow" ? -1 : 1;
    if (a.kind === "issueRow" && b.kind === "issueRow") {
      return a.payload.item.number - b.payload.item.number;
    }
    if (a.kind === "prRow" && b.kind === "prRow") {
      return a.payload.pr.number - b.payload.pr.number;
    }
    return 0;
  });

  // 5. Tree-continue promotion: if a tree-continue is anywhere in the
  //    top 5 of the merged list but not in slot 1, promote it to slot 2.
  if (merged.length >= 2) {
    const slot1IsTreeContinue =
      merged[0].kind === "issueRow" &&
      merged[0].payload.kind === "tree-continue";
    if (!slot1IsTreeContinue) {
      const limitToScan = Math.min(5, merged.length);
      let treeIdx = -1;
      for (let i = 1; i < limitToScan; i++) {
        const e = merged[i];
        if (e.kind === "issueRow" && e.payload.kind === "tree-continue") {
          treeIdx = i;
          break;
        }
      }
      if (treeIdx > 1) {
        const [moved] = merged.splice(treeIdx, 1);
        merged.splice(1, 0, moved);
      }
    }
  }

  // 6. Slice to limit and assign rank.
  const sliced = merged.slice(0, Math.max(0, config.limit));

  // 6a. Compute tied-at-top-score count from the sliced (final) list so the
  //     tie reflects what the user actually sees. Stamped onto each entry's
  //     signals only when the count is > 1; omitted otherwise.
  const tiedCount =
    sliced.length === 0
      ? 0
      : sliced.filter((entry) => {
          const s = entry.kind === "issueRow" ? entry.payload.score : entry.payload.score;
          const top = sliced[0].kind === "issueRow" ? sliced[0].payload.score : sliced[0].payload.score;
          return s === top;
        }).length;

  const directions: Direction[] = sliced.map((entry, idx) => {
    const rank = idx + 1;
    if (entry.kind === "issueRow") {
      const c = entry.payload;
      const signals: DirectionSignals = { ...c.signals };
      if (tiedCount > 1 && c.score === sliced[0].payload.score) {
        signals.tiedAtScore = tiedCount;
      }
      const reason = buildReason(c.kind, c.item, null, signals, config, null);
      return {
        rank,
        recommended: false,
        kind: c.kind,
        issue: toDirectionIssue(c.item),
        pr: null,
        signals,
        reason,
        tags: c.tags,
        score: c.score,
      };
    }
    // PR row
    const p = entry.payload;
    const signals: DirectionSignals = { ...p.signals };
    if (tiedCount > 1 && p.score === sliced[0].payload.score) {
      signals.tiedAtScore = tiedCount;
    }
    const reason = buildReason(
      "pr",
      null,
      p.pr,
      signals,
      config,
      p.linkedIssueNumber,
    );
    return {
      rank,
      recommended: false,
      kind: "pr",
      issue: null,
      pr: toDirectionPR(p.pr),
      signals,
      reason,
      tags: p.tags,
      score: p.score,
    };
  });

  // Mark the top-ranked entry as recommended. Both modes use this
  // flag for selection: interactive picker pre-selects it; headless
  // orchestrators dispatch on it.
  if (directions.length > 0) {
    directions[0].recommended = true;
  }

  // 7. Human-audience aggregate triage fallback: when the human scan finds
  //    nothing actionable (no scored issues, no PRs, no lock-stale, no
  //    unblock signal — checked pre-slice via `merged` so a small `limit`
  //    cannot masquerade as an empty board) and at least one OPEN item on
  //    the board has a null `workflowState`, surface a single aggregate
  //    direction pointing at `/ralph:caretake --mode triage` instead of an
  //    empty list. This is the human-audience counterpart to the agent-only
  //    Backlog/null-state fallback above (step 1b) — it never fires when
  //    any real direction exists, never fires when the caller asked for
  //    zero directions (`limit: 0`), skips already-closed stateless items,
  //    and never includes Backlog items (Backlog is a legitimate,
  //    dashboard-visible parking state).
  if (config.audience === "human" && merged.length === 0 && config.limit > 0) {
    const statelessCount = items.filter(
      (i) => i.workflowState === null && i.closedAt === null,
    ).length;
    if (statelessCount > 0) {
      directions.push({
        rank: 1,
        recommended: true,
        kind: "triage",
        issue: null,
        pr: null,
        signals: { tags: ["stateless-triage"], statelessCount },
        reason:
          statelessCount === 1
            ? "1 item has no workflow state — run /ralph:caretake --mode triage"
            : `${statelessCount} items have no workflow state — run /ralph:caretake --mode triage`,
        tags: ["stateless-triage"],
        score: HUMAN_TRIAGE_DIRECTION_SCORE,
      });
    }
  }

  return directions;
}
