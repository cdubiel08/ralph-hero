---
date: 2026-02-20
github_issue: 100
github_url: https://github.com/cdubiel08/ralph-hero/issues/100
status: complete
type: research
---

# GH-100: Add `list_projects` MCP Tool

## Problem Statement

There is no MCP tool to discover which GitHub Projects V2 exist for a given user or organization. The current `get_project` tool requires a known project number. For cross-project orchestration (epic #93), a discovery mechanism is needed to enumerate all projects before operating on them.

## Current State Analysis

### Existing Project Tools

[`project-tools.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-tools.ts) registers three tools:

1. **`setup_project`** -- Creates a new project with custom fields. Uses `client.projectMutate`.
2. **`get_project`** -- Fetches a single project by number. Uses `fetchProject()` helper (tries user, then org).
3. **`list_project_items`** -- Lists items in a project with filtering. Uses `paginateConnection`.
4. **`list_project_repos`** -- Lists repositories linked to a project. Uses `queryProjectRepositories` helper.

### Key Patterns to Reuse

#### User/Org Dual-Type Resolution

The `fetchProject()` function at [`project-tools.ts:828-926`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-tools.ts#L828-L926) demonstrates the standard pattern:
1. Try `user(login: $owner) { projectV2(number: ...) }` with `client.projectQuery`
2. If null, try `organization(login: $owner) { projectV2(number: ...) }`
3. Return null if neither works

For `list_projects`, the same pattern applies but with `projectsV2` (plural) connection instead of `projectV2(number:)`.

#### Pagination

[`pagination.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/pagination.ts) provides `paginateConnection<T>()` which handles cursor-based pagination for any GraphQL connection. This should be used for `list_projects` since an owner could have many projects.

#### Tool Registration

All tools follow the same pattern:
1. `server.tool(name, description, zodSchema, handler)`
2. Resolve `owner` from args or config via `resolveProjectOwner(client.config)`
3. Use `toolSuccess(data)` / `toolError(message)` from `types.ts`
4. Error handling via try/catch wrapping the entire handler

#### Test Pattern

Tests in `project-tools.test.ts` are **structural** -- they read the source file as a string and verify:
- Zod schema params exist
- Imports are present
- GraphQL query contains expected fields
- Response mapping includes expected keys

No API mocking; purely source-code analysis.

### GitHub GraphQL API: `projectsV2` Connection

The `projectsV2` connection is available on both `User` and `Organization` types:

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
        readme
        items { totalCount }
        fields { totalCount }
        views { totalCount }
      }
    }
  }
}
```

**Available fields on `ProjectV2`**:
- `id` (ID!) -- Global node ID
- `number` (Int!) -- Project number (used by `get_project`)
- `title` (String!) -- Project title
- `shortDescription` (String) -- Short description
- `public` (Boolean!) -- Whether publicly visible
- `closed` (Boolean!) -- Whether project is closed
- `url` (URI!) -- Project URL
- `readme` (String) -- README content
- `createdAt` (DateTime!) -- Creation timestamp
- `updatedAt` (DateTime!) -- Last update timestamp
- `items(first:)` -- Connection to project items (use `totalCount` for count)
- `fields(first:)` -- Connection to project fields (use `totalCount` for count)
- `views(first:)` -- Connection to project views (use `totalCount` for count)

**Filtering options** on the `projectsV2` connection:
- `first` / `after` -- Standard cursor pagination
- `orderBy: {field: TITLE | NUMBER | UPDATED_AT | CREATED_AT, direction: ASC | DESC}`
- `query: String` -- Search string for filtering (searches title and short description)

**Note**: There is no built-in `closed: Boolean` filter parameter on the `projectsV2` connection. Filtering by open/closed must be done client-side after fetching.

### Token Requirements

The `projectsV2` query requires the same `project` scope token used by `get_project`. The existing `client.projectQuery` method handles this automatically via the split-token architecture.

## Key Discoveries

### 1. Simple Implementation -- Mirror `get_project` Pattern

The implementation is straightforward: copy the dual-type resolution pattern from `fetchProject()`, replace `projectV2(number:)` with `projectsV2(first:, after:)`, and use `paginateConnection` for automatic pagination.

### 2. Client-Side Filtering Required for Open/Closed

GitHub's GraphQL API does not provide a `closed` filter parameter on the `projectsV2` connection. The tool must fetch all projects and filter client-side. This is fine in practice -- users rarely have more than ~50 projects.

### 3. Registration in `project-tools.ts`

The new tool should be registered in `registerProjectTools()` alongside the existing project tools. No new file needed -- it fits naturally in the existing module.

### 4. Response Shape Should Match Issue's Spec

The issue specifies returning: `id, number, title, shortDescription, public, closed, url, field count, item count`. This maps directly to GraphQL fields with `totalCount` sub-queries for fields and items.

### 5. No Field Cache Interaction

Unlike `get_project` and `list_project_items`, `list_projects` does not need the `FieldOptionCache` because it does not operate on a specific project's fields. It only enumerates project metadata.

## Potential Approaches

### Approach A: Add to `project-tools.ts` (Recommended)

Add `ralph_hero__list_projects` in `registerProjectTools()`, right after `get_project`.

**Implementation**:
1. Zod schema: `owner` (optional, defaults from config), `state` (optional, "open" | "closed" | "all", default "open")
2. Dual-type resolution: try `user.projectsV2`, then `organization.projectsV2`
3. Pagination via `paginateConnection`
4. Client-side filter for open/closed state
5. Return: array of project summaries

**Pros**: Follows existing patterns exactly. No new files. Minimal diff.
**Cons**: `project-tools.ts` grows slightly (~80 lines).

### Approach B: Separate `project-list-tools.ts`

Create a new tool file for project listing.

**Pros**: Smaller files.
**Cons**: Creates a new registration function, new import in `index.ts`, more boilerplate for a single tool.

## Risks and Edge Cases

1. **User with zero projects**: Should return empty array, not error. The `paginateConnection` handles this naturally (returns `{ nodes: [], totalCount: 0 }`).

2. **User vs Organization ambiguity**: Same as existing tools -- try user first, fall back to org. If both fail, return error.

3. **Large project count**: Pagination via `paginateConnection` handles this. Default `limit: 50` prevents runaway fetches.

4. **Closed projects**: Many users have closed projects. Default to `state: "open"` to avoid clutter.

5. **Token scoping**: Projects from organizations may require org-level project access. The existing `projectQuery` (with project token) handles this.

## Estimate Assessment

Current estimate: **S** -- This is appropriate. The implementation is a single tool with well-established patterns to follow. The GraphQL query, dual-type resolution, and pagination are all proven in the codebase. No new infrastructure needed.

## Recommended Next Steps

1. Use Approach A -- add `ralph_hero__list_projects` to `registerProjectTools()` in `project-tools.ts`
2. Follow the `fetchProject()` dual-type pattern for user/org resolution
3. Use `paginateConnection` for automatic pagination
4. Add `state` filter parameter with client-side filtering (default: "open")
5. Add structural tests following `project-tools.test.ts` pattern
6. No need for field cache interaction
