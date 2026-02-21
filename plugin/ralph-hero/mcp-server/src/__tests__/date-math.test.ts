import { describe, it, expect } from "vitest";
import { parseDateMath } from "../lib/date-math.js";

describe("parseDateMath", () => {
  // Fixed reference point: 2026-02-15T14:30:00Z
  const now = new Date("2026-02-15T14:30:00Z");

  it("@today returns midnight UTC of current day", () => {
    const result = parseDateMath("@today", now);
    expect(result.toISOString()).toBe("2026-02-15T00:00:00.000Z");
  });

  it("@today-7d returns 7 days before midnight UTC", () => {
    const result = parseDateMath("@today-7d", now);
    expect(result.toISOString()).toBe("2026-02-08T00:00:00.000Z");
  });

  it("@today-2w returns 14 days before midnight UTC", () => {
    const result = parseDateMath("@today-2w", now);
    expect(result.toISOString()).toBe("2026-02-01T00:00:00.000Z");
  });

  it("@today-1m returns 1 month before midnight UTC", () => {
    const result = parseDateMath("@today-1m", now);
    expect(result.toISOString()).toBe("2026-01-15T00:00:00.000Z");
  });

  it("@now returns current instant", () => {
    const result = parseDateMath("@now", now);
    expect(result.toISOString()).toBe("2026-02-15T14:30:00.000Z");
  });

  it("@now-24h returns 24 hours ago", () => {
    const result = parseDateMath("@now-24h", now);
    expect(result.toISOString()).toBe("2026-02-14T14:30:00.000Z");
  });

  it("@today+3d returns 3 days in the future", () => {
    const result = parseDateMath("@today+3d", now);
    expect(result.toISOString()).toBe("2026-02-18T00:00:00.000Z");
  });

  it("accepts absolute ISO date", () => {
    const result = parseDateMath("2026-01-15", now);
    expect(result.getUTCFullYear()).toBe(2026);
    expect(result.getUTCMonth()).toBe(0); // January
    expect(result.getUTCDate()).toBe(15);
  });

  it("accepts absolute ISO timestamp", () => {
    const result = parseDateMath("2026-01-15T12:00:00Z", now);
    expect(result.toISOString()).toBe("2026-01-15T12:00:00.000Z");
  });

  it("throws for invalid expression", () => {
    expect(() => parseDateMath("invalid", now)).toThrow(
      /Invalid date expression/,
    );
  });

  it("is case-insensitive for anchor", () => {
    const upper = parseDateMath("@TODAY-7d", now);
    const lower = parseDateMath("@today-7d", now);
    expect(upper.toISOString()).toBe(lower.toISOString());
  });

  it("is case-insensitive for unit", () => {
    const upper = parseDateMath("@today-7D", now);
    const lower = parseDateMath("@today-7d", now);
    expect(upper.toISOString()).toBe(lower.toISOString());
  });
});
