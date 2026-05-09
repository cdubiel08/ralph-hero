/**
 * Direct unit tests for `lib/rate-limiter.ts`.
 *
 * Phase 3 of GH-1118 (test coverage hardening). Asserts the public surface of
 * the `RateLimiter` class:
 *   - `update()` + `getStatus()` round-trip
 *   - `checkBeforeRequest()` no-op above warning threshold
 *   - warning-zone log without sleep
 *   - critical-zone sleep capped at 60s (via fake timers)
 *   - critical-zone no-sleep when reset is in the past
 *   - custom thresholds override defaults
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RateLimiter } from "../lib/rate-limiter.js";

describe("RateLimiter.update + getStatus", () => {
  it("update() reflects new remaining and resetAt in getStatus()", () => {
    const rl = new RateLimiter();
    const resetIso = "2030-01-01T00:00:00.000Z";
    rl.update({ remaining: 4321, resetAt: resetIso, limit: 5000, cost: 1 } as any);

    const status = rl.getStatus();
    expect(status.remaining).toBe(4321);
    expect(status.resetAt).toBeInstanceOf(Date);
    expect(status.resetAt.toISOString()).toBe(resetIso);
    expect(status.isLow).toBe(false);
    expect(status.isCritical).toBe(false);
  });

  it("getStatus() flags isLow=true when remaining <= warningThreshold", () => {
    const rl = new RateLimiter();
    rl.update({ remaining: 80, resetAt: "2030-01-01T00:00:00Z" } as any);
    const status = rl.getStatus();
    expect(status.isLow).toBe(true);
    expect(status.isCritical).toBe(false);
  });

  it("getStatus() flags isCritical=true when remaining <= blockThreshold", () => {
    const rl = new RateLimiter();
    rl.update({ remaining: 30, resetAt: "2030-01-01T00:00:00Z" } as any);
    const status = rl.getStatus();
    expect(status.isLow).toBe(true);
    expect(status.isCritical).toBe(true);
  });
});

describe("RateLimiter.checkBeforeRequest — warning thresholds", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is a no-op when remaining > warningThreshold", async () => {
    const rl = new RateLimiter();
    rl.update({ remaining: 5000, resetAt: new Date(Date.now() + 60_000).toISOString() } as any);

    await rl.checkBeforeRequest();
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("logs warning but does not sleep when blockThreshold < remaining <= warningThreshold", async () => {
    const rl = new RateLimiter();
    // 75 is in [51, 100] — warning zone with defaults
    rl.update({ remaining: 75, resetAt: new Date(Date.now() + 60_000).toISOString() } as any);

    const start = Date.now();
    await rl.checkBeforeRequest();
    const elapsed = Date.now() - start;

    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0][0]).toContain("approaching threshold");
    // No sleep: should resolve essentially synchronously
    expect(elapsed).toBeLessThan(50);
  });
});

describe("RateLimiter.checkBeforeRequest — critical zone", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("sleeps (capped at 60s) when remaining <= blockThreshold and reset is in the future", async () => {
    vi.useFakeTimers();
    const now = new Date("2030-01-01T00:00:00.000Z");
    vi.setSystemTime(now);

    const rl = new RateLimiter();
    // resetAt 5 minutes (300s) in the future — should cap at 60s
    const resetAt = new Date(now.getTime() + 5 * 60_000).toISOString();
    rl.update({ remaining: 10, resetAt } as any);

    const promise = rl.checkBeforeRequest();
    let resolved = false;
    promise.then(() => {
      resolved = true;
    });

    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0][0]).toContain("critically low");

    // Advance 59s — should not yet be resolved
    await vi.advanceTimersByTimeAsync(59_000);
    expect(resolved).toBe(false);

    // Advance the remaining 1s (total 60s) — promise should resolve
    await vi.advanceTimersByTimeAsync(1_000);
    await promise;
    expect(resolved).toBe(true);
  });

  it("does not sleep when remaining <= blockThreshold but resetAt is in the past", async () => {
    const rl = new RateLimiter();
    // resetAt in the past => msUntilReset <= 0
    rl.update({ remaining: 10, resetAt: new Date(Date.now() - 60_000).toISOString() } as any);

    const start = Date.now();
    await rl.checkBeforeRequest();
    const elapsed = Date.now() - start;

    // Critical-zone branch is taken but no log is emitted (only logs when waiting)
    // and no sleep happens.
    expect(elapsed).toBeLessThan(50);
  });
});

describe("RateLimiter custom thresholds", () => {
  it("custom warningThreshold and blockThreshold override defaults", () => {
    const rl = new RateLimiter({ warningThreshold: 200, blockThreshold: 100 });

    rl.update({ remaining: 250, resetAt: "2030-01-01T00:00:00Z" } as any);
    expect(rl.getStatus().isLow).toBe(false);

    rl.update({ remaining: 150, resetAt: "2030-01-01T00:00:00Z" } as any);
    expect(rl.getStatus().isLow).toBe(true);
    expect(rl.getStatus().isCritical).toBe(false);

    rl.update({ remaining: 100, resetAt: "2030-01-01T00:00:00Z" } as any);
    expect(rl.getStatus().isCritical).toBe(true);
  });
});
