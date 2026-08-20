/**
 * kit.test.ts — ralph/kit/ is a byte-identical vendored copy of the canonical
 * merge-gate sources (GH-2083). The kit ships in the plugin (the marketplace
 * packages only ./ralph); canonical stays at the repo root. This test is the
 * anti-drift mechanism — the GH-2058 shape: an edit to scripts/merge-pr.sh
 * that skips `bash ralph/scripts/kit-sync.sh` is a red build naming the
 * remedy, not a convention quietly ignored.
 *
 * The manifest's `sources` map (audit C3) names the canonical source for the
 * entries whose host destination differs from where the canonical file lives
 * (the advisory hooks vendored from ralph/hooks/, the kit-only sources under
 * ralph/scripts/kit-src/); absent an entry, canonical == destination.
 * `fragments` are the marker-merged blocks install-gates.sh writes into
 * host-owned files — byte-identity holds for them too, they just install
 * differently.
 */

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(__dirname, "..", "..");
const KIT_DIR = join(REPO_ROOT, "ralph", "kit");

const manifest = JSON.parse(readFileSync(join(KIT_DIR, "manifest.json"), "utf8")) as {
  files: Record<string, string>;
  sources?: Record<string, string>;
  fragments?: Record<string, { kit: string; src: string; sha256: string }>;
};

/** Same mapping kit-sync.sh applies: host-repo destination -> kit-dir path. */
const kitPath = (dest: string) => {
  if (dest.startsWith(".github/workflows/"))
    return join("workflows", dest.slice(".github/workflows/".length));
  if (dest.startsWith(".claude/hooks/")) return join("hooks", dest.slice(".claude/hooks/".length));
  return dest;
};

/** Canonical source for a destination: the sources map, else the dest itself. */
const canonicalPath = (dest: string) => manifest.sources?.[dest] ?? dest;

const sha256 = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

describe("ralph/kit is in sync with canonical sources", () => {
  const entries = Object.entries(manifest.files);
  const fragments = Object.entries(manifest.fragments ?? {});

  it("manifest is non-trivial", () => {
    expect(entries.length).toBeGreaterThanOrEqual(17);
  });

  for (const [dest, hash] of entries) {
    it(`${dest} — kit copy matches canonical and manifest`, () => {
      const canonical = readFileSync(join(REPO_ROOT, canonicalPath(dest)));
      const kit = readFileSync(join(KIT_DIR, kitPath(dest)));
      const remedy = "out of sync — run: bash ralph/scripts/kit-sync.sh";
      expect(kit.equals(canonical), `${dest} ${remedy}`).toBe(true);
      expect(sha256(canonical), `${dest} manifest hash ${remedy}`).toBe(hash);
    });
  }

  for (const [dest, frag] of fragments) {
    it(`fragment ${dest} — kit copy matches canonical and manifest`, () => {
      const canonical = readFileSync(join(REPO_ROOT, frag.src));
      const kit = readFileSync(join(KIT_DIR, frag.kit));
      const remedy = "out of sync — run: bash ralph/scripts/kit-sync.sh";
      expect(kit.equals(canonical), `fragment ${dest} ${remedy}`).toBe(true);
      expect(sha256(canonical), `fragment ${dest} manifest hash ${remedy}`).toBe(frag.sha256);
    });

    it(`fragment ${dest} — carries the BEGIN/END ralph-kit markers install-gates keys on`, () => {
      const text = readFileSync(join(KIT_DIR, frag.kit), "utf8");
      expect(text).toContain("<!-- BEGIN ralph-kit -->");
      expect(text).toContain("<!-- END ralph-kit -->");
    });
  }

  it("every sources entry names a file the manifest actually ships", () => {
    for (const dest of Object.keys(manifest.sources ?? {})) {
      expect(manifest.files[dest], `sources entry for unshipped dest: ${dest}`).toBeDefined();
    }
  });

  it("kit dir holds exactly the manifest's files (no strays)", () => {
    const expected = new Set(
      entries
        .map(([dest]) => join(KIT_DIR, kitPath(dest)))
        .concat(fragments.map(([, f]) => join(KIT_DIR, f.kit)))
        .concat(join(KIT_DIR, "manifest.json")),
    );
    expect(new Set(walk(KIT_DIR))).toEqual(expected);
  });
});
