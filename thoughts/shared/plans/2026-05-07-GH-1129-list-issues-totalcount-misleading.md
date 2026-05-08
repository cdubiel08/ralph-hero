---
date: 2026-05-07
status: draft
type: plan
github_issue: 1129
github_issues: [1129]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1129
primary_issue: 1129
tags: [list-issues, graphql, pagination, api-response, bug-fix]
---

# GH-1129: list_issues `totalCount` is misleading — Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-05-07-GH-1129-list-issues-totalcount-misleading]]

## Overview

Single-issue plan to fix the misleading `totalCount` field in the `ralph_hero__list_issues` MCP tool response by removing it (Option 1 from the research doc).

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-1129 | list_issues: `totalCount` is misleading — reports all-time project items, not filtered open issues | XS |

## Shared Constraints

- **Module system**: ESM with `"module": "NodeNext"`. All internal imports use `.js` extensions even for TypeScript source.
- **Build/typecheck gate**: `npm run build` (`tsc`) is the primary code-quality gate; strict mode enabled.
- **Test runner**: vitest 4. Tests in `src/__tests__/` are excluded from `tsc` build but run via `vitest run`.
- **Tool response shape**: Use `toolSuccess(...)` / `toolError(...)` helpers from `src/types.ts`.
- **Behavior preservation**: `filteredCount` must remain unchanged and accurate. The pagination helper (`paginateConnection` / `PaginatedResponse<T>`) must NOT be modified — other callers (e.g., `project-tools.ts`) still rely on its `totalCount` return shape.
- **Test pattern**: `issue-tools.test.ts` uses string-based structural assertions over the source file (`fs.readFileSync` of `issue-tools.ts`). New regression tests follow this style — no live API mocking.
- **Auto-release awareness**: Changes to `mcp-server/` source on a merge to `main` will auto-bump the patch version and publish to npm. Field removal is a breaking change to the response shape; document in commit message.

## Current State Analysis

`ralph_hero__list_issues` (registered at `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts:62-505`) returns a response with three fields:

```typescript
return toolSuccess({
  totalCount: itemsResult.totalCount,  // ← misleading: board total, not filter total
  filteredCount: formattedItems.length,
  items: formattedItems,
});
```

The `totalCount` value comes from the `ProjectV2.items` GraphQL connection (line 221), which counts **every item ever added to the project board** — open + closed issues, merged + closed PRs, and draft issues — regardless of any filter. For a long-lived project this can be 20× the actual open issue count (reproduction: 699 board items vs. 33 open issues), causing analyst confusion.

The pagination helper (`src/lib/pagination.ts:46-100`) captures `totalCount` from the first page and returns it in `PaginatedResponse<T>`. This is consumed by other tools (e.g., `project-tools.ts:468` uses `totalRepos: project.repositories.totalCount`) so the helper must stay intact — only the `list_issues` response field is removed.

`filteredCount` already accurately reports the post-filter count callers need. Searching the plugin tree confirms no skill, agent, or hook reads `totalCount` from a `list_issues` response, and no test asserts its value.

## Desired End State

`ralph_hero__list_issues` returns only `{ filteredCount, items }`. The misleading `totalCount` field is gone from the response. A structural test asserts the field's absence to prevent regression.

### Verification

- [x] `ralph_hero__list_issues` response no longer contains a `totalCount` key
- [x] `filteredCount` and `items` continue to reflect the post-filter result set unchanged
- [x] `npm run build` passes with no errors
- [x] `npm test` passes (existing tests unchanged + new regression test green)
- [x] No other tool's response shape is altered (only `list_issues`)

## What We're NOT Doing

- Not changing the `paginateConnection` helper or `PaginatedResponse<T>` type — other callers depend on it.
- Not implementing Option 2 (rename to `boardItemsTotal`) or Option 3 (compute true filtered total via second query) from the research doc — both add cost or clutter for no clear benefit given `filteredCount` already exists.
- Not removing the `totalCount` field from the GraphQL query selection set itself — this is a cosmetic payload-size optimization noted in the research doc but out of scope for the bug fix. Leaving it keeps the diff minimal.
- Not modifying the tool description string — it does not currently mention `totalCount` in its Returns clause.
- Not adding a deprecation period — there are no internal consumers, and the misleading semantics make a clean removal preferable.

## Implementation Approach

A single phase containing two minimal tasks: source change and regression test. Tasks are sequential because the regression test asserts the source change.

---

## Phase 1: Remove misleading `totalCount` field from list_issues response
- **depends_on**: null

### Overview

Delete the `totalCount: itemsResult.totalCount` line from the `toolSuccess` return at `issue-tools.ts:496`, then add a structural test to `issue-tools.test.ts` that asserts the field is absent from the source.

### Tasks

#### Task 1.1: Remove `totalCount` from list_issues response
- **files**: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [x] Line `totalCount: itemsResult.totalCount,` is deleted from the `toolSuccess` call (currently at line 496)
  - [x] The remaining `toolSuccess` call returns `{ filteredCount: formattedItems.length, items: formattedItems }`
  - [x] No other lines in `issue-tools.ts` are modified — the GraphQL query at line 221 still selects `totalCount` (cosmetic payload field, intentionally left alone)
  - [x] `itemsResult.totalCount` is no longer referenced anywhere in the `list_issues` handler scope (may still be referenced inside `paginateConnection` internals — that is fine)
  - [x] `npm run build` passes (no TS errors from the change)

#### Task 1.2: Add structural regression test asserting `totalCount` is absent from list_issues response
- **files**: `plugin/ralph-hero/mcp-server/src/__tests__/issue-tools.test.ts` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [x] A new `describe("list_issues totalCount removal (GH-1129)", ...)` block is added to the existing test file, following the file's structural-assertion style (uses `issueToolsSrc` already loaded at top of file via `fs.readFileSync`)
  - [x] Includes an assertion that `issueToolsSrc` does NOT contain the literal substring `totalCount: itemsResult.totalCount` (regression guard)
  - [x] Includes an assertion that `issueToolsSrc` DOES contain `filteredCount: formattedItems.length` (positive guard — confirms the surviving field stays)
  - [x] `npm test` passes including the new tests
  - [x] Existing tests are not modified

### Phase Success Criteria

#### Automated Verification:

- [x] `npm run build` (in `plugin/ralph-hero/mcp-server/`) — no errors
- [x] `npm test` (in `plugin/ralph-hero/mcp-server/`) — all passing including the two new structural assertions
- [x] `npx vitest run src/__tests__/issue-tools.test.ts` — passes

#### Manual Verification:

- [ ] Inspect the `list_issues` response shape via a manual MCP call (e.g., from Claude Code) and confirm the response object has only `filteredCount` and `items` keys
- [ ] Confirm `filteredCount` value remains accurate against a known-state filter

---

## Integration Testing

- [ ] After implementation, run a representative `list_issues` call against the live ralph-hero project (e.g., `workflowState="Backlog"`) and confirm the response is `{ filteredCount: N, items: [...] }` with no `totalCount` field, and that the count value matches `gh issue list` for the equivalent filter.

## References

- Research: [thoughts/shared/research/2026-05-07-GH-1129-list-issues-totalcount-misleading.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-05-07-GH-1129-list-issues-totalcount-misleading.md)
- Issue: https://github.com/cdubiel08/ralph-hero/issues/1129
- Source: [plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts:495-499](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L495-L499)
- Test file: [plugin/ralph-hero/mcp-server/src/__tests__/issue-tools.test.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/__tests__/issue-tools.test.ts)
