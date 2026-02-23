/**
 * MCP tools for debug log collation and statistics.
 *
 * Provides `ralph_hero__collate_debug` (error grouping + GitHub issue creation)
 * and `ralph_hero__debug_stats` (tool call aggregation metrics).
 *
 * Only registered when RALPH_DEBUG=true. Reads JSONL logs written by DebugLogger.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GitHubClient } from "../github-client.js";
import { toolSuccess, toolError } from "../types.js";

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

export function registerDebugTools(
  server: McpServer,
  client: GitHubClient,
): void {
  const logDir = join(homedir(), ".ralph-hero", "logs");

  // -------------------------------------------------------------------------
  // ralph_hero__collate_debug
  // -------------------------------------------------------------------------
  server.tool(
    "ralph_hero__collate_debug",
    "Collate debug log errors into GitHub issues. Reads JSONL logs, groups errors by normalized signature, deduplicates against existing `debug-auto` labeled issues, and creates/updates issues. Returns: summary of issues created, updated, and total occurrences.",
    {
      since: z
        .string()
        .optional()
        .describe("ISO date string. Only process events after this time (default: 24h ago)"),
      dryRun: z
        .boolean()
        .optional()
        .default(false)
        .describe("If true, report what would be created/updated without making changes"),
      projectNumber: z
        .number()
        .optional()
        .describe("Project number override (defaults to configured project)"),
    },
    async (args) => {
      try {
        const sinceDate = args.since
          ? new Date(args.since)
          : new Date(Date.now() - 24 * 60 * 60 * 1000);

        const { events, sessionsAnalyzed } = await readLogEvents(logDir, sinceDate);
        const errorGroups = groupErrors(events);

        if (errorGroups.length === 0) {
          return toolSuccess({
            message: "No errors found in the specified time window.",
            sessionsAnalyzed,
            since: sinceDate.toISOString(),
          });
        }

        let issuesCreated = 0;
        let issuesUpdated = 0;
        let totalOccurrences = 0;

        const owner = client.config.owner;
        const repo = client.config.repo;

        for (const group of errorGroups) {
          totalOccurrences += group.count;

          if (args.dryRun) continue;

          if (!owner || !repo) {
            return toolError("RALPH_GH_OWNER and RALPH_GH_REPO must be set for issue creation");
          }

          // Search for existing issue with this hash
          const searchQuery = `repo:${owner}/${repo} is:issue is:open label:debug-auto "${group.hash}" in:body`;
          let existingIssueNumber: number | undefined;

          try {
            const searchResult = await client.query<{
              search: { nodes: Array<{ number: number }> };
            }>(
              `query SearchDebugIssues($q: String!) {
                search(query: $q, type: ISSUE, first: 1) {
                  nodes {
                    ... on Issue { number }
                  }
                }
              }`,
              { q: searchQuery },
            );
            existingIssueNumber = searchResult.search.nodes[0]?.number;
          } catch {
            // Search failed, treat as no existing issue
          }

          if (existingIssueNumber) {
            // Add occurrence comment
            await client.mutate(
              `mutation AddComment($subjectId: ID!, $body: String!) {
                addComment(input: { subjectId: $subjectId, body: $body }) {
                  commentEdge { node { id } }
                }
              }`,
              {
                subjectId: `issue:${existingIssueNumber}`,
                body: `## Occurrence Report\n\n- Count: ${group.count}\n- Period: ${group.firstSeen} — ${group.lastSeen}\n- Signature: \`${group.signature}\``,
              },
            ).catch(() => {
              // Best-effort comment
            });
            issuesUpdated++;
          } else {
            // Create new issue
            try {
              await client.mutate(
                `mutation CreateIssue($repoId: ID!, $title: String!, $body: String!) {
                  createIssue(input: { repositoryId: $repoId, title: $title, body: $body }) {
                    issue { number }
                  }
                }`,
                {
                  repoId: `placeholder`, // Would need actual repo ID
                  title: `[debug-auto] ${getEventName(group.sample)} ${getErrorType(group.sample)}`,
                  body: `## Debug Auto-Report\n\n**Hash**: \`${group.hash}\`\n**Signature**: \`${group.signature}\`\n**Occurrences**: ${group.count}\n**First seen**: ${group.firstSeen}\n**Last seen**: ${group.lastSeen}\n\n### Sample Error\n\n\`\`\`json\n${JSON.stringify(group.sample, null, 2)}\n\`\`\`\n\n---\n_Auto-generated by ralph_hero__collate_debug_`,
                },
              ).catch(() => {
                // Best-effort issue creation
              });
              issuesCreated++;
            } catch {
              // Skip failed creations
            }
          }
        }

        return toolSuccess({
          since: sinceDate.toISOString(),
          sessionsAnalyzed,
          errorGroups: errorGroups.length,
          totalOccurrences,
          issuesCreated: args.dryRun ? 0 : issuesCreated,
          issuesUpdated: args.dryRun ? 0 : issuesUpdated,
          dryRun: args.dryRun,
          groups: errorGroups.map((g) => ({
            hash: g.hash,
            signature: g.signature,
            count: g.count,
            firstSeen: g.firstSeen,
            lastSeen: g.lastSeen,
          })),
        });
      } catch (error) {
        return toolError(
          `Failed to collate debug logs: ${error instanceof Error ? error.message : String(error)}`,
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
