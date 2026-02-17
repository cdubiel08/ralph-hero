/**
 * Text similarity utilities for duplicate detection.
 *
 * Provides Dice-Sorensen bigram coefficient for title comparison and
 * keyword extraction for building GitHub search queries.
 * Zero dependencies — pure string operations.
 */

// ---------------------------------------------------------------------------
// Stop words for keyword extraction
// ---------------------------------------------------------------------------

export const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "to", "for", "in", "on", "of",
  "and", "or", "with", "from", "by", "as", "at", "this", "that",
  "it", "be", "not", "do", "have", "will", "can", "should", "would",
  "add", "new", "use",
]);

// ---------------------------------------------------------------------------
// Dice-Sorensen bigram coefficient
// ---------------------------------------------------------------------------

/**
 * Compute the Dice-Sorensen bigram coefficient between two strings.
 * Returns a value between 0.0 (no similarity) and 1.0 (identical).
 * Case-insensitive comparison.
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
// Keyword extraction for search queries
// ---------------------------------------------------------------------------

/**
 * Extract search keywords from issue title and optional body.
 * Returns a space-separated string suitable for GitHub search queries.
 *
 * - Tokenizes on whitespace and punctuation
 * - Removes stop words
 * - Takes up to 5 words from title, plus up to 3 from body section headers
 * - Truncates result to 200 characters
 */
export function extractSearchKeywords(
  title: string,
  body?: string,
): string {
  const tokenize = (s: string): string[] =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1 && !STOP_WORDS.has(w));

  // Extract up to 5 meaningful words from title
  const titleWords = tokenize(title).slice(0, 5);

  // Extract up to 3 keywords from body section headers (## lines)
  const bodyWords: string[] = [];
  if (body) {
    const headerLines = body
      .split("\n")
      .filter((line) => line.startsWith("##"))
      .join(" ");
    bodyWords.push(...tokenize(headerLines).slice(0, 3));
  }

  // Combine, deduplicate, and truncate
  const seen = new Set(titleWords);
  for (const w of bodyWords) {
    if (!seen.has(w)) {
      seen.add(w);
      titleWords.push(w);
    }
  }

  const result = titleWords.join(" ");
  return result.length > 200 ? result.slice(0, 200).trimEnd() : result;
}
