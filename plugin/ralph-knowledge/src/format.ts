import type { SearchResult } from "./search.js";
import type { TraverseResult } from "./traverse.js";

export interface EnrichedSearchResult extends SearchResult {
  tags: string[];
  outcomes_summary?: unknown;
}

export interface BriefSearchResult {
  id: string;
  title: string;
  type: string | null;
  date: string | null;
  tags: string[];
  score: number;
}

export interface BriefTraverseResult {
  sourceId: string;
  targetId: string;
  type: string;
  depth: number;
  doc: { title: string } | null;
  tags: string[];
}

/**
 * Format search results for return to the caller.
 *
 * brief=false (default): Returns the full enriched result objects unchanged.
 * brief=true: Returns lightweight objects with id, title, type, date, tags, score only.
 *             Strips snippet, path, status, and outcomes_summary.
 */
export function formatSearchResults(
  results: EnrichedSearchResult[],
  brief: boolean,
): EnrichedSearchResult[] | BriefSearchResult[] {
  if (!brief) {
    return results;
  }

  return results.map((r): BriefSearchResult => ({
    id: r.id,
    title: r.title,
    type: r.type,
    date: r.date,
    tags: r.tags,
    score: r.score,
  }));
}

/**
 * Format traverse results for return to the caller.
 *
 * brief=false (default): Returns the original TraverseResult objects unchanged (no tags added).
 * brief=true: Strips doc to { title } only and adds tags array per hop target.
 */
export function formatTraverseResults(
  results: TraverseResult[],
  getTagsFn: (id: string) => string[],
  brief: boolean,
): TraverseResult[] | BriefTraverseResult[] {
  if (!brief) {
    return results;
  }

  return results.map((r): BriefTraverseResult => ({
    sourceId: r.sourceId,
    targetId: r.targetId,
    type: r.type,
    depth: r.depth,
    doc: r.doc != null ? { title: r.doc.title } : null,
    tags: getTagsFn(r.targetId),
  }));
}
