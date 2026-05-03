# ralph-knowledge benchmarks

Standalone benchmark scripts that exercise the ralph-knowledge runtime against
the live `knowledge.db`. They import from `../src/` but are NOT part of the
published npm package and are NOT executed by the test suite (`vitest`).

The `benchmark/` directory is excluded from `tsconfig.json`'s `include`
glob, so adding a script here will not change the `npm run build` output and
will not break the CI matrix on Node 18/20/22.

## Running

Each script is a standalone TypeScript file that can be run directly with
`tsx` (declared as a `devDependency` in `package.json`, installed by
`npm ci`):

```bash
# From repo root or plugin/ralph-knowledge:
npx tsx benchmark/reranker-bench.ts

# Or, equivalently, with the node loader form:
node --import tsx benchmark/reranker-bench.ts

# Or via the npm script (used by CI for the heap bench):
npm run bench:heap -- --assert
```

Scripts read the same `RALPH_KNOWLEDGE_DB` env var as the MCP server, so by
default they target `~/.ralph-hero/knowledge.db`.

## Scripts

### `reranker-bench.ts` (GH-901)

Benchmarks two ONNX cross-encoder rerankers loaded via `@huggingface/transformers`:

- `onnx-community/bge-reranker-v2-m3-ONNX` (int8 quantized) — primary candidate
- `Xenova/ms-marco-MiniLM-L-6-v2` — speed baseline

Draws a hard-coded set of ~44 sample queries spanning the five query intent
classes from the Phase 3 research (prior-work topic, plan-by-issue lookup,
claim evidence, epic context, hero orientation), runs `HybridSearch.search()`
to fetch top-20 RRF candidates per query, then reranks the candidates with
each loaded model. Captures cold-start latency, p50/p95 per-pair latency,
batch-of-20 latency, RSS memory delta, and top-3 agreement vs RRF-only.

Results are written as a TSV file at `benchmark/results-YYYY-MM-DD.tsv` and
echoed to stdout as a human-readable summary table. Models that fail to
download or load are reported with a `notes` column entry rather than aborting
the entire run.

The script is purely additive — it does not modify `hybrid-search.ts` or any
production source file. Production wiring of a default reranker is a separate
followup gated on the benchmark findings.

### `reindex-heap-bench.ts` (GH-913)

Microbenchmark guarding the OOM fix from #907 (#911 embedder tensor disposal,
#916 chunker forward-progress). Generates a deterministic 50-doc / ~240-chunk
synthetic corpus in a tmp dir via a seeded `mulberry32` RNG, runs `reindex()`
against it with `RALPH_CONTEXTUAL_RETRIEVAL=0`, samples
`process.memoryUsage()` every 100 ms, and writes a TSV row with peak
`heap_used`, `rss`, `external`, wall clock, cold start, and chunk count.

```bash
# Run once, write TSV row, no exit-1 behavior:
npx tsx benchmark/reindex-heap-bench.ts

# Same, but exit 1 if peak_heap_used > 600 MB or peak_rss > 800 MB:
npx tsx benchmark/reindex-heap-bench.ts --assert

# Same as above but via the npm script (used by CI in build-and-test-knowledge):
npm run bench:heap -- --assert
```

Results are appended one row per run to `benchmark/results-YYYY-MM-DD.tsv`
(history-preserving — re-running the bench during a tuning session adds rows
under the same header rather than overwriting). The TSV header is:

```
date	doc_count	chunk_count	cold_start_ms	wall_clock_s	peak_heap_used_mb	peak_rss_mb	peak_external_mb	threshold_pass	notes
```

Default thresholds (sourced from
[2026-04-29-reindex-memory-profile.md](../../../thoughts/shared/research/2026-04-29-reindex-memory-profile.md)):

| Threshold            | Value | Rationale                                                                                                                                  |
|----------------------|-------|--------------------------------------------------------------------------------------------------------------------------------------------|
| `peak_heap_used_mb`  | 600   | Catches catastrophic regrowth (the original OOM was 4 GB+); ~12x margin over today's typical ~30-50 MB on the 50-doc bench corpus.         |
| `peak_rss_mb`        | 800   | Catches transformer-model bloat or external-buffer growth; ~1.6-2x margin over today's typical ~400-450 MB on the 50-doc bench corpus.    |

**Tuning the thresholds**: open the TSV results history, find the
95th-percentile `peak_heap_used_mb` across the last ~10 runs on your CI
hardware, multiply by 2. That yields a regression-detection threshold without
flakiness from per-run jitter.

#### Manually verifying the bench fails on a regression

The intuition behind the bench is: **a regression that re-introduces
unbounded transient allocation will push one of the three peak metrics
(`heap_used`, `rss`, `external`) far above today's baseline**. The TSV
records all three so a tuning session can pick the right metric for the
regression class being guarded.

To confirm the bench's `--assert` path works end-to-end, force a synthetic
breach by temporarily lowering one of the thresholds in
`benchmark/reindex-heap-bench.ts`:

```bash
# In benchmark/reindex-heap-bench.ts, temporarily set:
#   const HEAP_THRESHOLD_MB = 30;   // below today's ~40 MB baseline
# (or)
#   const RSS_THRESHOLD_MB = 300;   // below today's ~450 MB baseline

npx tsx benchmark/reindex-heap-bench.ts --assert
# expected: exit code 1, console line:
#   reindex-heap-bench: ASSERT FAIL — THRESHOLD BREACH: heap_used 41.2 > 30

# Restore the threshold (revert benchmark/reindex-heap-bench.ts).
```

Do **NOT** commit the threshold change — it's a one-time confirmation that
the assertion path works end-to-end. The bench script itself is purely
additive and never modifies `embedder.ts`/`chunker.ts`/`reindex.ts`.

**Note on the dispose() regression**: an earlier draft of this section
suggested reverting `output.dispose()` in `src/embedder.ts` to verify the
bench catches the original GH-911 OOM. Empirically, on the 50-doc / ~240-chunk
synthetic corpus, removing the dispose call leaves `peak_heap_used_mb`
unchanged (~41 MB) and only adds ~3x to `peak_external_mb` (~21 MB -> ~65 MB).
The original OOM manifested at the live ~14k-chunk corpus scale, not at this
bench's scale. The bench therefore guards against **catastrophic
regressions** (a 10x+ allocation increase that crosses the 600 MB / 800 MB
margins) rather than the specific dispose() leak — which would need a much
larger synthetic corpus to be detectable. The `peak_external_mb` column is
recorded in the TSV for future tuning if a tighter native-buffer guard
becomes worth the added bench runtime.
