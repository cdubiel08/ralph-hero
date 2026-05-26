# Report composition

This reference is consulted by `/ralph:catch-up --mode report`. It carries argument parsing, the pipeline-dashboard call shape, the metrics fallback path, the markdown template, the `--with-trends` append flow, and the final status determination.

## Argument parsing

Parse the argument string for optional flags:

- `--dry-run`: Generate the report but do not post it. Display the composed markdown and determined status.
- `--window N`: Override the time window in days for velocity and highlights (default: 7).
- `--status ON_TRACK|AT_RISK|OFF_TRACK`: Override the auto-determined status with a manual designation.
- `--with-trends`: Append a "Trends" section (sparklines + 1d/7d/30d deltas) to the report body. Default: off. When set, call `metrics_trends` after composing the body and append its markdown only if `≥2` snapshots exist.

All arguments are optional. Default behavior: 7-day window, auto-determined status, no trends section, post to GitHub.

## pipeline_dashboard call shape

Fetch the pipeline dashboard with:

- `format`: `"json"`
- `includeHealth`: `true`
- `includeMetrics`: `true`
- `doneWindowDays`: parsed window value or `7`
- `velocityWindowDays`: parsed window value or `7`

## Metrics fallback

If the response does **not** contain a `metrics` field (e.g., `includeMetrics` was false, or the dashboard returned without a metrics block for any reason):

1. Set `velocity` to the count of issues in the "Done" phase.
2. Determine status from `health.ok`:
   - `health.ok === true` → `ON_TRACK`
   - Any `critical` severity warnings → `OFF_TRACK`
   - Otherwise → `AT_RISK`
3. Set `highlights` to empty lists.
4. Note "(metrics unavailable — using dashboard fallback)" in the report.

If the response **does** contain `metrics`, use it directly:

- `velocity` = `metrics.velocity`
- `status` = `metrics.status`
- `highlights` = `metrics.highlights`
- `riskScore` = `metrics.riskScore`

## Markdown template

Build a markdown report with the following template. Only include non-empty phases in the Pipeline Summary table. Omit sections that have no data.

```markdown
# Project Status Report

_Generated: {generatedAt}_

## Pipeline Summary

| Phase | Count | Points |
|-------|------:|-------:|
| {state} | {count} | {estimatePoints} |

**Board items**: {boardItems}

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

## --with-trends append (optional)

Only run this step when `--with-trends` was passed; otherwise skip entirely.

1. Call `metrics_trends` with `format: "markdown"` and the default `since` window (no override).
2. If the response indicates fewer than 2 snapshots — for example, an empty `markdown` field, an "insufficient history" payload, or any signal that trends are not yet meaningful — do NOT append anything and do NOT fail. Silently skip.
3. Otherwise, append the returned markdown to the body composed above under a new `## Trends` H2 heading. Place the appended section after the `## Status: {STATUS}` block (or substitute the trend tool's own headings under `## Trends` — keep the resulting body well-formed markdown).

This step is purely additive: when `--with-trends` is omitted, the composed body is unchanged.

## Final status determination

1. If `--status` argument was provided, use that value.
2. Otherwise, use `metrics.status` (or the fallback above).

Valid values: `ON_TRACK`, `AT_RISK`, `OFF_TRACK`.

## Post or display

**If `--dry-run`:**

1. Display the full composed report body.
2. Display the determined status.
3. Print: `Dry run complete. No status update posted.`
4. STOP.

**Otherwise:**

1. Create a status update with:
   - `status`: the final status from above
   - `body`: the composed report markdown
2. Display the response: status update ID, status, and a truncated preview of the body (first 200 characters).
3. Print: `Status update posted successfully.`
