---
date: 2026-04-26
topic: "How the ralph-knowledge indexer extracts wikilinks and turns them into graph nodes/edges, including the source of 'phantom node' observations from knowledge_traverse"
tags: [research, ralph-knowledge, indexer, parser, graph-builder, wikilinks, untyped-edges, stub-documents]
status: complete
type: research
github_issue: 897
github_url: https://github.com/cdubiel08/ralph-hero/issues/897
---

# Research: ralph-knowledge Wikilink Extractor — Indexer Pipeline and Phantom-Node Source

## Prior Work

- builds_on:: [[2026-03-24-GH-0664-capture-all-wiki-links-as-edges]]
- builds_on:: [[2026-03-26-ralph-knowledge-architecture-for-engine-parity]]
- builds_on:: [[2026-03-25-GH-0682-ralph-knowledge-three-bug-fix]]
- builds_on:: [[2026-03-28-ralph-knowledge-multi-project-architecture]]
- builds_on:: [[2026-04-03-knowledge-implementation-comparison-obra-vs-ralph]]

## Research Question

When `knowledge_traverse` was run from the seed dream-loop research doc, the result set included target IDs that look like literal placeholder text rather than real document IDs — `wikilink`, `wikilinks`, `doc-id`, `target`, `target-id`, `link`, `Alice`, `future-research-topic`, `<other surface docs that touch this one>`. Document how the current indexer extracts wikilinks, where these targets come from, and what filtering exists between extraction and the MCP traverse output.

## Summary

The phantom-target behavior is fully explained by the parser. `parser.ts:34` defines `WIKILINK_RE = /\[\[([^\]]+)\]\]/g` — any string between `[[` and `]]` that doesn't contain `]` is captured verbatim as a target ID. There is **no allowlist, no validation, no resolution step**. Code-fence blocks (triple backticks) are stripped before extraction; inline code, HTML comments, and block quotes are not. Each extracted target is persisted as both a stub document row (`is_stub = 1`, with the raw wikilink text used as `title`) and an untyped relationship row.

A graph-layer filter does exist: `GraphBuilder.buildGraph()` loads only documents with `is_stub = 0 OR is_stub IS NULL` and skips relationships whose endpoints aren't in the node set. This means stub-target edges *should* be invisible to anything that goes through `GraphBuilder`. Since `knowledge_traverse` returned them anyway, the suspected cause is that `traverse.ts` queries the SQLite `relationships` table directly without applying the stub filter — but this was not confirmed in this research and is the open question below.

The angle-bracket text `<other surface docs that touch this one>` is consistent with the regex: `[^\]]` accepts `<` and `>` freely, so a literal `[[<other surface docs that touch this one>]]` written inside a doc body would extract that exact string as a target ID.

## Detailed Findings

### Pipeline overview

The indexer (`reindex.ts`) runs in three phases:

1. **File discovery and stale cleanup.** `findMarkdownFiles` walks the configured root directories. Any previously synced file no longer on disk has its `documents`, FTS, and vector rows deleted from SQLite.
2. **Parse and store changed files.** For each file whose `mtime` differs from the `sync` table record, `parseDocument` extracts frontmatter, typed relationships, and untyped wikilink edges. The document is upserted, relationships are deleted and re-inserted, and every target — including unknown ones — is materialized as a stub `documents` row to satisfy the foreign-key constraint.
3. **FTS rebuild.** Full FTS rebuild only runs on schema-version change; per-document FTS is incremental during phase 2.

The in-memory `GraphBuilder` is a read-only view built on demand from the persisted `documents` and `relationships` tables. It is not part of the indexer write path.

### Wikilink extraction

`plugin/ralph-knowledge/src/parser.ts:32-35` defines four regexes:

```ts
const WIKILINK_REL_RE = /^- (builds_on|tensions|post_mortem):: \[\[(.+?)\]\]/gm;
const SUPERSEDED_BY_RE = /\[\[(.+?)\]\]/;
const WIKILINK_RE      = /\[\[([^\]]+)\]\]/g;
const FENCED_CODE_RE   = /```[\s\S]*?```/g;
```

- `WIKILINK_REL_RE` (line 32): typed relationship lines only (`- builds_on:: [[…]]`, `- tensions:: [[…]]`, `- post_mortem:: [[…]]`).
- `SUPERSEDED_BY_RE` (line 33): non-global; applied only to the `superseded_by` frontmatter value.
- `WIKILINK_RE` (line 34): the **untyped** extractor — anything `[[…]]` where `…` contains no `]`.
- `FENCED_CODE_RE` (line 35): triple-backtick block stripper.

`extractUntypedWikilinks` (around `parser.ts:70`) strips fenced code from each paragraph before scanning:

```ts
const stripped = paragraph.replace(FENCED_CODE_RE, "");
```

The test at `parser.test.ts:348-352` explicitly verifies that `[[should-be-skipped]]` inside a fenced block produces zero edges.

#### Behavior on observed phantom targets

| Source text in doc | Captured `targetId` | Why |
|---|---|---|
| `[[2026-04-16-real-doc]]` | `2026-04-16-real-doc` | Real wikilink, normal case |
| `[[wikilink]]` | `wikilink` | No filtering on capture group |
| `[[doc-id]]` | `doc-id` | Same |
| `[[Alice]]` | `Alice` | Same |
| `[[wikilinks]]`, `[[link]]`, `[[future-research-topic]]`, `[[target]]`, `[[target-id]]` | each captured verbatim | Same |
| `[[<other surface docs that touch this one>]]` | `<other surface docs that touch this one>` | `[^\]]` admits `<` and `>` |
| `<other surface docs…>` (no double brackets) | (nothing) | Angle brackets alone do not match any regex |

The phantom targets observed in `knowledge_traverse` output match category 1 (someone writing example wikilinks like `[[wikilink]]` inside research-doc prose to illustrate the syntax).

#### What is NOT stripped before extraction

Frontmatter is stripped at `parser.ts:94` (`raw.slice(fmMatch[0].length).trim()`), and fenced code blocks are stripped per-paragraph. The following are **not** stripped:

- **Inline code** (single backtick, e.g., `` `[[target]]` ``) — wikilinks inside are extracted as edges.
- **HTML comments** (`<!-- … -->`) — wikilinks inside are extracted.
- **Block quotes** (`> …`) — wikilinks inside are extracted.

No tests cover any of these three cases.

### Graph node/edge creation

For every untyped edge returned by `parseDocument`, `reindex.ts:165-168` runs:

```ts
for (const edge of parsed.untypedEdges) {
  db.upsertStubDocument(edge.targetId);
  db.addRelationship(edge.sourceId, edge.targetId, "untyped", edge.context);
}
```

`db.upsertStubDocument` (`db.ts:238-241`) executes:

```sql
INSERT OR IGNORE INTO documents
  (id, path, title, date, type, status, github_issue, content, is_stub)
VALUES (?, NULL, ?, NULL, NULL, NULL, NULL, '', 1)
```

For an unknown target, this creates a row with `is_stub = 1`, `path = NULL`, `title` set to the raw wikilink text, and all other metadata `NULL`. `INSERT OR IGNORE` makes it a no-op when the target is already a real document.

`db.addRelationship` (`db.ts:261`):

```sql
INSERT OR IGNORE INTO relationships (source_id, target_id, type, context)
VALUES (?, ?, ?, ?)
```

The primary key `(source_id, target_id, type)` on `db.ts:125` silently drops duplicate edges.

Typed relationships follow the identical path at `reindex.ts:160-163` (no `context` value passed; column stored as `NULL`).

#### Phase 3 stub sweep

After all files are processed, `reindex.ts:257-270` runs:

```ts
const allTargetIds = new Set<string>(
  (db.db.prepare("SELECT DISTINCT target_id FROM relationships").all() ...)
    .map(r => r.target_id)
);
for (const targetId of allTargetIds) {
  if (!db.documentExists(targetId)) {
    db.upsertStubDocument(targetId);
    stubCount++;
  }
}
```

This catches targets from prior runs whose referencing files were `mtime`-skipped in the current incremental run.

### GraphBuilder filtering

`GraphBuilder.buildGraph()` at `graph-builder.ts:33-34` loads only non-stub documents as graph nodes:

```sql
SELECT id, title, date, type, status FROM documents WHERE is_stub = 0 OR is_stub IS NULL
```

At `graph-builder.ts:63-64`, it then defensively skips any relationship row where either endpoint is missing from the node set:

```ts
if (!graph.hasNode(rel.source_id) || !graph.hasNode(rel.target_id)) {
  continue;
}
```

**Net effect**: stub-only targets are absent from the in-memory graphology graph. The `relationships` rows persist in SQLite, but `GraphBuilder` silently drops them during graph construction. Anything that consumes `GraphBuilder` (community detection, centrality, subgraph extraction) will not see them.

### Allowlist, validation, resolution — none

The captured `match[1]` from `WIKILINK_RE` is used verbatim as `targetId`. No date-prefix validation, no length check, no fuzzy match, no title-based resolution. The only deduplication:

- `seenInParagraph` Set (`parser.ts:81`) — same target twice in one paragraph collapses to one edge per paragraph.
- `typedTargets` Set (`parser.ts:79`) — a target appearing as a typed relationship is excluded from `untypedEdges`.
- SQLite `PRIMARY KEY (source_id, target_id, type)` (`db.ts:125`) — exact duplicate triples dropped via `INSERT OR IGNORE`.

### Test coverage

Tests in `plugin/ralph-knowledge/src/__tests__/`.

`parser.test.ts` — `extractUntypedWikilinks` block (lines 324-382):
- Single wikilink in a simple paragraph (line 325)
- Context returned as trimmed paragraph text (line 334)
- Multiple wikilinks per paragraph each get an edge (line 340)
- Wikilinks inside fenced code blocks skipped (line 348)
- Wikilinks whose target is in `typedTargets` skipped (line 354)
- Same target twice in one paragraph deduplicates (line 361)
- Same target in two paragraphs produces two edges (line 368)
- No wikilinks in body returns empty array (line 377)

`parser.test.ts` — `parseDocument untyped edges` block (lines 384-435): full-integration coverage of the above.

`reindex.test.ts`:
- Scenario 6 (line 239): real-document target is not marked as stub when the target file exists.
- Scenario 8 (line 289): stub document for unresolved wikilink `phantom` is created on first index and survives the next incremental run when the referencing file is `mtime`-skipped.

`graph-builder.test.ts`:
- FK constraint test (line 153): inserting a `relationships` row referencing a non-existent `documents.id` directly (bypassing `upsertStubDocument`) throws `FOREIGN KEY constraint failed`.
- No test asserts that a stub-target edge present in SQLite is dropped during `buildGraph()`. The behavior is documented in code comments at `graph-builder.ts:63-64` only.

**Gaps in test coverage:**
- Inline code (single backtick).
- HTML comments.
- Block quotes.
- Angle-bracket targets like `[[<...>]]`.
- The graph-side stub-edge drop behavior.
- Whether `knowledge_traverse` honors the stub filter.

## Code References

All references are at ralph-hero commit [`557f2a4`](https://github.com/cdubiel08/ralph-hero/tree/557f2a4389b0e37ce77d2da1d54cf698a6788e6e).

- [`parser.ts:32-35`](https://github.com/cdubiel08/ralph-hero/blob/557f2a4389b0e37ce77d2da1d54cf698a6788e6e/plugin/ralph-knowledge/src/parser.ts#L32-L35) — Regex constants for typed, untyped, superseded-by, and fenced-code blocks.
- [`parser.ts:70`](https://github.com/cdubiel08/ralph-hero/blob/557f2a4389b0e37ce77d2da1d54cf698a6788e6e/plugin/ralph-knowledge/src/parser.ts#L70) — Fenced-code stripping before untyped scan.
- [`parser.ts:79-81`](https://github.com/cdubiel08/ralph-hero/blob/557f2a4389b0e37ce77d2da1d54cf698a6788e6e/plugin/ralph-knowledge/src/parser.ts#L79-L81) — `typedTargets` and `seenInParagraph` dedup sets.
- [`parser.ts:94`](https://github.com/cdubiel08/ralph-hero/blob/557f2a4389b0e37ce77d2da1d54cf698a6788e6e/plugin/ralph-knowledge/src/parser.ts#L94) — Frontmatter stripped from `body`.
- [`parser.ts:121`](https://github.com/cdubiel08/ralph-hero/blob/557f2a4389b0e37ce77d2da1d54cf698a6788e6e/plugin/ralph-knowledge/src/parser.ts#L121) — `extractUntypedWikilinks` invocation in `parseDocument`.
- [`reindex.ts:160-163`](https://github.com/cdubiel08/ralph-hero/blob/557f2a4389b0e37ce77d2da1d54cf698a6788e6e/plugin/ralph-knowledge/src/reindex.ts#L160-L163) — Typed relationship persistence.
- [`reindex.ts:165-168`](https://github.com/cdubiel08/ralph-hero/blob/557f2a4389b0e37ce77d2da1d54cf698a6788e6e/plugin/ralph-knowledge/src/reindex.ts#L165-L168) — Untyped edge persistence with stub creation.
- [`reindex.ts:257-270`](https://github.com/cdubiel08/ralph-hero/blob/557f2a4389b0e37ce77d2da1d54cf698a6788e6e/plugin/ralph-knowledge/src/reindex.ts#L257-L270) — Phase 3 stub-target sweep across the relationships table.
- [`db.ts:125`](https://github.com/cdubiel08/ralph-hero/blob/557f2a4389b0e37ce77d2da1d54cf698a6788e6e/plugin/ralph-knowledge/src/db.ts#L125) — `relationships` primary key.
- [`db.ts:238-241`](https://github.com/cdubiel08/ralph-hero/blob/557f2a4389b0e37ce77d2da1d54cf698a6788e6e/plugin/ralph-knowledge/src/db.ts#L238-L241) — `upsertStubDocument` SQL.
- [`db.ts:261`](https://github.com/cdubiel08/ralph-hero/blob/557f2a4389b0e37ce77d2da1d54cf698a6788e6e/plugin/ralph-knowledge/src/db.ts#L261) — `addRelationship` SQL.
- [`graph-builder.ts:33-34`](https://github.com/cdubiel08/ralph-hero/blob/557f2a4389b0e37ce77d2da1d54cf698a6788e6e/plugin/ralph-knowledge/src/graph-builder.ts#L33-L34) — Graph node load with stub filter.
- [`graph-builder.ts:63-64`](https://github.com/cdubiel08/ralph-hero/blob/557f2a4389b0e37ce77d2da1d54cf698a6788e6e/plugin/ralph-knowledge/src/graph-builder.ts#L63-L64) — Edge skip when endpoint missing.

## Architecture Documentation

The indexer is a single-pass, incremental, write-through pipeline. The graph layer is read-through and built on demand. Every wikilink target — real or placeholder — becomes a persistent edge in SQLite; the graph layer is the place where placeholders are filtered out. This design keeps the indexer permissive (it doesn't need to know which targets will eventually exist) while concentrating all "what counts as a real node" decisions in `GraphBuilder`. The tradeoff is that any consumer that bypasses `GraphBuilder` and queries the `relationships` table directly will see the unfiltered, stub-inclusive view.

The frontmatter convention `builds_on:: [[…]]`, `tensions:: [[…]]`, and `post_mortem:: [[…]]` is the typed-edge surface; everything else inside `[[…]]` becomes an untyped edge with the surrounding paragraph stored as `context`.

## Historical Context (from thoughts/)

- `thoughts/shared/research/2026-03-24-GH-0664-capture-all-wiki-links-as-edges.md` — The research that introduced the current extraction behavior, including the paragraph-context capture and the explicit decision to capture *all* wikilinks (not only those resolving to real docs).
- `thoughts/shared/plans/2026-03-25-GH-0682-ralph-knowledge-three-bug-fix.md` — Bug #3 in that plan addressed an earlier stub-creation timing issue where `knownIds` was built only from the current batch, missing targets referenced by `mtime`-skipped files. The Phase 3 sweep at `reindex.ts:257-270` is the fix.
- `thoughts/shared/research/2026-03-26-ralph-knowledge-architecture-for-engine-parity.md` — Architecture overview describing the typed/untyped split and where each lives in the schema.
- `thoughts/shared/research/2026-03-28-ralph-knowledge-multi-project-architecture.md` — Multi-project ingestion and FTS5 rebuild behavior.
- `thoughts/shared/research/2026-04-03-knowledge-implementation-comparison-obra-vs-ralph.md` — Post-convergence scorecard noting "wikilinks as untyped edges now captured."

## Open Questions

1. **Does `knowledge_traverse` query SQLite directly or go through `GraphBuilder`?** Observed traverse output included stub targets (`wikilink`, `<other surface docs that touch this one>`, etc.) that `GraphBuilder` would have dropped. Tracing `traverse.ts` would confirm whether the MCP traverse path bypasses the stub filter, and if so, whether `knowledge_communities` and `knowledge_central` (which presumably do go through `GraphBuilder`) are unaffected.
2. **Does the same bypass affect any other MCP tools?** `knowledge_subgraph` is a likely candidate — it returns nodes and edges around a root document. If it queries SQLite directly, the same phantom-node behavior would appear there.
3. **What does the test for "stub edges are filtered at graph layer" look like?** Currently absent. Would need to set up a fixture with at least one stub target and assert it's not in `graph.nodes()` after `buildGraph()`.

## Follow-up audit (2026-04-26)

A direct trace of every MCP tool against the `is_stub` filter resolved the open questions above and surfaced two additional bypasses the original research missed. Tracked in [#897](https://github.com/cdubiel08/ralph-hero/issues/897).

### Summary table

| Tool | Path | `is_stub` filter? | Verdict |
|---|---|---|---|
| `knowledge_search` (FTS leg) | `search.ts:155-171` JOIN of `documents_fts` to `documents` | **NO** | **BYPASSES** |
| `knowledge_search` (vector-only leg) | `hybrid-search.ts:158-162` explicit `doc.isStub` guard | YES | HONORS |
| `knowledge_traverse` | `traverse.ts:24,81` recursive CTE + `LEFT JOIN documents` | **NO** | **BYPASSES** |
| `knowledge_subgraph` | `graph-tools.ts:799-916` → `GraphBuilder.buildGraph()` | YES | HONORS |
| `knowledge_communities` | `graph-tools.ts:176-321` → `GraphBuilder` | YES | HONORS |
| `knowledge_community` | `graph-tools.ts:326-447` → `GraphBuilder` | YES | HONORS |
| `knowledge_central` | `graph-tools.ts:452-563` → `GraphBuilder` | YES | HONORS |
| `knowledge_paths` | `graph-tools.ts:637-717` → `GraphBuilder` | YES | HONORS |
| `knowledge_bridges` | `graph-tools.ts:568-632` → `GraphBuilder` | YES | HONORS |
| `knowledge_common` | `graph-tools.ts:722-793` → `GraphBuilder` | YES | HONORS |
| `knowledge_memory_stats` | `index.ts:196,213,224` direct `SELECT COUNT(*)` on `documents` | **NO** | **BYPASSES** |
| `knowledge_query_outcomes` | `outcome_events` only | N/A | N/A |
| `knowledge_record_outcome` | `outcome_events` only | N/A | N/A |

### Confirmed answers

1. **`knowledge_traverse` does query SQLite directly.** Both `traverse()` and `traverseIncoming()` walk `relationships` with a `LEFT JOIN documents` and no `is_stub` clause. Stubs surface as hops with `doc.title = stubId` (because `upsertStubDocument` at `db.ts:241` sets `title = id`).
2. **`knowledge_subgraph` is NOT affected.** It calls `GraphBuilder.buildGraph()` at `graph-tools.ts:822`, so stubs are filtered.
3. **Two additional bypasses surfaced** (not on the original list):
   - **`knowledge_search` FTS leg.** `FtsSearch.rebuildIndex()` (`search.ts:90-104`) runs an unfiltered `INSERT INTO documents_fts ... SELECT rowid, title, path, content FROM documents`. After any schema-version bump, stubs are in the FTS index. Stub `content = ''` and `title = id`, so they match by title/path with empty snippets. The vector-only path at `hybrid-search.ts:161` already has a guard; the FTS path does not.
   - **`knowledge_memory_stats`.** All three count queries against `documents` (`index.ts:196`, `:213`, `:224`) lack the filter. `total_documents` and `by_tier` are inflated by every stub. `new_since` is incidentally clean only because stubs have `date = NULL` and the query filters on `date IS NOT NULL`.

### New side-effect findings

- **Typed relationships also create stubs.** `reindex.ts:160-168` calls `db.upsertStubDocument(rel.targetId)` for every typed relationship target (`builds_on`, `tensions`, `post_mortem`, `superseded_by`) before inserting the row. The fix must cover stubs created by typed edges, not just untyped wikilinks.
- **Vector index is clean.** `vec.upsertEmbedding` is only called inside the real-document chunk loop at `reindex.ts:230`; `upsertStubDocument` never embeds. Stubs have no rows in `documents_vec`, which is why the vector leg of search is naturally clean — the `hybrid-search.ts:161` guard is defense-in-depth, not the only thing protecting it.
- **FTS rebuild is conditional.** A full `rebuildIndex()` only runs on schema-version change (`reindex.ts:253`). Per-document FTS in Phase 2 is incremental and only touches real documents (stubs are never passed to `fts.upsertFtsEntry`). So stub-pollution of FTS is a *post-schema-bump* phenomenon, not continuous — but once present, it persists until the next schema bump.

### Test-coverage gaps confirmed

No test asserts:
- Stub edges are dropped during `GraphBuilder.buildGraph()`.
- `knowledge_traverse` excludes stub hops.
- `knowledge_search` FTS does not return stub documents.
- `knowledge_memory_stats` excludes stubs from totals.
- Typed relationships do not produce visible stubs.
