---
date: 2026-02-19
github_issue: 120
github_url: https://github.com/cdubiel08/ralph-hero/issues/120
status: complete
type: research
---

# GH-120: Add `create_draft_issue` and `update_draft_issue` MCP Tools

## Problem Statement

GitHub Projects V2 supports draft issues — lightweight project items with title and body that live in the project without a repository. The ralph-hero MCP server currently has no tools to create or update draft issues, despite the `DraftIssue` type already being defined and read fragments existing.

## Current State Analysis

### Existing Draft Issue Support

The codebase already handles draft issues in read paths:

- **Type definition**: [`types.ts:132-136`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/types.ts#L132) — `DraftIssue` interface with `__typename`, `title`, `body`
- **ProjectV2Item union**: [`types.ts:125-130`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/types.ts#L125) — `content` field includes `DraftIssue` in union type, `type` field includes `"DRAFT_ISSUE"`
- **Query fragments**: [`project-tools.ts:460-463`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-tools.ts#L460) — `... on DraftIssue { title body }` in project items query
- **Dashboard exclusion**: [`dashboard-tools.ts:154`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts#L154) — explicitly filters out drafts with comment `// Only include issues (not PRs or drafts)`

### Missing: Mutation Tools

No tools exist to call `addProjectV2DraftIssue` or `updateProjectV2DraftIssue`. These were classified as P3 and explicitly deferred from the GH-62 implementation group.

### GitHub GraphQL API

Two mutations are needed:

1. **`addProjectV2DraftIssue`** — Creates a draft issue in a project
   - Input: `projectId: ID!`, `title: String!`, `body: String`
   - Returns: `projectV2Item { id }` (the project item node ID)

2. **`updateProjectV2DraftIssue`** — Updates an existing draft issue
   - Input: `draftIssueId: ID!`, `title: String`, `body: String`
   - Returns: `projectV2Item { id }`

## Key Discoveries

### 1. Tool Registration Pattern

All project management tools follow the same structure in [`project-management-tools.ts:24-393`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts#L24):

```typescript
server.tool(
  "ralph_hero__<tool_name>",
  "Description string",
  { /* zod schema */ },
  async (args) => {
    const { owner, repo, projectNumber, projectOwner } = resolveFullConfig(client, args);
    await ensureFieldCache(client, fieldCache, projectOwner, projectNumber);
    const projectId = fieldCache.getProjectId();
    // ... mutation logic
  },
);
```

### 2. `projectMutate` Pattern

[`github-client.ts:228-239`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/github-client.ts#L228) — Mutations go through `client.projectMutate<T>()` which automatically invalidates `query:`-prefixed cache entries.

Example from `add_to_project` at [`project-management-tools.ts:195-209`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts#L195):

```typescript
const result = await client.projectMutate<{
  addProjectV2ItemById: { item: { id: string } };
}>(`mutation($projectId: ID!, $contentId: ID!) { ... }`, { projectId, contentId });
```

### 3. Optional Field Setting After Creation

The `create_issue` tool at [`issue-tools.ts:716-745`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L716) shows the pattern for setting fields post-creation:

```typescript
if (args.workflowState) {
  await updateProjectItemField(client, fieldCache, projectItemId, "Workflow State", args.workflowState);
}
```

The `updateProjectItemField` helper at [`helpers.ts:222-261`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/helpers.ts#L222) resolves field/option IDs from `FieldOptionCache` and calls `updateProjectV2ItemFieldValue`.

### 4. Draft Issues Have No Issue Number

Unlike repo issues, draft issues have no `number`, `url`, `state`, or `labels`. They are identified by their project item ID (`PVTI_*`). This means:
- No `project-item-id:owner/repo#number` cache entry can be written (no issue number exists)
- The `update_draft_issue` tool must accept `projectItemId` as its identifier
- The tool response should return `projectItemId` and `title` (not a number/URL)

### 5. Test Pattern

Tests in [`__tests__/project-management-tools.test.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/__tests__/project-management-tools.test.ts) are structural — they inline mutation strings and assert on substring presence using `expect(mutation).toContain()`. No mock client or field cache is needed.

## Potential Approaches

### Approach A: Add to `project-management-tools.ts` (Recommended)

Add both tools to the existing `project-management-tools.ts` file alongside `archive_item`, `remove_from_project`, `add_to_project`, `link_repository`, and `clear_field`.

**Pros:**
- Follows the established pattern — draft issues are project-side operations
- Reuses `resolveFullConfig`, `ensureFieldCache`, `projectMutate`
- Co-located with related project management tools

**Cons:**
- File grows from ~393 to ~500 lines (still manageable)

### Approach B: New `draft-tools.ts` file

Create a separate file for draft issue operations.

**Pros:**
- Clean separation of concerns

**Cons:**
- Overkill for two tools
- Requires new import and registration in `index.ts`
- Breaks the pattern of grouping project operations together

### Recommended: Approach A

## Implementation Details

### `create_draft_issue` Tool

```typescript
server.tool(
  "ralph_hero__create_draft_issue",
  "Create a draft issue in the project (no repo required)",
  {
    owner: z.string().optional(),
    repo: z.string().optional(),
    title: z.string().describe("Draft issue title"),
    body: z.string().optional().describe("Draft issue body (markdown)"),
    workflowState: z.string().optional().describe("Workflow state to set after creation"),
    priority: z.string().optional().describe("Priority to set after creation"),
    estimate: z.string().optional().describe("Estimate to set after creation"),
  },
  async (args) => { ... }
);
```

Data flow:
1. `resolveFullConfig(client, args)` → get `projectOwner`, `projectNumber`
2. `ensureFieldCache(...)` → populate field/option IDs
3. `fieldCache.getProjectId()` → project node ID
4. `client.projectMutate<{ addProjectV2DraftIssue: { projectItem: { id: string } } }>()` with `projectId`, `title`, `body`
5. Extract `projectItemId` from response
6. Optionally call `updateProjectItemField()` for each provided field (workflowState, priority, estimate)
7. Return `{ projectItemId, title }`

### `update_draft_issue` Tool

```typescript
server.tool(
  "ralph_hero__update_draft_issue",
  "Update title and/or body of an existing draft issue",
  {
    owner: z.string().optional(),
    repo: z.string().optional(),
    projectItemId: z.string().describe("Project item ID of the draft issue"),
    title: z.string().optional().describe("New title"),
    body: z.string().optional().describe("New body (markdown)"),
  },
  async (args) => { ... }
);
```

Note: `updateProjectV2DraftIssue` uses `draftIssueId` (the content node ID), not `projectItemId`. The tool may need to resolve the draft issue content ID from the project item ID, or accept the draft issue ID directly. This needs verification against the GitHub API.

## Risks

1. **Draft issue ID resolution**: `updateProjectV2DraftIssue` may require the `DraftIssue` content node ID rather than the `ProjectV2Item` ID. Need to verify the exact input field name and whether querying the project item returns the content ID.
2. **Field setting on drafts**: Need to verify that `updateProjectV2ItemFieldValue` works on draft issue project items the same way it works on regular issue project items.
3. **Dashboard/list impact**: Draft issues are currently excluded from `dashboard-tools.ts`. After this tool exists, users may want to include/exclude drafts in lists — this is tracked separately in #108.

## Recommended Next Steps

1. Implement both tools in `project-management-tools.ts` following Approach A
2. Add structural tests following the existing pattern
3. Verify `updateProjectV2DraftIssue` input field requirements against GitHub API docs
4. Consider whether `create_draft_issue` should default to setting Workflow State to "Backlog"
