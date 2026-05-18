---
date: 2026-05-06
status: draft
type: idea
author: user
tags: [pipeline-dashboard, status, loop, change-detection, dx]
github_issue: null
---

# Change-detection gate for recurring status updates

## The Idea

When a recurring status loop (`/loop 4h status update`) fires against `pipeline_dashboard`, diff the new snapshot against the prior one and emit "no change since HH:MM" instead of a full re-summary when nothing material moved.

## Why This Matters

- Observed during a 5-fire `/loop 4h` session: three consecutive fires returned byte-identical phase counts, velocity, and stuck-issue lists.
- Each fire still cost a 60KB dashboard pull plus a subagent summarization round-trip — pure token burn for zero new information.
- A one-line "no change" emit is more legible to the human reader and cheaper to produce.

## Rough Shape

- Persist last snapshot's signal fields (phase counts, velocity, risk score, stuck-issue numbers + ageHours bucket) to `~/.ralph-hero/last-status-snapshot.json` keyed by project number.
- On next fire, compute the diff. If no signal field changed beyond a threshold (e.g. ageHours rounded to nearest hour, no new/missing issue numbers), emit a short "stable since T" line.
- Threshold tunable so trivial age-hour drift doesn't trigger a full report.
- Could live as a wrapper skill (`/ralph-hero:status-delta`) or as a flag on `pipeline_dashboard` (`onlyIfChanged: true`).

## Open Questions

- Where to persist the prior snapshot — per-session in memory (loop-scoped) or durable across sessions?
- Should "stable" still summarize the stuck-issue tail, or omit it entirely?
- Does this belong in the dashboard tool itself, or as a thin client-side wrapper?

## Related

- `2026-05-06-pipeline-status-summary-tool.md` — the compact endpoint this would pair with
- `plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts` — current dashboard implementation
