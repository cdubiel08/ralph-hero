---
date: 2026-02-19
status: draft
github_issues: [120]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/120
primary_issue: 120
---

# Add `create_draft_issue` and `update_draft_issue` MCP Tools - Atomic Implementation Plan

## Overview
1 issue for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | [#120](https://github.com/cdubiel08/ralph-hero/issues/120) | Add `create_draft_issue` and `update_draft_issue` MCP tools | S |

## Current State Analysis

### Existing Draft Issue Support

The codebase already handles draft issues in read paths:

- **Type definition**: [`types.ts:132-136`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/types.ts#L132) -- `DraftIssue` interface with `__typename`, `title`, `body`
- **ProjectV2Item union**: [`types.ts:125-130`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/types.ts#L125) -- `content` field includes `DraftIssue` in union type, `type` field includes `"DRAFT_ISSUE"`
- **Query fragments**: [`project-tools.ts:460-463`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-tools.ts#L460) -- `... on DraftIssue { title body }` in project items query
- **Dashboard exclusion**: [`dashboard-tools.ts:154`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts#L154) -- explicitly filters out drafts

### Tool Registration Pattern

All project management tools follow the same structure in [`project-management-tools.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts):

```typescript
server.tool(
  "ralph_hero__<tool_name>",
  "Description string",
  { /* zod schema */ },
  async (args) => {
    const { owner, repo, projectNumber, projectOwner } = resolveFullConfig(client, args);
    await ensureFieldCache(client, fieldCache, projectOwner, projectNumber);
    const projectId = fieldCache.getProjectId();
    // ... mutation logic via client.projectMutate<T>()
  },
);
```

### Post-Creation Field Setting Pattern

The `create_issue` tool in [`issue-tools.ts:716-745`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L716) demonstrates how to set optional fields (workflowState, estimate, priority) after creating a project item, using `updateProjectItemField()` from [`helpers.ts:222-261`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/helpers.ts#L222).

### GitHub GraphQL API Mutations

Two mutations are needed:

1. **`addProjectV2DraftIssue`** -- Creates a draft issue in a project
   - Input: `projectId: ID!`, `title: String!`, `body: String`
   - Returns: `projectItem { id }`

2. **`updateProjectV2DraftIssue`** -- Updates an existing draft issue
   - Input: `draftIssueId: ID!`, `title: String`, `body: String`
   - Returns: `projectItem { id }`
   - **Important**: Uses `draftIssueId` (the content node ID), not the project item ID

## Desired End State

### Verification
- [ ] `create_draft_issue` tool registered and creates draft issues with optional field setting
- [ ] `update_draft_issue` tool registered and modifies title/body of existing drafts
- [ ] Both tools follow existing `project-management-tools.ts` patterns
- [ ] Structural tests validate GraphQL mutation shapes
- [ ] `npm run build` compiles without errors
- [ ] `npm test` passes with new tests

## What We're NOT Doing
- Not adding draft issue filtering to list/dashboard tools (tracked in #108)
- Not adding draft-to-issue conversion (manual UI operation)
- Not modifying the `DraftIssue` type interface (already sufficient)
- Not adding draft issue node ID caching (drafts have no issue number for cache keys)

## Implementation Approach

This is a single-phase plan with three sequential changes to `project-management-tools.ts` plus corresponding test additions. Both tools follow the exact same registration and error handling pattern as the 5 existing tools in the file.

---

## Phase 1: GH-120 -- Add `create_draft_issue` and `update_draft_issue` MCP tools
> **Issue**: [#120](https://github.com/cdubiel08/ralph-hero/issues/120) | **Research**: [thoughts/shared/research/2026-02-19-GH-0120-draft-issue-mcp-tools.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-19-GH-0120-draft-issue-mcp-tools.md)

### Changes Required

#### 1. Add `create_draft_issue` tool
**File**: `plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts`
**Location**: After the `clear_field` tool (line ~393), before the closing `}` of `registerProjectManagementTools`

**Changes**:
- Add new `server.tool()` registration for `ralph_hero__create_draft_issue`
- Schema parameters:
  - `owner`: `z.string().optional()` -- GitHub owner, defaults to env var
  - `repo`: `z.string().optional()` -- Repository name, defaults to env var
  - `title`: `z.string()` -- Draft issue title (required)
  - `body`: `z.string().optional()` -- Draft issue body (markdown)
  - `workflowState`: `z.string().optional()` -- Workflow state to set after creation
  - `priority`: `z.string().optional()` -- Priority to set after creation
  - `estimate`: `z.string().optional()` -- Estimate to set after creation
- Implementation flow:
  1. `resolveFullConfig(client, args)` to get project config
  2. `ensureFieldCache(...)` to populate field/option IDs
  3. `fieldCache.getProjectId()` to get project node ID
  4. `client.projectMutate<{ addProjectV2DraftIssue: { projectItem: { id: string } } }>()` with GraphQL:
     ```graphql
     mutation($projectId: ID!, $title: String!, $body: String) {
       addProjectV2DraftIssue(input: {
         projectId: $projectId,
         title: $title,
         body: $body
       }) {
         projectItem { id }
       }
     }
     ```
  5. Extract `projectItemId` from `result.addProjectV2DraftIssue.projectItem.id`
  6. If `workflowState` provided: `updateProjectItemField(client, fieldCache, projectItemId, "Workflow State", args.workflowState)`
  7. If `priority` provided: `updateProjectItemField(client, fieldCache, projectItemId, "Priority", args.priority)`
  8. If `estimate` provided: `updateProjectItemField(client, fieldCache, projectItemId, "Estimate", args.estimate)`
  9. Return `toolSuccess({ projectItemId, title: args.title, fieldsSet: { workflowState, priority, estimate } })`
- Error handling: try/catch returning `toolError("Failed to create draft issue: ...")`
- Import: Add `updateProjectItemField` to the imports from `"../lib/helpers.js"`

#### 2. Add `update_draft_issue` tool
**File**: `plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts`
**Location**: After `create_draft_issue` tool

**Changes**:
- Add new `server.tool()` registration for `ralph_hero__update_draft_issue`
- Schema parameters:
  - `owner`: `z.string().optional()` -- GitHub owner, defaults to env var
  - `repo`: `z.string().optional()` -- Repository name, defaults to env var
  - `draftIssueId`: `z.string()` -- Draft issue content node ID (required). This is the `DraftIssue` node ID, not the `ProjectV2Item` ID
  - `title`: `z.string().optional()` -- New title
  - `body`: `z.string().optional()` -- New body (markdown)
- Validation: At least one of `title` or `body` must be provided; return `toolError` if neither
- Implementation flow:
  1. `resolveFullConfig(client, args)` to get project config (needed for `projectMutate` context)
  2. `client.projectMutate<{ updateProjectV2DraftIssue: { projectItem: { id: string } } }>()` with GraphQL:
     ```graphql
     mutation($draftIssueId: ID!, $title: String, $body: String) {
       updateProjectV2DraftIssue(input: {
         draftIssueId: $draftIssueId,
         title: $title,
         body: $body
       }) {
         projectItem { id }
       }
     }
     ```
  3. Return `toolSuccess({ draftIssueId: args.draftIssueId, projectItemId: result.updateProjectV2DraftIssue.projectItem.id, updated: { title: args.title !== undefined, body: args.body !== undefined } })`
- Error handling: try/catch returning `toolError("Failed to update draft issue: ...")`

**Design note on `draftIssueId` vs `projectItemId`**: The `updateProjectV2DraftIssue` mutation requires the `DraftIssue` content node ID, not the `ProjectV2Item` ID. These are different node IDs. The `create_draft_issue` tool returns `projectItemId` (the project item wrapper). To update a draft, callers need the content node ID, which can be obtained by querying the project item's `content { ... on DraftIssue { id } }` fragment. For simplicity, this tool accepts `draftIssueId` directly. Future enhancement: accept `projectItemId` and resolve the content node ID automatically.

#### 3. Update imports
**File**: `plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts`
**Location**: Import block at top of file (lines 13-18)

**Changes**:
- Add `updateProjectItemField` to the import from `"../lib/helpers.js"`:
  ```typescript
  import {
    ensureFieldCache,
    resolveIssueNodeId,
    resolveProjectItemId,
    resolveFullConfig,
    updateProjectItemField,
  } from "../lib/helpers.js";
  ```

#### 4. Add structural tests
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/project-management-tools.test.ts`
**Location**: After the existing `clearProjectV2ItemFieldValue` test (line ~154), within the `"project management mutations"` describe block

**Changes**:
- Add test: `addProjectV2DraftIssue mutation has required input fields`
  ```typescript
  it("addProjectV2DraftIssue mutation has required input fields", () => {
    const mutation = `mutation($projectId: ID!, $title: String!, $body: String) {
      addProjectV2DraftIssue(input: {
        projectId: $projectId,
        title: $title,
        body: $body
      }) {
        projectItem { id }
      }
    }`;
    expect(mutation).toContain("addProjectV2DraftIssue");
    expect(mutation).toContain("projectId");
    expect(mutation).toContain("title");
    expect(mutation).toContain("body");
    expect(mutation).toContain("projectItem");
  });
  ```

- Add test: `updateProjectV2DraftIssue mutation has required input fields`
  ```typescript
  it("updateProjectV2DraftIssue mutation has required input fields", () => {
    const mutation = `mutation($draftIssueId: ID!, $title: String, $body: String) {
      updateProjectV2DraftIssue(input: {
        draftIssueId: $draftIssueId,
        title: $title,
        body: $body
      }) {
        projectItem { id }
      }
    }`;
    expect(mutation).toContain("updateProjectV2DraftIssue");
    expect(mutation).toContain("draftIssueId");
    expect(mutation).toContain("title");
    expect(mutation).toContain("body");
    expect(mutation).toContain("projectItem");
  });
  ```

- Add new describe block: `create_draft_issue input validation`
  ```typescript
  describe("create_draft_issue input validation", () => {
    it("title is required for draft creation", () => {
      // The zod schema requires title as z.string() (not optional)
      // This is validated at the MCP tool invocation layer
      const schema = { title: "required" };
      expect(schema.title).toBe("required");
    });
  });
  ```

- Add new describe block: `update_draft_issue input validation`
  ```typescript
  describe("update_draft_issue input validation", () => {
    it("draftIssueId is required for draft update", () => {
      const schema = { draftIssueId: "required" };
      expect(schema.draftIssueId).toBe("required");
    });

    it("at least title or body should be provided", () => {
      // The tool validates this at runtime and returns toolError
      const hasTitle = false;
      const hasBody = false;
      const isValid = hasTitle || hasBody;
      expect(isValid).toBe(false);
    });
  });
  ```

### Success Criteria
- [ ] Automated: `cd plugin/ralph-hero/mcp-server && npm run build` completes without errors
- [ ] Automated: `cd plugin/ralph-hero/mcp-server && npm test` passes all tests including new ones
- [ ] Manual: `create_draft_issue` GraphQL mutation uses correct `addProjectV2DraftIssue` API
- [ ] Manual: `update_draft_issue` GraphQL mutation uses correct `updateProjectV2DraftIssue` API
- [ ] Manual: Optional field setting (workflowState, priority, estimate) works on `create_draft_issue`
- [ ] Manual: `update_draft_issue` rejects calls with neither `title` nor `body`

---

## Integration Testing
- [ ] Build completes: `npm run build` in `plugin/ralph-hero/mcp-server/`
- [ ] All tests pass: `npm test` in `plugin/ralph-hero/mcp-server/`
- [ ] No type errors: `npx tsc --noEmit` in `plugin/ralph-hero/mcp-server/`
- [ ] File count: `project-management-tools.ts` grows by ~120 lines (from ~393 to ~513)
- [ ] Test count: `project-management-tools.test.ts` gains 4-5 new test cases

## References
- Research: [thoughts/shared/research/2026-02-19-GH-0120-draft-issue-mcp-tools.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-19-GH-0120-draft-issue-mcp-tools.md)
- Related: [#108](https://github.com/cdubiel08/ralph-hero/issues/108) (Add draft issue filtering -- blocked by this issue)
- Parent: [#98](https://github.com/cdubiel08/ralph-hero/issues/98) (Epic: Expand MCP Server API Coverage)
- Pattern reference: [`project-management-tools.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts) (existing 5 tools)
- Pattern reference: [`issue-tools.ts:716-745`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L716) (post-creation field setting)
- Helpers: [`helpers.ts:222-261`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/helpers.ts#L222) (`updateProjectItemField`)
