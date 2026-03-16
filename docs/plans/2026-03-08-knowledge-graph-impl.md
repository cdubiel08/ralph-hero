# Knowledge Graph Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Two-part implementation: (1) add a typed relationship document protocol innate to ralph-hero (Prior Work sections, tags, wikilinks), and (2) an optional knowledge-index plugin with semantic search and graph traversal via MCP tools.

**Architecture:** The document protocol (Part A) changes skill templates and the thoughts-locator agent — no new dependencies. The knowledge-index plugin (Part B) is a separate MCP server with SQLite + FTS5 + sqlite-vec + embeddings.

**Tech Stack:** Part A: markdown conventions only. Part B: TypeScript, better-sqlite3, sqlite-vec, @huggingface/transformers (Xenova/all-MiniLM-L6-v2), @modelcontextprotocol/sdk, zod, vitest

**Design doc:** `docs/plans/2026-03-08-knowledge-graph-design.md`

---

## Part A: Innate Document Protocol (ralph-hero core)

These changes ship with ralph-hero itself. No new dependencies. The relationship graph exists in the markdown files and is discoverable via grep/glob.

### Task A1: Update ralph-research Skill Template

**Files:**
- Modify: `plugin/ralph-hero/skills/ralph-research/SKILL.md`

**Step 1: Read the current skill template**

Read `plugin/ralph-hero/skills/ralph-research/SKILL.md` to find the frontmatter template and required sections.

**Step 2: Add `tags:` to required frontmatter**

In the Step 6 frontmatter template (around line 115), add `tags:`:

```yaml
---
date: YYYY-MM-DD
github_issue: NNN
github_url: https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/issues/NNN
status: complete
type: research
tags: [topic1, topic2]
---
```

Add instruction: "Include 2-5 tags describing the key concepts (e.g., caching, auth, mcp-server, performance). Use lowercase, hyphenated terms. Reuse existing tags from prior documents when applicable."

**Step 3: Add `## Prior Work` as a required section**

In the required sections list (around line 126), add `## Prior Work` as the first section after the title. Add instruction:

```markdown
## Prior Work

After the title and before Problem Statement, include a Prior Work section listing documents that informed this research. Use Obsidian Dataview syntax:

- `builds_on::` for documents this research extends or was informed by
- `tensions::` for documents whose conclusions conflict with findings here

Example:
```
## Prior Work

- builds_on:: [[2026-02-28-GH-0460-cache-invalidation-research]]
- tensions:: [[2026-02-25-GH-0390-aggressive-caching-plan]]
```

Populate from thoughts-locator results gathered in Step 4. If no relevant prior work exists, include the section with "None identified." Use filenames without extension.
```

**Step 4: Commit**

```bash
git add plugin/ralph-hero/skills/ralph-research/SKILL.md
git commit -m "feat(protocol): add tags and Prior Work section to ralph-research template"
```

---

### Task A2: Update ralph-plan Skill Template

**Files:**
- Modify: `plugin/ralph-hero/skills/ralph-plan/SKILL.md`

**Step 1: Read the current skill template**

Read `plugin/ralph-hero/skills/ralph-plan/SKILL.md` to find the frontmatter template and required sections.

**Step 2: Add `tags:` to required frontmatter**

In the Step 5 frontmatter template (around line 168), add `tags:`:

```yaml
---
date: YYYY-MM-DD
status: draft
github_issues: [123, 124, 125]
github_urls:
  - https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/issues/123
primary_issue: 123
tags: [topic1, topic2]
---
```

Same tagging instruction as research.

**Step 3: Add `## Prior Work` as a required section**

Add after the title, before Overview:

```markdown
## Prior Work

- builds_on:: [[2026-03-04-GH-0516-create-issue-status-sync-fix]]
- tensions:: [[2026-02-25-GH-0390-aggressive-caching-plan]]

Populate from research documents discovered in Step 3 and any related plans found during context gathering. Use filenames without extension.
```

**Step 4: Commit**

```bash
git add plugin/ralph-hero/skills/ralph-plan/SKILL.md
git commit -m "feat(protocol): add tags and Prior Work section to ralph-plan template"
```

---

### Task A3: Enhance thoughts-locator for Relationship Discovery

**Files:**
- Modify: `plugin/ralph-hero/agents/thoughts-locator.md`

**Step 1: Read the current agent definition**

Read `plugin/ralph-hero/agents/thoughts-locator.md`.

**Step 2: Add relationship-aware discovery**

Add a section for discovering documents via wikilink relationships (grep-based, no index):

```markdown
## Relationship Discovery (grep-based)

When asked about what relates to a specific document, you can trace relationships:

### Find what builds on a document
```bash
grep -rl "builds_on.*\[\[TARGET_FILENAME\]\]" thoughts/shared/
```

### Find what has tensions with a document
```bash
grep -rl "tensions.*\[\[TARGET_FILENAME\]\]" thoughts/shared/
```

### Find what a document builds on
```bash
grep "builds_on.*\[\[" thoughts/shared/TYPE/TARGET_FILENAME.md
```

### Find superseded documents
```bash
grep -rl "superseded_by" thoughts/shared/ | head -20
```

These patterns work without any index. When the `knowledge_search` or `knowledge_traverse` MCP tools are available, prefer those for faster and semantic results — fall back to grep when they are not.
```

**Step 3: Commit**

```bash
git add plugin/ralph-hero/agents/thoughts-locator.md
git commit -m "feat(protocol): add grep-based relationship discovery to thoughts-locator"
```

---

## Part B: Knowledge-Index Plugin (optional)

Everything below is an optional plugin. Ralph-hero works without it — it just adds semantic search and graph traversal MCP tools.

### Task B1: Project Scaffold

**Files:**
- Create: `plugin/ralph-hero/knowledge-index/package.json`
- Create: `plugin/ralph-hero/knowledge-index/tsconfig.json`
- Create: `plugin/ralph-hero/knowledge-index/src/index.ts` (empty entrypoint)

**Step 1: Create directory and package.json**

```bash
mkdir -p plugin/ralph-hero/knowledge-index/src
```

```json
{
  "name": "ralph-hero-knowledge-index",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "reindex": "node dist/reindex.js",
    "test": "vitest run"
  },
  "dependencies": {
    "@huggingface/transformers": "^3.0.0",
    "@modelcontextprotocol/sdk": "^1.26.0",
    "better-sqlite3": "^12.6.0",
    "sqlite-vec": "^0.1.7-alpha.10",
    "yaml": "^2.7.0",
    "zod": "^3.25.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.13",
    "@types/node": "^22.0.0",
    "typescript": "^5.7.0",
    "vitest": "^4.0.0"
  }
}
```

**Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "sourceMap": true,
    "declaration": true,
    "skipLibCheck": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist", "src/__tests__"]
}
```

**Step 3: Create empty entrypoint**

```typescript
// src/index.ts
// Knowledge index MCP server — entrypoint
```

**Step 4: Install dependencies**

Run: `cd plugin/ralph-hero/knowledge-index && npm install`

**Step 5: Verify build**

Run: `npm run build`
Expected: Compiles with no errors, creates `dist/index.js`

**Step 6: Commit**

```bash
git add plugin/ralph-hero/knowledge-index/
git commit -m "feat(knowledge): scaffold knowledge-index MCP server"
```

---

### Task B2: Markdown Parser

Parse YAML frontmatter, title, `## Prior Work` wikilinks, and `superseded_by` from markdown files.

**Files:**
- Create: `plugin/ralph-hero/knowledge-index/src/parser.ts`
- Create: `plugin/ralph-hero/knowledge-index/src/__tests__/parser.test.ts`

**Step 1: Write the failing tests**

```typescript
// src/__tests__/parser.test.ts
import { describe, it, expect } from "vitest";
import { parseDocument } from "../parser.js";

const FULL_DOC = `---
date: 2026-03-08
github_issue: 560
status: draft
type: research
tags: [caching, mcp-server, performance]
---

# GH-560: Response Cache TTL Strategy

## Prior Work

- builds_on:: [[2026-02-28-GH-0460-cache-invalidation-research]]
- builds_on:: [[2026-03-01-GH-0480-session-cache-architecture]]
- tensions:: [[2026-02-25-GH-0390-aggressive-caching-plan]]

## Problem Statement

The current cache has no TTL configuration.
`;

const SUPERSEDED_DOC = `---
date: 2026-02-20
github_issue: 200
status: superseded
type: plan
tags: [caching]
superseded_by: "[[2026-03-08-GH-0560-cache-ttl]]"
---

# GH-200: Old Caching Strategy

Some old content.
`;

const MINIMAL_DOC = `---
date: 2026-03-01
type: idea
---

# A Simple Idea

No prior work section.
`;

describe("parseDocument", () => {
  it("parses frontmatter fields", () => {
    const doc = parseDocument("2026-03-08-GH-0560-cache-ttl", "thoughts/shared/research/2026-03-08-GH-0560-cache-ttl.md", FULL_DOC);
    expect(doc.id).toBe("2026-03-08-GH-0560-cache-ttl");
    expect(doc.path).toBe("thoughts/shared/research/2026-03-08-GH-0560-cache-ttl.md");
    expect(doc.date).toBe("2026-03-08");
    expect(doc.type).toBe("research");
    expect(doc.status).toBe("draft");
    expect(doc.githubIssue).toBe(560);
    expect(doc.tags).toEqual(["caching", "mcp-server", "performance"]);
  });

  it("extracts title from first heading", () => {
    const doc = parseDocument("test", "test.md", FULL_DOC);
    expect(doc.title).toBe("GH-560: Response Cache TTL Strategy");
  });

  it("extracts builds_on relationships from Prior Work", () => {
    const doc = parseDocument("test", "test.md", FULL_DOC);
    const buildsOn = doc.relationships.filter(r => r.type === "builds_on");
    expect(buildsOn).toHaveLength(2);
    expect(buildsOn[0].targetId).toBe("2026-02-28-GH-0460-cache-invalidation-research");
    expect(buildsOn[1].targetId).toBe("2026-03-01-GH-0480-session-cache-architecture");
  });

  it("extracts tensions relationships from Prior Work", () => {
    const doc = parseDocument("test", "test.md", FULL_DOC);
    const tensions = doc.relationships.filter(r => r.type === "tensions");
    expect(tensions).toHaveLength(1);
    expect(tensions[0].targetId).toBe("2026-02-25-GH-0390-aggressive-caching-plan");
  });

  it("extracts superseded_by from frontmatter", () => {
    const doc = parseDocument("test", "test.md", SUPERSEDED_DOC);
    const superseded = doc.relationships.filter(r => r.type === "superseded_by");
    expect(superseded).toHaveLength(1);
    expect(superseded[0].targetId).toBe("2026-03-08-GH-0560-cache-ttl");
  });

  it("handles documents with no Prior Work section", () => {
    const doc = parseDocument("test", "test.md", MINIMAL_DOC);
    expect(doc.relationships).toEqual([]);
    expect(doc.tags).toEqual([]);
    expect(doc.title).toBe("A Simple Idea");
  });

  it("extracts content body for FTS indexing", () => {
    const doc = parseDocument("test", "test.md", FULL_DOC);
    expect(doc.content).toContain("current cache has no TTL");
    expect(doc.content).not.toContain("---"); // no frontmatter fences
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd plugin/ralph-hero/knowledge-index && npx vitest run src/__tests__/parser.test.ts`
Expected: FAIL — `parseDocument` not found

**Step 3: Implement the parser**

```typescript
// src/parser.ts
import { parse as parseYaml } from "yaml";

export interface Relationship {
  sourceId: string;
  targetId: string;
  type: "builds_on" | "tensions" | "superseded_by";
}

export interface ParsedDocument {
  id: string;
  path: string;
  title: string;
  date: string | null;
  type: string | null;
  status: string | null;
  githubIssue: number | null;
  tags: string[];
  relationships: Relationship[];
  content: string;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;
const TITLE_RE = /^# (.+)$/m;
const WIKILINK_REL_RE = /^- (builds_on|tensions):: \[\[(.+?)\]\]/gm;
const SUPERSEDED_BY_RE = /\[\[(.+?)\]\]/;

export function parseDocument(id: string, path: string, raw: string): ParsedDocument {
  // Parse frontmatter
  const fmMatch = raw.match(FRONTMATTER_RE);
  const frontmatter = fmMatch ? parseYaml(fmMatch[1]) ?? {} : {};

  // Strip frontmatter from content
  const body = fmMatch ? raw.slice(fmMatch[0].length).trim() : raw.trim();

  // Extract title
  const titleMatch = body.match(TITLE_RE);
  const title = titleMatch ? titleMatch[1].trim() : id;

  // Extract relationships from ## Prior Work section
  const relationships: Relationship[] = [];

  let match: RegExpExecArray | null;
  const relRe = new RegExp(WIKILINK_REL_RE.source, "gm");
  while ((match = relRe.exec(body)) !== null) {
    relationships.push({
      sourceId: id,
      targetId: match[2],
      type: match[1] as "builds_on" | "tensions",
    });
  }

  // Extract superseded_by from frontmatter
  const supersededBy = frontmatter.superseded_by;
  if (typeof supersededBy === "string") {
    const wlMatch = supersededBy.match(SUPERSEDED_BY_RE);
    if (wlMatch) {
      relationships.push({
        sourceId: id,
        targetId: wlMatch[1],
        type: "superseded_by",
      });
    }
  }

  // Tags
  const tags: string[] = Array.isArray(frontmatter.tags)
    ? frontmatter.tags.map(String)
    : [];

  return {
    id,
    path,
    title,
    date: frontmatter.date ? String(frontmatter.date) : null,
    type: frontmatter.type ?? null,
    status: frontmatter.status ?? null,
    githubIssue: typeof frontmatter.github_issue === "number" ? frontmatter.github_issue : null,
    tags,
    relationships,
    content: body,
  };
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/parser.test.ts`
Expected: All 7 tests PASS

**Step 5: Commit**

```bash
git add plugin/ralph-hero/knowledge-index/src/parser.ts plugin/ralph-hero/knowledge-index/src/__tests__/parser.test.ts
git commit -m "feat(knowledge): markdown parser with frontmatter, wikilinks, and relationship extraction"
```

---

### Task B3: SQLite Schema and Document Storage

Create the database, schema, and CRUD operations for documents, tags, and relationships.

**Files:**
- Create: `plugin/ralph-hero/knowledge-index/src/db.ts`
- Create: `plugin/ralph-hero/knowledge-index/src/__tests__/db.test.ts`

**Step 1: Write the failing tests**

```typescript
// src/__tests__/db.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { KnowledgeDB } from "../db.js";

let db: KnowledgeDB;

beforeEach(() => {
  db = new KnowledgeDB(":memory:");
});

describe("KnowledgeDB", () => {
  it("creates schema without error", () => {
    expect(db).toBeTruthy();
  });

  it("inserts and retrieves a document", () => {
    db.upsertDocument({
      id: "doc-1",
      path: "thoughts/shared/research/doc-1.md",
      title: "Test Doc",
      date: "2026-03-08",
      type: "research",
      status: "draft",
      githubIssue: 100,
      content: "Some content about caching",
    });

    const doc = db.getDocument("doc-1");
    expect(doc).toBeTruthy();
    expect(doc!.title).toBe("Test Doc");
    expect(doc!.type).toBe("research");
  });

  it("inserts and retrieves tags", () => {
    db.upsertDocument({ id: "doc-1", path: "p", title: "t", date: null, type: null, status: null, githubIssue: null, content: "" });
    db.setTags("doc-1", ["caching", "performance"]);

    const tags = db.getTags("doc-1");
    expect(tags).toEqual(["caching", "performance"]);
  });

  it("replaces tags on re-set", () => {
    db.upsertDocument({ id: "doc-1", path: "p", title: "t", date: null, type: null, status: null, githubIssue: null, content: "" });
    db.setTags("doc-1", ["old-tag"]);
    db.setTags("doc-1", ["new-tag"]);

    const tags = db.getTags("doc-1");
    expect(tags).toEqual(["new-tag"]);
  });

  it("inserts and retrieves relationships", () => {
    db.upsertDocument({ id: "doc-a", path: "a", title: "A", date: null, type: null, status: null, githubIssue: null, content: "" });
    db.upsertDocument({ id: "doc-b", path: "b", title: "B", date: null, type: null, status: null, githubIssue: null, content: "" });

    db.addRelationship("doc-a", "doc-b", "builds_on");

    const outgoing = db.getRelationshipsFrom("doc-a");
    expect(outgoing).toHaveLength(1);
    expect(outgoing[0]).toEqual({ sourceId: "doc-a", targetId: "doc-b", type: "builds_on" });

    const incoming = db.getRelationshipsTo("doc-b");
    expect(incoming).toHaveLength(1);
  });

  it("clears all data for rebuild", () => {
    db.upsertDocument({ id: "doc-1", path: "p", title: "t", date: null, type: null, status: null, githubIssue: null, content: "" });
    db.clearAll();

    const doc = db.getDocument("doc-1");
    expect(doc).toBeUndefined();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/db.test.ts`
Expected: FAIL — `KnowledgeDB` not found

**Step 3: Implement KnowledgeDB**

```typescript
// src/db.ts
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";

export interface DocumentRow {
  id: string;
  path: string;
  title: string;
  date: string | null;
  type: string | null;
  status: string | null;
  githubIssue: number | null;
  content: string;
}

export interface RelationshipRow {
  sourceId: string;
  targetId: string;
  type: string;
}

export class KnowledgeDB {
  readonly db: DatabaseType;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.createSchema();
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        title TEXT,
        date TEXT,
        type TEXT,
        status TEXT,
        github_issue INTEGER,
        content TEXT
      );

      CREATE TABLE IF NOT EXISTS tags (
        doc_id TEXT REFERENCES documents(id) ON DELETE CASCADE,
        tag TEXT,
        PRIMARY KEY (doc_id, tag)
      );

      CREATE TABLE IF NOT EXISTS relationships (
        source_id TEXT REFERENCES documents(id) ON DELETE CASCADE,
        target_id TEXT,
        type TEXT CHECK(type IN ('builds_on', 'tensions', 'superseded_by')),
        PRIMARY KEY (source_id, target_id, type)
      );

      CREATE INDEX IF NOT EXISTS idx_rel_target ON relationships(target_id, type);
      CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);
    `);
  }

  upsertDocument(doc: DocumentRow): void {
    this.db.prepare(`
      INSERT INTO documents (id, path, title, date, type, status, github_issue, content)
      VALUES (@id, @path, @title, @date, @type, @status, @githubIssue, @content)
      ON CONFLICT(id) DO UPDATE SET
        path = @path, title = @title, date = @date, type = @type,
        status = @status, github_issue = @githubIssue, content = @content
    `).run(doc);
  }

  getDocument(id: string): DocumentRow | undefined {
    return this.db.prepare(`
      SELECT id, path, title, date, type, status, github_issue AS githubIssue, content
      FROM documents WHERE id = ?
    `).get(id) as DocumentRow | undefined;
  }

  setTags(docId: string, tags: string[]): void {
    this.db.prepare("DELETE FROM tags WHERE doc_id = ?").run(docId);
    const insert = this.db.prepare("INSERT INTO tags (doc_id, tag) VALUES (?, ?)");
    for (const tag of tags) {
      insert.run(docId, tag);
    }
  }

  getTags(docId: string): string[] {
    const rows = this.db.prepare("SELECT tag FROM tags WHERE doc_id = ? ORDER BY tag").all(docId) as Array<{ tag: string }>;
    return rows.map(r => r.tag);
  }

  addRelationship(sourceId: string, targetId: string, type: string): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO relationships (source_id, target_id, type) VALUES (?, ?, ?)
    `).run(sourceId, targetId, type);
  }

  getRelationshipsFrom(sourceId: string): RelationshipRow[] {
    return this.db.prepare(`
      SELECT source_id AS sourceId, target_id AS targetId, type
      FROM relationships WHERE source_id = ?
    `).all(sourceId) as RelationshipRow[];
  }

  getRelationshipsTo(targetId: string): RelationshipRow[] {
    return this.db.prepare(`
      SELECT source_id AS sourceId, target_id AS targetId, type
      FROM relationships WHERE target_id = ?
    `).all(targetId) as RelationshipRow[];
  }

  clearAll(): void {
    this.db.exec("DELETE FROM relationships; DELETE FROM tags; DELETE FROM documents;");
  }

  close(): void {
    this.db.close();
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/db.test.ts`
Expected: All 6 tests PASS

**Step 5: Commit**

```bash
git add plugin/ralph-hero/knowledge-index/src/db.ts plugin/ralph-hero/knowledge-index/src/__tests__/db.test.ts
git commit -m "feat(knowledge): SQLite schema with document, tag, and relationship CRUD"
```

---

### Task B4: FTS5 Full-Text Search

Add FTS5 virtual table for keyword search over documents.

**Files:**
- Create: `plugin/ralph-hero/knowledge-index/src/search.ts`
- Create: `plugin/ralph-hero/knowledge-index/src/__tests__/search.test.ts`

**Step 1: Write the failing tests**

```typescript
// src/__tests__/search.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { KnowledgeDB } from "../db.js";
import { FtsSearch } from "../search.js";

let db: KnowledgeDB;
let search: FtsSearch;

beforeEach(() => {
  db = new KnowledgeDB(":memory:");
  search = new FtsSearch(db);

  db.upsertDocument({ id: "cache-doc", path: "p1", title: "Cache TTL Strategy", date: "2026-03-08", type: "research", status: "draft", githubIssue: 560, content: "The response cache needs configurable TTL for different endpoint types." });
  db.setTags("cache-doc", ["caching", "performance"]);

  db.upsertDocument({ id: "auth-doc", path: "p2", title: "Auth Token Refresh", date: "2026-03-07", type: "plan", status: "approved", githubIssue: 555, content: "JWT tokens should refresh silently when approaching expiry." });
  db.setTags("auth-doc", ["auth", "security"]);

  db.upsertDocument({ id: "cache-old", path: "p3", title: "Old Cache Approach", date: "2026-02-20", type: "plan", status: "superseded", githubIssue: 200, content: "Cache everything aggressively with no invalidation." });
  db.setTags("cache-old", ["caching"]);

  search.rebuildIndex();
});

describe("FtsSearch", () => {
  it("finds documents by keyword", () => {
    const results = search.search("cache TTL");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].id).toBe("cache-doc");
  });

  it("returns empty for no matches", () => {
    const results = search.search("kubernetes deployment");
    expect(results).toHaveLength(0);
  });

  it("filters by type", () => {
    const results = search.search("cache", { type: "plan" });
    expect(results.every(r => r.type === "plan")).toBe(true);
  });

  it("filters by tags", () => {
    const results = search.search("cache", { tags: ["performance"] });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("cache-doc");
  });

  it("excludes superseded documents by default", () => {
    const results = search.search("cache");
    expect(results.find(r => r.id === "cache-old")).toBeUndefined();
  });

  it("includes superseded documents when requested", () => {
    const results = search.search("cache", { includeSuperseded: true });
    expect(results.find(r => r.id === "cache-old")).toBeTruthy();
  });

  it("respects limit", () => {
    const results = search.search("cache", { limit: 1, includeSuperseded: true });
    expect(results).toHaveLength(1);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/search.test.ts`
Expected: FAIL — `FtsSearch` not found

**Step 3: Implement FtsSearch**

```typescript
// src/search.ts
import type { KnowledgeDB } from "./db.js";

export interface SearchOptions {
  type?: string;
  tags?: string[];
  limit?: number;
  includeSuperseded?: boolean;
}

export interface SearchResult {
  id: string;
  path: string;
  title: string;
  type: string | null;
  status: string | null;
  date: string | null;
  score: number;
  snippet: string;
}

export class FtsSearch {
  constructor(private knowledgeDb: KnowledgeDB) {}

  rebuildIndex(): void {
    const db = this.knowledgeDb.db;
    db.exec("DROP TABLE IF EXISTS documents_fts");
    db.exec(`
      CREATE VIRTUAL TABLE documents_fts USING fts5(
        id,
        title,
        content,
        content='documents',
        content_rowid='rowid'
      )
    `);
    db.exec(`
      INSERT INTO documents_fts(rowid, id, title, content)
        SELECT rowid, id, title, content FROM documents
    `);
  }

  search(query: string, options: SearchOptions = {}): SearchResult[] {
    const { type, tags, limit = 20, includeSuperseded = false } = options;
    const db = this.knowledgeDb.db;

    const conditions: string[] = ["documents_fts MATCH @query"];
    const params: Record<string, unknown> = { query, limit };

    if (!includeSuperseded) {
      conditions.push("d.status != 'superseded'");
    }
    if (type) {
      conditions.push("d.type = @type");
      params.type = type;
    }

    let tagJoin = "";
    if (tags && tags.length > 0) {
      tagJoin = "JOIN tags t ON t.doc_id = d.id";
      conditions.push(`t.tag IN (${tags.map((_, i) => `@tag${i}`).join(", ")})`);
      tags.forEach((tag, i) => { params[`tag${i}`] = tag; });
    }

    const sql = `
      SELECT d.id, d.path, d.title, d.type, d.status, d.date,
             rank AS score,
             snippet(documents_fts, 2, '<b>', '</b>', '...', 32) AS snippet
      FROM documents_fts
      JOIN documents d ON d.id = documents_fts.id
      ${tagJoin}
      WHERE ${conditions.join(" AND ")}
      ORDER BY rank
      LIMIT @limit
    `;

    return db.prepare(sql).all(params) as SearchResult[];
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/search.test.ts`
Expected: All 7 tests PASS

**Step 5: Commit**

```bash
git add plugin/ralph-hero/knowledge-index/src/search.ts plugin/ralph-hero/knowledge-index/src/__tests__/search.test.ts
git commit -m "feat(knowledge): FTS5 keyword search with type, tag, and status filtering"
```

---

### Task B5: Relationship Traversal

Add recursive CTE-based graph traversal for typed relationship edges.

**Files:**
- Create: `plugin/ralph-hero/knowledge-index/src/traverse.ts`
- Create: `plugin/ralph-hero/knowledge-index/src/__tests__/traverse.test.ts`

**Step 1: Write the failing tests**

```typescript
// src/__tests__/traverse.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { KnowledgeDB } from "../db.js";
import { Traverser } from "../traverse.js";

let db: KnowledgeDB;
let traverser: Traverser;

beforeEach(() => {
  db = new KnowledgeDB(":memory:");
  traverser = new Traverser(db);

  // Create a chain: doc-c builds_on doc-b builds_on doc-a
  db.upsertDocument({ id: "doc-a", path: "a", title: "Foundation", date: "2026-01-01", type: "research", status: "complete", githubIssue: 100, content: "" });
  db.upsertDocument({ id: "doc-b", path: "b", title: "Extension", date: "2026-02-01", type: "plan", status: "approved", githubIssue: 200, content: "" });
  db.upsertDocument({ id: "doc-c", path: "c", title: "Latest", date: "2026-03-01", type: "plan", status: "draft", githubIssue: 300, content: "" });

  db.addRelationship("doc-c", "doc-b", "builds_on");
  db.addRelationship("doc-b", "doc-a", "builds_on");
  db.addRelationship("doc-c", "doc-a", "tensions");
});

describe("Traverser", () => {
  it("finds direct outgoing relationships", () => {
    const results = traverser.traverse("doc-c", { depth: 1 });
    expect(results).toHaveLength(2); // builds_on doc-b, tensions doc-a
  });

  it("walks multi-hop builds_on chain", () => {
    const results = traverser.traverse("doc-c", { type: "builds_on", depth: 3 });
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ targetId: "doc-b", depth: 1 });
    expect(results[1]).toMatchObject({ targetId: "doc-a", depth: 2 });
  });

  it("respects depth limit", () => {
    const results = traverser.traverse("doc-c", { type: "builds_on", depth: 1 });
    expect(results).toHaveLength(1);
    expect(results[0].targetId).toBe("doc-b");
  });

  it("filters by relationship type", () => {
    const results = traverser.traverse("doc-c", { type: "tensions", depth: 3 });
    expect(results).toHaveLength(1);
    expect(results[0].targetId).toBe("doc-a");
  });

  it("finds incoming relationships (reverse traversal)", () => {
    const results = traverser.traverseIncoming("doc-a", { depth: 1 });
    expect(results).toHaveLength(2); // doc-b builds_on, doc-c tensions
  });

  it("includes document metadata in results", () => {
    const results = traverser.traverse("doc-c", { type: "builds_on", depth: 1 });
    expect(results[0].doc).toMatchObject({ title: "Extension", status: "approved", date: "2026-02-01" });
  });

  it("returns empty for document with no relationships", () => {
    const results = traverser.traverse("doc-a", { depth: 3 });
    expect(results).toEqual([]);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/traverse.test.ts`
Expected: FAIL — `Traverser` not found

**Step 3: Implement Traverser**

```typescript
// src/traverse.ts
import type { KnowledgeDB } from "./db.js";

export interface TraverseOptions {
  type?: string;
  depth?: number;
}

export interface TraverseResult {
  sourceId: string;
  targetId: string;
  type: string;
  depth: number;
  doc: { title: string; status: string | null; date: string | null } | null;
}

export class Traverser {
  constructor(private knowledgeDb: KnowledgeDB) {}

  traverse(fromId: string, options: TraverseOptions = {}): TraverseResult[] {
    const { type, depth = 3 } = options;
    const db = this.knowledgeDb.db;

    const typeFilter = type ? "AND r.type = @type" : "";

    const sql = `
      WITH RECURSIVE chain AS (
        SELECT r.source_id, r.target_id, r.type, 1 AS depth
        FROM relationships r
        WHERE r.source_id = @fromId ${typeFilter}
        UNION ALL
        SELECT r.source_id, r.target_id, r.type, c.depth + 1
        FROM relationships r
        JOIN chain c ON r.source_id = c.target_id
        WHERE c.depth < @depth ${typeFilter}
      )
      SELECT c.source_id AS sourceId, c.target_id AS targetId, c.type, c.depth,
             d.title, d.status, d.date
      FROM chain c
      LEFT JOIN documents d ON d.id = c.target_id
      ORDER BY c.depth, c.target_id
    `;

    const rows = db.prepare(sql).all({ fromId, type, depth }) as Array<
      TraverseResult & { title: string; status: string | null; date: string | null }
    >;

    return rows.map(row => ({
      sourceId: row.sourceId,
      targetId: row.targetId,
      type: row.type,
      depth: row.depth,
      doc: row.title ? { title: row.title, status: row.status, date: row.date } : null,
    }));
  }

  traverseIncoming(toId: string, options: TraverseOptions = {}): TraverseResult[] {
    const { type, depth = 3 } = options;
    const db = this.knowledgeDb.db;

    const typeFilter = type ? "AND r.type = @type" : "";

    const sql = `
      WITH RECURSIVE chain AS (
        SELECT r.source_id, r.target_id, r.type, 1 AS depth
        FROM relationships r
        WHERE r.target_id = @toId ${typeFilter}
        UNION ALL
        SELECT r.source_id, r.target_id, r.type, c.depth + 1
        FROM relationships r
        JOIN chain c ON r.target_id = c.source_id
        WHERE c.depth < @depth ${typeFilter}
      )
      SELECT c.source_id AS sourceId, c.target_id AS targetId, c.type, c.depth,
             d.title, d.status, d.date
      FROM chain c
      LEFT JOIN documents d ON d.id = c.source_id
      ORDER BY c.depth, c.source_id
    `;

    const rows = db.prepare(sql).all({ toId, type, depth }) as Array<
      TraverseResult & { title: string; status: string | null; date: string | null }
    >;

    return rows.map(row => ({
      sourceId: row.sourceId,
      targetId: row.targetId,
      type: row.type,
      depth: row.depth,
      doc: row.title ? { title: row.title, status: row.status, date: row.date } : null,
    }));
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/traverse.test.ts`
Expected: All 7 tests PASS

**Step 5: Commit**

```bash
git add plugin/ralph-hero/knowledge-index/src/traverse.ts plugin/ralph-hero/knowledge-index/src/__tests__/traverse.test.ts
git commit -m "feat(knowledge): recursive CTE relationship traversal with type filtering"
```

---

### Task B6: Embedding Generation and Vector Search

Add sqlite-vec for semantic similarity search.

**Files:**
- Create: `plugin/ralph-hero/knowledge-index/src/embedder.ts`
- Create: `plugin/ralph-hero/knowledge-index/src/vector-search.ts`
- Create: `plugin/ralph-hero/knowledge-index/src/__tests__/vector-search.test.ts`

**Step 1: Write the failing tests**

Tests use mock embeddings to avoid downloading the model in CI.

```typescript
// src/__tests__/vector-search.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { KnowledgeDB } from "../db.js";
import { VectorSearch } from "../vector-search.js";

let db: KnowledgeDB;
let vecSearch: VectorSearch;

function mockEmbedding(seed: number): Float32Array {
  const vec = new Float32Array(384);
  vec[0] = seed * 0.1;
  vec[1] = seed * 0.2;
  vec[2] = seed * 0.3;
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return vec;
}

beforeEach(() => {
  db = new KnowledgeDB(":memory:");
  vecSearch = new VectorSearch(db);
  vecSearch.createIndex();

  db.upsertDocument({ id: "doc-1", path: "p1", title: "Cache Strategy", date: "2026-03-08", type: "research", status: "draft", githubIssue: 100, content: "caching" });
  db.upsertDocument({ id: "doc-2", path: "p2", title: "Auth Tokens", date: "2026-03-07", type: "plan", status: "draft", githubIssue: 200, content: "auth" });

  vecSearch.upsertEmbedding("doc-1", mockEmbedding(1));
  vecSearch.upsertEmbedding("doc-2", mockEmbedding(5));
});

describe("VectorSearch", () => {
  it("finds nearest document by vector similarity", () => {
    const results = vecSearch.search(mockEmbedding(1), 5);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].id).toBe("doc-1");
  });

  it("returns distance scores", () => {
    const results = vecSearch.search(mockEmbedding(1), 5);
    expect(typeof results[0].distance).toBe("number");
    expect(results[0].distance).toBeLessThan(results[1].distance);
  });

  it("respects limit", () => {
    const results = vecSearch.search(mockEmbedding(1), 1);
    expect(results).toHaveLength(1);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/vector-search.test.ts`
Expected: FAIL — `VectorSearch` not found

**Step 3: Implement VectorSearch**

```typescript
// src/vector-search.ts
import * as sqliteVec from "sqlite-vec";
import type { KnowledgeDB } from "./db.js";

export interface VectorResult {
  id: string;
  distance: number;
}

export class VectorSearch {
  private vecLoaded = false;

  constructor(private knowledgeDb: KnowledgeDB) {}

  private ensureVecLoaded(): void {
    if (!this.vecLoaded) {
      sqliteVec.load(this.knowledgeDb.db);
      this.vecLoaded = true;
    }
  }

  createIndex(): void {
    this.ensureVecLoaded();
    this.knowledgeDb.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS documents_vec USING vec0(
        id TEXT PRIMARY KEY,
        embedding float[384] distance_metric=cosine
      )
    `);
  }

  dropIndex(): void {
    this.knowledgeDb.db.exec("DROP TABLE IF EXISTS documents_vec");
  }

  upsertEmbedding(id: string, embedding: Float32Array): void {
    this.ensureVecLoaded();
    this.knowledgeDb.db.prepare("DELETE FROM documents_vec WHERE id = ?").run(id);
    this.knowledgeDb.db.prepare(
      "INSERT INTO documents_vec (id, embedding) VALUES (?, ?)"
    ).run(id, embedding.buffer as Buffer);
  }

  search(queryEmbedding: Float32Array, limit: number = 10): VectorResult[] {
    this.ensureVecLoaded();
    return this.knowledgeDb.db.prepare(`
      SELECT id, distance
      FROM documents_vec
      WHERE embedding MATCH ? AND k = ?
      ORDER BY distance
    `).all(queryEmbedding.buffer as Buffer, limit) as VectorResult[];
  }
}
```

**Step 4: Implement the embedder**

```typescript
// src/embedder.ts
import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const MAX_CHARS = 500; // ~128 tokens — model's reliable range

let embedderInstance: FeatureExtractionPipeline | null = null;

export async function getEmbedder(): Promise<FeatureExtractionPipeline> {
  if (!embedderInstance) {
    embedderInstance = await pipeline("feature-extraction", MODEL_ID) as FeatureExtractionPipeline;
  }
  return embedderInstance;
}

export async function embed(text: string): Promise<Float32Array> {
  const embedder = await getEmbedder();
  const truncated = text.slice(0, MAX_CHARS);
  const output = await embedder(truncated, { pooling: "mean", normalize: true });
  return new Float32Array(output.data as ArrayLike<number>);
}

export function prepareTextForEmbedding(title: string, content: string): string {
  return `${title}\n${content}`.slice(0, MAX_CHARS);
}
```

**Step 5: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/vector-search.test.ts`
Expected: All 3 tests PASS

**Step 6: Commit**

```bash
git add plugin/ralph-hero/knowledge-index/src/embedder.ts plugin/ralph-hero/knowledge-index/src/vector-search.ts plugin/ralph-hero/knowledge-index/src/__tests__/vector-search.test.ts
git commit -m "feat(knowledge): sqlite-vec embedding storage and cosine similarity search"
```

---

### Task B7: Hybrid Search (FTS5 + Vector with RRF)

Combine keyword and semantic search using Reciprocal Rank Fusion.

**Files:**
- Create: `plugin/ralph-hero/knowledge-index/src/hybrid-search.ts`
- Create: `plugin/ralph-hero/knowledge-index/src/__tests__/hybrid-search.test.ts`

**Step 1: Write the failing tests**

```typescript
// src/__tests__/hybrid-search.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { KnowledgeDB } from "../db.js";
import { FtsSearch } from "../search.js";
import { VectorSearch } from "../vector-search.js";
import { HybridSearch } from "../hybrid-search.js";

let db: KnowledgeDB;
let hybrid: HybridSearch;

function mockEmbedding(seed: number): Float32Array {
  const vec = new Float32Array(384);
  vec[0] = seed * 0.1;
  vec[1] = seed * 0.2;
  vec[2] = seed * 0.3;
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return vec;
}

const mockEmbed = async (text: string): Promise<Float32Array> => {
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  return mockEmbedding(Math.abs(hash) % 100);
};

beforeEach(() => {
  db = new KnowledgeDB(":memory:");
  const fts = new FtsSearch(db);
  const vec = new VectorSearch(db);
  vec.createIndex();
  hybrid = new HybridSearch(db, fts, vec, mockEmbed);

  db.upsertDocument({ id: "cache-doc", path: "p1", title: "Cache TTL Strategy", date: "2026-03-08", type: "research", status: "draft", githubIssue: 560, content: "The response cache needs configurable TTL." });
  db.setTags("cache-doc", ["caching"]);

  db.upsertDocument({ id: "auth-doc", path: "p2", title: "Auth Token Refresh", date: "2026-03-07", type: "plan", status: "approved", githubIssue: 555, content: "JWT tokens should refresh silently." });
  db.setTags("auth-doc", ["auth"]);

  vec.upsertEmbedding("cache-doc", mockEmbedding(1));
  vec.upsertEmbedding("auth-doc", mockEmbedding(5));

  fts.rebuildIndex();
});

describe("HybridSearch", () => {
  it("returns results combining FTS and vector scores", async () => {
    const results = await hybrid.search("cache TTL");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].id).toBe("cache-doc");
  });

  it("passes through type filter", async () => {
    const results = await hybrid.search("cache", { type: "plan" });
    expect(results.every(r => r.type === "plan" || results.length === 0)).toBe(true);
  });

  it("passes through tag filter", async () => {
    const results = await hybrid.search("strategy", { tags: ["caching"] });
    expect(results.length <= 1).toBe(true);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/hybrid-search.test.ts`
Expected: FAIL — `HybridSearch` not found

**Step 3: Implement HybridSearch**

```typescript
// src/hybrid-search.ts
import type { KnowledgeDB } from "./db.js";
import type { FtsSearch, SearchOptions, SearchResult } from "./search.js";
import type { VectorSearch } from "./vector-search.js";

type EmbedFn = (text: string) => Promise<Float32Array>;

const RRF_K = 60;

export class HybridSearch {
  constructor(
    private knowledgeDb: KnowledgeDB,
    private fts: FtsSearch,
    private vec: VectorSearch,
    private embedFn: EmbedFn,
  ) {}

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const { limit = 20, ...filterOptions } = options;
    const fetchLimit = limit * 2;

    const ftsResults = this.fts.search(query, { ...filterOptions, limit: fetchLimit });

    const queryVec = await this.embedFn(query);
    const vecResults = this.vec.search(queryVec, fetchLimit);

    // Reciprocal Rank Fusion
    const scores = new Map<string, number>();

    ftsResults.forEach((r, i) => {
      scores.set(r.id, (scores.get(r.id) ?? 0) + 1 / (RRF_K + i + 1));
    });

    vecResults.forEach((r, i) => {
      scores.set(r.id, (scores.get(r.id) ?? 0) + 1 / (RRF_K + i + 1));
    });

    const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);

    const ftsMap = new Map(ftsResults.map(r => [r.id, r]));

    return ranked.map(([id, score]) => {
      const ftsHit = ftsMap.get(id);
      if (ftsHit) {
        return { ...ftsHit, score };
      }
      const doc = this.knowledgeDb.getDocument(id);
      return {
        id,
        path: doc?.path ?? "",
        title: doc?.title ?? id,
        type: doc?.type ?? null,
        status: doc?.status ?? null,
        date: doc?.date ?? null,
        score,
        snippet: "",
      };
    }).filter(r => {
      if (!options.includeSuperseded && r.status === "superseded") return false;
      if (options.type && r.type !== options.type) return false;
      return true;
    });
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/hybrid-search.test.ts`
Expected: All 3 tests PASS

**Step 5: Commit**

```bash
git add plugin/ralph-hero/knowledge-index/src/hybrid-search.ts plugin/ralph-hero/knowledge-index/src/__tests__/hybrid-search.test.ts
git commit -m "feat(knowledge): hybrid search with reciprocal rank fusion over FTS5 + vectors"
```

---

### Task B8: MCP Server with Both Tools

Wire hybrid search and traversal into MCP tools.

**Files:**
- Modify: `plugin/ralph-hero/knowledge-index/src/index.ts`
- Create: `plugin/ralph-hero/knowledge-index/src/__tests__/index.test.ts`

**Step 1: Write the failing test**

```typescript
// src/__tests__/index.test.ts
import { describe, it, expect } from "vitest";

describe("knowledge-index server", () => {
  it("exports createServer function", async () => {
    const mod = await import("../index.js");
    expect(typeof mod.createServer).toBe("function");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/index.test.ts`
Expected: FAIL — no `createServer` export

**Step 3: Implement the MCP server**

```typescript
// src/index.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { KnowledgeDB } from "./db.js";
import { FtsSearch } from "./search.js";
import { VectorSearch } from "./vector-search.js";
import { HybridSearch } from "./hybrid-search.js";
import { Traverser } from "./traverse.js";
import { embed } from "./embedder.js";

export function createServer(dbPath: string) {
  const server = new McpServer({ name: "ralph-hero-knowledge", version: "0.1.0" });
  const db = new KnowledgeDB(dbPath);
  const fts = new FtsSearch(db);
  const vec = new VectorSearch(db);
  const hybrid = new HybridSearch(db, fts, vec, embed);
  const traverser = new Traverser(db);

  server.tool(
    "knowledge_search",
    "Search the knowledge base by keyword, semantic similarity, and tags. Returns ranked documents.",
    {
      query: z.string().describe("Search query (keywords or natural language)"),
      tags: z.array(z.string()).optional().describe("Filter by tags"),
      type: z.string().optional().describe("Filter by document type (research, plan, review, idea, report)"),
      limit: z.number().optional().describe("Max results (default: 10)"),
      includeSuperseded: z.boolean().optional().describe("Include superseded documents (default: false)"),
    },
    async (args) => {
      try {
        const results = await hybrid.search(args.query, {
          tags: args.tags,
          type: args.type,
          limit: args.limit ?? 10,
          includeSuperseded: args.includeSuperseded,
        });
        const enriched = results.map(r => ({ ...r, tags: db.getTags(r.id) }));
        return { content: [{ type: "text" as const, text: JSON.stringify(enriched, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    "knowledge_traverse",
    "Walk typed relationship edges (builds_on, tensions, superseded_by) from a document.",
    {
      from: z.string().describe("Document ID (filename without extension)"),
      type: z.enum(["builds_on", "tensions", "superseded_by"]).optional().describe("Filter by relationship type"),
      depth: z.number().optional().describe("Max traversal depth (default: 3)"),
      direction: z.enum(["outgoing", "incoming"]).optional().describe("Edge direction (default: outgoing)"),
    },
    async (args) => {
      try {
        const opts = { type: args.type, depth: args.depth ?? 3 };
        const results = args.direction === "incoming"
          ? traverser.traverseIncoming(args.from, opts)
          : traverser.traverse(args.from, opts);
        return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  return { server, db, fts, vec, hybrid, traverser };
}

const isMain = process.argv[1]?.endsWith("index.js");
if (isMain) {
  const dbPath = process.env.RALPH_KNOWLEDGE_DB ?? "knowledge.db";
  const { server } = createServer(dbPath);
  const transport = new StdioServerTransport();
  server.connect(transport).catch(console.error);
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/index.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add plugin/ralph-hero/knowledge-index/src/index.ts plugin/ralph-hero/knowledge-index/src/__tests__/index.test.ts
git commit -m "feat(knowledge): MCP server with knowledge_search and knowledge_traverse tools"
```

---

### Task B9: Reindex Script

Script that scans markdown files, parses them, generates embeddings, and rebuilds the full index.

**Files:**
- Create: `plugin/ralph-hero/knowledge-index/src/reindex.ts`
- Create: `plugin/ralph-hero/knowledge-index/.gitignore`

**Step 1: Implement the reindex script**

```typescript
// src/reindex.ts
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, basename } from "node:path";
import { KnowledgeDB } from "./db.js";
import { FtsSearch } from "./search.js";
import { VectorSearch } from "./vector-search.js";
import { embed, prepareTextForEmbedding } from "./embedder.js";
import { parseDocument } from "./parser.js";

function findMarkdownFiles(dir: string): string[] {
  const results: string[] = [];
  function walk(d: string) {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const fullPath = join(d, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        results.push(fullPath);
      }
    }
  }
  walk(dir);
  return results;
}

async function reindex(thoughtsDir: string, dbPath: string): Promise<void> {
  console.log(`Indexing ${thoughtsDir} -> ${dbPath}`);

  const db = new KnowledgeDB(dbPath);
  const fts = new FtsSearch(db);
  const vec = new VectorSearch(db);
  vec.createIndex();

  db.clearAll();
  vec.dropIndex();
  vec.createIndex();

  const files = findMarkdownFiles(thoughtsDir);
  console.log(`Found ${files.length} markdown files`);

  let indexed = 0;
  for (const filePath of files) {
    const raw = readFileSync(filePath, "utf-8");
    const relPath = relative(join(thoughtsDir, ".."), filePath);
    const id = basename(filePath, ".md");

    const parsed = parseDocument(id, relPath, raw);

    db.upsertDocument({
      id: parsed.id,
      path: parsed.path,
      title: parsed.title,
      date: parsed.date,
      type: parsed.type,
      status: parsed.status,
      githubIssue: parsed.githubIssue,
      content: parsed.content,
    });

    if (parsed.tags.length > 0) {
      db.setTags(parsed.id, parsed.tags);
    }

    for (const rel of parsed.relationships) {
      db.addRelationship(rel.sourceId, rel.targetId, rel.type);
    }

    const text = prepareTextForEmbedding(parsed.title, parsed.content);
    try {
      const embedding = await embed(text);
      vec.upsertEmbedding(parsed.id, embedding);
    } catch (e) {
      console.warn(`Failed to embed ${id}: ${(e as Error).message}`);
    }

    indexed++;
    if (indexed % 50 === 0) {
      console.log(`  ${indexed}/${files.length} indexed`);
    }
  }

  fts.rebuildIndex();

  console.log(`Done. ${indexed} documents indexed.`);
  db.close();
}

const thoughtsDir = process.argv[2] ?? "../../thoughts";
const dbPath = process.argv[3] ?? "knowledge.db";
reindex(thoughtsDir, dbPath).catch(console.error);
```

**Step 2: Create .gitignore**

```
node_modules/
dist/
knowledge.db
```

**Step 3: Build and test manually**

Run: `cd plugin/ralph-hero/knowledge-index && npm run build`
Expected: Compiles

Run: `node dist/reindex.js ../../thoughts knowledge.db`
Expected: `Found N markdown files` ... `Done. N documents indexed.`

Note: First run downloads ~80MB embedding model. Subsequent runs use cache at `~/.cache/huggingface/hub/`.

**Step 4: Commit**

```bash
git add plugin/ralph-hero/knowledge-index/src/reindex.ts plugin/ralph-hero/knowledge-index/.gitignore
git commit -m "feat(knowledge): reindex script — scans thoughts/, parses markdown, generates embeddings"
```

---

### Task B10: Wire into .mcp.json

Register the knowledge index as a second MCP server in the plugin config.

**Files:**
- Modify: `plugin/ralph-hero/.mcp.json`

**Step 1: Read the current .mcp.json**

Read `plugin/ralph-hero/.mcp.json` to understand the existing structure.

**Step 2: Add the knowledge-index server entry**

Add alongside the existing server:

```json
"ralph-knowledge": {
  "command": "node",
  "args": ["${CLAUDE_PLUGIN_ROOT}/knowledge-index/dist/index.js"],
  "env": {
    "RALPH_KNOWLEDGE_DB": "${CLAUDE_PLUGIN_ROOT}/knowledge-index/knowledge.db"
  }
}
```

**Step 3: Build the knowledge-index**

Run: `cd plugin/ralph-hero/knowledge-index && npm run build`

**Step 4: Test the MCP server starts**

Run: `echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0.1"}}}' | node plugin/ralph-hero/knowledge-index/dist/index.js`
Expected: JSON response with server capabilities

**Step 5: Commit**

```bash
git add plugin/ralph-hero/.mcp.json
git commit -m "feat(knowledge): register knowledge-index MCP server in plugin config"
```

---

## Dependency Summary (Part B only)

| Package | Version | Purpose |
|---|---|---|
| `better-sqlite3` | ^12.6.0 | SQLite driver (sync, FTS5 built-in) |
| `@types/better-sqlite3` | ^7.6.13 | TypeScript types |
| `sqlite-vec` | ^0.1.7-alpha.10 | Vector similarity (cosine) via vec0 |
| `@huggingface/transformers` | ^3.0.0 | Local ONNX embeddings (all-MiniLM-L6-v2, 384 dims) |
| `@modelcontextprotocol/sdk` | ^1.26.0 | MCP server protocol |
| `yaml` | ^2.7.0 | YAML frontmatter parsing |
| `zod` | ^3.25.0 | Tool input validation |
| `vitest` | ^4.0.0 | Test runner |

## Key Gotchas

1. **Always pass `Float32Array.buffer`** to sqlite-vec — not the `Float32Array` itself
2. **FTS5 `rank` is negative** — sort ascending for best match first
3. **MiniLM-L6-v2 token limit** — 128 tokens reliable, 256 max. Truncate to ~500 chars
4. **First run downloads ~80MB model** — set `TRANSFORMERS_CACHE` for CI
5. **`@huggingface/transformers` is ESM-only** — project uses `"type": "module"`
6. **vec0 doesn't support `ON CONFLICT`** — delete before insert for upserts
7. **FTS5 content= tables need manual sync** — call `rebuildIndex()` after changes
