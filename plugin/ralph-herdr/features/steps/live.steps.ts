// live.steps.ts — step definitions for the @live scenarios.
//
// SAFETY CONTRACT (absolute — mirrors the suite header in live-smoke.feature):
//   * named test sessions only (ralph-bdd / ralph-probe) — the operator's
//     default herdr session is NEVER touched: every herdr call here goes
//     through `herdr --session <name>`, and `herdr server stop` (unscoped)
//     is never issued;
//   * plain shell panes only (`herdr pane run`) — no claude/codex agents,
//     nothing that bills;
//   * the session is stopped AND deleted in the After hook even when a step
//     failed;
//   * doubly gated: the test:bdd:live npm script refuses without
//     RALPH_BDD_LIVE=1, and every entry step re-checks the same env.
import { After, Given, Then, When } from '@cucumber/cucumber';
import * as assert from 'node:assert';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RalphWorld, SCRIPTS_DIR } from './world.ts';

const ALLOWED_SESSIONS = new Set(['ralph-bdd', 'ralph-probe']);

function gate(): void {
  if (process.env.RALPH_BDD_LIVE !== '1') {
    throw new Error(
      'refusing the live world: set RALPH_BDD_LIVE=1 (run via `npm run test:bdd:live`) — live scenarios start a real herdr server in the named test session ralph-bdd',
    );
  }
}

function herdrSession(session: string, args: string[], timeoutMs = 15_000): string {
  if (!ALLOWED_SESSIONS.has(session)) {
    throw new Error(`refusing to touch herdr session '${session}' — named test sessions only`);
  }
  return execFileSync('herdr', ['--session', session, ...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function sessionListed(session: string): 'running' | 'stopped' | 'absent' {
  const out = spawnSync('herdr', ['session', 'list'], { encoding: 'utf8', timeout: 10_000 });
  const line = (out.stdout ?? '').split('\n').find((l) => l.trim().startsWith(`${session} `) || l.trim().startsWith(`${session}\t`));
  if (!line) return 'absent';
  return /\brunning\b/.test(line) ? 'running' : 'stopped';
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

Given('a live herdr test session named {string}', async function (this: RalphWorld, session: string) {
  gate();
  if (!ALLOWED_SESSIONS.has(session)) {
    throw new Error(`refusing session name '${session}' — the safety contract allows only ${[...ALLOWED_SESSIONS].join(', ')}`);
  }
  const probe = spawnSync('herdr', ['--version'], { encoding: 'utf8', timeout: 10_000 });
  if (probe.status !== 0) throw new Error('herdr CLI not available on PATH — live scenarios need a real herdr install');
  this.liveSession = session;
  this.liveTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-bdd-live-'));
  if (sessionListed(session) !== 'running') {
    // Headless server for the NAMED session, detached; the After hook stops
    // and deletes it by name. Never `herdr server stop` (unscoped).
    const logFd = fs.openSync(path.join(this.liveTmp, 'server.log'), 'a');
    const child = spawn('herdr', ['--session', session, 'server'], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });
    child.unref();
    fs.closeSync(logFd);
  }
  const deadline = Date.now() + 20_000;
  while (sessionListed(session) !== 'running') {
    if (Date.now() > deadline) {
      throw new Error(`herdr session '${session}' did not reach running within 20s`);
    }
    await sleep(500);
  }
});

Given('a workspace with a plain shell pane in the test session', async function (this: RalphWorld) {
  gate();
  const created = herdrSession(this.liveSession, [
    'workspace',
    'create',
    '--cwd',
    this.liveTmp,
    '--no-focus',
  ]);
  let paneId = '';
  try {
    const j = JSON.parse(created);
    paneId =
      j?.result?.workspace?.root_pane?.pane_id ??
      j?.result?.root_pane?.pane_id ??
      j?.result?.pane?.pane_id ??
      '';
  } catch {
    /* fall through to pane list */
  }
  if (!paneId) {
    // Shape-tolerant fallback: take the newest pane the session reports.
    const listed = herdrSession(this.liveSession, ['pane', 'list']);
    const ids = [...listed.matchAll(/"pane_id"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);
    paneId = ids[ids.length - 1] ?? '';
  }
  assert.ok(paneId, `no pane id discoverable after workspace create:\n${created}`);
  this.livePane = paneId;
});

When('the pane runs the shell command {string}', async function (this: RalphWorld, cmd: string) {
  gate();
  // Plain shell only — never an agent kind, never claude/codex.
  herdrSession(this.liveSession, ['pane', 'run', this.livePane, 'bash', '-c', cmd]);
  await sleep(1000);
});

Then("the pane's output contains {string}", async function (this: RalphWorld, needle: string) {
  let tail = '';
  for (let i = 0; i < 20; i++) {
    tail = herdrSession(this.liveSession, [
      'pane',
      'read',
      this.livePane,
      '--source',
      'recent',
      '--lines',
      '80',
    ]);
    if (tail.includes(needle)) break;
    await sleep(500);
  }
  assert.ok(tail.includes(needle), `pane tail never showed '${needle}':\n${tail}`);
});

Then('the pane answers a well-formed pane JSON envelope', function (this: RalphWorld) {
  const raw = herdrSession(this.liveSession, ['pane', 'get', this.livePane]);
  const j = JSON.parse(raw);
  assert.ok(j && typeof j === 'object' && 'result' in j, `no result envelope in:\n${raw}`);
  const pane = j.result?.pane ?? j.result;
  assert.ok(pane && typeof pane === 'object', `no pane object in:\n${raw}`);
});

Given('an empty temporary ledger root', function (this: RalphWorld) {
  this.liveLedgerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-bdd-ledger-'));
});

When('the reconcile pass runs against the live test session', function (this: RalphWorld) {
  gate();
  // reconcile.sh talks through $HERDR_BIN_PATH — hand it a wrapper that pins
  // the NAMED session so no read can land on the default session.
  const wrapper = path.join(this.liveTmp || os.tmpdir(), 'herdr-bdd-session');
  fs.writeFileSync(wrapper, `#!/bin/bash\nexec herdr --session ${this.liveSession} "$@"\n`);
  fs.chmodSync(wrapper, 0o755);
  const r = spawnSync('bash', [path.join(SCRIPTS_DIR, 'reconcile.sh')], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      HERDR_BIN_PATH: wrapper,
      RALPH_HERDR_LEDGER_ROOT: this.liveLedgerRoot,
    },
  });
  this.last = {
    rc: r.status ?? -1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    out: `${r.stdout ?? ''}${r.stderr ?? ''}`,
  };
});

Then('the temporary ledger root is still empty', function (this: RalphWorld) {
  assert.deepStrictEqual(fs.readdirSync(this.liveLedgerRoot), [], 'reconcile wrote into an empty ledger root');
});

// Cleanup ALWAYS — the named session is stopped and deleted even when a step
// failed; only ever by name, only allowlisted names.
After({ tags: '@live' }, function (this: RalphWorld) {
  if (this.liveSession && ALLOWED_SESSIONS.has(this.liveSession)) {
    spawnSync('herdr', ['session', 'stop', this.liveSession], { encoding: 'utf8', timeout: 15_000 });
    spawnSync('herdr', ['session', 'delete', this.liveSession], { encoding: 'utf8', timeout: 15_000 });
  }
  for (const dir of [this.liveTmp, this.liveLedgerRoot]) {
    if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
});
