// replay.steps.ts — step definitions for the @replay world: drive the REAL
// bash scripts through the fake-herdr/fake-board harness (see world.ts) and
// assert through the invocation logs + the scoped ledger JSONL. Contract
// validation goes through the REAL board CLI (offline schema work).
import { Given, When, Then } from '@cucumber/cucumber';
import * as assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  RalphWorld,
  REAL_BOARD,
  REPO_ROOT,
  SCRIPTS_DIR,
  countLines,
  firstIndex,
  spawnLineFor,
} from './world.ts';

interface SeededAgent {
  ref: string;
  pane: string;
}

// Per-scenario scratch that isn't part of the world's harness surface.
const scratch = new WeakMap<
  RalphWorld,
  {
    issue?: number;
    parent?: number;
    title?: string;
    label?: string;
    liveAgent?: string;
    seeded?: SeededAgent[];
  }
>();
function s(world: RalphWorld) {
  let v = scratch.get(world);
  if (!v) {
    v = {};
    scratch.set(world, v);
  }
  return v;
}

function issueOf(name: string): string {
  const m = /^[a-z](\d+)-/.exec(name);
  if (!m) throw new Error(`not a grammar-B name: ${name}`);
  return m[1];
}

// ── Givens ───────────────────────────────────────────────────────────────────

Given('a replay world with a board-scoped repo', function (this: RalphWorld) {
  this.build();
});

Given('the herd is empty', function (this: RalphWorld) {
  this.writeHerd([]);
});

Given(
  'the queue offers issue {int} titled {string} under parent {int}',
  function (this: RalphWorld, issue: number, title: string, parent: number) {
    s(this).issue = issue;
    s(this).parent = parent;
    this.queueJson = JSON.stringify({
      next: { number: issue, title, parentNumber: parent },
      queue: [],
    });
  },
);

Given(
  'an agent named {string} is already live on pane {string}',
  function (this: RalphWorld, name: string, pane: string) {
    s(this).liveAgent = name;
    this.writeHerd([{ name, agent_status: 'working', pane_id: pane }]);
  },
);

Given(
  'a ledgered agent {string} with epoch {string} on pane {string} for issue {int}',
  function (this: RalphWorld, name: string, epoch: string, pane: string, issue: number) {
    s(this).issue = issue;
    this.seedLedger([spawnLineFor(`${name}#${epoch}`, pane)]);
  },
);

Given(
  'the frontier offers issues {int} {string}, {int} {string}, {int} {string}',
  function (this: RalphWorld, n1: number, t1: string, n2: number, t2: string, n3: number, t3: string) {
    this.writeBoardFixture(
      'frontier.json',
      JSON.stringify({
        frontier: [
          { number: n1, title: t1 },
          { number: n2, title: t2 },
          { number: n3, title: t3 },
        ],
        blocked: [],
      }) + '\n',
    );
  },
);

Given('every worktree verb fails for branch {string}', function (this: RalphWorld, branch: string) {
  this.failWorktreesForBranch(branch);
});

Given(
  'the ledger records spawns for {string} on pane {string} and {string} on pane {string}',
  function (this: RalphWorld, ref1: string, pane1: string, ref2: string, pane2: string) {
    s(this).seeded = [
      { ref: ref1, pane: pane1 },
      { ref: ref2, pane: pane2 },
    ];
    this.seedLedger([spawnLineFor(ref1, pane1), spawnLineFor(ref2, pane2)]);
  },
);

Given(
  'the live herd answers {string} on pane {string} and {string} on pane {string}',
  function (this: RalphWorld, n1: string, p1: string, n2: string, p2: string) {
    this.writeHerd([
      { name: n1, agent_status: 'working', pane_id: p1 },
      { name: n2, agent_status: 'working', pane_id: p2 },
    ]);
  },
);

Given(
  'the live herd answers {string} on pane {string} and an unledgered {string} on pane {string} whose pane cwd is the scoped repo',
  function (this: RalphWorld, n1: string, p1: string, n2: string, p2: string) {
    // Both agents bind to this world's repo through the snapshot's workspace
    // worktree provenance — which is also how the discover path now resolves
    // the unledgered one's board scope, so no per-pane `pane get` is needed.
    this.writeHerd([
      { name: n1, agent_status: 'working', pane_id: p1 },
      { name: n2, agent_status: 'idle', pane_id: p2 },
    ]);
  },
);

Given('the herdr server refuses every read', function (this: RalphWorld) {
  this.extraEnv.HERDR_BIN_PATH = '/usr/bin/false';
});

Given('Human Needed holds issue {int} titled {string}', function (this: RalphWorld, issue: number, title: string) {
  s(this).issue = issue;
  this.writeBoardFixture('list.json', JSON.stringify({ items: [{ number: issue, title }] }) + '\n');
});

Given('the board CLI predates the answer verb', function (this: RalphWorld) {
  this.writeBoardFixture('help.txt', 'mutations:\n  move NNN STATE\n');
});

// ── Whens ────────────────────────────────────────────────────────────────────

When('spawn_work_session runs for issue {int}', function (this: RalphWorld, issue: number) {
  const r = this.run(
    [
      'set -u',
      `. "${SCRIPTS_DIR}/lib.sh"`,
      'rc=0',
      'spawn_work_session "$BDD_ISSUE" "$BDD_QUEUE" || rc=$?',
      `printf 'BDD_RC=%s\\nBDD_AGENT=%s\\nBDD_REF=%s\\nBDD_PANE=%s\\n' "$rc" "\${RALPH_HERDR_SPAWNED_AGENT-}" "\${RALPH_HERDR_SPAWNED_REF-}" "\${RALPH_HERDR_SPAWNED_PANE-}"`,
    ].join('\n'),
    { env: { BDD_ISSUE: String(issue), BDD_QUEUE: this.queueJson } },
  );
  const grab = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(r.stdout)?.[1] ?? '';
  this.spawnRc = Number(grab('BDD_RC'));
  this.spawnAgent = grab('BDD_AGENT');
  this.spawnRef = grab('BDD_REF');
  this.spawnPane = grab('BDD_PANE');
});

When(
  'the watcher receives agent status {string} for {string} on pane {string} titled {string} with blocked label {string}',
  function (this: RalphWorld, status: string, agent: string, pane: string, title: string, label: string) {
    s(this).title = title;
    s(this).label = label;
    // The herd must actually hold the agent in that state: a status event is a
    // hint now (GH-1774), and the durable write is taken from the SNAPSHOT, not
    // the payload. These scenarios are the agreeing case — the event reports
    // what the herd already shows.
    this.writeHerd([{ name: agent, agent_status: status, pane_id: pane }]);
    this.run(`bash "${SCRIPTS_DIR}/watch-event.sh"`, {
      env: {
        HERDR_PLUGIN_EVENT: 'pane.agent_status_changed',
        HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
          pane_id: pane,
          agent,
          agent_status: status,
          title,
          state_labels: { blocked: label },
        }),
      },
    });
  },
);


Given(
  'the live herd reports {string} as {string} on pane {string}',
  function (this: RalphWorld, agent: string, status: string, pane: string) {
    this.writeHerd([{ name: agent, agent_status: status, pane_id: pane }]);
  },
);

When(
  'the watcher receives a stale agent status {string} for {string} on pane {string}',
  function (this: RalphWorld, status: string, agent: string, pane: string) {
    // Deliberately does NOT touch the herd: the payload and the snapshot
    // disagree, which is the whole point of the scenario.
    this.run(`bash "${SCRIPTS_DIR}/watch-event.sh"`, {
      env: {
        HERDR_PLUGIN_EVENT: 'pane.agent_status_changed',
        HERDR_PLUGIN_EVENT_JSON: JSON.stringify({ pane_id: pane, agent, agent_status: status }),
      },
    });
  },
);

When(
  'the watcher receives agent status {string} for {string} on pane {string}',
  function (this: RalphWorld, status: string, agent: string, pane: string) {
    // The herd must actually hold the agent in that state: a status event is a
    // hint now (GH-1774), and the durable write is taken from the SNAPSHOT, not
    // the payload. These scenarios are the agreeing case — the event reports
    // what the herd already shows.
    this.writeHerd([{ name: agent, agent_status: status, pane_id: pane }]);
    this.run(`bash "${SCRIPTS_DIR}/watch-event.sh"`, {
      env: {
        HERDR_PLUGIN_EVENT: 'pane.agent_status_changed',
        HERDR_PLUGIN_EVENT_JSON: JSON.stringify({ pane_id: pane, agent, agent_status: status }),
      },
    });
  },
);

When('work-fleet runs with a fleet size of {int}', function (this: RalphWorld, k: number) {
  this.run(`bash "${SCRIPTS_DIR}/work-fleet.sh" </dev/null`, {
    env: { RALPH_HERDR_FLEET: String(k), RALPH_HERDR_WATCH_POLL: '1' },
  });
});

When('the reconcile pass runs', function (this: RalphWorld) {
  this.run(`bash "${SCRIPTS_DIR}/reconcile.sh"`);
});

When('the operator answers item {int} with {string}', function (this: RalphWorld, pick: number, msg: string) {
  this.lastAnswerMsg = msg;
  this.run(`bash "${SCRIPTS_DIR}/ralph-answer.sh"`, {
    stdin: `${pick}\n${msg}\n.\n\n`,
    env: { FAKE_BOARD_LOG: this.combinedLogFile, FAKE_HERDR_LOG: this.combinedLogFile },
  });
});

// ── Thens: spawn + naming ────────────────────────────────────────────────────

Then('the spawn succeeds', function (this: RalphWorld) {
  assert.strictEqual(this.spawnRc, 0, `spawn rc — output:\n${this.last.out}`);
  const n = s(this).issue;
  assert.match(this.last.out, new RegExp(`spawned GH-${n} on feature/GH-${n}`));
});

Then('the agent is named {string}', function (this: RalphWorld, name: string) {
  assert.strictEqual(this.spawnAgent, name);
});

Then(
  'the worktree was created on branch {string} from origin\\/main',
  function (this: RalphWorld, branch: string) {
    const line = this.herdrLog().find((l) => l.startsWith('worktree create '));
    assert.ok(line, 'no worktree create call reached herdr');
    assert.ok(
      line.includes(`--branch ${branch} --base origin/main`),
      `worktree create not pinned to origin/main: ${line}`,
    );
  },
);

Then('the agent was prompted with {string}', function (this: RalphWorld, prompt: string) {
  const want = `agent prompt ${this.spawnAgent} ${prompt}`;
  assert.strictEqual(
    countLines(this.herdrLog(), (l) => l === want),
    1,
    `expected exactly one '${want}' in the herdr log`,
  );
});

Then(
  'the ledger holds one spawn record binding the agent ref to issue {int} with parent {int}',
  function (this: RalphWorld, issue: number, parent: number) {
    const spawns = this.ledgerRecords().filter((r) => r.ev === 'spawn');
    assert.strictEqual(spawns.length, 1, 'expected exactly one spawn record');
    const rec = spawns[0];
    assert.strictEqual(rec.agent_ref, this.spawnRef);
    assert.strictEqual(rec.lineage.contract, 'ralph.lineage');
    assert.strictEqual(rec.lineage.agent_ref, this.spawnRef);
    assert.strictEqual(rec.lineage.issue, issue);
    assert.strictEqual(rec.lineage.parent_issue, parent);
    assert.strictEqual(rec.lineage.plane, 'herdr');
    assert.strictEqual(rec.lineage.herdr.worktree_branch, `feature/GH-${issue}`);
  },
);

Then("the spawn record's agent ref is the agent's name plus a 8-hex epoch", function (this: RalphWorld) {
  assert.match(this.spawnRef, new RegExp(`^${this.spawnAgent}#[0-9a-f]{8}$`));
});

Then(
  "the spawn record's lineage validates against the ralph.lineage contract",
  function (this: RalphWorld) {
    const rec = this.ledgerRecords().find((r) => r.ev === 'spawn');
    assert.ok(rec, 'no spawn record to validate');
    const file = path.join(this.tmp, 'lineage-under-test.json');
    fs.writeFileSync(file, JSON.stringify(rec.lineage) + '\n');
    // The REAL validator, offline (fleet.test.sh parity): contract validate
    // is pure schema work, run from the repo checkout.
    const r = spawnSync(REAL_BOARD, ['contract', 'validate', 'ralph.lineage', file], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 90_000,
    });
    assert.strictEqual(r.status, 0, `board contract validate refused:\n${r.stdout}${r.stderr}`);
  },
);

Then('the spawn tokens were pushed onto the pane', function (this: RalphWorld) {
  const line = this.herdrLog().find((l) => l.startsWith(`pane report-metadata ${this.spawnPane} `));
  assert.ok(line, `no token push for pane ${this.spawnPane}`);
  for (const tok of ['--token role=w', `--token issue=${s(this).issue}`, '--token state=spawned']) {
    assert.ok(line.includes(tok), `token push missing '${tok}': ${line}`);
  }
});

Then('the spawn is skipped as already live', function (this: RalphWorld) {
  assert.strictEqual(this.spawnRc, 2, `expected the skip rc 2 — output:\n${this.last.out}`);
  assert.ok(this.last.out.includes(`SKIP ${s(this).liveAgent} already live`), this.last.out);
});

Then('no worktree was created and no agent was started', function (this: RalphWorld) {
  const log = this.herdrLog();
  assert.strictEqual(countLines(log, (l) => l.startsWith('worktree ')), 0, 'a worktree verb ran');
  assert.strictEqual(countLines(log, (l) => l.startsWith('agent start ')), 0, 'an agent was started');
});

Then('no {string} sibling name was ever attempted', function (this: RalphWorld, suffix: string) {
  assert.ok(!this.herdrLog().join('\n').includes(suffix), `'${suffix}' reached herdr`);
  assert.ok(!this.last.out.includes(suffix), `'${suffix}' appeared in the output`);
});

Then('the ledger stayed empty', function (this: RalphWorld) {
  assert.strictEqual(this.ledgerRecords().length, 0, 'the ledger gained records');
});

// ── Thens: watcher escalation ────────────────────────────────────────────────

Then('the hook exits 0', function (this: RalphWorld) {
  assert.strictEqual(this.last.rc, 0, this.last.out);
});

Then(
  'the ledger holds no state event recording status {string} for {string}',
  function (this: RalphWorld, status: string, ref: string) {
    const hits = this.ledgerRecords().filter(
      (r) => r.ev === 'state' && r.agent_status === status && r.agent_ref === ref,
    );
    assert.strictEqual(hits.length, 0, `stale payload status reached the ledger: ${JSON.stringify(hits)}`);
  },
);

Then(
  'the ledger holds exactly {int} state event recording status {string} for {string}',
  function (this: RalphWorld, count: number, status: string, ref: string) {
    const hits = this.ledgerRecords().filter(
      (r) => r.ev === 'state' && r.agent_status === status && r.agent_ref === ref,
    );
    assert.strictEqual(hits.length, count);
  },
);

Then(
  'the state token {string} was pushed onto pane {string} exactly once',
  function (this: RalphWorld, state: string, pane: string) {
    const want = `pane report-metadata ${pane} --source ralph-herdr --token state=${state}`;
    assert.strictEqual(countLines(this.herdrLog(), (l) => l === want), 1);
  },
);

Then(
  'exactly 1 notification was shown, carrying the title and the blocked label',
  function (this: RalphWorld) {
    const toasts = this.herdrLog().filter((l) => l.startsWith('notification show'));
    assert.strictEqual(toasts.length, 1, `expected one toast, saw: ${toasts.join(' | ')}`);
    assert.ok(toasts[0].includes(s(this).title ?? ''), `title missing from: ${toasts[0]}`);
    assert.ok(toasts[0].includes(s(this).label ?? ''), `label missing from: ${toasts[0]}`);
  },
);

Then('no notification was shown', function (this: RalphWorld) {
  assert.strictEqual(countLines(this.herdrLog(), (l) => l.startsWith('notification show')), 0);
});

Then('no state token and no notification went out', function (this: RalphWorld) {
  const log = this.herdrLog();
  assert.strictEqual(countLines(log, (l) => l.startsWith('pane report-metadata')), 0);
  assert.strictEqual(countLines(log, (l) => l.startsWith('notification show')), 0);
});

// ── Thens: fleet resilience ──────────────────────────────────────────────────

Then(
  'the fleet summary reports GH-{int} failed and the other two spawned',
  function (this: RalphWorld, failed: number) {
    assert.strictEqual(this.last.rc, 0, this.last.out);
    assert.match(this.last.out, new RegExp(`failed:\\s+GH-${failed}`));
    assert.ok(this.last.out.includes(`GH-${failed}: spawn failed`), this.last.out);
    const spawnedLine = this.last.out.split('\n').find((l) => l.trimStart().startsWith('spawned:'));
    assert.ok(spawnedLine, 'no fleet summary spawned line');
    assert.ok(!spawnedLine.includes(`GH-${failed}`) && !spawnedLine.includes(`w${failed}-`));
  },
);

Then(
  'agents {string} and {string} were each started and prompted once',
  function (this: RalphWorld, a1: string, a2: string) {
    const log = this.herdrLog();
    for (const a of [a1, a2]) {
      assert.strictEqual(
        countLines(log, (l) => l.startsWith(`agent start ${a} `)),
        1,
        `agent start count for ${a}`,
      );
      const prompt = `agent prompt ${a} /ralph:work ${issueOf(a)}`;
      assert.strictEqual(countLines(log, (l) => l === prompt), 1, `prompt count for ${a}`);
    }
  },
);

Then('no agent was ever started for issue {int}', function (this: RalphWorld, issue: number) {
  assert.strictEqual(
    countLines(this.herdrLog(), (l) => l.startsWith(`agent start w${issue}-`)),
    0,
  );
});

Then(
  'the ledger holds spawn records for issues {int} and {int} only',
  function (this: RalphWorld, n1: number, n2: number) {
    const issues = this.ledgerRecords()
      .filter((r) => r.ev === 'spawn')
      .map((r) => r.lineage.issue)
      .sort((a: number, b: number) => a - b);
    assert.deepStrictEqual(issues, [n1, n2].sort((a, b) => a - b));
  },
);

Then('reconcile completes its single pass', function (this: RalphWorld) {
  assert.strictEqual(this.last.rc, 0, this.last.out);
  assert.ok(this.last.out.includes('reconcile complete'), this.last.out);
});

Then('both survivors stay open in the ledger', function (this: RalphWorld) {
  const open = this.openAgentRefs().sort();
  const want = (s(this).seeded ?? []).map((x) => x.ref).sort();
  assert.deepStrictEqual(open, want);
});

Then("each survivor's spawn tokens were re-pushed onto its pane", function (this: RalphWorld) {
  for (const { ref, pane } of s(this).seeded ?? []) {
    const line = this.herdrLog().find((l) => l.startsWith(`pane report-metadata ${pane} `));
    assert.ok(line, `no token re-push for pane ${pane}`);
    const issue = issueOf(ref.split('#')[0]);
    assert.ok(line.includes(`--token issue=${issue}`), `issue token missing: ${line}`);
    assert.ok(line.includes('--token state=working'), `live state token missing: ${line}`);
  }
});

// ── Thens: lineage survives restart ──────────────────────────────────────────

Then('the pre-restart ledger lines are still byte-identical on disk', function (this: RalphWorld) {
  const now = fs.readFileSync(this.scopedLedger, 'utf8');
  assert.ok(
    now.startsWith(this.seededLedger),
    'the append-only prefix changed — pre-restart lines were rewritten',
  );
});

Then('{string} was marked lost via reconcile', function (this: RalphWorld, ref: string) {
  const hits = this.ledgerRecords().filter(
    (r) => r.ev === 'exit' && r.agent_ref === ref && r.reason === 'lost' && r.via === 'reconcile',
  );
  assert.strictEqual(hits.length, 1);
});

Then(
  'a discover record minted a fresh ref for {string} bound to pane {string}',
  function (this: RalphWorld, name: string, pane: string) {
    const hits = this.ledgerRecords().filter(
      (r) =>
        r.ev === 'discover' &&
        new RegExp(`^${name}#[0-9a-f]{8}$`).test(r.agent_ref) &&
        r.pane_id === pane &&
        r.via === 'reconcile',
    );
    assert.strictEqual(hits.length, 1, `discover records for ${name}: ${hits.length}`);
    assert.strictEqual(hits[0].tokens.issue, issueOf(name));
  },
);

Then(
  '{string} replayed its spawn tokens onto pane {string}',
  function (this: RalphWorld, ref: string, pane: string) {
    const line = this.herdrLog().find((l) => l.startsWith(`pane report-metadata ${pane} `));
    assert.ok(line, `no token re-push for pane ${pane}`);
    const issue = issueOf(ref.split('#')[0]);
    for (const tok of ['--token role=w', `--token issue=${issue}`, `--token branch=feature/GH-${issue}`]) {
      assert.ok(line.includes(tok), `'${tok}' missing from re-push: ${line}`);
    }
    assert.ok(line.includes('--token state=working'), `live status must supersede: ${line}`);
    assert.ok(!line.includes('--token state=spawned'), `stale recorded state replayed: ${line}`);
  },
);

Then('the open set is exactly {string} and {string}', function (this: RalphWorld, n1: string, n2: string) {
  const names = this.openAgentRefs()
    .map((r) => r.split('#')[0])
    .sort();
  assert.deepStrictEqual(names, [n1, n2].sort());
});

Then('reconcile declines the pass loudly', function (this: RalphWorld) {
  assert.strictEqual(this.last.rc, 0, this.last.out);
  assert.ok(this.last.out.includes('not reconciling'), this.last.out);
});

Then('the ledger is untouched', function (this: RalphWorld) {
  assert.strictEqual(fs.readFileSync(this.scopedLedger, 'utf8'), this.seededLedger);
});

// ── Thens: answer comment-first ──────────────────────────────────────────────

Then('the answer run exits 0', function (this: RalphWorld) {
  assert.strictEqual(this.last.rc, 0, this.last.out);
});

Then('the board answer verb carried the message for issue {int}', function (this: RalphWorld, issue: number) {
  const want = `answer ${issue} -m ${this.lastAnswerMsg}`;
  assert.strictEqual(
    countLines(this.combinedLog(), (l) => l === want),
    1,
    `expected exactly one '${want}' in:\n${this.combinedLog().join('\n')}`,
  );
});

Then('the board answer preceded the agent nudge in the combined log', function (this: RalphWorld) {
  const log = this.combinedLog();
  const a = firstIndex(log, `answer ${s(this).issue} -m`);
  const b = firstIndex(log, `agent prompt ${s(this).liveAgent}`);
  assert.ok(a >= 0 && b >= 0 && a < b, `answer at ${a}, nudge at ${b}:\n${log.join('\n')}`);
});

Then('the board answer even preceded the herd read', function (this: RalphWorld) {
  const log = this.combinedLog();
  const a = firstIndex(log, `answer ${s(this).issue} -m`);
  const b = log.findIndex((l) => l === 'api snapshot');
  assert.ok(a >= 0 && b >= 0 && a < b, `answer at ${a}, api snapshot at ${b}:\n${log.join('\n')}`);
});

Then('the nudge waited for delivery with a bounded timeout', function (this: RalphWorld) {
  const want = `agent prompt ${s(this).liveAgent} answered on issue — re-read #${s(this).issue} and resume --wait --timeout 15000`;
  assert.strictEqual(countLines(this.combinedLog(), (l) => l === want), 1);
});

Then('delivery was reported as nudged', function (this: RalphWorld) {
  assert.ok(this.last.out.includes(`nudged ${s(this).liveAgent}`), this.last.out);
});

Then('no agent prompt was ever attempted', function (this: RalphWorld) {
  assert.strictEqual(countLines(this.combinedLog(), (l) => l.startsWith('agent prompt')), 0);
});

Then('the output names the missing session for issue {int}', function (this: RalphWorld, issue: number) {
  assert.ok(this.last.out.includes(`no live session for #${issue}`), this.last.out);
});

Then('the missing verb was never called', function (this: RalphWorld) {
  assert.strictEqual(
    countLines(this.combinedLog(), (l) => l.startsWith(`answer ${s(this).issue}`)),
    0,
  );
});

Then('the gh comment preceded the board move in the combined log', function (this: RalphWorld) {
  const log = this.combinedLog();
  const a = firstIndex(log, `gh issue comment ${s(this).issue}`);
  const b = firstIndex(log, `move ${s(this).issue} In Progress`);
  assert.ok(a >= 0 && b >= 0 && a < b, `gh comment at ${a}, move at ${b}:\n${log.join('\n')}`);
});
