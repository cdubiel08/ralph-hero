---
date: 2026-03-03
topic: "State machine transition audit: do all commands set correct workflowState?"
tags: [research, codebase, state-machine, workflow-states, transitions, interactive-commands]
status: complete
type: research
---

# Research: State Machine Transition Audit

## Research Question

Do all state machine transitions properly set the correct workflowState? In particular, do the interactive commands properly create issues in the correct state?

## Summary

The audit found that **all autonomous Ralph skills** (`triage`, `split`, `research`, `plan`, `review`, `impl`, `merge`, `pr`) correctly set workflowState through a well-enforced system of semantic intents, command-level allowed-state validation, and hook-based state gates.

However, **issue creation paths across all commands consistently omit workflowState from the `create_issue` call**, relying instead on a subsequent `save_issue` call to set the state. This means newly created issues temporarily exist on the project board with **no Workflow State set**. Most autonomous skills handle this correctly via follow-up `save_issue` calls. The `form-idea` interactive skill, however, **never sets workflowState at all** - issues it creates land on the board with only an `estimate` field set and no workflow state.

## Detailed Findings

### 1. State Machine Architecture

The state machine is defined in three layers:

**Layer 1 - Canonical State Order** ([workflow-states.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts)):
```
Backlog -> Research Needed -> Research in Progress -> Ready for Plan ->
Plan in Progress -> Plan in Review -> In Progress -> In Review -> Done
```
Plus off-pipeline states: `Canceled`, `Human Needed`

**Layer 2 - Command Routing** ([state-resolution.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/state-resolution.ts)):
Each command has an allowlist of valid output states (`COMMAND_ALLOWED_STATES`) and semantic intent mappings (`SEMANTIC_INTENTS`).

**Layer 3 - Hook Enforcement** (shell scripts in `hooks/scripts/`):
PreToolUse and PostToolUse hooks validate state transitions at runtime. Plugin-level hooks (`pre-github-validator.sh`) validate against `ralph-state-machine.json`. Skill-level hooks (`*-state-gate.sh`) validate against `RALPH_VALID_OUTPUT_STATES`.

### 2. Autonomous Skill Transitions (All Correct)

| Skill | Input State | Lock | Output State(s) | Mechanism |
|-------|------------|------|-----------------|-----------|
| `ralph-triage` | Backlog | - | Research Needed, Done | `save_issue` with literal state + `command: "ralph_triage"` |
| `ralph-split` | Backlog, Research Needed | - | `__COMPLETE__` -> Backlog (children) | `save_issue` with semantic intent + `command: "ralph_split"` |
| `ralph-research` | Research Needed | Research in Progress (`__LOCK__`) | `__COMPLETE__` -> Ready for Plan | `save_issue` with semantic intents |
| `ralph-plan` | Ready for Plan | Plan in Progress (`__LOCK__`) | `__COMPLETE__` -> Plan in Review | `save_issue` with semantic intents |
| `ralph-review` | Plan in Review | - | `__COMPLETE__` -> In Progress (approve), Ready for Plan (reject) | `save_issue` with semantic intent or literal |
| `ralph-impl` | In Progress | In Progress (`__LOCK__`) | `__COMPLETE__` -> In Review | `save_issue` with semantic intents |
| `ralph-merge` | In Review | - | Done | `save_issue` literal or `advance_issue` |
| `ralph-pr` | (not enforced) | - | In Review | `save_issue` literal or `advance_issue` |

All autonomous skills pass the `command` parameter to `save_issue`, enabling both semantic intent resolution and command-level state validation via `COMMAND_ALLOWED_STATES`.

### 3. Interactive Skill Transitions

| Skill | Creates Issues? | Sets workflowState? | Details |
|-------|----------------|---------------------|---------|
| `draft-idea` | No | No | Pre-ticket; writes local markdown only |
| `form-idea` | Yes | **Never** | Creates issues with `create_issue(title, body)` then `save_issue(estimate=...)` but never sets workflowState |
| `create-plan` | Optionally | Conditionally | User-approved transition to "Plan in Review" via `save_issue(workflowState="Plan in Review", command="create_plan")` |
| `implement-plan` | No | Yes | Transitions to "In Progress" at start, "In Review" after PR, both via `save_issue` with `command="implement_plan"` |
| `iterate-plan` | No | Yes | Transitions to "Plan in Progress" via `save_issue(workflowState="Plan in Progress", command="iterate_plan")` |

### 4. Issue Creation Paths - workflowState Gap

Every issue creation path in the codebase follows the same pattern:

```
ralph_hero__create_issue(title=..., body=..., labels=...)   <- no workflowState
ralph_hero__save_issue(number=..., estimate="XS")           <- only estimate, no workflowState
```

**Paths that DO set workflowState after creation:**
- `ralph-split`: Sets `__COMPLETE__` via `save_issue` in a subsequent call (Step 6, then overrides in Step 9)
- `ralph-triage` (split path): Sets estimate only; child issues stay stateless
- `create-plan`: Optionally sets "Plan in Review" if user approves

**Paths that NEVER set workflowState after creation:**
- `form-idea` (single issue): Only sets estimate
- `form-idea` (ticket tree parent): Only sets estimate to "L"
- `form-idea` (ticket tree children): Only sets estimate to "XS"
- `demo-seed.sh`: CLI-based; never sets any project fields

The `create_issue` MCP tool itself supports a `workflowState` parameter (defined at `issue-tools.ts:897`), but no skill caller passes it.

### 5. The `form-idea` Gap

`form-idea` is the primary interactive issue creation skill. Its flow:

1. User crafts an idea from a draft
2. Skill calls `create_issue(title, body)`
3. Skill calls `save_issue(number, estimate="XS|S|M|L|XL")`
4. **Done** - no workflowState set

Issues created by `form-idea` land on the project board with an estimate but no Workflow State. They are invisible to the `ralph-triage` skill (which queries for `workflowState: "Backlog"` via the `analyst-triage` profile). These issues exist in a limbo state until manually triaged or until a user sets their workflow state.

In contrast, `ralph-split` properly sets workflowState on its created sub-issues (to "Backlog" via `__COMPLETE__`), making them immediately visible in the pipeline.

### 6. State Enforcement Mechanisms

**PreToolUse hooks** (block before API call):
- `pre-github-validator.sh`: Validates target state exists in `ralph-state-machine.json` (plugin-wide)
- `*-state-gate.sh`: Per-skill validation against `RALPH_VALID_OUTPUT_STATES` (impl, review, merge, pr)
- `human-needed-outbound-block.sh`: Blocks automated transitions out of "Human Needed"

**PostToolUse hooks** (validate after API call):
- `post-github-validator.sh`: Provides context feedback about transitions (plugin-wide, never blocks)
- `*-state-gate.sh`: Per-skill validation (triage, research, plan)

**Stop hooks** (validate on session end):
- Each mutating skill has a postcondition script validating expected artifacts/state changes

**`save_issue` with `command` parameter**:
- When `command` is provided, `resolveState()` validates against `COMMAND_ALLOWED_STATES`
- When `command` is absent, only `isValidState()` is checked (any of the 11 known states)

### 7. `create_issue` Status Sync Gap

The `save_issue` tool performs inline Status field sync (mapping workflowState to the GitHub default Status field: Todo/In Progress/Done). The `create_issue` tool does NOT sync Status when setting workflowState. Issues created with a workflowState via `create_issue` will have the Workflow State set but the Status field left at its default.

In practice this is a non-issue because no skill currently passes workflowState to `create_issue`.

## Code References

| Component | File | Key Lines |
|-----------|------|-----------|
| State order & helpers | `mcp-server/src/lib/workflow-states.ts` | 12-22 (STATE_ORDER), 117-129 (STATUS mapping) |
| Semantic intents | `mcp-server/src/lib/state-resolution.ts` | 12-30 (SEMANTIC_INTENTS), 34-49 (COMMAND_ALLOWED_STATES) |
| `save_issue` handler | `mcp-server/src/tools/issue-tools.ts` | 1095-1430 (full handler), 1141-1159 (resolution dispatch) |
| `create_issue` handler | `mcp-server/src/tools/issue-tools.ts` | 876-1090 (full handler), 1039-1071 (field setting) |
| State machine JSON | `hooks/scripts/ralph-state-machine.json` | Authoritative source |
| `form-idea` issue creation | `skills/form-idea/SKILL.md` | 160-172 (single issue), 214-225 (ticket tree) |
| `ralph-split` issue creation | `skills/ralph-split/SKILL.md` | 197-230 (create + set state) |
| `ralph-triage` split path | `skills/ralph-triage/SKILL.md` | 187-209 (create sub-issues) |

## Architecture Documentation

The state machine enforcement operates at three levels:

1. **MCP Server level**: `state-resolution.ts` resolves semantic intents and validates direct states against per-command allowlists. This is the innermost enforcement layer.

2. **Hook level**: Shell scripts in `hooks/scripts/` intercept tool calls via Claude Code's hook system. PreToolUse hooks block invalid transitions before they reach the API. PostToolUse hooks provide context feedback. Stop hooks validate postconditions.

3. **Skill level**: Each SKILL.md defines the expected flow via `set-skill-env.sh` (setting `RALPH_COMMAND`, `RALPH_VALID_OUTPUT_STATES`, `RALPH_REQUIRED_BRANCH`) and references the appropriate state gate script in its frontmatter hooks.

The system is designed for defense-in-depth: even if a skill prompt instructs an incorrect state, the hook and MCP server layers will block it.

## Open Questions

1. **Should `form-idea` set `workflowState: "Backlog"` on created issues?** Currently issues from `form-idea` have no state and are invisible to the triage pipeline. This appears to be a gap rather than an intentional design choice, since `ralph-split` does set state on its created issues.

2. **Should `ralph-triage` (split path) set workflowState on child issues?** The triage SPLIT path creates sub-issues with only `estimate` set, similar to `form-idea`. These children would also be invisible to the pipeline until manually triaged.

3. **Should `create_issue` sync the Status field like `save_issue` does?** Currently `create_issue` does not call `syncStatusField()` after setting workflowState. While no skill currently passes workflowState to `create_issue`, fixing this would prevent a future inconsistency if a skill starts using it.
