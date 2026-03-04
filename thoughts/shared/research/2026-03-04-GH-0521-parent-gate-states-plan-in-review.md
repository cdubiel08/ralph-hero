---
date: 2026-03-04
github_issue: 521
github_url: https://github.com/cdubiel08/ralph-hero/issues/521
status: complete
type: research
---

# Add Plan in Review to PARENT_GATE_STATES

## Problem Statement

`PARENT_GATE_STATES` in [`workflow-states.ts:50-54`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts#L50-L54) does not include `"Plan in Review"`. When all sub-issues reach "Plan in Review", calling `advance_issue(direction="parent")` returns `advanced: false` because the state is not recognized as a gate. The parent stays stuck at "Ready for Plan" while children are two states ahead.

## Current State Analysis

### PARENT_GATE_STATES Definition

[`plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts:50-54`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts#L50-L54):

```typescript
export const PARENT_GATE_STATES: readonly string[] = [
  "Ready for Plan",
  "In Review",
  "Done",
] as const;
```

Missing: `"Plan in Review"` — the state where all children have plans ready for human review.

### How PARENT_GATE_STATES Is Used

**`advance_issue` in `relationship-tools.ts`**:

[`plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts:806`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts#L806):

```typescript
if (!isParentGateState(minState)) {
  return toolSuccess({
    ...
    gateStates: [...PARENT_GATE_STATES],
  });
}
```

The `advance_issue(direction="parent")` tool finds the minimum workflow state among all siblings, then checks `isParentGateState(minState)`. If false, it returns without advancing. Adding `"Plan in Review"` to the array makes this check pass when all siblings are in "Plan in Review".

**`isParentGateState` helper**:

[`plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts:59-61`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts#L59-L61):

```typescript
export function isParentGateState(state: string): boolean {
  return PARENT_GATE_STATES.includes(state);
}
```

Pure array lookup. Adding `"Plan in Review"` makes `isParentGateState("Plan in Review")` return `true`.

### Test Coverage

[`plugin/ralph-hero/mcp-server/src/__tests__/workflow-states.test.ts:102-130`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/__tests__/workflow-states.test.ts#L102-L130):

- Line 104: `expect(PARENT_GATE_STATES).toEqual(["Ready for Plan", "In Review", "Done"])` — must add `"Plan in Review"` to expected array
- Line 117-119: `isParentGateState` true cases — must add `"Plan in Review"` assertion
- Line 123-128: `isParentGateState` false cases — "Plan in Review" is NOT in this list (it wasn't explicitly tested as false), so no removal needed

### Rationale for Adding

"Plan in Review" is a meaningful convergence point: "all children have plans ready for human review." It sits between "Ready for Plan" (index 3) and "In Progress" (index 6) in `STATE_ORDER`. The existing gates form a logical progression:

1. **Ready for Plan** (index 3) — all children have been researched
2. **Plan in Review** (index 5) — all children have implementation plans *(missing)*
3. **In Review** (index 7) — all children have implementations ready for review
4. **Done** (index 8) — all children are complete

Adding "Plan in Review" fills the gap in this progression.

## Recommended Approach

1-line addition to `PARENT_GATE_STATES` + 2 test updates. No logic changes needed.

## Risks

- **None**: Pure additive change. `isParentGateState` is a simple `includes()` check. Adding a value cannot break existing behavior — it only makes previously-false calls return true.

## Files Affected

### Will Modify
- `plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts` - Add `"Plan in Review"` to `PARENT_GATE_STATES` array
- `plugin/ralph-hero/mcp-server/src/__tests__/workflow-states.test.ts` - Update `toEqual` assertion to include "Plan in Review"; add `isParentGateState("Plan in Review")` true assertion

### Will Read (Dependencies)
- `plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts` - Consumer of `isParentGateState` in `advance_issue` (no changes needed)
