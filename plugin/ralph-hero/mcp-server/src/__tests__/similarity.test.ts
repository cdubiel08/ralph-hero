/**
 * Tests for similarity scoring and keyword extraction.
 *
 * All functions under test are pure (no I/O), so no mocking is needed.
 */

import { describe, it, expect } from "vitest";
import {
  diceSorensen,
  extractSearchKeywords,
  scoreCandidates,
  STOP_WORDS,
} from "../lib/similarity.js";

// ---------------------------------------------------------------------------
// diceSorensen
// ---------------------------------------------------------------------------

describe("diceSorensen", () => {
  it("returns 1.0 for identical strings", () => {
    expect(diceSorensen("hello world", "hello world")).toBe(1.0);
  });

  it("returns 1.0 for case-insensitive identical strings", () => {
    expect(diceSorensen("Hello World", "hello world")).toBe(1.0);
  });

  it("returns ~0 for completely different strings", () => {
    const score = diceSorensen("abcdef", "xyz123");
    expect(score).toBeLessThan(0.1);
  });

  it("returns moderate score for similar strings", () => {
    const score = diceSorensen("pipeline analytics", "pipeline metrics");
    expect(score).toBeGreaterThan(0.4);
  });

  it("returns 0 for empty string", () => {
    expect(diceSorensen("", "hello")).toBe(0.0);
    expect(diceSorensen("hello", "")).toBe(0.0);
  });

  it("returns 0 for single character strings", () => {
    expect(diceSorensen("a", "b")).toBe(0.0);
    expect(diceSorensen("a", "ab")).toBe(0.0);
  });

  it("returns moderate score for substring match", () => {
    const score = diceSorensen("auth", "authentication");
    expect(score).toBeGreaterThan(0.3);
    expect(score).toBeLessThan(1.0);
  });

  it("returns high score for near-duplicates", () => {
    const score = diceSorensen(
      "Add user authentication flow",
      "Add user authentication",
    );
    expect(score).toBeGreaterThan(0.7);
  });

  it("handles whitespace trimming", () => {
    expect(diceSorensen("  hello  ", "hello")).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// extractSearchKeywords
// ---------------------------------------------------------------------------

describe("extractSearchKeywords", () => {
  it("filters stop words", () => {
    const keywords = extractSearchKeywords(
      "Add new authentication for users",
    );
    expect(keywords).not.toContain("Add");
    expect(keywords).not.toContain("new");
    expect(keywords).not.toContain("for");
    expect(keywords.toLowerCase()).toContain("authentication");
    expect(keywords.toLowerCase()).toContain("users");
  });

  it("respects 5-word limit from title", () => {
    const keywords = extractSearchKeywords(
      "first second third fourth fifth sixth seventh",
    );
    const words = keywords.split(" ");
    expect(words.length).toBeLessThanOrEqual(5);
  });

  it("handles empty body gracefully", () => {
    const keywords = extractSearchKeywords("Test title", "");
    expect(keywords).toBeTruthy();
  });

  it("handles undefined body gracefully", () => {
    const keywords = extractSearchKeywords("Test title");
    expect(keywords).toBeTruthy();
  });

  it("truncates to 200 chars", () => {
    const longTitle =
      "VeryLongWord".repeat(20) + " " + "AnotherLongWord".repeat(20);
    const keywords = extractSearchKeywords(longTitle);
    expect(keywords.length).toBeLessThanOrEqual(200);
  });

  it("strips punctuation", () => {
    const keywords = extractSearchKeywords("Fix: crash on login!");
    expect(keywords).not.toContain(":");
    expect(keywords).not.toContain("!");
    expect(keywords.toLowerCase()).toContain("fix");
    expect(keywords.toLowerCase()).toContain("crash");
    expect(keywords.toLowerCase()).toContain("login");
  });

  it("extracts keywords from body section headers", () => {
    const keywords = extractSearchKeywords(
      "Short title",
      "## Implementation Details\n## Testing Strategy",
    );
    // Should include some body keywords
    expect(keywords.toLowerCase()).toContain("implementation");
  });

  it("filters single-character tokens", () => {
    const keywords = extractSearchKeywords("A B C authentication");
    expect(keywords.toLowerCase()).toContain("authentication");
    // Single chars should be filtered
    const words = keywords.split(" ");
    expect(words.every((w) => w.length > 1)).toBe(true);
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

  it("does not contain content words", () => {
    expect(STOP_WORDS.has("authentication")).toBe(false);
    expect(STOP_WORDS.has("pipeline")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// scoreCandidates
// ---------------------------------------------------------------------------

describe("scoreCandidates", () => {
  const candidates = [
    { number: 1, title: "Add user authentication" },
    { number: 2, title: "Add user auth flow" },
    { number: 3, title: "Completely different topic" },
    { number: 4, title: "Add user authentication system" },
  ];

  it("scores candidates by title similarity", () => {
    const results = scoreCandidates(
      "Add user authentication",
      99,
      candidates,
      0.0,
      10,
    );
    // Candidate #1 should have score 1.0 (exact match)
    const exactMatch = results.find((r) => r.number === 1);
    expect(exactMatch?.score).toBe(1.0);
  });

  it("excludes self from results", () => {
    const results = scoreCandidates(
      "Add user authentication",
      1, // Same as candidate #1
      candidates,
      0.0,
      10,
    );
    expect(results.find((r) => r.number === 1)).toBeUndefined();
  });

  it("filters candidates below threshold", () => {
    const results = scoreCandidates(
      "Add user authentication",
      99,
      candidates,
      0.8,
      10,
    );
    // Only highly similar candidates should remain
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0.8);
    }
  });

  it("sorts by score descending", () => {
    const results = scoreCandidates(
      "Add user authentication",
      99,
      candidates,
      0.0,
      10,
    );
    for (let i = 1; i < results.length; i++) {
      expect(results[i].score).toBeLessThanOrEqual(results[i - 1].score);
    }
  });

  it("limits to maxCandidates", () => {
    const results = scoreCandidates(
      "Add user authentication",
      99,
      candidates,
      0.0,
      2,
    );
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it("returns empty array for empty candidates", () => {
    const results = scoreCandidates("test", 99, [], 0.0, 10);
    expect(results).toHaveLength(0);
  });

  it("threshold of 0.0 returns all non-self candidates", () => {
    const results = scoreCandidates(
      "Add user authentication",
      99,
      candidates,
      0.0,
      100,
    );
    expect(results.length).toBe(candidates.length);
  });

  it("threshold of 1.0 returns only exact title matches", () => {
    const results = scoreCandidates(
      "Add user authentication",
      99,
      candidates,
      1.0,
      10,
    );
    expect(results.length).toBe(1);
    expect(results[0].number).toBe(1);
  });

  it("rounds scores to 3 decimal places", () => {
    const results = scoreCandidates(
      "Add user authentication",
      99,
      candidates,
      0.0,
      10,
    );
    for (const r of results) {
      const decimalPlaces = r.score.toString().split(".")[1]?.length || 0;
      expect(decimalPlaces).toBeLessThanOrEqual(3);
    }
  });
});
