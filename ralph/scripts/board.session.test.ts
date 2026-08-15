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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { encodeClaim, fetchIssue, readSessionBinding, transition } from "./board.js";
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
    writeFileSync(join(opts.session.dir, "sess-a.json"), "{ truncated");
    const ctx = makeCtx(gh, "me@test", "/repo", opts);
    expect(readSessionBinding(ctx)).toBeNull();
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
    expect(readdirSync(opts.session.dir)).toEqual(["sess-a.json"]);
  });

  it("a session id carrying path separators cannot escape the binding directory", () => {
    const opts = sessionOpts("../../etc/passwd");
    const ctx = makeCtx(gh, "me@test", "/repo", opts);
    transition(ctx, fetchIssue(ctx, 1), "In Progress");
    const [written] = readdirSync(opts.session.dir);
    expect(written).toBe(".._.._etc_passwd.json");
    expect(JSON.parse(readFileSync(join(opts.session.dir, written), "utf8")).issue).toBe(1);
  });
});
