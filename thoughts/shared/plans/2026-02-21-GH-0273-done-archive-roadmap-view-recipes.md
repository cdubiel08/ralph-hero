---
date: 2026-02-21
status: draft
github_issues: [273]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/273
primary_issue: 273
---

# Document Done Archive + Roadmap View Recipes - Implementation Plan

## Overview

Fill in the Done Archive (section 6) and Roadmap (section 7) placeholder sections in `thoughts/shared/research/view-recipes.md` with complete view recipes following the template structure established by GH-270.

## Current State Analysis

- `view-recipes.md` skeleton exists with placeholder TODO comments for sections 6 and 7
- `golden-project-views.md` contains full specs for both views (lines 144-171)
- Research doc `GH-0161` has detailed configuration tables for both views

## Desired End State

### Verification
- [ ] Done Archive section replaces TODO placeholder with full recipe
- [ ] Roadmap section replaces TODO placeholder with full recipe
- [ ] Both follow the View Recipe Template structure from the skeleton
- [ ] Target Date field setup instructions included for Roadmap
- [ ] "When to use" guidance included for both views

## What We're NOT Doing

- Not adding screenshots (documentation is text-based per research recommendations)
- Not modifying other view recipe sections (#271, #272 handle those)
- Not creating or modifying actual GitHub Project views
- Not changing the common sections or template structure

## Implementation Approach

Single phase: edit `view-recipes.md` to replace the two TODO placeholders with complete recipes.

---

## Phase 1: Fill in Done Archive + Roadmap Recipes

> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/273

### Changes Required

#### 1. Replace Done Archive placeholder (section 6)
**File**: `thoughts/shared/research/view-recipes.md`
**Changes**: Replace TODO comment with full recipe including:
- Configuration table (layout, filter, sort, visible fields)
- Step-by-step setup instructions (6 steps)
- When to use guidance
- Tips (archival workflow, finding recent completions)

#### 2. Replace Roadmap placeholder (section 7)
**File**: `thoughts/shared/research/view-recipes.md`
**Changes**: Replace TODO comment with full recipe including:
- Configuration table (layout, date field, zoom, group by, filter)
- Target Date field prerequisite and setup instructions
- Step-by-step setup instructions (7 steps)
- When to use guidance
- Known limitations (date field required)
- Tips (zoom levels, timeline planning)

### Success Criteria
- [ ] Automated: `grep -c "TODO.*#273" thoughts/shared/research/view-recipes.md` returns 0
- [ ] Automated: `grep -q "Done Archive" thoughts/shared/research/view-recipes.md && grep -q "Roadmap" thoughts/shared/research/view-recipes.md`
- [ ] Manual: Both recipes follow the View Recipe Template structure

## File Ownership Summary

| File | Phase | Action |
|------|-------|--------|
| `thoughts/shared/research/view-recipes.md` | 1 | Edit (sections 6 and 7 only) |

## References

- Research: [GH-0161](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0161-golden-project-views-documentation.md)
- Golden views: [golden-project-views.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/golden-project-views.md)
- Skeleton: [view-recipes.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/view-recipes.md)
- Parent: [#112 Document view recipes](https://github.com/cdubiel08/ralph-hero/issues/112)
