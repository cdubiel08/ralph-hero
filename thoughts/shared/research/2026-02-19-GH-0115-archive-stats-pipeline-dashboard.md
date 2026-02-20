---
date: 2026-02-19
github_issue: 115
github_url: https://github.com/cdubiel08/ralph-hero/issues/115
status: complete
type: research
---

# Research: Add Archive Stats to pipeline_dashboard Output (GH-115)

## Problem Statement

The `pipeline_dashboard` tool currently provides a snapshot of active project items grouped by workflow state, health indicators, and formatted output (JSON/markdown/ASCII). However, it has no visibility into archived items. The goal is to extend the dashboard with an "Archive" section showing: total archived items, recent archival rate (7/30 days), and items eligible for archival (Done + stale).

## Parent Context

This is issue #115 under the **Epic: Project Hygiene & Smart Auto-Archive** (#96), alongside:
- #113: `bulk_archive` MCP tool (Todo)
- #114: `project_hygiene` reporting tool (Todo)
- #116: Integrate hygiene check into ralph-loop.sh triage phase (In Progress)

## Current State Analysis

### Dashboard Architecture

The dashboard implementation follows a clean separation of concerns:

1. **Data fetching** (`dashboard-tools.ts:294-302`): Uses `paginateConnection` to fetch all project items via the GraphQL `items` connection on `ProjectV2`. Currently fetches up to 500 items.

2. **Data transformation** (`dashboard-tools.ts:150-173`): `toDashboardItems()` converts raw GraphQL items to `DashboardItem[]`, extracting `workflowState`, `priority`, `estimate`, `updatedAt`, `closedAt`, and `assignees`.

3. **Pure aggregation** (`lib/dashboard.ts`): `buildDashboard()` orchestrates:
   - `aggregateByPhase()` -- groups items by workflow state, filters Done/Canceled to `doneWindowDays`
   - `detectHealthIssues()` -- scans for WIP, stuck, blocked, pipeline gap, lock collision, oversized warnings

4. **Formatting** (`lib/dashboard.ts:379-477`): `formatMarkdown()` and `formatAscii()` render the dashboard data.

### Key Types

```typescript
// lib/dashboard.ts
interface DashboardItem {
  number: number;
  title: string;
  updatedAt: string;
  closedAt: string | null;
  workflowState: string | null;
  priority: string | null;
  estimate: string | null;
  assignees: string[];
  blockedBy: Array<{ number: number; workflowState: string | null }>;
}

interface DashboardData {
  generatedAt: string;
  totalIssues: number;
  phases: PhaseSnapshot[];
  health: { ok: boolean; warnings: HealthWarning[] };
}
```

### GraphQL API Capabilities

**ProjectV2Item `isArchived` field**: The `ProjectV2Item` type has a boolean `isArchived` field (`ProjectV2Item.isArchived: Boolean!`). This field is available on every item returned by the `items` connection.

**Key finding -- archived items are excluded from default queries**: Testing confirms that the `items(first: N)` connection on `ProjectV2` does **not** return archived items. All 144 items in the current project returned `isArchived: false`. This means:

- **Cannot count archived items via the standard `items` connection.** The `totalCount` on the connection only counts non-archived items.
- The `items` connection accepts a `query: String` argument for filtering, but testing shows `query: "is:archived"` does not return archived items either -- it returns the same non-archived set.

**No dedicated archived items endpoint**: GitHub's GraphQL API does not provide a separate `archivedItems` connection or an `includeArchived: Boolean` argument on the `items` connection.

**Workaround approaches for archived item counts**:

1. **Track archival events locally**: Whenever `ralph_hero__archive_item` is called, record the archival in a local log or metadata store. The dashboard could read this log to compute stats.

2. **Use `node(id: ...)` queries for known archived items**: If we maintain a list of archived item IDs, we can query them individually via `node(id: ...)` and confirm `isArchived: true`. However, this doesn't help discover items archived via the GitHub UI.

3. **Infer from issue state**: Query closed issues from the repository (via `issues` connection with `states: CLOSED`) and cross-reference with project items. Issues that are closed but not in the project's active items were likely archived. This is imprecise.

4. **Compute "eligible for archive" from active items**: The dashboard can already identify Done/Canceled items that meet a staleness threshold. This is the most actionable metric and requires no additional API calls.

### Existing `archive_item` Tool

Located at `project-management-tools.ts:32-100`, uses `archiveProjectV2Item` / `unarchiveProjectV2Item` mutations. Does not currently track archival history.

### Sibling Issue Dependencies

- **#113 (`bulk_archive`)**: If `bulk_archive` is implemented first, it could maintain an archival log that feeds archive stats. However, #115 should not hard-depend on #113 being done first.
- **#114 (`project_hygiene`)**: The hygiene tool will generate its own report with eligible-for-archive items. The dashboard archive section should be complementary, not duplicative.

## Key Discoveries

### 1. Archive Count Cannot Be Queried Directly

The GitHub Projects V2 GraphQL API does not expose a count of archived items. The `items` connection excludes them, and there is no `archivedItems` connection. This is the most significant constraint for this feature.

**Impact**: The dashboard cannot show "total archived items" without maintaining its own tracking state. The acceptance criterion "Shows total archived" requires either an external tracking mechanism or a caveat that the count is approximate.

### 2. "Eligible for Archive" Is Fully Computable

The dashboard already fetches all active project items with `updatedAt` and `closedAt` timestamps, plus workflow state. Items in Done/Canceled states that have not been updated within a configurable window (e.g., 14 days) are candidates for archival. This requires zero additional API calls.

### 3. Dashboard Pure Functions Enable Clean Extension

The `lib/dashboard.ts` module is entirely pure functions with no side effects. Adding an archive stats section means:
- Extending `DashboardData` with an optional `archive` object
- Adding a new `computeArchiveStats()` pure function
- Extending `formatMarkdown()` and `formatAscii()` to render the archive section

### 4. `doneWindowDays` Already Partitions Done Items

The existing `aggregateByPhase()` function already filters Done/Canceled items to a time window. Items outside this window are silently dropped. The "eligible for archive" computation can reuse this partitioning logic -- items in Done/Canceled that are older than the `doneWindowDays` window are candidates.

### 5. API Cost Is Minimal

The dashboard already fetches all items. Computing archive eligibility requires no additional queries. The only new API cost would come from optional archive count tracking.

## Potential Approaches

### Approach A: Eligible-for-Archive Only (Recommended)

Add an "Archive Eligibility" section to the dashboard output that computes from already-fetched data:

```typescript
interface ArchiveStats {
  eligibleForArchive: number;        // Done/Canceled + stale
  eligibleItems: Array<{
    number: number;
    title: string;
    workflowState: string;
    staleDays: number;               // days since last update
  }>;
  recentlyCompleted: number;         // Done/Canceled within doneWindowDays
  archiveThresholdDays: number;      // configurable, default 14
}
```

**Pros**:
- Zero additional API calls
- Fully computable from existing data
- Actionable: tells users what they should archive
- Clean pure function implementation

**Cons**:
- Cannot show "total archived" count
- No archival rate (7/30 day trend)

**Implementation effort**: XS -- extends existing pure functions, adds ~50 lines to `lib/dashboard.ts`, ~20 lines to formatters, ~15 lines to tool registration (new `archiveThresholdDays` parameter).

### Approach B: Full Stats with Local Tracking

Maintain a local JSON file (or in-memory per-session log) that records archival events from `archive_item` and `bulk_archive` tools. Dashboard reads this log for historical stats.

```typescript
interface ArchiveStats {
  totalArchived: number;             // from local log
  archivedLast7Days: number;         // from local log
  archivedLast30Days: number;        // from local log
  eligibleForArchive: number;        // computed from items
  eligibleItems: Array<{ ... }>;
  archiveThresholdDays: number;
}
```

**Pros**:
- Full stats (total, rate, eligible)
- Matches all acceptance criteria literally

**Cons**:
- Requires persistent state across sessions
- Only tracks Ralph-initiated archives, not UI archives
- Adds complexity (file I/O or state management)
- MCP servers are typically stateless

**Implementation effort**: S -- requires adding a persistence mechanism to the MCP server.

### Approach C: Inference from Repository Issues

Query all closed issues from the repository, compare against active project items, and infer archived count from the difference.

**Pros**:
- No local state needed
- Catches UI-initiated archives

**Cons**:
- Imprecise: issues can be closed without being in the project, or removed (not archived)
- Additional API calls for closed issues
- Complex reconciliation logic

**Implementation effort**: M -- requires new query + reconciliation, fragile assumptions.

## Risks and Considerations

1. **API limitation on archived item counts**: The most significant risk is that GitHub may never expose archived item counts via the API. Approach A gracefully handles this by focusing on actionable data (eligible items) rather than historical counts.

2. **Acceptance criteria gap**: The issue specifies "Shows total archived and recent archival count." Approach A does not satisfy this literally. The issue should be updated to reflect the API limitation, or Approach B should be used if exact counts are required.

3. **Consistency with #114 hygiene tool**: The `project_hygiene` tool (#114) will also identify items eligible for archival. The dashboard's archive section should use the same criteria (Done/Canceled + staleness threshold) to avoid conflicting recommendations.

4. **Dashboard API call budget**: The acceptance criterion "Does not significantly increase API calls" is naturally satisfied by Approach A (zero additional calls) and is a concern for Approach C.

5. **Archive threshold default**: The issue mentions "Done + stale" but does not define "stale." A sensible default is 14 days (matching GitHub's built-in auto-archive default filter `updated:<@today-14d`). This should be configurable via a new `archiveThresholdDays` parameter.

## Recommended Approach

**Approach A (Eligible-for-Archive Only)** is recommended because:

1. It requires zero additional API calls (satisfies the API budget acceptance criterion).
2. It provides the most actionable information (what to archive now).
3. It is a clean extension of the existing pure-function architecture.
4. It does not require persistent state in the MCP server.
5. Implementation is XS effort.

The "total archived" and "archival rate" metrics should be deferred to when `bulk_archive` (#113) is implemented with tracking capabilities, or if GitHub's API adds an archived items query endpoint.

**Suggested acceptance criteria update**:
- Dashboard includes "Archive Eligibility" section
- Shows count and list of items eligible for archival (Done/Canceled + stale)
- Shows recently completed items count (within doneWindowDays)
- Configurable `archiveThresholdDays` parameter (default: 14)
- Zero additional API calls
- Tests for new pure functions

## Implementation Outline

### Files to modify

1. **`plugin/ralph-hero/mcp-server/src/lib/dashboard.ts`**:
   - Add `ArchiveStats` interface
   - Add `computeArchiveStats(items, now, archiveThresholdDays, doneWindowDays)` pure function
   - Extend `DashboardData` with optional `archive?: ArchiveStats`
   - Extend `buildDashboard()` signature with `archiveThresholdDays` parameter
   - Extend `formatMarkdown()` to render archive section
   - Extend `formatAscii()` to render archive section

2. **`plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts`**:
   - Add `archiveThresholdDays` Zod parameter (default: 14)
   - Pass through to `buildDashboard()`

3. **`plugin/ralph-hero/mcp-server/src/__tests__/dashboard.test.ts`**:
   - Add tests for `computeArchiveStats()`
   - Add tests for archive section in markdown/ASCII formatters
   - Add integration test for `buildDashboard()` with archive stats

### Data flow

```
dashboard-tools.ts: fetch items (existing)
                    |
                    v
dashboard.ts: buildDashboard(items, config, now)
              |
              +-> aggregateByPhase(items, now, config)     [existing]
              +-> detectHealthIssues(phases, config)        [existing]
              +-> computeArchiveStats(items, now, threshold, doneWindow)  [NEW]
              |
              v
             DashboardData { phases, health, archive }
              |
              v
formatMarkdown / formatAscii  [extended with archive section]
```

### Example output (markdown)

```markdown
## Archive Eligibility

**Eligible for archive**: 3 items (stale > 14 days in Done/Canceled)
**Recently completed**: 5 items (within 7 days)

| # | Title | State | Stale Days |
|---|-------|-------|------------|
| #42 | Fix login timeout | Done | 21 |
| #38 | Update dependencies | Done | 18 |
| #35 | Remove deprecated API | Canceled | 16 |
```
