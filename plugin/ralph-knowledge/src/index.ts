#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { KnowledgeDB } from "./db.js";
import { FtsSearch } from "./search.js";
import { VectorSearch } from "./vector-search.js";
import { HybridSearch } from "./hybrid-search.js";
import { Traverser } from "./traverse.js";
import { embed } from "./embedder.js";

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
    },
    async (args) => {
      try {
        const results = await hybrid.search(args.query, {
          tags: args.tags,
          type: args.type,
          limit: args.limit ?? 10,
          includeSuperseded: args.includeSuperseded,
        });
        const enriched = results.map(r => ({ ...r, tags: db.getTags(r.id) }));
        return { content: [{ type: "text" as const, text: JSON.stringify(enriched, null, 2) }] };
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
    },
    async (args) => {
      try {
        const opts = { type: args.type, depth: args.depth ?? 3 };
        const results = args.direction === "incoming"
          ? traverser.traverseIncoming(args.from, opts)
          : traverser.traverse(args.from, opts);
        return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  return { server, db, fts, vec, hybrid, traverser };
}

const dbPath = process.env.RALPH_KNOWLEDGE_DB ?? "knowledge.db";
const { server } = createServer(dbPath);
const transport = new StdioServerTransport();
server.connect(transport).catch(console.error);
