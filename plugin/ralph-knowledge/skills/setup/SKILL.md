---
description: Set up or rebuild the ralph-knowledge index from markdown documents. Use when setting up ralph-knowledge for the first time, reindexing after adding new documents, rebuilding a corrupted knowledge DB, or when knowledge_search returns empty results. Also use when the user mentions "index thoughts", "reindex", "set up knowledge", or "knowledge search not working".
argument-hint: "[directory1,directory2,...]"
---

# Ralph Knowledge Setup

Interactive setup and reindex skill for the ralph-knowledge plugin. Indexes markdown documents from one or more directories into a SQLite database with full-text search and semantic embeddings.

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

### Step 1b: Additional directories

After confirming the thoughts directory, check if `RALPH_KNOWLEDGE_DIRS` is set in the environment. If it contains additional directories beyond the one found in Step 1, note them:

```
Also indexing from RALPH_KNOWLEDGE_DIRS: docs/plans, docs/adr
```

If `RALPH_KNOWLEDGE_DIRS` is NOT set, ask:

```
Would you like to index additional directories alongside thoughts/?
Common choices: docs/, docs/plans/, docs/adr/

Enter comma-separated paths (relative to project root), or press Enter to skip:
```

If the user provides additional directories, validate each exists. Combine all directories into a single list for Step 3.

If the user wants to persist this, suggest:

```
To persist, add to .claude/settings.local.json:
{
  "env": {
    "RALPH_KNOWLEDGE_DIRS": "thoughts,docs/plans"
  }
}
```

### Step 2: Determine the DB path

The default DB path is `~/.ralph-hero/knowledge.db`. The directory is auto-created if it doesn't exist.

If `RALPH_KNOWLEDGE_DB` is set in the environment, that overrides the default. Use it instead.

Pass the resolved DB path to the reindex script in Step 3.

### Step 3: Install and run reindex

The reindex script is bundled in the npm package. Install it to a temp location and run:

```bash
cd /tmp && npm install --no-save ralph-hero-knowledge-index@latest 2>&1 | tail -3
node /tmp/node_modules/ralph-hero-knowledge-index/dist/reindex.js [dir1] [dir2] ... [db-path]
```

Pass all directories as separate arguments, followed by the database path (ending in `.db`).

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

- **Empty results with "Error: no such table"**: The MCP server's DB path doesn't match where reindex wrote the DB. Both default to `~/.ralph-hero/knowledge.db` — if overriding, ensure `RALPH_KNOWLEDGE_DB` matches the path passed to reindex.
- **Empty results but no error**: The MCP server may need restarting to pick up the new DB. Run `/reload-plugins` or restart Claude Code.
- **Connection error**: The MCP server isn't running. Run `/reload-plugins` or restart Claude Code.

### Step 5: Summary

```
Knowledge Index Ready
=====================
Documents indexed: [N]
Database: [db-path]
Directories indexed:
  - thoughts/
  - docs/plans/

Tools available:
  - knowledge_search: Keyword + semantic search across documents
  - knowledge_traverse: Walk relationship edges between documents

To reindex after adding new documents:
  /ralph-knowledge:setup
```
