# Knowledge Graph for Ralph Hero

Design for scalable storage and discovery of plans, research, and outcomes with typed relationships.

## Problem

454 markdown files in 24 days (~19/day). Cross-referencing relies on GitHub issue comments, deterministic filenames, and glob-based discovery. Relationships between documents are implicit (shared issue numbers) — no structured way to surface thematically related documents or trace how knowledge evolves over time.

## Goals

- See the web of relationships between documents (what informed what, what replaced what, what conflicts with what)
- Both agents and humans consume the graph
- Agents build the graph as a natural byproduct of existing work (zero new workflow steps)
- Humans curate the graph (especially supersession decisions)
- Architecture supports personal use now and enterprise (400+ developers, federated teams) later without redesigning the document format

## Document Format

Every document gets a `## Prior Work` section after frontmatter and title, using Obsidian Dataview's `property:: [[wikilink]]` syntax:

```markdown
---
date: 2026-03-08
github_issue: 560
status: draft
type: research
tags: [caching, mcp-server, performance]
---

# GH-560: Response Cache TTL Strategy

## Prior Work

- builds_on:: [[2026-02-28-GH-0460-cache-invalidation-research]]
- tensions:: [[2026-02-25-GH-0390-aggressive-caching-plan]]

## Problem Statement
...
```

When a human decides a document is replaced:

```yaml
---
status: superseded
superseded_by: "[[2026-03-08-GH-0560-cache-ttl]]"
---
```

### Relationship Types

| Relationship | Asserted by | Location | Meaning |
|---|---|---|---|
| `builds_on` | Agent or human | `## Prior Work` on source doc | "I was informed by this" |
| `tensions` | Agent or human | `## Prior Work` on source doc | "This conflicts with or pulls against that" |
| `superseded_by` | **Human only** | Frontmatter on target doc | "This is replaced by that" |

### Wikilink Convention

- Use filenames without extension: `[[2026-02-28-GH-0460-cache-invalidation-research]]`
- Obsidian resolves these regardless of directory depth
- Agents parse them with regex: `(builds_on|tensions):: \[\[(.+?)\]\]`
- Cross-team references (future) work the same way — filenames are globally unique due to date + issue number

## Architecture

The system is split into two layers: an **innate document protocol** that ships with ralph-hero, and an **optional knowledge-index plugin** that adds search and graph traversal.

### Innate (always present in ralph-hero)

- `## Prior Work` section with typed `builds_on::` and `tensions::` wikilinks
- `superseded_by` frontmatter field (human-only)
- `tags:` in frontmatter
- Skills (ralph-research, ralph-plan) write these as part of normal document creation
- thoughts-locator uses grep/glob to parse wikilinks from files directly — no index needed

### Optional Plugin (knowledge-index)

```
┌──────────────────────────────────────────────────┐
│  Browsing: Obsidian + Dataview plugin            │
├──────────────────────────────────────────────────┤
│  Index: SQLite (FTS5 + sqlite-vec + rels)        │
├──────────────────────────────────────────────────┤
│  Source of Truth: Markdown files in git           │
└──────────────────────────────────────────────────┘
```

- **Source of truth**: Markdown files with typed wikilinks, committed to git in `thoughts/`
- **Index**: Derived SQLite database, rebuildable from source files. Provides keyword search (FTS5), semantic search (sqlite-vec embeddings), and typed relationship traversal (recursive CTEs)
- **Browsing**: Obsidian vault pointed at `thoughts/`. Dataview plugin for typed relationship queries

The index is derived and disposable. Delete it, rerun the indexer, everything is back.

Someone using ralph-hero **without** the knowledge plugin still gets typed relationships in their docs and Obsidian compatibility — they just don't get semantic search or graph traversal via MCP tools. The knowledge plugin is a pure accelerator, not a dependency.

## Index Schema

```sql
CREATE TABLE documents (
    id TEXT PRIMARY KEY,          -- filename without extension
    path TEXT NOT NULL,            -- relative path from repo root
    title TEXT,
    date TEXT,
    type TEXT,                     -- research, plan, review, idea, report
    status TEXT,                   -- draft, complete, approved, superseded
    github_issue INTEGER,
    content TEXT                   -- full body for FTS
);

CREATE VIRTUAL TABLE documents_fts USING fts5(
    id, title, content, tags,
    content='documents'
);

CREATE VIRTUAL TABLE documents_vec USING vec0(
    id TEXT PRIMARY KEY,
    embedding FLOAT[384]           -- all-MiniLM-L6-v2 dimensions
);

CREATE TABLE tags (
    doc_id TEXT REFERENCES documents(id),
    tag TEXT,
    PRIMARY KEY (doc_id, tag)
);

CREATE TABLE relationships (
    source_id TEXT REFERENCES documents(id),
    target_id TEXT REFERENCES documents(id),
    type TEXT CHECK(type IN ('builds_on', 'tensions', 'superseded_by')),
    PRIMARY KEY (source_id, target_id, type)
);

CREATE INDEX idx_rel_target ON relationships(target_id, type);
CREATE INDEX idx_tags_tag ON tags(tag);
```

## MCP Tools

Two new tools on the ralph-hero MCP server:

### `knowledge_search`

Keyword + semantic + tag search across all documents.

```typescript
// Input
{ query: "caching strategy TTL", tags?: ["mcp-server"], type?: "research", limit?: 10 }

// Output: ranked results with snippets
[{ id, path, title, score, snippet, tags, type, status }]
```

Uses FTS5 for keyword matching and sqlite-vec for embedding similarity, combined into a hybrid score.

### `knowledge_traverse`

Walk typed relationship edges from a document.

```typescript
// Input
{ from: "2026-03-08-GH-0560-cache-ttl", type?: "tensions", depth?: 3 }

// Output: relationship chain
[{ source_id, target_id, type, depth, doc: { title, status, date } }]
```

Uses recursive CTEs for multi-hop traversal.

## Indexer

A script (`scripts/reindex-knowledge.sh`) that:

1. Scans `thoughts/**/*.md`
2. Parses YAML frontmatter -> `documents` + `tags` rows
3. Parses `## Prior Work` section -> `relationships` rows
4. Parses `superseded_by` from frontmatter -> `relationships` rows (reversed direction)
5. Generates embeddings for title + first 500 words -> `documents_vec` rows
6. Rebuilds FTS index

Run by git post-commit hook or manually. Not an MCP tool — agents don't invoke it.

Embedding model: `all-MiniLM-L6-v2` (384 dims, runs locally, free) or swap for any model that produces the configured dimension. Token limit: 128 tokens for reliable quality, 256 max — chunk documents longer than ~500 chars.

## Agent Integration

### Innate changes (ralph-hero core)

Zero new workflow steps. Changes to existing skill templates:

1. **ralph-research** skill template: add `tags:` to required frontmatter, add `## Prior Work` as a required section (populated from thoughts-locator results during research phase)
2. **ralph-plan** skill template: add `tags:` to required frontmatter, add `## Prior Work` as a required section (populated from discovered research docs and related plans)
3. **thoughts-locator** agent: enhanced to grep for `builds_on::` and `tensions::` wikilinks in existing documents, enabling relationship discovery without any index

### Optional enhancements (knowledge-index plugin)

When the knowledge-index plugin is installed:

1. thoughts-locator calls `knowledge_search` + `knowledge_traverse` as primary discovery, falling back to grep/glob when unavailable
2. The indexer picks up new documents on next run

## Obsidian Setup

1. Open `thoughts/` as an Obsidian vault
2. Install Dataview plugin
3. Example queries:

```dataview
TABLE builds_on, tensions, status
WHERE builds_on != null OR tensions != null
SORT date DESC
```

```dataview
LIST
WHERE contains(builds_on, [[2026-02-28-GH-0460-cache-invalidation-research]])
```

## Enterprise Extensibility

Not built now, but the design supports it without changes to the document format:

- Add `team:` frontmatter field when federation is needed
- Swap sqlite-vec for Vertex AI Vector Search at scale
- Swap SQLite relationships for Neo4j if query patterns demand it
- Add a web UI alongside or instead of Obsidian
- Each team owns their repo; the index aggregates across all of them

## Decisions

- **Innate protocol vs optional index** — the document format (wikilinks, tags, Prior Work section) ships with ralph-hero core. The SQLite index, embeddings, and MCP search tools are an optional plugin. Ralph works without the plugin; the plugin just makes discovery faster and semantic.
- **Obsidian Dataview inline fields** (`property:: [[link]]`) over frontmatter wikilinks — first-class Obsidian citizen, better backlink support
- **`superseded_by` is human-only** — high-stakes relationship that effectively archives a document
- **`builds_on` and `tensions` are agent-assertable** — low/medium stakes, natural byproduct of prior work discovery
- **SQLite for everything** — FTS5 + sqlite-vec + recursive CTEs handle keyword search, semantic search, and graph traversal in one file. Swap backends later behind the MCP tool abstraction if needed
- **Indexer is a script, not an MCP tool** — reindexing is infrastructure, not an agent objective
- **No separate docs repo** — `thoughts/` stays in the code repo. Git handles thousands of text files fine. Split when it becomes a problem, not before
- **Separate MCP server** — the knowledge tools run as `ralph-knowledge` rather than being added to `ralph-github`, because `better-sqlite3` (native C++) and `@huggingface/transformers` (~80MB model) would break the npm distribution model of the main server
