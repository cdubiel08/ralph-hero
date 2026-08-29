// rh.steps.ts — hermetic operator replay for the public `rh` command surface.
//
// Every step runs the REAL router and Ralph-Herdr scripts. Only the external
// board and Herdr boundaries are fakes, inherited from RalphWorld, so the
// assertions observe public exit status, output, invocation logs, and the
// scoped durable ledger rather than a second implementation of the workflow.
import { Given, Then, When } from '@cucumber/cucumber';
import * as assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import {
  RalphWorld,
  RH_SCRIPT,
  WORLD_SESSION_KEY,
  countLines,
} from './world.ts';

interface RhRun {
  args: string[];
  rc: number;
  stdout: string;
  stderr: string;
  out: string;
}

const scratch = new WeakMap<RalphWorld, { candidateEpics: number[] }>();

function state(world: RalphWorld): { candidateEpics: number[] } {
  let value = scratch.get(world);
  if (!value) {
    value = { candidateEpics: [] };
    scratch.set(world, value);
  }
  return value;
}

function runRh(world: RalphWorld, args: string[]): void {
  const r = spawnSync('bash', [RH_SCRIPT, ...args], {
    cwd: world.repoDir,
    env: world.env(),
    encoding: 'utf8',
    input: '',
    timeout: 90_000,
  });
  world.last = {
    rc: r.status ?? -1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    out: `${r.stdout ?? ''}${r.stderr ?? ''}`,
  };
}

function runOperator(world: RalphWorld, args: string[]): void {
  runRh(world, args);
  fs.appendFileSync(
    world.rhLogFile,
    `${JSON.stringify({ args, ...world.last } satisfies RhRun)}\n`,
  );
}

function rhRuns(world: RalphWorld): RhRun[] {
  return fs
    .readFileSync(world.rhLogFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RhRun);
}

function leadName(epic: number): string {
  return `o${epic}-command-surface`;
}

function teamLabel(epic: number): string {
  return `t${epic}-command-surface`;
}

function seedDispatchFixture(world: RalphWorld): void {
  world.writeBoardFixture(
    'name.dispatch.json',
    `${JSON.stringify({ repo: 'demo', address: 'demo/dispatch' })}\n`,
  );
}

function seedWorktreeSource(world: RalphWorld): void {
  world.writeHerdrFixture(
    'worktree-list.json',
    `${JSON.stringify({
      source: {
        repo_key: `${world.repoDir}/.git`,
        repo_name: 'repo',
        repo_root: world.repoDir,
        source_checkout_path: world.repoDir,
        source_workspace_id: 'wM',
      },
      worktrees: [],
    })}\n`,
  );
}

function seedEpicFixtures(world: RalphWorld, epic: number): void {
  const lead = leadName(epic);
  const team = teamLabel(epic);
  world.writeBoardFixture(
    `get.${epic}.json`,
    `${JSON.stringify({
      number: epic,
      title: 'Command surface',
      issueState: 'OPEN',
      state: 'In Progress',
      children: [],
      childrenTruncated: false,
    })}\n`,
  );
  world.writeBoardFixture(
    `name.${epic}.json`,
    `${JSON.stringify({
      number: epic,
      kind: 'feat',
      lane: 'o',
      branch: `feat/${epic}-command-surface`,
      worktree: `feat-${epic}-command-surface`,
      agent: lead,
      legacyBranch: `feature/GH-${epic}`,
      team,
      teamEpic: epic,
      address: `demo/${team}/${lead}`,
    })}\n`,
  );
  seedDispatchFixture(world);
}

function orchestratorSpawnLine(
  epic: number,
  epoch: string,
  checkout: string,
): string {
  const ts = '2026-08-29T12:00:00Z';
  const name = leadName(epic);
  const ref = `${name}#${epoch}`;
  const pane = `p-history-${epic}-${epoch}`;
  const team = teamLabel(epic);
  return JSON.stringify({
    ts,
    ev: 'spawn',
    agent_ref: ref,
    pane_id: pane,
    shell_pid: 9000,
    checkout,
    session: WORLD_SESSION_KEY,
    lineage: {
      contract: 'ralph.lineage',
      contract_version: 1,
      agent_ref: ref,
      issue: epic,
      role: 'orchestrator',
      spawner: { script: 'work-team.sh', invoked_by: 'human' },
      herdr: { worktree_branch: '', pane_id: pane, workspace_label: team },
      plane: 'herdr',
      spawned_at: ts,
    },
    tokens: {
      role: 'orchestrator',
      issue: String(epic),
      slug: 'command-surface',
      address: `demo/${team}/${name}`,
      root: ref,
      depth: '0',
      state: 'spawned',
      branch: '',
      harness: 'claude',
      spawn_epoch: epoch,
    },
  });
}

function teamAgentStarts(world: RalphWorld): string[] {
  return world.herdrLog().filter((line) => /^agent start o[0-9]+-/.test(line));
}

function startsForEpic(world: RalphWorld, epic: number): string[] {
  return world.herdrLog().filter((line) => new RegExp(`^agent start o${epic}-`).test(line));
}

function teamWorkspaceCreates(world: RalphWorld): string[] {
  return world
    .herdrLog()
    .filter((line) => /^workspace create(?: |$)/.test(line) && /(?:^| )--label t[0-9]+-/.test(line));
}

function workspacesForEpic(world: RalphWorld, epic: number): string[] {
  return teamWorkspaceCreates(world).filter((line) =>
    new RegExp(`(?:^| )--label t${epic}-`).test(line),
  );
}

function attemptedTeamEpics(world: RalphWorld): number[] {
  return teamWorkspaceCreates(world).map((line) => {
    const match = /(?:^| )--label t([0-9]+)-/.exec(line);
    assert.ok(match, `team workspace line did not carry an epic: ${line}`);
    return Number(match[1]);
  });
}

function assertNoBoardSelection(world: RalphWorld): void {
  const selection = world.boardLog().filter((line) => /^(frontier|next)(?: |$)/.test(line));
  assert.deepStrictEqual(
    selection,
    [],
    `resume evidence must come from the scoped ledger, never board ranking:\n${selection.join('\n')}`,
  );
}

Given('the rh server is initially down', function (this: RalphWorld) {
  if (fs.existsSync(this.herdrServerState)) fs.unlinkSync(this.herdrServerState);
  seedDispatchFixture(this);
  seedWorktreeSource(this);
  this.writeHerd([]);
});

Given(
  'team {int} has one scoped historical lead record and no live lead',
  function (this: RalphWorld, epic: number) {
    seedEpicFixtures(this, epic);
    this.seedLedger([orchestratorSpawnLine(epic, 'aaaa2208', this.repoDir)]);
    this.writeHerd([]);
    state(this).candidateEpics = [epic];
  },
);

Given(
  'team {int} has one scoped historical lead record and a live lead',
  function (this: RalphWorld, epic: number) {
    seedEpicFixtures(this, epic);
    this.seedLedger([orchestratorSpawnLine(epic, 'bbbb2208', this.repoDir)]);
    this.writeHerd([{ name: leadName(epic), agent_status: 'working', pane_id: `p-live-${epic}` }]);
    state(this).candidateEpics = [epic];
  },
);

Given('team {int} has contradictory checkout evidence', function (this: RalphWorld, epic: number) {
  seedEpicFixtures(this, epic);
  this.seedLedger([
    orchestratorSpawnLine(epic, 'cccc2208', this.repoDir),
    orchestratorSpawnLine(epic, 'dddd2208', this.originDir),
  ]);
  this.writeHerd([]);
  state(this).candidateEpics = [epic];
});

Given('dispatch up will fail', function (this: RalphWorld) {
  this.writeBoardFixture('name.dispatch.rc', '1\n');
});

When('the operator runs naked rh', function (this: RalphWorld) {
  runOperator(this, []);
});

When('the operator runs rh dispatch', function (this: RalphWorld) {
  runOperator(this, ['dispatch']);
});

When('the operator runs rh dispatch up', function (this: RalphWorld) {
  runOperator(this, ['dispatch', 'up']);
});

When('the operator runs naked rh day', function (this: RalphWorld) {
  runOperator(this, ['day']);
});

When('the operator runs naked rh day again', function (this: RalphWorld) {
  runOperator(this, ['day']);
});

When('resumed lead for {int} becomes live', function (this: RalphWorld, epic: number) {
  const start = startsForEpic(this, epic);
  assert.strictEqual(start.length, 1, `expected the first day to start one GH-${epic} lead:\n${this.herdrLog().join('\n')}`);
  const name = start[0].split(' ')[2];
  assert.ok(name, `agent start line did not carry a name: ${start[0]}`);
  this.writeHerd([{ name, agent_status: 'working', pane_id: `p-resumed-${epic}` }]);
});

When(
  'the operator runs rh day with teams {int}, {int}, and {int}',
  function (this: RalphWorld, first: number, second: number, third: number) {
    const epics = [...new Set([first, second, third])];
    for (const epic of epics) seedEpicFixtures(this, epic);
    state(this).candidateEpics = epics;
    runOperator(this, [
      'day',
      '--team',
      String(first),
      '--team',
      String(second),
      '--team',
      String(third),
    ]);
  },
);

Then('rh succeeds', function (this: RalphWorld) {
  assert.strictEqual(this.last.rc, 0, `expected rh success, got rc ${this.last.rc}:\n${this.last.out}`);
});

Then('rh reports attention', function (this: RalphWorld) {
  assert.strictEqual(this.last.rc, 1, `expected rh attention rc 1, got ${this.last.rc}:\n${this.last.out}`);
  assert.match(this.last.out, /attention|not evaluated|unavailable/i);
});

Then('rh fails', function (this: RalphWorld) {
  assert.notStrictEqual(this.last.rc, 0, `expected rh failure:\n${this.last.out}`);
});

Then('no mutating board or Herdr command ran', function (this: RalphWorld) {
  const unexpectedBoard = this
    .boardLog()
    .filter((line) => !/^(brief|inbox|who dispatch|roster|doctor)(?: |$)/.test(line));
  const unexpectedHerdr = this.herdrLog().filter((line) => line !== 'status server --json');
  assert.deepStrictEqual(unexpectedBoard, [], `unexpected board command(s):\n${unexpectedBoard.join('\n')}`);
  assert.deepStrictEqual(unexpectedHerdr, [], `unexpected Herdr command(s):\n${unexpectedHerdr.join('\n')}`);
});

Then('the Herdr server was started once', function (this: RalphWorld) {
  assert.strictEqual(countLines(this.herdrLog(), (line) => line === 'server'), 1);
});

Then('dispatch was ensured once', function (this: RalphWorld) {
  assert.strictEqual(countLines(this.herdrLog(), (line) => /^workspace create(?: |$)/.test(line)), 1);
  assert.strictEqual(
    countLines(this.herdrLog(), (line) => /^plugin pane open(?: |$)/.test(line) && /(?:^| )--entrypoint hero(?: |$)/.test(line)),
    1,
  );
  assert.strictEqual(countLines(this.boardLog(), (line) => /^name dispatch(?: |$)/.test(line)), 1);
  assert.strictEqual(countLines(this.boardLog(), (line) => /^roster(?: |$)/.test(line)), 1);
});

Then('no team or cockpit command ran', function (this: RalphWorld) {
  assert.deepStrictEqual(teamAgentStarts(this), []);
  assert.deepStrictEqual(teamWorkspaceCreates(this), []);
  assert.strictEqual(
    countLines(this.herdrLog(), (line) => /^plugin pane open(?: |$)/.test(line) && /(?:^| )--entrypoint cockpit(?: |$)/.test(line)),
    0,
  );
});

Then('no work-team command ran', function (this: RalphWorld) {
  assert.deepStrictEqual(teamAgentStarts(this), []);
  assert.deepStrictEqual(teamWorkspaceCreates(this), []);
});

Then('cockpit and inbox followed healthy dispatch', function (this: RalphWorld) {
  const dispatch = this.last.stdout.search(/dispatch\s+ready/);
  const cockpit = this.last.stdout.search(/cockpit\s+ready/);
  const inbox = this.last.stdout.search(/inbox\s+ready/);
  assert.ok(dispatch >= 0, `missing healthy dispatch phase:\n${this.last.stdout}`);
  assert.ok(cockpit > dispatch, `cockpit did not follow dispatch:\n${this.last.stdout}`);
  assert.ok(inbox > cockpit, `inbox did not follow cockpit:\n${this.last.stdout}`);
  assert.strictEqual(
    countLines(this.herdrLog(), (line) => /^plugin pane open(?: |$)/.test(line) && /(?:^| )--entrypoint cockpit(?: |$)/.test(line)),
    1,
  );
  assert.strictEqual(countLines(this.boardLog(), (line) => /^inbox(?: |$)/.test(line)), 1);
});

Then('team {int} was resumed exactly once', function (this: RalphWorld, epic: number) {
  assert.strictEqual(startsForEpic(this, epic).length, 1);
  assert.strictEqual(workspacesForEpic(this, epic).length, 1);
  const runs = rhRuns(this);
  assert.strictEqual(runs.length, 2, `expected two day runs, got ${runs.length}`);
  assert.match(runs[0].out, new RegExp(`resume team GH-${epic}: resumed`));
  assert.match(runs[1].out, new RegExp(`resume team GH-${epic}: already live`));
  const spawnRecords = this
    .ledgerRecords()
    .filter((record) => record.ev === 'spawn' && String(record.agent_ref ?? '').startsWith(`o${epic}-`));
  assert.strictEqual(spawnRecords.length, 2, `expected historical + resumed spawn records:\n${JSON.stringify(spawnRecords, null, 2)}`);
});

Then('no other team was attempted', function (this: RalphWorld) {
  const expected = state(this).candidateEpics;
  assert.deepStrictEqual([...new Set(attemptedTeamEpics(this))], expected);
  const started = teamAgentStarts(this).map((line) => {
    const match = /^agent start o([0-9]+)-/.exec(line);
    assert.ok(match, `team agent start line did not carry an epic: ${line}`);
    return Number(match[1]);
  });
  assert.deepStrictEqual([...new Set(started)], expected);
  assertNoBoardSelection(this);
});

Then('no agent start for team {int} ran', function (this: RalphWorld, epic: number) {
  assert.deepStrictEqual(
    startsForEpic(this, epic),
    [],
    `unexpected GH-${epic} start:\n${this.last.out}\nHERDR:\n${this.herdrLog().join('\n')}\nLEDGER:\n${JSON.stringify(this.ledgerRecords(), null, 2)}`,
  );
  assert.deepStrictEqual(workspacesForEpic(this, epic), []);
  assertNoBoardSelection(this);
});

Then('only teams {int} and {int} were attempted once', function (this: RalphWorld, first: number, second: number) {
  const expected = [first, second];
  for (const epic of expected) {
    assert.strictEqual(startsForEpic(this, epic).length, 1, `GH-${epic} agent starts`);
    assert.strictEqual(workspacesForEpic(this, epic).length, 1, `GH-${epic} workspace creates`);
  }
  assert.strictEqual(teamAgentStarts(this).length, expected.length);
  assert.deepStrictEqual(attemptedTeamEpics(this), expected);
  assertNoBoardSelection(this);
});

Then('reconcile, teams, cockpit, and inbox did not run', function (this: RalphWorld) {
  assert.strictEqual(countLines(this.herdrLog(), (line) => line === 'api snapshot'), 0);
  assert.deepStrictEqual(teamAgentStarts(this), []);
  assert.deepStrictEqual(teamWorkspaceCreates(this), []);
  assert.strictEqual(
    countLines(this.herdrLog(), (line) => /^plugin pane open(?: |$)/.test(line) && /(?:^| )--entrypoint cockpit(?: |$)/.test(line)),
    0,
  );
  assert.strictEqual(countLines(this.boardLog(), (line) => /^inbox(?: |$)/.test(line)), 0);
  assert.doesNotMatch(this.last.out, /reconcile\s+(?:ready|unchanged|failed)|teams\s+(?:ready|unchanged|resumed|attention)|cockpit\s+(?:ready|failed)|inbox\s+(?:ready|attention)/);
});
