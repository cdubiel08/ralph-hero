/**
 * GH-920 — knowledge_search retrieval-quality CI guard.
 *
 * Loads the 8 hand-curated golden queries from `evals/golden-queries.json`,
 * reindexes the pinned `__tests__/eval-corpus/` fixture into a tmp-dir SQLite
 * DB, runs each query through `HybridSearch.search()` with `rerank: false`
 * (the default RRF-only path), and computes Hit@1, Hit@5, MRR.
 *
 * Modeled after `benchmark/reindex-heap-bench.ts` (GH-913): same `--assert`
 * flag, same `process.exitCode = 1` (NOT `process.exit(1)`) discipline to
 * avoid the libc++ abort during native ONNX teardown that otherwise turns
 * a clean exit-1 into a SIGABRT exit-134.
 *
 * Run with:
 *   # Always exits 0; just prints the summary:
 *   npx tsx plugin/ralph-knowledge/scripts/eval-retrieval.ts
 *
 *   # Exits 1 if Hit@5 < 5/8 (62.5%):
 *   npx tsx plugin/ralph-knowledge/scripts/eval-retrieval.ts --assert
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { KnowledgeDB } from "../src/db.js";
import { FtsSearch, type SearchResult } from "../src/search.js";
import { VectorSearch } from "../src/vector-search.js";
import { HybridSearch } from "../src/hybrid-search.js";
import { embed } from "../src/embedder.js";
import { reindex } from "../src/reindex.js";

/**
 * Hit@5 floor — raise to 6/8 (75%) once stable.
 *
 * Set conservatively below the verified 87.5% (7/8) post-reranker baseline so
 * a slightly noisy CI run does not flake on the threshold even though the
 * default RRF-only path consistently exceeds it. The threshold is in
 * absolute query-count units (not a percentage) to match the `${n}/8`
 * formatting convention from `benchmark/eval-rerank.mjs`.
 */
const HIT5_THRESHOLD = 5; // 5/8 = 62.5% — raise to 6/8 (75%) once stable

interface GoldenQuery {
  n: number;
  query: string;
  expectedSubstrings: string[];
  type: string;
}

interface PerQueryResult {
  n: number;
  query: string;
  type: string;
  rank: number | null;
  topPath: string | null;
}

interface EvalSummary {
  perQuery: PerQueryResult[];
  hit1: string;
  hit5: string;
  mrr: number;
  hit1Count: number;
  hit5Count: number;
  total: number;
}

/**
 * Load and parse the shared `evals/golden-queries.json`. Path is resolved
 * relative to this script via `import.meta.url` so it works whether the
 * script is invoked from the repo root, from `plugin/ralph-knowledge/`,
 * or from any other cwd.
 */
function loadGoldenQueries(jsonPath: string): GoldenQuery[] {
  let raw: string;
  try {
    raw = readFileSync(jsonPath, "utf8");
  } catch (e) {
    throw new Error(
      `eval-retrieval: failed to read golden-queries.json at ${jsonPath}: ${(e as Error).message}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `eval-retrieval: failed to parse golden-queries.json at ${jsonPath}: ${(e as Error).message}`,
    );
  }
  const queries = (parsed as { queries?: unknown }).queries;
  if (!Array.isArray(queries)) {
    throw new Error(
      `eval-retrieval: golden-queries.json at ${jsonPath} missing top-level "queries" array`,
    );
  }
  return queries as GoldenQuery[];
}

/**
 * Substring-based rank lookup. Mirrors `findRank()` in
 * `benchmark/eval-rerank.mjs` lines 86-95. Returns the 1-indexed position of
 * the first result whose `path` or `id` contains ANY of the expected
 * substrings; `null` when no result matches.
 */
function findRank(
  results: SearchResult[],
  expectedSubstrings: string[],
): number | null {
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const haystack = (r.path ?? "") + (r.id ?? "");
    for (const sub of expectedSubstrings) {
      if (haystack.includes(sub)) return i + 1;
    }
  }
  return null;
}

async function runEval(): Promise<EvalSummary> {
  const here = dirname(fileURLToPath(import.meta.url));
  const queriesPath = join(here, "..", "evals", "golden-queries.json");
  const corpusDir = join(here, "..", "__tests__", "eval-corpus");

  const queries = loadGoldenQueries(queriesPath);

  // Mirror the heap-bench gate: disable contextual retrieval so the LLM probe
  // doesn't try to reach localhost:8000 (which is unreachable in CI). MUST be
  // set before `reindex()` reads the env var.
  process.env.RALPH_CONTEXTUAL_RETRIEVAL = "0";

  // Tmp-dir DB: `mkdtempSync(join(tmpdir(), "eval-retrieval-db-"))` creates a
  // unique dir each run so concurrent CI jobs don't collide. NEVER write to
  // the user's `~/.ralph-hero/knowledge.db` — the eval needs a clean,
  // deterministic corpus.
  const dbDir = mkdtempSync(join(tmpdir(), "eval-retrieval-db-"));
  const dbPath = join(dbDir, "bench.db");

  console.log(`eval-retrieval: corpus=${corpusDir}`);
  console.log(`eval-retrieval: db=${dbPath}`);
  console.log(`eval-retrieval: reindexing ${queries.length}-query corpus...`);

  await reindex([corpusDir], dbPath, false);

  const db = new KnowledgeDB(dbPath);
  const fts = new FtsSearch(db);
  const vec = new VectorSearch(db);
  // No reranker — the CI guard tests the default RRF-only path. The cross-
  // encoder reranker incurs a ~7s ONNX cold-start that would balloon CI time
  // for marginal threshold-floor benefit.
  const hybrid = new HybridSearch(db, fts, vec, embed, undefined);

  // Warm the embedder once so the first per-query measurement isn't dominated
  // by model load. Doesn't affect the rank metrics — just keeps the per-query
  // log lines representative of the warm path.
  await hybrid.search("warmup", { limit: 1, rerank: false });

  const perQuery: PerQueryResult[] = [];
  for (const q of queries) {
    const results = await hybrid.search(q.query, { limit: 10, rerank: false });
    const rank = findRank(results, q.expectedSubstrings);
    const topPath = results[0]?.path ?? results[0]?.id ?? null;
    perQuery.push({
      n: q.n,
      query: q.query,
      type: q.type,
      rank,
      topPath,
    });
  }

  db.close();

  const total = queries.length;
  const hit1Count = perQuery.filter((p) => p.rank !== null && p.rank === 1).length;
  const hit5Count = perQuery.filter((p) => p.rank !== null && p.rank <= 5).length;
  const mrr =
    perQuery.reduce((acc, p) => acc + (p.rank === null ? 0 : 1 / p.rank), 0) /
    total;

  return {
    perQuery,
    hit1: `${hit1Count}/${total}`,
    hit5: `${hit5Count}/${total}`,
    mrr,
    hit1Count,
    hit5Count,
    total,
  };
}

function printSummary(s: EvalSummary): void {
  console.log("\n=== Retrieval Eval Results ===");
  console.log("  N  rank  type             query");
  for (const p of s.perQuery) {
    const rankStr = p.rank === null ? "  -" : String(p.rank).padStart(3, " ");
    const typeStr = p.type.padEnd(16, " ");
    console.log(`  ${p.n}  ${rankStr}  ${typeStr} ${p.query}`);
  }
  console.log("");
  console.log(`  Hit@1 : ${s.hit1}`);
  console.log(`  Hit@5 : ${s.hit5}`);
  console.log(`  MRR   : ${s.mrr.toFixed(3)}`);
  console.log("");
}

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const assertMode = args.includes("--assert");

  const summary = await runEval();
  printSummary(summary);

  if (assertMode) {
    if (summary.hit5Count < HIT5_THRESHOLD) {
      console.error(
        `eval-retrieval: ASSERT FAIL — Hit@5 ${summary.hit5Count}/${summary.total} below threshold ${HIT5_THRESHOLD}/${summary.total}`,
      );
      // Use `process.exitCode` (NOT `process.exit()`) so the event loop drains
      // and native bindings (better-sqlite3, transformers.js ONNX runtime)
      // tear down cleanly. A hard `process.exit(1)` causes a libc++ abort
      // during ONNX teardown that returns 134 (SIGABRT) instead of 1.
      // (Same discipline as `benchmark/reindex-heap-bench.ts` per GH-913.)
      process.exitCode = 1;
    } else {
      console.log(
        `eval-retrieval: PASS — Hit@5 ${summary.hit5Count}/${summary.total} >= threshold ${HIT5_THRESHOLD}/${summary.total}`,
      );
    }
  }
}

// Top-level runner — only executes when this file is invoked directly,
// not when imported. We use endsWith() over the tsx source path because tsx
// (the runner) sets process.argv[1] to the .ts file directly.
const invokedDirectly = process.argv[1]?.endsWith("eval-retrieval.ts");
if (invokedDirectly) {
  main().catch((e) => {
    console.error("eval-retrieval: fatal error", e);
    // Acceptable here: the catch fires before any successful reindex/search,
    // so no native ONNX teardown is in flight to abort.
    process.exit(1);
  });
}
