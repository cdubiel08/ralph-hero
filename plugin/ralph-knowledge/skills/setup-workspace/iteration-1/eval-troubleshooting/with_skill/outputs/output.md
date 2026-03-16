# Troubleshooting: knowledge_search Returns Empty Results

## Diagnosis

### Step 1: Verified MCP Server Connectivity

The `knowledge_search` and `knowledge_traverse` tools are both available and connected. No MCP server connectivity issue.

### Step 2: Tested knowledge_search

Ran a test query:

```
knowledge_search(query="recent research", limit=3)
```

**Result: Search returned 3 results successfully.** The tool is working.

Results returned:
1. `2026-03-01-hello-session-briefing` (thoughts/shared/ideas/) - score: 0.016
2. `2026-02-25-idea-hunt-synthesis` (thoughts/shared/ideas/) - score: 0.016
3. `2026-03-03-GH-0480-hello-session-briefing` (thoughts/shared/research/) - score: 0.016

### Step 3: Checked the Database

- **DB exists**: `/home/chad_a_dubiel/projects/ralph-hero/knowledge.db` (5.8 MB, last modified Mar 9 15:19)
- **`RALPH_KNOWLEDGE_DB` env var**: Not explicitly set -- the MCP server is using its default path resolution, which found the DB at the project root.

### Step 4: Checked the Thoughts Directory

- **Location**: `/home/chad_a_dubiel/projects/ralph-hero/thoughts/`
- **Contents**: 454 markdown files indexed

## Findings

The `knowledge_search` tool is **currently working**. If you were previously getting empty results, here are the most likely causes and how to prevent recurrence:

### Common Causes of Empty Results

1. **DB path mismatch**: The most common cause. If `RALPH_KNOWLEDGE_DB` is not set, the MCP server resolves `knowledge.db` relative to its own working directory. If the server's working directory changes (e.g., running from a worktree), it may look for the DB in a different location than where reindex wrote it.

   **Fix**: Set an absolute path in `.claude/settings.local.json`:
   ```json
   {
     "env": {
       "RALPH_KNOWLEDGE_DB": "/home/chad_a_dubiel/projects/ralph-hero/knowledge.db"
     }
   }
   ```

2. **Stale or empty DB**: If the DB file exists but was never populated (e.g., reindex failed partway through), searches return empty.

   **Fix**: Re-run the reindex:
   ```bash
   cd /tmp && npm install --no-save ralph-hero-knowledge-index@latest 2>&1 | tail -3
   node /tmp/node_modules/ralph-hero-knowledge-index/dist/reindex.js /home/chad_a_dubiel/projects/ralph-hero/thoughts /home/chad_a_dubiel/projects/ralph-hero/knowledge.db
   ```

3. **MCP server reading a different DB copy**: If there are multiple `knowledge.db` files (e.g., one in the project root, one in a worktree), the server may read a different copy than the one you indexed into.

   **Fix**: Search for duplicate DB files and set the explicit absolute path as shown above.

4. **Query too specific**: If searching for a very narrow term that doesn't appear in any indexed document, results will be empty. Try broader queries like "research" or "plan".

## Recommendation

Since `RALPH_KNOWLEDGE_DB` is not currently set explicitly, I recommend adding it to prevent future path-resolution issues:

Add to `.claude/settings.local.json`:
```json
{
  "env": {
    "RALPH_KNOWLEDGE_DB": "/home/chad_a_dubiel/projects/ralph-hero/knowledge.db"
  }
}
```

This ensures the MCP server always finds the DB regardless of working directory.

## Current Status

```
Knowledge Index Status
======================
Documents indexed: 454
Database: /home/chad_a_dubiel/projects/ralph-hero/knowledge.db (5.8 MB)
Thoughts directory: /home/chad_a_dubiel/projects/ralph-hero/thoughts/
MCP server: Connected and responding

Tools available:
  - knowledge_search: Working (verified with test query)
  - knowledge_traverse: Connected (available)

To reindex after adding new documents:
  /ralph-knowledge:setup /home/chad_a_dubiel/projects/ralph-hero/thoughts
```
