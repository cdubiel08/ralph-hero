---
date: 2026-04-04
github_issue: 734
github_url: https://github.com/cdubiel08/ralph-hero/issues/734
status: complete
type: research
tags: [ralph-knowledge, fts5, sqlite, search, bug]
---

# GH-734: knowledge_search crashes with "no such column: 730"

## Prior Work

- builds_on:: [[2026-04-03-knowledge-implementation-comparison-obra-vs-ralph]]
- builds_on:: [[2026-04-03-GH-0723-knowledge-quality-improvements]]
- tensions:: None identified.

## Problem Statement

`knowledge_search` throws `Error: no such column: 730` when the query string contains a bare number or hyphenated token like `GH-730`. Any search involving issue references (an extremely common pattern) crashes instead of returning results.

```
knowledge_search(query: "implementation plan GH-730 playwright-aware planning", type: "plan", limit: 3)
→ Error: no such column: 730
```

## Current State Analysis

### Query Flow (No Escaping Anywhere)

```
index.ts:37   z.string() — Zod validates non-empty only
index.ts:46   hybrid.search(args.query, ...)
                 ↓
hybrid-search.ts:24   fts.search(query, ...)  ← raw, unmodified
                 ↓
search.ts:100  params = { query, limit }      ← raw string stored
search.ts:141  db.prepare(sql).all(params)    ← @query bound via better-sqlite3
                 ↓
SQLite FTS5 MATCH parser receives raw string
```

There is **no sanitization, escaping, or preprocessing** at any point in the chain.

### Root Cause: FTS5 Query Grammar

FTS5 has its own query language that is parsed *after* SQLite parameter binding. Better-sqlite3's named parameter binding (`@query`) protects against SQL injection but does **not** escape FTS5 query syntax — the bound string value is passed verbatim into the FTS5 query parser.

FTS5 grammar tokenizes `GH-730` as:
1. `GH` — valid bareword token
2. `-` — **column filter negation operator** (FTS5 grammar rule for column-restricted queries)
3. `730` — a bareword interpreted as a **column name** following the `-` operator

This produces: "exclude column named `730` from the search". SQLite then fails with `no such column: 730` because no column by that name exists on the `documents_fts` virtual table (which has columns `title`, `path`, `content`).

**Key insight**: This is FTS5 query language grammar behavior — not a bug in `better-sqlite3` or parameter binding. The `-` character is not in FTS5's definition of a valid bareword, so it acts as a token boundary and operator.

### FTS5 Special Characters

The following characters carry syntactic meaning in FTS5 query strings:

| Character | FTS5 Role |
|-----------|-----------|
| `-` | Column filter negation (causes `no such column` on adjacent token) |
| `:` | Column filter separator (`colname : phrase`) |
| `*` | Prefix wildcard |
| `+` | Explicit phrase concatenation |
| `(` / `)` | Grouping |
| `AND`, `OR`, `NOT` | Boolean operators |
| `^` | Initial token marker |
| `"` | Phrase delimiter (must be doubled inside phrases) |

Any character outside alphanumeric, underscore, and non-ASCII (>127) acts as a token boundary.

### Affected Code

- [`plugin/ralph-knowledge/src/search.ts:99`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/search.ts#L99) — `["documents_fts MATCH @query"]` with no preceding escape
- [`plugin/ralph-knowledge/src/search.ts:100`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/search.ts#L100) — `{ query, limit }` — raw string stored as-is
- [`plugin/ralph-knowledge/src/search.ts:141`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/search.ts#L141) — `.prepare(sql).all(params)` — executed without escaping

### Test Gap

`plugin/ralph-knowledge/src/__tests__/search.test.ts` covers:
- Simple keywords: `"cache"`, `"authentication"`
- Phrases: `"cache invalidation"`
- Boolean: `"cache OR auth"`

No test cases exist for:
- Numeric queries (`"42"`, `"GH-730"`)
- Hyphenated tokens (`"two-factor"`, `"GH-734"`)
- Issue references
- FTS5 special characters

## Key Discoveries

### The Fix: Double-Quote Wrapping

FTS5 supports double-quoted strings as phrase literals. Wrapping the entire query in `"..."` causes FTS5 to treat all contents as a literal phrase search, neutralizing all operator characters:

```typescript
export function escapeFts5Query(raw: string): string {
  return '"' + raw.replace(/"/g, '""') + '"';
}
```

- Step 1: Replace all `"` with `""` (FTS5 escape-within-phrase rule)
- Step 2: Wrap in outer `"..."` to make it a phrase literal

For `GH-730` → `"GH-730"` (passed as the bound string value) → FTS5 reads as phrase literal, hyphen is inert.

**Semantic implication**: Wrapping in double quotes enforces phrase matching — tokens must appear contiguously and in order. For short, specific queries like issue references this is desirable. For longer natural language queries it may reduce recall by requiring exact contiguous match.

### Alternative: Token-Level Escaping

Rather than treating the entire query as a phrase, individual tokens could be double-quoted and rejoined:

```typescript
export function escapeFts5Tokens(raw: string): string {
  return raw
    .split(/\s+/)
    .filter(Boolean)
    .map(token => '"' + token.replace(/"/g, '""') + '"')
    .join(' ');
}
```

This wraps each whitespace-delimited word individually, preserving term co-occurrence requirements while neutralizing special chars within tokens. `"GH-730" "playwright-aware" "planning"` — each token quoted but treated as independent search terms (not necessarily adjacent).

**Trade-off**: Full-phrase escaping is simpler; token-level escaping preserves multi-term co-occurrence without proximity requirement.

### Where to Apply the Fix

The escape must be applied in `search.ts` before the `params` object is constructed — closest to the SQL. This is preferable to applying it at `index.ts` (entry point) because:
1. The same `FtsSearch` class is used for internal queries that may already have well-formed FTS5 syntax
2. The escape point being adjacent to the MATCH clause makes the invariant obvious to future readers

However, `search.ts` is a lower-level module that could also receive pre-validated FTS5 queries (e.g., tests using `OR` syntax). Adding a new `escapedQuery` parameter or escaping unconditionally needs consideration.

**Recommended approach**: Add `escapeFts5Query()` utility in `search.ts`, apply unconditionally to the `query` parameter before assigning to `params`. The `OR` test case (`"cache OR auth"`) would become `"cache OR auth"` (phrase), changing its semantics — update that test to use separate `fts.search("cache")` + `fts.search("auth")` calls, or add an `escapeQuery: boolean` option (default `true`).

### Tokenizer Note

The default FTS5 tokenizer (`unicode61`) splits on hyphens at indexing time too — meaning `GH-730` in a document is indexed as separate tokens `GH` and `730`. Wrapping the query in quotes searches for the phrase `GH 730` (adjacent), which will match documents that contain `GH-730` since the hyphen was stripped at index time. This is correct behavior.

## Potential Approaches

### Approach A: Unconditional Phrase Escaping (Recommended)

Escape all incoming queries as FTS5 phrases in `search.ts`:

```typescript
private escapeFts5Query(raw: string): string {
  return '"' + raw.replace(/"/g, '""') + '"';
}

search(query: string, options: SearchOptions = {}): SearchResult[] {
  const conditions: string[] = ["documents_fts MATCH @query"];
  const params: Record<string, unknown> = { query: this.escapeFts5Query(query), limit };
  // ...
}
```

**Pros**: Simple, minimal change, fixes all FTS5 operator injection. Tests with `OR` need updating (minor).
**Cons**: Phrase matching may reduce recall for multi-word natural language queries.

### Approach B: Token-Level Escaping

Escape each whitespace token individually:

```typescript
private escapeFts5Tokens(raw: string): string {
  return raw.split(/\s+/).filter(Boolean)
    .map(t => '"' + t.replace(/"/g, '""') + '"').join(' ');
}
```

**Pros**: Preserves multi-term co-occurrence without proximity constraint.
**Cons**: More complex, still requires test updates, slightly more code.

### Approach C: Regex Stripping

Strip all FTS5 special characters before passing:

```typescript
query.replace(/["\-:*+()\^]/g, ' ').trim()
```

**Pros**: No phrase semantics, raw tokens.
**Cons**: Lossy — destroys legitimate content. `two-factor` becomes `two factor`. Not the right approach.

## Recommended Fix

**Approach A** — unconditional phrase escaping. It's the simplest, most correct, and most consistent with how knowledge search is used (short targeted queries, not boolean expressions). Update the `"cache OR auth"` test to not rely on FTS5 `OR` syntax — test each term independently.

## Risks

- **Test breakage**: Existing test `fts.search("cache OR auth")` will fail because `"cache OR auth"` (phrase) won't match docs that only have `cache` or only have `auth`. Fix: split into separate calls or test with a document containing all three tokens contiguously.
- **Phrase vs. proximity recall**: For longer natural language queries, phrase matching is stricter. Mitigated by the fact that HybridSearch also uses vector search (which is unaffected) to provide semantic recall.

## Files Affected

### Will Modify
- `plugin/ralph-knowledge/src/search.ts` — Add `escapeFts5Query()` private method, apply to `params.query` before SQL execution
- `plugin/ralph-knowledge/src/__tests__/search.test.ts` — Add test cases for numeric queries and hyphenated tokens; update `"cache OR auth"` test

### Will Read (Dependencies)
- `plugin/ralph-knowledge/src/hybrid-search.ts` — Verify no other query entry paths
- `plugin/ralph-knowledge/src/index.ts` — Verify query flows only through `hybrid.search()`
