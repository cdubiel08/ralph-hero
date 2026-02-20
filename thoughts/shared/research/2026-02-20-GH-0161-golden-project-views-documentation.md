---
date: 2026-02-20
github_issue: 161
github_url: https://github.com/cdubiel08/ralph-hero/issues/161
status: complete
type: research
---

# GH-161: Configure 7 Pre-Defined Views and Document Golden Project Template

## Problem Statement

Configure all 7 recommended views on the golden project template and create comprehensive documentation for reproducing the setup. Since GitHub Projects V2 does not support creating or modifying views via API, all configuration is manual (UI-only). The documentation is the primary deliverable — it enables anyone to reproduce the golden project's view setup, and `copyProjectV2` preserves views when cloning the template.

## Current State Analysis

### API Limitation: Views Are UI-Only

Confirmed across multiple sources ([`view-tools.ts:7-8`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/view-tools.ts#L7), [GH-66 guidance](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-18-GH-0066-github-projects-v2-docs-guidance.md#what-requires-ui-cannot-be-done-via-api), GitHub API reference):

- **No `createProjectV2View` mutation** exists in the public GitHub GraphQL schema
- **No `updateProjectV2View` or `deleteProjectV2View`** mutations exist
- **No `gh project view-create`** CLI command exists
- Views are **read-only** via API: layout, filter, sort, groupBy can be queried but not written
- **`copyProjectV2` preserves views** — this is the only programmatic way to deploy pre-configured views

An undocumented `createProjectV2View` mutation may exist in the live schema (community-discovered via Copilot completions) but has no stability guarantees, no official documentation, and no corresponding update/delete mutations. Not safe for production use.

### Existing View Recipes

The [GH-66 guidance doc](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-18-GH-0066-github-projects-v2-docs-guidance.md#recommended-views) defines 3 views:

1. **Workflow Board** — Board layout, columns by Workflow State, filter `is:open`
2. **Priority Table** — Table layout, group by Priority, sort by Workflow State
3. **Done Archive** — Table layout, filter `workflow-state:Done,Canceled`, sort by Updated (newest)

The issue body requests 7 views, adding 4 more: Sprint Board, Triage Queue, Blocked Items, and Roadmap.

### Read-Only View API

The `ralph_hero__list_views` tool ([`view-tools.ts:29-78`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/view-tools.ts#L29)) queries `ProjectV2.views` and returns `{ id, name, number, layout }` for each view. The GraphQL API also supports reading:

- `filter` — the filter string applied to the view
- `sortByFields` — sort configuration (field + direction)
- `groupByFields` — grouping configuration (field reference)
- `verticalGroupByFields` — swimlane grouping (board layout)
- `fields` — visible fields in the view

These can be used to **verify** view configuration after manual setup, but not to create or modify views.

### `copyProjectV2` Copies Views

Confirmed by [GitHub docs](https://docs.github.com/en/issues/planning-and-tracking-with-projects/creating-projects/copying-an-existing-project) and [GH-162 research](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0162-copy-project-v2-setup-project.md): when a project is copied, the new project inherits all views with their full configuration (layout, filters, sorts, grouping, visible fields). This means getting the golden project's views right is critical — every future project cloned from it inherits these views.

### Filter Syntax

From the [deep dive ideas doc](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/ideas/2026-02-18-github-projects-v2-docs-deep-dive.md):

| Syntax | Meaning |
|--------|---------|
| `is:open` | Open issues only |
| `is:closed` | Closed issues only |
| `is:draft` | Draft issues only |
| `field:value` | Custom field exact match |
| `field:value1,value2` | Custom field multiple values (OR) |
| `-field:value` | Exclude items with field value |
| `@today` | Current date (for date fields) |
| `@current` | Current iteration |

## Key Discoveries

### 1. Complete View Specification (7 Views)

Based on the issue body, GH-66 guidance, and the deep dive ideas document:

#### View 1: Workflow Board (Board)

| Setting | Value |
|---------|-------|
| Layout | Board |
| Column field | Workflow State |
| Filter | `is:open` |
| Card fields | Title, Estimate, Priority, Assignee |
| Use for | Day-to-day workflow tracking, spotting bottlenecks |

This is the primary operational view. All 11 Workflow State options become columns. Hide columns for rarely-used states (Human Needed, Canceled) if desired.

#### View 2: Sprint Board (Board)

| Setting | Value |
|---------|-------|
| Layout | Board |
| Column field | Status (built-in: Todo / In Progress / Done) |
| Group by | Priority |
| Filter | `is:open` |
| Card fields | Title, Workflow State, Estimate, Assignee |
| Use for | Sprint planning, tracking active vs queued work |

**Note**: The issue body mentions "columns by Iteration (if configured)". Since the golden project may not have an Iteration field configured, use Status as the column field (a universally available alternative). If Iteration is added later, switch columns to Iteration and use `iteration:@current` filter.

#### View 3: Priority Table (Table)

| Setting | Value |
|---------|-------|
| Layout | Table |
| Group by | Priority |
| Sort by | Workflow State (ascending) |
| Columns | Number, Title, Workflow State, Estimate, Assignee, Labels |
| Field sums | Enable Estimate sum per group (shows total points per priority) |
| Use for | Sprint planning, priority review, capacity planning |

#### View 4: Triage Queue (Table)

| Setting | Value |
|---------|-------|
| Layout | Table |
| Filter | `workflow-state:Backlog` |
| Sort by | Created (oldest first / ascending) |
| Columns | Number, Title, Priority, Estimate, Labels, Created |
| Use for | Backlog grooming, identifying stale issues, triage sessions |

Oldest-first sorting ensures long-standing issues get attention. The `ralph-triage` label can be used to track which issues have been triaged.

#### View 5: Blocked Items (Table)

| Setting | Value |
|---------|-------|
| Layout | Table |
| Filter | `is:open` |
| Sort by | Priority (P0 first), then Workflow State |
| Columns | Number, Title, Workflow State, Priority, Estimate, Assignee, Labels |
| Use for | Identifying and unblocking stalled work |

**Limitation**: GitHub Projects V2 has no native filter for "has blocking dependencies". The `blocked` relationship is tracked via GitHub's sub-issue/dependency system, not as a project field. This view cannot directly filter to blocked items via the filter syntax.

**Workaround options**:
1. Add a `blocked` label to blocked issues and filter `label:blocked` — requires manual label management
2. Use this view as a general "open items sorted by priority" and visually inspect for blocking relationships
3. Use `ralph_hero__list_dependencies` to query blocked items programmatically and cross-reference

**Recommendation**: Configure as a general "Open by Priority" table. Document the limitation. If a `blocked` label convention is adopted, add `label:blocked` filter.

#### View 6: Done Archive (Table)

| Setting | Value |
|---------|-------|
| Layout | Table |
| Filter | `workflow-state:Done,Canceled` |
| Sort by | Updated (newest first / descending) |
| Columns | Number, Title, Workflow State, Priority, Estimate, Updated |
| Use for | Reviewing completed work, release notes, finding recently closed issues |

#### View 7: Roadmap (Roadmap)

| Setting | Value |
|---------|-------|
| Layout | Roadmap |
| Date field | Target Date (if a date field is configured) or Iteration |
| Zoom | Quarter |
| Group by | Priority |
| Filter | `is:open` |
| Use for | Timeline visualization, milestone tracking |

**Limitation**: The golden project from #160 may not have a date field configured (only Workflow State, Priority, Estimate are created by `setup_project`). The Roadmap layout requires a date or iteration field to position items on the timeline.

**Options**:
1. Add a "Target Date" date field to the golden project (via UI) — simplest
2. Add an Iteration field with sprint cadence — more structured but requires ongoing management
3. Skip the Roadmap view if no date field is configured — note this in documentation

**Recommendation**: Add a "Target Date" date field via UI on the golden project. This is the simplest approach and doesn't require ongoing sprint management. Document that the Roadmap view requires this field.

### 2. This Is Primarily a Documentation Task

Since views cannot be created via API, the implementation for GH-161 is:

1. **Manual UI work**: Create 7 views on the golden project (from #160) using the GitHub Projects UI
2. **Documentation**: Write a comprehensive guide documenting each view's configuration

The documentation is the higher-value deliverable — it enables anyone to reproduce the setup and serves as the reference for what `copyProjectV2` should preserve.

### 3. Verification via `list_views`

After creating views in the UI, use `ralph_hero__list_views` to verify they exist and have the correct layout type. The API returns `{ name, number, layout }` for each view but cannot verify filters, sorts, or grouping. Manual visual verification is needed for those.

### 4. Documentation File Location

The issue body suggests `thoughts/shared/research/golden-project-template.md`. However, since this is reference documentation (not research findings), a better location might be within the GH-66 guidance doc itself (append a "Golden Template Views" section) or as a standalone doc.

**Recommendation**: Create as a standalone doc at `thoughts/shared/research/golden-project-views.md` and link it from the GH-66 guidance doc. This keeps the GH-66 doc focused on general guidance while the new doc covers the specific golden project configuration.

### 5. `copyProjectV2` Limitations to Document

When documenting the golden template, note what `copyProjectV2` does NOT copy:

- **Items** (issues, PRs, draft issues with `includeDraftIssues: false`)
- **Collaborators** and team access
- **Repository links** (must call `link_repository` after copy)
- **Auto-add workflows** (must reconfigure in UI after copy)
- **Iteration schedule** (if an Iteration field exists, the schedule resets)

All views, custom fields, field options, and non-auto-add automations ARE preserved.

### 6. Field Sums / Aggregation

The Priority Table view should enable Estimate field sums to show total story points per priority group. This is a UI-only configuration (click the sum icon on the Estimate column header in table view). The API does not expose or configure field sum settings.

## Potential Approaches

### Approach A: Documentation-First with Manual UI Setup (Recommended)

1. Create the views manually in the GitHub UI on the golden project
2. Write step-by-step documentation for each view
3. Verify via `list_views` API call
4. Note limitations (Blocked Items filter, Roadmap date field requirement)

**Pros:** Simple, straightforward, matches the constraint that views are UI-only.
**Cons:** Manual work, documentation can drift from actual configuration.

### Approach B: Screenshots + Documentation

Same as Approach A but include screenshots of each view's configuration panel.

**Pros:** Visual reference reduces ambiguity.
**Cons:** Screenshots become outdated when GitHub UI changes, harder to maintain in markdown.

### Recommendation: Approach A

Step-by-step text documentation is more maintainable than screenshots. The `list_views` API call provides a machine-readable verification step.

## Implementation Sketch

### Documentation Structure

```markdown
# Golden Project Template — View Configuration

## Prerequisites
- Golden project created via GH-160 (fields: Workflow State, Priority, Estimate)
- Optional: "Target Date" date field added for Roadmap view

## Views

### 1. Workflow Board
**Layout**: Board
**Steps**:
1. Click "New view" → "Board"
2. Click column header → "Fields" → select "Workflow State"
3. Set filter: `is:open`
4. Configure card fields: show Estimate, Priority, Assignee
5. Rename view to "Workflow Board"
6. Save view

### 2. Sprint Board
[similar step-by-step]

### 3-7. [remaining views]

## Verification
Run `ralph_hero__list_views` to verify all 7 views exist:
| # | Name | Layout |
|---|------|--------|
| 1 | Workflow Board | BOARD_LAYOUT |
| 2 | Sprint Board | BOARD_LAYOUT |
| 3 | Priority Table | TABLE_LAYOUT |
| 4 | Triage Queue | TABLE_LAYOUT |
| 5 | Blocked Items | TABLE_LAYOUT |
| 6 | Done Archive | TABLE_LAYOUT |
| 7 | Roadmap | ROADMAP_LAYOUT |

## Template Usage
To create a new project from this template:
1. `ralph_hero__setup_project` with `templateProjectNumber: [golden-number]`
   (or `copyProjectV2` mutation directly)
2. `ralph_hero__link_repository` to link repos (not copied)
3. Configure auto-add workflows in UI (not copied)
```

## Group Context

Parent #110 has 2 children:

| Order | Issue | Title | Estimate | State |
|-------|-------|-------|----------|-------|
| 1 | #160 | Create golden project with fields and built-in automations | XS | Ready for Plan |
| 2 | **#161** | Configure 7 pre-defined views and document golden project template | S | **Research in Progress** |

#161 is blocked by #160 — the golden project must exist before views can be configured on it. #160 is in Ready for Plan (not yet implemented).

## Risks

1. **Blocked Items view limitation**: No native filter for "has blocking dependencies" in GitHub Projects V2. The Blocked Items view will function as a general "Open by Priority" table unless a `blocked` label convention is adopted. Document this clearly.

2. **Roadmap requires date field**: The Roadmap view is non-functional without a date or iteration field. The golden project from #160 doesn't include a date field. Either add one manually or document that the Roadmap view requires post-setup configuration.

3. **Documentation drift**: View configurations may be changed in the UI without updating documentation. Mitigate by periodically running `list_views` to verify view count and layout types.

4. **Iteration field not configured**: The Sprint Board falls back to Status columns if no Iteration field exists. Document both configurations (with and without Iteration).

5. **`copyProjectV2` doesn't copy auto-add**: Projects cloned from the template will need auto-add workflows reconfigured in the UI. Document this post-copy step.

## Recommended Next Steps

1. Wait for #160 to be implemented (golden project must exist)
2. Add a "Target Date" date field to the golden project (for Roadmap view)
3. Create all 7 views in the GitHub Projects UI following the specifications above
4. Write step-by-step documentation at `thoughts/shared/research/golden-project-views.md`
5. Verify via `ralph_hero__list_views` that all 7 views exist with correct layouts
6. Link documentation from the GH-66 guidance doc
7. Record golden project number in documentation for `copyProjectV2` / `setup_project` template parameter
