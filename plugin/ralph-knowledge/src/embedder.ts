import {
  pipeline,
  type FeatureExtractionPipeline,
} from "@huggingface/transformers";
import { chunkText, type Chunk, type ChunkerOptions } from "./chunker.js";

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
  return new Float32Array(output.data as ArrayLike<number>);
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
 * Embed a document by splitting it into chunks and emitting one embedding
 * per chunk. The embedded text for each chunk is
 * `${title}\n${tagLine}\n${chunk.content}` so the semantic anchors (title +
 * tags) travel with every chunk embedding — matching the shape of the legacy
 * `prepareTextForEmbedding()` but without the 500-char truncation.
 *
 * Short documents (<= chunkSize) produce exactly one chunk covering the whole
 * content. Empty content yields a single chunk with empty content (so callers
 * still get a title/tag-only embedding for stub documents).
 */
export async function embedDocument(
  title: string,
  tags: string[],
  content: string,
  opts?: ChunkerOptions,
): Promise<DocumentChunk[]> {
  const tagLine = tags.length > 0 ? tags.join(", ") : "";

  // If content is empty, still emit one chunk so the document has a searchable
  // embedding anchored on title + tags (preserves legacy behavior for
  // frontmatter-only / stub documents).
  const chunks: Chunk[] = content.length === 0
    ? [{ index: 0, content: "", charStart: 0, charEnd: 0 }]
    : chunkText(content, opts);

  const out: DocumentChunk[] = [];
  for (const chunk of chunks) {
    const parts = [title, tagLine, chunk.content].filter(p => p.length > 0);
    const embedText = parts.join("\n");
    const embedding = await embed(embedText);
    out.push({
      index: chunk.index,
      content: chunk.content,
      charStart: chunk.charStart,
      charEnd: chunk.charEnd,
      embedding,
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
