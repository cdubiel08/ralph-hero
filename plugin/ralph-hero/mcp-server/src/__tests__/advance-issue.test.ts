/**
 * Tests for advance_issue tool (unified from advance_children + advance_parent):
 * - Validates the schema for direction='children' with targetState + issues/number
 * - Validates the schema for direction='parent' with number only
 * - Verifies input validation logic
 *
 * These tests verify the schema and pure logic. Integration tests
 * (actual GraphQL execution) are tested manually.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { isEarlierState, isValidState, VALID_STATES } from "../lib/workflow-states.js";

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

  it("does not register list_dependencies", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "../tools/relationship-tools.ts"),
      "utf-8",
    );
    expect(src).not.toContain('"ralph_hero__list_dependencies"');
  });
});
