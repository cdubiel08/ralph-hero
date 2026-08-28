/**
 * board.roster.test.ts — the derived topology view + phone book (GH-2211).
 *
 * The subjects are `board roster` (a JOIN over `herdr agent list`, workspace
 * labels, C8 tokens and the local lease records — nothing written) and the
 * `who lead` / `who dispatch` phone book. The distinctions defended here:
 *
 *  - "not evaluated" NEVER renders as "nobody live" — herdr missing, herdr
 *    refusing, and herdr answering garbage are three different facts, and an
 *    empty fleet is a fourth (the GH-1929 null-probe direction).
 *  - the token-covered path costs ZERO GraphQL (a cockpit polls this verb);
 *    the derived-address fallback is bounded, per-row isolated, and its
 *    budget refusal is a different fact from "unattributable".
 *  - the default scope withholds nothing silently: foreign and unattributable
 *    rows are counted and named, `--all` shows everything (the brief/who
 *    split of GH-2108, extended).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  UsageError,
  readHerdAgents,
  rosterView,
  run,
  type Ctx,
  type RosterView,
} from "./board.js";
import { FakeGh, makeCtx, ok, refusalMessage } from "./board.testkit.js";

const NOW = new Date("2026-08-22T12:00:00Z");

let root: string;
let sessions: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "roster-"));
  sessions = join(root, "sessions");
  mkdirSync(sessions, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

// --- fixtures ---------------------------------------------------------------

interface FakeAgent {
  name?: string;
  agent_status?: string;
  cwd?: string;
  pane_id?: string;
  workspace_id?: string;
  tokens?: Record<string, string>;
}

/** Overlay herdr onto the fake exec — the default FakeGh answers exit 1
 *  ("unexpected") for anything it does not know, which models herdr-missing. */
function serveHerdr(
  gh: FakeGh,
  agents: FakeAgent[] | { raw: string } | { code: number; stderr: string },
  workspaces?: Array<{ workspace_id: string; label?: string; repo_name?: string }> | { code: number; stderr: string },
) {
  const inner = gh.exec.bind(gh);
  gh.exec = (argv, stdin) => {
    const cmd = argv.join(" ");
    if (cmd === "herdr agent list") {
      if ("code" in (agents as object)) {
        const a = agents as { code: number; stderr: string };
        return { code: a.code, stdout: "", stderr: a.stderr };
      }
      if ("raw" in (agents as object)) return ok((agents as { raw: string }).raw);
      return ok(JSON.stringify({ result: { type: "agent_list", agents } }));
    }
    if (cmd === "herdr workspace list") {
      if (workspaces === undefined) return ok(JSON.stringify({ result: { workspaces: [] } }));
      if ("code" in (workspaces as object)) {
        const w = workspaces as { code: number; stderr: string };
        return { code: w.code, stdout: "", stderr: w.stderr };
      }
      const list = (workspaces as Array<{ workspace_id: string; label?: string; repo_name?: string }>).map((w) => ({
        workspace_id: w.workspace_id,
        label: w.label,
        worktree: w.repo_name !== undefined ? { repo_name: w.repo_name } : undefined,
      }));
      return ok(JSON.stringify({ result: { workspaces: list } }));
    }
    return inner(argv, stdin);
  };
}

let seq = 0;
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

function ctxFor(gh: FakeGh, withSessions = true): Ctx {
  return makeCtx(gh, "me@test", root, {
    now: () => NOW,
    session: withSessions ? { id: "mine", dir: sessions } : undefined,
  });
}

function say(argv: string[], ctx: Ctx): { code: number; out: string } {
  const said: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((s) => {
    said.push(String(s));
    return true;
  });
  try {
    return { code: run(argv, ctx), out: said.join("") };
  } finally {
    spy.mockRestore();
  }
}

const view = (ctx: Ctx, all = false, deriveMax = 10): RosterView => rosterView(ctx, { all, deriveMax });

// --- not-evaluated vs empty -------------------------------------------------

describe("roster: unreadable inputs degrade to 'not evaluated', never to an empty roster", () => {
  it("herdr missing (exec refuses) → agents not evaluated WITH reason; leases still render", () => {
    const gh = new FakeGh(); // default: unknown argv → exit 1
    writeLock(7, join(root, "gone")); // checkout missing → DEAD orphan
    const ctx = ctxFor(gh);
    const v = view(ctx);
    expect(v.agentsEvaluated).toBe(false);
    expect(v.agentsReason).toBeTruthy();
    expect(v.rows).toEqual([]);
    expect(v.orphanLeases).not.toBeNull(); // the leases half answered
    const r = say(["roster"], ctx);
    expect(r.code).toBe(0);
    expect(r.out).toContain("live agents: not evaluated");
    // The dispatch space's DURABLE address is board-derived (D5.1) and still
    // prints; only its liveness is unknown.
    expect(r.out).toContain("dispatch  ralph-hero/dispatch — liveness not evaluated");
  });

  it("herdr answering garbage is 'not evaluated', not an empty fleet", () => {
    const gh = new FakeGh();
    serveHerdr(gh, { raw: "not json" });
    const v = view(ctxFor(gh));
    expect(v.agentsEvaluated).toBe(false);
    expect(v.agentsReason).toContain("unparseable");
  });

  it("a herdr REFUSAL (exit 1 with stderr) carries the refusal text, not 'unreachable'", () => {
    const gh = new FakeGh();
    serveHerdr(gh, { code: 1, stderr: "scope denied: agent list" });
    const v = view(ctxFor(gh));
    expect(v.agentsEvaluated).toBe(false);
    expect(v.agentsReason).toContain("scope denied");
  });

  it("an EMPTY fleet is a real answer — evaluated, no rows, no 'not evaluated' line", () => {
    const gh = new FakeGh();
    serveHerdr(gh, []);
    const ctx = ctxFor(gh);
    expect(view(ctx).agentsEvaluated).toBe(true);
    expect(say(["roster"], ctx).out).not.toContain("not evaluated");
  });

  it("no sessions dir → leases not evaluated; the orphan section is suppressed, not rendered empty", () => {
    const gh = new FakeGh();
    serveHerdr(gh, []);
    const ctx = ctxFor(gh, false);
    const v = view(ctx);
    expect(v.leasesEvaluated).toBe(false);
    expect(v.orphanLeases).toBeNull();
    const r = say(["roster"], ctx);
    expect(r.out).toContain("leases: not evaluated");
    expect(r.out).not.toContain("leases without a live pane");
  });
});

// --- the token-covered path -------------------------------------------------

describe("roster: token-stamped agents — zero GraphQL, grouped by the grammar", () => {
  const tokenFleet: FakeAgent[] = [
    {
      name: "o100-herd-epic",
      agent_status: "working",
      cwd: "/x/lead",
      pane_id: "w1:p1",
      workspace_id: "w1",
      tokens: { address: "ralph-hero/t100-herd-epic/o100-herd-epic", role: "orchestrator", depth: "0" },
    },
    {
      name: "w102-leaf-unit",
      agent_status: "working",
      cwd: "/x/worker",
      pane_id: "w1:p2",
      workspace_id: "w1",
      tokens: {
        address: "ralph-hero/t100-herd-epic/w102-leaf-unit",
        depth: "1",
        parent: "o100-herd-epic#abcd1234",
      },
    },
    {
      name: "hero",
      agent_status: "idle",
      cwd: "/x/hero",
      pane_id: "w1:p3",
      workspace_id: "w1",
      tokens: { address: "ralph-hero/dispatch" },
    },
    {
      name: "w7-other-repo",
      agent_status: "idle",
      cwd: "/y",
      pane_id: "w2:p1",
      workspace_id: "w2",
      tokens: { address: "landcrawler-ai/w7-other-repo" },
    },
  ];

  it("groups team members under their segment, lead first; dispatch binds the durable line; foreign is COUNTED", () => {
    const gh = new FakeGh();
    serveHerdr(gh, tokenFleet);
    const ctx = ctxFor(gh);
    const r = say(["roster"], ctx);
    expect(r.out).toContain("t100-herd-epic/");
    const leadAt = r.out.indexOf("o100-herd-epic");
    const workerAt = r.out.indexOf("w102-leaf-unit");
    expect(leadAt).toBeGreaterThan(-1);
    expect(workerAt).toBeGreaterThan(leadAt);
    // C8 readers: depth and parent render from the tokens, verbatim.
    expect(r.out).toContain("depth 1");
    expect(r.out).toContain("parent o100-herd-epic#abcd1234");
    // dispatch: live binding on the durable address line.
    expect(r.out).toContain("dispatch  ralph-hero/dispatch");
    expect(r.out).not.toContain("no live binding");
    // foreign withheld by count, not silence.
    expect(r.out).toContain("1 agent(s) in other repos");
    expect(r.out).not.toContain("w7-other-repo  ");
    // The whole read cost NOTHING on the board budget (a cockpit polls this).
    expect(gh.graphqlCalls).toBe(0);
    expect(gh.mutations).toEqual([]);
  });

  it("--all shows the foreign repo section and withholds nothing", () => {
    const gh = new FakeGh();
    serveHerdr(gh, tokenFleet);
    const r = say(["roster", "--all"], ctx4(gh));
    expect(r.out).toContain("landcrawler-ai");
    expect(r.out).toContain("w7-other-repo");
    expect(r.out).not.toContain("withheld:");
  });
  const ctx4 = (gh: FakeGh) => ctxFor(gh);

  it("absent C8 tokens render as '—', never fabricated", () => {
    const gh = new FakeGh();
    serveHerdr(gh, [
      { name: "w5-bare", agent_status: "idle", pane_id: "w1:p1", workspace_id: "w1", tokens: { address: "ralph-hero/w5-bare" } },
    ]);
    const r = say(["roster"], ctxFor(gh));
    expect(r.out).toContain("depth —");
    expect(r.out).not.toContain("depth 0");
  });
});

// --- derived-address fallback -----------------------------------------------

describe("roster: derived-address fallback for token-less agents (installed cockpits lag the release)", () => {
  function chainIssues(gh: FakeGh) {
    gh.issues.set(100, {
      number: 100,
      state: "In Progress",
      title: "Herd epic",
      children: [{ number: 102, state: "Backlog", issueState: "OPEN" }],
    });
    gh.issues.set(102, { number: 102, state: "In Progress", title: "Leaf unit", parent: 100 });
  }

  it("an own-repo grammar-B name gets the SAME address the grammar derives, marked derived", () => {
    const gh = new FakeGh();
    chainIssues(gh);
    serveHerdr(
      gh,
      [{ name: "w102-leaf-unit", agent_status: "working", cwd: "/x", pane_id: "w1:p1", workspace_id: "w1", tokens: {} }],
      [{ workspace_id: "w1", repo_name: "ralph-hero" }],
    );
    const v = view(ctxFor(gh));
    expect(v.rows).toHaveLength(1);
    expect(v.rows[0]).toMatchObject({
      address: "ralph-hero/t100-herd-epic/w102-leaf-unit",
      addressSource: "derived",
      team: "t100-herd-epic",
      teamEpic: 100,
      issue: 102,
    });
  });

  it("the budget bounds the walk; a past-budget row says BUDGET, which is not 'unattributable'", () => {
    const gh = new FakeGh();
    chainIssues(gh);
    gh.issues.set(103, { number: 103, state: "In Progress", title: "Second unit" });
    serveHerdr(
      gh,
      [
        { name: "w102-leaf-unit", cwd: "/x", workspace_id: "w1", tokens: {} },
        { name: "w103-second-unit", cwd: "/y", workspace_id: "w1", tokens: {} },
      ],
      [{ workspace_id: "w1", repo_name: "ralph-hero" }],
    );
    const v = view(ctxFor(gh), false, 1);
    const past = v.rows.find((r) => r.name === "w103-second-unit")!;
    expect(past.address).toBeNull();
    expect(past.note).toContain("budget");
    expect(past.repo).toBe("ralph-hero"); // attributed — a different fact
    expect(v.withheld.unattributedAgents).toBe(0);
  });

  it("one failed walk degrades its ROW, never the roster", () => {
    const gh = new FakeGh();
    // 999 does not exist — fetchIssue throws.
    serveHerdr(
      gh,
      [
        { name: "w999-ghost", cwd: "/x", workspace_id: "w1", tokens: {} },
        { name: "w5-flat", cwd: "/y", workspace_id: "w1", tokens: { address: "ralph-hero/w5-flat" } },
      ],
      [{ workspace_id: "w1", repo_name: "ralph-hero" }],
    );
    const ctx = ctxFor(gh);
    const v = view(ctx);
    expect(v.rows).toHaveLength(2);
    const ghost = v.rows.find((r) => r.name === "w999-ghost")!;
    expect(ghost.note).toContain("not derived");
    expect(say(["roster"], ctx).code).toBe(0);
  });

  it("workspace list unreadable → token-less rows are unattributable WITH the reason, never assumed into this repo", () => {
    const gh = new FakeGh();
    serveHerdr(gh, [{ name: "w102-leaf-unit", cwd: "/x", workspace_id: "w1", tokens: {} }], {
      code: 1,
      stderr: "workspace scope denied",
    });
    const v = view(ctxFor(gh));
    expect(v.workspacesEvaluated).toBe(false);
    expect(v.rows).toEqual([]); // withheld from the repo view…
    expect(v.withheld.unattributedAgents).toBe(1); // …but counted.
    const all = view(ctxFor(gh), true);
    expect(all.rows[0].note).toContain("workspace list not evaluated");
    expect(gh.graphqlCalls).toBe(0); // no walk on an unattributed row
  });

  it("a gen-suffixed respawn (w102-leaf-unit--2) derives the BASE logical address — spawn_epoch tells incarnations apart (D7.1)", () => {
    const gh = new FakeGh();
    chainIssues(gh);
    serveHerdr(
      gh,
      [{ name: "w102-leaf-unit--2", cwd: "/x", workspace_id: "w1", tokens: {} }],
      [{ workspace_id: "w1", repo_name: "ralph-hero" }],
    );
    const v = view(ctxFor(gh));
    expect(v.rows[0]).toMatchObject({
      issue: 102,
      address: "ralph-hero/t100-herd-epic/w102-leaf-unit",
      addressSource: "derived",
    });
  });

  it("an own-repo row no grammar can address says WHY its address is null", () => {
    const gh = new FakeGh();
    serveHerdr(
      gh,
      [
        { name: "gh-77", cwd: "/x", workspace_id: "w1", tokens: {} },
        { cwd: "/y", workspace_id: "w1", tokens: {} },
      ],
      [{ workspace_id: "w1", repo_name: "ralph-hero" }],
    );
    const v = view(ctxFor(gh));
    expect(v.rows.find((r) => r.name === "gh-77")!.note).toContain("legacy session name");
    expect(v.rows.find((r) => r.name === null)!.note).toContain("not grammar B");
    expect(gh.graphqlCalls).toBe(0);
  });

  it("a lease joined to a row the repo view WITHHOLDS returns to the orphan pool — the workspace-outage case may not eat it", () => {
    const wt = join(root, "wt-x");
    mkdirSync(wt, { recursive: true });
    writeLock(102, wt);
    const gh = new FakeGh();
    // Workspace list fails → the pane is unattributable and withheld from the
    // default view; its lease must surface as an orphan, not vanish.
    serveHerdr(gh, [{ name: "w102-leaf-unit", cwd: wt, workspace_id: "w1", tokens: {} }], {
      code: 1,
      stderr: "workspace scope denied",
    });
    const v = view(ctxFor(gh));
    expect(v.rows).toEqual([]);
    expect(v.orphanLeases!.map((l) => l.issue)).toEqual([102]);
    // Under --all the row is shown and the lease rides it again.
    const all = view(ctxFor(gh), true);
    expect(all.rows[0].lease).not.toBeNull();
    expect(all.orphanLeases).toEqual([]);
  });

  it("a foreign-repo token-less agent is never derived against OUR board (same number, different repo's issue)", () => {
    const gh = new FakeGh();
    chainIssues(gh);
    serveHerdr(
      gh,
      [{ name: "w102-leaf-unit", cwd: "/x", workspace_id: "w2", tokens: {} }],
      [{ workspace_id: "w2", repo_name: "landcrawler-ai" }],
    );
    const v = view(ctxFor(gh), true);
    expect(v.rows[0].repo).toBe("landcrawler-ai");
    expect(v.rows[0].address).toBeNull();
    expect(gh.graphqlCalls).toBe(0);
  });
});

// --- lease join --------------------------------------------------------------

describe("roster: the lease join (issue + checkout, realpath both sides)", () => {
  it("a lease for the agent's unit in the agent's checkout rides its row; an unmatched lease is an orphan", () => {
    const wt = join(root, "wt-a");
    mkdirSync(wt, { recursive: true });
    writeLock(102, wt);
    writeLock(55, join(root, "wt-b")); // nobody's pane
    mkdirSync(join(root, "wt-b"), { recursive: true });
    const gh = new FakeGh();
    serveHerdr(gh, [
      { name: "w102-leaf-unit", cwd: wt, workspace_id: "w1", tokens: { address: "ralph-hero/w102-leaf-unit" } },
    ]);
    const v = view(ctxFor(gh));
    expect(v.rows[0].lease).not.toBeNull();
    expect(v.orphanLeases!.map((l) => l.issue)).toEqual([55]);
  });

  it("a symlinked spelling of the same checkout still joins — a raw compare would false-orphan a live driver", () => {
    const real = join(root, "real-wt");
    mkdirSync(real, { recursive: true });
    const link = join(root, "link-wt");
    symlinkSync(real, link);
    writeLock(102, link); // lock stored the symlinked spelling at claim time
    const gh = new FakeGh();
    serveHerdr(gh, [
      { name: "w102-leaf-unit", cwd: real, workspace_id: "w1", tokens: { address: "ralph-hero/w102-leaf-unit" } },
    ]);
    const v = view(ctxFor(gh));
    expect(v.rows[0].lease).not.toBeNull();
    expect(v.orphanLeases).toEqual([]);
  });

  it("a DEAD orphan lease is counted in the default view and shown under --all (GH-2108: dead, never stale)", () => {
    writeLock(7, join(root, "gone"));
    const gh = new FakeGh();
    serveHerdr(gh, []);
    const v = view(ctxFor(gh));
    expect(v.orphanLeases).toEqual([]);
    expect(v.withheld.deadLeases).toBe(1);
    const all = view(ctxFor(gh), true);
    expect(all.orphanLeases!).toHaveLength(1);
    expect(say(["roster", "--all"], ctxFor(gh)).out).toContain("DEAD");
  });
});

// --- phone book ---------------------------------------------------------------

describe("who lead / who dispatch: the phone book (GH-2211)", () => {
  it("an unknown `who` subword REFUSES — an older plugin falls through to the lease dump, and that silent success is the hazard", () => {
    expect(() => run(["who", "bogus"], ctxFor(new FakeGh()))).toThrow(UsageError);
  });

  it("who dispatch: the durable address ALWAYS prints (it names the board, D5.1); a token-less hero is called invisible, not absent", () => {
    const gh = new FakeGh();
    serveHerdr(gh, [{ name: "ralph-hero-orc", agent_status: "idle", pane_id: "w1:p1", workspace_id: "w1", tokens: {} }]);
    const r = say(["who", "dispatch"], ctxFor(gh));
    expect(r.out).toContain("address  ralph-hero/dispatch");
    expect(r.out).toContain("token-less hero is invisible");
  });

  it("who dispatch: a token-stamped hero pane is the live binding", () => {
    const gh = new FakeGh();
    serveHerdr(gh, [
      { name: "hero", agent_status: "working", pane_id: "w1:p9", workspace_id: "w1", tokens: { address: "ralph-hero/dispatch" } },
    ]);
    const r = say(["who", "dispatch"], ctxFor(gh));
    expect(r.out).toContain("live     hero");
    expect(r.out).toContain("pane w1:p9");
  });

  it("who dispatch with herdr missing: address still prints, liveness reads not evaluated", () => {
    const r = say(["who", "dispatch"], ctxFor(new FakeGh()));
    expect(r.out).toContain("address  ralph-hero/dispatch");
    expect(r.out).toContain("live     not evaluated");
  });

  it("who lead NNN: a CHILD resolves to its epic root's lead; liveness matches token first, grammar-B name as corroboration", () => {
    const gh = new FakeGh();
    gh.issues.set(100, {
      number: 100,
      state: "In Progress",
      title: "Herd epic",
      children: [{ number: 102, state: "Backlog", issueState: "OPEN" }],
    });
    gh.issues.set(102, { number: 102, state: "In Progress", title: "Leaf unit", parent: 100 });
    serveHerdr(
      gh,
      [{ name: "o100-herd-epic", agent_status: "working", pane_id: "w1:p1", workspace_id: "w1", tokens: {} }],
      [{ workspace_id: "w1", repo_name: "ralph-hero" }],
    );
    const r = say(["who", "lead", "102", "--json"], ctxFor(gh));
    const parsed = JSON.parse(r.out);
    expect(parsed).toMatchObject({
      epic: 100,
      team: "t100-herd-epic",
      address: "ralph-hero/t100-herd-epic/o100-herd-epic",
    });
    expect(parsed.live).toHaveLength(1);
    expect(parsed.live[0]).toMatchObject({ name: "o100-herd-epic", source: "name", repoVerified: true });
  });

  it("who lead NNN: a name-matched pane in a workspace that resolved to a DIFFERENT repo is excluded", () => {
    const gh = new FakeGh();
    gh.issues.set(100, {
      number: 100,
      state: "In Progress",
      title: "Herd epic",
      children: [{ number: 102, state: "Backlog", issueState: "OPEN" }],
    });
    serveHerdr(
      gh,
      [{ name: "o100-herd-epic", pane_id: "w1:p1", workspace_id: "w1", tokens: {} }],
      [{ workspace_id: "w1", repo_name: "landcrawler-ai" }],
    );
    const parsed = JSON.parse(say(["who", "lead", "100", "--json"], ctxFor(gh)).out);
    expect(parsed.live).toEqual([]);
  });

  it("who lead NNN on a flat unit refuses and names the remedy", () => {
    const gh = new FakeGh();
    gh.issues.set(50, { number: 50, state: "Backlog", title: "Flat unit" });
    const msg = refusalMessage(() => run(["who", "lead", "50"], ctxFor(gh)));
    expect(msg).toContain("no team");
    expect(msg).toContain("board name 50");
  });

  it("who lead (no arg): live lane-o panes for this repo; none is said honestly, not silently", () => {
    const gh = new FakeGh();
    serveHerdr(gh, [
      { name: "o100-herd-epic", agent_status: "working", pane_id: "w1:p1", workspace_id: "w1", tokens: { address: "ralph-hero/t100-herd-epic/o100-herd-epic" } },
      { name: "o7-foreign", agent_status: "idle", pane_id: "w2:p1", workspace_id: "w2", tokens: { address: "landcrawler-ai/o7-foreign" } },
    ]);
    const parsed = JSON.parse(say(["who", "lead", "--json"], ctxFor(gh)).out);
    expect(parsed.leads).toHaveLength(1);
    expect(parsed.leads[0]).toMatchObject({ epic: 100, team: "t100-herd-epic", source: "token" });

    const none = say(["who", "lead"], (() => {
      const g2 = new FakeGh();
      serveHerdr(g2, []);
      return ctxFor(g2);
    })());
    expect(none.out).toContain("no live leads");
  });
});

// --- json surface -------------------------------------------------------------

describe("roster --json: the cockpit-facing shape (unit K reads this)", () => {
  it("carries the D7.3 statement and every evaluated flag", () => {
    const gh = new FakeGh();
    serveHerdr(gh, []);
    const parsed = JSON.parse(say(["roster", "--json"], ctxFor(gh)).out);
    expect(parsed).toMatchObject({
      repo: "ralph-hero",
      all: false,
      boardClaims: "not-read",
      agentsEvaluated: true,
      leasesEvaluated: true,
      rows: [],
      withheld: { foreignAgents: 0, unattributedAgents: 0, foreignLeases: 0, deadLeases: 0 },
    });
  });
});

// --- reader unit coverage ------------------------------------------------------

describe("readHerdAgents: defensive over the envelope", () => {
  it("tolerates rows with missing fields and non-string token values", () => {
    const gh = new FakeGh();
    serveHerdr(gh, { raw: JSON.stringify({ result: { agents: [{ tokens: { depth: 3 } }, null, "x"] } }) });
    const { agents } = readHerdAgents(ctxFor(gh));
    expect(agents).toHaveLength(1);
    expect(agents![0].tokens).toEqual({});
  });
});
