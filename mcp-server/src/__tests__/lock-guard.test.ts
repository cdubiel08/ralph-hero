/**
 * Unit tests for the isLockConflict pure function.
 *
 * These tests verify that the server-side lock guard correctly identifies
 * conflicting lock-state transitions without making any GitHub API calls.
 */

import { describe, it, expect } from "vitest";
import {
  isLockConflict,
  isGuardedLockRelease,
  isHeldSinceStale,
  describeLockConflict,
  describeGuardedRelease,
  LOCK_RELEASE_TARGET,
} from "../lib/lock-guard.js";
import { LOCK_STATES } from "../lib/workflow-states.js";

describe("isLockConflict", () => {
  // -------------------------------------------------------------------------
  // Conflict cases — should return true
  // -------------------------------------------------------------------------

  it("returns true when current is Research in Progress and target is Plan in Progress", () => {
    expect(isLockConflict("Research in Progress", "Plan in Progress")).toBe(true);
  });

  it("returns true when current is Plan in Progress and target is Research in Progress", () => {
    expect(isLockConflict("Plan in Progress", "Research in Progress")).toBe(true);
  });

  it("returns true for all cross-lock combinations (parametric)", () => {
    for (const current of LOCK_STATES) {
      for (const target of LOCK_STATES) {
        if (current !== target) {
          expect(
            isLockConflict(current, target),
            `expected conflict: current="${current}", target="${target}"`,
          ).toBe(true);
        }
      }
    }
  });

  // -------------------------------------------------------------------------
  // Same-state idempotency — should return false (re-claim is safe)
  // -------------------------------------------------------------------------

  it("returns false when current and target are both In Progress (idempotent re-claim)", () => {
    expect(isLockConflict("In Progress", "In Progress")).toBe(false);
  });

  it("returns false when current and target are both Research in Progress (idempotent re-claim)", () => {
    expect(isLockConflict("Research in Progress", "Research in Progress")).toBe(false);
  });

  it("returns false when current and target are both Plan in Progress (idempotent re-claim)", () => {
    expect(isLockConflict("Plan in Progress", "Plan in Progress")).toBe(false);
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

// ---------------------------------------------------------------------------
// isGuardedLockRelease (GH-1616 §4b — closes the two-call takeover)
// ---------------------------------------------------------------------------

describe("isGuardedLockRelease", () => {
  it("guards Research in Progress -> Research Needed", () => {
    expect(isGuardedLockRelease("Research in Progress", "Research Needed")).toBe(true);
  });

  it("guards Plan in Progress -> Ready for Plan", () => {
    expect(isGuardedLockRelease("Plan in Progress", "Ready for Plan")).toBe(true);
  });

  it("does NOT guard the completion exit Research in Progress -> Ready for Plan", () => {
    expect(isGuardedLockRelease("Research in Progress", "Ready for Plan")).toBe(false);
  });

  it("does NOT guard completion exits from Plan in Progress (-> Plan in Review / In Progress)", () => {
    expect(isGuardedLockRelease("Plan in Progress", "Plan in Review")).toBe(false);
    expect(isGuardedLockRelease("Plan in Progress", "In Progress")).toBe(false);
  });

  it("does NOT guard escalation exits (any lock state -> Human Needed)", () => {
    for (const state of LOCK_STATES) {
      expect(isGuardedLockRelease(state, "Human Needed")).toBe(false);
    }
  });

  it("does NOT guard terminal exits (any lock state -> Done / Canceled)", () => {
    for (const state of LOCK_STATES) {
      expect(isGuardedLockRelease(state, "Done")).toBe(false);
      expect(isGuardedLockRelease(state, "Canceled")).toBe(false);
    }
  });

  it("does NOT guard In Progress at all — there is no release edge for it", () => {
    expect(isGuardedLockRelease("In Progress", "Ready for Plan")).toBe(false);
    expect(isGuardedLockRelease("In Progress", "Research Needed")).toBe(false);
    expect(LOCK_RELEASE_TARGET["In Progress"]).toBeUndefined();
  });

  it("returns false when current is not a lock state", () => {
    expect(isGuardedLockRelease("Backlog", "Research Needed")).toBe(false);
    expect(isGuardedLockRelease(undefined, "Research Needed")).toBe(false);
  });

  it("returns false for a same-state write (not a release, a re-claim)", () => {
    expect(isGuardedLockRelease("Research in Progress", "Research in Progress")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isHeldSinceStale
// ---------------------------------------------------------------------------

describe("isHeldSinceStale", () => {
  const NOW = new Date("2026-07-26T12:00:00Z");

  it("returns true when heldSince is older than the threshold", () => {
    const heldSince = new Date(NOW.getTime() - 25 * 60 * 60 * 1000).toISOString();
    expect(isHeldSinceStale(heldSince, 24, NOW)).toBe(true);
  });

  it("returns false when heldSince is within the threshold", () => {
    const heldSince = new Date(NOW.getTime() - 5 * 60 * 60 * 1000).toISOString();
    expect(isHeldSinceStale(heldSince, 24, NOW)).toBe(false);
  });

  it("returns false when heldSince is exactly at the boundary minus epsilon", () => {
    const heldSince = new Date(NOW.getTime() - 23.99 * 60 * 60 * 1000).toISOString();
    expect(isHeldSinceStale(heldSince, 24, NOW)).toBe(false);
  });

  it("returns false (fail closed on releasing) when heldSince is undefined", () => {
    expect(isHeldSinceStale(undefined, 24, NOW)).toBe(false);
  });

  it("returns false when heldSince is unparseable", () => {
    expect(isHeldSinceStale("not-a-date", 24, NOW)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// describeLockConflict — message shape (GH-1616)
// ---------------------------------------------------------------------------

describe("describeLockConflict", () => {
  const NOW = new Date("2026-07-26T12:00:00Z");

  it("names the issue, current state, holder, and claim time", () => {
    const msg = describeLockConflict(
      1615, "Plan in Progress", "In Progress", "other-agent", "2026-07-25T12:00:00Z", NOW,
    );
    expect(msg).toContain("Issue #1615");
    expect(msg).toContain('"Plan in Progress"');
    expect(msg).toContain("@other-agent");
    expect(msg).toContain("2026-07-25T12:00:00Z");
    expect(msg).toContain("force=true");
  });

  it("degrades gracefully when holder is unavailable", () => {
    const msg = describeLockConflict(1615, "Plan in Progress", "In Progress", undefined, "2026-07-25T12:00:00Z", NOW);
    expect(msg).toContain("unknown");
  });

  it("degrades gracefully when heldSince is unavailable", () => {
    const msg = describeLockConflict(1615, "Plan in Progress", "In Progress", "other-agent", undefined, NOW);
    expect(msg).toContain("an unknown time");
  });

  it("does not present a bare release-then-claim recipe as the recovery", () => {
    const msg = describeLockConflict(1615, "Research in Progress", "Plan in Progress", "other-agent", "2026-07-25T12:00:00Z", NOW);
    // The release hint must name the gate (stale threshold or force), not a
    // bare "just call save_issue twice" recipe.
    expect(msg).toContain("stale threshold");
    expect(msg).toContain("force=true");
  });

  it("names the correct release edge per lock state", () => {
    const researchMsg = describeLockConflict(1, "Research in Progress", "In Progress", undefined, undefined, NOW);
    expect(researchMsg).toContain('"Research Needed"');
    const planMsg = describeLockConflict(2, "Plan in Progress", "In Progress", undefined, undefined, NOW);
    expect(planMsg).toContain('"Ready for Plan"');
  });

  it("notes there is no release edge for In Progress", () => {
    const msg = describeLockConflict(3, "In Progress", "Plan in Progress", undefined, undefined, NOW);
    expect(msg).toContain("no release edge");
  });
});

// ---------------------------------------------------------------------------
// describeGuardedRelease — message shape (GH-1616 §4b)
// ---------------------------------------------------------------------------

describe("describeGuardedRelease", () => {
  const NOW = new Date("2026-07-26T12:00:00Z");

  it("names the issue, current state, target, held-since, and threshold", () => {
    const msg = describeGuardedRelease(
      1615, "Research in Progress", "Research Needed", "2026-07-25T12:00:00Z", 24, NOW,
    );
    expect(msg).toContain("Issue #1615");
    expect(msg).toContain('"Research in Progress"');
    expect(msg).toContain('"Research Needed"');
    expect(msg).toContain("2026-07-25T12:00:00Z");
    expect(msg).toContain("24h");
    expect(msg).toContain("force=true");
  });

  it("degrades gracefully when heldSince is unavailable", () => {
    const msg = describeGuardedRelease(1615, "Plan in Progress", "Ready for Plan", undefined, 24, NOW);
    expect(msg).toContain("an unknown time");
  });
});
