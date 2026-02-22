---
date: 2026-02-22
github_issue: 330
github_url: https://github.com/cdubiel08/ralph-hero/issues/330
status: complete
type: research
---

# GH-330: Add Per-Stream Status to Pipeline Dashboard — Research Findings

## Problem Statement

The `pipeline_dashboard` tool groups GitHub issues by workflow state (phase-level view) but has no awareness of work streams. When a group is split into independent streams by `detect_work_streams`, the dashboard cannot show per-stream phase distribution or stream convergence health. GH-330 adds this capability as an optional overlay on the existing pipeline dashboard.

## Current State Analysis

### File Architecture

The dashboard system is split across two files:
- **`src/tools/dashboard-tools.ts`** — MCP tool registration, GraphQL query, `RawDashboardItem` → `DashboardItem` conversion (`toDashboardItems()`)
- **`src/lib/dashboard.ts`** — Pure aggregation, health detection, and formatting (`buildDashboard()`, `formatMarkdown()`, `formatAscii()`)

### `DashboardItem` Interface (lib/dashboard.ts:20–32)

```ts
export interface DashboardItem {
  number: number;
  title: string;
  updatedAt: string;
  closedAt: string | null;
  workflowState: string | null;
  priority: string | null;
  estimate: string | null;
  assignees: string[];
  blockedBy: Array<{ number: number; workflowState: string | null }>;
  projectNumber?: number;     // added for multi-project support
  projectTitle?: string;      // added for multi-project support
}
```

No stream fields exist. The dashboard fetches Workflow State, Priority, and Estimate from GitHub Projects V2 single-select fields via `DASHBOARD_ITEMS_QUERY` (`dashboard-tools.ts:193–236`). No parent/group relationship data is fetched in the bulk query.

### Stream Metadata Gap — Key Discovery

**Stream data is NOT stored in GitHub**: `detect_work_streams` is a pure TypeScript function that computes stream membership from caller-provided `IssueFileOwnership[]`. There are no GitHub Project custom fields for streams. The only places stream data exists are:
1. Task metadata in the SKILL.md team workflow (session-level, not persisted)
2. The `WorkStreamResult` returned by `detectWorkStreams()` (runtime computation)
3. Research documents (human-readable `## Files Affected` sections)

This means the dashboard cannot infer stream membership by querying GitHub. **Stream data must be provided by the caller as input**.

### Existing Optional Overlay Pattern

The dashboard already has a clean pattern for optional features:
- `includeMetrics: boolean` — activates `calculateMetrics()` from `lib/metrics.ts`
- `projectBreakdowns` — auto-activated when 2+ distinct `projectNumber` values are present
- `issuesPerPhase: number` — controls truncation, default 10

The stream overlay should follow the same pattern: caller provides `streams` (a `WorkStream[]`), dashboard adds the stream section when non-empty, otherwise renders identically.

### How `buildDashboard` / Formatters Work

- **`buildDashboard(items, config)`** (`lib/dashboard.ts:500`) takes `DashboardItem[]`, returns `DashboardData`
- **`DashboardData`** (`lib/dashboard.ts:82–92`): `{ generatedAt, totalIssues, phases: PhaseSnapshot[], health, archive, projectBreakdowns? }`
- **`formatMarkdown(data, issuesPerPhase)`** (`lib/dashboard.ts:579`): renders header → phase table → health → archive → per-project breakdown
- **`formatAscii(data)`** (`lib/dashboard.ts:707`): renders header → bar chart → health → archive → per-project breakdown

Both formatters append per-project sections at the end when `data.projectBreakdowns` is present. Stream section follows the same append-at-end pattern.

### Test Fixture Pattern (dashboard.test.ts)

```ts
const NOW = new Date("2026-02-16T12:00:00Z").getTime();
function makeItem(overrides?: Partial<DashboardItem>): DashboardItem { ... }
```

Tests are grouped by function in `describe` blocks. New stream tests will use `makeItem()` with issue numbers matching stream membership arrays.

## Recommended Approach

### 1. New `StreamDashboardSection` type in `lib/dashboard.ts`

```ts
export interface StreamPhaseCount {
  state: string;
  count: number;
}

export interface StreamSummary {
  streamId: string;          // e.g., "stream-42-44"
  primaryIssue: number;
  members: number[];
  phaseCounts: StreamPhaseCount[];   // count per workflow state for stream members
  convergencePercent: number;        // % of members at the modal (most common) state
  currentPhase: string;             // modal workflow state
}

export interface StreamDashboardSection {
  streams: StreamSummary[];
}
```

### 2. New `computeStreamSection()` pure function in `lib/dashboard.ts`

```ts
export function computeStreamSection(
  streams: WorkStream[],         // from detectWorkStreams()
  items: DashboardItem[],
): StreamDashboardSection
```

Algorithm:
1. Build a `Map<number, DashboardItem>` for O(1) lookup
2. For each `WorkStream`, filter `items` to `stream.issues` members
3. Count issues per `workflowState` (modal state = `currentPhase`)
4. `convergencePercent` = count of members at modal state / total members × 100
5. Sort streams by `primaryIssue` ascending

### 3. Add `streams?` field to `DashboardData`

```ts
export interface DashboardData {
  // ... existing fields ...
  streams?: StreamDashboardSection;  // present only when caller provides WorkStream[]
}
```

### 4. Extend `buildDashboard()` signature

```ts
export function buildDashboard(
  items: DashboardItem[],
  config: HealthConfig,
  streams?: WorkStream[],  // optional — from detectWorkStreams()
): DashboardData
```

When `streams && streams.length > 0`: call `computeStreamSection(streams, items)` and attach to result.

### 5. Extend `pipeline_dashboard` MCP tool input schema

Add optional `streams` parameter:
```ts
streams: z.array(z.object({
  id: z.string(),
  issues: z.array(z.number()),
  sharedFiles: z.array(z.string()),
  primaryIssue: z.number(),
})).optional().describe("Pre-computed stream assignments from detect_work_streams")
```

Pass `args.streams` through to `buildDashboard()`.

### 6. Extend `formatMarkdown()` and `formatAscii()`

Append a **Streams** section when `data.streams` is present:

**Markdown format**:
```
## Streams

| Stream | Phase | Members | Convergence |
|--------|-------|---------|-------------|
| stream-42-44 | In Progress | 2 | 100% |
| stream-43 | Plan in Review | 1 | 100% |
```

**ASCII format**:
```
--- Streams ---
stream-42-44   In Progress      2 members  100%
stream-43      Plan in Review   1 member   100%
```

### 7. Import `WorkStream` type

`lib/dashboard.ts` will need to import `WorkStream` from `../lib/work-stream-detection.js` (relative to `src/`). Since `dashboard.ts` is in `src/lib/`, the import is `./work-stream-detection.js`.

## File Ownership

| File | Change Type |
|------|-------------|
| `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts` | MODIFY — new types, `computeStreamSection()`, extend `buildDashboard()`, extend formatters |
| `plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts` | MODIFY — add `streams` param to tool schema, pass through to `buildDashboard()` |
| `plugin/ralph-hero/mcp-server/src/__tests__/dashboard.test.ts` | MODIFY — new `computeStreamSection` describe block + formatter stream section tests |

## Risks and Edge Cases

1. **Stream members not in dashboard**: Issues in `WorkStream.issues` may not appear in `DashboardItem[]` (e.g., if they're in a different project). Guard: filter stream members to those that exist in the `items` lookup map; skip members not found.
2. **Empty streams array**: `streams.length === 0` → skip section entirely (no regression).
3. **Single-member streams**: `convergencePercent = 100%` always (1 member = always converged). Display as singleton stream.
4. **Items with null workflowState**: Count as "Unknown" in phase counts. Modal state can be "Unknown".
5. **Import cycle**: `lib/dashboard.ts` importing from `lib/work-stream-detection.ts` — both are in `src/lib/`, no cycle risk.

## Acceptance Criteria Coverage

- **`npm run build` succeeds**: TypeScript types must be consistent across all three files
- **Dashboard with stream data shows Streams section**: Covered by `computeStreamSection()` + formatter changes
- **Stream section shows stream ID, phase, member count, convergence**: All four fields in `StreamSummary`
- **No regression without stream data**: Guard on `data.streams` presence in formatters
- **Existing tests pass; new test added**: New `computeStreamSection` describe block + formatter stream section tests

## Recommended Implementation Order

1. Add `StreamPhaseCount`, `StreamSummary`, `StreamDashboardSection` types to `lib/dashboard.ts`
2. Add `computeStreamSection()` function
3. Extend `DashboardData` with `streams?`
4. Extend `buildDashboard()` signature and body
5. Extend `formatMarkdown()` and `formatAscii()` with stream section
6. Extend tool schema in `dashboard-tools.ts`
7. Add tests for `computeStreamSection` and stream section rendering

## References

- Issue: https://github.com/cdubiel08/ralph-hero/issues/330
- Parent epic: https://github.com/cdubiel08/ralph-hero/issues/325
- Stream detection lib: `plugin/ralph-hero/mcp-server/src/lib/work-stream-detection.ts` (GH-327)
- Dashboard lib: `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts`
- Dashboard tool: `plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts`
- Test file: `plugin/ralph-hero/mcp-server/src/__tests__/dashboard.test.ts`
- Pattern reference: Multi-project breakdown pattern (`projectBreakdowns`) in `lib/dashboard.ts`
