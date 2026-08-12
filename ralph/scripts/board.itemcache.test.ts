/**
 * board.itemcache.test.ts — the cross-process bounded-staleness item cache
 * (GH-1806).
 *
 * Two processes are modelled as two Ctx values over ONE cacheDir, which is
 * what the cache actually is: machine-local state shared by CLI invocations
 * that never see each other. A test using a single ctx twice would prove
 * nothing the feature is about.
 *
 * The safety claims under test are the ones that make bounded staleness
 * legitimate here, not the speed:
 *   - the cache never reaches a write-guard evaluation
 *   - read-your-writes: a local mutation is visible to the next read
 *   - monotonic reads: no read ever goes backwards in time
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type Ctx,
  doctor,
  ITEM_CACHE_TTL_DEFAULT_SEC,
  ITEM_CACHE_TTL_MAX_SEC,
  isMutationOp,
  listItemsFull,
  listOwnOpenItems,
  listOwnOpenWalk,
  parseItemCacheTtlSec,
  QUEUE_SELECT_FULL,
  QUEUE_SELECT_MINIMAL,
  QUEUE_SELECT_NO_LABELS,
  run,
} from "./board.js";
import { FakeGh, makeCtx, NOW } from "./board.testkit.js";

const TTL = 90;

describe("item cache (GH-1806) — cross-process bounded staleness", () => {
  let gh: FakeGh;
  let dir: string;
  /** A separate Ctx over the same machine cache = a separate CLI process. */
  const proc = (opts: { at?: Date; ttlSec?: number } = {}): Ctx =>
    makeCtx(gh, "me@test", "/repo", {
      cacheDir: dir,
      itemCacheTtlSec: opts.ttlSec ?? TTL,
      now: () => opts.at ?? NOW,
    });
  const later = (sec: number) => new Date(NOW.getTime() + sec * 1000);
  /** Entry files are keyed by SELECTION as well as kind (GH-1803 × GH-1806) —
   *  `l1b1` is the default full selection, `l0b1` the ranker's lean one. */
  const entryPath = (kind: "full" | "own-open", tag = "l1b1") =>
    join(dir, `items-${kind}-${tag}-github.com-cdubiel08-ralph-hero-13.json`);
  const marksPath = () => join(dir, "items-marks-github.com-cdubiel08-ralph-hero-13.json");

  beforeEach(() => {
    gh = new FakeGh();
    dir = mkdtempSync(join(tmpdir(), "board-itemcache-"));
    gh.issues.set(1, { number: 1, state: "Backlog" });
    gh.issues.set(2, { number: 2, state: "In Review" });
  });

  describe("the win it exists for", () => {
    it("serves a second process's walk from disk inside Δ", () => {
      expect(listItemsFull(proc()).cached).toBe(false);
      const cost = gh.graphqlCalls;

      const hit = listItemsFull(proc({ at: later(30) }));
      expect(hit.cached).toBe(true);
      expect(hit.ageSec).toBe(30);
      expect(hit.open.map((i) => i.number)).toEqual([1, 2]);
      expect(gh.graphqlCalls).toBe(cost); // not one extra round trip
    });

    it("carries GH-1788's scan meter through a cache hit", () => {
      // A cache hit does no paging, so a meter recomputed on serve would be
      // zero and `board-volume` would report an empty board. The meter belongs
      // to the walk that produced the data and must travel with it.
      gh.itemsPageSize = 1; // force a multi-page walk so the meter is non-trivial
      const fresh = listItemsFull(proc());
      expect(fresh.scan.pages).toBeGreaterThan(1);

      const hit = listItemsFull(proc({ at: later(30) }));
      expect(hit.cached).toBe(true);
      expect(hit.scan).toEqual(fresh.scan);
    });

    it("refuses an entry whose meter is missing rather than reporting a zero-volume board", () => {
      listItemsFull(proc());
      const path = join(dir, "items-full-github.com-cdubiel08-ralph-hero-13.json");
      const entry = JSON.parse(readFileSync(path, "utf8"));
      delete entry.scan; // a v1-shaped entry, or a hand-truncated one
      writeFileSync(path, JSON.stringify(entry));
      expect(listItemsFull(proc({ at: later(5) })).cached).toBe(false);
    });

    it("walks again once Δ has passed", () => {
      listItemsFull(proc());
      const cost = gh.graphqlCalls;
      expect(listItemsFull(proc({ at: later(TTL + 1) })).cached).toBe(false);
      expect(gh.graphqlCalls).toBeGreaterThan(cost);
    });

    it("answers an own-open read from a fresh FULL walk — the chain's real win", () => {
      // `next` pays for the project scan; `list` then costs nothing, because
      // listOwnOpenItems === ownRepo(listItems).own, an identity board.test.ts
      // pins independently. The reverse derivation must NOT happen.
      gh.issues.set(3, { number: 3, state: "Backlog", repo: "other/repo" });
      gh.issues.set(4, { number: 4, state: "Done", issueState: "CLOSED", stateReason: "COMPLETED" });
      listItemsFull(proc());
      const cost = gh.graphqlCalls;

      const derived = listOwnOpenWalk(proc({ at: later(10) }));
      expect(derived.cached).toBe(true);
      expect(gh.graphqlCalls).toBe(cost);
      // Foreign and closed items are filtered out, exactly as the live read does.
      expect(derived.open.map((i) => i.number)).toEqual([1, 2]);
      expect(derived.closed).toEqual([]);
      expect(derived.open).toEqual(listOwnOpenItems(proc({ ttlSec: 0 })));
    });

    it("does not answer a FULL read from an own-open entry", () => {
      // own-open cannot see foreign or closed items; serving it as a full walk
      // would silently empty doctor's drift sweep and the foreign-item check.
      gh.issues.set(3, { number: 3, state: "Backlog", repo: "other/repo" });
      listOwnOpenWalk(proc());
      const cost = gh.graphqlCalls;

      const full = listItemsFull(proc({ at: later(10) }));
      expect(full.cached).toBe(false);
      expect(gh.graphqlCalls).toBeGreaterThan(cost);
      expect(full.open.map((i) => i.number)).toEqual([1, 2, 3]);
    });
  });

  describe("the QueueSelect seam (GH-1803 × GH-1806)", () => {
    // The bug neither change could produce alone: a walk that never REQUESTED
    // `blockedBy` yields items with the group ABSENT — and absent is not empty.
    // Serving that to a caller which reads blockers would not lose data, it
    // would fabricate "GitHub said there are none", and `next` would rank an
    // item as unblocked whose dependencies were never fetched.
    beforeEach(() => {
      gh.issues.set(7, {
        number: 7,
        state: "Backlog",
        labels: ["ralph:apply"],
        blockedBy: [{ number: 1, state: "OPEN" }],
      });
    });

    it("a lean entry does NOT serve a request that needs what it never fetched", () => {
      const lean = listItemsFull(proc(), QUEUE_SELECT_MINIMAL);
      expect(lean.cached).toBe(false);
      const cost = gh.graphqlCalls;

      // Needs blockers — minimal never asked for them.
      expect(listItemsFull(proc({ at: later(5) }), QUEUE_SELECT_NO_LABELS).cached).toBe(false);
      expect(gh.graphqlCalls).toBeGreaterThan(cost);
      // Needs labels too.
      const c2 = gh.graphqlCalls;
      expect(listItemsFull(proc({ at: later(6) }), QUEUE_SELECT_FULL).cached).toBe(false);
      expect(gh.graphqlCalls).toBeGreaterThan(c2);
    });

    it("and the item it would have served really is missing the group", () => {
      // The premise of the test above, made explicit: this is why coverage is
      // checked rather than assumed harmless.
      const minimal = listItemsFull(proc(), QUEUE_SELECT_MINIMAL);
      const item: any = minimal.open.find((i) => i.number === 7);
      expect(item.openBlockers).toBeUndefined();
      expect(item.blockersTruncated).toBeUndefined();
      expect(item.labels).toBeUndefined();

      const full = listItemsFull(proc({ at: later(TTL + 1) }), QUEUE_SELECT_FULL);
      const fat: any = full.open.find((i) => i.number === 7);
      expect(fat.openBlockers).toEqual([1]);
      expect(fat.labels).toEqual(["ralph:apply"]);
    });

    it("a WIDER entry serves a narrower request for free", () => {
      // The payoff side of the same rule: extra groups are truthful, and the
      // caller's own type declares them optional. This is what makes a `list`
      // or `doctor` walk pay for the `next`/`deliver-queue` reads after it.
      listItemsFull(proc(), QUEUE_SELECT_FULL);
      const cost = gh.graphqlCalls;

      for (const s of [QUEUE_SELECT_NO_LABELS, QUEUE_SELECT_MINIMAL]) {
        const hit = listItemsFull(proc({ at: later(10) }), s);
        expect(hit.cached).toBe(true);
        expect(hit.open.map((i) => i.number)).toContain(7);
      }
      expect(gh.graphqlCalls).toBe(cost);
    });

    it("keeps one entry file per selection, so a lean walk cannot evict a fat one", () => {
      // Lean FIRST, so it genuinely walks and writes its own file; a fat walk
      // after it must not overwrite that, nor be overwritten by the next lean
      // one. Keyed-by-selection is what buys this — a single file per kind
      // would let `next` and `list` clobber each other forever.
      listItemsFull(proc(), QUEUE_SELECT_MINIMAL);
      listItemsFull(proc({ at: later(1) }), QUEUE_SELECT_FULL);
      expect(existsSync(entryPath("full", "l0b0"))).toBe(true);
      expect(existsSync(entryPath("full", "l1b1"))).toBe(true);

      // Both still answer their own request — no downgrade, no thrash.
      const cost = gh.graphqlCalls;
      expect(listItemsFull(proc({ at: later(2) }), QUEUE_SELECT_FULL).cached).toBe(true);
      expect(listItemsFull(proc({ at: later(3) }), QUEUE_SELECT_MINIMAL).cached).toBe(true);
      expect(gh.graphqlCalls).toBe(cost);
    });

    it("a fat entry answers a lean request WITHOUT writing a second file", () => {
      // The corollary, and the reason the test above has to order lean-first:
      // coverage means the narrow walk never happens at all.
      listItemsFull(proc(), QUEUE_SELECT_FULL);
      const cost = gh.graphqlCalls;
      expect(listItemsFull(proc({ at: later(1) }), QUEUE_SELECT_MINIMAL).cached).toBe(true);
      expect(gh.graphqlCalls).toBe(cost);
      expect(existsSync(entryPath("full", "l0b0"))).toBe(false);
    });

    it("trusts the entry's own select, not the filename it was found under", () => {
      // The filename is an index; the assertion is the stored field. A file
      // moved, hand-edited, or written by another version must not be believed
      // just because it sits at the fat key.
      listItemsFull(proc(), QUEUE_SELECT_MINIMAL);
      const lean = JSON.parse(readFileSync(entryPath("full", "l0b0"), "utf8"));
      writeFileSync(entryPath("full", "l1b1"), JSON.stringify(lean)); // lie by filename
      expect(listItemsFull(proc({ at: later(5) }), QUEUE_SELECT_FULL).cached).toBe(false);
    });

    it("applies the same coverage rule to the full → own-open derivation", () => {
      listItemsFull(proc(), QUEUE_SELECT_MINIMAL);
      const cost = gh.graphqlCalls;
      // A minimal full scan cannot answer an own-open read that needs labels…
      expect(listOwnOpenWalk(proc({ at: later(5) }), QUEUE_SELECT_FULL).cached).toBe(false);
      expect(gh.graphqlCalls).toBeGreaterThan(cost);
      // …but a full scan can.
      listItemsFull(proc({ at: later(6) }), QUEUE_SELECT_FULL);
      const c2 = gh.graphqlCalls;
      expect(listOwnOpenWalk(proc({ at: later(7) }), QUEUE_SELECT_FULL).cached).toBe(true);
      expect(gh.graphqlCalls).toBe(c2);
    });

    it("a write invalidates every selection variant, not just the one in hand", () => {
      // A mutating process reads with ONE selection but invalidates the board,
      // not one shape of reading it. Asserted on the files rather than on two
      // successive reads, because the first re-read repopulates a covering
      // entry and would mask the second.
      listItemsFull(proc(), QUEUE_SELECT_MINIMAL);
      listItemsFull(proc({ at: later(1) }), QUEUE_SELECT_FULL);
      expect(existsSync(entryPath("full", "l0b0"))).toBe(true);
      expect(existsSync(entryPath("full", "l1b1"))).toBe(true);

      run(["comment", "1", "-m", "x"], proc({ at: later(10) }));

      expect(existsSync(entryPath("full", "l0b0"))).toBe(false);
      expect(existsSync(entryPath("full", "l1b1"))).toBe(false);
      expect(listItemsFull(proc({ at: later(11) }), QUEUE_SELECT_MINIMAL).cached).toBe(false);
    });
  });

  describe("carve-out 1 — the cache never drives a write-guard evaluation", () => {
    it("prune --apply walks fresh; its dry run may be cached", () => {
      // GH-1788 landed while this was in review. prune --apply picks DELETION
      // targets from the walk and then removes those project items — the most
      // consequential write-guard evaluation in the file, and the one where a
      // stale walk would delete against a board that no longer looks like that.
      for (let n = 10; n <= 12; n++)
        gh.issues.set(n, {
          number: n,
          state: "Done",
          issueState: "CLOSED",
          stateReason: "COMPLETED",
          closedAt: new Date(NOW.getTime() - 400 * 86_400_000).toISOString(),
        });
      listItemsFull(proc()); // warm

      const beforeDry = gh.graphqlCalls;
      run(["prune"], proc({ at: later(5) })); // dry run — served from disk
      const dryCost = gh.graphqlCalls - beforeDry;

      const beforeApply = gh.graphqlCalls;
      run(["prune", "--apply"], proc({ at: later(10) }));
      expect(gh.graphqlCalls - beforeApply).toBeGreaterThan(dryCost);
    });

    it("doctor --fix walks fresh even with a warm entry", () => {
      listItemsFull(proc()); // warm
      const cost = gh.graphqlCalls;
      // Report-only doctor is a read like any other and keeps the cache…
      run(["doctor"], proc({ at: later(5) }));
      const afterReport = gh.graphqlCalls;
      // …--fix pays for truth: it selects correction targets from this walk
      // and then mutates them.
      run(["doctor", "--fix"], proc({ at: later(10) }));
      expect(afterReport - cost).toBeLessThan(gh.graphqlCalls - afterReport);
    });

    it("every MUTATING command runs with the cache off, and --fresh forces a walk", () => {
      listItemsFull(proc());
      const warm = () => {
        const c = gh.graphqlCalls;
        run(["next"], proc({ at: later(5) }));
        return gh.graphqlCalls === c; // true = served from disk
      };
      expect(warm()).toBe(true);

      // A mutation invalidates (read-your-writes, below); the point here is
      // that the mutating command itself never READ the warm entry.
      const c = gh.graphqlCalls;
      run(["comment", "1", "-m", "x"], proc({ at: later(6) }));
      const spent = gh.graphqlCalls - c;
      expect(spent).toBeGreaterThan(1); // it walked/fetched rather than reusing

      listItemsFull(proc({ at: later(7) })); // re-warm
      const c2 = gh.graphqlCalls;
      run(["next", "--fresh"], proc({ at: later(8) }));
      expect(gh.graphqlCalls).toBeGreaterThan(c2);
    });

    it("doctor SAYS its report-only sweep was cached; --fix has nothing to say", () => {
      // "ok" about a board read 80 s ago is a different claim from "ok" about
      // one just read. CI runs cold-cache, so this line never appears there.
      doctor(proc());
      const warm = doctor(proc({ at: later(80) }));
      const note = warm.checks.find((c) => c.name === "board-read");
      expect(note).toMatchObject({ level: "info", detail: expect.stringContaining("80s old") });
      // Advisory by construction: an info line never moves the exit code.
      expect(warm.checks.filter((c) => c.level === "fail")).toEqual(
        doctor(proc({ at: later(81) })).checks.filter((c) => c.level === "fail"),
      );
      expect(doctor(proc({ at: later(82) }), { fix: true }).checks.some((c) => c.name === "board-read")).toBe(false);
    });

    it("a stale claim is still verified against a fresh single-item read", () => {
      // The guard doctor --fix applies is `claimIsStale` on a FRESH fetchIssue,
      // not on the walk. Pinned here because it is the specific place a cached
      // item reaching a guard would clear a live agent's claim.
      const old = new Date(NOW.getTime() - 200 * 60_000).toISOString();
      gh.issues.set(5, { number: 5, state: "In Progress", claim: `w5|${old}` });
      gh.refreshClaimOnFetch.add(5); // the holder renews between walk and guard
      run(["doctor", "--fix"], proc());
      expect(gh.mutations.filter((m) => m.includes("#5"))).toEqual([]);
      expect(gh.issues.get(5)!.claim).toContain("w5|");
    });
  });

  describe("carve-out 2 — session guarantees (Terry et al. 1994)", () => {
    it("read-your-writes: a mutation is visible to the next process's read", () => {
      listItemsFull(proc());
      expect(listItemsFull(proc({ at: later(5) })).cached).toBe(true);

      run(["comment", "1", "-m", "x"], proc({ at: later(10) }));

      // The very next read must not serve the pre-write walk.
      const after = listItemsFull(proc({ at: later(11) }));
      expect(after.cached).toBe(false);
    });

    it("read-your-writes survives a mutation that lands but fails to report back", () => {
      // The write happened server-side; only the RESPONSE was lost. Marking
      // solely on success would leave the pre-write walk servable, which is
      // the one case where a cache hands an agent its own stale view.
      listItemsFull(proc());
      expect(listItemsFull(proc({ at: later(5) })).cached).toBe(true);

      const doomed = proc({ at: later(10) });
      const real = doomed.exec;
      doomed.exec = (argv, stdin) => {
        const cmd = argv.join(" ");
        if (cmd.startsWith("gh api graphql") && stdin?.includes("mutation"))
          return { code: 1, stdout: "", stderr: "connection reset after the write landed" };
        return real(argv, stdin);
      };
      expect(() => run(["comment", "1", "-m", "x"], doomed)).toThrow();

      expect(listItemsFull(proc({ at: later(11) })).cached).toBe(false);
    });

    it("read-your-writes survives a walk that was already in flight", () => {
      // The race unlinking alone cannot cover: process B's walk STARTED before
      // A's write and lands after it. Start-stamped fetchedAt makes the entry
      // provably pre-write, so the epoch refuses it.
      run(["comment", "1", "-m", "x"], proc({ at: later(10) }));
      // B stamps at t+5 (before the write) and writes the file at t+20.
      const inFlight = makeCtx(gh, "me@test", "/repo", {
        cacheDir: dir,
        itemCacheTtlSec: TTL,
        now: () => later(5),
      });
      listItemsFull(inFlight);

      expect(listItemsFull(proc({ at: later(20) })).cached).toBe(false);
    });

    it("monotonic reads: an entry older than one already served is refused", () => {
      // A serves a walk stamped t+60. A concurrent writer then leaves behind an
      // entry stamped t+10 (its walk started earlier). Serving it would walk
      // the session's view backwards in time.
      listItemsFull(proc({ at: later(60) }));
      const oldWriter = makeCtx(gh, "me@test", "/repo", {
        cacheDir: dir,
        itemCacheTtlSec: TTL,
        now: () => later(10),
      });
      listItemsFull(oldWriter); // writes an entry stamped t+10

      const next = listItemsFull(proc({ at: later(61) }));
      expect(next.cached).toBe(false);
    });

    it("a fresh walk also advances the high-water mark", () => {
      // Bump the mark on cached serves only, and this sequence breaks: a fresh
      // walk at t+95 would leave servedAt at t+1, so the stale t+1 entry a slow
      // concurrent writer re-lands is still servable. Same violation, other route.
      const fresh = listItemsFull(proc({ at: later(TTL + 5) }));
      expect(fresh.cached).toBe(false);
      expect(fresh.fetchedAt).toBe(later(TTL + 5).toISOString());

      const behind = makeCtx(gh, "me@test", "/repo", {
        cacheDir: dir,
        itemCacheTtlSec: TTL,
        now: () => later(1),
      });
      listItemsFull(behind); // re-lands an entry stamped t+1

      expect(listItemsFull(proc({ at: later(TTL + 6) })).cached).toBe(false);
    });
  });

  describe("refusing what it cannot trust", () => {
    it("ignores a corrupt, wrong-version, or wrong-kind entry", () => {
      listItemsFull(proc());
      const path = entryPath("full");
      expect(existsSync(path)).toBe(true);

      writeFileSync(path, "{not json");
      expect(listItemsFull(proc({ at: later(1) })).cached).toBe(false);

      const good = JSON.parse(readFileSync(path, "utf8"));
      writeFileSync(path, JSON.stringify({ ...good, version: 99 }));
      expect(listItemsFull(proc({ at: later(2) })).cached).toBe(false);

      writeFileSync(path, JSON.stringify({ ...good, kind: "own-open" }));
      expect(listItemsFull(proc({ at: later(3) })).cached).toBe(false);
    });

    it("compares marks as instants, so an equivalent non-canonical timestamp still bars the entry", () => {
      // We write toISOString(), but these are plain JSON files in the user's
      // cache dir. `+00:00` is the SAME instant and must behave identically —
      // a lexical compare would let a barred entry through.
      listItemsFull(proc());
      const marks = join(dir, "items-marks-github.com-cdubiel08-ralph-hero-13.json");
      const entryAt = JSON.parse(
        readFileSync(join(dir, "items-full-github.com-cdubiel08-ralph-hero-13.json"), "utf8"),
      ).fetchedAt as string;
      // Same instant as the entry, written the other legal way.
      writeFileSync(marks, JSON.stringify({ epoch: entryAt.replace(".000Z", "+00:00"), servedAt: null }));
      expect(listItemsFull(proc({ at: later(5) })).cached).toBe(false);
    });

    it("treats a corrupt mark as absent rather than wedging every read", () => {
      listItemsFull(proc());
      const marks = join(dir, "items-marks-github.com-cdubiel08-ralph-hero-13.json");
      writeFileSync(marks, JSON.stringify({ epoch: "not-a-date", servedAt: "also-not" }));
      // Degrades to the ordinary Δ check, never to "refuse forever".
      expect(listItemsFull(proc({ at: later(5) })).cached).toBe(true);
    });

    it("refuses a future-dated entry rather than treating it as very fresh", () => {
      listItemsFull(proc({ at: later(3600) })); // clock step / copied file
      expect(listItemsFull(proc()).cached).toBe(false);
    });

    it("keeps the cache scoped per project", () => {
      listItemsFull(proc());
      const cost = gh.graphqlCalls;
      const otherBoard = proc({ at: later(5) });
      otherBoard.cfg = { ...otherBoard.cfg, projectNumber: 14 };
      expect(listItemsFull(otherBoard).cached).toBe(false);
      expect(gh.graphqlCalls).toBeGreaterThan(cost);
    });

    it("keeps the cache scoped per host — the field cache's key does not", () => {
      // This file carries ISSUE DATA, so a GHE board colliding with a
      // github.com board on the same owner/repo/number would hand an agent
      // another host's work queue. The harness refuses any call whose
      // --hostname is not its own, so reaching the network at all IS the proof
      // that the github.com entry was not reused.
      listItemsFull(proc());
      const ghe = proc({ at: later(5) });
      ghe.cfg = { ...ghe.cfg, host: "ghe.example.com" };
      expect(() => listItemsFull(ghe)).toThrow(/--hostname.*ghe\.example\.com/);
    });

    it("a walk that throws leaves nothing behind to serve", () => {
      gh.dropPageInfo = true;
      expect(() => listItemsFull(proc())).toThrow(/pagination metadata missing/);
      gh.dropPageInfo = false;
      expect(listItemsFull(proc({ at: later(1) })).cached).toBe(false);
    });
  });

  describe("staleness reaches the consumer", () => {
    it("--json carries {cached, fetchedAt, ageSec} and the human line says so", () => {
      const say = (argv: string[], c: Ctx) => {
        const said: string[] = [];
        const spy = vi.spyOn(process.stdout, "write").mockImplementation((s) => {
          said.push(String(s));
          return true;
        });
        try {
          run(argv, c);
        } finally {
          spy.mockRestore();
        }
        return said.join("");
      };

      expect(say(["next"], proc())).not.toContain("cached board read");
      const warm = JSON.parse(say(["next", "--json"], proc({ at: later(20) })));
      expect(warm.cache).toEqual({
        cached: true,
        fetchedAt: NOW.toISOString(),
        ageSec: 20,
      });
      expect(say(["next"], proc({ at: later(25) }))).toContain("cached board read, 25s old");
      // `frontier` shares next's lean selection, so it rides the same entry.
      expect(say(["frontier"], proc({ at: later(26) }))).toContain("cached board read");
      // `list` does NOT: it reads labels, and next's walk never fetched them.
      // It walks, and only then can it be served — pinned as its own test below.
      expect(say(["list"], proc({ at: later(27) }))).not.toContain("cached board read");
      expect(say(["list"], proc({ at: later(28) }))).toContain("cached board read");
    });

    it("an EMPTY queue says how old it is — the answer a loop acts on hardest", () => {
      const emptyGh = new FakeGh();
      const emptyDir = mkdtempSync(join(tmpdir(), "board-itemcache-empty-"));
      const emptyProc = (at: Date) =>
        makeCtx(emptyGh, "me@test", "/repo", {
          cacheDir: emptyDir,
          itemCacheTtlSec: TTL,
          now: () => at,
        });
      const say = (argv: string[], c: Ctx) => {
        const said: string[] = [];
        const spy = vi.spyOn(process.stdout, "write").mockImplementation((s) => {
          said.push(String(s));
          return true;
        });
        try {
          run(argv, c);
        } finally {
          spy.mockRestore();
        }
        return said.join("");
      };

      expect(say(["next"], emptyProc(NOW))).toContain("queue empty");
      const warm = say(["next"], emptyProc(later(40)));
      expect(warm).toContain("queue empty");
      expect(warm).toContain("cached board read, 40s old");
      expect(say(["frontier"], emptyProc(later(41)))).toContain("cached board read");
    });
  });

  describe("configuration", () => {
    it("defaults to 90s, accepts 0 as off, and refuses a value outside the band", () => {
      const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        expect(parseItemCacheTtlSec(undefined)).toBe(ITEM_CACHE_TTL_DEFAULT_SEC);
        expect(parseItemCacheTtlSec("0")).toBe(0);
        expect(parseItemCacheTtlSec("120")).toBe(120);
        expect(parseItemCacheTtlSec(String(ITEM_CACHE_TTL_MAX_SEC))).toBe(ITEM_CACHE_TTL_MAX_SEC);
        // A typo must not silently become a fiction — it warns and falls back.
        expect(parseItemCacheTtlSec("900000")).toBe(ITEM_CACHE_TTL_DEFAULT_SEC);
        expect(parseItemCacheTtlSec("90s")).toBe(ITEM_CACHE_TTL_DEFAULT_SEC);
        expect(parseItemCacheTtlSec("-1")).toBe(ITEM_CACHE_TTL_DEFAULT_SEC);
        // An empty export (this shell profile exports RALPH_* vars) reads as
        // unset, NOT as Number("") === 0 — which would silently switch the
        // cache off and leave someone measuring a fix that is not running.
        expect(parseItemCacheTtlSec("")).toBe(ITEM_CACHE_TTL_DEFAULT_SEC);
        expect(parseItemCacheTtlSec("  ")).toBe(ITEM_CACHE_TTL_DEFAULT_SEC);
      } finally {
        warn.mockRestore();
      }
    });

    it("ttl 0 neither reads nor writes", () => {
      listItemsFull(proc({ ttlSec: 0 }));
      // Nothing was stored, so a cache-enabled process still has to walk.
      expect(listItemsFull(proc({ at: later(1) })).cached).toBe(false);
    });
  });
});

describe("isMutationOp — the epoch hook's only input", () => {
  it("recognises a mutation past whitespace and comments", () => {
    expect(isMutationOp("mutation($id: ID!) { x }")).toBe(true);
    expect(isMutationOp("\n  # why\n  mutation { x }")).toBe(true);
  });

  it("treats every query form as a read, including anonymous shorthand", () => {
    // `{ … }` is a QUERY by the spec — reading it as a mutation would blow the
    // cache away on every board read and quietly delete the whole feature.
    expect(isMutationOp("{ viewer { login } }")).toBe(false);
    expect(isMutationOp("query($n: Int!) { repository { id } }")).toBe(false);
    expect(isMutationOp("  \n query { x }")).toBe(false);
    // A field named like the keyword is not the operation keyword.
    expect(isMutationOp("query { mutationCount }")).toBe(false);
  });
});
