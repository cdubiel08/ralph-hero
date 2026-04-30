/**
 * GH-923 — Reusable cross-encoder reranker module.
 *
 * Lifts the `AutoTokenizer.from_pretrained` + `AutoModelForSequenceClassification.from_pretrained`
 * + `tokenizer(texts, { text_pair, padding, truncation })` + `model(inputs)`
 * + `outputs.logits.tolist()` pattern from `benchmark/reranker-bench.ts` into
 * a unit-testable class. No DB, no MCP, no `HybridSearch` coupling.
 *
 * Design notes (load-bearing):
 *
 * 1. **Direct tokenizer + model path** — NOT `pipeline('text-classification', ...)`.
 *    The high-level pipeline silently coerces `{text, text_pair}` objects to
 *    strings and returns a constant `score=1`. The benchmark's comment block
 *    at `benchmark/reranker-bench.ts:178-204` documents this in detail.
 *
 * 2. **Lazy load** — the constructor MUST NOT call `from_pretrained`. The
 *    5-10s cold-start cost (ONNX load + warmup, per #901) is paid on the
 *    first non-empty `score()` call only. Empty `docs` returns immediately
 *    without loading the model. Subsequent calls reuse the cached
 *    tokenizer + model.
 *
 * 3. **Loader injection** — the optional `loader` constructor field replaces
 *    the default `AutoTokenizer.from_pretrained` + `AutoModelForSequenceClassification.from_pretrained`
 *    calls. Used by tests to bypass the ~580 MB model download. Production
 *    code omits the field; the default loader is constructed lazily inside
 *    `score()` on demand so the `@huggingface/transformers` import itself is
 *    deferred to first use.
 *
 * 4. **Single-label sigmoid head** — cross-encoder rerankers ship `[batch, 1]`
 *    logits. We take `row[0]` per row; empty rows fall back to `0` (matches
 *    the bench's defensive read at `reranker-bench.ts:306`).
 */

import type {
  PreTrainedTokenizer,
  PreTrainedModel,
} from "@huggingface/transformers";

/** A document candidate paired with its stable id. */
export interface RerankerInput {
  id: string;
  text: string;
}

/**
 * Dtype values accepted by `@huggingface/transformers` for ONNX model loading.
 * Passed through to `AutoModelForSequenceClassification.from_pretrained` when
 * non-undefined; left out when undefined (lets transformers.js pick the
 * default ONNX variant the model repo ships).
 */
export type RerankerDtype =
  | "fp32"
  | "fp16"
  | "q8"
  | "int8"
  | "uint8"
  | "q4"
  | "bnb4"
  | "auto";

/** Loader injection point — see Design Note 3 above. */
export type RerankerLoader = () => Promise<{
  tokenizer: PreTrainedTokenizer;
  model: PreTrainedModel;
}>;

/** Constructor options for {@link Reranker}. */
export interface RerankerOptions {
  /**
   * Hugging Face model id. Defaults to `onnx-community/bge-reranker-v2-m3-ONNX`,
   * the variant that benchmarked best in #901.
   */
  modelId?: string;
  /**
   * ONNX dtype variant. Defaults to `"q8"` (int8 quantized — the production
   * default per #901). Pass `undefined` to let transformers.js pick.
   */
  dtype?: RerankerDtype;
  /**
   * Optional loader override. When provided, replaces the default
   * `from_pretrained` calls. Used by tests to avoid downloading the real
   * ONNX model (~580 MB).
   */
  loader?: RerankerLoader;
}

const DEFAULT_MODEL_ID = "onnx-community/bge-reranker-v2-m3-ONNX";
const DEFAULT_DTYPE: RerankerDtype = "q8";
const DEFAULT_MAX_CHARS = 1000;

/**
 * Truncate a snippet for cross-encoder consumption. The transformers.js
 * tokenizer truncates internally to the model's max_position (typically 512),
 * but capping the input string here keeps memory and tokenization cost
 * predictable across models with different max_position.
 *
 * Mirrors `benchmark/reranker-bench.ts:173-176` exactly so the production
 * Reranker scores the same input shape the bench measured.
 */
export function truncateForRerank(s: string, maxChars = DEFAULT_MAX_CHARS): string {
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars);
}

/**
 * Cross-encoder reranker that lazily loads an ONNX model on first use and
 * caches it for subsequent calls.
 *
 * Construct once per process; pass into `HybridSearch` (Phase 2) for query-
 * time rescoring of the post-RRF candidate set.
 */
export class Reranker {
  private readonly modelId: string;
  private readonly dtype: RerankerDtype | undefined;
  private readonly loader: RerankerLoader;

  /**
   * Cached tokenizer + model after the first load. `null` until the first
   * non-empty `score()` call.
   */
  private cached: {
    tokenizer: PreTrainedTokenizer;
    model: PreTrainedModel;
  } | null = null;

  /**
   * In-flight load promise. Used to guarantee that concurrent `score()` calls
   * issued before the first load completes share a single load — without it,
   * two near-simultaneous calls would each fire a `from_pretrained` request.
   */
  private loadPromise: Promise<{
    tokenizer: PreTrainedTokenizer;
    model: PreTrainedModel;
  }> | null = null;

  constructor(opts: RerankerOptions = {}) {
    this.modelId = opts.modelId ?? DEFAULT_MODEL_ID;
    this.dtype = opts.dtype ?? DEFAULT_DTYPE;
    this.loader = opts.loader ?? this.makeDefaultLoader();
    // No model load here — see Design Note 2 above.
  }

  /**
   * Score (query, doc) pairs and return a `Map<id, logit>`. Logits are raw
   * cross-encoder scores; higher = more relevant. The caller decides how to
   * combine them with RRF / MMR / etc.
   *
   * Empty `docs` returns an empty Map without loading the model.
   */
  async score(query: string, docs: RerankerInput[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (docs.length === 0) {
      return out;
    }

    const { tokenizer, model } = await this.ensureLoaded();

    // Build parallel arrays per the bench `buildPairs` shape. The doc text is
    // truncated up-front so memory + tokenization cost stay predictable.
    const texts: string[] = [];
    const textPairs: string[] = [];
    for (const d of docs) {
      texts.push(query);
      textPairs.push(truncateForRerank(d.text));
    }

    // Direct tokenizer call — see Design Note 1 above.
    // The transformers.js types model `tokenizer` as a callable but TS can't
    // see the call signature on the union, so we cast to a function.
    const tokenize = tokenizer as unknown as (
      t: string[],
      o: { text_pair: string[]; padding: boolean; truncation: boolean },
    ) => Promise<unknown>;
    const inputs = await tokenize(texts, {
      text_pair: textPairs,
      padding: true,
      truncation: true,
    });

    // The model is also a callable proxy in transformers.js.
    const forward = model as unknown as (
      i: unknown,
    ) => Promise<{ logits: { tolist: () => number[][] } }>;
    const outputs = await forward(inputs);
    // `outputs.logits` is `[batch, num_labels]`. Cross-encoder rerankers ship
    // a single-label sigmoid head, so logits is `[batch, 1]`. Take `row[0]`
    // per row; fall back to 0 for an empty row (defensive — matches bench
    // `reranker-bench.ts:306`).
    const tolist = outputs.logits.tolist();
    for (let i = 0; i < docs.length; i++) {
      const row = tolist[i] ?? [];
      const logit = row.length > 0 ? row[0]! : 0;
      out.set(docs[i]!.id, logit);
    }
    return out;
  }

  /**
   * Resolve the cached tokenizer + model, loading them via the injected
   * `loader` on first call. Subsequent calls reuse the cache. Concurrent
   * first-time calls share a single in-flight load promise.
   */
  private async ensureLoaded(): Promise<{
    tokenizer: PreTrainedTokenizer;
    model: PreTrainedModel;
  }> {
    if (this.cached) {
      return this.cached;
    }
    if (!this.loadPromise) {
      this.loadPromise = this.loader().then((loaded) => {
        this.cached = loaded;
        return loaded;
      });
    }
    return this.loadPromise;
  }

  /**
   * Construct the default loader: `AutoTokenizer.from_pretrained(modelId)` +
   * `AutoModelForSequenceClassification.from_pretrained(modelId, { dtype })`.
   *
   * The `@huggingface/transformers` import is dynamic so the dependency is
   * pulled in only when a `Reranker` is actually used in production — keeps
   * cold start of `createServer` predictable for callers that never set
   * `rerank: true`.
   */
  private makeDefaultLoader(): RerankerLoader {
    return async () => {
      const transformers = await import("@huggingface/transformers");
      const { AutoTokenizer, AutoModelForSequenceClassification } = transformers;
      const tokenizer = await AutoTokenizer.from_pretrained(this.modelId);
      const model = await AutoModelForSequenceClassification.from_pretrained(
        this.modelId,
        this.dtype ? { dtype: this.dtype } : {},
      );
      return { tokenizer, model };
    };
  }
}
