import { describe, it, expect } from "vitest";
import {
  STATE_ORDER,
  VALID_STATES,
  WORKFLOW_STATE_TO_STATUS,
  stateIndex,
  compareStates,
  isEarlierState,
  isValidState,
} from "../lib/workflow-states.js";

describe("stateIndex", () => {
  it("returns correct indices for all ordered states", () => {
    expect(stateIndex("Backlog")).toBe(0);
    expect(stateIndex("Research Needed")).toBe(1);
    expect(stateIndex("Research in Progress")).toBe(2);
    expect(stateIndex("Ready for Plan")).toBe(3);
    expect(stateIndex("Plan in Progress")).toBe(4);
    expect(stateIndex("Plan in Review")).toBe(5);
    expect(stateIndex("In Progress")).toBe(6);
    expect(stateIndex("In Review")).toBe(7);
    expect(stateIndex("Done")).toBe(8);
  });

  it("returns -1 for states not in the ordered pipeline", () => {
    expect(stateIndex("Human Needed")).toBe(-1);
    expect(stateIndex("Canceled")).toBe(-1);
    expect(stateIndex("unknown")).toBe(-1);
    expect(stateIndex("")).toBe(-1);
  });
});

describe("compareStates", () => {
  it("returns negative when first state is earlier", () => {
    expect(compareStates("Backlog", "Research Needed")).toBeLessThan(0);
    expect(compareStates("Research Needed", "Done")).toBeLessThan(0);
  });

  it("returns positive when first state is later", () => {
    expect(compareStates("Done", "Backlog")).toBeGreaterThan(0);
    expect(compareStates("In Progress", "Research Needed")).toBeGreaterThan(0);
  });

  it("returns 0 for equal states", () => {
    expect(compareStates("Backlog", "Backlog")).toBe(0);
    expect(compareStates("In Progress", "In Progress")).toBe(0);
  });
});

describe("isEarlierState", () => {
  it("returns true when first state is earlier in pipeline", () => {
    expect(isEarlierState("Backlog", "Research Needed")).toBe(true);
    expect(isEarlierState("Research Needed", "Ready for Plan")).toBe(true);
    expect(isEarlierState("Ready for Plan", "In Progress")).toBe(true);
    expect(isEarlierState("In Progress", "Done")).toBe(true);
  });

  it("returns false when first state is later or equal", () => {
    expect(isEarlierState("Done", "Backlog")).toBe(false);
    expect(isEarlierState("In Progress", "In Progress")).toBe(false);
    expect(isEarlierState("In Review", "Research Needed")).toBe(false);
  });

  it("returns false when either state is not in pipeline", () => {
    expect(isEarlierState("Human Needed", "Backlog")).toBe(false);
    expect(isEarlierState("Backlog", "Human Needed")).toBe(false);
    expect(isEarlierState("Canceled", "Done")).toBe(false);
  });
});

describe("isValidState", () => {
  it("recognizes all pipeline states as valid", () => {
    for (const state of STATE_ORDER) {
      expect(isValidState(state)).toBe(true);
    }
  });

  it("recognizes Human Needed and Canceled as valid", () => {
    expect(isValidState("Human Needed")).toBe(true);
    expect(isValidState("Canceled")).toBe(true);
  });

  it("rejects unknown states", () => {
    expect(isValidState("Foo")).toBe(false);
    expect(isValidState("")).toBe(false);
    expect(isValidState("In review")).toBe(false); // case-sensitive
  });
});

describe("VALID_STATES completeness", () => {
  it("contains all STATE_ORDER states plus Canceled and Human Needed", () => {
    for (const state of STATE_ORDER) {
      expect(VALID_STATES).toContain(state);
    }
    expect(VALID_STATES).toContain("Canceled");
    expect(VALID_STATES).toContain("Human Needed");
  });
});

describe("WORKFLOW_STATE_TO_STATUS", () => {
  it("maps all VALID_STATES to a Status value", () => {
    for (const state of VALID_STATES) {
      expect(WORKFLOW_STATE_TO_STATUS[state]).toBeDefined();
      expect(["Todo", "In Progress", "Done"]).toContain(
        WORKFLOW_STATE_TO_STATUS[state],
      );
    }
  });

  it("maps queue states to Todo", () => {
    expect(WORKFLOW_STATE_TO_STATUS["Backlog"]).toBe("Todo");
    expect(WORKFLOW_STATE_TO_STATUS["Research Needed"]).toBe("Todo");
    expect(WORKFLOW_STATE_TO_STATUS["Ready for Plan"]).toBe("Todo");
    expect(WORKFLOW_STATE_TO_STATUS["Plan in Review"]).toBe("Todo");
  });

  it("maps active states to In Progress", () => {
    expect(WORKFLOW_STATE_TO_STATUS["Research in Progress"]).toBe("In Progress");
    expect(WORKFLOW_STATE_TO_STATUS["Plan in Progress"]).toBe("In Progress");
    expect(WORKFLOW_STATE_TO_STATUS["In Progress"]).toBe("In Progress");
    expect(WORKFLOW_STATE_TO_STATUS["In Review"]).toBe("In Progress");
  });

  it("maps terminal states to Done", () => {
    expect(WORKFLOW_STATE_TO_STATUS["Done"]).toBe("Done");
    expect(WORKFLOW_STATE_TO_STATUS["Canceled"]).toBe("Done");
    expect(WORKFLOW_STATE_TO_STATUS["Human Needed"]).toBe("Done");
  });
});
