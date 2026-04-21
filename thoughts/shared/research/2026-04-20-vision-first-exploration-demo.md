---
date: 2026-04-20
type: research
tags: [ralph-playwright, vision, exploration, demo, opus-4-7]
github_issue: 818
status: pending-live-run
assets: []
---

# Vision-first exploration: poor-a11y demo findings

Validation evidence for the `--vision-first` exploration mode ([#795](https://github.com/cdubiel08/ralph-hero/issues/795)).

Runs the ref-mode baseline and the vision-first variant against a synthetic poor-a11y fixture, compares metrics, and gives a keep / drop / iterate recommendation.

## Target

- **Fixture**: [plugin/ralph-playwright/examples/poor-a11y-demo/](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/examples/poor-a11y-demo/)
- **Served at**: `http://localhost:8765/` (via `python3 -m http.server 8765`)
- **Goal string**: `"add the green widget to the cart and reach the confirmation screen"`
- **Happy path**: 3 clicks — green card on home → orange "add" on product → pink "finish" on cart → confirmation screen labelled `ordered`

The fixture intentionally violates a11y best practice in five specific ways (see the fixture README for full list). The key violations that distinguish the two modes:

- Primary CTAs rendered as generic `<div>`s with `aria-hidden="true"` and no `role`/`aria-label` → invisible to the accessibility tree, visible to the eye.
- Decoy `<a href="#">` links with empty text content → surface as untitled refs in the a11y tree, likely picked first by ref-mode.
- Unlabeled `<input type="text">` on the cart screen → labelling ambiguity in the snapshot.

## Method

Two consecutive explore runs on the same URL+goal:

1. `/ralph-playwright:explore http://localhost:8765/ "add the green widget to the cart and reach the confirmation screen"` — ref mode (baseline)
2. `/ralph-playwright:explore --vision-first http://localhost:8765/ "add the green widget to the cart and reach the confirmation screen"` — vision-first mode

Comparison table rendered automatically by the Step 4 summary on the second run (metrics discovery logic from [#812](https://github.com/cdubiel08/ralph-hero/issues/812)).

## Results

**STATUS: PENDING LIVE OPERATOR RUN.**

The fixture and the research doc scaffolding ship in this PR. Tasks 4.2 and 4.3 of the feature plan require a live browser instance and `playwright-cli` against the served fixture; those cannot be executed inside the implementation agent that lands this PR. An operator with `playwright-cli` installed runs the reproduction steps from the fixture README and backfills the results section below as a follow-up commit on the same branch (or on a small follow-up PR if the feature has already merged).

The rest of this document is the skeleton the operator fills in.

### Ref-mode baseline (pending)

```yaml
# Paste from .playwright-cli/<session>/exploration-metrics.yaml once the run completes.
mode: ref
url: http://localhost:8765/
goal: "add the green widget to the cart and reach the confirmation screen"
session: <date>-explore-poor-a11y-ref
goal_achieved: <fill>
total_steps: <fill>
passed: <fill>
failed: <fill>
duration_ms: <fill>
unique_urls: <fill>
dead_ends: <fill>
```

### Vision-first run (pending)

```yaml
mode: vision-first
url: http://localhost:8765/
goal: "add the green widget to the cart and reach the confirmation screen"
session: <date>-explore-poor-a11y-vision
goal_achieved: <fill>
total_steps: <fill>
passed: <fill>
failed: <fill>
duration_ms: <fill>
unique_urls: <fill>
dead_ends: <fill>
```

### Comparison table (pending)

The table is rendered by the explore skill's Step 4 summary on the second (vision-first) run. Paste it verbatim.

```
Metric          Ref    Vision-first
------          ---    ------------
goal_achieved   ???    ???
total_steps     ???    ???
passed          ???    ???
failed          ???    ???
duration_ms     ???    ???
unique_urls     ???    ???
dead_ends       ???    ???
```

### Evidence screenshots (pending)

Promote (copy) the following screenshots to `thoughts/local/assets/<session>/` and link them here:

- A ref-mode screenshot showing the explorer stuck on the decoy screen (or looping on the home screen's invisible cards), annotated with the step index where it got stuck.
- A vision-first screenshot at the equivalent step showing the explorer correctly identifying the green card / orange CTA / pink CTA.

If ref-mode surprisingly succeeds, note that honestly — do not cherry-pick screenshots that support a pre-committed narrative.

## Recommendation

**STATUS: PENDING LIVE RUN RESULTS.**

Fill one of:

- **keep** — Vision-first clearly outperformed ref-mode on this fixture. Ship the flag as-is; operators reach for it on poor-a11y sites per the docs added in [#815](https://github.com/cdubiel08/ralph-hero/issues/815).
- **drop** — Vision-first did not outperform, OR its failure modes (mis-targeting, token cost, latency) outweighed the accessibility win. Land the flag but add a prominent caveat to the docs in [#815](https://github.com/cdubiel08/ralph-hero/issues/815) and consider de-prioritising future iteration.
- **iterate** — Mixed signal: vision-first unblocked some decisions ref-mode missed, but also introduced new failures (e.g., the coordinate-click fallback mis-fired; the rubric's "primary CTA" heuristic drifted). File follow-up issues with specific failure patterns and keep the flag experimental.

Whichever outcome: state the rationale in one paragraph, citing the metric deltas above. Do not claim outcomes not supported by the data. If the delta is within noise (e.g., ±1 step, ±few hundred ms), say so.

## Follow-ups

If the recommendation is `iterate` or surfaces specific failure modes, file issues and link them here. Candidate follow-ups to watch for:

- Vision-first mis-targets when a decoy card is more visually salient than the correct one.
- Coordinate-click fallback ([#792](https://github.com/cdubiel08/ralph-hero/issues/792)) needs to land for vision-first to hit full coverage on canvas-heavy sites (not this fixture).
- `--high-res` screenshots ([#794](https://github.com/cdubiel08/ralph-hero/issues/794)) may help on pages with small text or dense charts (not this fixture).
- Token-cost measurement — parent epic's open question about Opus 4.7 cost per screenshot is NOT answered here.

## Cross-references

- Parent feature: [#795 — vision-driven exploration mode in explorer-agent](https://github.com/cdubiel08/ralph-hero/issues/795)
- Grandparent epic: [#784 — ralph-playwright: Opus 4.7 vision upgrade](https://github.com/cdubiel08/ralph-hero/issues/784)
- Feature plan: [2026-04-20-GH-0795-ralph-playwright-vision-first-exploration.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-04-20-GH-0795-ralph-playwright-vision-first-exploration.md)
- Docs that cite this demo: `plugin/ralph-playwright/skills/explore/SKILL.md` (see "When to use `--vision-first`")
- Fixture README: [plugin/ralph-playwright/examples/poor-a11y-demo/README.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/examples/poor-a11y-demo/README.md)
