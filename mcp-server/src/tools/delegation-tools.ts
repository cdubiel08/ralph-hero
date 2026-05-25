/**
 * Registers the `ralph_hero__delegation_stats` MCP tool. Pure read-only
 * surface over the JSONL audit log written by `ralph-delegate.sh` (F1).
 *
 * Follows the same registration convention as `activity-tools.ts`: no
 * GitHub client argument, defaults pulled from env var with a homedir
 * fallback, returns `toolSuccess` on missing-file (zero-state) so callers
 * can render a dashboard without an error path.
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  readDelegationLog,
  aggregateDelegationStats,
  defaultDelegationLogPath,
} from "../lib/delegation-log.js";
import { toolSuccess, toolError } from "../types.js";

const TOKENS_REASON =
  "F1 audit-log does not capture token usage; bytes used as a proxy";

export function registerDelegationTools(server: McpServer): void {
  server.tool(
    "ralph_hero__delegation_stats",
    "Read-only telemetry over the local ralph-delegate JSONL audit log. Returns per-task call counts, fallback counts (non-ok/non-dry_run), p50/p99 latency from successful calls, and bytes_in/bytes_out aggregates. Reads RALPH_DELEGATE_LOG_PATH (default ~/.ralph-hero/delegate.log). Missing log file returns a zero-state result, never errors.",
    {
      logPath: z
        .string()
        .optional()
        .describe(
          "Optional override for the JSONL log path. Defaults to RALPH_DELEGATE_LOG_PATH or ~/.ralph-hero/delegate.log.",
        ),
    },
    async (params) => {
      try {
        const resolvedPath = params.logPath ?? defaultDelegationLogPath();
        const read = await readDelegationLog({ logPath: resolvedPath });
        const stats = aggregateDelegationStats(read.events);

        return toolSuccess({
          logPath: read.logPath,
          fileExists: read.fileExists,
          totals: {
            calls: stats.totals.calls,
            fallbacks: stats.totals.fallbacks,
            bytesIn: stats.totals.bytesIn,
            bytesOut: stats.totals.bytesOut,
            skippedLines: read.skippedLines,
          },
          byTask: stats.byTask,
          tokensReason: TOKENS_REASON,
        });
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  );
}
