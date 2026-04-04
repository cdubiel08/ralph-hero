---
date: 2026-04-04
status: draft
type: plan
github_issue: 734
github_issues: [734]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/734
primary_issue: 734
tags: [ralph-knowledge, fts5, sqlite, search, bug]
---

# Fix knowledge_search FTS5 query escaping - Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-04-04-GH-0734-knowledge-search-fts5-escape]]

## Overview
1 issue for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-734 | knowledge_search crashes with "no such column: 730" when query contains bare numbers | S |

## Shared Constraints

- All work in `plugin/ralph-knowledge/` directory
- Build: `npm run build` (tsc), Test: `npm test` (vitest run) from `plugin/ralph-knowledge/`
- ESM module system: imports require `.js` extensions
- The `FtsSearch.search()` method is the single entry point for FTS queries — no other code path needs the fix
- The fix must not break HybridSearch, which calls `fts.search()` with the same raw query string
- Vector search (`VectorSearch`) is unaffected — it uses embedding vectors, not FTS5 query syntax

## Current State Analysis

`FtsSearch.search()` at `search.ts:96-142` passes the raw user query string directly to SQLite FTS5 via `MATCH @query`. Better-sqlite3 parameter binding protects against SQL injection but FTS5 has its own query parser that runs *after* binding. FTS5 interprets `-` as a column negation operator, so `GH-730` becomes `GH` minus column `730` — crashing with "no such column: 730".

No escaping exists anywhere in the chain: `index.ts:46` → `hybrid-search.ts:24` → `search.ts:100`.

## Desired End State
### Verification
- [ ] `knowledge_search(query: "GH-730")` returns results (or empty) without crashing
- [ ] `knowledge_search(query: "implementation plan GH-730 playwright-aware planning")` works
- [ ] Queries with other FTS5 special chars (`*`, `:`, `+`, `(`, `)`, `^`) don't crash
- [ ] Existing search functionality (keyword, type filter, tag filter, superseded filter) still works
- [ ] All tests pass: `npm test` from `plugin/ralph-knowledge/`
- [ ] Build succeeds: `npm run build` from `plugin/ralph-knowledge/`

## What We're NOT Doing
- Not changing the tokenizer configuration (e.g., making hyphens token characters)
- Not adding advanced boolean query syntax for end users (OR/AND support)
- Not changing the vector search path
- Not modifying `hybrid-search.ts` or `index.ts`

## Implementation Approach

Token-level escaping: each whitespace-delimited token in the query is individually wrapped in FTS5 double quotes. This neutralizes special characters within tokens (hyphens, colons, etc.) while preserving multi-term matching semantics. Each token becomes a phrase literal.

The `"cache OR auth"` test at `search.test.ts:71` currently relies on FTS5 `OR` operator. With escaping, `OR` becomes a literal token. This test needs updating to use a query that matches the `auth-doc` directly.

---

## Phase 1: Fix FTS5 query escaping in search.ts + update tests (GH-734)
- **depends_on**: null

### Overview
Add an `escapeFts5Query()` utility to `FtsSearch` that wraps each whitespace token in double quotes, apply it in `search()`, and add tests for problematic query patterns.

### Tasks

#### Task 1.1: Add escapeFts5Query private method to FtsSearch
- **files**: `plugin/ralph-knowledge/src/search.ts` (modify)
- **tdd**: true
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] New private method `escapeFts5Query(raw: string): string` exists on `FtsSearch`
  - [ ] Method splits input on whitespace, filters empty strings, wraps each token in `"..."` with internal `"` doubled to `""`, joins with spaces
  - [ ] `escapeFts5Query("GH-730")` returns `"GH-730"`
  - [ ] `escapeFts5Query("cache OR auth")` returns `"cache" "OR" "auth"`
  - [ ] `escapeFts5Query('say "hello"')` returns `"say" """hello"""`
  - [ ] Empty/whitespace-only input returns empty string `""`

#### Task 1.2: Apply escape in search() method
- **files**: `plugin/ralph-knowledge/src/search.ts` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] Line 100 changes from `{ query, limit }` to `{ query: this.escapeFts5Query(query), limit }`
  - [ ] No other lines in `search()` change
  - [ ] The MATCH clause at line 99 remains `documents_fts MATCH @query`

#### Task 1.3: Update existing "cache OR auth" test
- **files**: `plugin/ralph-knowledge/src/__tests__/search.test.ts` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.2]
- **acceptance**:
  - [ ] Test at line 70-74 ("filters by tags") updated: query changed from `"cache OR auth"` to `"auth"` (which directly matches `auth-doc`), assertion unchanged (`results[0].id === "auth-doc"`)
  - [ ] Test still passes and validates tag filtering behavior

#### Task 1.4: Add test cases for FTS5 special character queries
- **files**: `plugin/ralph-knowledge/src/__tests__/search.test.ts` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.2]
- **acceptance**:
  - [ ] New `describe("FTS5 query escaping")` block added with these test cases:
  - [ ] `"GH-42"` — matches `auth-doc` (githubIssue: 42, but `42` appears in content as part of tokenized issue ref). If no match, returns empty array without throwing
  - [ ] `"cache-strategies"` — matches `cache-doc` (path contains `cache-strategies`)
  - [ ] `"column:injection"` — returns results or empty without throwing (colon is FTS5 column filter)
  - [ ] `"test*"` — returns results or empty without throwing (asterisk is FTS5 prefix wildcard)
  - [ ] `"(grouped)"` — returns results or empty without throwing (parentheses are FTS5 grouping)
  - [ ] All tests assert no exception is thrown and return type is an array

### Phase Success Criteria

#### Automated Verification:
- [ ] `npm run build` from `plugin/ralph-knowledge/` — no errors
- [ ] `npm test` from `plugin/ralph-knowledge/` — all passing

#### Manual Verification:
- [ ] Manually test `knowledge_search(query: "GH-730")` via MCP tool if available

**Creates for next phase**: N/A — single phase plan.

---

## Integration Testing
- [ ] Build succeeds: `cd plugin/ralph-knowledge && npm run build`
- [ ] All tests pass: `cd plugin/ralph-knowledge && npm test`
- [ ] No regressions in existing keyword, type, tag, and superseded filtering

## References
- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-04-GH-0734-knowledge-search-fts5-escape.md
- Issue: https://github.com/cdubiel08/ralph-hero/issues/734
- SQLite FTS5 query syntax: https://www.sqlite.org/fts5.html#full_text_query_syntax
