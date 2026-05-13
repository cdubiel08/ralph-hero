/**
 * Pure read library for the local ralph-delegate JSONL audit log.
 *
 * The log lives at `~/.ralph-hero/delegate.log` (overridable via
 * `RALPH_DELEGATE_LOG_PATH`). One JSON object per line, append-only,
 * written by `plugin/ralph-hero/scripts/ralph-delegate.sh`. This library
 * only reads — it never writes.
 *
 * Schema versioning: F1 (issue #1185) does NOT emit an explicit
 * `schemaVersion` field on each line. F5 treats lines containing the
 * required fields `{ts, task, status, ms}` as **implicit v1**. A future
 * issue MAY add an explicit `schemaVersion >= 2` — when that happens, the
 * shape-check should be expanded to honor it. TODO: revisit when the
 * producer side emits `schemaVersion`.
 *
 * Determinism: pure functions. Filesystem reads are the only side effect.
 * Missing log file resolves to a zero-state result with no throw, matching
 * the activity.ts precedent (the steady state for opt-out users).
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One parsed delegation event. The on-disk shape (per
 * `ralph-delegate.sh:_audit_log`) is:
 *   {ts, task, model, url, ms, status, bytes_in, bytes_out, caller}
 *
 * Only `{ts, task, status, ms}` are required for the line to be accepted
 * (implicit v1 schema). Other fields are optional.
 */
export interface DelegationEvent {
  ts: string;
  task: string;
  status: string;
  ms: number;
  model?: string;
  url?: string;
  bytes_in?: number;
  bytes_out?: number;
  caller?: string;
  /** Reserved for a future explicit schema bump. */
  schemaVersion?: number;
}

export interface DelegationReadConfig {
  logPath: string;
}

export interface DelegationReadResult {
  events: DelegationEvent[];
  skippedLines: number;
  fileExists: boolean;
  logPath: string;
}

export interface DelegationTaskStats {
  calls: number;
  fallbacks: number;
  p50Ms: number | null;
  p99Ms: number | null;
  bytesIn: number;
  bytesOut: number;
  /** Always null until F1 captures `.usage` from the OpenAI response. */
  tokens: null;
}

export interface DelegationStats {
  totals: {
    calls: number;
    fallbacks: number;
    bytesIn: number;
    bytesOut: number;
  };
  byTask: Record<string, DelegationTaskStats>;
}

// ---------------------------------------------------------------------------
// Test hook + default path resolution
// ---------------------------------------------------------------------------

/**
 * Optional override used only by tests. Production code never sets this.
 * Mirrors `__setSnapshotRoot` in `snapshots.ts`.
 */
let delegateLogPathOverride: string | null = null;

/** Test hook: override the default log path. Pass `null` to restore. */
export function __setDelegateLogPath(path: string | null): void {
  delegateLogPathOverride = path;
}

/**
 * Resolve the default log path: env var override, then `~/.ralph-hero/delegate.log`.
 * Expands a leading `~/` (mirrors `ralph-delegate.sh:208-211`).
 */
export function defaultDelegationLogPath(): string {
  if (delegateLogPathOverride !== null) return delegateLogPathOverride;
  const fromEnv = process.env.RALPH_DELEGATE_LOG_PATH;
  if (fromEnv && fromEnv.length > 0) {
    return expandHome(fromEnv);
  }
  return path.join(os.homedir(), ".ralph-hero", "delegate.log");
}

function expandHome(p: string): string {
  if (p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

/**
 * Read the delegation audit log. Returns a zero-state result with
 * `fileExists: false` when the file is missing — never throws on ENOENT.
 * Lines that fail JSON.parse OR lack required fields are skipped and
 * counted in `skippedLines`; each skip emits a `console.warn` with a
 * truncated prefix of the offending line.
 */
export async function readDelegationLog(
  config: DelegationReadConfig,
): Promise<DelegationReadResult> {
  const logPath = config.logPath;

  let content: string;
  try {
    content = await fs.readFile(logPath, "utf8");
  } catch (e) {
    if (
      e &&
      typeof e === "object" &&
      "code" in e &&
      (e as { code: string }).code === "ENOENT"
    ) {
      return { events: [], skippedLines: 0, fileExists: false, logPath };
    }
    throw e;
  }

  const events: DelegationEvent[] = [];
  let skipped = 0;

  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      skipped++;
      console.warn(
        `[delegation-log] Skipping malformed line in ${logPath}: ${line.slice(0, 80)}`,
      );
      continue;
    }

    if (!isDelegationEventShape(parsed)) {
      skipped++;
      console.warn(
        `[delegation-log] Skipping line with missing required fields in ${logPath}: ${line.slice(0, 80)}`,
      );
      continue;
    }

    events.push(parsed);
  }

  return { events, skippedLines: skipped, fileExists: true, logPath };
}

/**
 * Implicit-v1 shape check: presence of `{ts, task, status, ms}` with
 * correct primitive types. A future explicit `schemaVersion >= 2` may
 * extend this gate.
 */
function isDelegationEventShape(v: unknown): v is DelegationEvent {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.ts === "string" &&
    typeof o.task === "string" &&
    typeof o.status === "string" &&
    typeof o.ms === "number"
  );
}

// ---------------------------------------------------------------------------
// Aggregator
// ---------------------------------------------------------------------------

/**
 * Aggregate parsed events into per-task + totals. Pure function — does
 * no I/O. Percentiles use the nearest-rank method against successful
 * (status=ok) calls only.
 */
export function aggregateDelegationStats(
  events: DelegationEvent[],
): DelegationStats {
  const byTask: Record<string, DelegationTaskStats> = {};
  const okMsByTask: Record<string, number[]> = {};

  let totalCalls = 0;
  let totalFallbacks = 0;
  let totalBytesIn = 0;
  let totalBytesOut = 0;

  for (const ev of events) {
    const task = ev.task;
    if (!byTask[task]) {
      byTask[task] = {
        calls: 0,
        fallbacks: 0,
        p50Ms: null,
        p99Ms: null,
        bytesIn: 0,
        bytesOut: 0,
        tokens: null,
      };
      okMsByTask[task] = [];
    }

    byTask[task].calls += 1;
    totalCalls += 1;

    if (isFallbackStatus(ev.status)) {
      byTask[task].fallbacks += 1;
      totalFallbacks += 1;
    }

    const bIn = typeof ev.bytes_in === "number" ? ev.bytes_in : 0;
    const bOut = typeof ev.bytes_out === "number" ? ev.bytes_out : 0;
    byTask[task].bytesIn += bIn;
    byTask[task].bytesOut += bOut;
    totalBytesIn += bIn;
    totalBytesOut += bOut;

    if (ev.status === "ok") {
      okMsByTask[task].push(ev.ms);
    }
  }

  // Compute percentiles
  for (const task of Object.keys(byTask)) {
    const samples = okMsByTask[task];
    byTask[task].p50Ms = percentile(samples, 0.5);
    byTask[task].p99Ms = percentile(samples, 0.99);
  }

  return {
    totals: {
      calls: totalCalls,
      fallbacks: totalFallbacks,
      bytesIn: totalBytesIn,
      bytesOut: totalBytesOut,
    },
    byTask,
  };
}

/**
 * A fallback is any non-`ok`, non-`dry_run` status: timeout, unreachable,
 * parse_error, http_*. `dry_run` is operator-driven and not a real
 * delegation failure, so it does not count.
 */
function isFallbackStatus(status: string): boolean {
  return status !== "ok" && status !== "dry_run";
}

/**
 * Nearest-rank percentile: `sorted[ceil(q * n) - 1]`. Returns `null`
 * when the sample is empty.
 */
function percentile(samples: number[], q: number): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil(q * sorted.length);
  // Guard the edge case q=0 (would index -1)
  const idx = Math.max(0, rank - 1);
  return sorted[idx];
}
