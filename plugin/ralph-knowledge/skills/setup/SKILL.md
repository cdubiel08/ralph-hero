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

### Step 4: Run end-to-end bootstrap (dream-loop wiring)

This step is OPTIONAL — if the user only wanted to reindex, they can stop after Step 3. If they want the full dream-loop wiring (memory config, launchd nightly schedule, smoke ingest), continue here.

Ask the user:

```
Reindex complete. Would you also like to run the dream-loop bootstrap?
This writes ~/.ralph/knowledge.config.json, renders + loads the launchd
nightly plist, probes Gemma, and runs a smoke ingest.

(yes/no, default yes)
```

If yes (or no answer), invoke the bootstrap script. It is the single source of truth for setup logic — when something changes about dream-loop wiring, edit `bootstrap.sh`, not this skill:

```bash
bash "$CLAUDE_PLUGIN_ROOT/../../scripts/dream/bootstrap.sh"
```

(If `$CLAUDE_PLUGIN_ROOT` resolution to the repo root is unclear, fall back to discovering the repo: `git -C $(pwd) rev-parse --show-toplevel` then `bash <repo-root>/scripts/dream/bootstrap.sh`.)

The bootstrap script is idempotent:
- Each step prints `OK <step>` or `SKIP <step> (already configured)`
- Re-running yields all SKIP for file-creation steps and exits 0
- Gemma probe failures are non-blocking (prints `gemma-up` hint to stderr but continues)

Display the bootstrap output as it runs. The script prints a tier-count summary and a next-steps banner on completion.

### Step 5: Verify

After indexing completes, verify the tools work by running a test search:

```
knowledge_search(query="recent research", limit=3)
```

Display the results. If results come back, setup is complete. If results are empty or an error occurs:

- **Empty results with "Error: no such table"**: The MCP server's DB path doesn't match where reindex wrote the DB. Both default to `~/.ralph-hero/knowledge.db` — if overriding, ensure `RALPH_KNOWLEDGE_DB` matches the path passed to reindex.
- **Empty results but no error**: The MCP server may need restarting to pick up the new DB. Run `/reload-plugins` or restart Claude Code.
- **Connection error**: The MCP server isn't running. Run `/reload-plugins` or restart Claude Code.

### Step 6: Summary

Print a final summary that includes the tier-count rollup from the bootstrap step (if it was run):

```
Knowledge Index Ready
=====================
Documents indexed: [N]
Database: [db-path]
Directories indexed:
  - thoughts/
  - docs/plans/

Tier counts (from `sqlite3 [db] "SELECT memory_tier, COUNT(*) FROM documents GROUP BY memory_tier"`):
  doc=[N]
  raw=[N]
  reflection=[N]
  wiki=[N]

Tools available:
  - knowledge_search: Keyword + semantic search across documents
  - knowledge_recall: Role-aware retrieval (researcher/planner/implementer/...)
  - knowledge_traverse: Walk relationship edges between documents

To reindex after adding new documents:
  /ralph-knowledge:setup

To re-run dream-loop bootstrap (idempotent):
  bash scripts/dream/bootstrap.sh
```

Then suggest:
```
Want to browse your knowledge documents in Obsidian?
Run /ralph-knowledge:setup-obsidian to set up navigational indexes and vault config.
```
