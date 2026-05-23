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

You compose three primitives:

1. `narrative-synthesis.md` rules → `Agent(subagent_type="ralph-hero:catch-up-agent")` for the catch-up narrative.
2. `ralph_hero__next_actions` MCP tool → ranks work, marks one `recommended: true`. Do NOT pass `openPRs` — the tool fetches them internally.
3. `AskUserQuestion` picker over the ranked directions.

### Step 1: Catch-up narrative

Dispatch:

```
Agent(
  subagent_type="ralph-hero:catch-up-agent",
  description="Catch-up narrative",
  prompt="Synthesize the catch-up narrative for this session."
)
```

Capture the returned text. The 200-event activity payload stays in the sub-agent's context, not yours. If the sub-agent returns empty or errors, skip the narrative paragraph and proceed.

### Step 2: Compute directions

Call `ralph_hero__next_actions` with `limit=3, audience="human"`. Capture `directions[]`.

### Step 3: Render briefing

Output ≤ 40 lines total. Structure:

1. The catch-up narrative verbatim (one paragraph, 2-4 sentences). If empty, skip.
2. One synthesized sentence introducing the recommendations, naming the recommended pick. **Never quote `direction.reason` verbatim** — see `next-action-ranking.md` for synthesis rules.
3. The picker (Step 4).

**Empty directions case**: if `directions` is empty, output:

> Things look calm — nothing stuck, nothing on fire.

Skip the picker. Stop.

### Step 4: Picker

Present `AskUserQuestion` with options derived 1:1 from `directions[]`. The `recommended: true` option is FIRST (default). Per-option labels, descriptions, and the dispatch table all live in `next-action-ranking.md`. Add a final option: `{label: "Work through these in order", description: "Address each direction in order"}`.

If `CLAUDE_NONINTERACTIVE` is set or `AskUserQuestion` is unavailable, skip the picker and end with: *"Recommended: [recommended action] — invoke explicitly to proceed."*

### Step 5: Dispatch

Based on the picked option, dispatch via `Agent()` or `Skill()` per the dispatch table in `next-action-ranking.md`. For "Work through these in order", dispatch sequentially in `directions[]` order, noting before each subsequent dispatch: *"Earlier actions may have changed board state."*

After dispatch completes, output `Session complete.`

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
