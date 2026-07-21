/**
 * Behavioral tests for `list_issues`'s `scope` param (GH-1572 Phase 2).
 *
 * Mock-client harness modeled on `create-issue-defaults.test.ts`: independent
 * per-method response queues so a call routed to the wrong client method
 * (e.g. `scope: "repo"` accidentally hitting `projectQuery`) fails loudly
 * rather than silently mis-matching.
 */

import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerIssueTools } from "../tools/issue-tools.js";
import type { GitHubClient } from "../github-client.js";
import type { GitHubClientConfig } from "../types.js";
import { FieldOptionCache } from "../lib/cache.js";

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

function parsePayload(result: HandlerResult): Record<string, unknown> {
  expect(result.content).toHaveLength(1);
  return JSON.parse(result.content[0].text);
}

function createMockClient(
  responses: {
    query?: unknown[];
    projectQuery?: unknown[];
  },
): GitHubClient {
  const fullConfig: GitHubClientConfig = {
    token: "tok",
    owner: "test-owner",
    repo: "test-repo",
    projectNumber: 3,
    projectOwner: "test-owner",
  };

  function makeQueue(name: string, queue: unknown[] = []) {
    let idx = 0;
    return vi.fn(async () => {
      if (idx >= queue.length) {
        throw new Error(`No more mock ${name} responses`);
      }
      return queue[idx++];
    });
  }

  return {
    config: fullConfig,
    query: makeQueue("query", responses.query),
    projectQuery: makeQueue("projectQuery", responses.projectQuery),
    mutate: vi.fn(async () => {
      throw new Error("Unexpected mutate call");
    }),
    projectMutate: vi.fn(async () => {
      throw new Error("Unexpected projectMutate call");
    }),
    getRateLimitStatus: () => ({
      remaining: 5000,
      resetAt: new Date(),
      isLow: false,
      isCritical: false,
    }),
    getCache: () => ({
      get: () => undefined,
      set: vi.fn(),
      invalidateQueries: vi.fn(),
    }),
    getAuthenticatedUser: vi.fn(async () => "test-user"),
    restPost: vi.fn(async () => {
      throw new Error("Unexpected restPost call");
    }),
  } as unknown as GitHubClient;
}

function buildServer(client: GitHubClient, fieldCache: FieldOptionCache): McpServer {
  const server = new McpServer({ name: "test-server", version: "0.0.0" });
  registerIssueTools(server, client, fieldCache);
  return server;
}

/** Pre-populated so `ensureFieldCache`'s `isPopulated` short-circuit skips the fetch. */
function createMockFieldCache(): FieldOptionCache {
  const cache = new FieldOptionCache();
  cache.populate(3, "project-id-1", [
    {
      id: "field-ws-id",
      name: "Workflow State",
      options: [{ id: "opt-backlog", name: "Backlog" }],
    },
  ]);
  return cache;
}

const SEARCH_RESULT = {
  search: {
    issueCount: 1,
    nodes: [
      {
        number: 1523,
        title: "off-board issue",
        state: "OPEN",
        stateReason: null,
        url: "https://github.com/test-owner/test-repo/issues/1523",
        createdAt: "2026-07-01T00:00:00Z",
        updatedAt: "2026-07-01T00:00:00Z",
        labels: { nodes: [{ name: "user-feedback" }] },
        assignees: { nodes: [] },
        repository: { name: "test-repo", nameWithOwner: "test-owner/test-repo" },
      },
    ],
  },
};

/** Same single node, but GitHub reports far more total matches than fetched. */
const TRUNCATED_SEARCH_RESULT = {
  search: {
    issueCount: 137,
    nodes: SEARCH_RESULT.search.nodes,
  },
};

const PROJECT_ITEMS_RESULT = {
  node: {
    items: {
      totalCount: 1,
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [
        {
          id: "item-1",
          type: "ISSUE",
          content: {
            number: 2001,
            title: "on-board issue",
            body: "",
            state: "OPEN",
            stateReason: null,
            url: "https://github.com/test-owner/test-repo/issues/2001",
            createdAt: "2026-07-01T00:00:00Z",
            updatedAt: "2026-07-01T00:00:00Z",
            labels: { nodes: [] },
            assignees: { nodes: [] },
            repository: { name: "test-repo", nameWithOwner: "test-owner/test-repo" },
          },
          fieldValues: { nodes: [] },
        },
      ],
    },
  },
};

describe("list_issues scope param (GH-1572 Phase 2)", () => {
  it('scope: "repo" routes to client.query, never client.projectQuery', async () => {
    const client = createMockClient({ query: [SEARCH_RESULT] });
    const server = buildServer(client, createMockFieldCache());
    const tool = getTool(server, "ralph_hero__list_issues");

    const result = await tool.handler(
      { scope: "repo", label: "user-feedback" },
      {},
    );
    const payload = parsePayload(result);

    expect(client.query).toHaveBeenCalledTimes(1);
    expect(client.projectQuery).not.toHaveBeenCalled();
    expect(payload.filteredCount).toBe(1);
    expect((payload.items as Array<Record<string, unknown>>)[0]).toMatchObject(
      {
        number: 1523,
        workflowState: null,
        estimate: null,
        priority: null,
        iteration: null,
      },
    );
  });

  it('scope: "repo" combined with a project-only filter (workflowState) returns a toolError', async () => {
    const client = createMockClient({});
    const server = buildServer(client, createMockFieldCache());
    const tool = getTool(server, "ralph_hero__list_issues");

    const result = await tool.handler(
      { scope: "repo", workflowState: "Backlog" },
      {},
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("workflowState");
    expect(client.query).not.toHaveBeenCalled();
    expect(client.projectQuery).not.toHaveBeenCalled();
  });

  it('scope: "repo" surfaces incomplete: true + totalCount when the search result is truncated', async () => {
    const client = createMockClient({ query: [TRUNCATED_SEARCH_RESULT] });
    const server = buildServer(client, createMockFieldCache());
    const tool = getTool(server, "ralph_hero__list_issues");

    const result = await tool.handler(
      { scope: "repo", label: "user-feedback", limit: 1 },
      {},
    );
    const payload = parsePayload(result);

    expect(payload.filteredCount).toBe(1);
    expect(payload.incomplete).toBe(true);
    expect(payload.totalCount).toBe(137);
    expect(typeof payload.warning).toBe("string");
  });

  it('scope: "repo" omits incomplete/totalCount when the search result is exhaustive', async () => {
    const client = createMockClient({ query: [SEARCH_RESULT] });
    const server = buildServer(client, createMockFieldCache());
    const tool = getTool(server, "ralph_hero__list_issues");

    const result = await tool.handler(
      { scope: "repo", label: "user-feedback" },
      {},
    );
    const payload = parsePayload(result);

    expect(payload.incomplete).toBeUndefined();
    expect(payload.totalCount).toBeUndefined();
  });

  it("scope omitted preserves the existing project-path behavior (no regression)", async () => {
    const client = createMockClient({
      projectQuery: [PROJECT_ITEMS_RESULT],
    });
    const server = buildServer(client, createMockFieldCache());
    const tool = getTool(server, "ralph_hero__list_issues");

    const result = await tool.handler({}, {});
    const payload = parsePayload(result);

    expect(client.projectQuery).toHaveBeenCalled();
    expect(client.query).not.toHaveBeenCalled();
    expect(payload.filteredCount).toBe(1);
    expect((payload.items as Array<Record<string, unknown>>)[0]).toMatchObject(
      { number: 2001 },
    );
  });
});
