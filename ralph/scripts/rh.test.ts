/**
 * rh — command router contract.
 *
 * These integration tests execute the public shell entrypoint. A fake board is
 * necessary because the board CLI is external to the router; its observable
 * argv, stdin, streams, exit status, and signal are the forwarding contract.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const RH = join(fileURLToPath(new URL(".", import.meta.url)), "rh");
const INSTALL_RH = join(fileURLToPath(new URL(".", import.meta.url)), "install-rh.sh");
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
let tmp: string;
let boardLog: string;
let herdrLog: string;
let scriptLog: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "rh-test-"));
  writeFileSync(
    join(tmp, "pty-run.exp"),
    "set timeout -1\nspawn -noecho {*}$argv\nexpect eof\nset result [wait]\nexit [lindex $result 3]\n",
  );
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

type InstallEnv = Record<string, string> & {
  HOME: string;
  XDG_BIN_HOME: string;
  RALPH_INSTALLED_PLUGINS_FILE: string;
  PATH: string;
};

function installEnv(): InstallEnv {
  const home = join(tmp, "install-home");
  const plugin = join(tmp, "registered-ralph");
  const registry = join(tmp, "registry", "installed_plugins.json");
  mkdirSync(join(plugin, "scripts"), { recursive: true });
  mkdirSync(join(tmp, "registry"), { recursive: true });
  writeFileSync(join(plugin, "scripts", "rh"), "#!/usr/bin/env bash\nprintf 'rh registered\\n'\n");
  chmodSync(join(plugin, "scripts", "rh"), 0o755);
  writeFileSync(
    registry,
    JSON.stringify({
      plugins: {
        "ralph@local": [{ version: "99.0.0", installPath: plugin }],
      },
    }),
  );
  return {
    HOME: home,
    XDG_BIN_HOME: join(tmp, "bin"),
    RALPH_INSTALLED_PLUGINS_FILE: registry,
    PATH: process.env.PATH ?? "",
  };
}

function runInstall(argv: string[], env: InstallEnv, timeout = 10_000) {
  const result = spawnSync("/bin/bash", [INSTALL_RH, ...argv], {
    cwd: tmp,
    encoding: "utf8",
    env,
    timeout,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    errorCode: (result.error as NodeJS.ErrnoException | undefined)?.code,
  };
}

function runRh(
  argv: string[],
  opts: {
    RALPH_BOARD?: string;
    NO_COLOR?: string;
    LC_ALL?: string;
    HERDR_BIN_PATH?: string;
    RALPH_HERDR_SCRIPTS_DIR?: string;
    RALPH_HOME?: string;
    RALPH_RH_SERVER_ATTEMPTS?: string;
    RALPH_RH_SERVER_POLL_SEC?: string;
    HERDR_ENV?: string;
    PATH?: string;
    cwd?: string;
    stdin?: string;
    tty?: boolean;
  } = {},
): { status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string } {
  const env = {
    PATH: opts.PATH ?? process.env.PATH ?? "",
    ...(opts.RALPH_BOARD ? { RALPH_BOARD: opts.RALPH_BOARD } : {}),
    ...(opts.NO_COLOR !== undefined ? { NO_COLOR: opts.NO_COLOR } : {}),
    ...(opts.LC_ALL !== undefined ? { LC_ALL: opts.LC_ALL } : {}),
    ...(opts.HERDR_BIN_PATH ? { HERDR_BIN_PATH: opts.HERDR_BIN_PATH } : {}),
    ...(opts.RALPH_HERDR_SCRIPTS_DIR ? { RALPH_HERDR_SCRIPTS_DIR: opts.RALPH_HERDR_SCRIPTS_DIR } : {}),
    ...(opts.RALPH_HOME ? { RALPH_HOME: opts.RALPH_HOME } : {}),
    ...(opts.RALPH_RH_SERVER_ATTEMPTS ? { RALPH_RH_SERVER_ATTEMPTS: opts.RALPH_RH_SERVER_ATTEMPTS } : {}),
    ...(opts.RALPH_RH_SERVER_POLL_SEC ? { RALPH_RH_SERVER_POLL_SEC: opts.RALPH_RH_SERVER_POLL_SEC } : {}),
    ...(opts.HERDR_ENV !== undefined ? { HERDR_ENV: opts.HERDR_ENV } : {}),
  };
  const command = ["/bin/bash", RH, ...argv];
  // BSD script needs its own parent TTY; expect supplies one on macOS.
  // util-linux script provides the equivalent status-preserving PTY in CI/WSL.
  const ptyCommand = process.platform === "darwin" ? "/usr/bin/expect" : "script";
  const ptyArgs = process.platform === "darwin"
    ? [join(tmp, "pty-run.exp"), ...command]
    : ["-q", "-e", "-c", command.map((arg) => `'${arg.replaceAll("'", `'\"'\"'`)}'`).join(" "), "/dev/null"];
  const result = spawnSync(opts.tty ? ptyCommand : command[0], opts.tty ? ptyArgs : command.slice(1), {
    cwd: opts.cwd ?? tmp,
    encoding: "utf8",
    input: opts.stdin,
    env,
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

type SurfaceEnv = {
  NO_COLOR?: string;
  LC_ALL?: string;
  herdrStatus?: string;
  server?: "down" | "running";
  dispatchRc?: number;
  reconcileRc?: number;
  resumeRc?: number;
  cockpitRc?: number;
  inboxRc?: number;
  teamRc?: Record<string, number>;
  idempotentTeams?: boolean;
  isolatedLog?: string;
  PATH?: string;
  HERDR_ENV?: string;
  interactive?: boolean;
  attachRc?: number;
};

function fixtureEnv(env: SurfaceEnv = {}) {
  return env;
}

function runSurface(
  argv: string[],
  env: SurfaceEnv = fixtureEnv(),
): { status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string } {
  const fixture = env.isolatedLog ?? "default";
  boardLog = join(tmp, `board-${fixture}.log`);
  herdrLog = join(tmp, `herdr-${fixture}.log`);
  scriptLog = join(tmp, `scripts-${fixture}.log`);
  const serverState = join(tmp, `server-state-${fixture}`);
  const teamState = join(tmp, `team-state-${fixture}`);
  const scripts = join(tmp, `herdr-scripts-${fixture}`);
  const repo = join(tmp, `repo-${fixture}`);
  mkdirSync(scripts, { recursive: true });
  mkdirSync(repo, { recursive: true });
  writeFileSync(
    join(tmp, "fake-board"),
    `#!/bin/bash
printf '%s\\n' "$*" >>"${boardLog}"
case "$*" in
  brief) echo 'BOARD BRIEF' ;;
  inbox*) echo 'BOARD INBOX'; exit ${env.inboxRc ?? 0} ;;
  'who dispatch'*) echo 'DISPATCH ADDRESS' ;;
  roster*) echo 'ROSTER' ;;
  doctor) echo 'BOARD DOCTOR' ;;
esac
`,
  );
  chmodSync(join(tmp, "fake-board"), 0o755);
  if (!existsSync(serverState)) {
    writeFileSync(serverState, env.herdrStatus !== undefined ? "custom" : (env.server ?? "running"));
  }
  writeFileSync(
    join(tmp, "fake-herdr"),
    `#!/bin/bash
case "$*" in
  '')
    printf '%s\\n' attach >>"${herdrLog}"
    printf 'HERDR ATTACHED\\n'
    exit ${env.attachRc ?? 0}
    ;;
  'status server --json')
    if [ "$(cat "${serverState}")" = down ]; then sleep 0.05; fi
    printf '%s\\n' "$*" >>"${herdrLog}"
    if [ "$(cat "${serverState}")" = custom ]; then
      printf '%s\\n' '${env.herdrStatus ?? '{"status":"running"}'}'
    elif [ "$(cat "${serverState}")" = running ]; then
      printf '%s\\n' '{"status":"running"}'
    else
      exit 1
    fi
    ;;
  server)
    printf '%s\\n' "$*" >>"${herdrLog}"
    printf running >"${serverState}"
    ;;
esac
`,
  );
  chmodSync(join(tmp, "fake-herdr"), 0o755);
  writeFileSync(join(scripts, "dispatch-up.sh"), `#!/bin/bash
printf 'dispatch-up%s\\n' "\${*:+ $*}" >>"${scriptLog}"
exit ${env.dispatchRc ?? 0}
`);
  writeFileSync(join(scripts, "reconcile.sh"), `#!/bin/bash
printf '%s\\n' reconcile >>"${scriptLog}"
exit ${env.reconcileRc ?? 0}
`);
  writeFileSync(join(scripts, "resume-teams.sh"), `#!/bin/bash
printf '%s\\n' resume-teams >>"${scriptLog}"
exit ${env.resumeRc ?? 0}
`);
  writeFileSync(join(scripts, "cockpit-open.sh"), `#!/bin/bash
printf 'cockpit-open%s\\n' "\${*:+ $*}" >>"${scriptLog}"
exit ${env.cockpitRc ?? 0}
`);
  writeFileSync(join(scripts, "work-team.sh"), `#!/bin/bash
${env.idempotentTeams ? `grep -Fxq "$1" "${teamState}" 2>/dev/null && exit 0
printf '%s\\n' "$1" >>"${teamState}"
` : ""}printf 'work-team %s\\n' "$*" >>"${scriptLog}"
case "$1" in
${Object.entries(env.teamRc ?? {}).map(([epic, rc]) => `  ${epic}) exit ${rc} ;;`).join("\n")}
esac
`);
  writeFileSync(join(scripts, "fleet-status.sh"), `#!/bin/bash
printf '%s\\n' "fleet-status $*" >>"${herdrLog}"
echo 'FLEET STATUS'
`);
  chmodSync(join(scripts, "dispatch-up.sh"), 0o755);
  chmodSync(join(scripts, "reconcile.sh"), 0o755);
  chmodSync(join(scripts, "resume-teams.sh"), 0o755);
  chmodSync(join(scripts, "cockpit-open.sh"), 0o755);
  chmodSync(join(scripts, "work-team.sh"), 0o755);
  chmodSync(join(scripts, "fleet-status.sh"), 0o755);
  // A real Git root exercises the same repository gate as the public command.
  spawnSync("git", ["init", "-q", repo], { encoding: "utf8" });
  const result = runRh(argv, {
    RALPH_BOARD: join(tmp, "fake-board"),
    HERDR_BIN_PATH: join(tmp, "fake-herdr"),
    RALPH_HERDR_SCRIPTS_DIR: scripts,
    RALPH_HOME: join(tmp, "ralph-home"),
    RALPH_RH_SERVER_ATTEMPTS: "3",
    RALPH_RH_SERVER_POLL_SEC: "0",
    HERDR_ENV: env.HERDR_ENV,
    tty: env.interactive,
    cwd: repo,
    ...env,
  });
  return result;
}

function logFor(fixture: string): string {
  return join(tmp, `scripts-${fixture}.log`);
}

describe("rh", () => {
  it("installs an executable shim into XDG_BIN_HOME and resolves the registered Ralph plugin at call time", () => {
    // Break caught: skipping the registry resolver leaves an installed shim unable to find Ralph.
    const env = installEnv();
    expect(runInstall([], env).status).toBe(0);
    const shim = join(env.XDG_BIN_HOME, "rh");
    expect(statSync(shim).mode & 0o111).not.toBe(0);
    expect(readFileSync(shim, "utf8")).toContain("# ralph-hero-rh-shim:v1");
    const r = spawnSync(shim, ["version"], { cwd: tmp, encoding: "utf8", env });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^rh /);
  });

  it.each(["registry", "cache"] as const)("selects the newest executable %s candidate when sort rejects GNU -V", (source) => {
    // Break caught: relying on GNU sort -V makes valid installed Ralph copies unresolvable on macOS.
    const env = installEnv();
    const sortBin = join(tmp, "bsd-sort-bin");
    mkdirSync(sortBin, { recursive: true });
    writeFileSync(
      join(sortBin, "sort"),
      "#!/bin/sh\nfor arg in \"$@\"; do\n  [ \"$arg\" = -V ] && { echo 'sort: illegal option -- V' >&2; exit 2; }\ndone\nexec /usr/bin/sort \"$@\"\n",
    );
    chmodSync(join(sortBin, "sort"), 0o755);
    env.PATH = `${sortBin}:${env.PATH}`;

    const older = join(tmp, `${source}-older`);
    const newer = join(tmp, `${source}-newer`);
    for (const [root, label] of [[older, "older"], [newer, "newer"]]) {
      mkdirSync(join(root, "scripts"), { recursive: true });
      writeFileSync(join(root, "scripts", "rh"), `#!/usr/bin/env bash\nprintf 'rh ${label}\\n'\n`);
      chmodSync(join(root, "scripts", "rh"), 0o755);
    }

    if (source === "registry") {
      writeFileSync(
        env.RALPH_INSTALLED_PLUGINS_FILE,
        JSON.stringify({
          plugins: {
            "ralph@local": [
              { version: "1.2.0", installPath: older },
              { version: "1.10.0", installPath: newer },
            ],
          },
        }),
      );
    } else {
      const config = join(tmp, "claude-config");
      for (const [version, entrypoint] of [["1.2.0", older], ["1.10.0", newer]]) {
        const destination = join(config, "plugins", "cache", "marketplace", "ralph", version, "scripts");
        mkdirSync(destination, { recursive: true });
        writeFileSync(join(destination, "rh"), readFileSync(join(entrypoint, "scripts", "rh")));
        chmodSync(join(destination, "rh"), 0o755);
      }
      env.CLAUDE_CONFIG_DIR = config;
      env.RALPH_INSTALLED_PLUGINS_FILE = join(tmp, "missing-registry.json");
    }

    expect(runInstall([], env).status).toBe(0);
    const shim = join(env.XDG_BIN_HOME, "rh");
    const r = spawnSync(shim, ["version"], { cwd: tmp, encoding: "utf8", env });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("rh newer\n");
    expect(readFileSync(shim, "utf8")).not.toContain(REPO_ROOT);
    expect(readFileSync(shim, "utf8")).not.toContain(env.HOME);
  });

  it("updates a recognized shim idempotently", () => {
    // Break caught: each upgrade appends another marker or cannot replace its own shim.
    const env = installEnv();
    expect(runInstall([], env).status).toBe(0);
    expect(runInstall([], env).status).toBe(0);
    expect(readFileSync(join(env.XDG_BIN_HOME, "rh"), "utf8").match(/ralph-hero-rh-shim:v1/g)).toHaveLength(1);
  });

  it("refuses to replace a foreign rh executable", () => {
    // Break caught: installation overwrites an unrelated command named rh.
    const env = installEnv();
    mkdirSync(env.XDG_BIN_HOME, { recursive: true });
    writeFileSync(join(env.XDG_BIN_HOME, "rh"), "#!/bin/sh\necho foreign\n", { mode: 0o755 });
    const r = runInstall([], env);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("refusing to replace unrelated executable");
    expect(readFileSync(join(env.XDG_BIN_HOME, "rh"), "utf8")).toContain("echo foreign");
  });

  it.each(["dangling", "live"] as const)("refuses a %s symlink target without replacing it", (kind) => {
    // Break caught: -e follows live links and is false for dangling links, so
    // either kind can be mistaken for an installer-owned regular file.
    const env = installEnv();
    mkdirSync(env.XDG_BIN_HOME, { recursive: true });
    const target = join(env.XDG_BIN_HOME, "rh");
    const referent = join(tmp, `${kind}-referent`);
    if (kind === "live") {
      writeFileSync(referent, "#!/bin/bash\n# ralph-hero-rh-shim:v1\nprintf 'owned referent\\n'\n");
    }
    symlinkSync(referent, target);
    const referentBefore = kind === "live" ? readFileSync(referent, "utf8") : undefined;

    const r = runInstall([], env);

    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("refusing to replace unrelated executable");
    expect(lstatSync(target).isSymbolicLink()).toBe(true);
    expect(readlinkSync(target)).toBe(referent);
    expect(kind === "live" ? readFileSync(referent, "utf8") : existsSync(referent)).toBe(
      kind === "live" ? referentBefore : false,
    );
  });

  it("refuses a FIFO target without blocking or changing it", () => {
    // Break caught: inspecting a FIFO with grep waits for a writer, hanging the
    // installer instead of refusing the foreign filesystem object.
    const env = installEnv();
    mkdirSync(env.XDG_BIN_HOME, { recursive: true });
    const target = join(env.XDG_BIN_HOME, "rh");
    expect(spawnSync("mkfifo", [target]).status).toBe(0);

    const r = runInstall([], env, 1_000);

    expect(r.errorCode).toBeUndefined();
    expect(r.status).not.toBeNull();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("refusing to replace unrelated executable");
    expect(statSync(target).isFIFO()).toBe(true);
  });

  it("contains no source-checkout or user-specific absolute path", () => {
    // Break caught: the generated shim is pinned to the checkout that installed it.
    const env = installEnv();
    expect(runInstall([], env).status).toBe(0);
    const shim = readFileSync(join(env.XDG_BIN_HOME, "rh"), "utf8");
    expect(shim).not.toContain(REPO_ROOT);
    expect(shim).not.toContain(env.HOME);
  });

  it("uses an explicit executable development entrypoint", () => {
    // Break caught: an explicit development override is ignored in favor of an installed copy.
    const env = installEnv();
    env.RALPH_RH_ENTRYPOINT = executable("#!/usr/bin/env bash\nprintf 'rh development\\n'\n");
    expect(runInstall([], env).status).toBe(0);
    const r = spawnSync(join(env.XDG_BIN_HOME, "rh"), ["version"], { cwd: tmp, encoding: "utf8", env });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("rh development\n");
  });

  it("refuses a broken explicit development entrypoint", () => {
    // Break caught: a typo in an override silently runs a different Ralph copy.
    const env = installEnv();
    env.RALPH_RH_ENTRYPOINT = join(tmp, "missing-rh");
    expect(runInstall([], env).status).toBe(0);
    const r = spawnSync(join(env.XDG_BIN_HOME, "rh"), ["version"], { cwd: tmp, encoding: "utf8", env });
    expect(r.status).toBe(69);
    expect(r.stderr).toContain("RALPH_RH_ENTRYPOINT is not executable");
  });

  it("uses the current checkout before an installed plugin", () => {
    // Break caught: working in this checkout unexpectedly runs a separately installed release.
    const env = installEnv();
    expect(runInstall([], env).status).toBe(0);
    const r = spawnSync(join(env.XDG_BIN_HOME, "rh"), ["version"], { cwd: REPO_ROOT, encoding: "utf8", env });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^rh /);
    expect(r.stdout).not.toBe("rh registered\n");
  });

  it("labels the newest cache fallback as a guess", () => {
    // Break caught: an unregistered cache copy is used silently or without choosing the newest version.
    const env = installEnv();
    const config = join(tmp, "claude-config");
    const cached = join(config, "plugins", "cache", "marketplace", "ralph", "12.0.0", "scripts");
    mkdirSync(cached, { recursive: true });
    writeFileSync(join(cached, "rh"), "#!/usr/bin/env bash\nprintf 'rh cached\\n'\n");
    chmodSync(join(cached, "rh"), 0o755);
    env.CLAUDE_CONFIG_DIR = config;
    env.RALPH_INSTALLED_PLUGINS_FILE = join(tmp, "missing-registry.json");
    expect(runInstall([], env).status).toBe(0);
    const r = spawnSync(join(env.XDG_BIN_HOME, "rh"), ["version"], { cwd: tmp, encoding: "utf8", env });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("rh cached\n");
    expect(r.stderr).toContain("a guess, not a record");
  });

  it("fails with a setup remedy when no Ralph entrypoint can be resolved", () => {
    // Break caught: a fresh machine reports success while the shim has no runnable Ralph command.
    const env = installEnv();
    env.CLAUDE_CONFIG_DIR = join(tmp, "empty-config");
    env.RALPH_INSTALLED_PLUGINS_FILE = join(tmp, "missing-registry.json");
    expect(runInstall([], env).status).toBe(0);
    const r = spawnSync(join(env.XDG_BIN_HOME, "rh"), ["version"], { cwd: tmp, encoding: "utf8", env });
    expect(r.status).toBe(69);
    expect(r.stderr).toContain("install the ralph Claude Code plugin");
  });

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
    const dayHelp = runRh(["help", "day"], { cwd: tmp });
    expect(dayHelp.status).toBe(0);
    expect(dayHelp.stdout).toContain("--no-attach");
    expect(dayHelp.stdout).toContain("interactive terminal");
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

  it("dispatch up starts a missing server and invokes only dispatch-up once", () => {
    const r = runSurface(["dispatch", "up"], fixtureEnv({ server: "down" }));
    expect(r.status).toBe(0);
    expect(readLines(herdrLog)).toEqual([
      "status server --json",
      "server",
      "status server --json",
      "status server --json",
    ]);
    expect(readLines(scriptLog)).toEqual(["dispatch-up"]);
  });

  it("dispatch up reuses a healthy server", () => {
    const r = runSurface(["dispatch", "up"], fixtureEnv({ server: "running" }));
    expect(r.status).toBe(0);
    expect(readLines(herdrLog).filter((l) => l === "server")).toHaveLength(0);
    expect(readLines(scriptLog)).toEqual(["dispatch-up"]);
  });

  it.each([
    ["an empty successful response", ""],
    ["malformed JSON", "not json"],
    ["an empty object", "{}"],
    ["an explicit stopped state", '{"status":"stopped"}'],
  ])("dispatch up does not treat %s as server readiness", (_description, herdrStatus) => {
    // Break caught: exit-zero status transport without a running payload skips
    // server startup and lets dispatch claim readiness from malformed state.
    const r = runSurface(["dispatch", "up"], fixtureEnv({ herdrStatus }));
    expect(r.status).toBe(0);
    expect(readLines(herdrLog).filter((line) => line === "server")).toHaveLength(1);
    expect(readLines(scriptLog)).toEqual(["dispatch-up"]);
  });

  it("cockpit refuses a down server without starting it", () => {
    const r = runSurface(["cockpit"], fixtureEnv({ server: "down" }));
    expect(r.status).not.toBe(0);
    expect(readLines(herdrLog)).not.toContain("server");
    expect(readLines(scriptLog)).not.toContain("cockpit-open");
  });

  it("team is explicit and ensures dispatch before exactly one epic", () => {
    const r = runSurface(["team", "2208"], fixtureEnv({ server: "running" }));
    expect(r.status).toBe(0);
    expect(readLines(scriptLog)).toEqual(["dispatch-up", "work-team 2208"]);
  });

  it("binds the one resolved board executable into every installed-host Herdr script", () => {
    // Break caught: a host repository without ralph/scripts/board lets Herdr
    // delegates resolve a different board (or no board) than rh preflight did.
    const repo = join(tmp, "installed-host");
    const scripts = join(tmp, "installed-herdr-scripts");
    const calls = join(tmp, "installed-herdr-calls.log");
    const board = join(tmp, "resolved-board");
    const herdr = join(tmp, "resolved-herdr");
    mkdirSync(repo, { recursive: true });
    mkdirSync(scripts, { recursive: true });
    spawnSync("git", ["init", "-q", repo], { encoding: "utf8" });

    writeFileSync(board, "#!/bin/bash\n[ \"${1-}\" = inbox ] && printf 'BOARD INBOX\\n'\n");
    chmodSync(board, 0o755);
    writeFileSync(
      herdr,
      "#!/bin/bash\n[ \"$*\" = 'status server --json' ] && printf '{\"status\":\"running\"}\\n'\n",
    );
    chmodSync(herdr, 0o755);

    for (const script of [
      "dispatch-up.sh",
      "reconcile.sh",
      "resume-teams.sh",
      "work-team.sh",
      "cockpit-open.sh",
      "fleet-status.sh",
    ]) {
      writeFileSync(
        join(scripts, script),
        `#!/bin/bash\nprintf '%s\\t%s\\n' '${script}' "\${RALPH_HERDR_BOARD-}" >>"${calls}"\n`,
      );
      chmodSync(join(scripts, script), 0o755);
    }

    expect(existsSync(join(repo, "ralph", "scripts", "board"))).toBe(false);
    const opts = {
      RALPH_BOARD: board,
      HERDR_BIN_PATH: herdr,
      RALPH_HERDR_SCRIPTS_DIR: scripts,
      cwd: repo,
    };
    expect(runRh(["day", "--team", "2208"], opts).status).toBe(0);
    expect(runRh(["fleet"], opts).status).toBe(0);
    expect(readLines(calls)).toEqual([
      `dispatch-up.sh\t${board}`,
      `reconcile.sh\t${board}`,
      `resume-teams.sh\t${board}`,
      `work-team.sh\t${board}`,
      `cockpit-open.sh\t${board}`,
      `fleet-status.sh\t${board}`,
    ]);
  });

  it("team refuses a non-positive or non-numeric epic before dispatch", () => {
    for (const epic of ["0", "-1", "extra"]) {
      const r = runSurface(["team", epic]);
      expect(r.status).toBe(64);
      expect(readLines(scriptLog)).toEqual([]);
    }
    const r = runSurface(["team", "2208", "extra"]);
    expect(r.status).toBe(64);
    expect(readLines(scriptLog)).toEqual([]);
  });

  it("naked day never invokes work-team when no durable team exists", () => {
    const r = runSurface(["day"], fixtureEnv({ server: "running" }));
    expect(r.status).toBe(0);
    expect(readLines(scriptLog)).toEqual([
      "dispatch-up",
      "reconcile",
      "resume-teams",
      "cockpit-open",
    ]);
    expect(readLines(scriptLog).some((line) => line.startsWith("work-team "))).toBe(false);
    expect(readLines(herdrLog)).not.toContain("attach");
  });

  it("interactive day enters the full Herdr UI on dispatch after the inbox", () => {
    // Break caught: an interactive shell prepares detached panes and returns
    // to its prompt instead of entering the repo's attended dispatch seat.
    const r = runSurface(["day"], fixtureEnv({ interactive: true, isolatedLog: "interactive-outside" }));
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(readLines(scriptLog)).toEqual([
      "dispatch-up --focus",
      "reconcile",
      "resume-teams",
      "cockpit-open --no-focus",
    ]);
    expect(readLines(herdrLog).at(-1)).toBe("attach");
    expect(r.stdout.indexOf("inbox")).toBeGreaterThanOrEqual(0);
    expect(r.stdout.indexOf("HERDR ATTACHED")).toBeGreaterThan(r.stdout.indexOf("inbox"));
  });

  it("interactive day inside Herdr focuses dispatch without nesting a client", () => {
    // Break caught: invoking day from a managed pane nests a second Herdr TUI
    // instead of switching the existing client to the dispatch seat.
    const r = runSurface(
      ["day"],
      fixtureEnv({ interactive: true, HERDR_ENV: "1", isolatedLog: "interactive-inside" }),
    );
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(readLines(scriptLog)).toEqual([
      "dispatch-up --focus",
      "reconcile",
      "resume-teams",
      "cockpit-open --no-focus",
    ]);
    expect(readLines(herdrLog)).not.toContain("attach");
  });

  it("day --no-attach preserves the background-only path in an interactive shell", () => {
    // Break caught: the explicit escape hatch still changes focus or takes
    // over the calling terminal.
    const r = runSurface(
      ["day", "--no-attach"],
      fixtureEnv({ interactive: true, isolatedLog: "interactive-no-attach" }),
    );
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(readLines(scriptLog)).toEqual([
      "dispatch-up",
      "reconcile",
      "resume-teams",
      "cockpit-open",
    ]);
    expect(readLines(herdrLog)).not.toContain("attach");
  });

  it("interactive day reports an attach failure after completing preparation", () => {
    const r = runSurface(
      ["day"],
      fixtureEnv({ interactive: true, attachRc: 7, isolatedLog: "interactive-attach-failure" }),
    );
    expect(r.status).toBe(1);
    expect(readLines(herdrLog).at(-1)).toBe("attach");
    expect(r.stdout).toContain("herdr");
    expect(r.stdout).toContain("failed");
  });

  it("repeatable team flags are validated and deduplicated before mutation", () => {
    const r = runSurface(["day", "--team", "2208", "--team", "2208", "--team", "2176"]);
    expect(r.status).toBe(0);
    expect(readLines(scriptLog).filter((line) => line.startsWith("work-team "))).toEqual([
      "work-team 2208",
      "work-team 2176",
    ]);
  });

  it.each([
    [["day", "--team"], "--team needs an epic number"],
    [["day", "--team", "not-an-epic"], "invalid epic 'not-an-epic'"],
    [["day", "--team", "0"], "invalid epic '0'"],
    [["day", "--team", "000"], "invalid epic '000'"],
    [["day", "--unknown"], "unknown argument '--unknown'"],
  ])("%j rejects every invalid day argument before mutation", (args, message) => {
    const r = runSurface(args);
    expect(r.status).toBe(64);
    expect(r.stderr).toContain(message);
    expect(readLines(scriptLog)).toEqual([]);
    expect(readLines(boardLog)).toEqual([]);
    expect(readLines(herdrLog)).toEqual([]);
  });

  it("dispatch failure prevents every dependent phase", () => {
    const r = runSurface(["day"], fixtureEnv({ dispatchRc: 1 }));
    expect(r.status).not.toBe(0);
    expect(readLines(scriptLog)).toEqual(["dispatch-up"]);
    expect(r.stdout).toContain("dispatch");
    expect(r.stdout).toContain("failed");
  });

  it("resume ambiguity continues to cockpit and inbox but returns nonzero", () => {
    const r = runSurface(["day"], fixtureEnv({ resumeRc: 1 }));
    expect(r.status).not.toBe(0);
    expect(readLines(scriptLog)).toContain("cockpit-open");
    expect(readLines(boardLog)).toContain("inbox");
    expect(r.stdout).toContain("teams");
    expect(r.stdout).toContain("attention");
  });

  it("an explicit-team failure leaves later independent phases visible and aggregates nonzero", () => {
    const r = runSurface(
      ["day", "--team", "2208", "--team", "2176"],
      fixtureEnv({ teamRc: { "2208": 1 } }),
    );
    expect(r.status).not.toBe(0);
    expect(readLines(scriptLog)).toEqual([
      "dispatch-up",
      "reconcile",
      "resume-teams",
      "work-team 2208",
      "work-team 2176",
      "cockpit-open",
    ]);
    expect(readLines(boardLog)).toContain("inbox");
    expect(r.stdout).toContain("team GH-2208");
    expect(r.stdout).toContain("failed");
    expect(r.stdout).toContain("team GH-2176");
    expect(r.stdout).toContain("started");
  });

  it.each([
    {
      description: "reconcile failure continues through cockpit and inbox",
      args: ["day"],
      env: { reconcileRc: 7 },
      status: 1,
      phase: "reconcile",
      state: "failed",
      scripts: ["dispatch-up", "reconcile", "resume-teams", "cockpit-open"],
    },
    {
      description: "cockpit failure still renders inbox",
      args: ["day"],
      env: { cockpitRc: 8 },
      status: 1,
      phase: "cockpit",
      state: "failed",
      scripts: ["dispatch-up", "reconcile", "resume-teams", "cockpit-open"],
    },
    {
      description: "inbox failure aggregates attention",
      args: ["day"],
      env: { inboxRc: 9 },
      status: 1,
      phase: "inbox",
      state: "attention",
      scripts: ["dispatch-up", "reconcile", "resume-teams", "cockpit-open"],
    },
    {
      description: "explicit team rc 4 is clean completion",
      args: ["day", "--team", "2208"],
      env: { teamRc: { "2208": 4 } },
      status: 0,
      phase: "team GH-2208",
      state: "skipped",
      scripts: ["dispatch-up", "reconcile", "resume-teams", "work-team 2208", "cockpit-open"],
    },
  ])("day: $description", ({ args, env, status, phase, state, scripts }) => {
    // Break caught: partial-failure aggregation either aborts independent
    // recovery phases or loses a nonzero/clean-complete result in the summary.
    const r = runSurface(args, fixtureEnv(env));
    expect(r.status).toBe(status);
    expect(readLines(scriptLog)).toEqual(scripts);
    expect(readLines(boardLog)).toContain("inbox");
    expect(r.stdout).toContain(phase);
    expect(r.stdout).toContain(state);
  });

  it("dispatch day and day invoke the same ordered phases", () => {
    const direct = runSurface(["day"], fixtureEnv({ isolatedLog: "direct" }));
    const nested = runSurface(["dispatch", "day"], fixtureEnv({ isolatedLog: "nested" }));
    expect(direct.status).toBe(0);
    expect(direct.status).toBe(nested.status);
    const directPhases = readLines(logFor("direct"));
    expect(directPhases).toEqual(["dispatch-up", "reconcile", "resume-teams", "cockpit-open"]);
    expect(directPhases).toEqual(readLines(logFor("nested")));
  });

  it("rerunning day reuses the server and does not duplicate an idempotent explicit team start", () => {
    const env = fixtureEnv({ isolatedLog: "rerun", server: "down", idempotentTeams: true });
    expect(runSurface(["day", "--team", "2208"], env).status).toBe(0);
    expect(runSurface(["day", "--team", "2208"], env).status).toBe(0);
    expect(readLines(join(tmp, "herdr-rerun.log")).filter((line) => line === "server")).toHaveLength(1);
    expect(readLines(logFor("rerun")).filter((line) => line === "work-team 2208")).toHaveLength(1);
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

  it.each([
    ["malformed JSON", "not json"],
    ["an empty object", "{}"],
    ["an explicit stopped state", '{"status":"stopped"}'],
    ["an empty successful response", ""],
  ])("dispatch renders %s as not evaluated", (_description, herdrStatus) => {
    const r = runSurface(["dispatch"], { LC_ALL: "C", NO_COLOR: "1", herdrStatus });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("FAIL herdr        not evaluated    server status unavailable");
    expect(r.stdout).not.toContain("herdr        running");
  });

  it("renders visible read-only attention when jq is unavailable on PATH", () => {
    // Break caught: a missing parser must not turn an unknown Herdr response
    // into healthy status, usage success, or a mutation attempt.
    const isolatedPath = join(tmp, "path-without-jq");
    mkdirSync(isolatedPath);
    symlinkSync("/usr/bin/dirname", join(isolatedPath, "dirname"));
    symlinkSync("/usr/bin/git", join(isolatedPath, "git"));
    const r = runSurface(["dispatch"], {
      PATH: isolatedPath,
      LC_ALL: "C",
      NO_COLOR: "1",
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("FAIL herdr        not evaluated    server status unavailable");
    expect(readLines(boardLog)).toEqual(["who dispatch", "roster"]);
    expect(readLines(herdrLog).some((line) => /^(server|workspace|plugin pane|agent )/.test(line))).toBe(false);
    expect(readLines(scriptLog)).toEqual([]);
  });
});
