---
description: All board maintenance, grooming, and reflection in one verb. Triggers on "triage backlog", "clean up board", "scan for stale", "status check", "capture friction", "reflect on the session", "unblock issue", "answer unblock questions", "enrich idea files". Decomposition ("decompose ticket", "break this into sub-issues") lives in `/ralph:plan --mode epic` (GH-1605). Default mode is event-driven (reads `--issue NNN` labels and fans out via Skill). Named modes (triage/hygiene/unblock/reflect/watch/enrich) each route to a dedicated mode body under `modes/`.
argument-hint: "[--issue NNN | --mode <triage|hygiene|unblock|reflect|watch [--kind pr|upstream|issue]|enrich|all>] [#NNN] [--since <window>] [--auto-confirm] [--question] [--loop [duration]] [--auto]"
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
    - matcher: "Skill"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/triage-no-skill-dispatch.sh"
  PostToolUse:
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

All board maintenance flows through this one entrypoint. Seven named modes plus a default event-driven dispatcher. Each mode is a separate body under `modes/`; this top-level SKILL.md only owns arg parsing, dispatch routing, and the heartbeat fan-out. Decomposition (M/L/XL → sub-issues, strategic or atomic) is NOT here — see `/ralph:plan --mode epic` (GH-1605).

| Mode | Trigger | Role |
|---|---|---|
| **default** | `/ralph:caretake --issue NNN` | Event-driven: read labels, dispatch the right mode via `Skill()` |
| **all** | `/ralph:caretake` (no args) or `/ralph:caretake --mode all` | Heartbeat fan-out: hygiene + watch + enrich + catch-up report |
| **triage** | `/ralph:caretake --mode triage [#NNN]` | Pick oldest untriaged Backlog, assess, route |
| **hygiene** | `/ralph:caretake --mode hygiene` | Scan for archive candidates, stale items, WIP violations |
| **unblock** | `/ralph:caretake --mode unblock [#NNN] [--question]` | Interactive answer OR autonomous request post |
| **reflect** | `/ralph:caretake --mode reflect` | Capture intra-session friction into research doc |
| **watch** | `/ralph:caretake --mode watch [--kind pr\|upstream\|issue]` | Resolve `WAIT-*`-parked items by kind: `pr` (blocked:pr-NNN → PR merge/close), `upstream` (blocked:upstream → external condition), `issue` (blockedBy edge → all blockers closed). Bare invocation sweeps all three kinds serially. |
| **enrich** | `/ralph:caretake --mode enrich` | Background-enrich `status: draft` idea files (codebase + prior art + related issues), flip to `status: forming`, land via a standing PR against `main` (never a direct push — GH-1589) |

References: [../shared/event-taxonomy.md](../shared/event-taxonomy.md) (default-mode dispatch table — single-sourced with hero's Director classifier, GH-1607), [outcome-tokens.md](outcome-tokens.md) (per-mode terminal verdicts).

## Configuration (resolved at load time)

- Owner: !`echo ${RALPH_GH_OWNER:-NOT_SET}`
- Repo: !`echo ${RALPH_GH_REPO:-NOT_SET}`
- Project: !`echo ${RALPH_GH_PROJECT_NUMBER:-NOT_SET}`

## Step 0: Parse arguments + set subcommand scope

**`--auto` alias** — resolve BEFORE `--loop` detection. See `ralph/skills/shared/auto-alias.md`:
- Conflict check (`--auto` + an explicit `--mode`): apply `auto-alias.md` § Conflict detection — emit its refusal text verbatim, then STOP. Not restated here; that file is the only copy.
- If `--auto` in `$ARGUMENTS` → strip `--auto` token, prepend `--mode triage` to `$ARGUMENTS` (verb=caretake alias row). Continue to `--loop` detection with the rewritten args.

**`--loop` gate** — dispatch scaffolding only; `ralph/skills/shared/loop-wrapper.md` is the sole loop contract (intervals, terminal-sentinel presence/absence, and re-fire behavior all live in its manifest rows — do not restate them here). Run the arg-parsing snippet from `loop-wrapper.md` § Arg-parsing snippet (sets `LOOP_RAW`, `LOOP_INTERVAL`, `STRIPPED_ARGS`). If `LOOP_RAW` is set, resolve the manifest row for the routed mode and emit `Skill("loop", …)` via `loop-wrapper.md` § Continuation-prompt template, passing `STRIPPED_ARGS` through unchanged, then STOP. Mode → manifest row:
- `--mode triage` → `caretake:triage`; `--mode hygiene` → `caretake:hygiene`; `--mode unblock` (no `--question`) → `caretake:unblock`.
- No args (no `--issue`) → bare invocation runs the **heartbeat fan-out** (`RALPH_SUBCOMMAND=all`; see the dispatch body) → `caretake:all`. (The `caretake:default-event` row is the separate `--issue NNN`-scoped trigger-drain path — NOT this bare no-arg fan-out.)
- **`--mode all`** → `caretake:all`. `STRIPPED_ARGS` already carries the original `--mode all` — do NOT re-prefix it.
- **`--mode watch`** (with or without `--kind`) → `caretake:watch`. `STRIPPED_ARGS` already carries the original `--mode watch [--kind …]` — do NOT re-prefix it.
- `--issue NNN` present, `--mode reflect`, `--mode enrich`, or `--mode unblock --question` → emit refusal from `loop-wrapper.md` § Refusal message, then STOP. (`enrich` already runs as a child of the `caretake:all` heartbeat — see `loop-wrapper.md` § Unsuitable surfaces for why a standalone loop is refused.)

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

- **`--issue NNN`** → default-mode (event-driven). Fetch the issue, inspect labels, dispatch per [../shared/event-taxonomy.md](../shared/event-taxonomy.md) § Caretake default-mode label routing. After dispatch, post a `## Caretaker Action` comment summarizing mode + outcome.
- **`--mode <name>`** → read `modes/<name>.md` and follow its body. The mode body sets `RALPH_SUBCOMMAND=<name>` and runs.
- **No args** or **`--mode all`** → heartbeat fan-out. Invoke serially:
  1. `Skill("ralph:caretake", args="--mode hygiene")`
  2. `Skill("ralph:caretake", args="--mode watch")`
  3. `Skill("ralph:caretake", args="--mode enrich")`
  4. `Skill("ralph:catch-up", args="--mode report")`
  Report consolidated outcome (one line per child — 4 total). `--mode watch` (bare, no `--kind`) sweeps all three watcher kinds serially in this one child. The watch and enrich children run before report so the dashboards and brief reflect post-enrichment board/file state; all no-op (`IDLE` / `Queue empty.`) on an empty board/queue, or `SKIPPED` when the heartbeat fires off `main`. Enrich never pushes `main` directly even when it has files to land — it opens/updates a PR (`modes/enrich.md` § Step 4) and reports `ENRICHED <N> (PR <url>)`, so the routine no-argument heartbeat cannot perform an unreviewed repository write.

## Step 2: Emit result line

Each mode body ends by emitting its terminal token (see [outcome-tokens.md](outcome-tokens.md)). The dispatcher does not wrap or rewrite it. The harness extractor reads the token directly.

## Mode bodies

- [modes/triage.md](modes/triage.md) — pick + assess + route (autonomous)
- [modes/hygiene.md](modes/hygiene.md) — scan + optional archive
- [modes/unblock.md](modes/unblock.md) — interactive answer OR autonomous request
- [modes/reflect.md](modes/reflect.md) — intra-session friction → research doc
- [modes/watch.md](modes/watch.md) — resolve `WAIT-*`-parked items by kind (`--kind pr|upstream|issue`; bare sweeps all three)
- [modes/enrich.md](modes/enrich.md) — background-enrich `status: draft` idea files

## Per-mode terminal tokens

The harness reads these from the transcript; do not paraphrase. **Single source of truth: [outcome-tokens.md](outcome-tokens.md)** — every token family, value, and reason string is enumerated there and nowhere else. No quick-reference copy lives here: the prior one drifted from the full table on four token shapes (GH-1607), which is what single-sourcing them fixes.

## Notes

- **`RALPH_SUBCOMMAND` is set by each mode body** (not by SessionStart). Hooks discriminate against it to no-op when a different mode is active. SessionStart only sets `RALPH_COMMAND=caretake`, which guards all caretake-prefixed hooks at the plugin level.
- **Mode bodies port source-skill workflows verbatim** where possible. Plan 7 is a structural fold; capability changes are out of scope.
- **`ralph` is the sole plugin.** `plugin/ralph-hero/` was deleted in GH-1438.
