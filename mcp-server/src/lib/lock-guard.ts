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

// ---------------------------------------------------------------------------
// GH-1616: holder identity, claim age, loud force, and the lock-release
// takeover gate.
// ---------------------------------------------------------------------------

/**
 * Maps each lock state to the "release" queue state — the backward edge
 * added by the GH-1592 group plan's Design Decisions (a): a lock holder can
 * release its claim back to the pre-lock queue state so another agent can
 * pick it up. `In Progress` deliberately has NO entry: there is no release
 * edge for it (preserves the no-rollback-on-impl-failure asymmetry —
 * `lock-release-on-failure.sh:61-64`).
 */
export const LOCK_RELEASE_TARGET: Readonly<Record<string, string>> = {
  "Research in Progress": "Research Needed",
  "Plan in Progress": "Ready for Plan",
};

/**
 * True iff (current, target) is exactly one of the two backward release
 * edges Phase 1 added to `ALLOWED_TRANSITIONS`. These are the ONLY moves
 * whose sole purpose is to make an issue claimable again — completion
 * (`Research in Progress -> Ready for Plan`), escalation (`-> Human
 * Needed`), and terminal exits stay unconditional, because a lock holder
 * finishing, escalating, or closing its OWN work must never be gated.
 *
 * Without this gate, a two-call takeover of a LIVE lock is possible with no
 * `force` and no marker: call 1 releases (`Research in Progress -> Research
 * Needed` — target is not a lock state, so `isLockConflict` never fires);
 * call 2 re-claims (`Research Needed -> Research in Progress` — current is
 * no longer a lock state, so `isLockConflict` never fires either). Gating
 * call 1 on staleness/force closes the recipe at its only choke point.
 */
export function isGuardedLockRelease(
  current: string | undefined,
  target: string,
): boolean {
  if (!current || !LOCK_STATES.includes(current)) return false;
  return LOCK_RELEASE_TARGET[current] === target;
}

/**
 * True when `heldSince` is at least `thresholdHours` in the past.
 * `heldSince` missing/unparseable => NOT stale (fail closed on releasing a
 * claim whose age cannot be established).
 */
export function isHeldSinceStale(
  heldSince: string | undefined,
  thresholdHours: number,
  now: Date = new Date(),
): boolean {
  if (!heldSince) return false;
  const then = new Date(heldSince).getTime();
  if (Number.isNaN(then)) return false;
  const hours = (now.getTime() - then) / (1000 * 60 * 60);
  return hours >= thresholdHours;
}

/** Render a human-readable age string, e.g. "3h ago", "2d ago". */
function formatAge(heldSince: string, now: Date): string {
  const then = new Date(heldSince).getTime();
  if (Number.isNaN(then)) return "unknown age";
  const diffMs = Math.max(0, now.getTime() - then);
  const hours = diffMs / (1000 * 60 * 60);
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m ago`;
  if (hours < 48) return `${Math.round(hours)}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * Render the actionable lock-conflict refusal: who holds the lock, since
 * when, and how to recover. `holder`/`heldSince` are best-effort — sourced
 * from `ProjectV2ItemFieldValueCommon.creator`/`updatedAt` by the caller
 * (`helpers.ts#getFieldValueDetail`) — and the message degrades gracefully
 * when either is unavailable (e.g. a fine-grained token that cannot read
 * `creator`).
 *
 * Deliberately does NOT present a bare two-call release-then-claim as the
 * recovery (Phase 2 §4b closed that hole) — the release hint names the
 * actual gate: stale or `force`.
 */
export function describeLockConflict(
  issueNumber: number,
  current: string,
  target: string,
  holder?: string,
  heldSince?: string,
  now: Date = new Date(),
): string {
  const holderLabel = holder ? `@${holder}` : "unknown";
  const sinceLabel = heldSince
    ? `${heldSince} (${formatAge(heldSince, now)})`
    : "an unknown time";
  const releaseTarget = LOCK_RELEASE_TARGET[current];
  const releaseHint = releaseTarget
    ? `if the claim is stale (see next_actions lock-stale directions), release it via ` +
      `save_issue(workflowState: "${releaseTarget}") — releasing requires the claim to be ` +
      `past the stale threshold or force=true; `
    : `"${current}" has no release edge; `;
  return (
    `Issue #${issueNumber} is locked: "${current}" held by ${holderLabel} since ${sinceLabel}. ` +
    `Another agent may be working on it. Recovery: wait for release; ${releaseHint}` +
    `or override this claim directly with force=true (the override is recorded in the response).`
  );
}

/**
 * Render the refusal for a guarded backward-release attempt that is neither
 * stale nor forced — the two-call takeover's call 1.
 */
export function describeGuardedRelease(
  issueNumber: number,
  current: string,
  target: string,
  heldSince: string | undefined,
  thresholdHours: number,
  now: Date = new Date(),
): string {
  const sinceLabel = heldSince
    ? `${heldSince} (${formatAge(heldSince, now)})`
    : "an unknown time";
  return (
    `Issue #${issueNumber} is locked: "${current}" held since ${sinceLabel} — not yet ` +
    `stale (threshold: ${thresholdHours}h). Releasing it to "${target}" would let another ` +
    `agent claim it out from under the holder.\n` +
    `Recovery: wait for the holder to finish or escalate; if you ARE the holder releasing ` +
    `after a failure, retry with force=true (the release is recorded in the response).`
  );
}
