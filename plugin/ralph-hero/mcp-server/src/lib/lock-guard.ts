/**
 * Server-side lock guard for save_issue.
 *
 * Provides a pure, unit-testable function that determines whether a workflow
 * state transition would result in a lock conflict — i.e., two agents trying
 * to claim the same exclusive lock state simultaneously.
 */

import { LOCK_STATES } from "./workflow-states.js";

/**
 * Returns true when the requested transition is a lock conflict.
 *
 * A conflict exists when:
 *   1. The issue is already in a lock state (currentState ∈ LOCK_STATES), AND
 *   2. The caller is trying to set another lock state (targetState ∈ LOCK_STATES)
 *
 * The guard is intentionally narrow:
 *   - If currentState is undefined or empty, the issue's state is unknown
 *     (e.g., no project item yet). Allow the claim — it cannot conflict.
 *   - If targetState is NOT a lock state (e.g., moving to Done or reverting to
 *     Backlog), the guard is bypassed entirely. Non-lock transitions are always
 *     safe and should not incur an extra API roundtrip in the caller.
 *
 * @param currentState - The issue's current workflow state from the live API,
 *                       or undefined/empty if it could not be resolved.
 * @param targetState  - The workflow state the caller is trying to set.
 * @returns true if the transition should be blocked, false if it should proceed.
 */
export function isLockConflict(
  currentState: string | undefined,
  targetState: string,
): boolean {
  if (!currentState) {
    return false;
  }
  if (!LOCK_STATES.includes(targetState)) {
    return false;
  }
  if (currentState === targetState) {
    return false; // idempotent re-claim: same agent re-locking is safe
  }
  return LOCK_STATES.includes(currentState);
}
