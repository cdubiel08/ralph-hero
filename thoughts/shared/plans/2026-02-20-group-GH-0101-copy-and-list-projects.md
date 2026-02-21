---
date: 2026-02-20
status: draft
github_issues: [100, 101]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/100
  - https://github.com/cdubiel08/ralph-hero/issues/101
primary_issue: 101
---

# Add `list_projects` and `copy_project` MCP Tools - Atomic Implementation Plan

## Overview

2 related issues for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-100 | Add `list_projects` MCP tool -- discover all projects for an owner | S |
| 2 | GH-101 | Add `copy_project` MCP tool -- duplicate project from template | S |

**Why grouped**: Both are project-level MCP tools under Epic #93 (Cross-Project Orchestration). They share the same target file (`project-tools.ts`), use the same user/org dual-type resolution pattern, and are both "Ready for Plan" with S estimates. Implementing together avoids two separate PRs touching the same registration function.

## Current State Analysis

`project-tools.ts` currently registers 4 tools in `registerProjectTools()`:
1. `setup_project` -- creates a new project with custom fields (uses `client.projectMutate`, owner node ID resolution)
2. `get_project` -- fetches a single project by number (uses `fetchProject()` helper with user/org fallback)
3. `list_project_items` -- lists items in a project with filtering (uses `paginateConnection`)
4. `list_project_repos` -- lists repositories linked to a project (uses `queryProjectRepositories` helper)

Key patterns established:
- **Owner resolution**: `resolveProjectOwner(client.config)` for defaults, explicit `args.owner` overrides
- **Dual-type resolution**: Try `user(login:)` first, then `organization(login:)` -- used by `fetchProject()` and `setup_project`
- **Pagination**: `paginateConnection<T>()` from `pagination.ts` handles cursor-based GraphQL pagination
- **Error handling**: try/catch wrapping entire handler, using `toolError(message)` for errors
- **Structural tests**: `project-tools.test.ts` reads source as string and asserts on content (no API mocking)

## Desired End State

### Verification
- [ ] `ralph_hero__list_projects` tool registered and returns project summaries with pagination
- [ ] `ralph_hero__copy_project` tool registered and duplicates a project via `copyProjectV2` mutation
- [ ] Both tools handle user/org owners transparently
- [ ] `list_projects` supports `state` filter (open/closed/all) with client-side filtering
- [ ] `copy_project` supports cross-owner copy (source owner != target owner)
- [ ] Structural tests pass for both tools
- [ ] Existing tests still pass (`npm test`)
- [ ] Build succeeds (`npm run build`)

## What We're NOT Doing

- Not adding `markProjectV2AsTemplate` / `unmarkProjectV2AsTemplate` tools (out of scope for #101)
- Not populating field cache after copy (the new project has different field IDs; callers can use `get_project` if needed)
- Not modifying `index.ts` (both tools are in `project-tools.ts` which is already registered)
- Not adding `list_projects` to any existing filter profile system (it has no project-level field filtering)

## Implementation Approach

Phase 1 adds the read-only `list_projects` tool using the established `paginateConnection` + dual-type pattern. Phase 2 adds the mutation-based `copy_project` tool reusing the owner node ID resolution pattern from `setup_project`. Both phases modify the same file (`project-tools.ts`) and the same test file (`project-tools.test.ts`). No new files are needed.

---

## Phase 1: GH-100 -- Add `list_projects` MCP Tool

> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/100 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0100-list-projects-mcp-tool.md

### Changes Required

#### 1. Register `ralph_hero__list_projects` tool

**File**: `plugin/ralph-hero/mcp-server/src/tools/project-tools.ts`
**Where**: Inside `registerProjectTools()`, after the `get_project` tool registration (after line ~379) and before `list_project_items`.

**Changes**:

Add tool registration with Zod schema:
- `owner`: optional string, defaults to `resolveProjectOwner(client.config)`
- `state`: optional enum `"open" | "closed" | "all"`, default `"open"`
- `limit`: optional number, default 50, max 100

Handler logic:
1. Resolve `owner` from args or config
2. Define GraphQL query for `projectsV2` connection with fields: `id`, `number`, `title`, `shortDescription`, `public`, `closed`, `url`, `items { totalCount }`, `fields { totalCount }`, `views { totalCount }`
3. Use dual-type resolution: try `user.projectsV2` via `paginateConnection`, if connection not found (throws), try `organization.projectsV2`
4. Apply client-side `state` filter: if `"open"` keep `!closed`, if `"closed"` keep `closed`, if `"all"` keep all
5. Return `toolSuccess({ projects: [...], totalCount })` with mapped project summaries

GraphQL query shape (for each owner type):
```graphql
query($owner: String!, $cursor: String, $first: Int!) {
  user(login: $owner) {
    projectsV2(first: $first, after: $cursor, orderBy: {field: TITLE, direction: ASC}) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        number
        title
        shortDescription
        public
        closed
        url
        items { totalCount }
        fields { totalCount }
        views { totalCount }
      }
    }
  }
}
```

Response mapping per project:
```typescript
{
  id: p.id,
  number: p.number,
  title: p.title,
  shortDescription: p.shortDescription,
  public: p.public,
  closed: p.closed,
  url: p.url,
  itemCount: p.items?.totalCount ?? 0,
  fieldCount: p.fields?.totalCount ?? 0,
  viewCount: p.views?.totalCount ?? 0,
}
```

#### 2. Add structural tests for `list_projects`

**File**: `plugin/ralph-hero/mcp-server/src/__tests__/project-tools.test.ts`

**Changes**: Add a new `describe("list_projects structural")` block verifying:
- Tool is registered with name `ralph_hero__list_projects`
- Zod schema includes `state` parameter with enum values `"open"`, `"closed"`, `"all"`
- GraphQL query contains `projectsV2` connection
- GraphQL query contains expected fields: `shortDescription`, `public`, `closed`, `items { totalCount }`, `fields { totalCount }`, `views { totalCount }`
- Response mapping includes `itemCount`, `fieldCount`, `viewCount`
- Client-side closed filter logic exists (checks for `!p.closed` or equivalent)

### Success Criteria

- [x] Automated: `cd plugin/ralph-hero/mcp-server && npm test` passes with new list_projects tests
- [x] Automated: `npm run build` succeeds
- [ ] Manual: Tool returns projects for a configured owner

**Creates for next phase**: Establishes the dual-type `projectsV2` query pattern that Phase 2 could reference (though Phase 2 uses a different approach -- mutation-based).

---

## Phase 2: GH-101 -- Add `copy_project` MCP Tool

> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/101 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0101-copy-project-mcp-tool.md

### Changes Required

#### 1. Register `ralph_hero__copy_project` tool

**File**: `plugin/ralph-hero/mcp-server/src/tools/project-tools.ts`
**Where**: Inside `registerProjectTools()`, after `list_projects` (from Phase 1) and before `list_project_items`.

**Changes**:

Add tool registration with Zod schema:
- `sourceProjectNumber`: required number -- project number of the source project to copy
- `sourceOwner`: optional string -- owner of source project, defaults to `resolveProjectOwner(client.config)`
- `title`: required string -- title for the new project
- `targetOwner`: optional string -- owner for the new project, defaults to `sourceOwner`
- `includeDraftIssues`: optional boolean, default `false` -- whether to include draft issues in the copy

Handler logic:
1. Resolve `sourceOwner` from args or config
2. Resolve source project node ID: use `fetchProject(client, sourceOwner, sourceProjectNumber)` to get the source project's `id`. This reuses the existing `fetchProject` helper (module-private, dual-type resolution already built in).
3. Resolve target owner node ID: use the same user/org node ID resolution pattern from `setup_project` (try `user(login:)` then `organization(login:)` to get the `ownerId`)
4. Execute `copyProjectV2` mutation:
   ```graphql
   mutation($projectId: ID!, $ownerId: ID!, $title: String!, $includeDraftIssues: Boolean!) {
     copyProjectV2(input: {
       projectId: $projectId
       ownerId: $ownerId
       title: $title
       includeDraftIssues: $includeDraftIssues
     }) {
       projectV2 {
         id
         number
         url
         title
       }
     }
   }
   ```
5. Return `toolSuccess({ project: { id, number, url, title }, copiedFrom: { number: sourceProjectNumber, owner: sourceOwner }, note: "..." })` with a note about what was/was not copied

#### 2. Add structural tests for `copy_project`

**File**: `plugin/ralph-hero/mcp-server/src/__tests__/project-tools.test.ts`

**Changes**: Add a new `describe("copy_project structural")` block verifying:
- Tool is registered with name `ralph_hero__copy_project`
- Zod schema includes `sourceProjectNumber`, `title`, `sourceOwner`, `targetOwner`, `includeDraftIssues` parameters
- GraphQL mutation contains `copyProjectV2`
- Mutation input includes `projectId`, `ownerId`, `title`, `includeDraftIssues`
- Response includes new project `id`, `number`, `url`, `title`
- Uses `fetchProject` for source project resolution
- Uses owner node ID resolution pattern (queries `user` and `organization` for node ID)

### Success Criteria

- [x] Automated: `cd plugin/ralph-hero/mcp-server && npm test` passes with new copy_project tests
- [x] Automated: `npm run build` succeeds
- [ ] Manual: Tool copies a project and returns new project details

**Creates for next phase**: Provides the `copy_project` primitive that GH-111 (enhance `setup_project` with template mode) will use as the underlying mechanism.

---

## Integration Testing

- [x] Full test suite passes: `cd plugin/ralph-hero/mcp-server && npm test`
- [x] TypeScript build succeeds: `npm run build`
- [ ] Both new tools appear in the compiled output (`dist/tools/project-tools.js`)
- [ ] No regressions in existing project tool tests

## References

- Research (GH-100): https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0100-list-projects-mcp-tool.md
- Research (GH-101): https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0101-copy-project-mcp-tool.md
- Existing patterns: `plugin/ralph-hero/mcp-server/src/tools/project-tools.ts` (setup_project, get_project, fetchProject)
- Pagination utility: `plugin/ralph-hero/mcp-server/src/lib/pagination.ts`
- Epic: https://github.com/cdubiel08/ralph-hero/issues/93
