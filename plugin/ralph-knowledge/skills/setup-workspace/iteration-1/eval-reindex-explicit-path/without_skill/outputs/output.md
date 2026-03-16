# Reindex Knowledge Base - Without Skill

## Task

Reindex the knowledge base from `/home/chad_a_dubiel/projects/ralph-hero/thoughts`.

## Approach

Without any skill guidance, I investigated the knowledge plugin structure through the following steps:

1. **Explored the plugin directory** at `plugin/ralph-knowledge/` -- found it contained only a `skills/` directory with eval scaffolding (no local source code).

2. **Identified the npm package** `ralph-hero-knowledge-index` referenced in the `.mcp.json` at `plugin/ralph-knowledge/.mcp.json`. The MCP server config showed:
   - Command: `npx -y ralph-hero-knowledge-index@0.1.4`
   - Environment: `RALPH_KNOWLEDGE_DB` defaulting to `knowledge.db`

3. **Inspected the npm package** using `npm view ralph-hero-knowledge-index scripts` which revealed:
   - `reindex`: `node dist/reindex.js` -- the script needed for reindexing
   - `start`: `node dist/index.js` -- the MCP server entrypoint
   - The `bin` entry points to `dist/index.js` (MCP server), not the reindex script

4. **Read the `reindex.js` source** from the npx cache to understand its interface:
   - `argv[2]`: thoughts directory path (defaults to `../../thoughts`)
   - `argv[3]`: database file path (defaults to `knowledge.db`)
   - Walks the directory recursively for `.md` files
   - Parses each document (extracting title, date, type, status, tags, relationships)
   - Builds FTS (full-text search) index
   - Generates vector embeddings using `@huggingface/transformers`
   - Stores everything in a SQLite database with `sqlite-vec` extension

5. **Found existing `knowledge.db`** at the project root (`/home/chad_a_dubiel/projects/ralph-hero/knowledge.db`).

6. **Ran the reindex** by invoking `reindex.js` directly via node from the npx cache:
   ```
   node <npx-cache>/ralph-hero-knowledge-index/dist/reindex.js \
     /home/chad_a_dubiel/projects/ralph-hero/thoughts \
     /home/chad_a_dubiel/projects/ralph-hero/knowledge.db
   ```

## Challenges

- **The npm `bin` entrypoint is the MCP server**, not the reindex script. Running `npx ralph-hero-knowledge-index` starts the MCP server, not the reindexer.
- **No `npm run reindex` available via npx** -- the `reindex` script is defined in `package.json` but npx only exposes the `bin` entry, not npm scripts.
- **Had to locate `reindex.js` in the npx cache** and invoke it directly with `node`. This is fragile because the npx cache path is a hash that can change.
- **No documentation about how to run reindex** was available in the plugin directory or CLAUDE.md. Had to reverse-engineer the process from the npm package metadata and source code.

## Result

```
Indexing /home/chad_a_dubiel/projects/ralph-hero/thoughts -> /home/chad_a_dubiel/projects/ralph-hero/knowledge.db
Found 454 markdown files
dtype not specified for "model". Using the default dtype (fp32) for this device (cpu).
  50/454 indexed
  100/454 indexed
  150/454 indexed
  200/454 indexed
  250/454 indexed
  300/454 indexed
  350/454 indexed
  400/454 indexed
  450/454 indexed
Done. 454 documents indexed.
```

Successfully indexed 454 markdown documents into `knowledge.db` with full-text search and vector embeddings.

## Time & Effort Assessment

- Required ~8 tool calls to investigate and understand the reindex process before being able to run it
- Key friction points: no documented reindex command, bin entrypoint mismatch, npx cache dependency
- A skill could streamline this to a single guided command
