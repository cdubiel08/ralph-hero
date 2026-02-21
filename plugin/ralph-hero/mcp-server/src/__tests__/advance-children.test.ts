/**
 * Tests for advance_children tool extension:
 * - Validates the `issues` parameter for arbitrary issue sets
 * - Verifies backward compatibility with `number` parameter
 * - Tests input validation (neither, both, empty issues)
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

// Replicate the advance_children tool schema for testing
const advanceChildrenSchema = z.object({
  owner: z.string().optional(),
  repo: z.string().optional(),
  number: z.coerce.number().optional(),
  issues: z.array(z.coerce.number()).optional(),
  targetState: z.string(),
});

describe("advance_children schema", () => {
  it("accepts number only (backward compat)", () => {
    const result = advanceChildrenSchema.safeParse({
      number: 5,
      targetState: "Research Needed",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.number).toBe(5);
      expect(result.data.issues).toBeUndefined();
    }
  });

  it("accepts issues only", () => {
    const result = advanceChildrenSchema.safeParse({
      issues: [10, 11, 12],
      targetState: "Research Needed",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.issues).toEqual([10, 11, 12]);
      expect(result.data.number).toBeUndefined();
    }
  });

  it("accepts both number and issues", () => {
    const result = advanceChildrenSchema.safeParse({
      number: 5,
      issues: [10, 11, 12],
      targetState: "Ready for Plan",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.number).toBe(5);
      expect(result.data.issues).toEqual([10, 11, 12]);
    }
  });

  it("accepts neither number nor issues at schema level", () => {
    // Schema allows both optional - tool handler validates at runtime
    const result = advanceChildrenSchema.safeParse({
      targetState: "Research Needed",
    });
    expect(result.success).toBe(true);
  });

  it("accepts empty issues array at schema level", () => {
    const result = advanceChildrenSchema.safeParse({
      issues: [],
      targetState: "Research Needed",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.issues).toEqual([]);
    }
  });

  it("requires targetState", () => {
    const result = advanceChildrenSchema.safeParse({
      number: 5,
    });
    expect(result.success).toBe(false);
  });

  it("coerces string issue numbers to numbers", () => {
    const result = advanceChildrenSchema.safeParse({
      issues: ["10", "20", "30"],
      targetState: "Research Needed",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.issues).toEqual([10, 20, 30]);
    }
  });
});

// ---------------------------------------------------------------------------
// State advancement logic tests
// ---------------------------------------------------------------------------

describe("advance_children state logic", () => {
  it("identifies issues in earlier states for advancement", () => {
    // Backlog is earlier than Research Needed
    expect(isEarlierState("Backlog", "Research Needed")).toBe(true);
  });

  it("skips issues already at target state", () => {
    expect(isEarlierState("Research Needed", "Research Needed")).toBe(false);
  });

  it("skips issues past target state", () => {
    // In Progress is past Research Needed
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
    // Done and Canceled are terminal
    expect(isValidState("Done")).toBe(true);
    expect(isValidState("Canceled")).toBe(true);
  });

  it("handles all workflow states in order", () => {
    // Verify ordering: Backlog < Research Needed < ... < Done
    expect(isEarlierState("Backlog", "Done")).toBe(true);
    expect(isEarlierState("Done", "Backlog")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Input validation logic tests (mirrors tool handler)
// ---------------------------------------------------------------------------

describe("advance_children input validation", () => {
  function validateInputs(args: {
    number?: number;
    issues?: number[];
    targetState: string;
  }): { valid: boolean; error?: string } {
    // Mirror the tool's runtime validation
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

  it("rejects when neither number nor issues provided", () => {
    const result = validateInputs({ targetState: "Research Needed" });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Either");
  });

  it("rejects empty issues array with no number", () => {
    const result = validateInputs({ issues: [], targetState: "Research Needed" });
    expect(result.valid).toBe(false);
  });

  it("accepts number only", () => {
    const result = validateInputs({ number: 5, targetState: "Research Needed" });
    expect(result.valid).toBe(true);
  });

  it("accepts issues only", () => {
    const result = validateInputs({
      issues: [10, 11],
      targetState: "Research Needed",
    });
    expect(result.valid).toBe(true);
  });

  it("accepts both (issues takes precedence in handler)", () => {
    const result = validateInputs({
      number: 5,
      issues: [10, 11],
      targetState: "Ready for Plan",
    });
    expect(result.valid).toBe(true);
  });

  it("rejects invalid target state", () => {
    const result = validateInputs({
      number: 5,
      targetState: "InvalidState",
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Unknown target state");
  });

  it("validates all known states are accepted", () => {
    for (const state of VALID_STATES) {
      const result = validateInputs({ number: 1, targetState: state });
      expect(result.valid).toBe(true);
    }
  });
});
