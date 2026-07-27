/**
 * Tests for the save_issue unified mutation tool.
 *
 * Covers: schema validation, auto-close logic, semantic intent integration,
 * structural verification via source code reading, and (GH-1615) handler-
 * level integration tests for the transition-legality choke point.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveState } from "../lib/state-resolution.js";
import { TERMINAL_STATES, ISSUE_STATE_TO_TERMINAL_WORKFLOW } from "../lib/workflow-states.js";
import { registerIssueTools } from "../tools/issue-tools.js";
import type { GitHubClient } from "../github-client.js";
import { FieldOptionCache } from "../lib/cache.js";

// ---------------------------------------------------------------------------
// Read source for structural tests
// ---------------------------------------------------------------------------

const issueToolsSrc = fs.readFileSync(
  path.resolve(__dirname, "../tools/issue-tools.ts"),
  "utf-8",
);

// ---------------------------------------------------------------------------
// Schema (extracted from the tool registration for unit testing)
// ---------------------------------------------------------------------------

const saveIssueSchema = z.object({
  owner: z.string().optional(),
  repo: z.string().optional(),
  projectNumber: z.coerce.number().optional(),
  number: z.coerce.number(),
  title: z.string().optional(),
  body: z.string().optional(),
  labels: z.array(z.string()).optional(),
  assignees: z.array(z.string()).optional(),
  issueState: z.enum(["OPEN", "CLOSED", "CLOSED_NOT_PLANNED"]).optional(),
  workflowState: z.string().optional(),
  estimate: z.enum(["XS", "S", "M", "L", "XL"]).nullable().optional(),
  priority: z.enum(["P0", "P1", "P2", "P3"]).nullable().optional(),
  iteration: z.string().nullable().optional(),
  command: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Schema validation tests
// ---------------------------------------------------------------------------

describe("save_issue schema validation", () => {
  it("accepts number + title (issue-only update)", () => {
    const result = saveIssueSchema.safeParse({ number: 42, title: "New title" });
    expect(result.success).toBe(true);
  });

  it("accepts number + workflowState + command (project-only update)", () => {
    const result = saveIssueSchema.safeParse({
      number: 42,
      workflowState: "In Progress",
      command: "ralph_impl",
    });
    expect(result.success).toBe(true);
  });

  it("accepts number + title + workflowState + estimate (combined update)", () => {
    const result = saveIssueSchema.safeParse({
      number: 42,
      title: "New title",
      workflowState: "In Progress",
      estimate: "S",
    });
    expect(result.success).toBe(true);
  });

  it("accepts number + issueState (close/reopen)", () => {
    const result = saveIssueSchema.safeParse({
      number: 42,
      issueState: "CLOSED",
    });
    expect(result.success).toBe(true);
  });

  it("accepts number + estimate: null (field clearing)", () => {
    const result = saveIssueSchema.safeParse({
      number: 42,
      estimate: null,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.estimate).toBeNull();
    }
  });

  it("rejects invalid issueState values", () => {
    const result = saveIssueSchema.safeParse({
      number: 42,
      issueState: "INVALID",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid estimate values", () => {
    const result = saveIssueSchema.safeParse({
      number: 42,
      estimate: "HUGE",
    });
    expect(result.success).toBe(false);
  });

  it("coerces number from string to number", () => {
    const result = saveIssueSchema.safeParse({ number: "42", title: "Test" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.number).toBe(42);
    }
  });

  it("coerces projectNumber from string to number", () => {
    const result = saveIssueSchema.safeParse({
      number: 42,
      projectNumber: "3",
      title: "Test",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.projectNumber).toBe(3);
    }
  });

  it("accepts CLOSED_NOT_PLANNED issueState", () => {
    const result = saveIssueSchema.safeParse({
      number: 42,
      issueState: "CLOSED_NOT_PLANNED",
    });
    expect(result.success).toBe(true);
  });

  it("accepts number + iteration (iteration title)", () => {
    const result = saveIssueSchema.safeParse({
      number: 42,
      iteration: "Sprint 1",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.iteration).toBe("Sprint 1");
    }
  });

  it("accepts number + iteration: @current (token)", () => {
    const result = saveIssueSchema.safeParse({
      number: 42,
      iteration: "@current",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.iteration).toBe("@current");
    }
  });

  it("accepts number + iteration: @next (token)", () => {
    const result = saveIssueSchema.safeParse({
      number: 42,
      iteration: "@next",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.iteration).toBe("@next");
    }
  });

  it("accepts number + iteration: null (field clearing)", () => {
    const result = saveIssueSchema.safeParse({
      number: 42,
      iteration: null,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.iteration).toBeNull();
    }
  });

  it("treats iteration as project field (triggers project mutation path)", () => {
    // When iteration is the only project-level field, hasProjectFields should be true
    const result = saveIssueSchema.safeParse({
      number: 42,
      iteration: "Sprint 1",
    });
    expect(result.success).toBe(true);
    // Verify no issue-level fields are set (only project-level)
    if (result.success) {
      expect(result.data.title).toBeUndefined();
      expect(result.data.workflowState).toBeUndefined();
      expect(result.data.estimate).toBeUndefined();
      expect(result.data.priority).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Auto-close logic tests (pure function)
// ---------------------------------------------------------------------------

describe("save_issue auto-close logic", () => {
  function shouldAutoClose(
    workflowState: string | undefined,
    issueState: string | undefined,
  ): { autoClose: boolean; stateReason?: string } {
    if (!issueState && workflowState && TERMINAL_STATES.includes(workflowState)) {
      return {
        autoClose: true,
        stateReason: workflowState === "Canceled" ? "NOT_PLANNED" : "COMPLETED",
      };
    }
    return { autoClose: false };
  }

  it("auto-closes with NOT_PLANNED when workflowState is Canceled", () => {
    const result = shouldAutoClose("Canceled", undefined);
    expect(result.autoClose).toBe(true);
    expect(result.stateReason).toBe("NOT_PLANNED");
  });

  it("auto-closes with COMPLETED when workflowState is Done", () => {
    const result = shouldAutoClose("Done", undefined);
    expect(result.autoClose).toBe(true);
    expect(result.stateReason).toBe("COMPLETED");
  });

  it("does not auto-close for non-terminal workflowState", () => {
    const result = shouldAutoClose("In Progress", undefined);
    expect(result.autoClose).toBe(false);
  });

  it("does not auto-close when issueState is explicitly set", () => {
    const result = shouldAutoClose("Done", "OPEN");
    expect(result.autoClose).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Semantic intent resolution tests (integration with resolveState)
// ---------------------------------------------------------------------------

describe("save_issue semantic intent resolution", () => {
  it("__LOCK__ + ralph_plan resolves to Plan in Progress", () => {
    const result = resolveState("__LOCK__", "ralph_plan");
    expect(result.resolvedState).toBe("Plan in Progress");
    expect(result.wasIntent).toBe(true);
  });

  it("__COMPLETE__ + ralph_research resolves to Ready for Plan", () => {
    const result = resolveState("__COMPLETE__", "ralph_research");
    expect(result.resolvedState).toBe("Ready for Plan");
    expect(result.wasIntent).toBe(true);
  });

  it("__CANCEL__ + ralph_triage resolves to Canceled (triggers auto-close)", () => {
    const result = resolveState("__CANCEL__", "ralph_triage");
    expect(result.resolvedState).toBe("Canceled");
    expect(result.wasIntent).toBe(true);
    expect(TERMINAL_STATES.includes(result.resolvedState)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Structural tests (source code verification)
// ---------------------------------------------------------------------------

describe("save_issue structural", () => {
  it("save_issue tool is registered", () => {
    expect(issueToolsSrc).toContain("ralph_hero__save_issue");
  });

  it("handler calls resolveState when workflowState is provided", () => {
    expect(issueToolsSrc).toContain("resolveState(args.workflowState, args.command)");
  });

  it("handler calls resolveFullConfig for project field paths", () => {
    // The save_issue handler uses resolveFullConfig for project fields
    expect(issueToolsSrc).toContain("resolveFullConfig(client, args)");
  });

  it("handler calls resolveIssueNodeId for issue-object mutations", () => {
    expect(issueToolsSrc).toContain("resolveIssueNodeId(client, owner, repo, args.number)");
  });

  it("status sync is included in the aliased mutation (not a separate call)", () => {
    // Verify the inline status sync pattern with WORKFLOW_STATE_TO_STATUS
    expect(issueToolsSrc).toContain("WORKFLOW_STATE_TO_STATUS[resolvedWorkflowState]");
  });

  it("imports buildBatchMutationQuery from batch-tools", () => {
    expect(issueToolsSrc).toContain('import { buildBatchMutationQuery } from "./batch-tools.js"');
  });

  it("imports TERMINAL_STATES and WORKFLOW_STATE_TO_STATUS", () => {
    expect(issueToolsSrc).toContain("TERMINAL_STATES");
    expect(issueToolsSrc).toContain("WORKFLOW_STATE_TO_STATUS");
  });

  it("uses closeIssue mutation with stateReason for closing", () => {
    expect(issueToolsSrc).toContain("closeIssue(input:");
    expect(issueToolsSrc).toContain("$stateReason: IssueClosedStateReason");
  });

  it("uses reopenIssue mutation for reopening (no stateReason)", () => {
    expect(issueToolsSrc).toContain("reopenIssue(input:");
    // reopenIssue should NOT reference stateReason
    const reopenBlock = issueToolsSrc.slice(
      issueToolsSrc.indexOf("reopenIssue(input:"),
      issueToolsSrc.indexOf("reopenIssue(input:") + 200,
    );
    expect(reopenBlock).not.toContain("stateReason");
  });

  it("updateIssue mutation does not include state or stateReason", () => {
    // Find the updateIssue mutation input block
    const updateIdx = issueToolsSrc.indexOf("updateIssue(input:");
    expect(updateIdx).toBeGreaterThan(-1);
    const updateBlock = issueToolsSrc.slice(updateIdx, updateIdx + 300);
    expect(updateBlock).not.toContain("stateReason");
    // state should not be in updateIssue input (it's handled by closeIssue/reopenIssue)
    expect(updateBlock).not.toContain("$state");
  });

  it("does not hardcode null for metadata fields in updateIssue variables", () => {
    // After the fix, metadata fields should only be included when provided.
    // Scope check to the updateIssue section (not createIssue which is a separate path).
    const updateIdx = issueToolsSrc.indexOf("updateIssue(input:");
    expect(updateIdx).toBeGreaterThan(-1);
    // Grab a generous window covering the dynamic builder and mutation call
    const updateSection = issueToolsSrc.slice(updateIdx - 1000, updateIdx + 500);
    expect(updateSection).not.toContain("assigneeIds: null");
    expect(updateSection).not.toContain("args.title ?? null");
    expect(updateSection).not.toContain("args.body ?? null");
  });

  it("uses dynamic mutation construction for updateIssue", () => {
    expect(issueToolsSrc).toContain("varDefs");
    expect(issueToolsSrc).toContain("inputFields");
  });

  it("does not assign REOPENED as stateReason", () => {
    expect(issueToolsSrc).not.toContain('"REOPENED"');
  });

  it("supports field clearing via clearProjectV2ItemFieldValue", () => {
    expect(issueToolsSrc).toContain("clearProjectV2ItemFieldValue");
  });

  it("calls autoAdvanceParent gated by isParentGateState", () => {
    expect(issueToolsSrc).toContain("isParentGateState(resolvedWorkflowState)");
    expect(issueToolsSrc).toContain("autoAdvanceParent(");
  });

  it("imports autoAdvanceParent from helpers", () => {
    expect(issueToolsSrc).toContain("autoAdvanceParent");
  });

  it("imports isParentGateState from workflow-states", () => {
    expect(issueToolsSrc).toContain("isParentGateState");
  });

  it("imports resolveIterationId from helpers", () => {
    expect(issueToolsSrc).toContain("resolveIterationId");
  });

  it("includes iteration in hasProjectFields check", () => {
    expect(issueToolsSrc).toContain("args.iteration !== undefined");
  });

  it("calls resolveIterationId for non-null iteration values", () => {
    expect(issueToolsSrc).toContain("resolveIterationId(");
  });

  it("uses valueType iterationId for iteration field updates", () => {
    expect(issueToolsSrc).toContain('valueType: "iterationId"');
  });

  it("discovers iteration field dynamically via getFieldNames + getIterations", () => {
    expect(issueToolsSrc).toContain("fieldCache.getFieldNames(");
    expect(issueToolsSrc).toContain("fieldCache.getIterations(");
  });

  it("supports clearing iteration field via fieldsToClear", () => {
    // Iteration clear path pushes to fieldsToClear like estimate/priority
    const iterSection = issueToolsSrc.slice(
      issueToolsSrc.indexOf("// 4d. Iteration"),
      issueToolsSrc.indexOf("// 4e."),
    );
    expect(iterSection).toContain("fieldsToClear.push");
    expect(iterSection).toContain("args.iteration === null");
  });
});

// ---------------------------------------------------------------------------
// Reverse-inference logic tests (GH-1471): inferring workflowState from issueState
// ---------------------------------------------------------------------------

/**
 * Pure helper mirroring the reverse-inference block in save_issue.
 * Accepts the same inputs (args.workflowState, targetState, stateReason) and
 * returns the inferred workflowState (or undefined when inference does not apply).
 */
function inferWorkflowFromClose(
  explicitWorkflowState: string | undefined,
  targetState: "OPEN" | "CLOSED" | undefined,
  stateReason: "COMPLETED" | "NOT_PLANNED" | undefined,
): string | undefined {
  if (explicitWorkflowState !== undefined) return undefined; // explicit wins
  if (targetState !== "CLOSED") return undefined; // only closed issues
  const key = `CLOSED:${stateReason ?? ""}`;
  return ISSUE_STATE_TO_TERMINAL_WORKFLOW[key];
}

describe("save_issue reverse-inference (GH-1471)", () => {
  // Acceptance criterion 1: CLOSED (no workflowState) → Done
  it("CLOSED with no workflowState infers Done", () => {
    const result = inferWorkflowFromClose(undefined, "CLOSED", "COMPLETED");
    expect(result).toBe("Done");
  });

  // Acceptance criterion 2: CLOSED_NOT_PLANNED (no workflowState) → Canceled
  it("CLOSED_NOT_PLANNED with no workflowState infers Canceled", () => {
    const result = inferWorkflowFromClose(undefined, "CLOSED", "NOT_PLANNED");
    expect(result).toBe("Canceled");
  });

  // Acceptance criterion 3: explicit workflowState always wins
  it("explicit workflowState overrides close inference", () => {
    const result = inferWorkflowFromClose("In Progress", "CLOSED", "COMPLETED");
    expect(result).toBeUndefined();
  });

  // OPEN/reopen calls must not trigger inference
  it("OPEN targetState does not infer a workflow state", () => {
    const result = inferWorkflowFromClose(undefined, "OPEN", undefined);
    expect(result).toBeUndefined();
  });

  // No targetState (metadata-only call) must not trigger inference
  it("undefined targetState does not infer a workflow state", () => {
    const result = inferWorkflowFromClose(undefined, undefined, undefined);
    expect(result).toBeUndefined();
  });

  // Confirm inferred states are terminal (not lock states)
  it("inferred Done is in TERMINAL_STATES", () => {
    const result = inferWorkflowFromClose(undefined, "CLOSED", "COMPLETED");
    expect(TERMINAL_STATES.includes(result!)).toBe(true);
  });

  it("inferred Canceled is in TERMINAL_STATES", () => {
    const result = inferWorkflowFromClose(undefined, "CLOSED", "NOT_PLANNED");
    expect(TERMINAL_STATES.includes(result!)).toBe(true);
  });
});

describe("save_issue reverse-inference structural (GH-1471)", () => {
  // Verify the guard line changed to also trigger on inferredFromClose
  it("project-field block fires on inferredFromClose", () => {
    expect(issueToolsSrc).toContain("inferredFromClose");
    expect(issueToolsSrc).toContain("hasProjectFields || inferredFromClose");
  });

  it("ISSUE_STATE_TO_TERMINAL_WORKFLOW is exported from workflow-states", () => {
    const wsSrc = fs.readFileSync(
      path.resolve(__dirname, "../lib/workflow-states.ts"),
      "utf-8",
    );
    expect(wsSrc).toContain("ISSUE_STATE_TO_TERMINAL_WORKFLOW");
    expect(wsSrc).toContain('"CLOSED:COMPLETED": "Done"');
    expect(wsSrc).toContain('"CLOSED:NOT_PLANNED": "Canceled"');
  });

  it("reverse inference block precondition checks args.workflowState === undefined", () => {
    expect(issueToolsSrc).toContain("args.workflowState === undefined");
  });

  it("tool description mentions reverse inference direction", () => {
    expect(issueToolsSrc).toContain("Reverse inference");
  });

  // Confirm the forward Done→auto-close path is still present and unchanged
  it("forward auto-close path (Done/Canceled → CLOSED) still present", () => {
    expect(issueToolsSrc).toContain("changes.autoClose = true");
    expect(issueToolsSrc).toContain(
      "TERMINAL_STATES.includes(resolvedWorkflowState)",
    );
  });
});

// ---------------------------------------------------------------------------
// Lock guard integration tests (structural source code verification)
// ---------------------------------------------------------------------------

describe("save_issue lock guard integration", () => {
  it("imports isLockConflict from lock-guard", () => {
    expect(issueToolsSrc).toContain('import { isLockConflict } from "../lib/lock-guard.js"');
  });

  it("calls isLockConflict in the save_issue handler", () => {
    expect(issueToolsSrc).toContain("isLockConflict");
  });

  it("calls getCurrentFieldValue as part of the lock guard check", () => {
    // getCurrentFieldValue must be called conditionally inside the lock guard block
    expect(issueToolsSrc).toContain("getCurrentFieldValue");
    // Verify it is used specifically for the Workflow State field in the lock guard
    expect(issueToolsSrc).toContain('"Workflow State"');
  });

  it("returns toolError with actionable message when lock conflict detected", () => {
    expect(issueToolsSrc).toContain("already in a lock state");
    expect(issueToolsSrc).toContain("force=true to override");
  });

  it("guard is conditional on resolvedWorkflowState being a lock state", () => {
    expect(issueToolsSrc).toContain("LOCK_STATES.includes(resolvedWorkflowState)");
  });

  it("includes force parameter in save_issue schema", () => {
    expect(issueToolsSrc).toContain("force: zBoolish()");
  });

  it("guard is bypassed when args.force is true", () => {
    expect(issueToolsSrc).toContain("!args.force");
  });
});

// ---------------------------------------------------------------------------
// GH-1615: transition-legality choke point — handler-level integration tests
// (mirrors the `getTool` pattern used elsewhere in this test suite, e.g.
// issue-tools.test.ts's get_issue/list_issues integration harness).
// ---------------------------------------------------------------------------

interface HandlerResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

interface RegisteredTool {
  handler: (args: unknown, extra: unknown) => Promise<HandlerResult>;
}

function getSaveIssueHandler(server: McpServer): RegisteredTool {
  const tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
  const tool = tools?.["ralph_hero__save_issue"];
  if (!tool) throw new Error("ralph_hero__save_issue not registered");
  return tool;
}

function parseSaveIssuePayload(result: HandlerResult): Record<string, unknown> {
  expect(result.content).toHaveLength(1);
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

function makeFieldCacheForSaveIssueTests(): FieldOptionCache {
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
 * Mock GitHubClient for save_issue integration tests. `currentWorkflowState`
 * models the live board state: a string for a real value, `null` for "query
 * succeeded, no Workflow State value on the item" (genuinely unset).
 */
function makeSaveIssueMockClient(opts: {
  currentWorkflowState: string | null;
  fieldValueQueryShouldFail?: boolean;
}): { client: GitHubClient; mutate: ReturnType<typeof vi.fn>; projectMutate: ReturnType<typeof vi.fn> } {
  const cacheStore = new Map<string, { value: unknown; expiry: number }>();
  const projectItemId = "item-1615";

  const query = vi.fn(async (q: string) => {
    // resolveProjectItemId: `... on Issue { projectItems(first: ...) }`
    if (q.includes("... on Issue {") && q.includes("projectItems(first:")) {
      return {
        node: {
          projectItems: {
            nodes: [{ id: projectItemId, project: { id: "project-id-1" } }],
          },
        },
      };
    }
    // getCurrentFieldValue: `... on ProjectV2Item { fieldValues(first: 20) }`
    if (q.includes("... on ProjectV2Item {") && q.includes("fieldValues(first: 20)")) {
      if (opts.fieldValueQueryShouldFail) {
        throw new Error("simulated current-state fetch failure");
      }
      const nodes = opts.currentWorkflowState
        ? [{ __typename: "ProjectV2ItemFieldSingleSelectValue", name: opts.currentWorkflowState, field: { name: "Workflow State" } }]
        : [];
      return { node: { fieldValues: { nodes } } };
    }
    // resolveIssueNodeId: `repository(owner: ...) { issue(number: ...) { id } }`.
    // This is a READ helper shared by resolveProjectItemId (used by the
    // transition-legality check's current-state fetch) AND section 3's
    // issue-mutation path — it never mutates by itself, so its query firing
    // does not indicate a mutation happened.
    if (q.includes("repository(owner:") && q.includes("issue(number:")) {
      return { repository: { issue: { id: "issue-node-1615" } } };
    }
    throw new Error(`Unmocked query: ${q.slice(0, 120)}`);
  });

  const mutate = vi.fn(async () => ({}));
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
    mutate,
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

  return { client, mutate, projectMutate };
}

describe("save_issue transition legality — handler integration (GH-1615)", () => {
  let server: McpServer;
  let fieldCache: FieldOptionCache;

  beforeEach(() => {
    server = new McpServer({ name: "test", version: "0.0.0" });
    fieldCache = makeFieldCacheForSaveIssueTests();
  });

  it("PLACEMENT TEST: illegal transition + issueState:OPEN + title mutates NOTHING", async () => {
    const { client, mutate, projectMutate } = makeSaveIssueMockClient({
      currentWorkflowState: "Backlog",
    });
    registerIssueTools(server, client, fieldCache);
    const handler = getSaveIssueHandler(server);

    const result = await handler.handler(
      {
        number: 1615,
        issueState: "OPEN",
        title: "New title",
        workflowState: "In Review", // Backlog -> In Review is illegal
      },
      {},
    );

    expect(result.isError).toBe(true);
    const payload = parseSaveIssuePayload(result) as { error: string };
    expect(payload.error).toContain("Illegal transition for #1615");
    expect(payload.error).toContain('"Backlog" -> "In Review"');
    expect(payload.error).toContain("force=true");

    // Zero mutations of any kind: no reopenIssue/updateIssue (client.mutate)
    // and no updateProjectV2ItemFieldValue (client.projectMutate).
    expect(mutate).not.toHaveBeenCalled();
    expect(projectMutate).not.toHaveBeenCalled();
  });

  it("illegal transition names the legal next states", async () => {
    const { client } = makeSaveIssueMockClient({ currentWorkflowState: "Backlog" });
    registerIssueTools(server, client, fieldCache);
    const handler = getSaveIssueHandler(server);

    const result = await handler.handler(
      { number: 1615, workflowState: "In Review" },
      {},
    );

    expect(result.isError).toBe(true);
    const payload = parseSaveIssuePayload(result) as { error: string };
    expect(payload.error).toContain("Legal next states from \"Backlog\"");
    expect(payload.error).toContain("Research Needed");
    expect(payload.error).toContain("Ready for Plan");
  });

  it("legal transition succeeds and mutates the project field", async () => {
    const { client, projectMutate } = makeSaveIssueMockClient({ currentWorkflowState: "Ready for Plan" });
    registerIssueTools(server, client, fieldCache);
    const handler = getSaveIssueHandler(server);

    const result = await handler.handler(
      { number: 1615, workflowState: "In Progress" },
      {},
    );

    expect(result.isError).toBeUndefined();
    const payload = parseSaveIssuePayload(result) as { changes: { workflowState: string } };
    expect(payload.changes.workflowState).toBe("In Progress");
    expect(projectMutate).toHaveBeenCalledTimes(1);
  });

  it("force bypasses an illegal transition and marks it forced", async () => {
    const { client, projectMutate } = makeSaveIssueMockClient({ currentWorkflowState: "Backlog" });
    registerIssueTools(server, client, fieldCache);
    const handler = getSaveIssueHandler(server);

    const result = await handler.handler(
      { number: 1615, workflowState: "In Review", force: true },
      {},
    );

    expect(result.isError).toBeUndefined();
    const payload = parseSaveIssuePayload(result) as {
      changes: { forcedTransition?: { from: string; to: string } };
    };
    expect(payload.changes.forcedTransition).toEqual({ from: "Backlog", to: "In Review" });
    expect(projectMutate).toHaveBeenCalledTimes(1);
  });

  it("force on an already-legal transition does NOT add a forcedTransition marker", async () => {
    const { client } = makeSaveIssueMockClient({ currentWorkflowState: "Ready for Plan" });
    registerIssueTools(server, client, fieldCache);
    const handler = getSaveIssueHandler(server);

    const result = await handler.handler(
      { number: 1615, workflowState: "In Progress", force: true },
      {},
    );

    const payload = parseSaveIssuePayload(result) as { changes: Record<string, unknown> };
    expect(payload.changes.forcedTransition).toBeUndefined();
  });

  it("command-less direct-state path is still transition-validated", async () => {
    const { client } = makeSaveIssueMockClient({ currentWorkflowState: "Backlog" });
    registerIssueTools(server, client, fieldCache);
    const handler = getSaveIssueHandler(server);

    // No `command` — validateDirectState/resolveState are bypassed entirely,
    // but the transition-legality check still runs (this is the closed gap
    // research §3 identified: "the command-less path checks only isValidState").
    const result = await handler.handler(
      { number: 1615, workflowState: "In Review" },
      {},
    );
    expect(result.isError).toBe(true);
  });

  it("command + illegal transition is refused even though the command allows the direct state", async () => {
    const { client } = makeSaveIssueMockClient({ currentWorkflowState: "Backlog" });
    registerIssueTools(server, client, fieldCache);
    const handler = getSaveIssueHandler(server);

    // "In Review" is a valid ralph_impl output state (command-level check
    // passes), but Backlog -> In Review is still an illegal TRANSITION.
    const result = await handler.handler(
      { number: 1615, workflowState: "In Review", command: "ralph_impl" },
      {},
    );
    expect(result.isError).toBe(true);
    const payload = parseSaveIssuePayload(result) as { error: string };
    expect(payload.error).toContain("Illegal transition");
  });

  it("TERMINAL-SOURCE TEST: CLOSED_NOT_PLANNED on a Done issue refuses without force and does not close", async () => {
    const { client, mutate } = makeSaveIssueMockClient({ currentWorkflowState: "Done" });
    registerIssueTools(server, client, fieldCache);
    const handler = getSaveIssueHandler(server);

    const result = await handler.handler(
      { number: 1615, issueState: "CLOSED_NOT_PLANNED" },
      {},
    );

    expect(result.isError).toBe(true);
    const payload = parseSaveIssuePayload(result) as { error: string };
    expect(payload.error).toContain("Illegal transition for #1615");
    expect(payload.error).toContain('"Done" -> "Canceled"');
    // closeIssue is a client.mutate call — must not have fired.
    expect(mutate).not.toHaveBeenCalled();
  });

  it("TERMINAL-SOURCE TEST: CLOSED_NOT_PLANNED on Done succeeds with force and reports forcedTransition", async () => {
    const { client, mutate } = makeSaveIssueMockClient({ currentWorkflowState: "Done" });
    registerIssueTools(server, client, fieldCache);
    const handler = getSaveIssueHandler(server);

    const result = await handler.handler(
      { number: 1615, issueState: "CLOSED_NOT_PLANNED", force: true },
      {},
    );

    expect(result.isError).toBeUndefined();
    const payload = parseSaveIssuePayload(result) as {
      changes: { forcedTransition?: { from: string; to: string }; workflowStateInferred?: string };
    };
    expect(payload.changes.forcedTransition).toEqual({ from: "Done", to: "Canceled" });
    // With force, the close mutation DOES fire.
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it("TERMINAL-SOURCE TEST: Done -> Done re-close (same-state) still passes without force", async () => {
    const { client, mutate } = makeSaveIssueMockClient({ currentWorkflowState: "Done" });
    registerIssueTools(server, client, fieldCache);
    const handler = getSaveIssueHandler(server);

    const result = await handler.handler(
      { number: 1615, issueState: "CLOSED" },
      {},
    );

    expect(result.isError).toBeUndefined();
    const payload = parseSaveIssuePayload(result) as { changes: Record<string, unknown> };
    expect(payload.changes.forcedTransition).toBeUndefined();
    expect(payload.changes.workflowStateInferred).toBe("Done");
    expect(mutate).toHaveBeenCalledTimes(1); // closeIssue still fires (same-state)
  });

  it("FAIL-CLOSED FETCH TEST: current-state read rejects -> toolError, zero mutations", async () => {
    const { client, mutate, projectMutate } = makeSaveIssueMockClient({
      currentWorkflowState: "Backlog",
      fieldValueQueryShouldFail: true,
    });
    registerIssueTools(server, client, fieldCache);
    const handler = getSaveIssueHandler(server);

    const result = await handler.handler(
      { number: 1615, workflowState: "In Progress" },
      {},
    );

    expect(result.isError).toBe(true);
    const payload = parseSaveIssuePayload(result) as { error: string };
    expect(payload.error).toContain("Could not determine the current state");
    expect(mutate).not.toHaveBeenCalled();
    expect(projectMutate).not.toHaveBeenCalled();
  });

  it("FAIL-CLOSED FETCH TEST: item present with no Workflow State value PASSES", async () => {
    const { client, projectMutate } = makeSaveIssueMockClient({ currentWorkflowState: null });
    registerIssueTools(server, client, fieldCache);
    const handler = getSaveIssueHandler(server);

    const result = await handler.handler(
      { number: 1615, workflowState: "Ready for Plan" },
      {},
    );

    expect(result.isError).toBeUndefined();
    const payload = parseSaveIssuePayload(result) as { changes: { workflowState: string } };
    expect(payload.changes.workflowState).toBe("Ready for Plan");
    expect(projectMutate).toHaveBeenCalledTimes(1);
  });

  it("lock guard still fires (transition is legal) and shares the transition check's current-state read", async () => {
    const { client, projectMutate } = makeSaveIssueMockClient({ currentWorkflowState: "Plan in Progress" });
    registerIssueTools(server, client, fieldCache);
    const handler = getSaveIssueHandler(server);

    // "Plan in Progress" -> "In Progress" IS a legal transition (JSON edge),
    // so this exercises the lock guard specifically, not the transition
    // check: current is a DIFFERENT lock state than the target, a conflict.
    const result = await handler.handler(
      { number: 1615, workflowState: "In Progress" },
      {},
    );

    expect(result.isError).toBe(true);
    const payload = parseSaveIssuePayload(result) as { error: string };
    expect(payload.error).toContain("already in a lock state");
    expect(projectMutate).not.toHaveBeenCalled();

    // getCurrentFieldValue's underlying query fires exactly once — shared
    // between the transition check and the lock guard (GH-1615 Performance
    // Considerations: "hoisted so lock guard and transition check share it").
    const fieldValueCalls = (client.query as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(
      ([q]: unknown[]) => typeof q === "string" && q.includes("fieldValues(first: 20)"),
    );
    expect(fieldValueCalls).toHaveLength(1);
  });
});
