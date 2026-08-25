/**
 * board.metrics.test.ts — the cost registry. Every assertion here IS a metric:
 * exact GraphQL round trips and mutation counts per command scenario, pinned
 * so an optimization's evidence is a diff to this file and a regression (or a
 * sneaky mutation retry — mutations are pinned exact, retries double them and
 * fail) cannot land silently. Baselines measured at GH board-hardening landing;
 * "was" notes record the cost before that change.
 *
 * Directness metric: `next` must hand the driver an immediately actionable
 * number — Backlog, unclaimed, unblocked, no open board children — with no
 * follow-up `board get` needed to find the real work.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { refreshCache, run, type Ctx } from "./board.js";
import { FakeGh, makeCtx, NOW } from "./board.testkit.js";

/** Counting overlay on the exec seam: graphql round trips, mutation round
 *  trips, and query bytes. Reset by re-reading the fields. */
function meter(ctx: Ctx) {
  const m = { graphql: 0, mutations: 0, queryBytes: 0 };
  const inner = ctx.exec;
  ctx.exec = (argv, stdin) => {
    if (argv[0] === "gh" && argv[1] === "api" && argv[2] === "graphql") {
      m.graphql++;
      const q = stdin ? (JSON.parse(stdin).query as string) : "";
      m.queryBytes += q.length;
      if (/^\s*mutation/.test(q)) m.mutations++;
    }
    return inner(argv, stdin);
  };
  const reset = () => {
    m.graphql = 0;
    m.mutations = 0;
    m.queryBytes = 0;
  };
  return { m, reset };
}

/** Warm ctx: field cache populated so pins measure the command, not the miss. */
function warmCtx(gh: FakeGh): { ctx: Ctx; m: { graphql: number; mutations: number; queryBytes: number }; reset: () => void } {
  const ctx = makeCtx(gh);
  refreshCache(ctx);
  const { m, reset } = meter(ctx);
  return { ctx, m, reset };
}

function flatBoard(gh: FakeGh, n: number): void {
  for (let i = 1; i <= n; i++) gh.issues.set(i, { number: i, state: "Backlog" });
}

/** Epic root #1 (P0 via fixture priority is not modeled in FakeGh fieldValues,
 *  so shape alone drives the ranking) with leaves #2/#3; #4 is flat work. */
function epicBoard(gh: FakeGh): void {
  gh.issues.set(1, { number: 1, state: "Backlog" });
  gh.issues.set(2, { number: 2, state: "Backlog", parent: 1 });
  gh.issues.set(3, { number: 3, state: "Backlog", parent: 1 });
  gh.issues.set(4, { number: 4, state: "Backlog" });
}

const silence = () => {
  const orig = process.stdout.write.bind(process.stdout);
  const said: string[] = [];
  process.stdout.write = ((s: any) => {
    said.push(String(s));
    return true;
  }) as any;
  return { said, restore: () => (process.stdout.write = orig) };
};

function runQuiet(argv: string[], ctx: Ctx): { code: number; out: string } {
  const s = silence();
  try {
    const code = run(argv, ctx);
    return { code, out: s.said.join("") };
  } finally {
    s.restore();
  }
}

describe("metrics: read round trips", () => {
  it("refreshCache = 1 round trip (was 2 user-owned / 3 org-owned before the repositoryOwner merge)", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    const { m } = meter(ctx);
    refreshCache(ctx);
    expect(m.graphql).toBe(1);
  });

  it("get = 1 round trip warm; a cold cache adds exactly 1 refresh", () => {
    const gh = new FakeGh();
    flatBoard(gh, 3);
    const cold = makeCtx(gh);
    const cm = meter(cold);
    runQuiet(["get", "1"], cold);
    expect(cm.m.graphql).toBe(2); // refresh + read

    const { ctx, m } = warmCtx(gh);
    runQuiet(["get", "1"], ctx);
    expect(m.graphql).toBe(1);
  });

  it("next on a 150-item board = 2 round trips warm (page walk), all 150 ranked", () => {
    const gh = new FakeGh();
    flatBoard(gh, 150);
    gh.itemsPageSize = 100;
    const { ctx, m } = warmCtx(gh);
    const { out } = runQuiet(["next", "--json"], ctx);
    expect(m.graphql).toBe(2);
    expect(JSON.parse(out).queue).toHaveLength(150); // pagination loses nothing
  });

  it("next on an AGED field cache = 3 round trips — the one documented exception to that baseline", () => {
    // GH-1789: ranking reads the Priority field's DECLARED option order, and a
    // field cache older than PRIORITY_ORDER_MAX_AGE_MS is re-read once, so a
    // reorder/rename cannot steer the queue indefinitely. That is +1 trip on
    // the aged path ONLY. Pinned here so the exception is a measured fact
    // rather than a claim in a comment — and so that charging it to the WARM
    // path (which an earlier draft of this feature did) fails the suite.
    const gh = new FakeGh();
    flatBoard(gh, 150);
    gh.itemsPageSize = 100;
    const { ctx, m, reset } = warmCtx(gh);
    const cacheFile = join(ctx.cacheDir, "board-cdubiel08-ralph-hero-13.json");
    const age = (iso: string) => {
      const c = JSON.parse(readFileSync(cacheFile, "utf8"));
      c.fetchedAt = iso;
      writeFileSync(cacheFile, JSON.stringify(c));
    };

    age("2026-01-01T00:00:00Z"); // older than the ceiling
    const { out } = runQuiet(["next", "--json"], ctx);
    expect(m.graphql).toBe(3); // 2 page-walk trips + 1 schema re-read
    expect(JSON.parse(out).queue).toHaveLength(150); // still ranks everything

    // Re-stamped fresh, it is back to the 2-trip baseline: the extra read is
    // bounded by the ceiling, never charged to every call.
    reset();
    age(NOW.toISOString());
    runQuiet(["next", "--json"], ctx);
    expect(m.graphql).toBe(2);
  });

  it("dep/link = 2 round trips (was 3, two of them full-issue payloads); id query stays skeletal", () => {
    const gh = new FakeGh();
    flatBoard(gh, 3);
    const { ctx, m, reset } = warmCtx(gh);
    let idQueryBytes = 0;
    const inner = ctx.exec;
    ctx.exec = (argv, stdin) => {
      if (stdin?.includes("a0: issue(number")) idQueryBytes = JSON.parse(stdin).query.length;
      return inner(argv, stdin);
    };
    runQuiet(["dep", "1", "--on", "2"], ctx);
    expect(m.graphql).toBe(2);
    expect(idQueryBytes).toBeGreaterThan(0);
    expect(idQueryBytes).toBeLessThan(300); // ids only — not fetchIssue's kitchen sink
    reset();
    runQuiet(["link", "1", "3"], ctx);
    expect(m.graphql).toBe(2);
  });
});

describe("metrics: mutation round trips (exact — a retry doubles a pin and fails)", () => {
  it("claim from Backlog = 6 round trips, exactly 4 mutations (clear, claim, state, status)", () => {
    const gh = new FakeGh();
    flatBoard(gh, 1);
    const { ctx, m } = warmCtx(gh);
    runQuiet(["claim", "1"], ctx);
    expect(m.graphql).toBe(6); // read + clear + set-claim + set-state + status + verify re-read
    expect(m.mutations).toBe(4);
    expect(gh.mutations).toEqual([
      "clearField(#1, F_claim)",
      "setClaim(#1)",
      "setState(#1, In Progress)",
      "setField(F_status)",
    ]);
  });

  it("move In Review → Done (merged PR) = 5 round trips, 3 mutations", () => {
    const gh = new FakeGh();
    gh.issues.set(1, { number: 1, state: "In Review", prs: [{ number: 9, merged: true }] });
    const { ctx, m } = warmCtx(gh);
    runQuiet(["move", "1", "done"], ctx);
    expect(m.graphql).toBe(5); // read + set-state + status + close + verify re-read
    expect(m.mutations).toBe(3);
  });

  it("reconcile adoption = 5 round trips with ONE pre-write read (was 6 with a duplicate read)", () => {
    const gh = new FakeGh();
    gh.issues.set(41, { number: 41, state: null, onBoard: false });
    const { ctx, m } = warmCtx(gh);
    let preWriteReads = 0;
    let sawMutation = false;
    const inner = ctx.exec;
    ctx.exec = (argv, stdin) => {
      const q = stdin ? JSON.parse(stdin).query ?? "" : "";
      if (/^\s*mutation/.test(q)) sawMutation = true;
      else if (q.includes("issue(number") && !sawMutation) preWriteReads++;
      return inner(argv, stdin);
    };
    runQuiet(["reconcile", "41"], ctx);
    expect(m.graphql).toBe(5); // read + add-to-board + set-state + status + echo re-read
    expect(preWriteReads).toBe(1);
  });
});

describe("metrics: doctor sweep", () => {
  it("doctor on a 3-item board = 6 round trips warm (page walk + history chunk + refresh-as-check + PR-orphan sweep + deps-unwired inputs)", () => {
    const gh = new FakeGh();
    flatBoard(gh, 3);
    const { ctx, m } = warmCtx(gh);
    runQuiet(["doctor"], ctx);
    // doctor's refreshCache IS its cache-vs-live check (1), one items page (1),
    // one history chunk for 3 open items (1), and the GH-2048 orphan sweep (1 —
    // one page per 100 OPEN PRs, and it cannot be folded into any of the
    // others: they are all rooted at issues or at the project, and this is the
    // one question about work that reached neither). GH-2136 adds the
    // deps-unwired inputs: one bodies batch (plain aliased fields, 1-pt
    // floor) + one comments-only trail chunk over the unclaimed Backlog —
    // both bounded by live work, neither scales with closed history.
    expect(m.graphql).toBe(6);
    expect(m.mutations).toBe(0); // no --fix, no writes — pinned
  });
});

describe("metrics: tend-queue (GH-1891)", () => {
  /** Was: the full project scan (one page per 100 items the board has EVER
   *  held) plus a 20-issue history chunk per 20 recent closes — 22 round trips
   *  and 47 GraphQL points on this repo. Now both halves are issues-rooted and
   *  the trail fetch is comments-only: 17 points over these 4 round trips.
   *
   *  The pin that matters is that NONE of them scale with closed history: the
   *  open page and the closed WINDOW page are both bounded by live work, so a
   *  board with 55 long-closed items costs exactly what a board with none
   *  does. A regression here is a reader that went back to the scan. */
  it("tend-queue on a board of 5 open + 55 long-closed = 4 round trips warm", () => {
    const gh = new FakeGh();
    const old = new Date(NOW.getTime() - 400 * 86_400_000).toISOString();
    const stale = new Date(NOW.getTime() - 45 * 86_400_000).toISOString();
    for (let n = 1; n <= 5; n++) gh.issues.set(n, { number: n, state: "Backlog", updatedAt: stale });
    for (let n = 6; n <= 60; n++)
      gh.issues.set(n, {
        number: n, state: "Done", issueState: "CLOSED", stateReason: "COMPLETED",
        closedAt: old, updatedAt: old,
      });
    const { ctx, m } = warmCtx(gh);
    runQuiet(["tend-queue", "--json"], ctx);
    // 1 open page + 1 closed-window page + 1 deps-unwired bodies batch for
    // the 5-item unclaimed Backlog pool (GH-2136, plain aliased fields at the
    // 1-pt floor) + 1 trail chunk for the 5 queued open items (all
    // stale-body; the dep-judgment markers ride this same read). No audit
    // trail chunk: every close here is outside the 14-day window, so the
    // audit fetches nothing.
    expect(m.graphql).toBe(4);
    expect(m.mutations).toBe(0); // a selector never writes — pinned
  });

  it("and does not grow when the closed history does", () => {
    const cost = (closedCount: number): number => {
      const gh = new FakeGh();
      const old = new Date(NOW.getTime() - 400 * 86_400_000).toISOString();
      const stale = new Date(NOW.getTime() - 45 * 86_400_000).toISOString();
      for (let n = 1; n <= 5; n++) gh.issues.set(n, { number: n, state: "Backlog", updatedAt: stale });
      for (let n = 6; n <= 5 + closedCount; n++)
        gh.issues.set(n, {
          number: n, state: "Done", issueState: "CLOSED", stateReason: "COMPLETED",
          closedAt: old, updatedAt: old,
        });
      const { ctx, m } = warmCtx(gh);
      runQuiet(["tend-queue", "--json"], ctx);
      return m.graphql;
    };
    expect(cost(300)).toBe(cost(0));
  });
});

describe("metrics: next directness (epic boards)", () => {
  it("the head is immediately actionable — a leaf, not the epic root that needs a follow-up get", () => {
    const gh = new FakeGh();
    epicBoard(gh);
    const { ctx, m } = warmCtx(gh);
    const { out } = runQuiet(["next", "--json"], ctx);
    const parsed = JSON.parse(out);
    // Directness: head is a leaf under the epic, annotated, actionable as-is.
    expect(parsed.next.number).toBe(2);
    expect(parsed.next.via).toBe(1);
    expect(parsed.next.state).toBe("Backlog");
    expect(parsed.next.claim).toBeNull();
    expect(parsed.next.openBlockers).toEqual([]);
    // The root never heads the queue while it has open leaves.
    expect(parsed.queue.map((i: any) => i.number)).not.toContain(1);
    // And the tree resolution rode the existing page walk: 1 round trip warm.
    expect(m.graphql).toBe(1);
  });
});
