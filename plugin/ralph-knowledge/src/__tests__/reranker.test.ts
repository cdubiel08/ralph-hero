import { describe, it, expect, vi } from "vitest";
import { Reranker, truncateForRerank, type RerankerInput } from "../reranker.js";

/**
 * GH-923 — unit tests for the Reranker module.
 *
 * The Reranker accepts a `loader` injection point so tests bypass the real
 * `@huggingface/transformers` import and avoid downloading the ~580 MB ONNX
 * model. The tests below stub the loader entirely and assert the behaviors
 * spelled out in plan Tasks 1.1-1.3 acceptance criteria.
 */

/**
 * Build a fake tokenizer that records how many times it was called and what
 * args it received. Returns a sentinel object that the fake model can detect.
 */
function makeFakeTokenizer() {
  const calls: Array<{ texts: string[]; opts: Record<string, unknown> }> = [];
  const tokenizer = vi.fn(async (texts: string[], opts: Record<string, unknown>) => {
    calls.push({ texts, opts });
    // Return a sentinel input the fake model can identify. The real path
    // returns a BatchEncoding object — we only need an opaque value here.
    return { __fakeInputs: true, batchSize: texts.length };
  });
  return { tokenizer, calls };
}

/**
 * Build a fake model that returns the supplied `logits` (a number[][] shape
 * matching `[batch, num_labels]`). The model wraps the logits in the same
 * `{ tolist: () => number[][] }` interface the real ONNX model exposes.
 */
function makeFakeModel(logits: number[][]) {
  const calls: unknown[] = [];
  const model = vi.fn(async (inputs: unknown) => {
    calls.push(inputs);
    return {
      logits: {
        tolist: () => logits,
      },
    };
  });
  return { model, calls };
}

describe("truncateForRerank", () => {
  it("returns the string unchanged when shorter than maxChars", () => {
    expect(truncateForRerank("hello world", 1000)).toBe("hello world");
  });

  it("returns the string unchanged when exactly maxChars", () => {
    const s = "a".repeat(1000);
    expect(truncateForRerank(s, 1000)).toBe(s);
  });

  it("caps a 2000-char string at the default 1000-char limit", () => {
    const s = "a".repeat(2000);
    const result = truncateForRerank(s);
    expect(result.length).toBe(1000);
    expect(result).toBe("a".repeat(1000));
  });

  it("returns a 500-char string unchanged at the default limit", () => {
    const s = "b".repeat(500);
    expect(truncateForRerank(s)).toBe(s);
    expect(truncateForRerank(s).length).toBe(500);
  });

  it("respects a custom maxChars value", () => {
    const s = "x".repeat(100);
    expect(truncateForRerank(s, 50).length).toBe(50);
    expect(truncateForRerank(s, 50)).toBe("x".repeat(50));
  });
});

describe("Reranker constructor", () => {
  it("does not invoke the loader at construction time", () => {
    const loader = vi.fn();
    new Reranker({ loader });
    expect(loader).toHaveBeenCalledTimes(0);
  });

  it("accepts default options without arguments", () => {
    // Constructing with no args should not throw and should not load.
    const loader = vi.fn();
    // Pass loader so the default modelId doesn't matter for this test.
    const r = new Reranker({ loader });
    expect(r).toBeInstanceOf(Reranker);
    expect(loader).toHaveBeenCalledTimes(0);
  });

  it("stores custom modelId and dtype but does not load", () => {
    const loader = vi.fn();
    const r = new Reranker({
      modelId: "some/other-model",
      dtype: "fp32",
      loader,
    });
    expect(r).toBeInstanceOf(Reranker);
    expect(loader).toHaveBeenCalledTimes(0);
  });
});

describe("Reranker.score", () => {
  it("returns an empty Map for empty docs without invoking the loader", async () => {
    const loader = vi.fn();
    const r = new Reranker({ loader });
    const result = await r.score("query", []);
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
    expect(loader).toHaveBeenCalledTimes(0);
  });

  it("returns a Map with keys matching input doc ids", async () => {
    const { tokenizer } = makeFakeTokenizer();
    const { model } = makeFakeModel([[0.5], [0.3], [0.7]]);
    const loader = vi.fn(async () => ({ tokenizer, model }));
    const r = new Reranker({ loader });
    const docs: RerankerInput[] = [
      { id: "a", text: "alpha text" },
      { id: "b", text: "bravo text" },
      { id: "c", text: "charlie text" },
    ];
    const result = await r.score("query", docs);
    expect(result.size).toBe(3);
    expect(result.get("a")).toBe(0.5);
    expect(result.get("b")).toBe(0.3);
    expect(result.get("c")).toBe(0.7);
    expect(new Set(result.keys())).toEqual(new Set(["a", "b", "c"]));
  });

  it("invokes loader exactly once across multiple score calls", async () => {
    const { tokenizer } = makeFakeTokenizer();
    const { model } = makeFakeModel([[0.5]]);
    const loader = vi.fn(async () => ({ tokenizer, model }));
    const r = new Reranker({ loader });

    await r.score("q1", [{ id: "a", text: "x" }]);
    await r.score("q2", [{ id: "b", text: "y" }]);
    await r.score("q3", [{ id: "c", text: "z" }]);

    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("does not invoke loader when score is called only with empty docs", async () => {
    const loader = vi.fn();
    const r = new Reranker({ loader });
    await r.score("q1", []);
    await r.score("q2", []);
    expect(loader).toHaveBeenCalledTimes(0);
  });

  it("calls tokenizer with text_pair, padding, and truncation flags", async () => {
    const { tokenizer, calls: tokCalls } = makeFakeTokenizer();
    const { model } = makeFakeModel([[0.1], [0.2]]);
    const loader = vi.fn(async () => ({ tokenizer, model }));
    const r = new Reranker({ loader });

    await r.score("the query", [
      { id: "a", text: "doc one" },
      { id: "b", text: "doc two" },
    ]);

    expect(tokCalls).toHaveLength(1);
    const [call] = tokCalls;
    // Texts is a parallel array with the query repeated for each candidate.
    expect(call!.texts).toEqual(["the query", "the query"]);
    // text_pair carries the truncated doc text.
    expect(call!.opts.text_pair).toEqual(["doc one", "doc two"]);
    expect(call!.opts.padding).toBe(true);
    expect(call!.opts.truncation).toBe(true);
  });

  it("truncates each doc text via truncateForRerank before tokenization", async () => {
    const { tokenizer, calls: tokCalls } = makeFakeTokenizer();
    const { model } = makeFakeModel([[0.1]]);
    const loader = vi.fn(async () => ({ tokenizer, model }));
    const r = new Reranker({ loader });
    const longText = "z".repeat(2500);

    await r.score("q", [{ id: "a", text: longText }]);

    expect(tokCalls).toHaveLength(1);
    const textPair = tokCalls[0]!.opts.text_pair as string[];
    expect(textPair[0]!.length).toBe(1000);
  });

  it("preserves input order in the returned Map", async () => {
    const { tokenizer } = makeFakeTokenizer();
    // Logits intentionally don't match a sorted order — the score map is
    // input-indexed, sorting is the caller's job.
    const { model } = makeFakeModel([[0.1], [0.9], [0.5]]);
    const loader = vi.fn(async () => ({ tokenizer, model }));
    const r = new Reranker({ loader });

    const result = await r.score("q", [
      { id: "first", text: "a" },
      { id: "second", text: "b" },
      { id: "third", text: "c" },
    ]);

    expect(result.get("first")).toBe(0.1);
    expect(result.get("second")).toBe(0.9);
    expect(result.get("third")).toBe(0.5);
  });

  it("flattens single-label [batch, 1] logits by taking row[0]", async () => {
    // Confirms the same shape handling the bench documents at lines 299-306.
    const { tokenizer } = makeFakeTokenizer();
    const { model } = makeFakeModel([[0.42], [0.13]]);
    const loader = vi.fn(async () => ({ tokenizer, model }));
    const r = new Reranker({ loader });

    const result = await r.score("q", [
      { id: "a", text: "x" },
      { id: "b", text: "y" },
    ]);

    expect(result.get("a")).toBe(0.42);
    expect(result.get("b")).toBe(0.13);
  });

  it("handles empty logit rows by defaulting to 0", async () => {
    // Defensive: bench fallback at line 306 (`row.length > 0 ? row[0] : 0`).
    const { tokenizer } = makeFakeTokenizer();
    const { model } = makeFakeModel([[], [0.5]]);
    const loader = vi.fn(async () => ({ tokenizer, model }));
    const r = new Reranker({ loader });

    const result = await r.score("q", [
      { id: "empty", text: "x" },
      { id: "ok", text: "y" },
    ]);

    expect(result.get("empty")).toBe(0);
    expect(result.get("ok")).toBe(0.5);
  });

  it("does not re-load the model when alternating empty and non-empty calls", async () => {
    const { tokenizer } = makeFakeTokenizer();
    const { model } = makeFakeModel([[0.5]]);
    const loader = vi.fn(async () => ({ tokenizer, model }));
    const r = new Reranker({ loader });

    await r.score("q1", []);
    await r.score("q2", [{ id: "a", text: "x" }]);
    await r.score("q3", []);
    await r.score("q4", [{ id: "b", text: "y" }]);

    // Loader called exactly once (on the first non-empty call).
    expect(loader).toHaveBeenCalledTimes(1);
  });
});
