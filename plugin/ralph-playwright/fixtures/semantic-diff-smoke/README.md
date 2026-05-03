# Semantic-Diff Smoke Fixture (GH-816)

Two-page local fixture used to smoke-test the in-loop semantic visual diff
implemented in [GH-816](https://github.com/cdubiel08/ralph-hero/issues/816)
(Atomic #4 of Feature G under epic [GH-784](https://github.com/cdubiel08/ralph-hero/issues/784)).

## Files

- `v1.html` — Baseline variant. A simple subscribe form with a primary CTA
  that has a `margin-top: 16px` and a `box-shadow` drop-shadow.
- `v2.html` — Changed variant. The same form with three intentional
  differences:
  1. CTA `margin-top` increased from 16px to 56px (button shifts visibly
     down).
  2. CTA `box-shadow` set to `none` (drop-shadow removed).
  3. A new yellow promotional banner appears above the page (added DOM
     element above the fold).

## Serving

```bash
python3 -m http.server -d ./plugin/ralph-playwright/fixtures/semantic-diff-smoke 8765
```

Then visit:

- `http://localhost:8765/v1.html` (baseline)
- `http://localhost:8765/v2.html` (changed)

## Expected diff outcome

Running:

```
/ralph-playwright:explore http://localhost:8765/v1.html        # capture v1 trace
/ralph-playwright:reflect <v1-trace> --update-baseline         # promote v1 baselines
/ralph-playwright:explore http://localhost:8765/v2.html        # capture v2 trace
/ralph-playwright:reflect <v2-trace> --baseline <v1-trace>     # diff v2 vs v1
```

should produce **at least one** `regression` signal whose
natural-language description aligns with at least one of the three
intentional changes (e.g., "Submit button moved down and lost drop shadow"
or "Promo banner now appears above the page header"). Multiple bullets are
expected at the default `medium` noise floor.

Re-running the same flow with v1 as both baseline and current (i.e.,
diffing v1 against itself) should produce **zero** `regression` signals at
default noise floor — only the no-change sentinel from the model.

## Pilot notes

Pilot results are recorded under
`thoughts/local/pilots/2026-04-20-GH-0816-semantic-diff-smoke.md` (gitignored)
once an operator runs the flow with a live `playwright-cli` session and
Opus 4.7 model access. The pilot captures observed signal count, description
quality, false-positive count, and any surprises. The full automated path
(executor + Playwright + live model) is out of scope for this atomic; this
fixture exists so that the script behavior can be validated end-to-end once
those pieces are stitched together by an operator.

## Why a local fixture rather than a hosted demo?

The smoke test exists to confirm that the wiring between the four atomics
(#806 storage, #809 matcher, #813 emitter, #816 reflect-phase wiring) does
not break when an operator runs the live path. A local fixture keeps the
test:

- **Deterministic** — Fixed HTML, no flaky third-party dependencies.
- **Self-contained** — Two files + a `python3 -m http.server` invocation.
- **Reviewable** — The intentional differences live in the HTML diff
  between v1 and v2; reviewers can confirm the diff prompt's output
  matches the actual visual delta.
