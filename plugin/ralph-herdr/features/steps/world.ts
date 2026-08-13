// world.ts — the per-scenario replay world for the ralph-herdr BDD layer.
//
// One temp directory per scenario, torn down in the After hook, holding the
// EXACT harness the *.test.sh suites use (watcher/fleet/substrate — read
// them first, change them together):
//
//   bin/herdr    wrapper over tests/fake-herdr.sh (fixtures + invocation log),
//                plus whatever chaos a scenario injects ahead of it. It used
//                to hand-roll `agent get` — then unmodeled by the shim — as a
//                bare {result:{agent:{…}}} so notify-watch.sh would drain
//                instead of polling forever. That body is one the real server
//                cannot produce (protocol 19 requires an id and a
//                result.type), and the moment notify-watch.sh started reading
//                its polls through the transport adapter, the adapter refused
//                it — correctly (GH-1855). fake-herdr.sh models `agent get`
//                and `agent wait` now, envelope and all.
//   bin/board    wrapper over tests/fake-board.sh
//   bin/gh       the substrate.test.sh gh shim (logs into FAKE_BOARD_LOG)
//   repo/        a real git clone of a local origin (the spawn path fetches
//                origin/main before branching) carrying .ralph.json
//                {owner: acme, repo: demo} — so ralph_ledger_path resolves
//                the scoped ledger under this world's ledger root
//   ledger-root/ RALPH_HERDR_LEDGER_ROOT — no subprocess may ever fall back
//                to the real ~/.ralph
//
// Steps drive the REAL bash scripts (lib.sh spawn path, watch-event.sh,
// reconcile.sh, ralph-answer.sh, work-fleet.sh) and assert through the fake
// logs + the ledger JSONL. No server, no GitHub, no writes outside tmp.
import { After, setDefaultTimeout, setWorldConstructor, World } from '@cucumber/cucumber';
import { execFileSync, spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// Real bash + tsx invocations (board CLI validation, git plumbing) outrun
// cucumber's 5s default.
setDefaultTimeout(120_000);

const STEPS_DIR = path.dirname(fileURLToPath(import.meta.url));
/** plugin/ralph-herdr */
export const PLUGIN_DIR = path.resolve(STEPS_DIR, '..', '..');
export const SCRIPTS_DIR = path.join(PLUGIN_DIR, 'scripts');
export const TESTS_DIR = path.join(PLUGIN_DIR, 'tests');
/** repo root (ralph-hero checkout) */
export const REPO_ROOT = path.resolve(PLUGIN_DIR, '..', '..');
/** the REAL board CLI — contract validation is offline schema work */
export const REAL_BOARD = path.join(REPO_ROOT, 'ralph', 'scripts', 'board');

export interface RunResult {
  rc: number;
  stdout: string;
  stderr: string;
  /** stdout + stderr, in that order — most asserts don't care which stream */
  out: string;
}

export class RalphWorld extends World {
  tmp = '';
  bin = '';
  herdrFixtures = '';
  herdrLogFile = '';
  boardFixtures = '';
  boardLogFile = '';
  combinedLogFile = '';
  ledgerRoot = '';
  /** the scope every world repo resolves: acme/demo */
  scopedLedger = '';
  repoDir = '';
  originDir = '';
  wtDir = '';
  /** env overrides for the next run (e.g. a sick server's HERDR_BIN_PATH) */
  extraEnv: Record<string, string> = {};
  queueJson = '';
  seededLedger = '';
  last: RunResult = { rc: -1, stdout: '', stderr: '', out: '' };
  // spawn read-backs (lib.sh exports; echoed back by the step's driver)
  spawnRc = -1;
  spawnAgent = '';
  spawnRef = '';
  spawnPane = '';
  lastAnswerMsg = '';
  // live-session state (live.steps.ts)
  liveSession = '';
  livePane = '';
  liveTmp = '';
  liveLedgerRoot = '';

  /** Build the replay world — the "a replay world with a board-scoped repo" Given. */
  build(): void {
    this.tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-bdd-'));
    this.bin = path.join(this.tmp, 'bin');
    fs.mkdirSync(this.bin);
    this.herdrFixtures = mkdir(this.tmp, 'fixtures');
    this.boardFixtures = mkdir(this.tmp, 'board-fixtures');
    this.ledgerRoot = mkdir(this.tmp, 'ledger-root');
    this.wtDir = mkdir(this.tmp, 'wt');
    this.herdrLogFile = touch(this.tmp, 'herdr.log');
    this.boardLogFile = touch(this.tmp, 'board.log');
    this.combinedLogFile = touch(this.tmp, 'combined.log');
    this.scopedLedger = path.join(this.ledgerRoot, 'acme', 'demo', 'ledger.jsonl');

    this.installDefaultHerdrShim();
    // board + gh wrappers (not symlinks — the repo files' exec bits are never
    // load-bearing), exactly as the sh suites build them.
    writeExecutable(
      path.join(this.bin, 'board'),
      `#!/bin/bash\nexec bash "${path.join(TESTS_DIR, 'fake-board.sh')}" "$@"\n`,
    );
    writeExecutable(
      path.join(this.bin, 'gh'),
      [
        '#!/bin/bash',
        '# substrate.test.sh gh shim: logs into the board log (prefixed) and',
        '# answers the two surfaces ralph-answer.sh reads/writes.',
        'if [ -n "${FAKE_BOARD_LOG:-}" ]; then printf \'gh %s\\n\' "$*" >>"$FAKE_BOARD_LOG"; fi',
        'case "${1-} ${2-}" in',
        '  "issue view") printf \'question: which path should we take?\\n\' ;;',
        '  "issue comment") printf \'https://github.com/acme/demo/issues/%s#issuecomment-1\\n\' "${3-}" ;;',
        'esac',
        'exit 0',
        '',
      ].join('\n'),
    );

    // A real repo with a real (local) origin: the live spawn path fetches
    // origin/main before branching (fleet.test.sh parity).
    this.originDir = path.join(this.tmp, 'origin');
    this.repoDir = path.join(this.tmp, 'repo');
    git(['init', '-q', '-b', 'main', this.originDir]);
    git(['-C', this.originDir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']);
    git(['clone', '-q', this.originDir, this.repoDir]);
    fs.writeFileSync(
      path.join(this.repoDir, '.ralph.json'),
      '{"owner":"acme","repo":"demo","projectNumber":1}\n',
    );

    // Worktrees "open" on pane p31 inside this world's wt/ dir.
    this.writeHerdrFixture(
      'worktree-create.json',
      JSON.stringify({ result: { root_pane: { pane_id: 'p31' }, worktree: { path: this.wtDir } } }) + '\n',
    );
  }

  /** The default herdr wrapper: fake-herdr.sh, plus any injected chaos. */
  installDefaultHerdrShim(extraPrelude = ''): void {
    writeExecutable(
      path.join(this.bin, 'herdr'),
      [
        '#!/bin/bash',
        extraPrelude,
        `exec bash "${path.join(TESTS_DIR, 'fake-herdr.sh')}" "$@"`,
        '',
      ].join('\n'),
    );
  }

  /** Failure injection: every worktree verb refuses the given branch. */
  failWorktreesForBranch(branch: string): void {
    this.installDefaultHerdrShim(
      [
        `# injected chaos: worktree create AND open refuse branch ${branch}`,
        'if [ "${1-}" = worktree ]; then',
        `  case " $* " in *" --branch ${branch} "*)`,
        '    if [ -n "${FAKE_HERDR_LOG:-}" ]; then printf \'%s\\n\' "$*" >>"$FAKE_HERDR_LOG"; fi',
        '    printf \'{"error":{"code":"worktree_refused","message":"injected failure"}}\\n\'',
        '    exit 1 ;;',
        '  esac',
        'fi',
      ].join('\n'),
    );
  }

  env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
    const e: NodeJS.ProcessEnv = { ...process.env };
    // Scrub EVERY inherited RALPH_*/HERDR_* key (plus the API key the billing
    // guard must never see) before re-adding this world's own values. A kept
    // knob — an operator's exported RALPH_HERDR_DRY_RUN=true, _FLEET,
    // _JOIN_WAIT_SEC, ALLOW_API_BILLING — silently turns spawn scenarios into
    // no-ops, so the suite's verdict would depend on the host shell. Prefix
    // scrub, not a name list: knobs added later are isolated by default.
    for (const k of Object.keys(e)) {
      if (/^(RALPH_|HERDR_)/.test(k) || k === 'ANTHROPIC_API_KEY') delete e[k];
    }
    return {
      ...e,
      PATH: `${this.bin}:${process.env.PATH ?? ''}`,
      HERDR_BIN_PATH: path.join(this.bin, 'herdr'),
      FAKE_HERDR_FIXTURES: this.herdrFixtures,
      FAKE_HERDR_LOG: this.herdrLogFile,
      FAKE_BOARD_FIXTURES: this.boardFixtures,
      FAKE_BOARD_LOG: this.boardLogFile,
      RALPH_HERDR_LEDGER_ROOT: this.ledgerRoot,
      RALPH_HERDR_REPO: this.repoDir,
      RALPH_HERDR_BOARD: path.join(this.bin, 'board'),
      NO_COLOR: '1',
      ...this.extraEnv,
      ...overrides,
    };
  }

  /** Run a bash script fragment inside the world; captures rc + both streams. */
  run(script: string, opts: { env?: Record<string, string>; stdin?: string; cwd?: string } = {}): RunResult {
    const spawnOpts: SpawnSyncOptionsWithStringEncoding = {
      encoding: 'utf8',
      env: this.env(opts.env),
      cwd: opts.cwd ?? this.tmp,
      input: opts.stdin ?? '',
      timeout: 90_000,
      maxBuffer: 16 * 1024 * 1024,
    };
    const r = spawnSync('bash', ['-c', script], spawnOpts);
    if (r.error) throw r.error;
    this.last = {
      rc: r.status ?? -1,
      stdout: r.stdout ?? '',
      stderr: r.stderr ?? '',
      out: `${r.stdout ?? ''}${r.stderr ?? ''}`,
    };
    return this.last;
  }

  writeHerdrFixture(name: string, content: string): void {
    fs.writeFileSync(path.join(this.herdrFixtures, name), content);
  }

  /**
   * Describe the live herd (GH-1774).
   *
   * A scoped herd read resolves agent -> workspace -> worktree provenance and
   * ignores anything it cannot bind to this repository, so a two-field agent
   * list no longer describes a herd — it describes an empty one. This writes
   * the snapshot with the join already built, binding every agent to a
   * workspace whose worktree provenance points at this world's repo.
   *
   * The fake composes the protocol envelope (id + result.type), so only the
   * payload belongs here.
   */
  writeHerd(agents: Array<{ name: string | null; agent_status?: string; pane_id?: string }>): void {
    const full = agents.map((a, i) => ({
      name: a.name,
      agent_status: a.agent_status ?? 'unknown',
      pane_id: a.pane_id ?? `p${i}`,
      workspace_id: 'wR',
      tab_id: 'wR:t1',
      terminal_id: `term${i}`,
      focused: false,
      revision: 1,
    }));
    this.writeHerdrFixture(
      'api-snapshot.json',
      JSON.stringify({
        snapshot: {
          version: 1,
          protocol: 19,
          tabs: [{ tab_id: 'wR:t1' }],
          layouts: [],
          workspaces: [
            {
              workspace_id: 'wR',
              number: 1,
              label: 'repo',
              focused: true,
              pane_count: full.length,
              tab_count: 1,
              active_tab_id: 'wR:t1',
              agent_status: 'unknown',
              worktree: {
                repo_key: 'test/repo',
                repo_name: 'repo',
                repo_root: this.repoDir,
                checkout_path: this.repoDir,
                is_linked_worktree: false,
              },
            },
          ],
          panes: full.map((a) => ({
            pane_id: a.pane_id,
            terminal_id: a.terminal_id,
            workspace_id: 'wR',
            tab_id: 'wR:t1',
            focused: false,
            agent_status: a.agent_status,
            revision: 1,
            cwd: this.repoDir,
          })),
          agents: full,
        },
      }) + '\n',
    );
  }
  writeBoardFixture(name: string, content: string): void {
    fs.writeFileSync(path.join(this.boardFixtures, name), content);
  }

  /** Seed the scoped ledger with exact lines (kept for byte-identity asserts). */
  seedLedger(lines: string[]): void {
    fs.mkdirSync(path.dirname(this.scopedLedger), { recursive: true });
    this.seededLedger = lines.map((l) => `${l}\n`).join('');
    fs.writeFileSync(this.scopedLedger, this.seededLedger);
  }

  ledgerRecords(): Array<Record<string, any>> {
    if (!fs.existsSync(this.scopedLedger)) return [];
    return fs
      .readFileSync(this.scopedLedger, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l));
  }

  /** Open agent refs — the same spawn/discover-minus-exit reduce ledger.sh runs. */
  openAgentRefs(): string[] {
    const open = new Map<string, boolean>();
    for (const e of this.ledgerRecords()) {
      const ref = e.agent_ref ?? '';
      if (ref === '') continue;
      if (e.ev === 'spawn' || e.ev === 'discover') open.set(ref, true);
      else if (e.ev === 'exit') open.set(ref, false);
    }
    return [...open.entries()].filter(([, v]) => v).map(([k]) => k);
  }

  herdrLog(): string[] {
    return readLines(this.herdrLogFile);
  }
  boardLog(): string[] {
    return readLines(this.boardLogFile);
  }
  combinedLog(): string[] {
    return readLines(this.combinedLogFile);
  }
}

export function readLines(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l !== '');
}

/** Count of lines matching a predicate. */
export function countLines(lines: string[], pred: (l: string) => boolean): number {
  return lines.filter(pred).length;
}

/** First index of a line containing the fixed substring; -1 when absent. */
export function firstIndex(lines: string[], substr: string): number {
  return lines.findIndex((l) => l.includes(substr));
}

/** A grammar-B worker spawn line with the full C8 token map, from ref + pane. */
export function spawnLineFor(ref: string, pane: string): string {
  const name = ref.split('#')[0];
  const epoch = ref.split('#')[1] ?? '';
  const m = /^w(\d+)-(.+)$/.exec(name);
  if (!m) throw new Error(`not a w-lane grammar-B name: ${name}`);
  const [, issue, slug] = m;
  return JSON.stringify({
    ts: '2026-08-11T00:00:00Z',
    ev: 'spawn',
    agent_ref: ref,
    pane_id: pane,
    tokens: {
      role: 'w',
      issue,
      slug,
      root: ref,
      depth: '0',
      state: 'spawned',
      branch: `feature/GH-${issue}`,
      harness: 'claude',
      spawn_epoch: epoch,
    },
  });
}

function mkdir(...segs: string[]): string {
  const p = path.join(...segs);
  fs.mkdirSync(p, { recursive: true });
  return p;
}
function touch(...segs: string[]): string {
  const p = path.join(...segs);
  fs.writeFileSync(p, '');
  return p;
}
function writeExecutable(p: string, content: string): void {
  fs.writeFileSync(p, content);
  fs.chmodSync(p, 0o755);
}
function git(args: string[]): void {
  execFileSync('git', args, { stdio: 'pipe' });
}

setWorldConstructor(RalphWorld);

After(function (this: RalphWorld) {
  if (this.tmp && fs.existsSync(this.tmp)) {
    fs.rmSync(this.tmp, { recursive: true, force: true });
  }
});
