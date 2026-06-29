import { describe, it, expect } from "vitest";
import {
  buildThinkPrompt,
  parseThinkResponse,
  think,
  type ThinkSource,
} from "../think.js";

const SOURCES: ThinkSource[] = [
  { id: "reflection-aaa", title: "Clustering rework", snippet: "Agglomerative beat HDBSCAN on sparse streams.", tier: "reflection", score: 0.9 },
  { id: "raw-bbb", title: "Session", snippet: "We chose cosine distance 0.40.", tier: "raw", score: 0.5 },
];

describe("buildThinkPrompt", () => {
  it("includes the query, every source id, and the JSON contract", () => {
    const p = buildThinkPrompt("why agglomerative?", SOURCES);
    expect(p).toContain("why agglomerative?");
    expect(p).toContain("reflection-aaa");
    expect(p).toContain("raw-bbb");
    expect(p.toLowerCase()).toContain("json");
    expect(p.toLowerCase()).toContain("gaps");
  });
});

describe("parseThinkResponse", () => {
  it("parses bare JSON", () => {
    const got = parseThinkResponse('{"answer": "A [reflection-aaa]", "gaps": "none"}');
    expect(got).toEqual({ answer: "A [reflection-aaa]", gaps: "none" });
  });

  it("parses fenced JSON", () => {
    const got = parseThinkResponse('```json\n{"answer":"x","gaps":"y"}\n```');
    expect(got).toEqual({ answer: "x", gaps: "y" });
  });

  it("returns null on garbage", () => {
    expect(parseThinkResponse("not json at all")).toBeNull();
  });
});

describe("think", () => {
  it("synthesizes a cited answer + gaps from a good completion", async () => {
    const complete = async () =>
      '{"answer": "Use agglomerative [reflection-aaa].", "gaps": "No benchmark on N>1000."}';
    const r = await think("why agglomerative?", SOURCES, complete);
    expect(r.synthesized).toBe(true);
    expect(r.answer).toContain("[reflection-aaa]");
    expect(r.gaps).toContain("benchmark");
    expect(r.sources).toHaveLength(2);
  });

  it("reports a gap (not an error) when there are no sources", async () => {
    let called = false;
    const complete = async () => {
      called = true;
      return "{}";
    };
    const r = await think("anything", [], complete);
    expect(r.synthesized).toBe(false);
    expect(r.sources).toHaveLength(0);
    expect(r.gaps.toLowerCase()).toContain("no");
    expect(called).toBe(false); // never call the LLM with nothing to ground on
  });

  it("degrades gracefully when the local model is offline (empty completion)", async () => {
    const complete = async () => "";
    const r = await think("q", SOURCES, complete);
    expect(r.synthesized).toBe(false);
    expect(r.gaps.toLowerCase()).toContain("unavailable");
    // sources are still returned so the caller gets value offline
    expect(r.sources).toHaveLength(2);
  });

  it("falls back to raw text when the completion is not JSON", async () => {
    const complete = async () => "Here is a prose answer with no JSON.";
    const r = await think("q", SOURCES, complete);
    expect(r.synthesized).toBe(true);
    expect(r.answer).toContain("prose answer");
  });

  it("treats an undefined completion as offline", async () => {
    const complete = async () => undefined as unknown as string;
    const r = await think("q", SOURCES, complete);
    expect(r.synthesized).toBe(false);
    expect(r.gaps.toLowerCase()).toContain("unavailable");
  });

  it("fails open (does not throw) when complete() rejects", async () => {
    // think()'s fail-open guarantee must be self-contained: even if the
    // injected completion fn throws (e.g. a future non-fail-open caller),
    // the tool should still return the retrieved sources, not error out.
    const complete = async () => {
      throw new Error("connection refused");
    };
    const r = await think("q", SOURCES, complete);
    expect(r.synthesized).toBe(false);
    expect(r.gaps.toLowerCase()).toContain("unavailable");
    expect(r.sources).toEqual(SOURCES);
  });
});
