import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import type { ParsedDocument } from "./parser.js";

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Format a GitHub issue number with the GH- prefix.
 * Numbers under 5 digits are zero-padded to 4 digits.
 */
export function formatIssueNumber(num: number): string {
  if (num >= 10000) return `GH-${num}`;
  return `GH-${String(num).padStart(4, "0")}`;
}

/**
 * Generate a YAML frontmatter string with `---` delimiters.
 */
export function frontmatter(fields: Record<string, unknown>): string {
  return `---\n${stringify(fields)}---\n`;
}
