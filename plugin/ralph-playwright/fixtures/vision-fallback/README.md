# Vision-Fallback Integration Fixtures

Shared integration fixtures for the `ralph-playwright` vision-fallback feature (GH-792 / Feature H of GH-784).

These self-contained HTML pages exercise the three failure modes that motivate vision fallback — canvas rendering, map widgets, and poor-a11y markup — plus an a11y-good negative control that must NOT trigger the fallback.

This directory is the canonical shared-fixtures home for `ralph-playwright` per the vision-epic Integration Strategy. Future vision-related features (e.g., Feature K / GH-795, Feature G / GH-791) should add pages here rather than creating parallel directories.

## Fixtures

| File | Role | Fallback expectation |
|------|------|----------------------|
| `canvas-demo.html` | Canvas-rendered form with blue Submit / red Cancel buttons painted inside a `<canvas>`. | Must trigger `canvas_region`. |
| `map-demo.html` | Minimal pan/zoom canvas map with three labeled pin markers (SF, NYC, LA). | Must trigger `map_region`. |
| `bad-a11y.html` | Three interactive widgets rendered as bare `<div>` / `<span>` without roles/aria. | Must trigger `no_matching_ref` or `empty_snapshot`. |
| `a11y-good-control.html` | Standard accessible form (semantic labels, `<button type="submit">`). | MUST NOT trigger. `targeting_method: a11y_ref`. |

Each interactive fixture records clicks into a global `window.__*Clicks` array so integration tests can assert the vision-dispatched click landed near the intended target.

## Stories

User-story YAML files under `stories/` target each fixture. Each story uses a local-HTTP URL so runs are hermetic.

| Story | Target fixture | Expected path |
|-------|---------------|---------------|
| `stories/canvas-click.yaml` | `canvas-demo.html` | vision (canvas_region) |
| `stories/map-pin.yaml` | `map-demo.html` | vision (map_region) |
| `stories/div-button.yaml` | `bad-a11y.html` | vision (no_matching_ref) |
| `stories/a11y-good.yaml` | `a11y-good-control.html` | a11y |

## Serving locally

```bash
python3 -m http.server 8765 --directory plugin/ralph-playwright/fixtures/vision-fallback/
```

All four fixtures become reachable at `http://localhost:8765/<fixture>.html`.

## Running the integration suite

```bash
bash plugin/ralph-playwright/fixtures/vision-fallback/run-integration.sh
```

The runner:
1. Starts the HTTP server on port 8765 (backgrounded).
2. For each story, invokes the story-runner-agent or the documented manual invocation path.
3. Asserts against the resulting journey trace:
   - Canvas / map / bad-a11y: `targeting_method: vision_fallback` on the click step, `click_outcome: pass`, and the fixture's click log shows the click landed within ~30 px of the target.
   - A11y-good: `targeting_method: a11y_ref` (or absent, which defaults to `a11y_ref`).
4. Tears down the server on exit (trap EXIT).
5. Exits 0 on all-pass, non-zero on any failure.

The suite is hermetic — no live-network dependencies, no external CDNs.

## Adding a new fixture

1. Add the HTML file here, self-contained (no external SDK imports).
2. Expose a click-logging global (`window.__<fixture>Clicks`).
3. Add a story YAML under `stories/` that targets it.
4. Extend `run-integration.sh` with an assertion block.
