/**
 * rh — command router contract.
 *
 * These integration tests execute the public shell entrypoint. A fake board is
 * necessary because the board CLI is external to the router; its observable
 * argv, stdin, streams, exit status, and signal are the forwarding contract.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const RH = join(fileURLToPath(new URL(".", import.meta.url)), "rh");
let tmp: string;
let boardLog: string;
let herdrLog: string;

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
  opts: {
    RALPH_BOARD?: string;
    NO_COLOR?: string;
    LC_ALL?: string;
    HERDR_BIN_PATH?: string;
    RALPH_HERDR_SCRIPTS_DIR?: string;
    cwd?: string;
    stdin?: string;
  } = {},
): { status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string } {
  const result = spawnSync("/bin/bash", [RH, ...argv], {
    cwd: opts.cwd ?? tmp,
    encoding: "utf8",
    input: opts.stdin,
    env: {
      PATH: process.env.PATH ?? "",
      ...(opts.RALPH_BOARD ? { RALPH_BOARD: opts.RALPH_BOARD } : {}),
      ...(opts.NO_COLOR !== undefined ? { NO_COLOR: opts.NO_COLOR } : {}),
      ...(opts.LC_ALL !== undefined ? { LC_ALL: opts.LC_ALL } : {}),
      ...(opts.HERDR_BIN_PATH ? { HERDR_BIN_PATH: opts.HERDR_BIN_PATH } : {}),
      ...(opts.RALPH_HERDR_SCRIPTS_DIR ? { RALPH_HERDR_SCRIPTS_DIR: opts.RALPH_HERDR_SCRIPTS_DIR } : {}),
    },
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function readLines(path: string): string[] {
  try {
    return readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function runSurface(
  argv: string[],
  env: { NO_COLOR?: string; LC_ALL?: string } = {},
): { status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string } {
  boardLog = join(tmp, "board.log");
  herdrLog = join(tmp, "herdr.log");
  const scripts = join(tmp, "herdr-scripts");
  const repo = join(tmp, "repo");
  mkdirSync(scripts, { recursive: true });
  mkdirSync(repo, { recursive: true });
  writeFileSync(
    join(tmp, "fake-board"),
    `#!/bin/bash
printf '%s\\n' "$*" >>"${boardLog}"
case "$*" in
  brief) echo 'BOARD BRIEF' ;;
  inbox*) echo 'BOARD INBOX' ;;
  'who dispatch'*) echo 'DISPATCH ADDRESS' ;;
  roster*) echo 'ROSTER' ;;
  doctor) echo 'BOARD DOCTOR' ;;
esac
`,
  );
  chmodSync(join(tmp, "fake-board"), 0o755);
  writeFileSync(
    join(tmp, "fake-herdr"),
    `#!/bin/bash
printf '%s\\n' "$*" >>"${herdrLog}"
case "$*" in
  'status server --json') echo '{"status":"running"}' ;;
esac
`,
  );
  chmodSync(join(tmp, "fake-herdr"), 0o755);
  writeFileSync(join(tmp, "dispatch-up.sh"), "#!/bin/bash\n");
  writeFileSync(join(tmp, "fleet-status.sh"), `#!/bin/bash
printf '%s\\n' "fleet-status $*" >>"${herdrLog}"
echo 'FLEET STATUS'
`);
  chmodSync(join(tmp, "dispatch-up.sh"), 0o755);
  chmodSync(join(tmp, "fleet-status.sh"), 0o755);
  // A real Git root exercises the same repository gate as the public command.
  spawnSync("git", ["init", "-q", repo], { encoding: "utf8" });
  const result = runRh(argv, {
    RALPH_BOARD: join(tmp, "fake-board"),
    HERDR_BIN_PATH: join(tmp, "fake-herdr"),
    RALPH_HERDR_SCRIPTS_DIR: scripts,
    cwd: repo,
    ...env,
  });
  return result;
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

  it("uses non-empty NO_COLOR as the effective mode at a delegated command boundary", () => {
    const fake = executable("#!/bin/bash\nprintf '<%s>\\n' \"${RH_COLOR_MODE:-}\"\n");
    const r = runRh(["--color=always", "board", "list"], {
      RALPH_BOARD: fake,
      NO_COLOR: "1",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("<never>\n");
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

  it.each([[[]], [["dispatch"]], [["inbox"]], [["fleet"]], [["doctor"]]])(
    "%j never invokes a mutating board verb or Herdr action",
    (args: string[] = []) => {
      const r = runSurface(args);
      expect(r.status).not.toBe(64);
      expect(readLines(boardLog).every((line) => /^(brief|inbox|who dispatch|roster|doctor)/.test(line))).toBe(true);
      expect(readLines(herdrLog).some((line) => /^(server|workspace|plugin pane|agent start|agent prompt)/.test(line))).toBe(false);
    },
  );

  it("inbox accepts read flags and refuses the local digest mutation", () => {
    expect(runSurface(["inbox", "--json"]).status).toBe(0);
    const r = runSurface(["inbox", "--digest", "--mark"]);
    expect(r.status).toBe(64);
    expect(r.stderr).toContain("use 'rh board inbox --digest --mark'");
  });

  it("NO_COLOR wins over --color=always", () => {
    const r = runSurface(["--color=always"], { NO_COLOR: "1" });
    expect(r.stdout).not.toContain("\u001b[");
  });

  it("--color=always adds restrained ANSI only to rh-owned rows", () => {
    const r = runSurface(["--color=always"]);
    expect(r.stdout).toContain("\u001b[");
    expect(r.stdout).toContain("herdr");
  });

  it("a C locale uses the ASCII state vocabulary", () => {
    const r = runSurface([], { LC_ALL: "C", NO_COLOR: "1" });
    expect(r.stdout).toMatch(/\b(OK|WARN|FAIL)\b/);
  });
});
