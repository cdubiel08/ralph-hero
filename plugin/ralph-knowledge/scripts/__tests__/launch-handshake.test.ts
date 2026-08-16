import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SCRIPTS = path.resolve(__dirname, "..");

// The claim under test is a TIMING one — "a bootstrap slower than the deadline
// yields a live stub instead of a dead server" — so the launcher is run for
// real, against a fake npm whose duration the test controls. Asserting on the
// script's text instead would prove only that the branch was written.
let root: string;

/** A plugin root the launcher will treat as needing a bootstrap. */
function makePluginRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-knowledge-launch-"));
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "fake", version: "0.0.0", dependencies: {} }),
  );
  // An empty lockfile means deps-complete.cjs requires nothing, so the fake
  // install below is enough to satisfy it — the dependency walk has its own
  // suite and is not what this file is measuring.
  fs.writeFileSync(
    path.join(dir, "package-lock.json"),
    JSON.stringify({ name: "fake", lockfileVersion: 3, packages: {} }),
  );
  fs.writeFileSync(path.join(dir, "tsconfig.json"), "{}");
  fs.mkdirSync(path.join(dir, "src"));
  fs.mkdirSync(path.join(dir, "scripts"));
  for (const f of ["launch-mcp.sh", "deps-complete.cjs", "handshake-stub.cjs"]) {
    fs.copyFileSync(path.join(SCRIPTS, f), path.join(dir, "scripts", f));
  }
  fs.chmodSync(path.join(dir, "scripts", "launch-mcp.sh"), 0o755);
  return dir;
}

/**
 * A `npm` on PATH that takes `sleepSec` and then produces exactly what the
 * launcher checks for: node_modules and dist/index.js. `fail` makes it exit
 * non-zero instead, which is the broken-install case.
 */
function fakeNpm(dir: string, sleepSec: number, fail = false): string {
  const bin = path.join(dir, "fakebin");
  fs.mkdirSync(bin, { recursive: true });
  const npm = path.join(bin, "npm");
  fs.writeFileSync(
    npm,
    [
      "#!/usr/bin/env bash",
      "set -eu",
      'case "${1:-}" in',
      "  ci)",
      `    sleep ${sleepSec}`,
      fail ? '    echo "fake npm ci failed" >&2; exit 1;;' : "    ;;",
      "  esac",
      "mkdir -p node_modules dist",
      // A served entry point that identifies itself, so the test can tell the
      // real server from the stub by what comes back over the wire.
      `printf 'process.stdout.write("REAL-SERVER\\\\n");' >dist/index.js`,
      "exit 0",
    ].join("\n"),
  );
  fs.chmodSync(npm, 0o755);
  return bin;
}

/** Run the launcher, feed it one initialize, and report what answered. */
function launch(
  dir: string,
  bin: string,
  deadline: string,
  timeoutMs = 30_000,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [path.join(dir, "scripts", "launch-mcp.sh")], {
      cwd: dir,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        CLAUDE_PLUGIN_ROOT: dir,
        RALPH_KNOWLEDGE_HANDSHAKE_DEADLINE_SEC: deadline,
      },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`launcher timed out\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c: string) => {
      stdout += c;
      // Enough has come back to identify the server; close the channel the way
      // a client disconnecting would.
      if (stdout.includes("\n")) child.stdin.end();
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => {
      stderr += c;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {} },
      }) + "\n",
    );
  });
}

beforeEach(() => {
  root = makePluginRoot();
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("launcher handshake deadline (GH-1850)", () => {
  it("serves the real server when the bootstrap finishes inside the deadline", async () => {
    // The point of the deadline being 15s and a bootstrap ~4.5s: the ordinary
    // cold start is unchanged and still gets the full toolset on the FIRST
    // session. A change that pushed everyone onto the stub would be a
    // regression dressed as a fix.
    const bin = fakeNpm(root, 0);
    const { stdout } = await launch(root, bin, "10");
    expect(stdout).toContain("REAL-SERVER");
  }, 20_000);

  it("serves a live stub when the bootstrap outruns the deadline", async () => {
    const bin = fakeNpm(root, 20);
    const { stdout, stderr } = await launch(root, bin, "2");
    const reply = JSON.parse(stdout.split("\n")[0]);
    expect(reply.id).toBe(1);
    expect(reply.error).toBeUndefined();
    expect(reply.result.instructions).toMatch(/installing/i);
    expect(reply.result.capabilities.tools).toBeDefined();
    expect(stderr).toMatch(/still running/i);
  }, 30_000);

  it("finishes the install in the background after serving the stub", async () => {
    // The stub buys nothing if the install dies with the handshake — the whole
    // proposition is that the NEXT session is warm.
    const bin = fakeNpm(root, 3);
    await launch(root, bin, "1");
    const marker = fs
      .readdirSync(path.join(root, ".runtimes"))
      .map((k) => path.join(root, ".runtimes", k, ".bootstrap-complete"));
    await new Promise((r) => setTimeout(r, 6_000));
    expect(marker.some((m) => fs.existsSync(m))).toBe(true);
  }, 20_000);

  it("fails loudly on a broken install rather than serving a stub forever", async () => {
    // Slow and broken must not look alike: an npm that can never succeed would
    // otherwise produce a permanently tool-less plugin with no error anywhere.
    const bin = fakeNpm(root, 0, true);
    const { stdout, stderr, code } = await launch(root, bin, "10");
    expect(code).not.toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toMatch(/bootstrap failed/i);
  }, 20_000);

  it("blocks as before when the deadline is disabled", async () => {
    // 0 is the documented escape hatch back to pre-GH-1850 behaviour, and it
    // has to actually wait rather than fall through to the stub.
    const bin = fakeNpm(root, 3);
    const { stdout } = await launch(root, bin, "0");
    expect(stdout).toContain("REAL-SERVER");
  }, 20_000);
});
