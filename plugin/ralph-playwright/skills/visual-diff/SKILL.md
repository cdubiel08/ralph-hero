---
name: ralph-playwright:visual-diff
description: Storybook-component-level visual regression via Chromatic (default, free tier) or Applitools Eyes (AI-based). Pairs with the in-loop semantic visual diff (`reflect --baseline`) which catches journey-level changes. Use after visual changes to verify intentional vs unintentional component drift.
---

# Visual Diff — Visual Regression Testing

## Two Layers of Visual Regression

Visual regression in `ralph-playwright` is split across two complementary layers, neither of which replaces the other:

1. **In-loop semantic diff (journey-level).** `/ralph-playwright:reflect --baseline <prior-trace>` runs Opus 4.7 vision against matched screenshots from a prior journey trace and emits natural-language `regression` signals ("Submit button moved ~40px down and lost its drop shadow"). Owned by [`skills/reflect/SKILL.md`](../reflect/SKILL.md). Triggered as part of an agent loop, mid-journey, against whatever pages the journey naturally visits.
2. **Component-level pixel diff (Storybook-story).** Chromatic or Applitools Eyes runs against your Storybook story catalog, comparing pixel-level renders of each story against a saved snapshot. Owned by this skill. Triggered as a CI step on PR, per-story.

Both layers are complementary. The semantic diff catches journey-level layout shifts that no individual story would surface (e.g., the CTA falls below the fold mid-checkout because an upstream banner changed height). The component diff catches per-story drift that no journey would step through (e.g., a `Button` story in disabled state regresses while the journey only ever exercises the enabled state).

### Decision Guide

Which layer should catch which kind of regression:

| Scenario | Layer |
|----------|-------|
| Button padding tweak in a Storybook story | Component-level (Chromatic / Applitools) |
| Layout shift mid-journey pushing primary CTA below the fold | In-loop semantic diff (`reflect --baseline`) |
| Color-palette change affecting every component | Component-level (Chromatic / Applitools) |
| Error-state design regression (missing error banner after form submit) | In-loop semantic diff (`reflect --baseline`) |
| Font-weight regression on a single story | Component-level (Chromatic / Applitools) |
| Third-party widget rendering differently after a dependency upgrade | In-loop semantic diff (`reflect --baseline`) |
| Disabled-state of a button mis-styled (only used in one rare flow) | Component-level (Chromatic / Applitools) |
| Promo banner inserted above-the-fold pushing all journey content down | In-loop semantic diff (`reflect --baseline`) |

The rough rule:

- **Storybook story exists in isolation, change is component-internal** → component-level diff.
- **Page composition shifts, multi-component interaction matters, intent is journey-shaped** → semantic diff.

When in doubt, run both. They report on different work products and the cost of running each is bounded.

### Worked Example (in-loop semantic diff)

The smoke fixture in [`plugin/ralph-playwright/fixtures/semantic-diff-smoke/`](../../fixtures/semantic-diff-smoke/) demonstrates the journey-level signal shape. The fixture has two HTML variants:

- `v1.html` — Subscribe form with a primary CTA at `margin-top: 16px` and a soft drop-shadow.
- `v2.html` — Same form with three intentional differences: CTA `margin-top` increased to `56px`, CTA `box-shadow` removed, and a new yellow promo banner inserted above the page header.

Running the in-loop semantic diff at `--noise-floor=medium`:

```
/ralph-playwright:explore http://localhost:8765/v1.html
/ralph-playwright:reflect <v1-trace> --update-baseline
/ralph-playwright:explore http://localhost:8765/v2.html
/ralph-playwright:reflect <v2-trace> --baseline <v1-trace>
```

emits `regression` signals shaped like:

```
- Submit button moved ~40px down and lost its drop shadow.
- Promo banner now appears above the page header.
```

(Live operator-pilot verbatim bullets are captured in [`thoughts/shared/research/2026-04-20-semantic-diff-noise-floor-pilot.md`](../../../../thoughts/shared/research/2026-04-20-semantic-diff-noise-floor-pilot.md) §4 once an operator runs the pilot end-to-end.)

What the same v1→v2 diff would surface in **Chromatic / Applitools** instead: the per-story pixel-diff against a saved Subscribe-form story would highlight the `margin-top` and `box-shadow` deltas, but **only if** the page (`v1.html` / `v2.html`) corresponds to a Storybook story you have catalogued. A raw HTML page that is not a story is invisible to the component-layer diff. The promo banner, which is a new top-level DOM node not part of the form story, would not register at the component layer at all — it is a journey-level insertion.

The complementary observation: the component-level pixel-diff would also catch a 1-pixel padding tweak inside the `Button` component (which the natural-language semantic diff might dismiss as noise at `medium` noise floor). The two layers see different things; both are needed for full coverage.

### Noise floor

The semantic diff exposes a `--noise-floor` knob with three levels (`low` / `medium` / `high`). The default ships as **`medium`**, declared in code as [`DEFAULT_NOISE_FLOOR`](../../scripts/diff-emitter.mjs) in `plugin/ralph-playwright/scripts/diff-emitter.mjs`. The default value lives in one place; both this doc and `skills/reflect/SKILL.md` cite the constant by name.

The default is calibrated by the methodology in [`thoughts/shared/research/2026-04-20-semantic-diff-noise-floor-pilot.md`](../../../../thoughts/shared/research/2026-04-20-semantic-diff-noise-floor-pilot.md). The pilot runs against the smoke fixture above with two pairs (unchanged vs unchanged for the false-positive ceiling, unchanged vs changed for the true-positive floor) at three noise-floor levels. The shipped default is the level that satisfies these gates simultaneously:

- **False-positive ceiling**: ≤1 false-positive `regression` per 10 steps on the unchanged-vs-unchanged pair.
- **True-positive floor**: ≥2 of 3 intentional v1→v2 changes detected with ≤1 false positive on the changed pair.

Operators can override the default per-invocation:

```bash
# Per-shell environment variable
export RALPH_PLAYWRIGHT_DIFF_NOISE_FLOOR=high
/ralph-playwright:reflect <current-trace> --baseline <prior-trace>

# Per-invocation CLI flag (takes precedence over the env var)
/ralph-playwright:reflect <current-trace> --baseline <prior-trace> --noise-floor low
```

Use `low` to hunt subtle alignment regressions on stable pages; use `high` on noisy frontends with frequent rendering jitter to suppress false positives.

The pilot methodology doc is the place to record per-domain calibration drift if the shipped default does not fit a particular frontend.

## Component-Level Layer: Chromatic

Chromatic is the recommended default for component-level pixel-diffing. Free tier covers most small projects.

### Tool detection

Check what's configured in your repo:

```bash
cat package.json | grep -E "chromatic|@applitools"
```

- `chromatic` found → **Chromatic mode** (pixel-perfect)
- `@applitools/eyes-storybook` found → **Applitools mode** (AI-based)
- Neither → guide through Chromatic setup (recommended default)

### Setup

```bash
npm install --save-dev chromatic
```

Get your project token from https://www.chromatic.com and set it as an environment variable:

```bash
export CHROMATIC_PROJECT_TOKEN=your-token-here
```

Run:

```bash
npx chromatic
```

Free tier: 5,000 snapshots/month. Pixel-perfect diffing. Good for stable UIs.

## Component-Level Layer: Applitools Eyes

Applitools Eyes is the alternative for component-level diffing when Chromatic's strict pixel comparison produces excessive false positives.

### Setup

```bash
npm install --save-dev @applitools/eyes-storybook
npx eyes-storybook
```

AI-powered visual perception. Ignores rendering noise (anti-aliasing, sub-pixel differences). Better for UIs with dynamic content or cross-browser inconsistencies.

## When to choose Applitools over Chromatic

- Getting excessive false positives from Chromatic on animations or dynamic content
- Need cross-browser visual comparison (Chromatic uses one browser)
- Have Storybook stories with real data that varies slightly between runs

## See also

- [`skills/reflect/SKILL.md`](../reflect/SKILL.md) — Journey-level in-loop semantic diff via `--baseline` / `--update-baseline`. Pairs with this skill: this skill catches per-story drift; reflect catches journey-level shifts. Reciprocal of the "See also" link in reflect's `Semantic Visual Diff` section.
- [`thoughts/shared/research/2026-04-20-semantic-diff-noise-floor-pilot.md`](../../../../thoughts/shared/research/2026-04-20-semantic-diff-noise-floor-pilot.md) — Methodology + acceptance gates for the shipped `DEFAULT_NOISE_FLOOR`.
- [`plugin/ralph-playwright/fixtures/semantic-diff-smoke/`](../../fixtures/semantic-diff-smoke/) — Smoke fixture (v1.html / v2.html) used by both the unit tests and the noise-floor pilot.
- Parent epic [#784](https://github.com/cdubiel08/ralph-hero/issues/784) — `ralph-playwright` Opus 4.7 vision rollout.
- Feature [#791](https://github.com/cdubiel08/ralph-hero/issues/791) — In-loop semantic visual diff (the parent of `--baseline` / `--update-baseline`).
