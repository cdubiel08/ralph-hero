import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  encodeClaim,
  fetchIssue,
  reconcile,
  resolveProposal,
  sessionBindingPath,
  TEND_PROPOSAL_MARKER,
  transition,
} from "./board.js";
import { FakeGh, makeCtx, NOW, refusalMessage } from "./board.testkit.js";

const address = { owner: "acme", repo: "other", number: 9 };
const primaryAt = "2026-07-29T12:00:00Z";
const secondaryAt = "2026-07-30T12:00:00Z";
const proposal = (at: string) => `${TEND_PROPOSAL_MARKER}\n\`\`\`json\n${JSON.stringify({
  action: "close-as-delivered", at,
})}\n\`\`\``;

function programBoard() {
  const primary = new FakeGh();
  const secondary = new FakeGh();
  primary.issues.set(9, { number: 9, state: "Backlog", comments: [proposal(primaryAt)] });
  secondary.issues.set(9, {
    number: 9, repo: "acme/other", state: "Backlog", comments: [proposal(secondaryAt)],
  });
  const ctx = makeCtx(secondary);
  ctx.cfg.repos = ["cdubiel08/ralph-hero", "acme/other"];
  const reads: string[] = [];
  // Each FakeGh has its own number namespace. Repository reads MUST route
  // by the actual wire variables; primary global IDs carry a distinct prefix
  // so subsequent mutations route to the issue the read actually returned.
  // This makes a bare-number reread return a real, different primary issue.
  ctx.exec = (argv, stdin) => {
    if (stdin) {
      const { query, variables } = JSON.parse(stdin);
      if (query.includes("mutation")) {
        let primaryWrite = false;
        for (const key of ["itemId", "issueId", "subjectId"]) {
          if (variables[key]?.startsWith("PRIMARY_")) {
            primaryWrite = true;
            variables[key] = variables[key].slice("PRIMARY_".length);
          }
        }
        if (primaryWrite) return primary.exec(argv, JSON.stringify({ query, variables }));
      }
      if (query.includes("repository(owner") && query.includes("issue(number")) {
        const repo = `${variables.owner}/${variables.repo}`;
        reads.push(repo);
        if (repo === "cdubiel08/ralph-hero") {
          const result = primary.exec(argv, stdin);
          return { ...result, stdout: result.stdout.replace(/"((?:I|ITEM)_\d+)"/g, '"PRIMARY_$1"') };
        }
        expect(repo).toBe("acme/other");
      }
    }
    return secondary.exec(argv, stdin);
  };
  return { primary, secondary, ctx, reads };
}

describe("program scope rereads (GH-2483)", () => {
  it.each(["In Review", "Done"] as const)("rolls up the secondary parent after a child reaches %s", (to) => {
    const { ctx, primary, secondary, reads } = programBoard();
    secondary.issues.get(9)!.state = "In Progress";
    secondary.issues.get(9)!.claim = encodeClaim("me@test", NOW);
    secondary.issues.get(9)!.issueState = "CLOSED";
    secondary.issues.get(9)!.parent = 10;
    secondary.issues.get(9)!.parentRepo = "acme/other";
    primary.issues.set(10, {
      number: 10, state: "Backlog", children: [{ number: 20, issueState: "CLOSED" }],
    });
    secondary.issues.set(10, {
      number: 10, repo: "acme/other", state: "Backlog",
      children: [{ number: 9, issueState: "CLOSED" }],
    });
    transition(ctx, fetchIssue(ctx, address), to, { why: "delivered" });
    expect(secondary.issues.get(10)?.state).toBe("In Review");
    expect(secondary.comments.some((c) => c.body.includes("rollup lane"))).toBe(true);
    expect(primary.issues.get(10)?.state).toBe("Backlog");
    expect(primary.mutations).toEqual([]);
    expect(primary.comments).toEqual([]);
    expect(reads).toEqual(["acme/other", "acme/other", "acme/other"]);
  });

  it("does not roll up an unconfigured parent through a same-numbered primary issue", () => {
    const { ctx, primary, secondary, reads } = programBoard();
    secondary.issues.get(9)!.parent = 10;
    secondary.issues.get(9)!.parentRepo = "outside/program";
    primary.issues.set(10, {
      number: 10, state: "Backlog", children: [{ number: 20, issueState: "CLOSED" }],
    });
    transition(ctx, fetchIssue(ctx, address), "Done", { why: "delivered" });
    expect(primary.mutations).toEqual([]);
    expect(reads).toEqual(["acme/other", "acme/other"]);
  });

  it("reconciliation carries the actual parent repository into the same rollup lane", () => {
    const { ctx, primary, secondary } = programBoard();
    primary.issues.get(9)!.parent = 10;
    primary.issues.get(9)!.parentRepo = "acme/other";
    primary.issues.get(9)!.issueState = "CLOSED";
    primary.issues.set(10, {
      number: 10, state: "Backlog", children: [{ number: 20, issueState: "CLOSED" }],
    });
    secondary.issues.set(10, {
      number: 10, repo: "acme/other", state: "Backlog",
      children: [{ number: 9, issueState: "CLOSED" }],
    });
    reconcile(ctx, 9);
    expect(secondary.issues.get(10)?.state).toBe("In Review");
    expect(primary.issues.get(10)?.state).toBe("Backlog");
    expect(primary.comments.some((c) => c.body.includes("rollup lane"))).toBe(false);
  });

  it("verifies a secondary claim even when primary has no same-numbered issue", () => {
    const { ctx, primary, secondary, reads } = programBoard();
    primary.issues.delete(9);
    const after = transition(ctx, fetchIssue(ctx, address), "In Progress");
    expect(after.url).toBe("https://github.com/acme/other/issues/9");
    expect(after.claim?.holders).toEqual(["me@test"]);
    expect(secondary.issues.get(9)?.state).toBe("In Progress");
    expect(reads).toEqual(["acme/other", "acme/other"]);
  });

  it("cannot vouch for a lost secondary claim using a same-numbered primary claim", () => {
    const { ctx, primary, secondary } = programBoard();
    primary.issues.get(9)!.state = "In Progress";
    primary.issues.get(9)!.claim = encodeClaim("me@test", NOW);
    secondary.raceClaimTo = "rival@host";
    expect(() => transition(ctx, fetchIssue(ctx, address), "In Progress"))
      .toThrow(/lost the claim race.*rival@host/);
    expect(primary.mutations).toEqual([]);
  });

  it("returns the secondary issue after retrying a half-applied terminal close", () => {
    const { ctx, secondary, reads } = programBoard();
    secondary.issues.get(9)!.state = "Canceled";
    const after = transition(ctx, fetchIssue(ctx, address), "Canceled");
    expect(after.issueState).toBe("CLOSED");
    expect(after.state).toBe("Canceled");
    expect(reads).toEqual(["acme/other", "acme/other"]);
  });

  it("rereads the secondary claim before rolling back a concurrent session binding", () => {
    const { ctx, secondary, reads } = programBoard();
    ctx.session = { id: "program-race", dir: mkdtempSync(join(tmpdir(), "board-program-")) };
    const issue = fetchIssue(ctx, address);
    const exec = ctx.exec;
    let raced = false;
    ctx.exec = (argv, stdin) => {
      const result = exec(argv, stdin);
      if (!raced) {
        raced = true;
        writeFileSync(sessionBindingPath(ctx)!, JSON.stringify({
          issue: 1, since: NOW.toISOString(), holder: "me@test",
        }));
      }
      return result;
    };
    expect(refusalMessage(() => transition(ctx, issue, "In Progress")))
      .toContain('rolled back to "Backlog"');
    expect(secondary.issues.get(9)?.state).toBe("Backlog");
    expect(secondary.issues.get(9)?.claim).toBeNull();
    expect(reads).toEqual(["acme/other", "acme/other", "acme/other"]);
  });

  it("binds a disposition to the secondary proposal, not primary's same-numbered proposal", () => {
    const { ctx, primary, secondary, reads } = programBoard();
    expect(resolveProposal(ctx, fetchIssue(ctx, address), "rejected"))
      .toEqual({ at: secondaryAt });
    expect(secondary.comments.at(-1)?.body).toContain(`"proposed_at":"${secondaryAt}"`);
    expect(primary.comments).toEqual([]);
    expect(reads).toEqual(["acme/other", "acme/other"]);
  });

  it("does not invent a secondary proposal when only primary has one", () => {
    const { ctx, secondary } = programBoard();
    secondary.issues.get(9)!.comments = [];
    expect(resolveProposal(ctx, fetchIssue(ctx, address), "accepted")).toBeNull();
    expect(secondary.comments).toEqual([]);
  });

  it("fails closed when the secondary trail disappears even if primary has a proposal", () => {
    const { ctx, secondary } = programBoard();
    const issue = fetchIssue(ctx, address);
    secondary.issues.delete(9);
    expect(() => resolveProposal(ctx, issue, "rejected")).toThrow(/could not read.*comment trail/);
    expect(secondary.comments).toEqual([]);
  });
});
