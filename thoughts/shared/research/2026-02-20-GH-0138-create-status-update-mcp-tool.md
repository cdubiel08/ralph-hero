---
date: 2026-02-20
github_issue: 138
github_url: https://github.com/cdubiel08/ralph-hero/issues/138
status: complete
type: research
---

# GH-138: Create `create_status_update` MCP Tool for GitHub Projects V2

## Problem Statement

GitHub Projects V2 supports project-level status updates that display in the project header and panel. The ralph-hero MCP server needs a `ralph_hero__create_status_update` tool wrapping the `createProjectV2StatusUpdate` GraphQL mutation.

## Prior Research

Comprehensive research exists in [GH-117 research doc](2026-02-19-GH-0117-create-status-update-mcp-tool.md). GH-138 has identical scope to GH-117 (both implement `create_status_update`). GH-138 is a sub-issue of #119 (project_report skill), while GH-117 was part of epic #97 (Automated Project Status Updates). This document summarizes key findings and adds implementation-specific details.

## Current State Analysis

- No `createProjectV2StatusUpdate` implementation exists in the MCP server
- No status update types in `types.ts`
- The "status" references in existing code relate to the default Status column field sync (Todo/In Progress/Done), not project status updates

## Key Discoveries

### 1. GraphQL API (`createProjectV2StatusUpdate`)

**Input (`CreateProjectV2StatusUpdateInput!`):**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `projectId` | `ID` | Yes | Project node ID |
| `body` | `String` | No | Markdown body |
| `status` | `ProjectV2StatusUpdateStatus` | No | Health designation |
| `startDate` | `Date` | No | Start date (YYYY-MM-DD) |
| `targetDate` | `Date` | No | Target date (YYYY-MM-DD) |

**Status enum values:** `ON_TRACK`, `AT_RISK`, `OFF_TRACK`, `INACTIVE`, `COMPLETE`

**Return:** `ProjectV2StatusUpdate` with `id`, `body`, `bodyHTML`, `status`, `startDate`, `targetDate`, `createdAt`, `updatedAt`

### 2. Implementation Pattern

Follows existing `project-management-tools.ts` pattern:
- File: [`project-management-tools.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts)
- Pattern: `resolveFullConfig` → `ensureFieldCache` → `fieldCache.getProjectId()` → `client.projectMutate()` → `toolSuccess()`
- No post-mutation field setting needed (unlike issue tools)

### 3. Tool Schema

```typescript
server.tool(
  "ralph_hero__create_status_update",
  "Post a project-level status update. Returns: id, status, body, createdAt.",
  {
    owner: z.string().optional().describe("GitHub owner"),
    repo: z.string().optional().describe("Repository name"),
    status: z.enum(["ON_TRACK", "AT_RISK", "OFF_TRACK", "INACTIVE", "COMPLETE"])
      .describe("Project health designation"),
    body: z.string().optional().describe("Status update body (markdown)"),
    startDate: z.string().optional().describe("Start date (YYYY-MM-DD)"),
    targetDate: z.string().optional().describe("Target date (YYYY-MM-DD)"),
  },
  async (args) => { ... }
);
```

### 4. GraphQL Mutation

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

### 5. Related Mutations

Also available (for future sibling issues):
- `updateProjectV2StatusUpdate` — requires `statusUpdateId` + `projectId`
- `deleteProjectV2StatusUpdate` — requires `statusUpdateId` + `projectId`

### 6. Permissions

Same as other project mutations — requires `project` scope (classic PAT) or Projects read/write (fine-grained PAT). No elevated permissions needed.

## Potential Approaches

### Approach A: Add to `project-management-tools.ts` (Recommended)

Add the tool inline in `project-management-tools.ts` alongside `archive_item`, `remove_from_project`, `add_to_project`, `link_repository`, and `clear_field`. Follows existing file organization.

**Pros:** Consistent with existing pattern, no new files, shared config resolution
**Cons:** `project-management-tools.ts` grows (currently ~320 lines, would add ~60)

### Approach B: New `status-update-tools.ts` file

Create a separate tool file for status update tools, anticipating `update_status_update` and `delete_status_update` in sibling issues.

**Pros:** Cleaner separation, dedicated file for the status update domain
**Cons:** More boilerplate, another registration call in index.ts

**Recommendation:** Approach A for GH-138 alone (single tool, small addition). If/when sibling issues add update/delete, refactor to Approach B at that point.

## Risks

1. **Feature availability**: `createProjectV2StatusUpdate` added June 2024. May not be available on GitHub Enterprise Server < 3.16.
2. **Date validation**: Should validate `startDate`/`targetDate` are valid YYYY-MM-DD strings before sending to API.
3. **Duplicate with GH-117**: GH-138 and GH-117 have identical scope. One should be closed as duplicate or linked to avoid double implementation.

## Recommended Next Steps

1. **Resolve GH-117 vs GH-138 overlap** — close whichever is the duplicate
2. Implement in `project-management-tools.ts` following existing pattern
3. Make `status` required, other fields optional
4. Add date format validation for `startDate`/`targetDate`
5. Add structural tests in `project-management-tools.test.ts`
