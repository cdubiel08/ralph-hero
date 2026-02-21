# GH-199: Add Audit Trail Comments for Cross-Project State Sync

**Issue**: https://github.com/cdubiel08/ralph-hero/issues/199
**Size**: XS | **Priority**: P2
**Status**: Research in Progress
**Group**: Cross-project sync (parent #129)

## Summary

Add issue comments that document when `sync_across_projects` propagates Workflow State changes across projects. Two touch points: the MCP tool (`sync-tools.ts`) and the GitHub Actions script (`sync-project-state.js`). Uses `<!-- cross-project-sync-audit -->` HTML marker for idempotency detection, following the same pattern as routing audit in #173.

## Findings

### 1. MCP Tool (`sync-tools.ts`) — Current State

**File**: `plugin/ralph-hero/mcp-server/src/tools/sync-tools.ts` (278 lines)

The `ralph_hero__sync_across_projects` tool:
- Takes `owner`, `repo`, `number`, `workflowState`, and `dryRun` parameters
- Resolves issue node ID via `resolveIssueNodeId()` helper
- Discovers all project memberships via `projectItems(first: 20)` GraphQL query
- For each project item, compares current Workflow State to target; skips if matching (idempotency)
- Fetches per-project field metadata to resolve the "Workflow State" SingleSelectField and target option
- Applies `updateProjectV2ItemFieldValue` mutation per project
- Returns structured `synced[]` and `skipped[]` arrays

**No audit comment is added today.** The tool returns the sync results but does not leave any visible record on the issue.

The tool already has access to `client.mutate()` (repo-level mutations including addComment), and `resolveIssueNodeId()` which returns the node ID needed as `subjectId` for the `addComment` mutation.

### 2. Actions Script (`sync-project-state.js`) — Current State

**File**: `.github/scripts/sync/sync-project-state.js` (203 lines)

Standalone CommonJS script (like the routing script in #173). Uses `@octokit/graphql` directly via `SYNC_PAT`. Environment variables: `SYNC_PAT`, `CONTENT_NODE_ID`, `WORKFLOW_STATE`, `ORIGINATING_PROJECT_NUMBER`, `SYNC_PROJECT_FILTER`.

Same sync logic as the MCP tool but operates from Actions context with `CONTENT_NODE_ID` (GraphQL node ID) instead of issue number. No audit comment today.

Already has `graphqlWithAuth` configured — the same `addComment` mutation pattern from route.js (#173) will work directly.

### 3. Routing Audit Pattern (#173)

**File**: `scripts/routing/route.js` (lines 170-207)

Two key functions:
- `hasExistingAuditComment(gql, owner, repo, number, eventName)` — queries last 20 comments, checks if any body starts with `<!-- routing-audit -->`
- `addAuditComment(gql, contentId, matchedRules)` — builds formatted body with `<!-- routing-audit -->` prefix and posts via `addComment` mutation

The MCP tool equivalent uses `create_comment` tool in `issue-tools.ts` (line 1131-1188), which wraps the same `addComment` mutation:
```graphql
mutation($subjectId: ID!, $body: String!) {
  addComment(input: { subjectId: $subjectId, body: $body }) {
    commentEdge { node { id } }
  }
}
```

### 4. Comment Format Design

Per the issue spec:
> Comment format: "Workflow State synced to [state] across [N] projects: Project #X, Project #Y"

Proposed format:
```
<!-- cross-project-sync-audit -->
**Cross-project sync** — Workflow State synced to **In Progress** across 2 projects:
- Project #3 (Backlog -> In Progress)
- Project #5 (Todo -> In Progress)
```

### 5. Idempotency Strategy

Same approach as #173:
1. Before adding a comment, query last N comments on the issue
2. Check if any comment body starts with `<!-- cross-project-sync-audit -->`
3. If found, skip adding duplicate

For the **MCP tool**: needs the issue node ID (already resolved) to query comments. Since the tool operates on repo-level issues, use `client.query()` (repo token) for the comment check and `client.mutate()` for `addComment`.

For the **Actions script**: needs issue number to query comments. Currently only receives `CONTENT_NODE_ID` (GraphQL node ID). Two options:
- (a) Add `ISSUE_NUMBER` env var to the workflow
- (b) Query the issue number from the node ID

Option (a) is simpler. The `sync-project-state.yml` workflow dispatch already has `content_node_id`. The calling workflow/event should include the issue number. However, `addComment` uses `subjectId` which is the node ID — so we can post without the number. For the idempotency check, we can query comments using the node ID directly via `node(id:) { ... on Issue { comments(last:20) { nodes { body } } } }`.

### 6. Implementation Approach

**MCP tool changes** (`sync-tools.ts`):
1. Add `auditComment` optional boolean parameter (default: `true`)
2. After sync loop completes (and at least one project was synced), build audit comment body
3. Check for existing audit comment using node ID query
4. If no existing comment and `auditComment` is true, post via `client.mutate()`
5. Return `auditCommentAdded: true/false` in result

**Actions script changes** (`sync-project-state.js`):
1. After sync completes and syncedCount > 0, build audit comment body
2. Check for existing audit comment using `CONTENT_NODE_ID` node query
3. Post via `addComment` mutation

**Test additions** (`sync-tools.test.ts`):
1. Test `buildSyncAuditBody()` helper function — correct format, handles single/multiple projects
2. Test idempotency detection logic — extracts from comment body
3. Test `auditComment: false` skips comment generation

### 7. Risk Assessment

- **Low risk**: Additive change, no modifications to core sync logic
- **Comment permissions**: The `addComment` mutation requires `write` access to issues, which is already needed by the sync mutation (updating project fields requires higher permissions)
- **Rate limiting**: One additional query (comment check) + one mutation (addComment) per sync invocation. Within normal limits.
- **No breaking changes**: `auditComment` parameter defaults to `true`, so existing callers get the new behavior automatically. Setting `false` preserves old behavior.

### 8. Files to Modify

| File | Change |
|------|--------|
| `plugin/ralph-hero/mcp-server/src/tools/sync-tools.ts` | Add auditComment param, comment check + post logic |
| `.github/scripts/sync/sync-project-state.js` | Add comment check + post after sync |
| `plugin/ralph-hero/mcp-server/src/__tests__/sync-tools.test.ts` | Tests for comment generation and idempotency |

### 9. Dependencies

- **#180** (sync MCP tool) — merged
- **#181** (Actions sync script) — merged
- **#173** (routing audit pattern) — provides the pattern but code isn't shared; this ticket reimplements the same GraphQL pattern in the sync context
