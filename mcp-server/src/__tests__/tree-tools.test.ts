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
  packByChild,
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
        children: [{ title: "Only child", workflowState: "Backlog" }],
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

// ---------------------------------------------------------------------------
// packByChild — whole-child groups never straddle a chunk boundary (F3/F4)
// ---------------------------------------------------------------------------

describe("packByChild", () => {
  it("keeps each child's group whole; a group that would straddle starts a new chunk", () => {
    // Three groups of 30 each, size 50. A flat chunk(90, 50) would split the
    // middle group across the boundary; packByChild must not.
    const groups = new Map<number, number[]>([
      [0, Array.from({ length: 30 }, (_, i) => i)],
      [1, Array.from({ length: 30 }, (_, i) => 100 + i)],
      [2, Array.from({ length: 30 }, (_, i) => 200 + i)],
    ]);
    const chunks = packByChild(groups, 50);
    // No chunk mixes a partial group: each child index appears in exactly one
    // chunk, and that chunk carries all 30 of its items.
    expect(chunks).toHaveLength(3);
    for (const c of chunks) {
      expect(c.childIndices).toHaveLength(1);
      expect(c.items).toHaveLength(30);
    }
    expect(chunks.map((c) => c.childIndices[0])).toEqual([0, 1, 2]);
  });

  it("packs multiple small groups into one chunk up to size", () => {
    const groups = new Map<number, number[]>([
      [0, [1, 2]],
      [1, [3, 4]],
      [2, [5, 6]],
    ]);
    const chunks = packByChild(groups, 50);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].childIndices).toEqual([0, 1, 2]);
    expect(chunks[0].items).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("emits an oversized lone chunk rather than splitting a single large group", () => {
    const groups = new Map<number, number[]>([
      [0, Array.from({ length: 60 }, (_, i) => i)],
    ]);
    const chunks = packByChild(groups, 50);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].childIndices).toEqual([0]);
    expect(chunks[0].items).toHaveLength(60);
  });
});

// ---------------------------------------------------------------------------
// Handler-level: partial err.data salvage, dependsOn validation,
// dependsOnIssues, blocked-only edge attribution (F1/F2/F5/F6)
// ---------------------------------------------------------------------------

/** A GraphqlResponseError-shaped error: message + partial `.data` payload. */
function graphqlError(
  message: string,
  data: Record<string, unknown>,
): Error {
  const err = new Error(message) as Error & { data: Record<string, unknown> };
  err.data = data;
  return err;
}

describe("ralph_hero__create_sub_issues handler — Stage 1 partial err.data salvage (F1)", () => {
  it("salvages aliases present in err.data as created; absent aliases get the stage error", async () => {
    const fieldCache = createMockFieldCache();
    const client = createMockClient(
      {},
      {
        query: [
          { repository: { id: "repo-id-1" } },
          { repository: { issue: { id: "parent-node-id" } } },
        ],
        mutate: [
          // Stage 1: createIssue throws but carries c0 in err.data (c1 absent).
          graphqlError("createIssue partial failure", {
            c0: { issue: { id: "child-node-0", number: 101, url: "https://x/101" } },
          }),
          // Stage 2a: addSubIssue succeeds for the salvaged child.
          { l0: { subIssue: { id: "child-node-0" } } },
        ],
        projectMutate: [
          // Stage 2b: add to project succeeds for the salvaged child.
          { p0: { item: { id: "project-item-0" } } },
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
      number?: number;
      error?: string;
    }>;
    expect(children[0].created).toBe(true);
    expect(children[0].number).toBe(101);
    expect(children[1].created).toBe(false);
    expect(children[1].error).toContain("Stage 1 (create) failed");
  });
});

describe("ralph_hero__create_sub_issues handler — Stage 2a partial err.data salvage (F2)", () => {
  it("marks aliases present in err.data as linked; absent aliases get the link error", async () => {
    const fieldCache = createMockFieldCache();
    const client = createMockClient(
      {},
      {
        query: [
          { repository: { id: "repo-id-1" } },
          { repository: { issue: { id: "parent-node-id" } } },
        ],
        mutate: [
          {
            c0: { issue: { id: "child-node-0", number: 101, url: "https://x/101" } },
            c1: { issue: { id: "child-node-1", number: 102, url: "https://x/102" } },
          },
          // Stage 2a: addSubIssue throws but l0 linked before l1 failed.
          graphqlError("addSubIssue partial failure", {
            l0: { subIssue: { id: "child-node-0" } },
            l1: null,
          }),
        ],
        projectMutate: [
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

    expect(payload.partialFailure).toBe(true);
    const children = payload.children as Array<{
      linked: boolean;
      error?: string;
    }>;
    expect(children[0].linked).toBe(true);
    expect(children[0].error).toBeUndefined();
    expect(children[1].linked).toBe(false);
    expect(children[1].error).toContain("Stage 2 (link) failed");
  });
});

describe("ralph_hero__create_sub_issues handler — dependsOn strict-sibling validation (F6)", () => {
  it("rejects an out-of-range dependsOn value up front, naming the offender", async () => {
    const fieldCache = createMockFieldCache();
    // No mutation responses needed — validation returns before any GraphQL.
    const client = createMockClient({}, {});
    const server = buildServer(client, fieldCache);
    const tool = getTool(server, "ralph_hero__create_sub_issues");

    const result = await tool.handler(
      {
        parentNumber: 42,
        children: [
          { title: "First child" },
          { title: "Second child", dependsOn: [5] },
        ],
      },
      {},
    );

    expect(result.isError).toBe(true);
    const payload = parsePayload(result);
    expect(payload.error).toContain("invalid dependsOn");
    expect(payload.error).toContain("5");
    expect(payload.error).toContain("dependsOnIssues");
  });
});

describe("ralph_hero__create_sub_issues handler — dependsOnIssues wires edges to existing issues (F6)", () => {
  it("resolves a pre-existing issue number and wires the edge", async () => {
    const fieldCache = createMockFieldCache();
    const client = createMockClient(
      {},
      {
        query: [
          // Up-front (GH-1618): resolveDependsOnIssuesUpFront resolves #999
          // in one aliased query before any mutation, and seeds the cache
          // Stage 4's resolveIssueNodeId(999) call below reads from — no
          // second query for the same issue.
          // Aliases sit under ONE repository selection (chunked resolution),
          // not one repository(...) per alias.
          { repository: { n0: { id: "issue-999-node" } } },
          { repository: { id: "repo-id-1" } },
          { repository: { issue: { id: "parent-node-id" } } },
        ],
        mutate: [
          {
            c0: { issue: { id: "child-node-0", number: 101, url: "https://x/101" } },
            c1: { issue: { id: "child-node-1", number: 102, url: "https://x/102" } },
          },
          // Stage 2a: addSubIssue succeeds.
          { l0: {}, l1: {} },
          // Stage 4: dependency edge succeeds.
          { e1_0: { issue: { id: "child-node-1" } } },
        ],
        projectMutate: [
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
        children: [
          { title: "First child" },
          { title: "Second child", dependsOnIssues: [999] },
        ],
      },
      {},
    );
    const payload = parsePayload(result);

    expect(result.isError).toBeFalsy();
    expect(payload.partialFailure).toBe(false);
    const children = payload.children as Array<{ edgesWired: boolean }>;
    // Both wired: child0 vacuously (no edges), child1 via the resolved edge.
    expect(children[0].edgesWired).toBe(true);
    expect(children[1].edgesWired).toBe(true);
  });
});

describe("ralph_hero__create_sub_issues handler — Stage 4 blocked-only error attribution (F5)", () => {
  it("attaches a failed-edge error ONLY to the blocked child, not the blocking sibling", async () => {
    const fieldCache = createMockFieldCache();
    const client = createMockClient(
      {},
      {
        query: [
          { repository: { id: "repo-id-1" } },
          { repository: { issue: { id: "parent-node-id" } } },
        ],
        mutate: [
          {
            c0: { issue: { id: "child-node-0", number: 101, url: "https://x/101" } },
            c1: { issue: { id: "child-node-1", number: 102, url: "https://x/102" } },
          },
          // Stage 2a: addSubIssue succeeds.
          { l0: {}, l1: {} },
          // Stage 4: dependency edges throw (plain error, no partial data).
          new Error("addBlockedBy failed"),
        ],
        projectMutate: [
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
        // child1 (blocked) depends on sibling index 0 (the blocker).
        children: [
          { title: "Blocker" },
          { title: "Blocked", dependsOn: [0] },
        ],
      },
      {},
    );
    const payload = parsePayload(result);

    expect(payload.partialFailure).toBe(true);
    const children = payload.children as Array<{
      edgesWired: boolean;
      error?: string;
    }>;
    // Blocked child (index 1) carries the edge error and stays unwired.
    expect(children[1].edgesWired).toBe(false);
    expect(children[1].error).toContain("Stage 4 (edges) failed");
    // Blocking sibling (index 0) is untouched: no error, vacuously wired.
    expect(children[0].edgesWired).toBe(true);
    expect(children[0].error).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// GH-1618: tree contracts — maxChildEstimate ceiling, up-front workflowState
// validity, up-front dependsOnIssues resolvability. All whole-batch,
// before any mutation (nothing is created on a violation).
// ---------------------------------------------------------------------------

describe("ralph_hero__create_sub_issues handler — maxChildEstimate ceiling (GH-1618)", () => {
  it("rejects a child estimate above an explicit ceiling, creating zero issues", async () => {
    const fieldCache = createMockFieldCache();
    // No responses queued at all — the ceiling check must refuse before any
    // GraphQL call, so an accidental early call surfaces as a queue-exhaustion
    // error instead of the expected refusal text (a regression pinner).
    const client = createMockClient({}, {});
    const server = buildServer(client, fieldCache);
    const tool = getTool(server, "ralph_hero__create_sub_issues");

    const result = await tool.handler(
      {
        parentNumber: 42,
        maxChildEstimate: "S",
        children: [{ title: "Too big", estimate: "M" }],
      },
      {},
    );

    expect(result.isError).toBe(true);
    const payload = parsePayload(result);
    expect(payload.error).toContain("estimate M");
    expect(payload.error).toContain("maxChildEstimate=S");
    expect(client.mutate).not.toHaveBeenCalled();
    expect(client.projectMutate).not.toHaveBeenCalled();
  });

  it("refuses a child with no estimate when maxChildEstimate is armed explicitly", async () => {
    const fieldCache = createMockFieldCache();
    const client = createMockClient({}, {});
    const server = buildServer(client, fieldCache);
    const tool = getTool(server, "ralph_hero__create_sub_issues");

    const result = await tool.handler(
      {
        parentNumber: 42,
        maxChildEstimate: "S",
        children: [{ title: "No estimate" }],
      },
      {},
    );

    expect(result.isError).toBe(true);
    const payload = parsePayload(result);
    expect(payload.error).toContain("has no estimate");
    expect(payload.error).toContain("maxChildEstimate=S");
    expect(client.mutate).not.toHaveBeenCalled();
  });

  it("creates an unestimated child under the DEFAULT ceiling and reports it in unestimatedChildren", async () => {
    const fieldCache = createMockFieldCache();
    const client = createMockClient(
      {},
      {
        query: [
          { repository: { id: "repo-id-1" } },
          { repository: { issue: { id: "parent-node-id" } } },
        ],
        mutate: [
          { c0: { issue: { id: "child-node-0", number: 101, url: "https://x/101" } } },
          { l0: {} },
        ],
        projectMutate: [{ p0: { item: { id: "project-item-0" } } }],
      },
    );
    const server = buildServer(client, fieldCache);
    const tool = getTool(server, "ralph_hero__create_sub_issues");

    const result = await tool.handler(
      {
        parentNumber: 42,
        // No maxChildEstimate — falls back to the "M" default.
        children: [{ title: "No estimate, default ceiling" }],
      },
      {},
    );

    expect(result.isError).toBeFalsy();
    const payload = parsePayload(result);
    expect(payload.unestimatedChildren).toEqual([0]);
    const children = payload.children as Array<{ created: boolean }>;
    expect(children[0].created).toBe(true);
  });

  it("passes an M child under the default ceiling (epic-decomposition counter-example)", async () => {
    const fieldCache = createMockFieldCache();
    const client = createMockClient(
      {},
      {
        query: [
          { repository: { id: "repo-id-1" } },
          { repository: { issue: { id: "parent-node-id" } } },
        ],
        mutate: [
          { c0: { issue: { id: "child-node-0", number: 101, url: "https://x/101" } } },
          { l0: {} },
        ],
        projectMutate: [{ p0: { item: { id: "project-item-0" } } }],
      },
    );
    const server = buildServer(client, fieldCache);
    const tool = getTool(server, "ralph_hero__create_sub_issues");

    const result = await tool.handler(
      {
        parentNumber: 42,
        // No maxChildEstimate — the "M" default must NOT block this epic's
        // own M-estimate feature children (the counter-example that ruled
        // out an unconditional ceiling).
        children: [{ title: "Feature child", estimate: "M" }],
      },
      {},
    );

    expect(result.isError).toBeFalsy();
    const payload = parsePayload(result);
    expect(payload.unestimatedChildren).toBeUndefined();
    const children = payload.children as Array<{ created: boolean }>;
    expect(children[0].created).toBe(true);
  });

  it("refuses an XL child under the default ceiling (the closed L/XL hole)", async () => {
    const fieldCache = createMockFieldCache();
    const client = createMockClient({}, {});
    const server = buildServer(client, fieldCache);
    const tool = getTool(server, "ralph_hero__create_sub_issues");

    const result = await tool.handler(
      {
        parentNumber: 42,
        // No maxChildEstimate — the "M" default must still refuse XL.
        children: [{ title: "Too coarse", estimate: "XL" }],
      },
      {},
    );

    expect(result.isError).toBe(true);
    const payload = parsePayload(result);
    expect(payload.error).toContain("estimate XL");
    expect(payload.error).toContain("maxChildEstimate=M");
    expect(client.mutate).not.toHaveBeenCalled();
  });

  it("allows an XL child when maxChildEstimate is explicitly raised (deliberate coarse decomposition)", async () => {
    const fieldCache = createMockFieldCache();
    const client = createMockClient(
      {},
      {
        query: [
          { repository: { id: "repo-id-1" } },
          { repository: { issue: { id: "parent-node-id" } } },
        ],
        mutate: [
          { c0: { issue: { id: "child-node-0", number: 101, url: "https://x/101" } } },
          { l0: {} },
        ],
        projectMutate: [{ p0: { item: { id: "project-item-0" } } }],
      },
    );
    const server = buildServer(client, fieldCache);
    const tool = getTool(server, "ralph_hero__create_sub_issues");

    const result = await tool.handler(
      {
        parentNumber: 42,
        maxChildEstimate: "XL",
        children: [{ title: "Deliberately coarse", estimate: "XL" }],
      },
      {},
    );

    expect(result.isError).toBeFalsy();
    const payload = parsePayload(result);
    const children = payload.children as Array<{ created: boolean }>;
    expect(children[0].created).toBe(true);
  });
});

describe("ralph_hero__create_sub_issues handler — up-front workflowState validity (GH-1618)", () => {
  it("rejects an unknown workflowState up front, creating zero issues", async () => {
    const fieldCache = createMockFieldCache();
    const client = createMockClient({}, {});
    const server = buildServer(client, fieldCache);
    const tool = getTool(server, "ralph_hero__create_sub_issues");

    const result = await tool.handler(
      {
        parentNumber: 42,
        children: [{ title: "Bad state", workflowState: "Not A Real State" }],
      },
      {},
    );

    expect(result.isError).toBe(true);
    const payload = parsePayload(result);
    expect(payload.error).toContain('unknown workflowState "Not A Real State"');
    expect(client.mutate).not.toHaveBeenCalled();
  });
});

describe("ralph_hero__create_sub_issues handler — up-front dependsOnIssues resolvability (GH-1618)", () => {
  it("rejects an unresolvable dependsOnIssues number up front, creating zero issues", async () => {
    const fieldCache = createMockFieldCache();
    const client = createMockClient(
      {},
      {
        // Up-front resolution query returns no `n0` alias — treated as
        // unresolved, same as GraphQL genuinely returning issue: null.
        query: [{}],
      },
    );
    const server = buildServer(client, fieldCache);
    const tool = getTool(server, "ralph_hero__create_sub_issues");

    const result = await tool.handler(
      {
        parentNumber: 42,
        children: [{ title: "Blocked by ghost", dependsOnIssues: [9999] }],
      },
      {},
    );

    expect(result.isError).toBe(true);
    const payload = parsePayload(result);
    expect(payload.error).toContain("unknown issue number");
    expect(payload.error).toContain("#9999");
    expect(client.mutate).not.toHaveBeenCalled();
  });
});
