---
date: 2026-05-03
github_issue: 985
github_url: https://github.com/cdubiel08/ralph-hero/issues/985
topic: "Why the catch-up skill writes ~/.ralph-hero/cursors/catch-up.json via the LLM Write tool instead of a hook"
tags: [research, catch-up, hello, cursor, hooks, mcp-server, activity-log]
status: complete
type: research
git_commit: 462d3de14c6f8c7135031c5f90b42eb12f456ce5
git_branch: main
---

# Research: Why the catch-up skill writes its cursor via the LLM Write tool

## Prior Work

- builds_on:: [[2026-05-02-hello-composable-rewrite]] (plan — primary design intent for cursor management; explicitly specifies LLM-driven Write of `~/.ralph-hero/cursors/catch-up.json` in phase 4)
- builds_on:: [[2026-05-02-hello-composable-rewrite]] (research — four-layer design: activity log → MCP tools → skills → wrapper)
- builds_on:: [[2026-05-03-GH-0967-record-activity-stdin-json]] (plan — adjacent fix to `record-activity.sh` stdin handling; same activity-log subsystem)
- builds_on:: [[2026-04-30-group-GH-0921-hello-directions-implementation]] (plan — earlier hello/directions work that preceded the composable rewrite)

## Research Question

After the recent /hello revamp, the user observes Claude literally calling `Write(~/.ralph-hero/cursors/catch-up.json, {"last_event_ts": "<timestamp>"})` during /hello. They expected this to be an explicit hook calling a bash script, not an LLM tool call. Document where this Write originates, why the design put it in the LLM's hands, and what surrounding infrastructure exists.

## Summary

The `Write` call comes from **Step 5 of the catch-up skill** (`plugin/ralph-hero/skills/catch-up/SKILL.md:59-67`), which explicitly instructs the LLM:

> Only on successful synthesis: write `~/.ralph-hero/cursors/catch-up.json` with `{ "last_event_ts": "<cursor_advanced_to value from response>" }`. Use the Write tool. Create the parent directory if needed.

This was the **original design from day one** — the catch-up skill landed in commit `2b15f1f feat(GH-940): add catch-up skill for narrative synthesis [phase 4]` (2026-05-02), and the parent plan `thoughts/shared/plans/2026-05-02-hello-composable-rewrite.md:1648-1666` specified the LLM-driven Write in the same wording. The skill's frontmatter `allowed-tools` (line 10-13) explicitly lists `Write` for this purpose.

The MCP server holds **zero cursor state**. `cursor_advanced_to` is a pure derived value computed server-side from the last event's timestamp; the cursor *file* is read and written exclusively by the catch-up skill via the `Read` and `Write` tools. The activity log itself, however, is written by a hook (`record-activity.sh`), so the precedent for hook-driven JSON state mutation already exists in the same subsystem.

The skill states a "cursor only advances on successful synthesis" rule (lines 75-77). On inspection this rule is not load-bearing: the cursor is a "what events have been consumed" pointer, and any caller (the catch-up skill in /hello, a future agent, a programmatic invoker) that successfully calls `ralph_hero__recent_activity` has by definition consumed those events. The `cursor_advanced_to` value already encodes the right answer (`null` for the empty case, the last-event timestamp otherwise), so a `PostToolUse` hook matched on `ralph_hero__recent_activity` could read `tool_response.cursor_advanced_to` from stdin and write the cursor file directly — the worst case from removing the LLM-side gate is that an agent crash between tool call and prose output costs one narrative (the next invocation says "nothing's changed" instead). The "successful synthesis" wording reads as cautious rationalization for placing the Write inside the LLM context, not as a structural requirement.

## Detailed Findings

### Where the Write tool call originates

`plugin/ralph-hero/skills/catch-up/SKILL.md:1-79` is the entire skill definition. The relevant blocks:

**Frontmatter** (lines 1-14):
```yaml
allowed-tools:
  - Read
  - Write
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__recent_activity
```
Only three tools: `Read` (for the cursor and `MEMORY.md`), `Write` (for the cursor), and `recent_activity` (for events). No `Bash`, no `Skill`, no `Agent`.

**Step 1 — Read cursor** (lines 20-22):
> Read `~/.ralph-hero/cursors/catch-up.json`. If it exists, parse `last_event_ts`. If missing or corrupt, default the cursor to 24 hours before now.

**Step 5 — Advance cursor** (lines 59-67):
> Only on successful synthesis: write `~/.ralph-hero/cursors/catch-up.json` with: `{ "last_event_ts": "<cursor_advanced_to value from response>" }`. Use the Write tool. Create the parent directory if needed.

**Constraints** (lines 73-78):
> - Cursor only advances on successful synthesis
> - Never advance cursor when `recent_activity` errors

The `Write(<timestamp>)` invocation the user is seeing in /hello is this Step 5 firing.

### How /hello reaches the catch-up Write

`plugin/ralph-hero/skills/hello/SKILL.md:28-31` (Step 1 of hello):

> 1. **Catch-up narrative**: Invoke `Skill("ralph-hero:catch-up")`. Capture the returned text.

`Skill()` invocation forks into the catch-up skill's own context (hello SKILL.md line 139: *"catch-up runs in its own context (Skill() is fork-safe)"*). Inside that fork, the catch-up skill executes its 6 steps including the Step 5 Write. The hello wrapper itself never calls Write — it just consumes the returned narrative text.

### How `cursor_advanced_to` is computed (server-side, pure)

`mcp-server/src/lib/activity.ts:98-100`:
```typescript
events.sort((a, b) => a.ts.localeCompare(b.ts));
const limited = events.slice(0, config.limit);
const cursor = limited.length > 0 ? limited[limited.length - 1].ts : null;
```

`cursor_advanced_to` is the verbatim `ts` field of the chronologically-last event in the windowed result, or `null` when no events match. It is not `now()`, not synthetic, and not derived from any cursor file the server reads — the server is **stateless** with respect to cursor management.

The `recent_activity` tool registration confirms the stateless contract (`mcp-server/src/tools/activity-tools.ts:12-42`). The tool takes `since`, `until`, `kinds`, `category`, `project`, `limit` and returns `{ events, cursor_advanced_to, skipped_lines }`. No cursor file is read or written by the tool.

### Cursor file shape — single field

The cursor file the user inspected:
```json
{ "last_event_ts": "2026-05-03T16:04:31.000Z" }
```

One field, copied verbatim from `cursor_advanced_to`. No transformation.

### Existing hook patterns that already do mechanical state writes

The plugin already has hooks doing exactly the kind of "read tool input/output, mutate a state file" work the user expected here:

| Hook | Script | Wired in `hooks.json` | What it writes |
|---|---|---|---|
| Activity log writer | `plugin/ralph-hero/hooks/scripts/record-activity.sh:24` | `SessionStart` (line 30) + `PostToolUse` matcher-less (line 165) | `~/.ralph-hero/activity/YYYY/MM/DD.jsonl` (append-only JSONL) |
| Outcome collector | `plugin/ralph-hero/hooks/scripts/outcome-collector.sh:22` | `PostToolUse` matched on `ralph_hero__save_issue` and `Write` | `~/.ralph-hero/knowledge.db` (sqlite, WAL mode) |
| Superpowers bridge | `plugin/ralph-hero/hooks/scripts/superpowers-bridge.sh:72-85` | `PostToolUse` on `Write` | Constructs JSON via `jq -n --arg` from `tool_response` |
| Set skill env | `plugin/ralph-hero/hooks/scripts/set-skill-env.sh` | `SessionStart` (per-skill) | `$CLAUDE_ENV_FILE` (appended bash exports) |

All four read stdin JSON via the `read_input` / `get_field` helpers in `plugin/ralph-hero/hooks/scripts/hook-utils.sh`, which expose `tool_name`, `tool_input`, and `tool_response` to bash. The `outcome-collector.sh:88-99` and `superpowers-bridge.sh:72-85` patterns demonstrate that PostToolUse hooks can already extract values from `tool_response` and persist them to small JSON files — the same shape of work the catch-up cursor write does.

The note at `hooks.json:6` reads:
> Most hooks are registered via skill frontmatter for granular scoping. Plugin-level hooks apply across all skills.
> SessionStop, PostSkillInvoke, and agent-spawn/agent-complete are not currently surfaced by the harness; they are intentionally omitted.

So `PostToolUse` is the harness event available for matching `ralph_hero__recent_activity` calls. There is no `PostSkillInvoke` to gate on "catch-up skill finished synthesizing successfully."

### The activity log itself IS hook-written

`plugin/ralph-hero/hooks/scripts/record-activity.sh` writes the activity log (the *source* the catch-up cursor tracks against). It is wired in `hooks.json:30,165` to fire on `SessionStart` and `PostToolUse` (matcher-less). Each invocation appends one JSON line to `${RALPH_ACTIVITY_DIR:-$HOME/.ralph-hero/activity}/YYYY/MM/DD.jsonl` and categorizes the event as `"work"` or `"meta"` (script lines 77-121). The script exits 0 unconditionally — it is best-effort and never blocks the pipeline.

So in the catch-up subsystem, the *write* side of the activity log is hook-driven, but the *cursor* tracking that consumption progress is LLM-driven. The asymmetry is the user's observation.

### The "successful synthesis" gate is not load-bearing

The skill's constraint section (lines 73-78) and Step 5 lead-in ("Only on successful synthesis") read as a state machine the LLM enforces:

| Tool result | LLM action | Cursor advance under current design? |
|---|---|---|
| `events: []` (empty) | Output the canned "Nothing's changed" sentence (Step 4) | No (skill says "Do not advance the cursor. Stop here.") |
| `events: [...]`, synthesis succeeds | Output 2-4 sentence narrative | Yes (Step 5 Write) |
| `events: [...]`, recent_activity errors before return | LLM never gets `cursor_advanced_to` | No |
| `events: [...]`, LLM fails during synthesis | LLM never reaches Step 5 | No |

The empty case is already handled by the data: `cursor_advanced_to` is `null` (from `activity.ts:100`), so a `PostToolUse` hook reading `tool_response.cursor_advanced_to` from stdin would naturally skip the write when there's nothing to advance to. The error case is also already handled — `PostToolUse` hooks only fire when the tool returns successfully, so a recent_activity error means no hook invocation, no cursor write.

The only path the gate genuinely covers is "tool returned events, then the LLM crashed before producing prose." The cost of getting that wrong (cursor advances anyway, the events are marked seen, the next invocation says "nothing's changed" instead of belatedly summarizing them) is one missed narrative, not a correctness problem. The cursor is a "what events have been read" pointer; the synthesis is a separate concern.

A `PostToolUse` matcher on `ralph_hero__recent_activity` calling a script that does roughly:

```bash
cursor=$(echo "$RALPH_HOOK_INPUT" | jq -r '.tool_response.cursor_advanced_to // empty')
[[ -n "$cursor" ]] && {
  mkdir -p ~/.ralph-hero/cursors
  jq -n --arg ts "$cursor" '{last_event_ts: $ts}' > ~/.ralph-hero/cursors/catch-up.json
}
```

would replicate the meaningful behavior without any LLM involvement, in the same pattern as `outcome-collector.sh:88-99` and `superpowers-bridge.sh:72-85`. The skill could then drop `Write` from `allowed-tools` and remove Step 5 entirely. The "what does the LLM uniquely know that justifies it owning this Write" question doesn't have a load-bearing answer.

### What the cursor-management-via-LLM looks like in practice

Each /hello invocation produces this pattern in the conversation transcript:

1. Hello dispatches `Skill("ralph-hero:catch-up")` (forked context).
2. Inside catch-up: `Read(~/.ralph-hero/cursors/catch-up.json)` → parses `last_event_ts`.
3. `recent_activity(since=last_event_ts, category="work", limit=200)` → returns `events[]` and `cursor_advanced_to`.
4. LLM synthesizes prose narrative.
5. `Write(~/.ralph-hero/cursors/catch-up.json, {"last_event_ts": "<value>"})` — this is the Write the user observed.
6. Catch-up returns the narrative text to /hello.

The Write at step 5 is purely mechanical: copy one string from the tool response into the file. No reasoning is involved in producing the value.

## Code References

- `plugin/ralph-hero/skills/catch-up/SKILL.md:10-13` — `allowed-tools` includes `Write`
- `plugin/ralph-hero/skills/catch-up/SKILL.md:20-22` — Step 1 reads cursor file
- `plugin/ralph-hero/skills/catch-up/SKILL.md:59-67` — Step 5 instructs LLM to use Write tool for cursor
- `plugin/ralph-hero/skills/catch-up/SKILL.md:73-78` — Constraints establishing "advance only on successful synthesis"
- `plugin/ralph-hero/skills/hello/SKILL.md:28-31` — /hello dispatches catch-up via `Skill()`
- `plugin/ralph-hero/skills/hello/SKILL.md:139` — comment confirming `Skill()` forks into separate context
- `plugin/ralph-hero/mcp-server/src/lib/activity.ts:38-42` — `ActivityReadResult` type definition
- `plugin/ralph-hero/mcp-server/src/lib/activity.ts:98-100` — `cursor_advanced_to` computation
- `plugin/ralph-hero/mcp-server/src/tools/activity-tools.ts:8-10` — `defaultActivityRoot()` resolves `RALPH_ACTIVITY_DIR` or `~/.ralph-hero/activity`
- `plugin/ralph-hero/mcp-server/src/tools/activity-tools.ts:12-42` — `recent_activity` tool registration; no cursor I/O
- `plugin/ralph-hero/mcp-server/src/index.ts:486` — `registerActivityTools(server)` call site
- `plugin/ralph-hero/hooks/hooks.json:30` — `SessionStart` hook calling `record-activity.sh session_start`
- `plugin/ralph-hero/hooks/hooks.json:165` — matcher-less `PostToolUse` calling `record-activity.sh tool_called`
- `plugin/ralph-hero/hooks/scripts/record-activity.sh:24` — activity log root resolution
- `plugin/ralph-hero/hooks/scripts/record-activity.sh:77-121` — work/meta categorization
- `plugin/ralph-hero/hooks/scripts/outcome-collector.sh:22` — knowledge DB path resolution
- `plugin/ralph-hero/hooks/scripts/outcome-collector.sh:88-99` — INSERT pattern reading `tool_response` from stdin
- `plugin/ralph-hero/hooks/scripts/superpowers-bridge.sh:72-85` — `jq -n --arg` JSON construction from `tool_response`
- `plugin/ralph-hero/hooks/scripts/hook-utils.sh` — `read_input`, `get_field` helpers used by all hooks
- `plugin/ralph-hero/hooks/hooks.json:6` — note explaining which harness events are surfaced (`SessionStart`, `PreToolUse`, `PostToolUse`); `PostSkillInvoke` and `SessionStop` are intentionally omitted
- `~/.ralph-hero/cursors/catch-up.json` — current cursor: `{ "last_event_ts": "2026-05-03T16:04:31.000Z" }`

## Architecture Documentation

### Subsystem layers (current state)

```
┌──────────────────────────────────────────────────────────┐
│  /hello SKILL          (composition wrapper)             │
│   └── Skill("ralph-hero:catch-up")  ← forks context      │
└──────────────────────────────────────────────────────────┘
                           │
┌──────────────────────────▼───────────────────────────────┐
│  catch-up SKILL                                          │
│   1. Read(~/.ralph-hero/cursors/catch-up.json)           │
│   3. recent_activity(since=cursor)                       │
│   4. LLM synthesizes prose                               │
│   5. Write(~/.ralph-hero/cursors/catch-up.json, {...})   │ ◄── observed Write
└──────────────────────────────────────────────────────────┘
                           │
┌──────────────────────────▼───────────────────────────────┐
│  ralph_hero__recent_activity  (MCP tool, stateless)      │
│   reads JSONL from RALPH_ACTIVITY_DIR                    │
│   returns { events, cursor_advanced_to, skipped_lines }  │
└──────────────────────────────────────────────────────────┘
                           ▲
┌──────────────────────────┴───────────────────────────────┐
│  record-activity.sh  (PostToolUse hook, matcher-less)    │
│   appends to ~/.ralph-hero/activity/YYYY/MM/DD.jsonl     │ ◄── existing hook pattern
└──────────────────────────────────────────────────────────┘
```

### Ownership boundaries

- **MCP server**: pure read/compute. No state files written.
- **Hooks**: write the activity log (`record-activity.sh`), the knowledge DB (`outcome-collector.sh`), and `$CLAUDE_ENV_FILE` (`set-skill-env.sh`). Read `tool_input` and `tool_response` from stdin.
- **Skills**: read MEMORY.md and the cursor; write the cursor.
- **Cursor file** (`~/.ralph-hero/cursors/catch-up.json`): owned end-to-end by the catch-up skill. No other component reads or writes it.

### Data dependencies

- The cursor file's `last_event_ts` value is always copied verbatim from the tool's `cursor_advanced_to` response field. There is no transformation, no LLM reasoning, no enrichment.
- The cursor advance is *gated* on the LLM successfully producing a narrative — Step 4 (empty case) and Step 5 (advance) are mutually exclusive paths.
- The harness exposes `PostToolUse` for matching tool calls but does **not** expose `PostSkillInvoke` or `SessionStop` (`hooks.json:6`).

## Historical Context (from thoughts/)

The hello composable rewrite is decomposed across phases 1-6 (epic GH-936, phases via GH-937/940/941/942). Per `thoughts/shared/plans/2026-05-02-hello-composable-rewrite.md`:

- **Phases 1 & 3** (multiple sub-issues): activity log foundation — `record-activity.sh` + `recent_activity` MCP tool. Wires the hook-driven write side and the stateless MCP read side.
- **Phase 4 (GH-940)**: catch-up skill. The plan (lines 1576-1709) specifies the LLM-driven cursor Write in the same wording as the final SKILL.md.
- **Phase 5 (GH-941)**: /hello rewritten as a thin composition wrapper that calls `Skill("ralph-hero:catch-up")`.

The plan's verification step (line 1578) explicitly tests the LLM-driven cursor write:
> Verification at phase end: Invoking `/ralph-hero:catch-up` produces a 2-4 sentence narrative; cursor file at `~/.ralph-hero/cursors/catch-up.json` advances; second invocation says "nothing's changed."

The plan's seed step (lines 1691-1696) bootstraps the cursor with a literal echo:
```bash
mkdir -p ~/.ralph-hero/cursors ~/.ralph-hero/activity/2026/05
echo '{"last_event_ts":"2026-05-01T00:00:00Z"}' > ~/.ralph-hero/cursors/catch-up.json
```

So the cursor format and location were fixed during planning, and the LLM-driven Write was the explicit deliverable for phase 4.

## Related Research

- `thoughts/shared/research/2026-05-02-hello-composable-rewrite.md` — Original research spec for the four-layer composable design.
- `thoughts/shared/plans/2026-05-02-hello-composable-rewrite.md` — Master plan, 6 phases.
- `thoughts/shared/plans/2026-05-03-GH-0967-record-activity-stdin-json.md` — Adjacent fix to `record-activity.sh` stdin handling.
- `thoughts/shared/plans/2026-04-30-group-GH-0921-hello-directions-implementation.md` — Predecessor hello/directions work.

## Open Questions

- Whether the original GH-940 author had a specific failure mode in mind when writing the "only on successful synthesis" rule, or whether it was defensive boilerplate. Git history shows the rule landed in the same commit as the rest of the skill (`2b15f1f`), so there is no incremental commit message explaining its motivation.
- Whether any future caller of `ralph_hero__recent_activity` (e.g., a non-skill agent, a CLI script, a remote trigger) would need different cursor semantics — i.e., whether centralizing cursor management in a `PostToolUse` hook would lock all callers into the same advancement policy. Today there is only one caller (the catch-up skill), so this is hypothetical.
