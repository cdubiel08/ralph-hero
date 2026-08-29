import { describe, expect, it } from 'vitest';
import {
  cleanupLiveSession,
  parseLiveSessionList,
  sessionStateFromListResult,
  type LiveCommandResult,
} from '../../plugin/ralph-herdr/features/steps/live-session-lifecycle.js';

const header = 'name status directory socket\n';
const row = (name: string, status: string) => `${name} ${status} /tmp/${name} /tmp/${name}.sock\n`;
const ok = (stdout = ''): LiveCommandResult => ({ status: 0, signal: null, stdout, stderr: '' });

describe('strict live Herdr session lifecycle', () => {
  it.each([
    ['running', header + row('default', 'running') + row('ralph-bdd', 'running')],
    ['stopped', header + row('ralph-bdd', 'stopped')],
    ['absent', header + row('default', 'running')],
  ] as const)('derives exact %s state only from a complete session table', (state, stdout) => {
    expect(parseLiveSessionList(stdout, 'ralph-bdd')).toBe(state);
  });

  it.each([
    ['empty output', ''],
    ['unknown header', 'session state directory socket\n'],
    ['truncated row', header + 'ralph-bdd running /tmp/ralph-bdd\n'],
    ['extra row field', header + 'ralph-bdd running /tmp/a /tmp/a.sock extra\n'],
    ['unknown status', header + row('ralph-bdd', 'starting')],
    ['duplicate target rows', header + row('ralph-bdd', 'running') + row('ralph-bdd', 'stopped')],
  ])('rejects %s instead of inferring absence or stopped', (_description, stdout) => {
    expect(() => parseLiveSessionList(stdout, 'ralph-bdd')).toThrow();
  });

  it('rejects transport failure and a non-allowlisted default target', () => {
    expect(() =>
      sessionStateFromListResult({ status: 1, signal: null, stdout: header, stderr: 'offline' }, 'ralph-bdd'),
    ).toThrow(/session list failed/);
    expect(() => parseLiveSessionList(header + row('default', 'running'), 'default')).toThrow(/named test sessions only/);
  });

  it('stops, deletes, and polls the exact allowlisted name until absence is proven', async () => {
    const calls: string[][] = [];
    const results = [
      ok(header + row('ralph-bdd', 'running')),
      ok('stopped ralph-bdd\n'),
      ok('deleted ralph-bdd\n'),
      ok(header + row('ralph-bdd', 'stopped')),
      ok(header),
    ];
    let sleeps = 0;

    await expect(cleanupLiveSession('ralph-bdd', {
      run: async (args) => {
        calls.push([...args]);
        const result = results.shift();
        if (!result) throw new Error('unexpected lifecycle call');
        return result;
      },
      sleep: async () => { sleeps += 1; },
      maxPolls: 3,
      pollMs: 0,
    })).resolves.toEqual({ initialState: 'running', absencePolls: 2 });

    expect(calls).toEqual([
      ['session', 'list'],
      ['session', 'stop', 'ralph-bdd'],
      ['session', 'delete', 'ralph-bdd'],
      ['session', 'list'],
      ['session', 'list'],
    ]);
    expect(sleeps).toBe(1);
  });

  it('fails cleanup when an exact lifecycle command fails even if absence is later proven', async () => {
    const calls: string[][] = [];
    const results = [
      ok(header + row('ralph-bdd', 'running')),
      { status: 9, signal: null, stdout: '', stderr: 'stop refused' } satisfies LiveCommandResult,
      ok('deleted ralph-bdd\n'),
      ok(header),
    ];

    await expect(cleanupLiveSession('ralph-bdd', {
      run: async (args) => {
        calls.push([...args]);
        return results.shift()!;
      },
      sleep: async () => {},
      maxPolls: 1,
      pollMs: 0,
    })).rejects.toThrow(/session stop ralph-bdd failed.*stop refused/s);
    expect(calls).toEqual([
      ['session', 'list'],
      ['session', 'stop', 'ralph-bdd'],
      ['session', 'delete', 'ralph-bdd'],
      ['session', 'list'],
    ]);
  });

  it('fails closed on malformed absence proof and never targets the default session', async () => {
    const malformedCalls: string[][] = [];
    await expect(cleanupLiveSession('ralph-bdd', {
      run: async (args) => {
        malformedCalls.push([...args]);
        return ok('{}\n');
      },
      sleep: async () => {},
      maxPolls: 1,
      pollMs: 0,
    })).rejects.toThrow(/session list/);
    expect(malformedCalls).toEqual([['session', 'list']]);

    const defaultCalls: string[][] = [];
    await expect(cleanupLiveSession('default', {
      run: async (args) => {
        defaultCalls.push([...args]);
        return ok(header);
      },
      sleep: async () => {},
    })).rejects.toThrow(/named test sessions only/);
    expect(defaultCalls).toEqual([]);
  });

  it('fails when the exact session never becomes absent', async () => {
    const results = [
      ok(header + row('ralph-bdd', 'stopped')),
      ok('deleted ralph-bdd\n'),
      ok(header + row('ralph-bdd', 'stopped')),
      ok(header + row('ralph-bdd', 'stopped')),
    ];
    await expect(cleanupLiveSession('ralph-bdd', {
      run: async () => results.shift()!,
      sleep: async () => {},
      maxPolls: 2,
      pollMs: 0,
    })).rejects.toThrow(/still stopped after 2 absence checks/);
  });
});
