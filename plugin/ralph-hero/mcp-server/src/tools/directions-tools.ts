/**
 * MCP tools wrapping the pure ranker at `lib/directions.ts`.
 *
 * Exposes two tools that share a single implementation:
 *   - `ralph_hero__next_actions` (current name; accepts `audience` param)
 *   - `ralph_hero__hello_directions` (DEPRECATED alias; fixed at audience="human")
 *
 * Both return a fixed-shape JSON payload with up to N ranked "directions"
 * for the `hello` skill's session briefing. The skill is responsible for
 * fetching open PRs (via `gh pr list`) and passing them in as a parameter
 * — the MCP server does not itself open an Octokit-style PR API surface.
 *
 * Behaviour:
 *   1. Resolve owner + project numbers from args or client config.
 *   2. For each project, ensure the field cache is populated, then
 *      paginate `DASHBOARD_ITEMS_QUERY` to gather up to 500 items.
 *   3. Convert raw items to `DashboardItem[]` via `toDashboardItems`.
 *   4. Build a `RankConfig` from the args + defaults (with injected `now`).
 *   5. Compute each PR's `ageHours` at the boundary and call
 *      `rankDirections(allItems, enrichedPRs, config)`.
 *   6. Return `{ directions, fetchedAt, totalCandidates }`.
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
// Shared schema fragments
// ---------------------------------------------------------------------------

const openPRSchema = z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  isDraft: z.boolean(),
  reviewDecision: z
    .string()
    .nullable()
    .describe("REVIEW_REQUIRED | APPROVED | CHANGES_REQUESTED | null"),
  headRefName: z.string(),
  createdAt: z.string().describe("ISO timestamp from gh pr list"),
});

// ---------------------------------------------------------------------------
// Shared params type — both tools accept (almost) the same shape.
// `audience` is internal; callers only pass it via the `next_actions` tool.
// ---------------------------------------------------------------------------

export interface OpenPRArg {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  reviewDecision: string | null;
  headRefName: string;
  createdAt: string;
}

export interface RunDirectionsArgs {
  owner?: string;
  projectNumbers?: number[];
  limit?: number;
  stuckThresholdHours?: number;
  lockStaleHours?: number;
  treeRecentDoneDays?: number;
  prStaleHours?: number;
  openPRs?: OpenPRArg[];
  audience: Audience;
}

// ---------------------------------------------------------------------------
// Shared implementation — extracted so both `hello_directions` (deprecated)
// and `next_actions` (current) can route through the same code path. Also
// exported so the deprecated `pick_actionable_issue` wrapper in
// `issue-tools.ts` can delegate without duplicating the data-fetch +
// scoring pipeline.
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

      // Compute PR ageHours at the boundary so the lib never reads the wall clock.
      const enrichedPRs: OpenPR[] = (args.openPRs ?? []).map((pr) => {
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
        totalCandidates: allItems.length,
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
    "ralph_hero__hello_directions",
    "[DEPRECATED — use ralph_hero__next_actions instead. Removed in 2.7.0.] Compute up to N deterministic 'directions' for the hello skill's session briefing. Each direction includes a structured signals object (staleDays, staleThresholdDays, tiedAtScore, estimateWeight, parentChainNote) for skills to synthesize prose. The legacy 'reason' string is @deprecated and removed in 2.7.0.",
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
      stuckThresholdHours: z
        .number()
        .nonnegative()
        .optional()
        .default(48)
        .describe(
          "Hours before a non-lock issue is considered stale (default: 48).",
        ),
      lockStaleHours: z
        .number()
        .nonnegative()
        .optional()
        .default(24)
        .describe(
          "Hours before a lock-state issue is considered stalled (default: 24).",
        ),
      treeRecentDoneDays: z
        .number()
        .nonnegative()
        .optional()
        .default(7)
        .describe(
          "Days within which a sibling Done event still pulls a tree forward (default: 7).",
        ),
      prStaleHours: z
        .number()
        .nonnegative()
        .optional()
        .default(24)
        .describe(
          "Hours before an open PR is considered stale (default: 24).",
        ),
      openPRs: z
        .array(openPRSchema)
        .optional()
        .default([])
        .describe(
          "Open PRs gathered by the caller (e.g. via `gh pr list`). Drafts and APPROVED PRs are filtered internally.",
        ),
    },
    async (args) => {
      return await runDirections({ ...args, audience: "human" });
    },
  );

  server.tool(
    "ralph_hero__next_actions",
    "Compute up to N deterministic 'directions' (next actions) with one flagged `recommended: true`. Used by the /hello skill picker (interactive) and by headless orchestrators (auto-select recommended). Open PRs must be passed in as a parameter. Each direction includes a structured signals object (staleDays, staleThresholdDays, tiedAtScore, estimateWeight, parentChainNote) for skills to synthesize prose. The legacy 'reason' string is @deprecated and removed in 2.7.0.",
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
          "Hours before a non-lock issue is considered stale (default: 48).",
        ),
      lockStaleHours: z
        .number()
        .nonnegative()
        .optional()
        .default(24)
        .describe(
          "Hours before a lock-state issue is considered stalled (default: 24).",
        ),
      treeRecentDoneDays: z
        .number()
        .nonnegative()
        .optional()
        .default(7)
        .describe(
          "Days within which a sibling Done event still pulls a tree forward (default: 7).",
        ),
      prStaleHours: z
        .number()
        .nonnegative()
        .optional()
        .default(24)
        .describe(
          "Hours before an open PR is considered stale (default: 24).",
        ),
      openPRs: z
        .array(openPRSchema)
        .optional()
        .default([])
        .describe(
          "Open PRs gathered by the caller (e.g. via `gh pr list`). Drafts and APPROVED PRs are filtered internally.",
        ),
    },
    async (args) => {
      return await runDirections({ ...args, audience: args.audience ?? "human" });
    },
  );
}
