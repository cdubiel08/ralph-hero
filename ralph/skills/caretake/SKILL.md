---
description: All board maintenance, grooming, and reflection in one verb. Triggers on "triage backlog", "clean up board", "scan for stale", "status check", "post-mortem", "capture friction", "retro the session", "trend report", "snapshot metrics", "unblock issue", "answer unblock questions", "collate debug errors", "filer Langfuse errors", "split this issue", "decompose ticket". Default mode is event-driven (reads `--issue NNN` labels and fans out via Skill). Named modes (triage/hygiene/unblock/postmortem/retro/trends/debug/split) each route to a dedicated mode body under `modes/`.
argument-hint: "[--issue NNN | --mode <triage|hygiene|unblock|postmortem|retro|trends|debug|split|all>] [#NNN] [--since <window>] [--auto-confirm] [--question]"
context: inline
model: opus
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh RALPH_COMMAND=caretake"
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/branch-gate.sh"
    - matcher: "mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/split-estimate-gate.sh"
    - matcher: "mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_issue"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/split-size-gate.sh"
    - matcher: "Skill"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/triage-no-skill-dispatch.sh"
  PostToolUse:
    - matcher: "mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/split-estimate-gate.sh"
    - matcher: "mcp__plugin_ralph-hero_ralph-github__ralph_hero__add_sub_issue"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/split-verify-sub-issue.sh"
    - matcher: "mcp__plugin_ralph-hero_ralph-github__ralph_hero__save_issue"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/triage-state-gate.sh"
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/unblock-state-gate.sh"
  Stop:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/triage-postcondition.sh"
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/unblock-request-postcondition.sh"
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/split-postcondition.sh"
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/postmortem-completeness.sh"
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/lock-release-on-failure.sh"
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - Skill
  - Agent
  - Task
  - TaskList
  - TaskGet
  - AskUserQuestion
  - PushNotification
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_issues
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__save_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_comment
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__add_sub_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__add_dependency
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_sub_issues
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__pipeline_dashboard
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__project_hygiene
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__archive_items
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__capture_snapshot
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__metrics_trends
  - mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_record_outcome
  - mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_search
  - mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_recall
---

# /ralph:caretake — Board steward in one verb

All board maintenance flows through this one entrypoint. Eight named modes plus a default event-driven dispatcher. Each mode is a separate body under `modes/`; this top-level SKILL.md only owns arg parsing, dispatch routing, and the heartbeat fan-out.

| Mode | Trigger | Role |
|---|---|---|
| **default** | `/ralph:caretake --issue NNN` | Event-driven: read labels, dispatch the right mode via `Skill()` |
| **all** | `/ralph:caretake` (no args) or `/ralph:caretake --mode all` | Heartbeat fan-out: hygiene + catch-up report + trends |
| **triage** | `/ralph:caretake --mode triage [#NNN]` | Pick oldest untriaged Backlog, assess, route |
| **hygiene** | `/ralph:caretake --mode hygiene` | Scan for archive candidates, stale items, WIP violations |
| **unblock** | `/ralph:caretake --mode unblock [#NNN] [--question]` | Interactive answer OR autonomous request post |
| **postmortem** | `/ralph:caretake --mode postmortem [--plan-doc <path>]` | TaskList-driven structured session post-mortem |
| **retro** | `/ralph:caretake --mode retro` | Capture intra-session friction into research doc |
| **trends** | `/ralph:caretake --mode trends [--since 30d]` | Snapshot + markdown trend report (read-only stdout) |
| **debug** | `/ralph:caretake --mode debug [--since 24h] [--auto-confirm]` | Collate Langfuse errors → file `debug-auto` issues |
| **split** | `/ralph:caretake --mode split [#NNN]` | Split M/L/XL → multiple XS/S sub-issues |

References: [label-routing.md](label-routing.md) (default-mode dispatch table), [outcome-tokens.md](outcome-tokens.md) (per-mode terminal verdicts), [split-decomposition.md](split-decomposition.md) (split-mode strategy + hook contracts).

## Configuration (resolved at load time)

- Owner: !`echo ${RALPH_GH_OWNER:-NOT_SET}`
- Repo: !`echo ${RALPH_GH_REPO:-NOT_SET}`
- Project: !`echo ${RALPH_GH_PROJECT_NUMBER:-NOT_SET}`

## Step 0: Parse arguments + set subcommand scope

**`--auto` alias** — resolve BEFORE `--loop` detection. See `ralph/skills/shared/auto-alias.md`:
- If `--auto` in `$ARGUMENTS` AND `--mode` also present → emit `--auto cannot be combined with explicit --mode; pick one.` and STOP.
- If `--auto` in `$ARGUMENTS` → strip `--auto` token, prepend `--mode triage` to `$ARGUMENTS` (verb=caretake alias row). Continue to `--loop` detection with the rewritten args.

**`--loop` gate** — run the arg-parsing snippet from `ralph/skills/shared/loop-wrapper.md` § Arg-parsing snippet (sets `LOOP_RAW`, `LOOP_INTERVAL`, `STRIPPED_ARGS`). If `LOOP_RAW` is set, route by mode (all use continuation-prompt template from `loop-wrapper.md`):
- `--mode triage` → `caretake:triage` row; `--mode hygiene` → `caretake:hygiene` row; `--mode unblock` (no `--question`) → `caretake:unblock` row; `--mode debug` → `caretake:debug` row; `--mode split` → `caretake:split` row. Emit `Skill("loop", …)` then STOP.
- No args (no `--issue`) → `caretake:default-event` row. Emit `Skill("loop", …)` then STOP.
- `--issue NNN` present, `--mode postmortem`, `--mode retro`, or `--mode unblock --question` → emit refusal from `loop-wrapper.md` § Refusal message, then STOP.
- **`--mode all`** → heartbeat; default interval `1h`. Use `caretake:all` manifest row — no `Queue empty.` terminal; re-fires on clock. Emit `Skill("loop", args="${LOOP_INTERVAL:-1h} /ralph:caretake --mode all ${STRIPPED_ARGS}\n\n<continuation from loop-wrapper.md manifest>")` then STOP.
- **`--mode trends`** → periodic snapshot heartbeat; default interval `6h`. Use `caretake:trends` manifest row — no `Queue empty.` terminal; re-fires on clock. Emit `Skill("loop", args="${LOOP_INTERVAL:-6h} /ralph:caretake --mode trends ${STRIPPED_ARGS}\n\n<continuation from loop-wrapper.md manifest>")` then STOP.

```bash
# Parse $ARGUMENTS into mode + flags. Each mode body sets RALPH_SUBCOMMAND itself
# (so per-mode hook scope picks up the right subcommand even when the caller
# entered this skill via no-arg / --mode all fan-out). The top-level dispatch
# only sets RALPH_SUBCOMMAND for the default-event and `all` paths.
case "$ARGUMENTS" in
  *--issue*)      export RALPH_SUBCOMMAND=default-event ;;
  *--mode\ all*|"") export RALPH_SUBCOMMAND=all ;;
  *)              : ;;  # Mode body sets it
esac
```

## Step 1: Dispatch

- **`--issue NNN`** → default-mode (event-driven). Fetch the issue, inspect labels, dispatch per [label-routing.md](label-routing.md). After dispatch, post a `## Caretaker Action` comment summarizing mode + outcome.
- **`--mode <name>`** → read `modes/<name>.md` and follow its body. The mode body sets `RALPH_SUBCOMMAND=<name>` and runs.
- **No args** or **`--mode all`** → heartbeat fan-out. Invoke serially:
  1. `Skill("ralph:caretake", args="--mode hygiene")`
  2. `Skill("ralph:catch-up", args="--mode report")`
  3. `Skill("ralph:caretake", args="--mode trends")`
  Report consolidated outcome (one line per child).

## Step 2: Emit result line

Each mode body ends by emitting its terminal token (see [outcome-tokens.md](outcome-tokens.md)). The dispatcher does not wrap or rewrite it. The harness extractor reads the token directly.

## Mode bodies

- [modes/triage.md](modes/triage.md) — pick + assess + route (autonomous)
- [modes/hygiene.md](modes/hygiene.md) — scan + optional archive
- [modes/unblock.md](modes/unblock.md) — interactive answer OR autonomous request
- [modes/postmortem.md](modes/postmortem.md) — TaskList-driven session post-mortem
- [modes/retro.md](modes/retro.md) — intra-session friction → research doc
- [modes/trends.md](modes/trends.md) — snapshot + markdown trend report
- [modes/debug.md](modes/debug.md) — collate Langfuse errors
- [modes/split.md](modes/split.md) — M/L/XL → XS/S sub-issues

## Per-mode terminal tokens

The harness reads these from the transcript; do not paraphrase. Full table in [outcome-tokens.md](outcome-tokens.md). Quick reference:

- triage: `TRIAGED <verdict>` | `Queue empty.`
- hygiene: `HYGIENE COMPLETE <N>` | `HYGIENE BLOCKED <reason>`
- unblock (interactive): `UNBLOCK RESOLVED` | `UNBLOCK ESCALATED`
- unblock (autonomous): `UNBLOCK REQUEST POSTED` | `Queue empty.`
- postmortem: `POSTMORTEM <path>` | `POSTMORTEM SKIPPED <reason>`
- retro: `RETRO <path>` | `RETRO SKIPPED <reason>`
- trends: no terminal token (markdown output is the deliverable)
- debug: `DEBUG FILED <N>` | `DEBUG SKIPPED <reason>`
- split: `SPLIT <N>` | `SPLIT SKIPPED <reason>`

## Notes

- **`RALPH_SUBCOMMAND` is set by each mode body** (not by SessionStart). Hooks discriminate against it to no-op when a different mode is active. SessionStart only sets `RALPH_COMMAND=caretake`, which guards all caretake-prefixed hooks at the plugin level.
- **Mode bodies port source-skill workflows verbatim** where possible. Plan 7 is a structural fold; capability changes are out of scope.
- **Old `/ralph-hero:*` caretaker-family skills remain functional** until Plan 10 sunset. Both paths can run side-by-side during the parallel period.
