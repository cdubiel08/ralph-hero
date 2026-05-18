---
date: 2026-05-06
status: draft
type: idea
author: user
tags: [mcp, pipeline-dashboard, status, tooling, dx]
github_issue: null
---

# Compact `pipeline_status_summary` MCP tool

## The Idea

A purpose-built MCP tool that returns just the fields a recurring status update needs — health, velocity, phase counts, top-N stuck issues, delta-vs-prior — at a fraction of `pipeline_dashboard`'s payload size.

## Why This Matters

- `pipeline_dashboard` returns ~60KB even with `issuesPerPhase: 3`, which exceeds the tool-result token cap and forces every caller to either persist-to-disk + read in chunks, or dispatch a subagent to summarize.
- For a status report, the caller only needs ~10 numeric fields and a small list of stuck-issue identifiers. Everything else is overhead.
- A 1-2KB response keeps the data in the main agent's context so no subagent round-trip is needed, lowering cost and latency per fire.

## Rough Shape

- New MCP tool in `dashboard-tools.ts`: `ralph_hero__pipeline_status_summary`.
- Returns: `{ health, riskScore, velocity, totalIssues, phaseCounts: {state: count}, stuckIssues: [{number, title, state, ageHours}], wipViolations, blockedDeps }`.
- Reuses the existing aggregation in `lib/dashboard.ts` but skips the per-issue detail arrays and any markdown rendering.
- Optional `since` parameter that returns delta vs a passed timestamp/snapshot ID, enabling change-detection without a separate persistence layer.

## Open Questions

- Should this fully replace `pipeline_dashboard`'s JSON mode for status callers, or live alongside?
- How much stuck-issue detail to include — top 5 by ageHours, or filtered by severity threshold?
- Is `delta` better as a separate tool that takes two summaries, or built into this one?

## Related

- `2026-05-06-status-loop-change-detection.md` — the change-detection gate that would consume this
- `plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts` — where it would live
- `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts` — existing aggregation logic to reuse
