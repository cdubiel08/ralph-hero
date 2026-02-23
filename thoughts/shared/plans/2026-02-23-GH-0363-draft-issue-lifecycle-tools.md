---
date: 2026-02-23
status: draft
github_issues: [363]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/363
primary_issue: 363
---

# Draft Issue Lifecycle Tools - Atomic Implementation Plan

## Overview
1 issue for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-363 | Research GitHub API for converting draft issues to real issues | XS |

## Current State Analysis

The MCP server has `create_draft_issue` and `update_draft_issue` tools but no lifecycle management for drafts beyond that. Key gaps:

1. **`archive_item`** (`project-management-tools.ts:44`) requires `number` parameter — drafts have no issue number, so this tool is unusable for drafts
2. **`remove_from_project`** (`project-management-tools.ts:120`) same issue — requires `number`
3. **No convert tool** — the `convertProjectV2DraftIssueItemToIssue` GraphQL mutation exists but has no MCP tool wrapper
4. **`create_draft_issue`** (`project-management-tools.ts:422`) returns only `projectItemId` (PVTI_), not the `draftIssueId` (DI_) needed by `update_draft_issue`

The underlying GraphQL mutations (`archiveProjectV2Item`, `deleteProjectV2Item`, `convertProjectV2DraftIssueItemToIssue`) all accept the `PVTI_` project item ID, which `create_draft_issue` already returns.

## Desired End State

### Verification
- [ ] `archive_item` accepts optional `projectItemId` parameter as alternative to `number` for draft items
- [ ] `remove_from_project` accepts optional `projectItemId` parameter as alternative to `number` for draft items, with warning about permanent deletion for drafts
- [ ] New `convert_draft_issue` tool converts a draft to a real issue using `convertProjectV2DraftIssueItemToIssue` mutation
- [ ] `create_draft_issue` returns both `projectItemId` (PVTI_) and `draftIssueId` (DI_) in its response
- [ ] All new code paths have mutation-level tests
- [ ] `npm run build` and `npm test` pass

## What We're NOT Doing
- Not adding a separate `archive_draft_issue` or `delete_draft_issue` tool (Approach B from research) — extending existing tools is cleaner
- Not implementing the 3-step workaround fallback for fine-grained PATs in `convert_draft_issue` — that's a separate enhancement if needed
- Not fixing `update_draft_issue` return field (GH-350 — already tracked separately)
- Not adding bulk draft operations

## Implementation Approach

All changes are in `project-management-tools.ts` and its test file. The approach extends existing tools with an optional `projectItemId` parameter while keeping backwards compatibility, and adds one new tool.

---

## Phase 1: GH-363 — Draft Issue Lifecycle Tools
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/363 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-23-GH-0363-draft-issue-lifecycle-api.md

### Changes Required

#### 1. Extend `archive_item` to accept `projectItemId`
**File**: `plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts`
**Lines**: 44-115
**Changes**:
- Add optional `projectItemId` parameter: `projectItemId: z.string().optional().describe("Project item node ID (PVTI_...) — use instead of number for draft items")`
- Add validation: exactly one of `number` or `projectItemId` must be provided
- When `projectItemId` is provided, skip the `resolveProjectItemId` call and use it directly
- When `number` is provided, keep existing behavior unchanged
- Update description to mention draft item support
- Update return value: when using `projectItemId` directly, return `projectItemId` and omit `number` (or return `number: null`)

```
// Parameter validation at top of handler:
if (!args.number && !args.projectItemId) {
  return toolError("Either number or projectItemId must be provided");
}
if (args.number && args.projectItemId) {
  return toolError("Provide either number or projectItemId, not both");
}

// Resolution:
const itemId = args.projectItemId
  ? args.projectItemId
  : await resolveProjectItemId(client, fieldCache, owner, repo, args.number!, projectNumber);
```

#### 2. Extend `remove_from_project` to accept `projectItemId`
**File**: `plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts`
**Lines**: 120-179
**Changes**:
- Add optional `projectItemId` parameter (same pattern as archive_item)
- Add same one-of validation
- When `projectItemId` is provided, skip `resolveProjectItemId` and use directly
- Update description to mention draft support and warn about permanent deletion for drafts
- Skip cache invalidation when using `projectItemId` (no issue number to invalidate)

#### 3. Add `convert_draft_issue` tool
**File**: `plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts`
**Location**: After `update_draft_issue` (after line 549)
**Changes**: New tool registration:

```typescript
server.tool(
  "ralph_hero__convert_draft_issue",
  "Convert a draft issue to a real repository issue. Requires the project item ID (PVTI_...) returned by create_draft_issue. CAVEAT: This mutation fails with fine-grained PATs (known GitHub bug, unresolved as of early 2026). Use a classic PAT with repo+project scopes. Returns: projectItemId, converted.",
  {
    owner: z.string().optional().describe("GitHub owner. Defaults to env var"),
    repo: z.string().optional().describe("Repository name. Defaults to env var"),
    projectNumber: z.coerce.number().optional()
      .describe("Project number override (defaults to configured project)"),
    projectItemId: z.string().describe("Project item node ID (PVTI_...) of the draft issue"),
    repositoryId: z.string().optional()
      .describe("Repository node ID (R_...). Auto-fetched from configured repo if omitted"),
  },
  async (args) => {
    // 1. Resolve config
    // 2. If repositoryId not provided, fetch it:
    //    query($owner: String!, $name: String!) {
    //      repository(owner: $owner, name: $name) { id }
    //    }
    // 3. Call convertProjectV2DraftIssueItemToIssue mutation
    // 4. Return { projectItemId, converted: true }
  }
);
```

The mutation:
```graphql
mutation($itemId: ID!, $repositoryId: ID!) {
  convertProjectV2DraftIssueItemToIssue(input: {
    itemId: $itemId
    repositoryId: $repositoryId
  }) {
    item { id }
  }
}
```

Note: This uses `client.projectMutate()` since it operates on a project item.

#### 4. Enhance `create_draft_issue` return value
**File**: `plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts`
**Lines**: 450-467
**Changes**:
- After creating the draft, query for the `DI_` content node ID using the returned `PVTI_` project item ID:
```graphql
query($itemId: ID!) {
  node(id: $itemId) {
    ... on ProjectV2Item {
      content {
        ... on DraftIssue {
          id
        }
      }
    }
  }
}
```
- Add `draftIssueId` to the return value alongside `projectItemId`
- This eliminates the need for callers to make a separate query to use `update_draft_issue`

#### 5. Add tests for new functionality
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/project-management-tools.test.ts`
**Changes**: Add mutation structure tests following existing patterns (lines 157-186):

- `convertProjectV2DraftIssueItemToIssue` mutation has required input fields (`itemId`, `repositoryId`)
- `archiveProjectV2Item` mutation works with direct `itemId` (no number resolution)
- `deleteProjectV2Item` mutation works with direct `itemId` (no number resolution)
- Repository ID query has required fields (`owner`, `name`)

### Success Criteria
- [x] Automated: `cd plugin/ralph-hero/mcp-server && npm run build && npm test`
- [ ] Manual: Verify `archive_item` with `projectItemId` param archives a draft issue
- [ ] Manual: Verify `remove_from_project` with `projectItemId` param removes a draft issue
- [ ] Manual: Verify `convert_draft_issue` converts a draft to a real issue (with classic PAT)
- [ ] Manual: Verify `create_draft_issue` returns both `projectItemId` and `draftIssueId`

---

## Integration Testing
- [ ] Create a draft issue → verify both IDs returned
- [ ] Archive the draft using `projectItemId` → verify it's archived
- [ ] Unarchive it → verify it's restored
- [ ] Convert a different draft to real issue → verify it becomes a numbered issue
- [ ] Remove a draft from project using `projectItemId` → verify it's deleted
- [ ] Existing number-based flows for `archive_item` and `remove_from_project` still work unchanged

## References
- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-23-GH-0363-draft-issue-lifecycle-api.md
- Related issues: https://github.com/cdubiel08/ralph-hero/issues/350 (update_draft_issue return field fix)
