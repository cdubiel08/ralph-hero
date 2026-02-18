---
date: 2026-02-18
github_issue: 66
github_url: https://github.com/cdubiel08/ralph-hero/issues/66
status: complete
type: research
---

# Research: GH Projects V2 Documentation Review & Guidance (GH-66)

## Problem Statement

Comprehensive review of the GitHub Projects V2 documentation to produce a guidance document covering key capabilities, limitations, API operations, built-in automations, best practices, and recommendations for Ralph integration improvements.

## GitHub Projects V2 Comprehensive Reference

### 1. Core Concepts

GitHub Projects V2 is an adaptable planning tool that integrates with GitHub issues and pull requests. Projects exist at two levels:

- **Organization projects** - span multiple repositories, support team access, templates
- **User projects** - personal, limited to repositories owned by the individual

**Capacity limit**: 50,000 items per project (across active views and archive combined).

### 2. Layouts

Projects support three visualization formats, each configurable independently per view:

| Layout | Best For | Key Feature |
|--------|----------|-------------|
| **Table** | High-density data, bulk editing | Spreadsheet-like, show/hide columns |
| **Board** | Kanban workflow, visual status | Drag items between columns (any single-select field) |
| **Roadmap** | Timeline planning, date tracking | Drag to adjust start/target dates, iteration markers |

**Ralph relevance**: Board layout can use ANY single-select field for columns, not just Status. This means a board view grouped by "Workflow State" is possible and gives visual kanban for Ralph's state machine.

### 3. Field System

**Limit**: 50 fields total per project.

#### Built-in Tracked Fields (auto-synced with issues/PRs)
- Assignees, Labels, Milestone, Issue Type
- Linked Pull Requests, PR Reviewers
- Parent Issue, Sub-issue Progress (completion bars)

#### Custom Field Types
| Type | API dataType | Capabilities |
|------|-------------|--------------|
| **Single Select** | `SINGLE_SELECT` | Up to 50 options, color + description per option, board column source |
| **Text** | `TEXT` | Freeform notes |
| **Number** | `NUMBER` | Supports >, >=, <, <=, range filters |
| **Date** | `DATE` | Calendar picker, roadmap positioning, temporal filters |
| **Iteration** | `ITERATION` | Repeating time blocks, break support, @current/@next/@previous filters |

**Ralph's current custom fields**: Workflow State (SINGLE_SELECT), Priority (SINGLE_SELECT), Estimate (SINGLE_SELECT). These use 3 of the 50-field budget.

**Recommendation**: Ralph could benefit from:
- An **Iteration** field for sprint planning
- A **Date** field for target completion (roadmap view positioning)
- A **Text** field for brief status notes visible in table view

### 4. Views and Filtering

#### View Configuration
Each view independently controls:
- Layout (table/board/roadmap)
- Visible fields (columns in table)
- Sort order
- Filter expression
- Group-by field
- Slice-by field (sidebar segmentation)

**API limitation**: Views CANNOT be created, updated, or deleted via the GraphQL API. All view management is UI-only. This is a hard limitation confirmed in [view-tools.ts:8](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/view-tools.ts#L8).

#### Filter Syntax (comprehensive)

**Field filters**:
- `fieldname:value` - Exact match
- `fieldname:value1,value2` - OR match
- `-fieldname:value` - Negation
- `fieldname:>value`, `fieldname:>=value`, `fieldname:<value`, `fieldname:<=value` - Comparison
- `fieldname:value1..value2` - Range (inclusive)
- `fieldname:"value with spaces"` - Quoted values
- `fieldname:*text*` - Wildcard patterns

**Existence filters**:
- `has:fieldname` / `no:fieldname` - Field presence/absence
- `has:assignee` / `no:label` - Built-in field shortcuts

**State/type filters**:
- `is:open`, `is:closed`, `is:merged`, `is:draft`
- `is:issue`, `is:pr`
- `reason:completed`, `reason:"not planned"`, `reason:reopened`

**Temporal filters**:
- `updated:@today`, `updated:>@today-30d`
- `iteration:@current`, `iteration:@next`, `iteration:@previous`
- `date:@today..@today+7`

**Relationship filters**:
- `repo:owner/repo` - By repository
- `parent-issue:owner/repo#number` - Sub-issues of specific parent

**Special keywords**:
- `@me` - Current user
- `@today` - Current date
- `@current`, `@next`, `@previous` - Relative iterations

**Ralph relevance**: The filter syntax is powerful enough to build targeted views like:
- `is:open no:assignee field:"Workflow State":Backlog` - Unassigned backlog
- `is:open field:"Workflow State":"In Progress","In Review"` - Active work
- `is:open field:"Priority":P0,P1 field:"Workflow State":"Research Needed","Ready for Plan"` - High-priority queue

### 5. Built-in Automation Workflows

#### Default Workflows (enabled automatically)
1. **Item closed -> Status=Done** - When issues/PRs are closed
2. **PR merged -> Status=Done** - When PRs are merged

#### Configurable Workflows
3. **Item added -> Status=Todo** - When items are added to the project
4. **Auto-add from repository** - Adds issues/PRs matching a filter criteria
5. **Auto-archive** - Archives items meeting criteria (closed + updated threshold)

#### Auto-add Workflow Limits (by plan)
- GitHub Free: 1 workflow
- GitHub Pro/Team: 5 workflows
- Enterprise: 20 workflows

#### Auto-archive Filter Criteria
- `is`: open, closed, merged, draft, issue, pr
- `reason`: completed, reopened, "not planned"
- `updated`: last 14 days, last 3 weeks, last month

**Critical insight for Ralph**: Built-in automations ONLY affect the default **Status** field (Todo/In Progress/Done). They do NOT affect custom single-select fields like Ralph's **Workflow State**. This means:
- Ralph's state machine is NOT duplicated by built-in automations
- BUT users who interact with the default board columns won't trigger Ralph workflow transitions
- This is the core problem that GH-62 (Status <-> Workflow State mapping) needs to solve

### 6. GitHub Actions Integration

Projects V2 can be automated through GitHub Actions using the GraphQL API. Key patterns:

**Authentication**: Must use a GitHub App token or PAT with `project` + `repo` scopes. The built-in `GITHUB_TOKEN` cannot access projects (repository-scoped only).

**Common workflow pattern**:
1. Trigger on issue/PR event (e.g., `pull_request.ready_for_review`)
2. Query project structure to get field IDs
3. Add item to project via `addProjectV2ItemById`
4. Set field values via `updateProjectV2ItemFieldValue`

**Ralph relevance**: GitHub Actions could serve as the bridge between GitHub events and Ralph's MCP server -- for example, automatically setting Workflow State based on PR events, or triggering Ralph's research/plan phases based on label changes.

### 7. Webhooks

- `projects_v2_item` - Fires on item create/edit/delete/archive/restore
- **Limitation**: Org-scoped, not project-scoped (receives ALL project events for the org)
- Useful for: external automation, audit logging, Slack notifications

### 8. Insights and Charts

**Chart types**:
- **Current charts** - Point-in-time snapshots (distribution, breakdown)
- **Historical charts** - Track changes over time (burn-up, completion trends)

**Default chart**: "Burn up" showing completed vs remaining work.

**Limitations**:
- Archived/deleted items are NOT tracked in insights
- Charts are read-only via API (no programmatic chart creation)

### 9. Status Updates

Project-level status updates (separate from issue comments):
- Set status: "On track", "At risk", "Off track"
- Include start date, target date
- Markdown-formatted message body
- Visible to anyone with project read access
- API: `createProjectV2StatusUpdate`, `updateProjectV2StatusUpdate`, `deleteProjectV2StatusUpdate`

**Ralph relevance**: Could power automated sprint/project status reports generated from pipeline dashboard data.

### 10. Templates

Organization projects can be marked as templates:
- Templates include: views, custom fields, draft issues, configured workflows (except auto-add), insights
- Up to 6 recommended templates per org
- API: `markProjectV2AsTemplate`, `unmarkProjectV2AsTemplate`, `copyProjectV2`

**Ralph relevance**: A "Ralph Workflow" template with pre-configured Workflow State, Priority, Estimate fields and views could simplify onboarding. `setup_project` already does this programmatically, but a template approach would include views too (which can't be created via API).

### 11. Access Management

**Organization project roles**:
- No access, Read, Write, Admin (base level for all org members)
- Per-collaborator: Read, Write, Admin (individuals, teams, outside collaborators)
- API: `updateProjectV2Collaborators`

**Key constraint**: Project access is separate from repository access. Users need both project access AND repo access to see items from private repos.

### 12. Repository Linking

- Projects can be linked to repositories via `linkProjectV2ToRepository`
- A default repository can be set (new issues created in project go there)
- Only projects owned by the same user/org as the repo can be linked

## Gap Analysis: Current Ralph vs. GitHub Capabilities

### What Ralph Does Well
1. **Rich state machine** - 11 workflow states vs GitHub's 3 (Todo/In Progress/Done)
2. **Semantic state transitions** - `__LOCK__`, `__COMPLETE__`, `__ESCALATE__` intents
3. **Group detection** - Transitive closure over sub-issues + dependencies
4. **Pipeline detection** - Automatically determines next workflow phase
5. **Batch operations** - Aliased GraphQL for efficient bulk updates
6. **Dashboard** - Pipeline visualization with health indicators

### What Ralph Could Leverage Better

1. **Board views with Workflow State** - Board layout can use any single-select field as columns, not just Status. A view with columns for each Workflow State provides visual kanban without needing the Status field at all.

2. **Auto-add workflows** - Automatically add new issues from linked repos to the project. Currently, `create_issue` handles this, but auto-add catches issues created outside Ralph.

3. **Auto-archive** - Currently no archiving. Done/Canceled items accumulate. The built-in auto-archive or a new `archive_item` tool would solve this.

4. **Filter syntax** - Ralph's `list_issues` does client-side filtering after fetching all items. For projects with many items, leveraging GitHub's server-side view filtering could be more efficient. However, the API doesn't expose view-level filtered queries directly.

5. **Iteration fields** - Sprint planning is currently done ad-hoc. An iteration field + roadmap view would provide timeline-based planning.

6. **Status updates** - Project-level reporting (On track/At risk) could be automated from dashboard health data.

7. **Templates** - A "Ralph Workflow" project template with pre-configured fields AND views would simplify onboarding. The `setup_project` tool creates fields but can't create views.

### Known Hard Limitations

| Limitation | Impact on Ralph |
|-----------|----------------|
| Views cannot be created/modified via API | Cannot automate view setup; must use UI or templates |
| Built-in automations target Status only | Cannot auto-trigger Workflow State changes from GH events |
| Webhooks are org-scoped | Webhook listeners receive noise from all projects |
| 50 fields per project | Not a concern (Ralph uses 3 custom fields) |
| 50 options per single-select | Not a concern (Workflow State has 11 options) |
| 50,000 items per project | Not a concern for typical usage |
| Auto-add doesn't apply to existing items | Need bulk-add for initial setup |
| Insights exclude archived items | Archive timing matters for historical charts |

## Recommendations for Ralph Integration

### Priority 1: Immediate Improvements

1. **Add archive/unarchive tools** - Use `archiveProjectV2Item` / `unarchiveProjectV2Item` to keep boards clean. Could also batch-archive Done items older than N days.

2. **Configure auto-add workflow** - Document how users should set up auto-add to catch issues created outside Ralph. Include in `/ralph-setup` guidance.

3. **Configure auto-archive** - Document recommended auto-archive settings (e.g., `is:closed reason:completed updated:>3 weeks`).

4. **Board view guidance** - Document how to create a Board view using Workflow State as columns for visual kanban.

### Priority 2: Medium-Term Enhancements

5. **Add `link_repository` tool** - Wrap `linkProjectV2ToRepository` for multi-repo support.

6. **Add `remove_item` tool** - Wrap `deleteProjectV2Item` for cleanup.

7. **Add `clear_field_value` tool** - Wrap `clearProjectV2ItemFieldValue` for field resets.

8. **Project status update tool** - Wrap `createProjectV2StatusUpdate` for automated reporting.

### Priority 3: Future Opportunities

9. **Ralph project template** - Create a template project with pre-configured views, fields, and workflows. Document in setup guide.

10. **Iteration field support** - Add iteration field to `setup_project` and create tools for iteration management.

11. **GitHub Actions bridge** - Create a reusable Actions workflow that syncs PR events with Ralph's Workflow State.

## Risks and Considerations

1. **Status vs Workflow State tension** - The biggest risk is user confusion between GitHub's default Status field and Ralph's Workflow State. Board views can use either. Recommendation: hide Status from table views and use Workflow State exclusively, OR implement GH-62's mapping.

2. **Auto-archive vs insights** - Archiving too aggressively loses historical chart data. Recommendation: archive after 30+ days, not immediately on Done.

3. **Template maintenance** - Templates are snapshots; they don't auto-update when the source project changes. Need to re-mark as template after changes.

4. **View setup friction** - Since views can't be created via API, every new project requires manual view setup. Templates mitigate this but are org-only.

5. **Filter complexity** - GitHub's filter syntax is powerful but not accessible via API for querying. Ralph's client-side filtering in `list_issues` works but doesn't scale to very large projects (500+ items).
