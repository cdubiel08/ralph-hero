import { describe, it, expect } from "vitest";
import {
  resolveState,
  COMMAND_ALLOWED_STATES,
} from "../lib/state-resolution.js";
import {
  SKIP_ENTRY_STATES,
  isValidState,
} from "../lib/workflow-states.js";

describe("tiered planning state paths", () => {
  describe("epic (3+ tier) path", () => {
    it("ralph_plan_epic locks to Plan in Progress", () => {
      const result = resolveState("__LOCK__", "ralph_plan_epic");
      expect(result.resolvedState).toBe("Plan in Progress");
    });

    it("ralph_plan_epic completes to In Progress", () => {
      const result = resolveState("__COMPLETE__", "ralph_plan_epic");
      expect(result.resolvedState).toBe("In Progress");
    });

    it("ralph_plan_epic escalates to Human Needed", () => {
      const result = resolveState("__ESCALATE__", "ralph_plan_epic");
      expect(result.resolvedState).toBe("Human Needed");
    });

    it("ralph_plan_epic accepts bare command name", () => {
      const result = resolveState("__LOCK__", "plan_epic");
      expect(result.resolvedState).toBe("Plan in Progress");
    });
  });

  describe("split from plan", () => {
    it("ralph_split can create children at Ready for Plan (from plan-of-plans)", () => {
      const result = resolveState("Ready for Plan", "ralph_split");
      expect(result.resolvedState).toBe("Ready for Plan");
    });

    it("ralph_split can create children at In Progress (from implementation plan)", () => {
      const result = resolveState("In Progress", "ralph_split");
      expect(result.resolvedState).toBe("In Progress");
    });

    it("ralph_split __COMPLETE__ still defaults to Backlog", () => {
      const result = resolveState("__COMPLETE__", "ralph_split");
      expect(result.resolvedState).toBe("Backlog");
    });

    it("ralph_split rejects states not in its outputs", () => {
      expect(() => resolveState("Done", "ralph_split")).toThrow(
        /not a valid output for ralph_split/i,
      );
    });
  });

  describe("plan split-after-plan", () => {
    it("ralph_plan can exit to In Progress (split-after-plan for M issues)", () => {
      const result = resolveState("In Progress", "ralph_plan");
      expect(result.resolvedState).toBe("In Progress");
    });

    it("ralph_plan __COMPLETE__ still goes to Plan in Review", () => {
      const result = resolveState("__COMPLETE__", "ralph_plan");
      expect(result.resolvedState).toBe("Plan in Review");
    });
  });

  describe("SKIP_ENTRY_STATES mapping", () => {
    it("plan-of-plans children enter at Ready for Plan", () => {
      expect(SKIP_ENTRY_STATES["plan-of-plans"]).toBe("Ready for Plan");
    });

    it("implementation plan children enter at In Progress", () => {
      expect(SKIP_ENTRY_STATES["plan"]).toBe("In Progress");
    });

    it("all entry states are valid workflow states", () => {
      for (const state of Object.values(SKIP_ENTRY_STATES)) {
        expect(isValidState(state)).toBe(true);
      }
    });

    it("only has two entries (plan-of-plans and plan)", () => {
      expect(Object.keys(SKIP_ENTRY_STATES)).toHaveLength(2);
    });
  });

  describe("full lifecycle simulations", () => {
    it("epic lifecycle: Ready for Plan → Plan in Progress → In Progress", () => {
      expect(resolveState("__LOCK__", "ralph_plan_epic").resolvedState).toBe(
        "Plan in Progress",
      );
      expect(
        resolveState("__COMPLETE__", "ralph_plan_epic").resolvedState,
      ).toBe("In Progress");
    });

    it("feature lifecycle: Ready for Plan → Plan in Progress → Plan in Review → In Progress", () => {
      expect(resolveState("__LOCK__", "ralph_plan").resolvedState).toBe(
        "Plan in Progress",
      );
      expect(resolveState("__COMPLETE__", "ralph_plan").resolvedState).toBe(
        "Plan in Review",
      );
      expect(resolveState("__COMPLETE__", "ralph_review").resolvedState).toBe(
        "In Progress",
      );
    });

    it("parent-planned atomic: In Progress → In Review → Done", () => {
      expect(resolveState("__LOCK__", "ralph_impl").resolvedState).toBe(
        "In Progress",
      );
      expect(resolveState("__COMPLETE__", "ralph_impl").resolvedState).toBe(
        "In Review",
      );
      expect(resolveState("__COMPLETE__", "ralph_merge").resolvedState).toBe(
        "Done",
      );
    });

    it("standalone atomic: full pipeline including research and planning", () => {
      expect(resolveState("__LOCK__", "ralph_research").resolvedState).toBe(
        "Research in Progress",
      );
      expect(
        resolveState("__COMPLETE__", "ralph_research").resolvedState,
      ).toBe("Ready for Plan");
      expect(resolveState("__LOCK__", "ralph_plan").resolvedState).toBe(
        "Plan in Progress",
      );
      expect(resolveState("__COMPLETE__", "ralph_plan").resolvedState).toBe(
        "Plan in Review",
      );
      expect(resolveState("__COMPLETE__", "ralph_review").resolvedState).toBe(
        "In Progress",
      );
      expect(resolveState("__LOCK__", "ralph_impl").resolvedState).toBe(
        "In Progress",
      );
      expect(resolveState("__COMPLETE__", "ralph_impl").resolvedState).toBe(
        "In Review",
      );
      expect(resolveState("__COMPLETE__", "ralph_merge").resolvedState).toBe(
        "Done",
      );
    });
  });

  describe("command registration", () => {
    it("ralph_plan_epic is a registered command", () => {
      expect(COMMAND_ALLOWED_STATES["ralph_plan_epic"]).toBeDefined();
    });

    it("ralph_plan_epic has exactly 3 allowed states", () => {
      expect(COMMAND_ALLOWED_STATES["ralph_plan_epic"]).toHaveLength(3);
      expect(COMMAND_ALLOWED_STATES["ralph_plan_epic"]).toContain(
        "Plan in Progress",
      );
      expect(COMMAND_ALLOWED_STATES["ralph_plan_epic"]).toContain(
        "In Progress",
      );
      expect(COMMAND_ALLOWED_STATES["ralph_plan_epic"]).toContain(
        "Human Needed",
      );
    });

    it("ralph_split has expanded allowed states", () => {
      expect(COMMAND_ALLOWED_STATES["ralph_split"]).toContain("Backlog");
      expect(COMMAND_ALLOWED_STATES["ralph_split"]).toContain("In Progress");
      expect(COMMAND_ALLOWED_STATES["ralph_split"]).toContain(
        "Ready for Plan",
      );
    });

    it("ralph_plan has In Progress in allowed states", () => {
      expect(COMMAND_ALLOWED_STATES["ralph_plan"]).toContain("In Progress");
    });
  });
});
