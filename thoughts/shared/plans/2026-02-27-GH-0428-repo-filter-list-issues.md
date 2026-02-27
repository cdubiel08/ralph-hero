---
date: 2026-02-27
status: draft
github_issues: [428]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/428
primary_issue: 428
---

# Add repo filter to list_issues - Implementation Plan

## Overview

1 issue for implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-428 | Add repo filter to list_issues for multi-repo project boards | S |

## Current State Analysis

`list_issues` (`issue-tools.ts:52`) fetches up to 500 project items via GraphQL and applies 17 client-side filter steps (lines 237–388). The `... on Issue` content fragment (lines 203–214) does **not** include `repository` data, making it impossible to filter by source repo on multi-repo project boards.

The pattern for including `repository` in a `... on Issue` fragment already exists in `project-tools.ts:913–921`. All existing filters follow the same sequential `.filter()` chain pattern.

## Desired End State

### Verification
- [ ] `list_issues` accepts an optional `repoFilter` parameter (string, case-insensitive)
- [ ] `repoFilter: "my-repo"` filters by `repository.name` (short format)
- [ ] `repoFilter: "owner/my-repo"` filters by `repository.nameWithOwner` (full format)
- [ ] Omitting `repoFilter` returns all items (backward compatible)
- [ ] All existing tests pass
- [ ] New structural tests verify the parameter and filter logic exist
- [ ] `npm run build` succeeds

## What We're NOT Doing

- Not adding `repoFilter` to the tool description string (description is already long enough; the Zod `.describe()` is sufficient for MCP tool discovery)
- Not adding `excludeRepos` (exclusion variant) — can be a follow-up if needed
- Not adding repository data to the formatted response output — only using it for filtering (keeps response payload unchanged)
- Not modifying `RawProjectItem` interface — `content` is `Record<string, unknown>` and accessed via cast-at-access pattern
- Not addressing #429 (multi-repo inference) or #430 (dashboard grouping) — those are separate issues

## Implementation Approach

Three focused additions to `issue-tools.ts`, plus structural tests. No new files, no interface changes, no dependency additions.

---

## Phase 1: GH-428 — Add repo filter to list_issues

> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/428 | **Research**: thoughts/shared/research/2026-02-27-GH-0428-repo-filter-list-issues.md

### Changes Required

#### 1. Add `repository` to GraphQL fragment

**File**: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts`
**Location**: Lines 203–214 (inside `... on Issue` block)
**Change**: Add `repository { name nameWithOwner }` after the `assignees` field (line 213)

```graphql
... on Issue {
  number
  title
  body
  state
  stateReason
  url
  createdAt
  updatedAt
  labels(first: 10) { nodes { name } }
  assignees(first: 5) { nodes { login } }
  repository { name nameWithOwner }
}
```

**Pattern reference**: `project-tools.ts:913–921` uses the same `repository { nameWithOwner name owner { login } }` pattern. We only need `name` and `nameWithOwner` for filtering (not `owner { login }`).

#### 2. Add `repoFilter` parameter to Zod schema

**File**: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts`
**Location**: After line 87 (`label` param), before line 88 (`query` param)
**Change**: Add new optional string parameter

```typescript
repoFilter: z
  .string()
  .optional()
  .describe(
    "Filter items to only those from the specified repository. " +
    "Accepts 'name' or 'owner/name' format. Case-insensitive.",
  ),
```

**Why `repoFilter` not `repo`**: The existing `repo` param (line 62–65) is a **config parameter** for resolving the project owner. Using the same name would shadow it and cause confusion. `repoFilter` is unambiguous.

#### 3. Add client-side filter logic

**File**: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts`
**Location**: After the label filter block (line 289), before the `has` filter (line 291)
**Change**: Insert new filter step

```typescript
// Filter by repository
if (args.repoFilter) {
  const rf = args.repoFilter.toLowerCase();
  const useFullName = rf.includes("/");
  items = items.filter((item) => {
    const content = item.content as Record<string, unknown> | null;
    const repo = content?.repository as
      | { name?: string; nameWithOwner?: string }
      | undefined;
    const repoName = useFullName
      ? repo?.nameWithOwner?.toLowerCase()
      : repo?.name?.toLowerCase();
    return repoName === rf;
  });
}
```

**Why this approach**:
- Follows the exact same pattern as the label filter (lines 281–289): extract `content`, cast, traverse, compare
- Case-insensitive via `.toLowerCase()` (GitHub repo names are case-insensitive)
- `/` detection determines format: `"backend"` matches `name`, `"myorg/backend"` matches `nameWithOwner`
- Items without a `repository` field (shouldn't exist after the type gate at line 237, but safe) are filtered out

#### 4. Add structural tests

**File**: `plugin/ralph-hero/mcp-server/src/__tests__/issue-tools.test.ts`
**Location**: After the `exclude negation filters` describe block (line 128)
**Change**: Add new describe block

```typescript
describe("list_issues repoFilter structural", () => {
  it("Zod schema includes repoFilter param", () => {
    expect(issueToolsSrc).toContain("repoFilter: z");
  });

  it("GraphQL query fetches repository data", () => {
    expect(issueToolsSrc).toContain("repository { name nameWithOwner }");
  });

  it("filter logic uses case-insensitive comparison", () => {
    expect(issueToolsSrc).toContain("args.repoFilter.toLowerCase()");
  });

  it("supports both name and nameWithOwner formats", () => {
    expect(issueToolsSrc).toContain('rf.includes("/")');
  });
});
```

### Success Criteria

- [ ] Automated: `cd plugin/ralph-hero/mcp-server && npm test` — all tests pass (existing + 4 new)
- [ ] Automated: `cd plugin/ralph-hero/mcp-server && npm run build` — compiles without errors
- [ ] Manual: Verify `repoFilter` appears in the Zod schema output (tool discovery)

---

## Integration Testing

- [ ] `npm test` passes all tests (existing tests unmodified, 4 new tests added)
- [ ] `npm run build` compiles successfully
- [ ] No TypeScript errors in `issue-tools.ts`

## References

- Research: [thoughts/shared/research/2026-02-27-GH-0428-repo-filter-list-issues.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-27-GH-0428-repo-filter-list-issues.md)
- Prior multi-repo research: [thoughts/shared/research/2026-02-26-multi-repo-enterprise-project-management.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-26-multi-repo-enterprise-project-management.md)
- Related issues: #429 (multi-repo inference fallback), #430 (dashboard repo grouping)
