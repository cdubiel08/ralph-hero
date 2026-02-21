---
date: 2026-02-21
status: draft
github_issues: [246, 247]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/246
  - https://github.com/cdubiel08/ralph-hero/issues/247
primary_issue: 246
---

# Skip SPLIT for Already-Split Issues + Recursive Sub-Issue Traversal - Atomic Implementation Plan

## Overview
2 related issues for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-247 | feat(list-sub-issues): add recursive depth option for tree traversal | S |
| 2 | GH-246 | fix(pipeline-detection): skip SPLIT phase for issues that already have sub-issues | S |

**Why grouped**: GH-246 needs sub-issue count data to skip SPLIT for already-split issues. GH-247 adds recursive depth to `list_sub_issues`, which provides the tree traversal foundation. While GH-246 doesn't strictly depend on GH-247's recursive depth feature, implementing GH-247 first means the sub-issue data plumbing is established and GH-246 can leverage similar patterns. Both fix the same root problem: the pipeline re-splits tickets that already have children.

**Note**: GH-248 (orchestrator skill prompt changes) is excluded from this plan -- it depends on both GH-246 and GH-247 and will be planned separately after implementation.

## Current State Analysis

### Pipeline Detection (`pipeline-detection.ts`)
- `IssueState` interface has 4 fields: `number`, `title`, `workflowState`, `estimate` -- no sub-issue awareness
- Step 1 SPLIT check filters on `OVERSIZED_ESTIMATES` only, triggering SPLIT for any M/L/XL issue regardless of existing children
- The `detect_pipeline_position` tool constructs `IssueState[]` from group detection + `getIssueFieldValues()`, neither of which exposes sub-issue counts

### Sub-Issue Listing (`relationship-tools.ts`)
- `list_sub_issues` fetches depth=1 only (direct children via `subIssues(first: 50)`)
- Returns flat array of `{ id, number, title, state }` plus `subIssuesSummary`
- No recursive traversal capability -- callers needing grandchildren must make multiple calls

### Group Detection (`group-detection.ts`)
- `GroupIssue` interface has `id`, `number`, `title`, `state`, `order` -- no `subIssueCount`
- `IssueRelationData` has `subIssueNumbers: number[]` but this is only populated for the seed issue and expanded issues, not for siblings discovered via parent
- Siblings get `subIssueNumbers: []` because the parent's `subIssues` query doesn't recurse

## Desired End State

### Verification
- [ ] `list_sub_issues` accepts optional `depth` parameter (1-3), defaults to 1
- [ ] `depth=1` produces identical output to current behavior
- [ ] `depth=2+` returns nested `subIssues` and `subIssuesSummary` on each child node
- [ ] `IssueState` has a `subIssueCount` field (number, default 0)
- [ ] `detectPipelinePosition` skips SPLIT for issues where `subIssueCount > 0`
- [ ] `detect_pipeline_position` tool fetches sub-issue counts for oversized group members
- [ ] Unit tests cover all new behavior
- [ ] All existing tests pass unchanged

## What We're NOT Doing
- Modifying `GroupIssue` interface or `detectGroup()` (would be nice-to-have but adds scope)
- Recursive tree fetching beyond depth=3
- Pagination for nested sub-issues (each level uses `first: 50`)
- Orchestrator skill prompt changes (GH-248, planned separately)
- Changing `get_issue` tool's sub-issue response shape

## Implementation Approach
Phase 1 adds the `depth` parameter to `list_sub_issues` with a dynamic GraphQL query builder. Phase 2 then adds `subIssueCount` to `IssueState` and modifies the SPLIT check. Phase 2 uses a targeted approach: rather than modifying group detection, the `detect_pipeline_position` tool fetches `subIssuesSummary.total` for any oversized group member via an additional GraphQL query. This keeps the change scoped and avoids touching the group detection algorithm.

---

## Phase 1: GH-247 - Add recursive depth option to `list_sub_issues`
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/247 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-GH-0247-list-sub-issues-recursive-depth.md

### Changes Required

#### 1. Add `depth` parameter and dynamic query builder
**File**: [`plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts)

**Changes**:
- Add `depth` parameter to the tool's Zod schema: `z.coerce.number().optional().default(1).describe(...)` with `.min(1).max(3)` validation
- Add a `buildSubIssueFragment(currentDepth: number, maxDepth: number): string` helper function above or within the tool registration that recursively builds the GraphQL selection set:
  ```
  depth=1: "id number title state"
  depth=2: "id number title state subIssuesSummary { total completed percentCompleted } subIssues(first: 50) { nodes { id number title state } }"
  depth=3: (one more level of nesting)
  ```
- Replace the hardcoded GraphQL query string with a dynamically built query using `buildSubIssueFragment(1, args.depth)`
- Add a `mapSubIssueNodes(nodes, currentDepth, maxDepth)` recursive mapper that builds the response, adding `subIssues` and `subIssuesSummary` fields to child nodes when `currentDepth < maxDepth`
- Update the tool description to mention the `depth` parameter
- Update the response type to include optional nested fields on sub-issue nodes

**Pattern to follow**: The existing `list_sub_issues` query structure at [relationship-tools.ts:169-183](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts#L169-L183). The dynamic query replaces the static query but preserves the same root structure.

#### 2. Add tests for depth parameter
**File**: [`plugin/ralph-hero/mcp-server/src/__tests__/pipeline-detection.test.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/__tests__/pipeline-detection.test.ts) -- No, this is a new test file.

**File**: `plugin/ralph-hero/mcp-server/src/__tests__/relationship-tools.test.ts` (NEW FILE)

**Changes**: Following the structural/source-verification test pattern used throughout this codebase (e.g., [`issue-tools.test.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/__tests__/issue-tools.test.ts)):
- Test that `list_sub_issues` tool schema includes `depth` parameter
- Test that `depth` has `.default(1)` and `.max(3)` constraints
- Test `buildSubIssueFragment(1, 1)` returns base fields only (no nested subIssues)
- Test `buildSubIssueFragment(1, 2)` returns base fields + nested subIssues selection
- Test `buildSubIssueFragment(1, 3)` returns 3 levels of nesting
- Test `mapSubIssueNodes` produces correct nested structure

### Success Criteria
- [x] Automated: `npm test` passes with new and existing tests
- [ ] Manual: `list_sub_issues(number=202, depth=2)` returns GH-202's children with their own sub-issue data

**Creates for next phase**: The `buildSubIssueFragment` and `mapSubIssueNodes` helpers establish a pattern for fetching nested sub-issue data. Phase 2 uses a simpler approach (just `subIssuesSummary.total`) but the depth traversal is available for GH-248's orchestrator changes.

---

## Phase 2: GH-246 - Skip SPLIT phase for issues with existing sub-issues
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/246 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-GH-0246-pipeline-detection-skip-split-sub-issues.md | **Depends on**: Phase 1 (conceptually, but no code dependency)

### Changes Required

#### 1. Add `subIssueCount` to `IssueState` interface
**File**: [`plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts:26-31`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts#L26-L31)

**Changes**:
- Add `subIssueCount: number;` field to the `IssueState` interface (after `estimate`)

#### 2. Update SPLIT detection logic
**File**: [`plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts:118-131`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts#L118-L131)

**Changes**:
- Modify the `oversized` filter to also exclude issues where `subIssueCount > 0`:
  ```typescript
  const oversized = issues.filter(
    (i) => i.estimate !== null && OVERSIZED_ESTIMATES.has(i.estimate) && i.subIssueCount === 0,
  );
  ```
  This is a one-line change: adding `&& i.subIssueCount === 0` to the filter predicate.

#### 3. Fetch sub-issue counts in `detect_pipeline_position` tool
**File**: [`plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts:1350-1367`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L1350-L1367)

**Changes**:
- After constructing the initial `issueStates` array (line 1367), add a targeted fetch for sub-issue counts on any issue with an oversized estimate:
  ```typescript
  // Fetch sub-issue counts for oversized issues (targeted query, not all issues)
  const oversizedNumbers = issueStates
    .filter((i) => i.estimate !== null && OVERSIZED_ESTIMATES.has(i.estimate))
    .map((i) => i.number);

  if (oversizedNumbers.length > 0) {
    await Promise.all(
      oversizedNumbers.map(async (num) => {
        const subResult = await client.query<{
          repository: {
            issue: { subIssuesSummary: { total: number } | null } | null;
          } | null;
        }>(
          `query($owner: String!, $repo: String!, $number: Int!) {
            repository(owner: $owner, name: $repo) {
              issue(number: $number) {
                subIssuesSummary { total }
              }
            }
          }`,
          { owner, repo, number: num },
        );
        const issueState = issueStates.find((i) => i.number === num);
        if (issueState && subResult.repository?.issue?.subIssuesSummary) {
          issueState.subIssueCount = subResult.repository.issue.subIssuesSummary.total;
        }
      }),
    );
  }
  ```
- Import `OVERSIZED_ESTIMATES` from `pipeline-detection.ts` (or inline the set)
- Ensure all `IssueState` construction includes `subIssueCount: 0` as the default

#### 4. Update `makeIssue` helper and add test cases
**File**: [`plugin/ralph-hero/mcp-server/src/__tests__/pipeline-detection.test.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/__tests__/pipeline-detection.test.ts)

**Changes**:

Update `makeIssue` helper (line 12-23):
```typescript
function makeIssue(
  number: number,
  workflowState: string,
  estimate: string | null = "S",
  subIssueCount: number = 0,
): IssueState {
  return {
    number,
    title: `Issue #${number}`,
    workflowState,
    estimate,
    subIssueCount,
  };
}
```

Add new test section after the "edge cases" describe block:

```typescript
describe("detectPipelinePosition - sub-issue count (SPLIT skip)", () => {
  it("M issue with children should NOT trigger SPLIT", () => {
    const result = detectSingle(makeIssue(1, "Backlog", "M", 3));
    expect(result.phase).not.toBe("SPLIT");
    expect(result.phase).toBe("TRIAGE"); // Falls through to Backlog check
  });

  it("M issue without children should trigger SPLIT", () => {
    const result = detectSingle(makeIssue(1, "Backlog", "M", 0));
    expect(result.phase).toBe("SPLIT");
  });

  it("L issue with children should NOT trigger SPLIT", () => {
    const result = detectSingle(makeIssue(1, "Backlog", "L", 2));
    expect(result.phase).not.toBe("SPLIT");
  });

  it("XL issue with children should NOT trigger SPLIT", () => {
    const result = detectSingle(makeIssue(1, "Backlog", "XL", 1));
    expect(result.phase).not.toBe("SPLIT");
  });

  it("mixed group: some M issues already split, some not", () => {
    const result = detectGroup([
      makeIssue(1, "Backlog", "M", 3),  // already split
      makeIssue(2, "Backlog", "M", 0),  // needs splitting
    ]);
    expect(result.phase).toBe("SPLIT");
    expect(result.reason).toContain("#2=M");
    expect(result.reason).not.toContain("#1=M");
  });

  it("all M issues already split: no SPLIT phase", () => {
    const result = detectGroup([
      makeIssue(1, "Backlog", "M", 3),
      makeIssue(2, "Backlog", "L", 2),
    ]);
    expect(result.phase).not.toBe("SPLIT");
    expect(result.phase).toBe("TRIAGE"); // Falls through to Backlog check
  });

  it("S issue with children: subIssueCount is irrelevant (not oversized)", () => {
    const result = detectSingle(makeIssue(1, "Backlog", "S", 5));
    expect(result.phase).toBe("TRIAGE"); // S is not oversized, so SPLIT never fires
  });
});
```

#### 5. Export `OVERSIZED_ESTIMATES` for use in tool layer
**File**: [`plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts:70`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts#L70)

**Changes**:
- Change `const OVERSIZED_ESTIMATES` to `export const OVERSIZED_ESTIMATES` so `issue-tools.ts` can import it for the targeted sub-issue count fetch. Alternatively, inline the set `new Set(["M", "L", "XL"])` in the tool layer to avoid the export.

### Success Criteria
- [x] Automated: `npm test` passes -- all existing SPLIT tests still pass, new sub-issue-count tests pass
- [x] Automated: `makeIssue(1, "Backlog", "M", 3)` does NOT trigger SPLIT
- [x] Automated: `makeIssue(1, "Backlog", "M", 0)` DOES trigger SPLIT
- [ ] Manual: `detect_pipeline_position(number=202)` on the parent epic (which is M-sized with 3 children) should NOT return SPLIT

---

## Integration Testing
- [ ] Run full test suite: `cd plugin/ralph-hero/mcp-server && npm test`
- [ ] Verify `list_sub_issues(number=202, depth=1)` returns same output as before (backward compat)
- [ ] Verify `list_sub_issues(number=202, depth=2)` returns children with nested sub-issues
- [ ] Verify `detect_pipeline_position(number=202)` on the M-sized parent epic does NOT return SPLIT (it has 3 children)
- [ ] Build succeeds: `npm run build`

## References
- Research GH-246: [thoughts/shared/research/2026-02-21-GH-0246-pipeline-detection-skip-split-sub-issues.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-GH-0246-pipeline-detection-skip-split-sub-issues.md)
- Research GH-247: [thoughts/shared/research/2026-02-21-GH-0247-list-sub-issues-recursive-depth.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-GH-0247-list-sub-issues-recursive-depth.md)
- Parent epic: [GH-202](https://github.com/cdubiel08/ralph-hero/issues/202)
- Sibling (deferred): [GH-248](https://github.com/cdubiel08/ralph-hero/issues/248)
