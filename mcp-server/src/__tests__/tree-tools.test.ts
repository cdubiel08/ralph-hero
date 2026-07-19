/**
 * Tests for tree-tools: aliased GraphQL mutation builders and
 * sibling-index dependency cycle validation for create_sub_issues.
 *
 * The builders and cycle detector are pure functions and can be tested
 * without mocking a live client.
 */

import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  buildCreateIssuesMutation,
  buildAddSubIssuesMutation,
  buildAddToProjectMutation,
  buildDependencyEdgesMutation,
  detectSiblingCycle,
  registerTreeTools,
} from "../tools/tree-tools.js";
import type { GitHubClient } from "../github-client.js";
import type { GitHubClientConfig } from "../types.js";
import { FieldOptionCache } from "../lib/cache.js";

// ---------------------------------------------------------------------------
// buildCreateIssuesMutation
// ---------------------------------------------------------------------------

describe("buildCreateIssuesMutation", () => {
  it("generates correct aliases and per-alias variables", () => {
    const { mutationString, variables } = buildCreateIssuesMutation("repo-123", [
      { alias: "c0", title: "First", body: "body one" },
      { alias: "c1", title: "Second" },
    ]);

    expect(mutationString.trimStart()).toMatch(/^mutation\(/);
    expect(mutationString).toContain("createIssue");
    expect(mutationString).toContain("c0:");
    expect(mutationString).toContain("c1:");

    // Shared repo id
    expect(variables.repoId).toBe("repo-123");

    // Per-alias title/body variables
    expect(variables.title_c0).toBe("First");
    expect(variables.body_c0).toBe("body one");
    expect(variables.title_c1).toBe("Second");
    // Missing body coerces to null so the GraphQL String var is satisfied
    expect(variables.body_c1).toBeNull();
  });

  it("requests issue number and url in the selection set", () => {
    const { mutationString } = buildCreateIssuesMutation("r", [
      { alias: "c0", title: "X" },
    ]);
    expect(mutationString).toContain("number");
    expect(mutationString).toContain("url");
    expect(mutationString).toContain("id");
  });
});

// ---------------------------------------------------------------------------
// buildAddSubIssuesMutation
// ---------------------------------------------------------------------------

describe("buildAddSubIssuesMutation", () => {
  it("links each child under the shared parent", () => {
    const { mutationString, variables } = buildAddSubIssuesMutation("parent-1", [
      { alias: "l0", childId: "child-a" },
      { alias: "l1", childId: "child-b" },
    ]);

    expect(mutationString).toContain("addSubIssue");
    expect(mutationString).toContain("l0:");
    expect(mutationString).toContain("l1:");
    expect(variables.parentId).toBe("parent-1");
    expect(variables.child_l0).toBe("child-a");
    expect(variables.child_l1).toBe("child-b");
  });
});

// ---------------------------------------------------------------------------
// buildAddToProjectMutation
// ---------------------------------------------------------------------------

describe("buildAddToProjectMutation", () => {
  it("adds each content id to the shared project", () => {
    const { mutationString, variables } = buildAddToProjectMutation("proj-1", [
      { alias: "p0", contentId: "issue-a" },
      { alias: "p1", contentId: "issue-b" },
    ]);

    expect(mutationString).toContain("addProjectV2ItemById");
    expect(mutationString).toContain("p0:");
    expect(mutationString).toContain("p1:");
    expect(variables.projectId).toBe("proj-1");
    expect(variables.content_p0).toBe("issue-a");
    expect(variables.content_p1).toBe("issue-b");
  });
});

// ---------------------------------------------------------------------------
// buildDependencyEdgesMutation
// ---------------------------------------------------------------------------

describe("buildDependencyEdgesMutation", () => {
  it("wires blocked/blocking edges with collision-free variables", () => {
    const { mutationString, variables } = buildDependencyEdgesMutation([
      { alias: "e0", blockedId: "b0", blockingId: "k0" },
      { alias: "e1", blockedId: "b1", blockingId: "k1" },
    ]);

    expect(mutationString).toContain("addBlockedBy");
    expect(mutationString).toContain("e0:");
    expect(mutationString).toContain("e1:");
    expect(variables.blocked_e0).toBe("b0");
    expect(variables.blocking_e0).toBe("k0");
    expect(variables.blocked_e1).toBe("b1");
    expect(variables.blocking_e1).toBe("k1");
  });
});

// ---------------------------------------------------------------------------
// Variable naming safety
// ---------------------------------------------------------------------------

describe("tree-tools variable naming safety", () => {
  it("never uses reserved @octokit/graphql variable names", () => {
    const reserved = ["query", "method", "url"];

    const collect = (vars: Record<string, unknown>) => {
      for (const key of Object.keys(vars)) {
        expect(reserved).not.toContain(key);
      }
    };

    collect(buildCreateIssuesMutation("r", [{ alias: "c0", title: "T" }]).variables);
    collect(buildAddSubIssuesMutation("p", [{ alias: "l0", childId: "c" }]).variables);
    collect(buildAddToProjectMutation("p", [{ alias: "p0", contentId: "c" }]).variables);
    collect(
      buildDependencyEdgesMutation([{ alias: "e0", blockedId: "b", blockingId: "k" }])
        .variables,
    );
  });
});

// ---------------------------------------------------------------------------
// detectSiblingCycle
// ---------------------------------------------------------------------------

describe("detectSiblingCycle", () => {
  it("returns null for an acyclic sibling graph", () => {
    // 0 <- 1 <- 2 (child 1 depends on 0, child 2 depends on 1)
    const cycle = detectSiblingCycle([
      { title: "a", dependsOn: [] },
      { title: "b", dependsOn: [0] },
      { title: "c", dependsOn: [1] },
    ]);
    expect(cycle).toBeNull();
  });

  it("detects a direct two-node cycle", () => {
    const cycle = detectSiblingCycle([
      { title: "a", dependsOn: [1] },
      { title: "b", dependsOn: [0] },
    ]);
    expect(cycle).not.toBeNull();
    expect(cycle).toEqual(expect.arrayContaining([0, 1]));
  });

  it("detects a self-referential cycle", () => {
    const cycle = detectSiblingCycle([{ title: "a", dependsOn: [0] }]);
    expect(cycle).toEqual([0]);
  });

  it("detects a 3-node cycle (0 -> 1 -> 2 -> 0)", () => {
    // Child 0 depends on 1, child 1 depends on 2, child 2 depends on 0.
    const cycle = detectSiblingCycle([
      { title: "a", dependsOn: [1] },
      { title: "b", dependsOn: [2] },
      { title: "c", dependsOn: [0] },
    ]);
    expect(cycle).not.toBeNull();
    expect(cycle).toEqual(expect.arrayContaining([0, 1, 2]));
    expect(cycle).toHaveLength(3);
  });

  it("ignores dependsOn values that are existing GH issue numbers", () => {
    // With 2 children, a dependsOn value of 5 is an existing issue number,
    // not a sibling index — it must not be treated as a cycle edge.
    const cycle = detectSiblingCycle([
      { title: "a", dependsOn: [5] },
      { title: "b", dependsOn: [999] },
    ]);
    expect(cycle).toBeNull();
  });

  it("returns null when no dependsOn is present", () => {
    const cycle = detectSiblingCycle([{ title: "a" }, { title: "b" }]);
    expect(cycle).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Chunking: >50 children produces multiple chunked mutation strings
// ---------------------------------------------------------------------------
//
// The Zod schema caps `children` at 50, so the tool handler itself can never
// be called with more — but the exported builders accept arbitrary arrays,
// and the tool's internal `chunk()` helper (MUTATION_CHUNK_SIZE = 50) splits
// any larger set before calling them. These tests exercise that chunking
// boundary directly against the pure builders.

function chunkArray<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

describe("tree-tools chunking (>50 children)", () => {
  it("splits 60 children into two chunked buildCreateIssuesMutation calls", () => {
    const children = Array.from({ length: 60 }, (_, i) => ({
      alias: `c${i}`,
      title: `Child ${i}`,
    }));

    const chunks = chunkArray(children, 50);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(50);
    expect(chunks[1]).toHaveLength(10);

    const mutations = chunks.map((c) => buildCreateIssuesMutation("repo-1", c));
    expect(mutations).toHaveLength(2);

    // First chunk covers c0..c49, and must not spill into c50.
    expect(mutations[0].mutationString).toContain("c0:");
    expect(mutations[0].mutationString).toContain("c49:");
    expect(mutations[0].mutationString).not.toContain("c50:");

    // Second chunk covers c50..c59.
    expect(mutations[1].mutationString).toContain("c50:");
    expect(mutations[1].mutationString).toContain("c59:");

    // Variables are chunk-local: chunk 0 has 50 titles, chunk 1 has 10.
    expect(Object.keys(mutations[0].variables).filter((k) => k.startsWith("title_"))).toHaveLength(50);
    expect(Object.keys(mutations[1].variables).filter((k) => k.startsWith("title_"))).toHaveLength(10);
  });

  it("splits 60 sub-issue links into two chunked buildAddSubIssuesMutation calls", () => {
    const links = Array.from({ length: 60 }, (_, i) => ({
      alias: `l${i}`,
      childId: `child-node-${i}`,
    }));

    const chunks = chunkArray(links, 50);
    expect(chunks).toHaveLength(2);

    const mutations = chunks.map((c) => buildAddSubIssuesMutation("parent-1", c));
    expect(mutations[0].mutationString).toContain("l0:");
    expect(mutations[0].mutationString).not.toContain("l50:");
    expect(mutations[1].mutationString).toContain("l50:");
    expect(mutations[1].mutationString).toContain("l59:");
  });
});

// ---------------------------------------------------------------------------
// Handler-level: registerTreeTools against a mock McpServer + GitHubClient
// ---------------------------------------------------------------------------
//
// Mock-client and handler-extraction pattern mirrors
// create-issue-defaults.test.ts / sre-tools.test.ts: independent response
// queues per client method (query/mutate/projectMutate), a directly
// populated FieldOptionCache (bypassing ensureFieldCache's network fetch),
// and `_registeredTools[name].handler` to invoke the tool without going
// through the MCP transport.

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

function createMockClient(
  configOverrides: Partial<GitHubClientConfig>,
  responses: {
    query?: unknown[];
    mutate?: Array<unknown | Error>;
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

  function makeQueryQueue(name: string, queue: unknown[] = []) {
    let idx = 0;
    return vi.fn(async () => {
      if (idx >= queue.length) {
        throw new Error(`No more mock ${name} responses`);
      }
      return queue[idx++];
    });
  }

  // Mutate queue supports Error entries so a caller can simulate a
  // stage-specific failure (e.g. Stage 2 addSubIssue throwing) while
  // earlier/later calls in the same queue still resolve normally.
  function makeMutateQueue(name: string, queue: Array<unknown | Error> = []) {
    let idx = 0;
    return vi.fn(async () => {
      if (idx >= queue.length) {
        throw new Error(`No more mock ${name} responses`);
      }
      const next = queue[idx++];
      if (next instanceof Error) throw next;
      return next;
    });
  }

  const cacheStore = new Map<string, { value: unknown; expiry: number }>();

  return {
    config: fullConfig,
    query: makeQueryQueue("query", responses.query),
    projectQuery: vi.fn(async () => {
      throw new Error("Unexpected projectQuery call");
    }),
    mutate: makeMutateQueue("mutate", responses.mutate),
    projectMutate: makeMutateQueue("projectMutate", responses.projectMutate),
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

function createMockFieldCache(): FieldOptionCache {
  const cache = new FieldOptionCache();
  // No workflowState/estimate/priority fields needed for this test — Stage 3
  // is vacuously satisfied when a child requests no field values.
  cache.populate(3, "project-id-123", []);
  return cache;
}

function buildServer(client: GitHubClient, fieldCache: FieldOptionCache): McpServer {
  const server = new McpServer({ name: "test-server", version: "0.0.0" });
  registerTreeTools(server, client, fieldCache);
  return server;
}

describe("ralph_hero__create_sub_issues handler — Stage 2 partial failure", () => {
  it("reports created:true, linked:false per child and partialFailure:true when addSubIssue throws", async () => {
    const fieldCache = createMockFieldCache();
    const client = createMockClient(
      {},
      {
        query: [
          // Stage 0a: repository id lookup for createIssue.
          { repository: { id: "repo-id-1" } },
          // Stage 0b: resolveIssueNodeId for the parent issue.
          { repository: { issue: { id: "parent-node-id" } } },
        ],
        mutate: [
          // Stage 1: create issues succeeds for both children.
          {
            c0: { issue: { id: "child-node-0", number: 101, url: "https://x/101" } },
            c1: { issue: { id: "child-node-1", number: 102, url: "https://x/102" } },
          },
          // Stage 2a: addSubIssue throws.
          new Error("addSubIssue failed: some GraphQL error"),
        ],
        projectMutate: [
          // Stage 2b: addProjectV2ItemById still succeeds independently of 2a.
          {
            p0: { item: { id: "project-item-0" } },
            p1: { item: { id: "project-item-1" } },
          },
        ],
      },
    );
    const server = buildServer(client, fieldCache);
    const tool = getTool(server, "ralph_hero__create_sub_issues");

    const result = await tool.handler(
      {
        parentNumber: 42,
        children: [{ title: "First child" }, { title: "Second child" }],
      },
      {},
    );
    const payload = parsePayload(result);

    expect(result.isError).toBeFalsy();
    expect(payload.partialFailure).toBe(true);

    const children = payload.children as Array<{
      created: boolean;
      linked: boolean;
      error?: string;
    }>;
    expect(children).toHaveLength(2);
    for (const child of children) {
      expect(child.created).toBe(true);
      expect(child.linked).toBe(false);
      expect(child.error).toContain("Stage 2 (link) failed");
    }
  });
});

describe("ralph_hero__create_sub_issues handler — Stage 3 resolution failure", () => {
  it("keeps fieldsSet:false with a Stage 3 error when a child's only field fails to resolve", async () => {
    // Field cache has no Workflow State field, so resolution fails.
    const fieldCache = createMockFieldCache();
    const client = createMockClient(
      {},
      {
        query: [
          { repository: { id: "repo-id-1" } },
          { repository: { issue: { id: "parent-node-id" } } },
        ],
        mutate: [
          // Stage 1: create succeeds.
          { c0: { issue: { id: "child-node-0", number: 101, url: "https://x/101" } } },
          // Stage 2a: addSubIssue succeeds.
          { l0: { subIssue: { id: "child-node-0" } } },
        ],
        projectMutate: [
          // Stage 2b: add to project succeeds.
          { p0: { item: { id: "project-item-0" } } },
          // No Stage 3 mutation — resolution fails before any field update.
        ],
      },
    );
    const server = buildServer(client, fieldCache);
    const tool = getTool(server, "ralph_hero__create_sub_issues");

    const result = await tool.handler(
      {
        parentNumber: 42,
        children: [{ title: "Only child", workflowState: "Backlogg" }],
      },
      {},
    );
    const payload = parsePayload(result);

    expect(result.isError).toBeFalsy();
    expect(payload.partialFailure).toBe(true);

    const children = payload.children as Array<{
      created: boolean;
      linked: boolean;
      fieldsSet: boolean;
      error?: string;
    }>;
    expect(children).toHaveLength(1);
    expect(children[0].created).toBe(true);
    expect(children[0].linked).toBe(true);
    expect(children[0].fieldsSet).toBe(false);
    expect(children[0].error).toContain("Stage 3: could not resolve");
  });
});
