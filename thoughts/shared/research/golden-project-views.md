---
date: 2026-02-20
github_issues: [160, 161]
type: reference
---

# Golden Project Template -- View Configuration Guide

## Golden Project

| Field | Value |
|-------|-------|
| **Owner** | cdubiel08 |
| **Project Number** | 4 |
| **URL** | https://github.com/users/cdubiel08/projects/4 |
| **Title** | Ralph Golden Template |

## Prerequisites

- Project created via `ralph_hero__setup_project` (GH-160)
- Custom fields configured: Workflow State (11 options), Priority (4 options), Estimate (5 options)
- "Target Date" date field added manually (required for Roadmap view)
- Built-in automations configured per GH-66 guidance

## Field Reference

### Workflow State (Single Select, 11 options)

| Option | Color | Description |
|--------|-------|-------------|
| Backlog | GRAY | Awaiting triage |
| Research Needed | PURPLE | Needs investigation before planning |
| Research in Progress | PURPLE | Investigation underway (locked) |
| Ready for Plan | BLUE | Research complete, ready for planning |
| Plan in Progress | BLUE | Plan being written (locked) |
| Plan in Review | BLUE | Plan awaiting approval |
| In Progress | ORANGE | Implementation underway |
| In Review | YELLOW | PR created, awaiting code review |
| Done | GREEN | Completed and merged |
| Human Needed | RED | Escalated - requires human intervention |
| Canceled | GRAY | Ticket canceled or superseded |

### Priority (Single Select, 4 options)

| Option | Color | Description |
|--------|-------|-------------|
| P0 | RED | Critical - Drop everything, fix now |
| P1 | ORANGE | High - Must do this sprint |
| P2 | YELLOW | Medium - Should do soon |
| P3 | GRAY | Low - Nice to have |

### Estimate (Single Select, 5 options)

| Option | Color | Description |
|--------|-------|-------------|
| XS | BLUE | Extra Small (1) |
| S | GREEN | Small (2) |
| M | YELLOW | Medium (3) |
| L | ORANGE | Large (4) |
| XL | RED | Extra Large (5) |

### Target Date (Date)

Manual date field for Roadmap view positioning. Not created by `setup_project` -- must be added via GitHub UI.

## Views (7 total)

### 1. Workflow Board

**Layout**: Board
**Purpose**: Day-to-day workflow tracking, spotting bottlenecks

**Steps**:
1. Click "+ New view" at the top of the project
2. Select "Board"
3. Click the column header dropdown > "Column field" > select "Workflow State"
4. Click the filter icon > set filter: `is:open`
5. Click the card overflow menu > "Fields" > enable: Title, Estimate, Priority, Assignees
6. Optionally hide columns for rarely-used states (Human Needed, Canceled) by clicking the column header > "Hide column"
7. Rename the view tab to "Workflow Board"
8. Click the view tab dropdown > "Save changes"

### 2. Sprint Board

**Layout**: Board
**Purpose**: Sprint planning, tracking active vs queued work

**Steps**:
1. Click "+ New view" > "Board"
2. Set column field to "Status" (built-in: Todo / In Progress / Done)
3. Click the group icon > "Group by" > select "Priority"
4. Set filter: `is:open`
5. Configure card fields: Title, Workflow State, Estimate, Assignees
6. Rename to "Sprint Board"
7. Save changes

**Note**: If an Iteration field is added later, switch columns to Iteration and use `iteration:@current` filter for current sprint focus.

### 3. Priority Table

**Layout**: Table
**Purpose**: Sprint planning, priority review, capacity planning

**Steps**:
1. Click "+ New view" > "Table"
2. Click the group icon > "Group by" > select "Priority"
3. Click the sort icon > "Sort by" > select "Workflow State" > ascending
4. Configure visible columns: Number, Title, Workflow State, Estimate, Assignees, Labels
5. Click the Estimate column header > enable "Sum" to show total estimate per priority group
6. Rename to "Priority Table"
7. Save changes

### 4. Triage Queue

**Layout**: Table
**Purpose**: Backlog grooming, identifying stale issues, triage sessions

**Steps**:
1. Click "+ New view" > "Table"
2. Set filter: `workflow-state:Backlog`
3. Click sort icon > "Sort by" > "Created" > ascending (oldest first)
4. Configure visible columns: Number, Title, Priority, Estimate, Labels, Created
5. Rename to "Triage Queue"
6. Save changes

### 5. Blocked Items

**Layout**: Table
**Purpose**: Identifying and unblocking stalled work

**Steps**:
1. Click "+ New view" > "Table"
2. Set filter: `is:open`
3. Click sort icon > "Sort by" > "Priority" > ascending (P0 first)
4. Add secondary sort: "Workflow State" > ascending
5. Configure visible columns: Number, Title, Workflow State, Priority, Estimate, Assignees, Labels
6. Rename to "Blocked Items"
7. Save changes

**Known Limitation**: GitHub Projects V2 has no native filter for "has blocking dependencies". The blocking relationship is tracked via GitHub's sub-issue/dependency system, not as a project field. This view functions as a general "Open by Priority" table. To identify blocked items programmatically, use `ralph_hero__list_dependencies`.

**Workaround**: If a `blocked` label convention is adopted, add `label:blocked` filter to narrow results.

### 6. Done Archive

**Layout**: Table
**Purpose**: Reviewing completed work, release notes, finding recently closed issues

**Steps**:
1. Click "+ New view" > "Table"
2. Set filter: `workflow-state:Done,Canceled`
3. Click sort icon > "Sort by" > "Updated" > descending (newest first)
4. Configure visible columns: Number, Title, Workflow State, Priority, Estimate, Updated
5. Rename to "Done Archive"
6. Save changes

### 7. Roadmap

**Layout**: Roadmap
**Purpose**: Timeline visualization, milestone tracking

**Steps**:
1. Click "+ New view" > "Roadmap"
2. Set date field to "Target Date"
3. Set zoom level to "Quarter"
4. Click the group icon > "Group by" > select "Priority"
5. Set filter: `is:open`
6. Rename to "Roadmap"
7. Save changes

**Prerequisite**: The "Target Date" date field must exist on the project. If not configured, the Roadmap layout will not be functional.

## Verification

After creating all views, run `ralph_hero__list_views` to verify:

```
ralph_hero__list_views(owner: "cdubiel08", number: 4)
```

Expected result:

| # | Name | Layout |
|---|------|--------|
| 1 | Workflow Board | BOARD_LAYOUT |
| 2 | Sprint Board | BOARD_LAYOUT |
| 3 | Priority Table | TABLE_LAYOUT |
| 4 | Triage Queue | TABLE_LAYOUT |
| 5 | Blocked Items | TABLE_LAYOUT |
| 6 | Done Archive | TABLE_LAYOUT |
| 7 | Roadmap | ROADMAP_LAYOUT |

**Note**: The API can verify view names and layout types but cannot verify filters, sorts, or grouping. Visual inspection is required for those settings.

## Built-in Automations

| Automation | Setting | Rationale |
|------------|---------|-----------|
| Auto-close issue (Status = Done) | **Enabled** | When Ralph syncs Status to Done, GitHub auto-closes the issue |
| Auto-set Status when issue closed | **Disabled** | Prevents feedback loop if issues are closed manually |
| Auto-add to project | **Disabled** | Template should have no items; new projects configure per-repo |
| Auto-set Status when PR merged | **Default** | Harmless but redundant since Ralph manages Workflow State |

## Template Usage

### Creating a New Project from Template

To create a new Ralph-managed project from this golden template:

1. **Copy the project** using the `copyProjectV2` GraphQL mutation:
   ```graphql
   mutation {
     copyProjectV2(input: {
       projectId: "PVT_kwHOBBH8E84BPwTh"
       ownerId: "[target-owner-node-id]"
       title: "My New Project"
       includeDraftIssues: false
     }) {
       projectV2 { id number url }
     }
   }
   ```
   Or use the future `ralph_hero__copy_project` tool when available.

2. **Link repositories**: `ralph_hero__link_repository(owner, repo, projectNumber: [new-number])`

3. **Configure auto-add workflows** in the new project's UI (not copied by `copyProjectV2`)

4. **Set project description and README** for the new project context

### What `copyProjectV2` Preserves

- All custom fields and their options (Workflow State, Priority, Estimate, Target Date)
- All 7 views with full configuration (layout, filters, sorts, grouping, visible fields)
- Non-auto-add automations

### What `copyProjectV2` Does NOT Preserve

- Items (issues, PRs, draft issues)
- Collaborators and team access
- Repository links (must call `link_repository` after copy)
- Auto-add workflows (must reconfigure in UI)
- Iteration schedule (resets if Iteration field exists)

## Filter Syntax Reference

| Syntax | Meaning |
|--------|---------|
| `is:open` | Open issues only |
| `is:closed` | Closed issues only |
| `is:draft` | Draft issues only |
| `field:value` | Custom field exact match |
| `field:value1,value2` | Multiple values (OR) |
| `-field:value` | Exclude items with field value |
| `label:name` | Filter by label |
| `@today` | Current date (for date fields) |
| `@current` | Current iteration |

## References

- GH-66 guidance: [GitHub Projects V2 Docs Guidance](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-18-GH-0066-github-projects-v2-docs-guidance.md)
- GH-160: [Create golden project](https://github.com/cdubiel08/ralph-hero/issues/160)
- GH-161: [Configure views and document](https://github.com/cdubiel08/ralph-hero/issues/161)
- Parent: [#110 Create golden project template with pre-configured views](https://github.com/cdubiel08/ralph-hero/issues/110)
