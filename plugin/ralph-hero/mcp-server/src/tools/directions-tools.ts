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
import { paginateConnection } from "../lib/pagination.js";
import {
  DASHBOARD_ITEMS_QUERY,
  toDashboardItems,
  type RawDashboardItem,
} from "./dashboard-tools.js";
import type { DashboardItem } from "../lib/dashboard.js";
import {
  rankDirections,
  DEFAULT_RANK_CONFIG,
  type Audience,
  type OpenPR,
  type RankConfig,
  type UnblockSignal,
  type UnblockSignalMap,
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
              nodes { body createdAt }
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

  return { unblockRequestAgeDays, questionCount };
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
 * draft items) are skipped. Returns deterministic order (sorted) so the
 * downstream search query is stable.
 */
function uniqueRepos(items: DashboardItem[]): string[] {
  const seen = new Set<string>();
  for (const item of items) {
    if (item.repository) seen.add(item.repository);
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
          { maxItems: 500 },
        );

        allItems.push(...toDashboardItems(result.nodes, pn));
      }

      // Compute unblock signals for any Human Needed candidates so the
      // ranker can surface `human-needed-unblock` directions. Comments are
      // fetched at the boundary; the ranker stays pure.
      const unblockSignals = await buildUnblockSignalMap(client, allItems, now);

      // Build the RankConfig from args + defaults + injected `now`.
      const config: RankConfig = {
        limit: args.limit ?? DEFAULT_RANK_CONFIG.limit,
        stuckThresholdHours:
          args.stuckThresholdHours ?? DEFAULT_RANK_CONFIG.stuckThresholdHours,
        lockStaleHours:
          args.lockStaleHours ?? DEFAULT_RANK_CONFIG.lockStaleHours,
        treeRecentDoneDays:
          args.treeRecentDoneDays ?? DEFAULT_RANK_CONFIG.treeRecentDoneDays,
        prStaleHours:
          args.prStaleHours ?? DEFAULT_RANK_CONFIG.prStaleHours,
        audience: args.audience,
        now,
        unblockSignals,
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

      const directions = rankDirections(allItems, enrichedPRs, config);

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
    "Compute up to N deterministic 'directions' (next actions) with one flagged `recommended: true`. Used by the /hello skill picker (interactive) and by headless orchestrators (auto-select recommended). Open PRs are fetched internally via the configured GitHub token's `repo` scope (one `is:pr is:open repo:owner/name` GraphQL search per unique repo represented in the project items) — callers no longer pass an `openPRs` argument. Each direction includes a structured signals object (staleDays, staleThresholdDays, tiedAtScore, estimateWeight, parentChainNote) for skills to synthesize prose. The legacy 'reason' string is @deprecated and removed in 2.7.0. When `audience='agent'` and no items are in actionable phases (Plan in Review, In Review, Ready for Plan, Research Needed) or otherwise surfacing (lock-stale, unblock-requested), the picker falls back to Backlog and null-state items so autopilot can drive triage. Fallback items receive a fixed score penalty so they never outrank actionable items when those exist; the fallback never fires for `audience='human'`. Returns `{ directions, fetchedAt, boardItems }` where `boardItems` is the raw count of items on the project board pre-filter (uniform across discovery tools); the returned `directions` array is bounded by `limit`.",
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
        .default(24)
        .describe(
          "Hours before a lock-state issue is considered stalled (default: 24, unit: hours). Pulls from LOCK_STALE_HOURS in src/lib/thresholds.ts.",
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
    },
    async (args) => {
      return await runDirections({ ...args, audience: args.audience ?? "human" });
    },
  );
}
