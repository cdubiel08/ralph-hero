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
// 0b2. audience=agent Backlog fallback (GH-1154)
// ---------------------------------------------------------------------------

describe("audience=agent Backlog fallback", () => {
  it("agent audience: Backlog-only board returns the Backlog item as a direction", () => {
    const items = [
      makeItem({
        number: 1,
        workflowState: "Backlog",
        priority: "P2",
      }),
    ];
    const result = rankDirections(items, [], makeConfig({ limit: 3, audience: "agent" }));
    expect(result).toHaveLength(1);
    expect(result[0].issue?.number).toBe(1);
    expect(result[0].issue?.workflowState).toBe("Backlog");
    expect(result[0].kind).toBe("issue");
  });

  it("agent audience: null-state items also surface via the fallback", () => {
    const items = [
      makeItem({
        number: 1,
        workflowState: null,
        priority: "P2",
      }),
    ];
    const result = rankDirections(items, [], makeConfig({ limit: 3, audience: "agent" }));
    expect(result).toHaveLength(1);
    expect(result[0].issue?.number).toBe(1);
    expect(result[0].issue?.workflowState).toBeNull();
  });

  it("agent audience: mixed Backlog + actionable returns the actionable item (fallback does NOT fire)", () => {
    const items = [
      makeItem({
        number: 1,
        workflowState: "Backlog",
        priority: "P0", // even high priority Backlog must lose to any actionable item
      }),
      makeItem({
        number: 2,
        workflowState: "Ready for Plan",
        priority: "P2",
      }),
    ];
    const result = rankDirections(items, [], makeConfig({ limit: 3, audience: "agent" }));
    // Fallback only fires when the post-phase scored set is empty.
    // With #2 in Ready for Plan, scored has one entry, so #1 is filtered out.
    expect(result).toHaveLength(1);
    expect(result[0].issue?.number).toBe(2);
    expect(result[0].issue?.workflowState).toBe("Ready for Plan");
  });

  it("human audience: Backlog-only board returns no directions (fallback is agent-only)", () => {
    const items = [
      makeItem({
        number: 1,
        workflowState: "Backlog",
        priority: "P0",
      }),
    ];
    const result = rankDirections(items, [], makeConfig({ limit: 3, audience: "human" }));
    expect(result).toEqual([]);
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
    const reason = buildReason(
      "lock-stale",
      item,
      null,
      { tags: ["stalled"] },
      makeConfig(),
    );
    expect(reason).toContain("In Progress");
    expect(reason.toLowerCase()).toContain("stuck");
  });

  it("renders a tree-continue reason mentioning the issue number", () => {
    const item = makeItem({
      number: 1510,
      workflowState: "Plan in Review",
    });
    const reason = buildReason(
      "tree-continue",
      item,
      null,
      { tags: ["tree"] },
      makeConfig(),
    );
    expect(reason).toContain("#1510");
    expect(reason.toLowerCase()).toContain("tree");
  });

  it("renders a PR reason with day count", () => {
    const pr = makePR({
      number: 1520,
      reviewDecision: "REVIEW_REQUIRED",
      ageHours: 48,
    });
    const reason = buildReason(
      "pr",
      null,
      pr,
      { tags: ["needs-review"] },
      makeConfig(),
      42,
    );
    expect(reason).toContain("#1520");
    expect(reason).toContain("issue #42");
  });
});

// ---------------------------------------------------------------------------
// Direction signals shape (Phase 1 GH-975)
// ---------------------------------------------------------------------------

describe("Direction signals shape", () => {
  it("kind: 'issue' with stale tag — signals carry staleDays + threshold + tags mirror", () => {
    const items: DashboardItem[] = [
      makeItem({
        number: 1600,
        priority: "P2",
        workflowState: "Ready for Plan",
        updatedAt: new Date(NOW.getTime() - 5 * DAY_MS).toISOString(),
      }),
    ];
    const result = rankDirections(items, [], makeConfig({ limit: 1 }));
    expect(result).toHaveLength(1);
    const dir = result[0];
    expect(dir.kind).toBe("issue");
    expect(dir.signals.staleDays).toBe(5);
    expect(typeof dir.signals.staleDays).toBe("number");
    expect(dir.signals.staleThresholdDays).toBe(2); // 48h / 24
    expect(dir.signals.tags).toEqual(dir.tags);
    expect(dir.signals.tags).toContain("stale");
  });

  it("kind: 'issue' non-stale — staleDays undefined, threshold still set", () => {
    const items: DashboardItem[] = [
      makeItem({
        number: 1601,
        priority: "P1",
        workflowState: "Plan in Review",
        updatedAt: new Date(NOW.getTime() - 1 * HOUR_MS).toISOString(),
      }),
    ];
    const result = rankDirections(items, [], makeConfig({ limit: 1 }));
    const dir = result[0];
    expect(dir.kind).toBe("issue");
    expect(dir.signals.staleDays).toBeUndefined();
    expect(dir.signals.staleThresholdDays).toBe(2);
  });

  it("kind: 'lock-stale' — staleDays set, threshold matches lockStaleHours/24", () => {
    const items: DashboardItem[] = [
      makeItem({
        number: 1610,
        priority: "P2",
        workflowState: "In Progress",
        updatedAt: new Date(NOW.getTime() - 30 * HOUR_MS).toISOString(),
      }),
    ];
    const result = rankDirections(items, [], makeConfig({ limit: 1 }));
    const dir = result[0];
    expect(dir.kind).toBe("lock-stale");
    expect(dir.signals.staleDays).toBe(1); // 30h / 24 -> 1 day
    expect(dir.signals.staleThresholdDays).toBe(1); // lockStaleHours=24 / 24
  });

  it("kind: 'tree-continue' (sibling-closed branch) — parentChainNote matches sibling pattern", () => {
    const sibClosed = makeItem({
      number: 1700,
      workflowState: "Done",
      closedAt: new Date(NOW.getTime() - 2 * DAY_MS).toISOString(),
      parentNumber: 999,
      parentState: "OPEN",
    });
    const candidate = makeItem({
      number: 1620,
      priority: "P3",
      workflowState: "Plan in Review",
      parentNumber: 999,
      parentState: "OPEN",
    });
    const result = rankDirections(
      [candidate, sibClosed],
      [],
      makeConfig({ limit: 1 }),
    );
    const dir = result[0];
    expect(dir.kind).toBe("tree-continue");
    expect(dir.signals.parentChainNote).toBeDefined();
    expect(dir.signals.parentChainNote).toMatch(/sibling #\d+ closed \d+ days? ago/);
    expect(dir.signals.parentChainNote).toContain("#1700");
  });

  it("kind: 'tree-continue' (candidate-moved branch) — parentChainNote describes open siblings", () => {
    // No closed sibling -> fall through to rule (b): candidate moved
    // recently AND has open siblings.
    const openSibling = makeItem({
      number: 1701,
      workflowState: "Plan in Review",
      parentNumber: 999,
      parentState: "OPEN",
      closedAt: null,
    });
    const candidate = makeItem({
      number: 1630,
      priority: "P3",
      workflowState: "Plan in Review",
      parentNumber: 999,
      parentState: "OPEN",
      updatedAt: new Date(NOW.getTime() - 2 * DAY_MS).toISOString(),
    });
    const result = rankDirections(
      [candidate, openSibling],
      [],
      makeConfig({ limit: 2 }),
    );
    // candidate is the tree-continue match (openSibling is just a sibling)
    const dir = result.find((d) => d.kind === "tree-continue");
    expect(dir).toBeDefined();
    expect(dir!.signals.parentChainNote).toBeDefined();
    expect(dir!.signals.parentChainNote).toMatch(/candidate moved.*\d+ open sibling/);
  });

  it("kind: 'pr' REVIEW_REQUIRED with linked issue — signals carry prAgeDays / prReviewDecision / linkedIssueNumber", () => {
    const prs: OpenPR[] = [
      makePR({
        number: 1720,
        reviewDecision: "REVIEW_REQUIRED",
        headRefName: "feature/GH-42",
        ageHours: 36,
        createdAt: new Date(NOW.getTime() - 36 * HOUR_MS).toISOString(),
      }),
    ];
    const result = rankDirections([], prs, makeConfig({ limit: 1 }));
    const dir = result[0];
    expect(dir.kind).toBe("pr");
    expect(dir.signals.prAgeDays).toBe(1); // 36h / 24 = 1
    expect(dir.signals.prReviewDecision).toBe("REVIEW_REQUIRED");
    expect(dir.signals.linkedIssueNumber).toBe(42);
    expect(dir.signals.tags).toContain("needs-review");
  });

  it("audience='agent' with XL item — signals.estimateWeight === 60", () => {
    const items: DashboardItem[] = [
      makeItem({
        number: 1640,
        priority: "P2",
        workflowState: "Ready for Plan",
        estimate: "XL",
      }),
    ];
    const result = rankDirections(
      items,
      [],
      makeConfig({ limit: 1, audience: "agent" }),
    );
    expect(result[0].signals.estimateWeight).toBe(60);
  });

  it("audience='human' with XL item — signals.estimateWeight is undefined", () => {
    const items: DashboardItem[] = [
      makeItem({
        number: 1641,
        priority: "P2",
        workflowState: "Ready for Plan",
        estimate: "XL",
      }),
    ];
    const result = rankDirections(
      items,
      [],
      makeConfig({ limit: 1, audience: "human" }),
    );
    expect(result[0].signals.estimateWeight).toBeUndefined();
    // Also assert it round-trips through JSON.stringify as not-present
    const serialized = JSON.parse(JSON.stringify(result[0])) as {
      signals: { estimateWeight?: number };
    };
    expect("estimateWeight" in serialized.signals).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// rankDirections — tied-at-score (Phase 3 GH-975)
// ---------------------------------------------------------------------------

describe("rankDirections — tied-at-score", () => {
  it("three identically-scored P2 stale items — all signal tiedAtScore=3, ranks stable by issue number", () => {
    const stale = new Date(NOW.getTime() - 5 * DAY_MS).toISOString();
    const items: DashboardItem[] = [
      makeItem({
        number: 2000,
        priority: "P2",
        workflowState: "Ready for Plan",
        updatedAt: stale,
      }),
      makeItem({
        number: 2001,
        priority: "P2",
        workflowState: "Ready for Plan",
        updatedAt: stale,
      }),
      makeItem({
        number: 2002,
        priority: "P2",
        workflowState: "Ready for Plan",
        updatedAt: stale,
      }),
    ];
    const result = rankDirections(items, [], makeConfig({ limit: 3 }));
    expect(result).toHaveLength(3);
    expect(result[0].signals.tiedAtScore).toBe(3);
    expect(result[1].signals.tiedAtScore).toBe(3);
    expect(result[2].signals.tiedAtScore).toBe(3);
    // Stable by issue number (matches existing secondary sort).
    expect(result.map((d) => d.issue?.number)).toEqual([2000, 2001, 2002]);
  });

  it("no tie at top score — signals.tiedAtScore is undefined on rank-1", () => {
    const items: DashboardItem[] = [
      makeItem({ number: 2100, priority: "P0", workflowState: "Plan in Review" }),
      makeItem({ number: 2101, priority: "P1", workflowState: "Plan in Review" }),
      makeItem({ number: 2102, priority: "P2", workflowState: "Plan in Review" }),
    ];
    const result = rankDirections(items, [], makeConfig({ limit: 3 }));
    expect(result[0].signals.tiedAtScore).toBeUndefined();
    // Round-trip via JSON: field should be absent, not present-as-undefined
    const serialized = JSON.parse(JSON.stringify(result[0])) as {
      signals: { tiedAtScore?: number };
    };
    expect("tiedAtScore" in serialized.signals).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// rankDirections — human-needed-unblock (GH-1146 Phase 4)
// ---------------------------------------------------------------------------

describe("rankDirections — human-needed-unblock", () => {
  it("emits exactly one human-needed-unblock direction when one Human Needed issue carries an unblock signal and another does not", () => {
    const items: DashboardItem[] = [
      makeItem({
        number: 3000,
        title: "Has Unblock Request",
        workflowState: "Human Needed",
        priority: "P2",
        updatedAt: new Date(NOW.getTime() - 2 * DAY_MS).toISOString(),
      }),
      makeItem({
        number: 3001,
        title: "No Unblock Request",
        workflowState: "Human Needed",
        priority: "P2",
        updatedAt: new Date(NOW.getTime() - 2 * DAY_MS).toISOString(),
      }),
    ];
    const result = rankDirections(
      items,
      [],
      makeConfig({
        limit: 5,
        unblockSignals: {
          3000: { unblockRequestAgeDays: 2, questionCount: 3 },
        },
      }),
    );

    const unblockDirections = result.filter(
      (d) => d.kind === "human-needed-unblock",
    );
    expect(unblockDirections).toHaveLength(1);
    expect(unblockDirections[0].issue?.number).toBe(3000);
    expect(unblockDirections[0].signals.questionCount).toBe(3);
    expect(unblockDirections[0].signals.unblockRequestAgeDays).toBe(2);
    expect(unblockDirections[0].tags).toContain("unblock-requested");

    // The issue without an unblock signal should NOT surface as
    // human-needed-unblock (it might still be excluded entirely because
    // Human Needed is not an actionable phase by default).
    const direction3001 = result.find((d) => d.issue?.number === 3001);
    if (direction3001 !== undefined) {
      expect(direction3001.kind).not.toBe("human-needed-unblock");
    }
  });

  it("scores human-needed-unblock high enough to outrank lock-stale", () => {
    const items: DashboardItem[] = [
      makeItem({
        number: 3100,
        title: "Lock-stale candidate",
        workflowState: "In Progress",
        priority: "P2",
        updatedAt: new Date(NOW.getTime() - 30 * HOUR_MS).toISOString(),
      }),
      makeItem({
        number: 3101,
        title: "Human Needed unblock",
        workflowState: "Human Needed",
        priority: "P2",
        updatedAt: new Date(NOW.getTime() - 1 * DAY_MS).toISOString(),
      }),
    ];
    const result = rankDirections(
      items,
      [],
      makeConfig({
        limit: 2,
        unblockSignals: {
          3101: { unblockRequestAgeDays: 1, questionCount: 2 },
        },
      }),
    );

    expect(result[0].kind).toBe("human-needed-unblock");
    expect(result[0].issue?.number).toBe(3101);
    expect(result[1].kind).toBe("lock-stale");
  });

  it("does not surface a human-needed-unblock direction when unblockSignals is empty", () => {
    const items: DashboardItem[] = [
      makeItem({
        number: 3200,
        workflowState: "Human Needed",
        priority: "P0",
      }),
    ];
    const result = rankDirections(items, [], makeConfig({ limit: 5 }));
    expect(result.find((d) => d.kind === "human-needed-unblock")).toBeUndefined();
  });

  it("includes age + question count in signals", () => {
    const items: DashboardItem[] = [
      makeItem({
        number: 3300,
        title: "Stale unblock",
        workflowState: "Human Needed",
        priority: "P1",
      }),
    ];
    const result = rankDirections(
      items,
      [],
      makeConfig({
        limit: 3,
        unblockSignals: {
          3300: { unblockRequestAgeDays: 5, questionCount: 4 },
        },
      }),
    );

    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("human-needed-unblock");
    expect(result[0].signals.unblockRequestAgeDays).toBe(5);
    expect(result[0].signals.questionCount).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// PR filter — drop unlinkable PRs (no feature/GH-NNNN head-ref)
// ---------------------------------------------------------------------------

describe("rankDirections — unlinkable PR filter", () => {
  it("drops PRs whose headRefName does not match feature/GH-NNNN", () => {
    const items = [
      makeItem({ number: 1, workflowState: "Plan in Review", priority: "P1" }),
    ];
    // ageHours: 168 (>= PR_STALE_HOURS=24) gives PRs a non-zero stale score so
    // they reach the merged-loop filter; scorePR drops score=0 PRs before then.
    const openPRs: OpenPR[] = [
      makePR({ number: 100, headRefName: "feature/GH-1", ageHours: 168 }),       // linked → keep
      makePR({ number: 101, headRefName: "feature/GH-2", ageHours: 168 }),       // linked → keep
      makePR({ number: 102, headRefName: "dependabot/pip/idna-3.8", ageHours: 168 }), // unlinked → drop
    ];
    const result = rankDirections(items, openPRs, makeConfig({ limit: 10 }));

    const prDirections = result.filter((d) => d.kind === "pr");
    expect(prDirections).toHaveLength(2);
    const prNumbers = prDirections.map((d) => d.pr?.number).sort();
    expect(prNumbers).toEqual([100, 101]);
  });

  it("returns empty PR slice when every PR is unlinkable", () => {
    // ageHours: 168 (>= PR_STALE_HOURS=24) gives PRs a non-zero stale score so
    // they reach the merged-loop filter; scorePR drops score=0 PRs before then.
    const openPRs: OpenPR[] = [
      makePR({ number: 200, headRefName: "dependabot/pip/idna-3.8", ageHours: 168 }),
      makePR({ number: 201, headRefName: "dependabot/npm/typescript-5.6", ageHours: 168 }),
    ];
    const result = rankDirections([], openPRs, makeConfig({ limit: 10 }));
    const prDirections = result.filter((d) => d.kind === "pr");
    expect(prDirections).toHaveLength(0);
  });
});
