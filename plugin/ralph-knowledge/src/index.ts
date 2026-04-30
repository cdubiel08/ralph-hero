#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { homedir } from "node:os";
import { join } from "node:path";
import { KnowledgeDB } from "./db.js";
import { FtsSearch } from "./search.js";
import { VectorSearch } from "./vector-search.js";
import { HybridSearch } from "./hybrid-search.js";
import { Traverser } from "./traverse.js";
import { embed } from "./embedder.js";
import { Reranker } from "./reranker.js";
import { formatSearchResults, formatTraverseResults } from "./format.js";
import { registerGraphTools } from "./graph-tools.js";

const DEFAULT_DB_PATH = join(homedir(), ".ralph-hero", "knowledge.db");

function resolveEnv(name: string): string | undefined {
  const val = process.env[name];
  // Claude Code passes unexpanded ${VAR} literals for unset env vars in .mcp.json
  if (!val || val.startsWith("${")) return undefined;
  return val;
}

/**
 * True when the `chunks` table exists in the schema (v3+). When absent,
 * `knowledge_memory_stats` reports 0 chunks-per-doc percentiles.
 */
function chunksTableExists(db: KnowledgeDB): boolean {
  const row = db.db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='chunks'",
    )
    .get();
  return row !== undefined;
}

/**
 * True when the `documents.memory_tier` column exists (v3+). Used to decide
 * whether tier-level stats can be produced from the schema at all.
 */
function memoryTierColumnExists(db: KnowledgeDB): boolean {
  const rows = db.db
    .prepare("PRAGMA table_info(documents)")
    .all() as Array<{ name: string }>;
  return rows.some((r) => r.name === "memory_tier");
}

/**
 * Percentile helper using nearest-rank. For n sorted values returns the value
 * at index `floor(n * p)` clamped to [0, n-1]. Returns 0 on empty input.
 * Matches the spec in Phase 8 Task 8.4: "pick index at floor(n*0.5)".
 */
function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  const idx = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.floor(sortedValues.length * p)),
  );
  return sortedValues[idx];
}

/**
 * Options for `createServer`. When `embedFn` is provided it replaces the
 * production `embed` import, allowing tests to bypass the HuggingFace model
 * download.
 *
 * `rerankerFactory` mirrors the `embedFn` injection pattern: when provided,
 * it produces the `Reranker` passed into `HybridSearch` so unit tests can
 * supply a deterministic stub reranker without paying the ~580 MB ONNX
 * model download. Production callers omit this field; the default `Reranker`
 * is lazy-loaded and pays no cold-start cost until `rerank: true` is set on
 * a `knowledge_search` call.
 */
export interface CreateServerOptions {
  embedFn?: (text: string) => Promise<Float32Array>;
  rerankerFactory?: () => Reranker;
}

export function createServer(dbPath: string, opts: CreateServerOptions = {}) {
  const server = new McpServer({ name: "ralph-hero-knowledge", version: "0.1.0" });
  const db = new KnowledgeDB(dbPath);
  const fts = new FtsSearch(db);
  const vec = new VectorSearch(db);
  const embedImpl = opts.embedFn ?? embed;
  // GH-926: production constructs a default `Reranker` (lazy — no model load
  // until first `rerank: true` call). Tests inject a stub via
  // `rerankerFactory` to bypass the ONNX model download. Mirrors the
  // `embedFn` injection above.
  const reranker = opts.rerankerFactory ? opts.rerankerFactory() : new Reranker();
  const hybrid = new HybridSearch(db, fts, vec, embedImpl, reranker);
  const traverser = new Traverser(db);

  server.tool(
    "knowledge_search",
    "Search the knowledge base by keyword, semantic similarity, and tags. Returns ranked documents.",
    {
      query: z.string().describe("Search query (keywords or natural language)"),
      tags: z.array(z.string()).optional().describe("Filter by tags"),
      type: z.string().optional().describe("Filter by document type (research, plan, review, idea, report)"),
      limit: z.number().optional().describe("Max results (default: 10)"),
      includeSuperseded: z.boolean().optional().describe("Include superseded documents (default: false)"),
      brief: z.boolean().optional().describe("Return minimal metadata only (default: false)"),
      memory_tier: z
        .enum(["doc", "raw", "reflection", "any"])
        .optional()
        .default("any")
        .describe("Filter by memory tier: 'doc' (curated), 'raw' (dream-loop ingest), 'reflection' (synthesized), 'any' (default)"),
      return_chunk_meta: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include chunk_index/char_start/char_end/context_prefix in each hit when chunk data is available"),
      lambda: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("MMR diversity trade-off: 1.0 = pure relevance (default), 0.7 = balanced, 0.0 = max diversity. When omitted, results are byte-identical to today's pure-RRF behavior."),
      return_diagnostics: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include per-retriever diagnostic fields (fts_score, vec_distance, hit_sources) on each result. Default off — keeps payload byte-identical to today's response shape (Phase 2, GH-899 Track-B observability hook)."),
      rerank: z
        .boolean()
        .optional()
        .default(false)
        .describe("Apply cross-encoder reranking to the post-RRF top-N candidates (BGE-Reranker-v2-m3-int8). Adds ~0.5-1s of latency on first call (cold-start model load) and ~25-45ms per pair on warm calls. Improves Hit@1 on specific-keyword queries; default off until the eval re-run confirms no regression on paraphrase queries."),
    },
    async (args) => {
      try {
        const results = await hybrid.search(args.query, {
          tags: args.tags,
          type: args.type,
          limit: args.limit ?? 10,
          includeSuperseded: args.includeSuperseded,
          memoryTier: args.memory_tier,
          lambda: args.lambda,
          diagnosticMode: args.return_diagnostics,
          rerank: args.rerank,
        });
        const enriched = results.map((r) => {
          // Start with the camelCase SearchResult shape so existing callers
          // keep working, then optionally add snake_case aliases for new
          // chunk + diagnostic fields and strip them when callers didn't opt in.
          const {
            chunkIndex,
            charStart,
            charEnd,
            contextPrefix,
            bestChunkId,
            ftsScore,
            vecDistance,
            hitSources,
            rerankScore,
            ...rest
          } = r;
          const base: Record<string, unknown> = { ...rest, tags: db.getTags(r.id) };
          if (args.return_chunk_meta) {
            if (chunkIndex !== undefined) base.chunk_index = chunkIndex;
            if (charStart !== undefined) base.char_start = charStart;
            if (charEnd !== undefined) base.char_end = charEnd;
            if (contextPrefix !== undefined) base.context_prefix = contextPrefix;
            if (bestChunkId !== undefined) base.best_chunk_id = bestChunkId;
          }
          if (args.return_diagnostics) {
            if (ftsScore !== undefined) base.fts_score = ftsScore;
            if (vecDistance !== undefined) base.vec_distance = vecDistance;
            if (hitSources !== undefined) base.hit_sources = hitSources;
          }
          // GH-926: rerank_score is a diagnostic field — surface it only when
          // BOTH `rerank` and `return_diagnostics` are true. This matches the
          // diagnostic-field discipline that hides fts_score/vec_distance
          // unless diagnostics are explicitly requested.
          if (args.rerank && args.return_diagnostics) {
            if (rerankScore !== undefined) base.rerank_score = rerankScore;
          }
          // SearchResult does not carry githubIssue — fetch from documents table
          const doc = db.getDocument(r.id);
          if (doc?.githubIssue) {
            const outcomes = db.getOutcomeSummary(doc.githubIssue);
            if (outcomes) base.outcomes_summary = outcomes;
          }
          return base;
        });
        const formatted = formatSearchResults(
          enriched as unknown as Parameters<typeof formatSearchResults>[0],
          args.brief ?? false,
        );
        return { content: [{ type: "text" as const, text: JSON.stringify(formatted, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    "knowledge_traverse",
    "Walk typed and untyped relationship edges from a document.",
    {
      from: z.string().describe("Document ID (filename without extension)"),
      type: z.enum(["builds_on", "tensions", "superseded_by", "post_mortem", "untyped"]).optional().describe("Filter by relationship type"),
      depth: z.number().optional().describe("Max traversal depth (default: 3)"),
      direction: z.enum(["outgoing", "incoming"]).optional().describe("Edge direction (default: outgoing)"),
      brief: z.boolean().optional().describe("Return minimal metadata only (default: false)"),
      memory_tier: z
        .enum(["doc", "raw", "reflection", "any"])
        .optional()
        .default("any")
        .describe("Filter traversed nodes by memory tier (default: 'any')"),
    },
    async (args) => {
      try {
        const opts = { type: args.type, depth: args.depth ?? 3 };
        let results = args.direction === "incoming"
          ? traverser.traverseIncoming(args.from, opts)
          : traverser.traverse(args.from, opts);
        if (args.memory_tier && args.memory_tier !== "any") {
          const wantedTier = args.memory_tier;
          results = results.filter((r) => {
            const tier = db.getMemoryTier(r.targetId);
            // When memory_tier column is absent (pre-v3 DB) treat as "doc"
            return (tier ?? "doc") === wantedTier;
          });
        }
        const formatted = formatTraverseResults(results, (id) => db.getTags(id), args.brief ?? false);
        return { content: [{ type: "text" as const, text: JSON.stringify(formatted, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    "knowledge_memory_stats",
    "Return counts of documents by memory_tier plus chunk percentiles and last-reflection timestamp. Used by the dream-loop to confirm ingest/reflection completion.",
    {
      since: z
        .string()
        .optional()
        .describe("ISO timestamp — counts for 'new_since' are computed against this. Defaults to 24 hours ago."),
    },
    async (args) => {
      try {
        const since = args.since ?? new Date(Date.now() - 24 * 3600 * 1000).toISOString();
        const hasTier = memoryTierColumnExists(db);
        const hasChunks = chunksTableExists(db);

        const totalRow = db.db
          .prepare("SELECT COUNT(*) AS c FROM documents WHERE is_stub = 0 OR is_stub IS NULL")
          .get() as { c: number };
        const totalDocuments = totalRow.c;

        const byTier: Record<"doc" | "raw" | "reflection", number> = {
          doc: 0,
          raw: 0,
          reflection: 0,
        };
        const newSince: Record<"doc" | "raw" | "reflection", number> = {
          doc: 0,
          raw: 0,
          reflection: 0,
        };

        if (hasTier) {
          const rows = db.db
            .prepare(
              `SELECT memory_tier AS tier, COUNT(*) AS c
               FROM documents
               WHERE (is_stub = 0 OR is_stub IS NULL)
               GROUP BY memory_tier`,
            )
            .all() as Array<{ tier: string; c: number }>;
          for (const r of rows) {
            if (r.tier === "doc" || r.tier === "raw" || r.tier === "reflection") {
              byTier[r.tier] = r.c;
            }
          }
          const newRows = db.db
            .prepare(
              `SELECT memory_tier AS tier, COUNT(*) AS c
               FROM documents
               WHERE date IS NOT NULL AND date >= @since AND (is_stub = 0 OR is_stub IS NULL)
               GROUP BY memory_tier`,
            )
            .all({ since }) as Array<{ tier: string; c: number }>;
          for (const r of newRows) {
            if (r.tier === "doc" || r.tier === "raw" || r.tier === "reflection") {
              newSince[r.tier] = r.c;
            }
          }
        } else {
          // v2 schema — everything treated as "doc"
          byTier.doc = totalDocuments;
          const newDocRow = db.db
            .prepare(
              "SELECT COUNT(*) AS c FROM documents WHERE date IS NOT NULL AND date >= ? AND (is_stub = 0 OR is_stub IS NULL)",
            )
            .get(since) as { c: number };
          newSince.doc = newDocRow.c;
        }

        let chunksPerDocP50 = 0;
        let chunksPerDocP90 = 0;
        if (hasChunks) {
          const perDoc = db.db
            .prepare(
              `SELECT COUNT(*) AS c FROM chunks GROUP BY document_id`,
            )
            .all() as Array<{ c: number }>;
          const counts = perDoc.map((r) => r.c).sort((a, b) => a - b);
          chunksPerDocP50 = percentile(counts, 0.5);
          chunksPerDocP90 = percentile(counts, 0.9);
        }

        let lastReflectionAt: string | null = null;
        if (hasTier) {
          const row = db.db
            .prepare(
              `SELECT date FROM documents
               WHERE memory_tier = 'reflection' AND date IS NOT NULL AND (is_stub = 0 OR is_stub IS NULL)
               ORDER BY date DESC LIMIT 1`,
            )
            .get() as { date: string } | undefined;
          lastReflectionAt = row?.date ?? null;
        }

        const payload = {
          total_documents: totalDocuments,
          by_tier: byTier,
          new_since: newSince,
          chunks_per_doc_p50: chunksPerDocP50,
          chunks_per_doc_p90: chunksPerDocP90,
          last_reflection_at: lastReflectionAt,
          since,
        };

        return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    "knowledge_record_outcome",
    "Record a pipeline outcome event (research, plan, phase, validation, etc.)",
    {
      event_type: z.string().describe("Event type (e.g., 'phase_completed', 'research_started')"),
      issue_number: z.number().describe("GitHub issue number"),
      session_id: z.string().optional().describe("Team/hero session identifier"),
      duration_ms: z.number().optional().describe("Duration in milliseconds"),
      verdict: z.string().optional().describe("Outcome verdict (pass, fail, approved, needs_iteration)"),
      component_area: z.string().optional().describe("Component path prefix (e.g., 'src/tools/')"),
      estimate: z.string().optional().describe("Issue estimate (XS, S, M, L, XL)"),
      drift_count: z.number().optional().describe("Files modified outside plan scope"),
      model: z.string().optional().describe("LLM model used (opus, sonnet, haiku)"),
      agent_type: z.string().optional().describe("Agent type (analyst, builder, integrator)"),
      iteration_count: z.number().optional().describe("Number of retry/review cycles"),
      payload: z.record(z.unknown()).optional().describe("Arbitrary JSON payload"),
    },
    async (args) => {
      try {
        const result = db.insertOutcomeEvent({
          eventType: args.event_type,
          issueNumber: args.issue_number,
          sessionId: args.session_id,
          durationMs: args.duration_ms,
          verdict: args.verdict,
          componentArea: args.component_area,
          estimate: args.estimate,
          driftCount: args.drift_count,
          model: args.model,
          agentType: args.agent_type,
          iterationCount: args.iteration_count,
          payload: args.payload as Record<string, unknown>,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    "knowledge_query_outcomes",
    "Query outcome events with optional aggregation. Use to find patterns in pipeline history.",
    {
      issue_number: z.number().optional().describe("Filter to specific issue"),
      event_type: z.string().optional().describe("Filter by event type"),
      component_area: z.string().optional().describe("Filter by component (prefix match)"),
      estimate: z.string().optional().describe("Filter by estimate size"),
      verdict: z.string().optional().describe("Filter by verdict"),
      session_id: z.string().optional().describe("Filter by session"),
      since: z.string().optional().describe("ISO date — only events after this"),
      limit: z.number().optional().describe("Max results (default: 50)"),
      aggregate: z.boolean().optional().describe("Return computed stats instead of raw rows"),
    },
    async (args) => {
      try {
        const params = {
          issueNumber: args.issue_number,
          eventType: args.event_type,
          componentArea: args.component_area,
          estimate: args.estimate,
          verdict: args.verdict,
          sessionId: args.session_id,
          since: args.since,
          limit: args.limit,
        };
        if (args.aggregate) {
          const agg = db.aggregateOutcomeEvents(params);
          return { content: [{ type: "text" as const, text: JSON.stringify(agg, null, 2) }] };
        }
        const rows = db.queryOutcomeEvents(params);
        return { content: [{ type: "text" as const, text: JSON.stringify(rows, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  registerGraphTools(server, db);

  return { server, db, fts, vec, hybrid, traverser };
}

const dbPath = resolveEnv("RALPH_KNOWLEDGE_DB") ?? DEFAULT_DB_PATH;
const { server } = createServer(dbPath);
const transport = new StdioServerTransport();
server.connect(transport).catch(console.error);
