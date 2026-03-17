---
description: Set up Obsidian as the browsing UI for ralph-knowledge documents. Provisions .obsidian/ config, updates .gitignore, and runs reindex with index note generation. Use when users want to browse thoughts/ in Obsidian, set up Obsidian integration, or ask about viewing knowledge documents.
argument-hint: "[thoughts-directory]"
---

# Ralph Knowledge — Obsidian Setup

Configure a `thoughts/` directory as an Obsidian vault with navigational index notes, issue hubs, and Dataview query references.

## Prerequisites

The ralph-knowledge plugin must be installed and working. If `knowledge_search` tool is not available, tell the user to run `/ralph-knowledge:setup` first.

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

Proceed with Obsidian setup?
```

If not found, ask the user for the path.

### Step 2: Provision .obsidian/ config

Check if `[thoughts-dir]/.obsidian/` exists.

**If absent**, create the directory and write these config files:

`[thoughts-dir]/.obsidian/app.json`:
```json
{
  "useMarkdownLinks": false,
  "newLinkFormat": "shortest",
  "showFrontmatter": true
}
```

`[thoughts-dir]/.obsidian/graph.json`:
```json
{
  "colorGroups": [
    { "query": "path:_", "color": { "a": 1, "rgb": 8421504 } },
    { "query": "tag:#research OR type:research", "color": { "a": 1, "rgb": 4474111 } },
    { "query": "tag:#plan OR type:plan", "color": { "a": 1, "rgb": 4487360 } },
    { "query": "tag:#idea OR type:idea", "color": { "a": 1, "rgb": 16761095 } }
  ]
}
```

**If present**, patch conservatively:
- Read existing `app.json`. For each key in our config, only write it if the key does NOT already exist in the user's config. Write the merged result back.
- Read existing `graph.json`. Only add our `colorGroups` entries if `colorGroups` is empty or absent. If the user already has color groups, do not modify them.

Report what was created or patched.

### Step 3: Update .gitignore

Check if `[thoughts-dir]/.gitignore` exists.

**If absent**, create it with:
```
_*.md
_issues/
.obsidian/
```

**If present**, read it and append any missing lines from the list above. Do not duplicate existing entries.

### Step 4: Run reindex

Run reindex using the same mechanism as `/ralph-knowledge:setup`:

```bash
cd /tmp && npm install --no-save ralph-hero-knowledge-index@latest 2>&1 | tail -3
node /tmp/node_modules/ralph-hero-knowledge-index/dist/reindex.js [thoughts-dir] [db-path]
```

The `db-path` defaults to `~/.ralph-hero/knowledge.db` unless `RALPH_KNOWLEDGE_DB` is set.

This will index all documents AND generate the navigational index notes (`_index.md`, `_research.md`, `_plans.md`, `_ideas.md`, `_reviews.md`, `_reports.md`, `_issues/GH-NNNN.md`, `_queries.md`).

Display output as it runs.

### Step 5: Verify

Check that generated files exist:

```bash
ls [thoughts-dir]/_index.md [thoughts-dir]/_research.md [thoughts-dir]/_queries.md [thoughts-dir]/_issues/ 2>/dev/null
```

If files exist, setup is complete. If not, check for errors in the reindex output.

### Step 6: Summary

```
Obsidian Vault Ready
====================
Thoughts directory: [thoughts-dir]
Generated indexes: _index.md, _research.md, _plans.md, _ideas.md, _reviews.md, _reports.md
Issue hubs: _issues/ ([N] issues)
Query reference: _queries.md

Next steps:
1. Open Obsidian → "Open folder as vault" → select [thoughts-dir]
2. Install Dataview: Settings → Community Plugins → Browse → search "Dataview" → Install → Enable
3. Start with _index.md for navigation

To regenerate after adding new documents:
  /ralph-knowledge:setup [thoughts-dir]
```
