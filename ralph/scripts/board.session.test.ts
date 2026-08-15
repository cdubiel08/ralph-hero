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

import { mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
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
    expect(readdirSync(opts.session.dir)).toEqual([basename(sessionBindingPath(ctx)!)]);
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
});
