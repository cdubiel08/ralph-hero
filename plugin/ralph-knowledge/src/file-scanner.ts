import { readdirSync } from "node:fs";
import { join } from "node:path";

export function findMarkdownFiles(dir: string): string[] {
  const results: string[] = [];
  function walk(d: string) {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const fullPath = join(d, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith(".") && !entry.name.startsWith("_")) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".md") && !entry.name.startsWith("_")) {
        results.push(fullPath);
      }
    }
  }
  walk(dir);
  return results;
}
