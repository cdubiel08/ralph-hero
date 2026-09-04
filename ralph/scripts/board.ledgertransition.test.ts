/**
 * board.ledgertransition.test.ts — the ledger write half of GH-2446:
 * `board move`/`claim`/`release`/`answer --resume`/`promote` append
 * `{ev: "transition", unit, from, to, actor, at}` to the herdr ledger via
 * `ledger-transition.sh`, under `ledger.sh`'s own writer mutex.
 *
 * The one property this file exists to defend: the append is BEST-EFFORT.
 * The board write is the source of truth and already landed by the time the
 * append runs, so nothing about the ledger call — a nonzero exit, a thrown
 * error, an absent ralph-herdr install — may change the caller's own exit
 * code or output. `ctx.exec` is wrapped (not `gh.exec` itself) so the
 * default FakeGh fallback (`unexpected: <cmd>`, exit 1) continues to prove
 * the earlier claim: a machine with no ledger scripts wired at all — which
 * is what every OTHER test in this suite already is — sees transitions
 * unaffected. The recorded argv, when captured, pins the writer's contract
 * (REPO_ROOT UNIT FROM TO ACTOR AT) so a signature change here is deliberate.
 */

import { describe, expect, it } from "vitest";
import { ESCALATION_ROUTE_MARKER, run, type ExecResult } from "./board.js";
import { FakeGh, makeCtx, NOW } from "./board.testkit.js";

/** Wrap ctx.exec to record every "bash .../ledger-transition.sh ..." call
 *  and answer it with `result`, delegating everything else (gh, git) to the
 *  FakeGh transport underneath — exactly the transport every other test in
 *  this repo already runs with. */
function withLedgerSpy(gh: FakeGh, result: ExecResult) {
  const ctx = makeCtx(gh);
  const calls: string[][] = [];
  const inner = ctx.exec;
  ctx.exec = (argv, stdin) => {
    if (argv[0] === "bash" && argv[1]?.endsWith("ledger-transition.sh")) {
      calls.push(argv);
      return result;
    }
    return inner(argv, stdin);
  };
  return { ctx, calls };
}

const NOT_WIRED: ExecResult = { code: 1, stdout: "", stderr: "unexpected: bash ledger-transition.sh" };

describe("ledger transition append (GH-2446) — best-effort, never load-bearing", () => {
  it("claim (Backlog → In Progress) invokes ledger-transition.sh with REPO_ROOT UNIT FROM TO ACTOR AT", () => {
    const gh = new FakeGh();
    gh.issues.set(1, { number: 1, state: "Backlog", priority: "P1", estimate: "S" });
    const { ctx, calls } = withLedgerSpy(gh, NOT_WIRED);
    expect(run(["claim", "1"], ctx)).toBe(0);
    expect(calls).toHaveLength(1);
    const [bash, sh, repoRoot, unit, from, to, actor, at] = calls[0];
    expect(bash).toBe("bash");
    expect(sh.endsWith("/ledger-transition.sh")).toBe(true);
    expect(repoRoot).toBe(ctx.repoRoot);
    expect(unit).toBe("1");
    expect(from).toBe("Backlog");
    expect(to).toBe("In Progress");
    expect(actor).toBe(ctx.cfg.holder);
    expect(at).toBe(NOW.toISOString());
  });

  it("release (In Progress → Backlog) records the demotion edge", () => {
    const gh = new FakeGh();
    gh.issues.set(1, {
      number: 1, state: "In Progress", priority: "P1", estimate: "S",
      claim: "me@test|2026-07-31T11:00:00.000Z",
    });
    const { ctx, calls } = withLedgerSpy(gh, NOT_WIRED);
    expect(run(["release", "1", "-m", "stopped here"], ctx)).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].slice(4, 7)).toEqual(["In Progress", "Backlog", "me@test"]);
  });

  it("promote logs the marker on the timeline without inventing a state change (from === to)", () => {
    const gh = new FakeGh();
    const routedAt = new Date(NOW.getTime() - 30 * 60_000).toISOString();
    gh.issues.set(1, {
      number: 1,
      state: "Human Needed",
      comments: [
        `**Decision needed** (\`board\` by \`me@test\`):\n\nwhich way?\n\n${ESCALATION_ROUTE_MARKER}\n` +
          `\`\`\`json\n${JSON.stringify({ to: "lead", lead: "lead@test", at: routedAt })}\n\`\`\``,
      ],
    });
    const { ctx, calls } = withLedgerSpy(gh, NOT_WIRED);
    expect(run(["promote", "1"], ctx)).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].slice(4, 7)).toEqual(["Human Needed", "Human Needed", "me@test"]);
  });

  it("a nonzero-exit append never fails the move — the board write is the source of truth", () => {
    const gh = new FakeGh();
    gh.issues.set(1, { number: 1, state: "Backlog", priority: "P1", estimate: "S" });
    const { ctx } = withLedgerSpy(gh, {
      code: 1, stdout: "", stderr: "ledger-transition: the ralph-herdr plugin's ledger was not found",
    });
    expect(run(["claim", "1"], ctx)).toBe(0);
    expect(gh.issues.get(1)!.state).toBe("In Progress"); // the board write still landed
  });

  it("a THROWING exec (not just a nonzero exit) is swallowed too — appendLedgerTransition is try/catch'd", () => {
    const gh = new FakeGh();
    gh.issues.set(1, { number: 1, state: "Backlog", priority: "P1", estimate: "S" });
    const ctx = makeCtx(gh);
    const inner = ctx.exec;
    ctx.exec = (argv, stdin) => {
      if (argv[0] === "bash" && argv[1]?.endsWith("ledger-transition.sh")) throw new Error("spawn EMFILE");
      return inner(argv, stdin);
    };
    expect(run(["claim", "1"], ctx)).toBe(0);
    expect(gh.issues.get(1)!.state).toBe("In Progress");
  });

  it("a machine with no ledger scripts wired at all (the FakeGh default) succeeds unchanged — every OTHER test in this suite already proves this by construction, this one states it", () => {
    const gh = new FakeGh();
    gh.issues.set(1, { number: 1, state: "Backlog", priority: "P1", estimate: "S" });
    const ctx = makeCtx(gh); // no override — falls straight to FakeGh's `unexpected: <cmd>` (exit 1)
    expect(run(["claim", "1"], ctx)).toBe(0);
    expect(gh.issues.get(1)!.state).toBe("In Progress");
  });
});
