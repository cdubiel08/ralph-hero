# `--mode trends`

Capture a fresh project snapshot, then render a markdown trends report (sparklines + 1d/7d/30d deltas) for velocity, riskScore, wipTotal, and leadTimeP50Hours. **Read-only output** — results print to stdout; nothing is posted to GitHub.

```bash
export RALPH_SUBCOMMAND=trends
```

No hook gates this mode and no terminal token is emitted — the markdown report itself is the deliverable. Trends is the only caretaker mode without a terminal verdict because no state transition or artifact creation happens that a postcondition could verify.

## §Step 1: Parse arguments

Parse `$ARGUMENTS` for optional flags:

- `--since <window>` — lower bound for the trend window. Accepts ISO dates (e.g., `2026-04-01`) or date-math (`@today-30d`, `@now-24h`). Default: `7d` (interpreted as `@today-7d`).

All arguments are optional. Default behavior: capture a fresh snapshot, then trend over the last 7 days.

## §Step 2: Capture and query in one call

Call `ralph_hero__metrics_trends` with:

- `capture: true`
- `format: "markdown"`
- `since`: the parsed `--since` value, or `"@today-7d"` by default.

GH-1611 merged the former standalone `capture_snapshot` tool into the `capture` parameter, and capture happens *before* the trend computation in the same call — so one invocation appends the fresh row and trends over a window that already includes it. (Two calls would work but re-scan the JSONL for nothing.)

The tool picks up the current project from `RALPH_GH_OWNER` / `RALPH_GH_PROJECT_NUMBER`, uses the default 7-day velocity window for the captured row, appends it to `~/.ralph-hero/snapshots/<owner>/<projectNumber>.jsonl`, then computes 1d/7d/30d deltas and renders sparkline-augmented markdown for each metric.

Capture is non-fatal — if the project has zero history, the row written by this call will be the first.

## §Step 3: Print output

Print the returned `markdown` field directly to stdout. Do not post, do not summarize, do not edit.

If `metrics_trends` returns an "insufficient history" payload (fewer than 2 snapshots in the window), print the markdown as-is. Do not error.

## §Output contract

The markdown report IS the terminal output. No `result:` line, no terminal token, no `## Trends` comment posted anywhere. Consumers (operators, the heartbeat fan-out, future iOS surfaces) read the markdown directly from stdout.

## §Constraints

- **Read-only.** Trends never mutates GitHub state or any file outside `~/.ralph-hero/snapshots/`.
- **No terminal token.** Postcondition hooks ignore this mode.
- **Haiku-class workload.** The source skill declares `model: haiku` because the work is two MCP calls + a stdout print. The caretake top-level `model: sonnet` covers all modes; haiku would be cheaper but the slim plugin runs all modes under the same model for arg-routing simplicity.
- **Snapshot append is non-fatal.** If the snapshot file is missing or unreadable, `metrics_trends` with `capture: true` creates it; a read-only `metrics_trends` call degrades to an "insufficient history" report.
