/**
 * Text similarity utilities for duplicate detection.
 *
 * Pure functions with no external dependencies. Provides Dice-Sorensen
 * bigram coefficient for title comparison and keyword extraction for
 * GitHub search queries.
 */

// ---------------------------------------------------------------------------
// Dice-Sorensen bigram coefficient
// ---------------------------------------------------------------------------

/**
 * Compute the Dice-Sorensen coefficient between two strings.
 * Returns a value between 0.0 (no similarity) and 1.0 (identical).
 */
export function diceSorensen(a: string, b: string): number {
  const na = a.toLowerCase().trim();
  const nb = b.toLowerCase().trim();
  if (na === nb) return 1.0;
  if (na.length < 2 || nb.length < 2) return 0.0;

  const bigrams = (s: string): Set<string> => {
    const set = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) {
      set.add(s.slice(i, i + 2));
    }
    return set;
  };

  const bg1 = bigrams(na);
  const bg2 = bigrams(nb);
  let intersection = 0;
  for (const b of bg1) {
    if (bg2.has(b)) intersection++;
  }
  return (2 * intersection) / (bg1.size + bg2.size);
}

// ---------------------------------------------------------------------------
// Stop words
// ---------------------------------------------------------------------------

export const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "to", "for", "in", "on", "of",
  "and", "or", "with", "from", "by", "as", "at", "this", "that",
  "it", "be", "not", "do", "have", "will", "can", "should", "would",
  "add", "new", "use",
]);

// ---------------------------------------------------------------------------
// Keyword extraction
// ---------------------------------------------------------------------------

/**
 * Extract search keywords from issue title and optional body.
 * Returns a space-separated keyword string suitable for GitHub search.
 *
 * - Tokenizes title, removes stop words, takes first 5 meaningful words
 * - Optionally extracts 2-3 keywords from body section headers
 * - Truncates to 200 chars (leaving room for search qualifiers)
 */
export function extractSearchKeywords(title: string, body?: string): string {
  const keywords: string[] = [];

  // Extract title keywords
  const titleTokens = tokenize(title);
  const titleKeywords = titleTokens
    .filter((t) => !STOP_WORDS.has(t.toLowerCase()) && t.length > 1)
    .slice(0, 5);
  keywords.push(...titleKeywords);

  // Extract body section header keywords (optional)
  if (body) {
    const sectionHeaders = body.match(/^#{2,}\s+(.+)$/gm);
    if (sectionHeaders) {
      const bodyKeywords: string[] = [];
      for (const header of sectionHeaders.slice(0, 3)) {
        const headerText = header.replace(/^#{2,}\s+/, "");
        const tokens = tokenize(headerText)
          .filter((t) => !STOP_WORDS.has(t.toLowerCase()) && t.length > 1);
        bodyKeywords.push(...tokens);
      }
      // Take up to 3 unique keywords from body
      const uniqueBodyKws = bodyKeywords
        .filter((kw) => !keywords.some((k) => k.toLowerCase() === kw.toLowerCase()))
        .slice(0, 3);
      keywords.push(...uniqueBodyKws);
    }
  }

  const result = keywords.join(" ");
  return result.length > 200 ? result.slice(0, 200).trimEnd() : result;
}

/**
 * Tokenize a string into words, stripping punctuation.
 */
function tokenize(text: string): string[] {
  return text
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

// ---------------------------------------------------------------------------
// Candidate scoring helper
// ---------------------------------------------------------------------------

export interface ScoredCandidate {
  number: number;
  title: string;
  score: number;
  [key: string]: unknown;
}

/**
 * Score and filter candidates by title similarity to a target.
 * Returns candidates sorted by score descending, filtered by threshold.
 */
export function scoreCandidates<T extends { number: number; title: string }>(
  targetTitle: string,
  targetNumber: number,
  candidates: T[],
  threshold: number,
  maxCandidates: number,
): Array<T & { score: number }> {
  return candidates
    .filter((c) => c.number !== targetNumber) // Exclude self
    .map((c) => ({
      ...c,
      score: Math.round(diceSorensen(targetTitle, c.title) * 1000) / 1000,
    }))
    .filter((c) => c.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxCandidates);
}
