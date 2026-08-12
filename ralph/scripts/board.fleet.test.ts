/**
 * board.fleet.test.ts — Phase 3 fleet verbs: the frontier projection and the
 * shared-claim join/leave/show cockpit surface.
 *
 * Frontier contract: it is next's eligible queue, item for item and in the
 * same order (a RE-projection of rankNext, never a second eligibility
 * computation), with a per-item explanation {number, title, parentNumber?,
 * blockers: [{number, state}], eligible} and a blocked section
 * [{number, blockers_open, truncated?}].
 *
 * Claim-verb contract: join = addHolder (In Progress only, grammar-B/legacy
 * holder, 8-cap refusal, garbled refusal, read-back verify); leave =
 * removeHolder (non-member no-op, last-out clears, NEVER a state transition);
 * show is a plain read that works from any clone.
 */

import { describe, expect, it, vi } from "vitest";
import {
  claimJoin,
  claimLeave,
  claimShow,
  encodeClaim,
  frontierView,
  listItemsFull,
  ownRepo,
  rankNext,
  RefusalError,
  run,
  UsageError,
} from "./board.js";
import { FakeGh, makeCtx, NOW, refusalMessage } from "./board.testkit.js";

/** run() with stdout captured — the CLI-envelope harness the next-suite uses. */
function captured(argv: string[], ctx: Parameters<typeof run>[1]): string {
  const said: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((s) => {
    said.push(String(s));
    return true;
  });
  try {
    run(argv, ctx);
  } finally {
    spy.mockRestore();
  }
  return said.join("");
}

describe("frontier: a re-projection of next's ranking", () => {
  it("matches next's queue head — and the whole queue, item for item, in order", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    gh.issues.set(1, { number: 1, state: "Backlog", priority: "P1" });
    gh.issues.set(2, { number: 2, state: "Backlog", priority: "P0" });
    gh.issues.set(3, {
      number: 3,
      state: "Backlog",
      blockedBy: [{ number: 2, state: "OPEN" }],
    });
    const next = JSON.parse(captured(["next", "--json"], ctx));
    const frontier = JSON.parse(captured(["frontier", "--json"], ctx));
    expect(frontier.frontier[0].number).toBe(next.next.number);
    expect(frontier.frontier.map((f: any) => f.number)).toEqual(
      next.queue.map((i: any) => i.number),
    );
    expect(frontier.blocked.map((b: any) => b.number)).toEqual(
      next.blocked.map((i: any) => i.number),
    );
  });

  it("explains eligibility: closed blockers ride along with state CLOSED; blocked items name their open edges", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    // #5 waited on #4 (now closed) — eligible, and the frontier says why.
    gh.issues.set(5, {
      number: 5,
      state: "Backlog",
      blockedBy: [{ number: 4, state: "CLOSED" }],
    });
    // #6 still waits on #4-open-twin #7 — blocked, edge named.
    gh.issues.set(6, {
      number: 6,
      state: "Backlog",
      blockedBy: [{ number: 7, state: "OPEN" }],
    });
    gh.issues.set(7, { number: 7, state: "In Progress", claim: encodeClaim("w7-x", NOW) });
    const res = frontierView(rankNext(ownRepo(ctx, listItemsFull(ctx).open).own));
    const f5 = res.frontier.find((f) => f.number === 5)!;
    expect(f5).toMatchObject({
      number: 5,
      title: "Issue 5",
      blockers: [{ number: 4, state: "CLOSED" }],
      eligible: true,
    });
    expect(f5.parentNumber).toBeUndefined(); // no parent → key absent, not null
    expect(res.blocked).toEqual([{ number: 6, blockers_open: [7] }]);
  });

  it("fail-closed blockage (truncated reads) carries the truncated flag, not an invented edge", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    gh.issues.set(1, { number: 1, state: "Backlog", blockersTruncated: true });
    gh.issues.set(2, { number: 2, state: "Backlog", fieldValuesTruncated: true });
    const res = frontierView(rankNext(ownRepo(ctx, listItemsFull(ctx).open).own));
    expect(res.frontier).toEqual([]);
    expect(res.blocked).toEqual([
      { number: 1, blockers_open: [], truncated: true },
      { number: 2, blockers_open: [], truncated: true },
    ]);
  });

  it("carries the epic context through: a promoted leaf keeps via and its own-repo parentNumber", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    gh.issues.set(1, { number: 1, state: "Backlog", priority: "P0" });
    gh.issues.set(5, { number: 5, state: "Backlog", parent: 1 });
    const full = listItemsFull(ctx);
    const res = frontierView(
      rankNext(ownRepo(ctx, full.open).own, ownRepo(ctx, full.closed).own),
    );
    expect(res.frontier[0]).toMatchObject({
      number: 5,
      parentNumber: 1,
      via: 1,
      eligible: true,
    });
  });

  it("CLI: empty frontier names the blocked count; --json is the {frontier, blocked, cache} envelope", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    gh.issues.set(6, {
      number: 6,
      state: "Backlog",
      blockedBy: [{ number: 9, state: "OPEN" }],
    });
    expect(captured(["frontier"], ctx)).toBe("frontier empty (1 blocked: #6)\n");
    const parsed = JSON.parse(captured(["frontier", "--json"], ctx));
    // `cache` (GH-1806) rides alongside the envelope, never inside it: a fleet
    // reading `frontier`/`blocked` is unaffected, and one that wants to know
    // how old the read was has it without a second call.
    expect(parsed).toEqual({
      frontier: [],
      blocked: [{ number: 6, blockers_open: [9] }],
      cache: { cached: false, fetchedAt: NOW.toISOString(), ageSec: 0 },
    });
  });
});

describe("claim join", () => {
  it("adds a sibling to the shared claim and refreshes the ONE shared since (read-back verified)", () => {
    const gh = new FakeGh();
    const old = new Date(NOW.getTime() - 30 * 60_000);
    gh.issues.set(1, { number: 1, state: "In Progress", claim: `w1-first|${old.toISOString()}` });
    const ctx = makeCtx(gh);
    const after = claimJoin(ctx, 1, "w1-second");
    expect(gh.issues.get(1)!.claim).toBe(`w1-first+w1-second|${NOW.toISOString()}`);
    expect(after.claim?.holders).toEqual(["w1-first", "w1-second"]);
    // Clear-then-set, the claim-write protocol everywhere in this file.
    expect(gh.mutations).toEqual(["clearField(#1, F_claim)", "setClaim(#1)"]);
  });

  it("joining a claimless In Progress item creates the claim (mirrors transition's acquisition arm)", () => {
    const gh = new FakeGh();
    gh.issues.set(1, { number: 1, state: "In Progress" });
    const ctx = makeCtx(gh);
    claimJoin(ctx, 1, "w1-solo");
    expect(gh.issues.get(1)!.claim).toBe(`w1-solo|${NOW.toISOString()}`);
  });

  it("refuses when the item is not In Progress — the state transition is not join's to smuggle", () => {
    const gh = new FakeGh();
    gh.issues.set(1, { number: 1, state: "Backlog" });
    const ctx = makeCtx(gh);
    const msg = refusalMessage(() => claimJoin(ctx, 1, "w1-early"));
    expect(msg).toContain(`#1 is "Backlog"`);
    expect(gh.mutations).toEqual([]); // refused before any write
  });

  it("refuses the 9th holder (cap = 8) as a refusal, leaving the claim untouched", () => {
    const gh = new FakeGh();
    const eight = Array.from({ length: 8 }, (_, i) => `w1-h${i}`).join("+");
    const wire = `${eight}|${NOW.toISOString()}`;
    gh.issues.set(1, { number: 1, state: "In Progress", claim: wire });
    const ctx = makeCtx(gh);
    const msg = refusalMessage(() => claimJoin(ctx, 1, "w1-ninth"));
    expect(msg).toContain("cap (8)");
    expect(gh.issues.get(1)!.claim).toBe(wire);
  });

  it("validates the holder grammar (grammar-B or legacy) as usage, before any read", () => {
    const gh = new FakeGh();
    gh.issues.set(1, { number: 1, state: "In Progress" });
    const ctx = makeCtx(gh);
    expect(() => claimJoin(ctx, 1, "me@host")).toThrow(UsageError);
    expect(() => claimJoin(ctx, 1, "")).toThrow(UsageError);
    expect(() => claimJoin(ctx, 1, "W1-Upper")).toThrow(UsageError);
    // Legacy names remain valid holders during the transition window.
    claimJoin(ctx, 1, "gh-1");
    expect(gh.issues.get(1)!.claim).toBe(`gh-1|${NOW.toISOString()}`);
  });

  it("refuses a garbled claim — a hand-edited Claim field is never rewritten", () => {
    const gh = new FakeGh();
    gh.issues.set(1, { number: 1, state: "In Progress", claim: "hand-edited note to self" });
    const ctx = makeCtx(gh);
    const msg = refusalMessage(() => claimJoin(ctx, 1, "w1-late"));
    expect(msg).toContain("unparseable");
    expect(gh.issues.get(1)!.claim).toBe("hand-edited note to self");
  });

  it("read-back verify: a rival's write landing last is a loss, not a silent success", () => {
    const gh = new FakeGh();
    gh.issues.set(1, { number: 1, state: "In Progress", claim: encodeClaim("w1-a", NOW) });
    gh.raceClaimTo = "rival@x";
    const ctx = makeCtx(gh);
    const msg = refusalMessage(() => claimJoin(ctx, 1, "w1-b"));
    expect(msg).toContain("lost the claim race on #1 to rival@x");
  });

  it("read-back verify: a concurrent clear reads as vanished, not as held", () => {
    const gh = new FakeGh();
    gh.issues.set(1, { number: 1, state: "In Progress", claim: encodeClaim("w1-a", NOW) });
    gh.vanishClaim = true;
    const ctx = makeCtx(gh);
    const msg = refusalMessage(() => claimJoin(ctx, 1, "w1-b"));
    expect(msg).toContain("vanished");
  });
});

describe("claim leave", () => {
  it("a member leaves; co-holders keep the claim with its since untouched", () => {
    const gh = new FakeGh();
    const old = new Date(NOW.getTime() - 30 * 60_000);
    gh.issues.set(1, { number: 1, state: "In Progress", claim: `w1-a+w1-b|${old.toISOString()}` });
    const ctx = makeCtx(gh);
    const { issue, changed } = claimLeave(ctx, 1, "w1-b");
    expect(changed).toBe(true);
    expect(gh.issues.get(1)!.claim).toBe(`w1-a|${old.toISOString()}`);
    expect(issue.claim?.holders).toEqual(["w1-a"]);
  });

  it("the LAST one out clears the field and does NOT transition state — moves stay the skills' job", () => {
    const gh = new FakeGh();
    gh.issues.set(1, { number: 1, state: "In Progress", claim: encodeClaim("w1-only", NOW) });
    const ctx = makeCtx(gh);
    const { issue, changed } = claimLeave(ctx, 1, "w1-only");
    expect(changed).toBe(true);
    expect(issue.claim).toBeNull();
    expect(gh.issues.get(1)!.state).toBe("In Progress"); // claimless WIP — doctor's surface
    expect(gh.mutations.some((m) => m.startsWith("setState"))).toBe(false);
    expect(gh.mutations).toEqual(["clearField(#1, F_claim)"]); // no set after the clear
  });

  it("a non-member leave is an idempotent no-op: no write at all", () => {
    const gh = new FakeGh();
    const wire = `w1-a|${NOW.toISOString()}`;
    gh.issues.set(1, { number: 1, state: "In Progress", claim: wire });
    const ctx = makeCtx(gh);
    const { changed } = claimLeave(ctx, 1, "w1-stranger");
    expect(changed).toBe(false);
    expect(gh.issues.get(1)!.claim).toBe(wire);
    expect(gh.mutations).toEqual([]);
  });

  it("refuses a garbled claim — leaving cannot rewrite what it cannot parse", () => {
    const gh = new FakeGh();
    gh.issues.set(1, { number: 1, state: "In Progress", claim: "hand-edited note to self" });
    const ctx = makeCtx(gh);
    const msg = refusalMessage(() => claimLeave(ctx, 1, "w1-x"));
    expect(msg).toContain("unparseable");
  });

  it("read-back verify: a clear that did not stick is a loud failure, never a silent keep", () => {
    const gh = new FakeGh();
    gh.issues.set(1, { number: 1, state: "In Progress", claim: encodeClaim("w1-only", NOW) });
    gh.stickyClaim = true;
    const ctx = makeCtx(gh);
    const msg = refusalMessage(() => claimLeave(ctx, 1, "w1-only"));
    expect(msg).toContain("survived the leave");
  });
});

describe("claim show + CLI dispatch", () => {
  it("show reports holders, the shared since, age vs TTL, and staleness", () => {
    const gh = new FakeGh();
    const old = new Date(NOW.getTime() - 30 * 60_000);
    gh.issues.set(1, { number: 1, state: "In Progress", claim: `w1-a+w1-b|${old.toISOString()}` });
    const ctx = makeCtx(gh);
    expect(claimShow(ctx, 1)).toEqual({
      number: 1,
      state: "In Progress",
      claim: { holders: ["w1-a", "w1-b"], since: old },
      claimRaw: `w1-a+w1-b|${old.toISOString()}`,
      ageMin: 30,
      ttlMin: 120,
      stale: false,
    });
  });

  it("show is honest about the three claim shapes: fresh, absent, garbled", () => {
    const gh = new FakeGh();
    const stale = new Date(NOW.getTime() - 180 * 60_000);
    gh.issues.set(1, { number: 1, state: "In Progress", claim: `w1-a|${stale.toISOString()}` });
    gh.issues.set(2, { number: 2, state: "Backlog" });
    gh.issues.set(3, { number: 3, state: "In Progress", claim: "hand-edited note to self" });
    const ctx = makeCtx(gh);
    expect(captured(["claim", "show", "1"], ctx)).toContain("STALE");
    expect(captured(["claim", "show", "2"], ctx)).toBe("#2: no claim\n");
    expect(captured(["claim", "show", "3"], ctx)).toContain("GARBLED");
    const parsed = JSON.parse(captured(["claim", "show", "3", "--json"], ctx));
    expect(parsed.claim).toBeNull();
    expect(parsed.claimRaw).toBe("hand-edited note to self");
    expect(parsed.stale).toBeNull();
  });

  it("join/leave round-trip through the CLI; a bare number still drives the classic claim", () => {
    const gh = new FakeGh();
    gh.issues.set(1, { number: 1, state: "Backlog" });
    const ctx = makeCtx(gh);
    // Classic claim (transition) is untouched by the subverb dispatch.
    expect(run(["claim", "1"], ctx)).toBe(0);
    expect(gh.issues.get(1)!.claim).toBe(`me@test|${NOW.toISOString()}`);
    expect(run(["claim", "join", "1", "--holder", "w1-sib"], ctx)).toBe(0);
    expect(gh.issues.get(1)!.claim).toBe(`me@test+w1-sib|${NOW.toISOString()}`);
    const noop = captured(["claim", "leave", "1", "--holder", "w1-stranger"], ctx);
    expect(noop).toContain("no-op");
    expect(run(["claim", "leave", "1", "--holder", "w1-sib"], ctx)).toBe(0);
    expect(gh.issues.get(1)!.claim).toBe(`me@test|${NOW.toISOString()}`);
    expect(() => run(["claim", "join", "1"], ctx)).toThrow(/--holder/);
  });

  it("scope gate: join/leave are mutations (refused off-scope); show is a plain read", () => {
    const gh = new FakeGh();
    gh.issues.set(1, { number: 1, state: "In Progress", claim: encodeClaim("w1-a", NOW) });
    const ctx = makeCtx(gh);
    ctx.exec = (argv, stdin) => {
      if (argv.join(" ").includes("remote get-url"))
        return { code: 0, stdout: "git@github.com:someone-else/other.git\n", stderr: "" };
      return gh.exec(argv, stdin);
    };
    expect(() => run(["claim", "join", "1", "--holder", "w1-b"], ctx)).toThrow(RefusalError);
    expect(() => run(["claim", "leave", "1", "--holder", "w1-a"], ctx)).toThrow(RefusalError);
    expect(run(["claim", "show", "1"], ctx)).toBe(0); // read path works from any clone
  });
});
