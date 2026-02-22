---
date: 2026-02-22
status: draft
github_issues: [330]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/330
primary_issue: 330
---

# Per-Stream Pipeline Dashboard Status - Atomic Implementation Plan

## Overview
Single issue for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-330 | Add per-stream status to pipeline dashboard | S |

## Current State Analysis

The pipeline dashboard (`lib/dashboard.ts` + `tools/dashboard-tools.ts`) aggregates all project items by workflow state into `PhaseSnapshot[]`, detects health issues, and formats output as JSON, markdown, or ASCII. It already supports an optional multi-project overlay via `projectBreakdowns` (auto-activated when 2+ `projectNumber` values exist).

Stream data is NOT stored in GitHub — `detectWorkStreams()` is a pure runtime computation. The dashboard must accept pre-computed `WorkStream[]` as an optional input parameter, following the same overlay pattern as `projectBreakdowns` and `includeMetrics`.

Key file references:
- `DashboardItem` interface: `lib/dashboard.ts:20–32`
- `DashboardData` interface: `lib/dashboard.ts:82–92`
- `buildDashboard()`: `lib/dashboard.ts:500–570`
- `formatMarkdown()`: `lib/dashboard.ts:579–702`
- `formatAscii()`: `lib/dashboard.ts:707–790`
- Tool registration: `dashboard-tools.ts:248–455`
- `WorkStream` type: `lib/work-stream-detection.ts:11–16`

## Desired End State
### Verification
- [ ] `cd plugin/ralph-hero/mcp-server && npm run build` succeeds
- [ ] `cd plugin/ralph-hero/mcp-server && npm test` passes with all existing + new tests
- [ ] Dashboard with `streams` input shows "Streams" section in markdown and ASCII
- [ ] Dashboard without `streams` input renders identically (no regression)
- [ ] `computeStreamSection()` correctly computes convergence % and modal phase

## What We're NOT Doing
- No new MCP tool (that's GH-332 `detect_stream_positions`)
- No GitHub API changes — streams are caller-provided
- No SKILL.md changes — covered by GH-326 and GH-328
- No custom GitHub Project field for streams

## Implementation Approach

Follow the existing `projectBreakdowns` optional overlay pattern: add optional `streams` field to `DashboardData`, compute in `buildDashboard()` when provided, render in both formatters when present. Add pure `computeStreamSection()` function and corresponding tests.

---

## Phase 1: GH-330 — Per-Stream Dashboard Status
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/330 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-22-GH-0330-per-stream-dashboard-status.md

### Changes Required

#### 1. Add stream types to `lib/dashboard.ts`
**File**: `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts`
**Location**: After `ProjectBreakdown` interface (line 80), before `DashboardData` (line 82)

**Changes**: Add new interfaces:

```typescript
export interface StreamPhaseCount {
  state: string;
  count: number;
}

export interface StreamSummary {
  streamId: string;           // e.g., "stream-42-44"
  primaryIssue: number;
  members: number[];          // issue numbers in this stream
  currentPhase: string;       // modal workflow state
  phaseCounts: StreamPhaseCount[];  // count per state for stream members
  convergencePercent: number; // % at modal state, rounded to integer
}

export interface StreamDashboardSection {
  streams: StreamSummary[];
}
```

#### 2. Add `streams?` field to `DashboardData`
**File**: `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts`
**Location**: `DashboardData` interface (line 82–92)

**Changes**: Add after `projectBreakdowns?`:

```typescript
streams?: StreamDashboardSection;
```

#### 3. Add import for `WorkStream` type
**File**: `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts`
**Location**: After existing imports (line 13)

**Changes**: Add:

```typescript
import type { WorkStream } from "./work-stream-detection.js";
```

#### 4. Add `computeStreamSection()` pure function
**File**: `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts`
**Location**: Before `buildDashboard()` (before line 492)

**Changes**: New exported function:

```typescript
export function computeStreamSection(
  streams: WorkStream[],
  items: DashboardItem[],
): StreamDashboardSection {
  const itemMap = new Map<number, DashboardItem>();
  for (const item of items) {
    itemMap.set(item.number, item);
  }

  const summaries: StreamSummary[] = [];

  for (const stream of streams) {
    // Filter to stream members that exist in items
    const memberItems = stream.issues
      .map((n) => itemMap.get(n))
      .filter((item): item is DashboardItem => item !== undefined);

    if (memberItems.length === 0) continue;

    // Count per workflow state
    const stateCounts = new Map<string, number>();
    for (const item of memberItems) {
      const state = item.workflowState ?? "Unknown";
      stateCounts.set(state, (stateCounts.get(state) ?? 0) + 1);
    }

    const phaseCounts: StreamPhaseCount[] = [];
    let modalState = "Unknown";
    let modalCount = 0;
    for (const [state, count] of stateCounts) {
      phaseCounts.push({ state, count });
      if (count > modalCount) {
        modalCount = count;
        modalState = state;
      }
    }

    // Sort phaseCounts by STATE_ORDER for consistent output
    const stateIndex = (s: string) => {
      const idx = STATE_ORDER.indexOf(s);
      return idx >= 0 ? idx : STATE_ORDER.length;
    };
    phaseCounts.sort((a, b) => stateIndex(a.state) - stateIndex(b.state));

    const convergencePercent = Math.round(
      (modalCount / memberItems.length) * 100,
    );

    summaries.push({
      streamId: stream.id,
      primaryIssue: stream.primaryIssue,
      members: stream.issues,
      currentPhase: modalState,
      phaseCounts,
      convergencePercent,
    });
  }

  // Sort by primaryIssue ascending
  summaries.sort((a, b) => a.primaryIssue - b.primaryIssue);

  return { streams: summaries };
}
```

#### 5. Extend `buildDashboard()` signature and body
**File**: `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts`
**Location**: `buildDashboard()` function (line 500)

**Changes**:

1. Add optional `streams` parameter:
   ```typescript
   export function buildDashboard(
     items: DashboardItem[],
     config: HealthConfig = DEFAULT_HEALTH_CONFIG,
     now: number = Date.now(),
     streams?: WorkStream[],  // NEW
   ): DashboardData {
   ```

2. Before the `return` statement (line 559), add:
   ```typescript
   // Stream section (only when caller provides stream data)
   let streamSection: StreamDashboardSection | undefined;
   if (streams && streams.length > 0) {
     streamSection = computeStreamSection(streams, items);
   }
   ```

3. In the return object, add:
   ```typescript
   ...(streamSection ? { streams: streamSection } : {}),
   ```

#### 6. Extend `formatMarkdown()` with streams section
**File**: `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts`
**Location**: At end of `formatMarkdown()`, before `return lines.join("\n")` (line 701)

**Changes**: Add after the per-project breakdown block (after line 699):

```typescript
// Stream section
if (data.streams && data.streams.streams.length > 0) {
  lines.push("");
  lines.push("## Streams");
  lines.push("");
  lines.push("| Stream | Phase | Members | Convergence |");
  lines.push("|--------|-------|---------|-------------|");
  for (const s of data.streams.streams) {
    lines.push(
      `| ${s.streamId} | ${s.currentPhase} | ${s.members.length} | ${s.convergencePercent}% |`,
    );
  }
}
```

#### 7. Extend `formatAscii()` with streams section
**File**: `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts`
**Location**: At end of `formatAscii()`, before `return lines.join("\n")` (line 789)

**Changes**: Add after the per-project breakdown block (after line 787):

```typescript
// Stream section
if (data.streams && data.streams.streams.length > 0) {
  lines.push("");
  lines.push("--- Streams ---");
  for (const s of data.streams.streams) {
    const memberLabel = s.members.length === 1 ? "member" : "members";
    lines.push(
      `${s.streamId.padEnd(20)} ${s.currentPhase.padEnd(20)} ${s.members.length} ${memberLabel}  ${s.convergencePercent}%`,
    );
  }
}
```

#### 8. Extend tool schema in `dashboard-tools.ts`
**File**: `plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts`
**Location**: After `archiveThresholdDays` param (line 326), before closing `}` of schema (line 327)

**Changes**: Add new optional parameter:

```typescript
streams: z
  .array(
    z.object({
      id: z.string(),
      issues: z.array(z.number()),
      sharedFiles: z.array(z.string()),
      primaryIssue: z.number(),
    }),
  )
  .optional()
  .describe(
    "Pre-computed stream assignments from detect_work_streams. When provided, dashboard includes a Streams section.",
  ),
```

#### 9. Pass streams through to `buildDashboard()` in tool handler
**File**: `plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts`
**Location**: `buildDashboard()` call (line 405)

**Changes**: Pass `args.streams` as fourth argument:

```typescript
const dashboard = buildDashboard(allItems, healthConfig, undefined, args.streams);
```

Note: `now` parameter uses default (`Date.now()`), so pass `undefined` explicitly.

#### 10. Add tests for stream section
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/dashboard.test.ts`
**Location**: After the last test suite (end of file)

**Changes**: Add new describe blocks:

```typescript
describe("computeStreamSection", () => {
  it("computes convergence for fully-converged stream", () => {
    const streams: WorkStream[] = [
      { id: "stream-42-44", issues: [42, 44], sharedFiles: ["src/a.ts"], primaryIssue: 42 },
    ];
    const items = [
      makeItem({ number: 42, workflowState: "In Progress" }),
      makeItem({ number: 44, workflowState: "In Progress" }),
    ];
    const result = computeStreamSection(streams, items);
    expect(result.streams).toHaveLength(1);
    expect(result.streams[0].streamId).toBe("stream-42-44");
    expect(result.streams[0].currentPhase).toBe("In Progress");
    expect(result.streams[0].convergencePercent).toBe(100);
    expect(result.streams[0].members).toEqual([42, 44]);
  });

  it("computes convergence for partially-converged stream", () => {
    const streams: WorkStream[] = [
      { id: "stream-42-43-44", issues: [42, 43, 44], sharedFiles: [], primaryIssue: 42 },
    ];
    const items = [
      makeItem({ number: 42, workflowState: "In Progress" }),
      makeItem({ number: 43, workflowState: "In Progress" }),
      makeItem({ number: 44, workflowState: "Plan in Review" }),
    ];
    const result = computeStreamSection(streams, items);
    expect(result.streams[0].convergencePercent).toBe(67);
    expect(result.streams[0].currentPhase).toBe("In Progress");
  });

  it("skips stream members not in items", () => {
    const streams: WorkStream[] = [
      { id: "stream-42-44", issues: [42, 44], sharedFiles: [], primaryIssue: 42 },
    ];
    const items = [makeItem({ number: 42, workflowState: "In Progress" })];
    const result = computeStreamSection(streams, items);
    expect(result.streams[0].members).toEqual([42, 44]);
    expect(result.streams[0].convergencePercent).toBe(100);
  });

  it("returns empty streams for empty input", () => {
    const result = computeStreamSection([], []);
    expect(result.streams).toEqual([]);
  });

  it("sorts streams by primaryIssue ascending", () => {
    const streams: WorkStream[] = [
      { id: "stream-44", issues: [44], sharedFiles: [], primaryIssue: 44 },
      { id: "stream-42", issues: [42], sharedFiles: [], primaryIssue: 42 },
    ];
    const items = [
      makeItem({ number: 42, workflowState: "Backlog" }),
      makeItem({ number: 44, workflowState: "Backlog" }),
    ];
    const result = computeStreamSection(streams, items);
    expect(result.streams[0].streamId).toBe("stream-42");
    expect(result.streams[1].streamId).toBe("stream-44");
  });
});

describe("formatMarkdown stream section", () => {
  it("renders stream table when streams present", () => {
    const data: DashboardData = {
      ...buildDashboard([]),
      streams: {
        streams: [
          {
            streamId: "stream-42-44",
            primaryIssue: 42,
            members: [42, 44],
            currentPhase: "In Progress",
            phaseCounts: [{ state: "In Progress", count: 2 }],
            convergencePercent: 100,
          },
        ],
      },
    };
    const md = formatMarkdown(data);
    expect(md).toContain("## Streams");
    expect(md).toContain("stream-42-44");
    expect(md).toContain("In Progress");
    expect(md).toContain("100%");
  });

  it("omits stream section when no streams", () => {
    const data = buildDashboard([]);
    const md = formatMarkdown(data);
    expect(md).not.toContain("## Streams");
  });
});

describe("formatAscii stream section", () => {
  it("renders stream section when streams present", () => {
    const data: DashboardData = {
      ...buildDashboard([]),
      streams: {
        streams: [
          {
            streamId: "stream-42-44",
            primaryIssue: 42,
            members: [42, 44],
            currentPhase: "In Progress",
            phaseCounts: [{ state: "In Progress", count: 2 }],
            convergencePercent: 100,
          },
        ],
      },
    };
    const ascii = formatAscii(data);
    expect(ascii).toContain("--- Streams ---");
    expect(ascii).toContain("stream-42-44");
    expect(ascii).toContain("100%");
  });

  it("omits stream section when no streams", () => {
    const data = buildDashboard([]);
    const ascii = formatAscii(data);
    expect(ascii).not.toContain("Streams");
  });
});

describe("buildDashboard with streams", () => {
  it("includes stream section when streams provided", () => {
    const items = [
      makeItem({ number: 42, workflowState: "In Progress" }),
      makeItem({ number: 44, workflowState: "In Progress" }),
    ];
    const streams: WorkStream[] = [
      { id: "stream-42-44", issues: [42, 44], sharedFiles: ["a.ts"], primaryIssue: 42 },
    ];
    const data = buildDashboard(items, undefined, NOW, streams);
    expect(data.streams).toBeDefined();
    expect(data.streams!.streams).toHaveLength(1);
    expect(data.streams!.streams[0].convergencePercent).toBe(100);
  });

  it("omits stream section when no streams provided", () => {
    const data = buildDashboard([makeItem()], undefined, NOW);
    expect(data.streams).toBeUndefined();
  });
});
```

Import additions at top of test file:
```typescript
import { computeStreamSection } from "../lib/dashboard.js";
import type { WorkStream } from "../lib/work-stream-detection.js";
```

### File Ownership Summary

| File | Change Type |
|------|------------|
| `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts` | MODIFY — new types (StreamPhaseCount, StreamSummary, StreamDashboardSection), import WorkStream, computeStreamSection(), extend DashboardData, extend buildDashboard(), extend formatMarkdown(), extend formatAscii() |
| `plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts` | MODIFY — add `streams` Zod param, pass through to buildDashboard() |
| `plugin/ralph-hero/mcp-server/src/__tests__/dashboard.test.ts` | MODIFY — import computeStreamSection + WorkStream, 4 new describe blocks (~12 test cases) |

### Success Criteria
- [ ] Automated: `cd plugin/ralph-hero/mcp-server && npm run build` succeeds
- [ ] Automated: `cd plugin/ralph-hero/mcp-server && npm test` passes with all existing + ~12 new tests
- [ ] Manual: `computeStreamSection()` returns correct convergence % (100% for fully converged, 67% for 2-of-3)
- [ ] Manual: `formatMarkdown()` renders "## Streams" table with stream ID, phase, members, convergence
- [ ] Manual: `formatAscii()` renders "--- Streams ---" section with aligned columns
- [ ] Manual: Dashboard without `streams` input produces identical output to current (no regression)
- [ ] Manual: `pipeline_dashboard` tool accepts optional `streams` array matching `WorkStream` shape

---

## Integration Testing
- [ ] `cd plugin/ralph-hero/mcp-server && npm run build` passes
- [ ] `cd plugin/ralph-hero/mcp-server && npm test` passes with all existing + new tests
- [ ] No regressions in existing dashboard test suites (77 existing tests)

## References
- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-22-GH-0330-per-stream-dashboard-status.md
- Parent plan (Phase 4): https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-02-21-work-stream-parallelization.md
- Pattern reference: `projectBreakdowns` overlay in `lib/dashboard.ts` (multi-project support)
- Stream types: `plugin/ralph-hero/mcp-server/src/lib/work-stream-detection.ts` (GH-327)
- Parent epic: https://github.com/cdubiel08/ralph-hero/issues/325
- Sibling (done): https://github.com/cdubiel08/ralph-hero/issues/326 (Section 3.2 stream detection)
- Sibling (done): https://github.com/cdubiel08/ralph-hero/issues/328 (Sections 4.2/4.4 stream dispatch)
