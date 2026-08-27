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
 * Claim-verb contract: `join` was REMOVED in GH-1869 (it was the only path
 * that grew a holder set) and is now a refusal naming the migration; leave =
 * removeHolder (non-member no-op, last-out clears, NEVER a state transition)
 * and still handles multi-holder values already on the board; show is a plain
 * read that works from any clone and reports a fleet claim faithfully.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  claimLeave,
  claimShow,
  encodeClaim,
  frontierView,
  listItemsFull,
  ownRepo,
  rankNext,
  RefusalError,
  run,
} from "./board.js";
import * as boardApi from "./board.js";
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

describe("claim join — removed (GH-1869)", () => {
  it("refuses, names the migration, and writes nothing", () => {
    const gh = new FakeGh();
    const wire = `w1-first|${NOW.toISOString()}`;
    gh.issues.set(1, { number: 1, state: "In Progress", claim: wire });
    const ctx = makeCtx(gh);
    const msg = refusalMessage(() => run(["claim", "join", "1", "--holder", "w1-second"], ctx));
    expect(msg).toContain("GH-1869");
    expect(msg).toContain("board create");
    expect(gh.issues.get(1)!.claim).toBe(wire);
    expect(gh.mutations).toEqual([]);
  });

  it("no exported function can grow a holder set", () => {
    expect(Object.keys(boardApi)).not.toContain("claimJoin");
    expect(Object.keys(boardApi)).not.toContain("addHolder");
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

  it("leave round-trips through the CLI; a bare number still drives the classic claim", () => {
    const gh = new FakeGh();
    // A fleet claim already on the board — the only way one exists post-GH-1869.
    gh.issues.set(1, {
      number: 1,
      state: "In Progress",
      claim: `me@test+w1-sib|${NOW.toISOString()}`,
    });
    gh.issues.set(2, { number: 2, state: "Backlog" });
    const ctx = makeCtx(gh);
    // Classic claim (transition) is untouched by the subverb dispatch.
    expect(run(["claim", "2"], ctx)).toBe(0);
    expect(gh.issues.get(2)!.claim).toBe(`me@test|${NOW.toISOString()}`);
    const noop = captured(["claim", "leave", "1", "--holder", "w1-stranger"], ctx);
    expect(noop).toContain("no-op");
    expect(run(["claim", "leave", "1", "--holder", "w1-sib"], ctx)).toBe(0);
    expect(gh.issues.get(1)!.claim).toBe(`me@test|${NOW.toISOString()}`);
    expect(() => run(["claim", "leave", "1"], ctx)).toThrow(/--holder/);
  });

  it("scope gate: leave is a mutation (refused off-scope); show is a plain read", () => {
    const gh = new FakeGh();
    gh.issues.set(1, { number: 1, state: "In Progress", claim: encodeClaim("w1-a", NOW) });
    const ctx = makeCtx(gh);
    ctx.exec = (argv, stdin) => {
      if (argv.join(" ").includes("remote get-url"))
        return { code: 0, stdout: "git@github.com:someone-else/other.git\n", stderr: "" };
      return gh.exec(argv, stdin);
    };
    expect(() => run(["claim", "leave", "1", "--holder", "w1-a"], ctx)).toThrow(RefusalError);
    expect(run(["claim", "show", "1"], ctx)).toBe(0); // read path works from any clone
  });
});

// ---------------------------------------------------------------------------
// dispatch-rota.sh's fleet pass reads this CLI's frontier JSON (GH-2196).
// The first version read `.next.number` — board next's shape — so the jq
// always yielded empty and the pass reported idle on every run, silently.
// These tests extract the rota's ACTUAL jq programs from the script and run
// real jq against the CLI's real output, so a rename of either surface fails
// CI instead of silently disarming the rota again.
// ---------------------------------------------------------------------------
describe("dispatch-rota fleet pass ↔ frontier --json shape (GH-2196)", () => {
  const script = readFileSync(new URL("../examples/dispatch-rota.sh", import.meta.url), "utf8");
  const headExpr = script.match(/head=\$\(jq -r '([^']+)' <<<"\$fj"\)/)?.[1];
  const guardExpr = script.match(/! jq -e '([^']+)'/)?.[1];

  function jqR(program: string, input: string): string {
    return execFileSync("jq", ["-r", program], { input, encoding: "utf8" }).trim();
  }
  function jqPasses(program: string, input: string): boolean {
    try {
      execFileSync("jq", ["-e", program], { input, encoding: "utf8", stdio: ["pipe", "ignore", "ignore"] });
      return true;
    } catch {
      return false;
    }
  }

  it("the script still carries the pinned jq programs (the grep half of the pin)", () => {
    expect(headExpr).toBe(".frontier[0].number // empty");
    expect(guardExpr).toBe(".frontier | type == \"array\"");
  });

  it("head extraction: the rota's own jq program pulls the queue head from the CLI's real output", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    gh.issues.set(1, { number: 1, state: "Backlog", priority: "P1" });
    gh.issues.set(2, { number: 2, state: "Backlog", priority: "P0" });
    const out = captured(["frontier", "--json"], ctx);
    expect(jqPasses(guardExpr!, out)).toBe(true);
    expect(jqR(headExpr!, out)).toBe("2"); // P0 outranks P1 — next's head, not empty
  });

  it("empty frontier: guard passes, head parses to no candidate — the one honest idle", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    gh.issues.set(6, { number: 6, state: "Backlog", blockedBy: [{ number: 9, state: "OPEN" }] });
    const out = captured(["frontier", "--json"], ctx);
    expect(jqPasses(guardExpr!, out)).toBe(true);
    expect(jqR(headExpr!, out)).toBe("");
  });

  it("board next's shape — the bug's own input — fails the shape guard instead of reading as idle", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    gh.issues.set(1, { number: 1, state: "Backlog", priority: "P0" });
    const out = captured(["next", "--json"], ctx);
    expect(jqR(".next.number // empty", out)).toBe("1"); // it IS next's shape…
    expect(jqPasses(guardExpr!, out)).toBe(false); // …and the guard refuses it loudly
  });
});
