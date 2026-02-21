---
date: 2026-02-21
github_issue: 270
github_url: https://github.com/cdubiel08/ralph-hero/issues/270
parent_issue: 112
status: skeleton
type: documentation
---

# View Recipes — GitHub Projects V2

Step-by-step recipes for configuring the 7 recommended views on a Ralph-managed GitHub Projects V2 board. Each recipe covers layout, filters, sorting, grouping, and visible fields.

> **How to use this document**: The common sections below apply to all views. Each view recipe follows the same template structure. Views are configured manually in the GitHub Projects UI — the API is read-only for views.

## Prerequisites

Before configuring views, ensure:

1. **Project exists** with custom fields configured via `ralph_hero__setup_project`:
   - Workflow State (11 options)
   - Priority (4 options: P0–P3)
   - Estimate (5 options: XS–XL)
2. **Target Date** date field added manually (required for Roadmap view)
3. **At least one repository linked** via `ralph_hero__link_repository`
4. **Built-in automations configured**:
   - Auto-close issue when Status = Done: **Enabled**
   - Auto-set Status when issue closed: **Disabled**

## Field Reference

| Field | Type | Options | Source |
|-------|------|---------|--------|
| Workflow State | Single select | Backlog, Research Needed, Research in Progress, Ready for Plan, Plan in Progress, Plan in Review, In Progress, In Review, Done, Human Needed, Canceled | `setup_project` |
| Priority | Single select | P0 (Critical), P1 (High), P2 (Medium), P3 (Low) | `setup_project` |
| Estimate | Single select | XS (1), S (2), M (3), L (4), XL (5) | `setup_project` |
| Status | Single select (built-in) | Todo, In Progress, Done | Auto-synced from Workflow State |
| Target Date | Date | — | Manual (UI only) |

### Status Sync Mapping

Workflow State is automatically synced one-way to the built-in Status field:

| Status | Workflow States |
|--------|----------------|
| Todo | Backlog, Research Needed, Ready for Plan, Plan in Review |
| In Progress | Research in Progress, Plan in Progress, In Progress, In Review |
| Done | Done, Canceled, Human Needed |

## Filter Syntax Reference

| Syntax | Meaning | Example |
|--------|---------|---------|
| `is:open` | Open issues only | `is:open` |
| `is:closed` | Closed issues only | `is:closed` |
| `is:draft` | Draft issues only | `is:draft` |
| `field:value` | Custom field exact match | `workflow-state:Backlog` |
| `field:value1,value2` | Multiple values (OR) | `workflow-state:Done,Canceled` |
| `-field:value` | Exclude items with field value | `-priority:P3` |
| `label:name` | Filter by label | `label:bug` |
| `@today` | Current date (date fields) | `target-date:<@today` |
| `@current` | Current iteration | `iteration:@current` |

**Note**: Custom field names in filters use kebab-case (e.g., `workflow-state`, not `Workflow State`).

## Column Limits and Best Practices

### Board Views

- **Column count**: Board views create one column per option in the selected field. Workflow State creates 11 columns; Status creates 3.
- **Hiding columns**: Right-click a column header > "Hide column" to reduce noise. Commonly hidden: Human Needed, Canceled.
- **Column ordering**: Columns follow the field option order. Reorder options in project settings to change column order.
- **WIP awareness**: GitHub Projects V2 does not enforce WIP limits. Monitor column counts visually or use `ralph_hero__pipeline_dashboard` for programmatic WIP tracking.

### Table Views

- **Column selection**: Click the `+` button in the header row to add columns. Drag column headers to reorder.
- **Recommended column limit**: 6–8 visible columns. More columns reduce readability on standard screens.
- **Number column**: Always include the `#` (Number) column for quick issue identification.

### General

- **View naming**: Use descriptive names (e.g., "Workflow Board" not "Board 1"). Names appear as tabs.
- **Saving**: Always click "Save changes" after configuring a view. Unsaved changes show a blue dot on the tab.

## Field Sums (Table Views)

Table views support field sum aggregation for numeric and single-select fields:

1. Click the column header of the field to aggregate (e.g., Estimate)
2. Click the **sum icon** (Σ) that appears below the column header
3. Select the aggregation type:
   - **Sum**: Total of numeric values (treats select options as their ordinal: XS=1, S=2, M=3, L=4, XL=5)
   - **Count**: Number of items
   - **Min/Max**: Smallest/largest value

**When grouped**: Sums appear per group, showing subtotals. This is especially useful for:
- Priority Table: See total estimate points per priority level
- Any grouped table: Understand capacity distribution across groups

**Limitation**: Field sum settings are UI-only. The API cannot read or configure them. They are preserved by `copyProjectV2`.

## Slicing Recommendations

"Slicing" refers to combining group-by, sort-by, and filter to create focused views of your data.

### Common Slicing Patterns

| Goal | Layout | Group By | Sort By | Filter |
|------|--------|----------|---------|--------|
| Track workflow progress | Board | — | — | `is:open` |
| Sprint planning by priority | Board | Priority | — | `is:open` |
| Capacity review | Table | Priority | Workflow State | (none) |
| Backlog grooming | Table | — | Created (asc) | `workflow-state:Backlog` |
| Find stalled work | Table | — | Priority (asc) | `is:open` |
| Review completed work | Table | — | Updated (desc) | `workflow-state:Done,Canceled` |
| Timeline planning | Roadmap | Priority | — | `is:open` |

### Choosing Between Board and Table

| Use Board When | Use Table When |
|---------------|----------------|
| Tracking items across workflow stages | Comparing multiple fields side by side |
| Visualizing WIP distribution | Running totals via field sums |
| Drag-and-drop status changes needed | Sorting by date or other fields |
| Column count is manageable (3–7) | Large number of items (50+) |

### Grouping Guidelines

- **Group by Priority** when reviewing capacity or sprint planning
- **Group by Workflow State** in table views to see progress distribution
- **Avoid double-grouping**: GitHub Projects V2 supports only one group-by per view
- **Board + Group**: Grouping on board views creates swimlanes (rows), useful for Sprint Board (group by Priority with Status columns)

---

## View Recipe Template

Each view recipe below follows this structure:

> ### N. View Name
>
> **Layout**: Board | Table | Roadmap
> **Purpose**: What this view is used for
>
> | Setting | Value |
> |---------|-------|
> | Layout | ... |
> | Column field / Group by | ... |
> | Sort by | ... |
> | Filter | ... |
> | Visible fields | ... |
> | Field sums | ... |
>
> **Setup Steps**:
> 1. Step-by-step instructions...
>
> **Known Limitations** (if any):
> - ...
>
> **Tips**:
> - ...

---

## View Recipes

### 1. Workflow Board

<!-- TODO: #271 — Full recipe with setup steps, configuration table, tips -->

**Layout**: Board
**Purpose**: Day-to-day workflow tracking, spotting bottlenecks

---

### 2. Sprint Board

<!-- TODO: #271 — Full recipe with setup steps, configuration table, tips -->

**Layout**: Board
**Purpose**: Sprint planning, tracking active vs queued work

---

### 3. Priority Table

<!-- TODO: #272 — Full recipe with setup steps, configuration table, field sum instructions -->

**Layout**: Table
**Purpose**: Sprint planning, priority review, capacity planning

---

### 4. Triage Queue

<!-- TODO: #272 — Full recipe with setup steps, configuration table, filter details -->

**Layout**: Table
**Purpose**: Backlog grooming, identifying stale issues, triage sessions

---

### 5. Blocked Items

<!-- TODO: #272 — Full recipe with setup steps, known limitations, workarounds -->

**Layout**: Table
**Purpose**: Identifying and unblocking stalled work

---

### 6. Done Archive

**Layout**: Table
**Purpose**: Reviewing completed work, historical reference, release notes

| Setting | Value |
|---------|-------|
| Layout | Table |
| Filter | `workflow-state:Done,Canceled` |
| Sort by | Updated (descending — newest first) |
| Visible columns | Number, Title, Workflow State, Priority, Estimate, Updated |
| Field sums | None (optional: enable Count for total completed items) |

**When to use**:
- Retrospectives — review what was completed in a time period
- Auditing completed work — verify issues reached Done vs Canceled
- Release notes — find recently closed issues for changelog generation
- Historical reference — look up how a past issue was resolved

**Setup Steps**:
1. Click "+ New view" at the top of the project
2. Select "Table"
3. Click the filter icon and set filter to: `workflow-state:Done,Canceled`
4. Click the sort icon > "Sort by" > select "Updated" > descending (newest first)
5. Configure visible columns by clicking the `+` header button: Number, Title, Workflow State, Priority, Estimate, Updated. Remove any extra columns.
6. Rename the view tab to "Done Archive"
7. Click the view tab dropdown > "Save changes"

**Tips**:
- The `workflow-state:Done,Canceled` filter captures both successful completions and canceled items. To see only successful completions, use `workflow-state:Done` instead.
- Sorting by Updated (descending) surfaces the most recently completed work at the top, which is useful for sprint reviews and release notes.
- Consider enabling Count on the Estimate column to see how many items are in the archive. Enable Sum to see total story points completed.
- Items in Done Archive are candidates for archiving via `ralph_hero__archive_item` to keep the project board clean. Archived items are hidden from all views but remain in the project.

---

### 7. Roadmap

**Layout**: Roadmap
**Purpose**: Timeline planning, milestone tracking, stakeholder visibility

| Setting | Value |
|---------|-------|
| Layout | Roadmap |
| Date field | Target Date |
| Zoom level | Quarter |
| Group by | Priority |
| Filter | `is:open` |

**When to use**:
- Release planning — visualize when work is expected to complete
- Stakeholder visibility — share timeline with non-technical stakeholders
- Timeline communication — see overlapping work and sequencing
- Milestone tracking — monitor progress toward date-based goals

**Prerequisite — Target Date Field**:

The Roadmap layout requires a date field to position items on the timeline. The "Target Date" field is **not** created by `setup_project` — it must be added manually:

1. Go to your project's Settings (gear icon)
2. Click "Custom field" > "New field"
3. Name: `Target Date`
4. Type: **Date**
5. Click "Save"

Once created, set Target Date values on individual issues to position them on the roadmap timeline.

**Setup Steps**:
1. Click "+ New view" at the top of the project
2. Select "Roadmap"
3. Click the date field selector (calendar icon) and choose "Target Date"
4. Set the zoom level to "Quarter" using the zoom controls (magnifying glass icons or dropdown)
5. Click the group icon > "Group by" > select "Priority"
6. Click the filter icon and set filter to: `is:open`
7. Rename the view tab to "Roadmap"
8. Click the view tab dropdown > "Save changes"

**Known Limitations**:
- Items without a Target Date value will not appear on the timeline. They show in a "No date" section at the bottom.
- The Roadmap layout does not support field sums or column-level aggregation.
- Zoom levels available: Month, Quarter, Year. Quarter provides the best balance of detail and overview for most projects.

**Tips**:
- Use the Quarter zoom level for sprint-to-sprint planning. Switch to Month for near-term detail or Year for long-range roadmap views.
- Drag item bars on the timeline to adjust Target Date values directly in the Roadmap view.
- Grouping by Priority creates swimlanes that help stakeholders see high-priority work at a glance.
- If an Iteration field is configured later, you can use it as the date field instead of Target Date for sprint-aligned timelines.

---

## Verification

After configuring all views, verify with the Ralph MCP server:

```
ralph_hero__list_views(owner: "cdubiel08", number: <project-number>)
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

**Note**: The API can verify view names and layout types but cannot verify filters, sorts, grouping, or field sums. Visual inspection is required for those settings.

## References

- [Golden Project Views](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/golden-project-views.md) — Complete 7-view configuration spec
- [GH-66 GitHub Projects V2 Guidance](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-18-GH-0066-github-projects-v2-docs-guidance.md) — General Projects V2 guidance
- [GH-161 Research](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0161-golden-project-views-documentation.md) — View configuration research
- Parent: [#112 Document view recipes](https://github.com/cdubiel08/ralph-hero/issues/112)
- Downstream: [#271 Board views](https://github.com/cdubiel08/ralph-hero/issues/271), [#272 Table views](https://github.com/cdubiel08/ralph-hero/issues/272), [#273 Remaining views](https://github.com/cdubiel08/ralph-hero/issues/273)
