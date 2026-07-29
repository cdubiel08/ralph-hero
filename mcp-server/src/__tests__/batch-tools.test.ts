/**
 * Tests for batch-tools: aliased GraphQL query/mutation builders
 * and batch_update input validation logic.
 *
 * The query/mutation builders are pure functions and can be tested
 * without mocking. GH-1615 adds a handler-level integration suite
 * (mirroring the `getTool` pattern in `bulk-archive.test.ts`) for the new
 * workflow_state transition-legality refusal path.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  buildBatchResolveQuery,
  buildBatchMutationQuery,
  buildBatchFieldValueQuery,
  registerBatchTools,
} from "../tools/batch-tools.js";
import type { GitHubClient } from "../github-client.js";
import { FieldOptionCache } from "../lib/cache.js";

const batchToolsSrc = fs.readFileSync(
  path.resolve(__dirname, "../tools/batch-tools.ts"),
  "utf-8",
);

// ---------------------------------------------------------------------------
// buildBatchResolveQuery
// ---------------------------------------------------------------------------

describe("buildBatchResolveQuery", () => {
  it("generates correct aliases for N issues", () => {
    const { queryString, variables } = buildBatchResolveQuery(
      "testOwner",
      "testRepo",
      [10, 20, 30],
    );

    // Should have aliases i0, i1, i2
    expect(queryString).toContain("i0:");
    expect(queryString).toContain("i1:");
    expect(queryString).toContain("i2:");
    expect(queryString).not.toContain("i3:");

    // Should reference the variable names
    expect(queryString).toContain("$n0: Int!");
    expect(queryString).toContain("$n1: Int!");
    expect(queryString).toContain("$n2: Int!");

    // Variables should be populated
    expect(variables.owner).toBe("testOwner");
    expect(variables.repo).toBe("testRepo");
    expect(variables.n0).toBe(10);
    expect(variables.n1).toBe(20);
    expect(variables.n2).toBe(30);
  });

  it("includes projectItems in the issue query", () => {
    const { queryString } = buildBatchResolveQuery("o", "r", [1]);
    expect(queryString).toContain("projectItems");
    expect(queryString).toContain("project { id }");
  });

  it("generates a valid query for a single issue", () => {
    const { queryString, variables } = buildBatchResolveQuery("o", "r", [42]);
    expect(queryString).toContain("i0:");
    expect(queryString).toContain("$n0: Int!");
    expect(variables.n0).toBe(42);
    // Should not have i1
    expect(queryString).not.toContain("i1:");
  });
});

// ---------------------------------------------------------------------------
// buildBatchMutationQuery
// ---------------------------------------------------------------------------

describe("buildBatchMutationQuery", () => {
  it("generates correct aliases for N updates", () => {
    const { mutationString, variables } = buildBatchMutationQuery(
      "proj-123",
      [
        { alias: "u10_0", itemId: "item-a", fieldId: "field-ws", optionId: "opt-rn" },
        { alias: "u10_1", itemId: "item-a", fieldId: "field-est", optionId: "opt-xs" },
        { alias: "u20_0", itemId: "item-b", fieldId: "field-ws", optionId: "opt-rn" },
      ],
    );

    // Should have all three aliases
    expect(mutationString).toContain("u10_0:");
    expect(mutationString).toContain("u10_1:");
    expect(mutationString).toContain("u20_0:");

    // Project ID variable
    expect(variables.projectId).toBe("proj-123");

    // Per-alias variables
    expect(variables.item_u10_0).toBe("item-a");
    expect(variables.field_u10_0).toBe("field-ws");
    expect(variables.opt_u10_0).toBe("opt-rn");

    expect(variables.item_u10_1).toBe("item-a");
    expect(variables.field_u10_1).toBe("field-est");
    expect(variables.opt_u10_1).toBe("opt-xs");

    expect(variables.item_u20_0).toBe("item-b");
    expect(variables.field_u20_0).toBe("field-ws");
    expect(variables.opt_u20_0).toBe("opt-rn");
  });

  it("starts with a mutation keyword", () => {
    const { mutationString } = buildBatchMutationQuery("proj", [
      { alias: "u0", itemId: "i", fieldId: "f", optionId: "o" },
    ]);
    expect(mutationString.trimStart()).toMatch(/^mutation\(/);
  });

  it("uses correct GraphQL mutation name", () => {
    const { mutationString } = buildBatchMutationQuery("proj", [
      { alias: "u0", itemId: "i", fieldId: "f", optionId: "o" },
    ]);
    expect(mutationString).toContain("updateProjectV2ItemFieldValue");
  });

  it("references singleSelectOptionId in the value by default", () => {
    const { mutationString } = buildBatchMutationQuery("proj", [
      { alias: "u0", itemId: "i", fieldId: "f", optionId: "o" },
    ]);
    expect(mutationString).toContain("singleSelectOptionId");
  });

  it("uses iterationId value key when valueType is iterationId", () => {
    const { mutationString } = buildBatchMutationQuery("proj", [
      { alias: "iter_0", itemId: "item-a", fieldId: "field-sprint", optionId: "iter-abc", valueType: "iterationId" },
    ]);
    expect(mutationString).toContain("iterationId");
    expect(mutationString).not.toContain("singleSelectOptionId");
  });

  it("mixes singleSelectOptionId and iterationId in the same batch", () => {
    const { mutationString } = buildBatchMutationQuery("proj", [
      { alias: "ws_0", itemId: "item-a", fieldId: "field-ws", optionId: "opt-ip" },
      { alias: "iter_1", itemId: "item-a", fieldId: "field-sprint", optionId: "iter-abc", valueType: "iterationId" },
    ]);
    // Both value keys should be present
    expect(mutationString).toContain("singleSelectOptionId");
    expect(mutationString).toContain("iterationId");
    // Both aliases present
    expect(mutationString).toContain("ws_0:");
    expect(mutationString).toContain("iter_1:");
  });

  it("defaults valueType to singleSelectOptionId when omitted", () => {
    const { mutationString: withDefault } = buildBatchMutationQuery("proj", [
      { alias: "u0", itemId: "i", fieldId: "f", optionId: "o" },
    ]);
    const { mutationString: withExplicit } = buildBatchMutationQuery("proj", [
      { alias: "u0", itemId: "i", fieldId: "f", optionId: "o", valueType: "singleSelectOptionId" },
    ]);
    // Both should produce the same output
    expect(withDefault).toBe(withExplicit);
  });
});

// ---------------------------------------------------------------------------
// buildBatchFieldValueQuery
// ---------------------------------------------------------------------------

describe("buildBatchFieldValueQuery", () => {
  it("generates correct aliases for field value queries", () => {
    const { queryString, variables } = buildBatchFieldValueQuery([
      { alias: "fv10", itemId: "item-a" },
      { alias: "fv20", itemId: "item-b" },
    ]);

    // Should have both aliases
    expect(queryString).toContain("fv10:");
    expect(queryString).toContain("fv20:");

    // Variables
    expect(variables.id_fv10).toBe("item-a");
    expect(variables.id_fv20).toBe("item-b");
  });

  it("queries for single select field values", () => {
    const { queryString } = buildBatchFieldValueQuery([
      { alias: "fv1", itemId: "item-x" },
    ]);
    expect(queryString).toContain("ProjectV2ItemFieldSingleSelectValue");
    expect(queryString).toContain("fieldValues");
  });

  it("includes field name in the query", () => {
    const { queryString } = buildBatchFieldValueQuery([
      { alias: "fv1", itemId: "item-x" },
    ]);
    expect(queryString).toContain("ProjectV2FieldCommon");
    expect(queryString).toContain("name");
  });
});

// ---------------------------------------------------------------------------
// Variable naming safety
// ---------------------------------------------------------------------------

describe("variable naming safety", () => {
  it("does not use reserved @octokit/graphql variable names", () => {
    // @octokit/graphql v9 reserves 'query', 'method', and 'url'
    const reserved = ["query", "method", "url"];

    const { variables: resolveVars } = buildBatchResolveQuery("o", "r", [1, 2, 3]);
    for (const key of Object.keys(resolveVars)) {
      expect(reserved).not.toContain(key);
    }

    const { variables: mutVars } = buildBatchMutationQuery("p", [
      { alias: "u0", itemId: "i", fieldId: "f", optionId: "o" },
    ]);
    for (const key of Object.keys(mutVars)) {
      expect(reserved).not.toContain(key);
    }

    const { variables: fvVars } = buildBatchFieldValueQuery([
      { alias: "fv0", itemId: "i" },
    ]);
    for (const key of Object.keys(fvVars)) {
      expect(reserved).not.toContain(key);
    }
  });
});

// ---------------------------------------------------------------------------
// Chunking / large batch tests
// ---------------------------------------------------------------------------

describe("batch mutation chunking", () => {
  it("generates correct number of aliases for large batches", () => {
    // 60 updates should be split into chunks of 50 at the tool level,
    // but the builder itself handles any size — verify it works
    const updates = Array.from({ length: 60 }, (_, i) => ({
      alias: `u${i}_0`,
      itemId: `item-${i}`,
      fieldId: "field-ws",
      optionId: "opt-rn",
    }));

    const { mutationString, variables } = buildBatchMutationQuery("proj", updates);

    // Should contain all 60 aliases
    for (let i = 0; i < 60; i++) {
      expect(mutationString).toContain(`u${i}_0:`);
    }

    // Should have projectId + 3 variables per update (item, field, opt)
    expect(Object.keys(variables).length).toBe(1 + 60 * 3);
  });

  it("generates correct aliases for issues x operations matrix", () => {
    // Simulate 3 issues x 2 operations = 6 aliases
    const updates = [
      { alias: "u10_0", itemId: "item-10", fieldId: "f-ws", optionId: "o-rn" },
      { alias: "u10_1", itemId: "item-10", fieldId: "f-est", optionId: "o-xs" },
      { alias: "u20_0", itemId: "item-20", fieldId: "f-ws", optionId: "o-rn" },
      { alias: "u20_1", itemId: "item-20", fieldId: "f-est", optionId: "o-xs" },
      { alias: "u30_0", itemId: "item-30", fieldId: "f-ws", optionId: "o-rn" },
      { alias: "u30_1", itemId: "item-30", fieldId: "f-est", optionId: "o-xs" },
    ];

    const { mutationString } = buildBatchMutationQuery("proj", updates);

    // All 6 aliases present
    expect(mutationString).toContain("u10_0:");
    expect(mutationString).toContain("u10_1:");
    expect(mutationString).toContain("u20_0:");
    expect(mutationString).toContain("u20_1:");
    expect(mutationString).toContain("u30_0:");
    expect(mutationString).toContain("u30_1:");
  });
});

// ---------------------------------------------------------------------------
// Resolve query edge cases
// ---------------------------------------------------------------------------

describe("buildBatchResolveQuery edge cases", () => {
  it("handles large issue arrays (50 issues)", () => {
    const issues = Array.from({ length: 50 }, (_, i) => i + 1);
    const { queryString, variables } = buildBatchResolveQuery("owner", "repo", issues);

    // Should have 50 aliases (i0 through i49)
    expect(queryString).toContain("i0:");
    expect(queryString).toContain("i49:");
    expect(queryString).not.toContain("i50:");

    // Should have owner, repo + 50 number variables
    expect(variables.n0).toBe(1);
    expect(variables.n49).toBe(50);
  });

  it("preserves exact issue numbers in variables", () => {
    const { variables } = buildBatchResolveQuery("o", "r", [999, 1, 42]);
    expect(variables.n0).toBe(999);
    expect(variables.n1).toBe(1);
    expect(variables.n2).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// Field value query edge cases
// ---------------------------------------------------------------------------

describe("buildBatchFieldValueQuery edge cases", () => {
  it("handles single item", () => {
    const { queryString, variables } = buildBatchFieldValueQuery([
      { alias: "fv1", itemId: "item-only" },
    ]);
    expect(queryString).toContain("fv1:");
    expect(variables.id_fv1).toBe("item-only");
  });

  it("handles many items", () => {
    const items = Array.from({ length: 20 }, (_, i) => ({
      alias: `fv${i}`,
      itemId: `item-${i}`,
    }));
    const { queryString, variables } = buildBatchFieldValueQuery(items);

    expect(queryString).toContain("fv0:");
    expect(queryString).toContain("fv19:");
    expect(variables.id_fv0).toBe("item-0");
    expect(variables.id_fv19).toBe("item-19");
  });
});

// ---------------------------------------------------------------------------
// Integration: ralph_hero__batch_update workflow_state transition legality
// (GH-1615) — mirrors the `getTool` handler-invocation pattern used in
// bulk-archive.test.ts's archive-mode integration suite.
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
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

const ALL_WORKFLOW_STATES = [
  "Backlog",
  "Research Needed",
  "Research in Progress",
  "Ready for Plan",
  "Plan in Progress",
  "Plan in Review",
  "In Progress",
  "In Review",
  "Done",
  "Canceled",
  "Human Needed",
];

function makeFieldCacheWithWorkflowState(): FieldOptionCache {
  const cache = new FieldOptionCache();
  cache.populate(7, "project-id-1", [
    {
      id: "field-ws-id",
      name: "Workflow State",
      options: ALL_WORKFLOW_STATES.map((name, i) => ({ id: `opt-${i}`, name })),
    },
  ]);
  return cache;
}

/**
 * Mock client for the batch_update field-op path. `currentStates` maps issue
 * number -> its current Workflow State (or undefined for "no value set").
 * The field cache is pre-populated (see makeFieldCacheWithWorkflowState), so
 * ensureFieldCache short-circuits and never issues a projectQuery.
 */
function makeBatchFieldOpMockClient(opts: {
  currentStates: Record<number, string | undefined>;
  fieldValueQueryShouldFail?: boolean;
  mutateShouldFail?: boolean;
  /** GH-1616: per-issue holder/heldSince for the lock-conflict enrichment. */
  currentHolders?: Record<number, { holder?: string; heldSince?: string }>;
}): { client: GitHubClient; projectMutate: ReturnType<typeof vi.fn> } {
  const cacheStore = new Map<string, unknown>();
  const issueNumbers = Object.keys(opts.currentStates).map(Number);

  const query = vi.fn(async (q: string) => {
    // buildBatchResolveQuery: aliases i0, i1, ... over repository(owner:...)
    if (q.includes("repository(owner:") && q.includes("projectItems(first:")) {
      const result: Record<string, unknown> = {};
      issueNumbers.forEach((num, i) => {
        result[`i${i}`] = {
          issue: {
            id: `issue-node-${num}`,
            projectItems: { nodes: [{ id: `item-${num}`, project: { id: "project-id-1" } }] },
          },
        };
      });
      return result;
    }
    // buildBatchFieldValueQuery: aliases are `fv${issueNumber}` (the batch_update
    // handler keys itemsToCheck by issue number, not loop index — see
    // batch-tools.ts's `alias: \`fv${num}\`` in the Step 2 field-value fetch).
    if (q.includes("node(id: $id_fv")) {
      if (opts.fieldValueQueryShouldFail) {
        throw new Error("simulated field-value query failure");
      }
      const result: Record<string, unknown> = {};
      issueNumbers.forEach((num) => {
        const state = opts.currentStates[num];
        const holderInfo = opts.currentHolders?.[num];
        result[`fv${num}`] = {
          fieldValues: {
            nodes: state
              ? [{
                  __typename: "ProjectV2ItemFieldSingleSelectValue",
                  name: state,
                  updatedAt: holderInfo?.heldSince,
                  creator: holderInfo?.holder ? { login: holderInfo.holder } : undefined,
                  field: { name: "Workflow State" },
                }]
              : [],
          },
        };
      });
      return result;
    }
    throw new Error(`Unmocked query: ${q.slice(0, 100)}`);
  });

  const projectMutate = opts.mutateShouldFail
    ? vi.fn().mockRejectedValue(new Error("mutation failed"))
    : vi.fn().mockResolvedValue({});

  const client = {
    config: {
      token: "test",
      owner: "octocat",
      repo: "repo",
      projectNumber: 7,
      projectOwner: "octocat",
    },
    query,
    projectQuery: vi.fn(async () => {
      throw new Error("projectQuery should not be called — field cache is pre-populated");
    }),
    mutate: vi.fn(),
    projectMutate,
    getCache: vi.fn(() => ({
      get: (key: string) => cacheStore.get(key),
      set: (key: string, value: unknown) => cacheStore.set(key, value),
      invalidatePrefix: vi.fn(),
    })),
    getAuthenticatedUser: vi.fn(),
    getRateLimitStatus: vi.fn(),
    restPost: vi.fn(),
  } as unknown as GitHubClient;

  return { client, projectMutate };
}

describe("ralph_hero__batch_update workflow_state transition legality (GH-1615)", () => {
  let server: McpServer;
  let fieldCache: FieldOptionCache;

  beforeEach(() => {
    server = new McpServer({ name: "test", version: "0.0.0" });
    fieldCache = makeFieldCacheWithWorkflowState();
  });

  // The guard below picks the workflow_state op via `.find(...)` (first match)
  // but step 3 builds aliased writes for EVERY op, so a second workflow_state
  // entry would be applied without ever being checked for transition legality
  // or lock conflict — a direct bypass of this block. Refused up front.
  it("refuses duplicate field operations (second write would bypass the guards)", async () => {
    const { client, projectMutate } = makeBatchFieldOpMockClient({
      currentStates: { 10: "Backlog" },
    });
    registerBatchTools(server, client, fieldCache);
    const tool = getTool(server, "ralph_hero__batch_update");

    const result = await tool.handler(
      {
        issues: [10],
        operations: [
          { field: "workflow_state", value: "Research Needed" },
          { field: "workflow_state", value: "In Progress" },
        ],
      },
      {},
    );

    expect(result.isError).toBe(true);
    const payload = parsePayload(result) as { error: string };
    expect(payload.error).toContain("Duplicate field operation");
    expect(payload.error).toContain("workflow_state");
    expect(projectMutate).not.toHaveBeenCalled();
  });

  it("whole-batch refusal on an unknown workflow_state value (before any API calls)", async () => {
    const { client } = makeBatchFieldOpMockClient({ currentStates: { 10: "Backlog" } });
    registerBatchTools(server, client, fieldCache);
    const tool = getTool(server, "ralph_hero__batch_update");

    const result = await tool.handler(
      {
        issues: [10],
        operations: [{ field: "workflow_state", value: "Not A Real State" }],
      },
      {},
    );

    expect(result.isError).toBe(true);
    const payload = parsePayload(result) as { error: string };
    expect(payload.error).toContain("Invalid workflow_state value");
    expect(client.query).not.toHaveBeenCalled();
  });

  it("per-issue error for an illegal transition; the rest of the batch still mutates", async () => {
    const { client, projectMutate } = makeBatchFieldOpMockClient({
      currentStates: { 10: "Backlog", 11: "Ready for Plan" },
    });
    registerBatchTools(server, client, fieldCache);
    const tool = getTool(server, "ralph_hero__batch_update");

    const result = await tool.handler(
      {
        issues: [10, 11],
        operations: [{ field: "workflow_state", value: "In Progress" }],
      },
      {},
    );

    const payload = parsePayload(result) as {
      succeeded: Array<{ number: number }>;
      errors: Array<{ number: number; error: string }>;
      summary: { succeeded: number; errors: number };
    };

    // #10 Backlog -> In Progress is illegal (not in ALLOWED_TRANSITIONS)
    expect(payload.errors.map((e) => e.number)).toEqual([10]);
    expect(payload.errors[0].error).toContain("Illegal transition for #10");
    expect(payload.errors[0].error).toContain("force: true");

    // #11 Ready for Plan -> In Progress IS legal (added edge c) and mutates
    expect(payload.succeeded.map((s) => s.number)).toEqual([11]);
    expect(projectMutate).toHaveBeenCalledTimes(1);
  });

  it("current-state fetch failure is a whole-batch toolError with zero mutations (fail closed)", async () => {
    const { client, projectMutate } = makeBatchFieldOpMockClient({
      currentStates: { 10: "Backlog", 11: "Ready for Plan" },
      fieldValueQueryShouldFail: true,
    });
    registerBatchTools(server, client, fieldCache);
    const tool = getTool(server, "ralph_hero__batch_update");

    const result = await tool.handler(
      {
        issues: [10, 11],
        operations: [{ field: "workflow_state", value: "In Progress" }],
      },
      {},
    );

    expect(result.isError).toBe(true);
    const payload = parsePayload(result) as { error: string };
    expect(payload.error).toContain("Could not determine current workflow state");
    expect(projectMutate).not.toHaveBeenCalled();
  });

  it("a genuinely-unset current state (no Workflow State value) PASSES validation", async () => {
    const { client, projectMutate } = makeBatchFieldOpMockClient({
      currentStates: { 10: undefined },
    });
    registerBatchTools(server, client, fieldCache);
    const tool = getTool(server, "ralph_hero__batch_update");

    const result = await tool.handler(
      {
        issues: [10],
        operations: [{ field: "workflow_state", value: "Ready for Plan" }],
      },
      {},
    );

    const payload = parsePayload(result) as {
      succeeded: Array<{ number: number }>;
      errors: Array<unknown>;
    };
    expect(payload.errors).toEqual([]);
    expect(payload.succeeded.map((s) => s.number)).toEqual([10]);
    expect(projectMutate).toHaveBeenCalledTimes(1);
  });

  it("skipIfAtOrPast still skips same-state issues after the (legal) transition check", async () => {
    const { client, projectMutate } = makeBatchFieldOpMockClient({
      currentStates: { 10: "In Review" },
    });
    registerBatchTools(server, client, fieldCache);
    const tool = getTool(server, "ralph_hero__batch_update");

    const result = await tool.handler(
      {
        issues: [10],
        operations: [{ field: "workflow_state", value: "In Review" }],
        skipIfAtOrPast: true,
      },
      {},
    );

    const payload = parsePayload(result) as {
      skipped: Array<{ number: number; reason: string }>;
      errors: Array<unknown>;
    };
    expect(payload.errors).toEqual([]);
    expect(payload.skipped).toEqual([
      { number: 10, reason: "Already at target state" },
    ]);
    expect(projectMutate).not.toHaveBeenCalled();
  });

  // NOTE: the absence of a `force` escape hatch is asserted behaviorally in the
  // lock-conflict suite below ("force: true does not bypass..."). A
  // `not.toContain('force: zBoolish()')` source check is trivially defeated by
  // any reformatting or an equivalent schema spelling.
});

// ---------------------------------------------------------------------------
// GH-1616: batch_update lock-conflict side door — closed.
// ---------------------------------------------------------------------------

describe("ralph_hero__batch_update lock-conflict guard (GH-1616)", () => {
  let server: McpServer;
  let fieldCache: FieldOptionCache;

  beforeEach(() => {
    server = new McpServer({ name: "test", version: "0.0.0" });
    fieldCache = makeFieldCacheWithWorkflowState();
  });

  it("a lock-to-lock conflict lands in errors[] instead of silently mutating; the rest of the batch proceeds", async () => {
    const { client, projectMutate } = makeBatchFieldOpMockClient({
      currentStates: { 10: "Plan in Progress", 11: "Ready for Plan" },
      currentHolders: { 10: { holder: "other-agent", heldSince: "2026-07-25T00:00:00Z" } },
    });
    registerBatchTools(server, client, fieldCache);
    const tool = getTool(server, "ralph_hero__batch_update");

    const result = await tool.handler(
      {
        issues: [10, 11],
        operations: [{ field: "workflow_state", value: "In Progress" }],
      },
      {},
    );

    const payload = parsePayload(result) as {
      succeeded: Array<{ number: number }>;
      errors: Array<{ number: number; error: string }>;
    };

    // #10: Plan in Progress -> In Progress IS a legal JSON transition, but
    // it's a lock-to-lock conflict — dropped into errors[], not mutated.
    expect(payload.errors.map((e) => e.number)).toEqual([10]);
    expect(payload.errors[0].error).toContain("is locked:");
    expect(payload.errors[0].error).toContain("@other-agent");
    expect(payload.errors[0].error).toContain("2026-07-25T00:00:00Z");

    // #11: Ready for Plan -> In Progress is legal AND lock-conflict-free
    // (Ready for Plan is not a lock state) — still mutates.
    expect(payload.succeeded.map((s) => s.number)).toEqual([11]);
    expect(projectMutate).toHaveBeenCalledTimes(1);
  });

  // batch_update deliberately has no `force` escape hatch — repair goes through
  // save_issue(force: true) one issue at a time, so an override is always a
  // deliberate single-issue act with a recorded marker, never a bulk sweep.
  it("force: true does not bypass the lock-conflict guard (no bulk override path)", async () => {
    const { client, projectMutate } = makeBatchFieldOpMockClient({
      currentStates: { 10: "Plan in Progress" },
      currentHolders: { 10: { holder: "other-agent", heldSince: "2026-07-25T00:00:00Z" } },
    });
    registerBatchTools(server, client, fieldCache);
    const tool = getTool(server, "ralph_hero__batch_update");

    const result = await tool.handler(
      {
        issues: [10],
        operations: [{ field: "workflow_state", value: "In Progress" }],
        force: true,
      },
      {},
    );

    const payload = parsePayload(result) as {
      succeeded: Array<{ number: number }>;
      errors: Array<{ number: number; error: string }>;
    };

    expect(payload.errors.map((e) => e.number)).toEqual([10]);
    expect(payload.errors[0].error).toContain("is locked:");
    expect(payload.succeeded).toEqual([]);
    expect(projectMutate).not.toHaveBeenCalled();
  });

  it("does not apply the lock-conflict guard when the target is not a lock state", async () => {
    const { client, projectMutate } = makeBatchFieldOpMockClient({
      currentStates: { 10: "Research in Progress" },
    });
    registerBatchTools(server, client, fieldCache);
    const tool = getTool(server, "ralph_hero__batch_update");

    const result = await tool.handler(
      {
        issues: [10],
        operations: [{ field: "workflow_state", value: "Human Needed" }],
      },
      {},
    );

    const payload = parsePayload(result) as { errors: Array<unknown> };
    expect(payload.errors).toEqual([]);
    expect(projectMutate).toHaveBeenCalledTimes(1);
  });

  it("same-state re-assert on a lock state is NOT a conflict", async () => {
    const { client, projectMutate } = makeBatchFieldOpMockClient({
      currentStates: { 10: "In Progress" },
    });
    registerBatchTools(server, client, fieldCache);
    const tool = getTool(server, "ralph_hero__batch_update");

    const result = await tool.handler(
      {
        issues: [10],
        operations: [{ field: "workflow_state", value: "In Progress" }],
      },
      {},
    );

    const payload = parsePayload(result) as { errors: Array<unknown> };
    expect(payload.errors).toEqual([]);
    expect(projectMutate).toHaveBeenCalledTimes(1);
  });
});
