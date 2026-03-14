# Ralph-Knowledge Obsidian Integration Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend ralph-knowledge's reindex pipeline to generate Obsidian-friendly navigational markdown files (type indexes, issue hubs, Dataview queries) and add a setup-obsidian skill for easy onboarding.

**Architecture:** The `reindex.ts` script gains a post-indexing generation phase via a new `generate-indexes.ts` module. It consumes the already-parsed document list and writes `_`-prefixed markdown files into the thoughts directory. A new `setup-obsidian` skill handles `.obsidian/` config provisioning and `.gitignore` updates.

**Tech Stack:** TypeScript, Vitest, Node.js `fs` APIs, YAML frontmatter

**Spec:** `docs/superpowers/specs/2026-03-14-ralph-knowledge-obsidian-integration-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `plugin/ralph-knowledge/src/generate-indexes.ts` | Create | Core generator: type indexes, master index, issue hubs, queries |
| `plugin/ralph-knowledge/src/file-scanner.ts` | Create | Extracted `findMarkdownFiles` with `_`-prefix skipping |
| `plugin/ralph-knowledge/src/__tests__/generate-indexes.test.ts` | Create | Unit tests for all generator functions |
| `plugin/ralph-knowledge/src/reindex.ts` | Modify | Import file-scanner, call generator after indexing, add `--no-generate` flag |
| `plugin/ralph-knowledge/skills/setup-obsidian/SKILL.md` | Create | Setup skill for Obsidian config + reindex |
| `plugin/ralph-knowledge/skills/setup/SKILL.md` | Modify | Add suggestion to run setup-obsidian after success |

---

## Chunk 1: Core Generator Module

### Task 1: Scaffold generate-indexes.ts with types and helpers

**Files:**
- Create: `plugin/ralph-knowledge/src/generate-indexes.ts`
- Create: `plugin/ralph-knowledge/src/__tests__/generate-indexes.test.ts`

- [ ] **Step 1: Write types and helper tests**

In `plugin/ralph-knowledge/src/__tests__/generate-indexes.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { formatIssueNumber, frontmatter } from "../generate-indexes.js";

describe("helpers", () => {
  it("zero-pads issue numbers to 4 digits", () => {
    expect(formatIssueNumber(42)).toBe("GH-0042");
    expect(formatIssueNumber(564)).toBe("GH-0564");
    expect(formatIssueNumber(9)).toBe("GH-0009");
  });

  it("does not pad 5+ digit issue numbers", () => {
    expect(formatIssueNumber(12345)).toBe("GH-12345");
    expect(formatIssueNumber(100000)).toBe("GH-100000");
  });

  it("generates frontmatter with generated flag", () => {
    const result = frontmatter({ generated: true, updated: "2026-03-14" });
    expect(result).toBe("---\ngenerated: true\nupdated: '2026-03-14'\n---\n");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugin/ralph-knowledge && npx vitest run src/__tests__/generate-indexes.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement types and helpers**

In `plugin/ralph-knowledge/src/generate-indexes.ts`:

```typescript
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { stringify as yamlStringify } from "yaml";
import type { ParsedDocument } from "./parser.js";

export function formatIssueNumber(num: number): string {
  return num < 10000 ? `GH-${String(num).padStart(4, "0")}` : `GH-${num}`;
}

export function frontmatter(fields: Record<string, unknown>): string {
  return `---\n${yamlStringify(fields).trimEnd()}\n---\n`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd plugin/ralph-knowledge && npx vitest run src/__tests__/generate-indexes.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add plugin/ralph-knowledge/src/generate-indexes.ts plugin/ralph-knowledge/src/__tests__/generate-indexes.test.ts
git commit -m "feat(knowledge): scaffold generate-indexes with types and helpers"
```

---

### Task 2: Type index generation (writeTypeIndex)

**Files:**
- Modify: `plugin/ralph-knowledge/src/generate-indexes.ts`
- Modify: `plugin/ralph-knowledge/src/__tests__/generate-indexes.test.ts`

- [ ] **Step 1: Write tests for writeTypeIndex**

Append to `generate-indexes.test.ts`:

```typescript
import { writeTypeIndex } from "../generate-indexes.js";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ParsedDocument } from "../parser.js";

function makeParsedDoc(overrides: Partial<ParsedDocument>): ParsedDocument {
  return {
    id: "test-doc",
    path: "thoughts/shared/research/test-doc.md",
    title: "Test Document",
    date: "2026-03-14",
    type: "research",
    status: "draft",
    githubIssue: null,
    tags: [],
    relationships: [],
    content: "test content",
    ...overrides,
  };
}

describe("writeTypeIndex", () => {
  it("groups active and superseded docs", () => {
    const dir = mkdtempSync(join(tmpdir(), "gen-test-"));
    const docs = [
      makeParsedDoc({ id: "active-doc", title: "Active Research", status: "draft", githubIssue: 100 }),
      makeParsedDoc({
        id: "old-doc", title: "Old Research", status: "superseded",
        relationships: [{ sourceId: "old-doc", targetId: "active-doc", type: "superseded_by" }],
      }),
    ];
    writeTypeIndex(dir, "research", "Research Documents", docs);
    const content = readFileSync(join(dir, "_research.md"), "utf-8");
    expect(content).toContain("# Research Documents");
    expect(content).toContain("## Active");
    expect(content).toContain("[[active-doc]]");
    expect(content).toContain("#100");
    expect(content).toContain("## Superseded");
    expect(content).toContain("~~[[old-doc]]~~");
    expect(content).toContain("→ [[active-doc]]");
  });

  it("handles empty doc list", () => {
    const dir = mkdtempSync(join(tmpdir(), "gen-test-"));
    writeTypeIndex(dir, "research", "Research Documents", []);
    const content = readFileSync(join(dir, "_research.md"), "utf-8");
    expect(content).toContain("# Research Documents");
    expect(content).toContain("generated: true");
    expect(content).not.toContain("[[");
  });

  it("sorts by date descending", () => {
    const dir = mkdtempSync(join(tmpdir(), "gen-test-"));
    const docs = [
      makeParsedDoc({ id: "older", title: "Older", date: "2026-03-01" }),
      makeParsedDoc({ id: "newer", title: "Newer", date: "2026-03-14" }),
    ];
    writeTypeIndex(dir, "research", "Research Documents", docs);
    const content = readFileSync(join(dir, "_research.md"), "utf-8");
    const olderIdx = content.indexOf("[[older]]");
    const newerIdx = content.indexOf("[[newer]]");
    expect(newerIdx).toBeLessThan(olderIdx);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugin/ralph-knowledge && npx vitest run src/__tests__/generate-indexes.test.ts`
Expected: FAIL — `writeTypeIndex` not exported

- [ ] **Step 3: Implement writeTypeIndex**

Add to `generate-indexes.ts`:

```typescript
export function writeTypeIndex(
  outDir: string,
  type: string,
  heading: string,
  docs: ParsedDocument[],
): void {
  const active = docs.filter((d) => d.status !== "superseded");
  const superseded = docs.filter((d) => d.status === "superseded");

  const sortByDate = (a: ParsedDocument, b: ParsedDocument) =>
    (b.date ?? "").localeCompare(a.date ?? "");
  active.sort(sortByDate);
  superseded.sort(sortByDate);

  const lines: string[] = [
    frontmatter({ generated: true, updated: new Date().toISOString().slice(0, 10) }),
    `# ${heading}\n`,
  ];

  if (active.length > 0) {
    lines.push("## Active\n");
    for (const doc of active) {
      const issue = doc.githubIssue ? ` — #${doc.githubIssue}` : "";
      lines.push(`- [[${doc.id}]]${issue} · ${doc.title}`);
    }
    lines.push("");
  }

  if (superseded.length > 0) {
    lines.push("## Superseded\n");
    for (const doc of superseded) {
      const supersededByRel = doc.relationships.find((r) => r.type === "superseded_by");
      const arrow = supersededByRel ? ` → [[${supersededByRel.targetId}]]` : "";
      lines.push(`- ~~[[${doc.id}]]~~${arrow}`);
    }
    lines.push("");
  }

  writeFileSync(join(outDir, `_${type}.md`), lines.join("\n"));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd plugin/ralph-knowledge && npx vitest run src/__tests__/generate-indexes.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add plugin/ralph-knowledge/src/generate-indexes.ts plugin/ralph-knowledge/src/__tests__/generate-indexes.test.ts
git commit -m "feat(knowledge): add writeTypeIndex for type-specific index generation"
```

---

### Task 3: Issue hub generation (writeIssueHubs)

**Files:**
- Modify: `plugin/ralph-knowledge/src/generate-indexes.ts`
- Modify: `plugin/ralph-knowledge/src/__tests__/generate-indexes.test.ts`

- [ ] **Step 1: Write tests for writeIssueHubs**

Append to `generate-indexes.test.ts`:

```typescript
import { writeIssueHubs } from "../generate-indexes.js";

describe("writeIssueHubs", () => {
  it("creates per-issue hub with grouped docs", () => {
    const dir = mkdtempSync(join(tmpdir(), "gen-test-"));
    const docs = [
      makeParsedDoc({ id: "research-560", title: "Cache TTL Research", type: "research", githubIssue: 560 }),
      makeParsedDoc({ id: "research-560-b", title: "Cache Follow-up", type: "research", githubIssue: 560 }),
      makeParsedDoc({ id: "plan-560", title: "Cache TTL Plan", type: "plan", githubIssue: 560 }),
    ];
    writeIssueHubs(dir, docs);
    const content = readFileSync(join(dir, "_issues", "GH-0560.md"), "utf-8");
    expect(content).toContain("# GH-560");
    expect(content).toContain("github_issue: 560");
    expect(content).toContain("## Research");
    expect(content).toContain("[[research-560]]");
    expect(content).toContain("[[research-560-b]]");
    expect(content).toContain("## Plans");
    expect(content).toContain("[[plan-560]]");
  });

  it("skips docs without github_issue", () => {
    const dir = mkdtempSync(join(tmpdir(), "gen-test-"));
    const docs = [
      makeParsedDoc({ id: "no-issue", githubIssue: null }),
      makeParsedDoc({ id: "has-issue", githubIssue: 42 }),
    ];
    writeIssueHubs(dir, docs);
    expect(existsSync(join(dir, "_issues", "GH-0042.md"))).toBe(true);
    const files = readdirSync(join(dir, "_issues"));
    expect(files).toHaveLength(1);
  });

  it("includes relationships from all docs for the issue", () => {
    const dir = mkdtempSync(join(tmpdir(), "gen-test-"));
    const docs = [
      makeParsedDoc({
        id: "research-99", type: "research", githubIssue: 99,
        relationships: [{ sourceId: "research-99", targetId: "earlier-doc", type: "builds_on" }],
      }),
    ];
    writeIssueHubs(dir, docs);
    const content = readFileSync(join(dir, "_issues", "GH-0099.md"), "utf-8");
    expect(content).toContain("## Relationships");
    expect(content).toContain("builds_on:: [[earlier-doc]]");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugin/ralph-knowledge && npx vitest run src/__tests__/generate-indexes.test.ts`
Expected: FAIL — `writeIssueHubs` not exported

- [ ] **Step 3: Implement writeIssueHubs**

Add to `generate-indexes.ts`:

```typescript
import { readdirSync } from "node:fs";

const TYPE_HEADINGS: Record<string, string> = {
  research: "Research",
  plan: "Plans",
  idea: "Ideas",
  review: "Reviews",
  report: "Reports",
};

export function writeIssueHubs(outDir: string, allDocs: ParsedDocument[]): void {
  const byIssue = new Map<number, ParsedDocument[]>();
  for (const doc of allDocs) {
    if (doc.githubIssue !== null) {
      const list = byIssue.get(doc.githubIssue) ?? [];
      list.push(doc);
      byIssue.set(doc.githubIssue, list);
    }
  }

  const issuesDir = join(outDir, "_issues");
  mkdirSync(issuesDir, { recursive: true });

  for (const [issueNum, docs] of byIssue) {
    const fileName = `${formatIssueNumber(issueNum)}.md`;
    const lines: string[] = [
      frontmatter({ generated: true, github_issue: issueNum, updated: new Date().toISOString().slice(0, 10) }),
      `# GH-${issueNum}\n`,
    ];

    const byType = new Map<string, ParsedDocument[]>();
    for (const doc of docs) {
      const t = doc.type ?? "other";
      const list = byType.get(t) ?? [];
      list.push(doc);
      byType.set(t, list);
    }

    for (const [type, heading] of Object.entries(TYPE_HEADINGS)) {
      const typeDocs = byType.get(type);
      if (typeDocs && typeDocs.length > 0) {
        lines.push(`## ${heading}\n`);
        for (const doc of typeDocs) {
          lines.push(`- [[${doc.id}]] — ${doc.title}`);
        }
        lines.push("");
      }
    }

    // "other" type docs that don't match known headings
    const otherDocs = byType.get("other");
    if (otherDocs && otherDocs.length > 0) {
      lines.push("## Other\n");
      for (const doc of otherDocs) {
        lines.push(`- [[${doc.id}]] — ${doc.title}`);
      }
      lines.push("");
    }

    const allRels = docs.flatMap((d) => d.relationships);
    if (allRels.length > 0) {
      lines.push("## Relationships\n");
      for (const rel of allRels) {
        lines.push(`- ${rel.type}:: [[${rel.targetId}]]`);
      }
      lines.push("");
    }

    writeFileSync(join(issuesDir, fileName), lines.join("\n"));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd plugin/ralph-knowledge && npx vitest run src/__tests__/generate-indexes.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add plugin/ralph-knowledge/src/generate-indexes.ts plugin/ralph-knowledge/src/__tests__/generate-indexes.test.ts
git commit -m "feat(knowledge): add writeIssueHubs for per-issue hub generation"
```

---

### Task 4: Master index and queries generation

**Files:**
- Modify: `plugin/ralph-knowledge/src/generate-indexes.ts`
- Modify: `plugin/ralph-knowledge/src/__tests__/generate-indexes.test.ts`

- [ ] **Step 1: Write tests for writeMasterIndex and writeQueryReference**

Append to `generate-indexes.test.ts`:

```typescript
import { writeMasterIndex, writeQueryReference } from "../generate-indexes.js";

describe("writeMasterIndex", () => {
  it("links to type indexes and shows recent docs", () => {
    const dir = mkdtempSync(join(tmpdir(), "gen-test-"));
    const docs = [
      makeParsedDoc({ id: "recent-1", title: "Recent Research", type: "research", date: "2026-03-14" }),
      makeParsedDoc({ id: "recent-2", title: "Recent Plan", type: "plan", date: "2026-03-13" }),
    ];
    writeMasterIndex(dir, docs);
    const content = readFileSync(join(dir, "_index.md"), "utf-8");
    expect(content).toContain("# Knowledge Index");
    expect(content).toContain("[[_research]]");
    expect(content).toContain("[[_plans]]");
    expect(content).toContain("[[_ideas]]");
    expect(content).toContain("[[_reviews]]");
    expect(content).toContain("[[_reports]]");
    expect(content).toContain("## Recent Documents");
    expect(content).toContain("[[recent-1]]");
    expect(content).toContain("[[recent-2]]");
  });

  it("limits recent docs to 20", () => {
    const dir = mkdtempSync(join(tmpdir(), "gen-test-"));
    const docs = Array.from({ length: 30 }, (_, i) =>
      makeParsedDoc({ id: `doc-${i}`, title: `Doc ${i}`, date: `2026-03-${String(i + 1).padStart(2, "0")}` })
    );
    writeMasterIndex(dir, docs);
    const content = readFileSync(join(dir, "_index.md"), "utf-8");
    const matches = content.match(/\[\[doc-\d+\]\]/g);
    expect(matches).toHaveLength(20);
  });
});

describe("writeQueryReference", () => {
  it("writes Dataview query snippets", () => {
    const dir = mkdtempSync(join(tmpdir(), "gen-test-"));
    writeQueryReference(dir);
    const content = readFileSync(join(dir, "_queries.md"), "utf-8");
    expect(content).toContain("# Knowledge Queries");
    expect(content).toContain("```dataview");
    expect(content).toContain("type = \"research\"");
    expect(content).toContain("generated: true");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugin/ralph-knowledge && npx vitest run src/__tests__/generate-indexes.test.ts`
Expected: FAIL — functions not exported

- [ ] **Step 3: Implement writeMasterIndex and writeQueryReference**

Add to `generate-indexes.ts`:

```typescript
const RECENT_LIMIT = 20;

export function writeMasterIndex(outDir: string, allDocs: ParsedDocument[]): void {
  const sorted = [...allDocs].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  const recent = sorted.slice(0, RECENT_LIMIT);

  const lines: string[] = [
    frontmatter({ generated: true, updated: new Date().toISOString().slice(0, 10) }),
    "# Knowledge Index\n",
    "## Browse by Type\n",
    "- [[_research]] — Research documents",
    "- [[_plans]] — Implementation plans",
    "- [[_ideas]] — Ideas and drafts",
    "- [[_reviews]] — Code and plan reviews",
    "- [[_reports]] — Status reports",
    "- [[_queries]] — Dataview query snippets",
    "",
  ];

  if (recent.length > 0) {
    lines.push("## Recent Documents\n");
    for (const doc of recent) {
      const type = doc.type ? `[${doc.type}]` : "";
      const issue = doc.githubIssue ? ` #${doc.githubIssue}` : "";
      lines.push(`- [[${doc.id}]] ${type}${issue} — ${doc.title}`);
    }
    lines.push("");
  }

  writeFileSync(join(outDir, "_index.md"), lines.join("\n"));
}

export function writeQueryReference(outDir: string): void {
  const content = `${frontmatter({ generated: true, updated: new Date().toISOString().slice(0, 10) })}
# Knowledge Queries

Pre-built Dataview queries. Copy any query block into a note to use it.
Requires the [Dataview](https://github.com/blacksmithgu/obsidian-dataview) community plugin.

## All Research by Date

\`\`\`dataview
TABLE status, tags, github_issue as "Issue"
FROM "."
WHERE type = "research"
SORT date DESC
\`\`\`

## Plans by Status

\`\`\`dataview
TABLE status, github_issue as "Issue", date
FROM "."
WHERE type = "plan"
SORT date DESC
\`\`\`

## Documents by Tag

Replace \`"mcp-server"\` with your tag of interest:

\`\`\`dataview
TABLE type, status, date
FROM "."
WHERE contains(tags, "mcp-server")
SORT date DESC
\`\`\`

## Documents by Issue Number

Replace \`564\` with your issue number:

\`\`\`dataview
TABLE type, status, date
FROM "."
WHERE github_issue = 564
SORT type ASC
\`\`\`

## Draft Documents (Active Work)

\`\`\`dataview
TABLE type, github_issue as "Issue", date
FROM "."
WHERE status = "draft" AND !generated
SORT date DESC
\`\`\`

## Superseded Documents

\`\`\`dataview
TABLE superseded_by, date
FROM "."
WHERE status = "superseded"
SORT date DESC
\`\`\`

## Recently Modified

\`\`\`dataview
TABLE type, status, github_issue as "Issue"
FROM "."
WHERE !generated
SORT file.mtime DESC
LIMIT 20
\`\`\`

## Issues with Research but No Plan

\`\`\`dataview
TABLE date, status
FROM "."
WHERE type = "research" AND github_issue
GROUP BY github_issue
FLATTEN github_issue as issue
WHERE !contains(rows.type, "plan")
\`\`\`
`;

  writeFileSync(join(outDir, "_queries.md"), content);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd plugin/ralph-knowledge && npx vitest run src/__tests__/generate-indexes.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add plugin/ralph-knowledge/src/generate-indexes.ts plugin/ralph-knowledge/src/__tests__/generate-indexes.test.ts
git commit -m "feat(knowledge): add master index and Dataview query reference generation"
```

---

### Task 5: Top-level generateIndexes orchestrator

**Files:**
- Modify: `plugin/ralph-knowledge/src/generate-indexes.ts`
- Modify: `plugin/ralph-knowledge/src/__tests__/generate-indexes.test.ts`

- [ ] **Step 1: Write test for generateIndexes**

Append to `generate-indexes.test.ts`:

```typescript
import { generateIndexes } from "../generate-indexes.js";

describe("generateIndexes", () => {
  it("generates all index files from mixed doc types", () => {
    const dir = mkdtempSync(join(tmpdir(), "gen-test-"));
    const docs = [
      makeParsedDoc({ id: "r1", type: "research", githubIssue: 100 }),
      makeParsedDoc({ id: "p1", type: "plan", githubIssue: 100 }),
      makeParsedDoc({ id: "i1", type: "idea" }),
    ];
    generateIndexes(dir, docs);

    expect(existsSync(join(dir, "_index.md"))).toBe(true);
    expect(existsSync(join(dir, "_research.md"))).toBe(true);
    expect(existsSync(join(dir, "_plans.md"))).toBe(true);
    expect(existsSync(join(dir, "_ideas.md"))).toBe(true);
    expect(existsSync(join(dir, "_reviews.md"))).toBe(true);
    expect(existsSync(join(dir, "_reports.md"))).toBe(true);
    expect(existsSync(join(dir, "_queries.md"))).toBe(true);
    expect(existsSync(join(dir, "_issues", "GH-0100.md"))).toBe(true);
  });

  it("handles empty doc list without errors", () => {
    const dir = mkdtempSync(join(tmpdir(), "gen-test-"));
    expect(() => generateIndexes(dir, [])).not.toThrow();
    expect(existsSync(join(dir, "_index.md"))).toBe(true);
    expect(existsSync(join(dir, "_queries.md"))).toBe(true);
  });

  it("puts docs with null type into uncategorized index", () => {
    const dir = mkdtempSync(join(tmpdir(), "gen-test-"));
    const docs = [
      makeParsedDoc({ id: "no-type", type: null, title: "No Type Doc" }),
      makeParsedDoc({ id: "typed", type: "research", title: "Typed Doc" }),
    ];
    generateIndexes(dir, docs);
    expect(existsSync(join(dir, "_uncategorized.md"))).toBe(true);
    const content = readFileSync(join(dir, "_uncategorized.md"), "utf-8");
    expect(content).toContain("[[no-type]]");
    expect(content).not.toContain("[[typed]]");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugin/ralph-knowledge && npx vitest run src/__tests__/generate-indexes.test.ts`
Expected: FAIL — `generateIndexes` not exported

- [ ] **Step 3: Implement generateIndexes**

Add to `generate-indexes.ts`:

```typescript
const TYPE_INDEX_CONFIG: Array<{ type: string; filename: string; heading: string }> = [
  { type: "research", filename: "research", heading: "Research Documents" },
  { type: "plan", filename: "plans", heading: "Implementation Plans" },
  { type: "idea", filename: "ideas", heading: "Ideas & Drafts" },
  { type: "review", filename: "reviews", heading: "Reviews" },
  { type: "report", filename: "reports", heading: "Reports" },
];

export function generateIndexes(outDir: string, allDocs: ParsedDocument[]): void {
  for (const { type, filename, heading } of TYPE_INDEX_CONFIG) {
    const typeDocs = allDocs.filter((d) => d.type === type);
    writeTypeIndex(outDir, filename, heading, typeDocs);
  }

  // Documents with type: null go into an "uncategorized" index
  const uncategorized = allDocs.filter((d) => d.type === null || !TYPE_INDEX_CONFIG.some((c) => c.type === d.type));
  if (uncategorized.length > 0) {
    writeTypeIndex(outDir, "uncategorized", "Uncategorized Documents", uncategorized);
  }

  writeMasterIndex(outDir, allDocs);
  writeIssueHubs(outDir, allDocs);
  writeQueryReference(outDir);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd plugin/ralph-knowledge && npx vitest run src/__tests__/generate-indexes.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add plugin/ralph-knowledge/src/generate-indexes.ts plugin/ralph-knowledge/src/__tests__/generate-indexes.test.ts
git commit -m "feat(knowledge): add top-level generateIndexes orchestrator"
```

---

## Chunk 2: Reindex Integration

### Task 6: Extract findMarkdownFiles to its own module and skip `_`-prefixed entries

**Files:**
- Create: `plugin/ralph-knowledge/src/file-scanner.ts`
- Modify: `plugin/ralph-knowledge/src/reindex.ts:10-24`
- Modify: `plugin/ralph-knowledge/src/__tests__/generate-indexes.test.ts` (integration test)

Extracting `findMarkdownFiles` to its own module avoids the problem of importing `reindex.ts` in tests (which would trigger the top-level script execution and attempt real database operations).

- [ ] **Step 1: Write integration test for `_`-prefix skipping**

Append to `generate-indexes.test.ts`:

```typescript
import { findMarkdownFiles } from "../file-scanner.js";

describe("findMarkdownFiles", () => {
  it("skips _-prefixed files and directories during scan", () => {
    const dir = mkdtempSync(join(tmpdir(), "gen-test-"));
    // Create a normal doc
    mkdirSync(join(dir, "research"), { recursive: true });
    writeFileSync(join(dir, "research", "real-doc.md"), "---\ntype: research\n---\n# Real\n");
    // Create _-prefixed files that should be skipped
    writeFileSync(join(dir, "_index.md"), "---\ngenerated: true\n---\n# Index\n");
    mkdirSync(join(dir, "_issues"), { recursive: true });
    writeFileSync(join(dir, "_issues", "GH-0042.md"), "---\ngenerated: true\n---\n# Hub\n");

    const files = findMarkdownFiles(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain("real-doc.md");
  });

  it("skips dot-directories", () => {
    const dir = mkdtempSync(join(tmpdir(), "gen-test-"));
    mkdirSync(join(dir, ".obsidian"), { recursive: true });
    writeFileSync(join(dir, ".obsidian", "app.md"), "# Config\n");
    writeFileSync(join(dir, "real.md"), "# Real\n");

    const files = findMarkdownFiles(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain("real.md");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugin/ralph-knowledge && npx vitest run src/__tests__/generate-indexes.test.ts`
Expected: FAIL — `file-scanner.js` module not found

- [ ] **Step 3: Create file-scanner.ts and update reindex.ts**

Create `plugin/ralph-knowledge/src/file-scanner.ts`:

```typescript
import { readdirSync } from "node:fs";
import { join } from "node:path";

export function findMarkdownFiles(dir: string): string[] {
  const results: string[] = [];
  function walk(d: string) {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const fullPath = join(d, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith(".") && !entry.name.startsWith("_")) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".md") && !entry.name.startsWith("_")) {
        results.push(fullPath);
      }
    }
  }
  walk(dir);
  return results;
}
```

In `plugin/ralph-knowledge/src/reindex.ts`, replace the `findMarkdownFiles` function (lines 10-24) with an import:

Remove the entire `findMarkdownFiles` function and add this import at the top:

```typescript
import { findMarkdownFiles } from "./file-scanner.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd plugin/ralph-knowledge && npx vitest run src/__tests__/generate-indexes.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add plugin/ralph-knowledge/src/reindex.ts plugin/ralph-knowledge/src/__tests__/generate-indexes.test.ts
git commit -m "fix(knowledge): skip _-prefixed files and dirs in reindexer to prevent feedback loop"
```

---

### Task 7: Integrate generateIndexes into reindex pipeline

**Files:**
- Modify: `plugin/ralph-knowledge/src/reindex.ts`

- [ ] **Step 1: Add generation phase and --no-generate flag to reindex.ts**

In `plugin/ralph-knowledge/src/reindex.ts`, add the import at the top (after existing imports):

```typescript
import { generateIndexes } from "./generate-indexes.js";
```

Modify the `reindex` function signature to accept a `generate` flag:

```typescript
async function reindex(thoughtsDir: string, dbPath: string, generate: boolean): Promise<void> {
```

Collect parsed docs during the indexing loop to avoid double-parsing. Change the indexing loop (lines 41-80) to collect parsed docs:

```typescript
  const parsedDocs: ParsedDocument[] = [];
  let indexed = 0;
  for (const filePath of files) {
    const raw = readFileSync(filePath, "utf-8");
    const relPath = relative(join(thoughtsDir, ".."), filePath);
    const id = basename(filePath, ".md");

    const parsed = parseDocument(id, relPath, raw);
    parsedDocs.push(parsed);

    // ... rest of loop unchanged (db.upsertDocument, tags, relationships, embedding) ...
  }
```

Then after `fts.rebuildIndex()`:

```typescript
  if (generate) {
    console.log("Generating index notes...");
    generateIndexes(thoughtsDir, parsedDocs);
    console.log("Index notes generated.");
  }
```

Update the CLI section (lines 90-92) to parse the `--no-generate` flag:

```typescript
const args = process.argv.slice(2);
const noGenerate = args.includes("--no-generate");
const positional = args.filter((a) => !a.startsWith("--"));
const thoughtsDir = positional[0] ?? "../../thoughts";
const dbPath = positional[1] ?? DEFAULT_DB_PATH;
reindex(thoughtsDir, dbPath, !noGenerate).catch(console.error);
```

- [ ] **Step 2: Run the full test suite**

Run: `cd plugin/ralph-knowledge && npx vitest run`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add plugin/ralph-knowledge/src/reindex.ts
git commit -m "feat(knowledge): integrate index note generation into reindex pipeline"
```

---

### Task 8: Add frontmatter validation warnings

**Files:**
- Modify: `plugin/ralph-knowledge/src/reindex.ts`

- [ ] **Step 1: Add validation warnings after parsing**

In the indexing loop in `reindex.ts`, after `const parsed = parseDocument(...)` and `parsedDocs.push(parsed)`, add:

```typescript
    const missing: string[] = [];
    if (!parsed.date) missing.push("date");
    if (!parsed.type) missing.push("type");
    if (!parsed.status) missing.push("status");
    if (missing.length > 0) {
      console.warn(`  Warning: ${id} missing frontmatter: ${missing.join(", ")}`);
    }
```

- [ ] **Step 2: Run the full test suite**

Run: `cd plugin/ralph-knowledge && npx vitest run`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add plugin/ralph-knowledge/src/reindex.ts
git commit -m "feat(knowledge): add frontmatter validation warnings during reindex"
```

---

## Chunk 3: Setup Skill & Onboarding

### Task 9: Create setup-obsidian skill

**Files:**
- Create: `plugin/ralph-knowledge/skills/setup-obsidian/SKILL.md`

- [ ] **Step 1: Write the setup-obsidian skill**

Create `plugin/ralph-knowledge/skills/setup-obsidian/SKILL.md`:

```markdown
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
```

- [ ] **Step 2: Commit**

```bash
git add plugin/ralph-knowledge/skills/setup-obsidian/SKILL.md
git commit -m "feat(knowledge): add setup-obsidian skill for Obsidian vault provisioning"
```

---

### Task 10: Update existing setup skill to suggest Obsidian

**Files:**
- Modify: `plugin/ralph-knowledge/skills/setup/SKILL.md:85-100`

- [ ] **Step 1: Add Obsidian suggestion to Step 5 summary**

In `plugin/ralph-knowledge/skills/setup/SKILL.md`, modify Step 5 Summary. After the closing triple-backtick of the summary block (after line 100), add:

```markdown

Then suggest:
```
Want to browse your knowledge documents in Obsidian?
Run /ralph-knowledge:setup-obsidian to set up navigational indexes and vault config.
```
```

- [ ] **Step 2: Commit**

```bash
git add plugin/ralph-knowledge/skills/setup/SKILL.md
git commit -m "feat(knowledge): suggest setup-obsidian after successful index setup"
```

---

### Task 11: Final integration test — run reindex on real thoughts directory

- [ ] **Step 1: Build the package**

Run: `cd plugin/ralph-knowledge && npm run build`
Expected: Clean build, no errors

- [ ] **Step 2: Run full test suite**

Run: `cd plugin/ralph-knowledge && npx vitest run`
Expected: All tests PASS

- [ ] **Step 3: Run reindex locally on actual thoughts directory**

Run: `cd plugin/ralph-knowledge && node dist/reindex.js ../../thoughts`
Expected: Indexes all documents, generates `_index.md`, type indexes, `_issues/` hubs, `_queries.md`. No errors. Verify:

```bash
ls ../../thoughts/_index.md ../../thoughts/_research.md ../../thoughts/_queries.md ../../thoughts/_issues/ | head -20
cat ../../thoughts/_index.md | head -30
```

- [ ] **Step 4: Verify reindex doesn't index generated files**

Run reindex a second time: `cd plugin/ralph-knowledge && node dist/reindex.js ../../thoughts`
Expected: Same document count as first run (generated `_`-prefixed files not counted)

- [ ] **Step 5: Commit any final fixes**

If any issues were found during integration testing, fix and commit.
