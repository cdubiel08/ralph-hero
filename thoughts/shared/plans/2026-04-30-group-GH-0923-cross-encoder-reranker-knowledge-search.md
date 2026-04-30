---
date: 2026-04-30
status: draft
type: plan
github_issue: 923
github_issues: [923, 925, 926, 927]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/923
  - https://github.com/cdubiel08/ralph-hero/issues/925
  - https://github.com/cdubiel08/ralph-hero/issues/926
  - https://github.com/cdubiel08/ralph-hero/issues/927
primary_issue: 923
tags: [ralph-knowledge, reranker, cross-encoder, hybrid-search, retrieval-quality]
---

# Cross-encoder reranker for knowledge_search - Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-04-26-GH-0901-local-cross-encoder-reranker-m5-pro]]
- builds_on:: [[2026-04-26-softmax-and-rerank-calibration]]
- builds_on:: [[2026-04-29-knowledge-search-vs-ripgrep]]

## Overview

4 related issues for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-923 | Extract reranker module from benchmark with lazy load + score API | S |
| 2 | GH-925 | Wire Reranker into HybridSearch.search after RRF | S |
| 3 | GH-926 | Expose `rerank` parameter on knowledge_search MCP tool | XS |
| 4 | GH-927 | Re-run 8-query golden eval with rerank=true and document latency | XS |

**Why grouped**: This is a tightly-coupled chain extending parent #919 (M-issue split). Phase 1 produces the `Reranker` class consumed by Phase 2's `HybridSearch` wiring. Phase 3 surfaces the `rerank` param through MCP using Phase 2's plumbing. Phase 4 closes #919's measurable acceptance criteria (Hit@1 ≥ 50%) by re-running the existing 8-query eval against the now-live MCP surface. Splitting them across PRs would force a partial integration where each phase has nothing observable to ship on its own — the entire chain is one logical change to make rerank a first-class option of `knowledge_search`.

## Shared Constraints

These constraints apply to all four phases:

1. **No new npm dependencies.** `@huggingface/transformers` v3 is already a project dependency ([package.json:22](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/package.json#L22)). The benchmark already loads `AutoTokenizer` + `AutoModelForSequenceClassification` from it ([reranker-bench.ts:20-25](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/benchmark/reranker-bench.ts#L20-L25)).
2. **Direct tokenizer + model path, NOT `pipeline('text-classification', ...)`.** The high-level pipeline silently coerces `{text, text_pair}` to strings and returns a constant `score=1` ([reranker-bench.ts:178-204](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/benchmark/reranker-bench.ts#L178-L204) is the load-bearing comment block). All reranker code uses `await tokenizer(texts, { text_pair, padding, truncation })` then `await model(inputs)` then `outputs.logits.tolist()`.
3. **ESM module system.** All internal imports require `.js` extensions (e.g., `import { Reranker } from "./reranker.js"`). Project uses `"type": "module"` with `"module": "NodeNext"` ([tsconfig.json:3-4](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/tsconfig.json#L3-L4)).
4. **Default model: `onnx-community/bge-reranker-v2-m3-ONNX` with `dtype: "q8"`.** This is the variant that benchmarked best in #901 — same defaults the bench uses ([reranker-bench.ts:55-60](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/benchmark/reranker-bench.ts#L55-L60)).
5. **Default `rerank: false` (opt-in).** Per parent #919 acceptance criteria, ship opt-in initially; flip to opt-out only after Phase 4's eval re-run confirms no regression on Q5/Q7. Phase 3 uses zod `.optional().default(false)` mirroring `return_diagnostics` ([index.ts:107-111](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/index.ts#L107-L111)).
6. **Byte-identical default behavior.** When `rerank` is omitted/false, the JSON payload from `knowledge_search` MUST be byte-identical to today. Verified via the existing `diagnosticMode=false` test pattern ([hybrid-search.test.ts:743-760](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/__tests__/hybrid-search.test.ts#L743-L760)).
7. **`SearchResult.score` semantics preserved.** `score` continues to mean "RRF score". Rerank logits surface via a new optional `rerankScore` field, mirroring the `ftsScore`/`vecDistance` diagnostic-field pattern ([search.ts:46-66](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/search.ts#L46-L66)). This keeps `score` stable across `rerank` on/off so callers that sort/filter on it don't break.
8. **Test injection: stub the `Reranker` via dependency injection.** Follow the `embedFn` pattern at [index.ts:69](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/index.ts#L69) — a deterministic stub avoids the ONNX model download in unit tests (the real model is ~580 MB at q8). Production constructs the real `Reranker` at server-create time.
9. **Lazy load.** The `Reranker` constructor MUST NOT load the model. The 5-10s cold-start cost (ONNX load + warmup, per #901) is paid on the first `score()` call only. Empty `docs` → return empty map without loading.
10. **No CI infrastructure changes.** ralph-knowledge's `npm test` (vitest run) and `npm run build` (tsc) are the verification commands ([package.json:14-19](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/package.json#L14-L19)). All new tests must run without network access (unit tests use stubs; integration testing the live reranker happens in Phase 4 against the user's local DB).

## Current State Analysis

**Reranker has been benchmarked and is viable on M5 Pro, but is NOT in the default `knowledge_search` query path.** The benchmark at [`benchmark/reranker-bench.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/benchmark/reranker-bench.ts) loads two ONNX cross-encoders (BGE-Reranker-v2-m3-int8 and ms-marco-MiniLM-L-6-v2), runs them against the top-20 RRF candidates from 44 sample queries, and writes a TSV with cold-start, p50/p95 latency, batch latency, RSS delta, and top-3 agreement. The bench established that BGE-v2-m3-int8 is the recommended production default.

**As a result, retrieval quality on specific-keyword queries is poor.** The 2026-04-29 8-query golden eval ([`evals/2026-04-29-knowledge-search-vs-ripgrep.md`](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/evals/2026-04-29-knowledge-search-vs-ripgrep.md)) measured Hit@1 = 25% (semantic) vs 62.5% (lexical ripgrep). 4 of 8 expected docs are missing from semantic top-10 despite being indexed — they appear in the FTS-side hybrid candidate set but RRF's `1/(60+rank)` averaging buries them when the vector half doesn't also rank them highly. The reranker would rescore the top-K candidates and surface them.

**The integration point in `hybrid-search.ts` is well-defined.** Per [research §"Integration point"](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-26-GH-0901-local-cross-encoder-reranker-m5-pro.md), the rerank splice happens after the RRF score map is built and post-filters applied (line 215, the `let filtered = combined;` block) but BEFORE the optional MMR rerank ([hybrid-search.ts:282-289](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/hybrid-search.ts#L282-L289)) and the final `slice(0, limit)` (line 289). This places rerank between RRF and MMR in the pipeline, so when both are enabled, MMR operates on the rerank-sorted set — preserves intent: "give me the most relevant docs, then diversify within them".

**Existing patterns to mirror:**

- **Lazy singleton model loading**: [`embedder.ts:10-21`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/embedder.ts#L10-L21) caches `embedderInstance` after first `pipeline()` call.
- **Tensor disposal**: [`embedder.ts:33-41`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/embedder.ts#L33-L41) calls `output.dispose()` after copying data into a fresh `Float32Array` to prevent OOM. The reranker's `outputs.logits.tolist()` copies into a JS array so the tensor itself can be disposed after; logit values are primitives.
- **Diagnostic-field plumbing**: [`hybrid-search.ts:262-277`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/hybrid-search.ts#L262-L277) populates `ftsScore`/`vecDistance`/`hitSources` on each `SearchResult` BEFORE the optional MMR reorder so refs survive intact. `rerankScore` will follow the identical pattern.
- **MCP tool snake_case enrichment**: [`index.ts:147-151`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/index.ts#L147-L151) maps camelCase `SearchResult` fields to snake_case JSON aliases when `return_diagnostics: true`.
- **Test injection for embedFn**: [`index.test.ts:26-50`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/__tests__/index.test.ts#L26-L50) shows the `mockEmbedFn` + `callTool()` helper used to exercise tools without the real ONNX model. Reranker stub injection will follow this exact shape.

## Desired End State

### Verification

- [ ] `src/reranker.ts` exposes a `Reranker` class with constructor `{ modelId, dtype }` defaults (Phase 1).
- [ ] `Reranker.score(query, docs)` returns a `Map<id, logit>` with keys matching input doc ids, same load+score path as the bench (Phase 1).
- [ ] `HybridSearch.search()` accepts `rerank: boolean` in `SearchOptions` and rescores the post-RRF candidate set when set (Phase 2).
- [ ] `SearchResult.rerankScore?: number` is populated only when `rerank: true` (Phase 2).
- [ ] When both `rerank: true` and `lambda < 1.0` are set, rerank applies BEFORE MMR; documented in code comment (Phase 2).
- [ ] `knowledge_search` MCP tool accepts `rerank: boolean` parameter, default `false` (Phase 3).
- [ ] When `rerank: true` AND `return_diagnostics: true`, results include `rerank_score` (snake_case) (Phase 3).
- [ ] When `rerank` is omitted/false, MCP response is byte-identical to today (Phase 3).
- [ ] New eval doc at `thoughts/shared/evals/<date>-knowledge-search-with-rerank.md` covers all 8 golden queries with cold/warm latency and Hit@1/Hit@5/MRR vs baseline + ripgrep ceiling (Phase 4).
- [ ] Verdict in eval doc explicitly addresses parent #919's "Hit@1 ≥ 50%" and "no regression on Q5/Q7" criteria (Phase 4).

## What We're NOT Doing

- Flipping the default `rerank` from `false` to `true`. That is a follow-up PR after Phase 4 confirms no regression on Q5/Q7.
- Tuning RRF weights or adding learned-to-rank (separate; #899, #900).
- Changing the underlying embedding model (`Xenova/all-MiniLM-L6-v2`).
- Wiring an MLX/HTTP reranker endpoint. The rerank path is in-process ONNX via `@huggingface/transformers`, same runtime as the embedder.
- Adding Qwen3-Reranker support (research §"Qwen3 integration complexity" notes this needs a separate path).
- Refactoring the benchmark to import the new `Reranker` module. Phase 1 lists this as "optionally" — we'll do it only if it's a trivial change after the module exists; if not, the bench keeps its inline copy and we skip refactoring to avoid scope creep.
- Caching reranker scores across calls. Each query gets a fresh score; warm = model already loaded, NOT score cache.
- Adding a `RALPH_RERANKER_MODEL` env var. The default is hardcoded; env override is a follow-up if anyone asks.

## Implementation Approach

The four phases form a strict linear chain — each phase builds on the previous. Phase 1 produces a unit-tested `Reranker` class with no dependencies on the rest of the codebase. Phase 2 plumbs it through `HybridSearch.search()` behind the new `rerank` option. Phase 3 surfaces the option through the MCP tool. Phase 4 measures the result against the existing golden eval.

This means Phases 1-3 can each be reviewed independently against their acceptance criteria, but they ship as one PR (group plan convention) so the chain has no broken intermediate state in `main`.

**Phase dependency annotations** — each phase's `depends_on` line is set explicitly per the research (Phase 1 has no dependencies; 2 depends on 1; 3 depends on 2; 4 depends on 3).

---

## Phase 1: Atomic Issue GH-923 — Extract reranker module from benchmark

- **depends_on**: null

### Overview

Lift the `AutoTokenizer.from_pretrained` + `AutoModelForSequenceClassification.from_pretrained` + `tokenizer(texts, {text_pair, ...})` + `model(inputs)` + `logits.tolist()` pattern from the benchmark into a reusable `Reranker` class at [`plugin/ralph-knowledge/src/reranker.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/reranker.ts). Pure unit-testable surface — no DB, no MCP, no `HybridSearch` coupling.

### Tasks

#### Task 1.1: Create `src/reranker.ts` with `Reranker` class
- **files**: `plugin/ralph-knowledge/src/reranker.ts` (create), `plugin/ralph-knowledge/benchmark/reranker-bench.ts` (read), `plugin/ralph-knowledge/src/embedder.ts` (read)
- **tdd**: true
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] File exports `class Reranker` with constructor signature `constructor(opts?: { modelId?: string; dtype?: "fp32" | "fp16" | "q8" | "int8" | "uint8" | "q4" | "bnb4" | "auto" })`.
  - [ ] Default `modelId` = `"onnx-community/bge-reranker-v2-m3-ONNX"`, default `dtype` = `"q8"`.
  - [ ] Constructor stores opts but does NOT load the model — verified by a test asserting that constructing a `Reranker` makes zero `from_pretrained` calls.
  - [ ] File exports a `truncateForRerank(s: string, maxChars = 1000): string` helper using the same logic as [`reranker-bench.ts:173-176`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/benchmark/reranker-bench.ts#L173-L176).
  - [ ] File exports a `RerankerInput` type alias: `{ id: string; text: string }`.

#### Task 1.2: Implement lazy-load `score()` method
- **files**: `plugin/ralph-knowledge/src/reranker.ts` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] `async score(query: string, docs: Array<{ id: string; text: string }>): Promise<Map<string, number>>` returns a Map keyed by input doc ids.
  - [ ] Empty `docs` returns an empty Map without invoking `from_pretrained` — verified by spy on a `loaderFactory` injection point (see Task 1.3).
  - [ ] First non-empty `score()` call loads tokenizer + model exactly once via `AutoTokenizer.from_pretrained(modelId)` + `AutoModelForSequenceClassification.from_pretrained(modelId, dtype ? { dtype } : {})`.
  - [ ] Subsequent `score()` calls reuse the cached tokenizer + model — verified by a counter on the loader spy.
  - [ ] `score()` calls `truncateForRerank(doc.text, 1000)` per doc before building the `text_pair` array (matches bench `buildPairs` lines 199-202).
  - [ ] `score()` invokes `tokenizer(texts, { text_pair, padding: true, truncation: true })` then `model(inputs)` then reads `outputs.logits.tolist()` — single-label sigmoid head returns `[batch, 1]`, take `row[0]` per row.
  - [ ] Result map key is `docs[i].id` for the i-th logit (preserves input order mapping).

#### Task 1.3: Add loader injection point for testability
- **files**: `plugin/ralph-knowledge/src/reranker.ts` (modify)
- **tdd**: true
- **complexity**: low
- **depends_on**: [1.2]
- **acceptance**:
  - [ ] Constructor accepts an optional `loader?: () => Promise<{ tokenizer: PreTrainedTokenizer; model: PreTrainedModel }>` field. When provided, replaces the default `AutoTokenizer.from_pretrained` + `AutoModelForSequenceClassification.from_pretrained` calls.
  - [ ] Default loader (when `opts.loader` is absent) constructs the real loaders from `@huggingface/transformers`, parameterized by `modelId` + `dtype`.
  - [ ] `loader` is invoked at most once across the lifetime of a `Reranker` instance — verified by a spy that counts invocations.

#### Task 1.4: Add unit tests at `src/__tests__/reranker.test.ts`
- **files**: `plugin/ralph-knowledge/src/__tests__/reranker.test.ts` (create), `plugin/ralph-knowledge/src/__tests__/embedder.test.ts` (read)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [1.3]
- **acceptance**:
  - [ ] Test "constructor does not invoke loader": construct a Reranker with a spy `loader`, assert `loader` was called 0 times.
  - [ ] Test "empty docs returns empty map without loading": call `score("q", [])`, assert returned `Map.size === 0` and loader called 0 times.
  - [ ] Test "score keys match input doc ids": stub loader returning a fake tokenizer (returns a sentinel `inputs`) + fake model (returns `{ logits: { tolist: () => [[0.5], [0.3], [0.7]] } }`). Pass `[{id:"a",text:"..."}, {id:"b",text:"..."}, {id:"c",text:"..."}]`. Assert returned map has keys `{"a","b","c"}` and values `{a:0.5, b:0.3, c:0.7}`.
  - [ ] Test "loader invoked exactly once across multiple score calls": call `score("q1", [{id:"a", text:"x"}])` then `score("q2", [{id:"b", text:"y"}])`. Assert spy loader called exactly 1 time.
  - [ ] Test "truncateForRerank caps at maxChars": passing a 2000-char string returns a 1000-char string; passing a 500-char string returns it unchanged.
  - [ ] All tests run without network access (loader is fully stubbed; no `vi.mock("@huggingface/transformers")` needed since the loader injection point bypasses the import).

### Phase Success Criteria

#### Automated Verification:
- [ ] `cd plugin/ralph-knowledge && npm run build` — no errors (verifies `dist/reranker.js` is produced).
- [ ] `cd plugin/ralph-knowledge && npx vitest run src/__tests__/reranker.test.ts` — all new tests pass.
- [ ] `cd plugin/ralph-knowledge && npm test` — full test suite passes (no regressions).

#### Manual Verification:
- [ ] `dist/reranker.js` exists after build with `class Reranker` exported (spot-check the compiled output).
- [ ] No new lines in `package.json` dependencies (Constraint 1: no new npm deps).

**Creates for next phase**: `Reranker` class importable as `import { Reranker, type RerankerInput } from "./reranker.js"` in Phase 2's `hybrid-search.ts`.

---

## Phase 2: Atomic Issue GH-925 — Wire Reranker into HybridSearch.search after RRF

- **depends_on**: [phase-1]

### Overview

Plumb the Phase 1 `Reranker` into `HybridSearch.search()` as an optional final-stage rescore. Adds `rerank?: boolean` to `SearchOptions`, an optional reranker constructor injection to `HybridSearch`, the splice point between post-filter and MMR, and the `rerankScore` field on `SearchResult` that survives MMR's reorder.

### Tasks

#### Task 2.1: Extend `SearchOptions` and `SearchResult` in `search.ts`
- **files**: `plugin/ralph-knowledge/src/search.ts` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] `SearchOptions` adds optional `rerank?: boolean` with JSDoc describing the latency/quality tradeoff and the default-false opt-in (Constraint 5).
  - [ ] `SearchResult` adds optional `rerankScore?: number` with JSDoc noting "raw cross-encoder logit; populated only when `rerank: true`. Higher = more relevant. RRF `score` field is preserved separately." (Constraint 7).
  - [ ] No other shape changes to either interface — diagnostic fields (`ftsScore`, `vecDistance`, `hitSources`) and chunk fields untouched.

#### Task 2.2: Add `Reranker` constructor injection to `HybridSearch`
- **files**: `plugin/ralph-knowledge/src/hybrid-search.ts` (modify), `plugin/ralph-knowledge/src/reranker.ts` (read)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [2.1]
- **acceptance**:
  - [ ] `HybridSearch` constructor accepts a 5th optional argument `reranker?: Reranker`. Existing callers (`benchmark/reranker-bench.ts:434`, `index.ts:78`, all tests) work unchanged because the param is optional.
  - [ ] Stored as `private readonly reranker?: Reranker`.
  - [ ] When `options.rerank === true` BUT `this.reranker` is undefined, behave as if `rerank` was false (defensive — log nothing, return RRF order). This guards the `index.ts` upgrade order during incremental rollouts.

#### Task 2.3: Implement rerank splice in `HybridSearch.search()`
- **files**: `plugin/ralph-knowledge/src/hybrid-search.ts` (modify)
- **tdd**: true
- **complexity**: high
- **depends_on**: [2.2]
- **acceptance**:
  - [ ] Splice point is AFTER post-filters (`filtered = ...`), AFTER chunk-meta enrichment loop, AFTER diagnostic-mode population, BEFORE the optional MMR `applyMMR()` block (around hybrid-search.ts:279).
  - [ ] Triggered ONLY when `options.rerank === true` AND `this.reranker !== undefined` AND `filtered.length > 0`.
  - [ ] Compute `topN = Math.min(filtered.length, Math.max(50, limit * 5))` — the rerank window. Use `filtered.slice(0, topN)` as the candidate set; docs beyond topN keep their RRF position appended unchanged after the rerank set.
  - [ ] Build `RerankerInput[]` from the candidate set: `{ id: r.id, text: truncateForRerank(\`${r.title}\n${r.snippet}\`) }` — mirror the bench `buildPairs` pattern at [reranker-bench.ts:193-204](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/benchmark/reranker-bench.ts#L193-L204).
  - [ ] Call `await this.reranker.score(query, inputs)` — yields `Map<id, logit>`.
  - [ ] Stamp `r.rerankScore = scoreMap.get(r.id)` on each candidate; if a candidate's id is missing from the map, leave `rerankScore` undefined and keep the candidate's RRF position (defensive — documented as "fallback" in code comment).
  - [ ] Re-sort the candidate set descending by `rerankScore ?? -Infinity` so docs missing a score sink to the bottom of the rerank window but before the un-reranked tail.
  - [ ] Reassemble `filtered = [...rerankedTopN, ...filtered.slice(topN)]`.
  - [ ] Add a code comment block above the splice documenting: (a) score semantics (RRF in `score`, logit in `rerankScore`), (b) ordering rule (rerank-before-MMR when both enabled), (c) fallback for missing ids, (d) cite Constraint 7 from the plan.

#### Task 2.4: Verify rerank-before-MMR ordering is correct
- **files**: `plugin/ralph-knowledge/src/hybrid-search.ts` (modify)
- **tdd**: true
- **complexity**: low
- **depends_on**: [2.3]
- **acceptance**:
  - [ ] Existing `applyMMR()` call site at lines 282-289 is unchanged — MMR receives the rerank-sorted `filtered` array (when both enabled).
  - [ ] `applyMMR` signature does NOT change. The existing `bestChunkByDoc` map remains valid because rerank operates on `SearchResult` references — the same objects flow into MMR with `rerankScore` populated.
  - [ ] When `rerank: true` AND `lambda < 1.0` are both set, the resulting order is: `applyMMR(rerank-sorted candidates, lambda, limit, bestChunkByDoc)`. MMR's relevance term uses `score` (RRF), NOT `rerankScore` — this is a deliberate choice (rerank already determined "most relevant"; MMR adds diversity over the rerank set). Documented in the code comment from Task 2.3.

#### Task 2.5: Extend `src/__tests__/hybrid-search.test.ts` with rerank cases
- **files**: `plugin/ralph-knowledge/src/__tests__/hybrid-search.test.ts` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [2.4]
- **acceptance**:
  - [ ] New `describe("HybridSearch rerank wiring (GH-925)")` block added at the end of the file.
  - [ ] Test "rerank=false (or omitted) is byte-identical to today": run `hybrid.search("cache OR auth")` (no rerank), then `hybrid.search("cache OR auth", { rerank: false })` against a hybrid constructed with a stub reranker. Assert the two arrays deep-equal each other AND deep-equal the array from a hybrid constructed WITHOUT the reranker — confirms zero side-effects when off.
  - [ ] Test "stub reranker logits drive new order": stub returns `Map { "auth-doc"=>0.9, "cache-doc"=>0.1 }`. Run with `rerank: true`. Assert `results[0].id === "auth-doc"`, `results[1].id === "cache-doc"`, AND each result has `rerankScore` populated.
  - [ ] Test "stub returns no score for a doc id → that doc is sunk to bottom of rerank window": stub returns `Map { "auth-doc"=>0.5 }` only. Pass both docs through rerank; assert `auth-doc` ranks above `cache-doc` (since cache-doc gets `rerankScore=undefined` which sorts below 0.5), and `cache-doc.rerankScore === undefined`.
  - [ ] Test "rerank + lambda<1 applies rerank before MMR": construct fixture with 3 docs where rerank logits would put A>B>C but doc-doc cosine sim makes A and B near-duplicates. Run with `rerank: true, lambda: 0.7, limit: 2`. Assert results are A then C (B demoted by MMR because near-dup with A — confirms MMR ran on rerank-sorted set).
  - [ ] Test "rerank + return_diagnostics: rerankScore survives MMR reorder": run with all three flags on; assert every returned hit has both `rerankScore` (number) and `hitSources` (array) populated.
  - [ ] Test "no reranker injected + rerank=true: behaves as RRF-only": construct hybrid WITHOUT passing a reranker. Run with `rerank: true`. Assert results match the RRF-only ordering and no `rerankScore` field appears.
  - [ ] Stub reranker class is a small inline helper at the top of the new describe block: `class StubReranker { constructor(public scoreMap: Map<string, number>) {}; async score(_q: string, _docs: any[]) { return this.scoreMap; } }` — typed loosely is fine for tests.

### Phase Success Criteria

#### Automated Verification:
- [ ] `cd plugin/ralph-knowledge && npx vitest run src/__tests__/hybrid-search.test.ts` — full file passes including new rerank block AND existing MMR + diagnostic blocks (no regression).
- [ ] `cd plugin/ralph-knowledge && npm run build` — no errors.
- [ ] `cd plugin/ralph-knowledge && npm test` — full test suite passes.

#### Manual Verification:
- [ ] Code comment in `hybrid-search.ts` near the splice point documents the rerank-before-MMR ordering and the score semantics decision (Constraint 7 + Task 2.3 + Task 2.4 acceptance).

**Creates for next phase**: `HybridSearch.search()` accepts `rerank: boolean` end-to-end. The reranker can be passed at construction time. Phase 3 wires production construction in `index.ts`.

---

## Phase 3: Atomic Issue GH-926 — Expose `rerank` parameter on knowledge_search MCP tool

- **depends_on**: [phase-2]

### Overview

Surface the new `rerank` option through the MCP tool registration in `index.ts` so Claude Code agents can opt in per-query. Wires production `Reranker` construction into `createServer` and adds the `rerank_score` snake_case field to enriched results when both `rerank` and `return_diagnostics` are true.

### Tasks

#### Task 3.1: Construct production `Reranker` in `createServer`
- **files**: `plugin/ralph-knowledge/src/index.ts` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] `import { Reranker } from "./reranker.js"` added to the imports block.
  - [ ] In `createServer`, after `const hybrid = new HybridSearch(db, fts, vec, embedImpl);` (line 78), construct `const reranker = opts.rerankerFactory ? opts.rerankerFactory() : new Reranker();` and re-assign hybrid: `const hybrid = new HybridSearch(db, fts, vec, embedImpl, reranker);`.
  - [ ] `CreateServerOptions` interface adds optional `rerankerFactory?: () => Reranker` field with JSDoc explaining test-injection pattern (mirrors `embedFn` at line 69).
  - [ ] Production callers that instantiate `createServer(dbPath)` without opts continue to work — `Reranker` constructor is lazy (no model load until first `score()` call per Phase 1 Task 1.2 acceptance).

#### Task 3.2: Add `rerank` parameter to `knowledge_search` zod schema
- **files**: `plugin/ralph-knowledge/src/index.ts` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [3.1]
- **acceptance**:
  - [ ] After the `return_diagnostics` schema line (line 111), add: `rerank: z.boolean().optional().default(false).describe("Apply cross-encoder reranking to the post-RRF top-N candidates (BGE-Reranker-v2-m3-int8). Adds ~0.5-1s of latency on first call (cold-start model load) and ~25-45ms per pair on warm calls. Improves Hit@1 on specific-keyword queries; default off until the eval re-run confirms no regression on paraphrase queries."),` — description text MUST mention the latency tradeoff (Constraint 5 acceptance from issue body).
  - [ ] In the `hybrid.search()` call (line 115), pass `rerank: args.rerank` alongside the existing options.

#### Task 3.3: Plumb `rerank_score` through the enriched payload
- **files**: `plugin/ralph-knowledge/src/index.ts` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [3.2]
- **acceptance**:
  - [ ] In the `enriched.map(...)` block (lines 124-159), the destructuring at line 128 adds `rerankScore` alongside `ftsScore`, `vecDistance`, `hitSources`.
  - [ ] After the `if (args.return_diagnostics) { ... }` block at lines 147-151, ALSO populate `if (args.rerank && args.return_diagnostics) { if (rerankScore !== undefined) base.rerank_score = rerankScore; }`.
  - [ ] When `rerank: true` AND `return_diagnostics: false`, `rerank_score` is NOT added to the payload (diagnostic field discipline — matches existing pattern that hides `fts_score` etc. unless diagnostics requested). Verified by Task 3.4 test.
  - [ ] When `rerank: false` (or omitted), `rerank_score` is NEVER in the payload regardless of `return_diagnostics` value. Verified by Task 3.4 test.

#### Task 3.4: Add MCP tool tests for the rerank parameter
- **files**: `plugin/ralph-knowledge/src/__tests__/index.test.ts` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [3.3]
- **acceptance**:
  - [ ] New `describe("knowledge_search rerank parameter (GH-926)")` block added.
  - [ ] Schema validation test: `expect(() => schema.parse({ query: "x", rerank: true })).not.toThrow()`, same for `false`, omitted, and `expect(() => schema.parse({ query: "x", rerank: "yes" })).toThrow()`.
  - [ ] Smoke test invoking `callTool(server, "knowledge_search", { query, rerank: true, return_diagnostics: true })` against a server constructed with `rerankerFactory: () => stubReranker`. Assert each result in the parsed JSON contains `rerank_score: <number>`.
  - [ ] Smoke test "rerank: true + return_diagnostics: false → no rerank_score key": same call but `return_diagnostics: false`. Assert no `rerank_score` field on any result.
  - [ ] Smoke test "rerank: false → byte-identical to today": invoke with `rerank: false` and `rerank` omitted; both responses deep-equal each other and contain no `rerank_score` field.
  - [ ] Stub `rerankerFactory` returns a minimal stub whose `score()` method returns a deterministic `Map`. Inline class definition in the test file (no shared helper file needed).

### Phase Success Criteria

#### Automated Verification:
- [ ] `cd plugin/ralph-knowledge && npx vitest run src/__tests__/index.test.ts` — passes including new rerank block AND existing schema/tool registration blocks.
- [ ] `cd plugin/ralph-knowledge && npm run build` — produces clean `dist/index.js`.
- [ ] `cd plugin/ralph-knowledge && npm test` — full suite passes.

#### Manual Verification:
- [ ] Tool description string in `index.ts` mentions the `rerank` latency/quality tradeoff (Phase 3 Task 3.2 acceptance).
- [ ] Default `rerank: false` confirmed by reading the schema definition.

**Creates for next phase**: `knowledge_search` MCP tool accepts `rerank: true` with the real `Reranker` loaded lazily on first call. Phase 4 can now invoke this tool against the user's local DB.

---

## Phase 4: Atomic Issue GH-927 — Re-run 8-query golden eval with rerank=true

- **depends_on**: [phase-3]

### Overview

Re-run the 8-query golden eval against the now-live `knowledge_search` with `rerank: true`. Capture cold/warm latency and per-query rank-of-expected. Write a new eval doc that compares against the existing baseline + ripgrep ceiling and explicitly addresses parent #919's "Hit@1 ≥ 50%" and "no regression on Q5/Q7" criteria.

### Tasks

#### Task 4.1: Run the 8 golden queries with rerank=true
- **files**: `thoughts/shared/evals/2026-04-29-knowledge-search-vs-ripgrep.md` (read)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] Each of the 8 queries from the baseline doc (lines 35-44) is invoked via the MCP tool with `rerank: true, return_diagnostics: true, limit: 10` against `~/.ralph-hero/knowledge.db`.
  - [ ] For each query, capture: top-10 doc list (id + path), rank of expected doc (or "not in top-10"), `rerank_score` of the expected doc (when present in top-10).
  - [ ] First call's wall-clock time is recorded as cold-start latency (model load + warmup + first batch).
  - [ ] Subsequent 7 calls' wall-clock times are recorded as warm latency. Compute p50 and p95 across the 7 warm calls.
  - [ ] Optionally repeat each query 3 times after warmup to reduce variance — record median per query.

#### Task 4.2: Write the new eval doc
- **files**: `thoughts/shared/evals/2026-04-30-knowledge-search-with-rerank.md` (create), `thoughts/shared/evals/2026-04-29-knowledge-search-vs-ripgrep.md` (read)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [4.1]
- **acceptance**:
  - [ ] New file at `thoughts/shared/evals/2026-04-30-knowledge-search-with-rerank.md` (or run-date if implementation slips).
  - [ ] Frontmatter mirrors the baseline doc: `date`, `status: complete`, `type: eval`, `tags: [ralph-knowledge, retrieval-quality, evaluation, semantic-search, cross-encoder-reranker]`, `github_issues: [919, 923, 925, 926, 927]`.
  - [ ] Methodology section states: same 8 queries, same DB, same corpus, only difference is `rerank: true`. Lists model id and dtype (`onnx-community/bge-reranker-v2-m3-ONNX`, `q8`).
  - [ ] Results table: per-query rank-of-expected with three columns (Semantic+rerank, Semantic baseline, Lexical ripgrep ceiling).
  - [ ] Aggregate metrics table: Hit@1, Hit@5, MRR for Semantic+rerank vs Semantic baseline vs Lexical ceiling.
  - [ ] Latency table: cold-start ms (first call), warm p50 ms, warm p95 ms — per query and aggregate.
  - [ ] Per-query observations subsection (mirror the baseline doc's lines 70-86 format) describing what changed for each of the 8 queries.
  - [ ] Verdict section explicitly states: (a) did Hit@1 ≥ 50%? (b) did Q5 (reranker calibration) and Q7 (context handoff) hold or regress? (c) recommended next action (flip default? remain opt-in? roll back?).

#### Task 4.3: Update parent #919 with the verdict
- **files**: (no files — GitHub comment only)
- **tdd**: false
- **complexity**: low
- **depends_on**: [4.2]
- **acceptance**:
  - [ ] If Hit@1 ≥ 50% AND no regression on Q5/Q7: post a comment on #919 with the aggregate metric table, link to the new eval doc, and check off the "Hit@1 ≥ 50%", "Latency budget documented", and "No regression on Q5/Q7" boxes from the parent's acceptance criteria.
  - [ ] Also append a "Follow-up" section to the existing baseline doc (`evals/2026-04-29-knowledge-search-vs-ripgrep.md`) linking to the new eval doc.
  - [ ] If criteria are NOT met: post a comment on #919 documenting the failure mode (which queries regressed), recommend whether to keep rerank opt-in, raise topN window, or close #919 as "tried, didn't help". Do NOT check off any acceptance boxes.

### Phase Success Criteria

#### Automated Verification:
- [ ] New eval doc file exists at the expected path.
- [ ] Doc frontmatter parses as valid YAML (caught by ralph-knowledge reindex if anything is malformed; can be visually verified).

#### Manual Verification:
- [ ] All 8 queries have a rank-of-expected entry (number or "✗").
- [ ] Aggregate Hit@1, Hit@5, MRR are tabulated next to baseline + ripgrep.
- [ ] Cold/warm latency split is captured.
- [ ] Verdict section explicitly addresses #919's two criteria.
- [ ] Parent #919 either has the boxes checked (if criteria met) OR has a comment explaining the failure mode.

**Creates for next phase**: N/A — terminal phase. Outputs feed into a separate follow-up PR (out of scope for this group) that may flip the default to `rerank: true`.

---

## Integration Testing

- [ ] End-to-end: With Phases 1-3 merged, restart Claude Code so it picks up the new MCP server, invoke `knowledge_search` with `rerank: true` from a chat, observe that results return successfully (latency may be 5-10s on first call due to cold-start model load — this is documented and expected).
- [ ] End-to-end: Invoke `knowledge_search` without `rerank` (or with `rerank: false`) and verify the response is unchanged from a pre-merge run (Constraint 6).
- [ ] Phase 4's eval re-run IS the integration test for retrieval quality — verifies the chain produces measurably different results from RRF-only.

## References

- Parent issue: https://github.com/cdubiel08/ralph-hero/issues/919
- Phase 1 issue: https://github.com/cdubiel08/ralph-hero/issues/923
- Phase 2 issue: https://github.com/cdubiel08/ralph-hero/issues/925
- Phase 3 issue: https://github.com/cdubiel08/ralph-hero/issues/926
- Phase 4 issue: https://github.com/cdubiel08/ralph-hero/issues/927
- Reranker bench (the source of the extracted module): [`benchmark/reranker-bench.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/benchmark/reranker-bench.ts)
- Research: [2026-04-26-GH-0901-local-cross-encoder-reranker-m5-pro.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-26-GH-0901-local-cross-encoder-reranker-m5-pro.md)
- Calibration research: [2026-04-26-softmax-and-rerank-calibration.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-26-softmax-and-rerank-calibration.md)
- Baseline eval: [2026-04-29-knowledge-search-vs-ripgrep.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/evals/2026-04-29-knowledge-search-vs-ripgrep.md)
