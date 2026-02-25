---
date: 2026-02-25
status: draft
github_issues: [398]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/398
primary_issue: 398
---

# `get_draft_issue` MCP Tool — Implementation Plan

## Overview

Add a `ralph_hero__get_draft_issue` tool that reads the full content (title, body, metadata) of one or more draft issues. This is the last major gap in draft issue management — we can create, update, list, archive, convert, and remove drafts, but we cannot read a single draft's body.

## Current State Analysis

### What exists:
- `create_draft_issue` — creates, returns `projectItemId` (PVTI_) + `draftIssueId` (DI_)
- `update_draft_issue` — updates title/body, requires DI_ ID
- `convert_draft_issue` — converts to real issue, requires PVTI_ ID
- `archive_item` — archives via `number` or `projectItemId`
- `remove_from_project` — removes via `number` or `projectItemId`
- `list_project_items(itemType="DRAFT_ISSUE")` — lists drafts with `itemId`, `draftIssueId`, title, workflow state, estimate, priority. **Does not include body.**

### The gap:
No tool can read a draft's body/description. `list_project_items` fetches `body` from the API (`project-tools.ts:933`) but drops it in the formatted output (`project-tools.ts:1061-1085`). There is no `get_draft_issue` equivalent.

### Key discovery:
The GitHub GraphQL `node()` query supports both ID types:
- `node(id: "DI_...")` returns a `DraftIssue` with `id`, `title`, `body`, `creator`, `createdAt`, `updatedAt`
- `node(id: "PVTI_...")` returns a `ProjectV2Item` with `content { ... on DraftIssue { ... } }` plus field values

## Desired End State

A single `ralph_hero__get_draft_issue` tool that:
1. Accepts one ID or an array of IDs (DI_ or PVTI_, auto-detected by prefix)
2. Returns full content: title, body, creator, createdAt, updatedAt
3. For PVTI_ IDs, also returns project field values (workflow state, estimate, priority)
4. For DI_ IDs, returns content only (no project field context)
5. Uses GraphQL aliases for plurality (one HTTP request for multiple IDs)

### Verification:
- `npm test` passes with new tests
- `npm run build` compiles cleanly
- Tool is callable via MCP and returns expected shape for both ID types

## What We're NOT Doing

- **Not changing `list_project_items`** — keeping it concise for bulk listing. Use `get_draft_issue` when you need the body.
- **Not adding a higher-order skill** — `form-idea` already covers interactive draft management.
- **Not fixing `bulk_archive` draft handling** — tracked separately, out of scope.

## Implementation Approach

Single phase. The tool goes in `project-management-tools.ts` alongside the other draft tools. It uses the `node()` query pattern already used by `create_draft_issue` for DI_ resolution. For plurality, GraphQL aliases batch multiple `node()` calls into one request.

## Phase 1: Add `get_draft_issue` Tool

### Overview
Add the tool with auto-detecting ID prefix support and optional plurality via GraphQL aliases.

### Changes Required:

#### 1. New tool in `project-management-tools.ts`

**File**: `plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts`
**Location**: After `convert_draft_issue` (after line ~664)

**Schema**:
```typescript
server.tool(
  "ralph_hero__get_draft_issue",
  "Get the full content of one or more draft issues. Accepts DI_ (content node) or PVTI_ (project item) IDs — auto-detected by prefix. PVTI_ IDs also return project field values. Returns: array of { draftIssueId, projectItemId, title, body, creator, createdAt, updatedAt, workflowState?, estimate?, priority? }.",
  {
    owner: z.string().optional().describe("GitHub owner. Defaults to env var"),
    repo: z.string().optional().describe("Repository name. Defaults to env var"),
    projectNumber: z.coerce.number().optional()
      .describe("Project number override (defaults to configured project)"),
    ids: z.union([
      z.string().describe("Single draft issue ID (DI_... or PVTI_...)"),
      z.array(z.string()).describe("Array of draft issue IDs"),
    ]).describe("One or more draft issue IDs. DI_ prefix fetches content only. PVTI_ prefix also fetches project field values."),
  },
  async (args) => { /* ... */ },
);
```

**Handler logic**:

1. Normalize `ids` to an array: `const idList = Array.isArray(args.ids) ? args.ids : [args.ids];`
2. Validate all IDs start with `DI_` or `PVTI_`. Return error for invalid prefixes.
3. Partition IDs into two groups: `diIds` and `pvtiIds`.
4. Build a single GraphQL query with aliases:

For DI_ IDs:
```graphql
draft0: node(id: $id0) {
  ... on DraftIssue {
    id
    title
    body
    creator { login }
    createdAt
    updatedAt
  }
}
```

For PVTI_ IDs:
```graphql
item0: node(id: $id0) {
  ... on ProjectV2Item {
    id
    content {
      ... on DraftIssue {
        id
        title
        body
        creator { login }
        createdAt
        updatedAt
      }
    }
    fieldValues(first: 20) {
      nodes {
        ... on ProjectV2ItemFieldSingleSelectValue {
          name
          field { ... on ProjectV2FieldCommon { name } }
        }
      }
    }
  }
}
```

5. Execute a single `client.projectQuery()` call with the combined query.
6. Map results into a uniform response array:

```typescript
{
  draftIssueId: string;       // DI_ ID
  projectItemId: string | null; // PVTI_ ID (null if fetched via DI_)
  title: string;
  body: string | null;
  creator: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  // Only present for PVTI_ fetches:
  workflowState?: string;
  estimate?: string;
  priority?: string;
}
```

7. Return `toolSuccess({ drafts: [...] })`.

**Edge cases**:
- If a PVTI_ ID points to a non-draft item (Issue or PR), return an error entry for that ID: `{ id, error: "Not a draft issue" }`.
- If an ID doesn't resolve (deleted/invalid), return `{ id, error: "Not found" }`.
- Empty `ids` array → return error "At least one ID must be provided".

#### 2. Tests

**File**: `plugin/ralph-hero/mcp-server/src/__tests__/project-management-tools.test.ts`

Add tests in the existing `describe("GraphQL mutations and queries")` block:

```typescript
it("get_draft_issue DI_ query has required fields", () => {
  // Verify the DraftIssue fragment includes id, title, body, creator, createdAt, updatedAt
});

it("get_draft_issue PVTI_ query includes ProjectV2Item fields", () => {
  // Verify the PVTI_ path includes content + fieldValues
});

it("get_draft_issue source validates ID prefixes", () => {
  // Verify the implementation checks for DI_ and PVTI_ prefixes
});
```

### Success Criteria:

#### Automated Verification:
- [x] `npm test` passes with new tests
- [x] `npm run build` compiles cleanly
- [x] Tool is registered in the MCP server (grep for `ralph_hero__get_draft_issue` in source)

#### Manual Verification:
- [ ] Fetch a single draft by DI_ ID — returns title + body
- [ ] Fetch a single draft by PVTI_ ID — returns title + body + workflow state/estimate/priority
- [ ] Fetch multiple drafts in one call — returns array with all results
- [ ] Fetch with invalid ID prefix — returns clear error
- [ ] Fetch PVTI_ of a real issue (not draft) — returns "Not a draft issue" error

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation.

## Testing Strategy

### Unit Tests:
- GraphQL query structure validation (matching existing test pattern)
- ID prefix validation logic
- Response mapping for DI_ vs PVTI_ paths

### Manual Testing Steps:
1. Use `list_project_items(itemType="DRAFT_ISSUE")` to get a draft's `draftIssueId` and `itemId`
2. Call `get_draft_issue(ids="DI_...")` — verify body is returned
3. Call `get_draft_issue(ids="PVTI_...")` — verify body + fields are returned
4. Call `get_draft_issue(ids=["DI_...", "PVTI_..."])` — verify both returned in one call

## Performance Considerations

- GraphQL aliases batch all IDs into a single HTTP request, so fetching 5 drafts costs 1 API call.
- GraphQL mutations within aliases execute sequentially, but these are queries (read-only), so they execute efficiently.
- For very large batches (20+ IDs), consider splitting into chunks to avoid gateway timeouts, but this is unlikely in practice since projects rarely have that many drafts.

## References

- Prior research: `thoughts/shared/research/2026-02-23-GH-0363-draft-issue-lifecycle-api.md`
- Prior research: `thoughts/shared/research/2026-02-23-GH-0311-draft-issue-lifecycle-management.md`
- Existing draft tools: `project-management-tools.ts:445-664`
- GraphQL `node()` query pattern: `project-management-tools.ts:511-527` (used by `create_draft_issue`)
- Test patterns: `project-management-tools.test.ts:157-224`
