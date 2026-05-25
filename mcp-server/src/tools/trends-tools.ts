/**
 * MCP tools for project performance trends (Phase 1: snapshot capture).
 *
 * Phase 1 (GH-1022) registers `ralph_hero__capture_snapshot`, which
 * fetches the current dashboard + metrics and appends one row to the
 * partitioned JSONL file at
 * `~/.ralph-hero/snapshots/<owner>/<projectNumber>.jsonl`.
 *
 * Later phases (GH-1024 trend query, GH-1023 cycle-time enrichment)
 * register additional tools on the same module.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GitHubClient } from "../github-client.js";
import { FieldOptionCache } from "../lib/cache.js";
import { fetchDashboardItems } from "../lib/dashboard-fetch.js";
import { buildDashboard, DEFAULT_HEALTH_CONFIG } from "../lib/dashboard.js";
import {
  calculateMetrics,
  DEFAULT_METRICS_CONFIG,
} from "../lib/metrics.js";
import {
  appendSnapshot,
  fetchTransitionedIssues,
  readSnapshots,
  toSnapshot,
  type Snapshot,
} from "../lib/snapshots.js";
import { rollupCycleTimes } from "../lib/cycle-times.js";
import { parseDateMath } from "../lib/date-math.js";
import { computeTrends, type TrendSeries } from "../lib/trends.js";
import { resolveProjectOwner, toolError, toolSuccess } from "../types.js";

export function registerTrendsTools(
  server: McpServer,
  client: GitHubClient,
  fieldCache: FieldOptionCache,
): void {
  server.tool(
    "ralph_hero__capture_snapshot",
    "Capture a single point-in-time snapshot of the project dashboard + metrics and append it to the partitioned JSONL file at ~/.ralph-hero/snapshots/<owner>/<projectNumber>.jsonl. Fetches all project items (full project scan, no silent 500-cap) so per-phase WIP and totals reflect every item regardless of board position. Append-only, schema-versioned. Returns the snapshot row that was written.",
    {
      projectNumber: z
        .number()
        .optional()
        .describe(
          "Project number to capture. Defaults to RALPH_GH_PROJECT_NUMBER.",
        ),
      windowDays: z
        .number()
        .int()
        .positive()
        .default(7)
        .describe(
          "Velocity / highlights window in days (default: 7, unit: days). Shares the RECENT_WINDOW_DAYS value with hygiene.staleDays, dashboard.doneWindowDays, next_actions.treeRecentDoneDays, and metrics.velocityWindowDays.",
        ),
    },
    async (args) => {
      try {
        const owner = resolveProjectOwner(client.config);
        if (!owner) {
          return toolError(
            "RALPH_GH_OWNER and RALPH_GH_PROJECT_NUMBER required",
          );
        }

        const projectNumber =
          args.projectNumber ?? client.config.projectNumber;
        if (projectNumber === undefined) {
          return toolError(
            "RALPH_GH_OWNER and RALPH_GH_PROJECT_NUMBER required",
          );
        }

        const windowDays = args.windowDays ?? 7;

        const { items, warnings: fetchWarnings } = await fetchDashboardItems(
          client,
          fieldCache,
          projectNumber,
        );

        const data = buildDashboard(items, DEFAULT_HEALTH_CONFIG);
        const metrics = calculateMetrics(items, data, {
          ...DEFAULT_METRICS_CONFIG,
          velocityWindowDays: windowDays,
        });

        // Phase 2 (GH-1023): cycle-time enrichment.
        // Best-effort: fetch comments for Done-in-window items, parse
        // transition records, roll up percentiles. Failures are logged
        // inside fetchTransitionedIssues and never abort the snapshot.
        const now = Date.now();
        const cutoffMs = now - windowDays * 24 * 60 * 60 * 1000;
        const doneInWindow = items.filter((it) => {
          if (it.workflowState !== "Done" || !it.closedAt) return false;
          const ts = Date.parse(it.closedAt);
          return Number.isFinite(ts) && ts >= cutoffMs;
        });

        const transitioned = await fetchTransitionedIssues(client, doneInWindow);
        const rollup = rollupCycleTimes(transitioned, now);
        const includeCycleTime =
          rollup.sampleSize > 0 ||
          Object.keys(rollup.perPhaseDwellHours).length > 0;

        const snapshot = toSnapshot({
          owner,
          projectNumber,
          data,
          metrics,
          windowDays,
          ...(includeCycleTime ? { cycleTime: rollup } : {}),
        });

        await appendSnapshot(snapshot);

        return toolSuccess({
          ...snapshot,
          ...(fetchWarnings.length > 0 ? { fetchWarnings } : {}),
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to capture snapshot: ${message}`);
      }
    },
  );

  server.tool(
    "ralph_hero__metrics_trends",
    "Read local snapshot JSONL and return 1d/7d/30d deltas plus sparklines for velocity, riskScore, wipTotal, leadTimeP50Hours.",
    {
      projectNumber: z
        .number()
        .optional()
        .describe(
          "Project number to query. Defaults to RALPH_GH_PROJECT_NUMBER.",
        ),
      since: z
        .string()
        .nullable()
        .default(null)
        .describe(
          "Lower bound for the trend window. Accepts ISO dates or @today-Nd / @now-Nh date-math. Defaults to the last 30 days.",
        ),
      format: z
        .enum(["json", "markdown"])
        .default("json")
        .describe("Output format. `markdown` embeds sparklines per metric."),
    },
    async (args) => {
      try {
        const owner = resolveProjectOwner(client.config);
        if (!owner) {
          return toolError(
            "RALPH_GH_OWNER and RALPH_GH_PROJECT_NUMBER required",
          );
        }

        const projectNumber =
          args.projectNumber ?? client.config.projectNumber;
        if (projectNumber === undefined) {
          return toolError(
            "RALPH_GH_OWNER and RALPH_GH_PROJECT_NUMBER required",
          );
        }

        const sinceDate = args.since
          ? parseDateMath(args.since)
          : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

        let snapshots: Snapshot[];
        try {
          snapshots = await readSnapshots(owner, projectNumber, sinceDate);
        } catch (e) {
          if (
            e &&
            typeof e === "object" &&
            "code" in e &&
            (e as { code: string }).code === "ENOENT"
          ) {
            snapshots = [];
          } else {
            throw e;
          }
        }

        const now = Date.now();
        const series = computeTrends(snapshots, now);

        if (args.format === "markdown") {
          const markdown = renderTrendsMarkdown(series, owner, projectNumber);
          return toolSuccess({ markdown });
        }

        return toolSuccess({
          owner,
          projectNumber,
          since: sinceDate.toISOString(),
          now: new Date(now).toISOString(),
          series,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to compute trends: ${message}`);
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Markdown rendering (Phase 3, GH-1024)
// ---------------------------------------------------------------------------

const METRIC_LABEL_WIDTH = 18;

function renderTrendsMarkdown(
  series: TrendSeries[],
  owner: string,
  projectNumber: number,
): string {
  const totalPoints = series.reduce((acc, s) => acc + s.points.length, 0);
  if (totalPoints === 0) {
    return `No snapshots yet for ${owner}/${projectNumber}.`;
  }

  const lines: string[] = [];
  for (const s of series) {
    const label = `${s.metric}:`.padEnd(METRIC_LABEL_WIDTH, " ");
    const last = s.points.length > 0 ? s.points[s.points.length - 1].value : null;
    const current = formatValue(last);
    const d1 = formatDelta(s.delta1d);
    const d7 = formatDelta(s.delta7d);
    const d30 = formatDelta(s.delta30d);
    const spark = s.sparkline ?? "";
    lines.push(
      `${label}${current}  Δ1d=${d1}  Δ7d=${d7}  Δ30d=${d30}  ${spark}`.trimEnd(),
    );
  }
  return lines.join("\n");
}

function formatValue(v: number | null): string {
  if (v === null) return "n/a";
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

function formatDelta(v: number | null): string {
  if (v === null) return "n/a";
  const formatted = Number.isInteger(v) ? String(Math.abs(v)) : Math.abs(v).toFixed(2);
  if (v > 0) return `+${formatted}`;
  if (v < 0) return `-${formatted}`;
  return "+0";
}
