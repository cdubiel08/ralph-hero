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
import { formatSearchResults, formatTraverseResults } from "./format.js";

const DEFAULT_DB_PATH = join(homedir(), ".ralph-hero", "knowledge.db");

function resolveEnv(name: string): string | undefined {
  const val = process.env[name];
  // Claude Code passes unexpanded ${VAR} literals for unset env vars in .mcp.json
  if (!val || val.startsWith("${")) return undefined;
  return val;
}

export function createServer(dbPath: string) {
  const server = new McpServer({ name: "ralph-hero-knowledge", version: "0.1.0" });
  const db = new KnowledgeDB(dbPath);
  const fts = new FtsSearch(db);
  const vec = new VectorSearch(db);
  const hybrid = new HybridSearch(db, fts, vec, embed);
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
    },
    async (args) => {
      try {
        const results = await hybrid.search(args.query, {
          tags: args.tags,
          type: args.type,
          limit: args.limit ?? 10,
          includeSuperseded: args.includeSuperseded,
        });
        const enriched = results.map(r => {
          const base = { ...r, tags: db.getTags(r.id) };
          // SearchResult does not carry githubIssue — fetch from documents table
          const doc = db.getDocument(r.id);
          if (doc?.githubIssue) {
            const outcomes = db.getOutcomeSummary(doc.githubIssue);
            if (outcomes) return { ...base, outcomes_summary: outcomes };
          }
          return base;
        });
        const formatted = formatSearchResults(enriched, args.brief ?? false);
        return { content: [{ type: "text" as const, text: JSON.stringify(formatted, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    "knowledge_traverse",
    "Walk typed relationship edges (builds_on, tensions, superseded_by) from a document.",
    {
      from: z.string().describe("Document ID (filename without extension)"),
      type: z.enum(["builds_on", "tensions", "superseded_by"]).optional().describe("Filter by relationship type"),
      depth: z.number().optional().describe("Max traversal depth (default: 3)"),
      direction: z.enum(["outgoing", "incoming"]).optional().describe("Edge direction (default: outgoing)"),
      brief: z.boolean().optional().describe("Return minimal metadata only (default: false)"),
    },
    async (args) => {
      try {
        const opts = { type: args.type, depth: args.depth ?? 3 };
        const results = args.direction === "incoming"
          ? traverser.traverseIncoming(args.from, opts)
          : traverser.traverse(args.from, opts);
        const formatted = formatTraverseResults(results, (id) => db.getTags(id), args.brief ?? false);
        return { content: [{ type: "text" as const, text: JSON.stringify(formatted, null, 2) }] };
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

  return { server, db, fts, vec, hybrid, traverser };
}

const dbPath = resolveEnv("RALPH_KNOWLEDGE_DB") ?? DEFAULT_DB_PATH;
const { server } = createServer(dbPath);
const transport = new StdioServerTransport();
server.connect(transport).catch(console.error);
