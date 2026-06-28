/**
 * Query-time synthesis ("ralph think") — GH-1512, epic #1509 Phase 4.
 *
 * Borrows the `gbrain think` idiom in-place: retrieve the top-K knowledge-base
 * excerpts for a query, then ask the local model to synthesize a CITED answer
 * grounded ONLY in those excerpts, plus an explicit "gaps" report of what the
 * knowledge base does NOT contain. This bridges usefulness for the
 * planner/researcher roles before the reflection tier is fully populated, and
 * decouples user value from pipeline backlog.
 *
 * Fail-open: an empty completion (local model offline) or an unparseable
 * response never throws — the retrieved sources are always returned so the
 * caller gets value even when synthesis is unavailable.
 */

export interface ThinkSource {
  id: string;
  title?: string;
  path?: string;
  tier?: string;
  snippet: string;
  score?: number;
}

export interface ThinkResult {
  query: string;
  /** Synthesized answer (cites sources inline as [id]); "" when not synthesized. */
  answer: string;
  /** What the knowledge base does NOT contain to fully answer. */
  gaps: string;
  /** The retrieved excerpts the answer is grounded in. */
  sources: ThinkSource[];
  /** True iff the local model produced an answer. */
  synthesized: boolean;
}

const SNIPPET_CLIP = 600;

export function buildThinkPrompt(query: string, sources: ThinkSource[]): string {
  const blocks = sources
    .map((s) => {
      const title = s.title ? ` (${s.title})` : "";
      const tier = s.tier ? ` {${s.tier}}` : "";
      const snippet = (s.snippet || "").slice(0, SNIPPET_CLIP);
      return `[${s.id}]${title}${tier}\n${snippet}`;
    })
    .join("\n\n");

  return [
    "You are answering a question using ONLY the knowledge-base excerpts below.",
    "Do not invent facts that are not supported by an excerpt.",
    "",
    `Question: ${query}`,
    "",
    "Excerpts:",
    blocks,
    "",
    'Return ONLY a JSON object: {"answer": "...", "gaps": "..."}',
    "- answer: a concise synthesis grounded in the excerpts. Cite the excerpts",
    "  you use inline by their bracketed id, e.g. [reflection-abc]. If the",
    "  excerpts do not answer the question, say so plainly in the answer.",
    "- gaps: explicitly state what the knowledge base does NOT contain that",
    '  would be needed to fully answer (or "none" if the excerpts fully cover it).',
  ].join("\n");
}

export function parseThinkResponse(
  text: string,
): { answer: string; gaps: string } | null {
  let raw = (text || "").trim();
  if (raw.startsWith("```")) {
    const firstNl = raw.indexOf("\n");
    if (firstNl !== -1) raw = raw.slice(firstNl + 1);
    if (raw.trimEnd().endsWith("```")) raw = raw.trimEnd().slice(0, -3).trimEnd();
  }
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const obj = data as Record<string, unknown>;
  if (typeof obj.answer !== "string") return null;
  return {
    answer: obj.answer,
    gaps: typeof obj.gaps === "string" ? obj.gaps : "",
  };
}

export async function think(
  query: string,
  sources: ThinkSource[],
  complete: (prompt: string) => Promise<string>,
): Promise<ThinkResult> {
  if (sources.length === 0) {
    return {
      query,
      answer: "",
      gaps: "No matching documents in the knowledge base for this query.",
      sources: [],
      synthesized: false,
    };
  }

  const prompt = buildThinkPrompt(query, sources);
  // Fail-open is self-contained: the injected completion fn is expected to
  // return "" on failure, but we also guard a thrown rejection here so a
  // non-fail-open caller can never turn an offline model into a tool error.
  let completion = "";
  try {
    completion = (await complete(prompt)) ?? "";
  } catch {
    completion = "";
  }
  if (!completion.trim()) {
    return {
      query,
      answer: "",
      gaps: "Synthesis unavailable (local model offline); returning retrieved sources only.",
      sources,
      synthesized: false,
    };
  }

  const parsed = parseThinkResponse(completion);
  if (parsed === null) {
    // Model answered but not as JSON — keep the prose rather than discard it.
    return {
      query,
      answer: completion.trim(),
      gaps: "",
      sources,
      synthesized: true,
    };
  }

  return {
    query,
    answer: parsed.answer,
    gaps: parsed.gaps,
    sources,
    synthesized: true,
  };
}
