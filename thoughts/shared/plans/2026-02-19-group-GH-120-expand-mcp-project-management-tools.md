---
date: 2026-02-19
status: draft
github_issues: [120, 121, 122, 123, 124]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/120
  - https://github.com/cdubiel08/ralph-hero/issues/121
  - https://github.com/cdubiel08/ralph-hero/issues/122
  - https://github.com/cdubiel08/ralph-hero/issues/123
  - https://github.com/cdubiel08/ralph-hero/issues/124
primary_issue: 120
---

# Expand MCP Project Management Tools - Atomic Implementation Plan

## Overview

5 related issues adding new MCP tools to `project-management-tools.ts` for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-120 | Add `create_draft_issue` and `update_draft_issue` MCP tools | S |
| 2 | GH-121 | Add `reorder_item` MCP tool | S |
| 3 | GH-122 | Add `update_project` MCP tool | S |
| 4 | GH-123 | Add `delete_field` MCP tool | S |
| 5 | GH-124 | Add `update_collaborators` MCP tool | XS |

**Why grouped**: All 5 issues are siblings under Epic #98 (Expand MCP Server API Coverage). They all add new tools to `project-management-tools.ts` following the identical `server.tool()` + `resolveFullConfig()` + `ensureFieldCache()` + `projectMutate()` pattern. No dependencies between phases — order is by complexity (most complex first).

## Current State Analysis

All 5 tools target [`project-management-tools.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts) which currently has 5 tools (394 lines):
- `ralph_hero__archive_item` (lines 29-100)
- `ralph_hero__remove_from_project` (lines 102-161)
- `ralph_hero__add_to_project` (lines 163-230)
- `ralph_hero__link_repository` (lines 232-324)
- `ralph_hero__clear_field` (lines 326-392)

Supporting infrastructure already exists:
- [`helpers.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/helpers.ts): `resolveFullConfig()` (line 345), `ensureFieldCache()` (line 91), `resolveProjectItemId()` (line 153), `updateProjectItemField()` (line 222), `resolveIssueNodeId()` (line 119)
- [`cache.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/cache.ts): `FieldOptionCache.getProjectId()` (line 155), `FieldOptionCache.getFieldId()` (line 148), `FieldOptionCache.clear()` (line 184)
- [`types.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/types.ts): `DraftIssue` (line 132), `ProjectV2` (line 167), `toolSuccess()` (line 246), `toolError()` (line 252)
- [`project-management-tools.test.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/__tests__/project-management-tools.test.ts): Structural mutation string tests (13 existing tests)

## Desired End State

### Verification
- [x] `create_draft_issue` creates a project draft with optional field setting
- [x] `update_draft_issue` updates title/body of an existing draft
- [x] `reorder_item` repositions an item within the project view
- [x] `update_project` edits project title, description, README, visibility, closed state
- [x] `delete_field` deletes custom fields with safety guardrails and dry-run default
- [x] `update_collaborators` manages project access for users and teams
- [x] All 7 new tools registered in MCP server (2 from GH-120, 1 each from GH-121-124)
- [x] All existing tests pass (`npm test`)
- [x] New structural tests added for each mutation
- [x] `npm run build` succeeds with no type errors

## What We're NOT Doing
- Not modifying dashboard/list tools to include/exclude drafts (tracked in GH-108)
- Not adding batch reordering — single item positioning only
- Not auto-generating project READMEs (future use case, enabled by `update_project`)
- Not adding user/team lookup tools — `update_collaborators` resolves IDs internally
- Not modifying `index.ts` — `registerProjectManagementTools()` is already called there

## Implementation Approach

All 5 phases append new `server.tool()` registrations to the `registerProjectManagementTools()` function body in `project-management-tools.ts`. Each phase adds its corresponding structural tests to `project-management-tools.test.ts`. Phases are independent — no phase depends on artifacts from another phase.

The common pattern for every new tool:
```typescript
server.tool(
  "ralph_hero__<name>",
  "<description>",
  { /* zod schema with owner/repo optional */ },
  async (args) => {
    try {
      const { owner, repo, projectNumber, projectOwner } = resolveFullConfig(client, args);
      await ensureFieldCache(client, fieldCache, projectOwner, projectNumber);
      const projectId = fieldCache.getProjectId();
      if (!projectId) return toolError("Could not resolve project ID");
      // ... tool-specific logic using client.projectMutate() ...
      return toolSuccess({ /* result */ });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return toolError(`Failed to <action>: ${message}`);
    }
  },
);
```

---

## Phase 1: GH-120 — Add `create_draft_issue` and `update_draft_issue` MCP tools
> **Issue**: [GH-120](https://github.com/cdubiel08/ralph-hero/issues/120) | **Research**: [2026-02-19-GH-0120-draft-issue-mcp-tools.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-19-GH-0120-draft-issue-mcp-tools.md)

### Changes Required

#### 1. Add `create_draft_issue` tool
**File**: `plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts`
**Changes**: Append new `server.tool()` registration after the `clear_field` tool (after line 392).

Tool parameters (zod schema):
- `owner`: `z.string().optional()`
- `repo`: `z.string().optional()`
- `title`: `z.string().describe("Draft issue title")`
- `body`: `z.string().optional().describe("Draft issue body (markdown)")`
- `workflowState`: `z.string().optional().describe("Workflow state to set after creation")`
- `priority`: `z.string().optional().describe("Priority to set after creation")`
- `estimate`: `z.string().optional().describe("Estimate to set after creation")`

Handler logic:
1. `resolveFullConfig(client, args)` + `ensureFieldCache(...)` + `fieldCache.getProjectId()`
2. `client.projectMutate<{ addProjectV2DraftIssue: { projectItem: { id: string } } }>()` with mutation:
   ```graphql
   mutation($projectId: ID!, $title: String!, $body: String) {
     addProjectV2DraftIssue(input: { projectId: $projectId, title: $title, body: $body }) {
       projectItem { id }
     }
   }
   ```
3. Extract `projectItemId` from `result.addProjectV2DraftIssue.projectItem.id`
4. If `args.workflowState` → `updateProjectItemField(client, fieldCache, projectItemId, "Workflow State", args.workflowState)`
5. If `args.priority` → `updateProjectItemField(client, fieldCache, projectItemId, "Priority", args.priority)`
6. If `args.estimate` → `updateProjectItemField(client, fieldCache, projectItemId, "Estimate", args.estimate)`
7. Return `toolSuccess({ projectItemId, title: args.title, fieldsSet: [...] })`

#### 2. Add `update_draft_issue` tool
**File**: `plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts`
**Changes**: Append after `create_draft_issue`.

Tool parameters:
- `owner`: `z.string().optional()`
- `repo`: `z.string().optional()`
- `draftIssueId`: `z.string().describe("Draft issue content node ID (DI_...)")`
- `title`: `z.string().optional().describe("New title")`
- `body`: `z.string().optional().describe("New body (markdown)")`

Handler logic:
1. Validate at least one of `title` or `body` is provided
2. `resolveFullConfig(client, args)` + `ensureFieldCache(...)` (for consistency, though not strictly needed)
3. `client.projectMutate()` with mutation:
   ```graphql
   mutation($draftIssueId: ID!, $title: String, $body: String) {
     updateProjectV2DraftIssue(input: { draftIssueId: $draftIssueId, title: $title, body: $body }) {
       projectItem { id }
     }
   }
   ```
4. Return `toolSuccess({ draftIssueId: args.draftIssueId, updated: true })`

Note: `updateProjectV2DraftIssue` uses `draftIssueId` (the `DraftIssue` content node ID, prefix `DI_`), not the `ProjectV2Item` ID (prefix `PVTI_`). The `create_draft_issue` tool returns the `projectItem.id` — the caller will need the draft content ID for updates. This is a known API asymmetry documented in the research.

#### 3. Add structural tests
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/project-management-tools.test.ts`
**Changes**: Add new tests in the `"project management mutations"` describe block.

Tests to add:
- `"addProjectV2DraftIssue mutation has required input fields"` — assert `toContain("addProjectV2DraftIssue")`, `toContain("projectId")`, `toContain("title")`
- `"updateProjectV2DraftIssue mutation has required input fields"` — assert `toContain("updateProjectV2DraftIssue")`, `toContain("draftIssueId")`, `toContain("title")`, `toContain("body")`

### Success Criteria
- [x] Automated: `npm test` passes with new tests
- [x] Automated: `npm run build` succeeds
- [ ] Manual: `create_draft_issue` tool appears in MCP tool list
- [ ] Manual: `update_draft_issue` tool appears in MCP tool list

**Creates for next phase**: Pattern for optional post-creation field setting (reusable concept, not code dependency)

---

## Phase 2: GH-121 — Add `reorder_item` MCP tool
> **Issue**: [GH-121](https://github.com/cdubiel08/ralph-hero/issues/121) | **Research**: [2026-02-19-GH-0121-reorder-item-mcp-tool.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-19-GH-0121-reorder-item-mcp-tool.md)

### Changes Required

#### 1. Add `reorder_item` tool
**File**: `plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts`
**Changes**: Append new `server.tool()` registration.

Tool parameters:
- `owner`: `z.string().optional()`
- `repo`: `z.string().optional()`
- `number`: `z.number().describe("Issue number to reposition")`
- `afterNumber`: `z.number().optional().describe("Issue number to place after; omit to move to top")`

Handler logic:
1. `resolveFullConfig(client, args)` + `ensureFieldCache(...)` + `fieldCache.getProjectId()`
2. `resolveProjectItemId(client, fieldCache, owner, repo, args.number)` → `itemId`
3. If `args.afterNumber` → `resolveProjectItemId(client, fieldCache, owner, repo, args.afterNumber)` → `afterId`
4. `client.projectMutate()` with mutation:
   ```graphql
   mutation($projectId: ID!, $itemId: ID!, $afterId: ID) {
     updateProjectV2ItemPosition(input: { projectId: $projectId, itemId: $itemId, afterId: $afterId }) {
       items(first: 1) { nodes { id } }
     }
   }
   ```
5. Return `toolSuccess({ number: args.number, position: args.afterNumber ? "after #" + args.afterNumber : "top" })`

#### 2. Add structural tests
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/project-management-tools.test.ts`
**Changes**: Add test in `"project management mutations"` describe block.

Tests to add:
- `"updateProjectV2ItemPosition mutation has required input fields"` — assert `toContain("updateProjectV2ItemPosition")`, `toContain("projectId")`, `toContain("itemId")`, `toContain("afterId")`

### Success Criteria
- [x] Automated: `npm test` passes
- [x] Automated: `npm run build` succeeds
- [ ] Manual: `reorder_item` tool appears in MCP tool list

**Creates for next phase**: Nothing (independent)

---

## Phase 3: GH-122 — Add `update_project` MCP tool
> **Issue**: [GH-122](https://github.com/cdubiel08/ralph-hero/issues/122) | **Research**: [2026-02-19-GH-0122-update-project-mcp-tool.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-19-GH-0122-update-project-mcp-tool.md)

### Changes Required

#### 1. Add `update_project` tool
**File**: `plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts`
**Changes**: Append new `server.tool()` registration.

Tool parameters:
- `owner`: `z.string().optional()`
- `repo`: `z.string().optional()`
- `title`: `z.string().optional().describe("New project title")`
- `shortDescription`: `z.string().optional().describe("Short summary for listings")`
- `readme`: `z.string().optional().describe("Full README in markdown")`
- `public`: `z.boolean().optional().describe("Visibility (true=public, false=private)")`
- `closed`: `z.boolean().optional().describe("Close (true) or reopen (false) the project")`

Handler logic:
1. Validate at least one of `title`, `shortDescription`, `readme`, `public`, `closed` is provided — return `toolError("At least one field to update must be provided")` if none
2. `resolveFullConfig(client, args)` + `ensureFieldCache(...)` + `fieldCache.getProjectId()`
3. Build mutation variables dynamically — only include provided fields:
   ```typescript
   const vars: Record<string, unknown> = { projectId };
   const varDefs: string[] = ["$projectId: ID!"];
   const inputFields: string[] = ["projectId: $projectId"];
   if (args.title !== undefined) { vars.title = args.title; varDefs.push("$title: String"); inputFields.push("title: $title"); }
   // ... repeat for each optional field
   ```
4. `client.projectMutate<{ updateProjectV2: { projectV2: { id: string; title: string } } }>()` with dynamically built mutation
5. Return `toolSuccess({ projectId, updated: true, fields: [list of updated field names] })`

#### 2. Add structural tests
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/project-management-tools.test.ts`
**Changes**: Add test in `"project management mutations"` describe block.

Tests to add:
- `"updateProjectV2 mutation has required input fields"` — assert `toContain("updateProjectV2")`, `toContain("projectId")`

### Success Criteria
- [x] Automated: `npm test` passes
- [x] Automated: `npm run build` succeeds
- [ ] Manual: `update_project` tool appears in MCP tool list

**Creates for next phase**: Nothing (independent)

---

## Phase 4: GH-123 — Add `delete_field` MCP tool
> **Issue**: [GH-123](https://github.com/cdubiel08/ralph-hero/issues/123) | **Research**: [2026-02-19-GH-0123-delete-field-mcp-tool.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-19-GH-0123-delete-field-mcp-tool.md)

### Changes Required

#### 1. Add `delete_field` tool
**File**: `plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts`
**Changes**: Append new `server.tool()` registration.

Tool parameters:
- `owner`: `z.string().optional()`
- `repo`: `z.string().optional()`
- `field`: `z.string().describe("Name of the field to delete")`
- `confirm`: `z.boolean().optional().default(false).describe("Must be true to execute deletion; false for dry-run")`

Handler logic:
1. `resolveFullConfig(client, args)` + `ensureFieldCache(...)` + `fieldCache.getProjectId()`
2. Check against protected fields list:
   ```typescript
   const PROTECTED_FIELDS = ["Workflow State", "Priority", "Estimate", "Status"];
   if (PROTECTED_FIELDS.includes(args.field)) {
     return toolError(`Cannot delete protected field "${args.field}". Protected fields: ${PROTECTED_FIELDS.join(", ")}`);
   }
   ```
3. Resolve field ID: `const fieldId = fieldCache.getFieldId(args.field)`
   - If `undefined` → return `toolError("Field not found: ...")`
4. If `!args.confirm` → return `toolSuccess({ field: args.field, fieldId, action: "would_delete", confirm: false, message: "Dry run. Set confirm=true to delete." })`
5. If `args.confirm` → `client.projectMutate()` with mutation:
   ```graphql
   mutation($projectId: ID!, $fieldId: ID!) {
     deleteProjectV2Field(input: { projectId: $projectId, fieldId: $fieldId }) {
       projectV2Field { ... on ProjectV2SingleSelectField { id name } ... on ProjectV2Field { id name } }
     }
   }
   ```
6. After successful deletion, invalidate field cache: `fieldCache.clear()`
7. Return `toolSuccess({ field: args.field, deleted: true })`

#### 2. Add structural tests
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/project-management-tools.test.ts`
**Changes**: Add tests in `"project management mutations"` describe block and a new `"delete_field safety"` describe block.

Tests to add:
- `"deleteProjectV2Field mutation has required input fields"` — assert `toContain("deleteProjectV2Field")`, `toContain("projectId")`, `toContain("fieldId")`
- `"protected fields list includes required Ralph fields"` — test the hardcoded `PROTECTED_FIELDS` array contains `"Workflow State"`, `"Priority"`, `"Estimate"`, `"Status"`

To support the protected fields test, export the `PROTECTED_FIELDS` constant from `project-management-tools.ts`.

### Success Criteria
- [x] Automated: `npm test` passes with safety guardrail tests
- [x] Automated: `npm run build` succeeds
- [ ] Manual: `delete_field` with `confirm: false` returns dry-run result
- [ ] Manual: `delete_field` refuses to delete "Workflow State"

**Creates for next phase**: Nothing (independent)

---

## Phase 5: GH-124 — Add `update_collaborators` MCP tool
> **Issue**: [GH-124](https://github.com/cdubiel08/ralph-hero/issues/124) | **Research**: [2026-02-19-GH-0124-update-collaborators-mcp-tool.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-19-GH-0124-update-collaborators-mcp-tool.md)

### Changes Required

#### 1. Add `update_collaborators` tool
**File**: `plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts`
**Changes**: Append new `server.tool()` registration.

Tool parameters:
- `owner`: `z.string().optional()`
- `repo`: `z.string().optional()`
- `collaborators`: `z.array(z.object({ username: z.string().optional(), teamSlug: z.string().optional(), role: z.enum(["READER", "WRITER", "ADMIN", "NONE"]) })).describe("List of collaborator changes")`

Handler logic:
1. `resolveFullConfig(client, args)` + `ensureFieldCache(...)` + `fieldCache.getProjectId()`
2. Validate each collaborator entry has exactly one of `username` or `teamSlug`
3. Resolve identifiers to node IDs:
   - For `username`: `client.query<{ user: { id: string } }>()` with `query { user(login: $login) { id } }`
   - For `teamSlug`: `client.query<{ organization: { team: { id: string } } }>()` with `query { organization(login: $org) { team(slug: $slug) { id } } }` using `projectOwner` as `$org`
   - If `teamSlug` and project owner is not an org, return `toolError("Team collaborators require an organization-owned project")`
4. Build `collaborators` array with resolved `userId`/`teamId` and `role`
5. `client.projectMutate()` with mutation:
   ```graphql
   mutation($projectId: ID!, $collaborators: [ProjectV2Collaborator!]!) {
     updateProjectV2Collaborators(input: { projectId: $projectId, collaborators: $collaborators }) {
       collaborators { totalCount }
     }
   }
   ```
6. Return `toolSuccess({ updated: true, collaboratorCount: args.collaborators.length })`

Note: The exact GraphQL input type name for collaborators needs verification — research notes `ProjectV2CollaboratorInput` but the mutation variable type may differ. Use the mutation input directly if the nested type name is not accepted.

#### 2. Add structural tests
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/project-management-tools.test.ts`
**Changes**: Add test in `"project management mutations"` describe block.

Tests to add:
- `"updateProjectV2Collaborators mutation has required input fields"` — assert `toContain("updateProjectV2Collaborators")`, `toContain("projectId")`, `toContain("collaborators")`

### Success Criteria
- [x] Automated: `npm test` passes
- [x] Automated: `npm run build` succeeds
- [ ] Manual: `update_collaborators` tool appears in MCP tool list

---

## Integration Testing

- [x] `npm run build` compiles all new tools with no type errors
- [x] `npm test` passes all existing + new structural tests (182 total)
- [ ] All 7 new tools appear in MCP server tool listing
- [ ] `project-management-tools.ts` follows consistent pattern across all 10 tools (5 existing + 5 new = 10, but GH-120 adds 2 tools so total is 12)

## File Ownership

All phases modify the same two files:
- `plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts` — tool implementations (all 5 phases append)
- `plugin/ralph-hero/mcp-server/src/__tests__/project-management-tools.test.ts` — structural tests (all 5 phases append)

Phase 4 also exports `PROTECTED_FIELDS` from `project-management-tools.ts` for testing.

No other files need modification — `types.ts`, `helpers.ts`, `cache.ts`, and `index.ts` all provide sufficient existing infrastructure.

## References

- Research: [GH-0120](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-19-GH-0120-draft-issue-mcp-tools.md), [GH-0121](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-19-GH-0121-reorder-item-mcp-tool.md), [GH-0122](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-19-GH-0122-update-project-mcp-tool.md), [GH-0123](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-19-GH-0123-delete-field-mcp-tool.md), [GH-0124](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-19-GH-0124-update-collaborators-mcp-tool.md)
- Parent Epic: [GH-98](https://github.com/cdubiel08/ralph-hero/issues/98)
- Pattern reference: [project-management-tools.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts)
- API reference: [GitHub Projects V2 API research](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-18-GH-0064-github-projects-v2-api-automation.md)
