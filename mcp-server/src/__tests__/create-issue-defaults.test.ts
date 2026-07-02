/**
 * Tests for the `create_issue` Workflow State default (GH-1524).
 *
 * `create_issue` used to write the Workflow State project field only when
 * the caller passed `workflowState`, silently leaving newly-created items
 * stateless. This suite proves the fix: an omitted `workflowState` now
 * defaults to `"Backlog"` (Step 5 write + Status sync both fire
 * unconditionally), and an explicit value still wins outright.
 *
 * Handler-extraction pattern from `cross-tool-consistency.test.ts:306-317`
 * (`getTool` via `_registeredTools`, `parsePayload`). Mock-client pattern
 * from `auto-advance-parent.test.ts:81-139` (`FieldOptionCache.populate`).
 *
 * Mock gotcha: `updateProjectItemField` (and therefore `syncStatusField`,
 * which calls it) issues its write via `client.projectMutate`, NOT
 * `client.mutate` — only `createIssue` uses `mutate`. Each client method
 * here gets its own independent response queue (rather than one shared
 * global-order queue) specifically so a future accidental method swap
 * (e.g. `updateProjectItemField` switched to `mutate`) fails loudly with
 * "no more mock responses" instead of silently reading the wrong entry.
 */

import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerIssueTools } from "../tools/issue-tools.js";
import type { GitHubClient } from "../github-client.js";
import type { GitHubClientConfig } from "../types.js";
import { FieldOptionCache } from "../lib/cache.js";

// ---------------------------------------------------------------------------
// Handler-extraction harness (mirrors cross-tool-consistency.test.ts:296-317)
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

function parsePayload(result: HandlerResult): Record<string, unknown> {
  expect(result.content).toHaveLength(1);
  return JSON.parse(result.content[0].text);
}

// ---------------------------------------------------------------------------
// Mock GitHubClient — independent response queues per method (see file-level
// gotcha note above for why this beats one shared global-order queue).
// ---------------------------------------------------------------------------

function createMockClient(
  configOverrides: Partial<GitHubClientConfig>,
  responses: {
    query?: unknown[];
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
    ...configOverrides,
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

  const cacheStore = new Map<string, { value: unknown; expiry: number }>();

  return {
    config: fullConfig,
    query: makeQueue("query", responses.query),
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
      get: <T>(key: string): T | undefined => {
        const entry = cacheStore.get(key);
        if (!entry || Date.now() > entry.expiry) return undefined;
        return entry.value as T;
      },
      set: (key: string, value: unknown, ttlMs: number) => {
        cacheStore.set(key, { value, expiry: Date.now() + ttlMs });
      },
      invalidateQueries: vi.fn(),
    }),
    getAuthenticatedUser: vi.fn(async () => "test-user"),
    restPost: vi.fn(async () => {
      throw new Error("Unexpected restPost call");
    }),
  } as unknown as GitHubClient;
}

/** Populate a FieldOptionCache with Workflow State + Status options for project 3. */
function createMockFieldCache(): FieldOptionCache {
  const cache = new FieldOptionCache();
  cache.populate(3, "project-id-123", [
    {
      id: "field-ws-id",
      name: "Workflow State",
      options: [
        { id: "opt-backlog", name: "Backlog" },
        { id: "opt-in-progress", name: "In Progress" },
      ],
    },
    {
      id: "field-status-id",
      name: "Status",
      options: [
        { id: "opt-status-todo", name: "Todo" },
        { id: "opt-status-in-progress", name: "In Progress" },
      ],
    },
  ]);
  return cache;
}

function buildServer(client: GitHubClient, fieldCache: FieldOptionCache): McpServer {
  const server = new McpServer({ name: "test-server", version: "0.0.0" });
  registerIssueTools(server, client, fieldCache);
  return server;
}

const CREATE_ISSUE_RESULT = {
  createIssue: {
    issue: {
      id: "issue-node-id-1",
      number: 5001,
      title: "Test issue",
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

describe("create_issue Workflow State default (GH-1524)", () => {
  it("defaults workflowState to Backlog and syncs Status to Todo when omitted", async () => {
    const fieldCache = createMockFieldCache();
    const client = createMockClient(
      {},
      {
        query: [{ repository: { id: "repo-id-1" } }],
        mutate: [CREATE_ISSUE_RESULT],
        projectMutate: [
          ADD_TO_PROJECT_RESULT,
          UPDATE_FIELD_RESULT, // Workflow State -> Backlog
          UPDATE_FIELD_RESULT, // Status -> Todo
        ],
      },
    );
    const server = buildServer(client, fieldCache);
    const tool = getTool(server, "ralph_hero__create_issue");

    const result = await tool.handler({ title: "Test issue" }, {});
    const payload = parsePayload(result);

    expect(result.isError).toBeFalsy();
    expect(payload.fieldsSet).toMatchObject({ workflowState: "Backlog" });

    const projectMutateCalls = (client.projectMutate as unknown as { mock: { calls: unknown[][] } })
      .mock.calls;
    // Call 0: addProjectV2ItemById. Call 1: Workflow State write. Call 2: Status sync.
    expect(projectMutateCalls).toHaveLength(3);

    const workflowStateCallVars = projectMutateCalls[1][1] as {
      fieldId: string;
      optionId: string;
    };
    expect(workflowStateCallVars.fieldId).toBe("field-ws-id");
    expect(workflowStateCallVars.optionId).toBe("opt-backlog");

    const statusCallVars = projectMutateCalls[2][1] as {
      fieldId: string;
      optionId: string;
    };
    expect(statusCallVars.fieldId).toBe("field-status-id");
    expect(statusCallVars.optionId).toBe("opt-status-todo");
  });

  it("honors an explicit workflowState and syncs the matching Status", async () => {
    const fieldCache = createMockFieldCache();
    const client = createMockClient(
      {},
      {
        query: [{ repository: { id: "repo-id-1" } }],
        mutate: [CREATE_ISSUE_RESULT],
        projectMutate: [
          ADD_TO_PROJECT_RESULT,
          UPDATE_FIELD_RESULT, // Workflow State -> In Progress
          UPDATE_FIELD_RESULT, // Status -> In Progress
        ],
      },
    );
    const server = buildServer(client, fieldCache);
    const tool = getTool(server, "ralph_hero__create_issue");

    const result = await tool.handler(
      { title: "Test issue", workflowState: "In Progress" },
      {},
    );
    const payload = parsePayload(result);

    expect(result.isError).toBeFalsy();
    expect(payload.fieldsSet).toMatchObject({ workflowState: "In Progress" });

    const projectMutateCalls = (client.projectMutate as unknown as { mock: { calls: unknown[][] } })
      .mock.calls;
    expect(projectMutateCalls).toHaveLength(3);

    const workflowStateCallVars = projectMutateCalls[1][1] as {
      fieldId: string;
      optionId: string;
    };
    expect(workflowStateCallVars.fieldId).toBe("field-ws-id");
    expect(workflowStateCallVars.optionId).toBe("opt-in-progress");

    const statusCallVars = projectMutateCalls[2][1] as {
      fieldId: string;
      optionId: string;
    };
    expect(statusCallVars.fieldId).toBe("field-status-id");
    expect(statusCallVars.optionId).toBe("opt-status-in-progress");
  });
});
