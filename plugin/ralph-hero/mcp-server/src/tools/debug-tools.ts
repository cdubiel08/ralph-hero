/**
 * MCP tools for debug log collation and statistics.
 *
 * Provides:
 *   - `ralph_hero__collate_debug` (v2 — queries Langfuse for error spans,
 *     groups by normalized signature, returns the grouped report; GitHub
 *     issue creation lands in Phase 3b / GH-1100)
 *   - `ralph_hero__debug_stats` (v1 — aggregates JSONL logs; preserved for
 *     backward compat, not extended)
 *
 * Only registered when `RALPH_DEBUG=true`. JSONL helpers below still back
 * `debug_stats`; the new Langfuse path is fully separate.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GitHubClient } from "../github-client.js";
import { toolSuccess, toolError } from "../types.js";
import { zBoolish } from "../lib/zod-helpers.js";
import {
  createLangfuseClient,
  type LangfuseClient,
} from "../lib/langfuse-client.js";
import {
  groupSpansBySignature,
  observationToSpan,
} from "../lib/error-signature.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LogEvent {
  ts: string;
  cat: "tool" | "graphql" | "hook" | "session";
  tool?: string;
  operation?: string;
  hook?: string;
  ok?: boolean;
  blocked?: boolean;
  exitCode?: number;
  error?: string;
  durationMs?: number;
  [key: string]: unknown;
}

interface ErrorGroup {
  signature: string;
  hash: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  sample: LogEvent;
}

interface StatsGroup {
  calls: number;
  errors: number;
  errorRate: number;
  avgDurationMs: number;
  totalDurationMs: number;
}

// ---------------------------------------------------------------------------
// JSONL Parsing
// ---------------------------------------------------------------------------

/**
 * Read and parse all JSONL log files matching the time window.
 */
export async function readLogEvents(
  logDir: string,
  since: Date,
): Promise<{ events: LogEvent[]; sessionsAnalyzed: number }> {
  let files: string[];
  try {
    files = await readdir(logDir);
  } catch {
    return { events: [], sessionsAnalyzed: 0 };
  }

  const jsonlFiles = files
    .filter((f) => f.startsWith("session-") && f.endsWith(".jsonl"))
    .sort();

  const events: LogEvent[] = [];
  let sessionsAnalyzed = 0;

  for (const file of jsonlFiles) {
    const content = await readFile(join(logDir, file), "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);

    let fileHasEvents = false;
    for (const line of lines) {
      try {
        const event = JSON.parse(line) as LogEvent;
        if (new Date(event.ts) >= since) {
          events.push(event);
          fileHasEvents = true;
        }
      } catch {
        // Skip malformed lines
      }
    }

    if (fileHasEvents) sessionsAnalyzed++;
  }

  return { events, sessionsAnalyzed };
}

// ---------------------------------------------------------------------------
// Error Collation
// ---------------------------------------------------------------------------

function isErrorEvent(event: LogEvent): boolean {
  return (
    event.ok === false ||
    event.blocked === true ||
    (event.exitCode !== undefined && event.exitCode !== 0)
  );
}

function normalizeErrorMessage(msg: string): string {
  // Strip variable parts: numbers, hashes, timestamps, UUIDs
  return msg
    .replace(/\b[0-9a-f]{8,}\b/gi, "<HASH>")
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[.\dZ]*/g, "<TS>")
    .replace(/\b\d+\b/g, "<N>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

function getEventName(event: LogEvent): string {
  return event.tool ?? event.operation ?? event.hook ?? "unknown";
}

function getErrorType(event: LogEvent): string {
  if (event.exitCode !== undefined) return `exit:${event.exitCode}`;
  if (event.blocked) return "blocked";
  return "error";
}

/**
 * Build a signature string for grouping similar errors.
 */
export function buildSignature(event: LogEvent): string {
  const name = getEventName(event);
  const errorType = getErrorType(event);
  const normalized = normalizeErrorMessage(event.error ?? "");
  return `${event.cat}:${name}:${errorType}:${normalized}`;
}

/**
 * Hash a signature to an 8-char dedup key.
 */
export function hashSignature(signature: string): string {
  return createHash("sha256").update(signature).digest("hex").slice(0, 8);
}

/**
 * Group error events by normalized signature.
 */
export function groupErrors(events: LogEvent[]): ErrorGroup[] {
  const errors = events.filter(isErrorEvent);
  const groups = new Map<string, ErrorGroup>();

  for (const event of errors) {
    const signature = buildSignature(event);
    const hash = hashSignature(signature);

    const existing = groups.get(hash);
    if (existing) {
      existing.count++;
      if (event.ts > existing.lastSeen) existing.lastSeen = event.ts;
      if (event.ts < existing.firstSeen) existing.firstSeen = event.ts;
    } else {
      groups.set(hash, {
        signature,
        hash,
        count: 1,
        firstSeen: event.ts,
        lastSeen: event.ts,
        sample: event,
      });
    }
  }

  return Array.from(groups.values()).sort((a, b) => b.count - a.count);
}

// ---------------------------------------------------------------------------
// Stats Aggregation
// ---------------------------------------------------------------------------

/**
 * Aggregate tool call statistics.
 */
export function aggregateStats(
  events: LogEvent[],
  groupBy: "tool" | "category" | "day",
): {
  totalToolCalls: number;
  totalErrors: number;
  errorRate: number;
  groups: Record<string, StatsGroup>;
} {
  const toolEvents = events.filter((e) => e.cat === "tool");
  const totalToolCalls = toolEvents.length;
  const totalErrors = toolEvents.filter((e) => e.ok === false).length;

  const groupMap = new Map<string, { calls: number; errors: number; totalDuration: number }>();

  for (const event of toolEvents) {
    let key: string;
    switch (groupBy) {
      case "tool":
        key = event.tool ?? "unknown";
        break;
      case "category":
        key = event.cat;
        break;
      case "day":
        key = event.ts.slice(0, 10); // YYYY-MM-DD
        break;
    }

    const existing = groupMap.get(key) ?? { calls: 0, errors: 0, totalDuration: 0 };
    existing.calls++;
    if (event.ok === false) existing.errors++;
    existing.totalDuration += event.durationMs ?? 0;
    groupMap.set(key, existing);
  }

  const groups: Record<string, StatsGroup> = {};
  for (const [key, data] of groupMap) {
    groups[key] = {
      calls: data.calls,
      errors: data.errors,
      errorRate: data.calls > 0 ? data.errors / data.calls : 0,
      avgDurationMs: data.calls > 0 ? Math.round(data.totalDuration / data.calls) : 0,
      totalDurationMs: data.totalDuration,
    };
  }

  return {
    totalToolCalls,
    totalErrors,
    errorRate: totalToolCalls > 0 ? totalErrors / totalToolCalls : 0,
    groups,
  };
}

// ---------------------------------------------------------------------------
// Register Debug Tools
// ---------------------------------------------------------------------------

/**
 * Factory hook for the Langfuse client. Exported (and overridable) so unit
 * tests can stub the client without touching env vars or `fetch`.
 */
export type LangfuseClientFactory = () => LangfuseClient;

let langfuseClientFactory: LangfuseClientFactory = () =>
  createLangfuseClient();

/**
 * Override the Langfuse client factory. Returns a disposer that restores the
 * previous factory (used by tests).
 */
export function setLangfuseClientFactory(
  factory: LangfuseClientFactory,
): () => void {
  const prev = langfuseClientFactory;
  langfuseClientFactory = factory;
  return () => {
    langfuseClientFactory = prev;
  };
}

export function registerDebugTools(
  server: McpServer,
  client: GitHubClient,
): void {
  const logDir = join(homedir(), ".ralph-hero", "logs");
  // `client` is referenced by `debug_stats` (legacy) and reserved for Phase 3b
  // (GH-1100), which will use it for GitHub dedup + issue creation.
  void client;

  // -------------------------------------------------------------------------
  // ralph_hero__collate_debug (v2 — Langfuse path)
  // -------------------------------------------------------------------------
  server.tool(
    "ralph_hero__collate_debug",
    "Query Langfuse for error spans in a time window, normalize messages, and group by signature. Phase 3a returns the grouped report only (dryRun forced true); Phase 3b (GH-1100) adds GitHub issue dedup + create/comment. Returns: { since, errorGroups, totalOccurrences, dryRun, groups[] }.",
    {
      since: z
        .string()
        .optional()
        .describe(
          "ISO date string. Only spans whose startTime >= this value are considered (default: 24h ago).",
        ),
      dryRun: zBoolish()
        .optional()
        .default(true)
        .describe(
          "Phase 3a only honors dryRun=true; passing false returns a stub error until Phase 3b lands.",
        ),
      minOccurrences: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(3)
        .describe("Filter out signatures with fewer occurrences (default: 3)."),
      projectNumber: z
        .number()
        .optional()
        .describe("Project number override (reserved for Phase 3b)."),
    },
    async (args) => {
      try {
        const dryRun = args.dryRun ?? true;
        if (!dryRun) {
          return toolError(
            "dryRun=false requires GH-1100 (Phase 3b) — not yet implemented",
          );
        }

        const minOccurrences = args.minOccurrences ?? 3;
        const sinceDate = args.since
          ? new Date(args.since)
          : new Date(Date.now() - 24 * 60 * 60 * 1000);
        if (Number.isNaN(sinceDate.getTime())) {
          return toolError(`Invalid 'since' value: ${args.since}`);
        }

        let langfuse: LangfuseClient;
        try {
          langfuse = langfuseClientFactory();
        } catch (error) {
          return toolError(
            `Langfuse client unavailable: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        const fromStartTime = sinceDate.toISOString();
        const observations = await langfuse.queryAllObservations({
          type: "SPAN",
          level: "ERROR",
          fromStartTime,
          limit: 100,
        });

        const spans = observations.map(observationToSpan);
        const groups = groupSpansBySignature(spans, {
          minOccurrences,
          langfuseHost: langfuse.host,
        });

        const totalOccurrences = groups.reduce((sum, g) => sum + g.count, 0);

        return toolSuccess({
          since: fromStartTime,
          errorGroups: groups.length,
          totalOccurrences,
          dryRun: true,
          groups: groups.map((g) => ({
            signature: g.signature,
            hash: g.hash,
            count: g.count,
            firstSeen: g.firstSeen,
            lastSeen: g.lastSeen,
            exampleTraceUrl: g.exampleTraceUrl,
            sampleSpans: g.sampleSpans.slice(0, 3),
          })),
        });
      } catch (error) {
        return toolError(
          `Failed to collate debug spans: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  );

  // -------------------------------------------------------------------------
  // ralph_hero__debug_stats
  // -------------------------------------------------------------------------
  server.tool(
    "ralph_hero__debug_stats",
    "Aggregate debug log statistics. Reads JSONL logs and returns tool call counts, error rates, and average durations grouped by tool, category, or day. Returns: totalToolCalls, totalErrors, errorRate, sessionsAnalyzed, per-group breakdown.",
    {
      since: z
        .string()
        .optional()
        .describe("ISO date string. Only process events after this time (default: 7 days ago)"),
      groupBy: z
        .enum(["tool", "category", "day"])
        .optional()
        .default("tool")
        .describe("How to group statistics (default: 'tool')"),
    },
    async (args) => {
      try {
        const sinceDate = args.since
          ? new Date(args.since)
          : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

        const { events, sessionsAnalyzed } = await readLogEvents(logDir, sinceDate);

        if (events.length === 0) {
          return toolSuccess({
            message: "No events found in the specified time window.",
            sessionsAnalyzed: 0,
            since: sinceDate.toISOString(),
          });
        }

        const stats = aggregateStats(events, args.groupBy);

        return toolSuccess({
          since: sinceDate.toISOString(),
          sessionsAnalyzed,
          totalToolCalls: stats.totalToolCalls,
          totalErrors: stats.totalErrors,
          errorRate: Math.round(stats.errorRate * 10000) / 100, // percentage with 2 decimals
          groupBy: args.groupBy,
          groups: stats.groups,
        });
      } catch (error) {
        return toolError(
          `Failed to compute debug stats: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  );
}
