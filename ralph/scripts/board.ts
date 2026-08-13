/**
 * board.ts — the sole sanctioned mutation path for the ralph v2 board.
 *
 * Design (normative): thoughts/shared/ideas/2026-07-31-ralph-v2-minimal-harness.md
 * Plan: thoughts/shared/plans/2026-07-31-GH-1662-ralph-v2-minimal-harness.md
 *
 * Invariants carried here, not in prose:
 *   - transition legality checked against live state in the same invocation
 *   - claim = "{holder}[+{holder2}...]|{iso8601}" in the Claim text field
 *     (ClaimV2, contracts.ts — one holder is byte-identical to the v1 wire
 *     format); TTL is the only side door — there is deliberately NO --force
 *     flag anywhere in this CLI
 *   - scope check: the configured owner/repo must match `git remote get-url origin`
 *   - every mutation echoes the resulting state (per-write proof-of-fire)
 *   - `get` reads exactly the fields `move`/`claim` write (parity)
 *
 * Run: ralph/scripts/board <cmd> ...   (shim: bun > local tsx > npx tsx)
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  addHolder,
  BOARD_STATES,
  type BranchKind,
  branchKindFor,
  CLAIM_MAX_HOLDERS,
  type ClaimV2,
  CONTRACT_IDS,
  type ContractId,
  DELIVER_REASONS,
  formatAgentName,
  formatBranchName,
  parseBranchName,
  worktreeLeaf,
  emitJsonSchemas,
  formatClaim,
  heartbeat,
  isContractId,
  isMember,
  isValidHolder,
  type Lane,
  LANE_CHARS,
  type LiveLintDeps,
  parseClaim,
  removeHolder,
  runLints,
  TEND_CATEGORIES,
  validateContract,
} from "./contracts.js";

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

/** Aliased from contracts.ts — the single declaration (the C2/C6 schemas use
 *  the same tuple, so the machine and the contracts cannot drift). Declared
 *  there rather than here only because this file imports contracts.ts. */
export const STATES = BOARD_STATES;
export type State = (typeof STATES)[number];

/** Legal transitions. Done/Canceled have NO move edges — the only exit is
 *  `reopen`, which also reopens the GitHub issue (a bare move would leave a
 *  closed issue sitting in Backlog, invisible to list/next).
 *
 *  `Backlog → Done` is legal (GH-1777): work already delivered by some other
 *  path needs a *gated* close. Its absence never guarded anything — the Done
 *  gates below key on the destination, not on `from`, so the mover still owes
 *  a merged linked PR or an explicit `--why`, and an apply unit still owes
 *  `ralph-apply-evidence:v1` with no escape. All it did was divert that
 *  traffic to `reconcile`, which writes the state field directly and runs no
 *  gate at all.
 *
 *  `Backlog → Human Needed` is deliberately NOT legal. Human Needed is a pause
 *  on in-flight work: `answer` moves it back to In Progress and owns that edge
 *  alone. A proposal about an unstarted item is terminal-answered, not
 *  resumed — it files as a `<!-- ralph-tend:v1 proposed -->` marker comment
 *  (surfaced by `tend-queue`), not as a state. */
export const MACHINE: Record<State, readonly State[]> = {
  Backlog: ["In Progress", "Done", "Canceled"],
  "In Progress": ["In Review", "Human Needed", "Backlog", "Canceled"],
  "In Review": ["Done", "In Progress", "Human Needed", "Canceled"],
  "Human Needed": ["In Progress", "Backlog", "Canceled"],
  Done: [],
  Canceled: [],
};

/** Legacy (v1) states. The 11→6 collapse ran in GH-1662; these linger only as
 *  Workflow State field options the API cannot delete, so `doctor` and `setup`
 *  still surface them. */
export const LEGACY_STATES = [
  "Research Needed",
  "Research in Progress",
  "Ready for Plan",
  "Plan in Progress",
  "Plan in Review",
] as const;

/** Best-effort sync to the built-in Status field (UI coherence only). */
export const STATUS_SYNC: Record<State, string> = {
  Backlog: "Todo",
  "In Progress": "In Progress",
  "In Review": "In Progress",
  "Human Needed": "In Progress",
  Done: "Done",
  Canceled: "Done",
};

export function isState(s: string): s is State {
  return (STATES as readonly string[]).includes(s);
}

export function legalTransition(from: State, to: State): boolean {
  return MACHINE[from].includes(to);
}

/** Human-friendly state arg: "in-progress" / "In Progress" / "wip" all resolve. */
export function parseStateArg(raw: string): State | null {
  const norm = raw.trim().toLowerCase().replace(/[-_]+/g, " ");
  const aliases: Record<string, State> = {
    backlog: "Backlog",
    "in progress": "In Progress",
    wip: "In Progress",
    "in review": "In Review",
    review: "In Review",
    "human needed": "Human Needed",
    human: "Human Needed",
    blocked: "Human Needed",
    done: "Done",
    canceled: "Canceled",
    cancelled: "Canceled",
  };
  return aliases[norm] ?? null;
}

// ---------------------------------------------------------------------------
// Claims — ClaimV2 (contracts.ts): wire = "h1+h2+...|iso8601", 1..8 holders,
// ONE shared since. A single holder serializes byte-identically to the v1
// "{holder}|{iso}" format, so existing boards read back unchanged. Parse/
// format/membership live in contracts.ts (the herdr fleet shares them); TTL
// and staleness stay HERE — board.ts owns time semantics against that one
// shared timestamp, and any member's heartbeat refreshes it.
// ---------------------------------------------------------------------------

export type Claim = ClaimV2;
export { addHolder, CLAIM_MAX_HOLDERS, formatClaim, heartbeat, isMember, parseClaim, removeHolder } from "./contracts.js";

/** Single-holder encode — the spawn/steal path's convenience over formatClaim
 *  (byte-identical to the v1 wire format for one holder). */
export function encodeClaim(holder: string, since: Date): string {
  return formatClaim({ holders: [holder], since });
}

export function claimAgeMin(claim: Claim, now: Date): number {
  return (now.getTime() - claim.since.getTime()) / 60_000;
}

export function claimIsStale(claim: Claim, now: Date, ttlMin: number): boolean {
  return claimAgeMin(claim, now) >= ttlMin;
}

/** Fraction of the TTL that must have elapsed before a refused claim names the
 *  expiry clock time. Below it, the refusal stays as-is: losing a race to a
 *  genuinely fresh claim is the healthy outcome of the no-CAS protocol, and
 *  pointing at `--steal` there would manufacture the eviction pressure the TTL
 *  exists to avoid. */
export const CLAIM_HINT_TTL_FRACTION = 0.75;

/** Late in the TTL (strictly past the fraction) but not yet stale — the only
 *  window where naming the expiry is both new information and honest. */
export function claimHintDue(claim: Claim, now: Date, ttlMin: number): boolean {
  const age = claimAgeMin(claim, now);
  return age > ttlMin * CLAIM_HINT_TTL_FRACTION && age < ttlMin;
}

export function claimExpiry(claim: Claim, ttlMin: number): Date {
  return new Date(claim.since.getTime() + ttlMin * 60_000);
}

/** Local-time HH:MM. The expiry hint only fires inside the final quarter of the
 *  TTL, so the time it names is always minutes away — a date would be noise. */
export function formatLocalHm(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Queue ranking
// ---------------------------------------------------------------------------

/** Fields every queue read returns, whatever it selected (GH-1803). */
export interface QueueItemCore {
  number: number;
  repo: string; // nameWithOwner — the board is cross-repo capable
  title: string;
  state: string;
  priority: string | null; // "P0".."P3"
  hasParent: boolean; // ANY parent (repo-blind) — the ranker's tie-break
  /** Parent's issue number when the parent is in the OWN repo, else null.
   *  Fail-closed partitioning: a cross-repo parent must never let a foreign
   *  #N bind to an own-repo root when the tree is rebuilt from these edges. */
  parentNumber: number | null;
  /** Set by rankNext when this item was promoted into an epic root's queue
   *  position: the root it serves. Ranking output only, never fetched. */
  via?: number;
  /** Set by rankNext on an epic root whose children are all blocked: the
   *  blockage to clear instead of implementing the root wholesale. */
  childrenBlocked?: number[];
  fieldValuesTruncated: boolean; // fail closed: state/claim reads unreliable = not eligible
  claim: Claim | null;
  claimRaw: string | null; // raw Claim text — non-null with claim null = garbled (hand-edited)
  // Tend-lane inputs (GH-1712) — optional so pure-ranking fixtures stay terse;
  // listItemsFull always populates them.
  updatedAt?: string | null;
  createdAt?: string | null;
  estimate?: string | null;
}

/** Everything the `labels` connection carries. Omitted as a GROUP: a read
 *  that skipped the connection has no label list AND no truncation verdict. */
export interface QueueItemLabelParts {
  labels: string[]; // issue labels — apply-kind detection without a second round trip
  labelsTruncated: boolean; // fail closed: a truncated label list counts as apply-kind
}

/** Everything the `blockedBy` connection carries — same group rule. */
export interface QueueItemBlockerParts {
  openBlockers: number[];
  blockersTruncated: boolean; // fail closed: truncated blocker list = blocked
  openBlockerLabels: string[]; // display form of openBlockers: "#N" own-repo, "owner/repo#N" cross-repo
  closedBlockers: number[]; // CLOSED blockers: "the work this waited on has landed"
}

/** A full read: both nested connections fetched. The default everywhere. */
export type QueueItem = QueueItemCore & QueueItemLabelParts & QueueItemBlockerParts;

/** A read that fetched `blockedBy` but may have skipped `labels` — what the
 *  ranker and the tend classifier actually need. A full QueueItem satisfies
 *  it, so fixtures and full-read callers pass unchanged. */
export type QueueItemWithBlockers = QueueItemCore &
  QueueItemBlockerParts &
  Partial<QueueItemLabelParts>;

/** Any selection at all — only the core fields are guaranteed present. */
export type QueueItemAny = QueueItemCore &
  Partial<QueueItemLabelParts> &
  Partial<QueueItemBlockerParts>;

/** Which nested connections a queue read asks GitHub for (GH-1803).
 *
 *  Cost is charged per unique CONNECTION per page, not per field and not per
 *  node: over a 100-item page, `items` is 1 request and each nested connection
 *  is 100 more, so 1 + 100·3 = 301 requests = 3 points, and dropping one
 *  connection is worth exactly 1 point/page. Trimming a nested `first:` is
 *  worth ZERO — measured, both halves:
 *  `thoughts/shared/research/2026-08-11-graphql-cost-measurement.md`.
 *
 *  An unselected group is ABSENT from the item, never `[]`/`false`. That is
 *  the whole safety argument: `blockersTruncated: false` means "GitHub told us
 *  the blocker list was complete", and a read that never asked must not be
 *  able to say that. The lean item types above make the group optional, so
 *  `tsc` refuses the unguarded read rather than trusting a fabricated flag. */
export interface QueueSelect {
  readonly labels: boolean;
  readonly blockers: boolean;
}

/** Both connections — the historical shape, and the default for every caller
 *  that does not say otherwise (`doctor`, `list`). */
export const QUEUE_SELECT_FULL = { labels: true, blockers: true } as const;
/** Dependency edges without issue labels: the ranker's shape (`next`,
 *  `frontier`, `tend-queue`). 2 pts/page instead of 3. */
export const QUEUE_SELECT_NO_LABELS = { labels: false, blockers: true } as const;
/** Neither — board state and claim only (`deliver-queue`, which filters on
 *  state and hands `{number, title}` onward). The 1-point floor. */
export const QUEUE_SELECT_MINIMAL = { labels: false, blockers: false } as const;

/** The item shape a given selection yields. */
export type SelectedQueueItem<S extends QueueSelect> = QueueItemCore &
  (S["labels"] extends true ? QueueItemLabelParts : Partial<QueueItemLabelParts>) &
  (S["blockers"] extends true ? QueueItemBlockerParts : Partial<QueueItemBlockerParts>);

/** Numeric rank of a priority option; lower sorts first, missing ranks last.
 *
 *  Two ranking sources, in this order:
 *    1. `order` — the field's LIVE single-select option order, when the caller
 *       supplied it. A single-select's option order is the one ordering the
 *       host repo actually declared, so it is the only thing that can rank a
 *       custom scheme (`Now`/`Later`) at all — and GH-1789 accepts custom
 *       schemes on write, so `next` has to be able to order them.
 *    2. A trailing-digit suffix, for a value that is NOT (or no longer) an
 *       option — a renamed/removed option still stamped on an item, or a
 *       caller with no live schema to hand. "P0" → 0, "P10" → 10 (lexicographic
 *       would put "P10" before "P2").
 *  The fallback is OFFSET past the live option range, never sharing its rank
 *  space: otherwise a stale "P0" would tie `Now` at 0 and the issue-number
 *  tie-break could hand the obsolete item the queue head. A value the board no
 *  longer offers must sort behind every value it does, while keeping its
 *  relative order against other stale values.
 *  A seeded P0..P3 board ranks identically under both sources, so the default
 *  board's behavior is unchanged either way. */
function priorityRank(p: string | null, order: readonly string[] = []): number {
  if (p === null) return Number.MAX_SAFE_INTEGER;
  const idx = order.indexOf(p);
  if (idx !== -1) return idx;
  const m = p.match(/(\d+)\s*$/);
  return m ? order.length + Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

/** An epic root the ranker demoted because its subtree is already being
 *  worked: the driver must not be handed the root while a child is in flight. */
export interface InFlightEpic {
  root: number;
  child: number; // the in-flight descendant that demoted the root
  holder: string | null; // its claim holder, when there is one
}

/** Backlog, unblocked, unclaimed — P0 first, parented work before new roots,
 *  then oldest. Blocked items are excluded but reported separately; an item
 *  whose blocker or field-value list was truncated counts as blocked (fail
 *  closed).
 *
 *  Epic directionality (GH: root→leaf pairs): the board-resident tree is
 *  rebuilt in memory from the parent edges the page walk already fetched —
 *  zero extra round trips. An eligible item with open board-resident children
 *  is a live ROOT, and handing it to a driver only forces a follow-up
 *  `board get` to find the real work, so:
 *    - its best eligible descendant (by inherited priority, then the usual
 *      tie-breaks) takes the root's queue position, carrying `via: root`;
 *    - if a descendant is instead in flight (claimed, or past Backlog), the
 *      epic is being worked — neither root nor children head the queue, and
 *      the root is reported in `inFlightEpics`;
 *    - if every descendant is blocked, the root stays eligible annotated with
 *      `childrenBlocked` — the queue is never emptier than it was flat.
 *  Priority inheritance: an item's effective rank is the best priority on its
 *  own-repo parent chain (visited-set bounded, so a malformed cycle degrades
 *  to own priority). A tree the board doesn't hold is invisible by
 *  construction: an off-board parent leaves an item ranking as a plain leaf.
 *  `priorityOrder` is the Priority field's live option order — the only way a
 *  host repo's custom scheme (`Now`/`Later`) can be ordered at all; see
 *  priorityRank. Omitting it falls back to digit-suffix ranking. */
/** A closed board item's tree edge: closed nodes are PASS-THROUGH topology —
 *  a Done phase between an epic root and its live grandchildren must not sever
 *  the tree — but contribute nothing else (no eligibility, no in-flight
 *  status, no priority). */
export interface ClosedEdge {
  number: number;
  parentNumber: number | null;
}

/** Eligibility is a function of dependency edges and field values — never of
 *  labels — so the ranker declares the leaner input (GH-1803) and `next` can
 *  skip the `labels` connection for a point per page. */
export function rankNext(
  items: QueueItemWithBlockers[],
  closedEdges: ClosedEdge[] = [],
  priorityOrder: readonly string[] = [],
): {
  eligible: QueueItemWithBlockers[];
  blocked: QueueItemWithBlockers[];
  inFlightEpics: InFlightEpic[];
} {
  const backlog = items.filter((i) => i.state === "Backlog" && !i.claim);
  const ineligible = (i: QueueItemWithBlockers) =>
    i.openBlockers.length > 0 || i.blockersTruncated || i.fieldValuesTruncated;
  const blocked = backlog.filter(ineligible);

  // Board-resident tree, own-repo edges only (parentNumber is null for
  // cross-repo parents by construction — see QueueItem). Closed items pass
  // topology through; open items carry everything else.
  const byNumber = new Map(items.map((i) => [i.number, i]));
  const parentOf = new Map<number, number | null>();
  for (const i of items) parentOf.set(i.number, i.parentNumber);
  for (const e of closedEdges) if (!parentOf.has(e.number)) parentOf.set(e.number, e.parentNumber);
  const childrenOf = new Map<number, number[]>();
  for (const [n, p] of parentOf) {
    if (p === null || !parentOf.has(p)) continue;
    const list = childrenOf.get(p) ?? [];
    list.push(n);
    childrenOf.set(p, list);
  }

  const effRank = (i: QueueItemWithBlockers): number => {
    let r = priorityRank(i.priority, priorityOrder);
    const seen = new Set<number>([i.number]);
    for (let p = i.parentNumber; p != null && !seen.has(p); ) {
      seen.add(p);
      const parent = byNumber.get(p); // closed ancestors pass through, rankless
      if (parent) r = Math.min(r, priorityRank(parent.priority, priorityOrder));
      p = parentOf.get(p) ?? null;
    }
    return r;
  };

  const cmp = (a: QueueItemWithBlockers, b: QueueItemWithBlockers): number => {
    const pa = effRank(a);
    const pb = effRank(b);
    if (pa !== pb) return pa - pb;
    if (a.hasParent !== b.hasParent) return a.hasParent ? -1 : 1;
    return a.number - b.number;
  };

  /** OPEN descendants, walking through closed pass-through nodes. */
  const descendants = (root: QueueItemWithBlockers): QueueItemWithBlockers[] => {
    const out: QueueItemWithBlockers[] = [];
    const seen = new Set<number>([root.number]);
    const stack = [...(childrenOf.get(root.number) ?? [])];
    while (stack.length) {
      const n = stack.pop()!;
      if (seen.has(n)) continue;
      seen.add(n);
      const open = byNumber.get(n);
      if (open) out.push(open);
      stack.push(...(childrenOf.get(n) ?? []));
    }
    return out;
  };

  const sorted = backlog.filter((i) => !ineligible(i)).sort(cmp);
  const eligibleSet = new Set(sorted.map((i) => i.number));

  // Classify live roots (eligible items with open board-resident descendants).
  // Priority inheritance already ranks a root's best leaf at-or-above the root
  // itself, so demotion is a filter, not a reorder: a demoted root simply
  // yields the queue to the descendants that inherited its rank.
  const demoted = new Set<number>();
  const childrenBlockedOf = new Map<number, number[]>();
  const inFlightEpics: InFlightEpic[] = [];
  for (const i of sorted) {
    const desc = descendants(i);
    if (desc.length === 0) continue;
    if (desc.some((d) => eligibleSet.has(d.number))) {
      demoted.add(i.number); // its eligible leaves carry the epic forward
      continue;
    }
    // In flight = actively worked: claimed, or in a WORKING state. A terminal
    // board state (Done/Canceled) on a still-open issue is reconcile DRIFT,
    // not flight — counting it would suppress the epic and assert work that
    // does not exist, for as long as the corrective cron stays broken.
    const inFlight = desc.find(
      (d) => (d.state !== "Backlog" && !TERMINAL_BOARD_STATES.has(d.state)) || d.claim,
    );
    if (inFlight) {
      demoted.add(i.number);
      inFlightEpics.push({
        root: i.number,
        child: inFlight.number,
        holder: inFlight.claim ? inFlight.claim.holders.join("+") : null,
      });
      continue;
    }
    // Remaining descendants are blocked (or terminal drift): the root keeps
    // its slot, and the honest next move for the blocked ones is unblocking,
    // not implementing the root wholesale.
    const blockedDesc = desc
      .filter((d) => d.state === "Backlog")
      .map((d) => d.number)
      .sort((a, b) => a - b);
    if (blockedDesc.length) childrenBlockedOf.set(i.number, blockedDesc);
  }

  const nearestDemotedRoot = (i: QueueItemWithBlockers): number | undefined => {
    const seen = new Set<number>([i.number]);
    for (let p = i.parentNumber; p != null && !seen.has(p); ) {
      if (demoted.has(p)) return p;
      seen.add(p);
      p = parentOf.get(p) ?? null;
    }
    return undefined;
  };

  const eligible = sorted
    .filter((i) => !demoted.has(i.number))
    .map((i) => {
      const via = nearestDemotedRoot(i);
      const childrenBlocked = childrenBlockedOf.get(i.number);
      if (via === undefined && childrenBlocked === undefined) return i;
      return {
        ...i,
        ...(via !== undefined ? { via } : {}),
        ...(childrenBlocked !== undefined ? { childrenBlocked } : {}),
      };
    });
  return { eligible, blocked, inFlightEpics };
}

/** A blocked item whose every open blocker the board itself calls finished. */
export interface StaleBlockedEdge {
  number: number;
  blockers: number[]; // the open-on-GitHub, terminal-on-board blockers
}

export interface EmptyQueueReport {
  diagnosis: "no-items" | "human-needed" | "epic-in-flight" | "stale-blocked" | null;
  humanNeededCount: number;
  staleBlockedEdges: StaleBlockedEdge[];
  inFlightEpics: InFlightEpic[];
}

/** Board states that assert the work is finished; an item parked here still
 *  open on GitHub is the contradiction a stale blocked edge is made of. */
const TERMINAL_BOARD_STATES = new Set(["Done", "Canceled"]);

/** Why nothing is actionable, from data the caller already fetched — no new
 *  round trip. Tiers are mutually exclusive, first match wins, and `diagnosis`
 *  is null whenever anything IS eligible: a healthy run has no anomaly to name.
 *
 *  A GitHub-closed blocker never reaches openBlockers, so the only reachable
 *  form of "the block is not real" is a blocker the board has moved to a
 *  terminal state while the issue stayed open. A truncated blocker list hides
 *  blockers, so it counts as live — the same fail-closed rule the ranker uses. */
export function diagnoseEmptyQueue(
  items: QueueItemWithBlockers[],
  eligible: QueueItemWithBlockers[],
  blocked: QueueItemWithBlockers[],
  inFlightEpics: InFlightEpic[] = [],
): EmptyQueueReport {
  const humanNeededCount = items.filter((i) => i.state === "Human Needed").length;
  // Match on openBlockerLabels, not bare numbers: issue numbers repeat across
  // repos, and `items` is own-repo only, so a foreign owner/repo#9 must never
  // resolve against our own #9. Own-repo labels are exactly "#N".
  const terminalHere = new Set(
    items.filter((i) => TERMINAL_BOARD_STATES.has(i.state)).map((i) => `#${i.number}`),
  );
  const staleBlockedEdges = blocked
    .filter(
      (i) =>
        !i.blockersTruncated &&
        i.openBlockerLabels.length > 0 &&
        i.openBlockerLabels.every((l) => terminalHere.has(l)),
    )
    .map((i) => ({ number: i.number, blockers: i.openBlockers }));
  // epic-in-flight outranks stale-blocked: "the only work is an epic already
  // being worked under #R" is the more actionable fact than a stale edge.
  const diagnosis =
    eligible.length > 0 ? null
    : items.length === 0 ? "no-items"
    : humanNeededCount > 0 ? "human-needed"
    : inFlightEpics.length > 0 ? "epic-in-flight"
    : staleBlockedEdges.length > 0 ? "stale-blocked"
    : null;
  return { diagnosis, humanNeededCount, staleBlockedEdges, inFlightEpics };
}

// ---------------------------------------------------------------------------
// Frontier (ralph-herdr v2 Phase 3, D4) — the work-stealing frontier is
// next's eligible queue, item for item and in the same order. This section is
// a RE-PROJECTION of rankNext's output with a per-item explanation attached;
// it never computes eligibility itself, so the fleet controller and any DAG
// viz reading this shape cannot drift from what `next` would hand a driver.
// ---------------------------------------------------------------------------

export interface FrontierItem {
  number: number;
  title: string;
  /** Own-repo parent, when the item has one (cross-repo parents are null in
   *  QueueItem by construction and stay absent here). */
  parentNumber?: number;
  /** Epic context carried through from rankNext: the demoted root this leaf
   *  serves / the blocked children keeping a root eligible. */
  via?: number;
  childrenBlocked?: number[];
  /** WHY it is eligible: every dependency edge with its issue state. For an
   *  eligible item these are all CLOSED (an open blocker is what ineligible
   *  means) — the state field exists so blocked/eligible share one shape. */
  blockers: Array<{ number: number; state: "OPEN" | "CLOSED" }>;
  eligible: true;
}

export interface FrontierBlockedItem {
  number: number;
  blockers_open: number[];
  /** The blockage is (at least partly) a truncated read, not a listed edge —
   *  the same fail-closed rule the ranker applies. */
  truncated?: true;
}

export interface FrontierResult {
  frontier: FrontierItem[];
  blocked: FrontierBlockedItem[];
}

export function frontierView(ranked: {
  eligible: QueueItemWithBlockers[];
  blocked: QueueItemWithBlockers[];
}): FrontierResult {
  return {
    frontier: ranked.eligible.map((i) => ({
      number: i.number,
      title: i.title,
      ...(i.parentNumber !== null ? { parentNumber: i.parentNumber } : {}),
      ...(i.via !== undefined ? { via: i.via } : {}),
      ...(i.childrenBlocked !== undefined ? { childrenBlocked: i.childrenBlocked } : {}),
      blockers: [
        ...i.openBlockers.map((n) => ({ number: n, state: "OPEN" as const })),
        ...i.closedBlockers.map((n) => ({ number: n, state: "CLOSED" as const })),
      ],
      eligible: true as const,
    })),
    blocked: ranked.blocked.map((i) => ({
      number: i.number,
      blockers_open: [...i.openBlockers],
      ...(i.blockersTruncated || i.fieldValuesTruncated ? { truncated: true as const } : {}),
    })),
  };
}

// ---------------------------------------------------------------------------
// Config + scope
// ---------------------------------------------------------------------------

export interface Config {
  owner: string;
  repo: string;
  projectNumber: number;
  host: string; // remote host the scope gate requires (GHE via .ralph.json)
  lockTtlMin: number;
  holder: string;
  apply: ApplyConfig; // GH-1693: apply-kind opt-in, read from the merge policy
  smells: SmellThresholds; // GH-1715: doctor's advisory state-smell tripwires
  volume: VolumeThresholds; // GH-1788: how big the scanned board may get before doctor says so
}

// ---------------------------------------------------------------------------
// Apply kind (GH-1692 / GH-1693) — merge ≠ done for infra work.
//
// An issue labelled with `apply.label` is an APPLY unit: the deploy, the
// terraform run, the settings edit, the next scheduled fire. It closes only on
// deployed-and-verified evidence, never on a merge. Everything in this section
// is INERT unless the repo opted in via the `apply` block of
// .github/ralph-merge-policy.json — the same file the merge gate reads, so a
// repo opts in exactly once.
// ---------------------------------------------------------------------------

export interface ApplyConfig {
  enabled: boolean;
  label: string;
  /** Globs; the merge gate's infra-split rule uses these. board.ts only
   *  carries them so the two readers cannot drift apart. */
  infraPaths: string[];
}

export const APPLY_LABEL_DEFAULT = "ralph:apply";
export const APPLY_EVIDENCE_MARKER = "<!-- ralph-apply-evidence:v1 -->";
export const APPLY_EVIDENCE_KINDS = ["run", "observation", "settings"] as const;
const VERIFY_AFTER_RE = /<!--\s*ralph-verify-after:\s*([^\s>]+)\s*-->/;
/** Clock skew tolerance for `applied_at` — a runner minutes ahead of GitHub
 *  must not have its honest evidence rejected as time-travelling. */
const APPLIED_AT_SKEW_MS = 5 * 60_000;

/** Reads the `apply` block from .github/ralph-merge-policy.json.
 *  Fails CLOSED on a malformed policy file, exactly like merge-pr.sh: a
 *  truncated policy must not silently disable the gates it configures. */
export function loadApplyConfig(repoRoot: string): ApplyConfig {
  const off: ApplyConfig = { enabled: false, label: APPLY_LABEL_DEFAULT, infraPaths: [] };
  // RALPH_MERGE_POLICY_FILE is the same test-only override merge-pr.sh honours;
  // keeping one name means the two readers cannot be pointed at different files.
  const policyFile =
    process.env.RALPH_MERGE_POLICY_FILE ?? join(repoRoot, ".github", "ralph-merge-policy.json");
  if (!existsSync(policyFile)) return off;
  let policy: any;
  try {
    policy = JSON.parse(readFileSync(policyFile, "utf8"));
  } catch {
    process.stderr.write(
      `warn: ${policyFile} is not valid JSON — apply-kind gates stay ON with defaults (fail closed)\n`,
    );
    return { enabled: true, label: APPLY_LABEL_DEFAULT, infraPaths: [] };
  }
  const a = policy?.apply;
  if (!a || a.enabled !== true) return off;
  return {
    enabled: true,
    label: typeof a.label === "string" && a.label ? a.label : APPLY_LABEL_DEFAULT,
    infraPaths: Array.isArray(a.infraPaths) ? a.infraPaths.filter((p: unknown) => typeof p === "string") : [],
  };
}

/** Fails CLOSED on a truncated label list, matching the blocker/child
 *  truncation rules elsewhere in this file. An issue whose apply label sits
 *  past the fetch window would otherwise silently escape every apply control —
 *  and unlike the other truncations, that failure direction is OPEN. Treating
 *  it as apply-kind costs an unnecessary evidence comment on an absurdly
 *  labelled issue; the alternative costs a false completion. */
export function isApplyIssue(
  cfg: { apply: ApplyConfig },
  labels: readonly string[],
  labelsTruncated = false,
): boolean {
  if (!cfg.apply.enabled) return false;
  return labels.includes(cfg.apply.label) || labelsTruncated;
}

/** `<!-- ralph-verify-after: 2026-08-08T00:00:00Z -->` in the issue body:
 *  the instant before which this apply unit CANNOT be evidenced (a weekly
 *  cron's next fire is up to 7 days out). Doctor stays quiet until then. */
export function parseVerifyAfter(body: string | null | undefined): Date | null {
  const m = VERIFY_AFTER_RE.exec(body ?? "");
  if (!m) return null;
  const d = new Date(m[1]);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Extracts the JSON payload of the LAST `ralph-apply-evidence:v1` comment.
 *  Returns null when no marker comment carries a parseable fenced payload. */
export function parseApplyEvidence(commentBodies: readonly string[]): unknown | null {
  for (let i = commentBodies.length - 1; i >= 0; i--) {
    const body = commentBodies[i];
    const at = body.indexOf(APPLY_EVIDENCE_MARKER);
    if (at < 0) continue;
    const fence = /```json\s*\n([\s\S]*?)\n```/.exec(body.slice(at));
    if (!fence) return null; // marker present but shapeless — a real failure, not "absent"
    try {
      return JSON.parse(fence[1]);
    } catch {
      return null;
    }
  }
  return null;
}

/** Returns null when the evidence is shape-valid, else the FIRST failing rule
 *  in human words. Pure — the close gate and doctor share it verbatim.
 *
 *  What this does NOT check: whether `notes` is true, and whether an
 *  observation/settings command's output meant what the operator says it
 *  meant. Shape validity is the floor, not proof (plan §Risks). */
export function validateApplyEvidence(raw: unknown, now: Date): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return `no ${APPLY_EVIDENCE_MARKER} comment with a parseable \`\`\`json payload`;
  }
  const e = raw as Record<string, any>;
  const kind = e.kind;
  if (!APPLY_EVIDENCE_KINDS.includes(kind)) {
    return `evidence "kind" must be one of ${APPLY_EVIDENCE_KINDS.join("|")} (got ${JSON.stringify(kind)})`;
  }
  if (typeof e.applied_at !== "string" || Number.isNaN(new Date(e.applied_at).getTime())) {
    return `evidence "applied_at" must be an ISO-8601 timestamp (got ${JSON.stringify(e.applied_at)})`;
  }
  if (new Date(e.applied_at).getTime() > now.getTime() + APPLIED_AT_SKEW_MS) {
    return `evidence "applied_at" (${e.applied_at}) is in the future — the apply has not happened yet`;
  }
  if (typeof e.actor !== "string" || !e.actor.trim()) return `evidence "actor" must be non-empty`;
  if (typeof e.notes !== "string" || !e.notes.trim()) {
    return `evidence "notes" must state, in words, what is now live`;
  }
  if (kind === "run") {
    const r = e.run;
    if (!r || typeof r !== "object") return `kind=run evidence requires a "run" object`;
    if (typeof r.workflow !== "string" || !r.workflow.trim()) return `run.workflow must be non-empty`;
    if (r.id === undefined || r.id === null || String(r.id).trim() === "") return `run.id must be non-empty`;
    if (r.conclusion !== "success") {
      return `run.conclusion must be "success" (got ${JSON.stringify(r.conclusion)})`;
    }
    // The binding rule. A green run of the PRE-merge code is not proof the
    // merged change is live — that is the exact failure this epic exists for.
    const mergeSha = typeof e.merge_sha === "string" ? e.merge_sha.trim() : "";
    if (!mergeSha) return `kind=run evidence requires "merge_sha" — the commit that had to be deployed`;
    if (typeof r.head_sha !== "string" || !r.head_sha.trim()) return `run.head_sha must be non-empty`;
    if (r.head_sha.trim() !== mergeSha) {
      return `run.head_sha ${r.head_sha.trim().slice(0, 8)} != merge_sha ${mergeSha.slice(0, 8)} — that run did not execute the merged code`;
    }
    return null;
  }
  const checks = e.checks;
  if (!Array.isArray(checks) || checks.length === 0) {
    return `kind=${kind} evidence requires a non-empty "checks" array`;
  }
  // findIndex, not find: `find` returns undefined for a matching UNDEFINED
  // entry, and `bad !== undefined` would then read that as "no offender".
  const badAt = checks.findIndex((c: any) => !c || typeof c !== "object" || c.exit_code !== 0);
  if (badAt >= 0) {
    return `every checks[] entry needs exit_code 0 (offender: ${JSON.stringify(checks[badAt])})`;
  }
  return null;
}

/** Host + owner + repo must all match — a matching owner/repo on a mirror or
 *  another forge must not pass the gate. Host defaults to github.com.
 *  Handles scheme'd URLs (https/ssh/git, optional port — GHE commonly serves
 *  SSH on a non-default port) and scp-style remotes (which cannot carry a
 *  port; their colon is the path separator). */
export function scopeMatches(
  remoteUrl: string,
  owner: string,
  repo: string,
  host = "github.com",
): boolean {
  const url = remoteUrl.trim();
  const m =
    url.match(/^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/) ??
    url.match(/^(?:[^@/]+@)?([^/:]+):(.+)$/);
  if (!m) return false;
  const segs = m[2].replace(/\/+$/, "").replace(/\.git$/, "").split("/");
  if (segs.length !== 2) return false;
  return (
    m[1].toLowerCase() === host.toLowerCase() &&
    segs[0].toLowerCase() === owner.toLowerCase() &&
    segs[1].toLowerCase() === repo.toLowerCase()
  );
}

function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return startDir;
    dir = parent;
  }
}

/** Config precedence: .ralph.json > tracked .claude/settings.json env block.
 *  process.env fills only lockTtlMin/holder (never scope — scope is repo-anchored). */
export function loadConfig(repoRoot: string): Config {
  let owner = "";
  let repo = "";
  let projectNumber = 0;
  let host = "github.com";

  // Config parse failures name the file: a truncated .ralph.json must read as
  // "fix this file" (usage, exit 64), not as an anonymous SyntaxError (exit 1).
  const parseConfigFile = (path: string): any => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      throw new UsageError(`${path} is not valid JSON: ${e instanceof Error ? e.message : e}`);
    }
    // "null"/"[]"/'"x"' parse fine and then crash on property access — same
    // anonymous-exit-1 outcome this helper exists to remove.
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new UsageError(`${path} is not valid JSON: expected a JSON object`);
    }
    return parsed;
  };

  const ralphJson = join(repoRoot, ".ralph.json");
  const settingsJson = join(repoRoot, ".claude", "settings.json");
  if (existsSync(ralphJson)) {
    const c = parseConfigFile(ralphJson);
    owner = c.owner ?? "";
    repo = c.repo ?? "";
    projectNumber = Number(c.projectNumber ?? 0);
    host = c.host ?? host;
  } else if (existsSync(settingsJson)) {
    const env = parseConfigFile(settingsJson).env ?? {};
    owner = env.RALPH_GH_OWNER ?? "";
    repo = env.RALPH_GH_REPO ?? "";
    projectNumber = Number(env.RALPH_GH_PROJECT_NUMBER ?? 0);
    host = env.RALPH_GH_HOST ?? host;
  }

  if (!owner || !repo || !projectNumber) {
    throw new UsageError(
      "config missing: need owner/repo/projectNumber from .ralph.json or .claude/settings.json env " +
        "(RALPH_GH_OWNER, RALPH_GH_REPO, RALPH_GH_PROJECT_NUMBER)",
    );
  }

  // ClaimV2 wire delimiters: a holder carrying '+' or '|' would serialize as
  // a DIFFERENT holder set ("a+b" reads back as two members, neither of them
  // "a+b") and then fail its own read-back membership verify, stranding the
  // item claimed under names nobody uses. formatClaim refuses at write time
  // too (defense in depth); refusing HERE lets the message name the env var.
  const holder = process.env.RALPH_CLAIM_HOLDER ?? `${userInfo().username}@${hostname()}`;
  if (!holder || holder.includes("+") || holder.includes("|")) {
    throw new UsageError(
      `RALPH_CLAIM_HOLDER must be non-empty and free of the claim wire delimiters "+" and "|" (got ${JSON.stringify(holder)})`,
    );
  }

  return {
    owner,
    repo,
    projectNumber,
    host,
    lockTtlMin: parseTtlMin(process.env.RALPH_LOCK_TTL_MIN),
    holder,
    apply: loadApplyConfig(repoRoot),
    smells: parseSmellThresholds(),
    volume: parseVolumeThresholds(),
  };
}

/** Doctor's state-smell tripwires (GH-1715): how much observed failure a
 *  single issue must have accumulated before doctor says anything about it.
 *  Defaults are deliberately conservative — a check that fires on a healthy
 *  board every week is miscalibrated, and these lines are advisory, so nobody
 *  can act on a flood of them. Unlike RALPH_LOCK_TTL_MIN these gate no
 *  mutation, so a bad value degrades to the default with a warning. */
export interface SmellThresholds {
  claimExpiries: number; // repeated claim loss on ONE issue = empirically too big
  escalations: number; // Human Needed re-entries = the question is not converging
  reviewDays: number; // days In Review with a quiet PR
  proposalDays: number; // GH-1777: days a tend closure proposal has gone unanswered
}

export const SMELL_DEFAULTS: Readonly<SmellThresholds> = Object.freeze({
  claimExpiries: 2,
  escalations: 3,
  reviewDays: 7,
  proposalDays: 7,
});

export function parseSmellThresholds(
  env: Record<string, string | undefined> = process.env,
): SmellThresholds {
  const positive = (name: string, def: number): number => {
    const raw = env[name];
    if (raw === undefined) return def;
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
    process.stderr.write(`warn: ${name}="${raw}" is not a positive number — using ${def}\n`);
    return def;
  };
  return {
    claimExpiries: positive("RALPH_SMELL_CLAIM_EXPIRIES", SMELL_DEFAULTS.claimExpiries),
    escalations: positive("RALPH_SMELL_ESCALATIONS", SMELL_DEFAULTS.escalations),
    reviewDays: positive("RALPH_SMELL_REVIEW_DAYS", SMELL_DEFAULTS.reviewDays),
    proposalDays: positive("RALPH_SMELL_PROPOSAL_DAYS", SMELL_DEFAULTS.proposalDays),
  };
}

// ---------------------------------------------------------------------------
// Board volume (GH-1788) — every full scan pays for all-time history.
//
// listItemsFull walks EVERY item on the project, 100 per page, and the project
// keeps closed items forever. So the cost of `next`, `doctor`, `deliver-queue`
// and `tend-queue` grows monotonically with the number of issues this repo has
// ever closed, not with the number it is working on.
//
// ARCHIVING DOES NOT FIX THIS. Archived items are still returned by the items
// connection — that is the whole reason ClosedItem carries `archived` and the
// walk filters on it. Archiving hides an item from the board's VIEWS; the scan
// still pages through it. The only lever that shrinks the scan is removing the
// item from the project (deleteProjectV2Item), which leaves the GitHub issue
// completely untouched but does drop that item's board field values (Workflow
// State, Claim). That is one-way for board metadata, which is exactly why
// pruning is surfaced and offered, never performed automatically.
// ---------------------------------------------------------------------------

/** When doctor should start saying the scan has grown expensive, and how long
 *  a closed item must have been closed before it is even a prune candidate.
 *  Both are advisory: the volume line is INFO and never gates, and prune is a
 *  dry run unless a human passes --apply. A bad value degrades to the default
 *  with a warning, like the smell thresholds — neither gates a mutation. */
export interface VolumeThresholds {
  maxItems: number; // scanned items above which doctor names the cost
  pruneAfterDays: number; // minimum age of a closed item before it can be pruned
}

export const VOLUME_DEFAULTS: Readonly<VolumeThresholds> = Object.freeze({
  // ~8 pages. Comfortably above a healthy working board, well below the point
  // where a routine poll starts costing real GraphQL budget.
  maxItems: 800,
  // Six months. Far past tend's audit window and past any plausible reopen, so
  // a pruned item is one nobody is still reasoning about.
  pruneAfterDays: 180,
});

export function parseVolumeThresholds(
  env: Record<string, string | undefined> = process.env,
): VolumeThresholds {
  const positive = (name: string, def: number): number => {
    const raw = env[name];
    if (raw === undefined) return def;
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
    process.stderr.write(`warn: ${name}="${raw}" is not a positive number — using ${def}\n`);
    return def;
  };
  return {
    maxItems: positive("RALPH_VOLUME_MAX_ITEMS", VOLUME_DEFAULTS.maxItems),
    pruneAfterDays: positive("RALPH_PRUNE_AFTER_DAYS", VOLUME_DEFAULTS.pruneAfterDays),
  };
}

/** TTL is the only override path in this CLI, so a bad value must not fail
 *  silently: "" → 0 would make every claim instantly stealable; "120min" →
 *  NaN would make no claim ever expire. Invalid input warns and uses 120. */
export function parseTtlMin(raw: string | undefined): number {
  if (raw === undefined) return 120;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n;
  process.stderr.write(`warn: RALPH_LOCK_TTL_MIN="${raw}" is not a positive number — using 120\n`);
  return 120;
}

/** Item-cache staleness bound Δ, seconds (GH-1806). Unlike the claim TTL this
 *  one is economic, not safety: it bounds E[wasted work] ≈ P(stale within Δ) ×
 *  cost(failed claim attempt), because no write guard ever reads it.
 *
 *  0 disables. The ceiling is a guard against a typo (`900000`) silently
 *  turning a hint into a fiction — a value past it is refused, not clamped
 *  silently, so the operator learns their setting did not take. */
export const ITEM_CACHE_TTL_DEFAULT_SEC = 90;
export const ITEM_CACHE_TTL_MAX_SEC = 600;

export function parseItemCacheTtlSec(raw: string | undefined): number {
  // `RALPH_ITEM_CACHE_TTL_SEC=` (exported empty by a shell profile) must read
  // as unset, not as Number("") === 0 — which would silently switch the cache
  // off and leave someone measuring a "fix" that is not running.
  if (raw === undefined || raw.trim() === "") return ITEM_CACHE_TTL_DEFAULT_SEC;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0 && n <= ITEM_CACHE_TTL_MAX_SEC) return n;
  process.stderr.write(
    `warn: RALPH_ITEM_CACHE_TTL_SEC="${raw}" is not a number in 0..${ITEM_CACHE_TTL_MAX_SEC} — ` +
      `using ${ITEM_CACHE_TTL_DEFAULT_SEC}\n`,
  );
  return ITEM_CACHE_TTL_DEFAULT_SEC;
}

// ---------------------------------------------------------------------------
// Exec + gh transport (injected for tests)
// ---------------------------------------------------------------------------

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type ExecFn = (argv: string[], stdin?: string) => ExecResult;

export const realExec: ExecFn = (argv, stdin) => {
  const [cmd, ...args] = argv;
  const r = spawnSync(cmd, args, {
    input: stdin,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  // A spawn failure (ENOENT: gh not installed, EACCES, …) sets r.error and
  // leaves stderr empty — surface it, or every caller reports a blank reason.
  const stderr = r.error ? `${r.stderr ?? ""}${r.error.message}` : (r.stderr ?? "");
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr };
};

export class UsageError extends Error {}
export class RefusalError extends Error {} // invariant refusal — exit 2

/** GraphQL-level failure (body.errors non-empty). Carries the structured
 *  error types so callers can branch on `NOT_FOUND` etc. instead of matching
 *  GitHub's message wording. */
export class GraphQLError extends Error {
  constructor(
    message: string,
    public readonly types: string[],
  ) {
    super(message);
  }
}

export interface Ctx {
  exec: ExecFn;
  cfg: Config;
  repoRoot: string;
  cacheDir: string;
  now: () => Date;
  /** Bounded-staleness window for the ITEM walk cache, seconds (GH-1806).
   *  0 (and absent) disables it in both directions — no read, no write.
   *
   *  Absent-means-off is deliberate: a Ctx built by a future caller that has
   *  not thought about staleness gets today's always-fresh behaviour, and the
   *  write-guard carve-out is expressed by handing a mutating path a Ctx with
   *  this zeroed. Fail-safe is the only safe default direction for a cache. */
  itemCacheTtlSec?: number;
}

/** The probe is ALIASED: a caller that selects `rateLimit` itself keeps its own
 *  value, and cleanup deletes only our key. Aliases are free — cost is charged
 *  per connection, and `rateLimit` is not one. */
export const COST_ALIAS = "__ralphGqlCost";
const RATE_LIMIT_SELECTION = `${COST_ALIAS}: rateLimit { cost remaining limit used resetAt nodeCount }`;

/** Index of the `{` that opens the operation's SELECTION SET, or -1.
 *
 *  Not `indexOf("{")`: a variable default value carries its own braces
 *  (`query($f: Input = { state: OPEN })`), and splicing there yields an invalid
 *  document. The selection set is the first `{` at paren/bracket depth 0,
 *  skipping strings and `#` comments. Handles shorthand (`{ viewer { … } }`)
 *  and leading comments; anything it cannot read leaves the query untouched. */
function selectionSetStart(query: string): number {
  let depth = 0;
  for (let i = 0; i < query.length; i++) {
    const c = query[i];
    if (c === "#") {
      const nl = query.indexOf("\n", i);
      if (nl < 0) return -1;
      i = nl;
    } else if (query.startsWith('"""', i)) {
      const end = query.indexOf('"""', i + 3);
      if (end < 0) return -1;
      i = end + 2;
    } else if (c === '"') {
      i++;
      while (i < query.length && query[i] !== '"') i += query[i] === "\\" ? 2 : 1;
      if (i >= query.length) return -1;
    } else if (c === "(" || c === "[") {
      depth++;
    } else if (c === ")" || c === "]") {
      depth--;
    } else if (c === "{" && depth === 0) {
      return i;
    }
  }
  return -1;
}

/** RALPH_GQL_COST=1 measurement mode (GH-1801). `rateLimit` is a field on the
 *  Query root only, so mutations and subscriptions are left alone — including
 *  shorthand `{ … }`, which IS a query and is instrumented. */
export function instrumentQuery(query: string): { query: string; instrumented: boolean } {
  // Skip whitespace and leading `#` comments to reach the operation keyword.
  let head = 0;
  for (;;) {
    const rest = query.slice(head);
    const ws = rest.match(/^\s+/);
    if (ws) {
      head += ws[0].length;
      continue;
    }
    if (query[head] === "#") {
      const nl = query.indexOf("\n", head);
      if (nl < 0) return { query, instrumented: false };
      head = nl + 1;
      continue;
    }
    break;
  }
  const isQuery = /^query\b/.test(query.slice(head)) || query[head] === "{";
  if (!isQuery) return { query, instrumented: false };
  const brace = selectionSetStart(query.slice(head));
  if (brace < 0) return { query, instrumented: false };
  const at = head + brace;
  return {
    query: `${query.slice(0, at + 1)}\n  ${RATE_LIMIT_SELECTION}${query.slice(at + 1)}`,
    instrumented: true,
  };
}

/** Cumulative points observed this process, for the per-command totals line. */
export const gqlCost = { calls: 0, points: 0 };

function costLabel(query: string): string {
  const brace = selectionSetStart(query);
  const first = query.slice(brace + 1).match(/[A-Za-z_][A-Za-z0-9_]*/);
  return first ? first[0] : "query";
}

export function ghGraphQL<T = any>(
  ctx: Ctx,
  query: string,
  variables: Record<string, unknown>,
): T {
  const measuring = process.env.RALPH_GQL_COST === "1";
  const sent = measuring ? instrumentQuery(query) : { query, instrumented: false };
  // Read-your-writes, half one (GH-1806): mark BEFORE the wire, because a
  // mutation that lands and then fails to report back (non-zero exit,
  // unparseable body, dropped connection) has still happened. Marking only on
  // success would leave exactly that case serving a pre-write view.
  const mutating = isMutationOp(query);
  if (mutating) markLocalWrite(ctx);
  // --hostname keeps API traffic on the same host the scope gate verified —
  // a GHE config must not silently query github.com.
  const r = ctx.exec(
    ["gh", "api", "graphql", "--hostname", ctx.cfg.host, "--input", "-"],
    JSON.stringify({ query: sent.query, variables }),
  );
  if (r.code !== 0) {
    throw new Error(`gh api graphql failed (exit ${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
  }
  let body: any;
  try {
    body = JSON.parse(r.stdout);
  } catch {
    // exit 0 with non-JSON stdout (proxy interstitial, truncated pipe, …)
    throw new Error(`gh api graphql returned unparseable output: ${r.stdout.slice(0, 200)}`);
  }
  if (body.errors?.length) {
    throw new GraphQLError(
      `GraphQL: ${body.errors.map((e: any) => e.message).join("; ")}`,
      body.errors.map((e: any) => e?.type).filter((t: unknown): t is string => typeof t === "string"),
    );
  }
  if (sent.instrumented) {
    const rl = body.data?.[COST_ALIAS];
    if (rl) {
      gqlCost.calls += 1;
      gqlCost.points += rl.cost;
      process.stderr.write(
        `[gql-cost] ${costLabel(query)} cost=${rl.cost} nodes=${rl.nodeCount} ` +
          `used=${rl.used}/${rl.limit} remaining=${rl.remaining} resetAt=${rl.resetAt} ` +
          `| session calls=${gqlCost.calls} points=${gqlCost.points}\n`,
      );
    }
    // Callers destructure known keys, but leaving the probe in would leak into
    // --json output paths that re-emit whole nodes. Only OUR alias is removed —
    // a caller that selected `rateLimit` itself keeps its value.
    if (body.data && typeof body.data === "object") delete body.data[COST_ALIAS];
  }
  // Half two: mark AFTER the write lands as well. The pre-mark refuses every
  // entry that existed when we started; this one also refuses an entry from a
  // walk that ran DURING the write. Together they close both windows.
  //
  // Both halves live in ghGraphQL because it is the one path every write
  // takes — a per-mutation-helper rule is one a future writer can forget.
  if (mutating) markLocalWrite(ctx);
  return body.data as T;
}

/** True for a GraphQL `mutation` operation. Anonymous shorthand (`{ … }`) is a
 *  QUERY by the spec, so the absence of the keyword is not ambiguity. Leading
 *  whitespace and `#` comments are skipped, matching instrumentQuery. */
export function isMutationOp(query: string): boolean {
  let head = 0;
  for (;;) {
    const ws = query.slice(head).match(/^\s+/);
    if (ws) {
      head += ws[0].length;
      continue;
    }
    if (query[head] === "#") {
      const nl = query.indexOf("\n", head);
      if (nl < 0) return false;
      head = nl + 1;
      continue;
    }
    break;
  }
  return /^mutation\b/.test(query.slice(head));
}

// ---------------------------------------------------------------------------
// Field cache (~/.ralph/cache/board-{owner}-{project}.json)
// ---------------------------------------------------------------------------

interface FieldInfo {
  id: string;
  dataType: string;
  options?: Record<string, string>; // name → optionId
  /** The API's DECLARED option order, kept separately because the map above
   *  cannot carry it: JS enumerates integer-like keys numerically ahead of
   *  string keys, so a board declaring `10` before `2` reads back as `2, 10`
   *  from Object.keys — and no refresh can repair it, since the order is lost
   *  at the moment the options become object properties. Anything ranking by
   *  option order must read THIS. */
  optionOrder?: string[];
}
interface BoardCache {
  projectId: string;
  repositoryId: string;
  fields: Record<string, FieldInfo>; // field name → info
  fetchedAt: string;
  /** Priority values a LIVE read has already confirmed are not options — an
   *  item holding a removed/renamed value, which is a case the ranker supports
   *  on purpose (historical record). Without this, "value absent from options"
   *  is permanent evidence of staleness and every warm read pays a schema
   *  query forever; a confirmed-obsolete value must stop being news. */
  unresolvedPriorities?: string[];
  /** Set when the list above hit its cap and had to evict. A bare cap would
   *  RECREATE the loop it was meant to prevent: past the cap, eviction
   *  guarantees some observed value is always missing, so evidence fires, the
   *  refresh drops the same value again, and every warm read pays a query
   *  forever. Once truncated, unexplained values stop counting as evidence —
   *  `--fresh` and the age ceiling still bound staleness, so the degradation is
   *  a slower reaction to a rename, never an unbounded cost. */
  unresolvedPrioritiesTruncated?: boolean;
}

const STATE_FIELD = "Workflow State";
const CLAIM_FIELD = "Claim";
const STATUS_FIELD = "Status";
const ESTIMATE_FIELD = "Estimate";
const PRIORITY_FIELD = "Priority";

/** Advisory single-selects: sizing (`create --estimate`) and ranking (`next`)
 *  degrade gracefully without them, so doctor warns (never fails) and setup
 *  creates them when absent — but a host repo's existing scheme is respected:
 *  setup never edits an existing field's options or type. */
const ADVISORY_FIELDS: ReadonlyArray<{ name: string; options: readonly string[] }> = [
  { name: ESTIMATE_FIELD, options: ["XS", "S", "M", "L", "XL"] },
  { name: PRIORITY_FIELD, options: ["P0", "P1", "P2", "P3"] },
];

function advisoryFieldsMissing(cache: BoardCache): string[] {
  return ADVISORY_FIELDS.filter((f) => !cache.fields[f.name]).map((f) => f.name);
}

function cachePath(ctx: Ctx): string {
  // repo is part of the key: the cache stores repositoryId, and two repos
  // sharing one project would otherwise create issues in the wrong repo.
  return join(ctx.cacheDir, `board-${ctx.cfg.owner}-${ctx.cfg.repo}-${ctx.cfg.projectNumber}.json`);
}

export function refreshCache(ctx: Ctx): BoardCache {
  // ONE round trip: repositoryOwner covers both user- and org-owned projects
  // (inline fragments — the non-matching type simply contributes nothing, no
  // probe loop, no swallowed errors), and repository{id} rides as a sibling
  // root field. A transport/auth failure now surfaces as itself instead of
  // being eaten by a try-next-owner-type catch.
  const data = ghGraphQL(
    ctx,
    `query($owner: String!, $repo: String!, $number: Int!) {
      repositoryOwner(login: $owner) {
        ... on User { projectV2(number: $number) { ...pf } }
        ... on Organization { projectV2(number: $number) { ...pf } }
      }
      repository(owner: $owner, name: $repo) { id }
    }
    fragment pf on ProjectV2 {
      id
      fields(first: 50) {
        nodes {
          ... on ProjectV2FieldCommon { id name dataType }
          ... on ProjectV2SingleSelectField { id name dataType options { id name } }
        }
      }
    }`,
    { owner: ctx.cfg.owner, repo: ctx.cfg.repo, number: ctx.cfg.projectNumber },
  );
  const project = data.repositoryOwner?.projectV2;
  if (!project) {
    throw new Error(
      `project ${ctx.cfg.owner}/#${ctx.cfg.projectNumber} not found (checked user + organization)`,
    );
  }
  if (!data.repository?.id) {
    throw new Error(`repository ${ctx.cfg.owner}/${ctx.cfg.repo} not found`);
  }
  const repoData = data;

  const fields: Record<string, FieldInfo> = {};
  for (const f of project.fields.nodes) {
    if (!f?.name) continue;
    fields[f.name] = {
      id: f.id,
      dataType: f.dataType,
      options: f.options
        ? Object.fromEntries(f.options.map((o: any) => [o.name, o.id]))
        : undefined,
      // Captured from the ARRAY, before the map can lose it (see FieldInfo).
      optionOrder: f.options ? f.options.map((o: any) => String(o.name)) : undefined,
    };
  }

  // The suppression list is evidence a LIVE read already spent, so a schema
  // refresh must not make a confirmed-obsolete value news again. Without this
  // carry-over every priority mutation (each of which force-refreshes) would
  // reset it, and the repeated-refresh cost this field exists to bound would
  // come straight back on the next `next`.
  let prior: BoardCache | undefined;
  try {
    prior = JSON.parse(readFileSync(cachePath(ctx), "utf8")) as BoardCache;
  } catch {
    /* no usable prior cache — nothing to carry */
  }
  // Carried, but PRUNED against the schema just read: a suppressed name that is
  // live again (an option removed, then a later rename reusing the name) must
  // stop being suppressed, or the union in priorityOptionOrder would treat the
  // now-valid value as known-obsolete and rank it as stale. Every refresh is a
  // chance to learn that, so the pruning lives here rather than only on the
  // ordering path.
  const liveNames = new Set(fields[PRIORITY_FIELD]?.optionOrder ?? []);
  const carried = (prior?.unresolvedPriorities ?? []).filter((v) => !liveNames.has(v));
  const cache: BoardCache = {
    projectId: project.id,
    repositoryId: repoData.repository.id,
    fields,
    fetchedAt: ctx.now().toISOString(),
    ...(carried.length ? { unresolvedPriorities: carried } : {}),
    ...(prior?.unresolvedPrioritiesTruncated ? { unresolvedPrioritiesTruncated: true } : {}),
  };
  mkdirSync(ctx.cacheDir, { recursive: true });
  writeFileSync(cachePath(ctx), JSON.stringify(cache, null, 2));
  return cache;
}

export function ensureCache(ctx: Ctx): BoardCache {
  const p = cachePath(ctx);
  if (existsSync(p)) {
    try {
      return JSON.parse(readFileSync(p, "utf8"));
    } catch {
      /* corrupt — refresh */
    }
  }
  return refreshCache(ctx);
}

/** READ-ONLY ops: run against the cache; on any failure refresh once and
 *  retry. Never wrap a mutation in this — a mid-write retry would replay
 *  comments/closes/field writes. Mutations use mutationCache() instead. */
function withCache<T>(ctx: Ctx, op: (cache: BoardCache) => T): T {
  try {
    return op(ensureCache(ctx));
  } catch (e) {
    if (e instanceof RefusalError || e instanceof UsageError) throw e;
    return op(refreshCache(ctx));
  }
}

/** MUTATING ops resolve cache freshness BEFORE the first write: verify every
 *  (field, option) the op will need; refresh once if anything is missing;
 *  hard-error if still missing. The op itself then runs with NO retry, so a
 *  failure mid-write never replays earlier writes.
 *
 *  `optionalFields` are fields the op will use IF they exist (the Claim field
 *  before `board setup` runs). Their absence from the cache also triggers the
 *  one refresh — so a skip-if-absent decision is made against live schema,
 *  never a stale snapshot — but confirmed absence is not an error.
 *
 *  `liveOptionFields` are fields whose whole option SET the op validates a
 *  caller's value against. They force the refresh unconditionally, because
 *  `satisfied()` can only detect an option GitHub GAINED, never one it LOST:
 *  a cached-but-deleted option pre-validates clean and then fails at the field
 *  write — for `create`, after the issue exists, leaving exactly the
 *  unprioritized orphan the pre-validation was added to prevent. One extra
 *  schema read per priority write is the price of validating against truth. */
function mutationCache(
  ctx: Ctx,
  needs: Array<[field: string, option?: string]>,
  optionalFields: string[] = [],
  liveOptionFields: string[] = [],
): BoardCache {
  const satisfied = (c: BoardCache) =>
    needs.every(([f, o]) => c.fields[f] && (o === undefined || c.fields[f].options?.[o]));
  const optionalKnown = (c: BoardCache) => optionalFields.every((f) => c.fields[f]);
  let cache = ensureCache(ctx);
  if (liveOptionFields.length > 0 || !satisfied(cache) || !optionalKnown(cache))
    cache = refreshCache(ctx);
  if (!satisfied(cache)) {
    const missing = needs.filter(([f, o]) => !cache.fields[f] || (o !== undefined && !cache.fields[f].options?.[o]));
    throw new Error(
      `project is missing ${missing.map(([f, o]) => (o ? `option "${o}" on field "${f}"` : `field "${f}"`)).join(", ")} — run \`board setup\``,
    );
  }
  return cache;
}

// ---------------------------------------------------------------------------
// Issue read (parity: this is THE read shape; move/claim write these fields)
// ---------------------------------------------------------------------------

export interface Issue {
  number: number;
  nodeId: string;
  itemId: string | null; // project item in OUR project
  archived: boolean; // archived items reject all writes
  title: string;
  url: string;
  issueState: "OPEN" | "CLOSED";
  stateReason: string | null;
  state: string | null; // Workflow State field (may be legacy pre-migration)
  fieldValuesTruncated: boolean; // >FIELD_VALUE_PAGE values — state/claim reads unreliable, mutations refuse
  claim: Claim | null;
  claimRaw: string | null; // raw Claim text — non-null with claim null = garbled (hand-edited); join/leave refuse
  estimate: string | null;
  priority: string | null;
  labels: string[];
  labelsTruncated: boolean; // >LABEL_PAGE labels — apply detection fails closed
  parent: { number: number; title: string } | null;
  children: Array<{
    number: number;
    title: string;
    issueState: string;
    state: string | null;
    /** Child's own field-value page truncated: its board state is unreadable,
     *  not unset. Display-only — parentCheck gates on issueState, never this. */
    fieldValuesTruncated: boolean;
  }>;
  childrenTruncated: boolean; // >50 children — parentCheck fails closed on this
  blockedBy: Array<{ number: number; issueState: string; repo: string }>;
  blockersTruncated: boolean;
  prs: Array<{ number: number; url: string; state: string; merged: boolean }>;
}

/** One page of field values per item. Every other paged list in this file
 *  fails CLOSED on truncation; field values must too — Workflow State or Claim
 *  falling past the page would blind the MACHINE legality check (a null state
 *  skips it) and the claim guard (a null claim reads as unclaimed). */
const FIELD_VALUE_PAGE = 50;

const FIELD_VALUES_FRAGMENT = `fieldValues(first: ${FIELD_VALUE_PAGE}) {
  pageInfo { hasNextPage }
  nodes {
    ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2FieldCommon { name } } }
    ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { name } } }
  }
}`;

function fieldValuesTruncated(fieldValues: any): boolean {
  return fieldValues?.pageInfo?.hasNextPage ?? false;
}

function fieldValueMap(fieldValues: any): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of fieldValues?.nodes ?? []) {
    const name = v?.field?.name;
    if (!name) continue;
    if (typeof v.name === "string") out[name] = v.name;
    else if (typeof v.text === "string") out[name] = v.text;
  }
  return out;
}

export function fetchIssue(ctx: Ctx, number: number): Issue {
  return withCache(ctx, (cache) => {
    const data = ghGraphQL(
      ctx,
      `query($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          issue(number: $number) {
            id title url number state stateReason
            labels(first: 100) { pageInfo { hasNextPage } nodes { name } }
            parent { number title }
            subIssues(first: 50) {
              pageInfo { hasNextPage }
              nodes {
                number title state
                projectItems(first: 10) { nodes { project { id } ${FIELD_VALUES_FRAGMENT} } }
              }
            }
            blockedBy(first: 50) { pageInfo { hasNextPage } nodes { number state repository { nameWithOwner } } }
            closedByPullRequestsReferences(first: 10) { nodes { number url state merged } }
            projectItems(first: 20) { nodes { id isArchived project { id } ${FIELD_VALUES_FRAGMENT} } }
          }
        }
      }`,
      { owner: ctx.cfg.owner, repo: ctx.cfg.repo, number },
    );
    const issue = data.repository?.issue;
    if (!issue) throw new UsageError(`issue #${number} not found in ${ctx.cfg.owner}/${ctx.cfg.repo}`);

    const item = (issue.projectItems?.nodes ?? []).find(
      (n: any) => n.project?.id === cache.projectId,
    );
    const fv = fieldValueMap(item?.fieldValues);

    return {
      number: issue.number,
      nodeId: issue.id,
      itemId: item?.id ?? null,
      archived: item?.isArchived ?? false,
      title: issue.title,
      url: issue.url,
      issueState: issue.state,
      stateReason: issue.stateReason ?? null,
      state: fv[STATE_FIELD] ?? null,
      fieldValuesTruncated: fieldValuesTruncated(item?.fieldValues),
      claim: parseClaim(fv[CLAIM_FIELD]),
      claimRaw: fv[CLAIM_FIELD] ?? null,
      estimate: fv[ESTIMATE_FIELD] ?? null,
      priority: fv[PRIORITY_FIELD] ?? null,
      labels: (issue.labels?.nodes ?? []).map((l: any) => l.name),
      labelsTruncated: issue.labels?.pageInfo?.hasNextPage ?? false,
      parent: issue.parent ? { number: issue.parent.number, title: issue.parent.title } : null,
      children: (issue.subIssues?.nodes ?? []).map((c: any) => {
        const cItem = (c.projectItems?.nodes ?? []).find(
          (n: any) => n.project?.id === cache.projectId,
        );
        return {
          number: c.number,
          title: c.title,
          issueState: c.state,
          state: fieldValueMap(cItem?.fieldValues)[STATE_FIELD] ?? null,
          fieldValuesTruncated: fieldValuesTruncated(cItem?.fieldValues),
        };
      }),
      childrenTruncated: issue.subIssues?.pageInfo?.hasNextPage ?? false,
      blockedBy: (issue.blockedBy?.nodes ?? []).map((b: any) => ({
        number: b.number,
        issueState: b.state,
        repo: b.repository?.nameWithOwner ?? "",
      })),
      blockersTruncated: issue.blockedBy?.pageInfo?.hasNextPage ?? false,
      prs: (issue.closedByPullRequestsReferences?.nodes ?? []).map((p: any) => ({
        number: p.number,
        url: p.url,
        state: p.state,
        merged: p.merged,
      })),
    };
  });
}

/** Body + comment bodies for ONE issue. Deliberately a separate query rather
 *  than extra fields on `fetchIssue`: it is needed only when an apply issue is
 *  closed or swept (a handful of issues), and bodies are the largest payload
 *  on the board — the hot read path must not carry them. */
export function fetchApplyMeta(ctx: Ctx, number: number): { body: string; comments: string[] } {
  const data = ghGraphQL(
    ctx,
    `query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        issue(number: $number) { body comments(last: 50) { nodes { body } } }
      }
    }`,
    { owner: ctx.cfg.owner, repo: ctx.cfg.repo, number },
  );
  const issue = data.repository?.issue;
  return {
    body: issue?.body ?? "",
    comments: (issue?.comments?.nodes ?? []).map((c: any) => c?.body ?? ""),
  };
}

/** What doctor's state-smell checks (GH-1715) read: the comment trail the
 *  machine itself wrote, when the board last wrote this item's Workflow State
 *  (= when it entered its current state), and whether a linked PR has moved. */
export interface IssueHistory {
  /** Comment bodies, OLDEST-truncated: only the last HISTORY_COMMENTS are read,
   *  so every count derived from this is a LOWER bound. Deliberate — a smell
   *  check that under-fires stays quiet, one that over-fires invents a smell. */
  comments: string[];
  /** ISO instant the board's Workflow State value was last written. Null when
   *  the issue is not on this board (or the value was never set). */
  stateUpdatedAt: string | null;
  /** updatedAt of every PR that would close this issue — "is the PR moving?" */
  prActivityAt: string[];
}

const HISTORY_COMMENTS = 60;
const HISTORY_CHUNK = 20; // issues per round trip

const HISTORY_SELECTION = `
  comments(last: ${HISTORY_COMMENTS}) { nodes { body } }
  closedByPullRequestsReferences(first: 10) { nodes { updatedAt } }
  projectItems(first: 10) {
    nodes {
      project { id }
      fieldValues(first: 20) {
        nodes {
          ... on ProjectV2ItemFieldSingleSelectValue {
            updatedAt field { ... on ProjectV2FieldCommon { name } }
          }
        }
      }
    }
  }`;

/** History for MANY issues, batched behind GraphQL aliases. A query per open
 *  item would multiply doctor's cost by the size of the board (and the
 *  reconciler cron runs every 15 min), so `HISTORY_CHUNK` issues share one
 *  round trip. Bodies are never requested — only comments, which is where the
 *  machine's audit trail lives. Issues that came back null are simply absent
 *  from the map; every caller must treat "no history" as "no smell". */
export function fetchHistories(ctx: Ctx, numbers: number[]): Map<number, IssueHistory> {
  const out = new Map<number, IssueHistory>();
  if (numbers.length === 0) return out;
  return withCache(ctx, (cache) => {
    let succeeded = 0;
    let lastFailure: unknown = null;
    for (let start = 0; start < numbers.length; start += HISTORY_CHUNK) {
      const chunk = numbers.slice(start, start + HISTORY_CHUNK);
      const decls = chunk.map((_, k) => `$n${k}: Int!`).join(", ");
      const aliases = chunk
        .map((_, k) => `a${k}: issue(number: $n${k}) { ${HISTORY_SELECTION} }`)
        .join("\n");
      const vars: Record<string, unknown> = { owner: ctx.cfg.owner, repo: ctx.cfg.repo };
      chunk.forEach((n, k) => (vars[`n${k}`] = n));
      let data: any;
      try {
        data = ghGraphQL(
          ctx,
          `query($owner: String!, $repo: String!, ${decls}) {
            repository(owner: $owner, name: $repo) {
              ${aliases}
            }
          }`,
          vars,
        );
      } catch (e) {
        // Per-CHUNK fault isolation: one failed round trip (transient 5xx, or
        // a deleted issue's NOT_FOUND poisoning its whole alias batch) leaves
        // this chunk's issues absent from the map — the documented caller
        // contract ("no history = no smell") — instead of throwing away every
        // OTHER chunk's good data and degrading all smells to "not evaluated".
        lastFailure = e;
        continue;
      }
      succeeded++;
      const repo: any = data.repository ?? {};
      chunk.forEach((n, k) => {
        const issue = repo[`a${k}`];
        if (!issue) return;
        const item = (issue.projectItems?.nodes ?? []).find(
          (x: any) => x?.project?.id === cache.projectId,
        );
        const stateValue = (item?.fieldValues?.nodes ?? []).find(
          (v: any) => v?.field?.name === STATE_FIELD,
        );
        out.set(n, {
          comments: (issue.comments?.nodes ?? []).map((c: any) => c?.body ?? ""),
          stateUpdatedAt: stateValue?.updatedAt ?? null,
          prActivityAt: (issue.closedByPullRequestsReferences?.nodes ?? [])
            .map((p: any) => p?.updatedAt)
            .filter((t: unknown): t is string => typeof t === "string"),
        });
      });
    }
    // EVERY chunk failing is not partial degradation — it is the history read
    // failing, and the caller's honest report is "not evaluated", not "no smell".
    if (succeeded === 0 && lastFailure !== null) throw lastFailure;
    return out;
  });
}

/** The one question the close gate and doctor both ask: is this apply issue
 *  evidenced? Returns null when it is, else the first failing rule. */
export function applyEvidenceFailure(ctx: Ctx, number: number): string | null {
  const { comments } = fetchApplyMeta(ctx, number);
  return validateApplyEvidence(parseApplyEvidence(comments), ctx.now());
}

// ---------------------------------------------------------------------------
// Mutation primitives
// ---------------------------------------------------------------------------

function requireItem(issue: Issue): string {
  if (!issue.itemId) {
    throw new RefusalError(
      `#${issue.number} is not on the project board — add it first (board create adds automatically)`,
    );
  }
  if (issue.archived) {
    throw new RefusalError(
      `#${issue.number}'s project item is ARCHIVED — GitHub rejects all writes to it. Unarchive it in the board UI first.`,
    );
  }
  return issue.itemId;
}

function setSingleSelect(
  ctx: Ctx,
  cache: BoardCache,
  itemId: string,
  fieldName: string,
  optionName: string,
): void {
  const field = cache.fields[fieldName];
  const optionId = field?.options?.[optionName];
  if (!field || !optionId) {
    throw new Error(`field "${fieldName}" option "${optionName}" not in cache`);
  }
  ghGraphQL(
    ctx,
    `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId, itemId: $itemId, fieldId: $fieldId,
        value: { singleSelectOptionId: $optionId }
      }) { projectV2Item { id } }
    }`,
    { projectId: cache.projectId, itemId, fieldId: field.id, optionId },
  );
}

function setText(ctx: Ctx, cache: BoardCache, itemId: string, fieldName: string, text: string): void {
  const field = cache.fields[fieldName];
  if (!field) throw new Error(`field "${fieldName}" not in cache`);
  ghGraphQL(
    ctx,
    `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $text: String!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: { text: $text }
      }) { projectV2Item { id } }
    }`,
    { projectId: cache.projectId, itemId, fieldId: field.id, text },
  );
}

function clearField(ctx: Ctx, cache: BoardCache, itemId: string, fieldName: string): void {
  const field = cache.fields[fieldName];
  if (!field) throw new Error(`field "${fieldName}" not in cache`);
  ghGraphQL(
    ctx,
    `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!) {
      clearProjectV2ItemFieldValue(input: {
        projectId: $projectId, itemId: $itemId, fieldId: $fieldId
      }) { projectV2Item { id } }
    }`,
    { projectId: cache.projectId, itemId, fieldId: field.id },
  );
}

function addComment(ctx: Ctx, subjectId: string, body: string): void {
  ghGraphQL(
    ctx,
    `mutation($subjectId: ID!, $body: String!) {
      addComment(input: { subjectId: $subjectId, body: $body }) { clientMutationId }
    }`,
    { subjectId, body },
  );
}

function closeIssue(ctx: Ctx, nodeId: string, reason: "COMPLETED" | "NOT_PLANNED"): void {
  ghGraphQL(
    ctx,
    `mutation($issueId: ID!, $stateReason: IssueClosedStateReason) {
      closeIssue(input: { issueId: $issueId, stateReason: $stateReason }) { issue { id } }
    }`,
    { issueId: nodeId, stateReason: reason },
  );
}

function reopenIssue(ctx: Ctx, nodeId: string): void {
  ghGraphQL(
    ctx,
    `mutation($issueId: ID!) { reopenIssue(input: { issueId: $issueId }) { issue { id } } }`,
    { issueId: nodeId },
  );
}

/** Best-effort built-in Status sync; never fails the mutation. */
function syncStatus(ctx: Ctx, cache: BoardCache, itemId: string, state: State): void {
  try {
    setSingleSelect(ctx, cache, itemId, STATUS_FIELD, STATUS_SYNC[state]);
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// Transition engine — the INTENT lane.
//
// Three sanctioned write lanes, all typed, all evidenced:
//   transition()  — agent intent, guarded by the MACHINE table + claim guard
//   reconcile()   — reality sync (issue closed/reopened wins over the table)
//   parentCheck() — rollup (children all closed → parent to In Review,
//                   deliberately multi-hop past the table)
// Nothing else writes the state field.
// ---------------------------------------------------------------------------

interface MoveOpts {
  why?: string; // mandatory for Human Needed / release / cancel
  steal?: boolean; // claim only
  isReopen?: boolean;
}

/** Guard for leaving In Progress: caller must be a claim MEMBER (ClaimV2 —
 *  any holder of a shared fleet claim may move the item), or it is stale. */
function guardHolder(ctx: Ctx, issue: Issue): void {
  const claim = issue.claim;
  if (!claim) return; // no claim — nothing to guard
  if (isMember(claim, ctx.cfg.holder)) return;
  if (claimIsStale(claim, ctx.now(), ctx.cfg.lockTtlMin)) return;
  throw new RefusalError(
    `#${issue.number} is claimed by ${claim.holders.join("+")} (${claimAgeMin(claim, ctx.now()).toFixed(0)} min ago, ` +
      `TTL ${ctx.cfg.lockTtlMin} min). Wait for TTL expiry or have the holder release it.`,
  );
}

export function transition(ctx: Ctx, issue: Issue, to: State, opts: MoveOpts = {}): Issue {
  // Cache freshness resolved BEFORE any write; the body never retries.
  const cache = mutationCache(ctx, [[STATE_FIELD, to]], [CLAIM_FIELD]);
  {
    // Fail closed BEFORE any write: a truncated field-value page means the
    // state and claim just read may be wrong — the legality check and claim
    // guard below would be judging fiction.
    if (issue.fieldValuesTruncated) {
      throw new RefusalError(
        `#${issue.number} has more than ${FIELD_VALUE_PAGE} project field values — ` +
          `state/claim reads are unreliable, refusing to mutate`,
      );
    }
    const from = issue.state;

    if (from !== null && !isState(from)) {
      throw new RefusalError(
        `#${issue.number} is in legacy state "${from}" — set a v2 state on it in the board UI before mutating it`,
      );
    }
    // Same-state In Progress is claim (re)acquisition, not a transition:
    // adopting claimless WIP or refreshing one's own claim. Fully guarded by
    // the claim checks below; the state write is a harmless same-value set.
    const isClaimRefresh = from === "In Progress" && to === "In Progress";
    if (from !== null && !opts.isReopen && !isClaimRefresh && !legalTransition(from as State, to)) {
      throw new RefusalError(
        `illegal transition for #${issue.number}: "${from}" → "${to}". ` +
          `Legal: ${MACHINE[from as State].join(", ") || "(none — use reopen)"}`,
      );
    }
    if (from !== null && opts.isReopen && !["Done", "Canceled"].includes(from)) {
      throw new RefusalError(`reopen is for Done/Canceled issues; #${issue.number} is "${from}"`);
    }
    if (to === "Human Needed" && !opts.why) {
      throw new UsageError(
        `moving to Human Needed requires --why "<the exact decision needed>" — it becomes the escalation comment`,
      );
    }
    // Done requires evidence: a merged linked PR, or an explicit --why on the
    // record. Intent lane only — reconcile() reflects reality unchecked.
    const doneWithoutMergedPr = to === "Done" && !issue.prs.some((p) => p.merged);
    const applyKind = isApplyIssue(ctx.cfg, issue.labels, issue.labelsTruncated);
    if (doneWithoutMergedPr && !opts.why && !applyKind) {
      throw new UsageError(
        `moving #${issue.number} to Done requires a merged linked PR — none found. ` +
          `Pass --why "<how this was completed>" to complete without one.`,
      );
    }
    // Apply-kind close gate (GH-1693). PREVENTIVE, not advisory: an apply unit
    // reaches Done only on shape-valid `ralph-apply-evidence:v1`.
    //
    // There is deliberately NO --why escape here. --why means "completed
    // without a merged PR", which is the NORMAL case for an apply unit — so
    // honouring it would hand every apply issue a one-flag bypass of the only
    // gate that makes the kind mean anything. A merged PR is not an escape
    // either: a merge is exactly the thing this kind refuses to accept as proof.
    if (to === "Done" && applyKind) {
      const failure = applyEvidenceFailure(ctx, issue.number);
      if (failure) {
        throw new RefusalError(
          `#${issue.number} is an apply unit (label "${ctx.cfg.apply.label}") — Done requires deployed-and-verified evidence: ${failure}. ` +
            `Post one with scripts/apply-evidence.sh, or move it to Human Needed if the apply cannot be done. ` +
            `(--why does not bypass this.)`,
        );
      }
    }

    const itemId = requireItem(issue);
    const leavingInProgress = from === "In Progress" && to !== "In Progress";
    const enteringInProgress = to === "In Progress";

    if (leavingInProgress) guardHolder(ctx, issue);
    if (enteringInProgress) {
      const claim = issue.claim;
      if (claim && !isMember(claim, ctx.cfg.holder)) {
        const stale = claimIsStale(claim, ctx.now(), ctx.cfg.lockTtlMin);
        if (!stale) {
          // Late in the TTL, append the expiry clock time — the one fact the
          // refusal is missing. Never below the threshold (see claimHintDue).
          const hint =
            claimHintDue(claim, ctx.now(), ctx.cfg.lockTtlMin) ?
              `\nThat claim expires ~${formatLocalHm(claimExpiry(claim, ctx.cfg.lockTtlMin))} — ` +
              `\`board claim ${issue.number} --steal\` is honest after that.`
            : "";
          throw new RefusalError(
            `#${issue.number} is claimed by ${claim.holders.join("+")} ` +
              `(${claimAgeMin(claim, ctx.now()).toFixed(0)} min ago, TTL ${ctx.cfg.lockTtlMin} min). ` +
              `Pick other work, or wait for TTL and use \`board claim ${issue.number} --steal\`.` +
              hint,
          );
        }
        if (!opts.steal) {
          throw new RefusalError(
            `#${issue.number} has a STALE claim by ${claim.holders.join("+")}. ` +
              `Re-run with --steal to take it over (posts an eviction comment).`,
          );
        }
        addComment(
          ctx,
          issue.nodeId,
          `\`board\`: stale claim by \`${claim.holders.join("+")}\` (since ${claim.since.toISOString()}) ` +
            `evicted by \`${ctx.cfg.holder}\` after TTL ${ctx.cfg.lockTtlMin} min.`,
        );
      }
    }

    // Comments BEFORE state write so an interrupted run leaves evidence, not a bare state.
    if (opts.why) {
      const header =
        to === "Human Needed" ? "Decision needed"
        : to === "Canceled" ? "Canceled"
        : doneWithoutMergedPr ? "Completed without merged PR"
        : "Parked";
      addComment(ctx, issue.nodeId, `**${header}** (\`board\` by \`${ctx.cfg.holder}\`):\n\n${opts.why}`);
    }

    // Claim field: entering In Progress sets it (clear-then-set — the value carries
    // the timestamp, so we never depend on the field's own updatedAt); leaving clears.
    let claimWritten = false;
    if (cache.fields[CLAIM_FIELD]) {
      if (enteringInProgress) {
        // Any-member heartbeat: when the caller already holds (part of) the
        // claim, refresh the ONE shared since and keep the co-holders — a
        // fleet sibling's refresh must not evict its siblings. Otherwise
        // (no claim, or a stale claim the --steal path above adjudicated) a
        // fresh single-holder claim.
        const next =
          (issue.claim && heartbeat(issue.claim, ctx.cfg.holder, ctx.now())) ??
          { holders: [ctx.cfg.holder], since: ctx.now() };
        clearField(ctx, cache, itemId, CLAIM_FIELD);
        setText(ctx, cache, itemId, CLAIM_FIELD, formatClaim(next));
        claimWritten = true;
      } else if (leavingInProgress) {
        // Release = removeHolder: the leaving member drops out; co-holders
        // keep the claim (shared since untouched); the LAST one out clears
        // the field. A non-member mover (the stale-guard path) clears
        // outright — writing a dead claim back would manufacture an anomaly.
        const rest =
          issue.claim && isMember(issue.claim, ctx.cfg.holder)
            ? removeHolder(issue.claim, ctx.cfg.holder)
            : null;
        clearField(ctx, cache, itemId, CLAIM_FIELD);
        if (rest) setText(ctx, cache, itemId, CLAIM_FIELD, formatClaim(rest));
      }
    }

    try {
      setSingleSelect(ctx, cache, itemId, STATE_FIELD, to);
    } catch (err) {
      // A claim without its state write is a claim-anomaly. The rollback is
      // best-effort (its own failure is swallowed); doctor remains the backstop.
      if (claimWritten) {
        try {
          clearField(ctx, cache, itemId, CLAIM_FIELD);
        } catch {
          /* best-effort */
        }
      }
      throw err;
    }
    syncStatus(ctx, cache, itemId, to);

    if (to === "Done") closeIssue(ctx, issue.nodeId, "COMPLETED");
    if (to === "Canceled") closeIssue(ctx, issue.nodeId, "NOT_PLANNED");
    if (opts.isReopen && issue.issueState === "CLOSED") reopenIssue(ctx, issue.nodeId);

    // Mutation echo: re-read so the caller sees what the board now says
    // (parity) — and, for claims, VERIFY the write won. GitHub has no
    // compare-and-swap: two racers can both pass the pre-check; the re-read
    // makes the loser find out and back off instead of believing it holds
    // the item. A residual window remains (documented in the design).
    const after = fetchIssue(ctx, issue.number);
    // The write itself can push the item past the page (Claim + Status add up
    // to two values): a truncated echo cannot verify claim state, and must
    // say so rather than let the null-claim branches assert a race narrative
    // ("vanished"/"lost") that may be fiction.
    if ((to === "In Progress" || leavingInProgress) && after.fieldValuesTruncated) {
      throw new RefusalError(
        `#${issue.number}: the post-write read came back truncated (>${FIELD_VALUE_PAGE} field values) — ` +
          `claim state unverifiable; check with \`board get ${issue.number}\` or let doctor reconcile`,
      );
    }
    if (to === "In Progress" && (!after.claim || !isMember(after.claim, ctx.cfg.holder))) {
      // Either a rival's write landed last, or a concurrent clear wiped the
      // claim — in both cases this session does NOT hold the item.
      throw new RefusalError(
        after.claim
          ? `lost the claim race on #${issue.number} to ${after.claim.holders.join("+")} — pick other work`
          : `claim on #${issue.number} vanished after the write (concurrent clear) — pick other work`,
      );
    }
    // Symmetric verify for the leaving side: the same re-read must show this
    // session OUT of the claim (gone, or co-holders only) — surviving
    // membership means the clear did not stick and this session would
    // silently keep the item.
    if (leavingInProgress && after.claim && isMember(after.claim, ctx.cfg.holder)) {
      throw new RefusalError(
        `claim on #${issue.number} survived the clear (the write did not stick) — ` +
          `state is now "${to}" but the claim remains; re-run the move or let doctor release it`,
      );
    }

    // Parent gate: a child reaching In Review/Done may advance the parent.
    if ((to === "In Review" || to === "Done") && after.parent) {
      try {
        parentCheck(ctx, after.parent.number);
      } catch {
        /* advisory here; state-guard + doctor re-run it */
      }
    }
    return after;
  }
}

/** Parent gate — the ROLLUP lane (third of three write lanes; see the
 *  transition-engine comment). All children terminal → parent advances to
 *  In Review, deliberately multi-hop (a Backlog parent whose children all
 *  shipped must surface for review — the v1 carve-out that proved out).
 *  Fails CLOSED when the children list is truncated. */
export function parentCheck(ctx: Ctx, parentNumber: number): string {
  const parent = fetchIssue(ctx, parentNumber);
  if (parent.children.length === 0) return `#${parentNumber}: no children`;
  if (parent.fieldValuesTruncated) {
    return `#${parentNumber}: field values truncated (>${FIELD_VALUE_PAGE}) — state unreadable, refusing to gate`;
  }
  if (parent.state === null || !isState(parent.state)) return `#${parentNumber}: not on v2 board`;
  if (["In Review", "Done", "Canceled"].includes(parent.state)) {
    return `#${parentNumber}: already ${parent.state}`;
  }
  if (parent.childrenTruncated) {
    return `#${parentNumber}: more than ${parent.children.length} children — refusing to gate on a truncated list`;
  }
  const open = parent.children.filter((c) => c.issueState === "OPEN");
  if (open.length > 0) {
    return `#${parentNumber}: ${open.length}/${parent.children.length} children still open`;
  }
  guardHolder(ctx, parent);
  const cache = mutationCache(ctx, [[STATE_FIELD, "In Review"]], [CLAIM_FIELD]);
  const itemId = requireItem(parent);
  if (cache.fields[CLAIM_FIELD] && parent.state === "In Progress") {
    clearField(ctx, cache, itemId, CLAIM_FIELD);
  }
  setSingleSelect(ctx, cache, itemId, STATE_FIELD, "In Review");
  syncStatus(ctx, cache, itemId, "In Review");
  addComment(
    ctx,
    parent.nodeId,
    `\`board\`: all ${parent.children.length} children closed — parent advanced to In Review (rollup lane).`,
  );
  return `#${parentNumber}: advanced to In Review (all ${parent.children.length} children closed)`;
}

// ---------------------------------------------------------------------------
// Shared-claim fleet verbs (ralph-herdr v2 Phase 3) — explicit join/leave for
// multi-sibling issues. ClaimV2 already carries the fleet (1..8 holders, ONE
// shared since); these verbs give the cockpit the membership edit that
// transition() only performs as a side effect of moving state. They touch the
// Claim field ONLY: a last-out leave deliberately strands an In Progress item
// claimless (doctor's claimless-wip line surfaces it) rather than inventing a
// fourth state-write lane — board transitions stay the skills' job.
// ---------------------------------------------------------------------------

/** The guards every claim edit shares: item on the board, field values fully
 *  readable (a truncated page could hide the live claim), and a parseable
 *  claim — a hand-edited Claim field is a human's note to self and is never
 *  rewritten (the same rule doctor's claim-garbled check states). */
function guardClaimEdit(issue: Issue): string {
  const itemId = requireItem(issue);
  if (issue.fieldValuesTruncated) {
    throw new RefusalError(
      `#${issue.number} has more than ${FIELD_VALUE_PAGE} project field values — ` +
        `state/claim reads are unreliable, refusing to mutate`,
    );
  }
  if (issue.claimRaw !== null && !issue.claim) {
    throw new RefusalError(
      `#${issue.number}'s Claim text is unparseable (${JSON.stringify(issue.claimRaw)}) — ` +
        `want "holder[+holder2...]|iso8601"; a hand-edited claim is never rewritten. Fix it in the board UI first.`,
    );
  }
  return itemId;
}

/** Post-write membership verify, shared by join and leave: GitHub has no CAS,
 *  so the echo re-read is the only proof the edit stuck (same protocol as
 *  transition()). `wantMember` is the direction being verified. */
function verifyClaimEcho(ctx: Ctx, number: number, holder: string, wantMember: boolean): Issue {
  const after = fetchIssue(ctx, number);
  if (after.fieldValuesTruncated) {
    throw new RefusalError(
      `#${number}: the post-write read came back truncated (>${FIELD_VALUE_PAGE} field values) — ` +
        `claim state unverifiable; check with \`board get ${number}\` or let doctor reconcile`,
    );
  }
  const member = after.claim !== null && isMember(after.claim, holder);
  if (wantMember && !member) {
    throw new RefusalError(
      after.claim
        ? `lost the claim race on #${number} to ${after.claim.holders.join("+")} — the join did not stick`
        : `claim on #${number} vanished after the write (concurrent clear) — the join did not stick`,
    );
  }
  if (!wantMember && member) {
    throw new RefusalError(
      `claim on #${number} survived the leave (the write did not stick) — ` +
        `re-run the leave or let doctor release it`,
    );
  }
  return after;
}

/** Fleet join: addHolder onto the item's shared claim. In Progress only — a
 *  sibling joining work nobody started would smuggle in the state transition
 *  this verb refuses to own (and there is no --force, by design). Joining a
 *  claimless In Progress item creates the claim, mirroring transition()'s
 *  acquisition arm; joining refreshes the ONE shared since (any-member
 *  heartbeat semantics), so a fleet's TTL clock restarts on every arrival.
 *  That refresh applies to a STALE claim too — deliberately: arrival is
 *  treated as liveness, so a join resurrects the absent holders' claim with
 *  no comment trail. A driver waiting out a stale TTL should evict via
 *  `board claim NNN --steal` (which posts the eviction comment), not join. */
export function claimJoin(ctx: Ctx, number: number, holder: string): Issue {
  if (!isValidHolder(holder)) {
    throw new UsageError(
      `--holder must be a grammar-B agent name (<lane><issue>-<slug>, lanes ` +
        `w/r/o/d/s/x) or a legacy name (gh-N, ralph-deliver, ralph-tend) — got ${JSON.stringify(holder)}`,
    );
  }
  // Cache freshness resolved BEFORE any write; the body never retries.
  const cache = mutationCache(ctx, [[CLAIM_FIELD]]);
  const issue = fetchIssue(ctx, number);
  const itemId = guardClaimEdit(issue);
  if (issue.state !== "In Progress") {
    throw new RefusalError(
      `#${number} is "${issue.state ?? "(none)"}" — join is for In Progress items only. ` +
        `Claim it first (\`board claim ${number}\`); there is no --force.`,
    );
  }
  let next: Claim;
  try {
    next = issue.claim
      ? addHolder(issue.claim, holder, ctx.now())
      : { holders: [holder], since: ctx.now() };
  } catch (e) {
    // addHolder's holder-cap (8) refusal — an invariant, not a usage slip.
    if (e instanceof RangeError) throw new RefusalError(`#${number}: ${e.message}`);
    throw e;
  }
  // Clear-then-set, like every claim write: the value carries the timestamp,
  // so we never depend on the field's own updatedAt.
  clearField(ctx, cache, itemId, CLAIM_FIELD);
  setText(ctx, cache, itemId, CLAIM_FIELD, formatClaim(next));
  return verifyClaimEcho(ctx, number, holder, true);
}

/** Fleet leave: removeHolder from the shared claim. A non-member leave is an
 *  idempotent no-op (`changed: false`, no write); the LAST member out clears
 *  the field; co-holders keep the claim with its since untouched. No state
 *  guard: removing oneself from an anomalous claim (claim on a non-In-
 *  Progress item) is cleanup, and trapping the holder would help nobody. */
export function claimLeave(
  ctx: Ctx,
  number: number,
  holder: string,
): { issue: Issue; changed: boolean } {
  const cache = mutationCache(ctx, [[CLAIM_FIELD]]);
  const issue = fetchIssue(ctx, number);
  const itemId = guardClaimEdit(issue);
  if (!issue.claim || !isMember(issue.claim, holder)) return { issue, changed: false };
  const rest = removeHolder(issue.claim, holder);
  clearField(ctx, cache, itemId, CLAIM_FIELD);
  if (rest) setText(ctx, cache, itemId, CLAIM_FIELD, formatClaim(rest));
  return { issue: verifyClaimEcho(ctx, number, holder, false), changed: true };
}

/** What `claim show` reports — the claim exactly as the board holds it, plus
 *  the time semantics board.ts owns (age against the configured TTL). */
export interface ClaimShow {
  number: number;
  state: string | null;
  claim: Claim | null;
  claimRaw: string | null; // non-null with claim null = garbled
  ageMin: number | null;
  ttlMin: number;
  stale: boolean | null; // null when there is nothing to age
}

export function claimShow(ctx: Ctx, number: number): ClaimShow {
  const issue = fetchIssue(ctx, number);
  return {
    number: issue.number,
    state: issue.state,
    claim: issue.claim,
    claimRaw: issue.claimRaw,
    ageMin: issue.claim ? claimAgeMin(issue.claim, ctx.now()) : null,
    ttlMin: ctx.cfg.lockTtlMin,
    stale: issue.claim ? claimIsStale(issue.claim, ctx.now(), ctx.cfg.lockTtlMin) : null,
  };
}

// ---------------------------------------------------------------------------
// Answer — the Human Needed exit verb (ralph-herdr v2), COMMENT-FIRST.
//
// The durable half (a GitHub **Answer** comment) lands BEFORE the state write,
// extending transition()'s comments-before-state rule across the whole verb:
// if the process — or the multiplexer driving it — vanishes mid-answer, the
// decision is on the record and the item is still in Human Needed for a clean
// retry. The herdr prompt half (nudging the paused agent to resume) is
// deliberately NOT here: the board is authoritative and herdr decorative, so
// the prompt belongs to plugin/ralph-herdr. Escalation payload shape stays
// `board contract validate ralph.escalation`'s job — this verb validates
// nothing about the question, it only answers it.
// ---------------------------------------------------------------------------

export interface AnswerResult {
  commented: boolean;
  transitioned: boolean;
  state: string | null;
}

export function answer(
  ctx: Ctx,
  number: number,
  opts: { message: string; anyState?: boolean; commentOnly?: boolean },
): AnswerResult {
  const issue = fetchIssue(ctx, number);
  // Fail closed BEFORE the comment: a truncated field-value page means the
  // state just read may be fiction, and the Human Needed gate below would be
  // judging it.
  if (issue.fieldValuesTruncated) {
    throw new RefusalError(
      `#${number} has more than ${FIELD_VALUE_PAGE} project field values — ` +
        `the state read is unreliable, refusing to answer`,
    );
  }
  if (issue.state !== "Human Needed" && !opts.anyState) {
    throw new RefusalError(
      `#${number} is "${issue.state ?? "(none)"}" — answer is for Human Needed items. ` +
        `Re-run with --any-state to post the answer comment anyway (comment only, no transition), ` +
        `or use \`board comment ${number} -m\` for a plain comment.`,
    );
  }
  // Durable half FIRST. Whatever happens after this line, the decision exists.
  addComment(ctx, issue.nodeId, `**Answer** (\`board\` by \`${ctx.cfg.holder}\`):\n\n${opts.message}`);
  // The Human Needed → In Progress edge is the ONLY move this verb owns:
  // --comment-only skips it, and an --any-state answer outside Human Needed
  // has no edge to take — relaxing the refusal never relaxes the MACHINE.
  if (opts.commentOnly || issue.state !== "Human Needed") {
    return { commented: true, transitioned: false, state: issue.state };
  }
  try {
    const after = transition(ctx, issue, "In Progress");
    return { commented: true, transitioned: true, state: after.state };
  } catch (e) {
    // The durable half already happened — a refusal here (fleet co-holders
    // still on the claim, a lost claim race) must say so, or the operator
    // re-posts the same answer to retry a move.
    if (e instanceof RefusalError) {
      throw new RefusalError(
        `${e.message}\nThe answer comment IS on the record — retry the move ` +
          `(\`board claim ${number}\`), not the answer.`,
      );
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Adopt + reconcile — the reality-sync lane (used by state-guard.yml).
//
// `transition` governs agent INTENT and is guarded by the MACHINE table.
// `reconcile` syncs board state to GitHub REALITY (issue closed/reopened) and
// deliberately bypasses the table — a human closing an issue from Backlog is
// legal reality even though Backlog→Done is an illegal intent transition.
// Every correction posts a comment. Still no --force anywhere.
// ---------------------------------------------------------------------------

/** Ensure the issue is on the board with a state; new items land in Backlog. */
export function adopt(ctx: Ctx, number: number, prefetched?: Issue): Issue {
  const cache = mutationCache(ctx, [[STATE_FIELD, "Backlog"]]);
  // `prefetched` is internal plumbing for reconcile, whose own read of the
  // same issue is milliseconds old — the CLI `board adopt` path always reads
  // fresh. The echo re-read at the bottom (adopt's parity contract) stays.
  let issue = prefetched ?? fetchIssue(ctx, number);
  if (issue.archived) return issue; // archived items reject writes — no-op
  if (!issue.itemId) {
    const added = ghGraphQL(
      ctx,
      `mutation($projectId: ID!, $contentId: ID!) {
        addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) { item { id } }
      }`,
      { projectId: cache.projectId, contentId: issue.nodeId },
    );
    issue = { ...issue, itemId: added.addProjectV2ItemById.item.id };
  }
  // state === null on a TRUNCATED read may be a live state past the page —
  // adding to the board (above) is safe for a truncated item (a never-added
  // item has no field values), but writing Backlog over an unreadable state
  // is not (fail closed, like every write lane).
  if (issue.state === null && !issue.fieldValuesTruncated) {
    setSingleSelect(ctx, cache, issue.itemId!, STATE_FIELD, "Backlog");
    syncStatus(ctx, cache, issue.itemId!, "Backlog");
  }
  return fetchIssue(ctx, number);
}

/** Sync board state to issue reality. Returns a description of what changed. */
export function reconcile(ctx: Ctx, number: number): string {
  const cache = mutationCache(
    ctx,
    [[STATE_FIELD, "Done"], [STATE_FIELD, "Canceled"], [STATE_FIELD, "Backlog"], [STATE_FIELD, "Human Needed"]],
    [CLAIM_FIELD],
  );
  {
    const issue = fetchIssue(ctx, number);
    if (!issue.itemId) {
      adopt(ctx, number, issue);
      return `#${number}: adopted to board (Backlog)`;
    }
    if (issue.archived) {
      return `#${number}: project item archived — skipped (unarchive in the board UI to reconcile)`;
    }
    // Fail closed on a truncated field-value page: the state this lane would
    // "correct" may simply have fallen past the page window, and reconciling
    // fiction demotes live WIP (the reconciler cron would redo it every tick).
    if (issue.fieldValuesTruncated) {
      return `#${number}: field values truncated (>${FIELD_VALUE_PAGE}) — state unreadable, refusing to reconcile`;
    }

    // Apply-kind correction lane (GH-1693). GitHub has no pre-close hook, so a
    // human (or a stray closing keyword) CAN close an apply issue from the UI.
    // This is the corrective half, honestly labelled: the close is undone
    // within one reconcile pass — reopened and routed to Human Needed, never
    // silently accepted as Done. NOT_PLANNED is left alone: cancelling an apply
    // unit is a legitimate decision, not a false completion.
    if (
      issue.issueState === "CLOSED" &&
      issue.stateReason !== "NOT_PLANNED" &&
      isApplyIssue(ctx.cfg, issue.labels, issue.labelsTruncated)
    ) {
      const failure = applyEvidenceFailure(ctx, number);
      if (failure) {
        if (issue.claim && cache.fields[CLAIM_FIELD]) clearField(ctx, cache, issue.itemId, CLAIM_FIELD);
        // Comment BEFORE the writes: an interrupted run must leave the reason,
        // not a bare state (same ordering rule as transition()).
        addComment(
          ctx,
          issue.nodeId,
          `\`board reconcile\`: #${number} is an apply unit (label \`${ctx.cfg.apply.label}\`) closed as completed, ` +
            `but it carries no deployed-and-verified evidence: ${failure}\n\n` +
            `Reopened and routed to **Human Needed**. A merge is not an apply — either post ` +
            `\`ralph-apply-evidence:v1\` (scripts/apply-evidence.sh) and close it again, or cancel it as not-planned.`,
        );
        reopenIssue(ctx, issue.nodeId);
        setSingleSelect(ctx, cache, issue.itemId, STATE_FIELD, "Human Needed");
        syncStatus(ctx, cache, issue.itemId, "Human Needed");
        return `#${number}: apply unit closed without evidence — reopened to Human Needed (${failure})`;
      }
    }

    const target: State | null =
      issue.issueState === "CLOSED"
        ? issue.stateReason === "NOT_PLANNED"
          ? "Canceled"
          : "Done"
        : issue.state !== null && ["Done", "Canceled"].includes(issue.state)
          ? "Backlog" // reopened but board still terminal
          : issue.state === null
            ? "Backlog"
            : null;

    if (target === null || issue.state === target) {
      if (issue.issueState === "OPEN" && issue.state !== null && !isState(issue.state)) {
        return `#${number}: legacy state "${issue.state}" — fix it in the board UI, not reconcile's job`;
      }
      return `#${number}: no drift`;
    }

    if (issue.claim && cache.fields[CLAIM_FIELD]) clearField(ctx, cache, issue.itemId, CLAIM_FIELD);
    setSingleSelect(ctx, cache, issue.itemId, STATE_FIELD, target);
    syncStatus(ctx, cache, issue.itemId, target);
    addComment(
      ctx,
      issue.nodeId,
      `\`board reconcile\`: issue is ${issue.issueState === "CLOSED" ? `closed (${issue.stateReason ?? "completed"})` : "open"} ` +
        `but board said "${issue.state ?? "(none)"}" — corrected to "${target}".`,
    );
    if (target === "Done" && issue.parent) {
      try {
        parentCheck(ctx, issue.parent.number);
      } catch {
        /* advisory */
      }
    }
    return `#${number}: "${issue.state ?? "(none)"}" → "${target}" (reality sync)`;
  }
}

// ---------------------------------------------------------------------------
// List / next
// ---------------------------------------------------------------------------

/** Items from OTHER repos on this (cross-repo capable) board. board.ts
 *  resolves issues by bare number within cfg.repo, so a foreign item under
 *  the same number is a DIFFERENT issue — every sweep and the ranker must
 *  scope to own-repo items or risk mutating the wrong issue (the recorded
 *  wrong-repo failure mode, GH-1405 class; observed live with #12 during
 *  the GH-1662 migrate). Foreign items are surfaced by doctor, never touched. */
export function ownRepo<T extends { repo: string }>(ctx: Ctx, items: T[]): { own: T[]; foreign: T[] } {
  const self = `${ctx.cfg.owner}/${ctx.cfg.repo}`.toLowerCase();
  const own: T[] = [];
  const foreign: T[] = [];
  for (const i of items) (i.repo.toLowerCase() === self ? own : foreign).push(i);
  return { own, foreign };
}

/** CLOSED issue still on the board — invisible to the queue, but its board
 *  state can drift (closed while the board says In Review). Doctor's food. */
export interface ClosedItemCore {
  number: number;
  repo: string;
  itemId: string; // ProjectV2Item node id — the only handle prune can remove by
  state: string; // board Workflow State, "(none)" if unset
  archived: boolean;
  stateReason: string | null; // COMPLETED vs NOT_PLANNED — only the former is a claim of success
  closedAt: string | null; // ISO; how long an unevidenced close has been standing
  parentNumber: number | null; // own-repo parent — closed nodes pass tree topology through
}

/** A closed item from a full read — labels present (doctor's apply sweep). */
export type ClosedItem = ClosedItemCore & QueueItemLabelParts;

/** A closed item from any read: the label group is present only if selected. */
export type ClosedItemAny = ClosedItemCore & Partial<QueueItemLabelParts>;

/** The closed-item shape a given selection yields (blockedBy is never read for
 *  closed items, so only the label group varies). */
export type SelectedClosedItem<S extends QueueSelect> = ClosedItemCore &
  (S["labels"] extends true ? QueueItemLabelParts : Partial<QueueItemLabelParts>);

/** Fail closed on pagination metadata itself (CodeRabbit, PR #1794).
 *
 *  Absent `pageInfo` would read as "last page" and silently return a partial
 *  board; `hasNextPage: true` with no `endCursor` would re-request the first
 *  page forever. Both are corrupt-read shapes, and this file's rule is that a
 *  read it cannot trust is an error, never a thin result. */
function assertPageInfo(pageInfo: any, what: string): void {
  if (!pageInfo || typeof pageInfo.hasNextPage !== "boolean")
    throw new Error(`${what}: pagination metadata missing — cannot tell if the read is complete`);
  if (pageInfo.hasNextPage && !pageInfo.endCursor)
    throw new Error(`${what}: more pages reported but no cursor to fetch them`);
}

// ---------------------------------------------------------------------------
// Item-walk cache (GH-1806) — cross-process bounded staleness
//
// The field cache above memoizes the SCHEMA. The item walk was never memoized,
// so a `next` → `frontier` → `list` chain paid 42 + 42 + 23 = 107 points for
// three reads of the same board. A CLI process does one walk and exits, so
// in-process singleflight collapses nothing; only a file-backed cache helps.
//
// What this is, precisely: **client-side bounded staleness, not a lease.** A
// real lease needs server participation (Gray & Cheriton, SOSP '89) and GitHub
// offers none. The claim is "no read older than Δ" and nothing stronger.
//
// Why that is safe here — the whole argument in three parts:
//
//  1. Double-claim is a lost-update race on a CAS-less store, not a staleness
//     bug. A perfectly fresh read does not close the read→write window either;
//     read-back verification is the mitigation and it is already in place. So a
//     stale entry costs one wasted claim attempt, never a wrong outcome.
//  2. **The cache may drive candidate selection and display; it may NEVER
//     drive a write-guard evaluation.** Every write path already re-reads the
//     single item fresh (~6 pts) at the instant of the guard — transition()
//     via mutationCache + read-back, reconcile() and doctor's stale-claim fix
//     via fetchIssue. This module keeps that true by construction: a mutating
//     path is handed a Ctx with itemCacheTtlSec = 0.
//  3. Session guarantees (Terry et al. 1994) — the two that get forgotten:
//     **read-your-writes** (every local mutation bumps `epoch`; an entry at or
//     older than it is refused) and **monotonic reads** (`servedAt` is a
//     high-water mark; an entry older than one already served is refused).
//
// Honest limit: the marks file is read-modify-write, not atomic. Updates
// monotone-merge (max per field) to shrink the window, but two exactly-
// interleaved writers on one machine can still lose one. This is machine-local
// state behind a single flock'd scheduler, and the failure mode is bounded by
// (1) above — a wasted claim attempt.
// ---------------------------------------------------------------------------

/** A walk plus the staleness facts every consumer needs to judge it.
 *
 *  Extends ItemPages (GH-1788) rather than replacing it: `scan` is the walk's
 *  own cost meter and every consumer of it — `board-volume`, prune's dry run —
 *  must see the meter of the walk the data actually came from, cached or not.
 *  Generic over the selection (GH-1803) for the same reason: a cached walk must
 *  narrow to exactly the shape its caller asked for, never a wider promise. */
export interface ItemWalk<S extends QueueSelect = typeof QUEUE_SELECT_FULL> extends ItemPages<S> {
  /** ISO. Stamped at the START of the walk — see startStamp below. */
  fetchedAt: string;
  ageSec: number;
  cached: boolean;
}

type ItemCacheKind = "full" | "own-open";
/** 1 → 2: `scan` joined the entry (GH-1788). 2 → 3: `select` joined it
 *  (GH-1803). Both are load-bearing on serve, and an older file has neither,
 *  so the version check drops it rather than serving a confident wrong shape. */
const ITEM_CACHE_VERSION = 3;

interface ItemCacheEntry {
  version: number;
  kind: ItemCacheKind;
  /** The connections this walk ACTUALLY requested. Load-bearing: see
   *  selectCovers. Stored, never inferred from the items — an item with no
   *  blockers and an item whose blockers were never fetched look identical. */
  select: QueueSelect;
  fetchedAt: string;
  open: QueueItemAny[];
  closed: ClosedItemAny[];
  scan: ItemPages["scan"];
}

/** Does an entry fetched with `have` satisfy a request for `want`?
 *
 *  THE correctness rule of caching a variable-shape walk (GH-1803 × GH-1806).
 *  An unselected group is ABSENT from the item, never `[]` with
 *  `truncated: false` — so serving a labels-less entry to a caller that reads
 *  labels does not merely lose data, it fabricates "GitHub said there are
 *  none". `next` would then read `openBlockers: []` as "not blocked" and hand
 *  the ranker an item whose dependencies were never fetched.
 *
 *  TypeScript cannot catch this: the entry crosses a JSON file, where every
 *  static guarantee is erased. So the check is at RUNTIME, here, and the cast
 *  on serve is honest only because this ran first.
 *
 *  A WIDER entry serving a narrower request is safe and free — the extra
 *  groups are truthful, and the caller's own type declares them optional. That
 *  is the same subset-not-superset asymmetry that lets a full scan answer an
 *  own-open read. */
function selectCovers(have: QueueSelect, want: QueueSelect): boolean {
  return (!want.labels || have.labels) && (!want.blockers || have.blockers);
}

const SELECT_COMBOS: readonly QueueSelect[] = [
  { labels: true, blockers: true },
  { labels: true, blockers: false },
  { labels: false, blockers: true },
  { labels: false, blockers: false },
];

/** Entry files a request may legally be served from, nearest first: the exact
 *  selection, then any wider one already on disk. Keying by selection (rather
 *  than one file per kind) means a lean `next` walk cannot evict the fat entry
 *  that `list` and `doctor` need, and vice versa — no thrash, no downgrade. */
function candidateSelects(want: QueueSelect): QueueSelect[] {
  const covering = SELECT_COMBOS.filter((s) => selectCovers(s, want));
  const extra = (s: QueueSelect) =>
    (s.labels === want.labels ? 0 : 1) + (s.blockers === want.blockers ? 0 : 1);
  return [...covering].sort((a, b) => extra(a) - extra(b));
}

function selectTag(s: QueueSelect): string {
  return `l${s.labels ? 1 : 0}b${s.blockers ? 1 : 0}`;
}

interface ItemCacheMarks {
  /** Newest local mutation observed. Entries at or before it are refused. */
  epoch: string | null;
  /** Newest fetchedAt ever served. Older entries are refused (monotonic reads). */
  servedAt: string | null;
}

function itemCacheTtlSec(ctx: Ctx): number {
  const t = ctx.itemCacheTtlSec ?? 0;
  return Number.isFinite(t) && t > 0 ? t : 0;
}

/** Host is part of the key even though the field cache omits it: this file
 *  carries ISSUE DATA, so a GHE board colliding with a github.com board on the
 *  same owner/repo/number would serve another host's work queue. */
function itemCacheKey(ctx: Ctx): string {
  const safe = (s: string | number) => String(s).replace(/[^A-Za-z0-9._-]/g, "_");
  return `${safe(ctx.cfg.host)}-${safe(ctx.cfg.owner)}-${safe(ctx.cfg.repo)}-${safe(ctx.cfg.projectNumber)}`;
}

function itemCachePath(ctx: Ctx, kind: ItemCacheKind, select: QueueSelect): string {
  return join(ctx.cacheDir, `items-${kind}-${selectTag(select)}-${itemCacheKey(ctx)}.json`);
}

function itemMarksPath(ctx: Ctx): string {
  return join(ctx.cacheDir, `items-marks-${itemCacheKey(ctx)}.json`);
}

/** tmp+rename: a reader must never observe a half-written walk. The pid in the
 *  tmp name keeps two concurrent writers from clobbering each other's tmp. */
function atomicWrite(path: string, contents: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, contents);
    renameSync(tmp, path);
  } catch (e) {
    // A rename that never happened leaves a ~500 KB orphan in the user's
    // cache dir, once per failure, forever. Clean up rather than accumulate.
    removeIfPresent(tmp);
    throw e;
  }
}

function readMarks(ctx: Ctx): ItemCacheMarks {
  try {
    const raw = JSON.parse(readFileSync(itemMarksPath(ctx), "utf8"));
    return {
      epoch: typeof raw?.epoch === "string" ? raw.epoch : null,
      servedAt: typeof raw?.servedAt === "string" ? raw.servedAt : null,
    };
  } catch {
    return { epoch: null, servedAt: null }; // absent or corrupt — no marks yet
  }
}

/** Monotone merge, never a blind overwrite: a mark only ever moves forward, so
 *  a racing writer with an older value cannot walk either guarantee backwards. */
function advanceMarks(ctx: Ctx, patch: Partial<ItemCacheMarks>): void {
  const cur = readMarks(ctx);
  // By INSTANT, for the same reason the read path compares that way: a lexical
  // max over a non-canonical on-disk value could pick the earlier timestamp
  // and LOWER a mark, which is a safety regression, not a missed optimisation.
  const max = (a: string | null, b: string | null | undefined) => {
    if (!b) return a;
    const ta = markMs(a);
    const tb = markMs(b);
    if (tb === null) return a;
    return ta === null || tb > ta ? b : a;
  };
  const next: ItemCacheMarks = {
    epoch: max(cur.epoch, patch.epoch),
    servedAt: max(cur.servedAt, patch.servedAt),
  };
  if (next.epoch === cur.epoch && next.servedAt === cur.servedAt) return;
  mkdirSync(ctx.cacheDir, { recursive: true });
  atomicWrite(itemMarksPath(ctx), JSON.stringify(next));
}

function removeIfPresent(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    /* best-effort; the epoch mark is the real guard */
  }
}

/** Read-your-writes. Called from ghGraphQL for EVERY successful mutation.
 *
 *  Both halves are deliberate: unlinking handles the ordinary case, and the
 *  epoch handles the race unlinking cannot — a walk that was already in flight
 *  when the write landed, repopulating the file a moment later with data that
 *  predates it. If neither can be recorded we warn rather than proceed
 *  silently, because a write we failed to remember is exactly the state that
 *  serves an agent its own pre-write view. */
export function markLocalWrite(ctx: Ctx): void {
  const at = ctx.now().toISOString();
  // EVERY selection variant, not just the one this process happens to use —
  // a write invalidates the board, not one shape of reading it.
  for (const kind of ["full", "own-open"] as const)
    for (const s of SELECT_COMBOS) removeIfPresent(itemCachePath(ctx, kind, s));
  try {
    advanceMarks(ctx, { epoch: at });
  } catch (e) {
    process.stderr.write(
      `warn: could not record the item-cache write epoch (${(e as Error).message}) — ` +
        `a chained read may serve a pre-write view; \`--fresh\` forces a walk\n`,
    );
  }
}

/** null = nothing servable. Every refusal reason is a guarantee, not a
 *  heuristic: a selection that does not cover the request, expired Δ, an entry
 *  that predates a local write (read-your-writes), or one older than something
 *  already served (monotonic reads).
 *
 *  Tries the exact selection first, then any wider entry already on disk. */
function readItemCache(ctx: Ctx, kind: ItemCacheKind, want: QueueSelect): ItemCacheEntry | null {
  if (itemCacheTtlSec(ctx) === 0) return null;
  for (const s of candidateSelects(want)) {
    const entry = readItemCacheAt(ctx, kind, s, want);
    if (entry) return entry;
  }
  return null;
}

function readItemCacheAt(
  ctx: Ctx,
  kind: ItemCacheKind,
  at: QueueSelect,
  want: QueueSelect,
): ItemCacheEntry | null {
  const ttl = itemCacheTtlSec(ctx);
  let entry: ItemCacheEntry;
  try {
    entry = JSON.parse(readFileSync(itemCachePath(ctx, kind, at), "utf8"));
  } catch {
    return null; // absent or corrupt — walk
  }
  if (entry?.version !== ITEM_CACHE_VERSION || entry.kind !== kind) return null;
  if (!Array.isArray(entry.open) || !Array.isArray(entry.closed)) return null;
  // The selection is read from the ENTRY, never assumed from the filename: the
  // file could have been written by a different version, hand-edited, or moved.
  // The filename is an index; this is the assertion.
  if (typeof entry.select?.labels !== "boolean" || typeof entry.select?.blockers !== "boolean")
    return null;
  if (!selectCovers(entry.select, want)) return null;
  // A meter-less entry would report a zero-volume board to `board-volume` and
  // to prune's dry run. Refuse it rather than serve a confident wrong number.
  if (
    typeof entry.scan?.nodes !== "number" ||
    typeof entry.scan?.pages !== "number" ||
    typeof entry.scan?.archivedOpen !== "number"
  )
    return null;
  const t = Date.parse(entry.fetchedAt);
  if (!Number.isFinite(t)) return null;
  const ageSec = (ctx.now().getTime() - t) / 1000;
  // A future-dated entry (clock step, a file copied between machines) is not
  // "very fresh" — it is unreadable, so it is refused.
  if (ageSec < 0 || ageSec > ttl) return null;
  const marks = readMarks(ctx);
  // Compared as INSTANTS, not strings. We write canonical toISOString(), but
  // these files are plain JSON in the user's cache dir — an equivalent instant
  // written any other way (`+00:00`, a different fractional precision) would
  // compare wrong lexically, and comparing wrong here means serving an entry
  // a guarantee says to refuse.
  if (atOrBefore(t, marks.epoch)) return null;
  if (strictlyBefore(t, marks.servedAt)) return null;
  return entry;
}

/** An unparseable mark is treated as ABSENT, not as a barrier: a corrupt marks
 *  file must degrade to today's always-walk behaviour, never wedge every read. */
function markMs(mark: string | null): number | null {
  if (!mark) return null;
  const t = Date.parse(mark);
  return Number.isFinite(t) ? t : null;
}

function atOrBefore(t: number, mark: string | null): boolean {
  const m = markMs(mark);
  return m !== null && t <= m;
}

function strictlyBefore(t: number, mark: string | null): boolean {
  const m = markMs(mark);
  return m !== null && t < m;
}

function writeItemCache(ctx: Ctx, kind: ItemCacheKind, entry: ItemCacheEntry): void {
  if (itemCacheTtlSec(ctx) === 0) return;
  // A walk that began before a local write of ours carries a pre-write view;
  // storing it would hand read-your-writes back to the next process.
  if (atOrBefore(Date.parse(entry.fetchedAt), readMarks(ctx).epoch)) return;
  try {
    mkdirSync(ctx.cacheDir, { recursive: true });
    atomicWrite(itemCachePath(ctx, kind, entry.select), JSON.stringify(entry));
  } catch {
    /* a cache we cannot write is a cache miss, never an error */
  }
}

/** Every serve — cached OR fresh — advances the high-water mark. Skipping it
 *  for fresh walks would let the very next command serve an OLDER cached entry
 *  written by a concurrent process, which is the monotonic-reads violation. */
function serveWalk<S extends QueueSelect>(
  ctx: Ctx,
  entry: ItemCacheEntry,
  cached: boolean,
): ItemWalk<S> {
  try {
    if (itemCacheTtlSec(ctx) > 0) advanceMarks(ctx, { servedAt: entry.fetchedAt });
  } catch {
    /* the high-water mark is an optimisation over an already-safe read */
  }
  return {
    // The one seam where the runtime selection and the static one are asserted
    // equal — the mirror of walkFull's cast, and sound for the same reason:
    // readItemCache has already proved selectCovers(entry.select, want).
    open: entry.open as SelectedQueueItem<S>[],
    closed: entry.closed as SelectedClosedItem<S>[],
    scan: entry.scan,
    fetchedAt: entry.fetchedAt,
    ageSec: Math.max(0, Math.round((ctx.now().getTime() - Date.parse(entry.fetchedAt)) / 1000)),
    cached,
  };
}

/** fetchedAt is stamped BEFORE the first page, never after the last.
 *
 *  The full walk takes ~22 s against this board. An end-stamped entry whose
 *  walk began before a concurrent write would carry a timestamp AFTER that
 *  write and sail through the epoch check while holding pre-write data.
 *  Start-stamping makes the comparison sound, and makes every reported age
 *  conservative (never younger than the oldest byte in the entry). */
function startStamp(ctx: Ctx): string {
  return ctx.now().toISOString();
}

/** The issue fields a QueueItem is built from. Shared verbatim by the two
 *  read paths (project scan, repo-scoped queue read) so they cannot drift.
 *
 *  The two nested connections are emitted only when selected (GH-1803) —
 *  each one costs 1 point per 100-item page, and an unselected one must be
 *  absent from the DOCUMENT, not merely unread: a connection that ships in
 *  the query is charged whether or not anything looks at the result. */
function queueContentFragment(select: QueueSelect): string {
  return `
  number title state stateReason closedAt createdAt updatedAt
  repository { nameWithOwner }
  parent { number repository { nameWithOwner } }${
    select.labels ? `
  labels(first: 100) { pageInfo { hasNextPage } nodes { name } }` : ""
  }${
    select.blockers ? `
  blockedBy(first: 50) { pageInfo { hasNextPage } nodes { number state repository { nameWithOwner } } }` : ""
  }`;
}

/** Build the item. An unselected connection contributes NO keys at all —
 *  never `[]` and never `truncated: false`, which a downstream fail-closed
 *  check would read as GitHub's own "the list was complete" (GH-1803). */
function toQueueItem(
  c: any,
  fv: Record<string, string>,
  fvTruncated: boolean,
  self: string,
  select: QueueSelect,
): QueueItemAny {
  // Only read the connection the query actually asked for: `c.blockedBy` is
  // undefined on a lean read, and treating that as "no blockers" is the exact
  // conflation these types exist to prevent.
  const blockerParts = (): QueueItemBlockerParts => {
    const nodes = c.blockedBy?.nodes ?? [];
    const open = nodes.filter((b: any) => b.state === "OPEN");
    return {
      openBlockers: open.map((b: any) => b.number),
      openBlockerLabels: open.map((b: any) => {
        const r = b.repository?.nameWithOwner;
        return r && r.toLowerCase() !== self ? `${r}#${b.number}` : `#${b.number}`;
      }),
      blockersTruncated: c.blockedBy?.pageInfo?.hasNextPage ?? false,
      closedBlockers: nodes.filter((b: any) => b.state !== "OPEN").map((b: any) => b.number),
    };
  };
  return {
    number: c.number,
    repo: c.repository?.nameWithOwner ?? "",
    title: c.title,
    state: fv[STATE_FIELD] ?? "(none)",
    priority: fv[PRIORITY_FIELD] ?? null,
    hasParent: !!c.parent,
    // Own-repo parents only: a foreign parent's #N must never rebuild
    // a tree edge onto this repo's #N (fail-closed, like blocker labels).
    parentNumber:
      c.parent && c.parent.repository?.nameWithOwner?.toLowerCase() === self ? c.parent.number : null,
    fieldValuesTruncated: fvTruncated,
    claim: parseClaim(fv[CLAIM_FIELD]),
    claimRaw: fv[CLAIM_FIELD] ?? null,
    ...(select.blockers ? blockerParts() : {}),
    ...(select.labels
      ? {
          labels: (c.labels?.nodes ?? []).map((l: any) => l.name),
          labelsTruncated: c.labels?.pageInfo?.hasNextPage ?? false,
        }
      : {}),
    updatedAt: c.updatedAt ?? null,
    createdAt: c.createdAt ?? null,
    estimate: fv[ESTIMATE_FIELD] ?? null,
  };
}

/** Queue read scoped to the OWN repo's OPEN issues (GH-1785).
 *
 *  The project scan below walks every item the board has ever held — here,
 *  1344 items over 14 pages, ~22 s — because the items connection has no
 *  server-side filter. A queue read does not need the closed ones: entering
 *  from `repository.issues(states: OPEN)` costs pages proportional to open
 *  work instead (26 issues, one page).
 *
 *  What it deliberately cannot see: board items from OTHER repos. Those are
 *  read-only here anyway (ownRepo partitions them out of every write path)
 *  and doctor's `foreign-items` check still runs off the full scan — but a
 *  caller that must ENUMERATE them has to use listItemsFull, so callers say
 *  which they need rather than inheriting the wrong one silently. */
export function listOwnOpenItems<S extends QueueSelect = typeof QUEUE_SELECT_FULL>(
  ctx: Ctx,
  select: S = QUEUE_SELECT_FULL as unknown as S,
): SelectedQueueItem<S>[] {
  return listOwnOpenWalk(ctx, select).open;
}

/** The own-open read plus its staleness facts (GH-1806).
 *
 *  Note the DERIVATION: a fresh full-scan entry can answer an own-open request
 *  by filtering, because `listOwnOpenItems(ctx)` and `ownRepo(ctx,
 *  listItems(ctx)).own` are the same set — an identity this file's own suite
 *  already pins. Not the reverse: own-open cannot see foreign or closed items.
 *  That asymmetry is what makes `next` → `list` cost 42 + 0 rather than
 *  42 + 23. A derived answer is NOT written back as an own-open entry; the
 *  full entry it came from is already the fresher, more general one.
 *
 *  The SAME asymmetry now governs the selection (GH-1803): a full-scan entry
 *  answers this only if its `select` covers what is being asked for. */
export function listOwnOpenWalk<S extends QueueSelect = typeof QUEUE_SELECT_FULL>(
  ctx: Ctx,
  select: S = QUEUE_SELECT_FULL as unknown as S,
): ItemWalk<S> {
  const own = readItemCache(ctx, "own-open", select);
  if (own) return serveWalk<S>(ctx, own, true);
  const full = readItemCache(ctx, "full", select);
  if (full) {
    // `scan` rides through unchanged, describing the FULL project walk that
    // actually produced these items — the honest provenance. It is not a meter
    // of the own-repo subset, and no consumer reads it as one: volume and
    // prune both enter through listItemsFull.
    return serveWalk<S>(
      ctx,
      { ...full, kind: "own-open", open: ownRepo(ctx, full.open).own, closed: [] },
      true,
    );
  }
  const entry = walkOwnOpen(ctx, select);
  writeItemCache(ctx, "own-open", entry);
  return serveWalk<S>(ctx, entry, false);
}

function walkOwnOpen(ctx: Ctx, select: QueueSelect): ItemCacheEntry {
  const fetchedAt = startStamp(ctx);
  return withCache(ctx, (cache) => {
    const items: QueueItemAny[] = [];
    // Metered like the project scan (GH-1788), on this read's own terms: nodes
    // here are the repo's OPEN issues, not project items, so this meter is not
    // comparable to the full walk's and is never fed to `board-volume` — which
    // enters through listItemsFull. It is carried so a cached entry is never
    // the reason a number is missing.
    const scan = { nodes: 0, pages: 0, archivedOpen: 0 };
    const self = `${ctx.cfg.owner}/${ctx.cfg.repo}`.toLowerCase();
    let after: string | null = null;
    for (;;) {
      const data: any = ghGraphQL(
        ctx,
        `query($owner: String!, $repo: String!, $after: String) {
          repository(owner: $owner, name: $repo) {
            issues(states: OPEN, first: 100, after: $after) {
              pageInfo { hasNextPage endCursor }
              nodes {
                ${queueContentFragment(select)}
                projectItems(first: 20) {
                  pageInfo { hasNextPage }
                  nodes { isArchived project { id } ${FIELD_VALUES_FRAGMENT} }
                }
              }
            }
          }
        }`,
        { owner: ctx.cfg.owner, repo: ctx.cfg.repo, after },
      );
      const page = data.repository?.issues;
      if (!page) throw new Error(`could not read open issues for ${ctx.cfg.owner}/${ctx.cfg.repo}`);
      assertPageInfo(page.pageInfo, `open issues for ${ctx.cfg.owner}/${ctx.cfg.repo}`);
      // Metered only once the page is known trustworthy — an unreadable page is
      // an error, never a page that "cost nothing" (same rule as the full walk).
      scan.pages++;
      scan.nodes += (page.nodes ?? []).length;
      for (const c of page.nodes ?? []) {
        if (!c?.number) continue;
        const nodes = c.projectItems?.nodes ?? [];
        const item = nodes.find((n: any) => n.project?.id === cache.projectId);
        if (!item) {
          // Fail closed: an issue on 20+ projects whose board membership fell
          // past the page would silently read as off-board.
          if (c.projectItems?.pageInfo?.hasNextPage)
            throw new Error(`issue #${c.number}: project membership truncated — cannot tell if it is on the board`);
          continue; // genuinely off-board
        }
        // Archived items are still returned but cannot be written — skip.
        if (item.isArchived) {
          scan.archivedOpen++;
          continue;
        }
        items.push(
          toQueueItem(c, fieldValueMap(item.fieldValues), fieldValuesTruncated(item.fieldValues), self, select),
        );
      }
      if (!page.pageInfo.hasNextPage) break;
      after = page.pageInfo.endCursor;
    }
    return { version: ITEM_CACHE_VERSION, kind: "own-open", select, fetchedAt, open: items, closed: [], scan };
  });
}

/** Items fetched per round trip. */
export const ITEMS_PAGE = 100;

export interface ItemPages<S extends QueueSelect = typeof QUEUE_SELECT_FULL> {
  open: SelectedQueueItem<S>[];
  closed: SelectedClosedItem<S>[];
  /** The walk's own meter: nodes paged through, round trips spent, and the
   *  archived OPEN items dropped en route (they never reach `open`). */
  scan: { nodes: number; pages: number; archivedOpen: number };
}

/** One page walk, two views: open items for the queue, closed items for
 *  doctor's drift sweep. Every existing caller goes through listItems and
 *  keeps the OPEN-only contract — closed items must never reach the ranker. */
export function listItemsFull<S extends QueueSelect = typeof QUEUE_SELECT_FULL>(
  ctx: Ctx,
  select: S = QUEUE_SELECT_FULL as unknown as S,
): ItemWalk<S> {
  const hit = readItemCache(ctx, "full", select);
  if (hit) return serveWalk<S>(ctx, hit, true);
  const entry = walkFull(ctx, select);
  writeItemCache(ctx, "full", entry);
  return serveWalk<S>(ctx, entry, false);
}

function walkFull(ctx: Ctx, select: QueueSelect): ItemCacheEntry {
  const fetchedAt = startStamp(ctx);
  return withCache(ctx, (cache) => {
    const items: QueueItemAny[] = [];
    const closed: ClosedItemAny[] = [];
    // What the walk actually PAID FOR, counted as it pages. Not derivable from
    // items.length + closed.length: the `... on Issue` fragment silently drops
    // every node that is not an issue (pull requests, draft items), and those
    // nodes still cost a slot on a page. Volume must report the real cost.
    // archivedOpen is metered separately for the same reason `closed` carries
    // `archived`: archived is a DISTINCT class everywhere in this file, and an
    // archived open item is dropped before it reaches `items`. Without its own
    // counter it would be invisible here and get swept into the non-issue
    // residual, making doctor report a PR where an archived issue stands.
    const scan = { nodes: 0, pages: 0, archivedOpen: 0 };
    // A bare "#N" reads as this repo — a cross-repo blocker must say whose #N.
    const self = `${ctx.cfg.owner}/${ctx.cfg.repo}`.toLowerCase();
    let after: string | null = null;
    for (;;) {
      const data: any = ghGraphQL(
        ctx,
        `query($projectId: ID!, $after: String) {
          node(id: $projectId) {
            ... on ProjectV2 {
              items(first: ${ITEMS_PAGE}, after: $after) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  id
                  isArchived
                  content {
                    ... on Issue { ${queueContentFragment(select)} }
                  }
                  ${FIELD_VALUES_FRAGMENT}
                }
              }
            }
          }
        }`,
        { projectId: cache.projectId, after },
      );
      const page = data.node?.items;
      if (!page) throw new Error(`could not read project items for project ${ctx.cfg.projectNumber}`);
      assertPageInfo(page.pageInfo, `project items for project ${ctx.cfg.projectNumber}`);
      // Meter the walk only once the page is known trustworthy: an unreadable
      // page is an error, never a page that "cost nothing".
      scan.pages++;
      scan.nodes += (page.nodes ?? []).length;
      for (const n of page.nodes ?? []) {
        const c = n.content;
        if (!c?.number) continue;
        const fv = fieldValueMap(n.fieldValues);
        // Closed issues are already-fetched page data — retained for doctor's
        // drift sweep (number + board state + archived), never for the queue.
        if (c.state !== "OPEN") {
          closed.push({
            number: c.number,
            repo: c.repository?.nameWithOwner ?? "",
            itemId: n.id ?? "",
            state: fv[STATE_FIELD] ?? "(none)",
            archived: n.isArchived ?? false,
            ...(select.labels
              ? {
                  labels: (c.labels?.nodes ?? []).map((l: any) => l.name),
                  labelsTruncated: c.labels?.pageInfo?.hasNextPage ?? false,
                }
              : {}),
            stateReason: c.stateReason ?? null,
            closedAt: c.closedAt ?? null,
            parentNumber:
              c.parent && c.parent.repository?.nameWithOwner?.toLowerCase() === self
                ? c.parent.number
                : null,
          });
          continue;
        }
        // Archived items are still returned by the items connection but
        // cannot be written ("The item is archived") — skip them everywhere.
        if (n.isArchived) {
          scan.archivedOpen++;
          continue;
        }
        items.push(toQueueItem(c, fv, fieldValuesTruncated(n.fieldValues), self, select));
      }
      if (!page.pageInfo.hasNextPage) break;
      after = page.pageInfo.endCursor;
    }
    // `select` is stored IN the entry — the whole safety of caching a walk
    // whose SHAPE now varies per caller (GH-1803). `scan` likewise: a cache hit
    // does no paging, so a freshly-zeroed meter would make `board-volume`
    // report an empty board. Both belong to the walk that produced the data
    // and travel with it; the untyped `open`/`closed` here are re-narrowed on
    // serve, but only after readItemCache has proved the selection covers the
    // request at RUNTIME — the type-level cast alone cannot cross a JSON file.
    return { version: ITEM_CACHE_VERSION, kind: "full", select, fetchedAt, open: items, closed, scan };
  });
}

export function listItems<S extends QueueSelect = typeof QUEUE_SELECT_FULL>(
  ctx: Ctx,
  select: S = QUEUE_SELECT_FULL as unknown as S,
): SelectedQueueItem<S>[] {
  return listItemsFull(ctx, select).open;
}

// ---------------------------------------------------------------------------
// Deliver lane selector (GH-1712, D3) — spec §4.2.
//
// Read-only apart from invoking `merge-pr.sh --dry-run` (itself side-effect-
// free, D8). The selector CLASSIFIES; every judgment (what to do about an
// actionable PR) belongs to the deliver skill. It never writes the marker —
// only deliver sessions do, at exit.
// ---------------------------------------------------------------------------

export const DELIVER_MARKER = "<!-- ralph-deliver:v1 -->";

export interface DeliverOpts {
  /** Quiescence guard (min): fresh activity keeps an item settling. */
  settleMin: number;
  /** Bounded retry (min), any verdict: catches transitions no cheap signal
   *  can observe (stuck PENDING, a recorded PASS whose PR never merged). */
  retryMin: number;
  /** Dry-run probes per pass — the only non-trivial cost this selector has. */
  dryrunMax: number;
}

export const DELIVER_DEFAULTS: Readonly<DeliverOpts> = Object.freeze({
  settleMin: 5,
  retryMin: 60,
  dryrunMax: 3,
});

export function parseDeliverOpts(
  env: Record<string, string | undefined> = process.env,
): DeliverOpts {
  const positive = (name: string, def: number): number => {
    const raw = env[name];
    if (raw === undefined) return def;
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
    process.stderr.write(`warn: ${name}="${raw}" is not a positive number — using ${def}\n`);
    return def;
  };
  return {
    settleMin: positive("RALPH_SETTLE_MIN", DELIVER_DEFAULTS.settleMin),
    retryMin: positive("RALPH_RETRY_MIN", DELIVER_DEFAULTS.retryMin),
    dryrunMax: positive("RALPH_DELIVER_DRYRUN_MAX", DELIVER_DEFAULTS.dryrunMax),
  };
}

/** One PR's marker entry — the tuple that gates re-selection (§4.2.3a). */
export interface DeliverMarkerEntry {
  head_sha: string;
  verdict: string;
  gate: string | null;
  check_conclusions: string;
  review_cursor: string | null;
  thread_cursor: string | null;
  at: string; // ISO — anchors this PR's bounded retry window
}

/** Last DELIVER_MARKER comment wins; malformed JSON reads as "no marker"
 *  (markers are cursors, not authority — the cost is one redundant probe,
 *  never a wrong mutation). */
export function parseDeliverMarker(
  comments: string[],
): Record<string, DeliverMarkerEntry> | null {
  const body = [...comments].reverse().find((c) => c.includes(DELIVER_MARKER));
  if (!body) return null;
  const fence = /```json\s*\n([\s\S]*?)\n\s*```/.exec(body);
  if (!fence) return null;
  try {
    const parsed = JSON.parse(fence[1]);
    if (typeof parsed !== "object" || parsed === null) return null;
    const prs = (parsed as any).prs;
    if (typeof prs !== "object" || prs === null) return null;
    return prs as Record<string, DeliverMarkerEntry>;
  } catch {
    return null;
  }
}

/** What one linked PR looks like to the selector — cheap-signal cursors only;
 *  gate truth stays in merge-pr.sh --dry-run (D8). */
export interface DeliverPrFacts {
  number: number;
  state: "OPEN" | "MERGED" | "CLOSED";
  headSha: string;
  /** Sorted `name=conclusion` digest of check runs + status contexts. */
  checkConclusions: string;
  /** Latest review submittedAt. */
  reviewCursor: string | null;
  /** Latest comment createdAt across UNRESOLVED review threads. */
  threadCursor: string | null;
  /** Newest of head push / PR comment / review / thread activity — the PR's
   *  contribution to the quiescence clock and the delta's own timestamp. */
  lastActivityAt: string | null;
}

export interface DeliverCandidate {
  number: number;
  title: string;
  /** Linked PRs: closing references ∪ the branch convention — `<kind>/NNN-slug`
   *  or the legacy `feature/GH-NNN` (detect-if-present — hosts without the
   *  convention degrade to closing references only). Deduped by PR number. */
  prs: DeliverPrFacts[];
  stateUpdatedAt: string | null; // when the board wrote the current state
  lastCommentAt: string | null; // newest issue comment
  marker: Record<string, DeliverMarkerEntry> | null;
}

/** Derived from contracts.ts DELIVER_REASONS — the single declaration (the C6
 *  schema uses the same tuple; per-value docs live on it). */
export type DeliverReason = (typeof DELIVER_REASONS)[number];

export interface DeliverRow {
  number: number;
  title: string;
  pr: number | null; // null for no-pr / no-open-pr / settling (item-level rows)
  reason: DeliverReason;
  verdict?: string | null; // from the probe (or the marker, for retry rows)
  gate?: string | null;
  deltaAt?: string | null; // the delta's own timestamp (ordering input)
  /** Time-bounded blocked rows: when to look again. The lane's pacing input —
   *  rows without one (`no-pr`) only a human can clear. */
  windowExpiresAt?: string | null;
}

export interface DeliverQueueResult {
  next: DeliverRow | null;
  queue: DeliverRow[];
  blocked: DeliverRow[];
}

/** The verdict is the LAST non-WARN `MERGE GATE` line (D8 contract: WARN is a
 *  non-terminal advisory that never appears alone). Null = no parseable
 *  verdict (script crashed) — the caller treats that as "session decides". */
export function parseMergeGateVerdict(
  out: string,
): { verdict: "PASS" | "PENDING" | "FAIL"; gate: string | null } | null {
  const lines = out
    .split("\n")
    .filter((l) => l.startsWith("MERGE GATE ") && !l.startsWith("MERGE GATE WARN"));
  const last = lines[lines.length - 1];
  if (!last) return null;
  const m = /^MERGE GATE (PASS|PENDING|FAIL)(?:\s+—\s+([a-z0-9-]+))?/.exec(last);
  if (!m) return null;
  return {
    verdict: m[1] as "PASS" | "PENDING" | "FAIL",
    gate: m[1] === "PASS" ? null : (m[2] ?? null),
  };
}

/** A probe answers "what would the merge gate say right now" for one PR.
 *  Null = the probe ran but produced no verdict (crash) — still actionable;
 *  the session runs the gates itself and finds out. */
export type DeliverProbe = (pr: number) => { verdict: string; gate: string | null } | null;

/** Pure classification per spec §4.2 — deterministic given candidates, opts,
 *  clock, and probe. `probe === null` means the host repo ships no merge gate:
 *  cheap-delta candidates are actionable unprobed (native-flow degrade). */
export function classifyDeliver(
  cands: DeliverCandidate[],
  opts: DeliverOpts,
  now: Date,
  probe: DeliverProbe | null,
): DeliverQueueResult {
  const ms = (iso: string | null | undefined): number | null => {
    if (!iso) return null;
    const t = new Date(iso).getTime();
    return Number.isFinite(t) ? t : null;
  };
  const iso = (t: number): string => new Date(t).toISOString();
  const settleMs = opts.settleMin * 60_000;
  const retryMs = opts.retryMin * 60_000;

  const blocked: DeliverRow[] = [];
  const closeouts: DeliverRow[] = [];
  const retries: DeliverRow[] = [];
  const probeCands: Array<{
    c: DeliverCandidate;
    pr: DeliverPrFacts;
    entry: DeliverMarkerEntry | null;
    deltaAt: number;
  }> = [];

  for (const c of cands) {
    if (c.prs.length === 0) {
      // Rollup-advanced epic parents and human-placed items — not deliver's
      // business; they never reach the signal checks.
      blocked.push({ number: c.number, title: c.title, pr: null, reason: "no-pr" });
      continue;
    }
    const open = c.prs.filter((p) => p.state === "OPEN");
    if (open.length === 0) {
      // All linked PRs merged/closed: the close-out branch (§4.4). Neither
      // reconcile nor doctor covers an open In Review issue with a merged PR;
      // without this such items strand forever. Merged-vs-closed-unmerged is
      // the SESSION's judgment, not the selector's.
      closeouts.push({ number: c.number, title: c.title, pr: null, reason: "no-open-pr" });
      continue;
    }
    // Quiescence guard (§4.2.4): the newest of state change, issue comment,
    // and every open PR's activity must be older than the settle window.
    const newest = Math.max(
      ...[ms(c.stateUpdatedAt), ms(c.lastCommentAt), ...open.map((p) => ms(p.lastActivityAt))]
        .filter((t): t is number => t !== null),
      -Infinity,
    );
    if (newest !== -Infinity && now.getTime() - newest < settleMs) {
      blocked.push({
        number: c.number,
        title: c.title,
        pr: null,
        reason: "settling",
        windowExpiresAt: iso(newest + settleMs),
      });
      continue;
    }
    for (const p of open) {
      const entry = c.marker?.[String(p.number)] ?? null;
      if (!entry) {
        // Marker-less trivially differs from any tuple — probe candidate.
        probeCands.push({ c, pr: p, entry: null, deltaAt: ms(p.lastActivityAt) ?? 0 });
        continue;
      }
      const cheapDelta =
        entry.head_sha !== p.headSha ||
        entry.check_conclusions !== p.checkConclusions ||
        (entry.review_cursor ?? null) !== p.reviewCursor ||
        (entry.thread_cursor ?? null) !== p.threadCursor;
      const entryAt = ms(entry.at);
      const windowExpired = entryAt === null || now.getTime() - entryAt >= retryMs;
      if (cheapDelta) {
        probeCands.push({ c, pr: p, entry, deltaAt: ms(p.lastActivityAt) ?? 0 });
      } else if (windowExpired) {
        // Bounded retry, ANY verdict (§4.2.3b): a stuck PENDING and a recorded
        // PASS whose PR never merged re-arm identically. No selector-side
        // dry-run — the session runs the gates itself and refreshes `at`, so a
        // stuck PR costs one session per window, never one per pass.
        retries.push({
          number: c.number,
          title: c.title,
          pr: p.number,
          reason: "retry",
          verdict: entry.verdict,
          gate: entry.gate ?? null,
          deltaAt: entry.at,
        });
      } else {
        blocked.push({
          number: c.number,
          title: c.title,
          pr: p.number,
          reason: "retry-window",
          windowExpiresAt: entryAt === null ? null : iso(entryAt + retryMs),
        });
      }
    }
  }

  // Budgeted probes, NEWEST delta first (stateless anti-starvation: a freshly
  // green PR outranks a stale thread delta, so persistent marker-current
  // candidates cannot pin the budget). Retries never consume it.
  probeCands.sort((a, b) => b.deltaAt - a.deltaAt);
  const confirmed: DeliverRow[] = [];
  let budget = opts.dryrunMax;
  for (const pc of probeCands) {
    const base = {
      number: pc.c.number,
      title: pc.c.title,
      pr: pc.pr.number,
      deltaAt: pc.deltaAt > 0 ? iso(pc.deltaAt) : null,
    };
    if (probe === null) {
      // No merge gate in this repo — nothing to probe against; the delta
      // itself is the signal and the session uses the native flow.
      confirmed.push({ ...base, reason: "actionable", verdict: null, gate: null });
      continue;
    }
    if (budget <= 0) {
      blocked.push({ ...base, reason: "deferred", windowExpiresAt: null });
      continue;
    }
    budget--;
    const v = probe(pc.pr.number);
    if (v === null) {
      // Probe crashed (no parseable verdict) — still actionable; the session
      // runs the gates itself and finds out.
      confirmed.push({ ...base, reason: "actionable", verdict: null, gate: null });
      continue;
    }
    const tupleEqual =
      pc.entry !== null &&
      pc.entry.head_sha === pc.pr.headSha &&
      pc.entry.verdict === v.verdict &&
      (pc.entry.gate ?? null) === (v.gate ?? null);
    if (!tupleEqual) {
      confirmed.push({ ...base, reason: "actionable", verdict: v.verdict, gate: v.gate });
    } else {
      // Probed and nothing changed — including a recorded PASS: it re-arms via
      // the retry window like any other verdict, never via a special case.
      const entryAt = ms(pc.entry!.at);
      if (entryAt === null || now.getTime() - entryAt >= retryMs) {
        retries.push({
          ...base,
          reason: "retry",
          verdict: pc.entry!.verdict,
          gate: pc.entry!.gate ?? null,
        });
      } else {
        blocked.push({
          ...base,
          reason: "marker-current",
          windowExpiresAt: iso(entryAt + retryMs),
        });
      }
    }
  }

  // Queue order (§4.2): close-outs first (terminal, cheap, strand-forever
  // otherwise — a judgment call journaled on GH-1712), then confirmed
  // actionables oldest-first, then window-expired retries — a confirmed item
  // always outranks a retry, so stuck retries can never starve fresh work.
  confirmed.sort((a, b) => {
    const ta = a.deltaAt ? new Date(a.deltaAt).getTime() : 0;
    const tb = b.deltaAt ? new Date(b.deltaAt).getTime() : 0;
    return ta - tb;
  });
  retries.sort((a, b) => {
    const ta = a.deltaAt ? new Date(a.deltaAt).getTime() : 0;
    const tb = b.deltaAt ? new Date(b.deltaAt).getTime() : 0;
    return ta - tb;
  });
  const queue = [...closeouts, ...confirmed, ...retries];
  return { next: queue[0] ?? null, queue, blocked };
}

const DELIVER_CHUNK = 10;

/** Everything one PR contributes to the cheap checks, in one selection. */
const DELIVER_PR_FACTS = `
  number state headRefOid
  commits(last: 1) { nodes { commit { committedDate pushedDate
    statusCheckRollup { contexts(first: 100) { nodes {
      __typename
      ... on CheckRun { name conclusion }
      ... on StatusContext { context state }
    } } } } } }
  reviews(last: 10) { nodes { submittedAt } }
  reviewThreads(last: 50) { nodes { isResolved comments(last: 1) { nodes { createdAt } } } }
  comments(last: 1) { nodes { createdAt } }`;

function prFactsFrom(node: any): DeliverPrFacts {
  const commit = node.commits?.nodes?.[0]?.commit;
  const contexts: any[] = commit?.statusCheckRollup?.contexts?.nodes ?? [];
  const digest = contexts
    .map((x) =>
      x.__typename === "CheckRun"
        ? `${x.name}=${x.conclusion ?? "pending"}`
        : `${x.context}=${x.state ?? "pending"}`,
    )
    .sort()
    .join(",");
  const maxIso = (vals: Array<string | null | undefined>): string | null => {
    const ts = vals.filter((v): v is string => typeof v === "string");
    return ts.length ? ts.sort()[ts.length - 1] : null;
  };
  const reviewCursor = maxIso((node.reviews?.nodes ?? []).map((r: any) => r?.submittedAt));
  const threadCursor = maxIso(
    (node.reviewThreads?.nodes ?? [])
      .filter((t: any) => t && t.isResolved === false)
      .map((t: any) => t.comments?.nodes?.[0]?.createdAt),
  );
  const anyThread = maxIso(
    (node.reviewThreads?.nodes ?? []).map((t: any) => t?.comments?.nodes?.[0]?.createdAt),
  );
  return {
    number: node.number,
    state: node.state,
    headSha: node.headRefOid ?? "",
    checkConclusions: digest,
    reviewCursor,
    threadCursor,
    lastActivityAt: maxIso([
      commit?.pushedDate ?? commit?.committedDate,
      node.comments?.nodes?.[0]?.createdAt,
      reviewCursor,
      anyThread,
    ]),
  };
}

/** Batched detail fetch for the In Review candidates: one GraphQL document
 *  per DELIVER_CHUNK candidates (issue facts + branch-convention PRs), never
 *  one ad-hoc call per signal per candidate (§4.2 cost bound). */
export function fetchDeliverCandidates(
  ctx: Ctx,
  items: Array<{ number: number; title: string }>,
): DeliverCandidate[] {
  if (items.length === 0) return [];
  return withCache(ctx, (cache) => {
    const out: DeliverCandidate[] = [];
    for (let start = 0; start < items.length; start += DELIVER_CHUNK) {
      const chunk = items.slice(start, start + DELIVER_CHUNK);
      const decls = chunk.map((_, k) => `$n${k}: Int!, $h${k}: String!`).join(", ");
      const aliases = chunk
        .map(
          (_, k) => `
        d${k}: issue(number: $n${k}) {
          number title
          comments(last: 50) { nodes { body createdAt } }
          closedByPullRequestsReferences(first: 10) { nodes { ${DELIVER_PR_FACTS} } }
          projectItems(first: 10) { nodes { project { id } fieldValues(first: 20) { nodes {
            ... on ProjectV2ItemFieldSingleSelectValue {
              updatedAt field { ... on ProjectV2FieldCommon { name } }
            } } } } }
        }
        b${k}: refs(refPrefix: "refs/heads/", query: $h${k}, first: 10) {
          nodes {
            name
            associatedPullRequests(first: 10, states: [OPEN, MERGED, CLOSED]) {
              nodes { ${DELIVER_PR_FACTS} }
            }
          }
        }`,
        )
        .join("\n");
      const vars: Record<string, unknown> = { owner: ctx.cfg.owner, repo: ctx.cfg.repo };
      chunk.forEach((it, k) => {
        vars[`n${k}`] = it.number;
        // Provenance convention (work rule 6), detect-if-present. GitHub's ref
        // filter is a SUBSTRING match on the name after refs/heads/, so the
        // bare number covers BOTH grammars — `fix/1807-slug` and the legacy
        // `feature/GH-1807` — in one connection. It also returns unrelated
        // refs that merely contain the digits; parseBranchName rejects those
        // below. Costed live: +1 pt per DELIVER_CHUNK document (1 → 2).
        vars[`h${k}`] = String(it.number);
      });
      const data: any = ghGraphQL(
        ctx,
        `query($owner: String!, $repo: String!, ${decls}) {
          repository(owner: $owner, name: $repo) {
            ${aliases}
          }
        }`,
        vars,
      );
      const repo: any = data.repository ?? {};
      chunk.forEach((it, k) => {
        const issue = repo[`d${k}`];
        if (!issue) return; // deleted/foreign mid-walk — absent, not invented
        const byNumber = new Map<number, DeliverPrFacts>();
        for (const n of issue.closedByPullRequestsReferences?.nodes ?? []) {
          if (n?.number) byNumber.set(n.number, prFactsFrom(n));
        }
        for (const ref of repo[`b${k}`]?.nodes ?? []) {
          // The substring filter is GitHub's; this is ours. A ref that does
          // not PARSE as this issue's branch is a coincidence of digits
          // (`feature/GH-18070`, `chore/fix-1807-typo`), not linkage.
          if (parseBranchName(ref?.name ?? "")?.issue !== it.number) continue;
          for (const n of ref?.associatedPullRequests?.nodes ?? []) {
            if (n?.number && !byNumber.has(n.number)) byNumber.set(n.number, prFactsFrom(n));
          }
        }
        const comments: Array<{ body: string; createdAt: string | null }> = (
          issue.comments?.nodes ?? []
        ).map((c: any) => ({ body: c?.body ?? "", createdAt: c?.createdAt ?? null }));
        const item = (issue.projectItems?.nodes ?? []).find(
          (x: any) => x?.project?.id === cache.projectId,
        );
        const stateValue = (item?.fieldValues?.nodes ?? []).find(
          (v: any) => v?.field?.name === STATE_FIELD,
        );
        const commentTimes = comments
          .map((c) => c.createdAt)
          .filter((t): t is string => typeof t === "string")
          .sort();
        out.push({
          number: issue.number,
          title: issue.title ?? "",
          prs: [...byNumber.values()],
          stateUpdatedAt: stateValue?.updatedAt ?? null,
          lastCommentAt: commentTimes[commentTimes.length - 1] ?? null,
          marker: parseDeliverMarker(comments.map((c) => c.body)),
        });
      });
    }
    return out;
  });
}

/** The deliver lane's typed selector: own-repo In Review items → classified
 *  queue. `probeOverride` exists for tests; the CLI builds the real probe from
 *  the host repo's own merge gate (absent gate = native-flow degrade). */
export function deliverQueue(
  ctx: Ctx,
  opts: DeliverOpts = parseDeliverOpts(),
  probeOverride?: DeliverProbe | null,
): DeliverQueueResult {
  // The lane filters on board state and hands {number, title} to the
  // candidate fetch — neither labels nor dependency edges are ever read, so
  // the walk runs at the 1-point floor (GH-1803).
  const inReview = ownRepo(ctx, listItems(ctx, QUEUE_SELECT_MINIMAL))
    .own.filter((i) => i.state === "In Review");
  const cands = fetchDeliverCandidates(ctx, inReview);
  let probe: DeliverProbe | null;
  if (probeOverride !== undefined) {
    probe = probeOverride;
  } else {
    // Test-only override, same pattern as RALPH_APPLY_KEYWORDS_SH.
    const gateSh = process.env.RALPH_MERGE_PR_SH ?? join(ctx.repoRoot, "scripts", "merge-pr.sh");
    probe = existsSync(gateSh)
      ? (pr: number) => {
          const r = ctx.exec(["bash", gateSh, String(pr), "--dry-run"]);
          return parseMergeGateVerdict(r.stdout);
        }
      : null;
  }
  return classifyDeliver(cands, opts, ctx.now(), probe);
}

// ---------------------------------------------------------------------------
// Tend lane selector (GH-1712, D4) — spec §4.3.
//
// Deterministic hygiene queue over own-repo items. The selector CLASSIFIES;
// all judgment (is this actually stale? is the dup real? should it close?)
// belongs to the tend skill — and closures are proposals filed as marker
// comments (GH-1777), never selector or skill executions.
// ---------------------------------------------------------------------------

export const TEND_MARKER = "<!-- ralph-tend:v1 audited -->";

/** The proposal marker (GH-1777). A closure proposal is an ANNOTATION, not a
 *  state: the item stays where it is while a human decides. The marker is the
 *  cursor in both directions — it re-surfaces the proposal under the `proposed`
 *  category, and its presence stops the lane proposing the same thing twice.
 *  Same shape discipline as TEND_MARKER: the line, then a fenced JSON payload.
 *
 *  It is filed against Backlog items (`close-as-delivered`) AND against closed
 *  ones (`reopen-as-unevidenced`), so pending-ness is decided per item, by
 *  `pendingProposal` plus the resolution rules below — never by presence. */
export const TEND_PROPOSAL_MARKER = "<!-- ralph-tend:v1 proposed -->";

/** The disposition marker (GH-1777) — the other half of the lifecycle. A
 *  proposal with no way to say "answered" is unresolvable: the item comes back
 *  under `proposed` forever and the lane's goal state (a sweep with `acted=0`)
 *  becomes unreachable. This marker is that answer, and it is DURABLE — a
 *  comment, like the proposal, so the trail carries the whole exchange.
 *  Payload: `{"disposition": "accepted"|"rejected", "at": iso, "note": "…"}`. */
export const TEND_RESOLUTION_MARKER = "<!-- ralph-tend:v1 resolved -->";

/** The PENDING proposal in a comment trail, or null when there is none — either
 *  no proposal was ever filed, or the newest one has been disposed of.
 *
 *  Last marker wins. `comments(last: N)` returns oldest→newest within its
 *  window, so trail order IS chronological, and a resolution can only be
 *  written after the proposal it answers — which also means truncation is safe
 *  in the direction that matters: if the proposal is inside the window, so is
 *  everything filed after it. Within a single comment the later marker wins, so
 *  a resolution that quotes the proposal it answers still resolves it.
 *
 *  `at` is null when the payload is unreadable — still a PENDING proposal, a
 *  garbled timestamp must not un-file it; it only costs the age line. */
export function pendingProposal(comments: string[]): { at: string | null } | null {
  let pending: { at: string | null } | null = null;
  for (const body of comments) {
    const proposed = body.lastIndexOf(TEND_PROPOSAL_MARKER);
    const resolved = body.lastIndexOf(TEND_RESOLUTION_MARKER);
    if (proposed < 0 && resolved < 0) continue;
    if (resolved > proposed) {
      pending = null;
      continue;
    }
    const m = /"at"\s*:\s*"([^"]+)"/.exec(body);
    const t = m ? new Date(m[1]).getTime() : NaN;
    pending = { at: Number.isFinite(t) ? m![1] : null };
  }
  return pending;
}

export interface TendOpts {
  staleDays: number; // RALPH_STALE_DAYS — Backlog items with no updates
  auditDays: number; // RALPH_AUDIT_DAYS — Done-audit lookback
}

export const TEND_DEFAULTS: Readonly<TendOpts> = Object.freeze({
  staleDays: 30,
  auditDays: 14,
});

export function parseTendOpts(
  env: Record<string, string | undefined> = process.env,
): TendOpts {
  const positive = (name: string, def: number): number => {
    const raw = env[name];
    if (raw === undefined) return def;
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
    process.stderr.write(`warn: ${name}="${raw}" is not a positive number — using ${def}\n`);
    return def;
  };
  return {
    staleDays: positive("RALPH_STALE_DAYS", TEND_DEFAULTS.staleDays),
    auditDays: positive("RALPH_AUDIT_DAYS", TEND_DEFAULTS.auditDays),
  };
}

/** Derived from contracts.ts TEND_CATEGORIES — the single declaration (the C6
 *  schema uses the same tuple; per-value docs live on it). */
export type TendCategory = (typeof TEND_CATEGORIES)[number];

export interface TendRow {
  number: number;
  title: string;
  category: TendCategory;
  /** The timestamp that put it in the queue (ordering input, oldest first). */
  at: string | null;
}

export interface TendQueueResult {
  next: TendRow | null;
  queue: TendRow[];
  blocked: TendRow[]; // shape parity with next/deliver-queue; tend blocks nothing
  /** §4.3.5 — the observation-intake slot. The selector never reads dream-loop
   *  reflections (no MCP dependency); the SKILL decides whether to pull
   *  surfaced observations during its session. */
  observationSlot: true;
}

const UNFORMED_DAYS = 7;

/** Pure classification per spec §4.3. `auditCandidates` carries the recent
 *  closed items with their comment trails already fetched (batched upstream). */
export function classifyTend(
  open: QueueItemWithBlockers[],
  closed: Array<{ number: number; title?: string; closedAt: string | null; comments: string[] }>,
  opts: TendOpts,
  now: Date,
  /** number → the proposal's `at` (null when the payload was unreadable), for
   *  the open items whose trails were read. Absent = no proposal on file. */
  proposals: Map<number, string | null> = new Map(),
): TendQueueResult {
  const ms = (iso: string | null | undefined): number | null => {
    if (!iso) return null;
    const t = new Date(iso).getTime();
    return Number.isFinite(t) ? t : null;
  };
  const dayMs = 86_400_000;
  const backlog = open.filter((i) => i.state === "Backlog");
  const seen = new Set<number>(); // one row per issue — first category (spec order) wins
  const rows: { [K in TendCategory]: TendRow[] } = {
    proposed: [],
    "stale-body": [],
    "deps-cleared": [],
    "deps-truncated": [],
    unformed: [],
    "done-audit": [],
  };
  const push = (cat: TendCategory, i: { number: number; title?: string }, at: string | null) => {
    if (seen.has(i.number)) return;
    seen.add(i.number);
    rows[cat].push({ number: i.number, title: i.title ?? "", category: cat, at });
  };

  // 0. Pending proposals (GH-1777). FIRST in spec order deliberately: an item
  //    with a proposal on file surfaces as `proposed` instead of whatever
  //    category produced the proposal, which is what stops the lane proposing
  //    the same closure every pass. `seen` does the rest.
  for (const i of backlog) {
    if (!proposals.has(i.number)) continue;
    push("proposed", i, proposals.get(i.number) ?? null);
  }
  // 1. Stale bodies: the repo's documented failure mode is trusting these.
  for (const i of backlog) {
    const t = ms(i.updatedAt);
    if (t !== null && now.getTime() - t > opts.staleDays * dayMs) push("stale-body", i, i.updatedAt!);
  }
  // 2. Dependency anomalies — Backlog-scoped (§4.1 keeps tend out of In
  //    Progress / In Review beyond comments).
  for (const i of backlog) {
    if (i.openBlockers.length === 0 && i.closedBlockers.length > 0 && !i.blockersTruncated)
      push("deps-cleared", i, i.updatedAt ?? null);
  }
  for (const i of backlog) {
    if (i.blockersTruncated) push("deps-truncated", i, i.updatedAt ?? null);
  }
  // 3. Formation candidates: likely unformed intake.
  for (const i of backlog) {
    const t = ms(i.createdAt);
    const old = t !== null && now.getTime() - t > UNFORMED_DAYS * dayMs;
    if (
      old &&
      !i.estimate &&
      !i.hasParent &&
      i.openBlockers.length === 0 &&
      i.closedBlockers.length === 0 &&
      !i.blockersTruncated
    )
      push("unformed", i, i.createdAt!);
  }
  // 4. Done audit: the marker is the cursor; no local state.
  for (const c of closed) {
    const t = ms(c.closedAt);
    if (t === null || now.getTime() - t > opts.auditDays * dayMs) continue;
    // A pending proposal outranks the audit for the same reason it outranks
    // stale-body above: it is the do-not-re-propose cursor. Without this a
    // `reopen-as-unevidenced` proposal is invisible to the classifier (the
    // proposals map covers Backlog only), so the item returns as `done-audit`
    // every pass and gets proposed again forever.
    //
    // A proposal filed at or before the close was ANSWERED BY THE CLOSE — that
    // is what accepting a `close-as-delivered` proposal looks like — so it
    // settles without a marker and the item flows on to be audited. Only a
    // proposal filed AFTER the close (the `reopen-as-unevidenced` shape) is
    // still awaiting a human. An undated proposal fails closed to pending: it
    // stays visible rather than being silently swallowed by the audit path.
    const p = pendingProposal(c.comments);
    if (p && (p.at === null || (ms(p.at) ?? 0) > t)) {
      push("proposed", c, p.at);
      continue;
    }
    if (c.comments.some((b) => b.includes(TEND_MARKER))) continue;
    push("done-audit", c, c.closedAt);
  }

  const oldestFirst = (a: TendRow, b: TendRow) => {
    const ta = ms(a.at) ?? 0;
    const tb = ms(b.at) ?? 0;
    return ta - tb || a.number - b.number;
  };
  const queue = (
    ["proposed", "stale-body", "deps-cleared", "deps-truncated", "unformed", "done-audit"] as const
  ).flatMap((cat) => rows[cat].sort(oldestFirst));
  return { next: queue[0] ?? null, queue, blocked: [], observationSlot: true };
}

/** The tend lane's typed selector. Done-audit comment trails ride the same
 *  batched history fetch doctor uses — no per-item round trips, no MCP. */
export function tendQueue(ctx: Ctx, opts: TendOpts = parseTendOpts()): TendQueueResult {
  // classifyTend reads dependency edges (deps-cleared / deps-truncated) and
  // never labels — 2 pts/page instead of 3 (GH-1803).
  const full = listItemsFull(ctx, QUEUE_SELECT_NO_LABELS);
  const open = ownRepo(ctx, full.open).own;
  const closedOwn = ownRepo(ctx, full.closed).own.filter((c) => !c.archived);
  const dayMs = 86_400_000;
  const recent = closedOwn.filter((c) => {
    const t = c.closedAt ? new Date(c.closedAt).getTime() : NaN;
    return Number.isFinite(t) && ctx.now().getTime() - t <= opts.auditDays * dayMs;
  });
  const histories = fetchHistories(ctx, recent.map((c) => c.number));
  const closed = recent.map((c) => ({
    number: c.number,
    title: "",
    closedAt: c.closedAt,
    comments: histories.get(c.number)?.comments ?? [],
  }));
  // Proposal markers live in the comment trails of OPEN items, which this
  // selector does not fetch. Bound that cost by classifying first and reading
  // only the trails of items already in the queue — the only items a tend pass
  // could have proposed against — then re-classifying with the cursor. Both
  // calls are pure; the fetch is what costs. Honest limit: a proposal whose
  // item no longer qualifies for any category (it was formed or updated since)
  // drops out of this queue — doctor's `tend-proposal-stale` line, which reads
  // every open item's trail, is the backstop that keeps it visible.
  const first = classifyTend(open, closed, opts, ctx.now());
  const candidates = new Set(open.map((i) => i.number));
  const numbers = first.queue.map((r) => r.number).filter((n) => candidates.has(n));
  const proposals = new Map<number, string | null>();
  if (numbers.length > 0) {
    const trails = fetchHistories(ctx, numbers);
    for (const n of numbers) {
      const p = pendingProposal(trails.get(n)?.comments ?? []);
      if (p) proposals.set(n, p.at);
    }
  }
  if (proposals.size === 0) return first;
  return classifyTend(open, closed, opts, ctx.now(), proposals);
}

/** Dispose of a pending closure proposal by writing the durable resolution
 *  marker (GH-1777). This is the ONLY way to record a **rejection**: the other
 *  dispositions are state moves the board can already observe (a close answers
 *  a `close-as-delivered` proposal by outcome — see classifyTend — and `reopen`
 *  calls this itself), but "no, leave it open" changes nothing observable, so
 *  without a written record the item would re-surface as `proposed` forever.
 *
 *  Returns the proposal it answered, or null when nothing was pending — the
 *  caller decides whether that is an error (the CLI verb refuses; `reopen`
 *  moves on), so this never invents a disposition for a proposal that does not
 *  exist. Throws when the trail could not be READ: silently reporting "nothing
 *  pending" on a failed fetch would be the one wrong answer here. */
export function resolveProposal(
  ctx: Ctx,
  issue: Issue,
  disposition: "accepted" | "rejected",
  note?: string,
): { at: string | null } | null {
  const trail = fetchHistories(ctx, [issue.number]).get(issue.number);
  if (!trail)
    throw new Error(
      `could not read #${issue.number}'s comment trail — cannot tell whether a proposal is pending`,
    );
  const pending = pendingProposal(trail.comments);
  if (!pending) return null;
  const payload = JSON.stringify({
    disposition,
    at: ctx.now().toISOString(),
    ...(pending.at ? { proposed_at: pending.at } : {}),
    ...(note ? { note } : {}),
  });
  addComment(
    ctx,
    issue.nodeId,
    `**Tend proposal ${disposition}** (\`board\` by \`${ctx.cfg.holder}\`)` +
      (note ? `:\n\n${note}` : "") +
      `\n\n${TEND_RESOLUTION_MARKER}\n\`\`\`json\n${payload}\n\`\`\``,
  );
  return pending;
}

// ---------------------------------------------------------------------------
// Create / link / dep
// ---------------------------------------------------------------------------

export interface CreateOpts {
  title: string;
  body?: string;
  parent?: number;
  estimate?: string;
  priority?: string;
  state?: State;
  labels?: string[];
}

/** Validate a priority against the board's LIVE options rather than a hardcoded
 *  P0..P3: `setup` seeds that set but never edits an existing field, so a host
 *  repo's own scheme is the truth here — exactly as `next`'s ranking reads it. */
/** `setup` never edits an existing field, so a host board may already carry a
 *  TEXT or NUMBER field named "Priority" — and the name-only cache check would
 *  wave both write paths through. The SET path merely failed confusingly
 *  ("options are: (none)"), but CLEAR erased that field's value outright and
 *  then reported `(none)`, because issue reads only recognise a single-select
 *  Priority: destructive, and invisible in the output. Both paths refuse by
 *  dataType first, naming what the board actually has. */
function assertPrioritySingleSelect(cache: BoardCache): void {
  const field = cache.fields[PRIORITY_FIELD];
  if (field && field.dataType !== "SINGLE_SELECT") {
    throw new UsageError(
      `this board's ${PRIORITY_FIELD} field is ${field.dataType}, not SINGLE_SELECT — ralph ranks a ` +
        `single-select ${PRIORITY_FIELD} and will neither write nor CLEAR a custom ${field.dataType} field ` +
        `(clearing it would erase data \`board get\` cannot even show you). Convert it in the Projects UI, ` +
        `or leave ${PRIORITY_FIELD} to the board.`,
    );
  }
}

function assertPriorityOption(cache: BoardCache, value: string): void {
  assertPrioritySingleSelect(cache);
  const options = Object.keys(cache.fields[PRIORITY_FIELD]?.options ?? {});
  if (!options.includes(value)) {
    throw new UsageError(
      `unknown ${PRIORITY_FIELD} "${value}" — this board's options are: ${options.join(", ") || "(none)"}`,
    );
  }
}

/** The Priority field's live option order — what `next`/`frontier` hand the
 *  ranker so a host repo's accepted custom scheme is orderable, not just
 *  writable. An absent Priority field yields `[]`, i.e. exactly the
 *  digit-suffix fallback boards without the field have always had.
 *
 *  Nothing in the field cache can notice a REORDER or a RENAME — `satisfied()`
 *  only ever asks whether a name is present — so a purely cached read would
 *  steer the queue by an obsolete scheme until some unrelated mutation happened
 *  to refresh the schema. Refreshing on EVERY call is the wrong end of that
 *  trade: `next` is pinned at 2 warm round trips by the metrics registry, and
 *  the item cache exists precisely so a chain of reads pays for one walk. So
 *  the refresh is triggered three ways, cheapest first:
 *    - EVIDENCE: an item holds a priority value the cached options don't list.
 *      That is proof the schema moved under us (a rename, or an option added
 *      elsewhere), and it costs nothing on a healthy board — the common case
 *      never fires it. This closes the rename half outright rather than
 *      time-bounding it, and it is the reason the ranker's own input is passed
 *      in rather than read here. Evidence is spent ONCE per value: a live read
 *      that still does not list it proves the value is genuinely obsolete
 *      (a supported case — an item keeping a removed value as historical
 *      record), so it is recorded in `unresolvedPriorities` and stops counting
 *      as news. Otherwise such a board would pay a schema query on every warm
 *      read forever, defeating the very bound this design protects.
 *    - OPERATOR: `--fresh`, the flag that already means "don't serve me a
 *      snapshot", now forces the schema read too. A deterministic escape hatch
 *      beats waiting out any Δ.
 *    - AGE: a ceiling of PRIORITY_ORDER_MAX_AGE_MS for the one case no
 *        evidence can reveal — a pure REORDER of names that are all still
 *        present. That case is genuinely undetectable without reading the
 *        schema (GitHub offers no schema ETag or version), so it is
 *        bounded staleness by construction, exactly like the item cache's Δ,
 *        and this comment is the honest label rather than a claim of freshness.
 *
 *  A failed refresh degrades to the cached order, and a total miss to `[]`
 *  (digit-suffix ranking), each with a warning — deliberately fail-soft in that
 *  direction: the option order is advisory ranking input, while a `next` that
 *  cannot answer at all stops the loop. */
const PRIORITY_ORDER_MAX_AGE_MS = 60 * 60_000;
const PRIORITY_UNRESOLVED_MAX = 64;

/** POSIX single-quoting, for option names echoed into a copy-pasteable command.
 *  A live option may legitimately contain spaces or shell metacharacters
 *  ("High Priority"), and an unquoted recovery command would split it — at best
 *  failing, at worst setting a DIFFERENT valid option that matches the first
 *  word. A recovery hint that silently does something else is the worst kind. */
function shQuote(s: string): string {
  return /^[A-Za-z0-9._\/:@-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export function priorityOptionOrder(
  ctx: Ctx,
  opts: { values?: Array<string | null>; fresh?: boolean } = {},
): string[] {
  // The DECLARED order, never Object.keys of the option map — see FieldInfo.
  // An older cache file predating optionOrder falls back to the map, which is
  // correct for every non-integer-like scheme and no worse than before for the
  // rest; the next refresh repairs it.
  const order = (c: BoardCache): string[] => {
    const f = c.fields[PRIORITY_FIELD];
    return f?.optionOrder ?? Object.keys(f?.options ?? {});
  };
  // A cache written before `optionOrder` existed is STALE, not usable-as-is.
  // Falling back to the map is only safe as a last resort, because for
  // integer-like names it silently reverses the declared order — and the
  // evidence trigger cannot save us there: every value IS in the map, so
  // nothing looks unexplained and `next` would pick wrong work until the age
  // ceiling expired. One refresh on first use after the upgrade closes it.
  const legacy = (c: BoardCache): boolean => {
    const f = c.fields[PRIORITY_FIELD];
    return !!f?.options && f.optionOrder === undefined;
  };
  let cached: BoardCache;
  try {
    cached = ensureCache(ctx);
  } catch {
    process.stderr.write(`warn: ${PRIORITY_FIELD} options unreadable — ranking by digit suffix only\n`);
    return [];
  }
  const cachedOrder = order(cached);
  // An unparseable stamp counts as stale (NaN fails the comparison either way,
  // so it is asserted, not left to coincidence).
  const age = ctx.now().getTime() - Date.parse(cached.fetchedAt);
  const known = new Set([...cachedOrder, ...(cached.unresolvedPriorities ?? [])]);
  const candidates = (opts.values ?? []).filter((v): v is string => typeof v === "string" && v.length > 0);
  // Once the suppression list has evicted anything, "unexplained" no longer
  // proves the cache is stale — it may just be a value we can no longer afford
  // to remember (see unresolvedPrioritiesTruncated).
  const unexplained = cached.unresolvedPrioritiesTruncated ? [] : candidates.filter((v) => !known.has(v));
  const stale =
    opts.fresh === true ||
    unexplained.length > 0 ||
    legacy(cached) ||
    !(Number.isFinite(age) && age <= PRIORITY_ORDER_MAX_AGE_MS);
  if (!stale) return cachedOrder;
  let refreshed: BoardCache;
  try {
    refreshed = refreshCache(ctx);
  } catch (e) {
    process.stderr.write(
      `warn: ${PRIORITY_FIELD} options not refreshed (${(e as Error).message}) — ranking by the cached order\n`,
    );
    return cachedOrder;
  }
  const freshOrder = order(refreshed);
  // Spend the evidence: whatever the LIVE schema still does not list is
  // obsolete-by-confirmation, not a stale cache, and must not re-trigger.
  // Filtered against the LIVE order, carried entries included: a name that is
  // an option again is not obsolete, whatever a previous read concluded.
  const all = [
    ...new Set([...(cached.unresolvedPriorities ?? []), ...candidates]),
  ].filter((v) => !freshOrder.includes(v));
  // Bounded: this is a suppression list, not a ledger. Newest wins, because an
  // old entry GitHub re-added is re-learned by the next live read. Crossing the
  // cap sets the truncated flag, which is what stops eviction from turning into
  // a permanent refresh loop.
  const confirmed = all.slice(-PRIORITY_UNRESOLVED_MAX);
  const truncated = cached.unresolvedPrioritiesTruncated === true || all.length > PRIORITY_UNRESOLVED_MAX;
  if (confirmed.length || truncated) {
    if (confirmed.length) refreshed.unresolvedPriorities = confirmed;
    if (truncated) refreshed.unresolvedPrioritiesTruncated = true;
    try {
      writeFileSync(cachePath(ctx), JSON.stringify(refreshed, null, 2));
    } catch {
      /* the suppression list is an optimisation — losing it costs a query, not
         correctness, so a read-only cache dir must not break ranking */
    }
  }
  return freshOrder;
}

/** The setter `next` needed all along: an item filed without a priority ranks
 *  dead last, and until now the only fix was the Projects V2 UI — i.e. off the
 *  sanctioned path. `null` clears the field. */
export function setPriority(ctx: Ctx, number: number, value: string | null): Issue {
  const issue = fetchIssue(ctx, number);
  const itemId = requireItem(issue);
  // Live schema on BOTH branches. The set is what a value is judged against —
  // and a clear needs it just as much, for the field ID rather than the
  // options: a field deleted and recreated keeps its name, so the cache stays
  // `satisfied()` while holding an obsolete id, and every clear would fail
  // against it until some unrelated op happened to refresh. `--clear`
  // validating nothing was the wrong reason to skip the read.
  const cache = mutationCache(ctx, [[PRIORITY_FIELD]], [], [PRIORITY_FIELD]);
  if (value === null) {
    // Refuse BEFORE clearing: this is the destructive direction.
    assertPrioritySingleSelect(cache);
    clearField(ctx, cache, itemId, PRIORITY_FIELD);
  } else {
    assertPriorityOption(cache, value);
    setSingleSelect(ctx, cache, itemId, PRIORITY_FIELD, value);
  }
  return fetchIssue(ctx, number);
}

export function createIssue(ctx: Ctx, opts: CreateOpts): Issue {
  if (opts.state && ["Done", "Canceled"].includes(opts.state)) {
    throw new UsageError(
      `cannot create an issue in terminal state "${opts.state}" — create it open, then move/cancel it`,
    );
  }
  // Priority is validated BEFORE the issue exists — a bad option must cost a
  // usage error, not an orphaned issue nobody's selector will ever surface.
  //
  // ASKED-FOR, not truthy: `--priority ""` (an unset shell variable) arrives as
  // an empty string, and every truthiness check here used to skip validation
  // AND the write, filing the unprioritized issue this gate exists to refuse.
  // `undefined` is the only way to say "no priority"; anything else, empty
  // string included, is a request that must be validated and can fail.
  const wantsPriority = opts.priority !== undefined;
  const needs: Array<[string, string?]> = [[STATE_FIELD, opts.state ?? "Backlog"]];
  if (wantsPriority) needs.push([PRIORITY_FIELD]);
  // …and validated against a LIVE option set: a cached option GitHub has since
  // deleted would pass here and fail after createIssue (see mutationCache).
  const cache = mutationCache(ctx, needs, [], wantsPriority ? [PRIORITY_FIELD] : []);
  if (wantsPriority) assertPriorityOption(cache, opts.priority!);
  {
    const created = ghGraphQL(
      ctx,
      `mutation($repositoryId: ID!, $title: String!, $body: String) {
        createIssue(input: { repositoryId: $repositoryId, title: $title, body: $body }) {
          issue { id number url }
        }
      }`,
      { repositoryId: cache.repositoryId, title: opts.title, body: opts.body ?? "" },
    );
    const issue = created.createIssue.issue;

    const added = ghGraphQL(
      ctx,
      `mutation($projectId: ID!, $contentId: ID!) {
        addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) { item { id } }
      }`,
      { projectId: cache.projectId, contentId: issue.id },
    );
    const itemId = added.addProjectV2ItemById.item.id;

    setSingleSelect(ctx, cache, itemId, STATE_FIELD, opts.state ?? "Backlog");
    syncStatus(ctx, cache, itemId, opts.state ?? "Backlog");
    // Unlike estimate, a failed priority write is FATAL-loud: a null priority
    // is what makes an issue invisible to `next`, so it may not pass as a warn.
    //
    // DEFERRED, not immediate: throwing here skipped every later write, so
    // `create --apply --priority …` could leave the issue without its apply
    // label while the error told the operator to fix only Priority — following
    // the advertised recovery would not restore the requested shape. The rest of
    // the requested setup is applied first, and the throw then reports
    // everything that did not land.
    let priorityFailure: string | null = null;
    if (wantsPriority) {
      try {
        setSingleSelect(ctx, cache, itemId, PRIORITY_FIELD, opts.priority!);
      } catch (e) {
        priorityFailure = (e as Error).message;
      }
    }
    let estimateFailure: string | null = null;
    if (opts.estimate) {
      try {
        setSingleSelect(ctx, cache, itemId, ESTIMATE_FIELD, opts.estimate);
      } catch (e) {
        // Still only a warning on its own — an unset estimate does not hide the
        // issue from `next`. But it is recorded, because the aggregate error
        // below claims to name EVERY write that did not land, and a claim of
        // completeness that quietly omits one is worse than no claim.
        estimateFailure = (e as Error).message;
        process.stderr.write(`warn: estimate not set: ${estimateFailure}\n`);
      }
    }
    // Labels are applied via `gh issue edit` rather than GraphQL: it resolves
    // names to IDs itself, and creating the label when absent is the repo
    // owner's call, not the CLI's. A label failure is LOUD but non-fatal —
    // the issue exists, and an apply twin missing its label is caught by the
    // merge gate rather than being silently mislabelled here.
    let labelFailure: string | null = null;
    if (opts.labels?.length) {
      const r = ctx.exec([
        "gh", "issue", "edit", String(issue.number),
        "--repo", `${ctx.cfg.owner}/${ctx.cfg.repo}`,
        ...opts.labels.flatMap((l) => ["--add-label", l]),
      ]);
      if (r.code !== 0) {
        labelFailure = r.stderr.trim() || r.stdout.trim();
        process.stderr.write(
          `warn: labels ${opts.labels.join(",")} not applied to #${issue.number}: ` +
            `${labelFailure} (create the label first: gh label create)\n`,
        );
      }
    }
    let parentFailure: string | null = null;
    if (opts.parent) {
      try {
        const parent = fetchIssue(ctx, opts.parent);
        ghGraphQL(
          ctx,
          `mutation($parentId: ID!, $childId: ID!) {
            addSubIssue(input: { issueId: $parentId, subIssueId: $childId }) { issue { id } }
          }`,
          { parentId: parent.nodeId, childId: issue.id },
        );
      } catch (e) {
        // Only reported when priority already failed — otherwise a parenting
        // failure keeps its previous behavior of surfacing as itself.
        if (priorityFailure === null) throw e;
        parentFailure = (e as Error).message;
      }
    }
    // One error naming EVERY operation that did not land, each with the command
    // that repairs it — a recovery hint that fixes one of three unapplied writes
    // is worse than none, because it reads as completeness.
    if (priorityFailure !== null) {
      const unapplied = [
        `${PRIORITY_FIELD} (\`board priority ${issue.number} ${shQuote(opts.priority!)}\`): ${priorityFailure}`,
        ...(estimateFailure !== null
          ? [`${ESTIMATE_FIELD} ${opts.estimate} (set it in the board UI): ${estimateFailure}`]
          : []),
        ...(labelFailure !== null
          ? [`labels ${opts.labels!.join(",")} (\`gh issue edit ${issue.number} --add-label …\`): ${labelFailure}`]
          : []),
        ...(parentFailure !== null
          ? [`parent #${opts.parent} (\`board link ${opts.parent} ${issue.number}\`): ${parentFailure}`]
          : []),
      ];
      throw new Error(
        `#${issue.number} was created (${issue.url}) but ${unapplied.length} requested ` +
          `${unapplied.length === 1 ? "write" : "writes"} did NOT land:\n  - ${unapplied.join("\n  - ")}`,
      );
    }
    return fetchIssue(ctx, issue.number);
  }
}

/** Node ids only, one aliased round trip for any number of issues. link/dep/
 *  comment need exactly this — paying fetchIssue's full payload (100 labels,
 *  50 sub-issues with nested field values, 50 blockers) twice per `board dep`
 *  was the wrong reuse. Repository-scoped like every read, so a bare number
 *  still cannot resolve outside the configured repo. */
export function fetchNodeIds(ctx: Ctx, numbers: number[]): Map<number, string> {
  const decls = numbers.map((_, k) => `$n${k}: Int!`).join(", ");
  const aliases = numbers.map((_, k) => `a${k}: issue(number: $n${k}) { id }`).join(" ");
  const vars: Record<string, unknown> = { owner: ctx.cfg.owner, repo: ctx.cfg.repo };
  numbers.forEach((n, k) => (vars[`n${k}`] = n));
  let data: any;
  try {
    data = ghGraphQL(
      ctx,
      `query($owner: String!, $repo: String!, ${decls}) {
        repository(owner: $owner, name: $repo) { ${aliases} }
      }`,
      vars,
    );
  } catch (e) {
    // A missing issue surfaces as a NOT_FOUND entry in body.errors; keep
    // fetchIssue's contract (UsageError, exit 64) rather than a bare Error.
    // Match the structured type, not GitHub's message wording.
    if (e instanceof GraphQLError && e.types.includes("NOT_FOUND")) {
      throw new UsageError(
        `issue not found in ${ctx.cfg.owner}/${ctx.cfg.repo} (of #${numbers.join(", #")}): ${e.message}`,
      );
    }
    throw e;
  }
  const out = new Map<number, string>();
  numbers.forEach((n, k) => {
    const id = data.repository?.[`a${k}`]?.id;
    if (!id) throw new UsageError(`issue #${n} not found in ${ctx.cfg.owner}/${ctx.cfg.repo}`);
    out.set(n, id);
  });
  return out;
}

export function linkParent(ctx: Ctx, parentNumber: number, childNumber: number): void {
  const ids = fetchNodeIds(ctx, [parentNumber, childNumber]);
  ghGraphQL(
    ctx,
    `mutation($parentId: ID!, $childId: ID!) {
      addSubIssue(input: { issueId: $parentId, subIssueId: $childId }) { issue { id } }
    }`,
    { parentId: ids.get(parentNumber), childId: ids.get(childNumber) },
  );
}

export function setDependency(ctx: Ctx, blockedNumber: number, blockingNumber: number, remove = false): void {
  const ids = fetchNodeIds(ctx, [blockedNumber, blockingNumber]);
  const mutation = remove ? "removeBlockedBy" : "addBlockedBy";
  ghGraphQL(
    ctx,
    `mutation($blockedId: ID!, $blockingId: ID!) {
      ${mutation}(input: { issueId: $blockedId, blockingIssueId: $blockingId }) { issue { id } }
    }`,
    { blockedId: ids.get(blockedNumber), blockingId: ids.get(blockingNumber) },
  );
}

// ---------------------------------------------------------------------------
// Doctor
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// State smells (GH-1715) — evidence-based, never predictive.
//
// Every signal here is a failure the machine ALREADY WATCHED HAPPEN and wrote
// down, so no new tracking state exists to drift out of sync with reality: the
// comment trail IS the audit trail. The patterns below must therefore track
// their writers — `transition()` posts the --steal eviction comment and the
// "**Decision needed**" escalation; doctor --fix posts the stale-claim release.
// Both claim-loss writers say "stale claim by `holder`", which is the anchor.
// ---------------------------------------------------------------------------

/** Written by transition()'s --steal eviction AND doctor --fix's stale-claim
 *  release — the two ways a claim is lost rather than handed back. */
export const CLAIM_EXPIRY_EVIDENCE = /stale claim by/;
/** Written by transition() whenever --why accompanies a move to Human Needed,
 *  which the machine REQUIRES for that target — so every escalation leaves one. */
export const ESCALATION_EVIDENCE = /^\*\*Decision needed\*\*/m;

/** Count of comments matching an evidence pattern. A lower bound: only the
 *  last HISTORY_COMMENTS comments are read, so a very noisy issue under-counts
 *  and the check stays quiet — the safe direction for an advisory line. */
export function countEvidence(comments: string[], pattern: RegExp): number {
  return comments.filter((c) => pattern.test(c)).length;
}

/** In Review for >= `days` with nothing moving on a linked PR since it got
 *  there. Null means "not stalled" OR "not measurable" — with no state
 *  timestamp the machine has observed nothing, and an evidence-based check
 *  must stay silent rather than guess from the issue's own updatedAt. */
export function reviewStall(
  h: Pick<IssueHistory, "stateUpdatedAt" | "prActivityAt">,
  now: Date,
  days: number,
): { days: number; prs: number } | null {
  if (!h.stateUpdatedAt) return null;
  const since = new Date(h.stateUpdatedAt);
  if (Number.isNaN(since.getTime())) return null;
  const elapsedDays = (now.getTime() - since.getTime()) / 86_400_000;
  if (elapsedDays < days) return null;
  // "Since entering" is the whole point: a PR touched before the item reached
  // In Review is not review activity, it is the work that produced the PR.
  const moved = h.prActivityAt.some((t) => {
    const at = new Date(t);
    return !Number.isNaN(at.getTime()) && at.getTime() > since.getTime();
  });
  if (moved) return null;
  return { days: Math.floor(elapsedDays), prs: h.prActivityAt.length };
}

/** Named once so the failure path can mark every smell check "not evaluated"
 *  rather than leaving a reader to wonder which ones ran. */
export const SMELL_CHECKS = [
  "repeated-claim-expiry",
  "escalation-ping-pong",
  "review-stalled",
  "tend-proposal-stale",
] as const;

/** "info" is advisory-only by construction (GH-1715): it is not an invariant
 *  breach, `--strict` never escalates it, `--fix` never touches it, and the
 *  exit code below keys on "fail" alone. Anything that should change an exit
 *  code is a warn or a fail — never an info. */
export type DoctorLevel = "ok" | "info" | "warn" | "fail";

export interface DoctorReport {
  ok: boolean;
  checks: Array<{ name: string; level: DoctorLevel; detail: string }>;
}

// ---------------------------------------------------------------------------
// Installed-plugin floor (GH-1825). The gates in this file ship as a VERSIONED
// INSTALL, so a merge is not the moment one becomes true: agents call the copy
// recorded in installed_plugins.json, which can sit releases behind the tree
// the gate merged into. Observed three times in one session (#1705 ran the
// apply gate at 0.1.74, six releases before it existed).
//
// Advisory by construction, like every other info line: doctor cannot install
// a plugin, the operator's local install is not a repo invariant, and the
// weekly doctor.yml runs in an environment with no plugin install at all.
// ---------------------------------------------------------------------------

/** One row per gate that lives in the installed plugin. `since` is a fact about
 *  ralph's own release history — not a repo's to pick — and `reliedOn` is the
 *  opt-in the repo already declares once, in the merge policy. A new gate adds
 *  a row here, beside the gate itself; the version exists in no second place,
 *  so there is nothing to drift, and a repo that never enabled a capability
 *  never hears about its floor. */
export const CAPABILITY_FLOORS: ReadonlyArray<{
  capability: string;
  since: string;
  reliedOn: (cfg: Config) => boolean;
}> = [
  { capability: "the apply close gate", since: "0.1.81", reliedOn: (cfg) => cfg.apply.enabled },
];

export interface InstalledPluginCopy {
  installPath: string;
  version: string;
  /** "installed" = the copy's own .claude-plugin/plugin.json (the code that is
   *  actually there); "registry" = the installed_plugins.json record, used only
   *  when that manifest cannot be read, and always labelled as such. */
  source: "installed" | "registry";
}

/** Where Claude Code records what is installed. Resolved, never hardcoded to a
 *  cache directory: the whole bug class is that a directory which happens to
 *  exist is not the one being executed (this machine holds 29 ralph version
 *  dirs under the cache; exactly one is called). */
export function installedPluginsFile(): string {
  return (
    process.env.RALPH_INSTALLED_PLUGINS_FILE ??
    join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "plugins", "installed_plugins.json")
  );
}

/** Every installed copy of `name`, across marketplaces and scopes. Returns null
 *  when the question cannot be asked at all — no registry, unreadable registry,
 *  no such plugin — because absence of an install is never a breach. */
export function resolveInstalledPlugin(name: string): InstalledPluginCopy[] | null {
  const file = installedPluginsFile();
  if (!existsSync(file)) return null;
  let registry: any;
  try {
    registry = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  const plugins = registry?.plugins;
  if (!plugins || typeof plugins !== "object") return null;
  const copies: InstalledPluginCopy[] = [];
  for (const [key, entries] of Object.entries(plugins)) {
    if (key.split("@")[0] !== name) continue; // keys are "<name>@<marketplace>"
    for (const e of Array.isArray(entries) ? entries : []) {
      const installPath = typeof e?.installPath === "string" ? e.installPath : "";
      if (!installPath) continue;
      let version = "";
      let source: InstalledPluginCopy["source"] = "installed";
      try {
        const v = JSON.parse(
          readFileSync(join(installPath, ".claude-plugin", "plugin.json"), "utf8"),
        )?.version;
        if (typeof v === "string") version = v;
      } catch {
        /* the copy is gone or unreadable — fall back to the registry record */
      }
      if (!version) {
        source = "registry";
        version = typeof e?.version === "string" ? e.version : "";
      }
      if (version) copies.push({ installPath, version, source });
    }
  }
  return copies.length ? copies : null;
}

/** Numeric dot-compare. Null when either side is not a plain numeric version —
 *  "unknown" is a real value in installed_plugins.json, and an unparseable
 *  version is NOT evaluated rather than assumed stale. */
export function compareVersions(a: string, b: string): number | null {
  const parts = (v: string) => v.split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : NaN));
  const [x, y] = [parts(a), parts(b)];
  if ([...x, ...y].some((n) => Number.isNaN(n))) return null;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Doctor's `installed-plugin` line. Only ever "ok" or "info" — the type says
 *  so, so no future edit can make an operator's local install fail a repo's
 *  --strict sweep. */
export function installedPluginReport(cfg: Config): { level: "ok" | "info"; detail: string } {
  const copies = resolveInstalledPlugin("ralph");
  if (!copies)
    return {
      level: "info",
      detail:
        `not evaluated: no installed ralph plugin recorded in ${installedPluginsFile()} ` +
        `(a repo that vendors the CLI instead of installing the plugin has none)`,
    };
  const floors = CAPABILITY_FLOORS.filter((f) => f.reliedOn(cfg));
  // The LOWEST copy is the one to judge: any of them may be the one a session
  // resolved, and the risk is one-sided — a gate that isn't running.
  const ranked = copies.filter((c) => compareVersions(c.version, "0.0.0") !== null);
  const lowest = ranked.sort((a, b) => compareVersions(a.version, b.version)!)[0];
  const others = copies.length > 1 ? ` (${copies.length} installed copies; judging the lowest)` : "";
  if (!lowest)
    return {
      level: "info",
      detail: `not evaluated: installed version unparseable (${copies.map((c) => c.version).join(", ")})`,
    };
  const via =
    lowest.source === "registry"
      ? ` [version from the installed_plugins.json record — the copy's own manifest is unreadable]`
      : "";
  const where = `ralph ${lowest.version} at ${lowest.installPath}${via}${others}`;
  if (floors.length === 0)
    return {
      level: "ok",
      detail: `${where} — no capability floor applies (this repo enables no gate that lives in the plugin)`,
    };
  const below = floors.filter((f) => compareVersions(lowest.version, f.since)! < 0);
  if (below.length === 0)
    return {
      level: "ok",
      detail: `${where} — at or above every floor this repo relies on (${floors
        .map((f) => `${f.capability} ≥ ${f.since}`)
        .join(", ")})`,
    };
  return {
    level: "info",
    detail:
      `${where} — ` +
      below
        .map((f) => `${lowest.version} < ${f.since}, so ${f.capability} is NOT enforcing in agent sessions`)
        .join("; ") +
      `. The merged code is not the copy agents call: update the installed plugin (\`/plugin\`)`,
  };
}

// ---------------------------------------------------------------------------
// Volume + prune (GH-1788). Both are PURE over the page walk every caller
// already does — measuring the board costs nothing extra, and the dry run
// costs nothing at all.
// ---------------------------------------------------------------------------

export interface VolumeReport {
  items: number; // EVERY node the walk paged through — the number that sets the cost
  pages: number; // round trips a full scan actually spent
  open: number;
  closed: number;
  archived: number; // still scanned; see the VolumeThresholds banner
  /** Nodes the walk paid for and board.ts cannot use: pull requests and draft
   *  items (the `... on Issue` fragment matches neither). Called out because
   *  on a real board this is a large share of the bill, and no amount of issue
   *  hygiene touches it. Archived issues are NOT counted here — they are
   *  issues, they are reported as `archived`, and labelling them "PRs/drafts"
   *  would make the doctor line state something untrue. */
  nonIssue: number;
  maxItems: number;
  over: boolean;
}

/** What a full scan cost, measured BY the scan rather than inferred from what
 *  survived it. Inferring understates the bill: issues that were filtered out
 *  (foreign repos) and nodes that never matched the issue fragment (PRs,
 *  drafts) still occupied a slot on a page that had to be fetched. */
export function volumeReport(pages: ItemPages, thresholds: VolumeThresholds): VolumeReport {
  // Archived items land in two places: closed ones ride along in `closed`
  // (carrying their flag), open ones are dropped by the walk and survive only
  // as a counter. Both were scanned, so both are reported.
  const archived = pages.closed.filter((c) => c.archived).length + pages.scan.archivedOpen;
  const items = pages.scan.nodes;
  return {
    items,
    pages: Math.max(1, pages.scan.pages),
    open: pages.open.length,
    closed: pages.closed.length,
    archived,
    // A residual, so every accounted class must be subtracted — archived open
    // items included, or they masquerade as PRs.
    nonIssue: Math.max(
      0,
      items - pages.open.length - pages.closed.length - pages.scan.archivedOpen,
    ),
    maxItems: thresholds.maxItems,
    over: items > thresholds.maxItems,
  };
}

export interface PruneCandidate {
  number: number;
  itemId: string;
  state: string;
  closedAt: string;
  ageDays: number;
}

/** Why a closed item is NOT a candidate. Named, because a prune that silently
 *  drops items from its own candidate list is indistinguishable from a prune
 *  that found nothing. */
export type PruneRetention =
  | "not-terminal" // board state isn't Done/Canceled — closedDrift still has work here
  | "too-recent" // inside the prune-age window (tend's Done audit still reads these)
  | "undated" // no parseable closedAt — cannot prove it is old, so it stays
  | "apply-unit" // apply-labelled (or label list truncated): the close gate's evidence sweep owns it
  | "archived" // already hidden; removing it buys the same scan win but loses more state for no reason
  | "tree-edge" // an OPEN item reaches its ancestors through this closed node
  | "no-item-id"; // no ProjectV2Item handle came back — nothing safe to remove by

export interface PruneReport {
  candidates: PruneCandidate[];
  retained: Array<{ number: number; reason: PruneRetention }>;
  scanned: number; // own-repo closed items considered
}

/** The prune predicate, in one pure place so the dry run and the apply path
 *  can never disagree about what is safe to remove.
 *
 *  A candidate must be a closed own-repo item that NOTHING still reads:
 *  doctor's closedDrift wants non-terminal closed items, tend's Done audit
 *  wants recent ones, the apply-evidence sweep wants apply units, and
 *  next/frontier walk tree edges through closed ancestors. Anything another
 *  reader still depends on is retained WITH ITS REASON — every exclusion here
 *  fails closed, so an item we cannot classify stays on the board. */
export function classifyPrune(
  open: QueueItem[],
  closed: ClosedItem[],
  cfg: { volume: VolumeThresholds; apply: ApplyConfig },
  now: Date,
): PruneReport {
  // Closed nodes that an OPEN item reaches by walking up its own-repo parent
  // chain — exactly rankNext's tree, so pruning can never sever an edge the
  // ranker still walks. Visited-set bounded, so a malformed cycle terminates.
  const parentOf = new Map<number, number | null>();
  for (const i of open) parentOf.set(i.number, i.parentNumber);
  for (const c of closed) if (!parentOf.has(c.number)) parentOf.set(c.number, c.parentNumber);
  const loadBearing = new Set<number>();
  for (const i of open) {
    const seen = new Set<number>([i.number]);
    for (let p = i.parentNumber; p != null && !seen.has(p); ) {
      seen.add(p);
      loadBearing.add(p);
      p = parentOf.get(p) ?? null;
    }
  }

  const dayMs = 86_400_000;
  const candidates: PruneCandidate[] = [];
  const retained: PruneReport["retained"] = [];
  const keep = (number: number, reason: PruneRetention) => retained.push({ number, reason });

  for (const c of closed) {
    if (c.archived) {
      keep(c.number, "archived");
      continue;
    }
    if (!c.itemId) {
      keep(c.number, "no-item-id");
      continue;
    }
    if (!["Done", "Canceled"].includes(c.state)) {
      keep(c.number, "not-terminal");
      continue;
    }
    // Fail closed on a truncated label list, exactly as the apply close gate
    // does: an apply unit whose label fell past the page must not be pruned
    // out from under the evidence sweep.
    if (cfg.apply.enabled && (c.labelsTruncated || c.labels.includes(cfg.apply.label))) {
      keep(c.number, "apply-unit");
      continue;
    }
    if (loadBearing.has(c.number)) {
      keep(c.number, "tree-edge");
      continue;
    }
    const t = c.closedAt ? new Date(c.closedAt).getTime() : NaN;
    if (!Number.isFinite(t)) {
      keep(c.number, "undated");
      continue;
    }
    const ageDays = Math.floor((now.getTime() - t) / dayMs);
    if (ageDays < cfg.volume.pruneAfterDays) {
      keep(c.number, "too-recent");
      continue;
    }
    candidates.push({ number: c.number, itemId: c.itemId, state: c.state, closedAt: c.closedAt!, ageDays });
  }
  candidates.sort((a, b) => b.ageDays - a.ageDays);
  return { candidates, retained, scanned: closed.length };
}

/** Consecutive mutation failures that stop a sweep. A prune that keeps firing
 *  mutations after this many failures in a row is not making progress — it is
 *  burning the GraphQL budget this whole line of work exists to protect.
 *  Consecutive rather than total: isolated per-item failures (one archived or
 *  concurrently-removed item) are expected and must not abort a healthy sweep,
 *  while a rate limit or a revoked scope fails EVERY call from that point on. */
export const PRUNE_MAX_CONSECUTIVE_FAILURES = 5;

/** Hard ceiling on one sweep, so a first --apply on a huge board cannot spend
 *  thousands of mutation points in a single unattended command. */
export const PRUNE_DEFAULT_LIMIT = 200;

export function pruneLimit(raw: string | boolean | undefined): number {
  if (raw === undefined) return PRUNE_DEFAULT_LIMIT;
  // A bare `--limit` is a dropped value, not a request for the default.
  if (typeof raw === "boolean") throw new UsageError("--limit needs a positive integer value");
  const n = Number(raw);
  // Unlike the advisory thresholds, this one bounds a DESTRUCTIVE loop: a
  // typo'd --limit must not silently widen the blast radius, so it is refused
  // rather than defaulted.
  if (!Number.isInteger(n) || n <= 0) {
    throw new UsageError(`--limit must be a positive integer, got "${raw}"`);
  }
  return n;
}

export interface PruneApplyResult {
  attempted: number;
  removed: number;
  failed: string[];
  aborted: boolean; // stopped early on consecutive failures
}

/** The removal loop, bounded twice: by the caller's slice (--limit) and by a
 *  consecutive-failure circuit breaker. Extracted from the CLI case so it can
 *  be tested directly — the two bugs this replaces were both reachable only
 *  through the dispatch, which had no test. */
export function applyPrune(ctx: Ctx, candidates: PruneCandidate[]): PruneApplyResult {
  const failed: string[] = [];
  let removed = 0;
  let attempted = 0;
  let consecutive = 0;
  const projectId = refreshCache(ctx).projectId;
  for (const c of candidates) {
    attempted++;
    try {
      ghGraphQL(
        ctx,
        `mutation($projectId: ID!, $itemId: ID!) {
          deleteProjectV2Item(input: { projectId: $projectId, itemId: $itemId }) { deletedItemId }
        }`,
        { projectId, itemId: c.itemId },
      );
      removed++;
      consecutive = 0; // progress resets the breaker
    } catch (e) {
      // Per-item fault isolation, like doctor's fix loops: one unremovable
      // item must not abort a sweep that is otherwise working.
      failed.push(`#${c.number} (${(e as Error).message})`);
      if (++consecutive >= PRUNE_MAX_CONSECUTIVE_FAILURES) {
        return { attempted, removed, failed, aborted: true };
      }
    }
  }
  return { attempted, removed, failed, aborted: false };
}

export function doctor(ctx: Ctx, opts: { fix?: boolean; strict?: boolean } = {}): DoctorReport {
  // The write-guard carve-out (GH-1806), enforced HERE and not only at the CLI
  // dispatch, so a programmatic caller cannot route around it. --fix selects
  // its correction targets from the walk and then mutates: a cached walk would
  // be reconciling a board that no longer looks like that. The report-only
  // sweep is a read like any other and keeps the cache.
  if (opts.fix) ctx = { ...ctx, itemCacheTtlSec: 0 };
  const checks: DoctorReport["checks"] = [];
  const add = (name: string, level: DoctorLevel, detail: string) =>
    checks.push({ name, level, detail });

  // auth
  const auth = ctx.exec(["gh", "auth", "status"]);
  add("gh-auth", auth.code === 0 ? "ok" : "fail", auth.code === 0 ? "authenticated" : auth.stderr.trim());

  // scope
  const remote = ctx.exec(["git", "-C", ctx.repoRoot, "remote", "get-url", "origin"]);
  if (remote.code !== 0) add("scope", "warn", "no origin remote");
  else if (scopeMatches(remote.stdout, ctx.cfg.owner, ctx.cfg.repo, ctx.cfg.host)) add("scope", "ok", remote.stdout.trim());
  else add("scope", "fail", `origin ${remote.stdout.trim()} != configured ${ctx.cfg.host}/${ctx.cfg.owner}/${ctx.cfg.repo}`);

  // cache vs live schema
  let cache: BoardCache | null = null;
  try {
    cache = refreshCache(ctx);
    add("cache", "ok", `projectId ${cache.projectId.slice(0, 12)}…, ${Object.keys(cache.fields).length} fields`);
  } catch (e) {
    add("cache", "fail", (e as Error).message);
  }

  if (cache) {
    const stateField = cache.fields[STATE_FIELD];
    if (!stateField?.options) add("state-field", "fail", `"${STATE_FIELD}" field missing`);
    else {
      const names = Object.keys(stateField.options);
      const missing = STATES.filter((s) => !names.includes(s));
      const legacy = names.filter((n) => !isState(n));
      if (missing.length) add("state-field", "fail", `missing options: ${missing.join(", ")}`);
      else if (legacy.length)
        add(
          "state-field",
          opts.strict ? "fail" : "warn",
          `legacy options present (delete by hand in the board UI; the API cannot): ${legacy.join(", ")}`,
        );
      else add("state-field", "ok", "6-state option set");
    }
    add(
      "claim-field",
      cache.fields[CLAIM_FIELD] ? "ok" : opts.strict ? "fail" : "warn",
      cache.fields[CLAIM_FIELD] ? "present" : `"${CLAIM_FIELD}" text field missing (board setup creates it)`,
    );
    // Advisory fields warn even under --strict: sizing/ranking degrade
    // gracefully without them, so their absence is never an invariant breach.
    const missingAdvisory = advisoryFieldsMissing(cache);
    add(
      "advisory-fields",
      missingAdvisory.length === 0 ? "ok" : "warn",
      missingAdvisory.length === 0
        ? `${ESTIMATE_FIELD} + ${PRIORITY_FIELD} present`
        : `${missingAdvisory.join(", ")} missing — sizing/ranking degrade gracefully (board setup creates them)`,
    );

    // item sweep: legacy states, claim anomalies, stale claims, closed drift
    try {
      const pages = listItemsFull(ctx);
      const { own: items, foreign } = ownRepo(ctx, pages.open);
      const closedOwn = ownRepo(ctx, pages.closed).own;
      // The report-only sweep may be answered from the item cache (GH-1806) —
      // --fix never is. A doctor line saying "ok" about a board it read 80 s
      // ago is a different claim from one it just read, so it says which. CI
      // runs cold-cache, so this is always "fresh read" there.
      if (pages.cached)
        add("board-read", "info", `item sweep ran on a cached board read, ${pages.ageSec}s old (\`--fresh\` forces a walk; \`--fix\` always walks)`);
      add(
        "foreign-items",
        "ok",
        foreign.length === 0
          ? "none"
          : `${foreign.length} item(s) from other repos on this board (informational; board.ts never touches them): ${foreign.map((i) => `${i.repo}#${i.number}`).join(" ")}`,
      );
      // Board volume (GH-1788). INFO by construction: a big board is a cost,
      // never a broken invariant, so --strict must not escalate it and --fix
      // must not act on it — the remedy removes items from the project, which
      // is a human's call. Costs nothing: it measures the scan just done.
      // Its own try/catch is load-bearing for the same reason the smells block
      // has one: the enclosing catch would add `item-sweep: fail` and change
      // doctor's EXIT CODE, and no advisory line is worth that.
      try {
        const vol = volumeReport(pages, ctx.cfg.volume);
        const prune = classifyPrune(items, closedOwn, ctx.cfg, ctx.now());
        add(
          "board-volume",
          vol.over ? "info" : "ok",
          `${vol.items} items = ${vol.pages} page(s) per full scan ` +
            `(${vol.open} open, ${vol.closed} closed${vol.archived ? `, ${vol.archived} archived` : ""}` +
            `${vol.nonIssue ? `, ${vol.nonIssue} non-issue (PRs/drafts board.ts never reads)` : ""})` +
            (vol.over
              ? `; over ${vol.maxItems} (RALPH_VOLUME_MAX_ITEMS) — every scan pays for all of it, and ` +
                `archiving would NOT help (archived items are still returned by the items API). ` +
                (prune.candidates.length
                  ? `\`board prune\` lists ${prune.candidates.length} closed item(s) safe to remove from the project ` +
                    `(the issues are untouched); it is a dry run until \`--apply\``
                  : `no closed item is old enough to prune yet — the growth is live work, not history`)
              : ""),
        );
      } catch (e) {
        add("board-volume", "info", `not evaluated: ${(e as Error).message}`);
      }

      const legacyItems = items.filter((i) => i.state !== "(none)" && !isState(i.state));
      const noState = items.filter((i) => i.state === "(none)");
      const claimAnomalies = items.filter((i) => i.claim && i.state !== "In Progress");
      const terminalDrift = items.filter((i) => ["Done", "Canceled"].includes(i.state));
      // Closed issue, board not terminal: the issues:closed event lane missed
      // it (or never fired) — the cron sweep is the backstop. Archived items
      // reject writes and archive-on-done is legitimate closure, so skip them.
      const closedDrift = closedOwn.filter(
        (i) => !i.archived && !["Done", "Canceled"].includes(i.state),
      );
      // Claim text a human (or a bad write) left unparseable: parseClaim
      // returns null, so it would otherwise masquerade as "no claim".
      const garbled = items.filter((i) => i.claimRaw !== null && !i.claim);
      // In Progress with no claim: either UI-driven human work (fine) or the
      // shape a failed claim write leaves behind. Surface it; never auto-fix —
      // yanking a human's WIP back to Backlog would be hostile.
      const claimlessWip = cache.fields[CLAIM_FIELD]
        ? items.filter((i) => i.state === "In Progress" && !i.claim)
        : [];
      const stale = items.filter(
        (i) => i.claim && claimIsStale(i.claim, ctx.now(), ctx.cfg.lockTtlMin),
      );
      add(
        "legacy-items",
        legacyItems.length === 0 ? "ok" : opts.strict ? "fail" : "warn",
        legacyItems.length === 0
          ? "none"
          : `${legacyItems.length} open items in legacy states: ${legacyItems.slice(0, 10).map((i) => `#${i.number}(${i.state})`).join(" ")}`,
      );
      add("stateless-items", noState.length === 0 ? "ok" : "warn", noState.length === 0 ? "none" : `${noState.length} open items with no ${STATE_FIELD}: ${noState.slice(0, 10).map((i) => `#${i.number}`).join(" ")}`);
      add("claim-anomalies", claimAnomalies.length === 0 ? "ok" : "warn", claimAnomalies.length === 0 ? "none" : claimAnomalies.map((i) => `#${i.number}(${i.state})`).join(" "));
      add("stale-claims", stale.length === 0 ? "ok" : "warn", stale.length === 0 ? "none" : stale.map((i) => `#${i.number} by ${i.claim!.holders.join("+")}`).join(" "));
      add("terminal-drift", terminalDrift.length === 0 ? "ok" : "warn", terminalDrift.length === 0 ? "none" : `open issues in terminal board states: ${terminalDrift.map((i) => `#${i.number}(${i.state})`).join(" ")}`);
      add("closed-drift", closedDrift.length === 0 ? "ok" : "warn", closedDrift.length === 0 ? "none" : `closed issues in non-terminal board states: ${closedDrift.map((i) => `#${i.number}(${i.state})`).join(" ")}`);
      add("claimless-wip", claimlessWip.length === 0 ? "ok" : "warn", claimlessWip.length === 0 ? "none" : `In Progress without a claim (human WIP or a failed claim write): ${claimlessWip.map((i) => `#${i.number}`).join(" ")}`);
      // Never auto-fixed: a hand-edited Claim field is a human's note to self —
      // surfacing it is enough.
      add("claim-garbled", garbled.length === 0 ? "ok" : "warn", garbled.length === 0 ? "none" : `unparseable Claim text (want "holder[+holder2...]|iso8601"): ${garbled.map((i) => `#${i.number}`).join(" ")}`);

      // Apply-kind sweep (GH-1693). Inert — three `ok` lines — on a repo that
      // has not opted in, and on an opted-in board with no apply issues.
      if (!ctx.cfg.apply.enabled) {
        for (const n of ["merged-unapplied", "apply-verify-elapsed", "apply-closed-unevidenced"]) {
          add(n, "ok", "apply kind not enabled (no `apply` block in .github/ralph-merge-policy.json)");
        }
      } else {
        const openApply = items.filter((i) => isApplyIssue(ctx.cfg, i.labels, i.labelsTruncated));
        // The ship work this apply unit waited on has landed and the apply has
        // not happened. Requires blockers to have EXISTED: an apply unit with
        // no dependency edge was never gated on a merge, so "merged" is not a
        // claim anyone made about it.
        // blockersTruncated fails CLOSED here too: with an unseen tail of
        // blockers we cannot claim "the work this waited on has landed".
        const mergedUnapplied = openApply.filter(
          (i) => i.openBlockers.length === 0 && !i.blockersTruncated && i.closedBlockers.length > 0,
        );
        add(
          "merged-unapplied",
          mergedUnapplied.length === 0 ? "ok" : "warn",
          mergedUnapplied.length === 0
            ? "none"
            : `apply units whose blocking work has landed but which have not been applied: ` +
              mergedUnapplied.map((i) => `#${i.number}←closed ${i.closedBlockers.map((n) => `#${n}`).join(",")}`).join(" "),
        );
        // verify_after keeps a schedule-bound proof point (a weekly cron is up
        // to 7 days out) alive without rotting into daily noise: quiet until
        // the instant passes, then loud. Body reads are one query per apply
        // unit — a handful of issues, not the board.
        // Per-item fault isolation: one unreadable body must not hide every
        // OTHER elapsed apply unit — it is reported alongside them, not
        // instead of them.
        const elapsed: string[] = [];
        const unreadable: string[] = [];
        for (const i of openApply) {
          try {
            const at = parseVerifyAfter(fetchApplyMeta(ctx, i.number).body);
            if (at && at.getTime() <= ctx.now().getTime()) {
              elapsed.push(`#${i.number}(due ${at.toISOString()})`);
            }
          } catch (e) {
            unreadable.push(`#${i.number}(${(e as Error).message})`);
          }
        }
        const elapsedDetail = [
          elapsed.length ? `past their ralph-verify-after instant and still open: ${elapsed.join(" ")}` : "",
          unreadable.length ? `body unreadable (not evaluated): ${unreadable.join(" ")}` : "",
        ].filter(Boolean).join("; ");
        add(
          "apply-verify-elapsed",
          elapsed.length === 0 && unreadable.length === 0 ? "ok" : "warn",
          elapsedDetail || "none",
        );
        // The one strict-fail: a CLOSED-as-completed apply unit with no valid
        // evidence is the exact lie this epic exists to stop. NOT_PLANNED is
        // excluded — cancelling an apply unit is a decision, not a claim.
        const unevidenced: Array<{ number: number; failure: string }> = [];
        for (const i of closedOwn) {
          if (i.archived || !isApplyIssue(ctx.cfg, i.labels, i.labelsTruncated)) continue;
          if (i.stateReason === "NOT_PLANNED") continue;
          try {
            const failure = applyEvidenceFailure(ctx, i.number);
            if (failure) unevidenced.push({ number: i.number, failure });
          } catch (e) {
            unevidenced.push({ number: i.number, failure: `evidence unreadable: ${(e as Error).message}` });
          }
        }
        add(
          "apply-closed-unevidenced",
          unevidenced.length === 0 ? "ok" : opts.strict ? "fail" : "warn",
          unevidenced.length === 0
            ? "none"
            : `apply units closed as completed without deployed-and-verified evidence — ` +
              `\`board reconcile N\` reopens them to Human Needed: ` +
              unevidenced.map((u) => `#${u.number} (${u.failure})`).join("; "),
        );
        if (opts.fix) {
          for (const u of unevidenced) {
            try {
              add("fix", "ok", reconcile(ctx, u.number));
            } catch (e) {
              add("fix", "fail", `#${u.number}: ${(e as Error).message}`);
            }
          }
        }
      }

      // State smells (GH-1715). INFO level, always: these read history the
      // machine already wrote and suggest a next move — they are not
      // invariants, so --strict never escalates them and --fix never acts on
      // them. Their own try/catch is load-bearing: the enclosing catch would
      // add `item-sweep: fail` and change doctor's EXIT CODE, and no advisory
      // hint is worth that.
      try {
        const histories = fetchHistories(ctx, items.map((i) => i.number));
        const expiries: string[] = [];
        const pingPong: string[] = [];
        const stalled: string[] = [];
        const proposals: string[] = [];
        for (const i of items) {
          const h = histories.get(i.number);
          if (!h) continue; // no history read = nothing observed = nothing to say
          const lost = countEvidence(h.comments, CLAIM_EXPIRY_EVIDENCE);
          if (lost >= ctx.cfg.smells.claimExpiries) expiries.push(`#${i.number}(${lost} expired claims)`);
          const escalations = countEvidence(h.comments, ESCALATION_EVIDENCE);
          if (escalations >= ctx.cfg.smells.escalations) pingPong.push(`#${i.number}(escalated ${escalations}×)`);
          if (i.state === "In Review") {
            const s = reviewStall(h, ctx.now(), ctx.cfg.smells.reviewDays);
            if (s) stalled.push(`#${i.number}(${s.days}d, ${s.prs === 0 ? "no linked PR" : "PR quiet"})`);
          }
          const p = pendingProposal(h.comments);
          if (p) {
            const t = p.at ? new Date(p.at).getTime() : NaN;
            const days = Number.isFinite(t) ? (ctx.now().getTime() - t) / 86_400_000 : null;
            if (days === null) proposals.push(`#${i.number}(undated)`);
            else if (days >= ctx.cfg.smells.proposalDays) proposals.push(`#${i.number}(${Math.floor(days)}d)`);
          }
        }
        add(
          "repeated-claim-expiry",
          expiries.length === 0 ? "ok" : "info",
          expiries.length === 0
            ? "none"
            : `claims lost repeatedly — empirically too large for one tick; ` +
              `split via \`board create --parent N\`: ${expiries.join(" ")}`,
        );
        add(
          "escalation-ping-pong",
          pingPong.length === 0 ? "ok" : "info",
          pingPong.length === 0
            ? "none"
            : `re-escalated to Human Needed — the question is not converging; ` +
              `decompose or cancel: ${pingPong.join(" ")}`,
        );
        add(
          "review-stalled",
          stalled.length === 0 ? "ok" : "info",
          stalled.length === 0
            ? "none"
            : `In Review ≥${ctx.cfg.smells.reviewDays}d with no linked-PR activity since — ` +
              `merge gate or reviewer stuck? ${stalled.join(" ")}`,
        );
        add(
          "tend-proposal-stale",
          proposals.length === 0 ? "ok" : "info",
          proposals.length === 0
            ? "none"
            : `tend closure proposals unanswered ≥${ctx.cfg.smells.proposalDays}d — dispose of them ` +
              `(\`board cancel N -m\`, \`board move N done --why\`, \`board reopen N\`, or ` +
              `\`board resolve N --reject -m "why not"\`): ${proposals.join(" ")}`,
        );
      } catch (e) {
        for (const n of SMELL_CHECKS) add(n, "info", `not evaluated: ${(e as Error).message}`);
      }

      // Fix loops are per-item fault-isolated: one unwritable item logs its
      // own fail line and the sweep keeps going.
      if (opts.fix) {
        for (const i of [...terminalDrift, ...closedDrift]) {
          try {
            add("fix", "ok", reconcile(ctx, i.number));
          } catch (e) {
            add("fix", "fail", `#${i.number}: ${(e as Error).message}`);
          }
        }
      }
      if (opts.fix && cache.fields[CLAIM_FIELD]) {
        // Only STALE claims are cleared. A fresh claim on a state≠In-Progress
        // item is most likely a transition() mid-write (the claim lands before
        // the state) — clearing it would race the writer; the anomaly is
        // reported above and the next sweep gets it once the TTL expires.
        for (const i of stale) {
          try {
            const issue = fetchIssue(ctx, i.number);
            if (!issue.itemId) continue;
            // Staleness is re-verified on the fresh read, never trusted from
            // the snapshot: a holder that refreshed its claim between the page
            // walk and here is live, and clearing it would strand real WIP as
            // claimless (the demotion below would be skipped too).
            if (!issue.claim || !claimIsStale(issue.claim, ctx.now(), ctx.cfg.lockTtlMin)) {
              add("fix", "ok", `#${i.number}: claim refreshed since the sweep — left alone`);
              continue;
            }
            clearField(ctx, cache, issue.itemId, CLAIM_FIELD);
            if (issue.state === "In Progress") {
              // The one sanctioned state write outside transition/reconcile/
              // parent-check: releasing a stale claim must return the item to
              // Backlog, and no lane models "the holder vanished" (reconcile
              // follows issue open/closed reality, which has not changed).
              // Pinned by test: "stale-claim demotion is a deliberate…".
              setSingleSelect(ctx, cache, issue.itemId, STATE_FIELD, "Backlog");
              syncStatus(ctx, cache, issue.itemId, "Backlog");
              addComment(
                ctx,
                issue.nodeId,
                `\`board doctor --fix\`: stale claim by \`${issue.claim.holders.join("+")}\` released; returned to Backlog.`,
              );
            }
            add("fix", "ok", `#${i.number}: claim cleared`);
          } catch (e) {
            add("fix", "fail", `#${i.number}: ${(e as Error).message}`);
          }
        }
      }
    } catch (e) {
      add("item-sweep", "fail", (e as Error).message);
    }
  }

  // heartbeat (Phase 3 writes it; absence is fine before then)
  const hb = join(homedir(), ".ralph", "heartbeat");
  if (existsSync(hb)) {
    const ageMin = (ctx.now().getTime() - Number(readFileSync(hb, "utf8").trim()) * 1000) / 60_000;
    add("heartbeat", ageMin < 60 ? "ok" : "warn", `${ageMin.toFixed(0)} min old`);
  } else {
    add("heartbeat", "ok", "absent (loop not installed)");
  }

  // state-guard proof-of-fire (Phase 2 workflow; tolerate absence)
  const runs = ctx.exec([
    // -R pins the check to the CONFIGURED repo (and host): run from a foreign
    // clone this must not judge whatever repo cwd resolves to.
    "gh", "run", "list", "-R", `${ctx.cfg.host}/${ctx.cfg.owner}/${ctx.cfg.repo}`,
    "--workflow", "state-guard.yml", "--limit", "5",
    "--json", "conclusion,updatedAt",
  ]);
  if (runs.code === 0) {
    try {
      const parsed = JSON.parse(runs.stdout);
      const bad = parsed.filter((r: any) => r.conclusion && r.conclusion !== "success");
      if (parsed.length === 0) add("state-guard", "warn", "no runs recorded");
      else if (bad.length === 0) add("state-guard", "ok", `last ${parsed.length} runs green`);
      else {
        // Inside the state-guard workflow this check judges its own run
        // history, and the job's exit code becomes the next window's newest
        // entry — after any outage a hard fail here re-poisons the window
        // every cron tick and can never self-heal (GH-1722). Warn there;
        // local runs and doctor.yml keep the fail — the wall's watchers are
        // outside the wall.
        const selfRun = process.env.GITHUB_WORKFLOW === "state-guard";
        add(
          "state-guard",
          selfRun ? "warn" : "fail",
          `${bad.length}/${parsed.length} recent runs not successful${selfRun ? " (self-run: warn, letting this run go green so the window can heal)" : ""}`,
        );
      }
    } catch {
      add("state-guard", "warn", "run list unparseable");
    }
  } else {
    add("state-guard", "ok", "workflow absent (pre-Phase-2)");
  }

  // herdr cockpit (GH-1759). INFO level, always: the cockpit is optional
  // equipment, so its absence is never an invariant breach — the weekly CI
  // doctor has no herdr and must stay clean. The probing logic lives once, in
  // herdr-setup.sh (the same script /ralph:help herdr drives); doctor only
  // relays its one-line verdict. Any failure to run it degrades to
  // "not evaluated" — an advisory hint is never worth an exit-code change.
  try {
    const setupSh =
      process.env.RALPH_HERDR_SETUP_SH ??
      join(dirname(fileURLToPath(import.meta.url)), "herdr-setup.sh");
    if (!existsSync(setupSh)) {
      add("herdr-cockpit", "info", `not evaluated: herdr-setup.sh not found at ${setupSh}`);
    } else {
      const r = ctx.exec(["bash", setupSh, "check", "--oneline"]);
      const line = r.stdout.trim();
      if (!line.startsWith("herdr:")) {
        add("herdr-cockpit", "info", `not evaluated: ${(r.stderr || line || "no output").trim().slice(0, 200)}`);
      } else if (r.code === 0) {
        add("herdr-cockpit", "ok", "wired (optional cockpit)");
      } else if (r.code === 2) {
        add("herdr-cockpit", "info", "herdr not installed — optional cockpit; `/ralph:help herdr` to set it up");
      } else {
        add("herdr-cockpit", "info", `${line.replace(/^herdr:\s*/, "")} — \`/ralph:help herdr\` walks the setup`);
      }
    }
  } catch (e) {
    add("herdr-cockpit", "info", `not evaluated: ${(e as Error).message}`);
  }

  // Installed-plugin floor (GH-1825). INFO level always — see the section
  // above. Its own try/catch keeps a throwing filesystem read out of the exit
  // code, exactly as the smells and volume blocks do.
  try {
    const r = installedPluginReport(ctx.cfg);
    add("installed-plugin", r.level, r.detail);
  } catch (e) {
    add("installed-plugin", "info", `not evaluated: ${(e as Error).message}`);
  }

  const ok = !checks.some((c) => c.level === "fail");
  return { ok, checks };
}

// ---------------------------------------------------------------------------
// Readiness — advisory only. Recommendations, never gates: every check here
// describes what a capability unlocks, and nothing in this CLI or the skills
// blocks on a miss. (Inspired by Factory's Agent Readiness model: measure the
// environment, recommend the next rung, let the repo decide.)
// ---------------------------------------------------------------------------

export type ReadinessLevel = 1 | 2 | 3;
export interface ReadinessCheck {
  level: ReadinessLevel;
  name: string;
  status: "ok" | "miss" | "info"; // info = machine-local, unverifiable, or advisory — never a gap
  detail: string;
  recommend?: string;
}
export interface ReadinessReport {
  repo: string;
  /** highest level whose checks (and all lower levels') have no "miss" */
  readyFor: 0 | ReadinessLevel;
  checks: ReadinessCheck[];
}

export const READINESS_LEVELS: Record<ReadinessLevel, string> = {
  1: "drive interactively (/ralph:work by hand)",
  2: "unattended sessions (one issue at a time)",
  3: "autonomous loop (scheduler-owned ticks)",
};

export function readiness(ctx: Ctx): ReadinessReport {
  const checks: ReadinessCheck[] = [];
  const add = (
    level: ReadinessLevel,
    name: string,
    status: ReadinessCheck["status"],
    detail: string,
    recommend?: string,
  ) => checks.push({ level, name, status, detail, ...(recommend ? { recommend } : {}) });

  // — Level 1: enough to drive the board by hand. board setup covers all of it. —
  const auth = ctx.exec(["gh", "auth", "status"]);
  add(
    1, "gh-auth", auth.code === 0 ? "ok" : "miss",
    auth.code === 0 ? "authenticated" : auth.stderr.trim() || "gh auth status failed",
    auth.code === 0 ? undefined : "gh auth login -s repo,project",
  );
  try {
    const cache = refreshCache(ctx);
    const machineMissing = [STATE_FIELD, CLAIM_FIELD].filter((f) => !cache.fields[f]);
    add(
      1, "board-fields", machineMissing.length === 0 ? "ok" : "miss",
      machineMissing.length === 0
        ? `"${STATE_FIELD}" + "${CLAIM_FIELD}" present`
        : `${machineMissing.map((f) => `"${f}"`).join(", ")} missing`,
      machineMissing.length === 0 ? undefined : "board setup",
    );
    // "info", not "miss": sizing/ranking degrade gracefully, so a board
    // without these is still fully drivable — the recommendation stands,
    // but it must never hold Level 1 hostage (doctor agrees: warn, no fail).
    const advisoryMissing = advisoryFieldsMissing(cache);
    add(
      1, "advisory-fields", advisoryMissing.length === 0 ? "ok" : "info",
      advisoryMissing.length === 0
        ? `${ESTIMATE_FIELD} + ${PRIORITY_FIELD} present`
        : `${advisoryMissing.join(", ")} missing (sizing/ranking degrade gracefully without them)`,
      advisoryMissing.length === 0 ? undefined : "board setup",
    );
  } catch (e) {
    add(1, "board-fields", "miss", (e as Error).message, "check .ralph.json / project number, then board setup");
  }

  // — Level 2: what an unattended per-issue session leans on. —
  const agentDocs = ["CLAUDE.md", "AGENTS.md"].filter((f) => existsSync(join(ctx.repoRoot, f)));
  add(
    2, "agent-docs", agentDocs.length > 0 ? "ok" : "miss",
    agentDocs.length > 0 ? agentDocs.join(", ") : "no CLAUDE.md or AGENTS.md at the repo root",
    agentDocs.length > 0
      ? undefined
      : "write the repo's working knowledge down (build/test commands, conventions, gotchas) — it is every session's starting context",
  );

  const testSignals = [
    "vitest.config.ts", "vitest.config.js", "jest.config.js", "jest.config.ts",
    "pytest.ini", "tox.ini", "playwright.config.ts", "tests", "test",
  ];
  let hasTests = testSignals.some((f) => existsSync(join(ctx.repoRoot, f)));
  if (!hasTests && existsSync(join(ctx.repoRoot, "package.json"))) {
    try {
      const scripts = JSON.parse(readFileSync(join(ctx.repoRoot, "package.json"), "utf8")).scripts ?? {};
      hasTests = Object.keys(scripts).some((s) => s === "test" || s.startsWith("test:"));
    } catch { /* unreadable package.json is just no signal */ }
  }
  add(
    2, "tests", hasTests ? "ok" : "miss",
    hasTests ? "test signal found" : "no test signal found (heuristic: test config/dir/script)",
    hasTests ? undefined : "a runnable test suite is the tightest feedback loop an agent has — wire one, however small",
  );

  const wfDir = join(ctx.repoRoot, ".github", "workflows");
  const workflows = existsSync(wfDir)
    ? readdirSync(wfDir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    : [];
  add(
    2, "ci", workflows.length > 0 ? "ok" : "miss",
    workflows.length > 0 ? `${workflows.length} workflow(s) in .github/workflows` : "no CI workflows found",
    workflows.length > 0 ? undefined : "CI on PRs turns \"works locally\" into a verdict an agent can trust",
  );

  let prStatus: ReadinessCheck["status"] = "info";
  let prDetail = "could not verify (repo API unavailable)";
  const repoInfo = ctx.exec(["gh", "api", "--hostname", ctx.cfg.host, `repos/${ctx.cfg.owner}/${ctx.cfg.repo}`]);
  if (repoInfo.code === 0) {
    try {
      const def = JSON.parse(repoInfo.stdout).default_branch as string;
      const rules = ctx.exec([
        "gh", "api", "--hostname", ctx.cfg.host,
        `repos/${ctx.cfg.owner}/${ctx.cfg.repo}/rules/branches/${def}`,
      ]);
      if (rules.code === 0) {
        const requiresPr = (JSON.parse(rules.stdout) as Array<{ type?: string }>).some(
          (r) => r.type === "pull_request",
        );
        prStatus = requiresPr ? "ok" : "miss";
        prDetail = requiresPr ? `"${def}" requires PRs (active ruleset)` : `no PR-required rule on "${def}"`;
      }
    } catch { /* keep "info" — an unverifiable check must not read as a gap */ }
  }
  add(
    2, "pr-required", prStatus, prDetail,
    prStatus === "ok" ? undefined : "protect the default branch (require a PR) so every agent change has a review surface",
  );

  // — Level 3: what the scheduler-owned loop leans on. —
  const hasGate = existsSync(join(ctx.repoRoot, "scripts", "merge-pr.sh"));
  add(
    3, "merge-gate", hasGate ? "ok" : "miss",
    hasGate ? "scripts/merge-pr.sh present" : "no scripted merge gate",
    hasGate
      ? undefined
      : "before agents merge unattended, script the merge verdict (convention: scripts/merge-pr.sh running CI/review/attestation checks with real exit codes) or encode it as required status checks",
  );
  const hasStateGuard = existsSync(join(wfDir, "state-guard.yml"));
  add(
    3, "state-guard", hasStateGuard ? "ok" : "miss",
    hasStateGuard ? ".github/workflows/state-guard.yml present" : "no board reconciler workflow",
    hasStateGuard
      ? undefined
      : "a reconciler lane (issue-event corrections + a doctor --fix cron) keeps the board honest when no session is looking",
  );
  // "info", never "miss": most repos ship nothing whose completion is a deploy,
  // and telling those repos they have a gap would be exactly the process
  // theater this kind was designed to avoid. Recommendation, not a rung.
  add(
    3, "apply-kind",
    ctx.cfg.apply.enabled ? "ok" : "info",
    ctx.cfg.apply.enabled
      ? `apply units enabled (label "${ctx.cfg.apply.label}", ${ctx.cfg.apply.infraPaths.length} infra path(s))`
      : "apply units not enabled — merges close issues, including for infrastructure work",
    ctx.cfg.apply.enabled
      ? undefined
      : "if this repo has work whose completion is a DEPLOY rather than a merge (terraform, secrets, rulesets, " +
        "scheduled jobs), add an `apply` block to .github/ralph-merge-policy.json — the board then refuses to " +
        "call such work Done without deployed-and-verified evidence. Repos whose changes go live on merge need none of it",
  );
  // `||`, not `??`: tick.sh's `${RALPH_HOME:-...}` treats empty as unset, and
  // this row must read the same files the scripts write.
  const ralphHome = process.env.RALPH_HOME || join(homedir(), ".ralph");
  const hb = existsSync(join(ralphHome, "heartbeat"));
  add(
    3, "loop", "info",
    hb
      ? "scheduler heartbeat present on this machine"
      : "loop not installed on this machine (install-loop.sh --enable when wanted)",
  );

  // Per-lane drive state (GH-1712) — machine-local like `loop`, and `info`
  // UNCONDITIONALLY (spec §4.7): a stale heartbeat on one machine must never
  // change the repo's readyFor. What it reports: the unattended opt-in keys
  // (fail-closed two-key convention), heartbeat presence + age, outcomes log.
  const autopilotKeys = new Set<string>();
  try {
    for (const line of readFileSync(join(ralphHome, "config"), "utf8").split("\n")) {
      const m = /^\s*([A-Za-z0-9_.-]+)\s*=\s*true\s*$/.exec(line);
      if (m) autopilotKeys.add(m[1]);
    }
  } catch {
    /* no config = nothing enabled; still info */
  }
  for (const lane of ["deliver", "tend"] as const) {
    const optIn =
      autopilotKeys.has("autopilot") && autopilotKeys.has(`autopilot.${lane}`)
        ? "unattended opt-in ON (autopilot + autopilot." + lane + ")"
        : "unattended opt-in off (attended invocations need none)";
    let hbNote = `no ${lane}.heartbeat on this machine`;
    try {
      const ageMin = Math.round(
        (ctx.now().getTime() - statSync(join(ralphHome, `${lane}.heartbeat`)).mtimeMs) / 60_000,
      );
      hbNote = `heartbeat ${ageMin} min old`;
    } catch {
      /* absent: the note above stands */
    }
    let logNote = "no outcomes log yet";
    try {
      if (statSync(join(ralphHome, `${lane}.outcomes.log`)).size > 0) logNote = "outcomes log present";
    } catch {
      /* absent: the note above stands */
    }
    add(3, `lane-${lane}`, "info", `${optIn}; ${hbNote}; ${logNote}`);
  }

  let readyFor: ReadinessReport["readyFor"] = 0;
  for (const lvl of [1, 2, 3] as const) {
    if (checks.some((c) => c.level === lvl && c.status === "miss")) break;
    readyFor = lvl;
  }
  return { repo: `${ctx.cfg.owner}/${ctx.cfg.repo}`, readyFor, checks };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

export interface SetupReport {
  ok: boolean; // false = a created field/option did not survive the verify re-read
  notes: string[];
}

/** `emit` streams each note the moment it is produced, so a mid-run throw
 *  still surfaces everything done so far (the CLI passes stdout). */
export function setup(ctx: Ctx, emit?: (note: string) => void): SetupReport {
  const notes: string[] = [];
  const note = (s: string) => {
    notes.push(s);
    emit?.(s);
  };
  // Everything this run creates, so the final refresh can prove it stuck.
  const created: Array<{ name: string; options?: readonly string[] }> = [];
  const cache = refreshCache(ctx);

  // Advisory wrong-project check: a typo'd RALPH_GH_PROJECT_NUMBER would
  // provision a stranger's board. Linkage can legitimately be empty or lag
  // (fresh project, cross-repo boards), so this warns and never blocks.
  try {
    const linked: string[] = (
      ghGraphQL(
        ctx,
        `query($projectId: ID!) {
          node(id: $projectId) {
            ... on ProjectV2 { repositories(first: 50) { nodes { nameWithOwner } } }
          }
        }`,
        { projectId: cache.projectId },
      ).node?.repositories?.nodes ?? []
    ).map((r: any) => r.nameWithOwner);
    const self = `${ctx.cfg.owner}/${ctx.cfg.repo}`.toLowerCase();
    if (!linked.some((r) => r.toLowerCase() === self)) {
      note(
        `WARNING: project #${ctx.cfg.projectNumber} is not linked to ${ctx.cfg.owner}/${ctx.cfg.repo} ` +
          (linked.length ? `(linked: ${linked.join(", ")})` : "(no linked repositories)") +
          ` — verify RALPH_GH_PROJECT_NUMBER points at the intended board; ` +
          `linkage can also lag or be legitimately absent, so this is advisory only`,
      );
    }
  } catch {
    /* advisory only — unreadable linkage is not a setup failure */
  }

  const stateField = cache.fields[STATE_FIELD];
  if (!stateField) {
    ghGraphQL(
      ctx,
      `mutation($projectId: ID!, $name: String!, $options: [ProjectV2SingleSelectFieldOptionInput!]) {
        createProjectV2Field(input: {
          projectId: $projectId, name: $name, dataType: SINGLE_SELECT, singleSelectOptions: $options
        }) { projectV2Field { ... on ProjectV2SingleSelectField { id } } }
      }`,
      {
        projectId: cache.projectId,
        name: STATE_FIELD,
        options: STATES.map((s) => ({ name: s, color: "GRAY", description: "" })),
      },
    );
    created.push({ name: STATE_FIELD, options: STATES });
    note(`created "${STATE_FIELD}" single-select with the 6 v2 states`);
  } else {
    const names = Object.keys(stateField.options ?? {});
    const missing = STATES.filter((s) => !names.includes(s));
    if (missing.length) {
      note(
        `MANUAL: add option(s) ${missing.join(", ")} to "${STATE_FIELD}" in the board UI ` +
          `(the API cannot edit an existing field's option set)`,
      );
    }
    const legacy = names.filter((n) => !isState(n));
    if (legacy.length) {
      note(
        `MANUAL: delete legacy option(s) ${legacy.join(", ")} from "${STATE_FIELD}" in the board UI`,
      );
    }
  }

  if (!cache.fields[CLAIM_FIELD]) {
    ghGraphQL(
      ctx,
      `mutation($projectId: ID!, $name: String!) {
        createProjectV2Field(input: { projectId: $projectId, name: $name, dataType: TEXT }) {
          projectV2Field { ... on ProjectV2FieldCommon { id } }
        }
      }`,
      { projectId: cache.projectId, name: CLAIM_FIELD },
    );
    created.push({ name: CLAIM_FIELD });
    note(`created "${CLAIM_FIELD}" text field`);
  }

  for (const { name, options } of ADVISORY_FIELDS) {
    const existing = cache.fields[name];
    if (!existing) {
      ghGraphQL(
        ctx,
        `mutation($projectId: ID!, $name: String!, $options: [ProjectV2SingleSelectFieldOptionInput!]) {
          createProjectV2Field(input: {
            projectId: $projectId, name: $name, dataType: SINGLE_SELECT, singleSelectOptions: $options
          }) { projectV2Field { ... on ProjectV2SingleSelectField { id } } }
        }`,
        {
          projectId: cache.projectId,
          name,
          options: options.map((o) => ({ name: o, color: "GRAY", description: "" })),
        },
      );
      created.push({ name, options });
      note(`created "${name}" single-select (${options.join(" ")})`);
    } else if (existing.dataType !== "SINGLE_SELECT") {
      note(
        `"${name}" exists as ${existing.dataType} — left untouched ` +
          `(ralph's convention is single-select ${options.join("/")}; keeping your scheme is fine)`,
      );
    }
    // exists as a single-select: the host repo's option set is respected as-is
  }

  // Success is verified, never inferred from silence: the refreshed schema
  // must contain every field/option this run just created.
  const fresh = refreshCache(ctx);
  let ok = true;
  for (const c of created) {
    const f = fresh.fields[c.name];
    if (!f) {
      ok = false;
      note(`VERIFY FAILED: "${c.name}" is absent after refresh — the create did not stick`);
      continue;
    }
    const missingOpts = (c.options ?? []).filter((o) => !f.options?.[o]);
    if (missingOpts.length) {
      ok = false;
      note(`VERIFY FAILED: "${c.name}" is missing option(s) ${missingOpts.join(", ")} after refresh`);
    }
  }
  if (notes.length === 0) note("nothing to do — board already set up");
  return { ok, notes };
}

// ---------------------------------------------------------------------------
// Contract surface (ralph-herdr v2 Phase 1) — validate / emit / lint over the
// Zod source of truth in contracts.ts. Read-only against the board; `emit`
// writes schema artifacts into the repo (drift-checked by `contracts:check`).
// ---------------------------------------------------------------------------

/** Where `contract emit` lands by default, relative to the repo root. The
 *  generated *.schema.json files are commit-able artifacts — CI re-emits to a
 *  temp dir and diffs, so contracts.ts and the artifacts cannot drift apart. */
export const CONTRACTS_OUT_DEFAULT = join("ralph", "contracts", "generated");

function requireContractId(raw: string | undefined): ContractId {
  if (!raw || !isContractId(raw)) {
    throw new UsageError(`contract id required — one of: ${CONTRACT_IDS.join(", ")}`);
  }
  return raw;
}

/** Payload source: a file path, or "-"/absent for stdin (fd 0). */
function readContractPayload(arg: string | undefined): unknown {
  const raw = readFileSync(arg === undefined || arg === "-" ? 0 : arg, "utf8");
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new UsageError(`payload is not JSON: ${(e as Error).message}`);
  }
}

/** The live-lint effect functions (contracts.ts LiveLintDeps) wired to this
 *  CLI's own plumbing: L3's commit probe through the exec seam against the
 *  repo root, L5/L7's board read-back through fetchIssue — the same fetch
 *  path every other read uses. Built only under `contract lint --live`; a
 *  plain lint run stays repo- and network-free. */
export function liveLintDeps(ctx: Ctx): LiveLintDeps {
  return {
    execGit: (args) => ({ code: ctx.exec(["git", "-C", ctx.repoRoot, ...args]).code }),
    readBoardItem: (issue) => {
      try {
        const i = fetchIssue(ctx, issue);
        return { issueState: i.issueState, state: i.state, claim: i.claim };
      } catch (e) {
        // fetchIssue's not-found contract is UsageError; anything else
        // (transport, GraphQL) must propagate — a network failure is not
        // evidence the issue is missing.
        if (e instanceof UsageError) return null;
        throw e;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const HELP = `board — the ralph v2 board CLI (sole sanctioned mutation path)

reads
  get NNN [--json]            issue: state, claim, parent/children, blockers, PRs
  list [--state S] [--json]   open items on the board — a bounded own-repo
                              read (open issues only), not a full project
       [--all-repos]          scan the whole project instead: the only read
                              that enumerates foreign board items. --json
                              carries foreignEvaluated so "not read" never
                              reads as "none there"
  next [--json]               top-ranked actionable Backlog item (+ blocked report).
                              Epic-aware: an epic root yields to its best open
                              leaf (leaf inherits the root's priority, carries
                              "via"); an epic with a child in flight heads nothing
  frontier [--json]           the work-stealing frontier (ralph-herdr fleets):
                              every issue eligible to start NOW — next's queue,
                              item for item — each with its explanation
                              {number, title, parentNumber?, blockers:
                              [{number, state}], eligible}, plus a blocked
                              section [{number, blockers_open, truncated?}].
                              A re-projection of next's ranking, never a
                              second eligibility computation
  name NNN [--json]           the derived names for a unit (GH-1807): branch
                              <kind>/NNN-<slug>, agent w NNN-<slug> (grammar B,
                              same slug), worktree leaf. Kind comes from labels
                              (apply label wins); --lane picks the agent lane.
                              The ONLY place a transport may read the
                              convention from — no second copy of the grammar
  tree NNN                    subtree with states
  claim show NNN [--json]     the claim as the board holds it: holders, shared
                              since, age vs TTL, raw text when garbled
  deliver-queue [--json]      deliver lane (GH-1712): In Review items whose
                              linked PRs carry an actionable signal, marker-
                              gated per PR. {next, queue, blocked}; empty next
                              means spawn nothing (idle-exit is the caller's
                              contract). Knobs: RALPH_SETTLE_MIN (5),
                              RALPH_RETRY_MIN (60), RALPH_DELIVER_DRYRUN_MAX (3)
  tend-queue [--json]         tend lane (GH-1712): Backlog hygiene + Done audit
                              — pending closure proposals, stale bodies,
                              cleared/truncated deps, unformed intake,
                              unaudited closes. Classification only;
                              judgment (and every closure, as a marker-comment
                              proposal) belongs to /ralph:tend. Knobs:
                              RALPH_STALE_DAYS (30), RALPH_AUDIT_DAYS (14)

mutations
  create --title T [--body B] [--parent NNN] [--estimate XS..XL] [--state S]
                              [--priority P0..P3] [--label L[,L2]] [--apply]
                              --apply files an APPLY unit under the configured
                              label: it closes only on deployed-and-verified
                              evidence, never on a merge.
                              --priority is validated against the board's live
                              Priority options; omitting it ranks the item LAST
                              in \`next\` (null sorts after P3)
  priority NNN <option>       set Priority on an existing item (--clear removes
                              it). Options come from the live field, not a
                              hardcoded P0..P3 — a host repo owns its scheme,
                              and \`next\` orders a custom one by the field's
                              option ORDER (a trailing digit is the fallback)
  claim NNN [--steal]         Backlog/Human Needed/In Review → In Progress; sets Claim
  claim join NNN --holder H   add a fleet sibling to an In Progress item's
                              shared claim (ClaimV2, max 8 holders; H must be
                              a grammar-B or legacy agent name). Refreshes the
                              ONE shared since; refuses when not In Progress
  claim leave NNN --holder H  remove a sibling from the shared claim; non-
                              member leave is a no-op; the LAST one out clears
                              the field. Never transitions state — board moves
                              stay the skills' job
  release NNN -m "why"        In Progress → Backlog; parking comment required
  move NNN <state> [--why W]  any legal transition; Human Needed requires --why
  answer NNN -m "decision"    Human Needed → In Progress, COMMENT-FIRST: the
                              answer lands as an issue comment (**Answer** —
                              the durable half) BEFORE any state write, so a
                              session that vanishes mid-answer leaves the
                              decision on the record, not a bare move.
                              --message is an alias for -m. --comment-only
                              posts without the move; --any-state answers an
                              item outside Human Needed (comment only — the
                              Human Needed → In Progress edge is the only
                              move this verb owns). [--json] reports
                              {commented, transitioned, state}. The herdr
                              prompt half (nudging the paused agent to
                              resume) is deliberately NOT here — the
                              ralph-herdr plugin owns it. Escalation payload
                              shape is checked by \`board contract validate
                              ralph.escalation\`, never by this verb
  cancel NNN -m "why"         any open state → Canceled (closes as not-planned)
  reopen NNN                  Done/Canceled → Backlog (reopens the issue); also
                              resolves a pending tend proposal, since reopening
                              is what accepting "reopen-as-unevidenced" means
  resolve NNN --accept|--reject -m "why"
                              dispose of a pending \`ralph-tend:v1 proposed\`
                              closure proposal by writing the durable
                              resolution marker. The other dispositions are
                              state moves the board already observes (a close
                              answers the proposal by outcome, reopen resolves
                              itself); this verb exists for the one that is not
                              observable — REJECTION, "leave it open". Exits 1
                              when nothing is pending; -m required to reject
  link PARENT CHILD           add sub-issue edge
  dep NNN --on MMM [--rm]     NNN is blocked by MMM (--rm removes)
  comment NNN -m "body"

maintenance
  adopt NNN                   ensure issue is on the board (new items → Backlog)
  reconcile NNN               sync board state to issue reality (closed→Done/Canceled,
                              reopened→Backlog); the state-guard event lane
  parent-check NNN            advance parent if all children closed
  doctor [--fix] [--strict]   invariant sweep; --fix clears/releases bad claims.
                              "i" lines are advisory state smells read from the
                              machine's own comment trail — never gates, never
                              fixed; thresholds via RALPH_SMELL_CLAIM_EXPIRIES
                              (2), RALPH_SMELL_ESCALATIONS (3),
                              RALPH_SMELL_REVIEW_DAYS (7)
  prune [--apply] [--json] [--limit N]
                              list closed items removable from the PROJECT (the
                              issues are untouched) — closed ≥180 days
                              (RALPH_PRUNE_AFTER_DAYS), board state already
                              terminal, not an apply unit, and no open item's
                              tree passing through them. DRY RUN unless
                              --apply. This is the only lever that shrinks a
                              full scan: archiving does not, because archived
                              items are still returned by the items API.
                              Doctor's "board-volume" line says when it matters
                              (RALPH_VOLUME_MAX_ITEMS, 800). --json reports the
                              same run --apply performs (never a dry run under
                              --apply). One sweep removes at most --limit items
                              (200) and stops after 5 consecutive failures.
  setup                       create Workflow State / Claim / Estimate / Priority
                              fields (idempotent; never edits existing fields)
  readiness [--json]          agent-readiness report — 3 levels (interactive,
                              unattended, autonomous); recommendations, never gates

contracts (ralph-herdr v2 — the Zod source of truth is contracts.ts)
  contract validate <id> [file|-]
                              validate a JSON payload against the producer
                              (strict) schema; exit 1 with the issues listed
  contract emit [--out DIR]   write one <id>.schema.json per contract
                              (default ralph/contracts/generated); CI drift-
                              checks the artifacts via npm run contracts:check
  contract lint <id> [file|-] [--live]
                              run lints L1-L13 against a payload; exit 1 on any
                              failure. --live also runs L3 (commit_sha exists,
                              git cat-file against this repo), L5 (claim read-
                              back: the agent holds the issue's claim) and L7
                              (parent_issue exists and is not Done/Canceled);
                              without it they report skipped. L10 (lineage
                              closure) is ledger-side — see
                              plugin/ralph-herdr/scripts/doctor-lineage.sh
  ids: ralph.spawn_request ralph.completion_report ralph.fleet_brief
       ralph.fleet_reply ralph.board_queue ralph.lineage
       ralph.token_vocabulary ralph.escalation

There is no --force flag. A stale claim (TTL 120 min; RALPH_LOCK_TTL_MIN
overrides) is the only override path.

item cache (GH-1806)
  The board walk is memoized to ~/.ralph/cache for 90 s
  (RALPH_ITEM_CACHE_TTL_SEC; 0 disables, max 600), so a next → frontier →
  list chain pays for one walk instead of three. --fresh forces a walk for
  one command, and a cached answer always says so.

  Reads may be bounded-stale; WRITES SEE TRUTH. Every mutating command, and
  doctor --fix, runs with the cache off, and every write path re-reads the
  single item it is about to guard on. What a stale entry can cost is one
  wasted claim attempt — never a wrong transition — because the claim
  protocol is read-back verification, not read freshness.`;

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-m") {
      flags.m = argv[++i] ?? "";
    } else if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--") && !["json", "steal", "rm", "fix", "strict", "apply", "live", "comment-only", "any-state", "all-repos", "fresh", "clear"].includes(key)) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  if ("force" in flags) {
    throw new UsageError("there is no --force. A stale claim (TTL) is the only override path — by design.");
  }
  return { positional, flags };
}

/** A truncated child read means its board state is UNREADABLE, not unset —
 *  "(none)"-style output would send the operator fixing a state that exists. */
function childStateLabel(c: Issue["children"][number]): string {
  if (c.state !== null) return c.state;
  return c.fieldValuesTruncated ? "state unreadable — field values truncated" : c.issueState;
}

function issueLine(i: Issue): string {
  const claim = i.claim ? ` claim=${i.claim.holders.join("+")}@${i.claim.since.toISOString()}` : "";
  const parent = i.parent ? ` parent=#${i.parent.number}` : "";
  const blockers = i.blockedBy.filter((b) => b.issueState === "OPEN").map((b) => `#${b.number}`);
  const blocked = blockers.length ? ` blockedBy=${blockers.join(",")}` : "";
  return `#${i.number} [${i.state ?? "no-state"}]${claim}${parent}${blocked} ${i.title}`;
}

/** Exactly one line, whatever the tier. With no diagnosis it is byte-identical
 *  to what an empty queue has always printed. */
function emptyQueueLine(blocked: QueueItemWithBlockers[], dx: EmptyQueueReport): string {
  if (dx.diagnosis === "no-items")
    return `queue empty — nothing on the board; intake via /ralph:board or board create --title ...`;
  if (dx.diagnosis === "human-needed")
    return `queue empty — ${dx.humanNeededCount} in Human Needed awaiting answers (/ralph:board walks the queue)`;
  if (dx.diagnosis === "epic-in-flight") {
    const e = dx.inFlightEpics[0];
    const who = e.holder ? ` claimed by ${e.holder}` : " in flight";
    return `queue empty — epic #${e.root} is being worked (child #${e.child}${who})`;
  }
  if (!blocked.length) return "queue empty";
  const stale = dx.diagnosis === "stale-blocked" ? dx.staleBlockedEdges[0] : null;
  const hint = stale
    ? ` — #${stale.number}'s blockers are all resolved on the board; stale edge? board dep ${stale.number} --on ${stale.blockers[0]} --rm`
    : "";
  return `queue empty (${blocked.length} blocked: ${blocked.map((b) => `#${b.number}`).join(" ")}${hint})`;
}

/** The staleness facts that ride alongside every walk-derived CLI payload
 *  (GH-1806). A consumer that must not act on a hint can read `ageSec` and
 *  decide; one that never looks still cannot be harmed, because no write guard
 *  reads this data. `deliver-queue` and `tend-queue` deliberately do NOT carry
 *  it: both fetch live per-item detail on top of the walk, so a single age
 *  number would describe only part of what they returned. */
function cacheFacts(w: WalkStaleness): { cached: boolean; fetchedAt: string; ageSec: number } {
  return { cached: w.cached, fetchedAt: w.fetchedAt, ageSec: w.ageSec };
}

/** Just the staleness half of a walk. These two helpers read nothing that the
 *  QueueSelect varies, so they must not be pinned to one selection — a `next`
 *  walk (no labels) reports its age exactly like a `list` walk does. */
type WalkStaleness = Pick<ItemWalk, "cached" | "fetchedAt" | "ageSec">;

/** One line, only when the answer did not come from the network. Silence on a
 *  fresh read keeps every existing human-output assertion byte-identical. */
function cacheNote(w: WalkStaleness): string | null {
  return w.cached ? `(cached board read, ${w.ageSec}s old — \`--fresh\` forces a walk)` : null;
}

function requireNumber(p: string | undefined, what = "issue number"): number {
  const n = Number(p);
  if (!p || !Number.isInteger(n) || n <= 0) throw new UsageError(`${what} required`);
  return n;
}

const MUTATING = new Set([
  "create", "claim", "release", "move", "cancel", "reopen", "answer", "priority",
  "link", "dep", "comment", "adopt", "reconcile", "parent-check",
  "resolve", "setup",
]);

export function run(argv: string[], ctx: Ctx): number {
  const [cmd, ...rest] = argv;
  const { positional, flags } = parseArgs(rest);
  const out = (s: string) => process.stdout.write(s + "\n");
  const json = (v: unknown) => out(JSON.stringify(v, null, 2));

  // Every command that mutates, by any route. `prune --apply` (GH-1788) is one
  // of them and matters most to the cache: it picks DELETION targets from the
  // walk and then removes those project items, so a stale walk here would
  // delete against a board that no longer looks like that. Its dry run is a
  // read like any other and may be served from cache.
  const writes =
    (MUTATING.has(cmd) && !(cmd === "claim" && positional[0] === "show")) ||
    (cmd === "doctor" && flags.fix) ||
    (cmd === "prune" && flags.apply === true);

  // The write-guard carve-out (GH-1806) and its manual override, both applied
  // before any command body runs. A mutating command reads the board only to
  // decide what to write, so it pays for truth; a read may be bounded-stale.
  if (writes || flags.fresh) ctx = { ...ctx, itemCacheTtlSec: 0 };

  // Scope gate before ANY command that can write — including doctor --fix,
  // which mutates. Plain reads work from any clone (doctor reports scope);
  // `claim show` is a plain read wearing a mutating command's name, so it
  // gets the read path's carve-out.
  if (writes) {
    const remote = ctx.exec(["git", "-C", ctx.repoRoot, "remote", "get-url", "origin"]);
    if (remote.code !== 0 || !scopeMatches(remote.stdout, ctx.cfg.owner, ctx.cfg.repo, ctx.cfg.host)) {
      throw new RefusalError(
        `scope check failed: origin "${remote.stdout.trim()}" does not match configured ` +
          `${ctx.cfg.host}/${ctx.cfg.owner}/${ctx.cfg.repo} — refusing to mutate another repo's board`,
      );
    }
  }

  switch (cmd) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      out(HELP);
      return 0;

    case "get": {
      const issue = fetchIssue(ctx, requireNumber(positional[0]));
      if (flags.json) json(issue);
      else {
        out(issueLine(issue));
        for (const c of issue.children)
          out(`  child #${c.number} [${childStateLabel(c)}] ${c.title}`);
        for (const p of issue.prs) out(`  pr #${p.number} ${p.merged ? "merged" : p.state} ${p.url}`);
      }
      return 0;
    }

    case "name": {
      // The convention is DECLARED in contracts.ts and READ here. Shell
      // transports call this instead of rebuilding slugify in awk — a second
      // copy of the grammar is a second grammar (GH-1807).
      const num = requireNumber(positional[0]);
      const issue = fetchIssue(ctx, num);
      const lane = (typeof flags.lane === "string" ? flags.lane : "w") as Lane;
      if (!LANE_CHARS.includes(lane))
        throw new UsageError(
          `--lane must be one of ${LANE_CHARS.join("|")} (got ${JSON.stringify(flags.lane)})`,
        );
      const kind = branchKindFor(issue.labels, {
        applyLabel: ctx.cfg.apply.enabled ? ctx.cfg.apply.label : null,
        labelsTruncated: issue.labelsTruncated,
      });
      const branch = formatBranchName(kind, num, issue.title);
      const names = {
        number: num,
        title: issue.title,
        kind,
        lane,
        branch,
        worktree: worktreeLeaf(branch),
        agent: formatAgentName(lane, num, issue.title),
        legacyBranch: `feature/GH-${num}`,
      };
      if (flags.json) json(names);
      else {
        out(`branch   ${names.branch}`);
        out(`agent    ${names.agent}`);
        out(`worktree ${names.worktree}`);
      }
      return 0;
    }

    case "list": {
      // Default is the bounded own-repo queue read (GH-1785). --all-repos pays
      // for the full project scan, the only read that can enumerate foreign
      // board items; `foreignEvaluated` says which read answered, so a caller
      // never mistakes "not looked for" for "none there".
      const allRepos = flags["all-repos"] === true;
      const walk = allRepos ? listItemsFull(ctx) : listOwnOpenWalk(ctx);
      const { own, foreign } =
        allRepos ? ownRepo(ctx, walk.open) : { own: walk.open, foreign: [] as QueueItem[] };
      let items = own;
      if (typeof flags.state === "string") {
        const s = parseStateArg(flags.state);
        items = items.filter((i) => i.state === (s ?? flags.state));
      }
      if (flags.json) json({ items, foreign, foreignEvaluated: allRepos, cache: cacheFacts(walk) });
      else {
        for (const i of items) out(`#${i.number} [${i.state}]${i.claim ? ` claim=${i.claim.holders.join("+")}` : ""}${i.openBlockers.length ? ` blockedBy=${i.openBlockers.map((n) => `#${n}`).join(",")}` : ""} ${i.title}`);
        for (const f of foreign) out(`${f.repo}#${f.number} [${f.state}] (foreign repo — read-only here) ${f.title}`);
        if (!allRepos) out(`(own-repo open items; foreign board items not read — \`--all-repos\` scans the whole project)`);
        if (cacheNote(walk)) out(cacheNote(walk)!);
      }
      return 0;
    }

    case "next": {
      // Ranking is blockers + field values; labels are never consulted, so the
      // walk skips that connection (GH-1803).
      const full = listItemsFull(ctx, QUEUE_SELECT_NO_LABELS);
      const own = ownRepo(ctx, full.open).own;
      // Closed own-repo items ride along as pass-through tree edges only.
      const closedEdges = ownRepo(ctx, full.closed).own;
      // The values the ranker will actually rank double as staleness evidence:
      // one it cannot find in the cached options proves the schema moved.
      const order = priorityOptionOrder(ctx, {
        values: own.map((i) => i.priority),
        fresh: flags.fresh === true,
      });
      const { eligible, blocked, inFlightEpics } = rankNext(own, closedEdges, order);
      // --json carries the diagnosis as fields, never as the prose line.
      const dx = diagnoseEmptyQueue(own, eligible, blocked, inFlightEpics);
      if (flags.json) json({ next: eligible[0] ?? null, queue: eligible, blocked, ...dx, cache: cacheFacts(full) });
      else if (eligible.length === 0) {
        // The empty answer is where staleness matters MOST — a loop reads
        // "queue empty" and spawns nothing. It gets told how old that is.
        out(emptyQueueLine(blocked, dx));
        if (cacheNote(full)) out(`  ${cacheNote(full)}`);
      } else {
        const head = eligible[0];
        out(
          `next: #${head.number} ${head.title}` +
            (head.via !== undefined ? ` (under epic #${head.via})` : "") +
            (head.childrenBlocked ? ` (children blocked: ${head.childrenBlocked.map((n) => `#${n}`).join(" ")})` : ""),
        );
        for (const i of eligible.slice(1, 6)) out(`  then #${i.number} ${i.title}`);
        if (cacheNote(full)) out(`  ${cacheNote(full)}`);
        if (blocked.length)
          out(
            `  blocked: ${blocked
              .map((b) => {
                // An empty label list means the blockage is a truncation, not
                // an edge — name it, or the operator hunts a nonexistent dep.
                const why =
                  b.openBlockerLabels.length ? b.openBlockerLabels.join("+")
                  : b.fieldValuesTruncated ? "(field values truncated)"
                  : "(blockers truncated)";
                return `#${b.number}←${why}`;
              })
              .join(" ")}`,
          );
      }
      return 0;
    }

    case "frontier": {
      // EXACTLY next's inputs and ranking — frontier is a re-projection,
      // down to the query selection.
      const full = listItemsFull(ctx, QUEUE_SELECT_NO_LABELS);
      const own = ownRepo(ctx, full.open).own;
      const closedEdges = ownRepo(ctx, full.closed).own;
      const res = frontierView(
        rankNext(
          own,
          closedEdges,
          priorityOptionOrder(ctx, { values: own.map((i) => i.priority), fresh: flags.fresh === true }),
        ),
      );
      if (flags.json) json({ ...res, cache: cacheFacts(full) });
      else if (res.frontier.length === 0) {
        out(
          `frontier empty${res.blocked.length ? ` (${res.blocked.length} blocked: ${res.blocked.map((b) => `#${b.number}`).join(" ")})` : ""}`,
        );
        if (cacheNote(full)) out(cacheNote(full)!);
      } else {
        for (const f of res.frontier)
          out(
            `#${f.number}` +
              (f.via !== undefined ? ` (under epic #${f.via})` : "") +
              (f.blockers.length ? ` [blockers closed: ${f.blockers.map((b) => `#${b.number}`).join(",")}]` : "") +
              ` ${f.title}`,
          );
        if (cacheNote(full)) out(cacheNote(full)!);
        if (res.blocked.length)
          out(
            `blocked: ${res.blocked
              .map((b) => `#${b.number}←${b.truncated ? "(truncated)" : b.blockers_open.map((n) => `#${n}`).join("+")}`)
              .join(" ")}`,
          );
      }
      return 0;
    }

    case "tree": {
      const root = fetchIssue(ctx, requireNumber(positional[0]));
      out(issueLine(root));
      for (const c of root.children) out(`  #${c.number} [${childStateLabel(c)}] ${c.title}`);
      return 0;
    }

    case "deliver-queue": {
      const res = deliverQueue(ctx);
      if (flags.json) json(res);
      else if (!res.next) {
        const why = res.blocked.length
          ? ` (${res.blocked.length} blocked: ${res.blocked
              .map((b) => `#${b.number}${b.pr ? ` pr#${b.pr}` : ""}←${b.reason}`)
              .join(" ")})`
          : "";
        out(`deliver queue empty${why}`);
      } else {
        const rowLine = (r: DeliverRow): string =>
          `#${r.number}${r.pr ? ` pr#${r.pr}` : ""} [${r.reason}${
            r.verdict ? ` ${r.verdict}${r.gate ? ` — ${r.gate}` : ""}` : ""
          }] ${r.title}`;
        out(`deliver next: ${rowLine(res.next)}`);
        for (const r of res.queue.slice(1, 6)) out(`  then ${rowLine(r)}`);
        if (res.blocked.length)
          out(
            `  blocked: ${res.blocked
              .map((b) => `#${b.number}${b.pr ? ` pr#${b.pr}` : ""}←${b.reason}`)
              .join(" ")}`,
          );
      }
      return 0;
    }

    case "tend-queue": {
      const res = tendQueue(ctx);
      if (flags.json) json(res);
      else if (!res.next) out("tend queue empty — one clean sweep");
      else {
        out(`tend next: #${res.next.number} [${res.next.category}]${res.next.title ? ` ${res.next.title}` : ""}`);
        for (const r of res.queue.slice(1, 8))
          out(`  then #${r.number} [${r.category}]${r.title ? ` ${r.title}` : ""}`);
      }
      return 0;
    }

    case "create": {
      if (typeof flags.title !== "string" || !flags.title) throw new UsageError("--title required");
      const state = typeof flags.state === "string" ? parseStateArg(flags.state) : null;
      if (typeof flags.state === "string" && !state) throw new UsageError(`unknown state "${flags.state}"`);
      // A valueless `--priority` parses as boolean true; `--priority ""` (an
      // unset shell variable) parses as an empty string. Silently coercing
      // either to "no priority" would file the very last-sorting item the flag
      // was typed to avoid, so both are usage errors, not defaults. createIssue
      // refuses the empty string as well — this is the message, not the gate.
      if (flags.priority === true || (typeof flags.priority === "string" && flags.priority.trim() === ""))
        throw new UsageError("--priority needs a value (this board's options: `board get` any item, or see `board help`)");
      const issue = createIssue(ctx, {
        title: flags.title,
        body: typeof flags.body === "string" ? flags.body : undefined,
        parent: typeof flags.parent === "string" ? requireNumber(flags.parent, "--parent") : undefined,
        estimate: typeof flags.estimate === "string" ? flags.estimate : undefined,
        priority: typeof flags.priority === "string" ? flags.priority : undefined,
        state: state ?? undefined,
        // --apply resolves the CONFIGURED label rather than a literal, so a
        // repo that renamed it (apply.label) cannot end up with apply units
        // carrying a label none of its own gates recognise.
        labels: (() => {
          const explicit =
            typeof flags.label === "string"
              ? flags.label.split(",").map((l) => l.trim()).filter(Boolean)
              : [];
          if (flags.apply) {
            if (!ctx.cfg.apply.enabled) {
              throw new UsageError(
                "--apply needs the apply kind enabled: add an `apply` block to .github/ralph-merge-policy.json " +
                  "(see `board readiness`). Without it nothing enforces the evidence contract, so the label would be decoration.",
              );
            }
            explicit.push(ctx.cfg.apply.label);
          }
          return explicit.length ? explicit : undefined;
        })(),
      });
      out(issueLine(issue));
      out(issue.url);
      return 0;
    }

    case "priority": {
      const number = requireNumber(positional[0]);
      const value = positional[1];
      if (!flags.clear && !value)
        throw new UsageError("priority NNN <option> (or --clear) required");
      if (flags.clear && value)
        throw new UsageError("--clear takes no priority value");
      const issue = setPriority(ctx, number, flags.clear ? null : value!);
      out(`#${issue.number} priority=${issue.priority ?? "(none)"} ${issue.title}`);
      return 0;
    }

    case "claim": {
      // Fleet subverbs (join/leave/show) ride the same command word the
      // classic single-arg claim uses; a bare number keeps today's behavior.
      const sub = positional[0];
      if (sub === "show") {
        const view = claimShow(ctx, requireNumber(positional[1]));
        if (flags.json) json(view);
        else if (view.claim) {
          out(
            `#${view.number} claim: ${view.claim.holders.join("+")} since ${view.claim.since.toISOString()} ` +
              `(${view.ageMin!.toFixed(0)} min ago, TTL ${view.ttlMin} min, ` +
              `${view.claim.holders.length}/${CLAIM_MAX_HOLDERS} holders${view.stale ? ", STALE" : ""})`,
          );
        } else if (view.claimRaw !== null) {
          out(`#${view.number} claim: GARBLED — raw text ${JSON.stringify(view.claimRaw)} (want "holder[+holder2...]|iso8601")`);
        } else {
          out(`#${view.number}: no claim`);
        }
        return 0;
      }
      if (sub === "join" || sub === "leave") {
        const number = requireNumber(positional[1]);
        if (typeof flags.holder !== "string" || !flags.holder) {
          throw new UsageError(`claim ${sub} requires --holder <agent name>`);
        }
        if (sub === "join") {
          out(issueLine(claimJoin(ctx, number, flags.holder)));
          return 0;
        }
        const { issue: after, changed } = claimLeave(ctx, number, flags.holder);
        out(
          changed
            ? issueLine(after)
            : `#${number}: ${flags.holder} is not a claim holder — no-op`,
        );
        return 0;
      }
      const issue = fetchIssue(ctx, requireNumber(positional[0]));
      const after = transition(ctx, issue, "In Progress", { steal: !!flags.steal });
      out(issueLine(after));
      return 0;
    }

    case "release": {
      if (typeof flags.m !== "string" || !flags.m) throw new UsageError(`release requires -m "<where you stopped and what's next>"`);
      const issue = fetchIssue(ctx, requireNumber(positional[0]));
      const after = transition(ctx, issue, "Backlog", { why: flags.m });
      out(issueLine(after));
      return 0;
    }

    case "move": {
      const issue = fetchIssue(ctx, requireNumber(positional[0]));
      const to = positional[1] ? parseStateArg(positional[1]) : null;
      if (!to) throw new UsageError(`move requires a target state (${STATES.join(" | ")})`);
      const after = transition(ctx, issue, to, { why: typeof flags.why === "string" ? flags.why : undefined });
      out(issueLine(after));
      return 0;
    }

    case "answer": {
      const number = requireNumber(positional[0]);
      const message =
        typeof flags.m === "string" && flags.m ? flags.m
        : typeof flags.message === "string" && flags.message ? flags.message
        : null;
      if (!message) throw new UsageError(`answer requires -m "<the decision>" (--message also accepted)`);
      const res = answer(ctx, number, {
        message,
        anyState: !!flags["any-state"],
        commentOnly: !!flags["comment-only"],
      });
      if (flags.json) json(res);
      else {
        out(
          res.transitioned
            ? `#${number}: answer commented; Human Needed → ${res.state}`
            : `#${number}: answer commented; no transition (state: ${res.state ?? "(none)"})`,
        );
      }
      return 0;
    }

    case "cancel": {
      if (typeof flags.m !== "string" || !flags.m) throw new UsageError(`cancel requires -m "<reason>"`);
      const issue = fetchIssue(ctx, requireNumber(positional[0]));
      const after = transition(ctx, issue, "Canceled", { why: flags.m });
      out(issueLine(after));
      return 0;
    }

    case "reopen": {
      const issue = fetchIssue(ctx, requireNumber(positional[0]));
      const after = transition(ctx, issue, "Backlog", { isReopen: true });
      // Reopening IS the acceptance of a `reopen-as-unevidenced` proposal, and
      // it is the one disposition the classifier cannot infer afterwards: the
      // item is open again, so the "answered by the close" rule no longer
      // applies and the marker would read as pending forever. Record it.
      // Best-effort by construction — the reopen already happened, and a
      // failure to annotate it must not report the reopen as failed.
      try {
        const p = resolveProposal(ctx, issue, "accepted", "Resolved by `board reopen`.");
        if (p) out(`resolved the pending tend proposal on #${issue.number} (accepted)`);
      } catch (e) {
        process.stderr.write(
          `warn: reopened #${issue.number}, but could not resolve its tend proposal: ${(e as Error).message}\n`,
        );
      }
      out(issueLine(after));
      return 0;
    }

    case "resolve": {
      // Validate the intent before spending a read: exactly one disposition,
      // and a rejection must say why (it is the disposition nothing else on the
      // board records, so the comment IS the record).
      const number = requireNumber(positional[0]);
      const reject = !!flags.reject;
      if (reject === !!flags.accept)
        throw new UsageError(`resolve requires exactly one of --accept / --reject`);
      const note = typeof flags.m === "string" && flags.m ? flags.m : undefined;
      if (reject && !note)
        throw new UsageError(`resolve --reject requires -m "<why not>" — a rejection with no reason reads as a bug`);
      const p = resolveProposal(ctx, fetchIssue(ctx, number), reject ? "rejected" : "accepted", note);
      if (!p) {
        out(`#${number} has no pending tend proposal — nothing to resolve`);
        return 1;
      }
      out(`#${number}: tend proposal ${reject ? "rejected" : "accepted"}${p.at ? ` (proposed ${p.at})` : ""}`);
      return 0;
    }

    case "link": {
      const parent = requireNumber(positional[0], "parent number");
      const child = requireNumber(positional[1], "child number");
      linkParent(ctx, parent, child);
      out(`#${child} is now a sub-issue of #${parent}`);
      return 0;
    }

    case "dep": {
      const blocked = requireNumber(positional[0]);
      const blocking = requireNumber(typeof flags.on === "string" ? flags.on : undefined, "--on <blocking issue>");
      setDependency(ctx, blocked, blocking, !!flags.rm);
      out(`#${blocked} ${flags.rm ? "no longer" : "is"} blocked by #${blocking}`);
      return 0;
    }

    case "comment": {
      if (typeof flags.m !== "string" || !flags.m) throw new UsageError(`comment requires -m "<body>"`);
      const number = requireNumber(positional[0]);
      addComment(ctx, fetchNodeIds(ctx, [number]).get(number)!, flags.m);
      out(`commented on #${number}`);
      return 0;
    }

    case "adopt": {
      const issue = adopt(ctx, requireNumber(positional[0]));
      out(issueLine(issue));
      return 0;
    }

    case "reconcile": {
      out(reconcile(ctx, requireNumber(positional[0])));
      return 0;
    }

    case "parent-check": {
      out(parentCheck(ctx, requireNumber(positional[0])));
      return 0;
    }

    case "doctor": {
      const report = doctor(ctx, { fix: !!flags.fix, strict: !!flags.strict });
      if (flags.json) json(report);
      else {
        for (const c of report.checks)
          out(
            `${c.level === "ok" ? "✓" : c.level === "info" ? "i" : c.level === "warn" ? "⚠" : "✗"} ` +
              `${c.name}: ${c.detail}`,
          );
        out(report.ok ? "doctor: OK" : "doctor: FAIL");
      }
      return report.ok ? 0 : 1;
    }

    case "setup": {
      // Notes stream as they are produced — a mid-run throw still leaves
      // everything done so far on the record. Verification decides the exit.
      return setup(ctx, out).ok ? 0 : 1;
    }

    case "readiness": {
      const report = readiness(ctx);
      if (flags.json) {
        json(report);
        return 0;
      }
      out(`agent readiness — ${report.repo}`);
      for (const lvl of [1, 2, 3] as const) {
        const cs = report.checks.filter((c) => c.level === lvl);
        const gaps = cs.filter((c) => c.status === "miss").length;
        out(`\nLevel ${lvl} · ${READINESS_LEVELS[lvl]} — ${gaps === 0 ? "ready" : `${gaps} gap${gaps === 1 ? "" : "s"}`}`);
        for (const c of cs) {
          out(`  ${c.status === "ok" ? "✓" : c.status === "miss" ? "·" : "i"} ${c.name}: ${c.detail}`);
          if (c.recommend) out(`      → ${c.recommend}`);
        }
      }
      out(
        report.readyFor === 0
          ? `\nnot ready yet — start with the Level 1 recommendations above`
          : `\nready for: Level ${report.readyFor} — ${READINESS_LEVELS[report.readyFor]}`,
      );
      out("recommendations are advisory — adopt what fits this repo; nothing here blocks work");
      return 0; // advisory by design: a gap is a recommendation, not a failure
    }

    case "prune": {
      const full = listItemsFull(ctx);
      const own = ownRepo(ctx, full.open).own;
      const closedOwn = ownRepo(ctx, full.closed).own;
      const vol = volumeReport(full, ctx.cfg.volume);
      const report = classifyPrune(own, closedOwn, ctx.cfg, ctx.now());
      const applying = !!flags.apply;
      const limit = pruneLimit(flags.limit);
      const selected = applying ? report.candidates.slice(0, limit) : report.candidates;
      const text = !flags.json;

      // Deciding WHAT to do and choosing HOW to render it are orthogonal, and
      // the two must never interleave: the first cut returned early on --json
      // and so silently no-opped `--apply --json`, reporting `applied: false`
      // with exit 0 to exactly the caller least able to notice — automation.
      // The apply decision is made once, below, on every rendering path.
      if (text) {
        out(
          `board volume: ${vol.items} items = ${vol.pages} page(s) per full scan ` +
            `(${vol.open} open, ${vol.closed} closed` +
            `${vol.archived ? `, ${vol.archived} archived` : ""}` +
            `${vol.nonIssue ? `, ${vol.nonIssue} non-issue` : ""}) — threshold ${vol.maxItems}`,
        );
        if (vol.nonIssue) {
          out(
            `  note: ${vol.nonIssue} scanned node(s) are pull requests or drafts — paged for on every ` +
              `scan, never read by board.ts, and NOT prunable here (prune only removes closed issues).`,
          );
        }
      }

      if (report.candidates.length === 0) {
        if (text) {
          const counts = new Map<PruneRetention, number>();
          for (const r of report.retained) counts.set(r.reason, (counts.get(r.reason) ?? 0) + 1);
          out(
            `nothing to prune: ${report.scanned} closed item(s) all still read by something — ` +
              [...counts].map(([r, n]) => `${r} ${n}`).join(", "),
          );
        } else {
          json({ volume: vol, ...report, applied: applying, limit, attempted: 0, removed: 0, failed: [], abortedAfterConsecutiveFailures: false });
        }
        return 0;
      }

      // A destructive command shows its work: the same listing appears whether
      // this run is a rehearsal or the real thing.
      if (text) {
        for (const c of selected.slice(0, 20)) {
          out(`  #${c.number} ${c.state} closed ${c.closedAt.slice(0, 10)} (${c.ageDays}d)`);
        }
        if (selected.length > 20) out(`  … and ${selected.length - 20} more`);
        out(
          `\n${report.candidates.length} of ${report.scanned} closed item(s) are removable: closed ≥${ctx.cfg.volume.pruneAfterDays}d, ` +
            `board state already terminal, no open item's tree passes through them.`,
        );
      }

      if (!applying) {
        if (text) {
          out(
            `\nDRY RUN. \`board prune --apply\` removes them FROM THE PROJECT ONLY — ` +
              `the GitHub issue keeps everything of its own: title, body, comments, labels, closed state.\n` +
              `What a removal destroys is the BOARD ITEM: its Workflow State and Claim field values go with ` +
              `it, and re-adding the issue to the project later does not bring them back. If such an issue ` +
              `is ever reopened it comes back off-board, and doctor's reconcile re-adopts it to Backlog.` +
              (report.candidates.length > limit
                ? `\nOne sweep removes at most ${limit} (--limit); the rest need another run.`
                : ""),
          );
        } else {
          json({ volume: vol, ...report, applied: false, limit });
        }
        return 0;
      }

      const result = applyPrune(ctx, selected);
      if (!text) {
        json({
          volume: vol,
          ...report,
          applied: true,
          limit,
          attempted: result.attempted,
          removed: result.removed,
          failed: result.failed,
          abortedAfterConsecutiveFailures: result.aborted,
        });
        return result.failed.length ? 1 : 0;
      }
      out(
        `\nremoved ${result.removed} of ${result.attempted} attempted item(s) from the project; ` +
          `the issues are untouched`,
      );
      if (report.candidates.length > selected.length) {
        out(
          `${report.candidates.length - selected.length} candidate(s) left for the next run (--limit ${limit})`,
        );
      }
      if (result.aborted) {
        out(
          `ABORTED after ${PRUNE_MAX_CONSECUTIVE_FAILURES} consecutive failures — ` +
            `refusing to keep spending mutations against a wall (rate limit? revoked scope?).`,
        );
      }
      if (result.failed.length) {
        for (const f of result.failed.slice(0, 10)) out(`  failed: ${f}`);
        if (result.failed.length > 10) out(`  … and ${result.failed.length - 10} more failures`);
        return 1;
      }
      return 0;
    }

    case "contract": {
      const sub = positional[0];
      if (sub === "validate") {
        const id = requireContractId(positional[1]);
        const res = validateContract(id, readContractPayload(positional[2]));
        if (res.success) {
          out(`✓ ${id}: valid (producer schema)`);
          return 0;
        }
        out(`✗ ${id}: INVALID — ${res.error.issues.length} issue(s)`);
        for (const i of res.error.issues) out(`  ✗ ${i.path.join(".") || "(root)"}: ${i.message}`);
        return 1;
      }
      if (sub === "emit") {
        const dir =
          typeof flags.out === "string" ? flags.out : join(ctx.repoRoot, CONTRACTS_OUT_DEFAULT);
        mkdirSync(dir, { recursive: true });
        const schemas = emitJsonSchemas();
        for (const id of CONTRACT_IDS) {
          const file = join(dir, `${id}.schema.json`);
          writeFileSync(file, JSON.stringify(schemas[id], null, 2) + "\n");
          out(file);
        }
        return 0;
      }
      if (sub === "lint") {
        const id = requireContractId(positional[1]);
        const payload = readContractPayload(positional[2]);
        let failed = 0;
        // The id is a cross-check, not a router (lints self-select by payload
        // shape) — but a payload declaring a DIFFERENT contract is already a
        // finding, whatever the individual rules say.
        const declared = (payload as Record<string, unknown> | null)?.contract;
        if (typeof declared === "string" && declared !== id) {
          failed++;
          out(`✗ payload declares contract "${declared}", not "${id}"`);
        }
        for (const r of runLints(payload, flags.live ? liveLintDeps(ctx) : undefined)) {
          if ("skipped" in r) {
            out(`- ${r.rule}: skipped (${r.skipped})`);
          } else if (r.ok) {
            out(`✓ ${r.rule}${r.note ? ` (${r.note})` : ""}`);
          } else {
            failed++;
            out(`✗ ${r.rule}: ${r.message}`);
          }
        }
        out(failed === 0 ? "lint: OK" : `lint: FAIL (${failed})`);
        return failed === 0 ? 0 : 1;
      }
      throw new UsageError(`contract requires validate | emit | lint — run \`board help\``);
    }

    default:
      throw new UsageError(`unknown command "${cmd}" — run \`board help\``);
  }
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

// Robust against relative argv[1] (npm scripts) and symlinked paths — a
// false-negative here would make the CLI exit 0 silently doing nothing.
const isMain = (() => {
  if (typeof process.argv[1] !== "string") return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
})();

if (isMain) {
  try {
    const repoRoot = findRepoRoot(process.cwd());
    const cfg = loadConfig(repoRoot);
    const ctx: Ctx = {
      exec: realExec,
      cfg,
      repoRoot,
      cacheDir: join(homedir(), ".ralph", "cache"),
      now: () => new Date(),
      itemCacheTtlSec: parseItemCacheTtlSec(process.env.RALPH_ITEM_CACHE_TTL_SEC),
    };
    process.exit(run(process.argv.slice(2), ctx));
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`usage: ${e.message}\n`);
      process.exit(64);
    }
    if (e instanceof RefusalError) {
      process.stderr.write(`refused: ${e.message}\n`);
      process.exit(2);
    }
    process.stderr.write(`error: ${(e as Error).message}\n`);
    process.exit(1);
  }
}
