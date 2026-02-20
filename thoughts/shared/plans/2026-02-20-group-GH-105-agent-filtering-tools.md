---
date: 2026-02-20
status: complete
github_issues: [105, 107, 108]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/105
  - https://github.com/cdubiel08/ralph-hero/issues/107
  - https://github.com/cdubiel08/ralph-hero/issues/108
primary_issue: 105
---

# Agent Filtering Tools - Atomic Implementation Plan

## Overview

3 related issues adding filtering capabilities to `list_issues` and `list_project_items` MCP tools, implemented in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-105 | Add `updated` date-math filter | S |
| 2 | GH-107 | Add `reason` filter to distinguish close types | S |
| 3 | GH-108 | Add draft issue filtering (`itemType`) | S |

**Why grouped**: All three add client-side filtering params to the same two list tools, following the identical pattern (Zod param + filter block + response field). Grouping ensures consistent patterns and avoids merge conflicts from parallel PRs modifying the same filter chains.

## Current State Analysis

### `list_issues` (issue-tools.ts:47-254)
- **Zod schema**: 8 params — `owner`, `repo`, `workflowState`, `estimate`, `priority`, `label`, `query`, `state`, `orderBy`, `limit`
- **GraphQL**: Fetches `... on Issue { number title body state url createdAt updatedAt labels assignees }` — has `updatedAt` but NOT `stateReason`
- **Filter chain** (L154-208): type check → state → workflowState → estimate → priority → label → query
- **Response** (L225-242): number, title, state, url, workflowState, estimate, priority, labels, assignees — no `updatedAt`, no `stateReason`
- **Pagination**: `maxItems: 500`, fetches all then filters client-side

### `list_project_items` (project-tools.ts:379-549)
- **Zod schema**: 5 params — `owner`, `number`, `workflowState`, `estimate`, `priority`, `limit`
- **GraphQL**: Fetches 3 content fragments — `... on Issue`, `... on PullRequest`, `... on DraftIssue` — but NO `updatedAt` on any
- **Filter chain** (L496-515): workflowState → estimate → priority (no type filter)
- **Response** (L518-536): itemId, type, number, title, state, url, workflowState, estimate, priority, labels, assignees
- **Pagination**: `maxItems: args.limit` — stops after limit items, THEN filters (fewer results when filters are active)

### Existing pattern (dashboard.ts:158-166)
Date-math comparison: `now - new Date(ts).getTime() <= windowMs` — days to milliseconds, simple arithmetic.

## Desired End State

### Verification
- [x] `parseDateMath("@today-7d")` resolves correctly with unit tests
- [x] `list_issues` accepts `updatedSince`/`updatedBefore` and filters by date
- [x] `list_project_items` accepts `updatedSince`/`updatedBefore` and filters by date (with `updatedAt` now fetched)
- [x] `list_issues` accepts `reason` param and filters by `stateReason` (completed/not_planned/reopened)
- [x] `list_project_items` accepts `itemType` param and filters by item type (ISSUE/PULL_REQUEST/DRAFT_ISSUE)
- [x] All existing tests pass, new structural tests added
- [x] `npm run build` succeeds with no type errors

## What We're NOT Doing
- NOT adding `includeDrafts` to `list_issues` (drafts lack number/state/url — confusing in issue-focused tool)
- NOT adding multi-value `itemType` array (single enum is sufficient; array is backward-compatible expansion later)
- NOT adding server-side GitHub search filtering (GitHub Projects V2 GraphQL doesn't support `updatedAt` predicates)
- NOT changing `list_project_items` pagination ceiling globally (only when date filters are active)
- NOT adding `createdSince`/`createdBefore` (out of scope — `updatedAt` covers the primary use cases)

## Implementation Approach

Phase 1 creates the foundational `parseDateMath` utility and wires date filters into both list tools. Phase 2 adds `stateReason` to `list_issues` (GraphQL field + filter + response). Phase 3 adds `itemType` filtering to `list_project_items` (filter only — GraphQL already fetches all content types). Each phase is independently testable with `npm run build && npm test`.

---

## Phase 1: GH-105 — Add `updated` Date-Math Filter
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/105 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0105-updated-date-math-filter.md

### Changes Required

#### 1. New file: `lib/date-math.ts`
**File**: `plugin/ralph-hero/mcp-server/src/lib/date-math.ts`
**Changes**: Create `parseDateMath(expr: string, now?: Date): Date` utility function.

- Parse regex: `/^@(today|now)(?:([+-])(\d+)([hdwm]))?$/i`
- `@today` → midnight UTC of current day
- `@now` → current instant
- Offset units: `h` (hours), `d` (days), `w` (weeks), `m` (months)
- Absolute fallback: `new Date(expr)` with `isNaN` validation
- Throws descriptive error for invalid expressions

```typescript
export function parseDateMath(expr: string, now: Date = new Date()): Date
```

#### 2. New test file: `__tests__/date-math.test.ts`
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/date-math.test.ts`
**Changes**: Unit tests for `parseDateMath`:

- `@today` → midnight UTC
- `@today-7d` → 7 days before midnight UTC
- `@today-2w` → 14 days before midnight UTC
- `@today-1m` → 1 month before midnight UTC
- `@now` → current instant
- `@now-24h` → 24 hours ago
- `@today+3d` → 3 days in the future
- Absolute ISO date: `2026-01-15` → correct Date
- Absolute ISO timestamp: `2026-01-15T12:00:00Z` → correct Date
- Invalid expression → throws Error with descriptive message

#### 3. Add `updatedSince`/`updatedBefore` to `list_issues`
**File**: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts`
**Changes**:

- **Zod schema** (after `state` param, before `orderBy`): Add two new optional string params:
  ```typescript
  updatedSince: z.string().optional().describe("Include items updated on or after this date. Supports date-math (@today-7d, @now-24h) or ISO dates (YYYY-MM-DD)."),
  updatedBefore: z.string().optional().describe("Include items updated before this date. Supports date-math (@today-7d, @now-24h) or ISO dates (YYYY-MM-DD)."),
  ```

- **Import**: Add `import { parseDateMath } from "../lib/date-math.js";` at top of file

- **Filter blocks** (insert after query filter, before sort, ~L208): Two new filter blocks following the existing `if (args.xxx)` pattern:
  ```typescript
  if (args.updatedSince) {
    const since = parseDateMath(args.updatedSince).getTime();
    items = items.filter((item) => {
      const content = item.content as Record<string, unknown> | null;
      const updatedAt = content?.updatedAt as string | undefined;
      return updatedAt ? new Date(updatedAt).getTime() >= since : false;
    });
  }
  if (args.updatedBefore) {
    const before = parseDateMath(args.updatedBefore).getTime();
    items = items.filter((item) => {
      const content = item.content as Record<string, unknown> | null;
      const updatedAt = content?.updatedAt as string | undefined;
      return updatedAt ? new Date(updatedAt).getTime() < before : false;
    });
  }
  ```

- **Response mapping** (L225-242): Add `updatedAt` to the formatted response:
  ```typescript
  updatedAt: content?.updatedAt ?? null,
  ```

#### 4. Add `updatedSince`/`updatedBefore` to `list_project_items`
**File**: `plugin/ralph-hero/mcp-server/src/tools/project-tools.ts`
**Changes**:

- **Import**: Add `import { parseDateMath } from "../lib/date-math.js";` at top of file

- **GraphQL query** (L446-453): Add `updatedAt` to the Issue fragment:
  ```graphql
  ... on Issue {
    number title state url
    updatedAt
    labels(first: 10) { nodes { name } }
    assignees(first: 5) { nodes { login } }
  }
  ```

- **Zod schema** (after `priority`, before `limit`): Add two new optional string params:
  ```typescript
  updatedSince: z.string().optional().describe("Include items updated on or after this date. Supports date-math (@today-7d, @now-24h) or ISO dates."),
  updatedBefore: z.string().optional().describe("Include items updated before this date. Supports date-math (@today-7d, @now-24h) or ISO dates."),
  ```

- **Pagination adjustment** (L490-492): When date filters are active, increase `maxItems` to 500 so we don't miss items:
  ```typescript
  const hasDateFilters = args.updatedSince || args.updatedBefore;
  const maxItems = hasDateFilters ? 500 : (args.limit || 50);
  // ... pass maxItems to paginateConnection options
  ```

- **Filter blocks** (after priority filter, before response mapping): Same pattern as `list_issues`:
  ```typescript
  if (args.updatedSince) {
    const since = parseDateMath(args.updatedSince).getTime();
    items = items.filter((item) => {
      const content = item.content as Record<string, unknown> | null;
      const updatedAt = content?.updatedAt as string | undefined;
      return updatedAt ? new Date(updatedAt).getTime() >= since : false;
    });
  }
  if (args.updatedBefore) {
    const before = parseDateMath(args.updatedBefore).getTime();
    items = items.filter((item) => {
      const content = item.content as Record<string, unknown> | null;
      const updatedAt = content?.updatedAt as string | undefined;
      return updatedAt ? new Date(updatedAt).getTime() < before : false;
    });
  }
  ```

- **Limit slicing** (add after filter chain, before response mapping):
  ```typescript
  items = items.slice(0, args.limit || 50);
  ```

- **Response mapping**: Add `updatedAt` to formatted response:
  ```typescript
  updatedAt: content?.updatedAt ?? null,
  ```

#### 5. Structural tests
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/issue-tools.test.ts`
- Add test: `list_issues` tool description mentions `updatedSince`

**File**: `plugin/ralph-hero/mcp-server/src/__tests__/project-tools.test.ts`
- Add test: `list_project_items` GraphQL query contains `updatedAt`

### Success Criteria
- [x] Automated: `npm run build` succeeds (no type errors)
- [x] Automated: `npm test` passes — all existing tests + new date-math unit tests + structural tests
- [x] Manual: `parseDateMath("@today-7d")` returns correct Date 7 days ago

**Creates for next phase**: Pattern established for adding filter params + filter blocks. `updatedAt` now available in both tools' responses.

---

## Phase 2: GH-107 — Add `reason` Filter to Distinguish Close Types
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/107 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0107-reason-filter-list-issues.md

### Changes Required

#### 1. Add `stateReason` to GraphQL query
**File**: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts`
**Changes**: In the `list_issues` GraphQL query, add `stateReason` after `state` in the Issue fragment (L125):
```graphql
... on Issue {
  number title body state stateReason url createdAt updatedAt
  labels(first: 10) { nodes { name } }
  assignees(first: 5) { nodes { login } }
}
```

#### 2. Add `reason` param to Zod schema
**File**: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts`
**Changes**: Add after `state` param (after L81):
```typescript
reason: z
  .enum(["completed", "not_planned", "reopened"])
  .optional()
  .describe("Filter by close reason: completed, not_planned, reopened"),
```

#### 3. Add client-side filter
**File**: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts`
**Changes**: Insert after the `state` filter block (after L164), before `workflowState` filter:
```typescript
if (args.reason) {
  const reasonUpper = args.reason.toUpperCase();
  items = items.filter((item) => {
    const content = item.content as Record<string, unknown> | null;
    return content?.stateReason === reasonUpper;
  });
}
```

#### 4. Add `stateReason` to response
**File**: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts`
**Changes**: In the `formattedItems` map (L225-242), add after `state`:
```typescript
stateReason: content?.stateReason ?? null,
```

#### 5. Structural tests
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/issue-tools.test.ts`
- Add test: `list_issues` GraphQL query contains `stateReason`
- Add test: `list_issues` tool description mentions `reason`

### Success Criteria
- [x] Automated: `npm run build` succeeds
- [x] Automated: `npm test` passes — all existing + new tests
- [x] Manual: `reason: "completed"` filters to only COMPLETED-closed issues

**Creates for next phase**: `stateReason` available in `list_issues` response for velocity metrics (#139).

---

## Phase 3: GH-108 — Add Draft Issue Filtering (`itemType`)
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/108 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0108-draft-issue-filtering.md

### Changes Required

#### 1. Add `itemType` param to Zod schema
**File**: `plugin/ralph-hero/mcp-server/src/tools/project-tools.ts`
**Changes**: Add after `priority` param (after L406), before `updatedSince` (added in Phase 1):
```typescript
itemType: z
  .enum(["ISSUE", "PULL_REQUEST", "DRAFT_ISSUE"])
  .optional()
  .describe("Filter by item type (ISSUE, PULL_REQUEST, DRAFT_ISSUE). Omit to include all types."),
```

#### 2. Add client-side filter
**File**: `plugin/ralph-hero/mcp-server/src/tools/project-tools.ts`
**Changes**: Insert as the FIRST filter in the chain (before `workflowState` filter, after `let items = itemsResult.nodes;`):
```typescript
if (args.itemType) {
  items = items.filter((item) => item.type === args.itemType);
}
```

Place before other filters since it's the broadest filter — reduces the working set before field-value lookups.

#### 3. Update pagination for type filtering
**File**: `plugin/ralph-hero/mcp-server/src/tools/project-tools.ts`
**Changes**: Extend the `hasDateFilters` check from Phase 1 to also include `itemType`:
```typescript
const hasFilters = args.updatedSince || args.updatedBefore || args.itemType;
const maxItems = hasFilters ? 500 : (args.limit || 50);
```

This ensures type-filtered queries fetch enough items before filtering.

#### 4. Structural tests
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/project-tools.test.ts`
- Add test: `list_project_items` tool description mentions `itemType`

### Success Criteria
- [x] Automated: `npm run build` succeeds
- [x] Automated: `npm test` passes
- [x] Manual: `itemType: "DRAFT_ISSUE"` returns only draft items

**No GraphQL changes needed** — `list_project_items` already fetches all three content type fragments.

---

## Integration Testing

- [ ] `list_issues` with `updatedSince: "@today-7d"` returns only recently updated issues
- [ ] `list_issues` with `state: "CLOSED"` and `reason: "completed"` returns only completed-closed issues
- [ ] `list_issues` with `reason: "not_planned"` excludes completed issues
- [ ] `list_project_items` with `itemType: "DRAFT_ISSUE"` returns only draft items
- [ ] `list_project_items` with `itemType: "ISSUE"` excludes drafts and PRs
- [ ] `list_project_items` with `updatedSince: "@today-30d"` filters by date
- [ ] All filters compose correctly (e.g., `workflowState + updatedSince + itemType`)
- [ ] No `itemType` param → all types returned (backward compatible)
- [ ] No `reason` param → all issues returned (backward compatible)
- [ ] No date params → no date filtering (backward compatible)

## File Ownership Summary

| File | Phase(s) | Changes |
|------|----------|---------|
| `src/lib/date-math.ts` | 1 (new) | `parseDateMath` utility |
| `src/__tests__/date-math.test.ts` | 1 (new) | Unit tests for date-math |
| `src/tools/issue-tools.ts` | 1, 2 | Add updatedSince/updatedBefore/reason params, stateReason to GraphQL, 3 filter blocks, 2 response fields |
| `src/tools/project-tools.ts` | 1, 3 | Add updatedAt to GraphQL, updatedSince/updatedBefore/itemType params, 3 filter blocks, pagination fix, 1 response field |
| `src/__tests__/issue-tools.test.ts` | 1, 2 | Structural tests for new params |
| `src/__tests__/project-tools.test.ts` | 1, 3 | Structural tests for new params |

## References

- Research: [GH-105](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0105-updated-date-math-filter.md), [GH-107](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0107-reason-filter-list-issues.md), [GH-108](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0108-draft-issue-filtering.md)
- Related: Epic [#94](https://github.com/cdubiel08/ralph-hero/issues/94) (Intelligent Agent Filtering)
- Pattern reference: [GH-120 group plan](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-02-19-group-GH-120-expand-mcp-project-management-tools.md) — similar additive tool changes
