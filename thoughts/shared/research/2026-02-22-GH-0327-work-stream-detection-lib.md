---
date: 2026-02-22
github_issue: 327
github_url: https://github.com/cdubiel08/ralph-hero/issues/327
status: complete
type: research
---

# GH-327: Implement `work-stream-detection.ts` Library Module

## Problem Statement

The work-stream parallelization epic (GH-321 Phase 2) requires a pure algorithmic library module that clusters GitHub issues into independent work streams based on file overlap and `blockedBy` dependency relationships. This is the foundational building block — all sibling issues (#329, #331, #332) depend on the types and functions exported here.

The module lives in the MCP server and is intentionally decoupled from GitHub API access. The orchestrator (ralph-team) pre-parses `## Files Affected` sections from research docs and passes structured data to the tool. The algorithm itself is pure TypeScript with no network calls.

## Current State Analysis

No `work-stream-detection.ts` file exists yet. The codebase has two closely related modules to draw patterns from:

### `lib/group-detection.ts` — Graph traversal reference
- Uses BFS/transitive closure with a `Map<number, IssueRelationData>` as the canonical store
- `addIssueToMap()` merge-on-insert pattern (larger arrays win, non-null values preferred)
- Kahn's topological sort for ordering results
- Exported types: `GroupIssue`, `GroupDetectionResult`
- Requires `GitHubClient` — NOT a pure function (makes API calls)

**Key difference for our module**: `work-stream-detection.ts` will be fully pure — no `client`, no `owner`/`repo` params. All data arrives pre-parsed as `IssueFileOwnership[]`.

### `lib/pipeline-detection.ts` — Pure module reference
- Pure function: `detectPipelinePosition(issues: IssueState[], isGroup: boolean, groupPrimary: number | null): PipelinePosition`
- No API calls, no side effects
- Rich exported types with clear field semantics
- `REMAINING_PHASES` static constant for lookup tables
- `buildResult` private helper to assemble output

This is the structural template for `work-stream-detection.ts`.

### Test patterns from `__tests__/pipeline-detection.test.ts`
- `import { describe, it, expect } from "vitest"` — no mocking utilities needed for pure functions
- `.js` extension on all import paths (ESM TypeScript `moduleResolution: NodeNext`)
- `makeXxx()` factory helpers with sensible defaults
- One `describe` block per behavioral axis
- All assertions via `expect().toBe()`, `expect().toEqual()`, `expect().toHaveLength()`
- No snapshot assertions

## Key Discoveries

### Exact Types Specified in the Plan

From `thoughts/shared/plans/2026-02-21-work-stream-parallelization.md` (Phase 2, lines 161–180):

```typescript
export interface IssueFileOwnership {
  number: number;
  files: string[];    // Will Modify paths from research doc
  blockedBy: number[];// GitHub blockedBy issue numbers
}

export interface WorkStream {
  id: string;         // "stream-42-44" (sorted issue numbers joined by -)
  issues: number[];   // Issue numbers in this stream
  sharedFiles: string[]; // Files that caused clustering
  primaryIssue: number;  // First issue by topo order (for naming)
}

export interface WorkStreamResult {
  streams: WorkStream[];
  totalIssues: number;
  totalStreams: number;
  rationale: string;  // Human-readable clustering explanation
}
```

These types are fixed by the plan. The sibling tool issues (#329, #332) depend on these exact shapes.

### Algorithm: Union-Find with Two Edge Types

From the plan (lines 183–189), the algorithm builds a graph where:
1. **File-overlap edges**: Issues sharing any `Will Modify` file path → same component
2. **Dependency edges**: Issues connected by `blockedBy` → same component (business-logic coupling)
3. Find connected components → each component = one work stream
4. Sort streams by topological order (respecting `blockedBy` within streams)

**Stream ID format** (plan line 191): `stream-` + sorted issue numbers joined by `-`. E.g., `stream-42-44`, `stream-43`, `stream-45-46`. Content-based, deterministic across sessions.

### Union-Find Implementation (no external deps)

Best practice for TypeScript union-find with string keys (covering both `issue:N` and `file:path` nodes):

```typescript
class UnionFind {
  private parent = new Map<string, string>();
  private rank = new Map<string, number>();

  private init(x: string): void {
    if (!this.parent.has(x)) {
      this.parent.set(x, x);
      this.rank.set(x, 0);
    }
  }

  find(x: string): string {
    this.init(x);
    if (this.parent.get(x) !== x) {
      this.parent.set(x, this.find(this.parent.get(x)!)); // path compression
    }
    return this.parent.get(x)!;
  }

  union(x: string, y: string): void {
    const rx = this.find(x), ry = this.find(y);
    if (rx === ry) return;
    const rankX = this.rank.get(rx)!, rankY = this.rank.get(ry)!;
    if (rankX < rankY) { this.parent.set(rx, ry); }
    else if (rankX > rankY) { this.parent.set(ry, rx); }
    else { this.parent.set(ry, rx); this.rank.set(rx, rankX + 1); }
  }
}
```

Prefix `issue:N` and `file:path` keys to avoid namespace collisions between issue numbers and file paths.

### Two-Pass Collection Algorithm

**Pass 1 — Build components (union operations)**:
```
for each (issue, files, blockedBy) in input:
  issueKey = "issue:N"
  for each file: union("file:path", issueKey)
  for each dep in blockedBy: union("issue:dep", issueKey)
```

**Pass 2 — Collect components**:
```
components = Map<root, { issues: number[], files: Set<string> }>
for each issue: root = find("issue:N"), group by root
```

**Pass 3 — Build WorkStream[]**:
- `id`: `stream-` + sorted `issues`.join(`-`)
- `sharedFiles`: files appearing in 2+ issues within the component
- `primaryIssue`: lowest-numbered issue in the component (or topologically first by blockedBy)
- Sort streams: topological order by inter-stream `blockedBy` relationships (Kahn's), tie-break by smallest issue number

### Test Cases (from plan lines 231–238)

The plan specifies 8 test cases (the issue body says 5 — use the plan's 8 as authoritative):
1. 2 issues sharing files → 1 stream
2. 2 issues with no file overlap → 2 streams
3. 3 issues A↔B↔C transitive (A-B share file, B-C share file, A-C do not) → 1 stream
4. 2 issues with no file overlap but A `blockedBy` B → 1 stream (dependency co-clustering)
5. 3 issues: A blocks B (no file overlap), C independent → 2 streams (A+B, C)
6. 1 issue → 1 stream (degenerate)
7. Stream IDs deterministic: `stream-42-44` not `stream-1`
8. Missing file data (empty `files: []` with no blockedBy) → singleton stream (isolated, not an error)

Note: The issue body mentions "Missing research doc → error" but the plan architecture clarifies that the MCP tool receives pre-parsed data — it never reads research docs itself. An issue with empty `files` and no `blockedBy` is a valid singleton stream, not an error. The builder should implement the 8 plan-defined test cases.

### `sharedFiles` Computation

For a component with multiple issues:
- Build a frequency map: `filePath → count of issues in component that list it`
- `sharedFiles` = files with count ≥ 2

For singleton components (single issue, no overlap): `sharedFiles = []`.

### `rationale` Field

Human-readable string summarizing why issues were clustered. Example format:
```
"3 streams detected. Stream stream-42-44: issues share [src/lib/foo.ts]. Stream stream-43: independent. Stream stream-45-46: co-clustered via blockedBy relationship."
```

Keep concise — one sentence per stream.

## Potential Approaches

### Approach A: Pure union-find (recommended)
- Single `UnionFind` class with `find`/`union` methods, path compression + union by rank
- Two-pass: union phase → collect phase
- No external dependencies
- O(n·α(n)) time complexity — effectively O(n) for any realistic input size
- **Pros**: Optimal, well-understood, no edge cases
- **Cons**: Slightly more code than adjacency-list DFS

### Approach B: Adjacency-list DFS
- Build `Map<number, Set<number>>` adjacency graph of issue-to-issue edges
- Run DFS to find connected components
- **Pros**: Slightly simpler to read
- **Cons**: Requires O(n²) adjacency list population for file-sharing edges (must compare all pairs); worse than union-find for large inputs

**Recommendation**: Approach A (union-find). Matches the plan spec, handles large inputs well, and the `is:N`/`file:path` prefix trick elegantly handles both edge types without building a separate adjacency list.

## Risks and Edge Cases

| Risk | Mitigation |
|------|------------|
| Issue appears in `blockedBy` but not in `input` array | Guard: only union edges where both endpoints are in the input set |
| Circular `blockedBy` (A blocks B, B blocks A) | Union-find handles cycles naturally — they merge into one component |
| Empty input array | Return `{ streams: [], totalIssues: 0, totalStreams: 0, rationale: "No issues provided." }` |
| All issues in one stream | Valid result — `totalStreams: 1` |
| Determinism of stream IDs | Content-based IDs (`stream-42-44`) ensure stability; sort issues before joining |
| `primaryIssue` ordering | Use minimum issue number in component as primary (simple, deterministic, no topo sort needed for a pure lib function) |

## Recommended Implementation Plan

1. Create `plugin/ralph-hero/mcp-server/src/lib/work-stream-detection.ts`:
   - Export `IssueFileOwnership`, `WorkStream`, `WorkStreamResult` interfaces
   - Implement private `UnionFind` class (not exported)
   - Export `detectWorkStreams(issues: IssueFileOwnership[]): WorkStreamResult`

2. Create `plugin/ralph-hero/mcp-server/src/__tests__/work-stream-detection.test.ts`:
   - Import with `.js` extension: `from "../lib/work-stream-detection.js"`
   - `makeOwnership(number, files?, blockedBy?)` factory helper
   - 8 `it()` cases per plan spec
   - Assert `result.streams.length`, `result.streams[0].id`, `result.streams[0].issues`, `result.totalStreams`

3. Run `npm test` and `npm run build` to verify

## Files Affected

### Will Modify
- `plugin/ralph-hero/mcp-server/src/lib/work-stream-detection.ts` — New file (core algorithm + types)
- `plugin/ralph-hero/mcp-server/src/__tests__/work-stream-detection.test.ts` — New test file (8 test cases)

### Will Read (Dependencies)
- `plugin/ralph-hero/mcp-server/src/lib/group-detection.ts` — Pattern reference for graph traversal
- `plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts` — Pattern reference for pure module structure + `IssueState`/`PipelinePosition` types (needed by sibling #331)
- `plugin/ralph-hero/mcp-server/src/__tests__/pipeline-detection.test.ts` — Test pattern reference
- `thoughts/shared/plans/2026-02-21-work-stream-parallelization.md` — Authoritative type specs and algorithm
