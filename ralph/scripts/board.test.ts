/**
 * board.test.ts — the machine's contract. Every invariant named in the design
 * (thoughts/shared/ideas/2026-07-31-ralph-v2-minimal-harness.md §2) has a test.
 * Pure core + injected exec; no network.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  adopt,
  claimIsStale,
  type Config,
  createIssue,
  type Ctx,
  doctor,
  encodeClaim,
  type ExecResult,
  fetchIssue,
  legalTransition,
  LEGACY_STATES,
  listItems,
  MACHINE,
  migrate,
  migrateMapping,
  parentCheck,
  parseArgs,
  parseClaim,
  parseStateArg,
  parseTtlMin,
  type QueueItem,
  rankNext,
  readiness,
  reconcile,
  RefusalError,
  run,
  scopeMatches,
  setup,
  STATES,
  transition,
  UsageError,
} from "./board.js";

// ---------------------------------------------------------------------------
// Pure logic
// ---------------------------------------------------------------------------

describe("state machine", () => {
  it("encodes exactly the designed transition table — terminal states have no move edges", () => {
    expect(MACHINE).toEqual({
      Backlog: ["In Progress", "Canceled"],
      "In Progress": ["In Review", "Human Needed", "Backlog", "Canceled"],
      "In Review": ["Done", "In Progress", "Human Needed", "Canceled"],
      "Human Needed": ["In Progress", "Backlog", "Canceled"],
      Done: [],
      Canceled: [],
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
      ["Done", "Backlog"], // exit is reopen, never move
      ["Canceled", "Backlog"],
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
    repo: "cdubiel08/ralph-hero",
    title: `t${n}`,
    state: "Backlog",
    priority: null,
    hasParent: false,
    openBlockers: [],
    openBlockerLabels: [],
    blockersTruncated: false,
    claim: null,
    claimRaw: null,
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
      item(8, { blockersTruncated: true }), // truncated blocker list = blocked (fail closed)
    ];
    const { eligible, blocked } = rankNext(items);
    expect(eligible.map((i) => i.number)).toEqual([3, 2, 4, 10]);
    expect(blocked.map((i) => i.number)).toEqual([5, 8]);
  });

  it("priority sort is numeric, not lexicographic — P10 ranks after P2", () => {
    const items = [item(1, { priority: "P10" }), item(2, { priority: "P2" }), item(3, { priority: "P0" })];
    expect(rankNext(items).eligible.map((i) => i.number)).toEqual([3, 2, 1]);
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
  it("accepts https/ssh forms of the configured repo, case-insensitively, incl. trailing slash", () => {
    for (const url of [
      "https://github.com/cdubiel08/ralph-hero.git",
      "https://github.com/cdubiel08/ralph-hero",
      "https://github.com/cdubiel08/ralph-hero/",
      "git@github.com:cdubiel08/ralph-hero.git",
      "ssh://git@github.com/CDubiel08/Ralph-Hero.git",
    ]) {
      expect(scopeMatches(url, "cdubiel08", "ralph-hero"), url).toBe(true);
    }
  });

  it("refuses other repos, OTHER HOSTS with matching owner/repo, and garbage", () => {
    expect(scopeMatches("git@github.com:other/ralph-hero.git", "cdubiel08", "ralph-hero")).toBe(false);
    expect(scopeMatches("https://github.com/cdubiel08/other.git", "cdubiel08", "ralph-hero")).toBe(false);
    expect(scopeMatches("https://gitlab.example.com/cdubiel08/ralph-hero.git", "cdubiel08", "ralph-hero")).toBe(false);
    expect(scopeMatches("git@internal-mirror:cdubiel08/ralph-hero.git", "cdubiel08", "ralph-hero")).toBe(false);
    expect(scopeMatches("", "cdubiel08", "ralph-hero")).toBe(false);
  });

  it("host is configurable for GHE remotes, including SSH on a non-default port", () => {
    expect(scopeMatches("git@ghe.corp:cdubiel08/ralph-hero.git", "cdubiel08", "ralph-hero", "ghe.corp")).toBe(true);
    expect(scopeMatches("ssh://git@ghe.corp:22/cdubiel08/ralph-hero.git", "cdubiel08", "ralph-hero", "ghe.corp")).toBe(true);
    expect(scopeMatches("ssh://git@ghe.corp:2222/cdubiel08/ralph-hero.git", "cdubiel08", "ralph-hero", "ghe.corp")).toBe(true);
  });

  it("deep paths and subgroup-style remotes are refused (exactly owner/repo)", () => {
    expect(scopeMatches("https://github.com/cdubiel08/group/ralph-hero.git", "cdubiel08", "ralph-hero")).toBe(false);
  });
});

describe("parseTtlMin", () => {
  it("valid values pass; unset/empty/garbage/non-positive fall back to 120", () => {
    expect(parseTtlMin("60")).toBe(60);
    expect(parseTtlMin(undefined)).toBe(120);
    expect(parseTtlMin("")).toBe(120); // "" → 0 would make every claim instantly stealable
    expect(parseTtlMin("120min")).toBe(120); // NaN would make no claim ever expire
    expect(parseTtlMin("0")).toBe(120);
    expect(parseTtlMin("-5")).toBe(120);
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
  archived?: boolean;
  repo?: string; // nameWithOwner in the bulk items view; defaults to the own repo
  blockedBy?: Array<{ number: number; state: "OPEN" | "CLOSED"; repo?: string }>;
  state?: string | null;
  claim?: string | null;
  issueState?: "OPEN" | "CLOSED";
  stateReason?: string | null;
  onBoard?: boolean; // default true
  parent?: number;
  children?: Array<{ number: number; issueState: "OPEN" | "CLOSED"; state?: string | null }>;
  childrenTruncated?: boolean;
  comments?: string[];
  prs?: Array<{ number: number; merged: boolean }>;
}

/** Minimal in-memory board: answers the exact queries board.ts issues and
 *  records every mutation, so clear-then-set ordering is observable. */
class FakeGh {
  mutations: string[] = [];
  comments: Array<{ body: string }> = [];
  issues = new Map<number, FakeIssue>();
  failNextStateWrite = false; // transport-failure injection
  failNextComment = false;
  raceClaimTo: string | null = null; // simulate a concurrent writer winning the claim
  vanishClaim = false; // simulate a concurrent clear landing after our write
  stickyClaim = false; // simulate a claim clear silently not sticking
  dropCreates = false; // simulate a field create acking but not sticking
  refreshClaimOnFetch = new Set<number>(); // holder renews its claim mid-sweep
  omitFields: string[] = []; // simulate a fresh board missing these fields
  createdFields: Array<{ name: string; dataType: string; options?: string[] }> = [];
  linkedRepos = ["cdubiel08/ralph-hero"]; // projectV2 → repositories linkage

  expectedHost = "github.com"; // strict: a missing/wrong --hostname fails every test

  exec: (argv: string[], stdin?: string) => ExecResult = (argv, stdin) => {
    const cmd = argv.join(" ");
    if (cmd.startsWith("gh api graphql")) {
      if (!cmd.includes(`--hostname ${this.expectedHost}`)) {
        return { code: 1, stdout: "", stderr: `wrong or missing --hostname (want ${this.expectedHost}): ${cmd}` };
      }
      return this.graphql(JSON.parse(stdin!));
    }
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
      stateReason: fi.stateReason ?? null,
      labels: { nodes: [] },
      parent: fi.parent ? { number: fi.parent, title: `Issue ${fi.parent}` } : null,
      subIssues: {
        pageInfo: { hasNextPage: fi.childrenTruncated ?? false },
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
      closedByPullRequestsReferences: {
        nodes: (fi.prs ?? []).map((p) => ({
          number: p.number,
          url: `https://github.com/cdubiel08/ralph-hero/pull/${p.number}`,
          state: p.merged ? "MERGED" : "OPEN",
          merged: p.merged,
        })),
      },
      comments: { nodes: (fi.comments ?? []).map((body) => ({ body })) },
      projectItems: {
        nodes:
          fi.onBoard === false
            ? []
            : [
                {
                  id: `ITEM_${fi.number}`,
                  isArchived: fi.archived ?? false,
                  project: { id: PROJECT_ID },
                  fieldValues: fieldValues(fi.state, fi.claim),
                },
              ],
      },
    };
  }

  private graphql(payload: { query: string; variables: any }): ExecResult {
    const { query, variables } = payload;

    if (query.includes("projectV2(number")) {
      const defaults = [
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
        {
          id: "F_priority", name: "Priority", dataType: "SINGLE_SELECT",
          options: ["P0", "P1", "P2", "P3"].map((s) => ({ id: `P_${s}`, name: s })),
        },
      ];
      const created = this.createdFields.map((f) => ({
        id: `F_${f.name}`, name: f.name, dataType: f.dataType,
        options: f.options?.map((o) => ({ id: `${f.name}_${o}`, name: o })),
      }));
      return data({
        user: {
          projectV2: {
            id: PROJECT_ID,
            fields: { nodes: [...defaults.filter((f) => !this.omitFields.includes(f.name)), ...created] },
          },
        },
      });
    }
    if (query.includes("createProjectV2Field")) {
      const dataType = query.includes("dataType: TEXT") ? "TEXT" : "SINGLE_SELECT";
      if (!this.dropCreates) {
        this.createdFields.push({
          name: variables.name,
          dataType,
          options: (variables.options as Array<{ name: string }> | undefined)?.map((o) => o.name),
        });
      }
      this.mutations.push(`createField(${variables.name})`);
      return data({ createProjectV2Field: { projectV2Field: { id: `F_${variables.name}` } } });
    }
    if (query.includes("repositories(first")) {
      return data({
        node: { repositories: { nodes: this.linkedRepos.map((r) => ({ nameWithOwner: r })) } },
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
      // The holder refreshed its claim between the page walk and this re-read.
      if (fi.claim && this.refreshClaimOnFetch.has(fi.number)) {
        this.refreshClaimOnFetch.delete(fi.number);
        fi.claim = encodeClaim(fi.claim.slice(0, fi.claim.lastIndexOf("|")), NOW);
      }
      return data({ repository: { issue: this.issuePayload(fi) } });
    }
    if (query.includes("items(first")) {
      return data({
        node: {
          items: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [...this.issues.values()].map((fi) => ({
              isArchived: fi.archived ?? false,
              content: {
                number: fi.number, title: `Issue ${fi.number}`, state: fi.issueState ?? "OPEN",
                repository: { nameWithOwner: fi.repo ?? "cdubiel08/ralph-hero" },
                parent: fi.parent ? { number: fi.parent } : null,
                blockedBy: {
                  pageInfo: { hasNextPage: false },
                  nodes: (fi.blockedBy ?? []).map((b) => ({
                    number: b.number,
                    state: b.state,
                    repository: { nameWithOwner: b.repo ?? "cdubiel08/ralph-hero" },
                  })),
                },
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
        if (this.failNextStateWrite) {
          this.failNextStateWrite = false;
          return { code: 1, stdout: "", stderr: "simulated transport failure" };
        }
        fi.state = String(variables.optionId).replace("OPT_", "");
        this.mutations.push(`setState(#${itemNum}, ${fi.state})`);
      } else if (variables.fieldId === "F_claim" && fi) {
        // A concurrent writer's claim (or clear) can land last — no CAS on Projects V2.
        fi.claim = this.vanishClaim
          ? null
          : this.raceClaimTo
            ? `${this.raceClaimTo}|${new Date().toISOString()}`
            : variables.text;
        this.mutations.push(`setClaim(#${itemNum})`);
      } else {
        this.mutations.push(`setField(${variables.fieldId})`);
      }
      return data({ updateProjectV2ItemFieldValue: { projectV2Item: { id: variables.itemId } } });
    }
    if (query.includes("clearProjectV2ItemFieldValue")) {
      const itemNum = Number(String(variables.itemId).replace("ITEM_", ""));
      const fi = this.issues.get(itemNum);
      if (fi && variables.fieldId === "F_claim" && !this.stickyClaim) fi.claim = null;
      this.mutations.push(`clearField(#${itemNum}, ${variables.fieldId})`);
      return data({ clearProjectV2ItemFieldValue: { projectV2Item: { id: variables.itemId } } });
    }
    if (query.includes("addComment")) {
      if (this.failNextComment) {
        this.failNextComment = false;
        return { code: 1, stdout: "", stderr: "simulated comment failure" };
      }
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
      const fi = this.issues.get(num);
      if (fi) fi.onBoard = true;
      this.mutations.push(`addToBoard(#${num})`);
      return data({ addProjectV2ItemById: { item: { id: `ITEM_${num}` } } });
    }
    return { code: 1, stdout: "", stderr: `unhandled query: ${query.slice(0, 120)}` };
  }
}

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: "" });
const data = (d: unknown): ExecResult => ok(JSON.stringify({ data: d }));

function makeCtx(gh: FakeGh, holder = "me@test", repoRoot = "/repo"): Ctx {
  const cfg: Config = {
    owner: "cdubiel08",
    repo: "ralph-hero",
    projectNumber: 13,
    host: "github.com",
    lockTtlMin: 120,
    holder,
  };
  return {
    // Delegate per-call so tests may overlay gh.exec after ctx construction.
    exec: (argv, stdin) => gh.exec(argv, stdin),
    cfg,
    repoRoot,
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
    gh.issues.set(1, { number: 1, state: "In Review", prs: [{ number: 101, merged: true }] });
    transition(ctx, fetchIssue(ctx, 1), "Done");
    expect(gh.mutations).toContain("closeIssue(#1, COMPLETED)");

    gh.issues.set(2, { number: 2, state: "Backlog" });
    transition(ctx, fetchIssue(ctx, 2), "Canceled", { why: "superseded" });
    expect(gh.mutations).toContain("closeIssue(#2, NOT_PLANNED)");
  });

  it("Done requires evidence: no merged linked PR and no --why is refused before any write", () => {
    gh.issues.set(1, { number: 1, state: "In Review", prs: [{ number: 101, merged: false }] });
    expect(() => transition(ctx, fetchIssue(ctx, 1), "Done")).toThrow(UsageError);
    expect(() => transition(ctx, fetchIssue(ctx, 1), "Done")).toThrow(/merged linked PR.*--why/s);
    expect(gh.mutations).toEqual([]);
  });

  it("Done with a merged linked PR proceeds without --why and posts no extra comment", () => {
    gh.issues.set(1, { number: 1, state: "In Review", prs: [{ number: 101, merged: true }] });
    const after = transition(ctx, fetchIssue(ctx, 1), "Done");
    expect(after.state).toBe("Done");
    expect(gh.comments).toEqual([]);
  });

  it("Done without a PR but with --why posts the completion comment BEFORE the state write", () => {
    gh.issues.set(1, { number: 1, state: "In Review" });
    const after = transition(ctx, fetchIssue(ctx, 1), "Done", { why: "docs-only change, no PR" });
    expect(after.state).toBe("Done");
    const comment = gh.comments.find((c) => c.body.includes("Completed without merged PR"));
    expect(comment?.body).toContain("docs-only change, no PR");
    expect(gh.mutations.indexOf("addComment")).toBeLessThan(gh.mutations.indexOf("setState(#1, Done)"));
  });

  it("leaving In Progress verifies the clear on read-back — a surviving self-held claim is refused", () => {
    gh.stickyClaim = true;
    gh.issues.set(1, { number: 1, state: "In Progress", claim: encodeClaim("me@test", NOW) });
    expect(() => transition(ctx, fetchIssue(ctx, 1), "In Review")).toThrow(RefusalError);

    gh.issues.set(1, { number: 1, state: "In Progress", claim: encodeClaim("me@test", NOW) });
    expect(() => transition(ctx, fetchIssue(ctx, 1), "In Review")).toThrow(/did not stick/);
  });

  it("a state-write failure after the claim write rolls the claim back before rethrowing", () => {
    gh.issues.set(1, { number: 1, state: "Backlog" });
    gh.failNextStateWrite = true;
    expect(() => transition(ctx, fetchIssue(ctx, 1), "In Progress")).toThrow(
      /transport failure|gh api graphql failed/,
    );
    expect(gh.issues.get(1)!.claim).toBeNull(); // rollback cleared the orphan claim
    expect(gh.mutations.filter((m) => m === "clearField(#1, F_claim)")).toHaveLength(2);
  });

  it("reopen only from terminal states", () => {
    gh.issues.set(1, { number: 1, state: "In Progress", claim: encodeClaim("me@test", NOW) });
    expect(() => transition(ctx, fetchIssue(ctx, 1), "Backlog", { isReopen: true })).toThrow(/reopen is for/);
  });

  it("reopen from Done reopens the GitHub issue too — a bare move cannot exit a terminal state", () => {
    gh.issues.set(1, { number: 1, state: "Done", issueState: "CLOSED" });
    expect(() => transition(ctx, fetchIssue(ctx, 1), "Backlog")).toThrow(/use reopen/);
    const after = transition(ctx, fetchIssue(ctx, 1), "Backlog", { isReopen: true });
    expect(after.state).toBe("Backlog");
    expect(gh.mutations).toContain("reopenIssue");
  });

  it("a mid-write transport failure throws WITHOUT replaying earlier writes", () => {
    gh.issues.set(1, { number: 1, state: "In Progress", claim: encodeClaim("me@test", NOW) });
    gh.failNextStateWrite = true;
    expect(() =>
      transition(ctx, fetchIssue(ctx, 1), "Human Needed", { why: "decision X" }),
    ).toThrow(/transport failure|gh api graphql failed/);
    // The escalation comment was posted exactly once — no retry replay.
    expect(gh.comments.filter((c) => c.body.includes("decision X"))).toHaveLength(1);
  });

  it("claim race: the loser detects the overwrite on read-back and backs off", () => {
    gh.issues.set(1, { number: 1, state: "Backlog" });
    gh.raceClaimTo = "rival@other";
    expect(() => transition(ctx, fetchIssue(ctx, 1), "In Progress")).toThrow(/lost the claim race.*rival@other/);
  });

  it("claim from In Progress is (re)acquisition: adopts claimless WIP, refuses a live foreign claim", () => {
    gh.issues.set(1, { number: 1, state: "In Progress" }); // claimless WIP (pre-v2 or UI-driven)
    const after = transition(ctx, fetchIssue(ctx, 1), "In Progress");
    expect(after.claim?.holder).toBe("me@test");

    gh.issues.set(2, {
      number: 2, state: "In Progress",
      claim: encodeClaim("other@host", new Date(NOW.getTime() - 5 * 60_000)),
    });
    expect(() => transition(ctx, fetchIssue(ctx, 2), "In Progress")).toThrow(/other@host/);
  });

  it("claim read-back also rejects a VANISHED claim (concurrent clear)", () => {
    gh.issues.set(1, { number: 1, state: "Backlog" });
    gh.vanishClaim = true;
    expect(() => transition(ctx, fetchIssue(ctx, 1), "In Progress")).toThrow(/vanished/);
  });

  it("a stale cache lacking the Claim field refreshes before the skip decision — the claim IS written", () => {
    // Simulates: cache snapshot taken before `board setup` created Claim;
    // the live schema has it. The skip-if-absent decision must see live truth.
    gh.issues.set(1, { number: 1, state: "Backlog" });
    writeFileSync(
      join(ctx.cacheDir, "board-cdubiel08-ralph-hero-13.json"),
      JSON.stringify({
        projectId: "PVT_test",
        repositoryId: "R_test",
        fields: {
          "Workflow State": {
            id: "F_state", dataType: "SINGLE_SELECT",
            options: Object.fromEntries([...STATES, ...LEGACY_STATES].map((s) => [s, `OPT_${s}`])),
          },
        },
        fetchedAt: "2026-01-01T00:00:00Z",
      }),
    );
    const after = transition(ctx, fetchIssue(ctx, 1), "In Progress");
    expect(after.claim?.holder).toBe("me@test");
    expect(gh.mutations).toContain("setClaim(#1)");
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

  it("fails closed on a truncated children list — never gates on partial data", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    gh.issues.set(10, {
      number: 10, state: "In Progress", claim: encodeClaim("me@test", NOW),
      children: [{ number: 11, issueState: "CLOSED", state: "Done" }],
      childrenTruncated: true,
    });
    expect(parentCheck(ctx, 10)).toMatch(/refusing to gate on a truncated list/);
    expect(gh.mutations.filter((m) => m.startsWith("setState"))).toEqual([]);
  });
});

describe("guards at the CLI boundary", () => {
  it("create refuses terminal states — an OPEN issue must never sit in Done", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    expect(() => createIssue(ctx, { title: "x", state: "Done" })).toThrow(UsageError);
  });

  it("run(): scope gate covers mutations AND doctor --fix, not plain reads", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    ctx.exec = (argv, stdin) => {
      if (argv.join(" ").includes("remote get-url"))
        return { code: 0, stdout: "git@github.com:someone-else/other.git\n", stderr: "" };
      return gh.exec(argv, stdin);
    };
    gh.issues.set(1, { number: 1, state: "Backlog" });
    expect(() => run(["comment", "1", "-m", "x"], ctx)).toThrow(RefusalError);
    expect(() => run(["doctor", "--fix"], ctx)).toThrow(RefusalError);
    expect(run(["doctor"], ctx)).toBeTypeOf("number"); // read path still works anywhere
  });

  it("run(): a configured GHE host is used by BOTH the scope gate and the API transport", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    ctx.cfg.host = "ghe.corp";
    gh.expectedHost = "ghe.corp"; // fake refuses graphql not addressed to the GHE host
    ctx.exec = (argv, stdin) => {
      if (argv.join(" ").includes("remote get-url"))
        return { code: 0, stdout: "git@ghe.corp:cdubiel08/ralph-hero.git\n", stderr: "" };
      return gh.exec(argv, stdin);
    };
    gh.issues.set(1, { number: 1, state: "Backlog" });
    expect(run(["comment", "1", "-m", "x"], ctx)).toBe(0);
    expect(gh.comments.some((c) => c.body === "x")).toBe(true);
  });
});

describe("reality-sync lane (adopt + reconcile)", () => {
  let gh: FakeGh;
  let ctx: Ctx;
  beforeEach(() => {
    gh = new FakeGh();
    ctx = makeCtx(gh);
  });

  it("adopt puts an off-board issue on the board in Backlog", () => {
    gh.issues.set(1, { number: 1, onBoard: false, state: null });
    const after = adopt(ctx, 1);
    expect(gh.mutations).toContain("addToBoard(#1)");
    expect(after.state).toBe("Backlog");
  });

  it("reconcile: closed-as-completed wins over any board state, bypassing the intent table", () => {
    gh.issues.set(1, { number: 1, state: "Backlog", issueState: "CLOSED", stateReason: "COMPLETED" });
    expect(reconcile(ctx, 1)).toMatch(/→ "Done"/);
    expect(gh.issues.get(1)!.state).toBe("Done");
    expect(gh.comments.some((c) => c.body.includes("board reconcile"))).toBe(true);
  });

  it("reconcile: closed-as-not-planned → Canceled; clears any claim", () => {
    gh.issues.set(1, {
      number: 1, state: "In Progress", issueState: "CLOSED", stateReason: "NOT_PLANNED",
      claim: encodeClaim("dead@host", NOW),
    });
    reconcile(ctx, 1);
    expect(gh.issues.get(1)!.state).toBe("Canceled");
    expect(gh.issues.get(1)!.claim).toBeNull();
  });

  it("reconcile: reopened issue stuck in a terminal board state returns to Backlog", () => {
    gh.issues.set(1, { number: 1, state: "Done", issueState: "OPEN" });
    expect(reconcile(ctx, 1)).toMatch(/→ "Backlog"/);
  });

  it("reconcile: leaves legacy states to migrate, reports no-drift honestly", () => {
    gh.issues.set(1, { number: 1, state: "Ready for Plan", issueState: "OPEN" });
    expect(reconcile(ctx, 1)).toMatch(/migrate/);
    gh.issues.set(2, { number: 2, state: "In Progress" });
    expect(reconcile(ctx, 2)).toMatch(/no drift/);
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

  it("--fix re-verifies staleness on the fresh read — a renewed claim is left alone", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    gh.issues.set(1, {
      number: 1, state: "In Progress",
      claim: encodeClaim("busy@host", new Date(NOW.getTime() - 999 * 60_000)),
    });
    // Stale in the page walk, renewed by the time doctor re-reads it.
    gh.refreshClaimOnFetch.add(1);

    const report = doctor(ctx, { fix: true });
    expect(gh.issues.get(1)!.claim).not.toBeNull();
    expect(gh.issues.get(1)!.state).toBe("In Progress");
    expect(report.checks.some((c) => c.detail.includes("refreshed since the sweep"))).toBe(true);
    expect(gh.comments.some((c) => c.body.includes("stale claim"))).toBe(false);
  });

  it("stale-claim demotion is a deliberate fourth state write — no lane models a vanished holder", () => {
    // reconcile follows issue open/closed reality (unchanged here) and
    // transition needs an actor, so releasing a stale claim writes the state
    // field directly. Pinned so the three-lane rule stays an explicit choice.
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    gh.issues.set(1, {
      number: 1, state: "In Progress",
      claim: encodeClaim("dead@host", new Date(NOW.getTime() - 999 * 60_000)),
    });

    doctor(ctx, { fix: true });
    const stateWrites = gh.mutations.filter((m) => m.startsWith("setState("));
    expect(stateWrites).toHaveLength(1);
    expect(gh.issues.get(1)!.state).toBe("Backlog");
    expect(gh.issues.get(1)!.claim).toBeNull();
  });

  it("archived items are invisible to list/next/migrate — they cannot be written", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    gh.issues.set(1, { number: 1, state: "Ready for Plan", archived: true });
    gh.issues.set(2, { number: 2, state: "Ready for Plan" });
    const lines = migrate(ctx);
    expect(lines.some((l) => l.includes("#2"))).toBe(true);
    expect(lines.some((l) => l.includes("#1"))).toBe(false);
  });

  it("direct mutations refuse archived items with a clean message, not a raw API error", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    gh.issues.set(1, { number: 1, state: "Backlog", archived: true });
    expect(() => transition(ctx, fetchIssue(ctx, 1), "In Progress")).toThrow(/ARCHIVED.*Unarchive/);
    expect(reconcile(ctx, 1)).toMatch(/archived — skipped/);
  });

  it("migrate: a failed audit comment does NOT report the migration as FAILED", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    gh.issues.set(1, { number: 1, state: "Ready for Plan" });
    gh.failNextComment = true;
    const lines = migrate(ctx, { apply: true });
    expect(gh.issues.get(1)!.state).toBe("Backlog"); // state converged
    expect(lines[0]).toMatch(/audit comment failed/);
    expect(lines[0]).not.toMatch(/FAILED —/);
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

describe("doctor hardening (closed drift, fix gating, resilience, garbled claims)", () => {
  let gh: FakeGh;
  let ctx: Ctx;
  beforeEach(() => {
    gh = new FakeGh();
    ctx = makeCtx(gh);
  });

  it("closed issue stuck at In Review is closed-drift; --fix reconciles it to Done with a comment", () => {
    gh.issues.set(1, { number: 1, state: "In Review", issueState: "CLOSED", stateReason: "COMPLETED" });

    const report = doctor(ctx);
    const check = report.checks.find((c) => c.name === "closed-drift");
    expect(check?.level).toBe("warn");
    expect(check?.detail).toContain("#1(In Review)");

    doctor(ctx, { fix: true });
    expect(gh.issues.get(1)!.state).toBe("Done");
    expect(gh.comments.some((c) => c.body.includes("board reconcile"))).toBe(true);
  });

  it("closed items never leak into the queue — list/next see only open issues", () => {
    gh.issues.set(1, { number: 1, state: "Backlog" });
    gh.issues.set(2, { number: 2, state: "Backlog", issueState: "CLOSED", stateReason: "COMPLETED" });

    const items = listItems(ctx);
    expect(items.map((i) => i.number)).toEqual([1]);
    expect(rankNext(items).eligible.map((i) => i.number)).toEqual([1]);
  });

  it("--fix clears a STALE claim-anomaly but leaves a fresh one (transition mid-write) alone", () => {
    gh.issues.set(1, { number: 1, state: "In Review", claim: encodeClaim("racer@host", NOW) });
    gh.issues.set(2, {
      number: 2, state: "In Review",
      claim: encodeClaim("dead@host", new Date(NOW.getTime() - 999 * 60_000)),
    });

    const report = doctor(ctx, { fix: true });
    expect(report.checks.find((c) => c.name === "claim-anomalies")?.detail).toContain("#1(In Review)");
    expect(gh.issues.get(1)!.claim).toBe(encodeClaim("racer@host", NOW)); // fresh — untouched
    expect(gh.issues.get(2)!.claim).toBeNull(); // stale — cleared
  });

  it("one unwritable item gets its own fail line; the rest of the sweep still fixes", () => {
    gh.issues.set(1, { number: 1, state: "Done", issueState: "OPEN" }); // terminal drift ×2
    gh.issues.set(2, { number: 2, state: "Done", issueState: "OPEN" });
    gh.failNextStateWrite = true; // #1's reconcile write dies

    const report = doctor(ctx, { fix: true });
    const fails = report.checks.filter((c) => c.name === "fix" && c.level === "fail");
    expect(fails).toHaveLength(1);
    expect(fails[0].detail).toContain("#1");
    expect(gh.issues.get(2)!.state).toBe("Backlog"); // sweep survived #1
    expect(report.ok).toBe(false);
  });

  it("garbled claim text is claim-garbled (warn) and never auto-cleared, even under --fix", () => {
    gh.issues.set(1, { number: 1, state: "In Progress", claim: "not-a-claim" });

    const report = doctor(ctx, { fix: true });
    const check = report.checks.find((c) => c.name === "claim-garbled");
    expect(check?.level).toBe("warn");
    expect(check?.detail).toContain("#1");
    expect(gh.issues.get(1)!.claim).toBe("not-a-claim"); // surfaced, not fixed
  });

  it("foreign-repo items are an informational ok line, named with their repo", () => {
    gh.issues.set(1, { number: 1, state: "Backlog" });
    gh.issues.set(2, { number: 2, state: "Backlog", repo: "someone-else/theirs" });

    const check = doctor(ctx).checks.find((c) => c.name === "foreign-items");
    expect(check?.level).toBe("ok"); // informational, never a gate
    expect(check?.detail).toContain("someone-else/theirs#2");
    expect(check?.detail).toContain("never touches them");
  });

  it("claimless WIP warns and --fix leaves it alone — never yank a human's In Progress", () => {
    gh.issues.set(1, { number: 1, state: "In Progress" }); // no claim

    const report = doctor(ctx, { fix: true });
    const check = report.checks.find((c) => c.name === "claimless-wip");
    expect(check?.level).toBe("warn");
    expect(check?.detail).toContain("#1");
    expect(gh.issues.get(1)!.state).toBe("In Progress"); // untouched
    expect(gh.mutations).toEqual([]); // no fix wrote anything
  });

  it("items with no Workflow State are stateless-items (warn)", () => {
    gh.issues.set(1, { number: 1, state: null });

    const check = doctor(ctx).checks.find((c) => c.name === "stateless-items");
    expect(check?.level).toBe("warn");
    expect(check?.detail).toContain("#1");
  });

  it("a fail-level check makes report.ok false and the CLI exit nonzero", () => {
    gh.omitFields = ["Workflow State"]; // state-field missing = invariant breach

    const report = doctor(ctx);
    expect(report.checks.find((c) => c.name === "state-field")?.level).toBe("fail");
    expect(report.ok).toBe(false);

    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      expect(run(["doctor"], ctx)).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("next: cross-repo blocker labels", () => {
  it("a cross-repo blocker renders owner/repo#N in text and --json; own-repo stays #N; both block", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    gh.issues.set(1, {
      number: 1, state: "Backlog",
      blockedBy: [
        { number: 5, state: "OPEN", repo: "other/repo" },
        { number: 6, state: "OPEN" }, // own repo
        { number: 7, state: "CLOSED", repo: "other/repo" }, // closed — not a blocker
      ],
    });
    gh.issues.set(2, { number: 2, state: "Backlog" }); // eligible, so the blocked: line prints

    const lines: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((s) => {
      lines.push(String(s));
      return true;
    });
    try {
      run(["next", "--json"], ctx);
      const parsed = JSON.parse(lines.join(""));
      expect(parsed.next.number).toBe(2);
      expect(parsed.blocked[0].openBlockers).toEqual([5, 6]); // numbers keep ranking semantics
      expect(parsed.blocked[0].openBlockerLabels).toEqual(["other/repo#5", "#6"]);

      lines.length = 0;
      run(["next"], ctx);
      expect(lines.join("")).toContain("blocked: #1←other/repo#5+#6");
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Setup — full field provisioning, host conventions respected
// ---------------------------------------------------------------------------

describe("setup", () => {
  it("provisions ALL fields the CLI uses on a fresh board — state, claim, Estimate, Priority", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    gh.omitFields = ["Workflow State", "Claim", "Estimate", "Priority"];
    const { ok, notes } = setup(ctx);
    for (const f of ["Workflow State", "Claim", "Estimate", "Priority"]) {
      expect(gh.mutations).toContain(`createField(${f})`);
    }
    expect(notes.some((n) => n.includes('"Estimate" single-select (XS S M L XL)'))).toBe(true);
    expect(notes.some((n) => n.includes('"Priority" single-select (P0 P1 P2 P3)'))).toBe(true);
    expect(ok).toBe(true); // every create survived the verify re-read
  });

  it("respects a host repo's existing Estimate/Priority scheme — never edits an existing field", () => {
    const gh = new FakeGh(); // defaults include Estimate + Priority
    const ctx = makeCtx(gh);
    const { notes } = setup(ctx);
    expect(gh.mutations.filter((m) => m.startsWith("createField"))).toEqual([]);
    expect(notes.some((n) => n.includes("Estimate") || n.includes("Priority"))).toBe(false);
  });

  it("notes but never converts an Estimate of a different dataType (e.g. GitHub's number template)", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    gh.omitFields = ["Estimate"];
    gh.createdFields.push({ name: "Estimate", dataType: "NUMBER" }); // pre-existing, not ours
    const { notes } = setup(ctx);
    expect(gh.mutations.filter((m) => m.startsWith("createField"))).toEqual([]);
    expect(notes.some((n) => n.includes("exists as NUMBER — left untouched"))).toBe(true);
  });

  it("an existing state field missing v2 options gets a MANUAL note — the API cannot edit options", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    gh.omitFields = ["Workflow State"];
    gh.createdFields.push({
      name: "Workflow State", dataType: "SINGLE_SELECT",
      options: ["Backlog", "In Progress"], // pre-existing partial set, not ours
    });
    const { notes } = setup(ctx);
    expect(gh.mutations.filter((m) => m.startsWith("createField"))).toEqual([]);
    expect(notes.some((n) => n.startsWith("MANUAL: add option(s)") && n.includes("In Review"))).toBe(true);
  });

  it("legacy v1 options present get the MANUAL (after migrate) note", () => {
    const gh = new FakeGh(); // default Workflow State fixture includes LEGACY_STATES
    const ctx = makeCtx(gh);
    const { notes } = setup(ctx);
    expect(notes.some((n) => n.startsWith("MANUAL (after migrate):") && n.includes("Ready for Plan"))).toBe(true);
  });

  it("verifies its own work: a create that did not stick is a VERIFY FAILED note, ok=false, exit 1", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    gh.omitFields = ["Claim"];
    gh.dropCreates = true; // the create acks but the refreshed schema never shows it

    const streamed: string[] = [];
    const report = setup(ctx, (n) => streamed.push(n));
    expect(report.ok).toBe(false);
    expect(report.notes.some((n) => n.includes('VERIFY FAILED: "Claim" is absent after refresh'))).toBe(true);
    expect(streamed).toEqual(report.notes); // notes stream as produced — a mid-run throw loses nothing

    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      expect(run(["setup"], ctx)).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("warns (advisory, never blocks) when the project is not linked to the configured repo", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    gh.linkedRepos = ["stranger/board-owner"];
    const { ok, notes } = setup(ctx);
    expect(ok).toBe(true); // advisory only — recommend, never impose
    const warning = notes.find((n) => n.startsWith("WARNING:"));
    expect(warning).toContain("not linked to cdubiel08/ralph-hero");
    expect(warning).toContain("stranger/board-owner");
  });

  it("stays silent about linkage when the configured repo IS linked", () => {
    const gh = new FakeGh(); // default linkage includes cdubiel08/ralph-hero
    const ctx = makeCtx(gh);
    const { notes } = setup(ctx);
    expect(notes.some((n) => n.startsWith("WARNING:"))).toBe(false);
  });
});

describe("doctor advisory fields", () => {
  it("missing Estimate/Priority warn — never a failure, even under --strict", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    gh.omitFields = ["Estimate", "Priority"];
    const report = doctor(ctx, { strict: true });
    const check = report.checks.find((c) => c.name === "advisory-fields");
    expect(check?.level).toBe("warn"); // strict escalates invariants, not advice
    expect(check?.detail).toMatch(/Estimate, Priority missing/);
  });
});

// ---------------------------------------------------------------------------
// Readiness — advisory report; recommendations, never gates
// ---------------------------------------------------------------------------

/** Overlay REST answers (repo metadata + branch rules) on the FakeGh exec. */
function withRest(gh: FakeGh, opts: { prRule: boolean }) {
  const base = gh.exec;
  gh.exec = (argv, stdin) => {
    const cmd = argv.join(" ");
    if (cmd === "gh api --hostname github.com repos/cdubiel08/ralph-hero")
      return { code: 0, stdout: JSON.stringify({ default_branch: "main" }), stderr: "" };
    if (cmd.endsWith("rules/branches/main"))
      return { code: 0, stdout: JSON.stringify(opts.prRule ? [{ type: "pull_request" }] : []), stderr: "" };
    return base(argv, stdin);
  };
}

describe("readiness", () => {
  it("a bare repo reports gaps as recommendations and never throws", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh, "me@test", mkdtempSync(join(tmpdir(), "readiness-bare-")));
    withRest(gh, { prRule: false });
    const report = readiness(ctx);
    expect(report.readyFor).toBe(1); // board + auth work day one
    const names = (lvl: number, status: string) =>
      report.checks.filter((c) => c.level === lvl && c.status === status).map((c) => c.name);
    expect(names(2, "miss")).toEqual(["agent-docs", "tests", "ci", "pr-required"]);
    expect(names(3, "miss")).toEqual(["merge-gate", "state-guard"]);
    // every miss carries a recommendation — the report IS the guide
    for (const c of report.checks.filter((c) => c.status === "miss")) {
      expect(c.recommend, `${c.name} must recommend`).toBeTruthy();
    }
    // machine-local loop state is informational, never a gap
    expect(report.checks.find((c) => c.name === "loop")?.status).toBe("info");
  });

  it("missing advisory fields never hold Level 1 hostage — info with a recommendation", () => {
    const gh = new FakeGh();
    gh.omitFields = ["Estimate", "Priority"];
    const ctx = makeCtx(gh, "me@test", mkdtempSync(join(tmpdir(), "readiness-advisory-")));
    withRest(gh, { prRule: false });
    const report = readiness(ctx);
    const check = report.checks.find((c) => c.name === "advisory-fields");
    expect(check?.status).toBe("info"); // doctor agrees: warn, never fail
    expect(check?.recommend).toBe("board setup");
    expect(report.readyFor).toBe(1); // State + Claim are the only Level-1 field needs
  });

  it("levels unlock cumulatively as the repo grows the conventions", () => {
    const gh = new FakeGh();
    const root = mkdtempSync(join(tmpdir(), "readiness-full-"));
    writeFileSync(join(root, "AGENTS.md"), "# agents\n");
    writeFileSync(join(root, "vitest.config.ts"), "export default {}\n");
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });
    writeFileSync(join(root, ".github", "workflows", "ci.yml"), "on: push\n");
    const ctx = makeCtx(gh, "me@test", root);
    withRest(gh, { prRule: true });
    const level2 = readiness(ctx);
    expect(level2.checks.find((c) => c.name === "pr-required")?.status).toBe("ok"); // verified, not info
    expect(level2.readyFor).toBe(2);

    // add the level-3 conventions
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(join(root, "scripts", "merge-pr.sh"), "#!/bin/bash\n");
    writeFileSync(join(root, ".github", "workflows", "state-guard.yml"), "on: issues\n");
    expect(readiness(ctx).readyFor).toBe(3);
  });

  it("an unverifiable PR rule reads as info, not as a gap", () => {
    const gh = new FakeGh(); // no REST overlay → repo API "unavailable"
    const root = mkdtempSync(join(tmpdir(), "readiness-noapi-"));
    writeFileSync(join(root, "CLAUDE.md"), "# repo\n");
    writeFileSync(join(root, "vitest.config.ts"), "export default {}\n");
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });
    writeFileSync(join(root, ".github", "workflows", "ci.yml"), "on: push\n");
    const ctx = makeCtx(gh, "me@test", root);
    const report = readiness(ctx);
    expect(report.checks.find((c) => c.name === "pr-required")?.status).toBe("info");
    expect(report.readyFor).toBe(2);
  });
});
