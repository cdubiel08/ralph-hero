#!/usr/bin/env node
// match-steps.mjs — pair current and baseline journey-trace steps for the
// in-loop semantic visual diff (Atomic #809 of Feature G / parent #791 / epic
// #784).
//
// Contract (locked here; downstream atomics depend on the shape):
//
//   matchSteps(currentTrace, baselineTrace) -> {
//     pairs: Array<{ current: Step, baseline: Step, via: 'action-target' | 'index' }>,
//     addedInCurrent: Array<Step>,
//     missingFromCurrent: Array<Step>,
//   }
//
//   normalizeActionTarget(action, target) -> string
//
// Matching algorithm:
//   1. Primary key = normalized `(action, target)` tuple.
//      Normalization: trim both sides, lowercase, collapse internal whitespace
//      runs to a single space.
//   2. Build a multimap from primary key -> baseline steps. Steps with a
//      "missing" key (action OR target absent / empty after normalization) are
//      excluded from the primary-key map and queued for index-fallback.
//   3. For each current step:
//      a. If its key is "missing", queue for index-fallback.
//      b. If the bucket is unambiguous (exactly one baseline entry exists for
//         the key — original bucket size 1), pair with `via: 'action-target'`
//         and consume the baseline entry.
//      c. If the bucket has multiple baseline entries for the key (duplicates,
//         original bucket size >= 2), the pair was disambiguated by position:
//         pick the first un-consumed baseline step whose `index` matches the
//         current step's `index`. If none match, pick the first un-consumed
//         baseline step regardless. Mark `via: 'index'`.
//      d. If no baseline entry remains for the key (all consumed), the current
//         step falls to `addedInCurrent`.
//   4. Index-fallback pass: for each current step queued in step (3a), pair
//      with the baseline step at the same index that is STILL un-consumed.
//      Mark `via: 'index'`. Unmatched -> `addedInCurrent`.
//   5. Any baseline step not consumed after both passes -> `missingFromCurrent`.
//
// Design constraints (parent feature plan §Feature-specific constraints):
//   - Pure functions: no I/O, no module-level state.
//   - No external dependencies; Node stdlib only.
//   - Consumes the contract — does NOT call into baseline-store.mjs at all.
//     Trace-vs-trace matching is independent of whether the PNGs exist on disk.
//     The emitter (#813) checks for PNG presence via baseline-store.mjs.

// -------------------------------------------------------------------- //
// Normalization
// -------------------------------------------------------------------- //

/**
 * Normalize a single string: trim, lowercase, collapse internal whitespace runs.
 *
 * Null/undefined inputs are coerced to the empty string. The caller decides
 * whether an empty-after-normalization value is "missing" — see
 * `isMissingNormalizedToken` below.
 *
 * @param {string|null|undefined} s
 * @returns {string}
 */
function normalizeOne(s) {
  if (s === null || s === undefined) return "";
  if (typeof s !== "string") {
    // Defensive: schema requires action/target to be strings, but be tolerant
    // and stringify rather than throw — matchSteps is consumed by an emitter
    // that should never crash on malformed traces.
    s = String(s);
  }
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Normalize an `(action, target)` tuple into a single string key.
 *
 * Format: `"<normalized-action>::<normalized-target>"`. The double-colon
 * separator avoids accidental collisions (e.g., a literal colon inside a
 * URL target).
 *
 * Exposed alongside `matchSteps` so #813's prompt context can produce
 * deterministic, human-readable keys when listing pairs in the prompt.
 *
 * @param {string|null|undefined} action
 * @param {string|null|undefined} target
 * @returns {string}
 */
export function normalizeActionTarget(action, target) {
  return `${normalizeOne(action)}::${normalizeOne(target)}`;
}

/**
 * A primary key is "missing" when either side normalizes to the empty string.
 * Such steps fall through to the index-fallback pass — the matcher cannot
 * disambiguate them by `(action, target)` alone.
 *
 * @param {string} key - Output of normalizeActionTarget()
 * @returns {boolean}
 */
function isMissingNormalizedKey(key) {
  // Key shape is `${action}::${target}`. Either side empty => missing.
  const idx = key.indexOf("::");
  if (idx < 0) return true; // shouldn't happen; defensive
  const a = key.slice(0, idx);
  const t = key.slice(idx + 2);
  return a.length === 0 || t.length === 0;
}

// -------------------------------------------------------------------- //
// Matcher
// -------------------------------------------------------------------- //

/**
 * @typedef {Object} Step
 * @property {number} [index] - Step index in trace (0-based)
 * @property {string} [action] - Action verb (click, fill, navigate, ...)
 * @property {string} [target] - Action target (URL, selector, locator description)
 *
 * The full schema has many more fields (outcome, screenshot, snapshot, ...) but
 * the matcher only inspects these three. Extra fields are passed through verbatim
 * in the `pairs` output.
 */

/**
 * @typedef {Object} Trace
 * @property {Array<Step>} steps
 *
 * Matches the journey-trace schema's top-level shape; matcher only requires
 * `steps`. All other top-level fields are ignored.
 */

/**
 * @typedef {Object} MatchPair
 * @property {Step} current
 * @property {Step} baseline
 * @property {'action-target' | 'index'} via
 */

/**
 * @typedef {Object} MatchResult
 * @property {Array<MatchPair>} pairs
 * @property {Array<Step>} addedInCurrent - Current-trace steps with no baseline counterpart
 * @property {Array<Step>} missingFromCurrent - Baseline-trace steps with no current counterpart
 */

/**
 * Pair the steps of a current trace against a baseline trace.
 *
 * @param {Trace} currentTrace - Trace produced this run
 * @param {Trace} baselineTrace - Trace previously promoted as the baseline
 * @returns {MatchResult}
 */
export function matchSteps(currentTrace, baselineTrace) {
  // Defensive normalization: tolerate missing/empty `steps` so #813's emitter
  // can call this even when one side has zero steps.
  const currentSteps = Array.isArray(currentTrace?.steps)
    ? currentTrace.steps
    : [];
  const baselineSteps = Array.isArray(baselineTrace?.steps)
    ? baselineTrace.steps
    : [];

  // Pre-compute normalized keys for both traces so we don't re-normalize on
  // every lookup.
  const currentKeys = currentSteps.map((s) =>
    normalizeActionTarget(s?.action, s?.target),
  );
  const baselineKeys = baselineSteps.map((s) =>
    normalizeActionTarget(s?.action, s?.target),
  );

  // Build a multimap from key -> Array<{ idx, step }> over baseline steps.
  // Skip "missing" keys; those baseline steps participate only in the
  // index-fallback pass.
  /** @type {Map<string, Array<{ idx: number, step: Step }>>} */
  const baselineByKey = new Map();
  for (let idx = 0; idx < baselineSteps.length; idx++) {
    const key = baselineKeys[idx];
    if (isMissingNormalizedKey(key)) continue;
    const bucket = baselineByKey.get(key);
    if (bucket) {
      bucket.push({ idx, step: baselineSteps[idx] });
    } else {
      baselineByKey.set(key, [{ idx, step: baselineSteps[idx] }]);
    }
  }

  // Track which baseline indices have been consumed.
  const baselineConsumed = new Array(baselineSteps.length).fill(false);

  /** @type {Array<MatchPair>} */
  const pairs = [];
  /** @type {Array<Step>} */
  const addedInCurrent = [];
  // Steps that need the index-fallback pass after the primary-key pass.
  /** @type {Array<{ currentIdx: number, step: Step }>} */
  const indexFallbackQueue = [];

  // -------- Pass 1: primary-key matching -------- //
  for (let i = 0; i < currentSteps.length; i++) {
    const cur = currentSteps[i];
    const key = currentKeys[i];

    if (isMissingNormalizedKey(key)) {
      // Defer to index-fallback pass.
      indexFallbackQueue.push({ currentIdx: i, step: cur });
      continue;
    }

    const bucket = baselineByKey.get(key);
    if (!bucket) {
      // No baseline candidate for this key.
      addedInCurrent.push(cur);
      continue;
    }

    // Filter to un-consumed entries.
    const live = bucket.filter((b) => !baselineConsumed[b.idx]);
    if (live.length === 0) {
      addedInCurrent.push(cur);
      continue;
    }

    // `via` is determined by the ORIGINAL bucket size (i.e., whether the
    // baseline trace had duplicates for this key at all), not the live count.
    // Even if only one un-consumed entry remains by the time we process this
    // current step, the pair's identity was disambiguated by position when
    // duplicates existed — record that as `via: 'index'`.
    const isDuplicateKey = bucket.length > 1;

    if (!isDuplicateKey) {
      // Unambiguous primary-key match — bucket has exactly one baseline entry.
      const chosen = live[0];
      baselineConsumed[chosen.idx] = true;
      pairs.push({
        current: cur,
        baseline: chosen.step,
        via: "action-target",
      });
      continue;
    }

    // Duplicate (action, target) — disambiguate by index.
    // Prefer baseline step whose `index` matches the current step's `index`;
    // fall back to the first un-consumed entry.
    const curIndex = cur?.index;
    let chosen = null;
    if (typeof curIndex === "number") {
      chosen = live.find((b) => b.step?.index === curIndex) ?? null;
    }
    if (!chosen) {
      chosen = live[0];
    }
    baselineConsumed[chosen.idx] = true;
    pairs.push({
      current: cur,
      baseline: chosen.step,
      via: "index",
    });
  }

  // -------- Pass 2: index-fallback for current steps with "missing" keys -------- //
  for (const queued of indexFallbackQueue) {
    const { currentIdx, step: cur } = queued;
    // Look for the un-consumed baseline step at the same index.
    if (currentIdx < baselineSteps.length && !baselineConsumed[currentIdx]) {
      baselineConsumed[currentIdx] = true;
      pairs.push({
        current: cur,
        baseline: baselineSteps[currentIdx],
        via: "index",
      });
    } else {
      addedInCurrent.push(cur);
    }
  }

  // -------- Collect missingFromCurrent: any baseline step not consumed -------- //
  /** @type {Array<Step>} */
  const missingFromCurrent = [];
  for (let i = 0; i < baselineSteps.length; i++) {
    if (!baselineConsumed[i]) {
      missingFromCurrent.push(baselineSteps[i]);
    }
  }

  return { pairs, addedInCurrent, missingFromCurrent };
}

// -------------------------------------------------------------------- //
// No CLI entrypoint — this module is imported by #813's emitter only.
// (Mirrors baseline-store.mjs's posture; see parent plan §What We're NOT Doing.)
// -------------------------------------------------------------------- //

if (import.meta.url === `file://${process.argv[1]}`) {
  console.error(
    "match-steps.mjs has no CLI. Import it from another module:",
  );
  console.error(
    "  import { matchSteps, normalizeActionTarget } from './match-steps.mjs';",
  );
  process.exit(2);
}
