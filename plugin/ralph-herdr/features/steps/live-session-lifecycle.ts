// Strict, non-live-testable lifecycle policy for the opt-in Herdr scenarios.

export const ALLOWED_LIVE_SESSIONS = ['ralph-bdd', 'ralph-probe'] as const;
const ALLOWED_LIVE_SESSION_SET = new Set<string>(ALLOWED_LIVE_SESSIONS);

export type LiveSessionState = 'running' | 'stopped' | 'absent';

export interface LiveCommandResult {
  status: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  error?: unknown;
}

export interface LiveSessionCleanupOptions {
  run(args: readonly string[]): Promise<LiveCommandResult> | LiveCommandResult;
  sleep?(ms: number): Promise<void>;
  maxPolls?: number;
  pollMs?: number;
}

export interface LiveSessionCleanupResult {
  initialState: LiveSessionState;
  absencePolls: number;
}

export function assertAllowedLiveSession(session: string): void {
  if (!ALLOWED_LIVE_SESSION_SET.has(session)) {
    throw new Error(
      `refusing to touch herdr session '${session}' — named test sessions only (${ALLOWED_LIVE_SESSIONS.join(', ')})`,
    );
  }
}

export function parseLiveSessionList(stdout: string, session: string): LiveSessionState {
  assertAllowedLiveSession(session);
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length === 0) {
    throw new Error('herdr session list was empty — refusing to infer absence');
  }

  const header = lines[0].trim().split(/\s+/);
  if (header.length !== 4 || header[0] !== 'name' || header[1] !== 'status' ||
      header[2] !== 'directory' || header[3] !== 'socket') {
    throw new Error(`herdr session list had an unparseable header: ${lines[0]}`);
  }

  const seen = new Set<string>();
  let exact: Exclude<LiveSessionState, 'absent'> | undefined;
  for (const line of lines.slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 4) {
      throw new Error(`herdr session list had an unparseable row: ${line}`);
    }
    const [name, status, directory, socket] = fields;
    if (!/^[A-Za-z0-9._-]+$/.test(name) || !directory || !socket) {
      throw new Error(`herdr session list had an unparseable row: ${line}`);
    }
    if (status !== 'running' && status !== 'stopped') {
      throw new Error(`herdr session list had unknown status '${status}' for '${name}'`);
    }
    if (seen.has(name)) {
      throw new Error(`herdr session list was ambiguous: duplicate row for '${name}'`);
    }
    seen.add(name);
    if (name === session) exact = status;
  }
  return exact ?? 'absent';
}

function resultDetail(result: LiveCommandResult): string {
  const pieces = [result.stdout, result.stderr]
    .map((value) => value.trim())
    .filter(Boolean);
  if (result.error) pieces.push(result.error instanceof Error ? result.error.message : String(result.error));
  return pieces.join('\n');
}

function resultSucceeded(result: LiveCommandResult): boolean {
  return result.status === 0 && result.signal === null && result.error === undefined;
}

export function sessionStateFromListResult(result: LiveCommandResult, session: string): LiveSessionState {
  assertAllowedLiveSession(session);
  if (!resultSucceeded(result)) {
    const detail = resultDetail(result);
    throw new Error(
      `herdr session list failed for '${session}' (status ${String(result.status)}, signal ${String(result.signal)})` +
      (detail ? `:\n${detail}` : ''),
    );
  }
  return parseLiveSessionList(result.stdout, session);
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function cleanupLiveSession(
  session: string,
  options: LiveSessionCleanupOptions,
): Promise<LiveSessionCleanupResult> {
  assertAllowedLiveSession(session);
  const maxPolls = options.maxPolls ?? 40;
  const pollMs = options.pollMs ?? 250;
  const sleep = options.sleep ?? defaultSleep;
  if (!Number.isInteger(maxPolls) || maxPolls < 1 || !Number.isFinite(pollMs) || pollMs < 0) {
    throw new Error('invalid live-session cleanup polling configuration');
  }

  const run = async (args: readonly string[]): Promise<LiveCommandResult> => {
    try {
      return await options.run(args);
    } catch (error) {
      return { status: null, signal: null, stdout: '', stderr: '', error };
    }
  };

  const initialState = sessionStateFromListResult(await run(['session', 'list']), session);
  if (initialState === 'absent') return { initialState, absencePolls: 1 };

  const lifecycleFailures: string[] = [];
  if (initialState === 'running') {
    const stopped = await run(['session', 'stop', session]);
    if (!resultSucceeded(stopped)) {
      lifecycleFailures.push(
        `session stop ${session} failed (status ${String(stopped.status)}, signal ${String(stopped.signal)})` +
        (resultDetail(stopped) ? `:\n${resultDetail(stopped)}` : ''),
      );
    }
  }

  const deleted = await run(['session', 'delete', session]);
  if (!resultSucceeded(deleted)) {
    lifecycleFailures.push(
      `session delete ${session} failed (status ${String(deleted.status)}, signal ${String(deleted.signal)})` +
      (resultDetail(deleted) ? `:\n${resultDetail(deleted)}` : ''),
    );
  }

  let lastState: LiveSessionState = initialState;
  for (let poll = 1; poll <= maxPolls; poll += 1) {
    lastState = sessionStateFromListResult(await run(['session', 'list']), session);
    if (lastState === 'absent') {
      if (lifecycleFailures.length > 0) throw new Error(lifecycleFailures.join('\n'));
      return { initialState, absencePolls: poll };
    }
    if (poll < maxPolls) await sleep(pollMs);
  }

  const prefix = lifecycleFailures.length > 0 ? `${lifecycleFailures.join('\n')}\n` : '';
  throw new Error(`${prefix}session '${session}' is still ${lastState} after ${maxPolls} absence checks`);
}
