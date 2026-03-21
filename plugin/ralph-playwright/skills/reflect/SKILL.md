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
    tags: [<relevant tags>]
summary:
  total_signals: <N>
  by_severity: { critical: N, high: N, medium: N, low: N }
  recommendation: "<actionable recommendation>"
```

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
