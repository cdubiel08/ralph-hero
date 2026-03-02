---
date: 2026-03-02
github_issue: 487
github_url: https://github.com/cdubiel08/ralph-hero/issues/487
status: complete
type: research
---

# Research: GH-487 — Enhance computeSuggestedRoster() for Stream-Based Builder Scaling

## Problem Statement

`computeSuggestedRoster()` in `pipeline-detection.ts` uses a crude heuristic to determine how many builders to spawn: 2 builders if there are 5+ M/L/XL issues, otherwise 1. This heuristic is decoupled from actual parallelism — it doesn't know how many independent work streams exist. The result is under-scaling (never more than 2 builders) and wrong signals (a project with 5 independent small issues gets only 1 builder). The fix: use stream count from `detectWorkStreams` to drive builder scaling, one builder per stream capped at 3.

Additionally, the `detect_stream_positions` tool response currently contains per-stream `suggestedRoster` values (one per `StreamPipelineResult`) but no top-level aggregate. Callers (ralph-team) must manually aggregate, which requires extra logic. Adding a top-level `suggestedRoster` to the tool response resolves this.

## Current State Analysis

### `computeSuggestedRoster()` — Current Logic

**File**: [`plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts:392-425`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts#L392-L425)

```typescript
function computeSuggestedRoster(
  phase: PipelinePhase,
  issues: IssueState[],
): SuggestedRoster {
  // ...
  // Builder scaling: default 1; 2 if 5+ issues with M/L estimates
  const largeSized = issues.filter(i =>
    i.estimate != null && ['M', 'L', 'XL'].includes(i.estimate)
  );
  const builder = largeSized.length >= 5 ? 2 : 1;
  // ...
}
```

The function signature accepts only `phase` and `issues`. It has no awareness of stream count. It's called once in `buildResult()` at line 445.

### `buildResult()` Call Site

**File**: [`plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts:427-456`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts#L427-L456)

`buildResult()` calls `computeSuggestedRoster(phase, issues)` and embeds the result in the returned `PipelinePosition`. This function is called from both `detectPipelinePosition` (single-issue/group path) and `detectStreamPipelinePositions` (stream path). Adding an optional `streams` parameter to `computeSuggestedRoster` lets stream-aware callers pass stream count while single-issue callers omit it.

### `detectStreamPipelinePositions()` — Current Structure

**File**: [`plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts:363-386`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts#L363-L386)

```typescript
export function detectStreamPipelinePositions(
  streams: WorkStream[],
  issueStates: IssueState[],
  options: DetectionOptions = {},
): StreamPipelineResult[]
```

Returns `StreamPipelineResult[]` — each element has `streamId`, `issues`, `position` (which contains a per-stream `suggestedRoster`). There is no aggregate roster. The function has full access to `streams.length` already.

### `detect_stream_positions` Tool Handler

**File**: [`plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts:478-546`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts#L478-L546)

```typescript
return toolSuccess({
  streams: positions,
  totalStreams: streamResult.totalStreams,
  totalIssues: streamResult.totalIssues,
  rationale: streamResult.rationale,
});
```

No `suggestedRoster` in the top-level response. The tool handler already has `streamResult.totalStreams` available — computing an aggregate roster here is straightforward.

### `SuggestedRoster` Interface

**File**: [`plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts:48-52`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts#L48-L52)

```typescript
export interface SuggestedRoster {
  analyst: number;    // 0-3: 1 for single issue; 2 for 2-5 needing research; 3 for 6+
  builder: number;    // 1-2: 1 default; 2 if 5+ issues with M/L estimates
  integrator: number; // 1-2: 1 default; 2 if 5+ issues
}
```

The inline comment on `builder` is stale after this change — it will be updated to reflect stream-based scaling.

### `WorkStream` Interface

**File**: [`plugin/ralph-hero/mcp-server/src/lib/work-stream-detection.ts:11-16`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/work-stream-detection.ts#L11-L16)

```typescript
export interface WorkStream {
  id: string;
  issues: number[];
  sharedFiles: string[];
  primaryIssue: number;
}
```

`WorkStream[]` is already passed into `detectStreamPipelinePositions`. The length of this array is the independent stream count needed by the new heuristic.

### Existing Test Coverage

**File**: [`plugin/ralph-hero/mcp-server/src/__tests__/pipeline-detection.test.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/__tests__/pipeline-detection.test.ts)

Existing roster tests (lines ~522-530) only cover INTEGRATE and TERMINAL via `detectSingle()` — no test exercises `builder` count scaling. New tests must cover:
- 1 stream → builder = 1
- 2 streams → builder = 2
- 4 streams → builder = 3 (capped)
- 0 streams (no stream data) → builder = 1 (fallback)

## Key Discoveries

### 1. `computeSuggestedRoster` is called from one site only

`buildResult()` at line 445 is the sole caller. Adding an optional `streams?: WorkStream[]` parameter is safe — no other callers exist that would break.

### 2. Two distinct integration points for aggregate roster

Option A: Compute aggregate in `detectStreamPipelinePositions()` and return it alongside `StreamPipelineResult[]` (requires changing the return type). Option B: Compute aggregate in the `detect_stream_positions` tool handler using `streamResult.totalStreams` (no return type change needed). Option B is simpler and confines the aggregation to the tool layer.

### 3. Builder count formula is simple

```
builder = Math.min(streams.length || 1, 3)
```
- `streams.length || 1`: fallback to 1 when no stream data (backwards-compatible)
- `Math.min(..., 3)`: cap at 3 builders

### 4. Analyst and integrator counts stay unchanged

The issue scope explicitly limits changes to builder scaling. The existing analyst formula (based on `needsResearch` count) and integrator formula (based on total issues) remain unchanged.

### 5. Stream count is available without additional API calls

`detectStreamPipelinePositions` already receives `WorkStream[]` — its length is the stream count. No new data fetching is needed.

### 6. The tool-layer aggregate is the right place for `suggestedRoster`

ralph-team needs a single top-level roster, not per-stream rosters. The tool handler already aggregates `totalStreams` and `totalIssues`. Adding `suggestedRoster` there follows the existing pattern.

## Potential Approaches

### Approach A: Optional `streams` parameter on `computeSuggestedRoster` + tool-layer aggregate (Recommended)

1. Add `streams?: WorkStream[]` param to `computeSuggestedRoster`
2. Replace `const builder = largeSized.length >= 5 ? 2 : 1` with `const builder = Math.min((streams?.length || 0) || 1, 3)` — when `streams` is undefined or empty, falls back to 1
3. Pass `streams` from `detectStreamPipelinePositions` when calling `buildResult`/`computeSuggestedRoster` for stream-positioned results
4. In the `detect_stream_positions` tool handler, compute aggregate `suggestedRoster` using `streamResult.totalStreams` and add it to the response

**Pros**: Clean, backwards-compatible, minimal surface area, no return type change for `detectStreamPipelinePositions`.
**Cons**: The optional parameter on `computeSuggestedRoster` is internal-only — slight inconsistency with the tool-layer aggregate approach.

### Approach B: Compute aggregate roster only in tool handler

Skip modifying `computeSuggestedRoster`. Instead, compute the aggregate roster directly in `detect_stream_positions` tool handler using `streamResult.totalStreams`.

**Pros**: Zero change to the library function — tool layer stays entirely responsible for shaping output.
**Cons**: The per-stream `suggestedRoster` embedded in each `PipelinePosition` still uses the old builder heuristic. Inconsistency between per-stream and aggregate values.

**Verdict**: Approach A is correct. Fixing the per-stream roster too (via the updated `computeSuggestedRoster`) ensures consistency throughout the system.

## Risks and Considerations

1. **Cap at 3 is a soft limit**: Stream count could exceed 3 in large projects. Cap is intentional per the issue scope — revisit if teams regularly have more than 3 independent streams.
2. **Backwards compatibility**: Callers that invoke `detectPipelinePosition` directly (not the stream path) will get `builder = 1` always, since no `streams` are passed. This matches the existing behavior and is correct — single-issue detection doesn't have stream context.
3. **Per-stream roster inconsistency before this fix**: Each stream's `suggestedRoster.builder` is computed from that stream's own issues, not total streams. After the fix, `computeSuggestedRoster` receives the full `streams` array — so per-stream rosters now reflect total parallelism. This is intentional per the issue design (one builder per total stream count).
4. **Test file imports**: The test file imports `detectPipelinePosition` and `detectStreamPipelinePositions` but not `computeSuggestedRoster` directly (it's not exported). Tests must go through the public API.

## Recommended Next Steps

1. **Modify `computeSuggestedRoster`**: Add optional `streams?: WorkStream[]` param; replace builder heuristic with `Math.min(streams?.length || 1, 3)`. Update inline comment on `SuggestedRoster.builder`.
2. **Thread `streams` through `buildResult`**: Pass the `streams: WorkStream[]` array from `detectStreamPipelinePositions` through to `buildResult` and into `computeSuggestedRoster`.
3. **Update `detect_stream_positions` tool handler**: Add top-level `suggestedRoster` computed from `streamResult.totalStreams`: `{ analyst: X, builder: Math.min(streamResult.totalStreams, 3), integrator: Y }`. Use the aggregate analyst/integrator from summing across stream positions.
4. **Add tests**: 4 new cases in `pipeline-detection.test.ts` for stream-based builder scaling (1, 2, 4 streams, and fallback when no stream data).

## Files Affected

### Will Modify
- `plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts` — Add optional `streams` param to `computeSuggestedRoster` and `buildResult`; replace builder heuristic; update `SuggestedRoster.builder` comment
- `plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts` — Add top-level `suggestedRoster` to `detect_stream_positions` response
- `plugin/ralph-hero/mcp-server/src/__tests__/pipeline-detection.test.ts` — Add 4 test cases for stream-based builder scaling

### Will Read (Dependencies)
- `plugin/ralph-hero/mcp-server/src/lib/work-stream-detection.ts` — `WorkStream` type (imported, not modified)
- `plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts` — LOCK_STATES, TERMINAL_STATES (imported by pipeline-detection, not modified)
