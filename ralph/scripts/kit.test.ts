/**
 * kit.test.ts — ralph/kit/ is a byte-identical vendored copy of the canonical
 * merge-gate sources (GH-2083). The kit ships in the plugin (the marketplace
 * packages only ./ralph); canonical stays at the repo root. This test is the
 * anti-drift mechanism — the GH-2058 shape: an edit to scripts/merge-pr.sh
 * that skips `bash ralph/scripts/kit-sync.sh` is a red build naming the
 * remedy, not a convention quietly ignored.
 */

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(__dirname, "..", "..");
const KIT_DIR = join(REPO_ROOT, "ralph", "kit");

const manifest = JSON.parse(readFileSync(join(KIT_DIR, "manifest.json"), "utf8")) as {
  files: Record<string, string>;
};

/** Same mapping kit-sync.sh applies: host-repo destination -> kit-dir path. */
const kitPath = (dest: string) =>
  dest.startsWith(".github/workflows/")
    ? join("workflows", dest.slice(".github/workflows/".length))
    : dest;

const sha256 = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

describe("ralph/kit is in sync with canonical sources", () => {
  const entries = Object.entries(manifest.files);

  it("manifest is non-trivial", () => {
    expect(entries.length).toBeGreaterThanOrEqual(17);
  });

  for (const [dest, hash] of entries) {
    it(`${dest} — kit copy matches canonical and manifest`, () => {
      const canonical = readFileSync(join(REPO_ROOT, dest));
      const kit = readFileSync(join(KIT_DIR, kitPath(dest)));
      const remedy = "out of sync — run: bash ralph/scripts/kit-sync.sh";
      expect(kit.equals(canonical), `${dest} ${remedy}`).toBe(true);
      expect(sha256(canonical), `${dest} manifest hash ${remedy}`).toBe(hash);
    });
  }

  it("kit dir holds exactly the manifest's files (no strays)", () => {
    const expected = new Set(
      entries.map(([dest]) => join(KIT_DIR, kitPath(dest))).concat(join(KIT_DIR, "manifest.json")),
    );
    expect(new Set(walk(KIT_DIR))).toEqual(expected);
  });
});
