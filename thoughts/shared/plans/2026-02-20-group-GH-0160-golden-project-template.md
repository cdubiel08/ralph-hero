---
date: 2026-02-20
status: draft
github_issues: [160, 161]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/160
  - https://github.com/cdubiel08/ralph-hero/issues/161
primary_issue: 160
---

# Golden Project Template — Atomic Implementation Plan

## Overview

2 related issues for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-160 | Create golden project with fields and built-in automations | XS |
| 2 | GH-161 | Configure 7 pre-defined views and document golden project template | S |

**Why grouped**: #161 (views + documentation) depends on #160 (project creation). Both share parent #110 and deliver a single artifact: a fully-configured golden project template with documentation.

## Current State Analysis

- `ralph_hero__setup_project` creates a GitHub Project V2 with 3 custom fields (Workflow State: 11 options, Priority: 4 options, Estimate: 5 options) matching codebase constants exactly
- Built-in automations (auto-close, auto-set Status) are UI-only -- cannot be configured via API
- Views are entirely UI-only -- no create/update mutations in the GitHub GraphQL API
- `copyProjectV2` preserves all views, fields, field options, and non-auto-add automations
- `ralph_hero__list_views` can verify view existence and layout type but not filters/sorting/grouping

## Desired End State

### Verification
- [ ] Golden project exists on cdubiel08 account with all 3 custom fields (Workflow State, Priority, Estimate)
- [ ] Built-in automations configured per GH-66 guidance (auto-close on Done = enabled, auto-set Status on close = disabled, auto-add = disabled)
- [ ] "Target Date" date field added for Roadmap view support
- [ ] All 7 views created and saved with correct layout, filters, sorting, grouping
- [ ] Documentation at `thoughts/shared/research/golden-project-views.md` covers all view configurations
- [ ] Golden project number recorded in documentation
- [ ] `ralph_hero__list_views` confirms 7 views exist with correct layout types

## What We're NOT Doing

- No code changes to the MCP server
- No new MCP tools (view creation is UI-only per confirmed API limitation)
- No `copyProjectV2` tool implementation (that's GH-162)
- No Iteration field configuration (Sprint Board uses Status columns as fallback)
- No repository linking (done per-project, not on the template)

## Implementation Approach

Phase 1 creates the project and fields via the `setup_project` MCP tool, then documents the manual automation configuration steps. Phase 2 creates all 7 views in the GitHub UI and writes comprehensive reference documentation. Both phases are primarily manual/UI work with MCP tool assistance for creation and verification.

---

## Phase 1: Create Golden Project with Fields and Automations (GH-160)

> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/160 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0160-golden-project-template.md | **Depends on**: none

### Changes Required

#### 1. Check if golden project already exists

Before creating, check existing projects for "Ralph Golden Template" to avoid duplicates:

```
ralph_hero__get_project(owner: "cdubiel08")
```

If a project named "Ralph Golden Template" already exists, skip creation and use its number.

#### 2. Create golden project via MCP tool

```
ralph_hero__setup_project(owner: "cdubiel08", title: "Ralph Golden Template")
```

This creates the project with:
- **Workflow State**: 11 options (Backlog, Research Needed, Research in Progress, Ready for Plan, Plan in Progress, Plan in Review, In Progress, In Review, Done, Human Needed, Canceled)
- **Priority**: 4 options (P0, P1, P2, P3)
- **Estimate**: 5 options (XS, S, M, L, XL)

Record the returned project number.

#### 3. Set project metadata

```
ralph_hero__update_project(
  shortDescription: "Golden template for Ralph-managed projects. Do not add issues directly — use copyProjectV2 to clone.",
  readme: "# Ralph Golden Template\n\nCanonical template for Ralph-managed GitHub Projects V2.\n\n## Usage\n\nClone this project using `copyProjectV2` mutation or `ralph_hero__setup_project` with template support.\n\n## Do NOT\n\n- Add issues to this project directly\n- Modify field options without updating codebase constants\n- Delete views (they are preserved when copying)",
  public: false
)
```

#### 4. Add "Target Date" date field (UI-only)

The Roadmap view requires a date field. Add "Target Date" manually in the GitHub UI:
1. Go to the project settings
2. Click "New field" > "Date"
3. Name: "Target Date"
4. Save

#### 5. Configure built-in automations (UI-only)

Navigate to the project's "Workflows" tab in Settings and configure:

| Automation | Setting | Rationale |
|------------|---------|-----------|
| Auto-close issue (Status = Done) | **Enable** | When Ralph syncs Status to Done, GitHub auto-closes the issue |
| Auto-set Status when issue closed | **Disable** | Prevents feedback loop if issues are closed manually |
| Auto-add to project | **Disable** | Template should have no items; new projects configure per-repo |
| Auto-set Status when PR merged | **Leave default** | Harmless but redundant since Ralph manages Workflow State |

#### 6. Record project number

Post a comment on #160 with the golden project number for reference by downstream issues (#101, #162, #111).

### Success Criteria

- [ ] Automated: `ralph_hero__get_project(owner: "cdubiel08")` returns project with title "Ralph Golden Template"
- [ ] Automated: Project has fields Workflow State (11 options), Priority (4 options), Estimate (5 options)
- [ ] Manual: Built-in automations configured per table above
- [ ] Manual: "Target Date" date field exists
- [ ] Golden project number recorded in issue comment

**Creates for next phase**: Golden project number, project URL, confirmed field configuration

---

## Phase 2: Configure Views and Document (GH-161)

> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/161 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0161-golden-project-views-documentation.md | **Depends on**: Phase 1

### Changes Required

#### 1. Create 7 views in GitHub UI

All views must be created manually in the GitHub Projects UI on the golden project from Phase 1.

**View 1: Workflow Board**

| Setting | Value |
|---------|-------|
| Layout | Board |
| Column field | Workflow State |
| Filter | `is:open` |
| Card fields | Title, Estimate, Priority, Assignee |

**View 2: Sprint Board**

| Setting | Value |
|---------|-------|
| Layout | Board |
| Column field | Status (built-in: Todo / In Progress / Done) |
| Group by | Priority |
| Filter | `is:open` |
| Card fields | Title, Workflow State, Estimate, Assignee |

**View 3: Priority Table**

| Setting | Value |
|---------|-------|
| Layout | Table |
| Group by | Priority |
| Sort by | Workflow State (ascending) |
| Columns | Number, Title, Workflow State, Estimate, Assignee, Labels |
| Field sums | Enable Estimate sum per group |

**View 4: Triage Queue**

| Setting | Value |
|---------|-------|
| Layout | Table |
| Filter | `workflow-state:Backlog` |
| Sort by | Created (oldest first / ascending) |
| Columns | Number, Title, Priority, Estimate, Labels, Created |

**View 5: Blocked Items (Open by Priority)**

| Setting | Value |
|---------|-------|
| Layout | Table |
| Filter | `is:open` |
| Sort by | Priority (P0 first), then Workflow State |
| Columns | Number, Title, Workflow State, Priority, Estimate, Assignee, Labels |

**Note**: No native filter for "has blocking dependencies" in GitHub Projects V2. This view functions as a general "Open by Priority" table. Document this limitation.

**View 6: Done Archive**

| Setting | Value |
|---------|-------|
| Layout | Table |
| Filter | `workflow-state:Done,Canceled` |
| Sort by | Updated (newest first / descending) |
| Columns | Number, Title, Workflow State, Priority, Estimate, Updated |

**View 7: Roadmap**

| Setting | Value |
|---------|-------|
| Layout | Roadmap |
| Date field | Target Date |
| Zoom | Quarter |
| Group by | Priority |
| Filter | `is:open` |

#### 2. Verify views via MCP tool

```
ralph_hero__list_views(owner: "cdubiel08", number: [golden-project-number])
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

#### 3. Create documentation

**File**: `thoughts/shared/research/golden-project-views.md`

Document structure:

```markdown
# Golden Project Template — View Configuration Guide

## Golden Project
- **Owner**: cdubiel08
- **Project Number**: [number]
- **URL**: [url]

## Prerequisites
- Project created via `ralph_hero__setup_project` (GH-160)
- Custom fields: Workflow State (11 options), Priority (4), Estimate (5)
- "Target Date" date field added manually

## Views (7 total)

### 1. Workflow Board
**Layout**: Board
**Steps**:
1. Click "New view" -> "Board"
2. Set column field to "Workflow State"
3. Set filter: `is:open`
4. Configure card fields: Title, Estimate, Priority, Assignee
5. Rename view to "Workflow Board"
6. Save view

[... similar step-by-step for each view ...]

## Post-Copy Checklist
When cloning this template via `copyProjectV2`:
1. Views, fields, and field options are preserved automatically
2. Link repositories: `ralph_hero__link_repository`
3. Configure auto-add workflows in UI (not copied)
4. Set project description and README for the new project

## Limitations
- Blocked Items view: No native filter for blocking dependencies
- Roadmap view: Requires "Target Date" date field
- Views cannot be created/modified via API
- `copyProjectV2` does not copy: items, collaborators, repo links, auto-add workflows
```

### Success Criteria

- [ ] Automated: `ralph_hero__list_views` returns 7 views with correct layout types
- [ ] Manual: Each view has correct filters, sorting, grouping per specification
- [ ] File: `thoughts/shared/research/golden-project-views.md` exists with complete documentation
- [ ] Documentation includes golden project number and URL
- [ ] Documentation includes step-by-step instructions for each view
- [ ] Documentation includes post-copy checklist

---

## Integration Testing

- [ ] `ralph_hero__get_project` confirms project exists with correct fields
- [ ] `ralph_hero__list_views` confirms 7 views with correct layouts
- [ ] Documentation is complete and references correct project number
- [ ] Golden project number is recorded in issue comments for downstream use (#101, #162)

## References

- Research (GH-160): https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0160-golden-project-template.md
- Research (GH-161): https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0161-golden-project-views-documentation.md
- GH-66 guidance: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-18-GH-0066-github-projects-v2-docs-guidance.md
- Parent: https://github.com/cdubiel08/ralph-hero/issues/110
- Related: #101 (copy_project tool), #162 (copyProjectV2 mutation), #111 (setup_project template mode)
