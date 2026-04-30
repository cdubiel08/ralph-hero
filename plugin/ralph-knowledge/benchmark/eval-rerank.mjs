#!/usr/bin/env node
/**
 * GH-927 — Re-run the 8-query golden eval with `rerank: true` against the live
 * `~/.ralph-hero/knowledge.db`. Captures per-query rank-of-expected, cold/warm
 * latency, and rerank logits. Output is JSON on stdout for downstream
 * markdown formatting.
 *
 * Usage:
 *   node benchmark/eval-rerank.mjs > /tmp/eval-rerank-results.json
 *
 * The script imports the compiled `dist/` modules so it exercises the exact
 * code path `knowledge_search` runs in production.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { KnowledgeDB } from "../dist/db.js";
import { FtsSearch } from "../dist/search.js";
import { VectorSearch } from "../dist/vector-search.js";
import { HybridSearch } from "../dist/hybrid-search.js";
import { embed } from "../dist/embedder.js";
import { Reranker } from "../dist/reranker.js";

const DB_PATH = process.env.RALPH_KNOWLEDGE_DB
  ?? join(homedir(), ".ralph-hero", "knowledge.db");

/**
 * The 8 golden queries from the 2026-04-29 baseline eval. `expectedSubstrings`
 * lists path-segment substrings any of which counts as a hit (some queries
 * have multiple legitimate primary docs per the baseline).
 */
const QUERIES = [
  {
    n: 1,
    query: "what causes the reindex to OOM in ralph-knowledge",
    expectedSubstrings: ["2026-04-29-reindex-memory-profile"],
    type: "specific-keyword",
  },
  {
    n: 2,
    query: "release transformer tensors after embedding to free memory",
    expectedSubstrings: ["2026-04-29-GH-911-release-embedder-tensors"],
    type: "specific-keyword",
  },
  {
    n: 3,
    query: "chunker forward progress infinite loop fix",
    expectedSubstrings: ["2026-04-29-GH-916-chunker-no-progress-fix"],
    type: "specific-keyword",
  },
  {
    n: 4,
    query: "dream-loop memory consolidation pipeline architecture",
    expectedSubstrings: [
      "2026-04-26-dreaming-research-trail-and-self-containment",
      "2026-04-16-GH-0761",
    ],
    type: "mixed",
  },
  {
    n: 5,
    query: "cross-encoder reranker score calibration",
    expectedSubstrings: ["2026-04-26-softmax-and-rerank-calibration"],
    type: "mixed",
  },
  {
    n: 6,
    query: "wikilink extractor for markdown",
    expectedSubstrings: ["2026-04-26-ralph-knowledge-wikilink-extractor"],
    type: "specific-keyword",
  },
  {
    n: 7,
    query: "context handoff topology between agents",
    expectedSubstrings: ["2026-04-22-context-handoff-topology"],
    type: "mixed",
  },
  {
    n: 8,
    query: "landcrawler permit raw data migration hardening",
    expectedSubstrings: ["2026-04-24-landcrawler-backend-hardening-postmortem"],
    type: "specific-keyword",
  },
];

function findRank(results, expectedSubstrings) {
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const path = (r.path ?? "") + (r.id ?? "");
    for (const sub of expectedSubstrings) {
      if (path.includes(sub)) return i + 1;
    }
  }
  return null;
}

async function runOne(hybrid, q, withRerank) {
  const t0 = performance.now();
  const results = await hybrid.search(q.query, {
    limit: 10,
    diagnosticMode: true,
    rerank: withRerank,
  });
  const elapsed = performance.now() - t0;
  return { results, elapsedMs: elapsed };
}

async function main() {
  console.error(`[eval-rerank] DB: ${DB_PATH}`);
  const db = new KnowledgeDB(DB_PATH);
  const fts = new FtsSearch(db);
  const vec = new VectorSearch(db);
  const reranker = new Reranker();
  const hybrid = new HybridSearch(db, fts, vec, embed, reranker);

  // Warm up the embedder once (it's a separate model from the reranker; we
  // care about cold-start of the *reranker*, not the embedder, so isolate it).
  console.error(`[eval-rerank] warming embedder...`);
  await hybrid.search("warmup", { limit: 1 });

  const out = [];
  let firstRerankCall = true;

  for (const q of QUERIES) {
    console.error(`[eval-rerank] Q${q.n}: ${q.query}`);

    // First rerank invocation is the cold-start one (model load + first batch).
    // Subsequent invocations are warm.
    const cold = await runOne(hybrid, q, true);
    const wasFirstCall = firstRerankCall;
    firstRerankCall = false;

    // Warm runs: 3 repeats to compute median + p95.
    const warmRuns = [];
    for (let i = 0; i < 3; i++) {
      warmRuns.push(await runOne(hybrid, q, true));
    }

    // Also capture the no-rerank baseline order from the same DB so the eval
    // doc can verify the baseline column is reproducible (sanity check).
    const noRerank = await runOne(hybrid, q, false);

    const sortedWarm = warmRuns.map((r) => r.elapsedMs).sort((a, b) => a - b);
    const median = sortedWarm[Math.floor(sortedWarm.length / 2)];
    const p95Idx = Math.min(sortedWarm.length - 1, Math.floor(sortedWarm.length * 0.95));

    const top10 = cold.results.slice(0, 10).map((r) => ({
      id: r.id,
      path: r.path,
      title: r.title,
      score: r.score,
      rerankScore: r.rerankScore,
      ftsScore: r.ftsScore,
      vecDistance: r.vecDistance,
      hitSources: r.hitSources,
    }));
    const noRerankTop10 = noRerank.results.slice(0, 10).map((r) => ({
      id: r.id,
      path: r.path,
      title: r.title,
      score: r.score,
    }));

    const rank = findRank(cold.results, q.expectedSubstrings);
    const rankNoRerank = findRank(noRerank.results, q.expectedSubstrings);
    const expectedHit = rank !== null
      ? cold.results[rank - 1]
      : null;

    out.push({
      n: q.n,
      query: q.query,
      type: q.type,
      expectedSubstrings: q.expectedSubstrings,
      rank,
      rankNoRerank,
      expected: expectedHit
        ? {
          id: expectedHit.id,
          path: expectedHit.path,
          rerankScore: expectedHit.rerankScore,
          rrfScore: expectedHit.score,
        }
        : null,
      latency: {
        coldStartMs: wasFirstCall ? cold.elapsedMs : null,
        firstCallMs: cold.elapsedMs,
        warmMedianMs: median,
        warmP95Ms: sortedWarm[p95Idx],
        warmRunsMs: sortedWarm,
        noRerankMs: noRerank.elapsedMs,
      },
      top10,
      noRerankTop10,
    });
  }

  const ranksWithRerank = out.map((o) => o.rank);
  const ranksNoRerank = out.map((o) => o.rankNoRerank);
  const hitAt = (ranks, k) => ranks.filter((r) => r !== null && r <= k).length;
  const mrr = (ranks) =>
    ranks.reduce((a, r) => a + (r === null ? 0 : 1 / r), 0) / ranks.length;

  const aggregate = {
    rerank: {
      hitAt1: `${hitAt(ranksWithRerank, 1)}/${ranksWithRerank.length}`,
      hitAt5: `${hitAt(ranksWithRerank, 5)}/${ranksWithRerank.length}`,
      hitAt10: `${hitAt(ranksWithRerank, 10)}/${ranksWithRerank.length}`,
      mrr: mrr(ranksWithRerank),
    },
    noRerank: {
      hitAt1: `${hitAt(ranksNoRerank, 1)}/${ranksNoRerank.length}`,
      hitAt5: `${hitAt(ranksNoRerank, 5)}/${ranksNoRerank.length}`,
      hitAt10: `${hitAt(ranksNoRerank, 10)}/${ranksNoRerank.length}`,
      mrr: mrr(ranksNoRerank),
    },
  };

  // Latency aggregate
  const allCold = out.map((o) => o.latency.coldStartMs).filter((x) => x != null);
  const allWarmMedian = out.map((o) => o.latency.warmMedianMs);
  const allFirst = out.map((o) => o.latency.firstCallMs);
  aggregate.latency = {
    coldStartMs: allCold[0] ?? null,
    avgWarmMedianMs:
      allWarmMedian.reduce((a, x) => a + x, 0) / allWarmMedian.length,
    avgFirstCallMs:
      allFirst.reduce((a, x) => a + x, 0) / allFirst.length,
    avgNoRerankMs:
      out.reduce((a, o) => a + o.latency.noRerankMs, 0) / out.length,
  };

  console.log(JSON.stringify({ queries: out, aggregate, dbPath: DB_PATH }, null, 2));
  console.error(`[eval-rerank] done; aggregate:`, aggregate);
  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
