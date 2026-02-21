---
date: 2026-02-21
status: draft
github_issues: [272]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/272
primary_issue: 272
---

# Table View Recipes Documentation - Implementation Plan

## Overview

Fill in 3 Table view recipe placeholders in `thoughts/shared/research/view-recipes.md` for Priority Table, Triage Queue, and Blocked Items views. Each recipe replaces a `<!-- TODO: #272 -->` marker with full configuration details, setup steps, tips, and known limitations.

## Current State Analysis

- Skeleton doc exists at `thoughts/shared/research/view-recipes.md` with TODO placeholders for views 3, 4, 5
- Golden project views spec at `thoughts/shared/research/golden-project-views.md` has detailed config for all 3 views
- Research doc `thoughts/shared/research/2026-02-20-GH-0161-golden-project-views-documentation.md` has additional context
- Common sections (field sums, filter syntax, column limits) already in skeleton — recipes reference them, don't duplicate

## Desired End State

### Verification
- [ ] Priority Table recipe complete with configuration table, setup steps, field sum instructions, tips
- [ ] Triage Queue recipe complete with configuration table, setup steps, filter details, tips
- [ ] Blocked Items recipe complete with configuration table, setup steps, known limitations, workarounds, tips
- [ ] All 3 `<!-- TODO: #272 -->` markers replaced
- [ ] "When to use" guidance included for each view
- [ ] Consistent structure following the View Recipe Template defined in skeleton

## What We're NOT Doing

- Not adding screenshots (issue mentions them but no programmatic way to capture)
- Not creating or modifying actual GitHub Project views
- Not touching view recipes for #271 (Board views) or #273 (Done Archive + Roadmap)
- Not modifying the common sections of the skeleton

## Implementation Approach

Single phase — edit `view-recipes.md` to replace 3 TODO placeholders with full recipes.

---

## Phase 1: Fill in Table View Recipes

> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/272

### Changes Required

#### 1. Replace Priority Table placeholder (view 3)
**File**: `thoughts/shared/research/view-recipes.md`
**Changes**: Replace `<!-- TODO: #272 -->` with full recipe including:
- Configuration table: Table layout, group by Priority, sort by Workflow State (asc), visible columns, Estimate sum enabled
- 7-step setup instructions
- Tips: field sum for capacity planning, sorting within groups
- When to use: sprint planning, priority review, capacity assessment

#### 2. Replace Triage Queue placeholder (view 4)
**File**: `thoughts/shared/research/view-recipes.md`
**Changes**: Replace `<!-- TODO: #272 -->` with full recipe including:
- Configuration table: Table layout, filter `workflow-state:Backlog`, sort by Created (asc), visible columns
- 6-step setup instructions
- Tips: oldest-first ensures stale issues get attention, pair with `ralph-triage` label
- When to use: backlog grooming, triage sessions, issue intake

#### 3. Replace Blocked Items placeholder (view 5)
**File**: `thoughts/shared/research/view-recipes.md`
**Changes**: Replace `<!-- TODO: #272 -->` with full recipe including:
- Configuration table: Table layout, filter `is:open`, sort by Priority then Workflow State, visible columns
- 7-step setup instructions
- Known limitation: no native blocking dependency filter in Projects V2
- Workarounds: `blocked` label convention, `ralph_hero__list_dependencies` programmatic approach
- Tips: use as "Open by Priority" general view, cross-reference with dependency tools
- When to use: standup blockers review, dependency management

### Success Criteria
- [ ] Automated: `grep -c "TODO.*#272" thoughts/shared/research/view-recipes.md` returns 0
- [ ] Automated: `grep -c "Setup Steps" thoughts/shared/research/view-recipes.md` returns at least 3 (one per new recipe)
- [ ] Manual: Each recipe follows the View Recipe Template structure from the skeleton

## File Ownership Summary

| File | Phase | Action |
|------|-------|--------|
| `thoughts/shared/research/view-recipes.md` | 1 | Edit (views 3, 4, 5 only) |

## References

- Research: [GH-0161 golden project views](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0161-golden-project-views-documentation.md)
- Spec: [golden-project-views.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/golden-project-views.md)
- Skeleton: [view-recipes.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/view-recipes.md)
- Parent: [#112 Document view recipes](https://github.com/cdubiel08/ralph-hero/issues/112)
