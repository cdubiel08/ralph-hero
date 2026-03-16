---
date: 2026-02-27
status: draft
github_issues: [451]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/451
primary_issue: 451
---

# MCP Toolspace Consolidation Plan

## Overview

Collapse the MCP toolspace from 53 tools to ~26 by merging overlapping tools into fewer, more powerful primitives and removing setup/admin/operational tools that belong in scripts (not MCP). Modeled after Linear MCP's `updateIssue` pattern where one tool handles workflow state, field updates, and issue mutations in a single call. Also closes the close/reopen gap where closing an issue currently requires a separate `gh api` CLI call.

**Design principle**: MCP tools are for runtime workflow operations that LLMs call frequently. One-time setup, project administration, and operational tasks belong in shell scripts or `gh` CLI — not in the tool surface that agents must scan on every invocation.

## Current State Analysis

**53 tools** across 11 source files. The most common operation — updating an issue's workflow state — requires `update_workflow_state` (MCP, writes project field) but can't close the GitHub issue itself (requires separate CLI call). Five separate tools exist for what should be one `save_issue`: `update_issue`, `update_workflow_state`, `update_estimate`, `update_priority`, `clear_field`.

**Linear MCP comparison**: Even the comprehensive tacticlaunch implementation (38 tools) uses a unified `updateIssue` that handles `stateId` (workflow state), `priority`, `estimate`, `title`, `body`, `labels`, `assigneeId` in one call. Nobody in the Linear MCP ecosystem separates "update field" from "update workflow state."

### Key Discoveries:
- `update_issue` calls `updateIssue` mutation (Issue object: title, body, labels)
- `update_workflow_state` calls `updateProjectV2ItemFieldValue` (ProjectV2Item: workflow state field) + Status sync
- `update_estimate` / `update_priority` also call `updateProjectV2ItemFieldValue` on their respective fields
- These are different GitHub API surfaces (Issue vs ProjectV2Item) but callers shouldn't care
- `detect_group` is already folded into `get_issue` (via `includeGroup: true` default) — standalone tool is redundant
- `list_project_items` overlaps heavily with `list_issues`
- `detect_stream_positions` subsumes `detect_work_streams`
- `get_issue` already runs `detectGroup()` via `includeGroup: true` — `detect_pipeline_position` just adds field-value fetching + `detectPipelinePosition()` on top, making it a natural extension of `get_issue` via an `includePipeline` flag
- `batch_update` already demonstrates how to combine workflow state + status sync in one aliased mutation

## Desired End State

~35 tools (down from 53). The core mutation path collapses to:

| Before (5 tools) | After (1 tool) |
|---|---|
| `update_issue` | `save_issue` |
| `update_workflow_state` | `save_issue` |
| `update_estimate` | `save_issue` |
| `update_priority` | `save_issue` |
| `clear_field` (for issue fields) | `save_issue` (set value to `null`) |

Plus read tools removed by subsumption:

| Removed | Subsumed by |
|---|---|
| `detect_group` | `get_issue` (already has `includeGroup`) |
| `detect_pipeline_position` | `get_issue` (new `includePipeline` flag) |
| `check_convergence` | `get_issue` (pipeline data includes convergence) |
| `list_project_items` | `list_issues` |
| `detect_work_streams` | `detect_stream_positions` |
| `list_dependencies` | `get_issue` (already fetches blocking/blockedBy) |

Plus `archive_item` absorbed into `bulk_archive` (accepts single number or array).

Plus `advance_children` + `advance_parent` merged into one `advance_issue` tool.

Plus setup/admin/operational tools removed (belong in scripts/`gh` CLI, not MCP):

| Removed | Script/CLI alternative |
|---|---|
| `list_projects` | `gh project list` |
| `copy_project` | `gh project copy` |
| `update_project` | `gh project edit` |
| `list_views` | `gh project view` |
| `list_project_repos` | `gh project view --format json` |
| `remove_from_project` | `gh project item-delete` |
| `reorder_item` | GitHub UI drag-and-drop |
| `link_team` | `gh api` call in setup script |
| `delete_field` | `gh api` call in setup script |
| `update_collaborators` | `gh api` call in setup script |
| `add_to_project` | `gh project item-add` |
| `link_repository` | `gh project link` |
| `update_status_update` | Not needed (create-only in practice) |
| `delete_status_update` | Not needed (create-only in practice) |
| `sync_across_projects` | Script with `gh api` calls |
| `configure_routing` | Direct YAML file editing |

**Total removals: 28 tools. New: 2 (`save_issue`, `advance_issue`). Net: 53 → 27 tools** (51% reduction).

### Verification:
- All 20 skills updated to use `save_issue` instead of the 5 removed tools
- Both agents (`ralph-analyst`, `ralph-integrator`) updated
- All 13 justfile recipes updated
- All existing tests pass after migration
- `save_issue` can close/reopen issues AND update project fields in one call
- Semantic intents (`__LOCK__`, `__COMPLETE__`, etc.) still work via optional `command` parameter

## What We're NOT Doing

- **Not changing `create_issue`** — creation is a different operation with different semantics
- **Not changing `batch_update`** — it already works well for bulk operations; `save_issue` is for single-issue updates
- **Not changing `add_sub_issue`, `add_dependency`, `remove_dependency`, `list_sub_issues`** — structural relationship operations, actively used
- **Not removing draft issue tools** (`create_draft_issue`, `update_draft_issue`, `convert_draft_issue`, `get_draft_issue`) — these serve a distinct workflow for project-only items without repos
- **Not removing `pick_actionable_issue`** — dispatch loop primitive used by justfile `next` recipe
- **Not changing `pipeline_dashboard` / `project_hygiene`** — actively used reporting tools
- **Not removing semantic intents** — they remain as optional parameters on `save_issue`
- **Not changing `create_comment`** — different resource type
- **Not changing `setup_project` / `get_project`** — needed by `/ralph-setup` skill, low-frequency but essential for bootstrapping
- **Not removing `detect_stream_positions`** — only stream detection tool remaining after `detect_work_streams` removal

## Implementation Approach

Build `save_issue` as a new tool that orchestrates both the Issue mutation and ProjectV2Item field mutations in minimal API calls. Use the batch mutation pattern from `batch_update` to combine multiple field writes + status sync into one GraphQL call. Deprecate old tools but keep them as thin wrappers initially for backwards compatibility during skill migration, then remove them.

---

## Phase 1: Build `save_issue` Tool

### Overview
Create the unified `save_issue` tool that replaces 5 existing tools. This is the core of the consolidation.

### Changes Required:

#### 1. New tool: `save_issue`
**File**: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts`
**Changes**: Add new `save_issue` tool registration with unified parameter schema

```typescript
server.tool(
  "ralph_hero__save_issue",
  "Update a GitHub issue — fields, workflow state, estimate, priority, labels, close/reopen — all in one call. " +
    "Only include fields you want to change. Set a field to null to clear it. " +
    "Supports semantic intents for workflowState: __LOCK__, __COMPLETE__, __ESCALATE__, __CLOSE__, __CANCEL__ (requires command param). " +
    "Returns: number, title, url, changes applied.",
  {
    owner: z.string().optional().describe("GitHub owner. Defaults to env var"),
    repo: z.string().optional().describe("Repository name. Defaults to env var"),
    projectNumber: z.coerce.number().optional().describe("Project number override"),
    number: z.coerce.number().describe("Issue number"),
    // Issue object fields (GitHub Issue API)
    title: z.string().optional().describe("New issue title"),
    body: z.string().optional().describe("New issue body (Markdown)"),
    labels: z.array(z.string()).optional().describe("Label names (replaces existing labels)"),
    assignees: z.array(z.string()).optional().describe("GitHub usernames to assign (replaces existing)"),
    issueState: z.enum(["OPEN", "CLOSED", "CLOSED_NOT_PLANNED"]).optional()
      .describe("Close or reopen the issue. CLOSED_NOT_PLANNED sets stateReason to NOT_PLANNED."),
    // Project field values (ProjectV2Item API)
    workflowState: z.string().optional()
      .describe("Target workflow state: semantic intent (__LOCK__, __COMPLETE__, __ESCALATE__, __CLOSE__, __CANCEL__) or direct name"),
    estimate: z.enum(["XS", "S", "M", "L", "XL"]).nullable().optional()
      .describe("Issue estimate. Set to null to clear."),
    priority: z.enum(["P0", "P1", "P2", "P3"]).nullable().optional()
      .describe("Issue priority. Set to null to clear."),
    // Semantic intent support
    command: z.string().optional()
      .describe("Ralph command for semantic intent resolution (e.g., 'ralph_research'). Required when workflowState is a semantic intent."),
  },
  async (args) => {
    // Implementation: see detailed logic below
  }
);
```

**Implementation logic**:

```
1. Resolve config (owner, repo, projectNumber, projectOwner)
2. Separate args into two buckets:
   a. Issue-object fields: title, body, labels, assignees, issueState
   b. Project-field values: workflowState, estimate, priority

3. If any issue-object fields provided:
   a. Resolve issue node ID
   b. Build updateIssue mutation:
      - title, body, labelIds (resolve from names), assigneeIds (resolve from usernames)
      - If issueState == "CLOSED": set state: CLOSED, stateReason: COMPLETED
      - If issueState == "CLOSED_NOT_PLANNED": set state: CLOSED, stateReason: NOT_PLANNED
      - If issueState == "OPEN": set state: OPEN
   c. Execute mutation

4. If any project-field values provided:
   a. Ensure field cache
   b. Resolve project item ID
   c. If workflowState is semantic intent (__*__):
      - resolveState(args.workflowState, args.command) → concrete state name
   d. Build aliased mutation (reuse buildBatchMutationQuery pattern for 1 issue):
      - workflow_state update alias (if workflowState provided and not null)
      - status sync alias (if workflowState changed)
      - estimate update alias (if estimate provided and not null)
      - priority update alias (if priority provided and not null)
      - clear aliases for any field set to explicit null
   e. Execute single mutation

5. If workflowState is terminal (__CLOSE__, __CANCEL__, "Done", "Canceled") AND issueState not explicitly set:
   - Auto-close the GitHub issue (convenient default, avoids the 2-call problem)
   - This is the key UX improvement: `save_issue(number: 450, workflowState: "Canceled")` closes the issue AND sets the project field

6. Return unified result:
   {
     number, title, url,
     changes: { issueState?, workflowState?, estimate?, priority?, title?, labels?, ... },
     previousWorkflowState? (if workflow state changed),
   }
```

#### 2. Helper: `buildSingleIssueMutation`
**File**: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts` (or extracted to a shared helper)
**Changes**: Extract the aliased mutation building from `batch-tools.ts` into a reusable helper that works for 1 issue with N field updates + status sync in one mutation call.

#### 3. Close/Reopen support
**File**: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts`
**Changes**: Add `updateIssue` mutation with `state` and `stateReason` fields:

```graphql
mutation($issueId: ID!, $state: IssueState, $stateReason: IssueClosedStateReason) {
  updateIssue(input: {
    id: $issueId,
    state: $state,
    stateReason: $stateReason
  }) {
    issue { number title url state }
  }
}
```

The GitHub `updateIssue` mutation already supports `state: OPEN | CLOSED` and `stateReason: COMPLETED | NOT_PLANNED | REOPENED`. We just need to expose it.

### Success Criteria:

#### Automated Verification:
- [ ] `save_issue` tool registered and discoverable via MCP
- [ ] Tests pass: `npm test` in `mcp-server/`
- [ ] Build passes: `npm run build` in `mcp-server/`
- [ ] New unit tests for `save_issue` covering:
  - Issue-only updates (title, body, labels)
  - Project-field-only updates (workflowState, estimate, priority)
  - Combined updates (both in one call)
  - Close/reopen (issueState)
  - Auto-close on terminal workflow state
  - Semantic intents (__LOCK__, __COMPLETE__, etc.)
  - Field clearing (set to null)
  - Error handling (invalid state, missing issue, etc.)

#### Manual Verification:
- [ ] `save_issue(number: N, workflowState: "Canceled")` closes the issue AND updates the project field in one call
- [ ] `save_issue(number: N, title: "New title", workflowState: "In Progress", estimate: "S")` updates everything in one call
- [ ] `save_issue(number: N, estimate: null)` clears the estimate field

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation.

---

## Phase 2: Deprecate and Remove Old Tools

### Overview
Remove the 5 tools that `save_issue` replaces. Mark them as deprecated first (one release), then remove.

### Changes Required:

#### 1. Remove old tools from `issue-tools.ts`
**File**: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts`
**Changes**: Remove registrations for:
- `ralph_hero__update_issue` (lines 969-1074)
- `ralph_hero__update_workflow_state` (lines 1079-1174)
- `ralph_hero__update_estimate` (lines 1179-~1235)
- `ralph_hero__update_priority` (lines ~1238-~1295)

#### 2. Remove `clear_field` from `project-management-tools.ts`
**File**: `plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts`
**Changes**: Remove `ralph_hero__clear_field` registration (lines 374-442). `save_issue` handles clearing via `null` values.

#### 3. Update tests
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/`
**Changes**: Remove or migrate tests for deleted tools. Ensure `save_issue` tests cover all equivalent scenarios.

### Success Criteria:

#### Automated Verification:
- [ ] `npm test` passes
- [ ] `npm run build` passes
- [ ] No references to removed tool names in source code

#### Manual Verification:
- [ ] MCP tool list no longer shows the 5 removed tools

**Implementation Note**: Pause for manual verification before proceeding.

---

## Phase 3: Collapse Redundant Read Tools

### Overview
Remove 6 read tools by folding their capabilities into existing tools. The key insight: `get_issue` already runs `detectGroup()` — extending it with an `includePipeline` flag subsumes `detect_pipeline_position`, `detect_group`, AND `check_convergence` in one tool.

### Changes Required:

#### 1. Extend `get_issue` with `includePipeline` parameter
**File**: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts`
**Changes**: Add optional `includePipeline` parameter (default `false`) to `get_issue`. When `true`:
- After group detection (which `get_issue` already does via `includeGroup`), fetch workflow state + estimate for each group member using `getIssueFieldValues()`
- Fetch sub-issue counts for oversized (M/L/XL) estimates
- Run `detectPipelinePosition()` to determine next phase + convergence
- Return pipeline data alongside the existing issue data:

```typescript
includePipeline: z.boolean().optional().default(false)
  .describe("Include pipeline position detection: next phase (SPLIT/TRIAGE/RESEARCH/PLAN/REVIEW/IMPLEMENT/COMPLETE/HUMAN_GATE/TERMINAL), convergence status, group member states, remaining phases. Requires includeGroup (auto-enabled)."),
```

**Implementation logic** (appended to existing `get_issue` handler):
```
if (args.includePipeline) {
  // Force includeGroup on (pipeline needs group data)
  // Fetch field values for each group member (parallel)
  // Fetch sub-issue counts for M/L/XL estimates (parallel)
  // Run detectPipelinePosition()
  // Merge pipeline result into response under `pipeline` key
}
```

**Response shape when `includePipeline: true`**:
```json
{
  // ... existing get_issue fields ...
  "group": { /* existing group data */ },
  "pipeline": {
    "phase": "RESEARCH",
    "convergence": { "converged": true, "ready": 3, "blocking": [] },
    "memberStates": [...],
    "remainingPhases": [...]
  }
}
```

#### 2. Remove `detect_group` from `relationship-tools.ts`
**File**: `plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts`
**Changes**: Remove `ralph_hero__detect_group` registration (~line 563-595). Already subsumed by `get_issue` with `includeGroup: true` (default).

#### 3. Remove `detect_pipeline_position` from `issue-tools.ts`
**File**: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts`
**Changes**: Remove `ralph_hero__detect_pipeline_position` registration (~lines 1357-1457). Subsumed by `get_issue` with `includePipeline: true`. Move the pipeline detection logic (field value fetching, sub-issue counts, `detectPipelinePosition()` call) into the `get_issue` handler.

#### 4. Remove `check_convergence` from `issue-tools.ts`
**File**: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts`
**Changes**: Remove `ralph_hero__check_convergence` registration (~lines 1462-1598). Pipeline data from `get_issue(includePipeline: true)` includes convergence status.

#### 5. Remove `list_project_items` from `project-tools.ts`
**File**: `plugin/ralph-hero/mcp-server/src/tools/project-tools.ts`
**Changes**: Remove `ralph_hero__list_project_items` registration (~lines 770-1100). `list_issues` has richer filtering (profiles, date-math, exclusions) and returns the same data. Migrate any unique parameters (like `includeMetrics`) to `list_issues` if not already present.

#### 6. Remove `detect_work_streams` from `relationship-tools.ts`
**File**: `plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts`
**Changes**: Remove `ralph_hero__detect_work_streams` registration (~line 596-640). Subsumed by `detect_stream_positions` in `dashboard-tools.ts` which calls it internally and adds pipeline position detection.

#### 7. Merge `archive_item` into `bulk_archive`
**File**: `plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts`
**Changes**:
- Rename `bulk_archive` to `archive_items` (or keep `bulk_archive`)
- Add optional `number` parameter for single-item archive (alongside existing `workflowStates` filter)
- Remove standalone `archive_item` tool
- When `number` is provided, archive just that one item (skip the filter path)
- Keep `unarchive` support on the single-item path

### Success Criteria:

#### Automated Verification:
- [ ] `npm test` passes
- [ ] `npm run build` passes
- [ ] No references to removed tool names in source code
- [ ] `list_issues` has any parameters that were unique to `list_project_items`
- [ ] New tests for `get_issue` with `includePipeline: true`

#### Manual Verification:
- [ ] `get_issue(number: N, includePipeline: true)` returns group info AND pipeline position in one response
- [ ] Pipeline phase detection matches what `detect_pipeline_position` previously returned

**Implementation Note**: Pause for manual verification before proceeding.

---

## Phase 4: Remove Setup/Admin/Operational Tools

### Overview
Remove 16 tools that serve one-time setup, project administration, or operational concerns. These belong in shell scripts or `gh` CLI, not in the MCP tool surface that agents scan on every invocation. Also merge `advance_children` + `advance_parent` into one tool, fold `list_dependencies` into `get_issue`, and collapse the status update CRUD triplet.

### Design Principle
MCP tools should be **runtime workflow primitives** that LLMs call frequently during issue processing. If a tool is called 0-1 times across all skills and has a `gh` CLI equivalent, it's noise in the toolspace.

### Changes Required:

#### 1. Remove zero-usage setup/admin tools (12 tools)
**Files**: `project-tools.ts`, `project-management-tools.ts`, `view-tools.ts`

Remove these tool registrations:

| Tool | File | `gh` / script alternative |
|---|---|---|
| `list_projects` | `project-tools.ts` | `gh project list` |
| `copy_project` | `project-tools.ts` | `gh project copy` |
| `update_project` | `project-management-tools.ts` | `gh project edit` |
| `list_views` | `view-tools.ts` | `gh project view` |
| `list_project_repos` | `project-tools.ts` | `gh project view --format json` |
| `remove_from_project` | `project-management-tools.ts` | `gh project item-delete` |
| `reorder_item` | `project-management-tools.ts` | GitHub UI |
| `link_team` | `project-management-tools.ts` | `gh api` in setup script |
| `delete_field` | `project-management-tools.ts` | `gh api` in setup script |
| `update_collaborators` | `project-management-tools.ts` | `gh api` in setup script |
| `add_to_project` | `project-management-tools.ts` | `gh project item-add` |
| `link_repository` | `project-management-tools.ts` | `gh project link` |

**Note**: `link_repository` is referenced in `ralph-setup` skill. Update that skill to use `gh project link` CLI instead.

#### 2. Remove zero-usage operational tools (3 tools)
**Files**: `sync-tools.ts`, `routing-tools.ts`

| Tool | File | Alternative |
|---|---|---|
| `sync_across_projects` | `sync-tools.ts` | Script with `gh api` calls |
| `configure_routing` | `routing-tools.ts` | Direct YAML file editing |
| `update_field_options` | `view-tools.ts` | `gh api` in setup script |

**Note**: `configure_routing` is referenced in `ralph-setup` skill. Update to use direct file operations. `update_field_options` is referenced in `ralph-setup` only — move to `gh api` call.

#### 3. Collapse status update CRUD (3 tools → 1)
**File**: `project-management-tools.ts`
**Changes**:
- Keep `create_status_update` (used by `ralph-report` skill)
- Remove `update_status_update` (0 skill mentions)
- Remove `delete_status_update` (0 skill mentions)

#### 4. Merge `advance_children` + `advance_parent` into `advance_issue`
**File**: `plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts`
**Changes**: Create unified `advance_issue` tool with a `direction` parameter:

```typescript
server.tool(
  "ralph_hero__advance_issue",
  "Advance workflow state for related issues. direction='children': advance sub-issues to target state (skips those already at/past). direction='parent': check if all siblings reached a gate state and advance parent if so.",
  {
    owner: z.string().optional(),
    repo: z.string().optional(),
    projectNumber: z.coerce.number().optional(),
    direction: z.enum(["children", "parent"]).describe("'children' advances sub-issues to targetState; 'parent' auto-detects gate state from siblings"),
    number: z.coerce.number().describe("Parent issue number (for children) or child issue number (for parent)"),
    // children-specific params
    targetState: z.string().optional().describe("Target state to advance children to (required when direction='children')"),
    issues: z.array(z.coerce.number()).optional().describe("Explicit issue list instead of sub-issues (direction='children' only)"),
  },
);
```

Remove separate `advance_children` and `advance_parent` registrations.

#### 5. Fold `list_dependencies` into `get_issue`
**File**: `plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts`
**Changes**: Remove `ralph_hero__list_dependencies` registration (~line 458-560). `get_issue` already fetches `blocking` and `blockedBy` relationships in its default response. The standalone tool is redundant.

#### 6. Remove entire source files if empty
After removing all tools from a file, delete the file and remove its `register*` call from `index.ts`:
- `sync-tools.ts` → `registerSyncTools()` removed from `index.ts`
- `routing-tools.ts` → `registerRoutingTools()` removed from `index.ts`
- `view-tools.ts` → `registerViewTools()` removed from `index.ts` (both tools removed)

#### 7. Update `ralph-setup` skill
**File**: `plugin/ralph-hero/skills/ralph-setup/SKILL.md`
**Changes**: Replace MCP tool references with `gh` CLI equivalents:
- `link_repository` → `gh project link`
- `configure_routing` → direct file editing instructions
- `update_field_options` → `gh api` mutation

### Success Criteria:

#### Automated Verification:
- [ ] `npm test` passes
- [ ] `npm run build` passes
- [ ] No references to removed tool names in source code or skills
- [ ] `advance_issue` tool registered with both `children` and `parent` directions
- [ ] Empty source files removed, `index.ts` registration calls updated

#### Manual Verification:
- [ ] `advance_issue(direction: "children", number: N, targetState: "Ready for Plan")` works
- [ ] `advance_issue(direction: "parent", number: N)` works
- [ ] `ralph-setup` skill works using `gh` CLI instead of removed MCP tools

**Implementation Note**: Pause for manual verification before proceeding.

---

## Phase 5: Update Skills, Agents, and Justfile

### Overview
Update all consumers of removed tools to use the new consolidated tools. This is the largest phase by file count but each change is mechanical. Covers tools removed in Phases 1-4.

### Changes Required:

#### 1. Skills (20 files)
**Directory**: `plugin/ralph-hero/skills/`

**Pattern for workflow state changes** — replace:
```
ralph_hero__update_workflow_state(number=NNN, state="Research Needed", command="ralph_research")
```
with:
```
ralph_hero__save_issue(number=NNN, workflowState="Research Needed", command="ralph_research")
```

**Pattern for closing issues** — replace:
```
ralph_hero__update_workflow_state(number=NNN, state="__CANCEL__", command="ralph_triage")
# Plus separate gh api call to close issue
```
with:
```
ralph_hero__save_issue(number=NNN, workflowState="__CANCEL__", command="ralph_triage")
# Auto-closes the issue — no second call needed
```

**Pattern for advance operations** — replace:
```
ralph_hero__advance_children(number=NNN, targetState="Ready for Plan")
ralph_hero__advance_parent(number=NNN)
```
with:
```
ralph_hero__advance_issue(direction="children", number=NNN, targetState="Ready for Plan")
ralph_hero__advance_issue(direction="parent", number=NNN)
```

**Specific skill updates**:

| Skill | Changes |
|---|---|
| `ralph-triage/SKILL.md` | `update_workflow_state` → `save_issue`; remove any `gh api` close calls |
| `ralph-split/SKILL.md` | `update_workflow_state` → `save_issue` |
| `ralph-research/SKILL.md` | `update_workflow_state` → `save_issue` |
| `ralph-plan/SKILL.md` | `update_workflow_state` → `save_issue`; `detect_group` → `get_issue` |
| `ralph-impl/SKILL.md` | `update_workflow_state` → `save_issue`; `detect_pipeline_position` → `get_issue(includePipeline: true)`; `advance_children` → `advance_issue(direction: "children")` |
| `implement-plan/SKILL.md` | `update_workflow_state` → `save_issue` |
| `ralph-review/SKILL.md` | `update_workflow_state` → `save_issue` |
| `ralph-merge/SKILL.md` | `update_workflow_state` → `save_issue`; `advance_children`/`advance_parent` → `advance_issue`; can combine state + close in one call |
| `ralph-pr/SKILL.md` | `update_workflow_state` → `save_issue` |
| `ralph-hygiene/SKILL.md` | `archive_item` → `bulk_archive` (or renamed `archive_items`) |
| `ralph-setup/SKILL.md` | `link_repository` → `gh project link`; `configure_routing` → file editing; `update_field_options` → `gh api` |
| `form-idea/SKILL.md` | No change (uses `create_issue`) |
| `create-plan/SKILL.md` | `detect_group` references → `get_issue` |
| Other skills | Grep for ALL removed tool names |

#### 2. Agents (2 files)
**File**: `plugin/ralph-hero/agents/ralph-analyst.md`
**Changes**: Update tool declarations — remove `update_issue`, `update_workflow_state`, `update_estimate`, `update_priority`, `detect_group`, `add_dependency`, `remove_dependency`, `list_dependencies`. Add `save_issue`. Keep `add_dependency`, `remove_dependency` (still exist).

**File**: `plugin/ralph-hero/agents/ralph-integrator.md`
**Changes**: Update tool declarations — remove `update_issue`, `update_workflow_state`, `advance_children`, `advance_parent`. Add `save_issue`, `advance_issue`.

#### 3. Justfile
**File**: `plugin/ralph-hero/justfile`
**Changes**:

| Recipe | Current tool | New tool |
|---|---|---|
| `approve` | `update_workflow_state` | `save_issue` |
| `move` | `update_workflow_state` | `save_issue` |
| `assign` | `update_issue` | `save_issue` |
| `where` | `detect_pipeline_position` | `get_issue` with `includePipeline: true` |
| `deps` | `list_dependencies` | `get_issue` (already returns blocking/blockedBy) |

Other recipes (`status`, `hygiene`, `issue`, `info`, `comment`, `draft`, `next`, `ls`) use tools that aren't being removed — no change needed.

### Success Criteria:

#### Automated Verification:
- [ ] `grep -rE "update_workflow_state|update_issue|update_estimate|update_priority|clear_field|detect_group|check_convergence|detect_pipeline_position|list_project_items|detect_work_streams|archive_item|advance_children|advance_parent|list_dependencies|list_projects|copy_project|update_project|list_views|list_project_repos|remove_from_project|reorder_item|link_team|delete_field|update_collaborators|add_to_project|link_repository|update_status_update|delete_status_update|sync_across_projects|configure_routing|update_field_options" plugin/ralph-hero/skills/ plugin/ralph-hero/agents/ plugin/ralph-hero/justfile` returns empty
- [ ] No stale tool names in any `.md` file under `plugin/ralph-hero/`

#### Manual Verification:
- [ ] Run `/ralph-hero:ralph-status` — confirms `pipeline_dashboard` still works
- [ ] Run `just info 1` (or any existing issue) — confirms `get_issue` still works
- [ ] Run `just move 1 "Backlog"` — confirms `save_issue` works via justfile
- [ ] Run `just where 1` — confirms `get_issue(includePipeline: true)` works

**Implementation Note**: Pause for manual verification before proceeding.

---

## Phase 6: Update CLAUDE.md and Documentation

### Overview
Update project documentation to reflect the new 26-tool surface.

### Changes Required:

#### 1. Update CLAUDE.md
**File**: `/home/chad_a_dubiel/projects/ralph-hero/CLAUDE.md`
**Changes**:
- Update "Key Implementation Details" section to describe `save_issue` instead of separate tools
- Remove references to all removed tools
- Document the auto-close behavior on terminal workflow states
- Document `get_issue` flags (`includeGroup`, `includePipeline`)
- Document `advance_issue` direction parameter
- Add "Design Principle" note: MCP tools are runtime workflow primitives; setup/admin uses `gh` CLI

#### 2. Update `index.ts` registration
**File**: `plugin/ralph-hero/mcp-server/src/index.ts`
**Changes**:
- Remove `registerSyncTools()`, `registerRoutingTools()`, `registerViewTools()` calls
- Update any comments referencing removed tools
- Verify remaining `register*` calls match the 26-tool inventory

#### 3. Clean up source files
Delete empty source files:
- `plugin/ralph-hero/mcp-server/src/tools/sync-tools.ts`
- `plugin/ralph-hero/mcp-server/src/tools/routing-tools.ts`
- `plugin/ralph-hero/mcp-server/src/tools/view-tools.ts`

### Success Criteria:

#### Automated Verification:
- [ ] `npm run build` passes
- [ ] `npm test` passes
- [ ] No stale tool names in documentation or source
- [ ] No orphaned imports from deleted files

#### Manual Verification:
- [ ] CLAUDE.md accurately describes the 26-tool surface
- [ ] MCP server starts cleanly with no registration errors

---

## Testing Strategy

### Unit Tests:
- `save_issue` with issue-only fields (title, body, labels, assignees)
- `save_issue` with project-only fields (workflowState, estimate, priority)
- `save_issue` with mixed fields (both issue + project in one call)
- `save_issue` with close/reopen (issueState parameter)
- `save_issue` auto-close on terminal workflow state (Done, Canceled)
- `save_issue` with semantic intents (__LOCK__, __COMPLETE__, etc.)
- `save_issue` with field clearing (set to null)
- `save_issue` error cases (invalid state, missing issue, no fields provided)
- `save_issue` with command parameter validation

### Integration Tests:
- End-to-end: create issue → save_issue (set state + estimate) → get_issue (verify fields)
- End-to-end: save_issue with issueState=CLOSED → verify issue is closed via get_issue

### Manual Testing Steps:
1. Close an issue with one call: `save_issue(number: N, workflowState: "Canceled")`
2. Update multiple fields: `save_issue(number: N, title: "Updated", workflowState: "In Progress", estimate: "S", priority: "P1")`
3. Clear a field: `save_issue(number: N, estimate: null)`
4. Reopen an issue: `save_issue(number: N, issueState: "OPEN", workflowState: "Backlog")`

## Tool Count Summary

| Category | Before | After | Delta |
|---|---|---|---|
| Issue mutations | 5 (`update_issue`, `update_workflow_state`, `update_estimate`, `update_priority`, `clear_field`) | 1 (`save_issue`) | -4 |
| Read (group/pipeline/convergence) | 3 (`detect_group`, `detect_pipeline_position`, `check_convergence`) | 0 (folded into `get_issue`) | -3 |
| Read (list) | 2 (`list_issues`, `list_project_items`) | 1 (`list_issues`) | -1 |
| Read (streams) | 2 (`detect_work_streams`, `detect_stream_positions`) | 1 (`detect_stream_positions`) | -1 |
| Read (dependencies) | 1 (`list_dependencies`) | 0 (folded into `get_issue`) | -1 |
| Archive | 2 (`archive_item`, `bulk_archive`) | 1 (`archive_items`) | -1 |
| Advance workflow | 2 (`advance_children`, `advance_parent`) | 1 (`advance_issue`) | -1 |
| Status updates | 3 (`create/update/delete_status_update`) | 1 (`create_status_update`) | -2 |
| Setup/admin (gh overlap) | 12 tools | 0 (use `gh` CLI / scripts) | -12 |
| Operational | 3 (`sync_across_projects`, `configure_routing`, `update_field_options`) | 0 (scripts / file editing) | -3 |
| **Total removed** | | | **-29** |
| **New** | | `save_issue` + `advance_issue` | **+2** |
| **Net change** | **53** | **26** | **-27** |

### Final Tool Inventory (26 tools)

**Issue operations (7)**:
- `get_issue` (with `includeGroup` + `includePipeline` flags)
- `list_issues`
- `create_issue`
- `save_issue` (NEW — unified mutation)
- `create_comment`
- `pick_actionable_issue`
- `batch_update`

**Relationship operations (4)**:
- `add_sub_issue`
- `list_sub_issues`
- `add_dependency`
- `remove_dependency`

**Workflow automation (1)**:
- `advance_issue` (NEW — merged children + parent)

**Draft issue operations (4)**:
- `create_draft_issue`
- `update_draft_issue`
- `convert_draft_issue`
- `get_draft_issue`

**Project operations (3)**:
- `setup_project`
- `get_project`
- `archive_items` (merged single + bulk)

**Dashboard & reporting (4)**:
- `pipeline_dashboard`
- `detect_stream_positions`
- `project_hygiene`
- `create_status_update`

**Infrastructure (1)**:
- `health_check`

**Debug (2, conditional)**:
- `collate_debug` (RALPH_DEBUG=true only)
- `debug_stats` (RALPH_DEBUG=true only)

## Migration Notes

- The `command` parameter becomes optional on `save_issue` (only required when `workflowState` is a semantic intent)
- Auto-close on terminal states is a new behavior — document clearly so agents don't double-close
- `batch_update` remains unchanged — it handles the bulk case; `save_issue` handles the single-issue case
- The `save_issue` tool should use `buildBatchMutationQuery` pattern (from batch-tools.ts) for single-issue project field mutations to get workflow state + status sync in one API call
- `ralph-setup` skill needs the most rework — replacing 3 MCP tools with `gh` CLI equivalents
- `advance_issue` is a mechanical merge — same logic, just `direction` parameter instead of two tools
- Source files `sync-tools.ts`, `routing-tools.ts`, `view-tools.ts` become empty and should be deleted
- `project-management-tools.ts` shrinks dramatically (from 16 tools to 2: `archive_items` + draft CRUD lives here)
- Debug tools remain conditional on `RALPH_DEBUG=true` — they don't count toward the runtime tool surface

## References

- Linear MCP comparison: jerhadf/linear-mcp-server (5 tools, unified `update_issue`), tacticlaunch/mcp-linear (38 tools, unified `updateIssue`)
- Current tool inventory: 53 tools across 11 source files
- `batch_update` aliased mutation pattern: `plugin/ralph-hero/mcp-server/src/tools/batch-tools.ts`
- Workflow state management: `plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts`, `state-resolution.ts`
- Status sync helper: `plugin/ralph-hero/mcp-server/src/lib/helpers.ts:569-597`
