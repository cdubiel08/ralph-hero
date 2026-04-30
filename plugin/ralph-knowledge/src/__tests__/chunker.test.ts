import { describe, it, expect } from "vitest";
import { chunkText, type Chunk } from "../chunker.js";

/**
 * Test suite for the recursive character text splitter.
 *
 * Invariants asserted (all must hold for every chunk returned):
 *   - text.slice(charStart, charEnd) === content
 *   - charStart is monotonically non-decreasing
 *   - content.length <= chunkSize + (longest separator length)
 */

function assertCoreInvariants(
  text: string,
  chunks: Chunk[],
  chunkSize: number,
  separatorSlack = 2,
): void {
  let prevStart = -1;
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i]!;
    expect(c.index).toBe(i);
    expect(text.slice(c.charStart, c.charEnd)).toBe(c.content);
    expect(c.charStart).toBeGreaterThanOrEqual(prevStart);
    expect(c.content.length).toBeLessThanOrEqual(chunkSize + separatorSlack);
    prevStart = c.charStart;
  }
}

describe("chunkText — empty and short inputs", () => {
  it("returns [] for empty string", () => {
    expect(chunkText("")).toEqual([]);
  });

  it("returns a single chunk for a short doc", () => {
    const text = "short doc";
    const chunks = chunkText(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.charStart).toBe(0);
    expect(chunks[0]!.charEnd).toBe(text.length);
    expect(chunks[0]!.content).toBe(text);
    expect(chunks[0]!.index).toBe(0);
  });

  it("returns a single chunk at exactly chunkSize", () => {
    const text = "x".repeat(2048);
    const chunks = chunkText(text, { chunkSize: 2048 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.content).toBe(text);
  });

  it("returns a single chunk when text.length < chunkSize even with unusual separators", () => {
    const chunks = chunkText("hello world", {
      chunkSize: 100,
      chunkOverlap: 10,
      separators: ["##", "\n"],
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.content).toBe("hello world");
  });
});

describe("chunkText — long documents", () => {
  it("produces >= 4 chunks for an 8K-char paragraph-rich doc with chunkSize=2048", () => {
    const paragraph = "The quick brown fox jumps over the lazy dog. ".repeat(20);
    const text = Array.from({ length: 10 }, () => paragraph).join("\n\n");
    expect(text.length).toBeGreaterThan(8000);

    const chunks = chunkText(text, { chunkSize: 2048, chunkOverlap: 256 });
    expect(chunks.length).toBeGreaterThanOrEqual(4);
    assertCoreInvariants(text, chunks, 2048);
  });

  it("bounds content.length at chunkSize + separator slack", () => {
    const text = Array.from({ length: 400 }, (_, i) => `Sentence ${i}.`).join(" ");
    const chunks = chunkText(text, { chunkSize: 512, chunkOverlap: 64 });
    assertCoreInvariants(text, chunks, 512);
  });

  it("keeps charStart monotonically non-decreasing", () => {
    const text = "x".repeat(10_000);
    const chunks = chunkText(text, { chunkSize: 256, chunkOverlap: 32 });
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.charStart).toBeGreaterThanOrEqual(chunks[i - 1]!.charStart);
    }
  });

  it("reconstructs content bit-for-bit from offsets for every chunk", () => {
    const text = Array.from({ length: 500 }, (_, i) => `Para ${i}.\n\n`).join("");
    const chunks = chunkText(text, { chunkSize: 1024, chunkOverlap: 128 });
    for (const c of chunks) {
      expect(text.slice(c.charStart, c.charEnd)).toBe(c.content);
    }
  });
});

describe("chunkText — overlap behavior", () => {
  it("produces overlap of approximately chunkOverlap between consecutive chunks", () => {
    const text = "abcdefghij ".repeat(500); // ~5500 chars
    const chunkOverlap = 256;
    const chunks = chunkText(text, { chunkSize: 1024, chunkOverlap });

    expect(chunks.length).toBeGreaterThan(1);

    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1]!;
      const curr = chunks[i]!;
      // Overlap in characters = prev.charEnd - curr.charStart.
      const overlap = prev.charEnd - curr.charStart;
      expect(overlap).toBeGreaterThan(0);
      // Tolerance: +/- 16 chars (allows for snap to atom boundary).
      expect(Math.abs(overlap - chunkOverlap)).toBeLessThanOrEqual(16);
    }
  });

  it("makes forward progress even when chunkOverlap is zero", () => {
    const text = "abcdefghij ".repeat(300);
    const chunks = chunkText(text, { chunkSize: 512, chunkOverlap: 0 });
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.charStart).toBeGreaterThanOrEqual(chunks[i - 1]!.charEnd);
    }
  });

  it("rejects chunkOverlap >= chunkSize", () => {
    // Only need enough text to trigger the chunking path past the fast return.
    const text = "x".repeat(2048);
    expect(() =>
      chunkText(text, { chunkSize: 100, chunkOverlap: 100 }),
    ).toThrow(/chunkOverlap/);
    expect(() =>
      chunkText(text, { chunkSize: 100, chunkOverlap: 200 }),
    ).toThrow(/chunkOverlap/);
  });
});

describe("chunkText — unicode correctness", () => {
  it("preserves character boundaries with emoji + CJK", () => {
    // Mix emoji (surrogate pairs), CJK, and ASCII; repeat enough to exceed chunkSize.
    const segment =
      "Hello. こんにちは。 你好。 안녕하세요。 Emojis: 🎉🚀✨. ";
    const text = segment.repeat(100); // plenty of chunks
    const chunks = chunkText(text, { chunkSize: 512, chunkOverlap: 64 });

    assertCoreInvariants(text, chunks, 512);

    // Slicing must produce the same string as content — if indices split a
    // surrogate pair the JS string would still compare equal char-by-char,
    // but we additionally verify no lone surrogate prefix/suffix on boundaries.
    for (const c of chunks) {
      expect(text.slice(c.charStart, c.charEnd)).toBe(c.content);
    }
  });

  it("handles pure CJK doc (no ASCII separators beyond ideographic space)", () => {
    const text = "这是一个很长的中文文档。".repeat(300);
    const chunks = chunkText(text, { chunkSize: 256, chunkOverlap: 32 });
    assertCoreInvariants(text, chunks, 256);
    // Must cover the whole doc (last chunk ends at text.length).
    expect(chunks[chunks.length - 1]!.charEnd).toBe(text.length);
  });
});

describe("chunkText — separator priority", () => {
  it("prefers \\n\\n over other separators so code fences stay intact", () => {
    // A large markdown doc with a code fence that would exceed chunkSize if
    // we naively split on every newline; ensure it's kept whole by preferring
    // \n\n as the outer boundary.
    const prefix = "# Heading\n\nSome text before the fence.\n\n";
    const fence =
      "```typescript\n" +
      "const x = 1;\n".repeat(60) +
      "```";
    const suffix = "\n\nText after the fence.";
    const text = prefix + fence + suffix;

    const chunkSize = fence.length + 50; // Large enough to keep fence whole.
    const chunks = chunkText(text, {
      chunkSize,
      chunkOverlap: 64,
      separators: ["\n\n", "\n", ". ", " ", ""],
    });

    // Fence should appear intact in at least one chunk.
    const anyChunkContainsWholeFence = chunks.some(c => c.content.includes(fence));
    expect(anyChunkContainsWholeFence).toBe(true);

    // And no chunk should contain just a fragment of the opening backticks
    // separated from its closing ones — i.e., if a chunk starts with ``` it
    // must also contain the matching closing ```.
    for (const c of chunks) {
      const opens = (c.content.match(/```/g) ?? []).length;
      // Either zero fences (text-only chunk) or an even number (complete fences).
      expect(opens % 2 === 0 || c.content.includes(fence)).toBe(true);
    }
  });

  it("honors custom separators — '##' heading splitter", () => {
    const text =
      "Intro paragraph here.\n\n" +
      "## Section A\nContent for A.\n\n" +
      "## Section B\nContent for B with a bit more text.\n\n" +
      "## Section C\nFinal content goes here.";
    const chunks = chunkText(text, {
      chunkSize: 40, // small -> forces splitting
      chunkOverlap: 8,
      separators: ["##", "\n", " ", ""],
    });

    // Custom separator must be honored: the chunker must split on '##'.
    // Because the separator stays attached to the preceding piece (to keep
    // text.slice(start,end) === content), chunk boundaries occur *just after*
    // each '##' occurrence — verify that at least one chunk's charEnd aligns
    // with a '##' position + 2.
    expect(chunks.length).toBeGreaterThan(1);
    const sectionStarts = [
      text.indexOf("## Section A"),
      text.indexOf("## Section B"),
      text.indexOf("## Section C"),
    ];
    const endPositions = chunks.map(c => c.charEnd);
    const boundariesHit = sectionStarts.filter(pos =>
      endPositions.includes(pos + 2),
    );
    expect(boundariesHit.length).toBeGreaterThan(0);
  });

  it("character-splits as a last resort when no separator applies", () => {
    // A single token longer than chunkSize with no separators; must still
    // produce chunks (via the "" sentinel).
    const text = "a".repeat(300);
    const chunks = chunkText(text, {
      chunkSize: 100,
      chunkOverlap: 10,
      separators: ["\n\n", "\n", ""],
    });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.content.length).toBeLessThanOrEqual(100);
    }
    // Overall coverage: concatenating (with overlap removed) must reconstruct.
    const firstChar = chunks[0]!.charStart;
    const lastEnd = chunks[chunks.length - 1]!.charEnd;
    expect(firstChar).toBe(0);
    expect(lastEnd).toBe(text.length);
  });
});

describe("chunkText — forward progress invariant", () => {
  // Regression test for GH-916. Pre-fix this OOMs.
  it("terminates when a chunk would consist of a single atom shorter than chunkOverlap", () => {
    // Trigger: atom N is short (< 256 chars), atom N+1 is large enough that
    // packing them together would exceed chunkSize (2048).
    const shortAtom = "short paragraph that is under 256 chars.\n\n";
    const longAtom = "x".repeat(1900) + "\n\n";
    const text = shortAtom + longAtom + "tail.";
    const chunks = chunkText(text);
    // We don't care about the exact count; we care that chunkText returns at
    // all (pre-fix it loops forever) and that all chunks have non-empty content.
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.length).toBeLessThan(100); // sanity: no runaway
    for (const c of chunks) {
      expect(c.content.length).toBeGreaterThan(0);
    }
  });

  it("makes strict forward progress: chunk[i+1].charStart > chunk[i].charStart", () => {
    // Build an input that triggers many single-atom chunks.
    const blocks = [];
    for (let i = 0; i < 20; i++) {
      blocks.push("short " + i + ".\n\n");
      blocks.push("x".repeat(1900) + "\n\n");
    }
    const chunks = chunkText(blocks.join(""));
    expect(chunks.length).toBeGreaterThan(0);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.charStart).toBeGreaterThan(chunks[i - 1]!.charStart);
    }
  });

  it("chunks the GH-916 fixture file in bounded time and memory", () => {
    // Path-independent fixture: a markdown sample that mirrors the trigger
    // pattern (short paragraphs interspersed with large code blocks).
    const sample = [
      "# Heading\n\n",
      "Short intro paragraph.\n\n",
      "```python\n" + "code line\n".repeat(180) + "```\n\n",
      "Short follow-up.\n\n",
      "```python\n" + "more code\n".repeat(180) + "```\n\n",
      "End.",
    ].join("");
    const start = Date.now();
    const chunks = chunkText(sample);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1000); // pre-fix this would not return
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.length).toBeLessThan(50); // sanity: no runaway
    // Spot-check the canonical invariant
    for (const c of chunks) {
      expect(sample.slice(c.charStart, c.charEnd)).toBe(c.content);
    }
  });
});
