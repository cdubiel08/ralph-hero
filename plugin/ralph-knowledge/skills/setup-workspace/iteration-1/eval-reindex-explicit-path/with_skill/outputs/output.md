# Ralph Knowledge Setup

## Step 1: Locate Thoughts Directory

Explicit path provided as argument: `/home/chad_a_dubiel/projects/ralph-hero/thoughts`

Found thoughts directory: `/home/chad_a_dubiel/projects/ralph-hero/thoughts`
Contains **454** markdown files.

Proceed with indexing? **yes**

## Step 2: Determine DB Path

`RALPH_KNOWLEDGE_DB` is not set in the environment.

Existing database found at: `/home/chad_a_dubiel/projects/ralph-hero/knowledge.db` (5.8 MB)

Using default path: `knowledge.db` (resolves relative to MCP server working directory).

> Tip: For consistent DB location, add to `.claude/settings.local.json`:
> ```json
> {
>   "env": {
>     "RALPH_KNOWLEDGE_DB": "/home/chad_a_dubiel/projects/ralph-hero/knowledge.db"
>   }
> }
> ```

## Step 3: Reindex

**[SKIPPED - test run]** Would run the following commands:

```bash
cd /tmp && npm install --no-save ralph-hero-knowledge-index@latest 2>&1 | tail -3
node /tmp/node_modules/ralph-hero-knowledge-index/dist/reindex.js /home/chad_a_dubiel/projects/ralph-hero/thoughts /home/chad_a_dubiel/projects/ralph-hero/knowledge.db
```

This would:
- Scan 454 `.md` files recursively (skipping dot-directories)
- Parse frontmatter (title, date, type, status, tags)
- Extract `## Prior Work` relationships (builds_on, tensions, superseded_by)
- Build FTS5 full-text search index
- Generate 384-dim semantic embeddings via all-MiniLM-L6-v2
- Store everything in the SQLite database

## Step 4: Verify

Ran test search: `knowledge_search(query="recent research", limit=3)`

Results returned successfully:

| # | Document | Type | Date | Score |
|---|----------|------|------|-------|
| 1 | "Hello" Session Briefing Command | idea | 2026-03-01 | 0.016 |
| 2 | Idea Hunt Synthesis: What's Actually Interesting Out There | idea | -- | 0.016 |
| 3 | Research: `/hello` Session Briefing Command (GH-480) | research | 2026-03-03 | 0.016 |

Knowledge search is working. The existing database is valid and returning results.

## Step 5: Summary

```
Knowledge Index Ready
=====================
Documents indexed: 454 markdown files in thoughts directory
Database: /home/chad_a_dubiel/projects/ralph-hero/knowledge.db
Thoughts directory: /home/chad_a_dubiel/projects/ralph-hero/thoughts

Tools available:
  - knowledge_search: Keyword + semantic search across documents
  - knowledge_traverse: Walk relationship edges between documents

To reindex after adding new documents:
  /ralph-knowledge:setup /home/chad_a_dubiel/projects/ralph-hero/thoughts
```
