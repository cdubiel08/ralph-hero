/**
 * Threshold defaults — single source of truth assertions.
 *
 * Every per-module DEFAULT_*_CONFIG must source its values from
 * src/lib/thresholds.ts. These tests pin the values and the wiring,
 * so changes to one constant propagate everywhere they're referenced
 * (and any drift is caught at CI time).
 */

import { describe, expect, it } from "vitest";
import {
  AGENT_BACKLOG_FALLBACK_PENALTY,
  ARCHIVE_AGE_DAYS,
  AT_RISK_THRESHOLD,
  CRITICAL_STUCK_HOURS,
  LOCK_STALE_HOURS,
  OFF_TRACK_THRESHOLD,
  ORPHAN_AGE_DAYS,
  PR_STALE_HOURS,
  RECENT_WINDOW_DAYS,
  SIMILARITY_THRESHOLD,
  STUCK_THRESHOLD_HOURS,
} from "../lib/thresholds.js";
import { DEFAULT_RANK_CONFIG } from "../lib/directions.js";
import { DEFAULT_HEALTH_CONFIG } from "../lib/dashboard.js";
import { DEFAULT_HYGIENE_CONFIG } from "../lib/hygiene.js";
import { DEFAULT_METRICS_CONFIG } from "../lib/metrics.js";

describe("thresholds — constant values", () => {
  it("LOCK_STALE_HOURS is 24", () => {
    expect(LOCK_STALE_HOURS).toBe(24);
  });

  it("PR_STALE_HOURS is 24", () => {
    expect(PR_STALE_HOURS).toBe(24);
  });

  it("STUCK_THRESHOLD_HOURS is 48", () => {
    expect(STUCK_THRESHOLD_HOURS).toBe(48);
  });

  it("CRITICAL_STUCK_HOURS is STUCK_THRESHOLD_HOURS * 2 (96)", () => {
    expect(CRITICAL_STUCK_HOURS).toBe(96);
    expect(CRITICAL_STUCK_HOURS).toBe(STUCK_THRESHOLD_HOURS * 2);
  });

  it("RECENT_WINDOW_DAYS is 7", () => {
    expect(RECENT_WINDOW_DAYS).toBe(7);
  });

  it("ARCHIVE_AGE_DAYS is 14", () => {
    expect(ARCHIVE_AGE_DAYS).toBe(14);
  });

  it("ORPHAN_AGE_DAYS is 14", () => {
    expect(ORPHAN_AGE_DAYS).toBe(14);
  });

  it("AT_RISK_THRESHOLD is 2", () => {
    expect(AT_RISK_THRESHOLD).toBe(2);
  });

  it("OFF_TRACK_THRESHOLD is 6", () => {
    expect(OFF_TRACK_THRESHOLD).toBe(6);
  });

  it("SIMILARITY_THRESHOLD is 0.8", () => {
    expect(SIMILARITY_THRESHOLD).toBe(0.8);
  });

  it("AGENT_BACKLOG_FALLBACK_PENALTY is 100", () => {
    expect(AGENT_BACKLOG_FALLBACK_PENALTY).toBe(100);
  });
});

describe("thresholds — DEFAULT_RANK_CONFIG sources from shared module", () => {
  it("stuckThresholdHours pulls from STUCK_THRESHOLD_HOURS", () => {
    expect(DEFAULT_RANK_CONFIG.stuckThresholdHours).toBe(STUCK_THRESHOLD_HOURS);
  });

  it("lockStaleHours pulls from LOCK_STALE_HOURS", () => {
    expect(DEFAULT_RANK_CONFIG.lockStaleHours).toBe(LOCK_STALE_HOURS);
  });

  it("treeRecentDoneDays pulls from RECENT_WINDOW_DAYS", () => {
    expect(DEFAULT_RANK_CONFIG.treeRecentDoneDays).toBe(RECENT_WINDOW_DAYS);
  });

  it("prStaleHours pulls from PR_STALE_HOURS", () => {
    expect(DEFAULT_RANK_CONFIG.prStaleHours).toBe(PR_STALE_HOURS);
  });
});

describe("thresholds — DEFAULT_HEALTH_CONFIG sources from shared module", () => {
  it("stuckThresholdHours pulls from STUCK_THRESHOLD_HOURS", () => {
    expect(DEFAULT_HEALTH_CONFIG.stuckThresholdHours).toBe(
      STUCK_THRESHOLD_HOURS,
    );
  });

  it("criticalStuckHours pulls from CRITICAL_STUCK_HOURS", () => {
    expect(DEFAULT_HEALTH_CONFIG.criticalStuckHours).toBe(CRITICAL_STUCK_HOURS);
  });

  it("doneWindowDays pulls from RECENT_WINDOW_DAYS", () => {
    expect(DEFAULT_HEALTH_CONFIG.doneWindowDays).toBe(RECENT_WINDOW_DAYS);
  });

  it("archiveAgeDays pulls from ARCHIVE_AGE_DAYS", () => {
    expect(DEFAULT_HEALTH_CONFIG.archiveAgeDays).toBe(ARCHIVE_AGE_DAYS);
  });
});

describe("thresholds — DEFAULT_HYGIENE_CONFIG sources from shared module", () => {
  it("archiveAgeDays pulls from ARCHIVE_AGE_DAYS", () => {
    expect(DEFAULT_HYGIENE_CONFIG.archiveAgeDays).toBe(ARCHIVE_AGE_DAYS);
  });

  it("staleDays pulls from RECENT_WINDOW_DAYS", () => {
    expect(DEFAULT_HYGIENE_CONFIG.staleDays).toBe(RECENT_WINDOW_DAYS);
  });

  it("orphanDays pulls from ORPHAN_AGE_DAYS", () => {
    expect(DEFAULT_HYGIENE_CONFIG.orphanDays).toBe(ORPHAN_AGE_DAYS);
  });

  it("similarityThreshold pulls from SIMILARITY_THRESHOLD", () => {
    expect(DEFAULT_HYGIENE_CONFIG.similarityThreshold).toBe(
      SIMILARITY_THRESHOLD,
    );
  });
});

describe("thresholds — DEFAULT_METRICS_CONFIG sources from shared module", () => {
  it("velocityWindowDays pulls from RECENT_WINDOW_DAYS", () => {
    expect(DEFAULT_METRICS_CONFIG.velocityWindowDays).toBe(RECENT_WINDOW_DAYS);
  });

  it("atRiskThreshold pulls from AT_RISK_THRESHOLD", () => {
    expect(DEFAULT_METRICS_CONFIG.atRiskThreshold).toBe(AT_RISK_THRESHOLD);
  });

  it("offTrackThreshold pulls from OFF_TRACK_THRESHOLD", () => {
    expect(DEFAULT_METRICS_CONFIG.offTrackThreshold).toBe(OFF_TRACK_THRESHOLD);
  });
});

describe("thresholds — cross-module duplication is collapsed", () => {
  it("dashboard archiveAgeDays equals hygiene archiveAgeDays (single source)", () => {
    expect(DEFAULT_HEALTH_CONFIG.archiveAgeDays).toBe(
      DEFAULT_HYGIENE_CONFIG.archiveAgeDays,
    );
  });

  it("stuckThresholdHours single-sourced across rank + health configs", () => {
    expect(DEFAULT_RANK_CONFIG.stuckThresholdHours).toBe(
      DEFAULT_HEALTH_CONFIG.stuckThresholdHours,
    );
  });

  it("staleDays / doneWindowDays / treeRecentDoneDays / velocityWindowDays share RECENT_WINDOW_DAYS", () => {
    expect(DEFAULT_HYGIENE_CONFIG.staleDays).toBe(RECENT_WINDOW_DAYS);
    expect(DEFAULT_HEALTH_CONFIG.doneWindowDays).toBe(RECENT_WINDOW_DAYS);
    expect(DEFAULT_RANK_CONFIG.treeRecentDoneDays).toBe(RECENT_WINDOW_DAYS);
    expect(DEFAULT_METRICS_CONFIG.velocityWindowDays).toBe(RECENT_WINDOW_DAYS);
  });
});
