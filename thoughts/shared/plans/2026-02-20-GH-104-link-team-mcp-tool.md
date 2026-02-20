---
date: 2026-02-20
status: draft
github_issue: 104
github_url: https://github.com/cdubiel08/ralph-hero/issues/104
primary_issue: 104
---

# `link_team` MCP Tool - Implementation Plan

## Overview

Single issue implementation: GH-104 — Add `link_team` MCP tool to associate a project with a GitHub team for discoverability.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-104 | Add `link_team` MCP tool — associate project with GitHub team | S |

## Current State Analysis

- The `link_repository` tool (`project-management-tools.ts:246-334`) provides the exact pattern to follow: resolves a secondary ID (repo → node ID), branches on an `unlink` boolean to call link/unlink mutations, returns `{ resource, linked }`.
- The `update_collaborators` tool (`project-management-tools.ts:779-892`) already has team slug → node ID resolution via `organization.team(slug:)` query (lines 847-874), including org ownership validation and team-not-found error handling.
- `linkProjectV2ToTeam` and `unlinkProjectV2FromTeam` are GraphQL mutations that take `{ projectId, teamId }` as input and return `{ team { id name slug } }`.
- This is distinct from `updateProjectV2Collaborators` — link/unlink controls discoverability (project appears on team's Projects page), not access control.
- Teams are an org-level concept — personal projects cannot use this tool. Must validate org ownership.
- The last tool in `registerProjectManagementTools` is `ralph_hero__bulk_archive` ending at line 1262, with the function closing `}` at line 1263.

## Desired End State

### Verification
- [ ] `ralph_hero__link_team` tool registered and functional
- [ ] Links project to team via `linkProjectV2ToTeam` mutation
- [ ] Unlinks project from team via `unlinkProjectV2FromTeam` mutation when `unlink: true`
- [ ] Validates org ownership (returns clear error for personal projects)
- [ ] Validates team exists (returns clear error with slug and org name)
- [ ] Structural tests pass for both mutations
- [ ] `npm run build` and `npm test` succeed

## What We're NOT Doing
- No `list_teams` discovery tool (potential follow-up)
- No combining with `update_collaborators` into a single tool (different operations)
- No extracting team resolution into a shared helper (only two callers, established pattern)
- No changes to existing `update_collaborators` tool

## Implementation Approach

Add the new tool to `project-management-tools.ts` before the closing `}` of `registerProjectManagementTools`, following the `link_repository` pattern exactly: resolve project ID, resolve team slug → node ID (reusing the `update_collaborators` query pattern), branch on `unlink` boolean, call the appropriate mutation.

---

## Phase 1: GH-104 — Add `link_team` MCP tool
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/104 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0104-link-team-mcp-tool.md

### Changes Required

#### 1. Add `ralph_hero__link_team` tool
**File**: `plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts`
**Where**: Before the closing `}` of `registerProjectManagementTools` (currently line 1263), after the `ralph_hero__bulk_archive` tool block (line 1262)

**Changes**: Add a new `server.tool()` registration block:

- Tool name: `ralph_hero__link_team`
- Description: `"Link or unlink a project from a GitHub team. Makes the project visible on the team's Projects page (org-owned projects only). Distinct from update_collaborators which controls access roles. Returns: team, linked."`
- Input schema:
  ```typescript
  {
    owner: z.string().optional().describe("GitHub owner. Defaults to env var"),
    repo: z.string().optional().describe("Repository name. Defaults to env var"),
    teamSlug: z.string().describe("Team slug (e.g., 'engineering')"),
    unlink: z.boolean().optional().default(false)
      .describe("If true, unlink instead of link (default: false)"),
  }
  ```
- Handler flow (following `link_repository` pattern at lines 246-334):
  1. `resolveFullConfig(client, args)` — resolve owner/repo/project config
  2. `ensureFieldCache(client, fieldCache, projectOwner, projectNumber)` — populate project ID
  3. `fieldCache.getProjectId()` — get project node ID (guard with `if (!projectId)` error)
  4. Resolve team slug → node ID via `organization.team(slug:)` query (following `update_collaborators` pattern at lines 847-874):
     ```typescript
     const teamResult = await client.query<{
       organization: { team: { id: string } | null } | null;
     }>(
       `query($org: String!, $slug: String!) {
         organization(login: $org) {
           team(slug: $slug) { id }
         }
       }`,
       { org: projectOwner, slug: args.teamSlug },
       { cache: true, cacheTtlMs: 60 * 60 * 1000 },
     );
     ```
  5. Validate org ownership: if `!teamResult.organization`, return `toolError("Team linking requires an organization-owned project. \"${projectOwner}\" is not an organization.")`
  6. Validate team exists: if `!teamResult.organization.team`, return `toolError("Team \"${args.teamSlug}\" not found in organization \"${projectOwner}\"")`
  7. Extract `teamId = teamResult.organization.team.id`
  8. Branch on `unlink`:
     - If `args.unlink`:
       ```typescript
       await client.projectMutate(
         `mutation($projectId: ID!, $teamId: ID!) {
           unlinkProjectV2FromTeam(input: {
             projectId: $projectId,
             teamId: $teamId
           }) {
             team { id }
           }
         }`,
         { projectId, teamId },
       );
       ```
     - Else (link):
       ```typescript
       await client.projectMutate(
         `mutation($projectId: ID!, $teamId: ID!) {
           linkProjectV2ToTeam(input: {
             projectId: $projectId,
             teamId: $teamId
           }) {
             team { id }
           }
         }`,
         { projectId, teamId },
       );
       ```
  9. Return `toolSuccess({ team: args.teamSlug, linked: !args.unlink })`
  10. Catch block: `toolError("Failed to ${args.unlink ? "unlink" : "link"} team: ${message}")`

#### 2. Update module JSDoc
**File**: `plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts`
**Where**: File header comment (lines 1-6)

**Changes**: Add "linking teams" to the tool list description:
```typescript
/**
 * MCP tools for GitHub Projects V2 management operations.
 *
 * Provides tools for archiving/unarchiving items, removing items from projects,
 * adding existing issues to projects, linking repositories, linking teams,
 * clearing field values, managing project status updates (create, update, delete),
 * updating collaborator access, and bulk archiving.
 */
```

#### 3. Add structural tests
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/project-management-tools.test.ts`
**Where**: Inside the `describe("project management mutations", ...)` block, after the existing mutation tests

**Changes**: Add test cases following the established structural test pattern:

```typescript
it("linkProjectV2ToTeam mutation has required input fields", () => {
  const mutation = `mutation($projectId: ID!, $teamId: ID!) {
    linkProjectV2ToTeam(input: {
      projectId: $projectId,
      teamId: $teamId
    }) {
      team { id }
    }
  }`;
  expect(mutation).toContain("linkProjectV2ToTeam");
  expect(mutation).toContain("projectId");
  expect(mutation).toContain("teamId");
});

it("unlinkProjectV2FromTeam mutation has required input fields", () => {
  const mutation = `mutation($projectId: ID!, $teamId: ID!) {
    unlinkProjectV2FromTeam(input: {
      projectId: $projectId,
      teamId: $teamId
    }) {
      team { id }
    }
  }`;
  expect(mutation).toContain("unlinkProjectV2FromTeam");
  expect(mutation).toContain("projectId");
  expect(mutation).toContain("teamId");
});
```

Also add an org validation test in a new describe block:

```typescript
describe("link_team org validation", () => {
  it("team slug resolution query targets organization type", () => {
    const teamQuery = `query($org: String!, $slug: String!) {
      organization(login: $org) {
        team(slug: $slug) { id }
      }
    }`;
    expect(teamQuery).toContain("organization");
    expect(teamQuery).toContain("team(slug:");
    expect(teamQuery).not.toContain("user");
  });
});
```

### Success Criteria
- [x] Automated: `cd plugin/ralph-hero/mcp-server && npm run build` succeeds
- [x] Automated: `cd plugin/ralph-hero/mcp-server && npm test` passes
- [ ] Manual: `ralph_hero__link_team` tool appears in MCP tool listing
- [ ] Manual: Tool correctly validates org ownership and team existence

---

## Integration Testing
- [x] Build succeeds: `cd plugin/ralph-hero/mcp-server && npm run build`
- [x] All tests pass: `cd plugin/ralph-hero/mcp-server && npm test`
- [x] No type errors in new code
- [x] New tool follows `link_repository` pattern exactly
- [x] Team slug resolution follows `update_collaborators` pattern
- [x] Variable names avoid `@octokit/graphql` reserved names (`query`, `method`, `url`)

## References
- Research GH-104: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0104-link-team-mcp-tool.md
- `link_repository` pattern: `plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts:246-334`
- Team slug resolution: `plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts:847-874`
- Test pattern: `plugin/ralph-hero/mcp-server/src/__tests__/project-management-tools.test.ts:54-232`
- Parent epic: https://github.com/cdubiel08/ralph-hero/issues/93
