---
date: 2026-02-23
status: draft
github_issues: [311]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/311
primary_issue: 311
---

# Draft Issue List Support — Atomic Implementation Plan

## Overview
1 issue for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-311 | Improve draft issue management — archive, remove, and list support | S |

## Current State Analysis

GH-363 (PR #372) already implemented the archive/remove `projectItemId` bypass and `create_draft_issue` DI_ return. The remaining gap from GH-311 is in `list_project_items`:

1. **DraftIssue GraphQL fragment** (`project-tools.ts:930-933`) only selects `title` and `body` — missing the `id` field (DI_* content node ID)
2. **Formatted response** (`project-tools.ts:1060-1083`) has no `draftIssueId` field, so callers who discover drafts via listing cannot call `update_draft_issue` without a separate query
3. **`DraftIssue` interface** (`types.ts:132-136`) lacks an `id` field

This means the `list → update_draft_issue` workflow is broken: you can list drafts (via `itemType: "DRAFT_ISSUE"`) and get their `PVTI_*` item IDs, but not their `DI_*` content IDs needed by `update_draft_issue`.

## Desired End State

### Verification
- [ ] `list_project_items` with `itemType: "DRAFT_ISSUE"` returns `draftIssueId` (DI_*) for each draft item
- [ ] `DraftIssue` interface in `types.ts` includes `id` field
- [ ] Existing non-draft list queries are unaffected
- [ ] `npm run build` and `npm test` pass

## What We're NOT Doing
- Not modifying `archive_item` or `remove_from_project` (already done in GH-363/PR #372)
- Not modifying `create_draft_issue` return value (already done in GH-363/PR #372)
- Not adding `convert_draft_issue` tool (already done in GH-363/PR #372)
- Not fixing `bulk_archive` draft `updatedBefore` gap (separate issue per research)
- Not adding `updatedAt` to DraftIssue fragment (drafts don't have updatedAt on the content node; it lives on the ProjectV2Item wrapper — separate enhancement)

## Implementation Approach

Three small, additive changes in `project-tools.ts`, `types.ts`, and their test files. No behavior change for existing callers — `draftIssueId` is simply a new field in the response that is `null` for non-draft items.

---

## Phase 1: GH-311 — Draft Issue List DI_* Exposure
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/311 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-23-GH-0311-draft-issue-lifecycle-management.md

### Changes Required

#### 1. Add `id` to DraftIssue GraphQL fragment
**File**: `plugin/ralph-hero/mcp-server/src/tools/project-tools.ts`
**Lines**: 930-933
**Changes**: Add `id` field to the DraftIssue inline fragment:

```graphql
... on DraftIssue {
  id
  title
  body
}
```

This returns the `DI_*` content node ID for draft items in the paginated query.

#### 2. Expose `draftIssueId` in formatted response
**File**: `plugin/ralph-hero/mcp-server/src/tools/project-tools.ts`
**Lines**: 1060-1083 (the `items.map(...)` formatter)
**Changes**: Add `draftIssueId` field to the response object. For draft items, extract `content.id` (which is the DI_* ID). For non-draft items, return `null`:

```typescript
draftIssueId: item.type === "DRAFT_ISSUE" ? (content?.id as string) ?? null : null,
```

Insert this after the `type` field in the response mapping.

#### 3. Update `DraftIssue` interface
**File**: `plugin/ralph-hero/mcp-server/src/types.ts`
**Lines**: 132-136
**Changes**: Add `id` to the `DraftIssue` interface:

```typescript
export interface DraftIssue {
  __typename: "DraftIssue";
  id: string;
  title: string;
  body: string;
}
```

#### 4. Add tests
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/project-tools.test.ts`
**Changes**: Add structural tests following existing patterns (source-string matching):

- DraftIssue fragment includes `id` field
- Response mapping includes `draftIssueId` field
- `draftIssueId` is conditional on `DRAFT_ISSUE` type

**File**: `plugin/ralph-hero/mcp-server/src/__tests__/types.test.ts`
**Changes**: If a DraftIssue structural test exists, verify `id` field is present. Otherwise follow existing pattern.

### Success Criteria
- [ ] Automated: `cd plugin/ralph-hero/mcp-server && npm run build && npm test`
- [ ] Manual: Call `list_project_items` with `itemType: "DRAFT_ISSUE"` and verify `draftIssueId` (DI_*) appears in response
- [ ] Manual: Verify non-draft items have `draftIssueId: null`

---

## Integration Testing
- [ ] List drafts → get DI_* → call `update_draft_issue` with the DI_* — full lifecycle works
- [ ] List all items (no `itemType` filter) → drafts have `draftIssueId`, issues have `null`
- [ ] Existing `list_project_items` filters (workflowState, estimate, etc.) still work

## References
- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-23-GH-0311-draft-issue-lifecycle-management.md
- Related: GH-363 (PR #372) — archive/remove projectItemId bypass, create_draft_issue DI_ return
- Related: GH-108 — Draft issue filtering for list tools (Done)
