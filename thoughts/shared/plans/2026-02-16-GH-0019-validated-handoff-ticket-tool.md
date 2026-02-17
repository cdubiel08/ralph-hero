---
date: 2026-02-16
status: draft
github_issue: 19
github_url: https://github.com/cdubiel08/ralph-hero/issues/19
---

# Validated handoff_ticket Tool to Enforce State Machine Transitions

## Overview

Replace the raw `ralph_hero__update_workflow_state` MCP tool with `ralph_hero__handoff_ticket` — a validated, intent-aware state transition tool that enforces the Ralph workflow state machine at the MCP protocol layer. Every state change goes through this tool, which validates transitions against the state graph, resolves semantic intents per-command, requires an audit reason (posted as a GitHub issue comment), and returns structured guidance about the new state. No agent can bypass the state machine because the raw tool no longer exists.

## Current State Analysis

### The Gap

The existing `update_workflow_state` tool ([issue-tools.ts:1208-1295](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L1208-L1295)) fetches the current state but **never validates** whether the transition is allowed per the state machine graph defined in [ralph-state-machine.json](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/ralph-state-machine.json). Shell hook scripts provide advisory feedback but always exit 0. Agents spawned via `Task()` without `Skill()` have no hooks at all.

### What Exists

| Component | Location | What It Does | Gap |
|-----------|----------|-------------|-----|
| `state-resolution.ts` | [lib/state-resolution.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/state-resolution.ts) | Semantic intent → state resolution, command output validation | No source-state transition validation |
| `workflow-states.ts` | [lib/workflow-states.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts) | State ordering, comparison helpers | No transition graph |
| `ralph-state-machine.json` | [hooks/scripts/](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/ralph-state-machine.json) | Full transition graph, 11 states, `allowed_transitions` | Only read by shell scripts, not by TypeScript |
| Shell hooks | [hooks/scripts/](https://github.com/cdubiel08/ralph-hero/tree/main/plugin/ralph-hero/hooks/scripts) | Pre/post validation, advisory context | Always exit 0, informational only |
| `resolveIssueNodeId` | Duplicated in [issue-tools.ts:117-145](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L117-L145) and [relationship-tools.ts:27-50](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts#L27-L50) | Resolves issue # → GraphQL node ID | Duplicated across two files |

### Scope of Changes

References to `update_workflow_state` exist across **23 files**:
- **7 skill files**: ralph-triage, ralph-research, ralph-plan, ralph-review, ralph-impl, ralph-split, shared/conventions.md
- **5 agent files**: ralph-triager, ralph-researcher, ralph-planner, ralph-advocate, ralph-implementer
- **11 hook files**: hooks.json (2 matchers), plus 9 individual hook scripts
- **0 test files**: No existing tests reference the tool name directly

## Desired End State

1. `ralph_hero__update_workflow_state` no longer exists
2. `ralph_hero__handoff_ticket` is the only way to change workflow state
3. `StateMachine` class embeds the full transition graph with compile-time type safety
4. Every transition posts a GitHub issue comment (audit trail)
5. Semantic intents (`lock`, `complete`, `escalate`, `reject`, `close`, `cancel`) resolve per-command
6. Invalid transitions return structured errors with valid alternatives
7. All 7 skill files, 5 agent files, and 11 hook files reference `handoff_ticket`

### Verification
- [ ] `npm run build` compiles with no type errors
- [ ] `npm test` passes with new StateMachine + handoff_ticket tests
- [ ] Calling `handoff_ticket` with invalid transition returns error listing valid transitions
- [ ] Calling `handoff_ticket` with valid transition succeeds and posts audit comment
- [ ] Calling `handoff_ticket` with semantic intent resolves correctly per command
- [ ] `update_workflow_state` tool no longer appears in MCP tool list
- [ ] `grep -r "update_workflow_state" plugin/ralph-hero/` returns no matches

## What We're NOT Doing

- Not changing the state machine itself (same 11 states, same transition graph)
- Not adding new states or transition rules
- Not changing how other issue tools work (create, update, estimate, priority, comment)
- Not implementing precondition checking beyond state transitions (e.g., "does research doc exist?")
- Not removing local hook scripts — they continue providing advisory context for the new tool name
- Not adding `__REJECT__` intent (out of scope for this issue; can be a follow-up)

## Implementation Approach

Create a `StateMachine` class that embeds the transition graph as TypeScript types, replacing `state-resolution.ts`. Implement `handoff_ticket` tool in `issue-tools.ts` that validates transitions, posts audit comments, and returns structured guidance. Update all 23 referencing files. Write comprehensive tests.

---

## Phase 1: StateMachine Class and Shared Utilities

### Overview

Create the `StateMachine` class that embeds the full transition graph from `ralph-state-machine.json` as TypeScript defaults. This class subsumes all functionality of `state-resolution.ts` (semantic intent resolution, command output validation) and adds the critical missing piece: source-state transition validation.

Also extract `resolveIssueNodeId` into a shared utility to eliminate duplication between `issue-tools.ts` and `relationship-tools.ts`.

### Changes Required

#### 1. Create StateMachine class

**File**: `plugin/ralph-hero/mcp-server/src/lib/state-machine.ts` (NEW)

Create a new module with:

- **Type definitions**: `WorkflowState` (union of 11 state string literals), `RalphCommand` (union of 7 command names), `SemanticIntent` (union of 6 intent names), `StateDefinition`, `CommandDefinition`, `StateMachineConfig`
- **`StateMachine` class** with methods:
  - `isValidTransition(from, to)` — checks `allowed_transitions` graph
  - `getAllowedTransitions(from)` — returns valid target states
  - `resolveIntent(intent, command)` — semantic intent → state (replaces `state-resolution.ts` logic)
  - `isLockState(state)`, `isTerminal(state)`, `requiresHumanAction(state)` — state metadata queries
  - `isValidState(state)` — type guard for `WorkflowState`
  - `getExpectedByCommands(state)` — which commands expect this state as input
  - `isValidOutputForCommand(command, state)` — command output validation (replaces `COMMAND_ALLOWED_STATES`)
- **`DEFAULT_CONFIG`**: Embedded config matching `ralph-state-machine.json` states (11 states with `allowed_transitions`, `is_lock_state`, `is_terminal`, `requires_human_action`), semantic intents (5 intents from current `SEMANTIC_INTENTS` in state-resolution.ts), and commands (7 commands with `valid_input_states`, `valid_output_states`, `lock_state`)
- **`loadStateMachine(configPath?)`**: Factory function that loads from optional JSON path (via `RALPH_STATE_MACHINE_CONFIG` env var) or falls back to `DEFAULT_CONFIG`

**Key design decisions**:
- Embed config as TypeScript defaults (not runtime JSON dependency) for reliability. The JSON file in `hooks/scripts/` remains the authoritative reference but is consumed at build time via the data consistency test, not at runtime.
- The `StateMachine` class is a pure data structure + validators. No I/O, no side effects. This makes it trivially testable.
- Use string literal union types (`WorkflowState`, `RalphCommand`) for compile-time safety. The `isValidState` method serves as a runtime type guard.

#### 2. Extract resolveIssueNodeId to shared utility

**File**: `plugin/ralph-hero/mcp-server/src/lib/resolve.ts` (NEW)

Move the `resolveIssueNodeId` function from `issue-tools.ts` (lines 117-145) to this new shared module. The function is identical in both `issue-tools.ts` and `relationship-tools.ts` — extract it once and import from both.

The function:
- Takes `(client: GitHubClient, owner: string, repo: string, number: number)`
- Checks `SessionCache` for `issue-node-id:${owner}/${repo}#${number}`
- Falls back to GraphQL query
- Caches result for 30 minutes
- Returns the GraphQL node ID string

#### 3. Update imports in issue-tools.ts and relationship-tools.ts

**File**: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts`
- Remove the local `resolveIssueNodeId` function (lines 117-145)
- Add import: `import { resolveIssueNodeId } from "../lib/resolve.js";`

**File**: `plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts`
- Remove the local `resolveIssueNodeId` function (lines 27-52)
- Add import: `import { resolveIssueNodeId } from "../lib/resolve.js";`

### Success Criteria

#### Automated Verification
- [x] `npm run build` compiles with no type errors
- [x] `npm test` passes (existing tests unaffected)
- [x] `StateMachine` class correctly validates all 11 states' transition rules

#### Manual Verification
- [x] Semantic intent resolution returns same results as current `state-resolution.ts`
- [x] `resolveIssueNodeId` works identically from both import locations

**Dependencies created for Phase 2**: `StateMachine` class and `resolveIssueNodeId` utility

---

## Phase 2: Implement handoff_ticket Tool and Remove update_workflow_state

### Overview

Create the `ralph_hero__handoff_ticket` tool that replaces `update_workflow_state`. Wire the `StateMachine` into the server initialization. Delete the old tool and the now-superseded `state-resolution.ts` module.

### Changes Required

#### 1. Wire StateMachine into server init

**File**: `plugin/ralph-hero/mcp-server/src/index.ts`

- Add import: `import { loadStateMachine } from "./lib/state-machine.js";`
- After `const fieldCache = new FieldOptionCache();` (line 281), add:
  ```typescript
  const stateMachineConfigPath = resolveEnv("RALPH_STATE_MACHINE_CONFIG");
  const stateMachine = loadStateMachine(stateMachineConfigPath);
  ```
- Update `registerIssueTools` call (line 293) to pass `stateMachine`:
  ```typescript
  registerIssueTools(server, client, fieldCache, stateMachine);
  ```

#### 2. Update registerIssueTools signature

**File**: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts`

- Add `stateMachine` parameter to function signature:
  ```typescript
  export function registerIssueTools(
    server: McpServer,
    client: GitHubClient,
    fieldCache: FieldOptionCache,
    stateMachine: StateMachine,
  ): void {
  ```
- Add imports:
  ```typescript
  import { StateMachine, type WorkflowState } from "../lib/state-machine.js";
  import { resolveIssueNodeId } from "../lib/resolve.js";
  ```
- Remove import of `resolveState` from `../lib/state-resolution.js` (line 24)

#### 3. Implement handoff_ticket tool

**File**: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts`

Replace the `ralph_hero__update_workflow_state` tool (lines 1208-1295) with `ralph_hero__handoff_ticket`. The new tool:

**Parameters** (zod schema):
- `owner` (optional string) — GitHub owner, defaults to env
- `repo` (optional string) — repo name, defaults to env
- `number` (number, required) — issue number
- `command` (enum: `triage|split|research|plan|review|impl|hero`, required) — requesting Ralph command
- `intent` (optional enum: `lock|complete|escalate|close|cancel`) — semantic intent, mutually exclusive with `to_state`
- `to_state` (optional string) — explicit target state, mutually exclusive with `intent`
- `reason` (string, required) — audit trail text, posted as GitHub comment

**Logic flow**:
1. **Input validation**: Reject if both `intent` and `to_state` provided, or neither
2. **Resolve target state**: If `intent`, call `stateMachine.resolveIntent(intent, command)`. If `to_state`, use directly
3. **Validate target state exists**: `stateMachine.isValidState(targetState)`
4. **Fetch current state**: `getCurrentFieldValue(...)` for "Workflow State"
5. **Validate transition**: `stateMachine.isValidTransition(currentState, targetState)`. On failure, return error with `getAllowedTransitions(currentState)`
6. **Validate command output**: `stateMachine.isValidOutputForCommand(command, targetState)`. On failure, return error with valid outputs for command
7. **Execute transition**: `resolveProjectItemId()` then `updateProjectItemField(..., "Workflow State", targetState)`
8. **Post audit comment**: GraphQL `addComment` mutation via `client.mutate()` with body: `**State transition**: {prev} → {new} (intent: {intent})\n**Command**: ralph_{command}\n**Reason**: {reason}`
9. **Return structured guidance**: `{ number, previousState, newState, intent, command, reason, guidance: { isLockState, isTerminal, requiresHumanAction, allowedNextTransitions, expectedByCommands, note } }`

#### 4. Delete update_workflow_state tool

**File**: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts`

Remove the entire `ralph_hero__update_workflow_state` tool registration block (lines 1205-1295).

#### 5. Delete state-resolution.ts

**File**: `plugin/ralph-hero/mcp-server/src/lib/state-resolution.ts`

Delete this file entirely. Its functionality is fully subsumed by the `StateMachine` class:
- `SEMANTIC_INTENTS` → `StateMachine.resolveIntent()`
- `COMMAND_ALLOWED_STATES` → `StateMachine.isValidOutputForCommand()`
- `resolveState()` → replaced by `handoff_ticket` tool logic

#### 6. Update update_issue tool description

**File**: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts`

Update the `ralph_hero__update_issue` tool description (line 1100) from:
```
"Use update_workflow_state for state changes"
```
to:
```
"Use handoff_ticket for state changes"
```

### Success Criteria

#### Automated Verification
- [x] `npm run build` compiles with no type errors
- [x] `npm test` passes (existing `state-resolution.test.ts` tests will need updates — see Phase 4)
- [x] `update_workflow_state` no longer appears in MCP tool list
- [x] `handoff_ticket` with `intent: "complete", command: "research"` returns `newState: "Ready for Plan"`
- [x] `handoff_ticket` with invalid transition returns error with allowed transitions
- [x] `handoff_ticket` with both `intent` and `to_state` returns error
- [x] `handoff_ticket` with neither `intent` nor `to_state` returns error

#### Manual Verification
- [x] GitHub issue comment is created on successful transition
- [x] Comment includes previous state, new state, command, and reason

**Depends on**: Phase 1 (`StateMachine` class, `resolveIssueNodeId` utility)

---

## Phase 3: Update All Skill, Agent, and Hook References

### Overview

Update all 23 files referencing `update_workflow_state` to use `handoff_ticket` instead. This is a systematic find-and-replace with semantic changes to parameter usage.

### Changes Required

#### 1. Update Skill Files (7 files)

For each skill file, replace `ralph_hero__update_workflow_state` calls with `ralph_hero__handoff_ticket` calls. The key parameter changes:

**Old pattern**:
```
ralph_hero__update_workflow_state
- number: [N]
- state: "__LOCK__"
- command: "ralph_research"
```

**New pattern**:
```
ralph_hero__handoff_ticket
- number: [N]
- command: "research"
- intent: "lock"
- reason: "Starting research phase"
```

Key transformations:
- `state: "__LOCK__"` → `intent: "lock"`
- `state: "__COMPLETE__"` → `intent: "complete"`
- `state: "__ESCALATE__"` → `intent: "escalate"`
- `state: "__CLOSE__"` → `intent: "close"`
- `state: "__CANCEL__"` → `intent: "cancel"`
- `state: "Research Needed"` → `to_state: "Research Needed"`
- `command: "ralph_research"` → `command: "research"` (drop `ralph_` prefix)
- Add `reason: "..."` to every call (describe what was accomplished)

**Files and specific changes**:

| File | Changes |
|------|---------|
| `skills/ralph-triage/SKILL.md` | Lines 12, 149, 158, 218, 384: Update tool name in hook matcher, all invocations, error handling text |
| `skills/ralph-research/SKILL.md` | Lines 60, 68, 125: Lock (line 60), error handling (68), complete (125) |
| `skills/ralph-plan/SKILL.md` | Lines 11, 113, 210: Hook matcher (11), lock (113), complete (210) |
| `skills/ralph-review/SKILL.md` | Lines 15, 225, 233, 271, 351: Hook matcher (15), approve→In Progress (225), error (233), reject→Ready for Plan (271), escalate (351) |
| `skills/ralph-impl/SKILL.md` | Lines 13, 118, 260: Hook matcher (13), lock (118), complete (260) |
| `skills/ralph-split/SKILL.md` | Lines 269, 277, 378: Set initial state (269), error (277), complete (378) |
| `skills/shared/conventions.md` | Lines 32, 72: Escalate example (32), error handling guidance (72) |

#### 2. Update Agent Files (5 files)

Replace `ralph_hero__update_workflow_state` with `ralph_hero__handoff_ticket` in the `tools:` list on line 4 of each agent:

| File | Change |
|------|--------|
| `agents/ralph-triager.md` | Tool list update |
| `agents/ralph-researcher.md` | Tool list update |
| `agents/ralph-planner.md` | Tool list update |
| `agents/ralph-advocate.md` | Tool list update |
| `agents/ralph-implementer.md` | Tool list update |

#### 3. Update Hook Files (11 files)

**File**: `hooks/hooks.json`
- Line 10: Change `"matcher": "ralph_hero__update_workflow_state"` → `"matcher": "ralph_hero__handoff_ticket"`
- Line 48: Same change for PostToolUse matcher

**Hook scripts** (9 files): Update tool name checks and comments.

| File | Lines | Change |
|------|-------|--------|
| `hooks/scripts/pre-github-validator.sh` | 20 | `$TOOL_NAME != "ralph_hero__update_workflow_state"` → `"ralph_hero__handoff_ticket"` |
| `hooks/scripts/post-github-validator.sh` | 18 | Same pattern |
| `hooks/scripts/state-gate.sh` | 5, 26 | Comment + conditional |
| `hooks/scripts/convergence-gate.sh` | 3, 6 | Comments |
| `hooks/scripts/auto-state.sh` | 5, 27 | Comment + conditional. NOTE: This hook's semantic intent interception is now handled by the tool itself. The hook can be simplified to pass-through or removed. For this phase, just update the tool name match. |
| `hooks/scripts/research-state-gate.sh` | 3 | Comment |
| `hooks/scripts/review-state-gate.sh` | 3 | Comment |
| `hooks/scripts/triage-state-gate.sh` | 3 | Comment |
| `hooks/scripts/impl-state-gate.sh` | 3 | Comment |
| `hooks/scripts/plan-state-gate.sh` | 3 | Comment |

### Success Criteria

#### Automated Verification
- [x] `grep -r "update_workflow_state" plugin/ralph-hero/` returns **zero matches**
- [x] `grep -r "handoff_ticket" plugin/ralph-hero/skills/` returns matches in all 7 skill files
- [x] `grep -r "handoff_ticket" plugin/ralph-hero/agents/` returns matches in all 5 agent files
- [x] `grep -r "handoff_ticket" plugin/ralph-hero/hooks/` returns matches in hooks.json

#### Manual Verification
- [x] Skill invocation examples are syntactically correct (valid `intent`/`to_state` enum values, `reason` present)
- [x] Hook scripts correctly filter on the new tool name

**Depends on**: Phase 2 (tool must exist before references make sense)

---

## Phase 4: Tests

### Overview

Write comprehensive tests for the `StateMachine` class and adapt the existing `state-resolution.test.ts` to test the new system. The existing test file has 259 lines of well-structured tests for semantic intents and command validation — these test cases should be preserved and adapted.

### Changes Required

#### 1. State Machine Unit Tests

**File**: `plugin/ralph-hero/mcp-server/src/__tests__/state-machine.test.ts` (NEW)

Test suites:

**`isValidTransition`**:
- Valid transitions accepted (e.g., "Backlog" → "Research Needed")
- Invalid transitions rejected (e.g., "Backlog" → "In Progress")
- Terminal states have no transitions ("Done" → anything = false)
- "Human Needed" → allowed targets ("Backlog", "Research Needed", "Ready for Plan", "In Progress")
- Bidirectional transitions where applicable ("Plan in Review" ↔ "Ready for Plan")

**`getAllowedTransitions`**:
- Returns correct transition list for each of the 11 states
- Terminal states return empty array
- "Human Needed" returns 4 allowed targets

**`resolveIntent`** (adapt from `state-resolution.test.ts`):
- `lock` + research → "Research in Progress"
- `lock` + plan → "Plan in Progress"
- `lock` + impl → "In Progress"
- `complete` + research → "Ready for Plan"
- `complete` + plan → "Plan in Review"
- `complete` + impl → "In Review"
- `complete` + review → "In Progress"
- `complete` + split → "Backlog"
- `complete` + triage → null (ambiguous)
- `escalate` + any → "Human Needed" (wildcard)
- `close` + any → "Done"
- `cancel` + any → "Canceled"
- Unknown command returns null

**State metadata queries**:
- `isLockState` identifies 3 lock states
- `isTerminal` identifies "Done" and "Canceled"
- `requiresHumanAction` identifies "Human Needed", "Plan in Review", "In Review"
- `isValidState` accepts all 11 states, rejects arbitrary strings

**`isValidOutputForCommand`**:
- Each of the 7 commands validates its output states correctly
- Unknown commands pass through (return true)

**`getExpectedByCommands`**:
- "Research Needed" → expected by `ralph_research`, `ralph_split`
- "Ready for Plan" → expected by `ralph_plan`
- "Plan in Review" → expected by `ralph_review`, `ralph_impl`

**Data consistency with JSON**:
- Adapt existing JSON consistency tests from `state-resolution.test.ts` (lines 193-258)
- Verify `DEFAULT_CONFIG.states` matches `ralph-state-machine.json` states and `allowed_transitions`
- Verify `DEFAULT_CONFIG.semantic_states` matches JSON `semantic_states`
- Verify `DEFAULT_CONFIG.commands` matches JSON `commands`

**Config loading**:
- `loadStateMachine()` without path returns default config
- `loadStateMachine("/nonexistent/path")` falls back to defaults

#### 2. Delete state-resolution.test.ts

**File**: `plugin/ralph-hero/mcp-server/src/__tests__/state-resolution.test.ts`

Delete this file. All test cases are migrated into `state-machine.test.ts` with updated API calls (e.g., `resolveState("__LOCK__", "research")` → `stateMachine.resolveIntent("lock", "research")`).

### Success Criteria

#### Automated Verification
- [ ] `npm test` passes all new tests
- [ ] All 11 states' transition rules tested
- [ ] All semantic intent × command combinations tested
- [ ] JSON consistency tests pass
- [ ] No references to deleted `state-resolution.test.ts`

#### Manual Verification
- [ ] Test output is clean with descriptive test names

**Depends on**: Phase 1 (StateMachine class must exist), Phase 2 (state-resolution.ts deleted)

---

## Testing Strategy

### Unit Tests (Phase 4)
- `StateMachine` class: transition validation, intent resolution, state metadata
- JSON data consistency: embedded defaults match `ralph-state-machine.json`

### Integration Testing (Manual)
1. Build: `cd plugin/ralph-hero/mcp-server && npm run build`
2. Start Claude Code with plugin
3. Call `handoff_ticket` with valid intent → verify state change + audit comment on GitHub
4. Call `handoff_ticket` with invalid transition → verify rejection with valid alternatives
5. Run `/ralph-research` on a test issue → verify it uses `handoff_ticket` for lock + complete
6. Verify `update_workflow_state` no longer in tool list
7. Full workflow: triage → research → plan → review → implement → done

## Performance Considerations

- State machine config loaded once at startup, held in memory (negligible)
- Each `handoff_ticket` call adds **one extra API call** vs old tool: the `addComment` mutation for audit trail
- `getCurrentFieldValue` already called by old tool — no additional cost
- `resolveIssueNodeId` for comments uses existing 30-min cache
- Net cost: ~1 additional API mutation per state transition (well within 5000 points/hour rate limit)

## File Ownership Summary

| Phase | Key Files (NEW) | Key Files (MODIFIED) | Key Files (DELETED) |
|-------|-----------------|---------------------|---------------------|
| 1 | `lib/state-machine.ts`, `lib/resolve.ts` | `tools/issue-tools.ts`, `tools/relationship-tools.ts` | — |
| 2 | — | `index.ts`, `tools/issue-tools.ts` | `lib/state-resolution.ts` |
| 3 | — | 7 skill files, 5 agent files, `hooks.json`, 9 hook scripts | — |
| 4 | `__tests__/state-machine.test.ts` | — | `__tests__/state-resolution.test.ts` |

## References

- [Issue #19](https://github.com/cdubiel08/ralph-hero/issues/19) — Validated handoff_ticket tool
- [Research document](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-16-GH-0019-validated-handoff-ticket-tool.md)
- [Prior art plan](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-02-15-handoff-ticket-mcp-tool.md)
- [State machine JSON](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/ralph-state-machine.json)
- [Current issue-tools.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts)
- [Current state-resolution.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/state-resolution.ts)
