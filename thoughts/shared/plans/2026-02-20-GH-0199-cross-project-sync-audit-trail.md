---
date: 2026-02-20
status: draft
github_issues: [199]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/199
primary_issue: 199
---

# Add Audit Trail Comments for Cross-Project State Sync - Implementation Plan

## Overview

Single XS issue to add audit trail comments when `sync_across_projects` propagates Workflow State changes. Two touch points: the MCP tool (`sync-tools.ts`) and the GitHub Actions script (`sync-project-state.js`).

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-199 | Add audit trail comments for cross-project state sync | XS |

## Current State Analysis

The `sync_across_projects` MCP tool and Actions script both propagate Workflow State across projects but leave no visible record on the issue. The routing workflow (#173) already implements this pattern with `<!-- routing-audit -->` HTML markers. This ticket replicates that pattern for the sync context.

**Existing code to build on**:
- `sync-tools.ts:163-275` — sync loop that already tracks `synced[]` and `skipped[]` results
- `sync-project-state.js:75-198` — Actions script with same sync loop tracking `syncedCount`
- `issue-tools.ts:1131-1188` — `create_comment` tool wrapping `addComment` mutation (pattern reference)
- `route.js:170-207` — routing audit pattern with `hasExistingAuditComment` + `addAuditComment`

## Desired End State

### Verification
- [ ] MCP tool adds audit comment after syncing (opt-in via `auditComment` param, default true)
- [ ] Actions script adds audit comment after successful sync
- [ ] Comments contain `<!-- cross-project-sync-audit -->` marker, project numbers, and state transitions
- [ ] Idempotent: duplicate invocations do not add duplicate comments
- [ ] `auditComment: false` suppresses comment in MCP tool
- [ ] Tests cover comment body generation, idempotency detection, and opt-out

## What We're NOT Doing

- Modifying core sync logic (state propagation, field updates, loop prevention)
- Adding audit to dry-run mode (no mutations = no audit)
- Sharing code between MCP tool and Actions script (different runtimes/patterns)
- Adding comment-based audit to other tools (routing audit is separate in #173)

## Implementation Approach

Three parallel changes to the same files, ordered by dependency:

1. Add pure helper functions for comment body generation and marker detection (testable independently)
2. Wire helpers into the MCP tool's sync loop with an `auditComment` parameter
3. Wire equivalent logic into the Actions script
4. Add tests for helpers and integration logic

---

## Phase 1: GH-199 — Audit Trail Comments

> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/199 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0199-cross-project-sync-audit-trail.md

### Changes Required

#### 1. Add audit helper functions to sync-tools.ts

**File**: `plugin/ralph-hero/mcp-server/src/tools/sync-tools.ts`

Add two helper functions above `registerSyncTools()`:

**`buildSyncAuditBody(workflowState, syncedResults)`** — Pure function, no I/O.
- Takes the target `workflowState` string and the `synced: SyncResult[]` array
- Returns the formatted comment body string:
  ```
  <!-- cross-project-sync-audit -->
  **Cross-project sync** — Workflow State synced to **{state}** across {N} project(s):
  - Project #{number} ({previousState} -> {state})
  ```
- Each synced result becomes a bullet with project number and state transition
- Uses `currentState ?? "none"` for the previous state display

**`hasExistingSyncAuditComment(client, issueNodeId)`** — Async, queries GitHub.
- Uses `client.query()` to fetch last 20 comments on the issue via node ID:
  ```graphql
  query($issueId: ID!) {
    node(id: $issueId) {
      ... on Issue {
        comments(last: 20) { nodes { body } }
      }
    }
  }
  ```
- Returns `true` if any comment body starts with `<!-- cross-project-sync-audit -->`

#### 2. Wire audit into the MCP tool

**File**: `plugin/ralph-hero/mcp-server/src/tools/sync-tools.ts`

Changes to `registerSyncTools()`:

1. Add `auditComment` parameter to the tool schema:
   ```typescript
   auditComment: z.boolean().optional().default(true)
     .describe("Add audit comment to the issue after sync (default: true)")
   ```

2. After the sync loop (after line 260, before the `return toolSuccess`), add audit logic:
   ```typescript
   let auditCommentAdded = false;
   if (args.auditComment && !args.dryRun && synced.length > 0) {
     const alreadyAudited = await hasExistingSyncAuditComment(client, issueNodeId);
     if (!alreadyAudited) {
       const body = buildSyncAuditBody(args.workflowState, synced);
       await client.mutate(ADD_SYNC_AUDIT_COMMENT, {
         subjectId: issueNodeId,
         body,
       });
       auditCommentAdded = true;
     }
   }
   ```

3. Add `auditCommentAdded` to the `toolSuccess` return object.

4. Add the `ADD_SYNC_AUDIT_COMMENT` mutation constant (same pattern as `issue-tools.ts:1168-1177`):
   ```typescript
   const ADD_SYNC_AUDIT_COMMENT = `mutation($subjectId: ID!, $body: String!) {
     addComment(input: { subjectId: $subjectId, body: $body }) {
       commentEdge { node { id } }
     }
   }`;
   ```

#### 3. Wire audit into the Actions script

**File**: `.github/scripts/sync/sync-project-state.js`

Add two functions after `fetchProjectFieldMeta()`:

**`buildSyncAuditBody(workflowState, syncedProjects)`** — Same pure logic as MCP version but CommonJS.
- Takes `workflowState` string and array of `{ projectNumber, previousState }` objects
- Returns formatted body with `<!-- cross-project-sync-audit -->` marker

**`hasExistingSyncAuditComment(gql, contentNodeId)`** — Queries last 20 comments via node ID.
- Uses `node(id:) { ... on Issue { comments(last: 20) { nodes { body } } } }` query
- Returns boolean

In `main()`, after the sync loop (after line 197), add:
```javascript
if (syncedCount > 0) {
  const alreadyAudited = await hasExistingSyncAuditComment(graphqlWithAuth, CONTENT_NODE_ID);
  if (!alreadyAudited) {
    const body = buildSyncAuditBody(WORKFLOW_STATE, syncedProjects);
    await graphqlWithAuth(
      `mutation($subjectId: ID!, $body: String!) {
        addComment(input: { subjectId: $subjectId, body: $body }) {
          commentEdge { node { id } }
        }
      }`,
      { subjectId: CONTENT_NODE_ID, body },
    );
    console.log('Audit comment added.');
  } else {
    console.log('Audit comment already exists. Skipping.');
  }
}
```

Also collect `syncedProjects` during the loop: push `{ projectNumber, previousState: currentStateName }` when a project is synced.

#### 4. Add tests

**File**: `plugin/ralph-hero/mcp-server/src/__tests__/sync-tools.test.ts`

Add three new test sections:

**`describe("buildSyncAuditBody")`** (4 tests):
- Builds correct body for single synced project
- Builds correct body for multiple synced projects
- Uses "none" when currentState is null
- Starts with `<!-- cross-project-sync-audit -->` marker

**`describe("hasExistingSyncAuditComment")`** (3 tests, pure logic):
- Since we can't easily mock the GraphQL client in the current test pattern, test the marker detection logic as a pure function:
  - `detectSyncAuditMarker(comments)` returns true when marker present
  - Returns false when no marker
  - Returns false for empty comments array

**`describe("auditComment parameter")`** (2 tests):
- Test that `auditComment: false` with synced results produces `auditCommentAdded: false` in decision logic
- Test that dry run with `auditComment: true` produces `auditCommentAdded: false`

To make `buildSyncAuditBody` and `detectSyncAuditMarker` testable, export them from `sync-tools.ts`. Use a named export alongside the `registerSyncTools` function:
```typescript
export { buildSyncAuditBody, detectSyncAuditMarker };
```

### Success Criteria

- [ ] Automated: `cd plugin/ralph-hero/mcp-server && npm run build` passes
- [ ] Automated: `cd plugin/ralph-hero/mcp-server && npm test` passes (all existing + new tests)
- [ ] Manual: MCP tool return value includes `auditCommentAdded: true` when synced > 0
- [ ] Manual: Comment visible on issue with correct format and marker

---

## Integration Testing

- [ ] Build passes: `npm run build` in mcp-server directory
- [ ] All tests pass: `npm test` in mcp-server directory (existing sync tests + new audit tests)
- [ ] No type errors from new exports

## References

- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0199-cross-project-sync-audit-trail.md
- Pattern reference: `scripts/routing/route.js` lines 170-207 (routing audit from #173)
- MCP addComment pattern: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts` lines 1131-1188
- Sync tool: `plugin/ralph-hero/mcp-server/src/tools/sync-tools.ts`
- Actions script: `.github/scripts/sync/sync-project-state.js`
