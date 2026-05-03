/**
 * Integration tests for `registerDirectionsTools` /
 * `ralph_hero__hello_directions`.
 *
 * Mocks `client.projectQuery` and exercises the tool's full flow:
 *   ensureFieldCache -> paginateConnection -> toDashboardItems ->
 *   rankDirections -> toolSuccess.
 *
 * Mock-client harness mirrors `auto-advance-parent.test.ts:81-110` and
 * `repo-inference.test.ts:30-41` (the integration patterns) — NOT
 * `dashboard.test.ts` (pure-function-only).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerDirectionsTools } from "../tools/directions-tools.js";
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
  parentNumber?: number | null;
  parentState?: string | null;
}

/**
 * Build a `node.items.nodes[]` entry that matches the shape returned by
 * `DASHBOARD_ITEMS_QUERY`. `toDashboardItems` will turn it into a
 * `DashboardItem` with the expected workflowState / priority / estimate.
 */
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

  const trackedInIssues =
    fix.parentNumber !== undefined && fix.parentNumber !== null
      ? {
          nodes: [
            {
              number: fix.parentNumber,
              state: fix.parentState ?? "OPEN",
              closedAt: null,
            },
          ],
        }
      : { nodes: [] };

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
      trackedInIssues,
    },
    fieldValues: { nodes: fieldValues },
  };
}

/** Wrap raw issue nodes into a `DASHBOARD_ITEMS_QUERY`-shaped response. */
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

/**
 * Field-cache populate response. `ensureFieldCache` queries
 * `${ownerType}(login: $owner) { projectV2 { id, fields {...} } }` and
 * tries `user` first, then `organization` — return the user shape so the
 * first attempt succeeds.
 */
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
                { id: "opt-pir", name: "Plan in Review" },
                { id: "opt-rfp", name: "Ready for Plan" },
                { id: "opt-rn", name: "Research Needed" },
                { id: "opt-ip", name: "In Progress" },
                { id: "opt-iv", name: "In Review" },
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

/** Detect the kind of GraphQL query being sent so we can route mock responses. */
function isFieldCacheQuery(q: string): boolean {
  return q.includes("projectV2(number:") && q.includes("fields(first:");
}

function isDashboardItemsQuery(q: string): boolean {
  return q.includes("node(id: $projectId)") && q.includes("items(first:");
}

interface MockClientOptions {
  /** Items response per project (keyed by project number). */
  itemsByProject?: Record<number, unknown[]>;
  /** Make ensureFieldCache fail (returns null project everywhere). */
  failFieldCache?: boolean;
}

function createMockClient(
  config: Partial<GitHubClientConfig>,
  options: MockClientOptions = {},
): { client: GitHubClient; projectQuery: ReturnType<typeof vi.fn> } {
  const fullConfig: GitHubClientConfig = {
    token: "tok",
    owner: "test-owner",
    projectNumber: 3,
    projectOwner: "test-owner",
    ...config,
  };

  const projectQuery = vi.fn(async (q: string, vars: Record<string, unknown>) => {
    if (isFieldCacheQuery(q)) {
      if (options.failFieldCache) {
        // Both user and organization paths return null projectV2.
        return { user: { projectV2: null }, organization: { projectV2: null } };
      }
      return fieldCacheResponse(`project-id-${vars.number}`);
    }
    if (isDashboardItemsQuery(q)) {
      // Project ID convention: "project-id-${pn}"; unwrap to find pn.
      const projectId = vars.projectId as string;
      const match = projectId.match(/project-id-(\d+)/);
      const pn = match ? Number(match[1]) : 0;
      const nodes = options.itemsByProject?.[pn] ?? [];
      return itemsResponse(nodes);
    }
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

function buildArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  // Match Zod-defaulted args. `validateToolInput` would normally do this;
  // we pass the resolved object directly so each test stays focused.
  return {
    limit: 3,
    stuckThresholdHours: 48,
    lockStaleHours: 24,
    treeRecentDoneDays: 7,
    prStaleHours: 24,
    openPRs: [],
    ...overrides,
  };
}

function parsePayload(result: HandlerResult): unknown {
  expect(result.content).toHaveLength(1);
  return JSON.parse(result.content[0].text);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ralph_hero__hello_directions", () => {
  let server: McpServer;
  let fieldCache: FieldOptionCache;

  beforeEach(() => {
    server = new McpServer({ name: "test", version: "0.0.0" });
    fieldCache = new FieldOptionCache();
  });

  // -------------------------------------------------------------------------
  // 1. End-to-end happy path
  // -------------------------------------------------------------------------
  it("returns top 3 directions with correct shape from a 5-issue board", async () => {
    const now = Date.now();
    const oneHourAgo = new Date(now - 1 * 60 * 60 * 1000).toISOString();

    const fixtures = [
      rawIssue({
        number: 100,
        title: "P0 plan-in-review",
        workflowState: "Plan in Review",
        priority: "P0",
        updatedAt: oneHourAgo,
      }),
      rawIssue({
        number: 101,
        title: "P1 ready-for-plan",
        workflowState: "Ready for Plan",
        priority: "P1",
        updatedAt: oneHourAgo,
      }),
      rawIssue({
        number: 102,
        title: "P2 in-review",
        workflowState: "In Review",
        priority: "P2",
        updatedAt: oneHourAgo,
      }),
      rawIssue({
        number: 103,
        title: "Research needed P3",
        workflowState: "Research Needed",
        priority: "P3",
        updatedAt: oneHourAgo,
      }),
      rawIssue({
        number: 104,
        title: "Done — should not surface",
        workflowState: "Done",
        priority: "P0",
        updatedAt: oneHourAgo,
        closedAt: oneHourAgo,
      }),
    ];

    const { client } = createMockClient(
      { projectNumber: 3 },
      { itemsByProject: { 3: fixtures } },
    );

    registerDirectionsTools(server, client, fieldCache);
    const tool = getTool(server, "ralph_hero__hello_directions");

    const result = await tool.handler(buildArgs(), {});
    const payload = parsePayload(result) as {
      directions: Array<{
        rank: number;
        kind: string;
        issue: { number: number } | null;
        pr: unknown;
        reason: string;
        tags: string[];
        score: number;
      }>;
      fetchedAt: string;
      totalCandidates: number;
    };

    expect(result.isError).toBeUndefined();
    expect(payload.totalCandidates).toBe(5);
    expect(payload.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(payload.directions).toHaveLength(3);

    // Top direction: P0 in Plan in Review.
    expect(payload.directions[0].issue?.number).toBe(100);
    expect(payload.directions[0].rank).toBe(1);
    expect(payload.directions[0].kind).toBe("issue");

    // Done issue (#104) must not appear.
    const numbers = payload.directions.map((d) => d.issue?.number);
    expect(numbers).not.toContain(104);

    // Each direction has the documented shape.
    for (const dir of payload.directions) {
      expect(typeof dir.rank).toBe("number");
      expect(typeof dir.kind).toBe("string");
      expect(typeof dir.reason).toBe("string");
      expect(Array.isArray(dir.tags)).toBe(true);
      expect(typeof dir.score).toBe("number");
    }
  });

  // -------------------------------------------------------------------------
  // 2. Empty board
  // -------------------------------------------------------------------------
  it("returns an empty directions array on an empty board (no error)", async () => {
    const { client } = createMockClient(
      { projectNumber: 3 },
      { itemsByProject: { 3: [] } },
    );

    registerDirectionsTools(server, client, fieldCache);
    const tool = getTool(server, "ralph_hero__hello_directions");

    const result = await tool.handler(buildArgs(), {});
    const payload = parsePayload(result) as {
      directions: unknown[];
      totalCandidates: number;
    };

    expect(result.isError).toBeUndefined();
    expect(payload.directions).toEqual([]);
    expect(payload.totalCandidates).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 3. Multi-project
  // -------------------------------------------------------------------------
  it("merges items across multiple project numbers", async () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    const projectA = [
      rawIssue({
        number: 200,
        title: "Project A — P0",
        workflowState: "Plan in Review",
        priority: "P0",
        updatedAt: oneHourAgo,
      }),
    ];
    const projectB = [
      rawIssue({
        number: 300,
        title: "Project B — P1",
        workflowState: "Plan in Review",
        priority: "P1",
        updatedAt: oneHourAgo,
      }),
      rawIssue({
        number: 301,
        title: "Project B — P2",
        workflowState: "Plan in Review",
        priority: "P2",
        updatedAt: oneHourAgo,
      }),
    ];

    const { client, projectQuery } = createMockClient(
      { projectNumbers: [3, 7] },
      { itemsByProject: { 3: projectA, 7: projectB } },
    );

    registerDirectionsTools(server, client, fieldCache);
    const tool = getTool(server, "ralph_hero__hello_directions");

    const result = await tool.handler(buildArgs(), {});
    const payload = parsePayload(result) as {
      directions: Array<{ issue: { number: number } | null }>;
      totalCandidates: number;
    };

    expect(result.isError).toBeUndefined();
    expect(payload.totalCandidates).toBe(3);

    // Both projects were queried (2 field-cache + 2 items = 4 calls).
    expect(projectQuery.mock.calls.length).toBeGreaterThanOrEqual(4);

    const numbers = payload.directions.map((d) => d.issue?.number);
    // P0 from A wins slot 1.
    expect(numbers[0]).toBe(200);
    // Both project B items also surface.
    expect(numbers).toContain(300);
    expect(numbers).toContain(301);
  });

  // -------------------------------------------------------------------------
  // 4. Field cache miss
  // -------------------------------------------------------------------------
  it("returns toolError when ensureFieldCache fails", async () => {
    const { client } = createMockClient(
      { projectNumber: 3 },
      { failFieldCache: true },
    );

    registerDirectionsTools(server, client, fieldCache);
    const tool = getTool(server, "ralph_hero__hello_directions");

    const result = await tool.handler(buildArgs(), {});
    expect(result.isError).toBe(true);

    const payload = parsePayload(result) as { error: string };
    expect(payload.error).toMatch(/Failed to compute hello directions/);
    expect(payload.error).toMatch(/Project #3 not found/);
  });

  // -------------------------------------------------------------------------
  // 5. PR injection
  // -------------------------------------------------------------------------
  it("surfaces a REVIEW_REQUIRED PR (age 30h) as direction 1", async () => {
    const now = Date.now();
    const oneHourAgo = new Date(now - 60 * 60 * 1000).toISOString();
    const thirtyHoursAgo = new Date(now - 30 * 60 * 60 * 1000).toISOString();

    const fixtures = [
      rawIssue({
        number: 400,
        title: "P0 issue",
        workflowState: "Plan in Review",
        priority: "P0",
        updatedAt: oneHourAgo,
      }),
    ];

    const { client } = createMockClient(
      { projectNumber: 3 },
      { itemsByProject: { 3: fixtures } },
    );

    registerDirectionsTools(server, client, fieldCache);
    const tool = getTool(server, "ralph_hero__hello_directions");

    const result = await tool.handler(
      buildArgs({
        openPRs: [
          {
            number: 999,
            title: "Important PR",
            url: "https://github.com/o/r/pull/999",
            isDraft: false,
            reviewDecision: "REVIEW_REQUIRED",
            headRefName: "feature/GH-400",
            createdAt: thirtyHoursAgo,
          },
        ],
      }),
      {},
    );

    const payload = parsePayload(result) as {
      directions: Array<{
        kind: string;
        issue: { number: number } | null;
        pr: { number: number } | null;
      }>;
    };

    expect(result.isError).toBeUndefined();
    expect(payload.directions[0].kind).toBe("pr");
    expect(payload.directions[0].pr?.number).toBe(999);
    expect(payload.directions[0].issue).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 6. Defaults applied
  // -------------------------------------------------------------------------
  it("applies default RankConfig when no config args are provided", async () => {
    const now = Date.now();
    const oneHourAgo = new Date(now - 60 * 60 * 1000).toISOString();

    // Build 5 candidates — default limit=3 should drop the bottom 2.
    const fixtures = [
      rawIssue({
        number: 500,
        title: "P0",
        workflowState: "Plan in Review",
        priority: "P0",
        updatedAt: oneHourAgo,
      }),
      rawIssue({
        number: 501,
        title: "P1",
        workflowState: "Plan in Review",
        priority: "P1",
        updatedAt: oneHourAgo,
      }),
      rawIssue({
        number: 502,
        title: "P2",
        workflowState: "Plan in Review",
        priority: "P2",
        updatedAt: oneHourAgo,
      }),
      rawIssue({
        number: 503,
        title: "P3",
        workflowState: "Plan in Review",
        priority: "P3",
        updatedAt: oneHourAgo,
      }),
      rawIssue({
        number: 504,
        title: "no-priority",
        workflowState: "Plan in Review",
        priority: null,
        updatedAt: oneHourAgo,
      }),
    ];

    const { client } = createMockClient(
      { projectNumber: 3 },
      { itemsByProject: { 3: fixtures } },
    );

    registerDirectionsTools(server, client, fieldCache);
    const tool = getTool(server, "ralph_hero__hello_directions");

    // Build args WITHOUT defaults — only required fields. The handler must
    // fall back to DEFAULT_RANK_CONFIG values (limit: 3, etc.).
    const result = await tool.handler({ openPRs: [] }, {});
    const payload = parsePayload(result) as {
      directions: Array<{ issue: { number: number } | null }>;
      totalCandidates: number;
    };

    expect(result.isError).toBeUndefined();
    expect(payload.totalCandidates).toBe(5);
    // Default limit of 3 was honored.
    expect(payload.directions).toHaveLength(3);
    // Top three by priority.
    expect(payload.directions.map((d) => d.issue?.number)).toEqual([500, 501, 502]);
  });
});

// ---------------------------------------------------------------------------
// Phase 2.4 — ralph_hero__next_actions
// ---------------------------------------------------------------------------

describe("ralph_hero__next_actions", () => {
  let server: McpServer;
  let fieldCache: FieldOptionCache;

  beforeEach(() => {
    server = new McpServer({ name: "test", version: "0.0.0" });
    fieldCache = new FieldOptionCache();
  });

  it("registers under the new name and accepts audience param", async () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const fixtures = [
      rawIssue({
        number: 700,
        title: "P0 plan-in-review",
        workflowState: "Plan in Review",
        priority: "P0",
        updatedAt: oneHourAgo,
      }),
    ];

    const { client } = createMockClient(
      { projectNumber: 3 },
      { itemsByProject: { 3: fixtures } },
    );

    registerDirectionsTools(server, client, fieldCache);

    // Tool is registered under the new name
    const tool = getTool(server, "ralph_hero__next_actions");
    expect(tool).toBeDefined();

    // Call with audience=agent
    const result = await tool.handler(
      buildArgs({ limit: 1, audience: "agent" }),
      {},
    );
    const payload = parsePayload(result) as {
      directions: Array<{ recommended: boolean }>;
    };
    expect(result.isError).toBeUndefined();
    expect(payload.directions).toBeDefined();
    if (payload.directions.length > 0) {
      expect(payload.directions[0].recommended).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 2.5 — hello_directions backwards-compat parity
// ---------------------------------------------------------------------------

describe("hello_directions backwards-compat", () => {
  let server: McpServer;
  let fieldCache: FieldOptionCache;

  beforeEach(() => {
    server = new McpServer({ name: "test", version: "0.0.0" });
    fieldCache = new FieldOptionCache();
  });

  it("hello_directions still returns same shape as next_actions(audience=human)", async () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const fixtures = [
      rawIssue({
        number: 800,
        title: "P0 plan-in-review",
        workflowState: "Plan in Review",
        priority: "P0",
        updatedAt: oneHourAgo,
      }),
      rawIssue({
        number: 801,
        title: "P1 ready-for-plan",
        workflowState: "Ready for Plan",
        priority: "P1",
        updatedAt: oneHourAgo,
      }),
      rawIssue({
        number: 802,
        title: "P2 in-review",
        workflowState: "In Review",
        priority: "P2",
        updatedAt: oneHourAgo,
      }),
    ];

    const { client } = createMockClient(
      { projectNumber: 3 },
      { itemsByProject: { 3: fixtures } },
    );

    registerDirectionsTools(server, client, fieldCache);

    const oldTool = getTool(server, "ralph_hero__hello_directions");
    const newTool = getTool(server, "ralph_hero__next_actions");

    const oldResult = await oldTool.handler(
      buildArgs({ limit: 3, openPRs: [] }),
      {},
    );
    const newResult = await newTool.handler(
      buildArgs({ limit: 3, audience: "human", openPRs: [] }),
      {},
    );

    const oldPayload = parsePayload(oldResult) as {
      directions: Array<{ recommended: boolean }>;
    };
    const newPayload = parsePayload(newResult) as {
      directions: Array<{ recommended: boolean }>;
    };

    expect(oldResult.isError).toBeUndefined();
    expect(newResult.isError).toBeUndefined();
    expect(oldPayload.directions.length).toBe(newPayload.directions.length);
    if (oldPayload.directions.length > 0) {
      expect(oldPayload.directions[0].recommended).toBe(true);
      expect(newPayload.directions[0].recommended).toBe(true);
    }
  });
});
