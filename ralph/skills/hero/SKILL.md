---
description: Autonomous orchestrator for the ralph slim plugin. Drives a GitHub issue through the full lifecycle (research → plan → impl → review → merge) with a human plan-approval gate by default. Five modes:default(one-shot), --mode auto (autopilot drain via /loop), --mode classify (director-only dispatch), --mode watch (watcher heartbeat), --mode pr-drain (PR triage). Triggers on "run the hero", "drain the backlog", "classify this issue", "dispatch this", "watch the alerts", "drain this PR", "auto mode", "ship this ticket".
argument-hint: "[<issue-number> | --mode <auto|classify|watch|pr-drain>] [--issue NNN] [--pr NNN] [--since <window>]"
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
    - matcher: "mcp__plugin_ralph-hero_ralph-github__ralph_hero__save_issue"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/hero-state-gate.sh"
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/pr-drain-state-gate.sh"
    - matcher: "mcp__plugin_ralph-hero_ralph-github__ralph_hero__advance_issue"
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
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_issues
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__save_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__advance_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_comment
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__add_sub_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_sub_issues
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__add_dependency
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__remove_dependency
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__decompose_feature
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__detect_stream_positions
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__next_actions
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__pipeline_dashboard
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

```bash
case "$ARGUMENTS" in
  --mode\ auto*)        export RALPH_SUBCOMMAND=auto ;;
  --mode\ classify*)    export RALPH_SUBCOMMAND=classify ;;
  --mode\ watch*)       export RALPH_SUBCOMMAND=watch ;;
  --mode\ pr-drain*)    export RALPH_SUBCOMMAND=pr-drain ;;
  *)                    export RALPH_SUBCOMMAND=default ;;
esac
```

## Step 1: Dispatch

Route to the matching mode body below:

- `RALPH_SUBCOMMAND=default` → **Default mode** (this section)
- `RALPH_SUBCOMMAND=auto` → **--mode auto** (Phase 4)
- `RALPH_SUBCOMMAND=classify` → **--mode classify** (Phase 3)
- `RALPH_SUBCOMMAND=watch` → **--mode watch** (Phase 5)
- `RALPH_SUBCOMMAND=pr-drain` → **--mode pr-drain** (Phase 6)

## Default mode — one-shot orchestrator

### Step 1: Detect pipeline position

Parse `$ARGUMENTS` for a bare issue number. If none provided, call `next_actions({})`, present the top actionable direction via `AskUserQuestion`, and resolve `TARGET_ISSUE` from the user's response.

Call `get_issue({ number: TARGET_ISSUE, includePipeline: true })`. Trust the returned `phase` — do NOT interpret workflow states yourself. Convergence rules + ASCII state machine live in [state-machine.md](state-machine.md).

### Step 1a: Registry lookup

Read `.ralph-repos.yml` (single-repo mode if absent). Store `registryAvailable`, `repoEntries`, `patterns` for cross-repo decomposition during SPLIT.

### Step 1.5: Resumability check

`TaskList()` — if tasks already exist for this pipeline (subjects start with "Research GH-" / "Plan group GH-" / etc.), skip task creation and resume from Step 3.

### Step 2: Create upfront task list

Build the task graph per starting `phase`. Shape per starting phase + dependency-graph-aware impl ordering live in [task-graph.md](task-graph.md). Pattern is two-step: `TaskCreate` then `TaskUpdate(addBlockedBy=[...])`.

### Step 3: Execution loop

Loop `TaskList → filter pending+unblocked → dispatch → mark completed` until all tasks are completed. Phase-specific dispatch (verb mapping, `Skill()` vs `Agent()`, model selection via `${RALPH_IMPL_MODEL:-sonnet}`, BLOCKED escalation, plan-review gate, merge gate) lives in [dispatch.md](dispatch.md).

### Step 4: Report final status

After INTEGRATE completes, report issue numbers, PR URLs, merge status, CI results.

```
result: Hero complete — GH-NNN merged via PR #<N>, CI <status>.
```

Or on STOP (interactive gate / Human Needed / failure):

```
result: Hero paused at <phase> — <reason>. Resume: /ralph:hero NNN
```

## --mode classify

(Phase 3 — filled in next.)

## --mode auto

(Phase 4 — filled in next.)

## --mode watch

(Phase 5 — filled in next.)

## --mode pr-drain

(Phase 6 — filled in next.)

## Notes

- **`RALPH_SUBCOMMAND` is set at Step 0**, once. Hooks discriminate against it to no-op when a different mode is active. SessionStart only sets `RALPH_COMMAND=hero`, which guards all hero-prefixed hooks.
- **Old `/ralph-hero:*` orchestrator skills remain functional** until Plan 10 sunset. Both paths can run side-by-side during the parallel period.
