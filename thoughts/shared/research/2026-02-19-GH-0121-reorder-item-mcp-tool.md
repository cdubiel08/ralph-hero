---
date: 2026-02-19
github_issue: 121
github_url: https://github.com/cdubiel08/ralph-hero/issues/121
status: complete
type: research
---

# GH-121: Add `reorder_item` MCP Tool

## Problem Statement

GitHub Projects V2 items have a display order within views. The ralph-hero MCP server has no tool to control item positioning, preventing automated priority-based sorting (e.g., moving P0 items to the top of their column).

## Current State Analysis

### No Existing Implementation

No implementation of `reorder_item`, `updateProjectV2ItemPosition`, or any item positioning logic exists in the codebase. The mutation is documented in research at [`thoughts/shared/research/2026-02-18-GH-0064-github-projects-v2-api-automation.md:108`](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-18-GH-0064-github-projects-v2-api-automation.md#L108) as unimplemented.

### GitHub GraphQL API

**Mutation: `updateProjectV2ItemPosition`**

Input (`UpdateProjectV2ItemPositionInput!`):

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `projectId` | `ID` | Yes | Project node ID |
| `itemId` | `ID` | Yes | ProjectV2Item node ID to reposition |
| `afterId` | `ID` | No | Item to place after; omit/null for top |
| `clientMutationId` | `String` | No | Idempotency key |

Return (`UpdateProjectV2ItemPositionPayload`):

| Field | Type | Description |
|-------|------|-------------|
| `item` | `ProjectV2Item` | The repositioned item |

**Key notes:**
- `afterId` accepts a `ProjectV2Item` node ID (not issue/PR node ID)
- Omitting `afterId` moves the item to the top
- Position only affects default view ordering; custom-sorted views may not reflect changes

## Key Discoveries

### 1. Follows Standard Project Management Tool Pattern

The tool fits perfectly in [`project-management-tools.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts) using the established pattern:

1. `resolveFullConfig(client, args)` → resolve project context
2. `ensureFieldCache(...)` → populate field IDs
3. `fieldCache.getProjectId()` → get project node ID
4. `client.projectMutate(...)` → execute mutation

### 2. Item ID Resolution

The tool needs a `ProjectV2Item` node ID. Two approaches:
- **Accept `number` param**: Resolve via `resolveProjectItemId()` from [`helpers.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/helpers.ts) (consistent with other tools)
- **Accept `itemId` param**: Direct project item ID (needed for `afterId` anyway)

Recommended: Accept `number` (issue number) for the item to move, and `afterNumber` (optional issue number) for positioning. Resolve both to project item IDs internally using `resolveProjectItemId()`.

### 3. Simple Mutation — No Post-Mutation Field Updates

Unlike `create_draft_issue`, this tool has no optional field-setting step. It's a single mutation call with a simple response.

## Recommended Approach

Add to `project-management-tools.ts` with this interface:

```typescript
server.tool(
  "ralph_hero__reorder_item",
  "Set item position within project views",
  {
    owner: z.string().optional(),
    repo: z.string().optional(),
    number: z.number().describe("Issue number to reposition"),
    afterNumber: z.number().optional().describe("Issue number to place after; omit for top"),
  },
  async (args) => { ... }
);
```

Data flow:
1. Resolve project context and item IDs
2. Call `updateProjectV2ItemPosition` with `projectId`, `itemId`, and optional `afterId`
3. Return `{ number, position: "top" | "after #N" }`

## Risks

1. **View-specific ordering**: Position changes may not apply to views with custom sort rules. This is a GitHub limitation, not something the tool can control.
2. **Batch reordering**: Moving multiple items requires sequential calls. No batch mutation exists.

## Recommended Next Steps

1. Implement in `project-management-tools.ts`
2. Accept `number` and `afterNumber` params (resolve to project item IDs internally)
3. Add structural tests following existing pattern
