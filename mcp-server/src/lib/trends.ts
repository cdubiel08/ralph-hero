/**
 * Trend computation over a series of snapshots.
 *
 * Phase 3 (GH-1024) of the product-performance-over-time epic. Pure
 * module — no I/O. Reads `Snapshot[]` (provided by `lib/snapshots.ts`,
 * Phase 1) and emits one `TrendSeries` per tracked metric with 1d/7d/30d
 * deltas and a Unicode sparkline.
 *
 * Tracked metrics (fixed order):
 *   1. velocity
 *   2. riskScore
 *   3. wipTotal           (derived: sum of wipByPhase)
 *   4. leadTimeP50Hours   (read from cycleTime.leadTimeP50Hours; null until Phase 2)
 */

import type { Snapshot } from "./snapshots.js";
import { SNAPSHOT_SCHEMA_VERSION } from "./snapshots.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TrendMetric =
  | "velocity"
  | "riskScore"
  | "wipTotal"
  | "leadTimeP50Hours";

/** One sample in a trend series. `value` may be null for missing samples. */
export interface TrendPoint {
  capturedAt: string;
  value: number | null;
}

export interface TrendSeries {
  metric: TrendMetric;
  points: TrendPoint[];
  delta1d: number | null;
  delta7d: number | null;
  delta30d: number | null;
  sparkline?: string;
}

// ---------------------------------------------------------------------------
// Sparkline alphabet (U+2581..U+2588, 8 buckets)
// ---------------------------------------------------------------------------

const SPARKLINE_ALPHABET = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;
const SPARKLINE_MIDDLE = SPARKLINE_ALPHABET[3]; // "▄"

/**
 * Render a sparkline from a series of (number | null) values using the
 * fixed alphabet `▁▂▃▄▅▆▇█`.
 *
 * Rules:
 *  - Empty input → empty string.
 *  - All-null input → empty string.
 *  - Single value or all-equal non-null values → middle bucket (`▄`)
 *    once per non-null value.
 *  - `null` values render as a single space at their position so x-axis
 *    alignment is preserved.
 *  - Bucketing: `bucket = floor((v - min) / (max - min) * 7.999)`.
 */
export function renderSparkline(values: (number | null)[]): string {
  if (values.length === 0) return "";

  const numeric = values.filter((v): v is number => v !== null);
  if (numeric.length === 0) return "";

  const min = Math.min(...numeric);
  const max = Math.max(...numeric);
  const range = max - min;

  let out = "";
  for (const v of values) {
    if (v === null) {
      out += " ";
      continue;
    }
    if (range === 0) {
      out += SPARKLINE_MIDDLE;
      continue;
    }
    const bucket = Math.floor(((v - min) / range) * 7.999);
    const clamped = Math.max(0, Math.min(7, bucket));
    out += SPARKLINE_ALPHABET[clamped];
  }
  return out;
}

// ---------------------------------------------------------------------------
// computeTrends
// ---------------------------------------------------------------------------

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const METRIC_ORDER: TrendMetric[] = [
  "velocity",
  "riskScore",
  "wipTotal",
  "leadTimeP50Hours",
];

function extractMetric(snapshot: Snapshot, metric: TrendMetric): number | null {
  switch (metric) {
    case "velocity":
      return typeof snapshot.velocity === "number" ? snapshot.velocity : null;
    case "riskScore":
      return typeof snapshot.riskScore === "number" ? snapshot.riskScore : null;
    case "wipTotal": {
      const phases = snapshot.wipByPhase;
      if (!phases || typeof phases !== "object") return null;
      let total = 0;
      let any = false;
      for (const v of Object.values(phases)) {
        if (typeof v === "number") {
          total += v;
          any = true;
        }
      }
      return any ? total : null;
    }
    case "leadTimeP50Hours": {
      const ct = snapshot.cycleTime as
        | (Snapshot["cycleTime"] & { leadTimeP50Hours?: number | null })
        | undefined;
      const v = ct?.leadTimeP50Hours;
      return typeof v === "number" ? v : null;
    }
  }
}

function findValueAtOrBefore(
  points: TrendPoint[],
  targetMs: number,
): number | null {
  for (let i = points.length - 1; i >= 0; i--) {
    const p = points[i];
    const ts = new Date(p.capturedAt).getTime();
    if (Number.isNaN(ts)) continue;
    if (ts <= targetMs && p.value !== null) {
      return p.value;
    }
  }
  return null;
}

/**
 * Compute trend series from a list of snapshots. Returns exactly four
 * series in the canonical order. Snapshots with unknown schema versions
 * are skipped (with a `console.warn`); input order is normalized to
 * ascending capturedAt before delta math.
 */
export function computeTrends(
  snapshots: Snapshot[],
  now: number,
): TrendSeries[] {
  const valid: Snapshot[] = [];
  for (const s of snapshots) {
    if (s.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
      console.warn(
        `[trends] Skipping snapshot with unknown schemaVersion=${
          (s as { schemaVersion?: unknown }).schemaVersion
        }`,
      );
      continue;
    }
    valid.push(s);
  }

  const sorted = [...valid].sort((a, b) => {
    const ta = new Date(a.capturedAt).getTime();
    const tb = new Date(b.capturedAt).getTime();
    return ta - tb;
  });

  return METRIC_ORDER.map((metric) => {
    const points: TrendPoint[] = sorted.map((s) => ({
      capturedAt: s.capturedAt,
      value: extractMetric(s, metric),
    }));

    const latest = findValueAtOrBefore(points, now);

    const delta1d = computeDelta(points, latest, now - DAY_MS);
    const delta7d = computeDelta(points, latest, now - 7 * DAY_MS);
    const delta30d = computeDelta(points, latest, now - 30 * DAY_MS);

    const sparkline = renderSparkline(points.map((p) => p.value));

    return {
      metric,
      points,
      delta1d,
      delta7d,
      delta30d,
      sparkline,
    };
  });
}

function computeDelta(
  points: TrendPoint[],
  current: number | null,
  targetMs: number,
): number | null {
  if (current === null) return null;
  const prior = findValueAtOrBefore(points, targetMs);
  if (prior === null) return null;
  return current - prior;
}
