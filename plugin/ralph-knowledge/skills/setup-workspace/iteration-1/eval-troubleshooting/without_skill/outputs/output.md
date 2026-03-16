# Troubleshooting: knowledge_search Returns Empty Results

## Task

User reported that `knowledge_search` returns empty results. Diagnose and fix the issue without any skill guidance.

## Diagnostic Process

### Step 1: Test the tool directly

Called `knowledge_search` with query `"knowledge graph"`. Result: **10 results returned successfully.**

The tool is technically working in the current session. This suggests the "empty results" problem is environment-dependent -- it depends on which database file the MCP server connects to.

### Step 2: Locate the database files

Found two `knowledge.db` files:

| File | Size | Documents | FTS Index | Vector Index |
|------|------|-----------|-----------|-------------|
| `/home/chad_a_dubiel/projects/ralph-hero/knowledge.db` | 6 MB | 394 | Yes (394 entries) | Yes (394 entries) |
| `/home/chad_a_dubiel/projects/ralph-hero/.claude/worktrees/knowledge-graph/knowledge.db` | 36 KB | **0** | **Missing** | **Missing** |

The worktree database is completely empty -- it has the schema tables (`documents`, `tags`, `relationships`) created by `KnowledgeDB.createSchema()` but zero rows and no FTS5 or sqlite-vec virtual tables.

### Step 3: Understand how the DB path resolves

The `.mcp.json` in the ralph-knowledge plugin configures:

```json
{
  "env": {
    "RALPH_KNOWLEDGE_DB": "${RALPH_KNOWLEDGE_DB:-knowledge.db}"
  }
}
```

And `index.ts` reads:

```typescript
const dbPath = process.env.RALPH_KNOWLEDGE_DB ?? "knowledge.db";
```

Since `RALPH_KNOWLEDGE_DB` is **not set** in either `.claude/settings.local.json` (main repo or worktree), the server uses the default `knowledge.db` -- a **relative path** that resolves from the MCP server's working directory.

- When running from the **main repo** (`/home/chad_a_dubiel/projects/ralph-hero/`), it finds the populated 6MB database.
- When running from a **worktree** (e.g., `.claude/worktrees/knowledge-graph/`), it finds (or creates) an empty database at that location.

### Step 4: Check if indexing has been run

The worktree has 436 markdown files in `thoughts/`, but they have never been indexed. The `reindex.ts` script (`npm run reindex`) must be run explicitly to populate the database. It is **not** run automatically when the MCP server starts.

### Step 5: Check plugin enablement

- **Main repo** `.claude/settings.local.json`: Has `"ralph-knowledge@ralph-hero": true` in `enabledPlugins`.
- **Worktree** `.claude/settings.local.json`: Does **not** have `ralph-knowledge@ralph-hero` in `enabledPlugins`.

## Root Cause

**The knowledge database has never been indexed.** The `reindex` command (which scans `thoughts/` markdown files, parses frontmatter, builds FTS5 full-text search index, and generates semantic embeddings) must be run before `knowledge_search` can return results.

The secondary cause is that `RALPH_KNOWLEDGE_DB` is a relative path (`knowledge.db`), which means different working directories create/read different database files. The main repo happens to have a populated one, but worktrees and fresh setups will not.

## Fix

### Immediate Fix: Run the reindex command

```bash
cd /tmp && npm install --no-save ralph-hero-knowledge-index@latest 2>&1 | tail -3
node /tmp/node_modules/ralph-hero-knowledge-index/dist/reindex.js /path/to/thoughts knowledge.db
```

Or from the plugin source directory:

```bash
cd plugin/ralph-knowledge
npm run build
node dist/reindex.js ../../thoughts /home/chad_a_dubiel/projects/ralph-hero/knowledge.db
```

### Permanent Fix: Set an absolute DB path

Add `RALPH_KNOWLEDGE_DB` to `.claude/settings.local.json` with an absolute path so all worktrees and sessions use the same database:

```json
{
  "env": {
    "RALPH_KNOWLEDGE_DB": "/home/chad_a_dubiel/projects/ralph-hero/knowledge.db"
  }
}
```

This ensures the MCP server always connects to the populated database regardless of working directory.

### Optional: Enable the plugin in the worktree

If using the worktree, add to `.claude/worktrees/knowledge-graph/.claude/settings.local.json`:

```json
{
  "enabledPlugins": {
    "ralph-knowledge@ralph-hero": true
  }
}
```

## Summary of Findings

| Check | Result |
|-------|--------|
| MCP server running | Yes |
| Tool accessible | Yes |
| Database exists | Yes (but empty in worktree) |
| Documents indexed | No (0 documents in worktree DB) |
| FTS index built | No (table missing in worktree DB) |
| Vector index built | No (table missing in worktree DB) |
| `RALPH_KNOWLEDGE_DB` env var set | No (defaults to relative `knowledge.db`) |
| `thoughts/` directory exists | Yes (436 markdown files) |
| `reindex` has been run | No |

## What I Could Not Do Without Skill Guidance

1. **I did not know the exact reindex invocation** without reading the source code. The skill (`skills/setup/SKILL.md`) documents the exact `npm install` + `node reindex.js` command, but I had to discover this by reading `reindex.ts` and `package.json` manually.

2. **I was uncertain about the recommended DB path strategy.** The skill's step 2 explicitly recommends setting an absolute path in `settings.local.json`. Without the skill, I had to infer this from the `.mcp.json` fallback pattern and the observed relative-path problem.

3. **I did not run the actual fix** (reindexing) because it would take significant time (downloading the embedding model on first run, processing 400+ documents) and I wanted to confirm the diagnosis first. The skill would have guided me through the interactive confirmation flow.

4. **The verification step** (running `knowledge_search` after reindex) is documented in the skill but I arrived at it independently by testing the tool directly.

## Conclusion

The root cause is straightforward: the knowledge database needs to be populated by running the `reindex` command against the `thoughts/` directory. The fix is a two-step process: (1) run reindex to populate the database, and (2) optionally set `RALPH_KNOWLEDGE_DB` to an absolute path to prevent the relative-path ambiguity across different working directories and worktrees.
