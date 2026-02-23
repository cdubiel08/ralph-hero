---
date: 2026-02-23
github_issue: 311
github_url: https://github.com/cdubiel08/ralph-hero/issues/311
status: complete
type: research
---

# GH-311: Improve Draft Issue Management — Archive, Remove, and List Support

## Problem Statement

Draft issues in GitHub Projects V2 cannot be managed via the MCP tools once created. The three gaps are:

1. **Archive/Remove**: `archive_item` and `remove_from_project` both call `resolveProjectItemId()`, which requires an integer issue number. Draft issues have no issue number — they exist only in the project, not in a repository.
2. **List/Identify**: `list_project_items` supports `DRAFT_ISSUE` type filtering (implemented in GH-108) but does not return the draft's content node ID (`DI_*`). Without this ID, `update_draft_issue` cannot be called on any draft discovered through listing.
3. **DI_* retrieval path**: `create_draft_issue` returns only the project item ID (`PVTI_*`). After creation the draft's content node ID is unavailable through any existing tool.

## Current State Analysis

### Tool Coverage Matrix

| Operation | Tool | Works on Drafts? | Root Cause |
|-----------|------|-------------------|------------|
| Create | `create_draft_issue` | Yes | Uses `addProjectV2DraftIssue` |
| Update content | `update_draft_issue` | Yes (if DI_* known) | Uses `updateProjectV2DraftIssue` with `draftIssueId` |
| Archive | `archive_item` | **No** | Calls `resolveProjectItemId(number)` — no number on drafts |
| Remove/delete | `remove_from_project` | **No** | Same `resolveProjectItemId` dependency |
| List | `list_project_items` | Partial | `itemType: "DRAFT_ISSUE"` filter works; `PVTI_*` returned; `DI_*` not returned |
| Discover DI_* | _(none)_ | **No** | No tool exposes the draft content ID after creation |

### Why `archive_item` and `remove_from_project` Fail for Drafts

`resolveProjectItemId` at [`lib/helpers.ts:154-218`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/helpers.ts#L154) performs a two-step resolution:

1. `resolveIssueNodeId(client, owner, repo, issueNumber)` — queries `repository(owner, name).issue(number: N)`. Draft issues are not repository issues; this returns `null`.
2. `node(id: $issueId) { ... on Issue { projectItems { ... } } }` — the `... on Issue` fragment would not match a `DraftIssue` node even if a DI_* ID were passed.

Both `archive_item` and `remove_from_project` expose only `number: z.coerce.number()` with no alternative path. There is no way to pass a `PVTI_*` ID directly to these tools today.

### `list_project_items` — What Works vs What's Missing

The `DRAFT_ISSUE` type filter was implemented in GH-108 and works correctly at [`project-tools.ts:838-843`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-tools.ts#L838).

The GraphQL query returns `PVTI_*` item IDs for all types including drafts. However, the DraftIssue content fragment at [`project-tools.ts:930-933`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-tools.ts#L930) only selects `title` and `body`:

```graphql
... on DraftIssue {
  title
  body
  # missing: id  ← the DI_* content node ID
}
```

The formatted response includes `itemId` (`PVTI_*`) but has no field for the `DI_*` content ID. This means callers who need to call `update_draft_issue` after listing cannot do so without storing the `DI_*` from the original `create_draft_issue` call.

### `create_draft_issue` — Returns PVTI_* Only

The mutation response at [`project-management-tools.ts:455-467`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts#L455) selects:

```graphql
addProjectV2DraftIssue(input: { ... }) {
  projectItem { id }   # PVTI_* only
}
```

The `DI_*` content node ID is accessible by also selecting `projectItem { id content { ... on DraftIssue { id } } }` but this is not currently done. The tool returns `{ projectItemId, title, fieldsSet }` — no `draftIssueId`.

## Key Discoveries

### 1. GitHub GraphQL API Fully Supports Draft Archive/Remove via PVTI_*

Both `archiveProjectV2Item` and `deleteProjectV2Item` operate on the `ProjectV2Item` wrapper, not on item content. They accept `PVTI_*` IDs uniformly for all item types:

```graphql
mutation($projectId: ID!, $itemId: ID!) {
  deleteProjectV2Item(input: { projectId: $projectId, itemId: $itemId }) {
    deletedItemId
  }
}
```

```graphql
mutation($projectId: ID!, $itemId: ID!) {
  archiveProjectV2Item(input: { projectId: $projectId, itemId: $itemId }) {
    item { id }
  }
}
```

There is **no** `deleteProjectV2DraftIssue` mutation. The standard `deleteProjectV2Item` covers draft removal.

### 2. The Fix Is Additive — No Existing Code Needs Restructuring

`archive_item` and `remove_from_project` already call the correct GraphQL mutations with `projectItemId`. The only barrier is that `resolveProjectItemId()` is called unconditionally. Adding an optional `projectItemId` bypass resolves this without changing the mutations or existing issue-number flow.

### 3. Two ID Types — PVTI_* and DI_*

| Prefix | Type | Purpose | Obtained From |
|--------|------|---------|---------------|
| `PVTI_*` | `ProjectV2Item` | Board row — used for archive, remove, field updates | `create_draft_issue` response, `list_project_items` `itemId` |
| `DI_*` | `DraftIssue` | Content node — required by `updateProjectV2DraftIssue` | Not currently returned by any tool after creation |

### 4. `ProjectV2Item.updatedAt` Is Available for All Types

The `updatedAt` timestamp lives on the `ProjectV2Item` wrapper, not the content node. This means `bulk_archive`'s `updatedBefore` filter can be applied to drafts — but the current implementation reads `updatedAt` from the content fragments (`... on Issue`, `... on PullRequest`) not from the item wrapper. Drafts fall through with `undefined` and are excluded from date-based filtering. This is a pre-existing bug surfaced by this research.

### 5. `list_project_items` DraftIssue Fragment Needs `id`

Adding `id` to the `DraftIssue` fragment is a one-line GraphQL change. The `DI_*` ID returned can then be surfaced as `draftIssueId` in the formatted response, enabling a `list → update_draft_issue` workflow.

## Files Affected

### Will Modify
- `plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts` — Add `projectItemId` optional param to `archive_item` and `remove_from_project`; update `create_draft_issue` mutation to also return `DI_*` content ID
- `plugin/ralph-hero/mcp-server/src/tools/project-tools.ts` — Add `id` to DraftIssue GraphQL fragment; expose as `draftIssueId` in formatted response
- `plugin/ralph-hero/mcp-server/src/__tests__/project-management-tools.test.ts` — Add tests for draft-aware archive and remove (direct projectItemId path)
- `plugin/ralph-hero/mcp-server/src/__tests__/project-tools.test.ts` — Add test for DI_* in list_project_items draft response

### Will Read (Dependencies)
- `plugin/ralph-hero/mcp-server/src/lib/helpers.ts` — `resolveProjectItemId` function that is bypassed when `projectItemId` is provided directly
- `plugin/ralph-hero/mcp-server/src/types.ts` — `DraftIssue` interface (may need `id` field added)

## Potential Approaches

### Approach A: `projectItemId` Optional Bypass (Recommended)

Add an optional `projectItemId: z.string().optional()` parameter to `archive_item` and `remove_from_project`. When provided, skip `resolveProjectItemId()` and use the provided ID directly as `itemId` in the mutation. Require `number` OR `projectItemId` (one must be provided).

```typescript
// archive_item schema addition:
projectItemId: z.string().optional().describe(
  "Project item ID (PVTI_...) — use for draft issues which have no issue number"
),

// handler logic:
const projectItemId = args.projectItemId
  ?? await resolveProjectItemId(client, fieldCache, owner, repo, args.number!, projectNumber);
```

**Pros:**
- Minimal change — single conditional per tool
- Backward compatible — existing callers unaffected
- Consistent with `add_to_project` which already uses `contentId` directly
- Same mutation, same path, just skips the resolution step

**Cons:**
- Requires callers to have stored the `PVTI_*` from `create_draft_issue` or from `list_project_items`

### Approach B: New `delete_draft_issue` and `archive_draft_issue` Tools

Dedicated tools that accept `projectItemId` only.

**Pros:** Cleaner discovery via tool name, explicit for drafts

**Cons:** Redundant — `deleteProjectV2Item` already handles both. Duplicates mutation code. Inflates tool count. The existing tools accepting `projectItemId` directly is sufficient and simpler.

### Approach C: Auto-detect from `list_project_items` (Not Recommended)

Have `archive_item` / `remove_from_project` first query project items to find the draft's PVTI_* by title match.

**Cons:** Fragile (title collisions), adds latency, not how the tool is designed.

### Recommended: Approach A + DI_* exposure

1. **`archive_item` + `remove_from_project`**: Add optional `projectItemId` bypass (Approach A)
2. **`list_project_items`**: Add `id` to DraftIssue fragment → expose as `draftIssueId` in response
3. **`create_draft_issue`**: Extend mutation selection to also return `DI_*` content ID → expose as `draftIssueId` in response

This creates a complete lifecycle: `create` (get PVTI_* + DI_*) → `update` (use DI_*) → `archive`/`remove` (use PVTI_*), and `list` provides all IDs needed for any subsequent operation.

## Risks

1. **`archiveProjectV2Item` on draft items**: The GitHub GraphQL documentation treats all item types uniformly for archive/delete, but there is no community-confirmed test case specifically for archiving draft items. The API schema allows it, but if GitHub rejects it silently, the tool should surface a clear error.
2. **Cache invalidation for `remove_from_project` with `projectItemId`**: Currently the cache invalidation key is `project-item-id:${owner}/${repo}#${args.number}`. With a direct `projectItemId` bypass, there is no `number` to invalidate. For drafts this is acceptable (no cache entry was ever written for them), but the invalidation call must be skipped when `args.number` is absent.
3. **Validation**: Each tool should enforce that exactly one of `number` or `projectItemId` is provided. Zod `.refine()` can enforce this.
4. **`bulk_archive` date filter exclusion of drafts**: The pre-existing bug (drafts excluded from `updatedBefore` filter) is out of scope for this issue but should be tracked separately.

## Recommended Next Steps

1. Modify `archive_item`: add `projectItemId` optional param; skip `resolveProjectItemId` when provided; skip cache invalidation when `number` is absent
2. Modify `remove_from_project`: same pattern
3. Modify `create_draft_issue` GraphQL selection to include `projectItem { id content { ... on DraftIssue { id } } }`; return `draftIssueId` alongside `projectItemId`
4. Modify `list_project_items` DraftIssue fragment to include `id`; add `draftIssueId` to formatted draft item response
5. Add tests for all four changes
6. File separate issue for `bulk_archive` draft `updatedBefore` gap
