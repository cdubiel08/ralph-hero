/**
 * board.leases.test.ts — dead vs stale local leases (GH-2108).
 *
 * The subject is `readLocalLeases` and the three surfaces over it: `who`
 * (machine-wide, withholds nothing), `brief` (repo-scoped, withholds and says
 * so), and `reap-leases` (the only writer). The distinction every case here
 * defends is that a lock whose CHECKOUT is gone is dead — unrefreshable by
 * anything — while a lock that is merely past its TTL may still have a holder
 * coming back, and the two rendered identically until this issue.
 *
 * Real directories and real git worktrees throughout: the classification is a
 * filesystem question, and a fake fs would let the code agree with itself
 * about what "gone" means.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  localSessionLease,
  partitionBriefLeases,
  readLocalLeases,
  reapDeadLeases,
  realExec,
  run,
  type Ctx,
  type LeaseRow,
} from "./board.js";
import { FakeGh, makeCtx } from "./board.testkit.js";

const TTL = 120;
const NOW = new Date("2026-08-22T12:00:00Z");

let root: string;
let sessions: string;

/** A real git repo, and optionally a linked worktree of it — the only way to
 *  exercise the common-dir comparison honestly. */
function gitRepo(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => {
    const r = realExec(["git", "-C", dir, ...args]);
    if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git("init", "-q");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "fixture");
  return dir;
}

function linkedWorktree(repo: string, leaf: string): string {
  const wt = join(root, "worktrees", leaf);
  const r = realExec(["git", "-C", repo, "worktree", "add", "-q", "-b", leaf, wt]);
  if (r.code !== 0) throw new Error(`worktree add: ${r.stderr}`);
  return wt;
}

let seq = 0;
/** Write a lock in the shape `worktreeLockPath` publishes. The digest is not
 *  re-derived here — the reader only ever matches its shape. */
function writeLock(issue: number, worktree: string, opts: { session?: string; ageMin?: number } = {}): string {
  const digest = (seq++).toString(16).padStart(16, "0");
  const file = join(sessions, `wt-${issue}-${digest}.json`);
  writeFileSync(
    file,
    JSON.stringify({ session: opts.session ?? "peer", issue, worktree, since: "2026-08-22T09:00:00Z" }),
  );
  const t = new Date(NOW.getTime() - (opts.ageMin ?? 0) * 60_000);
  utimesSync(file, t, t);
  return file;
}

function ctxFor(repoRoot: string, sessionId = "mine"): Ctx {
  return makeCtx(new FakeGh(), "me@test", repoRoot, {
    session: { id: sessionId, dir: sessions },
    now: () => NOW,
  } as never);
}

function capture(fn: () => number): { code: number; out: string } {
  const chunks: string[] = [];
  const orig = process.stdout.write;
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    chunks.push(s);
    return true;
  };
  try {
    return { code: fn(), out: chunks.join("") };
  } finally {
    (process.stdout as unknown as { write: typeof orig }).write = orig;
  }
}

const forIssue = (rows: LeaseRow[] | null, n: number): LeaseRow => {
  const r = rows?.find((x) => x.issue === n);
  if (!r) throw new Error(`no lease row for #${n}`);
  return r;
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ralph-leases-"));
  sessions = join(root, "sessions");
  mkdirSync(sessions, { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("readLocalLeases — a deleted checkout is DEAD, not stale (GH-2108)", () => {
  it("classifies a present checkout as present, whatever its age", () => {
    const repo = gitRepo("repo-a");
    writeLock(11, repo, { ageMin: TTL + 60 });
    const row = forIssue(readLocalLeases(ctxFor(repo)), 11);
    expect(row.worktreeState).toBe("present");
    // Still stale — the TTL question is untouched for a checkout that exists.
    expect(row.stale).toBe(true);
  });

  it("classifies a deleted checkout as missing even while the lock is FRESH", () => {
    // The case a TTL-multiple expiry would get wrong: a sweep removes an idle
    // session's checkout minutes after its last heartbeat, and the lock is
    // inside its window while being unrefreshable forever.
    const repo = gitRepo("repo-a");
    const gone = join(root, "worktrees", "swept");
    mkdirSync(gone, { recursive: true });
    writeLock(12, gone, { ageMin: 1 });
    expect(forIssue(readLocalLeases(ctxFor(repo)), 12).stale).toBe(false);
    rmSync(gone, { recursive: true, force: true });
    const row = forIssue(readLocalLeases(ctxFor(repo)), 12);
    expect(row.worktreeState).toBe("missing");
    expect(row.stale).toBe(false);
  });

  it("a path that fails to read for any reason OTHER than absence is unknown, never missing", () => {
    // ENOTDIR: the parent is a file. Unreadable is not evidence of removal,
    // and only `missing` is ever reaped or withheld.
    const repo = gitRepo("repo-a");
    const file = join(root, "a-file");
    writeFileSync(file, "not a directory");
    writeLock(13, join(file, "below"));
    expect(forIssue(readLocalLeases(ctxFor(repo)), 13).worktreeState).toBe("unknown");
  });

  it("a record with no worktree path is unknown rather than missing", () => {
    const repo = gitRepo("repo-a");
    writeLock(14, "");
    expect(forIssue(readLocalLeases(ctxFor(repo)), 14).worktreeState).toBe("unknown");
  });
});

describe("readLocalLeases — which repo a checkout belongs to (GH-2108)", () => {
  it("a linked worktree of the configured repo is sameRepo, and its main checkout is too", () => {
    const repo = gitRepo("repo-a");
    const wt = linkedWorktree(repo, "feat-1-x");
    writeLock(21, wt);
    writeLock(22, repo);
    const rows = readLocalLeases(ctxFor(wt));
    expect(forIssue(rows, 21).sameRepo).toBe(true);
    expect(forIssue(rows, 22).sameRepo).toBe(true);
  });

  it("another repo's worktree is NOT sameRepo — its #N names a different issue", () => {
    const mine = gitRepo("repo-a");
    const other = gitRepo("repo-b");
    writeLock(76, linkedWorktree(other, "feat-76-y"));
    expect(forIssue(readLocalLeases(ctxFor(mine)), 76).sameRepo).toBe(false);
  });

  it("a checkout that is gone, or is not a git repo at all, is sameRepo null — unknown, never foreign", () => {
    const mine = gitRepo("repo-a");
    const plain = join(root, "not-a-repo");
    mkdirSync(plain, { recursive: true });
    writeLock(31, join(root, "never-existed"));
    writeLock(32, plain);
    const rows = readLocalLeases(ctxFor(mine));
    expect(forIssue(rows, 31).sameRepo).toBeNull();
    expect(forIssue(rows, 32).sameRepo).toBeNull();
  });

  it("an unresolvable own repoRoot leaves every row unknown rather than marking them all foreign", () => {
    const other = gitRepo("repo-b");
    writeLock(41, linkedWorktree(other, "feat-41-z"));
    const rows = readLocalLeases(ctxFor(join(root, "no-such-root")));
    expect(forIssue(rows, 41).sameRepo).toBeNull();
  });
});

describe("localSessionLease — cross-repo isolation (GH-2293)", () => {
  it("a sibling repo's lock on the same issue number is not a hold — issue numbers are per-repo", () => {
    const mine = gitRepo("repo-a");
    const other = gitRepo("repo-b");
    writeLock(76, linkedWorktree(other, "feat-76-y"));
    expect(localSessionLease(ctxFor(mine))!(76)).toBeNull();
  });

  it("a lock on our own repo's worktree for the same number still blocks", () => {
    const mine = gitRepo("repo-a");
    const wt = linkedWorktree(mine, "feat-76-y");
    writeLock(76, wt);
    expect(localSessionLease(ctxFor(mine))!(76)).not.toBeNull();
  });

  it("a checkout that is gone keeps blocking — unresolvable is not evidence of a different repo", () => {
    const mine = gitRepo("repo-a");
    writeLock(76, join(root, "never-existed"));
    expect(localSessionLease(ctxFor(mine))!(76)).not.toBeNull();
  });

  it("an unresolvable own repoRoot keeps blocking too — the fail-safe direction, over-block never under", () => {
    const other = gitRepo("repo-b");
    writeLock(76, linkedWorktree(other, "feat-76-y"));
    expect(localSessionLease(ctxFor(join(root, "no-such-root")))!(76)).not.toBeNull();
  });
});

describe("partitionBriefLeases — the repo-scoped cut (GH-2108)", () => {
  const row = (over: Partial<LeaseRow>): LeaseRow => ({
    issue: 1,
    session: "peer",
    worktree: "/wt",
    since: "2026-08-22T09:00:00Z",
    expiresAt: "2026-08-22T13:00:00Z",
    stale: false,
    ours: false,
    file: "/sessions/wt-1-0000000000000000.json",
    worktreeState: "present",
    sameRepo: true,
    ...over,
  });

  it("withholds dead rows and other repos' rows, and counts each separately", () => {
    const p = partitionBriefLeases([
      row({ issue: 1 }),
      row({ issue: 2, worktreeState: "missing", sameRepo: null }),
      row({ issue: 3, sameRepo: false }),
    ]);
    expect(p.shown.map((r) => r.issue)).toEqual([1]);
    expect(p.dead).toBe(1);
    expect(p.foreign).toBe(1);
  });

  it("shows everything it could not classify — unknown state and unknown repo both stay", () => {
    const p = partitionBriefLeases([
      row({ issue: 4, worktreeState: "unknown", sameRepo: null }),
      row({ issue: 5, sameRepo: null }),
    ]);
    expect(p.shown.map((r) => r.issue)).toEqual([4, 5]);
    expect(p.dead).toBe(0);
    expect(p.foreign).toBe(0);
  });

  it("a dead row is counted once — never as foreign as well", () => {
    const p = partitionBriefLeases([row({ issue: 6, worktreeState: "missing", sameRepo: false })]);
    expect(p.dead).toBe(1);
    expect(p.foreign).toBe(0);
  });
});

describe("board who — machine-wide, withholds nothing (GH-2108)", () => {
  it("prints DEAD for a gone checkout and STALE for an aged one, and never both readings for one row", () => {
    const repo = gitRepo("repo-a");
    writeLock(51, join(root, "gone"), { ageMin: TTL + 1 });
    writeLock(52, repo, { ageMin: TTL + 1 });
    const { out } = capture(() => run(["who"], ctxFor(repo)));
    expect(out).toMatch(/#51 .*DEAD \(worktree deleted/);
    expect(out).not.toMatch(/#51 .*STALE/);
    expect(out).toMatch(/#52 .*STALE \(past TTL\)/);
    expect(out).toMatch(/1 dead lease\(s\)/);
  });

  it("still lists another repo's leases — 'who is working on this machine' is its whole question", () => {
    const mine = gitRepo("repo-a");
    const other = gitRepo("repo-b");
    writeLock(61, linkedWorktree(other, "feat-61-a"));
    const { out } = capture(() => run(["who"], ctxFor(mine)));
    expect(out).toMatch(/#61 /);
  });

  it("an unreadable sessions dir is not evaluated, never 'nobody working'", () => {
    const repo = gitRepo("repo-a");
    const ctx = makeCtx(new FakeGh(), "me@test", repo, {
      session: { id: "mine", dir: join(root, "no-sessions-dir") },
      now: () => NOW,
    } as never);
    const { out } = capture(() => run(["who"], ctx));
    expect(out).toMatch(/not evaluated/);
    expect(out).toMatch(/distinct from nobody working/);
  });
});

describe("board reap-leases — keyed on the missing checkout, never on age (GH-2108)", () => {
  it("dry run by default: it names the dead locks and removes nothing", () => {
    const repo = gitRepo("repo-a");
    const dead = writeLock(71, join(root, "gone"));
    const { code, out } = capture(() => run(["reap-leases"], ctxFor(repo)));
    expect(code).toBe(0);
    expect(out).toMatch(/DRY RUN/);
    expect(existsSync(dead)).toBe(true);
  });

  it("--apply removes ONLY the locks whose checkout is gone", () => {
    const repo = gitRepo("repo-a");
    const dead = writeLock(72, join(root, "gone"));
    // Aged far past the TTL and still live: age is not the predicate.
    const old = writeLock(73, repo, { ageMin: TTL * 10 });
    const file = join(root, "a-file");
    writeFileSync(file, "not a directory");
    const unknown = writeLock(74, join(file, "below"));
    const { code, out } = capture(() => run(["reap-leases", "--apply"], ctxFor(repo)));
    expect(code).toBe(0);
    expect(out).toMatch(/reaped 1 of 1/);
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(old)).toBe(true);
    expect(existsSync(unknown)).toBe(true);
  });

  it("a checkout restored between the classification and the delete is KEPT", () => {
    // `git worktree add` can put the path back under a reader that has already
    // classified it, and the restored checkout's lock is live again — so the
    // state is re-read at the moment of deletion rather than trusted.
    const repo = gitRepo("repo-a");
    const file = writeLock(75, join(root, "restored"));
    const rows = readLocalLeases(ctxFor(repo))!;
    const dead = rows.filter((r) => r.worktreeState === "missing");
    expect(dead).toHaveLength(1);
    const res = reapDeadLeases(dead, () => "present");
    expect(res.removed).toHaveLength(0);
    expect(res.failed[0].reason).toMatch(/reappeared/);
    expect(existsSync(file)).toBe(true);
  });

  it("a lock that cannot be unlinked is reported, not counted as removed", () => {
    const repo = gitRepo("repo-a");
    writeLock(76, join(root, "gone"));
    const dead = readLocalLeases(ctxFor(repo))!.filter((r) => r.worktreeState === "missing");
    // Delete the file out from under the reap: unlink then fails ENOENT.
    rmSync(dead[0].file, { force: true });
    const res = reapDeadLeases(dead, () => "missing");
    expect(res.removed).toHaveLength(0);
    expect(res.failed).toHaveLength(1);
  });

  it("nothing dead: it says so and touches nothing", () => {
    const repo = gitRepo("repo-a");
    writeLock(77, repo);
    const { code, out } = capture(() => run(["reap-leases", "--apply"], ctxFor(repo)));
    expect(code).toBe(0);
    expect(out).toMatch(/nothing to reap/);
  });

  it("an unreadable sessions dir reaps nothing and says it was not evaluated", () => {
    const repo = gitRepo("repo-a");
    const ctx = makeCtx(new FakeGh(), "me@test", repo, {
      session: { id: "mine", dir: join(root, "no-sessions-dir") },
      now: () => NOW,
    } as never);
    const { code, out } = capture(() => run(["reap-leases", "--apply"], ctx));
    expect(code).toBe(0);
    expect(out).toMatch(/not evaluated/);
  });

  it("--json reports the run it actually performed", () => {
    const repo = gitRepo("repo-a");
    writeLock(78, join(root, "gone"));
    const { out } = capture(() => run(["reap-leases", "--apply", "--json"], ctxFor(repo)));
    const j = JSON.parse(out);
    expect(j).toMatchObject({ evaluated: true, applied: true, removed: 1 });
    expect(j.dead).toHaveLength(1);
  });
});
