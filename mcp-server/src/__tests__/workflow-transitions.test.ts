/**
 * Pure-predicate matrix for the GH-1615 transition-legality layer:
 * `isLegalTransition`, `legalNextStates`, and `isLegalParentGateAdvance`
 * from `workflow-states.ts`. No mocking — these are pure functions.
 *
 * Spec baseline: ports the allow/block matrix from the (now-deleted)
 * `state-gate.test.sh` shell suite plus the release-edge and universal-edge
 * additions from the GH-1592 group plan's Design Decisions.
 */

import { describe, it, expect } from "vitest";
import {
  isLegalTransition,
  legalNextStates,
  isLegalParentGateAdvance,
  ALLOWED_TRANSITIONS,
  STATE_ORDER,
  TERMINAL_STATES,
  LOCK_STATES,
  PARENT_GATE_STATES,
} from "../lib/workflow-states.js";

// ---------------------------------------------------------------------------
// Every JSON edge is legal (spot-checked across all eleven states)
// ---------------------------------------------------------------------------

describe("isLegalTransition — every ALLOWED_TRANSITIONS edge is legal", () => {
  for (const [current, targets] of Object.entries(ALLOWED_TRANSITIONS)) {
    for (const target of targets) {
      it(`"${current}" -> "${target}" is legal`, () => {
        expect(isLegalTransition(current, target)).toBe(true);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Gate-skip refusals (the core invariant this feature adds)
// ---------------------------------------------------------------------------

describe("isLegalTransition — gate-skip refusals", () => {
  it("Backlog -> In Progress is illegal (skips Research/Ready-for-Plan/Plan gates)", () => {
    expect(isLegalTransition("Backlog", "In Progress")).toBe(false);
  });

  it("Research Needed -> In Review is illegal", () => {
    expect(isLegalTransition("Research Needed", "In Review")).toBe(false);
  });

  it("Ready for Plan -> In Review is illegal", () => {
    expect(isLegalTransition("Ready for Plan", "In Review")).toBe(false);
  });

  it("Backlog -> Plan in Progress is illegal (the live plan/SKILL.md --mode epic finding)", () => {
    expect(isLegalTransition("Backlog", "Plan in Progress")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Release edges (Design Decision a)
// ---------------------------------------------------------------------------

describe("isLegalTransition — release edges", () => {
  it("Research in Progress -> Research Needed is legal (stale-lock reclamation)", () => {
    expect(isLegalTransition("Research in Progress", "Research Needed")).toBe(true);
  });

  it("Plan in Progress -> Ready for Plan is legal (stale-lock reclamation)", () => {
    expect(isLegalTransition("Plan in Progress", "Ready for Plan")).toBe(true);
  });

  it("In Progress -> Ready for Plan is ILLEGAL — no release edge for In Progress (no-rollback asymmetry)", () => {
    expect(isLegalTransition("In Progress", "Ready for Plan")).toBe(false);
  });

  it("In Progress has no backward release edge to any pre-lock queue state", () => {
    expect(ALLOWED_TRANSITIONS["In Progress"]).not.toContain("Ready for Plan");
    expect(ALLOWED_TRANSITIONS["In Progress"]).not.toContain("Plan in Review");
  });
});

// ---------------------------------------------------------------------------
// Universal edges (Design Decision b): every non-terminal state -> Human
// Needed / Done / Canceled
// ---------------------------------------------------------------------------

describe("isLegalTransition — universal escalation/terminal edges", () => {
  const nonTerminal = STATE_ORDER.filter((s) => !TERMINAL_STATES.includes(s)).concat("Human Needed");

  for (const state of nonTerminal) {
    it(`"${state}" -> "Human Needed" is legal`, () => {
      expect(isLegalTransition(state, "Human Needed")).toBe(true);
    });
    it(`"${state}" -> "Done" is legal`, () => {
      expect(isLegalTransition(state, "Done")).toBe(true);
    });
    it(`"${state}" -> "Canceled" is legal`, () => {
      expect(isLegalTransition(state, "Canceled")).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Named additions (c), (d), (e)
// ---------------------------------------------------------------------------

describe("isLegalTransition — named additions", () => {
  it("(c) Ready for Plan -> In Progress is legal (parent-plan-reuse fast path)", () => {
    expect(isLegalTransition("Ready for Plan", "In Progress")).toBe(true);
  });

  it("(d) Research Needed -> Backlog is legal (ralph_split __COMPLETE__ re-queue)", () => {
    expect(isLegalTransition("Research Needed", "Backlog")).toBe(true);
  });

  it("(e) Plan in Review -> Plan in Progress is legal (NEEDS_ITERATION re-lock)", () => {
    expect(isLegalTransition("Plan in Review", "Plan in Progress")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Terminal states have no outbound edges
// ---------------------------------------------------------------------------

describe("isLegalTransition — Done/Canceled have no outbound edges", () => {
  const allStates = [...STATE_ORDER, "Canceled", "Human Needed"];

  for (const target of allStates) {
    if (target === "Done") continue; // same-state, covered separately
    it(`"Done" -> "${target}" is illegal`, () => {
      expect(isLegalTransition("Done", target)).toBe(false);
    });
  }
  for (const target of allStates) {
    if (target === "Canceled") continue;
    it(`"Canceled" -> "${target}" is illegal`, () => {
      expect(isLegalTransition("Canceled", target)).toBe(false);
    });
  }

  it("Done -> Canceled cross-terminal re-classification is illegal (needs force)", () => {
    expect(isLegalTransition("Done", "Canceled")).toBe(false);
  });
  it("Canceled -> Done cross-terminal re-classification is illegal (needs force)", () => {
    expect(isLegalTransition("Canceled", "Done")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Same-state and undefined/empty current
// ---------------------------------------------------------------------------

describe("isLegalTransition — idempotency and unset current", () => {
  it("same-state is always legal, including for terminal states", () => {
    expect(isLegalTransition("Done", "Done")).toBe(true);
    expect(isLegalTransition("Canceled", "Canceled")).toBe(true);
    expect(isLegalTransition("Backlog", "Backlog")).toBe(true);
  });

  it("undefined current is always legal (new/stateless item)", () => {
    expect(isLegalTransition(undefined, "In Review")).toBe(true);
    expect(isLegalTransition(undefined, "Done")).toBe(true);
  });

  it("null current is always legal (query succeeded, no value on item)", () => {
    expect(isLegalTransition(null, "Ready for Plan")).toBe(true);
  });

  it("empty-string current is always legal", () => {
    expect(isLegalTransition("", "In Progress")).toBe(true);
  });

  it("an unknown current state (not in ALLOWED_TRANSITIONS) is illegal unless same-state", () => {
    expect(isLegalTransition("Some Bogus State", "Backlog")).toBe(false);
    expect(isLegalTransition("Some Bogus State", "Some Bogus State")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// legalNextStates
// ---------------------------------------------------------------------------

describe("legalNextStates", () => {
  it("returns the configured edges for a known state", () => {
    expect(legalNextStates("Backlog")).toEqual(ALLOWED_TRANSITIONS["Backlog"]);
  });

  it("returns an empty array for terminal states", () => {
    expect(legalNextStates("Done")).toEqual([]);
    expect(legalNextStates("Canceled")).toEqual([]);
  });

  it("returns an empty array for an unknown state", () => {
    expect(legalNextStates("Not A Real State")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// isLegalParentGateAdvance
// ---------------------------------------------------------------------------

describe("isLegalParentGateAdvance", () => {
  it("refuses an unresolvable (undefined) current state", () => {
    expect(isLegalParentGateAdvance(undefined, "Ready for Plan")).toEqual({
      ok: false,
      reason: "parent state unresolvable",
    });
  });

  it("refuses a null current state (query succeeded, no value)", () => {
    expect(isLegalParentGateAdvance(null, "Ready for Plan")).toEqual({
      ok: false,
      reason: "parent state unresolvable",
    });
  });

  it("refuses an empty-string current state", () => {
    expect(isLegalParentGateAdvance("", "Ready for Plan")).toEqual({
      ok: false,
      reason: "parent state unresolvable",
    });
  });

  it("refuses when the parent is escalated (Human Needed)", () => {
    expect(isLegalParentGateAdvance("Human Needed", "In Review")).toEqual({
      ok: false,
      reason: "parent is escalated",
    });
  });

  it("refuses when the parent is terminal (Done)", () => {
    expect(isLegalParentGateAdvance("Done", "In Review")).toEqual({
      ok: false,
      reason: "parent is terminal",
    });
  });

  it("refuses when the parent is terminal (Canceled)", () => {
    expect(isLegalParentGateAdvance("Canceled", "In Review")).toEqual({
      ok: false,
      reason: "parent is terminal",
    });
  });

  for (const lockState of LOCK_STATES) {
    it(`refuses when the parent holds a live lock state (${lockState})`, () => {
      const gate = PARENT_GATE_STATES.find((g) => g !== lockState) ?? "In Review";
      expect(isLegalParentGateAdvance(lockState, gate)).toEqual({
        ok: false,
        reason: "parent is locked by an active claim",
      });
    });
  }

  it("refuses when the target is not a gate state", () => {
    expect(isLegalParentGateAdvance("Backlog", "Research in Progress")).toEqual({
      ok: false,
      reason: "not a gate state",
    });
  });

  it("refuses when the parent is already at or past the gate", () => {
    expect(isLegalParentGateAdvance("In Review", "Ready for Plan")).toEqual({
      ok: false,
      reason: "already at or past",
    });
    expect(isLegalParentGateAdvance("Done", "Done")).toEqual({
      // Done is caught by the terminal check first, not "already at or past"
      ok: false,
      reason: "parent is terminal",
    });
  });

  it("ALLOWS a multi-hop forward gate jump (Backlog -> In Review, all children at In Review)", () => {
    expect(isLegalParentGateAdvance("Backlog", "In Review")).toEqual({ ok: true });
  });

  it("ALLOWS Backlog -> Ready for Plan", () => {
    expect(isLegalParentGateAdvance("Backlog", "Ready for Plan")).toEqual({ ok: true });
  });

  it("ALLOWS Research Needed -> Plan in Review", () => {
    expect(isLegalParentGateAdvance("Research Needed", "Plan in Review")).toEqual({ ok: true });
  });

  it("ALLOWS a parent to advance to Done from In Review", () => {
    expect(isLegalParentGateAdvance("In Review", "Done")).toEqual({ ok: true });
  });
});
