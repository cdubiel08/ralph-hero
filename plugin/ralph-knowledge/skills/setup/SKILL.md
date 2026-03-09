---
description: Set up or rebuild the ralph-knowledge index from markdown documents. Use when setting up ralph-knowledge for the first time, reindexing after adding new documents, rebuilding a corrupted knowledge DB, or when knowledge_search returns empty results. Also use when the user mentions "index thoughts", "reindex", "set up knowledge", or "knowledge search not working".
argument-hint: "[thoughts-directory]"
---

# Ralph Knowledge Setup

Interactive setup and reindex skill for the ralph-knowledge plugin. Indexes markdown documents from a `thoughts/` directory into a SQLite database with full-text search and semantic embeddings.

## Prerequisites

The ralph-knowledge MCP server must be running. If `knowledge_search` and `knowledge_traverse` tools aren't available, tell the user:

```
The ralph-knowledge MCP server isn't connected.

To install:
1. Add to .claude/settings.local.json:
   "enabledPlugins": { "ralph-knowledge@ralph-hero": true }
2. Restart Claude Code
3. Run this skill again
```

## Workflow

### Step 1: Locate the thoughts directory

If an argument was provided, use it as the thoughts directory path.

Otherwise, look for a `thoughts/` directory in these locations (in order):
1. `./thoughts/` (current project root)
2. `../thoughts/` (parent directory, for worktree setups)

If found, confirm with the user:
```
Found thoughts directory: [path]
Contains [N] markdown files

Proceed with indexing?
```

If not found, ask the user for the path.

### Step 2: Determine the DB path

Check if `RALPH_KNOWLEDGE_DB` is set in the environment. If so, use it.

If not, default to `knowledge.db` in the current project root. Note: this is a relative path that resolves based on the MCP server's working directory.

For a more reliable setup, suggest setting an absolute path:
```
Tip: For consistent DB location, add to .claude/settings.local.json:
{
  "env": {
    "RALPH_KNOWLEDGE_DB": "/absolute/path/to/knowledge.db"
  }
}
```

### Step 3: Install and run reindex

The reindex script is bundled in the npm package. Install it to a temp location and run:

```bash
cd /tmp && npm install --no-save ralph-hero-knowledge-index@latest 2>&1 | tail -3
node /tmp/node_modules/ralph-hero-knowledge-index/dist/reindex.js [thoughts-dir] [db-path]
```

Display the output as it runs. The script will:
- Scan for all `.md` files recursively (skipping dot-directories)
- Parse frontmatter (title, date, type, status, tags)
- Extract `## Prior Work` relationships (builds_on, tensions, superseded_by)
- Build FTS5 full-text search index
- Generate 384-dim semantic embeddings via all-MiniLM-L6-v2
- Store everything in the SQLite database

The first run downloads the embedding model (~80MB) which takes a minute. Subsequent runs are faster.

### Step 4: Verify

After indexing completes, verify the tools work by running a test search:

```
knowledge_search(query="recent research", limit=3)
```

Display the results. If results come back, setup is complete. If results are empty or an error occurs:

- **Empty results with "Error: no such table"**: The MCP server's DB path doesn't match where reindex wrote the DB. Check `RALPH_KNOWLEDGE_DB` env var.
- **Empty results but no error**: The DB exists but the MCP server is reading a different copy. Set `RALPH_KNOWLEDGE_DB` to the absolute path of the DB that was just created.
- **Connection error**: The MCP server isn't running. Run `/reload-plugins` or restart Claude Code.

### Step 5: Summary

```
Knowledge Index Ready
=====================
Documents indexed: [N]
Database: [db-path]
Thoughts directory: [thoughts-dir]

Tools available:
  - knowledge_search: Keyword + semantic search across documents
  - knowledge_traverse: Walk relationship edges between documents

To reindex after adding new documents:
  /ralph-knowledge:setup [thoughts-dir]
```
