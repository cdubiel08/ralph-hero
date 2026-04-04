import { describe, it, expect } from "vitest";
import { prepareTextForEmbedding } from "../embedder.js";

describe("prepareTextForEmbedding", () => {
  it("includes title, tags, and first paragraph", () => {
    const result = prepareTextForEmbedding(
      "My Title",
      ["graphology", "search"],
      "First paragraph.\n\nSecond paragraph.",
    );
    expect(result).toBe("My Title\ngraphology, search\nFirst paragraph.");
  });

  it("extracts first paragraph by splitting on blank lines", () => {
    const result = prepareTextForEmbedding(
      "Title",
      [],
      "First paragraph here.\n\nSecond paragraph.\n\nThird paragraph.",
    );
    expect(result).toBe("Title\nFirst paragraph here.");
  });

  it("skips leading blank lines to find first non-empty paragraph", () => {
    const result = prepareTextForEmbedding(
      "Title",
      ["tag1"],
      "\n\nActual first paragraph.\n\nSecond.",
    );
    expect(result).toBe("Title\ntag1\nActual first paragraph.");
  });

  it("produces no blank line when tags array is empty", () => {
    const result = prepareTextForEmbedding(
      "My Title",
      [],
      "Content here.\n\nMore content.",
    );
    expect(result).toBe("My Title\nContent here.");
    // Verify there is no blank line between title and content
    expect(result).not.toContain("\n\n");
  });

  it("truncates at MAX_CHARS (500) total", () => {
    const longParagraph = "A".repeat(600);
    const result = prepareTextForEmbedding(
      "Title",
      ["tag1", "tag2"],
      longParagraph,
    );
    expect(result.length).toBe(500);
    expect(result.startsWith("Title\ntag1, tag2\n")).toBe(true);
  });

  it("uses only first paragraph, not full content", () => {
    const result = prepareTextForEmbedding(
      "Title",
      ["tag"],
      "Short first para.\n\nThis is a much longer second paragraph that should not appear in the output.",
    );
    expect(result).toBe("Title\ntag\nShort first para.");
    expect(result).not.toContain("second paragraph");
  });

  it("handles content with no blank lines (single paragraph)", () => {
    const result = prepareTextForEmbedding(
      "Title",
      ["a", "b"],
      "Just one paragraph with no blank lines.",
    );
    expect(result).toBe("Title\na, b\nJust one paragraph with no blank lines.");
  });

  it("handles empty content", () => {
    const result = prepareTextForEmbedding("Title", ["tag"], "");
    expect(result).toBe("Title\ntag");
  });

  it("handles empty title, tags, and content", () => {
    const result = prepareTextForEmbedding("", [], "");
    expect(result).toBe("");
  });

  it("trims whitespace from first paragraph", () => {
    const result = prepareTextForEmbedding(
      "Title",
      [],
      "  Paragraph with leading/trailing spaces.  \n\nSecond.",
    );
    expect(result).toBe("Title\nParagraph with leading/trailing spaces.");
  });

  it("matches the exact example from the plan success criteria", () => {
    const result = prepareTextForEmbedding(
      "My Title",
      ["graphology", "search"],
      "First paragraph.\n\nSecond paragraph.",
    );
    expect(result).toBe("My Title\ngraphology, search\nFirst paragraph.");
  });
});
