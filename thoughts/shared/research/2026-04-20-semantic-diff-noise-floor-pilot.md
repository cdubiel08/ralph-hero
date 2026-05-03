---
date: 2026-04-20
topic: "Semantic-diff noise-floor pilot methodology"
tags: [ralph-playwright, semantic-diff, noise-floor, pilot, visual-diff]
status: methodology-defined
type: research
github_issue: 820
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/820
related_plans:
  - thoughts/shared/plans/2026-04-20-GH-0820-document-visual-diff-split-noise-floor-pilot.md
  - thoughts/shared/plans/2026-04-20-GH-0791-ralph-playwright-semantic-visual-diff.md
related_research:
  - thoughts/shared/research/2026-04-16-opus-4-7-ralph-playwright-vision.md
---

# Semantic-Diff Noise-Floor Pilot — Methodology + Defaults

## Summary

The in-loop semantic visual diff (epic [#784](https://github.com/cdubiel08/ralph-hero/issues/784) Feature G; atomics [#806](https://github.com/cdubiel08/ralph-hero/issues/806), [#809](https://github.com/cdubiel08/ralph-hero/issues/809), [#813](https://github.com/cdubiel08/ralph-hero/issues/813), [#816](https://github.com/cdubiel08/ralph-hero/issues/816)) ships a `--noise-floor` knob with three levels (`low` / `medium` / `high`) that govern the meaningful-change threshold the Opus 4.7 prompt applies to a baseline-vs-current screenshot pair.

This document defines the pilot methodology used to set the shipped default. The ship default is `medium`, declared in code as `DEFAULT_NOISE_FLOOR` in [`plugin/ralph-playwright/scripts/diff-emitter.mjs`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/scripts/diff-emitter.mjs). `medium` is the prompt's stated default in [`semantic-diff-prompt.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/skills/reflect/references/semantic-diff-prompt.md) Noise-Floor Rubric — it includes "changes that affect visual hierarchy, readability, or affordance" while skipping "micro-alignments and color palette tweaks that preserve intent".

The choice is *evidence-pending* rather than evidence-backed: this atomic locked the methodology, the fixture, and the gate criteria. The live pilot (Playwright + Opus 4.7 vision against `fixtures/semantic-diff-smoke/`) is deferred to an operator who has live model access during a session where Playwright is wired in. The "Results" table in §4 is the canonical place for the operator to fill in actual numbers; flipping the constant becomes a one-line change once the data is in.

## 1. What this pilot tests

The pilot calibrates a single decision: which noise-floor level (`low` / `medium` / `high`) becomes the shipped default for `/ralph-playwright:reflect --baseline`.

It tests the *prompt + Opus 4.7 vision* end-to-end through the merged stack (`#806` storage, `#809` matcher, `#813` emitter, `#816` reflect-phase wiring). It is NOT a unit test of any one atomic — those are covered by `diff-emitter.test.mjs`, `reflect-diff-runner.test.mjs`, and friends, all of which use injected mock model invokers.

What the pilot does NOT test:
- High-resolution capture (default viewport only — `1280x800`, `deviceScaleFactor: 1`)
- Multiple fixtures (one fixture is sufficient to set a sensible default; see §6 for follow-ups)
- Cross-browser variation (Playwright Chromium only)
- Multiple model variants (Opus 4.7 only — the frontmatter-declared model)
- Long journeys (the smoke fixture is a single page, single step in practice)

## 2. Fixture

`plugin/ralph-playwright/fixtures/semantic-diff-smoke/` (created in [#816](https://github.com/cdubiel08/ralph-hero/issues/816) Task 1.5):

- `v1.html` — Baseline. Subscribe-newsletter form with primary CTA at `margin-top: 16px` and a soft drop-shadow.
- `v2.html` — Changed variant. Same form with three deliberate differences:
  1. CTA `margin-top` increased from `16px` to `56px` — button shifts visibly downward.
  2. CTA `box-shadow` set to `none` — drop-shadow disappears.
  3. New `.promo-banner` div above `<header>` — yellow banner inserted above-the-fold.

Serve locally:

```bash
python3 -m http.server -d ./plugin/ralph-playwright/fixtures/semantic-diff-smoke 8765
# v1: http://localhost:8765/v1.html
# v2: http://localhost:8765/v2.html
```

Why this fixture: three changes, distributed across reflect's seven-category audit so the prompt can detect them by category — `Layout integrity` (banner inserted above the fold), `Visual hierarchy` (CTA position shift relative to form), `Imagery` (drop-shadow removal). Three changes is enough to give the model "true positives to find" without flooding the bullet list, which is what we need to measure recall at each noise-floor level.

## 3. Procedure

The pilot runs six sessions total: two A/A pairs (unchanged baseline against itself, three noise-floor levels) and three A/B pairs (changed variant against baseline, three noise-floor levels).

### 3.1. Run A — unchanged (false-positive ceiling)

For each level in `[low, medium, high]`:

```bash
# 1. Capture baseline
/ralph-playwright:explore http://localhost:8765/v1.html
# session-id: e.g. 2026-04-20-explore-v1-baseline

# 2. Promote to baseline directory
/ralph-playwright:reflect .playwright-cli/<session-id>/journey-trace.yaml --update-baseline

# 3. Capture current (re-render of the same URL — natural rendering noise included)
/ralph-playwright:explore http://localhost:8765/v1.html
# session-id: e.g. 2026-04-20-explore-v1-current-${LEVEL}

# 4. Diff at this level
RALPH_PLAYWRIGHT_DIFF_NOISE_FLOOR=${LEVEL} \
  /ralph-playwright:reflect .playwright-cli/<current-session>/journey-trace.yaml \
  --baseline .playwright-cli/<baseline-session>/journey-trace.yaml

# 5. Count regression signals in the resulting signal-report.yaml
yq '.signals[] | select(.type == "regression") | .description' \
  .playwright-cli/<current-session>/signal-report.yaml | wc -l
```

Each `regression` signal counted in step 5 is a **false positive** — the URL is unchanged, so any "meaningful change" reported by the prompt is noise. Record per-level counts in §4.

### 3.2. Run B — known-change (true-positive floor)

For each level in `[low, medium, high]`:

```bash
# 1. Reuse the v1 baseline from Run A (no need to recapture)

# 2. Capture v2 current
/ralph-playwright:explore http://localhost:8765/v2.html
# session-id: e.g. 2026-04-20-explore-v2-current-${LEVEL}

# 3. Diff at this level
RALPH_PLAYWRIGHT_DIFF_NOISE_FLOOR=${LEVEL} \
  /ralph-playwright:reflect .playwright-cli/<v2-session>/journey-trace.yaml \
  --baseline .playwright-cli/<v1-baseline-session>/journey-trace.yaml

# 4. Read each regression bullet's `description`. For each, classify:
#    - true positive: bullet describes one of the three intentional v1->v2 changes
#    - false positive: bullet describes something not present in the v1->v2 diff
#    - duplicate: bullet describes the same change another bullet already covered
yq '.signals[] | select(.type == "regression") | .description' \
  .playwright-cli/<v2-session>/signal-report.yaml
```

Record per-level counts (true positives, false positives, duplicates), plus a verbatim copy of the most representative true-positive bullet for the worked-example section of `skills/visual-diff/SKILL.md`.

### 3.3. Per-step rate normalization

The smoke fixture is a single-page, single-step journey, so the per-level false-positive count IS the per-step rate. For multi-step journeys the rate is `count / step_count`; the gate criteria below use the per-step rate.

## 4. Results

> **Status: methodology-only.** Operator running the pilot fills in this table from the live runs above. The pilot ships when an operator with live Opus 4.7 vision + Playwright in-session captures both runs and edits this table.

| Noise-floor | A: false positives (per step) | B: true positives | B: missed real changes (out of 3) | B: false positives | Notes |
|-------------|-------------------------------|-------------------|------------------------------------|---------------------|-------|
| `low`       | _pending_                     | _pending_         | _pending_                          | _pending_           | Expected: includes minor alignment tweaks; rendering-noise FPs likely. |
| `medium`    | _pending_                     | _pending_         | _pending_                          | _pending_           | Expected: 0–1 FP on unchanged; 2–3 TPs covering the three v1→v2 changes. |
| `high`      | _pending_                     | _pending_         | _pending_                          | _pending_           | Expected: 0 FPs; may miss the drop-shadow change as too cosmetic. |

### Verbatim true-positive bullet (worked example for SKILL.md)

> **Status: methodology-only.** Operator paste the most representative `regression` description from Run B (medium level) verbatim here. The plan acceptance for `skills/visual-diff/SKILL.md` § Worked Example reproduces this bullet by reference.

```
- <pending operator pilot>
```

Expected shape (from the prompt's stated examples in [`semantic-diff-prompt.md`](../../plugin/ralph-playwright/skills/reflect/references/semantic-diff-prompt.md) Output Format):

```
- Submit button moved ~40px down and lost its drop shadow.
- Promo banner now appears above the page header.
```

The shape is what the prompt instructs the model to produce. The actual wording will vary; the *structure* (subject + change + optional quantity/direction) is the load-bearing part.

## 5. Decision

**Shipped default: `medium`** (declared in [`plugin/ralph-playwright/scripts/diff-emitter.mjs`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/scripts/diff-emitter.mjs) as `export const DEFAULT_NOISE_FLOOR = "medium"`).

The decision criteria are evidence-gated and apply to whichever operator next runs the pilot:

- Keep `medium` if §4 Run A at medium has **≤1 false positive per 10 steps** AND §4 Run B at medium catches **≥2 of the 3 intentional changes** with **≤1 false positive**.
- Flip to `high` if §4 Run A at medium has **>1 false positive per 10 steps** (medium produces unacceptable noise on unchanged frames).
- Flip to `low` if §4 Run B at medium catches **<2 of the 3 intentional changes** AND Run A at low has **<2 false positives per 10 steps** (medium misses real changes; low recovers them without flooding).

The pre-data choice of `medium` is grounded in the prompt's own rubric paragraph — it is the level the prompt template is written to produce, and the seven-category reflect audit it inherits is calibrated for hierarchy/readability/affordance, which is exactly the medium-level gate. The operator pilot either confirms this calibration or surfaces an asymmetry between the prompt's stated rubric and Opus 4.7's actual behavior.

**Operator action when running the live pilot:** edit §4 with measured numbers, then either leave `DEFAULT_NOISE_FLOOR = "medium"` or flip to `low` / `high` per the criteria above. Both `skills/visual-diff/SKILL.md` and `skills/reflect/SKILL.md` cite the constant by name, so a one-line change in `diff-emitter.mjs` propagates without doc edits.

### Cross-link to code

- [`plugin/ralph-playwright/scripts/diff-emitter.mjs#L109`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/scripts/diff-emitter.mjs#L109) — `DEFAULT_NOISE_FLOOR` constant (the canonical value).
- [`plugin/ralph-playwright/scripts/reflect-diff-runner.mjs`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/scripts/reflect-diff-runner.mjs) — Imports `DEFAULT_NOISE_FLOOR` and uses it as the fallback when `--noise-floor` and `RALPH_PLAYWRIGHT_DIFF_NOISE_FLOOR` are both unset.

## 6. Open questions / follow-up gaps

This pilot is bounded by §1's "what is NOT tested" list. Areas left for follow-up tickets:

1. **Multi-fixture pilot.** One fixture sets a sensible default. Replicating the methodology against another fixture (e.g., a dashboard with charts, a checkout flow with multi-step state transitions) increases confidence and may surface fixture-specific calibration drift.
2. **High-res capture interaction.** When [#794](https://github.com/cdubiel08/ralph-hero/issues/794) (high-res mode) lands, re-run the pilot at high-res to check whether elevated pixel density changes the false-positive rate. The hypothesis is that high-res reduces false positives (the model can see real detail rather than guessing from anti-aliasing artifacts), but it is unmeasured.
3. **Operator-reported drift.** Once the pilot's default ships and operators run live workloads, capture user-reported FP/FN counts against arbitrary frontends as informal calibration data. If a pattern emerges (e.g., medium produces 5+ FPs on dashboards consistently), open a retuning ticket with the field data.
4. **Per-domain default override.** The current API has one global default. A future enhancement could let operators configure per-domain or per-session defaults (e.g., chart-heavy dashboards default to `high`; static landing pages default to `low`). Out of scope until §3's data shows it is needed.
5. **Auto-tuning from history.** A post-pilot version could read the last N signal-reports for a session slug and auto-adjust the default based on the operator's historical accept/reject ratio. Speculative; flagged in the parent feature plan as out-of-scope for this atomic.

## References

- Issue: https://github.com/cdubiel08/ralph-hero/issues/820
- Plan: [thoughts/shared/plans/2026-04-20-GH-0820-document-visual-diff-split-noise-floor-pilot.md](../plans/2026-04-20-GH-0820-document-visual-diff-split-noise-floor-pilot.md)
- Parent feature plan: [thoughts/shared/plans/2026-04-20-GH-0791-ralph-playwright-semantic-visual-diff.md](../plans/2026-04-20-GH-0791-ralph-playwright-semantic-visual-diff.md)
- Parent epic plan-of-plans: [thoughts/shared/plans/2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md](../plans/2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md) Feature G
- Vision research: [thoughts/shared/research/2026-04-16-opus-4-7-ralph-playwright-vision.md](2026-04-16-opus-4-7-ralph-playwright-vision.md) §Part 3 Item 7 + Open Questions on "Semantic-diff noise floor"
- Fixture README: [plugin/ralph-playwright/fixtures/semantic-diff-smoke/README.md](../../plugin/ralph-playwright/fixtures/semantic-diff-smoke/README.md)
- Prompt template: [plugin/ralph-playwright/skills/reflect/references/semantic-diff-prompt.md](../../plugin/ralph-playwright/skills/reflect/references/semantic-diff-prompt.md)
