/**
 * board.lint.test.ts — `contract lint --live` at the CLI level. The unit
 * suite (contracts.test.ts) proves the rules against fake deps; this file
 * proves board.ts WIRES them: L3's commit probe runs real `git cat-file`
 * against a temp repo fixture, L5/L7's board read-back rides fetchIssue over
 * FakeGh, and the exit code carries the verdict. No network anywhere.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeClaim, liveLintDeps, realExec, run, type Ctx } from "./board.js";
import { FakeGh, makeCtx, NOW } from "./board.testkit.js";

// --- fixtures ---------------------------------------------------------------

/** A real (empty-commit) git repo: L3's truth source. Built once — the suite
 *  only ever reads it. */
let gitRepo: string;
let realSha: string;
const MISSING_SHA = "b".repeat(40); // valid shape, in no repo's history
let payloadDir: string;

beforeAll(() => {
  gitRepo = mkdtempSync(join(tmpdir(), "board-lint-git-"));
  payloadDir = mkdtempSync(join(tmpdir(), "board-lint-payload-"));
  const git = (...args: string[]) => {
    const r = realExec(["git", "-C", gitRepo, ...args]);
    if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git("init", "-q");
  git("-c", "user.email=lint@test", "-c", "user.name=lint", "commit", "--allow-empty", "-q", "-m", "fixture");
  realSha = git("rev-parse", "HEAD");
});

afterAll(() => {
  rmSync(gitRepo, { recursive: true, force: true });
  rmSync(payloadDir, { recursive: true, force: true });
});

/** Ctx whose repoRoot IS the git fixture, with the exec seam split: git
 *  commands run for real (the fixture is the point), everything else stays on
 *  FakeGh — the same overlay-after-construction seam makeCtx documents. */
function lintCtx(gh: FakeGh): Ctx {
  const ctx = makeCtx(gh, "me@test", gitRepo);
  const fake = gh.exec;
  gh.exec = (argv, stdin) => (argv[0] === "git" && argv.includes("cat-file") ? realExec(argv, stdin) : fake(argv, stdin));
  return ctx;
}

let seq = 0;
function payloadFile(payload: unknown): string {
  const file = join(payloadDir, `p${seq++}.json`);
  writeFileSync(file, JSON.stringify(payload));
  return file;
}

function capture(argv: string[], ctx: Ctx): { code: number; text: string } {
  const said: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((s) => {
    said.push(String(s));
    return true;
  });
  let code: number;
  try {
    code = run(argv, ctx);
  } finally {
    spy.mockRestore();
  }
  return { code, text: said.join("") };
}

/** A payload the live rules all bite on: agent + issue (L5), commit_sha (L3),
 *  a lineage parent (L7). w7-wire's name bakes issue 7, so L2 stays green. */
const REPORT = (over: Record<string, unknown> = {}) => ({
  agent: "w7-wire",
  issue: 7,
  commit_sha: "", // per-test: realSha only exists after beforeAll
  lineage: { parent_issue: 5 },
  ...over,
});

/** Board where every live rule agrees: #7 claimed by w7-wire, #5 open work. */
function agreeingGh(): FakeGh {
  const gh = new FakeGh();
  gh.issues.set(7, { number: 7, state: "In Progress", claim: encodeClaim("w7-wire", NOW) });
  gh.issues.set(5, { number: 5, state: "In Progress" });
  return gh;
}

// --- the suite --------------------------------------------------------------

describe("contract lint --live (CLI)", () => {
  it("all-green: L3 finds the fixture commit, L5 the claim, L7 the open parent — exit 0", () => {
    const ctx = lintCtx(agreeingGh());
    const file = payloadFile(REPORT({ commit_sha: realSha }));
    const { code, text } = capture(["contract", "lint", "ralph.completion_report", file, "--live"], ctx);
    expect(text).toContain("✓ L3");
    expect(text).toContain("✓ L5");
    expect(text).toContain("✓ L7");
    expect(text).toContain("lint: OK");
    expect(code).toBe(0);
  });

  it("without --live the same payload skips L3/L5/L7 (requires --live) and still exits 0", () => {
    const ctx = lintCtx(agreeingGh());
    const file = payloadFile(REPORT({ commit_sha: realSha }));
    const { code, text } = capture(["contract", "lint", "ralph.completion_report", file], ctx);
    for (const id of ["L3", "L5", "L7"]) expect(text).toContain(`- ${id}: skipped (requires --live)`);
    expect(code).toBe(0);
  });

  it("L10 skips with the doctor-lineage.sh pointer, --live or not — the rule is ledger-side", () => {
    const file = payloadFile(REPORT({ commit_sha: realSha }));
    for (const argv of [
      ["contract", "lint", "ralph.completion_report", file],
      ["contract", "lint", "ralph.completion_report", file, "--live"],
    ]) {
      const { text } = capture(argv, lintCtx(agreeingGh()));
      expect(text).toMatch(/- L10: skipped \(.*doctor-lineage\.sh\)/);
    }
  });

  it("L3 fails on a sha the repo has never seen — real git is the judge", () => {
    const ctx = lintCtx(agreeingGh());
    const file = payloadFile(REPORT({ commit_sha: MISSING_SHA }));
    const { code, text } = capture(["contract", "lint", "ralph.completion_report", file, "--live"], ctx);
    expect(text).toContain(`✗ L3: commit_sha ${MISSING_SHA} is not a commit in this repo`);
    expect(code).toBe(1);
  });

  it("L5 fails when the live claim belongs to someone else — read-back over fetchIssue", () => {
    const gh = agreeingGh();
    gh.issues.get(7)!.claim = encodeClaim("r7-review", NOW);
    const file = payloadFile(REPORT({ commit_sha: realSha }));
    const { code, text } = capture(["contract", "lint", "ralph.completion_report", file, "--live"], lintCtx(gh));
    expect(text).toContain("✗ L5");
    expect(text).toContain("r7-review");
    expect(code).toBe(1);
  });

  it("L5 fails when the issue carries no claim at all", () => {
    const gh = agreeingGh();
    gh.issues.get(7)!.claim = null;
    const file = payloadFile(REPORT({ commit_sha: realSha }));
    const { code, text } = capture(["contract", "lint", "ralph.completion_report", file, "--live"], lintCtx(gh));
    expect(text).toContain("✗ L5: issue #7 carries no claim");
    expect(code).toBe(1);
  });

  it("L7 fails when the parent is Done — closed work cannot parent new work", () => {
    const gh = agreeingGh();
    gh.issues.get(5)!.state = "Done";
    const file = payloadFile(REPORT({ commit_sha: realSha }));
    const { code, text } = capture(["contract", "lint", "ralph.completion_report", file, "--live"], lintCtx(gh));
    expect(text).toContain("✗ L7: parent #5 is Done");
    expect(code).toBe(1);
  });

  it("L7 fails closed when the parent does not exist — fetchIssue's not-found maps to null, not a crash", () => {
    const gh = agreeingGh();
    gh.issues.delete(5);
    const file = payloadFile(REPORT({ commit_sha: realSha }));
    const { code, text } = capture(["contract", "lint", "ralph.completion_report", file, "--live"], lintCtx(gh));
    expect(text).toContain("✗ L7: parent_issue #5 does not exist");
    expect(code).toBe(1);
  });

  it("one failing rule among passing ones: the verdict aggregates and exit is 1", () => {
    const gh = agreeingGh();
    gh.issues.get(5)!.state = "Canceled";
    const file = payloadFile(REPORT({ commit_sha: realSha }));
    const { code, text } = capture(["contract", "lint", "ralph.completion_report", file, "--live"], lintCtx(gh));
    expect(text).toContain("✓ L3");
    expect(text).toContain("✓ L5");
    expect(text).toContain("✗ L7");
    expect(text).toContain("lint: FAIL (1)");
    expect(code).toBe(1);
  });

  it("liveLintDeps: git failures surface as nonzero codes; non-UsageError fetch failures propagate", () => {
    const gh = agreeingGh();
    const ctx = lintCtx(gh);
    const deps = liveLintDeps(ctx);
    expect(deps.execGit!(["cat-file", "-e", `${realSha}^{commit}`]).code).toBe(0);
    expect(deps.execGit!(["cat-file", "-e", `${MISSING_SHA}^{commit}`]).code).not.toBe(0);
    expect(deps.readBoardItem!(999)).toBeNull(); // not-found → null (fail closed at the rule)
    const item = deps.readBoardItem!(7);
    expect(item).toMatchObject({ issueState: "OPEN", state: "In Progress" });
    expect(item!.claim!.holders).toEqual(["w7-wire"]);
    // A transport failure is NOT "the issue is missing" — it must throw.
    gh.exec = () => ({ code: 1, stdout: "", stderr: "simulated transport failure" });
    expect(() => deps.readBoardItem!(7)).toThrow(/transport failure|graphql/i);
  });
});
