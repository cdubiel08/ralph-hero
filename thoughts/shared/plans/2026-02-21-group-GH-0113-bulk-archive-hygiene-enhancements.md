---
date: 2026-02-21
status: draft
github_issues: [113, 114, 155, 157, 159]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/113
  - https://github.com/cdubiel08/ralph-hero/issues/114
  - https://github.com/cdubiel08/ralph-hero/issues/155
  - https://github.com/cdubiel08/ralph-hero/issues/157
  - https://github.com/cdubiel08/ralph-hero/issues/159
primary_issue: 113
---

# Bulk Archive & Hygiene Enhancements - Atomic Implementation Plan

## Overview
3 related issues for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-155 | Add `dryRun` mode to `bulk_archive` | XS |
| 2 | GH-157 | Add `updatedBefore` date filter to `bulk_archive` | XS |
| 3 | GH-159 | Add duplicate candidate detection to `project_hygiene` via fuzzy title matching | XS |

**Why grouped**: GH-155 and GH-157 are sibling sub-issues under GH-113 (`bulk_archive` parent tracker), both modifying `project-management-tools.ts`. GH-159 is the sole remaining sub-issue under GH-114 (`project_hygiene` parent tracker). All three are under Epic #96 (Project Hygiene & Smart Auto-Archive) and complete the remaining work for both parent trackers. Phases 1-2 share the same file; Phase 3 is independent but grouped for a single PR to close out the epic's remaining leaf work.

## Current State Analysis

### bulk_archive (GH-113)
The core `bulk_archive` tool is implemented ([project-management-tools.ts:1157-1293](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts#L1157-L1293)). It accepts `workflowStates` and `maxItems`, queries project items via paginated GraphQL, filters by workflow state, and executes batched `archiveProjectV2Item` mutations in chunks of 50. Two features remain: dry-run preview (#155) and date-based filtering (#157).

### project_hygiene (GH-114)
The core `project_hygiene` tool is implemented with 6 report sections in a two-layer architecture: pure functions in [lib/hygiene.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/hygiene.ts) and I/O layer in [tools/hygiene-tools.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/hygiene-tools.ts). One feature remains: duplicate candidate detection via fuzzy title matching (#159).

### Existing Patterns
- **dryRun**: `sync_across_projects` in [sync-tools.ts:220-224](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/sync-tools.ts#L220-L224) uses `dryRun: z.boolean().optional().default(false)` with a conditional skip of mutations when true.
- **Date comparison**: [hygiene.ts:62-67](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/hygiene.ts#L62-L67) uses `ageDays()` helper for timestamp comparison.
- **Hygiene sections**: All existing sections follow the pattern of a pure function in `hygiene.ts` that takes `DashboardItem[]` + config and returns typed results, wired by `buildHygieneReport()`.

## Desired End State
### Verification
- [ ] `bulk_archive` accepts `dryRun` boolean, returns preview without executing mutations when true
- [ ] `bulk_archive` accepts `updatedBefore` ISO date string, filters items by `updatedAt < cutoff`
- [ ] `bulk_archive` composes `workflowStates` and `updatedBefore` with AND logic
- [ ] `project_hygiene` includes a "Duplicate Candidates" section with fuzzy title matching
- [ ] `project_hygiene` accepts `similarityThreshold` parameter (default 0.8)
- [ ] All existing tests pass, new tests cover all three features
- [ ] `npm run build` succeeds with no type errors

## What We're NOT Doing
- No `bulk_unarchive` tool (separate future work)
- No `@today-Nd` date-math syntax for `updatedBefore` (GH-105 scope)
- No external npm dependency for fuzzy matching (Levenshtein implemented in-house)
- No automatic dedup/closing from duplicate detection (future work)
- No changes to `batch-tools.ts` or `buildBatchArchiveMutation`

## Implementation Approach
Phase 1 adds dryRun to bulk_archive (no GraphQL changes, just a conditional before the mutation loop). Phase 2 extends the GraphQL query to fetch `updatedAt` and adds date filtering (composable with Phase 1's dryRun). Phase 3 is independent, adding a new section to the hygiene report. All phases are backward-compatible (new optional params with defaults preserving existing behavior).

---

## Phase 1: GH-155 — Add `dryRun` mode to `bulk_archive`
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/155 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-GH-0113-bulk-archive-remaining-enhancements.md

### Changes Required

#### 1. Add `dryRun` parameter to tool schema
**File**: `plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts`
**Changes**: Add `dryRun: z.boolean().optional().default(false).describe(...)` to the `bulk_archive` tool schema (after `maxItems`, around line 1175). Follow the `sync_across_projects` pattern from `sync-tools.ts:220-224`.

#### 2. Add conditional before mutation loop
**File**: `plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts`
**Changes**: After the filter + slice phase (line 1240), before the "no matches" early return (line 1242), add a conditional: if `args.dryRun` is true, return early with `{ dryRun: true, wouldArchive: matched.length, items: matched.map(m => ({ number: m.content?.number, title: m.content?.title, itemId: m.id })), errors: [] }`. When `dryRun` is false, execution continues to the existing mutation loop unchanged.

#### 3. Include `dryRun` flag in normal response
**File**: `plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts`
**Changes**: Add `dryRun: false` to the normal (non-dry-run) success response at line 1283 for response shape consistency.

#### 4. Add dryRun tests
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/bulk-archive.test.ts`
**Changes**: Add a new `describe("bulk_archive dryRun")` block with tests:
- `dryRun response includes wouldArchive count and items list` — verify the response shape when constructing a mock dry-run result
- `dryRun flag is false in normal response` — verify the non-dry-run response includes `dryRun: false`
- `dryRun items include number, title, and itemId` — verify item shape

### Success Criteria
- [ ] Automated: `cd plugin/ralph-hero/mcp-server && npm test` passes
- [ ] Automated: `npm run build` succeeds
- [ ] Manual: Calling `bulk_archive` with `dryRun: true` returns items without archiving them

**Creates for next phase**: dryRun can be used to preview `updatedBefore` filtering results in Phase 2.

---

## Phase 2: GH-157 — Add `updatedBefore` date filter to `bulk_archive`
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/157 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-GH-0113-bulk-archive-remaining-enhancements.md | **Depends on**: Phase 1

### Changes Required

#### 1. Add `updatedBefore` parameter to tool schema
**File**: `plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts`
**Changes**: Add `updatedBefore: z.string().optional().describe("ISO 8601 date (UTC). Only archive items with updatedAt before this date. Composable with workflowStates (AND logic).")` to the `bulk_archive` tool schema.

#### 2. Extend GraphQL query to fetch `updatedAt`
**File**: `plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts`
**Changes**: In the GraphQL query at lines 1206-1213, add `updatedAt` to both the Issue and PullRequest fragments:
```graphql
content {
  ... on Issue { number, title, updatedAt }
  ... on PullRequest { number, title, updatedAt }
}
```

#### 3. Extend `RawBulkArchiveItem` type
**File**: `plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts`
**Changes**: At line 1396, extend the `content` type to include `updatedAt?: string`:
```typescript
content: { number?: number; title?: string; updatedAt?: string } | null;
```

#### 4. Add date validation and filtering
**File**: `plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts`
**Changes**: After the workflow state filter (line 1235-1239), before the `.slice()`, add an additional `.filter()` step:
- Parse `args.updatedBefore` with `new Date()`, validate with `isNaN()`, return `toolError("Invalid updatedBefore date. Use ISO 8601 format (e.g., 2026-02-01T00:00:00Z)")` if invalid
- Filter: `item.content?.updatedAt && new Date(item.content.updatedAt).getTime() < cutoff`
- Items with null content (DraftIssues) are excluded from date filtering (no `updatedAt` available)

#### 5. Add date filter tests
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/bulk-archive.test.ts`
**Changes**: Add a new `describe("bulk_archive updatedBefore")` block with tests:
- `date validation rejects invalid dates` — verify `isNaN(new Date("not-a-date").getTime())` is true
- `date validation accepts valid ISO dates` — verify `isNaN(new Date("2026-02-01T00:00:00Z").getTime())` is false
- `date filter composes with workflow state filter` — verify AND logic with mock items: items matching workflow state but updated after cutoff should be excluded
- `items with null content are excluded from date filter` — verify DraftIssue-like items (null content) are not matched

### Success Criteria
- [ ] Automated: `cd plugin/ralph-hero/mcp-server && npm test` passes
- [ ] Automated: `npm run build` succeeds
- [ ] Manual: `bulk_archive` with both `workflowStates` and `updatedBefore` filters correctly

**Creates for next phase**: Nothing (Phase 3 is independent).

---

## Phase 3: GH-159 — Add duplicate candidate detection to `project_hygiene`
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/159 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-GH-0114-project-hygiene-reporting-tool.md

### Changes Required

#### 1. Add `findDuplicateCandidates()` pure function
**File**: `plugin/ralph-hero/mcp-server/src/lib/hygiene.ts`
**Changes**: Add a new section function after `findWipViolations()` (after line 189):

- **Levenshtein distance function**: Implement a standard Levenshtein distance algorithm (~15 lines). The function takes two strings and returns the edit distance as a number.
- **Title normalization function**: `normalizeTitle(title: string): string` — lowercase, strip common prefixes (`Add`, `Create`, `Fix`, `Update`, `Remove`, `Implement`, `Refactor`), remove punctuation (backticks, quotes, colons, parentheses), trim whitespace.
- **Similarity function**: `titleSimilarity(a: string, b: string): number` — normalize both titles, return `1 - (levenshteinDistance(a, b) / Math.max(a.length, b.length))`. Returns 0-1 scale.
- **`findDuplicateCandidates(items, now, threshold)`**: Filter to non-terminal items. Skip pairs where normalized title length difference > 50%. Compare all pairs (O(n^2), acceptable for <= 500 items). Return pairs where similarity >= threshold.

- **New type**: `DuplicateCandidate` interface:
  ```typescript
  export interface DuplicateCandidate {
    items: [HygieneItem, HygieneItem];
    similarity: number; // 0-1
  }
  ```

#### 2. Extend `HygieneReport` type
**File**: `plugin/ralph-hero/mcp-server/src/lib/hygiene.ts`
**Changes**: Add `duplicateCandidates: DuplicateCandidate[]` to the `HygieneReport` interface (after `wipViolations`, around line 48). Add `duplicateCandidateCount: number` to the `summary` object.

#### 3. Wire into `buildHygieneReport()`
**File**: `plugin/ralph-hero/mcp-server/src/lib/hygiene.ts`
**Changes**: In `buildHygieneReport()`, call `findDuplicateCandidates(items, now, config.similarityThreshold)` and include the result in the returned report. Add `duplicateCandidateCount` to the summary.

#### 4. Extend `HygieneConfig`
**File**: `plugin/ralph-hero/mcp-server/src/lib/hygiene.ts`
**Changes**: Add `similarityThreshold: number` (default 0.8) to `HygieneConfig` interface and `DEFAULT_HYGIENE_CONFIG`.

#### 5. Add markdown formatting for duplicates
**File**: `plugin/ralph-hero/mcp-server/src/lib/hygiene.ts`
**Changes**: In `formatHygieneMarkdown()`, add a "Duplicate Candidates" section after WIP violations. For each candidate pair, render a row with both issue numbers, titles, and similarity score (rounded to 2 decimal places). Add `duplicateCandidateCount` to the Summary section output.

#### 6. Add `similarityThreshold` tool parameter
**File**: `plugin/ralph-hero/mcp-server/src/tools/hygiene-tools.ts`
**Changes**: Add `similarityThreshold: z.number().optional().default(0.8).describe("Similarity threshold for duplicate detection (0.5-1.0, default: 0.8)")` to the tool schema. Pass it through to `hygieneConfig`.

#### 7. Add duplicate detection tests
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/hygiene.test.ts`
**Changes**: Add a new `describe("findDuplicateCandidates")` block:
- `detects similar titles` — two items with titles like "Add caching to API" and "Add caching to the API" should match at threshold 0.8
- `ignores dissimilar titles` — "Add caching" and "Fix auth bug" should not match
- `normalizes common prefixes` — "Create bulk_archive tool" and "Implement bulk_archive tool" should match after prefix stripping
- `skips terminal state items` — Done items should be excluded
- `handles short generic titles without false positives` — "Fix bug" items with different contexts should not produce spurious matches (verify with items that have short titles but are genuinely different)
- `respects similarity threshold` — lowering threshold catches more pairs, raising it catches fewer

Add to existing `buildHygieneReport` tests:
- `includes duplicateCandidates in report` — verify the field exists and duplicateCandidateCount matches
- Add `Duplicate Candidates` to `formatHygieneMarkdown` tests

### Success Criteria
- [ ] Automated: `cd plugin/ralph-hero/mcp-server && npm test` passes
- [ ] Automated: `npm run build` succeeds
- [ ] Manual: `project_hygiene` report includes "Duplicate Candidates" section when similar titles exist

**Creates for next phase**: Nothing (final phase).

---

## Integration Testing
- [ ] `npm run build` succeeds with no type errors across all changed files
- [ ] `npm test` passes all existing and new tests
- [ ] `bulk_archive` with `dryRun: true, workflowStates: ["Done"]` returns preview without archiving
- [ ] `bulk_archive` with `workflowStates: ["Done"], updatedBefore: "2026-01-01"` filters by both criteria
- [ ] `bulk_archive` with `dryRun: true, workflowStates: ["Done"], updatedBefore: "2026-01-01"` combines all features
- [ ] `project_hygiene` report includes 7 sections when all have findings
- [ ] `project_hygiene` with custom `similarityThreshold` adjusts duplicate detection sensitivity

## References
- Research (GH-113): https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-GH-0113-bulk-archive-remaining-enhancements.md
- Research (GH-114): https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-GH-0114-project-hygiene-reporting-tool.md
- dryRun pattern: https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/sync-tools.ts#L220-L224
- Existing bulk_archive: https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts#L1157-L1293
- Existing hygiene: https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/hygiene.ts
- Epic: https://github.com/cdubiel08/ralph-hero/issues/96
