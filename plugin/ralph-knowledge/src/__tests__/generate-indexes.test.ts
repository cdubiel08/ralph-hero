import { describe, it, expect } from "vitest";
import { formatIssueNumber, frontmatter, writeTypeIndex, writeIssueHubs, writeMasterIndex, writeQueryReference, generateIndexes } from "../generate-indexes.js";
import { findMarkdownFiles } from "../file-scanner.js";
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
    expect(result).toBe("---\ngenerated: true\nupdated: 2026-03-14\n---\n");
  });
});

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

  it("includes uncategorized link when hasUncategorized is true", () => {
    const dir = mkdtempSync(join(tmpdir(), "gen-test-"));
    writeMasterIndex(dir, [], true);
    const content = readFileSync(join(dir, "_index.md"), "utf-8");
    expect(content).toContain("[[_uncategorized]]");
  });

  it("omits uncategorized link when hasUncategorized is false", () => {
    const dir = mkdtempSync(join(tmpdir(), "gen-test-"));
    writeMasterIndex(dir, [], false);
    const content = readFileSync(join(dir, "_index.md"), "utf-8");
    expect(content).not.toContain("[[_uncategorized]]");
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
    // _index.md should link to _uncategorized when it exists
    const index = readFileSync(join(dir, "_index.md"), "utf-8");
    expect(index).toContain("[[_uncategorized]]");
  });

  it("does not link _uncategorized in index when all docs are typed", () => {
    const dir = mkdtempSync(join(tmpdir(), "gen-test-"));
    const docs = [
      makeParsedDoc({ id: "r1", type: "research" }),
    ];
    generateIndexes(dir, docs);
    const index = readFileSync(join(dir, "_index.md"), "utf-8");
    expect(index).not.toContain("[[_uncategorized]]");
  });
});

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
