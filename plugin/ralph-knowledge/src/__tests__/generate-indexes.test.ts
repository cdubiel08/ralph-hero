import { describe, it, expect } from "vitest";
import { formatIssueNumber, frontmatter, writeTypeIndex, writeIssueHubs } from "../generate-indexes.js";
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
