---
date: 2026-03-10
status: draft
type: plan
tags: [ralph-knowledge, reindex, configuration]
---

# Multi-Directory Knowledge Index Implementation Plan

## Prior Work

- builds_on:: [[2026-03-08-ralph-knowledge-optional-plugin-design]]
- builds_on:: [[2026-03-08-knowledge-graph-design]]

## Overview

Make the ralph-knowledge reindex script accept multiple directories via the `RALPH_KNOWLEDGE_DIRS` environment variable (comma-separated). Users can index `thoughts/`, `docs/plans/`, or any custom directories in a single index. Falls back to CLI arg, then to default `thoughts/`.

## Current State Analysis

- `reindex.ts` accepts a single directory via `process.argv[2]` with default `../../thoughts`
- The setup skill (`plugin/ralph-knowledge/skills/setup/SKILL.md`) locates a single `thoughts/` directory
- Users configure ralph env vars in `.claude/settings.local.json`

## Desired End State

- `RALPH_KNOWLEDGE_DIRS=thoughts,docs/plans,docs/adr` in settings indexes all three directories
- The setup skill asks if users want to add directories beyond `thoughts/`
- Reindex merges files from all directories into one unified index
- CLI still works: `npm run reindex -- thoughts docs/plans`

### Key Decisions:
- Paths are resolved relative to the CWD of the reindex process
- The env var uses comma separation (consistent with `RALPH_GH_PROJECT_NUMBERS`)
- CLI args override the env var (explicit > implicit)

## What We're NOT Doing

- No config file (`.ralph-knowledge.yml`) — env var is sufficient
- No auto-discovery of directories — user explicitly opts in
- No per-directory filtering or type inference — all dirs treated equally

## Phase 1: Multi-directory reindex.ts

### Overview
Update the reindex script to accept multiple directories from env var or CLI args.

### Changes Required:

#### 1. Update reindex.ts
**File**: `plugin/ralph-knowledge/src/reindex.ts`

Change the CLI entrypoint from single-dir to multi-dir:

```typescript
// OLD:
const thoughtsDir = process.argv[2] ?? "../../thoughts";
const dbPath = process.argv[3] ?? "knowledge.db";
reindex(thoughtsDir, dbPath).catch(console.error);

// NEW:
function resolveDirs(): { dirs: string[]; dbPath: string } {
  const cliDirs = process.argv.slice(2).filter(a => !a.endsWith(".db"));
  const cliDb = process.argv.slice(2).find(a => a.endsWith(".db"));

  if (cliDirs.length > 0) {
    return { dirs: cliDirs, dbPath: cliDb ?? "knowledge.db" };
  }

  const envDirs = process.env.RALPH_KNOWLEDGE_DIRS;
  if (envDirs) {
    return {
      dirs: envDirs.split(",").map(d => d.trim()).filter(Boolean),
      dbPath: cliDb ?? process.env.RALPH_KNOWLEDGE_DB ?? "knowledge.db",
    };
  }

  return { dirs: ["../../thoughts"], dbPath: cliDb ?? "knowledge.db" };
}
```

Update the `reindex` function signature to accept `dirs: string[]`:

```typescript
async function reindex(dirs: string[], dbPath: string): Promise<void> {
  console.log(`Indexing ${dirs.join(", ")} -> ${dbPath}`);
  // ... setup db, fts, vec ...

  const files: string[] = [];
  for (const dir of dirs) {
    const found = findMarkdownFiles(dir);
    console.log(`  ${dir}: ${found.length} files`);
    files.push(...found);
  }
  console.log(`Found ${files.length} total markdown files`);

  // ... rest unchanged, but relPath needs to handle multiple base dirs ...
}
```

For `relPath` computation, use the directory that contains the file as the base:

```typescript
// OLD:
const relPath = relative(join(thoughtsDir, ".."), filePath);

// NEW: find which source dir this file came from
const sourceDir = dirs.find(d => filePath.startsWith(resolve(d)));
const relPath = sourceDir ? relative(resolve(sourceDir, ".."), filePath) : filePath;
```

Add `import { resolve } from "node:path"` to the imports.

### Success Criteria:

#### Automated Verification:
- [ ] Build passes: `cd plugin/ralph-knowledge && npm run build`
- [ ] Tests pass: `npm test`
- [ ] CLI with multiple dirs works: `node dist/reindex.js ../../thoughts ../../docs/plans knowledge.db`
- [ ] Env var works: `RALPH_KNOWLEDGE_DIRS=../../thoughts,../../docs/plans node dist/reindex.js`

---

## Phase 2: Update setup skill

### Overview
Update the setup skill to ask about additional directories and persist to `RALPH_KNOWLEDGE_DIRS`.

### Changes Required:

#### 1. Update setup skill
**File**: `plugin/ralph-knowledge/skills/setup/SKILL.md`

After Step 1 (locate thoughts directory), add a new step:

```markdown
### Step 1b: Ask about additional directories

After confirming the thoughts directory, ask:

\```
Would you like to index additional directories? Common choices:
- docs/plans/
- docs/adr/
- docs/

Enter comma-separated paths relative to the project root, or press Enter to skip:
\```

If the user provides additional directories, validate each exists. Combine with the thoughts directory into a single list.

Set `RALPH_KNOWLEDGE_DIRS` for the reindex step:

\```bash
export RALPH_KNOWLEDGE_DIRS="thoughts,docs/plans"
\```

Optionally suggest persisting to settings:

\```
To persist this configuration, add to .claude/settings.local.json:
{
  "env": {
    "RALPH_KNOWLEDGE_DIRS": "thoughts,docs/plans"
  }
}
\```
```

Update Step 3 to pass multiple dirs to the reindex script:

```markdown
### Step 3: Install and run reindex

Pass all directories as CLI arguments:

\```bash
node /tmp/node_modules/ralph-hero-knowledge-index/dist/reindex.js [dir1] [dir2] [db-path]
\```
```

Update Step 5 summary to show all indexed directories.

### Success Criteria:

#### Manual Verification:
- [ ] Setup skill prompts for additional directories
- [ ] Reindex includes files from all specified directories
- [ ] Summary shows all indexed directories

---

## Phase 3: Test coverage

### Overview
Add a test for multi-directory reindex behavior.

### Changes Required:

#### 1. Add reindex test
**File**: `plugin/ralph-knowledge/src/__tests__/reindex.test.ts`

Test the `findMarkdownFiles` and `resolveDirs` functions. Export them from reindex.ts for testing.

```typescript
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findMarkdownFiles } from "../reindex.js";

describe("findMarkdownFiles", () => {
  it("finds .md files recursively", () => {
    const dir = mkdtempSync(join(tmpdir(), "knowledge-test-"));
    writeFileSync(join(dir, "a.md"), "# A");
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "b.md"), "# B");
    writeFileSync(join(dir, "c.txt"), "not markdown");

    const files = findMarkdownFiles(dir);
    expect(files).toHaveLength(2);
    expect(files.every(f => f.endsWith(".md"))).toBe(true);
  });

  it("skips dot-directories", () => {
    const dir = mkdtempSync(join(tmpdir(), "knowledge-test-"));
    mkdirSync(join(dir, ".hidden"));
    writeFileSync(join(dir, ".hidden", "secret.md"), "# Hidden");
    writeFileSync(join(dir, "visible.md"), "# Visible");

    const files = findMarkdownFiles(dir);
    expect(files).toHaveLength(1);
  });
});
```

### Success Criteria:

#### Automated Verification:
- [ ] All tests pass: `npm test`
- [ ] Build passes: `npm run build`

---

## Testing Strategy

### Unit Tests:
- `findMarkdownFiles` with multiple directories
- `resolveDirs` with CLI args, env var, and defaults

### Integration Tests:
- Reindex across two temp directories produces merged index
- Documents from both dirs are searchable

### Manual Testing Steps:
1. Set `RALPH_KNOWLEDGE_DIRS=thoughts,docs/plans` in settings.local.json
2. Run `/ralph-knowledge:setup`
3. Verify `knowledge_search` returns results from both directories

## References

- Design doc: `docs/plans/2026-03-08-ralph-knowledge-optional-plugin-design.md`
- Existing reindex: `plugin/ralph-knowledge/src/reindex.ts` (on `worktree-knowledge-graph` branch)
- Setup skill: `plugin/ralph-knowledge/skills/setup/SKILL.md`
