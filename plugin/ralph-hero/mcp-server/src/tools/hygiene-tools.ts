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
import {
  buildHygieneReport,
  formatHygieneMarkdown,
  type HygieneConfig,
  DEFAULT_HYGIENE_CONFIG,
} from "../lib/hygiene.js";
import { fetchDashboardItems } from "../lib/dashboard-fetch.js";
import type { DashboardItem } from "../lib/dashboard.js";
import {
  toolSuccess,
  toolError,
  resolveProjectOwner,
  resolveProjectNumbers,
} from "../types.js";

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
    "Generate a project board hygiene report. Identifies archive candidates, stale items, orphaned backlog entries, missing fields, WIP violations, and duplicate candidates. Returns: report with 7 sections + summary stats.",
    {
      owner: z
        .string()
        .optional()
        .describe("GitHub owner. Defaults to env var"),
      projectNumbers: z
        .array(z.coerce.number())
        .optional()
        .describe(
          "Project numbers to include. Defaults to RALPH_GH_PROJECT_NUMBERS or single configured project.",
        ),
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
      similarityThreshold: z
        .number()
        .optional()
        .default(0.8)
        .describe(
          "Similarity threshold for duplicate detection (0.5-1.0, default: 0.8)",
        ),
      format: z
        .enum(["json", "markdown"])
        .optional()
        .default("json")
        .describe("Output format (default: json)"),
    },
    async (args) => {
      try {
        const owner = args.owner || resolveProjectOwner(client.config);
        if (!owner) {
          return toolError("owner is required");
        }

        // Resolve project numbers
        const projectNumbers =
          args.projectNumbers ?? resolveProjectNumbers(client.config);

        if (projectNumbers.length === 0) {
          return toolError(
            "No project numbers configured. Set RALPH_GH_PROJECT_NUMBER or RALPH_GH_PROJECT_NUMBERS.",
          );
        }

        // Fetch items from all projects via the shared helper. We mirror
        // the dashboard tool: when an explicit `projectNumbers` argument
        // is provided, iterate one project at a time so the helper hits
        // exactly the requested set; otherwise let the helper read the
        // configured project list once.
        const allItems: DashboardItem[] = [];
        const fetchWarnings: string[] = [];

        if (args.projectNumbers && args.projectNumbers.length > 0) {
          for (const pn of args.projectNumbers) {
            const { items, warnings } = await fetchDashboardItems(
              client,
              fieldCache,
              pn,
            );
            allItems.push(...items);
            fetchWarnings.push(...warnings);
          }
        } else {
          const { items, warnings } = await fetchDashboardItems(
            client,
            fieldCache,
          );
          allItems.push(...items);
          fetchWarnings.push(...warnings);
        }

        // Build hygiene config
        const hygieneConfig: HygieneConfig = {
          ...DEFAULT_HYGIENE_CONFIG,
          archiveDays: args.archiveDays ?? 14,
          staleDays: args.staleDays ?? 7,
          orphanDays: args.orphanDays ?? 14,
          wipLimits: args.wipLimits ?? {},
          similarityThreshold: args.similarityThreshold ?? 0.8,
        };

        // Build report from merged items
        const report = buildHygieneReport(allItems, hygieneConfig);

        // Format output
        if (args.format === "markdown") {
          return toolSuccess({
            ...report,
            formatted: formatHygieneMarkdown(report),
            ...(fetchWarnings.length > 0 ? { fetchWarnings } : {}),
          });
        }

        return toolSuccess({
          ...report,
          ...(fetchWarnings.length > 0 ? { fetchWarnings } : {}),
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to generate hygiene report: ${message}`);
      }
    },
  );
}
