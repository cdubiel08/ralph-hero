---
date: 2026-02-21
status: draft
github_issues: [271]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/271
primary_issue: 271
---

# Board View Recipes (Workflow Board + Sprint Board) - Implementation Plan

## Overview

Fill in the Workflow Board and Sprint Board recipe sections in the existing `thoughts/shared/research/view-recipes.md` skeleton document. Replace the TODO placeholders with complete recipes following the template structure defined in the skeleton.

## Current State Analysis

- Skeleton document exists at `thoughts/shared/research/view-recipes.md` (created by GH-270)
- Two TODO placeholders exist for `#271`: sections 1 (Workflow Board) and 2 (Sprint Board)
- Complete view specifications exist in `thoughts/shared/research/golden-project-views.md`
- Research findings in `thoughts/shared/research/2026-02-20-GH-0161-golden-project-views-documentation.md`

## Desired End State

### Verification
- [ ] Workflow Board recipe replaces TODO placeholder with full recipe (config table, setup steps, tips)
- [ ] Sprint Board recipe replaces TODO placeholder with full recipe (config table, setup steps, tips)
- [ ] Both recipes follow the View Recipe Template structure from the skeleton
- [ ] "When to use" guidance included for each view
- [ ] No TODO markers remain for #271

## What We're NOT Doing

- Not adding screenshots (documentation is text-only per research recommendation)
- Not modifying any other view recipes (#272, #273 handle those)
- Not changing the common reference sections or skeleton structure
- Not creating or modifying actual GitHub Project views

## Implementation Approach

Single phase — replace the two #271 TODO placeholders with complete view recipes.

---

## Phase 1: Fill in Board View Recipes
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/271

### Changes Required

#### 1. Replace Workflow Board placeholder
**File**: `thoughts/shared/research/view-recipes.md`
**Changes**: Replace the `<!-- TODO: #271 -->` block under "### 1. Workflow Board" with:
- Configuration table (Layout, Column field, Filter, Card fields, Field sums)
- Step-by-step setup instructions (8 steps from golden-project-views.md)
- When to use section
- Known limitations (11 columns can be wide)
- Tips (hiding unused columns, WIP monitoring)

#### 2. Replace Sprint Board placeholder
**File**: `thoughts/shared/research/view-recipes.md`
**Changes**: Replace the `<!-- TODO: #271 -->` block under "### 2. Sprint Board" with:
- Configuration table (Layout, Column field, Group by, Filter, Card fields)
- Step-by-step setup instructions (7 steps from golden-project-views.md)
- When to use section
- Known limitations (no Iteration field by default)
- Tips (switching to Iteration field, swimlane behavior)

### Success Criteria
- [ ] Automated: `grep -c "TODO.*#271" thoughts/shared/research/view-recipes.md` returns 0
- [ ] Automated: `grep -q "Workflow State" thoughts/shared/research/view-recipes.md` (column field mentioned)
- [ ] Automated: `grep -q "Group by.*Priority" thoughts/shared/research/view-recipes.md` (Sprint Board grouping)
- [ ] Manual: Both recipes follow the View Recipe Template structure

## File Ownership Summary

| File | Phase | Action |
|------|-------|--------|
| `thoughts/shared/research/view-recipes.md` | 1 | Edit (sections 1 and 2 only) |

## References

- Research: [GH-0161 research](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0161-golden-project-views-documentation.md)
- Reference: [Golden Project Views](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/golden-project-views.md)
- Skeleton: [View Recipes](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/view-recipes.md)
- Parent: [#112 Document view recipes](https://github.com/cdubiel08/ralph-hero/issues/112)
