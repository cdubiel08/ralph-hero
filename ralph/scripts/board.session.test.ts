/**
 * board.session.test.ts — the session→unit binding (GH-1948).
 *
 * Contract rule 9 ("one unit per session, and a finished session stops")
 * shipped as prose in GH-1924 and refused nothing. These pin the code half:
 * a second DISTINCT unit claimed from one session is refused; the same unit
 * re-claimed never is; and a session that publishes no id is not evaluated
 * rather than blocked.
 *
 * The two orderings are what the suite really exists for. The guard runs
 * BEFORE any mutation, and the binding is written only AFTER the claim's
 * read-back verify — so a session that loses a claim race stays unbound and
 * can go pick the other work it was just told to pick.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  encodeClaim,
  fetchIssue,
  readSessionBinding,
  sessionBindingPath,
  transition,
  worktreeLockPath,
} from "./board.js";
import { FakeGh, makeCtx, NOW, refusalMessage } from "./board.testkit.js";

function sessionOpts(id: string | null) {
  return { session: { id, dir: mkdtempSync(join(tmpdir(), "board-session-")) } };
}

describe("session→unit binding (GH-1948)", () => {
  let gh: FakeGh;
  beforeEach(() => {
    gh = new FakeGh();
    gh.issues.set(1, { number: 1, state: "Backlog" });
    gh.issues.set(2, { number: 2, state: "Backlog" });
  });

  it("records the unit on a successful claim", () => {
    const ctx = makeCtx(gh, "me@test", "/repo", sessionOpts("sess-a"));
    transition(ctx, fetchIssue(ctx, 1), "In Progress");
    expect(readSessionBinding(ctx)).toEqual({
      issue: 1,
      since: NOW.toISOString(),
      holder: "me@test",
      worktree: "/repo",
    });
  });

  it("refuses a SECOND, distinct unit from the same session — and mutates nothing", () => {
    const opts = sessionOpts("sess-a");
    const ctx = makeCtx(gh, "me@test", "/repo", opts);
    transition(ctx, fetchIssue(ctx, 1), "In Progress");

    const msg = refusalMessage(() => transition(ctx, fetchIssue(ctx, 2), "In Progress"));
    expect(msg).toContain("already drove #1");
    expect(msg).toContain("rule 9");
    // The guard is a PRE-check: #2 must be untouched, not half-claimed.
    expect(gh.issues.get(2)!.state).toBe("Backlog");
    expect(gh.issues.get(2)!.claim).toBeUndefined();
    expect(readSessionBinding(ctx)!.issue).toBe(1); // binding unchanged
  });

  it("never refuses a RE-claim of the same unit, and keeps the original since", () => {
    const opts = sessionOpts("sess-a");
    const first = makeCtx(gh, "me@test", "/repo", opts);
    transition(first, fetchIssue(first, 1), "In Progress");

    // Resume 30 min later (heartbeat, or return from Human Needed).
    const later = new Date(NOW.getTime() + 30 * 60_000);
    const resumed = makeCtx(gh, "me@test", "/repo", { ...opts, now: () => later });
    expect(() => transition(resumed, fetchIssue(resumed, 1), "In Progress")).not.toThrow();
    // The board's claim heartbeats; the BINDING's since stays first-claim time.
    expect(gh.issues.get(1)!.claim).toBe(encodeClaim("me@test", later));
    expect(readSessionBinding(resumed)!.since).toBe(NOW.toISOString());
  });

  it("a DIFFERENT session on the same machine is unaffected — this is not a machine lock", () => {
    const a = makeCtx(gh, "me@test", "/repo", sessionOpts("sess-a"));
    const b = makeCtx(gh, "me@test", "/repo", sessionOpts("sess-b"));
    transition(a, fetchIssue(a, 1), "In Progress");
    expect(() => transition(b, fetchIssue(b, 2), "In Progress")).not.toThrow();
    expect(gh.issues.get(2)!.state).toBe("In Progress");
  });

  it("a session with no id is NOT EVALUATED — it claims freely and records nothing", () => {
    const ctx = makeCtx(gh, "me@test", "/repo", sessionOpts(null));
    transition(ctx, fetchIssue(ctx, 1), "In Progress");
    transition(ctx, fetchIssue(ctx, 2), "In Progress");
    expect(gh.issues.get(2)!.state).toBe("In Progress");
    expect(readSessionBinding(ctx)).toBeNull();
  });

  it("a Ctx that declares no session at all leaves the guard inert (absent ≠ policy)", () => {
    const ctx = makeCtx(gh); // no session field — every pre-GH-1948 caller
    transition(ctx, fetchIssue(ctx, 1), "In Progress");
    expect(() => transition(ctx, fetchIssue(ctx, 2), "In Progress")).not.toThrow();
  });

  it("a garbled binding record reads as not-evaluated rather than blocking the session", () => {
    const opts = sessionOpts("sess-a");
    const ctx = makeCtx(gh, "me@test", "/repo", opts);
    writeFileSync(sessionBindingPath(ctx)!, "{ truncated");
    expect(readSessionBinding(ctx)).toBeNull();
    // A garbled record must not wedge the session either: the exclusive create
    // finds it present, re-reads it as unusable, and lets the claim stand.
    expect(() => transition(ctx, fetchIssue(ctx, 1), "In Progress")).not.toThrow();
  });

  it("losing the claim race leaves the session UNBOUND — it can still take other work", () => {
    // The read-back echo shows a rival holding #1, so transition refuses. The
    // binding must not have been written, or the session would now be barred
    // from the "pick other work" its own refusal just instructed.
    const opts = sessionOpts("sess-a");
    const ctx = makeCtx(gh, "me@test", "/repo", opts);
    const rival = encodeClaim("rival@host", NOW);
    const realExec = gh.exec.bind(gh);
    let wrote = false;
    gh.exec = (argv, stdin) => {
      const res = realExec(argv, stdin);
      if (!wrote && gh.issues.get(1)!.claim === encodeClaim("me@test", NOW)) {
        gh.issues.get(1)!.claim = rival; // rival's write lands last
        wrote = true;
      }
      return res;
    };
    expect(refusalMessage(() => transition(ctx, fetchIssue(ctx, 1), "In Progress"))).toContain(
      "lost the claim race",
    );
    expect(readSessionBinding(ctx)).toBeNull();
  });

  it("prunes binding records older than the 7-day window, keeping fresh ones", () => {
    const opts = sessionOpts("sess-a");
    const stale = join(opts.session.dir, "sess-ancient.json");
    writeFileSync(stale, JSON.stringify({ issue: 99, since: "x", holder: "old@host" }));
    const longAgo = (NOW.getTime() - 30 * 86_400_000) / 1000;
    utimesSync(stale, longAgo, longAgo);

    const ctx = makeCtx(gh, "me@test", "/repo", opts);
    transition(ctx, fetchIssue(ctx, 1), "In Progress");
    expect(readdirSync(opts.session.dir).sort()).toEqual(
      [basename(sessionBindingPath(ctx)!), basename(worktreeLockPath(ctx, 1)!)].sort(),
    );
  });

  it("a session id carrying path separators cannot escape the binding directory", () => {
    const opts = sessionOpts("../../etc/passwd");
    const ctx = makeCtx(gh, "me@test", "/repo", opts);
    transition(ctx, fetchIssue(ctx, 1), "In Progress");
    const [written] = readdirSync(opts.session.dir);
    expect(written).toMatch(/^\.\._\.\._etc_passwd-[0-9a-f]{16}\.json$/);
    expect(JSON.parse(readFileSync(join(opts.session.dir, written), "utf8")).issue).toBe(1);
  });

  it("ids that SANITIZE alike still get distinct records — a collision is a false refusal", () => {
    const dir = mkdtempSync(join(tmpdir(), "board-session-"));
    const slash = makeCtx(gh, "me@test", "/repo", { session: { id: "a/b", dir } });
    const under = makeCtx(gh, "me@test", "/repo", { session: { id: "a_b", dir } });
    expect(sessionBindingPath(slash)).not.toBe(sessionBindingPath(under));
    transition(slash, fetchIssue(slash, 1), "In Progress");
    expect(() => transition(under, fetchIssue(under, 2), "In Progress")).not.toThrow();
  });

  it("a concurrent claim that races the guard is refused by the exclusive create, not last-write-wins", () => {
    // Both siblings read an ABSENT binding and pass the guard; the sibling's
    // record lands while this one is mid-claim. Without the exclusive create
    // the later write would silently overwrite it, leaving one session holding
    // two claimed issues and a record naming only one — rule 9 defeated by a
    // race rather than by prose. Replayed by writing the sibling's record from
    // inside the claim's own exec, which is exactly that interleaving.
    const opts = sessionOpts("sess-a");
    const ctx = makeCtx(gh, "me@test", "/repo", opts);
    const siblingRecord = JSON.stringify({ issue: 1, since: NOW.toISOString(), holder: "me@test" });
    const issue2 = fetchIssue(ctx, 2); // fetched BEFORE the hook — the guard
    const realExec = gh.exec.bind(gh); // must still read an absent binding
    let raced = false;
    gh.exec = (argv, stdin) => {
      const res = realExec(argv, stdin);
      if (!raced) {
        raced = true;
        writeFileSync(sessionBindingPath(ctx)!, siblingRecord);
      }
      return res;
    };

    const msg = refusalMessage(() => transition(ctx, issue2, "In Progress"));
    expect(msg).toContain("CONCURRENT claim");
    expect(msg).toContain("bound it to #1");
    expect(readSessionBinding(ctx)!.issue).toBe(1); // the sibling's record survives
    // And the claim this command took is UNWOUND: leaving #2 In Progress under
    // a claim nobody drives would cost the queue a full TTL.
    expect(msg).toContain('rolled back to "Backlog"');
    expect(gh.issues.get(2)!.state).toBe("Backlog");
    expect(gh.issues.get(2)!.claim).toBeNull();
  });

  it("the unwind refuses to clobber an item another writer took over in the meantime", () => {
    // Same race, but a rival's claim lands between the read-back verify and
    // the unwind. Restoring unconditionally would clear a claim that is not
    // ours and regress work this session cannot see.
    const opts = sessionOpts("sess-a");
    const ctx = makeCtx(gh, "me@test", "/repo", opts);
    const siblingRecord = JSON.stringify({ issue: 1, since: NOW.toISOString(), holder: "me@test" });
    const rival = encodeClaim("rival@host", NOW);
    const issue2 = fetchIssue(ctx, 2);
    // Ordering matters and is exact. The sibling's record must land AFTER the
    // read-back verify (before it, the existing lost-the-race guard fires and
    // the unwind never runs), and the rival must take the item after that —
    // on the fetch the UNWIND itself makes. Both are keyed off the read/write
    // shape of the call rather than a call index, which drifts.
    const realExec = gh.exec.bind(gh);
    let mutated = false; // the claim/state writes have gone out
    let bound = false; // the sibling's record is on disk
    gh.exec = (argv, stdin) => {
      const isMutation = String(stdin ?? "").includes("mutation");
      if (bound) gh.issues.get(2)!.claim = rival; // the unwind's fetch sees a rival
      const res = realExec(argv, stdin);
      if (isMutation) mutated = true;
      else if (mutated && !bound) {
        // The first READ after the writes is the read-back verify: it has just
        // confirmed our claim, so the bind is next and must collide.
        writeFileSync(sessionBindingPath(ctx)!, siblingRecord);
        bound = true;
      }
      return res;
    };

    const msg = refusalMessage(() => transition(ctx, issue2, "In Progress"));
    expect(msg).toContain("NOT rolled back");
    expect(gh.issues.get(2)!.claim).toBe(rival); // the rival's claim survives
  });

  it("the unwind matches the claim it WROTE, not merely the holder — a sibling refresh survives", () => {
    // Every session on this machine writes the same `user@host` holder, so a
    // holder test cannot tell our own write from a sibling's refresh landing
    // between the verify and the unwind. The claim's `since` can: any refresh
    // replaces it. Without that, the sibling's claim is cleared and its work
    // regressed to Backlog.
    const opts = sessionOpts("sess-a");
    const ctx = makeCtx(gh, "me@test", "/repo", opts);
    const siblingRecord = JSON.stringify({ issue: 1, since: NOW.toISOString(), holder: "me@test" });
    const refreshed = encodeClaim("me@test", new Date(NOW.getTime() + 60_000));
    const issue2 = fetchIssue(ctx, 2);
    const realExec = gh.exec.bind(gh);
    let mutated = false;
    let bound = false;
    gh.exec = (argv, stdin) => {
      // Same holder, same In Progress state — only `since` differs.
      if (bound) gh.issues.get(2)!.claim = refreshed;
      const isMutation = String(stdin ?? "").includes("mutation");
      const res = realExec(argv, stdin);
      if (isMutation) mutated = true;
      else if (mutated && !bound) {
        writeFileSync(sessionBindingPath(ctx)!, siblingRecord);
        bound = true;
      }
      return res;
    };

    const msg = refusalMessage(() => transition(ctx, issue2, "In Progress"));
    expect(msg).toContain("NOT rolled back");
    expect(gh.issues.get(2)!.claim).toBe(refreshed); // the sibling keeps it
    expect(gh.issues.get(2)!.state).toBe("In Progress"); // and is not regressed
  });

  it("a half-failed unwind leaves a STALE CLAIM, never claimless work in progress", () => {
    // The unwind is two writes. If the claim were cleared first and the state
    // restore then failed, the item would sit In Progress holding no claim —
    // work nobody owns and no sweep repairs — while the refusal claimed the
    // opposite. State first makes the survivable half the one that survives.
    const opts = sessionOpts("sess-a");
    const ctx = makeCtx(gh, "me@test", "/repo", opts);
    const siblingRecord = JSON.stringify({ issue: 1, since: NOW.toISOString(), holder: "me@test" });
    const issue2 = fetchIssue(ctx, 2);
    const realExec = gh.exec.bind(gh);
    let mutated = false;
    let bound = false;
    gh.exec = (argv, stdin) => {
      const body = String(stdin ?? "");
      const isMutation = body.includes("mutation");
      // Fail the CLAIM-clearing half of the unwind only.
      if (bound && isMutation && body.includes("clearProjectV2ItemFieldValue")) {
        throw new Error("simulated field-clear failure");
      }
      const res = realExec(argv, stdin);
      if (isMutation) mutated = true;
      else if (mutated && !bound) {
        writeFileSync(sessionBindingPath(ctx)!, siblingRecord);
        bound = true;
      }
      return res;
    };

    const msg = refusalMessage(() => transition(ctx, issue2, "In Progress"));
    expect(msg).toContain("FAILED");
    // The residue sits at Backlog carrying a claim, which `release` CANNOT
    // clear (Backlog → Backlog is not a legal transition), so the message must
    // not name it. It names what actually resolves this: TTL, doctor's
    // anomaly line, and a re-claim from the same holder.
    expect(msg).toContain("claim anomaly");
    expect(msg).toContain("TTL");
    expect(msg).not.toContain("release");
    expect(gh.issues.get(2)!.state).toBe("Backlog");
    expect(gh.issues.get(2)!.claim).toBe(encodeClaim("me@test", NOW));
  });
});

/**
 * The second writer in one worktree (GH-1956).
 *
 * A fork pane (`claude --resume <id> --fork-session`) is a NEW session id in
 * the SOURCE'S worktree, so the rule-9 binding above sees an unbound session
 * and the board's `user@host` holder is identical for both panes. These pin
 * the rule that closes it — keyed on the WORKTREE, because that is what is
 * actually shared, and expiring on the CLAIM TTL, because "the source is gone"
 * already has exactly one definition on this board.
 */
describe("second writer in one worktree (GH-1956)", () => {
  let gh: FakeGh;
  let dir: string;
  beforeEach(() => {
    gh = new FakeGh();
    gh.issues.set(1, { number: 1, state: "Backlog" });
    gh.issues.set(2, { number: 2, state: "Backlog" });
    dir = mkdtempSync(join(tmpdir(), "board-session-"));
  });

  const at = (id: string, repoRoot = "/repo") =>
    makeCtx(gh, "me@test", repoRoot, { session: { id, dir } });

  it("refuses a fork claiming the unit its source is driving — and mutates nothing", () => {
    const source = at("source");
    transition(source, fetchIssue(source, 1), "In Progress");
    const fork = at("fork");
    const msg = refusalMessage(() => transition(fork, fetchIssue(fork, 1), "In Progress"));
    expect(msg).toContain("this worktree");
    expect(msg).toContain("/repo");
    expect(msg).toContain("--steal");
    // A pre-check: the source's claim and state are untouched by the refusal.
    expect(gh.issues.get(1)!.state).toBe("In Progress");
    expect(readSessionBinding(fork)).toBeNull();
  });

  it("permits the fork once the source's record has aged past the claim TTL", () => {
    const source = at("source");
    transition(source, fetchIssue(source, 1), "In Progress");
    // Same clock the board uses to call a claim stealable — nothing longer.
    const old = new Date(NOW.getTime() - 121 * 60_000);
    utimesSync(worktreeLockPath(source, 1)!, old, old);
    gh.issues.get(1)!.claim = encodeClaim("me@test", old);

    const fork = at("fork");
    expect(() => transition(fork, fetchIssue(fork, 1), "In Progress")).not.toThrow();
    expect(readSessionBinding(fork)!.issue).toBe(1);
  });

  it("does not refuse a session in a DIFFERENT worktree", () => {
    const source = at("source", "/repo-a");
    transition(source, fetchIssue(source, 1), "In Progress");
    const other = at("other", "/repo-b");
    expect(() => transition(other, fetchIssue(other, 1), "In Progress")).not.toThrow();
  });

  it("does not refuse the source's own heartbeat re-claim", () => {
    const source = at("source");
    transition(source, fetchIssue(source, 1), "In Progress");
    expect(() => transition(source, fetchIssue(source, 1), "In Progress")).not.toThrow();
  });

  it("is not evaluated against a pre-GH-1956 record that names no worktree", () => {
    // A record written by an older board.ts asserts nothing about where it ran,
    // and inferring one would be a guess that costs a false refusal.
    const source = at("source");
    writeFileSync(
      sessionBindingPath(source)!,
      JSON.stringify({ issue: 1, since: NOW.toISOString(), holder: "me@test" }),
    );
    const fork = at("fork");
    expect(() => transition(fork, fetchIssue(fork, 1), "In Progress")).not.toThrow();
  });

  it("says nothing about a peer driving a DIFFERENT unit from the same worktree", () => {
    const source = at("source");
    transition(source, fetchIssue(source, 1), "In Progress");
    const fork = at("fork");
    expect(() => transition(fork, fetchIssue(fork, 2), "In Progress")).not.toThrow();
  });

  it("--steal is the escape hatch — the operator asserting the other driver is gone", () => {
    // A session killed mid-unit and resumed in its own worktree is the common
    // honest case. It must not have to wait out a TTL to say something the
    // claim vocabulary already lets it say.
    const source = at("source");
    transition(source, fetchIssue(source, 1), "In Progress");
    const resumed = at("resumed");
    expect(() =>
      transition(resumed, fetchIssue(resumed, 1), "In Progress", { steal: true }),
    ).not.toThrow();
    expect(readSessionBinding(resumed)!.issue).toBe(1);
  });
});

/**
 * The race the pre-check cannot see (GH-1956, review finding).
 *
 * Two DISTINCT sessions in one worktree both read the binding directory before
 * either record exists, so both pass the pre-check — and each then writes its
 * OWN file, so the exclusive create that settles the GH-1948 sibling race
 * (one file, two writers) never fires. Settled after the write instead, by a
 * total order both sessions compute identically.
 */
describe("worktree race between distinct sessions (GH-1956)", () => {
  let gh: FakeGh;
  let dir: string;
  beforeEach(() => {
    gh = new FakeGh();
    gh.issues.set(1, { number: 1, state: "Backlog" });
    dir = mkdtempSync(join(tmpdir(), "board-session-"));
  });

  const at = (id: string) => makeCtx(gh, "me@test", "/repo", { session: { id, dir } });

  it("settles a race the pre-check cannot see — the lock is taken after the claim", () => {
    // Both sessions read an empty directory before either owner exists, so the
    // pre-check clears both. What decides it is the exclusive create: the file
    // is named for (worktree, unit), so exactly one creator wins and the loser
    // reads back someone else's name.
    const second = at("second");
    const realExec = gh.exec.bind(gh);
    let planted = false;
    gh.exec = (argv, stdin) => {
      const res = realExec(argv, stdin);
      if (!planted && String(stdin ?? "").includes("mutation")) {
        writeFileSync(
          worktreeLockPath(second, 1)!,
          JSON.stringify({
            session: "first",
            issue: 1,
            worktree: "/repo",
            since: NOW.toISOString(),
          }),
        );
        planted = true;
      }
      return res;
    };
    const msg = refusalMessage(() => transition(second, fetchIssue(second, 1), "In Progress"));
    expect(msg).toContain("this worktree");
    // The winner's lock is untouched, and the board needs no unwind — same
    // holder, same claim field, so it is already correct.
    expect(JSON.parse(readFileSync(worktreeLockPath(second, 1)!, "utf8")).session).toBe("first");
    expect(gh.issues.get(1)!.state).toBe("In Progress");
  });

  it("the winner is not refused by its own lock on a heartbeat re-claim", () => {
    const first = at("first");
    transition(first, fetchIssue(first, 1), "In Progress");
    expect(() => transition(first, fetchIssue(first, 1), "In Progress")).not.toThrow();
    expect(JSON.parse(readFileSync(worktreeLockPath(first, 1)!, "utf8")).session).toBe("first");
  });

  it("--steal displaces the lock, and the guard stays armed behind it", () => {
    const source = at("source");
    transition(source, fetchIssue(source, 1), "In Progress");
    const resumed = at("resumed");
    transition(resumed, fetchIssue(resumed, 1), "In Progress", { steal: true });
    expect(JSON.parse(readFileSync(worktreeLockPath(resumed, 1)!, "utf8")).session).toBe("resumed");

    // A third session is refused by the REPLACEMENT's lock — proof the guard is
    // still armed, not that --steal disabled it.
    const third = at("third");
    expect(refusalMessage(() => transition(third, fetchIssue(third, 1), "In Progress"))).toContain(
      "this worktree",
    );
  });

  it("--steal displaces only the lock it SAW — a concurrent stealer is refused", () => {
    // Two stealers otherwise each unlink the other's lock after the other's
    // read-back has already returned, and both succeed. A lock that appeared
    // after the pre-check belongs to a session --steal never spoke to: it did
    // not exist when the operator made the assertion, so it is not displaced.
    const stealer = at("stealer"); // pre-check sees an EMPTY directory
    const realExec = gh.exec.bind(gh);
    let planted = false;
    gh.exec = (argv, stdin) => {
      const res = realExec(argv, stdin);
      if (!planted && String(stdin ?? "").includes("mutation")) {
        planted = true;
        writeFileSync(
          worktreeLockPath(stealer, 1)!,
          JSON.stringify({
            session: "rival",
            issue: 1,
            worktree: "/repo",
            since: NOW.toISOString(),
          }),
        );
      }
      return res;
    };
    const msg = refusalMessage(() =>
      transition(stealer, fetchIssue(stealer, 1), "In Progress", { steal: true }),
    );
    expect(msg).toContain("this worktree");
    expect(JSON.parse(readFileSync(worktreeLockPath(stealer, 1)!, "utf8")).session).toBe("rival");
  });

  it("a --steal that LOSES the claim race must not erase the incumbent's lock", () => {
    // Acting in the pre-check would disarm the guard on the way out: the
    // incumbent may still be driving the checkout, and the next session would
    // then claim with no flag at all.
    const source = at("source");
    transition(source, fetchIssue(source, 1), "In Progress");
    const before = readFileSync(worktreeLockPath(source, 1)!, "utf8");

    const stealer = at("stealer");
    const realExec = gh.exec.bind(gh);
    let wrote = false;
    gh.exec = (argv, stdin) => {
      const res = realExec(argv, stdin);
      if (!wrote && gh.issues.get(1)!.claim?.startsWith("me@test")) {
        gh.issues.get(1)!.claim = encodeClaim("rival@host", NOW);
        wrote = true;
      }
      return res;
    };
    expect(
      refusalMessage(() =>
        transition(stealer, fetchIssue(stealer, 1), "In Progress", { steal: true }),
      ),
    ).toContain("claimed by rival@host");
    expect(readFileSync(worktreeLockPath(source, 1)!, "utf8")).toBe(before);
  });

  it("the lock lands atomically — a peer never reads a half-written record", () => {
    // A reader that catches a partial file scores it as NO OWNER, and two
    // sessions then both succeed. Hence write-then-link(2), which is atomic AND
    // fails EEXIST, rather than an exclusive-but-non-atomic write.
    const ctx = at("solo");
    transition(ctx, fetchIssue(ctx, 1), "In Progress");
    expect(readdirSync(dir).some((n) => n.endsWith(".tmp"))).toBe(false);
    expect(JSON.parse(readFileSync(worktreeLockPath(ctx, 1)!, "utf8"))).toMatchObject({
      session: "solo",
      issue: 1,
      worktree: "/repo",
    });
  });
  it("serializes displacement — a second displacer refuses rather than racing", () => {
    // Displacement is validate-then-replace, two steps POSIX cannot fuse. Two
    // sessions validating the same incumbent could otherwise each unlink the
    // other's replacement after it landed, and both pass their own read-back.
    const source = at("source");
    transition(source, fetchIssue(source, 1), "In Progress");
    const lock = worktreeLockPath(source, 1)!;
    // Another displacer is mid-section.
    writeFileSync(
      `${lock}.mu`,
      JSON.stringify({ session: "other", issue: 1, worktree: "/repo", since: NOW.toISOString() }),
    );
    const stealer = at("stealer");
    expect(
      refusalMessage(() =>
        transition(stealer, fetchIssue(stealer, 1), "In Progress", { steal: true }),
      ),
    ).toContain("this worktree");
    expect(JSON.parse(readFileSync(lock, "utf8")).session).toBe("source");
  });

  it("a killed displacer fails CLOSED, and the refusal names the file that clears it", () => {
    // The mutex deliberately has NO expiry: recovering one by unlinking the
    // path lets two recoverers each delete the other's fresh mutex and both
    // enter — the race the mutex exists to remove, reintroduced by its own
    // escape hatch. The bounded price is this: displacement in ONE worktree
    // blocks until a human deletes one named file. First claims, other units
    // and other worktrees are untouched.
    const source = at("source");
    transition(source, fetchIssue(source, 1), "In Progress");
    const lock = worktreeLockPath(source, 1)!;
    writeFileSync(
      `${lock}.mu`,
      JSON.stringify({ session: "dead", issue: 1, worktree: "/repo", since: NOW.toISOString() }),
    );
    const old = new Date(NOW.getTime() - 5 * 60_000);
    utimesSync(`${lock}.mu`, old, old);

    const stealer = at("stealer");
    const msg = refusalMessage(() =>
      transition(stealer, fetchIssue(stealer, 1), "In Progress", { steal: true }),
    );
    expect(msg).toContain(`${lock}.mu`); // the remedy is named, not implied
    expect(JSON.parse(readFileSync(lock, "utf8")).session).toBe("source");

    // A different unit in the same worktree is unaffected — the block is scoped
    // to the one lock, not to the checkout.
    gh.issues.set(2, { number: 2, state: "Backlog" });
    const other = at("other");
    expect(() => transition(other, fetchIssue(other, 2), "In Progress")).not.toThrow();
  });
});

describe("release clears the session's own worktree lock (GH-2107)", () => {
  let gh: FakeGh;
  let dir: string;
  beforeEach(() => {
    gh = new FakeGh();
    gh.issues.set(1, { number: 1, state: "Backlog" });
    dir = mkdtempSync(join(tmpdir(), "board-session-"));
  });

  const at = (id: string | null) => makeCtx(gh, "me@test", "/repo", { session: { id, dir } });

  it("release deletes the lock — the unit is immediately spawnable, not TTL-parked", () => {
    const ctx = at("driver");
    transition(ctx, fetchIssue(ctx, 1), "In Progress");
    expect(existsSync(worktreeLockPath(ctx, 1)!)).toBe(true);

    transition(ctx, fetchIssue(ctx, 1), "Backlog", { why: "handing back to the pool" });
    expect(existsSync(worktreeLockPath(ctx, 1)!)).toBe(false);

    // A fresh session claims immediately — no --steal, no TTL wait. This is
    // the reproduced GH-2107 flow: answer → release → fleet spawn.
    const next = at("next-session");
    expect(() => transition(next, fetchIssue(next, 1), "In Progress")).not.toThrow();
    expect(gh.issues.get(1)!.state).toBe("In Progress");
  });

  it("never deletes a PEER's lock — a non-owning demoter leaves the live driver's guard armed", () => {
    const driver = at("driver");
    transition(driver, fetchIssue(driver, 1), "In Progress");

    // A different session on the same machine passes guardHolder (the board
    // holder is user@host for both) and demotes — the lock is not its to take.
    const other = at("other");
    transition(other, fetchIssue(other, 1), "Backlog", { why: "parking from elsewhere" });
    expect(JSON.parse(readFileSync(worktreeLockPath(driver, 1)!, "utf8")).session).toBe("driver");
  });

  it("In Progress → In Review KEEPS the lock — deliver's lease outlives the claim (GH-1929)", () => {
    const ctx = at("driver");
    transition(ctx, fetchIssue(ctx, 1), "In Progress");
    transition(ctx, fetchIssue(ctx, 1), "In Review");
    expect(existsSync(worktreeLockPath(ctx, 1)!)).toBe(true);
  });

  it("a session with no id is NOT EVALUATED — the release proceeds and deletes nothing", () => {
    const owner = at("driver");
    transition(owner, fetchIssue(owner, 1), "In Progress");

    const anon = at(null);
    expect(() =>
      transition(anon, fetchIssue(anon, 1), "Backlog", { why: "anonymous release" }),
    ).not.toThrow();
    expect(existsSync(worktreeLockPath(owner, 1)!)).toBe(true);
  });
});
