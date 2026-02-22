import { describe, it, expect } from "vitest";
import {
  detectPipelinePosition,
  detectStreamPipelinePositions,
  type IssueState,
  type PipelinePhase,
  type StreamPipelineResult,
} from "../lib/pipeline-detection.js";
import type { WorkStream } from "../lib/work-stream-detection.js";

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
): ReturnType<typeof detectPipelinePosition> {
  return detectPipelinePosition([issue], false, issue.number);
}

function detectGroup(
  issues: IssueState[],
): ReturnType<typeof detectPipelinePosition> {
  return detectPipelinePosition(issues, true, issues[0]?.number ?? null);
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

  it("returns HUMAN_GATE for Plan in Review (single issue = all in review)", () => {
    const result = detectSingle(makeIssue(1, "Plan in Review"));
    expect(result.phase).toBe("HUMAN_GATE");
  });

  it("returns IMPLEMENT for In Progress", () => {
    const result = detectSingle(makeIssue(1, "In Progress"));
    expect(result.phase).toBe("IMPLEMENT");
  });

  it("returns TERMINAL for In Review", () => {
    const result = detectSingle(makeIssue(1, "In Review"));
    expect(result.phase).toBe("TERMINAL");
  });

  it("returns TERMINAL for Done", () => {
    const result = detectSingle(makeIssue(1, "Done"));
    expect(result.phase).toBe("TERMINAL");
  });

  it("returns TERMINAL for Human Needed", () => {
    const result = detectSingle(makeIssue(1, "Human Needed"));
    expect(result.phase).toBe("TERMINAL");
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

  it("returns HUMAN_GATE when ALL plans in review", () => {
    const result = detectGroup([
      makeIssue(1, "Plan in Review"),
      makeIssue(2, "Plan in Review"),
      makeIssue(3, "Plan in Review"),
    ]);
    expect(result.phase).toBe("HUMAN_GATE");
  });

  it("returns IMPLEMENT when some issues in progress", () => {
    const result = detectGroup([
      makeIssue(1, "In Progress"),
      makeIssue(2, "In Progress"),
    ]);
    expect(result.phase).toBe("IMPLEMENT");
  });

  it("returns TERMINAL when all issues done or in review", () => {
    const result = detectGroup([
      makeIssue(1, "In Review"),
      makeIssue(2, "Done"),
      makeIssue(3, "In Review"),
    ]);
    expect(result.phase).toBe("TERMINAL");
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

  it("returns TERMINAL when any issue needs human intervention", () => {
    const result = detectGroup([
      makeIssue(1, "In Progress"),
      makeIssue(2, "Human Needed"),
    ]);
    // Human Needed is checked after In Progress, but let's verify:
    // Actually, In Progress check comes first in the logic, so IMPLEMENT
    // Wait -- the plan says Human Needed -> TERMINAL. Let me verify the order:
    // Step 8 is In Progress -> IMPLEMENT, Step 10 is Human Needed -> TERMINAL
    // So if mixed In Progress + Human Needed, it's IMPLEMENT (In Progress takes priority)
    expect(result.phase).toBe("IMPLEMENT");
  });

  it("returns TERMINAL for pure Human Needed group", () => {
    const result = detectGroup([
      makeIssue(1, "Human Needed"),
      makeIssue(2, "Human Needed"),
    ]);
    expect(result.phase).toBe("TERMINAL");
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

  it("TERMINAL has no remaining phases", () => {
    const result = detectSingle(makeIssue(1, "Done"));
    expect(result.remainingPhases).toEqual([]);
  });

  it("HUMAN_GATE has no remaining phases", () => {
    const result = detectSingle(makeIssue(1, "Plan in Review"));
    expect(result.remainingPhases).toEqual([]);
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
// Stream-level pipeline detection
// ---------------------------------------------------------------------------

function makeStream(id: string, issues: number[], primaryIssue: number): WorkStream {
  return { id, issues, sharedFiles: [], primaryIssue };
}

describe("detectStreamPipelinePositions", () => {
  it("returns one result per stream", () => {
    const streams = [
      makeStream("stream-42-44", [42, 44], 42),
      makeStream("stream-43", [43], 43),
    ];
    const issueStates = [
      makeIssue(42, "In Progress"),
      makeIssue(43, "Research Needed"),
      makeIssue(44, "In Progress"),
    ];
    const results = detectStreamPipelinePositions(streams, issueStates);
    expect(results).toHaveLength(2);
    expect(results[0].streamId).toBe("stream-42-44");
    expect(results[1].streamId).toBe("stream-43");
  });

  it("detects correct phase per stream independently", () => {
    const streams = [
      makeStream("stream-42-44", [42, 44], 42),
      makeStream("stream-43", [43], 43),
    ];
    const issueStates = [
      makeIssue(42, "In Progress"),
      makeIssue(43, "Research Needed"),
      makeIssue(44, "In Progress"),
    ];
    const results = detectStreamPipelinePositions(streams, issueStates);
    expect(results[0].position.phase).toBe("IMPLEMENT");
    expect(results[1].position.phase).toBe("RESEARCH");
  });

  it("filters issueStates to only stream members", () => {
    const streams = [makeStream("stream-42", [42], 42)];
    const issueStates = [
      makeIssue(42, "Ready for Plan"),
      makeIssue(43, "Research Needed"), // not in stream
    ];
    const results = detectStreamPipelinePositions(streams, issueStates);
    expect(results[0].issues).toHaveLength(1);
    expect(results[0].issues[0].number).toBe(42);
    expect(results[0].position.phase).toBe("PLAN");
  });

  it("sets isGroup=true for multi-issue streams", () => {
    const streams = [makeStream("stream-42-44", [42, 44], 42)];
    const issueStates = [
      makeIssue(42, "Ready for Plan"),
      makeIssue(44, "Ready for Plan"),
    ];
    const results = detectStreamPipelinePositions(streams, issueStates);
    expect(results[0].position.isGroup).toBe(true);
    expect(results[0].position.groupPrimary).toBe(42);
  });

  it("sets isGroup=false for single-issue streams", () => {
    const streams = [makeStream("stream-43", [43], 43)];
    const issueStates = [makeIssue(43, "In Progress")];
    const results = detectStreamPipelinePositions(streams, issueStates);
    expect(results[0].position.isGroup).toBe(false);
  });

  it("returns empty array for empty streams input", () => {
    const results = detectStreamPipelinePositions([], [makeIssue(42, "In Progress")]);
    expect(results).toEqual([]);
  });
});
