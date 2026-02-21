---
date: 2026-02-20
status: draft
github_issues: [115, 116]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/115
  - https://github.com/cdubiel08/ralph-hero/issues/116
primary_issue: 115
---

# Project Hygiene Dashboard & Loop Integration - Atomic Implementation Plan

## Overview

2 related issues for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-115 | Add archive stats to `pipeline_dashboard` output | S |
| 2 | GH-116 | Integrate hygiene check into ralph-loop.sh triage phase | S |

**Why grouped**: Both belong to Epic #96 (Project Hygiene & Smart Auto-Archive). Phase 1 adds archive eligibility data to the dashboard's pure-function layer, while Phase 2 creates the `/ralph-hygiene` skill and integrates it into `ralph-loop.sh`. Phase 2 uses the dashboard archive stats as one of its data sources.

## Current State Analysis

### Dashboard Architecture (`lib/dashboard.ts`)

The dashboard is built on pure functions with clean separation:
1. `aggregateByPhase()` -- groups items by workflow state, filters Done/Canceled to `doneWindowDays`
2. `detectHealthIssues()` -- scans for WIP, stuck, blocked, pipeline gap, lock collision, oversized warnings
3. `buildDashboard()` -- orchestrates aggregation + health detection, returns `DashboardData`
4. `formatMarkdown()` / `formatAscii()` -- render dashboard data

The `DashboardData` type has: `generatedAt`, `totalIssues`, `phases`, `health`.

### Dashboard Tool (`tools/dashboard-tools.ts`)

Registers `pipeline_dashboard` tool with Zod schema parameters. Fetches all project items via `paginateConnection`, converts to `DashboardItem[]`, builds dashboard, optionally computes metrics.

### ralph-loop.sh

Sequential phase runner with mode flags (`--triage-only`, `--split-only`, etc.), optional phases (`--split=auto|skip`, `--review=auto|skip|interactive`), env var defaults (`RALPH_SPLIT_MODE`, `RALPH_REVIEW_MODE`), and `run_claude()` helper.

### API Limitation

GitHub Projects V2 API does not expose archived item counts. The `items` connection excludes archived items. Only "eligible for archive" stats can be computed from existing data (Done/Canceled + stale).

## Desired End State

### Verification
- [ ] `pipeline_dashboard` includes archive eligibility section in all formats (json, markdown, ascii)
- [ ] `computeArchiveStats()` pure function computes eligible items from existing dashboard data
- [ ] New `archiveThresholdDays` parameter on `pipeline_dashboard` tool (default: 14)
- [ ] Unit tests for `computeArchiveStats()` and formatter extensions
- [ ] `/ralph-hygiene` skill file exists at `plugin/ralph-hero/skills/ralph-hygiene/SKILL.md`
- [ ] `ralph-loop.sh` has `--hygiene=auto|skip` and `--hygiene-only` flags
- [ ] Hygiene phase runs before triage in the loop
- [ ] All existing tests pass

## What We're NOT Doing

- Not tracking total archived item counts (API limitation -- deferred to when `bulk_archive` adds local tracking)
- Not implementing archival rate (7/30 day trends) -- same API limitation
- Not adding file-based hygiene report logging (stdout only for v1)
- Not adding hygiene postcondition hook (lightweight v1)
- Not implementing the `bulk_archive` or `project_hygiene` MCP tools (separate issues #153, #158)

## Implementation Approach

Phase 1 extends the dashboard's pure-function layer with archive eligibility stats. This adds a new `computeArchiveStats()` function and extends `DashboardData`, `buildDashboard()`, and both formatters. Zero additional API calls -- all data comes from already-fetched items.

Phase 2 creates a new `/ralph-hygiene` skill that calls `project_hygiene` and optionally `bulk_archive` MCP tools (gracefully degrading if tools unavailable), then integrates it into `ralph-loop.sh` as an optional phase before triage.

---

## Phase 1: GH-115 - Add Archive Eligibility Stats to pipeline_dashboard

> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/115 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-19-GH-0115-archive-stats-pipeline-dashboard.md

### Changes Required

#### 1. Add `ArchiveStats` interface and `computeArchiveStats()` function
**File**: `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts`
**Changes**:
- Add `ArchiveStats` interface:
  ```typescript
  export interface ArchiveStats {
    eligibleForArchive: number;
    eligibleItems: Array<{
      number: number;
      title: string;
      workflowState: string;
      staleDays: number;
    }>;
    recentlyCompleted: number;
    archiveThresholdDays: number;
  }
  ```
- Add `archive?: ArchiveStats` field to `DashboardData`
- Add `archiveThresholdDays` to `HealthConfig` (default: 14)
- Add `computeArchiveStats(items: DashboardItem[], now: number, archiveThresholdDays: number, doneWindowDays: number): ArchiveStats` pure function:
  - Filter items in Done/Canceled states
  - Compute stale days from `closedAt ?? updatedAt`
  - Items with staleDays > archiveThresholdDays are "eligible for archive"
  - Items with staleDays <= doneWindowDays are "recently completed"
  - Sort eligible items by staleDays descending (stalest first)
- Update `buildDashboard()` to call `computeArchiveStats()` and include in return value

#### 2. Extend formatters with archive section
**File**: `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts`
**Changes**:
- Extend `formatMarkdown()`: Add "## Archive Eligibility" section after health section:
  ```
  ## Archive Eligibility

  **Eligible for archive**: N items (stale > X days in Done/Canceled)
  **Recently completed**: N items (within Y days)

  | # | Title | State | Stale Days |
  |---|-------|-------|------------|
  | #42 | Fix login timeout | Done | 21 |
  ```
  Only render table if there are eligible items.
- Extend `formatAscii()`: Add archive summary line after health section:
  ```
  Archive: N eligible (threshold: Xd), N recent
  ```

#### 3. Add `archiveThresholdDays` parameter to tool
**File**: `plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts`
**Changes**:
- Add `archiveThresholdDays` Zod parameter: `z.number().optional().default(14).describe("Days in Done/Canceled before eligible for archive (default: 14)")`
- Pass `archiveThresholdDays` to `buildDashboard()` via `HealthConfig`

#### 4. Add tests
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/dashboard.test.ts`
**Changes**:
- Add `describe("computeArchiveStats")` block:
  - Test: items in Done > threshold days are eligible
  - Test: items in Canceled > threshold days are eligible
  - Test: items in Done within threshold are not eligible
  - Test: non-terminal items are never eligible
  - Test: recently completed count matches items within doneWindowDays
  - Test: eligible items sorted by staleDays descending
  - Test: uses closedAt when available, falls back to updatedAt
  - Test: empty items returns 0 eligible, 0 recent
- Add tests for archive section in formatMarkdown output
- Add test for archive line in formatAscii output

### Success Criteria

- [ ] Automated: `cd plugin/ralph-hero/mcp-server && npm test` passes
- [ ] Automated: `cd plugin/ralph-hero/mcp-server && npm run build` succeeds
- [ ] Manual: `computeArchiveStats` returns correct eligible items for test data

**Creates for next phase**: Archive eligibility data available in dashboard output for the hygiene skill to reference.

---

## Phase 2: GH-116 - Integrate Hygiene Check into ralph-loop.sh

> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/116 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-19-GH-0116-integrate-hygiene-check-ralph-loop.md | **Depends on**: Phase 1

### Changes Required

#### 1. Create `/ralph-hygiene` skill
**File**: `plugin/ralph-hero/skills/ralph-hygiene/SKILL.md` (new)
**Changes**: Create skill definition following existing patterns (e.g., `ralph-triage/SKILL.md`):
- Step 1: Call `ralph_hero__pipeline_dashboard` with `includeHealth: true` and `archiveThresholdDays` from env
- Step 2: Report archive eligibility summary from dashboard output
- Step 3: If `project_hygiene` tool is available, call it for full hygiene report
- Step 4: If `bulk_archive` tool is available AND archive candidates exceed threshold AND not dry-run, call `bulk_archive`
- Step 5: Report summary (items found, items archived, recommendations)
- Graceful degradation: if MCP tools (`project_hygiene`, `bulk_archive`) are not yet available, report archive eligibility from dashboard only and note that full hygiene requires those tools
- Environment variables: `RALPH_HYGIENE_THRESHOLD` (default: 10), `RALPH_HYGIENE_DRY_RUN` (default: true)

#### 2. Register skill in plugin manifest
**File**: `plugin/ralph-hero/.claude-plugin/plugin.json`
**Changes**: Add `ralph-hygiene` skill entry to the skills array (following existing pattern for other skills).

#### 3. Integrate into ralph-loop.sh
**File**: `plugin/ralph-hero/scripts/ralph-loop.sh`
**Changes**:
- Add `HYGIENE_MODE` variable: `HYGIENE_MODE="${RALPH_HYGIENE_MODE:-auto}"` with `--hygiene=*` flag parsing
- Add `--hygiene-only` to the mode flag parsing
- Add hygiene phase **before triage** in the analyst section:
  ```bash
  # Hygiene phase (before triage for clean board scanning)
  if [ "$MODE" = "all" ] || [ "$MODE" = "--hygiene-only" ] || [ "$MODE" = "--analyst-only" ]; then
      if [ "$HYGIENE_MODE" != "skip" ]; then
          echo "--- Analyst: Hygiene Phase (mode: $HYGIENE_MODE) ---"
          run_claude "/ralph-hygiene" "hygiene"
          work_done=true
      else
          echo "--- Analyst: Hygiene Phase: SKIPPED (--hygiene=skip) ---"
      fi
  fi
  ```
- Add `RALPH_HYGIENE_MODE` export alongside other mode exports
- Update usage comment at top of file to include `--hygiene=auto|skip` and `--hygiene-only`
- Echo hygiene mode in the startup banner

### Success Criteria

- [ ] Automated: `bash -n plugin/ralph-hero/scripts/ralph-loop.sh` passes (syntax check)
- [ ] Automated: `cd plugin/ralph-hero/mcp-server && npm test` still passes
- [ ] Automated: `cd plugin/ralph-hero/mcp-server && npm run build` still succeeds
- [ ] Manual: `./scripts/ralph-loop.sh --hygiene-only` invokes the hygiene skill
- [ ] Manual: `./scripts/ralph-loop.sh --hygiene=skip` skips hygiene phase
- [ ] Manual: Skill file is well-structured and follows existing patterns

**Creates for next phase**: N/A (final phase)

---

## Integration Testing

- [ ] Full `npm test` suite passes with no regressions
- [ ] `npm run build` produces clean output
- [ ] `bash -n` passes on all modified shell scripts
- [ ] Dashboard archive section renders correctly in markdown and ascii formats
- [ ] ralph-loop.sh hygiene flags work as documented

## References

- Research GH-115: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-19-GH-0115-archive-stats-pipeline-dashboard.md
- Research GH-116: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-19-GH-0116-integrate-hygiene-check-ralph-loop.md
- Epic #96: https://github.com/cdubiel08/ralph-hero/issues/96
- Dashboard source: `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts`
- Dashboard tool: `plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts`
- Loop script: `plugin/ralph-hero/scripts/ralph-loop.sh`
