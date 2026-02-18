---
date: 2026-02-18
github_issue: 66
github_url: https://github.com/cdubiel08/ralph-hero/issues/66
status: complete
---

# GitHub Projects V2 Guidance Document

Comprehensive guide for using GitHub Projects V2 with Ralph Hero's MCP server.

## Board Setup

### Recommended Board View: Workflow State Columns

Create a Board view using the **Workflow State** custom field as the column source. This gives you 11 columns matching Ralph's workflow pipeline:

1. Backlog
2. Research Needed
3. Research in Progress
4. Ready for Plan
5. Plan in Progress
6. Plan in Review
7. In Progress
8. In Review
9. Done
10. Human Needed
11. Canceled

**How to create** (UI only, cannot be done via API):

1. Go to your project board
2. Click "New view" -> "Board"
3. Click the column header dropdown -> "Fields" -> select "Workflow State"
4. Rename the view (e.g., "Workflow Board")

### Default Status Field

The built-in **Status** field (Todo / In Progress / Done) is automatically synced one-way from Workflow State. You do not need to manage Status manually.

## Status-to-Workflow-State Mapping

Ralph syncs the default Status field whenever a Workflow State changes. The mapping is:

| Workflow State | Status |
|----------------|--------|
| Backlog | Todo |
| Research Needed | Todo |
| Ready for Plan | Todo |
| Plan in Review | Todo |
| Research in Progress | In Progress |
| Plan in Progress | In Progress |
| In Progress | In Progress |
| In Review | In Progress |
| Done | Done |
| Canceled | Done |
| Human Needed | Done |

**Rationale:**
- **Todo** = work not yet actively started (queued states)
- **In Progress** = work actively being processed (lock states + review)
- **Done** = terminal/escalated states (no automated progression)

**Implementation**: `WORKFLOW_STATE_TO_STATUS` constant in `plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts`. The sync is best-effort: if the Status field is missing or has custom options, it silently skips.

### Where the sync happens

- `update_workflow_state` tool: calls `syncStatusField()` after updating Workflow State
- `batch_update` tool: adds extra GraphQL aliases for Status updates in the same mutation batch (zero extra API calls)
- `advance_children` tool: calls `syncStatusField()` after advancing each child

## Built-in Automations

GitHub Projects V2 has built-in automations that operate on the **Status** field. Since Ralph now syncs Workflow State -> Status, these automations work correctly:

### Recommended automations to ENABLE

- **Auto-close issues when Status = Done**: When Ralph moves an issue to Done/Canceled/Human Needed, the Status syncs to "Done", which triggers auto-close. This closes the GitHub issue automatically.

### Recommended automations to DISABLE

- **Auto-set Status when issue is closed**: This creates a feedback loop if you close issues manually. Let Ralph manage Status via Workflow State sync instead.
- **Auto-add to project on issue creation**: Only enable this if you want ALL new issues in the project. Otherwise, use `ralph_hero__create_issue` or `ralph_hero__add_to_project` to add issues selectively.

### Automations that are safe either way

- **Auto-set Status when PR is merged**: This only sets Status to "Done". Since Ralph manages Workflow State independently, this is harmless but redundant.

## Auto-Add Configuration

Auto-add workflows automatically add issues from linked repositories to the project.

**Setup** (UI only, cannot be configured via API):

1. Go to Project Settings -> Workflows
2. Find "Auto-add to project"
3. Click "Edit" and select which repositories to auto-add from
4. Optionally set filters (e.g., only issues with certain labels)

**To link a repository** (can be done via API):
```
ralph_hero__link_repository(repoToLink: "owner/repo-name")
```

## Field Configuration

Ralph requires 3 custom single-select fields in the project:

| Field | Options | Setup |
|-------|---------|-------|
| Workflow State | Backlog, Research Needed, Research in Progress, Ready for Plan, Plan in Progress, Plan in Review, In Progress, In Review, Done, Human Needed, Canceled | `ralph_hero__setup_project` |
| Priority | P0, P1, P2, P3 | `ralph_hero__setup_project` |
| Estimate | XS, S, M, L, XL | `ralph_hero__setup_project` |

The built-in **Status** field (Todo, In Progress, Done) is automatically present in all projects.

Run `ralph_hero__setup_project` to create a new project with all custom fields pre-configured. For existing projects, add fields manually in the project settings UI.

## Tool Reference

### Issue Management

| Tool | Description |
|------|-------------|
| `ralph_hero__create_issue` | Create issue + add to project + set fields |
| `ralph_hero__update_issue` | Update issue properties (title, body, labels) |
| `ralph_hero__get_issue` | Get full issue context with relationships and group detection |
| `ralph_hero__list_issues` | List/filter project issues |
| `ralph_hero__create_comment` | Add comment to an issue |

### Workflow State Management

| Tool | Description |
|------|-------------|
| `ralph_hero__update_workflow_state` | Change Workflow State (auto-syncs Status) |
| `ralph_hero__update_estimate` | Change Estimate field |
| `ralph_hero__update_priority` | Change Priority field |
| `ralph_hero__batch_update` | Bulk-update fields across multiple issues (auto-syncs Status) |
| `ralph_hero__advance_children` | Advance sub-issues to match parent state (auto-syncs Status) |

### Project Management

| Tool | Description |
|------|-------------|
| `ralph_hero__setup_project` | Create new project with custom fields |
| `ralph_hero__get_project` | Get project details and field configuration |
| `ralph_hero__list_project_items` | List/filter project items |
| `ralph_hero__archive_item` | Archive/unarchive a project item |
| `ralph_hero__remove_from_project` | Remove an issue from the project |
| `ralph_hero__add_to_project` | Add an existing issue to the project |
| `ralph_hero__link_repository` | Link/unlink a repository to the project |
| `ralph_hero__clear_field` | Clear a field value on a project item |

### Relationships & Pipeline

| Tool | Description |
|------|-------------|
| `ralph_hero__add_sub_issue` | Create parent/child relationship |
| `ralph_hero__list_sub_issues` | List sub-issues of a parent |
| `ralph_hero__add_dependency` | Create blocking dependency |
| `ralph_hero__remove_dependency` | Remove blocking dependency |
| `ralph_hero__list_dependencies` | List blocking/blocked-by relationships |
| `ralph_hero__detect_group` | Detect group of related issues |
| `ralph_hero__detect_pipeline_position` | Determine next workflow phase |
| `ralph_hero__check_convergence` | Check if group has converged to target state |
| `ralph_hero__pick_actionable_issue` | Find highest-priority unblocked issue |

### Views & Dashboard

| Tool | Description |
|------|-------------|
| `ralph_hero__list_views` | List project views |
| `ralph_hero__health_check` | Validate API connectivity and configuration |

## What Requires UI (Cannot Be Done via API)

| Operation | Why |
|-----------|-----|
| Create/edit board/table views | `createProjectV2View` does not exist in the API |
| Configure auto-add workflows | Workflow configuration is UI-only |
| Configure built-in automations | Automation rules are UI-only |
| Customize Status field options | Built-in field options cannot be modified via API |
| Set iteration field schedules | Iteration configuration is UI-only |
| Delete built-in workflows | `deleteProjectV2Workflow` is available but risky |
| Reorder board columns | View layout configuration is UI-only |

## Recommended Views

### 1. Workflow Board (Board layout)

- **Column field**: Workflow State
- **Filter**: `is:open` (hide closed issues)
- **Use for**: Day-to-day workflow tracking, spotting bottlenecks

### 2. Priority Table (Table layout)

- **Group by**: Priority
- **Sort by**: Workflow State
- **Columns**: Number, Title, Workflow State, Estimate, Assignee
- **Use for**: Sprint planning, priority review

### 3. Done Archive (Table layout)

- **Filter**: `workflow-state:Done,Canceled`
- **Sort by**: Updated (newest first)
- **Use for**: Reviewing completed work, finding recently closed issues
