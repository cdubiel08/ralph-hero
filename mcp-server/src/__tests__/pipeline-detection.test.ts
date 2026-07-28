import { describe, it, expect } from "vitest";
import {
  detectPipelinePosition,
  type IssueState,
  type PipelinePhase,
  type DetectionOptions,
} from "../lib/pipeline-detection.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIssue(
  number: number,
  workflowState: string,
  estimate: string | null = "S",
  subIssueCount: number = 0,
): IssueState {
  return {
    number,
    title: `Issue #${number}`,
    workflowState,
    estimate,
    subIssueCount,
  };
}

function detectSingle(
  issue: IssueState,
  options?: DetectionOptions,
): ReturnType<typeof detectPipelinePosition> {
  return detectPipelinePosition([issue], false, issue.number, options);
}

function detectGroup(
  issues: IssueState[],
  options?: DetectionOptions,
): ReturnType<typeof detectPipelinePosition> {
  return detectPipelinePosition(issues, true, issues[0]?.number ?? null, options);
}

// ---------------------------------------------------------------------------
// Phase detection for all 7+ workflow states (single issue)
// ---------------------------------------------------------------------------

describe("detectPipelinePosition - single issue", () => {
  it("returns TRIAGE for Backlog XS/S issue", () => {
    const result = detectSingle(makeIssue(1, "Backlog"));
    expect(result.phase).toBe("TRIAGE");
  });

  it("returns SPLIT for Backlog M issue", () => {
    const result = detectSingle(makeIssue(1, "Backlog", "M"));
    expect(result.phase).toBe("SPLIT");
  });

  it("returns SPLIT for L estimate", () => {
    const result = detectSingle(makeIssue(1, "Backlog", "L"));
    expect(result.phase).toBe("SPLIT");
  });

  it("returns SPLIT for XL estimate", () => {
    const result = detectSingle(makeIssue(1, "Research Needed", "XL"));
    expect(result.phase).toBe("SPLIT");
  });

  it("returns RESEARCH for Research Needed", () => {
    const result = detectSingle(makeIssue(1, "Research Needed"));
    expect(result.phase).toBe("RESEARCH");
  });

  it("returns RESEARCH for Research in Progress", () => {
    const result = detectSingle(makeIssue(1, "Research in Progress"));
    expect(result.phase).toBe("RESEARCH");
  });

  it("returns PLAN for Ready for Plan", () => {
    const result = detectSingle(makeIssue(1, "Ready for Plan"));
    expect(result.phase).toBe("PLAN");
    expect(result.convergence.met).toBe(true);
  });

  it("returns REVIEW for Plan in Progress", () => {
    const result = detectSingle(makeIssue(1, "Plan in Progress"));
    expect(result.phase).toBe("REVIEW");
  });

  it("returns REVIEW for Plan in Review (decision-gated review is dispatchable)", () => {
    const result = detectSingle(makeIssue(1, "Plan in Review"));
    expect(result.phase).toBe("REVIEW");
  });

  it("returns IMPLEMENT for In Progress", () => {
    const result = detectSingle(makeIssue(1, "In Progress"));
    expect(result.phase).toBe("IMPLEMENT");
  });

  it("returns INTEGRATE for In Review", () => {
    const result = detectSingle(makeIssue(1, "In Review"));
    expect(result.phase).toBe("INTEGRATE");
  });

  it("returns COMPLETE for Done (report final status, not dead)", () => {
    const result = detectSingle(makeIssue(1, "Done"));
    expect(result.phase).toBe("COMPLETE");
  });

  it("returns TERMINAL for Canceled", () => {
    const result = detectSingle(makeIssue(1, "Canceled"));
    expect(result.phase).toBe("TERMINAL");
  });

  it("returns HUMAN_GATE for Human Needed (escalated, not dead)", () => {
    const result = detectSingle(makeIssue(1, "Human Needed"));
    expect(result.phase).toBe("HUMAN_GATE");
  });

  it("returns TRIAGE for unknown/missing workflow state", () => {
    const result = detectSingle(makeIssue(1, "unknown"));
    expect(result.phase).toBe("TRIAGE");
  });

  it("returns TRIAGE for empty workflow state", () => {
    const result = detectSingle(makeIssue(1, ""));
    expect(result.phase).toBe("TRIAGE");
  });
});

// ---------------------------------------------------------------------------
// Phase detection for groups (convergence logic)
// ---------------------------------------------------------------------------

describe("detectPipelinePosition - groups", () => {
  it("returns RESEARCH when some issues need research", () => {
    const result = detectGroup([
      makeIssue(1, "Research Needed"),
      makeIssue(2, "Ready for Plan"),
      makeIssue(3, "Research in Progress"),
    ]);
    expect(result.phase).toBe("RESEARCH");
    expect(result.convergence.met).toBe(false);
    expect(result.convergence.blocking).toHaveLength(2); // issues 1 and 3
  });

  it("returns PLAN when all issues are Ready for Plan (converged)", () => {
    const result = detectGroup([
      makeIssue(1, "Ready for Plan"),
      makeIssue(2, "Ready for Plan"),
      makeIssue(3, "Ready for Plan"),
    ]);
    expect(result.phase).toBe("PLAN");
    expect(result.convergence.met).toBe(true);
    expect(result.convergence.blocking).toHaveLength(0);
  });

  it("returns REVIEW when some plans in progress", () => {
    const result = detectGroup([
      makeIssue(1, "Plan in Progress"),
      makeIssue(2, "Plan in Review"),
    ]);
    expect(result.phase).toBe("REVIEW");
  });

  it("returns REVIEW when ALL plans in review (decision-gated, dispatchable)", () => {
    const result = detectGroup([
      makeIssue(1, "Plan in Review"),
      makeIssue(2, "Plan in Review"),
      makeIssue(3, "Plan in Review"),
    ]);
    expect(result.phase).toBe("REVIEW");
  });

  it("returns IMPLEMENT when some issues in progress", () => {
    const result = detectGroup([
      makeIssue(1, "In Progress"),
      makeIssue(2, "In Progress"),
    ]);
    expect(result.phase).toBe("IMPLEMENT");
  });

  it("returns INTEGRATE when group has In Review issues", () => {
    const result = detectGroup([
      makeIssue(1, "In Review"),
      makeIssue(2, "Done"),
      makeIssue(3, "In Review"),
    ]);
    expect(result.phase).toBe("INTEGRATE");
  });

  it("returns TERMINAL when mixed terminal + canceled", () => {
    const result = detectGroup([
      makeIssue(1, "Done"),
      makeIssue(2, "Canceled"),
    ]);
    expect(result.phase).toBe("TERMINAL");
  });

  it("returns SPLIT when any issue is oversized", () => {
    const result = detectGroup([
      makeIssue(1, "Research Needed", "S"),
      makeIssue(2, "Research Needed", "M"),
    ]);
    expect(result.phase).toBe("SPLIT");
    expect(result.reason).toContain("#2=M");
  });

  it("mixed In Progress + Human Needed stays IMPLEMENT (In Progress has priority)", () => {
    const result = detectGroup([
      makeIssue(1, "In Progress"),
      makeIssue(2, "Human Needed"),
    ]);
    // Step 8 (In Progress -> IMPLEMENT) precedes step 10 (Human Needed ->
    // HUMAN_GATE), so active work wins over the escalation.
    expect(result.phase).toBe("IMPLEMENT");
  });

  it("returns HUMAN_GATE for pure Human Needed group", () => {
    const result = detectGroup([
      makeIssue(1, "Human Needed"),
      makeIssue(2, "Human Needed"),
    ]);
    expect(result.phase).toBe("HUMAN_GATE");
  });

  it("returns COMPLETE for pure Done group", () => {
    const result = detectGroup([
      makeIssue(1, "Done"),
      makeIssue(2, "Done"),
    ]);
    expect(result.phase).toBe("COMPLETE");
  });
});

// ---------------------------------------------------------------------------
// Remaining phases
// ---------------------------------------------------------------------------

describe("detectPipelinePosition - remaining phases", () => {
  it("SPLIT has full pipeline remaining", () => {
    const result = detectSingle(makeIssue(1, "Backlog", "M"));
    expect(result.remainingPhases).toEqual([
      "split",
      "triage",
      "research",
      "plan",
      "review",
      "implement",
      "pr",
    ]);
  });

  it("RESEARCH has research through pr remaining", () => {
    const result = detectSingle(makeIssue(1, "Research Needed"));
    expect(result.remainingPhases).toEqual([
      "research",
      "plan",
      "review",
      "implement",
      "pr",
    ]);
  });

  it("PLAN has plan through pr remaining", () => {
    const result = detectSingle(makeIssue(1, "Ready for Plan"));
    expect(result.remainingPhases).toEqual([
      "plan",
      "review",
      "implement",
      "pr",
    ]);
  });

  it("IMPLEMENT has implement and pr remaining", () => {
    const result = detectSingle(makeIssue(1, "In Progress"));
    expect(result.remainingPhases).toEqual(["implement", "pr"]);
  });

  it("COMPLETE has no remaining phases", () => {
    const result = detectSingle(makeIssue(1, "Done"));
    expect(result.remainingPhases).toEqual([]);
  });

  it("TERMINAL has no remaining phases", () => {
    const result = detectSingle(makeIssue(1, "Canceled"));
    expect(result.remainingPhases).toEqual([]);
  });

  it("HUMAN_GATE (Human Needed) has no remaining phases", () => {
    const result = detectSingle(makeIssue(1, "Human Needed"));
    expect(result.remainingPhases).toEqual([]);
  });

  it("REVIEW (Plan in Review) has review/implement/pr remaining", () => {
    const result = detectSingle(makeIssue(1, "Plan in Review"));
    expect(result.remainingPhases).toEqual(["review", "implement", "pr"]);
  });
});

// ---------------------------------------------------------------------------
// Group metadata
// ---------------------------------------------------------------------------

describe("detectPipelinePosition - metadata", () => {
  it("single issue: isGroup=false, groupPrimary set", () => {
    const result = detectSingle(makeIssue(42, "Backlog"));
    expect(result.isGroup).toBe(false);
    expect(result.groupPrimary).toBe(42);
  });

  it("group: isGroup=true, groupPrimary is first issue", () => {
    const result = detectGroup([
      makeIssue(10, "Research Needed"),
      makeIssue(20, "Research Needed"),
    ]);
    expect(result.isGroup).toBe(true);
    expect(result.groupPrimary).toBe(10);
  });

  it("includes all issues in the response", () => {
    const issues = [
      makeIssue(1, "Research Needed"),
      makeIssue(2, "Ready for Plan"),
    ];
    const result = detectGroup(issues);
    expect(result.issues).toHaveLength(2);
    expect(result.issues[0].number).toBe(1);
    expect(result.issues[1].number).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("detectPipelinePosition - edge cases", () => {
  it("empty issue list returns TRIAGE", () => {
    const result = detectPipelinePosition([], false, null);
    expect(result.phase).toBe("TRIAGE");
    expect(result.reason).toContain("No issues");
  });

  it("null estimate is treated as not oversized", () => {
    const result = detectSingle(makeIssue(1, "Backlog", null));
    expect(result.phase).toBe("TRIAGE"); // Not SPLIT
  });

  it("XS estimate is not oversized", () => {
    const result = detectSingle(makeIssue(1, "Backlog", "XS"));
    expect(result.phase).toBe("TRIAGE"); // Not SPLIT
  });

  it("Ready for Plan mixed with later states returns PLAN with blocking info", () => {
    const result = detectGroup([
      makeIssue(1, "Ready for Plan"),
      makeIssue(2, "In Progress"),
    ]);
    // In Progress takes priority over Ready for Plan in mixed state
    expect(result.phase).toBe("IMPLEMENT");
  });
});

// ---------------------------------------------------------------------------
// Sub-issue count: skip SPLIT for already-split issues
// ---------------------------------------------------------------------------

describe("detectPipelinePosition - sub-issue count (SPLIT skip)", () => {
  it("M issue with children should NOT trigger SPLIT", () => {
    const result = detectSingle(makeIssue(1, "Backlog", "M", 3));
    expect(result.phase).not.toBe("SPLIT");
    expect(result.phase).toBe("TRIAGE"); // Falls through to Backlog check
  });

  it("M issue without children should trigger SPLIT", () => {
    const result = detectSingle(makeIssue(1, "Backlog", "M", 0));
    expect(result.phase).toBe("SPLIT");
  });

  it("L issue with children should NOT trigger SPLIT", () => {
    const result = detectSingle(makeIssue(1, "Backlog", "L", 2));
    expect(result.phase).not.toBe("SPLIT");
  });

  it("XL issue with children should NOT trigger SPLIT", () => {
    const result = detectSingle(makeIssue(1, "Backlog", "XL", 1));
    expect(result.phase).not.toBe("SPLIT");
  });

  it("mixed group: some M issues already split, some not", () => {
    const result = detectGroup([
      makeIssue(1, "Backlog", "M", 3),  // already split
      makeIssue(2, "Backlog", "M", 0),  // needs splitting
    ]);
    expect(result.phase).toBe("SPLIT");
    expect(result.reason).toContain("#2=M");
    expect(result.reason).not.toContain("#1=M");
  });

  it("all M issues already split: no SPLIT phase", () => {
    const result = detectGroup([
      makeIssue(1, "Backlog", "M", 3),
      makeIssue(2, "Backlog", "L", 2),
    ]);
    expect(result.phase).not.toBe("SPLIT");
    expect(result.phase).toBe("TRIAGE"); // Falls through to Backlog check
  });

  it("S issue with children: subIssueCount is irrelevant (not oversized)", () => {
    const result = detectSingle(makeIssue(1, "Backlog", "S", 5));
    expect(result.phase).toBe("TRIAGE"); // S is not oversized, so SPLIT never fires
  });
});

// ---------------------------------------------------------------------------
// Workflow-state guard: SPLIT only fires in pre-plan states (GH-1546).
// The state-blind check misfired live on issue #1544: an M issue in
// Plan in Review with an approved plan attached was told to split.
// ---------------------------------------------------------------------------

describe("detectPipelinePosition - SPLIT state guard", () => {
  it("M issue in Plan in Review is REVIEW, not SPLIT", () => {
    const result = detectSingle(makeIssue(1, "Plan in Review", "M", 0));
    expect(result.phase).toBe("REVIEW");
  });

  it("M issue in Plan in Progress is REVIEW, not SPLIT", () => {
    const result = detectSingle(makeIssue(1, "Plan in Progress", "M", 0));
    expect(result.phase).toBe("REVIEW");
  });

  it("L issue in In Progress is IMPLEMENT, not SPLIT", () => {
    const result = detectSingle(makeIssue(1, "In Progress", "L", 0));
    expect(result.phase).toBe("IMPLEMENT");
  });

  it("XL issue in In Review is INTEGRATE, not SPLIT", () => {
    const result = detectSingle(makeIssue(1, "In Review", "XL", 0));
    expect(result.phase).toBe("INTEGRATE");
  });

  it("M issue in Human Needed is HUMAN_GATE, not SPLIT", () => {
    const result = detectSingle(makeIssue(1, "Human Needed", "M", 0));
    expect(result.phase).toBe("HUMAN_GATE");
  });

  it("M issue in Ready for Plan still SPLITs (pre-plan state)", () => {
    const result = detectSingle(makeIssue(1, "Ready for Plan", "M", 0));
    expect(result.phase).toBe("SPLIT");
  });

  it("M issue with no workflow state still SPLITs (split precedes triage)", () => {
    const result = detectSingle(makeIssue(1, "unknown", "M", 0));
    expect(result.phase).toBe("SPLIT");
  });

  it("group: M in Plan in Review does not drag group to SPLIT", () => {
    const result = detectGroup([
      makeIssue(1, "Plan in Review", "M", 0),
      makeIssue(2, "Plan in Review", "S", 0),
    ]);
    expect(result.phase).toBe("REVIEW");
  });
});

// ---------------------------------------------------------------------------
// Auto mode (RALPH_HERO_AUTO): INTEGRATE phase
// ---------------------------------------------------------------------------

describe("detectPipelinePosition - auto mode (RALPH_HERO_AUTO)", () => {
  const auto: DetectionOptions = { autoMode: true };

  it("returns INTEGRATE for In Review (single issue)", () => {
    const result = detectSingle(makeIssue(1, "In Review"), auto);
    expect(result.phase).toBe("INTEGRATE");
    expect(result.remainingPhases).toEqual(["integrate"]);
  });

  it("returns INTEGRATE for group with all In Review", () => {
    const result = detectGroup([
      makeIssue(1, "In Review"),
      makeIssue(2, "In Review"),
    ], auto);
    expect(result.phase).toBe("INTEGRATE");
  });

  it("returns INTEGRATE for mixed In Review + Done (some still need integration)", () => {
    const result = detectGroup([
      makeIssue(1, "In Review"),
      makeIssue(2, "Done"),
    ], auto);
    expect(result.phase).toBe("INTEGRATE");
  });

  it("returns COMPLETE for all Done even in auto mode", () => {
    const result = detectGroup([
      makeIssue(1, "Done"),
      makeIssue(2, "Done"),
    ], auto);
    expect(result.phase).toBe("COMPLETE");
  });

  it("returns TERMINAL for Done + Canceled (no In Review) in auto mode", () => {
    const result = detectGroup([
      makeIssue(1, "Done"),
      makeIssue(2, "Canceled"),
    ], auto);
    expect(result.phase).toBe("TERMINAL");
  });

  it("In Review returns INTEGRATE regardless of autoMode", () => {
    const result = detectSingle(makeIssue(1, "In Review"));
    expect(result.phase).toBe("INTEGRATE");
  });

  it("INTEGRATE roster is integrator-only", () => {
    const result = detectSingle(makeIssue(1, "In Review"), auto);
    expect(result.suggestedRoster).toEqual({ analyst: 0, builder: 0, integrator: 1 });
  });

  it("TERMINAL roster is empty (no workers needed)", () => {
    const result = detectSingle(makeIssue(1, "Done"));
    expect(result.suggestedRoster).toEqual({ analyst: 0, builder: 0, integrator: 0 });
  });
});

// ---------------------------------------------------------------------------
// Stream-based builder scaling
// ---------------------------------------------------------------------------

describe("stream-based builder scaling", () => {
  it("no stream context (single-issue path) -> builder = 1 (fallback)", () => {
    const result = detectSingle(makeIssue(1, "Research Needed"));
    expect(result.suggestedRoster.builder).toBe(1);
  });
});
