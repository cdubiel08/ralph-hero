import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  renderLiveHerdrWrapper,
  RH_COCKPIT_LABEL,
  RH_DISPATCH_LABEL,
} from '../../plugin/ralph-herdr/features/steps/live-herdr-wrapper.js';

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

describe('rh live Herdr wrapper', () => {
  let tmp = '';
  let repo = '';
  let wrapper = '';
  let wrapperLog = '';
  let fakeLog = '';

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-live-wrapper-'));
    repo = path.join(tmp, 'repo with spaces');
    fs.mkdirSync(repo);
    const fakeDir = path.join(tmp, 'fake bin');
    fs.mkdirSync(fakeDir);
    const fakeHerdr = path.join(fakeDir, 'herdr');
    fakeLog = path.join(tmp, 'fake-herdr.log');
    wrapperLog = path.join(tmp, 'wrapper calls.log');
    wrapper = path.join(tmp, 'herdr-ralph-bdd');
    fs.writeFileSync(
      fakeHerdr,
      [
        '#!/bin/bash',
        `printf 'CALL' >>${shellQuote(fakeLog)}`,
        `for arg in "$@"; do printf '\\t%s' "$arg" >>${shellQuote(fakeLog)}; done`,
        `printf '\\n' >>${shellQuote(fakeLog)}`,
        '',
      ].join('\n'),
    );
    fs.chmodSync(fakeHerdr, 0o755);
    fs.writeFileSync(
      wrapper,
      renderLiveHerdrWrapper({ realHerdr: fakeHerdr, callLog: wrapperLog, repo }),
    );
    fs.chmodSync(wrapper, 0o755);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function fakeCalls(): string[] {
    if (!fs.existsSync(fakeLog)) return [];
    return fs.readFileSync(fakeLog, 'utf8').trim().split('\n').filter(Boolean);
  }

  it('allows every exact rh live topology call and pins it to ralph-bdd', () => {
    const allowed = [
      ['status', 'server', '--json'],
      ['server'],
      ['workspace', 'list'],
      ['workspace', 'create', '--cwd', repo, '--label', RH_DISPATCH_LABEL, '--no-focus'],
      ['pane', 'list'],
      ['pane', 'list', '--workspace', 'w1'],
      ['pane', 'rename', 'p1', RH_DISPATCH_LABEL],
      ['pane', 'rename', 'p2', RH_COCKPIT_LABEL],
      ['pane', 'split', 'p1', '--direction', 'right', '--cwd', repo, '--no-focus'],
      ['plugin', 'pane', 'focus', 'p2'],
    ];

    for (const argv of allowed) {
      const run = spawnSync(wrapper, argv, { encoding: 'utf8' });
      expect(run.status, `${argv.join(' ')}\n${run.stderr}`).toBe(0);
    }

    expect(fakeCalls()).toEqual(
      allowed.map((argv) => ['CALL', '--session', 'ralph-bdd', ...argv].join('\t')),
    );
  });

  it('rejects agent, session-selection, and unknown argv before real Herdr is invoked', () => {
    const forbidden = [
      ['agent', 'list'],
      ['--session', 'default', 'status', 'server', '--json'],
      ['status', 'server', '--json', '--session', 'default'],
      ['workspace', 'list', '--session=default'],
      ['status', 'server', '--json', '--remote-keybindings'],
      ['pane', 'list', '--workspace', '--session'],
      ['workspace', 'create', '--cwd', repo, '--label', 'not-the-live-label', '--no-focus'],
      ['notification', 'list'],
    ];

    const runs = forbidden.map((argv) => spawnSync(wrapper, argv, { encoding: 'utf8' }));
    expect(runs.map((run) => run.status)).toEqual(forbidden.map(() => 64));
    expect(runs.map((run) => run.stderr)).toEqual(
      forbidden.map(() => 'herdr-ralph-bdd: refusing command outside the live rh allowlist\n'),
    );
    expect(fakeCalls()).toEqual([]);
  });
});
