---
date: 2026-03-01
github_issue: 431
github_url: https://github.com/cdubiel08/ralph-hero/issues/431
status: complete
type: research
---

# GH-431: Add list_groups Tool — Research Findings

## Problem Statement

There is no way to get a bird's-eye view of all issue groups (parent issues with sub-issues) in a project. The only current path is to call `get_issue(includeGroup: true)` per issue, requiring N API calls to discover N groups. This is prohibitively expensive for projects with many issues and makes group enumeration impractical for orchestration and reporting use cases.

## Current State Analysis

### Existing Sub-Issue Infrastructure

The codebase already has substantial sub-issue infrastructure to build on:

**`list_sub_issues`** (`plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts:204–297`)
- Fetches direct children (depth 1–3) of a *known* parent via `repository.issue(number) { subIssues(first: 50) { ... } }`
- Uses `buildSubIssueFragment` to dynamically generate recursive GraphQL fragments
- Requires caller to already know which issues are parents

**`get_issue` with group detection** (`plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts:472–860`)
- Fetches `subIssuesSummary { total completed percentCompleted }` and `subIssues(first: 50)` per issue
- `includeGroup: true` (default) also runs `detectGroup()` for full group context
- Still requires N individual calls to discover N groups

**`list_issues`** (`plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts:59–444`)
- Paginates all project items (up to 500) and filters client-side
- The project items GraphQL query (`issue-tools.ts:204–242`) fetches `content { ... on Issue { number, title, body, state, url, labels, assignees, repository } }` — **crucially, `subIssuesSummary` is absent**
- Has complete filter infrastructure: `workflowState`, `estimate`, `priority`, `state`, `label`, etc.

### Gap: No Group Enumeration Tool

There is no tool that can answer: "Which issues in this project have sub-issues, and what are those sub-issues?" The `list_issues` output contains no sub-issue data, and calling `get_issue` per item to find parents is prohibitively expensive.

## Key Discoveries

### 1. `subIssuesSummary` Is Available in Project Items Content Fragment

The `subIssuesSummary` field is a native GitHub Issue field (not a project custom field), queryable on any Issue node. The existing `get_issue` implementation confirms it is accessible via `repository.issue(number)`. It is equally accessible within the project items `content { ... on Issue { ... } }` fragment in `list_issues`-style queries.

**Adding `subIssuesSummary { total completed percentCompleted }` to the project items query enables client-side filtering to parent issues in a single paginated pass.** This is the key enabler for the feature.

When `showChildren: true`, additionally adding `subIssues(first: 50) { nodes { number title state } }` returns children inline.

### 2. Child `workflowState` Can Be Resolved Without Extra API Calls

`workflowState` is a GitHub Projects V2 single-select field — it lives in `fieldValues`, not on the Issue node itself. Fetching it for children is non-trivial if querying `subIssues` inline.

**Solution**: The project items pagination already fetches field values for every item. Build a lookup map `issue_number → { workflowState, estimate, priority }` from the full items result, then cross-reference children's numbers against this map. Cost: zero additional API calls; children's states resolve from the same already-fetched dataset.

This works reliably because children are themselves project items, so their field values appear in the same paginated result.

### 3. Single-Pass GraphQL Architecture Is Viable

The complete algorithm:

```
1. paginateConnection(project items with subIssuesSummary [+ subIssues if showChildren])
   → up to 500 items, same as list_issues
2. Build lookup map: issue_number → { workflowState, estimate, priority, state, title }
3. Filter items: type === "ISSUE" && subIssuesSummary.total > 0
4. Apply parent-level filters: state, workflowState, estimate, priority, limit
5. Assemble group objects: parent + childCount + completedCount [+ children with state lookup]
6. Return { totalGroups, groups }
```

No N+1 problem. No additional API calls per group or per child.

### 4. Filter Infrastructure Is Directly Reusable

`list_issues` already has `getFieldValue(item, fieldName)` (`issue-tools.ts:1718`) and the multi-stage filter chain. All parent-level filters from the issue spec (`state`, `workflowState`, `estimate`, `priority`, `limit`) map directly onto existing helpers with zero new filter logic needed.

### 5. Tool Placement: `relationship-tools.ts`

`relationship-tools.ts` already owns `list_sub_issues`, `add_sub_issue`, `remove_sub_issue`, and `buildSubIssueFragment`. Group listing is a natural fit in this module. Registration follows the identical pattern used by all other tools: `registerRelationshipTools(server, client, fieldCache)` called from `index.ts:345`.

### 6. `GraphQL-Features: sub_issues` Header Not Required

The existing codebase uses `subIssuesSummary` and `subIssues` fields successfully without an explicit `GraphQL-Features: sub_issues` header. The `github-client.ts` creates its `graphql.defaults()` instances with only authorization headers (`github-client.ts:81–97`). The sub-issues GraphQL features are now generally available.

## Potential Approaches

### Approach A (Recommended): Single-Pass with `subIssuesSummary` in Project Items Query

**How**: Extend the project items GraphQL content fragment to include `subIssuesSummary { total completed percentCompleted }` (and `subIssues(first: 50) { nodes { number title state } }` when `showChildren: true`). Filter and assemble client-side. Cross-reference child states from the full item map.

**Pros**:
- Single paginated API call (same as `list_issues`)
- No N+1 problem
- Full child `workflowState` resolution for free
- Reuses all existing filter helpers
- Minimal new code

**Cons**:
- Slightly larger GraphQL response per item (subIssuesSummary adds ~3 fields per item)
- Children with `showChildren: true` adds sub-issues payload; for projects with many parent issues and many children, response size grows

### Approach B: Two-Step (Fetch Items → Per-Parent Expansion)

**How**: First call `list_issues` to identify candidates (need to add `subIssuesSummary` to detect parents), then call `list_sub_issues` per parent for children.

**Cons**:
- N+1 API calls for N parent issues
- Higher rate limit cost
- More complex orchestration
- No advantage over Approach A

**Verdict**: Approach B is strictly worse. Use Approach A.

### Approach C: GraphQL Query via `repository.issues` (Non-Project)

**How**: Query `repository { issues(first: 100) { nodes { subIssues { totalCount } } } }` to find parents, then cross-reference with project membership.

**Cons**:
- Doesn't respect project membership filtering
- Doesn't have access to project custom fields (workflowState, estimate, priority) without separate lookups
- Misaligns with the existing project-centric architecture

**Verdict**: Not viable. All tooling is project-centric.

## Implementation Plan

### Files to Create

- `plugin/ralph-hero/mcp-server/src/tools/group-tools.ts` — new file for `list_groups` and future group-management tools, OR add to `relationship-tools.ts`

  **Recommendation**: Add to `relationship-tools.ts` to keep group-related tools co-located with `list_sub_issues`. If the file grows, extract later.

### Files to Modify

1. **`plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts`**
   - Add `ralph_hero__list_groups` tool registration inside `registerRelationshipTools`
   - Import no new helpers needed (all exist: `paginateConnection`, `ensureFieldCache`, `resolveFullConfig`, `getFieldValue`, `toolSuccess`, `toolError`)

2. **`plugin/ralph-hero/mcp-server/src/index.ts`**
   - No changes needed — `registerRelationshipTools` is already called at line 345

3. **`plugin/ralph-hero/mcp-server/src/__tests__/relationship-tools.test.ts`** (or new test file)
   - Add structural tests for `list_groups`: parameter schema, filter behavior, `showChildren` flag, child state resolution

### GraphQL Query Shape

```graphql
query($projectId: ID!, $cursor: String, $first: Int!) {
  node(id: $projectId) {
    ... on ProjectV2 {
      items(first: $first, after: $cursor) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          type
          content {
            ... on Issue {
              number
              title
              state
              url
              subIssuesSummary { total completed percentCompleted }
              # Only when showChildren: true:
              subIssues(first: 50) {
                nodes { number title state }
              }
            }
          }
          fieldValues(first: 20) {
            nodes {
              ... on ProjectV2ItemFieldSingleSelectValue {
                __typename
                name
                field { ... on ProjectV2FieldCommon { name } }
              }
            }
          }
        }
      }
    }
  }
}
```

### Return Shape (matching issue spec)

```json
{
  "totalGroups": 5,
  "groups": [
    {
      "parent": {
        "number": 393,
        "title": "Extract ralph-val as standalone skill",
        "state": "OPEN",
        "workflowState": "Backlog",
        "estimate": "M"
      },
      "childCount": 5,
      "completedCount": 2,
      "children": [
        { "number": 401, "title": "Phase 1: Create ralph-val skill", "state": "OPEN", "workflowState": "In Progress" }
      ]
    }
  ]
}
```

`children` is omitted when `showChildren: false`.

## Risks

| Risk | Severity | Mitigation |
|------|----------|-----------|
| `subIssuesSummary` not available in project items content fragment | Medium | Use `get_issue` as reference — the field is on the Issue type. If unavailable, fall back to a separate `repository.issues` query. Verify in integration test. |
| Children with `>50` sub-issues truncated | Low | `first: 50` is the existing codebase limit for sub-issues throughout. Add `hasMore` flag in response; acceptable for current scale. |
| Response size with `showChildren: true` for large projects | Low | Default `showChildren: false`. Limit with `limit` parameter (default 50 groups). |
| Child issues not on the project board | Low | Cross-referencing child states from the item map only works for children that are project items. Children not on the board return `workflowState: null`. Document this behavior. |

## Recommended Next Steps

1. Implement `ralph_hero__list_groups` in `relationship-tools.ts` following the Approach A design
2. Add the `subIssuesSummary` field to the project items content fragment (confirm it works)
3. Build child state lookup map from the full items result
4. Add Zod parameter schema with all parameters from the issue spec
5. Add structural tests for filter behavior and `showChildren` flag
6. Verify `subIssues(first: 50)` works within the project items query (integration check)

## Files Affected

### Will Modify
- `plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts` — Add `ralph_hero__list_groups` tool registration
- `plugin/ralph-hero/mcp-server/src/__tests__/relationship-tools.test.ts` — Add structural tests for list_groups

### Will Read (Dependencies)
- `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts` — list_issues filter pattern, getFieldValue helper, paginateConnection usage, RawProjectItem type
- `plugin/ralph-hero/mcp-server/src/lib/pagination.ts` — paginateConnection signature
- `plugin/ralph-hero/mcp-server/src/lib/cache.ts` — ensureFieldCache, FieldOptionCache usage
- `plugin/ralph-hero/mcp-server/src/types.ts` — toolSuccess, toolError, resolveFullConfig
- `plugin/ralph-hero/mcp-server/src/lib/helpers.ts` — resolveFullConfig, resolveConfig helpers
- `plugin/ralph-hero/mcp-server/src/index.ts` — Tool registration call site (no changes needed)
