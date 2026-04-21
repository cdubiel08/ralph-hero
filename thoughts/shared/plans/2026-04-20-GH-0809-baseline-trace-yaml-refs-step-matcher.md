---
date: 2026-04-20
status: draft
type: plan
github_issue: 809
github_issues: [809]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/809
primary_issue: 809
parent_plan: thoughts/shared/plans/2026-04-20-GH-0791-ralph-playwright-semantic-visual-diff.md
tags: [ralph-playwright, opus-4-7, semantic-diff, step-matcher, journey-trace, schema]
---

# ralph-playwright: baseline trace-YAML refs + step matcher — Implementation Plan

## Prior Work

- builds_on:: [[2026-04-16-opus-4-7-ralph-playwright-vision]]
- builds_on:: [[2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic]]
- builds_on:: [[2026-04-20-GH-0791-ralph-playwright-semantic-visual-diff]]

## Overview

Atomic #809 of Feature G. Extend `journey-trace.schema.yaml` with an optional per-step `baseline_ref` field, and implement `matchSteps(currentTrace, baselineTrace)`. Consumes the storage helper from #806 — no re-implementation.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-809 | baseline trace-YAML refs + step matcher | S |

## Shared Constraints

Inherited verbatim from the parent feature plan (§Shared Constraints). Key items relevant here:

### Architecture & file ownership (from parent)

- Schema additions must be additive (new optional fields). `baseline_ref` must not appear in `step.required`.
- Hook validator updates must accompany schema changes in the same PR when the change tightens validation. In this case, `baseline_ref` is an optional pass-through string, so the hook validator pass-through behavior is sufficient — no explicit `yq` check needed unless the atomic decides to add one for documentation value.

### Research anchoring (from parent)

Cite `thoughts/shared/research/2026-04-16-opus-4-7-ralph-playwright-vision.md` §Part 3 Item 7 for motivation. The research specifies primary key `(action, target)` with index fallback.

### Feature-specific constraints (from parent)

- **Step-matcher contract is small and stable.** Shape: `{ pairs: [{current, baseline}], addedInCurrent: [...], missingFromCurrent: [...] }`. This atomic LOCKS that shape. Downstream atomics (#813, #816) rely on it.
- **Primary key normalization**: trim, lowercase, collapse internal whitespace runs on `(action, target)` tuples before comparison.
- **Fallback**: index-wise pairing when the primary key is missing, ambiguous, or duplicated.
- Consumes #806 helpers; does not re-implement slug/step-id resolution.

### Atomic-specific constraints

- **Backward-compatible schema evolution.** The `baseline_ref` field is optional. Existing `journey-trace.yaml` files with no baseline context must continue to validate. The parent research doc explicitly says the baseline path is `thoughts/local/baselines/<session-slug>/<step-id>.png`; `baseline_ref` stores that path (relative to the repo root OR relative to the session dir — atomic decides; match existing `screenshot` / `snapshot` conventions).
- **Trace writer scope.** The writer that emits `journey-trace.yaml` is the explorer-agent / story-runner-agent. For this atomic, "populating `baseline_ref` when a baseline exists" means ADDING the field to the yaml emitted by reflect's loader flow (not the execute-agent flow), OR keeping the write responsibility narrow and letting #816's reflect-phase wiring populate it at read-time. This plan prefers the narrow approach: #809 defines the schema + matcher; #816 populates `baseline_ref` when it loads the baseline trace.
- **No new external dependencies.** The matcher is pure-JS / Node, stdlib only, same pattern as `baseline-store.mjs` from #806.
- **Canonical matcher location.** `plugin/ralph-playwright/scripts/match-steps.mjs` alongside `baseline-store.mjs` (from #806) and `annotate.mjs` (from #790).

## Current State Analysis

### Journey-trace schema today

`plugin/ralph-playwright/schemas/journey-trace.schema.yaml`:
- `step.required: [index, action, target, outcome, screenshot, snapshot, console, duration_ms]` (line 42).
- Optional step fields already include: `error`, `decision_mode`, `vision_rationale`, `targeting_method`, `vision_fallback`, `capture`. Pattern: each optional field is added to `step.properties` without being listed in `step.required`, and the schema includes a short `description:` documenting default behavior when absent.
- No baseline field today.

### Hook validator today

`plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh`:
- Validates enum fields explicitly for `outcome`, `decision_mode`, `targeting_method`, `trigger_reason`, `click_outcome`, signal `type`, signal `severity`.
- Validates structural bbox constraints for signals.
- Unknown optional scalar string fields pass through without explicit validation (the script does a `required` check and then targeted enum/structure checks — it does not walk every property).
- Implication: adding an optional string `baseline_ref` to the schema requires NO hook change. If this atomic wants belt-and-suspenders, it can add a one-line check that, when present, the value is a non-empty string matching a path-like pattern. Prefer not to, to keep surface minimal.

### Matcher today

Nothing exists. This atomic creates the first cross-run trace-alignment utility in the plugin.

### Storage helper today (post-#806)

`plugin/ralph-playwright/scripts/baseline-store.mjs` provides:
- `resolveSessionSlug(sessionOrPath)` → canonical slug
- `resolveStepId(stepIdOrIndex)` → two-digit string
- `getBaselineDir(sessionSlug)` → absolute dir path
- `writeBaseline(sessionSlug, stepId, sourcePath)` → dest path
- `readBaseline(sessionSlug, stepId)` → path, throws `BaselineNotFoundError` on absence

The matcher does NOT need to call `readBaseline` — matching is purely trace-vs-trace. The presence or absence of a PNG on disk is a downstream concern for #813's emitter (it calls `readBaseline` before invoking the model).

### Files reviewed

- `plugin/ralph-playwright/schemas/journey-trace.schema.yaml` (150 lines) — primary edit target
- `plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh` (230 lines) — reviewed; no change needed
- `plugin/ralph-playwright/scripts/baseline-store.mjs` (post-#806) — consumed for helper pattern
- `plugin/ralph-playwright/scripts/annotate.mjs` — ESM pattern reference

## Desired End State

After this atomic merges:

- `journey-trace.schema.yaml` documents an optional per-step `baseline_ref: string` field. Existing traces remain valid.
- `plugin/ralph-playwright/scripts/match-steps.mjs` exports `matchSteps(currentTrace, baselineTrace)` returning `{ pairs, addedInCurrent, missingFromCurrent }`.
- `plugin/ralph-playwright/scripts/match-steps.test.mjs` covers at least five scenarios: exact match, reorder, added step in current, removed step from current, duplicate `(action, target)` disambiguated by index.
- No CLI flag, no reflect SKILL.md touch yet (#816's responsibility).

### Verification

- [ ] `journey-trace.schema.yaml` has `baseline_ref` under `step.properties` as an optional string with a `description` explaining the field semantics
- [ ] A sample `journey-trace.yaml` with NO `baseline_ref` field on any step passes `validate-primitive-io.sh`
- [ ] A sample `journey-trace.yaml` WITH `baseline_ref` set on some steps passes `validate-primitive-io.sh`
- [ ] `match-steps.mjs` exports `matchSteps`
- [ ] `matchSteps({steps: [...]}, {steps: [...]})` returns the exact shape `{ pairs: [{current, baseline}], addedInCurrent: [...], missingFromCurrent: [...] }`
- [ ] Primary-key normalization is applied before equality check
- [ ] Fallback-to-index kicks in only when primary-key matching is ambiguous / missing / duplicated
- [ ] `node --test plugin/ralph-playwright/scripts/match-steps.test.mjs` exits 0
- [ ] All five canonical scenarios have dedicated test cases

## What We're NOT Doing

- **No prompt authoring.** The semantic-diff prompt is #813's job.
- **No emitter.** Invoking Opus 4.7 per matched pair is #813's job.
- **No reflect SKILL.md change.** #816 owns the flag docs.
- **No CLI flags.** `--baseline` / `--update-baseline` are #816's job.
- **No writer change.** This atomic does not modify explorer-agent or story-runner-agent. Populating `baseline_ref` in emitted traces is done by #816 at read-time (reflect loads the baseline trace, annotates the current trace's steps with the resolved `baseline_ref` values); this atomic only supplies the schema field and the matcher.
- **No validator tightening.** `baseline_ref` is a pass-through optional string. No new `yq` check.
- **No multi-baseline logic.** `matchSteps` is 2-trace only.
- **No fuzzy matching.** If `(action, target)` does not normalize to equality AND index-fallback does not align, the step is counted as unmatched. No Levenshtein, no embedding similarity.

## Implementation Approach

Two additive changes: schema edit + new matcher module with tests. Order: schema first (so tests have something to depend on documentation-wise); matcher and tests in the same task.

---

## Phase 1: GH-809 — baseline trace-YAML refs + step matcher

- **depends_on**: [GH-806]

### Overview

Add `baseline_ref` to the journey-trace schema. Implement `matchSteps` and its test suite.

### Tasks

#### Task 1.1: Add `baseline_ref` to journey-trace schema

- **files**:
  - `plugin/ralph-playwright/schemas/journey-trace.schema.yaml` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] `step.properties` gains `baseline_ref` as a string type
  - [ ] Field is NOT added to `step.required`
  - [ ] `description:` explains the semantics: "Optional. Relative path under `thoughts/local/baselines/<session-slug>/` to the baseline screenshot used for semantic-diff comparison (GH-791). When absent, no baseline is available for this step and the diff emitter skips it. When present, `plugin/ralph-playwright/scripts/baseline-store.mjs#readBaseline()` must be able to resolve the path; otherwise the emitter fails loudly (see GH-816)."
  - [ ] Field is documented alongside other optional step fields, in an order consistent with the file (group with other cross-run / session-level annotations)
  - [ ] A sample `journey-trace.yaml` with `baseline_ref: "2026-04-20-explore-checkout/00.png"` on a step passes `validate-primitive-io.sh` when fed through the hook manually (or the test harness described in #786's plan)
  - [ ] A pre-existing `journey-trace.yaml` with NO `baseline_ref` on any step still passes (regression proof)

#### Task 1.2: Author `match-steps.mjs`

- **files**:
  - `plugin/ralph-playwright/scripts/match-steps.mjs` (create)
- **tdd**: true (tests authored in Task 1.3 drive design; this task lands the module to make them green)
- **complexity**: medium
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] ESM `.mjs`, no external deps
  - [ ] Exports `normalizeActionTarget(action, target)` returning a normalized tuple string (e.g., `click::submit-button`). Rules: trim both, lowercase both, replace internal runs of whitespace with a single space. Null/undefined inputs are treated as the empty string for the purposes of normalization, but a "missing" (null/undefined/empty-after-normalize) action OR target signals the fallback path to the matcher.
  - [ ] Exports `matchSteps(currentTrace, baselineTrace)`:
    - Input: two objects conforming to the journey-trace schema (must have a `steps` array)
    - Output: `{ pairs: Array<{ current: Step, baseline: Step, via: 'action-target' | 'index' }>, addedInCurrent: Array<Step>, missingFromCurrent: Array<Step> }`
    - `via` is informational — #813's emitter may log it or ignore it
  - [ ] Algorithm:
    1. Build a map from `normalizeActionTarget(step.action, step.target)` to baseline step(s). Entries with a "missing" key (see normalization rule) are excluded from the primary-key map and queued for index-fallback.
    2. For each current step:
       a. If its key is "missing", skip to index fallback for that step.
       b. Look up the key in the baseline map. If the baseline map has exactly one un-consumed entry for this key, pair them (consume the baseline entry) with `via: 'action-target'`.
       c. If the baseline map has multiple un-consumed entries for this key (duplicates), use index-fallback: pick the first un-consumed baseline step whose `index` matches the current step's `index`. If none match by index, pick the first un-consumed baseline step regardless; `via: 'index'`.
       d. If no baseline entry remains for this key, the current step falls to `addedInCurrent`.
    3. Index-fallback pass: for each current step not yet paired (those with "missing" keys), pair with the baseline step at the same index that is STILL un-consumed. Mark `via: 'index'`. Unmatched → `addedInCurrent`.
    4. Any baseline step not consumed after both passes → `missingFromCurrent`.
  - [ ] All functions pure (no I/O; no module-level state)
  - [ ] File exports both `matchSteps` and `normalizeActionTarget` (the latter is useful for ad-hoc matching in #813's prompt context)

#### Task 1.3: Test suite `match-steps.test.mjs`

- **files**:
  - `plugin/ralph-playwright/scripts/match-steps.test.mjs` (create)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [1.2]
- **acceptance**:
  - [ ] Uses `node:test` + `node:assert/strict`
  - [ ] Test `normalizeActionTarget` covers: trim both sides, lowercase both sides, collapse double-space in target, null action falls through to empty-string normalization
  - [ ] Scenario 1 (exact match): current steps `[{action:'click',target:'#submit',index:0}, {action:'fill',target:'email',index:1}]`, baseline identical. Expect: 2 pairs (both `via: 'action-target'`), 0 added, 0 missing.
  - [ ] Scenario 2 (reorder): current has the two steps in reversed order; baseline in original order. Expect: 2 pairs by `action-target`, 0 added, 0 missing. `pairs[i].current.index` may not equal `pairs[i].baseline.index` — the matcher pairs by key not position.
  - [ ] Scenario 3 (extra in current): current has 3 steps, baseline has 2 (the third current step's `(action,target)` is unique). Expect: 2 pairs, 1 `addedInCurrent` (the extra step), 0 missing.
  - [ ] Scenario 4 (removed from current): current has 2, baseline has 3 (the missing one's `(action,target)` is unique). Expect: 2 pairs, 0 added, 1 `missingFromCurrent` (the baseline step not represented in current).
  - [ ] Scenario 5 (duplicate `(action,target)` disambiguated by index): current has `[{action:'click',target:'next',index:0}, {action:'click',target:'next',index:2}]`, baseline has `[{action:'click',target:'next',index:0}, {action:'click',target:'next',index:3}]`. Expect: 2 pairs — `index:0` to `index:0`, and `index:2` to `index:3` (first un-consumed baseline step with matching key; index-fallback disambiguation). `via: 'index'` on the second pair.
  - [ ] Scenario 6 (missing `target` triggers index fallback): one step has no `target` field. Expect: that step pairs with the same-index baseline step via index-fallback, `via: 'index'`.
  - [ ] Scenario 7 (regression — baseline has extra index-only noise): baseline has 4 steps, current has 3 all matching `action-target`. Expect: 3 pairs (`action-target`), 1 `missingFromCurrent`.
  - [ ] Cleanup unnecessary — tests pure-function, no I/O.
  - [ ] `node --test plugin/ralph-playwright/scripts/match-steps.test.mjs` exits 0.

### Phase Success Criteria

#### Automated Verification:
- [ ] `node --test plugin/ralph-playwright/scripts/match-steps.test.mjs` — exits 0, all 7 scenarios pass
- [ ] Schema validation smoke-test: craft a minimal `journey-trace.yaml` with and without `baseline_ref`; run `validate-primitive-io.sh` on each; both exit 0
- [ ] `cd plugin/ralph-hero/mcp-server && npm run build` — no errors
- [ ] `cd plugin/ralph-hero/mcp-server && npm test` — all passing

#### Manual Verification:
- [ ] Reviewer confirms `baseline_ref` description accurately documents the "missing means skip, present means required-to-resolve" semantics
- [ ] Reviewer confirms `matchSteps` return shape matches the feature plan's contract exactly (including the `via` discriminator for pair provenance)
- [ ] Reviewer confirms normalization rule handles realistic Playwright action strings (e.g., `fill`, `click`, `verify`, `navigate` with URLs that may have trailing slashes)

**Creates for next phase**: `matchSteps` function (called by #813's emitter to pair current and baseline steps) and the schema field `baseline_ref` that #816 populates at baseline-trace-load time.

---

## Integration Testing

No integration test at this atomic level. Integration happens when #813 iterates `matchSteps(...)` output to drive its emitter — covered in the parent plan's §Integration Testing.

## References

- Parent feature plan: [thoughts/shared/plans/2026-04-20-GH-0791-ralph-playwright-semantic-visual-diff.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-04-20-GH-0791-ralph-playwright-semantic-visual-diff.md)
- Parent epic plan-of-plans: [thoughts/shared/plans/2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md) Feature G
- Research: [thoughts/shared/research/2026-04-16-opus-4-7-ralph-playwright-vision.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-16-opus-4-7-ralph-playwright-vision.md) §Part 3 Item 7
- Issue: https://github.com/cdubiel08/ralph-hero/issues/809
- Upstream atomic: [GH-806](https://github.com/cdubiel08/ralph-hero/issues/806) (provides `baseline-store.mjs` helper)
- Downstream consumers: [GH-813](https://github.com/cdubiel08/ralph-hero/issues/813) (iterates `matchSteps` output), [GH-816](https://github.com/cdubiel08/ralph-hero/issues/816) (populates `baseline_ref` at baseline-load time)
- Schema file: [plugin/ralph-playwright/schemas/journey-trace.schema.yaml](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/schemas/journey-trace.schema.yaml)
- Validator (unchanged): [plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh)
