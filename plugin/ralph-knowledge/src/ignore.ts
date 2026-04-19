import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import ignorePkg, { type Ignore } from "ignore";

// The `ignore` CJS module exposes the factory via `module.exports = factory`
// with `factory.default = factory` attached. Under `NodeNext` + ESM, depending
// on the interop mode, the default import can resolve to either the factory
// itself or the whole namespace. Probe and pick the callable form.
const ignore: (options?: { ignorecase?: boolean }) => Ignore = (
  typeof (ignorePkg as unknown) === "function"
    ? (ignorePkg as unknown as (options?: { ignorecase?: boolean }) => Ignore)
    : ((ignorePkg as unknown as { default: (options?: { ignorecase?: boolean }) => Ignore }).default)
);

/**
 * Default ignore patterns applied to every root even when no `.ralphignore`
 * file or caller-supplied globals are provided. These target directories and
 * files that should virtually never be indexed.
 */
export const DEFAULT_IGNORE_PATTERNS: string[] = [
  ".claude/",
  "node_modules/",
  "dist/",
  ".git/",
  "*.log",
];

/**
 * Opaque matcher returned by {@link loadIgnoreForRoot}. Given a path relative
 * to the root used to construct the matcher, {@link isIgnored} reports whether
 * the path should be skipped by the scanner.
 */
export interface IgnoreMatcher {
  isIgnored(relativePath: string): boolean;
}

/**
 * Build an {@link IgnoreMatcher} for a given root directory. The matcher
 * combines (in order):
 *   1. {@link DEFAULT_IGNORE_PATTERNS} — always applied.
 *   2. `globalPatterns` — caller-supplied patterns (typically from
 *      `knowledge.config.json`'s `ignorePatterns`).
 *   3. Contents of `<rootDir>/.ralphignore`, if present.
 *
 * All patterns follow gitignore syntax via the `ignore` package.
 *
 * @param rootDir absolute path of the root being scanned
 * @param globalPatterns optional extra patterns applied before the per-root
 *   `.ralphignore` file
 */
export function loadIgnoreForRoot(
  rootDir: string,
  globalPatterns?: string[],
): IgnoreMatcher {
  const ign: Ignore = ignore();
  ign.add(DEFAULT_IGNORE_PATTERNS);
  if (globalPatterns && globalPatterns.length > 0) {
    ign.add(globalPatterns);
  }

  const ralphIgnorePath = join(rootDir, ".ralphignore");
  if (existsSync(ralphIgnorePath)) {
    try {
      const contents = readFileSync(ralphIgnorePath, "utf-8");
      ign.add(contents);
    } catch (e) {
      console.warn(
        `Failed to read .ralphignore at ${ralphIgnorePath}: ${(e as Error).message}`,
      );
    }
  }

  return {
    isIgnored(relativePath: string): boolean {
      if (!relativePath) return false;
      // `ignore` package requires forward-slash paths with no leading slash.
      const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
      if (!normalized) return false;
      return ign.ignores(normalized);
    },
  };
}
