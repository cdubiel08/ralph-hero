/**
 * board.approvalwait.test.ts — approval-wait metric (GH-2447, unit 5 of the
 * 2026-09-03 approval-gated-hosts design, D4).
 *
 * Wait is DERIVED from GitHub's own PR timeline (ready-for-review /
 * review-requested → an approving review's submittedAt → mergedAt), one
 * query per PR, never recorded — the honest-limits bullet: a PR approved
 * verbally and merged by hand reports `unmeasured`, never a fabricated zero.
 * `deriveApprovalWait` is pure and covers the plan's three fixtures
 * (requested → approved → merged; approved without request; merged without
 * approval); `attachApprovalWait`/`deliverQueue` prove the wiring end to end;
 * doctor's `approval-wait` line is advisory-only, same rules as its
 * GH-2398/GH-2403/GH-2347 siblings — INFO always, never strict, never fixed.
 */

import { describe, expect, it } from "vitest";
import {
  DELIVER_MARKER,
  deriveApprovalWait,
  deliverQueue,
  doctor,
  fmtHours,
  parseApprovalTimeline,
  type PrApprovalTimeline,
} from "./board.js";
import { FakeGh, makeCtx, NOW, type FakeIssue } from "./board.testkit.js";

const OLD = "2026-07-31T10:00:00Z"; // settled relative to testkit NOW (12:00Z)

const t = (over: Partial<PrApprovalTimeline> = {}): PrApprovalTimeline => ({
  readyForReviewAt: null,
  reviewRequestedAt: null,
  approvedAt: null,
  mergedAt: null,
  ...over,
});

describe("deriveApprovalWait — pure, the plan's three timeline fixtures", () => {
  it("requested → approved → merged: measured, since the request, to the approval", () => {
    const w = deriveApprovalWait(
      t({ reviewRequestedAt: "2026-07-30T10:00:00Z", approvedAt: "2026-07-30T14:00:00Z", mergedAt: "2026-07-30T15:00:00Z" }),
      NOW,
    );
    expect(w.since).toBe("2026-07-30T10:00:00Z");
    expect(w.waitHours).toBe(4);
  });

  it("approved without a request/ready event: UNMEASURED — no anchor to measure from, never zero", () => {
    const w = deriveApprovalWait(t({ approvedAt: "2026-07-30T14:00:00Z" }), NOW);
    expect(w.since).toBeNull();
    expect(w.waitHours).toBeNull();
  });

  it("merged without an approving review GitHub recorded: UNMEASURED, never a fabricated zero", () => {
    const w = deriveApprovalWait(
      t({ reviewRequestedAt: "2026-07-30T10:00:00Z", mergedAt: "2026-07-30T15:00:00Z" }),
      NOW,
    );
    expect(w.since).toBe("2026-07-30T10:00:00Z");
    expect(w.waitHours).toBeNull();
  });

  it("still open, no approval yet: elapsed to now — this is the row's `elapsed`", () => {
    const w = deriveApprovalWait(t({ reviewRequestedAt: "2026-07-31T09:00:00Z" }), NOW);
    expect(w.since).toBe("2026-07-31T09:00:00Z");
    expect(w.waitHours).toBe(3);
  });

  it("ready-for-review AND a later review-requested: the LATER one wins (a re-request restarts the clock)", () => {
    const w = deriveApprovalWait(
      t({ readyForReviewAt: "2026-07-30T08:00:00Z", reviewRequestedAt: "2026-07-30T10:00:00Z" }),
      NOW,
    );
    expect(w.since).toBe("2026-07-30T10:00:00Z");
  });

  it("an approval that PREDATES the current wait (superseded by a re-request) falls through to elapsed, not a negative", () => {
    const w = deriveApprovalWait(
      t({ reviewRequestedAt: "2026-07-31T09:00:00Z", approvedAt: "2026-07-30T10:00:00Z" }),
      NOW,
    );
    expect(w.waitHours).toBe(3); // elapsed since the re-request, not (approvedAt - since)
  });

  it("no timeline anchor at all: UNMEASURED regardless of mergedAt", () => {
    expect(deriveApprovalWait(t(), NOW)).toEqual({ since: null, waitHours: null });
    expect(deriveApprovalWait(t({ mergedAt: "2026-07-30T15:00:00Z" }), NOW)).toEqual({ since: null, waitHours: null });
  });
});

describe("parseApprovalTimeline — raw GraphQL node shape", () => {
  it("takes the LATEST event of each type and the LATEST approved review", () => {
    const parsed = parseApprovalTimeline({
      mergedAt: null,
      timelineItems: {
        nodes: [
          { __typename: "ReviewRequestedEvent", createdAt: "2026-07-30T08:00:00Z" },
          { __typename: "ReviewRequestedEvent", createdAt: "2026-07-30T10:00:00Z" }, // later — wins
          { __typename: "ReadyForReviewEvent", createdAt: "2026-07-30T07:00:00Z" },
        ],
      },
      reviews: {
        nodes: [
          { state: "CHANGES_REQUESTED", submittedAt: "2026-07-30T09:00:00Z" }, // not APPROVED — ignored
          { state: "APPROVED", submittedAt: "2026-07-30T11:00:00Z" },
        ],
      },
    });
    expect(parsed).toEqual({
      readyForReviewAt: "2026-07-30T07:00:00Z",
      reviewRequestedAt: "2026-07-30T10:00:00Z",
      approvedAt: "2026-07-30T11:00:00Z",
      mergedAt: null,
    });
  });

  it("absent connections parse as empty, not a crash", () => {
    expect(parseApprovalTimeline({})).toEqual({
      readyForReviewAt: null,
      reviewRequestedAt: null,
      approvedAt: null,
      mergedAt: null,
    });
  });
});

describe("fmtHours", () => {
  it("hours under 48, days at or past it", () => {
    expect(fmtHours(3.2)).toBe("3.2h");
    expect(fmtHours(47.9)).toBe("47.9h");
    expect(fmtHours(48)).toBe("2.0d");
    expect(fmtHours(96)).toBe("4.0d");
  });
});

/** One In Review issue with a marker already recording gate=approval,
 *  PENDING, reviewDecision REVIEW_REQUIRED — the GH-2444 shape that classifies
 *  `awaiting-approval` with zero probes (same fixture convention as the
 *  GH-2444 suite in board.test.ts, but seeded through FakeGh end to end
 *  rather than the classifyDeliver harness, so `deliverQueue`'s own
 *  attachApprovalWait wiring is what's under test). */
function seedAwaitingApproval(
  gh: FakeGh,
  opts: { approvalTimeline?: NonNullable<FakeIssue["prs"]>[number]["approvalTimeline"] } = {},
): void {
  const marker =
    `${DELIVER_MARKER}\n\`\`\`json\n` +
    JSON.stringify({
      prs: {
        "101": {
          head_sha: "sha-a",
          verdict: "PENDING",
          gate: "approval",
          check_conclusions: "",
          review_cursor: null,
          thread_cursor: null,
          at: "2026-07-31T09:00:00Z",
        },
      },
    }) +
    "\n```";
  gh.issues.set(1, {
    number: 1,
    title: "Issue 1",
    state: "In Review",
    stateUpdatedAt: OLD,
    comments: [marker],
    prs: [
      {
        number: 101,
        merged: false,
        prState: "OPEN",
        headSha: "sha-a",
        checks: [],
        reviewsAt: [],
        threadsAt: [],
        pushedAt: OLD,
        reviewDecision: "REVIEW_REQUIRED",
        approvalTimeline: opts.approvalTimeline,
      },
    ],
  });
}

describe("attachApprovalWait via deliverQueue — end to end through FakeGh", () => {
  it("an awaiting-approval row is decorated with since/waitHours from the PR's own timeline", () => {
    const gh = new FakeGh();
    seedAwaitingApproval(gh, { approvalTimeline: { reviewRequestedAt: "2026-07-31T09:00:00Z" } });
    const ctx = makeCtx(gh);
    const res = deliverQueue(ctx, undefined, null, null);
    expect(res.blocked).toMatchObject([{ number: 1, reason: "awaiting-approval", since: "2026-07-31T09:00:00Z", waitHours: 3 }]);
  });

  it("no timeline anchor: since/waitHours are null, not absent — the row still says unmeasured", () => {
    const gh = new FakeGh();
    seedAwaitingApproval(gh); // no approvalTimeline at all
    const ctx = makeCtx(gh);
    const res = deliverQueue(ctx, undefined, null, null);
    expect(res.blocked).toMatchObject([{ number: 1, reason: "awaiting-approval", since: null, waitHours: null }]);
  });

  it("a non-awaiting-approval blocked row is left undecorated (no since/waitHours keys)", () => {
    const gh = new FakeGh();
    gh.issues.set(2, { number: 2, state: "In Review", stateUpdatedAt: OLD }); // no-pr
    const ctx = makeCtx(gh);
    const res = deliverQueue(ctx, undefined, null, null);
    expect(res.blocked).toMatchObject([{ number: 2, reason: "no-pr" }]);
    expect(res.blocked[0].since).toBeUndefined();
    expect(res.blocked[0].waitHours).toBeUndefined();
  });
});

describe("doctor: approval-wait (GH-2447) — advisory by construction", () => {
  const check = (r: ReturnType<typeof doctor>) => r.checks.find((c) => c.name === "approval-wait")!;

  it("nothing awaiting approval — ok", () => {
    const gh = new FakeGh();
    const c = check(doctor(makeCtx(gh)));
    expect(c.level).toBe("ok");
    expect(c.detail).toContain("no PRs currently awaiting approval");
  });

  it("one PR waiting, under the threshold — ok, reports median", () => {
    const gh = new FakeGh();
    seedAwaitingApproval(gh, { approvalTimeline: { reviewRequestedAt: "2026-07-31T09:00:00Z" } }); // 3h elapsed
    const c = check(doctor(makeCtx(gh)));
    expect(c.level).toBe("ok");
    expect(c.detail).toContain("1 PR awaiting approval");
    expect(c.detail).toContain("median 3.0h");
    expect(c.detail).toContain("none past");
  });

  it("THE smell: past RALPH_SMELL_APPROVAL_HOURS — info, names the PR", () => {
    const gh = new FakeGh();
    // reviewRequestedAt 30h before NOW (12:00Z on 07-31) — past the 24h default.
    seedAwaitingApproval(gh, { approvalTimeline: { reviewRequestedAt: "2026-07-30T06:00:00Z" } });
    const c = check(doctor(makeCtx(gh)));
    expect(c.level).toBe("info");
    expect(c.detail).toContain("past the line");
    expect(c.detail).toContain("#1 pr#101");
  });

  it("unmeasured PRs are counted separately, never folded into the median as zero", () => {
    const gh = new FakeGh();
    seedAwaitingApproval(gh); // no timeline anchor at all
    const c = check(doctor(makeCtx(gh)));
    expect(c.level).toBe("ok");
    expect(c.detail).toContain("1 unmeasured");
  });

  it("the threshold is env-tunable via RALPH_SMELL_APPROVAL_HOURS", () => {
    const gh = new FakeGh();
    seedAwaitingApproval(gh, { approvalTimeline: { reviewRequestedAt: "2026-07-31T09:00:00Z" } }); // 3h elapsed
    const ctx = makeCtx(gh);
    ctx.cfg.smells = { ...ctx.cfg.smells, approvalHours: 1 };
    const c = check(doctor(ctx));
    expect(c.level).toBe("info");
    expect(c.detail).toContain("past the line");
  });

  it("info never escalates the exit code under --strict", () => {
    const gh = new FakeGh();
    seedAwaitingApproval(gh, { approvalTimeline: { reviewRequestedAt: "2026-07-30T06:00:00Z" } }); // past default
    const ctx = makeCtx(gh);
    const strictBaseline = doctor(ctx, { strict: true }).ok;
    const r = doctor(ctx, { strict: true });
    expect(check(r).level).toBe("info");
    // --strict's exit code keys on "fail" alone (board.ts's own rule) — the
    // approval-wait line being "info" must not move it from whatever the
    // rest of the report already reads.
    expect(r.ok).toBe(strictBaseline);
  });
});
