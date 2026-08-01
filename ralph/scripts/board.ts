/**
 * board.ts — the sole sanctioned mutation path for the ralph v2 board.
 *
 * Design (normative): thoughts/shared/ideas/2026-07-31-ralph-v2-minimal-harness.md
 * Plan: thoughts/shared/plans/2026-07-31-GH-1662-ralph-v2-minimal-harness.md
 *
 * Invariants carried here, not in prose:
 *   - transition legality checked against live state in the same invocation
 *   - claim = "{holder}|{iso8601}" in the Claim text field; TTL is the only side
 *     door — there is deliberately NO --force flag anywhere in this CLI
 *   - scope check: the configured owner/repo must match `git remote get-url origin`
 *   - every mutation echoes the resulting state (per-write proof-of-fire)
 *   - `get` reads exactly the fields `move`/`claim` write (parity)
 *
 * Run: ralph/scripts/board <cmd> ...   (shim: bun > local tsx > npx tsx)
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

export const STATES = [
  "Backlog",
  "In Progress",
  "In Review",
  "Human Needed",
  "Done",
  "Canceled",
] as const;
export type State = (typeof STATES)[number];

/** Legal transitions. Done/Canceled have NO move edges — the only exit is
 *  `reopen`, which also reopens the GitHub issue (a bare move would leave a
 *  closed issue sitting in Backlog, invisible to list/next). */
export const MACHINE: Record<State, readonly State[]> = {
  Backlog: ["In Progress", "Canceled"],
  "In Progress": ["In Review", "Human Needed", "Backlog", "Canceled"],
  "In Review": ["Done", "In Progress", "Human Needed", "Canceled"],
  "Human Needed": ["In Progress", "Backlog", "Canceled"],
  Done: [],
  Canceled: [],
};

/** Legacy (v1) states still meaningful to `migrate` and `doctor`. */
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

/** migrate: v1 state → v2 state. `hasDecisionRequest` = issue has a
 *  "## Decision Request" comment (the held-plan marker). */
export function migrateMapping(
  oldState: string,
  hasDecisionRequest: boolean,
): State | null {
  switch (oldState) {
    case "Research Needed":
    case "Ready for Plan":
      return "Backlog";
    // v1 lock states carry no v2 claim → treat as stale, back to the queue.
    case "Research in Progress":
    case "Plan in Progress":
      return "Backlog";
    case "Plan in Review":
      return hasDecisionRequest ? "Human Needed" : "Backlog";
    default:
      return isState(oldState) ? (oldState as State) : null;
  }
}

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

export interface Claim {
  holder: string;
  since: Date;
}

export function encodeClaim(holder: string, since: Date): string {
  return `${holder}|${since.toISOString()}`;
}

export function parseClaim(value: string | null | undefined): Claim | null {
  if (!value) return null;
  const idx = value.lastIndexOf("|");
  if (idx < 1) return null;
  const since = new Date(value.slice(idx + 1));
  if (Number.isNaN(since.getTime())) return null;
  return { holder: value.slice(0, idx), since };
}

export function claimAgeMin(claim: Claim, now: Date): number {
  return (now.getTime() - claim.since.getTime()) / 60_000;
}

export function claimIsStale(claim: Claim, now: Date, ttlMin: number): boolean {
  return claimAgeMin(claim, now) >= ttlMin;
}

// ---------------------------------------------------------------------------
// Queue ranking
// ---------------------------------------------------------------------------

export interface QueueItem {
  number: number;
  repo: string; // nameWithOwner — the board is cross-repo capable
  title: string;
  state: string;
  priority: string | null; // "P0".."P3"
  hasParent: boolean;
  openBlockers: number[];
  blockersTruncated: boolean; // fail closed: truncated blocker list = blocked
  claim: Claim | null;
  claimRaw: string | null; // raw Claim text — non-null with claim null = garbled (hand-edited)
  openBlockerLabels: string[]; // display form of openBlockers: "#N" own-repo, "owner/repo#N" cross-repo
}

/** Numeric rank of a priority option ("P0" → 0, "P10" → 10). A lexicographic
 *  compare would order "P10" before "P2"; missing/unparseable ranks last. */
function priorityRank(p: string | null): number {
  const m = p?.match(/(\d+)\s*$/);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

/** Backlog, unblocked, unclaimed — P0 first, parented work before new roots,
 *  then oldest. Blocked items are excluded but reported separately; an item
 *  whose blocker list was truncated counts as blocked (fail closed). */
export function rankNext(items: QueueItem[]): {
  eligible: QueueItem[];
  blocked: QueueItem[];
} {
  const backlog = items.filter((i) => i.state === "Backlog" && !i.claim);
  const blocked = backlog.filter((i) => i.openBlockers.length > 0 || i.blockersTruncated);
  const eligible = backlog
    .filter((i) => i.openBlockers.length === 0 && !i.blockersTruncated)
    .sort((a, b) => {
      const pa = priorityRank(a.priority);
      const pb = priorityRank(b.priority);
      if (pa !== pb) return pa - pb;
      if (a.hasParent !== b.hasParent) return a.hasParent ? -1 : 1;
      return a.number - b.number;
    });
  return { eligible, blocked };
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

  const ralphJson = join(repoRoot, ".ralph.json");
  const settingsJson = join(repoRoot, ".claude", "settings.json");
  if (existsSync(ralphJson)) {
    const c = JSON.parse(readFileSync(ralphJson, "utf8"));
    owner = c.owner ?? "";
    repo = c.repo ?? "";
    projectNumber = Number(c.projectNumber ?? 0);
    host = c.host ?? host;
  } else if (existsSync(settingsJson)) {
    const env = JSON.parse(readFileSync(settingsJson, "utf8")).env ?? {};
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

  return {
    owner,
    repo,
    projectNumber,
    host,
    lockTtlMin: parseTtlMin(process.env.RALPH_LOCK_TTL_MIN),
    holder:
      process.env.RALPH_CLAIM_HOLDER ??
      `${userInfo().username}@${hostname()}`,
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
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

export class UsageError extends Error {}
export class RefusalError extends Error {} // invariant refusal — exit 2

export interface Ctx {
  exec: ExecFn;
  cfg: Config;
  repoRoot: string;
  cacheDir: string;
  now: () => Date;
}

export function ghGraphQL<T = any>(
  ctx: Ctx,
  query: string,
  variables: Record<string, unknown>,
): T {
  // --hostname keeps API traffic on the same host the scope gate verified —
  // a GHE config must not silently query github.com.
  const r = ctx.exec(
    ["gh", "api", "graphql", "--hostname", ctx.cfg.host, "--input", "-"],
    JSON.stringify({ query, variables }),
  );
  if (r.code !== 0) {
    throw new Error(`gh api graphql failed (exit ${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
  }
  const body = JSON.parse(r.stdout);
  if (body.errors?.length) {
    throw new Error(`GraphQL: ${body.errors.map((e: any) => e.message).join("; ")}`);
  }
  return body.data as T;
}

// ---------------------------------------------------------------------------
// Field cache (~/.ralph/cache/board-{owner}-{project}.json)
// ---------------------------------------------------------------------------

interface FieldInfo {
  id: string;
  dataType: string;
  options?: Record<string, string>; // name → optionId
}
interface BoardCache {
  projectId: string;
  repositoryId: string;
  fields: Record<string, FieldInfo>; // field name → info
  fetchedAt: string;
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
  const fieldsQ = `query($owner: String!, $number: Int!) {
    OWNER_TYPE(login: $owner) {
      projectV2(number: $number) {
        id
        fields(first: 50) {
          nodes {
            ... on ProjectV2FieldCommon { id name dataType }
            ... on ProjectV2SingleSelectField { id name dataType options { id name } }
          }
        }
      }
    }
  }`;
  let project: any = null;
  for (const ownerType of ["user", "organization"]) {
    try {
      const data = ghGraphQL(ctx, fieldsQ.replace("OWNER_TYPE", ownerType), {
        owner: ctx.cfg.owner,
        number: ctx.cfg.projectNumber,
      });
      project = data[ownerType]?.projectV2;
      if (project) break;
    } catch {
      /* try next owner type */
    }
  }
  if (!project) {
    throw new Error(
      `project ${ctx.cfg.owner}/#${ctx.cfg.projectNumber} not found (checked user + organization)`,
    );
  }

  const repoData = ghGraphQL(
    ctx,
    `query($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) { id } }`,
    { owner: ctx.cfg.owner, repo: ctx.cfg.repo },
  );

  const fields: Record<string, FieldInfo> = {};
  for (const f of project.fields.nodes) {
    if (!f?.name) continue;
    fields[f.name] = {
      id: f.id,
      dataType: f.dataType,
      options: f.options
        ? Object.fromEntries(f.options.map((o: any) => [o.name, o.id]))
        : undefined,
    };
  }

  const cache: BoardCache = {
    projectId: project.id,
    repositoryId: repoData.repository.id,
    fields,
    fetchedAt: ctx.now().toISOString(),
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
 *  never a stale snapshot — but confirmed absence is not an error. */
function mutationCache(
  ctx: Ctx,
  needs: Array<[field: string, option?: string]>,
  optionalFields: string[] = [],
): BoardCache {
  const satisfied = (c: BoardCache) =>
    needs.every(([f, o]) => c.fields[f] && (o === undefined || c.fields[f].options?.[o]));
  const optionalKnown = (c: BoardCache) => optionalFields.every((f) => c.fields[f]);
  let cache = ensureCache(ctx);
  if (!satisfied(cache) || !optionalKnown(cache)) cache = refreshCache(ctx);
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
  claim: Claim | null;
  estimate: string | null;
  priority: string | null;
  labels: string[];
  parent: { number: number; title: string } | null;
  children: Array<{ number: number; title: string; issueState: string; state: string | null }>;
  childrenTruncated: boolean; // >50 children — parentCheck fails closed on this
  blockedBy: Array<{ number: number; issueState: string; repo: string }>;
  blockersTruncated: boolean;
  prs: Array<{ number: number; url: string; state: string; merged: boolean }>;
}

const FIELD_VALUES_FRAGMENT = `fieldValues(first: 20) {
  nodes {
    ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2FieldCommon { name } } }
    ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { name } } }
  }
}`;

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
            labels(first: 20) { nodes { name } }
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
      claim: parseClaim(fv[CLAIM_FIELD]),
      estimate: fv[ESTIMATE_FIELD] ?? null,
      priority: fv[PRIORITY_FIELD] ?? null,
      labels: (issue.labels?.nodes ?? []).map((l: any) => l.name),
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

/** Guard for leaving In Progress: caller must hold the claim, or it is stale. */
function guardHolder(ctx: Ctx, issue: Issue): void {
  const claim = issue.claim;
  if (!claim) return; // no claim — nothing to guard
  if (claim.holder === ctx.cfg.holder) return;
  if (claimIsStale(claim, ctx.now(), ctx.cfg.lockTtlMin)) return;
  throw new RefusalError(
    `#${issue.number} is claimed by ${claim.holder} (${claimAgeMin(claim, ctx.now()).toFixed(0)} min ago, ` +
      `TTL ${ctx.cfg.lockTtlMin} min). Wait for TTL expiry or have the holder release it.`,
  );
}

export function transition(ctx: Ctx, issue: Issue, to: State, opts: MoveOpts = {}): Issue {
  // Cache freshness resolved BEFORE any write; the body never retries.
  const cache = mutationCache(ctx, [[STATE_FIELD, to]], [CLAIM_FIELD]);
  {
    const from = issue.state;

    if (from !== null && !isState(from)) {
      throw new RefusalError(
        `#${issue.number} is in legacy state "${from}" — run \`board migrate\` (Phase 2) before mutating it`,
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
    if (doneWithoutMergedPr && !opts.why) {
      throw new UsageError(
        `moving #${issue.number} to Done requires a merged linked PR — none found. ` +
          `Pass --why "<how this was completed>" to complete without one.`,
      );
    }

    const itemId = requireItem(issue);
    const leavingInProgress = from === "In Progress" && to !== "In Progress";
    const enteringInProgress = to === "In Progress";

    if (leavingInProgress) guardHolder(ctx, issue);
    if (enteringInProgress) {
      const claim = issue.claim;
      if (claim && claim.holder !== ctx.cfg.holder) {
        const stale = claimIsStale(claim, ctx.now(), ctx.cfg.lockTtlMin);
        if (!stale) {
          throw new RefusalError(
            `#${issue.number} is claimed by ${claim.holder} ` +
              `(${claimAgeMin(claim, ctx.now()).toFixed(0)} min ago, TTL ${ctx.cfg.lockTtlMin} min). ` +
              `Pick other work, or wait for TTL and use \`board claim ${issue.number} --steal\`.`,
          );
        }
        if (!opts.steal) {
          throw new RefusalError(
            `#${issue.number} has a STALE claim by ${claim.holder}. ` +
              `Re-run with --steal to take it over (posts an eviction comment).`,
          );
        }
        addComment(
          ctx,
          issue.nodeId,
          `\`board\`: stale claim by \`${claim.holder}\` (since ${claim.since.toISOString()}) ` +
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
        clearField(ctx, cache, itemId, CLAIM_FIELD);
        setText(ctx, cache, itemId, CLAIM_FIELD, encodeClaim(ctx.cfg.holder, ctx.now()));
        claimWritten = true;
      } else if (leavingInProgress) {
        clearField(ctx, cache, itemId, CLAIM_FIELD);
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
    if (to === "In Progress" && after.claim?.holder !== ctx.cfg.holder) {
      // Either a rival's write landed last, or a concurrent clear wiped the
      // claim — in both cases this session does NOT hold the item.
      throw new RefusalError(
        after.claim
          ? `lost the claim race on #${issue.number} to ${after.claim.holder} — pick other work`
          : `claim on #${issue.number} vanished after the write (concurrent clear) — pick other work`,
      );
    }
    // Symmetric verify for the leaving side: the same re-read must show the
    // claim gone (null or not-self) — a surviving self-held claim means the
    // clear did not stick and this session would silently keep the item.
    if (leavingInProgress && after.claim?.holder === ctx.cfg.holder) {
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
// Adopt + reconcile — the reality-sync lane (used by state-guard.yml).
//
// `transition` governs agent INTENT and is guarded by the MACHINE table.
// `reconcile` syncs board state to GitHub REALITY (issue closed/reopened) and
// deliberately bypasses the table — a human closing an issue from Backlog is
// legal reality even though Backlog→Done is an illegal intent transition.
// Every correction posts a comment. Still no --force anywhere.
// ---------------------------------------------------------------------------

/** Ensure the issue is on the board with a state; new items land in Backlog. */
export function adopt(ctx: Ctx, number: number): Issue {
  const cache = mutationCache(ctx, [[STATE_FIELD, "Backlog"]]);
  let issue = fetchIssue(ctx, number);
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
  if (issue.state === null) {
    setSingleSelect(ctx, cache, issue.itemId!, STATE_FIELD, "Backlog");
    syncStatus(ctx, cache, issue.itemId!, "Backlog");
  }
  return fetchIssue(ctx, number);
}

/** Sync board state to issue reality. Returns a description of what changed. */
export function reconcile(ctx: Ctx, number: number): string {
  const cache = mutationCache(
    ctx,
    [[STATE_FIELD, "Done"], [STATE_FIELD, "Canceled"], [STATE_FIELD, "Backlog"]],
    [CLAIM_FIELD],
  );
  {
    const issue = fetchIssue(ctx, number);
    if (!issue.itemId) {
      adopt(ctx, number);
      return `#${number}: adopted to board (Backlog)`;
    }
    if (issue.archived) {
      return `#${number}: project item archived — skipped (unarchive in the board UI to reconcile)`;
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
        return `#${number}: legacy state "${issue.state}" — migrate's job, not reconcile's`;
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
export interface ClosedItem {
  number: number;
  repo: string;
  state: string; // board Workflow State, "(none)" if unset
  archived: boolean;
}

/** One page walk, two views: open items for the queue, closed items for
 *  doctor's drift sweep. Every existing caller goes through listItems and
 *  keeps the OPEN-only contract — closed items must never reach the ranker. */
export function listItemsFull(ctx: Ctx): { open: QueueItem[]; closed: ClosedItem[] } {
  return withCache(ctx, (cache) => {
    const items: QueueItem[] = [];
    const closed: ClosedItem[] = [];
    // A bare "#N" reads as this repo — a cross-repo blocker must say whose #N.
    const self = `${ctx.cfg.owner}/${ctx.cfg.repo}`.toLowerCase();
    let after: string | null = null;
    for (;;) {
      const data: any = ghGraphQL(
        ctx,
        `query($projectId: ID!, $after: String) {
          node(id: $projectId) {
            ... on ProjectV2 {
              items(first: 100, after: $after) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  isArchived
                  content {
                    ... on Issue {
                      number title state
                      repository { nameWithOwner }
                      parent { number }
                      blockedBy(first: 50) { pageInfo { hasNextPage } nodes { number state repository { nameWithOwner } } }
                    }
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
      for (const n of page?.nodes ?? []) {
        const c = n.content;
        if (!c?.number) continue;
        const fv = fieldValueMap(n.fieldValues);
        // Closed issues are already-fetched page data — retained for doctor's
        // drift sweep (number + board state + archived), never for the queue.
        if (c.state !== "OPEN") {
          closed.push({
            number: c.number,
            repo: c.repository?.nameWithOwner ?? "",
            state: fv[STATE_FIELD] ?? "(none)",
            archived: n.isArchived ?? false,
          });
          continue;
        }
        // Archived items are still returned by the items connection but
        // cannot be written ("The item is archived") — skip them everywhere.
        if (n.isArchived) continue;
        const openBlockerNodes = (c.blockedBy?.nodes ?? []).filter((b: any) => b.state === "OPEN");
        items.push({
          number: c.number,
          repo: c.repository?.nameWithOwner ?? "",
          title: c.title,
          state: fv[STATE_FIELD] ?? "(none)",
          priority: fv[PRIORITY_FIELD] ?? null,
          hasParent: !!c.parent,
          openBlockers: openBlockerNodes.map((b: any) => b.number),
          openBlockerLabels: openBlockerNodes.map((b: any) => {
            const r = b.repository?.nameWithOwner;
            return r && r.toLowerCase() !== self ? `${r}#${b.number}` : `#${b.number}`;
          }),
          blockersTruncated: c.blockedBy?.pageInfo?.hasNextPage ?? false,
          claim: parseClaim(fv[CLAIM_FIELD]),
          claimRaw: fv[CLAIM_FIELD] ?? null,
        });
      }
      if (!page?.pageInfo?.hasNextPage) break;
      after = page.pageInfo.endCursor;
    }
    return { open: items, closed };
  });
}

export function listItems(ctx: Ctx): QueueItem[] {
  return listItemsFull(ctx).open;
}

// ---------------------------------------------------------------------------
// Create / link / dep
// ---------------------------------------------------------------------------

export interface CreateOpts {
  title: string;
  body?: string;
  parent?: number;
  estimate?: string;
  state?: State;
}

export function createIssue(ctx: Ctx, opts: CreateOpts): Issue {
  if (opts.state && ["Done", "Canceled"].includes(opts.state)) {
    throw new UsageError(
      `cannot create an issue in terminal state "${opts.state}" — create it open, then move/cancel it`,
    );
  }
  const cache = mutationCache(ctx, [[STATE_FIELD, opts.state ?? "Backlog"]]);
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
    if (opts.estimate) {
      try {
        setSingleSelect(ctx, cache, itemId, ESTIMATE_FIELD, opts.estimate);
      } catch (e) {
        process.stderr.write(`warn: estimate not set: ${(e as Error).message}\n`);
      }
    }
    if (opts.parent) {
      const parent = fetchIssue(ctx, opts.parent);
      ghGraphQL(
        ctx,
        `mutation($parentId: ID!, $childId: ID!) {
          addSubIssue(input: { issueId: $parentId, subIssueId: $childId }) { issue { id } }
        }`,
        { parentId: parent.nodeId, childId: issue.id },
      );
    }
    return fetchIssue(ctx, issue.number);
  }
}

export function linkParent(ctx: Ctx, parentNumber: number, childNumber: number): void {
  const parent = fetchIssue(ctx, parentNumber);
  const child = fetchIssue(ctx, childNumber);
  ghGraphQL(
    ctx,
    `mutation($parentId: ID!, $childId: ID!) {
      addSubIssue(input: { issueId: $parentId, subIssueId: $childId }) { issue { id } }
    }`,
    { parentId: parent.nodeId, childId: child.nodeId },
  );
}

export function setDependency(ctx: Ctx, blockedNumber: number, blockingNumber: number, remove = false): void {
  const blocked = fetchIssue(ctx, blockedNumber);
  const blocking = fetchIssue(ctx, blockingNumber);
  const mutation = remove ? "removeBlockedBy" : "addBlockedBy";
  ghGraphQL(
    ctx,
    `mutation($blockedId: ID!, $blockingId: ID!) {
      ${mutation}(input: { issueId: $blockedId, blockingIssueId: $blockingId }) { issue { id } }
    }`,
    { blockedId: blocked.nodeId, blockingId: blocking.nodeId },
  );
}

// ---------------------------------------------------------------------------
// Doctor
// ---------------------------------------------------------------------------

export interface DoctorReport {
  ok: boolean;
  checks: Array<{ name: string; level: "ok" | "warn" | "fail"; detail: string }>;
}

export function doctor(ctx: Ctx, opts: { fix?: boolean; strict?: boolean } = {}): DoctorReport {
  const checks: DoctorReport["checks"] = [];
  const add = (name: string, level: "ok" | "warn" | "fail", detail: string) =>
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
          `legacy options present (pre-migration OK): ${legacy.join(", ")}`,
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
      add(
        "foreign-items",
        "ok",
        foreign.length === 0
          ? "none"
          : `${foreign.length} item(s) from other repos on this board (informational; board.ts never touches them): ${foreign.map((i) => `${i.repo}#${i.number}`).join(" ")}`,
      );
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
      add("stale-claims", stale.length === 0 ? "ok" : "warn", stale.length === 0 ? "none" : stale.map((i) => `#${i.number} by ${i.claim!.holder}`).join(" "));
      add("terminal-drift", terminalDrift.length === 0 ? "ok" : "warn", terminalDrift.length === 0 ? "none" : `open issues in terminal board states: ${terminalDrift.map((i) => `#${i.number}(${i.state})`).join(" ")}`);
      add("closed-drift", closedDrift.length === 0 ? "ok" : "warn", closedDrift.length === 0 ? "none" : `closed issues in non-terminal board states: ${closedDrift.map((i) => `#${i.number}(${i.state})`).join(" ")}`);
      add("claimless-wip", claimlessWip.length === 0 ? "ok" : "warn", claimlessWip.length === 0 ? "none" : `In Progress without a claim (human WIP or a failed claim write): ${claimlessWip.map((i) => `#${i.number}`).join(" ")}`);
      // Never auto-fixed: a hand-edited Claim field is a human's note to self —
      // surfacing it is enough.
      add("claim-garbled", garbled.length === 0 ? "ok" : "warn", garbled.length === 0 ? "none" : `unparseable Claim text (want "holder|iso8601"): ${garbled.map((i) => `#${i.number}`).join(" ")}`);

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
                `\`board doctor --fix\`: stale claim by \`${issue.claim.holder}\` released; returned to Backlog.`,
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
    "gh", "run", "list", "--workflow", "state-guard.yml", "--limit", "5",
    "--json", "conclusion,updatedAt",
  ]);
  if (runs.code === 0) {
    try {
      const parsed = JSON.parse(runs.stdout);
      const bad = parsed.filter((r: any) => r.conclusion && r.conclusion !== "success");
      if (parsed.length === 0) add("state-guard", "warn", "no runs recorded");
      else add("state-guard", bad.length === 0 ? "ok" : "fail", bad.length === 0 ? `last ${parsed.length} runs green` : `${bad.length}/${parsed.length} recent runs not successful`);
    } catch {
      add("state-guard", "warn", "run list unparseable");
    }
  } else {
    add("state-guard", "ok", "workflow absent (pre-Phase-2)");
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
  const hb = existsSync(join(homedir(), ".ralph", "heartbeat"));
  add(
    3, "loop", "info",
    hb
      ? "scheduler heartbeat present on this machine"
      : "loop not installed on this machine (install-loop.sh --enable when wanted)",
  );

  let readyFor: ReadinessReport["readyFor"] = 0;
  for (const lvl of [1, 2, 3] as const) {
    if (checks.some((c) => c.level === lvl && c.status === "miss")) break;
    readyFor = lvl;
  }
  return { repo: `${ctx.cfg.owner}/${ctx.cfg.repo}`, readyFor, checks };
}

// ---------------------------------------------------------------------------
// Setup + migrate
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
        `MANUAL (after migrate): delete legacy option(s) ${legacy.join(", ")} from "${STATE_FIELD}" in the board UI`,
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

export function migrate(ctx: Ctx, opts: { apply?: boolean } = {}): string[] {
  const out: string[] = [];
  // Cache resolved before any write; the loop never retries, and a report
  // line is pushed only AFTER the write it describes succeeds.
  const cache = mutationCache(ctx, STATES.map((s) => [STATE_FIELD, s] as [string, string]));
  const { own, foreign } = ownRepo(ctx, listItems(ctx));
  for (const f of foreign) {
    out.push(`#${f.number} (${f.repo}): foreign-repo item — never touched by migrate`);
  }
  const legacyItems = own.filter((i) => i.state !== "(none)" && !isState(i.state));
  const stateless = own.filter((i) => i.state === "(none)");

  for (const i of [...legacyItems, ...stateless]) {
    let hasDecisionRequest = false;
    if (i.state === "Plan in Review") {
      const comments = ghGraphQL(
        ctx,
        `query($owner: String!, $repo: String!, $number: Int!) {
          repository(owner: $owner, name: $repo) {
            issue(number: $number) { comments(last: 50) { nodes { body } } }
          }
        }`,
        { owner: ctx.cfg.owner, repo: ctx.cfg.repo, number: i.number },
      );
      hasDecisionRequest = (comments.repository?.issue?.comments?.nodes ?? []).some((c: any) =>
        c.body?.includes("## Decision Request"),
      );
    }
    const target = i.state === "(none)" ? "Backlog" : migrateMapping(i.state, hasDecisionRequest);
    if (!target) {
      out.push(`#${i.number}: unmapped state "${i.state}" — SKIPPED (fix by hand)`);
      continue;
    }
    if (!opts.apply) {
      out.push(`#${i.number}: "${i.state}" → "${target}" (dry-run)`);
      continue;
    }
    try {
      const issue = fetchIssue(ctx, i.number);
      if (!issue.itemId) {
        out.push(`#${i.number}: not on the board — SKIPPED`);
        continue;
      }
      setSingleSelect(ctx, cache, issue.itemId, STATE_FIELD, target);
      syncStatus(ctx, cache, issue.itemId, target);
      // The state converged; the audit comment is best-effort. A comment
      // failure must NOT report the migration as FAILED — the item would
      // leave the candidate set (state now valid) with no repair path.
      let note = "";
      try {
        addComment(
          ctx,
          issue.nodeId,
          `\`board migrate\`: workflow state "${i.state}" → "${target}" (v2 6-state collapse, GH-1662).`,
        );
      } catch (e) {
        note = ` (migrated; audit comment failed — ${(e as Error).message})`;
      }
      out.push(`#${i.number}: "${i.state}" → "${target}"${note}`);
    } catch (e) {
      // One unwritable item (archived, permissions) must not strand the rest.
      out.push(`#${i.number}: FAILED — ${(e as Error).message}`);
    }
  }
  if (out.length === 0) out.push("nothing to migrate — all open items already in v2 states");
  return out;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const HELP = `board — the ralph v2 board CLI (sole sanctioned mutation path)

reads
  get NNN [--json]            issue: state, claim, parent/children, blockers, PRs
  list [--state S] [--json]   open items on the board
  next [--json]               top-ranked actionable Backlog item (+ blocked report)
  tree NNN                    subtree with states

mutations
  create --title T [--body B] [--parent NNN] [--estimate XS..XL] [--state S]
  claim NNN [--steal]         Backlog/Human Needed/In Review → In Progress; sets Claim
  release NNN -m "why"        In Progress → Backlog; parking comment required
  move NNN <state> [--why W]  any legal transition; Human Needed requires --why
  cancel NNN -m "why"         any open state → Canceled (closes as not-planned)
  reopen NNN                  Done/Canceled → Backlog (reopens the issue)
  link PARENT CHILD           add sub-issue edge
  dep NNN --on MMM [--rm]     NNN is blocked by MMM (--rm removes)
  comment NNN -m "body"

maintenance
  adopt NNN                   ensure issue is on the board (new items → Backlog)
  reconcile NNN               sync board state to issue reality (closed→Done/Canceled,
                              reopened→Backlog); the state-guard event lane
  parent-check NNN            advance parent if all children closed
  doctor [--fix] [--strict]   invariant sweep; --fix clears/releases bad claims
  setup                       create Workflow State / Claim / Estimate / Priority
                              fields (idempotent; never edits existing fields)
  readiness [--json]          agent-readiness report — 3 levels (interactive,
                              unattended, autonomous); recommendations, never gates
  migrate [--apply]           v1 11-state → v2 6-state collapse (dry-run by default)

There is no --force flag. A stale claim (TTL 120 min; RALPH_LOCK_TTL_MIN
overrides) is the only override path.`;

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
      if (next !== undefined && !next.startsWith("--") && !["json", "steal", "rm", "fix", "strict", "apply"].includes(key)) {
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

function issueLine(i: Issue): string {
  const claim = i.claim ? ` claim=${i.claim.holder}@${i.claim.since.toISOString()}` : "";
  const parent = i.parent ? ` parent=#${i.parent.number}` : "";
  const blockers = i.blockedBy.filter((b) => b.issueState === "OPEN").map((b) => `#${b.number}`);
  const blocked = blockers.length ? ` blockedBy=${blockers.join(",")}` : "";
  return `#${i.number} [${i.state ?? "no-state"}]${claim}${parent}${blocked} ${i.title}`;
}

function requireNumber(p: string | undefined, what = "issue number"): number {
  const n = Number(p);
  if (!p || !Number.isInteger(n) || n <= 0) throw new UsageError(`${what} required`);
  return n;
}

const MUTATING = new Set([
  "create", "claim", "release", "move", "cancel", "reopen",
  "link", "dep", "comment", "adopt", "reconcile", "parent-check",
  "setup", "migrate",
]);

export function run(argv: string[], ctx: Ctx): number {
  const [cmd, ...rest] = argv;
  const { positional, flags } = parseArgs(rest);
  const out = (s: string) => process.stdout.write(s + "\n");
  const json = (v: unknown) => out(JSON.stringify(v, null, 2));

  // Scope gate before ANY command that can write — including doctor --fix,
  // which mutates. Plain reads work from any clone (doctor reports scope).
  if (MUTATING.has(cmd) || (cmd === "doctor" && flags.fix)) {
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
        for (const c of issue.children) out(`  child #${c.number} [${c.state ?? c.issueState}] ${c.title}`);
        for (const p of issue.prs) out(`  pr #${p.number} ${p.merged ? "merged" : p.state} ${p.url}`);
      }
      return 0;
    }

    case "list": {
      const { own, foreign } = ownRepo(ctx, listItems(ctx));
      let items = own;
      if (typeof flags.state === "string") {
        const s = parseStateArg(flags.state);
        items = items.filter((i) => i.state === (s ?? flags.state));
      }
      if (flags.json) json({ items, foreign });
      else {
        for (const i of items) out(`#${i.number} [${i.state}]${i.claim ? ` claim=${i.claim.holder}` : ""}${i.openBlockers.length ? ` blockedBy=${i.openBlockers.map((n) => `#${n}`).join(",")}` : ""} ${i.title}`);
        for (const f of foreign) out(`${f.repo}#${f.number} [${f.state}] (foreign repo — read-only here) ${f.title}`);
      }
      return 0;
    }

    case "next": {
      const { eligible, blocked } = rankNext(ownRepo(ctx, listItems(ctx)).own);
      if (flags.json) json({ next: eligible[0] ?? null, queue: eligible, blocked });
      else if (eligible.length === 0) out(`queue empty${blocked.length ? ` (${blocked.length} blocked: ${blocked.map((b) => `#${b.number}`).join(" ")})` : ""}`);
      else {
        out(`next: #${eligible[0].number} ${eligible[0].title}`);
        for (const i of eligible.slice(1, 6)) out(`  then #${i.number} ${i.title}`);
        if (blocked.length) out(`  blocked: ${blocked.map((b) => `#${b.number}←${b.openBlockerLabels.join("+")}`).join(" ")}`);
      }
      return 0;
    }

    case "tree": {
      const root = fetchIssue(ctx, requireNumber(positional[0]));
      out(issueLine(root));
      for (const c of root.children) out(`  #${c.number} [${c.state ?? c.issueState}] ${c.title}`);
      return 0;
    }

    case "create": {
      if (typeof flags.title !== "string" || !flags.title) throw new UsageError("--title required");
      const state = typeof flags.state === "string" ? parseStateArg(flags.state) : null;
      if (typeof flags.state === "string" && !state) throw new UsageError(`unknown state "${flags.state}"`);
      const issue = createIssue(ctx, {
        title: flags.title,
        body: typeof flags.body === "string" ? flags.body : undefined,
        parent: typeof flags.parent === "string" ? requireNumber(flags.parent, "--parent") : undefined,
        estimate: typeof flags.estimate === "string" ? flags.estimate : undefined,
        state: state ?? undefined,
      });
      out(issueLine(issue));
      out(issue.url);
      return 0;
    }

    case "claim": {
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
      out(issueLine(after));
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
      const issue = fetchIssue(ctx, requireNumber(positional[0]));
      addComment(ctx, issue.nodeId, flags.m);
      out(`commented on #${issue.number}`);
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
        for (const c of report.checks) out(`${c.level === "ok" ? "✓" : c.level === "warn" ? "⚠" : "✗"} ${c.name}: ${c.detail}`);
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

    case "migrate": {
      for (const n of migrate(ctx, { apply: !!flags.apply })) out(n);
      if (!flags.apply) out("(dry-run — re-run with --apply to write)");
      return 0;
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
