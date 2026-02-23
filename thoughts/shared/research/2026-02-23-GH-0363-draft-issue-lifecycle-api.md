---
date: 2026-02-23
github_issue: 363
github_url: https://github.com/cdubiel08/ralph-hero/issues/363
status: complete
type: research
---

# GH-363: Research GitHub API for Converting Draft Issues to Real Issues

## Problem Statement

Ralph's MCP tools can create and update draft issues (`create_draft_issue`, `update_draft_issue`) but have no lifecycle management beyond that. The `archive_item` and `remove_from_project` tools require an issue `number` parameter, making them unusable for draft issues (which have no issue number). There is also no tool to convert a draft issue into a real repository issue.

There are currently 6 draft issues on the board with no programmatic path to archive, delete, or convert them.

## Current State Analysis

### Existing Tools and Their Limitations

**`ralph_hero__archive_item`** ([`project-management-tools.ts:44-115`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts#L44)):
- Requires `number: z.coerce.number()` (issue number)
- Calls `resolveProjectItemId(client, fieldCache, owner, repo, args.number, projectNumber)` to resolve `PVTI_` ID
- Draft issues have no issue number → this tool cannot be used on drafts

**`ralph_hero__remove_from_project`** ([`project-management-tools.ts:120-179`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts#L120)):
- Same issue: requires `number`, calls `resolveProjectItemId`
- Draft items → completely unusable

**`ralph_hero__create_draft_issue`** ([`project-management-tools.ts:422-493`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts#L422)):
- Returns `projectItemId` (`PVTI_` prefix)
- Calls `addProjectV2DraftIssue` → returns `projectItem.id` (`PVTI_`)
- No `DI_` ID is returned or stored

**`ralph_hero__update_draft_issue`** ([`project-management-tools.ts:498-549`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts#L498)):
- Requires `draftIssueId` (`DI_` prefix, content node ID)
- Calls `updateProjectV2DraftIssue` which requires the content node, not the project item wrapper

### Two Distinct Node IDs for Draft Issues

Draft issues expose two separate node IDs that serve different purposes:

| Prefix | GraphQL Type | Represents | Used By |
|--------|-------------|------------|---------|
| `PVTI_...` | `ProjectV2Item` | Project item wrapper | `archiveProjectV2Item`, `deleteProjectV2Item`, `convertProjectV2DraftIssueItemToIssue` |
| `DI_...` | `DraftIssue` | Draft content node | `updateProjectV2DraftIssue` exclusively |

`create_draft_issue` returns `projectItemId` (`PVTI_`) but **not** the `DI_` content ID. To use `update_draft_issue` the caller must separately query for the `DI_` ID:

```graphql
query {
  node(id: "PVT_...") {
    ... on ProjectV2 {
      items(first: 20) {
        nodes {
          id            # PVTI_... (project item)
          content {
            ... on DraftIssue {
              id        # DI_... (content node)
              title
            }
          }
        }
      }
    }
  }
}
```

## Key Discoveries

### 1. `convertProjectV2DraftIssueItemToIssue` Mutation Exists

The mutation is available in the GitHub GraphQL API:

```graphql
mutation($itemId: ID!, $repositoryId: ID!) {
  convertProjectV2DraftIssueItemToIssue(input: {
    itemId: $itemId           # PVTI_... project item node ID
    repositoryId: $repositoryId  # R_... repository node ID
  }) {
    item { id }
  }
}
```

- `itemId`: The `PVTI_` project item node ID (returned by `create_draft_issue`)
- `repositoryId`: The `R_` repository node ID (fetchable from the repo or the linked project)
- Returns: The converted `ProjectV2Item` with the new issue as content
- Side effect: The draft content (`DI_`) is permanently replaced by a real issue

**Critical caveat**: This mutation fails with **fine-grained PATs** as of early 2026. The API returns `"User does not have access to this repository"` despite correct permissions. Classic PATs work. GitHub has acknowledged the bug with no fix timeline. The workaround is: (1) create issue via REST API, (2) add to project via `addProjectV2ItemById`, (3) delete draft via `deleteProjectV2Item`.

### 2. `archiveProjectV2Item` Works for Drafts

The existing `archiveProjectV2Item` mutation accepts the `PVTI_` project item ID and works for draft items:

```graphql
mutation($projectId: ID!, $itemId: ID!) {
  archiveProjectV2Item(input: {
    projectId: $projectId
    itemId: $itemId           # PVTI_... works for drafts
  }) {
    item { id }
  }
}
```

Archiving is **recoverable** — drafts appear in the project archive view and can be restored. The `ralph_hero__archive_item` tool already uses this mutation; the only gap is the `number`-based lookup path.

### 3. `deleteProjectV2Item` Works for Drafts (Permanently)

The existing `deleteProjectV2Item` mutation accepts `PVTI_` IDs and works for drafts:

```graphql
mutation($projectId: ID!, $itemId: ID!) {
  deleteProjectV2Item(input: {
    projectId: $projectId
    itemId: $itemId           # PVTI_... works for drafts
  }) {
    deletedItemId
  }
}
```

**Key behavioral difference from regular issues**: For regular issues/PRs, this mutation only removes the item from the project (the underlying issue persists). For draft issues, this is a **permanent destruction** of the content — the `DI_` node is gone. There is no "soft delete" for drafts.

### 4. `update_draft_issue` Currently Uses Wrong Return Field

The current `update_draft_issue` implementation ([`project-management-tools.ts:527-538`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts#L527)) queries `projectItem { id }` in the mutation return but the `updateProjectV2DraftIssue` mutation returns `draftIssue { id }` not `projectItem`. This is tracked in GH-350.

### 5. Repository Node ID Resolution

Converting a draft requires a repository node ID (`R_...`). This can be fetched via:

```graphql
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    id  # R_...
  }
}
```

The MCP server already resolves owner/repo from env vars, so this can be fetched as a pre-step in a `convert_draft_issue` tool.

## Potential Approaches

### Approach A: Add `projectItemId` parameter to `archive_item` and `remove_from_project` (Recommended for lifecycle)

Extend the two existing tools to accept either `number` (for real issues) or `projectItemId` (for drafts). Only one must be provided.

**Pros**: No new tools, backwards compatible, users already know these tool names.
**Cons**: Slightly more complex parameter handling.

### Approach B: New `delete_draft_issue` and `archive_draft_issue` tools

Dedicated tools that accept only `projectItemId` (no issue number).

**Pros**: Clean separation, clear documentation.
**Cons**: More tools to discover; duplicates mutation logic.

### Approach C: New `convert_draft_issue` tool (for conversion)

A new `ralph_hero__convert_draft_issue` tool that accepts `projectItemId` + optional `repositoryId` and calls `convertProjectV2DraftIssueItemToIssue`.

**Pros**: Clean API, maps directly to the GraphQL mutation.
**Cons**: Will fail silently or with confusing error for users using fine-grained PATs.

### Recommended

**For lifecycle management (archive/delete)**: Approach A — extend existing tools with `projectItemId` as an alternative to `number`. This is the minimum change with maximum compatibility.

**For conversion**: Approach C — add `ralph_hero__convert_draft_issue` with a clear PAT warning in the tool description. The tool should also document the 3-step workaround fallback.

## Risks

1. **Fine-grained PAT bug on convert**: Most users likely use fine-grained PATs. The convert tool will error for them. Must prominently document the limitation.
2. **Permanent deletion for drafts**: Unlike regular issues, `deleteProjectV2Item` on a draft cannot be undone. The `remove_from_project` tool should surface a warning when used on draft items.
3. **No reverse path**: Once a draft is converted to a real issue, there is no API to convert it back to a draft.
4. **`update_draft_issue` ID confusion**: The current implementation uses the `DI_` (content) ID, but `create_draft_issue` returns only the `PVTI_` (item) ID. Users must query to find the `DI_` ID. Consider returning both IDs from `create_draft_issue`.

## Recommended Next Steps

1. **Extend `archive_item`**: Accept `projectItemId` as an alternative to `number`. Skip `resolveProjectItemId` if `projectItemId` is directly provided.
2. **Extend `remove_from_project`**: Same pattern — accept `projectItemId` directly for drafts. Add a warning note about permanent deletion.
3. **Add `convert_draft_issue` tool**: New tool accepting `projectItemId` (PVTI_) + optional `repositoryId`. Auto-fetches `repositoryId` from configured repo if not provided. Document the fine-grained PAT bug prominently. Also document the 3-step workaround.
4. **Update `create_draft_issue` return**: Return both `projectItemId` (PVTI_) and `draftIssueId` (DI_) to make subsequent `update_draft_issue` calls easier. The `DI_` can be fetched via an extra query after creation.
5. **Fix `update_draft_issue` return field** (GH-350): Change `projectItem { id }` to `draftIssue { id }` in the mutation.

## Files Affected

### Will Modify
- `plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts` - Extend `archive_item` and `remove_from_project` with `projectItemId` param; add `convert_draft_issue` tool; update `create_draft_issue` return value
- `plugin/ralph-hero/mcp-server/src/__tests__/project-management-tools.test.ts` - Add tests for new `projectItemId` paths and `convert_draft_issue`

### Will Read (Dependencies)
- `plugin/ralph-hero/mcp-server/src/lib/helpers.ts` - `resolveProjectItemId`, `resolveFullConfig`, `updateProjectItemField` patterns
- `plugin/ralph-hero/mcp-server/src/github-client.ts` - `projectMutate`, `repoQuery` methods
- `plugin/ralph-hero/mcp-server/src/types.ts` - `DraftIssue` interface, `ProjectV2Item` union
