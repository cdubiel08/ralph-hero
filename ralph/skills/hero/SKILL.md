---
description: Autonomous orchestrator for the ralph slim plugin. Drives a GitHub issue through the full lifecycle (research → plan → impl → review → merge) with a human plan-approval gate by default. Five modes:default(one-shot), --mode auto (autopilot drain via /loop), --mode classify (director-only dispatch), --mode watch (watcher heartbeat), --mode pr-drain (PR triage). Triggers on "run the hero", "drain the backlog", "classify this issue", "dispatch this", "watch the alerts", "drain this PR", "auto mode", "ship this ticket".
argument-hint: "[<issue-number> | --mode <auto|classify|watch|pr-drain>] [--issue NNN] [--pr NNN] [--since <window>] [--loop [duration]] [--auto]"
context: inline
model: opus
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
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/hero-state-gate.sh"
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/pr-drain-state-gate.sh"
    - matcher: "mcp__plugin_ralph_ralph-github__ralph_hero__advance_issue"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/hero-state-gate.sh"
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

The only autonomous entrypoint in the ralph slim plugin. Drives one issue end-to-end by default, or fans out to four mode-specific orchestrations.

| Mode | Trigger | Role |
|---|---|---|
| **default** | `/ralph:hero NNN` or `/ralph:hero` (picks top-ranked) | One-shot: research → plan → review → impl → PR → merge |
| **`--mode auto`** | `/ralph:hero --mode auto` | Drain the backlog via `/loop` (dynamic) + classify each event |
| **`--mode classify`** | `/ralph:hero --mode classify [--issue NNN]` | Director-only: classify one event, dispatch correct verb, stop |
| **`--mode watch`** | `/ralph:hero --mode watch [--issue NNN]` | Watcher heartbeat — dispatch gcp-incident-triage / debug-collate / log-reader / sre-fixit |
| **`--mode pr-drain`** | `/ralph:hero --mode pr-drain --pr NNN` | Drain a PR (Dependabot/stale/unlinked) — classify, gate, act |

References: [state-machine.md](state-machine.md), [task-graph.md](task-graph.md), [dispatch.md](dispatch.md), [event-classes.md](event-classes.md), [watch-dispatch.md](watch-dispatch.md), [pr-drain.md](pr-drain.md).

## Configuration (resolved at load time)

- Owner: !`echo ${RALPH_GH_OWNER:-NOT_SET}`
- Repo: !`echo ${RALPH_GH_REPO:-NOT_SET}`
- Project: !`echo ${RALPH_GH_PROJECT_NUMBER:-NOT_SET}`
- Plan review: !`echo ${RALPH_REVIEW_PLAN:-auto}`
- Merge review: !`echo ${RALPH_REVIEW_MODE:-interactive}`
- Impl model: !`echo ${RALPH_IMPL_MODEL:-sonnet}`
- Autopilot enabled: !`echo ${RALPH_AUTOPILOT_ENABLE:-unset}`

## Step 0: Parse arguments + set subcommand scope

**`--auto` alias** — resolve BEFORE mode dispatch. See `ralph/skills/shared/auto-alias.md`:
- If `--auto` in `$ARGUMENTS` AND `--mode` also present → emit `--auto cannot be combined with explicit --mode; pick one.` and STOP.
- If `--auto` in `$ARGUMENTS` → strip `--auto` token, prepend `--mode auto` to `$ARGUMENTS` (verb=hero alias row). The `RALPH_AUTOPILOT_ENABLE` gate still applies — `--mode auto` dispatches via `/loop` which is guarded by `autopilot-enable-gate.sh`.

```bash
case "$ARGUMENTS" in
  --mode\ auto*)        export RALPH_SUBCOMMAND=auto ;;
  --mode\ classify*)    export RALPH_SUBCOMMAND=classify ;;
  --mode\ watch*)       export RALPH_SUBCOMMAND=watch ;;
  --mode\ pr-drain*)    export RALPH_SUBCOMMAND=pr-drain ;;
  *)                    export RALPH_SUBCOMMAND=default ;;
esac
```

## Step 1: Dispatch by `RALPH_SUBCOMMAND`

Route to the matching mode section below. The dispatcher does NOT rewrite terminal `result:` lines — the harness reads them directly.

## Default mode — one-shot orchestrator

1. **Detect phase.** Parse `$ARGUMENTS` for an issue number; if none, pick from `next_actions({})` via `AskUserQuestion`. Call `get_issue({ number: TARGET, includePipeline: true })` — trust the returned `phase`. State machine + convergence rules in [state-machine.md](state-machine.md).
2. **Registry lookup.** Read `.ralph-repos.yml` (single-repo if absent) for cross-repo decomposition.
3. **Resumability.** `TaskList()` — if tasks match the pipeline shape, skip task creation and resume from the execution loop.
4. **Build upfront task list** per starting `phase`. Shape + dependency-graph-aware impl ordering in [task-graph.md](task-graph.md).
5. **Execution loop.** `TaskList → filter pending+unblocked → dispatch → mark completed`. Per-phase verb mapping, `Skill()`/`Agent()` choice, `${RALPH_IMPL_MODEL:-sonnet}` selection, BLOCKED escalation, plan-review gate, merge gate all in [dispatch.md](dispatch.md).
6. **Report final status.** On COMPLETE: `result: Hero complete — GH-NNN merged via PR #<N>, CI <status>.` On STOP: `result: Hero paused at <phase> — <reason>. Resume: /ralph:hero NNN`.

## --mode classify

Director-only mode: classify one event, dispatch the correct verb, stop. Full taxonomy in [event-classes.md](event-classes.md).

1. **Parse + detect input source.** `--issue NNN` → `TARGET_ISSUE=NNN`, skip to step 3. `RemoteTrigger` tool input (deprecated) → extract `issue_number`+`team`, set `DISPATCH_REASON=RemoteTrigger`, skip to step 4. Otherwise → step 2.
2. **Read `next_actions({})`.** Empty queue → emit `result: Queue empty. No events to dispatch.` STOP. Pick top-ranked direction; resolve `TARGET_ISSUE` per [event-classes.md](event-classes.md) (kind rules).
3. **Fetch + classify.** `get_issue({ number: TARGET_ISSUE })`. Apply [event-classes.md](event-classes.md) priority order: `trigger:*` labels → **`blocked:*` labels (watcher routing)** → automation labels → `workflow_state`. Set `TEAM`, `ENTRYPOINT`, `DISPATCH_REASON`, `CONSUMED_LABEL`, and (for `blocked:*`) `DISPATCH_ARG`. For the `blocked:*` tier: a label prefix-matching `blocked:pr-` → `TEAM=caretakers`, `ENTRYPOINT=ralph:caretake`, `DISPATCH_ARG="--mode watch-pr"`, `DISPATCH_REASON=blocked:pr`, `CONSUMED_LABEL=none`; exact `blocked:upstream` → `DISPATCH_ARG="--mode watch-upstream"`, `DISPATCH_REASON=blocked:upstream`, `CONSUMED_LABEL=none`.
4. **Dispatch.** For the `blocked:*` tier, `Skill(ENTRYPOINT, args=DISPATCH_ARG)` — i.e. `Skill("ralph:caretake", args="--mode watch-pr")` or `Skill("ralph:caretake", args="--mode watch-upstream")`, a **board-wide watcher sweep** NOT scoped to `NNN` (the watcher modes ignore an issue arg). For all other tiers, `Skill(ENTRYPOINT, args="NNN")` (bare issue number). Unimplemented team (memorykeepers) → emit `needs input: team <name> not yet implemented; skipping dispatch.`
5. **Consume label.** If `CONSUMED_LABEL` set (only the `trigger:*` tier sets it): `save_issue({ number: TARGET_ISSUE, labels: ISSUE_LABELS minus CONSUMED_LABEL })`. The `blocked:*` tier (`CONSUMED_LABEL=none` — the watcher owns the label lifecycle), automation labels, and `RemoteTrigger` paths skip this step.
6. **Emit result marker:** `result: Dispatched #NNN to <team> via <entrypoint>. (reason: <DISPATCH_REASON>)`.

## --mode auto

Autonomous **never-terminating adaptive watcher** via `/loop` dynamic mode. This mode does NOT drain-and-stop: it loops until the user deliberately cancels via `/tasks`. While the queue has actionable work it re-fires on a tight cadence; when the queue is idle it backs off to a 1h ceiling and keeps watching, so new issues, merged-PR fallout, or `trigger:*` labels are picked up within at most an hour. Opt-in enforced by `autopilot-enable-gate.sh` — if `RALPH_AUTOPILOT_ENABLE != true`, the `Skill("loop", …)` call exits 2 with a deterministic message.

Emit `Skill("loop", args="Run /ralph:hero --mode classify …\n\n<continuation prompt from loop-wrapper.md § Continuation-prompt template, hero:auto manifest row>")`. Fill `{INNER_COMMAND}` = `Run /ralph:hero --mode classify on the next-most-important event on the project queue`, `{PROGRESS_SENTINELS}` = `result: Dispatched #NNN to <team> via <entrypoint>` (the line `--mode classify` emits on every successful dispatch — see step 6 of `--mode classify` above). There are **no terminal sentinels** — this loop never ends on its own.

**Continuation rules (LOAD-BEARING):**
- `result: Dispatched #NNN …` → busy/burst → `ScheduleWakeup` 60-270s (warm-cache continuation; drains as fast as the queue produces work).
- `result: Queue empty.` → **idle, NOT terminal** → `ScheduleWakeup` **3600s flat** (the 1h ceiling), then re-check. Do NOT end the loop.
- **Every tick MUST call `ScheduleWakeup`** — there is no clean self-exit. `autopilot-stop-gate.sh` (keyed to `RALPH_COMMAND=hero`, armed once `Skill("loop", …--mode classify…)` is observed) blocks session exit with a loud message if a tick returns without a wakeup. Never 300s (`autopilot-wakeup-clear.sh` rejects it). Cancel only via `/tasks` → delete the pending wakeup.

Do not maintain an iteration counter — `/loop` and `--mode classify` own that.

> **Use the `hero:auto` row, NOT `hero:default`.** `--mode auto` wraps `--mode classify`, whose result lines are `result: Dispatched #NNN …` and `result: Queue empty.` — not the `result: Hero complete …` / `result: Hero paused …` lines on the `hero:default` row. The `hero:auto` row treats BOTH classify result lines as re-fire signals (Dispatched → tight cadence, Queue empty → 1h idle backoff) so the watcher never falls through to a terminal stop.

## --mode watch

Watcher team entrypoint. Full dispatch table + SOUL refusal preconditions + heartbeat shape in [watch-dispatch.md](watch-dispatch.md).

**`--loop` gate** — detect `--loop [interval]` (snippet from `loop-wrapper.md` § Arg-parsing snippet). If present: default interval `15m` (see `RALPH_WATCH_HEARTBEAT_MIN`). Use `hero:watch` manifest row — heartbeat, no `Queue empty.` terminal sentinel; re-fires unless `RALPH_WATCH_DISABLE=true` or user cancels via `/tasks`. Emit `Skill("loop", args="${LOOP_INTERVAL:-15m} /ralph:hero --mode watch ${STRIPPED_ARGS}\n\n<continuation from loop-wrapper.md manifest>")` then STOP.

```bash
# Argument parse: --issue NNN or bare NNN → direct mode; no arg → heartbeat mode
case "$ARGUMENTS" in
  --issue\ [0-9]*|[0-9]*) WATCH_MODE=direct  ;;
  *)                      WATCH_MODE=heartbeat ;;
esac
```

- **Direct (`--issue NNN` or bare number):** fetch issue → SOUL refusal preconditions ([watch-dispatch.md](watch-dispatch.md) §SOUL refusal) → dispatch table first-match-wins ([watch-dispatch.md](watch-dispatch.md) §Dispatch table) → sre-fixit pre-check if applicable → emit terminal result line.
- **Heartbeat (no arg):** follow [watch-dispatch.md](watch-dispatch.md) §Heartbeat mode. Bounded loop — only processes issues from the initial `list_issues` call.

## --mode pr-drain

Drain a pull request that `--mode classify` cannot dispatch (Dependabot bumps, stale unlinked PRs). Full rules, per-class actions, audit trail, and synth-issue threading in [pr-drain.md](pr-drain.md).

1. **Parse + idempotency.** Require `--pr <N>` (else `needs input:`). Check the `pr-drained` label via `gh pr view` — if present, emit `result: PR #<N> already drained. Skipping.` STOP.
2. **Fetch PR** via `gh pr view <N> --json number,url,title,author,statusCheckRollup,mergeable,headRefName,createdAt,updatedAt,body,state,mergedAt`. Skip if PR no longer accessible or already MERGED/CLOSED.
3. **Classify** per [pr-drain.md](pr-drain.md) §Classification. The pre-classification guard exits early if CI is still pending.
4. **Create-or-reuse synth issue** per [pr-drain.md](pr-drain.md) §Synthetic Ralph issue. Synth is created BEFORE PR mutation.
5. **Act per CLASS** per [pr-drain.md](pr-drain.md) §Per-class actions. Set `FINAL_CLASS`, `REVIEW_VERDICT`.
6. **Audit trail** per [pr-drain.md](pr-drain.md) §Audit trail. Skip entirely for `needs-human` class.
7. **Advance synth + record outcome** per [pr-drain.md](pr-drain.md) §Synth advance + outcome record.
8. **Emit result marker** per [pr-drain.md](pr-drain.md) §Result marker.

## Notes

`RALPH_SUBCOMMAND` is set once at Step 0. Hooks discriminate against it to no-op when a different mode is active. Old `/ralph-hero:*` orchestrator skills remain functional until Plan 10 sunset; both paths can run side-by-side.
