import { describe, it, expect } from "vitest";
import { formatSearchResults, formatTraverseResults } from "../format.js";
import type { EnrichedSearchResult } from "../format.js";
import type { TraverseResult } from "../traverse.js";

// --- Test fixtures ---

const makeSearchResult = (overrides: Partial<EnrichedSearchResult> = {}): EnrichedSearchResult => ({
  id: "doc-a",
  path: "thoughts/shared/research/doc-a.md",
  title: "Foundation Research",
  type: "research",
  status: "approved",
  date: "2026-01-01",
  score: 0.9,
  snippet: "...snippet text here...",
  tags: ["tag-one", "tag-two"],
  ...overrides,
});

const makeTraverseResult = (overrides: Partial<TraverseResult> = {}): TraverseResult => ({
  sourceId: "doc-a",
  targetId: "doc-b",
  type: "builds_on",
  depth: 1,
  doc: { title: "Doc B", status: "draft", date: "2026-01-15" },
  ...overrides,
});

// --- formatSearchResults ---

describe("formatSearchResults", () => {
  describe("brief=false (full mode)", () => {
    it("returns the original enriched result objects unchanged", () => {
      const results = [makeSearchResult()];
      const output = formatSearchResults(results, false);
      expect(output).toBe(results); // same reference — passthrough
    });

    it("preserves snippet field", () => {
      const results = [makeSearchResult({ snippet: "important snippet" })];
      const output = formatSearchResults(results, false) as EnrichedSearchResult[];
      expect(output[0].snippet).toBe("important snippet");
    });

    it("preserves path field", () => {
      const results = [makeSearchResult({ path: "some/path.md" })];
      const output = formatSearchResults(results, false) as EnrichedSearchResult[];
      expect(output[0].path).toBe("some/path.md");
    });

    it("preserves status field", () => {
      const results = [makeSearchResult({ status: "approved" })];
      const output = formatSearchResults(results, false) as EnrichedSearchResult[];
      expect(output[0].status).toBe("approved");
    });

    it("preserves outcomes_summary field", () => {
      const summary = { total: 3, verdict: "pass" };
      const results = [makeSearchResult({ outcomes_summary: summary })];
      const output = formatSearchResults(results, false) as EnrichedSearchResult[];
      expect(output[0].outcomes_summary).toBe(summary);
    });

    it("returns empty array when input is empty", () => {
      expect(formatSearchResults([], false)).toEqual([]);
    });
  });

  describe("brief=true", () => {
    it("omits snippet field", () => {
      const results = [makeSearchResult({ snippet: "should be dropped" })];
      const output = formatSearchResults(results, true);
      expect("snippet" in output[0]).toBe(false);
    });

    it("omits path field", () => {
      const results = [makeSearchResult()];
      const output = formatSearchResults(results, true);
      expect("path" in output[0]).toBe(false);
    });

    it("omits status field", () => {
      const results = [makeSearchResult({ status: "approved" })];
      const output = formatSearchResults(results, true);
      expect("status" in output[0]).toBe(false);
    });

    it("omits outcomes_summary field", () => {
      const results = [makeSearchResult({ outcomes_summary: { total: 1 } })];
      const output = formatSearchResults(results, true);
      expect("outcomes_summary" in output[0]).toBe(false);
    });

    it("retains id", () => {
      const results = [makeSearchResult({ id: "my-id" })];
      const output = formatSearchResults(results, true);
      expect(output[0].id).toBe("my-id");
    });

    it("retains title", () => {
      const results = [makeSearchResult({ title: "My Title" })];
      const output = formatSearchResults(results, true);
      expect(output[0].title).toBe("My Title");
    });

    it("retains type", () => {
      const results = [makeSearchResult({ type: "plan" })];
      const output = formatSearchResults(results, true);
      expect(output[0].type).toBe("plan");
    });

    it("retains date", () => {
      const results = [makeSearchResult({ date: "2026-03-24" })];
      const output = formatSearchResults(results, true);
      expect(output[0].date).toBe("2026-03-24");
    });

    it("retains tags", () => {
      const results = [makeSearchResult({ tags: ["alpha", "beta"] })];
      const output = formatSearchResults(results, true);
      expect(output[0].tags).toEqual(["alpha", "beta"]);
    });

    it("retains score", () => {
      const results = [makeSearchResult({ score: 0.75 })];
      const output = formatSearchResults(results, true);
      expect(output[0].score).toBe(0.75);
    });

    it("returns empty array when input is empty", () => {
      expect(formatSearchResults([], true)).toEqual([]);
    });

    it("handles multiple results", () => {
      const results = [
        makeSearchResult({ id: "a", snippet: "s1" }),
        makeSearchResult({ id: "b", snippet: "s2" }),
      ];
      const output = formatSearchResults(results, true);
      expect(output).toHaveLength(2);
      expect(output[0].id).toBe("a");
      expect(output[1].id).toBe("b");
      expect("snippet" in output[0]).toBe(false);
      expect("snippet" in output[1]).toBe(false);
    });
  });
});

// --- formatTraverseResults ---

describe("formatTraverseResults", () => {
  const mockGetTags = (id: string): string[] => {
    const map: Record<string, string[]> = {
      "doc-b": ["plan", "alpha"],
      "doc-c": ["research"],
    };
    return map[id] ?? [];
  };

  describe("brief=false (full mode)", () => {
    it("returns the original TraverseResult objects unchanged", () => {
      const results = [makeTraverseResult()];
      const output = formatTraverseResults(results, mockGetTags, false);
      expect(output).toBe(results); // same reference — passthrough
    });

    it("does NOT add tags in full mode", () => {
      const results = [makeTraverseResult()];
      const output = formatTraverseResults(results, mockGetTags, false);
      expect("tags" in output[0]).toBe(false);
    });

    it("preserves full doc object", () => {
      const results = [makeTraverseResult()];
      const output = formatTraverseResults(results, mockGetTags, false) as TraverseResult[];
      expect(output[0].doc).toEqual({ title: "Doc B", status: "draft", date: "2026-01-15" });
    });

    it("returns empty array when input is empty", () => {
      expect(formatTraverseResults([], mockGetTags, false)).toEqual([]);
    });
  });

  describe("brief=true", () => {
    it("strips doc to { title } only", () => {
      const results = [makeTraverseResult({ doc: { title: "Doc B", status: "approved", date: "2026-01-15" } })];
      const output = formatTraverseResults(results, mockGetTags, true);
      expect(output[0].doc).toEqual({ title: "Doc B" });
      expect("status" in (output[0].doc as object)).toBe(false);
      expect("date" in (output[0].doc as object)).toBe(false);
    });

    it("adds tags for the target document", () => {
      const results = [makeTraverseResult({ targetId: "doc-b" })];
      const output = formatTraverseResults(results, mockGetTags, true);
      expect(output[0].tags).toEqual(["plan", "alpha"]);
    });

    it("adds empty tags array when target has no tags", () => {
      const results = [makeTraverseResult({ targetId: "unknown-doc" })];
      const output = formatTraverseResults(results, mockGetTags, true);
      expect(output[0].tags).toEqual([]);
    });

    it("handles doc=null in brief mode", () => {
      const results = [makeTraverseResult({ doc: null })];
      const output = formatTraverseResults(results, mockGetTags, true);
      expect(output[0].doc).toBeNull();
    });

    it("preserves sourceId, targetId, type, depth", () => {
      const results = [makeTraverseResult({ sourceId: "s", targetId: "t", type: "tensions", depth: 2 })];
      const output = formatTraverseResults(results, mockGetTags, true);
      expect(output[0].sourceId).toBe("s");
      expect(output[0].targetId).toBe("t");
      expect(output[0].type).toBe("tensions");
      expect(output[0].depth).toBe(2);
    });

    it("returns empty array when input is empty", () => {
      expect(formatTraverseResults([], mockGetTags, true)).toEqual([]);
    });

    it("handles multiple results with different tags", () => {
      const results = [
        makeTraverseResult({ targetId: "doc-b", depth: 1 }),
        makeTraverseResult({ targetId: "doc-c", depth: 2 }),
      ];
      const output = formatTraverseResults(results, mockGetTags, true);
      expect(output[0].tags).toEqual(["plan", "alpha"]);
      expect(output[1].tags).toEqual(["research"]);
    });
  });
});
