---
date: 2026-03-02
status: draft
github_issues: [487]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/487
primary_issue: 487
---

# Enhance computeSuggestedRoster() for Stream-Based Builder Scaling - Atomic Implementation Plan

## Overview
1 issue for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-487 | enhance computeSuggestedRoster() to scale builder count from independent stream count | XS |

## Current State Analysis

[`computeSuggestedRoster()`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts#L392-L425) uses a static heuristic for builder scaling: `largeSized.length >= 5 ? 2 : 1`. This is disconnected from actual parallelism — it doesn't know how many independent work streams exist. The `detect_stream_positions` tool response also lacks a top-level aggregate `suggestedRoster`, forcing callers (ralph-team) to aggregate per-stream rosters manually.

The builder count should be driven by the number of independent work streams detected by `detectWorkStreams()`, capped at 3: `Math.min(streamCount || 1, 3)`.

## Desired End State

### Verification
- [x] `computeSuggestedRoster()` uses stream count (when available) for builder scaling instead of the M/L estimate heuristic
- [x] `detect_stream_positions` response includes a top-level `suggestedRoster` field
- [x] All existing tests pass unchanged
- [x] 4 new tests verify stream-based builder scaling (1, 2, 4 streams, and no-stream fallback)
- [x] No breaking changes: callers that omit stream data get `builder = 1` (same as before for typical single-stream cases)

## What We're NOT Doing
- Changing `work-stream-detection.ts` — no changes needed to stream detection itself
- Changing `ralph-team/SKILL.md` — handled by sibling issue #488
- Modifying analyst or integrator scaling formulas — those remain unchanged
- Changing the `pipeline_dashboard` tool response — only `detect_stream_positions` gets the aggregate roster

## Implementation Approach

Thread stream count through the existing `DetectionOptions` interface (already flows through the call chain: `detectStreamPipelinePositions` → `detectPipelinePosition` → `buildResult` → `computeSuggestedRoster`). Then compute an aggregate roster in the `detect_stream_positions` tool handler.

Changes flow in three layers:
1. **Library layer** (`pipeline-detection.ts`): Add `streamCount` to options, update builder formula
2. **Tool layer** (`dashboard-tools.ts`): Add top-level aggregate `suggestedRoster` to tool response
3. **Test layer** (`pipeline-detection.test.ts`): Add stream-based builder scaling tests

---

## Phase 1: GH-487 — Stream-Based Builder Scaling
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/487 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-02-GH-0487-compute-suggested-roster-stream-scaling.md

### Changes Required

#### 1. Add `streamCount` to `DetectionOptions`
**File**: [`plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts:28-31`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts#L28-L31)
**Changes**: Add optional `streamCount` field to the existing `DetectionOptions` interface:
```typescript
export interface DetectionOptions {
  /** When true, "In Review" maps to INTEGRATE instead of TERMINAL */
  autoMode?: boolean;
  /** Total number of independent work streams (drives builder scaling) */
  streamCount?: number;
}
```

#### 2. Update `SuggestedRoster` comment
**File**: [`plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts:48-52`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts#L48-L52)
**Changes**: Update the inline comment on `builder`:
```typescript
export interface SuggestedRoster {
  analyst: number;    // 0-3: 1 for single issue; 2 for 2-5 needing research; 3 for 6+
  builder: number;    // 1-3: 1 per independent stream, capped at 3; falls back to 1 when no stream data
  integrator: number; // 1-2: 1 default; 2 if 5+ issues
}
```

#### 3. Update `computeSuggestedRoster()` builder formula
**File**: [`plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts:392-425`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts#L392-L425)
**Changes**: Add optional `streamCount` parameter and replace the builder heuristic:
```typescript
function computeSuggestedRoster(
  phase: PipelinePhase,
  issues: IssueState[],
  streamCount?: number,
): SuggestedRoster {
  // TERMINAL: no workers needed
  if (phase === 'TERMINAL') {
    return { analyst: 0, builder: 0, integrator: 0 };
  }
  // INTEGRATE: only integrator needed
  if (phase === 'INTEGRATE') {
    return { analyst: 0, builder: 0, integrator: 1 };
  }

  // Phase-aware: if past research, analyst = 0
  const needsResearch = issues.filter(i =>
    ['Research Needed', 'Research in Progress'].includes(i.workflowState)
  );
  let analyst = 0;
  if (phase === 'RESEARCH' || phase === 'SPLIT' || phase === 'TRIAGE' || phase === 'PLAN') {
    analyst = needsResearch.length <= 1 ? 1
      : needsResearch.length <= 5 ? 2
      : 3;
  }

  // Builder scaling: 1 per independent stream, capped at 3
  const builder = Math.min(streamCount || 1, 3);

  const integrator = issues.length >= 5 ? 2 : 1;

  return { analyst, builder, integrator };
}
```

Key change: Remove the `largeSized` filter and replace `const builder = largeSized.length >= 5 ? 2 : 1` with `const builder = Math.min(streamCount || 1, 3)`. When `streamCount` is `undefined` or `0`, the `||` fallback gives `1` (backwards-compatible).

#### 4. Thread `streamCount` through `buildResult()`
**File**: [`plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts:427-456`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts#L427-L456)
**Changes**: Add optional `streamCount` parameter and pass it to `computeSuggestedRoster`:
```typescript
function buildResult(
  phase: PipelinePhase,
  reason: string,
  issues: IssueState[],
  isGroup: boolean,
  groupPrimary: number | null,
  convergence: Omit<ConvergenceInfo, "recommendation">,
  streamCount?: number,
): PipelinePosition {
  // ... (recommendation logic unchanged)

  const suggestedRoster = computeSuggestedRoster(phase, issues, streamCount);
  // ... (return unchanged)
}
```

#### 5. Pass `options.streamCount` from `detectPipelinePosition` to `buildResult`
**File**: [`plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts:120-357`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts#L120-L357)
**Changes**: Every call to `buildResult(...)` within `detectPipelinePosition` needs the `streamCount` appended as the final argument. Search for all `buildResult(` calls and add `options.streamCount` as the last argument. There are multiple call sites — each gets the same addition.

Example (line 127-135, empty issues case):
```typescript
// Before:
return buildResult('TERMINAL', 'No issues', [], isGroup, groupPrimary,
  { required: false, met: true, blocking: [] });

// After:
return buildResult('TERMINAL', 'No issues', [], isGroup, groupPrimary,
  { required: false, met: true, blocking: [] }, options.streamCount);
```

Apply the same pattern to ALL `buildResult(...)` calls in the function. The `options` variable is already in scope at every call site.

#### 6. Pass `streams.length` via options in `detectStreamPipelinePositions`
**File**: [`plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts:363-386`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts#L363-L386)
**Changes**: When calling `detectPipelinePosition` for each stream, inject `streamCount` into the options:
```typescript
return {
  streamId: stream.id,
  issues: filteredIssues,
  position: detectPipelinePosition(filteredIssues, isGroup, groupPrimary, {
    ...options,
    streamCount: streams.length,
  }),
};
```

This ensures per-stream `suggestedRoster.builder` values reflect total stream count.

#### 7. Add aggregate `suggestedRoster` to `detect_stream_positions` tool response
**File**: [`plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts:535-540`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts#L535-L540)
**Changes**: Compute aggregate roster from stream positions and add to response:
```typescript
// After line 533 (const positions = detectStreamPipelinePositions(...))

// Aggregate roster: max analyst/integrator across streams, stream-count-based builder
const suggestedRoster = positions.length > 0
  ? {
      analyst: Math.max(...positions.map(p => p.position.suggestedRoster.analyst)),
      builder: Math.min(streamResult.totalStreams, 3),
      integrator: Math.max(...positions.map(p => p.position.suggestedRoster.integrator)),
    }
  : { analyst: 0, builder: 0, integrator: 0 };

return toolSuccess({
  streams: positions,
  totalStreams: streamResult.totalStreams,
  totalIssues: streamResult.totalIssues,
  rationale: streamResult.rationale,
  suggestedRoster,
});
```

The aggregate uses `Math.max` across per-stream analyst and integrator values (the highest demand from any stream), and `Math.min(totalStreams, 3)` for builder (one per stream, capped).

#### 8. Add stream-based builder scaling tests
**File**: [`plugin/ralph-hero/mcp-server/src/__tests__/pipeline-detection.test.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/__tests__/pipeline-detection.test.ts)
**Changes**: Add a new `describe` block after the existing roster tests (after line ~530):

```typescript
describe("stream-based builder scaling", () => {
  it("1 stream -> builder = 1", () => {
    const streams = [{ id: "s-1", issues: [1], sharedFiles: [], primaryIssue: 1 }];
    const states = [makeIssue(1, "Research Needed")];
    const results = detectStreamPipelinePositions(streams, states);
    expect(results[0].position.suggestedRoster.builder).toBe(1);
  });

  it("2 streams -> builder = 2", () => {
    const streams = [
      { id: "s-1", issues: [1], sharedFiles: [], primaryIssue: 1 },
      { id: "s-2", issues: [2], sharedFiles: [], primaryIssue: 2 },
    ];
    const states = [makeIssue(1, "Research Needed"), makeIssue(2, "Research Needed")];
    const results = detectStreamPipelinePositions(streams, states);
    expect(results[0].position.suggestedRoster.builder).toBe(2);
    expect(results[1].position.suggestedRoster.builder).toBe(2);
  });

  it("4 streams -> builder = 3 (capped)", () => {
    const streams = [
      { id: "s-1", issues: [1], sharedFiles: [], primaryIssue: 1 },
      { id: "s-2", issues: [2], sharedFiles: [], primaryIssue: 2 },
      { id: "s-3", issues: [3], sharedFiles: [], primaryIssue: 3 },
      { id: "s-4", issues: [4], sharedFiles: [], primaryIssue: 4 },
    ];
    const states = [
      makeIssue(1, "Research Needed"), makeIssue(2, "Research Needed"),
      makeIssue(3, "Research Needed"), makeIssue(4, "Research Needed"),
    ];
    const results = detectStreamPipelinePositions(streams, states);
    expect(results[0].position.suggestedRoster.builder).toBe(3);
  });

  it("no stream context (single-issue path) -> builder = 1 (fallback)", () => {
    const result = detectSingle(makeIssue(1, "Research Needed"));
    expect(result.suggestedRoster.builder).toBe(1);
  });
});
```

### Success Criteria
- [x] Automated: `cd plugin/ralph-hero/mcp-server && npm test` — all existing + 4 new tests pass
- [x] Automated: `grep -c 'largeSized' plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts` returns 0 (old heuristic removed)
- [x] Automated: `grep -c 'streamCount' plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts` returns 4+ (new param threaded)
- [ ] Manual: Verify `detect_stream_positions` response includes top-level `suggestedRoster` with `builder = min(totalStreams, 3)`

---

## Integration Testing
- [ ] Run `npm test` — all 30+ test files pass (no regressions)
- [ ] Run `npm run build` — TypeScript compilation succeeds
- [ ] Call `detect_stream_positions` with 2 independent streams and verify response includes `suggestedRoster.builder = 2`
- [ ] Call `detectPipelinePosition` directly (single-issue path) and verify `suggestedRoster.builder = 1` (fallback, no regression)

## References
- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-02-GH-0487-compute-suggested-roster-stream-scaling.md
- Related issues:
  - https://github.com/cdubiel08/ralph-hero/issues/464 (parent: dynamic worker scaling)
  - https://github.com/cdubiel08/ralph-hero/issues/465 (sibling: stacked branch strategy)
  - https://github.com/cdubiel08/ralph-hero/issues/488 (sibling: spawn N builders from stream detection)
