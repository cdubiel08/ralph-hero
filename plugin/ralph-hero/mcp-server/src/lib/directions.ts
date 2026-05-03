/**
 * Pure ranker library for the `ralph_hero__hello_directions` MCP tool.
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

export interface Direction {
  rank: number;
  /**
   * Exactly one entry has `true` (rank-1 by default). Both modes use this
   * flag for selection: interactive picker pre-selects it; headless
   * orchestrators dispatch on it.
   */
  recommended: boolean;
  kind: "issue" | "pr" | "tree-continue" | "lock-stale";
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
  reason: string;
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
}

export const DEFAULT_RANK_CONFIG: Omit<RankConfig, "now"> = {
  limit: 3,
  stuckThresholdHours: 48,
  lockStaleHours: 24,
  treeRecentDoneDays: 7,
  prStaleHours: 24,
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

// ---------------------------------------------------------------------------
// scoreIssue
// ---------------------------------------------------------------------------

/**
 * Score a single dashboard item. Returns the winning kind for this candidate
 * in precedence order:
 *
 *   detectLockStale(item) -> kind: "lock-stale"
 *   else detectTreeContinue(item) -> kind: "tree-continue"
 *   else -> kind: "issue"
 *
 * `tags[]` carries descriptive signals (e.g. "stale", "high-priority",
 * "blocked") that did NOT win the kind slot but still shape the prose
 * `reason` rendered by `buildReason`.
 *
 * PR ranking is handled separately by `rankDirections` — this function
 * never returns kind "pr".
 */
export function scoreIssue(
  item: DashboardItem,
  allItems: DashboardItem[],
  config: RankConfig,
): { score: number; kind: Exclude<Direction["kind"], "pr">; tags: string[] } {
  const tags: string[] = [];

  let score = priorityScore(item.priority) + phaseScore(item.workflowState);

  // Audience-aware estimate penalty (no-op for "human"; pushes XL items
  // down for "agent" so autonomous loops favor XS/S work).
  score += audiencePenalty(item, config.audience);

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

  return { score, kind, tags };
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

  return {
    pr,
    score,
    reason: "", // filled in by buildReason at finalization time
    tags,
    linkedIssueNumber,
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
 */
export function buildReason(
  kind: Direction["kind"],
  issue: DashboardItem | null,
  pr: OpenPR | null,
  tags: string[],
  config: RankConfig,
  linkedIssueNumber: number | null = null,
): string {
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
  //    the candidate set even if their phase is not actionable).
  const scored: ScoredCandidate[] = [];
  for (const item of items) {
    const isLockStale = detectLockStale(item, config);
    const passesPhaseFilter = isCandidatePhase(item.workflowState) || isLockStale;
    if (!passesPhaseFilter) continue;

    const { score, kind, tags } = scoreIssue(item, items, config);
    scored.push({ item, score, kind, tags });
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
  for (const p of prScored) merged.push({ kind: "prRow", payload: p });

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

  const directions: Direction[] = sliced.map((entry, idx) => {
    const rank = idx + 1;
    if (entry.kind === "issueRow") {
      const c = entry.payload;
      const reason = buildReason(c.kind, c.item, null, c.tags, config, null);
      return {
        rank,
        recommended: false,
        kind: c.kind,
        issue: toDirectionIssue(c.item),
        pr: null,
        reason,
        tags: c.tags,
        score: c.score,
      };
    }
    // PR row
    const p = entry.payload;
    const reason = buildReason(
      "pr",
      null,
      p.pr,
      p.tags,
      config,
      p.linkedIssueNumber,
    );
    return {
      rank,
      recommended: false,
      kind: "pr",
      issue: null,
      pr: toDirectionPR(p.pr),
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

  return directions;
}
