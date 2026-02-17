import { describe, it, expect } from "vitest";
import {
  diceSorensen,
  extractSearchKeywords,
  STOP_WORDS,
} from "../lib/similarity.js";

// ---------------------------------------------------------------------------
// diceSorensen
// ---------------------------------------------------------------------------

describe("diceSorensen", () => {
  it("returns 1.0 for identical strings", () => {
    expect(diceSorensen("pipeline analytics", "pipeline analytics")).toBe(1.0);
  });

  it("returns 1.0 for case-insensitive identical strings", () => {
    expect(diceSorensen("Hello", "hello")).toBe(1.0);
  });

  it("returns ~0.0 for completely different strings", () => {
    expect(diceSorensen("abcdef", "xyz123")).toBeLessThan(0.1);
  });

  it("returns moderate score for similar strings", () => {
    const score = diceSorensen("pipeline analytics", "pipeline metrics");
    expect(score).toBeGreaterThan(0.4);
    expect(score).toBeLessThan(1.0);
  });

  it("returns moderate score for substring relationship", () => {
    const score = diceSorensen("auth", "authentication");
    expect(score).toBeGreaterThan(0.2);
    expect(score).toBeLessThan(0.8);
  });

  it("returns 0.0 for empty string", () => {
    expect(diceSorensen("", "hello")).toBe(0.0);
  });

  it("returns 0.0 for single character strings", () => {
    expect(diceSorensen("a", "b")).toBe(0.0);
  });

  it("returns 1.0 for both empty strings (identical)", () => {
    // Empty strings are equal — identity check returns 1.0 before length check
    expect(diceSorensen("", "")).toBe(1.0);
  });

  it("handles whitespace trimming", () => {
    expect(diceSorensen("  hello  ", "hello")).toBe(1.0);
  });

  it("returns value between 0 and 1", () => {
    const score = diceSorensen("duplicate detection", "duplicate issue finder");
    expect(score).toBeGreaterThanOrEqual(0.0);
    expect(score).toBeLessThanOrEqual(1.0);
  });
});

// ---------------------------------------------------------------------------
// extractSearchKeywords
// ---------------------------------------------------------------------------

describe("extractSearchKeywords", () => {
  it("filters stop words", () => {
    const result = extractSearchKeywords(
      "Add new authentication for users",
    );
    expect(result).not.toContain("add");
    expect(result).not.toContain("new");
    expect(result).not.toContain("for");
    expect(result).toContain("authentication");
    expect(result).toContain("users");
  });

  it("respects 5-word limit from title", () => {
    const result = extractSearchKeywords(
      "implement smart duplicate detection during triage using semantic similarity",
    );
    const words = result.split(" ");
    // 5 from title max (after stop word removal)
    expect(words.length).toBeLessThanOrEqual(8); // 5 title + up to 3 body
  });

  it("handles empty body gracefully", () => {
    const result = extractSearchKeywords("pipeline analytics dashboard");
    expect(result).toBe("pipeline analytics dashboard");
  });

  it("handles undefined body", () => {
    const result = extractSearchKeywords("pipeline analytics", undefined);
    expect(result).toBe("pipeline analytics");
  });

  it("strips punctuation", () => {
    const result = extractSearchKeywords("Fix: crash on login!");
    expect(result).toContain("fix");
    expect(result).toContain("crash");
    expect(result).toContain("login");
    expect(result).not.toContain(":");
    expect(result).not.toContain("!");
  });

  it("extracts keywords from body section headers", () => {
    const result = extractSearchKeywords(
      "Smart detection",
      "## Motivation\n\nSome text\n\n## Implementation\n\nMore text",
    );
    expect(result).toContain("smart");
    expect(result).toContain("detection");
    expect(result).toContain("motivation");
    expect(result).toContain("implementation");
  });

  it("deduplicates between title and body keywords", () => {
    const result = extractSearchKeywords(
      "pipeline dashboard",
      "## Pipeline Overview\n\nDetails here",
    );
    const words = result.split(" ");
    const pipelineCount = words.filter((w) => w === "pipeline").length;
    expect(pipelineCount).toBe(1);
  });

  it("truncates to 200 chars", () => {
    const longTitle = Array(50).fill("longword").join(" ");
    const result = extractSearchKeywords(longTitle);
    expect(result.length).toBeLessThanOrEqual(200);
  });

  it("filters single-character tokens", () => {
    const result = extractSearchKeywords("A B C real words here");
    expect(result).not.toContain(" b ");
    expect(result).not.toContain(" c ");
    expect(result).toContain("real");
    expect(result).toContain("words");
  });
});

// ---------------------------------------------------------------------------
// STOP_WORDS
// ---------------------------------------------------------------------------

describe("STOP_WORDS", () => {
  it("contains common English stop words", () => {
    expect(STOP_WORDS.has("the")).toBe(true);
    expect(STOP_WORDS.has("is")).toBe(true);
    expect(STOP_WORDS.has("and")).toBe(true);
  });

  it("contains action verbs that are noise in issue titles", () => {
    expect(STOP_WORDS.has("add")).toBe(true);
    expect(STOP_WORDS.has("new")).toBe(true);
    expect(STOP_WORDS.has("use")).toBe(true);
  });

  it("does not contain technical terms", () => {
    expect(STOP_WORDS.has("pipeline")).toBe(false);
    expect(STOP_WORDS.has("authentication")).toBe(false);
    expect(STOP_WORDS.has("duplicate")).toBe(false);
  });
});
