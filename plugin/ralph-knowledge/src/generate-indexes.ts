import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { stringify as yamlStringify } from "yaml";
import type { ParsedDocument } from "./parser.js";

export function formatIssueNumber(num: number): string {
  return num < 10000 ? `GH-${String(num).padStart(4, "0")}` : `GH-${num}`;
}

export function frontmatter(fields: Record<string, unknown>): string {
  return `---\n${yamlStringify(fields).trimEnd()}\n---\n`;
}
