// live.steps.ts — step definitions for the @live scenarios.
//
// SAFETY CONTRACT (absolute — mirrors the suite header in live-smoke.feature):
//   * named test sessions only (ralph-bdd / ralph-probe) — the operator's
//     default herdr session is NEVER touched: every server/status/workspace/
//     pane/agent call goes through `herdr --session <name>`; only named
//     session list/stop/delete lifecycle calls are unscoped, and `herdr server
//     stop` is never issued;
//   * plain shell panes only (`workspace create`, `pane split`, `pane run`) —
//     no claude/codex agents, nothing that bills;
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
import { RalphWorld, RH_SCRIPT, SCRIPTS_DIR } from './world.ts';
import {
  renderLiveHerdrWrapper,
  RH_COCKPIT_LABEL,
  RH_DISPATCH_LABEL,
  RH_LIVE_SESSION,
} from './live-herdr-wrapper.ts';

const ALLOWED_SESSIONS = new Set(['ralph-bdd', 'ralph-probe']);

interface LiveState {
  realHerdr: string;
  repo: string;
  wrapper: string;
  wrapperLog: string;
  stubLog: string;
  scripts: string;
  board: string;
}

const liveStates = new WeakMap<RalphWorld, LiveState>();

function gate(): void {
  if (process.env.RALPH_BDD_LIVE !== '1') {
    throw new Error(
      'refusing the live world: set RALPH_BDD_LIVE=1 (run via `npm run test:bdd:live`) — live scenarios start a real herdr server in the named test session ralph-bdd',
    );
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function writeExecutable(file: string, lines: string[]): void {
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  fs.chmodSync(file, 0o755);
}

function resolveExecutable(name: string): string {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.resolve(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch {
      // Keep searching PATH.
    }
  }
  throw new Error(`${name} CLI not available on PATH — live scenarios need a real install`);
}

function liveState(world: RalphWorld): LiveState {
  const state = liveStates.get(world);
  assert.ok(state, 'live rh state was not initialized');
  return state;
}

function prepareLiveWorld(world: RalphWorld, session: string): LiveState {
  gate();
  if (!ALLOWED_SESSIONS.has(session)) {
    throw new Error(`refusing session name '${session}' — the safety contract allows only ${[...ALLOWED_SESSIONS].join(', ')}`);
  }
  const realHerdr = resolveExecutable('herdr');
  const probe = spawnSync(realHerdr, ['--version'], { encoding: 'utf8', timeout: 10_000 });
  if (probe.status !== 0) throw new Error('herdr CLI not available on PATH — live scenarios need a real herdr install');
  world.liveSession = session;
  world.liveTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-bdd-live-'));
  const state: LiveState = {
    realHerdr,
    repo: path.join(world.liveTmp, 'repo'),
    wrapper: path.join(world.liveTmp, `herdr-${RH_LIVE_SESSION}`),
    wrapperLog: path.join(world.liveTmp, 'herdr-wrapper.log'),
    stubLog: path.join(world.liveTmp, 'rh-stubs.log'),
    scripts: path.join(world.liveTmp, 'rh-scripts'),
    board: path.join(world.liveTmp, 'board'),
  };
  liveStates.set(world, state);
  return state;
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
  if (out.status !== 0) {
    throw new Error(`herdr session list failed — refusing to infer absence:\n${out.stdout ?? ''}${out.stderr ?? ''}`);
  }
  const line = (out.stdout ?? '').split('\n').find((l) => l.trim().startsWith(`${session} `) || l.trim().startsWith(`${session}\t`));
  if (!line) return 'absent';
  return /\brunning\b/.test(line) ? 'running' : 'stopped';
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

Given('a live herdr test session named {string}', async function (this: RalphWorld, session: string) {
  const state = prepareLiveWorld(this, session);
  if (sessionListed(session) !== 'running') {
    // Headless server for the NAMED session, detached; the After hook stops
    // and deletes it by name. Never `herdr server stop` (unscoped).
    //
    // RALPH_HERDR_LEDGER_ROOT is pinned to a throwaway dir for the SERVER's
    // own environment, and that is load-bearing (GH-2018). herdr fires the
    // `[[startup]]` hook for EVERY server that starts, this one included, and
    // that hook runs reconcile.sh — inheriting this process's env, so without
    // the pin it would sweep the operator's real `~/.ralph` ledgers while
    // answering about a herd it has never had. That is finding D8 verbatim,
    // and starting a test server would be betting the operator's live fleet on
    // the very gate the suite is here to measure.
    //
    // Bounding it does not weaken the measurement: the D8 scenarios invoke
    // reconcile.sh themselves against a scratch ledger root they seeded, so
    // the hook is the delivery mechanism, not the subject. This removes an
    // uncontrolled second pass whose victim would be real.
    const quarantine = path.join(this.liveTmp, 'startup-hook-quarantine');
    fs.mkdirSync(quarantine, { recursive: true });
    const logFd = fs.openSync(path.join(this.liveTmp, 'server.log'), 'a');
    const child = spawn(state.realHerdr, ['--session', session, 'server'], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env, RALPH_HERDR_LEDGER_ROOT: quarantine },
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

Given('an absent live herdr test session named {string}', async function (this: RalphWorld, session: string) {
  const state = prepareLiveWorld(this, session);
  const listed = sessionListed(session);
  if (listed === 'running') {
    spawnSync(state.realHerdr, ['session', 'stop', session], { encoding: 'utf8', timeout: 15_000 });
  }
  if (listed !== 'absent') {
    const deleted = spawnSync(state.realHerdr, ['session', 'delete', session], {
      encoding: 'utf8',
      timeout: 15_000,
    });
    assert.strictEqual(
      deleted.status,
      0,
      `could not delete pre-existing named test session '${session}':\n${deleted.stdout ?? ''}${deleted.stderr ?? ''}`,
    );
  }
  const deadline = Date.now() + 10_000;
  while (sessionListed(session) !== 'absent') {
    if (Date.now() > deadline) throw new Error(`herdr session '${session}' did not become absent within 10s`);
    await sleep(250);
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

/**
 * The env a live reconcile runs under.
 *
 * Every inherited `RALPH_`/`HERDR_` key is scrubbed before this world's own
 * values go back — the same rule world.ts's `env()` states for the replay
 * world, and it matters more here, not less. An operator's exported
 * `RALPH_HERDR_DRY_RUN=true` would turn the D8 scenario's "nothing was marked
 * lost" into a tautology about the harness rather than a fact about the gate,
 * and this suite's whole claim is that its refusals are measurements. Prefix
 * scrub, not a name list, so knobs added later are isolated by default.
 * `ANTHROPIC_API_KEY` goes too: nothing here may bill, and the billing guard
 * must not be handed a reason to think it may.
 */
function liveEnv(w: RalphWorld, wrapper: string): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(e)) {
    if (/^(RALPH_|HERDR_)/.test(k) || k === 'ANTHROPIC_API_KEY') delete e[k];
  }
  return {
    ...e,
    HERDR_BIN_PATH: wrapper,
    RALPH_HERDR_LEDGER_ROOT: w.liveLedgerRoot,
    NO_COLOR: '1',
  };
}

/**
 * reconcile.sh talks through `$HERDR_BIN_PATH` — a wrapper that pins the NAMED
 * session so no read can land on the operator's default session.
 */
function sessionWrapper(w: RalphWorld): string {
  const wrapper = path.join(w.liveTmp || os.tmpdir(), 'herdr-bdd-session');
  writeExecutable(wrapper, [
    '#!/bin/bash',
    `exec ${shellQuote(liveState(w).realHerdr)} --session ${shellQuote(w.liveSession)} "$@"`,
  ]);
  return wrapper;
}

function installRhLiveStubs(world: RalphWorld): void {
  const state = liveState(world);
  assert.strictEqual(
    world.liveSession,
    RH_LIVE_SESSION,
    `safe rh live stubs are pinned to ${RH_LIVE_SESSION}, not ${world.liveSession}`,
  );
  world.liveLedgerRoot = path.join(world.liveTmp, 'ledger-root');
  fs.mkdirSync(state.repo, { recursive: true });
  fs.mkdirSync(state.scripts, { recursive: true });
  fs.mkdirSync(world.liveLedgerRoot, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', state.repo], { stdio: 'pipe' });
  fs.writeFileSync(
    path.join(state.repo, '.ralph.json'),
    '{"owner":"ralph-bdd","repo":"rh-live","projectNumber":1}\n',
  );
  fs.writeFileSync(state.wrapperLog, '');
  fs.writeFileSync(state.stubLog, '');

  fs.writeFileSync(
    state.wrapper,
    renderLiveHerdrWrapper({ realHerdr: state.realHerdr, callLog: state.wrapperLog, repo: state.repo }),
  );
  fs.chmodSync(state.wrapper, 0o755);

  writeExecutable(state.board, [
    '#!/bin/bash',
    'set -u',
    `printf 'board %s\\n' "$*" >>${shellQuote(state.stubLog)}`,
    'case "${1-}" in',
    "  inbox) printf 'inbox: empty\\n' ;;",
    "  *) printf 'safe board stub: refusing %s\\n' \"$*\" >&2; exit 97 ;;",
    'esac',
  ]);

  writeExecutable(path.join(state.scripts, 'dispatch-up.sh'), [
    '#!/bin/bash',
    'set -euo pipefail',
    'HERDR="${HERDR_BIN_PATH:?}"',
    `LABEL=${shellQuote(RH_DISPATCH_LABEL)}`,
    `REPO=${shellQuote(state.repo)}`,
    `LOG=${shellQuote(state.stubLog)}`,
    "printf 'dispatch-up\\n' >>\"$LOG\"",
    'workspaces=$("$HERDR" workspace list)',
    "count=$(printf '%s\\n' \"$workspaces\" | jq -er --arg label \"$LABEL\" '(.result.workspaces // null) as $rows | if ($rows | type) != \"array\" then error(\"missing workspaces\") else [$rows[] | select((.label // \"\") == $label)] | length end')",
    '[ "$count" -le 1 ] || { echo "safe dispatch stub: duplicate $LABEL workspaces" >&2; exit 1; }',
    'if [ "$count" -eq 0 ]; then',
    '  created=$("$HERDR" workspace create --cwd "$REPO" --label "$LABEL" --no-focus)',
    "  ws=$(printf '%s\\n' \"$created\" | jq -er '.result.workspace.workspace_id // .result.workspace_id // empty')",
    "  pane=$(printf '%s\\n' \"$created\" | jq -er '.result.workspace.root_pane.pane_id // .result.root_pane.pane_id // .result.pane.pane_id // empty')",
    '  "$HERDR" pane rename "$pane" "$LABEL" >/dev/null',
    'else',
    "  ws=$(printf '%s\\n' \"$workspaces\" | jq -er --arg label \"$LABEL\" '.result.workspaces[] | select((.label // \"\") == $label) | .workspace_id')",
    '  panes=$("$HERDR" pane list --workspace "$ws")',
    "  pane_count=$(printf '%s\\n' \"$panes\" | jq -er --arg label \"$LABEL\" '(.result.panes // null) as $rows | if ($rows | type) != \"array\" then error(\"missing panes\") else [$rows[] | select(((.label // .title) // \"\") == $label)] | length end')",
    '  [ "$pane_count" -le 1 ] || { echo "safe dispatch stub: duplicate $LABEL panes" >&2; exit 1; }',
    '  if [ "$pane_count" -eq 0 ]; then',
    "    pane=$(printf '%s\\n' \"$panes\" | jq -er '.result.panes[0].pane_id // empty')",
    '    "$HERDR" pane rename "$pane" "$LABEL" >/dev/null',
    '  fi',
    'fi',
    "printf 'dispatch ready: %s\\n' \"$ws\"",
  ]);

  writeExecutable(path.join(state.scripts, 'reconcile.sh'), [
    '#!/bin/bash',
    'set -eu',
    `printf 'reconcile\\n' >>${shellQuote(state.stubLog)}`,
  ]);
  writeExecutable(path.join(state.scripts, 'resume-teams.sh'), [
    '#!/bin/bash',
    'set -eu',
    `printf 'resume-teams\\n' >>${shellQuote(state.stubLog)}`,
  ]);
  writeExecutable(path.join(state.scripts, 'work-team.sh'), [
    '#!/bin/bash',
    `printf 'FORBIDDEN work-team %s\\n' "$*" >>${shellQuote(state.stubLog)}`,
    "echo 'safe live scenario refuses team creation' >&2",
    'exit 97',
  ]);
  writeExecutable(path.join(state.scripts, 'cockpit-open.sh'), [
    '#!/bin/bash',
    'set -euo pipefail',
    'HERDR="${HERDR_BIN_PATH:?}"',
    `LABEL=${shellQuote(RH_COCKPIT_LABEL)}`,
    `DISPATCH_LABEL=${shellQuote(RH_DISPATCH_LABEL)}`,
    `REPO=${shellQuote(state.repo)}`,
    `LOG=${shellQuote(state.stubLog)}`,
    "printf 'cockpit-open\\n' >>\"$LOG\"",
    'panes=$("$HERDR" pane list)',
    "count=$(printf '%s\\n' \"$panes\" | jq -er --arg label \"$LABEL\" '(.result.panes // null) as $rows | if ($rows | type) != \"array\" then error(\"missing panes\") else [$rows[] | select(((.label // .title) // \"\") == $label)] | length end')",
    '[ "$count" -le 1 ] || { echo "safe cockpit stub: duplicate $LABEL panes" >&2; exit 1; }',
    'if [ "$count" -eq 0 ]; then',
    '  workspaces=$("$HERDR" workspace list)',
    "  ws_count=$(printf '%s\\n' \"$workspaces\" | jq -er --arg label \"$DISPATCH_LABEL\" '[.result.workspaces[] | select((.label // \"\") == $label)] | length')",
    '  [ "$ws_count" -eq 1 ] || { echo "safe cockpit stub: expected one $DISPATCH_LABEL workspace" >&2; exit 1; }',
    "  ws=$(printf '%s\\n' \"$workspaces\" | jq -er --arg label \"$DISPATCH_LABEL\" '.result.workspaces[] | select((.label // \"\") == $label) | .workspace_id')",
    '  dispatch_panes=$("$HERDR" pane list --workspace "$ws")',
    "  anchor=$(printf '%s\\n' \"$dispatch_panes\" | jq -er --arg label \"$DISPATCH_LABEL\" '.result.panes[] | select(((.label // .title) // \"\") == $label) | .pane_id' | head -n 1)",
    '  created=$("$HERDR" pane split "$anchor" --direction right --cwd "$REPO" --no-focus)',
    "  pane=$(printf '%s\\n' \"$created\" | jq -er '.result.pane.pane_id // .result.root_pane.pane_id // .result.pane_id // empty')",
    '  "$HERDR" pane rename "$pane" "$LABEL" >/dev/null',
    'else',
    "  pane=$(printf '%s\\n' \"$panes\" | jq -er --arg label \"$LABEL\" '.result.panes[] | select(((.label // .title) // \"\") == $label) | .pane_id')",
    'fi',
    '"$HERDR" plugin pane focus "$pane" >/dev/null',
    "printf 'cockpit ready: %s\\n' \"$pane\"",
  ]);
}

function rhLiveEnv(world: RalphWorld): NodeJS.ProcessEnv {
  const state = liveState(world);
  return {
    ...liveEnv(world, state.wrapper),
    RALPH_HOME: path.join(world.liveTmp, 'ralph-home'),
    RALPH_BOARD: state.board,
    RALPH_HERDR_SCRIPTS_DIR: state.scripts,
    RALPH_RH_SERVER_ATTEMPTS: '40',
    RALPH_RH_SERVER_POLL_SEC: '0.25',
  };
}

function noAgents(world: RalphWorld, checkpoint: string): void {
  const raw = herdrSession(world.liveSession, ['agent', 'list']);
  const agents = JSON.parse(raw)?.result?.agents;
  assert.ok(Array.isArray(agents), `agent list was not a protocol array at ${checkpoint}:\n${raw}`);
  assert.deepStrictEqual(agents, [], `coding agents appeared at ${checkpoint}:\n${raw}`);
}

function runLiveRhDay(world: RalphWorld, checkpoint: string): void {
  noAgents(world, `before ${checkpoint}`);
  const state = liveState(world);
  const r = spawnSync('/bin/bash', [RH_SCRIPT, 'day'], {
    cwd: state.repo,
    env: rhLiveEnv(world),
    encoding: 'utf8',
    timeout: 90_000,
    input: '',
  });
  world.last = {
    rc: r.status ?? -1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    out: `${r.stdout ?? ''}${r.stderr ?? ''}`,
  };
  noAgents(world, `after ${checkpoint}`);
}

function resultRows(raw: string, key: 'workspaces' | 'panes'): Array<Record<string, unknown>> {
  const rows = JSON.parse(raw)?.result?.[key];
  assert.ok(Array.isArray(rows), `${key} list did not contain a protocol array:\n${raw}`);
  return rows;
}

function paneLabel(row: Record<string, unknown>): string {
  return typeof row.label === 'string' ? row.label : typeof row.title === 'string' ? row.title : '';
}

Given('safe rh live stubs for board, dispatch, resume, and cockpit', function (this: RalphWorld) {
  gate();
  installRhLiveStubs(this);
});

When('rh day starts the named test session', function (this: RalphWorld) {
  gate();
  runLiveRhDay(this, 'first rh day');
});

When('rh day runs again in the named test session', function (this: RalphWorld) {
  gate();
  runLiveRhDay(this, 'second rh day');
});

Then('rh reports a healthy dispatch and inbox', function (this: RalphWorld) {
  assert.strictEqual(this.last.rc, 0, `rh day failed in the safe live world:\n${this.last.out}`);
  assert.match(this.last.stdout, /dispatch\s+ready/, `no healthy dispatch phase:\n${this.last.stdout}`);
  assert.match(this.last.stdout, /inbox\s+ready/, `no healthy inbox phase:\n${this.last.stdout}`);
  assert.ok(
    fs.readFileSync(liveState(this).stubLog, 'utf8').split('\n').includes('board inbox'),
    'rh day never reached the local inbox stub',
  );
});

Then('the named test session has no coding agents', function (this: RalphWorld) {
  noAgents(this, 'named-session assertion');
});

Then('no second server or dispatch seat is created', function (this: RalphWorld) {
  assert.strictEqual(this.last.rc, 0, `second rh day failed:\n${this.last.out}`);
  noAgents(this, 'idempotency assertion');
  const state = liveState(this);
  const calls = fs.readFileSync(state.wrapperLog, 'utf8').split('\n').filter(Boolean);
  assert.strictEqual(calls.filter((line) => line === 'server').length, 1, `server starts:\n${calls.join('\n')}`);

  const workspaces = resultRows(herdrSession(this.liveSession, ['workspace', 'list']), 'workspaces');
  assert.strictEqual(
    workspaces.filter((row) => row.label === RH_DISPATCH_LABEL).length,
    1,
    `expected exactly one ${RH_DISPATCH_LABEL} workspace:\n${JSON.stringify(workspaces, null, 2)}`,
  );
  const panes = resultRows(herdrSession(this.liveSession, ['pane', 'list']), 'panes');
  assert.strictEqual(
    panes.filter((row) => paneLabel(row) === RH_DISPATCH_LABEL).length,
    1,
    `expected exactly one ${RH_DISPATCH_LABEL} pane:\n${JSON.stringify(panes, null, 2)}`,
  );
  assert.strictEqual(
    panes.filter((row) => paneLabel(row) === RH_COCKPIT_LABEL).length,
    1,
    `expected exactly one ${RH_COCKPIT_LABEL} pane:\n${JSON.stringify(panes, null, 2)}`,
  );

  const stubs = fs.readFileSync(state.stubLog, 'utf8');
  assert.doesNotMatch(stubs, /^FORBIDDEN /m, `a forbidden team path ran:\n${stubs}`);
  assert.doesNotMatch(
    calls.join('\n'),
    /(?:^|\s)agent start(?:\s|$)|\b(?:claude|codex|gh)\b/,
    `the safe wrapper observed a forbidden command:\n${calls.join('\n')}`,
  );
});

When('the reconcile pass runs against the live test session', function (this: RalphWorld) {
  gate();
  const r = spawnSync('bash', [path.join(SCRIPTS_DIR, 'reconcile.sh')], {
    encoding: 'utf8',
    timeout: 60_000,
    env: liveEnv(this, sessionWrapper(this)),
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

// ── D8: the controlled re-test (GH-2018) ────────────────────────────────────
// The replay suites pin the ownership gate's logic against fake-herdr.sh.
// These steps re-enter the D8 shape against a REAL isolated server, which is
// the half a fake cannot reproduce: a server that has genuinely never held
// these panes, answering into the phases that read absence as death.

/** The two seeded workers. Neither carries `shell_pid`, and both name a
 *  checkout that does not exist — see the feature's blast-bound paragraph. */
const D8_REFS = ['w4242-alpha#aaaa', 'w4243-beta#bbbb'] as const;
const D8_PANES = ['p-d8-alpha', 'p-d8-beta'] as const;

/**
 * The `ralph_session_key` reconcile.sh will compute for THIS run.
 *
 * Shelled out to ledger.sh's own function under the exact env the pass gets,
 * never re-derived here. The key is a hash of herdr's socket selection, which
 * the wrapper and the scrubbed env between them decide; a second copy of that
 * resolution ladder in TypeScript would be free to drift, and the positive
 * control below is worth exactly as much as this value is correct.
 */
function liveSessionKey(w: RalphWorld, wrapper: string): string {
  const out = execFileSync(
    'bash',
    ['-c', `. "${path.join(SCRIPTS_DIR, 'ledger.sh')}" && ralph_session_key`],
    { encoding: 'utf8', timeout: 15_000, env: liveEnv(w, wrapper) },
  );
  const key = out.trim();
  assert.ok(key, 'ralph_session_key printed nothing — the positive control cannot be trusted');
  return key;
}

/** Seed <root>/acme/demo/ledger.jsonl with the two open records. */
function seedD8Ledger(w: RalphWorld, session: string): void {
  w.liveLedgerRoot ||= fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-bdd-ledger-'));
  w.liveScopedLedger = path.join(w.liveLedgerRoot, 'acme', 'demo', 'ledger.jsonl');
  fs.mkdirSync(path.dirname(w.liveScopedLedger), { recursive: true });
  w.liveSeededLedger = D8_REFS.map((ref, i) => {
    const [name, epoch] = ref.split('#');
    const m = /^w(\d+)-(.+)$/.exec(name)!;
    return `${JSON.stringify({
      ts: '2026-08-15T00:00:00Z',
      ev: 'spawn',
      agent_ref: ref,
      pane_id: D8_PANES[i],
      session,
      // No `checkout`: recover_claim can resolve no board scope from an empty
      // one, so the claim-recovery phase cannot reach GitHub even if its own
      // pane-verdict guard failed. A bound, not the assertion.
      checkout: '',
      tokens: {
        role: 'w',
        issue: m[1],
        slug: m[2],
        root: ref,
        depth: '0',
        state: 'spawned',
        harness: 'claude',
        spawn_epoch: epoch,
      },
    })}\n`;
  }).join('');
  fs.writeFileSync(w.liveScopedLedger, w.liveSeededLedger);
}

function d8Records(w: RalphWorld): Array<Record<string, any>> {
  return fs
    .readFileSync(w.liveScopedLedger, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l));
}

Given('a scratch ledger root holding two open records written by another session', function (this: RalphWorld) {
  gate();
  // A key no ralph_session_key can produce: the real one is 12 hex chars.
  seedD8Ledger(this, 'not-this-servers-session-key');
});

Given('a scratch ledger root holding two open records written by this server', function (this: RalphWorld) {
  gate();
  this.liveLedgerRoot ||= fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-bdd-ledger-'));
  seedD8Ledger(this, liveSessionKey(this, sessionWrapper(this)));
});

Then('no record in the scratch ledger is marked lost', function (this: RalphWorld) {
  const exits = d8Records(this).filter((r) => r.ev === 'exit');
  assert.deepStrictEqual(
    exits,
    [],
    `reconcile swept a ledger it holds no pane of and did not write:\n${this.last.out}`,
  );
});

Then('the scratch ledger is byte-identical to what was seeded', function (this: RalphWorld) {
  assert.strictEqual(
    fs.readFileSync(this.liveScopedLedger, 'utf8'),
    this.liveSeededLedger,
    'the foreign ledger was written to at all',
  );
});

Then('the pass declined the sweep out loud', function (this: RalphWorld) {
  assert.ok(
    this.last.out.includes("not this server's ledger"),
    `the pass swept nothing but never said why — silence and a working gate must not read alike:\n${this.last.out}`,
  );
});

Then('both records are still open', function (this: RalphWorld) {
  const open = new Map<string, boolean>();
  for (const r of d8Records(this)) {
    if (r.ev === 'spawn' || r.ev === 'discover') open.set(r.agent_ref, true);
    else if (r.ev === 'exit') open.set(r.agent_ref, false);
  }
  assert.deepStrictEqual(
    [...open.entries()].filter(([, v]) => v).map(([k]) => k).sort(),
    [...D8_REFS].sort(),
  );
});

Then('both records are marked lost', function (this: RalphWorld) {
  // The control that makes the refusals above measurements rather than
  // tautologies: same ledger, same live server, same empty herd — the ONLY
  // difference is the writer stamp, and the sweep runs.
  const lost = d8Records(this)
    .filter((r) => r.ev === 'exit' && r.reason === 'lost')
    .map((r) => r.agent_ref)
    .sort();
  assert.deepStrictEqual(
    lost,
    [...D8_REFS].sort(),
    `the ownership proof did not reach phase A — the refusal scenarios prove nothing without this:\n${this.last.out}`,
  );
});

Given('the scratch scope has an armed fleet from another session', function (this: RalphWorld) {
  gate();
  const dir = path.join(path.dirname(this.liveScopedLedger), 'runs', 'd8-run');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'fleet.json'),
    `${JSON.stringify({
      run_id: 'd8-run',
      armed: true,
      k: 3,
      refill: true,
      budget_left: 8,
      // Far future: an expired arm disarms before the ownership gate is
      // reached, which would pass this scenario for the wrong reason.
      expires_at: '2099-01-01T00:00:00Z',
      // A repo that does not exist. If the ownership gate ever failed, the
      // refill path disarms here instead of spawning — the blast bound. The
      // assertion below is that we never got that far.
      repo: path.join(this.liveTmp, 'no-such-repo'),
      session: 'not-this-servers-session-key',
      spawned: [],
      created_at: '2026-08-15T00:00:00Z',
    })}\n`,
  );
});

Then('the pass declined the refill out loud', function (this: RalphWorld) {
  assert.ok(
    /refill: .*was armed by session .*not this server/.test(this.last.out),
    `phase F did not name the foreign arming — an inert refill and a gated one must not read alike:\n${this.last.out}`,
  );
});

Then('the refill never reached the spawn path', function (this: RalphWorld) {
  // The blast bound's own line. Seeing it would mean the ownership gate let
  // this run through and only the missing repo stopped the spawn.
  assert.ok(
    !this.last.out.includes('is gone — disarming'),
    `the refill got PAST the ownership gate and was stopped only by the missing repo:\n${this.last.out}`,
  );
});

Then('the live test session gained no agents', function (this: RalphWorld) {
  const raw = herdrSession(this.liveSession, ['agent', 'list']);
  const agents = JSON.parse(raw)?.result?.agents ?? [];
  assert.deepStrictEqual(agents, [], `the live test session holds agents it never should have:\n${raw}`);
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
