---
date: 2026-02-19
github_issue: 117
github_url: https://github.com/cdubiel08/ralph-hero/issues/117
status: complete
type: research
---

# GH-117: Add `create_status_update` MCP Tool

## Problem Statement

GitHub Projects V2 support project-level status updates that display in the project header and panel. These are visible to all project viewers and track project health over time with status designations (ON_TRACK, AT_RISK, OFF_TRACK, INACTIVE, COMPLETE). The ralph-hero MCP server has no tools to create or manage these status updates.

## Current State Analysis

### No Existing Implementation

No implementation of `create_status_update`, `createProjectV2StatusUpdate`, or any status update management exists in the MCP server. The "status" references in existing code relate to the GitHub Projects V2 default Status column field (Todo/In Progress/Done), which is synced from Workflow State — completely unrelated to project status updates.

### GitHub GraphQL API

**Mutation: `createProjectV2StatusUpdate`** (added June 2024)

Input (`CreateProjectV2StatusUpdateInput!`):

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `projectId` | `ID` | Yes | Project node ID |
| `body` | `String` | No | Markdown body text |
| `startDate` | `Date` | No | Start date |
| `targetDate` | `Date` | No | Target date |
| `status` | `ProjectV2StatusUpdateStatus` | No | Status designation |
| `clientMutationId` | `String` | No | Idempotency key |

**`ProjectV2StatusUpdateStatus` enum:**

| Value | Description |
|-------|-------------|
| `ON_TRACK` | No risks |
| `AT_RISK` | Encountering challenges |
| `OFF_TRACK` | Needs attention |
| `INACTIVE` | Inactive project |
| `COMPLETE` | Project complete |

Return (`CreateProjectV2StatusUpdatePayload`):

| Field | Type | Description |
|-------|------|-------------|
| `statusUpdate` | `ProjectV2StatusUpdate` | The created status update |

**`ProjectV2StatusUpdate` object:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | `ID!` | Node ID |
| `body` | `String` | Markdown source |
| `bodyHTML` | `HTML` | Rendered HTML |
| `status` | `ProjectV2StatusUpdateStatus` | Status designation |
| `startDate` | `Date` | Start date |
| `targetDate` | `Date` | Target date |
| `creator` | `Actor` | Who created it |
| `project` | `ProjectV2!` | Parent project |
| `createdAt` | `DateTime!` | Creation timestamp |
| `updatedAt` | `DateTime!` | Last update timestamp |

## Key Discoveries

### 1. Follows Standard Project Management Pattern

The tool fits in `project-management-tools.ts`. Uses `resolveFullConfig` → `ensureFieldCache` → `fieldCache.getProjectId()` → `client.projectMutate()`. No post-mutation field setting needed.

### 2. Date Type Handling

The `startDate` and `targetDate` fields use the GraphQL `Date` scalar (YYYY-MM-DD format), not `DateTime`. This is simpler — no timezone handling needed.

### 3. All Fields Optional Except `projectId`

Even `status` is optional in the mutation input. The tool should make `status` required for clarity (users should always specify the health designation), while keeping `body`, `startDate`, and `targetDate` optional.

### 4. Group Context: Epic #97

This issue is the first in a 3-issue group under Epic #97 (Automated Project Status Updates):
- **#117**: `create_status_update` (this issue — no dependencies, implement first)
- **#118**: `update_status_update` + `delete_status_update` (blocked by #117)
- **#119**: `project_report` skill (blocked by #117 and #118)

## Recommended Approach

Add to `project-management-tools.ts`:

```typescript
server.tool(
  "ralph_hero__create_status_update",
  "Post a project-level status update with health designation",
  {
    owner: z.string().optional(),
    repo: z.string().optional(),
    status: z.enum(["ON_TRACK", "AT_RISK", "OFF_TRACK", "INACTIVE", "COMPLETE"])
      .describe("Project health designation"),
    body: z.string().optional().describe("Status update body (markdown)"),
    startDate: z.string().optional().describe("Start date (YYYY-MM-DD)"),
    targetDate: z.string().optional().describe("Target date (YYYY-MM-DD)"),
  },
  async (args) => { ... }
);
```

Data flow:
1. `resolveFullConfig(client, args)` → resolve project context
2. `ensureFieldCache(...)` → populate project ID
3. `fieldCache.getProjectId()` → project node ID
4. `client.projectMutate<{ createProjectV2StatusUpdate: { statusUpdate: { id, status, createdAt } } }>(...)`
5. Return `{ id, status, body, startDate, targetDate, createdAt }`

## Risks

1. **Feature availability**: Added June 2024. May not be available on older GitHub Enterprise Server versions.
2. **Permission model**: Requires write access to the project. Same permissions as other project mutations.
3. **Date validation**: Should validate `startDate` and `targetDate` are valid YYYY-MM-DD strings before sending to API.

## Recommended Next Steps

1. Implement in `project-management-tools.ts`
2. Make `status` required, other fields optional
3. Add date format validation for startDate/targetDate
4. Add structural tests following existing pattern
5. Consider adding a `ProjectV2StatusUpdate` type to `types.ts`
