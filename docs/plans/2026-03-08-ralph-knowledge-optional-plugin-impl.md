# ralph-knowledge Optional Plugin Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extract knowledge-index into a standalone optional plugin and add "if available" knowledge tool integration to ralph-hero's agents and skills.

**Architecture:** Move `plugin/ralph-hero/knowledge-index/` to `plugin/ralph-knowledge/` with its own plugin manifest and MCP config. Enhance thoughts-locator and 5 Tier 1 skills with best-effort knowledge tool usage that falls back to existing grep/glob behavior.

**Tech Stack:** Markdown skill/agent files, JSON plugin config, shell commands for file moves

**Design doc:** `docs/plans/2026-03-08-ralph-knowledge-optional-plugin-design.md`

---

## Part 1: Plugin Extraction

### Task 1: Move knowledge-index to plugin/ralph-knowledge/

Move the entire knowledge-index directory to its new plugin location.

**Files:**
- Move: `plugin/ralph-hero/knowledge-index/` → `plugin/ralph-knowledge/`

**Step 1: Create the target directory and move files**

```bash
mkdir -p plugin/ralph-knowledge
git mv plugin/ralph-hero/knowledge-index/* plugin/ralph-knowledge/
git mv plugin/ralph-hero/knowledge-index/.gitignore plugin/ralph-knowledge/
rmdir plugin/ralph-hero/knowledge-index
```

**Step 2: Verify the move**

Run: `ls plugin/ralph-knowledge/src/`
Expected: `__tests__  db.ts  embedder.ts  hybrid-search.ts  index.ts  parser.ts  reindex.ts  search.ts  traverse.ts  vector-search.ts`

Run: `ls plugin/ralph-knowledge/package.json plugin/ralph-knowledge/tsconfig.json plugin/ralph-knowledge/.gitignore`
Expected: All three files present

**Step 3: Verify build still works**

Run: `cd plugin/ralph-knowledge && npm run build`
Expected: Compiles with no errors

**Step 4: Verify tests still pass**

Run: `cd plugin/ralph-knowledge && npm test`
Expected: 34 tests pass across 7 suites

**Step 5: Commit**

```bash
git add -A
git commit -m "refactor(knowledge): move knowledge-index to plugin/ralph-knowledge/"
```

---

### Task 2: Create plugin manifest and MCP config

Create the `.claude-plugin/plugin.json` manifest and `.mcp.json` for the standalone plugin.

**Files:**
- Create: `plugin/ralph-knowledge/.claude-plugin/plugin.json`
- Create: `plugin/ralph-knowledge/.mcp.json`

**Step 1: Create plugin manifest**

```bash
mkdir -p plugin/ralph-knowledge/.claude-plugin
```

Create `plugin/ralph-knowledge/.claude-plugin/plugin.json`:

```json
{
  "name": "ralph-knowledge",
  "version": "0.1.0",
  "description": "Knowledge graph for ralph-hero: semantic search, relationship traversal, and document indexing across thoughts/ documents. Optional companion to ralph-hero.",
  "author": {
    "name": "Chad Dubiel",
    "url": "https://github.com/cdubiel08"
  },
  "homepage": "https://github.com/cdubiel08/ralph-hero",
  "repository": "https://github.com/cdubiel08/ralph-hero",
  "license": "MIT",
  "keywords": [
    "knowledge-graph",
    "semantic-search",
    "obsidian",
    "ralph-hero",
    "document-indexing",
    "fts5",
    "embeddings"
  ]
}
```

**Step 2: Create MCP server config**

Create `plugin/ralph-knowledge/.mcp.json`:

```json
{
  "mcpServers": {
    "ralph-knowledge": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/dist/index.js"],
      "env": {
        "RALPH_KNOWLEDGE_DB": "${CLAUDE_PLUGIN_ROOT}/knowledge.db"
      }
    }
  }
}
```

Note: paths changed from `knowledge-index/dist/index.js` to `dist/index.js` because `CLAUDE_PLUGIN_ROOT` now points directly at `plugin/ralph-knowledge/`.

**Step 3: Test MCP server starts from new config**

Run: `cd plugin/ralph-knowledge && npm run build`

Run: `echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0.1"}}}' | RALPH_KNOWLEDGE_DB=":memory:" node plugin/ralph-knowledge/dist/index.js`
Expected: JSON response with server capabilities

**Step 4: Commit**

```bash
git add plugin/ralph-knowledge/.claude-plugin/plugin.json plugin/ralph-knowledge/.mcp.json
git commit -m "feat(knowledge): add plugin manifest and MCP config for standalone plugin"
```

---

### Task 3: Remove ralph-knowledge from ralph-hero's .mcp.json

Revert ralph-hero's `.mcp.json` to only contain the ralph-github server.

**Files:**
- Modify: `plugin/ralph-hero/.mcp.json`

**Step 1: Read the current file**

Read `plugin/ralph-hero/.mcp.json` to confirm current state.

**Step 2: Remove the ralph-knowledge server entry**

Edit `plugin/ralph-hero/.mcp.json` to remove the entire `ralph-knowledge` block, leaving only:

```json
{
  "mcpServers": {
    "ralph-github": {
      "command": "npx",
      "args": ["-y", "ralph-hero-mcp-server@2.5.4"],
      "cwd": "${CLAUDE_PLUGIN_ROOT}",
      "env": {
        "RALPH_GH_OWNER": "${RALPH_GH_OWNER:-cdubiel08}",
        "RALPH_GH_REPO": "${RALPH_GH_REPO:-ralph-hero}",
        "RALPH_GH_PROJECT_NUMBER": "${RALPH_GH_PROJECT_NUMBER:-3}"
      }
    }
  }
}
```

**Step 3: Commit**

```bash
git add plugin/ralph-hero/.mcp.json
git commit -m "fix(plugin): remove ralph-knowledge from ralph-hero .mcp.json — now a separate plugin"
```

---

### Task 4: Update marketplace.json

Add ralph-knowledge to the marketplace catalog so users can install it independently.

**Files:**
- Modify: `.claude-plugin/marketplace.json`

**Step 1: Read the current marketplace.json**

Read `.claude-plugin/marketplace.json` to see the current plugin list.

**Step 2: Add ralph-knowledge entry**

The current file has a `plugins` array with one entry (ralph-hero). Add ralph-knowledge as a second entry:

```json
{
  "name": "ralph-hero",
  "metadata": {
    "description": "Autonomous workflow plugins for GitHub Projects V2"
  },
  "owner": {
    "name": "Chad Dubiel"
  },
  "plugins": [
    {
      "name": "ralph-hero",
      "description": "The naive hero picks tickets, does their best work, and moves on. Autonomous triage, research, planning, and implementation with GitHub Projects V2.",
      "source": "./plugin/ralph-hero"
    },
    {
      "name": "ralph-knowledge",
      "description": "Knowledge graph for ralph-hero: semantic search, relationship traversal, and document indexing across thoughts/ documents. Optional companion to ralph-hero.",
      "source": "./plugin/ralph-knowledge"
    }
  ]
}
```

**Step 3: Commit**

```bash
git add .claude-plugin/marketplace.json
git commit -m "feat(marketplace): add ralph-knowledge as independently installable plugin"
```

---

## Part 2: Agent & Skill Enhancements

### Task 5: Enhance thoughts-locator with knowledge tool integration

Add "if available, use knowledge tools; else grep" pattern to the thoughts-locator agent. This is Tier 2 — calling skills (ralph-research, form, research, plan) benefit transparently without any changes.

**Files:**
- Modify: `plugin/ralph-hero/agents/thoughts-locator.md`

**Step 1: Read the current file**

Read `plugin/ralph-hero/agents/thoughts-locator.md` to find the Search Strategy section and the Relationship Discovery section.

**Step 2: Add knowledge tool integration to Search Strategy**

After the existing "### Search Patterns" section (after line 52), insert a new section:

```markdown
### Knowledge Graph (when available)

If `knowledge_search` or `knowledge_traverse` MCP tools are available (from the ralph-knowledge plugin), prefer them for discovery:

1. **Semantic search**: `knowledge_search(query="[search topic]")` returns ranked documents with relevance scores and snippets. Use this FIRST for topic-based searches — it finds conceptually related documents even when exact keywords differ.

2. **Relationship traversal**: `knowledge_traverse(from="[document-id]", direction="incoming")` returns all documents that `builds_on` or have `tensions` with a given document. Use this to map the knowledge web around a document.

3. **Fall back to grep/glob** if the knowledge tools are not available or return no results. The grep-based patterns below always work without any index.
```

**Step 3: Update the Relationship Discovery section header**

Change the section at line 106 from:

```markdown
## Relationship Discovery (grep-based)
```

to:

```markdown
## Relationship Discovery

### Via knowledge tools (preferred, when available)

Use `knowledge_traverse` for typed relationship walking:
- `knowledge_traverse(from="[doc-id]", type="builds_on", direction="incoming")` — find what builds on this document
- `knowledge_traverse(from="[doc-id]", type="tensions", direction="incoming")` — find what has tensions with this document
- `knowledge_traverse(from="[doc-id]", direction="outgoing")` — find what this document builds on

### Via grep (fallback, always works)
```

**Step 4: Remove the old Note at line 130**

Remove the line:
```markdown
> **Note:** These patterns work without any index. When the `knowledge_search` or `knowledge_traverse` MCP tools are available, prefer those for faster and semantic results — fall back to grep when they are not.
```

This guidance is now integrated into the structured sections above.

**Step 5: Commit**

```bash
git add plugin/ralph-hero/agents/thoughts-locator.md
git commit -m "feat(thoughts-locator): add knowledge tool integration with grep fallback"
```

---

### Task 6: Add knowledge_search to artifact discovery in Tier 1 skills

Add a `knowledge_search` shortcut step BEFORE the existing Artifact Comment Protocol chain in 5 skills. The existing comment→glob→self-heal chain remains as the fallback.

**Files:**
- Modify: `plugin/ralph-hero/skills/ralph-plan/SKILL.md`
- Modify: `plugin/ralph-hero/skills/plan/SKILL.md`
- Modify: `plugin/ralph-hero/skills/ralph-impl/SKILL.md`
- Modify: `plugin/ralph-hero/skills/ralph-review/SKILL.md`
- Modify: `plugin/ralph-hero/skills/iterate/SKILL.md`

The same block of text is inserted into each skill. The wording varies slightly based on whether the skill looks for a **research document** or an **implementation plan**.

**Step 1: Read each skill file**

Read all 5 files to find the exact artifact discovery section in each.

**Step 2: Add knowledge_search shortcut to ralph-plan/SKILL.md**

In `plugin/ralph-hero/skills/ralph-plan/SKILL.md`, insert BEFORE the existing "Artifact shortcut" line (the first line of the artifact discovery chain):

```markdown
   **Knowledge graph shortcut**: If `knowledge_search` is available, try it first:
   ```
   knowledge_search(query="research GH-${number} [issue title keywords]", type="research", limit=3)
   ```
   If a high-relevance result is returned, read that file directly and skip steps 1-7 below. If `knowledge_search` is not available or returns no results, continue with standard Artifact Comment Protocol discovery below.

```

**Step 3: Add knowledge_search shortcut to plan/SKILL.md**

In `plugin/ralph-hero/skills/plan/SKILL.md`, insert BEFORE step 2 ("If a `#NNN` issue was provided"):

```markdown
   **Knowledge graph shortcut**: If `knowledge_search` is available, try it first to find related research:
   ```
   knowledge_search(query="research [topic keywords]", type="research", limit=5)
   ```
   If results are returned, read the top matches for context. This supplements (not replaces) the issue comment check and thoughts-locator search below.

```

**Step 4: Add knowledge_search shortcut to ralph-impl/SKILL.md**

In `plugin/ralph-hero/skills/ralph-impl/SKILL.md`, insert BEFORE the existing "Artifact shortcut" line:

```markdown
   **Knowledge graph shortcut**: If `knowledge_search` is available, try it first:
   ```
   knowledge_search(query="implementation plan GH-${number} [issue title keywords]", type="plan", limit=3)
   ```
   If a high-relevance result is returned, read that file directly and skip steps 1-8 below. If `knowledge_search` is not available or returns no results, continue with standard Artifact Comment Protocol discovery below.

```

**Step 5: Add knowledge_search shortcut to ralph-review/SKILL.md**

In `plugin/ralph-hero/skills/ralph-review/SKILL.md`, insert BEFORE the existing "Artifact shortcut" line. Use the exact same text as ralph-impl (Step 4) — both look for implementation plans.

**Step 6: Add knowledge_search shortcut to iterate/SKILL.md**

In `plugin/ralph-hero/skills/iterate/SKILL.md`, insert BEFORE step 1 ("Query GitHub for the issue"):

```markdown
   **Knowledge graph shortcut**: If `knowledge_search` is available, try it first:
   ```
   knowledge_search(query="implementation plan GH-${number}", type="plan", limit=3)
   ```
   If a high-relevance result is returned, read that file directly and skip steps 1-8 below. If `knowledge_search` is not available or returns no results, continue with standard discovery below.

```

**Step 7: Commit**

```bash
git add plugin/ralph-hero/skills/ralph-plan/SKILL.md plugin/ralph-hero/skills/plan/SKILL.md plugin/ralph-hero/skills/ralph-impl/SKILL.md plugin/ralph-hero/skills/ralph-review/SKILL.md plugin/ralph-hero/skills/iterate/SKILL.md
git commit -m "feat(skills): add knowledge_search shortcut to artifact discovery in 5 skills"
```

---

### Task 7: Add optional dedup checks to Tier 3 skills

Add lightweight `knowledge_search` dedup checks to draft and ralph-triage skills when available.

**Files:**
- Modify: `plugin/ralph-hero/skills/draft/SKILL.md`
- Modify: `plugin/ralph-hero/skills/ralph-triage/SKILL.md`

**Step 1: Read each skill file**

Read both files to find the insertion points.

**Step 2: Add dedup check to draft/SKILL.md**

In `plugin/ralph-hero/skills/draft/SKILL.md`, find the "### Step 2: Light Research (Optional)" section. Insert AFTER that section:

```markdown
### Step 2b: Dedup Check (Optional)

If `knowledge_search` is available, check for existing similar ideas:
```
knowledge_search(query="[idea topic summary]", type="idea", limit=3)
```
If a close match is found, mention it to the user: "There's an existing idea that may overlap: `[path]` — [title]. Want to continue with a new idea or build on that one?"

If `knowledge_search` is not available, skip this step.
```

**Step 3: Add knowledge context to ralph-triage/SKILL.md**

In `plugin/ralph-hero/skills/ralph-triage/SKILL.md`, find the "### Step 7: Find and Link Related Issues" section. Insert BEFORE step 1 ("Query candidate issues"):

```markdown
   **Knowledge context (optional)**: If `knowledge_search` is available, search for related research documents before querying issues:
   ```
   knowledge_search(query="[issue title and key concepts]", limit=5)
   ```
   Use any returned documents as additional context when analyzing relatedness in step 2. This helps surface conceptual relationships that aren't visible from issue titles alone.

```

**Step 4: Commit**

```bash
git add plugin/ralph-hero/skills/draft/SKILL.md plugin/ralph-hero/skills/ralph-triage/SKILL.md
git commit -m "feat(skills): add optional knowledge_search dedup to draft and triage"
```

---

### Task 8: Update reindex.ts default path

The reindex script's default `thoughtsDir` path needs to change because the script moved from `plugin/ralph-hero/knowledge-index/` to `plugin/ralph-knowledge/`.

**Files:**
- Modify: `plugin/ralph-knowledge/src/reindex.ts`

**Step 1: Read the current file**

Read `plugin/ralph-knowledge/src/reindex.ts` to find the default path on the last few lines.

**Step 2: Update the default path**

The script moved up one directory level. The current default is `"../../../thoughts"` (from `plugin/ralph-hero/knowledge-index/`). From `plugin/ralph-knowledge/`, the correct path is `"../../thoughts"`.

Change line 87:
```typescript
const thoughtsDir = process.argv[2] ?? "../../../thoughts";
```
to:
```typescript
const thoughtsDir = process.argv[2] ?? "../../thoughts";
```

**Step 3: Verify build**

Run: `cd plugin/ralph-knowledge && npm run build`
Expected: Compiles

**Step 4: Verify tests still pass**

Run: `cd plugin/ralph-knowledge && npm test`
Expected: 34 tests pass

**Step 5: Commit**

```bash
git add plugin/ralph-knowledge/src/reindex.ts
git commit -m "fix(knowledge): update reindex default path after plugin directory move"
```

---

## Task Summary

| Task | Description | Type |
|------|-------------|------|
| 1 | Move knowledge-index to plugin/ralph-knowledge/ | File move |
| 2 | Create plugin manifest and MCP config | New files |
| 3 | Remove ralph-knowledge from ralph-hero .mcp.json | Edit |
| 4 | Update marketplace.json | Edit |
| 5 | Enhance thoughts-locator with knowledge tool integration | Tier 2 |
| 6 | Add knowledge_search to 5 Tier 1 skills | Tier 1 |
| 7 | Add optional dedup to draft and triage | Tier 3 |
| 8 | Update reindex.ts default path | Bug fix |
