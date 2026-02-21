---
date: 2026-02-21
github_issue: 247
github_url: https://github.com/cdubiel08/ralph-hero/issues/247
status: complete
type: research
---

# GH-247: Add Recursive Depth Option to list_sub_issues

## Problem Statement

The `ralph_hero__list_sub_issues` tool currently returns only direct children (depth=1) of a parent issue. Callers that need the full sub-issue tree (children + grandchildren) must make multiple sequential calls, which is cumbersome and error-prone. Adding an optional `depth` parameter would let callers fetch multiple levels in a single tool invocation.

## Current State Analysis

### Current `list_sub_issues` Implementation

[`relationship-tools.ts:128-227`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts#L128-L227)

The tool currently:
1. Accepts `owner`, `repo`, `number` (parent issue number)
2. Executes a single GraphQL query with `subIssues(first: 50)`
3. Returns flat array of `{ id, number, title, state }` plus `subIssuesSummary` and `hasMore` pagination flag
4. Does NOT recurse into children's children

### GraphQL Query Structure

```graphql
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      id number title
      subIssuesSummary { total completed percentCompleted }
      subIssues(first: 50) {
        nodes { id number title state }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}
```

### Existing Patterns for Deep Sub-Issue Fetching

The codebase already has patterns for fetching nested sub-issue data:

1. **Group detection** (`group-detection.ts:45-130`): The `SEED_QUERY` and `EXPAND_QUERY` already fetch `parent.subIssues` and `issue.subIssues` with blocking/blockedBy data. This uses an expand-queue approach (BFS) rather than nested GraphQL.

2. **`get_issue` tool** (`issue-tools.ts:509-561`): Fetches sub-issues at depth=1 only, similar to current `list_sub_issues`.

3. **`advance_children` tool** (`relationship-tools.ts:519-725`): Fetches sub-issues of a parent to iterate and update workflow states. Depth=1 only.

## Key Discoveries

### 1. GraphQL Does Not Support Recursive Queries

GraphQL has no native recursion support. You cannot write a query that automatically traverses arbitrary depth. Two approaches exist:

**Approach A: Static nesting in the query** -- Embed sub-issue selections at compile time for each depth level:
```graphql
# depth=2 query
subIssues(first: 50) {
  nodes {
    id number title state
    subIssuesSummary { total completed percentCompleted }
    subIssues(first: 50) {
      nodes { id number title state }
    }
  }
}
```

**Approach B: Sequential API calls** -- Make one query per level (BFS approach), similar to group detection's expand queue.

### 2. Static Nesting (Approach A) is Preferred

For the max depth of 3 specified in the issue, static nesting is simpler and more efficient:
- Only 1 API call regardless of depth (vs N calls for BFS)
- Predictable response shape
- Low complexity: just build the query string based on the `depth` parameter
- Max 3 levels is well within GraphQL complexity limits (50 * 50 * 50 = 125,000 nodes theoretical max, but GitHub's `nodeCount` limit will naturally cap this)
- The `subIssues` field is available on the `Issue` type, so nesting is valid

### 3. Response Shape Design

Each sub-issue node at depth > 1 should gain optional `subIssues` and `subIssuesSummary` fields, matching the acceptance criteria:

```typescript
interface SubIssueNode {
  id: string;
  number: number;
  title: string;
  state: string;
  // Only present when depth > 1 and this node has children
  subIssues?: SubIssueNode[];
  subIssuesSummary?: {
    total: number;
    completed: number;
    percentCompleted: number;
  };
}
```

### 4. Query Building Strategy

Build the GraphQL query dynamically based on depth:

```typescript
function buildSubIssueFragment(currentDepth: number, maxDepth: number): string {
  const base = "id number title state";
  if (currentDepth >= maxDepth) return base;
  return `${base}
    subIssuesSummary { total completed percentCompleted }
    subIssues(first: 50) {
      nodes { ${buildSubIssueFragment(currentDepth + 1, maxDepth)} }
    }`;
}
```

This produces correctly nested GraphQL for any depth 1-3.

### 5. Backward Compatibility

- Default `depth=1` preserves exact current behavior
- Same response shape at depth=1: flat `subIssues` array without nested `subIssues`/`subIssuesSummary` on children
- At depth > 1, children gain the extra fields only if they have sub-issues of their own
- Existing callers pass no `depth` parameter and get identical behavior

### 6. Rate Limit / Performance Considerations

- Depth=1: 1 API call (same as today)
- Depth=2: Still 1 API call, but higher `nodeCount` cost
- Depth=3: Still 1 API call, potentially significant `nodeCount` cost
- GitHub's node count limit (default ~500,000) should not be an issue for depth <= 3 with 50-node pages
- The `first: 50` pagination on each level naturally bounds the response
- No need for special rate limiting beyond what `GitHubClient` already provides

### 7. Test Strategy

The existing test pattern in this codebase is structural/source-verification tests (reading source files and asserting on patterns), not mocked integration tests. Following the same pattern:

- Verify `depth` parameter exists in Zod schema
- Verify `z.coerce.number().optional().default(1)` pattern
- Verify max depth validation (cap at 3)
- Verify that the GraphQL query building function produces correct nesting
- Verify backward compatibility: depth=1 query matches current query structure

The test file should be: `relationship-tools.test.ts`

## Potential Approaches

### Recommended: Dynamic Query Building with Static Nesting

1. Add `depth` parameter: `z.coerce.number().optional().default(1)` with `.max(3)` validation
2. Build GraphQL query dynamically using a recursive string builder
3. Parse response recursively to build nested `SubIssueNode[]` array
4. Return enriched response with nested `subIssues` when depth > 1

**Pros:**
- Single API call for any depth
- Simple implementation (~40 lines of new code)
- Clean recursive query builder
- Follows existing patterns in the codebase

**Cons:**
- Query string grows with depth (but max 3 is manageable)
- Response parsing requires recursive mapping

### Alternative: BFS with Multiple Queries

Make separate queries per level, like group detection does.

**Pros:**
- Each query is simple and identical
- Could handle arbitrarily deep trees

**Cons:**
- Multiple API calls (1 per level)
- More complex state management
- Unnecessary given the max depth=3 constraint
- Slower due to sequential requests

## Risks

1. **GitHub `subIssues` field availability**: The `subIssues` field requires the `GraphQL-Features: sub_issues` header. The existing codebase already uses this field throughout, so this is a non-risk.

2. **Node count limits**: For very wide trees (many sub-issues at each level), nested queries could hit GitHub's node count limits. The `first: 50` cap and max depth=3 mitigate this. Worst case: 50 * 50 * 50 = 125,000 nodes. If hit, the response will be truncated gracefully by GitHub.

3. **Response size**: Deep trees with many nodes produce larger JSON responses. This is bounded by the same `first: 50` limits and is unlikely to be problematic.

## Recommended Next Steps

1. Add `depth` parameter to `ralph_hero__list_sub_issues` Zod schema
2. Create `buildSubIssueFragment()` helper function for dynamic query building
3. Create `mapSubIssueNodes()` helper for recursive response mapping
4. Update tool description to mention depth parameter
5. Add structural tests in `relationship-tools.test.ts`
6. Verify depth=1 produces identical output to current implementation
