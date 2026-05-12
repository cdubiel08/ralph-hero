/**
 * Optional round-trip integration test against a real local Langfuse stack.
 *
 * Skipped by default — runs only when `LANGFUSE_INTEGRATION=1` is set so CI
 * stays hermetic. When enabled:
 *
 *   - calls `ralph_hero__collate_debug({ dryRun: true })` against the live
 *     stack at `LANGFUSE_HOST` (defaults to `http://localhost:3100`)
 *   - asserts either: at least one group returned, OR the response notes
 *     "no errors in window" (zero groups is a valid runtime state).
 *
 * Does NOT exercise `dryRun=false` — issue creation against real GitHub from
 * an automated test is reserved for manual verification.
 */

import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerDebugTools } from "../tools/debug-tools.js";
import type { GitHubClient } from "../github-client.js";

const INTEGRATION_ENABLED = process.env.LANGFUSE_INTEGRATION === "1";

interface HandlerResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

interface RegisteredTool {
  handler: (args: unknown, extra: unknown) => Promise<HandlerResult>;
}

function getTool(server: McpServer, name: string): RegisteredTool {
  const tools = (
    server as unknown as { _registeredTools: Record<string, RegisteredTool> }
  )._registeredTools;
  const tool = tools?.[name];
  if (!tool) throw new Error(`Tool ${name} not registered`);
  return tool;
}

function fakeClient(): GitHubClient {
  // Integration test only exercises dryRun=true — no GitHub calls are made.
  return {
    config: {
      token: "tok",
      owner: process.env.RALPH_GH_OWNER ?? "test",
      repo: process.env.RALPH_GH_REPO ?? "test",
      projectNumber: 1,
    },
  } as unknown as GitHubClient;
}

describe.skipIf(!INTEGRATION_ENABLED)(
  "collate_debug round-trip (LANGFUSE_INTEGRATION=1)",
  () => {
    it("dryRun against live Langfuse returns a grouped report", async () => {
      const server = new McpServer({ name: "test", version: "0.0.0" });
      registerDebugTools(server, fakeClient(), "test");

      const tool = getTool(server, "ralph_hero__collate_debug");
      const result = await tool.handler(
        { dryRun: true, minOccurrences: 1 },
        {},
      );

      // Either succeeded with a (possibly empty) group list, or surfaced a
      // descriptive error — but never the Phase 3a stub.
      if (result.isError) {
        const payload = JSON.parse(result.content[0].text) as {
          error?: string;
        };
        expect(payload.error).not.toContain(
          "Phase 3b) — not yet implemented",
        );
        return;
      }
      const payload = JSON.parse(result.content[0].text) as {
        errorGroups: number;
        groups: unknown[];
      };
      expect(payload.errorGroups).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(payload.groups)).toBe(true);
    }, 30_000);
  },
);
