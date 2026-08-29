/**
 * rh — command router contract.
 *
 * These integration tests execute the public shell entrypoint. A fake board is
 * necessary because the board CLI is external to the router; its observable
 * argv, stdin, streams, exit status, and signal are the forwarding contract.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const RH = join(fileURLToPath(new URL(".", import.meta.url)), "rh");
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "rh-test-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function executable(contents: string): string {
  const path = join(tmp, `fake-${Math.random().toString(36).slice(2)}`);
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
  return path;
}

function runRh(
  argv: string[],
  opts: { RALPH_BOARD?: string; cwd?: string; stdin?: string } = {},
): { status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string } {
  const result = spawnSync("/bin/bash", [RH, ...argv], {
    cwd: opts.cwd ?? tmp,
    encoding: "utf8",
    input: opts.stdin,
    env: {
      PATH: process.env.PATH ?? "",
      ...(opts.RALPH_BOARD ? { RALPH_BOARD: opts.RALPH_BOARD } : {}),
    },
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("rh", () => {
  it("executes the resolved board with byte-identical argv, stdin, streams, and rc", () => {
    const fake = executable(`#!/bin/bash
printf 'argc=%s\\n' "$#"
for arg in "$@"; do printf '<%s>\\n' "$arg"; done
IFS= read -r line || true
printf 'stdin=<%s>\\n' "$line"
printf 'board-stderr\\n' >&2
exit 23
`);
    const r = runRh(["board", "get", "22", "--title", "two words"], {
      RALPH_BOARD: fake,
      stdin: "payload with spaces\n",
    });
    expect(r.status).toBe(23);
    expect(r.stdout).toBe("argc=4\n<get>\n<22>\n<--title>\n<two words>\nstdin=<payload with spaces>\n");
    expect(r.stderr).toBe("board-stderr\n");
  });

  it("stops parsing global options after board", () => {
    const log = join(tmp, "argv.log");
    const fake = executable(`#!/bin/bash\nprintf '%s\\n' "$@" >"${log}"\n`);
    const r = runRh(["board", "--color=always", "list"], { RALPH_BOARD: fake });
    expect(r.status).toBe(0);
    expect(readFileSync(log, "utf8")).toBe("--color=always\nlist\n");
  });

  it("preserves a delegated board signal", () => {
    const fake = executable("#!/bin/bash\nkill -TERM $$\n");
    const r = runRh(["board", "list"], { RALPH_BOARD: fake });
    expect(r.status).toBeNull();
    expect(r.signal).toBe("SIGTERM");
  });

  it("help and version work outside a git repository", () => {
    expect(runRh(["help"], { cwd: tmp }).status).toBe(0);
    expect(runRh(["--help"], { cwd: tmp }).status).toBe(0);
    expect(runRh(["version"], { cwd: tmp }).stdout).toMatch(/^rh /);
    expect(runRh(["--version"], { cwd: tmp }).stdout).toMatch(/^rh /);
  });

  it("unknown commands fail as usage without invoking board", () => {
    const r = runRh(["dipsatch"], { cwd: tmp });
    expect(r.status).toBe(64);
    expect(r.stderr).toContain("unknown command 'dipsatch'");
    expect(r.stderr).toContain("rh dispatch");
  });
});
