---
date: 2026-02-18
status: draft
github_issue: 61
github_url: https://github.com/cdubiel08/ralph-hero/issues/61
---

# [Bug] Epic Stays at Back of Swimlane -- Add `advance_parent` Tool

## Overview

Parent epic issues remain in earlier workflow states on the GitHub Projects V2 board even when all child sub-issues have advanced. The root cause is that `advance_children` only propagates state downward (parent -> children). There is no upward propagation mechanism. This plan adds a new `ralph_hero__advance_parent` MCP tool and wires it into the integrator and team-lead workflows.

## Current State Analysis

- [`advance_children`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts#L515-L707) pushes child issues forward to match a parent's state (downward only)
- No mechanism exists to advance a parent when all children reach a gate state
- GitHub Projects V2 board position is determined by the `Workflow State` field value -- if parent state is not updated, it stays in the wrong column
- Existing helpers [`isEarlierState`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts#L77), [`compareStates`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts#L69), and [`stateIndex`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts#L60) can be reused
- The tool infrastructure in [`relationship-tools.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts) provides the registration pattern

## Desired End State

When all children of an epic reach a gate state, the parent automatically advances to that state when `advance_parent` is called. The board reflects accurate epic positions.

### Verification
- [ ] New `ralph_hero__advance_parent` tool exists and is callable
- [ ] Calling `advance_parent` with a child issue number looks up the parent, checks all siblings, and advances the parent if all are at or past a gate state
- [ ] Gate states are: "Ready for Plan", "In Review", "Done"
- [ ] Parent is NOT advanced for intermediate states (Research in Progress, Plan in Progress, In Progress)
- [ ] Parent is NOT advanced if ANY child is behind the gate state
- [ ] Integrator calls `advance_parent` after updating child workflow states in the merge flow
- [ ] Team-lead SKILL.md documents `advance_parent` usage at convergence gates
- [ ] Unit tests cover: all-children-at-gate, partial-children, no-parent, already-advanced scenarios

## What We're NOT Doing

- Automatic parent advancement inside `update_workflow_state` (too much implicit behavior)
- Periodic sync / batch epic refresh (treats symptom, not cause)
- Changing `advance_children` behavior (independent operations)
- Handling dependency relationships (blocking/blocked-by) -- only parent/child sub-issues

## Implementation Approach

Three phases: (1) implement the new MCP tool in `relationship-tools.ts`, (2) add unit tests, (3) wire the tool into the integrator agent and team-lead skill.

---

## Phase 1: Implement `advance_parent` MCP Tool

### Overview

Add a new `ralph_hero__advance_parent` tool to `relationship-tools.ts` that checks all siblings' workflow states and advances the parent when ALL children reach a gate state.

### Changes Required

#### 1. Define gate states constant
**File**: [`plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts)

Add a new exported constant defining which states trigger parent advancement:

```typescript
/**
 * Gate states that trigger parent advancement when ALL children reach them.
 * Intermediate "in progress" states should NOT advance the parent.
 */
export const PARENT_GATE_STATES: readonly string[] = [
  "Ready for Plan",
  "In Review",
  "Done",
] as const;
```

Add a helper function:

```typescript
/**
 * Check if a state is a parent advancement gate.
 */
export function isParentGateState(state: string): boolean {
  return PARENT_GATE_STATES.includes(state);
}
```

#### 2. Implement `advance_parent` tool
**File**: [`plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts)

Add the new tool registration inside `registerRelationshipTools()`, after the `advance_children` tool (after line 707). Import `PARENT_GATE_STATES` and `isParentGateState` from workflow-states.

**Tool signature**:
```typescript
server.tool(
  "ralph_hero__advance_parent",
  "Check if all siblings of a child issue have reached a gate state, and if so, advance the parent issue to match. Gate states: Ready for Plan, In Review, Done. Only applies to parent/child (sub-issue) relationships. Returns what changed or why the parent was not advanced.",
  {
    owner: z.string().optional().describe("GitHub owner. Defaults to GITHUB_OWNER env var"),
    repo: z.string().optional().describe("Repository name. Defaults to GITHUB_REPO env var"),
    number: z.number().describe("Child issue number (any child in the group)"),
  },
  async (args) => { ... }
)
```

**Implementation logic**:

1. Resolve config (owner, repo, projectNumber, projectOwner)
2. Ensure field cache is populated
3. Fetch the child issue to find its parent:
   ```graphql
   query($owner: String!, $repo: String!, $number: Int!) {
     repository(owner: $owner, name: $repo) {
       issue(number: $number) {
         number
         title
         parent { number title state }
       }
     }
   }
   ```
4. If no parent: return `{ advanced: false, reason: "Issue has no parent" }`
5. Fetch all siblings (sub-issues of the parent):
   ```graphql
   query($owner: String!, $repo: String!, $parentNumber: Int!) {
     repository(owner: $owner, name: $repo) {
       issue(number: $parentNumber) {
         number
         title
         subIssues(first: 50) {
           nodes { id number title state }
         }
       }
     }
   }
   ```
6. Get workflow state for each sibling via `getCurrentFieldValue`
7. Find the minimum state among all siblings (using `stateIndex`). Skip siblings with states not in `STATE_ORDER` (e.g., "Human Needed", "Canceled") -- treat these as blockers that prevent parent advancement
8. Check if the minimum state is a gate state via `isParentGateState`
9. If not a gate state: return `{ advanced: false, reason: "Not all children at a gate state", childStates: [...] }`
10. Get the parent's current workflow state via `getCurrentFieldValue`
11. If parent is already at or past the minimum gate state: return `{ advanced: false, reason: "Parent already at or past target state", parentState, targetState }`
12. Advance the parent: resolve project item ID, call `updateProjectItemField` and `syncStatusField`
13. Return `{ advanced: true, parent: { number, fromState, toState }, childStates: [...] }`

**Key decisions**:
- "Human Needed" and "Canceled" children block parent advancement (they're not in `STATE_ORDER`)
- The minimum child state determines the target, not the child passed as argument
- Only advances when ALL children are at or past a single gate state
- Does NOT call `advance_children` afterward (independent operations)

#### 3. Update imports in relationship-tools.ts

Add `PARENT_GATE_STATES` and `isParentGateState` to the import from `workflow-states.js`:

**Before**:
```typescript
import {
  isValidState,
  isEarlierState,
  VALID_STATES,
} from "../lib/workflow-states.js";
```

**After**:
```typescript
import {
  isValidState,
  isEarlierState,
  VALID_STATES,
  PARENT_GATE_STATES,
  isParentGateState,
  stateIndex,
} from "../lib/workflow-states.js";
```

### Success Criteria

#### Automated Verification
- [ ] `npm run build` succeeds with no TypeScript errors
- [ ] `grep "advance_parent" plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts` matches the tool registration
- [ ] `grep "PARENT_GATE_STATES" plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts` matches the constant

#### Manual Verification
- [ ] Tool accepts a child issue number and returns appropriate result
- [ ] Tool handles: no parent, parent already advanced, not all children at gate, all children at gate

---

## Phase 2: Add Unit Tests

### Overview

Add tests for the new `PARENT_GATE_STATES` constant, `isParentGateState` helper, and document the `advance_parent` tool's expected behavior.

### Changes Required

#### 1. Add gate state tests to workflow-states.test.ts
**File**: [`plugin/ralph-hero/mcp-server/src/__tests__/workflow-states.test.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/__tests__/workflow-states.test.ts)

Add new test blocks:

```typescript
import { PARENT_GATE_STATES, isParentGateState } from "../lib/workflow-states.js";

describe("PARENT_GATE_STATES", () => {
  it("contains exactly the expected gate states", () => {
    expect(PARENT_GATE_STATES).toEqual(["Ready for Plan", "In Review", "Done"]);
  });

  it("does not include intermediate states", () => {
    expect(PARENT_GATE_STATES).not.toContain("Research in Progress");
    expect(PARENT_GATE_STATES).not.toContain("Plan in Progress");
    expect(PARENT_GATE_STATES).not.toContain("In Progress");
    expect(PARENT_GATE_STATES).not.toContain("Backlog");
  });
});

describe("isParentGateState", () => {
  it("returns true for gate states", () => {
    expect(isParentGateState("Ready for Plan")).toBe(true);
    expect(isParentGateState("In Review")).toBe(true);
    expect(isParentGateState("Done")).toBe(true);
  });

  it("returns false for non-gate states", () => {
    expect(isParentGateState("Backlog")).toBe(false);
    expect(isParentGateState("Research in Progress")).toBe(false);
    expect(isParentGateState("Plan in Progress")).toBe(false);
    expect(isParentGateState("In Progress")).toBe(false);
    expect(isParentGateState("Human Needed")).toBe(false);
    expect(isParentGateState("Canceled")).toBe(false);
  });
});
```

### Success Criteria

#### Automated Verification
- [ ] `npm test` passes with all new tests green
- [ ] Gate state tests validate the exact set of states

#### Manual Verification
- [ ] Tests cover positive and negative cases for gate state identification

---

## Phase 3: Wire `advance_parent` into Integrator and Team-Lead

### Overview

Update the integrator agent and team-lead SKILL.md to call `advance_parent` at the appropriate points in the workflow.

### Changes Required

#### 1. Add `advance_parent` to integrator agent tools
**File**: [`plugin/ralph-hero/agents/ralph-integrator.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/agents/ralph-integrator.md)

**Line 4** (tools list): Add `ralph_hero__advance_parent` to the tool list.

**Before**:
```yaml
tools: Read, Glob, Bash, TaskList, TaskGet, TaskUpdate, SendMessage, ralph_hero__get_issue, ralph_hero__list_issues, ralph_hero__update_issue, ralph_hero__update_workflow_state, ralph_hero__create_comment, ralph_hero__advance_children, ralph_hero__list_sub_issues
```

**After**:
```yaml
tools: Read, Glob, Bash, TaskList, TaskGet, TaskUpdate, SendMessage, ralph_hero__get_issue, ralph_hero__list_issues, ralph_hero__update_issue, ralph_hero__update_workflow_state, ralph_hero__create_comment, ralph_hero__advance_children, ralph_hero__advance_parent, ralph_hero__list_sub_issues
```

#### 2. Add advance_parent call to integrator merge flow
**File**: [`plugin/ralph-hero/agents/ralph-integrator.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/agents/ralph-integrator.md)

After step 6d (`advance_children` call), add step 6e:

**Before** (line 23-24):
```markdown
   d. Advance parent: `advance_children(parentNumber=EPIC)` if epic member
   e. Post comment: merge completion summary
```

**After**:
```markdown
   d. Advance parent (downward): `advance_children(parentNumber=EPIC)` if epic member
   e. Advance parent (upward): `advance_parent(number=ISSUE)` -- checks if all siblings are at a gate state and advances the parent if so
   f. Post comment: merge completion summary
```

#### 3. Document advance_parent in team-lead SKILL.md
**File**: [`plugin/ralph-hero/skills/ralph-team/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-team/SKILL.md)

In Section 3 (State Detection & Pipeline Position), under "Group Tracking" (around line 91), add a note about parent advancement:

**After** line 91 (`- **Child state advancement**: Lead MUST advance children via ...`):

Add:
```markdown
- **Parent state advancement**: When all children of an epic reach a gate state (Ready for Plan, In Review, Done), the parent advances automatically via `ralph_hero__advance_parent`. The integrator calls this after merge; the lead should call it at convergence gates (e.g., after all research tasks complete for a group).
```

### Success Criteria

#### Automated Verification
- [ ] `grep "advance_parent" plugin/ralph-hero/agents/ralph-integrator.md` matches in tools list and merge flow
- [ ] `grep "advance_parent" plugin/ralph-hero/skills/ralph-team/SKILL.md` matches in group tracking section

#### Manual Verification
- [ ] Integrator calls `advance_parent` after updating child states in merge flow
- [ ] Team-lead SKILL.md documents when to call `advance_parent`
- [ ] Tool list in integrator frontmatter includes `advance_parent`

---

## Testing Strategy

1. **Unit tests** (Phase 2): Test `PARENT_GATE_STATES` and `isParentGateState` in existing workflow-states test file
2. **Build verification**: `npm run build` must succeed (TypeScript compilation)
3. **Full test suite**: `npm test` must pass with no regressions
4. **Grep checks**: Verify tool registration, constant export, and agent/skill references
5. **Manual smoke test**: After implementation, call `advance_parent` on a child of an epic and verify the parent advances when all children are at a gate state

## References

- [Issue #61](https://github.com/cdubiel08/ralph-hero/issues/61)
- [Research: GH-61](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-18-GH-0061-epic-swimlane-position.md)
- [`advance_children` implementation](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts#L515-L707)
- [`workflow-states.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts)
- [`ralph-integrator.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/agents/ralph-integrator.md)
- [`SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-team/SKILL.md)
