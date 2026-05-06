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
  toSnapshot,
} from "../lib/snapshots.js";
import { rollupCycleTimes } from "../lib/cycle-times.js";
import { resolveProjectOwner, toolError, toolSuccess } from "../types.js";

export function registerTrendsTools(
  server: McpServer,
  client: GitHubClient,
  fieldCache: FieldOptionCache,
): void {
  server.tool(
    "ralph_hero__capture_snapshot",
    "Capture a single point-in-time snapshot of the project dashboard + metrics and append it to the partitioned JSONL file at ~/.ralph-hero/snapshots/<owner>/<projectNumber>.jsonl. Append-only, schema-versioned. Returns the snapshot row that was written.",
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
          "Velocity / highlights window in days (default: 7).",
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
}
