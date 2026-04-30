---
date: 2026-04-29
status: draft
type: plan
github_issue: 911
github_issues: [911]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/911
primary_issue: 911
tags: [ralph-knowledge, performance, memory-profiling, reindex, embedder, oom]
---

# Release Embedder Tensors and Drop parsedDocs Accumulator - Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-04-29-reindex-memory-profile]]
- builds_on:: [[2026-04-29-GH-910-reindex-memory-profile]]
- builds_on:: [[2026-04-26-dreaming-research-trail-and-self-containment]]

## Overview

Single-issue plan with three sequential phases. The dominant retainer driving the OOM at ~150 chunks is per-call `@huggingface/transformers` Tensor allocation pressure inside `embed()` — the pipeline returns a Tensor wrapping ONNX-runtime native data buffers that V8 cannot reclaim quickly enough across the per-chunk `await` loop. Profile evidence (4 GB and 8 GB heap runs both OOM at iter=15 / 150 chunks with identical `ArrayPrototypeSlice → AsyncFunctionAwaitResolveClosure → PromiseFulfillReactionJob` stack) rules out `parsedDocs[]`, sqlite-vec, microtask buildup, and the LLM contextualize path.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-911 | Dispose transformer Tensor outputs after copying embedding data | S |
| 2 | GH-911 | Skip parsedDocs[] accumulator when generate=false | S |
| 3 | GH-911 | Verify on full corpus and re-run heap profile | S |

**Why phased**: Phase 1 is the OOM-blocking fix (1-line change at `embedder.ts:23-31`). Phase 2 is a correctness improvement that lands alongside since the issue body bundles them. Phase 3 is empirical confirmation against the live 1,626-doc corpus, mirroring the GH-910 profile run.

## Shared Constraints

- **Embedder singleton must NOT be destroyed** — `embedderInstance` at [embedder.ts:10](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/embedder.ts#L10) is a fixed-cost module-level cache. The leak is per-`embed()`-call, not the model itself. Do not add `embedderInstance = null` anywhere.
- **Embedding semantics must not change** — the returned `Float32Array` shape (length 384), values, and call surface (`embed(text: string)`) are part of the public API consumed by `embedDocument()` and contract-tested in `embedder.test.ts`. Phase 1 only adds tensor cleanup AFTER the data copy; the returned vector must be byte-identical.
- **No new runtime dependencies** — `Tensor.dispose()` already exists in `@huggingface/transformers@^3.0.0` at `node_modules/@huggingface/transformers/src/utils/tensor.js:121`. No new packages.
- **No `--expose-gc`** — the issue body explicitly cautions against forcing GC. The fix must be structural (release native buffers eagerly), not heuristic.
- **`RALPH_CONTEXTUAL_RETRIEVAL=0` is a workaround, not a fix** — Phase 3 verification must run with the default contextual flag (or `=0` consistent with the GH-910 baseline) and confirm the OOM is gone with default 4 GB heap.
- **Test environment uses mocked transformers** — `embedder.test.ts` mocks `@huggingface/transformers` to avoid loading the real ONNX model. The mock returns `{ data: new Float32Array(384) }` (no `dispose()` method). Phase 1's call to `output.dispose()` must be safe when `dispose` is absent on the mock — check for the method's existence before invoking it.

## Current State Analysis

### Per-call leak in `embed()`

The current implementation at [plugin/ralph-knowledge/src/embedder.ts:23-31](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/embedder.ts#L23-L31):

```typescript
export async function embed(text: string): Promise<Float32Array> {
  const embedder = await getEmbedder();
  const output = await embedder(text, {
    pooling: "mean",
    normalize: true,
  });
  return new Float32Array(output.data as ArrayLike<number>);
}
```

`output` is a `Tensor` wrapping an ONNX-runtime `ort_tensor` whose `.data` is a `TypedArray` view onto a native `ArrayBuffer`. Constructing `new Float32Array(output.data)` *copies* the data (the constructor's `ArrayLike<number>` overload iterates and assigns), so the returned Float32Array is independent of the source buffer.

However, the `output` reference itself stays in scope until the function returns and the closure is collected. Across 150 sequential awaits in `embedDocument()`, V8's incremental Mark-Compact cannot reclaim them fast enough. The native ONNX-allocated `last_hidden_state` buffers (sequence_length × 384 × 4 bytes ≈ 786 KB per call at 512 tokens) accumulate in OldSpace until heap_limit is reached.

`Tensor.dispose()` at `node_modules/@huggingface/transformers/src/utils/tensor.js:121-124` calls `this.ort_tensor.dispose()`, releasing the native buffer immediately rather than waiting for V8 GC.

### Unbounded `parsedDocs[]` accumulator

[plugin/ralph-knowledge/src/reindex.ts:97](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/reindex.ts#L97):

```typescript
const parsedDocs: ParsedDocument[] = [];
// ... per-file loop pushes parsed docs ...
parsedDocs.push(parsed);  // line 120
// ... at end of reindex, line 274:
if (generate && dirs.length > 0) {
  generateIndexes(dirs[0], parsedDocs);
}
```

The accumulator pins every parsed document's full content + relationships in memory across the entire run, but `generateIndexes()` is the only consumer and only runs when `generate=true`. On the live corpus (24.6 MB raw markdown), this pins ~125 MB worst-case — not OOM-causing on its own but a footgun on a 10x corpus.

### Files Affected (from research)

**Will Modify**:
- [plugin/ralph-knowledge/src/embedder.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/embedder.ts) — Phase 1: add `output.dispose()` in `embed()`
- [plugin/ralph-knowledge/src/reindex.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/reindex.ts) — Phase 2: gate `parsedDocs.push(parsed)` on `generate=true`
- [plugin/ralph-knowledge/src/__tests__/embedder.test.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/__tests__/embedder.test.ts) — Phase 1: add a test asserting `dispose()` is called and the mock supports its absence
- [plugin/ralph-knowledge/src/__tests__/reindex.test.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/__tests__/reindex.test.ts) — Phase 2: add a test that confirms `generateIndexes` still works when `generate=true` and is unaffected by the accumulator gating

**Will Read**:
- [plugin/ralph-knowledge/src/__tests__/reindex.test.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/__tests__/reindex.test.ts) — confirm mock `embedDocument` shape
- [plugin/ralph-knowledge/package.json](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/package.json) — discover build/test commands

## Desired End State

### Verification

- [ ] `npm run reindex` on the full corpus (1,626 docs / ~11,743 chunks) completes successfully with default 4 GB Node heap (no `--max-old-space-size` override).
- [ ] Peak heap during the verification run stays ≤ 600 MB (per the GH-910 research recommendation).
- [ ] Indexing throughput (docs/sec) is within 20% of pre-fix baseline.
- [ ] All existing tests in `embedder.test.ts` (32 tests) and `reindex.test.ts` (incremental scenarios) still pass.
- [ ] New test asserts `output.dispose()` is invoked once per `embed()` call.
- [ ] New test confirms `parsedDocs` is empty (or skipped) when `generate=false` and populated only when `generate=true`.

## What We're NOT Doing

- **Not collapsing the embedder singleton** — `embedderInstance` remains module-level. Per profile, it's a 200-300 MB fixed cost, not the leak.
- **Not adding `--expose-gc` or manual `global.gc()` calls** — the fix is structural (eager native release), not heuristic.
- **Not switching transformer libraries** — per the research's "Open Questions", evaluating onnxruntime-node directly is a future optimization, out of scope.
- **Not changing `DEFAULT_CHUNK_SIZE`** — chunker constants stay; this changes embedding semantics.
- **Not implementing sqlite-vec batching** — that's #912, deprioritized to throughput-only after the GH-910 profile.
- **Not adding the heap regression bench** — that's #913.
- **Not addressing LLM contextualize retainers** — `RALPH_CONTEXTUAL_RETRIEVAL=0` ruled out the LLM path; out of scope.
- **Not refactoring `generateIndexes()` to stream** — Phase 2 only gates the accumulator; `generateIndexes` continues to receive the full `ParsedDocument[]` when `generate=true`. Streaming refactor is a future correctness/scalability improvement.

## Implementation Approach

Phase 1 ships the OOM-blocking fix (the smallest possible structural change). Phase 2 lands alongside as a correctness fix because the issue body bundles both. Phase 3 is the empirical confirmation that mirrors the GH-910 profile methodology — without it, we can't claim the OOM is fixed.

**Phase dependency annotations**:
- Phase 1: no dependency (independent surgical fix)
- Phase 2: no dependency on Phase 1 (different file, independent change), but ordered second by convention
- Phase 3: depends on Phase 1 + Phase 2 (verifies both are present)

---

## Phase 1: Dispose transformer Tensor outputs after copying embedding data

- **depends_on**: null

### Overview

Add `output.dispose()` after copying `output.data` into the returned `Float32Array` in `embed()`. Guard the call so the existing test mock (which returns `{ data: Float32Array }` without a `dispose` method) keeps passing. Add a unit test asserting the dispose call is made.

### Tasks

#### Task 1.1: Add tensor disposal in `embed()`

- **files**: `plugin/ralph-knowledge/src/embedder.ts` (modify)
- **tdd**: true
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] After `new Float32Array(output.data as ArrayLike<number>)` copies the data, `embed()` calls `output.dispose()` if the method exists.
  - [ ] The dispose call is wrapped in a `typeof output.dispose === "function"` guard so the mock (which lacks the method) still works.
  - [ ] The returned `Float32Array` is byte-identical to the pre-fix output (constructor copies; `dispose()` only affects the source `Tensor`).
  - [ ] No change to the function signature: `export async function embed(text: string): Promise<Float32Array>`.
  - [ ] No reassignment to `embedderInstance` anywhere.

#### Task 1.2: Update mock and add disposal test

- **files**: `plugin/ralph-knowledge/src/__tests__/embedder.test.ts` (modify)
- **tdd**: true
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] Mock `fakePipeline` at `embedder.test.ts:8-11` returns an object with both `data: Float32Array` and a `dispose: vi.fn()` mock.
  - [ ] New test in the existing `describe("prepareTextForEmbedding")` or a new `describe("embed")` block that calls `embed("hello")` and asserts `fakePipelineOutput.dispose` was called exactly once.
  - [ ] Existing 32 tests in `embedder.test.ts` continue to pass (the mock-update is backward-compatible because the guard at Task 1.1 tolerates `dispose: undefined`).

### Phase Success Criteria

#### Automated Verification:
- [x] `npm run build` (from `plugin/ralph-knowledge/`) — no TypeScript errors
- [x] `npm test` (from `plugin/ralph-knowledge/`) — all tests pass, including new disposal test
- [x] `npx vitest run src/__tests__/embedder.test.ts` — embedder suite green

#### Manual Verification:
- [x] Diff inspection: only `embed()` body and one mock object are touched. No changes to `getEmbedder()`, `embedDocument()`, or `prepareTextForEmbedding()`.

**Creates for next phase**: A guarded `output.dispose()` call in `embed()` that releases native ONNX buffers eagerly, eliminating the per-call retention pressure that currently OOMs the corpus reindex at ~150 chunks.

---

## Phase 2: Skip parsedDocs[] accumulator when generate=false

- **depends_on**: null

### Overview

Stop unconditionally pushing every `ParsedDocument` into the corpus-wide `parsedDocs[]` array. Push only when `generate=true` (the rare case where `generateIndexes()` runs at end of reindex). On a 10x larger corpus this avoids pinning hundreds of MB of parsed-doc state for no gain.

### Tasks

#### Task 2.1: Gate `parsedDocs.push(parsed)` on the `generate` flag

- **files**: `plugin/ralph-knowledge/src/reindex.ts` (modify)
- **tdd**: true
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] At [reindex.ts:120](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/reindex.ts#L120), `parsedDocs.push(parsed)` is wrapped in `if (generate) { ... }`.
  - [ ] At [reindex.ts:97](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/reindex.ts#L97), `const parsedDocs: ParsedDocument[] = [];` remains so the variable is in scope for the post-loop `generateIndexes` call (when `generate=true`).
  - [ ] At [reindex.ts:274-277](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/reindex.ts#L274-L277), the existing `if (generate && dirs.length > 0) { generateIndexes(dirs[0], parsedDocs); }` block is unchanged — same call site, same arguments.
  - [ ] No other reference to `parsedDocs` is added or removed.

#### Task 2.2: Add reindex test verifying accumulator gating

- **files**: `plugin/ralph-knowledge/src/__tests__/reindex.test.ts` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [2.1]
- **acceptance**:
  - [ ] New test scenario in the `describe("incremental reindex")` block titled along the lines of "scenario N: generateIndexes is invoked only when generate=true".
  - [ ] Test calls `reindex([dir], dbPath, false)` (generate=false), confirms `generateIndexes` is NOT called by spying on the mocked module (or asserting no `index.md` is produced).
  - [ ] Second test call: `reindex([dir], dbPath, true)` (generate=true), confirms `generateIndexes` IS called with a non-empty `ParsedDocument[]` matching the on-disk fixtures.
  - [ ] All existing 17+ scenarios in `reindex.test.ts` continue to pass.

### Phase Success Criteria

#### Automated Verification:
- [ ] `npm run build` — no errors
- [ ] `npx vitest run src/__tests__/reindex.test.ts` — all reindex scenarios pass, including new gating test
- [ ] `npm test` — full suite green

#### Manual Verification:
- [ ] Diff shows only one conditional wrap and one new test scenario; no other reindex behavior changed.

**Creates for next phase**: A reindex run with `generate=false` (the default for the production CLI invocation) no longer pins `ParsedDocument[]` for the full corpus. Combined with Phase 1, this leaves zero unbounded accumulators in the per-document hot path.

---

## Phase 3: Verify on full corpus and re-run heap profile

- **depends_on**: [phase-1, phase-2]

### Overview

Run `npm run reindex` against the full live corpus (`~/projects/thoughts`, `~/projects/ralph-hero/thoughts`, `~/projects/ralph-engine/thoughts`, `~/projects/landcrawler-ai/thoughts`) at default 4 GB heap and confirm: (a) it completes without OOM, (b) peak heap stays ≤ 600 MB per the GH-910 recommendation, (c) throughput is within 20% of a pre-fix baseline. Append findings to the existing GH-910 research document or create a short verification note.

### Tasks

#### Task 3.1: Backup pre-existing knowledge.db

- **files**: `~/.ralph-hero/knowledge.db` (read; no source-code change)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] If `~/.ralph-hero/knowledge.db` exists, rename it to `~/.ralph-hero/knowledge.db.pre-911-backup`. If it does not exist, log "no pre-existing DB" and continue.
  - [ ] Backup file is restorable via `mv` if the run aborts.

#### Task 3.2: Build the plugin with the Phase 1 + Phase 2 fixes

- **files**: `plugin/ralph-knowledge/package.json` (read)
- **tdd**: false
- **complexity**: low
- **depends_on**: [3.1]
- **acceptance**:
  - [ ] `cd plugin/ralph-knowledge && npm run build` exits 0 with no TypeScript errors.
  - [ ] `dist/embedder.js` exists and `grep "dispose" dist/embedder.js` shows the disposal call is in the compiled output.
  - [ ] `dist/reindex.js` exists and `grep -A1 "if (generate)" dist/reindex.js` shows the accumulator gating is in the compiled output.

#### Task 3.3: Run reindex at default 4 GB heap with `--heap-prof`

- **files**: `plugin/ralph-knowledge/dist/reindex.js` (read)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [3.2]
- **acceptance**:
  - [ ] Command run from `plugin/ralph-knowledge/`: `RALPH_CONTEXTUAL_RETRIEVAL=0 node --heap-prof --heap-prof-dir=/tmp/heap-prof-gh911 dist/reindex.js`
  - [ ] Run completes with exit code 0 (NOT 134 / SIGABRT).
  - [ ] Final stdout shows "Done. N documents indexed, M skipped (unchanged)." with N + M ≥ 1,600.
  - [ ] At least one `.heapprofile` file is produced under `/tmp/heap-prof-gh911/`.

#### Task 3.4: Capture peak heap and throughput metrics

- **files**: `/tmp/heap-prof-gh911/*` (read), `/tmp/reindex-911-stdout.log` (create)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [3.3]
- **acceptance**:
  - [ ] Run a second invocation with `process.memoryUsage()` snapshots logged every 50 chunks (modify a temporary copy of `dist/reindex.js` or use a wrapping probe — do NOT commit any probe).
  - [ ] Capture peak `rss` and peak `heapUsed`. Peak `heapUsed` ≤ 600 MB.
  - [ ] Capture wall-clock duration and chunks-per-second. Document these in the verification note.

#### Task 3.5: Append verification findings to the research document

- **files**: `thoughts/shared/research/2026-04-29-reindex-memory-profile.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [3.4]
- **acceptance**:
  - [ ] Append a new section `## Verification (post-#911 fix)` to the research document with: date of run, plugin commit hash, peak heap (rss + heapUsed), wall-clock duration, doc/chunk count, exit code.
  - [ ] Section includes a short paragraph confirming the OOM is fixed and noting any remaining concerns (e.g., RSS still inflates due to ONNX baseline, but heapUsed is bounded).
  - [ ] No re-derivation of the original profile findings — only append; do not edit prior sections.

#### Task 3.6: Restore (or accept new) knowledge.db

- **files**: `~/.ralph-hero/knowledge.db.pre-911-backup` (read)
- **tdd**: false
- **complexity**: low
- **depends_on**: [3.5]
- **acceptance**:
  - [ ] If the verification run produced a fresh `~/.ralph-hero/knowledge.db` that is healthy (sqlite3 check passes, document count matches files-on-disk), keep the new DB and remove the backup.
  - [ ] Otherwise restore the backup via `mv ~/.ralph-hero/knowledge.db.pre-911-backup ~/.ralph-hero/knowledge.db`.

### Phase Success Criteria

#### Automated Verification:
- [ ] `npm run build` — clean
- [ ] `npm test` — green
- [ ] `node dist/reindex.js` against full corpus exits 0 (not 134)
- [ ] `sqlite3 ~/.ralph-hero/knowledge.db "SELECT COUNT(*) FROM documents WHERE is_stub=0"` returns ≥ 1,600

#### Manual Verification:
- [ ] Verification section appended to `2026-04-29-reindex-memory-profile.md` with peak heap ≤ 600 MB, wall-clock duration, throughput.
- [ ] Stack trace in stderr (if any) does NOT contain `JS Allocation failed` or `Mark-Compact (reduce)` near heap_limit messages.

**Creates for next phase**: Empirical proof that Phase 1 + Phase 2 fix the OOM on the live corpus. The verification artifact is appended to the existing GH-910 research note (no new doc to maintain). Sibling issue #913 can now calibrate its regression bench against the measured 600 MB ceiling.

---

## Integration Testing

- [ ] Full `npm test` from `plugin/ralph-knowledge/` passes (covers embedder, reindex, hybrid-search, vector-search, parser, all interactive tests).
- [ ] Manual smoke test: `knowledge_search` MCP tool returns sensible results against the freshly indexed DB (verifies the embedder fix didn't change embedding values).
- [ ] `knowledge_memory_stats` returns non-zero `total_chunks` matching the indexed corpus.

## References

- Issue: https://github.com/cdubiel08/ralph-hero/issues/911
- Parent issue: https://github.com/cdubiel08/ralph-hero/issues/907
- Sibling profile (closed): https://github.com/cdubiel08/ralph-hero/issues/910
- Sibling regression bench (open): https://github.com/cdubiel08/ralph-hero/issues/913
- Sibling sqlite-vec batching (open, deprioritized): https://github.com/cdubiel08/ralph-hero/issues/912
- Research: [thoughts/shared/research/2026-04-29-reindex-memory-profile.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-29-reindex-memory-profile.md)
- transformers.js Tensor source: `node_modules/@huggingface/transformers/src/utils/tensor.js:121-124` (`dispose()` impl)
- transformers.js FeatureExtractionPipeline: `node_modules/@huggingface/transformers/src/pipelines.js:1305-1357`
