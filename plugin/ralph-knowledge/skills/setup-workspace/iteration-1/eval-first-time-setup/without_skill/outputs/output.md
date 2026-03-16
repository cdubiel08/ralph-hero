# Baseline Eval: Set Up ralph-knowledge (Without Skill Guidance)

## Task

"Set up ralph-knowledge" — first-time setup of the knowledge index for the `thoughts/` directory (454 markdown files).

## What I Found

### Current State

The `ralph-knowledge` plugin does **not exist yet** as implemented code. Here is what exists:

1. **Design doc**: `docs/plans/2026-03-08-knowledge-graph-design.md` — describes the full architecture (SQLite + FTS5 + sqlite-vec + embeddings), document format (wikilinks, Prior Work sections), MCP tools (`knowledge_search`, `knowledge_traverse`), and the indexer.

2. **Implementation plan**: `docs/plans/2026-03-08-knowledge-graph-impl.md` — a 10-task plan (Part A: 3 tasks for innate document protocol, Part B: 7 tasks for the optional knowledge-index plugin). Contains complete source code for every file.

3. **Empty plugin directory**: `plugin/ralph-knowledge/skills/setup-workspace/iteration-1/` exists with empty `outputs/` directories for evaluation scaffolding, but no actual plugin code (no `package.json`, no `src/`, no `.mcp.json`, no MCP server).

4. **No `knowledge-index` directory**: `plugin/ralph-hero/knowledge-index/` does not exist. The impl plan specifies this as the location for the MCP server.

5. **Existing `.mcp.json`**: `plugin/ralph-hero/.mcp.json` only registers `ralph-github` (the main MCP server via `npx ralph-hero-mcp-server@2.5.4`). There is no `ralph-knowledge` entry.

6. **454 markdown files** exist in `thoughts/` across subdirectories: `ideas/`, `shared/ideas/`, `shared/plans/`, `shared/reports/`, `shared/research/`, `shared/reviews/`.

### What "Set Up ralph-knowledge" Requires

Based on the design and implementation plan, setting up ralph-knowledge requires building the entire knowledge-index MCP server from scratch:

#### Part B of the Implementation Plan (7 tasks):

| Task | Description | Status |
|------|-------------|--------|
| B1 | Project scaffold (package.json, tsconfig.json, npm install) | Not started |
| B2 | Markdown parser (frontmatter, wikilinks, relationships) | Not started |
| B3 | SQLite schema and document storage (KnowledgeDB class) | Not started |
| B4 | FTS5 full-text search (FtsSearch class) | Not started |
| B5 | Relationship traversal (Traverser class with recursive CTEs) | Not started |
| B6 | Embedding generation and vector search (sqlite-vec + HuggingFace) | Not started |
| B7 | Hybrid search (RRF over FTS5 + vectors) | Not started |
| B8 | MCP server with both tools (knowledge_search, knowledge_traverse) | Not started |
| B9 | Reindex script (scan thoughts/, parse, embed, build index) | Not started |
| B10 | Wire into .mcp.json | Not started |

#### Dependencies Required:
- `better-sqlite3` ^12.6.0 (SQLite driver)
- `sqlite-vec` ^0.1.7-alpha.10 (vector similarity)
- `@huggingface/transformers` ^3.0.0 (~80MB model download on first run)
- `@modelcontextprotocol/sdk` ^1.26.0
- `yaml` ^2.7.0
- `zod` ^3.25.0
- `vitest` ^4.0.0 (dev)
- `typescript` ^5.7.0 (dev)

#### After Building, the Setup Steps Would Be:

1. `cd plugin/ralph-hero/knowledge-index && npm install` — install dependencies
2. `npm run build` — compile TypeScript
3. `node dist/reindex.js ../../thoughts knowledge.db` — index all 454 markdown files (first run downloads ~80MB embedding model to `~/.cache/huggingface/hub/`)
4. Add `ralph-knowledge` entry to `plugin/ralph-hero/.mcp.json`
5. Restart Claude Code to pick up the new MCP server

## What I Did

1. **Explored** the `plugin/ralph-knowledge/` directory — found only empty eval scaffolding.
2. **Read** both design and implementation plan documents in full.
3. **Checked** `plugin/ralph-hero/knowledge-index/` — does not exist.
4. **Checked** `.mcp.json` — only `ralph-github` is registered.
5. **Verified** the `thoughts/` directory has 454 markdown files ready to index.
6. **Did NOT attempt to build the plugin** because:
   - The implementation plan is a 10-task, multi-file project (~1000+ lines of TypeScript)
   - It requires native C++ dependencies (`better-sqlite3`, `sqlite-vec`) and a large ML model download
   - Building it without explicit instruction to implement the full plan would be overstepping the "set up" request

## Blockers

**The knowledge-index MCP server has not been implemented yet.** There is no code to set up, configure, or run. The `knowledge_search` and `knowledge_traverse` MCP tools listed in the available deferred tools appear to exist in the tool registry, but the underlying server code at `plugin/ralph-hero/knowledge-index/` has not been created.

To proceed, someone needs to execute the implementation plan at `docs/plans/2026-03-08-knowledge-graph-impl.md` (Tasks B1-B10), which would create all the source files, build the MCP server, and run the initial index.

## Outcome

**Could not complete setup.** The ralph-knowledge plugin is in design/planning phase only — no implementation exists to set up. The design docs are comprehensive and contain complete source code for every file, but the code has not been written to disk yet.

## Confidence

High confidence that I correctly identified the situation. The task cannot be completed without first implementing the knowledge-index MCP server per the implementation plan.
