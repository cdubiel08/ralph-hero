---
date: 2026-03-03
status: draft
github_issues: [519, 520, 521, 522]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/519
  - https://github.com/cdubiel08/ralph-hero/issues/520
  - https://github.com/cdubiel08/ralph-hero/issues/521
  - https://github.com/cdubiel08/ralph-hero/issues/522
primary_issue: 519
---

# Parent State Advancement & Dashboard False Positive Fix — Implementation Plan

## Overview

Fix two related gaps in how parent/umbrella issues are handled:
1. The dashboard's `oversized_in_pipeline` warning fires on already-split parent issues (false positive)
2. Parent issues never advance through the pipeline as their children progress (except at merge)

## Current State Analysis

**Dashboard false positive**: `detectHealthIssues()` in [`dashboard.ts:388-402`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/dashboard.ts#L388-L402) flags any M/L/XL issue not in Backlog/terminal as "should be split". It does not check if the issue already has sub-issues. Meanwhile, [`pipeline-detection.ts:146`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts#L146) already solves this with a `subIssueCount === 0` guard — but the dashboard has no access to sub-issue data.

**Parent advancement gap**: `PARENT_GATE_STATES` in [`workflow-states.ts:50-54`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts#L50-L54) is `["Ready for Plan", "In Review", "Done"]`. `Plan in Review` (index 5) is absent, so parents cannot advance to it even when all children reach that state.

**No auto-advancement**: `save_issue` ([`issue-tools.ts:1102-1437`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L1102-L1437)) and `batch_update` do not check or advance parent issues. Only `ralph-merge` calls `advance_issue(direction="parent")`. Skills like `research`, `plan`, `review`, and `impl` silently leave the parent behind.

**Observed symptom**: Issue #367 has 5 sub-issues all in "Plan in Review", but the parent is stuck in "Ready for Plan". The dashboard flags it as "M estimate should be split" even though it was already split.

### Key Discoveries:
- [`DashboardItem`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/dashboard.ts#L30-L43) and [`DASHBOARD_ITEMS_QUERY`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts#L197-L241) have no sub-issue data
- [`PhaseSnapshot`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/dashboard.ts#L46-L60) issue shape has no `subIssueCount` field
- `advance_issue(direction="parent")` makes N+5 API calls for N siblings (sequential `getCurrentFieldValue` per sibling)
- [`buildBatchResolveQuery`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/batch-tools.ts#L46-L80) and [`buildBatchFieldValueQuery`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/batch-tools.ts#L132-L162) already exist and can collapse N sequential queries into 1 each
- `resolveIssueNodeId` ([`helpers.ts:127-155`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/helpers.ts#L127-L155)) fetches only `{ id }` — does not include `parent`
- `save_issue` already has `resolvedWorkflowState` available at line 1145 and `projectItemId` resolved at line 1328

## Desired End State

1. Dashboard no longer flags parent/umbrella issues that have sub-issues as "oversized"
2. `Plan in Review` is a recognized gate state for parent advancement
3. When `save_issue` moves a sub-issue to a gate state, the parent is automatically advanced if all siblings are at that gate — with constant-time API cost (4-5 calls max, not N+5)

### Verification
- [ ] Dashboard `oversized_in_pipeline` warning does not fire for issues with `subIssueCount > 0`
- [ ] `isParentGateState("Plan in Review")` returns `true`
- [ ] `save_issue` moving last sibling to a gate state advances the parent
- [ ] `save_issue` moving a sibling to a non-gate state adds zero additional API calls
- [ ] All existing tests pass; new tests cover the added behaviors

## What We're NOT Doing

- Not changing `advance_issue` tool itself — it retains its current behavior as an explicit manual tool
- Not auto-advancing parents from `batch_update` — scope limited to `save_issue` for now
- Not adding sub-issue awareness to other dashboard warnings (stuck, blocked, etc.)
- Not changing the `pipeline-detection.ts` SPLIT check (already correct)
- Not adding parent advancement to individual skill definitions (the whole point is eliminating that need)

## Implementation Approach

Three phases, each independently testable and deployable. Phase 1 is standalone. Phase 2 is a prerequisite for Phase 3 to handle the `Plan in Review` gate correctly, but Phase 2 is also valuable alone.

---

## Phase 1: Suppress `oversized_in_pipeline` for issues with sub-issues

> **Estimate**: XS | **Files**: 4

### Changes Required:

#### 1. Add `subIssues { totalCount }` to `DASHBOARD_ITEMS_QUERY`

**File**: [`plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts)

**Change**: Add `subIssues { totalCount }` inside the `... on Issue` fragment (after line 215).

```graphql
... on Issue {
  __typename
  number
  title
  state
  updatedAt
  closedAt
  assignees(first: 5) { nodes { login } }
  repository { nameWithOwner name }
  subIssues { totalCount }
}
```

**Change**: Add `subIssueCount` to `RawDashboardItem.content` (line 121-142):

```typescript
subIssues?: { totalCount: number };
```

#### 2. Add `subIssueCount` to `DashboardItem` and `toDashboardItems()`

**File**: [`plugin/ralph-hero/mcp-server/src/lib/dashboard.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/dashboard.ts)

**Change**: Add field to `DashboardItem` interface (after line 42):

```typescript
subIssueCount: number;
```

**File**: [`plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts)

**Change**: Map it in `toDashboardItems()` (around line 183):

```typescript
subIssueCount: r.content.subIssues?.totalCount ?? 0,
```

#### 3. Thread `subIssueCount` through `PhaseSnapshot` and `buildSnapshot()`

**File**: [`plugin/ralph-hero/mcp-server/src/lib/dashboard.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/dashboard.ts)

**Change**: Add to `PhaseSnapshot` issue shape (after line 58):

```typescript
subIssueCount: number;
```

**Change**: Map it in `buildSnapshot()` (around line 292):

```typescript
subIssueCount: item.subIssueCount,
```

#### 4. Guard the `oversized_in_pipeline` check

**File**: [`plugin/ralph-hero/mcp-server/src/lib/dashboard.ts:388-402`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/dashboard.ts#L388-L402)

**Change**: Add `issue.subIssueCount === 0` condition (line 389):

```typescript
if (
  issue.estimate &&
  OVERSIZED_ESTIMATES.has(issue.estimate) &&
  issue.subIssueCount === 0 &&
  phase.state !== "Backlog" &&
  !TERMINAL_STATES.includes(phase.state) &&
  phase.state !== "Human Needed"
) {
```

#### 5. Update tests

**File**: [`plugin/ralph-hero/mcp-server/src/__tests__/dashboard.test.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/__tests__/dashboard.test.ts)

- Add `subIssueCount: 0` to existing test `PhaseSnapshot` issue shapes (lines 571, 599, 625, 652) to maintain current behavior
- Add new test: `"oversized_in_pipeline: M/L/XL with sub-issues not flagged"` — issue with estimate `"L"` and `subIssueCount: 3` in `"Ready for Plan"` should produce zero `oversized_in_pipeline` warnings

### Success Criteria:

#### Automated Verification:
- [x] `npm test` — all existing dashboard tests pass
- [x] New test: oversized issue with sub-issues is not flagged
- [x] `npm run build` — no type errors

#### Manual Verification:
- [ ] `pipeline_dashboard` with `includeHealth: true` no longer shows false positive for #367

---

## Phase 2: Add `Plan in Review` to `PARENT_GATE_STATES`

> **Estimate**: XS | **Files**: 2

### Changes Required:

#### 1. Add `Plan in Review` to the gate states array

**File**: [`plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts:50-54`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts#L50-L54)

**Change**: Add `"Plan in Review"` to `PARENT_GATE_STATES`:

```typescript
export const PARENT_GATE_STATES: readonly string[] = [
  "Ready for Plan",
  "Plan in Review",
  "In Review",
  "Done",
] as const;
```

**Rationale**: "All children have plans ready for human review" is a meaningful convergence point. The parent should reflect that its children are collectively at the plan review gate. Without this, the parent remains at "Ready for Plan" while all children are two states ahead.

#### 2. Update tests

**File**: [`plugin/ralph-hero/mcp-server/src/__tests__/workflow-states.test.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/__tests__/workflow-states.test.ts)

- Update test at line 105: `expect(PARENT_GATE_STATES).toEqual(["Ready for Plan", "Plan in Review", "In Review", "Done"])`
- Add assertion at line 118: `expect(isParentGateState("Plan in Review")).toBe(true)`
- Remove `"Plan in Review"` from the `false` assertions if present

### Success Criteria:

#### Automated Verification:
- [ ] `npm test` — all workflow-states tests pass with updated expectations
- [ ] `npm run build` — no type errors

#### Manual Verification:
- [ ] Calling `advance_issue(direction="parent", number=508)` with all siblings in "Plan in Review" now returns `advanced: true` (moves #367 to "Plan in Review")

---

## Phase 3: Auto-advance parent in `save_issue` with batch optimization

> **Estimate**: S | **Files**: 4

### Overview

Add a post-mutation hook in `save_issue` that checks whether the parent should advance. Gated on `isParentGateState()` so non-gate transitions pay zero cost. Uses batch queries for constant-time performance.

### Changes Required:

#### 1. Create `autoAdvanceParent()` helper

**File**: [`plugin/ralph-hero/mcp-server/src/lib/helpers.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/helpers.ts) (after `syncStatusField` at line 597)

**Add new exported function**:

```typescript
/**
 * Auto-advance the parent issue if all siblings have reached the same gate state.
 * Uses batch queries for constant-time API cost (4-5 calls max regardless of sibling count).
 * Best-effort: returns null on any failure without throwing.
 */
export async function autoAdvanceParent(
  client: GitHubClient,
  fieldCache: FieldOptionCache,
  owner: string,
  repo: string,
  issueNumber: number,
  gateState: string,
  projectNumber: number,
): Promise<{ advanced: boolean; parentNumber?: number; toState?: string } | null>
```

**Implementation logic** (all best-effort — catch and return `null` on any failure):

**Step A — Fetch parent number (1 query)**:

```typescript
const parentResult = await client.query<{
  repository: {
    issue: { parent: { number: number } | null } | null;
  } | null;
}>(
  `query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      issue(number: $number) { parent { number } }
    }
  }`,
  { owner, repo, number: issueNumber },
);
const parentNumber = parentResult.repository?.issue?.parent?.number;
if (!parentNumber) return null;
```

**Step B — Fetch siblings (1 query)**:

```typescript
const siblingResult = await client.query<{
  repository: {
    issue: {
      subIssues: { nodes: Array<{ number: number }> };
    } | null;
  } | null;
}>(
  `query($owner: String!, $repo: String!, $parentNum: Int!) {
    repository(owner: $owner, name: $repo) {
      issue(number: $parentNum) {
        subIssues(first: 50) { nodes { number } }
      }
    }
  }`,
  { owner, repo, parentNum: parentNumber },
);
const siblings = siblingResult.repository?.issue?.subIssues?.nodes || [];
if (siblings.length === 0) return { advanced: false, parentNumber };
```

**Step C — Batch resolve project item IDs (1 query)**:

Use `buildBatchResolveQuery()` for all siblings + parent. Import from `batch-tools.ts`.

```typescript
const allNumbers = [...siblings.map((s) => s.number), parentNumber];
const { queryString, variables } = buildBatchResolveQuery(owner, repo, allNumbers);
const resolveResult = await client.query<Record<string, ...>>(queryString, variables);
```

Parse result to map each issue number to its project item ID. Write to session cache (`issue-node-id:*` and `project-item-id:*`) for reuse.

**Step D — Batch read field values (1 query)**:

Use `buildBatchFieldValueQuery()` for all resolved project item IDs.

```typescript
const itemEntries = projectItemIds.map((id, i) => ({
  alias: `fv${i}`,
  itemId: id,
}));
const fvBatch = buildBatchFieldValueQuery(itemEntries);
const fvResult = await client.query<Record<string, ...>>(
  fvBatch.queryString,
  fvBatch.variables,
);
```

Parse field values using `extractWorkflowState()` helper (see below).

**Step E — Gate check (in-memory, zero cost)**:

```typescript
const siblingStates = siblings.map((_, i) =>
  extractWorkflowState(fvResult[`fv${i}`]),
);
const allAtGate = siblingStates.every((state) => state === gateState);
if (!allAtGate) return { advanced: false, parentNumber };

const parentIdx = allNumbers.length - 1;
const parentState = extractWorkflowState(fvResult[`fv${parentIdx}`]);
if (stateIndex(parentState || "") >= stateIndex(gateState)) {
  return { advanced: false, parentNumber };
}
```

**Step F — Advance parent (1-2 mutations)**:

```typescript
const parentItemId = projectItemIds[parentIdx];
await updateProjectItemField(
  client, fieldCache, parentItemId,
  "Workflow State", gateState, projectNumber,
);
await syncStatusField(
  client, fieldCache, parentItemId, gateState, projectNumber,
);
return { advanced: true, parentNumber, toState: gateState };
```

#### 2. Add `extractWorkflowState()` helper

**File**: [`plugin/ralph-hero/mcp-server/src/lib/helpers.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/helpers.ts)

Small helper used by `autoAdvanceParent` to parse batch field value responses:

```typescript
function extractWorkflowState(
  item:
    | {
        fieldValues?: {
          nodes: Array<{
            __typename?: string;
            name?: string;
            field?: { name: string };
          }>;
        };
      }
    | undefined,
): string | null {
  const node = item?.fieldValues?.nodes?.find(
    (fv) =>
      fv.field?.name === "Workflow State" &&
      fv.__typename === "ProjectV2ItemFieldSingleSelectValue",
  );
  return node?.name ?? null;
}
```

#### 3. Call `autoAdvanceParent` from `save_issue`

**File**: [`plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L1425-L1431)

**Insert after line 1425** (after all project field mutations, before `toolSuccess`):

```typescript
// Auto-advance parent if we just moved to a gate state
if (resolvedWorkflowState && isParentGateState(resolvedWorkflowState)) {
  try {
    const advanceResult = await autoAdvanceParent(
      client,
      fieldCache,
      owner,
      repo,
      args.number,
      resolvedWorkflowState,
      projectNumber,
    );
    if (advanceResult?.advanced) {
      changes.parentAdvanced = {
        number: advanceResult.parentNumber,
        toState: advanceResult.toState,
      };
    }
  } catch {
    // Best-effort: don't fail the primary save_issue operation
  }
}
```

**Add imports**: `isParentGateState` from `../lib/workflow-states.js` and `autoAdvanceParent` from `../lib/helpers.js`.

**Note**: `projectNumber` is already resolved at line 1325. `fieldCache` is already available. No new parameters needed.

#### 4. Update tests

**File**: [`plugin/ralph-hero/mcp-server/src/__tests__/save-issue.test.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/__tests__/save-issue.test.ts)

Add structural test: verify `save_issue` source contains `autoAdvanceParent` call gated by `isParentGateState`.

**File**: New [`plugin/ralph-hero/mcp-server/src/__tests__/auto-advance-parent.test.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/__tests__/)

Test `autoAdvanceParent()` helper directly:

- **No parent**: returns `null`
- **Siblings not all at gate**: returns `{ advanced: false }`
- **Parent already at/past gate**: returns `{ advanced: false }`
- **All siblings at gate, parent behind**: returns `{ advanced: true, parentNumber, toState }`
- **API error**: returns `null` (best-effort)

### API Cost Summary

| Scenario | Extra calls added to `save_issue` |
|----------|-----------------------------------|
| Non-gate state transition (most calls) | **0** |
| Gate state, no parent | **1** (parent lookup) |
| Gate state, parent exists, not all siblings at gate | **4** (parent + siblings + batch resolve + batch field values) |
| Gate state, all siblings at gate, parent already there | **4** |
| Gate state, all siblings at gate, **advance parent** | **6** (4 reads + 2 mutations) |

Constant regardless of sibling count — vs. current `advance_issue` at N+5.

### Success Criteria:

#### Automated Verification:
- [ ] `npm test` — all tests pass including new `auto-advance-parent.test.ts`
- [ ] `npm run build` — no type errors
- [ ] Structural test: `save_issue` source contains `autoAdvanceParent` gated by `isParentGateState`

#### Manual Verification:
- [ ] Move all sub-issues of a parent to "Plan in Review" via `save_issue` — parent auto-advances to "Plan in Review"
- [ ] Move a sub-issue to "In Progress" (non-gate state) — no parent advancement, no extra latency
- [ ] Move last sub-issue to "Done" — parent auto-advances to "Done" and auto-closes

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation that the auto-advancement works correctly in a real scenario before merging.

---

## Testing Strategy

### Unit Tests:
- `dashboard.test.ts`: Existing `oversized_in_pipeline` tests updated + new sub-issue guard test
- `workflow-states.test.ts`: `PARENT_GATE_STATES` content assertion + `isParentGateState` tests
- `auto-advance-parent.test.ts`: Full coverage of `autoAdvanceParent()` helper

### Integration Testing:
- [ ] End-to-end: process a sub-issue through `save_issue(workflowState="Plan in Review")` and verify parent advances
- [ ] Verify `pipeline_dashboard` no longer shows false positive for parent issues with sub-issues

### Manual Testing Steps:
1. Run `pipeline_dashboard` with `includeHealth: true` — confirm #367 no longer flagged as oversized
2. Call `save_issue` on a sub-issue with `workflowState: "Plan in Review"` — confirm parent advances
3. Call `save_issue` with `workflowState: "In Progress"` — confirm zero additional latency

## Performance Considerations

- **Zero-cost gate**: `isParentGateState()` is a pure in-memory array `.includes()` check. Non-gate transitions (the vast majority) pay nothing.
- **Batch queries**: Using existing `buildBatchResolveQuery` and `buildBatchFieldValueQuery` patterns collapses N sequential queries into 1 each, giving O(1) API cost.
- **Cache priming**: The batch resolve step writes sibling `issue-node-id:*` and `project-item-id:*` entries to `SessionCache`, benefiting subsequent operations on those siblings within the same session.
- **Best-effort**: The entire auto-advance block is wrapped in try/catch. If any API call fails, `save_issue` still returns successfully — the parent just doesn't advance this time.

## References

- State machine audit: [`thoughts/shared/research/2026-03-03-GH-0000-state-machine-transition-audit.md`](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-03-GH-0000-state-machine-transition-audit.md)
- Workflow states: [`plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts)
- Dashboard health: [`plugin/ralph-hero/mcp-server/src/lib/dashboard.ts:306-418`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/dashboard.ts#L306-L418)
- Batch tools: [`plugin/ralph-hero/mcp-server/src/tools/batch-tools.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/batch-tools.ts)
- `save_issue`: [`plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts:1102-1437`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L1102-L1437)
- `advance_issue`: [`plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts:652-877`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts#L652-L877)
