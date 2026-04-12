---
date: 2026-04-03
topic: "obra/knowledge-graph vs ralph-knowledge: implementation comparison after convergence"
tags: [research, knowledge-graph, ralph-knowledge, graphology, semantic-search, obra, comparison]
status: complete
type: research
git_commit: 22a88633ef60046ddfc77c3d54fb6a70c3189acc
---

# Research: obra/knowledge-graph vs ralph-knowledge — Post-Convergence Comparison

## Prior Work

- builds_on:: [[2026-03-24-knowledge-graph-plugin-comparison]]
- builds_on:: [[2026-03-24-GH-0670-graphology-graph-builder]]
- builds_on:: [[2026-03-24-GH-0671-knowledge-communities-louvain]]
- builds_on:: [[2026-03-24-GH-0672-centrality-tools]]
- builds_on:: [[2026-03-24-GH-0673-knowledge-paths-and-common-tools]]
- builds_on:: [[2026-03-24-GH-0664-capture-all-wiki-links-as-edges]]
- builds_on:: [[2026-03-24-GH-0667-knowledge-brief-full-mode]]
- builds_on:: [[2026-03-24-GH-0668-prove-claim-investigative-skill]]

## Research Question

The original comparison (March 24) identified 7 gaps in ralph-knowledge relative to obra/knowledge-graph. A burst of implementation followed. What is the current parity status? What still diverges, and what has each system done that the other hasn't?

## Summary

Since the March 24 comparison, ralph-knowledge has implemented **6 of the 7 identified gaps**: graphology integration, untyped edges with context, incremental indexing, stub nodes, brief mode on search/traverse, and the prove-claim skill. The one remaining gap is **write tools** (kg_create_node, kg_annotate_node, kg_add_link). Meanwhile, ralph-knowledge retains 6 structural advantages that obra's implementation does not have: hybrid RRF search fusion, typed semantic relationships, superseded document lifecycle, outcome ledger, document type taxonomy, and tag-filtered search. The two implementations have converged significantly but serve fundamentally different use cases — obra indexes a personal Obsidian vault, ralph-knowledge indexes a project-management document corpus with GitHub integration.

---

## Gap Closure Scorecard

| Original Gap (March 24) | Status | Implementation |
|---|---|---|
| Graph algorithms (Louvain, PageRank, betweenness, DFS, common) | **Closed** | `graph-tools.ts`, `graph-builder.ts` — 5 tools |
| Capture all wiki links as untyped edges | **Closed** | `parser.ts:120-121` — `extractUntypedWikilinks()` with paragraph context |
| Edge context preservation | **Closed** | `relationships.context` column, schema migration in `db.ts:169-189` |
| Incremental indexing (mtime) | **Closed** | `sync` table in `db.ts:153-157`, mtime comparison in `reindex.ts:57` |
| Stub nodes for unresolved references | **Closed** | `db.upsertStubDocument()` called per-edge and in global pass (`reindex.ts:102-145`) |
| Brief/full mode for search results | **Closed** | `brief` param on `knowledge_search` and `knowledge_traverse` (`index.ts:42,79`) |
| Write tools (create/annotate/link) | **Open** | obra has `kg_create_node`, `kg_annotate_node`, `kg_add_link`; ralph-knowledge is read-only |

---

## Detailed Feature Comparison

### Shared Foundation (identical)

Both implementations share:
- **SQLite** via `better-sqlite3`
- **sqlite-vec** for vector storage (384-dim float arrays)
- **FTS5** for full-text search
- **`Xenova/all-MiniLM-L6-v2`** via `@huggingface/transformers` for local embeddings
- **graphology** for in-memory graph algorithms
- **Incremental indexing** with mtime-based sync tables
- **Stub nodes** for unresolved wikilink targets

### Where ralph-knowledge is ahead

**1. Hybrid search with Reciprocal Rank Fusion**

ralph-knowledge runs FTS5 and vector search in parallel, fuses via RRF (K=60), and returns a single ranked list (`hybrid-search.ts`). obra's `kg_search` requires the caller to choose `fulltext: true` or semantic — one mode per call, no fusion.

**2. Typed semantic relationships**

ralph-knowledge's `relationships` table has a `type` column with CHECK constraint: `builds_on`, `tensions`, `superseded_by`, `post_mortem`, `untyped`. This enables typed traversal ("what does this document build on?"). obra stores all edges as untyped rows in a flat `edges` table — context text is the only qualifier.

**3. Superseded document lifecycle**

`knowledge_search` defaults to filtering out documents with `superseded_by` relationships, preventing stale research from appearing. obra has no document lifecycle concept.

**4. Outcome ledger**

`outcome_events` table records pipeline events (triage verdicts, phase completions, drift counts) tied to GitHub issue numbers. `knowledge_search` enriches results with outcome summaries. Two MCP tools: `knowledge_record_outcome`, `knowledge_query_outcomes`. obra has nothing equivalent.

**5. Document type taxonomy**

Parser infers types from path segments (`/research/`, `/plans/`, `/ideas/`, `/reviews/`, `/reports/`). Search accepts `type` filter. obra treats all vault content uniformly.

**6. Tag-filtered search**

`knowledge_search` accepts a `tags` array for filtering. obra extracts `#hashtags` into frontmatter but doesn't expose tag-filtered search via MCP.

### Where obra is ahead

**1. Write tools**

obra has 3 write tools (`kg_create_node`, `kg_annotate_node`, `kg_add_link`) backed by a `VaultWriter` class. These atomically create/modify markdown files AND update the index in one operation, ensuring graph-filesystem consistency. ralph-knowledge is strictly read-only — document creation happens through skills writing files directly, with a manual reindex to pick up changes.

**2. Fuzzy node resolution**

obra implements a 5-tier name matching cascade: exact ID → exact title → case-insensitive title → alias → substring (`resolve.ts`). All MCP tools use this resolver. ralph-knowledge requires exact document IDs.

**3. Subgraph extraction tool**

obra's `kg_subgraph` extracts an N-hop neighborhood as a self-contained graph (nodes + edges). ralph-knowledge has `knowledge_traverse` for chain walking and `knowledge_paths` for path finding, but no tool that returns a subgraph as a structural unit.

**4. Community persistence**

obra stores detected communities in a `communities` table with labels and summaries. ralph-knowledge computes communities on-the-fly with no persistence — every `knowledge_communities` call rebuilds the graph and runs Louvain from scratch.

**5. Separate community detail tool**

obra has both `kg_communities` (list all) and `kg_community` (get one by ID/label). ralph-knowledge has only `knowledge_communities` which returns all communities in one response (the 318K character output we observed is evidence of this scaling issue).

### Differences in implementation approach

| Dimension | obra | ralph-knowledge |
|-----------|------|-----------------|
| **Edge storage** | Flat `edges` table, no type column, autoincrement PK | Single `relationships` table with type CHECK constraint, composite PK `(source, target, type)` |
| **Edge context** | Always stored (default `''`) | Stored for untyped edges, NULL for typed |
| **Embedding text** | `title + tags + first paragraph`, no explicit truncation | `title + content`, truncated to 500 chars |
| **Embedding quantization** | `dtype: 'q8'` (8-bit, 22MB) | Default precision (no quantization specified) |
| **FTS rebuild** | Per-document insert/delete via FTS content sync | Full FTS rebuild on every reindex (`reindex.ts:129`) |
| **Graph construction** | Persistent communities table | On-demand graph construction from relationships table |
| **Node filtering** | All nodes including stubs | Stubs excluded from graph and vector search |
| **PageRank isolation** | Filters isolates before computation | Runs PageRank on all nodes, then zeroes isolate scores post-hoc |
| **Louvain determinism** | Not specified in source | Fixed RNG `() => 0.5` for deterministic results |
| **CJS interop** | Not addressed in available source | Explicit CJS interop via `createRequire` for graphology-metrics subpath modules |
| **MCP tool count** | 14 tools | 9 tools (search, traverse, record/query outcomes, communities, central, bridges, paths, common) |
| **Skills** | 1 (`prove-claim`) | 3 setup skills + `prove-claim` in ralph-hero plugin |
| **CLI** | 10 CLI commands via commander | No CLI (MCP-only) |

---

## Graph Statistics (live, as of 2026-04-03)

ralph-knowledge graph: **1,026 nodes / 499 edges**

Top bridge documents by betweenness centrality:
1. `2026-03-19-stripe-minions-agentic-infrastructure` (0.0062)
2. `2026-03-25-eight-pillar-product-readiness-audit` (0.0044)
3. `2026-03-21-GH-0150-deployment-architecture-state` (0.0024)

obra's graph size is ~3,300 nodes (full Obsidian vault) — no public statistics on edge count.

---

## Code References

- Graph builder: `plugin/ralph-knowledge/src/graph-builder.ts:27-68`
- Graph tools (5 algorithms): `plugin/ralph-knowledge/src/graph-tools.ts:176-649`
- Relationship schema + migration: `plugin/ralph-knowledge/src/db.ts:120-189`
- Incremental indexing: `plugin/ralph-knowledge/src/reindex.ts:32-126`
- Stub creation: `plugin/ralph-knowledge/src/reindex.ts:102-145`
- Untyped edge extraction: `plugin/ralph-knowledge/src/parser.ts:62-90`
- Hybrid RRF search: `plugin/ralph-knowledge/src/hybrid-search.ts:8-101`
- Outcome ledger tools: `plugin/ralph-knowledge/src/index.ts:94-170`

## External References

- [obra/knowledge-graph source](https://github.com/obra/knowledge-graph)
- [obra blog post](https://blog.fsck.com/releases/2026/03/20/knowledge-graph/)
- [graphology library](https://graphology.github.io/)

## Historical Context (from thoughts/)

20 related documents exist in `thoughts/shared/`. The March 24 original comparison (GH-663) drove a wave of 7+ implementation tickets (GH-664 through GH-673) that closed most gaps within a week. The `prove-claim` skill was implemented in the ralph-hero plugin layer rather than in ralph-knowledge itself, following the existing pattern where skills compose MCP tools.

## Open Questions

1. Should ralph-knowledge add write tools, or is the current pattern (skills write files, reindex picks them up) sufficient?
2. Should `knowledge_communities` persist results to avoid the 318K response problem, or should a `knowledge_community` (singular) detail tool be added to paginate?
3. Is fuzzy node resolution worth implementing, or do skills already handle name resolution before calling knowledge tools?
4. Should FTS rebuild be made incremental (per-document content sync) to match the rest of the incremental indexing pipeline?
