---
date: 2026-02-18
github_issue: 61
github_url: https://github.com/cdubiel08/ralph-hero/issues/61
status: complete
type: research
---

# Research: Epic GH-40 Stays at Back of Swimlane Despite Children Advancing

## Problem Statement

Parent epic issues stay in earlier workflow states (and thus earlier board columns) even when all their child sub-issues have advanced. The specific example is issue #40 ("Consolidate agents into scope-bounded workers"), which reportedly stayed at the back of the swimlane despite all 8 children progressing through the pipeline.

## Current State Analysis

### Issue #40 Status (Now Resolved)

Issue #40 is now CLOSED with workflow state "Done" and all 8 sub-issues completed (100%). The immediate problem has been resolved for this specific epic, likely through manual intervention or the recent #78 PR merge workflow. However, the **systemic gap** that caused the problem remains.

### advance_children Tool (Downward-Only Propagation)

The [`advance_children` tool](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts#L515-L703) pushes child issues forward to match a parent's state. Key characteristics:

- **Direction**: Parent -> children (downward only)
- **Logic**: Fetches all sub-issues, checks their current workflow state via `getCurrentFieldValue`, advances any child that is in an earlier state than `targetState` ([relationship-tools.ts:650](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts#L650))
- **Called by**: Team lead after PR creation ([SKILL.md:157](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-team/SKILL.md#L157)) and integrator after merge ([ralph-integrator.md:23](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/agents/ralph-integrator.md#L23))

### Missing: Upward Propagation (advance_parent)

**There is no mechanism in the codebase to advance a parent's workflow state when all children reach a milestone.** Searching the entire MCP server source for parent advancement, propagation, or bubble-up logic yields zero results.

The gap occurs because:

1. Children advance through the pipeline independently (Research -> Plan -> Implement -> In Review -> Done)
2. Each child state transition uses `update_workflow_state` which only affects the child issue
3. No tool or automation checks "are all siblings at state X? If so, advance parent to state X"
4. `advance_children` is called explicitly by the orchestrator but only in the downward direction

### How GitHub Projects V2 Board Position Works

GitHub Projects V2 boards use the `Workflow State` single-select field to determine column placement. If a parent epic's `Workflow State` is "Backlog" while all children are "Done", the epic literally appears in the "Backlog" column. This is the "back of swimlane" behavior reported in the bug.

### Where Parent Advancement Should Happen

The natural trigger points for parent advancement are:

1. **When the last child in a group reaches a gate state** (all at "Ready for Plan", all at "In Review", all "Done")
2. **When `update_workflow_state` is called on any child** -- check if all siblings are now at the same or later state, and if so, advance the parent
3. **In the integrator's merge flow** -- after marking children as "Done", check if the parent should also be "Done"

### Workflow State Ordering

From [`workflow-states.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts#L12-L22):

```
Backlog -> Research Needed -> Research in Progress -> Ready for Plan ->
Plan in Progress -> Plan in Review -> In Progress -> In Review -> Done
```

The `isEarlierState()` and `compareStates()` helpers already exist and can be reused for parent advancement logic.

## Potential Approaches

### Approach A: New `advance_parent` MCP Tool (Recommended)

Create a new tool `ralph_hero__advance_parent` that:
1. Takes a child issue number
2. Looks up the child's parent
3. Fetches all sibling sub-issues and their workflow states
4. If ALL siblings are at or past a target state, advances the parent to that state
5. Returns what changed

**Calling convention**: Called by the orchestrator/integrator at the same points where `advance_children` is called, but in reverse. Could also be called automatically by `update_workflow_state` as a side effect.

**Pros:**
- Explicit, testable, debuggable
- Follows existing tool patterns
- Can be called selectively (not every state change needs parent advancement)
- No risk of infinite loops (parent advancement doesn't re-trigger child advancement)

**Cons:**
- Requires callers to remember to invoke it (same problem as `advance_children`)
- Manual orchestration burden

### Approach B: Automatic Parent Advancement in `update_workflow_state`

Add parent-check logic directly into the `update_workflow_state` tool. After updating a child's state:
1. Check if the issue has a parent
2. Fetch all siblings
3. If all siblings are at or past the new state, advance the parent

**Pros:**
- Zero burden on callers -- always happens automatically
- Handles all edge cases (any tool or human changing state triggers it)

**Cons:**
- Extra API calls on every state transition (check parent, fetch siblings)
- Risk of unexpected side effects (parent state changes when you only meant to change a child)
- More complex error handling (partial failure: child updated but parent advancement fails)
- Could create confusion if parent advancement triggers `advance_children` in the same call

### Approach C: Periodic Sync / Board Refresh

Add a `ralph_hero__sync_epic_states` tool that scans all open epics and advances parents based on child state convergence. Run periodically or on-demand.

**Pros:**
- Batch operation, no per-transition overhead
- Catches any drift regardless of how state changes happened
- Could be run as a scheduled GitHub Action

**Cons:**
- Not real-time -- board may be stale between runs
- Doesn't solve the root cause (just patches the symptom)
- Extra API calls for full project scan

## Risks and Considerations

1. **Gate states for parent advancement**: Not every child state transition should advance the parent. Reasonable gates are:
   - All children at "Ready for Plan" -> parent to "Ready for Plan"
   - All children at "In Review" -> parent to "In Review"
   - All children at "Done" -> parent to "Done"
   - Intermediate states (Research in Progress, Plan in Progress, In Progress) should NOT advance the parent

2. **Partial completion**: If 7 of 8 children are "Done" and 1 is "In Progress", the parent should NOT advance to "Done". The logic must require ALL children to meet the threshold.

3. **Mixed groups vs pure epics**: The `advance_parent` logic should only apply to parent/child relationships (sub-issues), not to dependency relationships (blocking/blocked-by).

4. **Existing `advance_children` interaction**: If `advance_parent` moves a parent forward, should it also call `advance_children` on the parent? No -- this would create confusion. The two operations should be independent.

5. **Closed vs Done**: GitHub issue `state: CLOSED` is separate from workflow state "Done". The parent should check workflow state, not issue close state.

## Recommended Next Steps

1. Implement **Approach A** (new `advance_parent` tool) in `relationship-tools.ts`
2. Define gate states: advance parent only when ALL children reach "Ready for Plan", "In Review", or "Done"
3. Update the integrator agent to call `advance_parent` after updating child states
4. Update the team-lead SKILL.md to call `advance_parent` at convergence gates
5. Add tests for the new tool in the existing test suite
