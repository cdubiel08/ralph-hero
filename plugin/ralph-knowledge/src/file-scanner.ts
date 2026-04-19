import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import type { IgnoreMatcher } from "./ignore.js";

/**
 * Recursively find all `.md` files under `dir`.
 *
 * Directory names beginning with `.` or `_` and file names beginning with `_`
 * are always skipped (fast-path). When an {@link IgnoreMatcher} is supplied,
 * each remaining path is additionally tested against it via its root-relative
 * form; matches are skipped.
 *
 * @param dir root directory to walk
 * @param matcher optional matcher built via `loadIgnoreForRoot(dir, …)`
 */
export function findMarkdownFiles(dir: string, matcher?: IgnoreMatcher): string[] {
  const results: string[] = [];
  function walk(d: string) {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const fullPath = join(d, entry.name);
      if (entry.isDirectory()) {
        // Fast-path: hidden/underscored directories are always skipped.
        if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
        if (matcher) {
          // Test both bare and trailing-slash forms so gitignore-style
          // directory-only patterns (e.g., `dist/`) match even when the
          // directory itself has not yet been descended.
          const rel = relative(dir, fullPath);
          if (matcher.isIgnored(rel) || matcher.isIgnored(`${rel}/`)) continue;
        }
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".md") && !entry.name.startsWith("_")) {
        if (matcher) {
          const rel = relative(dir, fullPath);
          if (matcher.isIgnored(rel)) continue;
        }
        results.push(fullPath);
      }
    }
  }
  walk(dir);
  return results;
}
