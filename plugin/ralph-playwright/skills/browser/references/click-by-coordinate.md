---
title: Click-by-Coordinate Dispatch
phase: 3
issue: 799
parent: 792
---

# Click-by-Coordinate Dispatch

Bridge resolved pixel coordinates (from [`vision-locator-prompt.md`](vision-locator-prompt.md)) to an actual browser click via `playwright-cli`.

Contract signature (interpreted by agents):

```
click_at_coordinate(session: str, x: int, y: int) -> {outcome, post_screenshot}
```

## Upstream CLI Discovery

`@playwright/cli` at current release (as surveyed during Phase 3 execution) does **not** expose a native `click --x --y` sub-command. Running `playwright-cli click --help` shows the documented form as `click <ref>` — ref-based targeting only. `npm view @playwright/cli versions` confirms no version in the current line adds coordinate-click.

Therefore the **canonical dispatch** is the `eval` shim using `page.mouse.click(x, y)`:

```bash
playwright-cli -s=<session> eval "await page.mouse.click(${X}, ${Y})"
```

`page.mouse.click` accepts **CSS pixel coordinates** (browser device-independent pixels), not device pixels. See "Coordinate Space" below for DPR reconciliation.

If a future version of `@playwright/cli` adds native `click --x --y`, prefer it and update this document. The `eval` shim stays as fallback.

### Recommended Invocation

Copy-paste ready shell snippet (assumes `X` and `Y` are shell variables holding the CSS-pixel coordinates):

```bash
# Dispatch click at (X, Y) in CSS pixels within the active session
playwright-cli -s="${SESSION}" eval "await page.mouse.click(${X}, ${Y})"

# Immediately capture the post-click screenshot and snapshot
# (handled by the existing step loop in story-runner / explorer)
playwright-cli -s="${SESSION}" screenshot --filename=".playwright-cli/${SESSION}/${INDEX}_post_click.png"
playwright-cli -s="${SESSION}" snapshot   --filename=".playwright-cli/${SESSION}/${INDEX}_post_click.md"
```

The click itself is fire-and-forget from the CLI's perspective — it returns immediately once the underlying Playwright Page API dispatches the mouse event. Post-click state is captured by the existing step loop.

### Return Value

The caller records:

```yaml
outcome: pass | fail | out_of_bounds
post_screenshot: ".playwright-cli/<session>/<index>_post_click.png"
```

Mapping of dispatch results to `click_outcome` in the journey trace:

- `pass`: eval returned without error AND post-click screenshot captured successfully.
- `fail`: eval returned an error (e.g., browser navigated mid-click, session closed). Step outcome is `fail`.
- `out_of_bounds`: pre-dispatch bounds check failed (coords outside viewport). No click attempted. Step outcome is `fail`. This is distinct from `fail` because it indicates a vision-locator error rather than a browser error.

## Bounds Validation

**Pre-dispatch check**: the caller MUST assert `0 <= x < viewport_width` and `0 <= y < viewport_height` BEFORE invoking the eval shim. Out-of-bounds coords are a vision-locator error (see `vision-locator-prompt.md` Response Parsing rule 3) and must not produce a click attempt.

Obtain viewport dims via:

```bash
playwright-cli -s="${SESSION}" eval "JSON.stringify({w: window.innerWidth, h: window.innerHeight})"
```

Failure mode if caller elides the bounds check: `page.mouse.click` with out-of-bounds coords does NOT error — it silently clicks at the clamped edge or misses. This is a correctness bug masquerading as a successful dispatch. The pre-dispatch check is therefore mandatory.

### Example error text

On bounds violation, the caller raises (or the agent records):

```
ClickBoundsError: coordinates (1820, 950) out of bounds for viewport 1440x900.
  resolved_x: 1820 >= viewport_width: 1440
  resolved_y: 950  >= viewport_height: 900
  No click dispatched. Emit click_outcome: out_of_bounds.
```

### Worked examples

1. **In-bounds click succeeds.** Viewport 1440x900, coords (720, 450). Passes bounds check, dispatches `page.mouse.click(720, 450)`, captures post-click screenshot. Outcome: `pass`.
2. **Out-of-bounds raises.** Viewport 1440x900, coords (1500, 1000). Fails bounds check (`1500 >= 1440`). No dispatch. Outcome: `out_of_bounds`.
3. **Zero-coord edge case.** Viewport 1440x900, coords (0, 0). Passes bounds check (0 is in range `[0, width)`). Dispatches. This is a valid click at the top-left corner — used occasionally for "close" UI or full-page element tests. Outcome: `pass`.

## Coordinate Space

**The reconciliation problem**: the screenshot PNG passed to `vision-locator-prompt.md` may be captured at **device-pixel resolution** (native hardware pixels). `page.mouse.click` takes **CSS pixels** (the unit used by `window.innerWidth`, `window.innerHeight`, `clientX`, etc.). These differ by `window.devicePixelRatio` (DPR).

On a standard desktop viewport, DPR = 1 and device pixels equal CSS pixels. On a Retina / high-DPI / zoomed display, DPR can be 2, 3, or a fractional value (e.g., 1.5, 1.25). A coordinate returned by the locator as `(720, 450)` on a DPR=2 device-pixel screenshot is actually `(360, 225)` in CSS pixels.

### Detecting the DPR

```bash
DPR=$(playwright-cli -s="${SESSION}" eval "window.devicePixelRatio")
```

This returns the DPR as a JSON number (e.g., `1`, `2`, `1.5`).

### Detecting screenshot resolution

Read the PNG metadata (IHDR chunk) to get width/height in device pixels:

```bash
# Using `identify` from ImageMagick (preferred when available)
identify -format "%wx%h" ".playwright-cli/${SESSION}/${INDEX}.png"

# Alternatively with `file`:
file ".playwright-cli/${SESSION}/${INDEX}.png"
# png image data, 2880 x 1800, 8-bit/color RGBA, ...
```

Or shell-agnostic via the Read tool on the PNG followed by parsing the IHDR bytes.

### Reconciliation formula

```
css_x = round(device_x / dpr)
css_y = round(device_y / dpr)
```

Example: locator returns `(device_x=720, device_y=450)` on a screenshot that is 2880x1800 device pixels, with `window.innerWidth=1440` and `window.devicePixelRatio=2`.

- `css_x = round(720 / 2) = 360`
- `css_y = round(450 / 2) = 225`
- Dispatch: `page.mouse.click(360, 225)` (CSS pixels).

### Default: skip on DPR=1

Most desktop CI test runs operate at DPR=1. In that case the reconciliation is a no-op (`css = device`). The helper should detect DPR=1 and skip the divide step to avoid rounding artifacts. Only DPR != 1 triggers the divide.

Pseudo-logic for the reconciliation step:

```
if dpr == 1:
    css_x = device_x
    css_y = device_y
else:
    css_x = round(device_x / dpr)
    css_y = round(device_y / dpr)
```

### Validated in Phase 6

A high-DPI fixture (explicit `devicePixelRatio=2` via Playwright context option) exercises the divide path. See Phase 6's canvas fixture for the concrete test. Without that fixture, DPR reconciliation would be an untested code path in real (Retina) runs.

## Cross-references

- Caller: [`vision-fallback-sequence.md`](vision-fallback-sequence.md) Step 8 dispatches this.
- Input coordinates come from [`vision-locator-prompt.md`](vision-locator-prompt.md).
- Trigger: [`vision-fallback-trigger.md`](vision-fallback-trigger.md) gates the whole chain.
- Telemetry: `vision_fallback.click_outcome` in [`../../../../schemas/journey-trace.schema.yaml`](../../../../schemas/journey-trace.schema.yaml).
