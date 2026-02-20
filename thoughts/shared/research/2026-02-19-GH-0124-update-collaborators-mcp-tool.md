---
date: 2026-02-19
github_issue: 124
github_url: https://github.com/cdubiel08/ralph-hero/issues/124
status: complete
type: research
---

# GH-124: Add `update_collaborators` MCP Tool

## Problem Statement

GitHub Projects V2 support collaborator management via the `updateProjectV2Collaborators` mutation. The ralph-hero MCP server has no tool to manage who has access to a project, requiring manual UI interaction for access provisioning.

## Current State Analysis

### No Existing Implementation

No implementation of `update_collaborators`, `updateProjectV2Collaborators`, or any collaborator management exists in the MCP server. The only "access" reference in the codebase is the connectivity check in [`index.ts:158`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/index.ts#L158) which validates token permissions, not collaborator management.

### GitHub GraphQL API

**Mutation: `updateProjectV2Collaborators`**

Input (`UpdateProjectV2CollaboratorsInput!`):

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `projectId` | `ID!` | Yes | Project node ID |
| `collaborators` | `[ProjectV2CollaboratorInput!]!` | Yes | List of collaborator entries |
| `clientMutationId` | `String` | No | Idempotency key |

Nested input (`ProjectV2CollaboratorInput`):

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `userId` | `ID` | Conditional | User node ID (provide userId OR teamId) |
| `teamId` | `ID` | Conditional | Team node ID (provide userId OR teamId) |
| `role` | `ProjectV2Roles!` | Yes | Permission level |

**`ProjectV2Roles` enum:**

| Value | Description |
|-------|-------------|
| `READER` | View-only access |
| `WRITER` | View and edit access |
| `ADMIN` | Full admin access |
| `NONE` | Remove direct access |

Return (`UpdateProjectV2CollaboratorsPayload`):

| Field | Type | Description |
|-------|------|-------------|
| `projectV2` | `ProjectV2` | The updated project |

**Key notes:**
- Setting `role: NONE` removes a collaborator's direct access (no separate remove mutation)
- Team collaborators (`teamId`) require org-owned projects — personal projects only support user collaborators
- Requires project admin permissions
- Only one of `userId` or `teamId` per collaborator entry

## Key Discoveries

### 1. User/Team ID Resolution Challenge

The mutation requires GitHub node IDs (`U_kgDO...` for users, `T_kgDO...` for teams), not usernames or team slugs. The tool needs a resolution strategy:

**Option A**: Accept node IDs directly
- Simplest implementation
- Users must know or look up node IDs

**Option B**: Accept usernames/team slugs, resolve to node IDs
- Better UX
- Requires additional GraphQL queries: `query { user(login: "...") { id } }` and `query { organization(login: "...") { team(slug: "...") { id } } }`

**Recommended**: Option B — accept `usernames` and/or `teamSlugs` arrays, resolve internally. This is consistent with how other tools accept human-readable inputs and resolve IDs internally.

### 2. Batch Nature of the Mutation

The mutation accepts an array of collaborators in a single call. The tool should accept multiple collaborators at once rather than requiring one call per collaborator.

### 3. Personal vs Organization Projects

Community reports indicate `updateProjectV2Collaborators` has limited support for personal (user-owned) projects. The ralph-hero setup uses personal projects by default. This is the primary risk for this tool.

## Recommended Approach

Add to `project-management-tools.ts`:

```typescript
server.tool(
  "ralph_hero__update_collaborators",
  "Manage project collaborator access — add, update, or remove users/teams",
  {
    owner: z.string().optional(),
    repo: z.string().optional(),
    collaborators: z.array(z.object({
      username: z.string().optional().describe("GitHub username"),
      teamSlug: z.string().optional().describe("Team slug (org projects only)"),
      role: z.enum(["READER", "WRITER", "ADMIN", "NONE"]).describe("Permission level (NONE removes access)"),
    })).describe("List of collaborator changes"),
  },
  async (args) => { ... }
);
```

Data flow:
1. `resolveFullConfig(client, args)` → resolve project context
2. `ensureFieldCache(...)` → populate project ID
3. For each collaborator entry, resolve username/teamSlug to node ID via GraphQL
4. Call `updateProjectV2Collaborators` with `projectId` and resolved `collaborators` array
5. Return summary of changes applied

## Risks

1. **Personal project limitations**: The mutation may not work fully on personal (user-owned) projects, which is the default ralph-hero setup. Needs testing.
2. **Node ID resolution**: Resolving usernames to node IDs requires additional API calls, adding latency.
3. **Team access requires org**: Team-based collaborators only work on organization-owned projects. The tool should validate and return a clear error for personal projects.
4. **Limited community usage**: This mutation has fewer community examples than other Projects V2 mutations, suggesting it may be newer or less tested.

## Recommended Next Steps

1. Implement in `project-management-tools.ts`
2. Accept usernames and team slugs (resolve to node IDs internally)
3. Add validation: reject team collaborators on personal projects
4. Add structural tests + test for personal project team rejection
5. Note in documentation that this tool works best with org-owned projects
