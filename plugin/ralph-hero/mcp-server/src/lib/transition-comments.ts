/**
 * Transition comment format specification, builder, and parsers.
 *
 * Defines the canonical machine-parseable transition comment format
 * (`<!-- ralph-transition: {...} -->`) and provides parsers for both
 * the HTML comment format and #19's handoff_ticket markdown audit
 * comment format.
 *
 * Pure utility module — no API dependencies.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single state transition record extracted from an issue comment. */
export interface TransitionRecord {
  from: string;    // Previous workflow state
  to: string;      // New workflow state
  command: string; // Ralph command that triggered transition (e.g., "ralph_research")
  at: string;      // ISO 8601 timestamp
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Regex pattern for HTML transition comments: <!-- ralph-transition: {...} --> */
export const TRANSITION_COMMENT_PATTERN =
  /<!-- ralph-transition: (\{.*?\}) -->/g;

/** Regex pattern for #19 handoff_ticket audit comments */
export const AUDIT_COMMENT_PATTERN =
  /\*\*State transition\*\*: (.+?) → (.+?) \(intent: .+?\)\n\*\*Command\*\*: ralph_(\w+)/g;

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Build a machine-parseable HTML comment encoding a transition record.
 * The HTML comment is invisible in rendered GitHub markdown.
 * JSON is compact (no pretty-printing) for single-line format.
 */
export function buildTransitionComment(record: TransitionRecord): string {
  const json = JSON.stringify({
    from: record.from,
    to: record.to,
    command: record.command,
    at: record.at,
  });
  return `<!-- ralph-transition: ${json} -->`;
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

/**
 * Parse transition records from HTML comment format.
 * Scans text for all `<!-- ralph-transition: {...} -->` patterns.
 * Gracefully handles malformed JSON (skips unparseable entries).
 */
export function parseTransitionComments(text: string): TransitionRecord[] {
  const records: TransitionRecord[] = [];
  const regex = new RegExp(TRANSITION_COMMENT_PATTERN.source, "g");

  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed.from && parsed.to && parsed.command && parsed.at) {
        records.push({
          from: parsed.from,
          to: parsed.to,
          command: parsed.command,
          at: parsed.at,
        });
      }
    } catch {
      // Skip malformed JSON entries
    }
  }

  return records;
}

/**
 * Parse transition records from #19's handoff_ticket markdown audit format.
 * Pattern: `**State transition**: X → Y (intent: Z)\n**Command**: ralph_cmd`
 * Uses `commentCreatedAt` as the `at` timestamp since audit comments don't
 * embed their own timestamp.
 */
export function parseAuditComments(
  text: string,
  commentCreatedAt: string,
): TransitionRecord[] {
  const records: TransitionRecord[] = [];
  const regex = new RegExp(AUDIT_COMMENT_PATTERN.source, "g");

  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    records.push({
      from: match[1],
      to: match[2],
      command: `ralph_${match[3]}`,
      at: commentCreatedAt,
    });
  }

  return records;
}

/**
 * Parse transition records from a comment body, trying both formats.
 * Prefers HTML comment format; falls back to audit format.
 * Deduplicates records that appear in both formats (by from+to+command).
 *
 * This is the primary entry point for future analytics tools.
 */
export function parseAllTransitions(
  commentBody: string,
  commentCreatedAt: string,
): TransitionRecord[] {
  const htmlRecords = parseTransitionComments(commentBody);
  const auditRecords = parseAuditComments(commentBody, commentCreatedAt);

  if (htmlRecords.length === 0) {
    return auditRecords;
  }

  if (auditRecords.length === 0) {
    return htmlRecords;
  }

  // Both present — deduplicate by from+to+command
  const seen = new Set(
    htmlRecords.map((r) => `${r.from}|${r.to}|${r.command}`),
  );
  const unique = [...htmlRecords];
  for (const r of auditRecords) {
    const key = `${r.from}|${r.to}|${r.command}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(r);
    }
  }

  return unique;
}
