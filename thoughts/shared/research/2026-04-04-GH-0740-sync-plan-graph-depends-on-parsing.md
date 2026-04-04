---
date: 2026-04-04
github_issue: 740
github_url: https://github.com/cdubiel08/ralph-hero/issues/740
status: complete
type: research
tags: [ralph-hero, mcp-server, plan-graph, regex, bug]
---

# GH-740: sync_plan_graph removes valid dependency edges

## Prior Work

- builds_on:: None identified.
- tensions:: None identified.

## Problem Statement

`sync_plan_graph` fails to parse `depends_on` annotations from plan documents when phase headings use `GH-NNN` without surrounding parentheses. All existing GitHub dependency edges are treated as stale and removed.

## Current State Analysis

### Root Cause: Phase Heading Regex Too Strict

The phase heading regex at [`plan-graph.ts:87`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/plan-graph.ts#L87):

```typescript
const phasePattern = /^## Phase (\d+):.*\(GH-(\d+)\)/;
```

Requires **literal parentheses** around the GH-NNN reference: `(GH-736)`. When plans generate headings in the format `## Phase 1: GH-736 — title` (no parens), the regex fails to match.

**Consequence chain:**
1. `phasePattern` fails to match any heading → `phaseToIssue` map stays empty
2. `currentPhaseIssue` is never set → no `depends_on` lines are processed
3. `parsePlanGraph()` returns `edges: []` (0 declared edges)
4. `diffDependencyEdges()` sees 0 declared vs N existing → all N edges classified as "removed"
5. `sync_plan_graph` removes all dependency edges

### Heading Formats in the Wild

The ralph-plan skill template uses `## Phase N: [Atomic Issue GH-NNN — title]` (bracket notation). Actual generated plans vary:

| Format | Matches regex? |
|--------|---------------|
| `## Phase 1: Core data model (GH-660)` | Yes |
| `## Phase 1: GH-736 — title` | **No** |
| `## Phase 1: Fix FTS5 escaping (GH-734)` | Yes |

The test fixtures in `plan-graph.test.ts` all use the `(GH-NNN)` format, so the bug was never caught.

### Same Issue in Plan-of-Plans Regex

The feature heading regex at `plan-graph.ts:143`:
```typescript
const featurePattern = /^### Feature [^:]+:.*\(GH-(\d+)\)/;
```
Also requires parentheses. Should be fixed for consistency.

## Key Discoveries

### The Fix

Remove the parentheses requirement from both regexes:

**Phase heading** (line 87):
```typescript
// Before:
const phasePattern = /^## Phase (\d+):.*\(GH-(\d+)\)/;
// After:
const phasePattern = /^## Phase (\d+):.*GH-(\d+)/;
```

**Feature heading** (line 143):
```typescript
// Before:
const featurePattern = /^### Feature [^:]+:.*\(GH-(\d+)\)/;
// After:
const featurePattern = /^### Feature [^:]+:.*GH-(\d+)/;
```

The `.*` greedy quantifier + regex backtracking handles both formats:
- `## Phase 1: title (GH-660)` → `.*` matches `title (`, captures `660`
- `## Phase 1: GH-736 — title` → `.*` matches empty, captures `736`

### Existing Tests Pass Both Formats

The test fixtures use `(GH-NNN)` format. After the regex change, they still match because `GH-NNN` is a superset match — `(GH-660)` still contains `GH-660`.

## Files Affected

### Will Modify
- `plugin/ralph-hero/mcp-server/src/lib/plan-graph.ts` — Fix both regexes (lines 87 and 143)
- `plugin/ralph-hero/mcp-server/src/__tests__/plan-graph.test.ts` — Add test case for no-parens heading format

### Will Read (Dependencies)
- `plugin/ralph-hero/mcp-server/src/tools/plan-graph-tools.ts` — Consumer of `parsePlanGraph()`, no changes needed
