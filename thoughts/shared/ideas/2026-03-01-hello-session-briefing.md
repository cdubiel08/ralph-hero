---
date: 2026-03-01
status: formed
author: user
tags: [ux, session-start, dashboard, insights, command, workflow]
github_issue: 480
---

# "Hello" Session Briefing Command

## The Idea

A `/hello` command (or similar) that runs at session start and gives you a quick situational briefing — 3 actionable insights pulled from recent activity, urgent issues, and pipeline state. It then offers to act on those insights immediately, turning a passive dashboard into an interactive launch pad.

## Why This Matters

- Starting a session cold means you have to manually check the board, recent PRs, and figure out what's important — this automates that ramp-up
- Surfaces things you might miss (stale PRs waiting for review, blocked issues, WIP violations)
- Reduces decision fatigue by curating the top 3 things worth your attention right now

## Rough Shape

- Pulls data from multiple sources:
  - **Recent activity**: merged/open PRs in last 24-48h, newly created issues, recently closed items
  - **Urgent items**: high-priority issues, items stuck in a phase too long, blocked dependencies
  - **Pipeline snapshot**: brief counts per phase, WIP violations, health indicators
- Synthesizes into exactly 3 insights, ranked by urgency/impact:
  ```
  Good morning! Here's what's happening:

  1. PR #42 has been open 3 days with no review — it's blocking GH-189
  2. 2 issues are stuck in "Plan in Review" for 5+ days — may need attention
  3. GH-201 (High priority) just moved to Ready for Plan — it's next in line

  Want me to act on any of these? (1/2/3/all/skip)
  ```
- If user picks one, it routes to the appropriate skill:
  - Stale PR → `/ralph-hero:ralph-merge` or open in browser
  - Stuck issues → `/ralph-hero:ralph-review` or `/ralph-hero:ralph-triage`
  - Next actionable issue → `/ralph-hero:ralph-research` or `/ralph-hero:ralph-plan`
- "all" runs through them sequentially
- "skip" just leaves the briefing as informational

## Open Questions

- Should this be `/hello`, `/ralph-hero:hello`, `/ralph-hero:good-morning`, or fold into an enhanced `/ralph-hero:ralph-status`?
- How far back should "recent activity" look — 24h? 48h? Since last session?
- Should it learn preferences over time (e.g., always show PR status first if user frequently acts on those)?
- Could it integrate with `pipeline_dashboard` and `project_hygiene` tools that already exist, or does it need its own aggregation logic?

## Related

- `plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts` — existing pipeline_dashboard tool
- `plugin/ralph-hero/mcp-server/src/tools/hygiene-tools.ts` — pick_actionable_issue, project hygiene
- `plugin/ralph-hero/skills/ralph-status/` — current read-only status skill
- `plugin/ralph-hero/skills/ralph-hygiene/` — existing hygiene check skill
