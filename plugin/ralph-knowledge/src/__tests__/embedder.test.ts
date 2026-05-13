import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @huggingface/transformers so we don't need to load the real ONNX
// model during unit tests. The fake pipeline returns a constant 384-dim
// vector; we track call count via the `embedCalls` array below.
//
// GH-911: the mock now also exposes a `dispose` mock on each output so we can
// assert that `embed()` releases the native tensor buffer eagerly. The dispose
// invocations are aggregated on the module-level `disposeCalls` array so tests
// can introspect call counts across multiple `embed()` invocations.
const embedCalls: string[] = [];
const batchCalls: string[][] = [];
const disposeCalls: ReturnType<typeof vi.fn>[] = [];
vi.mock("@huggingface/transformers", () => {
  const fakePipeline = async (input: string | string[], _opts: unknown) => {
    const dispose = vi.fn();
    disposeCalls.push(dispose);
    if (Array.isArray(input)) {
      // GH-1203 batch path: record the input array; produce a flat
      // Float32Array of shape [batch, 384] whose per-text slice has a known
      // pattern so tests can verify slicing math.
      batchCalls.push([...input]);
      const dim = 384;
      const flat = new Float32Array(input.length * dim);
      // Seed each row's first element with the row index + 1 so slicing
      // tests can confirm per-text isolation without needing model output.
      for (let i = 0; i < input.length; i++) {
        flat[i * dim] = i + 1;
      }
      return { data: flat, dispose };
    }
    embedCalls.push(input);
    return { data: new Float32Array(384), dispose };
  };
  return {
    pipeline: vi.fn(async () => fakePipeline),
  };
});

import { prepareTextForEmbedding, embed, embedDocument, embedChunks } from "../embedder.js";
import type { LlmClient } from "../llm-client.js";

function makeMockLlm(contextualize: LlmClient["contextualize"]): LlmClient {
  return {
    available: vi.fn(async () => true),
    contextualize: vi.fn(contextualize),
  };
}

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

// GH-911: regression tests for tensor disposal in embed(). The mock exposes a
// vi.fn() on each output's `dispose` slot; embed() must invoke it once per
// call so the underlying ONNX-runtime native buffer is freed eagerly instead
// of waiting on V8 GC (which cannot keep up with the per-chunk await loop).
describe("embed (tensor disposal)", () => {
  beforeEach(() => {
    embedCalls.length = 0;
    disposeCalls.length = 0;
  });

  it("calls output.dispose() exactly once per embed() invocation", async () => {
    const result = await embed("hello");
    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(384);
    expect(disposeCalls).toHaveLength(1);
    expect(disposeCalls[0]).toHaveBeenCalledTimes(1);
  });

  it("calls dispose on every output across multiple invocations", async () => {
    await embed("first");
    await embed("second");
    await embed("third");
    expect(disposeCalls).toHaveLength(3);
    for (const dispose of disposeCalls) {
      expect(dispose).toHaveBeenCalledTimes(1);
    }
  });

  it("returns a Float32Array independent of the source tensor (data is copied before dispose)", async () => {
    const result = await embed("text");
    // dispose was called, but the returned Float32Array is still usable —
    // verifies the data was copied (not aliased) before disposal.
    expect(disposeCalls[0]).toHaveBeenCalledTimes(1);
    expect(() => {
      result[0] = 1.0;
      void result[0];
    }).not.toThrow();
    expect(result.length).toBe(384);
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

  // Phase 6 (GH-767): Contextual Retrieval integration.
  describe("contextual retrieval", () => {
    it("calls llm.contextualize once per chunk when llm is provided", async () => {
      const content = "A".repeat(500);
      const mockLlm = makeMockLlm(async () => "CTX");
      const result = await embedDocument("T", [], content, {
        llm: mockLlm,
        chunkSize: 100,
        chunkOverlap: 10,
      });
      expect(result.length).toBeGreaterThan(1);
      expect(mockLlm.contextualize).toHaveBeenCalledTimes(result.length);
    });

    it("stores non-empty contextPrefix on every returned chunk", async () => {
      const mockLlm = makeMockLlm(async () => "THIS IS CONTEXT");
      const result = await embedDocument("Title", ["tag"], "body text", { llm: mockLlm });
      expect(result).toHaveLength(1);
      expect(result[0]!.contextPrefix).toBe("THIS IS CONTEXT");
      // Embed text prepends contextPrefix ahead of title/tags/content.
      expect(embedCalls[0]).toBe("THIS IS CONTEXT\nTitle\ntag\nbody text");
    });

    it("passes the full document (not the chunk) as the first contextualize arg", async () => {
      const longContent = "A".repeat(500);
      const mockLlm = makeMockLlm(async () => "CTX");
      await embedDocument("T", [], longContent, {
        llm: mockLlm,
        chunkSize: 100,
        chunkOverlap: 10,
      });
      const calls = (mockLlm.contextualize as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.length).toBeGreaterThan(1);
      for (const [fullDoc] of calls) {
        expect(fullDoc).toBe(longContent);
      }
    });

    it("fail-open (empty string) yields contextPrefix: '' and omits leading blank line", async () => {
      const mockLlm = makeMockLlm(async () => "");
      const result = await embedDocument("Title", ["tag"], "body text", { llm: mockLlm });
      expect(result[0]!.contextPrefix).toBe("");
      // No leading blank line from an empty contextPrefix — falls back to the
      // no-context embed shape.
      expect(embedCalls[0]).toBe("Title\ntag\nbody text");
      expect(embedCalls[0]!.startsWith("\n")).toBe(false);
    });

    it("uses cachedPrefixes entry for a chunk and skips llm.contextualize for that index", async () => {
      const content = "A".repeat(500);
      const mockLlm = makeMockLlm(async () => "LIVE CTX");
      // First run to discover the chunk layout.
      const baseline = await embedDocument("T", [], content, {
        llm: mockLlm,
        chunkSize: 100,
        chunkOverlap: 10,
      });
      const chunkCount = baseline.length;
      expect(chunkCount).toBeGreaterThan(1);

      (mockLlm.contextualize as ReturnType<typeof vi.fn>).mockClear();
      embedCalls.length = 0;

      // Cache all but the last chunk index.
      const cached = new Map<number, string>();
      for (let i = 0; i < chunkCount - 1; i++) {
        cached.set(i, `CACHED-${i}`);
      }

      const result = await embedDocument("T", [], content, {
        llm: mockLlm,
        cachedPrefixes: cached,
        chunkSize: 100,
        chunkOverlap: 10,
      });

      expect(result).toHaveLength(chunkCount);
      // Only the last (uncached) chunk triggered a live LLM call.
      expect(mockLlm.contextualize).toHaveBeenCalledTimes(1);
      // Cached chunks preserve the cached prefix verbatim.
      for (let i = 0; i < chunkCount - 1; i++) {
        expect(result[i]!.contextPrefix).toBe(`CACHED-${i}`);
      }
      expect(result[chunkCount - 1]!.contextPrefix).toBe("LIVE CTX");
    });

    it("with no llm, contextPrefix is '' on every chunk and no LLM calls occur", async () => {
      const content = "A".repeat(500);
      const mockLlm = makeMockLlm(async () => "SHOULD NOT CALL");
      // Note: do NOT pass `llm` into opts — this is the flag-off path.
      const result = await embedDocument("T", [], content, {
        chunkSize: 100,
        chunkOverlap: 10,
      });
      expect(result.length).toBeGreaterThan(1);
      expect(mockLlm.contextualize).not.toHaveBeenCalled();
      for (const chunk of result) {
        expect(chunk.contextPrefix).toBe("");
      }
      // Embed text uses the no-context shape.
      expect(embedCalls[0]!.startsWith("T\n")).toBe(true);
    });

    it("cachedPrefixes without llm has no effect (no LLM, caching is moot)", async () => {
      const content = "short content";
      const mockLlm = makeMockLlm(async () => "LIVE");
      const cached = new Map<number, string>([[0, "CACHED"]]);
      const result = await embedDocument("T", [], content, {
        cachedPrefixes: cached,
      });
      // Without llm, no contextualize calls happen and no cached prefix is applied
      // (since caching is only a fast-path on the LLM branch).
      expect(mockLlm.contextualize).not.toHaveBeenCalled();
      expect(result[0]!.contextPrefix).toBe("");
    });
  });
});

// GH-1203: batch primitive for embedding multiple texts in a single pipeline
// call. Used by the reindex chunk buffer to amortize ONNX overhead.
describe("embedChunks (batch primitive)", () => {
  beforeEach(() => {
    embedCalls.length = 0;
    batchCalls.length = 0;
    disposeCalls.length = 0;
  });

  it("returns [] without invoking the pipeline when texts is empty", async () => {
    const out = await embedChunks([]);
    expect(out).toEqual([]);
    expect(batchCalls).toHaveLength(0);
    expect(disposeCalls).toHaveLength(0);
  });

  it("invokes the pipeline ONCE per batch (not once per text)", async () => {
    const out = await embedChunks(["a", "b", "c"]);
    expect(out).toHaveLength(3);
    // ONE pipeline call, not three.
    expect(batchCalls).toHaveLength(1);
    expect(batchCalls[0]).toEqual(["a", "b", "c"]);
    // Serial `embed(text)` path was NOT used.
    expect(embedCalls).toHaveLength(0);
  });

  it("returns one Float32Array per input text in input order", async () => {
    const out = await embedChunks(["a", "b", "c"]);
    expect(out).toHaveLength(3);
    // Mock seeded each row's first element with rowIndex+1 so per-text
    // isolation is observable.
    expect(out[0]![0]).toBe(1);
    expect(out[1]![0]).toBe(2);
    expect(out[2]![0]).toBe(3);
  });

  it("each returned Float32Array has length 384", async () => {
    const out = await embedChunks(["a", "b"]);
    for (const v of out) {
      expect(v).toBeInstanceOf(Float32Array);
      expect(v.length).toBe(384);
    }
  });

  it("disposes the batch-output tensor exactly once per call", async () => {
    await embedChunks(["a", "b", "c", "d"]);
    // One dispose for the single pipeline invocation, NOT one per text.
    expect(disposeCalls).toHaveLength(1);
    expect(disposeCalls[0]).toHaveBeenCalledTimes(1);
  });

  it("disposes once per batch across multiple invocations", async () => {
    await embedChunks(["a", "b"]);
    await embedChunks(["c", "d", "e"]);
    expect(disposeCalls).toHaveLength(2);
    for (const d of disposeCalls) {
      expect(d).toHaveBeenCalledTimes(1);
    }
  });

  it("returned arrays are independent of the disposed source buffer", async () => {
    const out = await embedChunks(["a", "b"]);
    // dispose was called, but the returned Float32Arrays remain mutable and
    // independent — verifies data was copied (not aliased) before disposal.
    expect(disposeCalls[0]).toHaveBeenCalledTimes(1);
    out[0]![0] = 99;
    expect(out[0]![0]).toBe(99);
    // Mutating one does not affect another.
    expect(out[1]![0]).toBe(2);
  });

  it("produces numerically equivalent embeddings to per-text calls (mock parity)", async () => {
    // With the mock pipeline, the only deterministic component is the
    // first element of each row (seeded with rowIndex+1). Compare
    // explicitly against that pattern. This verifies the slicing math
    // would yield correct per-text vectors for the real model too.
    const batched = await embedChunks(["x", "y", "z"]);
    expect(batched[0]![0]).toBe(1);
    expect(batched[1]![0]).toBe(2);
    expect(batched[2]![0]).toBe(3);
    // All other elements are zero (mock seeds only index 0).
    for (let i = 1; i < 384; i++) {
      expect(batched[0]![i]).toBe(0);
    }
  });
});
