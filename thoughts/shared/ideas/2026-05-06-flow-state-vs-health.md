---
date: 2026-05-06
status: draft
type: idea
author: user
tags: [pipeline-dashboard, health-scoring, metrics, dx]
github_issue: null
---

# Separate `flow_state` from `health` in pipeline scoring

## The Idea

The dashboard's health rubric currently flags OFF_TRACK in situations that aren't unhealthy — e.g. WIP=0 with a recently-drained backlog. Split "is the pipeline healthy" from "what state is flow in" so the signal isn't conflated.

## Why This Matters

- Observed during a `/loop 4h` session: pipeline showed `health: OFF_TRACK` (risk 12) while `phaseCounts` was `{Backlog: 1, Done: 71, all-other-lanes: 0}` and velocity was healthy. That's not "off track" — it's "starved" (no intake).
- A user reading "OFF_TRACK" on a fully-drained, post-shipping board gets a false alarm and tunes out the indicator.
- Recurring status updates in particular benefit from a flow-state distinction because the loop fires when nothing has happened, and "nothing has happened because we're done" is very different from "nothing has happened because we're stuck."

## Rough Shape

Replace single `health` field with two:

- `health`: ON_TRACK | AT_RISK | OFF_TRACK — driven by stuck issues, WIP violations, blocked deps, aging in active states.
- `flow_state`: ACTIVE | STARVED | STUCK | DRAINED — driven by phase distribution and velocity:
  - ACTIVE — items in flow lanes, velocity > 0
  - STARVED — flow lanes empty, Backlog low, velocity recently positive (need intake)
  - STUCK — flow lanes empty, Backlog full (triage gap)
  - DRAINED — flow lanes empty, Backlog empty, recent velocity (post-ship calm)

Risk score stays as-is but is fed into `health`, not `flow_state`.

## Open Questions

- Should `flow_state` be derivable from existing fields (no schema change), or a first-class scored field?
- Are four flow states the right granularity, or is three enough (ACTIVE / IDLE / BLOCKED)?
- How to threshold "recently positive velocity" — same window as the velocity metric itself?

## Related

- `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts` — current health-scoring logic
- `2026-05-06-pipeline-status-summary-tool.md` — would expose `flow_state` in its response
