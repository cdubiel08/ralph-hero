---
date: 2026-02-27
status: draft
github_issues: [452]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/452
primary_issue: 452
---

# Build Unified `save_issue` Tool — Atomic Implementation Plan

## Overview

1 issue for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-452 | Build unified `save_issue` tool | S |

## Current State Analysis

Five separate tools handle issue mutation:
- `update_issue` (`issue-tools.ts:969-1074`) — title, body, labels via `updateIssue` GraphQL mutation
- `update_workflow_state` (`issue-tools.ts:1079-1174`) — workflow state via `updateProjectV2ItemFieldValue` + status sync
- `update_estimate` (`issue-tools.ts:1179-1232`) — estimate via `updateProjectV2ItemFieldValue`
- `update_priority` (`issue-tools.ts:1237-1290`) — priority via `updateProjectV2ItemFieldValue`
- `clear_field` (`project-management-tools.ts:374-442`) — clears any project field

All project-field tools share the same 3-step pattern: `resolveFullConfig` → `ensureFieldCache` + `resolveProjectItemId` → `updateProjectItemField`. The `update_issue` tool uses `resolveConfig` (no project awareness) and calls the `updateIssue` GraphQL mutation directly.

**Critical gap**: Closing a GitHub issue requires a separate `gh api` call — `update_workflow_state` can set "Canceled" on the project field but can't close the Issue object itself. The `updateIssue` mutation already supports `state: OPEN | CLOSED` and `stateReason: COMPLETED | NOT_PLANNED | REOPENED` — we just need to expose it.

**Batch pattern**: `batch-tools.ts:86-126` builds aliased mutations that combine N field updates + status sync in one GraphQL call via `buildBatchMutationQuery`. We can reuse this for single-issue mutations with N field changes.

## Desired End State

A single `save_issue` tool that:
1. Accepts any combination of issue-object fields (title, body, labels, assignees, issueState) and project-field values (workflowState, estimate, priority)
2. Executes at most 2 GraphQL calls: one `updateIssue` mutation for issue-object fields, one aliased project mutation for all project fields + status sync
3. Auto-closes the GitHub issue when workflowState resolves to a terminal state (Done, Canceled) unless issueState is explicitly set
4. Supports semantic intents (__LOCK__, __COMPLETE__, etc.) via the existing `resolveState()` mechanism
5. Supports field clearing by setting values to `null`

### Verification
- [x] `save_issue` registered and discoverable via MCP
- [x] Issue-only, project-only, and combined updates all work in one call
- [x] Close/reopen via `issueState` parameter
- [x] Auto-close on terminal workflow state
- [x] Semantic intents resolve correctly
- [x] Field clearing via null
- [x] All existing tests pass
- [x] New unit tests cover all parameter combinations

## What We're NOT Doing

- Removing old tools (Phase 2, GH-453)
- Updating skills/agents/justfile to use `save_issue` (Phase 5, GH-456)
- Changing `create_issue`, `batch_update`, or any other tools

## Implementation Approach

Build `save_issue` as a new tool registration in `issue-tools.ts` that orchestrates both mutation paths. Reuse the aliased mutation pattern from `batch-tools.ts` via an extracted helper. The old tools remain untouched — they'll be removed in Phase 2.

---

## Phase 1: GH-452 — Build unified `save_issue` tool
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/452

### Changes Required

#### 1. Extract `buildSingleIssueMutation` helper
**File**: `plugin/ralph-hero/mcp-server/src/tools/batch-tools.ts`
**Changes**: Export `buildBatchMutationQuery` so it can be imported by `issue-tools.ts`. It's currently only used internally but its signature is already generic — it accepts an array of `{ alias, itemId, fieldId, optionId }` entries.

Alternatively, extract a thin wrapper in a new shared location:

**File**: `plugin/ralph-hero/mcp-server/src/lib/helpers.ts` (add to existing helpers)
**Changes**: Add a `buildProjectFieldMutation` function that wraps the aliased mutation pattern for a single issue with multiple field updates:

```typescript
export function buildProjectFieldMutation(
  projectId: string,
  updates: Array<{ alias: string; itemId: string; fieldId: string; optionId: string }>
): { mutationString: string; variables: Record<string, string> }
```

This can either import `buildBatchMutationQuery` from `batch-tools.ts` (if exported) or inline the same logic (it's ~40 lines). Prefer importing to avoid duplication.

#### 2. Add `save_issue` tool registration
**File**: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts`
**Changes**: Add new tool registration after the existing `get_issue` tool (~line 968, before `update_issue`):

**Parameter schema** (Zod):
```typescript
{
  owner: z.string().optional().describe("GitHub owner. Defaults to env var"),
  repo: z.string().optional().describe("Repository name. Defaults to env var"),
  projectNumber: z.coerce.number().optional().describe("Project number override"),
  number: z.coerce.number().describe("Issue number"),
  // Issue object fields (GitHub Issue API)
  title: z.string().optional().describe("New issue title"),
  body: z.string().optional().describe("New issue body (Markdown)"),
  labels: z.array(z.string()).optional().describe("Label names (replaces existing labels)"),
  assignees: z.array(z.string()).optional().describe("GitHub usernames to assign"),
  issueState: z.enum(["OPEN", "CLOSED", "CLOSED_NOT_PLANNED"]).optional()
    .describe("Close or reopen the issue"),
  // Project field values (ProjectV2Item API)
  workflowState: z.string().optional()
    .describe("Workflow state: semantic intent (__LOCK__, __COMPLETE__, etc.) or direct name"),
  estimate: z.enum(["XS", "S", "M", "L", "XL"]).nullable().optional()
    .describe("Estimate. Set to null to clear."),
  priority: z.enum(["P0", "P1", "P2", "P3"]).nullable().optional()
    .describe("Priority. Set to null to clear."),
  command: z.string().optional()
    .describe("Ralph command for semantic intent resolution. Required when workflowState is a semantic intent."),
}
```

**Handler implementation logic** (pseudocode):

```
async (args) => {
  // 1. Resolve config
  const { owner, repo } = resolveConfig(client, args);
  const hasIssueFields = args.title || args.body || args.labels || args.assignees || args.issueState;
  const hasProjectFields = args.workflowState !== undefined || args.estimate !== undefined || args.priority !== undefined;

  if (!hasIssueFields && !hasProjectFields) {
    return toolError("No fields to update. Provide at least one field.");
  }

  const changes: Record<string, unknown> = {};
  let resolvedWorkflowState: string | undefined;
  let previousWorkflowState: string | undefined;

  // 2. Resolve workflow state if provided (need this early for auto-close logic)
  if (args.workflowState) {
    const resolution = resolveState(args.workflowState, args.command);
    resolvedWorkflowState = resolution.resolvedState;
    // Get current state for the response
    previousWorkflowState = await getCurrentFieldValue(client, fieldCache, owner, repo, args.number, "Workflow State", projectNumber);
  }

  // 3. Issue-object mutations
  if (hasIssueFields) {
    const issueNodeId = await resolveIssueNodeId(client, owner, repo, args.number);

    // Determine issueState — explicit or auto-close
    let targetState: "OPEN" | "CLOSED" | undefined;
    let stateReason: "COMPLETED" | "NOT_PLANNED" | "REOPENED" | undefined;

    if (args.issueState === "CLOSED") {
      targetState = "CLOSED"; stateReason = "COMPLETED";
    } else if (args.issueState === "CLOSED_NOT_PLANNED") {
      targetState = "CLOSED"; stateReason = "NOT_PLANNED";
    } else if (args.issueState === "OPEN") {
      targetState = "OPEN"; stateReason = "REOPENED";
    }

    // Build and execute updateIssue mutation
    // Include: title, body, labelIds (resolved), assigneeIds (resolved), state, stateReason
    // Use existing label resolution pattern from update_issue (issue-tools.ts:1007-1028)
  }

  // 4. Auto-close logic (if workflowState is terminal AND issueState not explicitly set)
  if (!args.issueState && resolvedWorkflowState && TERMINAL_STATES.includes(resolvedWorkflowState)) {
    const issueNodeId = await resolveIssueNodeId(client, owner, repo, args.number);
    const stateReason = resolvedWorkflowState === "Canceled" ? "NOT_PLANNED" : "COMPLETED";
    // Execute close mutation
    changes.autoClose = true;
  }

  // 5. Project-field mutations (aliased batch for 1 issue)
  if (hasProjectFields) {
    const { projectNumber, projectOwner } = resolveFullConfig(client, args);
    await ensureFieldCache(client, fieldCache, projectOwner, projectNumber);
    const projectItemId = await resolveProjectItemId(client, fieldCache, owner, repo, args.number, projectNumber);

    const updates: Array<{ alias, itemId, fieldId, optionId }> = [];
    let opIdx = 0;

    // 5a. Workflow state
    if (resolvedWorkflowState) {
      const fieldId = fieldCache.getFieldId("Workflow State", projectNumber);
      const optionId = fieldCache.resolveOptionId("Workflow State", resolvedWorkflowState, projectNumber);
      updates.push({ alias: `ws_${opIdx}`, itemId: projectItemId, fieldId, optionId });
      opIdx++;

      // Status sync (inline, same as batch-tools.ts:464-483)
      const targetStatus = WORKFLOW_STATE_TO_STATUS[resolvedWorkflowState];
      if (targetStatus) {
        const statusFieldId = fieldCache.getFieldId("Status", projectNumber);
        const statusOptionId = statusFieldId ? fieldCache.resolveOptionId("Status", targetStatus, projectNumber) : undefined;
        if (statusFieldId && statusOptionId) {
          updates.push({ alias: `ss_${opIdx}`, itemId: projectItemId, fieldId: statusFieldId, optionId: statusOptionId });
          opIdx++;
        }
      }
      changes.workflowState = resolvedWorkflowState;
    }

    // 5b. Estimate (set or clear)
    if (args.estimate !== undefined) {
      if (args.estimate === null) {
        // Clear: use clearProjectV2ItemFieldValue mutation
        // (separate mutation, can't be aliased with updateProjectV2ItemFieldValue)
        changes.estimate = null;
      } else {
        const fieldId = fieldCache.getFieldId("Estimate", projectNumber);
        const optionId = fieldCache.resolveOptionId("Estimate", args.estimate, projectNumber);
        updates.push({ alias: `est_${opIdx}`, itemId: projectItemId, fieldId, optionId });
        opIdx++;
        changes.estimate = args.estimate;
      }
    }

    // 5c. Priority (set or clear)
    if (args.priority !== undefined) {
      if (args.priority === null) {
        // Clear: use clearProjectV2ItemFieldValue mutation
        changes.priority = null;
      } else {
        const fieldId = fieldCache.getFieldId("Priority", projectNumber);
        const optionId = fieldCache.resolveOptionId("Priority", args.priority, projectNumber);
        updates.push({ alias: `pri_${opIdx}`, itemId: projectItemId, fieldId, optionId });
        opIdx++;
        changes.priority = args.priority;
      }
    }

    // 5d. Execute single aliased mutation for all non-null field updates
    if (updates.length > 0) {
      const { mutationString, variables } = buildBatchMutationQuery(projectId, updates);
      await client.projectMutate(mutationString, variables);
    }

    // 5e. Execute clear mutations for null fields (separate calls, can't batch with sets)
    // clearProjectV2ItemFieldValue is a different mutation signature
  }

  // 6. Invalidate session cache
  client.cache.invalidateMutationCaches();

  // 7. Return unified result
  return toolSuccess({
    number: args.number,
    url: `https://github.com/${owner}/${repo}/issues/${args.number}`,
    changes,
    previousWorkflowState,
  });
}
```

#### 3. Handle field clearing via `clearProjectV2ItemFieldValue`
**File**: `plugin/ralph-hero/mcp-server/src/lib/helpers.ts`
**Changes**: Add a `clearProjectItemField` helper function that calls:

```graphql
mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!) {
  clearProjectV2ItemFieldValue(input: {
    projectId: $projectId,
    itemId: $itemId,
    fieldId: $fieldId
  }) {
    projectV2Item { id }
  }
}
```

This is the mutation used by the existing `clear_field` tool (`project-management-tools.ts:405-430`). Extract it into a reusable helper.

#### 4. Handle `updateIssue` with state/stateReason
**File**: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts`
**Changes**: Extend the `updateIssue` mutation in the `save_issue` handler to include `state` and `stateReason` parameters:

```graphql
mutation(
  $issueId: ID!,
  $title: String,
  $body: String,
  $labelIds: [ID!],
  $assigneeIds: [ID!],
  $state: IssueState,
  $stateReason: IssueClosedStateReason
) {
  updateIssue(input: {
    id: $issueId,
    title: $title,
    body: $body,
    labelIds: $labelIds,
    assigneeIds: $assigneeIds,
    state: $state,
    stateReason: $stateReason
  }) {
    issue { number title url state stateReason }
  }
}
```

Note: `IssueState` is an enum (`OPEN | CLOSED`), and `IssueClosedStateReason` is an enum (`COMPLETED | NOT_PLANNED | REOPENED`). The `updateIssue` mutation accepts these as top-level input fields.

#### 5. Export `buildBatchMutationQuery` from batch-tools.ts
**File**: `plugin/ralph-hero/mcp-server/src/tools/batch-tools.ts`
**Changes**: Add `export` to the `buildBatchMutationQuery` function at line 86 (if not already exported). This allows `save_issue` to import and reuse it for single-issue aliased mutations.

Check: if `buildBatchMutationQuery` is already exported, no change needed. If not, add `export` keyword.

#### 6. Add unit tests
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/save-issue.test.ts` (new file)
**Changes**: Create comprehensive tests following existing patterns:

**Schema validation tests** (Zod safeParse):
- Accept `number` only (at least one field required → should fail)
- Accept `number` + `title` (issue-only update)
- Accept `number` + `workflowState` + `command` (project-only update)
- Accept `number` + `title` + `workflowState` + `estimate` (combined update)
- Accept `number` + `issueState` (close/reopen)
- Accept `number` + `estimate: null` (field clearing)
- Reject invalid `issueState` values
- Reject invalid `estimate` values
- Coerce `number` from string to number
- Coerce `projectNumber` from string to number

**Auto-close logic tests** (pure function):
- `workflowState: "Canceled"` + no `issueState` → auto-close with NOT_PLANNED
- `workflowState: "Done"` + no `issueState` → auto-close with COMPLETED
- `workflowState: "In Progress"` → no auto-close
- `workflowState: "Done"` + `issueState: "OPEN"` → no auto-close (explicit override)

**Semantic intent tests** (integration with resolveState):
- `workflowState: "__LOCK__"` + `command: "ralph_plan"` → resolves to "Plan in Progress"
- `workflowState: "__COMPLETE__"` + `command: "ralph_research"` → resolves to "Ready for Plan"
- `workflowState: "__CANCEL__"` + `command: "ralph_triage"` → resolves to "Canceled" + triggers auto-close

**Structural tests** (source code verification, following issue-tools.test.ts pattern):
- `save_issue` tool is registered (source contains `ralph_hero__save_issue`)
- Handler calls `resolveState` when `workflowState` is provided
- Handler calls `resolveFullConfig` for project field paths
- Handler calls `resolveIssueNodeId` for issue-object mutations
- Status sync is included in the aliased mutation (not a separate call)

### Success Criteria

#### Automated Verification:
- [x] `npm run build` passes in `plugin/ralph-hero/mcp-server/`
- [x] `npm test` passes in `plugin/ralph-hero/mcp-server/`
- [x] New test file `save-issue.test.ts` exists with schema, auto-close, semantic intent, and structural tests
- [x] `buildBatchMutationQuery` is exported from `batch-tools.ts`
- [x] `save_issue` tool description mentions all key capabilities (fields, workflow state, close/reopen, null clearing)

#### Manual Verification:
- [ ] `save_issue(number: N, workflowState: "Canceled")` closes the issue AND updates the project field
- [ ] `save_issue(number: N, title: "New title", workflowState: "In Progress", estimate: "S")` updates everything in one call
- [ ] `save_issue(number: N, estimate: null)` clears the estimate field
- [ ] `save_issue(number: N, issueState: "CLOSED_NOT_PLANNED")` closes with NOT_PLANNED reason

**Implementation Note**: After completing this phase and all automated verification passes, pause for manual confirmation before proceeding to Phase 2 (GH-453).

---

## Testing Strategy

### Unit Tests (save-issue.test.ts):
- Schema validation via `safeParse()` (8+ cases)
- Auto-close logic as pure function tests (4 cases)
- Semantic intent resolution integration (3 cases)
- Structural verification via source code reading (5 cases)

### Integration Tests (manual):
- Create test issue → `save_issue` with multiple fields → `get_issue` to verify
- `save_issue` with `issueState=CLOSED` → verify issue closed
- `save_issue` with terminal `workflowState` → verify auto-close
- `save_issue` with `estimate: null` → verify field cleared

## Key Implementation Notes

1. **Two mutation paths**: Issue-object fields use `client.mutate()` (repo-scoped token), project fields use `client.projectMutate()` (project-scoped token). The dual-token split in `github-client.ts:88-97` means we must use the correct client method for each path.

2. **Aliased mutation for project fields**: Reuse `buildBatchMutationQuery` from `batch-tools.ts` to combine workflow state + status sync + estimate + priority in one `projectMutate` call. This avoids the single-issue `syncStatusField` helper which requires a second API call.

3. **Clear vs set**: `clearProjectV2ItemFieldValue` is a different GraphQL mutation than `updateProjectV2ItemFieldValue`. Null fields require separate clear mutations — they can't be batched with set operations in the same aliased mutation.

4. **Auto-close order**: Auto-close should happen AFTER the project field mutation (so the workflow state is set before the issue is closed). This ensures the project board reflects the correct state.

5. **Label resolution**: Reuse the existing pattern from `update_issue` (issue-tools.ts:1007-1028) that fetches repo labels and resolves names to IDs.

6. **Cache invalidation**: Call `client.cache.invalidateMutationCaches()` once at the end (not after each mutation), matching the pattern in existing tools.

## References

- Parent issue: https://github.com/cdubiel08/ralph-hero/issues/451
- Parent plan: `thoughts/shared/plans/2026-02-27-mcp-toolspace-consolidation.md`
- Existing mutation tools: `issue-tools.ts:969-1290`
- Batch mutation builder: `batch-tools.ts:86-126`
- Status sync: `helpers.ts:569-597`, `workflow-states.ts:117-129`
- State resolution: `state-resolution.ts:75-92`
- Field cache: `cache.ts:110-233`
- Config resolution: `helpers.ts:471-531`
- Clear field mutation: `project-management-tools.ts:405-430`
