/**
 * deliver-push.test.ts — the typed half of the work/deliver exclusion
 * (GH-1917), proved against real git rather than a mock.
 *
 * The whole claim of `deliver-push.sh` is that git's ref update is a genuine
 * compare-and-swap, so the race resolves with a winner and a loser. A mocked
 * `git push` could not prove that — it would only prove we can spell the
 * flag. So every case here builds a real bare "remote" plus two real clones
 * (a deliver lane and a live work session) and runs the actual race. Local
 * bare repos only: no network anywhere.
 *
 * The control case matters as much as the refusal: `bareForcePushClobbers`
 * shows the work session's commit is DESTROYED under today's plain force
 * push, which is what makes the refusal worth having.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(__dirname, "deliver-push.sh");

let root: string;
const roots: string[] = [];

/** Run a command, returning stdout+stderr and the exit code — never throwing.
 *  A non-zero exit is the SUBJECT of most of these assertions, and an
 *  exception would collapse "refused the lease" (75) into the same shape as
 *  "script is broken" (1). */
function run(cmd: string, args: string[], cwd: string): { out: string; code: number } {
  try {
    const out = execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: "pipe" });
    return { out, code: 0 };
  } catch (err: any) {
    return { out: `${err.stdout ?? ""}${err.stderr ?? ""}`, code: err.status ?? -1 };
  }
}

const git = (args: string[], cwd: string) => run("git", args, cwd);
const push = (args: string[], cwd: string) => run("bash", [SCRIPT, ...args], cwd);

/** A bare remote + a `deliver` clone and a `work` clone, both on feat/x at C1.
 *  Returns C1 — the sha deliver would pin its lease to. */
function fixture(): { deliver: string; work: string; c1: string } {
  root = mkdtempSync(join(tmpdir(), "ralph-lease-"));
  roots.push(root);
  const remote = join(root, "remote.git");
  git(["init", "-q", "--bare", remote], root);

  const seed = join(root, "seed");
  git(["clone", "-q", remote, seed], root);
  git(["config", "user.email", "s@x"], seed);
  git(["config", "user.name", "seed"], seed);
  execFileSync("bash", ["-c", "echo base > f"], { cwd: seed });
  git(["add", "-A"], seed);
  git(["commit", "-qm", "C1"], seed);
  git(["branch", "-M", "main"], seed);
  git(["push", "-q", "origin", "main"], seed);
  git(["checkout", "-qb", "feat/x"], seed);
  git(["push", "-q", "origin", "feat/x"], seed);
  const c1 = git(["rev-parse", "HEAD"], seed).out.trim();

  const paths: Record<string, string> = {};
  for (const name of ["deliver", "work"]) {
    const p = join(root, name);
    git(["clone", "-q", remote, p], root);
    git(["config", "user.email", `${name}@x`], p);
    git(["config", "user.name", name], p);
    git(["checkout", "-q", "feat/x"], p);
    paths[name] = p;
  }
  return { deliver: paths.deliver, work: paths.work, c1 };
}

/** Deliver rebases (diverging from C1); the live work session pushes W1. */
function race(f: { deliver: string; work: string }): void {
  execFileSync("bash", ["-c", "echo deliver > f"], { cwd: f.deliver });
  git(["commit", "-qam", "D1"], f.deliver);
  execFileSync("bash", ["-c", "echo work > f"], { cwd: f.work });
  git(["commit", "-qam", "W1"], f.work);
  git(["push", "-q", "origin", "feat/x"], f.work);
}

const remoteHas = (repo: string, subject: string): boolean => {
  git(["fetch", "-q", "origin"], repo);
  return git(["log", "origin/feat/x", "--oneline"], repo).out.includes(subject);
};

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

describe("deliver-push.sh — argument gates", () => {
  beforeEach(() => void 0);

  it("refuses a missing --expect: a push with no pinned sha is not a lease", () => {
    const f = fixture();
    const r = push(["--branch", "feat/x"], f.deliver);
    expect(r.code).toBe(1);
    expect(r.out).toContain("DELIVER PUSH FAIL — args");
  });

  it("refuses an abbreviated sha", () => {
    // git compares the expected value literally, so a short sha could never
    // match — the lease would always refuse, a failure wearing the costume of
    // protection.
    const f = fixture();
    const r = push(["--branch", "feat/x", "--expect", f.c1.slice(0, 8)], f.deliver);
    expect(r.code).toBe(1);
    expect(r.out).toContain("40-character sha");
  });

  it("refuses --force outright, with a legible message", () => {
    const f = fixture();
    const r = push(["--branch", "feat/x", "--expect", f.c1, "--force"], f.deliver);
    expect(r.code).toBe(1);
    expect(r.out).toContain("the lease is the gate");
  });
});

describe("deliver-push.sh — the race", () => {
  it("PASSES when no peer touched the branch", () => {
    const f = fixture();
    execFileSync("bash", ["-c", "echo deliver > f"], { cwd: f.deliver });
    git(["commit", "-qam", "D1"], f.deliver);
    const r = push(["--branch", "feat/x", "--expect", f.c1], f.deliver);
    expect(r.code).toBe(0);
    expect(r.out).toContain("DELIVER PUSH PASS");
    expect(remoteHas(f.work, "D1")).toBe(true);
  });

  it("REFUSES with exit 75 when a live work session pushed first", () => {
    const f = fixture();
    race(f);
    const r = push(["--branch", "feat/x", "--expect", f.c1], f.deliver);
    expect(r.code).toBe(75); // PENDING, not FAIL: back off, do not escalate
    expect(r.out).toContain("DELIVER PUSH PENDING — lease");
    expect(remoteHas(f.work, "W1")).toBe(true); // the work commit survived
  });

  it("holds even after a fetch refreshed the remote-tracking ref", () => {
    // The footgun that makes --expect mandatory: a bare --force-with-lease
    // compares against the remote-tracking ref, which this innocent fetch
    // updates — silently disarming the lease. The pinned form is immune.
    const f = fixture();
    race(f);
    git(["fetch", "-q", "origin"], f.deliver);
    const r = push(["--branch", "feat/x", "--expect", f.c1], f.deliver);
    expect(r.code).toBe(75);
    expect(remoteHas(f.work, "W1")).toBe(true);
  });

  it("CONTROL: a bare force push destroys the work session's commit", () => {
    // Not a test of the script — a test of why it exists. If this ever starts
    // preserving W1, the hazard changed shape and the lease may be moot.
    const f = fixture();
    race(f);
    const r = git(["push", "--force", "origin", "HEAD:feat/x"], f.deliver);
    expect(r.code).toBe(0);
    expect(remoteHas(f.work, "W1")).toBe(false); // silently gone
  });

  it("reports a no-op honestly instead of claiming a lease it never checked", () => {
    // git skips the ref update when nothing changes, so it exits 0 WITHOUT
    // evaluating the lease — even against a nonsense --expect. Nothing is
    // overwritten, so this is not a failure; but calling it PASS would assert
    // a check that never ran.
    const f = fixture();
    const bogus = "0".repeat(40);
    const r = push(["--branch", "feat/x", "--expect", bogus], f.deliver);
    expect(r.code).toBe(0);
    expect(r.out).toContain("DELIVER PUSH WARN — noop");
    expect(r.out).toContain("Lease NOT exercised");
  });

  it("refuses to force-push the default branch", () => {
    const f = fixture();
    git(["remote", "set-head", "origin", "main"], f.deliver);
    git(["checkout", "-q", "main"], f.deliver);
    execFileSync("bash", ["-c", "echo x >> f"], { cwd: f.deliver });
    git(["commit", "-qam", "onmain"], f.deliver);
    const head = git(["rev-parse", "origin/main"], f.deliver).out.trim();
    const r = push(["--branch", "main", "--expect", head], f.deliver);
    expect(r.code).toBe(1);
    expect(r.out).toContain("refusing to force-push the default branch");
  });
});
