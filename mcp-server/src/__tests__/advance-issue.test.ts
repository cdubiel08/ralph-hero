/**
 * Tests for advance_issue tool (unified from advance_children + advance_parent):
 * - Validates the schema for direction='children' with targetState + issues/number
 * - Validates the schema for direction='parent' with number only
 * - Verifies input validation logic
 * - (GH-1615) handler-level integration tests for the transition-legality
 *   checks in both directions.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isEarlierState, isValidState, VALID_STATES } from "../lib/workflow-states.js";
import { registerRelationshipTools } from "../tools/relationship-tools.js";
import type { GitHubClient } from "../github-client.js";
import { FieldOptionCache } from "../lib/cache.js";

// ---------------------------------------------------------------------------
// Schema validation tests
// ---------------------------------------------------------------------------

// Replicate the advance_issue tool schema for testing
const advanceIssueSchema = z.object({
  owner: z.string().optional(),
  repo: z.string().optional(),
  projectNumber: z.coerce.number().optional(),
  direction: z.enum(["children", "parent"]),
  number: z.coerce.number(),
  targetState: z.string().optional(),
  issues: z.array(z.coerce.number()).optional(),
});

describe("advance_issue schema (direction='children')", () => {
  it("accepts direction='children' with number and targetState", () => {
    const result = advanceIssueSchema.safeParse({
      direction: "children",
      number: 5,
      targetState: "Research Needed",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.direction).toBe("children");
      expect(result.data.number).toBe(5);
      expect(result.data.targetState).toBe("Research Needed");
    }
  });

  it("accepts direction='children' with issues array", () => {
    const result = advanceIssueSchema.safeParse({
      direction: "children",
      number: 5,
      issues: [10, 11, 12],
      targetState: "Research Needed",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.issues).toEqual([10, 11, 12]);
    }
  });

  it("coerces string issue numbers to numbers", () => {
    const result = advanceIssueSchema.safeParse({
      direction: "children",
      number: 5,
      issues: ["10", "20", "30"],
      targetState: "Research Needed",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.issues).toEqual([10, 20, 30]);
    }
  });

  it("accepts empty issues array at schema level", () => {
    const result = advanceIssueSchema.safeParse({
      direction: "children",
      number: 5,
      issues: [],
      targetState: "Research Needed",
    });
    expect(result.success).toBe(true);
  });
});

describe("advance_issue schema (direction='parent')", () => {
  it("accepts direction='parent' with number only", () => {
    const result = advanceIssueSchema.safeParse({
      direction: "parent",
      number: 42,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.direction).toBe("parent");
      expect(result.data.number).toBe(42);
      expect(result.data.targetState).toBeUndefined();
    }
  });

  it("direction='parent' does not require targetState", () => {
    const result = advanceIssueSchema.safeParse({
      direction: "parent",
      number: 42,
    });
    expect(result.success).toBe(true);
  });
});

describe("advance_issue schema validation", () => {
  it("rejects invalid direction", () => {
    const result = advanceIssueSchema.safeParse({
      direction: "invalid",
      number: 5,
      targetState: "Research Needed",
    });
    expect(result.success).toBe(false);
  });

  it("requires number parameter", () => {
    const result = advanceIssueSchema.safeParse({
      direction: "children",
      targetState: "Research Needed",
    });
    expect(result.success).toBe(false);
  });

  it("accepts projectNumber override", () => {
    const result = advanceIssueSchema.safeParse({
      direction: "children",
      number: 5,
      targetState: "Research Needed",
      projectNumber: 7,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.projectNumber).toBe(7);
    }
  });
});

// ---------------------------------------------------------------------------
// State advancement logic tests
// ---------------------------------------------------------------------------

describe("advance_issue state logic", () => {
  it("identifies issues in earlier states for advancement", () => {
    expect(isEarlierState("Backlog", "Research Needed")).toBe(true);
  });

  it("skips issues already at target state", () => {
    expect(isEarlierState("Research Needed", "Research Needed")).toBe(false);
  });

  it("skips issues past target state", () => {
    expect(isEarlierState("In Progress", "Research Needed")).toBe(false);
  });

  it("validates target state against known states", () => {
    expect(isValidState("Research Needed")).toBe(true);
    expect(isValidState("Ready for Plan")).toBe(true);
    expect(isValidState("In Progress")).toBe(true);
    expect(isValidState("Done")).toBe(true);
  });

  it("rejects unknown target states", () => {
    expect(isValidState("NotARealState")).toBe(false);
    expect(isValidState("")).toBe(false);
  });

  it("handles terminal states correctly", () => {
    expect(isValidState("Done")).toBe(true);
    expect(isValidState("Canceled")).toBe(true);
  });

  it("handles all workflow states in order", () => {
    expect(isEarlierState("Backlog", "Done")).toBe(true);
    expect(isEarlierState("Done", "Backlog")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Input validation logic tests (mirrors tool handler)
// ---------------------------------------------------------------------------

describe("advance_issue input validation (direction='children')", () => {
  function validateChildrenInputs(args: {
    number?: number;
    issues?: number[];
    targetState?: string;
  }): { valid: boolean; error?: string } {
    // Mirror the tool's runtime validation for direction='children'
    if (!args.targetState) {
      return {
        valid: false,
        error: "targetState is required when direction='children'.",
      };
    }
    if (args.number === undefined && (!args.issues || args.issues.length === 0)) {
      return {
        valid: false,
        error: "Either 'number' (parent issue) or 'issues' (explicit list) is required.",
      };
    }
    if (!isValidState(args.targetState)) {
      return {
        valid: false,
        error: `Unknown target state '${args.targetState}'.`,
      };
    }
    return { valid: true };
  }

  it("rejects when targetState is missing", () => {
    const result = validateChildrenInputs({ number: 5 });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("targetState is required");
  });

  it("rejects when neither number nor issues provided", () => {
    const result = validateChildrenInputs({ targetState: "Research Needed" });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Either");
  });

  it("rejects empty issues array with no number", () => {
    const result = validateChildrenInputs({ issues: [], targetState: "Research Needed" });
    expect(result.valid).toBe(false);
  });

  it("accepts number only", () => {
    const result = validateChildrenInputs({ number: 5, targetState: "Research Needed" });
    expect(result.valid).toBe(true);
  });

  it("accepts issues only", () => {
    const result = validateChildrenInputs({
      issues: [10, 11],
      targetState: "Research Needed",
    });
    expect(result.valid).toBe(true);
  });

  it("accepts both (issues takes precedence in handler)", () => {
    const result = validateChildrenInputs({
      number: 5,
      issues: [10, 11],
      targetState: "Ready for Plan",
    });
    expect(result.valid).toBe(true);
  });

  it("rejects invalid target state", () => {
    const result = validateChildrenInputs({
      number: 5,
      targetState: "InvalidState",
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Unknown target state");
  });

  it("validates all known states are accepted", () => {
    for (const state of VALID_STATES) {
      const result = validateChildrenInputs({ number: 1, targetState: state });
      expect(result.valid).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Structural: advance_issue tool is registered
// ---------------------------------------------------------------------------

describe("advance_issue structural", () => {
  it("tool is registered as ralph_hero__advance_issue", () => {
    // Read source to verify registration
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "../tools/relationship-tools.ts"),
      "utf-8",
    );
    expect(src).toContain('"ralph_hero__advance_issue"');
  });

  it("has direction enum parameter", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "../tools/relationship-tools.ts"),
      "utf-8",
    );
    expect(src).toContain('z.enum(["children", "parent"])');
  });

  it("does not register old advance_children or advance_parent", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "../tools/relationship-tools.ts"),
      "utf-8",
    );
    expect(src).not.toContain('"ralph_hero__advance_children"');
    expect(src).not.toContain('"ralph_hero__advance_parent"');
  });

  it("registers list_dependencies (GH-539)", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "../tools/relationship-tools.ts"),
      "utf-8",
    );
    expect(src).toContain('"ralph_hero__list_dependencies"');
  });
});

// ---------------------------------------------------------------------------
// GH-1615: transition-legality — handler-level integration tests for both
// advance_issue directions.
// ---------------------------------------------------------------------------

interface HandlerResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

interface RegisteredTool {
  handler: (args: unknown, extra: unknown) => Promise<HandlerResult>;
}

function getAdvanceIssueHandler(server: McpServer): RegisteredTool {
  const tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
  const tool = tools?.["ralph_hero__advance_issue"];
  if (!tool) throw new Error("ralph_hero__advance_issue not registered");
  return tool;
}

function parseAdvancePayload(result: HandlerResult): Record<string, unknown> {
  expect(result.content).toHaveLength(1);
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

function makeAdvanceIssueFieldCache(): FieldOptionCache {
  const cache = new FieldOptionCache();
  cache.populate(7, "project-id-1", [
    {
      id: "field-ws-id",
      name: "Workflow State",
      options: [
        "Backlog", "Research Needed", "Research in Progress", "Ready for Plan",
        "Plan in Progress", "Plan in Review", "In Progress", "In Review",
        "Done", "Canceled", "Human Needed",
      ].map((name, i) => ({ id: `opt-ws-${i}`, name })),
    },
    {
      id: "field-status-id",
      name: "Status",
      options: [
        { id: "opt-todo", name: "Todo" },
        { id: "opt-ip", name: "In Progress" },
        { id: "opt-done", name: "Done" },
      ],
    },
  ]);
  return cache;
}

/**
 * Shared mock GitHubClient for advance_issue integration tests. Handles both
 * the direction='children' subIssues lookup and the direction='parent'
 * child->parent + siblings lookups, plus the per-issue current-state read
 * (resolveProjectItemId -> resolveIssueNodeId, then getCurrentFieldValue)
 * every code path in relationship-tools.ts goes through.
 */
function makeAdvanceIssueMockClient(opts: {
  currentStates: Record<number, string | undefined>;
  childrenByParent?: Record<number, number[]>;
  parentOf?: Record<number, number>;
  /** GH-1616: per-issue holder/heldSince for the lock-conflict enrichment. */
  currentHolders?: Record<number, { holder?: string; heldSince?: string }>;
}): { client: GitHubClient; projectMutate: ReturnType<typeof vi.fn> } {
  const cacheStore = new Map<string, { value: unknown; expiry: number }>();

  const query = vi.fn(async (q: string, vars: Record<string, unknown> = {}) => {
    // resolveIssueNodeId: bare `issue(number: ...) { id }` lookup (also used
    // internally by resolveProjectItemId).
    if (q.includes("repository(owner:") && q.includes("issue(number:") && q.includes("{ id }")) {
      const num = vars.number as number;
      return { repository: { issue: { id: `issue-node-${num}` } } };
    }
    // resolveProjectItemId's own query: `... on Issue { projectItems(first: ...) }`
    if (q.includes("... on Issue {") && q.includes("projectItems(first:")) {
      const issueId = vars.issueId as string;
      const match = /issue-node-(\d+)/.exec(issueId);
      const num = match ? Number(match[1]) : 0;
      return {
        node: {
          projectItems: { nodes: [{ id: `item-${num}`, project: { id: "project-id-1" } }] },
        },
      };
    }
    // getFieldValueDetail (GH-1616, replaces bare getCurrentFieldValue):
    // `... on ProjectV2Item { fieldValues(first: 20) }`
    if (q.includes("... on ProjectV2Item {") && q.includes("fieldValues(first: 20)")) {
      const itemId = vars.itemId as string;
      const match = /item-(\d+)/.exec(itemId);
      const num = match ? Number(match[1]) : 0;
      const state = opts.currentStates[num];
      const holderInfo = opts.currentHolders?.[num];
      const nodes = state
        ? [{
            __typename: "ProjectV2ItemFieldSingleSelectValue",
            name: state,
            updatedAt: holderInfo?.heldSince,
            creator: holderInfo?.holder ? { login: holderInfo.holder } : undefined,
            field: { name: "Workflow State" },
          }]
        : [];
      return { node: { fieldValues: { nodes } } };
    }
    // direction='children': parent's subIssues (`$number: Int!`)
    if (q.includes("subIssues(first: 50)") && q.includes("$number: Int!")) {
      const num = vars.number as number;
      const childNums = opts.childrenByParent?.[num] ?? [];
      return {
        repository: {
          issue: {
            number: num,
            title: `Issue ${num}`,
            subIssues: {
              nodes: childNums.map((n) => ({ id: `issue-node-${n}`, number: n, title: `Issue ${n}`, state: "OPEN" })),
            },
          },
        },
      };
    }
    // direction='parent': child -> parent lookup
    if (q.includes("parent { number title state }")) {
      const num = vars.issueNumber as number;
      const parentNum = opts.parentOf?.[num];
      return {
        repository: {
          issue: {
            number: num,
            title: `Issue ${num}`,
            parent: parentNum !== undefined ? { number: parentNum, title: `Issue ${parentNum}`, state: "OPEN" } : null,
          },
        },
      };
    }
    // direction='parent': siblings of the parent (`$parentNum: Int!`)
    if (q.includes("subIssues(first: 50)") && q.includes("$parentNum: Int!")) {
      const num = vars.parentNum as number;
      const childNums = opts.childrenByParent?.[num] ?? [];
      return {
        repository: {
          issue: {
            number: num,
            title: `Issue ${num}`,
            subIssues: {
              nodes: childNums.map((n) => ({ id: `issue-node-${n}`, number: n, title: `Issue ${n}`, state: "OPEN" })),
            },
          },
        },
      };
    }
    throw new Error(`Unmocked query: ${q.slice(0, 150)}`);
  });

  const projectMutate = vi.fn(async () => ({}));

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
    getCache: () => ({
      get: <T>(key: string): T | undefined => {
        const entry = cacheStore.get(key);
        if (!entry || Date.now() > entry.expiry) return undefined;
        return entry.value as T;
      },
      set: (key: string, value: unknown, ttlMs?: number) => {
        cacheStore.set(key, { value, expiry: Date.now() + (ttlMs ?? 30 * 60 * 1000) });
      },
      invalidatePrefix: () => {},
    }),
    getAuthenticatedUser: vi.fn(),
    getRateLimitStatus: vi.fn(),
    restPost: vi.fn(),
  } as unknown as GitHubClient;

  return { client, projectMutate };
}

describe("advance_issue direction='children' transition legality (GH-1615)", () => {
  let server: McpServer;
  let fieldCache: FieldOptionCache;

  beforeEach(() => {
    server = new McpServer({ name: "test", version: "0.0.0" });
    fieldCache = makeAdvanceIssueFieldCache();
  });

  it("illegal transition lands in errors[]; the rest of the batch still advances", async () => {
    const { client, projectMutate } = makeAdvanceIssueMockClient({
      currentStates: { 20: "Research Needed", 21: "Ready for Plan" },
      childrenByParent: { 100: [20, 21] },
    });
    registerRelationshipTools(server, client, fieldCache);
    const handler = getAdvanceIssueHandler(server);

    const result = await handler.handler(
      { direction: "children", number: 100, targetState: "In Progress" },
      {},
    );

    const payload = parseAdvancePayload(result) as {
      advanced: Array<{ number: number }>;
      errors: Array<{ number: number; error: string }>;
    };

    // #20 Research Needed -> In Progress skips every gate: illegal.
    expect(payload.errors.map((e) => e.number)).toEqual([20]);
    expect(payload.errors[0].error).toContain("Illegal transition for #20");

    // #21 Ready for Plan -> In Progress IS legal (added edge c).
    expect(payload.advanced.map((a) => a.number)).toEqual([21]);
    expect(projectMutate).toHaveBeenCalled();
  });

  it("does not error on a legal forward move", async () => {
    const { client } = makeAdvanceIssueMockClient({
      currentStates: { 30: "Plan in Review" },
      childrenByParent: { 100: [30] },
    });
    registerRelationshipTools(server, client, fieldCache);
    const handler = getAdvanceIssueHandler(server);

    const result = await handler.handler(
      { direction: "children", number: 100, targetState: "In Progress" },
      {},
    );

    const payload = parseAdvancePayload(result) as {
      advanced: Array<{ number: number }>;
      errors: Array<unknown>;
    };
    expect(payload.errors).toEqual([]);
    expect(payload.advanced.map((a) => a.number)).toEqual([30]);
  });
});

describe("advance_issue direction='children' lock-conflict guard (GH-1616)", () => {
  let server: McpServer;
  let fieldCache: FieldOptionCache;

  beforeEach(() => {
    server = new McpServer({ name: "test", version: "0.0.0" });
    fieldCache = makeAdvanceIssueFieldCache();
  });

  it("a lock-to-lock conflict lands in errors[] with holder + heldSince; the rest of the batch advances", async () => {
    const { client, projectMutate } = makeAdvanceIssueMockClient({
      currentStates: { 20: "Plan in Progress", 21: "Ready for Plan" },
      currentHolders: { 20: { holder: "other-agent", heldSince: "2026-07-25T00:00:00Z" } },
      childrenByParent: { 100: [20, 21] },
    });
    registerRelationshipTools(server, client, fieldCache);
    const handler = getAdvanceIssueHandler(server);

    const result = await handler.handler(
      { direction: "children", number: 100, targetState: "In Progress" },
      {},
    );

    const payload = parseAdvancePayload(result) as {
      advanced: Array<{ number: number }>;
      errors: Array<{ number: number; error: string }>;
    };

    // #20: Plan in Progress -> In Progress IS a legal JSON transition, but
    // it's a lock-to-lock conflict — errors[], not silently advanced.
    expect(payload.errors.map((e) => e.number)).toEqual([20]);
    expect(payload.errors[0].error).toContain("is locked:");
    expect(payload.errors[0].error).toContain("@other-agent");
    expect(payload.errors[0].error).toContain("2026-07-25T00:00:00Z");

    // #21: Ready for Plan -> In Progress is legal and lock-conflict-free.
    expect(payload.advanced.map((a) => a.number)).toEqual([21]);
    expect(projectMutate).toHaveBeenCalled();
  });

  it("does not apply the lock-conflict guard when targetState is not a lock state", async () => {
    const { client } = makeAdvanceIssueMockClient({
      currentStates: { 20: "Research in Progress" },
      childrenByParent: { 100: [20] },
    });
    registerRelationshipTools(server, client, fieldCache);
    const handler = getAdvanceIssueHandler(server);

    const result = await handler.handler(
      { direction: "children", number: 100, targetState: "Ready for Plan" },
      {},
    );

    const payload = parseAdvancePayload(result) as { errors: Array<unknown> };
    expect(payload.errors).toEqual([]);
  });
});

describe("advance_issue direction='parent' gate legality (GH-1615)", () => {
  let server: McpServer;
  let fieldCache: FieldOptionCache;

  beforeEach(() => {
    server = new McpServer({ name: "test", version: "0.0.0" });
    fieldCache = makeAdvanceIssueFieldCache();
  });

  it("refuses to advance a parent parked at Human Needed (would overwrite an escalation)", async () => {
    const { client, projectMutate } = makeAdvanceIssueMockClient({
      currentStates: { 41: "In Review", 10: "Human Needed" },
      parentOf: { 41: 10 },
      childrenByParent: { 10: [41] },
    });
    registerRelationshipTools(server, client, fieldCache);
    const handler = getAdvanceIssueHandler(server);

    const result = await handler.handler(
      { direction: "parent", number: 41 },
      {},
    );

    const payload = parseAdvancePayload(result) as { advanced: boolean; reason: string };
    expect(payload.advanced).toBe(false);
    expect(payload.reason).toBe("parent is escalated");
    expect(projectMutate).not.toHaveBeenCalled();
  });

  it("advances a Backlog parent to Ready for Plan when all children reach that gate (multi-hop jump)", async () => {
    const { client, projectMutate } = makeAdvanceIssueMockClient({
      currentStates: { 41: "Ready for Plan", 10: "Backlog" },
      parentOf: { 41: 10 },
      childrenByParent: { 10: [41] },
    });
    registerRelationshipTools(server, client, fieldCache);
    const handler = getAdvanceIssueHandler(server);

    const result = await handler.handler(
      { direction: "parent", number: 41 },
      {},
    );

    const payload = parseAdvancePayload(result) as { advanced: boolean; parent: { toState: string } };
    expect(payload.advanced).toBe(true);
    expect(payload.parent.toState).toBe("Ready for Plan");
    expect(projectMutate).toHaveBeenCalled();
  });

  it("refuses to advance a parent holding a live lock (does not overwrite an in-flight claim)", async () => {
    const { client, projectMutate } = makeAdvanceIssueMockClient({
      currentStates: { 41: "In Review", 10: "Plan in Progress" },
      parentOf: { 41: 10 },
      childrenByParent: { 10: [41] },
    });
    registerRelationshipTools(server, client, fieldCache);
    const handler = getAdvanceIssueHandler(server);

    const result = await handler.handler(
      { direction: "parent", number: 41 },
      {},
    );

    const payload = parseAdvancePayload(result) as { advanced: boolean; reason: string };
    expect(payload.advanced).toBe(false);
    expect(payload.reason).toBe("parent is locked by an active claim");
    expect(projectMutate).not.toHaveBeenCalled();
  });
});
