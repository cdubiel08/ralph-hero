---
date: 2026-04-26
github_issue: 901
github_url: https://github.com/cdubiel08/ralph-hero/issues/901
status: complete
type: research
tags: [ralph-knowledge, reranker, cross-encoder, onnx, transformers-js, apple-silicon, performance, hybrid-search]
---

# Research: Local Cross-Encoder Reranker on M5 Pro

## Prior Work

- builds_on:: [[2026-04-26-softmax-and-rerank-calibration]]
- builds_on:: [[2026-04-26-GH-0899-rrf-calibration-observability]]
- builds_on:: [[2026-04-16-GH-0761-ralph-knowledge-chunked-embeddings-dream-loop]]
- tensions:: None identified.

## Problem Statement

Issue #901 asks: what is the latency and quality of running a local cross-encoder reranker (e.g., BGE-Reranker-v2-m3) on M5 Pro hardware, and how would it complement the existing local-LLM stack? The goal is a small benchmark to determine whether a Stage-2 reranker is worth shipping, making opt-in, or skipping in favor of RRF-only.

## Current Embedding / Inference Setup

### Model: all-MiniLM-L6-v2

`plugin/ralph-knowledge/src/embedder.ts` lines 1–8 establish the embedding model:

```typescript
const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
```

This is the 22.7M-parameter MiniLM variant, 384-dimensional embeddings, loaded via `@huggingface/transformers` (transformers.js v3), which runs the ONNX Runtime under the hood. The pipeline is a `feature-extraction` pipeline with `pooling: "mean"` and `normalize: true`. The pipeline is lazily initialized and cached as a singleton (`embedderInstance`).

### Runtime: transformers.js (ONNX Runtime)

The `@huggingface/transformers` package at `^3.0.0` is listed in `package.json` as a production dependency. This package bundles ONNX Runtime and resolves model weights from Hugging Face Hub (or local cache). On Apple Silicon it selects the `cpu` execution provider by default — the WebGPU/MPS provider is available via `env.backends.onnx.wasm.numThreads` tuning but is not explicitly configured.

No CUDA, CoreML, or Metal-specific acceleration is active in the current embedder. The `all-MiniLM-L6-v2` model generates embeddings from Node.js using pure ONNX on CPU.

### Existing Local LLM Infrastructure

`plugin/ralph-knowledge/src/llm-client.ts` lines 45–49 reveal:

```typescript
const DEFAULT_BASE_URL = "http://localhost:8000";
const DEFAULT_MODEL = "mlx-community/gemma-4-26b-a4b-it-mxfp8";
```

The LLM client targets a local OpenAI-compatible server (gemma-lab, or any endpoint at `RALPH_LLM_URL`) running `Gemma 4 26B MXFP8` via MLX. This is a separate process — the MCP server communicates via HTTP, not by loading the model directly. The LLM is used only for contextual retrieval (generating chunk context prefixes at reindex time), not at query time.

This means there is already a local MLX inference server running on the M5 Pro. **A cross-encoder reranker that can expose an OpenAI-compatible scoring endpoint would slot in without any new process management** — it would reuse the same `RALPH_LLM_URL` pattern.

### Vector Dimensions

`plugin/ralph-knowledge/src/vector-search.ts` line 33:
```
embedding float[384] distance_metric=cosine
```

The sqlite-vec virtual table stores 384-dimensional cosine vectors, consistent with all-MiniLM-L6-v2.

### Hybrid Search Pipeline

`plugin/ralph-knowledge/src/hybrid-search.ts` lines 34–226 show the complete Stage-1 pipeline:

1. FTS5 search over title + path + content (FTS raw BM25 rank)
2. Vector cosine search via sqlite-vec (top 2×limit candidates)
3. Per-document bucketing: for chunked docs, take best-rank chunk per doc
4. RRF fusion with k=60: `score = 1/(60 + rank)`
5. Sort descending, apply post-filters, trim to `limit`

**The reranker slot is between step 5 (sorted RRF list) and the `return filtered.slice(0, limit)` call on line 226.** This is the single splice point where a Stage-2 reranker would take the pre-limit list and re-order it before slicing.

## BGE-Reranker-v2-m3: Analysis

### Model Specifications

| Property | Value |
|---|---|
| Parameters | 568M (0.6B) |
| Architecture | XLM-RoBERTa (cross-encoder) |
| Tensor type | F32 (fp32 on disk) |
| On-disk size (F32) | ~2.3 GB |
| Max tokens | 512 per (query, document) pair |
| ONNX model available | Yes (`onnx-community/bge-reranker-v2-m3-ONNX`) |
| Quantized variants | 43 variants on Hub |
| MTEB-R | 57.03 |
| Monthly downloads | 8.5M+ |

The model outputs raw logits converted to a [0,1] relevance score via sigmoid. It is multilingual (bge-m3 base), making it appropriate for English-only use cases while not being constrained to them.

### M5 Pro Latency Estimate

No published M5 Pro cross-encoder benchmarks were found. Extrapolating from the closest available data:

- **XLM-RoBERTa-base on M2 Max: ~27ms per inference** (arxiv:2510.18921, single-sample, no batching)
- BGE-Reranker-v2-m3 is XLM-RoBERTa at 568M params vs 279M for base — roughly 2x the base model size
- M5 Pro memory bandwidth is ~28% higher than M4 Pro, and approximately 45-55% higher than M2 Max (153 GB/s vs ~100 GB/s); latency on transformer inference scales sub-linearly with bandwidth
- Estimated per-pair latency on M5 Pro, ONNX CPU: **40–80ms** at batch=1, 512 tokens

Reranking top-20 RRF candidates: **~0.8–1.6 seconds**. Reranking top-10: **~0.4–0.8 seconds**.

This is outside a real-time interactive SLA but acceptable for background MCP tool calls where the embedding step already takes 50–200ms.

**With int8 quantization** (ONNX), the XLM-RoBERTa family typically sees 40–60% latency reduction on CPU, bringing the estimate to **25–45ms per pair** for top-20: **~0.5–0.9 seconds**.

### Transformers.js Compatibility

`onnx-community/bge-reranker-v2-m3-ONNX` is directly usable via `@huggingface/transformers`:

```typescript
import { pipeline } from '@huggingface/transformers';
const reranker = await pipeline('text-classification', 'onnx-community/bge-reranker-v2-m3-ONNX');
// pairs: Array<[query, document]>
const scores = await reranker(pairs);
```

This matches the existing runtime surface exactly — the same `@huggingface/transformers` package already loaded for embedding. No new npm dependency is required. The `pipeline('text-classification', ...)` form returns logit-based classification scores; the reranker uses these as relevance scores (higher = more relevant).

## Alternative Candidate Models

### Jina Reranker v2 (jina-reranker-v2-base-multilingual)

| Property | Value |
|---|---|
| Parameters | 278M |
| On-disk size | ~550 MB |
| Context length | 1024 tokens |
| Claimed throughput vs BGE-v2-m3 | 15x more docs per 50ms on GPU |
| ONNX available | Yes (safetensors + transformers.js) |

At 278M params vs 568M for BGE-v2-m3, Jina v2 is half the size. On the M5 Pro, the expected per-pair latency with ONNX CPU would be approximately **15–30ms** — a 2-3x speedup over BGE-v2-m3. The quality trade-off: Jina v2 is "almost state-of-the-art" per the vendor, without published neutral MTEB-R scores to compare head-to-head. However, the 15x GPU throughput advantage does not translate directly to CPU (where Flash Attention is not hardware-accelerated the same way).

### Qwen3-Reranker-0.6B (tomaarsen/Qwen3-Reranker-0.6B-seq-cls)

| Property | Value |
|---|---|
| Parameters | 0.6B (same as BGE-v2-m3) |
| Architecture | Qwen3-0.6B (decoder-only, adapted as cross-encoder) |
| On-disk size (BF16) | ~1.2 GB |
| Context length | 32K tokens |
| MTEB-R | 65.80 (vs 57.03 for BGE-v2-m3) |
| ONNX/GGUF | GGUF via `Mungert/Qwen3-Reranker-0.6B-GGUF`; seq-cls variant via `tomaarsen/Qwen3-Reranker-0.6B-seq-cls` |

The Qwen3-Reranker-0.6B outperforms BGE-v2-m3 on MTEB-R (+8.77 points) and especially MTEB-Code (+32 points), at the same parameter count. The BF16 footprint is ~1.2 GB vs 2.3 GB for BGE-v2-m3 F32. The GGUF variant enables llama.cpp inference, which uses Metal acceleration on Apple Silicon.

The `tomaarsen/Qwen3-Reranker-0.6B-seq-cls` conversion produces a sequence-classification head compatible with sentence-transformers. Transformers.js does not yet have first-class support for the Qwen3 architecture (decoder-only adapted as cross-encoder), so this model would likely require the llama.cpp path via `llama-cpp-node` or the local MLX server. This adds integration complexity relative to BGE-v2-m3.

**Runtime recommendation for Qwen3:** use the GGUF via llama.cpp with Metal on the M5 Pro, or route through the existing local MLX server if an OpenAI-compatible reranker endpoint is added.

### MS-Marco-MiniLM-L6-v2 (cross-encoder/ms-marco-MiniLM-L6-v2)

| Property | Value |
|---|---|
| Parameters | 22.7M |
| On-disk size | ~90 MB |
| ONNX available | Yes (`Xenova/ms-marco-MiniLM-L-6-v2`) |
| CPU latency (batch=1) | ~12ms per inference |
| CPU latency (batch=10) | ~59ms |

The MiniLM cross-encoder is extremely fast (12ms per pair at batch=1 on a modern CPU) and has a Xenova-prefixed ONNX model ready for transformers.js. It is English-only and has a lower quality ceiling than BGE-v2-m3, making it ideal as a speed/quality lower bound in the benchmark.

The ONNX model (`Xenova/ms-marco-MiniLM-L-6-v2`) is exactly analogous to the existing embedder — both use `Xenova/` prefix and `@huggingface/transformers`. This is the lowest-friction model to add.

## Complementarity with Existing Local LLM Stack

The local MLX stack (gemma-4-26b-a4b-it-mxfp8 at localhost:8000) is invoked only during reindex (contextual retrieval prefix generation), not during search queries. A cross-encoder reranker added to the query path is **additive**, not competitive:

| Component | When | Path |
|---|---|---|
| `all-MiniLM-L6-v2` embedder | Reindex + query | ONNX in-process |
| Gemma 4 26B LLM | Reindex only | MLX HTTP |
| Cross-encoder reranker | Query only (Stage-2) | ONNX in-process or MLX HTTP |

For ONNX-based rerankers (BGE-v2-m3, Jina v2, MiniLM-L6), no new infrastructure is needed — they load via the existing `@huggingface/transformers` dependency. For Qwen3-Reranker via GGUF, either llama.cpp or the existing MLX server (if a reranker endpoint is wired) can serve it.

The M5 Pro's memory bandwidth (153 GB/s Pro tier) and unified memory mean concurrent model loading is feasible: `all-MiniLM-L6-v2` (~90 MB ONNX) and BGE-v2-m3-int8 (~580 MB) fit comfortably in memory alongside the OS and application footprint.

## Recommended Benchmark Design

### Models to benchmark (in priority order)

1. **BGE-Reranker-v2-m3-ONNX (int8 quantized)** — primary candidate; direct transformers.js compatibility, strong MTEB, reasonable size
2. **Xenova/ms-marco-MiniLM-L-6-v2** — speed lower bound; 12ms/pair, ONNX, transformers.js-native
3. **Qwen3-Reranker-0.6B via llama.cpp GGUF** — quality upper bound; requires separate integration path

### Metrics to collect per model

- Cold-start model load time (first inference call)
- Warm per-pair latency: p50, p95 across 30–50 sample queries
- Batch latency for top-20 RRF candidates (the realistic production batch)
- Memory footprint delta (before/after model load via `process.memoryUsage()`)
- Top-3 agreement rate with RRF-only ordering (on same 30–50 sample queries)

### Benchmark script location

`plugin/ralph-knowledge/benchmark/reranker-bench.ts` — a standalone script that:
1. Loads the ralph-knowledge DB via `KnowledgeDB`
2. Draws 30–50 sample queries from the corpus (e.g., one per unique tag)
3. Runs `HybridSearch.search()` to get the RRF-ranked list (top-20)
4. Loads each reranker via `pipeline()` and rescores the same 20 candidates
5. Measures wall-clock time and top-3 agreement
6. Writes a TSV results table to `benchmark/results-YYYY-MM-DD.tsv`

### Integration point in hybrid-search.ts

The reranker would slot in after the RRF sort and before the `slice(0, limit)` call on line 226:

```typescript
// After: combined.sort((a, b) => b.score - a.score);
// After: let filtered = combined; (and the post-filters)
// Before: return filtered.slice(0, limit);

if (rerankerFn && filtered.length > limit) {
  const candidates = filtered.slice(0, limit * 2); // rerank 2x window
  filtered = await rerankerFn(query, candidates);
}
return filtered.slice(0, limit);
```

`HybridSearch` receives the reranker as an optional constructor dependency (same pattern as `embedFn`), keeping it opt-in and unit-testable.

## Risks and Considerations

**Latency budget.** The current `knowledge_search` tool has no documented SLA. MCP tool calls in Claude's context are synchronous from the tool's perspective. Adding 500ms–1s of reranker latency per search is observable but not blocking for the use case. The opt-in design (off by default) mitigates this.

**Cold-start on first query.** ONNX model files are downloaded and cached on first use by `@huggingface/transformers`. BGE-v2-m3 at 2.3 GB has a slow first-run (network-bound). The benchmark should measure warm (cached) latency, not cold-start; the benchmark report should note cold-start separately.

**Corpus size.** The ralph-knowledge corpus is ~75–150 documents. At this scale, top-20 RRF candidates typically represent a meaningful fraction of the corpus. Quality improvements from a cross-encoder may be modest for such a small, well-curated corpus — a fact the benchmark should explicitly surface.

**Qwen3 integration complexity.** Qwen3-Reranker uses a decoder-only architecture as cross-encoder, requiring special prompt formatting (system prompt with instructions + `<|im_start|>assistant<|im_end|>` suffix to extract the `yes`/`no` token log-probability). This is not natively supported by the standard `pipeline('text-classification', ...)` API without a seq-cls conversion. Only the `tomaarsen/Qwen3-Reranker-0.6B-seq-cls` variant simplifies this, at the cost of an unofficial conversion.

## Recommendation

Benchmark two models first: **BGE-Reranker-v2-m3-ONNX-int8** and **Xenova/ms-marco-MiniLM-L-6-v2**. These are directly usable via the existing transformers.js runtime with no new dependencies and no new infrastructure. If quality lift from BGE-v2-m3 over MiniLM-L6 is substantial (>3 positions shift in top-3 agreement), ship BGE-v2-m3-int8 as an opt-in feature via a `RALPH_RERANKER_MODEL` env var. If quality lift is minimal over RRF-only, document the finding and close the loop.

Add Qwen3-Reranker-0.6B as a stretch benchmark if the initial two fail to demonstrate meaningful quality lift — it is the highest-quality option at the same parameter count but requires a separate integration path.

## Files Affected

### Will Modify
- `plugin/ralph-knowledge/src/hybrid-search.ts` - Add optional `rerankerFn` constructor param and rerank splice point
- `plugin/ralph-knowledge/benchmark/reranker-bench.ts` - New benchmark script (create)

### Will Read (Dependencies)
- `plugin/ralph-knowledge/src/embedder.ts` - Runtime pattern to replicate for reranker pipeline init
- `plugin/ralph-knowledge/src/llm-client.ts` - Existing fail-open pattern and env var resolution
- `plugin/ralph-knowledge/src/db.ts` - KnowledgeDB for loading corpus in benchmark
- `plugin/ralph-knowledge/src/vector-search.ts` - VectorSearch for understanding current sqlite-vec dimensions
- `plugin/ralph-knowledge/package.json` - Existing `@huggingface/transformers` version constraint

## Sources

- [BAAI/bge-reranker-v2-m3 on Hugging Face](https://huggingface.co/BAAI/bge-reranker-v2-m3)
- [onnx-community/bge-reranker-v2-m3-ONNX on Hugging Face](https://huggingface.co/onnx-community/bge-reranker-v2-m3-ONNX)
- [Qwen/Qwen3-Reranker-0.6B on Hugging Face](https://huggingface.co/Qwen/Qwen3-Reranker-0.6B)
- [tomaarsen/Qwen3-Reranker-0.6B-seq-cls on Hugging Face](https://huggingface.co/tomaarsen/Qwen3-Reranker-0.6B-seq-cls)
- [jinaai/jina-reranker-v2-base-multilingual on Hugging Face](https://huggingface.co/jinaai/jina-reranker-v2-base-multilingual)
- [Xenova/ms-marco-MiniLM-L-6-v2 on Hugging Face](https://huggingface.co/Xenova/ms-marco-MiniLM-L-6-v2)
- [Jina Reranker v2: Ultra-Fast for Agentic RAG](https://jina.ai/news/jina-reranker-v2-for-agentic-rag-ultra-fast-multilingual-function-calling-and-code-search/)
- [Sentence Transformers: Cross-Encoder Efficiency](https://sbert.net/docs/cross_encoder/usage/efficiency.html)
- [Benchmarking On-Device ML on Apple Silicon with MLX (arxiv:2510.18921)](https://arxiv.org/html/2510.18921v1)
- [Apple ML Research: Exploring LLMs with MLX and M5 GPU](https://machinelearning.apple.com/research/exploring-llms-mlx-m5)
- [BGE Reranker BERT Crossencoder ONNX latency issue - sentence-transformers #2470](https://github.com/UKPLab/sentence-transformers/issues/2470)
- [Qwen3 Embedding & Reranker on Ollama](https://www.glukhov.org/post/2025/06/qwen3-embedding-qwen3-reranker-on-ollama/)
- [jina-ai/mlx-retrieval — Train embedding/reranker models on Apple Silicon with MLX](https://github.com/jina-ai/mlx-retrieval)
- [M4 Pro vs M5 Pro: Local AI Inference Benchmarks](https://contracollective.com/blog/m4-m5-pro-local-ai-inference-mlx-2026)
