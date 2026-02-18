---
date: 2026-02-18
status: complete
github_issues: [62, 64, 63, 66, 65]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/62
  - https://github.com/cdubiel08/ralph-hero/issues/64
  - https://github.com/cdubiel08/ralph-hero/issues/63
  - https://github.com/cdubiel08/ralph-hero/issues/66
  - https://github.com/cdubiel08/ralph-hero/issues/65
primary_issue: 62
parent_issue: 58
---

# GitHub Projects V2 Workflow Automations - Atomic Implementation Plan

## Overview

This plan covers 5 related issues for atomic implementation in a single PR, all sub-issues of epic [#58](https://github.com/cdubiel08/ralph-hero/issues/58). The work adds Status-to-Workflow-State sync, new project management MCP tools, and a guidance document.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | [#64](https://github.com/cdubiel08/ralph-hero/issues/64) | Research GitHub Projects V2 API for automation opportunities | S |
| 2 | [#65](https://github.com/cdubiel08/ralph-hero/issues/65) | Research existing MCP servers for GitHub Projects V2 | S |
| 3 | [#62](https://github.com/cdubiel08/ralph-hero/issues/62) | Map GH Projects default Todo/In Progress/Done states to Ralph Workflow States | M |
| 4 | [#63](https://github.com/cdubiel08/ralph-hero/issues/63) | Natural language interaction for adding repositories and managing GH Projects | M |
| 5 | [#66](https://github.com/cdubiel08/ralph-hero/issues/66) | Review GH Projects V2 docs and create guidance document | M |

**Why grouped**: All 5 issues are sub-issues of epic #58 and share the same domain (GitHub Projects V2 API). Phases 1-2 are research-to-action closures (research already done, deliverable is closing the issue with findings documented). Phase 3 adds the Status sync to `update_workflow_state`. Phase 4 adds new MCP tools that use the same helpers and patterns. Phase 5 produces a guidance document and setup improvements that reference all prior phases.

## Current State Analysis

### Codebase Architecture

The MCP server at [`plugin/ralph-hero/mcp-server/src/`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/) has:

- **24 tools** across 6 modules: issue-tools, project-tools, relationship-tools, view-tools, dashboard-tools, batch-tools
- **Shared helpers** in [`lib/helpers.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/helpers.ts): `ensureFieldCache`, `resolveProjectItemId`, `updateProjectItemField`, `getCurrentFieldValue`, `resolveConfig`, `resolveFullConfig`
- **Field option cache** in [`lib/cache.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/cache.ts): `FieldOptionCache` maps field names -> option names -> option IDs; `SessionCache` for API response caching
- **Workflow states** in [`lib/workflow-states.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts): 11 states (Backlog through Done/Canceled/Human Needed)
- **State resolution** in [`lib/state-resolution.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/state-resolution.ts): semantic intents (__LOCK__, __COMPLETE__, etc.) and per-command allowed states
- **Tool registration** in [`index.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/index.ts): each module exports a `register*Tools` function

### Key Patterns

1. **Tool registration**: Each tool module exports `registerXTools(server, client, fieldCache)` called from `index.ts`
2. **Field updates**: All single-select field updates go through `updateProjectItemField()` in helpers.ts
3. **ID resolution**: `resolveIssueNodeId()` and `resolveProjectItemId()` with `SessionCache` caching
4. **Error handling**: Try/catch wrapping each tool, returning `toolError()` or `toolSuccess()`
5. **Config resolution**: `resolveConfig()` for owner/repo, `resolveFullConfig()` for owner/repo/project

### GraphQL API Coverage

Ralph currently uses 10 of 25 available ProjectV2 mutations. The default "Status" field (Todo/In Progress/Done) is a built-in single-select field that `ensureFieldCache` already caches alongside custom fields like "Workflow State". The `updateProjectV2ItemFieldValue` mutation works identically for both built-in and custom single-select fields.

### Research Findings Summary

All 5 issues have completed research with detailed findings in issue comments:

- **#64**: Identified 8 high-value API gaps (archive, remove, clear field, link repo, etc.)
- **#65**: Evaluated 5 existing MCP servers; none provide workflow intelligence. Recommendation: continue custom, borrow archive/unarchive patterns.
- **#62**: Recommended Approach A (one-way MCP tool-level sync from Workflow State -> Status). ~20 lines in `update_workflow_state`.
- **#63**: Identified 5 Tier 1 tools (link_repository, add_to_project, archive_item, remove_from_project, clear_field) + 3 Tier 2 tools
- **#66**: Board view can use Workflow State as columns. Auto-add/auto-archive are UI-only. Views cannot be created via API.

## Desired End State

1. Every `update_workflow_state` call automatically syncs the default Status field (one-way: Workflow State -> Status)
2. Five new MCP tools for project management: `archive_item`, `remove_from_project`, `add_to_project`, `link_repository`, `clear_field`
3. Research issues (#64, #65) closed with findings documented
4. Guidance document for GitHub Projects V2 setup and usage with Ralph
5. All new code has unit tests, existing tests pass

### Verification
- [x] `npm run build` compiles with no type errors
- [x] `npm test` passes with all new and existing tests
- [x] `update_workflow_state` sets Status field alongside Workflow State
- [x] `batch_update` with workflow_state operations also syncs Status
- [x] `advance_children` syncs Status when advancing children
- [x] 5 new tools (`archive_item`, `remove_from_project`, `add_to_project`, `link_repository`, `clear_field`) are registered and functional
- [x] Guidance document exists at `thoughts/shared/research/2026-02-18-GH-0066-github-projects-v2-docs-guidance.md`
- [x] Issues #64 and #65 have research summary comments

## What We're NOT Doing

- **No two-way sync** (Status -> Workflow State): The reverse mapping is ambiguous (Todo maps to 4 possible states). One-way sync is sufficient.
- **No GitHub Actions/webhooks**: All sync happens within MCP tool calls. External automation deferred.
- **No view creation**: GitHub API does not support creating/updating views programmatically.
- **No Tier 2/3 tools** (update_project, add_draft_issue, copy_project, status_update): Deferred to future issues.
- **No skill layer** (`/ralph-project`): Only MCP tools in this PR. Composite skill deferred.
- **No iteration field support**: Sprint/iteration fields are a separate concern.
- **No deletion of built-in workflows**: `deleteProjectV2Workflow` is risky and not needed for sync.

## Implementation Approach

**Phase ordering rationale**: Phases 1-2 close research issues (no code changes). Phase 3 adds the Status sync foundation that Phase 4's tools will inherit automatically. Phase 5 documents everything.

The Status sync in Phase 3 is the linchpin: by modifying `updateProjectItemField` or adding a post-update hook in `update_workflow_state`, all subsequent field updates (including Phase 4's new tools that transition workflow state) will automatically keep Status in sync.

---

## Phase 1: Close Research Issue #64 (API Gap Analysis)

> **Issue**: [#64](https://github.com/cdubiel08/ralph-hero/issues/64)
> **Research**: [GH-0064 research doc](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-18-GH-0064-github-projects-v2-api-automation.md)

### Overview

Research is complete. This phase closes #64 by verifying the research document is on `main` and adding a closure comment summarizing actionable outcomes.

### Changes Required

#### 1. Verify research document on main
**File**: `thoughts/shared/research/2026-02-18-GH-0064-github-projects-v2-api-automation.md`
**Changes**: Already exists and is committed. Verify it is on `main` branch.

#### 2. Add closure comment to issue
Add a comment to #64 summarizing which recommendations will be implemented:
- Status sync (#62) - this PR
- 5 new tools (#63) - this PR
- Remaining gaps tracked for future work

### Success Criteria

#### Automated Verification
- [x] Research document exists at `thoughts/shared/research/2026-02-18-GH-0064-github-projects-v2-api-automation.md`

#### Manual Verification
- [x] Issue #64 has closure comment with actionable outcomes

**Dependencies created for next phase**: None (independent closure)

---

## Phase 2: Close Research Issue #65 (MCP Server Comparison)

> **Issue**: [#65](https://github.com/cdubiel08/ralph-hero/issues/65)
> **Research**: Findings in issue comments (no separate research doc)

### Overview

Research is complete. This phase closes #65 by adding a closure comment summarizing the recommendation to continue with custom ralph-hero implementation.

### Changes Required

#### 1. Add closure comment to issue
Add a comment to #65 summarizing the recommendation:
- Continue custom ralph-hero MCP server
- No existing server provides workflow intelligence (custom states, group detection, pipeline position, convergence)
- Borrow archive/unarchive and draft issue patterns from `mcp-github-projects`
- Monitor GitHub official MCP server for future parity

### Success Criteria

#### Manual Verification
- [x] Issue #65 has closure comment with decision and rationale

**Dependencies created for next phase**: None (independent closure)

---

## Phase 3: Status Sync in update_workflow_state (#62)

> **Issue**: [#62](https://github.com/cdubiel08/ralph-hero/issues/62)
> **Research**: Detailed research in [#62 comment](https://github.com/cdubiel08/ralph-hero/issues/62)
> **Depends on**: None (foundational phase)

### Overview

Add one-way sync from Workflow State to the default Status field. When `update_workflow_state` changes the Workflow State, it also updates the built-in Status field based on a mapping. The same sync applies to `batch_update` and `advance_children` when they modify workflow state.

### Changes Required

#### 1. Add Status mapping constant
**File**: [`plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts)
**Changes**: Add a new exported constant mapping each Workflow State to its corresponding default Status value.

```typescript
/**
 * Maps Ralph Workflow States to GitHub's default Status field values.
 * Used for one-way sync: Workflow State changes -> Status field updates.
 *
 * Rationale:
 * - Todo = work not yet actively started (queued states)
 * - In Progress = work actively being processed (lock states + review)
 * - Done = terminal/escalated states (no automated progression)
 */
export const WORKFLOW_STATE_TO_STATUS: Record<string, string> = {
  "Backlog": "Todo",
  "Research Needed": "Todo",
  "Ready for Plan": "Todo",
  "Plan in Review": "Todo",
  "Research in Progress": "In Progress",
  "Plan in Progress": "In Progress",
  "In Progress": "In Progress",
  "In Review": "In Progress",
  "Done": "Done",
  "Canceled": "Done",
  "Human Needed": "Done",
};
```

#### 2. Add syncStatusField helper function
**File**: [`plugin/ralph-hero/mcp-server/src/lib/helpers.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/helpers.ts)
**Changes**: Add a new exported helper that syncs the Status field after a Workflow State change. This is a best-effort operation: if the Status field doesn't exist in the project or the sync fails, it logs a warning but doesn't throw.

```typescript
import { WORKFLOW_STATE_TO_STATUS } from "./workflow-states.js";

/**
 * Sync the default Status field to match a Workflow State change.
 * Best-effort: logs warning on failure but does not throw.
 */
export async function syncStatusField(
  client: GitHubClient,
  fieldCache: FieldOptionCache,
  projectItemId: string,
  workflowState: string,
): Promise<void> {
  const targetStatus = WORKFLOW_STATE_TO_STATUS[workflowState];
  if (!targetStatus) return;

  const statusFieldId = fieldCache.getFieldId("Status");
  if (!statusFieldId) return; // Status field not in project (shouldn't happen, but safe)

  const statusOptionId = fieldCache.resolveOptionId("Status", targetStatus);
  if (!statusOptionId) return; // Option not found (custom Status options)

  try {
    await updateProjectItemField(
      client,
      fieldCache,
      projectItemId,
      "Status",
      targetStatus,
    );
  } catch {
    // Best-effort sync - don't fail the primary operation
  }
}
```

#### 3. Call syncStatusField in update_workflow_state tool
**File**: [`plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts)
**Changes**: After the existing `updateProjectItemField` call for Workflow State (around line 940-945), add a call to `syncStatusField`:

```typescript
// After updating Workflow State:
await updateProjectItemField(
  client, fieldCache, projectItemId, "Workflow State", resolvedState,
);

// Sync default Status field (best-effort, one-way)
await syncStatusField(client, fieldCache, projectItemId, resolvedState);
```

Import `syncStatusField` from `../lib/helpers.js` at the top of the file.

#### 4. Sync Status in batch_update tool
**File**: [`plugin/ralph-hero/mcp-server/src/tools/batch-tools.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/batch-tools.ts)
**Changes**: When building the aliased mutation for workflow_state operations, also include Status field updates in the same mutation batch. For each issue being updated with a workflow_state operation, add an additional alias that updates the Status field.

In the "Step 3: Build and execute aliased mutations" section (around line 394-461), after building the `updates` array for workflow_state operations, also push Status field update aliases:

```typescript
// For each workflow_state operation, also sync Status
if (op.field === "workflow_state") {
  const targetStatus = WORKFLOW_STATE_TO_STATUS[op.value];
  if (targetStatus) {
    const statusFieldId = fieldCache.getFieldId("Status");
    const statusOptionId = statusFieldId
      ? fieldCache.resolveOptionId("Status", targetStatus)
      : undefined;
    if (statusFieldId && statusOptionId) {
      updates.push({
        alias: `s${num}_${opIdx}`,
        itemId: issue.projectItemId,
        fieldId: statusFieldId,
        optionId: statusOptionId,
        issueNumber: num,
        field: "status_sync",
        value: targetStatus,
      });
    }
  }
}
```

Import `WORKFLOW_STATE_TO_STATUS` from `../lib/workflow-states.js`.

#### 5. Sync Status in advance_children tool
**File**: [`plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts)
**Changes**: In the `advance_children` tool, after each child's Workflow State is updated via `updateProjectItemField`, call `syncStatusField`. Import `syncStatusField` from helpers.

#### 6. Unit tests for Status mapping
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/workflow-states.test.ts` (existing)
**Changes**: Add test cases for `WORKFLOW_STATE_TO_STATUS`:

```typescript
describe("WORKFLOW_STATE_TO_STATUS", () => {
  it("maps all VALID_STATES to a Status value", () => {
    for (const state of VALID_STATES) {
      expect(WORKFLOW_STATE_TO_STATUS[state]).toBeDefined();
      expect(["Todo", "In Progress", "Done"]).toContain(
        WORKFLOW_STATE_TO_STATUS[state],
      );
    }
  });

  it("maps queue states to Todo", () => {
    expect(WORKFLOW_STATE_TO_STATUS["Backlog"]).toBe("Todo");
    expect(WORKFLOW_STATE_TO_STATUS["Research Needed"]).toBe("Todo");
    expect(WORKFLOW_STATE_TO_STATUS["Ready for Plan"]).toBe("Todo");
    expect(WORKFLOW_STATE_TO_STATUS["Plan in Review"]).toBe("Todo");
  });

  it("maps active states to In Progress", () => {
    expect(WORKFLOW_STATE_TO_STATUS["Research in Progress"]).toBe("In Progress");
    expect(WORKFLOW_STATE_TO_STATUS["Plan in Progress"]).toBe("In Progress");
    expect(WORKFLOW_STATE_TO_STATUS["In Progress"]).toBe("In Progress");
    expect(WORKFLOW_STATE_TO_STATUS["In Review"]).toBe("In Progress");
  });

  it("maps terminal states to Done", () => {
    expect(WORKFLOW_STATE_TO_STATUS["Done"]).toBe("Done");
    expect(WORKFLOW_STATE_TO_STATUS["Canceled"]).toBe("Done");
    expect(WORKFLOW_STATE_TO_STATUS["Human Needed"]).toBe("Done");
  });
});
```

#### 7. Document the mapping in CLAUDE.md
**File**: [`CLAUDE.md`](https://github.com/cdubiel08/ralph-hero/blob/main/CLAUDE.md)
**Changes**: Add a new section under "Key Implementation Details" documenting the Status sync:

```markdown
- **Status sync (one-way)**: `update_workflow_state` automatically syncs the default Status field (Todo/In Progress/Done) based on `WORKFLOW_STATE_TO_STATUS` mapping in `workflow-states.ts`. The sync is best-effort: if the Status field is missing or has custom options, the sync silently skips. Mapping: queue states -> Todo, lock/active states -> In Progress, terminal states -> Done.
```

### Success Criteria

#### Automated Verification
- [x] `npm run build` compiles successfully
- [x] `npm test` passes including new WORKFLOW_STATE_TO_STATUS tests
- [x] All 11 Workflow States have a Status mapping

#### Manual Verification
- [x] Calling `update_workflow_state` with state "In Progress" also sets Status to "In Progress"
- [x] Calling `update_workflow_state` with state "Done" also sets Status to "Done"
- [x] `batch_update` with workflow_state operation syncs Status for each issue
- [x] If Status field is missing from project, sync silently skips (no error)

**Dependencies created for next phase**: Phase 4's new tools use `update_workflow_state` for state transitions, which now includes Status sync automatically.

---

## Phase 4: New Project Management MCP Tools (#63)

> **Issue**: [#63](https://github.com/cdubiel08/ralph-hero/issues/63)
> **Research**: Detailed research in [#63 comments](https://github.com/cdubiel08/ralph-hero/issues/63)
> **Depends on**: Phase 3 (Status sync is active for any workflow state changes)

### Overview

Add 5 new MCP tools for project management operations that are currently missing from ralph-hero. These are the Tier 1 tools identified in research: `archive_item`, `remove_from_project`, `add_to_project`, `link_repository`, and `clear_field`. All tools follow existing patterns in the codebase.

### Changes Required

#### 1. Create new tool module: project-management-tools.ts
**File**: `plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts` (new file)
**Changes**: Create a new tool module following the existing pattern (see project-tools.ts, batch-tools.ts). Export `registerProjectManagementTools(server, client, fieldCache)`.

**Tool: `ralph_hero__archive_item`**
- **Mutation**: `archiveProjectV2Item` / `unarchiveProjectV2Item`
- **Input**: `owner?`, `repo?`, `number` (issue number), `unarchive?` (boolean, default false)
- **Logic**:
  1. `resolveFullConfig()` for owner/repo/project
  2. `ensureFieldCache()` to get project ID
  3. `resolveProjectItemId()` to get the project item ID
  4. Call `archiveProjectV2Item` or `unarchiveProjectV2Item` mutation
- **Return**: `{ number, archived: true/false, projectItemId }`

```typescript
server.tool(
  "ralph_hero__archive_item",
  "Archive or unarchive a project item. Archived items are hidden from default views but not deleted. Returns: number, archived, projectItemId.",
  {
    owner: z.string().optional().describe("GitHub owner. Defaults to env var"),
    repo: z.string().optional().describe("Repository name. Defaults to env var"),
    number: z.number().describe("Issue number"),
    unarchive: z.boolean().optional().default(false)
      .describe("If true, unarchive instead of archive (default: false)"),
  },
  async (args) => {
    // resolveFullConfig, ensureFieldCache, resolveProjectItemId
    // then archiveProjectV2Item or unarchiveProjectV2Item mutation
  },
);
```

**Tool: `ralph_hero__remove_from_project`**
- **Mutation**: `deleteProjectV2Item`
- **Input**: `owner?`, `repo?`, `number` (issue number)
- **Logic**:
  1. `resolveFullConfig()`, `ensureFieldCache()`
  2. `resolveProjectItemId()` to get the project item ID
  3. Call `deleteProjectV2Item` mutation
  4. Invalidate cached project item ID
- **Return**: `{ number, removed: true }`

**Tool: `ralph_hero__add_to_project`**
- **Mutation**: `addProjectV2ItemById`
- **Input**: `owner?`, `repo?`, `number` (existing issue number)
- **Logic**:
  1. `resolveFullConfig()`, `ensureFieldCache()`
  2. `resolveIssueNodeId()` to get the issue node ID
  3. Get project ID from fieldCache
  4. Call `addProjectV2ItemById` mutation
  5. Cache the new project item ID
- **Return**: `{ number, projectItemId, added: true }`

**Tool: `ralph_hero__link_repository`**
- **Mutation**: `linkProjectV2ToRepository` / `unlinkProjectV2FromRepository`
- **Input**: `owner?`, `repoToLink` (required - "owner/name" or just "name"), `unlink?` (boolean, default false)
- **Logic**:
  1. `resolveFullConfig()`, `ensureFieldCache()`
  2. Resolve repository node ID for the target repo via GraphQL query
  3. Get project ID from fieldCache
  4. Call `linkProjectV2ToRepository` or `unlinkProjectV2FromRepository` mutation
- **Return**: `{ repository, linked: true/false }`

**Tool: `ralph_hero__clear_field`**
- **Mutation**: `clearProjectV2ItemFieldValue`
- **Input**: `owner?`, `repo?`, `number` (issue number), `field` (field name, e.g. "Estimate", "Priority", "Workflow State")
- **Logic**:
  1. `resolveFullConfig()`, `ensureFieldCache()`
  2. `resolveProjectItemId()` to get the project item ID
  3. `fieldCache.getFieldId()` to get the field ID
  4. Call `clearProjectV2ItemFieldValue` mutation
- **Return**: `{ number, field, cleared: true }`

#### 2. Register new tools in index.ts
**File**: [`plugin/ralph-hero/mcp-server/src/index.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/index.ts)
**Changes**: Import and call `registerProjectManagementTools`:

```typescript
import { registerProjectManagementTools } from "./tools/project-management-tools.js";

// In main(), after registerBatchTools:
registerProjectManagementTools(server, client, fieldCache);
```

#### 3. Unit tests for new tools
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/project-management-tools.test.ts` (new file)
**Changes**: Test the GraphQL mutations are constructed correctly for each tool. Follow the pattern in `batch-tools.test.ts` for mocking the GitHubClient.

Key test cases:
- `archive_item`: verify correct mutation name and variables
- `archive_item` with `unarchive: true`: verify `unarchiveProjectV2Item` mutation
- `remove_from_project`: verify `deleteProjectV2Item` mutation and cache invalidation
- `add_to_project`: verify `addProjectV2ItemById` mutation
- `link_repository`: verify repo name resolution and `linkProjectV2ToRepository` mutation
- `link_repository` with `unlink: true`: verify `unlinkProjectV2FromRepository` mutation
- `clear_field`: verify `clearProjectV2ItemFieldValue` mutation with correct field ID

### Success Criteria

#### Automated Verification
- [x] `npm run build` compiles successfully
- [x] `npm test` passes including new project-management-tools tests
- [x] 5 new tools registered (visible in MCP server tool list)

#### Manual Verification
- [x] `archive_item` with a Done issue hides it from default board view
- [x] `remove_from_project` removes an issue from the project board
- [x] `add_to_project` adds an existing issue to the project
- [x] `link_repository` links a repository to the project
- [x] `clear_field` clears an Estimate value on an issue

**Dependencies created for next phase**: Phase 5 documents all new tools in the guidance document.

---

## Phase 5: Guidance Document and Setup Improvements (#66)

> **Issue**: [#66](https://github.com/cdubiel08/ralph-hero/issues/66)
> **Research**: [GH-0066 research findings in issue comments](https://github.com/cdubiel08/ralph-hero/issues/66)
> **Depends on**: Phase 3 (Status sync), Phase 4 (new tools)

### Overview

Create a comprehensive guidance document for using GitHub Projects V2 with Ralph. Document the Status-to-Workflow-State mapping, recommended board setup (Workflow State columns), new tools, and manual setup steps that can't be automated via API. Also update setup-related documentation.

### Changes Required

#### 1. Create guidance document
**File**: `thoughts/shared/research/2026-02-18-GH-0066-github-projects-v2-docs-guidance.md` (new or update if exists from research branch)
**Changes**: Comprehensive document covering:

- **Board Setup**: How to create a Board view using Workflow State as columns (11 columns). How the default Status field stays in sync automatically.
- **Built-in Automations**: Which automations to enable/disable. The "auto-close on Done" and "auto-Done on merge" automations operate on the Status field only. Since Ralph now syncs Workflow State -> Status, the "auto-close on Done" will trigger when Ralph marks an issue Done.
- **Auto-Add Configuration**: How to configure auto-add workflows to automatically add issues from linked repositories. This is UI-only (cannot be configured via API).
- **Field Configuration**: Ralph requires 3 custom fields (Workflow State, Priority, Estimate). Document the setup via `setup_project` tool and manual additions.
- **Tool Reference**: Quick reference for all project management tools, including the 5 new ones from Phase 4.
- **Status Mapping**: Document the `WORKFLOW_STATE_TO_STATUS` mapping table and rationale.
- **What Requires UI**: Comprehensive list of operations that cannot be done via API (view creation, automation configuration, Status field option customization, iteration schedule).
- **Recommended Views**: Suggested board and table views with filter configurations.

#### 2. Update CLAUDE.md with new tools
**File**: [`CLAUDE.md`](https://github.com/cdubiel08/ralph-hero/blob/main/CLAUDE.md)
**Changes**: Add the 5 new tools to the "MCP Server Distribution" or tool inventory section if one exists. Add reference to the guidance document.

### Success Criteria

#### Automated Verification
- [x] Guidance document exists and is committed

#### Manual Verification
- [x] Document covers board setup, built-in automations, auto-add, field configuration
- [x] Document references the Status-to-Workflow-State mapping
- [x] Document lists all new MCP tools from Phase 4
- [x] Document clearly separates API-possible vs UI-only operations

---

## Integration Testing

After all phases complete:
- [x] `npm run build` compiles with zero errors
- [x] `npm test` passes all tests (existing + new)
- [x] `update_workflow_state` syncs Status field for all 11 Workflow States
- [x] `batch_update` with workflow_state operations syncs Status for each issue in batch
- [x] `advance_children` syncs Status when advancing children
- [x] All 5 new tools (`archive_item`, `remove_from_project`, `add_to_project`, `link_repository`, `clear_field`) work end-to-end
- [x] Guidance document is comprehensive and references all changes
- [x] Issues #64 and #65 have closure comments
- [x] All 5 issues can be moved to Done

## File Change Summary

| File | Change Type | Phase |
|------|-------------|-------|
| `plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts` | Modified (add WORKFLOW_STATE_TO_STATUS) | 3 |
| `plugin/ralph-hero/mcp-server/src/lib/helpers.ts` | Modified (add syncStatusField) | 3 |
| `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts` | Modified (call syncStatusField) | 3 |
| `plugin/ralph-hero/mcp-server/src/tools/batch-tools.ts` | Modified (sync Status in batch) | 3 |
| `plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts` | Modified (sync Status in advance_children) | 3 |
| `plugin/ralph-hero/mcp-server/src/__tests__/workflow-states.test.ts` | Modified (add mapping tests) | 3 |
| `plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts` | **New file** (5 tools) | 4 |
| `plugin/ralph-hero/mcp-server/src/index.ts` | Modified (register new tools) | 4 |
| `plugin/ralph-hero/mcp-server/src/__tests__/project-management-tools.test.ts` | **New file** (tests) | 4 |
| `thoughts/shared/research/2026-02-18-GH-0066-github-projects-v2-docs-guidance.md` | **New file** (guidance doc) | 5 |
| `CLAUDE.md` | Modified (add docs reference + new tools + Status sync note) | 3, 5 |

## References

- Research documents:
  - [#64 Research: GitHub Projects V2 API](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-18-GH-0064-github-projects-v2-api-automation.md)
  - [#66 Research: Guidance Document](https://github.com/cdubiel08/ralph-hero/issues/66) (findings in issue comments)
- Related issues:
  - [#58 Epic: GitHub Projects V2 Workflow Automations](https://github.com/cdubiel08/ralph-hero/issues/58)
  - [#62 Status Sync](https://github.com/cdubiel08/ralph-hero/issues/62)
  - [#63 Natural Language Interaction](https://github.com/cdubiel08/ralph-hero/issues/63)
  - [#64 API Research](https://github.com/cdubiel08/ralph-hero/issues/64)
  - [#65 MCP Server Comparison](https://github.com/cdubiel08/ralph-hero/issues/65)
  - [#66 Docs Review](https://github.com/cdubiel08/ralph-hero/issues/66)
