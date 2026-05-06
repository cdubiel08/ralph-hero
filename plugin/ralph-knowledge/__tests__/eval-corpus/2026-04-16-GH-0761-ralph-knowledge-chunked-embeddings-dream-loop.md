---
date: 2026-04-16
status: draft
type: plan
tags: [ralph-knowledge, chunking, embeddings, mcp, dream-loop, local-llm, contextual-retrieval, memory-layer, gemma-4, launchd]
github_issue: 761
github_issues: [761]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/761
primary_issue: 761
---

# ralph-knowledge Chunked Embeddings + Contextual Retrieval + Dream-Loop Foundation

## Prior Work

- builds_on:: [[2026-04-16-local-llm-delivery-truth-personal-dreams-team-memory]]
- builds_on:: [[2026-03-28-ralph-knowledge-multi-project-architecture]]
- builds_on:: [[2026-03-26-ralph-knowledge-architecture-for-engine-parity]]
- builds_on:: [[2026-03-24-knowledge-graph-plugin-comparison]]
- builds_on:: [[2026-03-27-group-GH-247-knowledge-persistence-parity]]

## Overview

Three coupled improvements to `ralph-hero/plugin/ralph-knowledge`, plus a new dream-loop that uses the improved substrate:

1. **Chunked embeddings** — replace 500-char prefix truncation with recursive 512-token chunks (+64 overlap), enabling full-document semantic search over 3–8K char research corpus.
2. **Contextual Retrieval** — prepend 50–100 token Gemma-4-generated context to each chunk before embedding, flag-on by default with graceful fallback when the local LLM is unreachable.
3. **Multi-root ergonomics** — add `.ralphignore` support and a standard config pattern so the three project `thoughts/` roots index cleanly without per-session env var juggling.
4. **Dream-loop** — nightly Python job pulls raw memories (gemma-lab sessions, git commits, existing corpus), clusters with HDBSCAN, asks Gemma 4 26B for per-cluster reflections, writes them back as `memory_tier=reflection` documents. Scheduled via launchd.

This is a single plan because the dream-loop is the acceptance test for the chunking + MCP extensions: reflections are multi-paragraph, the corpus is long-form, and retrieval has to work end-to-end from Claude Code.

## Current State Analysis

Canonical implementation lives at `/Users/dubiel/projects/ralph-hero/plugin/ralph-knowledge/` (not ralph-engine — that is a downstream port).

### What works today

- **MCP server**: `index.ts:3,179` wires `StdioServerTransport` with `@modelcontextprotocol/sdk ^1.26.0`. 11 tools registered: `knowledge_search`, `knowledge_traverse`, `knowledge_record_outcome`, `knowledge_query_outcomes`, plus 7 graph tools (`graph-tools.ts:176,326,452,568,637,722,799`). Exposed as `mcp__plugin_ralph-knowledge_*` in Claude Code.
- **Hybrid search**: `hybrid-search.ts:8,35-45` with RRF K=60. Document-level results only.
- **Vector store**: `vector-search.ts:26-33` declares `documents_vec` as `vec0(id TEXT PRIMARY KEY, embedding float[384] distance_metric=cosine)`.
- **Schema + migrations**: `db.ts:103-163` `createSchema()`. Migration pattern via `meta.schema_version` key (`reindex.ts:22-30, 151-153`). Current version: `"2"`.
- **Multi-root via env var**: `reindex.ts:185-206` `resolveDirs()` accepts `RALPH_KNOWLEDGE_DIRS` (comma-split) OR CLI positional args, falls back to `../../thoughts` relative to cwd. **This already works** — it is just undiscoverable.
- **Mtime incremental**: `reindex.ts:66-73` skips unchanged files. Stale deletion at `reindex.ts:44-55` drops `documents` / FTS / `documents_vec` / `sync` rows when a file disappears.
- **Tests**: 13 vitest files under `src/__tests__/` cover every major module.
- **Typed wikilinks**: `parser.ts:32,58-89` extracts `builds_on::`, `tensions::`, `post_mortem::` plus untyped `[[link]]` with paragraph context.

### Gaps that break the research corpus

1. **500-char prefix truncation** (`embedder.ts:7,24`): `prepareTextForEmbedding` (`embedder.ts:32-43`) concatenates `title + tagLine + firstParagraph` and slices at 500 chars. For 3–8K char research docs, everything past the first paragraph is invisible to vector search.
2. **No chunk support in schema** (`db.ts:103-163`): one row per document in `documents`, one row per doc in `documents_vec`, one row per doc in `documents_fts`. No way to store multiple embeddings per document.
3. **No `.ralphignore` / gitignore awareness** (`file-scanner.ts:4-18`): only skips `.`/`_`-prefixed entries. Ephemeral agent worktrees under `ralph-hero/.claude/worktrees/agent-*` would be indexed if the user added that root.
4. **No `memory_tier` column**: dream-loop reflections need to be distinguishable from raw memories so the LLM can query "show me only reflections about X" or weigh them differently.
5. **No config file**: only `RALPH_KNOWLEDGE_DIRS` env var (`reindex.ts:196-203`) — invisible at session start, lost if shell is reset.

### Key discoveries

- `meta` table with `schema_version` gives us clean forward migrations (`reindex.ts:22-30`). Bumping to `"3"` triggers full reindex automatically.
- `outcome_events` table (`db.ts:130-145`) is a template for how auxiliary tables are structured — but reflection telemetry should go in its own `reflection_runs` table, not blend with outcome events.
- `embed()` returns raw `Float32Array` (`embedder.ts:29`) — no hard-coded 384. Dim lives only in `vector-search.ts:29`. Future embedder swap (BGE-small same dim, or Nomic 768-dim with migration) is narrow in scope.
- Gemma 4 26B MoE is live at `http://localhost:8000` (`gemma-lab/.env`, `scripts/start-server.sh`) with OpenAI-compatible `/v1/chat/completions`. 262K context, ~75 tok/s. Fast enough for per-chunk context generation.
- `gemma-lab/sessions/YYYY-MM-DD.jsonl` already logs every `ask.sh` call — free dream-loop source with zero instrumentation.
- `~/.llm/logs.db` is available if we install `simonw/llm` (not currently installed).

## Desired End State

After this plan:

1. `knowledge_search "reflection loop HDBSCAN"` returns snippets from chunk-level matches inside research docs, not just title/first-paragraph matches.
2. Schema version is `"3"`; `chunks` table populated with ~6–16 chunks per long document; every chunk has a `context_prefix` if `RALPH_LLM_URL` is reachable, empty string if not.
3. `~/.ralph/knowledge.config.json` documents scan roots and ignore patterns. `.ralphignore` files at root dirs override for path-local exclusions.
4. `scripts/dream-ingest.py` runs on demand and during the nightly job; pulls 24h of gemma-lab sessions, git commits, and optionally `llm` CLI logs into ralph-knowledge as `memory_tier=raw` documents.
5. `scripts/dream-reflect.py` clusters the last 24h of raw memories, asks Gemma 4 26B for one reflection per cluster, stores them as `memory_tier=reflection` documents with `builds_on::` links to source raw memories.
6. `~/Library/LaunchAgents/com.dubiel.dream-loop.plist` runs the ingester + reflector at 3 AM daily with `StartCalendarInterval` (survives sleep).
7. From Claude Code, `knowledge_search "what did I work on this week" --memory_tier reflection` returns reflections covering last 7 days.

### Verification

- `npm run build && npm test` in `plugin/ralph-knowledge` passes.
- `npm run reindex -- ~/.ralph-hero/knowledge.db /Users/dubiel/projects/thoughts` completes; `sqlite3 knowledge.db "SELECT COUNT(*) FROM chunks"` is > 3× `SELECT COUNT(*) FROM documents`.
- Manual query from Claude Code via MCP returns chunk-level snippets from a known long research doc.
- After one manual dream-loop run, `SELECT id, title FROM documents WHERE memory_tier='reflection' ORDER BY date DESC LIMIT 5` returns 1–5 reflections with source links.
- `launchctl list | grep com.dubiel.dream-loop` shows the agent loaded; next fire timestamp is tomorrow at 03:00.

## What We're NOT Doing

Explicitly out of scope:

- **Embedding model swap** (BGE-small-en-v1.5 / Nomic / EmbeddingGemma). Keep `Xenova/all-MiniLM-L6-v2` 384-dim. Model swap is a separate follow-up plan — trivial once chunks exist.
- **Per-project DB isolation**. Global `~/.ralph-hero/knowledge.db` stays. Open question #2 from the research doc is deferred.
- **Git `worktree list --porcelain` auto-discovery**. Multi-root is already supported; `.ralphignore` + config file is the complete ergonomic fix. Git shell-outs add fragility and risk indexing ephemeral agent worktrees.
- **FTS5 incremental upsert optimization**. `reindex.ts` already handles per-document FTS inserts (`reindex.ts:151-153` full rebuild only on schema version bump). Current behavior is acceptable for the corpus size.
- **Screenpipe ambient capture**. Not installed, out of scope. Optional Phase-later.
- **`llm` CLI adoption as default prompt logger**. Install is optional in Phase 5; gemma-lab sessions are the canonical source.
- **Reflection-of-reflections** (tier 2+ consolidation). Single pass: raw → reflection. Higher-order consolidation is future work.
- **Cognee / Mem0 / Graphiti integration**. We extend ralph-knowledge instead.
- **OAuth / ACL**. Single-user local stack. OAuth 2.1 OBO is Prototype C (team-memory) scope.
- **Cross-repo issue coordination**. Tracking issue in `cdubiel08/ralph-hero`, all code PRs in same repo.

## Implementation Approach

Six phases. Phases 1–4 are plugin-side (TypeScript, `plugin/ralph-knowledge/src/`). Phases 5–6 add the dream-loop (Python, `scripts/dream/`, launchd plist). Phase 1 is a hard prerequisite for everything else; Phases 2–4 can run in parallel after Phase 1; Phase 5 depends on Phase 4; Phase 6 depends on Phase 5.

---

## Phase 1: Chunk-level embeddings + schema v3

### Overview

Introduce a `chunks` table and migrate `documents_vec` to chunk-level rows. Replace `prepareTextForEmbedding`'s single-slice truncation with a `RecursiveCharacterTextSplitter` that emits 512-token chunks with 64-token overlap. `HybridSearch` deduplicates by `document_id` and returns the best-scoring chunk's content as `snippet`.

### Changes Required

#### 1. Schema migration (v2 → v3)

**File**: `plugin/ralph-knowledge/src/db.ts`

In `createSchema()` after the `meta` table (around line 163), add:

```sql
CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,              -- "{doc_id}#c{index}"
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  char_start INTEGER NOT NULL,
  char_end INTEGER NOT NULL,
  context_prefix TEXT NOT NULL DEFAULT '',  -- filled by Phase 2
  UNIQUE(document_id, chunk_index)
);
CREATE INDEX IF NOT EXISTS idx_chunks_document_id ON chunks(document_id);
```

Add `memory_tier` column to `documents`:

```sql
ALTER TABLE documents ADD COLUMN memory_tier TEXT NOT NULL DEFAULT 'doc'
  CHECK(memory_tier IN ('doc','raw','reflection'));
CREATE INDEX IF NOT EXISTS idx_documents_memory_tier ON documents(memory_tier);
```

Update `schema_version` bump in `reindex.ts:22-30` to target `"3"`. The existing logic already triggers full FTS + vec rebuild on version change; no new migration code path needed, just the SQL.

#### 2. Chunker

**File**: `plugin/ralph-knowledge/src/chunker.ts` (new)

Port `RecursiveCharacterTextSplitter` semantics. Signature:

```typescript
export interface Chunk {
  index: number;
  content: string;
  charStart: number;
  charEnd: number;
}

export interface ChunkerOptions {
  chunkSize?: number;   // default 2048 chars (~512 tokens for English)
  chunkOverlap?: number; // default 256 chars (~64 tokens)
  separators?: string[]; // default ["\n\n","\n",". "," ",""]
}

export function chunkText(text: string, opts?: ChunkerOptions): Chunk[];
```

Algorithm: try each separator in order; if split pieces fit `chunkSize`, join with overlap; else recurse into the largest piece with the next separator. Preserve `charStart`/`charEnd` byte offsets into the original string.

Short documents (≤ `chunkSize`) yield a single chunk covering the whole text — so every document has at least one row in `chunks`.

#### 3. Embedder API change

**File**: `plugin/ralph-knowledge/src/embedder.ts`

Replace `prepareTextForEmbedding` (lines 32-43) and the single-slice in `embed()` (line 24) with a chunk-aware flow.

Keep the existing `embed(text: string): Promise<Float32Array>` for backward compat in tests. Add:

```typescript
export interface DocumentChunk extends Chunk {
  embedding: Float32Array;
  contextPrefix?: string; // added in Phase 2
}

export async function embedDocument(
  title: string,
  tags: string[],
  content: string,
  opts?: ChunkerOptions
): Promise<DocumentChunk[]>;
```

Each chunk is embedded from `${title}\n${tagLine}\n${chunk.content}` (title and tags prepended to every chunk so the semantic anchor travels). No hard slice; the transformer's internal 512-token window handles overflow via its own truncation — acceptable since chunks are sized to fit.

Remove `MAX_CHARS = 500`. Remove the `.slice(0, MAX_CHARS)` at line 24.

#### 4. Reindex wiring

**File**: `plugin/ralph-knowledge/src/reindex.ts`

Around lines 100–140 where a document's content is written, replace the single `documents_vec` upsert with:

```typescript
// Delete all existing chunks for this document
db.prepare('DELETE FROM chunks WHERE document_id = ?').run(doc.id);
db.prepare('DELETE FROM documents_vec WHERE id GLOB ?').run(`${doc.id}#c*`);

// Produce and insert chunks
const docChunks = await embedDocument(doc.title, doc.tags, doc.content);
const insertChunk = db.prepare(
  'INSERT INTO chunks (id, document_id, chunk_index, content, char_start, char_end) VALUES (?,?,?,?,?,?)'
);
const insertVec = db.prepare(
  'INSERT INTO documents_vec (id, embedding) VALUES (?, ?)'
);
for (const chunk of docChunks) {
  const chunkId = `${doc.id}#c${chunk.index}`;
  insertChunk.run(chunkId, doc.id, chunk.index, chunk.content, chunk.charStart, chunk.charEnd);
  insertVec.run(chunkId, Buffer.from(chunk.embedding.buffer));
}
```

Stale deletion (lines 44-55) stays as-is since `ON DELETE CASCADE` on `chunks.document_id` will clean children, and the `documents_vec` `GLOB` pattern works for the chunk id scheme.

#### 5. HybridSearch: chunk-level match with doc-level dedupe

**File**: `plugin/ralph-knowledge/src/hybrid-search.ts`

Two changes:

1. **Extract document_id from chunk id**: when reading vector search results, split on `#c` to get `doc_id`.
2. **Deduplicate by doc_id, keep best chunk**: fuse RRF scores across chunk matches per document; return `{ doc_id, best_chunk_id, best_chunk_content, score }`.

Pseudocode at lines 35-45 region:

```typescript
// Vector hits now reference chunks; convert to doc-level buckets
const docBuckets = new Map<string, { bestChunkId: string; bestChunkRank: number; bestChunkContent: string }>();
for (const hit of vectorResults) {
  const docId = hit.id.split('#c')[0];
  if (!docBuckets.has(docId) || hit.rank < docBuckets.get(docId)!.bestChunkRank) {
    docBuckets.set(docId, { bestChunkId: hit.id, bestChunkRank: hit.rank, bestChunkContent: hit.content });
  }
}
// Then RRF-fuse bucket ranks with FTS ranks (FTS is still doc-level)
```

The `snippet` field in `SearchResult` (`search.ts:11-19`) becomes the matching chunk's content (truncated to ~300 chars for readability), not the document's first paragraph.

#### 6. Vector search join

**File**: `plugin/ralph-knowledge/src/vector-search.ts`

At lines 62-68, the MATCH query returns chunk ids; add a LEFT JOIN to `chunks` to return `content` alongside `distance` for the snippet.

### Success Criteria

#### Automated Verification
- [ ] `npm run build` passes (TypeScript strict)
- [ ] `npm test` passes (all 13 existing test files)
- [ ] New file `src/__tests__/chunker.test.ts` covers: short docs (single chunk), long docs (multiple chunks), overlap boundaries, unicode, code fences preserved
- [ ] Updated `src/__tests__/embedder.test.ts` covers `embedDocument` returning ≥1 chunk, chunk count scaling with document length
- [ ] Updated `src/__tests__/hybrid-search.test.ts` covers dedup-by-document_id and best-chunk snippet selection
- [ ] `npm run reindex` against a fixture with one 8K-char markdown file produces ≥4 `chunks` rows for that doc

#### Manual Verification
- [ ] After reindex against `/Users/dubiel/projects/thoughts`, `SELECT COUNT(*) FROM chunks` is at least 3× `SELECT COUNT(*) FROM documents`
- [ ] `mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_search` from Claude Code with query "chunking strategies recursive character" returns a research doc with a snippet drawn from the *body* of the doc, not just the title/first paragraph
- [ ] Existing search results for simple title-matching queries are still at least as good (no regression)

**Implementation Note**: Pause here for manual confirmation. Bump schema to `"3"` forces a full reindex of the corpus — verify elapsed time and disk size before proceeding to Phase 2.

---

## Phase 2: Contextual Retrieval pre-embedding

### Overview

For each chunk, generate 50–100 token context via Gemma 4 26B at `http://localhost:8000` and prepend it to the chunk content before embedding. Store the context prefix in `chunks.context_prefix` so it survives reindexes without regeneration (unless the document mtime changes). Feature-flagged on by default with graceful fallback when the LLM endpoint is unreachable.

### Changes Required

#### 1. LLM client

**File**: `plugin/ralph-knowledge/src/llm-client.ts` (new)

Minimal OpenAI-compatible client (no SDK dep):

```typescript
export interface LlmClientOptions {
  baseUrl?: string;  // default http://localhost:8000
  model?: string;    // default env RALPH_LLM_MODEL or mlx-community/gemma-4-26b-a4b-it-mxfp8
  timeoutMs?: number; // default 30000
}

export interface LlmClient {
  available(): Promise<boolean>;
  contextualize(fullDocument: string, chunkContent: string): Promise<string>;
}

export function createLlmClient(opts?: LlmClientOptions): LlmClient;
```

`available()` probes `${baseUrl}/v1/models` with a 2s timeout.

`contextualize()` uses the Anthropic Contextual Retrieval prompt verbatim:

```
<document>
{fullDocument}
</document>

Here is the chunk we want to situate within the whole document:

<chunk>
{chunkContent}
</chunk>

Please give a short succinct context to situate this chunk within the overall
document for the purposes of improving search retrieval of the chunk. Answer only
with the succinct context and nothing else.
```

Response target: ≤ 100 tokens. On error or timeout: return empty string (fail-open).

#### 2. Feature flag + env vars

Env vars (documented in README):

- `RALPH_LLM_URL` (default `http://localhost:8000`) — LLM endpoint
- `RALPH_LLM_MODEL` (default `mlx-community/gemma-4-26b-a4b-it-mxfp8`)
- `RALPH_CONTEXTUAL_RETRIEVAL` (default `1`) — set to `0` to disable entirely

At reindex start, if flag is on, probe `available()`. If unreachable, log a single warning ("LLM endpoint unreachable at $URL, contextual retrieval disabled for this run") and proceed with empty context prefixes.

#### 3. Wire into embedder

**File**: `plugin/ralph-knowledge/src/embedder.ts`

Extend `embedDocument` signature:

```typescript
export async function embedDocument(
  title: string,
  tags: string[],
  content: string,
  opts?: ChunkerOptions & { llm?: LlmClient }
): Promise<DocumentChunk[]>;
```

When `opts.llm` is provided, for each chunk:
1. Check `chunks` table for existing `context_prefix` keyed on `doc_id + chunk_index + content hash`. If present and doc mtime unchanged, reuse.
2. Otherwise call `llm.contextualize(content, chunk.content)`.
3. Embed `${context}\n${title}\n${tagLine}\n${chunk.content}`.

The content hash check prevents regenerating context when chunking boundaries shift but the text itself is stable — reduces backfill cost on re-runs.

#### 4. Reindex integration

**File**: `plugin/ralph-knowledge/src/reindex.ts`

At the top of `main()` (near line 30), construct an LLM client if flag is on; pass to `embedDocument` calls.

Backfill note: one-time cost for 429 docs × ~8 chunks × ~15s ≈ 14 hours. User should run this overnight or in segments. Add a progress log every 50 chunks.

### Success Criteria

#### Automated Verification
- [ ] `npm run build` passes
- [ ] `src/__tests__/llm-client.test.ts` covers `available()` success + failure paths with mock fetch
- [ ] `src/__tests__/embedder.test.ts` covers `embedDocument` with a mock LLM client, verifies `context_prefix` is stored
- [ ] With `RALPH_CONTEXTUAL_RETRIEVAL=0`, reindex completes without any LLM calls (verify via mock client call count)
- [ ] With flag on and a mock-unreachable endpoint, reindex completes with empty context prefixes and logs one warning

#### Manual Verification
- [ ] With gemma-lab running (`./scripts/status.sh` shows active), a reindex of a 10-doc fixture produces non-empty `context_prefix` for every chunk
- [ ] With gemma-lab stopped, reindex still completes (fail-open) with empty `context_prefix` and one log line
- [ ] Search quality improves for a hand-picked set of 5 queries where the first paragraph does not mention the query term — compare results before/after contextualization

**Implementation Note**: Pause for manual confirmation. Kick off full-corpus backfill asynchronously before proceeding to Phase 3.

---

## Phase 3: Multi-root ergonomics (`.ralphignore` + config)

### Overview

Multi-root via `RALPH_KNOWLEDGE_DIRS` already works (`reindex.ts:196-203`). The real gaps are: no ignore-pattern support, no persistent config, and no discoverable way to see what roots are being indexed. Adds `.ralphignore` (gitignore syntax) per-root plus an optional `~/.ralph/knowledge.config.json` that lists roots and global ignore patterns.

### Changes Required

#### 1. Ignore-pattern matcher

**File**: `plugin/ralph-knowledge/src/ignore.ts` (new)

Thin wrapper around the `ignore` npm package (already a common dep in the TS ecosystem; add to `package.json` dependencies). Signature:

```typescript
export interface IgnoreMatcher {
  isIgnored(relativePath: string): boolean;
}

export function loadIgnoreForRoot(rootDir: string, globalPatterns?: string[]): IgnoreMatcher;
```

Reads `${rootDir}/.ralphignore` if present, combines with `globalPatterns`, returns a matcher. Default global patterns (applied even with no config): `.claude/`, `node_modules/`, `dist/`, `.git/`, `*.log`.

#### 2. Config file support

**File**: `plugin/ralph-knowledge/src/config.ts` (new)

```typescript
export interface KnowledgeConfig {
  roots?: string[];                // absolute paths; expanded tildes
  ignorePatterns?: string[];       // gitignore syntax, applied to every root
  dbPath?: string;
}

export function loadConfig(): KnowledgeConfig;
```

Reads `$RALPH_KNOWLEDGE_CONFIG` env var path OR `~/.ralph/knowledge.config.json` OR returns empty.

#### 3. Precedence update in `resolveDirs`

**File**: `plugin/ralph-knowledge/src/reindex.ts`

At lines 185-206, update precedence:

```
1. CLI positional args (explicit override)
2. RALPH_KNOWLEDGE_DIRS env var
3. Config file roots
4. Fallback: cwd/thoughts
```

If multiple sources conflict, the higher-priority wins (CLI > env > config > fallback). Log which source was selected.

#### 4. Wire ignore into scanner

**File**: `plugin/ralph-knowledge/src/file-scanner.ts`

Extend signature:

```typescript
export function findMarkdownFiles(dir: string, matcher?: IgnoreMatcher): string[];
```

In the walk (lines 4-18), test each path against `matcher.isIgnored(relativeToRoot)` before descending or including. Keeps existing `.`/`_`-prefix skip as a fast-path.

In `reindex.ts`, build a matcher per root via `loadIgnoreForRoot(root, config.ignorePatterns)` and pass it in.

#### 5. User-facing config template

**File**: `plugin/ralph-knowledge/README.md` (update)

Document the config file with example:

```json
{
  "roots": [
    "/Users/dubiel/projects/thoughts",
    "/Users/dubiel/projects/ralph-engine/thoughts",
    "/Users/dubiel/projects/ralph-hero/thoughts"
  ],
  "ignorePatterns": [
    ".claude/worktrees/**",
    "**/node_modules/**"
  ]
}
```

Document that `.ralphignore` files at root dirs augment global ignore patterns.

### Success Criteria

#### Automated Verification
- [ ] `npm run build` passes
- [ ] `src/__tests__/ignore.test.ts` covers gitignore syntax (globs, negation, directory-only patterns)
- [ ] `src/__tests__/config.test.ts` covers missing file, malformed JSON, tilde expansion, env var override
- [ ] Updated `src/__tests__/reindex.test.ts` covers precedence (CLI > env > config > fallback)
- [ ] `src/__tests__/file-scanner.test.ts` updated to verify `.ralphignore` exclusions on a temp directory

#### Manual Verification
- [ ] Write `~/.ralph/knowledge.config.json` with three roots; run `npm run reindex`; observe all three roots scanned (check log output)
- [ ] Drop `.ralphignore` with `.claude/worktrees/**` into `ralph-hero/`; observe no `documents` rows from agent worktrees after reindex
- [ ] `npm run reindex -- /Users/dubiel/projects/thoughts` still works (CLI override)

---

## Phase 4: MCP tool extensions

### Overview

Extend `knowledge_search` to accept a `memory_tier` filter and surface chunk-level snippet metadata (chunk index, char offsets) so agents can cite specific passages. Add a new `knowledge_memory_stats` tool so the dream-loop can check "did reflections get written today?" without shelling into sqlite.

### Changes Required

#### 1. `knowledge_search` schema extension

**File**: `plugin/ralph-knowledge/src/index.ts` (lines 33-43)

Add to Zod schema:

```typescript
memory_tier: z.enum(['doc','raw','reflection','any']).optional().default('any'),
return_chunk_meta: z.boolean().optional().default(false),
```

When `memory_tier !== 'any'`, filter `documents.memory_tier` in the SQL joins. When `return_chunk_meta` is true, include `chunk_index`, `char_start`, `char_end`, and `context_prefix` in the result payload.

#### 2. `knowledge_memory_stats` (new tool)

**File**: `plugin/ralph-knowledge/src/index.ts`

```typescript
server.tool(
  'knowledge_memory_stats',
  {
    since: z.string().optional(), // ISO date; defaults to 24h ago
  },
  async ({ since }) => { ... }
);
```

Returns:

```json
{
  "total_documents": 1234,
  "by_tier": { "doc": 1200, "raw": 28, "reflection": 6 },
  "new_since": { "doc": 3, "raw": 28, "reflection": 6 },
  "chunks_per_doc_p50": 4,
  "chunks_per_doc_p90": 11,
  "last_reflection_at": "2026-04-16T03:12:47Z"
}
```

Used by the dream-loop to confirm ingest + reflection completed.

#### 3. `knowledge_traverse` memory_tier filter

**File**: `plugin/ralph-knowledge/src/index.ts` (lines 70-79)

Add `memory_tier` optional filter. Useful for "traverse reflections only" queries.

### Success Criteria

#### Automated Verification
- [ ] `npm run build` passes
- [ ] `src/__tests__/index.test.ts` covers `knowledge_search` with `memory_tier=reflection` returns only reflection docs
- [ ] New `src/__tests__/memory-stats.test.ts` covers `knowledge_memory_stats` tool on a fixture DB
- [ ] `return_chunk_meta=true` results include `chunk_index` and `char_start`

#### Manual Verification
- [ ] From Claude Code: `knowledge_search` with `memory_tier=raw` returns only raw memories after Phase 5 runs
- [ ] `knowledge_memory_stats` returns expected JSON shape

---

## Phase 5: Dream-loop ingester (Python)

### Overview

Python script `scripts/dream/ingest.py` that pulls the last 24 hours of raw memories from three sources and writes them to ralph-knowledge as `memory_tier=raw` markdown files in a dedicated `dream-memories/` directory, then triggers a reindex. Uses `uv` per user convention.

### Changes Required

#### 1. Directory + source conventions

**Path**: `/Users/dubiel/projects/thoughts/dream-memories/YYYY/MM/DD/<source>-<hash>.md`

Example: `thoughts/dream-memories/2026/04/16/gemma-lab-a3f2e1.md`

Each file carries frontmatter:

```yaml
---
date: 2026-04-16T14:32:07-07:00
memory_tier: raw
source: gemma-lab     # gemma-lab | llm-cli | git-commit
source_id: a3f2e1...   # hash or line number for idempotency
tags: [dream, raw]
---
```

Body contains the raw memory content (prompt+response for LLM sessions, diff summary for commits).

Add `thoughts/dream-memories/` to the config roots (Phase 3 already reads it).

#### 2. Python project

**File**: `ralph-hero/scripts/dream/pyproject.toml` (new)

```toml
[project]
name = "ralph-dream"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = [
  "httpx>=0.27",
  "hdbscan>=0.8.38",
  "umap-learn>=0.5.6",
  "numpy>=2.0",
  "pyyaml>=6.0",
]
```

Use `uv` for install: `uv sync` in `scripts/dream/`.

#### 3. Ingester

**File**: `ralph-hero/scripts/dream/ingest.py` (new)

```python
def ingest_gemma_lab_sessions(since: datetime) -> list[RawMemory]:
    # Read gemma-lab/sessions/*.jsonl, filter by ts >= since
    # Emit RawMemory per prompt/response pair

def ingest_llm_cli_logs(since: datetime) -> list[RawMemory]:
    # If ~/.llm/logs.db exists, read responses table, filter by datetime_utc >= since
    # Emit RawMemory per response row

def ingest_git_commits(since: datetime, repos: list[Path]) -> list[RawMemory]:
    # For each repo, run `git log --since=... --format=... --patch`
    # Emit RawMemory per commit with short patch summary

def write_memory(m: RawMemory, base_dir: Path) -> Path:
    # Hash source+id for idempotent filename
    # Write .md with frontmatter to dream-memories/YYYY/MM/DD/
```

Idempotency: filename includes stable hash of `(source, source_id)`. Re-running the same day is safe — overwrites existing files with same content (no-op if mtime unchanged, so reindex skips).

CLI:

```bash
uv run ingest.py --since 24h --base-dir /Users/dubiel/projects/thoughts/dream-memories \
  --repos /Users/dubiel/projects/ralph-hero /Users/dubiel/projects/ralph-engine
```

#### 4. Config

**File**: `ralph-hero/scripts/dream/config.yaml` (new)

```yaml
base_dir: /Users/dubiel/projects/thoughts/dream-memories
gemma_lab_sessions: /Users/dubiel/projects/gemma-lab/sessions
llm_cli_db: ~/.llm/logs.db   # optional; skipped if missing
git_repos:
  - /Users/dubiel/projects/ralph-hero
  - /Users/dubiel/projects/ralph-engine
  - /Users/dubiel/projects/gemma-lab
```

#### 5. Reindex hook

At end of ingest, invoke:

```bash
npm --prefix /Users/dubiel/projects/ralph-hero/plugin/ralph-knowledge run reindex
```

### Success Criteria

#### Automated Verification
- [ ] `uv sync` in `scripts/dream/` succeeds
- [ ] `pytest` (add `tests/test_ingest.py`) covers:
  - Gemma-lab JSONL parsing (fixture with 5 entries)
  - Git commit extraction (fixture repo)
  - Idempotency: running ingest twice produces same files with same content
  - `llm` CLI absent is handled gracefully

#### Manual Verification
- [ ] Run `uv run ingest.py --since 24h` — `ls thoughts/dream-memories/YYYY/MM/DD/` shows expected files
- [ ] Reindex triggered; `knowledge_memory_stats` returns `by_tier.raw > 0`
- [ ] Running ingest again immediately does not duplicate files

---

## Phase 6: Nightly reflection loop + launchd scheduling

### Overview

`scripts/dream/reflect.py` runs after ingest. It queries ralph-knowledge for the last 24h of `memory_tier=raw` documents, clusters them with HDBSCAN on UMAP-reduced embeddings, asks Gemma 4 26B for one reflection per cluster, and writes reflections as `memory_tier=reflection` markdown files with `builds_on::` links to source raw memory ids. A launchd plist schedules both ingest + reflect at 3 AM daily.

### Changes Required

#### 1. Reflection clusterer

**File**: `ralph-hero/scripts/dream/reflect.py` (new)

```python
def fetch_recent_raw_memories(mcp_url: str, since: datetime) -> list[Memory]:
    # Call knowledge_search via MCP stdio (or direct sqlite if simpler)
    # memory_tier=raw, since=..., limit=500

def cluster_memories(memories: list[Memory]) -> list[Cluster]:
    # Stack embeddings (Nx384)
    # UMAP to 50 dims (n_neighbors=15, min_dist=0.1)
    # HDBSCAN (min_cluster_size=5, min_samples=3)
    # Return clusters; discard noise (label = -1)

def synthesize_reflection(cluster: Cluster, llm: LlmClient) -> Reflection:
    # Prompt template (A-Mem-inspired)

def write_reflection(r: Reflection, base_dir: Path) -> Path:
    # thoughts/dream-memories/reflections/YYYY/MM/DD/<theme-slug>.md
```

Embeddings: read directly from `knowledge.db` `documents_vec` for the raw memory chunks. For cluster assignment, use the mean chunk embedding per document.

#### 2. Reflection prompt (A-Mem-inspired)

```
You are consolidating short-term memories into a single reflection note.

Below are {N} related memories from the last 24 hours:

{for each memory:
---
source: {source}
timestamp: {ts}
content: {content[:800]}
---
}

Produce a reflection with:
1. A 3-7 word title capturing the theme
2. A 2-3 sentence summary of what the memories have in common
3. 3-5 bullet points of specific insights, decisions, or unresolved questions
4. A list of the memory ids this reflection links to

Format as YAML frontmatter followed by markdown body.
```

Parse LLM output; write as `memory_tier=reflection` with `builds_on:: [[source-memory-id]]` for each linked memory.

#### 3. Reflection storage convention

**Path**: `/Users/dubiel/projects/thoughts/dream-memories/reflections/YYYY/MM/DD/<theme-slug>.md`

Frontmatter:

```yaml
---
date: 2026-04-17T03:12:47-07:00
memory_tier: reflection
source: dream-loop
cluster_size: 7
source_ids: [abc123, def456, ...]
tags: [dream, reflection]
---

# Theme title

## Summary
...

## Insights
- ...

## Links
- builds_on:: [[dream-memory-abc123]]
- builds_on:: [[dream-memory-def456]]
```

#### 4. launchd plist

**File**: `~/Library/LaunchAgents/com.dubiel.dream-loop.plist` (new; not committed to repo — lives in `$HOME`)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.dubiel.dream-loop</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-lc</string>
    <string>cd /Users/dubiel/projects/ralph-hero/scripts/dream && uv run ingest.py --since 24h && uv run reflect.py --since 24h</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>3</integer>
    <key>Minute</key><integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>/tmp/dream-loop.out</string>
  <key>StandardErrorPath</key>
  <string>/tmp/dream-loop.err</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    <key>RALPH_KNOWLEDGE_CONFIG</key>
    <string>/Users/dubiel/.ralph/knowledge.config.json</string>
    <key>RALPH_LLM_URL</key>
    <string>http://localhost:8000</string>
  </dict>
</dict>
</plist>
```

Commit a **template** at `ralph-hero/scripts/dream/launchd/com.dubiel.dream-loop.plist.template` and document the copy-and-load step:

```bash
cp scripts/dream/launchd/com.dubiel.dream-loop.plist.template \
   ~/Library/LaunchAgents/com.dubiel.dream-loop.plist
launchctl load ~/Library/LaunchAgents/com.dubiel.dream-loop.plist
```

#### 5. Log rotation

Keep `/tmp/dream-loop.out` and `.err` bounded; add a `scripts/dream/logrotate.sh` that tails to 1000 lines post-run, called from the launchd job.

### Success Criteria

#### Automated Verification
- [ ] `pytest scripts/dream/tests/` passes; new `test_reflect.py` covers:
  - Clustering on fixture embeddings (expect 2-3 clusters from a crafted fixture)
  - Reflection parsing (well-formed LLM output fixture)
  - LLM output malformed — fails gracefully with one warning, writes no reflection
- [ ] `uv run reflect.py --since 24h --dry-run` on a seeded fixture produces the expected cluster count

#### Manual Verification
- [ ] Manually run `uv run ingest.py --since 24h && uv run reflect.py --since 24h` — at least 1 reflection written
- [ ] Read the reflection — the theme is recognizable, insights are specific, links resolve
- [ ] `knowledge_search` from Claude Code with `memory_tier=reflection` returns the new reflection
- [ ] `launchctl load ~/Library/LaunchAgents/com.dubiel.dream-loop.plist` succeeds
- [ ] `launchctl list | grep dream-loop` shows the agent with next-fire timestamp
- [ ] Set system clock forward ~1 min past 03:00 OR use `launchctl start com.dubiel.dream-loop` — job runs; `/tmp/dream-loop.out` shows success
- [ ] Next day at 03:00 real fire — reflections written (verify via `knowledge_memory_stats.last_reflection_at`)

---

## Testing Strategy

### Unit tests (plugin/ralph-knowledge)
- Chunker boundary cases (empty, short, unicode, code fences)
- Embedder chunk generation count
- HybridSearch dedupe-by-document
- Ignore pattern matching
- Config file precedence
- LLM client fail-open

### Integration tests (plugin/ralph-knowledge)
- Full reindex of a 10-doc fixture corpus with varied lengths — verify chunk counts, context prefixes, search results
- Reindex with contextual retrieval OFF then ON — verify context_prefix population differs

### End-to-end (dream-loop)
- Seed fixture: 20 gemma-lab sessions, 5 git commits, 3 llm-cli entries
- Run ingest → verify raw memories created
- Run reflect → verify reflections created with correct links
- Query via MCP → verify reflections are retrievable

### Manual acceptance
- One week of real use: daily reflections written, reflections are actually useful for "what did I work on this week" queries

## Performance Considerations

- **Backfill**: ~429 docs × ~8 chunks × ~15s contextualization = ~14 hours one-time cost. Run overnight in a single pass; `reindex.ts` already supports resumption via mtime check.
- **Incremental**: new docs in `thoughts/` trigger only their own chunks' contextualization (~2 min per new doc).
- **Chunk table size**: 429 docs × 8 chunks × ~2KB content ≈ 7 MB. Current DB is 5.1 MB. Post-Phase-1 DB size estimate: 15–20 MB. Fine.
- **Search latency**: chunk-level join adds one INDEX lookup per vector hit. Expected overhead: <5ms per query at corpus size.
- **HDBSCAN on 100–500 memories**: <1s on M5 Pro. No concern.
- **Gemma 4 26B reflection per cluster**: ~5–15 clusters/night × ~500 token output × ~75 tok/s = ~1–2 min total LLM time per night.

## Migration Notes

- **Schema v2 → v3**: bumping `meta.schema_version` forces full reindex via existing pattern at `reindex.ts:22-30`. No manual intervention needed.
- **Existing `documents` rows preserved**: `memory_tier` defaults to `'doc'` for all current records. Dream-loop writes new rows with `raw`/`reflection`.
- **Backward compat**: `knowledge_search` tool schema stays backward compatible (new fields are optional). Existing Claude Code invocations without `memory_tier` get `'any'` behavior (same as today).
- **Rollback path**: if Phase 1 reindex produces worse search quality, revert schema to v2 and re-run reindex — chunks table is dropped by the downgrade.

## References

- Research: `thoughts/shared/research/2026-04-16-local-llm-delivery-truth-personal-dreams-team-memory.md`
- Contextual Retrieval (Anthropic, Sept 2024): https://www.anthropic.com/news/contextual-retrieval
- A-Mem (NeurIPS 2025): https://arxiv.org/abs/2502.12110
- sqlite-vec chunk pattern: https://github.com/asg017/sqlite-vec
- `simonw/llm` schema: https://llm.datasette.io/en/stable/logging.html
- launchd `StartCalendarInterval`: https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/ScheduledJobs.html
- Canonical code paths: `plugin/ralph-knowledge/src/{embedder,db,reindex,hybrid-search,vector-search,file-scanner,index}.ts`
