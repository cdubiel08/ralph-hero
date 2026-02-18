---
date: 2026-02-18
github_issue: 64
github_url: https://github.com/cdubiel08/ralph-hero/issues/64
status: complete
type: research
---

# Research: GitHub Projects V2 API for Automation Opportunities (GH-64)

## Problem Statement

Perform a thorough review of the GitHub Projects V2 GraphQL API to identify:
- Available mutations for project automation (webhooks, field updates, item management)
- Gaps in current ralph-hero MCP server coverage
- Opportunities for easier project management (bulk operations, templates, automations)
- Built-in workflow automation features we may be duplicating or could leverage

## Current State Analysis

### Ralph-Hero MCP Server Tool Inventory

The MCP server currently provides **24 tools** organized across 6 modules:

**Core** (1 tool):
- `health_check` - Validates auth, repo, project, and required fields

**Project Management** ([project-tools.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-tools.ts)) (3 tools):
- `setup_project` - Creates project + Workflow State/Priority/Estimate fields
- `get_project` - Fetches project with fields and options
- `list_project_items` - Lists items with field value filters

**Views** ([view-tools.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/view-tools.ts)) (2 tools):
- `list_views` - Lists project views (board, table, roadmap)
- `update_field_options` - Updates single-select field options (colors, descriptions)

**Issues** ([issue-tools.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts)) (9 tools):
- `list_issues` - Lists with filters (workflowState, estimate, priority, label)
- `get_issue` - Full context with relationships and group detection
- `create_issue` - Creates issue + adds to project + sets fields
- `update_issue` - Updates title, body, labels, assignees
- `update_workflow_state` - State transitions with semantic intents
- `update_estimate` - Updates estimate field
- `update_priority` - Updates priority field
- `create_comment` - Adds comments to issues
- `detect_pipeline_position` - Determines next workflow phase
- `check_convergence` - Checks group convergence on target state
- `pick_actionable_issue` - Finds highest-priority unblocked work

**Relationships** ([relationship-tools.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts)) (6 tools):
- `add_sub_issue` - Parent/child relationships
- `list_sub_issues` - Lists children with completion summary
- `add_dependency` - Blocking relationships
- `remove_dependency` - Removes blocking relationships
- `list_dependencies` - Lists blocking/blocked-by
- `detect_group` - Transitive group detection with topological sort
- `advance_children` - Batch-advance children to match parent state

**Dashboard** ([dashboard-tools.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts)) (1 tool):
- `pipeline_dashboard` - Aggregates by phase, health indicators, markdown/ASCII output

**Batch** ([batch-tools.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/batch-tools.ts)) (1 tool):
- `batch_update` - Bulk field updates using aliased GraphQL

### GraphQL Mutations Used by Ralph-Hero

Currently used:
- `createProjectV2` - In setup_project
- `createProjectV2Field` - In setup_project
- `addProjectV2ItemById` - In create_issue
- `updateProjectV2ItemFieldValue` - In all field update tools
- `updateProjectV2Field` - In update_field_options
- `createIssue` - In create_issue
- `updateIssue` - In update_issue
- `addComment` - In create_comment
- `addSubIssue` - In add_sub_issue
- `addBlockedBy` / `removeBlockedBy` - In dependency tools

## Full GitHub Projects V2 API Inventory

### All Available Mutations (25 total)

| Mutation | Description | Ralph-Hero Uses? |
|----------|-------------|------------------|
| `addProjectV2DraftIssue` | Create draft issue in project | No |
| `addProjectV2ItemById` | Add issue/PR to project | Yes |
| `archiveProjectV2Item` | Archive an item | No |
| `clearProjectV2ItemFieldValue` | Clear a field value | No |
| `copyProjectV2` | Duplicate project with config | No |
| `createProjectV2` | Create new project | Yes |
| `createProjectV2Field` | Create custom field | Yes |
| `createProjectV2StatusUpdate` | Add project status update | No |
| `deleteProjectV2` | Delete entire project | No |
| `deleteProjectV2Field` | Remove custom field | No |
| `deleteProjectV2Item` | Remove item from project | No |
| `deleteProjectV2StatusUpdate` | Delete status update | No |
| `deleteProjectV2Workflow` | Remove project workflow | No |
| `linkProjectV2ToRepository` | Link project to repo | No |
| `linkProjectV2ToTeam` | Link project to team | No |
| `markProjectV2AsTemplate` | Mark as template | No |
| `unarchiveProjectV2Item` | Restore archived item | No |
| `unmarkProjectV2AsTemplate` | Remove template mark | No |
| `updateProjectV2` | Update project settings | No |
| `updateProjectV2Collaborators` | Update collaborators | No |
| `updateProjectV2DraftIssue` | Update draft issue | No |
| `updateProjectV2Field` | Update field config | Yes |
| `updateProjectV2ItemFieldValue` | Update item field value | Yes |
| `updateProjectV2ItemPosition` | Reorder items | No |
| `updateProjectV2StatusUpdate` | Update status update | No |

### Built-in Automations (GitHub-native)

GitHub Projects V2 includes built-in workflows (configured via UI, not API):

1. **Auto-add items** - Automatically add issues/PRs matching a filter from linked repos
2. **Item closed -> Status=Done** - When issues/PRs are closed, set Status to Done (default: enabled)
3. **PR merged -> Status=Done** - When PRs are merged, set Status to Done (default: enabled)
4. **Item added -> Status=Todo** - When items are added, set Status to Todo
5. **Auto-archive** - Archive items meeting criteria

**Key insight**: These automations work with the default **Status** field (Todo/In Progress/Done), NOT custom single-select fields like Ralph's **Workflow State**. This is the fundamental tension between Ralph's richer state machine and GitHub's built-in automations.

### Webhook Events

- `projects_v2_item` - Fires on item create/edit/delete/archive/restore in org projects
- Limitation: Cannot filter by specific project; receives ALL project events for the org
- Useful for: external automation servers, Slack notifications, audit logging

## Gap Analysis

### High-Value Gaps (New Tools Worth Adding)

1. **`linkProjectV2ToRepository`** - Currently, Ralph assumes a single repo, but as multi-repo support is explored (GH-23), linking repos to projects becomes essential. This would replace manual UI configuration.

2. **`archiveProjectV2Item` / `unarchiveProjectV2Item`** - Ralph has no way to archive Done/Canceled issues. This causes project boards to accumulate stale items. An `archive_done_items` tool using the batch pattern would be valuable.

3. **`deleteProjectV2Item`** - Useful for removing items accidentally added to the project. Currently no way to undo an `addProjectV2ItemById`.

4. **`clearProjectV2ItemFieldValue`** - Sometimes a field value needs to be cleared rather than changed. Currently Ralph can only set values, not clear them.

5. **`updateProjectV2ItemPosition`** - Item ordering within views. Could enable priority-based automatic sorting.

6. **`addProjectV2DraftIssue` / `updateProjectV2DraftIssue`** - Draft issues are useful for quick capture without creating full issues. Could support a "quick add" workflow.

7. **`createProjectV2StatusUpdate`** - Project-level status updates (separate from issue comments). Could power automated sprint/project reporting.

8. **`updateProjectV2`** - Update project title, description, visibility. Useful for project lifecycle management.

### Medium-Value Gaps

9. **`copyProjectV2`** - Template duplication. Could support project templates for new teams/repos.

10. **`updateProjectV2Collaborators`** - Manage who has access to the project programmatically.

11. **`linkProjectV2ToTeam`** - Link project to GitHub team for access control.

12. **`deleteProjectV2Field`** - Clean up unused custom fields.

### Low-Value / Unlikely Needs

13. **`deleteProjectV2` / `deleteProjectV2StatusUpdate` / `deleteProjectV2Workflow`** - Destructive operations rarely needed in automation.

14. **`markProjectV2AsTemplate` / `unmarkProjectV2AsTemplate`** - Niche org-level feature.

### Built-in Automation Overlap

Ralph currently **does not duplicate** any built-in automation. The built-in automations target the default Status field, while Ralph uses a custom "Workflow State" field. However, there is a potential synergy opportunity:

- If the default Status field is mapped to Ralph's Workflow State (see GH-62), the built-in "closed -> Done" automation could complement Ralph's state machine.
- Ralph could also leverage the "auto-add" workflow to ensure new issues in linked repos are automatically added to the project.

## Potential Approaches

### Approach A: Targeted Gap-Fill (Recommended)

Add the 4-5 highest-value missing tools:
1. `archive_item` / `unarchive_item` - Project hygiene
2. `remove_item` - Undo accidental additions
3. `clear_field_value` - Reset fields
4. `link_repository` - Multi-repo support
5. `reorder_item` - Position management

**Pros**: Focused, immediate value, low effort
**Cons**: Doesn't address automation/webhook story

### Approach B: Automation Layer

Build a GitHub Actions workflow or webhook listener that:
- Watches `projects_v2_item` events
- Syncs Status <-> Workflow State changes
- Auto-archives Done items after N days
- Auto-adds new issues from linked repos

**Pros**: Enables event-driven automation
**Cons**: Requires infrastructure beyond MCP server (Actions workflow or webhook server)

### Approach C: Comprehensive Coverage

Expose all 25 mutations through MCP tools for complete API coverage.

**Pros**: No gaps, full control
**Cons**: Many tools rarely used, increases maintenance burden, bloats tool namespace

## Risks and Considerations

1. **View API limitation**: GitHub's GraphQL API does NOT support creating or updating project views programmatically. Views (board, table, roadmap) must be configured through the UI. This is explicitly noted in [view-tools.ts:8](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/view-tools.ts#L8).

2. **Rate limiting**: Each new tool adds API calls. The current rate limiter and caching strategy should handle this, but bulk operations (archive all done items) need the same aliased-mutation pattern used in batch-tools.

3. **Status vs Workflow State**: The fundamental design tension is that GitHub's built-in automations target "Status" while Ralph uses "Workflow State". Any automation strategy needs to address this mapping (GH-62).

4. **Webhook org-level scope**: `projects_v2_item` events are org-level, not project-level. A webhook receiver would need to filter by project ID.

5. **`@octokit/graphql` v9 reserved words**: The existing note in CLAUDE.md about `query`, `method`, and `url` being reserved applies to all new tools.

## Recommended Next Steps

1. **Implement Approach A** (targeted gap-fill) as new MCP tools
2. **Research GH-62** (Status <-> Workflow State mapping) to determine if built-in automations can complement Ralph
3. **Defer webhook/Actions automation** until the mapping question is resolved
4. **Track new tool additions** as sub-issues of a new implementation ticket

### Prioritized New Tools

| Priority | Tool | Mutation | Rationale |
|----------|------|----------|-----------|
| P1 | `archive_item` | `archiveProjectV2Item` | Board hygiene, high user demand |
| P1 | `remove_item` | `deleteProjectV2Item` | Undo accidental additions |
| P2 | `clear_field_value` | `clearProjectV2ItemFieldValue` | Field reset capability |
| P2 | `link_repository` | `linkProjectV2ToRepository` | Multi-repo support (GH-23) |
| P3 | `reorder_item` | `updateProjectV2ItemPosition` | View organization |
| P3 | `create_draft_issue` | `addProjectV2DraftIssue` | Quick capture workflow |
| P3 | `update_project` | `updateProjectV2` | Project lifecycle management |
| P3 | `create_status_update` | `createProjectV2StatusUpdate` | Automated reporting |
