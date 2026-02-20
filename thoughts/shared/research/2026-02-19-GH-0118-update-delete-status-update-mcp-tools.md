---
date: 2026-02-19
github_issue: 118
github_url: https://github.com/cdubiel08/ralph-hero/issues/118
status: complete
type: research
---

# GH-118: Add `update_status_update` and `delete_status_update` MCP Tools

## Problem Statement

After creating project status updates (#117), users need to modify or remove them. Two companion mutations exist: `updateProjectV2StatusUpdate` and `deleteProjectV2StatusUpdate`.

## Current State Analysis

### No Existing Implementation

No status update management tools exist in the MCP server. This issue depends on #117 (`create_status_update`) being implemented first — the create tool establishes the pattern and types that update/delete build on.

### GitHub GraphQL API

**Mutation: `updateProjectV2StatusUpdate`**

Input (`UpdateProjectV2StatusUpdateInput!`):

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `statusUpdateId` | `ID` | Yes | Status update node ID |
| `body` | `String` | No | Updated markdown body |
| `startDate` | `Date` | No | Updated start date |
| `targetDate` | `Date` | No | Updated target date |
| `status` | `ProjectV2StatusUpdateStatus` | No | Updated status designation |
| `clientMutationId` | `String` | No | Idempotency key |

Return: `{ statusUpdate: ProjectV2StatusUpdate }`

**Key difference from create**: No `projectId` — the `statusUpdateId` alone identifies the record.

**Mutation: `deleteProjectV2StatusUpdate`**

Input (`DeleteProjectV2StatusUpdateInput!`):

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `statusUpdateId` | `ID` | Yes | Status update node ID |
| `clientMutationId` | `String` | No | Idempotency key |

Return: `{ deletedStatusUpdateId: ID, projectV2: ProjectV2 }`

## Key Discoveries

### 1. Both Tools Are Simple Mutations

Both mutations take `statusUpdateId` as the primary identifier. Update allows partial modifications (only supplied fields change). Delete is the simplest mutation in the API.

### 2. `statusUpdateId` Must Come from Create or Query

Users get the `statusUpdateId` from the `create_status_update` response or from querying project status updates. The ralph-hero codebase does not currently have a way to list/query status updates. If needed, a `list_status_updates` query could be added, but this is out of scope for this issue.

### 3. Pattern: Companion Update/Delete Tools

This follows the same pattern as other CRUD tool sets in the codebase. The update mutation supports partial updates (only supplied fields are modified), and the delete mutation is minimal.

### 4. No Project ID Needed

Unlike `create`, both `update` and `delete` only need the `statusUpdateId`. The project context is implicit. However, the tool should still call `resolveFullConfig` for consistency and to ensure the MCP server is properly configured.

## Recommended Approach

Add both tools to `project-management-tools.ts`:

```typescript
// Update
server.tool(
  "ralph_hero__update_status_update",
  "Update an existing project status update",
  {
    owner: z.string().optional(),
    repo: z.string().optional(),
    statusUpdateId: z.string().describe("Node ID of the status update to modify"),
    status: z.enum(["ON_TRACK", "AT_RISK", "OFF_TRACK", "INACTIVE", "COMPLETE"]).optional(),
    body: z.string().optional().describe("Updated body (markdown)"),
    startDate: z.string().optional().describe("Updated start date (YYYY-MM-DD)"),
    targetDate: z.string().optional().describe("Updated target date (YYYY-MM-DD)"),
  },
  async (args) => { ... }
);

// Delete
server.tool(
  "ralph_hero__delete_status_update",
  "Delete a project status update",
  {
    owner: z.string().optional(),
    repo: z.string().optional(),
    statusUpdateId: z.string().describe("Node ID of the status update to delete"),
  },
  async (args) => { ... }
);
```

### Validation

- Update: require at least one content field (status, body, startDate, targetDate) to prevent no-op calls
- Delete: no additional validation needed

## Risks

1. **No list/query tool**: Users must know the `statusUpdateId`. The create tool returns it, but there's no `list_status_updates` tool to find existing ones. This may be needed as a follow-up.
2. **Irreversible delete**: Status update deletion cannot be undone. Consider adding a confirmation parameter similar to `delete_field`.

## Recommended Next Steps

1. Implement after #117 is complete (shares types and patterns)
2. Add both tools to `project-management-tools.ts`
3. Reuse `ProjectV2StatusUpdate` type from #117 implementation
4. Add structural tests
5. Consider follow-up issue for `list_status_updates` query tool
