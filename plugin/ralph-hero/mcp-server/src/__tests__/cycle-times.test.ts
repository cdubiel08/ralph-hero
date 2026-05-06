/**
 * Unit tests for `lib/cycle-times.ts` — pure rollup of transition
 * records into lead-time and per-phase dwell percentiles.
 */

import { describe, expect, it } from "vitest";
import {
  rollupCycleTimes,
  type TransitionedIssue,
} from "../lib/cycle-times.js";
import type { TransitionRecord } from "../lib/transition-comments.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a TransitionRecord with sensible defaults for terse test data. */
function tr(from: string, to: string, at: string): TransitionRecord {
  return { from, to, command: `ralph_${to.toLowerCase().replace(/\s+/g, "_")}`, at };
}

/** Fixed `now` for deterministic open-ended tests. */
const NOW = Date.parse("2026-05-05T00:00:00.000Z");

// ---------------------------------------------------------------------------
// rollupCycleTimes
// ---------------------------------------------------------------------------

describe("rollupCycleTimes — empty input", () => {
  it("returns null lead-time and empty per-phase map", () => {
    const out = rollupCycleTimes([], NOW);
    expect(out.leadTimeP50Hours).toBeNull();
    expect(out.leadTimeP90Hours).toBeNull();
    expect(out.perPhaseDwellHours).toEqual({});
    expect(out.sampleSize).toBe(0);
  });
});

describe("rollupCycleTimes — single issue with two transitions", () => {
  it("computes lead-time as last - first and one dwell bucket", () => {
    const records: TransitionedIssue[] = [
      {
        issueNumber: 1,
        transitions: [
          tr("Plan in Progress", "In Progress", "2026-05-01T00:00:00.000Z"),
          tr("In Progress", "Done", "2026-05-01T05:00:00.000Z"),
        ],
        closedAt: "2026-05-01T05:00:00.000Z",
      },
    ];

    const out = rollupCycleTimes(records, NOW);
    // 5h between first and last transition.
    expect(out.leadTimeP50Hours).toBe(5);
    expect(out.leadTimeP90Hours).toBe(5);
    expect(out.sampleSize).toBe(1);

    // "In Progress" dwell is 5h between first and second transition.
    expect(out.perPhaseDwellHours["Plan in Progress"]).toEqual({
      p50: 5,
      p90: 5,
      n: 1,
    });
    // Terminal "Done" dwell uses closedAt (== last.at) → 0h.
    expect(out.perPhaseDwellHours["Done"]).toEqual({
      p50: 0,
      p90: 0,
      n: 1,
    });
  });
});

describe("rollupCycleTimes — multi-issue with mixed phase counts", () => {
  it("aggregates dwell buckets across issues and reports correct sampleSize", () => {
    const records: TransitionedIssue[] = [
      {
        // 2 transitions, 4h lead, 4h "In Progress" dwell.
        issueNumber: 1,
        transitions: [
          tr("In Progress", "In Review", "2026-05-01T00:00:00.000Z"),
          tr("In Review", "Done", "2026-05-01T04:00:00.000Z"),
        ],
        closedAt: "2026-05-01T04:00:00.000Z",
      },
      {
        // 3 transitions, 10h lead, contributes 6h "Plan in Progress" + 4h "In Progress" dwell.
        issueNumber: 2,
        transitions: [
          tr("Plan in Progress", "In Progress", "2026-05-02T00:00:00.000Z"),
          tr("In Progress", "In Review", "2026-05-02T06:00:00.000Z"),
          tr("In Review", "Done", "2026-05-02T10:00:00.000Z"),
        ],
        closedAt: "2026-05-02T10:00:00.000Z",
      },
      {
        // single transition — excluded from lead-time, contributes no dwell.
        issueNumber: 3,
        transitions: [
          tr("Backlog", "In Progress", "2026-05-03T00:00:00.000Z"),
        ],
        closedAt: null,
      },
    ];

    const out = rollupCycleTimes(records, NOW);
    expect(out.sampleSize).toBe(2); // issues 1 and 2 only

    // lead times sorted: [4, 10] -> p50 interpolates rank 0.5 = 7, p90 rank 0.9 = 4 + 6*0.9 = 9.4
    expect(out.leadTimeP50Hours).toBe(7);
    expect(out.leadTimeP90Hours).toBeCloseTo(9.4, 10);

    // "In Progress" dwell samples: [4 (issue1: in-progress→in-review N/A; actually keyed by from),
    //   for issue 1 first interval `from = In Progress`, dwell 4h
    //   for issue 2 second interval `from = In Progress`, dwell 4h
    expect(out.perPhaseDwellHours["In Progress"]).toEqual({
      p50: 4,
      p90: 4,
      n: 2,
    });
    // "In Review" dwell: issue 1 has zero records keyed In Review (only one interval), wait —
    //   issue 1 transitions: [In Progress→In Review @0, In Review→Done @4]
    //     interval keyed by from of [0]: "In Progress" — already counted above.
    //   issue 2 has [Plan in Progress→In Progress @0, In Progress→In Review @6, In Review→Done @10]
    //     interval[0] from=Plan in Progress, dwell 6h
    //     interval[1] from=In Progress, dwell 4h (counted above)
    //     terminal state: last.to = Done, closedAt set → adds 0h to "Done".
    //   issue 1 terminal "Done" with closedAt == last.at adds 0h.
    expect(out.perPhaseDwellHours["Plan in Progress"]).toEqual({
      p50: 6,
      p90: 6,
      n: 1,
    });
    // "Done" terminal dwell from issue 1 and issue 2, both 0h.
    expect(out.perPhaseDwellHours["Done"]).toEqual({
      p50: 0,
      p90: 0,
      n: 2,
    });
  });
});

describe("rollupCycleTimes — out-of-order timestamps", () => {
  it("defensively sorts before computing intervals and does not mutate input", () => {
    const t1 = tr("Plan in Progress", "In Progress", "2026-05-01T05:00:00.000Z");
    const t2 = tr("In Progress", "Done", "2026-05-01T00:00:00.000Z"); // earlier
    const original = [t1, t2];
    const records: TransitionedIssue[] = [
      { issueNumber: 1, transitions: original, closedAt: "2026-05-01T05:00:00.000Z" },
    ];

    const out = rollupCycleTimes(records, NOW);
    // After sort: t2 (00:00) → t1 (05:00) → lead = 5h.
    expect(out.leadTimeP50Hours).toBe(5);

    // Original array reference + element order preserved.
    expect(records[0].transitions).toBe(original);
    expect(records[0].transitions[0]).toBe(t1);
    expect(records[0].transitions[1]).toBe(t2);
  });
});

describe("rollupCycleTimes — malformed `at` strings", () => {
  it("skips bad rows and counts the rest", () => {
    const records: TransitionedIssue[] = [
      {
        issueNumber: 1,
        transitions: [
          tr("Plan in Progress", "In Progress", "not-a-date"),
          tr("In Progress", "In Review", "2026-05-01T00:00:00.000Z"),
          tr("In Review", "Done", "2026-05-01T03:00:00.000Z"),
        ],
        closedAt: "2026-05-01T03:00:00.000Z",
      },
    ];

    const out = rollupCycleTimes(records, NOW);
    // Two valid transitions remain → 3h lead.
    expect(out.leadTimeP50Hours).toBe(3);
    expect(out.sampleSize).toBe(1);
    // First valid interval keyed by from = "In Progress".
    expect(out.perPhaseDwellHours["In Progress"]).toEqual({ p50: 3, p90: 3, n: 1 });
  });

  it("does not throw when ALL transitions have malformed timestamps", () => {
    const records: TransitionedIssue[] = [
      {
        issueNumber: 1,
        transitions: [
          tr("a", "b", "garbage"),
          tr("b", "c", "also-garbage"),
        ],
      },
    ];
    const out = rollupCycleTimes(records, NOW);
    expect(out.sampleSize).toBe(0);
    expect(out.leadTimeP50Hours).toBeNull();
    expect(out.perPhaseDwellHours).toEqual({});
  });
});

describe("rollupCycleTimes — single-transition issues", () => {
  it("excludes from lead-time and contributes no dwell", () => {
    const records: TransitionedIssue[] = [
      {
        issueNumber: 1,
        transitions: [tr("Backlog", "In Progress", "2026-05-01T00:00:00.000Z")],
      },
    ];
    const out = rollupCycleTimes(records, NOW);
    expect(out.sampleSize).toBe(0);
    expect(out.leadTimeP50Hours).toBeNull();
    expect(out.perPhaseDwellHours).toEqual({});
  });
});

describe("rollupCycleTimes — terminal-state dwell with closedAt", () => {
  it("includes terminal dwell when closedAt is set (closedAt > last.at)", () => {
    const records: TransitionedIssue[] = [
      {
        issueNumber: 1,
        transitions: [
          tr("In Progress", "In Review", "2026-05-01T00:00:00.000Z"),
          tr("In Review", "Done", "2026-05-01T02:00:00.000Z"),
        ],
        // 3h after last transition — issue lingered in Done.
        closedAt: "2026-05-01T05:00:00.000Z",
      },
    ];
    const out = rollupCycleTimes(records, NOW);
    expect(out.perPhaseDwellHours["Done"]).toEqual({ p50: 3, p90: 3, n: 1 });
  });

  it("excludes terminal dwell when closedAt is null and issue is open", () => {
    const records: TransitionedIssue[] = [
      {
        issueNumber: 1,
        transitions: [
          tr("In Progress", "In Review", "2026-05-01T00:00:00.000Z"),
          tr("In Review", "Done", "2026-05-01T02:00:00.000Z"),
        ],
        closedAt: null,
      },
    ];
    const out = rollupCycleTimes(records, NOW);
    // First interval contributes "In Progress" → 2h.
    expect(out.perPhaseDwellHours["In Progress"]).toEqual({ p50: 2, p90: 2, n: 1 });
    // Terminal "Done" dwell excluded.
    expect(out.perPhaseDwellHours["Done"]).toBeUndefined();
  });
});

describe("rollupCycleTimes — percentile correctness", () => {
  it("computes p50 / p90 with linear interpolation over a sorted sample", () => {
    // Build 10 issues with lead times [1, 2, 3, ..., 10] hours.
    const records: TransitionedIssue[] = [];
    for (let i = 0; i < 10; i++) {
      const startHour = i * 24; // separate each issue by one day
      const endHour = startHour + (i + 1); // i+1 hour lead time
      const startMs = Date.parse("2026-05-01T00:00:00.000Z") + startHour * 3_600_000;
      const endMs = Date.parse("2026-05-01T00:00:00.000Z") + endHour * 3_600_000;
      records.push({
        issueNumber: i + 1,
        transitions: [
          tr("In Progress", "Done", new Date(startMs).toISOString()),
          tr("Done", "Closed", new Date(endMs).toISOString()),
        ],
        closedAt: new Date(endMs).toISOString(),
      });
    }

    const out = rollupCycleTimes(records, NOW);
    expect(out.sampleSize).toBe(10);

    // sorted lead-times: [1..10]. n=10, rank = p*(n-1).
    // p50: rank=4.5 → 0.5*(5)+0.5*(6)=5.5
    // p90: rank=8.1 → 0.1 between sorted[8]=9 and sorted[9]=10 → 9.1
    expect(out.leadTimeP50Hours).toBeCloseTo(5.5, 10);
    expect(out.leadTimeP90Hours).toBeCloseTo(9.1, 10);
  });
});
