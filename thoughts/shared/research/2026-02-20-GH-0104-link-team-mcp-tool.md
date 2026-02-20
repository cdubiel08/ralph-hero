---
date: 2026-02-20
github_issue: 104
github_url: https://github.com/cdubiel08/ralph-hero/issues/104
status: complete
type: research
---

# GH-104: Add `link_team` MCP Tool — Associate Project with GitHub Team

## Problem Statement

GitHub Projects V2 can be linked to GitHub teams for discoverability — the project appears on the team's "Projects" page. The ralph-hero MCP server has no tool wrapping `linkProjectV2ToTeam`. This is distinct from the existing `update_collaborators` tool which manages fine-grained access roles.

## Current State Analysis

### Existing Team-Related Tools

**`update_collaborators`** ([`project-management-tools.ts:779-892`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts#L779)):
- Manages collaborator access via `updateProjectV2Collaborators` mutation
- Accepts `teamSlug` entries with role (READER/WRITER/ADMIN/NONE)
- Resolves team slug to node ID via `organization.team(slug:)` query (L844-868)
- Validates org ownership — returns error for personal projects (L856-860)

**`link_repository`** ([`project-management-tools.ts:243-326`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts#L243)):
- Links/unlinks repositories to projects via `linkProjectV2ToRepository` / `unlinkProjectV2FromRepository`
- Accepts `repoToLink` and `unlink` boolean
- **Best pattern to follow** — same link/unlink structure needed for teams

### No `linkProjectV2ToTeam` Implementation

No code for `linkProjectV2ToTeam`, `unlinkProjectV2FromTeam`, or `link_team` exists in the MCP server source.

## Key Discoveries

### 1. `linkProjectV2ToTeam` Mutation

**Input** (`LinkProjectV2ToTeamInput!`):

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `projectId` | `ID!` | Yes | Project node ID |
| `teamId` | `ID!` | Yes | Team node ID |
| `clientMutationId` | `String` | No | Idempotency key |

**Return** (`LinkProjectV2ToTeamPayload`):

| Field | Type | Description |
|-------|------|-------------|
| `team` | `Team` | The linked team |
| `clientMutationId` | `String` | Idempotency key |

### 2. `unlinkProjectV2FromTeam` Exists

**Input** (`UnlinkProjectV2FromTeamInput!`): Same shape — `projectId` + `teamId`.

**Return** (`UnlinkProjectV2FromTeamPayload`): Same shape — `team` + `clientMutationId`.

Both link and unlink should be exposed from a single tool with an `unlink` boolean, following the `link_repository` pattern.

### 3. Distinct from `updateProjectV2Collaborators`

| Aspect | `linkProjectV2ToTeam` | `updateProjectV2Collaborators` (with teamId) |
|--------|----------------------|-----------------------------------------------|
| **Purpose** | Discoverability — project appears on team's Projects page | Access control — sets READER/WRITER/ADMIN/NONE role |
| **Input** | `projectId` + `teamId` only | `projectId` + array of `{ teamId, role }` |
| **Permission effect** | Implicit Read access | Explicit role assignment |
| **UI effect** | Project appears on team page | No team page side-effect |

**Both may be needed together**: Link for discoverability + set collaborator role for write access.

### 4. Org-Only Requirement

Teams are an org-level concept in GitHub. `linkProjectV2ToTeam` requires an org-owned project. Personal projects do not support team linking. The tool must validate org ownership, following the same pattern as `update_collaborators` (L856-860).

### 5. Team Node ID Resolution — Already Solved

The `update_collaborators` tool already has team slug → node ID resolution at [`project-management-tools.ts:844-868`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts#L844):

```graphql
query($org: String!, $slug: String!) {
  organization(login: $org) {
    team(slug: $slug) { id }
  }
}
```

This query can be reused directly. The `org` variable is bound to `projectOwner` from `resolveProjectOwner()`.

### 6. Implementation Pattern — Follow `link_repository`

The `link_repository` tool (L243-326) is the exact structural template:

1. `resolveFullConfig(client, args)` → owner, repo, projectNumber, projectOwner
2. `ensureFieldCache(...)` → populate project ID
3. `fieldCache.getProjectId()` → project node ID
4. Resolve secondary ID (team slug → team node ID via org query)
5. Branch on `unlink` boolean → call `linkProjectV2ToTeam` or `unlinkProjectV2FromTeam`
6. Return `{ team: teamSlug, linked: !args.unlink }`

### 7. No Community Examples

The GitHub GraphQL schema includes both mutations, but GitHub's official "Using the API to manage Projects" guide does not cover team linking. No community examples or blog posts were found. The mutations are minimally documented.

## Recommended Approach

Add to `project-management-tools.ts`:

```typescript
server.tool(
  "ralph_hero__link_team",
  "Link or unlink a project from a GitHub team — makes the project visible on the team's Projects page (org-owned projects only)",
  {
    owner: z.string().optional(),
    repo: z.string().optional(),
    teamSlug: z.string().describe("Team slug (e.g., 'engineering')"),
    unlink: z.boolean().optional().default(false)
      .describe("true to unlink, false to link (default: link)"),
  },
  async (args) => { ... }
);
```

Data flow:
1. `resolveFullConfig(client, args)` → resolve project context
2. `ensureFieldCache(...)` → populate project ID
3. `fieldCache.getProjectId()` → project node ID
4. Resolve `teamSlug` → team node ID via `organization.team(slug:)` query (reuse pattern from `update_collaborators` L844-868)
5. If `!args.unlink` → `linkProjectV2ToTeam(input: { projectId, teamId })`
6. If `args.unlink` → `unlinkProjectV2FromTeam(input: { projectId, teamId })`
7. Return `{ team: args.teamSlug, linked: !args.unlink }`

### Validation

- Validate org ownership: if `organization(login:)` returns null, return error "Team linking requires an organization-owned project"
- Validate team exists: if `organization.team(slug:)` returns null, return error with the attempted slug and org

## Risks

1. **Org-only**: Tool is non-functional for personal projects (default ralph-hero setup). Error message should be clear.
2. **Minimal documentation**: No official GitHub examples for this mutation. Behavior is inferred from schema and access docs.
3. **Potential redundancy with `update_collaborators`**: Users may link a team for discoverability but still need `update_collaborators` for write access. Consider noting this in the tool description.
4. **No `list_teams` tool**: Users need to know the team slug. A `list_teams` query helper would improve UX but is out of scope for this issue.

## Recommended Next Steps

1. Implement in `project-management-tools.ts` following `link_repository` pattern
2. Reuse team slug resolution from `update_collaborators`
3. Support both link and unlink via boolean flag
4. Add structural tests
5. Consider follow-up for `list_teams` discovery tool
