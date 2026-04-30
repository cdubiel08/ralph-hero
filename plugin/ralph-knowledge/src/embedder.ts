import {
  pipeline,
  type FeatureExtractionPipeline,
} from "@huggingface/transformers";
import { chunkText, type Chunk, type ChunkerOptions } from "./chunker.js";
import type { LlmClient } from "./llm-client.js";

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";

let embedderInstance: FeatureExtractionPipeline | null = null;

export async function getEmbedder(): Promise<FeatureExtractionPipeline> {
  if (!embedderInstance) {
    // @ts-expect-error pipeline() overload union is too complex for TS
    embedderInstance = (await pipeline(
      "feature-extraction",
      MODEL_ID
    )) as FeatureExtractionPipeline;
  }
  return embedderInstance;
}

export async function embed(text: string): Promise<Float32Array> {
  const embedder = await getEmbedder();
  // Pass text directly — the transformer's own 512-token window handles overflow.
  const output = await embedder(text, {
    pooling: "mean",
    normalize: true,
  });
  // Copy data into a freshly allocated Float32Array (constructor's ArrayLike
  // overload iterates and assigns, decoupling from the source buffer).
  const embedding = new Float32Array(output.data as ArrayLike<number>);
  // GH-911: eagerly release the underlying ONNX-runtime native tensor buffer.
  // V8 cannot reclaim native (off-heap) memory fast enough across the per-chunk
  // await loop in `embedDocument()`, which causes the corpus reindex to OOM at
  // ~150 chunks. `Tensor.dispose()` (transformers.js v3) calls
  // `ort_tensor.dispose()` which frees the native buffer immediately.
  // The guard tolerates test mocks that lack a `dispose` method.
  if (output && typeof (output as { dispose?: unknown }).dispose === "function") {
    (output as { dispose: () => void }).dispose();
  }
  return embedding;
}

/**
 * A chunk paired with the embedding of its (contextualized) content.
 * Extends the base Chunk from the chunker module with an embedding vector
 * and an optional contextPrefix (populated by Phase 6 — contextual retrieval).
 */
export interface DocumentChunk extends Chunk {
  embedding: Float32Array;
  contextPrefix?: string;
}

/**
 * Options accepted by `embedDocument`. Extends `ChunkerOptions` with optional
 * Contextual Retrieval inputs:
 *
 * - `llm`: when present, each chunk is run through `llm.contextualize(fullDoc, chunkContent)`
 *   and the returned string is prepended to the embed text (and persisted on the
 *   resulting `DocumentChunk.contextPrefix`). Empty-string returns (fail-open from
 *   the LLM client) cause the embed text to fall back to the legacy
 *   `${title}\n${tagLine}\n${chunk.content}` shape.
 * - `cachedPrefixes`: optional `Map<chunkIndex, contextPrefix>` from a prior run.
 *   When a chunk's index has a cached prefix, the LLM call is skipped and the
 *   cached string is reused verbatim. Used by the reindex content-hash cache
 *   fast-path (Task 6.4) so unchanged docs don't re-contact the LLM endpoint.
 */
export interface EmbedDocumentOptions extends ChunkerOptions {
  llm?: LlmClient;
  cachedPrefixes?: Map<number, string>;
}

/**
 * Embed a document by splitting it into chunks and emitting one embedding
 * per chunk. The embedded text for each chunk is
 * `${title}\n${tagLine}\n${chunk.content}` so the semantic anchors (title +
 * tags) travel with every chunk embedding — matching the shape of the legacy
 * `prepareTextForEmbedding()` but without the 500-char truncation.
 *
 * When `opts.llm` is provided (Phase 6 — Contextual Retrieval), a short
 * context prefix is generated per chunk via `opts.llm.contextualize(content, chunk.content)`
 * and prepended to the embed text as `${contextPrefix}\n${title}\n${tagLine}\n${chunk.content}`.
 * If `contextualize` returns `""` (fail-open path), the embed text reverts to the
 * no-context shape so we never emit a leading blank line.
 *
 * Short documents (<= chunkSize) produce exactly one chunk covering the whole
 * content. Empty content yields a single chunk with empty content (so callers
 * still get a title/tag-only embedding for stub documents).
 */
export async function embedDocument(
  title: string,
  tags: string[],
  content: string,
  opts?: EmbedDocumentOptions,
): Promise<DocumentChunk[]> {
  const tagLine = tags.length > 0 ? tags.join(", ") : "";

  // If content is empty, still emit one chunk so the document has a searchable
  // embedding anchored on title + tags (preserves legacy behavior for
  // frontmatter-only / stub documents).
  const chunks: Chunk[] = content.length === 0
    ? [{ index: 0, content: "", charStart: 0, charEnd: 0 }]
    : chunkText(content, opts);

  const llm = opts?.llm;
  const cached = opts?.cachedPrefixes;

  const out: DocumentChunk[] = [];
  for (const chunk of chunks) {
    let contextPrefix = "";
    if (llm) {
      // Cache hit: reuse prior context_prefix when the caller supplied a map
      // keyed by chunk.index. Avoids an LLM round-trip per unchanged chunk.
      if (cached && cached.has(chunk.index)) {
        contextPrefix = cached.get(chunk.index) ?? "";
      } else {
        // `contextualize` is fail-open: it returns "" on any network/timeout/
        // malformed-response error. That empty string propagates into the
        // returned `DocumentChunk.contextPrefix` (persisted by the caller) and
        // causes the embed text to skip the leading blank line below.
        contextPrefix = await llm.contextualize(content, chunk.content);
      }
    }

    const parts = contextPrefix.length > 0
      ? [contextPrefix, title, tagLine, chunk.content]
      : [title, tagLine, chunk.content];
    const embedText = parts.filter(p => p.length > 0).join("\n");
    const embedding = await embed(embedText);
    out.push({
      index: chunk.index,
      content: chunk.content,
      charStart: chunk.charStart,
      charEnd: chunk.charEnd,
      embedding,
      contextPrefix,
    });
  }
  return out;
}

/**
 * Back-compat shim: kept so callers outside the reindex path can still build
 * a title/tags/first-paragraph string. No longer used by `embedDocument` (the
 * per-chunk flow prepends title + tags directly).
 */
export function prepareTextForEmbedding(
  title: string,
  tags: string[],
  content: string,
): string {
  const tagLine = tags.length > 0 ? tags.join(", ") : "";
  // Extract first paragraph: split on blank lines, take first non-empty segment
  const paragraphs = content.split(/\n\n+/);
  const firstParagraph = paragraphs.find(p => p.trim().length > 0)?.trim() ?? "";
  const parts = [title, tagLine, firstParagraph].filter(p => p.length > 0);
  return parts.join("\n");
}
