---
name: ralph-playwright:reflect
description: Analyze a journey trace and its screenshots to produce a signal report. Use when you have a journey trace from a previous execute run and want to analyze it separately. Reads screenshots and accessibility snapshots to identify anomalies, regressions, a11y violations, and UX issues.
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

1. **Read the screenshot** (the PNG file at the `screenshot` path) — look for visual anomalies, layout issues, error states
2. **Read the accessibility snapshot** (the `.md` file at the `snapshot` path) — check element structure, labels, roles, ARIA attributes
3. **Check console entries** — any errors or warnings indicate issues
4. **Check the outcome** — failed steps need investigation
5. **Note pixel coordinates** — while examining each screenshot, record approximate pixel bounding boxes for any region-specific issue you spot (e.g. the low-contrast button, the misaligned header, the error banner). Coordinates are 1:1 with the PNG pixels (no DPR scaling, no downsample) — what you see at `(x, y)` in the image is `(x, y)` in the file.

### Step 3: Classify signals

For each finding, classify as:

| Type | When |
|------|------|
| `anomaly` | Unexpected behavior, visual glitches, broken layouts |
| `regression` | Something that previously worked now fails (requires baseline comparison) |
| `a11y_violation` | WCAG non-compliance: missing labels, broken tab order, contrast |
| `ux_issue` | Confusing navigation, dead ends, unclear feedback |
| `error` | Console errors, failed steps, broken interactions |

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
