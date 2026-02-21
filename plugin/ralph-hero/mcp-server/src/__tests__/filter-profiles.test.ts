import { describe, it, expect } from "vitest";
import {
  expandProfile,
  FILTER_PROFILES,
  VALID_PROFILE_NAMES,
} from "../lib/filter-profiles.js";
import { VALID_STATES } from "../lib/workflow-states.js";

describe("FILTER_PROFILES", () => {
  it("contains exactly 6 profiles", () => {
    expect(Object.keys(FILTER_PROFILES)).toHaveLength(6);
  });

  it("analyst-triage filters to Backlog", () => {
    expect(FILTER_PROFILES["analyst-triage"]).toEqual({
      workflowState: "Backlog",
    });
  });

  it("analyst-research filters to Research Needed", () => {
    expect(FILTER_PROFILES["analyst-research"]).toEqual({
      workflowState: "Research Needed",
    });
  });

  it("builder-active filters to In Progress", () => {
    expect(FILTER_PROFILES["builder-active"]).toEqual({
      workflowState: "In Progress",
    });
  });

  it("builder-planned filters to Plan in Review", () => {
    expect(FILTER_PROFILES["builder-planned"]).toEqual({
      workflowState: "Plan in Review",
    });
  });

  it("validator-review filters to Plan in Review", () => {
    expect(FILTER_PROFILES["validator-review"]).toEqual({
      workflowState: "Plan in Review",
    });
  });

  it("integrator-merge filters to In Review", () => {
    expect(FILTER_PROFILES["integrator-merge"]).toEqual({
      workflowState: "In Review",
    });
  });

  it("all profile workflowState values are valid workflow states", () => {
    for (const [name, params] of Object.entries(FILTER_PROFILES)) {
      if (params.workflowState) {
        expect(
          VALID_STATES.includes(params.workflowState),
          `Profile "${name}" has invalid workflowState "${params.workflowState}"`,
        ).toBe(true);
      }
    }
  });
});

describe("VALID_PROFILE_NAMES", () => {
  it("contains all 6 expected profile names", () => {
    expect(VALID_PROFILE_NAMES).toEqual(
      expect.arrayContaining([
        "analyst-triage",
        "analyst-research",
        "builder-active",
        "builder-planned",
        "validator-review",
        "integrator-merge",
      ]),
    );
    expect(VALID_PROFILE_NAMES).toHaveLength(6);
  });
});

describe("expandProfile", () => {
  it("returns filter params for a valid profile", () => {
    const result = expandProfile("analyst-triage");
    expect(result).toEqual({ workflowState: "Backlog" });
  });

  it("returns a copy, not the original reference", () => {
    const a = expandProfile("builder-active");
    const b = expandProfile("builder-active");
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    // Mutating the copy does not affect the registry
    a.workflowState = "modified";
    expect(FILTER_PROFILES["builder-active"].workflowState).toBe(
      "In Progress",
    );
  });

  it("throws for unknown profile name with recovery guidance", () => {
    expect(() => expandProfile("nonexistent")).toThrow(
      /Unknown filter profile "nonexistent"/,
    );
    expect(() => expandProfile("nonexistent")).toThrow(/Valid profiles:/);
    expect(() => expandProfile("nonexistent")).toThrow(/Recovery:/);
  });

  it("error message lists all valid profile names", () => {
    try {
      expandProfile("bad-name");
    } catch (e) {
      const msg = (e as Error).message;
      for (const name of VALID_PROFILE_NAMES) {
        expect(msg).toContain(name);
      }
    }
  });
});
