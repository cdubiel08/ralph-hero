---
date: 2026-03-09
github_issue: 554
github_url: https://github.com/cdubiel08/ralph-hero/issues/554
status: complete
type: research
tags: [ralph-knowledge, parser, frontmatter, knowledge-graph]
---

# GH-554: Update ralph-knowledge indexer parser to support github_issues array fallback

## Prior Work

- builds_on:: [[2026-03-08-knowledge-graph-design]]
- builds_on:: [[2026-03-09-GH-0549-knowledge-metadata-alignment]]

## Problem Statement

The `parseDocument()` function in `plugin/ralph-knowledge/src/parser.ts` (line 60) only reads the singular `github_issue` frontmatter field:

```typescript
githubIssue: typeof frontmatter.github_issue === "number" ? frontmatter.github_issue : null,
```

However, plan documents produced by ralph-plan and plan (interactive) skills use a different frontmatter convention: `github_issues` (array) and `primary_issue` (integer). Out of ~138 plan documents with `github_issues:` in their frontmatter, only ~34 also include the singular `github_issue:` field. This means the majority of plan documents are indexed with `githubIssue: null`, making them invisible to issue-based lookups in the knowledge graph.

## Current State Analysis

### Frontmatter conventions in the wild

Three distinct patterns exist across `thoughts/shared/plans/`:

1. **Old-style plans** (~34 files): Have `github_issue: NNN` (singular). These work correctly with the current parser.
2. **New-style plans** (~104 files): Have `github_issues: [NNN]` and `primary_issue: NNN` but no singular `github_issue:`. These yield `githubIssue: null` in the index.
3. **Edge cases** (~7 files): Have `github_issues: []` (empty array) or `primary_issue: null`. These should correctly yield `githubIssue: null`.

Research and review documents consistently use `github_issue:` (singular) and are unaffected.

### Parser location and structure

The parser lives at `plugin/ralph-knowledge/src/parser.ts` — this is inside the `ralph-hero` monorepo (under `plugin/ralph-knowledge/`), not a separate external package as the issue body suggested. The npm package name is `ralph-hero-knowledge-index` (per `package.json`).

The `parseDocument()` function:
- Parses YAML frontmatter via the `yaml` package
- Extracts `github_issue` as `number | null` (line 60)
- Returns a `ParsedDocument` interface (line 9-20)
- The `ParsedDocument.githubIssue` field is typed as `number | null`

### Database schema

The `github_issue` column in the `documents` table is `INTEGER` (nullable). The `upsertDocument()` method in `db.ts` maps the `githubIssue` property to the `github_issue` column. No schema change is needed — the column already accepts integers and null.

### Test coverage

The existing `parser.test.ts` has 7 tests but only one that validates `githubIssue` extraction (the `FULL_DOC` fixture with `github_issue: 560`). There are no tests for the `github_issues` array or `primary_issue` fields, because neither is currently supported.

### YAML parsing behavior

The `yaml` package parses `github_issues: [42]` into `{ github_issues: [42] }` (a JavaScript array of numbers) and `primary_issue: 42` into `{ primary_issue: 42 }`. Edge cases:
- `github_issues: []` → empty array (should yield `null` — no element at index 0)
- `primary_issue: null` → JavaScript `null` (should yield `null` — `typeof null !== "number"`)
- `github_issues: [42, 43]` → array of two numbers (should yield `42` — first element)

## Key Discoveries

### 1. Single-line change in parser.ts (line 60)

The fix is a pure fallback chain replacement on line 60 of `parser.ts`. No other files in the parser or DB layer need modification.

**Current** ([parser.ts:60](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/parser.ts#L60)):
```typescript
githubIssue: typeof frontmatter.github_issue === "number" ? frontmatter.github_issue : null,
```

**Proposed**:
```typescript
githubIssue: typeof frontmatter.github_issue === "number"
  ? frontmatter.github_issue
  : Array.isArray(frontmatter.github_issues) && typeof frontmatter.github_issues[0] === "number"
    ? frontmatter.github_issues[0]
    : typeof frontmatter.primary_issue === "number"
      ? frontmatter.primary_issue
      : null,
```

Fallback chain: `github_issue` → `github_issues[0]` → `primary_issue` → `null`

### 2. No type changes needed

The `ParsedDocument` interface (`githubIssue: number | null`) and `DocumentRow` interface (`githubIssue: number | null`) already accommodate the output. The database column (`github_issue INTEGER`) also needs no change.

### 3. No downstream consumers affected

The `githubIssue` field flows through: `parser.ts` → `reindex.ts` → `db.ts` → `search.ts` (not used in queries) / `db.getDocument()`. None of these care about which frontmatter field the value originated from.

### 4. Tool description already correct

The `knowledge_search` tool description in `index.ts` line 37 already lists the correct type vocabulary: `"research, plan, review, idea, report"`. No change needed there (confirming the parent plan's Phase 5 analysis).

### 5. Package is local, not external

The issue body states "Package: `ralph-hero-knowledge-index` (external npm package, not in this repo)" but the source is at `plugin/ralph-knowledge/` within this repo. The implementation, tests, build, and publish can all happen from within the monorepo.

## Potential Approaches

Only one approach is viable — the fallback chain described above. There are no meaningful alternatives:

- **Adding `github_issue:` to all plan templates** is being done in Phases 2-3 of the parent plan (#549), but that only affects future documents. The ~104 existing plans without `github_issue:` still need the parser fallback to be indexed correctly.
- **Backfilling `github_issue:` into existing plans** is explicitly out of scope per the parent plan ("Backfilling `github_issue:` into existing plan documents (indexer fallback handles this)").

## Risks

1. **Low risk — string-typed values in arrays**: If a document has `github_issues: ["42"]` (string instead of number), the `typeof ... === "number"` guard correctly rejects it and falls through to `primary_issue` or `null`. This is safe.
2. **Low risk — empty arrays**: `Array.isArray([]) && typeof [][0] === "number"` evaluates to `false` (because `typeof undefined !== "number"`). Falls through correctly.
3. **No risk — backward compatibility**: The fallback chain tries `github_issue` first, so existing documents that already use the singular field are completely unaffected.

## Recommended Next Steps

1. Update the single line in `parser.ts` (line 60) with the fallback chain
2. Add three new test cases to `parser.test.ts`:
   - Document with only `github_issues: [42]` → yields `githubIssue: 42`
   - Document with only `primary_issue: 42` → yields `githubIssue: 42`
   - Document with `github_issue: 42` (regression guard) → yields `githubIssue: 42` (already covered but worth an explicit named test)
3. Consider adding edge case tests:
   - Document with `github_issues: []` → yields `githubIssue: null`
   - Document with `primary_issue: null` → yields `githubIssue: null`
4. Run `npm test` to verify
5. Publish new version of `ralph-hero-knowledge-index` and reindex to verify plan documents are linked

## Files Affected

### Will Modify
- `plugin/ralph-knowledge/src/parser.ts` - Add fallback chain for `githubIssue` extraction (line 60)
- `plugin/ralph-knowledge/src/__tests__/parser.test.ts` - Add test cases for `github_issues` array and `primary_issue` fallbacks

### Will Read (Dependencies)
- `plugin/ralph-knowledge/src/db.ts` - Confirm `githubIssue` column type (INTEGER, nullable) — no changes needed
- `plugin/ralph-knowledge/src/reindex.ts` - Confirm it passes `parsed.githubIssue` through unchanged — no changes needed
- `plugin/ralph-knowledge/src/index.ts` - Confirm tool description type vocabulary — no changes needed
- `plugin/ralph-knowledge/package.json` - Version bump after implementation
