---
description: Generate and post a project status report. Queries pipeline dashboard with velocity metrics, composes a markdown report, auto-determines health status (ON_TRACK/AT_RISK/OFF_TRACK), and posts via GitHub Projects V2 status updates.
argument-hint: "[optional: --dry-run] [optional: --window N] [optional: --status ON_TRACK|AT_RISK|OFF_TRACK]"
model: sonnet
env:
  RALPH_COMMAND: "report"
---

# Ralph Project Report

Generate a project status report and post it as a GitHub Projects V2 status update.

## Workflow

### Step 1: Parse Arguments

Parse the argument string for optional flags:

- `--dry-run`: Generate the report but do not post it. Display the composed markdown and determined status.
- `--window N`: Override the time window in days for velocity and highlights (default: 7).
- `--status ON_TRACK|AT_RISK|OFF_TRACK`: Override the auto-determined status with a manual designation.

All arguments are optional. Default behavior: 7-day window, auto-determined status, post to GitHub.

### Step 2: Fetch Dashboard with Metrics

Call `ralph_hero__pipeline_dashboard` with:
- `format`: `"json"`
- `includeHealth`: `true`
- `includeMetrics`: `true`
- `doneWindowDays`: parsed window value or `7`
- `velocityWindowDays`: parsed window value or `7`

### Step 3: Handle Metrics Fallback

If the response does **not** contain a `metrics` field (the metrics library from GH-139 is not yet deployed):

1. Set `velocity` to the count of issues in the "Done" phase
2. Determine status from `health.ok`:
   - `health.ok === true` -> `ON_TRACK`
   - Any `critical` severity warnings -> `OFF_TRACK`
   - Otherwise -> `AT_RISK`
3. Set `highlights` to empty lists
4. Note "(metrics unavailable — using dashboard fallback)" in the report

If the response **does** contain `metrics`, use it directly:
- `velocity` = `metrics.velocity`
- `status` = `metrics.status`
- `highlights` = `metrics.highlights`
- `riskScore` = `metrics.riskScore`

### Step 4: Compose Report Body

Build a markdown report with the following template. Only include non-empty phases in the pipeline summary table. Omit sections that have no data.

```markdown
# Project Status Report

_Generated: {generatedAt}_

## Pipeline Summary

| Phase | Count |
|-------|------:|
| {state} | {count} |

**Total**: {totalIssues} issues

## Velocity

{velocity} issues completed in the last {windowDays} days.

## Health Indicators

{For each warning, grouped by severity:}
- [{SEVERITY}] {message}

{If no warnings:}
All clear — no health warnings.

## Highlights

**Recently Completed:**
- #{number} {title}

{If none: "None in this window."}

**Newly Added:**
- #{number} {title}

{If none: "None in this window."}

## Status: {STATUS}

{If auto-determined: "Auto-determined from risk score ({riskScore})."}
{If manually overridden: "Manually set to {STATUS}."}
```

### Step 5: Determine Final Status

1. If `--status` argument was provided, use that value.
2. Otherwise, use `metrics.status` (or the fallback from Step 3).

Valid values: `ON_TRACK`, `AT_RISK`, `OFF_TRACK`.

### Step 6: Post or Display

**If `--dry-run`:**
1. Display the full composed report body.
2. Display the determined status.
3. Print: "Dry run complete. No status update posted."
4. STOP.

**Otherwise:**
1. Call `ralph_hero__create_status_update` with:
   - `status`: the final status from Step 5
   - `body`: the composed report markdown from Step 4
2. Display the response: status update ID, status, and a truncated preview of the body (first 200 characters).
3. Print: "Status update posted successfully."

## Output

Display the report output and posting confirmation. Keep additional commentary minimal.
