/**
 * Integration test: outcome-recorder → record outcome → query outcome
 *
 * Asserts the full merge → outcome-row path described in GH-1272 Feature E.
 * Uses an in-memory SQLite DB so no ~/.ralph-hero/knowledge.db is touched.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { KnowledgeDB } from "../db.js";

/**
 * Helper to call a registered MCP tool by name.
 * McpServer stores handlers as a plain object at _registeredTools.
 */
async function callTool(
  toolServer: McpServer,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const registeredTools = (toolServer as unknown as Record<string, unknown>)
    ._registeredTools as Record<
    string,
    { handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown> }
  >;
  const tool = registeredTools?.[name];
  if (!tool) {
    throw new Error(`Tool "${name}" not registered`);
  }
  return tool.handler(args, {}) as Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

let db: KnowledgeDB;
let server: McpServer;

beforeEach(async () => {
  const mod = await import("../index.js");
  const result = mod.createServer(":memory:");
  server = result.server;
  db = result.db;
});

describe("outcome-merge-ingest: record outcome → query outcome", () => {
  it("Test 1: records merge_completed outcome and retrieves it via knowledge_query_outcomes", async () => {
    const recordResult = await callTool(server, "knowledge_record_outcome", {
      event_type: "merge_completed",
      issue_number: 9999,
      verdict: "merged",
      payload: {
        pr_url: "https://github.com/owner/repo/pull/1",
        commit_sha: "abc123",
        repo: "ralph-hero",
      },
    });

    expect(recordResult.isError).toBeFalsy();
    const recorded = JSON.parse(recordResult.content[0].text);
    expect(recorded.eventType).toBe("merge_completed");
    expect(recorded.issueNumber).toBe(9999);

    // Query back by issue number
    const queryResult = await callTool(server, "knowledge_query_outcomes", {
      issue_number: 9999,
    });

    expect(queryResult.isError).toBeFalsy();
    const queried = JSON.parse(queryResult.content[0].text);
    // Returns either rows array or aggregate — check both shapes
    const rows: Array<Record<string, unknown>> = Array.isArray(queried)
      ? queried
      : queried.rows ?? [];

    expect(rows.length).toBe(1);
    expect(rows[0].eventType).toBe("merge_completed");
    expect(rows[0].verdict).toBe("merged");
    const payloadStr = rows[0].payload as string;
    const payload = typeof payloadStr === "string" ? JSON.parse(payloadStr) : payloadStr;
    expect(payload.commit_sha).toBe("abc123");
    expect(payload.repo).toBe("ralph-hero");
  });

  it("Test 2: outcomes_summary attaches to documents linked to the same issue", async () => {
    // Insert a stub document tied to issue 9999
    db.upsertDocument({
      id: "doc-test-9999",
      path: "thoughts/shared/plans/test-plan.md",
      title: "Test Plan for Issue 9999",
      date: "2026-05-16",
      type: "plan",
      status: "completed",
      githubIssue: 9999,
      content: "Test plan content.",
    });

    // Record an outcome for issue 9999
    await callTool(server, "knowledge_record_outcome", {
      event_type: "merge_completed",
      issue_number: 9999,
      verdict: "merged",
      payload: {
        pr_url: "https://github.com/owner/repo/pull/1",
        commit_sha: "abc123",
        repo: "ralph-hero",
      },
    });

    // getOutcomeSummary is the DB-level helper knowledge_search uses internally
    const summary = db.getOutcomeSummary(9999);
    expect(summary).not.toBeNull();
    expect(summary!.totalEvents).toBe(1);
    expect(summary!.latestVerdict).toBe("merged");
    expect(summary!.eventsByType["merge_completed"]).toBe(1);
  });

  it("Test 3: recording the same outcome twice creates two rows (no de-duplication)", async () => {
    const args = {
      event_type: "merge_completed",
      issue_number: 9999,
      verdict: "merged",
      payload: {
        pr_url: "https://github.com/owner/repo/pull/1",
        commit_sha: "abc123",
        repo: "ralph-hero",
      },
    };

    await callTool(server, "knowledge_record_outcome", args);
    await callTool(server, "knowledge_record_outcome", args);

    const queryResult = await callTool(server, "knowledge_query_outcomes", {
      issue_number: 9999,
    });

    expect(queryResult.isError).toBeFalsy();
    const queried = JSON.parse(queryResult.content[0].text);
    const rows: Array<Record<string, unknown>> = Array.isArray(queried)
      ? queried
      : queried.rows ?? [];

    // Two inserts → two rows (no de-duplication at the recorder level)
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.eventType === "merge_completed")).toBe(true);
  });
});
