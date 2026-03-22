---
date: 2026-03-21
status: draft
type: plan
github_issue: 659
github_issues: [659]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/659
primary_issue: 659
tags: [hooks, outcome-ledger, observability, bug-fix]
---

# Fix Unreachable Branches in outcome-collector.sh - Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-03-21-autonomous-experiment-loop-patterns]]
- builds_on:: [[2026-03-21-outcome-ledger-design]]

## Overview
1 issue for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-659 | outcome-collector: ralph_val and ralph_pr hook branches are unreachable | S |

## Shared Constraints

- outcome-collector.sh is a PostToolUse hook that must always exit 0 (never block the pipeline)
- The hook reads `tool_input` and `tool_response` from stdin as JSON
- Event type determination uses `${command}:${workflow_state}` as the case key
- The hook only fires on `PostToolUse(ralph_hero__save_issue)` and `PostToolUse(Write)` registrations (per [hooks.json:93-106](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/hooks.json#L93-L106))

## Current State Analysis

Two case branches in [outcome-collector.sh:126-127](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/outcome-collector.sh#L126-L127) are unreachable:

### Branch 1: `ralph_val:*` (line 126)

**Root cause**: ralph-val does not call `ralph_hero__save_issue`. The tool is not in ralph-val's `allowed-tools` list ([SKILL.md:17-22](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-val/SKILL.md#L17-L22)). Ralph-val is a read-only skill that produces a verdict comment; the integrator handles all state transitions based on that verdict. Since outcome-collector fires only on `PostToolUse(ralph_hero__save_issue)`, this branch can never execute.

### Branch 2: `ralph_pr:__COMPLETE__` (line 127)

**Root cause**: ralph-pr calls `save_issue(workflowState="In Review", command="ralph_pr")` ([SKILL.md:143](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-pr/SKILL.md#L143)). The actual case key that would arrive is `ralph_pr:In Review`, not `ralph_pr:__COMPLETE__`. The `__COMPLETE__` sentinel is a semantic intent that gets resolved by `state-resolution.ts` before the tool returns, but outcome-collector reads from `tool_input` (pre-resolution). So if ralph-pr passed `__COMPLETE__`, the case key would be `ralph_pr:__COMPLETE__`, matching the branch. However, ralph-pr explicitly passes the direct state `"In Review"`, not `__COMPLETE__`.

**Additional complication**: `ralph_pr` is not a recognized command in [state-resolution.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/state-resolution.ts#L36-L52). The `COMMAND_ALLOWED_STATES` map does not contain `ralph_pr`; it uses `ralph_hero` for the `["In Review", "Human Needed"]` output states. If ralph-pr passes `command="ralph_pr"`, `resolveState()` throws an "Unknown command" error. The tool_response would lack a `.number` field, causing outcome-collector to exit early at line 113-115. This means no `pr_completed` event can fire even with a corrected case match, unless the command name is also fixed.

## Desired End State

### Verification
- [ ] The `ralph_pr:In Review` case correctly maps to `pr_completed` event type
- [ ] The `ralph_val` branch is removed with an inline comment explaining why
- [ ] A comment in the case statement documents what each skill actually passes
- [ ] `bash -n outcome-collector.sh` passes (syntax check)
- [ ] Existing bats CI test infrastructure is unaffected

## What We're NOT Doing
- Adding `ralph_pr` to `COMMAND_ALLOWED_STATES` in state-resolution.ts (separate concern -- the SKILL.md instructions may need updating to use `command="ralph_hero"` instead, or a new `ralph_pr` command needs to be registered; either way that is a broader change)
- Adding custom hook emission for ralph-val (the integrator path handles val outcomes)
- Writing shell-level integration tests for outcome-collector (no sqlite3 test infrastructure exists in CI; this is hook code with an always-exit-0 contract)

## Implementation Approach

This is a single-phase fix to the case statement in outcome-collector.sh. The fix:
1. Changes the `ralph_pr` branch to match the actual case key `ralph_pr:In Review`
2. Removes the `ralph_val:*` branch entirely
3. Adds inline documentation explaining what each skill passes and why ralph_val is excluded

---

## Phase 1: Fix unreachable case branches in outcome-collector.sh (GH-659)

### Overview
Correct the case statement in `handle_save_issue()` to match the actual `command:workflowState` pairs that arrive from ralph-pr, and remove the ralph_val branch that can never fire.

### Tasks

#### Task 1.1: Fix the ralph_pr case branch
- **files**: `plugin/ralph-hero/hooks/scripts/outcome-collector.sh` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] Line 127 changed from `ralph_pr:__COMPLETE__)` to `ralph_pr:In Review)`
  - [ ] The event_type remains `"pr_completed"`
  - [ ] The case pattern uses the exact string `ralph_pr:In Review` with the space

#### Task 1.2: Remove the ralph_val branch
- **files**: `plugin/ralph-hero/hooks/scripts/outcome-collector.sh` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] Line 126 (`ralph_val:*)  event_type="validation_completed" ;;`) is removed
  - [ ] No other references to `ralph_val` or `validation_completed` remain in this file

#### Task 1.3: Add inline documentation to the case statement
- **files**: `plugin/ralph-hero/hooks/scripts/outcome-collector.sh` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1, 1.2]
- **acceptance**:
  - [ ] A comment block above the case statement documents the mapping between skills and their actual `command:workflowState` values
  - [ ] The comment notes that ralph-val does not call save_issue (integrator handles state transitions)
  - [ ] The comment notes that `ralph_pr` is not yet a recognized command in state-resolution.ts, so `pr_completed` events will only fire once that is addressed

### Phase Success Criteria

#### Automated Verification:
- [ ] `bash -n plugin/ralph-hero/hooks/scripts/outcome-collector.sh` -- no syntax errors

#### Manual Verification:
- [ ] The case statement's branches all correspond to actual skill behavior:
  - `ralph_research:__LOCK__` -- ralph-research calls `save_issue(workflowState="__LOCK__", command="ralph_research")`
  - `ralph_research:__COMPLETE__` -- ralph-research calls `save_issue(workflowState="__COMPLETE__", command="ralph_research")`
  - `ralph_plan:__LOCK__` -- ralph-plan calls `save_issue(workflowState="__LOCK__", command="ralph_plan")`
  - `ralph_plan:__COMPLETE__` -- ralph-plan calls `save_issue(workflowState="__COMPLETE__", command="ralph_plan")`
  - `ralph_review:*` -- ralph-review calls `save_issue` with various states and `command="ralph_review"`
  - `ralph_impl:__LOCK__` -- ralph-impl calls `save_issue(workflowState="__LOCK__", command="ralph_impl")`
  - `ralph_impl:__COMPLETE__` -- ralph-impl calls `save_issue(workflowState="__COMPLETE__", command="ralph_impl")`
  - `ralph_pr:In Review` -- ralph-pr calls `save_issue(workflowState="In Review", command="ralph_pr")`
  - `ralph_merge:__COMPLETE__` -- ralph-merge calls `save_issue(workflowState="Done", command="ralph_merge")` which uses `__COMPLETE__` semantic intent
- [ ] No remaining unreachable branches exist in the case statement

---

## Integration Testing
- [ ] `bash -n plugin/ralph-hero/hooks/scripts/outcome-collector.sh` passes
- [ ] No changes to hooks.json registration (PostToolUse matchers unchanged)

## References
- Issue: https://github.com/cdubiel08/ralph-hero/issues/659
- Outcome collector: [plugin/ralph-hero/hooks/scripts/outcome-collector.sh](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/outcome-collector.sh)
- ralph-pr SKILL.md: [plugin/ralph-hero/skills/ralph-pr/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-pr/SKILL.md)
- ralph-val SKILL.md: [plugin/ralph-hero/skills/ralph-val/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-val/SKILL.md)
- State resolution: [plugin/ralph-hero/mcp-server/src/lib/state-resolution.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/state-resolution.ts)
- Hook registration: [plugin/ralph-hero/hooks/hooks.json](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/hooks.json)
