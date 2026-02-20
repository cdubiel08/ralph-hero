---
date: 2026-02-19
github_issue: 122
github_url: https://github.com/cdubiel08/ralph-hero/issues/122
status: complete
type: research
---

# GH-122: Add `update_project` MCP Tool

## Problem Statement

GitHub Projects V2 have project-level metadata (title, description, README, visibility, open/closed state) that can be managed via the `updateProjectV2` mutation. The ralph-hero MCP server can create projects but cannot update their settings after creation.

## Current State Analysis

### Existing Project Support

- **Create**: [`project-tools.ts:173`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-tools.ts#L173) — `createProjectV2` with `title` param
- **Read**: [`project-tools.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-tools.ts) — `get_project`, `list_project_items`
- **Type**: [`types.ts:167-177`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/types.ts#L167) — `ProjectV2` interface includes `shortDescription` and `closed` fields
- **No Update**: No `updateProjectV2` mutation call exists anywhere in the codebase

### GitHub GraphQL API

**Mutation: `updateProjectV2`**

Input (`UpdateProjectV2Input!`):

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `projectId` | `ID` | Yes | Project node ID |
| `title` | `String` | No | New project title |
| `shortDescription` | `String` | No | Short summary for listings |
| `readme` | `String` | No | Full README in markdown |
| `public` | `Boolean` | No | Visibility (true=public) |
| `closed` | `Boolean` | No | Close/reopen state |
| `clientMutationId` | `String` | No | Idempotency key |

All non-`projectId` fields are optional. Only supplied fields are updated.

Return (`UpdateProjectV2Payload`):

| Field | Type | Description |
|-------|------|-------------|
| `projectV2` | `ProjectV2` | Full updated project object |

**Key notes:**
- No separate close/reopen mutation — `closed` boolean handles both
- `public` changes on org projects may be restricted by org-level policies
- Requires project admin permissions (owner or org member with admin rights)

## Key Discoveries

### 1. Pattern Reference: `createProjectV2`

The existing `setup_project` tool in [`project-tools.ts:173`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-tools.ts#L173) calls `createProjectV2`. The `update_project` tool follows the same pattern but calls `updateProjectV2` instead.

### 2. Project ID Resolution Already Works

`fieldCache.getProjectId()` returns the project node ID after `ensureFieldCache()` populates it. This is exactly what `updateProjectV2` needs as its `projectId` input.

### 3. `ProjectV2` Type Already Defined

[`types.ts:167-177`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/types.ts#L167) includes `shortDescription` and `closed`. May need to add `readme` and `public` fields to the interface for the return type, or use an inline type at the call site.

### 4. Idea Doc: Project README as Living Documentation

[`thoughts/ideas/2026-02-18-github-projects-v2-docs-deep-dive.md:290-297`](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/ideas/2026-02-18-github-projects-v2-docs-deep-dive.md#L290) describes auto-generating project READMEs from Ralph config. The `update_project` tool is the prerequisite for that workflow.

## Recommended Approach

Add to `project-management-tools.ts`:

```typescript
server.tool(
  "ralph_hero__update_project",
  "Update project settings — title, description, README, visibility, open/closed state",
  {
    owner: z.string().optional(),
    repo: z.string().optional(),
    title: z.string().optional().describe("New project title"),
    shortDescription: z.string().optional().describe("Short summary for listings"),
    readme: z.string().optional().describe("Full README in markdown"),
    public: z.boolean().optional().describe("Visibility (true=public, false=private)"),
    closed: z.boolean().optional().describe("Close (true) or reopen (false) the project"),
  },
  async (args) => { ... }
);
```

Data flow:
1. `resolveFullConfig(client, args)` → resolve project context
2. `ensureFieldCache(...)` → populate field/option IDs
3. `fieldCache.getProjectId()` → project node ID
4. Build mutation variables from only the provided optional fields
5. `client.projectMutate<{ updateProjectV2: { projectV2: { id, title, ... } } }>(...)`
6. Return updated project fields

### Validation

- Require at least one optional field to be provided (no-op prevention)
- No field name conflicts: `title`, `shortDescription`, `readme`, `public`, `closed` are all safe (not reserved by `@octokit/graphql` v9)

## Risks

1. **Org visibility policies**: Setting `public: true` may fail on org projects with restricted visibility settings. The error should be surfaced clearly.
2. **Closing active projects**: Setting `closed: true` doesn't archive items — it just hides the project from the active list. Users may expect archival behavior.
3. **Type expansion**: May need to add `readme` and `public` to the `ProjectV2` interface in `types.ts`, or use inline types.

## Recommended Next Steps

1. Implement in `project-management-tools.ts`
2. Add validation: require at least one update field
3. Optionally extend `ProjectV2` interface in `types.ts` with `readme` and `public` fields
4. Add structural tests following existing pattern
