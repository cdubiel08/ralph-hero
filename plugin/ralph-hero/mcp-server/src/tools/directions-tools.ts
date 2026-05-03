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

interface OpenPRArg {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  reviewDecision: string | null;
  headRefName: string;
  createdAt: string;
}

interface RunDirectionsArgs {
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
// and `next_actions` (current) can route through the same code path. Keep
// file-private (no export) — alias lives in this same file.
// ---------------------------------------------------------------------------

function makeRunDirections(client: GitHubClient, fieldCache: FieldOptionCache) {
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
    "[DEPRECATED — use ralph_hero__next_actions instead. Removed in 2.7.0.] Compute up to N deterministic 'directions' for the hello skill's session briefing.",
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
    "Compute up to N deterministic 'directions' (next actions) with one flagged `recommended: true`. Used by the /hello skill picker (interactive) and by headless orchestrators (auto-select recommended). Open PRs must be passed in as a parameter.",
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
