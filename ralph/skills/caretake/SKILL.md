---
description: All board maintenance, grooming, and reflection in one verb. Triggers on "triage backlog", "clean up board", "scan for stale", "status check", "capture friction", "reflect on the session", "unblock issue", "answer unblock questions", "split this issue", "decompose ticket", "enrich idea files". Default mode is event-driven (reads `--issue NNN` labels and fans out via Skill). Named modes (triage/hygiene/unblock/reflect/split/watch/enrich) each route to a dedicated mode body under `modes/`.
argument-hint: "[--issue NNN | --mode <triage|hygiene|unblock|reflect|split|watch [--kind pr|upstream|issue]|enrich|all>] [#NNN] [--since <window>] [--auto-confirm] [--question] [--loop [duration]] [--auto]"
context: inline
model: sonnet
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
    - matcher: "mcp__plugin_ralph_ralph-github__ralph_hero__get_issue"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/split-estimate-gate.sh"
    - matcher: "mcp__plugin_ralph_ralph-github__ralph_hero__create_issue|mcp__plugin_ralph_ralph-github__ralph_hero__create_sub_issues"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/split-size-gate.sh"
    - matcher: "Skill"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/triage-no-skill-dispatch.sh"
  PostToolUse:
    - matcher: "mcp__plugin_ralph_ralph-github__ralph_hero__get_issue"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/split-estimate-gate.sh"
    - matcher: "mcp__plugin_ralph_ralph-github__ralph_hero__save_issue"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/state-gate.sh caretake:triage triage"
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
  - mcp__plugin_ralph_ralph-github__ralph_hero__get_issue
  - mcp__plugin_ralph_ralph-github__ralph_hero__list_issues
  - mcp__plugin_ralph_ralph-github__ralph_hero__save_issue
  - mcp__plugin_ralph_ralph-github__ralph_hero__create_issue
  - mcp__plugin_ralph_ralph-github__ralph_hero__create_comment
  - mcp__plugin_ralph_ralph-github__ralph_hero__add_sub_issue
  - mcp__plugin_ralph_ralph-github__ralph_hero__create_sub_issues
  - mcp__plugin_ralph_ralph-github__ralph_hero__add_dependency
  - mcp__plugin_ralph_ralph-github__ralph_hero__advance_issue
  - mcp__plugin_ralph_ralph-github__ralph_hero__batch_update
  - mcp__plugin_ralph_ralph-github__ralph_hero__list_sub_issues
  - mcp__plugin_ralph_ralph-github__ralph_hero__pipeline_dashboard
  - mcp__plugin_ralph_ralph-github__ralph_hero__project_hygiene
  - mcp__plugin_ralph_ralph-github__ralph_hero__archive_items
  - mcp__plugin_ralph_ralph-github__ralph_hero__capture_snapshot
  - mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_record_outcome
  - mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_search
  - mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_recall
---

# /ralph:caretake — Board steward in one verb

All board maintenance flows through this one entrypoint. Eight named modes plus a default event-driven dispatcher. Each mode is a separate body under `modes/`; this top-level SKILL.md only owns arg parsing, dispatch routing, and the heartbeat fan-out.

| Mode | Trigger | Role |
|---|---|---|
| **default** | `/ralph:caretake --issue NNN` | Event-driven: read labels, dispatch the right mode via `Skill()` |
| **all** | `/ralph:caretake` (no args) or `/ralph:caretake --mode all` | Heartbeat fan-out: hygiene + watch + enrich + catch-up report |
| **triage** | `/ralph:caretake --mode triage [#NNN]` | Pick oldest untriaged Backlog, assess, route |
| **hygiene** | `/ralph:caretake --mode hygiene` | Scan for archive candidates, stale items, WIP violations |
| **unblock** | `/ralph:caretake --mode unblock [#NNN] [--question]` | Interactive answer OR autonomous request post |
| **reflect** | `/ralph:caretake --mode reflect` | Capture intra-session friction into research doc |
| **split** | `/ralph:caretake --mode split [#NNN]` | Split M/L/XL → multiple XS/S sub-issues |
| **watch** | `/ralph:caretake --mode watch [--kind pr\|upstream\|issue]` | Resolve `WAIT-*`-parked items by kind: `pr` (blocked:pr-NNN → PR merge/close), `upstream` (blocked:upstream → external condition), `issue` (blockedBy edge → all blockers closed). Bare invocation sweeps all three kinds serially. |
| **enrich** | `/ralph:caretake --mode enrich` | Background-enrich `status: draft` idea files (codebase + prior art + related issues), flip to `status: forming` |

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
- `--mode triage` → `caretake:triage` row; `--mode hygiene` → `caretake:hygiene` row; `--mode unblock` (no `--question`) → `caretake:unblock` row; `--mode split` → `caretake:split` row. Emit `Skill("loop", …)` then STOP.
- No args (no `--issue`) → bare invocation runs the **heartbeat fan-out** (`RALPH_SUBCOMMAND=all`; see the dispatch body), so loop it with the `caretake:all` heartbeat row — default interval `1h`, **no `Queue empty.` terminal**, re-fires on clock. Emit `Skill("loop", args="${LOOP_INTERVAL:-1h} /ralph:caretake ${STRIPPED_ARGS}\n\n<continuation from loop-wrapper.md manifest, caretake:all row>")` then STOP. (The `caretake:default-event` row is the `--issue NNN`-scoped trigger-drain path — NOT the bare no-arg fan-out.)
- `--issue NNN` present, `--mode reflect`, or `--mode unblock --question` → emit refusal from `loop-wrapper.md` § Refusal message, then STOP.
- **`--mode all`** → heartbeat; default interval `1h`. Use `caretake:all` manifest row — no `Queue empty.` terminal; re-fires on clock. Emit `Skill("loop", args="${LOOP_INTERVAL:-1h} /ralph:caretake --mode all ${STRIPPED_ARGS}\n\n<continuation from loop-wrapper.md manifest>")` then STOP.
- **`--mode watch`** (with or without `--kind`) → heartbeat; default interval `1h`. Use `caretake:watch` manifest row — no `Queue empty.` terminal; re-fires on clock. Emit `Skill("loop", args="${LOOP_INTERVAL:-1h} /ralph:caretake --mode watch ${STRIPPED_ARGS}\n\n<continuation from loop-wrapper.md manifest, caretake:watch row>")` then STOP.

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
  2. `Skill("ralph:caretake", args="--mode watch")`
  3. `Skill("ralph:caretake", args="--mode enrich")`
  4. `Skill("ralph:catch-up", args="--mode report")`
  Report consolidated outcome (one line per child — 4 total). `--mode watch` (bare, no `--kind`) sweeps all three watcher kinds serially in this one child. The watch and enrich children run before report so the dashboards and brief reflect post-enrichment board/file state; all no-op (`IDLE` / `Queue empty.`) on an empty board/queue, or `SKIPPED` when the heartbeat fires off `main`.

## Step 2: Emit result line

Each mode body ends by emitting its terminal token (see [outcome-tokens.md](outcome-tokens.md)). The dispatcher does not wrap or rewrite it. The harness extractor reads the token directly.

## Mode bodies

- [modes/triage.md](modes/triage.md) — pick + assess + route (autonomous)
- [modes/hygiene.md](modes/hygiene.md) — scan + optional archive
- [modes/unblock.md](modes/unblock.md) — interactive answer OR autonomous request
- [modes/reflect.md](modes/reflect.md) — intra-session friction → research doc
- [modes/split.md](modes/split.md) — M/L/XL → XS/S sub-issues
- [modes/watch.md](modes/watch.md) — resolve `WAIT-*`-parked items by kind (`--kind pr|upstream|issue`; bare sweeps all three)
- [modes/enrich.md](modes/enrich.md) — background-enrich `status: draft` idea files

## Per-mode terminal tokens

The harness reads these from the transcript; do not paraphrase. Full table in [outcome-tokens.md](outcome-tokens.md). Quick reference:

- triage: `TRIAGED <verdict>` | `Queue empty.`
- hygiene: `HYGIENE COMPLETE <N>` | `HYGIENE BLOCKED <reason>`
- unblock (interactive): `UNBLOCK RESOLVED` | `UNBLOCK ESCALATED`
- unblock (autonomous): `UNBLOCK REQUEST POSTED` | `Queue empty.`
- reflect: `REFLECT <path>` | `REFLECT SKIPPED <reason>`
- split: `SPLIT <N>` | `SPLIT SKIPPED <reason>`
- watch (per kind, `KIND` ∈ `PR`/`UPSTREAM`/`ISSUE`): `WATCH-<KIND> ADVANCED <N>` | `WATCH-<KIND> IDLE` | `WATCH-<KIND> SKIPPED — branch <name> is not main`
- enrich: `ENRICHED <N>` | `Queue empty.` | `ENRICH SKIPPED <reason>`

## Notes

- **`RALPH_SUBCOMMAND` is set by each mode body** (not by SessionStart). Hooks discriminate against it to no-op when a different mode is active. SessionStart only sets `RALPH_COMMAND=caretake`, which guards all caretake-prefixed hooks at the plugin level.
- **Mode bodies port source-skill workflows verbatim** where possible. Plan 7 is a structural fold; capability changes are out of scope.
- **`ralph` is the sole plugin.** `plugin/ralph-hero/` was deleted in GH-1438.
