---
date: 2026-02-18
status: closed
reason: "Ideas triaged: #367 (iteration), #368 (capacity). Ideas 2,3,4,7 already implemented. Ideas 5,8,9 covered by existing issues."
sources: 24 GitHub Docs pages (Projects V2 complete documentation)
---

# GitHub Projects V2 Documentation Deep Dive

Research summary and idea generation based on comprehensive review of all GitHub Projects V2 documentation.

## Documentation Summary

### Core Concept

GitHub Projects V2 is an adaptable planning/tracking tool that integrates with issues and pull requests at user or organization levels. It presents data in three layouts (table, board, roadmap) with custom fields, filtering, automation, and insights.

### Item Management

- **50,000 item limit** across active views and archive combined
- Items can be issues, PRs, or draft issues (lightweight placeholders)
- Draft issues support titles, body text, assignees, and custom fields but lack repo/labels/milestones until converted
- 7 methods to add items: URL paste, search (#), bulk add, repo list, sidebar, command palette, auto-add workflow
- Archiving preserves custom field data and is restorable; deletion is permanent
- Table layout supports copy/paste cells, drag-handle fill, bulk clear, and undo

### Field Types

| Field Type | Capabilities |
|------------|-------------|
| **Text** | Freeform text, exact match filtering (`field:"text"`) |
| **Number** | Numeric values, comparison operators (`>`, `>=`, `<`, `<=`, `..`), field sums |
| **Date** | Calendar picker, `@today` keyword, comparison operators, powers roadmap timeline |
| **Single Select** | Up to 50 options with colors and descriptions, comma filtering |
| **Iteration** | Repeating time blocks (days/weeks), breaks, `@current`/`@previous`/`@next` keywords |

**Limit**: 50 fields total per project (built-in + custom combined).

### Views System

Three layout types, each independently configurable per view tab:

**Table**: Spreadsheet-like. Supports field show/hide, grouping, slicing (side panel filter), field reordering, row reordering (drag), primary + secondary sorting, field sums per group.

**Board**: Kanban columns keyed to any single-select or iteration field. Drag between columns updates field values automatically. Supports column limits (advisory, not enforced), slicing, sorting (disables manual reorder), grouping (horizontal sections), field sums per column.

**Roadmap**: Timeline visualization using date or iteration fields for start/end. Drag to adjust dates. Vertical markers for iterations, milestones, and project dates. Three zoom levels (month, quarter, year). Supports slicing, sorting, grouping.

**View management**: Create, duplicate, save, reorder tabs, rename, delete. Unsaved changes are personal until saved.

### Filtering (Very Powerful)

| Feature | Syntax |
|---------|--------|
| Field match | `field:value` |
| OR within field | `field:value1,value2` |
| AND across fields | `field1:a field2:b` |
| Negation | `-field:value` |
| Presence | `has:field` / `no:field` |
| Comparison | `>`, `>=`, `<`, `<=`, `..` |
| Date keywords | `@today`, `updated:@today-14d` |
| Iteration keywords | `@current`, `@next`, `@previous`, with ranges |
| Wildcards | `label:*bug*` |
| Type/state | `is:issue`, `is:open`, `is:draft` |
| Close reason | `reason:completed`, `reason:"not planned"` |
| Sub-issues | `parent-issue:owner/repo#4` |
| Current user | `@me` |

### Built-in Automations

5 automation types (configured via UI, not API):

1. **Auto-add to project** - Add issues/PRs matching filters from linked repos (plan limits: Free=1, Pro/Team=5, Enterprise=20)
2. **Item added -> Status=Todo** - Default off
3. **Item closed -> Status=Done** - Default on
4. **PR merged -> Status=Done** - Default on
5. **Auto-archive** - Archive items matching `is:`, `reason:`, `updated:` filters
6. **Close issue when Status=Done** - Reverse of #3

Auto-add supports: `is`, `label`, `reason`, `assignee`, `no` qualifiers with negation.

### API (GraphQL)

- 25 mutations available for project management
- Authentication: PAT with `project` scope or GitHub App with project permissions
- `GITHUB_TOKEN` in Actions **cannot** access projects (requires PAT or App token)
- Webhook: `projects_v2_item` fires on item CRUD, but is org-scoped (not project-scoped)
- Key limitation: **Cannot create/edit views, configure automations, or manage iteration schedules via API**

### GitHub Actions Integration

- Common pattern: trigger on repo event -> query project structure -> add item -> update fields
- Requires project field ID lookup (fields returned as union types needing inline fragments)
- `actions/add-to-project` community action simplifies the add step
- Each repo needs its own workflow copy (workflows are repo-scoped, projects span repos)

### Templates & Copying

- Projects can be copied with views, fields, workflows (except auto-add), insights, and optionally draft issues
- Organizations can designate template projects
- Copying excludes: items, collaborators, team/repo links

---

## Gap Analysis: What Ralph-Hero Could Leverage

### Already Well-Covered by Ralph

- Issue CRUD, workflow state management, field updates
- Batch operations, relationship management (sub-issues, dependencies)
- Pipeline dashboard, group detection, convergence checking
- Project setup with custom fields
- Archive/unarchive, remove/add items, link repos, clear fields (added in GH-66)

### Not Yet Leveraged

| GitHub Feature | Ralph Gap | Opportunity |
|----------------|-----------|-------------|
| Draft issues | No support | Quick capture without full issue overhead |
| Iteration fields | No support | Sprint planning, time-boxed work |
| Roadmap layout | No tooling | Timeline visualization for date-based planning |
| Project status updates | No support | Automated sprint/project reporting |
| Auto-archive configuration | UI-only, no guidance | Document best practices, recommend filters |
| Column limits (board) | Not surfaced | Capacity/WIP limit communication |
| Field sums | Not surfaced | Aggregate metrics (estimate totals per state) |
| View duplication | Not surfaced | Standardized view templates |
| Slicing | Not surfaced | Side-panel filtering for focused work |
| `@today`/`@current` filtering | Not used in tools | Dynamic date-relative queries |
| Item position ordering | No support | Priority-based auto-sort |
| Copy project | No support | Project templates for new repos/teams |
| Project description/README | No support | Automated project documentation |

---

## Ideas

### Idea 1: Sprint/Iteration Support

**Problem**: Ralph treats all work as a flat backlog. There's no concept of time-boxed iterations or sprints.

**What GitHub Provides**: Iteration fields with configurable duration, breaks, `@current`/`@next`/`@previous` keywords, board columns by iteration, roadmap visualization.

**Idea**: Add iteration awareness to Ralph:
- `setup_project` creates an Iteration field alongside existing custom fields
- `assign_to_iteration` tool sets iteration on issues
- `list_issues` gains `iteration` filter param (`@current`, `@next`, etc.)
- `pipeline_dashboard` shows per-iteration breakdown
- New `sprint_report` tool summarizes completed/remaining work in `@current` iteration
- Board view recommendation: column by Iteration, grouped by Workflow State

**Value**: Enables time-boxed planning while keeping Ralph's workflow state machine intact.

### Idea 2: Automated Project Reporting via Status Updates

**Problem**: No automated way to communicate project health to stakeholders who don't use CLI tools.

**What GitHub Provides**: `createProjectV2StatusUpdate` mutation with rich markdown, status designation (On track/At risk/Off track), and target dates. Status updates display in the project header and panel.

**Idea**: A `project_status_update` tool that:
- Queries current pipeline state (reuse dashboard logic)
- Calculates velocity (issues completed in last N days)
- Identifies risks (stuck items, WIP violations, blocked dependencies)
- Generates a status update with markdown summary
- Posts via `createProjectV2StatusUpdate`
- Could run on a schedule via `ralph-loop.sh` as a periodic step

**Value**: Stakeholders see project health in GitHub UI without needing Ralph/CLI access.

### Idea 3: Draft Issue Quick-Capture Workflow

**Problem**: Creating full issues requires title, body, labels, repo context. Sometimes you just need to capture an idea fast.

**What GitHub Provides**: `addProjectV2DraftIssue` creates lightweight project items with just title + optional body. Draft issues live in the project without a repo. They can be converted to full issues later.

**Idea**: A two-phase capture workflow:
- `capture_idea` tool creates draft issues in the project with minimal input (title + optional body)
- Draft issues get added to Backlog workflow state
- New `triage_drafts` skill converts promising drafts to real issues (assigns repo, labels, estimates)
- `list_issues` updated to include/exclude drafts via `is:draft` filter
- Integrates with existing triage workflow: drafts appear alongside backlog issues

**Value**: Lower friction for idea capture. Useful during brainstorming or when processing external feedback.

### Idea 4: Smart Auto-Archive with Hygiene Reporting

**Problem**: Project boards accumulate stale Done/Canceled items. Ralph has `archive_item` but no automated hygiene.

**What GitHub Provides**: Built-in auto-archive with `is:closed reason:completed updated:<@today-14d` filters. Also the `archiveProjectV2Item` mutation for programmatic archiving.

**Idea**: A `project_hygiene` tool/skill that:
- Recommends auto-archive filter configuration (document the UI steps)
- Provides a `bulk_archive` tool that archives items matching criteria (e.g., Done + not updated in 14 days)
- Generates a hygiene report: items archived, items approaching archive threshold, orphaned items (no assignee, stale in backlog)
- Could auto-run as part of `ralph-loop.sh` triage phase
- Pairs with the existing `pipeline_dashboard` to show archive statistics

**Value**: Keeps boards clean and focused. Reduces noise for agents scanning the board.

### Idea 5: View Template Recipes

**Problem**: New users don't know which views to create or how to configure them for Ralph's workflow. The existing guidance doc (GH-66) covers this but requires manual UI setup.

**What GitHub Provides**: Views are UI-only (no API), but projects can be copied with views intact. Templates can be shared org-wide.

**Idea**: A "golden project" template approach:
- Create a reference project with pre-configured views:
  - **Workflow Board**: columns by Workflow State, `is:open` filter
  - **Sprint Board**: columns by Iteration, grouped by Priority
  - **Priority Table**: grouped by Priority, sorted by Workflow State, with estimate sums
  - **Roadmap**: date fields for target dates, iteration markers
  - **Triage Queue**: filtered to `workflow-state:Backlog`, sorted by created date
  - **Blocked Items**: filtered to items with blocking dependencies
- Document the `copyProjectV2` mutation in `setup_project` as an alternative to creating from scratch
- Publish view screenshots and configuration steps in the guidance doc
- `setup_project` could optionally copy from template project instead of creating blank

**Value**: Faster onboarding. Consistent view configuration across projects.

### Idea 6: Capacity Planning with Field Sums

**Problem**: No visibility into workload distribution. How many estimate points are in each workflow state? Is any one person overloaded?

**What GitHub Provides**: Field sums in table and board views show aggregate number values per group/column. Iteration fields enable time-boxed capacity.

**Idea**: Extend `pipeline_dashboard` with capacity metrics:
- Query estimate values per workflow state and sum them
- Show per-assignee workload (estimate sum for in-progress items)
- If iterations are used, show iteration capacity (total estimates vs. target)
- New `capacity_report` tool outputs:
  - Estimate distribution across pipeline stages
  - Per-person WIP (items in active states)
  - Sprint burndown (if iterations configured)
- Recommend board view configuration with estimate sums enabled

**Value**: Data-driven sprint planning. Prevents overloading individuals or pipeline stages.

### Idea 7: Cross-Project Orchestration

**Problem**: Ralph currently manages one project. Organizations often have multiple projects (e.g., per-team, per-product).

**What GitHub Provides**: `copyProjectV2` for templates, `linkProjectV2ToTeam` for team association, user/org level project listing, items can be in multiple projects.

**Idea**: Multi-project awareness:
- `list_projects` tool to discover all projects for an owner
- `copy_project` tool to create new projects from templates
- `move_item_between_projects` workflow (add to target + remove from source)
- Cross-project dashboard: aggregate pipeline stats across projects
- `link_project_to_team` tool for access management
- Environment config supports multiple project numbers

**Value**: Scales Ralph from single-project to portfolio management.

### Idea 8: Intelligent Filtering for Agent Context

**Problem**: Agents (analyst, builder, etc.) often need a specific subset of issues but currently get everything and filter client-side.

**What GitHub Provides**: Rich filtering syntax with AND/OR/NOT, comparisons, date math, wildcards, sub-issue queries, close reasons.

**Idea**: Enhance `list_issues` and `list_project_items` with the full filter grammar:
- Support `updated:@today-7d` for recently active items
- Support `parent-issue:owner/repo#N` for sub-issue scoping
- Support `reason:completed` vs `reason:"not planned"` to distinguish close types
- Support `-workflow-state:Done,Canceled` to exclude terminal states
- Support `has:estimate` / `no:estimate` for triage (find unestimated items)
- Build pre-canned filter profiles for each agent role:
  - Analyst: `no:estimate workflow-state:Backlog` (untriaged work)
  - Builder: `workflow-state:"In Progress" assignee:@me` (my active work)
  - Validator: `workflow-state:"Plan in Review","In Review"` (items needing review)
  - Integrator: `workflow-state:"In Review" has:linked-pr` (ready to merge)

**Value**: Reduces API calls and context window usage. Agents get exactly what they need.

### Idea 9: Webhook-Driven Event Bus

**Problem**: Ralph is pull-based (agents poll for work). No real-time reaction to external changes (someone closes an issue in the UI, merges a PR, etc.).

**What GitHub Provides**: `projects_v2_item` webhook for item changes, plus standard `issues` and `pull_request` webhooks. GitHub Actions can trigger on these events.

**Idea**: A lightweight event-driven layer:
- GitHub Actions workflow that triggers on `issues.closed`, `pull_request.merged`, `projects_v2_item`
- Action calls Ralph MCP tools (via CLI or direct GraphQL) to:
  - Sync Workflow State when issue is closed externally
  - Auto-advance parent when all children complete
  - Notify (via issue comment) when a blocked item becomes unblocked
  - Trigger auto-archive after configurable delay
- Not a full event bus, just targeted reactions to common external events
- Complements Ralph's pull-based loop with push-based reactions

**Value**: Ralph stays in sync even when humans make changes outside the CLI workflow.

### Idea 10: Project README as Living Documentation

**Problem**: Project context (workflow rules, field meanings, team conventions) lives in CLAUDE.md and skill files, not visible in GitHub UI.

**What GitHub Provides**: `updateProjectV2` mutation can set project README (markdown) and description. README displays prominently in the project UI.

**Idea**: Auto-generate project README from Ralph's configuration:
- `update_project_readme` tool that generates markdown from:
  - Workflow state definitions and transition rules
  - Priority/estimate field option meanings
  - Current pipeline statistics
  - Links to research docs and plans
  - Team conventions and automation rules
- Could regenerate on each `ralph-loop.sh` run to keep stats current
- Include a "last updated" timestamp and agent attribution
- Helps onboard new team members who discover the project in GitHub UI

**Value**: Single source of truth visible in GitHub UI. Bridges the gap between Ralph's internal knowledge and external visibility.
