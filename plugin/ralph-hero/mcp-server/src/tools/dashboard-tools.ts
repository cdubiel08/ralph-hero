/**
 * MCP tool for pipeline dashboard and status visualization.
 *
 * Provides a single `ralph_hero__pipeline_dashboard` tool that
 * aggregates project items by workflow phase, detects health issues,
 * and formats output as JSON, markdown, or ASCII.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GitHubClient } from "../github-client.js";
import { FieldOptionCache } from "../lib/cache.js";
import {
  buildDashboard,
  formatMarkdown,
  formatAscii,
  groupDashboardItemsByRepo,
  type DashboardItem,
  type HealthConfig,
  DEFAULT_HEALTH_CONFIG,
} from "../lib/dashboard.js";
import {
  fetchDashboardItems,
  DASHBOARD_ITEMS_QUERY,
  toDashboardItems,
  type RawDashboardItem,
} from "../lib/dashboard-fetch.js";
import { toolSuccess, toolError, resolveProjectOwner, resolveProjectNumbers } from "../types.js";
import { detectWorkStreams, type IssueFileOwnership } from "../lib/work-stream-detection.js";
import { detectStreamPipelinePositions, type IssueState } from "../lib/pipeline-detection.js";
import {
  calculateMetrics,
  DEFAULT_METRICS_CONFIG,
  type MetricsConfig,
} from "../lib/metrics.js";

// Re-export for backwards compatibility — tests + downstream tools used to
// pull these symbols straight out of dashboard-tools.ts before they were
// hoisted into lib/dashboard-fetch.ts.
export { DASHBOARD_ITEMS_QUERY, toDashboardItems, type RawDashboardItem };

// ---------------------------------------------------------------------------
// Register dashboard tools
// ---------------------------------------------------------------------------

export function registerDashboardTools(
  server: McpServer,
  client: GitHubClient,
  fieldCache: FieldOptionCache,
): void {
  server.tool(
    "ralph_hero__pipeline_dashboard",
    "Generate pipeline status dashboard with issue counts per workflow phase, health indicators, and formatted output. Returns structured data with optional markdown or ASCII rendering. Top-level `boardItems` is the raw count of all project items including PRs (uniform across discovery tools — next_actions, pipeline_dashboard, project_hygiene). Per-phase `count` values reflect that phase's bucket; for `Done` and `Canceled`, the count is bounded by `doneWindowDays` (default 7) and may be smaller than the actual phase membership. Per-iteration `totalIssues` is a distinct concept (iteration-scoped count).",
    {
      owner: z
        .string()
        .optional()
        .describe("GitHub owner. Defaults to GITHUB_OWNER env var"),
      projectNumbers: z
        .array(z.coerce.number())
        .optional()
        .describe(
          "Project numbers to include. Defaults to RALPH_GH_PROJECT_NUMBERS or single configured project.",
        ),
      format: z
        .enum(["json", "markdown", "ascii"])
        .optional()
        .default("json")
        .describe("Output format (default: json)"),
      includeHealth: z
        .boolean()
        .optional()
        .default(true)
        .describe("Include health indicators (default: true)"),
      stuckThresholdHours: z
        .number()
        .optional()
        .default(48)
        .describe(
          "Hours before flagging stuck issues (default: 48, unit: hours). Shared with next_actions.stuckThresholdHours — both pull from STUCK_THRESHOLD_HOURS in src/lib/thresholds.ts.",
        ),
      wipLimits: z
        .record(z.coerce.number())
        .optional()
        .describe(
          'Per-state WIP limits, e.g. { "In Progress": 3 }',
        ),
      doneWindowDays: z
        .number()
        .optional()
        .default(7)
        .describe(
          "Only show Done issues from last N days (default: 7, unit: days). Shares the RECENT_WINDOW_DAYS value with hygiene.staleDays, next_actions.treeRecentDoneDays, and metrics.velocityWindowDays.",
        ),
      issuesPerPhase: z
        .number()
        .optional()
        .default(10)
        .describe("Max issues to list per phase (default: 10)"),
      includeMetrics: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Include velocity metrics, risk score, and auto-status (default: false)",
        ),
      velocityWindowDays: z
        .number()
        .optional()
        .default(7)
        .describe(
          "Days to look back for velocity calculation (default: 7, unit: days). Shares the RECENT_WINDOW_DAYS value with hygiene.staleDays, dashboard.doneWindowDays, and next_actions.treeRecentDoneDays.",
        ),
      atRiskThreshold: z
        .number()
        .optional()
        .default(2)
        .describe(
          "Risk score threshold for AT_RISK status (default: 2, unit: count). Pulls from AT_RISK_THRESHOLD in src/lib/thresholds.ts.",
        ),
      offTrackThreshold: z
        .number()
        .optional()
        .default(6)
        .describe(
          "Risk score threshold for OFF_TRACK status (default: 6, unit: count). Pulls from OFF_TRACK_THRESHOLD in src/lib/thresholds.ts.",
        ),
      archiveAgeDays: z
        .number()
        .optional()
        .default(14)
        .describe(
          "Days in Done/Canceled before eligible for archive (default: 14, unit: days). Same concept as project_hygiene.archiveAgeDays — both renamed from the legacy archiveThresholdDays/archiveDays pair so the value is shared across discovery tools.",
        ),
      streams: z
        .array(
          z.object({
            id: z.string(),
            issues: z.array(z.number()),
            sharedFiles: z.array(z.string()),
            primaryIssue: z.number(),
          }),
        )
        .optional()
        .describe(
          "Pre-computed stream assignments from detect_work_streams. When provided, dashboard includes a Streams section.",
        ),
      groupBy: z
        .enum(["repo"])
        .optional()
        .describe(
          "Group dashboard output by dimension. 'repo' groups items by repository within the project.",
        ),
    },
    async (args) => {
      try {
        const owner = args.owner || resolveProjectOwner(client.config);
        if (!owner) {
          return toolError("owner is required");
        }

        // Resolve project numbers
        const projectNumbers = args.projectNumbers
          ?? resolveProjectNumbers(client.config);

        if (projectNumbers.length === 0) {
          return toolError(
            "No project numbers configured. Set RALPH_GH_PROJECT_NUMBER or RALPH_GH_PROJECT_NUMBERS.",
          );
        }

        // Fetch items from all projects via the shared helper. We pass
        // projectNumber=undefined and let the helper read the configured
        // project list, but if the caller passed an explicit
        // `projectNumbers` argument we iterate one at a time so the
        // helper hits exactly the requested set.
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

        // Build health config
        const healthConfig: HealthConfig = {
          ...DEFAULT_HEALTH_CONFIG,
          stuckThresholdHours: args.stuckThresholdHours ?? 48,
          criticalStuckHours: (args.stuckThresholdHours ?? 48) * 2,
          wipLimits: args.wipLimits ?? {},
          doneWindowDays: args.doneWindowDays ?? 7,
          archiveAgeDays: args.archiveAgeDays ?? 14,
        };

        // Build dashboard from merged items
        const dashboard = buildDashboard(allItems, healthConfig, undefined, args.streams);

        // Strip health if not requested
        if (!args.includeHealth) {
          dashboard.health = { ok: true, warnings: [] };
        }

        // Truncate issue lists per phase
        const issuesPerPhase = args.issuesPerPhase ?? 10;
        for (const phase of dashboard.phases) {
          phase.issues = phase.issues.slice(0, issuesPerPhase);
        }

        // If groupBy=repo, build per-repo sub-dashboards
        if (args.groupBy === "repo") {
          const repoGroups = groupDashboardItemsByRepo(allItems);

          if (args.format === "markdown") {
            let md = "# Pipeline Dashboard (by repo)\n\n";
            for (const [repoName, repoItems] of Object.entries(repoGroups)) {
              const sub = buildDashboard(repoItems, healthConfig);
              md += `## ${repoName} (${repoItems.length} items)\n\n`;
              md += formatMarkdown(sub) + "\n\n";
            }
            return toolSuccess({ markdown: md });
          }

          if (args.format === "ascii") {
            let ascii = "Pipeline Dashboard (by repo)\n\n";
            for (const [repoName, repoItems] of Object.entries(repoGroups)) {
              const sub = buildDashboard(repoItems, healthConfig);
              ascii += `=== ${repoName} (${repoItems.length} items) ===\n`;
              ascii += formatAscii(sub) + "\n\n";
            }
            return toolSuccess({ ascii });
          }

          // JSON format
          const repoResults: Record<string, unknown> = {};
          for (const [repoName, repoItems] of Object.entries(repoGroups)) {
            repoResults[repoName] = buildDashboard(repoItems, healthConfig);
          }
          return toolSuccess({ groupBy: "repo", repos: repoResults });
        }

        // Compute metrics if requested
        let metrics: ReturnType<typeof calculateMetrics> | undefined;
        if (args.includeMetrics) {
          const metricsConfig: MetricsConfig = {
            ...DEFAULT_METRICS_CONFIG,
            velocityWindowDays: args.velocityWindowDays ?? 7,
            atRiskThreshold: args.atRiskThreshold ?? 2,
            offTrackThreshold: args.offTrackThreshold ?? 6,
          };
          metrics = calculateMetrics(
            allItems,
            dashboard,
            metricsConfig,
          );
        }

        // Format output
        const format = args.format ?? "json";
        let formatted: string | undefined;

        if (format === "markdown") {
          formatted = formatMarkdown(dashboard, issuesPerPhase);
        } else if (format === "ascii") {
          formatted = formatAscii(dashboard);
        }

        return toolSuccess({
          ...dashboard,
          ...(formatted !== undefined ? { formatted } : {}),
          ...(metrics !== undefined ? { metrics } : {}),
          ...(fetchWarnings.length > 0 ? { fetchWarnings } : {}),
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to generate dashboard: ${message}`);
      }
    },
  );

  // -------------------------------------------------------------------------
  // ralph_hero__detect_stream_positions
  // -------------------------------------------------------------------------
  server.tool(
    "ralph_hero__detect_stream_positions",
    "Combined work-stream detection + per-stream pipeline position detection. Takes issue file ownership data and issue workflow states, clusters issues into streams, then detects the pipeline phase for each stream independently.",
    {
      issues: z
        .array(
          z.object({
            number: z.number().describe("Issue number"),
            files: z
              .array(z.string())
              .describe("Will Modify file paths from research doc"),
            blockedBy: z
              .array(z.number())
              .describe("GitHub blockedBy issue numbers"),
          }),
        )
        .describe("List of issues with their file ownership and dependencies"),
      issueStates: z
        .array(
          z.object({
            number: z.number().describe("Issue number"),
            title: z.string().describe("Issue title"),
            workflowState: z.string().describe("Current workflow state"),
            estimate: z.string().nullable().describe("Estimate (XS/S/M/L/XL)"),
            subIssueCount: z
              .number()
              .optional()
              .default(0)
              .describe("Number of sub-issues"),
          }),
        )
        .describe("Workflow state data for each issue"),
    },
    async (args) => {
      try {
        const ownership: IssueFileOwnership[] = args.issues.map((i) => ({
          number: i.number,
          files: i.files,
          blockedBy: i.blockedBy,
        }));

        const streamResult = detectWorkStreams(ownership);

        const states: IssueState[] = args.issueStates.map((s) => ({
          number: s.number,
          title: s.title,
          workflowState: s.workflowState,
          estimate: s.estimate,
          subIssueCount: s.subIssueCount ?? 0,
        }));

        const positions = detectStreamPipelinePositions(
          streamResult.streams,
          states,
          { autoMode: client.config.autoMode },
        );

        // Aggregate roster: max analyst/integrator across streams, stream-count-based builder
        const suggestedRoster = positions.length > 0
          ? {
              analyst: Math.max(...positions.map(p => p.position.suggestedRoster.analyst)),
              builder: Math.min(streamResult.totalStreams, 3),
              integrator: Math.max(...positions.map(p => p.position.suggestedRoster.integrator)),
            }
          : { analyst: 0, builder: 0, integrator: 0 };

        return toolSuccess({
          streams: positions,
          totalStreams: streamResult.totalStreams,
          totalIssues: streamResult.totalIssues,
          rationale: streamResult.rationale,
          suggestedRoster,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to detect stream positions: ${message}`);
      }
    },
  );
}
