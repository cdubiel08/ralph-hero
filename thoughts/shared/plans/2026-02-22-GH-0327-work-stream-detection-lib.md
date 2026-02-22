---
date: 2026-02-22
status: draft
github_issues: [327]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/327
primary_issue: 327
---

# Work Stream Detection Library Module - Atomic Implementation Plan

## Overview
Single issue for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-327 | Implement `work-stream-detection.ts` library module with union-find and tests | S |

## Current State Analysis

No `work-stream-detection.ts` exists yet. Two related modules provide structural patterns:

1. **`lib/pipeline-detection.ts`** — Pure function module (no API calls). Types exported at top with section divider comments. Single main exported function `detectPipelinePosition()`. Private `buildResult` helper. This is the structural template.

2. **`lib/group-detection.ts`** — Graph traversal reference using BFS/transitive closure and Kahn's topological sort. NOT pure (requires `GitHubClient`). Our module will be pure like `pipeline-detection.ts`.

3. **`__tests__/pipeline-detection.test.ts`** — Import with `.js` extension, `makeIssue()` factory helper with defaults, `describe`/`it` structure grouped by behavioral concern, assertions via `expect().toBe()`, `.toEqual()`, `.toContain()`.

The plan (Phase 2 of GH-321) specifies exact types: `IssueFileOwnership`, `WorkStream`, `WorkStreamResult`. These are fixed — sibling issues #329, #331, #332 depend on these shapes.

## Desired End State
### Verification
- [ ] `cd plugin/ralph-hero/mcp-server && npm run build` succeeds
- [ ] `cd plugin/ralph-hero/mcp-server && npm test` passes with all 8 test cases
- [ ] `IssueFileOwnership`, `WorkStream`, `WorkStreamResult` types exported
- [ ] Union-find correctly groups issues with shared `Will Modify` files
- [ ] `blockedBy` relationships co-cluster issues into same stream
- [ ] Transitive file sharing (A-B share, B-C share) produces 1 stream
- [ ] Stream IDs are deterministic content-based strings (`stream-42-44`)
- [ ] Empty input returns `{ streams: [], totalIssues: 0, totalStreams: 0 }`

## What We're NOT Doing
- No MCP tool registration (that's GH-329)
- No pipeline detection integration (that's GH-331)
- No dashboard tool (that's GH-332)
- No GitHub API calls — module is pure TypeScript
- No research doc parsing — orchestrator provides pre-parsed data

## Implementation Approach

Follow `pipeline-detection.ts` module structure: types at top with section dividers, main exported function, private helpers. Algorithm is union-find with path compression and union by rank, using `issue:N`/`file:path` prefixed keys to handle both edge types in a single data structure.

---

## Phase 1: GH-327 — Work Stream Detection Library Module
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/327 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-22-GH-0327-work-stream-detection-lib.md

### Changes Required

#### 1. Create `work-stream-detection.ts` library module
**File**: `plugin/ralph-hero/mcp-server/src/lib/work-stream-detection.ts` (NEW)
**Changes**: New file implementing the clustering algorithm.

**Structure** (follow `pipeline-detection.ts` patterns):

```
// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IssueFileOwnership { ... }
export interface WorkStream { ... }
export interface WorkStreamResult { ... }

// ---------------------------------------------------------------------------
// Union-Find (internal)
// ---------------------------------------------------------------------------

class UnionFind { ... }  // NOT exported

// ---------------------------------------------------------------------------
// Detection logic
// ---------------------------------------------------------------------------

export function detectWorkStreams(issues: IssueFileOwnership[]): WorkStreamResult { ... }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildRationale(streams: WorkStream[], ...): string { ... }
```

**Types** (from plan spec — must match exactly):

```typescript
export interface IssueFileOwnership {
  number: number;
  files: string[];               // Will Modify paths from research doc
  blockedBy: number[];           // GitHub blockedBy issue numbers
}

export interface WorkStream {
  id: string;                    // e.g., "stream-42-44" (sorted issue numbers)
  issues: number[];              // Issue numbers in this stream (sorted)
  sharedFiles: string[];         // Files that caused clustering
  primaryIssue: number;          // First issue (smallest number in component)
}

export interface WorkStreamResult {
  streams: WorkStream[];
  totalIssues: number;
  totalStreams: number;
  rationale: string;             // Human-readable clustering explanation
}
```

**UnionFind class** (private, not exported):
- `parent: Map<string, string>` and `rank: Map<string, number>`
- `find(x)`: with path compression
- `union(x, y)`: with union by rank
- Lazy initialization via `init(x)` called from `find()`
- Keys use prefixed format: `issue:42`, `file:src/lib/foo.ts`

**`detectWorkStreams()` algorithm**:

1. **Guard**: Empty input → return `{ streams: [], totalIssues: 0, totalStreams: 0, rationale: "No issues provided." }`

2. **Pass 1 — Union operations**:
   - For each `IssueFileOwnership`: create `issue:N` key
   - For each file in `files[]`: `union("file:path", "issue:N")`
   - For each dep in `blockedBy[]`: if dep is in the input set, `union("issue:dep", "issue:N")`
   - Guard: only union `blockedBy` edges where both endpoints are in the input array

3. **Pass 2 — Collect components**:
   - Group issues by their root: `Map<root, number[]>`
   - For each issue key `issue:N`: `find("issue:N")` → group by root

4. **Pass 3 — Build `WorkStream[]`**:
   - For each component:
     - `issues`: sorted issue numbers
     - `id`: `"stream-"` + sorted issues joined by `"-"` (e.g., `"stream-42-44"`)
     - `sharedFiles`: files appearing in 2+ issues within the component (frequency map)
     - `primaryIssue`: minimum issue number in component
   - Sort streams by `primaryIssue` ascending

5. **Build result**: `{ streams, totalIssues: issues.length, totalStreams: streams.length, rationale: buildRationale(streams) }`

**`buildRationale()` helper**:
- One sentence per stream describing clustering reason
- Format: `"N streams detected. Stream stream-42-44: issues share [src/lib/foo.ts]. Stream stream-43: independent."`
- For dependency-only clustering: `"co-clustered via blockedBy relationship"`

#### 2. Create test file
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/work-stream-detection.test.ts` (NEW)
**Changes**: New test file with 8 test cases.

**Structure** (follow `pipeline-detection.test.ts` patterns):

```typescript
import { describe, it, expect } from "vitest";
import {
  detectWorkStreams,
  type IssueFileOwnership,
  type WorkStream,
  type WorkStreamResult,
} from "../lib/work-stream-detection.js";  // .js extension for ESM

function makeOwnership(
  number: number,
  files: string[] = [],
  blockedBy: number[] = [],
): IssueFileOwnership {
  return { number, files, blockedBy };
}
```

**Test cases** (8, per plan spec):

```
describe("detectWorkStreams - file overlap", () => {
  it("clusters 2 issues sharing files into 1 stream")
  it("separates 2 issues with no file overlap into 2 streams")
  it("clusters 3 issues with transitive file overlap into 1 stream")
})

describe("detectWorkStreams - blockedBy co-clustering", () => {
  it("clusters 2 issues with blockedBy but no file overlap into 1 stream")
  it("clusters A+B via blockedBy while C stays independent (2 streams)")
})

describe("detectWorkStreams - edge cases", () => {
  it("returns 1 stream for single issue (degenerate)")
  it("produces deterministic stream IDs (stream-42-44)")
  it("treats issue with empty files and no blockedBy as singleton stream")
})
```

**Assertion patterns**:
- `expect(result.totalStreams).toBe(N)`
- `expect(result.streams).toHaveLength(N)`
- `expect(result.streams[0].id).toBe("stream-42-44")`
- `expect(result.streams[0].issues).toEqual([42, 44])`
- `expect(result.streams[0].sharedFiles).toContain("src/auth/middleware.ts")`
- `expect(result.streams[0].primaryIssue).toBe(42)`

### File Ownership Summary

| File | Change Type |
|------|------------|
| `plugin/ralph-hero/mcp-server/src/lib/work-stream-detection.ts` | NEW — Core algorithm + types |
| `plugin/ralph-hero/mcp-server/src/__tests__/work-stream-detection.test.ts` | NEW — 8 test cases |

### Success Criteria
- [x] Automated: `cd plugin/ralph-hero/mcp-server && npm run build` succeeds
- [x] Automated: `cd plugin/ralph-hero/mcp-server && npm test` passes with 8 new test cases
- [ ] Manual: Types match plan spec exactly (`IssueFileOwnership`, `WorkStream`, `WorkStreamResult`)
- [ ] Manual: Stream IDs use `stream-` prefix with sorted issue numbers
- [ ] Manual: `sharedFiles` contains only files appearing in 2+ issues within a component
- [ ] Manual: `blockedBy` edges only union when both endpoints are in the input set
- [ ] Manual: Empty input returns valid empty result

---

## Integration Testing
- [ ] `cd plugin/ralph-hero/mcp-server && npm run build` passes
- [ ] `cd plugin/ralph-hero/mcp-server && npm test` passes with all existing + 8 new tests
- [ ] No regressions in existing test suites

## References
- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-22-GH-0327-work-stream-detection-lib.md
- Parent plan (Phase 2): https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-02-21-work-stream-parallelization.md
- Pattern reference: `plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts` (pure module structure)
- Pattern reference: `plugin/ralph-hero/mcp-server/src/__tests__/pipeline-detection.test.ts` (test patterns)
- Related issues: https://github.com/cdubiel08/ralph-hero/issues/323 (parent), https://github.com/cdubiel08/ralph-hero/issues/329 (tool registration), https://github.com/cdubiel08/ralph-hero/issues/331 (pipeline detection), https://github.com/cdubiel08/ralph-hero/issues/332 (dashboard tool)
