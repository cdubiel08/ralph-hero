---
description: Investigate a codebase question, a GitHub issue, or a claim. Use whenever
  the user says "research X", "investigate this", "how does Y work", "find me
  prior art on Z", hands over an issue number, or asks to "prove" / "verify" a
  claim. Default flow is interactive (asks for the question, dispatches parallel
  sub-agents, lets you review findings before writing the doc). --mode auto runs
  the autonomous Research-Needed picker. --mode prove runs a 5-step knowledge-graph
  claim investigation that produces a verdict + confidence + evidence chains.
argument-hint: "[--mode auto|prove] [<question|#NNN|claim>] [--playwright|--no-playwright]"
context: inline
model: opus
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh RALPH_COMMAND=research RALPH_REQUIRED_BRANCH=main"
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/branch-gate.sh"
  PostToolUse:
    - matcher: "mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/research-state-gate.sh"
  Stop:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/research-postcondition.sh"
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/doc-structure-validator.sh"
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/lock-release-on-failure.sh"
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - Task
  - Agent
  - AskUserQuestion
  - WebSearch
  - WebFetch
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_issues
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__save_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_comment
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__add_dependency
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__remove_dependency
  - mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_search
  - mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_recall
  - mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_traverse
  - mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_query_outcomes
  - mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_record_outcome
  - mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_expert
  - mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_paths
  - mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_common
  - mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_communities
  - mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_central
  - mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_bridges
---

# /ralph:research — Research

The unified research verb. Default flow is interactive (collaborative
codebase investigation with human review before doc write). `--mode auto`
is the autonomous Research-Needed picker. `--mode prove` is a 5-step
knowledge-graph claim investigation.

## Mode dispatch

| Mode | Behavior | Equivalent to |
|---|---|---|
| (default) | Interactive: question/issue intake → parallel sub-agents → findings review picker → write doc → optional artifact comment | `/ralph-hero:research` |
| `--mode auto [#NNN]` | Autonomous: pick / lock XS/S Research-Needed issue → research → write findings → advance to Ready for Plan | `/ralph-hero:ralph-research` |
| `--mode prove "<claim>"` | Knowledge-graph claim investigation: decompose → entities → paths → evidence → verdict | `/ralph-hero:prove-claim` |
| `--help` / `-h` | Print this table and exit | — |

## Step 0: Parse args

Set `MODE` ∈ `{default, auto, prove}` from `--mode` flag (default if absent).
Capture `ARG` as the remaining positional. Capture `--playwright` /
`--no-playwright` overrides. Bail with the mode table on `--help` / `-h`.

## Default flow

_(Filled by Phase 2 and Phase 3.)_

## --mode auto

_(Filled by Phase 4.)_

## --mode prove

_(Filled by Phase 5.)_

## References

- `intake-routing.md` — issue / question / no-args detection, blocker semantics
- `research-shapes.md` — sub-agent palette, parallel dispatch, knowledge-graph + cross-repo addenda
- `findings-format.md` — doc frontmatter, section order, Prior Work, Files Affected, per-mode required-sections matrix
- `playwright-baseline.md` — conditional UI baseline (default + auto modes)
- `prove-claim.md` — 5-step claim investigation, evidence weighting, confidence calibration, anti-patterns
