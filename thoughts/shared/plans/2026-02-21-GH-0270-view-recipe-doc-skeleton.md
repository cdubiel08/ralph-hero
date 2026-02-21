---
date: 2026-02-21
status: draft
github_issues: [270]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/270
primary_issue: 270
---

# View Recipe Doc Skeleton - Implementation Plan

## Overview

Create a view recipe documentation skeleton at `thoughts/shared/research/view-recipes.md` with common sections that downstream issues (#271, #272, #273) will populate with specific view recipes. The skeleton provides shared reference material (column limits, field sums, slicing recommendations, filter syntax) and a consistent per-view template.

## Current State Analysis

Two existing reference documents provide source material:
- `thoughts/shared/research/golden-project-views.md` — Complete 7-view spec with filter/sort/group settings
- `thoughts/shared/research/2026-02-18-GH-0066-github-projects-v2-docs-guidance.md` — General GitHub Projects V2 guidance

Neither document is structured as a "recipe" format suitable for end-user consumption. The golden-project-views doc is a reference spec; the GH-66 doc is implementation guidance.

## Desired End State

A skeleton document that:
1. Has frontmatter linking to parent issue #112 and this issue #270
2. Contains common reference sections (field reference, filter syntax, column limits, field sums, slicing)
3. Provides a per-view recipe template with consistent structure
4. Has placeholder sections for each of the 7 views that #271, #272, #273 will fill in
5. Includes a verification section

### Verification
- [ ] File exists at `thoughts/shared/research/view-recipes.md`
- [ ] Frontmatter references GH-270 and parent GH-112
- [ ] Common sections present: Prerequisites, Field Reference, Filter Syntax, Column Limits, Field Sums, Slicing Recommendations
- [ ] Per-view recipe template defined
- [ ] All 7 view placeholders present with correct names and layout types
- [ ] Verification section with `list_views` instructions

## What We're NOT Doing

- Not writing full view recipes (that's #271, #272, #273)
- Not adding screenshots (out of scope per research findings)
- Not creating or modifying actual GitHub Project views
- Not duplicating the golden-project-views.md content verbatim

## Implementation Approach

Single phase — create the skeleton document synthesizing common patterns from existing research docs.

---

## Phase 1: Create View Recipe Skeleton Document
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/270

### Changes Required

#### 1. Create skeleton document
**File**: `thoughts/shared/research/view-recipes.md`
**Changes**: Create new markdown document with:

1. **Frontmatter**: date, github_issue, parent_issue, status
2. **Introduction**: Purpose of the doc and how it relates to golden project views
3. **Prerequisites**: What must exist before configuring views (project, fields, Target Date)
4. **Common Reference Sections**:
   - **Field Reference**: Summary table of Workflow State (11 options), Priority (4), Estimate (5), Status (3 built-in), Target Date
   - **Filter Syntax**: Complete filter syntax reference table from research
   - **Column Limits & Best Practices**: Guidance on hiding unused columns, board vs table layout choice
   - **Field Sums**: How to enable field sum aggregation on table views (Estimate column)
   - **Slicing Recommendations**: When to use group-by, sort-by, and filter combinations for different purposes
5. **View Recipe Template**: A template showing the consistent structure each view recipe should follow:
   - View name, layout type, purpose
   - Configuration table (settings/values)
   - Step-by-step setup instructions
   - Known limitations (if any)
   - Tips section
6. **View Placeholders**: One section per view (7 total) with name, layout type, and `<!-- TODO: #271/#272/#273 -->` markers:
   - Workflow Board (Board) — #271
   - Sprint Board (Board) — #271
   - Priority Table (Table) — #272
   - Triage Queue (Table) — #272
   - Blocked Items (Table) — #272
   - Done Archive (Table) — #273
   - Roadmap (Roadmap) — #273
7. **Verification**: Instructions to run `list_views` and expected output table
8. **References**: Links to golden-project-views.md, GH-66 guidance, parent #112

### Success Criteria
- [ ] Automated: `test -f thoughts/shared/research/view-recipes.md && grep -q "Column Limits" thoughts/shared/research/view-recipes.md && grep -q "Field Sums" thoughts/shared/research/view-recipes.md && grep -q "Slicing" thoughts/shared/research/view-recipes.md && grep -q "Filter Syntax" thoughts/shared/research/view-recipes.md`
- [ ] Automated: `grep -c "TODO.*#27[1-3]" thoughts/shared/research/view-recipes.md` returns at least 7
- [ ] Manual: Document reads as a coherent skeleton ready for downstream issues to fill in

## File Ownership Summary

| File | Phase | Action |
|------|-------|--------|
| `thoughts/shared/research/view-recipes.md` | 1 | Create |

## References

- Research: [golden-project-views.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/golden-project-views.md)
- Research: [GH-0066 guidance](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-18-GH-0066-github-projects-v2-docs-guidance.md)
- Research: [GH-0161 research](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0161-golden-project-views-documentation.md)
- Parent: [#112 Document view recipes](https://github.com/cdubiel08/ralph-hero/issues/112)
- Downstream: [#271](https://github.com/cdubiel08/ralph-hero/issues/271), [#272](https://github.com/cdubiel08/ralph-hero/issues/272), [#273](https://github.com/cdubiel08/ralph-hero/issues/273)
