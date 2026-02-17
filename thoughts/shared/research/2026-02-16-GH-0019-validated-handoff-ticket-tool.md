---
date: 2026-02-16
github_issue: 19
github_url: https://github.com/cdubiel08/ralph-hero/issues/19
status: complete
type: research
---

# Research: GH-19 - Validated handoff_ticket Tool to Enforce State Machine Transitions

## Problem Statement

The current `ralph_hero__update_workflow_state` MCP tool accepts any workflow state string and passes it to GitHub Projects V2 with **no source-state validation**. While command-level output validation exists (via `state-resolution.ts`), the tool never checks whether the *current* state is allowed to transition to the *target* state per the state machine graph. This means:

1. An agent can jump from "Backlog" directly to "In Progress", bypassing research and planning phases
2. Shell hook scripts (`pre-github-validator.sh`, `post-github-validator.sh`) provide feedback but **do not block** invalid transitions - they exit 0 with advisory context
3. Agents spawned via `Task()` without `Skill()` have no hooks at all, creating an unguarded path
4. No audit trail exists for state transitions - changes happen silently without GitHub issue comments

## Current State Analysis

### What Exists Today

#### 1. The `update_workflow_state` Tool ([issue-tools.ts:1208-1295](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L1208-L1295))

The tool accepts `number`, `state`, and `command` parameters. Its logic:
1. Resolves semantic intents or validates direct state names via `resolveState()` from `state-resolution.ts`
2. Populates the field cache
3. Fetches current state (for the response, not for validation)
4. Resolves project item ID
5. Updates the GitHub Projects field
6. Returns `{ number, previousState, newState, command }`

**Key gap**: The current state is fetched (line 1251) but never compared against the state machine's `allowed_transitions` graph.

#### 2. State Resolution Module ([state-resolution.ts:1-196](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/state-resolution.ts))

Provides two validation layers:
- **Semantic intent resolution**: Maps `__LOCK__`, `__COMPLETE__`, `__ESCALATE__`, `__CLOSE__`, `__CANCEL__` to concrete states per command
- **Command output validation**: Checks if a target state is in `COMMAND_ALLOWED_STATES[command]`

This module validates *what a command is allowed to produce* but not *whether the current state permits the transition*.

#### 3. Workflow States Module ([workflow-states.ts:1-90](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts))

Defines state ordering constants (`STATE_ORDER`, `TERMINAL_STATES`, `LOCK_STATES`, `HUMAN_STATES`, `VALID_STATES`) and comparison helpers (`stateIndex`, `compareStates`, `isEarlierState`, `isValidState`). Used by pipeline detection, not by transition validation.

#### 4. State Machine JSON ([ralph-state-machine.json](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/ralph-state-machine.json))

The authoritative state machine definition with 11 states, each having:
- `allowed_transitions`: The valid target states from this state
- `required_by_commands` / `produces_for_commands`: Command mappings
- `is_lock_state`, `is_terminal`, `requires_human_action`: State metadata

This JSON defines the transition graph but it is only read by shell hook scripts, not by the TypeScript MCP server.

#### 5. Shell Hook Scripts

- [pre-github-validator.sh](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/pre-github-validator.sh): Checks if the target state exists in the state machine, provides advisory context about valid source states, but **always exits 0** (allows the transition)
- [post-github-validator.sh](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/post-github-validator.sh): After transition, provides feedback about next allowed transitions, terminal states, and human-needed states

Neither hook enforces transition validity - they are informational only.

#### 6. Skills Using `update_workflow_state`

| Skill | Transitions | Semantic Intents Used |
|-------|------------|----------------------|
| `ralph-triage` | Backlog -> Research Needed, Done, Canceled | `__ESCALATE__`, direct states |
| `ralph-research` | Research Needed -> Research in Progress -> Ready for Plan | `__LOCK__`, `__COMPLETE__` |
| `ralph-plan` | Ready for Plan -> Plan in Progress -> Plan in Review | `__LOCK__`, `__COMPLETE__` |
| `ralph-impl` | In Progress -> In Review | `__LOCK__`, `__COMPLETE__` |
| `ralph-review` | Plan in Review -> In Progress or Ready for Plan | `__COMPLETE__`, direct states, `__ESCALATE__` |
| `ralph-split` | Creates sub-issues in Backlog/Research Needed | `__COMPLETE__`, direct states |

All 6 skills call `update_workflow_state` with the `command` parameter for semantic resolution. The `ralph-hero` and `ralph-team` orchestrators delegate state transitions to these skills.

### Validation Gap Summary

| Layer | What It Validates | What It Misses |
|-------|------------------|----------------|
| `state-resolution.ts` | Command can produce target state | Source state allows target transition |
| `workflow-states.ts` | State ordering/comparison | No transition validation |
| `pre-github-validator.sh` | Target state exists | Does not block invalid transitions |
| `post-github-validator.sh` | None (post-hoc feedback) | Everything |
| `ralph-state-machine.json` | Defines `allowed_transitions` | Not consumed by TypeScript code |

**The `allowed_transitions` graph defined in `ralph-state-machine.json` is the key enforcement mechanism that is NOT used by the MCP server.**

## Key Discoveries

### 1. Existing Infrastructure is 80% Complete

The state machine JSON, semantic intent system, and command validation already exist. The missing piece is:
- Loading `allowed_transitions` into TypeScript
- Adding source-state validation to the tool
- Adding audit trail (issue comments)
- Adding structured guidance in the response

### 2. Prior Art Plan is Comprehensive

A detailed implementation plan exists at [thoughts/shared/plans/2026-02-15-handoff-ticket-mcp-tool.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-02-15-handoff-ticket-mcp-tool.md). It proposes:
- A `StateMachine` class with `isValidTransition()`, `getAllowedTransitions()`, `resolveIntent()`, and state metadata queries
- Embedded default config with optional JSON file override
- A `handoff_ticket` tool that validates transitions, posts audit comments, and returns structured guidance
- Extracting `resolveIssueNodeId` to `lib/resolve.ts` for shared use
- Updating all skill/agent references from `update_workflow_state` to `handoff_ticket`

### 3. `resolveIssueNodeId` is Currently in `relationship-tools.ts`

The comment-posting mutation needs `resolveIssueNodeId` (to get the issue's GraphQL node ID), which currently lives only in [relationship-tools.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts). The prior art plan correctly identifies this needs extraction to a shared `lib/resolve.ts`.

### 4. `create_comment` Tool Already Exists

The existing `ralph_hero__create_comment` tool in [issue-tools.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts) already posts comments to issues. The `handoff_ticket` tool can use the same GraphQL mutation inline rather than calling the MCP tool recursively.

### 5. Dual State Resolution Systems Would Need Consolidation

Currently, `state-resolution.ts` handles semantic intents with hardcoded mappings verified against the JSON. The proposed `StateMachine` class would embed equivalent logic. The implementation should either:
- **Option A**: Replace `state-resolution.ts` with the `StateMachine` class entirely
- **Option B**: Have `handoff_ticket` use `StateMachine` for transition validation while keeping `state-resolution.ts` for backward compat

**Recommendation**: Option A is cleaner. The `StateMachine` class subsumes all functionality of `state-resolution.ts` plus adds transition graph validation. The existing tests can be adapted to test `StateMachine` methods instead.

### 6. Hook Scripts Need Tool Name Updates

Both `pre-github-validator.sh` and `post-github-validator.sh` filter on `tool_name == "ralph_hero__update_workflow_state"`. When the tool is renamed to `handoff_ticket`, these hooks need updating or the hook filter needs to match both names during migration.

### 7. `__REJECT__` Intent is Missing from Current Implementation

The prior art plan adds a `__REJECT__` semantic intent (for review rejection: `ralph_review -> "Ready for Plan"`, `ralph_impl -> "In Progress"`, wildcard -> "Human Needed"). This intent does not exist in the current `state-resolution.ts` or `ralph-state-machine.json`. Adding it is a small scope addition that improves the intent vocabulary.

## Potential Approaches

### Approach A: Full Replacement (Recommended)

Replace `update_workflow_state` entirely with `handoff_ticket`. Create the `StateMachine` class, embed the transition graph, and update all 6 skill files.

**Pros**:
- Single source of truth for state transitions
- No backward compatibility complexity
- Audit trail from day one
- Structured guidance enables smarter agent decisions

**Cons**:
- All 6 skills must be updated simultaneously
- Hook scripts need tool name updates
- Larger change surface

### Approach B: Additive with Deprecation

Add `handoff_ticket` alongside `update_workflow_state`. Mark the old tool as deprecated. Update skills incrementally.

**Pros**:
- Lower risk of breaking existing workflows
- Incremental migration

**Cons**:
- Two tools doing similar things creates confusion
- Agents might use the wrong one
- Deprecation period adds maintenance burden
- The whole point is to prevent bypass - keeping the old tool defeats the purpose

### Approach C: Enhance Existing Tool In-Place

Add transition validation to `update_workflow_state` without renaming.

**Pros**:
- No skill/hook updates needed
- Minimal change surface

**Cons**:
- Doesn't add audit trail requirement (no `reason` parameter)
- Doesn't add structured guidance
- Doesn't improve the API surface
- Doesn't match the prior art plan

## Risks and Considerations

1. **Skill update breadth**: 6 skill files must reference the new tool name and use the new parameter signature (`intent`/`to_state` + `reason` instead of `state`). This is a bulk find-and-replace with semantic changes.

2. **Agent definitions**: Any agent `.md` files listing `ralph_hero__update_workflow_state` in their tool lists need updating to `ralph_hero__handoff_ticket`.

3. **Hook script compatibility**: The pre/post GitHub validator hooks filter on tool name. They need updating to match `ralph_hero__handoff_ticket` or the hook `tool_name` pattern needs to be broader.

4. **`create_comment` API cost**: Each `handoff_ticket` call adds one GitHub API mutation for the audit comment. This is ~1 additional API call per state transition. Given rate limits of 5000 points/hour and typical issue processing of ~5 transitions per issue, this is negligible.

5. **State machine JSON bundling**: The prior art plan embeds the state machine as TypeScript defaults with optional JSON override via env var. This is appropriate - it avoids runtime file dependency while allowing config changes without republishing.

6. **Test migration**: Existing `state-resolution.test.ts` (259 lines) tests semantic intent resolution and command validation. These tests can be adapted to test `StateMachine` methods. The JSON consistency tests should be preserved.

7. **NPM publish required**: Since the MCP server is published to npm as `ralph-hero-mcp-server`, a new version must be published after changes. The CD workflow handles this via version tag push.

## Recommended Next Steps

1. **Phase 1**: Create `lib/state-machine.ts` with `StateMachine` class, embedding the full transition graph and semantic intent resolution. Extract `resolveIssueNodeId` to `lib/resolve.ts`.

2. **Phase 2**: Implement `handoff_ticket` tool in `issue-tools.ts`, removing `update_workflow_state`. Wire `StateMachine` into server init.

3. **Phase 3**: Update all 6 skill SKILL.md files and agent definitions to reference `handoff_ticket`. Update hook scripts for new tool name.

4. **Phase 4**: Write comprehensive tests for `StateMachine` class and `handoff_ticket` tool error paths. Adapt existing `state-resolution.test.ts` tests.

5. **Phase 5**: Build, test, bump version, publish.

The prior art plan at `thoughts/shared/plans/2026-02-15-handoff-ticket-mcp-tool.md` provides detailed implementation specs for each phase including TypeScript code, and should be used as the primary reference during planning.
