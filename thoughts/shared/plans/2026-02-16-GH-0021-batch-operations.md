---
date: 2026-02-16
status: draft
github_issue: 21
github_url: https://github.com/cdubiel08/ralph-hero/issues/21
---

# Batch Operations for Bulk State Transitions, Estimation, and Labeling

## Overview

Add a `ralph_hero__batch_update` MCP tool for bulk-updating project fields (workflow state, estimate, priority) across multiple issues in a single tool call. Extend the existing `advance_children` tool to accept arbitrary issue sets. Extract duplicated helper functions from `issue-tools.ts` and `relationship-tools.ts` into shared modules to eliminate code duplication and enable clean batch tool implementation.

## Current State Analysis

### The Problem

All MCP server mutation operations are single-issue. Processing backlogs requires N tool calls for N issues:
- Each `update_workflow_state` call: 3 API calls minimum (resolve issue node ID + resolve project item ID + mutation)
- 10 issues × 2 field updates = 60 API calls (~60 rate limit points)

### Existing Batch Pattern: `advance_children`

[relationship-tools.ts:560-749](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts#L560-L749) implements the batch pattern:
- Fetches all sub-issues in one query
- Loops sequentially, checking `isEarlierState()` before advancing
- Tracks results in `advanced[]`, `skipped[]`, `errors[]` arrays
- Per-item try/catch for partial failure handling

**Limitation**: Only advances sub-issues of a parent, not arbitrary issue sets.

### Duplicated Helpers

6 helper functions are duplicated between `issue-tools.ts` and `relationship-tools.ts`:

| Helper | `issue-tools.ts` | `relationship-tools.ts` |
|--------|-------------------|------------------------|
| `ensureFieldCache()` | [Lines 31-53](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L31-L53) | `ensureFieldCacheForRelationships` [Line 756](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts#L756) |
| `resolveIssueNodeId()` | [Lines 117-145](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L117-L145) | [Lines 27-52](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts#L27-L52) |
| `resolveProjectItemId()` | [Lines 151-214](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L151-L214) | `resolveProjectItemIdForRelationships` [Line 829](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts#L829) |
| `updateProjectItemField()` | [Lines 220-259](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L220-L259) | `updateProjectItemFieldForRelationships` [Line 945](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts#L945) |
| `getCurrentFieldValue()` | [Lines 265-316](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L265-L316) | `getCurrentFieldValueForRelationships` [Line 893](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts#L893) |
| `resolveConfig()` | [Lines 329-344](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L329-L344) | [Lines 61-76](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts#L61-L76) |

### GraphQL Optimization Opportunity

GitHub GraphQL supports aliased mutations — N field updates can be batched into 1 API call:
```graphql
mutation {
  u1: updateProjectV2ItemFieldValue(input: { ... item1 ... }) { projectV2Item { id } }
  u2: updateProjectV2ItemFieldValue(input: { ... item2 ... }) { projectV2Item { id } }
}
```

Similarly, node ID resolution can be batched via aliased queries. For 10 issues × 2 fields: ~22 points vs ~60 points (63% savings).

## Desired End State

1. `ralph_hero__batch_update` tool updates workflow state, estimate, and/or priority across multiple issues in a single call
2. `advance_children` accepts optional `issues` array for arbitrary issue sets (backward-compatible)
3. All duplicated helpers extracted to `lib/helpers.ts` — single source of truth
4. Batch operations use aliased GraphQL mutations for efficiency
5. Cache invalidation happens once per batch, not per-item

### Verification
- [ ] `npm run build` compiles with no type errors
- [ ] `npm test` passes with new batch tests
- [ ] `batch_update` with 5 issues and 2 fields completes in ~2 API calls (resolve + mutate)
- [ ] `advance_children` works with both `number` (parent) and `issues` (arbitrary list) parameters
- [ ] No duplicated helper functions between `issue-tools.ts` and `relationship-tools.ts`
- [ ] Partial failures report per-issue status without aborting the batch

## What We're NOT Doing

- Not implementing `batch_triage` (per-issue differentiated actions — can use multiple `batch_update` calls)
- Not adding label/assignee batch updates (those use `updateIssue` mutation, not project field updates — different pattern)
- Not adding rollback semantics (field updates are idempotent; partial results are acceptable)
- Not adding pre-execution confirmation prompts (tool callers decide what to batch)
- Not changing the rate limiter to predict batch costs upfront (reactive tracking is sufficient)

## Implementation Approach

Extract shared helpers first (prerequisite for clean batch tool code), then implement `batch_update` with aliased GraphQL, then extend `advance_children`. Tests throughout.

**Note on #19 interaction**: If #19 (handoff_ticket) lands first, `batch_update` for workflow state changes should validate transitions via `StateMachine`. The plan accounts for this by keeping state validation modular. If #19 has not landed, `batch_update` uses direct state names without transition validation (matching current `update_workflow_state` behavior).

---

## Phase 1: Extract Shared Helpers

### Overview

Extract the 6 duplicated helper functions into shared modules. This eliminates code duplication and makes helpers importable by the new batch tools module.

### Changes Required

#### 1. Create shared helpers module

**File**: `plugin/ralph-hero/mcp-server/src/lib/helpers.ts` (NEW)

Move these functions from `issue-tools.ts` into this new module (keeping exact same implementations):

- `ensureFieldCache(client, fieldCache, owner, projectNumber)` — from issue-tools.ts lines 31-53 + the `fetchProjectForCache` function it depends on (lines 67-111)
- `resolveProjectItemId(client, fieldCache, owner, repo, issueNumber)` — from issue-tools.ts lines 151-214
- `updateProjectItemField(client, fieldCache, projectItemId, fieldName, optionName)` — from issue-tools.ts lines 220-259
- `getCurrentFieldValue(client, fieldCache, owner, repo, issueNumber, fieldName)` — from issue-tools.ts lines 265-316
- `resolveConfig(client, args)` — from issue-tools.ts lines 329-344
- `resolveFullConfig(client, args)` — from issue-tools.ts lines 346-364 (including the `ResolvedConfig` interface)

Also move the `ProjectCacheResponse` interface (lines 55-65) and `fetchProjectForCache` function (lines 67-111) since `ensureFieldCache` depends on them.

**Note**: `resolveIssueNodeId` is planned to move to `lib/resolve.ts` in issue #19. If #19 lands first, import from there. If not, include it in `helpers.ts` and coordinate with #19's PR.

All functions keep identical signatures and implementations — this is a pure extraction.

#### 2. Update issue-tools.ts imports

**File**: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts`

- Remove the local definitions of all 6 functions plus `ProjectCacheResponse` and `fetchProjectForCache`
- Add import:
  ```typescript
  import {
    ensureFieldCache,
    resolveIssueNodeId,
    resolveProjectItemId,
    updateProjectItemField,
    getCurrentFieldValue,
    resolveConfig,
    resolveFullConfig,
  } from "../lib/helpers.js";
  ```
- The `getIssueFieldValues` function (lines 1945-2014) stays in `issue-tools.ts` since it's only used locally

#### 3. Update relationship-tools.ts imports

**File**: `plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts`

- Remove all `*ForRelationships` duplicate functions (lines 756-984)
- Remove the local `resolveIssueNodeId` (lines 27-52) and `resolveConfig` (lines 61-76)
- Add import:
  ```typescript
  import {
    ensureFieldCache,
    resolveIssueNodeId,
    resolveProjectItemId,
    updateProjectItemField,
    getCurrentFieldValue,
    resolveConfig,
    resolveFullConfig,
  } from "../lib/helpers.js";
  ```
- Update all call sites from `*ForRelationships` to the shared function names (e.g., `ensureFieldCacheForRelationships(...)` → `ensureFieldCache(...)`)

### Success Criteria

#### Automated Verification
- [x] `npm run build` compiles with no type errors
- [x] `npm test` passes (all existing tests unaffected)
- [x] `grep -r "ForRelationships" plugin/ralph-hero/mcp-server/src/` returns zero matches

#### Manual Verification
- [x] All existing tools behave identically after extraction

**Dependencies created for Phase 2**: Shared helpers available for batch tools import

---

## Phase 2: Implement `batch_update` Tool

### Overview

Create the `ralph_hero__batch_update` tool in a new `tools/batch-tools.ts` module. Uses aliased GraphQL queries and mutations for efficient batch processing.

### Changes Required

#### 1. Create batch tools module

**File**: `plugin/ralph-hero/mcp-server/src/tools/batch-tools.ts` (NEW)

**`ralph_hero__batch_update` tool**:

**Parameters** (zod schema):
- `owner` (optional string) — GitHub owner, defaults to env
- `repo` (optional string) — repo name, defaults to env
- `issues` (array of numbers, required, min 1, max 50) — issue numbers to update
- `operations` (array, required, min 1, max 3) — each with:
  - `field` (enum: `"workflow_state" | "estimate" | "priority"`) — which field to update
  - `value` (string) — target value (e.g., "Research Needed", "XS", "P1")
- `skipIfAtOrPast` (optional boolean, default false) — for workflow_state operations, skip issues already at or past the target state (uses `isEarlierState()`)

**Logic flow**:

1. **Validate inputs**:
   - Each operation's field name is valid
   - Each operation's value is valid (valid state name for workflow_state, valid estimate/priority)
   - Issue list is not empty, not over 50

2. **Batch resolve node IDs**: Build a single aliased GraphQL query:
   ```graphql
   query {
     i0: repository(owner: "x", name: "y") { issue(number: 1) { id projectItems(first: 5) { nodes { id project { id } } } } }
     i1: repository(owner: "x", name: "y") { issue(number: 2) { id projectItems(first: 5) { nodes { id project { id } } } } }
   }
   ```
   Parse results to build a map: `issueNumber → { nodeId, projectItemId }`. Issues not found → add to `errors[]`.

3. **Pre-filter with skipIfAtOrPast**: If `skipIfAtOrPast` is true and any operation targets workflow_state, fetch current states via a batch aliased query on project item field values. Skip issues already at or past the target. Add to `skipped[]`.

4. **Build aliased mutation**: For each issue × operation combination, create one alias:
   ```graphql
   mutation {
     u0_0: updateProjectV2ItemFieldValue(input: { projectId: "...", itemId: "item0", fieldId: "wsField", value: { singleSelectOptionId: "optId" } }) { projectV2Item { id } }
     u0_1: updateProjectV2ItemFieldValue(input: { projectId: "...", itemId: "item0", fieldId: "estField", value: { singleSelectOptionId: "optId" } }) { projectV2Item { id } }
     u1_0: updateProjectV2ItemFieldValue(input: { ... item1 ... }) { projectV2Item { id } }
   }
   ```

5. **Execute mutation**: Use `client.projectMutate()` for the combined mutation. Parse per-alias results. Aliases that succeed → `succeeded[]`. Aliases that fail → `errors[]`.

   **Chunking**: If total aliases > 50, chunk into multiple mutations (safety margin for GitHub complexity limits).

6. **Cache management**: The single `projectMutate()` call triggers one cache invalidation automatically — no special handling needed.

7. **Return results**:
   ```typescript
   {
     succeeded: [{ number: 1, updates: { workflow_state: "Research Needed", estimate: "XS" } }],
     skipped: [{ number: 3, reason: "Already at or past target state" }],
     errors: [{ number: 5, error: "Issue not found in project" }],
     summary: { total: 5, succeeded: 3, skipped: 1, errors: 1 }
   }
   ```

#### 2. Register batch tools in server

**File**: `plugin/ralph-hero/mcp-server/src/index.ts`

- Add import: `import { registerBatchTools } from "./tools/batch-tools.js";`
- Add registration after relationship tools (line 294):
  ```typescript
  // Phase 5: Batch operations
  registerBatchTools(server, client, fieldCache);
  ```

### Success Criteria

#### Automated Verification
- [x] `npm run build` compiles with no type errors
- [x] `npm test` passes with new batch_update tests
- [x] `batch_update` with 5 issues × 1 field uses 2 API calls (1 resolve query + 1 mutation)
- [x] `batch_update` with invalid field value returns validation error before any API calls
- [x] Partial failures report per-issue status

#### Manual Verification
- [ ] Batch update 3 issues to "Research Needed" — all update, audit visible on project board
- [ ] Batch update with one non-existent issue — others succeed, error reported for missing one
- [ ] `skipIfAtOrPast: true` correctly skips issues already at target state

**Depends on**: Phase 1 (shared helpers)

---

## Phase 3: Extend `advance_children` with Arbitrary Issue Sets

### Overview

Add an optional `issues` parameter to `advance_children` that accepts an arbitrary array of issue numbers instead of requiring a parent issue. This makes the existing batch-advancing pattern reusable for group operations beyond parent-child relationships. Backward-compatible — existing callers using `number` (parent) are unaffected.

### Changes Required

#### 1. Update advance_children tool schema

**File**: `plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts`

Update the tool's zod schema to accept either `number` (parent) or `issues` (arbitrary list):

```typescript
{
  owner: z.string().optional().describe("GitHub owner"),
  repo: z.string().optional().describe("Repository name"),
  number: z.number().optional().describe("Parent issue number (resolves sub-issues automatically)"),
  issues: z.array(z.number()).optional().describe("Explicit list of issue numbers to advance (alternative to parent number)"),
  targetState: z.string().describe("State to advance issues to"),
}
```

Add input validation: at least one of `number` or `issues` must be provided. If both, `issues` takes precedence.

#### 2. Update advance_children logic

When `issues` is provided:
- Skip the sub-issue fetch query (lines 617-645)
- Build the issue list from the `issues` parameter directly
- Proceed with the same sequential advance loop (lines 675-737)

When only `number` is provided:
- Existing behavior unchanged — fetch sub-issues of parent

#### 3. Update tool description

Update the description to mention the new `issues` parameter:
```
"Advance issues to a target workflow state. Provide either 'number' (parent issue, advances sub-issues) or 'issues' (explicit list of issue numbers). Only advances issues in earlier workflow states. Returns what changed, what was skipped, and any errors."
```

#### 4. Update error message references

Line 734 currently references `update_workflow_state` in the recovery suggestion:
```
`Recovery: retry advance_children or update this child manually via update_workflow_state.`
```

Update to:
```
`Recovery: retry advance_children or update this issue manually.`
```

(Remove tool name reference since #19 may rename it.)

### Success Criteria

#### Automated Verification
- [x] `npm run build` compiles with no type errors
- [x] `npm test` passes
- [ ] `advance_children` with `number: 5` behaves identically to current (backward compat)
- [ ] `advance_children` with `issues: [10, 11, 12]` advances those specific issues

#### Manual Verification
- [ ] Calling with both `number` and `issues` uses `issues` and ignores parent
- [ ] Calling with neither returns validation error

**Depends on**: Phase 1 (shared helpers — `advance_children` uses shared functions after extraction)

---

## Phase 4: Tests

### Overview

Add unit tests for the `batch_update` tool and the `advance_children` extension. Test aliased query/mutation generation, partial failure handling, and the `skipIfAtOrPast` optimization.

### Changes Required

#### 1. Batch tools tests

**File**: `plugin/ralph-hero/mcp-server/src/__tests__/batch-tools.test.ts` (NEW)

Test suites:

**Input validation**:
- Rejects empty `issues` array
- Rejects `issues` array > 50
- Rejects empty `operations` array
- Rejects invalid field names (e.g., `"foo"`)
- Rejects invalid workflow state values
- Rejects invalid estimate values
- Rejects invalid priority values

**Aliased query generation** (unit test internal helper):
- Generates correct aliases for N issues (`i0`, `i1`, ..., `iN`)
- Each alias resolves issue ID + project item IDs

**Aliased mutation generation** (unit test internal helper):
- Generates correct aliases for N issues × M operations (`u0_0`, `u0_1`, ..., `uN_M`)
- Uses correct field IDs from field cache
- Uses correct option IDs from field cache

**Batch execution** (mock GraphQL client):
- Happy path: 3 issues × 1 field → all succeed
- Happy path: 3 issues × 2 fields → all succeed
- Partial failure: 1 of 3 issues not found → 2 succeed, 1 error
- `skipIfAtOrPast`: issues at or past target → skipped with reason
- `skipIfAtOrPast`: issues before target → advanced
- Chunking: 60 issues → split into 2 mutations of 30

**Result format**:
- `succeeded` array has correct `number` and `updates` map
- `skipped` array has correct `number` and `reason`
- `errors` array has correct `number` and `error` message
- `summary` counts match array lengths

#### 2. Advance children extension tests

**File**: `plugin/ralph-hero/mcp-server/src/__tests__/advance-children.test.ts` (NEW)

Tests:
- With `number` only: fetches sub-issues from parent (existing behavior)
- With `issues` only: uses provided list directly
- With both `number` and `issues`: uses `issues`, ignores parent
- With neither: returns validation error
- Empty `issues` array: returns empty results
- Issues already at target: skipped with correct reason
- Issues past target: skipped with correct reason
- Issues before target: advanced

### Success Criteria

#### Automated Verification
- [ ] `npm test` passes all new tests
- [ ] All batch_update error paths tested
- [ ] advance_children backward compatibility verified

#### Manual Verification
- [ ] Test output clean with descriptive names

**Depends on**: Phase 2 (batch tool), Phase 3 (advance_children extension)

---

## Testing Strategy

### Unit Tests (Phase 4)
- Aliased GraphQL query/mutation generation (deterministic string building)
- Input validation for all field types
- Result aggregation (succeeded/skipped/errors)

### Integration Tests (Mock)
- Mock `GitHubClient` to verify correct GraphQL strings sent
- Verify cache invalidation happens once per batch
- Verify node ID caching works across batches

### Manual Testing
1. Build: `cd plugin/ralph-hero/mcp-server && npm run build`
2. `batch_update` 3 test issues to "Research Needed" — verify all update on project board
3. `batch_update` with one invalid issue — verify partial success
4. `advance_children` with `issues: [N, N+1]` — verify arbitrary advancement
5. Monitor rate limit cost: batch of 10 should be ~22 points vs ~60 sequential

## File Ownership Summary

| Phase | Key Files (NEW) | Key Files (MODIFIED) | Key Files (DELETED) |
|-------|-----------------|---------------------|---------------------|
| 1 | `lib/helpers.ts` | `tools/issue-tools.ts`, `tools/relationship-tools.ts` | — |
| 2 | `tools/batch-tools.ts` | `index.ts` | — |
| 3 | — | `tools/relationship-tools.ts` | — |
| 4 | `__tests__/batch-tools.test.ts`, `__tests__/advance-children.test.ts` | — | — |

## References

- [Issue #21](https://github.com/cdubiel08/ralph-hero/issues/21) — Batch operations
- [Research document](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-16-GH-0021-batch-operations.md)
- [advance_children implementation](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts#L560-L749)
- [issue-tools.ts helpers](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L31-L364)
- [Issue #19](https://github.com/cdubiel08/ralph-hero/issues/19) — Related: handoff_ticket may affect batch state validation
