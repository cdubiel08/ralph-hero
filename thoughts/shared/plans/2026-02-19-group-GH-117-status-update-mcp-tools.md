---
date: 2026-02-19
status: draft
github_issues: [117, 118]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/117
  - https://github.com/cdubiel08/ralph-hero/issues/118
primary_issue: 117
---

# Project Status Update MCP Tools - Atomic Implementation Plan

## Overview
2 related issues for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-117 | Add `create_status_update` MCP tool | S |
| 2 | GH-118 | Add `update_status_update` and `delete_status_update` MCP tools | S |

**Why grouped**: GH-118's update/delete tools depend on GH-117's create tool being implemented first. Both share the same `ProjectV2StatusUpdateStatus` enum, GraphQL mutation pattern, and belong to the same file (`project-management-tools.ts`). A single PR keeps the status update CRUD surface cohesive.

## Current State Analysis

- No status update tools exist in the MCP server. The only "status" references relate to the default Status column field (Todo/In Progress/Done) synced from Workflow State — completely unrelated.
- `project-management-tools.ts` currently has 5 tools: `archive_item`, `remove_from_project`, `add_to_project`, `link_repository`, `clear_field`. All follow the same pattern: `resolveFullConfig` → `ensureFieldCache` → `fieldCache.getProjectId()` → `client.projectMutate()` → `toolSuccess()`/`toolError()`.
- The `createProjectV2StatusUpdate`, `updateProjectV2StatusUpdate`, and `deleteProjectV2StatusUpdate` GraphQL mutations were added June 2024 and are documented in the research findings.

## Desired End State

### Verification
- [ ] `ralph_hero__create_status_update` tool registered and functional
- [ ] `ralph_hero__update_status_update` tool registered and functional
- [ ] `ralph_hero__delete_status_update` tool registered and functional
- [ ] All 5 status designations supported (ON_TRACK, AT_RISK, OFF_TRACK, INACTIVE, COMPLETE)
- [ ] Optional markdown body and date params work correctly
- [ ] Structural tests pass for all 3 mutations
- [ ] `npm run build` succeeds with no type errors
- [ ] `npm test` passes

## What We're NOT Doing
- No `list_status_updates` query tool (potential follow-up issue)
- No changes to existing Status column sync logic (unrelated feature)
- No new types in `types.ts` — response types are inlined in the generic parameter to `client.projectMutate<T>()`, matching the pattern used by `add_to_project`
- No changes to `index.ts` — tools register inside the existing `registerProjectManagementTools` function

## Implementation Approach

Both phases add tools to the existing `registerProjectManagementTools` function in `project-management-tools.ts`. The create tool (Phase 1) establishes the pattern and the status enum schema. The update/delete tools (Phase 2) reuse that enum and follow the same mutation pattern but don't need `projectId` (only `statusUpdateId`).

---

## Phase 1: GH-117 — Add `create_status_update` MCP tool
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/117 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-19-GH-0117-create-status-update-mcp-tool.md

### Changes Required

#### 1. Add `ralph_hero__create_status_update` tool
**File**: `plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts`
**Where**: After the `ralph_hero__clear_field` tool block (after line 392), before the closing `}` of `registerProjectManagementTools`

**Changes**:
- Add a new `server.tool()` registration block following the existing pattern
- Tool name: `ralph_hero__create_status_update`
- Description: `"Post a project-level status update with health designation. Visible in GitHub Projects UI header and panel. Returns: id, status, createdAt."`
- Input schema:
  ```typescript
  {
    owner: z.string().optional().describe("GitHub owner. Defaults to env var"),
    repo: z.string().optional().describe("Repository name. Defaults to env var"),
    status: z.enum(["ON_TRACK", "AT_RISK", "OFF_TRACK", "INACTIVE", "COMPLETE"])
      .describe("Project health designation"),
    body: z.string().optional().describe("Status update body (markdown)"),
    startDate: z.string().optional().describe("Start date (YYYY-MM-DD)"),
    targetDate: z.string().optional().describe("Target date (YYYY-MM-DD)"),
  }
  ```
- Handler pattern:
  1. `resolveFullConfig(client, args)` — resolve owner/repo/project config
  2. `ensureFieldCache(client, fieldCache, projectOwner, projectNumber)` — populate project ID
  3. `fieldCache.getProjectId()` — get project node ID (guard with `if (!projectId)` error)
  4. Build variables object: `{ projectId, status: args.status }` plus optional `body`, `startDate`, `targetDate` (only include if provided)
  5. `client.projectMutate<{ createProjectV2StatusUpdate: { statusUpdate: { id: string; status: string; body: string | null; startDate: string | null; targetDate: string | null; createdAt: string } } }>(mutation, variables)`
  6. GraphQL mutation:
     ```graphql
     mutation($projectId: ID!, $status: ProjectV2StatusUpdateStatus!, $body: String, $startDate: Date, $targetDate: Date) {
       createProjectV2StatusUpdate(input: {
         projectId: $projectId,
         status: $status,
         body: $body,
         startDate: $startDate,
         targetDate: $targetDate
       }) {
         statusUpdate {
           id
           status
           body
           startDate
           targetDate
           createdAt
         }
       }
     }
     ```
  7. Return `toolSuccess({ id, status, body, startDate, targetDate, createdAt })` from the response
  8. Catch block: `toolError("Failed to create status update: ${message}")`

**Note on date validation**: The GraphQL `Date` scalar enforces YYYY-MM-DD format server-side. No client-side validation needed — invalid dates will return a clear GraphQL error. This matches how other tools handle validation (rely on API errors).

#### 2. Add structural tests for `createProjectV2StatusUpdate`
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/project-management-tools.test.ts`
**Where**: Inside the existing `describe("project management mutations", ...)` block, after the `clearProjectV2ItemFieldValue` test (after line 154)

**Changes**: Add one test case:
```typescript
it("createProjectV2StatusUpdate mutation has required input fields", () => {
  const mutation = `mutation($projectId: ID!, $status: ProjectV2StatusUpdateStatus!, $body: String, $startDate: Date, $targetDate: Date) {
    createProjectV2StatusUpdate(input: {
      projectId: $projectId,
      status: $status,
      body: $body,
      startDate: $startDate,
      targetDate: $targetDate
    }) {
      statusUpdate {
        id
        status
        body
        startDate
        targetDate
        createdAt
      }
    }
  }`;
  expect(mutation).toContain("createProjectV2StatusUpdate");
  expect(mutation).toContain("projectId");
  expect(mutation).toContain("ProjectV2StatusUpdateStatus");
  expect(mutation).toContain("statusUpdate");
});
```

Also add a test for the status enum values:
```typescript
it("supports all 5 ProjectV2StatusUpdateStatus values", () => {
  const validStatuses = ["ON_TRACK", "AT_RISK", "OFF_TRACK", "INACTIVE", "COMPLETE"];
  expect(validStatuses).toHaveLength(5);
  for (const status of validStatuses) {
    expect(status).toMatch(/^[A-Z_]+$/);
  }
});
```

### Success Criteria
- [x] Automated: `cd plugin/ralph-hero/mcp-server && npm run build` succeeds
- [x] Automated: `cd plugin/ralph-hero/mcp-server && npm test` passes
- [ ] Manual: Tool appears in MCP server tool listing

**Creates for next phase**: The `create_status_update` tool establishes the pattern for status enum handling and project mutation flow. Phase 2's update/delete tools follow the same structure but use `statusUpdateId` instead of `projectId`.

---

## Phase 2: GH-118 — Add `update_status_update` and `delete_status_update` MCP tools
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/118 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-19-GH-0118-update-delete-status-update-mcp-tools.md | **Depends on**: Phase 1

### Changes Required

#### 1. Add `ralph_hero__update_status_update` tool
**File**: `plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts`
**Where**: After the `ralph_hero__create_status_update` tool block added in Phase 1

**Changes**:
- Tool name: `ralph_hero__update_status_update`
- Description: `"Update an existing project status update. Modify body, status designation, or dates. Returns: id, status, body, startDate, targetDate, updatedAt."`
- Input schema:
  ```typescript
  {
    owner: z.string().optional().describe("GitHub owner. Defaults to env var"),
    repo: z.string().optional().describe("Repository name. Defaults to env var"),
    statusUpdateId: z.string().describe("Node ID of the status update to modify"),
    status: z.enum(["ON_TRACK", "AT_RISK", "OFF_TRACK", "INACTIVE", "COMPLETE"]).optional()
      .describe("Updated project health designation"),
    body: z.string().optional().describe("Updated body (markdown)"),
    startDate: z.string().optional().describe("Updated start date (YYYY-MM-DD)"),
    targetDate: z.string().optional().describe("Updated target date (YYYY-MM-DD)"),
  }
  ```
- Handler pattern:
  1. Validate at least one content field is provided (`status`, `body`, `startDate`, `targetDate`). If none: `return toolError("At least one field to update is required (status, body, startDate, targetDate)")`
  2. `resolveFullConfig(client, args)` — for config consistency (no `projectId` needed for this mutation)
  3. `ensureFieldCache(client, fieldCache, projectOwner, projectNumber)` — for consistency
  4. Build variables: `{ statusUpdateId: args.statusUpdateId }` plus optional fields
  5. GraphQL mutation:
     ```graphql
     mutation($statusUpdateId: ID!, $status: ProjectV2StatusUpdateStatus, $body: String, $startDate: Date, $targetDate: Date) {
       updateProjectV2StatusUpdate(input: {
         statusUpdateId: $statusUpdateId,
         status: $status,
         body: $body,
         startDate: $startDate,
         targetDate: $targetDate
       }) {
         statusUpdate {
           id
           status
           body
           startDate
           targetDate
           updatedAt
         }
       }
     }
     ```
  6. Return `toolSuccess({ id, status, body, startDate, targetDate, updatedAt })`
  7. Catch block: `toolError("Failed to update status update: ${message}")`

**Note**: Unlike `create`, the `status` field is optional here (partial update). The `statusUpdateId` alone identifies the record — no `projectId` needed. We still call `resolveFullConfig`/`ensureFieldCache` for consistency with the codebase pattern, even though their results aren't directly used in the mutation.

#### 2. Add `ralph_hero__delete_status_update` tool
**File**: `plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts`
**Where**: After the `ralph_hero__update_status_update` tool block

**Changes**:
- Tool name: `ralph_hero__delete_status_update`
- Description: `"Delete a project status update. This action cannot be undone. Returns: deletedStatusUpdateId."`
- Input schema:
  ```typescript
  {
    owner: z.string().optional().describe("GitHub owner. Defaults to env var"),
    repo: z.string().optional().describe("Repository name. Defaults to env var"),
    statusUpdateId: z.string().describe("Node ID of the status update to delete"),
  }
  ```
- Handler pattern:
  1. `resolveFullConfig(client, args)` — for consistency
  2. `ensureFieldCache(client, fieldCache, projectOwner, projectNumber)` — for consistency
  3. GraphQL mutation:
     ```graphql
     mutation($statusUpdateId: ID!) {
       deleteProjectV2StatusUpdate(input: {
         statusUpdateId: $statusUpdateId
       }) {
         deletedStatusUpdateId
       }
     }
     ```
  4. Return `toolSuccess({ deletedStatusUpdateId })` from the response
  5. Catch block: `toolError("Failed to delete status update: ${message}")`

**Note**: This is the simplest mutation — only `statusUpdateId` is needed. No confirmation parameter is added (matching the existing `remove_from_project` pattern which also has no confirmation).

#### 3. Update module JSDoc
**File**: `plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts`
**Where**: Line 1-6 (file header comment)

**Changes**: Update the description to include status update tools:
```typescript
/**
 * MCP tools for GitHub Projects V2 management operations.
 *
 * Provides tools for archiving/unarchiving items, removing items from projects,
 * adding existing issues to projects, linking repositories, clearing field values,
 * and managing project status updates (create, update, delete).
 */
```

#### 4. Add structural tests for both mutations
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/project-management-tools.test.ts`
**Where**: Inside the existing `describe("project management mutations", ...)` block, after Phase 1's tests

**Changes**: Add two test cases:
```typescript
it("updateProjectV2StatusUpdate mutation has required input fields", () => {
  const mutation = `mutation($statusUpdateId: ID!, $status: ProjectV2StatusUpdateStatus, $body: String, $startDate: Date, $targetDate: Date) {
    updateProjectV2StatusUpdate(input: {
      statusUpdateId: $statusUpdateId,
      status: $status,
      body: $body,
      startDate: $startDate,
      targetDate: $targetDate
    }) {
      statusUpdate {
        id
        status
        body
        startDate
        targetDate
        updatedAt
      }
    }
  }`;
  expect(mutation).toContain("updateProjectV2StatusUpdate");
  expect(mutation).toContain("statusUpdateId");
  expect(mutation).toContain("statusUpdate");
});

it("deleteProjectV2StatusUpdate mutation has required input fields", () => {
  const mutation = `mutation($statusUpdateId: ID!) {
    deleteProjectV2StatusUpdate(input: {
      statusUpdateId: $statusUpdateId
    }) {
      deletedStatusUpdateId
    }
  }`;
  expect(mutation).toContain("deleteProjectV2StatusUpdate");
  expect(mutation).toContain("statusUpdateId");
  expect(mutation).toContain("deletedStatusUpdateId");
});
```

Also add a validation test for the update tool's "at least one field" requirement:
```typescript
describe("update_status_update validation", () => {
  it("requires at least one content field", () => {
    const contentFields = ["status", "body", "startDate", "targetDate"];
    const emptyArgs = { statusUpdateId: "test-id" };
    const hasContentField = contentFields.some((f) => f in emptyArgs && (emptyArgs as Record<string, unknown>)[f] !== undefined);
    expect(hasContentField).toBe(false);
  });
});
```

### Success Criteria
- [ ] Automated: `cd plugin/ralph-hero/mcp-server && npm run build` succeeds
- [ ] Automated: `cd plugin/ralph-hero/mcp-server && npm test` passes
- [ ] Manual: Both tools appear in MCP server tool listing

**Creates for next phase**: The 3 status update tools (create, update, delete) provide the MCP tool foundation that the `project_report` skill (GH-119's children: GH-138, GH-139, GH-140) will use to post automated status updates.

---

## Integration Testing
- [ ] Build succeeds: `cd plugin/ralph-hero/mcp-server && npm run build`
- [ ] All tests pass: `cd plugin/ralph-hero/mcp-server && npm test`
- [ ] No type errors in new code
- [ ] New tools follow existing patterns in `project-management-tools.ts`
- [ ] File header comment updated to reflect new tools

## References
- Research GH-117: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-19-GH-0117-create-status-update-mcp-tool.md
- Research GH-118: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-19-GH-0118-update-delete-status-update-mcp-tools.md
- Existing pattern: `plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts`
- Test pattern: `plugin/ralph-hero/mcp-server/src/__tests__/project-management-tools.test.ts`
- Epic: https://github.com/cdubiel08/ralph-hero/issues/97
