/**
 * Integration tests for `registerDashboardTools` /
 * `ralph_hero__pipeline_dashboard {view: "summary"}`.
 *
 * GH-1610 merged the standalone `pipeline_status_summary` tool into
 * `pipeline_dashboard` behind a `view` enum (né `pipeline-status-summary.test.ts`
 * — retargeted, not deleted, per the plan's preservation requirement).
 *
 * Mocks `client.projectQuery` and exercises the tool's full flow:
 *   ensureFieldCache -> fetchDashboardItems -> buildStatusSummary ->
 *   toolSuccess.
 *
 * Mock-client harness mirrors `directions-tools.test.ts`'s
 * createMockClient/getTool pattern.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerDashboardTools } from "../tools/dashboard-tools.js";
import type { GitHubClient } from "../github-client.js";
import type { GitHubClientConfig } from "../types.js";
import { FieldOptionCache } from "../lib/cache.js";

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

interface RawIssueFixture {
  number: number;
  title: string;
  workflowState?: string | null;
  priority?: string | null;
  estimate?: string | null;
  updatedAt?: string;
  closedAt?: string | null;
}

function rawIssue(fix: RawIssueFixture): unknown {
  const fieldValues: Array<Record<string, unknown>> = [];
  if (fix.workflowState !== undefined && fix.workflowState !== null) {
    fieldValues.push({
      __typename: "ProjectV2ItemFieldSingleSelectValue",
      name: fix.workflowState,
      field: { name: "Workflow State" },
    });
  }
  if (fix.priority !== undefined && fix.priority !== null) {
    fieldValues.push({
      __typename: "ProjectV2ItemFieldSingleSelectValue",
      name: fix.priority,
      field: { name: "Priority" },
    });
  }
  if (fix.estimate !== undefined && fix.estimate !== null) {
    fieldValues.push({
      __typename: "ProjectV2ItemFieldSingleSelectValue",
      name: fix.estimate,
      field: { name: "Estimate" },
    });
  }

  return {
    id: `item-${fix.number}`,
    type: "ISSUE",
    content: {
      __typename: "Issue",
      number: fix.number,
      title: fix.title,
      state: "OPEN",
      updatedAt: fix.updatedAt ?? new Date().toISOString(),
      closedAt: fix.closedAt ?? null,
      assignees: { nodes: [] },
      repository: { nameWithOwner: "owner/repo", name: "repo" },
      subIssues: { totalCount: 0 },
      trackedIssues: { nodes: [] },
      trackedInIssues: { nodes: [] },
    },
    fieldValues: { nodes: fieldValues },
  };
}

function itemsResponse(nodes: unknown[]): unknown {
  return {
    node: {
      items: {
        totalCount: nodes.length,
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes,
      },
    },
  };
}

function fieldCacheResponse(projectId = "project-id-123"): unknown {
  return {
    user: {
      projectV2: {
        id: projectId,
        fields: {
          nodes: [
            {
              id: "field-ws-id",
              name: "Workflow State",
              dataType: "SINGLE_SELECT",
              options: [
                { id: "opt-backlog", name: "Backlog" },
                { id: "opt-ip", name: "In Progress" },
                { id: "opt-rfp", name: "Ready for Plan" },
                { id: "opt-done", name: "Done" },
              ],
            },
            {
              id: "field-pri-id",
              name: "Priority",
              dataType: "SINGLE_SELECT",
              options: [
                { id: "p0", name: "P0" },
                { id: "p1", name: "P1" },
                { id: "p2", name: "P2" },
                { id: "p3", name: "P3" },
              ],
            },
            {
              id: "field-est-id",
              name: "Estimate",
              dataType: "SINGLE_SELECT",
              options: [
                { id: "xs", name: "XS" },
                { id: "s", name: "S" },
                { id: "m", name: "M" },
              ],
            },
          ],
        },
      },
    },
  };
}

function isFieldCacheQuery(q: string): boolean {
  return q.includes("projectV2(number:") && q.includes("fields(first:");
}

function isDashboardItemsQuery(q: string): boolean {
  return q.includes("node(id: $projectId)") && q.includes("items(first:");
}

interface MockClientOptions {
  itemsByProject?: Record<number, unknown[]>;
}

function createMockClient(
  config: Partial<GitHubClientConfig>,
  options: MockClientOptions = {},
): {
  client: GitHubClient;
  projectQuery: ReturnType<typeof vi.fn>;
} {
  const fullConfig: GitHubClientConfig = {
    token: "tok",
    owner: "test-owner",
    projectNumber: 3,
    projectOwner: "test-owner",
    ...config,
  };

  const projectQuery = vi.fn(async (q: string, vars: Record<string, unknown>) => {
    if (isFieldCacheQuery(q)) {
      return fieldCacheResponse(`project-id-${vars.number}`);
    }
    if (isDashboardItemsQuery(q)) {
      const projectId = vars.projectId as string;
      const match = projectId.match(/project-id-(\d+)/);
      const pn = match ? Number(match[1]) : 0;
      const nodes = options.itemsByProject?.[pn] ?? [];
      return itemsResponse(nodes);
    }
    // Project-title lookup (non-fatal on failure per fetchDashboardItems).
    throw new Error(`Unmocked projectQuery: ${q.slice(0, 80)}`);
  });

  const client = {
    config: fullConfig,
    query: vi.fn(),
    projectQuery,
    projectMutate: vi.fn(),
    mutate: vi.fn(),
    getCache: vi.fn(() => ({
      get: vi.fn(),
      set: vi.fn(),
      invalidateQueries: vi.fn(),
    })),
    getAuthenticatedUser: vi.fn(),
  } as unknown as GitHubClient;

  return { client, projectQuery };
}

// ---------------------------------------------------------------------------
// Server / handler harness
// ---------------------------------------------------------------------------

interface HandlerResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

interface RegisteredTool {
  handler: (args: unknown, extra: unknown) => Promise<HandlerResult>;
}

function getTool(server: McpServer, name: string): RegisteredTool {
  const tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
  const tool = tools?.[name];
  if (!tool) throw new Error(`Tool ${name} not registered`);
  return tool;
}

function parsePayload(result: HandlerResult): unknown {
  expect(result.content).toHaveLength(1);
  return JSON.parse(result.content[0].text);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ralph_hero__pipeline_dashboard {view: \"summary\"}", () => {
  let server: McpServer;
  let fieldCache: FieldOptionCache;

  beforeEach(() => {
    server = new McpServer({ name: "test", version: "0.0.0" });
    fieldCache = new FieldOptionCache();
  });

  function fixtures(): unknown[] {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    return [
      rawIssue({
        number: 1,
        title: "Backlog issue",
        workflowState: "Backlog",
        priority: "P2",
        updatedAt: oneHourAgo,
      }),
      rawIssue({
        number: 2,
        title: "In progress issue",
        workflowState: "In Progress",
        priority: "P1",
        updatedAt: oneHourAgo,
      }),
      rawIssue({
        number: 3,
        title: "Another backlog issue",
        workflowState: "Backlog",
        priority: "P3",
        updatedAt: oneHourAgo,
      }),
    ];
  }

  it("returns exactly the compact top-level keys", async () => {
    const { client } = createMockClient(
      { projectNumber: 3 },
      { itemsByProject: { 3: fixtures() } },
    );
    registerDashboardTools(server, client, fieldCache);
    const tool = getTool(server, "ralph_hero__pipeline_dashboard");

    const result = await tool.handler({ view: "summary" }, {});
    const payload = parsePayload(result) as Record<string, unknown>;

    expect(result.isError).toBeUndefined();
    expect(Object.keys(payload).sort()).toEqual(
      [
        "health",
        "riskScore",
        "velocity",
        "totalIssues",
        "phaseCounts",
        "stuckIssues",
        "wipViolations",
        "blockedDeps",
      ].sort(),
    );
    // No per-phase issues[], no formatted/archive/projectBreakdowns.
    expect(payload).not.toHaveProperty("issues");
    expect(payload).not.toHaveProperty("formatted");
    expect(payload).not.toHaveProperty("archive");
    expect(payload).not.toHaveProperty("projectBreakdowns");
    expect(payload).not.toHaveProperty("phases");
  });

  it("phaseCounts matches the fixture", async () => {
    const { client } = createMockClient(
      { projectNumber: 3 },
      { itemsByProject: { 3: fixtures() } },
    );
    registerDashboardTools(server, client, fieldCache);
    const tool = getTool(server, "ralph_hero__pipeline_dashboard");

    const result = await tool.handler({ view: "summary" }, {});
    const payload = parsePayload(result) as {
      phaseCounts: Record<string, number>;
      totalIssues: number;
    };

    expect(result.isError).toBeUndefined();
    expect(payload.totalIssues).toBe(3);
    expect(payload.phaseCounts).toEqual({ Backlog: 2, "In Progress": 1 });
  });

  it("stuckIssues length is at most 5", async () => {
    const staleTime = new Date(Date.now() - 200 * 60 * 60 * 1000).toISOString(); // 200h ago
    const manyStuck = Array.from({ length: 8 }, (_, i) =>
      rawIssue({
        number: 200 + i,
        title: `Stuck ${i}`,
        workflowState: "In Progress",
        priority: "P2",
        updatedAt: staleTime,
      }),
    );

    const { client } = createMockClient(
      { projectNumber: 3 },
      { itemsByProject: { 3: manyStuck } },
    );
    registerDashboardTools(server, client, fieldCache);
    const tool = getTool(server, "ralph_hero__pipeline_dashboard");

    const result = await tool.handler(
      { view: "summary", stuckThresholdHours: 48 },
      {},
    );
    const payload = parsePayload(result) as {
      stuckIssues: Array<{ number: number }>;
    };

    expect(result.isError).toBeUndefined();
    expect(payload.stuckIssues.length).toBeLessThanOrEqual(5);
  });

  it("owner missing returns a tool error", async () => {
    const { client } = createMockClient({ owner: "", projectOwner: "" });
    registerDashboardTools(server, client, fieldCache);
    const tool = getTool(server, "ralph_hero__pipeline_dashboard");

    const result = await tool.handler({ view: "summary" }, {});
    expect(result.isError).toBe(true);
  });

  it("ignores format — summary view never returns markdown/ascii/formatted", async () => {
    const { client } = createMockClient(
      { projectNumber: 3 },
      { itemsByProject: { 3: fixtures() } },
    );
    registerDashboardTools(server, client, fieldCache);
    const tool = getTool(server, "ralph_hero__pipeline_dashboard");

    const result = await tool.handler(
      { view: "summary", format: "markdown" },
      {},
    );
    const payload = parsePayload(result) as Record<string, unknown>;

    expect(result.isError).toBeUndefined();
    expect(payload).not.toHaveProperty("formatted");
    expect(payload).not.toHaveProperty("markdown");
    expect(Object.keys(payload).sort()).toEqual(
      [
        "health",
        "riskScore",
        "velocity",
        "totalIssues",
        "phaseCounts",
        "stuckIssues",
        "wipViolations",
        "blockedDeps",
      ].sort(),
    );
  });

  it("default view (\"full\") is unaffected — no view arg still returns the full dashboard shape", async () => {
    const { client } = createMockClient(
      { projectNumber: 3 },
      { itemsByProject: { 3: fixtures() } },
    );
    registerDashboardTools(server, client, fieldCache);
    const tool = getTool(server, "ralph_hero__pipeline_dashboard");

    const result = await tool.handler({}, {});
    const payload = parsePayload(result) as Record<string, unknown>;

    expect(result.isError).toBeUndefined();
    // Full dashboard shape has `phases`, not the compact summary keys.
    expect(payload).toHaveProperty("phases");
    expect(payload).not.toHaveProperty("riskScore");
  });
});
