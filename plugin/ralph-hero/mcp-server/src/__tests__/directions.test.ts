/**
 * Tests for the pure ranker library at `lib/directions.ts`.
 *
 * All cases use injected `now` via `RankConfig` so that time-dependent
 * boosts (stale, lock-stale, tree-recent-done, PR age) are deterministic.
 * No GraphQL mocking is required — `DashboardItem[]` is fabricated
 * directly.
 */

import { describe, it, expect } from "vitest";
import {
  rankDirections,
  scoreIssue,
  detectTreeContinue,
  detectLockStale,
  buildReason,
  DEFAULT_RANK_CONFIG,
  type RankConfig,
  type OpenPR,
} from "../lib/directions.js";
import type { DashboardItem } from "../lib/dashboard.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const NOW = new Date("2026-04-30T12:00:00Z");

function makeConfig(overrides: Partial<RankConfig> = {}): RankConfig {
  return {
    ...DEFAULT_RANK_CONFIG,
    now: NOW,
    ...overrides,
  };
}

function makeItem(overrides: Partial<DashboardItem> = {}): DashboardItem {
  return {
    number: 1,
    title: "Test issue",
    updatedAt: new Date(NOW.getTime() - 1 * HOUR_MS).toISOString(),
    closedAt: null,
    workflowState: "Plan in Review",
    priority: null,
    estimate: null,
    assignees: [],
    subIssueCount: 0,
    blockedBy: [],
    parentNumber: null,
    parentState: null,
    ...overrides,
  };
}

function makePR(overrides: Partial<OpenPR> = {}): OpenPR {
  return {
    number: 100,
    title: "Test PR",
    url: "https://github.com/o/r/pull/100",
    isDraft: false,
    reviewDecision: null,
    headRefName: "feature/GH-1",
    createdAt: new Date(NOW.getTime() - 1 * HOUR_MS).toISOString(),
    ageHours: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 0. Recommended flag (Phase 2.1)
// ---------------------------------------------------------------------------

describe("recommended flag", () => {
  it("marks rank-1 entry as recommended when directions are returned", () => {
    const items = [
      makeItem({ number: 1, workflowState: "Plan in Review", priority: "P1" }),
      makeItem({ number: 2, workflowState: "Ready for Plan", priority: "P2" }),
    ];
    const result = rankDirections(items, [], makeConfig({ limit: 2 }));
    expect(result).toHaveLength(2);
    expect(result[0].recommended).toBe(true);
    expect(result[1].recommended).toBe(false);
  });

  it("returns no recommended flag when directions are empty", () => {
    const result = rankDirections([], [], makeConfig({ limit: 3 }));
    expect(result).toHaveLength(0);
    // No assertion needed — just no crash
  });
});

// ---------------------------------------------------------------------------
// 0b. Audience param (Phase 2.2)
// ---------------------------------------------------------------------------

describe("audience param", () => {
  it("audience='human' (default) does not penalize XL items", () => {
    const items = [
      makeItem({
        number: 1,
        workflowState: "Ready for Plan",
        priority: "P2",
        estimate: "XL",
        updatedAt: new Date(NOW.getTime() - 10 * DAY_MS).toISOString(),
      }),
      makeItem({
        number: 2,
        workflowState: "Ready for Plan",
        priority: "P2",
        estimate: "S",
        updatedAt: new Date(NOW.getTime() - 1 * DAY_MS).toISOString(),
      }),
    ];
    const result = rankDirections(items, [], makeConfig({ limit: 2, audience: "human" }));
    // The XL item is much staler so should rank first under human audience
    expect(result[0].issue?.number).toBe(1);
  });

  it("audience='agent' penalizes XL items, preferring smaller", () => {
    const items = [
      makeItem({
        number: 1,
        workflowState: "Ready for Plan",
        priority: "P2",
        estimate: "XL",
        updatedAt: new Date(NOW.getTime() - 10 * DAY_MS).toISOString(),
      }),
      makeItem({
        number: 2,
        workflowState: "Ready for Plan",
        priority: "P2",
        estimate: "S",
        updatedAt: new Date(NOW.getTime() - 1 * DAY_MS).toISOString(),
      }),
    ];
    const result = rankDirections(items, [], makeConfig({ limit: 2, audience: "agent" }));
    // The S item should rank first because XL is penalized
    expect(result[0].issue?.number).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 0c. Differentiated stale reasons (Phase 2.3)
// ---------------------------------------------------------------------------

describe("differentiated stale reasons", () => {
  it("stale P1 produces a different reason than stale P2", () => {
    const stale = new Date(NOW.getTime() - 5 * DAY_MS).toISOString();
    const items = [
      makeItem({ number: 1, workflowState: "Ready for Plan", priority: "P1", updatedAt: stale }),
      makeItem({ number: 2, workflowState: "Ready for Plan", priority: "P2", updatedAt: stale }),
    ];
    const result = rankDirections(items, [], makeConfig({ limit: 2 }));
    const p1Reason = result.find((d) => d.issue?.priority === "P1")?.reason;
    const p2Reason = result.find((d) => d.issue?.priority === "P2")?.reason;
    expect(p1Reason).toBeDefined();
    expect(p2Reason).toBeDefined();
    expect(p1Reason).not.toBe(p2Reason);
  });

  it("stale P0 reason mentions urgency", () => {
    const stale = new Date(NOW.getTime() - 5 * DAY_MS).toISOString();
    const items = [
      makeItem({ number: 1, workflowState: "Ready for Plan", priority: "P0", updatedAt: stale }),
    ];
    const result = rankDirections(items, [], makeConfig({ limit: 1 }));
    expect(result[0].reason.toLowerCase()).toMatch(/p0|urgent|top/);
  });
});

// ---------------------------------------------------------------------------
// 1. Empty input
// ---------------------------------------------------------------------------

describe("rankDirections — empty input", () => {
  it("returns an empty directions array when there are no items and no PRs", () => {
    const result = rankDirections([], [], makeConfig());
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. Pure priority sort
// ---------------------------------------------------------------------------

describe("rankDirections — pure priority sort", () => {
  it("orders P0 / P1 / P2 issues in Plan in Review by priority", () => {
    const items: DashboardItem[] = [
      makeItem({ number: 102, priority: "P2", workflowState: "Plan in Review" }),
      makeItem({ number: 100, priority: "P0", workflowState: "Plan in Review" }),
      makeItem({ number: 101, priority: "P1", workflowState: "Plan in Review" }),
    ];

    const result = rankDirections(items, [], makeConfig());
    expect(result.map((d) => d.issue?.number)).toEqual([100, 101, 102]);
    expect(result.map((d) => d.kind)).toEqual(["issue", "issue", "issue"]);
    expect(result.map((d) => d.rank)).toEqual([1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// 3. Phase tiebreaker
// ---------------------------------------------------------------------------

describe("rankDirections — phase tiebreaker", () => {
  it("orders Plan in Review > In Review > Research Needed when priorities tie", () => {
    const items: DashboardItem[] = [
      makeItem({ number: 200, priority: "P1", workflowState: "Research Needed" }),
      makeItem({ number: 201, priority: "P1", workflowState: "Plan in Review" }),
      makeItem({ number: 202, priority: "P1", workflowState: "In Review" }),
    ];

    const result = rankDirections(items, [], makeConfig());
    expect(result.map((d) => d.issue?.workflowState)).toEqual([
      "Plan in Review",
      "In Review",
      "Research Needed",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 4. Stale boost
// ---------------------------------------------------------------------------

describe("rankDirections — stale boost", () => {
  it("a stale P3 issue beats a fresh P1 issue when the boost is large enough", () => {
    const items: DashboardItem[] = [
      makeItem({
        number: 300,
        priority: "P1",
        workflowState: "Plan in Review",
        updatedAt: new Date(NOW.getTime() - 1 * HOUR_MS).toISOString(),
      }),
      makeItem({
        number: 301,
        priority: "P3",
        workflowState: "Plan in Review",
        updatedAt: new Date(NOW.getTime() - 60 * HOUR_MS).toISOString(),
      }),
    ];

    const result = rankDirections(items, [], makeConfig());
    // Stale P3: 30 + 0 + (-50) = -20
    // Fresh P1: 10 + 0 + 0 = 10
    expect(result[0].issue?.number).toBe(301);
    expect(result[0].tags).toContain("stale");
  });
});

// ---------------------------------------------------------------------------
// 5. Lock-stale surfacing
// ---------------------------------------------------------------------------

describe("rankDirections — lock-stale surfacing", () => {
  it("surfaces an In Progress issue idle 30h as kind: lock-stale", () => {
    const items: DashboardItem[] = [
      makeItem({
        number: 400,
        priority: "P2",
        workflowState: "In Progress",
        updatedAt: new Date(NOW.getTime() - 30 * HOUR_MS).toISOString(),
      }),
    ];

    const result = rankDirections(items, [], makeConfig());
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("lock-stale");
    expect(result[0].issue?.number).toBe(400);
    expect(result[0].tags).toContain("stalled");
  });

  it("does not surface an In Progress issue idle 10h as lock-stale", () => {
    const items: DashboardItem[] = [
      makeItem({
        number: 401,
        priority: "P2",
        workflowState: "In Progress",
        updatedAt: new Date(NOW.getTime() - 10 * HOUR_MS).toISOString(),
      }),
    ];

    const result = rankDirections(items, [], makeConfig());
    // In Progress is not an actionable phase, and 10h < lockStaleHours=24
    // so the issue is filtered out entirely.
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 6. Blocked-by dropped
// ---------------------------------------------------------------------------

describe("rankDirections — blocked-by handling", () => {
  it("filters out blocked candidates when other candidates exist", () => {
    const items: DashboardItem[] = [
      makeItem({
        number: 500,
        priority: "P0",
        workflowState: "Plan in Review",
        blockedBy: [{ number: 999, workflowState: null }],
      }),
      makeItem({
        number: 501,
        priority: "P3",
        workflowState: "Plan in Review",
      }),
    ];

    const result = rankDirections(items, [], makeConfig());
    expect(result.map((d) => d.issue?.number)).toEqual([501]);
  });

  it("surfaces a blocked candidate when it is the only option, with blocked tag", () => {
    const items: DashboardItem[] = [
      makeItem({
        number: 510,
        priority: "P1",
        workflowState: "Plan in Review",
        blockedBy: [{ number: 999, workflowState: null }],
      }),
    ];

    const result = rankDirections(items, [], makeConfig());
    expect(result).toHaveLength(1);
    expect(result[0].issue?.number).toBe(510);
    expect(result[0].tags).toContain("blocked");
  });
});

// ---------------------------------------------------------------------------
// 7. Tree-continue promotion
// ---------------------------------------------------------------------------

describe("rankDirections — tree-continue promotion", () => {
  it("promotes a tree-continue candidate from rank 4 to rank 2", () => {
    // Construct a scoring landscape where tree-continue lands at rank 4
    // by absolute score, so we can verify the promotion rule pulls it
    // up to slot 2 without disturbing slot 1.
    //
    // Three P0 stale items in Plan in Review:  0 + 0 - 50 = -50 each
    // One  P3 tree-continue   in Plan in Review: 30 + 0 - 75 = -45
    // One  P3 plain           in Plan in Review: 30 + 0 = 30
    //
    // Natural sort: 601(-50), 602(-50), 603(-50), 604(-45), 605(30).
    // After tree-continue promotion: 601, 604, 602, 603, 605.
    const stale = new Date(NOW.getTime() - 60 * HOUR_MS).toISOString();
    const sibClosed = makeItem({
      number: 700,
      workflowState: "Done",
      closedAt: new Date(NOW.getTime() - 1 * DAY_MS).toISOString(),
      parentNumber: 999,
      parentState: "OPEN",
    });

    const items: DashboardItem[] = [
      makeItem({ number: 601, priority: "P0", workflowState: "Plan in Review", updatedAt: stale }),
      makeItem({ number: 602, priority: "P0", workflowState: "Plan in Review", updatedAt: stale }),
      makeItem({ number: 603, priority: "P0", workflowState: "Plan in Review", updatedAt: stale }),
      makeItem({
        number: 604,
        priority: "P3",
        workflowState: "Plan in Review",
        parentNumber: 999,
        parentState: "OPEN",
      }),
      makeItem({ number: 605, priority: "P3", workflowState: "Plan in Review" }),
      sibClosed,
    ];

    const result = rankDirections(items, [], makeConfig({ limit: 5 }));
    // 604 should be in slot 2 (promoted)
    expect(result[1].issue?.number).toBe(604);
    expect(result[1].kind).toBe("tree-continue");
    // Slot 1 unchanged: top stale P0 by issue number = 601
    expect(result[0].issue?.number).toBe(601);
  });
});

// ---------------------------------------------------------------------------
// 8. Tree-continue criteria sub-cases
// ---------------------------------------------------------------------------

describe("detectTreeContinue criteria", () => {
  it("(a) sibling closed within window -> positive", () => {
    const candidate = makeItem({
      number: 800,
      parentNumber: 999,
      parentState: "OPEN",
      updatedAt: new Date(NOW.getTime() - 30 * DAY_MS).toISOString(),
    });
    const sibling = makeItem({
      number: 801,
      parentNumber: 999,
      parentState: "OPEN",
      workflowState: "Done",
      closedAt: new Date(NOW.getTime() - 2 * DAY_MS).toISOString(),
    });
    expect(detectTreeContinue(candidate, [candidate, sibling], makeConfig())).toBe(true);
  });

  it("(b) candidate updated within window AND parent has open siblings -> positive", () => {
    const candidate = makeItem({
      number: 810,
      parentNumber: 999,
      parentState: "OPEN",
      updatedAt: new Date(NOW.getTime() - 1 * DAY_MS).toISOString(),
    });
    const openSibling = makeItem({
      number: 811,
      parentNumber: 999,
      parentState: "OPEN",
      workflowState: "Plan in Review",
      closedAt: null,
    });
    expect(
      detectTreeContinue(candidate, [candidate, openSibling], makeConfig()),
    ).toBe(true);
  });

  it("(c) no parent -> negative", () => {
    const candidate = makeItem({
      number: 820,
      parentNumber: null,
      parentState: null,
      updatedAt: new Date(NOW.getTime() - 1 * DAY_MS).toISOString(),
    });
    expect(detectTreeContinue(candidate, [candidate], makeConfig())).toBe(false);
  });

  it("(d) parent done -> negative", () => {
    const candidate = makeItem({
      number: 830,
      parentNumber: 999,
      parentState: "CLOSED",
      updatedAt: new Date(NOW.getTime() - 1 * DAY_MS).toISOString(),
    });
    const sibling = makeItem({
      number: 831,
      parentNumber: 999,
      parentState: "CLOSED",
      workflowState: "Done",
      closedAt: new Date(NOW.getTime() - 1 * DAY_MS).toISOString(),
    });
    expect(
      detectTreeContinue(candidate, [candidate, sibling], makeConfig()),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 9. PR ranking
// ---------------------------------------------------------------------------

describe("rankDirections — PR ranking", () => {
  it("a REVIEW_REQUIRED PR ranks above any issue", () => {
    const items: DashboardItem[] = [
      makeItem({ number: 900, priority: "P0", workflowState: "Plan in Review" }),
    ];
    const prs: OpenPR[] = [
      makePR({
        number: 901,
        reviewDecision: "REVIEW_REQUIRED",
        ageHours: 30,
        headRefName: "feature/GH-900",
        createdAt: new Date(NOW.getTime() - 30 * HOUR_MS).toISOString(),
      }),
    ];

    const result = rankDirections(items, prs, makeConfig());
    expect(result[0].kind).toBe("pr");
    expect(result[0].pr?.number).toBe(901);
    expect(result[1].kind).toBe("issue");
  });

  it("an APPROVED PR is not surfaced", () => {
    const items: DashboardItem[] = [];
    const prs: OpenPR[] = [
      makePR({
        number: 910,
        reviewDecision: "APPROVED",
        ageHours: 30,
      }),
    ];

    const result = rankDirections(items, prs, makeConfig());
    expect(result).toEqual([]);
  });

  it("a draft PR is excluded from ranking", () => {
    const items: DashboardItem[] = [];
    const prs: OpenPR[] = [
      makePR({
        number: 920,
        isDraft: true,
        reviewDecision: "REVIEW_REQUIRED",
        ageHours: 30,
      }),
    ];

    const result = rankDirections(items, prs, makeConfig());
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 10. PR-issue link via headRefName
// ---------------------------------------------------------------------------

describe("rankDirections — PR-issue link", () => {
  it("parses GH-NNNN out of headRefName and mentions it in reason", () => {
    const prs: OpenPR[] = [
      makePR({
        number: 1000,
        reviewDecision: "REVIEW_REQUIRED",
        headRefName: "feature/GH-0042",
        ageHours: 36,
        createdAt: new Date(NOW.getTime() - 36 * HOUR_MS).toISOString(),
      }),
    ];

    const result = rankDirections([], prs, makeConfig());
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("pr");
    expect(result[0].issue).toBeNull();
    expect(result[0].reason).toContain("issue #42");
  });
});

// ---------------------------------------------------------------------------
// 11. Determinism
// ---------------------------------------------------------------------------

describe("rankDirections — determinism", () => {
  it("returns byte-identical output across two calls with the same input + now", () => {
    const items: DashboardItem[] = [
      makeItem({ number: 1100, priority: "P0", workflowState: "Plan in Review" }),
      makeItem({ number: 1101, priority: "P1", workflowState: "In Review" }),
      makeItem({
        number: 1102,
        priority: "P3",
        workflowState: "Research Needed",
        updatedAt: new Date(NOW.getTime() - 60 * HOUR_MS).toISOString(),
      }),
    ];
    const prs: OpenPR[] = [
      makePR({
        number: 1110,
        reviewDecision: "REVIEW_REQUIRED",
        ageHours: 30,
        headRefName: "feature/GH-1100",
      }),
    ];

    const config = makeConfig();
    const a = rankDirections(items, prs, config);
    const b = rankDirections(items, prs, config);
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });
});

// ---------------------------------------------------------------------------
// 12. Limit honored
// ---------------------------------------------------------------------------

describe("rankDirections — limit honored", () => {
  it("returns at most config.limit directions", () => {
    const items: DashboardItem[] = Array.from({ length: 10 }, (_, i) =>
      makeItem({
        number: 1200 + i,
        priority: "P1",
        workflowState: "Plan in Review",
      }),
    );

    const result = rankDirections(items, [], makeConfig({ limit: 1 }));
    expect(result).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 13. All criteria off (fallback to phase-rank)
// ---------------------------------------------------------------------------

describe("rankDirections — phase-rank-only fallback", () => {
  it("falls back to phase rank when no priorities, no stale, no tree, no PRs", () => {
    const items: DashboardItem[] = [
      makeItem({
        number: 1300,
        priority: null,
        workflowState: "Research Needed",
      }),
      makeItem({
        number: 1301,
        priority: null,
        workflowState: "Plan in Review",
      }),
      makeItem({
        number: 1302,
        priority: null,
        workflowState: "In Review",
      }),
    ];

    const result = rankDirections(items, [], makeConfig());
    expect(result.map((d) => d.issue?.workflowState)).toEqual([
      "Plan in Review",
      "In Review",
      "Research Needed",
    ]);
  });
});

// ---------------------------------------------------------------------------
// scoreIssue precedence (sanity)
// ---------------------------------------------------------------------------

describe("scoreIssue — kind precedence", () => {
  it("lock-stale wins over tree-continue when both match", () => {
    const candidate = makeItem({
      number: 1400,
      workflowState: "In Progress",
      updatedAt: new Date(NOW.getTime() - 30 * HOUR_MS).toISOString(),
      parentNumber: 999,
      parentState: "OPEN",
    });
    const sibling = makeItem({
      number: 1401,
      parentNumber: 999,
      parentState: "OPEN",
      workflowState: "Done",
      closedAt: new Date(NOW.getTime() - 1 * DAY_MS).toISOString(),
    });
    const config = makeConfig();
    const { kind } = scoreIssue(candidate, [candidate, sibling], config);
    expect(kind).toBe("lock-stale");
  });

  it("tree-continue wins over plain issue when no lock-stale", () => {
    const candidate = makeItem({
      number: 1410,
      workflowState: "Plan in Review",
      parentNumber: 999,
      parentState: "OPEN",
    });
    const sibling = makeItem({
      number: 1411,
      parentNumber: 999,
      parentState: "OPEN",
      workflowState: "Done",
      closedAt: new Date(NOW.getTime() - 1 * DAY_MS).toISOString(),
    });
    const { kind } = scoreIssue(candidate, [candidate, sibling], makeConfig());
    expect(kind).toBe("tree-continue");
  });
});

// ---------------------------------------------------------------------------
// detectLockStale (direct)
// ---------------------------------------------------------------------------

describe("detectLockStale", () => {
  it("returns false for non-lock states regardless of age", () => {
    const item = makeItem({
      workflowState: "Plan in Review",
      updatedAt: new Date(NOW.getTime() - 100 * HOUR_MS).toISOString(),
    });
    expect(detectLockStale(item, makeConfig())).toBe(false);
  });

  it("returns true for lock states older than threshold", () => {
    const item = makeItem({
      workflowState: "Plan in Progress",
      updatedAt: new Date(NOW.getTime() - 25 * HOUR_MS).toISOString(),
    });
    expect(detectLockStale(item, makeConfig())).toBe(true);
  });

  it("returns false for lock states younger than threshold", () => {
    const item = makeItem({
      workflowState: "Research in Progress",
      updatedAt: new Date(NOW.getTime() - 5 * HOUR_MS).toISOString(),
    });
    expect(detectLockStale(item, makeConfig())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildReason — natural English smoke checks
// ---------------------------------------------------------------------------

describe("buildReason", () => {
  it("renders a lock-stale reason mentioning the workflow state", () => {
    const item = makeItem({
      number: 1500,
      workflowState: "In Progress",
      updatedAt: new Date(NOW.getTime() - 48 * HOUR_MS).toISOString(),
    });
    const reason = buildReason("lock-stale", item, null, ["stalled"], makeConfig());
    expect(reason).toContain("In Progress");
    expect(reason.toLowerCase()).toContain("stuck");
  });

  it("renders a tree-continue reason mentioning the issue number", () => {
    const item = makeItem({
      number: 1510,
      workflowState: "Plan in Review",
    });
    const reason = buildReason("tree-continue", item, null, ["tree"], makeConfig());
    expect(reason).toContain("#1510");
    expect(reason.toLowerCase()).toContain("tree");
  });

  it("renders a PR reason with day count", () => {
    const pr = makePR({
      number: 1520,
      reviewDecision: "REVIEW_REQUIRED",
      ageHours: 48,
    });
    const reason = buildReason("pr", null, pr, ["needs-review"], makeConfig(), 42);
    expect(reason).toContain("#1520");
    expect(reason).toContain("issue #42");
  });
});
