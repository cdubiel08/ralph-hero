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
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BOARD_STATES,
  BRANCH_KIND_CHARS,
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
  type Lane,
  LANE_CHARS,
  type LiveLintDeps,
  parseClaim,
  peerPrefix,
  removeHolder,
  resolvePeerAddress,
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
 *  on in-flight work: an answered item resumes back to In Progress via the
 *  RESUMING session's `board claim` (GH-2204 — `answer` posts the decision,
 *  the driver takes the edge). A proposal about an unstarted item is
 *  terminal-answered, not resumed — it files as a
 *  `<!-- ralph-tend:v1 proposed -->` marker comment (surfaced by
 *  `tend-queue`), not as a state. */
export const MACHINE: Record<State, readonly State[]> = {
  // Intake (GH-2077) is strictly one-way. Approval IS the `Intake → Backlog`
  // transition, gated on Priority + Estimate below: Backlog means
  // approved-and-ready, and an approval that lands an unrankable item just
  // recreates the null-priority sink `next` already sorts last.
  //
  // `Backlog → Intake` is deliberately NOT legal, on the argument
  // `Backlog → Human Needed` already lost: a demotion edge is a way to hide
  // work from the queue. Scope that collapses under review is Canceled plus a
  // fresh Intake item. The edge can be added later if a real need shows; it
  // cannot be cheaply removed once scripts lean on it.
  //
  // `Intake → In Progress` is NOT legal either, which is what makes
  // `board claim` on an Intake item refuse via the MACHINE — no special code,
  // no second predicate to forget. Approval cannot be skipped by claiming.
  Intake: ["Backlog", "Canceled"],
  Backlog: ["In Progress", "Done", "Canceled"],
  // In Progress → Done is legal for the same reason Backlog → Done is
  // (GH-1777): the Done evidence gates key on the DESTINATION, so a unit whose
  // completion is not a PR — an apply unit closing on its evidence comment, a
  // decision unit closing on its recorded artifact — closes through the gated
  // lane instead of laundering through a fictional In Review hop that drops
  // its --why. Nothing is weakened: the gates run identically on every edge
  // into Done.
  "In Progress": ["In Review", "Done", "Human Needed", "Backlog", "Canceled"],
  "In Review": ["Done", "In Progress", "Human Needed", "Canceled"],
  // `Human Needed → Backlog` removed (GH-2078): an answered item RESUMES
  // (`→ In Progress`, the resuming session's `board claim` — GH-2204) or
  // DIES (`→ Canceled`). A
  // parking edge out of an escalation is a way to lose the question — the
  // item re-enters the eligible pool and the next claimant re-derives the
  // very context the escalation existed to hand over. "Answered: not now"
  // is recorded but NOT decided (possibly `→ Intake` once judged); it does
  // not resurrect this edge in the meantime.
  "Human Needed": ["In Progress", "Canceled"],
  Done: [],
  Canceled: [],
};

/** Legacy (v1) states. The 11→6 collapse ran in GH-1662; these linger as
 *  Workflow State field options that `setup` deliberately does not delete —
 *  removing an option clears the Workflow State of every item still holding
 *  it — so `doctor` and `setup` surface them for a human instead. */
export const LEGACY_STATES = [
  "Research Needed",
  "Research in Progress",
  "Ready for Plan",
  "Plan in Progress",
  "Plan in Review",
] as const;

/** Best-effort sync to the built-in Status field (UI coherence only). */
export const STATUS_SYNC: Record<State, string> = {
  Intake: "Todo",
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
    intake: "Intake",
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
export { CLAIM_MAX_HOLDERS, formatClaim, heartbeat, isMember, parseClaim, removeHolder } from "./contracts.js";

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
// ---------------------------------------------------------------------------
// Defer — "the precondition is not met" as a typed, parking write lane.
// The mark lives in a project TEXT field ("Defer"), which rides the
// fieldValues page every walk already pays for — zero extra GraphQL cost,
// visible as a board column, and never a label (rankNext's eligibility is a
// function of dependency edges and field values, never labels — GH-1803).
// Value grammar mirrors Claim's: `{recheck-iso|-}|{condition}`.
// ---------------------------------------------------------------------------

export interface DeferMark {
  recheck: Date | null; // when to look again; null = no date, condition-only
  condition: string; // the observable the item waits on
}

export function parseDefer(raw: string | null | undefined): DeferMark | null {
  if (!raw || !raw.trim()) return null;
  const idx = raw.indexOf("|");
  if (idx < 0) return { recheck: null, condition: raw.trim() };
  const iso = raw.slice(0, idx).trim();
  const t = new Date(iso).getTime();
  return {
    recheck: iso !== "-" && Number.isFinite(t) ? new Date(iso) : null,
    condition: raw.slice(idx + 1).trim(),
  };
}

export function formatDefer(m: DeferMark): string {
  return `${m.recheck ? m.recheck.toISOString() : "-"}|${m.condition}`;
}

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
  /** Project-item id in OUR project — what a field write addresses (GH-2130).
   *  A plain field on the walk document, so it costs nothing (cost is per
   *  CONNECTION, GH-1803). Optional so pure-ranking fixtures stay terse; the
   *  bulk field write fails closed on its absence rather than guessing. */
  itemId?: string | null;
  claim: Claim | null;
  claimRaw: string | null; // raw Claim text — non-null with claim null = garbled (hand-edited)
  /** Defer mark ("the precondition is not met") — a deferred item never
   *  ranks. Optional so pure-ranking fixtures stay terse; every walk
   *  populates it (the field rides the same fieldValues page). */
  defer?: DeferMark | null;
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
/** Null ranks LAST, deliberately (GH-1796). Defaulting it to a mid rank would
 *  fabricate a judgment nobody made — a null item would tie a deliberate P2 and
 *  win the head on the issue-number tie-break for being older. The tail is made
 *  visible by tend's `unformed` category rather than by a ranking default, and
 *  inheritance still lets a parent chain assert a rank on a null item's behalf. */
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
  deferred: QueueItemWithBlockers[];
} {
  // A deferred item never ranks — its stated precondition is not met, and
  // re-dispatching it burns a session to rediscover that. Returned as its own
  // bucket, not folded into `blocked`: a defer is a judgment on the record
  // (`board defer --clear` lifts it), while blocked is a dependency fact.
  const deferred = items.filter((i) => i.state === "Backlog" && !i.claim && i.defer);
  const backlog = items.filter((i) => i.state === "Backlog" && !i.claim && !i.defer);
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
    // does not exist, for as long as the corrective cron stays broken. Intake
    // is the same shape one step earlier (GH-2077): it is UPSTREAM of Backlog,
    // not past it, so an unapproved child must not suppress its epic root —
    // that would hide the root behind work nobody has approved, and the
    // "in-flight epic" line would name a holder that cannot exist.
    const inFlight = desc.find(
      (d) => (!UNSTARTED_BOARD_STATES.has(d.state) && !TERMINAL_BOARD_STATES.has(d.state)) || d.claim,
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
  return { eligible, blocked, inFlightEpics, deferred };
}

/** A blocked item whose every open blocker the board itself calls finished. */
export interface StaleBlockedEdge {
  number: number;
  blockers: number[]; // the open-on-GitHub, terminal-on-board blockers
}

export interface EmptyQueueReport {
  diagnosis: "no-items" | "human-needed" | "epic-in-flight" | "stale-blocked" | "all-deferred" | null;
  humanNeededCount: number;
  staleBlockedEdges: StaleBlockedEdge[];
  inFlightEpics: InFlightEpic[];
  deferredCount: number;
}

/** Board states that assert the work is finished; an item parked here still
 *  open on GitHub is the contradiction a stale blocked edge is made of. */
const TERMINAL_BOARD_STATES = new Set(["Done", "Canceled"]);
/** States that are BEFORE work, not during it: Backlog (approved, unstarted)
 *  and Intake (not yet approved). The epic ranker's in-flight probe keys on
 *  this rather than on `!== "Backlog"` — see rankNext. */
const UNSTARTED_BOARD_STATES = new Set(["Backlog", "Intake"]);

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
  deferred: QueueItemWithBlockers[] = [],
): EmptyQueueReport {
  const humanNeededCount = items.filter((i) => i.state === "Human Needed").length;
  const deferredCount = deferred.length;
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
    : deferredCount > 0 && blocked.length === 0 ? "all-deferred"
    : null;
  return { diagnosis, humanNeededCount, staleBlockedEdges, inFlightEpics, deferredCount };
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
  foreign: ForeignRepoPolicy; // GH-1815: may items from other repos live on this board at all
  prOrphans: PrOrphanPolicy; // GH-2048: whose unlinked open PRs are worth surfacing
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

/** Write the .ralph.json `board bootstrap` runs from (audit C2). Refuses to
 *  overwrite: there is no --force anywhere in this CLI, and a config that
 *  already exists is edited by hand, not clobbered by a bring-up command. */
export function writeBootstrapConfig(repoRoot: string, flags: Record<string, unknown>): string {
  const owner = typeof flags.owner === "string" ? flags.owner.trim() : "";
  const repo = typeof flags.repo === "string" ? flags.repo.trim() : "";
  const project = Number(flags.project);
  if (!owner || !repo || !Number.isInteger(project) || project <= 0) {
    throw new UsageError(
      "bootstrap requires --owner <owner> --repo <repo> --project <number> (optional --host <ghe-host>)",
    );
  }
  const path = join(repoRoot, ".ralph.json");
  if (existsSync(path)) throw new UsageError(`${path} already exists — edit it by hand instead of re-bootstrapping`);
  const host = typeof flags.host === "string" && flags.host ? { host: flags.host } : {};
  writeFileSync(path, JSON.stringify({ owner, repo, projectNumber: project, ...host }, null, 2) + "\n");
  return path;
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
        "(RALPH_GH_OWNER, RALPH_GH_REPO, RALPH_GH_PROJECT_NUMBER). " +
        "New here? `board bootstrap --owner <o> --repo <r> --project <n>` writes .ralph.json and provisions the board.",
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
    foreign: parseForeignRepoPolicy(),
    prOrphans: parsePrOrphanPolicy(),
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
  intakeDays: number; // GH-2077: days an Intake item has waited for an approval decision
  answerMin: number; // GH-2204: minutes an answered Human Needed item has sat unresumed
}

export const SMELL_DEFAULTS: Readonly<SmellThresholds> = Object.freeze({
  claimExpiries: 2,
  escalations: 3,
  reviewDays: 7,
  proposalDays: 7,
  // Deliberately the longest default here: an unapproved item is not a
  // failure, it is a decision nobody has needed to make yet. Two weeks is the
  // point at which "nobody has looked" becomes the likelier reading than
  // "nobody has needed to".
  intakeDays: 14,
  // Minutes, not days: a live agent resumes within seconds of the nudge, so
  // an answered item still Human Needed half an hour later means the driver
  // is dead and someone has to claim it. Doctor's cron ceiling is tens of
  // minutes (GH-1703), so a tighter default would fire on items the sweep
  // simply hadn't seen yet.
  answerMin: 30,
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
    intakeDays: positive("RALPH_SMELL_INTAKE_DAYS", SMELL_DEFAULTS.intakeDays),
    answerMin: positive("RALPH_SMELL_ANSWER_MIN", SMELL_DEFAULTS.answerMin),
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
  // ~8 pages. "Comfortably above a healthy working board" was true when this
  // was chosen and is not any more (GH-2052): #2050 swept 763 PR/draft items
  // out, so the count now measures real issues only, and this repo's live
  // board sits just above 800 with nothing prunable. It cannot be otherwise —
  // `pruneAfterDays` sets a floor of one retention window of closed work
  // (~840 items at this repo's throughput), so no constant below that floor is
  // reachable by the remedy the line names. The number therefore marks where
  // pruning becomes worth RECOMMENDING once anything is prunable, not a size a
  // board stays under; the doctor line's severity carries the difference.
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

// ---------------------------------------------------------------------------
// Unlinked open PRs (GH-2048) — the one class of work no board surface sees.
//
// Every selector here is keyed on the board: `next`/`frontier` rank issues,
// `deliver-queue` selects In Review items, `doctor` sweeps board invariants.
// An open PR that references no issue is on none of those surfaces, so it is
// not merely unranked — it is unseeable, and an empty queue renders exactly
// like a queue that is empty because its work never reached the board. Three
// PRs sat that way for up to 23 days.
//
// This is a SELECTOR, not a gate. It never files an issue (that would convert
// a human's exploratory branch into board work without their say) and never
// blocks `gh pr create` (GH-1717's stated reason for observing rather than
// redirecting is unchanged: there is no sanctioned alternative to redirect to).
// Honest limit: making orphans visible does not make anyone look at them.
// ---------------------------------------------------------------------------

/** Whose unlinked PRs are noise rather than work.
 *
 *  Bots that open PRs on their own lifecycle — dependabot, renovate — will
 *  never carry a closing reference and are triaged by merging or closing them,
 *  not by adopting them onto a board. Left in, they would be a dozen standing
 *  rows and the line would be ignored, which is the failure mode this whole
 *  issue is about. */
export interface PrOrphanPolicy {
  ignoreAuthors: string[]; // lowercased logins whose orphan PRs are not surfaced
  configured: boolean; // false = the defaults below, nothing was set
}

export const PR_ORPHAN_IGNORE_ENV = "RALPH_PR_ORPHAN_IGNORE_AUTHORS";

export const PR_ORPHAN_DEFAULT_IGNORE: readonly string[] = Object.freeze([
  "dependabot",
  "renovate",
  "github-actions",
]);

/** A bot login has TWO spellings and they are not interchangeable — measured,
 *  not assumed: GraphQL's `author.login` returns `dependabot` while REST, the
 *  web UI and every doc write `dependabot[bot]`. The first draft of this list
 *  used the suffixed form and matched nothing, leaving all 12 of this repo's
 *  dependabot PRs standing in the line — the exact "a dozen rows and nobody
 *  reads it" failure the whole check was designed to avoid. So the suffix is
 *  stripped on BOTH sides and an operator may write either form. */
export function normalizeBotLogin(login: string): string {
  return login.trim().toLowerCase().replace(/\[bot\]$/, "");
}

/** Comma-separated logins. An explicitly EMPTY value means "ignore nobody" —
 *  distinct from unset, which takes the defaults — so a repo that wants its
 *  bot PRs surfaced can say so without inventing a sentinel. */
export function parsePrOrphanPolicy(
  env: Record<string, string | undefined> = process.env,
): PrOrphanPolicy {
  const raw = env[PR_ORPHAN_IGNORE_ENV];
  if (raw === undefined)
    return { ignoreAuthors: [...PR_ORPHAN_DEFAULT_IGNORE], configured: false };
  return {
    ignoreAuthors: raw.split(",").map(normalizeBotLogin).filter(Boolean),
    configured: true,
  };
}

// ---------------------------------------------------------------------------
// Foreign-repo posture (GH-1815) — multi-repo is opt-in, never implicit.
//
// The board is repo-blind by construction: the walk is rooted at
// ProjectV2.items, so an item from ANY repository lands in the result and is
// partitioned after the fact by ownRepo(). Nothing in GitHub prevents one from
// being added. This posture says whether that is permitted at all.
//
// It exists for GH-1814, which narrows the read path to a repo-scoped walk.
// That narrowing is sound only if foreign items cannot be introduced — a
// foreign item on a board nobody scans for foreign items is INVISIBLE, which
// is strictly worse than today's visible-but-partitioned behaviour.
//
// Honest limit, the same shape as the apply close gate: GitHub has no pre-add
// hook, so a human, the Projects UI or another automation can still place a
// foreign item on the board. board.ts refuses to be the one that does it, and
// doctor's full-project sweep is the periodic audit that catches the rest.
// That division is the point: the hot path may be repo-scoped precisely
// because doctor still walks the whole project.
// ---------------------------------------------------------------------------

export const FOREIGN_REPO_ENV = "RALPH_ALLOW_FOREIGN_REPO_ITEMS";

/** `configured` is not decoration: "nobody has decided" and "somebody decided
 *  deny" are different postures, and doctor reports which one is in effect so
 *  an operator can tell a default they inherited from a choice they made. */
export interface ForeignRepoPolicy {
  allow: boolean;
  configured: boolean;
}

/** Unlike the smell and volume thresholds, this one gates a WRITE, so an
 *  unreadable value may not degrade to "whatever the default was" quietly —
 *  it fails closed AND says so. Empty reads as unset (an exported-but-empty
 *  shell variable is the commonest way to arrive here, and it is not a
 *  decision), which costs nothing: both postures deny. */
export function parseForeignRepoPolicy(
  env: Record<string, string | undefined> = process.env,
): ForeignRepoPolicy {
  const raw = env[FOREIGN_REPO_ENV];
  if (raw === undefined || raw.trim() === "") return { allow: false, configured: false };
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return { allow: true, configured: true };
  if (["0", "false", "no", "off"].includes(v)) return { allow: false, configured: true };
  process.stderr.write(
    `warn: ${FOREIGN_REPO_ENV}=${JSON.stringify(raw)} is not a boolean — denying foreign-repo items\n`,
  );
  return { allow: false, configured: true };
}

/** The `owner/repo` an issue URL says the issue lives in, or null if the URL
 *  is not one we can read. Host-agnostic (GHE lives under a different host,
 *  same path shape). */
export function repoFromIssueUrl(url: string): string | null {
  const m = /^https?:\/\/[^/]+\/([^/\s]+)\/([^/\s]+)\/issues\/\d+/.exec(url);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** The one gate between board.ts and placing an item on the board.
 *
 *  Audited 2026-08-14 (GH-1815): both add-to-project call sites are own-repo
 *  BY CONSTRUCTION — `createIssue` writes into `cache.repositoryId` and
 *  `adopt` resolves through `fetchIssue`, whose query is pinned to
 *  cfg.owner/cfg.repo, while `requireNumber` accepts a bare integer only. So
 *  this is an ASSERTION, not a filter: it currently refuses nothing. It ships
 *  anyway so that a future add path which is NOT own-repo trips here instead
 *  of silently making GH-1814's repo-scoped walk incomplete — the audit
 *  written down as code rather than as a comment that rots.
 *
 *  It is checked at the MUTATION, not at the verb, because a verb-level check
 *  is one refactor away from being routed around. And it keys on the URL
 *  GitHub returned in the same response as the node id being added — comparing
 *  `${cfg.owner}/${cfg.repo}` against itself would assert nothing. */
export function assertBoardAddAllowed(ctx: Ctx, url: string, number: number): void {
  if (ctx.cfg.foreign.allow) return;
  const self = `${ctx.cfg.owner}/${ctx.cfg.repo}`;
  const repo = repoFromIssueUrl(url);
  // Fails closed on an unreadable URL: it arrives in the same response as the
  // node id about to be added, so not being able to read it means not knowing
  // what is being added — and the blast radius is `adopt`/`create` alone.
  if (repo === null)
    throw new RefusalError(
      `cannot read the repository from issue URL ${JSON.stringify(url)}, so #${number} cannot be ` +
        `confirmed to belong to ${self}. Foreign-repo items are denied on this board; ` +
        `set ${FOREIGN_REPO_ENV}=true to permit them.`,
    );
  if (repo.toLowerCase() !== self.toLowerCase())
    throw new RefusalError(
      `#${number} belongs to ${repo}, not ${self}. Foreign-repo items are denied on this board ` +
        `(multi-repo is opt-in): set ${FOREIGN_REPO_ENV}=true to permit them. ` +
        `Items already on the board are never removed by this refusal — \`board doctor\` lists them.`,
    );
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
/** Temporary failure — exit 75 (EX_TEMPFAIL): "wait and re-run", never "this
 *  request is malformed". Rate limits and lane budget deferrals land here so
 *  a caller can distinguish backing off from being wrong (the gh-budget.sh
 *  exit-4 typing, extended into board.ts's own error surface — audit B2). */
export class TransientError extends Error {
  constructor(
    message: string,
    public readonly resetAt: string | null = null,
  ) {
    super(message);
  }
}

/** Synchronous nap for the transport retry — reads only, bounded, jittered. */
function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Transport-shaped failure: the request may never have reached GitHub, so a
 *  READ is safe to retry. An HTTP error body or GraphQL errors are NOT
 *  transport — those answers are real and retrying them is spend. */
const TRANSPORT_RE =
  /\b(i\/o timeout|timed? ?out|connection (reset|refused|closed)|TLS handshake|unexpected EOF|temporary failure|no such host|network is unreachable|could not resolve host)\b/i;

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
  /** T_max for the change oracle, seconds (GH-1804). 0 (and absent) disables
   *  it, leaving Δ as the only window — the same fail-safe default direction
   *  as the TTL above, and for the same reason. */
  itemOracleMaxSec?: number;
  /** Session→unit binding (GH-1948): who this process is, and where the
   *  binding records live. Absent — like a null `id` — leaves the guard
   *  inert, which is the honest reading of "this runner told us nothing"
   *  rather than a policy choice (see guardSessionUnit). */
  session?: { id: string | null; dir: string };
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

/** One ledger line per spending invocation (audit B2): attribution was the
 *  actual blocker in the 5000-pt exhaustion incident — the burner was
 *  invisible to every transcript. Best-effort by construction: a failed
 *  append must never fail the command that did the real work. */
export function appendBudgetLedger(cmd: string, now: Date): void {
  if (gqlCost.calls === 0) return;
  try {
    const dir = join(process.env.RALPH_HOME || join(homedir(), ".ralph"), "");
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      join(dir, "budget.jsonl"),
      JSON.stringify({ at: now.toISOString(), cmd, calls: gqlCost.calls, points: gqlCost.points }) + "\n",
    );
  } catch {
    /* best-effort */
  }
}

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
  // Instrumentation is on by default (measured cost-neutral, GH-1801):
  // the per-invocation ledger below needs the numbers even when nobody is
  // watching stderr. RALPH_GQL_COST=0 disables; =1 additionally narrates.
  const measuring = process.env.RALPH_GQL_COST !== "0";
  const narrate = process.env.RALPH_GQL_COST === "1";
  const sent = measuring ? instrumentQuery(query) : { query, instrumented: false };
  // Read-your-writes, half one (GH-1806): mark BEFORE the wire, because a
  // mutation that lands and then fails to report back (non-zero exit,
  // unparseable body, dropped connection) has still happened. Marking only on
  // success would leave exactly that case serving a pre-write view.
  const mutating = isMutationOp(query);
  if (mutating) markLocalWrite(ctx);
  // --hostname keeps API traffic on the same host the scope gate verified —
  // a GHE config must not silently query github.com.
  const argv = ["gh", "api", "graphql", "--hostname", ctx.cfg.host, "--input", "-"];
  const payload = JSON.stringify({ query: sent.query, variables });
  let r = ctx.exec(argv, payload);
  // Bounded jittered retry on TRANSPORT failures, reads only (audit B2): a
  // TLS flap and a refusal must stop being indistinguishable, and the ad-hoc
  // remedy was hand-typed sleeps. Mutations never retry — GH-1973's read-back
  // over retry choice stands, and mutationCache's no-replay rule with it.
  for (let attempt = 0; r.code !== 0 && !mutating && attempt < 2; attempt++) {
    const said = `${r.stderr} ${r.stdout}`;
    if (!TRANSPORT_RE.test(said)) break;
    sleepMs(200 * (attempt + 1) + Math.floor(Math.random() * 150));
    r = ctx.exec(argv, payload);
  }
  if (r.code !== 0) {
    const said = (r.stderr.trim() || r.stdout.trim());
    // gh already failed on the limit: still typed 4→75, not passed through —
    // "wait for the reset" and "this request is malformed" are different
    // remedies (the gh-budget.sh rule).
    if (/rate limit/i.test(said)) throw new TransientError(`gh api graphql rate limited: ${said}`);
    if (TRANSPORT_RE.test(said) && !mutating)
      throw new TransientError(`gh api graphql transport failure (retried): ${said}`);
    throw new Error(`gh api graphql failed (exit ${r.code}): ${said}`);
  }
  let body: any;
  try {
    body = JSON.parse(r.stdout);
  } catch {
    // exit 0 with non-JSON stdout (proxy interstitial, truncated pipe, …)
    throw new Error(`gh api graphql returned unparseable output: ${r.stdout.slice(0, 200)}`);
  }
  if (body.errors?.length) {
    if (body.errors.some((e: any) => e?.type === "RATE_LIMITED")) {
      const reset = body.data?.[COST_ALIAS]?.resetAt ?? null;
      throw new TransientError(
        `GraphQL rate limited${reset ? ` (resets ${reset})` : ""}: ${body.errors.map((e: any) => e.message).join("; ")}`,
        reset,
      );
    }
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
      if (narrate)
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
export const DEFER_FIELD = "Defer";
const STATUS_FIELD = "Status";
const ESTIMATE_FIELD = "Estimate";
const PRIORITY_FIELD = "Priority";

/** Advisory single-selects: sizing (`create --estimate`) and ranking (`next`)
 *  degrade gracefully without them, so doctor warns (never fails) and setup
 *  creates them when absent — but a host repo's existing scheme is respected:
 *  setup never edits an existing field's options or type. */
export const ESTIMATE_SCALE: readonly string[] = ["XS", "S", "M", "L", "XL"];

const ADVISORY_FIELDS: ReadonlyArray<{ name: string; options: readonly string[] }> = [
  { name: ESTIMATE_FIELD, options: ESTIMATE_SCALE },
  { name: PRIORITY_FIELD, options: ["P0", "P1", "P2", "P3"] },
];

/** Why the advisory single-selects need no option writer: ralph validates a
 *  value against the LIVE option set and never demands its own, so a host
 *  board's Small/Big Estimate is legal and an unknown value is a refusal that
 *  NAMES what exists. That is a redirect, not a deadlock — unlike a missing
 *  Workflow State option, which fails every write closed. Which options an
 *  advisory field carries is the board owner's call. */
const ADVISORY_OPTIONS_EXEMPT =
  "advisory single-select: ralph validates against the LIVE option set and never demands its own, " +
  "so a missing option is a refusal naming what exists, never a deadlock; which options it carries is the board owner's call";

/**
 * Lifecycle parity (GH-2129) — every Project field this CLI reads or gates on
 * must have a sanctioned CLI write surface, or a stated exemption.
 *
 * The class this closes: a surface that READS field state (a refusal
 * predicate, a doctor check, a ranking input) acquires enforcement weight
 * while the corrective verb is forgotten, because reads and writes are added
 * by different units at different times. Two live instances on 2026-08-23 —
 * the approval edge gated on Estimate the CLI could set only at create
 * (GH-2126), and `mutationCache` failed every write closed on a missing state
 * option whose only remedy was a manual UI step (GH-2127). Each was cheap to
 * fix and the class regenerates, so the answer is a test, not a convention:
 * `board.parity.test.ts` derives the ENUMERATION from the `*_FIELD` constants
 * above — a new field is opted in by existing — and makes this table answer
 * for every one of them. A field with no row fails the suite by name.
 *
 * Two axes per field, because they deadlock differently. `value` is who can
 * write an ITEM's value; its verb must address an existing issue, which is
 * exactly what `create` does not do and exactly why GH-2126 shipped a gate
 * with no corrective verb. `options` is who can write the FIELD's option set;
 * its verb is board-scoped, so it takes no issue number.
 *
 * An exemption's reason IS the assertion — parity is not symmetry, and a list
 * of bare names would rot into a suppression file.
 */
export type ParitySurface =
  /** A verb in `run()`'s dispatch that writes this field. */
  | { verb: string }
  /** No writer, on purpose. The reason is the thing being asserted. */
  | { exempt: string };

export interface FieldParity {
  field: string;
  value: ParitySurface;
  options: ParitySurface;
}

export const FIELD_PARITY: readonly FieldParity[] = [
  {
    field: STATE_FIELD,
    value: { verb: "move" },
    // GH-2127. Removal is deliberately NOT offered: deleting an option clears
    // the Workflow State of every item still holding it, unrecoverably, so it
    // stays a human act in the board UI. The exemption is on removal only —
    // the deadlock (a missing option fails every write closed) has a verb.
    options: { verb: "setup" },
  },
  {
    field: CLAIM_FIELD,
    value: { verb: "claim" }, // `release` and the machine clear it
    options: { exempt: "TEXT field — it has no option set to write" },
  },
  {
    field: DEFER_FIELD,
    value: { verb: "defer" },
    options: { exempt: "TEXT field — it has no option set to write" },
  },
  {
    field: STATUS_FIELD,
    // A derived MIRROR of Workflow State (STATUS_SYNC), written on every state
    // write and never independently. A verb that set it apart from the state
    // would desync the board's own Status column from the machine, which is
    // the one thing the mirror exists to prevent.
    value: { exempt: "derived mirror of Workflow State (STATUS_SYNC); never written independently" },
    options: { exempt: "GitHub's built-in Status field — ralph maps onto the board template's options, never authors them" },
  },
  {
    field: ESTIMATE_FIELD,
    value: { verb: "estimate" }, // GH-2126
    options: { exempt: ADVISORY_OPTIONS_EXEMPT },
  },
  {
    field: PRIORITY_FIELD,
    value: { verb: "priority" },
    options: { exempt: ADVISORY_OPTIONS_EXEMPT },
  },
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
  defer: DeferMark | null; // Defer mark — parked out of next/frontier until cleared
  estimate: string | null;
  priority: string | null;
  labels: string[];
  labelsTruncated: boolean; // >LABEL_PAGE labels — apply detection fails closed
  parent: { number: number; title: string } | null;
  /** Same field, same rule, same name as the queue shapes (QueueItem,
   *  ClosedEdge): own-repo parent number, else null. `get` carried the edge
   *  only as `parent`, so `parentNumber` was an ABSENT key — and an absent key
   *  reads as `null`, which is exactly what a genuinely parentless issue
   *  reads as (GH-1791). Two names for one fact is what let a reader conclude
   *  `get` and `tree` disagreed when they never did. */
  parentNumber: number | null;
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
            parent { number title repository { nameWithOwner } }
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
      defer: parseDefer(fv[DEFER_FIELD]),
      estimate: fv[ESTIMATE_FIELD] ?? null,
      priority: fv[PRIORITY_FIELD] ?? null,
      labels: (issue.labels?.nodes ?? []).map((l: any) => l.name),
      labelsTruncated: issue.labels?.pageInfo?.hasNextPage ?? false,
      parent: issue.parent ? { number: issue.parent.number, title: issue.parent.title } : null,
      parentNumber:
        issue.parent &&
        issue.parent.repository?.nameWithOwner?.toLowerCase() ===
          `${ctx.cfg.owner}/${ctx.cfg.repo}`.toLowerCase()
          ? issue.parent.number
          : null,
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

/** A merged PR reaching #number through the branch convention rather than a
 *  closing keyword (GH-1732) — the second half of deliver-queue's linkage
 *  predicate, reused here so the Done gate and the close-out lane agree on
 *  what "linked" means.
 *
 *  FAILS CLOSED by construction: every unreadable path returns null, and null
 *  is the refusal. That is the whole safety argument — a rate limit, a revoked
 *  scope or a malformed response may not manufacture evidence for a close,
 *  because evidence is the artifact no later reader re-derives.
 *
 *  Read through SEARCH, not live refs (GH-1996). The refs read this replaced
 *  assumed the head branch survives the merge; `merge-pr.sh` deletes it
 *  (merge-pr.sh:565, observed on #1995 — GH-1732's own PR), so for every PR
 *  merged through the gate the ref is already gone by the time a close-out
 *  asks, and the evidence path found nothing for the exact population it was
 *  built to serve. Search's `head:` qualifier survives branch deletion.
 *
 *  `head:` is a PREFIX match and needs the kind, so `head:1996` matches
 *  nothing — hence one qualifier per grammar (the closed BRANCH_KINDS set plus
 *  the legacy `feature/GH-N`), OR'd inside a single query. Being a prefix
 *  match it also accepts `feat/19960-…`, which parseBranchName rejects below —
 *  the same re-validation the substring read needed, for the same reason.
 *
 *  Honest limits: search is eventually consistent, so a PR merged seconds ago
 *  may not be indexed yet — that reads as no evidence, which is the fail-closed
 *  direction. deliver-queue's own ref read is untouched: it runs against OPEN
 *  PRs, whose branches still exist.
 *
 *  One query, the same slot the refs read occupied, and only ever asked when
 *  the closing-reference half already came up empty on a Done move. */
function branchLinkedMergedPr(ctx: Ctx, number: number): { number: number; url: string } | null {
  const heads = [...BRANCH_KIND_CHARS.map((k) => `${k}/${number}`), `feature/GH-${number}`];
  let data: any;
  try {
    data = ghGraphQL(
      ctx,
      `query($q: String!) {
        search(type: ISSUE, query: $q, first: 20) {
          nodes { ... on PullRequest { number url merged headRefName } }
        }
      }`,
      {
        q:
          `repo:${ctx.cfg.owner}/${ctx.cfg.repo} is:pr is:merged ` +
          heads.map((h) => `head:${h}`).join(" "),
      },
    );
  } catch {
    return null;
  }
  for (const p of data?.search?.nodes ?? []) {
    if (!p?.merged || typeof p.number !== "number") continue;
    if (parseBranchName(p.headRefName ?? "")?.issue !== number) continue;
    return { number: p.number, url: p.url ?? "" };
  }
  return null;
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
/** Issues per round trip when only comments are read (GH-1891). Higher than
 *  HISTORY_CHUNK because the charge follows nodeCount, and without the
 *  projectItems × fieldValues nesting each issue costs 60 nodes instead of
 *  ~280 — so this batch bills LESS than the smaller one it replaces. */
const COMMENTS_CHUNK = 100;

const COMMENTS_SELECTION = `
  comments(last: ${HISTORY_COMMENTS}) { nodes { body } }`;

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

/** Comment trails only (GH-1891) — what the tend lane actually reads.
 *
 *  `HISTORY_SELECTION` costs what it costs because of ONE nesting:
 *  `projectItems × fieldValues` is 200 of the ~280 nodes charged per issue, and
 *  the tend lane reads neither — it wants the audit/proposal markers, which
 *  live in comments. Dropping that nesting is what lets the chunk grow too:
 *  cost tracks nodeCount, so 100 issues × 60 comments bills less than 20 issues
 *  × 280 did. Measured on this repo's 14-day audit window, 5 round trips at
 *  3 pts became 1 at 2.
 *
 *  A separate return type rather than an `IssueHistory` with nulled fields:
 *  `stateUpdatedAt: null` means "the board never wrote this item's state", and
 *  a read that never asked may not make that claim (the same absent-vs-empty
 *  rule the queue selects follow). Doctor's smells keep `fetchHistories`. */
export function fetchCommentTrails(ctx: Ctx, numbers: number[]): Map<number, string[]> {
  return batchIssueRead(ctx, numbers, COMMENTS_CHUNK, COMMENTS_SELECTION, (issue) =>
    (issue.comments?.nodes ?? []).map((c: any) => c?.body ?? ""),
  );
}

/** History for MANY issues, batched behind GraphQL aliases. A query per open
 *  item would multiply doctor's cost by the size of the board (and the
 *  reconciler cron runs every 15 min), so `HISTORY_CHUNK` issues share one
 *  round trip. Bodies are never requested — only comments, which is where the
 *  machine's audit trail lives. Issues that came back null are simply absent
 *  from the map; every caller must treat "no history" as "no smell". */
export function fetchHistories(ctx: Ctx, numbers: number[]): Map<number, IssueHistory> {
  return batchIssueRead(ctx, numbers, HISTORY_CHUNK, HISTORY_SELECTION, (issue, cache) => {
    const item = (issue.projectItems?.nodes ?? []).find(
      (x: any) => x?.project?.id === cache.projectId,
    );
    const stateValue = (item?.fieldValues?.nodes ?? []).find(
      (v: any) => v?.field?.name === STATE_FIELD,
    );
    return {
      comments: (issue.comments?.nodes ?? []).map((c: any) => c?.body ?? ""),
      stateUpdatedAt: stateValue?.updatedAt ?? null,
      prActivityAt: (issue.closedByPullRequestsReferences?.nodes ?? [])
        .map((p: any) => p?.updatedAt)
        .filter((t: unknown): t is string => typeof t === "string"),
    };
  });
}

/** The batched-alias read both issue-trail fetchers share. Selection and chunk
 *  size are the caller's — the per-chunk fault isolation, which is the part
 *  that is easy to get subtly wrong, is not duplicated. */
function batchIssueRead<T>(
  ctx: Ctx,
  numbers: number[],
  chunkSize: number,
  selection: string,
  parse: (issue: any, cache: BoardCache) => T,
): Map<number, T> {
  const out = new Map<number, T>();
  if (numbers.length === 0) return out;
  return withCache(ctx, (cache) => {
    let succeeded = 0;
    let lastFailure: unknown = null;
    for (let start = 0; start < numbers.length; start += chunkSize) {
      const chunk = numbers.slice(start, start + chunkSize);
      const decls = chunk.map((_, k) => `$n${k}: Int!`).join(", ");
      const aliases = chunk
        .map((_, k) => `a${k}: issue(number: $n${k}) { ${selection} }`)
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
        out.set(n, parse(issue, cache));
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
  /** GH-2179: address the escalation to this lead — the route marker rides
   *  the Decision needed comment. Human Needed target only; ignored elsewhere. */
  routeToLead?: string;
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

export const DECISION_EVIDENCE_MARKER = "<!-- ralph-decision-evidence:v1 -->";

/** Decision evidence: the typed close for a unit that legitimately ends with
 *  no PR — a decision recorded in thoughts/, a spike whose outcome is a
 *  document. A comment carrying the marker names the artifact; the gate
 *  accepts it the way it accepts apply evidence. The marker check is
 *  code-masked (lastMarkerIndex), so prose QUOTING the marker does not pass
 *  it; the artifact is read from the raw line, since backticks around a path
 *  are how comments write one. */
export function decisionEvidence(comments: readonly string[]): string | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    if (lastMarkerIndex(comments[i], DECISION_EVIDENCE_MARKER) < 0) continue;
    const m = /^\s*artifact:\s*(\S[^\n]*)$/m.exec(comments[i]);
    if (m) return m[1].replace(/`/g, "").trim();
  }
  return null;
}

/** The Done evidence gates, shared verbatim by the fresh transition and the
 *  same-state re-drive — two callers may not disagree about what "evidenced"
 *  means (the GH-1732 rule, one layer up).
 *
 *  Apply-kind close gate (GH-1693). PREVENTIVE, not advisory: an apply unit
 *  reaches Done only on shape-valid `ralph-apply-evidence:v1`. There is
 *  deliberately NO --why escape for it. --why means "completed without a
 *  merged PR", which is the NORMAL case for an apply unit — so honouring it
 *  would hand every apply issue a one-flag bypass of the only gate that makes
 *  the kind mean anything. A merged PR is not an escape either: a merge is
 *  exactly the thing this kind refuses to accept as proof. */
function guardDoneEvidence(ctx: Ctx, issue: Issue, why: string | undefined): void {
  if (isApplyIssue(ctx.cfg, issue.labels, issue.labelsTruncated)) {
    const failure = applyEvidenceFailure(ctx, issue.number);
    if (failure) {
      throw new RefusalError(
        `#${issue.number} is an apply unit (label "${ctx.cfg.apply.label}") — Done requires deployed-and-verified evidence: ${failure}. ` +
          `Post one with scripts/apply-evidence.sh, or move it to Human Needed if the apply cannot be done. ` +
          `(--why does not bypass this.)`,
      );
    }
    return;
  }
  if (why || issue.prs.some((p) => p.merged)) return;
  // Epic-root rollup evidence (GH-2198): a root every one of whose children
  // is closed. The fact is DERIVED — parentCheck already computed it to
  // advance the root to In Review — so asking for --why here made the escape
  // hatch the routine path for every completed epic (the GH-1732 argument,
  // one population over). Checked before the branch read because the child
  // list is already on the issue: a qualifying root costs zero extra reads.
  // Bounds, all fail-closed: a childless issue is not an epic and keeps the
  // linkage gates; a truncated child list is not-all-closed; only CLOSED
  // counts (a Canceled child is CLOSED on GitHub and counts — the same key
  // parentCheck gates on — but an unreadable state never reads as closed).
  if (
    issue.children.length > 0 &&
    !issue.childrenTruncated &&
    issue.children.every((c) => c.issueState === "CLOSED")
  ) {
    return;
  }
  // Parity with deliver-queue's linkage (GH-1732): a merged PR reaches the
  // issue through the closing reference OR the branch convention. The
  // no-closing-keyword population is exactly the one the close-out lane
  // exists for, so refusing it here made `--why` the routine path and
  // drained the flag of meaning.
  if (branchLinkedMergedPr(ctx, issue.number)) return;
  // Decision evidence — checked last: it costs a comment-trail read, and only
  // the path that would otherwise refuse pays it. An unreadable trail is not
  // evidence (fail closed, same direction as every other read here).
  try {
    if (decisionEvidence(fetchApplyMeta(ctx, issue.number).comments)) return;
  } catch {
    /* unreadable trail is not evidence */
  }
  // A root with children was one closed child away from the rollup evidence
  // above — name what stands in the way, so the refusal is actionable.
  const openChildren = issue.children.filter((c) => c.issueState === "OPEN").map((c) => `#${c.number}`);
  const rootLine = issue.childrenTruncated
    ? `This root has more than ${issue.children.length} children — refusing to count a truncated list as all-closed. `
    : openChildren.length > 0
      ? `Children still open: ${openChildren.join(", ")} — a root whose children are ALL closed passes bare. `
      : "";
  throw new UsageError(
    `moving #${issue.number} to Done requires a merged linked PR — none found ` +
      `(neither a closing reference nor a merged PR on this issue's branch — see \`board name ${issue.number}\`). ` +
      rootLine +
      `For a unit that ends without a PR, record the outcome: \`board move ${issue.number} done --decision "<artifact path>"\`. ` +
      `Pass --why "<how this was completed>" to complete without either.`,
  );
}

/** Claim-size ceiling (GH-2134). The ceiling is an environment fact, not
 *  doctrine — context windows move, so "too big for one session" belongs in a
 *  var (precedent: RALPH_LOCK_TTL_MIN, RALPH_REVIEW_ROUND_CAP), and setting it
 *  empty removes the guard with no doctrine rewrite.
 *
 *  unset → default "XL"; empty/whitespace → disabled (null); a value outside
 *  the Estimate scale is a LOUD config error, never a silent pass — unlike
 *  parseTtlMin's warn-and-default, because a typo here would silently disarm a
 *  guard whose whole output is a refusal, and nothing downstream would notice. */
export function claimMaxEstimate(raw: string | undefined = process.env.RALPH_CLAIM_MAX_ESTIMATE): string | null {
  if (raw === undefined) return "XL";
  const v = raw.trim().toUpperCase();
  if (v === "") return null;
  if (ESTIMATE_SCALE.includes(v)) return v;
  throw new UsageError(
    `RALPH_CLAIM_MAX_ESTIMATE="${raw}" is not an Estimate option (${ESTIMATE_SCALE.join(", ")}). ` +
      `Set one of those, or set it empty to disable the claim-size ceiling.`,
  );
}

/** Refuse a fresh claim at/above the ceiling; warn one notch under it. No
 *  override flag — the explicit assertion that a unit is not really that size
 *  is re-estimating it (\`board estimate\`), one visible command, exactly how
 *  --steal relates to a stale claim. No Estimate, or a value outside the
 *  scale (a host repo's own scheme): not evaluated, never refused —
 *  estimate-less Backlog items exist by design (GH-1952 adoption) and are
 *  exactly what unattended loops claim. */
export function guardClaimEstimate(
  issue: Pick<Issue, "number" | "estimate">,
  warn: (msg: string) => void = (m) => process.stderr.write(m),
): void {
  const ceiling = claimMaxEstimate();
  if (ceiling === null) return;
  if (!issue.estimate) return;
  const rank = ESTIMATE_SCALE.indexOf(issue.estimate);
  if (rank === -1) return;
  const cap = ESTIMATE_SCALE.indexOf(ceiling);
  if (rank >= cap) {
    const smaller = ESTIMATE_SCALE[Math.max(cap - 1, 0)];
    throw new RefusalError(
      `#${issue.number} is estimated ${issue.estimate} — at or above the claim ceiling ` +
        `${ceiling} (RALPH_CLAIM_MAX_ESTIMATE). A unit this size is decomposition, not one session. ` +
        `If it is genuinely smaller, say so on the board: \`board estimate ${issue.number} ${smaller}\` ` +
        `(or smaller), then claim again.`,
    );
  }
  if (rank === cap - 1) {
    warn(
      `warn: #${issue.number} is estimated ${issue.estimate} — one notch under the claim ceiling ` +
        `${ceiling} (RALPH_CLAIM_MAX_ESTIMATE). An ${issue.estimate} that is genuinely one session exists; ` +
        `consider decomposing before building.\n`,
    );
  }
}

export function transition(ctx: Ctx, issue: Issue, to: State, opts: MoveOpts = {}): Issue {
  // Cache freshness resolved BEFORE any write; the body never retries.
  const cache = mutationCache(ctx, [[STATE_FIELD, to]], [CLAIM_FIELD, DEFER_FIELD]);
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
    // Same-state moves are RETRIES, not violations: a lost response and a
    // failed write are indistinguishable to a caller, so the retry has to be
    // the safe move — the refusal it used to get ("Done → Done: illegal")
    // carried no safety value (the noop mutates nothing) and turned every
    // half-applied close into a human repair. Mutate nothing that already
    // holds; re-drive only the side effect the earlier call left missing — a
    // terminal state whose issue close never landed — and on the SAME
    // evidence a fresh move would demand, because the board saying "Done" is
    // not evidence (a UI write can say anything). The --why comment is also
    // skipped: on a retry it is already on the record, and re-posting it
    // would make every retry a duplicate.
    if (from === to && to !== "In Progress") {
      const needsClose = (to === "Done" || to === "Canceled") && issue.issueState === "OPEN";
      if (!needsClose) return issue; // pure noop — read back, nothing to re-drive
      if (to === "Done") guardDoneEvidence(ctx, issue, opts.why);
      closeIssue(ctx, issue.nodeId, to === "Done" ? "COMPLETED" : "NOT_PLANNED");
      return fetchIssue(ctx, issue.number);
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
    // Approval gate (GH-2077). `Intake → Backlog` is the approval edge, and
    // Backlog means approved-AND-RANKABLE: `next` sorts a null priority behind
    // every real one and no lane names it at all, so an approval that lands an
    // unrankable item has not approved it into the queue, it has lost it. Same
    // bar as `create --backlog`, stated by the same helper so the two spellings
    // of "ready for work" cannot drift. Truncated field values already refused
    // above, so absence here is GitHub's assertion, not a short read.
    if (from === "Intake" && to === "Backlog") {
      const missing = backlogReadinessGaps(issue.priority, issue.estimate);
      if (missing.length > 0) {
        throw new UsageError(
          `#${issue.number} is not ready for Backlog — ${missing.join("; ")}\n` +
            `Backlog means approved and rankable. Set them, then move it again; ` +
            `leave it in Intake if it is not yet approved.`,
        );
      }
    }
    if (to === "Human Needed" && !opts.why) {
      throw new UsageError(
        `moving to Human Needed requires --why "<the exact decision needed>" — it becomes the escalation comment`,
      );
    }
    // Backward edges are exceptional, not routine (GH-2078): the reason is
    // machine-required and posted as a comment, so every demotion is auditable
    // instead of implicit. The two edges are named individually — a general
    // "backward" predicate would need an ordering the states do not carry.
    if (from === "In Progress" && to === "Backlog" && !opts.why) {
      throw new UsageError(
        `In Progress → Backlog is a demotion and requires the reason on the record: ` +
          `\`board release ${issue.number} -m "<where you stopped, what's next>"\` ` +
          `(or \`board move ${issue.number} backlog --why\`).`,
      );
    }
    if (from === "In Review" && to === "In Progress" && !opts.why) {
      throw new UsageError(
        `In Review → In Progress is a demotion and requires the reason on the record: ` +
          `\`board claim ${issue.number} --why "<the rework this resumes for>"\` ` +
          `(or \`board move ${issue.number} in-progress --why\`).`,
      );
    }
    // Done requires evidence: a merged linked PR, typed decision evidence, or
    // an explicit --why on the record. Intent lane only — reconcile() reflects
    // reality unchecked. The gates key on the DESTINATION (guardDoneEvidence,
    // shared with the same-state re-drive above), which is what makes every
    // edge into Done equally strong.
    const doneWithoutMergedPr = to === "Done" && !issue.prs.some((p) => p.merged);
    if (to === "Done") guardDoneEvidence(ctx, issue, opts.why);

    const itemId = requireItem(issue);
    const leavingInProgress = from === "In Progress" && to !== "In Progress";
    const enteringInProgress = to === "In Progress";

    if (leavingInProgress) guardHolder(ctx, issue);
    // Read the binding before the guard so the post-verify write can preserve
    // its `since` on a heartbeat re-claim of the same unit.
    const priorBinding = enteringInProgress ? readSessionBinding(ctx) : null;
    let spokeTo: WorktreeLock | null = null;
    if (enteringInProgress) {
      // Size ceiling (GH-2134) — FIRST and only on fresh acquisition: a
      // heartbeat or resume by a current holder is not the moment to relitigate
      // size (refusing it would strand in-flight work mid-unit; rule 9 says a
      // re-claim of the same unit always passes). A steal IS a fresh
      // acquisition and is judged. Pure read, so a refusal leaves the board
      // untouched.
      if (!(issue.claim && isMember(issue.claim, ctx.cfg.holder))) {
        guardClaimEstimate(issue);
      }
      guardSessionUnit(priorBinding, issue.number);
      // Second only to the rule-9 guard, and for the same reason: a PRE-check,
      // so a refused claim leaves #N exactly as it found it. Skipped when this
      // session already holds the binding — that is a heartbeat, and the peer
      // it would find could only be a stale record of itself.
      if (!priorBinding) spokeTo = guardWorktreePeer(ctx, issue.number, !!opts.steal);
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
        : from === "In Review" && to === "In Progress" ? "Demoted for rework"
        : "Parked";
      // GH-2179: a lead-routed escalation carries its route ON the escalation
      // comment itself — one self-contained, board-resident record. The header
      // stays byte-identical (ESCALATION_EVIDENCE anchors on it).
      const routed =
        to === "Human Needed" && opts.routeToLead
          ? `\n\n${ESCALATION_ROUTE_MARKER}\n\`\`\`json\n` +
            JSON.stringify({ to: "lead", lead: opts.routeToLead, at: ctx.now().toISOString() }) +
            `\n\`\`\``
          : "";
      addComment(ctx, issue.nodeId, `**${header}** (\`board\` by \`${ctx.cfg.holder}\`):\n\n${opts.why}${routed}`);
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

    // Claiming lifts a defer: taking the unit asserts its stated precondition
    // now holds (or is being tested) — a mark left behind would hide the item
    // from `next` again the moment the claim releases.
    if (enteringInProgress && issue.defer && cache.fields[DEFER_FIELD]) {
      clearField(ctx, cache, itemId, DEFER_FIELD);
    }

    // Approval clears a snooze (GH-2202): a Defer on an Intake item was a
    // judgment about the approval decision, which this move just made. The
    // ordinary approve clears it; carrying it into Backlog is a fresh,
    // explicit `board defer` on the now-approved item.
    if (from === "Intake" && to === "Backlog" && issue.defer && cache.fields[DEFER_FIELD]) {
      clearField(ctx, cache, itemId, DEFER_FIELD);
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
    // The claim is verifiably this session's: bind the session to the unit
    // (GH-1948). Deliberately after the verify — see the binding block.
    if (enteringInProgress) {
      // The exact claim the read-back just verified as ours — the fingerprint
      // the unwind below matches on.
      const wroteClaimSince = after.claim!.since.getTime();
      const wonBySibling = writeSessionBinding(ctx, issue.number, priorBinding);
      if (wonBySibling) {
        // A sibling in this session bound first, so this claim must not stand.
        // Unwind it here: leaving the issue In Progress under a claim nobody
        // drives would cost the queue a full TTL, and it is the same shape the
        // state-write rollback above already treats as an anomaly to undo.
        // Best-effort, like that one — doctor remains the backstop.
        let unwound = false;
        let moved = false;
        try {
          // Re-read first: an unconditional restore would clobber whatever
          // landed after the read-back verify — clearing a newer claim and
          // regressing the state of work someone else is now doing. Only undo
          // what is still recognisably OURS.
          const now = fetchIssue(ctx, issue.number);
          // Identity is the claim's `since`, NOT its holder. The holder is
          // `user@host` — every session on this machine writes the same one —
          // so a sibling that refreshed this issue between the verify and here
          // would look identical to our own write and get clobbered. The
          // timestamp is what our write actually stamped, and any refresh
          // (ours or a sibling's) replaces it.
          moved = !(
            now.claim &&
            now.claim.since.getTime() === wroteClaimSince &&
            isMember(now.claim, ctx.cfg.holder) &&
            now.state === to
          );
          if (!moved) {
            // A residual window remains between this check and the writes
            // below, and it is IRREDUCIBLE, not unhandled: Projects V2 has no
            // compare-and-swap, so every mutation in this file — including the
            // claim protocol itself — makes races visible and refused rather
            // than impossible. The two narrowings that were available are
            // taken (re-read, and a `since` fingerprint rather than a
            // machine-wide holder); closing it entirely needs a primitive
            // GitHub does not offer. Doctor's claim-anomaly sweep is the
            // backstop, as it is for the state-write rollback above.
            //
            // STATE FIRST, claim second. The unwind is two writes and either
            // can fail; this order makes the survivable half survive. Clearing
            // the claim first would leave a claimless item sitting In Progress
            // — work nobody holds and no sweep repairs — and the refusal below
            // would then say "still claimed", which would be false. This way a
            // half-unwind leaves the item back at `from` still holding our
            // claim: a stale claim, which is exactly what the message names
            // and what release / TTL / doctor already handle.
            //
            // A null `from` is an item that had no Workflow State to begin
            // with; there is nothing to restore, and dropping the claim is the
            // whole unwind. Inventing a state would be the worse repair.
            if (from) {
              setSingleSelect(ctx, cache, itemId, STATE_FIELD, from);
              syncStatus(ctx, cache, itemId, from);
            }
            if (cache.fields[CLAIM_FIELD]) clearField(ctx, cache, itemId, CLAIM_FIELD);
            unwound = true;
          }
        } catch {
          /* best-effort */
        }
        throw new RefusalError(
          `#${issue.number} was claimed on the board, but a CONCURRENT claim in this session bound it to ` +
            `#${wonBySibling.issue} first — contract rule 9 is one unit per session. ` +
            (unwound
              ? `The claim has been rolled back${from ? ` to "${from}"` : ""}.`
              : moved
                ? `The claim was NOT rolled back — #${issue.number} has moved on since (another writer holds it), ` +
                  `and undoing that would clobber work this session cannot see.`
                : `Rolling the claim back FAILED — #${issue.number} still carries this machine's claim ` +
                  `(doctor surfaces it as a claim anomaly, and it expires after TTL ${ctx.cfg.lockTtlMin} min). ` +
                  `Claiming it from a new session on this machine works regardless — same holder, so the ` +
                  `claim refreshes rather than refusing.`) +
            ` Drive #${issue.number} from a new session.`,
        );
      }
      // Now that this session's record exists, settle any race with a DISTINCT
      // session in the same worktree (GH-1956). It has to run here rather than
      // in the pre-check: two unbound sessions both read an empty directory,
      // and each writes its own file, so no exclusive create settles it.
      takeWorktreeLock(ctx, issue.number, spokeTo);
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
    // The demotion edge returns the unit to the eligible pool, so the local
    // lock must not outlive the claim there (GH-2107). After the verify, so a
    // failed state write never disarms the guard on a unit still being driven.
    if (from === "In Progress" && to === "Backlog") releaseWorktreeLock(ctx, issue.number);

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
// Claim membership verbs. `leave` and `show` remain; `join` was REMOVED in
// GH-1869 — it was the only path that grew a holder set, and under the
// one-writer invariant one owner holds the claim while delegates hold none.
// Existing multi-holder values are still RECOGNIZED everywhere (parse, report,
// leave), so state already on the board can be reported and cleaned.
// `leave` touches the Claim field ONLY: a last-out leave deliberately strands
// an In Progress item claimless (doctor's claimless-wip line surfaces it)
// rather than inventing a fourth state-write lane — board transitions stay
// the skills' job.
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

/** Post-write membership verify for leave: GitHub has no CAS, so the echo
 *  re-read is the only proof the edit stuck (same protocol as transition()). */
function verifyClaimEcho(ctx: Ctx, number: number, holder: string): Issue {
  const after = fetchIssue(ctx, number);
  if (after.fieldValuesTruncated) {
    throw new RefusalError(
      `#${number}: the post-write read came back truncated (>${FIELD_VALUE_PAGE} field values) — ` +
        `claim state unverifiable; check with \`board get ${number}\` or let doctor reconcile`,
    );
  }
  if (after.claim !== null && isMember(after.claim, holder)) {
    throw new RefusalError(
      `claim on #${number} survived the leave (the write did not stick) — ` +
        `re-run the leave or let doctor release it`,
    );
  }
  return after;
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
  return { issue: verifyClaimEcho(ctx, number, holder), changed: true };
}

// ── Session→unit binding (GH-1948) ──────────────────────────────────────────
// Contract rule 9 — "one unit per session, and a finished session stops" —
// shipped in GH-1924 as prose, which refuses nothing. This is the code half.
//
// The binding is LOCAL because the fact is local. The board's holder is
// `user@host`, shared by every session on the machine, so a board-side rule
// keyed on it would refuse legitimate concurrent panes — the opposite of what
// rule 9 says. The session id is the only identity at the right granularity,
// and it exists only in this process's environment.
//
// The claim path is the enforcement point because contract rule 1 puts every
// sanctioned session through it before anything mutates. That makes this
// strictly wider than a spawn-path counter: it also catches the session that
// reached a second unit without passing the spawner at all, which is exactly
// the case a spawn-path count is blind to.
//
// Check EARLY, bind LATE. The binding is written only after the claim's
// read-back verify passes: binding first would strand a session that lost a
// claim race — bound to an issue it never held, then refused the other work
// it was correctly told to go pick.
//
// No resolvable session id, no readable record → NOT EVALUATED. Unlike this
// repo's opt-in flags, an absent value here is not a policy choice, and
// refusing every claim on a runner that publishes no session id would break
// the tool over a fact it was never told.

const SESSION_BINDING_TTL_DAYS = 7;

export interface SessionBinding {
  issue: number;
  since: string; // when this session FIRST claimed it (a heartbeat re-claim keeps it)
  holder: string;
  worktree: string; // the checkout the claim was driven from (GH-1956)
}

export function sessionBindingPath(ctx: Ctx): string | null {
  const id = ctx.session?.id;
  if (!id) return null;
  // The id becomes a filename: anything outside the safe set — a "/" above all
  // — would write outside the directory. Sanitizing ALONE is lossy ("a/b" and
  // "a_b" land on one file), and a collision here is a FALSE REFUSAL of a guard
  // that has no --force, so the digest of the raw id carries the identity and
  // the readable half is only there to make the directory greppable.
  const safe = id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);
  const digest = createHash("sha256").update(id).digest("hex").slice(0, 16);
  return join(ctx.session!.dir, `${safe}-${digest}.json`);
}

export function readSessionBinding(ctx: Ctx): SessionBinding | null {
  const path = sessionBindingPath(ctx);
  if (!path) return null;
  try {
    const b = JSON.parse(readFileSync(path, "utf8"));
    return Number.isInteger(b?.issue) ? (b as SessionBinding) : null;
  } catch {
    return null; // absent or garbled: not evaluated (see above)
  }
}

// ── The second writer in one worktree (GH-1956) ─────────────────────────────
// The binding above is keyed on the SESSION, so it is blind to the case that
// motivated this: a fork pane (`claude --resume <id> --fork-session`) is a NEW
// session id in the SOURCE'S WORKTREE. It reads as unbound, and the board's
// holder is `user@host` for both panes, so nothing in either guard sees two
// harnesses about to race on one index, one branch, and one set of uncommitted
// files — the hazard GH-1774 removed sibling fleets over.
//
// The rule is keyed on the WORKTREE, not on fork-ness. A fork is merely the
// cheapest way to reach this state; a second `claude` started by hand in the
// same checkout is the identical hazard and an env marker set by fork.sh
// would miss it (and would vanish on a `/clear` besides). The worktree is the
// thing actually being shared, so it is the thing the rule names.
//
// SAME UNIT ONLY. A second session in one checkout claiming a DIFFERENT unit
// is also wrong — branch mixing — but that shape has a legitimate reading
// (a worktree reused after its first unit shipped) and refusing it would cost
// false refusals to catch a case nobody has hit. This refuses exactly the
// reported one.
//
// IS A FORK EVER LEGITIMATELY THE DRIVER? Yes — when the source is gone and
// the fork is its continuation. That question already has an answer on this
// board, and it is the claim TTL: a claim nobody refreshes goes stale and
// `--steal` is honest after it. So this rule expires on the SAME clock. A peer
// binding counts only while it is fresh within `RALPH_LOCK_TTL_MIN`, and a
// heartbeat re-claim touches it (see writeSessionBinding), so a live source
// stays fresh and a dead one frees its unit locally at the exact moment it
// frees it on the board. One clock, not two — a second, longer local clock
// would mean a fork could steal on the board and still be refused here.// THE MECHANISM IS A LOCK, NOT A RANKING. An earlier draft compared peer
// records and let the lower-ranked one win, which is not a compare-and-swap:
// two sessions can each publish after the other has already scanned, and both
// then read a directory that justifies their own success. What settles it is a
// single file whose NAME is derived from (worktree, unit) and whose creation is
// exclusive — one path, so exactly one creator, decided by the filesystem
// rather than by two processes agreeing about an order they cannot both see.
//
// Unlike the board claim — where Projects V2 offers no CAS, so races are made
// visible and refused rather than impossible — a local file can actually win
// this, the same asymmetry GH-1948's binding already relies on.

/** The lock's identity: (worktree, unit). Digested, because a worktree path is
 *  not a safe filename and is unbounded.
 *
 *  An earlier version of this comment claimed a 7-day pruner reaped these
 *  along with everything else in the directory. There is no such pruner and
 *  there never was, which is how 126 locks accumulated on one machine with two
 *  thirds of them pointing at deleted checkouts. `board reap-leases` is the
 *  reaper (GH-2108), and its predicate is the missing checkout, not age. */
export function worktreeLockPath(ctx: Ctx, number: number): string | null {
  // No session id is not a policy choice, same as everywhere in this block:
  // not evaluated. A lock with no owner name could never be read back.
  if (!ctx.session?.id || !ctx.repoRoot) return null;
  const digest = createHash("sha256")
    .update(`${ctx.repoRoot}\u0000${number}`)
    .digest("hex")
    .slice(0, 16);
  return join(ctx.session.dir, `wt-${number}-${digest}.json`);
}

interface WorktreeLock {
  session: string;
  issue: number;
  worktree: string;
  since: string;
}

function readWorktreeLock(path: string): { lock: WorktreeLock; freshMs: number } | null {
  try {
    const lock = JSON.parse(readFileSync(path, "utf8"));
    if (typeof lock?.session !== "string") return null;
    return { lock: lock as WorktreeLock, freshMs: statSync(path).mtimeMs };
  } catch {
    return null; // absent, or a record we cannot read — asserts nothing
  }
}

/** Publish atomically AND exclusively: write a complete temp file, then link it
 *  into place. link(2) fails EEXIST, which is the compare-and-swap, and is
 *  atomic, so a concurrent reader never sees a half-written record and scores
 *  it as "no owner". A plain `wx` write gives the first property but not the
 *  second. */
function publishWorktreeLock(ctx: Ctx, path: string, lock: WorktreeLock): boolean {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(ctx.session!.dir, { recursive: true });
    writeFileSync(tmp, JSON.stringify(lock));
    linkSync(tmp, path);
    return true;
  } catch {
    return false;
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort */
    }
  }
}

/** The read-only half, run BEFORE any mutation so the common refusal costs
 *  nothing and leaves the board untouched. It cannot be the whole guard — the
 *  owner may appear between this and the write — which is what takeWorktreeLock
 *  is for. */
function guardWorktreePeer(ctx: Ctx, number: number, steal: boolean): WorktreeLock | null {
  const path = worktreeLockPath(ctx, number);
  if (!path) return null; // no session dir or no repo root: not evaluated
  const held = readWorktreeLock(path);
  if (!held) return null;
  if (held.lock.session === ctx.session!.id) return null; // our own earlier claim
  // --steal is the operator asserting THIS driver is gone. It stays a
  // deliberate flag, not a default — the whole difference from having no guard.
  // The lock seen here is returned, and is the ONLY one the steal may displace.
  if (steal) return held.lock;
  if (held.freshMs < ctx.now().getTime() - ctx.cfg.lockTtlMin * 60_000) return null; // aged out
  throw peerRefusal(ctx, number, ctx.repoRoot, held.lock.since);
}

/** Take the lock, once the claim is verifiably ours — check early, act late.
 *  Acting in the pre-check would let a steal that then LOSES the claim race
 *  erase the incumbent's lock on its way out, disarming the guard while the
 *  incumbent is still driving.
 *
 *  Every path ends in a READ-BACK: whatever the create did, the lock is re-read
 *  and its session id must be ours. That is what makes two concurrent stealers
 *  settle — both may unlink and both may create, but the file that survives
 *  names exactly one session, and everyone else refuses.
 *
 *  A loser does NOT unwind the board claim, unlike the GH-1948 sibling unwind:
 *  there the refused session's claim would have been left driving nothing,
 *  whereas here the winner is a live session holding the same unit under the
 *  same `user@host` holder and the same claim field. The board is already
 *  correct, and a "restore" would strip the winner's claim rather than its own. */
function takeWorktreeLock(ctx: Ctx, number: number, spoke: WorktreeLock | null): void {
  const path = worktreeLockPath(ctx, number);
  if (!path) return;
  const mine: WorktreeLock = {
    session: ctx.session!.id!,
    issue: number,
    worktree: ctx.repoRoot,
    since: ctx.now().toISOString(),
  };
  if (!publishWorktreeLock(ctx, path, mine)) {
    // Occupied, so this is a DISPLACEMENT, and displacement is validate-then-
    // replace: two steps, which POSIX gives no way to fuse (there is no
    // conditional unlink). Two sessions can therefore each validate the same
    // incumbent, and the second can unlink the first's replacement after it
    // landed — both then pass their own read-back and both drive the checkout.
    //
    // So the section is serialized by a second, short-lived exclusive create.
    // Only one displacer runs at a time; anyone who cannot enter refuses rather
    // than proceeding on a validation that may already be stale. The mutex has
    // its own SHORT expiry (not the claim TTL): the section is milliseconds, so
    // a file older than that is a crashed holder, and inheriting the claim
    // TTL's window would wedge every steal in this worktree for two hours.
    const mu = `${path}.mu`;
    // NO EXPIRY, and therefore no takeover. An expiring mutex needs fencing to
    // be safe: recovering one by unlinking the PATH lets two recoverers each
    // delete the other's fresh mutex and both enter — the very race the mutex
    // exists to remove, reintroduced by its own escape hatch. A section that
    // never expires needs no recovery, so this is a pure exclusive create.
    //
    // The price is honest and bounded: a displacer killed mid-section leaves a
    // file that blocks further DISPLACEMENT in this one worktree — never a
    // first claim, never another unit, never another worktree. It fails CLOSED,
    // and the remedy is naming the file, which the refusal does.
    if (!publishWorktreeLock(ctx, mu, mine)) {
      throw new RefusalError(
        `another session is taking over #${number} in this worktree (${ctx.repoRoot}) right now — re-run in a moment. ` +
          `If this persists, a previous takeover was killed mid-way: delete ${mu} to clear it. ` +
          `(That file is only ever held for the few milliseconds of a takeover, so it should never be seen twice.)`,
      );
    }
    try {
      // RE-READ inside the section: whatever was validated before entering may
      // have been replaced by the displacer that just left it.
      const held = readWorktreeLock(path);
      const ours = held?.lock.session === ctx.session!.id;
      const aged = !held || held.freshMs < ctx.now().getTime() - ctx.cfg.lockTtlMin * 60_000;
      // A steal displaces ONLY the lock the pre-check actually saw. A different
      // one now present belongs to a CONCURRENT stealer — a session --steal
      // never spoke to, since it did not exist when the operator made the
      // assertion.
      const spokeTo =
        !!spoke && !!held && held.lock.session === spoke.session && held.lock.since === spoke.since;
      if (ours) {
        try {
          const t = ctx.now();
          utimesSync(path, t, t); // heartbeat: keep a long-lived session fresh
        } catch {
          /* best-effort */
        }
        return;
      }
      if (spokeTo || aged) {
        try {
          unlinkSync(path);
        } catch {
          /* raced away — already the desired end state */
        }
        publishWorktreeLock(ctx, path, mine);
      }
      const inside = readWorktreeLock(path);
      if (inside && inside.lock.session === ctx.session!.id) return;
      throw peerRefusal(ctx, number, ctx.repoRoot, inside?.lock.since ?? "unknown");
    } finally {
      try {
        unlinkSync(mu);
      } catch {
        /* best-effort */
      }
    }
  }
  const won = readWorktreeLock(path);
  if (won && won.lock.session === ctx.session!.id) return;
  throw peerRefusal(ctx, number, ctx.repoRoot, won?.lock.since ?? "unknown");
}

/** The release edge gives the unit back to the pool, so this session's lock
 *  goes with the claim (GH-2107): left behind, the board says Backlog while
 *  the fleet's lease probe says taken, and the unit is unspawnable for a full
 *  TTL. Own lock only — a fresh lock naming another session is a live driver
 *  this session may not disarm — and best-effort: a failed unlink restores the
 *  status quo (the TTL self-clear), never blocks the release. In Progress →
 *  In Review deliberately does NOT clear: deliver reads that lease for the
 *  unpushed-commits case (GH-1929), so there the lock must outlive the claim. */
function releaseWorktreeLock(ctx: Ctx, number: number): void {
  const path = worktreeLockPath(ctx, number);
  if (!path) return; // no session id or repo root: not evaluated
  const held = readWorktreeLock(path);
  if (!held || held.lock.session !== ctx.session!.id) return;
  try {
    unlinkSync(path);
  } catch {
    /* best-effort — the TTL remains the backstop */
  }
}

function peerRefusal(ctx: Ctx, number: number, worktree: string, since: string): RefusalError {
  return new RefusalError(
    `another live session in this worktree (${worktree}) is already driving #${number} (since ${since}). ` +
      `Two harnesses in one checkout race on the index, the branch and each other's uncommitted files, ` +
      `and the board claim cannot see it: the holder is \`${ctx.cfg.holder}\` for both. ` +
      `If this pane is a fork, use it to read and think from that session's context, not to drive its unit. ` +
      `If that session is gone — killed, crashed — say so with \`board claim ${number} --steal\`; ` +
      `otherwise its record ages out after ${ctx.cfg.lockTtlMin} min on the same clock as the board claim, ` +
      `or take a different unit in its own worktree (\`board next\`, then \`board name NNN\`).`,
  );
}

// ── The lock read as a lease, by deliver (GH-1929) ──────────────────────────
//
// GH-1917 typed the work/deliver exclusion at the PUSH INSTANT: `deliver-push.sh`
// pins the remote head with `--force-with-lease=<ref>:<sha>`, so a work session
// that already pushed wins atomically. It says in its own header that it does
// not protect a session holding UNPUSHED local commits, and the lanes spec
// (§8.2) accepts that as messy-but-recoverable: deliver rebases, the work
// session's next push conflicts loudly.
//
// The gap is not that no lease exists. It is that nobody READ the one that
// does. `takeWorktreeLock` (GH-1956) already publishes a record per (worktree,
// unit) at every `board claim` — the mandatory acquisition point contract rule
// 1 makes unavoidable — so the "who takes it, and is that enforceable" question
// a branch-level lease would have to answer is already answered by construction.
// It is not a convention that can fail open (lanes spec §8.3): no user script
// can strip it, because it is taken inside the CLI's own claim path.
//
// Two properties make it readable from outside the owning session, neither of
// them accidental: the sessions dir is machine-shared, and the issue number is
// in the FILENAME. So one `readdir` names every live holder of a unit on this
// machine, at zero API cost — which matters, since the ranking walk this feeds
// runs at the 1-pt GraphQL floor (GH-1803) and a lease check that spent points
// would be paid on every candidate on every pass.
//
// SCOPE, stated rather than implied: this covers a deliver loop on the SAME
// MACHINE. A deliver running on another host sees no lock, and residue §8.2
// survives there untouched. That is the right boundary and not a shortfall —
// unpushed local commits are themselves a machine-local fact, so there was
// never anything for a remote reader to observe.
//
// Why not a new `refs/ralph/lease/<branch>` ref, the issue's own first option:
// it would be a second lock with a second expiry semantics to design and
// heartbeat, guarding a hazard that never leaves the machine. Reusing the
// existing record means the expiry question is already settled — the SAME
// `RALPH_LOCK_TTL_MIN` clock as the board claim, so a dead session cannot block
// deliver any longer than it can block another claim.

/** A live foreign hold on a unit, as deliver sees it. */
export interface LeaseHold {
  session: string;
  worktree: string;
  since: string;
  /** When the lock ages out on its own. This is what makes the resulting
   *  blocked row self-clearing, unlike `convergence-stalled`, which only a
   *  human clears. */
  expiresAt: string;
}

export type LeaseProbe = (number: number) => LeaseHold | null;

/** Enumerate live worktree locks on this machine, keyed by issue number.
 *
 *  Returns null — NOT an empty probe — when there is no readable sessions dir.
 *  The distinction is the whole safety argument: an empty probe asserts "no
 *  session holds anything", while null asserts nothing and leaves deliver's
 *  queue exactly as it was. A lease we could not read is never evidence that
 *  no lease is held.
 *
 *  Own-session locks are excluded. A deliver pass driven from the very session
 *  that holds the unit is not racing itself, and blocking there would make the
 *  lane unable to close out its own work. */
export function localSessionLease(ctx: Ctx): LeaseProbe | null {
  if (!ctx.session?.dir) return null;
  let names: string[];
  try {
    names = readdirSync(ctx.session.dir);
  } catch {
    return null; // no dir yet, or unreadable — not evaluated
  }
  const cutoff = ctx.now().getTime() - ctx.cfg.lockTtlMin * 60_000;
  const ttlMs = ctx.cfg.lockTtlMin * 60_000;
  const holds = new Map<number, LeaseHold>();
  for (const name of names) {
    // The same shape `worktreeLockPath` writes. Matched with an anchored
    // pattern rather than a prefix test so a future `wt-` file of another kind
    // cannot be read as a lock — and so `wt-19290-…` is never mistaken for a
    // hold on #1929, the prefix-match trap GH-1996 hit on `head:`.
    const m = /^wt-(\d+)-[0-9a-f]{16}\.json$/.exec(name);
    if (!m) continue;
    const number = Number(m[1]);
    const held = readWorktreeLock(join(ctx.session.dir, name));
    if (!held) continue;
    if (held.freshMs < cutoff) continue; // aged out on the board claim's own clock
    if (held.lock.session === ctx.session.id) continue; // ours
    // Several worktrees may hold the same unit (each has its own digest). Keep
    // the one that expires LAST: the row may not re-enter the queue while any
    // live session still holds it.
    const hold: LeaseHold = {
      session: held.lock.session,
      worktree: held.lock.worktree,
      since: held.lock.since,
      expiresAt: new Date(held.freshMs + ttlMs).toISOString(),
    };
    const prior = holds.get(number);
    if (!prior || prior.expiresAt < hold.expiresAt) holds.set(number, hold);
  }
  return (number: number) => holds.get(number) ?? null;
}

/** Is the checkout a lock names still on disk?
 *
 *  DEAD IS NOT STALE (GH-2108). Staleness asks whether the holder might come
 *  back, and it is the right question for a lease whose checkout still exists.
 *  It is the wrong question — and gives the wrong answer forever — for one
 *  whose worktree was deleted: nothing can refresh that lock, so it is not
 *  aging toward anything, and rendering it as STALE tells a reader to wait for
 *  a session that cannot return. Measured on the reporting machine: 83 of 126
 *  locks named a directory that no longer existed, the oldest a week old, and
 *  the five real holds were buried under them in the one command an operator
 *  reads to orient.
 *
 *  ENOENT is the ONLY reading that means gone. A permission error, an
 *  unmounted volume, a symlink loop — every other failure is "unknown", which
 *  every consumer here treats as present. A path we could not read is never
 *  evidence that the checkout was removed, and the two mistakes do not cost
 *  the same: keeping a dead row is noise, while dropping or reaping a live one
 *  loses a real hold. */
export type WorktreeState = "present" | "missing" | "unknown";
function worktreeState(path: string): WorktreeState {
  if (!path) return "unknown"; // a record with no worktree asserts nothing
  try {
    statSync(path);
    return "present";
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "ENOENT" ? "missing" : "unknown";
  }
}

/** The repo a checkout belongs to, as the resolved path of its git common dir.
 *
 *  The sessions dir is machine-global while `brief` is repo-scoped, so without
 *  this every lease on the machine printed into every repo's brief — 37 of the
 *  43 live locks on the reporting machine belonged to two other repos. That is
 *  not merely noise: issue numbers are per-repo, so another checkout's
 *  `lease: #76` names a DIFFERENT issue than this repo's #76, and the line is
 *  a wrong statement rather than an irrelevant one.
 *
 *  Pure fs, no exec: a linked worktree's `.git` is a file pointing at
 *  `<common>/worktrees/<name>`, and a main checkout's is the common dir
 *  itself. Returns null on any shape it does not recognise or cannot resolve,
 *  and callers compare only when BOTH sides resolved — an unresolved side is
 *  "unknown", never "different", so a real lease is never withheld because a
 *  read failed. (Resolving both sides also settles the /var vs /private/var
 *  symlink split on macOS, which an unresolved comparison would score as two
 *  different repos.) */
function gitCommonDir(dir: string): string | null {
  const dot = join(dir, ".git");
  let st;
  try {
    st = statSync(dot);
  } catch {
    return null;
  }
  if (st.isDirectory()) {
    try {
      return realpathSync(dot);
    } catch {
      return null;
    }
  }
  let txt: string;
  try {
    txt = readFileSync(dot, "utf8");
  } catch {
    return null;
  }
  const m = /^\s*gitdir:\s*(.+?)\s*$/m.exec(txt);
  if (!m) return null;
  let p = isAbsolute(m[1]) ? m[1] : resolve(dir, m[1]);
  // A LINKED worktree points into <common>/worktrees/<name>; any other `.git`
  // file (a submodule's) already names the common dir.
  if (basename(dirname(p)) === "worktrees") p = dirname(dirname(p));
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/** Every local per-(worktree, unit) lease, for `board who` (audit A2): the
 *  machine-shared sessions dir already names holder, unit and worktree in one
 *  readdir at zero API cost — the question "who is working" was unanswerable
 *  without grepping this file. Null = could not read, never "nobody". */
export interface LeaseRow {
  issue: number;
  session: string;
  worktree: string;
  since: string;
  expiresAt: string;
  stale: boolean;
  ours: boolean;
  /** The lock file itself — what `reap-leases` unlinks, and the only handle a
   *  reader has on a record it wants to name. */
  file: string;
  /** GH-2108. "missing" is DEAD, and is never rendered as STALE anywhere. */
  worktreeState: WorktreeState;
  /** Whether this lock's checkout belongs to the configured repo. null = could
   *  not tell (either side unresolved), which is kept, never withheld. */
  sameRepo: boolean | null;
}
export function readLocalLeases(ctx: Ctx): LeaseRow[] | null {
  if (!ctx.session?.dir) return null;
  let names: string[];
  try {
    names = readdirSync(ctx.session.dir);
  } catch {
    return null;
  }
  const ttlMs = ctx.cfg.lockTtlMin * 60_000;
  const cutoff = ctx.now().getTime() - ttlMs;
  // Resolved once: the answer is the same for every row, and a failure here
  // leaves every sameRepo unknown rather than marking every row foreign.
  const ourCommon = ctx.repoRoot ? gitCommonDir(ctx.repoRoot) : null;
  const rows: LeaseRow[] = [];
  for (const name of names) {
    const m = /^wt-(\d+)-[0-9a-f]{16}\.json$/.exec(name);
    if (!m) continue;
    const file = join(ctx.session.dir, name);
    const held = readWorktreeLock(file);
    if (!held) continue;
    const state = worktreeState(held.lock.worktree);
    // Only a checkout that is actually there can be asked what repo it is.
    const theirCommon = state === "present" ? gitCommonDir(held.lock.worktree) : null;
    rows.push({
      issue: Number(m[1]),
      session: held.lock.session,
      worktree: held.lock.worktree,
      since: held.lock.since,
      expiresAt: new Date(held.freshMs + ttlMs).toISOString(),
      stale: held.freshMs < cutoff,
      ours: held.lock.session === (ctx.session.id ?? ""),
      file,
      worktreeState: state,
      sameRepo: ourCommon && theirCommon ? ourCommon === theirCommon : null,
    });
  }
  rows.sort((a, b) => a.issue - b.issue);
  return rows;
}

/** What the REPO-SCOPED orientation read shows, and what it holds back
 *  (GH-2108). Split out from `brief` so the cut itself is pinned rather than
 *  only its rendering.
 *
 *  Two exclusions, both toward keeping the row: a checkout that is gone
 *  (`missing`, never `unknown`), and a checkout that resolved to a DIFFERENT
 *  repo (`sameRepo === false`, never `null`). Everything the reader could not
 *  classify is shown, because the cost of a stray row is a line of noise and
 *  the cost of a wrong exclusion is a real hold nobody sees. */
export function partitionBriefLeases(rows: LeaseRow[]): {
  shown: LeaseRow[];
  dead: number;
  foreign: number;
} {
  const shown = rows.filter((l) => l.worktreeState !== "missing" && l.sameRepo !== false);
  const dead = rows.filter((l) => l.worktreeState === "missing").length;
  return { shown, dead, foreign: rows.length - shown.length - dead };
}

/** The only writer over the lease records (GH-2108) — separated from the
 *  reader so the one thing that cannot be read off the code is pinned: the
 *  worktree state is RE-CHECKED at the moment of deletion, not trusted from
 *  the classification pass. `git worktree add` can restore the very path
 *  between the two, and the restored checkout's lock is live again.
 *
 *  `probe` is the seam that makes that re-check testable; nothing in
 *  production passes anything but the real one. */
export function reapDeadLeases(
  dead: LeaseRow[],
  probe: (path: string) => WorktreeState = worktreeState,
): { removed: string[]; failed: { file: string; reason: string }[] } {
  const removed: string[] = [];
  const failed: { file: string; reason: string }[] = [];
  for (const l of dead) {
    if (probe(l.worktree) !== "missing") {
      failed.push({ file: l.file, reason: "worktree reappeared between the read and the delete — left alone" });
      continue;
    }
    try {
      unlinkSync(l.file);
      removed.push(l.file);
    } catch (e) {
      failed.push({ file: l.file, reason: (e as Error).message });
    }
  }
  return { removed, failed };
}

/** Refuse a SECOND, distinct unit driven from one session. Re-claiming the
 *  same issue (heartbeat, resume after Human Needed) is not a second unit and
 *  always passes. There is deliberately no --force: a fresh session is the
 *  remedy, and it is one the caller can always take. */
function guardSessionUnit(bound: SessionBinding | null, number: number): void {
  if (!bound || bound.issue === number) return;
  throw new RefusalError(
    `this session already drove #${bound.issue} (claimed ${bound.since}) — contract rule 9 is one unit per session. ` +
      `#${number} needs a NEW session: branch, worktree and lineage all derive from the unit, so a second unit here ` +
      `inherits the first's three, and the fleet bound is counted at the spawn path only, so nobody sees it. ` +
      `File follow-ups with \`board create\` and let whoever spawns the next session rank them.`,
  );
}

/** Bind — with the O_EXCL create doing the compare-and-swap the read in
 *  guardSessionUnit cannot. Without it, two overlapping claims from ONE session
 *  both read an absent binding, both pass the guard, and the last write silently
 *  decides which unit the session "has" while both issues stay claimed by it —
 *  the exact outcome rule 9 exists to prevent, reached by racing the guard.
 *
 *  Unlike the board claim (Projects V2 has no CAS, so races are made VISIBLE
 *  rather than impossible), a local file can actually win this one: first
 *  writer takes the binding, and the loser is refused by name. */
function writeSessionBinding(
  ctx: Ctx,
  number: number,
  prior: SessionBinding | null,
): SessionBinding | null {
  const path = sessionBindingPath(ctx);
  if (!path) return null;
  const since = prior?.issue === number ? prior.since : ctx.now().toISOString();
  const record = JSON.stringify({
    issue: number,
    since,
    holder: ctx.cfg.holder,
    worktree: ctx.repoRoot,
  });
  try {
    mkdirSync(ctx.session!.dir, { recursive: true });
    // Write-then-LINK, not a plain exclusive write. `wx` is exclusive but not
    // atomic: a concurrent reader can open the file between the create and the
    // write and see zero or partial bytes, which readPeerBindings would score
    // as "no peer" — two sessions then both settle to a win and both drive the
    // checkout. link(2) is atomic AND fails EEXIST, so it keeps the
    // compare-and-swap GH-1948 needs while making the record appear complete or
    // not at all. The temp name carries the pid so two processes cannot collide
    // on it.
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, record);
    try {
      linkSync(tmp, path);
    } finally {
      try {
        unlinkSync(tmp);
      } catch {
        /* best-effort */
      }
    }
    pruneSessionBindings(ctx);
    return null;
  } catch (e) {
    // An unwritable state dir must not fail a claim the board already granted:
    // the claim is the durable half, this is a local rule, and a machine that
    // cannot write ~/.ralph has a louder problem than rule 9.
    if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") return null;
  }
  // A record already exists — either this session's own earlier claim of the
  // SAME unit (a heartbeat: leave it, its `since` is the one worth keeping,
  // and touch it so the pruner cannot reap a long-lived session), or a
  // concurrent sibling that won the binding first.
  const won = readSessionBinding(ctx);
  if (!won || won.issue === number) {
    try {
      const t = ctx.now();
      utimesSync(path, t, t);
    } catch {
      /* best-effort */
    }
    return null;
  }
  return won; // caller unwinds the claim it just took, then refuses
}

/** Session ids are unique per session, so the records would accumulate forever.
 *  Swept on write — the only moment we are already touching the directory. */
function pruneSessionBindings(ctx: Ctx): void {
  const dir = ctx.session!.dir;
  const cutoff = ctx.now().getTime() - SESSION_BINDING_TTL_DAYS * 86_400_000;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const p = join(dir, name);
      if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
    } catch {
      /* raced away by a concurrent sweep — already the desired end state */
    }
  }
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
// Answer — the Human Needed answer verb (ralph-herdr v2), COMMENT-FIRST.
//
// The durable half (a GitHub **Answer** comment) lands first, extending
// transition()'s comments-before-state rule across the whole verb: if the
// process — or the multiplexer driving it — vanishes mid-answer, the decision
// is on the record and the item is still in Human Needed for a clean retry.
// The herdr prompt half (nudging the paused agent to resume) is deliberately
// NOT here: the board is authoritative and herdr decorative, so the prompt
// belongs to plugin/ralph-herdr. Escalation payload shape stays `board
// contract validate ralph.escalation`'s job — this verb validates nothing
// about the question, it only answers it.
//
// The resume edge belongs to the RESUMING agent (GH-2204). The verb's default
// is comment-only: the item STAYS Human Needed and the driving session takes
// Human Needed → In Progress itself (`board claim NNN` — the machine edge
// already exists). Every claim-adjacent guard — the session→unit binding
// (GH-1948), the worktree lock (GH-1956), the size ceiling (GH-2134) — keys
// on "whoever runs the command is whoever will drive the unit", and `answer`
// is the one verb where those differ by construction: the answerer is a
// proxy. Transitioning here bound the ANSWERER — a hero pane walking the
// queue broke at item two on rule 9, the worktree lock made deliver-queue
// report a driver that wasn't, and when the paused agent was dead the item
// landed In Progress + claimed + no driver, invisible to work-fleet for a
// full TTL. `--resume` keeps the one-invocation form for the session that IS
// the driver answering its own item (answerer == driver, so the guards bind
// correctly). The answered-but-unresumed window is surfaced, not hidden:
// the marker below timestamps the answer, `board escalations` classifies it,
// and doctor's `answer-unresumed` line ages it.
// ---------------------------------------------------------------------------

/** Appended (with a fenced JSON payload `{at, by}`) to every **Answer**
 *  comment, so the answered-but-unresumed classification is computed at READ
 *  time from the trail — the same no-tracking-state shape as the escalation
 *  route's TTL (GH-2179). */
export const ANSWER_MARKER = "<!-- ralph-answer:v1 -->";

/** An **Answer** comment, matched the way ESCALATION_EVIDENCE matches its
 *  half — on the masked body, so a quoted answer inside a code fence is not
 *  one. */
export const ANSWER_EVIDENCE = /^\*\*Answer\*\*/m;

export interface AnswerResult {
  commented: boolean;
  transitioned: boolean;
  state: string | null;
  /** True when the item is still Human Needed with this answer on record —
   *  someone still has to drive it (`board claim NNN` resumes). */
  resumePending: boolean;
}

export function answer(
  ctx: Ctx,
  number: number,
  opts: { message: string; anyState?: boolean; resume?: boolean },
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
  const payload = JSON.stringify({ at: ctx.now().toISOString(), by: ctx.cfg.holder });
  addComment(
    ctx,
    issue.nodeId,
    `**Answer** (\`board\` by \`${ctx.cfg.holder}\`):\n\n${opts.message}` +
      `\n\n${ANSWER_MARKER}\n\`\`\`json\n${payload}\n\`\`\``,
  );
  // The Human Needed → In Progress edge is taken only on --resume (self-
  // answer: answerer == driver), and an --any-state answer outside Human
  // Needed has no edge to take — relaxing the refusal never relaxes the
  // MACHINE. The default leaves the item Human Needed for the resuming
  // session's own `board claim`.
  if (!opts.resume || issue.state !== "Human Needed") {
    return {
      commented: true,
      transitioned: false,
      state: issue.state,
      resumePending: issue.state === "Human Needed",
    };
  }
  try {
    const after = transition(ctx, issue, "In Progress");
    return { commented: true, transitioned: true, state: after.state, resumePending: false };
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
    assertBoardAddAllowed(ctx, issue.url, issue.number);
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

// ---------------------------------------------------------------------------
// Change oracle — gate the walk, bound the staleness (GH-1804)
//
// Δ (the item-cache TTL) is the window inside which no question is asked. Past
// it the walk is not automatic: a REST conditional request answers "has
// anything ISSUE-visible changed since the etag was captured", and a 304 costs
// ZERO rate limit on a budget that is measurably independent of the GraphQL one
// the walk spends (#1801: GraphQL 0/5000 while REST read 4983/5000).
//
// What it can and cannot see — measured on #1801, not assumed:
//
//   visible   comments, body edits, labels, open/close
//   INVISIBLE Workflow State transitions, Claim writes, dependency edges,
//             cross-references — i.e. every ordinary `board move` / `board
//             claim`, the most common write on this board
//
// So this is NOT "an unchanged board is free to confirm unchanged". A board
// that is issue-quiet and transition-busy — exactly what an agent fleet
// produces — returns 304 the whole way through a Backlog → In Progress → In
// Review sequence. `T_max` is therefore the correctness-relevant bound rather
// than a backstop: it, not the oracle, sets the true refresh rate for the
// invisible writes. Foreign-repo board items live outside the probed repo and
// are invisible to the oracle entirely; their staleness is bounded by T_max
// alone. Both are stated here rather than discovered in production.
//
// Every failure direction is toward PAYING for the walk:
//
//  * `gh api` exits 1 on a 304 and 0 on a 200, so the verdict is read from the
//    HTTP status LINE and never from the exit code. Reading exit-1 as
//    "unchanged" would turn every network failure, auth error and rate-limit
//    response into a quiet board and the walk would never run again — trap #1
//    of the issue (fail-open-to-zero) wearing a different hat.
//  * Anything that is not a clean 304 — including an unreadable response — is
//    CHANGED, never "probably fine".
//  * `since` is the instant the etag was CAPTURED, and an entry is certified
//    only when `since <= fetchedAt`. A 304 proves nothing changed after
//    `since`; it says nothing about the window before it, so an etag captured
//    AFTER a walk cannot vouch for that walk.
//  * The oracle can only EXTEND a serve that every other guarantee already
//    permits — selection coverage, read-your-writes and monotonic reads are
//    checked exactly as before, on the same entry.
//
// It never runs for a mutating path (those zero the TTL, which short-circuits
// the whole read) and never for `doctor`, the one walk consumer that mutates
// from what it read: correcting live state from a stale view is a correctness
// bug, not a wasted claim attempt.
// ---------------------------------------------------------------------------

export const ITEM_ORACLE_MAX_DEFAULT_SEC = 600;
export const ITEM_ORACLE_MAX_LIMIT_SEC = 3600;

export function parseItemOracleMaxSec(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return ITEM_ORACLE_MAX_DEFAULT_SEC;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0 && n <= ITEM_ORACLE_MAX_LIMIT_SEC) return n;
  process.stderr.write(
    `warn: RALPH_ITEM_ORACLE_MAX_SEC="${raw}" is not a number in 0..${ITEM_ORACLE_MAX_LIMIT_SEC} — ` +
      `using ${ITEM_ORACLE_MAX_DEFAULT_SEC}\n`,
  );
  return ITEM_ORACLE_MAX_DEFAULT_SEC;
}

/** T_max, seconds. Never below Δ: a ceiling under the no-question window would
 *  read as "the oracle makes things staler", which it must never do. */
function itemOracleMaxSec(ctx: Ctx): number {
  const t = ctx.itemOracleMaxSec ?? 0;
  if (!Number.isFinite(t) || t <= 0) return 0;
  return Math.max(t, itemCacheTtlSec(ctx));
}

interface OracleMark {
  etag: string;
  /** ISO. When the etag was captured — the start of the window a 304 covers. */
  since: string;
}

function itemOraclePath(ctx: Ctx): string {
  return join(ctx.cacheDir, `items-oracle-${itemCacheKey(ctx)}.json`);
}

function readOracleMark(ctx: Ctx): OracleMark | null {
  try {
    const raw = JSON.parse(readFileSync(itemOraclePath(ctx), "utf8"));
    if (typeof raw?.etag !== "string" || !raw.etag) return null;
    if (typeof raw?.since !== "string" || !Number.isFinite(Date.parse(raw.since))) return null;
    return { etag: raw.etag, since: raw.since };
  } catch {
    return null; // absent or corrupt — no certification, so: walk
  }
}

type OracleVerdict = "unchanged" | "changed";

/** One probe per Ctx, memoized: a chain of reads inside one command asks
 *  GitHub once. Keyed by the Ctx VALUE rather than by the config it names —
 *  the verdict is a fact about one moment, and a second Ctx is a second
 *  moment (a later CLI invocation, a clone made with a different clock or a
 *  different staleness policy). Sharing a verdict across those would let one
 *  read's answer certify a chain that never asked. */
const oracleProbes = new WeakMap<Ctx, OracleVerdict>();

/** The conditional request. Returns `changed` for everything that is not an
 *  unambiguous 304, and records a fresh etag whenever one arrives. */
function probeOracle(ctx: Ctx): OracleVerdict {
  const memo = oracleProbes.get(ctx);
  if (memo) return memo;
  const verdict = runOracleProbe(ctx);
  oracleProbes.set(ctx, verdict);
  return verdict;
}

function runOracleProbe(ctx: Ctx): OracleVerdict {
  const mark = readOracleMark(ctx);
  // Captured BEFORE the request: the window a future 304 vouches for must
  // begin no later than the state this response describes.
  const since = ctx.now().toISOString();
  const argv = [
    "gh", "api", "-i", "--hostname", ctx.cfg.host,
    `repos/${ctx.cfg.owner}/${ctx.cfg.repo}/issues?state=all&sort=updated&direction=desc&per_page=1`,
  ];
  if (mark) argv.push("-H", `If-None-Match: ${mark.etag}`);
  let r: ExecResult;
  try {
    r = ctx.exec(argv);
  } catch {
    return "changed";
  }
  // The status LINE, never the exit code — `gh api` exits 1 on a 304.
  const status = /^HTTP\/[\d.]+\s+(\d{3})/im.exec(r.stdout)?.[1] ?? null;
  if (status === "304" && mark) return "unchanged";
  if (status === "200") {
    const etag = /^etag:\s*(\S.*?)\s*$/im.exec(r.stdout)?.[1];
    if (etag) writeOracleMark(ctx, { etag, since });
  }
  return "changed";
}

function writeOracleMark(ctx: Ctx, mark: OracleMark): void {
  try {
    mkdirSync(ctx.cacheDir, { recursive: true });
    atomicWrite(itemOraclePath(ctx), JSON.stringify(mark));
  } catch {
    /* an etag we cannot store is an oracle that always says changed */
  }
}

/** Called on the way to a walk, so the NEXT process has an etag whose window
 *  opened before this walk did. Inert when the oracle is off. */
function refreshOracle(ctx: Ctx): void {
  // No cache write means no entry for an etag to vouch for later.
  if (itemCacheTtlSec(ctx) === 0 || itemOracleMaxSec(ctx) === 0) return;
  probeOracle(ctx);
}

/** May an entry older than Δ still be served? Only with a certification whose
 *  window opened at or before the walk it is vouching for. */
function oracleCertifies(ctx: Ctx, fetchedAtMs: number): boolean {
  if (itemOracleMaxSec(ctx) === 0) return false;
  const mark = readOracleMark(ctx);
  if (!mark) return false;
  const since = Date.parse(mark.since);
  if (!Number.isFinite(since) || since > fetchedAtMs) return false;
  return probeOracle(ctx) === "unchanged";
}

/** null = nothing servable. Every refusal reason is a guarantee, not a
 *  heuristic: a selection that does not cover the request, expired Δ with no
 *  oracle certification (or past T_max, where no certification is enough), an
 *  entry that predates a local write (read-your-writes), or one older than
 *  something already served (monotonic reads).
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
  if (ageSec < 0) return null;
  // Past Δ the entry is not dead, it is on probation: the oracle may extend it
  // up to T_max, which is a HARD ceiling no certification overrides — the
  // writes the oracle cannot see (state, claim) are bounded by nothing else.
  if (ageSec > ttl && (ageSec > itemOracleMaxSec(ctx) || !oracleCertifies(ctx, t))) return null;
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
  itemId: string | null = null,
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
    itemId,
    claim: parseClaim(fv[CLAIM_FIELD]),
    claimRaw: fv[CLAIM_FIELD] ?? null,
    defer: parseDefer(fv[DEFER_FIELD]),
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
  refreshOracle(ctx);
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
                projectItems(first: ${PROJECT_ITEMS_PAGE}) {
                  pageInfo { hasNextPage }
                  nodes { id isArchived project { id } ${FIELD_VALUES_FRAGMENT} }
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
          toQueueItem(c, fieldValueMap(item.fieldValues), fieldValuesTruncated(item.fieldValues), self, select, item.id ?? null),
        );
      }
      if (!page.pageInfo.hasNextPage) break;
      after = page.pageInfo.endCursor;
    }
    return { version: ITEM_CACHE_VERSION, kind: "own-open", select, fetchedAt, open: items, closed: [], scan };
  });
}

/** Project memberships read per issue in the issues-rooted paths.
 *
 *  This one number IS the cost of the inverted walk, and it is the exception
 *  the GH-1811 lesson predicts: on the ProjectV2.items walk every connection
 *  hangs under one `items(first: 100)` page, so trimming a nested `first:` is
 *  worth zero. Here `projectItems` is a SECOND level of nesting, and
 *  `fieldValues` hangs under IT — so the product, and the charge, is
 *  100 × projectItems × fieldValues. Probed against this repo, one page:
 *
 *      projectItems  fieldValues   cost
 *                20           20     21
 *                20           10     21   ← fieldValues is free
 *                10           20     11
 *                 5           20      6
 *
 *  `fieldValues` moves nothing; `projectItems` halves the walk. 10 buys the
 *  halving while keeping ample headroom over the number of projects a board
 *  issue is realistically on — and being wrong is a hard, self-naming error
 *  (membership truncated), never a silently short read. */
const PROJECT_ITEMS_PAGE = 10;

/** Parent lookups per round trip in the closed-edge closure. */
const CLOSED_EDGE_BATCH = 50;

/** The own-repo issues closed inside a lookback window, issues-rooted (GH-1891).
 *
 *  The Done audit is the last reader that needed the project scan's `closed`
 *  half, which is what kept `tend-queue` paying for every item the board has
 *  ever held (15 pages, 30 pts) to find ~90 issues closed in the last 14 days.
 *
 *  There is no server-side `closedAt` filter or ordering, so the window is cut
 *  against UPDATED_AT DESC. That is COMPLETE, not a heuristic: closing an issue
 *  is an update, so `updatedAt >= closedAt` always — an issue closed inside the
 *  window cannot have sorted below one updated outside it. The first node older
 *  than the cutoff therefore ends the read, and only issues whose window
 *  membership was decided by a field GitHub actually sorted on are dropped.
 *
 *  Cheaper than the walk it replaces in a second way: `fieldValues` — the
 *  connection that makes the open walk's `projectItems` nesting cost real
 *  points — is not requested at all. `title` and `stateReason` are scalars and
 *  ride free (GH-2062): the Done view needs both, and the audit's rows carried
 *  an empty title only because nothing had asked for one. Board membership and
 *  archived are filtered exactly as the scan-derived set filtered them, and a
 *  truncated membership list is the same hard, self-naming error the open walk
 *  raises rather than a silent drop. */
export function listOwnRecentClosed(
  ctx: Ctx,
  since: Date,
): Array<{ number: number; title: string; closedAt: string; stateReason: string | null }> {
  const cutoff = since.getTime();
  return withCache(ctx, (cache) => {
    const out: Array<{ number: number; title: string; closedAt: string; stateReason: string | null }> = [];
    let after: string | null = null;
    for (;;) {
      const data: any = ghGraphQL(
        ctx,
        `query($owner: String!, $repo: String!, $after: String) {
          repository(owner: $owner, name: $repo) {
            issues(states: CLOSED, first: 100, after: $after,
                   orderBy: {field: UPDATED_AT, direction: DESC}) {
              pageInfo { hasNextPage endCursor }
              nodes {
                number
                title
                closedAt
                stateReason
                updatedAt
                projectItems(first: ${PROJECT_ITEMS_PAGE}) {
                  pageInfo { hasNextPage }
                  nodes { isArchived project { id } }
                }
              }
            }
          }
        }`,
        { owner: ctx.cfg.owner, repo: ctx.cfg.repo, after },
      );
      const page = data.repository?.issues;
      if (!page)
        throw new Error(`could not read closed issues for ${ctx.cfg.owner}/${ctx.cfg.repo}`);
      assertPageInfo(page.pageInfo, `closed issues for ${ctx.cfg.owner}/${ctx.cfg.repo}`);
      for (const c of page.nodes ?? []) {
        if (!c?.number) continue;
        const updated = new Date(c.updatedAt ?? "").getTime();
        // An unreadable updatedAt cannot be proven older than the cutoff, so it
        // is skipped rather than allowed to end the read early.
        if (Number.isFinite(updated) && updated < cutoff) return out;
        const nodes = c.projectItems?.nodes ?? [];
        const item = nodes.find((n: any) => n.project?.id === cache.projectId);
        if (!item) {
          if (c.projectItems?.pageInfo?.hasNextPage)
            throw new Error(
              `issue #${c.number}: project membership truncated — cannot tell if it is on the board`,
            );
          continue; // genuinely off-board
        }
        if (item.isArchived) continue;
        const closed = new Date(c.closedAt ?? "").getTime();
        if (!Number.isFinite(closed) || closed < cutoff) continue;
        out.push({
          number: c.number,
          title: c.title ?? "",
          closedAt: c.closedAt,
          stateReason: c.stateReason ?? null,
        });
      }
      if (!page.pageInfo.hasNextPage) return out;
      after = page.pageInfo.endCursor;
    }
  });
}

/** The closed pass-through tree edges an issues-rooted walk cannot see
 *  (GH-1814).
 *
 *  `next`/`frontier` used to take these from the full project scan's `closed`
 *  half — the whole reason those two commands still paid for a walk over every
 *  item the board has ever held. What the ranker actually needs is far
 *  smaller: only a closed node that lies BETWEEN an open item and an open
 *  ancestor changes any answer. A closed subtree with no open descendant
 *  contributes nothing — closed nodes are rankless and never eligible, and the
 *  descendant walk only reaches them from an open root.
 *
 *  So the closure runs UPWARD from the open set: take every parent the open
 *  items name that is not itself open, resolve its own parent, repeat. That is
 *  exactly the set of intermediate nodes, and it terminates because each round
 *  either finds new numbers or stops. On this board it is usually zero round
 *  trips — most parents are open.
 *
 *  Two filters keep the result identical to the scan-derived one it replaces:
 *  a parent is an edge only if it is ON the configured board (an off-board
 *  closed parent severed the tree before and must keep severing it), and only
 *  own-repo parents are followed (a foreign #N must never rebuild a tree edge
 *  onto this repo's #N — the same fail-closed rule `toQueueItem` applies).
 *  Archived is deliberately NOT filtered: an archived closed item carried a
 *  tree edge under the project scan, and dropping it here would sever a tree
 *  the previous read path joined. */
export function closedTreeEdges(ctx: Ctx, open: { number: number; parentNumber: number | null }[]): ClosedEdge[] {
  const self = `${ctx.cfg.owner}/${ctx.cfg.repo}`.toLowerCase();
  const known = new Set(open.map((i) => i.number));
  const edges: ClosedEdge[] = [];
  let frontier = [...new Set(open.map((i) => i.parentNumber).filter((n): n is number => n != null && !known.has(n)))];
  for (const n of frontier) known.add(n);
  if (frontier.length === 0) return edges;

  return withCache(ctx, (cache) => {
    while (frontier.length > 0) {
      const next: number[] = [];
      for (let i = 0; i < frontier.length; i += CLOSED_EDGE_BATCH) {
        const batch = frontier.slice(i, i + CLOSED_EDGE_BATCH);
        const aliases = batch
          .map((n, k) => `pe${k}: issue(number: ${n}) {
            number
            parent { number repository { nameWithOwner } }
            projectItems(first: ${PROJECT_ITEMS_PAGE}) { pageInfo { hasNextPage } nodes { project { id } } }
          }`)
          .join("\n");
        const d: any = ghGraphQL(
          ctx,
          `query($owner: String!, $repo: String!) {
            repository(owner: $owner, name: $repo) { ${aliases} }
          }`,
          { owner: ctx.cfg.owner, repo: ctx.cfg.repo },
        );
        const repo = d.repository;
        if (!repo) throw new Error(`could not read parent issues for ${ctx.cfg.owner}/${ctx.cfg.repo}`);
        batch.forEach((n, k) => {
          const c = repo[`pe${k}`];
          if (!c) return; // deleted or transferred — no edge, same as off-board
          const pi = c.projectItems;
          // Fail closed, exactly as the walk does: membership we could not see
          // must not read as "not on the board".
          if (!pi?.nodes?.some((x: any) => x.project?.id === cache.projectId)) {
            if (pi?.pageInfo?.hasNextPage)
              throw new Error(`issue #${n}: project membership truncated — cannot tell if it is on the board`);
            return; // genuinely off-board — the tree stays severed here
          }
          const p =
            c.parent && c.parent.repository?.nameWithOwner?.toLowerCase() === self ? c.parent.number : null;
          edges.push({ number: n, parentNumber: p });
          if (p != null && !known.has(p)) {
            known.add(p);
            next.push(p);
          }
        });
      }
      frontier = next;
    }
    return edges;
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
  refreshOracle(ctx);
  const entry = walkFull(ctx, select);
  writeItemCache(ctx, "full", entry);
  return serveWalk<S>(ctx, entry, false);
}

/** GitHub's `items(first:100, after:)` cursor is not stable across a project
 *  being mutated under a ~15-page walk: a page boundary can skip a live node
 *  (observed 2026-08-14, GH-1896 — #1873 reproducibly absent while the
 *  issues-rooted read returned it). `totalCount` is the connection's own
 *  answer to "how many are there", so a walk that paged FEWER nodes than that
 *  dropped some. One retry absorbs the transient case; a second short read is
 *  raised, because doctor's sweeps read a dropped item as "none" — silently
 *  failing OPEN is the one outcome this file refuses everywhere else. */
function walkFull(ctx: Ctx, select: QueueSelect): ItemCacheEntry {
  const first = walkFullOnce(ctx, select);
  if (!first.short) return first.entry;
  const second = walkFullOnce(ctx, select);
  if (!second.short) return second.entry;
  throw new Error(
    `project ${ctx.cfg.projectNumber}: the item walk returned ${second.scanned} of ${second.expected} items ` +
      `(twice) — GitHub's cursor dropped live board items, so this read is incomplete. Retry; if it persists, ` +
      `the project is being mutated faster than it can be paged.`,
  );
}

function walkFullOnce(
  ctx: Ctx,
  select: QueueSelect,
): { entry: ItemCacheEntry; short: boolean; scanned: number; expected: number } {
  const fetchedAt = startStamp(ctx);
  // `expected` is the LAST page's totalCount: the connection's count as of the
  // end of the walk, which is what the nodes paged so far must account for.
  let expected = 0;
  const entry: ItemCacheEntry = withCache(ctx, (cache): ItemCacheEntry => {
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
                totalCount
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
      // A connection that answers with no totalCount cannot prove the walk
      // complete, but it also cannot prove it short — 0 leaves the check
      // inert rather than turning an unasked question into a failure.
      if (typeof page.totalCount === "number") expected = page.totalCount;
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
        items.push(toQueueItem(c, fv, fieldValuesTruncated(n.fieldValues), self, select, n.id ?? null));
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
  return { entry, short: entry.scan.nodes < expected, scanned: entry.scan.nodes, expected };
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
  /** Convergence checks per pass (GH-1977), spent on queue rows in queue
   *  order. Each is 3 REST/GraphQL reads, so it is budgeted like the dry-run
   *  probe rather than run across the ranking walk. */
  convergenceMax: number;
}

export const DELIVER_DEFAULTS: Readonly<DeliverOpts> = Object.freeze({
  settleMin: 5,
  retryMin: 60,
  dryrunMax: 3,
  convergenceMax: 3,
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
    convergenceMax: positive("RALPH_DELIVER_CONVERGENCE_MAX", DELIVER_DEFAULTS.convergenceMax),
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
  /** GH-1816: on a `FAIL — review`, which judgement the pass made —
   *  `live` (demoted), `stale` (held at In Review), or `not-evaluated`.
   *  Trail only: the selector's re-arm delta reads the four cursors above and
   *  never this, so recording it can neither hold nor re-arm a row. Absent on
   *  every verdict but review, because there was no judgement to record. */
  review_staleness?: "live" | "stale" | "not-evaluated";
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

/** A linked PR before its facts are fetched — all phase A of the fetch knows
 *  (GH-1811). Enough for the two length checks and to pick phase B's set;
 *  deliberately not enough for a signal check, which is why it is a type. */
export interface DeliverPrLink {
  /** The node id, not the number, is what phase B fetches by: a closing
   *  reference can name a PR in ANOTHER repo, where the same number is a
   *  different PR entirely (or none). */
  id: string;
  number: number;
  state: "OPEN" | "MERGED" | "CLOSED";
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
  /** Linked PRs of ANY state: closing references ∪ the branch convention —
   *  `<kind>/NNN-slug` or the legacy `feature/GH-NNN` (detect-if-present —
   *  hosts without the convention degrade to closing references only).
   *  Deduped by PR number. Linkage only; facts live in `openPrs`. */
  prs: DeliverPrLink[];
  /** Facts for the OPEN linked PRs, and only those (GH-1811). Every signal
   *  check reads off the open subset, so a merged PR's checks, reviews and
   *  threads were fetched and discarded — ~90% of this query's cost. */
  openPrs: DeliverPrFacts[];
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
  /** GH-1977: the convergence verdict that held this row out of the queue
   *  (`stalled` / `cap-reached`), plus the script's own detail line. Present
   *  only on `convergence-stalled` rows. */
  convergence?: string | null;
  detail?: string | null;
  /** GH-1929: the live foreign session holding this unit's worktree lock.
   *  Present only on `local-session-active` rows. */
  lease?: LeaseHold | null;
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

/** GH-1977. Answers "is this PR's review loop still converging" for one PR —
 *  `scripts/review-convergence.sh`, parsed. Null = not evaluated (the script
 *  is absent, crashed, or answered `ok:false`), and not-evaluated NEVER holds
 *  a row back: the rule gates nothing at the merge path (#1849's split), so an
 *  unreadable answer must leave the queue exactly as it was rather than
 *  inventing a block nobody can clear. */
export type ConvergenceProbe = (pr: number) => { verdict: string; detail: string } | null;

/** The two terminal verdicts that mean "stop iterating and escalate" — the
 *  only ones this selector acts on. Every other verdict (`converged`,
 *  `converging`, `insufficient-data`, `no-passes`) is a live loop. */
const CONVERGENCE_STOP = new Set(["stalled", "cap-reached"]);

export function parseConvergenceVerdict(out: string): { verdict: string; detail: string } | null {
  try {
    const j = JSON.parse(out.trim().split("\n").filter(Boolean).pop() ?? "");
    if (!j || typeof j !== "object" || j.ok !== true) return null;
    if (typeof j.verdict !== "string") return null;
    return { verdict: j.verdict, detail: typeof j.detail === "string" ? j.detail : "" };
  } catch {
    return null;
  }
}

/** Pure classification per spec §4.2 — deterministic given candidates, opts,
 *  clock, and probe. `probe === null` means the host repo ships no merge gate:
 *  cheap-delta candidates are actionable unprobed (native-flow degrade). */
export function classifyDeliver(
  cands: DeliverCandidate[],
  opts: DeliverOpts,
  now: Date,
  probe: DeliverProbe | null,
  convergence: ConvergenceProbe | null = null,
  lease: LeaseProbe | null = null,
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
    // GH-1929, first: a unit a live session on this machine is driving is
    // refused ENTIRELY, before any PR-shaped reasoning. That is deliberate and
    // stronger than the push-instant lease it complements — the hazard is
    // unpushed local commits, which are invisible to every remote signal the
    // checks below read, so no amount of looking at the PR can rule it out.
    // Close-outs are included: if the holder's PR merged, the holder is the
    // session that should close it, and it will.
    //
    // Surfaced as a blocked row, never silently dropped — the GH-1977
    // precedent, and for its reason: a row that simply vanished from the queue
    // would be indistinguishable from one that merged.
    const hold = lease?.(c.number) ?? null;
    if (hold) {
      blocked.push({
        number: c.number,
        title: c.title,
        pr: c.openPrs[0]?.number ?? null,
        reason: "local-session-active",
        // Self-clearing, unlike convergence-stalled: the lock ages out on
        // RALPH_LOCK_TTL_MIN with no human in the loop, which is the answer to
        // "a dead session blocks deliver forever".
        windowExpiresAt: hold.expiresAt,
        lease: hold,
      });
      continue;
    }
    if (c.prs.length === 0) {
      // Rollup-advanced epic parents and human-placed items — not deliver's
      // business; they never reach the signal checks.
      blocked.push({ number: c.number, title: c.title, pr: null, reason: "no-pr" });
      continue;
    }
    const open = c.openPrs;
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
  const ordered = [...closeouts, ...confirmed, ...retries];

  // Convergence stop (GH-1977). A stalled or cap-spent review loop is work an
  // unattended lane must stop PICKING UP — it will otherwise re-request a
  // review every retry window forever, which is the budget #1849 measured and
  // could not stop with prose. It is held out of `queue` and surfaced as its
  // own blocked row rather than withheld silently: a stalled PR that simply
  // vanished would read exactly like one that merged.
  //
  // Nothing here touches the merge path — #1849's split is intact. `next` is
  // still the driver's judgment; this only stops a lane nobody is watching
  // from spending its budget on a loop that has already stopped converging.
  //
  // Budgeted, in queue order, and only rows carrying a PR: the check is 3 API
  // reads per PR and the ranking walk runs at the 1-pt floor (GH-1803). Rows
  // past the budget keep their classification — the status quo, which is what
  // an ungated rule means.
  const queue: DeliverRow[] = [];
  let convBudget = convergence === null ? 0 : opts.convergenceMax;
  for (const row of ordered) {
    // Reviewer rate-limited (audit B7): the gate's own text says the external
    // reviewer cannot answer right now, so a session dispatched at this row
    // would only rediscover the wait. Its own blocked row — never withheld
    // silently — and self-clearing: the next pass re-reads the gate, and a
    // reviewer that answered stops matching. Matched on the probe's recorded
    // text, no new API read; nothing here escalates (the measure/decide split).
    if (/rate.?limit/i.test(`${row.verdict ?? ""} ${row.gate ?? ""}`)) {
      blocked.push({
        number: row.number,
        title: row.title,
        pr: row.pr,
        reason: "reviewer-rate-limited",
        verdict: row.verdict ?? null,
        gate: row.gate ?? null,
        deltaAt: row.deltaAt ?? null,
        windowExpiresAt: null,
        detail: row.gate ?? row.verdict ?? "",
      });
      continue;
    }
    if (convBudget <= 0 || row.pr === null) {
      queue.push(row);
      continue;
    }
    convBudget--;
    const v = convergence!(row.pr);
    if (v === null || !CONVERGENCE_STOP.has(v.verdict)) {
      queue.push(row);
      continue;
    }
    blocked.push({
      number: row.number,
      title: row.title,
      pr: row.pr,
      reason: "convergence-stalled",
      verdict: row.verdict ?? null,
      gate: row.gate ?? null,
      deltaAt: row.deltaAt ?? null,
      // Only a human clears it — the remedy is `board move NNN human-needed`,
      // which is the driver's call and not a window that expires.
      windowExpiresAt: null,
      convergence: v.verdict,
      detail: v.detail,
    });
  }
  return { next: queue[0] ?? null, queue, blocked };
}

const DELIVER_CHUNK = 10;

/** All phase A reads off a linked PR. Both linkage connections are nested two
 *  deep (`refs` → `associatedPullRequests`), and GraphQL cost tracks the
 *  PRODUCT of the `first:` values down that nesting — so anything selected here
 *  is charged 10x-100x over. Facts go in phase B, under a single node. */
const DELIVER_PR_LINK = `id number state`;

/** Everything one PR contributes to the cheap checks, in one selection.
 *  Selected ONLY under a top-level `node(id:)` alias (phase B): a single node
 *  multiplies nothing, so this costs ~212 nodes per PR flat. */
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

/** Phase B: facts for the OPEN PRs of one chunk, keyed by NODE ID.
 *
 *  Split out of the issue document (GH-1811) because cost tracks the product of
 *  the `first:` values down a nesting, and these facts used to hang two
 *  connections deep under `refs` → `associatedPullRequests`: 21,310 nodes and
 *  55 points for ONE candidate, measured. Under `node(id:)` the same selection
 *  is one node — 10 PRs cost 6 points total.
 *
 *  By id and not by number, with no `repository` scope: a closing reference can
 *  name a PR in ANOTHER repo, where that number is a different PR or none. */
function fetchDeliverPrFacts(ctx: Ctx, ids: string[]): Map<string, DeliverPrFacts> {
  const out = new Map<string, DeliverPrFacts>();
  for (let start = 0; start < ids.length; start += DELIVER_CHUNK) {
    const chunk = ids.slice(start, start + DELIVER_CHUNK);
    const decls = chunk.map((_, k) => `$p${k}: ID!`).join(", ");
    const aliases = chunk
      .map((_, k) => `p${k}: node(id: $p${k}) { ... on PullRequest { ${DELIVER_PR_FACTS} } }`)
      .join("\n");
    const vars: Record<string, unknown> = {};
    chunk.forEach((id, k) => {
      vars[`p${k}`] = id;
    });
    const data: any = ghGraphQL(ctx, `query(${decls}) {\n${aliases}\n}`, vars);
    chunk.forEach((id, k) => {
      const node = data[`p${k}`];
      if (node?.number) out.set(id, prFactsFrom(node));
    });
  }
  return out;
}

/** Batched detail fetch for the In Review candidates: two GraphQL documents
 *  per DELIVER_CHUNK candidates — issue facts + PR linkage, then facts for the
 *  open PRs that linkage found — never one ad-hoc call per signal per
 *  candidate (§4.2 cost bound). */
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
          closedByPullRequestsReferences(first: 10) { nodes { ${DELIVER_PR_LINK} } }
          projectItems(first: 10) { nodes { project { id } fieldValues(first: 20) { nodes {
            ... on ProjectV2ItemFieldSingleSelectValue {
              updatedAt field { ... on ProjectV2FieldCommon { name } }
            } } } } }
        }
        b${k}: refs(refPrefix: "refs/heads/", query: $h${k}, first: 10) {
          nodes {
            name
            associatedPullRequests(first: 10, states: [OPEN, MERGED, CLOSED]) {
              nodes { ${DELIVER_PR_LINK} }
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
      const pending: DeliverCandidate[] = [];
      chunk.forEach((it, k) => {
        const issue = repo[`d${k}`];
        if (!issue) return; // deleted/foreign mid-walk — absent, not invented
        const byNumber = new Map<number, DeliverPrLink>();
        for (const n of issue.closedByPullRequestsReferences?.nodes ?? []) {
          if (n?.number) byNumber.set(n.number, { id: n.id, number: n.number, state: n.state });
        }
        for (const ref of repo[`b${k}`]?.nodes ?? []) {
          // The substring filter is GitHub's; this is ours. A ref that does
          // not PARSE as this issue's branch is a coincidence of digits
          // (`feature/GH-18070`, `chore/fix-1807-typo`), not linkage.
          if (parseBranchName(ref?.name ?? "")?.issue !== it.number) continue;
          for (const n of ref?.associatedPullRequests?.nodes ?? []) {
            if (n?.number && !byNumber.has(n.number)) {
              byNumber.set(n.number, { id: n.id, number: n.number, state: n.state });
            }
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
        pending.push({
          number: issue.number,
          title: issue.title ?? "",
          prs: [...byNumber.values()],
          openPrs: [],
          stateUpdatedAt: stateValue?.updatedAt ?? null,
          lastCommentAt: commentTimes[commentTimes.length - 1] ?? null,
          marker: parseDeliverMarker(comments.map((c) => c.body)),
        });
      });

      // Phase B — facts, for the open PRs only. A chunk whose candidates have
      // none (all merged, or PR-less) skips the call entirely.
      const openIds = [
        ...new Set(pending.flatMap((c) => c.prs.filter((p) => p.state === "OPEN").map((p) => p.id))),
      ];
      const facts = openIds.length
        ? fetchDeliverPrFacts(ctx, openIds)
        : new Map<string, DeliverPrFacts>();
      for (const c of pending) {
        c.openPrs = c.prs
          .filter((p) => p.state === "OPEN")
          .map((p) => {
            const f = facts.get(p.id);
            // Fail closed. An open PR with no facts must never be dropped
            // silently: an empty `openPrs` is the CLOSE-OUT branch, so a
            // swallowed miss would tell the deliver lane to close an issue
            // whose PR is still open. Phase A saw this PR moments ago, so a
            // miss is a broken read, not a state — and it says so.
            if (!f) {
              throw new Error(
                `deliver: PR #${p.number} (${p.id}) was OPEN in the linkage read but ` +
                  `returned no facts — refusing to classify #${c.number} on a partial read`,
              );
            }
            return f;
          })
          // A PR that merged BETWEEN the two calls is legitimately gone from
          // the open set: phase B is the fresher read and wins, so the item
          // classifies as a close-out on truth rather than on stale facts.
          .filter((f) => f.state === "OPEN");
        out.push(c);
      }
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
  convergenceOverride?: ConvergenceProbe | null,
): DeliverQueueResult {
  // The lane filters on board state and hands {number, title} to the
  // candidate fetch — neither labels nor dependency edges are ever read, so
  // the walk runs at the 1-point floor (GH-1803).
  // Own-repo open items only, and the walk is rooted at them (GH-1814): the
  // lane's inputs are all open by definition, so the project scan's closed
  // half was pure history it paid for and discarded.
  const inReview = listOwnOpenItems(ctx, QUEUE_SELECT_MINIMAL)
    .filter((i) => i.state === "In Review");
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
  let conv: ConvergenceProbe | null;
  if (convergenceOverride !== undefined) {
    conv = convergenceOverride;
  } else {
    // Detect-if-present, like the merge gate above: a host repo that does not
    // ship the rule gets the pre-GH-1977 selector unchanged.
    const convSh =
      process.env.RALPH_REVIEW_CONVERGENCE_SH ??
      join(ctx.repoRoot, "scripts", "review-convergence.sh");
    conv = existsSync(convSh)
      ? (pr: number) => {
          const r = ctx.exec(["bash", convSh, String(pr)]);
          return parseConvergenceVerdict(r.stdout);
        }
      : null;
  }
  // GH-1929. Unbudgeted, unlike the convergence probe: one `readdir` for the
  // whole pass and no API call at all, so there is nothing here to ration.
  return classifyDeliver(cands, opts, ctx.now(), probe, conv, localSessionLease(ctx));
}

// ---------------------------------------------------------------------------
// Card signals (GH-2062) — the viewer's read.
//
// `deliver-queue` is a SELECTOR and is deliberately not this. Three reasons it
// cannot serve a card marking, none of them a defect in it:
//
//   1. It runs the merge gate. The CLI builds a probe that shells
//      `merge-pr.sh <PR> --dry-run` per open linked PR, plus
//      `review-convergence.sh` per PR. GH-1803's 1-point floor is a fact about
//      the ITEM WALK, not about the command. Polling that from a viewer is the
//      shape GH-1817 recorded driving the GraphQL budget to 0/5000, and
//      contract rule 7 says gates are RUN, not predicted — a chip is not a
//      decision anyone asked the gate to make.
//   2. `DeliverRow.pr` is null on `no-open-pr` and `settling` — exactly the
//      rows whose PRs are all merged or all closed, i.e. the population the
//      purple and red inks exist for. Correct for a selector (merged-vs-closed
//      is the session's judgment) and useless as a source of PR fate.
//   3. `fetchDeliverCandidates` reads `comments(last: 50)` and
//      `projectItems.fieldValues` per candidate — cost a chip never reads.
//
// So this is its own read: linkage plus four scalars, no subprocess. It
// answers "what is on the card", never "what should happen next".
// ---------------------------------------------------------------------------

/** One linked PR as a card marking. `checks`/`mergeable` are null when GitHub
 *  did not answer — a rollup is absent until a check runs, and mergeability is
 *  computed lazily. Null is NOT green: `prReady` requires the positive fact. */
export interface CardPr {
  number: number;
  state: "OPEN" | "MERGED" | "CLOSED";
  merged: boolean;
  /** `statusCheckRollup.state` — EXPECTED | ERROR | FAILURE | PENDING |
   *  SUCCESS. A scalar on a non-connection object, so it is free of the
   *  GH-1811 nesting hazard: measured live at cost 1, nodeCount 0. */
  checks: string | null;
  /** MERGEABLE | CONFLICTING | UNKNOWN. UNKNOWN is the transient GitHub
   *  returns while it recomputes, which is why only CONFLICTING demotes. */
  mergeable: string | null;
}

export interface CardPrRow {
  number: number; // the ISSUE
  prs: CardPr[];
}

/** An epic parent's child rollup. `truncated` is the fail-closed flag the
 *  renderer needs: 2/4 read off a truncated child list is not 2/4. */
export interface CardEpic {
  number: number;
  title: string;
  done: number;
  total: number;
  truncated: boolean;
}

export interface CardSignalsResult {
  inReview: CardPrRow[];
  epics: CardEpic[];
  /** In Review issues whose PR linkage came back TRUNCATED — GitHub had more
   *  closing references, more matching branches, or more PRs on one branch than
   *  the page asked for. They are held OUT of `inReview` rather than answered
   *  from a partial list, because an omitted live PR would let the newest
   *  merged one win the chip and render an in-flight unit as landed. Absence
   *  from `inReview` is what the cockpit already draws as unread; this array is
   *  so a human running the verb can see WHICH, rather than reading the same
   *  silence a deleted issue produces. */
  unreadable: number[];
}

/** Linkage + the four scalars, per In Review issue. Selected inside two
 *  connections (`closedByPullRequestsReferences`, and the PRs hanging off
 *  `refs`), which is safe precisely because none of these is itself a
 *  connection — GH-1811's 607-point document was `contexts(first: 100)` nested
 *  three deep, and nodeCount is the PRODUCT of the `first:` values down each
 *  nesting. Scalars and plain objects multiply nothing. */
const CARD_PR_FIELDS = `number state merged mergeable statusCheckRollup { state }`;

function cardPrFrom(n: any): CardPr {
  return {
    number: n.number,
    state: n.state,
    merged: n.merged === true,
    checks: n.statusCheckRollup?.state ?? null,
    mergeable: n.mergeable ?? null,
  };
}

/** The card markings whose data must be fetched: In Review PR fate and the
 *  epic rollups for the distinct own-repo parents of the open board.
 *
 *  Both halves ride the ONE open walk the caller's board poll already paid for
 *  (`listOwnOpenItems` at the 1-point floor, served from the item cache when
 *  it is warm), then one GraphQL document each. The PR linkage is the same
 *  union `deliver` uses — closing references ∪ the branch convention — because
 *  a chip that disagreed with the lane about which PR belongs to an issue
 *  would be worse than no chip. */
export function cardSignals(ctx: Ctx): CardSignalsResult {
  const open = listOwnOpenItems(ctx, QUEUE_SELECT_MINIMAL);
  return withCache(ctx, () => {
    const linkage = cardPrLinkage(
      ctx,
      open.filter((i) => i.state === "In Review").map((i) => i.number),
    );
    return {
      ...linkage,
      epics: cardEpicRollups(
        ctx,
        [...new Set(open.map((i) => i.parentNumber).filter((n): n is number => n != null))],
      ),
    };
  });
}

function cardPrLinkage(
  ctx: Ctx,
  numbers: number[],
): { inReview: CardPrRow[]; unreadable: number[] } {
  const out: CardPrRow[] = [];
  const unreadable: number[] = [];
  for (let start = 0; start < numbers.length; start += DELIVER_CHUNK) {
    const chunk = numbers.slice(start, start + DELIVER_CHUNK);
    const decls = chunk.map((_, k) => `$n${k}: Int!, $h${k}: String!`).join(", ");
    // `c`/`r` aliases, deliberately not deliver's `d`/`b`: the two documents
    // are separable in the fixtures and in any cost probe, and a reader of one
    // can never be handed the other's payload.
    const aliases = chunk
      .map(
        (_, k) => `
      c${k}: issue(number: $n${k}) {
        number
        closedByPullRequestsReferences(first: 10) {
          pageInfo { hasNextPage }
          nodes { ${CARD_PR_FIELDS} }
        }
      }
      r${k}: refs(refPrefix: "refs/heads/", query: $h${k}, first: 10) {
        pageInfo { hasNextPage }
        nodes {
          name
          associatedPullRequests(first: 10, states: [OPEN, MERGED, CLOSED]) {
            pageInfo { hasNextPage }
            nodes { ${CARD_PR_FIELDS} }
          }
        }
      }`,
      )
      .join("\n");
    const vars: Record<string, unknown> = { owner: ctx.cfg.owner, repo: ctx.cfg.repo };
    chunk.forEach((n, k) => {
      vars[`n${k}`] = n;
      // GitHub's ref filter is a SUBSTRING match, so the bare number spans
      // both branch grammars in one connection — and returns coincidences
      // (`feature/GH-20620`), which parseBranchName rejects below.
      vars[`h${k}`] = String(n);
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
    chunk.forEach((num, k) => {
      const issue = repo[`c${k}`];
      // Absent, not invented: an issue deleted or made invisible mid-walk
      // yields no row, and the renderer draws that as "not read" rather than
      // as "no PR" — the whole point of the grey `?`.
      if (!issue) return;
      const refs = repo[`r${k}`];
      // Fail closed on a truncated page, exactly as the blocker, child and
      // label reads do. These connections are UNPAGINATED, so a `hasNextPage`
      // means GitHub had more linkage than we asked for — and the omitted PR
      // is as likely to be the live one as any other. Answering from what came
      // back would let an older merged PR win the chip and paint an in-flight
      // unit as landed, which is a stronger claim than the read supports.
      if (
        issue.closedByPullRequestsReferences?.pageInfo?.hasNextPage ||
        refs?.pageInfo?.hasNextPage ||
        (refs?.nodes ?? []).some((r: any) => r?.associatedPullRequests?.pageInfo?.hasNextPage)
      ) {
        unreadable.push(num);
        return;
      }
      const byNumber = new Map<number, CardPr>();
      for (const n of issue.closedByPullRequestsReferences?.nodes ?? []) {
        if (n?.number) byNumber.set(n.number, cardPrFrom(n));
      }
      for (const ref of refs?.nodes ?? []) {
        if (parseBranchName(ref?.name ?? "")?.issue !== num) continue;
        for (const n of ref?.associatedPullRequests?.nodes ?? []) {
          if (n?.number && !byNumber.has(n.number)) byNumber.set(n.number, cardPrFrom(n));
        }
      }
      out.push({ number: num, prs: [...byNumber.values()] });
    });
  }
  return { inReview: out, unreadable };
}

/** Children per rollup round trip. Matches `fetchIssue`'s `subIssues(first: 50)`
 *  so the two reads agree about when a child list is truncated. */
const CARD_EPIC_CHILDREN = 50;
const CARD_EPIC_CHUNK = 10;

function cardEpicRollups(ctx: Ctx, parents: number[]): CardEpic[] {
  const out: CardEpic[] = [];
  for (let start = 0; start < parents.length; start += CARD_EPIC_CHUNK) {
    const chunk = parents.slice(start, start + CARD_EPIC_CHUNK);
    const decls = chunk.map((_, k) => `$e${k}: Int!`).join(", ");
    const aliases = chunk
      .map(
        (_, k) => `
      e${k}: issue(number: $e${k}) {
        number title
        subIssues(first: ${CARD_EPIC_CHILDREN}) {
          pageInfo { hasNextPage }
          nodes { number state }
        }
      }`,
      )
      .join("\n");
    const vars: Record<string, unknown> = { owner: ctx.cfg.owner, repo: ctx.cfg.repo };
    chunk.forEach((n, k) => {
      vars[`e${k}`] = n;
    });
    const data: any = ghGraphQL(
      ctx,
      `query($owner: String!, $repo: String!, ${decls}) {
        repository(owner: $owner, name: $repo) { ${aliases} }
      }`,
      vars,
    );
    const repo: any = data.repository ?? {};
    chunk.forEach((num, k) => {
      const e = repo[`e${k}`];
      if (!e) return;
      const kids: any[] = e.subIssues?.nodes ?? [];
      out.push({
        number: num,
        title: e.title ?? "",
        // CLOSED, not "board state Done": `parentCheck`'s own rollup rule is
        // "all children closed", and reading the board state per child would
        // mean a `fieldValues` connection under a `subIssues` connection —
        // the nesting GH-1811 measured at hundreds of points.
        done: kids.filter((c) => c?.state === "CLOSED").length,
        total: kids.length,
        truncated: e.subIssues?.pageInfo?.hasNextPage ?? false,
      });
    });
  }
  return out;
}

/** One own-repo issue closed as completed inside the audit window. */
export interface DoneItem {
  number: number;
  repo: string; // nameWithOwner — own-repo by construction; carried for URLs
  title: string;
  closedAt: string;
}

export interface DoneResult {
  windowDays: number;
  since: string;
  items: DoneItem[];
}

/** Board items closed as COMPLETED inside `RALPH_AUDIT_DAYS` — the Done view.
 *
 *  `board list` cannot answer this: it is open-issues-only by construction
 *  (GH-1814 moved the lanes off the project scan), so `--state Done` returns
 *  an empty list rather than a Done column.
 *
 *  NOT_PLANNED is excluded, which is `reconcile`'s own rule verbatim (closed +
 *  NOT_PLANNED → Canceled, else Done) rather than a second opinion about what
 *  Done means. Newest first: the window is a recency view, and its consumer
 *  reads the top of it.
 *
 *  The window is a WINDOW. Every consumer must say so — a bare "Done" header
 *  over 14 days of closes claims a completeness this read does not have. */
export function recentDone(ctx: Ctx, opts: TendOpts = parseTendOpts()): DoneResult {
  const since = new Date(ctx.now().getTime() - opts.auditDays * 86_400_000);
  const items = listOwnRecentClosed(ctx, since)
    .filter((c) => c.stateReason !== "NOT_PLANNED")
    .map((c) => ({
      number: c.number,
      repo: `${ctx.cfg.owner}/${ctx.cfg.repo}`,
      title: c.title,
      closedAt: c.closedAt,
    }))
    .sort((a, b) => (a.closedAt < b.closedAt ? 1 : a.closedAt > b.closedAt ? -1 : b.number - a.number));
  return { windowDays: opts.auditDays, since: since.toISOString(), items };
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

/** The dep-judgment marker (GH-2136) — the durable "no edge here" record.
 *  `deps-unwired` surfaces unjudged candidate pairs; wiring an edge is
 *  observable (blockedBy), but a judgment of "these are NOT dependent" changes
 *  nothing the board can see, so without a written record the same pair would
 *  re-surface every pass forever — the GH-1777 argument, one surface over.
 *  Written by `board dep NNN --on MMM --dismiss`, never hand-composed
 *  (GH-1826's quoting trap; GH-2129's no-CLI-writer class).
 *  Payload: `{"target": N, "dismissed": [M, ...], "at": iso, "note"?: "…"}`.
 *  Judgments are CUMULATIVE across markers — each covers specific pairs, so
 *  last-wins semantics would silently un-judge earlier pairs. */
export const TEND_DEP_JUDGED_MARKER = "<!-- ralph-tend:v1 dep-judged -->";

/** Canonical undirected pair key — a dismissal clears BOTH endpoints' rows. */
export const depPairKey = (a: number, b: number): string =>
  `${Math.min(a, b)}|${Math.max(a, b)}`;

/** Every dismissed pair a comment trail records, as canonical pair keys.
 *  The payload's own `target` binds the pair — not the issue the trail came
 *  from — so a quoted marker inside a code span is masked (lastMarkerIndex)
 *  and a payload that names no target contributes nothing. */
export function dismissedDepPairs(comments: string[]): Set<string> {
  const pairs = new Set<string>();
  for (const body of comments) {
    if (lastMarkerIndex(body, TEND_DEP_JUDGED_MARKER) < 0) continue;
    const t = /"target"\s*:\s*(\d+)/.exec(body);
    const d = /"dismissed"\s*:\s*\[([\d,\s]*)\]/.exec(body);
    if (!t || !d) continue;
    const target = Number(t[1]);
    for (const m of d[1].matchAll(/\d+/g)) pairs.add(depPairKey(target, Number(m[0])));
  }
  return pairs;
}

export const DEP_OVERLAP_MIN_DEFAULT = 0.2;

/** RALPH_DEP_OVERLAP_MIN — the `deps-unwired` qualification threshold on the
 *  scale-free `overlap` coefficient. A fact about a board's vocabulary
 *  density, not doctrine (measured here 2026-08-24: max 0.36; ≥0.2 → 5
 *  pairs; ≥0.1 → 40). Out-of-range values warn and use the default — 0 would
 *  put the whole backlog in the category, >1 is unsatisfiable. */
export function parseDepOverlapMin(raw: string | undefined): number {
  if (raw === undefined) return DEP_OVERLAP_MIN_DEFAULT;
  const v = Number(raw);
  if (Number.isFinite(v) && v > 0 && v <= 1) return v;
  process.stderr.write(
    `warn: RALPH_DEP_OVERLAP_MIN="${raw}" is not in (0, 1] — using ${DEP_OVERLAP_MIN_DEFAULT}\n`,
  );
  return DEP_OVERLAP_MIN_DEFAULT;
}

/** Blank every character of a span except its newlines, so masking a region
 *  preserves every later index — marker positions within one comment are
 *  COMPARED (last one wins), so a mask that shifted offsets would reorder them. */
const blankKeepNewlines = (s: string): string => s.replace(/[^\n]/g, " ");

/** A comment body with fenced blocks and inline code spans masked out (GH-1826).
 *  A marker inside a code span is a comment DISCUSSING the protocol, not
 *  speaking it — #1777, the issue that implemented the proposal marker, quoted
 *  it three times in backticks and thereby filed a phantom proposal against
 *  itself that no disposition could clear. */
export function maskCode(body: string): string {
  let fence: string | null = null;
  return body
    .split("\n")
    .map((line) => {
      const opener = /^\s*(`{3,}|~{3,})/.exec(line);
      if (fence !== null) {
        if (opener && line.trim().startsWith(fence)) fence = null;
        return blankKeepNewlines(line);
      }
      if (opener) {
        fence = opener[1];
        return blankKeepNewlines(line);
      }
      return line.replace(/`+[^`\n]*`+/g, blankKeepNewlines);
    })
    .join("\n");
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Index of the LAST line that OPENS with `marker` (outside code), or -1
 *  (GH-1826). Two narrowings, both load-bearing: the marker must start a line —
 *  every marker this protocol writes leads its own comment line, while prose
 *  reaches it mid-sentence or indented under a bullet — and code spans are
 *  masked, since backticks are how prose quotes one. Trailing text on the
 *  marker's own line is tolerated: it is still the protocol speaking, and
 *  audit comments in the wild carry a word after the marker. Returning an index
 *  rather than a boolean keeps `pendingProposal`'s within-comment ordering. */
export function lastMarkerIndex(body: string, marker: string): number {
  const re = new RegExp(`^${escapeRegExp(marker)}`, "gm");
  const masked = maskCode(body);
  let last = -1;
  for (let m = re.exec(masked); m !== null; m = re.exec(masked)) {
    last = m.index;
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return last;
}

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
    const proposed = lastMarkerIndex(body, TEND_PROPOSAL_MARKER);
    const resolved = lastMarkerIndex(body, TEND_RESOLUTION_MARKER);
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

/** The newest ACCEPTED resolution no later proposal supersedes (audit B9).
 *  `resolve --accept` records a decision the board cannot otherwise observe —
 *  the item still needs its disposition performed (`move done` / `cancel`),
 *  and an accepted-but-unmoved item rendered exactly like an unactioned one.
 *  Excluded: resolutions whose payload says `actioned` (the reopen path — the
 *  reopen IS the action), and, for legacy payloads, notes naming `board
 *  reopen`. */
export function acceptedUnactioned(comments: string[]): { at: string | null } | null {
  let accepted: { at: string | null } | null = null;
  for (const body of comments) {
    const proposed = lastMarkerIndex(body, TEND_PROPOSAL_MARKER);
    const resolved = lastMarkerIndex(body, TEND_RESOLUTION_MARKER);
    if (proposed < 0 && resolved < 0) continue;
    if (resolved > proposed) {
      const isAccepted = /"disposition"\s*:\s*"accepted"/.test(body);
      const isActioned = /"actioned"\s*:\s*true/.test(body) || /Resolved by `board reopen`/.test(body);
      if (isAccepted && !isActioned) {
        const m = /"at"\s*:\s*"([^"]+)"/.exec(body);
        const t = m ? new Date(m[1]).getTime() : NaN;
        accepted = { at: Number.isFinite(t) ? m![1] : null };
      } else {
        accepted = null;
      }
    } else {
      accepted = null; // a newer proposal re-arms `pending`; nothing accepted stands
    }
  }
  return accepted;
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
  /** GH-2136: deps-unwired rows only — the judge's inputs travel with the
   *  row, so acting on the queue needs no second read. */
  candidates?: DepCandidate[];
}

export interface TendQueueResult {
  next: TendRow | null;
  queue: TendRow[];
  blocked: TendRow[]; // shape parity with next/deliver-queue; tend blocks nothing
  /** GH-2202: Intake items a snooze (Defer with a future recheck) is currently
   *  withholding from `unformed`. Counted, never silent — a suppressed
   *  reminder that leaves no trace reads identical to a healthy queue
   *  (the GH-1945 rule). */
  snoozed: number;
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
  /** GH-2136: number → its unjudged high-overlap candidates, computed by the
   *  caller (depsUnwiredMap) where the bodies and dismissal trails live.
   *  Absent/empty = the category is empty — this stays a pure classifier. */
  depsUnwired: Map<number, DepCandidate[]> = new Map(),
): TendQueueResult {
  const ms = (iso: string | null | undefined): number | null => {
    if (!iso) return null;
    const t = new Date(iso).getTime();
    return Number.isFinite(t) ? t : null;
  };
  const dayMs = 86_400_000;
  const backlog = open.filter((i) => i.state === "Backlog");
  const formation = open.filter((i) => i.state === "Backlog" || i.state === "Intake");
  const seen = new Set<number>(); // one row per issue — first category (spec order) wins
  const rows: { [K in TendCategory]: TendRow[] } = {
    proposed: [],
    "stale-body": [],
    "deps-cleared": [],
    "deps-truncated": [],
    "deps-unwired": [],
    unformed: [],
    "done-audit": [],
  };
  const push = (
    cat: TendCategory,
    i: { number: number; title?: string },
    at: string | null,
    candidates?: DepCandidate[],
  ) => {
    if (seen.has(i.number)) return;
    seen.add(i.number);
    rows[cat].push({
      number: i.number,
      title: i.title ?? "",
      category: cat,
      at,
      ...(candidates ? { candidates } : {}),
    });
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
  // 2b. Unjudged high-overlap dependency candidates (GH-2136) — the third
  //     deps-* sibling, deliberately NOT folded into `unformed` (which means
  //     "missing Priority or Estimate" — a different question; collapsing
  //     them would make a clean sweep of formation work silently assert
  //     dependency hygiene nobody checked). The map is computed by the
  //     caller; spec order means proposed/stale-body/deps-cleared/truncated
  //     outrank it via `seen`.
  for (const i of backlog) {
    const cands = depsUnwired.get(i.number);
    if (cands && cands.length > 0) push("deps-unwired", i, i.updatedAt ?? null, cands);
  }
  // 3. Formation candidates: likely unformed intake. A MISSING PRIORITY counts
  //    equally with a missing estimate (GH-1796): `priorityRank` sorts null
  //    behind every real priority, which is the honest reading — nobody judged
  //    this item — but it is a forcing function only if something forces. A
  //    null-priority item that already has an estimate is ranked last by `next`
  //    and named by no lane, so it is not deprioritized, it is lost. The
  //    remedy is one flag (`board priority NNN P2`), which is exactly why the
  //    ranking does not need to invent a default on the item's behalf.
  //    Truncated field values fail closed: absence GitHub never asserted is not
  //    evidence of an unset field.
  //    Intake items join this category with their age (GH-2077): an intake
  //    item that has sat unformed for a week is exactly what tend exists to
  //    find, and the tier's whole point is that pending intake stops being
  //    invisible. The predicate is unchanged — an Intake item that already
  //    carries a Priority and an Estimate is formed, and its only remaining
  //    need is a human's approval, which is doctor's `intake-stale` line.
  let snoozed = 0;
  for (const i of formation) {
    const t = ms(i.createdAt);
    const old = t !== null && now.getTime() - t > UNFORMED_DAYS * dayMs;
    if (
      old &&
      (!i.estimate || !i.priority) &&
      !i.fieldValuesTruncated &&
      !i.hasParent &&
      i.openBlockers.length === 0 &&
      i.closedBlockers.length === 0 &&
      !i.blockersTruncated
    ) {
      // GH-2202: a snoozed Intake item — Defer with a FUTURE recheck — is
      // withheld until the recheck instant, then resurfaces with its full age
      // (`at` stays createdAt: the snooze suppressed the reminder, never the
      // fact). A recheck-less defer does not snooze — an untimed snooze is
      // invisible-forever, which is why the write path refuses one — and
      // Backlog items are untouched: their defer already parks ranking, and
      // an unformed-but-deferred Backlog row is still tend's business.
      if (i.state === "Intake" && i.defer?.recheck && i.defer.recheck.getTime() > now.getTime()) {
        snoozed++;
        continue;
      }
      push("unformed", i, i.createdAt!);
    }
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
    if (c.comments.some((b) => lastMarkerIndex(b, TEND_MARKER) >= 0)) continue;
    push("done-audit", c, c.closedAt);
  }

  const oldestFirst = (a: TendRow, b: TendRow) => {
    const ta = ms(a.at) ?? 0;
    const tb = ms(b.at) ?? 0;
    return ta - tb || a.number - b.number;
  };
  const queue = (
    [
      "proposed",
      "stale-body",
      "deps-cleared",
      "deps-truncated",
      "deps-unwired",
      "unformed",
      "done-audit",
    ] as const
  ).flatMap((cat) => rows[cat].sort(oldestFirst));
  return { next: queue[0] ?? null, queue, blocked: [], snoozed, observationSlot: true };
}

/** The tend lane's typed selector. Done-audit comment trails ride the same
 *  batched history fetch doctor uses — no per-item round trips, no MCP. */
export function tendQueue(ctx: Ctx, opts: TendOpts = parseTendOpts()): TendQueueResult {
  // classifyTend reads dependency edges (deps-cleared / deps-truncated) and
  // never labels — 2 pts/page instead of 3 (GH-1803). Both halves are
  // issues-rooted (GH-1891): the open one joins `next`/`deliver-queue` on
  // GH-1814's read, and the Done audit's window is cut server-side rather than
  // filtered out of a scan over every item the board has ever held.
  const open = listOwnOpenItems(ctx, QUEUE_SELECT_NO_LABELS);
  const dayMs = 86_400_000;
  const recent = listOwnRecentClosed(
    ctx,
    new Date(ctx.now().getTime() - opts.auditDays * dayMs),
  );
  const trails = fetchCommentTrails(ctx, recent.map((c) => c.number));
  const closed = recent.map((c) => ({
    number: c.number,
    title: c.title,
    closedAt: c.closedAt,
    comments: trails.get(c.number) ?? [],
  }));
  // Proposal markers live in the comment trails of OPEN items, which this
  // selector does not fetch. Bound that cost by classifying first and reading
  // only the trails of items already in the queue — the only items a tend pass
  // could have proposed against — then re-classifying with the cursor. Both
  // calls are pure; the fetch is what costs. Honest limit: a proposal whose
  // item no longer qualifies for any category (it was formed or updated since)
  // drops out of this queue — doctor's `tend-proposal-stale` line, which reads
  // every open item's trail, is the backstop that keeps it visible.
  // deps-unwired inputs (GH-2136): one bodies batch over the unclaimed
  // Backlog (1 pt / 50, zero nested connections) + in-memory pairwise
  // scoring. An unreadable bodies read PROPAGATES — typed like every other
  // failed selector read — because a category that silently emptied on a
  // failed fetch would render exactly like a judged-clean board.
  const pool = open
    .filter((i) => i.state === "Backlog" && !i.claim)
    .map((i) => ({
      number: i.number,
      title: i.title,
      openBlockers: i.openBlockers ?? [],
      closedBlockers: i.closedBlockers ?? [],
      blockersTruncated: i.blockersTruncated,
      parentNumber: i.parentNumber ?? null,
    }));
  const minOverlap = parseDepOverlapMin(process.env.RALPH_DEP_OVERLAP_MIN);
  const cap = parseDepCandidatesCap(process.env.RALPH_DEP_CANDIDATES_MAX);
  const bodies =
    pool.length >= 2 ? fetchIssueBodies(ctx, pool.map((i) => i.number)) : new Map<number, { title: string; body: string }>();
  const unwired = depsUnwiredMap(pool, bodies, new Set(), minOverlap, cap);
  const first = classifyTend(open, closed, opts, ctx.now(), new Map(), unwired);
  const candidates = new Set(open.map((i) => i.number));
  const numbers = first.queue.map((r) => r.number).filter((n) => candidates.has(n));
  const proposals = new Map<number, string | null>();
  // Dismissed pairs ride the SAME trail fetch as the proposal cursor. Honest
  // limit: only pass-1 queue rows' trails are read, so a dismissal recorded
  // on an item outside the queue is invisible here — but every unjudged pair
  // puts BOTH endpoints in the queue, so the judging item's own trail is
  // fetched whenever the pair still surfaces. Doctor reads the full pool's
  // trails and is the backstop.
  const dismissed = new Set<string>();
  if (numbers.length > 0) {
    const openTrails = fetchCommentTrails(ctx, numbers);
    for (const n of numbers) {
      const trail = openTrails.get(n) ?? [];
      const p = pendingProposal(trail);
      if (p) proposals.set(n, p.at);
      for (const k of dismissedDepPairs(trail)) dismissed.add(k);
    }
  }
  if (proposals.size === 0 && dismissed.size === 0) return first;
  const judged =
    dismissed.size === 0 ? unwired : depsUnwiredMap(pool, bodies, dismissed, minOverlap, cap);
  return classifyTend(open, closed, opts, ctx.now(), proposals, judged);
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
  actioned = false, // true when the acceptance IS the action (the reopen path)
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
    ...(actioned ? { actioned: true } : {}),
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
// Lead arbitration (GH-2179) — who an escalation is ADDRESSED to.
//
// An escalation is the `**Decision needed**` comment transition() already
// writes; addressing it to a team's lead appends the route marker to that SAME
// comment, so the whole exchange is board-resident and one comment is
// self-contained. No route marker = human-addressed — every escalation that
// predates this, and every reality-lane correction (reconcile's apply reopen),
// is human-addressed by construction.
//
// The lead dispositions a routed escalation three ways: answer or re-steer
// (the existing `answer` verb — the answer is on record and the resuming
// session's `board claim` then disposes it by state, GH-2204), or PROMOTE
// (`board promote NNN`) — a durable
// marker comment saying "this genuinely needs the human", no state change,
// because Human Needed is already the right state; promotion changes the
// audience, not the machine.
//
// The TTL bound is computed at READ time, never by a cron: a routed
// escalation with no promotion marker and age >= RALPH_LOCK_TTL_MIN
// classifies as auto-promoted wherever it is read. Same shape as claim
// staleness — no tracking state exists to drift, and a dead lead costs
// latency, never a stranded worker. An unparseable `at` fails the same
// direction (auto-promoted): an unmeasurable clock must not strand a worker.
//
// Promotion deliberately does NOT validate C9 shape (the decision GH-2179 was
// asked to make): the TTL path cannot validate by construction — a dead lead
// plus strict validation is a stranded worker — so validating only the manual
// path would make waiting out the TTL the permissive lane and train leads not
// to promote. The escalation is `--why` prose, not a typed payload; `board
// contract validate ralph.escalation` stays the deliberate check.
// ---------------------------------------------------------------------------

/** Appended (with a fenced JSON payload `{to, lead, at}`) to the escalation
 *  comment itself when the worker addresses it to its lead. */
export const ESCALATION_ROUTE_MARKER = "<!-- ralph-escalation:v1 routed -->";

/** The lead's promotion — its own comment, after the routed escalation.
 *  Payload: `{"at": iso, "by": holder, "note"?: "…"}`. */
export const ESCALATION_PROMOTED_MARKER = "<!-- ralph-escalation:v1 promoted -->";

export interface EscalationRoute {
  route: "lead" | "human";
  /** Lead's agent name from the route payload; null when unreadable. */
  lead?: string | null;
  /** When the escalation was routed (payload `at`); null when unreadable. */
  at?: string | null;
  /** Only for route "lead": pending (the lead's queue), promoted (the lead
   *  said so), or auto-promoted (the TTL said so). */
  disposition?: "pending" | "promoted" | "auto-promoted";
  /** GH-2204: the live escalation has an **Answer** comment AFTER it and the
   *  item is still Human Needed — the answer is on record, resume pending
   *  (`board claim NNN` is the resume edge). `at` is the answer payload's
   *  timestamp, null when unreadable (pre-marker answers) — doctor ages an
   *  unreadable clock as overdue, failing toward visibility. */
  answered?: { at: string | null };
}

/** Classify the LAST escalation in a comment trail. Trail order is
 *  chronological (`comments(last: N)`, oldest→newest), so the newest
 *  `**Decision needed**` comment is the live escalation and everything before
 *  it is history — a re-escalation supersedes, in either direction. A
 *  promotion marker counts only when it lands AFTER the escalation it answers
 *  (same rule as tend's proposal/resolution pair). */
export function classifyEscalation(
  comments: string[],
  now: Date,
  ttlMin: number,
): EscalationRoute {
  let lastEsc = -1;
  let routed: { lead: string | null; at: string | null } | null = null;
  let lastProm = -1;
  let lastAns = -1;
  let ansAt: string | null = null;
  for (let i = 0; i < comments.length; i++) {
    const body = comments[i];
    if (ESCALATION_EVIDENCE.test(maskCode(body))) {
      lastEsc = i;
      if (lastMarkerIndex(body, ESCALATION_ROUTE_MARKER) >= 0) {
        const lead = /"lead"\s*:\s*"([^"]+)"/.exec(body);
        const at = /"at"\s*:\s*"([^"]+)"/.exec(body);
        const t = at ? new Date(at[1]).getTime() : NaN;
        routed = { lead: lead ? lead[1] : null, at: Number.isFinite(t) ? at![1] : null };
      } else {
        routed = null;
      }
    }
    if (ANSWER_EVIDENCE.test(maskCode(body))) {
      lastAns = i;
      const at = /"at"\s*:\s*"([^"]+)"/.exec(body);
      const t = at ? new Date(at[1]).getTime() : NaN;
      ansAt = Number.isFinite(t) ? at![1] : null;
    }
    if (lastMarkerIndex(body, ESCALATION_PROMOTED_MARKER) >= 0) lastProm = i;
  }
  // Answered = an Answer AFTER the live escalation (GH-2204). Anchored on the
  // escalation deliberately: a reconcile-reopened apply unit (no Decision
  // needed comment) is not disposed by an Answer — its remedies are evidence
  // or a cancel — so a stale Answer from a prior cycle may not read as one.
  const answered = lastEsc >= 0 && lastAns > lastEsc ? { answered: { at: ansAt } } : {};
  if (lastEsc < 0 || !routed) return { route: "human", ...answered };
  if (lastProm > lastEsc) return { route: "lead", ...routed, disposition: "promoted", ...answered };
  // Unreadable `at` → auto-promoted: fail toward the human seeing it.
  const since = routed.at ? new Date(routed.at).getTime() : NaN;
  const expired = !Number.isFinite(since) || now.getTime() - since >= ttlMin * 60_000;
  return {
    route: "lead",
    ...routed,
    disposition: expired ? "auto-promoted" : "pending",
    ...answered,
  };
}

export interface EscalationRow extends EscalationRoute {
  number: number;
  title: string;
}

/** The arbitration queue: every Human Needed item, classified. The lead's
 *  work is the `pending` rows; everything else (human-addressed, promoted,
 *  auto-promoted) is the human tier — the split `board inbox` (GH-2180)
 *  ENFORCES since GH-2218: Tier 1 admits only the human tier, so a lead's
 *  promotion writes the inbox directly and dispatch (which reads the inbox
 *  like the human does) is reachable, never a rung. Trails are fetched for
 *  the Human Needed subset only, so the read is bounded by live
 *  escalations, not board size. */
export function escalationsQueue(ctx: Ctx): EscalationRow[] {
  const items = listItems(ctx, QUEUE_SELECT_MINIMAL).filter((i) => i.state === "Human Needed");
  if (items.length === 0) return [];
  const trails = fetchCommentTrails(ctx, items.map((i) => i.number));
  return items.map((i) => ({
    number: i.number,
    title: i.title,
    ...classifyEscalation(trails.get(i.number) ?? [], ctx.now(), ctx.cfg.lockTtlMin),
  }));
}

export interface PromoteResult {
  promoted: boolean;
  /** Why nothing was posted when promoted=false. */
  reason?: "already-promoted";
  route: EscalationRoute;
}

/** The lead's promotion verb — comment-only, no state change. Refuses when
 *  the item is not in Human Needed (promotion is about a live escalation) or
 *  when the live escalation is not lead-routed (a human-addressed escalation
 *  is already in front of the human by construction). Promoting an
 *  auto-promoted escalation is allowed — it turns the TTL's implicit verdict
 *  into the lead's explicit, durable one. Idempotent: an already-promoted
 *  escalation is a noop, not an error, so a retry never double-posts. */
export function promote(ctx: Ctx, number: number, opts: { note?: string } = {}): PromoteResult {
  const issue = fetchIssue(ctx, number);
  if (issue.fieldValuesTruncated) {
    throw new RefusalError(
      `#${number} has more than ${FIELD_VALUE_PAGE} project field values — ` +
        `the state read is unreliable, refusing to promote`,
    );
  }
  if (issue.state !== "Human Needed") {
    throw new RefusalError(
      `#${number} is "${issue.state ?? "(none)"}" — promote is for Human Needed items ` +
        `(an escalation is a pause on in-flight work; there is nothing to promote here)`,
    );
  }
  const trail = fetchCommentTrails(ctx, [number]).get(number);
  if (!trail) {
    throw new Error(
      `could not read #${number}'s comment trail — cannot tell whether an escalation is routed`,
    );
  }
  const route = classifyEscalation(trail, ctx.now(), ctx.cfg.lockTtlMin);
  if (route.route !== "lead") {
    throw new RefusalError(
      `#${number}'s escalation is already addressed to the human — nothing to promote. ` +
        `(Only a lead-routed escalation promotes; \`board answer ${number} -m\` disposes it either way.)`,
    );
  }
  if (route.disposition === "promoted") return { promoted: false, reason: "already-promoted", route };
  const payload = JSON.stringify({
    at: ctx.now().toISOString(),
    by: ctx.cfg.holder,
    ...(opts.note ? { note: opts.note } : {}),
  });
  addComment(
    ctx,
    issue.nodeId,
    `**Promoted to human** (\`board\` by \`${ctx.cfg.holder}\`)` +
      (opts.note ? `:\n\n${opts.note}` : "") +
      `\n\n${ESCALATION_PROMOTED_MARKER}\n\`\`\`json\n${payload}\n\`\`\``,
  );
  return { promoted: true, route: { ...route, disposition: "promoted" } };
}

// ---------------------------------------------------------------------------
// Dependency-candidate selector (GH-2135)
// ---------------------------------------------------------------------------
//
// `board dep-candidates NNN` answers one question: which OPEN, UNCLAIMED
// Backlog items might this issue depend on (or vice versa)? It hands scored
// candidates to a judge; it NEVER writes an edge — the edge is the agent's
// act, on the record.
//
// This is one of TWO members of a family, and their biases run in OPPOSITE
// directions on purpose — do not "fix" one into the other (GH-2135):
//
//   * plugin/ralph-herdr/scripts/dep-refs.sh — prose references, biased
//     toward SILENCE, at the SPAWN surfaces (work-fleet; GH-2120 extends to
//     refill/work-next). Its caller treats a hit as a refusal, so a false
//     positive blocks real work.
//   * this selector — term overlap, biased toward RECALL, at the WRITE
//     surfaces (filing, tend). A MISSED dependency causes a wrong parallel
//     spawn and a rebase cascade; a false candidate costs one judgment call
//     an agent was already making. The output states that candidates are not
//     dependencies, so a reader cannot mistake the bias for a verdict.
//
// Scoring is document-frequency-weighted term overlap over title + body:
// a term's weight is log(N/df), so a word every open item carries ("board",
// "ralph") weighs nothing on any board without a hand-kept stopword list,
// while a term two items share and the rest lack carries the score. Rejected
// alternatives are in the design record (2026-08-23-board-work-shape-design):
// a bare skill instruction degrades silently as the backlog grows, and a
// semantic index is a subsystem for a problem term overlap probably solves.

export const DEP_CANDIDATES_CAP_DEFAULT = 10;

export const DEP_CANDIDATES_DISCLAIMER =
  "candidates are NOT dependencies — term overlap only, biased toward recall; judge each before wiring an edge";

/** Glue words that would dominate tiny populations before df-weighting has
 *  enough documents to price them. Deliberately small: df does the real work. */
const DEP_TERM_STOPWORDS = new Set([
  "the", "and", "for", "that", "this", "with", "not", "are", "was", "its",
  "has", "have", "had", "but", "when", "from", "into", "over", "then", "than",
  "each", "all", "any", "can", "cannot", "may", "must", "does", "did", "also",
  "only", "which", "what", "who", "how", "where", "why", "will", "would",
  "should", "could", "been", "being", "because", "one", "two", "here", "there",
  "never", "always", "same", "other", "our", "out", "you", "your",
]);

/** Tokenize into overlap terms: lowercase runs of [a-z0-9_-], length ≥ 3,
 *  hyphen/underscore-preserving so `dep-refs`, `tend-queue` and `GH-2120`
 *  survive as the distinctive tokens they are. */
export function depCandidateTerms(text: string): Set<string> {
  const terms = new Set<string>();
  for (const m of text.toLowerCase().matchAll(/[a-z0-9][a-z0-9_-]*/g)) {
    const t = m[0].replace(/[_-]+$/, "");
    if (t.length >= 3 && !DEP_TERM_STOPWORDS.has(t)) terms.add(t);
  }
  return terms;
}

export interface DepCandidateDoc {
  number: number;
  title: string;
  body: string;
}

export interface DepCandidate {
  number: number;
  title: string;
  score: number;
  /** Normalized overlap coefficient in [0,1]: shared-term weight over the
   *  SMALLER document's total weight (GH-2136). `score` scales with body
   *  length and backlog size, so a threshold on it rots as the board grows;
   *  this is the scale-free number `deps-unwired` thresholds on. min() rather
   *  than union: a small unit whose vocabulary is contained in a big epic's
   *  is exactly the containment a dependency edge looks like. */
  overlap: number;
  /** Shared terms, most distinctive first — the judge's foothold. */
  terms: string[];
}

/** Score the pool against the target. Pure — population filtering (state,
 *  claim, wiring) happens at the caller, where the walk's facts live. */
export function scoreDepCandidates(
  target: DepCandidateDoc,
  pool: DepCandidateDoc[],
  cap: number,
): { candidates: DepCandidate[]; capped: number } {
  const docs = [target, ...pool].map((d) => ({
    number: d.number,
    title: d.title,
    terms: depCandidateTerms(`${d.title}\n${d.body}`),
  }));
  const n = docs.length;
  const df = new Map<string, number>();
  for (const d of docs) for (const t of d.terms) df.set(t, (df.get(t) ?? 0) + 1);
  // log((N+1)/df), SMOOTHED on purpose: a term in every document is nearly
  // worthless (~1/N) but never zero — zeroing would disqualify candidates on
  // tiny populations where df statistics mean nothing, which is a precision
  // move inside a selector whose declared bias is recall. Ranking, not
  // qualification, is where ubiquity gets priced.
  const weight = (t: string) => Math.log((n + 1) / (df.get(t) ?? n));
  const totalWeight = (terms: Set<string>) => [...terms].reduce((s, t) => s + weight(t), 0);
  const targetTerms = docs[0].terms;
  const targetTotal = totalWeight(targetTerms);
  const scored: DepCandidate[] = [];
  for (const d of docs.slice(1)) {
    const shared = [...d.terms].filter((t) => targetTerms.has(t));
    if (shared.length === 0) continue;
    const score = shared.reduce((s, t) => s + weight(t), 0);
    const denom = Math.min(targetTotal, totalWeight(d.terms));
    const overlap = denom > 0 ? score / denom : 0;
    shared.sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : 1));
    scored.push({ number: d.number, title: d.title, score, overlap, terms: shared.slice(0, 6) });
  }
  scored.sort((a, b) => b.score - a.score || a.number - b.number);
  const candidates = scored.slice(0, cap);
  return { candidates, capped: scored.length - candidates.length };
}

export function parseDepCandidatesCap(raw: string | undefined): number {
  const v = Number(raw ?? DEP_CANDIDATES_CAP_DEFAULT);
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : DEP_CANDIDATES_CAP_DEFAULT;
}

/** Bodies per round trip in the dep-candidates batch read. */
const DEP_BODY_BATCH = 50;

/** Title + body for a set of issues, batched behind `db{k}:` aliases. Plain
 *  fields only — ZERO nested connections, so the whole batch rides at the
 *  1-pt floor (the GH-1803 cost model charges per connection, never per
 *  field; measured with RALPH_GQL_COST=1 on this repo 2026-08-24: cost=1,
 *  nodes=0, for a 16-issue batch).
 *  A null alias (deleted/transferred mid-flight) is a real answer and is
 *  skipped; an unreadable repository is an error, never an empty map. */
function fetchIssueBodies(ctx: Ctx, numbers: number[]): Map<number, { title: string; body: string }> {
  const out = new Map<number, { title: string; body: string }>();
  for (let i = 0; i < numbers.length; i += DEP_BODY_BATCH) {
    const batch = numbers.slice(i, i + DEP_BODY_BATCH);
    const aliases = batch
      .map((n, k) => `db${k}: issue(number: ${n}) { number title body }`)
      .join("\n");
    const d: any = ghGraphQL(
      ctx,
      `query($owner: String!, $repo: String!) {
        repository(owner: $owner, name: $repo) { ${aliases} }
      }`,
      { owner: ctx.cfg.owner, repo: ctx.cfg.repo },
    );
    const repo = d.repository;
    if (!repo) throw new Error(`could not read issue bodies for ${ctx.cfg.owner}/${ctx.cfg.repo}`);
    batch.forEach((n, k) => {
      const c = repo[`db${k}`];
      if (!c) return;
      out.set(n, { title: c.title ?? "", body: c.body ?? "" });
    });
  }
  return out;
}

/** The dep-candidates read, whole: population walk, pool predicate, body
 *  fetch, scoring. ONE definition for both write points (GH-2137) — the CLI
 *  verb and the filing path in `create` — because two spellings of the pool
 *  predicate is the GH-1843 drift seed, and the issue's own acceptance pins
 *  "called, not reimplemented".
 *
 *  Pool: OPEN, UNCLAIMED Backlog — rankNext's own predicate (`!claim`), so
 *  the selector and the ranker agree about what "unclaimed" means. Deferred
 *  items stay IN: recall bias — a parked item is still real future work an
 *  edge can point at. Wired-either-direction, self, and recorded
 *  parent/child edges are out: the subject is the edge the graph does NOT
 *  have (dep-refs.sh's rule, kept here).
 *
 *  `target.body === undefined` means "fetch it" (the CLI verb, which has only
 *  a number); the filing path passes the body it just wrote and skips the
 *  extra alias. */
export function readDepCandidates(
  ctx: Ctx,
  target: { number: number; title: string; body?: string; parentNumber: number | null },
  wired: Set<number>,
  presetWalk?: ReturnType<typeof listOwnOpenWalk>,
): {
  candidates: DepCandidate[];
  considered: number;
  cap: number;
  capped: number;
  docCount: number;
  walk: ReturnType<typeof listOwnOpenWalk>;
} {
  const cap = parseDepCandidatesCap(process.env.RALPH_DEP_CANDIDATES_MAX);
  const walk = presetWalk ?? listOwnOpenWalk(ctx, QUEUE_SELECT_NO_LABELS);
  const n = target.number;
  const pool = walk.open.filter(
    (i) =>
      i.number !== n &&
      i.state === "Backlog" &&
      !i.claim &&
      !wired.has(i.number) &&
      !(i.openBlockers ?? []).includes(n) &&
      !(i.closedBlockers ?? []).includes(n) &&
      i.parentNumber !== n &&
      i.number !== target.parentNumber,
  );
  const fetchNumbers =
    target.body === undefined ? [n, ...pool.map((i) => i.number)] : pool.map((i) => i.number);
  const bodies = fetchIssueBodies(ctx, fetchNumbers);
  const targetDoc: DepCandidateDoc = {
    number: n,
    title: bodies.get(n)?.title ?? target.title,
    body: target.body ?? bodies.get(n)?.body ?? "",
  };
  const poolDocs: DepCandidateDoc[] = pool.map((i) => ({
    number: i.number,
    title: bodies.get(i.number)?.title ?? i.title,
    body: bodies.get(i.number)?.body ?? "",
  }));
  const { candidates, capped } = scoreDepCandidates(targetDoc, poolDocs, cap);
  return { candidates, considered: pool.length, cap, capped, docCount: poolDocs.length + 1, walk };
}

/** Candidates the FILING path prints, at most. The full recall-biased list is
 *  one `board dep-candidates NNN` away and the print says so; a ten-row
 *  stderr block on every create is the "a dozen rows and nobody reads it"
 *  failure GH-2048 names. */
export const DEP_FILING_PRINT_CAP = 3;

/** The filing path's "high overlap" bar (GH-2137): the weight of THREE
 *  maximally-distinctive shared terms — df=2, i.e. terms only the new issue
 *  and the candidate carry — in this population's own scale
 *  (`3 * log((docCount+1)/2)`, the same smoothed weight scoreDepCandidates
 *  assigns). Population-relative on purpose: an absolute score threshold
 *  silently loosens as the backlog grows, because every term's weight rises
 *  with N. The CLI verb keeps NO threshold — it is the judge's full recall
 *  surface; only the unasked-for print on the filing path needs a floor. */
export function depFilingThreshold(docCount: number): number {
  return 3 * Math.log((docCount + 1) / 2);
}

/** The filing-path dependency check (GH-2137): after a create lands, the SAME
 *  selector runs against the new issue's title+body and prints high-overlap
 *  candidates on stderr. Advisory by construction — the write already
 *  happened, nothing here can refuse it, and EVERY failure is caught and
 *  printed as NOT CHECKED (GH-1971's rule: a filing that silently skipped the
 *  check would render exactly like a filing with no dependencies). */
function printFilingDepCandidates(
  ctx: Ctx,
  issue: { number: number; title: string; blockedBy: Array<{ number: number; repo?: string | null }> },
  body: string,
  parentNumber: number | null,
): void {
  try {
    // A fresh filing has no edges, but `create` can ADOPT a twin (GH-1973)
    // that already carries some — same own-repo filter the CLI verb applies.
    const self = `${ctx.cfg.owner}/${ctx.cfg.repo}`.toLowerCase();
    const wired = new Set<number>();
    for (const b of issue.blockedBy)
      if (!b.repo || b.repo.toLowerCase() === self) wired.add(b.number);
    const read = readDepCandidates(
      ctx,
      { number: issue.number, title: issue.title, body, parentNumber },
      wired,
    );
    const floor = depFilingThreshold(read.docCount);
    const hits = read.candidates.filter((c) => c.score >= floor).slice(0, DEP_FILING_PRINT_CAP);
    if (hits.length === 0) return;
    process.stderr.write(
      `possible dependencies (${DEP_CANDIDATES_DISCLAIMER}):\n` +
        hits.map((c) => `  #${c.number} ${c.score.toFixed(2)} ${c.title} (shared: ${c.terms.join(" ")})\n`).join("") +
        `  wire a real one: board dep ${issue.number} --on <m> — full list: board dep-candidates ${issue.number}\n`,
    );
  } catch {
    process.stderr.write(
      `dep-candidates: NOT CHECKED — the read failed; this is not an empty candidate list ` +
        `(the filing succeeded; \`board dep-candidates ${issue.number}\` retries the check)\n`,
    );
  }
}

/** The `deps-unwired` population (GH-2136): for each unclaimed Backlog item,
 *  its unjudged high-overlap candidates. Pure — the caller supplies bodies
 *  and the dismissed-pair set from wherever its trails live (tendQueue rides
 *  the trail fetch it already does; doctor reads comment trails).
 *
 *  Fail-closed exclusions: an item with a TRUNCATED blocker list is out
 *  entirely (both as target and candidate) — with an unseen tail of edges we
 *  cannot assert any pair is unwired, and the item is already a
 *  `deps-truncated` row. Already-wired pairs (either direction) and
 *  parent/child pairs are out: the subject is the edge the graph does NOT
 *  have. Items with no fetched body are skipped — a body GitHub never
 *  returned scores nothing. */
export function depsUnwiredMap(
  pool: Array<{
    number: number;
    title: string;
    openBlockers: number[];
    closedBlockers: number[];
    blockersTruncated: boolean;
    parentNumber: number | null;
  }>,
  bodies: Map<number, { title: string; body: string }>,
  dismissed: Set<string>,
  minOverlap: number,
  cap: number,
): Map<number, DepCandidate[]> {
  const eligible = pool.filter((i) => !i.blockersTruncated && bodies.has(i.number));
  const out = new Map<number, DepCandidate[]>();
  if (eligible.length < 2) return out;
  const excluded = new Set<string>(dismissed);
  for (const i of eligible) {
    for (const b of [...i.openBlockers, ...i.closedBlockers]) excluded.add(depPairKey(i.number, b));
    if (i.parentNumber !== null) excluded.add(depPairKey(i.number, i.parentNumber));
  }
  const doc = (i: { number: number }): DepCandidateDoc => ({
    number: i.number,
    title: bodies.get(i.number)!.title,
    body: bodies.get(i.number)!.body,
  });
  for (const target of eligible) {
    const others = eligible.filter((i) => i.number !== target.number).map(doc);
    // Uncapped at the scorer: the threshold and pair exclusions decide
    // membership; the cap applies to what SURVIVES them.
    const { candidates } = scoreDepCandidates(doc(target), others, others.length);
    const kept = candidates
      .filter((c) => c.overlap >= minOverlap && !excluded.has(depPairKey(target.number, c.number)))
      .slice(0, cap);
    if (kept.length > 0) out.set(target.number, kept);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Inbox (GH-2180, unit D of #2176) — the single place for a human's attention.
//
// One walk over the four human queues: Human Needed (decisions), tend
// proposals, Intake approvals, and the deliver-queue blocked rows only a
// human clears. Board as the only store — the inbox holds nothing of its own;
// every row is derived from state another surface already writes, so there is
// no inbox state to drift. Two tiers per the 2026-08-26 design (decision 7):
// Tier 1 is the interrupt-worthy decision queue below; Tier 2 is the digest
// (`--digest`), completions batched behind a machine-local stamp.
//
// THE invariant (design §2.7): nothing enters either tier without a
// disposition verb or an expiry. Tier 1 enforces it by construction — every
// row carries `verb`, a literal command, and the test suite iterates every
// category asserting it non-empty. Tier 2's expiry is the mark itself: each
// completion enters exactly one digest window and then ages out of it.
// ---------------------------------------------------------------------------

export type InboxQueueKind = "decision" | "proposal" | "approval" | "deliver-blocked";

export interface InboxRow {
  number: number;
  /** nameWithOwner — every inbox row is an own-repo open issue by
   *  construction, but a viewer (the cockpit's `g` browser verb) needs the
   *  literal repo to build a URL rather than re-deriving config. Null only
   *  when the row's number could not be joined back to the open walk. */
  repo: string | null;
  title: string;
  queue: InboxQueueKind;
  /** Ordering input, oldest first (nulls last) — the queue's own timestamp:
   *  updatedAt for decisions, the proposal's `at`, createdAt for approvals,
   *  the delta's own time for deliver rows. */
  at: string | null;
  priority: string | null;
  /** Approvals only — the readiness bar's other half. */
  estimate?: string | null;
  /** deliver-blocked only; honestly null on no-pr rows. */
  pr?: number | null;
  /** deliver-blocked only. */
  reason?: DeliverReason;
  /** Decision rows: first line of the why in the latest `**Decision needed**`
   *  comment — null when the trail could not be read or held none, which the
   *  renderer says out loud rather than leaving blank. A missing detail never
   *  drops the row: rows derive from STATE, detail is decoration. */
  detail: string | null;
  /** The literal disposition command. NEVER empty — the invariant. */
  verb: string;
}

export interface InboxTier1 {
  decisions: InboxRow[];
  proposals: InboxRow[];
  approvals: InboxRow[];
  deliverBlocked: InboxRow[];
  /** Deliver-blocked rows NOT admitted, counted by reason — the GH-2108 rule:
   *  an operator must be able to tell "nothing held back" from "the reader
   *  dropped it". A new DeliverReason lands here visibly, never invisibly. */
  withheld: Array<{ reason: DeliverReason; count: number }>;
  /** Human Needed rows NOT admitted because their live escalation is
   *  lead-routed and still inside the lead's window (GH-2218, unit J of
   *  #2208): the lead's queue, not the inbox's. A promotion — the lead's
   *  marker or the TTL, both computed at read time by classifyEscalation —
   *  is the admission; until then the row is counted here, never dropped
   *  (same GH-2108 rule as `withheld`). One arbitration hop total:
   *  worker → lead → inbox. */
  leadPending: Array<{ number: number; lead: string | null; at: string | null }>;
  count: number;
}

/** Tier 1 admission for deliver-blocked rows, in one declaration: a reason
 *  enters the inbox only if a human VERB disposes it. Excluded, by the
 *  invariant rather than by taste: the windowed self-clearing reasons
 *  (local-session-active, settling, retry-window, marker-current — their
 *  `windowExpiresAt` IS their disposition), `deferred` (probe-budget backoff;
 *  the next deliver pass re-probes with no human in the loop), and
 *  `reviewer-rate-limited`, which CANNOT enter: it has no disposing verb and
 *  no computable expiry (the quota reset instant is the reviewer's secret),
 *  so admitting it would put a row in the decision queue nothing can dispose.
 *  `no-pr`'s population is rollup-advanced epic parents and human-placed
 *  items (see classifyDeliver) — nothing but a human ever clears one. */
export const INBOX_DELIVER_VERBS: Partial<Record<DeliverReason, (n: number) => string>> = {
  "convergence-stalled": (n) => `board move ${n} in-progress --why "<rework direction>"`,
  "no-pr": (n) => `board move ${n} done (passes bare on an all-children-closed epic root; else --why "<review verdict>")`,
};

/** First line of the why in the LATEST escalation comment — the
 *  phone-answerable line the C9 shape asks the escalator to lead with.
 *  transition() writes `**Decision needed** (\`board\` by \`holder\`):\n\n<why>`,
 *  so the text after the header's first newline, trimmed, first line, is the
 *  why's lead. Null when no comment matches — the caller renders that as
 *  unavailable, never as an empty string pretending to be a decision. */
export function latestEscalationWhy(comments: string[]): string | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i] ?? "";
    if (!ESCALATION_EVIDENCE.test(c)) continue;
    const nl = c.indexOf("\n");
    const rest = nl >= 0 ? c.slice(nl + 1).trim() : "";
    const first = rest.split("\n")[0]?.trim() ?? "";
    return first || null;
  }
  return null;
}

/** Pure Tier 1 classification. One row per issue via a seen-set with
 *  precedence decisions > proposals > approvals > deliver-blocked — a closure
 *  proposal outranks approving the same Intake item ("should this exist"
 *  precedes "approve it"), and an escalation outranks everything (it is the
 *  one row a human already asked for by name). */
export function classifyInbox(
  open: QueueItemCore[],
  tend: Pick<TendQueueResult, "queue">,
  deliver: Pick<DeliverQueueResult, "blocked">,
  /** number → why-line for Human Needed items whose trails were read; a
   *  missing or null entry degrades `detail`, never the row. */
  decisionWhys: Map<number, string | null> = new Map(),
  /** number → escalation route for Human Needed items (GH-2218): a
   *  lead-routed `pending` row is withheld to `leadPending` — the lead's
   *  queue, one arbitration hop. A MISSING entry admits: an unreadable
   *  trail may not hide a decision from the human (fail toward
   *  visibility, the same direction as auto-promotion). */
  routes: Map<number, EscalationRoute> = new Map(),
): InboxTier1 {
  const byNumber = new Map(open.map((i) => [i.number, i]));
  const seen = new Set<number>();
  const oldestFirst = (a: InboxRow, b: InboxRow): number => {
    if (a.at === null && b.at === null) return a.number - b.number;
    if (a.at === null) return 1;
    if (b.at === null) return -1;
    return a.at < b.at ? -1 : a.at > b.at ? 1 : a.number - b.number;
  };

  const decisions: InboxRow[] = [];
  const leadPending: InboxTier1["leadPending"] = [];
  for (const i of open) {
    if (i.state !== "Human Needed" || seen.has(i.number)) continue;
    seen.add(i.number);
    const route = routes.get(i.number);
    if (route?.route === "lead" && route.disposition === "pending") {
      // The lead's row, not the human's — withheld WITH the seen-set mark:
      // an item in the lead's queue may not resurface in another tier
      // (a tend proposal on it waits for the arbitration to conclude).
      leadPending.push({ number: i.number, lead: route.lead ?? null, at: route.at ?? null });
      continue;
    }
    decisions.push({
      number: i.number,
      repo: i.repo ?? null,
      title: i.title,
      queue: "decision",
      at: i.updatedAt ?? null,
      priority: i.priority ?? null,
      detail: decisionWhys.get(i.number) ?? null,
      verb: `board answer ${i.number} -m "<the decision>"`,
    });
  }

  const proposals: InboxRow[] = [];
  for (const r of tend.queue) {
    if (r.category !== "proposed" || seen.has(r.number)) continue;
    seen.add(r.number);
    proposals.push({
      number: r.number,
      repo: byNumber.get(r.number)?.repo ?? null,
      title: r.title,
      queue: "proposal",
      at: r.at,
      priority: byNumber.get(r.number)?.priority ?? null,
      detail: null,
      verb: `board resolve ${r.number} --accept | --reject -m "<why not>"`,
    });
  }

  const approvals: InboxRow[] = [];
  for (const i of open) {
    if (i.state !== "Intake" || seen.has(i.number)) continue;
    seen.add(i.number);
    // The verb is honest about the readiness bar (GH-2077): approval REFUSES
    // without Priority and Estimate, so a row missing one renders the field
    // step first — the same facts backlogReadinessGaps enforces at the edge.
    const steps: string[] = [];
    if (!i.priority) steps.push(`board priority ${i.number} <P0..P3>`);
    if (!i.estimate) steps.push(`board estimate ${i.number} <XS..XL>`);
    steps.push(`board move ${i.number} backlog`);
    approvals.push({
      number: i.number,
      repo: i.repo ?? null,
      title: i.title,
      queue: "approval",
      at: i.createdAt ?? null,
      priority: i.priority ?? null,
      estimate: i.estimate ?? null,
      detail: `reject: board cancel ${i.number} -m "<why>"`,
      verb: steps.join(" && "),
    });
  }

  const deliverBlocked: InboxRow[] = [];
  const withheldCounts = new Map<DeliverReason, number>();
  for (const r of deliver.blocked) {
    const verb = INBOX_DELIVER_VERBS[r.reason];
    if (!verb) {
      withheldCounts.set(r.reason, (withheldCounts.get(r.reason) ?? 0) + 1);
      continue;
    }
    if (seen.has(r.number)) continue;
    seen.add(r.number);
    deliverBlocked.push({
      number: r.number,
      repo: byNumber.get(r.number)?.repo ?? null,
      title: r.title,
      queue: "deliver-blocked",
      at: r.deltaAt ?? null,
      priority: byNumber.get(r.number)?.priority ?? null,
      pr: r.pr ?? null,
      reason: r.reason,
      detail:
        r.reason === "no-pr"
          ? `no open PR at this item — a rollup-advanced epic awaiting close-out (all children closed → board move ${r.number} done passes bare), or demote: board move ${r.number} in-progress --why "<why>"`
          : (r.detail ?? r.convergence ?? null),
      verb: verb(r.number),
    });
  }

  decisions.sort(oldestFirst);
  proposals.sort(oldestFirst);
  approvals.sort(oldestFirst);
  deliverBlocked.sort(oldestFirst);
  const withheld = [...withheldCounts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => (a.reason < b.reason ? -1 : 1));
  leadPending.sort((a, b) => a.number - b.number);
  return {
    decisions,
    proposals,
    approvals,
    deliverBlocked,
    withheld,
    leadPending,
    // leadPending is deliberately OUTSIDE the count: the count is what waits
    // on the inbox's reader, and those rows wait on the lead.
    count: decisions.length + proposals.length + approvals.length + deliverBlocked.length,
  };
}

export interface InboxDigestFacts {
  /** EFFECTIVE window start — max(stamp, the audit window's own floor). A
   *  20-day-old stamp silently capped to the 14-day read would otherwise
   *  report a window it did not search. */
  since: string;
  /** The stamp as read (echoed so a reader can audit the window derivation);
   *  null = absent or unreadable, which fall back to a 24h window — the
   *  over-notify direction, correct for a digest. */
  stamp: string | null;
  /** Keyed on the LOCAL calendar date — the human's morning, not UTC's. */
  markedToday: boolean;
  /** Computed BEFORE any stamp write: worth a push only when unmarked today
   *  and something happened. Zero pushes on a quiet day is legal — "at most
   *  one push a day" is the invariant, not a quota to fill. */
  pushWorthy: boolean;
  completions: Array<{ number: number; title: string; closedAt: string | null }>;
  counts: {
    tier1: number;
    decisions: number;
    proposals: number;
    approvals: number;
    deliverBlocked: number;
    completions: number;
  };
}

/** Pure digest derivation (Tier 2). The stamp is machine-local, so two hosts
 *  running rotas produce two pushes a day — an honest limit of a local stamp,
 *  stated rather than solved (the board stays the only shared store). */
export function digestFacts(
  stampAt: string | null,
  now: Date,
  audit: { since: string; items: Array<{ number: number; title: string; closedAt: string | null }> },
  tier1: Pick<InboxTier1, "count" | "decisions" | "proposals" | "approvals" | "deliverBlocked">,
): InboxDigestFacts {
  const stampMs = stampAt ? new Date(stampAt).getTime() : NaN;
  const auditMs = new Date(audit.since).getTime();
  const sinceMs = Number.isFinite(stampMs)
    ? Math.max(stampMs, Number.isFinite(auditMs) ? auditMs : stampMs)
    : now.getTime() - 86_400_000;
  const sameLocalDay = (a: Date, b: Date): boolean =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const completions = audit.items.filter((i) => {
    const t = i.closedAt ? new Date(i.closedAt).getTime() : NaN;
    return Number.isFinite(t) && t >= sinceMs;
  });
  const markedToday = Number.isFinite(stampMs) && sameLocalDay(new Date(stampMs), now);
  return {
    since: new Date(sinceMs).toISOString(),
    stamp: Number.isFinite(stampMs) ? stampAt : null,
    markedToday,
    pushWorthy: !markedToday && (tier1.count > 0 || completions.length > 0),
    completions,
    counts: {
      tier1: tier1.count,
      decisions: tier1.decisions.length,
      proposals: tier1.proposals.length,
      approvals: tier1.approvals.length,
      deliverBlocked: tier1.deliverBlocked.length,
      completions: completions.length,
    },
  };
}

/** The digest stamp's home — machine-local under RALPH_HOME, one file per
 *  board, written atomically (last-write-wins is the right level: a stamp is
 *  a cursor, not a lock). */
export function inboxStampPath(cfg: { owner: string; repo: string }): string {
  return join(process.env.RALPH_HOME || join(homedir(), ".ralph"), "inbox", `digest-${cfg.owner}-${cfg.repo}.json`);
}

// ---------------------------------------------------------------------------
// Create / link / dep
// ---------------------------------------------------------------------------

/** THE Backlog readiness bar (GH-2077), in one place: the approval edge
 *  (`Intake → Backlog`) and the `create --backlog` lane are two spellings of
 *  the same claim — "this is approved and rankable" — and a bar that lived in
 *  both would be the GH-1843 shape, a rule held together by a comment asking
 *  its copies to stay in sync.
 *
 *  Returns one plain-English gap per unset field, each naming exactly what to
 *  add. Empty = ready. Hints name the FLAG on the create path and the field on
 *  the move path, so the caller is told the remedy it can actually run — see
 *  the two call sites for the surrounding sentence. */
export function backlogReadinessGaps(
  priority: string | null | undefined,
  estimate: string | null | undefined,
): string[] {
  const gaps: string[] = [];
  if (!priority)
    gaps.push(
      `it has no ${PRIORITY_FIELD} (unprioritized items sort LAST in \`board next\` and are named by no lane)`,
    );
  if (!estimate) gaps.push(`it has no ${ESTIMATE_FIELD} (nothing sizes the unit)`);
  return gaps;
}

export interface CreateOpts {
  title: string;
  body?: string;
  parent?: number;
  estimate?: string;
  priority?: string;
  /** The LANDING STATE, required (GH-2077). Deliberately not optional: a bare
   *  `create` used to land in Backlog — that is, filing an issue silently
   *  approved it for autonomous pickup, which is the gap the intake tier
   *  closes. Making it required puts the choice on `tsc` for programmatic
   *  callers and on a loud UsageError for the CLI, rather than on a default
   *  nobody types and nobody sees. */
  state: State;
  labels?: string[];
  /** Skip the duplicate guard — the operator asserts a second issue with this
   *  exact title, filed minutes after the first, is what they meant. */
  allowDuplicate?: boolean;
}

/** How far back the create-dedupe guard looks. Observed duplicate gaps were
 *  62/75/122 s (GH-1973); 300 covers a caller that retried after a long
 *  timeout. 0 disables the guard entirely. */
export function createDedupeWindowSec(): number {
  const raw = process.env.RALPH_CREATE_DEDUPE_SEC;
  if (raw === undefined || raw.trim() === "") return 300;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 300;
}

/** An OPEN issue in this repo with a byte-identical title, filed by US inside
 *  the window. That conjunction is the whole safety argument: title alone
 *  collides on legitimately-repeated intake, and a foreign author's issue is
 *  never ours to adopt. Returns null on ANY doubt.
 *
 *  Restricted to OPEN deliberately — a twin closed within the window is a
 *  deliberate act, and adopting it would hand `create` a terminal issue it is
 *  forbidden to file into. */
export function findRecentTwin(
  ctx: Ctx,
  title: string,
  windowSec: number,
): { id: string; number: number; url: string; createdAt: string } | null {
  if (windowSec <= 0) return null;
  const data = ghGraphQL<any>(
    ctx,
    `query($owner: String!, $repo: String!) {
      viewer { login }
      repository(owner: $owner, name: $repo) {
        issues(first: 25, states: OPEN, orderBy: { field: CREATED_AT, direction: DESC }) {
          nodes { id number url title createdAt author { login } }
        }
      }
    }`,
    { owner: ctx.cfg.owner, repo: ctx.cfg.repo },
  );
  const me = data?.viewer?.login;
  const nodes: any[] = data?.repository?.issues?.nodes ?? [];
  const cutoff = Date.now() - windowSec * 1000;
  for (const n of nodes) {
    const at = Date.parse(n?.createdAt ?? "");
    // The list is CREATED_AT DESC, so the first out-of-window node ends the
    // scan — no later node can be newer.
    if (!Number.isFinite(at) || at < cutoff) break;
    if (n.title !== title) continue;
    if (!me || n?.author?.login !== me) continue;
    return { id: n.id, number: n.number, url: n.url, createdAt: n.createdAt };
  }
  return null;
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
function assertAdvisorySingleSelect(cache: BoardCache, fieldName: string): void {
  const field = cache.fields[fieldName];
  if (field && field.dataType !== "SINGLE_SELECT") {
    throw new UsageError(
      `this board's ${fieldName} field is ${field.dataType}, not SINGLE_SELECT — ralph reads a ` +
        `single-select ${fieldName} and will neither write nor CLEAR a custom ${field.dataType} field ` +
        `(clearing it would erase data \`board get\` cannot even show you). Convert it in the Projects UI, ` +
        `or leave ${fieldName} to the board.`,
    );
  }
}

function assertAdvisoryOption(cache: BoardCache, fieldName: string, value: string): void {
  assertAdvisorySingleSelect(cache, fieldName);
  const options = Object.keys(cache.fields[fieldName]?.options ?? {});
  if (!options.includes(value)) {
    throw new UsageError(
      `unknown ${fieldName} "${value}" — this board's options are: ${options.join(", ") || "(none)"}`,
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
/** One setter for both advisory single-selects (Priority, Estimate) — two
 *  spellings of "set an advisory single-select" is the GH-1843 drift seed
 *  (GH-2126). */
function setAdvisoryField(ctx: Ctx, number: number, fieldName: string, value: string | null): Issue {
  const issue = fetchIssue(ctx, number);
  const itemId = requireItem(issue);
  // Live schema on BOTH branches. The set is what a value is judged against —
  // and a clear needs it just as much, for the field ID rather than the
  // options: a field deleted and recreated keeps its name, so the cache stays
  // `satisfied()` while holding an obsolete id, and every clear would fail
  // against it until some unrelated op happened to refresh. `--clear`
  // validating nothing was the wrong reason to skip the read.
  const cache = mutationCache(ctx, [[fieldName]], [], [fieldName]);
  writeAdvisoryValue(ctx, cache, itemId, fieldName, value);
  return fetchIssue(ctx, number);
}

/** The one advisory-field write: assert against the live schema, then set or
 *  clear. Extracted so the list-arity path (GH-2130) is the SAME writer called
 *  N times behind one resolution and one `mutationCache` — never a second
 *  implementation of the guard (the GH-1843 drift shape Decision 2 forecloses). */
function writeAdvisoryValue(
  ctx: Ctx,
  cache: BoardCache,
  itemId: string,
  fieldName: string,
  value: string | null,
): void {
  if (value === null) {
    // Refuse BEFORE clearing: this is the destructive direction.
    assertAdvisorySingleSelect(cache, fieldName);
    clearField(ctx, cache, itemId, fieldName);
  } else {
    assertAdvisoryOption(cache, fieldName, value);
    setSingleSelect(ctx, cache, itemId, fieldName, value);
  }
}

export function setPriority(ctx: Ctx, number: number, value: string | null): Issue {
  return setAdvisoryField(ctx, number, PRIORITY_FIELD, value);
}

export function setEstimate(ctx: Ctx, number: number, value: string | null): Issue {
  return setAdvisoryField(ctx, number, ESTIMATE_FIELD, value);
}

/** The run a list-arity field write actually performed (GH-2130). Shape
 *  follows PruneApplyResult; `applied` names the numbers written, because a
 *  breaker-aborted run must be reportable item by item, never inferred. */
export interface BulkFieldResult {
  field: string;
  value: string | null;
  attempted: number;
  updated: number;
  applied: number[];
  failed: string[];
  aborted: boolean;
}

/** A resolved bulk target: the number as typed, and what the walk knows. */
interface BulkTarget {
  number: number;
  itemId: string;
  title: string;
}

/** List arity on the advisory field verbs (GH-2130, record Decisions 2-5).
 *
 *  Resolution is the OPEN WALK, not N fetchIssue point reads: the measured
 *  waste in a shell loop is 12 of 14 points spent re-reading the board per
 *  item, and the walk returns every open item's project-item id in one
 *  connection at a cost flat in N (the id is a field, not a connection —
 *  GH-1803's cost model; probed, not assumed). The price of that primitive is
 *  stated by GH-1814: it sees open, on-board, unarchived items only — so any
 *  target outside that set is a TYPED REFUSAL naming the number, never a
 *  silent skip, and it lands BEFORE the first write. Partial application from
 *  a typo is the failure mode here; the single-number form (which resolves
 *  via fetchIssue and still works on a closed item) is the named remedy.
 *
 *  The bulk path owns resolution, iteration and reporting — NOTHING else.
 *  Option validation, the schema read and the write itself are the same
 *  `mutationCache` + `writeAdvisoryValue` the single verb uses: N values
 *  judged against ONE live read of the same truth (the guard's best case).
 *  An explicit list is applied whole or not at all, so a list longer than
 *  --limit refuses rather than truncating — prune SLICES to --limit because
 *  its computed set legitimately spans runs; a hand-approved list has no
 *  "rest for the next run", only silent partial application. */
export function bulkSetAdvisoryField(
  ctx: Ctx,
  numbers: number[],
  fieldName: string,
  value: string | null,
  limit: number = PRUNE_DEFAULT_LIMIT,
): { result: BulkFieldResult; targets: BulkTarget[] } {
  const dupes = [...new Set(numbers.filter((n, i) => numbers.indexOf(n) !== i))];
  if (dupes.length > 0) {
    // A duplicate in a hand-typed list is a typo signal ("2105,2105" for
    // "2105,2106") — the write would be harmlessly idempotent, but the list
    // is not the one the operator meant to approve.
    throw new UsageError(`duplicate issue number(s) in list: ${dupes.map((n) => `#${n}`).join(", ")}`);
  }
  if (numbers.length > limit) {
    throw new UsageError(
      `${numbers.length} targets exceed --limit ${limit} — an explicit list is applied ` +
        `whole or not at all (raise --limit or split the list)`,
    );
  }
  const open = listOwnOpenItems(ctx, QUEUE_SELECT_MINIMAL);
  const byNumber = new Map(open.map((i) => [i.number, i]));
  const resolved: BulkTarget[] = [];
  const unresolved: number[] = [];
  for (const n of numbers) {
    const item = byNumber.get(n);
    // A row without an item id fails closed with the rest: "the walk did not
    // say" must never resolve to a write target.
    if (!item || !item.itemId) unresolved.push(n);
    else resolved.push({ number: n, itemId: item.itemId, title: item.title });
  }
  if (unresolved.length > 0) {
    throw new RefusalError(
      `cannot resolve ${unresolved.map((n) => `#${n}`).join(", ")} — list targets must be ` +
        `open, on this board, and not archived (a closed or archived target is invisible to ` +
        `the open walk). Nothing was written. For a closed board item use the single form: ` +
        `board ${fieldName === PRIORITY_FIELD ? "priority" : "estimate"} NNN ${value ?? "--clear"}`,
    );
  }
  // One live schema read validates every value in the run (the single verb
  // pays this per write). Asserted BEFORE the first write so a bad option is
  // a clean refusal, not a partial application.
  const cache = mutationCache(ctx, [[fieldName]], [], [fieldName]);
  if (value === null) assertAdvisorySingleSelect(cache, fieldName);
  else assertAdvisoryOption(cache, fieldName, value);
  const applied: number[] = [];
  const r = applyWithBreaker(
    resolved,
    (t) => `#${t.number}`,
    (t) => {
      writeAdvisoryValue(ctx, cache, t.itemId, fieldName, value);
      applied.push(t.number);
    },
  );
  return {
    result: {
      field: fieldName,
      value,
      attempted: r.attempted,
      updated: r.succeeded,
      applied,
      failed: r.failed,
      aborted: r.aborted,
    },
    targets: resolved,
  };
}

/** Park / unpark an item (audit B8): "the precondition is not met" as a typed
 *  write instead of an unrepresentable fact that costs a session per re-rank.
 *  Metadata-only — never touches the state field or the claim. The comment is
 *  provenance, posted BEFORE the field write (the transition() ordering rule:
 *  an interrupted run leaves the reason, not a bare mark). */
export function setDefer(ctx: Ctx, number: number, mark: DeferMark | null): Issue {
  const issue = fetchIssue(ctx, number);
  const itemId = requireItem(issue);
  const cache = mutationCache(ctx, [[DEFER_FIELD]]);
  if (mark === null) {
    if (issue.defer) {
      addComment(
        ctx,
        issue.nodeId,
        `\`board defer --clear\` (by \`${ctx.cfg.holder}\`): precondition lifted — ${issue.defer.condition}`,
      );
      clearField(ctx, cache, itemId, DEFER_FIELD);
    }
  } else {
    // GH-2202: on Intake, defer is a timed SNOOZE and --recheck is REQUIRED.
    // On Backlog an open-ended defer is safe — claiming lifts it and the
    // deferred bucket stays visible in `next`'s diagnosis. Intake never ranks,
    // so the recheck instant is the ONLY thing that resurfaces the item; an
    // untimed snooze there is invisible-forever, the exact failure the Intake
    // tier was built to end (GH-2077).
    if (issue.state === "Intake" && !mark.recheck) {
      throw new UsageError(
        `#${number} is Intake — defer there is a timed snooze and requires --recheck <ISO> ` +
          `(when to be reminded again). Intake never ranks, so only the recheck date ` +
          `resurfaces the item; an untimed snooze would hide it forever.`,
      );
    }
    const snooze = issue.state === "Intake";
    addComment(
      ctx,
      issue.nodeId,
      snooze ?
        `\`board defer\` (by \`${ctx.cfg.holder}\`): snoozed — ${mark.condition}\n` +
          `Withheld from tend-queue \`unformed\` and doctor \`intake-stale\` until ` +
          `${mark.recheck!.toISOString()}, then resurfaces with its full age. Still visible in \`board list\`.\n\n` +
          `Lifted by \`board defer ${number} --clear\` or by the approval decision itself.`
      : `\`board defer\` (by \`${ctx.cfg.holder}\`): parked — ${mark.condition}` +
          (mark.recheck ? `\nRecheck by ${mark.recheck.toISOString()}.` : "") +
          `\n\nLifted by \`board defer ${number} --clear\` or by claiming the unit.`,
    );
    setText(ctx, cache, itemId, DEFER_FIELD, formatDefer(mark));
  }
  return fetchIssue(ctx, number);
}

export function createIssue(ctx: Ctx, opts: CreateOpts): Issue {
  if (["Done", "Canceled"].includes(opts.state)) {
    throw new UsageError(
      `cannot create an issue in terminal state "${opts.state}" — create it open, then move/cancel it`,
    );
  }
  // The Backlog lane's evidentiary bar, refused BEFORE the issue exists — the
  // same reason priority validation runs here rather than after createIssue.
  // Landing an unrankable item in Backlog is what `--intake` exists to make
  // unnecessary, so the hint names that lane too: "not ready" and "not yet
  // approved" are different answers and the caller knows which one is true.
  if (opts.state === "Backlog") {
    const missing = backlogReadinessGaps(opts.priority, opts.estimate);
    if (missing.length > 0) {
      throw new UsageError(
        `--backlog means approved and ready, but ${missing.join("; and ")}.\n` +
          `Add \`--priority P0..P3\` (P1 = the default lane for real work) and ` +
          `\`--estimate XS..XL\` — or file with \`--intake\` if this is not yet approved.`,
      );
    }
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
  const needs: Array<[string, string?]> = [[STATE_FIELD, opts.state]];
  if (wantsPriority) needs.push([PRIORITY_FIELD]);
  // …and validated against a LIVE option set: a cached option GitHub has since
  // deleted would pass here and fail after createIssue (see mutationCache).
  // PRIORITY_FIELD is OPTIONAL, never a `need`: a board without the field must
  // still be able to file issues. It is asked for even when no priority was
  // requested, so the closing hint can tell "this board has no Priority field"
  // apart from "the cache never looked" — a hint that names a flag the board
  // cannot honour is worse than silence (GH-1792, the hint-pr-linkage rule).
  const cache = mutationCache(
    ctx,
    needs,
    wantsPriority ? [] : [PRIORITY_FIELD],
    wantsPriority ? [PRIORITY_FIELD] : [],
  );
  if (wantsPriority) assertAdvisoryOption(cache, PRIORITY_FIELD, opts.priority!);
  {
    // GH-1973: a lost RESPONSE and a failed WRITE are indistinguishable to the
    // caller, and the safe-looking response — retry — is the one that files a
    // duplicate. `create` owns that hazard rather than exporting it, the same
    // way transition() read-backs its claim because GitHub has no CAS.
    //
    // Two guards, both keyed on the same predicate. The PRE search catches a
    // caller that already retried (the observed incident: three duplicate
    // pairs, 62-122 s apart). The POST read-back catches the lost response
    // inside this very invocation, so a retry is never needed for it.
    const window = opts.allowDuplicate ? 0 : createDedupeWindowSec();
    const adopt = (
      twin: { id: string; number: number; url: string },
      how: string,
    ): { id: string; number: number; url: string } => {
      process.stderr.write(
        `note: adopted existing #${twin.number} (${how}) instead of filing a duplicate — ` +
          `pass --allow-duplicate if a second issue with this title is intended\n`,
      );
      return twin;
    };
    let issue: { id: string; number: number; url: string };
    let pre: ReturnType<typeof findRecentTwin> = null;
    try {
      pre = findRecentTwin(ctx, opts.title, window);
    } catch (e) {
      // A failed guard may not block intake: the outage that loses a response
      // is the same outage that breaks this read, and refusing here would make
      // `create` unusable in exactly the conditions it exists to survive. The
      // POST read-back still covers the lost-response case.
      process.stderr.write(`warn: duplicate check failed, filing anyway: ${(e as Error).message}\n`);
    }
    if (pre) {
      issue = adopt(pre, "same title, filed moments ago by you");
    } else {
      try {
        const created = ghGraphQL(
          ctx,
          `mutation($repositoryId: ID!, $title: String!, $body: String) {
            createIssue(input: { repositoryId: $repositoryId, title: $title, body: $body }) {
              issue { id number url }
            }
          }`,
          { repositoryId: cache.repositoryId, title: opts.title, body: opts.body ?? "" },
        );
        issue = created.createIssue.issue;
      } catch (e) {
        // The mutation may have landed. Ask the server which it was rather
        // than reporting a failure the caller can only resolve by retrying.
        let twin: ReturnType<typeof findRecentTwin> = null;
        try {
          // Always a real window here, even under --allow-duplicate or a
          // configured 0: the only issue this can find is the one THIS
          // invocation just wrote, and adopting it is never a dedupe decision.
          twin = findRecentTwin(ctx, opts.title, window || 300);
        } catch {
          /* read-back unavailable — fall through to the honest error below */
        }
        if (!twin)
          throw new Error(
            `${(e as Error).message}\n` +
              `The issue may or may not have been created — the mutation was sent and its ` +
              `outcome could not be read back. Check \`gh issue list --search ${JSON.stringify(opts.title)}\` ` +
              `before retrying; a blind retry is how duplicates get filed.`,
          );
        issue = adopt(twin, "mutation response was lost; the write had landed");
      }
    }

    // The issue already exists by the time the URL it is judged on exists, so
    // a refusal here has a durable half — say so, like answer() does, rather
    // than leaving an issue nobody's selector will ever surface (the same
    // reason priority is validated above BEFORE createIssue runs).
    try {
      assertBoardAddAllowed(ctx, issue.url, issue.number);
    } catch (e) {
      if (e instanceof RefusalError)
        throw new RefusalError(
          `${e.message}\nThe issue WAS created (${issue.url}) and is NOT on the board — ` +
            `\`board adopt ${issue.number}\` once the posture permits it, or close it.`,
        );
      throw e;
    }
    const added = ghGraphQL(
      ctx,
      `mutation($projectId: ID!, $contentId: ID!) {
        addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) { item { id } }
      }`,
      { projectId: cache.projectId, contentId: issue.id },
    );
    const itemId = added.addProjectV2ItemById.item.id;

    setSingleSelect(ctx, cache, itemId, STATE_FIELD, opts.state);
    syncStatus(ctx, cache, itemId, opts.state);
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
        process.stderr.write(
          `warn: estimate not set (\`board estimate ${issue.number} ${shQuote(opts.estimate)}\` retries it): ${estimateFailure}\n`,
        );
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
          ? [`${ESTIMATE_FIELD} ${opts.estimate} (\`board estimate ${issue.number} ${shQuote(opts.estimate!)}\`): ${estimateFailure}`]
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

/** GH-1792's stderr nudge ("this item has no Priority and will be named by no
 *  lane") is GONE, replaced by the `--backlog` lane gate above (GH-2077). It
 *  existed because `create` had no lane: a bare filing landed in Backlog, and
 *  refusing there would have blocked the fast human capture that legitimately
 *  does not know a priority yet. The intake tier removes that trade — that
 *  filing has `--intake` now — so the bar the hint described is enforced
 *  instead of suggested, and a hint that can no longer fire on the lane it was
 *  written for is worse than none. */

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

/** The child's current parent as GitHub reports it — or null for a root.
 *  Repo is carried so cross-repo parents are NAMED in refusals rather than
 *  silently treated as absent (the partitioning rule elsewhere nulls them,
 *  which is right for ranking and wrong for a message about why a link
 *  refused). */
type CurrentParent = { number: number; repo: string } | null;

/** Node ids for both ends of a link write plus the child's current parent, in
 *  one round trip — the pre-read every link mode needs (GH-2206): the bare
 *  form refuses an already-parented child by NAME, `--rm` refuses a
 *  mismatched pair, and the same read re-run after the mutation is the
 *  read-back verify. Repository-scoped like fetchNodeIds, so a bare number
 *  still cannot resolve outside the configured repo. */
function fetchLinkPair(
  ctx: Ctx,
  parentNumber: number,
  childNumber: number,
): { parentId: string; childId: string; childParent: CurrentParent } {
  let data: any;
  try {
    data = ghGraphQL(
      ctx,
      `query($owner: String!, $repo: String!, $parent: Int!, $child: Int!) {
        repository(owner: $owner, name: $repo) {
          lp: issue(number: $parent) { id }
          lc: issue(number: $child) { id parent { number repository { nameWithOwner } } }
        }
      }`,
      { owner: ctx.cfg.owner, repo: ctx.cfg.repo, parent: parentNumber, child: childNumber },
    );
  } catch (e) {
    if (e instanceof GraphQLError && e.types.includes("NOT_FOUND")) {
      throw new UsageError(
        `issue not found in ${ctx.cfg.owner}/${ctx.cfg.repo} (of #${parentNumber}, #${childNumber}): ${e.message}`,
      );
    }
    throw e;
  }
  const lp = data.repository?.lp;
  const lc = data.repository?.lc;
  if (!lp) throw new UsageError(`issue #${parentNumber} not found in ${ctx.cfg.owner}/${ctx.cfg.repo}`);
  if (!lc) throw new UsageError(`issue #${childNumber} not found in ${ctx.cfg.owner}/${ctx.cfg.repo}`);
  return {
    parentId: lp.id,
    childId: lc.id,
    childParent: lc.parent
      ? { number: lc.parent.number, repo: lc.parent.repository?.nameWithOwner ?? "" }
      : null,
  };
}

export type LinkMode = "add" | "rm" | "replace";

/** Sub-issue edge writes (GH-2206). Three modes over ONE mutation surface:
 *  bare add, `--rm` (removeSubIssue — the inverse `dep` always had), and
 *  `--replace` (addSubIssue with replaceParent — deliberately ONE atomic
 *  mutation, never remove+add: between two writes the child is parentless,
 *  and the epic-aware ranker would read it as a root for that window).
 *  Every mode re-reads the child's parent after the write and refuses to
 *  report success on a mismatch. Returns the human line for the CLI. */
export function linkParent(ctx: Ctx, parentNumber: number, childNumber: number, mode: LinkMode = "add"): string {
  if (parentNumber === childNumber) throw new UsageError("an issue cannot be its own parent");
  const ownRepo = (p: NonNullable<CurrentParent>): boolean =>
    p.repo.toLowerCase() === `${ctx.cfg.owner}/${ctx.cfg.repo}`.toLowerCase();
  const label = (p: NonNullable<CurrentParent>): string => (ownRepo(p) ? `#${p.number}` : `${p.repo}#${p.number}`);

  const { parentId, childId, childParent } = fetchLinkPair(ctx, parentNumber, childNumber);
  const isCurrent = childParent !== null && ownRepo(childParent) && childParent.number === parentNumber;

  if (mode === "rm") {
    if (childParent === null) {
      throw new RefusalError(`#${childNumber} has no parent — nothing to unlink`);
    }
    if (!isCurrent) {
      // A remove that silently no-ops on a mismatched pair hides a wrong
      // mental model — refuse with the actual parent's name.
      throw new RefusalError(
        `#${parentNumber} is not #${childNumber}'s parent — current parent is ${label(childParent)}` +
          (ownRepo(childParent)
            ? ` (\`board link ${childParent.number} ${childNumber} --rm\` detaches it)`
            : ` (cross-repo — detach it in the GitHub UI)`),
      );
    }
    ghGraphQL(
      ctx,
      `mutation($parentId: ID!, $childId: ID!) {
        removeSubIssue(input: { issueId: $parentId, subIssueId: $childId }) { issue { id } }
      }`,
      { parentId, childId },
    );
    const after = fetchLinkPair(ctx, parentNumber, childNumber).childParent;
    if (after !== null && ownRepo(after) && after.number === parentNumber) {
      throw new Error(
        `unlink did NOT land — GitHub still reports #${parentNumber} as #${childNumber}'s parent; retry \`board link ${parentNumber} ${childNumber} --rm\``,
      );
    }
    return `#${childNumber} is no longer a sub-issue of #${parentNumber} (now a root)`;
  }

  // add / replace. Same-parent re-link is a retry, not a violation — noop
  // success, no mutation (the same-state-move rule, v0.2.0).
  if (isCurrent) return `#${childNumber} is already a sub-issue of #${parentNumber} (no change)`;

  if (mode === "add" && childParent !== null) {
    // Digested refusal, not GitHub's raw "already has a parent": name the
    // current parent and both remedies. A cross-repo parent cannot be
    // addressed by bare number, so only --replace is offered there.
    throw new RefusalError(
      `#${childNumber} already has a parent (${label(childParent)}) — ` +
        `\`board link ${parentNumber} ${childNumber} --replace\` moves it atomically` +
        (ownRepo(childParent) ? `; \`board link ${childParent.number} ${childNumber} --rm\` detaches it` : ``),
    );
  }

  ghGraphQL(
    ctx,
    `mutation($parentId: ID!, $childId: ID!) {
      addSubIssue(input: { issueId: $parentId, subIssueId: $childId${mode === "replace" ? ", replaceParent: true" : ""} }) { issue { id } }
    }`,
    { parentId, childId },
  );
  const after = fetchLinkPair(ctx, parentNumber, childNumber).childParent;
  if (!(after !== null && ownRepo(after) && after.number === parentNumber)) {
    throw new Error(
      `link did NOT land — GitHub reports ${after ? label(after) : "no parent"} as #${childNumber}'s parent; ` +
        `retry \`board link ${parentNumber} ${childNumber}${mode === "replace" ? " --replace" : ""}\``,
    );
  }
  return mode === "replace" && childParent !== null
    ? `#${childNumber} moved: parent ${label(childParent)} → #${parentNumber}`
    : `#${childNumber} is now a sub-issue of #${parentNumber}`;
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
  "answer-unresumed",
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

/** Doctor's `gate-kit` line (GH-2083). Only ever ok|info, like
 *  `installed-plugin`: the kit is vendored BY CHOICE (validate-attestation.yml
 *  runs the gate scripts in Actions, where no plugin install exists, so a shim
 *  was never an option), which makes drift a fact to surface, not a breach.
 *  Compares the host repo's install stamp (.github/ralph-kit.json, written by
 *  install-gates.sh) against the installed plugin's kit manifest. Files the
 *  host modified or deleted are the host's — named, never counted as drift
 *  (recommend, never impose). */
export function gateKitReport(repoRoot: string): { level: "ok" | "info"; detail: string } {
  const stampPath = join(repoRoot, ".github", "ralph-kit.json");
  if (!existsSync(stampPath))
    return {
      level: "ok",
      detail:
        "no gate-kit stamp (.github/ralph-kit.json) — merge gates not installed from the plugin kit " +
        "(install-gates.sh writes one; a repo with its own gates, or the canonical repo, has none)",
    };
  let stamped: Record<string, string>;
  let stampVersion = "?";
  try {
    const stamp = JSON.parse(readFileSync(stampPath, "utf8"));
    if (!stamp?.files || typeof stamp.files !== "object") throw new Error("no files map");
    stamped = stamp.files;
    if (typeof stamp.version === "string") stampVersion = stamp.version;
  } catch (e) {
    return { level: "info", detail: `not evaluated: .github/ralph-kit.json unreadable (${(e as Error).message})` };
  }
  const copies = resolveInstalledPlugin("ralph");
  if (!copies)
    return { level: "info", detail: "not evaluated: a gate-kit stamp exists but no installed ralph plugin is recorded to compare it against" };
  // The HIGHEST installed version is the judge here — the question is "is a
  // better kit available than what is vendored", the inverse of the floor
  // check's lowest-copy rule (there the risk was a gate not running).
  const ranked = copies
    .filter((c) => compareVersions(c.version, "0.0.0") !== null)
    .sort((a, b) => compareVersions(b.version, a.version)!);
  const best = ranked[0];
  if (!best)
    return { level: "info", detail: `not evaluated: installed version unparseable (${copies.map((c) => c.version).join(", ")})` };
  const manifestPath = join(best.installPath, "kit", "manifest.json");
  let kitFiles: Record<string, string>;
  try {
    kitFiles = JSON.parse(readFileSync(manifestPath, "utf8"))?.files ?? {};
  } catch {
    return {
      level: "info",
      detail: `not evaluated: installed ralph ${best.version} ships no readable kit manifest (predates the kit, or a partial install)`,
    };
  }
  const outdated: string[] = [];
  const modified: string[] = [];
  const retired: string[] = [];
  let current = 0;
  for (const [dest, stampedHash] of Object.entries(stamped)) {
    const kitHash = kitFiles[dest];
    let hostHash: string | null = null;
    try {
      hostHash = createHash("sha256").update(readFileSync(join(repoRoot, dest))).digest("hex");
    } catch {
      hostHash = null; // deleted by the host — an opt-out install-gates.sh respects
    }
    if (kitHash === undefined) {
      retired.push(dest);
      continue;
    }
    if (hostHash === null) continue; // opt-out: not drift, not current
    if (hostHash !== stampedHash) {
      modified.push(dest); // the host owns this file now
      continue;
    }
    if (stampedHash === kitHash) current++;
    else outdated.push(dest);
  }
  const notes: string[] = [];
  if (modified.length) notes.push(`${modified.length} locally modified (the host's, respected)`);
  if (retired.length) notes.push(`${retired.length} retired from the kit`);
  const suffix = notes.length ? ` — ${notes.join("; ")}` : "";
  if (outdated.length === 0)
    return {
      level: "ok",
      detail: `gate kit ${stampVersion}: ${current} file(s) current with installed ralph ${best.version}${suffix}`,
    };
  return {
    level: "info",
    detail:
      `gate kit ${stampVersion} is behind installed ralph ${best.version}: ${outdated.length} file(s) outdated ` +
      `(${outdated.slice(0, 3).join(", ")}${outdated.length > 3 ? ", …" : ""})${suffix} — ` +
      `re-run: bash ${best.installPath}/scripts/install-gates.sh`,
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
  | "sibling-edge" // an OPEN item shares this closed node's own-repo parent (GH-1883)
  | "blocks-edge" // this closed node blocks an OPEN item (GH-1883)
  | "no-item-id"; // no ProjectV2Item handle came back — nothing safe to remove by

/** A closed issue whose board state never reached a terminal one. Already
 *  retained as `not-terminal`; carried separately only so prune can NAME it,
 *  because the remedy is a command (`board reconcile N`) rather than "wait".
 *  Derived from the same keep, never a second detector (GH-1883). */
export interface PruneDivergence {
  number: number;
  state: string; // board Workflow State
  stateReason: string | null; // COMPLETED / NOT_PLANNED
}

export interface PruneReport {
  candidates: PruneCandidate[];
  retained: Array<{ number: number; reason: PruneRetention }>;
  diverged: PruneDivergence[];
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

  // One-hop quiet neighbourhood (GH-1883). A closed issue often carries the
  // context an OPEN neighbour still needs, so two more edges hold it — both
  // read from data the walk ALREADY fetches, so this costs zero extra points:
  //  - siblings: parents of the open set. A closed item sharing one has an
  //    open sibling. One hop — a sibling's siblings are not walked.
  //  - blocks: the INVERSE of blockedBy, which GitHub does not expose as its
  //    own connection. An open item's CLOSED blockers are exactly the closed
  //    items that block something open, so the inverse falls out of the
  //    forward edge and no new nested connection is added (GH-1811).
  const openParents = new Set<number>();
  for (const i of open) if (i.parentNumber != null) openParents.add(i.parentNumber);
  const blocksSomethingOpen = new Set<number>();
  // Fail closed on a truncated blocker list: a blocker past the page is
  // invisible, so we cannot prove this closed item blocks nothing. Unlike the
  // per-item label check the unknown is on the OPEN side, so it taints every
  // candidate — heavy, but retention is the direction that loses nothing, and
  // the retained list names it rather than letting the sweep read as clean.
  let blockersUnknown = false;
  for (const i of open) {
    if (i.blockersTruncated) blockersUnknown = true;
    // Bare numbers: a cross-repo blocker's #N can alias an own-repo #N here.
    // The only consequence is retaining an item we could have pruned.
    for (const n of i.closedBlockers) blocksSomethingOpen.add(n);
  }

  const dayMs = 86_400_000;
  const candidates: PruneCandidate[] = [];
  const retained: PruneReport["retained"] = [];
  const diverged: PruneDivergence[] = [];
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
      // Every item here is a CLOSED issue by construction, so a non-terminal
      // board state IS axis divergence — a rendering branch off the existing
      // keep, not a second detector that could drift from doctor's sweep.
      diverged.push({ number: c.number, state: c.state, stateReason: c.stateReason });
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
    if (c.parentNumber != null && openParents.has(c.parentNumber)) {
      keep(c.number, "sibling-edge");
      continue;
    }
    if (blockersUnknown || blocksSomethingOpen.has(c.number)) {
      keep(c.number, "blocks-edge");
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
  return { candidates, retained, diverged, scanned: closed.length };
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
  return removeProjectItems(
    ctx,
    candidates.map((c) => ({ itemId: c.itemId, label: `#${c.number}` })),
  );
}

/** One project item to remove, and what to call it in a failure line. */
export interface RemovableItem {
  itemId: string;
  label: string;
}

/** The outcome of a breaker-bounded bulk loop — the run actually performed. */
export interface BulkApplyOutcome {
  attempted: number;
  succeeded: number;
  failed: string[];
  aborted: boolean; // stopped early on consecutive failures
}

/** The one bulk-mutation loop: per-item fault isolation (one failing item must
 *  not abort a run that is otherwise working) bounded by the consecutive-
 *  failure circuit breaker, so a rate limit or a revoked scope mid-run cannot
 *  burn the budget. Shared by `prune`, `sweep-non-issues` and the list-arity
 *  field writes (GH-2130) deliberately: the callers disagree about WHAT to act
 *  on and must keep disagreeing, but "when do we stop trying" is one answer,
 *  and a second copy of it is a second place for the circuit breaker to rot. */
export function applyWithBreaker<T>(
  items: T[],
  label: (item: T) => string,
  op: (item: T) => void,
): BulkApplyOutcome {
  const failed: string[] = [];
  let succeeded = 0;
  let attempted = 0;
  let consecutive = 0;
  for (const c of items) {
    attempted++;
    try {
      op(c);
      succeeded++;
      consecutive = 0; // progress resets the breaker
    } catch (e) {
      failed.push(`${label(c)} (${(e as Error).message})`);
      if (++consecutive >= PRUNE_MAX_CONSECUTIVE_FAILURES) {
        return { attempted, succeeded, failed, aborted: true };
      }
    }
  }
  return { attempted, succeeded, failed, aborted: false };
}

/** The removal loop, bounded twice: by the caller's slice (--limit) and by the
 *  shared breaker above. Extracted from the CLI case so it can be tested
 *  directly — the two bugs this replaces were both reachable only through the
 *  dispatch, which had no test. */
export function removeProjectItems(ctx: Ctx, items: RemovableItem[]): PruneApplyResult {
  const projectId = refreshCache(ctx).projectId;
  const r = applyWithBreaker(
    items,
    (c) => c.label,
    (c) =>
      ghGraphQL(
        ctx,
        `mutation($projectId: ID!, $itemId: ID!) {
          deleteProjectV2Item(input: { projectId: $projectId, itemId: $itemId }) { deletedItemId }
        }`,
        { projectId, itemId: c.itemId },
      ),
  );
  return { attempted: r.attempted, removed: r.succeeded, failed: r.failed, aborted: r.aborted };
}

// ---------------------------------------------------------------------------
// Non-issue sweep (GH-2050) — a ONE-TIME removal of the PR/draft items the
// project's built-in "Auto-add to project" workflow deposited before its
// filter was narrowed to `is:issue` on 2026-08-16 (GH-1889).
//
// Why a separate verb rather than an arm on `prune`: prune's predicate is a
// fail-closed argument about *issues other readers still need* — closedDrift,
// tend's Done audit, the apply-evidence sweep, tree edges. A non-issue item
// has none of those readers, because `board.ts` cannot see it at all: the
// item walk's content union has only an `... on Issue` fragment, so every PR
// and draft on this board is paged for, metered, and then dropped. Teaching
// prune's predicate to reason about a second kind of subject would erode the
// one guarantee it exists to make (GH-1821, GH-1889 both said so).
//
// Why it is safe in a way prune is not: removing a project item destroys that
// item's Workflow State and Claim field values. For an issue that is real
// loss. For a PR or draft there is nothing to lose — board.ts never wrote a
// field value on one and never read one back. The pull request itself is
// untouched, exactly as prune leaves the issue.
// ---------------------------------------------------------------------------

/** A board item whose content is not an issue — a pull request or a draft. */
export interface NonIssueItem {
  itemId: string;
  kind: string; // ProjectV2 item type: PULL_REQUEST, DRAFT_ISSUE, REDACTED, …
  isArchived: boolean;
  createdAt: string | null;
  creator: string | null;
  label: string; // "PR #2049" / "draft \"title\"" — what a failure line prints
}

export interface NonIssueWalk {
  nonIssue: NonIssueItem[];
  issues: number; // ISSUE items seen — never touched, reported for proportion
  scanned: number; // nodes paged
  pages: number;
  short: boolean; // paged fewer nodes than totalCount claimed
}

/** The item kinds this sweep will remove. An ALLOWLIST, not "everything that
 *  is not ISSUE" — `ProjectV2ItemType` also has `REDACTED`, which is what
 *  GitHub returns when the viewer cannot see an item's content, and a redacted
 *  item may perfectly well be an ISSUE whose board field values are real. A
 *  by-exclusion predicate would remove it and destroy them. Anything GitHub
 *  adds to that enum later lands on the retained side by default, which is the
 *  direction a sweep with no undo has to fail. */
export const SWEEPABLE_ITEM_KINDS: readonly string[] = ["PULL_REQUEST", "DRAFT_ISSUE"];

/** Why a non-issue item is NOT removed. Named for the same reason prune's
 *  retention reasons are: a sweep that silently drops items from its own
 *  candidate list reads identically to one that found nothing. */
export type NonIssueRetention =
  | "archived" // archived items reject writes — the mutation would fail anyway
  | "unrecognized-kind"; // absent, REDACTED, or a kind added after this shipped

export interface NonIssueSweepReport {
  candidates: NonIssueItem[];
  retained: Array<{ label: string; reason: NonIssueRetention }>;
  byKind: Array<[string, number]>;
  /** Newest non-issue item by createdAt — the ONLY observable of whether the
   *  auto-add source is still live. The ProjectV2 API cannot read a built-in
   *  workflow's filter (GH-1889), so its effect is all there is to look at. */
  newest: NonIssueItem | null;
}

/** Lean full-project walk selecting only what the sweep decides on.
 *
 *  Deliberately NOT `listItemsFull`: that walk drops every non-issue node
 *  before returning (its content union has no PR fragment), so the items this
 *  sweep exists to find are invisible to it. One connection, no nested ones —
 *  the 1-pt-per-page floor.
 *
 *  Never served from the item cache and never writes to it: this walk selects
 *  a different shape entirely, and a mutating path pays for truth anyway. */
export function walkNonIssueItems(ctx: Ctx): NonIssueWalk {
  const cache = refreshCache(ctx);
  const nonIssue: NonIssueItem[] = [];
  let issues = 0;
  let scanned = 0;
  let pages = 0;
  let expected = -1;
  let after: string | null = null;
  for (;;) {
    const data: any = ghGraphQL(
      ctx,
      `query($projectId: ID!, $after: String) {
        node(id: $projectId) {
          ... on ProjectV2 {
            items(first: ${ITEMS_PAGE}, after: $after) {
              totalCount
              pageInfo { hasNextPage endCursor }
              nodes {
                id
                type
                isArchived
                createdAt
                creator { login }
                content {
                  ... on PullRequest { number }
                  ... on DraftIssue { title }
                }
              }
            }
          }
        }
      }`,
      { projectId: cache.projectId, after },
    );
    const page = data?.node?.items;
    if (!page) break;
    pages++;
    if (typeof page.totalCount === "number") expected = page.totalCount;
    for (const n of page.nodes ?? []) {
      scanned++;
      const kind: string | null = typeof n?.type === "string" ? n.type : null;
      if (kind === "ISSUE") {
        issues++;
        continue;
      }
      const num = n?.content?.number;
      const title = n?.content?.title;
      nonIssue.push({
        itemId: n.id,
        // A null `type` is carried through as "unknown" rather than guessed
        // at. It is not on SWEEPABLE_ITEM_KINDS, so the classifier retains
        // it — a guess here is the one way this sweep could remove an issue.
        kind: kind ?? "unknown",
        isArchived: !!n.isArchived,
        createdAt: typeof n?.createdAt === "string" ? n.createdAt : null,
        creator: n?.creator?.login ?? null,
        label:
          typeof num === "number"
            ? `PR #${num}`
            : typeof title === "string"
              ? `draft "${title.slice(0, 40)}"`
              : `${kind ?? "unknown"} item ${n.id}`,
      });
    }
    if (!page.pageInfo?.hasNextPage) break;
    after = page.pageInfo.endCursor;
  }
  // Same completeness question GH-1896 asked of the main walk. A short read
  // here cannot cause a wrong removal — everything removed was seen — but it
  // can make an incomplete sweep read as a finished one, so it is reported
  // and the caller says another run is needed.
  return { nonIssue, issues, scanned, pages, short: expected >= 0 && scanned < expected };
}

/** The sweep predicate. Fails closed in the one direction that matters: an
 *  item whose kind did not come back is retained, never removed. */
export function classifyNonIssueSweep(walk: NonIssueWalk): NonIssueSweepReport {
  const candidates: NonIssueItem[] = [];
  const retained: Array<{ label: string; reason: NonIssueRetention }> = [];
  const byKind = new Map<string, number>();
  let newest: NonIssueItem | null = null;
  for (const it of walk.nonIssue) {
    byKind.set(it.kind, (byKind.get(it.kind) ?? 0) + 1);
    if (it.createdAt && (!newest?.createdAt || it.createdAt > newest.createdAt)) newest = it;
    if (!SWEEPABLE_ITEM_KINDS.includes(it.kind)) retained.push({ label: it.label, reason: "unrecognized-kind" });
    else if (it.isArchived) retained.push({ label: it.label, reason: "archived" });
    else candidates.push(it);
  }
  return { candidates, retained, byKind: [...byKind].sort((a, b) => b[1] - a[1]), newest };
}

/** One open PR that references no issue in this repo. */
export interface PrOrphanRow {
  number: number;
  title: string;
  author: string | null; // null = a deleted account; never matched against the ignore list
  isDraft: boolean;
  createdAt: string;
  ageDays: number;
}

export interface PrOrphanReport {
  scanned: number; // open PRs read
  orphans: PrOrphanRow[]; // unlinked, author not ignored — oldest first
  ignored: number; // unlinked, but by an author the policy skips
  unreadable: number[]; // PRs whose linkage could not be read at all
  ignoreAuthors: string[];
  configured: boolean;
}

/** Open PRs in the configured repo with no `closingIssuesReferences` (GH-2048).
 *
 *  `closingIssuesReferences` is GitHub's own derived linkage — the same field
 *  gate 6 reads — so this asks the question the merge gate asks, one step
 *  earlier and without a board item to hang it on. It is deliberately NOT a
 *  body regex: closing keywords are honoured in commit messages too, and a PR
 *  body is app-writable (GH-1940).
 *
 *  Cost is one connection page per 100 open PRs; the nested linkage read is
 *  `first: 1` because only its existence is in question, so nodeCount stays at
 *  the page's own size (GH-1811 — the nesting product is what bills).
 *
 *  A PR whose linkage object is absent from the response is counted as
 *  UNREADABLE rather than sorted into either bucket: "we could not tell" and
 *  "there is no linkage" are different claims, and collapsing them is the
 *  defect class this line exists to remove. */
export function prOrphans(ctx: Ctx): PrOrphanReport {
  // Normalized here as well as at the parse, so the comparison is spelling-
  // blind on both sides no matter how the Config was built.
  const ignore = new Set(ctx.cfg.prOrphans.ignoreAuthors.map(normalizeBotLogin));
  const orphans: PrOrphanRow[] = [];
  const unreadable: number[] = [];
  let scanned = 0;
  let ignored = 0;
  const now = ctx.now().getTime();
  let after: string | null = null;
  for (;;) {
    const data: any = ghGraphQL(
      ctx,
      `query($owner: String!, $repo: String!, $after: String) {
        repository(owner: $owner, name: $repo) {
          pullRequests(states: OPEN, first: 100, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes {
              number
              title
              isDraft
              createdAt
              author { login }
              closingIssuesReferences(first: 1) { totalCount }
            }
          }
        }
      }`,
      { owner: ctx.cfg.owner, repo: ctx.cfg.repo, after },
    );
    const page = data.repository?.pullRequests;
    if (!page) throw new Error(`could not read open PRs for ${ctx.cfg.owner}/${ctx.cfg.repo}`);
    assertPageInfo(page.pageInfo, `open PRs for ${ctx.cfg.owner}/${ctx.cfg.repo}`);
    for (const p of page.nodes ?? []) {
      if (!p?.number) continue;
      scanned++;
      const total = p.closingIssuesReferences?.totalCount;
      if (typeof total !== "number") {
        unreadable.push(p.number);
        continue;
      }
      if (total > 0) continue;
      const author: string | null = typeof p.author?.login === "string" ? p.author.login : null;
      if (author && ignore.has(normalizeBotLogin(author))) {
        ignored++;
        continue;
      }
      const created = Date.parse(p.createdAt ?? "");
      orphans.push({
        number: p.number,
        title: p.title ?? "",
        author,
        isDraft: p.isDraft === true,
        createdAt: p.createdAt ?? "",
        ageDays: Number.isFinite(created) ? Math.floor((now - created) / 86_400_000) : 0,
      });
    }
    if (!page.pageInfo.hasNextPage) break;
    after = page.pageInfo.endCursor;
  }
  orphans.sort((a, b) => b.ageDays - a.ageDays || a.number - b.number);
  return {
    scanned,
    orphans,
    ignored,
    unreadable,
    ignoreAuthors: ctx.cfg.prOrphans.ignoreAuthors,
    configured: ctx.cfg.prOrphans.configured,
  };
}

export function doctor(ctx: Ctx, opts: { fix?: boolean; strict?: boolean } = {}): DoctorReport {
  // The write-guard carve-out (GH-1806), enforced HERE and not only at the CLI
  // dispatch, so a programmatic caller cannot route around it. --fix selects
  // its correction targets from the walk and then mutates: a cached walk would
  // be reconciling a board that no longer looks like that. The report-only
  // sweep is a read like any other and keeps the cache.
  if (opts.fix) ctx = { ...ctx, itemCacheTtlSec: 0 };
  // The oracle is off for doctor even when only reporting (GH-1804): every
  // other consumer of a stale walk pays a wasted claim attempt, while doctor's
  // own sweeps read state and claim fields — precisely the writes the oracle
  // cannot see — and `--strict` turns what it read into an exit code.
  ctx = { ...ctx, itemOracleMaxSec: 0 };
  const checks: DoctorReport["checks"] = [];
  const add = (name: string, level: DoctorLevel, detail: string) =>
    checks.push({ name, level, detail });

  // auth
  const auth = ctx.exec(["gh", "auth", "status"]);
  add("gh-auth", auth.code === 0 ? "ok" : "fail", auth.code === 0 ? "authenticated" : auth.stderr.trim());

  // scope — "not a repo" and "no origin remote" are different bring-up steps,
  // and the gate every mutation depends on should name which is missing
  // rather than leave it an archaeology finding (audit C2).
  const remote = ctx.exec(["git", "-C", ctx.repoRoot, "remote", "get-url", "origin"]);
  if (remote.code !== 0) {
    const inRepo = ctx.exec(["git", "-C", ctx.repoRoot, "rev-parse", "--is-inside-work-tree"]);
    add(
      "scope",
      "warn",
      inRepo.code !== 0
        ? `not a git repository (${ctx.repoRoot}) — every mutation's scope gate needs one`
        : "no origin remote — `git remote add origin <url>`; the scope gate compares it against the configured repo",
    );
  }
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
      if (missing.length)
        add("state-field", "fail", `missing options: ${missing.join(", ")} (board setup adds them)`);
      else if (legacy.length)
        add(
          "state-field",
          opts.strict ? "fail" : "warn",
          `legacy options present (delete by hand in the board UI; removing an option clears ` +
            `the state of every item holding it, so setup never does): ${legacy.join(", ")}`,
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
    // GH-1815. INFO by construction — a posture is a configuration, never a
    // breach; the breach (a foreign item under `deny`) is `foreign-items`
    // below. Reported OUTSIDE the item sweep so a scan that throws still
    // leaves the operator able to see which posture is in effect.
    add(
      "foreign-repo-policy",
      "info",
      ctx.cfg.foreign.allow
        ? `allow — foreign-repo items are permitted (${FOREIGN_REPO_ENV} set); reads partition them out of every write path`
        : `deny${ctx.cfg.foreign.configured ? ` (${FOREIGN_REPO_ENV} set)` : " (default — nothing configured)"}` +
          ` — board.ts refuses to place a foreign-repo item on this board. GitHub has no pre-add hook, so items` +
          ` added by hand or by other automation are caught by the \`foreign-items\` sweep, not prevented.`,
    );

    // Unlinked open PRs (GH-2048). INFO by construction, same rules as
  // `board-volume`: --strict never escalates it and --fix never acts on it,
  // because the remedy is a judgment (link it, file an issue, close the PR)
  // and auto-adopting someone's branch onto the board is exactly what this
  // was designed not to do. Its own try/catch keeps a failed read from
  // changing doctor's exit code via the item sweep's catch.
  try {
    const po = prOrphans(ctx);
    const shown = po.orphans
      .slice(0, 5)
      .map((o) => `#${o.number} (${o.ageDays}d${o.isDraft ? ", draft" : ""}, ${o.author ?? "unknown author"})`)
      .join(" ");
    add(
      "pr-orphans",
      po.orphans.length === 0 && po.unreadable.length === 0 ? "ok" : "info",
      (po.orphans.length === 0
        ? `none of ${po.scanned} open PR(s) are unlinked`
        : `${po.orphans.length} of ${po.scanned} open PR(s) reference no issue — invisible to every board surface ` +
          `(no board item, so no \`next\`, \`deliver-queue\` or sweep row): ${shown}` +
          (po.orphans.length > 5 ? ` +${po.orphans.length - 5} more` : "") +
          `. \`board pr-orphans\` lists them. Remedy is a judgment: add a closing reference, file the issue, or close the PR`) +
        (po.ignored ? `; ${po.ignored} skipped by ${PR_ORPHAN_IGNORE_ENV}` : "") +
        (po.unreadable.length ? `; linkage UNREADABLE for ${po.unreadable.map((n) => `#${n}`).join(" ")} — not counted either way` : ""),
    );
  } catch (e) {
    add("pr-orphans", "info", `not evaluated: ${(e as Error).message}`);
  }

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
      // GH-1815: posture-aware. Under `allow` a foreign item is the configured
      // shape of the board and stays informational. Under `deny` it is a
      // policy breach AND the thing that would make GH-1814's repo-scoped walk
      // incomplete — so it warns. It does NOT escalate under --strict and
      // --fix never touches it: pre-existing items are grandfathered by
      // policy, the remedy removes work from a board, and that is a human's
      // call. A weekly CI doctor going red over a state the policy explicitly
      // declines to auto-fix would be the check crying wolf about itself.
      const foreignList = foreign.map((i) => `${i.repo}#${i.number}`).join(" ");
      add(
        "foreign-items",
        foreign.length === 0 || ctx.cfg.foreign.allow ? "ok" : "warn",
        foreign.length === 0
          ? "none"
          : ctx.cfg.foreign.allow
            ? `${foreign.length} item(s) from other repos on this board, permitted by ${FOREIGN_REPO_ENV} (board.ts never touches them): ${foreignList}`
            : `${foreign.length} item(s) from other repos on this board while foreign-repo items are DENIED: ${foreignList}. ` +
              `Grandfathered — never removed automatically. Either set ${FOREIGN_REPO_ENV}=true to permit them, ` +
              `or move them off this board; until then a repo-scoped read cannot be assumed complete.`,
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
        // GH-2052: over threshold is only NEWS when the remedy exists. Once
        // #2050 removed the PR/draft items the count became honest and the
        // line became permanent — 860 real issues, 0 prunable — because
        // `pruneAfterDays` floors the board at one retention window of closed
        // work, which at this repo's throughput is already above 800. A
        // threshold under that floor cannot be met by pruning, so an `i` that
        // never clears is the check crying wolf about itself (the failure
        // `foreign-items` above declines for the same reason). The
        // measurement is never withheld — doctor renders `ok` lines too — only
        // the marker that asks the reader to act.
        const actionable = vol.over && prune.candidates.length > 0;
        add(
          "board-volume",
          actionable ? "info" : "ok",
          `${vol.items} items = ${vol.pages} page(s) per full scan ` +
            `(${vol.open} open, ${vol.closed} closed${vol.archived ? `, ${vol.archived} archived` : ""}` +
            `${vol.nonIssue ? `, ${vol.nonIssue} non-issue (PRs/drafts board.ts never reads)` : ""})` +
            (vol.over
              ? `; over ${vol.maxItems} (RALPH_VOLUME_MAX_ITEMS) — every scan pays for all of it, and ` +
                `archiving would NOT help (archived items are still returned by the items API). ` +
                (actionable
                  ? `\`board prune\` lists ${prune.candidates.length} closed item(s) safe to remove from the project ` +
                    `(the issues are untouched); it is a dry run until \`--apply\``
                  : `Nothing is prunable — every closed item is still read by something (\`board prune\` says which), ` +
                    `so there is no action and this reads ok rather than info: the board cannot fall below one ` +
                    `${ctx.cfg.volume.pruneAfterDays}-day window of closed work, and a threshold under that floor ` +
                    `would fire forever with no remedy`)
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

      // Stranded local work (audit B6's mirror row): a worktree with
      // uncommitted changes whose branch parses as an issue branch while that
      // issue carries no claim — the shape a TTL release leaves behind, which
      // until now only a human's memory surfaced. INFO always: resuming or
      // re-claiming is a judgment, and --fix must never touch a working tree.
      // Machine-local by nature (git reads only), own try/catch so an odd git
      // cannot change doctor's exit code.
      try {
        const wt = ctx.exec(["git", "-C", ctx.repoRoot, "worktree", "list", "--porcelain"]);
        if (wt.code !== 0) {
          add("worktree-uncommitted", "info", "not evaluated: git worktree list failed");
        } else {
          const claimed = new Set(items.filter((i) => i.claim).map((i) => i.number));
          const rows: string[] = [];
          for (const block of wt.stdout.trim().split(/\n\n+/)) {
            const path = /^worktree (.+)$/m.exec(block)?.[1];
            const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1];
            if (!path || !branch) continue;
            const parsed = parseBranchName(branch);
            if (!parsed || claimed.has(parsed.issue)) continue;
            const st = ctx.exec(["git", "-C", path, "status", "--porcelain"]);
            if (st.code !== 0 || !st.stdout.trim()) continue; // unreadable = not evidence
            rows.push(`#${parsed.issue}(${path})`);
          }
          add(
            "worktree-uncommitted",
            rows.length === 0 ? "ok" : "info",
            rows.length === 0
              ? "none"
              : `uncommitted work in issue worktrees with no live board claim — resume the session or \`board claim N\` there: ${rows.join(" ")}`,
          );
        }
      } catch (e) {
        add("worktree-uncommitted", "info", `not evaluated: ${(e as Error).message}`);
      }

      // Defer marks past their recheck instant (audit B8). INFO by
      // construction: a defer is a judgment on the record, and lifting it is
      // one too — --strict never escalates, --fix never acts. The marker only
      // renders when the remedy applies (GH-2052's rule).
      const deferElapsed = items.filter(
        (i) => i.defer?.recheck && i.defer.recheck.getTime() <= ctx.now().getTime(),
      );
      add(
        "defer-elapsed",
        deferElapsed.length === 0 ? "ok" : "info",
        deferElapsed.length === 0
          ? "none"
          : `deferred items past their recheck instant — re-test the condition and \`board defer N --clear\` or re-defer: ` +
            deferElapsed.map((i) => `#${i.number}(${i.defer!.condition})`).join(" "),
      );

      // Null-Priority intake (audit B5). INFO with the remedy named: a null
      // priority sinks below stale backlog in `next`, so these items are
      // invisible to every ranking lane until someone triages them.
      const untriaged = items.filter((i) => i.state === "Backlog" && !i.priority);
      add(
        "untriaged-priority",
        untriaged.length === 0 ? "ok" : "info",
        untriaged.length === 0
          ? "none"
          : `${untriaged.length} Backlog item(s) with no Priority — invisible to next/frontier ranking; ` +
            `\`board priority N P0..P3\`: ${untriaged.slice(0, 10).map((i) => `#${i.number}`).join(" ")}` +
            (untriaged.length > 10 ? ` +${untriaged.length - 10} more` : ""),
      );

      // Aging intake (GH-2077). Advisory in full: an Intake item is TRACKED
      // and deliberately not eligible, so this is never an invariant breach —
      // `--strict` does not escalate it and `--fix` may not act on it, because
      // the only remedies are a human's approval or a human's cancellation.
      // Its whole job is to keep pending intake from becoming invisible again
      // by a different route: a queue that is empty because nothing is
      // approved must not read like a queue that is empty because there is
      // nothing to do (GH-2048's lesson, one tier upstream).
      //
      // An unreadable/absent createdAt does NOT count as aged: a date GitHub
      // never asserted is not evidence that anyone has been waiting.
      const intakeDayMs = 86_400_000;
      // GH-2202: a snoozed item (Defer with a future recheck) is withheld
      // until the recheck instant, then resurfaces with its FULL age — the
      // snooze suppressed the reminder, never the fact. Suppression is
      // counted, never silent: a withheld reminder with no trace reads
      // identical to a healthy queue (the GH-1945 rule).
      const agedAll = items
        .filter((i) => i.state === "Intake")
        .map((i) => {
          const t = i.createdAt ? Date.parse(i.createdAt) : NaN;
          return {
            number: i.number,
            days: Number.isFinite(t) ? (ctx.now().getTime() - t) / intakeDayMs : null,
            snoozed: !!(i.defer?.recheck && i.defer.recheck.getTime() > ctx.now().getTime()),
          };
        })
        .filter((r) => r.days !== null && r.days >= ctx.cfg.smells.intakeDays);
      const agedIntake = agedAll.filter((r) => !r.snoozed);
      const snoozedIntake = agedAll.length - agedIntake.length;
      const snoozeNote = snoozedIntake > 0 ? ` (${snoozedIntake} snoozed until their recheck)` : "";
      add(
        "intake-stale",
        agedIntake.length === 0 ? "ok" : "info",
        agedIntake.length === 0
          ? `none${snoozeNote}`
          : `${agedIntake.length} Intake item(s) awaiting an approval decision ≥${ctx.cfg.smells.intakeDays}d${snoozeNote} — ` +
            `approve (\`board move N backlog\`, needs Priority + Estimate) or reject (\`board cancel N -m "why"\`): ` +
            agedIntake.slice(0, 10).map((r) => `#${r.number}(${Math.floor(r.days!)}d)`).join(" ") +
            (agedIntake.length > 10 ? ` +${agedIntake.length - 10} more` : ""),
      );

      // Apply-kind sweep (GH-1693). Inert — three `ok` lines — on a repo that
      // has not opted in, and on an opted-in board with no apply issues.
      if (!ctx.cfg.apply.enabled) {
        for (const n of ["merged-unapplied", "apply-verify-elapsed", "apply-closed-unevidenced"]) {
          add(n, "ok", "apply kind not enabled (no `apply` block in .github/ralph-merge-policy.json)");
        }
      } else {
        const openApply = items.filter((i) => isApplyIssue(ctx.cfg, i.labels, i.labelsTruncated));
        // One body read per open apply unit, shared by merged-unapplied's hold
        // and apply-verify-elapsed below. An entry is either the parsed
        // verify-after instant (null = no marker) or the read failure.
        const verifyAfter = new Map<number, { at: Date | null } | { error: string }>();
        for (const i of openApply) {
          try {
            verifyAfter.set(i.number, { at: parseVerifyAfter(fetchApplyMeta(ctx, i.number).body) });
          } catch (e) {
            verifyAfter.set(i.number, { error: (e as Error).message });
          }
        }
        // The ship work this apply unit waited on has landed and the apply has
        // not happened. Requires blockers to have EXISTED: an apply unit with
        // no dependency edge was never gated on a merge, so "merged" is not a
        // claim anyone made about it.
        // blockersTruncated fails CLOSED here too: with an unseen tail of
        // blockers we cannot claim "the work this waited on has landed".
        const mergedCandidates = openApply.filter(
          (i) => i.openBlockers.length === 0 && !i.blockersTruncated && i.closedBlockers.length > 0,
        );
        // A future ralph-verify-after HOLDS the warning (GH-2124): a soak- or
        // schedule-bound proof point cannot be applied yet, so warning daily is
        // an advisory whose remedy is unreachable (the GH-2052 shape). Held
        // items are still named — the measurement is printed, only the marker
        // asking a reader to act is withheld. An unreadable body does NOT
        // hold: this check exists to say the deploy has not happened, so a
        // failed read stays loud.
        const held: string[] = [];
        const mergedUnapplied = mergedCandidates.filter((i) => {
          const v = verifyAfter.get(i.number);
          if (v && "at" in v && v.at && v.at.getTime() > ctx.now().getTime()) {
            held.push(`#${i.number}(until ${v.at.toISOString()})`);
            return false;
          }
          return true;
        });
        const heldDetail = held.length ? `held until their ralph-verify-after instant: ${held.join(" ")}` : "";
        add(
          "merged-unapplied",
          mergedUnapplied.length === 0 ? "ok" : "warn",
          mergedUnapplied.length === 0
            ? heldDetail || "none"
            : [
                `apply units whose blocking work has landed but which have not been applied: ` +
                  mergedUnapplied.map((i) => `#${i.number}←closed ${i.closedBlockers.map((n) => `#${n}`).join(",")}`).join(" "),
                heldDetail,
              ].filter(Boolean).join("; "),
        );
        // verify_after keeps a schedule-bound proof point (a weekly cron is up
        // to 7 days out) alive without rotting into daily noise: quiet until
        // the instant passes, then loud.
        // Per-item fault isolation: one unreadable body must not hide every
        // OTHER elapsed apply unit — it is reported alongside them, not
        // instead of them.
        const elapsed: string[] = [];
        const unreadable: string[] = [];
        for (const i of openApply) {
          const v = verifyAfter.get(i.number)!;
          if ("error" in v) {
            unreadable.push(`#${i.number}(${v.error})`);
          } else if (v.at && v.at.getTime() <= ctx.now().getTime()) {
            elapsed.push(`#${i.number}(due ${v.at.toISOString()})`);
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
        const unresumed: string[] = [];
        for (const i of items) {
          const h = histories.get(i.number);
          if (!h) continue; // no history read = nothing observed = nothing to say
          if (i.state === "Human Needed") {
            // GH-2204: answered but never resumed. `answer` no longer takes
            // the resume edge, so this window is real by design — and it may
            // not rot silently. Unreadable answer clock ages as overdue (the
            // fail-toward-visibility direction, same as auto-promote).
            const esc = classifyEscalation(h.comments, ctx.now(), ctx.cfg.lockTtlMin);
            if (esc.answered) {
              const t = esc.answered.at ? new Date(esc.answered.at).getTime() : NaN;
              const min = Number.isFinite(t) ? (ctx.now().getTime() - t) / 60_000 : null;
              if (min === null) unresumed.push(`#${i.number}(undated answer)`);
              else if (min >= ctx.cfg.smells.answerMin) unresumed.push(`#${i.number}(${Math.floor(min)}min)`);
            }
          }
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
          } else {
            // Accepted but never moved (audit B9): the decision is on the
            // record and the item still sits open — surfaced immediately, no
            // age threshold, because someone already decided.
            const a = acceptedUnactioned(h.comments);
            if (a) proposals.push(`#${i.number}(accepted${a.at ? ` ${a.at.slice(0, 10)}` : ""}, unactioned)`);
          }
        }
        add(
          "repeated-claim-expiry",
          expiries.length === 0 ? "ok" : "info",
          expiries.length === 0
            ? "none"
            : `claims lost repeatedly — empirically too large for one tick; ` +
              `split via \`board create --backlog --parent N\`: ${expiries.join(" ")}`,
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
        add(
          "answer-unresumed",
          unresumed.length === 0 ? "ok" : "info",
          unresumed.length === 0
            ? "none"
            : `answered ≥${ctx.cfg.smells.answerMin}min ago and still Human Needed — the answer is ` +
              `on record but nobody is driving; a session resumes it with \`board claim N\` ` +
              `(or \`board cancel N -m\` if the answer was "don't"): ${unresumed.join(" ")}`,
        );
      } catch (e) {
        for (const n of SMELL_CHECKS) add(n, "info", `not evaluated: ${(e as Error).message}`);
      }

      // Unjudged high-overlap dependency candidates (GH-2136). Advisory in
      // full — the info rules verbatim: `--strict` never escalates it, `--fix`
      // never acts on it (wiring an edge is a judgment, not a repair), and a
      // throwing read degrades to `not evaluated`. It exists because tend is
      // capped at RALPH_TEND_BATCH per pass, so an unwired candidate can sit
      // for many passes without ever being the item under judgment — this
      // line is the count that keeps that backlog visible, and tend is the
      // remedy it names. Own try/catch for the same reason the smells have
      // one: no advisory hint is worth changing doctor's exit code.
      try {
        const pool = items
          .filter((i) => i.state === "Backlog" && !i.claim)
          .map((i) => ({
            number: i.number,
            title: i.title,
            openBlockers: i.openBlockers ?? [],
            closedBlockers: i.closedBlockers ?? [],
            blockersTruncated: i.blockersTruncated,
            parentNumber: i.parentNumber ?? null,
          }));
        let unwired = new Map<number, DepCandidate[]>();
        if (pool.length >= 2) {
          const bodies = fetchIssueBodies(ctx, pool.map((i) => i.number));
          // Comments-only trails (GH-1891 doctrine): dismissal markers are
          // comments, and this line reads no state history.
          const trails = fetchCommentTrails(ctx, pool.map((i) => i.number));
          const dismissed = new Set<string>();
          for (const t of trails.values()) for (const k of dismissedDepPairs(t)) dismissed.add(k);
          unwired = depsUnwiredMap(
            pool,
            bodies,
            dismissed,
            parseDepOverlapMin(process.env.RALPH_DEP_OVERLAP_MIN),
            parseDepCandidatesCap(process.env.RALPH_DEP_CANDIDATES_MAX),
          );
        }
        const nums = [...unwired.keys()].sort((a, b) => a - b);
        add(
          "deps-unwired",
          nums.length === 0 ? "ok" : "info",
          nums.length === 0
            ? "none"
            : `${nums.length} Backlog item(s) with unjudged high-overlap dependency candidates ` +
              `(overlap ≥ ${parseDepOverlapMin(process.env.RALPH_DEP_OVERLAP_MIN)}) — tend judges each ` +
              `(\`board tend-queue\` carries the candidates; wire \`board dep N --on M\` or dismiss ` +
              `\`board dep N --on M --dismiss\`): ` +
              nums.slice(0, 10).map((n) => `#${n}`).join(" ") +
              (nums.length > 10 ? ` +${nums.length - 10} more` : ""),
        );
      } catch (e) {
        add("deps-unwired", "info", `not evaluated: ${(e as Error).message}`);
      }

      // Fix loops are per-item fault-isolated: one unwritable item logs its
      // own fail line and the sweep keeps going.
      if (opts.fix) {
        // Terminal drift is the board being AHEAD of GitHub — the shape a
        // half-applied `move done` leaves (field written, close lost to the
        // network). Reconcile would demote the finished work to Backlog, so
        // the close is COMPLETED instead — but only on the same evidence a
        // fresh move would demand (a UI write saying "Done" is not evidence).
        // No evidence, or any read failure → reconcile demotes as before:
        // the repair may not be weaker than the gate it repairs around.
        for (const i of terminalDrift) {
          try {
            const issue = fetchIssue(ctx, i.number);
            const terminal = issue.state === "Done" || issue.state === "Canceled";
            if (issue.issueState !== "OPEN" || !terminal) {
              add("fix", "ok", reconcile(ctx, i.number));
              continue;
            }
            try {
              if (issue.state === "Done") guardDoneEvidence(ctx, issue, undefined);
              closeIssue(ctx, issue.nodeId, issue.state === "Done" ? "COMPLETED" : "NOT_PLANNED");
              addComment(
                ctx,
                issue.nodeId,
                `\`board doctor --fix\`: board said "${issue.state}" but the issue was still open — completed the close.`,
              );
              add("fix", "ok", `#${i.number}: completed the close the board was ahead of ("${issue.state}")`);
            } catch {
              add("fix", "ok", reconcile(ctx, i.number));
            }
          } catch (e) {
            add("fix", "fail", `#${i.number}: ${(e as Error).message}`);
          }
        }
        for (const i of closedDrift) {
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
        //
        // A stale BOARD claim can still be driven locally: a network flap that
        // ate the heartbeat's board write leaves the per-(worktree, unit) lock
        // (GH-1956) fresh while the board's copy ages out. The lock ages on
        // the SAME RALPH_LOCK_TTL_MIN clock — deliberately, "the source is
        // gone" has exactly one definition here — so this consult adds signal
        // only where the two writes diverged, and a genuinely dead session
        // still costs one TTL and is then released. Null probe (unreadable
        // sessions dir) keeps today's release: "could not read the lease"
        // never blocks the remedy.
        const lease = localSessionLease(ctx);
        for (const i of stale) {
          try {
            const hold = lease?.(i.number) ?? null;
            if (hold) {
              add(
                "claim-idle-but-driven",
                "info",
                `#${i.number}: board claim is stale but a live local session holds the worktree lock ` +
                  `(${hold.worktree}, lease expires ${hold.expiresAt}) — left alone`,
              );
              continue;
            }
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

  // heartbeat (GH-1909). The file's age alone cannot tell "no scheduler was
  // ever installed here" from "a scheduler is registered and has stopped
  // firing", and only the second is worth an alarm: a machine that ran one
  // manual tick months ago warns forever from a leftover file. So the
  // registration fact is consulted too — read from install-loop.sh, which
  // owns how the job is registered, rather than re-derived here.
  {
    const hb = join(process.env.RALPH_HOME || join(homedir(), ".ralph"), "heartbeat");
    const ageMin = existsSync(hb)
      ? (ctx.now().getTime() - Number(readFileSync(hb, "utf8").trim()) * 1000) / 60_000
      : null;
    const fresh = ageMin !== null && ageMin < 60;
    const age = ageMin === null ? "" : `${ageMin.toFixed(0)} min old`;

    let registered: boolean | null = null; // null = could not be determined
    let note = "";
    try {
      const sh =
        process.env.RALPH_INSTALL_LOOP_SH ??
        join(dirname(fileURLToPath(import.meta.url)), "install-loop.sh");
      if (existsSync(sh)) {
        const r = ctx.exec(["bash", sh, "--status"]);
        if (r.code === 0 || r.code === 1) {
          registered = r.code === 0;
          note = r.stdout.trim().replace(/^loop:\s*/, "");
        }
      }
    } catch {
      /* registration stays unknown; the heartbeat half still reports */
    }

    if (registered === null) {
      // Unknown registration: fall back to the age-only reading, fail-closed.
      if (ageMin === null) add("heartbeat", "ok", "absent (scheduler registration not evaluated)");
      else add("heartbeat", fresh ? "ok" : "warn", `${age} (scheduler registration not evaluated)`);
    } else if (registered) {
      if (ageMin === null) add("heartbeat", "warn", `scheduler registered but has never fired — ${note}`);
      else if (fresh) add("heartbeat", "ok", `${age} — ${note}`);
      else add("heartbeat", "warn", `scheduler registered but not firing — ${age}, ${note}`);
    } else {
      if (ageMin === null) add("heartbeat", "ok", "absent (loop not installed)");
      else if (fresh) add("heartbeat", "ok", `${age} (manual tick; loop not installed)`);
      else add("heartbeat", "info", `loop not installed; heartbeat ${age} is a leftover — \`install-loop.sh --enable\` to run the loop`);
    }
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
  //
  // GH-1911: the level stays info — deliberately, and for the same reason
  // `installed-plugin` is only ever ok|info: severity here would buy nothing an
  // operator can act on and would cost the property that keeps CI green on a
  // machine with no cockpit. What was actually broken was the RELAY. The line
  // used to carry a count and a check name, so a genuine deploy gap ("the
  // cockpit is running plugin code older than this ralph expects") rendered
  // identically to setup drift and was read as cosmetic for a working day. The
  // fix is in `--oneline`, which now carries each gap's detail — both versions
  // and the remedy command — and this relay passes it through whole. A line
  // that cannot carry its finding should not claim to have reported it.
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
        // GH-2105: a wired verdict may carry the worktree-pile fragment — the
        // one number that accretes on a HEALTHY cockpit. Flattening it to the
        // bare "wired" is how ~60 finished worktrees stayed invisible to every
        // doctor pass; pass whatever follows "wired" through whole instead.
        const extra = line.replace(/^herdr:\s*wired[;\s]*/, "").trim();
        add("herdr-cockpit", "ok", extra ? `wired (optional cockpit) — ${extra}` : "wired (optional cockpit)");
      } else if (r.code === 2) {
        add("herdr-cockpit", "info", "herdr not installed — optional cockpit; `/ralph:help herdr` to set it up");
      } else {
        add("herdr-cockpit", "info", `${line.replace(/^herdr:\s*/, "")} — \`/ralph:help herdr\` walks the setup`);
      }
    }
  } catch (e) {
    add("herdr-cockpit", "info", `not evaluated: ${(e as Error).message}`);
  }

  // GraphQL spend attribution (audit B2). INFO always: a number is a fact,
  // never a breach — the exhaustion incident's real blocker was that no
  // surface said WHO was spending. Reads the per-invocation ledger every
  // command already appends; an absent ledger is a young machine, not a
  // problem.
  try {
    const ledger = join(process.env.RALPH_HOME || join(homedir(), ".ralph"), "budget.jsonl");
    if (!existsSync(ledger)) {
      add("gql-spend", "ok", "no spend ledger yet (~/.ralph/budget.jsonl appends per invocation)");
    } else {
      const cutoff = ctx.now().getTime() - 24 * 3600_000;
      const byCmd = new Map<string, number>();
      let total = 0;
      for (const line of readFileSync(ledger, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const j = JSON.parse(line);
          if (new Date(j.at).getTime() < cutoff) continue;
          byCmd.set(j.cmd, (byCmd.get(j.cmd) ?? 0) + (j.points ?? 0));
          total += j.points ?? 0;
        } catch {
          /* one garbled line is not a broken ledger */
        }
      }
      const top = [...byCmd.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
      add(
        "gql-spend",
        "ok",
        total === 0
          ? "0 points recorded in the last 24h"
          : `${total} points in 24h — top: ${top.map(([c, p]) => `${c}=${p}`).join(" ")} (~/.ralph/budget.jsonl)`,
      );
    }
  } catch (e) {
    add("gql-spend", "info", `not evaluated: ${(e as Error).message}`);
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

  // Gate-kit drift (GH-2083). INFO level always, same construction as the
  // floor check above: vendored gates that lag the plugin are a fact worth a
  // line, never a breach — and a repo with no stamp hears "ok", not noise.
  try {
    const r = gateKitReport(ctx.repoRoot);
    add("gate-kit", r.level, r.detail);
  } catch (e) {
    add("gate-kit", "info", `not evaluated: ${(e as Error).message}`);
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

// — Integration policy (GH-2138) — Level-3 concurrency checks that emit a
// RECOMMENDED POLICY, not a table: a report that outputs a decision gets
// read; one that outputs a table joins the twelve unread dependabot PRs
// (GH-2048's honest limit). Ralph recommends a merge queue and never
// implements one (a named non-goal — GitHub ships this). Advisory twice
// over: status is only ever ok/info, so nothing here can move readyFor.

/** First-parent landings measured for the collision surface. */
const INTEGRATION_MERGE_WINDOW = 50;
/** A file is "hot" when it appears in at least this share of the window. */
const INTEGRATION_HOT_SHARE = 0.3;
/** Below this many landings a collision share is noise, not a signal. */
const INTEGRATION_MIN_SAMPLE = 10;

export interface IntegrationSignals {
  /** null on every input = unreadable — and a check we cannot run must not
   *  manufacture a gap, so each null degrades the verdict toward info. */
  mergeQueue: boolean | null;
  /** ruleset "require branches to be up to date" (strict status checks) */
  strict: boolean | null;
  mergesPerWeek: number | null;
  medianPrHours: number | null;
  /** files in ≥ INTEGRATION_HOT_SHARE of measured landings, formatted
   *  "path (n/window)"; [] = measured and quiet; null = not measured. */
  hotFiles: string[] | null;
  /** landings the window actually held — 0 = history unreadable/empty. */
  mergesMeasured: number;
}

/** The decision, pure. Exported for tests. */
export function integrationPolicy(
  s: IntegrationSignals,
): { status: "ok" | "info"; detail: string; recommend?: string } {
  const load: string[] = [];
  if (s.mergesPerWeek !== null) load.push(`${s.mergesPerWeek} landings/wk on the default branch`);
  if (s.medianPrHours !== null) load.push(`median PR lifetime ${s.medianPrHours}h`);
  const loadStr = load.length ? ` — measured: ${load.join(", ")}` : "";

  if (s.mergeQueue === true) {
    return {
      status: "ok",
      detail:
        "merge queue active — verified-as-landed with no human or agent rebasing; " +
        `no integration-policy change recommended${loadStr}`,
    };
  }
  if (s.mergeQueue === null) {
    // Unreadable ruleset: the recommendation hinges on whether a queue
    // exists, so there is no honest decision to emit — say so, recommend
    // nothing, and never render the unread as a gap.
    return {
      status: "info",
      detail: `not evaluated: branch ruleset unreadable (merge queue / require-up-to-date unknown)${loadStr}`,
    };
  }
  if (s.strict === true) {
    // The org-standard case ("PRs must be up to date with main"): strict
    // without a queue forces a rebase after every merge whether or not
    // anything conflicts — O(n²) — for a property the queue buys exactly
    // once, at the only moment freshness is worth anything.
    return {
      status: "info",
      detail:
        "require-up-to-date (strict) is set with no merge queue — every merge obsoletes every open " +
        `PR's freshness, a rebase bill paid by humans or agents${loadStr}`,
      recommend:
        "enable GitHub's merge queue on the default branch — it rebases and tests speculatively " +
        "exactly once at merge time, delivering tested-against-HEAD with nobody rebasing",
    };
  }
  if (s.hotFiles === null) {
    return {
      status: "info",
      detail:
        (s.mergesMeasured > 0
          ? `collision surface not assessed (${s.mergesMeasured} landing(s) measured, ` +
            `need ${INTEGRATION_MIN_SAMPLE})`
          : "collision surface not measured (default-branch history unreadable)") +
        `; no merge queue, strict unset${loadStr}`,
    };
  }
  if (s.hotFiles.length > 0) {
    return {
      status: "info",
      detail:
        `high collision surface with no merge queue and strict unset: ${s.hotFiles.join(", ")}` +
        loadStr,
      recommend:
        "this churn is substrate, not decomposition — recommend a merge queue before narrowing " +
        "agent concurrency",
    };
  }
  return {
    status: "ok",
    detail:
      "no integration pressure measured — plain PRs against an un-strict default branch fit " +
      `this load (no hot files in the last ${s.mergesMeasured} landings)${loadStr}`,
  };
}

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
  // Kept for the merge-gate check below (audit C1): a recommendation whose
  // alternative the tool can check and doesn't is a false positive that
  // trains operators to ignore the report. null = unreadable, never "no".
  type BranchRule = {
    type?: string;
    parameters?: { strict_required_status_checks_policy?: boolean };
  };
  let branchRules: BranchRule[] | null = null;
  // Kept for the integration-policy check below (GH-2138): the merge history
  // that measures collision has to be read off the DEFAULT branch, not
  // whatever branch this worktree happens to have checked out.
  let defaultBranch: string | null = null;
  const repoInfo = ctx.exec(["gh", "api", "--hostname", ctx.cfg.host, `repos/${ctx.cfg.owner}/${ctx.cfg.repo}`]);
  if (repoInfo.code === 0) {
    try {
      const def = JSON.parse(repoInfo.stdout).default_branch as string;
      defaultBranch = def;
      const rules = ctx.exec([
        "gh", "api", "--hostname", ctx.cfg.host,
        `repos/${ctx.cfg.owner}/${ctx.cfg.repo}/rules/branches/${def}`,
      ]);
      if (rules.code === 0) {
        branchRules = JSON.parse(rules.stdout) as BranchRule[];
        const requiresPr = branchRules.some((r) => r.type === "pull_request");
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
  // The named alternative, CHECKED (audit C1): required status checks under
  // the effective branch rules satisfy this rung without a scripted gate.
  // Unreadable rules stay a miss — a read we could not make is not "satisfied".
  const requiredChecks = branchRules?.some((r) => r.type === "required_status_checks") ?? false;
  add(
    3, "merge-gate", hasGate || requiredChecks ? "ok" : "miss",
    hasGate
      ? "scripts/merge-pr.sh present"
      : requiredChecks
        ? "no scripted gate, but required status checks are active on the default branch — the stated alternative, verified"
        : "no scripted merge gate",
    hasGate
      ? undefined
      : "before agents merge unattended, script the merge verdict — the plugin ships the whole family as an " +
        "installable kit (`bash <plugin>/scripts/install-gates.sh` from this repo vendors merge-pr.sh, attestation, " +
        "review evidence and the validating workflow, and prints the ruleset steps) — or encode it as required status checks",
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

  // Integration policy (GH-2138). Level 3 is the home because concurrency
  // policy only becomes a question once the autonomous loop runs — which is
  // what Level 3 IS; a repo driving interactively hears nothing new
  // elsewhere. Every measurement below degrades to null on any failed read,
  // and integrationPolicy() renders null as info, never miss.
  {
    const mergeQueue = branchRules === null ? null : branchRules.some((r) => r.type === "merge_queue");
    const strict =
      branchRules === null
        ? null
        : branchRules.some(
            (r) =>
              r.type === "required_status_checks" &&
              r.parameters?.strict_required_status_checks_policy === true,
          );

    // Collision surface + velocity: first-parent landings on the DEFAULT
    // branch (origin's view first — this worktree's HEAD is usually a
    // feature branch). `-m` with `--first-parent` makes merge commits show
    // their first-parent diff, so squash-merge and merge-commit repos
    // measure the same thing: what each landing touched.
    let mergesPerWeek: number | null = null;
    let hotFiles: string[] | null = null;
    let mergesMeasured = 0;
    const refCandidates = defaultBranch ? [`origin/${defaultBranch}`, defaultBranch, "HEAD"] : ["HEAD"];
    for (const ref of refCandidates) {
      const log = ctx.exec([
        "git", "-C", ctx.repoRoot, "log", "--first-parent", "-m",
        "-n", String(INTEGRATION_MERGE_WINDOW), "--format=%x1e%ct", "--name-only", ref, "--",
      ]);
      if (log.code !== 0) continue;
      const chunks = log.stdout.split("\x1e").map((c) => c.trim()).filter(Boolean);
      mergesMeasured = chunks.length;
      const times: number[] = [];
      const touched = new Map<string, number>();
      for (const chunk of chunks) {
        const lines = chunk.split("\n").map((l) => l.trim()).filter(Boolean);
        const ct = Number(lines.shift());
        if (Number.isFinite(ct)) times.push(ct);
        for (const f of new Set(lines)) touched.set(f, (touched.get(f) ?? 0) + 1);
      }
      if (times.length >= 2) {
        // Floor the span at a day so a burst of landings reads as high
        // velocity rather than dividing by zero.
        const weeks = Math.max((Math.max(...times) - Math.min(...times)) / 604_800, 1 / 7);
        mergesPerWeek = Math.round((mergesMeasured / weeks) * 10) / 10;
      }
      if (mergesMeasured >= INTEGRATION_MIN_SAMPLE) {
        const floor = Math.ceil(mergesMeasured * INTEGRATION_HOT_SHARE);
        hotFiles = [...touched.entries()]
          .filter(([, n]) => n >= floor)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([f, n]) => `${f} (${n}/${mergesMeasured})`);
      }
      break;
    }

    // Median PR lifetime: the last window of closed PRs, merged ones only.
    let medianPrHours: number | null = null;
    const pulls = ctx.exec([
      "gh", "api", "--hostname", ctx.cfg.host,
      `repos/${ctx.cfg.owner}/${ctx.cfg.repo}/pulls?state=closed&per_page=${INTEGRATION_MERGE_WINDOW}`,
    ]);
    if (pulls.code === 0) {
      try {
        const hours = (JSON.parse(pulls.stdout) as Array<{ created_at?: string; merged_at?: string | null }>)
          .filter((p) => p.merged_at && p.created_at)
          .map((p) => (Date.parse(p.merged_at!) - Date.parse(p.created_at!)) / 3_600_000)
          .filter((h) => Number.isFinite(h) && h >= 0)
          .sort((a, b) => a - b);
        if (hours.length > 0) medianPrHours = Math.round(hours[Math.floor(hours.length / 2)] * 10) / 10;
      } catch { /* unreadable payload = not measured, never a gap */ }
    }

    const pol = integrationPolicy({ mergeQueue, strict, mergesPerWeek, medianPrHours, hotFiles, mergesMeasured });
    add(3, "integration-policy", pol.status, pol.detail, pol.recommend);
  }
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

interface LiveOption {
  id: string;
  name: string;
  color: string;
  description: string;
}

/** The field's option set as GitHub currently holds it — ids, colors and
 *  descriptions included, none of which the schema cache carries.
 *
 *  `updateProjectV2Field` REPLACES the whole option set, and an option
 *  resubmitted without its id is recreated as a new one, clearing every item
 *  value that referenced it. So a blind resubmit is precisely the destructive
 *  write the id mechanism exists to prevent: an unreadable or empty option set
 *  returns null and the caller refuses the mutation rather than guessing. */
function readLiveOptions(ctx: Ctx, fieldId: string): LiveOption[] | null {
  let raw: unknown;
  try {
    raw = ghGraphQL(
      ctx,
      `query($fieldId: ID!) {
        node(id: $fieldId) {
          ... on ProjectV2SingleSelectField { options { id name color description } }
        }
      }`,
      { fieldId },
    )?.node?.options;
  } catch {
    return null;
  }
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const opts: LiveOption[] = [];
  for (const o of raw as Array<Record<string, unknown>>) {
    // Every field is load-bearing on the way back in: `name` and `color` are
    // NON_NULL on the input type, and an id we cannot read is an option we
    // cannot preserve.
    if (typeof o?.id !== "string" || !o.id) return null;
    if (typeof o?.name !== "string" || !o.name) return null;
    if (typeof o?.color !== "string" || !o.color) return null;
    opts.push({
      id: o.id,
      name: o.name,
      color: o.color,
      description: typeof o.description === "string" ? o.description : "",
    });
  }
  return opts;
}

/** Existing options in their existing order, with each missing state inserted
 *  at the position STATES implies. Nothing is reordered, renamed or removed —
 *  adding is the only edit this file makes to an existing option set (removal
 *  clears the item values of anything still holding the option, and stays a
 *  deliberate act in the UI). */
export function mergeStateOptions(
  existing: readonly LiveOption[],
  missing: readonly string[],
): Array<{ id?: string; name: string; color: string; description: string }> {
  const pending = new Set(missing);
  const out: Array<{ id?: string; name: string; color: string; description: string }> = [];
  const emitNew = (name: string) => {
    pending.delete(name);
    out.push({ name, color: "GRAY", description: "" });
  };
  for (const o of existing) {
    const idx = STATES.indexOf(o.name as (typeof STATES)[number]);
    if (idx >= 0) for (const s of STATES.slice(0, idx)) if (pending.has(s)) emitNew(s);
    out.push({ id: o.id, name: o.name, color: o.color, description: o.description });
  }
  // Anything with no successor among the existing options (and any legacy
  // option set that contains no v2 state at all) lands at the end.
  for (const s of STATES) if (pending.has(s)) emitNew(s);
  return out;
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
  // Pre-existing state options an option-set edit had to resubmit. Their ids
  // must come back unchanged: a dropped id means GitHub recreated the option
  // and cleared every item value holding it — the one-way hazard, so it is
  // verified against the refreshed schema rather than assumed from the ack.
  let preservedOptions: Array<{ name: string; id: string }> = [];
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
    note(`created "${STATE_FIELD}" single-select with the ${STATES.length} v2 states`);
  } else {
    const names = Object.keys(stateField.options ?? {});
    const missing = STATES.filter((s) => !names.includes(s));
    if (missing.length) {
      const live = readLiveOptions(ctx, stateField.id);
      if (!live) {
        note(
          `MANUAL: add option(s) ${missing.join(", ")} to "${STATE_FIELD}" in the board UI — ` +
            `could not read the field's current option set, and resubmitting one without its id ` +
            `would clear every item value that references it` +
            // Named rather than left to be inferred: until the option exists,
            // `create --intake` and `move N intake` fail closed on mutationCache's
            // missing-option refusal, which points back at `board setup` — this
            // is the far end of that pointer, so it has to say what the option
            // buys and not just that it is absent.
            (missing.includes("Intake")
              ? ` — until "Intake" exists, \`board create --intake\` and \`board move N intake\` refuse (fail closed); ` +
                `Intake is the tracked-but-not-yet-approved tier, invisible to \`board next\`/\`frontier\``
              : ""),
        );
      } else {
        ghGraphQL(
          ctx,
          `mutation($fieldId: ID!, $options: [ProjectV2SingleSelectFieldOptionInput!]) {
            updateProjectV2Field(input: { fieldId: $fieldId, singleSelectOptions: $options }) {
              projectV2Field { ... on ProjectV2SingleSelectField { id } }
            }
          }`,
          { fieldId: stateField.id, options: mergeStateOptions(live, missing) },
        );
        preservedOptions = live.map((o) => ({ name: o.name, id: o.id }));
        created.push({ name: STATE_FIELD, options: missing });
        note(`added option(s) ${missing.join(", ")} to "${STATE_FIELD}" (${live.length} existing option(s) preserved by id)`);
      }
    }
    const legacy = names.filter((n) => !isState(n));
    if (legacy.length) {
      note(
        `MANUAL: delete legacy option(s) ${legacy.join(", ")} from "${STATE_FIELD}" in the board UI ` +
          `(removal stays a human act: deleting an option clears the Workflow State of every item ` +
          `still holding it, so it is never done unattended)`,
      );
    }
  }

  for (const textField of [CLAIM_FIELD, DEFER_FIELD]) {
    if (cache.fields[textField]) continue;
    ghGraphQL(
      ctx,
      `mutation($projectId: ID!, $name: String!) {
        createProjectV2Field(input: { projectId: $projectId, name: $name, dataType: TEXT }) {
          projectV2Field { ... on ProjectV2FieldCommon { id } }
        }
      }`,
      { projectId: cache.projectId, name: textField },
    );
    created.push({ name: textField });
    note(`created "${textField}" text field`);
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
  if (preservedOptions.length) {
    const now = fresh.fields[STATE_FIELD]?.options;
    const lost = preservedOptions.filter((o) => now?.[o.name] !== o.id);
    if (lost.length) {
      ok = false;
      note(
        `VERIFY FAILED: "${STATE_FIELD}" option(s) ${lost.map((o) => o.name).join(", ")} lost their ` +
          `original id in the option-set edit — every item value referencing them is cleared; ` +
          `restore them in the board UI`,
      );
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
  brief [--json]              ONE orientation read: next head, queue counts,
                              deliver/tend counts, local session leases
  inbox [--json] [--digest [--mark]]
                              the human's single surface (GH-2180): one walk
                              over the four human queues — Human Needed
                              decisions (with the escalation's own why-line),
                              tend proposals, Intake approvals, and the
                              deliver-blocked rows only a human clears
                              (convergence-stalled, no-pr; self-clearing and
                              wait-state rows are counted as withheld, never
                              silently dropped). Lead-routed escalations
                              inside their window are the LEAD's rows, not
                              the inbox's (GH-2218): counted as "with leads",
                              admitted by promotion or the TTL — one
                              arbitration hop, worker → lead → inbox.
                              Every row names its literal
                              disposition verb — the invariant. --digest adds
                              Tier 2: completions since the last mark (stamp
                              under ~/.ralph/inbox/, machine-local) plus a
                              pushWorthy verdict; --mark closes the window —
                              the mark IS Tier 2's expiry, and "at most one
                              push a day" keys on the local calendar date.
                              A lane/orientation read, NOT a viewer-poll
                              surface: a cockpit view owns its cadence or
                              reuses the item cache
  who [--json]                who is driving what on this machine — the
                              per-(worktree, unit) leases, zero API. A lock
                              whose checkout was deleted reads DEAD, never
                              STALE: nothing can refresh it
  reap-leases [--apply]       remove local lock files whose worktree is gone
              [--json]        (dry run by default). Keyed on the checkout being
                              absent, never on age — a live lease may not be
                              deletable by a clock. Zero API
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
  peer NNN [--candidates a,b] the unit's live PEER ADDRESS (GH-1918), resolved
                              against candidate names on stdin (one per line)
                              or --candidates. The peer namespace is harness-
                              owned: the address is the unit's worktree leaf
                              plus a suffix assigned at session start, so it
                              can be RECOGNISED but never constructed —
                              matched under BOTH branch grammars, so a session
                              resuming a legacy branch is not called dead —
                              enumerate first, then resolve here. Exit 1 (and
                              a named reason) on no match or on two sessions
                              in one worktree; never guesses between them
  tree NNN                    subtree with states
  claim show NNN [--json]     the claim as the board holds it: holders, shared
                              since, age vs TTL, raw text when garbled
  deliver-queue [--json]      deliver lane (GH-1712): In Review items whose
                              linked PRs carry an actionable signal, marker-
                              gated per PR. {next, queue, blocked}; empty next
                              means spawn nothing (idle-exit is the caller's
                              contract). Knobs: RALPH_SETTLE_MIN (5),
                              RALPH_RETRY_MIN (60), RALPH_DELIVER_DRYRUN_MAX (3).
                              A PR whose review loop has stalled or spent its
                              round cap (scripts/review-convergence.sh, GH-1977)
                              is held OUT of the queue as a convergence-stalled
                              blocked row — visible, and out of an unattended
                              lane's reach. Budget: RALPH_DELIVER_CONVERGENCE_MAX
                              (3); cap: RALPH_REVIEW_ROUND_CAP
                              A unit a live session on THIS machine is driving
                              (the GH-1956 worktree lock, taken at board
                              claim) is held out entirely as a local-session-
                              active row (GH-1929): that session may hold
                              unpushed commits, which no remote signal can see.
                              Self-clearing on RALPH_LOCK_TTL_MIN; same-machine
                              only, and never evaluated without a sessions dir
  pr-orphans [--json]         open PRs in this repo with no closing issue
                              reference (GH-2048) — the one class of work no
                              board surface can see, since a PR is not an issue
                              and carries no board item. Reads GitHub's own
                              derived linkage, never the PR body. Bot authors
                              are skipped via RALPH_PR_ORPHAN_IGNORE_AUTHORS
                              (dependabot,renovate,github-actions; a trailing
                              [bot] is stripped on both sides, since GraphQL
                              spells these logins without it. Set it EMPTY to
                              surface everyone). A selector:
                              it files nothing and blocks nothing. Doctor
                              carries the same count as an advisory i line
  tend-queue [--json]         tend lane (GH-1712): Backlog hygiene + Done audit
                              — pending closure proposals, stale bodies,
                              cleared/truncated deps, unjudged high-overlap
                              dep candidates (deps-unwired, GH-2136 — the
                              candidate list rides the row), unformed intake,
                              unaudited closes. Classification only;
                              judgment (and every closure, as a marker-comment
                              proposal) belongs to /ralph:tend. Knobs:
                              RALPH_STALE_DAYS (30), RALPH_AUDIT_DAYS (14),
                              RALPH_DEP_OVERLAP_MIN (0.2)
  escalations [--json]        the arbitration queue (GH-2179): every Human
                              Needed item, classified by who its escalation is
                              addressed to. A lead's work is the pending rows;
                              →human, promoted, and auto-promoted rows are the
                              human tier. Auto-promotion is computed HERE, at
                              read time — a lead-routed escalation older than
                              RALPH_LOCK_TTL_MIN (120) with no promotion
                              marker renders auto-promoted; no cron exists.
                              Bounded: trails are fetched for Human Needed
                              items only
  dep-candidates <n> [--json] which OPEN, UNCLAIMED Backlog items might #n
                              depend on (or vice versa) — df-weighted term
                              overlap on title + body, handed to a judge.
                              Recall-biased ON PURPOSE (the opposite of
                              dep-refs.sh's silence bias: a missed dependency
                              costs a wrong parallel spawn; a false candidate
                              costs one judgment call). NEVER writes an edge;
                              candidates are not dependencies. Already-wired,
                              parent/child, and self excluded. Cap:
                              RALPH_DEP_CANDIDATES_MAX (10). An unreadable
                              read prints NOT CHECKED, never an empty list
  card-signals [--json]       the VIEWER's read (GH-2062, ralph-herdr cockpit):
                              In Review items with their linked PRs
                              {number, state, merged, mergeable, checks} — the
                              same closing-references ∪ branch-convention union
                              deliver uses — plus epic rollups
                              {number, title, done, total, truncated} for the
                              distinct own-repo parents of open items. Two
                              GraphQL documents on top of the open walk, no
                              subprocess. Deliberately NOT deliver-queue: that
                              selector shells the merge gate per PR (rule 7 —
                              gates are RUN, not predicted, and never on a
                              viewer's timer) and drops the PR number on
                              exactly its merged and closed rows
  closed [--json]             own-repo board items closed as COMPLETED inside
                              RALPH_AUDIT_DAYS (14), newest first — the Done
                              view. \`list\` cannot answer it (open-issues-only
                              by construction, GH-1814). NOT_PLANNED is
                              excluded, reconcile's own rule. A WINDOW, never
                              all history: every consumer must say so

mutations
  create --title T [--body B] [--parent NNN] [--estimate XS..XL] [--state S]
                              [--priority P0..P3] [--label L[,L2]] [--apply]
                              [--allow-duplicate]
                              Retry-safe: an OPEN issue with a byte-identical
                              title, filed by you inside
                              RALPH_CREATE_DEDUPE_SEC (300, 0 disables), is
                              ADOPTED rather than duplicated — and a lost
                              mutation response is read back rather than
                              reported as a failure the caller can only fix by
                              retrying. --allow-duplicate files anyway.
                              --apply files an APPLY unit under the configured
                              label: it closes only on deployed-and-verified
                              evidence, never on a merge.
                              --priority is validated against the board's live
                              Priority options; omitting it ranks the item LAST
                              in \`next\` (null sorts after P3)
  priority NNN[,NNN...] <option>
                              set Priority on existing item(s) (--clear removes
                              it). Options come from the live field, not a
                              hardcoded P0..P3 — a host repo owns its scheme,
                              and \`next\` orders a custom one by the field's
                              option ORDER (a trailing digit is the fallback).
                              A comma list (GH-2130) resolves every target up
                              front via the open walk and refuses BEFORE any
                              write if one is unresolvable, closed, archived or
                              off-board — never a silent skip or a partial
                              apply. Bounded like prune: --limit (200, an
                              over-long list REFUSES rather than truncates),
                              5-consecutive-failure breaker; --json reports the
                              run performed. No comments posted, same as the
                              single form.
  estimate NNN[,NNN...] <option>
                              set Estimate on existing item(s) (--clear removes
                              it). Same live-option rule as priority — never a
                              hardcoded XS..XL — and the same list arity.
                              Approval (Intake → Backlog) gates on Priority AND
                              Estimate, so this is how an intake filing becomes
                              approvable from the CLI
  claim NNN [--steal] [--why W]  Backlog/Human Needed/In Review → In Progress; sets
                              Claim. Claiming from In Review is a DEMOTION and
                              requires --why "<the rework>" (GH-2078).
                              Binds this session to the unit (GH-1948): a second
                              DISTINCT unit from one session is refused (contract
                              rule 9). Re-claiming the same unit always passes;
                              a fresh session is the only remedy — there is no
                              --force. Inert where no session id is published.
                              Size ceiling (GH-2134): a fresh claim refuses at/
                              above RALPH_CLAIM_MAX_ESTIMATE (default XL) and
                              warns one notch under it — the remedy is
                              \`board estimate NNN <size>\`, on the record; set
                              the var empty to disable. No Estimate = not judged
  claim leave NNN --holder H  remove a holder from an existing shared claim;
                              non-member leave is a no-op; the LAST one out
                              clears the field. Never transitions state — board
                              moves stay the skills' job. (\`claim join\` was
                              removed in GH-1869: nothing creates multi-holder
                              claims; existing ones are still read and cleaned)
  release NNN -m "why"        In Progress → Backlog; parking comment required
  move NNN <state> [--why W]  any legal transition; Human Needed requires --why,
                              and so do the two demotions (In Progress →
                              Backlog, In Review → In Progress) — backward
                              moves are exceptional and the reason is posted
                              as a comment (GH-2078).
                              Done evidence: merged linked PR, a decision
                              artifact (--decision), an epic root whose
                              children are ALL closed (GH-2198 — derived,
                              nothing to type), or --why.
                              Intake → Backlog is APPROVAL: it refuses without
                              a Priority and an Estimate.
                              Escalation addressing (GH-2179, Human Needed
                              only): the route rides the Decision needed
                              comment as a marker. Default = the lead when
                              RALPH_HERDR_LEAD is set (the team spawn path
                              sets it), else the human; --to-lead <name> is
                              explicit, --to-human forces the reserved-set
                              direction (spend, scope, irreversibles are
                              never a lead's to grant)
  answer NNN -m "decision"    answer a Human Needed item, COMMENT-FIRST: the
                              answer lands as an issue comment (**Answer** —
                              the durable half, timestamped by a
                              ralph-answer:v1 marker) and the item STAYS
                              Human Needed — the resume edge belongs to the
                              RESUMING agent (GH-2204), whose \`board claim
                              NNN\` takes Human Needed → In Progress so the
                              session binding, worktree lock and size guard
                              land on the actual driver. --resume takes the
                              edge in this invocation (self-answer: the
                              driver answering its own item). --message is
                              an alias for -m; --comment-only names the
                              default and is inert; --any-state answers an
                              item outside Human Needed (comment only).
                              [--json] reports {commented, transitioned,
                              state, resumePending}. Answered-but-unresumed
                              items surface in \`board escalations\` and
                              doctor's answer-unresumed line. The herdr
                              prompt half (nudging the paused agent to
                              resume) is deliberately NOT here — the
                              ralph-herdr plugin owns it. Escalation payload
                              shape is checked by \`board contract validate
                              ralph.escalation\`, never by this verb
  promote NNN [-m "note"]     lead arbitration (GH-2179): promote a lead-routed
                              escalation into the inbox — a durable marker
                              comment, NO state change (Human Needed is
                              already the right state; promotion changes the
                              audience, not the machine). Promotion is the
                              inbox admission (GH-2218): until it — or the
                              TTL — the row is the lead's, and Tier 1
                              withholds it. Refuses outside
                              Human Needed and on human-addressed escalations;
                              noop when already promoted. The other two
                              dispositions are \`answer\` (whose comment the
                              resuming session's claim then disposes).
                              Deliberately validates NO C9 shape: the TTL
                              path cannot validate by construction, and a
                              stricter manual path would train leads to wait
                              out the clock instead
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
  link PARENT CHILD           add sub-issue edge; refuses an already-parented
                              child, naming the current parent and both remedies
       PARENT CHILD --rm      remove the edge (refuses unless PARENT is the
                              current parent — a silent no-op would hide a
                              wrong mental model)
       NEWPARENT CHILD --replace
                              re-parent atomically (one mutation, never
                              remove+add — the child is never transiently a
                              root the ranker could misread)
  dep NNN --on MMM [--rm]     NNN is blocked by MMM (--rm removes);
                              --dismiss [-m why] records "judged, NO edge"
                              instead — the durable answer to a deps-unwired
                              candidate (GH-2136)
  comment NNN -m "body"

maintenance
  adopt NNN                   ensure issue is on the board (new items → Backlog).
                              Refuses a foreign-repo issue: multi-repo is
                              opt-in via RALPH_ALLOW_FOREIGN_REPO_ITEMS=true
                              (unset = deny). Items already on the board are
                              grandfathered — doctor lists them, nothing
                              removes them.
  reconcile NNN               sync board state to issue reality (closed→Done/Canceled,
                              reopened→Backlog); the state-guard event lane
  parent-check NNN            advance parent if all children closed
  doctor [--fix] [--strict]   invariant sweep; --fix clears/releases bad claims.
                              "i" lines are advisory state smells read from the
                              machine's own comment trail — never gates, never
                              fixed; thresholds via RALPH_SMELL_CLAIM_EXPIRIES
                              (2), RALPH_SMELL_ESCALATIONS (3),
                              RALPH_SMELL_REVIEW_DAYS (7),
                              RALPH_SMELL_INTAKE_DAYS (14 — "intake-stale":
                              items awaiting an approval decision).
                              "foreign-repo-policy" reports the posture in
                              effect and whether it was configured or
                              defaulted; "foreign-items" warns when items from
                              other repos are on a board that denies them —
                              never escalated by --strict, never removed by
                              --fix (that call stays with the operator)
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
  sweep-non-issues [--apply] [--json] [--limit N]
                              list the PULL REQUEST and DRAFT items on the
                              project (GH-2050). board.ts cannot read one —
                              the item walk's content union is issues-only —
                              so they are paged for and metered on every full
                              scan and then dropped. DRY RUN unless --apply;
                              removes the board item only, never the PR.
                              Separate from prune on purpose: prune's
                              predicate is a fail-closed argument about issues
                              other readers still need, and a non-issue item
                              has no such reader. Prints the newest non-issue
                              item's timestamp and creator — the only
                              observable of whether the "Auto-add to project"
                              workflow is still depositing them, since the API
                              cannot read that workflow's filter. Same bounds
                              as prune: --limit (200), 5 consecutive failures.
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
  protocol is read-back verification, not read freshness.

change oracle (GH-1804)
  Past that 90 s, a REST conditional request (a 304 costs zero rate limit,
  on a budget independent of the GraphQL one the walk spends) may extend a
  cached walk up to T_max — RALPH_ITEM_ORACLE_MAX_SEC, default 600, 0
  disables, max 3600. Anything that is not a clean 304 pays for the walk.

  It sees comments, body edits, labels and open/close. It does NOT see
  Workflow State, Claim, or dependency edges — so a transition-busy board
  returns 304 the whole way and T_max, not the oracle, is what bounds
  staleness. doctor never uses it: it mutates from what it read.
v0.2.0 additions
  defer NNN --until "<condition>" [--recheck ISO] | --clear
                              park a Backlog item out of ranking until its
                              stated precondition holds; claiming lifts it.
                              On Intake it is a timed snooze (--recheck
                              REQUIRED): withheld from tend unformed and
                              doctor intake-stale until then, resurfaces
                              with full age; ordinary approval clears it
  move NNN done --decision <artifact>
                              typed close for a unit with no PR: records
                              ralph-decision-evidence:v1 naming the artifact
  bootstrap --owner O --repo R --project N [--host H]
                              first-run bring-up: writes .ralph.json, links
                              the repo, runs setup, prints next steps
  add <issue-url>             add an issue by URL (cross-repo path, gated on
                              RALPH_ALLOW_FOREIGN_REPO_ITEMS)
  help <verb>                 per-verb usage with an example
  dep NNN --blocked-by M      alias for --on (the CLI's own vocabulary)

  Same-state moves are safe retries: a noop, or completing a half-applied
  terminal close on the same evidence a fresh move demands.
`;

/** Per-verb usage (audit A5): `board help <verb>` — one usage line, one
 *  example, the flags that matter. The monolith HELP above stays the index. */
export const VERB_HELP: Record<string, string> = {
  next: "board next [--json] [--fresh]\n  The ranked work queue's head. Empty is typed (--json: diagnosis).\n  example: board next",
  frontier: "board frontier [--json]\n  next's eligible queue re-projected with per-item explanations (fleet feed).\n  example: board frontier --json",
  brief: "board brief [--json]\n  One orientation read: next head, queue counts, deliver/tend counts, local leases.\n  example: board brief",
  inbox:
    "board inbox [--json] [--digest [--mark]]\n  The human's single surface: Human Needed decisions, tend proposals, Intake approvals,\n  and human-clearable deliver-blocked rows, each with its literal disposition verb.\n  Lead-routed escalations inside their window are withheld as \"with leads\" (GH-2218) —\n  promotion or the TTL admits them; `board escalations` lists them.\n  --digest adds completions since the last mark + a pushWorthy verdict; --mark stamps the window.\n  example: board inbox --digest",
  who: "board who [--json]\n  Local per-(worktree, unit) leases — who is driving what on this machine. Zero API.\n  A lease whose worktree was deleted prints DEAD, not STALE: nothing can refresh it, so it is\n  not aging toward anything. `board reap-leases` clears those.\n  example: board who",
  "reap-leases": "board reap-leases [--apply] [--json]\n  Remove local lock files whose worktree no longer exists. Dry run unless --apply. Zero API.\n  The predicate is the missing CHECKOUT, never the lock's age: a lease is what deliver-queue\n  reads for local-session-active, so a clock may not be allowed to delete a live one. Any read\n  failure that is not ENOENT leaves the lock alone.\n  example: board reap-leases --apply",
  list: "board list [--state <s>] [--json]\n  Items by state. Full-board scan — prefer next/brief for orientation.\n  example: board list --state human",
  get: "board get <n> [--json]\n  One issue with board fields, parity with what move/claim write.\n  example: board get 1234",
  create: "board create (--intake | --backlog | --state <s>) --title <t> [--body <b>] [--parent <n>] [--estimate XS..XL] [--priority P0..P3] [--apply]\n  Files an issue onto the board. Retry-safe (twin dedupe, GH-1973).\n  The landing state is REQUIRED — there is no default, because filing is not approving:\n    --intake   tracked, not yet approved; invisible to next/frontier (Priority/Estimate optional)\n    --backlog  approved and ready to work (Priority and Estimate REQUIRED)\n  example: board create --backlog --title \"fix the gate\" --priority P1 --estimate S",
  claim: "board claim <n> [--steal] [--why <w>] | board claim show <n>\n  Take a unit (Backlog→In Progress). --steal only after TTL expiry.\n  Claiming from In Review demotes and requires --why \"<the rework>\".\n  example: board claim 1234",
  release: "board release <n> -m \"<where you stopped>\"\n  Give a unit back (→Backlog) with the handoff note.\n  example: board release 1234 -m \"tests red on X; next: fix parser\"",
  move: "board move <n> <state> [--why <w>] [--decision <artifact>] [--to-lead <name> | --to-human]\n  Gated transition. Done needs evidence: merged linked PR, decision artifact,\n  an epic root with ALL children closed (GH-2198), or --why.\n  Demotions (In Progress→Backlog, In Review→In Progress) require --why (GH-2078).\n  Same-state moves are safe retries (noop / completes a half-applied close).\n  Human Needed only: --to-lead/--to-human address the escalation (GH-2179);\n  default is the lead when RALPH_HERDR_LEAD is set, else the human.\n  example: board move 1234 done --decision thoughts/shared/research/x.md",
  answer: "board answer <n> -m \"<the decision>\" [--resume] [--any-state]\n  Answer a Human Needed item; it stays Human Needed until the driving\n  session resumes it (board claim <n>). --resume answers AND resumes in one\n  invocation — for the driver answering its own item.\n  example: board answer 1234 -m \"ship option B\"",
  promote: "board promote <n> [-m \"<note>\"] [--json]\n  Promote a lead-routed escalation into the inbox (GH-2179/GH-2218): durable\n  marker comment, no state change — the admission that puts the row in\n  Tier 1 of `board inbox`. Refuses outside Human Needed and on\n  human-addressed escalations; noop when already promoted.\n  example: board promote 1234 -m \"authorization, not knowledge — yours\"",
  escalations: "board escalations [--json]\n  The arbitration queue (GH-2179): Human Needed items classified by audience.\n  pending = the lead's work; →human / promoted / auto-promoted (TTL\n  RALPH_LOCK_TTL_MIN elapsed, computed at read time) = the human tier.\n  example: board escalations --json",
  cancel: "board cancel <n> -m \"<reason>\"\n  Cancel (→Canceled, closes NOT_PLANNED). Reopen is the only exit.\n  example: board cancel 1234 -m \"superseded by #1300\"",
  reopen: "board reopen <n>\n  The one exit from Done/Canceled (→Backlog); accepts a pending reopen proposal.\n  example: board reopen 1234",
  defer: "board defer <n> --until \"<condition>\" [--recheck <ISO>] | board defer <n> --clear\n  Park a Backlog item out of ranking until its stated precondition holds.\n  Claiming the unit also lifts it. doctor surfaces elapsed rechecks.\n  On an Intake item this is a timed snooze and --recheck is REQUIRED:\n  withheld from tend-queue unformed and doctor intake-stale until the\n  recheck, then resurfaces with its full age. Approval clears it.\n  example: board defer 1234 --until \"GH-2088 lands\" --recheck 2026-09-01T00:00:00Z",
  dep: "board dep <blocked> --on <blocking> [--rm|--dismiss [-m why]]   (--blocked-by = --on)\n  Dependency edge; blocked items never rank. --dismiss records the judgment that the pair is NOT dependent (clears it from tend's deps-unwired).\n  example: board dep 1234 --blocked-by 1200",
  link: "board link <parent> <child> [--rm|--replace]\n  Sub-issue edge (the tree parent-check rolls up). Bare form refuses an already-parented child, naming the current parent and both remedies. --rm removes the edge (the named parent must be the current one). --replace re-parents in ONE atomic mutation — never remove+add, so the child is never transiently a root.\n  example: board link 1200 1234\n  move example: board link 1300 1234 --replace   (#1234 moves under #1300)",
  priority: "board priority <n> <P0..P3|--clear>\n  Set/clear Priority. Null priority sinks below stale backlog in next.\n  example: board priority 1234 P1",
  comment: "board comment <n> -m \"<body>\"\n  Plain comment through the sanctioned path.\n  example: board comment 1234 -m \"blocked on infra\"",
  resolve: "board resolve <n> --accept | --reject -m \"<why not>\"\n  Dispose of a tend closure proposal. --accept prints the gated follow-up.\n  example: board resolve 1234 --reject -m \"still needed for the demo\"",
  adopt: "board adopt <n>\n  Put an off-board issue onto the board (Backlog).\n  example: board adopt 1234",
  add: "board add <issue-url>\n  Add an issue by URL — the sanctioned cross-repo path, gated on RALPH_ALLOW_FOREIGN_REPO_ITEMS.\n  example: board add https://github.com/o/r/issues/9",
  reconcile: "board reconcile <n>\n  Reality sync: GitHub open/closed wins over the board.\n  example: board reconcile 1234",
  "parent-check": "board parent-check <n>\n  Roll a parent forward when every child is closed.\n  example: board parent-check 1200",
  "deliver-queue": "board deliver-queue [--json]\n  Quiescent In Review items with actionable PR signal (the deliver lane's selector).\n  example: board deliver-queue --json",
  "tend-queue": "board tend-queue [--json]\n  Backlog-hygiene and Done-audit rows (the tend lane's selector).\n  example: board tend-queue",
  "dep-candidates":
    "board dep-candidates <n> [--json]\n  Unclaimed Backlog items that might depend on #n (or vice versa), by term overlap — recall-biased, never writes an edge.\n  example: board dep-candidates 2135",
  doctor: "board doctor [--fix] [--strict] [--fresh]\n  Invariant sweep + advisory lines. --fix corrects drift; info lines are never escalated.\n  example: board doctor --fix",
  readiness: "board readiness [--json]\n  Advisory agent-readiness report (3 levels) — recommendations, never gates.\n  example: board readiness",
  setup: "board setup\n  Idempotent field provisioning; prints exactly which steps are manual.\n  example: board setup",
  bootstrap: "board bootstrap --owner <o> --repo <r> --project <n> [--host <ghe>]\n  First-run bring-up: writes .ralph.json, links the repo, runs setup, prints next steps.\n  example: board bootstrap --owner me --repo my-app --project 7",
  prune: "board prune [--apply] [--limit N]\n  Remove long-closed terminal items from the PROJECT (issues untouched). Dry run until --apply.\n  example: board prune",
  name: "board name <n> [--json]\n  THE branch/agent name grammar for a unit (never rebuild slugify in shell).\n  example: board name 1234",
  peer: "board peer <n>\n  Resolve the unit's live messaging address from the enumerated sessions.\n  example: board peer 1234",
};

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

/** Flags that take NO value (GH-1826). Deny-by-omission on this list is what
 *  made `board resolve NNN --reject -m "why"` — the form `board help` prints —
 *  parse as `reject: "-m"` and then refuse for want of the `-m` it was handed.
 *  A flag reaching `run()` and absent here is a bug, and `board.test.ts` fails
 *  on it rather than leaving the next one to be found at a call site. */
export const BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  "json", "steal", "rm", "fix", "strict", "apply", "live", "comment-only",
  "any-state", "resume", "all-repos", "fresh", "clear", "allow-duplicate", "accept", "reject",
  "intake", "backlog", "dismiss", "to-human", "digest", "mark", "replace",
]);

/** Flags that take a value. Declared beside the booleans so arity is a property
 *  of the flag rather than of the token that happens to follow it. */
export const VALUE_FLAGS: ReadonlySet<string> = new Set([
  "blocked-by", "body", "candidates", "decision", "estimate", "holder", "host",
  "label", "lane", "limit", "message", "on", "out", "owner", "parent", "priority",
  "project", "recheck", "repo", "state", "title", "to-lead", "until", "why",
]);

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
      // A token that is itself a flag (`-m`, `--json`) is never a value: an
      // undeclared flag must not swallow the next one the way `--reject` did.
      const nextIsFlag = next !== undefined && /^-[^0-9]/.test(next);
      if (next !== undefined && !nextIsFlag && !BOOLEAN_FLAGS.has(key)) {
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
  const defer =
    i.defer ?
      i.state === "Intake" && i.defer.recheck ?
        ` snoozed(until ${i.defer.recheck.toISOString().slice(0, 10)}, ${i.defer.condition})`
      : ` deferred(${i.defer.condition}${i.defer.recheck ? `, recheck ${i.defer.recheck.toISOString().slice(0, 10)}` : ""})`
    : "";
  return `#${i.number} [${i.state ?? "no-state"}]${claim}${defer}${parent}${blocked} ${i.title}`;
}

/** Exactly one line, whatever the tier. With no diagnosis it is byte-identical
 *  to what an empty queue has always printed. */
function emptyQueueLine(blocked: QueueItemWithBlockers[], dx: EmptyQueueReport): string {
  if (dx.diagnosis === "no-items")
    return `queue empty — nothing approved; file work with \`board create --backlog\` (ready to work) or \`board create --intake\` (tracked, awaiting approval), or via /ralph:board. \`board list --state intake\` shows what is waiting on a decision`;
  if (dx.diagnosis === "human-needed")
    return `queue empty — ${dx.humanNeededCount} in Human Needed awaiting answers (/ralph:board walks the queue)`;
  if (dx.diagnosis === "epic-in-flight") {
    const e = dx.inFlightEpics[0];
    const who = e.holder ? ` claimed by ${e.holder}` : " in flight";
    return `queue empty — epic #${e.root} is being worked (child #${e.child}${who})`;
  }
  if (dx.diagnosis === "all-deferred")
    return `queue empty — ${dx.deferredCount} deferred awaiting their stated preconditions (board list shows them; board defer N --clear lifts one)`;
  if (!blocked.length) return dx.deferredCount ? `queue empty (${dx.deferredCount} deferred)` : "queue empty";
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
  "estimate", "defer", "link", "dep", "comment", "adopt", "reconcile", "parent-check",
  "resolve", "setup", "add", "bootstrap", "promote",
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
    (cmd === "prune" && flags.apply === true) ||
    (cmd === "sweep-non-issues" && flags.apply === true);

  // The write-guard carve-out (GH-1806) and its manual override, both applied
  // before any command body runs. A mutating command reads the board only to
  // decide what to write, so it pays for truth; a read may be bounded-stale.
  if (writes || flags.fresh) ctx = { ...ctx, itemCacheTtlSec: 0, itemOracleMaxSec: 0 };

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

  // Lane budget pre-flight (audit B2): the ranking/selector lanes are the
  // repo's recurring GraphQL spenders, and a pass that starts under an
  // exhausted budget half-completes and loses its markers. Checked BEFORE any
  // read; REST /rate_limit is free and its budget is measurably independent
  // of the GraphQL one (GH-1804's measurement). Fails OPEN on an unreadable
  // budget — a transient outage must never read as starvation (GH-1817).
  if (["next", "frontier", "deliver-queue", "tend-queue", "dep-candidates", "brief", "inbox"].includes(cmd)) {
    const floor = Number(process.env.RALPH_GH_BUDGET_FLOOR ?? 500);
    if (Number.isFinite(floor) && floor > 0) {
      const r = ctx.exec(["gh", "api", "--hostname", ctx.cfg.host, "rate_limit"]);
      if (r.code === 0) {
        try {
          const g = JSON.parse(r.stdout)?.resources?.graphql;
          if (g && typeof g.remaining === "number" && g.remaining < floor) {
            process.stderr.write(
              `BUDGET-DEFER graphql remaining=${g.remaining} < floor=${floor} (RALPH_GH_BUDGET_FLOOR) reset=${g.reset}\n`,
            );
            return 75;
          }
        } catch {
          /* unreadable budget: proceed — see fail-open note above */
        }
      }
    }
  }

  switch (cmd) {
    case undefined:
    case "help":
    case "--help":
    case "-h": {
      const topic = positional[0];
      if (topic) {
        const entry = VERB_HELP[topic];
        if (entry) out(entry);
        else {
          out(`no such verb "${topic}" — verbs with per-verb help: ${Object.keys(VERB_HELP).sort().join(", ")}`);
          return 64;
        }
        return 0;
      }
      out(HELP);
      return 0;
    }

    case "brief": {
      // One orientation read (audit A2): what sessions spent 5-15 discovery
      // calls re-assembling. Reads only; the three lanes share this
      // invocation's item-cache walk, so the marginal cost is the deliver and
      // tend detail, not three scans. Probes are OFF (no merge-pr dry-runs) —
      // a brief is a glance, not a gate run.
      const full = listOwnOpenWalk(ctx, QUEUE_SELECT_NO_LABELS);
      const own = full.open;
      const closedEdges = closedTreeEdges(ctx, own);
      const order = priorityOptionOrder(ctx, { values: own.map((i) => i.priority), fresh: flags.fresh === true });
      const { eligible, blocked, inFlightEpics, deferred } = rankNext(own, closedEdges, order);
      const dx = diagnoseEmptyQueue(own, eligible, blocked, inFlightEpics, deferred);
      const dq = deliverQueue(ctx, parseDeliverOpts(), null, null);
      const tq = tendQueue(ctx);
      const who = readLocalLeases(ctx);
      const brief = {
        next: eligible.slice(0, 3).map((i) => ({ number: i.number, title: i.title, priority: i.priority })),
        counts: {
          eligible: eligible.length,
          blocked: blocked.length,
          deferred: dx.deferredCount,
          humanNeeded: dx.humanNeededCount,
          deliver: dq.queue.length,
          deliverBlocked: dq.blocked.length,
          tend: tq.queue.length,
        },
        // null = the lease dir could not be read — distinct from [] (nobody).
        leases: who,
        cache: cacheFacts(full),
      };
      if (flags.json) {
        json(brief);
        return 0;
      }
      out(
        eligible.length === 0
          ? `next: ${emptyQueueLine(blocked, dx)}`
          : `next: ${eligible.slice(0, 3).map((i) => `#${i.number}${i.priority ? ` ${i.priority}` : ""} ${i.title}`).join("; ")}`,
      );
      out(
        `queues: ${eligible.length} eligible, ${blocked.length} blocked, ${dx.deferredCount} deferred, ` +
          `${dx.humanNeededCount} human-needed | deliver ${dq.queue.length} (+${dq.blocked.length} blocked) | tend ${tq.queue.length}`,
      );
      // GH-2108: brief is the REPO-SCOPED orientation read, so it prints the
      // leases on this repo's own checkouts and states, in one line, what it
      // left out. Withholding silently would recreate the defect one layer
      // down — an operator could not tell "nothing held here" from "the reader
      // dropped it" — so the counts and the machine-wide surface that still
      // lists everything are both named. --json is unfiltered by design: the
      // three new fields let a machine reader apply whichever cut it wants.
      if (who === null) out(`leases: not evaluated (no session dir)`);
      else {
        const { shown, dead, foreign } = partitionBriefLeases(who);
        if (shown.length === 0) out(`leases: none for this repo — no local session is driving a unit here`);
        else for (const l of shown) out(`  lease: #${l.issue} ${l.ours ? "(this session)" : l.session} in ${l.worktree}${l.stale ? " STALE" : ` until ${l.expiresAt}`}`);
        const withheld: string[] = [];
        if (foreign) withheld.push(`${foreign} on another repo's checkout`);
        if (dead) withheld.push(`${dead} dead (worktree deleted — \`board reap-leases\` clears them)`);
        if (withheld.length) out(`  leases withheld: ${withheld.join(", ")} — \`board who\` lists every lease on this machine`);
      }
      if (cacheNote(full)) out(`  ${cacheNote(full)}`);
      return 0;
    }

    case "inbox": {
      // The human's single surface (GH-2180): one walk over the four human
      // queues. A lane/orientation read on the shared item cache — NOT a
      // viewer-poll surface; a cockpit view owns its own cadence (GH-2062's
      // lesson) or reuses the cache. Probes are OFF like brief's: an inbox is
      // a glance, not a gate run.
      if (flags.mark && !flags.digest)
        throw new UsageError(`inbox --mark requires --digest — the mark closes a digest window it must first compute`);
      const full = listOwnOpenWalk(ctx, QUEUE_SELECT_NO_LABELS);
      const own = full.open;
      const tq = tendQueue(ctx);
      const dq = deliverQueue(ctx, parseDeliverOpts(), null, null);
      // Decision text: comments-only batch over the Human Needed items alone
      // (bounded — escalations are few by construction). A trail that came
      // back empty degrades the row's detail to null, never drops the row;
      // a THROWN read propagates as the typed transport failure it is —
      // an inbox rendering every decision with no text would look healthy
      // while hiding that nothing was read.
      const hn = own.filter((i) => i.state === "Human Needed").map((i) => i.number);
      const whys = new Map<number, string | null>();
      const routes = new Map<number, EscalationRoute>();
      if (hn.length > 0) {
        // Same trails answer both questions — the why-line AND the audience
        // (GH-2218): a lead-routed pending escalation is the lead's row, so
        // Tier 1 withholds it until a promotion (the lead's or the TTL's,
        // classified at read time) admits it. Zero extra reads.
        const trails = fetchCommentTrails(ctx, hn);
        for (const n of hn) {
          whys.set(n, latestEscalationWhy(trails.get(n) ?? []));
          routes.set(n, classifyEscalation(trails.get(n) ?? [], ctx.now(), ctx.cfg.lockTtlMin));
        }
      }
      const tier1 = classifyInbox(own, tq, dq, whys, routes);
      let digest: InboxDigestFacts | null = null;
      let marked: string | null = null;
      if (flags.digest) {
        const stampPath = inboxStampPath(ctx.cfg);
        let stampAt: string | null = null;
        try {
          const parsed = JSON.parse(readFileSync(stampPath, "utf8"));
          if (typeof parsed?.at === "string") stampAt = parsed.at;
        } catch {
          // Absent or unreadable stamp → the 24h fallback window inside
          // digestFacts — the over-notify direction, correct for a digest.
        }
        // recentDone re-reads the closed window tendQueue already fetched in
        // this invocation — a bounded double read, accepted (brief's
        // pay-full-price precedent) over threading tend's internals out here.
        digest = digestFacts(stampAt, ctx.now(), recentDone(ctx), tier1);
        if (flags.mark) {
          // Always stamp, pushWorthy or not: an empty-inbox rota run still
          // closes the day's window. pushWorthy was computed above, BEFORE
          // this write, so the stamp can never talk itself out of a push.
          marked = ctx.now().toISOString();
          mkdirSync(join(stampPath, ".."), { recursive: true });
          atomicWrite(stampPath, JSON.stringify({ at: marked }) + "\n");
        }
      }
      if (flags.json) {
        json({ tier1, digest, marked, cache: cacheFacts(full) });
        return 0;
      }
      const ago = (at: string | null): string => {
        if (!at) return "";
        const ms = ctx.now().getTime() - new Date(at).getTime();
        if (!Number.isFinite(ms) || ms < 0) return "";
        const d = Math.floor(ms / 86_400_000);
        if (d > 0) return ` [${d}d]`;
        const h = Math.floor(ms / 3_600_000);
        return h > 0 ? ` [${h}h]` : ` [<1h]`;
      };
      out(
        tier1.count === 0
          ? `inbox: empty — no decisions waiting`
          : `inbox: ${tier1.count} waiting — ${tier1.decisions.length} decisions, ${tier1.proposals.length} proposals, ` +
              `${tier1.approvals.length} approvals, ${tier1.deliverBlocked.length} deliver-blocked`,
      );
      const section = (name: string, rows: InboxRow[]) => {
        if (rows.length === 0) return;
        out(`${name}:`);
        for (const r of rows) {
          const pri = r.priority ? ` ${r.priority}` : "";
          const pr = r.pr ? ` PR #${r.pr}` : "";
          const reason = r.reason ? ` (${r.reason})` : "";
          out(`  #${r.number}${pri}${ago(r.at)}${pr}${reason} ${r.title}`);
          if (r.queue === "decision")
            out(`      ${r.detail ?? "(decision text unavailable — see the issue's Decision needed comment)"}`);
          else if (r.detail) out(`      ${r.detail}`);
          out(`      → ${r.verb}`);
        }
      };
      section("decisions", tier1.decisions);
      section("proposals", tier1.proposals);
      section("approvals", tier1.approvals);
      section("deliver-blocked", tier1.deliverBlocked);
      if (tier1.withheld.length > 0)
        out(
          `withheld: ${tier1.withheld.map((w) => `${w.count} ${w.reason}`).join(", ")} — ` +
            `self-clearing or waiting, no human verb disposes them (\`board deliver-queue\` lists them)`,
        );
      if (tier1.leadPending.length > 0)
        out(
          `with leads: ${tier1.leadPending.map((l) => `#${l.number} (${l.lead ?? "unnamed lead"})`).join(", ")} — ` +
            `lead-routed escalations inside their window; promotion or the TTL admits them (\`board escalations\` lists them)`,
        );
      if (digest) {
        out(
          `digest since ${digest.since}: ${digest.completions.length} completions` +
            (digest.stamp ? "" : " (no stamp — 24h window)"),
        );
        for (const c of digest.completions) out(`  #${c.number} ${c.closedAt ?? ""} ${c.title}`);
        out(
          `push: ${digest.pushWorthy ? "worthy" : "not worthy"} (${digest.markedToday ? "already marked today" : "unmarked today"}` +
            `${digest.pushWorthy || digest.markedToday ? "" : ", nothing new"})` + (marked ? `; marked ${marked}` : ""),
        );
      }
      if (cacheNote(full)) out(`  ${cacheNote(full)}`);
      return 0;
    }

    case "who": {
      // Machine-local, zero API: the per-(worktree, unit) leases `board claim`
      // already publishes (GH-1929/1956), printed instead of grepped for.
      const rows = readLocalLeases(ctx);
      if (flags.json) {
        json({ leases: rows });
        return 0;
      }
      if (rows === null) out("leases: not evaluated — sessions dir unreadable (distinct from nobody working)");
      else if (rows.length === 0) out("no local session leases — nobody on this machine is driving a unit");
      else {
        // Machine-wide is this verb's whole question, so nothing is withheld
        // here — but DEAD is checked before STALE (GH-2108). A deleted
        // checkout is not aging toward anything, and a lock swept minutes ago
        // is dead while still inside its TTL, so the age test would call it
        // live.
        for (const l of rows) {
          const status =
            l.worktreeState === "missing"
              ? " DEAD (worktree deleted — nothing can refresh this lock)"
              : l.stale
                ? " STALE (past TTL)"
                : ` — lease until ${l.expiresAt}`;
          out(`#${l.issue} ${l.ours ? "(this session)" : l.session} in ${l.worktree} since ${l.since}${status}`);
        }
        const dead = rows.filter((l) => l.worktreeState === "missing").length;
        if (dead) out(`${dead} dead lease(s) — \`board reap-leases --apply\` removes locks whose checkout is gone`);
      }
      return 0;
    }

    case "reap-leases": {
      // GH-2108. Nothing removed these files, so they accumulated forever —
      // 126 locks on the reporting machine, two thirds of them pointing at
      // checkouts the GH-2103 sweep had removed, the oldest a week old.
      //
      // THE PREDICATE IS "THE CHECKOUT IS GONE", NEVER "THE LOCK IS OLD". A
      // lease is the mechanism deliver-queue reads for local-session-active
      // (GH-1929), so anything able to delete one must be unable to delete a
      // live one. Age cannot tell them apart — a session idle for three hours
      // still owns its tree and its unpushed commits — while a missing
      // directory can: no session can be driving a checkout that is not
      // there, and nothing can ever refresh the lock again. Any read failure
      // that is not ENOENT stays "unknown" and is left alone.
      //
      // Machine-wide, like `who`: the sessions dir is shared by every repo on
      // the box, and a dead lock's own repo can no longer be read off a
      // directory that does not exist. Scoping this to the configured repo
      // would leave exactly the rows nobody can attribute.
      const rows = readLocalLeases(ctx);
      if (rows === null) {
        // Not "nothing to reap" — the same distinction every lease reader here
        // keeps. A dir we could not read has told us nothing.
        if (flags.json) json({ evaluated: false, applied: false, dead: [], removed: 0, failed: [] });
        else out("leases: not evaluated — sessions dir unreadable (distinct from nothing to reap)");
        return 0;
      }
      const dead = rows.filter((l) => l.worktreeState === "missing");
      const applying = !!flags.apply;
      const { removed, failed } = applying
        ? reapDeadLeases(dead)
        : { removed: [] as string[], failed: [] as { file: string; reason: string }[] };
      if (flags.json) {
        json({ evaluated: true, applied: applying, dead, removed: removed.length, removedFiles: removed, failed });
        return failed.length ? 1 : 0;
      }
      if (dead.length === 0) {
        out(`nothing to reap — every one of the ${rows.length} local lease(s) names a checkout that still exists`);
        return 0;
      }
      for (const l of dead) out(`  ${applying ? "REAP" : "dead"}: #${l.issue} ${l.session} — worktree gone: ${l.worktree}`);
      if (!applying) {
        out(`${dead.length} dead lease(s) of ${rows.length} — DRY RUN, nothing was touched; re-run with --apply to remove them`);
        return 0;
      }
      out(`reaped ${removed.length} of ${dead.length} dead lease(s)`);
      for (const f of failed) out(`  KEPT ${f.file}: ${f.reason}`);
      return failed.length ? 1 : 0;
    }

    case "bootstrap": {
      // .ralph.json exists by the time run() sees this (pre-existing, or just
      // written by the no-config path in main from these same flags).
      if (typeof flags.owner === "string" && (flags.owner !== ctx.cfg.owner || flags.repo !== ctx.cfg.repo)) {
        out(
          `note: config already present (${ctx.cfg.owner}/${ctx.cfg.repo}, project #${ctx.cfg.projectNumber}) — ` +
            `flags ignored; edit .ralph.json to change scope`,
        );
      }
      // Repo→project linkage is advisory (setup warns when absent); linking
      // needs the project scope, so a failure is a printed manual step.
      const link = ctx.exec([
        "gh", "project", "link", String(ctx.cfg.projectNumber),
        "--owner", ctx.cfg.owner, "--repo", `${ctx.cfg.owner}/${ctx.cfg.repo}`,
      ]);
      out(
        link.code === 0
          ? `linked ${ctx.cfg.owner}/${ctx.cfg.repo} to project #${ctx.cfg.projectNumber}`
          : `MANUAL: could not link the repo to project #${ctx.cfg.projectNumber} (${(link.stderr || link.stdout).trim().slice(0, 120)}) — link it in the project UI`,
      );
      const rep = setup(ctx, out);
      out("");
      out(`config: .ralph.json is authoritative; the tracked settings env block is the alternative:`);
      out(`  "env": { "RALPH_GH_OWNER": "${ctx.cfg.owner}", "RALPH_GH_REPO": "${ctx.cfg.repo}", "RALPH_GH_PROJECT_NUMBER": "${ctx.cfg.projectNumber}" }`);
      out(`next: \`board readiness\` reports what this repo is ready for; \`board doctor\` sweeps invariants`);
      return rep.ok ? 0 : 1;
    }

    case "add": {
      // The one sanctioned non-own-repo add path (audit C4) — the guard
      // CLAUDE.md documents as "exists so a future non-own-repo add path
      // trips" is exactly what gates it: RALPH_ALLOW_FOREIGN_REPO_ITEMS
      // unset/false refuses with the reason.
      const url = positional[0];
      if (!url || !/^https?:\/\//.test(url)) throw new UsageError(`add requires an issue URL (board add https://github.com/o/r/issues/N)`);
      const parsedRepo = repoFromIssueUrl(url);
      const numMatch = /\/issues\/(\d+)$/.exec(url);
      if (!parsedRepo || !numMatch) throw new UsageError(`not an issue URL: ${url}`);
      const num = Number(numMatch[1]);
      // Policy check BEFORE the read (on the typed URL — refusing costs no
      // API), and again after on the URL GitHub returned, which is the
      // authoritative one (the GH-1815 rule: comparing cfg against itself
      // asserts nothing; a redirect could differ from what was typed).
      assertBoardAddAllowed(ctx, url, num);
      const [owner, name] = parsedRepo.split("/");
      const data = ghGraphQL<any>(
        ctx,
        `query($owner: String!, $name: String!, $number: Int!) {
          repository(owner: $owner, name: $name) { issue(number: $number) { id url title } }
        }`,
        { owner, name, number: num },
      );
      const issueNode = data.repository?.issue;
      if (!issueNode) throw new UsageError(`issue not found: ${url}`);
      assertBoardAddAllowed(ctx, issueNode.url, num);
      const cache = ensureCache(ctx);
      ghGraphQL(
        ctx,
        `mutation($projectId: ID!, $contentId: ID!) {
          addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) { item { id } }
        }`,
        { projectId: cache.projectId, contentId: issueNode.id },
      );
      out(`added ${parsedRepo}#${num} to the board (${issueNode.title})`);
      return 0;
    }

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
        peerPrefix: peerPrefix(branch),
        legacyBranch: `feature/GH-${num}`,
      };
      if (flags.json) json(names);
      else {
        out(`branch   ${names.branch}`);
        out(`agent    ${names.agent}`);
        out(`worktree ${names.worktree}`);
        out(`peer     ${names.peerPrefix}-<suffix> (harness-assigned; resolve with \`board peer ${num}\`)`);
      }
      return 0;
    }

    case "peer": {
      // The peer namespace is harness-owned (GH-1918): ralph can recognise an
      // address but never construct one, so the live names arrive on stdin —
      // whatever the caller's transport enumerated — and this decides. Fails
      // closed on both zero and >1: an address is a session, and the wrong
      // session is worse than no session.
      const num = requireNumber(positional[0]);
      const issue = fetchIssue(ctx, num);
      const kind = branchKindFor(issue.labels, {
        applyLabel: ctx.cfg.apply.enabled ? ctx.cfg.apply.label : null,
        labelsTruncated: issue.labelsTruncated,
      });
      // BOTH grammars, for the same reason the linkage query covers both: a
      // session that resumed a legacy branch is running under leaf `GH-N`
      // while this derives `feat-N-slug`, and asking about one prefix would
      // report a live peer as not running.
      const prefixes = [
        peerPrefix(formatBranchName(kind, num, issue.title)),
        peerPrefix(`feature/GH-${num}`),
      ];
      const prefix = prefixes[0];
      const rawCandidates =
        typeof flags.candidates === "string" ? flags.candidates.replace(/,/g, "\n") : readFileSync(0, "utf8");
      const candidates = rawCandidates
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l !== "");
      const res = resolvePeerAddress(prefixes, candidates);
      if (flags.json) json({ number: num, peerPrefix: prefix, peerPrefixes: prefixes, candidates, ...res });
      else if (res.kind === "resolved") out(res.address);
      else if (res.kind === "none")
        out(`no live peer matching ${prefixes.map((p) => `${p}-<suffix>`).join(" or ")} among ${candidates.length} candidate(s) — that session is not running`);
      else
        out(`ambiguous: ${res.candidates.join(", ")} are distinct live sessions for #${num} — name one explicitly`);
      return res.kind === "resolved" ? 0 : 1;
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
      const full = listOwnOpenWalk(ctx, QUEUE_SELECT_NO_LABELS);
      const own = full.open;
      // Closed items ride along as pass-through tree edges only — resolved
      // upward from the open set rather than by paging the whole project.
      const closedEdges = closedTreeEdges(ctx, own);
      // The values the ranker will actually rank double as staleness evidence:
      // one it cannot find in the cached options proves the schema moved.
      const order = priorityOptionOrder(ctx, {
        values: own.map((i) => i.priority),
        fresh: flags.fresh === true,
      });
      const { eligible, blocked, inFlightEpics, deferred } = rankNext(own, closedEdges, order);
      // --json carries the diagnosis as fields, never as the prose line.
      const dx = diagnoseEmptyQueue(own, eligible, blocked, inFlightEpics, deferred);
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
      const full = listOwnOpenWalk(ctx, QUEUE_SELECT_NO_LABELS);
      const own = full.open;
      const closedEdges = closedTreeEdges(ctx, own);
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
      // A stalled loop is the one blocked row whose remedy is a human's, so it
      // gets its detail line rather than a bare `←reason` (GH-1977).
      const stalledLines = (): void => {
        for (const b of res.blocked) {
          if (b.reason !== "convergence-stalled") continue;
          out(
            `  #${b.number} pr#${b.pr} review loop ${b.convergence}: ${b.detail ?? ""}` +
              `\n    → board move ${b.number} human-needed --why "<decision>" (do not request another review)`,
          );
        }
        // GH-1929: a held unit names its holder and its own expiry. A bare
        // `←local-session-active` would read as a fault needing intervention,
        // when the correct response is almost always to wait — so the line says
        // when it clears itself, and the escape hatch is the same --steal the
        // claim path already documents.
        for (const b of res.blocked) {
          if (b.reason !== "local-session-active" || !b.lease) continue;
          out(
            `  #${b.number} held by a live session in ${b.lease.worktree} (since ${b.lease.since})` +
              `\n    → it may hold unpushed commits; clears itself at ${b.lease.expiresAt}.` +
              ` If that session is gone: board claim ${b.number} --steal`,
          );
        }
      };
      if (flags.json) json(res);
      else if (!res.next) {
        const why = res.blocked.length
          ? ` (${res.blocked.length} blocked: ${res.blocked
              .map((b) => `#${b.number}${b.pr ? ` pr#${b.pr}` : ""}←${b.reason}`)
              .join(" ")})`
          : "";
        out(`deliver queue empty${why}`);
        stalledLines();
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
        stalledLines();
      }
      return 0;
    }

    case "card-signals": {
      const res = cardSignals(ctx);
      if (flags.json) json(res);
      else {
        for (const r of res.inReview) {
          const prs = r.prs.length
            ? r.prs
                .map(
                  (p) =>
                    `pr#${p.number} ${p.merged ? "MERGED" : p.state}` +
                    (p.state === "OPEN"
                      ? ` checks=${p.checks ?? "?"} mergeable=${p.mergeable ?? "?"}`
                      : ""),
                )
                .join(" ")
            : "(no linked PR)";
          out(`#${r.number} ${prs}`);
        }
        for (const e of res.epics)
          out(
            `epic #${e.number} ${e.done}/${e.total}${e.truncated ? " (child list TRUNCATED)" : ""} ${e.title}`,
          );
        if (res.unreadable.length)
          out(
            `  linkage TRUNCATED (held out, reads as unread): ${res.unreadable.map((n) => `#${n}`).join(" ")}`,
          );
        if (!res.inReview.length && !res.epics.length && !res.unreadable.length)
          out("no card signals");
      }
      return 0;
    }

    case "closed": {
      const res = recentDone(ctx);
      if (flags.json) json(res);
      else {
        out(`${res.items.length} closed as completed since ${res.since} (${res.windowDays}d window)`);
        for (const c of res.items) out(`  #${c.number} ${c.closedAt} ${c.title}`);
      }
      return 0;
    }

    case "pr-orphans": {
      const res = prOrphans(ctx);
      if (flags.json) json(res);
      else {
        if (!res.orphans.length) out(`no unlinked open PRs (${res.scanned} open)`);
        else {
          out(`${res.orphans.length} unlinked open PR(s) of ${res.scanned}:`);
          for (const o of res.orphans)
            out(
              `  #${o.number} ${o.ageDays}d${o.isDraft ? " draft" : ""} ` +
                `${o.author ?? "(unknown author)"} — ${o.title}`,
            );
        }
        if (res.ignored)
          out(`  ${res.ignored} skipped by ${PR_ORPHAN_IGNORE_ENV} (${res.ignoreAuthors.join(",") || "none"})`);
        if (res.unreadable.length)
          out(`  linkage UNREADABLE: ${res.unreadable.map((n) => `#${n}`).join(" ")} — neither linked nor orphaned`);
      }
      return 0;
    }

    case "tend-queue": {
      const res = tendQueue(ctx);
      // GH-2202: the snoozed count prints in BOTH branches — a suppressed
      // reminder that leaves no trace reads identical to a healthy queue.
      const snoozeNote =
        res.snoozed > 0 ? ` (${res.snoozed} intake snoozed — withheld from unformed until recheck)` : "";
      if (flags.json) json(res);
      else if (!res.next) out(`tend queue empty — one clean sweep${snoozeNote}`);
      else {
        out(`tend next: #${res.next.number} [${res.next.category}]${res.next.title ? ` ${res.next.title}` : ""}`);
        for (const c of res.next.candidates ?? [])
          out(`    candidate #${c.number} overlap=${c.overlap.toFixed(2)} ${c.title} (shared: ${c.terms.join(" ")})`);
        for (const r of res.queue.slice(1, 8))
          out(
            `  then #${r.number} [${r.category}]${r.title ? ` ${r.title}` : ""}` +
              (r.candidates?.length ? ` (${r.candidates.length} candidate${r.candidates.length === 1 ? "" : "s"})` : ""),
          );
        if (snoozeNote) out(` ${snoozeNote.trim()}`);
      }
      return 0;
    }

    case "dep-candidates": {
      const n = requireNumber(positional[0]);
      try {
        // The target's already-wired edges, both directions. From the walk
        // when it is there; a just-filed issue can sit inside the cache TTL,
        // so an absent target gets one authoritative read instead of an
        // error a caller on the filing path would hit every time.
        const cliWalk = listOwnOpenWalk(ctx, QUEUE_SELECT_NO_LABELS);
        const t = cliWalk.open.find((i) => i.number === n);
        const wired = new Set<number>();
        let targetTitle: string;
        let targetParent: number | null;
        if (t) {
          targetTitle = t.title;
          targetParent = t.parentNumber;
          for (const b of t.openBlockers ?? []) wired.add(b);
          for (const b of t.closedBlockers ?? []) wired.add(b);
        } else {
          const issue = fetchIssue(ctx, n);
          targetTitle = issue.title;
          targetParent = issue.parentNumber;
          const self = `${ctx.cfg.owner}/${ctx.cfg.repo}`.toLowerCase();
          for (const b of issue.blockedBy)
            if (!b.repo || b.repo.toLowerCase() === self) wired.add(b.number);
        }
        const { candidates, considered, cap, capped, walk } = readDepCandidates(
          ctx,
          { number: n, title: targetTitle, parentNumber: targetParent },
          wired,
          cliWalk,
        );
        if (flags.json)
          json({
            target: n,
            considered,
            cap,
            capped,
            disclaimer: DEP_CANDIDATES_DISCLAIMER,
            candidates,
            cache: cacheFacts(walk),
          });
        else {
          out(
            `dep-candidates for #${n}: ${candidates.length} of ${considered} unclaimed Backlog items share terms (cap ${cap})`,
          );
          out(`  note: ${DEP_CANDIDATES_DISCLAIMER}`);
          for (const c of candidates)
            out(
              `  #${c.number} ${c.score.toFixed(2)} (overlap ${c.overlap.toFixed(2)}) ${c.title} (shared: ${c.terms.join(" ")})`,
            );
          if (capped > 0) out(`  (+${capped} more past cap ${cap} — RALPH_DEP_CANDIDATES_MAX raises it)`);
          if (candidates.length === 0)
            out("  no overlap found — absence of overlap is not evidence of independence");
          if (cacheNote(walk)) out(`  ${cacheNote(walk)}`);
        }
        return 0;
      } catch (e) {
        // GH-1971's rule, load-bearing here: a filing path that silently
        // skipped the check would render exactly like a filing with no
        // dependencies. Exit codes keep their lane meanings (75 transport,
        // 1 error); a usage error is the caller's, not a failed check.
        if (!(e instanceof UsageError))
          process.stderr.write("dep-candidates: NOT CHECKED — the read failed; this is not an empty candidate list\n");
        throw e;
      }
    }

    case "create": {
      if (typeof flags.title !== "string" || !flags.title) throw new UsageError("--title required");
      // The landing state is CHOSEN, never defaulted (GH-2077). A bare
      // `create` used to land in Backlog, which meant filing an issue silently
      // approved it for autonomous pickup — the gap the intake tier closes.
      // Three spellings, one resolved answer: `--intake`, `--backlog`, and the
      // pre-existing `--state <s>` for the states neither lane names. Two at
      // once is a refusal rather than a precedence rule nobody can recall.
      const explicitState = typeof flags.state === "string" ? parseStateArg(flags.state) : null;
      if (typeof flags.state === "string" && !explicitState)
        throw new UsageError(`unknown state "${flags.state}"`);
      const lanes = [
        flags.intake === true ? ("Intake" as State) : null,
        flags.backlog === true ? ("Backlog" as State) : null,
        explicitState,
      ].filter((x): x is State => x !== null);
      if (lanes.length > 1)
        throw new UsageError(
          `pick ONE landing state: --intake, --backlog and --state name ${lanes.join(", ")} — ` +
            `which one is intended cannot be guessed`,
        );
      const state = lanes[0];
      if (!state)
        throw new UsageError(
          "create needs a landing state — there is no default, because filing an issue is not approving it:\n" +
            "  --intake    track it now, not yet approved for pickup (Priority/Estimate optional)\n" +
            "  --backlog   approved and ready to work (Priority and Estimate REQUIRED)\n" +
            "An intake item is invisible to `board next`/`frontier`; `board move NNN backlog` approves it.",
        );
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
        state,
        allowDuplicate: flags["allow-duplicate"] === true,
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
      // The filing-path dependency check (GH-2137), AFTER the create's own
      // output: the write outranks the advisory, so nothing here can refuse
      // or fail the filing — every failure inside prints NOT CHECKED and
      // returns. Both lanes run it; a dependency is a fact about the work,
      // not about which tier it landed in.
      // Scored on the text the filer TYPED (flags), not the fetched
      // round-trip: they are the same bytes on a clean create, and on an
      // adopted twin the typed text is still the intent being filed.
      printFilingDepCandidates(
        ctx,
        { number: issue.number, title: flags.title, blockedBy: issue.blockedBy },
        typeof flags.body === "string" ? flags.body : "",
        issue.parentNumber,
      );
      return 0;
    }

    case "priority":
    case "estimate": {
      const value = positional[1];
      if (!flags.clear && !value)
        throw new UsageError(`${cmd} NNN <option> (or --clear) required`);
      if (flags.clear && value)
        throw new UsageError(`--clear takes no ${cmd} value`);
      // List arity (GH-2130): a comma selects the bulk path; a bare number
      // keeps the single-item path byte-identical to before.
      if (String(positional[0] ?? "").includes(",")) {
        const numbers = String(positional[0])
          .split(",")
          .map((s) => requireNumber(s.trim() || undefined, `issue number in list ("${positional[0]}")`));
        const { result } = bulkSetAdvisoryField(
          ctx,
          numbers,
          cmd === "priority" ? PRIORITY_FIELD : ESTIMATE_FIELD,
          flags.clear ? null : value!,
          pruneLimit(flags.limit as string | boolean | undefined),
        );
        if (flags.json) {
          json(result);
          return result.aborted ? 1 : 0;
        }
        for (const n of result.applied) out(`#${n} ${cmd}=${result.value ?? "(none)"}`);
        for (const f of result.failed) out(`FAILED ${f}`);
        if (result.aborted) {
          out(
            `ABORTED after ${PRUNE_MAX_CONSECUTIVE_FAILURES} consecutive failures — ` +
              `${numbers.length - result.attempted} item(s) not attempted`,
          );
          return 1;
        }
        return result.failed.length > 0 ? 1 : 0;
      }
      const number = requireNumber(positional[0]);
      const issue =
        cmd === "priority"
          ? setPriority(ctx, number, flags.clear ? null : value!)
          : setEstimate(ctx, number, flags.clear ? null : value!);
      const after = cmd === "priority" ? issue.priority : issue.estimate;
      out(`#${issue.number} ${cmd}=${after ?? "(none)"} ${issue.title}`);
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
      if (sub === "join") {
        throw new RefusalError(
          `claim join was removed in GH-1869 — nothing creates a multi-holder claim any more. ` +
            `One owner holds the claim (\`board claim NNN\`) and delegates hold none; ` +
            `co-equal siblings on one issue are decomposition (\`board create\` + \`board dep\`), not a shared claim.`,
        );
      }
      if (sub === "leave") {
        const number = requireNumber(positional[1]);
        if (typeof flags.holder !== "string" || !flags.holder) {
          throw new UsageError(`claim leave requires --holder <agent name>`);
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
      const after = transition(ctx, issue, "In Progress", {
        steal: !!flags.steal,
        // In Review → In Progress is a demotion and the machine requires the
        // reason (GH-2078); claiming back a reviewed item carries it here.
        why: typeof flags.why === "string" ? flags.why : undefined,
      });
      out(issueLine(after));
      return 0;
    }

    case "release": {
      if (typeof flags.m !== "string" || !flags.m) throw new UsageError(`release requires -m "<where you stopped and what's next>"`);
      const issue = fetchIssue(ctx, requireNumber(positional[0]));
      const after = transition(ctx, issue, "Backlog", { why: flags.m });
      if (issue.state === "Backlog") out(`noop: #${after.number} already "Backlog" (nothing to do)`);
      else out(issueLine(after));
      return 0;
    }

    case "move": {
      const issue = fetchIssue(ctx, requireNumber(positional[0]));
      const to = positional[1] ? parseStateArg(positional[1]) : null;
      if (!to) throw new UsageError(`move requires a target state (${STATES.join(" | ")})`);
      if (typeof flags.decision === "string" && flags.decision) {
        // Evidence BEFORE the state write, same ordering rule as --why: an
        // interrupted run leaves the record, not a bare state.
        addComment(
          ctx,
          issue.nodeId,
          `**Decision evidence** (\`board\` by \`${ctx.cfg.holder}\`):\n\n${DECISION_EVIDENCE_MARKER}\nartifact: ${flags.decision}`,
        );
      }
      // GH-2179: escalation addressing. Default keys on RALPH_HERDR_LEAD —
      // set by the team spawn path (GH-2178), absent in solo sessions — so a
      // team worker's escalation routes to its lead with no prose change and
      // everyone else keeps the status quo. --to-human forces the reserved-set
      // direction; --to-lead <name> is the explicit form.
      const toHuman = !!flags["to-human"];
      const toLeadFlag = typeof flags["to-lead"] === "string" ? flags["to-lead"].trim() : null;
      if ((toHuman || toLeadFlag !== null) && to !== "Human Needed")
        throw new UsageError(`--to-lead/--to-human address an escalation — only \`move NNN human-needed\` takes them`);
      if (toHuman && toLeadFlag !== null)
        throw new UsageError(`--to-lead and --to-human are exclusive`);
      let routeToLead: string | undefined;
      if (to === "Human Needed" && !toHuman) {
        const envLead = (process.env.RALPH_HERDR_LEAD ?? "").trim();
        if (toLeadFlag !== null) {
          if (!toLeadFlag && !envLead)
            throw new UsageError(`--to-lead requires a lead name (none given, RALPH_HERDR_LEAD unset)`);
          routeToLead = toLeadFlag || envLead;
        } else if (envLead) routeToLead = envLead;
      }
      const noop = issue.state === to && to !== "In Progress";
      const after = transition(ctx, issue, to, {
        why: typeof flags.why === "string" ? flags.why : undefined,
        routeToLead,
      });
      if (noop) {
        out(
          issue.issueState === "OPEN" && after.issueState === "CLOSED"
            ? `noop: #${after.number} already "${to}" — completed the issue close the earlier move left half-applied`
            : `noop: #${after.number} already "${to}" (nothing to do)`,
        );
      } else out(issueLine(after));
      return 0;
    }

    case "answer": {
      const number = requireNumber(positional[0]);
      const message =
        typeof flags.m === "string" && flags.m ? flags.m
        : typeof flags.message === "string" && flags.message ? flags.message
        : null;
      if (!message) throw new UsageError(`answer requires -m "<the decision>" (--message also accepted)`);
      // --comment-only is accepted and inert: it names what is now the
      // default (GH-2204 moved the resume edge to the resuming agent).
      const res = answer(ctx, number, {
        message,
        anyState: !!flags["any-state"],
        resume: !!flags.resume,
      });
      if (flags.json) json(res);
      else {
        out(
          res.transitioned
            ? `#${number}: answer commented; Human Needed → ${res.state} (resumed under this session's claim)`
            : res.resumePending
              ? `#${number}: answer commented; stays Human Needed — resume pending ` +
                `(the driving session runs \`board claim ${number}\`)`
              : `#${number}: answer commented; no transition (state: ${res.state ?? "(none)"})`,
        );
      }
      return 0;
    }

    case "promote": {
      const number = requireNumber(positional[0]);
      const note =
        typeof flags.m === "string" && flags.m ? flags.m
        : typeof flags.message === "string" && flags.message ? flags.message
        : undefined;
      const res = promote(ctx, number, { note });
      if (flags.json) json(res);
      else if (!res.promoted) out(`noop: #${number} is already promoted (nothing to do)`);
      else out(`#${number}: escalation promoted into the inbox (was ${res.route.lead ?? "lead"}-routed)`);
      return 0;
    }

    case "escalations": {
      const rows = escalationsQueue(ctx);
      if (flags.json) {
        json({ escalations: rows });
        return 0;
      }
      if (rows.length === 0) {
        out("no Human Needed items");
        return 0;
      }
      for (const r of rows) {
        const who =
          r.route === "human" ? "→human"
          : r.disposition === "pending" ? `→lead ${r.lead ?? "(unnamed)"} (pending${r.at ? ` since ${r.at}` : ""})`
          : r.disposition === "promoted" ? `→human (promoted by lead)`
          : `→human (auto-promoted: lead ${r.lead ?? "(unnamed)"} TTL elapsed)`;
        const ans = r.answered
          ? ` [ANSWERED${r.answered.at ? ` ${r.answered.at}` : ""} — resume pending: board claim ${r.number}]`
          : "";
        out(`#${r.number} ${who}${ans} ${r.title}`);
      }
      return 0;
    }

    case "cancel": {
      if (typeof flags.m !== "string" || !flags.m) throw new UsageError(`cancel requires -m "<reason>"`);
      const issue = fetchIssue(ctx, requireNumber(positional[0]));
      const after = transition(ctx, issue, "Canceled", { why: flags.m });
      if (issue.state === "Canceled") {
        out(
          issue.issueState === "OPEN" && after.issueState === "CLOSED"
            ? `noop: #${after.number} already "Canceled" — completed the issue close the earlier cancel left half-applied`
            : `noop: #${after.number} already "Canceled" (nothing to do)`,
        );
      } else out(issueLine(after));
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
        const p = resolveProposal(ctx, issue, "accepted", "Resolved by `board reopen`.", true);
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
      if (!reject) {
        // Accepting records the decision; the disposition is still a gated
        // state move this verb deliberately does not perform (its charter:
        // rejection is the one disposition nothing else observes). Name the
        // follow-up so accepted-but-unmoved stops being a discovery.
        out(`  complete the disposition: board move ${number} done --why "<how>" (delivered) or board cancel ${number} -m "<why>" (duplicate/superseded)`);
      }
      return 0;
    }

    case "defer": {
      const number = requireNumber(positional[0]);
      if (flags.clear) {
        const after = setDefer(ctx, number, null);
        out(after.defer ? `#${number}: defer clear did not stick — re-run` : `#${number}: defer cleared`);
        return 0;
      }
      const condition = typeof flags.until === "string" ? flags.until.trim() : "";
      if (!condition)
        throw new UsageError(
          `defer requires --until "<observable condition>" (what must become true before this ranks again), or --clear`,
        );
      let recheck: Date | null = null;
      if (typeof flags.recheck === "string" && flags.recheck) {
        const t = new Date(flags.recheck).getTime();
        // Refused at write time, never misfiled: a recheck nobody can parse is
        // a defer that silently never resurfaces.
        if (!Number.isFinite(t)) throw new UsageError(`--recheck must be an ISO-8601 instant, got "${flags.recheck}"`);
        recheck = new Date(t);
      }
      const after = setDefer(ctx, number, { recheck, condition });
      if (after.state === "Intake") {
        out(
          `#${number}: snoozed — ${condition} (until ${recheck!.toISOString()}) — ` +
            `withheld from tend-queue unformed and doctor intake-stale until then, ` +
            `then resurfaces with its full age; still visible in board list`,
        );
      } else {
        out(
          `#${number}: deferred — ${condition}` +
            (recheck ? ` (recheck by ${recheck.toISOString()})` : "") +
            ` — parked out of next/frontier until cleared or claimed`,
        );
        if (after.state !== "Backlog") out(`  note: state is "${after.state}" — defer only parks Backlog ranking`);
      }
      return 0;
    }

    case "link": {
      const parent = requireNumber(positional[0], "parent number");
      const child = requireNumber(positional[1], "child number");
      if (flags.rm && flags.replace) throw new UsageError("--rm and --replace are mutually exclusive");
      const mode: LinkMode = flags.rm ? "rm" : flags.replace ? "replace" : "add";
      out(linkParent(ctx, parent, child, mode));
      return 0;
    }

    case "dep": {
      const blocked = requireNumber(positional[0]);
      // --blocked-by is an alias for --on: the CLI's own output and JSON say
      // "blockedBy", and every observed first use typed it — a CLI that
      // disagrees with its own vocabulary is the defect, not the typist.
      const onFlag =
        typeof flags.on === "string" ? flags.on
        : typeof flags["blocked-by"] === "string" ? flags["blocked-by"]
        : undefined;
      const blocking = requireNumber(onFlag, "--on <blocking issue> (--blocked-by also accepted)");
      // --dismiss (GH-2136): the judgment that these two are NOT dependent,
      // recorded durably so `deps-unwired` stops surfacing the pair. A typed
      // writer, deliberately: hand-composed markers are the GH-1826 quoting
      // trap, and a category keyed on a marker with no CLI writer is the
      // GH-2129 class.
      if (flags.dismiss) {
        if (flags.rm) throw new UsageError("--dismiss and --rm are mutually exclusive");
        if (blocked === blocking) throw new UsageError("cannot dismiss an issue against itself");
        const note = typeof flags.m === "string" && flags.m ? flags.m : undefined;
        const payload = JSON.stringify({
          target: blocked,
          dismissed: [blocking],
          at: ctx.now().toISOString(),
          ...(note ? { note } : {}),
        });
        addComment(
          ctx,
          fetchNodeIds(ctx, [blocked]).get(blocked)!,
          `**Dependency judged: no edge** between #${blocked} and #${blocking} (\`board\` by \`${ctx.cfg.holder}\`)` +
            (note ? `:\n\n${note}` : "") +
            `\n\n${TEND_DEP_JUDGED_MARKER}\n\`\`\`json\n${payload}\n\`\`\``,
        );
        out(`#${blocked}: dismissed dependency candidate #${blocking} (judged, no edge)`);
        return 0;
      }
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

      // Held items are REPORTED on every path (GH-1883). A hold here is
      // indefinite — nothing ever force-prunes — so an over-tight rule is only
      // visible if the retention tally is printed whether or not the sweep
      // also found something to remove.
      const retentionSummary = () => {
        if (report.retained.length === 0) return;
        const counts = new Map<PruneRetention, number>();
        for (const r of report.retained) counts.set(r.reason, (counts.get(r.reason) ?? 0) + 1);
        out(
          `  held indefinitely: ${report.retained.length} closed item(s) still read by something — ` +
            [...counts].map(([r, n]) => `${r} ${n}`).join(", "),
        );
        for (const d of report.diverged.slice(0, 20)) {
          out(
            `  #${d.number} DIVERGED issue=CLOSED/${d.stateReason ?? "unknown"} ` +
              `workflow-state="${d.state}" → run \`board reconcile ${d.number}\``,
          );
        }
        if (report.diverged.length > 20) out(`  … and ${report.diverged.length - 20} more diverged`);
      };

      if (report.candidates.length === 0) {
        if (text) {
          out(`nothing to prune: ${report.scanned} closed item(s) all still read by something.`);
          retentionSummary();
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
            `board state already terminal, no open item's tree, sibling or blocks edge touches them.`,
        );
        retentionSummary();
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

    case "sweep-non-issues": {
      const walk = walkNonIssueItems(ctx);
      const report = classifyNonIssueSweep(walk);
      const applying = !!flags.apply;
      const limit = pruneLimit(flags.limit);
      const selected = applying ? report.candidates.slice(0, limit) : report.candidates;
      const text = !flags.json;

      // The source-liveness line is printed FIRST and on every path, because
      // it is the operator's whole verification gate: the API cannot read the
      // auto-add workflow's filter, so the newest non-issue item's timestamp
      // and creator are the only evidence that the source is closed. It is
      // deliberately NOT an automatic refusal — a board with no recent PRs
      // cannot distinguish "the filter was fixed" from "nobody opened a PR",
      // so a timestamp threshold here would be a coin flip wearing a gate's
      // clothes. The operator reads it against a PR they know was opened.
      const sourceLine = () => {
        if (!report.newest) return "no non-issue item carries a createdAt — source liveness NOT evaluated";
        return (
          `newest non-issue item: ${report.newest.label} added ${report.newest.createdAt}` +
          ` by ${report.newest.creator ?? "unknown"}`
        );
      };

      if (text) {
        out(
          `${walk.scanned} item(s) = ${walk.pages} page(s) per full scan: ` +
            `${walk.issues} issue(s), ${walk.nonIssue.length} non-issue` +
            (report.byKind.length ? ` (${report.byKind.map(([k, n]) => `${k} ${n}`).join(", ")})` : ""),
        );
        out(`  ${sourceLine()}`);
        out(
          `  compare that against a pull request you know was opened AFTER the auto-add filter was ` +
            `narrowed to \`is:issue\`. If a later PR is absent here, the source is closed and this set is finite.`,
        );
        if (walk.short) {
          out(
            `  WARNING: paged fewer nodes than the project reported — this walk is INCOMPLETE. ` +
              `Everything listed was really seen, but "none left" cannot be concluded from it; re-run.`,
          );
        }
        for (const r of report.retained.slice(0, 10)) out(`  held: ${r.label} (${r.reason})`);
        if (report.retained.length > 10) out(`  … and ${report.retained.length - 10} more held`);
      }

      if (report.candidates.length === 0) {
        if (text) out(`nothing to sweep: no removable non-issue item on this board.`);
        else json({ ...walk, nonIssue: undefined, ...report, applied: applying, limit, attempted: 0, removed: 0, failed: [], abortedAfterConsecutiveFailures: false });
        return 0;
      }

      if (!applying) {
        if (text) {
          out(
            `\nDRY RUN. \`board sweep-non-issues --apply\` removes ${report.candidates.length} item(s) ` +
              `FROM THE PROJECT ONLY — the pull requests and drafts themselves are untouched, exactly as ` +
              `\`board prune\` leaves an issue.\nUnlike prune there is nothing to lose: board.ts cannot ` +
              `read a non-issue item at all, so none of them carries a Workflow State or Claim value.` +
              (report.candidates.length > limit
                ? `\nOne sweep removes at most ${limit} (--limit); the rest need another run.`
                : ""),
          );
        } else {
          json({ ...walk, nonIssue: undefined, ...report, applied: false, limit });
        }
        return 0;
      }

      const result = removeProjectItems(ctx, selected);
      if (!text) {
        json({
          ...walk,
          nonIssue: undefined,
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
      out(`\nremoved ${result.removed} of ${result.attempted} attempted item(s) from the project; the PRs are untouched`);
      if (report.candidates.length > selected.length) {
        out(`${report.candidates.length - selected.length} candidate(s) left for the next run (--limit ${limit})`);
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
    let cfg: Config;
    try {
      cfg = loadConfig(repoRoot);
    } catch (e) {
      // Config-free carve-outs (audit C2): `help` must never exit 64 on a
      // fresh clone — learning that `board bootstrap` exists cannot require
      // the config bootstrap creates — and `bootstrap` is HOW config appears.
      const bare = process.argv.slice(2);
      const cmd = bare[0];
      if (!(e instanceof UsageError)) throw e;
      if (cmd === undefined || cmd === "help" || cmd === "--help" || cmd === "-h") {
        const topic = bare[1];
        process.stdout.write((topic && VERB_HELP[topic] ? VERB_HELP[topic] : HELP) + "\n");
        process.exit(0);
      }
      if (cmd === "bootstrap") {
        const { flags } = parseArgs(bare.slice(1));
        const path = writeBootstrapConfig(repoRoot, flags);
        process.stdout.write(`wrote ${path}\n`);
        cfg = loadConfig(repoRoot);
      } else {
        throw e;
      }
    }
    const ctx: Ctx = {
      exec: realExec,
      cfg,
      repoRoot,
      cacheDir: join(homedir(), ".ralph", "cache"),
      now: () => new Date(),
      itemCacheTtlSec: parseItemCacheTtlSec(process.env.RALPH_ITEM_CACHE_TTL_SEC),
      itemOracleMaxSec: parseItemOracleMaxSec(process.env.RALPH_ITEM_ORACLE_MAX_SEC),
      session: {
        // RALPH_SESSION_ID first so a non-Claude runner can publish the fact
        // itself; CLAUDE_CODE_SESSION_ID is the one every session here has.
        id: process.env.RALPH_SESSION_ID || process.env.CLAUDE_CODE_SESSION_ID || null,
        dir: join(process.env.RALPH_HOME || join(homedir(), ".ralph"), "sessions"),
      },
    };
    let code: number;
    try {
      code = run(process.argv.slice(2), ctx);
    } finally {
      appendBudgetLedger(process.argv[2] ?? "(none)", new Date());
    }
    process.exit(code);
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`usage: ${e.message}\n`);
      process.exit(64);
    }
    if (e instanceof RefusalError) {
      process.stderr.write(`refused: ${e.message}\n`);
      process.exit(2);
    }
    if (e instanceof TransientError) {
      // EX_TEMPFAIL: wait and re-run — never "this request is malformed".
      process.stderr.write(`temporary: ${e.message}\n`);
      process.exit(75);
    }
    process.stderr.write(`error: ${(e as Error).message}\n`);
    process.exit(1);
  }
}
