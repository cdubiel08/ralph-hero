import {
  pipeline,
  type FeatureExtractionPipeline,
} from "@huggingface/transformers";

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const MAX_CHARS = 500;

let embedderInstance: FeatureExtractionPipeline | null = null;

export async function getEmbedder(): Promise<FeatureExtractionPipeline> {
  if (!embedderInstance) {
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
  content: string
): string {
  return `${title}\n${content}`.slice(0, MAX_CHARS);
}
