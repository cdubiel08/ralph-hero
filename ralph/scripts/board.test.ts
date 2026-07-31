/**
 * board.test.ts — the machine's contract. Every invariant named in the design
 * (thoughts/shared/ideas/2026-07-31-ralph-v2-minimal-harness.md §2) has a test.
 * Pure core + injected exec; no network.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claimIsStale,
  type Config,
  type Ctx,
  doctor,
  encodeClaim,
  type ExecResult,
  fetchIssue,
  legalTransition,
  LEGACY_STATES,
  MACHINE,
  migrate,
  migrateMapping,
  parentCheck,
  parseArgs,
  parseClaim,
  parseStateArg,
  type QueueItem,
  rankNext,
  RefusalError,
  scopeMatches,
  STATES,
  transition,
  UsageError,
} from "./board.js";

// ---------------------------------------------------------------------------
// Pure logic
// ---------------------------------------------------------------------------

describe("state machine", () => {
  it("encodes exactly the designed transition table", () => {
    expect(MACHINE).toEqual({
      Backlog: ["In Progress", "Canceled"],
      "In Progress": ["In Review", "Human Needed", "Backlog", "Canceled"],
      "In Review": ["Done", "In Progress", "Human Needed", "Canceled"],
      "Human Needed": ["In Progress", "Backlog", "Canceled"],
      Done: ["Backlog"],
      Canceled: ["Backlog"],
    });
  });

  it("refuses everything not in the table", () => {
    const illegal: Array<[string, string]> = [
      ["Backlog", "In Review"],
      ["Backlog", "Done"],
      ["Backlog", "Human Needed"],
      ["In Progress", "Done"],
      ["Human Needed", "In Review"],
      ["Human Needed", "Done"],
      ["Done", "In Progress"],
      ["Canceled", "Done"],
    ];
    for (const [from, to] of illegal) {
      expect(legalTransition(from as any, to as any), `${from} → ${to}`).toBe(false);
    }
  });

  it("parses human-friendly state aliases", () => {
    expect(parseStateArg("in-progress")).toBe("In Progress");
    expect(parseStateArg("wip")).toBe("In Progress");
    expect(parseStateArg("In Review")).toBe("In Review");
    expect(parseStateArg("human_needed")).toBe("Human Needed");
    expect(parseStateArg("cancelled")).toBe("Canceled");
    expect(parseStateArg("Ready for Plan")).toBeNull();
  });
});

describe("claims", () => {
  const t0 = new Date("2026-07-31T12:00:00Z");

  it("round-trips encode/parse (parity of the claim wire format)", () => {
    const c = parseClaim(encodeClaim("chad@mbp", t0));
    expect(c).toEqual({ holder: "chad@mbp", since: t0 });
  });

  it("holder may contain | — last separator wins", () => {
    const c = parseClaim(`weird|host|${t0.toISOString()}`);
    expect(c?.holder).toBe("weird|host");
  });

  it("rejects malformed values instead of guessing", () => {
    expect(parseClaim("")).toBeNull();
    expect(parseClaim(null)).toBeNull();
    expect(parseClaim("no-separator")).toBeNull();
    expect(parseClaim("holder|not-a-date")).toBeNull();
  });

  it("staleness is >= TTL, not >", () => {
    const claim = { holder: "x", since: t0 };
    const at = (min: number) => new Date(t0.getTime() + min * 60_000);
    expect(claimIsStale(claim, at(119), 120)).toBe(false);
    expect(claimIsStale(claim, at(120), 120)).toBe(true);
  });
});

describe("rankNext", () => {
  const item = (n: number, over: Partial<QueueItem> = {}): QueueItem => ({
    number: n,
    title: `t${n}`,
    state: "Backlog",
    priority: null,
    hasParent: false,
    openBlockers: [],
    claim: null,
    ...over,
  });

  it("priority beats parenthood beats age; blocked excluded but reported; claimed invisible", () => {
    const items = [
      item(10),
      item(2, { priority: "P2" }),
      item(3, { priority: "P0" }),
      item(4, { hasParent: true }),
      item(5, { openBlockers: [3] }),
      item(6, { claim: { holder: "other", since: new Date() } }),
      item(7, { state: "In Review" }),
    ];
    const { eligible, blocked } = rankNext(items);
    expect(eligible.map((i) => i.number)).toEqual([3, 2, 4, 10]);
    expect(blocked.map((i) => i.number)).toEqual([5]);
  });
});

describe("migrateMapping (11 → 6)", () => {
  it("maps every legacy state", () => {
    expect(migrateMapping("Research Needed", false)).toBe("Backlog");
    expect(migrateMapping("Ready for Plan", false)).toBe("Backlog");
    expect(migrateMapping("Research in Progress", false)).toBe("Backlog");
    expect(migrateMapping("Plan in Progress", false)).toBe("Backlog");
    expect(migrateMapping("Plan in Review", false)).toBe("Backlog");
    expect(migrateMapping("Plan in Review", true)).toBe("Human Needed");
  });

  it("passes v2 states through and rejects unknowns", () => {
    for (const s of STATES) expect(migrateMapping(s, false)).toBe(s);
    expect(migrateMapping("Weird", false)).toBeNull();
  });

  it("LEGACY_STATES covers exactly the 5 removed states", () => {
    expect(LEGACY_STATES).toHaveLength(5);
    for (const s of LEGACY_STATES) expect(migrateMapping(s, false)).not.toBeNull();
  });
});

describe("scopeMatches", () => {
  it("accepts https/ssh forms of the configured repo, case-insensitively", () => {
    for (const url of [
      "https://github.com/cdubiel08/ralph-hero.git",
      "https://github.com/cdubiel08/ralph-hero",
      "git@github.com:cdubiel08/ralph-hero.git",
      "ssh://git@github.com/CDubiel08/Ralph-Hero.git",
    ]) {
      expect(scopeMatches(url, "cdubiel08", "ralph-hero"), url).toBe(true);
    }
  });

  it("refuses other repos and garbage", () => {
    expect(scopeMatches("git@github.com:other/ralph-hero.git", "cdubiel08", "ralph-hero")).toBe(false);
    expect(scopeMatches("https://github.com/cdubiel08/other.git", "cdubiel08", "ralph-hero")).toBe(false);
    expect(scopeMatches("", "cdubiel08", "ralph-hero")).toBe(false);
  });
});

describe("parseArgs", () => {
  it("handles -m, --key value, and boolean flags", () => {
    const p = parseArgs(["12", "-m", "parked here", "--steal", "--state", "wip"]);
    expect(p.positional).toEqual(["12"]);
    expect(p.flags).toEqual({ m: "parked here", steal: true, state: "wip" });
  });

  it("there is no --force, by design", () => {
    expect(() => parseArgs(["12", "--force"])).toThrow(UsageError);
    expect(() => parseArgs(["12", "--force"])).toThrow(/no --force/);
  });
});

// ---------------------------------------------------------------------------
// Command flows against a fake gh
// ---------------------------------------------------------------------------

const NOW = new Date("2026-07-31T12:00:00Z");
const PROJECT_ID = "PVT_test";

interface FakeIssue {
  number: number;
  state?: string | null;
  claim?: string | null;
  issueState?: "OPEN" | "CLOSED";
  parent?: number;
  children?: Array<{ number: number; issueState: "OPEN" | "CLOSED"; state?: string | null }>;
  comments?: string[];
}

/** Minimal in-memory board: answers the exact queries board.ts issues and
 *  records every mutation, so clear-then-set ordering is observable. */
class FakeGh {
  mutations: string[] = [];
  comments: Array<{ body: string }> = [];
  issues = new Map<number, FakeIssue>();

  exec: (argv: string[], stdin?: string) => ExecResult = (argv, stdin) => {
    const cmd = argv.join(" ");
    if (cmd.startsWith("gh api graphql")) return this.graphql(JSON.parse(stdin!));
    if (cmd.startsWith("gh auth status")) return ok("");
    if (cmd.startsWith("git") && cmd.includes("remote"))
      return ok("git@github.com:cdubiel08/ralph-hero.git\n");
    if (cmd.startsWith("gh run list")) return ok("[]");
    return { code: 1, stdout: "", stderr: `unexpected: ${cmd}` };
  };

  private issuePayload(fi: FakeIssue) {
    const fieldValues = (state?: string | null, claim?: string | null) => ({
      nodes: [
        ...(state ? [{ name: state, field: { name: "Workflow State" } }] : []),
        ...(claim ? [{ text: claim, field: { name: "Claim" } }] : []),
      ],
    });
    return {
      id: `I_${fi.number}`,
      number: fi.number,
      title: `Issue ${fi.number}`,
      url: `https://github.com/cdubiel08/ralph-hero/issues/${fi.number}`,
      state: fi.issueState ?? "OPEN",
      stateReason: null,
      labels: { nodes: [] },
      parent: fi.parent ? { number: fi.parent, title: `Issue ${fi.parent}` } : null,
      subIssues: {
        nodes: (fi.children ?? []).map((c) => ({
          number: c.number,
          title: `Issue ${c.number}`,
          state: c.issueState,
          projectItems: {
            nodes: [{ project: { id: PROJECT_ID }, fieldValues: fieldValues(c.state) }],
          },
        })),
      },
      blockedBy: { nodes: [] },
      closedByPullRequestsReferences: { nodes: [] },
      comments: { nodes: (fi.comments ?? []).map((body) => ({ body })) },
      projectItems: {
        nodes: [
          { id: `ITEM_${fi.number}`, project: { id: PROJECT_ID }, fieldValues: fieldValues(fi.state, fi.claim) },
        ],
      },
    };
  }

  private graphql(payload: { query: string; variables: any }): ExecResult {
    const { query, variables } = payload;

    if (query.includes("projectV2(number")) {
      return data({
        user: {
          projectV2: {
            id: PROJECT_ID,
            fields: {
              nodes: [
                {
                  id: "F_state", name: "Workflow State", dataType: "SINGLE_SELECT",
                  options: [...STATES, ...LEGACY_STATES].map((s) => ({ id: `OPT_${s}`, name: s })),
                },
                { id: "F_claim", name: "Claim", dataType: "TEXT" },
                {
                  id: "F_status", name: "Status", dataType: "SINGLE_SELECT",
                  options: ["Todo", "In Progress", "Done"].map((s) => ({ id: `S_${s}`, name: s })),
                },
                {
                  id: "F_estimate", name: "Estimate", dataType: "SINGLE_SELECT",
                  options: ["XS", "S", "M", "L", "XL"].map((s) => ({ id: `E_${s}`, name: s })),
                },
              ],
            },
          },
        },
      });
    }
    if (query.includes("repository(owner") && query.includes("{ id }") && !query.includes("issue(number")) {
      return data({ repository: { id: "R_test" } });
    }
    if (query.includes("comments(last")) {
      const fi = this.issues.get(variables.number)!;
      return data({ repository: { issue: { comments: { nodes: (fi.comments ?? []).map((b) => ({ body: b })) } } } });
    }
    if (query.includes("issue(number")) {
      const fi = this.issues.get(variables.number);
      if (!fi) return data({ repository: { issue: null } });
      return data({ repository: { issue: this.issuePayload(fi) } });
    }
    if (query.includes("items(first")) {
      return data({
        node: {
          items: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [...this.issues.values()].map((fi) => ({
              content: {
                number: fi.number, title: `Issue ${fi.number}`, state: fi.issueState ?? "OPEN",
                repository: { nameWithOwner: "cdubiel08/ralph-hero" },
                parent: fi.parent ? { number: fi.parent } : null,
                blockedBy: { nodes: [] },
              },
              fieldValues: {
                nodes: [
                  ...(fi.state ? [{ name: fi.state, field: { name: "Workflow State" } }] : []),
                  ...(fi.claim ? [{ text: fi.claim, field: { name: "Claim" } }] : []),
                ],
              },
            })),
          },
        },
      });
    }

    // Mutations — record, and update the in-memory board so echo re-reads see them.
    if (query.includes("updateProjectV2ItemFieldValue")) {
      const itemNum = Number(String(variables.itemId).replace("ITEM_", ""));
      const fi = this.issues.get(itemNum);
      if (variables.optionId && variables.fieldId === "F_state" && fi) {
        fi.state = String(variables.optionId).replace("OPT_", "");
        this.mutations.push(`setState(#${itemNum}, ${fi.state})`);
      } else if (variables.fieldId === "F_claim" && fi) {
        fi.claim = variables.text;
        this.mutations.push(`setClaim(#${itemNum})`);
      } else {
        this.mutations.push(`setField(${variables.fieldId})`);
      }
      return data({ updateProjectV2ItemFieldValue: { projectV2Item: { id: variables.itemId } } });
    }
    if (query.includes("clearProjectV2ItemFieldValue")) {
      const itemNum = Number(String(variables.itemId).replace("ITEM_", ""));
      const fi = this.issues.get(itemNum);
      if (fi && variables.fieldId === "F_claim") fi.claim = null;
      this.mutations.push(`clearField(#${itemNum}, ${variables.fieldId})`);
      return data({ clearProjectV2ItemFieldValue: { projectV2Item: { id: variables.itemId } } });
    }
    if (query.includes("addComment")) {
      this.comments.push({ body: variables.body });
      this.mutations.push("addComment");
      return data({ addComment: { clientMutationId: null } });
    }
    if (query.includes("closeIssue")) {
      const num = Number(String(variables.issueId).replace("I_", ""));
      const fi = this.issues.get(num);
      if (fi) fi.issueState = "CLOSED";
      this.mutations.push(`closeIssue(#${num}, ${variables.stateReason})`);
      return data({ closeIssue: { issue: { id: variables.issueId } } });
    }
    if (query.includes("reopenIssue")) {
      this.mutations.push("reopenIssue");
      return data({ reopenIssue: { issue: { id: variables.issueId } } });
    }
    if (query.includes("addSubIssue")) {
      this.mutations.push("addSubIssue");
      return data({ addSubIssue: { issue: { id: "x" } } });
    }
    if (query.includes("addBlockedBy") || query.includes("removeBlockedBy")) {
      this.mutations.push("dep");
      return data({ addBlockedBy: { issue: { id: "x" } }, removeBlockedBy: { issue: { id: "x" } } });
    }
    if (query.includes("createIssue")) {
      const number = 900 + this.issues.size;
      this.issues.set(number, { number, state: null });
      return data({ createIssue: { issue: { id: `I_${number}`, number, url: `u/${number}` } } });
    }
    if (query.includes("addProjectV2ItemById")) {
      const num = Number(String(variables.contentId).replace("I_", ""));
      return data({ addProjectV2ItemById: { item: { id: `ITEM_${num}` } } });
    }
    return { code: 1, stdout: "", stderr: `unhandled query: ${query.slice(0, 120)}` };
  }
}

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: "" });
const data = (d: unknown): ExecResult => ok(JSON.stringify({ data: d }));

function makeCtx(gh: FakeGh, holder = "me@test"): Ctx {
  const cfg: Config = {
    owner: "cdubiel08",
    repo: "ralph-hero",
    projectNumber: 13,
    lockTtlMin: 120,
    holder,
  };
  return {
    exec: gh.exec,
    cfg,
    repoRoot: "/repo",
    cacheDir: mkdtempSync(join(tmpdir(), "board-test-")),
    now: () => NOW,
  };
}

describe("transition engine", () => {
  let gh: FakeGh;
  let ctx: Ctx;
  beforeEach(() => {
    gh = new FakeGh();
    ctx = makeCtx(gh);
  });

  it("claim from Backlog: clear-then-set claim, then state; echo re-reads (parity)", () => {
    gh.issues.set(1, { number: 1, state: "Backlog" });
    const after = transition(ctx, fetchIssue(ctx, 1), "In Progress");
    expect(gh.mutations.slice(0, 3)).toEqual(["clearField(#1, F_claim)", "setClaim(#1)", "setState(#1, In Progress)"]);
    expect(after.state).toBe("In Progress");
    expect(after.claim?.holder).toBe("me@test");
    expect(after.claim?.since).toEqual(NOW);
  });

  it("refuses a live foreign claim, naming holder and TTL", () => {
    gh.issues.set(1, {
      number: 1, state: "Backlog",
      claim: encodeClaim("other@host", new Date(NOW.getTime() - 30 * 60_000)),
    });
    expect(() => transition(ctx, fetchIssue(ctx, 1), "In Progress")).toThrow(RefusalError);
    expect(() => transition(ctx, fetchIssue(ctx, 1), "In Progress")).toThrow(/other@host/);
    expect(gh.mutations).toEqual([]); // refused before any write
  });

  it("stale foreign claim: refused without --steal, evicted with it (comment posted)", () => {
    gh.issues.set(1, {
      number: 1, state: "Backlog",
      claim: encodeClaim("other@host", new Date(NOW.getTime() - 300 * 60_000)),
    });
    expect(() => transition(ctx, fetchIssue(ctx, 1), "In Progress")).toThrow(/--steal/);
    const after = transition(ctx, fetchIssue(ctx, 1), "In Progress", { steal: true });
    expect(gh.comments.some((c) => c.body.includes("evicted"))).toBe(true);
    expect(after.claim?.holder).toBe("me@test");
  });

  it("leaving In Progress requires holder-or-stale; clears the claim", () => {
    gh.issues.set(1, {
      number: 1, state: "In Progress",
      claim: encodeClaim("other@host", new Date(NOW.getTime() - 10 * 60_000)),
    });
    expect(() => transition(ctx, fetchIssue(ctx, 1), "In Review")).toThrow(RefusalError);

    gh.issues.get(1)!.claim = encodeClaim("me@test", NOW);
    const after = transition(ctx, fetchIssue(ctx, 1), "In Review");
    expect(after.state).toBe("In Review");
    expect(after.claim).toBeNull();
  });

  it("illegal transitions are refused with the legal set named", () => {
    gh.issues.set(1, { number: 1, state: "Backlog" });
    expect(() => transition(ctx, fetchIssue(ctx, 1), "Done")).toThrow(/Legal: In Progress, Canceled/);
    expect(gh.mutations).toEqual([]);
  });

  it("legacy states are frozen until migrate", () => {
    gh.issues.set(1, { number: 1, state: "Ready for Plan" });
    expect(() => transition(ctx, fetchIssue(ctx, 1), "In Progress")).toThrow(/board migrate/);
  });

  it("Human Needed requires --why and posts it as the escalation comment", () => {
    gh.issues.set(1, { number: 1, state: "In Progress", claim: encodeClaim("me@test", NOW) });
    expect(() => transition(ctx, fetchIssue(ctx, 1), "Human Needed")).toThrow(UsageError);
    transition(ctx, fetchIssue(ctx, 1), "Human Needed", { why: "need a decision on X" });
    expect(gh.comments.some((c) => c.body.includes("need a decision on X"))).toBe(true);
  });

  it("Done closes the issue as COMPLETED; Canceled as NOT_PLANNED", () => {
    gh.issues.set(1, { number: 1, state: "In Review" });
    transition(ctx, fetchIssue(ctx, 1), "Done");
    expect(gh.mutations).toContain("closeIssue(#1, COMPLETED)");

    gh.issues.set(2, { number: 2, state: "Backlog" });
    transition(ctx, fetchIssue(ctx, 2), "Canceled", { why: "superseded" });
    expect(gh.mutations).toContain("closeIssue(#2, NOT_PLANNED)");
  });

  it("reopen only from terminal states", () => {
    gh.issues.set(1, { number: 1, state: "In Progress", claim: encodeClaim("me@test", NOW) });
    expect(() => transition(ctx, fetchIssue(ctx, 1), "Backlog", { isReopen: true })).toThrow(/reopen is for/);
  });
});

describe("parent gate", () => {
  it("advances only when every child is closed, with a comment", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    gh.issues.set(10, {
      number: 10, state: "In Progress", claim: encodeClaim("me@test", NOW),
      children: [
        { number: 11, issueState: "CLOSED", state: "Done" },
        { number: 12, issueState: "OPEN", state: "In Progress" },
      ],
    });
    expect(parentCheck(ctx, 10)).toMatch(/1\/2 children still open/);
    expect(gh.mutations.filter((m) => m.startsWith("setState"))).toEqual([]);

    gh.issues.get(10)!.children![1] = { number: 12, issueState: "CLOSED", state: "Done" };
    expect(parentCheck(ctx, 10)).toMatch(/advanced to In Review/);
    expect(gh.mutations).toContain("setState(#10, In Review)");
    expect(gh.comments.some((c) => c.body.includes("children closed"))).toBe(true);
  });
});

describe("doctor + migrate", () => {
  it("doctor: legacy states warn by default, fail under --strict", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    gh.issues.set(1, { number: 1, state: "Ready for Plan" });

    const lax = doctor(ctx);
    expect(lax.ok).toBe(true);
    expect(lax.checks.find((c) => c.name === "legacy-items")?.level).toBe("warn");

    const strict = doctor(ctx, { strict: true });
    expect(strict.ok).toBe(false);
  });

  it("doctor --fix releases stale claims back to Backlog with a comment", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    gh.issues.set(1, {
      number: 1, state: "In Progress",
      claim: encodeClaim("dead@host", new Date(NOW.getTime() - 999 * 60_000)),
    });
    doctor(ctx, { fix: true });
    expect(gh.issues.get(1)!.state).toBe("Backlog");
    expect(gh.comments.some((c) => c.body.includes("stale claim"))).toBe(true);
  });

  it("migrate: dry-run by default; Decision Request routes Plan in Review to Human Needed", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    gh.issues.set(1, { number: 1, state: "Ready for Plan" });
    gh.issues.set(2, { number: 2, state: "Plan in Review", comments: ["## Decision Request\npick one"] });
    gh.issues.set(3, { number: 3, state: "In Progress" });

    const dry = migrate(ctx);
    expect(dry).toContain('#1: "Ready for Plan" → "Backlog" (dry-run)');
    expect(dry).toContain('#2: "Plan in Review" → "Human Needed" (dry-run)');
    expect(dry.some((l) => l.includes("#3"))).toBe(false);
    expect(gh.mutations.filter((m) => m.startsWith("setState"))).toEqual([]);

    migrate(ctx, { apply: true });
    expect(gh.issues.get(1)!.state).toBe("Backlog");
    expect(gh.issues.get(2)!.state).toBe("Human Needed");
    expect(gh.comments.filter((c) => c.body.includes("board migrate")).length).toBe(2);
  });
});
