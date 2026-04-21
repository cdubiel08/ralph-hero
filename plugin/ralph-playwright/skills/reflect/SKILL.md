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
