# ralph-knowledge benchmarks

Standalone benchmark scripts that exercise the ralph-knowledge runtime against
the live `knowledge.db`. They import from `../src/` but are NOT part of the
published npm package and are NOT executed by the test suite (`vitest`).

The `benchmark/` directory is excluded from `tsconfig.json`'s `include`
glob, so adding a script here will not change the `npm run build` output and
will not break the CI matrix on Node 18/20/22.

## Running

Each script is a standalone TypeScript file that can be run directly with
`tsx` (already a transitive devDependency via `vitest` — no install required):

```bash
# From repo root or plugin/ralph-knowledge:
npx tsx benchmark/reranker-bench.ts

# Or, equivalently, with the node loader form:
node --import tsx benchmark/reranker-bench.ts
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
