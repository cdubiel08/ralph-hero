---
date: 2026-03-21
status: draft
type: plan
github_issue: 659
github_issues: [659, 660, 661]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/659
  - https://github.com/cdubiel08/ralph-hero/issues/660
  - https://github.com/cdubiel08/ralph-hero/issues/661
primary_issue: 659
tags: [hooks, outcome-ledger, observability, bug-fix, state-resolution]
---

# Fix Unreachable outcome-collector Branches and Register ralph_pr Command — Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-03-21-autonomous-experiment-loop-patterns]]
- builds_on:: [[2026-03-21-outcome-ledger-design]]

## Overview
3 issues (1 umbrella + 2 atomics) for implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-660 | Register ralph_pr in COMMAND_ALLOWED_STATES with tests | XS |
| 2 | GH-661 | Fix outcome-collector.sh case branches and add inline docs | XS |

**Umbrella**: GH-659 (M) — parent tracking issue, closed when both children complete.

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
- [ ] `ralph_pr` is a registered command in `COMMAND_ALLOWED_STATES` with `["In Review", "Human Needed"]`
- [ ] `resolveState("In Review", "ralph_pr")` returns successfully (no "Unknown command" error)
- [ ] Unit tests cover `ralph_pr` direct state and semantic intents
- [ ] `ralph-state-machine.json` is updated if needed for data consistency tests
- [ ] The `ralph_pr:In Review` case correctly maps to `pr_completed` event type
- [ ] The `ralph_val` branch is removed with an inline comment explaining why
- [ ] A comment in the case statement documents what each skill actually passes
- [ ] `bash -n outcome-collector.sh` passes (syntax check)
- [ ] `npm test` passes (state-resolution tests + full suite)
- [ ] Existing bats CI test infrastructure is unaffected

## What We're NOT Doing
- Adding custom hook emission for ralph-val (the integrator path handles val outcomes)
- Writing shell-level integration tests for outcome-collector (no sqlite3 test infrastructure exists in CI; this is hook code with an always-exit-0 contract)
- Adding semantic intents for `ralph_pr` beyond what's needed (only `__ESCALATE__`, `__CLOSE__`, `__CANCEL__` wildcards apply; no `__LOCK__`/`__COMPLETE__` since ralph-pr uses direct states)

## Implementation Approach

Two-phase fix across two code layers (TypeScript MCP server + shell hook), shipped in a single PR:

1. **Phase 1** (GH-660): Register `ralph_pr` as a recognized command in `state-resolution.ts` so that `save_issue(command="ralph_pr", workflowState="In Review")` no longer throws. Add unit tests.
2. **Phase 2** (GH-661): Fix the outcome-collector.sh case statement to match the actual `command:workflowState` pairs, remove the dead `ralph_val` branch, and add inline docs.

Phase 1 must be correct before Phase 2 matters — if `resolveState` throws for `ralph_pr`, the tool response has no `.number` and outcome-collector exits early.

---

## Phase 1: Register ralph_pr in COMMAND_ALLOWED_STATES (GH-660)

### Overview
Add `ralph_pr` as a recognized command in the state resolution module so that `save_issue(workflowState="In Review", command="ralph_pr")` succeeds. This unblocks the outcome-collector hook from ever seeing a successful `ralph_pr` save_issue response.

### Tasks

#### Task 1.1: Add ralph_pr to COMMAND_ALLOWED_STATES
- **files**: `plugin/ralph-hero/mcp-server/src/lib/state-resolution.ts` (modify, [line 36-52](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/state-resolution.ts#L36-L52))
- **tdd**: true — write a failing test first, then add the entry
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] `COMMAND_ALLOWED_STATES` contains `ralph_pr: ["In Review", "Human Needed"]`
  - [ ] Entry placed alphabetically between `ralph_plan_epic` and `ralph_research`
  - [ ] `VALID_COMMANDS` (derived from `Object.keys()`) automatically includes `ralph_pr`

#### Task 1.2: Add unit tests for ralph_pr command
- **files**: `plugin/ralph-hero/mcp-server/src/__tests__/state-resolution.test.ts` (modify)
- **tdd**: true
- **complexity**: low
- **depends_on**: null (write tests first, they fail, then Task 1.1 makes them pass)
- **acceptance**:
  - [ ] Test: `resolveState("In Review", "ralph_pr")` returns `{ resolvedState: "In Review", wasIntent: false }`
  - [ ] Test: `resolveState("Human Needed", "ralph_pr")` returns successfully
  - [ ] Test: `resolveState("In Progress", "ralph_pr")` throws (not in allowed states)
  - [ ] Test: wildcard intents (`__ESCALATE__`, `__CLOSE__`, `__CANCEL__`) resolve correctly for `ralph_pr`
  - [ ] Test: `normalizeCommand("pr")` returns `"ralph_pr"`

#### Task 1.3: Update ralph-state-machine.json if needed
- **files**: `plugin/ralph-hero/hooks/scripts/ralph-state-machine.json` (modify if it exists and data consistency tests reference it)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] Data consistency test at `state-resolution.test.ts:258-323` passes
  - [ ] If JSON file doesn't exist or test is guarded by `fs.existsSync`, confirm it's a no-op

### Phase Success Criteria

#### Automated Verification:
- [ ] `cd plugin/ralph-hero/mcp-server && npm test` -- all tests pass, including new ralph_pr tests
- [ ] `cd plugin/ralph-hero/mcp-server && npm run build` -- TypeScript compiles cleanly

#### Manual Verification:
- [ ] `ralph_pr` appears in `VALID_COMMANDS` export
- [ ] `resolveState("In Review", "ralph_pr")` does not throw

---

## Phase 2: Fix outcome-collector.sh case branches (GH-661)

### Overview
Correct the case statement in `handle_save_issue()` to match the actual `command:workflowState` pairs that arrive from ralph-pr, remove the ralph_val branch that can never fire, and add inline documentation.

### Tasks

#### Task 2.1: Fix the ralph_pr case branch
- **files**: `plugin/ralph-hero/hooks/scripts/outcome-collector.sh` (modify, [line 127](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/outcome-collector.sh#L127))
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] Line 127 changed from `ralph_pr:__COMPLETE__)` to `"ralph_pr:In Review")`
  - [ ] The event_type remains `"pr_completed"`
  - [ ] The case pattern is quoted to handle the space: `"ralph_pr:In Review"`

#### Task 2.2: Remove the ralph_val branch
- **files**: `plugin/ralph-hero/hooks/scripts/outcome-collector.sh` (modify, [line 126](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/outcome-collector.sh#L126))
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] Line 126 (`ralph_val:*)  event_type="validation_completed" ;;`) is removed
  - [ ] No other references to `ralph_val` or `validation_completed` remain in this file

#### Task 2.3: Add inline documentation to the case statement
- **files**: `plugin/ralph-hero/hooks/scripts/outcome-collector.sh` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [2.1, 2.2]
- **acceptance**:
  - [ ] A comment block above the case statement documents the mapping between skills and their actual `command:workflowState` values
  - [ ] The comment notes that ralph-val does not call save_issue (integrator handles state transitions)
  - [ ] The comment confirms `ralph_pr` is now a registered command in state-resolution.ts

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
  - `"ralph_pr:In Review"` -- ralph-pr calls `save_issue(workflowState="In Review", command="ralph_pr")`
  - `ralph_merge:__COMPLETE__` -- ralph-merge calls `save_issue(workflowState="Done", command="ralph_merge")` via `__COMPLETE__` semantic intent
- [ ] No remaining unreachable branches exist in the case statement

---

## Integration Testing
- [ ] `cd plugin/ralph-hero/mcp-server && npm test` passes (state-resolution + full suite)
- [ ] `cd plugin/ralph-hero/mcp-server && npm run build` compiles cleanly
- [ ] `bash -n plugin/ralph-hero/hooks/scripts/outcome-collector.sh` passes
- [ ] No changes to hooks.json registration (PostToolUse matchers unchanged)

## References
- Issue: https://github.com/cdubiel08/ralph-hero/issues/659
- Outcome collector: [plugin/ralph-hero/hooks/scripts/outcome-collector.sh](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/outcome-collector.sh)
- ralph-pr SKILL.md: [plugin/ralph-hero/skills/ralph-pr/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-pr/SKILL.md)
- ralph-val SKILL.md: [plugin/ralph-hero/skills/ralph-val/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-val/SKILL.md)
- State resolution: [plugin/ralph-hero/mcp-server/src/lib/state-resolution.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/state-resolution.ts)
- Hook registration: [plugin/ralph-hero/hooks/hooks.json](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/hooks.json)
