/**
 * Tests for the save_issue unified mutation tool.
 *
 * Covers: schema validation, auto-close logic, semantic intent integration,
 * and structural verification via source code reading.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { resolveState } from "../lib/state-resolution.js";
import { TERMINAL_STATES } from "../lib/workflow-states.js";

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

  it("supports issueState with state and stateReason in mutation", () => {
    expect(issueToolsSrc).toContain("$state: IssueState");
    expect(issueToolsSrc).toContain("$stateReason: IssueClosedStateReason");
  });

  it("supports field clearing via clearProjectV2ItemFieldValue", () => {
    expect(issueToolsSrc).toContain("clearProjectV2ItemFieldValue");
  });
});
