/**
 * MCP tool for project board hygiene reporting.
 *
 * Provides a single `ralph_hero__project_hygiene` tool that
 * identifies archive candidates, stale items, orphaned entries,
 * field gaps, and WIP violations.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GitHubClient } from "../github-client.js";
import { FieldOptionCache } from "../lib/cache.js";
import { paginateConnection } from "../lib/pagination.js";
import { ensureFieldCache } from "../lib/helpers.js";
import {
  buildHygieneReport,
  formatHygieneMarkdown,
  type HygieneConfig,
  DEFAULT_HYGIENE_CONFIG,
} from "../lib/hygiene.js";
import {
  DASHBOARD_ITEMS_QUERY,
  toDashboardItems,
  type RawDashboardItem,
} from "./dashboard-tools.js";
import { toolSuccess, toolError, resolveProjectOwner } from "../types.js";

// ---------------------------------------------------------------------------
// Register hygiene tools
// ---------------------------------------------------------------------------

export function registerHygieneTools(
  server: McpServer,
  client: GitHubClient,
  fieldCache: FieldOptionCache,
): void {
  server.tool(
    "ralph_hero__project_hygiene",
    "Generate a project board hygiene report. Identifies archive candidates, stale items, orphaned backlog entries, missing fields, and WIP violations. Returns: report with 6 sections + summary stats.",
    {
      owner: z
        .string()
        .optional()
        .describe("GitHub owner. Defaults to env var"),
      archiveDays: z
        .number()
        .optional()
        .default(14)
        .describe(
          "Days before Done/Canceled items become archive candidates (default: 14)",
        ),
      staleDays: z
        .number()
        .optional()
        .default(7)
        .describe(
          "Days before non-terminal items are flagged as stale (default: 7)",
        ),
      orphanDays: z
        .number()
        .optional()
        .default(14)
        .describe(
          "Days before unassigned Backlog items are flagged as orphaned (default: 14)",
        ),
      wipLimits: z
        .record(z.coerce.number())
        .optional()
        .describe('Per-state WIP limits, e.g. { "In Progress": 3 }'),
      format: z
        .enum(["json", "markdown"])
        .optional()
        .default("json")
        .describe("Output format (default: json)"),
    },
    async (args) => {
      try {
        const owner = args.owner || resolveProjectOwner(client.config);
        const projectNumber = client.config.projectNumber;

        if (!owner) {
          return toolError("owner is required");
        }
        if (!projectNumber) {
          return toolError("project number is required");
        }

        // Ensure field cache
        await ensureFieldCache(client, fieldCache, owner, projectNumber);

        const projectId = fieldCache.getProjectId();
        if (!projectId) {
          return toolError("Could not resolve project ID");
        }

        // Fetch all project items (reuse dashboard query)
        const result = await paginateConnection<RawDashboardItem>(
          (q, v) => client.projectQuery(q, v),
          DASHBOARD_ITEMS_QUERY,
          { projectId, first: 100 },
          "node.items",
          { maxItems: 500 },
        );

        // Convert to dashboard items
        const dashboardItems = toDashboardItems(result.nodes);

        // Build hygiene config
        const hygieneConfig: HygieneConfig = {
          ...DEFAULT_HYGIENE_CONFIG,
          archiveDays: args.archiveDays ?? 14,
          staleDays: args.staleDays ?? 7,
          orphanDays: args.orphanDays ?? 14,
          wipLimits: args.wipLimits ?? {},
        };

        // Build report
        const report = buildHygieneReport(dashboardItems, hygieneConfig);

        // Format output
        if (args.format === "markdown") {
          return toolSuccess({
            ...report,
            formatted: formatHygieneMarkdown(report),
          });
        }

        return toolSuccess(report);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to generate hygiene report: ${message}`);
      }
    },
  );
}
