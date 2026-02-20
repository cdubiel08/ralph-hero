---
date: 2026-02-20
github_issue: 105
github_url: https://github.com/cdubiel08/ralph-hero/issues/105
status: complete
type: research
---

# GH-105: Add `updated` Date-Math Filter to `list_issues` / `list_project_items`

## Problem Statement

Agents frequently need to find recently active or stale issues (e.g., "issues updated in the last 7 days" or "issues not updated in 14 days"). Currently, `list_issues` fetches `updatedAt` for sorting but offers no date-based filtering. `list_project_items` doesn't even fetch `updatedAt`. Users must fetch all items and filter externally, wasting API calls and context window.

## Current State Analysis

### `list_issues` — Has `updatedAt`, No Date Filter

[`issue-tools.ts:47-254`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L47):

- **GraphQL query** fetches `createdAt` (L127) and `updatedAt` (L128) on Issue content
- **Sort step** (L211-219) uses `updatedAt` or `createdAt` based on `orderBy` param
- **No date filter params** exist — only `state`, `workflowState`, `estimate`, `priority`, `label`, `query`, `orderBy`, `limit`
- **Pagination**: Fetches up to 500 items, filters client-side, then slices to `limit`

### `list_project_items` — No `updatedAt` at All

[`project-tools.ts:379-538`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-tools.ts#L379):

- **GraphQL query** does NOT request `createdAt` or `updatedAt` on Issue content (L446-453)
- **Filters**: Only `workflowState`, `estimate`, `priority` (3 params vs 8 in `list_issues`)
- **Pagination**: `maxItems = args.limit` — fetches exactly as many as needed, then filters. This means post-filter results may be fewer than `limit` if items are filtered out.

### `dashboard.ts` — Date Math Reference Implementation

[`dashboard.ts:158-166`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/dashboard.ts#L158):

```typescript
const windowMs = config.doneWindowDays * 24 * 60 * 60 * 1000;
// ...
const ts = item.closedAt ?? item.updatedAt;
return now - new Date(ts).getTime() <= windowMs;
```

Pattern: days → milliseconds, compare `now - timestamp <= window`. This is the existing codebase pattern for date-range filtering.

## Key Discoveries

### 1. Date-Math Syntax Design

The issue requests `@today`, `@today-Nd`, `@today-Nw`, `@today-Nm`. This is a well-known pattern from Elasticsearch, Kibana, and Grafana date-math.

Proposed syntax:

| Expression | Resolves To |
|-----------|-------------|
| `@today` | Start of today (midnight UTC) |
| `@today-7d` | 7 days ago from midnight UTC |
| `@today-2w` | 14 days ago |
| `@today-1m` | ~30 days ago |
| `@now` | Current instant |
| `@now-24h` | 24 hours ago |
| `YYYY-MM-DD` | Absolute date (midnight UTC) |
| ISO 8601 | Absolute datetime |

The parser should also accept plain ISO dates (`2026-02-13`) and ISO timestamps (`2026-02-13T00:00:00Z`) for absolute filtering.

### 2. New Utility: `parseDateMath(expr: string): Date`

No date-math utility exists in `lib/`. A new `lib/date-math.ts` module should provide:

```typescript
export function parseDateMath(expr: string, now?: Date): Date
```

- `now` parameter makes it testable (same pattern as `dashboard.ts` passing `now: number`)
- Parse regex: `/^@(today|now)(?:([+-])(\d+)([hdwm]))?$/`
- Absolute fallback: `new Date(expr)` with validation (`isNaN` check)
- Throws descriptive error for invalid expressions

### 3. Two New Params Per Tool

Both `list_issues` and `list_project_items` get:

| Param | Type | Description |
|-------|------|-------------|
| `updatedSince` | `z.string().optional()` | Items updated on or after this date (date-math or ISO) |
| `updatedBefore` | `z.string().optional()` | Items updated before this date (date-math or ISO) |

These form a half-open interval: `[updatedSince, updatedBefore)`.

### 4. `list_project_items` Needs `updatedAt` in GraphQL

The Issue fragment at [`project-tools.ts:446-453`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-tools.ts#L446) must add `updatedAt` (and optionally `createdAt`) to enable date filtering. Currently it only fetches `number`, `title`, `state`, `url`, `labels`, `assignees`.

### 5. Filter Placement — Client-Side

Filtering is client-side in both tools (existing pattern). The new filter blocks follow the identical pattern:

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

### 6. Pagination Concern for `list_project_items`

`list_project_items` uses `maxItems: args.limit`, which means the pagination stops after fetching `limit` items, THEN filters. With date filtering, many fetched items may be filtered out, returning fewer than `limit` results.

**Recommended**: Change `list_project_items` to use `maxItems: 500` (matching `list_issues`) when any filter param is provided, then slice to `limit` after filtering. This is a separate concern but should be noted in the implementation plan.

### 7. Return `updatedAt` in Response

Currently `list_issues` fetches `updatedAt` but does NOT include it in the formatted response (L225-242). When date filtering is active, `updatedAt` should be included in the response so callers can see the actual timestamps. Consider always including it (it's useful context).

### 8. Group Context

Part of Epic #94 (Intelligent Agent Filtering), a 7-issue group:
1. **#105** (this issue) — date-math filter — no blockers
2. #106 — `has`/`no` presence filters
3. #107 — `reason` filter for close types
4. #108 — draft issue filtering
5. #109 — pre-canned agent filter profiles
6. #120 — draft issue MCP tools
7. #147 — filter profile registry (depends on #105 for "stale" profile)

#105 is the foundational filtering issue — its `parseDateMath` utility and filtering pattern will be reused by other issues in the group.

## Recommended Approach

### File Changes

1. **New file: `lib/date-math.ts`** — `parseDateMath(expr, now?)` function + tests
2. **Modify: `tools/issue-tools.ts`** — Add `updatedSince`/`updatedBefore` params and filter blocks to `list_issues`
3. **Modify: `tools/project-tools.ts`** — Add `updatedAt` to GraphQL fragment, add `updatedSince`/`updatedBefore` params and filter blocks to `list_project_items`
4. **New test file: `__tests__/date-math.test.ts`** — Unit tests for `parseDateMath`
5. **Modify existing test files** — Add structural tests for new params

### `parseDateMath` Implementation

```typescript
const DATE_MATH_RE = /^@(today|now)(?:([+-])(\d+)([hdwm]))?$/i;

export function parseDateMath(expr: string, now: Date = new Date()): Date {
  const match = expr.match(DATE_MATH_RE);
  if (match) {
    const [, anchor, op, amountStr, unit] = match;
    let base: Date;
    if (anchor === "today") {
      base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    } else {
      base = new Date(now);
    }
    if (op && amountStr && unit) {
      const amount = parseInt(amountStr, 10) * (op === "-" ? -1 : 1);
      switch (unit) {
        case "h": base.setTime(base.getTime() + amount * 3600000); break;
        case "d": base.setUTCDate(base.getUTCDate() + amount); break;
        case "w": base.setUTCDate(base.getUTCDate() + amount * 7); break;
        case "m": base.setUTCMonth(base.getUTCMonth() + amount); break;
      }
    }
    return base;
  }
  // Absolute date fallback
  const parsed = new Date(expr);
  if (isNaN(parsed.getTime())) {
    throw new Error(`Invalid date expression: "${expr}". Use @today-Nd, @now-Nh, or YYYY-MM-DD.`);
  }
  return parsed;
}
```

## Risks

1. **`list_project_items` pagination ceiling**: With `maxItems = args.limit`, heavy date filtering may return far fewer results than expected. Mitigation: increase `maxItems` when filters are active.
2. **Timezone ambiguity**: `@today` should resolve to UTC midnight to be deterministic. Document this clearly.
3. **No server-side filtering**: GitHub Projects V2 GraphQL API does not support `updatedAt` predicates in queries. All filtering is client-side after fetching up to 500 items. For very large projects, this may miss items beyond the 500-item ceiling.
4. **Month arithmetic edge cases**: `@today-1m` from March 31 → February 28/29. Standard `Date.setUTCMonth` handles this but results may surprise users.

## Recommended Next Steps

1. Create `lib/date-math.ts` with `parseDateMath` function
2. Add `__tests__/date-math.test.ts` with comprehensive unit tests
3. Add `updatedSince`/`updatedBefore` to `list_issues` zod schema and filter chain
4. Add `updatedAt` to `list_project_items` Issue GraphQL fragment
5. Add `updatedSince`/`updatedBefore` to `list_project_items` zod schema and filter chain
6. Include `updatedAt` in formatted response for both tools
7. Add structural tests for new params in existing test files
