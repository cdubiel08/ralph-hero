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
    expect(result).toBe("---\ngenerated: true\nupdated: 2026-03-14\n---\n");
  });
});
