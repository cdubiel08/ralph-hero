/**
 * Behavioral tests for `create_issue`'s pre-creation dedup check (GH-1572
 * Phase 3).
 *
 * Modeled on `create-issue-defaults.test.ts`'s independent-per-method-queue
 * mock client (so a call routed to the wrong client method fails loudly)
 * and `collate-debug-phase3b.test.ts`'s query-routing awareness — the
 * dedup search and the Step 1 repo-ID lookup both go through `client.query`
 * within a single handler invocation, so the `query` queue must return the
 * search result first, then the repo-ID result, in call order.
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

function makeQueue(name: string, queue: unknown[] = []) {
  let idx = 0;
  return vi.fn(async () => {
    if (idx >= queue.length) {
      throw new Error(`No more mock ${name} responses`);
    }
    return queue[idx++];
  });
}

/** First call throws; subsequent calls pop from `queue` in order. */
function makeThrowOnceThenQueue(queue: unknown[]) {
  let idx = 0;
  return vi.fn(async () => {
    if (idx === 0) {
      idx++;
      throw new Error("search API unavailable");
    }
    const i = idx - 1;
    idx++;
    if (i >= queue.length) {
      throw new Error("No more mock query responses");
    }
    return queue[i];
  });
}

function createMockClient(
  responses: {
    query?: unknown[] | ReturnType<typeof vi.fn>;
    mutate?: unknown[];
    projectMutate?: unknown[];
  },
): GitHubClient {
  const fullConfig: GitHubClientConfig = {
    token: "tok",
    owner: "test-owner",
    repo: "test-repo",
    projectNumber: 3,
    projectOwner: "test-owner",
  };

  const queryFn = Array.isArray(responses.query)
    ? makeQueue("query", responses.query)
    : responses.query ?? makeQueue("query", []);

  return {
    config: fullConfig,
    query: queryFn,
    projectQuery: vi.fn(async () => {
      throw new Error("Unexpected projectQuery call");
    }),
    mutate: makeQueue("mutate", responses.mutate),
    projectMutate: makeQueue("projectMutate", responses.projectMutate),
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

function createMockFieldCache(): FieldOptionCache {
  const cache = new FieldOptionCache();
  cache.populate(3, "project-id-123", [
    {
      id: "field-ws-id",
      name: "Workflow State",
      options: [{ id: "opt-backlog", name: "Backlog" }],
    },
    {
      id: "field-status-id",
      name: "Status",
      options: [{ id: "opt-status-todo", name: "Todo" }],
    },
  ]);
  return cache;
}

function buildServer(client: GitHubClient, fieldCache: FieldOptionCache): McpServer {
  const server = new McpServer({ name: "test-server", version: "0.0.0" });
  registerIssueTools(server, client, fieldCache);
  return server;
}

const EXISTING_MATCH_SEARCH_RESULT = {
  search: {
    issueCount: 1,
    nodes: [
      {
        number: 1523,
        title: "  Login  Bug  ",
        state: "OPEN",
        stateReason: null,
        url: "https://github.com/test-owner/test-repo/issues/1523",
        createdAt: "2026-07-01T00:00:00Z",
        updatedAt: "2026-07-01T00:00:00Z",
        labels: { nodes: [] },
        assignees: { nodes: [] },
        repository: { name: "test-repo", nameWithOwner: "test-owner/test-repo" },
      },
    ],
  },
};

const NO_MATCH_SEARCH_RESULT = {
  search: {
    issueCount: 1,
    nodes: [
      {
        number: 999,
        title: "Completely unrelated issue",
        state: "OPEN",
        stateReason: null,
        url: "https://github.com/test-owner/test-repo/issues/999",
        createdAt: "2026-07-01T00:00:00Z",
        updatedAt: "2026-07-01T00:00:00Z",
        labels: { nodes: [] },
        assignees: { nodes: [] },
        repository: { name: "test-repo", nameWithOwner: "test-owner/test-repo" },
      },
    ],
  },
};

/**
 * Same single fetched node as `NO_MATCH_SEARCH_RESULT`, but GitHub reports
 * far more total matches than the dedup check's page size (10) fetched —
 * the check is incomplete, not exhaustive.
 */
const TRUNCATED_NO_MATCH_SEARCH_RESULT = {
  search: {
    issueCount: 42,
    nodes: NO_MATCH_SEARCH_RESULT.search.nodes,
  },
};

const REPO_ID_RESULT = { repository: { id: "repo-id-1" } };

const CREATE_ISSUE_RESULT = {
  createIssue: {
    issue: {
      id: "issue-node-id-1",
      number: 5001,
      title: "Login Bug",
      url: "https://github.com/test-owner/test-repo/issues/5001",
    },
  },
};

const ADD_TO_PROJECT_RESULT = {
  addProjectV2ItemById: { item: { id: "project-item-id-1" } },
};

const UPDATE_FIELD_RESULT = {
  updateProjectV2ItemFieldValue: { projectV2Item: { id: "project-item-id-1" } },
};

describe("create_issue pre-creation dedup check (GH-1572 Phase 3)", () => {
  it("refuses creation with a toolError naming the match on an exact-title OPEN duplicate", async () => {
    const client = createMockClient({ query: [EXISTING_MATCH_SEARCH_RESULT] });
    const server = buildServer(client, createMockFieldCache());
    const tool = getTool(server, "ralph_hero__create_issue");

    const result = await tool.handler({ title: "login bug" }, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("#1523");
    expect(result.content[0].text).toContain("skipDedupeCheck");
    expect(client.query).toHaveBeenCalledTimes(1); // search only — never reached Step 1
    expect(client.mutate).not.toHaveBeenCalled();
  });

  it("skipDedupeCheck: true bypasses the search entirely and creates normally", async () => {
    const client = createMockClient({
      query: [REPO_ID_RESULT],
      mutate: [CREATE_ISSUE_RESULT],
      projectMutate: [ADD_TO_PROJECT_RESULT, UPDATE_FIELD_RESULT, UPDATE_FIELD_RESULT],
    });
    const server = buildServer(client, createMockFieldCache());
    const tool = getTool(server, "ralph_hero__create_issue");

    const result = await tool.handler(
      { title: "Login Bug", skipDedupeCheck: true },
      {},
    );
    const payload = parsePayload(result);

    expect(result.isError).toBeFalsy();
    expect(payload.number).toBe(5001);
    expect(client.query).toHaveBeenCalledTimes(1); // repo-ID only — no search call
  });

  it("a non-matching title proceeds to normal creation after one search call", async () => {
    const client = createMockClient({
      query: [NO_MATCH_SEARCH_RESULT, REPO_ID_RESULT],
      mutate: [CREATE_ISSUE_RESULT],
      projectMutate: [ADD_TO_PROJECT_RESULT, UPDATE_FIELD_RESULT, UPDATE_FIELD_RESULT],
    });
    const server = buildServer(client, createMockFieldCache());
    const tool = getTool(server, "ralph_hero__create_issue");

    const result = await tool.handler({ title: "Login Bug" }, {});
    const payload = parsePayload(result);

    expect(result.isError).toBeFalsy();
    expect(payload.number).toBe(5001);
    expect(client.query).toHaveBeenCalledTimes(2); // search, then repo-ID
  });

  it("refuses creation with a toolError when the dedup search is truncated and no match was found in the fetched page", async () => {
    const client = createMockClient({
      query: [TRUNCATED_NO_MATCH_SEARCH_RESULT],
    });
    const server = buildServer(client, createMockFieldCache());
    const tool = getTool(server, "ralph_hero__create_issue");

    const result = await tool.handler({ title: "Login Bug" }, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("42");
    expect(result.content[0].text).toContain("skipDedupeCheck");
    expect(client.query).toHaveBeenCalledTimes(1); // search only — never reached Step 1
    expect(client.mutate).not.toHaveBeenCalled();
  });

  it("skipDedupeCheck: true bypasses the truncated-search guard entirely", async () => {
    const client = createMockClient({
      query: [REPO_ID_RESULT],
      mutate: [CREATE_ISSUE_RESULT],
      projectMutate: [ADD_TO_PROJECT_RESULT, UPDATE_FIELD_RESULT, UPDATE_FIELD_RESULT],
    });
    const server = buildServer(client, createMockFieldCache());
    const tool = getTool(server, "ralph_hero__create_issue");

    const result = await tool.handler(
      { title: "Login Bug", skipDedupeCheck: true },
      {},
    );
    const payload = parsePayload(result);

    expect(result.isError).toBeFalsy();
    expect(payload.number).toBe(5001);
  });

  it("a dedup search failure is swallowed and falls through to normal creation", async () => {
    const client = createMockClient({
      query: makeThrowOnceThenQueue([REPO_ID_RESULT]),
      mutate: [CREATE_ISSUE_RESULT],
      projectMutate: [ADD_TO_PROJECT_RESULT, UPDATE_FIELD_RESULT, UPDATE_FIELD_RESULT],
    });
    const server = buildServer(client, createMockFieldCache());
    const tool = getTool(server, "ralph_hero__create_issue");

    const result = await tool.handler({ title: "Login Bug" }, {});
    const payload = parsePayload(result);

    expect(result.isError).toBeFalsy();
    expect(payload.number).toBe(5001);
  });
});
