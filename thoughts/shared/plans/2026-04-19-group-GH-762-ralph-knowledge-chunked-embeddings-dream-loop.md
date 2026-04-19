---
date: 2026-04-19
status: draft
type: plan
github_issue: 762
github_issues: [762, 763, 764, 765, 766, 767, 768, 769, 770, 771, 772]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/762
  - https://github.com/cdubiel08/ralph-hero/issues/763
  - https://github.com/cdubiel08/ralph-hero/issues/764
  - https://github.com/cdubiel08/ralph-hero/issues/765
  - https://github.com/cdubiel08/ralph-hero/issues/766
  - https://github.com/cdubiel08/ralph-hero/issues/767
  - https://github.com/cdubiel08/ralph-hero/issues/768
  - https://github.com/cdubiel08/ralph-hero/issues/769
  - https://github.com/cdubiel08/ralph-hero/issues/770
  - https://github.com/cdubiel08/ralph-hero/issues/771
  - https://github.com/cdubiel08/ralph-hero/issues/772
primary_issue: 762
parent_plan: thoughts/shared/plans/2026-04-16-GH-0761-ralph-knowledge-chunked-embeddings-dream-loop.md
tags: [ralph-knowledge, chunking, embeddings, contextual-retrieval, dream-loop, mcp, local-llm, launchd]
---

# ralph-knowledge Chunked Embeddings + Contextual Retrieval + Dream-Loop — Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-04-16-GH-0761-ralph-knowledge-chunked-embeddings-dream-loop]]

## Overview

11 related issues for atomic implementation across multiple PRs. Each child issue maps to exactly one phase below. This plan is the child of the plan-of-plans at [thoughts/shared/plans/2026-04-16-GH-0761-ralph-knowledge-chunked-embeddings-dream-loop.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-04-16-GH-0761-ralph-knowledge-chunked-embeddings-dream-loop.md) (epic issue #761).

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-762 | Schema v3 migration (chunks table + memory_tier) | XS |
| 2 | GH-763 | RecursiveCharacterTextSplitter chunker module | S |
| 3 | GH-764 | Chunk-aware embedder + reindex persistence | S |
| 4 | GH-765 | HybridSearch chunk-to-doc dedup + snippet | S |
| 5 | GH-766 | LLM client for Contextual Retrieval (Gemma @ localhost) | S |
| 6 | GH-767 | Wire contextual retrieval into embedder + reindex | S |
| 7 | GH-768 | `.ralphignore` + knowledge.config.json + scanner wiring | S |
| 8 | GH-769 | MCP tool extensions (memory_tier filter + knowledge_memory_stats) | S |
| 9 | GH-770 | Dream-loop ingester (gemma-lab + git + llm-cli) | S |
| 10 | GH-771 | Dream-loop reflection synthesis (HDBSCAN + Gemma) | S |
| 11 | GH-772 | launchd plist template + log rotation for dream-loop | XS |

**Why grouped**: The 11 issues form a single delivery vertical that moves ralph-knowledge from 500-char prefix truncation to chunk-aware + contextualized retrieval with a nightly dream-loop producing reflection documents. Phase 1 (schema) is a hard prerequisite for every downstream phase; phases 2-4 form the core chunking pipeline; 5-6 layer in Contextual Retrieval; 7 adds ergonomics; 8 extends the MCP surface; 9-11 implement the Python dream-loop. Integration-level verification (end-to-end: raw memories -> clusters -> reflections -> searchable from Claude Code) requires all 11 to land before the system is useful, so they must be planned together even though they merge as independent PRs.

## Shared Constraints

Inherited from parent plan-of-plans ([GH-0761](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-04-16-GH-0761-ralph-knowledge-chunked-embeddings-dream-loop.md)) and extended where new constraints were discovered:

1. **Embedder model stays**: `Xenova/all-MiniLM-L6-v2` @ 384-dim. No model swap in this plan.
2. **Single global DB**: `~/.ralph-hero/knowledge.db`. No per-project isolation.
3. **Fail-open LLM**: Contextual Retrieval and dream-loop must survive unreachable Gemma endpoints. Empty string / single warning log / proceed.
4. **Idempotency on reruns**: dream-loop ingesters must produce same output on back-to-back runs (stable hash naming).
5. **Schema migration triggers full reindex**: bumping `meta.schema_version` is the only required migration action (existing pattern in [plugin/ralph-knowledge/src/reindex.ts:22-30](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/reindex.ts#L22-L30) drops sync records and re-embeds).
6. **Chunk id scheme**: `{doc_id}#c{index}` (zero-indexed). Vector search stores chunk ids; HybridSearch splits on `#c` to recover `doc_id`.
7. **Code style**: TypeScript strict mode. ESM with `.js` extensions on all internal imports. Vitest for tests. Zod for MCP schemas.
8. **No linter**: TypeScript strict is the primary quality gate. Do not introduce ESLint/Prettier.
9. **Canonical paths**: Plugin source at `plugin/ralph-knowledge/src/`. Python dream-loop at `scripts/dream/` (new). Tests under `src/__tests__/` for TS, `scripts/dream/tests/` for Python.
10. **Env vars**: `RALPH_LLM_URL` (default `http://localhost:8000`), `RALPH_LLM_MODEL` (default `mlx-community/gemma-4-26b-a4b-it-mxfp8`), `RALPH_CONTEXTUAL_RETRIEVAL` (default `1`), `RALPH_KNOWLEDGE_CONFIG` (optional path override), `RALPH_KNOWLEDGE_DIRS` (already supported at [plugin/ralph-knowledge/src/reindex.ts:196](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/reindex.ts#L196)).
11. **Discovery note** — the existing `SCHEMA_VERSION = "2"` literal is at [plugin/ralph-knowledge/src/reindex.ts:22](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/reindex.ts#L22). Bumping to `"3"` auto-triggers full re-embed via `clearSyncRecords()` at [reindex.ts:27](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/reindex.ts#L27).
12. **Discovery note** — `KnowledgeDB.clearAll()` at [db.ts:449-452](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/db.ts#L449-L452) currently deletes `relationships`, `tags`, `documents`, `sync` but does NOT delete `chunks`. When Phase 1 adds the `chunks` table, update `clearAll()` to also drop its rows (children cascade from `documents` ON DELETE CASCADE but `clearAll()` uses raw DELETE on individual tables).
13. **Discovery note** — `VectorSearch` at [vector-search.ts:28-32](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/vector-search.ts#L28-L32) declares `documents_vec` as `vec0(id TEXT PRIMARY KEY, ...)`. Chunk ids follow the `{doc_id}#c{index}` convention; the virtual table column stays `id` but row values become chunk ids.

## Current State Analysis

From [plugin/ralph-knowledge/src/embedder.ts:7,24](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/embedder.ts#L7): `MAX_CHARS = 500` constant plus `.slice(0, MAX_CHARS)` inside `embed()` is the single point that truncates research documents. `prepareTextForEmbedding` at [embedder.ts:32-43](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/embedder.ts#L32-L43) assembles `title + tags + firstParagraph` before the slice.

From [plugin/ralph-knowledge/src/db.ts:103-163](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/db.ts#L103-L163): `createSchema()` currently defines `documents`, `tags`, `relationships`, `outcome_events`, `sync`, `meta` — no `chunks` table.

From [plugin/ralph-knowledge/src/vector-search.ts:28-32](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/vector-search.ts#L28-L32): `documents_vec` is `vec0(id TEXT PRIMARY KEY, embedding float[384] distance_metric=cosine)`. One row per document today; will become one row per chunk post-Phase 3.

From [plugin/ralph-knowledge/src/hybrid-search.ts:33-45](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/hybrid-search.ts#L33-L45): RRF fusion happens in a single `Map<string, number>` keyed by document id. No dedup needed today because every `id` is doc-level.

From [plugin/ralph-knowledge/src/file-scanner.ts:4-18](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/file-scanner.ts#L4-L18): Walk only skips entries starting with `.` or `_`. No gitignore-style support.

From [plugin/ralph-knowledge/src/reindex.ts:185-206](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/reindex.ts#L185-L206): `resolveDirs()` precedence is `CLI args > RALPH_KNOWLEDGE_DIRS > cwd/thoughts`. No config file support.

From [plugin/ralph-knowledge/src/index.ts:33-92](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/index.ts#L33-L92): `knowledge_search` and `knowledge_traverse` Zod schemas have no `memory_tier` input. No `knowledge_memory_stats` tool registered.

The `scripts/` directory exists at [scripts/](https://github.com/cdubiel08/ralph-hero/tree/main/scripts) with bash helpers (`create-worktree.sh`, `merge-pr.sh`, etc.) but no `dream/` subdirectory.

## Desired End State

1. `chunks` table populated with ~6-16 chunks per long research doc; `documents_vec` stores one embedding per chunk; search returns chunk-level snippets.
2. `embed()` no longer slices at 500 chars. `embedDocument(title, tags, content, opts)` emits `DocumentChunk[]` with embeddings.
3. HybridSearch deduplicates by `document_id` and surfaces the best-matching chunk's content as `snippet`.
4. LLM client at `llm-client.ts` probes `http://localhost:8000/v1/models` and calls `/v1/chat/completions`; fails open on any error.
5. Reindex flow reads `RALPH_CONTEXTUAL_RETRIEVAL` flag, constructs LLM client if on, and per-chunk stores `context_prefix` on the `chunks` row.
6. `~/.ralph/knowledge.config.json` lists roots and ignore patterns; `.ralphignore` files per-root augment them; scanner honors both.
7. MCP `knowledge_search` accepts `memory_tier` + `return_chunk_meta`; `knowledge_traverse` accepts `memory_tier`; new `knowledge_memory_stats` tool returns tier counts and percentiles.
8. `scripts/dream/ingest.py` pulls 24h of raw memories from three sources; writes `memory_tier=raw` markdown files with idempotent hashes; triggers reindex.
9. `scripts/dream/reflect.py` clusters raw memories, asks Gemma for per-cluster reflections, writes `memory_tier=reflection` markdown files with `builds_on::` links.
10. `~/Library/LaunchAgents/com.dubiel.dream-loop.plist` (installed from template in `scripts/dream/launchd/`) fires ingest + reflect at 03:00 daily; `/tmp/dream-loop.out` capped at 1000 lines.

### Verification

- [ ] `npm run build && npm test` in `plugin/ralph-knowledge` passes (all existing + new tests green).
- [ ] `sqlite3 ~/.ralph-hero/knowledge.db "SELECT COUNT(*) FROM chunks"` > 3x `SELECT COUNT(*) FROM documents` after reindex of `/Users/dubiel/projects/thoughts`.
- [ ] `knowledge_search "chunking strategies recursive character"` from Claude Code returns a body-of-doc snippet (not title/first paragraph).
- [ ] `knowledge_search --memory_tier reflection` returns reflection docs after one manual dream-loop run.
- [ ] `launchctl list | grep com.dubiel.dream-loop` shows loaded agent with next-fire timestamp.
- [ ] `uv run ingest.py --since 24h && uv run reflect.py --since 24h` produces >=1 reflection on real corpus.

## What We're NOT Doing

- Embedding model swap (BGE-small / Nomic / EmbeddingGemma). Keep `Xenova/all-MiniLM-L6-v2` 384-dim.
- Per-project DB isolation. Global `~/.ralph-hero/knowledge.db` stays.
- Git worktree auto-discovery.
- Screenpipe ambient capture.
- `simonw/llm` CLI install (optional source in Phase 9, not required).
- Reflection-of-reflections (tier 2+).
- FTS5 incremental upsert optimization (current full-rebuild-on-version-bump stays).
- OAuth / ACL / multi-user.
- Full-corpus contextualization backfill (Phase 6 wires the flag; actual backfill is a manual op post-merge, documented in README).

## Implementation Approach

- **Phase 1** (GH-762): schema migration lands first, unblocks everything.
- **Phases 2-3** (GH-763, GH-764): chunker module + embedder/reindex wiring produce the first real chunk data.
- **Phase 4** (GH-765): HybridSearch deduplication makes chunk-level hits presentable at doc-level.
- **Phases 5-6** (GH-766, GH-767): LLM client + contextual retrieval wiring layer on Anthropic Contextual Retrieval.
- **Phase 7** (GH-768): ergonomics (`.ralphignore` + config file). Independent of chunking; can run after Phase 1.
- **Phase 8** (GH-769): MCP tool extensions expose memory_tier filter + new stats tool. Depends on schema (Phase 1) + chunks data (Phase 3).
- **Phases 9-10** (GH-770, GH-771): dream-loop ingester then reflection synthesizer. Requires Phase 8 MCP surface.
- **Phase 11** (GH-772): launchd plist + log rotation wraps the nightly job. Requires Phases 9-10.

**Phase dependency annotations** — Each phase below includes a `depends_on` line immediately after the heading, used by orchestrators to determine parallelism. Phases 4, 5, 7 can all run in parallel after Phase 3; Phase 6 depends on Phase 5; Phase 8 depends on Phase 1 + Phase 3; Phase 9 depends on Phase 8; Phase 10 depends on Phase 9; Phase 11 depends on Phases 9 + 10.

---

## Phase 1: GH-762 — Schema v3 migration (chunks table + memory_tier)

- **depends_on**: null

### Overview

Add `chunks` table and `memory_tier` column with check constraint + index. Bump `SCHEMA_VERSION` to `"3"` in reindex, which auto-triggers full re-embed via existing migration pattern. Maps to GH-762.

### Tasks

#### Task 1.1: Add chunks table DDL to createSchema
- **files**: `plugin/ralph-knowledge/src/db.ts` (modify)
- **tdd**: true
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] `createSchema()` block at [db.ts:102-163](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/db.ts#L102-L163) contains `CREATE TABLE IF NOT EXISTS chunks` with columns: `id TEXT PRIMARY KEY`, `document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE`, `chunk_index INTEGER NOT NULL`, `content TEXT NOT NULL`, `char_start INTEGER NOT NULL`, `char_end INTEGER NOT NULL`, `context_prefix TEXT NOT NULL DEFAULT ''`, `UNIQUE(document_id, chunk_index)`
  - [ ] `CREATE INDEX IF NOT EXISTS idx_chunks_document_id ON chunks(document_id)` appears in the same exec block
  - [ ] Schema executes cleanly on fresh DB (new test in `db.test.ts` verifies `PRAGMA table_info(chunks)` returns expected rows)

#### Task 1.2: Add memory_tier column with CHECK + index
- **files**: `plugin/ralph-knowledge/src/db.ts` (modify)
- **tdd**: true
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] `createSchema()` includes a try/catch ALTER pattern matching the `is_stub` migration at [db.ts:168-172](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/db.ts#L168-L172): `ALTER TABLE documents ADD COLUMN memory_tier TEXT NOT NULL DEFAULT 'doc' CHECK(memory_tier IN ('doc','raw','reflection'))`
  - [ ] `CREATE INDEX IF NOT EXISTS idx_documents_memory_tier ON documents(memory_tier)` executes
  - [ ] Existing `documents` rows preserved with default `'doc'` when ALTER runs on a v2 DB
  - [ ] Attempting to insert a document with `memory_tier='garbage'` fails with CHECK constraint error (new test case)

#### Task 1.3: Update clearAll() to include chunks
- **files**: `plugin/ralph-knowledge/src/db.ts` (modify)
- **tdd**: true
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] `clearAll()` at [db.ts:449-452](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/db.ts#L449-L452) includes `DELETE FROM chunks;` in the exec statement (ON DELETE CASCADE from documents would handle this via FK, but `clearAll()` deletes relationships/tags/sync/documents explicitly; match that pattern)
  - [ ] Test in `db.test.ts` inserts a chunk row, calls `clearAll()`, verifies `SELECT COUNT(*) FROM chunks` returns 0

#### Task 1.4: Bump SCHEMA_VERSION to "3"
- **files**: `plugin/ralph-knowledge/src/reindex.ts` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1, 1.2]
- **acceptance**:
  - [ ] Constant at [reindex.ts:22](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/reindex.ts#L22) changes from `"2"` to `"3"`
  - [ ] No other code change in `reindex.ts` for this task — the existing `clearSyncRecords()` + `setMeta()` pattern at [reindex.ts:25-30](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/reindex.ts#L25-L30) handles the migration

#### Task 1.5: Test: schema migration verifies DDL + CHECK
- **files**: `plugin/ralph-knowledge/src/__tests__/db.test.ts` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [1.1, 1.2, 1.3]
- **acceptance**:
  - [ ] New test group "schema v3" covers: chunks table DDL columns match spec, idx_chunks_document_id exists, ON DELETE CASCADE removes chunks when parent document deleted, memory_tier CHECK rejects invalid values, idx_documents_memory_tier exists
  - [ ] `npm test -- db.test.ts` passes

### Phase Success Criteria

#### Automated Verification:
- [ ] `npm run build` in `plugin/ralph-knowledge` — no TypeScript errors
- [ ] `npm test` — all existing tests plus new v3 schema tests pass
- [ ] On a fresh DB: `schema_version` meta row is `"3"` after reindex

#### Manual Verification:
- [ ] Run reindex against an existing v2 DB; `sqlite3 ~/.ralph-hero/knowledge.db ".schema chunks"` matches spec
- [ ] `sqlite3 ~/.ralph-hero/knowledge.db "SELECT value FROM meta WHERE key='schema_version'"` returns `3`

**Creates for next phase**: `chunks` table ready to accept rows; `memory_tier` column ready to filter.

---

## Phase 2: GH-763 — RecursiveCharacterTextSplitter chunker module

- **depends_on**: null  # Pure module, no DB/schema dep

### Overview

New `chunker.ts` implementing LangChain-style recursive character splitting. Emits chunks with char offsets so downstream code can reconstruct positions. Pure module — no DB, no embeddings. Maps to GH-763.

### Tasks

#### Task 2.1: Create chunker.ts with type exports
- **files**: `plugin/ralph-knowledge/src/chunker.ts` (create)
- **tdd**: true
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] File exports `interface Chunk { index: number; content: string; charStart: number; charEnd: number }`
  - [ ] File exports `interface ChunkerOptions { chunkSize?: number; chunkOverlap?: number; separators?: string[] }`
  - [ ] File exports `function chunkText(text: string, opts?: ChunkerOptions): Chunk[]`
  - [ ] Default options: `chunkSize=2048`, `chunkOverlap=256`, `separators=["\n\n","\n",". "," ",""]`
  - [ ] Imports follow ESM style — no `.js` import extensions needed since this module has no internal imports

#### Task 2.2: Implement recursive splitting algorithm
- **files**: `plugin/ralph-knowledge/src/chunker.ts` (modify)
- **tdd**: true
- **complexity**: high
- **depends_on**: [2.1]
- **acceptance**:
  - [ ] Algorithm: split text by first separator; if a piece exceeds `chunkSize`, recurse into it with the next separator; accumulate pieces until the running total would exceed `chunkSize`, emit chunk, then start next chunk with last `chunkOverlap` chars of previous
  - [ ] `chunkText("")` returns `[]` (document: empty input -> empty output)
  - [ ] `chunkText("short doc")` returns one chunk with `charStart=0`, `charEnd="short doc".length`, `content="short doc"`
  - [ ] `text.slice(chunk.charStart, chunk.charEnd) === chunk.content` for every chunk produced
  - [ ] `charStart` values are monotonically non-decreasing across returned chunks
  - [ ] `chunk.content.length <= chunkSize + separator.length` (slack for boundary snapping)
  - [ ] Consecutive chunks overlap by `chunkOverlap` chars with tolerance +/-16 chars

#### Task 2.3: Unicode + code fence correctness tests
- **files**: `plugin/ralph-knowledge/src/__tests__/chunker.test.ts` (create)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [2.2]
- **acceptance**:
  - [ ] Test: empty string returns `[]`
  - [ ] Test: short doc returns single chunk with full coverage
  - [ ] Test: long doc (8K chars) with `chunkSize=2048` produces >=4 chunks
  - [ ] Test: overlap between chunks i and i+1 is `chunkOverlap` chars (tolerance +/-16)
  - [ ] Test: unicode fixture with emoji and CJK preserves character boundaries (no mojibake; `text.slice(start,end) === content`)
  - [ ] Test: code fence `\`\`\`typescript\n...\n\`\`\`` larger than chunkSize splits on outer `\n\n` boundaries, not inside the fence (use separator priority — `\n\n` first)
  - [ ] Test: custom separators parameter honored (e.g., `separators=["##","\n"]` splits on markdown headings first)
  - [ ] `npm test -- chunker.test.ts` passes

### Phase Success Criteria

#### Automated Verification:
- [ ] `npm run build` passes (TypeScript strict)
- [ ] `npm test -- chunker.test.ts` — all chunker test cases pass
- [ ] `npm test` — all existing tests still pass (no regression)

#### Manual Verification:
- [ ] Ad-hoc REPL: `import { chunkText } from "./dist/chunker.js"; console.log(chunkText(readFileSync("thoughts/.../some-doc.md", "utf-8")).length)` returns >= 4 for any thoughts doc > 4K chars

**Creates for next phase**: exported `chunkText()` and `Chunk` type consumed by embedder.

---

## Phase 3: GH-764 — Chunk-aware embedder + reindex persistence

- **depends_on**: [GH-762, GH-763]

### Overview

Add `embedDocument()` that emits one embedding per chunk; remove the 500-char slice from `embed()`; wire chunk persistence into reindex with `{doc_id}#c{index}` chunk ids. Maps to GH-764.

### Tasks

#### Task 3.1: Remove MAX_CHARS slice and export DocumentChunk type
- **files**: `plugin/ralph-knowledge/src/embedder.ts` (modify)
- **tdd**: true
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] `MAX_CHARS = 500` constant at [embedder.ts:7](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/embedder.ts#L7) removed
  - [ ] `.slice(0, MAX_CHARS)` at [embedder.ts:24](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/embedder.ts#L24) removed; `embed()` passes text directly (transformer's own 512-token window handles overflow)
  - [ ] New exported interface `DocumentChunk extends Chunk { embedding: Float32Array; contextPrefix?: string }` — imports `Chunk` from `./chunker.js`
  - [ ] Existing `prepareTextForEmbedding()` at [embedder.ts:32-43](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/embedder.ts#L32-L43) kept for back-compat (unused in new path, still exported)

#### Task 3.2: Implement embedDocument()
- **files**: `plugin/ralph-knowledge/src/embedder.ts` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [3.1]
- **acceptance**:
  - [ ] Signature: `export async function embedDocument(title: string, tags: string[], content: string, opts?: ChunkerOptions): Promise<DocumentChunk[]>`
  - [ ] Calls `chunkText(content, opts)` to get chunks
  - [ ] For each chunk, embeds `${title}\n${tagLine}\n${chunk.content}` where `tagLine = tags.join(", ")` (matches existing `prepareTextForEmbedding` shape)
  - [ ] Returns array of `DocumentChunk` with `{ index, content, charStart, charEnd, embedding }`
  - [ ] Short document (< chunkSize) yields exactly one chunk

#### Task 3.3: Test embedder chunk generation
- **files**: `plugin/ralph-knowledge/src/__tests__/embedder.test.ts` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [3.2]
- **acceptance**:
  - [ ] Existing tests for `embed()` still pass with slice removed
  - [ ] New test: `embedDocument("Title", ["tag"], "short content")` returns array of length 1 with non-null embedding
  - [ ] New test: `embedDocument("Title", [], longContent)` where longContent is 8K chars returns array with length >= 4
  - [ ] New test: embedding is a `Float32Array` of length 384 (assert `emb.length === 384`)

#### Task 3.4: Wire embedDocument into reindex with chunks persistence
- **files**: `plugin/ralph-knowledge/src/reindex.ts` (modify)
- **tdd**: true
- **complexity**: high
- **depends_on**: [3.1, 3.2]
- **acceptance**:
  - [ ] Import updated: `import { embedDocument } from "./embedder.js"` added; `import { prepareTextForEmbedding }` removed (no longer used)
  - [ ] At the current embed block [reindex.ts:133-139](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/reindex.ts#L133-L139), replace the single `embed(text)` + `vec.upsertEmbedding(parsed.id, embedding)` with:
    - `db.db.prepare('DELETE FROM chunks WHERE document_id = ?').run(parsed.id)`
    - `db.db.prepare('DELETE FROM documents_vec WHERE id GLOB ?').run(parsed.id + '#c%')`
    - loop over `await embedDocument(parsed.title, parsed.tags, parsed.content)`:
      - Insert chunk row: `INSERT INTO chunks (id, document_id, chunk_index, content, char_start, char_end) VALUES (?,?,?,?,?,?)` with id = `${parsed.id}#c${chunk.index}`
      - Insert vec row via `vec.upsertEmbedding(chunkId, chunk.embedding)`
  - [ ] Stale deletion at [reindex.ts:44-55](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/reindex.ts#L44-L55) requires update: replace `vec.deleteEmbedding(id)` call with a GLOB-based cascade deletion — add a method `deleteChunkVecsByDoc(docId)` to `VectorSearch` that runs `DELETE FROM documents_vec WHERE id GLOB ?` with pattern `${docId}#c%`; chunks themselves cascade via `ON DELETE CASCADE` on `chunks.document_id` when `deleteDocument(id)` runs
  - [ ] Progress log unchanged (existing `if (indexed % 50 === 0)` block)

#### Task 3.5: Add deleteChunkVecsByDoc to VectorSearch
- **files**: `plugin/ralph-knowledge/src/vector-search.ts` (modify)
- **tdd**: true
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] New method `deleteChunkVecsByDoc(docId: string): void` added to `VectorSearch` class
  - [ ] Method runs `DELETE FROM documents_vec WHERE id GLOB ?` with parameter `${docId}#c%`
  - [ ] Method calls `this.ensureVecLoaded()` first (matches pattern of sibling methods)
  - [ ] Existing `deleteEmbedding(id)` method retained for back-compat (used by tests)

#### Task 3.6: Update reindex test for chunk persistence
- **files**: `plugin/ralph-knowledge/src/__tests__/reindex.test.ts` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [3.4, 3.5]
- **acceptance**:
  - [ ] Test: after reindex of a fixture with one 8K-char markdown file, `SELECT COUNT(*) FROM chunks WHERE document_id=?` returns >= 4
  - [ ] Test: after reindex, `SELECT COUNT(*) FROM documents_vec` equals total chunk count across all docs
  - [ ] Test: all chunk ids follow pattern `^{docId}#c\d+$`
  - [ ] Test: stale deletion — delete source markdown file, re-run reindex, verify chunks for that doc removed via cascade

### Phase Success Criteria

#### Automated Verification:
- [ ] `npm run build` passes
- [ ] `npm test` — embedder.test.ts + reindex.test.ts + all existing tests pass
- [ ] Reindex against an 8K-char fixture doc produces >=4 chunks per doc

#### Manual Verification:
- [ ] Run `npm run reindex -- /Users/dubiel/projects/thoughts`; `sqlite3 ~/.ralph-hero/knowledge.db "SELECT COUNT(*) FROM chunks"` is >= 3x `SELECT COUNT(*) FROM documents`
- [ ] Chunk id pattern check: `sqlite3 ~/.ralph-hero/knowledge.db "SELECT id FROM chunks LIMIT 5"` returns ids shaped like `some-doc-name#c0`, `some-doc-name#c1`, ...

**Creates for next phase**: `chunks` + `documents_vec` populated with chunk-level rows that HybridSearch can query.

---

## Phase 4: GH-765 — HybridSearch chunk-to-doc dedup + snippet

- **depends_on**: [GH-764]

### Overview

Make HybridSearch aware that vector hits are now chunk-level; deduplicate to one entry per document while keeping the best-scoring chunk as the snippet source. FTS stays document-level. Maps to GH-765.

### Tasks

#### Task 4.1: Extend VectorSearch to return chunk content
- **files**: `plugin/ralph-knowledge/src/vector-search.ts` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] `interface VectorResult` extended with optional `content?: string` field (preserves back-compat for pre-chunks callers)
  - [ ] `search()` method at [vector-search.ts:57-70](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/vector-search.ts#L57-L70) updated SQL: `SELECT documents_vec.id, distance, chunks.content FROM documents_vec LEFT JOIN chunks ON chunks.id = documents_vec.id WHERE embedding MATCH ? AND k = ? ORDER BY distance`
  - [ ] `content` is populated when the vec id matches a chunks row; null/undefined when no match (keeps test fixtures working with doc-level ids)

#### Task 4.2: Test VectorSearch LEFT JOIN
- **files**: `plugin/ralph-knowledge/src/__tests__/vector-search.test.ts` (modify)
- **tdd**: true
- **complexity**: low
- **depends_on**: [4.1]
- **acceptance**:
  - [ ] Test: when `chunks` table has a row matching the vec id, `search()` returns `content` populated
  - [ ] Test: when no matching chunks row, `content` is null (back-compat preserved)

#### Task 4.3: Update HybridSearch to bucket by doc_id
- **files**: `plugin/ralph-knowledge/src/hybrid-search.ts` (modify)
- **tdd**: true
- **complexity**: high
- **depends_on**: [4.1]
- **acceptance**:
  - [ ] After vector search at [hybrid-search.ts:30](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/hybrid-search.ts#L30), loop over `vecResults` and split each `hit.id` on `#c` to derive `docId`
  - [ ] Build a `Map<docId, { bestRank: number; bestChunkId: string; bestContent: string }>` keeping only the entry with smallest rank index for each doc
  - [ ] Replace the vector-results RRF loop at [hybrid-search.ts:41-45](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/hybrid-search.ts#L41-L45) so that the RRF score is computed from the best-rank-per-doc bucket (bucket rank = index of first occurrence of that doc_id in the sorted vector result list)
  - [ ] When assembling `combined` results, populate `snippet` from the bucket's `bestContent` truncated to <=300 chars; for FTS-only hits, leave existing FTS snippet in place
  - [ ] RRF K=60 constant unchanged
  - [ ] When `hit.id` has no `#c` in it (back-compat with doc-level ids, e.g., from fixtures or pre-v3 vec rows), treat the entire id as `docId` and use `hit.id` as `bestChunkId`

#### Task 4.4: HybridSearch dedup + best-chunk tests
- **files**: `plugin/ralph-knowledge/src/__tests__/hybrid-search.test.ts` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [4.3]
- **acceptance**:
  - [ ] Test: 5 chunks from same doc all match query; result set contains exactly 1 entry for that doc
  - [ ] Test: surfaced entry's `snippet` comes from the highest-ranked chunk's content (smallest rank index)
  - [ ] Test: `snippet.length <= 300`
  - [ ] Test: title-only matching queries still return the same top document (no regression on legacy doc-level hits)
  - [ ] Test: RRF score for a doc with bucketed rank 0 + FTS rank 2 == `1/(60+1) + 1/(60+3)`

### Phase Success Criteria

#### Automated Verification:
- [ ] `npm run build` passes
- [ ] `npm test` — hybrid-search + vector-search tests + full suite pass
- [ ] No regression: existing `search.test.ts` cases still pass

#### Manual Verification:
- [ ] From Claude Code: `knowledge_search "chunking strategies recursive character"` returns a snippet drawn from the body of the doc, not the title or first paragraph
- [ ] Title-matching query returns identical top result as before the change

**Creates for next phase**: chunk-aware search works end-to-end without the LLM context layer; ready for Phase 5 to add contextualization.

---

## Phase 5: GH-766 — LLM client for Contextual Retrieval (Gemma @ localhost)

- **depends_on**: null  # Standalone module, no dependencies

### Overview

Standalone LLM client module with `available()` probe + `contextualize()` call. Native `fetch` with `AbortController` timeout. Fail-open on error. Maps to GH-766.

### Tasks

#### Task 5.1: Create llm-client.ts with type exports
- **files**: `plugin/ralph-knowledge/src/llm-client.ts` (create)
- **tdd**: true
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] File exports `interface LlmClientOptions { baseUrl?: string; model?: string; timeoutMs?: number }`
  - [ ] File exports `interface LlmClient { available(): Promise<boolean>; contextualize(fullDocument: string, chunkContent: string): Promise<string> }`
  - [ ] File exports `function createLlmClient(opts?: LlmClientOptions): LlmClient`
  - [ ] Default `baseUrl`: `process.env.RALPH_LLM_URL ?? "http://localhost:8000"`
  - [ ] Default `model`: `process.env.RALPH_LLM_MODEL ?? "mlx-community/gemma-4-26b-a4b-it-mxfp8"`
  - [ ] Default `timeoutMs`: `30000`

#### Task 5.2: Implement available() with 2s timeout probe
- **files**: `plugin/ralph-knowledge/src/llm-client.ts` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [5.1]
- **acceptance**:
  - [ ] `available()` issues `fetch(${baseUrl}/v1/models)` with `AbortController` scheduled to abort after 2000ms
  - [ ] Returns `true` only when response status is 200
  - [ ] Returns `false` on timeout, connection refused, non-200, or any thrown exception (try/catch around fetch)
  - [ ] No SDK deps — native Node fetch only

#### Task 5.3: Implement contextualize() with Anthropic prompt
- **files**: `plugin/ralph-knowledge/src/llm-client.ts` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [5.1]
- **acceptance**:
  - [ ] Prompt text is the verbatim Anthropic Contextual Retrieval template from parent plan Phase 2 (with `{fullDocument}` and `{chunkContent}` placeholders)
  - [ ] POST to `${baseUrl}/v1/chat/completions` with `{ model, messages: [{role:"user", content: prompt}], max_tokens: 120 }`
  - [ ] Content-Type `application/json`; `AbortController` with `timeoutMs`
  - [ ] On success: return `response.choices[0].message.content.trim()`
  - [ ] On any error (network, timeout, missing `.choices`, JSON parse error): return empty string `""` (fail-open)

#### Task 5.4: Test llm-client with mocked fetch
- **files**: `plugin/ralph-knowledge/src/__tests__/llm-client.test.ts` (create)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [5.2, 5.3]
- **acceptance**:
  - [ ] Test: `available()` returns `true` when mock fetch resolves with status 200
  - [ ] Test: `available()` returns `false` when mock fetch rejects with `AbortError` (simulate timeout)
  - [ ] Test: `available()` returns `false` when mock fetch returns status 404 or 500
  - [ ] Test: `available()` returns `false` when mock fetch throws `ECONNREFUSED`
  - [ ] Test: `contextualize("doc body", "chunk")` returns mocked content on happy path
  - [ ] Test: `contextualize()` returns `""` on timeout
  - [ ] Test: `contextualize()` returns `""` on malformed response (no `choices` key)
  - [ ] Test: custom `baseUrl` and `model` options honored (fetch called with those values)
  - [ ] Uses vitest's `vi.fn()` + global fetch stub pattern

### Phase Success Criteria

#### Automated Verification:
- [ ] `npm run build` passes
- [ ] `npm test -- llm-client.test.ts` — all cases pass

#### Manual Verification:
- [ ] With gemma-lab running at `http://localhost:8000`, ad-hoc call to `createLlmClient().available()` returns `true`
- [ ] With gemma-lab stopped, same call returns `false` within 2s

**Creates for next phase**: `LlmClient` type consumed by embedder; `available()` probe used at reindex startup.

---

## Phase 6: GH-767 — Wire contextual retrieval into embedder + reindex

- **depends_on**: [GH-764, GH-766]

### Overview

Integrate LLM client into chunk embedding flow. Per chunk: generate context via `llm.contextualize()`, prepend to embed text, persist to `chunks.context_prefix`. Gated by `RALPH_CONTEXTUAL_RETRIEVAL` (default on). Skip regeneration on cache hit. Maps to GH-767.

### Tasks

#### Task 6.1: Extend embedDocument() to accept LlmClient
- **files**: `plugin/ralph-knowledge/src/embedder.ts` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] `embedDocument` signature extends to `opts?: ChunkerOptions & { llm?: LlmClient }`
  - [ ] When `opts.llm` is present, for each chunk: call `contextPrefix = await opts.llm.contextualize(content, chunk.content)` (content = full doc)
  - [ ] Embed text becomes `${contextPrefix}\n${title}\n${tagLine}\n${chunk.content}` when `contextPrefix` is non-empty
  - [ ] When `contextPrefix` is empty string, embed text reverts to `${title}\n${tagLine}\n${chunk.content}` (no extra blank line)
  - [ ] Returned `DocumentChunk` includes `contextPrefix` field set to whatever `contextualize` returned (empty string on fail-open)

#### Task 6.2: Construct LLM client at reindex start + probe availability
- **files**: `plugin/ralph-knowledge/src/reindex.ts` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] Near the top of `reindex()` (before the "Phase 1: Discover files" log at [reindex.ts:32](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/reindex.ts#L32)), read `process.env.RALPH_CONTEXTUAL_RETRIEVAL` — treat as enabled unless literally `"0"` or `"false"`
  - [ ] If enabled, construct `llm = createLlmClient()`; call `const llmReady = await llm.available()`
  - [ ] If `llmReady === false`, log `"LLM endpoint unreachable at ${url}, contextual retrieval disabled for this run"` exactly once and set `llm = undefined` so downstream code skips contextualization
  - [ ] If flag disabled, skip the probe entirely and leave `llm = undefined`
  - [ ] Import `createLlmClient` from `./llm-client.js`

#### Task 6.3: Pass llm and persist context_prefix in reindex
- **files**: `plugin/ralph-knowledge/src/reindex.ts` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [6.1, 6.2]
- **acceptance**:
  - [ ] The `embedDocument(parsed.title, parsed.tags, parsed.content)` call established in Phase 3 changes to `embedDocument(parsed.title, parsed.tags, parsed.content, { llm })` (undefined when disabled)
  - [ ] The `INSERT INTO chunks` statement includes `context_prefix` and binds `chunk.contextPrefix ?? ""`
  - [ ] Progress log added: `if ((totalChunks % 50) === 0)` log `"${totalChunks} chunks embedded"` — maintain a local `totalChunks` counter incremented per inserted chunk

#### Task 6.4: Cache hit: reuse existing context_prefix on unchanged content
- **files**: `plugin/ralph-knowledge/src/reindex.ts` (modify)
- **tdd**: true
- **complexity**: high
- **depends_on**: [6.3]
- **acceptance**:
  - [ ] Before calling `embedDocument`, compute `contentHash = createHash("sha256").update(parsed.content).digest("hex").slice(0, 16)` using `node:crypto`
  - [ ] Store a `meta` row keyed as `content_hash:${doc.id}` with the hash on upsert; read prior hash first
  - [ ] If prior hash matches current hash AND `llm` is provided AND `chunks` already exist for this doc, build a `Map<chunkIndex, contextPrefix>` from the existing `chunks` rows and pass it to `embedDocument` via an additional `opts.cachedPrefixes?: Map<number, string>` parameter
  - [ ] In `embedDocument`, when `cachedPrefixes` is provided and has a value for `chunk.index`, skip the LLM call and use the cached prefix
  - [ ] After reindex completes for the doc, write the new `content_hash:${doc.id}` meta row
  - [ ] Note: the simpler alternative is doc-level mtime (already tracked in `sync` table) — if the current mtime skip at [reindex.ts:68-73](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/reindex.ts#L68-L73) already catches unchanged docs, the hash check is only needed when mtime differs but content is identical (rare). Implementer may opt to defer the content-hash logic and rely on mtime only; document this choice in a comment.

#### Task 6.5: Embedder test: context prefix stored + flag off skips LLM
- **files**: `plugin/ralph-knowledge/src/__tests__/embedder.test.ts` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [6.1]
- **acceptance**:
  - [ ] Test: `embedDocument(title, tags, content, { llm: mockLlm })` calls `mockLlm.contextualize` once per chunk
  - [ ] Test: mock LLM returning `"THIS IS CONTEXT"` causes `DocumentChunk.contextPrefix === "THIS IS CONTEXT"`
  - [ ] Test: mock LLM returning `""` (fail-open) produces `contextPrefix: ""` and embed text excludes the leading blank line
  - [ ] Test: with `cachedPrefixes` Map provided containing entries for chunk indices, mock LLM is NOT called for those chunks
  - [ ] Test: no `opts.llm` provided means no LLM interaction and `contextPrefix` is `""` or absent on every chunk

#### Task 6.6: Reindex test: flag off + unreachable endpoint paths
- **files**: `plugin/ralph-knowledge/src/__tests__/reindex.test.ts` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [6.2, 6.3]
- **acceptance**:
  - [ ] Test: with `RALPH_CONTEXTUAL_RETRIEVAL=0` in env, reindex completes without calling the mocked LLM client (verify call count)
  - [ ] Test: with flag on and mocked `available()` returning `false`, reindex completes; all `chunks.context_prefix` are empty strings; one warning matching `/LLM endpoint unreachable/` was logged
  - [ ] Test: with flag on and mocked LLM returning non-empty strings, `SELECT context_prefix FROM chunks` returns non-empty values
  - [ ] Uses existing vitest test infrastructure with tmp DB and small markdown fixtures

### Phase Success Criteria

#### Automated Verification:
- [ ] `npm run build` passes
- [ ] `npm test` — embedder + reindex + full suite pass

#### Manual Verification:
- [ ] With gemma-lab running, reindex of a 10-doc fixture produces non-empty `context_prefix` on every chunk (verify via `sqlite3 ... "SELECT context_prefix FROM chunks LIMIT 5"`)
- [ ] With gemma-lab stopped, reindex completes with empty `context_prefix` and exactly one `"LLM endpoint unreachable"` log line
- [ ] `RALPH_CONTEXTUAL_RETRIEVAL=0 npm run reindex` produces empty `context_prefix` and makes zero HTTP calls to localhost:8000

**Creates for next phase**: contextualized chunks embedded; ready to be filtered by memory_tier in Phase 8.

---

## Phase 7: GH-768 — `.ralphignore` + knowledge.config.json + scanner wiring

- **depends_on**: [GH-762]

### Overview

Add per-root `.ralphignore` (gitignore syntax) + optional `~/.ralph/knowledge.config.json` with roots and global ignore patterns. Precedence: CLI > env > config > fallback. Maps to GH-768.

### Tasks

#### Task 7.1: Add `ignore` npm dependency
- **files**: `plugin/ralph-knowledge/package.json` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] `dependencies` in `package.json` includes `"ignore": "^5.3.0"` (or latest stable at implementation time)
  - [ ] `npm install` succeeds; `node_modules/ignore/` exists
  - [ ] `package-lock.json` updated

#### Task 7.2: Create ignore.ts with loadIgnoreForRoot()
- **files**: `plugin/ralph-knowledge/src/ignore.ts` (create)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [7.1]
- **acceptance**:
  - [ ] Exports `interface IgnoreMatcher { isIgnored(relativePath: string): boolean }`
  - [ ] Exports `function loadIgnoreForRoot(rootDir: string, globalPatterns?: string[]): IgnoreMatcher`
  - [ ] Implementation: reads `${rootDir}/.ralphignore` via `readFileSync` if present; combines with `globalPatterns`; instantiates `ignore()` instance from the `ignore` package
  - [ ] Default global patterns (applied even without config): `.claude/`, `node_modules/`, `dist/`, `.git/`, `*.log`
  - [ ] `isIgnored()` delegates to `ign.ignores(relativePath)` on the ignore instance

#### Task 7.3: Test ignore.ts gitignore semantics
- **files**: `plugin/ralph-knowledge/src/__tests__/ignore.test.ts` (create)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [7.2]
- **acceptance**:
  - [ ] Test: glob pattern `**/node_modules/**` matches `foo/node_modules/bar.js`
  - [ ] Test: negation `!keep-me.md` overrides earlier `*.md`
  - [ ] Test: directory-only pattern `dist/` matches `dist/file.js` but not a file named `dist`
  - [ ] Test: `loadIgnoreForRoot(tmpDir, ["custom/**"])` honors caller-provided globals even when `.ralphignore` is absent
  - [ ] Test: missing `.ralphignore` file falls back to globals-only behavior (no thrown error)

#### Task 7.4: Create config.ts with loadConfig()
- **files**: `plugin/ralph-knowledge/src/config.ts` (create)
- **tdd**: true
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] Exports `interface KnowledgeConfig { roots?: string[]; ignorePatterns?: string[]; dbPath?: string }`
  - [ ] Exports `function loadConfig(): KnowledgeConfig`
  - [ ] Priority order for config file path: `process.env.RALPH_KNOWLEDGE_CONFIG` env var > `path.join(os.homedir(), ".ralph", "knowledge.config.json")`
  - [ ] Returns `{}` if no file present (no exception)
  - [ ] On file read, expands `~` prefixes in `roots[]` and `dbPath` to `os.homedir()` + rest
  - [ ] Malformed JSON caught; logs one warning; returns `{}`

#### Task 7.5: Test config.ts loading paths
- **files**: `plugin/ralph-knowledge/src/__tests__/config.test.ts` (create)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [7.4]
- **acceptance**:
  - [ ] Test: missing config file returns `{}`
  - [ ] Test: malformed JSON returns `{}` and logs warning (capture console.warn)
  - [ ] Test: tilde expansion: `{"roots":["~/thoughts"]}` produces absolute path with `os.homedir()` prefix
  - [ ] Test: `RALPH_KNOWLEDGE_CONFIG` env var override is honored (write fixture to tmp path, set env, call `loadConfig()`)

#### Task 7.6: Extend findMarkdownFiles to accept IgnoreMatcher
- **files**: `plugin/ralph-knowledge/src/file-scanner.ts` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [7.2]
- **acceptance**:
  - [ ] Signature updates to `findMarkdownFiles(dir: string, matcher?: IgnoreMatcher): string[]`
  - [ ] Walker computes `relativeToRoot = relative(dir, fullPath)` for each entry; skips when `matcher?.isIgnored(relativeToRoot)` returns true
  - [ ] Existing `.`/`_`-prefix skip retained as fast-path before matcher check
  - [ ] Back-compat: calling without matcher preserves existing behavior
  - [ ] `import { relative } from "node:path"` added

#### Task 7.7: Test file-scanner with .ralphignore
- **files**: `plugin/ralph-knowledge/src/__tests__/file-scanner.test.ts` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [7.6]
- **acceptance**:
  - [ ] Test: tmp directory with 3 `.md` files where one is covered by `.ralphignore` — `findMarkdownFiles(tmpDir, matcher)` returns 2
  - [ ] Test: directory excluded by pattern `subdir/**` has its children skipped even if they contain `.md`
  - [ ] Test: calling without matcher returns all `.md` files (back-compat)

#### Task 7.8: Update resolveDirs() precedence
- **files**: `plugin/ralph-knowledge/src/reindex.ts` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [7.4]
- **acceptance**:
  - [ ] `resolveDirs()` at [reindex.ts:185-206](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/reindex.ts#L185-L206) imports `loadConfig` and calls it once
  - [ ] New precedence order: (1) CLI positional args, (2) `RALPH_KNOWLEDGE_DIRS` env, (3) `config.roots`, (4) `"../../thoughts"` fallback
  - [ ] `dbPath` precedence: CLI `.db` arg > `process.env.RALPH_KNOWLEDGE_DB` > `config.dbPath` > `DEFAULT_DB_PATH`
  - [ ] Returns new field `config: KnowledgeConfig` so `reindex()` can forward `ignorePatterns`
  - [ ] Log line added: `console.log("Using roots from: CLI|env|config|fallback")` indicating the selected source

#### Task 7.9: Wire ignore matcher per-root into reindex()
- **files**: `plugin/ralph-knowledge/src/reindex.ts` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [7.2, 7.6, 7.8]
- **acceptance**:
  - [ ] `reindex()` accepts optional `ignorePatterns` (either via extended signature or from the extended `resolveDirs()` return shape)
  - [ ] For each root, `matcher = loadIgnoreForRoot(root, ignorePatterns)` built before `findMarkdownFiles(root, matcher)`
  - [ ] The `main()` branch at [reindex.ts:208-212](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/reindex.ts#L208-L212) forwards config.ignorePatterns to reindex

#### Task 7.10: Update reindex.test.ts precedence cases
- **files**: `plugin/ralph-knowledge/src/__tests__/reindex.test.ts` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [7.8]
- **acceptance**:
  - [ ] Test: CLI args beat env var even when both set
  - [ ] Test: env var beats config file roots
  - [ ] Test: config file roots beat fallback when CLI + env absent
  - [ ] Test: fallback used when all other sources absent

#### Task 7.11: Document config + .ralphignore in README
- **files**: `plugin/ralph-knowledge/README.md` (modify if exists, create if not)
- **tdd**: false
- **complexity**: low
- **depends_on**: [7.4]
- **acceptance**:
  - [ ] Section "Configuration" documents `~/.ralph/knowledge.config.json` path, schema, example with 3 roots + ignore patterns
  - [ ] Section "Ignoring files" documents `.ralphignore` with gitignore syntax example

### Phase Success Criteria

#### Automated Verification:
- [ ] `npm run build` passes
- [ ] `npm test` — new ignore/config tests + updated file-scanner/reindex tests pass
- [ ] `npm install` completes with `ignore` dep resolved

#### Manual Verification:
- [ ] Write `~/.ralph/knowledge.config.json` with 3 roots; run `npm run reindex`; log line shows `"Using roots from: config"` and all 3 roots appear in output
- [ ] Drop `.ralphignore` with `.claude/worktrees/**` into `ralph-hero/`; reindex; `sqlite3 ~/.ralph-hero/knowledge.db "SELECT COUNT(*) FROM documents WHERE path LIKE '%.claude/worktrees/%'"` returns 0
- [ ] `npm run reindex -- /Users/dubiel/projects/thoughts` still works (CLI override path)

**Creates for next phase**: persistent multi-root setup + ignore pattern support; independent of other phases.

---

## Phase 8: GH-769 — MCP tool extensions (memory_tier filter + knowledge_memory_stats)

- **depends_on**: [GH-762, GH-764]

### Overview

Extend `knowledge_search` Zod schema with `memory_tier` + `return_chunk_meta`; extend `knowledge_traverse` with `memory_tier`; add new `knowledge_memory_stats` tool. Maps to GH-769.

### Tasks

#### Task 8.1: Extend knowledge_search Zod schema + filter
- **files**: `plugin/ralph-knowledge/src/index.ts` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] `knowledge_search` schema at [index.ts:33-43](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/index.ts#L33-L43) adds `memory_tier: z.enum(["doc","raw","reflection","any"]).optional().default("any")` and `return_chunk_meta: z.boolean().optional().default(false)`
  - [ ] Handler at [index.ts:44-67](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/index.ts#L44-L67) passes `memory_tier` into the hybrid search path (via new `SearchOptions.memoryTier?` field added in Task 8.2)
  - [ ] When `return_chunk_meta=true`, each result is enriched with `chunk_index`, `char_start`, `char_end`, `context_prefix` (looked up via chunk id extracted from best-chunk-id stored on the search path — requires `HybridSearch` to expose best-chunk-id on results)

#### Task 8.2: Thread memoryTier through SearchOptions + HybridSearch
- **files**: `plugin/ralph-knowledge/src/search.ts` (modify), `plugin/ralph-knowledge/src/hybrid-search.ts` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] `interface SearchOptions` in [search.ts:3-8](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/search.ts#L3-L8) gains `memoryTier?: "doc" | "raw" | "reflection" | "any"`
  - [ ] `FtsSearch.search()` at [search.ts:102](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/search.ts#L102) adds `AND d.memory_tier = @memoryTier` to conditions when `memoryTier` is set and not `"any"`; params.memoryTier set accordingly
  - [ ] `HybridSearch.search()` in `hybrid-search.ts` forwards `memoryTier` to `fts.search()` and post-filters vector-only results by re-fetching `doc.memory_tier` (when `memoryTier !== "any"`, skip docs whose memory_tier differs)
  - [ ] `SearchResult` (search.ts) gains optional fields `chunkIndex?`, `charStart?`, `charEnd?`, `contextPrefix?`, `bestChunkId?` — populated from the HybridSearch bucket when chunk data is available

#### Task 8.3: Extend knowledge_traverse schema
- **files**: `plugin/ralph-knowledge/src/index.ts` (modify)
- **tdd**: true
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] `knowledge_traverse` schema at [index.ts:70-79](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/index.ts#L70-L79) adds `memory_tier: z.enum(["doc","raw","reflection","any"]).optional().default("any")`
  - [ ] Handler post-filters the traverse result set by looking up `doc.memory_tier` for each id, dropping those that don't match when `memory_tier !== "any"`
  - [ ] Add a helper on `KnowledgeDB` (`getMemoryTier(id: string): string | undefined` — selects the `memory_tier` column) so `index.ts` doesn't have to rewrite SQL

#### Task 8.4: Implement knowledge_memory_stats tool
- **files**: `plugin/ralph-knowledge/src/index.ts` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] `server.tool("knowledge_memory_stats", ...)` registered with Zod schema `{ since: z.string().optional() }`
  - [ ] Default `since` is 24h ago (`new Date(Date.now() - 24*3600*1000).toISOString()`)
  - [ ] Returns JSON with keys: `total_documents`, `by_tier` (object keyed doc/raw/reflection), `new_since` (object same shape counting docs where `documents.date >= since`), `chunks_per_doc_p50`, `chunks_per_doc_p90`, `last_reflection_at`
  - [ ] `last_reflection_at` = ISO timestamp of most-recent document with `memory_tier='reflection'`, or `null` when none exist
  - [ ] `chunks_per_doc_p50`/`_p90` computed from `SELECT COUNT(*) FROM chunks GROUP BY document_id` with in-JS percentile math (sort, pick index at floor(n*0.5) and floor(n*0.9))

#### Task 8.5: Test memory_tier filter + stats tool
- **files**: `plugin/ralph-knowledge/src/__tests__/index.test.ts` (modify), `plugin/ralph-knowledge/src/__tests__/memory-stats.test.ts` (create)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [8.1, 8.2, 8.3, 8.4]
- **acceptance**:
  - [ ] `index.test.ts`: seed 3 docs with memory_tier `doc`, `raw`, `reflection`; `knowledge_search` with `memory_tier=reflection` returns only the reflection doc
  - [ ] `index.test.ts`: `memory_tier="any"` returns all three
  - [ ] `index.test.ts`: `return_chunk_meta=true` produces a payload with `chunk_index` populated for at least one hit
  - [ ] `index.test.ts`: `knowledge_traverse` with `memory_tier=reflection` filter drops non-reflection nodes from results
  - [ ] `memory-stats.test.ts`: seed a fixture with known tier counts; assert `by_tier.doc=X`, `by_tier.raw=Y`, `by_tier.reflection=Z`
  - [ ] `memory-stats.test.ts`: `chunks_per_doc_p50` on a fixture with chunk counts `[1,2,3,4,5]` returns `3`
  - [ ] `memory-stats.test.ts`: empty reflection set produces `last_reflection_at: null`

### Phase Success Criteria

#### Automated Verification:
- [ ] `npm run build` passes
- [ ] `npm test` — index.test.ts, memory-stats.test.ts, and full suite pass

#### Manual Verification:
- [ ] From Claude Code (with MCP server reloaded): `knowledge_memory_stats` returns expected shape; `knowledge_search` with `memory_tier=reflection` runs against an empty reflection set and returns `[]` without error

**Creates for next phase**: MCP surface that dream-loop scripts can invoke to confirm ingest + reflection completed.

---

## Phase 9: GH-770 — Dream-loop ingester (gemma-lab + git + llm-cli)

- **depends_on**: [GH-769]

### Overview

Python + `uv` project at `scripts/dream/`. Pulls last 24h of raw memories from three sources and writes them as `memory_tier=raw` markdown files with idempotent hash-based filenames. Triggers reindex at end. Maps to GH-770.

### Tasks

#### Task 9.1: Create Python project scaffold
- **files**: `scripts/dream/pyproject.toml` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] `[project]` block: `name="ralph-dream"`, `version="0.1.0"`, `requires-python=">=3.11"`
  - [ ] `dependencies`: `httpx>=0.27`, `hdbscan>=0.8.38`, `umap-learn>=0.5.6`, `numpy>=2.0`, `pyyaml>=6.0`
  - [ ] `[project.optional-dependencies]` includes `test = ["pytest>=8.0"]`
  - [ ] `uv sync` completes in `scripts/dream/` without network errors at install time

#### Task 9.2: Create config.yaml template
- **files**: `scripts/dream/config.yaml` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] Keys: `base_dir`, `gemma_lab_sessions`, `llm_cli_db`, `git_repos` (list of paths)
  - [ ] `base_dir`: `/Users/dubiel/projects/thoughts/dream-memories`
  - [ ] `gemma_lab_sessions`: `/Users/dubiel/projects/gemma-lab/sessions`
  - [ ] `llm_cli_db`: `~/.llm/logs.db`
  - [ ] `git_repos`: list with `/Users/dubiel/projects/ralph-hero`, `/Users/dubiel/projects/ralph-engine`, `/Users/dubiel/projects/gemma-lab`

#### Task 9.3: Implement RawMemory dataclass + write_memory()
- **files**: `scripts/dream/ingest.py` (create)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [9.1]
- **acceptance**:
  - [ ] `@dataclass RawMemory` with fields: `source`, `source_id`, `timestamp` (ISO str), `content`, optional `tags`
  - [ ] `write_memory(m: RawMemory, base_dir: Path) -> Path` — computes `hashlib.sha1(f"{m.source}:{m.source_id}".encode()).hexdigest()[:12]` for idempotent filename
  - [ ] Filename pattern: `${base_dir}/YYYY/MM/DD/${m.source}-${hash}.md`
  - [ ] Parent dirs created with `mkdir(parents=True, exist_ok=True)`
  - [ ] Frontmatter written with keys: `date`, `memory_tier: raw`, `source`, `source_id`, `tags` (default `[dream, raw]`)
  - [ ] Body is `m.content` verbatim after the frontmatter block

#### Task 9.4: Implement ingest_gemma_lab_sessions()
- **files**: `scripts/dream/ingest.py` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [9.3]
- **acceptance**:
  - [ ] Signature: `def ingest_gemma_lab_sessions(since: datetime, sessions_dir: Path) -> list[RawMemory]`
  - [ ] Reads `*.jsonl` files under `sessions_dir` matching the last 24h
  - [ ] Each line parsed as JSON with at least `{"ts": ISO, "prompt": str, "response": str}`; filters by `ts >= since`
  - [ ] Each entry yields one `RawMemory` with `source="gemma-lab"`, `source_id=<line_number or ts>`, `content="## Prompt\n\n{prompt}\n\n## Response\n\n{response}"`
  - [ ] Missing `sessions_dir` returns `[]` and logs a single info line

#### Task 9.5: Implement ingest_git_commits()
- **files**: `scripts/dream/ingest.py` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [9.3]
- **acceptance**:
  - [ ] Signature: `def ingest_git_commits(since: datetime, repos: list[Path]) -> list[RawMemory]`
  - [ ] For each repo, shells out to `git log --since=<ISO> --format=%H|%ai|%s --patch -p --stat -n 50`
  - [ ] Parses blocks; each commit yields `RawMemory(source="git-commit", source_id=<sha>, content="# {subject}\n\n{patch-summary}")`
  - [ ] Non-existent repo path returns `[]` for that repo with a single warn log
  - [ ] Truncates patch content at 4K chars (we want summaries, not full diffs)

#### Task 9.6: Implement ingest_llm_cli_logs()
- **files**: `scripts/dream/ingest.py` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [9.3]
- **acceptance**:
  - [ ] Signature: `def ingest_llm_cli_logs(since: datetime, db_path: Path | None) -> list[RawMemory]`
  - [ ] When `db_path` is None or file does not exist: return `[]` and log single info line
  - [ ] When present: open sqlite, read `SELECT id, datetime_utc, prompt, response FROM responses WHERE datetime_utc >= ?` with `since` param
  - [ ] Each row yields `RawMemory(source="llm-cli", source_id=<id>, ...)`

#### Task 9.7: Implement CLI entry point
- **files**: `scripts/dream/ingest.py` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [9.4, 9.5, 9.6]
- **acceptance**:
  - [ ] `argparse`: `--since` (str like "24h" / "3d" / ISO), `--base-dir` (overrides config), `--config` (yaml path), dry-run flag
  - [ ] `--since 24h` parses to `datetime.now(tz=UTC) - timedelta(hours=24)`
  - [ ] Runs all three ingesters, collects memories, calls `write_memory` for each, prints summary: `"Wrote N memories from {sources}"`
  - [ ] At end, shells out to `npm --prefix /Users/dubiel/projects/ralph-hero/plugin/ralph-knowledge run reindex` (configurable via config.yaml key `reindex_cmd`)
  - [ ] `--dry-run` skips writes and reindex; prints counts only

#### Task 9.8: Test ingest with fixtures
- **files**: `scripts/dream/tests/test_ingest.py` (create)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [9.3, 9.4, 9.5, 9.6]
- **acceptance**:
  - [ ] `tests/fixtures/sessions/2026-04-19.jsonl` with 5 entries created for test
  - [ ] Test: `ingest_gemma_lab_sessions` with fixture returns 5 `RawMemory` objects
  - [ ] Test: `ingest_git_commits` against a throwaway git repo created in a pytest tmp dir (init repo, create 2 commits) returns 2 memories
  - [ ] Test: `ingest_llm_cli_logs` with `db_path=Path("/nonexistent")` returns `[]` without exception
  - [ ] Test: `write_memory` called twice with same `RawMemory` produces same file path with same content (idempotency)
  - [ ] Running via `uv run pytest tests/` passes

### Phase Success Criteria

#### Automated Verification:
- [ ] `uv sync` in `scripts/dream/` succeeds
- [ ] `uv run pytest scripts/dream/tests/` passes
- [ ] `uv run ingest.py --dry-run --since 24h` prints summary line without writes

#### Manual Verification:
- [ ] `uv run ingest.py --since 24h`: files appear in `thoughts/dream-memories/YYYY/MM/DD/`
- [ ] Re-running immediately: no duplicate files (hash-based filenames stable)
- [ ] After reindex trigger: `knowledge_memory_stats` (via MCP) returns `by_tier.raw > 0`

**Creates for next phase**: raw memories indexed and searchable by `memory_tier=raw`; ready for reflection clustering.

---

## Phase 10: GH-771 — Dream-loop reflection synthesis (HDBSCAN + Gemma)

- **depends_on**: [GH-770]

### Overview

Python script that clusters raw memories via HDBSCAN on UMAP-reduced embeddings, asks Gemma for per-cluster reflections, writes `memory_tier=reflection` markdown files with `builds_on::` links back to source raw memories. Maps to GH-771.

### Tasks

#### Task 10.1: Implement fetch_recent_raw_memories()
- **files**: `scripts/dream/reflect.py` (create)
- **tdd**: true
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] Signature: `def fetch_recent_raw_memories(db_path: Path, since: datetime) -> list[dict]` where each dict has `id`, `content`, `path`, `date`, `embedding` (numpy array of len 384)
  - [ ] Reads directly from sqlite (`better-sqlite3` not needed in Python — use `sqlite3` stdlib)
  - [ ] Joins `documents` + `chunks` + `documents_vec` (via `sqlite-vec` extension loaded through `vec0` virtual table; use `sqlite_vec` Python package)
  - [ ] Mean-pools chunk embeddings per document (one vector per document)
  - [ ] Filters `documents.memory_tier='raw' AND documents.date >= since`

#### Task 10.2: Implement cluster_memories()
- **files**: `scripts/dream/reflect.py` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [10.1]
- **acceptance**:
  - [ ] Signature: `def cluster_memories(memories: list[dict]) -> list[list[dict]]` — returns list of clusters, each cluster is a list of memory dicts
  - [ ] Stacks embeddings to `(N, 384)` numpy array; UMAP-reduces with `n_neighbors=15, min_dist=0.1, n_components=50`
  - [ ] HDBSCAN with `min_cluster_size=5, min_samples=3`
  - [ ] Noise points (label == -1) discarded
  - [ ] Returns one list per non-noise cluster label, sorted by cluster size descending

#### Task 10.3: Implement synthesize_reflection()
- **files**: `scripts/dream/reflect.py` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [10.2]
- **acceptance**:
  - [ ] Signature: `def synthesize_reflection(cluster: list[dict], llm_url: str, model: str) -> dict | None`
  - [ ] Builds prompt using the A-Mem template from parent plan Phase 6 (verbatim structure)
  - [ ] Posts to `${llm_url}/v1/chat/completions` with `max_tokens=1500`, `timeout=60`
  - [ ] Parses LLM response: expects YAML frontmatter + markdown body
  - [ ] Returns dict: `{title, summary, insights (list), source_ids (list), cluster_size}`
  - [ ] On parse error or network failure: returns `None` and logs single warning (no reflection written)

#### Task 10.4: Implement write_reflection()
- **files**: `scripts/dream/reflect.py` (modify)
- **tdd**: true
- **complexity**: low
- **depends_on**: [10.3]
- **acceptance**:
  - [ ] Signature: `def write_reflection(r: dict, base_dir: Path) -> Path`
  - [ ] File path: `${base_dir}/reflections/YYYY/MM/DD/${slugified-title}.md`
  - [ ] Slugify title to ASCII kebab-case (truncate to 60 chars)
  - [ ] Frontmatter: `date`, `memory_tier: reflection`, `source: dream-loop`, `cluster_size`, `source_ids` (list), `tags: [dream, reflection]`
  - [ ] Body: `# {title}\n\n## Summary\n{summary}\n\n## Insights\n- ...\n\n## Links\n- builds_on:: [[{source_id}]]\n...` (one line per source)

#### Task 10.5: CLI entry point for reflect.py
- **files**: `scripts/dream/reflect.py` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [10.1, 10.2, 10.3, 10.4]
- **acceptance**:
  - [ ] `argparse`: `--since`, `--db-path`, `--base-dir`, `--llm-url`, `--model`, `--dry-run`
  - [ ] Reads config.yaml for defaults
  - [ ] `--dry-run` prints cluster count + titles without invoking LLM or writing files
  - [ ] After each reflection written, appends path to summary log

#### Task 10.6: Test reflect.py on fixture embeddings
- **files**: `scripts/dream/tests/test_reflect.py` (create)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [10.1, 10.2, 10.3, 10.4]
- **acceptance**:
  - [ ] Fixture: seed sqlite DB with 15 raw memories; manually craft embeddings so 2 clusters are separable (e.g., 8 memories near `[1,0,0,...]`, 7 near `[0,1,0,...]`)
  - [ ] Test: `cluster_memories(fixture)` returns 2 clusters (noise discarded)
  - [ ] Test: `synthesize_reflection` with mock LLM returning well-formed YAML produces parseable dict
  - [ ] Test: `synthesize_reflection` with mock returning garbage returns `None`
  - [ ] Test: `write_reflection` creates correctly structured file with `builds_on::` wikilinks matching `source_ids`
  - [ ] `--dry-run` prints expected cluster count without writes

### Phase Success Criteria

#### Automated Verification:
- [ ] `uv run pytest scripts/dream/tests/test_reflect.py` passes
- [ ] `uv run reflect.py --dry-run --since 24h` on seeded fixture DB prints expected cluster count

#### Manual Verification:
- [ ] `uv run ingest.py --since 24h && uv run reflect.py --since 24h` produces >=1 reflection file
- [ ] Reflection file frontmatter + body are parseable; `builds_on::` links resolve to real raw memory ids
- [ ] `knowledge_search` with `memory_tier=reflection` from Claude Code returns the new reflection

**Creates for next phase**: end-to-end raw -> reflection pipeline that launchd can schedule.

---

## Phase 11: GH-772 — launchd plist template + log rotation

- **depends_on**: [GH-770, GH-771]

### Overview

Commit a launchd plist template (lives in repo; installed copy goes to `~/Library/LaunchAgents/`) that fires ingest + reflect nightly at 03:00. Adds `logrotate.sh` capping output logs at 1000 lines. README documents install. Maps to GH-772.

### Tasks

#### Task 11.1: Create launchd plist template
- **files**: `scripts/dream/launchd/com.dubiel.dream-loop.plist.template` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] Valid XML plist structure with `Label=com.dubiel.dream-loop`
  - [ ] `ProgramArguments`: `["/bin/bash", "-lc", "cd /Users/dubiel/projects/ralph-hero/scripts/dream && uv run ingest.py --since 24h && uv run reflect.py --since 24h && ./logrotate.sh"]`
  - [ ] `StartCalendarInterval` dict with `Hour=3`, `Minute=0`
  - [ ] `StandardOutPath=/tmp/dream-loop.out`, `StandardErrorPath=/tmp/dream-loop.err`
  - [ ] `EnvironmentVariables` dict sets `PATH=/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin`, `RALPH_KNOWLEDGE_CONFIG=/Users/dubiel/.ralph/knowledge.config.json`, `RALPH_LLM_URL=http://localhost:8000`
  - [ ] `plutil -lint scripts/dream/launchd/com.dubiel.dream-loop.plist.template` succeeds

#### Task 11.2: Create logrotate.sh
- **files**: `scripts/dream/logrotate.sh` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] Script begins with `#!/usr/bin/env bash`
  - [ ] Uses `tail -n 1000` pattern applied atomically via tmp file + `mv` for both `/tmp/dream-loop.out` and `/tmp/dream-loop.err`
  - [ ] File is set executable (`chmod +x`) — verify via git `ls-files --stage` showing `100755`
  - [ ] Running `./logrotate.sh` on a 5000-line tmp file reduces it to 1000 lines

#### Task 11.3: Create scripts/dream/README.md with install steps
- **files**: `scripts/dream/README.md` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: [11.1, 11.2]
- **acceptance**:
  - [ ] Section "Install" contains absolute-path copy command: `cp scripts/dream/launchd/com.dubiel.dream-loop.plist.template ~/Library/LaunchAgents/com.dubiel.dream-loop.plist`
  - [ ] Section documents `launchctl load ~/Library/LaunchAgents/com.dubiel.dream-loop.plist` and `launchctl start com.dubiel.dream-loop` for immediate test
  - [ ] Section "Verify": `launchctl list | grep dream-loop` expected output snippet
  - [ ] Section "Logs": `/tmp/dream-loop.out` and `.err` locations; mention 1000-line cap from logrotate.sh
  - [ ] Section "Uninstall": `launchctl unload` command

#### Task 11.4: Wire logrotate into launchd job
- **files**: `scripts/dream/launchd/com.dubiel.dream-loop.plist.template` (modify if needed)
- **tdd**: false
- **complexity**: low
- **depends_on**: [11.1, 11.2]
- **acceptance**:
  - [ ] `ProgramArguments` bash command ends with `&& /Users/dubiel/projects/ralph-hero/scripts/dream/logrotate.sh`
  - [ ] After one full launchd fire, `wc -l /tmp/dream-loop.out` returns <= 1000

### Phase Success Criteria

#### Automated Verification:
- [ ] `plutil -lint scripts/dream/launchd/com.dubiel.dream-loop.plist.template` passes
- [ ] `ls -l scripts/dream/logrotate.sh` shows executable bit set
- [ ] `bash scripts/dream/logrotate.sh` runs without error on an empty or large tmp file (cover both via quick smoke test in CI script if added)

#### Manual Verification:
- [ ] Copy template to `~/Library/LaunchAgents/com.dubiel.dream-loop.plist`; `launchctl load` succeeds
- [ ] `launchctl list | grep com.dubiel.dream-loop` shows agent with next-fire timestamp
- [ ] `launchctl start com.dubiel.dream-loop` triggers immediate run; `/tmp/dream-loop.out` shows ingest + reflect output
- [ ] Real 03:00 fire the next day writes new reflections; `knowledge_memory_stats.last_reflection_at` is within last 24h

**Creates for next phase**: nightly scheduling complete; no further phases.

---

## Integration Testing

- [ ] End-to-end: fresh DB -> reindex with Phase 1-3 changes -> verify `chunks` count -> enable Phase 6 contextual retrieval -> verify `context_prefix` populated -> ingest 24h of raw memories via Phase 9 -> reflect via Phase 10 -> query reflections via Phase 8 MCP tools
- [ ] Launchd: install plist -> trigger manual `launchctl start` -> verify both ingest and reflect complete -> check log rotation

## References

- Parent plan: [thoughts/shared/plans/2026-04-16-GH-0761-ralph-knowledge-chunked-embeddings-dream-loop.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-04-16-GH-0761-ralph-knowledge-chunked-embeddings-dream-loop.md)
- Epic issue: https://github.com/cdubiel08/ralph-hero/issues/761
- Child issues: https://github.com/cdubiel08/ralph-hero/issues/762 through https://github.com/cdubiel08/ralph-hero/issues/772
- Contextual Retrieval: https://www.anthropic.com/news/contextual-retrieval
- A-Mem paper: https://arxiv.org/abs/2502.12110
- sqlite-vec: https://github.com/asg017/sqlite-vec
- launchd `StartCalendarInterval`: https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/ScheduledJobs.html
- Canonical source paths: [plugin/ralph-knowledge/src/](https://github.com/cdubiel08/ralph-hero/tree/main/plugin/ralph-knowledge/src) (`db.ts`, `embedder.ts`, `reindex.ts`, `hybrid-search.ts`, `vector-search.ts`, `file-scanner.ts`, `search.ts`, `index.ts`)
