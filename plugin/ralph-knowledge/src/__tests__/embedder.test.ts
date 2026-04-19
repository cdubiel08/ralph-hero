import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @huggingface/transformers so we don't need to load the real ONNX
// model during unit tests. The fake pipeline returns a constant 384-dim
// vector; we track call count via the `embedCalls` array below.
const embedCalls: string[] = [];
vi.mock("@huggingface/transformers", () => {
  const fakePipeline = async (text: string, _opts: unknown) => {
    embedCalls.push(text);
    return { data: new Float32Array(384) };
  };
  return {
    pipeline: vi.fn(async () => fakePipeline),
  };
});

import { prepareTextForEmbedding, embedDocument } from "../embedder.js";

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

  it("no longer truncates at 500 chars (MAX_CHARS removed)", () => {
    const longParagraph = "A".repeat(600);
    const result = prepareTextForEmbedding(
      "Title",
      ["tag1", "tag2"],
      longParagraph,
    );
    // Title (5) + \n + tag1, tag2 (10) + \n + 600 A's = 617 chars
    expect(result.length).toBe(617);
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

describe("embedDocument", () => {
  beforeEach(() => {
    embedCalls.length = 0;
  });

  it("returns exactly one chunk for short content", async () => {
    const result = await embedDocument("Title", ["tag"], "short content");
    expect(result).toHaveLength(1);
    expect(result[0]!.index).toBe(0);
    expect(result[0]!.content).toBe("short content");
    expect(result[0]!.charStart).toBe(0);
    expect(result[0]!.charEnd).toBe("short content".length);
    expect(result[0]!.embedding).toBeInstanceOf(Float32Array);
  });

  it("embeds with title + tagLine + chunk.content prepended", async () => {
    await embedDocument("My Title", ["graphology", "search"], "body text");
    expect(embedCalls).toHaveLength(1);
    expect(embedCalls[0]).toBe("My Title\ngraphology, search\nbody text");
  });

  it("omits empty title/tags/content from the embed input", async () => {
    await embedDocument("", [], "only content here");
    expect(embedCalls).toContain("only content here");

    embedCalls.length = 0;
    await embedDocument("Just Title", [], "");
    // Empty content -> one chunk with empty string, only title is non-empty.
    expect(embedCalls).toContain("Just Title");
  });

  it("yields >= 4 chunks for an 8K-char document", async () => {
    const longContent = "A".repeat(8000);
    const result = await embedDocument("Title", [], longContent);
    expect(result.length).toBeGreaterThanOrEqual(4);
    // Each chunk gets its own embedding.
    expect(embedCalls).toHaveLength(result.length);
  });

  it("produces Float32Array embeddings of length 384", async () => {
    const result = await embedDocument("T", [], "hello world");
    expect(result[0]!.embedding).toBeInstanceOf(Float32Array);
    expect(result[0]!.embedding.length).toBe(384);
  });

  it("chunk indexes are monotonically increasing from 0", async () => {
    const longContent = "word ".repeat(3000); // ~15K chars, many chunks
    const result = await embedDocument("T", [], longContent);
    expect(result.length).toBeGreaterThan(1);
    for (let i = 0; i < result.length; i++) {
      expect(result[i]!.index).toBe(i);
    }
  });

  it("chunk offsets reconstruct the original content", async () => {
    const content = "A".repeat(5000);
    const result = await embedDocument("T", [], content);
    for (const chunk of result) {
      expect(content.slice(chunk.charStart, chunk.charEnd)).toBe(chunk.content);
    }
  });

  it("empty content yields one chunk with empty content (anchors on title/tags)", async () => {
    const result = await embedDocument("Just Title", ["some-tag"], "");
    expect(result).toHaveLength(1);
    expect(result[0]!.content).toBe("");
    expect(result[0]!.charStart).toBe(0);
    expect(result[0]!.charEnd).toBe(0);
    // Still got embedded using title + tag.
    expect(embedCalls).toContain("Just Title\nsome-tag");
  });

  it("respects custom chunker options", async () => {
    const content = "A".repeat(500);
    const result = await embedDocument("T", [], content, {
      chunkSize: 100,
      chunkOverlap: 10,
    });
    // With chunkSize=100 over 500 chars, we expect multiple chunks.
    expect(result.length).toBeGreaterThan(1);
  });
});
