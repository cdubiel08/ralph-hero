---
date: 2026-05-06
status: draft
type: plan
github_issue: 1085
github_issues: [1085, 1086, 1087, 1088]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1085
  - https://github.com/cdubiel08/ralph-hero/issues/1086
  - https://github.com/cdubiel08/ralph-hero/issues/1087
  - https://github.com/cdubiel08/ralph-hero/issues/1088
primary_issue: 1085
tags: [hygiene, multi-repo, mcp-server, project-hygiene, dashboard]
---

# project_hygiene multi-repo aggregation - Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-03-14-hygiene-pipeline-multi-repo-aggregation]]
- builds_on:: [[2026-02-21-GH-0114-project-hygiene-reporting-tool]]

## Overview

4 related issues for atomic implementation in a single PR. Together they bring `project_hygiene` to feature-parity with `pipeline_dashboard` for multi-repo / multi-project workspaces.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-1085 | preserve repository field on HygieneItem | XS |
| 2 | GH-1086 | add projectNumbers parameter for multi-project aggregation | S |
| 3 | GH-1087 | auto-compute repoBreakdowns and render per-repo markdown sections | S |
| 4 | GH-1088 | add groupBy=repo parameter for explicit per-repo sub-reports | S |

**Why grouped**: All four issues share a parent (#563) and form one coherent migration of the `project_hygiene` tool from single-project / single-repo to the same multi-project + multi-repo capability already shipped on `pipeline_dashboard`. The phases build strictly: (1) data plumbing (`HygieneItem.repository`), (2) ingest (multi-project fetch via `fetchDashboardItems`), (3) auto-aggregation (`repoBreakdowns` + markdown), (4) explicit slicing (`groupBy: "repo"`). Each phase by itself is a useless half-step; together they ship the feature in one PR.

## Shared Constraints

These constraints apply to ALL phases:

- **Mirror dashboard precedent**: This work is a deliberate port of `pipeline_dashboard`'s multi-repo machinery onto `project_hygiene`. Where in doubt, copy the dashboard pattern verbatim — same parameter names, same response shapes, same threshold semantics.
- **Backward compatibility**: Single-project, single-repo callers MUST see byte-identical responses. Specifically: when `projectNumbers` is omitted and items span <2 repos, the JSON response shape and markdown output must be unchanged from the pre-change behavior.
- **Reuse, don't duplicate**: `groupDashboardItemsByRepo` (`lib/dashboard.ts:1043`) and `fetchDashboardItems` (`lib/dashboard-fetch.ts:225`) are already exported and intended for reuse. Do not re-implement the Map-based grouping or the per-project fetch loop.
- **Pure-function discipline**: `lib/hygiene.ts` must remain side-effect-free. All GraphQL / I/O lives in `tools/hygiene-tools.ts`. The `repoBreakdowns` computation goes inside `buildHygieneReport()`, not the tool layer.
- **`(unknown)` repo bucket**: Items missing `repository` fall under the `"(unknown)"` key, matching `groupDashboardItemsByRepo` behavior. Do not invent a different sentinel.
- **2+ repos threshold**: `repoBreakdowns` is emitted only when `repoGroups.size >= 2`. Below that, it is `undefined` (omitted from the response). This matches `buildDashboard` at `lib/dashboard.ts:781`.
- **TypeScript strict mode** is the only quality gate; `npm run build` and `npm test` are the verification commands. No lint step exists.
- **ESM imports**: All internal imports use `.js` extensions (e.g., `import { ... } from "./dashboard.js"`).

## Current State Analysis

`pipeline_dashboard` has full multi-repo support: it accepts `projectNumbers`, supports `groupBy: "repo"`, and auto-emits `repoBreakdowns` when items span 2+ repos. The dashboard fetch path has been factored into a reusable helper (`fetchDashboardItems` in `lib/dashboard-fetch.ts`) precisely so other tools can adopt it.

`project_hygiene` does none of this:

1. **`HygieneItem` type** (`lib/hygiene.ts:31-36`) has no `repository` field. `toHygieneItem()` (`lib/hygiene.ts:78-85`) discards `item.repository` even though `toDashboardItems` populated it.
2. **Tool schema** (`tools/hygiene-tools.ts:40-82`) has no `projectNumbers` parameter and no `groupBy` parameter. The fetch loop (`hygiene-tools.ts:103-113`) hits `client.config.projectNumber` directly and calls `toDashboardItems(result.nodes)` without the `(projectNumber, projectTitle)` arguments.
3. **`HygieneReport`** (`lib/hygiene.ts:43-65`) has no `repoBreakdowns` field. The markdown formatter has no per-repo sections.
4. **No `groupBy: "repo"` rendering branch** exists.

The upstream raw-item GraphQL data is correct (the dashboard query already returns `repository.nameWithOwner`), so this is purely a downstream plumbing fix.

## Desired End State

After the four phases:

- `HygieneItem` carries `repository?: string` end-to-end.
- `ralph_hero__project_hygiene` accepts `projectNumbers?: number[]` and aggregates across all listed projects, with per-project failure warnings non-fatal.
- When merged items span 2+ repos, `HygieneReport.repoBreakdowns: Record<string, HygieneRepoBreakdown>` is auto-populated and the markdown formatter emits a `## Per-Repository Breakdown` section.
- When called with `groupBy: "repo"`, the tool returns `{ groupBy: "repo", repos: Record<string, HygieneReport> }` (JSON) or one `## owner/repo` heading per repo (markdown).
- All existing single-project / single-repo callers see byte-identical responses (no shape regression).

### Verification

- [ ] `HygieneItem.repository` is preserved by every section function (archive, stale, orphan, field gaps, WIP, duplicates).
- [ ] `projectNumbers: [3, 5]` produces a merged report with items from both projects.
- [ ] A 2-repo input yields `repoBreakdowns` with one entry per repo and a `## Per-Repository Breakdown` markdown section.
- [ ] A 1-repo input yields `repoBreakdowns: undefined` and unchanged markdown (regression-safe).
- [ ] `groupBy: "repo"` yields `{ groupBy: "repo", repos: { ... } }` JSON and one `## owner/repo` heading per repo in markdown.
- [ ] `groupBy: "repo"` combined with `projectNumbers` works (multi-project, multi-repo).

## What We're NOT Doing

- **Not touching `HygieneReport` shape outside the optional `repoBreakdowns` field** — no changes to `archiveCandidates`, `staleItems`, `orphanedItems`, `fieldGaps`, `wipViolations`, `duplicateCandidates`, or `summary`.
- **Not changing GraphQL queries** — `DASHBOARD_ITEMS_QUERY` already returns `repository.nameWithOwner`; nothing more is needed.
- **Not implementing cross-repo duplicate detection logic** — the open question from the research doc ("should hygiene support cross-repo duplicate detection?") is deferred. Duplicate detection continues to operate on the merged item set; per-repo `repoBreakdowns` will simply re-run `findDuplicateCandidates` on each per-repo subset. No new heuristic.
- **Not implementing per-repo WIP limits** — the second open question ("per-repo WIP limits separate from global?") is deferred. `wipLimits` remains a flat `Record<string, number>` keyed by state, applied identically to global and per-repo runs.
- **Not adding ASCII format** to hygiene — hygiene only supports `json` and `markdown`. Don't add `ascii` to keep scope tight.
- **Not changing `archiveDays`/`staleDays`/`orphanDays`/`similarityThreshold` semantics** — these continue to apply uniformly across all repos and projects.

## Implementation Approach

The phases form a strict topological chain — each one is a prerequisite for the next:

1. **Phase 1 (data plumbing)**: Add `repository` to `HygieneItem` and propagate it through `toHygieneItem()`. No tool schema changes. No formatter changes. This unblocks every later phase that needs to group items by repo.
2. **Phase 2 (multi-project ingest)**: Replace the inline single-project fetch in `tools/hygiene-tools.ts` with `fetchDashboardItems()` (the same helper the dashboard tool uses). Add `projectNumbers` schema option. Items now carry `projectNumber`/`projectTitle` AND `repository`.
3. **Phase 3 (auto-aggregation)**: Add `HygieneRepoBreakdown` type + `repoBreakdowns?` field to `HygieneReport`. Update `buildHygieneReport` to compute per-repo breakdowns when `repoGroups.size >= 2`. Append `## Per-Repository Breakdown` to `formatHygieneMarkdown`. Reuses `groupDashboardItemsByRepo`.
4. **Phase 4 (explicit slicing)**: Add `groupBy: "repo"` schema option. When set, build N separate `HygieneReport`s (one per repo) instead of one merged report. JSON shape is `{ groupBy: "repo", repos: { ... } }`, markdown is one `## owner/repo` heading per repo.

**Phase dependency annotations** are below; orchestrators may parallelise later phases that don't actually depend on each other, but Phase 2 strictly needs Phase 1, Phase 3 strictly needs both, and Phase 4 strictly needs Phase 3.

---

## Phase 1: GH-1085 - preserve repository field on HygieneItem

- **depends_on**: null

### Overview

Add `repository?: string` to the `HygieneItem` type and update `toHygieneItem()` to copy `item.repository` from the source `DashboardItem`. No behavior change to flat reports; this is pure plumbing for later phases.

### Tasks

#### Task 1.1: Add `repository` field to `HygieneItem` interface
- **files**: `plugin/ralph-hero/mcp-server/src/lib/hygiene.ts` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] `HygieneItem` interface (around line 31-36) gains `repository?: string` field positioned after `ageDays` (or in the same shape order as `DashboardItem`).
  - [ ] No other type fields change (still `number`, `title`, `workflowState`, `ageDays`).
  - [ ] TypeScript compiles (`npm run build` succeeds).

#### Task 1.2: Propagate `repository` in `toHygieneItem()`
- **files**: `plugin/ralph-hero/mcp-server/src/lib/hygiene.ts` (modify)
- **tdd**: true
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] `toHygieneItem()` (around line 78-85) spreads `repository` through using the `...(item.repository ? { repository: item.repository } : {})` pattern (matching the optional-field style in `lib/dashboard-fetch.ts:115`).
  - [ ] The function signature is unchanged (`(item: DashboardItem, now: number) => HygieneItem`).
  - [ ] When `item.repository` is undefined, the resulting `HygieneItem` has no `repository` key (not `undefined`).

#### Task 1.3: Add tests verifying `repository` flows through every section function
- **files**: `plugin/ralph-hero/mcp-server/src/__tests__/hygiene.test.ts` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [1.2]
- **acceptance**:
  - [ ] New test verifies `findArchiveCandidates` returns items with `repository` populated when input has `repository: "owner/repo"`.
  - [ ] New test verifies `findStaleItems` preserves `repository`.
  - [ ] New test verifies `findOrphanedItems` preserves `repository`.
  - [ ] New test verifies `findFieldGaps` preserves `repository` on both `missingEstimate` and `missingPriority` arrays.
  - [ ] New test verifies `findWipViolations` preserves `repository` on `items[]` inside each violation.
  - [ ] New test verifies `findDuplicateCandidates` preserves `repository` on both items in each pair.
  - [ ] All existing tests still pass — no regression.

### Phase Success Criteria

#### Automated Verification:
- [x] `npm run build` (in `plugin/ralph-hero/mcp-server/`) — no errors
- [x] `npm test` — all tests pass, including the 6 new repository-preservation tests

#### Manual Verification:
- [x] `HygieneItem` type definition includes `repository?: string`
- [x] `toHygieneItem` copies `item.repository` through unchanged

**Creates for next phase**: `HygieneItem` carries repository data end-to-end so Phase 3's per-repo grouping can read it. Phase 2 doesn't strictly need Phase 1 to compile, but completing it first keeps the type consistent across all phases.

---

## Phase 2: GH-1086 - add projectNumbers parameter for multi-project aggregation

- **depends_on**: [phase-1]

### Overview

Replace the inline single-project fetch loop in `tools/hygiene-tools.ts` with a call to the existing `fetchDashboardItems` helper from `lib/dashboard-fetch.ts`. This automatically gives the tool multi-project support, per-project fetch warnings, and `projectNumber`/`projectTitle` propagation onto each item — matching the dashboard tool exactly.

### Tasks

#### Task 2.1: Add `projectNumbers` parameter to tool schema
- **files**: `plugin/ralph-hero/mcp-server/src/tools/hygiene-tools.ts` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] Schema gains `projectNumbers: z.array(z.coerce.number()).optional().describe("Project numbers to include. Defaults to RALPH_GH_PROJECT_NUMBERS or single configured project.")` (matching `dashboard-tools.ts:59-64` verbatim).
  - [ ] The new param is documented adjacent to `owner` for discoverability.

#### Task 2.2: Replace inline fetch with `fetchDashboardItems` helper
- **files**: `plugin/ralph-hero/mcp-server/src/tools/hygiene-tools.ts` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [2.1]
- **acceptance**:
  - [ ] Imports updated: drop `paginateConnection`, `ensureFieldCache`, `DASHBOARD_ITEMS_QUERY`, `RawDashboardItem` (no longer needed); add `fetchDashboardItems` from `../lib/dashboard-fetch.js` and `resolveProjectNumbers` from `../types.js`.
  - [ ] Tool handler resolves project numbers via `args.projectNumbers ?? resolveProjectNumbers(client.config)`.
  - [ ] When the resolved list is empty, returns `toolError("No project numbers configured. Set RALPH_GH_PROJECT_NUMBER or RALPH_GH_PROJECT_NUMBERS.")` — matching the dashboard tool's message verbatim.
  - [ ] Iterates the list and merges results: for each `pn`, calls `fetchDashboardItems(client, fieldCache, pn)` and pushes `items` into a flat `allItems: DashboardItem[]` while collecting `warnings` into `fetchWarnings: string[]`. (Mirror the dashboard-tool branch at `dashboard-tools.ts:176-185`.)
  - [ ] When `args.projectNumbers` is omitted, calls `fetchDashboardItems(client, fieldCache)` once (helper reads the configured list internally).
  - [ ] `buildHygieneReport(allItems, hygieneConfig)` is called on the merged set.
  - [ ] When `fetchWarnings.length > 0`, response includes `fetchWarnings: string[]` field (mirror dashboard tool at `dashboard-tools.ts:281`).
  - [ ] Existing single-project response shape is byte-identical when `projectNumbers` is omitted and only one project is configured (no `fetchWarnings` key when array is empty).

#### Task 2.3: Add multi-project test
- **files**: `plugin/ralph-hero/mcp-server/src/__tests__/hygiene.test.ts` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [2.2]
- **acceptance**:
  - [ ] New test in the `buildHygieneReport` describe block that constructs a 2-project input (items tagged `projectNumber: 3` and `projectNumber: 5`) and asserts all 6 sections aggregate items from both projects.
  - [ ] Test asserts `report.totalItems` equals the sum of items across projects.
  - [ ] Test does NOT exercise the tool layer — `buildHygieneReport` is a pure function and the multi-project merge happens before it. (The fetch-loop integration is covered by the existing dashboard-tool tests for `fetchDashboardItems`; we don't duplicate that mocking work.)

### Phase Success Criteria

#### Automated Verification:
- [ ] `npm run build` — no errors
- [ ] `npm test` — all tests pass

#### Manual Verification:
- [ ] Tool schema documents `projectNumbers`
- [ ] When `RALPH_GH_PROJECT_NUMBERS=3,5` is set in env, calling the tool with no args fetches both projects (sanity-check via REPL or the live CLI).

**Creates for next phase**: `allItems` now carries `projectNumber` AND `repository` fields, ready for `groupDashboardItemsByRepo` in Phase 3.

---

## Phase 3: GH-1087 - auto-compute repoBreakdowns and render per-repo markdown sections

- **depends_on**: [phase-1, phase-2]

### Overview

Add per-repo breakdowns to `HygieneReport` (mirroring `DashboardData.repoBreakdowns`) and render them in the markdown formatter. The breakdowns are auto-computed inside `buildHygieneReport()` whenever items span 2+ repos.

### Tasks

#### Task 3.1: Define `HygieneRepoBreakdown` type
- **files**: `plugin/ralph-hero/mcp-server/src/lib/hygiene.ts` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] New exported `HygieneRepoBreakdown` interface containing: `repoName: string`, plus the same six section fields as `HygieneReport` (`archiveCandidates`, `staleItems`, `orphanedItems`, `fieldGaps`, `wipViolations`, `duplicateCandidates`), plus the same `summary` shape.
  - [ ] Equivalent shape choice: alternatively, define `HygieneRepoBreakdown` as `{ repoName: string } & Omit<HygieneReport, "generatedAt" | "totalItems" | "repoBreakdowns">` to avoid duplicating the field list. Either approach is acceptable as long as the runtime shape is the same.

#### Task 3.2: Add `repoBreakdowns?` to `HygieneReport`
- **files**: `plugin/ralph-hero/mcp-server/src/lib/hygiene.ts` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [3.1]
- **acceptance**:
  - [ ] `HygieneReport` gains optional `repoBreakdowns?: Record<string, HygieneRepoBreakdown>` field.
  - [ ] No existing fields renamed or removed.

#### Task 3.3: Compute `repoBreakdowns` in `buildHygieneReport`
- **files**: `plugin/ralph-hero/mcp-server/src/lib/hygiene.ts` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [3.2]
- **acceptance**:
  - [ ] Imports `groupDashboardItemsByRepo` from `./dashboard.js`.
  - [ ] After computing the merged report, `buildHygieneReport` calls `groupDashboardItemsByRepo(items)`. If the resulting map has `>= 2` entries, it computes `repoBreakdowns` by recursively running each section function over each repo's items (use a small helper or inline the six `find*` calls — do NOT recursively call `buildHygieneReport` itself, to avoid emitting nested `repoBreakdowns`).
  - [ ] Per-repo `summary` is computed identically to the global one (counts derived from each section's length, `fieldCoveragePercent` recomputed against per-repo non-terminal items).
  - [ ] When `repoGroups.size < 2`, `repoBreakdowns` is omitted from the response (`undefined`, conditional spread `...(repoBreakdowns ? { repoBreakdowns } : {})`).
  - [ ] Keys in `repoBreakdowns` are repo `nameWithOwner` strings, matching `groupDashboardItemsByRepo` output (including `"(unknown)"` if any items lack repository).

#### Task 3.4: Render `## Per-Repository Breakdown` in markdown formatter
- **files**: `plugin/ralph-hero/mcp-server/src/lib/hygiene.ts` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [3.3]
- **acceptance**:
  - [ ] `formatHygieneMarkdown` appends a `## Per-Repository Breakdown` section after the existing `## Duplicate Candidates` section, only when `report.repoBreakdowns` is defined and has `>= 2` keys.
  - [ ] Each repo gets a `### owner/repo` sub-section, sorted alphabetically by repo name (matching dashboard at `dashboard.ts:956-958`).
  - [ ] Each per-repo sub-section renders only the non-empty section tables (skip a section if its array is empty), reusing the same `formatItemRow` helper and the same column headers as the global flat report.
  - [ ] When `repoBreakdowns` is `undefined`, the markdown output is byte-identical to the pre-Phase-3 output. Add an explicit regression test for this.

#### Task 3.5: Add tests for repoBreakdowns
- **files**: `plugin/ralph-hero/mcp-server/src/__tests__/hygiene.test.ts` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [3.4]
- **acceptance**:
  - [ ] Test: single-repo input (all items have same `repository`) produces `report.repoBreakdowns === undefined`.
  - [ ] Test: 2-repo input produces `report.repoBreakdowns` with exactly 2 keys, matching the input repo names.
  - [ ] Test: each per-repo breakdown contains only items from that repo (correct partitioning).
  - [ ] Test: items with no `repository` are bucketed under `"(unknown)"` when at least one other repo is present.
  - [ ] Test: `formatHygieneMarkdown` output for single-repo input does not contain `"Per-Repository Breakdown"` (regression-safe).
  - [ ] Test: `formatHygieneMarkdown` output for 2-repo input contains `## Per-Repository Breakdown` and one `### owner/repo` heading per repo.

### Phase Success Criteria

#### Automated Verification:
- [ ] `npm run build` — no errors
- [ ] `npm test` — all tests pass, including the new repoBreakdowns tests

#### Manual Verification:
- [ ] Live invocation with multi-repo project shows `## Per-Repository Breakdown` in markdown
- [ ] Single-repo invocation output unchanged (compare before/after)

**Creates for next phase**: `repoBreakdowns` is the *implicit* per-repo view. Phase 4 layers an *explicit* `groupBy: "repo"` mode on top, returning N separate `HygieneReport`s instead of one merged report with breakdowns appended.

---

## Phase 4: GH-1088 - add groupBy=repo parameter for explicit per-repo sub-reports

- **depends_on**: [phase-3]

### Overview

Add a `groupBy: "repo"` schema option to `ralph_hero__project_hygiene`. When set, the tool early-returns N separate `HygieneReport`s (one per repo group) instead of computing a single merged report. Mirrors `pipeline_dashboard`'s `groupBy: "repo"` branch at `dashboard-tools.ts:219-249`.

### Tasks

#### Task 4.1: Add `groupBy` schema option
- **files**: `plugin/ralph-hero/mcp-server/src/tools/hygiene-tools.ts` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] Schema gains `groupBy: z.enum(["repo"]).optional().describe("Group hygiene output by dimension. 'repo' returns one full hygiene sub-report per repository within the project.")` (mirror `dashboard-tools.ts:144-149`).
  - [ ] Schema description hints at the response-shape change (so callers know they get `{ groupBy: "repo", repos: ... }` rather than the flat report).

#### Task 4.2: Implement groupBy=repo branch (JSON)
- **files**: `plugin/ralph-hero/mcp-server/src/tools/hygiene-tools.ts` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [4.1]
- **acceptance**:
  - [ ] Imports `groupDashboardItemsByRepo` from `../lib/dashboard.js`.
  - [ ] Before calling `buildHygieneReport(allItems, ...)`, the handler checks `if (args.groupBy === "repo")`.
  - [ ] When set, calls `groupDashboardItemsByRepo(allItems)`, then for each `[repoName, repoItems]` calls `buildHygieneReport(repoItems, hygieneConfig)` and assembles `repoResults: Record<string, HygieneReport>`.
  - [ ] JSON response shape: `toolSuccess({ groupBy: "repo", repos: repoResults, ...(fetchWarnings.length > 0 ? { fetchWarnings } : {}) })`.
  - [ ] Items missing `repository` fall under `"(unknown)"` (delegated to `groupDashboardItemsByRepo` — verify this is the case).
  - [ ] When `groupBy` is omitted, the existing merged-report path is taken (no behavior change for existing callers).

#### Task 4.3: Implement groupBy=repo branch (markdown)
- **files**: `plugin/ralph-hero/mcp-server/src/tools/hygiene-tools.ts` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [4.2]
- **acceptance**:
  - [ ] When `args.groupBy === "repo"` AND `args.format === "markdown"`, the handler emits a single string starting with `# Project Hygiene (by repo)\n\n` followed by per-repo sections.
  - [ ] Each repo section: `## owner/repo (N items)\n\n` + `formatHygieneMarkdown(perRepoReport) + "\n\n"`.
  - [ ] Repos rendered in sorted order (alphabetical by repo name) for deterministic output.
  - [ ] Returns `toolSuccess({ markdown: combinedString, ...(fetchWarnings.length > 0 ? { fetchWarnings } : {}) })`.

#### Task 4.4: Add groupBy combo tests
- **files**: `plugin/ralph-hero/mcp-server/src/__tests__/hygiene.test.ts` (or new `hygiene-tools.test.ts`) (modify or create)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [4.3]
- **acceptance**:
  - [ ] Test: pure-function shape — given a 2-repo `DashboardItem[]`, `groupDashboardItemsByRepo` + `buildHygieneReport` per group produces a `Record<string, HygieneReport>` with one entry per repo. (No tool-layer mocking required — exercise the composition the tool will perform.)
  - [ ] Test: items with no `repository` land in the `"(unknown)"` group.
  - [ ] Test: each per-repo `HygieneReport` contains only that repo's items in every section.
  - [ ] Test: markdown composition produces one `## owner/repo` heading per repo (string-contains assertion).
  - [ ] Test: when `groupBy` is omitted, response uses the existing merged shape (regression covered by Phase 3 tests, just confirm no regression here).

### Phase Success Criteria

#### Automated Verification:
- [ ] `npm run build` — no errors
- [ ] `npm test` — all tests pass

#### Manual Verification:
- [ ] Live invocation with `groupBy: "repo"` returns `{ groupBy: "repo", repos: { ... } }` JSON
- [ ] Live invocation with `groupBy: "repo"` and `format: "markdown"` returns one heading per repo
- [ ] Combined call with `projectNumbers: [3, 5]` and `groupBy: "repo"` aggregates across both projects, then splits by repo

**Creates for next phase**: None — this is the final feature phase. The four phases together close out parent issue #563.

---

## Integration Testing

- [ ] End-to-end: live call with `RALPH_GH_PROJECT_NUMBER=3` and a single-repo board produces a response byte-identical to the pre-change tool (run before/after diff).
- [ ] End-to-end: live call with `RALPH_GH_PROJECT_NUMBERS=3,5` (multi-project, multi-repo) produces a merged report with `repoBreakdowns` populated.
- [ ] End-to-end: live call with `groupBy: "repo"` returns one sub-report per repo.
- [ ] All existing hygiene tests in `hygiene.test.ts` continue to pass without modification.
- [ ] `npm run build` and `npm test` from `plugin/ralph-hero/mcp-server/` both succeed.

## References

- Parent issue: https://github.com/cdubiel08/ralph-hero/issues/563
- GH-1085: https://github.com/cdubiel08/ralph-hero/issues/1085
- GH-1086: https://github.com/cdubiel08/ralph-hero/issues/1086
- GH-1087: https://github.com/cdubiel08/ralph-hero/issues/1087
- GH-1088: https://github.com/cdubiel08/ralph-hero/issues/1088
- Research: thoughts/shared/research/2026-03-14-hygiene-pipeline-multi-repo-aggregation.md
- Dashboard precedent (multi-project): `plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts:151-193`
- Dashboard precedent (groupBy=repo): `plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts:219-249`
- Dashboard precedent (auto repoBreakdowns): `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts:766-792`
- Dashboard precedent (markdown per-repo): `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts:948-991`
- Reusable helpers: `groupDashboardItemsByRepo` (`lib/dashboard.ts:1043`), `fetchDashboardItems` (`lib/dashboard-fetch.ts:225`)
