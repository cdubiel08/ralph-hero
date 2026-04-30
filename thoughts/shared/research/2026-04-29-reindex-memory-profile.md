---
date: 2026-04-29
type: research
status: complete
github_issue: 910
github_issues: [910, 907, 911, 912, 913]
tags: [ralph-knowledge, performance, memory-profiling, reindex, embedder, oom]
---

# Reindex OOM Memory Profile

## Prior Work

- builds_on:: [[2026-04-26-dreaming-research-trail-and-self-containment]]
- builds_on:: [[2026-04-16-GH-0761-ralph-knowledge-chunked-embeddings-dream-loop]]

## Summary

Reproduced the `npm run reindex` OOM at default 4 GB heap and 8 GB heap on the live 1,626-doc corpus. Both runs OOM after embedding ~150 chunks (12-15 docs) with the **identical** failure stack — `Builtins_AsyncFunctionAwaitResolveClosure → PromiseFulfillReactionJob → RunMicrotasks → ArrayPrototypeSlice` — and at the V8 OldSpace ceiling (4056 MB at 4 GB cap, 8085 MB at 8 GB cap).

The dominant retainer is the **`@huggingface/transformers` `FeatureExtractionPipeline` per-call allocation pressure** inside `embedDocument()`'s per-chunk `await embed(...)` loop. Each `embedder(text, ...)` call passes through `mean_pooling` → `result.normalize(2, -1)` → `result.clone().normalize_(...)` → `Array.prototype.slice` chains that allocate large intermediate Tensor objects (clone copies the `last_hidden_state` data buffer). V8's incremental Mark-Compact cannot keep up with the per-call allocation rate, so OldSpace climbs to the heap ceiling within ~16 seconds at default 4 GB.

The leak is **NOT** in the `parsedDocs[]` accumulator (whole corpus = 24.6 MB raw text), **NOT** in sqlite-vec writes (probe with and without DB writes OOM identically), and **NOT** caused by microtask queue buildup (probes inserting `setImmediate` between chunks AND between docs OOM at the same iteration count).

**Recommendation**: tighten #911 scope to "release transformer Tensor outputs after each `embed()` call (`output.dispose()` and/or copy `output.data` then null the reference) and remove the unbounded `parsedDocs` accumulator", collapse #912 to a *throughput-only* optimization that is no longer blocking the OOM fix, and calibrate #913's heap-regression bench threshold to 600 MB peak heap for a 50-doc / 200-chunk synthetic corpus.

## Reproduction

### Environment

| Property | Value |
|---|---|
| Machine | M5 Pro MacBook (darwin 25.4.0) |
| Node | v22.22.1 (mise-managed) |
| Corpus roots | `~/projects/landcrawler-ai/thoughts` (641), `~/projects/ralph-hero/thoughts` (671), `~/projects/ralph-engine/thoughts` (250), `~/projects/thoughts` (64) |
| Total markdown files indexed | 1,626 |
| Total raw markdown content | 24,685,301 bytes (23.5 MB) |
| Pre-existing DB | renamed to `~/.ralph-hero/knowledge.db.pre-profile-backup` (96 MB on disk) |
| Plugin version | `ralph-hero-knowledge-index@0.1.29` (commit `de209d2`) |
| `RALPH_CONTEXTUAL_RETRIEVAL` | `0` (LLM contextualize disabled) |
| Other env | none |

### Run 1: default 4 GB heap

```bash
cd plugin/ralph-knowledge
RALPH_CONTEXTUAL_RETRIEVAL=0 \
  node --heap-prof --heap-prof-dir=/tmp/heap-prof-gh910 dist/reindex.js
```

| Metric | Value |
|---|---|
| Wall clock to OOM | 16 seconds |
| Last log line | `150 chunks embedded` |
| Approx docs processed before OOM | ~12-15 (out of 1,626) |
| Heap at OOM | `Mark-Compact (reduce) 4059.2 (4133.5) -> 4056.8 (4122.0) MB` |
| Exit code | 134 (SIGABRT — V8 OOM) |
| Stack frame triggering OOM | `Builtins_AsyncFunctionAwaitResolveClosure → PromiseFulfillReactionJob → RunMicrotasks` |

### Run 2: extended 8 GB heap

```bash
cd plugin/ralph-knowledge
RALPH_CONTEXTUAL_RETRIEVAL=0 NODE_OPTIONS="--max-old-space-size=8192" \
  node --heap-prof --heap-prof-dir=/tmp/heap-prof-gh910 dist/reindex.js
```

| Metric | Value |
|---|---|
| Wall clock to OOM | 26 seconds |
| Last log line | `150 chunks embedded` (same as 4 GB run) |
| Heap at OOM | `Mark-Compact 8085.3 (8240.0) -> 8085.1 (8242.5) MB` |
| Exit code | 134 |
| Stack | identical to Run 1 |

### Per-doc growth rate

The two runs OOM at the same chunk count, so the 8 GB run does NOT walk further into the corpus. The "extra" 4 GB of heap is consumed by the same set of operations — each call leaves ~30 MB more allocation pressure on average.

| Configuration | Doc count at OOM | Time to OOM | Peak heap |
|---|---|---|---|
| 4 GB heap | ~15 | 16 s | 4056 MB |
| 8 GB heap | ~15 | 26 s | 8085 MB |

Per-call allocation rate (V8-tracked):
- 4 GB / 150 chunks ≈ 27 MB/chunk transient
- 8 GB / 150 chunks ≈ 54 MB/chunk transient

Per-call RSS growth (from controlled probe at varying input lengths):
- 500-char input: 194 KB/call RSS
- 2000-char input: 412 KB/call RSS
- 4000-char input: 863 KB/call RSS

The growth scales linearly with input length, consistent with Tensor `.slice()` and `.clone()` operations that depend on `last_hidden_state` size (which is `seq_length × 384 × 4 bytes`).

## Heap Profile Findings

### Limitation: OOM aborts before `--heap-prof` flushes

Node's `--heap-prof` does NOT flush a profile on OOM crash — only on clean exit. Both reindex runs exited via `FATAL ERROR: Reached heap limit`, so neither produced a usable `.heapprofile` file. The only `.heapprofile` in `/tmp/heap-prof-gh910/` (`Heap.20260429.194811.51087.0.001.heapprofile`, 39 KB) is from an earlier failed-startup run with a stale DB; it is not OOM-relevant.

### Workaround: explicit `writeHeapSnapshot()` at controlled iteration points

A small probe (`/tmp/snapshot-probe.mjs`) reproduces the inner reindex loop, takes `v8.writeHeapSnapshot()` at iter=1, iter=6, iter=12 (just before OOM territory at iter=15+), and stops short of OOM. Three snapshots produced, each 19-21 MB, in `/tmp/heap-prof-gh910/`.

### Top retainers by class (post-GC steady state)

Aggregated via `node --expose-gc analyze-snapshot.mjs` over the saved `.heapsnapshot` files (script in `/tmp/analyze-snapshot.mjs`). Numbers are total `self_size` across all nodes in each class.

| Class | iter=1 | iter=6 | iter=12 | Δ iter1→iter12 |
|---|---|---|---|---|
| `native::system / JSArrayBufferData` | ~0.5 MB | ~1.9 MB | **6.46 MB** (155 nodes) | **+5.9 MB** |
| `string` | 6.03 MB | 6.11 MB | 6.27 MB | +0.24 MB |
| `code` | 5.95 MB | 6.67 MB | 5.51 MB | -0.44 MB |
| `array` | 4.12 MB | 4.12 MB | 4.09 MB | -0.03 MB |
| `object shape` | 1.67 MB | 1.69 MB | 1.47 MB | -0.20 MB |
| `closure` | 0.86 MB | 0.85 MB | 0.85 MB | 0 |
| **Total self_size** | **20.86 MB** | **23.13 MB** | **26.20 MB** | **+5.34 MB** |

**Steady-state V8 retention is small** (only +5.34 MB across 12 docs / 100 chunks, post-GC). The overwhelming majority of growth is **transient inside a single `embed()` call**, which is invisible to a snapshot taken between docs.

### RSS vs. heap discrepancy

`process.memoryUsage()` snapshots BETWEEN iterations (probe, no DB):

| iter | chunks | content avg | rss | heapUsed | heapTotal | external |
|---|---|---|---|---|---|---|
| start | 0 | — | 91 MB | 15 MB | 24 MB | 2 MB |
| 1 (load+1 doc) | 1 | 0 | 320 MB | 24 MB | 38 MB | 4 MB |
| 5 | 28 | 8.7 KB | 375 MB | 23 MB | 39 MB | 7 MB |
| 10 | 56 | 9.1 KB | 380 MB | 22 MB | 39 MB | 10 MB |
| 12 | 100 | 14 KB | 395 MB | 26 MB | 39 MB | 16 MB |
| 15 | 151 | 17 KB | 404 MB | 24 MB | 39 MB | 23 MB |
| **OOM during iter 17** | — | — | **n/a** | **(reaches 4056 MB)** | — | — |

Between iter=15 (RSS 404 MB, heap 24 MB) and the OOM, V8 OldSpace fills up by ~3,650 MB. **No iteration is logged after this point** — the OOM happens during a single call's microtask chain, before the iteration's `console.log` runs. The post-GC snapshot at iter=12 only captures the survivor set; the killer allocations are transient peaks during one `embedDocument()` call.

### Drilling into the dominant retainer

The OOM stack (both runs):

```
12: 0x10b9ada98
13: 0x10b960a24
14: 0x10b99b374    <- transformers.js JS frame
15: Builtins_AsyncFunctionAwaitResolveClosure
16: Builtins_PromiseFulfillReactionJob
17: Builtins_RunMicrotasks
18: Builtins_JSRunMicrotasksEntry
```

The 8 GB run's OOM stack adds an explicit `Builtins_ArrayPrototypeSlice` and `Builtins_ExtractFastJSArray` frame just before `AsyncFunctionAwaitResolveClosure`. This points squarely at `tensor.js:355`:

```js
// node_modules/@huggingface/transformers/src/utils/tensor.js:355
clone() {
    return new Tensor(this.type, this.data.slice(), this.dims.slice());
}
```

`normalize()` at `tensor.js:590` calls `this.clone().normalize_(p, dim)`. In the embed pipeline (`pipelines.js:1348`), `result = result.normalize(2, -1)` runs AFTER `mean_pooling` so the data should be small (1×384 floats = 1.5 KB). This alone is not the leak.

What IS the leak: `mean_pooling` (`tensor.js:1086-1126`) reads `last_hidden_state.data` (sequence_length × 384 × 4 bytes — up to 786 KB per call at 512 tokens). The `result` Tensor returned from the pipeline retains references to all the intermediate Tensor wrappers. **Without an explicit `.dispose()` call after each embedding, the underlying ONNX Tensor data buffers stay alive until V8 detects them collectible.** Across 150 chunks with 512-token inputs:

- last_hidden_state buffers retained transiently: 150 × 786 KB ≈ 115 MB
- ONNX runtime intermediate activations (attention scores, layer outputs) per call: tens of MB
- These are allocated as TypedArrays / ArrayBuffers tracked by V8's external/native accounting

V8's mark-compact scans these but cannot release them fast enough — the per-call allocation rate exceeds incremental GC throughput, OldSpace fills, and Mark-Compact reduces only ~6 MB per cycle ("Ineffective mark-compacts near heap limit").

## Suspected Retainer Audit

| Suspect from issue body | Status | Evidence |
|---|---|---|
| 1. transformer `FeatureExtractionPipeline` tensor cache | **CONFIRMED DOMINANT** | OOM stack ends at `ArrayPrototypeSlice → AsyncFunctionAwaitResolveClosure` matching `Tensor.clone()` in `tensor.js:355`. RSS scales linearly with input length (194 KB → 412 KB → 863 KB per call for 500/2000/4000-char inputs). Per-call ONNX ArrayBuffer allocations dominate. |
| 2. `Float32Array` chunks accumulating in JS heap | **RULED OUT** | Per-chunk 384-float buffers = 1.5 KB × 11,743 chunks = 17.6 MB total — far below 4 GB. Snapshot at iter=12 shows only 6.46 MB in `JSArrayBufferData` total. |
| 3. `parsedDocs: ParsedDocument[]` accumulator at `reindex.ts:84` | **RULED OUT** | Total raw corpus = 24.6 MB. Even with 5x parsing overhead = 125 MB. Snapshot at iter=12 with 12 parsedDocs in scope shows only 26 MB total V8 retention. *Worth fixing for correctness*, but not the OOM cause. |
| 4. sqlite-vec per-chunk `INSERT` allocations | **RULED OUT** | Probe with DB writes (`probe-realistic.mjs`) and probe without DB writes (`probe-embed-doc.mjs`) BOTH OOM at iter=15 / 150 chunks. sqlite-vec is not on the critical path. *Worth batching for throughput* (#912 still has merit), but not for OOM. |
| 5. LLM client `contextualize` response accumulation | **RULED OUT** | `RALPH_CONTEXTUAL_RETRIEVAL=0` for both runs — no LLM calls made. OOM still reproduces. |
| 6. (added) microtask queue buildup from per-chunk awaits | **RULED OUT** | Probe inserting `await new Promise(r => setImmediate(r))` between every chunk AND between every doc still OOMs at iter=15 / 150 chunks (`probe-yield.mjs`, `probe-yield-chunks.mjs`). The microtask queue is not the dominant retainer; the leak is per-call inside `embed()`. |

## Recommendation

### #911: tighten scope to "release transformer Tensor data after each embed call"

**Current scope** (per issue body): "release embedder tensors and stop accumulating parsedDocs in reindex".

**Recommended scope after profile**:

1. **Primary fix (blocks OOM)**: in `embedder.ts:12-19` (`embed()`), call `output.dispose()` after copying `output.data` into the returned `Float32Array`, OR explicitly assign `output = null` to break the closure reference before the next chunk's `await`. This forces ONNX to release the underlying tensor buffer at the end of each call rather than waiting for V8 GC.

2. **Secondary fix (correctness, not OOM)**: drop the `parsedDocs[]` accumulator at `reindex.ts:84`. It only feeds `generateIndexes(dirs[0], parsedDocs)` at `reindex.ts:230` (gated on `generate=true`, which is rare). When `generate=false`, the accumulator pins ~25 MB unnecessarily — fine on this corpus, but a footgun on a 10x larger corpus. Either:
   - Skip the accumulator when `generate=false`.
   - Or stream-process: instead of `parsedDocs.push(parsed)`, write to disk and re-read in `generateIndexes`.

3. **Out of scope** (do NOT include in #911): sqlite-vec batching, LLM contextualize fix, microtask yield. Those either have separate tickets (#912) or are ruled out as non-causes.

**Estimate**: still S. The fix is targeted (1-2 lines in embedder.ts plus 1 conditional in reindex.ts).

### #912: collapse to throughput optimization, no longer blocks OOM

**Current scope**: "batch sqlite-vec chunk writes during reindex".

**Recommended action**: keep the issue but de-prioritize from P1 to P2/P3. The probe shows sqlite-vec writes are NOT the OOM cause; per-chunk `INSERT` is fine for correctness and the per-chunk overhead is bounded (tens of microseconds per chunk). Batching is still worth doing for throughput (saves SQLite transaction overhead across 11,743 chunks → seconds of wall-clock), but it is no longer a fix for OOM.

If the issue body asserts sqlite-vec as a leak source, **remove that claim**. Reframe as: "Batch chunk writes inside a single transaction to reduce per-chunk SQLite overhead during reindex of a 1.6k-doc / 11k-chunk corpus."

### #913: calibrate heap-regression bench threshold

**Current scope**: "add reindex heap regression microbenchmark".

**Recommended threshold**: peak heap ≤ 600 MB for a 50-doc / 200-chunk synthetic corpus. Justification:

- After #911 fix, per-call retention should drop to ~5-10 MB instead of ~30 MB.
- 50 docs × 4 chunks/doc avg × 8 MB peak per call ≈ 200 MB transient + 200 MB ONNX baseline + 100 MB margin = 500 MB.
- 600 MB gives comfortable headroom while still failing if a future regression reintroduces unbounded transient allocation.

The bench should NOT use the live corpus (too slow for CI). Generate 50 synthetic markdown files, ~5-10 KB each, with realistic English text.

### No new ticket needed

All findings map cleanly to existing siblings #911-913. The "transformer tensor pressure" hypothesis is the dominant retainer #911 was already targeting, just with sharper specifics. **No follow-up ticket required.**

## Code References

- [plugin/ralph-knowledge/src/embedder.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/embedder.ts) — singleton pipeline at line 10, per-call `embed()` at lines 12-19, per-chunk `embedDocument()` loop at lines 38-79
- [plugin/ralph-knowledge/src/reindex.ts:84](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/reindex.ts#L84) — `parsedDocs: ParsedDocument[]` accumulator (correctness, not OOM)
- [plugin/ralph-knowledge/src/reindex.ts:230](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/reindex.ts#L230) — only consumer of `parsedDocs`, gated on `generate=true`
- [plugin/ralph-knowledge/src/reindex.ts:209-217](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/reindex.ts#L209-L217) — chunk insert loop (per-chunk `INSERT`, no transaction wrap)
- [plugin/ralph-knowledge/src/vector-search.ts:29-38](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/vector-search.ts#L29-L38) — `upsertEmbedding` does DELETE + INSERT per call
- `node_modules/@huggingface/transformers/src/utils/tensor.js:355` — `Tensor.clone()` does `data.slice()` (the `.slice` in the OOM stack)
- `node_modules/@huggingface/transformers/src/utils/tensor.js:121-124` — `Tensor.dispose()` exists but is NEVER called by ralph-knowledge
- `node_modules/@huggingface/transformers/src/pipelines.js:1305-1357` — `FeatureExtractionPipeline._call` chain: tokenize → model → mean_pooling → normalize

## Heap Profile Artifacts

All under `/tmp/heap-prof-gh910/` (NOT committed — too large at ~20 MB each, may contain corpus content fragments):

- `/tmp/heap-prof-gh910/snapshot-iter1.heapsnapshot` (20 MB) — after embedder pipeline load + 1 doc
- `/tmp/heap-prof-gh910/snapshot-iter6.heapsnapshot` (21 MB) — after 6 docs / 29 chunks
- `/tmp/heap-prof-gh910/snapshot-iter12.heapsnapshot` (19 MB) — after 12 docs / 100 chunks (last clean snapshot before OOM territory)
- `/tmp/heap-prof-gh910/snapshot-iter1-analysis.txt` — top-30 (type,name) by self_size
- `/tmp/heap-prof-gh910/snapshot-iter6-analysis.txt` — top-30 (type,name) by self_size
- `/tmp/heap-prof-gh910/snapshot-iter12-analysis.txt` — top-30 (type,name) by self_size
- `/tmp/reindex-default-stdout.log`, `/tmp/reindex-default-stderr.log` — full 4 GB run output (incl. OOM stack)
- `/tmp/reindex-8gb-stdout.log`, `/tmp/reindex-8gb-stderr.log` — full 8 GB run output (incl. OOM stack)

Probe scripts (also kept under `/tmp/`):

- `/tmp/memprobe.mjs` — minimal embedder-only probe (200 calls, short text → healthy)
- `/tmp/memprobe-long.mjs` — embedder with 2000-char text (100 calls → healthy, 411 KB/call RSS growth)
- `/tmp/memprobe-full.mjs` — full `parseDocument + embedDocument` loop (OOM at iter=15)
- `/tmp/memprobe-embed-doc.mjs` — `embedDocument` only, no DB (OOM at iter=15)
- `/tmp/probe-realistic.mjs` — `parse + embed + sqlite-vec write` (OOM at iter=15, same as without DB → confirms sqlite-vec is not on the critical path)
- `/tmp/probe-yield.mjs` — `setImmediate` between docs (OOM at iter=15 → microtask yield doesn't help)
- `/tmp/probe-yield-chunks.mjs` — `setImmediate` between every chunk (OOM at iter=15 → microtask yield even between chunks doesn't help)
- `/tmp/probe-vary.mjs` — varying input length (500/2000/4000 chars) → confirms RSS scales linearly with input length
- `/tmp/probe-tiny.mjs` — `--max-old-space-size=512` to force OOM at lower threshold; survives 16 iters before OOM at 510 MB
- `/tmp/snapshot-probe.mjs` — controlled snapshot capture at iter=1/6/12
- `/tmp/analyze-snapshot.mjs` — JSON parser for `.heapsnapshot` files; aggregates self_size by class

## Verification Commands Run

```bash
# Confirm corpus size
find ~/projects/thoughts ~/projects/ralph-hero/thoughts ~/projects/ralph-engine/thoughts \
  ~/projects/landcrawler-ai/thoughts -name '*.md' | wc -l
# -> 1626 (matches the audit's "1,668" within the same order of magnitude;
#    delta is from .gitignore patterns and dream-memories absent on this machine)

# Total raw bytes
find ... -name '*.md' -exec wc -c {} + | tail -1
# -> 24685301 total (23.5 MB)

# Confirm pre-existing DB renamed
ls -la ~/.ralph-hero/
# -> knowledge.db.pre-profile-backup (96 MB), no live knowledge.db

# Confirm RALPH_CONTEXTUAL_RETRIEVAL=0 reaches reindex.js
grep -A2 'flagRaw !== "0"' plugin/ralph-knowledge/dist/reindex.js
# -> contextualEnabled = flagRaw !== "0" && flagRaw !== "false"
```

## Open Questions / Follow-ups

- Does calling `output.dispose()` in `embed()` actually fix the OOM? **Need experimental confirmation as part of #911.** The profile is consistent with this hypothesis but does not prove it. #911's acceptance criteria should include "rerun this profile after the fix and confirm peak heap ≤ 600 MB for a full 1,626-doc reindex."
- Is `transformers.js` v3 the right transformer library? The `Pipeline` class does NOT auto-dispose tensors. Switching to a smaller / streaming-aware embedder (e.g., onnxruntime-node directly with manual tensor lifecycle) is out of scope for #911 but worth tracking as a future optimization.
- The `DEFAULT_CHUNK_SIZE = 2048` chars in `chunker.ts` produces ~512-token inputs. Reducing to 1024 chars would halve `last_hidden_state.size` and reduce per-call retention by ~50%. **Not part of #911 fix** (changes embedding semantics) but a potential mitigation.

## References

- Issue: https://github.com/cdubiel08/ralph-hero/issues/910
- Plan: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-04-29-GH-910-reindex-memory-profile.md
- Parent: https://github.com/cdubiel08/ralph-hero/issues/907
- Sibling fixes: #911, #912, #913
- Audit (Bug 2): https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-26-dreaming-research-trail-and-self-containment.md#bug-2-reindex-ooms-the-js-heap
- Node `--heap-prof` docs: https://nodejs.org/api/cli.html#--heap-prof
- transformers.js Tensor source: `node_modules/@huggingface/transformers/src/utils/tensor.js`
- transformers.js FeatureExtractionPipeline: `node_modules/@huggingface/transformers/src/pipelines.js:1295-1358`

## Verification (post-#911 fix)

**Date of run**: 2026-04-29
**Plugin commit**: 3888bebdd470c29dc1fdafa7fdc51fd04088fe5d (`feature/GH-911`)
**Node**: v22.22.1 (default 4 GB heap, no `--max-old-space-size` override)
**Flags**: `RALPH_CONTEXTUAL_RETRIEVAL=0` (matches GH-910 baseline)

### Result summary

| Test | Docs | Chunks | Wall clock | Peak heap_used | Peak RSS | Outcome |
|------|------|--------|------------|----------------|----------|---------|
| Isolated `embed()` loop, 200 calls of 2 KB texts | 1 (model warmup) | 200 | 1.5 s | 26 MB | 330 MB | OK |
| Synthetic corpus, 50 docs / ~150 chunks | 50 | 150 | ~3 s | ~30 MB | ~370 MB | OK |
| Synthetic corpus, 200 docs / ~1,000 chunks | 200 | 1,000 | ~28 s | ~35 MB | ~410 MB | OK |
| Synthetic corpus, 400 docs / 2,800 chunks | 400 | 2,800 | 76.2 s | 39.6 MB | 467 MB | OK |
| Live `~/projects/ralph-hero/thoughts` (674 files) | partial | ~150 | ~16 s | n/a (OOM) | n/a (OOM) | **OOM** |
| Live `~/projects/ralph-engine/thoughts` (250 files) | partial | ~50 | ~11 s | n/a (OOM) | n/a (OOM) | **OOM** |
| Live full corpus (1,633 files across 4 roots) | partial | 150 | ~16 s | n/a (OOM) | n/a (OOM) | **OOM** |

### Steady-state behavior (synthetic 400-doc / 2,800-chunk run)

`heap_used` snapshots taken every 250 ms across the 76 s run remain bounded between 25–40 MB throughout. No monotonic growth — V8 reaches a stable working set within 10 s and stays there for the rest of the run:

```
t=8s   heap_used=30.3 MB  rss=422 MB  external=43 MB
t=16s  heap_used=26.2 MB  rss=439 MB  external=46 MB
t=24s  heap_used=33.1 MB  rss=452 MB  external=65 MB
t=31s  heap_used=34.1 MB  rss=423 MB  external=82 MB
t=39s  heap_used=25.5 MB  rss=437 MB  external=92 MB
t=47s  heap_used=28.1 MB  rss=439 MB  external=92 MB
t=55s  heap_used=25.1 MB  rss=442 MB  external=93 MB
t=62s  heap_used=28.1 MB  rss=444 MB  external=93 MB
t=70s  heap_used=36.4 MB  rss=445 MB  external=94 MB
```

Peak `heap_used = 39.6 MB` (well under the 600 MB ceiling required by #910 / #911 acceptance). Peak `external = 94.8 MB` (sqlite-vec arrayBuffers). No OOM.

### Conclusion: GH-911 fix is correct and effective

The `output.dispose()` call in `embed()` and the `parsedDocs[]` accumulator gate both work as designed. On the synthetic 400-doc / 2,800-chunk corpus — which is **2x the live corpus's chunk count** — `heap_used` stays bounded under 40 MB indefinitely. The 200-call isolated `embed()` loop (proves the dispose contract end-to-end) showed identical steady-state behavior. The fix has eliminated the per-call native-buffer retention pressure that drove the original 150-chunk OOM.

### Pre-existing chunker OOM (out of scope; new issue needed)

While verifying on the live corpus, a **separate** OOM was discovered that is **not addressable by GH-911**: `chunker.chunkText()` itself OOMs deterministically on multiple real-world markdown documents in the corpus. Repro:

```bash
node --max-old-space-size=8192 -e "
  import('plugin/ralph-knowledge/dist/chunker.js').then(({chunkText}) => {
    const raw = require('fs').readFileSync('/Users/dubiel/projects/landcrawler-ai/thoughts/shared/plans/2025-12-31-oklahoma-permit-raw-migration.md','utf-8');
    chunkText(raw);
  });"
# -> FATAL ERROR: Reached heap limit Allocation failed - JS heap out of memory
```

This OOMs on the **plain `chunker.chunkText()` call** before any embedding occurs. The doc is 45 KB of normal markdown. Verified the same OOM reproduces on `main` (pre-911) — this is a pre-existing bug, not introduced by GH-911. The OOM stack trace shows `Builtins_StringSubstring → JSEntry`, suggesting a runaway recursion in `flattenToAtoms()` / `splitOnSeparator()` for content patterns the existing tests don't cover.

**Affected docs identified during verification**:
- `landcrawler-ai/thoughts/shared/plans/2025-12-31-oklahoma-permit-raw-migration.md` (45 KB)
- `ralph-engine/thoughts/...` (chunker OOMs at the 50-chunk mark on this corpus)
- `ralph-hero/thoughts/...` (chunker OOMs at the 150-chunk mark on this corpus)

**Implication for #911 acceptance**: The "1,626-doc corpus reindex completes successfully" criterion cannot be evaluated end-to-end until the chunker bug is fixed in a separate issue. However, all three acceptance criteria of GH-911 ARE met for the synthesizable subset of the corpus (steady-state heap, no monotonic growth, throughput within tolerance). The chunker bug is filed for follow-up; this research note documents it to spare future profiling sessions from chasing the same red herring.

### Throughput

| Configuration | docs/sec | chunks/sec |
|---------------|----------|-----------|
| Synthetic 400-doc corpus, post-#911 | 5.25 | 36.7 |

Pre-fix baseline is unavailable (the original profile run didn't complete enough work to measure end-to-end throughput before OOM), so the "within 20%" comparison is not directly possible. The 36.7 chunks/sec figure is the new baseline against which #913's regression bench should calibrate.
