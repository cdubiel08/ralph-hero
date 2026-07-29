/**
 * Pipeline position detection logic.
 *
 * Determines the current workflow phase for an issue or group of issues
 * based on their workflow states and estimates. Replaces the prose
 * decision tables in orchestrator SKILL.md files.
 */

import { LOCK_STATES, TERMINAL_STATES } from "./workflow-states.js";

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
  | "INTEGRATE"
  | "COMPLETE"
  | "HUMAN_GATE"
  | "TERMINAL";

export interface DetectionOptions {
  /** Reserved for future use (In Review now always maps to INTEGRATE) */
  autoMode?: boolean;
  /** Total number of independent work streams (drives builder scaling) */
  streamCount?: number;
}

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
  builder: number;    // 1-3: 1 per independent stream, capped at 3; falls back to 1 when no stream data
  integrator: number; // 1-2: 1 default; 2 if 5+ issues
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
  INTEGRATE: ["integrate"],
  COMPLETE: [],
  HUMAN_GATE: [],
  TERMINAL: [],
};

// ---------------------------------------------------------------------------
// Split eligibility
// ---------------------------------------------------------------------------

/**
 * States in which an oversized estimate still warrants decomposition.
 * Once planning has begun (Plan in Progress and beyond), an M/L/XL
 * estimate no longer routes to SPLIT — the plan is the unit of work and
 * the state-based phase wins. GH-1546: the previous state-blind check
 * sent an M issue sitting in Plan in Review (approved plan attached)
 * back to decomposition.
 */
const SPLIT_ELIGIBLE_STATES: ReadonlySet<string> = new Set([
  "Backlog",
  "Research Needed",
  "Research in Progress",
  "Ready for Plan",
]);

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
 * 1. Any M/L/XL estimates in a pre-plan state -> SPLIT
 * 2. Any issues without workflow state -> TRIAGE
 * 3. Any issues in Research Needed or Research in Progress -> RESEARCH
 * 4. All issues in Ready for Plan -> PLAN (convergence met)
 * 5. Mixed with some Ready for Plan and some earlier -> RESEARCH (convergence not met)
 * 6. Any issues in Plan in Progress -> REVIEW (plans still being written)
 * 7. Any issues in Plan in Review -> REVIEW (dispatch plan review; the
 *    gate is decision-driven per GH-1544 — no state-level human gate)
 * 8. Any issues in In Progress -> IMPLEMENT
 * 9. Any issues in In Review (with rest Done/Canceled) -> INTEGRATE
 * 9b. All Done -> COMPLETE; any Canceled among all-terminal -> TERMINAL
 * 10. Any issues in Human Needed -> HUMAN_GATE (escalated; hero stops)
 * 11. Fallback -> TRIAGE
 */
export function detectPipelinePosition(
  issues: IssueState[],
  isGroup: boolean,
  groupPrimary: number | null,
  options: DetectionOptions = {},
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
      options.streamCount,
    );
  }

  // Step 1: Check for oversized issues needing split (skip already-split
  // issues AND issues already past the planning threshold — an oversized
  // estimate discovered mid-flight falls through to the state-based phase).
  const oversized = issues.filter(
    (i) =>
      i.estimate !== null &&
      OVERSIZED_ESTIMATES.has(i.estimate) &&
      i.subIssueCount === 0 &&
      (!i.workflowState ||
        i.workflowState === "unknown" ||
        SPLIT_ELIGIBLE_STATES.has(i.workflowState)),
  );
  if (oversized.length > 0) {
    return buildResult(
      "SPLIT",
      `${oversized.length} issue(s) need splitting (estimate: ${oversized.map((i) => `#${i.number}=${i.estimate}`).join(", ")})`,
      issues,
      isGroup,
      groupPrimary,
      { required: false, met: true, blocking: [] },
      options.streamCount,
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
      options.streamCount,
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
      options.streamCount,
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
      options.streamCount,
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
      options.streamCount,
    );
  }

  // Step 7: Any issues in Plan in Review (none in Plan in Progress) -> REVIEW.
  // Under decision-gated approval (GH-1544) the plan-review gate is
  // dispatchable by default (RALPH_REVIEW_PLAN=auto): decision-free plans
  // auto-advance; held plans re-emit PLAN AWAITING DECISION idempotently.
  // "Awaiting human approval" is no longer a state-level fact, so this is
  // REVIEW — HUMAN_GATE is reserved for Human Needed (step 10).
  if (planInReview.length > 0) {
    return buildResult(
      "REVIEW",
      `${planInReview.length} plan(s) in review — dispatch plan review`,
      issues,
      isGroup,
      groupPrimary,
      { required: false, met: true, blocking: [] },
      options.streamCount,
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
      options.streamCount,
    );
  }

  // Step 9: All issues in In Review, Done, or Canceled
  const completed = inReview.length + done.length + canceled.length;
  if (completed === issues.length) {
    // "In Review" = PRs awaiting review/merge — actionable, not terminal
    if (inReview.length > 0) {
      return buildResult(
        "INTEGRATE",
        `${inReview.length} issue(s) in review`,
        issues,
        isGroup,
        groupPrimary,
        { required: false, met: true, blocking: [] },
        options.streamCount,
      );
    }
    // All Done (no Canceled) -> COMPLETE (report final status).
    // Any Canceled present -> TERMINAL (dead/skip).
    if (done.length === issues.length) {
      return buildResult(
        "COMPLETE",
        `All ${done.length} issue(s) done`,
        issues,
        isGroup,
        groupPrimary,
        { required: false, met: true, blocking: [] },
        options.streamCount,
      );
    }
    return buildResult(
      "TERMINAL",
      `All issues done or canceled (${done.length} done, ${canceled.length} canceled)`,
      issues,
      isGroup,
      groupPrimary,
      { required: false, met: true, blocking: [] },
      options.streamCount,
    );
  }

  // Step 10: Any issues in Human Needed -> HUMAN_GATE (escalated, waiting
  // on the human; hero STOPs and reports the blocker). TERMINAL is for
  // dead work, not escalated work.
  if (humanNeeded.length > 0) {
    return buildResult(
      "HUMAN_GATE",
      `${humanNeeded.length} issue(s) in Human Needed — human required`,
      issues,
      isGroup,
      groupPrimary,
      { required: false, met: true, blocking: [] },
      options.streamCount,
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
      options.streamCount,
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
      options.streamCount,
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
    options.streamCount,
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeSuggestedRoster(
  phase: PipelinePhase,
  issues: IssueState[],
  streamCount?: number,
): SuggestedRoster {
  // TERMINAL / COMPLETE / HUMAN_GATE: no workers needed (dead, done, or
  // waiting on the human)
  if (phase === 'TERMINAL' || phase === 'COMPLETE' || phase === 'HUMAN_GATE') {
    return { analyst: 0, builder: 0, integrator: 0 };
  }
  // INTEGRATE: only integrator needed
  if (phase === 'INTEGRATE') {
    return { analyst: 0, builder: 0, integrator: 1 };
  }

  // Phase-aware: if past research, analyst = 0
  const needsResearch = issues.filter(i =>
    ['Research Needed', 'Research in Progress'].includes(i.workflowState)
  );
  let analyst = 0;
  if (phase === 'RESEARCH' || phase === 'SPLIT' || phase === 'TRIAGE' || phase === 'PLAN') {
    analyst = needsResearch.length <= 1 ? 1
      : needsResearch.length <= 5 ? 2
      : 3;
  }

  // Builder scaling: 1 per independent stream, capped at 3
  const builder = Math.min(streamCount || 1, 3);

  const integrator = issues.length >= 5 ? 2 : 1;

  return { analyst, builder, integrator };
}

function buildResult(
  phase: PipelinePhase,
  reason: string,
  issues: IssueState[],
  isGroup: boolean,
  groupPrimary: number | null,
  convergence: Omit<ConvergenceInfo, "recommendation">,
  streamCount?: number,
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

  const suggestedRoster = computeSuggestedRoster(phase, issues, streamCount);
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
