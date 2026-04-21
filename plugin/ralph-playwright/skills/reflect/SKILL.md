---
name: ralph-playwright:reflect
description: Analyze a journey trace and its screenshots to produce a signal report. Use when you have a journey trace from a previous execute run and want to analyze it separately. Reads screenshots and accessibility snapshots to identify anomalies, regressions, a11y violations, and UX issues.
model: claude-opus-4-7
allowed-tools:
  - Read
  - Write
---

# Reflect — Analyze a Journey Trace

## Input

Path to a journey trace YAML file (from a previous execute run):
- Example: `.playwright-cli/2026-03-21-explore-checkout-flow/journey-trace.yaml`

## Process

### Step 1: Read the trace

Read the journey trace YAML. Verify it conforms to the journey-trace schema (has id, timestamp, steps, summary).

### Step 2: Examine each step

For each step in the trace:

1. **Read the screenshot** (the PNG file at the `screenshot` path) and perform a **structured visual audit** across the seven categories below. For every finding, report **concrete, observable specifics** (element name, visible text, location on the page) — not vague phrases like "anomaly observed". Use the signal-type hints to map findings into the existing taxonomy in Step 3 (no new types).

   > **Color/contrast note:** Record qualitative observations only (e.g., "body text looks low-contrast against the banner background"). Do NOT compute pixel-level contrast ratios — pixel-computed contrast is handled by the `a11y-scan` skill's contrast check, not here.

   - **Layout integrity** — overlapping elements, clipped content, horizontal overflow, broken z-index stacking (modal behind page, tooltip cut off by container).
     - Example: *"Price label overlaps the 'Add to cart' button at the right edge of the product card"*
     - Example: *"Sticky footer covers the bottom row of the product grid"*
     - Typical signal types: `anomaly`, `ux_issue`
   - **Typography** — truncation without ellipsis, mixed font faces in a single region, unintended size jumps, broken line-height or kerning.
     - Example: *"Submit button label truncated to 'Sub...' with no ellipsis glyph"*
     - Example: *"Headline renders in system serif while surrounding body uses sans-serif"*
     - Typical signal types: `anomaly`, `ux_issue`
   - **Imagery** — broken image placeholders (alt-text box, camera icon), missing thumbnails, aspect-ratio squish (portrait photo stretched to landscape), visible pixelation, wrong image for the content.
     - Example: *"Hero image slot shows the browser's broken-image glyph"*
     - Example: *"Product thumbnail is vertically squashed to ~40% of its natural aspect ratio"*
     - Typical signal types: `anomaly`, `error`
   - **State visibility** — loading spinners lingering while data is clearly present, empty states with no explanatory message, missing feedback after a user action (form submitted with no confirmation), error states styled identically to success, disabled controls that look enabled.
     - Example: *"Spinner still visible over the results grid after 8 rendered rows appear"*
     - Example: *"Error banner uses the same green color token as success toasts"*
     - Typical signal types: `ux_issue`, `error`
   - **Visual hierarchy** — primary CTA is not visually dominant (outlined while a secondary action is filled), destructive actions styled as primary (red "Delete" presented as the default blue button), multiple competing primary buttons, key status information buried below decorative content.
     - Example: *"'Cancel subscription' button is the largest filled button on the page"*
     - Example: *"Two 'Continue' buttons of equal weight appear side by side"*
     - Typical signal type: `ux_issue`
   - **Chart & data UIs** — axis labels missing or illegible, legend-to-data mismatch (three series in legend, two in chart), unreadable density (bars overlap, points cluster into a blob), unlabeled units (numbers without `%`, `$`, `ms`, etc.), truncated numeric labels.
     - Example: *"Y-axis shows values 0–100 with no unit label; table below uses percentages"*
     - Example: *"Legend lists four regions but the stacked bar chart renders only three colors"*
     - Typical signal types: `ux_issue` (missing labels, illegible density) or `anomaly` (legend/data mismatch). Until issue #793 lands a `data_interpretation` type, map chart findings into these existing types.
   - **Viewport / responsive** — unintended horizontal scroll, content clipped at the fold (primary CTA not visible without scrolling on a standard desktop screenshot), navigation collapsed incorrectly, elements escaping their container.
     - Example: *"Horizontal scrollbar appears on desktop screenshot because the data table extends past the viewport"*
     - Example: *"Primary 'Checkout' button is below the fold on the 1280×800 default viewport"*
     - Typical signal types: `anomaly`, `ux_issue`

   **Severity rubric (applies to all visual findings):** `critical` = blocks core functionality (e.g., primary CTA unclickable or off-screen); `high` = major usability or a11y barrier (e.g., critical text truncated, destructive action styled as primary); `medium` = noticeable issue with a workaround (e.g., misaligned labels, minor spacing inconsistency); `low` = cosmetic or best-practice nit.

2. **Read the accessibility snapshot** (the `.md` file at the `snapshot` path) — check element structure, labels, roles, ARIA attributes
3. **Check console entries** — any errors or warnings indicate issues
4. **Check the outcome** — failed steps need investigation
5. **Note pixel coordinates** — while examining each screenshot, record approximate pixel bounding boxes for any region-specific issue you spot (e.g. the low-contrast button, the misaligned header, the error banner). Coordinates are 1:1 with the PNG pixels (no DPR scaling, no downsample) — what you see at `(x, y)` in the image is `(x, y)` in the file.

#### Capture resolution

When a step has a `capture` sub-object with `mode: high-res`, the screenshot was captured at elevated pixel density (≈2560x1440 or similar, up to 2576px longest-edge / 3.75MP). This means the screenshot is suitable for:

- **OCR-style reading** — extracting text that appears *inside* the rendered image (receipt totals, table cell values, chart labels, invoice line items).
- **Dense tabular data** — reading specific values from tables too dense to render legibly at default resolution.
- **Fine chart annotations** — small axis labels, data point values, legend text.
- **Small-type forms** — receipts, contracts, or compliance-style pages with fine print.

High-res steps carry an implicit expectation: the caller spent extra tokens specifically so that reflect could observe detail invisible at default resolution. Produce observations that exercise this detail — a generic "page loaded successfully" signal on a high-res receipt step is a wasted capture.

**Pairing rule.** High-res screenshots + Sonnet-at-1568px is wasted tokens — Sonnet downsamples the image before reading it. High-res pairs best with Opus 4.7 reflect (routed by Feature A #785 once landed). If you are running as Sonnet and encounter high-res captures, note this in the signal report so callers can correct the pairing.

Steps WITHOUT a `capture` sub-object (or with `mode: default`) were captured at viewport resolution — apply normal layout/structure analysis. Do not attempt OCR-style observation on default-resolution screenshots; the model cannot reliably read small text at those densities.

### Step 3: Classify signals

For each finding, classify as:

| Type | When |
|------|------|
| `anomaly` | Unexpected behavior, visual glitches, broken layouts |
| `regression` | Something that previously worked now fails (requires baseline comparison) |
| `a11y_violation` | WCAG non-compliance: missing labels, broken tab order, contrast |
| `ux_issue` | Confusing navigation, dead ends, unclear feedback |
| `error` | Console errors, failed steps, broken interactions |
| `data_interpretation` | Dashboard or chart misinterpretation: axis label missing, legend does not match data, unreadable density, unlabeled units, incorrect numeric callouts, misleading visualizations. Distinct from `anomaly` (which covers layout/visual glitches) and `ux_issue` (which covers nav/feedback confusion) — use this when the chart *renders* fine but *communicates* wrong. |

Assign severity:
- `critical`: Blocks core functionality or causes data loss
- `high`: Major usability or accessibility barrier
- `medium`: Noticeable issue but workaround exists
- `low`: Minor cosmetic or best-practice issue

### Step 4: Write signal report

Write to `.playwright-cli/<session>/signal-report.yaml` following the signal-report schema:

```yaml
trace_id: "<from trace>"
timestamp: "<now ISO-8601>"
signals:
  - type: <type>
    severity: <severity>
    title: "<short title>"
    description: "<detailed description>"
    evidence:
      steps: [<step indices>]
      screenshots: ["<screenshot filenames>"]
      bboxes:
        - screenshot: "<screenshot filename, must also appear in evidence.screenshots>"
          x: <integer, top-left X pixel, >= 0>
          y: <integer, top-left Y pixel, >= 0>
          w: <integer, width in pixels, >= 1>
          h: <integer, height in pixels, >= 1>
          note: "<optional short label for what the box highlights>"
    tags: [<relevant tags>]
summary:
  total_signals: <N>
  by_severity: { critical: N, high: N, medium: N, low: N }
  recommendation: "<actionable recommendation>"
```

**Concrete example** — a contrast violation on a primary CTA spotted at pixel region `(240, 480)` with size `180x44`:

```yaml
- type: a11y_violation
  severity: high
  title: "Primary CTA fails WCAG AA contrast"
  description: "The 'Continue' button at the bottom of the checkout form renders with a 2.8:1 contrast ratio; needs >=4.5:1 for AA."
  evidence:
    steps: [3]
    screenshots: ["03_checkout.png"]
    bboxes:
      - screenshot: "03_checkout.png"
        x: 240
        y: 480
        w: 180
        h: 44
        note: "Continue button (2.8:1)"
  tags: [a11y, contrast, wcag-aa]
```

**When to populate `bboxes`:**

- **Populate** when the signal concerns a specific region of a screenshot: contrast violations, layout breaks, error banners, misaligned elements, low-density text, off-canvas CTAs, overlapping modals, malformed form fields, broken focus rings.
- **Omit** for whole-page signals that do not refer to a specific region: global console errors, navigation failures, page-load timeouts, cookies-banner-on-every-page issues.
- `bboxes` is OPTIONAL. Old signal reports without it remain valid. A missing `bboxes` field means "no region-specific annotations for this signal" — the act phase will skip rendering for that signal but still promote the original screenshot.

**Coordinate conventions:**

- All coordinates are integer pixels, origin at top-left of the PNG.
- 1:1 with the image bytes — no DPR scaling, no downsample. Playwright screenshots use `deviceScaleFactor: 1` by default.
- `x, y` must be `>= 0`. `w, h` must be `>= 1`. The hook validator rejects negative coords or zero dimensions.
- `screenshot` must match a filename already listed under `evidence.screenshots[]` for the same signal. The validator rejects dangling references.

### Step 5: Report

```
== Signal Report for <session> ==
Trace: <trace_id> | Steps: <N> | Duration: <ms>

Signals: N total
  🔴 Critical: N
  🟠 High: N
  🟡 Medium: N
  ⚪ Low: N

<signal details>

Recommendation: <recommendation>

Next: Use /ralph-playwright:capture to promote screenshots, or pipe this
report to the act primitive for automated issue creation.
```

## Model Routing

Reflect runs on **Claude Opus 4.7** by default via the `model: claude-opus-4-7` frontmatter hint above. Reflect is a vision-heavy workload — screenshot analysis, layout inspection, and visual anomaly detection benefit materially from Opus-tier vision. The execute phase stays on Sonnet: both `agents/explorer-agent.md` and `agents/story-runner-agent.md` declare `model: sonnet` because navigation and click/fill actions are mechanical and Sonnet is competent and cheap for that workload.

### Overriding the model

Set `RALPH_PLAYWRIGHT_REFLECT_MODEL` in the session environment to pin a different model. This is the canonical escape hatch — use it to roll back to Sonnet for cost control, or to pin a newer model when one ships.

```bash
# Roll back reflect to Sonnet (cheaper; loses Opus-tier vision)
export RALPH_PLAYWRIGHT_REFLECT_MODEL=claude-sonnet-4-6

# Pin a future Opus release
export RALPH_PLAYWRIGHT_REFLECT_MODEL=claude-opus-4-8
```

### Scope caveat

The frontmatter hint fires on **direct** `Skill("ralph-playwright:reflect")` invocations (including `/ralph-playwright:reflect <trace-path>`). When reflect is embedded as an in-line step inside a parent skill (`explore`, `test-e2e`, `a11y-scan`, `capture`, `ux-audit`), it inherits the caller's model context — the standalone SKILL.md is not re-loaded. For those contexts, `RALPH_PLAYWRIGHT_REFLECT_MODEL` is the user-facing override; per-skill propagation of the hint is a future concern.

### Rationale

See [`thoughts/shared/research/2026-04-16-opus-4-7-ralph-playwright-vision.md`](../../../../thoughts/shared/research/2026-04-16-opus-4-7-ralph-playwright-vision.md) §Part 3 Item 1 for the empirical motivation — Opus 4.7's vision improvements on screenshot-heavy analysis workloads justify the per-phase split.

### See also

For the plugin-level narrative on the execute/reflect model split and the full pipeline orientation, see [`plugin/ralph-playwright/README.md`](../../README.md).
