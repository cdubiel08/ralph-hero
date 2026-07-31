---
description: Orientation companion — catches you up on what changed since you last
  checked, surfaces ranked next actions with a recommended pick, composes and
  posts a status report, or walks the full human queue (decisions, unblocks,
  incubating thoughts) in one sitting. Use whenever the user asks "what's
  going on", "what should I work on", "catch me up", "show me the board",
  "post a status update", "daily brief", "walk the queue", "empty the human
  queue", or starts a session wanting orientation. --mode flag selects
  report / brief sub-surfaces.
argument-hint: "[--mode {report,brief}] [--dry-run] [--window N] [--status ON_TRACK|AT_RISK|OFF_TRACK] [--with-trends] [--prepare] [--loop [duration]]"
context: inline
allowed-tools:
  - Read
  - Glob
  - Grep
  - Bash
  - Skill
  - Agent
  - AskUserQuestion
  - PushNotification
  - mcp__plugin_ralph_ralph-github__ralph_hero__recent_activity
  - mcp__plugin_ralph_ralph-github__ralph_hero__next_actions
  - mcp__plugin_ralph_ralph-github__ralph_hero__pipeline_dashboard
  - mcp__plugin_ralph_ralph-github__ralph_hero__create_status_update
  - mcp__plugin_ralph_ralph-github__ralph_hero__metrics_trends
  - mcp__plugin_ralph_ralph-github__ralph_hero__get_issue
  - mcp__plugin_ralph_ralph-github__ralph_hero__create_comment
---

# /ralph:catch-up — Orientation

The unified orientation verb. The `--mode` flag selects a single-surface alternative.

## Step 0: Flag guards

**`--auto` refusal** — if `--auto` appears in `$ARGUMENTS`, emit the following and STOP (see `ralph/skills/shared/auto-alias.md` § Refusal targets):

```
--auto is not supported for this verb (interactive / single-artifact / one-shot). See ralph/CLAUDE.md § Loop suitability for the canonical detail.
```

**`--loop` gate** — use the arg-parsing snippet from `ralph/skills/shared/loop-wrapper.md` § Arg-parsing snippet (sets `LOOP_RAW`, `LOOP_INTERVAL`, `STRIPPED_ARGS`). If `LOOP_RAW` is set:

- **`--mode report`** → allowed. Default interval `1d`. Use `catch-up:report` manifest row — heartbeat, no `Queue empty.` terminal; re-fires on clock.
  - Dry-run default: unless `--post` is in `$ARGUMENTS` OR `RALPH_CATCH_UP_HEARTBEAT_POST=true`, append `--dry-run` to `STRIPPED_ARGS` before wrapping (compose + print only; do NOT call `create_status_update`).
  - Emit `Skill("loop", args="${LOOP_INTERVAL:-1d} /ralph:catch-up --mode report ${STRIPPED_ARGS}\n\n<continuation from loop-wrapper.md manifest>")` then STOP.
- **Any other mode** (default/brief) → emit refusal from `loop-wrapper.md` § Refusal message, then STOP. `--mode brief` stays refused here even with `--prepare` set — brief is an interactive sitting; `--prepare`'s daily cadence is owned by the #1555 scheduled task, not `/loop`.

## Mode dispatch

| Mode | Behavior |
|---|---|
| (default, no `--mode`) | Narrative paragraph + AskUserQuestion picker over `next_actions`, then Agent dispatch |
| `--mode report` | Compose status update; post via `create_status_update` (pass `--dry-run` to skip posting) |
| `--mode brief` | Daily sitting: status header + human-queue walk (decisions → unblocks → thoughts) + read-only flagged tail |
| `--help` / `-h` | Print this table and exit |

## Default flow

You compose three primitives:

1. `narrative-synthesis.md` rules → `Agent(subagent_type="ralph:catch-up-agent")` for the catch-up narrative.
2. `ralph_hero__next_actions` MCP tool → ranks work, marks one `recommended: true`. Do NOT pass `openPRs` — the tool fetches them internally.
3. `AskUserQuestion` picker over the ranked directions.

### Step 1: Catch-up narrative

Dispatch:

```
Agent(
  subagent_type="ralph:catch-up-agent",
  description="Catch-up narrative",
  prompt="Synthesize the catch-up narrative for this session. Follow the synthesis procedure in ${CLAUDE_PLUGIN_ROOT}/skills/catch-up/narrative-synthesis.md exactly (cursor read, recent_activity call shape, empty/populated/long-absence cases, tone rules, output contract). Return only the narrative text."
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

## --mode report

Parse arguments:

- `--dry-run`: compose but do not post
- `--window N`: override the time window in days (default 7)
- `--status ON_TRACK|AT_RISK|OFF_TRACK`: override auto-determined status
- `--with-trends`: append a Trends section (sparklines + 1d/7d/30d deltas)

Compose per `report-composition.md`:

1. Fetch `ralph_hero__pipeline_dashboard` with `format="json", includeHealth=true, includeMetrics=true, doneWindowDays=<window>, velocityWindowDays=<window>`.
2. Handle the metrics-absent fallback per `report-composition.md`.
3. Compose the markdown body using the template in `report-composition.md`.
4. If `--with-trends`, call `ralph_hero__metrics_trends` with `format="markdown"` and append under `## Trends` only when ≥2 snapshots exist.
5. Determine final status: `--status` override > `metrics.status` > fallback.

**Heartbeat dry-run default**: when invoked via `--loop` without an explicit `--post` flag and `RALPH_CATCH_UP_HEARTBEAT_POST` is unset, `--dry-run` is implicitly active. The skill composes the report, writes the markdown body to stdout, appends the literal hint line `> hint: to actually post this status update, re-run with --post (or set RALPH_CATCH_UP_HEARTBEAT_POST=true).`, and exits WITHOUT calling `create_status_update`. Non-loop invocations preserve post-by-default behavior. Opt-in to heartbeat-posting: explicit `--post` OR `RALPH_CATCH_UP_HEARTBEAT_POST=true`.

If `--dry-run`: display the composed body + determined status + `Dry run complete. No status update posted.` Stop.

Otherwise: call `ralph_hero__create_status_update` with `{status, body}`. Display the response: status update ID + status + first 200 chars of body. Print `Status update posted successfully.`

## --mode brief

Parse `--prepare` from `$ARGUMENTS`.

**If `--prepare` is present**: read `~/.ralph-hero/brief/last-prepared`. If its content equals today's date (local, `YYYY-MM-DD`), emit `Brief already prepared today.` and STOP — no push, no prompts, no further reads. Otherwise follow `brief-composition.md` § Prepare (headless).

**Otherwise**: follow `brief-composition.md` for the full interactive sitting: status header, decision walk, unblock walk, incubating-thought walk, read-only flagged tail, closing summary.

## References

- `narrative-synthesis.md` — catch-up narrative tone rules + cursor mechanics
- `next-action-ranking.md` — signal-cue table, picker label rules, dispatch table
- `dashboard-render.md` — pipeline render rules + negative-constraint prose
- `report-composition.md` — markdown template, status determination, --with-trends
- `brief-composition.md` — two-source read, status header, walk order + dispatch table, render rules, closing summary
