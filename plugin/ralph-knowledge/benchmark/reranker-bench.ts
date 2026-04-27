/**
 * Phase 4 (GH-901) — Benchmark local cross-encoder rerankers on M5 Pro.
 *
 * Loads two ONNX cross-encoder rerankers via the existing
 * `@huggingface/transformers` v3 dependency, runs each over the top-20 RRF
 * candidates from a hard-coded sample-query set, and writes a TSV results
 * table covering cold-start load, per-pair latency p50/p95, batch latency,
 * RSS memory delta, and top-3 agreement vs RRF-only.
 *
 * NOT wired into `hybrid-search.ts` — production wiring is a separate
 * followup gated on the table's findings (see plan §"What We're NOT Doing").
 *
 * Run with:
 *   npx tsx plugin/ralph-knowledge/benchmark/reranker-bench.ts
 */
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  AutoTokenizer,
  AutoModelForSequenceClassification,
  type PreTrainedTokenizer,
  type PreTrainedModel,
} from "@huggingface/transformers";
import { KnowledgeDB } from "../src/db.js";
import { FtsSearch } from "../src/search.js";
import { VectorSearch } from "../src/vector-search.js";
import { HybridSearch } from "../src/hybrid-search.js";
import { embed } from "../src/embedder.js";
import type { SearchResult } from "../src/search.js";

const DEFAULT_DB_PATH = join(homedir(), ".ralph-hero", "knowledge.db");
const TOP_K_CANDIDATES = 20;
const TOP_AGREEMENT_K = 3;

/**
 * One reranker model under test. The HF model id resolves through the
 * transformers.js Hub cache (same backing store as the embedder), so no new
 * npm dependency or network setup is required beyond the first download.
 */
interface ModelSpec {
  /** Display name used in TSV + console output. */
  label: string;
  /** Hugging Face model id (loaded via `pipeline('text-classification', ...)`). */
  modelId: string;
  /**
   * Optional dtype passed to the pipeline factory. `'q8'` selects the int8
   * quantized ONNX variant when the repo ships one (BGE-Reranker-v2-m3-ONNX
   * does; MiniLM-L6 ships only fp32 + q8).
   */
  dtype?: "fp32" | "fp16" | "q8" | "int8" | "uint8" | "q4" | "bnb4" | "auto";
}

const MODELS: ModelSpec[] = [
  {
    label: "bge-reranker-v2-m3-ONNX-int8",
    modelId: "onnx-community/bge-reranker-v2-m3-ONNX",
    dtype: "q8",
  },
  {
    label: "ms-marco-MiniLM-L-6-v2",
    modelId: "Xenova/ms-marco-MiniLM-L-6-v2",
    // MiniLM ships an fp32 ONNX as the default — no quantization needed (it's
    // already tiny). Letting transformers.js pick the default avoids a load
    // failure if the q8 variant isn't packaged in this revision.
  },
];

/**
 * Hard-coded sample queries spanning the five query intent classes from
 * Phase 3 research (GH-900): prior-work topic, plan-by-issue lookup, claim
 * evidence, epic context, hero orientation. Total = 44.
 *
 * Skewed toward generic ralph-knowledge / ralph-hero corpus topics so the
 * RRF retriever returns non-empty results on a representative dev DB.
 */
const SAMPLE_QUERIES: string[] = [
  // 12 prior-work topic queries
  "hybrid search RRF fusion",
  "MMR diversity reranking",
  "cross-encoder reranker latency",
  "calibration of search scores",
  "platt scaling for retrieval",
  "softmax temperature in reranking",
  "BGE reranker BAAI multilingual",
  "transformers.js ONNX runtime apple silicon",
  "sqlite-vec cosine distance",
  "FTS5 BM25 ranking sqlite",
  "chunked embeddings dream loop",
  "contextual retrieval anthropic",
  // 8 plan-by-issue lookups
  "plan for ralph-knowledge stage-2 reranker",
  "plan GH-902 MMR diversity",
  "plan GH-899 RRF observability",
  "plan GH-901 cross-encoder benchmark",
  "plan GH-900 labeling effort scope",
  "plan GH-761 chunked embeddings",
  "plan epic ralph-hero token resolution",
  "plan hello skill output budget",
  // 8 claim evidence queries
  "evidence MMR demotes near duplicates",
  "evidence cross-encoder beats RRF",
  "evidence platt calibration improves NDCG",
  "evidence isotonic regression sample floor",
  "evidence LambdaMART labeled data requirement",
  "evidence Qwen3 reranker MTEB-R score",
  "evidence transformers.js cpu latency",
  "evidence sqlite-vec POINT query plan",
  // 8 epic context queries
  "ralph-knowledge epic stage-2 capabilities",
  "ralph-hero workflow state machine epic",
  "knowledge graph traversal epic",
  "memory tier dream loop epic",
  "outcome events search feedback epic",
  "github projects v2 automation epic",
  "claude code plugin architecture epic",
  "stream-based parallel implementation epic",
  // 8 hero orientation queries
  "what does ralph-hero do",
  "how to add a new skill to ralph-hero",
  "how to run ralph-knowledge tests",
  "how to debug MCP server stdio",
  "how to create a new agent for ralph-hero",
  "what is the ralph workflow state machine",
  "how to wire a new tool into hybrid search",
  "how plan agents dispatch impl agents",
];

/** Result row aggregated per model for TSV output. */
interface ModelResult {
  model: string;
  cold_start_ms: number;
  latency_p50_ms: number;
  latency_p95_ms: number;
  batch_top20_p50_ms: number;
  memory_rss_delta_mb: number;
  top3_agreement_avg: number;
  notes: string;
}

/**
 * Per-query, per-pair raw measurements collected before percentiling.
 */
interface PerQueryMeasurement {
  /** Wall-clock ms for the entire batch of `TOP_K_CANDIDATES` (query, doc) pairs. */
  batchMs: number;
  /** `batchMs / TOP_K_CANDIDATES` — the per-pair latency at this batch size. */
  perPairMs: number;
  /** Top-K agreement vs the RRF-only ordering of the same candidates. */
  top3Agreement: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor(sorted.length * p)),
  );
  return sorted[idx];
}

function bytesToMb(bytes: number): number {
  return bytes / (1024 * 1024);
}

/**
 * Truncate a snippet for cross-encoder consumption. The transformers.js
 * pipeline tokenizes/truncates internally to the model's max_position
 * (typically 512), but capping the input string here keeps memory and
 * tokenization cost predictable across models with different max_position.
 */
function truncateForRerank(s: string, maxChars = 1000): string {
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars);
}

/**
 * Build the parallel `texts[]` and `text_pairs[]` arrays for a candidate set.
 * The doc text combines title + snippet so the cross-encoder sees the same
 * anchor that the embedder used (title is the strongest semantic anchor in
 * this corpus).
 *
 * Returned shape matches what `tokenizer(texts, { text_pair, padding,
 * truncation })` expects — see the AutoTokenizer encode signature in
 * transformers.js (tokenizers.js `_encode_plus`). This is the only reliable
 * way to invoke a cross-encoder reranker through the library: the
 * higher-level `pipeline('text-classification', ...)` callback accepts only
 * a single text per input and silently coerces `{text, text_pair}` objects
 * to strings, returning a constant `score=1` for every pair. The direct
 * tokenizer + model path returns the actual logits.
 */
function buildPairs(
  query: string,
  candidates: SearchResult[],
): { texts: string[]; textPairs: string[] } {
  const texts: string[] = [];
  const textPairs: string[] = [];
  for (const c of candidates) {
    texts.push(query);
    textPairs.push(truncateForRerank(`${c.title}\n${c.snippet}`));
  }
  return { texts, textPairs };
}

/**
 * Compute top-K agreement: |intersection of top-K id sets| / K.
 * `rerankedOrder` is the candidate index order the reranker produced (best
 * first). The RRF baseline order is `[0, 1, ..., n-1]` since
 * `candidates` is already RRF-sorted.
 */
function topKAgreement(
  candidates: SearchResult[],
  rerankedOrder: number[],
  k: number,
): number {
  const rrfTop = new Set(candidates.slice(0, k).map((c) => c.id));
  const rerTop = new Set(
    rerankedOrder.slice(0, k).map((idx) => candidates[idx].id),
  );
  let intersect = 0;
  for (const id of rerTop) if (rrfTop.has(id)) intersect++;
  return intersect / k;
}

/**
 * Run a single reranker model against the per-query candidate sets. Returns
 * the aggregated `ModelResult` row plus a notes string describing any
 * partial failures encountered.
 */
async function benchmarkModel(
  spec: ModelSpec,
  perQueryCandidates: Array<{ query: string; candidates: SearchResult[] }>,
): Promise<ModelResult> {
  const notes: string[] = [];
  const rssBefore = process.memoryUsage().rss;

  // ---- Cold-start (load + first inference) ----
  let coldStartMs = 0;
  let tokenizer: PreTrainedTokenizer | null = null;
  let model: PreTrainedModel | null = null;
  const loadStart = performance.now();
  try {
    tokenizer = await AutoTokenizer.from_pretrained(spec.modelId);
    model = await AutoModelForSequenceClassification.from_pretrained(
      spec.modelId,
      spec.dtype ? { dtype: spec.dtype } : {},
    );
  } catch (e) {
    return {
      model: spec.label,
      cold_start_ms: 0,
      latency_p50_ms: 0,
      latency_p95_ms: 0,
      batch_top20_p50_ms: 0,
      memory_rss_delta_mb: 0,
      top3_agreement_avg: 0,
      notes: `model load failed: ${(e as Error).message}`,
    };
  }
  // First-inference penalty (model warmup): use the first query's pairs.
  const firstNonEmpty = perQueryCandidates.find((q) => q.candidates.length > 0);
  if (firstNonEmpty && model && tokenizer) {
    try {
      const { texts: warmT, textPairs: warmP } = buildPairs(
        firstNonEmpty.query,
        firstNonEmpty.candidates,
      );
      const inputs = await tokenizer(warmT, {
        text_pair: warmP,
        padding: true,
        truncation: true,
      });
      await model(inputs);
    } catch (e) {
      notes.push(`warmup-failed: ${(e as Error).message.slice(0, 80)}`);
    }
  }
  coldStartMs = performance.now() - loadStart;

  const rssAfter = process.memoryUsage().rss;
  const memDeltaMb = bytesToMb(rssAfter - rssBefore);

  // ---- Per-query measurement loop ----
  const measurements: PerQueryMeasurement[] = [];
  let queryFailures = 0;
  for (const { query, candidates } of perQueryCandidates) {
    if (candidates.length === 0) continue;
    const { texts, textPairs } = buildPairs(query, candidates);
    const start = performance.now();
    let logitsList: number[];
    try {
      const inputs = await tokenizer(texts, {
        text_pair: textPairs,
        padding: true,
        truncation: true,
      });
      const outputs = await model(inputs);
      // outputs.logits is a Tensor with shape [batch, num_labels]. Cross-
      // encoder rerankers ship a single-label sigmoid head, so logits is
      // [batch, 1]. `.tolist()` yields nested number[][]; flatten by taking
      // the first (and only) value per row. Fallback to softmax-and-take-
      // first when num_labels > 1 (e.g., a 2-class classifier).
      const logits = outputs.logits as { tolist: () => number[][]; dims?: number[] };
      const tolist = logits.tolist();
      logitsList = tolist.map((row) => (row.length > 0 ? row[0] : 0));
    } catch (e) {
      queryFailures++;
      if (queryFailures <= 3) {
        notes.push(`query-failed: ${(e as Error).message.slice(0, 80)}`);
      }
      continue;
    }
    const batchMs = performance.now() - start;

    // Map each candidate idx -> logit, sort desc.
    const scored = logitsList.map((score, idx) => ({ idx, score }));
    scored.sort((a, b) => b.score - a.score);
    const rerankedOrder = scored.map((s) => s.idx);
    const agreement = topKAgreement(
      candidates,
      rerankedOrder,
      TOP_AGREEMENT_K,
    );
    measurements.push({
      batchMs,
      perPairMs: batchMs / texts.length,
      top3Agreement: agreement,
    });
  }

  if (measurements.length === 0) {
    return {
      model: spec.label,
      cold_start_ms: Math.round(coldStartMs),
      latency_p50_ms: 0,
      latency_p95_ms: 0,
      batch_top20_p50_ms: 0,
      memory_rss_delta_mb: Number(memDeltaMb.toFixed(1)),
      top3_agreement_avg: 0,
      notes:
        notes.length > 0
          ? notes.join("; ")
          : "no successful query measurements",
    };
  }

  const perPairSorted = [...measurements.map((m) => m.perPairMs)].sort(
    (a, b) => a - b,
  );
  const batchSorted = [...measurements.map((m) => m.batchMs)].sort(
    (a, b) => a - b,
  );
  const agreementAvg =
    measurements.reduce((s, m) => s + m.top3Agreement, 0) /
    measurements.length;

  if (queryFailures > 0) {
    notes.push(
      `${queryFailures}/${perQueryCandidates.length} queries failed during rerank`,
    );
  }

  return {
    model: spec.label,
    cold_start_ms: Math.round(coldStartMs),
    latency_p50_ms: Number(percentile(perPairSorted, 0.5).toFixed(2)),
    latency_p95_ms: Number(percentile(perPairSorted, 0.95).toFixed(2)),
    batch_top20_p50_ms: Number(percentile(batchSorted, 0.5).toFixed(2)),
    memory_rss_delta_mb: Number(memDeltaMb.toFixed(1)),
    top3_agreement_avg: Number(agreementAvg.toFixed(3)),
    notes:
      notes.length > 0
        ? notes.join("; ")
        : `n=${measurements.length} queries`,
  };
}

function formatTsv(rows: ModelResult[]): string {
  const headers = [
    "model",
    "cold_start_ms",
    "latency_p50_ms",
    "latency_p95_ms",
    "batch_top20_p50_ms",
    "memory_rss_delta_mb",
    "top3_agreement_avg",
    "notes",
  ];
  const lines = [headers.join("\t")];
  for (const r of rows) {
    lines.push(
      [
        r.model,
        r.cold_start_ms,
        r.latency_p50_ms,
        r.latency_p95_ms,
        r.batch_top20_p50_ms,
        r.memory_rss_delta_mb,
        r.top3_agreement_avg,
        r.notes,
      ].join("\t"),
    );
  }
  return lines.join("\n") + "\n";
}

function printSummary(rows: ModelResult[]): void {
  // Console-friendly two-column dump per row (TSV is the machine-readable form).
  console.log("\n=== Reranker Benchmark Results ===");
  for (const r of rows) {
    console.log(`\n[${r.model}]`);
    console.log(`  cold_start_ms       : ${r.cold_start_ms}`);
    console.log(`  latency_p50_ms      : ${r.latency_p50_ms}`);
    console.log(`  latency_p95_ms      : ${r.latency_p95_ms}`);
    console.log(`  batch_top20_p50_ms  : ${r.batch_top20_p50_ms}`);
    console.log(`  memory_rss_delta_mb : ${r.memory_rss_delta_mb}`);
    console.log(`  top3_agreement_avg  : ${r.top3_agreement_avg}`);
    console.log(`  notes               : ${r.notes}`);
  }
  console.log("");
}

function isoDate(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

export async function main(): Promise<void> {
  const dbPath = process.env.RALPH_KNOWLEDGE_DB ?? DEFAULT_DB_PATH;
  console.log(`reranker-bench: opening DB at ${dbPath}`);
  const db = new KnowledgeDB(dbPath);
  const fts = new FtsSearch(db);
  const vec = new VectorSearch(db);
  const hybrid = new HybridSearch(db, fts, vec, embed);

  // Pre-compute the RRF candidate set per query (top-20). Doing this once,
  // before loading any reranker, ensures all rerankers benchmark against the
  // identical candidate sets. Empty candidate sets are kept in the array so
  // the per-query iteration matches between runs.
  console.log(
    `reranker-bench: pre-computing RRF candidates for ${SAMPLE_QUERIES.length} queries...`,
  );
  const perQueryCandidates: Array<{ query: string; candidates: SearchResult[] }> =
    [];
  let nonEmpty = 0;
  for (const q of SAMPLE_QUERIES) {
    let candidates: SearchResult[] = [];
    try {
      candidates = await hybrid.search(q, { limit: TOP_K_CANDIDATES });
    } catch (e) {
      console.warn(`  query failed: "${q}" — ${(e as Error).message}`);
    }
    perQueryCandidates.push({ query: q, candidates });
    if (candidates.length > 0) nonEmpty++;
  }
  console.log(
    `  ${nonEmpty}/${SAMPLE_QUERIES.length} queries returned candidates`,
  );

  if (nonEmpty === 0) {
    console.error(
      "reranker-bench: no queries returned RRF candidates — is the DB indexed?",
    );
    process.exit(1);
  }

  // Run each model serially. Loading two ONNX models in parallel would
  // confound the cold-start and RSS-delta measurements.
  const results: ModelResult[] = [];
  for (const spec of MODELS) {
    console.log(`\nreranker-bench: loading ${spec.label} (${spec.modelId})...`);
    const r = await benchmarkModel(spec, perQueryCandidates);
    results.push(r);
    if (r.notes.startsWith("model load failed")) {
      console.warn(`  ${spec.label}: ${r.notes}`);
    } else {
      console.log(
        `  ${spec.label}: cold_start=${r.cold_start_ms}ms, p50=${r.latency_p50_ms}ms/pair, agreement=${r.top3_agreement_avg}`,
      );
    }
  }

  // Write TSV next to this script.
  const here = dirname(fileURLToPath(import.meta.url));
  const outPath = join(here, `results-${isoDate()}.tsv`);
  writeFileSync(outPath, formatTsv(results), "utf8");
  console.log(`\nreranker-bench: wrote ${outPath}`);

  printSummary(results);

  // Exit non-zero only if ALL models failed to load.
  const anySucceeded = results.some(
    (r) => !r.notes.startsWith("model load failed"),
  );
  if (!anySucceeded) {
    console.error("reranker-bench: every model failed to load — exiting 1");
    process.exit(1);
  }
}

// Top-level runner — only executes when this file is invoked directly,
// not when imported by another script (e.g., a future suite that compares
// runs across hardware revisions).
const invokedDirectly =
  import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (invokedDirectly) {
  main().catch((e) => {
    console.error("reranker-bench: fatal error", e);
    process.exit(1);
  });
}
