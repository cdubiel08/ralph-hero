---
description: Validate an implementation against its plan, run code review, merge an approved PR, or do the full close-out (val → code-review → merge → CI watch). Use whenever the user says "review this", "validate the impl", "run code review", "merge the PR", "close the loop", "ship it", "finish #NNN", "is this ready to merge", "did the plan get fulfilled". Default mode runs the full close-out and owns the depth-0 fan-out for `code-review:code-review`. --mode val validates impl vs. plan with citation gate + drift log. --mode code runs the code-review-and-fix loop (up to 3 rounds). --mode merge is merge-only mechanics (refuses unreviewed PRs).
argument-hint: "[--mode val|code|merge] [<issue-number>] [--pr-url <url>] [--plan-doc <path>]"
context: inline
model: opus
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh RALPH_COMMAND=review RALPH_VALID_OUTPUT_STATES='In Review,Done,Human Needed'"
  PreToolUse:
    - matcher: "mcp__plugin_ralph-hero_ralph-github__ralph_hero__save_issue|mcp__plugin_ralph-hero_ralph-github__ralph_hero__advance_issue"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/merge-state-gate.sh"
    - matcher: "Bash"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/closeout-scout-gate.sh"
  Stop:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/closeout-postcondition.sh"
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/lock-release-on-failure.sh"
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/doc-structure-validator.sh"
allowed-tools:
  - Read
  - Glob
  - Grep
  - Bash
  - Skill
  - Agent
  - Monitor
  - AskUserQuestion
  - PushNotification
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_issues
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_sub_issues
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_dependencies
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__save_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__advance_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_comment
  - mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_record_outcome
---

# /ralph:review — Close-out the loop

Validates, reviews, and merges completed implementations. Four modes share substrate (PR readiness, terminal verdicts, state transitions) but route to distinct workflow bodies. Default mode owns depth-0 fan-out for `code-review:code-review`.

| Mode | Trigger | Role |
|---|---|---|
| **default** | `/ralph:review #NNN` | Full close-out: val → code-review → merge → CI watch. Orchestrator. |
| **val** | `/ralph:review --mode val [#NNN]` | Validate impl against plan — citation gate, drift log, cross-phase integration |
| **code** | `/ralph:review --mode code [#NNN]` | Run code-review + impl-agent fix loop (up to 3 rounds), escalate on exhaustion |
| **merge** | `/ralph:review --mode merge [#NNN]` | Merge-only mechanics. Refuses unreviewed PRs even when caller skipped default. |

References: [plan-vs-impl-rubric.md](plan-vs-impl-rubric.md) (val rubric: citation gate, drift, integration), [code-review-prompt.md](code-review-prompt.md) (code-review loop invariants + escalation), [merge-gate.md](merge-gate.md) (pre-merge gates, CI watch, cross-repo, scout report), [auto-vs-interactive.md](auto-vs-interactive.md) (depth-0 fan-out, `RALPH_REVIEW_MODE` switch, fix-cycle bound).

## Step 0: Parse arguments

Resolve `MODE`, `TARGET`, optional flags from args:

- no args → `MODE=default`, prompt for `TARGET`
- `#NNN` / `NNN` → `MODE=default`, `TARGET=NNN`
- `--mode val [#NNN]` → `MODE=val`, `TARGET=NNN` or queue-pick
- `--mode code [#NNN]` → `MODE=code`, `TARGET=NNN` or queue-pick
- `--mode merge [#NNN]` → `MODE=merge`, `TARGET=NNN` or queue-pick
- `--pr-url <url>` → forward to merge-mode and default-mode (skips PR discovery)
- `--plan-doc <path>` → forward to val-mode + default-mode (Artifact Passthrough)

Export `RALPH_TICKET_ID="GH-${TARGET}"` when `TARGET` is an issue number.

## Default mode — full close-out

_Filled by Phase 5._

## `--mode val` — validate impl vs. plan

_Filled by Phase 2._

## `--mode code` — code-review-and-fix loop

_Filled by Phase 3._

## `--mode merge` — merge mechanics

_Filled by Phase 4._

## Link Formatting

!cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/link-formatting.md
