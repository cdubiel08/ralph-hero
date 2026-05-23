---
description: Orientation companion — catches you up on what changed since you last
  checked, then surfaces actionable directions with a recommended default. Folds
  the ralph-hero hello, catch-up, status, report, and cos verbs. Default flow is
  narrative + interactive picker; --mode flag selects narrative / dashboard /
  report sub-surfaces.
argument-hint: "[--mode {narrative,dashboard,report}] [--dry-run] [--window N] [--status ON_TRACK|AT_RISK|OFF_TRACK] [--with-trends]"
context: inline
allowed-tools:
  - Read
  - Skill
  - Agent
  - AskUserQuestion
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__recent_activity
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__next_actions
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__pipeline_dashboard
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_status_update
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__metrics_trends
---

# /ralph:catch-up — Orientation

The unified orientation verb. Default flow is narrative + picker (matches the old
`/ralph-hero:hello`). The `--mode` flag selects a single-surface alternative.

## Mode dispatch

| Mode | Behavior | Equivalent to |
|---|---|---|
| (default, no `--mode`) | Narrative paragraph + AskUserQuestion picker over `next_actions`, then Agent dispatch | `/ralph-hero:hello` |
| `--mode narrative` | 2-4 sentence narrative only, no picker, no dispatch | `/ralph-hero:catch-up` |
| `--mode dashboard` | Raw `pipeline_dashboard` render (markdown / ascii / json) | `/ralph-hero:status` |
| `--mode report` | Compose status update; post via `create_status_update` (pass `--dry-run` to skip posting) | `/ralph-hero:report` |
| `--help` / `-h` | Print this table and exit | — |

> The `cos` family (`desk`, `remote`, `unattended`) is deliberately CLI-only —
> see `ralph cos --help`. Those modes shell out to a local LLM specifically to
> avoid spawning Claude Code (phone-friendly, scheduled, offline).

## Default flow

_(Filled by Phase 2.)_

## --mode narrative

_(Filled by Phase 3.)_

## --mode dashboard

_(Filled by Phase 3.)_

## --mode report

_(Filled by Phase 4.)_

## References

- `narrative-synthesis.md` — catch-up narrative tone rules + cursor mechanics
- `next-action-ranking.md` — signal-cue table, picker label rules, dispatch table
- `dashboard-render.md` — pipeline render rules + negative-constraint prose
- `report-composition.md` — markdown template, status determination, --with-trends
