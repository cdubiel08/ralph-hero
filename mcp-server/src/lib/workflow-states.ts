/**
 * Workflow state ordering and helpers for pipeline detection.
 *
 * Hardcoded from ralph-state-machine.json. The state order defines
 * the canonical progression through the workflow pipeline.
 */

/**
 * Canonical ordering of workflow states from earliest to latest.
 * Used to determine relative position of issues in the pipeline.
 */
export const STATE_ORDER: readonly string[] = [
  "Backlog",
  "Research Needed",
  "Research in Progress",
  "Ready for Plan",
  "Plan in Progress",
  "Plan in Review",
  "In Progress",
  "In Review",
  "Done",
] as const;

/**
 * Terminal states that indicate no further workflow progression.
 */
export const TERMINAL_STATES: readonly string[] = ["Done", "Canceled"] as const;

/**
 * Lock states that indicate exclusive ownership.
 */
export const LOCK_STATES: readonly string[] = [
  "Research in Progress",
  "Plan in Progress",
  "In Progress",
] as const;

/**
 * States requiring human intervention.
 *
 * "Plan in Review" was removed in GH-1546: under decision-gated approval
 * (GH-1544) plan review runs autonomously by default and decision-free
 * plans auto-advance, so Plan-in-Review dwell is no longer human-gated —
 * prolonged dwell there now indicates review never ran or a decision hold
 * the human is ignoring, which stuck-detection SHOULD surface. Held-plan
 * status is a comment-level signal (## Decision Request), not a state.
 */
export const HUMAN_STATES: readonly string[] = [
  "Human Needed",
] as const;

/**
 * Gate states that trigger parent advancement when ALL children reach them.
 * Intermediate "in progress" states should NOT advance the parent.
 */
export const PARENT_GATE_STATES: readonly string[] = [
  "Ready for Plan",
  "Plan in Review",
  "In Review",
  "Done",
] as const;

/**
 * Check if a state is a parent advancement gate.
 */
export function isParentGateState(state: string): boolean {
  return PARENT_GATE_STATES.includes(state);
}

/**
 * Valid workflow states for the project (all known states).
 */
export const VALID_STATES: readonly string[] = [
  ...STATE_ORDER,
  "Canceled",
  "Human Needed",
] as const;

/**
 * Get the ordinal index of a state in the pipeline.
 * Returns -1 if the state is not in the ordered pipeline
 * (e.g., "Human Needed", "Canceled").
 */
export function stateIndex(state: string): number {
  return STATE_ORDER.indexOf(state);
}

/**
 * Compare two states by their pipeline position.
 * Returns negative if a comes before b, positive if after, 0 if equal.
 * States not in STATE_ORDER (Human Needed, Canceled) are treated as -1.
 */
export function compareStates(a: string, b: string): number {
  return stateIndex(a) - stateIndex(b);
}

/**
 * Check if state `a` is earlier in the pipeline than state `b`.
 * Both states must be in STATE_ORDER for a meaningful comparison.
 */
export function isEarlierState(a: string, b: string): boolean {
  const idxA = stateIndex(a);
  const idxB = stateIndex(b);
  if (idxA === -1 || idxB === -1) return false;
  return idxA < idxB;
}

/**
 * Validate that a state name is a known workflow state.
 */
export function isValidState(state: string): boolean {
  return VALID_STATES.includes(state);
}

/**
 * Maps Ralph Workflow States to GitHub's default Status field values.
 * Used for one-way sync: Workflow State changes -> Status field updates.
 *
 * Rationale:
 * - Todo = work not yet actively started (queued states)
 * - In Progress = work actively being processed (lock states + review)
 * - Done = terminal/escalated states (no automated progression)
 */
/**
 * Maps parent plan document type to the entry state for children
 * created by ralph_split from that plan.
 *
 * When a parent issue has a plan-of-plans, its feature children
 * skip to "Ready for Plan" (they need their own detailed plan).
 *
 * When a parent issue has an implementation plan, its atomic children
 * skip to "In Progress" (the plan already covers their implementation).
 */
export const SKIP_ENTRY_STATES: Record<string, string> = {
  "plan-of-plans": "Ready for Plan",
  "plan": "In Progress",
};

export const WORKFLOW_STATE_TO_STATUS: Record<string, string> = {
  "Backlog": "Todo",
  "Research Needed": "Todo",
  "Ready for Plan": "Todo",
  "Plan in Review": "Todo",
  "Research in Progress": "In Progress",
  "Plan in Progress": "In Progress",
  "In Progress": "In Progress",
  "In Review": "In Progress",
  "Done": "Done",
  "Canceled": "Done",
  "Human Needed": "Todo",
};

/**
 * Reverse-inference map (GH-1471): when a save_issue call closes the GitHub
 * issue but provides no explicit workflowState, infer the matching terminal
 * board state. Keyed by `CLOSED:${stateReason ?? ""}` to mirror the lookup in
 * issue-tools.ts. This is the symmetric inverse of the forward auto-close path.
 *
 * - CLOSED:COMPLETED   → Done     (issue closed as completed)
 * - CLOSED:NOT_PLANNED → Canceled (issue closed as not planned)
 * - CLOSED:            → Done     (close with no stateReason defaults to Done)
 *
 * An explicit workflowState always wins — the caller only consults this map
 * when args.workflowState is undefined.
 */
export const ISSUE_STATE_TO_TERMINAL_WORKFLOW: Record<string, string> = {
  "CLOSED:COMPLETED": "Done",
  "CLOSED:NOT_PLANNED": "Canceled",
  "CLOSED:": "Done",
};

/**
 * Server-side transition legality table (GH-1615).
 *
 * Base edges are ported verbatim from `ralph-state-machine.json`'s
 * `states.*.allowed_transitions`. Additions on top of the JSON (each with
 * its consuming caller, per the GH-1592 group plan's Design Decisions):
 *
 * - Release edges (a): `Research in Progress -> Research Needed` and
 *   `Plan in Progress -> Ready for Plan` — required by #1617 stale-lock
 *   reclamation and by `lock-release-on-failure.sh`'s crashed-agent advice.
 *   Deliberately NO `In Progress -> Ready for Plan` release edge (preserves
 *   the no-rollback-on-impl-failure asymmetry).
 * - Universal edges (b): every non-terminal state can reach
 *   `Human Needed` / `Done` / `Canceled` — mirrors the
 *   `__ESCALATE__`/`__CLOSE__`/`__CANCEL__` wildcard intents, the auto-close
 *   path, and the reverse-inference path (issue-tools.ts).
 * - (c) `Ready for Plan -> In Progress` — parent-plan-reuse fast path
 *   (`intake-routing.md`) and `ralph_plan`'s existing allowlist.
 * - (d) `Research Needed -> Backlog` — `ralph_split` `__COMPLETE__` re-queue.
 * - (e) `Plan in Review -> Plan in Progress` — NEEDS_ITERATION re-lock
 *   (fixes the live `plan/SKILL.md` mismatch).
 *
 * Kept in lockstep with `ralph/hooks/scripts/ralph-state-machine.json` by
 * the two-way parity test in `state-resolution.test.ts`.
 */
export const ALLOWED_TRANSITIONS: Record<string, readonly string[]> = {
  "Backlog": ["Research Needed", "Ready for Plan", "Done", "Canceled", "Human Needed"],
  "Research Needed": ["Research in Progress", "Ready for Plan", "Human Needed", "Backlog", "Done", "Canceled"],
  "Research in Progress": ["Ready for Plan", "Human Needed", "Research Needed", "Done", "Canceled"],
  "Ready for Plan": ["Plan in Progress", "Human Needed", "In Progress", "Done", "Canceled"],
  "Plan in Progress": ["Plan in Review", "In Progress", "Human Needed", "Ready for Plan", "Done", "Canceled"],
  "Plan in Review": ["In Progress", "Ready for Plan", "Human Needed", "Plan in Progress", "Done", "Canceled"],
  "In Progress": ["In Review", "Human Needed", "Done", "Canceled"],
  "In Review": ["Done", "In Progress", "Human Needed", "Canceled"],
  "Human Needed": ["Backlog", "Research Needed", "Ready for Plan", "In Progress", "Done", "Canceled"],
  "Done": [],
  "Canceled": [],
};

/**
 * Check whether a workflow-state transition is legal.
 *
 * - `current` undefined/empty (new/stateless item — genuinely unset, not
 *   "could not be read") always passes. Discriminating "genuinely unset"
 *   from "fetch failed" is the CALLER's job (see issue-tools.ts's
 *   three-outcome table) — this predicate stays pure and permissive on
 *   `undefined` so it can be unit-tested without API stubs.
 * - `current === target` always passes (idempotent re-assert).
 * - Otherwise, `target` must be in `ALLOWED_TRANSITIONS[current]`.
 */
export function isLegalTransition(
  current: string | null | undefined,
  target: string,
): boolean {
  if (!current) return true;
  if (current === target) return true;
  const allowed = ALLOWED_TRANSITIONS[current];
  return allowed ? allowed.includes(target) : false;
}

/**
 * Legal next states from `current`, for refusal error text.
 */
export function legalNextStates(current: string): readonly string[] {
  return ALLOWED_TRANSITIONS[current] ?? [];
}

/** Result of a parent-gate advance legality check. */
export type ParentGateAdvanceResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Check whether a parent may be advanced to `gate` given its current state.
 *
 * The parent gate legitimately performs a MULTI-HOP forward jump — a parent
 * at `Backlog` whose children all reach `In Review` should advance — so
 * validating it against `isLegalTransition` verbatim is too strong (it would
 * refuse `Backlog -> In Review` and strand the parent permanently, since
 * `split.md` states parent transitions are server-owned, never manual). The
 * children's own (now transition-validated) progression is the legality
 * evidence for each skipped phase. This predicate is therefore a
 * purpose-built, documented carve-out, not a verbatim transition check.
 */
export function isLegalParentGateAdvance(
  current: string | null | undefined,
  gate: string,
): ParentGateAdvanceResult {
  if (!current) {
    return { ok: false, reason: "parent state unresolvable" };
  }
  if (current === "Human Needed") {
    return { ok: false, reason: "parent is escalated" };
  }
  if (TERMINAL_STATES.includes(current)) {
    return { ok: false, reason: "parent is terminal" };
  }
  if (LOCK_STATES.includes(current) && current !== gate) {
    return { ok: false, reason: "parent is locked by an active claim" };
  }
  if (!PARENT_GATE_STATES.includes(gate)) {
    return { ok: false, reason: "not a gate state" };
  }
  // Fail closed on a state outside the canonical pipeline (renamed or custom
  // project-field option, drift). Without this, stateIndex(current) is -1, the
  // ordering check below can never be true, and a corrupted parent state would
  // be silently overwritten instead of refused like the other unresolvable cases.
  if (stateIndex(current) === -1) {
    return { ok: false, reason: "parent state unrecognized" };
  }
  if (stateIndex(gate) <= stateIndex(current)) {
    return { ok: false, reason: "already at or past" };
  }
  return { ok: true };
}
