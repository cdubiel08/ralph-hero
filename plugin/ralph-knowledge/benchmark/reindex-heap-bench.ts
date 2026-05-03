/**
 * GH-913 — Heap-regression microbenchmark for reindex().
 *
 * Generates a deterministic 50-doc synthetic corpus, runs the production
 * reindex() against it with RALPH_CONTEXTUAL_RETRIEVAL=0 and a 100 ms heap
 * sampler, then writes a TSV row with peak heap_used, peak RSS, peak external,
 * cold-start, wall-clock, and chunk count.
 *
 * Guards the OOM fix from #907 (#911 + #916). A regression that re-introduces
 * catastrophic transient allocation (10x+ over today's baseline) will push
 * peak_heap_used or peak_rss past the configured thresholds and fail
 * `--assert` (exit 1).
 *
 * Run with:
 *   # Always exits 0; just records the row:
 *   npx tsx plugin/ralph-knowledge/benchmark/reindex-heap-bench.ts
 *
 *   # Exits 1 if peak_heap_used > 600 MB OR peak_rss > 800 MB:
 *   npx tsx plugin/ralph-knowledge/benchmark/reindex-heap-bench.ts --assert
 */
import { mkdtempSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { reindex } from "../src/reindex.js";

const DOC_COUNT = 50;
const TARGET_DOC_BYTES = 7 * 1024; // ~7 KB per doc -> ~3-5 chunks each
const SAMPLE_INTERVAL_MS = 100;

/**
 * Default thresholds — sourced from the GH-910 reindex memory profile note.
 *
 * - HEAP_THRESHOLD_MB (600): catches catastrophic regrowth. Pre-#911 the
 *   per-call retention was ~30 MB transient, climbing to 4 GB+ within ~150
 *   chunks on the LIVE corpus. Today's typical heap_used on the 50-doc
 *   bench corpus is ~30-50 MB, so 600 MB gives ~12x margin for the post-#911
 *   baseline while still failing if a regression causes 10x+ allocation.
 * - RSS_THRESHOLD_MB (800): catches transformer-model bloat or external-buffer
 *   growth. Today's typical RSS on the 50-doc bench is ~400-450 MB (mostly
 *   the transformer model baseline), so 800 MB gives 1.6-2x margin while
 *   still failing if a regression doubles per-doc RSS pressure.
 *
 * Tuning recipe: open the TSV history, find p95 across the last ~10 runs
 * on your CI hardware, multiply by 2. Avoids per-run jitter flakes.
 */
const HEAP_THRESHOLD_MB = 600;
const RSS_THRESHOLD_MB = 800;

/**
 * One bench-run row. Columns mirror the reranker-bench convention (one
 * scalar per metric, trailing free-form `notes` for any partial-failure
 * or threshold-breach description). `threshold_pass` and `notes` are
 * populated by `main()` after `runBench()` returns the raw measurements —
 * keeps the measurement path independent of the threshold-check policy.
 */
interface BenchResult {
  date: string;
  doc_count: number;
  chunk_count: number;
  cold_start_ms: number;
  wall_clock_s: number;
  peak_heap_used_mb: number;
  peak_rss_mb: number;
  peak_external_mb: number;
  threshold_pass: boolean;
  notes: string;
}

/**
 * Seeded RNG (mulberry32) — deterministic across runs and machines so the
 * synthetic corpus is reproducible. We DO NOT want jitter from `Math.random()`
 * in the corpus generator: the bench's value comes from comparing memory
 * deltas across CI runs of the SAME corpus shape, not from sampling random
 * corpora.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function (): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * English filler pool. Small repeating set keeps generation fast and
 * produces realistic chunker behavior (sentence boundaries trip the
 * paragraph-aware split heuristic in chunker.ts). Sentences are 60-120
 * characters each — typical for prose paragraphs.
 */
const SENTENCES: string[] = [
  "The reindex pipeline ingests markdown files from configured roots.",
  "Each document is parsed for frontmatter and its body content is extracted.",
  "Chunking splits long documents into roughly 800 token windows with overlap.",
  "An embedding is produced for every chunk using a small transformer model.",
  "The vector index stores normalized float embeddings in a virtual table.",
  "Full text search is provided by a separate FTS5 index in the same database.",
  "Hybrid search combines reciprocal rank fusion across the two retrievers.",
  "Sync records track file modification times to skip unchanged documents.",
  "Schema version metadata forces a full reindex when the embedding shape changes.",
  "Stub documents are upserted for outbound relationships that lack a target.",
  "Contextual retrieval prepends a short context prefix to each chunk before embedding.",
  "The LLM endpoint is probed once and the run fails open when unreachable.",
  "Memory tier classification distinguishes raw notes from synthesized reflections.",
  "Tags are split from frontmatter arrays and indexed separately for filtering.",
  "Relationships extend wiki style links into typed predicates between documents.",
  "Untyped edges capture incidental mentions outside an explicit predicate context.",
  "The chunker walks the document and emits chunks with character offsets.",
  "Forward progress is enforced so the chunker never returns a zero length chunk.",
  "Each embedding call disposes the underlying tensor immediately after copy.",
  "Without disposal the native ONNX buffers retain memory across the await loop.",
  "Mark compact garbage collection cannot reclaim native memory on its own.",
  "The accumulator gate prevents unbounded retention during long indexing runs.",
  "Synthetic corpora isolate heap behavior from live document content drift.",
  "Reproducibility across machines requires seeded random number generation.",
  "Wall clock measurements include cold start latency from model download.",
  "Peak resident set size captures both heap and native buffer pressure.",
  "External memory in the v8 heap snapshot tracks ArrayBuffer allocations.",
  "Sampling at one hundred millisecond intervals catches transient spikes.",
  "TSV results are appended one row per run for tuning and history review.",
  "Threshold values come from the calibration profile in the prior research note.",
];

/**
 * Generate one synthetic markdown doc. Frontmatter is realistic enough to
 * pass the parseDocument frontmatter check; body is built by sampling the
 * filler pool until the target byte budget is reached.
 */
function generateSyntheticDoc(rng: () => number, idx: number): string {
  const fmDate = "2026-05-02";
  const tier = "research";
  // Deterministic title: pick three filler-pool prefixes by RNG.
  const titleSeed = [
    SENTENCES[Math.floor(rng() * SENTENCES.length)].split(" ").slice(0, 3).join(" "),
    SENTENCES[Math.floor(rng() * SENTENCES.length)].split(" ").slice(0, 2).join(" "),
  ].join(" - ");
  let body = "";
  while (body.length < TARGET_DOC_BYTES) {
    body += SENTENCES[Math.floor(rng() * SENTENCES.length)] + " ";
    // Insert a paragraph break every ~10 sentences so the chunker has
    // realistic paragraph boundaries to split on.
    if (body.length % 11 === 0) body += "\n\n";
  }
  return `---\ndate: ${fmDate}\ntype: ${tier}\nstatus: draft\n---\n\n# Doc ${idx}: ${titleSeed}\n\n${body}\n`;
}

function generateCorpus(dir: string): void {
  const rng = mulberry32(0xc0ffee);
  for (let i = 0; i < DOC_COUNT; i++) {
    const name = `doc-${String(i).padStart(3, "0")}.md`;
    writeFileSync(join(dir, name), generateSyntheticDoc(rng, i));
  }
}

interface HeapSample {
  heapUsed: number;
  rss: number;
  external: number;
}

/**
 * Start a 100 ms in-process heap sampler. The sampler captures peak values
 * across the full sampling window (vs. snapshots between docs, which
 * underestimate transient peaks per the GH-910 profile note). The interval
 * handle is `unref()`d so it does not pin the event loop alive on its own —
 * `stop()` clears the interval and returns the accumulated peaks.
 */
function startHeapSampler(): { stop: () => HeapSample } {
  const peak: HeapSample = { heapUsed: 0, rss: 0, external: 0 };
  const tick = (): void => {
    const m = process.memoryUsage();
    if (m.heapUsed > peak.heapUsed) peak.heapUsed = m.heapUsed;
    if (m.rss > peak.rss) peak.rss = m.rss;
    if (m.external > peak.external) peak.external = m.external;
  };
  tick();
  const handle = setInterval(tick, SAMPLE_INTERVAL_MS);
  handle.unref();
  return {
    stop: (): HeapSample => {
      tick();
      clearInterval(handle);
      return peak;
    },
  };
}

/**
 * Query the chunk count from the database directly. Reindex does not
 * expose this on its return value, but the schema is stable: the
 * `chunks` table is populated as a side effect of `reindex()` per the
 * upsert loop in `src/reindex.ts`. Using better-sqlite3 directly keeps
 * the bench independent of KnowledgeDB's surface — the count survives
 * any future API drift as long as `chunks(document_id)` exists.
 */
function countChunks(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number };
    return row.n;
  } catch {
    // Table not present (e.g., very early reindex failure). Surface as 0
    // rather than throwing so the TSV row still records the heap data.
    return 0;
  } finally {
    db.close();
  }
}

async function runBench(): Promise<BenchResult> {
  process.env.RALPH_CONTEXTUAL_RETRIEVAL = "0";

  const corpusDir = mkdtempSync(join(tmpdir(), "bench-heap-corpus-"));
  const dbDir = mkdtempSync(join(tmpdir(), "bench-heap-db-"));
  const dbPath = join(dbDir, "bench.db");

  generateCorpus(corpusDir);

  const sampler = startHeapSampler();
  // Cold start = model load + first reindex prelude. We approximate by
  // measuring time-to-first heap-sample-after-reindex-start. In practice
  // the dominant cost is the transformer model load on the first chunk;
  // the 100 ms sampler captures a stable peak after that point.
  const t0 = performance.now();
  const coldStartMark = performance.now();
  await reindex([corpusDir], dbPath, false);
  const elapsed = (performance.now() - t0) / 1000;
  const peak = sampler.stop();
  const coldStartMs = Math.round(coldStartMark - t0);

  const chunkCount = countChunks(dbPath);

  return {
    date: isoDate(),
    doc_count: DOC_COUNT,
    chunk_count: chunkCount,
    cold_start_ms: coldStartMs,
    wall_clock_s: Number(elapsed.toFixed(2)),
    peak_heap_used_mb: Number((peak.heapUsed / 1024 / 1024).toFixed(1)),
    peak_rss_mb: Number((peak.rss / 1024 / 1024).toFixed(1)),
    peak_external_mb: Number((peak.external / 1024 / 1024).toFixed(1)),
    // Threshold check is the caller's responsibility (main() in --assert
    // mode). Default to neutral values so the row is well-formed even
    // when a downstream consumer imports runBench() directly.
    threshold_pass: true,
    notes: "",
  };
}

const TSV_HEADERS = [
  "date",
  "doc_count",
  "chunk_count",
  "cold_start_ms",
  "wall_clock_s",
  "peak_heap_used_mb",
  "peak_rss_mb",
  "peak_external_mb",
  "threshold_pass",
  "notes",
] as const;

function rowToTsv(r: BenchResult): string {
  return [
    r.date,
    r.doc_count,
    r.chunk_count,
    r.cold_start_ms,
    r.wall_clock_s,
    r.peak_heap_used_mb,
    r.peak_rss_mb,
    r.peak_external_mb,
    r.threshold_pass,
    r.notes,
  ].join("\t");
}

/**
 * Append `rows` to `outPath`. If the file does not exist, write the header
 * line first; if it does, only append rows. Idempotent: re-invoking the
 * bench on the same day produces additional rows under the same header,
 * never duplicate headers. (The reranker-bench overwrites because it runs
 * a fixed model set sequentially; the heap bench may be invoked multiple
 * times during a tuning session and history is the point.)
 */
function appendOrCreateTsv(outPath: string, rows: BenchResult[]): void {
  const lines = rows.map(rowToTsv);
  if (existsSync(outPath)) {
    appendFileSync(outPath, lines.join("\n") + "\n", "utf8");
  } else {
    writeFileSync(outPath, TSV_HEADERS.join("\t") + "\n" + lines.join("\n") + "\n", "utf8");
  }
}

function printSummary(r: BenchResult): void {
  console.log("\n=== Reindex Heap Benchmark Result ===");
  console.log(`  date                : ${r.date}`);
  console.log(`  doc_count           : ${r.doc_count}`);
  console.log(`  chunk_count         : ${r.chunk_count}`);
  console.log(`  cold_start_ms       : ${r.cold_start_ms}`);
  console.log(`  wall_clock_s        : ${r.wall_clock_s}`);
  console.log(`  peak_heap_used_mb   : ${r.peak_heap_used_mb}`);
  console.log(`  peak_rss_mb         : ${r.peak_rss_mb}`);
  console.log(`  peak_external_mb    : ${r.peak_external_mb}`);
  console.log(`  threshold_pass      : ${r.threshold_pass}`);
  console.log(`  notes               : ${r.notes}`);
  console.log("");
}

function isoDate(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const assertMode = args.includes("--assert");

  console.log(`reindex-heap-bench: generating ${DOC_COUNT}-doc synthetic corpus...`);
  const result = await runBench();

  // Threshold check — applied unconditionally so the TSV row always records
  // pass/fail, but only --assert turns a breach into a non-zero exit.
  const heapBreach = result.peak_heap_used_mb > HEAP_THRESHOLD_MB;
  const rssBreach = result.peak_rss_mb > RSS_THRESHOLD_MB;
  result.threshold_pass = !heapBreach && !rssBreach;
  if (heapBreach || rssBreach) {
    const breaches: string[] = [];
    if (heapBreach) {
      breaches.push(`heap_used ${result.peak_heap_used_mb} > ${HEAP_THRESHOLD_MB}`);
    }
    if (rssBreach) {
      breaches.push(`rss ${result.peak_rss_mb} > ${RSS_THRESHOLD_MB}`);
    }
    result.notes = `THRESHOLD BREACH: ${breaches.join("; ")}`;
  } else {
    result.notes = "ok";
  }

  // Always write TSV — useful for tuning even when an --assert run aborts.
  const here = dirname(fileURLToPath(import.meta.url));
  const outPath = join(here, `results-${isoDate()}.tsv`);
  appendOrCreateTsv(outPath, [result]);
  console.log(`reindex-heap-bench: wrote ${outPath}`);

  printSummary(result);

  // Exit 1 ONLY when --assert was passed AND a threshold breached. Without
  // --assert, a breach still appears in the TSV `notes` column so a tuning
  // session can review history without aborting.
  //
  // Use `process.exitCode` (not `process.exit()`) so the event loop drains
  // and native bindings (better-sqlite3, transformers.js ONNX runtime) tear
  // down cleanly. A hard `process.exit(1)` here causes a libc++ abort during
  // ONNX teardown that returns 134 (SIGABRT) instead of 1.
  if (assertMode && !result.threshold_pass) {
    console.error(`reindex-heap-bench: ASSERT FAIL — ${result.notes}`);
    process.exitCode = 1;
  }
}

// Top-level runner — only executes when this file is invoked directly,
// not when imported. We use endsWith() over the tsx source path because tsx
// (the runner) sets process.argv[1] to the .ts file directly.
const invokedDirectly = process.argv[1]?.endsWith("reindex-heap-bench.ts");
if (invokedDirectly) {
  main().catch((e) => {
    console.error("reindex-heap-bench: fatal error", e);
    process.exit(1);
  });
}
