/**
 * Tests for the pure delegation-log read library at `lib/delegation-log.ts`.
 *
 * The library reads the JSONL audit log produced by `ralph-delegate.sh`
 * (default path: `~/.ralph-hero/delegate.log`). Tests use a temp file and
 * the `__setDelegateLogPath` test hook to point at it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  readDelegationLog,
  aggregateDelegationStats,
  __setDelegateLogPath,
  defaultDelegationLogPath,
  type DelegationEvent,
} from "../lib/delegation-log.js";

let tmpDir: string;
let logPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "delegation-log-test-"));
  logPath = path.join(tmpDir, "delegate.log");
  __setDelegateLogPath(logPath);
});

afterEach(() => {
  __setDelegateLogPath(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeLog(events: object[]): void {
  fs.writeFileSync(logPath, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

describe("readDelegationLog — missing file", () => {
  it("returns empty result with fileExists=false when file does not exist", async () => {
    const result = await readDelegationLog({ logPath });
    expect(result.events).toEqual([]);
    expect(result.skippedLines).toBe(0);
    expect(result.fileExists).toBe(false);
    expect(result.logPath).toBe(logPath);
  });

  it("does not throw when file is missing", async () => {
    await expect(readDelegationLog({ logPath })).resolves.toBeDefined();
  });
});

describe("readDelegationLog — empty file", () => {
  it("returns empty events but fileExists=true", async () => {
    fs.writeFileSync(logPath, "");
    const result = await readDelegationLog({ logPath });
    expect(result.events).toEqual([]);
    expect(result.skippedLines).toBe(0);
    expect(result.fileExists).toBe(true);
  });
});

describe("readDelegationLog — populated file", () => {
  it("reads a single well-formed line", async () => {
    writeLog([
      {
        ts: "2026-05-12T08:00:00Z",
        task: "locator",
        model: "gemma-4",
        url: "http://localhost:8000",
        ms: 250,
        status: "ok",
        bytes_in: 100,
        bytes_out: 50,
        caller: "test-skill",
      },
    ]);
    const result = await readDelegationLog({ logPath });
    expect(result.events).toHaveLength(1);
    expect(result.events[0].task).toBe("locator");
    expect(result.events[0].status).toBe("ok");
    expect(result.events[0].ms).toBe(250);
    expect(result.skippedLines).toBe(0);
    expect(result.fileExists).toBe(true);
  });

  it("reads mixed statuses (ok, timeout, unreachable)", async () => {
    writeLog([
      { ts: "2026-05-12T08:00:00Z", task: "locator", ms: 100, status: "ok", bytes_in: 50, bytes_out: 30 },
      { ts: "2026-05-12T08:01:00Z", task: "locator", ms: 5000, status: "timeout", bytes_in: 50, bytes_out: 0 },
      { ts: "2026-05-12T08:02:00Z", task: "summarize", ms: 0, status: "unreachable", bytes_in: 30, bytes_out: 0 },
    ]);
    const result = await readDelegationLog({ logPath });
    expect(result.events).toHaveLength(3);
    expect(result.skippedLines).toBe(0);
  });
});

describe("readDelegationLog — error tolerance", () => {
  it("skips lines that fail JSON.parse and counts them", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    fs.writeFileSync(
      logPath,
      [
        '{"ts":"2026-05-12T08:00:00Z","task":"locator","status":"ok","ms":100}',
        "not json at all",
        '{"ts":"2026-05-12T08:01:00Z","task":"locator","status":"ok","ms":120}',
      ].join("\n") + "\n",
    );
    const result = await readDelegationLog({ logPath });
    expect(result.events).toHaveLength(2);
    expect(result.skippedLines).toBe(1);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("skips lines missing required fields {ts, task, status, ms}", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    fs.writeFileSync(
      logPath,
      [
        '{"ts":"2026-05-12T08:00:00Z","task":"locator","status":"ok","ms":100}',
        '{"foo":"bar"}',
        '{"ts":"2026-05-12T08:01:00Z","task":"locator","status":"ok"}',
        '{"ts":"2026-05-12T08:02:00Z","status":"ok","ms":120}',
      ].join("\n") + "\n",
    );
    const result = await readDelegationLog({ logPath });
    expect(result.events).toHaveLength(1);
    expect(result.skippedLines).toBe(3);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("ignores blank lines without counting them as skipped", async () => {
    fs.writeFileSync(
      logPath,
      [
        '{"ts":"2026-05-12T08:00:00Z","task":"locator","status":"ok","ms":100}',
        "",
        "  ",
        '{"ts":"2026-05-12T08:01:00Z","task":"locator","status":"ok","ms":120}',
      ].join("\n") + "\n",
    );
    const result = await readDelegationLog({ logPath });
    expect(result.events).toHaveLength(2);
    expect(result.skippedLines).toBe(0);
  });
});

describe("aggregateDelegationStats — empty", () => {
  it("returns zero-state for empty events list", () => {
    const stats = aggregateDelegationStats([]);
    expect(stats.totals).toEqual({
      calls: 0,
      fallbacks: 0,
      bytesIn: 0,
      bytesOut: 0,
    });
    expect(stats.byTask).toEqual({});
  });
});

describe("aggregateDelegationStats — single event", () => {
  it("aggregates one ok event correctly", () => {
    const events: DelegationEvent[] = [
      {
        ts: "2026-05-12T08:00:00Z",
        task: "locator",
        status: "ok",
        ms: 100,
        bytes_in: 50,
        bytes_out: 30,
      } as DelegationEvent,
    ];
    const stats = aggregateDelegationStats(events);
    expect(stats.totals.calls).toBe(1);
    expect(stats.totals.fallbacks).toBe(0);
    expect(stats.totals.bytesIn).toBe(50);
    expect(stats.totals.bytesOut).toBe(30);
    expect(stats.byTask.locator).toEqual({
      calls: 1,
      fallbacks: 0,
      p50Ms: 100,
      p99Ms: 100,
      bytesIn: 50,
      bytesOut: 30,
      tokens: null,
    });
  });
});

describe("aggregateDelegationStats — fallbacks counting", () => {
  it("counts non-ok, non-dry_run statuses as fallbacks", () => {
    const events: DelegationEvent[] = [
      { ts: "t1", task: "locator", status: "ok", ms: 100 } as DelegationEvent,
      { ts: "t2", task: "locator", status: "timeout", ms: 5000 } as DelegationEvent,
      { ts: "t3", task: "locator", status: "unreachable", ms: 0 } as DelegationEvent,
      { ts: "t4", task: "locator", status: "parse_error", ms: 200 } as DelegationEvent,
      { ts: "t5", task: "locator", status: "http_500", ms: 300 } as DelegationEvent,
      { ts: "t6", task: "locator", status: "dry_run", ms: 0 } as DelegationEvent,
    ];
    const stats = aggregateDelegationStats(events);
    expect(stats.totals.calls).toBe(6);
    expect(stats.totals.fallbacks).toBe(4);
    expect(stats.byTask.locator.calls).toBe(6);
    expect(stats.byTask.locator.fallbacks).toBe(4);
  });
});

describe("aggregateDelegationStats — percentiles", () => {
  it("p50/p99 of 1 sample equals the sample", () => {
    const events: DelegationEvent[] = [
      { ts: "t1", task: "x", status: "ok", ms: 100 } as DelegationEvent,
    ];
    const stats = aggregateDelegationStats(events);
    expect(stats.byTask.x.p50Ms).toBe(100);
    expect(stats.byTask.x.p99Ms).toBe(100);
  });

  it("p50/p99 of 2 samples uses nearest-rank method", () => {
    const events: DelegationEvent[] = [
      { ts: "t1", task: "x", status: "ok", ms: 100 } as DelegationEvent,
      { ts: "t2", task: "x", status: "ok", ms: 200 } as DelegationEvent,
    ];
    const stats = aggregateDelegationStats(events);
    // sorted: [100, 200]; p50 = sorted[ceil(0.5*2)-1] = sorted[0] = 100
    // p99 = sorted[ceil(0.99*2)-1] = sorted[1] = 200
    expect(stats.byTask.x.p50Ms).toBe(100);
    expect(stats.byTask.x.p99Ms).toBe(200);
  });

  it("p50/p99 of 3 samples", () => {
    const events: DelegationEvent[] = [
      { ts: "t1", task: "x", status: "ok", ms: 100 } as DelegationEvent,
      { ts: "t2", task: "x", status: "ok", ms: 200 } as DelegationEvent,
      { ts: "t3", task: "x", status: "ok", ms: 300 } as DelegationEvent,
    ];
    const stats = aggregateDelegationStats(events);
    // sorted: [100, 200, 300]; p50 = sorted[ceil(1.5)-1] = sorted[1] = 200
    // p99 = sorted[ceil(2.97)-1] = sorted[2] = 300
    expect(stats.byTask.x.p50Ms).toBe(200);
    expect(stats.byTask.x.p99Ms).toBe(300);
  });

  it("p50/p99 of 100 samples", () => {
    const events: DelegationEvent[] = [];
    for (let i = 1; i <= 100; i++) {
      events.push({ ts: `t${i}`, task: "x", status: "ok", ms: i } as DelegationEvent);
    }
    const stats = aggregateDelegationStats(events);
    // sorted: [1..100]; p50 = sorted[ceil(50)-1] = sorted[49] = 50
    // p99 = sorted[ceil(99)-1] = sorted[98] = 99
    expect(stats.byTask.x.p50Ms).toBe(50);
    expect(stats.byTask.x.p99Ms).toBe(99);
  });

  it("percentiles only include successful (ok) calls", () => {
    const events: DelegationEvent[] = [
      { ts: "t1", task: "x", status: "ok", ms: 100 } as DelegationEvent,
      { ts: "t2", task: "x", status: "timeout", ms: 99999 } as DelegationEvent,
      { ts: "t3", task: "x", status: "ok", ms: 200 } as DelegationEvent,
    ];
    const stats = aggregateDelegationStats(events);
    // ok-only sorted: [100, 200]; p50 = 100, p99 = 200
    expect(stats.byTask.x.p50Ms).toBe(100);
    expect(stats.byTask.x.p99Ms).toBe(200);
  });

  it("returns null percentiles when no ok calls", () => {
    const events: DelegationEvent[] = [
      { ts: "t1", task: "x", status: "timeout", ms: 5000 } as DelegationEvent,
    ];
    const stats = aggregateDelegationStats(events);
    expect(stats.byTask.x.p50Ms).toBeNull();
    expect(stats.byTask.x.p99Ms).toBeNull();
  });
});

describe("aggregateDelegationStats — byte aggregation", () => {
  it("sums bytes_in / bytes_out per task and across totals", () => {
    const events: DelegationEvent[] = [
      { ts: "t1", task: "a", status: "ok", ms: 100, bytes_in: 10, bytes_out: 5 } as DelegationEvent,
      { ts: "t2", task: "a", status: "ok", ms: 100, bytes_in: 20, bytes_out: 8 } as DelegationEvent,
      { ts: "t3", task: "b", status: "ok", ms: 100, bytes_in: 30, bytes_out: 12 } as DelegationEvent,
    ];
    const stats = aggregateDelegationStats(events);
    expect(stats.byTask.a.bytesIn).toBe(30);
    expect(stats.byTask.a.bytesOut).toBe(13);
    expect(stats.byTask.b.bytesIn).toBe(30);
    expect(stats.byTask.b.bytesOut).toBe(12);
    expect(stats.totals.bytesIn).toBe(60);
    expect(stats.totals.bytesOut).toBe(25);
  });

  it("treats missing bytes_in/bytes_out as zero", () => {
    const events: DelegationEvent[] = [
      { ts: "t1", task: "a", status: "ok", ms: 100 } as DelegationEvent,
    ];
    const stats = aggregateDelegationStats(events);
    expect(stats.byTask.a.bytesIn).toBe(0);
    expect(stats.byTask.a.bytesOut).toBe(0);
  });
});

describe("aggregateDelegationStats — tokens field", () => {
  it("reports tokens: null per task (F1 audit-log does not capture token usage)", () => {
    const events: DelegationEvent[] = [
      { ts: "t1", task: "x", status: "ok", ms: 100 } as DelegationEvent,
    ];
    const stats = aggregateDelegationStats(events);
    expect(stats.byTask.x.tokens).toBeNull();
  });
});

describe("defaultDelegationLogPath", () => {
  // These tests need the override cleared so the env-var / default path
  // resolution actually runs.
  beforeEach(() => {
    __setDelegateLogPath(null);
  });

  it("respects RALPH_DELEGATE_LOG_PATH env var when set", () => {
    const original = process.env.RALPH_DELEGATE_LOG_PATH;
    process.env.RALPH_DELEGATE_LOG_PATH = "/custom/path/delegate.log";
    try {
      expect(defaultDelegationLogPath()).toBe("/custom/path/delegate.log");
    } finally {
      if (original === undefined) delete process.env.RALPH_DELEGATE_LOG_PATH;
      else process.env.RALPH_DELEGATE_LOG_PATH = original;
    }
  });

  it("expands leading ~/ to home dir", () => {
    const original = process.env.RALPH_DELEGATE_LOG_PATH;
    process.env.RALPH_DELEGATE_LOG_PATH = "~/foo/delegate.log";
    try {
      const resolved = defaultDelegationLogPath();
      expect(resolved.startsWith(os.homedir())).toBe(true);
      expect(resolved.endsWith("/foo/delegate.log")).toBe(true);
    } finally {
      if (original === undefined) delete process.env.RALPH_DELEGATE_LOG_PATH;
      else process.env.RALPH_DELEGATE_LOG_PATH = original;
    }
  });

  it("falls back to ~/.ralph-hero/delegate.log when env var unset", () => {
    const original = process.env.RALPH_DELEGATE_LOG_PATH;
    delete process.env.RALPH_DELEGATE_LOG_PATH;
    try {
      const resolved = defaultDelegationLogPath();
      expect(resolved).toBe(path.join(os.homedir(), ".ralph-hero", "delegate.log"));
    } finally {
      if (original !== undefined) process.env.RALPH_DELEGATE_LOG_PATH = original;
    }
  });
});
