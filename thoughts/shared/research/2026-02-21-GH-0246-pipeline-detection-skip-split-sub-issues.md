---
date: 2026-02-21
github_issue: 246
github_url: https://github.com/cdubiel08/ralph-hero/issues/246
status: complete
type: research
---

# GH-246: Skip SPLIT Phase for Issues with Existing Sub-Issues

## Problem Statement

The `detectPipelinePosition()` function in `pipeline-detection.ts` triggers the SPLIT phase for any issue with an M/L/XL estimate, regardless of whether the issue already has sub-issues. This causes the orchestrator to attempt re-splitting tickets that have already been decomposed, wasting tokens and potentially creating duplicate work items.

## Current State Analysis

### Pipeline Detection (Step 1: SPLIT Check)

**File**: `plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts:118-131`

The current SPLIT detection logic only checks the `estimate` field:

```typescript
const oversized = issues.filter(
  (i) => i.estimate !== null && OVERSIZED_ESTIMATES.has(i.estimate),
);
if (oversized.length > 0) {
  return buildResult("SPLIT", ...);
}
```

The `IssueState` interface (line 26-31) only has four fields:
- `number: number`
- `title: string`
- `workflowState: string`
- `estimate: string | null`

There is no `subIssueCount` or `hasChildren` field, so the SPLIT decision cannot consider existing sub-issues.

### detect_pipeline_position Tool (IssueState Construction)

**File**: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts:1351-1367`

The `detect_pipeline_position` tool builds `IssueState[]` via `getIssueFieldValues()` (line 1825-1894), which only queries the project item's field values (Workflow State, Estimate, Priority). It does not fetch sub-issue data from the issue itself.

The `getIssueFieldValues()` helper queries a project item node by ID and extracts `ProjectV2ItemFieldSingleSelectValue` fields. Adding sub-issue data here would require a different query approach since sub-issue counts come from the issue node, not the project item node.

### get_issue Tool Already Has Sub-Issue Data

**File**: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts:524-526`

The `get_issue` tool already fetches `subIssuesSummary { total completed percentCompleted }` and `subIssues(first: 50)` via GraphQL. This data is available in the `get_issue` response but is not passed through to pipeline detection.

### Group Detection Already Fetches Sub-Issue Structure

**File**: `plugin/ralph-hero/mcp-server/src/lib/group-detection.ts:45-86`

The `SEED_QUERY` in group detection fetches `subIssues(first: 50)` for the seed issue and its parent's sub-issues. However, it doesn't expose sub-issue counts on individual group members.

## Key Discoveries

1. **`IssueState` interface is the data contract** between the tool layer and the detection logic. Adding `subIssueCount` here is the minimal, clean change.

2. **Two data paths construct `IssueState[]`**:
   - `detect_pipeline_position` tool (issue-tools.ts:1351-1367) -- builds from group detection + field value queries
   - Unit tests (pipeline-detection.test.ts:12-23) -- builds via `makeIssue()` helper

3. **`getIssueFieldValues()` is the wrong place to add sub-issue data**. It queries a `ProjectV2Item` node which doesn't have sub-issue information. The sub-issue data must come from the issue node itself.

4. **Group detection already has access to sub-issue structure** via `IssueRelationData.subIssueNumbers` (group-detection.ts:36). The `detect_pipeline_position` tool could extract sub-issue counts from the group detection result rather than making additional API calls.

5. **The `GroupIssue` interface** (group-detection.ts:15-21) doesn't include sub-issue counts either. The `groupTickets` array returned by `detectGroup()` would need augmentation, OR the tool layer could do a separate fetch.

## Potential Approaches

### Approach A: Augment GroupIssue and Flow Through (Recommended)

1. Add `subIssueCount: number` to `GroupIssue` interface in group-detection.ts
2. Populate it from the `IssueRelationData.subIssueNumbers.length` during the group detection result construction
3. Add `subIssueCount: number` (default 0) to `IssueState` interface in pipeline-detection.ts
4. In `detect_pipeline_position` tool, pass `subIssueCount` from group detection through to `IssueState`
5. In `detectPipelinePosition()` Step 1, filter out oversized issues where `subIssueCount > 0`

**Pros**: Leverages data already fetched by group detection. No additional API calls. Clean data flow.
**Cons**: Touches both group-detection.ts and pipeline-detection.ts. GroupIssue gets a new field.

### Approach B: Separate Query in Tool Layer

1. Add `subIssueCount: number` to `IssueState` interface
2. In `detect_pipeline_position` tool, after group detection, fetch `subIssuesSummary` for each issue separately via GraphQL
3. Pass counts through to `IssueState`

**Pros**: No changes to group detection. Simpler scope.
**Cons**: Additional API calls (one per group member). Worse performance.

### Approach C: Batch Query in Tool Layer

1. Add `subIssueCount: number` to `IssueState`
2. In `detect_pipeline_position` tool, make a single batched GraphQL query for all group member sub-issue counts
3. Pass counts through to `IssueState`

**Pros**: Single additional API call. No group-detection changes.
**Cons**: Adds query complexity. Batched GraphQL with dynamic aliases is verbose.

### Recommended: Approach A

Approach A is best because:
- Group detection already fetches sub-issue lists via `subIssues(first: 50)` in the SEED_QUERY
- The data is already in `IssueRelationData.subIssueNumbers` -- just not exposed in the final result
- Zero additional API calls
- The change follows existing data flow patterns

## Implementation Details

### Changes Required

1. **`pipeline-detection.ts`** -- `IssueState` interface:
   ```typescript
   export interface IssueState {
     number: number;
     title: string;
     workflowState: string;
     estimate: string | null;
     subIssueCount: number;  // NEW: number of direct sub-issues
   }
   ```

2. **`pipeline-detection.ts`** -- Step 1 SPLIT logic:
   ```typescript
   const oversized = issues.filter(
     (i) => i.estimate !== null && OVERSIZED_ESTIMATES.has(i.estimate) && i.subIssueCount === 0,
   );
   ```

3. **`group-detection.ts`** -- `GroupIssue` interface:
   ```typescript
   export interface GroupIssue {
     id: string;
     number: number;
     title: string;
     state: string;
     order: number;
     subIssueCount: number;  // NEW
   }
   ```

4. **`group-detection.ts`** -- `IssueRelationData` already has `subIssueNumbers: number[]`. In the `detectGroup()` result construction (line 354-363), add:
   ```typescript
   subIssueCount: issueMap.get(num)!.subIssueNumbers.length,
   ```

5. **`issue-tools.ts`** -- `detect_pipeline_position` tool (line 1351-1367):
   ```typescript
   return {
     number: ticket.number,
     title: ticket.title,
     workflowState: state.workflowState || "unknown",
     estimate: state.estimate || null,
     subIssueCount: ticket.subIssueCount ?? 0,  // NEW: from group detection
   };
   ```

6. **`pipeline-detection.test.ts`** -- Update `makeIssue()` helper and add test cases:
   - `makeIssue()` gets optional `subIssueCount` parameter (default 0)
   - Test: "M issue with children should not trigger SPLIT" -- `makeIssue(1, "Backlog", "M", 3)` -> expect phase NOT "SPLIT"
   - Test: "M issue without children should trigger SPLIT" -- `makeIssue(1, "Backlog", "M", 0)` -> expect "SPLIT"
   - Test: "mixed group: some M issues already split, some not" -> only unsplit ones trigger SPLIT

### Edge Cases

- **`subIssueCount` defaults to 0**: Safe for backward compatibility. Any existing callers not providing it will behave exactly as before.
- **Issue with sub-issues that are all closed**: Still has children, should still skip SPLIT. The count is of direct sub-issues, not open ones. This is correct -- re-splitting a ticket whose children are done makes no sense.
- **Parent issue (#202) is M-sized with 3 sub-issues**: Currently the parent is in Backlog and isn't part of the group member set (it's excluded by `filterGroupMembers`). The siblings (#246, #247, #248) are all S/XS, so SPLIT wouldn't fire on them anyway. This is the correct behavior.

### Data Flow Verification

The sub-issue data flows through group detection's `SEED_QUERY` which already requests:
```graphql
subIssues(first: 50) {
  nodes { id number title state ... }
}
```

For siblings (fetched via parent's subIssues), the query also fetches `blocking`/`blockedBy` but does NOT currently recurse into grandchildren's `subIssues`. This means:
- For a **direct child of a parent** (e.g., #246 under #202), the seed query fetches #246's own `subIssues` via the seed issue path
- For **siblings discovered via parent** (e.g., #247, #248), the parent's `subIssues` query returns them but doesn't fetch THEIR sub-issues

This is a limitation: sibling sub-issue counts may not be populated from group detection alone. However, the seed issue's sub-issue count IS available. For the typical case where the `detect_pipeline_position` tool is called on a specific issue, the seed issue will have accurate sub-issue data.

**Mitigation**: In the expand phase, `EXPAND_QUERY` also fetches `subIssues(first: 50)` for expanded issues. And for siblings fetched via the parent, we could add `subIssues(first: 0) { totalCount }` (or `subIssuesSummary`) to the sibling node query to get counts without fetching full children. But this is an optimization for sibling issue #247 (recursive depth), not strictly needed for #246.

**Practical note**: The `IssueRelationData.subIssueNumbers` field IS populated for siblings from parent's subIssues query -- but it only captures the sub-issues explicitly listed in the SEED_QUERY response. For siblings, the `subIssueNumbers` will be `[]` because the parent's subIssues query doesn't recurse into each sibling's own sub-issues. This means sibling sub-issue counts from group detection alone may be inaccurate (showing 0 when there are children).

**Best approach**: In the `detect_pipeline_position` tool, when constructing `IssueState[]`, fetch `subIssuesSummary` for any issue that has an oversized estimate. This is a targeted query only for M/L/XL issues, keeping API calls minimal while ensuring accuracy.

## Risks

1. **Low risk**: Adding a field to `IssueState` is backward-compatible (default 0 preserves existing behavior).
2. **Low risk**: The SPLIT logic change is additive -- it only narrows when SPLIT fires, never widens.
3. **Medium risk**: Sub-issue count accuracy for sibling issues discovered via group detection. Mitigated by the targeted fetch approach described above.

## Recommended Next Steps

1. Add `subIssueCount` to `IssueState` interface with default 0
2. Update `detectPipelinePosition` Step 1 to skip oversized issues with `subIssueCount > 0`
3. In the `detect_pipeline_position` tool, fetch `subIssuesSummary.total` for oversized group members
4. Add unit tests for all described scenarios
5. Keep `GroupIssue` changes optional (nice-to-have for Approach A, not strictly required if using targeted fetch)
