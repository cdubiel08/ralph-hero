/**
 * MCP tools wrapping the pure ranker at `lib/directions.ts`.
 *
 * Exposes `ralph_hero__next_actions` — accepts `audience` param and returns
 * a fixed-shape JSON payload with up to N ranked "directions" for the
 * `hello` skill's session briefing. Open PRs are fetched internally via the
 * configured GitHub token's `repo` scope; callers no longer pass an
 * `openPRs` argument.
 *
 * Behaviour:
 *   1. Resolve owner + project numbers from args or client config.
 *   2. For each project, ensure the field cache is populated, then
 *      paginate `DASHBOARD_ITEMS_QUERY` to gather up to 500 items.
 *   3. Convert raw items to `DashboardItem[]` via `toDashboardItems`.
 *   4. Derive the unique `repo:owner/name` set from items and run the
 *      internal `fetchOpenPRs` helper to gather open PRs.
 *   5. Build a `RankConfig` from the args + defaults (with injected `now`).
 *   6. Compute each PR's `ageHours` at the boundary and call
 *      `rankDirections(allItems, enrichedPRs, config)`.
 *   7. Return `{ directions, fetchedAt, boardItems }`.
 *
 * Determinism: `fetchedAt` is the only time-varying field. Two consecutive
 * calls on the same board state produce byte-identical `directions[]`
 * (after stripping `fetchedAt`).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GitHubClient } from "../github-client.js";
import { FieldOptionCache } from "../lib/cache.js";
import { ensureFieldCache } from "../lib/helpers.js";
import { resolveLockStaleHours } from "../lib/thresholds.js";
import { paginateConnection } from "../lib/pagination.js";
import {
  DASHBOARD_ITEMS_QUERY,
  toDashboardItems,
  type RawDashboardItem,
} from "./dashboard-tools.js";
import type { DashboardItem } from "../lib/dashboard.js";
import {
  rankDirections,
  enumerateDirections,
  DEFAULT_RANK_CONFIG,
  type Audience,
  type OpenPR,
  type RankConfig,
  type UnblockSignal,
  type UnblockSignalMap,
  type DecisionSignal,
  type DecisionSignalMap,
} from "../lib/directions.js";
import {
  toolSuccess,
  toolError,
  resolveProjectOwner,
  resolveProjectNumbers,
} from "../types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// ---------------------------------------------------------------------------
// Helpers — unblock signal extraction for `human-needed-unblock` direction.
// Comments are fetched at the tool boundary so the pure ranker stays
// deterministic and side-effect-free. Only Human Needed candidates are
// queried — typical projects have 0–5 such issues so the per-issue overhead
// is acceptable.
// ---------------------------------------------------------------------------

interface IssueCommentNode {
  body: string;
  createdAt: string;
  /**
   * Comment permalink from the GraphQL `url` field. Optional so older
   * fixtures / callers without the field still type-check; when present it
   * becomes the signal's `sourceCommentUrl`.
   */
  url?: string;
}

interface FetchCommentsResult {
  comments: IssueCommentNode[];
}

/**
 * Fetch the most recent comments on a single issue. Returns an empty list on
 * error (e.g. the issue is private or has been deleted) so the surrounding
 * ranker continues to produce directions.
 */
async function fetchIssueCommentsForUnblock(
  client: GitHubClient,
  owner: string,
  repo: string,
  number: number,
): Promise<IssueCommentNode[]> {
  try {
    const data = await client.query<{
      repository: {
        issue: {
          comments: { nodes: IssueCommentNode[] };
        } | null;
      } | null;
    }>(
      `query($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          issue(number: $number) {
            comments(last: 20) {
              nodes { body createdAt url }
            }
          }
        }
      }`,
      { owner, repo, number },
    );
    return data.repository?.issue?.comments?.nodes ?? [];
  } catch {
    return [];
  }
}

/**
 * Parse a list of comments and return the unblock signal for the issue, or
 * `null` if the issue should NOT produce a `human-needed-unblock` direction.
 *
 * Rules (matching plan Phase 4.1):
 *   1. Find the most recent comment whose body starts with `## Unblock Request`.
 *      If none exists, return null.
 *   2. Find the most recent comment whose body starts with `## Escalation`.
 *      If it exists and is newer than the unblock request, return null
 *      (the autonomous skill needs to re-run before the human is asked).
 *   3. Compute `unblockRequestAgeDays` from the unblock request's createdAt.
 *   4. Compute `questionCount` by counting lines matching `^\d+\.\s` in the
 *      unblock request body.
 */
export function extractUnblockSignal(
  comments: IssueCommentNode[],
  now: Date,
): UnblockSignal | null {
  // Iterate to find the most recent comment of each header kind. Use
  // string-prefix match because authors may include trailing whitespace
  // or quote a header in a follow-up comment that we want to ignore.
  let latestUnblock: IssueCommentNode | null = null;
  let latestEscalation: IssueCommentNode | null = null;

  for (const c of comments) {
    if (c.body.startsWith("## Unblock Request")) {
      if (
        latestUnblock === null ||
        new Date(c.createdAt).getTime() >
          new Date(latestUnblock.createdAt).getTime()
      ) {
        latestUnblock = c;
      }
    } else if (c.body.startsWith("## Escalation")) {
      if (
        latestEscalation === null ||
        new Date(c.createdAt).getTime() >
          new Date(latestEscalation.createdAt).getTime()
      ) {
        latestEscalation = c;
      }
    }
  }

  if (latestUnblock === null) return null;

  // Skip if the most recent escalation is newer than the unblock request.
  if (latestEscalation !== null) {
    const escTs = new Date(latestEscalation.createdAt).getTime();
    const ubTs = new Date(latestUnblock.createdAt).getTime();
    if (escTs > ubTs) return null;
  }

  // Age in whole days, rounded down. Floor at 0 (never negative).
  const ts = new Date(latestUnblock.createdAt).getTime();
  const ageMs = Number.isNaN(ts) ? 0 : Math.max(0, now.getTime() - ts);
  const unblockRequestAgeDays = Math.floor(ageMs / DAY_MS);

  // Count question lines: `^\d+\.\s` (e.g. "1. ", "2.\t")
  const questionCount = latestUnblock.body
    .split("\n")
    .filter((line) => /^\d+\.\s/.test(line)).length;

  const signal: UnblockSignal = { unblockRequestAgeDays, questionCount };
  if (latestUnblock.url !== undefined) {
    signal.sourceCommentUrl = latestUnblock.url;
  }
  return signal;
}

/**
 * Parse a list of comments and return the decision signal for a Plan in
 * Review issue, or `null` if the issue should NOT produce a
 * `plan-decision` direction (GH-1544 decision-gated approval).
 *
 * Rules:
 *   1. Find the most recent comment whose body starts with
 *      `## Decision Request`. If none exists, return null (the plan is a
 *      plain review candidate, not held).
 *   2. If ANY comment is newer than that request, return null — the reply
 *      is treated as answers and the next review dispatch folds them, so
 *      the ball is back in the agent's court, not the human's.
 *   3. Compute `decisionRequestAgeDays` from the request's createdAt.
 *   4. Compute `decisionCount` from `^### ` section lines in the request
 *      body (one per open decision block; floor 1).
 */
export function extractDecisionSignal(
  comments: IssueCommentNode[],
  now: Date,
): DecisionSignal | null {
  let latestRequest: IssueCommentNode | null = null;
  for (const c of comments) {
    if (c.body.startsWith("## Decision Request")) {
      if (
        latestRequest === null ||
        new Date(c.createdAt).getTime() >
          new Date(latestRequest.createdAt).getTime()
      ) {
        latestRequest = c;
      }
    }
  }
  if (latestRequest === null) return null;

  // Any later comment counts as an answer -> not a human-attention hold.
  const reqTs = new Date(latestRequest.createdAt).getTime();
  for (const c of comments) {
    if (c === latestRequest) continue;
    const ts = new Date(c.createdAt).getTime();
    if (!Number.isNaN(ts) && ts > reqTs) return null;
  }

  const ageMs = Number.isNaN(reqTs) ? 0 : Math.max(0, now.getTime() - reqTs);
  const decisionRequestAgeDays = Math.floor(ageMs / DAY_MS);

  const decisionCount = Math.max(
    1,
    latestRequest.body.split("\n").filter((line) => /^### /.test(line)).length,
  );

  const signal: DecisionSignal = { decisionRequestAgeDays, decisionCount };
  if (latestRequest.url !== undefined) {
    signal.sourceCommentUrl = latestRequest.url;
  }
  return signal;
}

/**
 * Parse "owner/repo" into its parts. Returns null on malformed input.
 */
function splitOwnerRepo(
  nameWithOwner: string | undefined,
): { owner: string; repo: string } | null {
  if (!nameWithOwner) return null;
  const parts = nameWithOwner.split("/");
  if (parts.length !== 2) return null;
  if (!parts[0] || !parts[1]) return null;
  return { owner: parts[0], repo: parts[1] };
}

/**
 * Build the unblock signal map for all Human Needed candidates in `items`.
 * Skips items that don't carry a parseable repository identifier (we need
 * `owner/repo` to fetch issue comments via the GitHub repo API).
 */
async function buildUnblockSignalMap(
  client: GitHubClient,
  items: DashboardItem[],
  now: Date,
): Promise<UnblockSignalMap> {
  const map: Record<number, UnblockSignal> = {};
  const candidates = items.filter(
    (item) => item.workflowState === "Human Needed",
  );
  if (candidates.length === 0) return map;

  // Fetch comments per candidate. Sequential to keep rate-limit pressure low —
  // the candidate set is typically tiny (0-5).
  for (const item of candidates) {
    const ownerRepo = splitOwnerRepo(item.repository);
    if (!ownerRepo) continue;
    const comments = await fetchIssueCommentsForUnblock(
      client,
      ownerRepo.owner,
      ownerRepo.repo,
      item.number,
    );
    const signal = extractUnblockSignal(comments, now);
    if (signal !== null) {
      map[item.number] = signal;
    }
  }

  return map;
}

/**
 * Build the decision signal map for all Plan in Review candidates in
 * `items` (GH-1544). Same boundary pattern as the unblock map: sequential
 * per-issue comment fetch, typically 0-5 candidates.
 */
async function buildDecisionSignalMap(
  client: GitHubClient,
  items: DashboardItem[],
  now: Date,
): Promise<DecisionSignalMap> {
  const map: Record<number, DecisionSignal> = {};
  const candidates = items.filter(
    (item) => item.workflowState === "Plan in Review",
  );
  if (candidates.length === 0) return map;

  for (const item of candidates) {
    const ownerRepo = splitOwnerRepo(item.repository);
    if (!ownerRepo) continue;
    const comments = await fetchIssueCommentsForUnblock(
      client,
      ownerRepo.owner,
      ownerRepo.repo,
      item.number,
    );
    const signal = extractDecisionSignal(comments, now);
    if (signal !== null) {
      map[item.number] = signal;
    }
  }

  return map;
}

// ---------------------------------------------------------------------------
// Internal PR fetch — runs `is:pr is:open repo:owner/name` GraphQL search per
// unique repo represented in the project items. Replaces the caller-supplied
// `openPRs` parameter (removed in 2.6.0). Failures (e.g. token without repo
// scope) yield an empty list rather than blocking direction computation.
// ---------------------------------------------------------------------------

interface RawOpenPR {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  reviewDecision: string | null;
  headRefName: string;
  createdAt: string;
}

/**
 * Derive the unique `owner/repo` set from the project items so the PR search
 * mirrors the project's repo scope. Items lacking a `repository` field (e.g.
 * draft items) are skipped. Closed items (GitHub `closedAt` set, or workflow
 * state Done/Canceled) also do NOT expand the radius — a stale closed
 * cross-repo item on the board would otherwise pull every open PR from that
 * foreign repo into `next_actions` (see GH-1399). Returns deterministic order
 * (sorted) so the downstream search query is stable.
 */
function uniqueRepos(items: DashboardItem[]): string[] {
  const seen = new Set<string>();
  for (const item of items) {
    if (!item.repository) continue;
    if (item.closedAt !== null) continue;
    if (item.workflowState === "Done" || item.workflowState === "Canceled") continue;
    seen.add(item.repository);
  }
  return Array.from(seen).sort();
}

/**
 * Fetch open PRs via GraphQL `search(type: ISSUE)` filtered to
 * `is:pr is:open repo:<nameWithOwner>`. One query per repo — the project's
 * repo set is typically tiny (1–3 repos) and most boards are single-repo so
 * the call shape matches the previous `gh pr list` cost.
 *
 * Returns the raw shape consumed by `runDirections`'s age-enrichment pass.
 * Errors are swallowed and logged via `console.error` so a token without
 * `repo` scope cannot block direction computation — PR-kind directions
 * simply don't surface.
 */
export async function fetchOpenPRs(
  client: GitHubClient,
  repos: string[],
): Promise<RawOpenPR[]> {
  if (repos.length === 0) return [];

  const out: RawOpenPR[] = [];
  for (const nameWithOwner of repos) {
    const q = `is:pr is:open repo:${nameWithOwner}`;
    try {
      const data = await client.query<{
        search: {
          nodes: Array<{
            number: number;
            title: string;
            url: string;
            isDraft: boolean;
            reviewDecision: string | null;
            headRefName: string;
            createdAt: string;
          }>;
        };
      }>(
        `query OpenPRs($q: String!) {
          search(query: $q, type: ISSUE, first: 100) {
            nodes {
              ... on PullRequest {
                number
                title
                url
                isDraft
                reviewDecision
                headRefName
                createdAt
              }
            }
          }
        }`,
        { q },
      );
      for (const pr of data.search.nodes) {
        // Defensive: search responses can include empty fragments when the
        // node is not a PullRequest. Skip rows missing required fields.
        if (typeof pr.number !== "number" || !pr.url) continue;
        out.push({
          number: pr.number,
          title: pr.title,
          url: pr.url,
          isDraft: pr.isDraft,
          reviewDecision: pr.reviewDecision,
          headRefName: pr.headRefName,
          createdAt: pr.createdAt,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[ralph-hero] fetchOpenPRs failed for repo ${nameWithOwner}: ${msg}`,
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shared params type — both tools accept (almost) the same shape.
// `audience` is internal; callers only pass it via the `next_actions` tool.
// ---------------------------------------------------------------------------

export interface RunDirectionsArgs {
  owner?: string;
  projectNumbers?: number[];
  limit?: number;
  stuckThresholdHours?: number;
  lockStaleHours?: number;
  treeRecentDoneDays?: number;
  prStaleHours?: number;
  audience: Audience;
  /**
   * When `"human-queue"`, return the FULL ranked human queue (every
   * direction, unsliced) instead of the top-`limit`. Forces
   * `audience: "human"` server-side. Canonical caller: `catch-up --mode
   * brief` (GH-1553).
   */
  enumerate?: "human-queue";
}

// ---------------------------------------------------------------------------
// Shared implementation — extracted so the `next_actions` tool can route
// through a single code path.
// ---------------------------------------------------------------------------

export function makeRunDirections(client: GitHubClient, fieldCache: FieldOptionCache) {
  return async function runDirections(args: RunDirectionsArgs) {
    try {
      const owner = args.owner || resolveProjectOwner(client.config);
      if (!owner) {
        return toolError("owner is required");
      }

      const projectNumbers =
        args.projectNumbers ?? resolveProjectNumbers(client.config);

      if (projectNumbers.length === 0) {
        return toolError(
          "No project numbers configured. Set RALPH_GH_PROJECT_NUMBER or RALPH_GH_PROJECT_NUMBERS.",
        );
      }

      // Inject `now` at the boundary so the lib remains deterministic.
      const now = new Date();

      const allItems: DashboardItem[] = [];

      for (const pn of projectNumbers) {
        await ensureFieldCache(client, fieldCache, owner, pn);

        const projectId = fieldCache.getProjectId(pn);
        if (!projectId) {
          // Defensive: ensureFieldCache succeeded but no projectId.
          // Skip this project rather than blowing up the whole call.
          continue;
        }

        const result = await paginateConnection<RawDashboardItem>(
          (q, v) => client.projectQuery(q, v),
          DASHBOARD_ITEMS_QUERY,
          { projectId, first: 100 },
          "node.items",
          { scanUntilExhausted: true },
        );

        allItems.push(...toDashboardItems(result.nodes, pn));
      }

      // Compute unblock signals for any Human Needed candidates so the
      // ranker can surface `human-needed-unblock` directions. Comments are
      // fetched at the boundary; the ranker stays pure.
      const unblockSignals = await buildUnblockSignalMap(client, allItems, now);

      // Compute decision signals for any Plan in Review candidates holding
      // on an unanswered `## Decision Request` (GH-1544): human audience
      // surfaces them as `plan-decision`; agent audience excludes them.
      const decisionSignals = await buildDecisionSignalMap(
        client,
        allItems,
        now,
      );

      // Build the RankConfig from args + defaults + injected `now`.
      // Enumeration is a human-queue concept only: when `enumerate` is set,
      // force human audience server-side regardless of the caller's
      // `audience` arg (an agent-audience enumeration would silently drop
      // plan-decision holds — the exact items the human queue exists for).
      const enumerating = args.enumerate === "human-queue";
      const config: RankConfig = {
        limit: args.limit ?? DEFAULT_RANK_CONFIG.limit,
        stuckThresholdHours:
          args.stuckThresholdHours ?? DEFAULT_RANK_CONFIG.stuckThresholdHours,
        // GH-1617: resolveLockStaleHours resolves param > RALPH_LOCK_STALE_HOURS
        // env > LOCK_STALE_HOURS constant. The zod schema below deliberately
        // does NOT carry `.default(24)` — a schema default would make
        // `args.lockStaleHours` always defined and make the env branch
        // unreachable (the bug this fixes).
        lockStaleHours: resolveLockStaleHours(args.lockStaleHours),
        treeRecentDoneDays:
          args.treeRecentDoneDays ?? DEFAULT_RANK_CONFIG.treeRecentDoneDays,
        prStaleHours:
          args.prStaleHours ?? DEFAULT_RANK_CONFIG.prStaleHours,
        audience: enumerating ? "human" : args.audience,
        now,
        unblockSignals,
        decisionSignals,
      };

      // Fetch open PRs internally for the unique repo set covered by the
      // project items. Replaces the caller-supplied `openPRs` parameter
      // (removed in 2.6.0). One search query per repo; failures yield an
      // empty list so the rest of the ranking still runs.
      const repos = uniqueRepos(allItems);
      const rawOpenPRs = await fetchOpenPRs(client, repos);

      // Compute PR ageHours at the boundary so the lib never reads the wall clock.
      const enrichedPRs: OpenPR[] = rawOpenPRs.map((pr) => {
        const t = new Date(pr.createdAt).getTime();
        const ageHours = Number.isNaN(t)
          ? 0
          : Math.max(0, (now.getTime() - t) / HOUR_MS);
        return {
          number: pr.number,
          title: pr.title,
          url: pr.url,
          isDraft: pr.isDraft,
          reviewDecision: pr.reviewDecision,
          headRefName: pr.headRefName,
          createdAt: pr.createdAt,
          ageHours,
        };
      });

      const directions = enumerating
        ? enumerateDirections(allItems, enrichedPRs, config)
        : rankDirections(allItems, enrichedPRs, config);

      return toolSuccess({
        directions,
        fetchedAt: now.toISOString(),
        // `boardItems` is the raw count of items on the project board pre-filter
        // (sum across all configured project numbers). Uniform across discovery
        // tools (next_actions, pipeline_dashboard, project_hygiene). The number
        // of returned `directions` is bounded by `limit` and may be much smaller.
        boardItems: allItems.length,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return toolError(`Failed to compute hello directions: ${message}`);
    }
  };
}

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------

export function registerDirectionsTools(
  server: McpServer,
  client: GitHubClient,
  fieldCache: FieldOptionCache,
): void {
  const runDirections = makeRunDirections(client, fieldCache);

  server.tool(
    "ralph_hero__next_actions",
    "Compute up to N deterministic 'directions' (next actions) with one flagged `recommended: true`. Fetches all project items (full project scan, no silent 500-cap) so candidate selection covers every item regardless of board position. Used by the /hello skill picker (interactive) and by headless orchestrators (auto-select recommended). Open PRs are fetched internally via the configured GitHub token's `repo` scope (one `is:pr is:open repo:owner/name` GraphQL search per unique repo represented in the project items) — callers no longer pass an `openPRs` argument. Each direction includes a structured signals object (staleDays, staleThresholdDays, tiedAtScore, estimateWeight, parentChainNote) for skills to synthesize prose. Plan in Review issues holding on an unanswered `## Decision Request` comment (GH-1544 decision-gated approval) surface as `kind: 'plan-decision'` for `audience='human'` (signals carry decisionRequestAgeDays + decisionCount; the right action is ANSWERING the request, not re-reviewing) and are EXCLUDED for `audience='agent'` (an agent cannot answer a design decision). The legacy 'reason' string is @deprecated and removed in 2.7.0. When `audience='agent'` and no items are in actionable phases (Plan in Review, In Review, Ready for Plan, Research Needed) or otherwise surfacing (lock-stale, unblock-requested), the picker falls back to Backlog and null-state items so autopilot can drive triage. Fallback items receive a fixed score penalty so they never outrank actionable items when those exist; the per-item fallback never fires for `audience='human'`. However, when `audience='human'` and the scan yields zero directions (nothing actionable, no PRs, no lock-stale, no unblock signal) and at least one item has a null Workflow State, a single aggregate `kind: 'triage'` direction (`issue`/`pr` both null, `signals.statelessCount` set) is returned instead of an empty list — callers switching on `kind` should tolerate unknown values. Returns `{ directions, fetchedAt, boardItems }` where `boardItems` is the raw count of items on the project board pre-filter (uniform across discovery tools); the returned `directions` array is bounded by `limit`. ENUMERATION MODE (GH-1551): pass `enumerate: 'human-queue'` to get the FULL ranked human queue — every direction the ranker would ever surface (plan-decision holds, human-needed unblocks, stale locks, PRs, actionable issues), unsliced. In this mode `limit` is ignored, `audience` is forced to 'human' server-side, `rank` runs 1..N over the whole list, and `plan-decision`/`human-needed-unblock` entries carry `signals.sourceCommentUrl` pointing at the source `## Decision Request`/`## Unblock Request` comment. The ONE canonical caller is `catch-up --mode brief` (GH-1553) — other callers should use the default ranked-top-N path and must NOT re-rank or re-filter enumeration output (epic #1550 contract: one scan, one ranking).",
    {
      owner: z
        .string()
        .optional()
        .describe("GitHub owner. Defaults to RALPH_GH_OWNER env var."),
      projectNumbers: z
        .array(z.coerce.number())
        .optional()
        .describe(
          "Project numbers to include. Defaults to RALPH_GH_PROJECT_NUMBERS or single configured project.",
        ),
      limit: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .default(3)
        .describe("Max directions to return (default: 3)."),
      audience: z
        .enum(["human", "agent"])
        .optional()
        .default("human")
        .describe(
          "Tilts scoring per consumer; agent penalizes large estimates to honor autonomous-loop XS/S preference (default: human).",
        ),
      stuckThresholdHours: z
        .number()
        .nonnegative()
        .optional()
        .default(48)
        .describe(
          "Hours before a non-lock issue is considered stale (default: 48, unit: hours). Shared with pipeline_dashboard.stuckThresholdHours — both pull from STUCK_THRESHOLD_HOURS in src/lib/thresholds.ts.",
        ),
      lockStaleHours: z
        .number()
        .nonnegative()
        .optional()
        .describe(
          "Hours before a lock-state issue is considered stalled (default: 24, unit: hours). Pulls from LOCK_STALE_HOURS in src/lib/thresholds.ts, overridable via the RALPH_LOCK_STALE_HOURS env var when this param is omitted (see resolveLockStaleHours). No zod `.default()` here deliberately — a schema default would make this param always defined and the env-var branch unreachable.",
        ),
      treeRecentDoneDays: z
        .number()
        .nonnegative()
        .optional()
        .default(7)
        .describe(
          "Days within which a sibling Done event still pulls a tree forward (default: 7, unit: days). Shares the RECENT_WINDOW_DAYS value with hygiene.staleDays, dashboard.doneWindowDays, and metrics.velocityWindowDays.",
        ),
      prStaleHours: z
        .number()
        .nonnegative()
        .optional()
        .default(24)
        .describe(
          "Hours before an open PR is considered stale (default: 24, unit: hours). Pulls from PR_STALE_HOURS in src/lib/thresholds.ts.",
        ),
      enumerate: z
        .enum(["human-queue"])
        .optional()
        .describe(
          "Set to 'human-queue' to return the FULL ranked human queue unsliced: ignores `limit`, forces `audience: 'human'` server-side, ranks 1..N over every returned entry. Canonical caller: catch-up --mode brief (GH-1553); other callers should use the default ranked-top-N path.",
        ),
    },
    async (args) => {
      return await runDirections({ ...args, audience: args.audience ?? "human" });
    },
  );
}
