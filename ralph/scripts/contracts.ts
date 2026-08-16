/**
 * contracts.ts — the Zod source of truth for ralph-herdr v2 (Phase 1).
 *
 * Plan: thoughts/shared/plans/2026-08-10-ralph-herdr-v2-implementation.md
 * Decision record: thoughts/shared/html-out/2026-08-10-ralph-herdr-v2-microworld.html
 *
 * Invariants carried here, not in prose:
 *   - naming grammar B: name = <lane><issue>-<slug>[--<gen>], ≤32 chars,
 *     parse-back guaranteed (lane = char 1, issue = leading digits, slug =
 *     the rest before any --N); "--" appears ONLY in the collision suffix
 *   - durable ref = name#spawn_epoch — pane_id is NEVER a durable key
 *   - ClaimV2 wire = "h1+h2+...|iso8601"; one holder == today's board.ts
 *     format byte-for-byte (back-compatible by construction)
 *   - every contract carries `contract` (literal id) + `contract_version: 1`;
 *     producers validate .strict(), consumers .passthrough() (additive-only —
 *     unknown keys are ignored on read, refused on write)
 *   - board state authoritative, herdr decorative: C6 declares the board CLI's
 *     REAL --json shapes (parity with board.ts, which imports this file — so
 *     this file must never import board.ts)
 *
 * Lints: L1–L13. Static ones run on the payload alone; L3/L5/L7 are LIVE
 * lints that run through injected effect functions (LiveLintDeps — board.ts
 * wires them under `contract lint --live`) and report
 * { skipped: "requires --live" } when no deps are given. L10 needs the herdr
 * ledger and stays bash-side (plugin/ralph-herdr/scripts/doctor-lineage.sh).
 */

import { createRequire } from "node:module";
import type { SafeParseReturnType, ZodRawShape, ZodTypeAny } from "zod";

// ---------------------------------------------------------------------------
// Lazy zod runtime
// ---------------------------------------------------------------------------
// board.ts imports this module on EVERY command, and installed-plugin copies
// ship no node_modules (the shim's `npx tsx` fallback is a supported runtime,
// ralph/scripts/board + ralph/README.md). A top-level `import "zod"` would
// therefore crash every board command on such hosts before any work happens —
// so zod loads lazily, on the first schema-needing call (`contract validate`
// / `contract emit`). Everything else in this file — naming, ClaimV2, the
// token vocabulary, the lints — is dependency-free on purpose.
//
// The type-only imports above are erased at runtime; only the values below
// touch the real package. Assigned once by loadZod(); the schema builders
// below only run after it.
let z: typeof import("zod")["z"];
let zodToJsonSchema: typeof import("zod-to-json-schema")["zodToJsonSchema"];
let zIssue: ZodTypeAny;
let zNonEmpty: ZodTypeAny;
let zIsoUtc: ZodTypeAny;
let zLane: ZodTypeAny;
let zAgentName: ZodTypeAny;
let zAgentRef: ZodTypeAny;

function loadZod(): void {
  if (z !== undefined) return;
  const require = createRequire(import.meta.url);
  try {
    ({ z } = require("zod") as typeof import("zod"));
    ({ zodToJsonSchema } = require("zod-to-json-schema") as typeof import("zod-to-json-schema"));
  } catch (e) {
    throw new Error(
      "`board contract validate|emit` needs the zod package, which is not resolvable beside this board copy " +
        "(installed-plugin copies ship without node_modules). Run it from a ralph-hero checkout after `npm install`, " +
        "or install bun. Every other board command works without zod. " +
        `(${e instanceof Error ? e.message : e})`,
    );
  }
  zIssue = z.number().int().positive();
  zNonEmpty = z.string().min(1);
  // ISO-8601, Z-anchored UTC (zod's .datetime() rejects offsets by default).
  zIsoUtc = z.string().datetime();
  zLane = z.enum(LANE_CHARS as [Lane, ...Lane[]]);
  zAgentName = z
    .string()
    .max(NAME_MAX)
    .refine((n) => parseAgentName(n)?.kind === "v2", {
      message: "not a grammar-B agent name (<lane><issue>-<slug>[--N])",
    });
  zAgentRef = z.string().refine((r) => parseRef(r) !== null, {
    message: "not a durable ref (name#epoch, epoch = 4-8 lowercase hex)",
  });
}

// ---------------------------------------------------------------------------
// Naming grammar B
// ---------------------------------------------------------------------------

/** Lane registry — the single char that opens every agent name. Issue 0 is
 *  reserved for infra agents (s0-watch, x0-relay). */
export const LANES = {
  w: "work",
  r: "review",
  o: "orchestrator",
  d: "disposable",
  s: "watcher",
  x: "relay",
  i: "investigation",
  t: "tending",
} as const;
export type Lane = keyof typeof LANES;
export const LANE_CHARS = Object.keys(LANES) as Lane[];

// ---------------------------------------------------------------------------
// Fleet roles (GH-1808) — the one-writer invariant, made structural
// ---------------------------------------------------------------------------

/** The role registry. A role answers ONE question the lane letter cannot:
 *  may this agent write the working tree it was spawned into?
 *
 *  `writesTree` is the invariant's whole surface. Exactly one agent per
 *  worktree may carry a role with `writesTree: true` — that is what makes a
 *  shared checkout safe where GH-1774's K sibling writers were not, and it is
 *  enforced at the spawn path (ralph_driver_guard), not asked of prose.
 *
 *  `spawns` is the edge rule: which roles this role may spawn on the herdr
 *  plane. An empty list is a LEAF — investigators, tenders, relays and
 *  watchers spawn nothing. (The watcher's refill is not a counterexample: a
 *  refill spawn is recorded as a depth-0 ROOT with no parent ref, the same
 *  shape a human click produces, so it crosses no edge here.) */
export const ROLES = {
  orchestrator: {
    doc: "plans and dispatches; owns no tree",
    writesTree: false,
    spawns: ["driver", "investigator", "tender"],
  },
  driver: {
    doc: "the one writer in a worktree — holds the board claim, cuts the branch",
    writesTree: true,
    spawns: ["investigator"],
  },
  investigator: {
    doc: "read-only fan-out worker (ralph/agents/investigator.md); a leaf",
    writesTree: false,
    spawns: [],
  },
  tender: { doc: "board metadata hygiene; writes no tree", writesTree: false, spawns: [] },
  relay: { doc: "message transport; writes no tree", writesTree: false, spawns: [] },
  watcher: { doc: "observes and reconciles; writes no tree", writesTree: false, spawns: [] },
} as const satisfies Record<string, { doc: string; writesTree: boolean; spawns: readonly string[] }>;
export type Role = keyof typeof ROLES;
export const ROLE_NAMES = Object.keys(ROLES) as Role[];

/** What a human may spawn directly. A human is not a role — it is the only
 *  spawner with no record of its own — so it is named here rather than given
 *  a row in ROLES it could never satisfy (`writesTree` is meaningless for it). */
export const HUMAN_SPAWNS = ["orchestrator", "driver"] as const satisfies readonly Role[];

/** Lane → role, for records that have no spawn-time role to read. The lane
 *  letter is recoverable from the agent name, so this is a DEFAULT for the
 *  discover path (reconcile), never an override: a spawn writes its role
 *  explicitly. `r` and `d` map to driver because both write a checkout — a
 *  review worker edits, and a fork is a second session in a real tree. */
export const LANE_ROLES = {
  w: "driver",
  r: "driver",
  d: "driver",
  o: "orchestrator",
  s: "watcher",
  x: "relay",
  i: "investigator",
  t: "tender",
} as const satisfies Record<Lane, Role>;

/** May PARENT spawn CHILD on the herdr plane? PARENT is a role or "human".
 *  Unknown names are refused rather than waved through: an edge check that
 *  fails open is not a check. */
export function spawnEdgeAllowed(parent: string, child: string): boolean {
  if (!(child in ROLES)) return false;
  if (parent === "human") return (HUMAN_SPAWNS as readonly string[]).includes(child);
  if (!(parent in ROLES)) return false;
  return (ROLES[parent as Role].spawns as readonly string[]).includes(child);
}

export const NAME_MAX = 32;
/** Chars reserved at format time for a possible collision suffix (--2..--9). */
export const GEN_RESERVE = 3;

/** The locked grammar: <lane><issue>-<slug>[--<gen>]. The slug starts with a
 *  letter and never contains "--", so the collision suffix is unambiguous. */
export const AGENT_NAME_RE = /^([a-z])([0-9]+)-([a-z][a-z0-9]*(?:-[a-z0-9]+)*)(--[2-9])?$/;
export const SLUG_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
/** What herdr itself accepts as an agent name — grammar B is a strict subset. */
export const HERDR_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
/** spawn_epoch: lowercase hex, 4–8 chars. */
export const EPOCH_RE = /^[0-9a-f]{4,8}$/;

export type ParsedAgentName =
  | { kind: "v2"; lane: Lane; issue: number; slug: string; gen: number | null }
  | { kind: "legacy"; name: string; issue: number | null };

/** lowercase, non-alnum runs → single hyphen, trim hyphens. The grammar also
 *  requires a leading letter, so leading digit/hyphen runs are stripped; an
 *  empty result falls back to "task" (a name must exist to be a scan key). */
export function slugify(title: string): string {
  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^[^a-z]+/, "")
    .replace(/^-+/, "");
  return s === "" ? "task" : s;
}

/** Slug budget for a given issue: 32 − lane(1) − digits − hyphen(1) − 3
 *  reserved for a possible --N suffix (so collisions never re-truncate). */
export function slugBudget(issue: number): number {
  return NAME_MAX - 1 - String(issue).length - 1 - GEN_RESERVE;
}

/** Truncate at the last full word of ≥3 chars within budget, else hard cut;
 *  strip trailing hyphens either way. */
export function truncateSlug(slug: string, issue: number): string {
  const budget = slugBudget(issue);
  if (slug.length <= budget) return slug;
  let keep = "";
  for (const w of slug.split("-")) {
    const cand = keep ? `${keep}-${w}` : w;
    if (cand.length > budget) break;
    keep = cand;
  }
  // A trailing "-a" / "-of" is noise, not a scan key — drop short last words.
  while (keep !== "") {
    const parts = keep.split("-");
    if (parts[parts.length - 1].length >= 3) break;
    parts.pop();
    keep = parts.join("-");
  }
  if (keep === "") keep = slug.slice(0, budget).replace(/-+$/, "");
  return keep;
}

/** Canonical name for (lane, issue, title). Title goes through slugify +
 *  truncateSlug; collision suffixes are collideName's job. */
export function formatAgentName(lane: Lane, issue: number, title: string): string {
  if (!(lane in LANES)) throw new RangeError(`unknown lane ${JSON.stringify(lane)}`);
  if (!Number.isInteger(issue) || issue < 0) throw new RangeError(`issue must be a non-negative integer (got ${issue})`);
  return `${lane}${issue}-${truncateSlug(slugify(title), issue)}`;
}

/** Parse-back: grammar B first, then the legacy transition names (gh-N,
 *  ralph-deliver, ralph-tend). Unknown lanes fail — the registry is closed. */
export function parseAgentName(name: string): ParsedAgentName | null {
  if (name.length === 0 || name.length > NAME_MAX) return null;
  const gh = /^gh-([0-9]+)$/.exec(name);
  if (gh) return { kind: "legacy", name, issue: Number(gh[1]) };
  if (name === "ralph-deliver" || name === "ralph-tend") return { kind: "legacy", name, issue: null };
  const m = AGENT_NAME_RE.exec(name);
  if (!m) return null;
  if (!(m[1] in LANES)) return null;
  return {
    kind: "v2",
    lane: m[1] as Lane,
    issue: Number(m[2]),
    slug: m[3],
    gen: m[4] ? Number(m[4].slice(2)) : null,
  };
}

/** First free name among base, base--2 .. base--9. The slug budget reserved 3
 *  chars, so a suffixed name never exceeds NAME_MAX. Nine live generations of
 *  one (lane, issue, slug) is a runaway spawner, not a naming problem. */
export function collideName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let g = 2; g <= 9; g++) {
    const cand = `${base}--${g}`;
    if (!taken.has(cand)) return cand;
  }
  throw new RangeError(`collision space exhausted for ${base} (--2..--9 all taken)`);
}

// ---------------------------------------------------------------------------
// Branch names — grammar B's other face (GH-1807)
//
// `<kind>/<issue>-<slug>`, where the slug is byte-identical to the one in the
// agent name for the same unit: `fix/1807-semantic-branch` alongside
// `w1807-semantic-branch`. One vocabulary, two surfaces, one declaration.
// ---------------------------------------------------------------------------

/** Kind registry — the closed set a branch may open with. Derived from labels,
 *  never free text, so `git branch` sorts into meaningful groups. */
export const BRANCH_KINDS = {
  feat: "new capability (the default)",
  fix: "defect repair",
  chore: "maintenance, deps, tooling",
  docs: "documentation only",
  apply: "apply unit — the deploy, not the merge",
} as const;
export type BranchKind = keyof typeof BRANCH_KINDS;
export const BRANCH_KIND_CHARS = Object.keys(BRANCH_KINDS) as BranchKind[];
export const DEFAULT_BRANCH_KIND: BranchKind = "feat";

/** Label→kind, first match wins. Substring-matched against lowercased labels
 *  so `type: bug`, `kind/bug` and `bug` all land on `fix`. The apply label is
 *  NOT here — it is configured per repo and passed in separately. */
const BRANCH_KIND_LABELS: ReadonlyArray<[string, BranchKind]> = [
  ["bug", "fix"],
  ["fix", "fix"],
  ["defect", "fix"],
  ["doc", "docs"],
  ["chore", "chore"],
  ["maintenance", "chore"],
  ["dependencies", "chore"],
  ["feature", "feat"],
  ["enhancement", "feat"],
];

/** The kind for an issue's labels. `applyLabel` wins outright when present —
 *  an apply unit is a different kind of work, not a flavour of feature. A
 *  truncated label list cannot prove the apply label absent, so pass
 *  `labelsTruncated` and the answer degrades to `apply` rather than guessing.
 *  Everything unmatched is DEFAULT_BRANCH_KIND: the branch shape is always
 *  producible, never blocked on a label taxonomy the host repo may not have. */
export function branchKindFor(
  labels: readonly string[],
  opts: { applyLabel?: string | null; labelsTruncated?: boolean } = {},
): BranchKind {
  const lower = labels.map((l) => l.toLowerCase());
  if (opts.applyLabel) {
    if (opts.labelsTruncated) return "apply";
    if (lower.includes(opts.applyLabel.toLowerCase())) return "apply";
  }
  for (const l of lower) {
    for (const [needle, kind] of BRANCH_KIND_LABELS) if (l.includes(needle)) return kind;
  }
  return DEFAULT_BRANCH_KIND;
}

/** `<kind>/<issue>-<slug>`. Legacy shape: `feature/GH-<issue>` — matched only
 *  by the parser, never produced. `feature` is deliberately NOT a live kind:
 *  it is the legacy prefix, and letting both grammars claim it would make
 *  `feature/1807-x` and `feature/GH-1807` neighbours in the same namespace. */
export const BRANCH_RE = /^([a-z]+)\/([0-9]+)-([a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/;
export const LEGACY_BRANCH_RE = /^feature\/GH-([0-9]+)$/;

export type ParsedBranch =
  | { kind: "v2"; branchKind: BranchKind; issue: number; slug: string }
  | { kind: "legacy"; branch: string; issue: number };

/** The branch for (kind, issue, title). Uses the AGENT slug budget unchanged —
 *  including the 3 chars reserved for a collision suffix branches never carry.
 *  Spending them on nothing is the price of a byte-identical slug on both
 *  surfaces; a wider branch budget would be two grammars to read. */
export function formatBranchName(kind: BranchKind, issue: number, title: string): string {
  if (!(kind in BRANCH_KINDS)) throw new RangeError(`unknown branch kind ${JSON.stringify(kind)}`);
  if (!Number.isInteger(issue) || issue < 0)
    throw new RangeError(`issue must be a non-negative integer (got ${issue})`);
  return `${kind}/${issue}-${truncateSlug(slugify(title), issue)}`;
}

/** Parse-back: grammar B first, then the legacy `feature/GH-N`. Mirrors
 *  parseAgentName — an unknown kind fails, because the registry is closed and
 *  a branch this cannot name is a branch the linkage must not claim. */
export function parseBranchName(branch: string): ParsedBranch | null {
  const legacy = LEGACY_BRANCH_RE.exec(branch);
  if (legacy) return { kind: "legacy", branch, issue: Number(legacy[1]) };
  const m = BRANCH_RE.exec(branch);
  if (!m) return null;
  if (!(m[1] in BRANCH_KINDS)) return null;
  return { kind: "v2", branchKind: m[1] as BranchKind, issue: Number(m[2]), slug: m[3] };
}

/** The issue a branch belongs to, or null. The linkage predicate: GitHub's
 *  ref filter is a SUBSTRING match, so `1807` also returns `feature/GH-18070`
 *  and `chore/fix-1807-typo`. This is what rejects them. */
export function branchIssue(branch: string): number | null {
  return parseBranchName(branch)?.issue ?? null;
}

/** Worktree directory leaf for a branch: the branch with `/` → `-`, so
 *  `.claude/worktrees/` reads the same as `git branch`. Legacy branches keep
 *  their historical `GH-N` leaf — an existing worktree must stay findable. */
export function worktreeLeaf(branch: string): string {
  const p = parseBranchName(branch);
  if (p?.kind === "legacy") return `GH-${p.issue}`;
  return branch.replace(/\//g, "-");
}

// ---------------------------------------------------------------------------
// Peer addresses — the third namespace (GH-1918)
//
// A session carries two identities: the grammar-B agent name (`w1918-slug`)
// and the peer address the messaging transport enumerates. The peer namespace
// is HARNESS-owned — ralph cannot derive the whole address, because the trailing
// discriminator is assigned at session start and is unpredictable. What ralph
// owns is the ROOT: measured 2026-08-15, a peer address is the session's working
// directory leaf plus `-<suffix>`, and for a ralph unit that leaf is exactly
// worktreeLeaf(). So holding the issue number is enough to RECOGNISE the
// address, never to construct it — enumeration stays mandatory, but it now has
// a predicate instead of an eyeball.
// ---------------------------------------------------------------------------

/** The harness-assigned discriminator: hyphen-free by observation, and the
 *  whole safety argument. Allowing a hyphen would let the prefix
 *  `feat-1918-one` match `feat-1918-one-session-two-c6` — a different unit's
 *  session, addressed silently. */
export const PEER_SUFFIX_RE = /^[a-z0-9]+$/;

/** The peer-namespace root for a branch. Same string as worktreeLeaf() today,
 *  declared separately because it asserts something else: not "where the
 *  worktree lives" but "what the transport roots the address on". If the
 *  harness ever roots it elsewhere, this moves and worktreeLeaf() does not. */
export function peerPrefix(branch: string): string {
  return worktreeLeaf(branch);
}

export type PeerResolution =
  | { kind: "resolved"; address: string }
  | { kind: "none" }
  | { kind: "ambiguous"; candidates: string[] };

/** Resolve a peer address from the unit's prefixes and the enumerated live
 *  peers. Takes prefixES because a unit can legitimately be running on either
 *  branch grammar — "resume beats re-cut" means a session started on
 *  `feature/GH-N` keeps leaf `GH-N` while this repo derives `feat-N-slug`, and
 *  a single-prefix lookup would call that live session "not running".
 *
 *  Fails closed both ways: no match is `none` ("that session is not running"),
 *  and more than one DISTINCT address is `ambiguous` with every candidate named
 *  — two sessions in one worktree is a real situation, and guessing between
 *  them addresses the wrong one. Repeats of one address are deduped first: a
 *  caller that concatenated two enumerations has one session, not two. Never
 *  returns a bare prefix — an address is only ever a name the transport
 *  actually listed. */
export function resolvePeerAddress(
  prefixes: string | readonly string[],
  candidates: readonly string[],
): PeerResolution {
  const roots = (typeof prefixes === "string" ? [prefixes] : prefixes).filter((p) => p !== "");
  const hits = [
    ...new Set(
      candidates.filter((c) =>
        roots.some((p) => c.startsWith(`${p}-`) && PEER_SUFFIX_RE.test(c.slice(p.length + 1))),
      ),
    ),
  ];
  if (hits.length === 0) return { kind: "none" };
  if (hits.length > 1) return { kind: "ambiguous", candidates: hits };
  return { kind: "resolved", address: hits[0] };
}

// --- durable refs: name#spawn_epoch ---------------------------------------

export interface AgentRef {
  name: string;
  epoch: string;
}

export function formatRef(name: string, epoch: string): string {
  if (parseAgentName(name)?.kind !== "v2") throw new RangeError(`not a grammar-B name: ${name}`);
  if (!EPOCH_RE.test(epoch)) throw new RangeError(`epoch must be 4-8 lowercase hex chars (got ${JSON.stringify(epoch)})`);
  return `${name}#${epoch}`;
}

export function parseRef(ref: string): AgentRef | null {
  const idx = ref.indexOf("#");
  if (idx < 1) return null;
  const name = ref.slice(0, idx);
  const epoch = ref.slice(idx + 1);
  if (parseAgentName(name)?.kind !== "v2") return null;
  if (!EPOCH_RE.test(epoch)) return null;
  return { name, epoch };
}

// ---------------------------------------------------------------------------
// ClaimV2 — wire-compatible with board.ts's single-holder claim
//
// Multi-holder values are RECOGNIZED but never CREATED (GH-1869): nothing
// grows a holder set any more. Readers, doctor checks and the leave path
// still parse, report and shrink values already on the board.
// ---------------------------------------------------------------------------

/** Wire format: "holder1+holder2+...|iso8601". One holder serializes to
 *  exactly today's "{holder}|{iso}" — a v1 reader sees a v2 single-holder
 *  claim unchanged, and a v1-written claim parses here as holders:[h]. */
export interface ClaimV2 {
  holders: string[]; // 1..8, unique, insertion order preserved
  since: Date; // ONE shared timestamp — any member's heartbeat refreshes it
}

export const CLAIM_MAX_HOLDERS = 8;

/** During transition a holder is a grammar-B name OR a legacy name (gh-N,
 *  ralph-deliver, ralph-tend). NOT enforced by the wire parser — today's
 *  boards hold arbitrary "user@host" holders and the board reads them fine;
 *  strictness belongs to producers and lints, never to reads. */
export function isValidHolder(holder: string): boolean {
  return parseAgentName(holder) !== null;
}

/** Lenient by design (parity with board.ts parseClaim): any '+'-free,
 *  non-empty holder tokens before the LAST '|', ISO date after it. Duplicates
 *  dedupe on read; >8 holders or an empty token reads as garbled (null) — the
 *  same fail-closed convention as board.ts's claimRaw-non-null/claim-null. */
export function parseClaim(value: string | null | undefined): ClaimV2 | null {
  if (!value) return null;
  const idx = value.lastIndexOf("|");
  if (idx < 1) return null;
  const since = new Date(value.slice(idx + 1));
  if (Number.isNaN(since.getTime())) return null;
  const raw = value.slice(0, idx).split("+");
  if (raw.some((h) => h === "")) return null;
  const holders = [...new Set(raw)];
  if (holders.length < 1 || holders.length > CLAIM_MAX_HOLDERS) return null;
  return { holders, since };
}

/** The ONE claim wire writer. A holder carrying a wire delimiter would parse
 *  back as a different holder set ("a+b" reads as two members, and neither is
 *  "a+b" — its own writer would then fail the read-back membership verify and
 *  strand the item claimed under names nobody uses), so every write refuses
 *  such holders loudly. Reads stay lenient (parseClaim) — strictness belongs
 *  to producers, never to reads. */
export function formatClaim(claim: ClaimV2): string {
  for (const h of claim.holders)
    if (h === "" || h.includes("+") || h.includes("|"))
      throw new RangeError(`claim holder contains wire delimiters: ${JSON.stringify(h)}`);
  return `${claim.holders.join("+")}|${claim.since.toISOString()}`;
}

export function isMember(claim: ClaimV2, holder: string): boolean {
  return claim.holders.includes(holder);
}

/** Leave: removing the last holder returns null — the caller clears the
 *  field. Removing a non-member is a no-op (idempotent release). */
export function removeHolder(claim: ClaimV2, holder: string): ClaimV2 | null {
  if (!isMember(claim, holder)) return claim;
  const holders = claim.holders.filter((h) => h !== holder);
  if (holders.length === 0) return null;
  return { holders, since: claim.since };
}

/** Any member refreshes the single shared since; a non-member gets null (its
 *  claim to be heartbeating is itself the anomaly). TTL/staleness semantics
 *  are unchanged from v1 — board.ts owns them against this one timestamp. */
export function heartbeat(claim: ClaimV2, holder: string, now: Date): ClaimV2 | null {
  if (!isMember(claim, holder)) return null;
  return { holders: [...claim.holders], since: now };
}

// ---------------------------------------------------------------------------
// Shared schema primitives
// ---------------------------------------------------------------------------

export const HARNESSES = ["claude", "codex", "pi"] as const;
export type Harness = (typeof HARNESSES)[number];
export const INVOKED_BY = ["human", "agent", "scheduler"] as const;

/** THE board state list — the single declaration. Declared here rather than
 *  in board.ts because board.ts imports this file (a reverse import would be
 *  a cycle); board.ts re-exports it as STATES (`STATES = BOARD_STATES`), so
 *  drift between the machine and the C2/C6 schemas is impossible by
 *  construction, not guarded by a test. */
export const BOARD_STATES = [
  "Backlog",
  "In Progress",
  "In Review",
  "Human Needed",
  "Done",
  "Canceled",
] as const;

/** THE deliver-lane reason list (same single-declaration rule): board.ts
 *  derives its DeliverReason type from this tuple. */
export const DELIVER_REASONS = [
  "actionable", // confirmed by a dry-run probe (or probe unavailable)
  "retry", // marker window expired — the session runs the gates itself
  "no-open-pr", // all linked PRs merged/closed — close-out branch (§4.4)
  "settling",
  "no-pr",
  "marker-current",
  "retry-window",
  "deferred",
  "convergence-stalled", // GH-1977: review-convergence.sh says `stalled`/`cap-reached` — held OUT of the queue so an unattended lane stops re-requesting, surfaced as its own blocked row so it never reads as "merged"
  "local-session-active", // GH-1929: a live session on THIS machine holds the GH-1956 worktree lock for this unit — it may be sitting on unpushed local commits, which no remote signal can see. Held OUT of the queue until the lock ages out on RALPH_LOCK_TTL_MIN
] as const;
/** THE tend-lane category list (same single-declaration rule): board.ts
 *  derives its TendCategory type from this tuple. */
export const TEND_CATEGORIES = [
  "proposed", // a PENDING `<!-- ralph-tend:v1 proposed -->` marker on an open OR a closed item (`reopen-as-unevidenced`) — awaiting a human disposition, do not re-propose. Pending = not answered by a `<!-- ralph-tend:v1 resolved -->` marker, and, on a closed item, filed after the close (a close answers a close-as-delivered proposal by outcome)
  "stale-body", // Backlog, no updates in staleDays — grep the live tree before trusting it
  "deps-cleared", // Backlog, every blocker closed — the wait is over (or the edge is stale)
  "deps-truncated", // Backlog, blocker list truncated — the board cannot see its own edges
  "unformed", // no estimate OR no priority, no parent, no deps, older than 7 days — likely raw intake
  "done-audit", // closed recently, no audit marker — the cursor is the marker comment
] as const;

/** Producer schemas are .strict() (refuse unknown keys at the source);
 *  consumer schemas are .passthrough() (ignore unknown keys — additive-only
 *  evolution needs old readers to survive new fields). One factory per
 *  contract builds both so the shapes can never drift apart.
 *  (The zIssue/zLane/… primitives it composes live in loadZod() above —
 *  every build* function below runs only behind loadSchemas().) */
type Mode = "strict" | "loose";
function obj<T extends ZodRawShape>(mode: Mode, shape: T) {
  return mode === "strict" ? z.object(shape).strict() : z.object(shape).passthrough();
}

// ---------------------------------------------------------------------------
// Contracts C1–C9 (C5 is deliberately absent from the locked spec)
// ---------------------------------------------------------------------------

/** The herdr-plane spawn-depth cap: depths 0..DEPTH_MAX, so DEPTH_MAX+1 nested
 *  levels. Spelled ONCE here (C1's field and C8's `depth` token both read it)
 *  and cross-checked against the bash predicate that enforces it —
 *  `ralph_depth_guard` in plugin/ralph-herdr/scripts/lib.sh — by
 *  contracts.test.ts, the naming golden table's shape applied to a number
 *  (GH-1880). Inner-plane subagents are free and never counted. */
export const DEPTH_MAX = 3;

export const CONTRACT_IDS = [
  "ralph.spawn_request",
  "ralph.completion_report",
  "ralph.fleet_brief",
  "ralph.fleet_reply",
  "ralph.board_queue",
  "ralph.lineage",
  "ralph.token_vocabulary",
  "ralph.escalation",
] as const;
export type ContractId = (typeof CONTRACT_IDS)[number];

// --- C1 SpawnRequest -------------------------------------------------------

function buildSpawnRequest(mode: Mode) {
  return obj(mode, {
    contract: z.literal("ralph.spawn_request"),
    contract_version: z.literal(1),
    issue: zIssue,
    lane: zLane,
    slug: z.string().regex(SLUG_RE, "not a valid slug"),
    harness: z.enum(HARNESSES),
    branch: zNonEmpty,
    base: zNonEmpty,
    parent_ref: zAgentRef.optional(),
    depth: z.number().int().min(0).max(DEPTH_MAX),
    invoked_by: z.enum(INVOKED_BY),
  }).superRefine((v, ctx) => {
    // The assembled name must obey the grammar's length cap with the gen
    // suffix still reserved — i.e. the producer already ran truncateSlug.
    if (1 + String(v.issue).length + 1 + v.slug.length > NAME_MAX - GEN_RESERVE)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["slug"],
        message: `slug over budget for issue ${v.issue}: run truncateSlug (name must fit ${NAME_MAX} chars incl. --N reserve)`,
      });
  });
}

// --- C2 CompletionReport ---------------------------------------------------

function buildCompletionReport(mode: Mode) {
  return obj(mode, {
    contract: z.literal("ralph.completion_report"),
    contract_version: z.literal(1),
    agent: zAgentName,
    agent_ref: zAgentRef,
    issue: zIssue,
    outcome: z.enum(["completed", "blocked", "failed", "abandoned"]),
    pr: zIssue.optional(),
    commit_sha: z.string().regex(/^[0-9a-f]{40}$/, "not a 40-char lowercase hex sha").optional(),
    board_state_claimed: z.enum(BOARD_STATES).optional(),
    tests: z.array(z.string()),
    blockers: z.array(z.string()),
    started_at: zIsoUtc,
    finished_at: zIsoUtc,
    lineage: obj(mode, {
      spawned_by: zAgentRef,
      parent_issue: zIssue.optional(),
    }),
  }).superRefine((v, ctx) => {
    if (v.outcome === "completed" && v.pr === undefined)
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["pr"], message: "outcome=completed requires pr" });
    if (v.outcome === "completed" && v.commit_sha === undefined)
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["commit_sha"], message: "outcome=completed requires commit_sha" });
    if (v.outcome === "blocked" && v.blockers.length === 0)
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["blockers"], message: "outcome=blocked requires at least one blocker" });
    if (Date.parse(v.finished_at) < Date.parse(v.started_at))
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["finished_at"], message: "finished_at must be >= started_at" });
  });
}

// --- C3 FleetBrief ---------------------------------------------------------

/** Skill invocation a brief for (lane, issue) must carry, when the lane has a
 *  known skill mapping; null = free-form (any nonempty invocation is legal). */
export function expectedSkillInvocation(lane: Lane, issue: number): string | null {
  return lane === "w" ? `/ralph:work ${issue}` : null;
}

function buildFleetBrief(mode: Mode) {
  return obj(mode, {
    contract: z.literal("ralph.fleet_brief"),
    contract_version: z.literal(1),
    issue: zIssue,
    role: zLane,
    skill_invocation: zNonEmpty,
    reply_to: obj(mode, {
      kind: z.literal("herdr_agent"),
      name: zAgentName,
    }),
    report_path: zNonEmpty,
    constraints: obj(mode, {
      branch: zNonEmpty,
      base: zNonEmpty,
      no_force: z.literal(true),
    }),
    deadline: zIsoUtc.optional(),
  }).superRefine((v, ctx) => {
    const want = expectedSkillInvocation(v.role, v.issue);
    if (want !== null && v.skill_invocation !== want)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["skill_invocation"],
        message: `lane ${v.role} for issue ${v.issue} must invoke ${JSON.stringify(want)}`,
      });
  });
}

// --- C4 FleetReply ---------------------------------------------------------

function zOption(mode: Mode) {
  return obj(mode, {
    id: zNonEmpty,
    label: zNonEmpty,
    recommended: z.boolean().optional(),
  });
}

function buildFleetReply(mode: Mode) {
  return obj(mode, {
    contract: z.literal("ralph.fleet_reply"),
    contract_version: z.literal(1),
    agent_ref: zAgentRef,
    issue: zIssue,
    kind: z.enum(["progress", "blocked", "done", "question"]),
    body: z.string().max(2000),
    options: z.array(zOption(mode)).optional(),
  }).superRefine((v, ctx) => {
    if (v.kind !== "question") return;
    const opts = v.options ?? [];
    if (opts.length === 0)
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["options"], message: "kind=question requires options" });
    else if (opts.filter((o) => o.recommended === true).length !== 1)
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["options"], message: "kind=question requires exactly one recommended option" });
  });
}

// --- C6 BoardQueue ---------------------------------------------------------
// TODAY's real shapes of `board next|deliver-queue|tend-queue --json`,
// declared field-for-field from board.ts (QueueItem / DeliverRow / TendRow +
// the EmptyQueueReport spread `next` adds). Do not "improve" these here —
// board.ts is the producer; this contract only names what it already emits.
// Parity is EXECUTABLE, not prose: contracts.test.ts drives the real CLI
// (run(["next"|"deliver-queue"|"tend-queue","--json"]) over FakeGh) and
// validates the captured output against these schemas.
// NOTE on the envelope: board.ts emits the BARE result object today — the
// {contract, contract_version, selector, result} wrapper is added by the
// consumer that ships a queue snapshot across a boundary (the Phase-2
// watcher). Nothing produces the envelope yet; the schema exists so that
// consumer has a contract to meet on day one.

function zClaimJson(mode: Mode) {
  // board.ts Claim (= ClaimV2) JSON-serialized: Date → ISO string, holders
  // 1..8 in insertion order (one shared since — see the ClaimV2 section).
  return obj(mode, {
    holders: z.array(zNonEmpty).min(1).max(CLAIM_MAX_HOLDERS),
    since: zIsoUtc,
  });
}

function zQueueItem(mode: Mode) {
  return obj(mode, {
    number: zIssue,
    repo: zNonEmpty, // nameWithOwner — the board is cross-repo capable
    title: z.string(),
    state: z.string(), // string, not enum: legacy v1 options still exist on the field
    priority: z.string().nullable(),
    hasParent: z.boolean(),
    parentNumber: z.number().int().nullable(),
    via: z.number().int().optional(),
    childrenBlocked: z.array(z.number().int()).optional(),
    openBlockers: z.array(z.number().int()),
    blockersTruncated: z.boolean(),
    fieldValuesTruncated: z.boolean(),
    claim: zClaimJson(mode).nullable(),
    claimRaw: z.string().nullable(),
    openBlockerLabels: z.array(z.string()),
    // GH-1803: `next` runs the lean walk (no `labels` connection — 1 GraphQL
    // point per page saved), so both label fields are ABSENT from its rows.
    // Optional, never nullable and never defaulted: a consumer must be able to
    // tell "this read did not fetch labels" from "this issue has none", and
    // `labelsTruncated` is a fail-closed flag no unfetched read may assert.
    labels: z.array(z.string()).optional(),
    labelsTruncated: z.boolean().optional(),
    closedBlockers: z.array(z.number().int()),
    updatedAt: zIsoUtc.nullable().optional(),
    createdAt: zIsoUtc.nullable().optional(),
    estimate: z.string().nullable().optional(),
  });
}

function zNextResult(mode: Mode) {
  return obj(mode, {
    next: zQueueItem(mode).nullable(),
    queue: z.array(zQueueItem(mode)),
    blocked: z.array(zQueueItem(mode)),
    diagnosis: z.enum(["no-items", "human-needed", "epic-in-flight", "stale-blocked"]).nullable(),
    humanNeededCount: z.number().int().min(0),
    staleBlockedEdges: z.array(obj(mode, { number: zIssue, blockers: z.array(z.number().int()) })),
    inFlightEpics: z.array(obj(mode, { root: zIssue, child: zIssue, holder: z.string().nullable() })),
    cache: zCacheFacts(mode).optional(),
  });
}

/** Item-cache staleness facts (GH-1806). OPTIONAL wherever it appears, in both
 *  modes: a payload produced before the cache existed, or by a `--fresh` run,
 *  is still valid — and a strict producer that passes a selector's `--json`
 *  through verbatim must not start failing because the read was answered from
 *  disk. */
function zCacheFacts(mode: Mode) {
  return obj(mode, {
    cached: z.boolean(),
    fetchedAt: zIsoUtc,
    ageSec: z.number().int().min(0),
  });
}

function zDeliverRow(mode: Mode) {
  return obj(mode, {
    number: zIssue,
    title: z.string(),
    pr: z.number().int().nullable(),
    reason: z.enum(DELIVER_REASONS),
    verdict: z.string().nullable().optional(),
    gate: z.string().nullable().optional(),
    deltaAt: zIsoUtc.nullable().optional(),
    windowExpiresAt: zIsoUtc.nullable().optional(),
    // GH-1977 — present only on `convergence-stalled` rows.
    convergence: z.string().nullable().optional(),
    detail: z.string().nullable().optional(),
  });
}

function zDeliverResult(mode: Mode) {
  return obj(mode, {
    next: zDeliverRow(mode).nullable(),
    queue: z.array(zDeliverRow(mode)),
    blocked: z.array(zDeliverRow(mode)),
  });
}

function zTendRow(mode: Mode) {
  return obj(mode, {
    number: zIssue,
    title: z.string(),
    category: z.enum(TEND_CATEGORIES),
    at: zIsoUtc.nullable(),
  });
}

function zTendResult(mode: Mode) {
  return obj(mode, {
    next: zTendRow(mode).nullable(),
    queue: z.array(zTendRow(mode)),
    blocked: z.array(zTendRow(mode)), // shape parity — tend blocks nothing
    observationSlot: z.literal(true),
  });
}

// GH-1880 — `board frontier --json`. The one herdr-facing wire shape (its help
// text names ralph-herdr fleets as the consumer) that had no contract at all:
// it lived on `tsc` and behavioural tests, so a fleet-side consumer had nothing
// to validate against. Declared field-for-field from board.ts's FrontierItem /
// FrontierBlockedItem / FrontierResult; the CLI parity test below drives the
// real selector, so a rename fails the same day.
function zFrontierItem(mode: Mode) {
  return obj(mode, {
    number: zIssue,
    title: z.string(),
    // Emitted only when present — board.ts spreads these conditionally, and
    // "absent" is the honest encoding of "no own-repo parent / not under an
    // epic", which `null` would blur.
    parentNumber: z.number().int().optional(),
    via: z.number().int().optional(),
    childrenBlocked: z.array(z.number().int()).optional(),
    blockers: z.array(obj(mode, { number: z.number().int(), state: z.enum(["OPEN", "CLOSED"]) })),
    eligible: z.literal(true),
  });
}

function zFrontierBlockedRow(mode: Mode) {
  return obj(mode, {
    number: zIssue,
    blockers_open: z.array(z.number().int()),
    // Present only as `true`: a truncated read is the fail-closed assertion,
    // and `false` would let a reader that never checked look like one that did.
    truncated: z.literal(true).optional(),
  });
}

function zFrontierResult(mode: Mode) {
  return obj(mode, {
    frontier: z.array(zFrontierItem(mode)),
    blocked: z.array(zFrontierBlockedRow(mode)),
    cache: zCacheFacts(mode).optional(),
  });
}

function buildBoardQueue(mode: Mode) {
  const head = {
    contract: z.literal("ralph.board_queue"),
    contract_version: z.literal(1),
  };
  return z
    .discriminatedUnion("selector", [
      obj(mode, { ...head, selector: z.literal("next"), result: zNextResult(mode) }),
      obj(mode, { ...head, selector: z.literal("deliver-queue"), result: zDeliverResult(mode) }),
      obj(mode, { ...head, selector: z.literal("tend-queue"), result: zTendResult(mode) }),
      obj(mode, { ...head, selector: z.literal("frontier"), result: zFrontierResult(mode) }),
    ])
    .superRefine((v, ctx) => {
      // frontier is a re-projection, not a ranked queue: it has no `next`
      // head, so the queue-integrity rules below do not apply to it. Its own
      // invariants — one row per issue, and eligibility MEANING every listed
      // blocker is closed — are checked here instead.
      if (v.selector === "frontier") {
        const f = v.result as { frontier: Array<{ number: number; blockers: Array<{ state: string }> }>; blocked: Array<{ number: number }> };
        const nums = f.frontier.map((i) => i.number);
        if (new Set(nums).size !== nums.length)
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["result", "frontier"],
            message: "frontier numbers must be unique",
          });
        const blockedNums = new Set(f.blocked.map((b) => b.number));
        for (const n of nums)
          if (blockedNums.has(n))
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["result", "frontier"],
              message: `issue ${n} is both eligible and blocked`,
            });
        f.frontier.forEach((i, idx) => {
          if (i.blockers.some((b) => b.state === "OPEN"))
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["result", "frontier", idx, "blockers"],
              message: "an eligible frontier item may not carry an OPEN blocker",
            });
        });
        return;
      }
      const r = v.result as { next: unknown; queue: Array<{ number: number }> };
      if (r.next !== null && r.queue.length > 0 && JSON.stringify(r.next) !== JSON.stringify(r.queue[0]))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["result", "next"],
          message: "next must deep-equal queue[0] when both present",
        });
      if (new Set(r.queue.map((q) => q.number)).size !== r.queue.length)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["result", "queue"],
          message: "queue numbers must be unique",
        });
    });
}

// --- C7 LineageRecord ------------------------------------------------------

function buildLineageRecord(mode: Mode) {
  return obj(mode, {
    contract: z.literal("ralph.lineage"),
    contract_version: z.literal(1),
    agent_ref: zAgentRef,
    issue: zIssue,
    parent_issue: zIssue.optional(),
    /** GH-1808 — required of a PRODUCER (strict), optional for a CONSUMER
     *  (loose), because every record written before this field existed is
     *  still a valid record and a reader that refused them would lose the
     *  history the ledger exists to keep. */
    role:
      mode === "strict"
        ? z.enum(ROLE_NAMES as [Role, ...Role[]])
        : z.enum(ROLE_NAMES as [Role, ...Role[]]).optional(),
    spawner: obj(mode, {
      script: zNonEmpty,
      invoked_by: z.enum(INVOKED_BY),
    }),
    herdr: obj(mode, {
      session: z.string().optional(),
      /** pane_id is OPAQUE and server-scoped: it names a live pane on one
       *  herdr server instance and dies with it. It is NEVER a durable key —
       *  agent_ref (name#spawn_epoch) is the durable identity. */
      pane_id: z.string().optional(),
      worktree_branch: z.string().optional(),
      workspace_label: z.string().optional(),
    }),
    plane: z.enum(["herdr", "inner"]),
    spawned_at: zIsoUtc,
  });
}

// --- C8 TokenVocabulary ----------------------------------------------------

export const TOKEN_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
export const TOKEN_VALUE_MAX = 80;

export const AGENT_STATES = [
  "spawned",
  "briefed",
  "working",
  "blocked",
  "reporting",
  // GH-1907 — terminal-turn VERDICTS, written by the watcher rather than by the
  // session, because the session that needs them most is the one that died. A
  // herdr `done` is a turn boundary: an outage that kills a session mid-response
  // ends its turn exactly as a delivery does, and the pre-1907 token then kept
  // its last value, so an outage-killed pair read `done … spawned` — identical
  // to a finished one, over worktrees full of uncommitted work.
  //
  // `interrupted` is positive evidence of unfinished work (a dirty checkout).
  // `indeterminate` is the honest refusal: nothing separates "finished but never
  // reported" from "killed before it could report". Neither is a completion
  // claim — only `reporting` is, and only a live session can write it. A caller
  // deciding whether to retire a workspace may act on `reporting` alone.
  "interrupted",
  "indeterminate",
  "orphaned",
  "adopted",
] as const;
export type AgentState = (typeof AGENT_STATES)[number];

export interface TokenSpec {
  doc: string;
  /** Cheap per-value validator; free-form tokens only get the shared ≤80 cap. */
  validate: (value: string) => boolean;
}

const freeForm = (doc: string): TokenSpec => ({ doc, validate: () => true });

/** The token vocabulary — tokens are ATTRIBUTES; the name is identity. */
export const TOKENS = {
  // GH-1808: role is the FLEET role, not the lane letter it used to hold. The
  // lane is the agent name's first char and was therefore already derivable
  // from agent_ref; the role is not derivable from anything, because it is a
  // spawn-time decision about who may write the tree.
  role: { doc: "fleet role from the ROLES registry", validate: (v) => v in ROLES },
  issue: { doc: "board issue number (0 = infra)", validate: (v) => /^(0|[1-9][0-9]*)$/.test(v) },
  slug: { doc: "the name's slug part", validate: (v) => SLUG_RE.test(v) },
  parent: freeForm("parent agent name or durable ref"),
  root: freeForm("root of this agent's spawn tree"),
  depth: {
    doc: "herdr-plane spawn depth (inner subagents are free)",
    validate: (v) => /^[0-9]+$/.test(v) && Number(v) <= DEPTH_MAX,
  },
  state: {
    doc: "agent lifecycle state",
    validate: (v) => (AGENT_STATES as readonly string[]).includes(v),
  },
  branch: freeForm("git branch the agent works on"),
  claim: freeForm("board claim summary for the cockpit"),
  pr: { doc: "pull request number", validate: (v) => /^[1-9][0-9]*$/.test(v) },
  spawn_epoch: { doc: "durable-ref epoch (4-8 lowercase hex)", validate: (v) => EPOCH_RE.test(v) },
  harness: {
    doc: "which coding agent runs in the pane — metadata, NEVER in the name",
    validate: (v) => (HARNESSES as readonly string[]).includes(v),
  },
  inner: { doc: "count of inner-plane subagents", validate: (v) => /^(0|[1-9][0-9]*)$/.test(v) },
  fresh: freeForm("freshness marker for the cockpit"),
} as const satisfies Record<string, TokenSpec>;
export type TokenName = keyof typeof TOKENS;
export const TOKEN_NAMES = Object.keys(TOKENS) as TokenName[];

function buildTokenVocabulary(mode: Mode) {
  return obj(mode, {
    contract: z.literal("ralph.token_vocabulary"),
    contract_version: z.literal(1),
    tokens: z.record(z.string().regex(TOKEN_NAME_RE), z.string().max(TOKEN_VALUE_MAX)),
  }).superRefine((v, ctx) => {
    for (const [name, value] of Object.entries(v.tokens)) {
      const spec = (TOKENS as Record<string, TokenSpec>)[name];
      if (!spec) {
        // Producers stay inside the vocabulary; consumers ignore strangers.
        if (mode === "strict")
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["tokens", name],
            message: `unknown token name ${JSON.stringify(name)} (vocabulary: ${TOKEN_NAMES.join(", ")})`,
          });
        continue;
      }
      if (!spec.validate(value))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["tokens", name],
          message: `invalid value for token ${name}: ${JSON.stringify(value)} (${spec.doc})`,
        });
    }
  });
}

// --- C9 EscalationPayload --------------------------------------------------
// Phone-answerable by construction: short single-line body, ≥2 enumerated
// options with exactly one recommended default, and a machine-actionable
// resume path — a human taps a choice; nothing needs a keyboard.

function buildEscalationPayload(mode: Mode) {
  return obj(mode, {
    contract: z.literal("ralph.escalation"),
    contract_version: z.literal(1),
    agent: zAgentName.optional(),
    issue: zIssue,
    title: z.string().min(1).max(80),
    body: z
      .string()
      .min(1)
      .max(240)
      .refine((b) => !/[\r\n]/.test(b), { message: "body must be a single line" }),
    options: z.array(zOption(mode)).min(2),
    resume: obj(mode, {
      kind: z.enum(["herdr_prompt", "board_comment"]),
      target: zNonEmpty,
    }),
  }).superRefine((v, ctx) => {
    if (v.options.filter((o) => o.recommended === true).length !== 1)
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["options"], message: "exactly one option must be recommended" });
  });
}

// --- lazy schema registry --------------------------------------------------

export interface ContractEntry {
  /** Producer-side: .strict() everywhere — unknown keys refuse to serialize. */
  strict: ZodTypeAny;
  /** Consumer-side: .passthrough() everywhere — unknown keys ride along. */
  loose: ZodTypeAny;
}

/** Built on first use (see the lazy-zod note at the top of this file) —
 *  importing this module must stay free of any zod dependency at runtime. */
let CONTRACTS: Record<ContractId, ContractEntry> | null = null;

function loadSchemas(): Record<ContractId, ContractEntry> {
  if (CONTRACTS) return CONTRACTS;
  loadZod();
  CONTRACTS = {
    "ralph.spawn_request": { strict: buildSpawnRequest("strict"), loose: buildSpawnRequest("loose") },
    "ralph.completion_report": { strict: buildCompletionReport("strict"), loose: buildCompletionReport("loose") },
    "ralph.fleet_brief": { strict: buildFleetBrief("strict"), loose: buildFleetBrief("loose") },
    "ralph.fleet_reply": { strict: buildFleetReply("strict"), loose: buildFleetReply("loose") },
    "ralph.board_queue": { strict: buildBoardQueue("strict"), loose: buildBoardQueue("loose") },
    "ralph.lineage": { strict: buildLineageRecord("strict"), loose: buildLineageRecord("loose") },
    "ralph.token_vocabulary": { strict: buildTokenVocabulary("strict"), loose: buildTokenVocabulary("loose") },
    "ralph.escalation": { strict: buildEscalationPayload("strict"), loose: buildEscalationPayload("loose") },
  };
  return CONTRACTS;
}

export function isContractId(id: string): id is ContractId {
  return (CONTRACT_IDS as readonly string[]).includes(id);
}

export function validateContract(
  id: ContractId,
  data: unknown,
  opts: { loose?: boolean } = {},
): SafeParseReturnType<unknown, unknown> {
  const entry = loadSchemas()[id];
  return (opts.loose ? entry.loose : entry.strict).safeParse(data);
}

// ---------------------------------------------------------------------------
// Lints L1–L13
// ---------------------------------------------------------------------------
// Static lints run on any payload and answer "not applicable" (skipped) when
// the payload lacks the fields they judge. L3/L5/L7 are LIVE lints: they take
// the same payload plus an optional LiveLintDeps of injected effect functions
// (git probe, board read-back) and skip with "requires --live" when no deps
// arrive — so this file stays dependency-free and the caller (board.ts under
// `contract lint --live`) is the only place that touches git or the network.
// L10 (lineage closure) needs the herdr ledger, which no TS surface reads —
// it stays a named stub here and is implemented bash-side.

export const LINT_IDS = [
  "L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8", "L9", "L10", "L11", "L12", "L13",
] as const;
export type LintId = (typeof LINT_IDS)[number];
export const LIVE_LINT_IDS: readonly LintId[] = ["L3", "L5", "L7", "L10"];

export type LintResult =
  | { rule: LintId; ok: true; note?: string }
  | { rule: LintId; ok: false; message: string }
  | { rule: LintId; skipped: string };

type Dict = Record<string, unknown>;
const isDict = (v: unknown): v is Dict => typeof v === "object" && v !== null && !Array.isArray(v);
const notApplicable = (rule: LintId, why: string): LintResult => ({ rule, skipped: `not applicable — ${why}` });

/** The projection of board.ts's Issue the live lints judge — declared here
 *  rather than imported because board.ts imports THIS file (a reverse import
 *  would be a cycle). board.ts's liveLintDeps() narrows its Issue to this. */
export interface BoardItemView {
  issueState: "OPEN" | "CLOSED";
  /** Workflow State field value (board truth; null = no state / not on board). */
  state: string | null;
  claim: ClaimV2 | null;
}

/** Effect functions the LIVE lints (L3/L5/L7) run through. Injected by the
 *  caller — board.ts builds them only under `contract lint --live`, so a
 *  plain lint run stays repo- and network-free. An absent deps object (or an
 *  absent individual function) makes the lint report skipped, never guess. */
export interface LiveLintDeps {
  /** Run `git <args>` against the working repo; only the exit code is judged. */
  execGit?: (args: string[]) => { code: number };
  /** One issue by number; null = the issue does not exist. */
  readBoardItem?: (issue: number) => BoardItemView | null;
}

/** L2's shared source rule: the payload's agent name, from `agent` or the
 *  name half of `agent_ref`. */
function agentNameOf(payload: Dict): string | null {
  if (typeof payload.agent === "string") return payload.agent;
  if (typeof payload.agent_ref === "string") return payload.agent_ref.split("#")[0];
  return null;
}

/** L1: a brief's reply_to must be a routable herdr agent. */
export function lintL1ReplyToShape(payload: unknown): LintResult {
  const rule: LintId = "L1";
  if (!isDict(payload) || !("reply_to" in payload)) return notApplicable(rule, "no reply_to");
  const rt = payload.reply_to;
  if (!isDict(rt)) return { rule, ok: false, message: "reply_to must be an object" };
  if (rt.kind !== "herdr_agent")
    return { rule, ok: false, message: `reply_to.kind must be "herdr_agent" (got ${JSON.stringify(rt.kind)})` };
  if (typeof rt.name !== "string" || parseAgentName(rt.name)?.kind !== "v2")
    return { rule, ok: false, message: `reply_to.name is not a grammar-B agent name: ${JSON.stringify(rt.name)}` };
  return { rule, ok: true };
}

/** L2: the agent name parses, and the issue baked into the name matches the
 *  payload's issue — a w1743 pane reporting on issue 1800 is lying somewhere. */
export function lintL2AgentNameIssue(payload: unknown): LintResult {
  const rule: LintId = "L2";
  if (!isDict(payload)) return notApplicable(rule, "not an object");
  const source = agentNameOf(payload);
  if (source === null) return notApplicable(rule, "no agent / agent_ref");
  const parsed = parseAgentName(source);
  if (parsed === null) return { rule, ok: false, message: `agent name does not parse: ${JSON.stringify(source)}` };
  if (typeof payload.issue === "number" && parsed.issue !== null && parsed.issue !== payload.issue)
    return { rule, ok: false, message: `name says issue ${parsed.issue}, payload says issue ${payload.issue}` };
  return { rule, ok: true };
}

/** L3 (LIVE): a reported commit_sha must exist in the repo — an agent
 *  reporting a sha `git cat-file` has never seen is reporting fiction. */
export function lintL3CommitInRepo(payload: unknown, deps?: LiveLintDeps): LintResult {
  const rule: LintId = "L3";
  const execGit = deps?.execGit;
  if (!execGit) return { rule, skipped: "requires --live" };
  if (!isDict(payload) || !("commit_sha" in payload)) return notApplicable(rule, "no commit_sha");
  const sha = payload.commit_sha;
  // Shape-gate before shelling out: a non-sha value must never reach a git
  // argv (L4 owns the shape complaint; L3 refuses to probe with garbage).
  if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha))
    return {
      rule,
      ok: false,
      message: `commit_sha is not a 40-char lowercase hex sha — refusing to probe the repo with ${JSON.stringify(sha)}`,
    };
  if (execGit(["cat-file", "-e", `${sha}^{commit}`]).code !== 0)
    return { rule, ok: false, message: `commit_sha ${sha} is not a commit in this repo` };
  return { rule, ok: true };
}

/** L4: outcome–evidence coherence on completion reports (schema-independent,
 *  so it also catches loose-parsed payloads a consumer accepted). */
export function lintL4OutcomeEvidence(payload: unknown): LintResult {
  const rule: LintId = "L4";
  if (!isDict(payload) || typeof payload.outcome !== "string") return notApplicable(rule, "no outcome");
  const problems: string[] = [];
  if (payload.outcome === "completed") {
    if (typeof payload.pr !== "number") problems.push("completed without pr");
    if (typeof payload.commit_sha !== "string" || !/^[0-9a-f]{40}$/.test(payload.commit_sha))
      problems.push("completed without a valid commit_sha");
  }
  if (payload.outcome === "blocked" && (!Array.isArray(payload.blockers) || payload.blockers.length === 0))
    problems.push("blocked without blockers");
  if (problems.length) return { rule, ok: false, message: problems.join("; ") };
  return { rule, ok: true };
}

/** L5 (LIVE): claim read-back — the payload's agent must be a live holder of
 *  the claim on the payload's issue. Membership is what a lying reporter
 *  fakes first; TTL/staleness semantics stay board.ts's job (it owns time
 *  against the one shared since). Fails closed: an unreadable or absent
 *  issue is a finding, not a pass. */
export function lintL5ClaimReadback(payload: unknown, deps?: LiveLintDeps): LintResult {
  const rule: LintId = "L5";
  const readBoardItem = deps?.readBoardItem;
  if (!readBoardItem) return { rule, skipped: "requires --live" };
  if (!isDict(payload)) return notApplicable(rule, "not an object");
  const agent = agentNameOf(payload);
  if (agent === null || typeof payload.issue !== "number")
    return notApplicable(rule, "no agent + issue");
  const item = readBoardItem(payload.issue);
  if (item === null)
    return { rule, ok: false, message: `issue #${payload.issue} does not exist — no claim to read back` };
  if (item.claim === null)
    return { rule, ok: false, message: `issue #${payload.issue} carries no claim — ${agent} does not hold it` };
  if (!item.claim.holders.includes(agent))
    return {
      rule,
      ok: false,
      message: `claim on #${payload.issue} is held by ${item.claim.holders.join("+")} — ${agent} is not a member`,
    };
  return { rule, ok: true };
}

/** L6: contract_version must be KNOWN. A higher version is refused loudly —
 *  guessing at a future wire format is how silent corruption starts. */
export function lintL6ContractVersion(payload: unknown): LintResult {
  const rule: LintId = "L6";
  if (!isDict(payload) || !("contract_version" in payload)) return notApplicable(rule, "no contract_version");
  const v = payload.contract_version;
  if (v === 1) return { rule, ok: true };
  if (typeof v === "number" && Number.isInteger(v) && v > 1)
    return {
      rule,
      ok: false,
      message: `REFUSING contract_version ${v}: this validator knows only version 1 — upgrade before trusting this payload`,
    };
  return { rule, ok: false, message: `contract_version must be the integer 1 (got ${JSON.stringify(v)})` };
}

/** L7 (LIVE): no orphan parent ref — a declared parent_issue (top-level, C7;
 *  or under lineage, C2) must exist and still be open work. Fails closed: a
 *  parent the board cannot resolve IS the orphan ref this rule exists for. */
export function lintL7ParentOpen(payload: unknown, deps?: LiveLintDeps): LintResult {
  const rule: LintId = "L7";
  const readBoardItem = deps?.readBoardItem;
  if (!readBoardItem) return { rule, skipped: "requires --live" };
  const parent =
    isDict(payload) && typeof payload.parent_issue === "number" ? payload.parent_issue
    : isDict(payload) && isDict(payload.lineage) && typeof payload.lineage.parent_issue === "number"
      ? payload.lineage.parent_issue
      : null;
  if (parent === null) return notApplicable(rule, "no parent_issue");
  const item = readBoardItem(parent);
  if (item === null)
    return { rule, ok: false, message: `parent_issue #${parent} does not exist — an orphan parent ref` };
  if (item.state === "Done" || item.state === "Canceled")
    return { rule, ok: false, message: `parent #${parent} is ${item.state} — closed work cannot parent new work` };
  if (item.issueState === "CLOSED")
    return {
      rule,
      ok: false,
      message: `parent #${parent} is closed on GitHub — reconcile will move it to Done/Canceled`,
    };
  return { rule, ok: true };
}

/** L8: the working branch is derived, not chosen — `<kind>/<issue>-<slug>`
 *  (GH-1807), or the legacy `feature/GH-<issue>` for the deprecation window.
 *  The SLUG is not checked: this lint has the issue number, not the title, and
 *  a rule that cannot recompute the expected value must not pretend to. What
 *  it does enforce is that the branch parses and names THIS issue — the same
 *  predicate the PR linkage runs. */
export function lintL8BranchConvention(payload: unknown): LintResult {
  const rule: LintId = "L8";
  if (!isDict(payload) || typeof payload.issue !== "number") return notApplicable(rule, "no issue");
  const branch =
    typeof payload.branch === "string" ? payload.branch
    : isDict(payload.constraints) && typeof payload.constraints.branch === "string" ? payload.constraints.branch
    : null;
  if (branch === null) return notApplicable(rule, "no branch");
  const shapes = `<kind>/${payload.issue}-<slug>` + ` (kind: ${BRANCH_KIND_CHARS.join("|")})` +
    ` or the legacy "feature/GH-${payload.issue}"`;
  const parsed = parseBranchName(branch);
  if (parsed === null)
    return { rule, ok: false, message: `branch ${JSON.stringify(branch)} matches neither shape — expected ${shapes}` };
  if (parsed.issue !== payload.issue)
    return {
      rule,
      ok: false,
      message: `branch ${JSON.stringify(branch)} names issue #${parsed.issue}, not #${payload.issue} — expected ${shapes}`,
    };
  return { rule, ok: true };
}

/** L9: queue-rank integrity — next deep-equals queue[0] when both present,
 *  queue numbers unique. Accepts a C6 envelope or a bare result object. */
export function lintL9QueueRank(payload: unknown): LintResult {
  const rule: LintId = "L9";
  const r = isDict(payload) && isDict(payload.result) ? payload.result : payload;
  if (!isDict(r) || !Array.isArray(r.queue) || !("next" in r)) return notApplicable(rule, "no next/queue");
  if (r.next !== null && r.queue.length > 0 && JSON.stringify(r.next) !== JSON.stringify(r.queue[0]))
    return { rule, ok: false, message: "next does not deep-equal queue[0]" };
  const nums = r.queue.filter(isDict).map((q) => q.number);
  if (new Set(nums).size !== nums.length) return { rule, ok: false, message: "queue numbers are not unique" };
  return { rule, ok: true };
}

/** L10 (LIVE, ledger-side): lineage closure — every live agent ↔ exactly one
 *  open ledger record. Needs herdr and ~/.ralph/<owner>-<repo>/ledger.jsonl,
 *  which no TS surface reads; the rule is implemented bash-side. The stub
 *  keeps the rule id stable and points at the real implementation. */
export function lintL10Live(_payload: unknown, _deps?: LiveLintDeps): LintResult {
  return {
    rule: "L10",
    skipped: "requires --live ledger access — implemented by plugin/ralph-herdr/scripts/doctor-lineage.sh",
  };
}

/** L11: an escalation's resume path must be machine-actionable — a target the
 *  resuming side can act on without a human decoding free text. */
export function lintL11EscalationResume(payload: unknown): LintResult {
  const rule: LintId = "L11";
  if (!isDict(payload) || !("resume" in payload)) return notApplicable(rule, "no resume");
  const r = payload.resume;
  if (!isDict(r)) return { rule, ok: false, message: "resume must be an object" };
  const target = typeof r.target === "string" ? r.target : "";
  if (r.kind === "herdr_prompt") {
    if (parseAgentName(target)?.kind !== "v2" && parseRef(target) === null)
      return { rule, ok: false, message: `herdr_prompt target must be an agent name or ref (got ${JSON.stringify(r.target)})` };
    return { rule, ok: true };
  }
  if (r.kind === "board_comment") {
    if (!/^#?[0-9]+$/.test(target) && !/^https:\/\/[^\s]+\/issues\/[0-9]+([#?].*)?$/.test(target))
      return { rule, ok: false, message: `board_comment target must be an issue number or issue URL (got ${JSON.stringify(r.target)})` };
    return { rule, ok: true };
  }
  return { rule, ok: false, message: `resume.kind must be herdr_prompt|board_comment (got ${JSON.stringify(r.kind)})` };
}

/** L12: no-secret-leak — a contract payload travels through comments, ledgers
 *  and phone notifications; a credential anywhere in it is an incident. */
export const SECRET_RE = /sk-ant-|ANTHROPIC_API_KEY\s*=|ghp_[A-Za-z0-9]/;
export function lintL12NoSecretLeak(payload: unknown): LintResult {
  const rule: LintId = "L12";
  let text: string;
  try {
    text = JSON.stringify(payload) ?? "";
  } catch {
    return { rule, ok: false, message: "payload is not JSON-serializable — cannot prove it leaks no secret" };
  }
  if (SECRET_RE.test(text)) return { rule, ok: false, message: "payload matches a secret pattern (sk-ant-/ANTHROPIC_API_KEY=/ghp_)" };
  return { rule, ok: true };
}

/** L13: timestamps are UTC-Z ISO strings and internally ordered
 *  (finished_at ≥ started_at wherever both appear). Deadline-in-the-future is
 *  deliberately NOT checked — no clock injection here; ordering only. */
export function lintL13Timestamps(payload: unknown): LintResult {
  const rule: LintId = "L13";
  const TS_KEY = /(_at$|^deadline$|^since$|^at$)/;
  const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
  const bad: string[] = [];
  let sawAny = false;
  const walk = (v: unknown, path: string): void => {
    if (Array.isArray(v)) {
      v.forEach((e, i) => walk(e, `${path}[${i}].`));
      return;
    }
    if (!isDict(v)) return;
    for (const [k, val] of Object.entries(v)) {
      if (TS_KEY.test(k) && typeof val === "string") {
        sawAny = true;
        if (!ISO_Z.test(val) || Number.isNaN(Date.parse(val))) bad.push(`${path}${k} not UTC-Z ISO: ${JSON.stringify(val)}`);
      }
      walk(val, `${path}${k}.`);
    }
    const s = v.started_at;
    const f = v.finished_at;
    if (typeof s === "string" && typeof f === "string" && ISO_Z.test(s) && ISO_Z.test(f) && Date.parse(f) < Date.parse(s))
      bad.push(`${path}finished_at precedes started_at`);
  };
  walk(payload, "");
  if (!sawAny) return notApplicable(rule, "no timestamp fields");
  if (bad.length) return { rule, ok: false, message: bad.join("; ") };
  return { rule, ok: true, note: "deadline future-at-emit deliberately unchecked (no clock injection)" };
}

export const LINTS: Record<LintId, (payload: unknown, deps?: LiveLintDeps) => LintResult> = {
  L1: lintL1ReplyToShape,
  L2: lintL2AgentNameIssue,
  L3: lintL3CommitInRepo,
  L4: lintL4OutcomeEvidence,
  L5: lintL5ClaimReadback,
  L6: lintL6ContractVersion,
  L7: lintL7ParentOpen,
  L8: lintL8BranchConvention,
  L9: lintL9QueueRank,
  L10: lintL10Live,
  L11: lintL11EscalationResume,
  L12: lintL12NoSecretLeak,
  L13: lintL13Timestamps,
};

/** Run every lint against one payload, in rule order. Live deps (when given)
 *  reach only the rules that declare them; static rules ignore the argument. */
export function runLints(payload: unknown, deps?: LiveLintDeps): LintResult[] {
  return LINT_IDS.map((id) => LINTS[id](payload, deps));
}

// ---------------------------------------------------------------------------
// JSON Schema emission (D5: zod-to-json-schema; artifacts land via
// `board contract emit` and are drift-checked in CI)
// ---------------------------------------------------------------------------

/** One self-contained JSON Schema per contract, from the STRICT (producer)
 *  variant — external validators should hold producers to the producer bar.
 *  Note: Zod refinements (outcome coherence, queue integrity, …) have no JSON
 *  Schema equivalent and are emitted as the input shape only; the lints and
 *  the Zod schemas remain the full truth. */
export function emitJsonSchemas(): Record<ContractId, Record<string, unknown>> {
  const contracts = loadSchemas();
  const out = {} as Record<ContractId, Record<string, unknown>>;
  for (const id of CONTRACT_IDS) {
    const schema = zodToJsonSchema(contracts[id].strict, { $refStrategy: "none" }) as Record<string, unknown>;
    out[id] = { $id: `ralph:contracts/${id}`, ...schema };
  }
  return out;
}
