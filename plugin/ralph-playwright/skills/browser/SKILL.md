---
name: ralph-playwright:browser
description: Raw browser automation via playwright-cli with ralph-hero conventions. Use when you need direct access to playwright-cli commands — navigation, interaction, screenshots, snapshots, cookies, storage, network, devtools. All other ralph-playwright skills compose through this one. Requires global install of @playwright/cli.
allowed-tools:
  - Bash(playwright-cli *)
  - Read
  - Write
---

# Browser — playwright-cli with Ralph-Hero Conventions

Direct access to the full `playwright-cli` command surface with enforced conventions.

## Prerequisites

`playwright-cli` must be globally installed:
```bash
which playwright-cli || echo "Not installed — run: npm install -g @playwright/cli@latest"
```

## Session Convention

All output is scoped to `.playwright-cli/<session>/`. Session name defaults to:
```
<date>-<skill>-<slug>
```
Example: `2026-03-21-browser-checkout-flow`

## Path Construction

The CLI does not auto-scope output by session. You MUST construct paths explicitly and pass via `--filename`:
```bash
playwright-cli screenshot --filename=".playwright-cli/<session>/<index>_<slug>.png"
playwright-cli snapshot --filename=".playwright-cli/<session>/<index>_<slug>.md"
```

## High-resolution captures

Default screenshot capture uses the current viewport resolution (typically ~1280x720 to ~1920x1080 depending on viewport settings, ≈1.15MP area). For steps that need fine-grained pixel detail — OCR of table cells, receipt verification, dense chart labels, pixel-computed color contrast, thin focus indicators — callers can opt into high-resolution capture for a specific step.

### Canonical flag spelling

High-res capture is controlled at the **top-level CLI** (analogous to `--viewport WxH`), not as a screenshot sub-command flag. This applies at session open time so subsequent screenshots in that session inherit the density. Two forms are supported:

```bash
# Canonical form — explicit device scale factor
playwright-cli --device-scale-factor 2 -s=<session> screenshot --filename=".playwright-cli/<session>/<index>_<slug>.png"

# Semantic alias — "just give me the high-res preset"
playwright-cli --high-res -s=<session> screenshot --filename=".playwright-cli/<session>/<index>_<slug>.png"
```

The `--high-res` alias expands to `--device-scale-factor 2` with automatic clamping (below). Both forms are equivalent when the viewport is ≤1280px wide.

> **Fallback for older playwright-cli versions without native flag support**: if neither `--high-res` nor `--device-scale-factor` is recognized by your installed `@playwright/cli`, use an eval-based scale at session open time:
> ```bash
> playwright-cli -s=<session> eval "await page.evaluate(() => { window.devicePixelRatio = 2; }); await page.setViewportSize({ width: <W>, height: <H>, deviceScaleFactor: 2 })"
> ```
> Prefer the native flag when available — it is layout-preserving.

### Resolution ceiling and clamping

The target when `--high-res` is on:
- Longest dimension ≤ **2576 px** (Opus 4.7 vision ceiling)
- Total pixel area ≤ **3.75 MP**

If the viewport × device-scale-factor exceeds either bound, the CLI clamps to the nearest safe scale factor. Concretely:
- Viewport 1280x720 × DSF 2 → 2560x1440 → **1.84 MP, 2560 longest-edge** — no clamp.
- Viewport 1920x1080 × DSF 2 → 3840x2160 → exceeds 2576 longest-edge → clamp to DSF ≈ 1.34 → ~2576x1449.
- Viewport 2576x1448 × DSF 1 → already at ceiling → no scaling applied.

The clamp preserves the layout (deviceScaleFactor, not viewport) — only pixel density changes.

### Token cost warning

High-res screenshots consume approximately **3.25x more image-input tokens** than default viewport captures (≈1.15 MP → ≈3.75 MP). At Opus 4.7 prices, blanket high-res on a 20-step journey is materially expensive. Use `--high-res` ONLY when the downstream reflect phase needs the extra precision:
- OCR-style reading of dense tables, receipts, invoices
- Chart or graph label fidelity
- Pixel-computed color contrast or thin focus indicator checks
- Small-type form label audits

**Pair-with-model discipline.** High-res + Sonnet-at-1568px wastes tokens — Sonnet downsamples. Pair `--high-res` with Opus 4.7 reflect (see [`skills/reflect/SKILL.md`](../reflect/SKILL.md)) or with OCR-heavy manual review. For a11y-focused uses (contrast, alt relevance), see [`skills/a11y-scan/SKILL.md`](../a11y-scan/SKILL.md).

This flag does NOT automatically escalate on failure — that behavior is tracked separately (#787). Callers opt in per-step, per-session, or per-story.

## Console Capture Setup

At journey start, inject the console error interceptor:
```bash
playwright-cli eval "window.__consoleErrors = []; window.__consoleWarnings = []; const origError = console.error; const origWarn = console.warn; console.error = (...args) => { window.__consoleErrors.push(args.map(String).join(' ')); origError.apply(console, args); }; console.warn = (...args) => { window.__consoleWarnings.push(args.map(String).join(' ')); origWarn.apply(console, args); };"
```

Read console state per step:
```bash
playwright-cli eval "JSON.stringify({ errors: window.__consoleErrors || [], warnings: window.__consoleWarnings || [] })"
```

## Available Commands

| Category | Commands |
|----------|----------|
| Browser | `open [url]`, `close` |
| Navigation | `goto <url>`, `go-back`, `go-forward`, `reload` |
| Interaction | `click <ref>`, `dblclick <ref>`, `fill <ref> <value>`, `type <text>`, `hover <ref>`, `select <ref> <values>`, `check <ref>`, `uncheck <ref>`; coordinate clicks via `eval page.mouse.click` — see `references/click-by-coordinate.md` |
| Capture | `screenshot [ref] [--filename=path.png]`, `snapshot [--filename=path.md]` |
| Keyboard | `press <key>`, `keydown <key>`, `keyup <key>` |
| Eval | `eval <js-expression>` |
| Tabs | `tab-list`, `tab-new [url]`, `tab-close`, `tab-select <ref>` |
| Cookies | `cookie-list`, `cookie-get <name>`, `cookie-set <name> <value>`, `cookie-delete <name>`, `cookie-clear` |
| Storage | `localstorage-list`, `localstorage-get <key>`, `localstorage-set <key> <value>`, `sessionstorage-*` |
| State | `state-save --filename=path`, `state-load --filename=path` |
| Network | `route <pattern> <handler>`, `unroute <pattern>` |
| DevTools | `console [min-level]`, `network`, `tracing-start`, `tracing-stop`, `video-start`, `video-stop [--filename=path.webm]` — see [Video capture](#video-capture) |

## Video capture

Measured against `@playwright/cli` 1.59.0-alpha on 2026-08-15 (GH-1749); the notes below are observations, not inferences from the docs.

```bash
playwright-cli -s=<session> open <url>          # video-start refuses if no browser is open
playwright-cli -s=<session> video-start          # takes NO arguments
# ... drive the page ...
playwright-cli -s=<session> video-stop --filename=".playwright-cli/<session>/demo.webm"
```

- **`video-start` takes no filename.** The path is given to `video-stop --filename`. Omitting it writes `.playwright-cli/video-<timestamp>.webm` — outside the session dir, so always pass it, and `mkdir -p` the session dir first.
- **Recording begins at `video-start`,** so open and navigate before starting if the load should not be in the artifact.
- **`video-chapter` does not exist.** There is no chapter/marker command; segment by recording separate clips, or record timestamps yourself alongside the capture.
- **Errors exit 0.** `video-stop` when nothing is recording, `video-start` twice, and an unrecognised subcommand all print `### Error` (or a usage dump) on stdout and still exit 0. In a script, grep the output for `### Error` — the exit code proves nothing.
- **Frame size is capped at 800x800 and is not configurable.** Playwright's default is the viewport scaled to fit 800x800, and the CLI exposes no size option, so a 1280x720 viewport records at **800x450**. `resize 1280 720` before `video-start` changes the viewport and does **not** change the recorded size (verified). If the artifact needs true 720p, use the API fallback below.

### Observed WebM properties

| | |
|---|---|
| Container / codec | Matroska/WebM, **VP8**, no audio track |
| Dimensions | **800x450** from a 1280x720 viewport (viewport aspect, capped at 800px) |
| Frame rate | 25 fps constant |
| Content | Real interaction frames — clicks and DOM/CSS changes render correctly under headless |

**Duration metadata:** the *stream* reports `duration=N/A` and `nb_frames=N/A`, so `ffprobe -show_entries stream=duration` returns nothing — this is the trap. The *format* duration is present and was exact in every capture (30.32 s / 758 frames, 8.20 s / 205, 3.84 s / 96, all = frames ÷ 25). Read it from the format, and for a render pipeline prefer the frame count, which cannot disagree with itself:

```bash
ffprobe -v error -show_entries format=duration -of csv=p=0 demo.webm
ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=nb_read_frames -of csv=p=0 demo.webm
```

### Fallback: the Playwright API, when size matters

`page.video().start({ size })` accepts explicit dimensions the CLI cannot pass. Verified to produce a true 1280x720 VP8 WebM:

```js
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await ctx.newPage();
await page.goto(url);
await page.video().start({ size: { width: 1280, height: 720 } });
// ... drive the page ...
await page.video().stop({ path: 'demo.webm' });
```

Use the CLI path by default — it composes with every other command in this skill and 800x450 is fine for an inline artifact. Drop to the API only when the deliverable needs ≥720p.

## Session Management

```bash
playwright-cli -s=<session-name> <command>  # Run command in named session
playwright-cli list                          # List active sessions
playwright-cli close-all                     # Close all sessions
```

## Vision-Fallback Trigger

When an a11y snapshot yields no ref for the target (canvas / map / bad-a11y / empty snapshot), the agents consult a trigger heuristic to decide whether to escalate to vision-based targeting. The reference doc enumerates exactly four trigger conditions plus worked positive and negative examples:

- Reference: [`references/vision-fallback-trigger.md`](references/vision-fallback-trigger.md)

The a11y-first invariant holds: a matching ref ALWAYS wins. The trigger is consulted only after ref-lookup fails.

## Vision Locator

When the trigger fires, an Opus 4.7 prompt resolves the target's pixel coordinates from the current screenshot. Input: screenshot path + plain-language target description. Output: parsed JSON or `None`. Model is pinned to Opus 4.7 via env var `RALPH_PLAYWRIGHT_VISION_LOCATOR_MODEL` (default `opus`).

- Reference: [`references/vision-locator-prompt.md`](references/vision-locator-prompt.md)

## Click by Coordinate

Dispatch a browser click at resolved pixel coordinates. `@playwright/cli` at current release does not expose a native `click --x --y`; the canonical dispatch uses the `eval page.mouse.click(X, Y)` shim. Bounds validation + DPR reconciliation are mandatory per the reference.

- Reference: [`references/click-by-coordinate.md`](references/click-by-coordinate.md)

## Vision-Fallback Orchestrator

The three primitives above compose into a single a11y-first sequence. The orchestrator doc is the canonical flow that both story-runner-agent and explorer-agent consume, including guardrails (no CSS selectors, one vision attempt per action) and worked test cases.

- Reference: [`references/vision-fallback-sequence.md`](references/vision-fallback-sequence.md)

## Vision-Fallback Fixtures

Integration fixtures (canvas / map / bad-a11y + a11y-good negative control) live at `plugin/ralph-playwright/fixtures/vision-fallback/`. This is the canonical shared-fixtures home for the ralph-playwright plugin per the vision-epic Integration Strategy — future vision-related features (e.g., Feature K / GH-795, Feature G / GH-791) may add pages here rather than creating parallel directories.

- Reference: [`../../fixtures/vision-fallback/README.md`](../../fixtures/vision-fallback/README.md)
