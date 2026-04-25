---
date: 2026-04-25
github_issue: 869
github_url: https://github.com/cdubiel08/ralph-hero/issues/869
status: complete
type: research
tags: [dashboard, blockedBy, graphql, mcp-server, health-warnings]
---

# Fix blockedBy hardcoded to [] in toDashboardItems() — wire real dependency data

## Prior Work

- builds_on:: [[2026-04-25-GH-0571-status-report-audit]]
- tensions:: None identified.

## Problem Statement

In `plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts`, `toDashboardItems()` at line 195 hardcodes `blockedBy: []` with a comment "blockedBy requires separate queries; omit for now". This means the "blocked" health warning in `pipeline_dashboard` **never fires** — every issue appears unblocked regardless of its actual dependency state.

The `detectHealthIssues()` function in `dashboard.ts` at lines 397-404 has fully correct logic for the "blocked" warning, iterating `item.blockedBy` to find open (non-Done, non-Canceled) blockers. The code path exists and is tested, but is dead because `blockedBy` is always `[]`.

## Current State Analysis

### Data Flow

```
DASHBOARD_ITEMS_QUERY (GraphQL) 
  → paginateConnection → RawDashboardItem[]
  → toDashboardItems() → DashboardItem[]
  → buildDashboard() → detectHealthIssues()
  → HealthWarning[type="blocked"]  ← NEVER FIRES
```

### DashboardItem.blockedBy Type

`dashboard.ts:41`:
```typescript
blockedBy: Array<{ number: number; workflowState: string | null }>;
```

The health check at `dashboard.ts:397-399`:
```typescript
const openBlockers = issue.blockedBy.filter(
  (b) => b.workflowState !== "Done" && b.workflowState !== "Canceled",
);
```

This requires `workflowState` (the project-level custom field) — not just GitHub's native `state` (OPEN/CLOSED). However, there is a clean mapping: a CLOSED GitHub issue is always in a terminal workflow state (Done or Canceled, per `WORKFLOW_STATE_TO_STATUS`). An OPEN GitHub issue may be in any non-terminal state.

**Key insight**: For the purpose of the "blocked" health check, we only need to know if the blocker is in a terminal state. `state === "CLOSED"` can be mapped to `workflowState: "Done"`, and `state === "OPEN"` to `workflowState: null`. This is correct for the health check's filter logic and avoids per-issue project field lookups.

### GitHub GraphQL — Available Fields

Two mechanisms exist for fetching "what blocks this issue":

**Option A — `trackedIssues` inline in DASHBOARD_ITEMS_QUERY:**
- `trackedIssues(first: N)` on an Issue node returns the issues this issue tracks (= its blockers)
- Used in `issue-tools.ts:622` for `get_issue`: `trackedIssues(first: 20) { nodes { number title state } }`
- Mapped at `issue-tools.ts:906`: `blockedBy: issue.trackedIssues.nodes.map(...)`
- This field is available on Issue nodes and works inside ProjectV2 content fragments
- Already partially scaffolded: `RawDashboardItem.content.trackedInIssues` exists at `dashboard-tools.ts:133` (note: this is the reverse — "blocking" direction; the correct field for blockers is `trackedIssues`)
- **Zero additional API requests** — data fetched inline with existing dashboard query
- **Cost**: adds N items × up to 10 blocker nodes per issue to the response payload

**Option B — `blockedBy(first: N)` native field (post-processing pass):**
- Native GitHub dependency field, used in `relationship-tools.ts:574` and `group-detection.ts:84`
- `blockedBy(first: 50) { nodes { id number title state repository { nameWithOwner } } }`
- Returns the true GitHub dependency relationship (set via "blocked by" UI)
- Requires **separate repo-scoped queries** per issue (not available from projectV2 `node` query context)
- The triage comment on this issue recommends Option B (post-processing pass), but this was written before recognizing that `trackedIssues` is available inline

### Comparison: trackedIssues vs blockedBy

| Aspect | `trackedIssues` (inline) | `blockedBy` (post-processing) |
|--------|--------------------------|-------------------------------|
| GitHub concept | Issues that "track" this issue = dependencies | Native dependency relationship |
| How set | Via "tracked by" tasklist feature | Via "blocked by" dependency UI |
| Available inline in ProjectV2 query | Yes | No (needs repo-scoped query) |
| Additional API calls | 0 | N (one per active issue) |
| Fields available | number, title, state | number, title, state, repository |
| Relationship accuracy | Tasklist-based (may differ from blockedBy) | Explicit dependency graph |

**Critical distinction**: `trackedIssues` and `blockedBy` are different GitHub features. `blockedBy` (native dependency) is what `add_dependency` / `remove_dependency` in `relationship-tools.ts` manipulates. `trackedIssues` is the tasklist "tracked by" relationship. In the ralph-hero workflow, all blocking relationships are set via the MCP tools which use the native `blockedBy` GraphQL field. Therefore, `blockedBy` is the accurate source.

### Performance Analysis for Option B

The dashboard fetches up to 500 items via `paginateConnection`. For a post-processing pass:
- We only need to check active (non-terminal) issues for blockers
- Active issues typically: Research Needed + Research in Progress + Ready for Plan + Plan in Progress + Plan in Review + In Progress + In Review
- For a typical small board (~30-50 active issues), 30-50 additional queries is significant
- Mitigation: batch using GraphQL aliases (like `batch_update` does) — N issues per request

**GraphQL alias batching pattern** (from `batch-tools.ts`):
```graphql
query {
  i1: repository(owner: $owner, name: $repo) {
    issue(number: 123) { trackedIssues(first: 10) { nodes { number state } } }
  }
  i2: repository(owner: $owner, name: $repo) {
    issue(number: 456) { trackedIssues(first: 10) { nodes { number state } } }
  }
}
```
This batches up to ~20-30 issues per GraphQL request — better but still 1-3 extra requests for a 50-issue board.

### Recommended Approach: Inline trackedIssues in DASHBOARD_ITEMS_QUERY

**Option A with correct field** — add `trackedIssues(first: 10)` to the Issue fragment in `DASHBOARD_ITEMS_QUERY`. This:
1. Uses zero additional API calls
2. Uses the correct field for "what blocks this issue" (consistent with `get_issue` mapping)
3. Requires updating `RawDashboardItem.content` type to include `trackedIssues`
4. Requires updating `toDashboardItems()` to map `trackedIssues.nodes` to `blockedBy`
5. Maps `state === "CLOSED"` → `workflowState: "Done"`, `state === "OPEN"` → `workflowState: null`

**Note**: The existing `trackedInIssues` field in `RawDashboardItem` (line 133) is the reverse direction (issues this one blocks = `blocking`). The correct field for blockers is `trackedIssues`. The `trackedInIssues` in `RawDashboardItem` was scaffolded but never included in the query or mapped — it should also be wired if we want to provide "blocking" data, but that's out of scope for this issue.

**Limit consideration**: Use `first: 10` for `trackedIssues` in the dashboard query. The `get_issue` tool uses `first: 20`, but for dashboard purposes 10 is sufficient (an issue blocked by >10 others is anomalous).

## Key Discoveries

1. **`toDashboardItems()` at `dashboard-tools.ts:195`** hardcodes `blockedBy: []` — confirmed bug.

2. **Health check logic is correct and tested** (`dashboard.ts:397-404`, `dashboard.test.ts:415-489`) — the "blocked" warning fires correctly when `blockedBy` is populated with proper data.

3. **Existing unit tests already cover the blocked warning path** via direct `PhaseSnapshot` construction — no need to add new "blocked fires" tests; only a test asserting that `toDashboardItems()` correctly maps `trackedIssues` to `blockedBy` is needed.

4. **`trackedIssues` is the correct inline field** for "what blocks this issue", consistent with how `get_issue` maps it (lines 906-910 in `issue-tools.ts`).

5. **`RawDashboardItem.content.trackedInIssues` exists at line 133** but is never fetched in `DASHBOARD_ITEMS_QUERY` — this is the reverse direction (blocking). The correct field for this issue is `trackedIssues`.

6. **State mapping**: `state === "CLOSED"` maps to `workflowState: "Done"` (terminal), `state === "OPEN"` maps to `workflowState: null` (non-terminal). This is conservative and correct for the health check.

7. **No performance regression**: Adding `trackedIssues(first: 10)` inline adds at most ~10 issue node references per item to the GraphQL response, but requires zero additional network requests.

8. **`pick_actionable_issue` uses `trackedIssues` for the same purpose** at `issue-tools.ts:1805-1810`, confirming this is the established pattern in the codebase.

## Potential Approaches

### Option A: Inline trackedIssues in DASHBOARD_ITEMS_QUERY (Recommended)

**Implementation**:
1. Add `trackedIssues(first: 10) { nodes { number state } }` to the `... on Issue` fragment in `DASHBOARD_ITEMS_QUERY`
2. Add `trackedIssues?: { nodes: Array<{ number: number; state: string }> }` to `RawDashboardItem.content` type
3. In `toDashboardItems()`, replace `blockedBy: []` with:
   ```typescript
   blockedBy: r.content.trackedIssues?.nodes?.map((n) => ({
     number: n.number,
     workflowState: n.state === "CLOSED" ? "Done" : null,
   })) ?? [],
   ```
4. Add unit test in `dashboard.test.ts` for `toDashboardItems()` asserting `trackedIssues` nodes are correctly mapped to `blockedBy`

**Pros**:
- Zero additional API calls
- Minimal code change (4 touch points)
- Consistent with how `get_issue` and `pick_actionable_issue` handle this
- No performance regression

**Cons**:
- `trackedIssues` (tasklist tracking) vs native `blockedBy` (dependency graph) — subtle semantic difference. In practice, ralph-hero uses both; native `blockedBy` is set by `add_dependency` tool; `trackedIssues` reflects the tasklist. If blocking is set via `add_dependency`, it shows up in `blockedBy` native field but may not appear in `trackedIssues`.

### Option B: Post-processing pass with native blockedBy queries

**Implementation**:
1. After `toDashboardItems()`, filter to active (non-terminal) issues
2. Batch fetch `blockedBy` via aliased GraphQL queries for active issues
3. Merge results back into `DashboardItem[]`

**Pros**:
- Uses the true native dependency relationship
- Matches what `list_dependencies` / `add_dependency` tools manage

**Cons**:
- 1-3 additional API requests per dashboard load (for 30-50 active issues)
- More complex implementation
- Rate limiter impact

### Option C: Hybrid — trackedIssues inline as best-effort

Use Option A as the implementation, document that it reflects "tracked by" relationships. Add a note in the dashboard output that blockedBy uses tasklist data. Since ralph-hero's `add_dependency` creates native blockedBy relationships (not tasklist-based), investigate whether they also appear in `trackedIssues`.

**Recommendation**: Option A, but validate during implementation that `add_dependency`-created relationships appear in `trackedIssues`. If they don't (confirmed native-only), fall back to a minimal post-processing pass using batched aliases for active issues only (typically <50 items, so 2-3 requests max).

## Risks

1. **trackedIssues vs blockedBy semantic mismatch**: If `add_dependency` creates native GitHub dependency links that don't appear in `trackedIssues`, Option A would silently not detect those blockers. Implementation should validate this.

2. **GraphQL query size**: Adding `trackedIssues(first: 10)` increases per-page payload. For 100-item pages, this adds up to 1000 nested node references. Monitor for timeout/size issues.

3. **Pagination**: The dashboard uses `paginateConnection` with `maxItems: 500`. The inline `trackedIssues` nodes don't need separate pagination (10 is sufficient) — they're fetched inline with each item page.

4. **State mapping accuracy**: Using `state === "CLOSED"` → `workflowState: "Done"` is conservative. A CLOSED GitHub issue could be "Canceled" rather than "Done", but both are terminal states and both are filtered identically in the health check. No functional difference.

## Recommended Next Steps

1. Add `trackedIssues(first: 10) { nodes { number state } }` to `DASHBOARD_ITEMS_QUERY` Issue fragment
2. Update `RawDashboardItem.content` type with `trackedIssues` field
3. Update `toDashboardItems()` to map `trackedIssues` to `blockedBy` using state mapping
4. During implementation, test against a real issue with a native `blockedBy` dependency (set via `add_dependency`) to verify `trackedIssues` captures it
5. If native `blockedBy` does NOT appear in `trackedIssues`, switch to the batched post-processing approach for active issues only
6. Add unit test in `toDashboardItems` describe block asserting correct mapping
7. Validate the "blocked" health warning fires end-to-end in a dashboard call

## Files Affected

### Will Modify
- `plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts` - Add `trackedIssues` to `DASHBOARD_ITEMS_QUERY` Issue fragment, update `RawDashboardItem.content` type, replace `blockedBy: []` with real mapping in `toDashboardItems()`
- `plugin/ralph-hero/mcp-server/src/__tests__/dashboard.test.ts` - Add unit test for `toDashboardItems` asserting `trackedIssues` nodes map correctly to `blockedBy`

### Will Read (Dependencies)
- `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts` - `DashboardItem.blockedBy` type and `detectHealthIssues` blocked-warning logic
- `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts` - `get_issue` and `pick_actionable_issue` patterns for trackedIssues mapping (lines 906, 1805-1810)
- `plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts` - Native `blockedBy(first: 50)` pattern for fallback reference
- `plugin/ralph-hero/mcp-server/src/lib/group-detection.ts` - Native `blockedBy(first: 20)` pattern for cross-reference
