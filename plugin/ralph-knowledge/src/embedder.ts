import {
  pipeline,
  type FeatureExtractionPipeline,
} from "@huggingface/transformers";

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const MAX_CHARS = 500;

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
  const truncated = text.slice(0, MAX_CHARS);
  const output = await embedder(truncated, {
    pooling: "mean",
    normalize: true,
  });
  return new Float32Array(output.data as ArrayLike<number>);
}

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
  return parts.join("\n").slice(0, MAX_CHARS);
}
