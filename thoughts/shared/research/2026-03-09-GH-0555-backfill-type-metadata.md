---
date: 2026-03-09
github_issue: 555
github_url: https://github.com/cdubiel08/ralph-hero/issues/555
status: complete
type: research
tags: [knowledge-graph, metadata, backfill, frontmatter, indexer]
---

# Research: Backfill Existing Documents with Type Metadata

## Prior Work

- builds_on:: [[2026-03-09-GH-0549-knowledge-metadata-alignment]]
- builds_on:: [[2026-03-08-knowledge-graph-design]]
- builds_on:: [[2026-03-08-knowledge-graph-impl]]

## Problem Statement

The ralph-knowledge indexer uses the `type:` frontmatter field to enable `knowledge_search(type=...)` filtering. Currently, the majority of existing documents either lack a `type:` field or use an outdated value (`type: critique` instead of `type: review`). This makes the knowledge graph largely non-functional for type-based discovery.

GH-555 is Phase 6 of the parent plan (GH-549), which prescribes one-time bash commands to fix this across reviews, plans, and ideas directories, then reindex.

## Current State Analysis

### Document Inventory

| Directory | Total Docs | Have `type:` | Missing `type:` | Notes |
|-----------|-----------|-------------|-----------------|-------|
| `thoughts/shared/reviews/` | 60 | 60 (all `critique`) | 0 | All need `critique` -> `review` rename |
| `thoughts/shared/plans/` | 180 | 18 | 162 | 13 of the 18 have non-`plan` types (see below) |
| `thoughts/shared/ideas/` | 2 | 0 | 2 | 1 doc has no YAML frontmatter at all |
| `thoughts/shared/research/` | 192 | 191 | 1 | 2 docs have non-standard types (`reference`, `documentation`) |
| `thoughts/shared/reports/` | 18 | 1 | 17 | Out of scope per issue definition |

### Review Documents (60 files)

All 60 review documents have `type: critique` in their YAML frontmatter. The rename is a clean `sed -i 's/^type: critique$/type: review/'` with zero ambiguity. No review docs already use `type: review`, so there is no collision risk.

### Plan Documents (180 files)

162 plan documents lack any `type:` field. The parent plan proposes inserting `type: plan` after the `status:` line using `sed`.

**Edge cases discovered:**

1. **1 plan doc has no YAML frontmatter at all**: `thoughts/shared/plans/2026-02-20-ralph-team-worker-redesign.md` uses markdown-style metadata (`**Date**: ...`, `**Status**: Draft`) instead of YAML frontmatter. The `sed '/^status:/a type: plan'` approach will skip this file silently because there is no `^status:` line to anchor on. This is acceptable -- the doc is a legacy format and would need manual attention regardless.

2. **13 plan docs have non-`plan` type values** already set. These should NOT be overwritten:
   - `type: design` (1 doc) -- `2026-02-17-GH-0044-worker-scope-boundaries-design.md`
   - `type: feature` (4 docs) -- early architecture plans
   - `type: review` / `type: critique` (3 docs) -- review docs mis-filed in plans directory
   - `type: epic` (1 doc) -- `2026-02-17-ralph-hero-v3-architecture-epic.md`
   - `type: spec` / `type: architecture-spec` (2 docs) -- spec documents
   - `type: parent-plan` (1 doc) -- `2026-03-02-group-GH-0000-enforcement-gap-remediation.md`
   - `type: plan` (5 docs) -- already correct

   The sed approach in the parent plan correctly handles this because it only inserts `type: plan` into docs that are MISSING the `type:` field. Docs that already have any `type:` value will be left untouched.

3. **The 3 plan-dir docs with `type: critique`** are review documents that were placed in the wrong directory (they are v3-era review files like `plan-1-review-critique.md`). The global `sed` for reviews will NOT touch them because it only targets `thoughts/shared/reviews/`. These misplaced files will keep their current type, which is arguably correct since they ARE critiques/reviews even though they live in the plans directory. This is an acceptable state.

### Idea Documents (2 files)

1. **`2026-03-01-hello-session-briefing.md`**: Has YAML frontmatter with `status: formed` but no `type:` field. The sed approach (`/^status:/a type: idea`) will work correctly.

2. **`2026-02-25-idea-hunt-synthesis.md`**: Has NO YAML frontmatter at all. Uses plain markdown with a `# ` title and `**Date:**` style metadata. The sed approach will skip this file silently (no `^---` match, no `^status:` line). This document would need manual frontmatter addition, which is out of scope for an automated backfill.

### Research Documents (out of scope but noted)

191 of 192 research docs already have `type: research`. Only `2026-02-18-GH-0066-github-projects-v2-docs-guidance.md` is missing `type:`. Two docs have non-standard types: `golden-project-views.md` (`type: reference`) and `view-recipes.md` (`type: documentation`). The issue scope explicitly excludes research docs from the backfill, and the gap is minimal (1 doc out of 192).

### Report Documents (out of scope)

17 of 18 report docs are missing `type:`. This is explicitly out of scope per the issue definition.

## Dependency Analysis

### Phase 4 (GH-553): Hook and Spec Update

The `review-verify-doc.sh` hook currently enforces `type: critique` on line 33:
```bash
if ! head -20 "$file_path" | grep -q "^type: critique"; then
  block "Critique missing 'type: critique' in frontmatter: $file_path"
```

**Critical ordering constraint**: If Phase 6 (backfill) runs BEFORE Phase 4 (hook update), existing review documents will have `type: review` but the hook will still demand `type: critique`. This means any future `ralph_review` runs will fail validation against the old hook while trying to read backfilled docs. However, the hook only fires on new document writes (PostToolUse for Write), not on reads of existing docs. So the actual risk is: if the hook runs AFTER Phase 6 but BEFORE Phase 4, new review docs would need `type: review` (matching the skill template from Phase 2), but the hook would reject them. This confirms Phase 4 must complete before Phase 6.

The specs `artifact-metadata.md` (line 74) and `document-protocols.md` (lines 95, 107) reference `type: critique` and need updating in Phase 4.

### Phase 5 (GH-554): Indexer Update

The parser at `plugin/ralph-knowledge/src/parser.ts:60` currently reads only `github_issue` (singular):
```typescript
githubIssue: typeof frontmatter.github_issue === "number" ? frontmatter.github_issue : null,
```

There is no `github_issues` fallback yet. Phase 5 must add the fallback chain before the reindex in Phase 6, otherwise plan documents that only have `github_issues` (array) will not be linked to their issues in the knowledge graph. However, the `type:` backfill itself does not depend on this -- the reindex will correctly populate `type` fields regardless. The `github_issues` fallback only matters for plan-issue linkage.

**Conclusion**: Phase 6 should run after both Phases 4 and 5 as the issue body states, but the `type:` backfill operations (Steps A-C) are independent of both. Only the reindex step (Step D) depends on Phase 5 for full benefit.

## Approach Evaluation

### Approach 1: Parent Plan's Bash Commands (Recommended)

The parent plan prescribes simple `sed` and `find` commands run as one-time operations.

**Pros:**
- Simple, auditable, reversible (git revert)
- Handles the 95% case correctly
- Matches the tool (sed) to the job (text substitution in YAML frontmatter)

**Cons:**
- Silently skips 2 edge-case files (no YAML frontmatter)
- Does not handle plan docs with non-`plan` types (but shouldn't -- they have intentional types)

**Verdict**: The parent plan's approach is sound. The edge cases are acceptable losses.

### Approach 2: Python/Node Script with YAML Parser

A script that properly parses YAML frontmatter, applies type logic based on directory, and rewrites.

**Pros:**
- Handles all edge cases including frontmatter-less files
- Can add frontmatter to files that lack it
- Type-safe YAML manipulation

**Cons:**
- Overkill for a one-time operation
- Risk of YAML parser reformatting (e.g., changing quote styles, reordering fields)
- More code to review and debug

**Verdict**: Not recommended. The complexity is not justified.

## Risks

1. **Low risk -- Silent skips**: 2 documents (1 plan, 1 idea) lack YAML frontmatter and will be silently skipped. These are legacy-format docs that should eventually be manually migrated. The impact is 2 documents out of 454 total remain undiscoverable by type.

2. **Low risk -- Non-plan types in plans directory**: 13 plan docs have intentionally non-`plan` types. The sed approach correctly ignores these because it only targets docs missing `type:`. No data corruption risk.

3. **Medium risk -- Hook ordering**: If the backfill runs before the hook update (Phase 4), the `review-verify-doc.sh` hook will enforce `type: critique` on new review docs while existing ones already say `type: review`. This is a temporary inconsistency that could confuse developers. Mitigation: enforce Phase 4 before Phase 6 ordering via the `blockedBy` relationship.

4. **Low risk -- Reindex without Phase 5**: If reindex runs before the indexer update (Phase 5), `type` filtering will work but `githubIssue` linkage for plans will be incomplete. This is a partial-benefit scenario, not a failure. Mitigation: ensure Phase 5 merges before Phase 6 reindex.

5. **No risk -- Sed idempotency**: Running the backfill twice is safe. `sed 's/^type: critique$/type: review/'` on a file already containing `type: review` is a no-op. The `type: plan` insertion check (`grep -q "^type:"`) prevents double-insertion.

## Recommended Implementation

Follow the parent plan's Phase 6 approach with these refinements:

1. **Step A (reviews)**: Use `find ... -exec sed -i 's/^type: critique$/type: review/' {} +` as prescribed
2. **Step B (plans)**: Use the for-loop with `head -20` guard as prescribed. The `status:` anchor is reliable (179/180 plan docs have it; the 1 exception has no YAML frontmatter and will be skipped)
3. **Step C (ideas)**: Same approach as Step B. The 1 idea doc with frontmatter will get `type: idea`; the 1 without frontmatter will be skipped
4. **Step D (reindex)**: Run after confirming Phases 4 and 5 are merged
5. **Verification**: Run the acceptance criteria checks from the issue body
6. **Commit**: Stage all three directories and commit with the prescribed message

**Estimated effort**: XS -- under 30 minutes for execution and verification.

## Files Affected

### Will Modify
- `thoughts/shared/reviews/*.md` (60 files) -- `type: critique` -> `type: review`
- `thoughts/shared/plans/*.md` (~162 files) -- insert `type: plan` after `status:` where missing
- `thoughts/shared/ideas/2026-03-01-hello-session-briefing.md` -- insert `type: idea` after `status:`

### Will Read (Dependencies)
- `plugin/ralph-hero/hooks/scripts/review-verify-doc.sh` -- must be updated to `type: review` first (Phase 4, GH-553)
- `plugin/ralph-knowledge/src/parser.ts` -- must have `github_issues` fallback first (Phase 5, GH-554)
- `plugin/ralph-knowledge/src/reindex.ts` -- used for reindexing after backfill
- `specs/artifact-metadata.md` -- references `type: critique` (updated in Phase 4)
- `specs/document-protocols.md` -- references `type: critique` (updated in Phase 4)
