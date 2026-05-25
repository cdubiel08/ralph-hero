/**
 * Pure cycle-time rollup over `TransitionRecord[]` extracted from
 * issue comments by `parseAllTransitions()`.
 *
 * Phase 2 (GH-1023) of the product-performance-over-time epic (#1019).
 *
 * Inputs are a list of `TransitionedIssue` (issueNumber + transitions
 * + optional `closedAt`). Output is a `CycleTimeRollup` with p50/p90
 * lead-time across issues and per-phase dwell percentiles.
 *
 * Semantics:
 *   - **Lead-time** per issue = `(last.at - first.at)` in hours. Issues
 *     with `< 2` valid transitions are excluded from the lead-time
 *     sample. `sampleSize` counts only included issues.
 *   - **Per-phase dwell** = consecutive `(transition[i+1].at -
 *     transition[i].at)` keyed by `transition[i].from`. The terminal
 *     state's dwell uses `closedAt ?? now` as the upper bound when the
 *     issue has not transitioned out of it. If `closedAt` is missing
 *     (issue still open), the open-ended terminal dwell is excluded.
 *   - **Out-of-order tolerance**: transitions are defensively sorted
 *     by `at` ascending before computation. Original arrays are not
 *     mutated.
 *   - **Malformed timestamps**: any transition whose `at` does not
 *     parse to a finite epoch (`Number.isFinite(Date.parse(at)) ===
 *     false`) is skipped without throwing.
 *   - **Percentiles**: linear-interpolation nearest-rank. With `n =
 *     1`, both p50 and p90 equal the single value. With `n = 0`, the
 *     phase entry is omitted from `perPhaseDwellHours`; lead-time
 *     fields are `null`.
 *
 * Pure: no I/O, deterministic, safe to call from any context.
 */

import type { TransitionRecord } from "./transition-comments.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One issue's transition history, ready for rollup. */
export interface TransitionedIssue {
  issueNumber: number;
  transitions: TransitionRecord[];
  /** ISO 8601 close timestamp, or null/undefined if the issue is open. */
  closedAt?: string | null;
}

/** Per-phase dwell percentile bucket. */
export interface DwellBucket {
  p50: number;
  p90: number;
  n: number;
}

/** Rollup result returned by `rollupCycleTimes`. */
export interface CycleTimeRollup {
  leadTimeP50Hours: number | null;
  leadTimeP90Hours: number | null;
  perPhaseDwellHours: Record<string, DwellBucket>;
  /** Number of issues contributing at least one valid lead-time interval. */
  sampleSize: number;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const MS_PER_HOUR = 3_600_000;

/** Parse an ISO timestamp; return `null` when not finite. */
function parseAt(at: string): number | null {
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Linear-interpolation nearest-rank percentile over a sorted (ascending)
 * array of finite numbers. `p` is in [0, 1]. Caller must ensure the
 * array is non-empty and sorted.
 */
function percentile(sorted: number[], p: number): number {
  const n = sorted.length;
  if (n === 1) return sorted[0];
  // rank in [0, n-1] (zero-indexed)
  const rank = p * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const frac = rank - lo;
  return sorted[lo] + (sorted[hi] - sorted[lo]) * frac;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Roll up lead-time and per-phase dwell-time across a batch of
 * transitioned issues.
 *
 * @param records  One entry per issue with parsed transitions.
 * @param now      Epoch milliseconds — used to bound the terminal-state
 *                 dwell when `closedAt` is missing on a non-terminal
 *                 issue. Always pass `Date.now()` from production code;
 *                 tests inject a fixed value for determinism.
 */
export function rollupCycleTimes(
  records: TransitionedIssue[],
  now: number,
): CycleTimeRollup {
  const leadTimes: number[] = [];
  const phaseBuckets: Record<string, number[]> = {};

  for (const rec of records) {
    // Filter + parse + sort defensively. Do not mutate the caller's array.
    const valid = rec.transitions
      .map((t) => {
        const ms = parseAt(t.at);
        return ms === null ? null : { t, ms };
      })
      .filter((x): x is { t: TransitionRecord; ms: number } => x !== null)
      .sort((a, b) => a.ms - b.ms);

    if (valid.length === 0) continue;

    // Lead-time: only when the issue has >= 2 valid transitions.
    if (valid.length >= 2) {
      const firstMs = valid[0].ms;
      const lastMs = valid[valid.length - 1].ms;
      const hours = (lastMs - firstMs) / MS_PER_HOUR;
      if (Number.isFinite(hours) && hours >= 0) {
        leadTimes.push(hours);
      }
    }

    // Per-phase dwell from consecutive intervals.
    for (let i = 0; i < valid.length - 1; i++) {
      const fromState = valid[i].t.from;
      const dwellHours = (valid[i + 1].ms - valid[i].ms) / MS_PER_HOUR;
      if (!Number.isFinite(dwellHours) || dwellHours < 0) continue;
      (phaseBuckets[fromState] ??= []).push(dwellHours);
    }

    // Terminal-state dwell: from the last transition's `to` state until
    // either `closedAt` (if present) or `now` (if the issue is open).
    // If the issue is open AND `closedAt` is missing, the terminal
    // dwell is open-ended and excluded — matches the Phase 2 spec.
    const last = valid[valid.length - 1];
    const terminalState = last.t.to;
    let upperMs: number | null = null;
    if (rec.closedAt) {
      const cMs = parseAt(rec.closedAt);
      if (cMs !== null) upperMs = cMs;
    } else {
      // Open issue: skip open-ended terminal dwell rather than
      // synthesising a value from `now`. (Spec: open-ended terminal
      // dwell is excluded when `closedAt` is missing AND the issue is
      // open.)
      upperMs = null;
    }

    if (upperMs !== null) {
      const dwellHours = (upperMs - last.ms) / MS_PER_HOUR;
      if (Number.isFinite(dwellHours) && dwellHours >= 0) {
        (phaseBuckets[terminalState] ??= []).push(dwellHours);
      }
    }
  }

  // ----- assemble percentile output -----------------------------------------

  const perPhaseDwellHours: Record<string, DwellBucket> = {};
  for (const [phase, samples] of Object.entries(phaseBuckets)) {
    if (samples.length === 0) continue;
    const sorted = [...samples].sort((a, b) => a - b);
    perPhaseDwellHours[phase] = {
      p50: percentile(sorted, 0.5),
      p90: percentile(sorted, 0.9),
      n: sorted.length,
    };
  }

  let leadTimeP50Hours: number | null = null;
  let leadTimeP90Hours: number | null = null;
  if (leadTimes.length > 0) {
    const sorted = [...leadTimes].sort((a, b) => a - b);
    leadTimeP50Hours = percentile(sorted, 0.5);
    leadTimeP90Hours = percentile(sorted, 0.9);
  }

  // Reference `now` for callers that want to bound things in the future.
  // The current spec excludes open-ended terminal dwell, but `now` is
  // retained in the API surface for forward-compat. Touch it here so
  // strict-mode TS does not flag it as unused.
  void now;

  return {
    leadTimeP50Hours,
    leadTimeP90Hours,
    perPhaseDwellHours,
    sampleSize: leadTimes.length,
  };
}
