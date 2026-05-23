---
description: Implement an approved plan, address PR review feedback, or create a pull
  request. Use whenever the user says "implement this", "code this up", "build
  the plan", "ship phase N", "run the plan", "execute the plan", "do the
  implementation", "auto-impl", "next phase", "resume the build", "address the
  review", "fix the PR feedback", "respond to comments", "create a PR", "open a
  pull request", "push the branch", "make the PR", hands over an issue number or
  plan path. Default is interactive (phase-by-phase with human verification).
  --mode auto runs ONE phase autonomously per invocation, hook-gated. --mode
  address handles PR review feedback. --mode pr creates a pull request for a
  completed implementation.
argument-hint: "[--mode auto|address|pr] [<issue-number|plan-path>] [--plan-doc <path>] [--push-drive|--no-push-drive]"
context: inline
model: opus
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh RALPH_COMMAND=impl"
  PreToolUse:
    - matcher: "Write|Edit"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/impl-plan-required.sh"
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/impl-worktree-gate.sh"
    - matcher: "mcp__plugin_ralph-hero_ralph-github__ralph_hero__save_issue"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/impl-state-gate.sh"
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/pr-state-gate.sh"
    - matcher: "Bash"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/impl-staging-gate.sh"
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/impl-branch-gate.sh"
  PostToolUse:
    - matcher: "Write|Edit"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/drift-tracker.sh"
    - matcher: "Bash"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/impl-verify-commit.sh"
  Stop:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/impl-postcondition.sh"
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/lock-release-on-failure.sh"
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/doc-structure-validator.sh"
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - Agent
  - Task
  - WebSearch
  - WebFetch
  - AskUserQuestion
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_issues
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_sub_issues
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__save_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_comment
  - mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_recall
  - mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_search
  - mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_record_outcome
---

# /ralph:impl — Implement, address review, or ship PR

Reads an approved plan from `thoughts/shared/plans/`, executes phases, and ships a PR. Four modes share substrate (worktree isolation, plan compliance, staging gates) but route to distinct workflow bodies.

| Mode | Trigger | Role |
|---|---|---|
| **default** | `/ralph:impl #NNN` or `/ralph:impl <plan-path>` | Interactive phase-by-phase implementation, paused between phases for human verification |
| **auto** | `/ralph:impl --mode auto [#NNN] [--plan-doc <path>]` | Autonomous ONE phase per invocation, hook-gated, then STOP for resumability |
| **address** | `/ralph:impl --mode address [#NNN]` | PR review feedback handling (MUST_FIX / SHOULD_FIX / DISCUSS) |
| **pr** | `/ralph:impl --mode pr [#NNN] [--push-drive\|--no-push-drive]` | Push branch + create PR + scout-trigger heuristic + Drive push |

References (consult per mode):
- [worktree-setup.md](worktree-setup.md) — create/reuse worktree, single + cross-repo, base-branch detection
- [plan-compliance.md](plan-compliance.md) — File Ownership Summary, staging algorithm, drift handling
- [phase-execution.md](phase-execution.md) — task graph, sub-agent controller, phase quality review, IMPL BLOCKED escalation
- [address-mode.md](address-mode.md) — PR review feedback classification + reply shape
- [pr-creation.md](pr-creation.md) — PR body template, cross-repo, Drive push, scout trigger heuristic

## Step 0: Parse arguments

Resolve the invocation into `MODE`, `TARGET`, optional flags:

```
no args                        → MODE=default, prompt for TARGET (issue/path)
"#NNN" or "NNN"                → MODE=default, TARGET=issue NNN
"<plan-path>"                  → MODE=default, TARGET=plan-path
"--mode auto [#NNN]"           → MODE=auto, TARGET=NNN or queue-pick
"--mode address #NNN"          → MODE=address, TARGET=NNN (must be In Review)
"--mode pr [#NNN]"             → MODE=pr, TARGET=NNN or queue-pick
"--plan-doc <path>"            → auto-mode shortcut: bypass plan discovery
"--push-drive|--no-push-drive" → pr-mode flag: forwarded to push-artifact.sh
```

After parsing, export `RALPH_TICKET_ID="GH-${TARGET}"` when TARGET is an issue number.

## Step 1+: Mode body

The remaining workflow is mode-dispatched. Each mode body lives in its own section below; this skill scaffold ships with the dispatch table + Step 0 only.

> **Scaffold notice:** Phase 1 of [GH-1366](https://github.com/cdubiel08/ralph-hero/issues/1366) ships the dispatch shell, hook bindings, and reference stubs. Phases 2-6 fill in the mode bodies. Until those land, this skill no-ops with a message pointing the user at `/ralph-hero:impl`, `/ralph-hero:ralph-impl`, or `/ralph-hero:ralph-pr`.

```
SCAFFOLD: /ralph:impl is being built across Plan 5 phases. Mode bodies arrive
in Phases 2-6. For now use:
  - /ralph-hero:impl <NNN>          (interactive impl)
  - /ralph-hero:ralph-impl <NNN>    (one-phase autonomous)
  - /ralph-hero:ralph-pr <NNN>      (push branch + create PR)
```

## Configuration (resolved at load time)

- Owner: !`echo ${RALPH_GH_OWNER:-NOT_SET}`
- Repo: !`echo ${RALPH_GH_REPO:-NOT_SET}`
- Project: !`echo ${RALPH_GH_PROJECT_NUMBER:-NOT_SET}`

Use these resolved values when constructing GitHub URLs or referencing the repository.
