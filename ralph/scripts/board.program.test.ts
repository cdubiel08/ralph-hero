import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  encodeClaim,
  fetchIssue,
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
  // by the actual wire variables; writes target the secondary fixture's IDs.
  // This makes a bare-number reread return a real, different primary issue.
  ctx.exec = (argv, stdin) => {
    if (stdin) {
      const { query, variables } = JSON.parse(stdin);
      if (query.includes("repository(owner") && query.includes("issue(number")) {
        const repo = `${variables.owner}/${variables.repo}`;
        reads.push(repo);
        if (repo === "cdubiel08/ralph-hero") return primary.exec(argv, stdin);
        expect(repo).toBe("acme/other");
      }
    }
    return secondary.exec(argv, stdin);
  };
  return { primary, secondary, ctx, reads };
}

describe("program scope rereads (GH-2483)", () => {
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
