/**
 * Unit tests for the isLockConflict pure function.
 *
 * These tests verify that the server-side lock guard correctly identifies
 * conflicting lock-state transitions without making any GitHub API calls.
 */

import { describe, it, expect } from "vitest";
import { isLockConflict } from "../lib/lock-guard.js";
import { LOCK_STATES } from "../lib/workflow-states.js";

describe("isLockConflict", () => {
  // -------------------------------------------------------------------------
  // Conflict cases — should return true
  // -------------------------------------------------------------------------

  it("returns true when current is Research in Progress and target is Plan in Progress", () => {
    expect(isLockConflict("Research in Progress", "Plan in Progress")).toBe(true);
  });

  it("returns true when current is In Progress and target is In Progress (same lock re-claim)", () => {
    expect(isLockConflict("In Progress", "In Progress")).toBe(true);
  });

  it("returns true when current is Plan in Progress and target is Research in Progress", () => {
    expect(isLockConflict("Plan in Progress", "Research in Progress")).toBe(true);
  });

  it("returns true for all lock-to-lock combinations (parametric)", () => {
    for (const current of LOCK_STATES) {
      for (const target of LOCK_STATES) {
        expect(
          isLockConflict(current, target),
          `expected conflict: current="${current}", target="${target}"`,
        ).toBe(true);
      }
    }
  });

  // -------------------------------------------------------------------------
  // Allow cases — should return false
  // -------------------------------------------------------------------------

  it("returns false when currentState is undefined (unknown state allows claim)", () => {
    expect(isLockConflict(undefined, "In Progress")).toBe(false);
  });

  it("returns false when currentState is empty string (empty state allows claim)", () => {
    expect(isLockConflict("", "In Progress")).toBe(false);
  });

  it("returns false when currentState is Research Needed (non-locked allows acquisition)", () => {
    expect(isLockConflict("Research Needed", "Research in Progress")).toBe(false);
  });

  it("returns false when currentState is Ready for Plan (non-locked allows acquisition)", () => {
    expect(isLockConflict("Ready for Plan", "Plan in Progress")).toBe(false);
  });

  it("returns false when targetState is Ready for Plan (non-lock target bypasses guard)", () => {
    expect(isLockConflict("Research in Progress", "Ready for Plan")).toBe(false);
  });

  it("returns false when targetState is Done (non-lock target bypasses guard)", () => {
    expect(isLockConflict("In Progress", "Done")).toBe(false);
  });

  it("returns false when currentState is Backlog and target is Research in Progress", () => {
    expect(isLockConflict("Backlog", "Research in Progress")).toBe(false);
  });

  it("returns false when currentState is In Review and target is Done (both non-conflicts)", () => {
    expect(isLockConflict("In Review", "Done")).toBe(false);
  });

  it("returns false when currentState is Canceled and target is In Progress", () => {
    expect(isLockConflict("Canceled", "In Progress")).toBe(false);
  });
});
