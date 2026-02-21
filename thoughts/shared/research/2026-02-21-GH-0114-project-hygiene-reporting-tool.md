---
date: 2026-02-21
github_issue: 114
github_url: https://github.com/cdubiel08/ralph-hero/issues/114
status: complete
type: research
---

# GH-114: Add `project_hygiene` Reporting Tool — Board Health and Cleanup Recommendations

## Problem Statement

GH-114 is a parent tracker for adding a comprehensive `project_hygiene` reporting tool to the MCP server. The tool generates a hygiene report identifying stale items, missing fields, WIP violations, and cleanup recommendations. The original issue specified 7 report sections and was split into two sub-issues.

## Current State Analysis

### Sub-Issue Status

| Sub-Issue | Title | Status | Estimate |
|-----------|-------|--------|----------|
| #158 | Create core `project_hygiene` reporting tool with standard sections | **DONE** (merged via PR #192) | S |
| #159 | Add duplicate candidate detection via fuzzy title matching | Open / Backlog | XS |

### What Is Already Implemented (GH-158, Complete)

The core `project_hygiene` tool is fully operational with 6 report sections:

**`lib/hygiene.ts`** (pure functions, ~348 lines):
- `HygieneConfig` interface with configurable thresholds: `archiveDays` (14), `staleDays` (7), `orphanDays` (14), `wipLimits` ({})
- `HygieneItem` type: `number`, `title`, `workflowState`, `ageDays`
- `HygieneReport` type: all 6 sections + summary stats
- Six pure section functions:
  1. `findArchiveCandidates()` — Done/Canceled items older than `archiveDays` (uses `closedAt` when available)
  2. `findStaleItems()` — non-terminal items older than `staleDays`
  3. `findOrphanedItems()` — Backlog items with no assignee older than `orphanDays`
  4. `findFieldGaps()` — non-terminal items missing `estimate` or `priority`
  5. `findWipViolations()` — states exceeding configured WIP limits
  6. `buildHygieneReport()` — orchestrator computing all sections + field coverage %
- `formatHygieneMarkdown()` — markdown formatter with tables per section

**`tools/hygiene-tools.ts`** (I/O layer, ~136 lines):
- Tool registered as `ralph_hero__project_hygiene`
- Reuses `DASHBOARD_ITEMS_QUERY` and `toDashboardItems()` from `dashboard-tools.ts`
- Parameters: `owner`, `archiveDays`, `staleDays`, `orphanDays`, `wipLimits`, `format` (json/markdown)
- Uses `paginateConnection` with `maxItems: 500`

**`__tests__/hygiene.test.ts`** (~379 lines):
- Complete test coverage for all 6 sections
- Uses `makeItem()` factory and fixed `NOW` timestamp (same pattern as `dashboard.test.ts`)
- Tests for edge cases: closedAt vs updatedAt, terminal vs non-terminal state filtering, empty report formatting

**Registration** in `index.ts:24,338`:
- `registerHygieneTools(server, client, fieldCache)` wired into server startup

### What Remains (GH-159, Not Yet Researched/Planned)

GH-159 adds a 7th report section: **Duplicate candidate detection** via fuzzy title matching.

Scope from the issue:
- Implement Levenshtein distance or similar string similarity
- Normalize titles: lowercase, strip common prefixes ("Add", "Create", "Fix"), remove punctuation
- Compare all pairs of non-terminal items
- Flag pairs with similarity > configurable threshold (default 0.8)
- Add `similarityThreshold` parameter to tool schema
- O(n^2) comparison acceptable for up to 500 items

Integration points:
- `lib/hygiene.ts`: Add `findDuplicateCandidates()` function
- `tools/hygiene-tools.ts`: Wire new section + add `similarityThreshold` param
- `HygieneReport` type: Add `duplicateCandidates` field
- `formatHygieneMarkdown()`: Add "Duplicate Candidates" section
- Tests: Add test cases for fuzzy matching

### Group Context

GH-114 belongs to two groups:

**As parent tracker** (sub-issues):
- #158 (done) -> #159 (open, depends on #158 which is satisfied)

**Under Epic #96** (Project Hygiene & Smart Auto-Archive), siblings:
- #113: `bulk_archive` tool (split into #153-#157, in progress)
- #115: Archive stats in `pipeline_dashboard` (closed)
- #116: Integrate hygiene check into `ralph-loop.sh` (closed)

### Architecture Notes

The hygiene module follows the established two-layer pattern:
- **Pure functions** in `lib/hygiene.ts` — no I/O, testable with fixed timestamps
- **I/O layer** in `tools/hygiene-tools.ts` — GraphQL fetching, tool registration

This mirrors `lib/dashboard.ts` + `tools/dashboard-tools.ts` exactly. The `DashboardItem` type from `lib/dashboard.ts` is reused as input to all hygiene functions, avoiding type duplication.

## Key Findings

1. **Core tool is complete and merged** — 6 of 7 acceptance criteria sections from GH-114 are implemented
2. **One remaining sub-issue** — GH-159 (XS) adds duplicate candidate detection, the 7th section
3. **GH-159 is unblocked** — its dependency (#158) is satisfied
4. **GH-159 is well-scoped** — adds one pure function + one tool param + one report section
5. **No additional research needed for GH-114 itself** — it's a tracker, not an implementation ticket
6. **GH-159 needs its own research/plan cycle** — it's currently in Backlog with no research

## Risks

1. **Parent tracker premature closure** — GH-114 should remain open until #159 is complete
2. **Fuzzy matching false positives** — short generic titles like "Fix bug" could produce false matches; GH-159 notes this as an acceptance criterion to address
3. **No external dependency needed** — Levenshtein can be implemented in ~20 lines; no npm package required

## Recommended Next Steps

1. **Move GH-159 to Research Needed** — it's the only remaining work under GH-114
2. **Research GH-159** — focused on fuzzy matching algorithm choice and integration with existing `HygieneReport` type
3. **Plan and implement GH-159** — XS estimate, straightforward addition
4. **Close GH-114** when #159 is done — parent tracker complete
