---
date: 2026-02-20
github_issue: 177
github_url: https://github.com/cdubiel08/ralph-hero/issues/177
status: complete
type: research
---

# GH-177: Actions: Parent Issue Auto-Advance When All Children Reach Done

## Problem Statement

When all child (sub-issue) issues of a parent issue reach the "Done" Workflow State, the parent issue should be automatically advanced to "Done" as well. This is the Actions-side complement to the existing `ralph_hero__advance_parent` MCP tool, enabling fully automated parent state propagation without requiring MCP server invocation.

## Current State Analysis

### Existing MCP Tool: `advance_parent` (`relationship-tools.ts:715-965`)

The `ralph_hero__advance_parent` tool already implements the full parent advancement logic:

1. Fetches child issue to find its `parent` (GraphQL `parent` field on Issue)
2. Fetches all siblings via `subIssues(first: 50)` on the parent
3. For each sibling, reads current Workflow State via `getCurrentFieldValue`
4. Computes the "minimum" state across all children using `stateIndex()`
5. Checks if minimum state is a **gate state** (`PARENT_GATE_STATES`: Ready for Plan, In Review, Done)
6. If all children are at or past a gate state AND parent is behind, advances the parent
7. Also syncs Status field via `syncStatusField()`

**Key insight**: The MCP tool handles ALL gate states (Ready for Plan, In Review, Done), not just Done. However, the Actions workflow (GH-177) only needs to handle the "all children Done" case, since that's the trigger from `issues: [closed]`.

### Existing Actions Workflows

**`sync-issue-state.yml` (GH-175)**: Fires on `issues: [closed, reopened]`. Sets Workflow State to Done (completed), Canceled (not_planned), or Backlog (reopened). Pure shell + `gh api graphql`. Uses `ROUTING_PAT` secret, `PROJECT_OWNER`/`PROJECT_NUMBER` vars.

**`sync-pr-merge.yml` (GH-176)**: Fires on `pull_request: [closed]` (merged). Advances In Progress -> In Review -> Done. Similar pure shell pattern.

Both workflows use the same pattern:
1. Resolve project ID and field options (user/org fallback)
2. Resolve issue node ID -> project item ID
3. Read current Workflow State via `fieldValueByName`
4. Conditionally update via `updateProjectV2ItemFieldValue` mutation

### Trigger Mechanism

**Best option: `workflow_run` after `sync-issue-state`**. When a child issue is closed, `sync-issue-state.yml` fires and sets the child's Workflow State to Done. The parent auto-advance workflow should trigger AFTER that completes, ensuring the child's project field is already updated before checking convergence.

```yaml
on:
  workflow_run:
    workflows: ["Sync Workflow State on Close/Reopen"]
    types: [completed]
  workflow_dispatch:
    inputs:
      issue_number:
        description: 'Child issue number to check parent advancement'
        required: true
        type: number
```

**Why `workflow_run` over `issues: [closed]` directly**:
- `issues: [closed]` fires before `sync-issue-state` updates the Workflow State field
- A race condition would exist: the parent advance check might read stale Workflow State values
- `workflow_run` guarantees `sync-issue-state` has completed its field update first

**Why NOT `workflow_dispatch` from within `sync-issue-state`**:
- Would require the sync workflow to know about parent advancement -- tight coupling
- `workflow_run` is the standard GitHub Actions pattern for workflow chaining

### Key GraphQL Queries Needed

**1. Get the closed issue's parent**:
```graphql
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      parent { number }
    }
  }
}
```

**2. Get parent's sub-issues**:
```graphql
query($owner: String!, $repo: String!, $parentNum: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $parentNum) {
      subIssues(first: 50) {
        nodes { number state }
      }
    }
  }
}
```

**3. Check Workflow State** (same pattern as existing workflows): `fieldValueByName(name: "Workflow State")`

### Convergence Logic

From `advance_parent`, the convergence check for the "Done" gate state:
- All children must have `state === "CLOSED"` (GitHub issue state) or Workflow State === "Done"
- Using GitHub's native `state` field is actually simpler for the "all Done" check, since closing an issue is what triggers the workflow in the first place
- However, we should also verify the Workflow State field is "Done" to handle edge cases where issues are closed as "not_planned" (which maps to Canceled, not Done)

**Recommended approach**: After `sync-issue-state` completes, check if all siblings have Workflow State "Done" in the project. This is the most reliable check since it uses the same field the MCP tools use.

### Edge Cases

1. **Partial completion**: Some children Done, some not -- skip (no advancement)
2. **Canceled children**: If any child is Canceled, parent should NOT auto-advance to Done (it's not truly complete)
3. **Recursive parents**: If advancing a parent to Done also completes a grandparent, the chain should continue. However, the `workflow_run` trigger on `sync-issue-state` handles this naturally -- when the parent is advanced to Done, it would need to be closed via GitHub issue state to trigger another round. This is a gap for v1 (documented).
4. **No parent**: Issue has no parent -- exit silently
5. **Parent already Done**: Idempotent -- skip
6. **Issue closed as not_planned**: `sync-issue-state` sets Workflow State to Canceled, not Done. Parent advance check sees "Canceled" and correctly does NOT advance parent.
7. **`workflow_run` context**: The `workflow_run` event provides the triggering workflow's conclusion but NOT the original issue number. The workflow must extract the issue number from the triggering run's context.

### Extracting Issue Number from `workflow_run`

The `workflow_run` event payload includes the triggering workflow run. We can use `gh run view` to get the original issue number. However, this is complex. A simpler approach:

**Alternative**: Use `issues: [closed]` trigger with a delay/retry, or parse the triggering workflow run logs. But this is fragile.

**Better alternative**: Use `workflow_dispatch` only, called by `sync-issue-state.yml` at the end of its run. This gives us the issue number directly. But this couples the workflows.

**Best alternative for v1**: Use `issues: [closed]` directly, but only check Workflow State fields (which are set by `sync-issue-state`). Add a small sleep or re-read to handle the race condition. Actually, we can simply query the `subIssuesSummary` field which uses GitHub's native `state` (CLOSED) count -- this is populated synchronously when the issue closes, no race.

**Recommended approach (v1)**: Trigger on `issues: [closed]` directly. Check if the closed issue has a parent. If yes, query all siblings and check if ALL have GitHub `state === "CLOSED"` AND `stateReason === "COMPLETED"`. This avoids the Workflow State race entirely since GitHub's issue state is set atomically when the close event fires.

## Implementation Approach

### Workflow: `.github/workflows/advance-parent.yml`

```yaml
name: Advance Parent on Child Completion

on:
  issues:
    types: [closed]
  workflow_dispatch:
    inputs:
      issue_number:
        description: 'Child issue number'
        required: true
        type: number
```

### Logic (pure shell, matching existing pattern)

1. **Check if closed as completed**: `state_reason == "completed"`. Exit if "not_planned".
2. **Fetch parent**: Query `issue.parent.number`. Exit if no parent.
3. **Fetch all siblings**: Query `issue(number: $parent).subIssues(first: 50)`. Get `number`, `state`, `stateReason`.
4. **Check convergence**: All siblings must have `state == "CLOSED"` and `stateReason == "COMPLETED"`.
5. **Resolve project field IDs**: Same pattern as `sync-issue-state.yml`.
6. **Read parent's current Workflow State**: If already "Done", exit (idempotent).
7. **Update parent to Done**: `updateProjectV2ItemFieldValue` mutation.
8. **(Optional) Close parent issue**: `gh issue close $PARENT_NUMBER --reason completed` to trigger cascading advancement.

### Closing the Parent Issue

Step 8 (closing the parent GitHub issue) is important for cascading: if a grandparent exists, closing the parent triggers `sync-issue-state` -> "Done", then this workflow fires again for the grandparent. This enables recursive hierarchy advancement.

However, auto-closing issues is a stronger action than just updating a project field. For v1, this should be configurable or opt-in.

**Recommendation**: Close the parent issue in v1. The `sync-issue-state.yml` workflow already handles the close event, and the concurrency group (`sync-issue-$NUMBER`) prevents races. This gives us free recursive advancement.

### File Changes

| File | Change | Effort |
|------|--------|--------|
| `.github/workflows/advance-parent.yml` | NEW - Workflow for parent auto-advance | Primary |

No JS script needed -- the logic is simple enough for pure shell + `gh api graphql`, matching the pattern of `sync-issue-state.yml` and `sync-pr-merge.yml`.

### Risks

1. **Recursive loop**: Parent close triggers `sync-issue-state` -> Done, which triggers `issues: [closed]`, which triggers this workflow for grandparent. This is desired behavior (cascading), but needs the concurrency group to prevent overlapping runs. Risk is LOW because each run targets a different issue number.

2. **Rate limiting**: Each parent advance requires ~5 GraphQL API calls (parent lookup, sibling query, project resolve, current state read, update). For deep hierarchies, this could chain. Acceptable for typical 2-3 level hierarchies.

3. **`subIssues(first: 50)` limit**: Parents with more than 50 children would miss some. Acceptable for typical usage.

4. **`gh issue close` requires `repo` scope**: The `ROUTING_PAT` already has `repo` scope (required by existing workflows).

## Recommended Approach

1. Create `.github/workflows/advance-parent.yml` using pure shell + `gh api graphql`
2. Trigger on `issues: [closed]` + `workflow_dispatch`
3. Check `state_reason == "completed"` (skip not_planned/duplicate)
4. Query parent, then all siblings
5. Check all siblings are CLOSED + COMPLETED
6. If converged, update parent's Workflow State to Done in the project
7. Close the parent issue with `--reason completed` to enable cascading
8. Add concurrency group on parent issue number to prevent parallel advancement
