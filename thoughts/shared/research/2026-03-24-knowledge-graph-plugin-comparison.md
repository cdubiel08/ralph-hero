---
date: 2026-03-24
topic: "obra/knowledge-graph plugin: lessons for our superpowers ecosystem"
tags: [research, knowledge-graph, ralph-knowledge, superpowers, plugin-architecture, graphology, semantic-search]
status: complete
type: research
git_commit: 50d5a9572982c42e010447a85ecad3b673b08e90
github_issue: 663
github_url: https://github.com/cdubiel08/ralph-hero/issues/663
---

# Research: obra/knowledge-graph — Lessons for Superpowers

## Prior Work

- builds_on:: [[2026-03-15-superpowers-vs-ralph-hero-comparison]]
- builds_on:: [[2026-03-10-multi-dir-knowledge-index]]
- builds_on:: [[2026-03-09-GH-0549-knowledge-metadata-alignment]]

## Research Question

Jesse Vincent (obra) published a [knowledge-graph](https://github.com/obra/knowledge-graph) Claude Code plugin that turns an Obsidian vault (~3,300 notes) into a queryable knowledge graph with 13 MCP tools, graph algorithms, and a "prove-claim" investigative skill. What can we learn from this implementation? What are we doing better? Where are we overcomplicating things?

## Summary

Knowledge-graph and our ralph-knowledge plugin share the same foundation (SQLite + sqlite-vec + FTS5 + `all-MiniLM-L6-v2` embeddings) but diverge sharply in what they build on top. Knowledge-graph invests in **graph algorithms** — community detection, centrality, bridge finding, path traversal — using the graphology library. We invest in **structured metadata** — typed relationships, superseded-doc tracking, outcome ledger, hybrid RRF search. Neither is wrong; they serve different corpora. But knowledge-graph exposes capabilities we lack that would genuinely improve document discovery, and our system carries complexity that knowledge-graph's simpler choices call into question.

---

## Detailed Findings

### What Knowledge-Graph Does

Blog post: [blog.fsck.com/releases/2026/03/20/knowledge-graph](https://blog.fsck.com/releases/2026/03/20/knowledge-graph/)
Source: [github.com/obra/knowledge-graph](https://github.com/obra/knowledge-graph)

13 MCP tools built on:
- **graphology** for Louvain community detection, PageRank, betweenness centrality, BFS neighbors, DFS path finding
- **sqlite-vec** for cosine-similarity vector search
- **FTS5** for keyword search
- **`Xenova/all-MiniLM-L6-v2`** for local embeddings (identical model to ours)
- **`gray-matter`** for frontmatter parsing

The vault is treated as a directed multigraph: markdown files = nodes, wiki links = edges. Every `[[wikilink]]` becomes an edge, with the enclosing paragraph stored as `context`. The indexer tracks file mtimes for incremental updates and creates stub nodes for unresolved link targets.

One skill ships: **prove-claim** — a 5-step investigative workflow (decompose claim → find entities → find connections → read evidence → report with verdict + confidence).

### What We're Doing Better

**1. Hybrid search with Reciprocal Rank Fusion**

Knowledge-graph exposes `kg_search` with a `mode` flag: either semantic OR fulltext. The caller has to decide. Our `knowledge_search` runs both FTS5 and vector search in parallel, fuses results via RRF (K=60), and returns a single ranked list. This consistently surfaces documents that either approach alone would miss.

**2. Typed, semantic relationships**

Knowledge-graph stores all wiki links as untyped edges in a flat `edges` table. Every `[[link]]` is treated identically. Our `relationships` table constrains edges to explicit types: `builds_on`, `tensions`, `superseded_by`. This means our graph traversal can answer "what does this document build on?" or "what supersedes this?" — questions that matter for research provenance. Knowledge-graph can only answer "what links to what?"

**3. Superseded document handling**

We track `superseded_by` as a first-class relationship. `knowledge_search` defaults to filtering out superseded documents, preventing stale research from polluting results. Knowledge-graph has no concept of document lifecycle — a year-old note and today's note have equal standing.

**4. Outcome ledger**

Our append-only `outcome_events` table records pipeline events (triage verdicts, drift counts, blocker events) tied to GitHub issue numbers. `knowledge_search` enriches results with outcome summaries inline. Knowledge-graph has no operational history layer — it indexes content but doesn't track what happened to the work that content represents.

**5. Structured document taxonomy**

Our parser infers document types from path segments (`/research/`, `/plans/`, `/ideas/`, `/reviews/`, `/reports/`) and frontmatter. `knowledge_search` accepts a `type` filter. Knowledge-graph treats all vault content uniformly — no type-based filtering.

**6. Tag-based filtering in search**

Our search tools accept `tags` parameter for filtering. Knowledge-graph extracts inline `#hashtags` into frontmatter but doesn't expose tag-filtered search through MCP.

### What We Can Learn

**1. Graph algorithms are the big gap**

Knowledge-graph uses graphology to answer questions we simply can't:

| Capability | Knowledge-graph | ralph-knowledge |
|---|---|---|
| Community detection | Louvain with configurable resolution | — |
| Centrality ranking | PageRank (with degree-centrality fallback for disconnected graphs) | — |
| Bridge/connector nodes | Betweenness centrality | — |
| Path finding | DFS all simple paths between two nodes | — |
| Common connections | Set intersection of neighbor sets | — |
| Subgraph extraction | N-hop neighborhood as nodes+edges | — |
| Neighbor traversal | BFS at configurable depth | Recursive CTE (outgoing + incoming) |

Our recursive CTE traverser handles linear chains well (`builds_on` paths), but can't identify document clusters, find the most important documents by connectivity, detect bridging documents that connect otherwise-separate topics, or extract the path of reasoning between two unrelated notes.

With ~200 documents in `thoughts/` (and growing), community detection would surface organic topic clusters. Bridge detection would identify documents that connect disparate workstreams. PageRank would surface the most-referenced research. These would make `knowledge_search` results dramatically more useful.

**2. Incremental indexing**

Knowledge-graph maintains a `sync` table with `(path, mtime, indexed_at)`. On re-index, files whose mtime hasn't changed are skipped entirely. Only changed/new files get re-parsed and re-embedded.

Our `reindex()` calls `clearAll()` then rebuilds everything from scratch every time. For 200 documents this is fast enough (~seconds), but it's wasteful — embedding is the expensive step, and unchanged documents produce identical embeddings. As the corpus grows, incremental indexing becomes essential.

**3. Edge context preservation**

When knowledge-graph encounters `[[Alice]]` in a paragraph about "Alice proposed the new API design," it stores that entire paragraph as the edge's `context` field. This means graph traversal results carry *why* the link exists, not just *that* it exists.

Our `relationships` table stores `(source_id, target_id, type)` with no context. When we traverse a `builds_on` chain, we know Document A builds on Document B, but not what specifically it builds on. The user has to read both documents to understand the connection.

**4. Stub nodes for unresolved references**

Knowledge-graph creates placeholder nodes with `{ _stub: true }` for wiki link targets that don't resolve to actual files. This preserves graph structure — a document linking to `[[future-research-topic]]` creates a visible node even before that document exists.

We silently discard unresolvable `[[wikilink]]` targets. This means forward references (linking to documents that don't exist yet) disappear from the graph entirely.

**5. Fuzzy node resolution**

Knowledge-graph implements a 5-tier name matching hierarchy: exact ID → exact title → case-insensitive title → alias → substring. All MCP tools use this resolver, so users can reference documents by approximate name.

Our tools require exact document IDs. This is fine for programmatic access but poor for conversational use.

**6. Write tools**

Knowledge-graph includes `kg_create_node`, `kg_annotate_node`, and `kg_add_link` — tools that create and modify vault content from within the MCP server. Our knowledge plugin is strictly read-only; document creation happens through skills writing files directly.

The advantage: write tools can atomically create content AND update the index in one operation, ensuring the graph is always consistent with the filesystem.

**7. The prove-claim skill pattern**

The `prove-claim` skill is a structured investigative workflow that leverages graph tools:
1. Decompose claim into entities and relationships
2. Find entities via semantic search
3. Find connections via paths, common neighbors, neighbor traversal
4. Read evidence (not just path existence — read actual content)
5. Report with verdict, confidence, evidence chains, and caveats

Key design insight from the skill: *"Do not stop at 'a path exists' — read the content to verify the connection is semantically relevant."* And: *"Community co-membership is not evidence; path through generic hub nodes is weaker than path through relevant summary nodes."*

This is a pattern we could adopt: a skill that uses graph structure to guide focused reading rather than just returning search results.

### Where We Might Be Overcomplicating

**1. Relationship type constraints**

We restrict relationships to exactly three types: `builds_on`, `tensions`, `superseded_by`. Knowledge-graph stores ALL wiki links as edges. This means we miss the vast majority of cross-references in our documents — any `[[wikilink]]` that isn't preceded by one of our three type prefixes is invisible to the graph.

Knowledge-graph's approach captures the full link topology. Our typed relationships carry more semantic meaning per edge, but at the cost of a sparse graph. The 80/20 solution: store untyped edges for ALL wiki links, keep typed relationships as an enrichment layer on top.

**2. Full rebuild indexing**

As noted above, our `clearAll()` + full rebuild is simpler code but does O(n) embedding work on every index. Knowledge-graph's mtime tracking is ~30 extra lines of code and reduces re-index cost to O(changed files). This is the kind of complexity that pays for itself immediately.

**3. Content truncation for embeddings**

Our `prepareTextForEmbedding()` concatenates `title + content` and truncates to 500 characters. Knowledge-graph's `buildEmbeddingText()` uses `title + tags + first paragraph`. Neither is clearly superior, but:
- We lose tag signal (which often captures the most important metadata)
- Truncating to a fixed character count is arbitrary — first paragraph is a more semantically meaningful boundary
- 500 chars is conservative for a 384-dim model that can handle ~512 tokens (~2000 chars)

**4. No brief/full mode for document retrieval**

Knowledge-graph's `kg_node` tool has a `brief` flag: brief returns metadata + connection titles only; full returns content + edge context. This is smart for LLM context management — you can explore the graph cheaply with brief lookups, then read full content only for promising nodes.

Our search returns full content excerpts always. For graph-style exploration (which we don't have yet), brief mode would be essential.

---

## Architecture Comparison

```
┌────────────────────────────────────┬────────────────────────────────────┐
│      obra/knowledge-graph          │       ralph-knowledge              │
├────────────────────────────────────┼────────────────────────────────────┤
│ Corpus: Obsidian vault (~3,300)    │ Corpus: thoughts/ dir (~200)       │
│ Edges: ALL wiki links (untyped)    │ Edges: 3 typed rels only           │
│ Graph: graphology (in-memory)      │ Graph: recursive CTE (SQL-only)    │
│ Algorithms: Louvain, PageRank,     │ Algorithms: linear chain traversal │
│   betweenness, DFS paths           │                                    │
│ Search: separate FTS / vector      │ Search: hybrid RRF fusion          │
│ Index: incremental (mtime)         │ Index: full rebuild                │
│ Edge context: paragraph stored     │ Edge context: none                 │
│ Stubs: created for broken links    │ Stubs: silently dropped            │
│ Name resolution: 5-tier fuzzy      │ Name resolution: exact ID only     │
│ Write: create/annotate/link tools  │ Write: none (read-only)            │
│ Skills: 1 (prove-claim)           │ Skills: 30+ (full pipeline)        │
│ Outcome tracking: none             │ Outcome tracking: event ledger     │
│ Document lifecycle: none           │ Document lifecycle: superseded_by  │
│ Type taxonomy: none                │ Type taxonomy: 5 inferred types    │
│ GitHub integration: none           │ GitHub integration: deep           │
└────────────────────────────────────┴────────────────────────────────────┘
```

## Actionable Ideas (Ranked by Impact)

1. **Add graphology** for community detection, centrality, and bridge finding. Our corpus is small enough that in-memory graph construction on-demand is trivial. Start with `kg_communities` and `kg_central` equivalents — these unlock document cluster discovery and importance ranking.

2. **Capture all wiki links as untyped edges** alongside existing typed relationships. This makes the graph dense enough for graph algorithms to work. Current typed relationships become a semantic overlay.

3. **Incremental indexing with mtime tracking**. ~30 lines of code, eliminates redundant embedding computation. Add a `sync` table with `(path, mtime, indexed_at)`.

4. **Store edge context** (the enclosing paragraph around each wiki link). Makes traversal results self-explanatory.

5. **Add brief/full mode to search results**. Brief = title + type + tags + connections. Full = content + snippets. Enables cheap graph exploration.

6. **Prove-claim style skill** that uses graph structure to guide evidence-based reasoning through our research corpus.

## Related Research

- [Superpowers vs Ralph-Hero Comparison](thoughts/shared/research/2026-03-15-superpowers-vs-ralph-hero-comparison.md)
- [Knowledge Metadata Alignment Plan](thoughts/shared/plans/2026-03-09-GH-0549-knowledge-metadata-alignment.md)
- [Multi-dir Knowledge Index Plan](thoughts/shared/plans/2026-03-10-multi-dir-knowledge-index.md)

## External References

- [Blog post: Knowledge Graph Tools](https://blog.fsck.com/releases/2026/03/20/knowledge-graph/) — Jesse Vincent
- [GitHub: obra/knowledge-graph](https://github.com/obra/knowledge-graph)
- [graphology library](https://graphology.github.io/)
- [sqlite-vec](https://github.com/asg017/sqlite-vec)

## Open Questions

1. Is graphology worth adding as a dependency, or can we get 80% of the value with SQL-only algorithms (e.g., simple degree centrality via `COUNT(*)` on edges)?
2. Should untyped edges and typed relationships coexist in the same table or separate tables?
3. Would incremental indexing break any assumptions in our test suite or index generation?
4. How does the prove-claim pattern adapt to our structured document types (research docs have different semantics than plan docs)?
