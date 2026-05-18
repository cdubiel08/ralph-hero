---
date: 2026-05-04
status: draft
type: idea
author: user
tags: [ai-agent, github, trends, research, automation, idea-hunt]
github_issue: null
---

# Automated GitHub Trend Research Agent

## The Idea

An AI agent that automatically researches GitHub trends for a given topic and surfaces emerging open-source projects, running on a schedule or triggered by events rather than manually invoked like `/ralph-hero:idea-hunt`.

## Why This Matters

- `/ralph-hero:idea-hunt` requires a human to initiate research — interesting signals are missed between runs
- Automated trend monitoring could surface relevant projects before they become mainstream
- Could feed a persistent "what's emerging" digest rather than one-off reports

## Rough Shape

- Scheduled agent (e.g., weekly) that runs idea-hunt angles across a configured topic list
- Deduplicates against prior runs so only novel findings surface
- Writes results to `thoughts/shared/ideas/` or posts a digest comment on a tracking issue
- Could integrate with the dream-loop or run as a separate launchd job

## Open Questions

- Is this different enough from idea-hunt to warrant its own skill, or is it a scheduling wrapper around it?
- What topics would be configured — user-defined list, or inferred from active tickets?
- How does dedup work across runs — by repo URL, by title similarity, by ralph-knowledge lookup?
- Output: file per run, or accumulated into a living digest?

## Related

- `/ralph-hero:idea-hunt` — the existing on-demand version of this
- `thoughts/shared/ideas/2026-02-25-idea-hunt-synthesis.md` — prior idea-hunt output
- `scripts/dream/` — pattern for scheduled autonomous pipeline work
