---
description: Capture a fresh project snapshot, then render a markdown trends report (sparklines + 1d/7d/30d deltas) for velocity, riskScore, wipTotal, and leadTimeP50Hours. Read-only output to stdout — does not post anywhere.
argument-hint: "[optional: --since 30d]"
context: fork
model: haiku
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh RALPH_COMMAND=trends"
allowed-tools:
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__capture_snapshot
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__metrics_trends
---

# Ralph Trends

Capture a single fresh snapshot of the current project, then render a markdown trends report comparing the latest values to recent history.

This skill is **read-only output**: results print to stdout. Nothing is posted to GitHub.

## Workflow

### Step 1: Parse Arguments

Parse the argument string for optional flags:

- `--since <window>`: Lower bound for the trend window. Accepts ISO dates (e.g., `2026-04-01`) or date-math (`@today-30d`, `@now-24h`). Default: `7d` (interpreted as `@today-7d`).

All arguments are optional. Default behavior: capture a fresh snapshot, then trend over the last 7 days.

### Step 2: Capture Fresh Snapshot

Call `ralph_hero__capture_snapshot` with no arguments. <!-- internal: the tool picks up the current project from `RALPH_GH_OWNER` / `RALPH_GH_PROJECT_NUMBER` and uses the default 7-day velocity window. -->

This appends one row to `~/.ralph-hero/snapshots/<owner>/<projectNumber>.jsonl`. <!-- internal: capture is non-fatal — if the project has zero history, the row written by this call will be the first. -->

### Step 3: Query Trends

Call `ralph_hero__metrics_trends` with:

- `format`: `"markdown"`
- `since`: the parsed `--since` value, or `"@today-7d"` by default

The tool reads the local JSONL file, computes 1d/7d/30d deltas, and renders sparkline-augmented markdown for each metric.

### Step 4: Print Output

Print the returned `markdown` field directly to stdout. Do not post, do not summarize, do not edit.

If `metrics_trends` returns an "insufficient history" payload (fewer than 2 snapshots in the window), print the markdown as-is. Do not error.

## Output

Print the markdown report exactly as returned. No additional commentary.
