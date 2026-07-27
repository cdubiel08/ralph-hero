---
description: Autonomous orchestrator for the ralph slim plugin. Drives a GitHub issue through the full lifecycle (research → plan → impl → review → merge) with decision-gated human plan approval (open design decisions route to the human; decision-free plans flow through) and autonomous merge by default. Four modes:default(one-shot), --mode auto (autopilot drain via /loop, internally ticking a director-only dispatch step), --mode watch (watcher heartbeat), --mode pr-drain (PR triage). Triggers on "run the hero", "drain the backlog", "dispatch this", "watch the alerts", "drain this PR", "auto mode", "ship this ticket".
argument-hint: "[<issue-number> | --mode <auto|watch|pr-drain>] [--issue NNN] [--pr NNN] [--since <window>] [--loop [duration]] [--auto] [--model fable]"
context: inline
model: sonnet
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh RALPH_COMMAND=hero"
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/branch-gate.sh"
    - matcher: "Skill"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/autopilot-enable-gate.sh"
    - matcher: "ScheduleWakeup"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/autopilot-wakeup-clear.sh"
    - matcher: "mcp__plugin_ralph_ralph-github__ralph_hero__save_issue"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/state-gate.sh hero hero"
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/state-gate.sh hero:pr-drain pr_drain"
    - matcher: "mcp__plugin_ralph_ralph-github__ralph_hero__advance_issue"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/state-gate.sh hero hero"
  PostToolUse:
    - matcher: "Skill"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/hero-dispatch-log.sh"
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/autopilot-director-postcheck.sh"
  Stop:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/autopilot-stop-gate.sh"
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/lock-release-on-failure.sh"
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - Agent
  - Skill
  - Task
  - TaskCreate
  - TaskUpdate
  - TaskList
  - TaskGet
  - AskUserQuestion
  - PushNotification
  - ScheduleWakeup
  - mcp__plugin_ralph_ralph-github__ralph_hero__get_issue
  - mcp__plugin_ralph_ralph-github__ralph_hero__list_issues
  - mcp__plugin_ralph_ralph-github__ralph_hero__save_issue
  - mcp__plugin_ralph_ralph-github__ralph_hero__advance_issue
  - mcp__plugin_ralph_ralph-github__ralph_hero__create_issue
  - mcp__plugin_ralph_ralph-github__ralph_hero__create_comment
  - mcp__plugin_ralph_ralph-github__ralph_hero__add_sub_issue
  - mcp__plugin_ralph_ralph-github__ralph_hero__list_sub_issues
  - mcp__plugin_ralph_ralph-github__ralph_hero__add_dependency
  - mcp__plugin_ralph_ralph-github__ralph_hero__remove_dependency
  - mcp__plugin_ralph_ralph-github__ralph_hero__decompose_feature
  - mcp__plugin_ralph_ralph-github__ralph_hero__detect_stream_positions
  - mcp__plugin_ralph_ralph-github__ralph_hero__next_actions
  - mcp__plugin_ralph_ralph-github__ralph_hero__pipeline_dashboard
  - mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_search
  - mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_traverse
  - mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_record_outcome
---

# /ralph:hero — Orchestrator in one verb

The only autonomous entrypoint in the ralph slim plugin. Drives one issue end-to-end by default, or fans out to three mode-specific orchestrations.

| Mode | Trigger | Role |
|---|---|---|
| **default** | `/ralph:hero NNN` or `/ralph:hero` (picks top-ranked) | One-shot: research → plan → review → impl → PR → merge |
| **`--mode auto`** | `/ralph:hero --mode auto` | Drain the backlog via `/loop` (dynamic); each tick internally classifies one event and dispatches the correct verb |
| **`--mode watch`** | `/ralph:hero --mode watch [--issue NNN]` | Watcher heartbeat — dispatch gcp-incident-triage / log-reader / sre-fixit |
| **`--mode pr-drain`** | `/ralph:hero --mode pr-drain --pr NNN` | Drain a PR (Dependabot/stale/unlinked) — classify, gate, act |

References: [state-machine.md](state-machine.md), [task-graph.md](task-graph.md), [dispatch.md](dispatch.md), [../shared/event-taxonomy.md](../shared/event-taxonomy.md), [watch-dispatch.md](watch-dispatch.md), [pr-drain.md](pr-drain.md), [auto-tick.md](auto-tick.md).

## Configuration (resolved at load time)

- Owner: !`echo ${RALPH_GH_OWNER:-NOT_SET}`
- Repo: !`echo ${RALPH_GH_REPO:-NOT_SET}`
- Project: !`echo ${RALPH_GH_PROJECT_NUMBER:-NOT_SET}`
- Plan review: !`echo ${RALPH_REVIEW_PLAN:-auto}`
- Merge review: !`echo ${RALPH_REVIEW_MODE:-auto}`
- Impl model: !`echo ${RALPH_IMPL_MODEL:-sonnet}`
- Autopilot enabled: !`echo ${RALPH_AUTOPILOT_ENABLE:-unset}`

## Step 0: Parse arguments + set subcommand scope

**`--model fable` alias** — resolve FIRST, before `--auto` and mode dispatch. Forwarding alias to the isolated Fable-native surface (design record: `thoughts/shared/ideas/2026-06-10-fable-native-ralph-artifact-contracts.md`, D8):
- If `--model fable` (or `--model=fable`) in `$ARGUMENTS` → strip the two tokens, `Skill("ralph:hero-fable", args="<stripped $ARGUMENTS>")`, then STOP. hero-fable carries its own identity guard — no availability check here.
- Any other `--model <x>` value → emit `--model selects the fable surface only (--model fable). Model tiers are pinned in frontmatter; the impl tier is overridden via RALPH_IMPL_MODEL.` and STOP.

**`--auto` alias** — resolve BEFORE mode dispatch. See `ralph/skills/shared/auto-alias.md`:
- Conflict check (`--auto` + an explicit `--mode`): apply `auto-alias.md` § Conflict detection — emit its refusal text verbatim, then STOP. Not restated here; that file is the only copy.
- If `--auto` in `$ARGUMENTS` → strip `--auto` token, prepend `--mode auto` to `$ARGUMENTS` (verb=hero alias row). The `RALPH_AUTOPILOT_ENABLE` gate still applies — `--mode auto` dispatches via `/loop` which is guarded by `autopilot-enable-gate.sh`. hero resolves `MODE` from the **rewritten** `$ARGUMENTS` below, so no separate `MODE=` assignment is needed here (see `auto-alias.md` § Ordering contract).

Resolve `MODE` from `--mode` **wherever it appears** in `$ARGUMENTS`, then key the
hook scope off that. A `case "$ARGUMENTS" in --mode\ watch*)` prefix match only
fires when `--mode` is the FIRST token, so `/ralph:hero --issue 5 --mode watch`
fell through to `default` and exported the wrong scope key (same defect class as
plan/SKILL.md's Step 0):

```bash
MODE=""
if [[ "$ARGUMENTS" =~ (^|[[:space:]])--mode[[:space:]]+([a-z-]+) ]]; then
  MODE="${BASH_REMATCH[2]}"
elif [[ " $ARGUMENTS " == *" --tick "* ]]; then
  # --tick is a bare internal flag, not a --mode value. --mode wins if both appear.
  MODE=tick
fi
case "$MODE" in
  auto)     export RALPH_SUBCOMMAND=auto ;;
  tick)     export RALPH_SUBCOMMAND=tick ;;
  watch)    export RALPH_SUBCOMMAND=watch ;;
  pr-drain) export RALPH_SUBCOMMAND=pr-drain ;;
  *)        export RALPH_SUBCOMMAND=default ;;
esac
```

**`--loop` gate (default mode)** — `--loop` is meaningful only for the autonomous drain, which is `--mode auto` (the autopilot). The `--auto` alias above already rewrites `--auto` → `--mode auto`, so a bare `--loop` surviving into `default` mode is a misuse — refuse it rather than run the one-shot flow with a stray token. (`--mode auto` and `--mode watch` handle `--loop` in their own sections; `--mode pr-drain` is single-shot. `--tick` is the internal per-event step `--mode auto`'s loop wrapper dispatches — not a public mode, so it never reaches this gate directly.)

```bash
if [[ "$RALPH_SUBCOMMAND" == "default" && "$ARGUMENTS" == *--loop* ]]; then
  printf '%s\n' "--loop is not supported for this mode. Looping is meaningful only for autonomous queue-drainers; this surface is interactive. See ralph/CLAUDE.md § Loop suitability."
  printf '%s\n' "For an autonomous drain, use: /ralph:hero --auto  (resolves to --mode auto)."
  exit 0
fi
```

## Step 1: Dispatch by `RALPH_SUBCOMMAND`

Route to the matching mode section below. The dispatcher does NOT rewrite terminal `result:` lines — the harness reads them directly.

`auto` and `tick` are **different destinations and must not be collapsed**: `auto` is the outer wrapper (it emits `Skill("loop", …)` once and stops), `tick` is the per-event body that wrapper re-issues. Routing `--tick` to the `auto` section would make every loop iteration emit another `Skill("loop", …)` — the queue would never be read and the nested watchers would compound.

## --tick (internal — not a public mode)

Execute [auto-tick.md](auto-tick.md) § Auto tick steps 1-6 directly (classify one event, dispatch the matching verb, consume the trigger label on success, emit the `result:` marker), then STOP. Do **not** fall through to `## --mode auto` and do **not** emit a `Skill("loop", …)` call — the `/loop` wrapper that dispatched this tick owns the cadence and the `ScheduleWakeup`.

## Default mode — one-shot orchestrator

1. **Detect phase.** Parse `$ARGUMENTS` for an issue number; if none, pick from `next_actions({})` via `AskUserQuestion`. **Audience here is the `human` default — intentional:** this result feeds an interactive `AskUserQuestion` picker (not the autonomous loop), so the agent-only XS/S penalty and Backlog/null-state fallback would mis-rank the human surface. The autonomous queue read lives in the internal `--tick` step of `--mode auto` (see [auto-tick.md](auto-tick.md) § Auto tick) and uses `audience: "agent"`. A picked direction with `kind: "triage"` has no issue number — label the option from `signals.statelessCount` (e.g. "Triage N stateless items"; do not deref `issue`/`pr`, both null), dispatch `Skill("ralph:caretake", args="--mode triage")` board-wide instead of resolving `TARGET`/`get_issue`, then emit `result: Dispatched board-wide caretake triage (N stateless items).` and STOP — the remaining default-mode steps assume a single TARGET issue and do not apply. Otherwise, call `get_issue({ number: TARGET, includePipeline: true })` — trust the returned `phase`. State machine + convergence rules in [state-machine.md](state-machine.md).
2. **Registry lookup.** Read `.ralph-repos.yml` (single-repo if absent) for cross-repo decomposition.
3. **Resumability.** `TaskList()` — if tasks match the pipeline shape, skip task creation and resume from the execution loop.
4. **Build upfront task list** per starting `phase`. Shape + dependency-graph-aware impl ordering in [task-graph.md](task-graph.md).
5. **Execution loop.** `TaskList → filter pending+unblocked → dispatch → mark completed`. Per-phase verb mapping, `Skill()`/`Agent()` choice, `${RALPH_IMPL_MODEL:-sonnet}` selection, BLOCKED escalation, plan-review gate, merge gate all in [dispatch.md](dispatch.md).
6. **Report final status.** On COMPLETE: `result: Hero complete — GH-NNN merged via PR #<N>, CI <status>.` On STOP: `result: Hero paused at <phase> — <reason>. Resume: /ralph:hero NNN`.

## --mode auto

Autonomous **never-terminating adaptive watcher** via `/loop` dynamic mode — see [auto-tick.md](auto-tick.md) for the full contract (loop emission, continuation rules, `ScheduleWakeup` discipline, and the `hero:auto` manifest row's cadence) and the internal `--tick` step it wraps (classify-one-event, dispatch, stop). Opt-in enforced by `autopilot-enable-gate.sh` — if `RALPH_AUTOPILOT_ENABLE != true`, the `Skill("loop", …)` call exits 2 with a deterministic message. **`--loop [duration]` does not apply to this mode** — `--mode auto` always self-loops on its own adaptive cadence and ignores any duration token; only `--mode watch` below honors a fixed `--loop [duration]` override.

## --mode watch

Watcher team entrypoint. Full dispatch table + SOUL refusal preconditions + heartbeat shape in [watch-dispatch.md](watch-dispatch.md).

**`--loop` gate** — dispatch scaffolding only; `loop-wrapper.md` is the sole loop contract (the `hero:watch` manifest row owns the interval default and terminal-sentinel behavior — do not restate them here). Detect `--loop [interval]` (snippet from `loop-wrapper.md` § Arg-parsing snippet; env override `RALPH_WATCH_HEARTBEAT_MIN`). If present, emit `Skill("loop", args="${LOOP_INTERVAL:-15m} /ralph:hero --mode watch ${STRIPPED_ARGS}\n\n<continuation from loop-wrapper.md manifest, hero:watch row>")` then STOP. `RALPH_WATCH_DISABLE=true` and `/tasks` cancellation are the two ways to stop the heartbeat (hero-specific controls, not part of the shared manifest).

```bash
# --issue NNN (or a bare NNN) ANYWHERE → direct mode; nothing resolvable →
# heartbeat. Contract + dispatcher rule: watch-dispatch.md § Argument parse.
WATCH_ISSUE=""
if [[ "$ARGUMENTS" =~ (^|[[:space:]])--issue[[:space:]]+#?([0-9]+) ]]; then
  WATCH_ISSUE="${BASH_REMATCH[2]}"
elif [[ "$ARGUMENTS" =~ (^|[[:space:]])#?([0-9]+)([[:space:]]|$) ]]; then
  WATCH_ISSUE="${BASH_REMATCH[2]}"   # operator shorthand
fi
WATCH_MODE=heartbeat
[[ -n "$WATCH_ISSUE" ]] && WATCH_MODE=direct
```

- **Direct (`--issue NNN` or bare number):** fetch issue → SOUL refusal preconditions ([watch-dispatch.md](watch-dispatch.md) §SOUL refusal) → dispatch table first-match-wins ([watch-dispatch.md](watch-dispatch.md) §Dispatch table) → sre-fixit pre-check if applicable → emit terminal result line.
- **Heartbeat (no arg):** follow [watch-dispatch.md](watch-dispatch.md) §Heartbeat mode. Bounded loop — only processes issues from the initial `list_issues` call.

## --mode pr-drain

Drain a pull request that the auto tick cannot dispatch (Dependabot bumps, stale unlinked PRs). Full rules, per-class actions, audit trail, and synth-issue threading in [pr-drain.md](pr-drain.md).

1. **Parse + idempotency.** Require `--pr <N>` (else `needs input:`). Check the `pr-drained` label via `gh pr view` — if present, emit `result: PR #<N> already drained. Skipping.` STOP.
2. **Fetch PR** via `gh pr view <N> --json number,url,title,author,statusCheckRollup,mergeable,headRefName,createdAt,updatedAt,body,state,mergedAt`. Skip if PR no longer accessible or already MERGED/CLOSED.
3. **Classify** per [pr-drain.md](pr-drain.md) §Classification. The pre-classification guard exits early if CI is still pending.
4. **Create-or-reuse synth issue** per [pr-drain.md](pr-drain.md) §Synthetic Ralph issue. Synth is created BEFORE PR mutation.
5. **Act per CLASS** per [pr-drain.md](pr-drain.md) §Per-class actions. Set `FINAL_CLASS`, `REVIEW_VERDICT`.
6. **Audit trail** per [pr-drain.md](pr-drain.md) §Audit trail. Skip entirely for `needs-human` class.
7. **Advance synth + record outcome** per [pr-drain.md](pr-drain.md) §Synth advance + outcome record.
8. **Emit result marker** per [pr-drain.md](pr-drain.md) §Result marker.

## Notes

`RALPH_SUBCOMMAND` is set once at Step 0. Hooks discriminate against it to no-op when a different mode is active. `ralph` is the sole plugin; `plugin/ralph-hero/` was deleted in GH-1438.
