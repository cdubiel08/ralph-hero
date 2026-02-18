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
 */
export const HUMAN_STATES: readonly string[] = [
  "Human Needed",
  "Plan in Review",
] as const;

/**
 * Gate states that trigger parent advancement when ALL children reach them.
 * Intermediate "in progress" states should NOT advance the parent.
 */
export const PARENT_GATE_STATES: readonly string[] = [
  "Ready for Plan",
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
  "Human Needed": "Done",
};
