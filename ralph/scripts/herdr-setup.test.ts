/**
 * herdr-setup.sh --oneline (GH-1911).
 *
 * The relay used to carry a count and the check's name. That made a real deploy
 * gap — the cockpit executing plugin code older than this ralph expects — render
 * identically to setup drift, and it was read as cosmetic for a working day. The
 * contract asserted here: one line, and that line carries what a reader needs to
 * act (both versions, and the remedy command).
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const SETUP_SH = join(dirname(fileURLToPath(import.meta.url)), "herdr-setup.sh");

/** Each test shells out to `bash herdr-setup.sh` through execFileSync, so its cost
 *  is process spawn, not I/O — and under the full suite's 12 parallel files that
 *  one subprocess loses the race against vitest's 5000 ms default (GH-2065:
 *  observed red, then green on a bare re-run of the same suite). Sized per test
 *  rather than by raising the global testTimeout, which would mask genuinely slow
 *  tests elsewhere; 20 s leaves room for a loaded CI runner while still bounding a
 *  hang — it is the ceiling on both halves, the spawn below and the test itself. */
const SUBPROCESS_TIMEOUT_MS = 20_000;

/** A herdr stand-in that reports a healthy, wired cockpit — so the only gap the
 *  script can find is the one under test. */
function fakeHerdr(): string {
  const dir = mkdtempSync(join(tmpdir(), "herdr-bin-"));
  const bin = join(dir, "herdr");
  writeFileSync(
    bin,
    `#!/usr/bin/env bash
case "$1 $2" in
  "--version ") echo "herdr 0.9.0" ;;
  "agent list") echo "[]" ;;
  "plugin list") echo "ralph-herdr  enabled" ;;
  "integration status") echo "claude: installed" ;;
  *) exit 0 ;;
esac
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

function runOneline(pluginVersion: string, stampVersion: string): string {
  const dir = mkdtempSync(join(tmpdir(), "herdr-setup-"));
  const pluginsJson = join(dir, "plugins.json");
  writeFileSync(
    pluginsJson,
    JSON.stringify([
      {
        plugin_id: "ralph-herdr",
        plugin_root: join(dir, "root"),
        version: pluginVersion,
        source: {
          kind: "github",
          owner: "cdubiel08",
          repo: "ralph-hero",
          subdir: "plugin/ralph-herdr",
          requested_ref: "main",
        },
      },
    ]),
  );
  const stamp = join(dir, "herdr-plugin-version");
  writeFileSync(stamp, `${stampVersion}\n`);
  const repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });

  try {
    return execFileSync("bash", [SETUP_SH, "check", "--oneline"], {
      encoding: "utf8",
      stdio: "pipe",
      // execFileSync BLOCKS the worker, so vitest's own timeout cannot interrupt it —
      // it only fires once this returns. Without a kill here a genuine hang in the
      // script hangs the suite forever, and the per-test timeout below would never
      // be reached to report it.
      timeout: SUBPROCESS_TIMEOUT_MS,
      env: {
        ...process.env,
        HERDR_BIN_PATH: fakeHerdr(),
        RALPH_HERDR_PLUGINS_JSON: pluginsJson,
        RALPH_HERDR_VERSION_STAMP: stamp,
        RALPH_HERDR_REPO: repo,
      },
    });
  } catch (e: any) {
    // Exit 1 = gaps found, which is the case under test; the verdict is stdout.
    if (e?.status === 1 && typeof e.stdout === "string") return e.stdout;
    throw e;
  }
}

describe("herdr-setup.sh --oneline carries the finding, not just its name", () => {
  it("a stale ralph-herdr plugin relays both versions and the remedy command", () => {
    const out = runOneline("0.5.1", "0.5.2");
    expect(out.trim().split("\n")).toHaveLength(1); // still exactly one line
    expect(out).toMatch(/^herdr: \d+ gap\(s\) — /);
    expect(out).toContain("ralph-herdr-version:");
    expect(out).toContain("0.5.1 < 0.5.2");
    expect(out).toContain("herdr plugin install cdubiel08/ralph-hero/plugin/ralph-herdr --ref main -y");
    // The consequence, in the same "not in effect" language installed-plugin uses.
    expect(out).toContain("EXECUTING PLUGIN CODE OLDER");
  }, SUBPROCESS_TIMEOUT_MS);

  it("a current plugin produces no version gap at all", () => {
    const out = runOneline("0.5.2", "0.5.2");
    expect(out.trim().split("\n")).toHaveLength(1);
    expect(out).not.toContain("ralph-herdr-version");
  }, SUBPROCESS_TIMEOUT_MS);
});
