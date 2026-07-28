/**
 * Tests for autoAdvanceParent() helper and extractWorkflowState().
 *
 * Uses mock GitHubClient and FieldOptionCache to test the helper directly
 * without network calls.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { extractWorkflowState, autoAdvanceParent } from "../lib/helpers.js";
import type { GitHubClient } from "../github-client.js";
import { FieldOptionCache } from "../lib/cache.js";

// ---------------------------------------------------------------------------
// extractWorkflowState tests
// ---------------------------------------------------------------------------

describe("extractWorkflowState", () => {
  it("extracts Workflow State from field value nodes", () => {
    const item = {
      fieldValues: {
        nodes: [
          {
            __typename: "ProjectV2ItemFieldSingleSelectValue",
            name: "Plan in Review",
            field: { name: "Workflow State" },
          },
          {
            __typename: "ProjectV2ItemFieldSingleSelectValue",
            name: "Todo",
            field: { name: "Status" },
          },
        ],
      },
    };
    expect(extractWorkflowState(item)).toBe("Plan in Review");
  });

  it("returns null when no Workflow State field found", () => {
    const item = {
      fieldValues: {
        nodes: [
          {
            __typename: "ProjectV2ItemFieldSingleSelectValue",
            name: "Todo",
            field: { name: "Status" },
          },
        ],
      },
    };
    expect(extractWorkflowState(item)).toBeNull();
  });

  it("returns null for undefined item", () => {
    expect(extractWorkflowState(undefined)).toBeNull();
  });

  it("returns null for item with no fieldValues", () => {
    expect(extractWorkflowState({})).toBeNull();
  });

  it("ignores non-SingleSelect field values", () => {
    const item = {
      fieldValues: {
        nodes: [
          {
            __typename: "ProjectV2ItemFieldTextValue",
            name: "Ready for Plan",
            field: { name: "Workflow State" },
          },
        ],
      },
    };
    expect(extractWorkflowState(item)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// autoAdvanceParent tests
// ---------------------------------------------------------------------------

function createMockClient(responses: Array<unknown>): GitHubClient {
  let callIdx = 0;
  const cache = new Map<string, { value: unknown; expiry: number }>();

  return {
    query: vi.fn(async () => {
      if (callIdx >= responses.length) throw new Error("No more mock responses");
      return responses[callIdx++];
    }),
    projectQuery: vi.fn(async () => {
      if (callIdx >= responses.length) throw new Error("No more mock responses");
      return responses[callIdx++];
    }),
    mutate: vi.fn(async () => {
      if (callIdx >= responses.length) throw new Error("No more mock responses");
      return responses[callIdx++];
    }),
    projectMutate: vi.fn(async () => {
      if (callIdx >= responses.length) throw new Error("No more mock responses");
      return responses[callIdx++];
    }),
    getCache: () => ({
      get: <T>(key: string): T | undefined => {
        const entry = cache.get(key);
        if (!entry || Date.now() > entry.expiry) return undefined;
        return entry.value as T;
      },
      set: (key: string, value: unknown, ttlMs: number) => {
        cache.set(key, { value, expiry: Date.now() + ttlMs });
      },
    }),
  } as unknown as GitHubClient;
}

function createMockFieldCache(): FieldOptionCache {
  const cache = new FieldOptionCache();
  cache.populate(3, "project-id-123", [
    {
      id: "field-ws-id",
      name: "Workflow State",
      options: [
        { id: "opt-rfp", name: "Ready for Plan" },
        { id: "opt-pir", name: "Plan in Review" },
        { id: "opt-ir", name: "In Review" },
        { id: "opt-done", name: "Done" },
      ],
    },
    {
      id: "field-status-id",
      name: "Status",
      options: [
        { id: "opt-todo", name: "Todo" },
        { id: "opt-ip", name: "In Progress" },
        { id: "opt-d", name: "Done" },
      ],
    },
  ]);
  return cache;
}

describe("autoAdvanceParent", () => {
  let fieldCache: FieldOptionCache;

  beforeEach(() => {
    fieldCache = createMockFieldCache();
  });

  it("returns null when issue has no parent", async () => {
    const client = createMockClient([
      // Step A: parent query
      { repository: { issue: { parent: null } } },
    ]);

    const result = await autoAdvanceParent(
      client, fieldCache, "owner", "repo", 42, "Plan in Review", 3,
    );
    expect(result).toBeNull();
  });

  it("returns advanced: false when siblings not all at gate", async () => {
    const client = createMockClient([
      // Step A: parent query
      { repository: { issue: { parent: { number: 10 } } } },
      // Step B: siblings query
      { repository: { issue: { subIssues: { nodes: [{ number: 42 }, { number: 43 }] } } } },
      // Step C: batch resolve
      {
        i0: { issue: { id: "node-42", projectItems: { nodes: [{ id: "item-42", project: { id: "project-id-123" } }] } } },
        i1: { issue: { id: "node-43", projectItems: { nodes: [{ id: "item-43", project: { id: "project-id-123" } }] } } },
        i2: { issue: { id: "node-10", projectItems: { nodes: [{ id: "item-10", project: { id: "project-id-123" } }] } } },
      },
      // Step D: batch field values
      {
        fv0: { fieldValues: { nodes: [{ __typename: "ProjectV2ItemFieldSingleSelectValue", name: "Plan in Review", field: { name: "Workflow State" } }] } },
        fv1: { fieldValues: { nodes: [{ __typename: "ProjectV2ItemFieldSingleSelectValue", name: "Ready for Plan", field: { name: "Workflow State" } }] } },
        fv2: { fieldValues: { nodes: [{ __typename: "ProjectV2ItemFieldSingleSelectValue", name: "Ready for Plan", field: { name: "Workflow State" } }] } },
      },
    ]);

    const result = await autoAdvanceParent(
      client, fieldCache, "owner", "repo", 42, "Plan in Review", 3,
    );
    expect(result).toEqual({ advanced: false, parentNumber: 10 });
  });

  it("returns advanced: false when parent already at or past gate", async () => {
    const client = createMockClient([
      // Step A: parent query
      { repository: { issue: { parent: { number: 10 } } } },
      // Step B: siblings query
      { repository: { issue: { subIssues: { nodes: [{ number: 42 }] } } } },
      // Step C: batch resolve
      {
        i0: { issue: { id: "node-42", projectItems: { nodes: [{ id: "item-42", project: { id: "project-id-123" } }] } } },
        i1: { issue: { id: "node-10", projectItems: { nodes: [{ id: "item-10", project: { id: "project-id-123" } }] } } },
      },
      // Step D: batch field values - parent already at Plan in Review
      {
        fv0: { fieldValues: { nodes: [{ __typename: "ProjectV2ItemFieldSingleSelectValue", name: "Plan in Review", field: { name: "Workflow State" } }] } },
        fv1: { fieldValues: { nodes: [{ __typename: "ProjectV2ItemFieldSingleSelectValue", name: "Plan in Review", field: { name: "Workflow State" } }] } },
      },
    ]);

    const result = await autoAdvanceParent(
      client, fieldCache, "owner", "repo", 42, "Plan in Review", 3,
    );
    expect(result).toEqual({
      advanced: false,
      parentNumber: 10,
      skippedReason: "already at or past",
    });
  });

  it("advances parent when all siblings at gate and parent behind", async () => {
    const client = createMockClient([
      // Step A: parent query
      { repository: { issue: { parent: { number: 10 } } } },
      // Step B: siblings query
      { repository: { issue: { subIssues: { nodes: [{ number: 42 }, { number: 43 }] } } } },
      // Step C: batch resolve
      {
        i0: { issue: { id: "node-42", projectItems: { nodes: [{ id: "item-42", project: { id: "project-id-123" } }] } } },
        i1: { issue: { id: "node-43", projectItems: { nodes: [{ id: "item-43", project: { id: "project-id-123" } }] } } },
        i2: { issue: { id: "node-10", projectItems: { nodes: [{ id: "item-10", project: { id: "project-id-123" } }] } } },
      },
      // Step D: batch field values - all siblings at Plan in Review, parent at Ready for Plan
      {
        fv0: { fieldValues: { nodes: [{ __typename: "ProjectV2ItemFieldSingleSelectValue", name: "Plan in Review", field: { name: "Workflow State" } }] } },
        fv1: { fieldValues: { nodes: [{ __typename: "ProjectV2ItemFieldSingleSelectValue", name: "Plan in Review", field: { name: "Workflow State" } }] } },
        fv2: { fieldValues: { nodes: [{ __typename: "ProjectV2ItemFieldSingleSelectValue", name: "Ready for Plan", field: { name: "Workflow State" } }] } },
      },
      // Step F: updateProjectItemField mutation (Workflow State)
      { updateProjectV2ItemFieldValue: { projectV2Item: { id: "item-10" } } },
      // Step F: syncStatusField mutation (Status)
      { updateProjectV2ItemFieldValue: { projectV2Item: { id: "item-10" } } },
    ]);

    const result = await autoAdvanceParent(
      client, fieldCache, "owner", "repo", 42, "Plan in Review", 3,
    );
    expect(result).toEqual({ advanced: true, parentNumber: 10, toState: "Plan in Review" });
  });

  it("returns null on API error (best-effort)", async () => {
    const client = createMockClient([]);
    // query will throw "No more mock responses"
    const result = await autoAdvanceParent(
      client, fieldCache, "owner", "repo", 42, "Plan in Review", 3,
    );
    expect(result).toBeNull();
  });

  it("returns advanced: false when siblings list is empty", async () => {
    const client = createMockClient([
      // Step A: parent query
      { repository: { issue: { parent: { number: 10 } } } },
      // Step B: siblings query - empty
      { repository: { issue: { subIssues: { nodes: [] } } } },
    ]);

    const result = await autoAdvanceParent(
      client, fieldCache, "owner", "repo", 42, "Plan in Review", 3,
    );
    expect(result).toEqual({ advanced: false, parentNumber: 10 });
  });
});

// ---------------------------------------------------------------------------
// isLegalParentGateAdvance matrix (GH-1615)
//
// Replaces the bare `stateIndex(parent) >= stateIndex(gate)` guard, which
// returns -1 for Human Needed / Canceled / unset, so it always "advanced"
// from those states — silently overwriting an escalation or writing over a
// live lock. All siblings are fixed at the gate state so the scenario
// reaches the parent-gate check being exercised.
// ---------------------------------------------------------------------------

function makeParentGateScenario(
  parentState: string | null,
  gateState: string,
): Array<unknown> {
  const parentFieldValues = parentState
    ? [{ __typename: "ProjectV2ItemFieldSingleSelectValue", name: parentState, field: { name: "Workflow State" } }]
    : [];
  return [
    // Step A: parent query
    { repository: { issue: { parent: { number: 10 } } } },
    // Step B: siblings query
    { repository: { issue: { subIssues: { nodes: [{ number: 42 }] } } } },
    // Step C: batch resolve
    {
      i0: { issue: { id: "node-42", projectItems: { nodes: [{ id: "item-42", project: { id: "project-id-123" } }] } } },
      i1: { issue: { id: "node-10", projectItems: { nodes: [{ id: "item-10", project: { id: "project-id-123" } }] } } },
    },
    // Step D: batch field values — sibling at gate, parent at parentState
    {
      fv0: { fieldValues: { nodes: [{ __typename: "ProjectV2ItemFieldSingleSelectValue", name: gateState, field: { name: "Workflow State" } }] } },
      fv1: { fieldValues: { nodes: parentFieldValues } },
    },
  ];
}

describe("autoAdvanceParent isLegalParentGateAdvance matrix", () => {
  let fieldCache: FieldOptionCache;

  beforeEach(() => {
    fieldCache = createMockFieldCache();
  });

  it("does NOT advance a parent at Human Needed (would overwrite an escalation)", async () => {
    const client = createMockClient(makeParentGateScenario("Human Needed", "Plan in Review"));
    const result = await autoAdvanceParent(client, fieldCache, "owner", "repo", 42, "Plan in Review", 3);
    expect(result).toEqual({ advanced: false, parentNumber: 10, skippedReason: "parent is escalated" });
  });

  it("does NOT advance a terminal parent (Done)", async () => {
    const client = createMockClient(makeParentGateScenario("Done", "Plan in Review"));
    const result = await autoAdvanceParent(client, fieldCache, "owner", "repo", 42, "Plan in Review", 3);
    expect(result).toEqual({ advanced: false, parentNumber: 10, skippedReason: "parent is terminal" });
  });

  it("does NOT advance a terminal parent (Canceled)", async () => {
    const client = createMockClient(makeParentGateScenario("Canceled", "Plan in Review"));
    const result = await autoAdvanceParent(client, fieldCache, "owner", "repo", 42, "Plan in Review", 3);
    expect(result).toEqual({ advanced: false, parentNumber: 10, skippedReason: "parent is terminal" });
  });

  it("does NOT advance a parent holding a live lock state", async () => {
    const client = createMockClient(makeParentGateScenario("Plan in Progress", "In Review"));
    const result = await autoAdvanceParent(client, fieldCache, "owner", "repo", 42, "In Review", 3);
    expect(result).toEqual({ advanced: false, parentNumber: 10, skippedReason: "parent is locked by an active claim" });
  });

  it("does NOT advance an unresolvable (unset) parent state", async () => {
    const client = createMockClient(makeParentGateScenario(null, "Plan in Review"));
    const result = await autoAdvanceParent(client, fieldCache, "owner", "repo", 42, "Plan in Review", 3);
    expect(result).toEqual({ advanced: false, parentNumber: 10, skippedReason: "parent state unresolvable" });
  });

  it("ADVANCES a Backlog parent to Ready for Plan (multi-hop gate jump)", async () => {
    const scenario = makeParentGateScenario("Backlog", "Ready for Plan");
    const client = createMockClient([
      ...scenario,
      { updateProjectV2ItemFieldValue: { projectV2Item: { id: "item-10" } } },
      { updateProjectV2ItemFieldValue: { projectV2Item: { id: "item-10" } } },
    ]);
    const result = await autoAdvanceParent(client, fieldCache, "owner", "repo", 42, "Ready for Plan", 3);
    expect(result).toEqual({ advanced: true, parentNumber: 10, toState: "Ready for Plan" });
  });

  it("ADVANCES a Backlog parent all the way to In Review (four-gate jump)", async () => {
    const scenario = makeParentGateScenario("Backlog", "In Review");
    const client = createMockClient([
      ...scenario,
      { updateProjectV2ItemFieldValue: { projectV2Item: { id: "item-10" } } },
      { updateProjectV2ItemFieldValue: { projectV2Item: { id: "item-10" } } },
    ]);
    const result = await autoAdvanceParent(client, fieldCache, "owner", "repo", 42, "In Review", 3);
    expect(result).toEqual({ advanced: true, parentNumber: 10, toState: "In Review" });
  });

  it("never throws on refusal — resolves with a skip result instead", async () => {
    const client = createMockClient(makeParentGateScenario("Human Needed", "Plan in Review"));
    // If autoAdvanceParent threw on refusal, this await would reject and fail
    // the test with an uncaught exception rather than a failed assertion.
    const result = await autoAdvanceParent(client, fieldCache, "owner", "repo", 42, "Plan in Review", 3);
    expect(result).not.toBeNull();
    expect(result?.advanced).toBe(false);
  });
});
