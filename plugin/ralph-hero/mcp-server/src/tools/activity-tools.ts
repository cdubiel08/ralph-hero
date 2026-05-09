import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as path from "node:path";
import * as os from "node:os";
import { readActivity, type Category } from "../lib/activity.js";
import { toolSuccess, toolError } from "../types.js";

function defaultActivityRoot(): string {
  return process.env.RALPH_ACTIVITY_DIR ?? path.join(os.homedir(), ".ralph-hero", "activity");
}

export function registerActivityTools(server: McpServer): void {
  server.tool(
    "ralph_hero__recent_activity",
    "Read structured events from the local ralph-hero activity log since a cursor. Used by /catch-up to synthesize 'what changed since last time' narratives. Pure read; the log is written by harness hooks.",
    {
      since: z.string().nullable().default(null).describe("ISO8601 timestamp lower bound; null = all of today"),
      until: z.string().nullable().default(null).describe("Optional ISO8601 upper bound"),
      kinds: z.array(z.string()).nullable().default(null).describe("Filter by event kind (e.g., ['pr_opened','issue_advanced'])"),
      category: z.enum(["work", "meta", "all"]).default("work").describe("Filter by category; default 'work' excludes meta noise"),
      project: z.string().nullable().default(null).describe("Filter by project name"),
      limit: z.number().int().min(1).default(50).describe("Max events to return (default 50; was 100 before 2.5.x)"),
      compact: z.boolean().default(false).describe("When true, project each event to {ts, kind, tool, project}; drops actor/session_id/category/wrapper-target. Use for narrative synthesis."),
    },
    async (params) => {
      try {
        const result = readActivity({
          rootDir: defaultActivityRoot(),
          since: params.since ?? null,
          until: params.until ?? null,
          kinds: params.kinds ?? null,
          category: (params.category ?? "work") as Category,
          project: params.project ?? null,
          limit: params.limit ?? 50,
          compact: params.compact ?? false,
          now: new Date(),
        });
        return toolSuccess(result);
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  );
}
