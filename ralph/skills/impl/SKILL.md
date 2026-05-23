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

## Default mode — interactive phase-by-phase

### Step 1: Resolve plan + issue

For `#NNN`: fetch issue, scan comments for `## Implementation Plan` (most recent if multiple), extract path from URL. Fall back to glob `thoughts/shared/plans/*GH-${NNN}*` then `*group*GH-*` (scan frontmatter for issue number). If found via glob only, self-heal by posting the missing artifact comment. STOP with "No plan found for #NNN" if no match.

For `<plan-path>`: verify file exists, read frontmatter for `github_issue` / `github_issues`. Proceed without issue integration if no link.

### Step 2: Read plan fully

Read fully (no offset/limit). Detect resumption: scan for existing `- [x]` checkmarks; the first unchecked phase is the start point. Build context: which issue(s) does the plan cover (single `github_issue` or group `github_issues`).

### Step 3: Setup

Optional worktree suggestion per [worktree-setup.md §Suggestion](worktree-setup.md). If the user agrees, run `scripts/create-worktree.sh GH-NNN` and `cd worktrees/GH-NNN`. Otherwise implement in place.

Transition the linked issue to "In Progress" (skip if already). Post `## Implementation Started` comment.

### Step 4: Implement phase by phase

For each unchecked phase:

1. Read phase requirements + all referenced files (FULLY).
2. Implement changes per [plan-compliance.md §File Ownership](plan-compliance.md).
3. Run the phase's automated verification commands; fix until they pass.
4. Update `- [ ]` → `- [x]` for automated items that pass. Do NOT check manual items.
5. **Pause for human verification** via AskUserQuestion: list automated checks that passed + manual items the user must run. Wait for confirmation before proceeding to next phase.
6. If reality doesn't match the plan, STOP and surface the gap (Expected / Found / Why this matters / How should I proceed?).

If instructed to execute multiple phases consecutively, skip the pause until the final phase.

> Steps 5-6 (Complete + Next-steps picker) land in Phase 3 of [GH-1366](https://github.com/cdubiel08/ralph-hero/issues/1366).

## Configuration (resolved at load time)

- Owner: !`echo ${RALPH_GH_OWNER:-NOT_SET}`
- Repo: !`echo ${RALPH_GH_REPO:-NOT_SET}`
- Project: !`echo ${RALPH_GH_PROJECT_NUMBER:-NOT_SET}`

Use these resolved values when constructing GitHub URLs or referencing the repository.
