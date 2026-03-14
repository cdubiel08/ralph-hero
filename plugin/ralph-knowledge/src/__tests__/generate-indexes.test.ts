import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  formatIssueNumber,
  frontmatter,
} from "../generate-indexes.js";
import type { ParsedDocument } from "../parser.js";

// ── Helpers for building test documents ──────────────────────────────

function makeDoc(overrides: Partial<ParsedDocument> = {}): ParsedDocument {
  return {
    id: overrides.id ?? "2026-03-01-test-doc",
    path: overrides.path ?? "thoughts/shared/research/2026-03-01-test-doc.md",
    title: overrides.title ?? "Test Document",
    date: overrides.date ?? "2026-03-01",
    type: overrides.type ?? "research",
    status: overrides.status ?? "draft",
    githubIssue: overrides.githubIssue ?? null,
    tags: overrides.tags ?? [],
    relationships: overrides.relationships ?? [],
    content: overrides.content ?? "Test content.",
  };
}

// ── Task 1: Helpers ─────────────────────────────────────────────────

describe("formatIssueNumber", () => {
  it("zero-pads numbers under 5 digits to 4 digits", () => {
    expect(formatIssueNumber(1)).toBe("GH-0001");
    expect(formatIssueNumber(42)).toBe("GH-0042");
    expect(formatIssueNumber(999)).toBe("GH-0999");
    expect(formatIssueNumber(9999)).toBe("GH-9999");
  });

  it("does not pad numbers with 5 or more digits", () => {
    expect(formatIssueNumber(10000)).toBe("GH-10000");
    expect(formatIssueNumber(12345)).toBe("GH-12345");
    expect(formatIssueNumber(100000)).toBe("GH-100000");
  });
});

describe("frontmatter", () => {
  it("generates YAML frontmatter with delimiters", () => {
    const result = frontmatter({ title: "My Title", date: "2026-03-01" });
    expect(result).toContain("---");
    expect(result).toMatch(/^---\n/);
    expect(result).toMatch(/\n---\n$/);
    expect(result).toContain("title: My Title");
    expect(result).toContain("date: 2026-03-01");
  });

  it("handles array fields", () => {
    const result = frontmatter({ tags: ["a", "b", "c"] });
    expect(result).toContain("tags:");
    // yaml stringify arrays as block or flow style
    expect(result).toMatch(/a/);
    expect(result).toMatch(/b/);
    expect(result).toMatch(/c/);
  });

  it("handles empty fields object", () => {
    const result = frontmatter({});
    expect(result).toBe("---\n{}\n---\n");
  });
});
