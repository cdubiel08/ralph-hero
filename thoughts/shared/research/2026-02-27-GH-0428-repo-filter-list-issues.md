---
date: 2026-02-27
github_issue: 428
github_url: https://github.com/cdubiel08/ralph-hero/issues/428
status: complete
type: research
---

# GH-428: Add repo filter to list_issues for multi-repo project boards

## Problem Statement

When a GitHub Projects V2 board spans multiple repositories (e.g., `frontend`, `backend`, `infra`), there is no way to filter `list_issues` results by source repository. The tool queries by project items via project node ID and returns all issues from all linked repositories without any repo-level filter.

This is **Limitation L2** identified in the multi-repo enterprise research (`thoughts/shared/research/2026-02-26-multi-repo-enterprise-project-management.md`): "No Repo-Aware List Filtering."

## Current State Analysis

### What `list_issues` does today

`list_issues` (`issue-tools.ts:52`) fetches up to 500 project items via a single GraphQL query keyed by project node ID, then applies all filtering **client-side** via a chain of `.filter()` calls. There are 17 filtering steps applied sequentially (lines 237–388).

### The missing piece: repository data in the GraphQL fragment

The `... on Issue` content fragment (lines 202–214) currently returns:

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
}
```

**There is no `repository` field.** The GitHub Projects V2 API supports `repository { name, nameWithOwner }` on `Issue` content items, and this is already used in `project-tools.ts:913–921` as an established pattern:

```graphql
... on Issue {
  number
  title
  state
  url
  updatedAt
  labels(first: 10) { nodes { name } }
  assignees(first: 5) { nodes { login } }
  repository { nameWithOwner name owner { login } }
}
```

This means the data is available from GitHub's API but not being requested in `list_issues`.

### Client-side filtering pattern

All existing filters follow the same pattern. The closest model for a repo filter is the label filter (lines 281–289):

```typescript
if (args.label) {
  items = items.filter((item) => {
    const content = item.content as Record<string, unknown> | null;
    const labels =
      (content?.labels as { nodes: Array<{ name: string }> })?.nodes || [];
    return labels.some((l) => l.name === args.label);
  });
}
```

A repo filter would follow the exact same pattern — extract from `content`, cast, traverse, compare.

### `repo` config vs. `repo` filter — an important distinction

The existing `repo` parameter in the `list_issues` schema (line 62–65) is a **configuration parameter** used for:
- Resolving the project owner (via `resolveFullConfig`)
- Issue mutation operations (create, update)

It is **not used as a filter** in the `list_issues` query. The new filter parameter must be named distinctly to avoid ambiguity — `repoFilter` is the clearest option (or alternatively `filterByRepo`). Using `repo` itself would shadow the config parameter and cause confusion.

### Multi-repo context in config

When multiple repos are linked to a project, `resolveRepoFromProject` (`helpers.ts:420–456`) throws an error at startup unless `RALPH_GH_REPO` is explicitly set. Issue #429 addresses this graceful fallback. The repo filter in #428 is orthogonal — it operates after items are fetched, regardless of what `client.config.repo` resolves to.

## Key Discoveries

### 1. Exact GraphQL change location (`issue-tools.ts:203–214`)

The `... on Issue` block starts at line 203. Adding `repository { name nameWithOwner }` before the closing brace of the fragment is the only GraphQL change needed. The field must be inside the `... on Issue` discriminated union because `DraftIssue` items do not have a `repository` field — placing it outside would cause a type error for non-Issue items.

### 2. Filter insertion point (`issue-tools.ts:289–292`)

The best insertion point is immediately after the label filter (line 289) and before the `has` filter (line 292). This maintains the ordering convention (positive inclusion filters before presence filters, exclusion filters, date filters).

### 3. Both `name` and `nameWithOwner` formats should be supported

The issue description calls for supporting both `name` (`backend`) and `owner/name` (`myorg/backend`) formats. Implementation:
- If `repoFilter` contains `/`, compare against `content.repository.nameWithOwner`
- Otherwise, compare against `content.repository.name`

This is consistent with how GitHub's own APIs handle repo identity.

### 4. Case-insensitive comparison is appropriate

GitHub repo names are case-insensitive. The comparison should use `.toLowerCase()` on both sides to prevent user frustration with `Backend` vs `backend`.

### 5. Test pattern is structural string-based (`__tests__/issue-tools.test.ts:74–128`)

The existing tests for `has`/`no` filters use structural string matching on the source file (`expect(issueToolsSrc).toContain(...)`). New tests for `repoFilter` should follow this exact pattern for consistency.

### 6. `RawProjectItem` type does not need changing

`content` is typed as `Record<string, unknown>` (line 1814), so adding `repository` to the GraphQL response requires no TypeScript interface changes — the same cast-at-access pattern used in the label filter applies.

## Potential Approaches

### Approach A: Client-side filter only (Recommended)

Add `repository { name nameWithOwner }` to the GraphQL fragment and add a new `repoFilter` parameter with client-side filtering logic.

**Pros:**
- Minimal change surface — 3 focused additions to one file
- Consistent with all other filter params
- No new API calls
- Backward compatible (optional param, undefined = no filter)
- No performance impact for single-repo boards

**Cons:**
- Still fetches all items from all repos, then discards non-matching ones
- Up to 500 items fetched even if only 10 match the repo filter

### Approach B: Server-side (GraphQL-level) repo filtering

Pass the repo name as a variable and filter in the GraphQL query.

**Pros:**
- Reduced payload for large multi-repo boards

**Cons:**
- GitHub Projects V2 API does not support `items(filter: {repository: ...})` — the API only supports `items(first: N)` with no content-level filtering. This approach is **not possible** with the current GitHub GraphQL API.

Approach A is the only viable option.

## Risks and Edge Cases

| Risk | Severity | Mitigation |
|------|----------|-----------|
| `DraftIssue` items have no `repository` field | Medium | Filter is only applied to `Issue` type items (enforced by type gate at line 237). DraftIssues are already excluded before the repo filter runs. |
| Case sensitivity mismatch | Low | Use case-insensitive comparison (`.toLowerCase()`) |
| `repoFilter` param shadows config `repo` | Medium | Use distinct parameter name `repoFilter`, not `repo` |
| Query payload size increase | Low | `repository { name nameWithOwner }` adds ~2 fields per item — negligible |
| `nameWithOwner` format for cross-org repos | Low | Already handled by the `owner/name` vs `name` format split |

## Recommended Next Steps

1. Add `repository { name nameWithOwner }` to the `... on Issue` fragment in `list_issues` GraphQL query (`issue-tools.ts:203–214`)
2. Add `repoFilter: z.string().optional()` parameter to the Zod schema with description: `"Filter items to only those from the specified repository. Accepts 'name' or 'owner/name' format. Case-insensitive."`
3. Add filter logic after the label filter (line 289), checking `content.repository.name` (short format) or `content.repository.nameWithOwner` (full format)
4. Add structural tests in `__tests__/issue-tools.test.ts` following the existing string-matching test pattern
5. Update the MCP tool description to mention the new parameter

## Files Affected

### Will Modify
- `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts` - Add `repository` to GraphQL fragment, add `repoFilter` Zod param, add filter logic
- `plugin/ralph-hero/mcp-server/src/__tests__/issue-tools.test.ts` - Add structural tests for `repoFilter`

### Will Read (Dependencies)
- `plugin/ralph-hero/mcp-server/src/tools/project-tools.ts` - Reference implementation of `repository { name nameWithOwner }` in `... on Issue` fragment (lines 913–921)
- `plugin/ralph-hero/mcp-server/src/lib/helpers.ts` - `resolveFullConfig` flow, multi-repo inference context (lines 462–501)
- `thoughts/shared/research/2026-02-26-multi-repo-enterprise-project-management.md` - Prior research establishing L2 gap context
