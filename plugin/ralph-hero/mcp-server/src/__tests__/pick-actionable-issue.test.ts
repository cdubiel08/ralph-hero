/**
 * Integration tests for `ralph_hero__pick_actionable_issue` after Phase 6
 * deprecation: the tool is now a thin wrapper that delegates to the same
 * `runDirections` helper used by `ralph_hero__next_actions` (with
 * `audience="agent"`).
 *
 * Two parity tests verify the wrapper:
 *   1. Without `workflowState` — output's picked issue equals
 *      next_actions(limit=1, audience="agent").directions[0].issue.
 *   2. With `workflowState` — wrapper still filters to that phase, returning
 *      the highest-priority candidate within it.
 *
 * Mock-client harness mirrors `directions-tools.test.ts`.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerIssueTools } from "../tools/issue-tools.js";
import { registerDirectionsTools } from "../tools/directions-tools.js";
import type { GitHubClient } from "../github-client.js";
import type { GitHubClientConfig } from "../types.js";
import { FieldOptionCache } from "../lib/cache.js";

// ---------------------------------------------------------------------------
// Mock fixture builders — same shape as directions-tools.test.ts
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

function fieldCacheResponse(projectId = "project-id-3"): unknown {
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

function isFieldCacheQuery(q: string): boolean {
  return q.includes("projectV2(number:") && q.includes("fields(first:");
}

function isDashboardItemsQuery(q: string): boolean {
  return q.includes("node(id: $projectId)") && q.includes("items(first:");
}

function isGroupDetectionQuery(q: string): boolean {
  // detectGroup uses `repository(owner:..., name:...) { issue(number:...) ... }`
  return q.includes("repository(owner:") && q.includes("issue(number:");
}

function isOpenPRsSearchQuery(q: string): boolean {
  return q.includes("search(query:") && q.includes("... on PullRequest");
}

function createMockClient(
  config: Partial<GitHubClientConfig>,
  itemsByProject: Record<number, unknown[]>,
): GitHubClient {
  const fullConfig: GitHubClientConfig = {
    token: "tok",
    owner: "test-owner",
    repo: "test-repo",
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
      const m = projectId.match(/project-id-(\d+)/);
      const pn = m ? Number(m[1]) : 0;
      return itemsResponse(itemsByProject[pn] ?? []);
    }
    throw new Error(`Unmocked projectQuery: ${q.slice(0, 80)}`);
  });

  // detectGroup uses client.query() (issue-level GraphQL). Return a benign
  // shape so the wrapper's best-effort group lookup just yields a non-group
  // result without throwing. The internal `fetchOpenPRs` helper also runs
  // through client.query (PR search); return an empty result so the
  // delegated runDirections call never sees a PR direction.
  const query = vi.fn(async (q: string, _vars: Record<string, unknown>) => {
    if (isGroupDetectionQuery(q)) {
      return {
        repository: {
          issue: {
            number: 0,
            title: "",
            state: "OPEN",
            parent: null,
            subIssues: { nodes: [] },
          },
        },
      };
    }
    if (isOpenPRsSearchQuery(q)) {
      return { search: { nodes: [] } };
    }
    throw new Error(`Unmocked query: ${q.slice(0, 80)}`);
  });

  return {
    config: fullConfig,
    query,
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
}

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

function buildNextActionsArgs(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    limit: 1,
    audience: "agent",
    stuckThresholdHours: 48,
    lockStaleHours: 24,
    treeRecentDoneDays: 7,
    prStaleHours: 24,
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

describe("ralph_hero__pick_actionable_issue (deprecated wrapper)", () => {
  let server: McpServer;
  let fieldCache: FieldOptionCache;

  beforeEach(() => {
    server = new McpServer({ name: "test", version: "0.0.0" });
    fieldCache = new FieldOptionCache();
  });

  it("returns the same item as next_actions(limit=1, audience='agent') when workflowState is omitted", async () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const fixtures = [
      rawIssue({
        number: 100,
        title: "P0 plan-in-review",
        workflowState: "Plan in Review",
        priority: "P0",
        estimate: "S",
        updatedAt: oneHourAgo,
      }),
      rawIssue({
        number: 101,
        title: "P1 ready-for-plan",
        workflowState: "Ready for Plan",
        priority: "P1",
        estimate: "S",
        updatedAt: oneHourAgo,
      }),
      rawIssue({
        number: 102,
        title: "P2 in-review",
        workflowState: "In Review",
        priority: "P2",
        estimate: "S",
        updatedAt: oneHourAgo,
      }),
    ];

    const client = createMockClient({ projectNumber: 3 }, { 3: fixtures });

    registerIssueTools(server, client, fieldCache);
    registerDirectionsTools(server, client, fieldCache);

    const oldTool = getTool(server, "ralph_hero__pick_actionable_issue");
    const newTool = getTool(server, "ralph_hero__next_actions");

    const oldResult = await oldTool.handler(
      // No workflowState — wrapper returns the rank-1 recommended direction.
      { maxEstimate: "S" },
      {},
    );
    const newResult = await newTool.handler(buildNextActionsArgs(), {});

    const oldData = parsePayload(oldResult) as {
      found: boolean;
      issue: { number: number; workflowState: string | null } | null;
    };
    const newData = parsePayload(newResult) as {
      directions: Array<{ issue: { number: number } | null; recommended: boolean }>;
    };

    expect(oldData.found).toBe(true);
    expect(newData.directions).toHaveLength(1);
    expect(newData.directions[0].recommended).toBe(true);

    // Parity: the picked issue must be the rank-1 (recommended) one.
    expect(oldData.issue?.number).toBe(newData.directions[0].issue?.number);
  });

  it("filters by workflowState when provided (preserves legacy contract)", async () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const fixtures = [
      // Highest priority is in Plan in Review, but caller only wants Research Needed.
      rawIssue({
        number: 200,
        title: "P0 elsewhere",
        workflowState: "Plan in Review",
        priority: "P0",
        estimate: "S",
        updatedAt: oneHourAgo,
      }),
      rawIssue({
        number: 201,
        title: "P2 research candidate",
        workflowState: "Research Needed",
        priority: "P2",
        estimate: "S",
        updatedAt: oneHourAgo,
      }),
      rawIssue({
        number: 202,
        title: "P1 research candidate (winner)",
        workflowState: "Research Needed",
        priority: "P1",
        estimate: "S",
        updatedAt: oneHourAgo,
      }),
    ];

    const client = createMockClient({ projectNumber: 3 }, { 3: fixtures });

    registerIssueTools(server, client, fieldCache);
    registerDirectionsTools(server, client, fieldCache);

    const tool = getTool(server, "ralph_hero__pick_actionable_issue");
    const result = await tool.handler(
      { workflowState: "Research Needed", maxEstimate: "S" },
      {},
    );

    const payload = parsePayload(result) as {
      found: boolean;
      issue: { number: number; workflowState: string | null; priority: string | null } | null;
      alternatives: number;
    };

    expect(payload.found).toBe(true);
    // Should pick #202 (P1 in Research Needed), not #200 (P0 outside the requested phase).
    expect(payload.issue?.number).toBe(202);
    expect(payload.issue?.workflowState).toBe("Research Needed");
    expect(payload.issue?.priority).toBe("P1");
    // One other Research Needed candidate (#201) remained.
    expect(payload.alternatives).toBe(1);
  });

  it("returns { found: false } when no issue matches the requested state", async () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const fixtures = [
      rawIssue({
        number: 300,
        title: "Only Plan in Review item",
        workflowState: "Plan in Review",
        priority: "P0",
        estimate: "S",
        updatedAt: oneHourAgo,
      }),
    ];

    const client = createMockClient({ projectNumber: 3 }, { 3: fixtures });

    registerIssueTools(server, client, fieldCache);
    registerDirectionsTools(server, client, fieldCache);

    const tool = getTool(server, "ralph_hero__pick_actionable_issue");
    const result = await tool.handler(
      { workflowState: "Research Needed", maxEstimate: "S" },
      {},
    );

    const payload = parsePayload(result) as {
      found: boolean;
      issue: unknown;
      alternatives: number;
    };

    expect(payload.found).toBe(false);
    expect(payload.issue).toBeNull();
    expect(payload.alternatives).toBe(0);
  });

  it("excludes oversized items via maxEstimate", async () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const fixtures = [
      rawIssue({
        number: 400,
        title: "P0 but M-sized",
        workflowState: "Ready for Plan",
        priority: "P0",
        estimate: "M",
        updatedAt: oneHourAgo,
      }),
      rawIssue({
        number: 401,
        title: "P1 S-sized — should win",
        workflowState: "Ready for Plan",
        priority: "P1",
        estimate: "S",
        updatedAt: oneHourAgo,
      }),
    ];

    const client = createMockClient({ projectNumber: 3 }, { 3: fixtures });

    registerIssueTools(server, client, fieldCache);
    registerDirectionsTools(server, client, fieldCache);

    const tool = getTool(server, "ralph_hero__pick_actionable_issue");
    const result = await tool.handler(
      { workflowState: "Ready for Plan", maxEstimate: "S" },
      {},
    );

    const payload = parsePayload(result) as {
      found: boolean;
      issue: { number: number } | null;
    };

    expect(payload.found).toBe(true);
    expect(payload.issue?.number).toBe(401);
  });

  it("returns the legacy output shape (number, title, description, workflowState, estimate, priority, isLocked, blockedBy)", async () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const fixtures = [
      rawIssue({
        number: 500,
        title: "Sole candidate",
        workflowState: "Plan in Review",
        priority: "P1",
        estimate: "S",
        updatedAt: oneHourAgo,
      }),
    ];

    const client = createMockClient({ projectNumber: 3 }, { 3: fixtures });

    registerIssueTools(server, client, fieldCache);
    registerDirectionsTools(server, client, fieldCache);

    const tool = getTool(server, "ralph_hero__pick_actionable_issue");
    const result = await tool.handler({ maxEstimate: "S" }, {});
    const payload = parsePayload(result) as {
      found: boolean;
      issue: Record<string, unknown> | null;
      group: unknown;
      alternatives: number;
    };

    expect(payload.found).toBe(true);
    expect(payload.issue).not.toBeNull();
    expect(payload.issue).toMatchObject({
      number: 500,
      title: "Sole candidate",
      description: "", // Wrapper does not fetch the body — empty by design.
      workflowState: "Plan in Review",
      estimate: "S",
      priority: "P1",
      isLocked: false,
      blockedBy: [],
    });
    expect(payload).toHaveProperty("group");
    expect(payload).toHaveProperty("alternatives");
  });

  it("rejects unknown workflow state with a recovery hint", async () => {
    const client = createMockClient({ projectNumber: 3 }, { 3: [] });

    registerIssueTools(server, client, fieldCache);
    registerDirectionsTools(server, client, fieldCache);

    const tool = getTool(server, "ralph_hero__pick_actionable_issue");
    const result = await tool.handler(
      { workflowState: "Not A Real State", maxEstimate: "S" },
      {},
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Unknown workflow state");
    expect(result.content[0].text).toContain("Recovery:");
  });

  it("tool description includes [DEPRECATED] marker pointing at next_actions", () => {
    const client = createMockClient({ projectNumber: 3 }, { 3: [] });

    registerIssueTools(server, client, fieldCache);
    registerDirectionsTools(server, client, fieldCache);

    // McpServer stores tools as `{ description, ... }` under
    // `_registeredTools`. Cast to read it directly.
    const tools = (server as unknown as {
      _registeredTools: Record<string, { description: string }>;
    })._registeredTools;
    const desc = tools["ralph_hero__pick_actionable_issue"].description;

    expect(desc).toContain("[DEPRECATED");
    expect(desc).toContain("ralph_hero__next_actions");
  });
});
