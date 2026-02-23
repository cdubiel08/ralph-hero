---
title: "Fix update_draft_issue MCP tool — wrong mutation response field"
github_issue: 350
estimate: XS
status: approved
created: 2026-02-23
---

# Fix `update_draft_issue` MCP Tool — Wrong Mutation Response Field

## Problem

The `ralph_hero__update_draft_issue` tool fails with:
```
Field 'projectItem' doesn't exist on type 'UpdateProjectV2DraftIssuePayload'
```

The GraphQL mutation selects `projectItem { id }` but `UpdateProjectV2DraftIssuePayload` only returns `draftIssue`.

## Phase 1: Fix mutation response field and update test

### Changes Required

1. **`plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts`** (~line 534)
   - Change `projectItem { id }` to `draftIssue { id title }` in the `updateProjectV2DraftIssue` mutation

2. **`plugin/ralph-hero/mcp-server/src/__tests__/project-management-tools.test.ts`** (~line 179)
   - Update the test's mutation string to match: `draftIssue { id title }`

### File Ownership Summary

| File | Phase |
|------|-------|
| `plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts` | 1 |
| `plugin/ralph-hero/mcp-server/src/__tests__/project-management-tools.test.ts` | 1 |

### Automated Verification

- [x] `cd plugin/ralph-hero/mcp-server && npm test` passes
- [x] `cd plugin/ralph-hero/mcp-server && npm run build` succeeds

### Success Criteria

- The `updateProjectV2DraftIssue` mutation queries `draftIssue { id title }` instead of `projectItem { id }`
- Tests updated and passing
- Build succeeds
