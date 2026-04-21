# ralph-playwright fixtures

Static HTML fixtures used to exercise ralph-playwright skills against known-shape pages. Each fixture lives in its own subdirectory and is servable from any static file server (e.g., `python3 -m http.server`). No build step is required.

## Convention

Each fixture directory contains:

- `index.html` — the page under test.
- `README.md` — describes the fixture, the cases it exercises, the expected signals the skill should emit when run against it, and a "How to verify" runbook.
- Optional `expected-signals.md` — a documentation-only oracle listing the signals that a correctly-configured skill should emit for each labeled case. Not a machine-checked spec; ralph-playwright is skills/agents-only.

Cases within a fixture are labeled `data-contrast-case="A"`, `data-<skill>-case="X"`, etc. so README and expected-signals files can reference cases unambiguously.

## Directory

| Fixture | Purpose | Introduced for |
|---------|---------|----------------|
| [low-contrast/](low-contrast/) | Four labeled text samples (A-D) covering normal-fail, normal-pass, large-fail, text-over-image. Exercises pixel-computed WCAG 2.x contrast logic in `a11y-scan`. | [GH-788](https://github.com/cdubiel08/ralph-hero/issues/788) |

## Why this directory exists

Introduced by [GH-788](https://github.com/cdubiel08/ralph-hero/issues/788) per the recommendation in the parent plan-of-plans ([2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md](../../../thoughts/shared/plans/2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md)): "Shared fixtures live under (recommended) `plugin/ralph-playwright/fixtures/` — a new directory introduced by whichever feature needs test pages first."

Sibling features are expected to extend this directory:

- [#789](https://github.com/cdubiel08/ralph-hero/issues/789) alt-text relevance (images-with-misleading-alt fixture)
- [#790](https://github.com/cdubiel08/ralph-hero/issues/790) annotated evidence bounding boxes
- [#791](https://github.com/cdubiel08/ralph-hero/issues/791) in-loop semantic visual diff
- [#792](https://github.com/cdubiel08/ralph-hero/issues/792) vision-fallback element targeting
