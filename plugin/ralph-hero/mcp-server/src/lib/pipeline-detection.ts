/**
 * Pipeline position detection logic.
 *
 * Determines the current workflow phase for an issue or group of issues
 * based on their workflow states and estimates. Replaces the prose
 * decision tables in orchestrator SKILL.md files.
 */

import { LOCK_STATES, TERMINAL_STATES } from "./workflow-states.js";
import type { WorkStream } from "./work-stream-detection.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PipelinePhase =
  | "SPLIT"
  | "TRIAGE"
  | "RESEARCH"
  | "PLAN"
  | "REVIEW"
  | "IMPLEMENT"
  | "COMPLETE"
  | "HUMAN_GATE"
  | "TERMINAL";

export interface IssueState {
  number: number;
  title: string;
  workflowState: string;
  estimate: string | null;
  subIssueCount: number;
}

export interface ConvergenceInfo {
  required: boolean;
  met: boolean;
  blocking: Array<{ number: number; state: string }>;
  recommendation: "proceed" | "wait" | "escalate";
}

export interface SuggestedRoster {
  analyst: number;    // 0-3: 1 for single issue; 2 for 2-5 needing research; 3 for 6+
  builder: number;    // 1-2: 1 default; 2 if 5+ issues with M/L estimates
  validator: number;  // always 1
  integrator: number; // always 1
}

export interface PipelinePosition {
  phase: PipelinePhase;
  reason: string;
  remainingPhases: string[];
  issues: IssueState[];
  convergence: ConvergenceInfo;
  isGroup: boolean;
  groupPrimary: number | null;
  suggestedRoster: SuggestedRoster;
}

export interface StreamPipelineResult {
  streamId: string;
  issues: IssueState[];
  position: PipelinePosition;
}

// ---------------------------------------------------------------------------
// Phase-to-remaining mapping
// ---------------------------------------------------------------------------

const REMAINING_PHASES: Record<PipelinePhase, string[]> = {
  SPLIT: ["split", "triage", "research", "plan", "review", "implement", "pr"],
  TRIAGE: ["triage", "research", "plan", "review", "implement", "pr"],
  RESEARCH: ["research", "plan", "review", "implement", "pr"],
  PLAN: ["plan", "review", "implement", "pr"],
  REVIEW: ["review", "implement", "pr"],
  IMPLEMENT: ["implement", "pr"],
  COMPLETE: ["pr"],
  HUMAN_GATE: [],
  TERMINAL: [],
};

// ---------------------------------------------------------------------------
// Oversized estimate detection
// ---------------------------------------------------------------------------

export const OVERSIZED_ESTIMATES = new Set(["M", "L", "XL"]);

// ---------------------------------------------------------------------------
// Detection logic
// ---------------------------------------------------------------------------

/**
 * Detect the pipeline position for a set of issues.
 *
 * The logic follows this priority order (first match wins):
 * 1. Any M/L/XL estimates -> SPLIT
 * 2. Any issues without workflow state -> TRIAGE
 * 3. Any issues in Research Needed or Research in Progress -> RESEARCH
 * 4. All issues in Ready for Plan -> PLAN (convergence met)
 * 5. Mixed with some Ready for Plan and some earlier -> RESEARCH (convergence not met)
 * 6. Any issues in Plan in Progress or Plan in Review -> REVIEW
 * 7. All issues in Plan in Review -> HUMAN_GATE (plans awaiting human approval)
 * 8. Any issues in In Progress -> IMPLEMENT
 * 9. All issues in In Review/Done -> TERMINAL
 * 10. Any issues in Human Needed -> TERMINAL (need human)
 * 11. Fallback -> TRIAGE
 *
 * Note: The HUMAN_GATE check (step 7) comes AFTER the general REVIEW check
 * (step 6) to handle the case where some plans are still in progress while
 * others are in review. When ALL plans are in review (none in progress),
 * that's when we hit the HUMAN_GATE. This addresses the ordering bug noted
 * in the plan critique.
 */
export function detectPipelinePosition(
  issues: IssueState[],
  isGroup: boolean,
  groupPrimary: number | null,
): PipelinePosition {
  if (issues.length === 0) {
    return buildResult(
      "TRIAGE",
      "No issues provided",
      issues,
      isGroup,
      groupPrimary,
      {
        required: false,
        met: true,
        blocking: [],
      },
    );
  }

  // Step 1: Check for oversized issues needing split (skip already-split issues)
  const oversized = issues.filter(
    (i) => i.estimate !== null && OVERSIZED_ESTIMATES.has(i.estimate) && i.subIssueCount === 0,
  );
  if (oversized.length > 0) {
    return buildResult(
      "SPLIT",
      `${oversized.length} issue(s) need splitting (estimate: ${oversized.map((i) => `#${i.number}=${i.estimate}`).join(", ")})`,
      issues,
      isGroup,
      groupPrimary,
      { required: false, met: true, blocking: [] },
    );
  }

  // Step 2: Check for issues without workflow state
  const noState = issues.filter(
    (i) => !i.workflowState || i.workflowState === "unknown",
  );
  if (noState.length > 0) {
    return buildResult(
      "TRIAGE",
      `${noState.length} issue(s) have no workflow state; triage first`,
      issues,
      isGroup,
      groupPrimary,
      { required: false, met: true, blocking: [] },
    );
  }

  // Categorize issues by state
  const needsResearch = issues.filter(
    (i) => i.workflowState === "Research Needed",
  );
  const inResearch = issues.filter(
    (i) => i.workflowState === "Research in Progress",
  );
  const readyForPlan = issues.filter(
    (i) => i.workflowState === "Ready for Plan",
  );
  const planInProgress = issues.filter(
    (i) => i.workflowState === "Plan in Progress",
  );
  const planInReview = issues.filter(
    (i) => i.workflowState === "Plan in Review",
  );
  const inProgress = issues.filter((i) => i.workflowState === "In Progress");
  const inReview = issues.filter((i) => i.workflowState === "In Review");
  const done = issues.filter((i) => i.workflowState === "Done");
  const canceled = issues.filter((i) => i.workflowState === "Canceled");
  const humanNeeded = issues.filter((i) => i.workflowState === "Human Needed");
  const backlog = issues.filter((i) => i.workflowState === "Backlog");

  // Step 3: Any issues needing or in research -> RESEARCH
  if (needsResearch.length > 0 || inResearch.length > 0) {
    const convergence = {
      required: isGroup,
      met: false as const,
      blocking: [
        ...needsResearch.map((i) => ({
          number: i.number,
          state: i.workflowState,
        })),
        ...inResearch.map((i) => ({
          number: i.number,
          state: i.workflowState,
        })),
      ],
    };
    return buildResult(
      "RESEARCH",
      `${needsResearch.length} need research, ${inResearch.length} in progress`,
      issues,
      isGroup,
      groupPrimary,
      convergence,
    );
  }

  // Step 4: All issues in Ready for Plan -> PLAN (convergence met)
  if (readyForPlan.length === issues.length) {
    return buildResult(
      "PLAN",
      "All issues ready for planning",
      issues,
      isGroup,
      groupPrimary,
      { required: isGroup, met: true, blocking: [] },
    );
  }

  // Step 5: Some Ready for Plan but not all (mixed with earlier states) -> still need earlier work
  // This is handled by the checks above (research, backlog) and below (plan in progress/review)

  // Step 6: Any issues in Plan in Progress -> REVIEW (plans still being written)
  // If some are in Plan in Progress and some in Plan in Review, we're still in REVIEW phase
  if (planInProgress.length > 0) {
    return buildResult(
      "REVIEW",
      `${planInProgress.length} plan(s) in progress, ${planInReview.length} in review`,
      issues,
      isGroup,
      groupPrimary,
      { required: false, met: true, blocking: [] },
    );
  }

  // Step 7: All issues in Plan in Review -> HUMAN_GATE (all plans awaiting approval)
  if (planInReview.length === issues.length) {
    return buildResult(
      "HUMAN_GATE",
      "All plans awaiting human approval",
      issues,
      isGroup,
      groupPrimary,
      { required: false, met: true, blocking: [] },
    );
  }

  // Some in Plan in Review (but not all, and none in Plan in Progress) -> REVIEW
  if (planInReview.length > 0) {
    return buildResult(
      "REVIEW",
      `${planInReview.length} plan(s) in review`,
      issues,
      isGroup,
      groupPrimary,
      { required: false, met: true, blocking: [] },
    );
  }

  // Step 8: Any issues in In Progress -> IMPLEMENT
  if (inProgress.length > 0) {
    return buildResult(
      "IMPLEMENT",
      `${inProgress.length} issue(s) in progress`,
      issues,
      isGroup,
      groupPrimary,
      { required: false, met: true, blocking: [] },
    );
  }

  // Step 9: All issues terminal (In Review or Done or Canceled) -> TERMINAL
  const terminal = inReview.length + done.length + canceled.length;
  if (terminal === issues.length) {
    return buildResult(
      "TERMINAL",
      "All issues in review or done",
      issues,
      isGroup,
      groupPrimary,
      { required: false, met: true, blocking: [] },
    );
  }

  // Step 10: Any issues need human intervention -> TERMINAL
  if (humanNeeded.length > 0) {
    return buildResult(
      "TERMINAL",
      `${humanNeeded.length} issue(s) need human intervention`,
      issues,
      isGroup,
      groupPrimary,
      { required: false, met: true, blocking: [] },
    );
  }

  // Step 11: Backlog issues -> TRIAGE
  if (backlog.length > 0) {
    return buildResult(
      "TRIAGE",
      `${backlog.length} issue(s) in Backlog`,
      issues,
      isGroup,
      groupPrimary,
      { required: false, met: true, blocking: [] },
    );
  }

  // Step 12: Mixed states - default to earliest incomplete phase
  // Check Ready for Plan mixed with later states
  if (readyForPlan.length > 0) {
    const blocking = issues
      .filter((i) => i.workflowState !== "Ready for Plan")
      .map((i) => ({ number: i.number, state: i.workflowState }));
    return buildResult(
      "PLAN",
      "Some issues ready for planning, mixed states",
      issues,
      isGroup,
      groupPrimary,
      { required: isGroup, met: false, blocking },
    );
  }

  // Fallback
  return buildResult(
    "TRIAGE",
    "Mixed states, defaulting to triage",
    issues,
    isGroup,
    groupPrimary,
    { required: false, met: true, blocking: [] },
  );
}

// ---------------------------------------------------------------------------
// Stream-level detection
// ---------------------------------------------------------------------------

export function detectStreamPipelinePositions(
  streams: WorkStream[],
  issueStates: IssueState[],
): StreamPipelineResult[] {
  const stateByNumber = new Map<number, IssueState>();
  for (const state of issueStates) {
    stateByNumber.set(state.number, state);
  }

  return streams.map((stream) => {
    const filteredIssues = stream.issues
      .map((num) => stateByNumber.get(num))
      .filter((s): s is IssueState => s !== undefined);
    const isGroup = filteredIssues.length > 1;
    const groupPrimary = stream.primaryIssue;

    return {
      streamId: stream.id,
      issues: filteredIssues,
      position: detectPipelinePosition(filteredIssues, isGroup, groupPrimary),
    };
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeSuggestedRoster(
  phase: PipelinePhase,
  issues: IssueState[],
): SuggestedRoster {
  // Phase-aware: if past research, analyst = 0
  const needsResearch = issues.filter(i =>
    ['Research Needed', 'Research in Progress'].includes(i.workflowState)
  );
  let analyst = 0;
  if (phase === 'RESEARCH' || phase === 'SPLIT' || phase === 'TRIAGE') {
    analyst = needsResearch.length <= 1 ? 1
      : needsResearch.length <= 5 ? 2
      : 3;
  }

  // Builder scaling: default 1; 2 if 5+ issues with M/L estimates
  const largeSized = issues.filter(i =>
    i.estimate != null && ['M', 'L', 'XL'].includes(i.estimate)
  );
  const builder = largeSized.length >= 5 ? 2 : 1;

  return { analyst, builder, validator: 1, integrator: 1 };
}

function buildResult(
  phase: PipelinePhase,
  reason: string,
  issues: IssueState[],
  isGroup: boolean,
  groupPrimary: number | null,
  convergence: Omit<ConvergenceInfo, "recommendation">,
): PipelinePosition {
  // Derive recommendation from convergence state
  let recommendation: ConvergenceInfo["recommendation"];
  if (convergence.met) {
    recommendation = "proceed";
  } else if (convergence.blocking.some((b) => b.state === "Human Needed")) {
    recommendation = "escalate";
  } else {
    recommendation = "wait";
  }

  const suggestedRoster = computeSuggestedRoster(phase, issues);
  return {
    phase,
    reason,
    remainingPhases: REMAINING_PHASES[phase],
    issues,
    convergence: { ...convergence, recommendation },
    isGroup,
    groupPrimary,
    suggestedRoster,
  };
}
