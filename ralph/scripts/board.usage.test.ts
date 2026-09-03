/**
 * board.usage.test.ts — the herdr ledger's usage facts read from the board
 * side (GH-2347): `board brief`'s $/unit lines and doctor's `unit-cost`
 * advisory, over the same opener `board events` uses.
 *
 * The distinctions defended: an ABSENT tape is not evaluated (brief) / ok
 * (doctor), never "$0"; an unreadable one is `not evaluated`, never ok; the
 * latest usage fact per ref wins (each is the whole transcript, not a delta);
 * closed units are the population and never findings; the ctx line fires
 * alone at any sample size while the p90 line waits for ten; and the info
 * level never moves the exit code, --strict or not.
 *
 * Real sqlite databases throughout, via the sqlite3 CLI — the reader shells
 * out to that binary, so a fake would let the code agree with itself.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  doctor,
  parseSmellThresholds,
  readLedgerUsage,
  realExec,
  reduceLeadRespawns,
  reduceLedgerUsage,
  run,
  UsageError,
  type Ctx,
} from "./board.js";
import { FakeGh, makeCtx } from "./board.testkit.js";

let root: string;
let saved: Record<string, string | undefined> = {};

/** sqlite3 runs for real; everything else (gh, git) stays on the fake — brief
 *  and doctor walk the board, and a real gh here would be a network call. */
function ctx(gh: FakeGh = new FakeGh()): Ctx {
  const base = makeCtx(gh);
  return { ...base, exec: (argv, stdin) => (argv[0] === "sqlite3" ? realExec(argv, stdin) : base.exec(argv, stdin)) };
}

function dbPath(): string {
  const dir = join(root, "cdubiel08", "ralph-hero");
  mkdirSync(dir, { recursive: true });
  return join(dir, "ledger.sqlite");
}

function buildDb(payloads: string[], userVersion = 1): void {
  const inserts = payloads
    .map((p, i) => `INSERT INTO facts(seq, payload) VALUES(${i + 1}, '${p.replaceAll("'", "''")}');`)
    .join("\n");
  const r = realExec(
    ["sqlite3", dbPath()],
    `PRAGMA user_version=${userVersion};\nCREATE TABLE facts(seq INTEGER PRIMARY KEY, payload TEXT NOT NULL);\n${inserts}\n`,
  );
  expect(r.code).toBe(0);
}

const spawn = (ref: string, issue: number) =>
  JSON.stringify({ ts: "2026-09-01T00:00:00Z", ev: "spawn", agent_ref: ref, lineage: { issue }, tokens: { issue: String(issue) } });
const exit = (ref: string) => JSON.stringify({ ts: "2026-09-01T01:00:00Z", ev: "exit", agent_ref: ref, reason: "pane-closed" });
const usage = (ref: string, listUsd: number, maxContext: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    ts: "2026-09-01T00:30:00Z",
    ev: "usage",
    agent_ref: ref,
    via: "event",
    price_table: "2026-09-01",
    usage: { model: "claude-sonnet-5", calls: 12, list_usd: listUsd, max_context: maxContext, unpriced_calls: 0, ...extra },
  });

function capture() {
  const lines: string[] = [];
  const outSpy = vi.spyOn(process.stdout, "write").mockImplementation((s) => {
    lines.push(String(s));
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  return { lines, text: () => lines.join(""), restore: () => (outSpy.mockRestore(), errSpy.mockRestore()) };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "board-usage-"));
  saved = {
    RALPH_HERDR_LEDGER_ROOT: process.env.RALPH_HERDR_LEDGER_ROOT,
    RALPH_SQLITE3_BIN: process.env.RALPH_SQLITE3_BIN,
    RALPH_HERDR_LEDGER: process.env.RALPH_HERDR_LEDGER,
  };
  process.env.RALPH_HERDR_LEDGER_ROOT = root;
  delete process.env.RALPH_SQLITE3_BIN;
  delete process.env.RALPH_HERDR_LEDGER;
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

describe("reduceLedgerUsage — latest fact per ref, joined to issue and open state", () => {
  it("latest wins, never summed; issue comes from the spawn; exit closes", () => {
    const units = reduceLedgerUsage([
      spawn("w1-a#aaaa", 1),
      usage("w1-a#aaaa", 1.5, 50_000),
      usage("w1-a#aaaa", 4.25, 120_000),
      spawn("w2-b#bbbb", 2),
      usage("w2-b#bbbb", 0.5, 30_000),
      exit("w2-b#bbbb"),
      "not json at all",
    ]);
    expect(units).toEqual([
      expect.objectContaining({ ref: "w1-a#aaaa", issue: 1, open: true, listUsd: 4.25, maxContext: 120_000, calls: 12 }),
      expect.objectContaining({ ref: "w2-b#bbbb", issue: 2, open: false, listUsd: 0.5 }),
    ]);
  });

  it("a usage fact for a ref nobody spawned still surfaces — issue null, closed", () => {
    const [u] = reduceLedgerUsage([usage("w9-ghost#ffff", 2, 10_000)]);
    expect(u.issue).toBeNull();
    expect(u.open).toBe(false);
  });
});

describe("readLedgerUsage — the three states of the tape", () => {
  it("absent is absent, not an empty list", () => {
    expect(readLedgerUsage(ctx())).toEqual({ kind: "absent" });
  });
  it("a present tape is read through sqlite3", () => {
    buildDb([spawn("w1-a#aaaa", 1), usage("w1-a#aaaa", 3, 90_000)]);
    const r = readLedgerUsage(ctx());
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.units[0]).toMatchObject({ issue: 1, listUsd: 3, open: true });
  });
  it("a future schema is an error, never a guess", () => {
    buildDb([usage("w1-a#aaaa", 3, 90_000)], 2);
    const r = readLedgerUsage(ctx());
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.msg).toContain("user_version=2");
  });
  it("an unreadable file is an error — 'could not read' must not render as 'no usage'", () => {
    writeFileSync(dbPath(), "not a database");
    expect(readLedgerUsage(ctx()).kind).toBe("error");
  });
});

describe("board brief — $/unit for live units", () => {
  it("no ledger: not evaluated, and --json carries usage: null", () => {
    const c = capture();
    try {
      expect(run(["brief"], ctx())).toBe(0);
      expect(c.text()).toContain("cost: not evaluated (no herdr ledger");
      c.lines.length = 0;
      expect(run(["brief", "--json"], ctx())).toBe(0);
      expect(JSON.parse(c.text()).usage).toBeNull();
    } finally {
      c.restore();
    }
  });

  it("live units print their latest fact, sorted by cost; closed units are withheld", () => {
    buildDb([
      spawn("w2347-usage#u001", 2347),
      usage("w2347-usage#u001", 1.0, 100_000),
      usage("w2347-usage#u001", 8.0, 274_076),
      spawn("w2311-big#u002", 2311),
      usage("w2311-big#u002", 44.1, 444_000),
      exit("w2311-big#u002"),
      spawn("w10-small#u003", 10),
      usage("w10-small#u003", 0.42, 60_000, { unpriced_calls: 2 }),
    ]);
    const c = capture();
    try {
      expect(run(["brief"], ctx())).toBe(0);
      const t = c.text();
      expect(t).toContain("cost: 2 live units, $8.42 list-equivalent");
      expect(t).toContain("cost: #2347 $8.00 sonnet-5 274k ctx 12 calls (w2347-usage#u001)");
      expect(t).toContain("cost: #10 $0.42 sonnet-5 60k ctx 12 calls (2 unpriced)");
      expect(t).not.toContain("#2311");
      expect(t.indexOf("#2347")).toBeLessThan(t.indexOf("#10 "));
      c.lines.length = 0;
      expect(run(["brief", "--json"], ctx())).toBe(0);
      const j = JSON.parse(c.text());
      expect(j.usage.map((u: { issue: number }) => u.issue)).toEqual([2347, 10]);
    } finally {
      c.restore();
    }
  });

  it("a ledger with no usage facts says so — distinct from no ledger", () => {
    buildDb([spawn("w1-a#aaaa", 1)]);
    const c = capture();
    try {
      expect(run(["brief"], ctx())).toBe(0);
      expect(c.text()).toContain("cost: no usage fact for any live unit yet");
    } finally {
      c.restore();
    }
  });
});

describe("doctor: unit-cost (GH-2347) — advisory by construction", () => {
  const check = (r: ReturnType<typeof doctor>) => r.checks.find((c) => c.name === "unit-cost")!;

  it("no ledger is ok, quietly", () => {
    const c = check(doctor(ctx()));
    expect(c.level).toBe("ok");
    expect(c.detail).toContain("no herdr ledger");
  });

  it("an unreadable ledger is not evaluated — never ok", () => {
    writeFileSync(dbPath(), "not a database");
    const c = check(doctor(ctx()));
    expect(c.level).toBe("info");
    expect(c.detail).toContain("not evaluated");
  });

  it("a live unit past RALPH_UNIT_CTX_MAX is named at any sample size, with the Estimate remedy", () => {
    buildDb([spawn("w2347-usage#u001", 2347), usage("w2347-usage#u001", 8.0, 274_076)]);
    const cx = ctx();
    const strictBaseline = doctor(cx, { strict: true }).ok;
    const r = doctor(cx, { strict: true });
    const c = check(r);
    expect(c.level).toBe("info");
    expect(c.detail).toContain("#2347 $8.00 sonnet-5 (274k ctx ≥200k)");
    expect(c.detail).toContain("board estimate NNN <size>");
    expect(c.detail).toContain("never a cap");
    expect(c.detail).toContain("p90 needs ≥10");
    expect(r.ok).toBe(strictBaseline); // info never touches the exit code
  });

  it("the ctx line honours RALPH_UNIT_CTX_MAX", () => {
    buildDb([spawn("w1-a#aaaa", 1), usage("w1-a#aaaa", 1.0, 150_000)]);
    const cx = ctx();
    expect(check(doctor(cx)).level).toBe("ok");
    cx.cfg.smells.unitCtxMax = 100_000;
    expect(check(doctor(cx)).level).toBe("info");
  });

  it("p90 fires only at ten measured units, only on LIVE ones, and closed units are the population", () => {
    const rows: string[] = [];
    // Eighteen closed units at $1..$18: the population. Nearest-rank p90 of
    // twenty is the 18th smallest ($18), so two units sit past it.
    for (let i = 1; i <= 18; i++) rows.push(spawn(`w${i}-old#c${i}`, i), usage(`w${i}-old#c${i}`, i, 50_000), exit(`w${i}-old#c${i}`));
    // A live unit at $40 — past the p90.
    rows.push(spawn("w100-hot#live", 100), usage("w100-hot#live", 40, 50_000));
    // A CLOSED unit at $50 is past it too, but finished work is never a
    // finding — nothing can re-estimate it.
    rows.push(spawn("w101-done#gone", 101), usage("w101-done#gone", 50, 50_000), exit("w101-done#gone"));
    buildDb(rows);
    const c = check(doctor(ctx()));
    expect(c.level).toBe("info");
    expect(c.detail).toContain("20 units measured");
    expect(c.detail).toContain("p90 $18.00");
    expect(c.detail).toContain("#100 $40.00 sonnet-5 ($40.00 > p90)");
    expect(c.detail).not.toContain("#101");
  });

  it("under ten samples a pricey live unit under the ctx line is ok — a p90 of three numbers is one of them", () => {
    buildDb([spawn("w1-a#aaaa", 1), usage("w1-a#aaaa", 99, 50_000), spawn("w2-b#bbbb", 2), usage("w2-b#bbbb", 1, 50_000)]);
    const c = check(doctor(ctx()));
    expect(c.level).toBe("ok");
    expect(c.detail).toContain("2 units measured");
  });
});

// ---------------------------------------------------------------------------
// lead-respawns (GH-2398) — the GH-2357 loop signature, read from the same
// tape: heal.sh (`invoked_by: scheduler`) standing a successor lead up for
// one epic N times inside an hour, joined with the epic's ready frontier
// only on a hit. The test clock is NOW = 2026-07-31T12:00:00Z (board.testkit).
// ---------------------------------------------------------------------------

/** A lead spawn record in the wire shape lib.sh's _ralph_spawn_record writes:
 *  the o-lane ref carries the epic, lineage.spawner.invoked_by carries who. */
const leadSpawn = (epic: number, ts: string, by: "scheduler" | "human" | "agent" = "scheduler", epoch = ts.replace(/\D/g, "")) =>
  JSON.stringify({
    ts,
    ev: "spawn",
    agent_ref: `o${epic}-some-epic#${epoch}`,
    lineage: { contract: "ralph.lineage", contract_version: 1, issue: epic, role: "lead", spawner: { script: "work-team.sh", invoked_by: by } },
    tokens: { role: "lead", issue: String(epic), spawn_epoch: epoch },
  });

describe("reduceLeadRespawns — scheduler-invoked o-lane spawns per epic, inside the window", () => {
  const now = new Date("2026-07-31T12:00:00Z");
  const hour = 3_600_000;

  it("counts only scheduler-invoked lead spawns inside [now-1h, now], grouped by the ref's own epic", () => {
    const rows = reduceLeadRespawns(
      [
        leadSpawn(1525, "2026-07-31T11:59:57Z"),
        leadSpawn(1525, "2026-07-31T11:59:54Z"),
        leadSpawn(1525, "2026-07-31T11:59:51Z"),
        leadSpawn(1525, "2026-07-31T10:59:00Z"), // an hour and a minute ago — outside
        leadSpawn(1525, "2026-07-31T12:00:01Z"), // after now — a clock skew is not a respawn
        leadSpawn(1525, "2026-07-31T11:30:00Z", "human"), // an operator's re-arm is not a respawn
        leadSpawn(1525, "2026-07-31T11:31:00Z", "agent"),
        leadSpawn(2000, "2026-07-31T11:45:00Z"),
        spawn("w1525-a-worker#w1", 1525), // a worker under the epic, wrong lane
        JSON.stringify({ ts: "2026-07-31T11:50:00Z", ev: "exit", agent_ref: "o1525-some-epic#x", reason: "pane-closed" }),
        JSON.stringify({ ts: "not a time", ev: "spawn", agent_ref: "o1525-some-epic#nt", lineage: { spawner: { invoked_by: "scheduler" } } }),
        "{not json",
      ],
      now,
      hour,
    );
    expect(rows).toEqual([
      { epic: 1525, spawns: 3, latest: "2026-07-31T11:59:57Z" },
      { epic: 2000, spawns: 1, latest: "2026-07-31T11:45:00Z" },
    ]);
  });

  it("an empty tape is an empty answer", () => {
    expect(reduceLeadRespawns([], now, hour)).toEqual([]);
  });
});

describe("RALPH_SMELL_LEAD_RESPAWNS — the threshold reader", () => {
  it("defaults to 3 and honours a positive override", () => {
    expect(parseSmellThresholds({}).leadRespawns).toBe(3);
    expect(parseSmellThresholds({ RALPH_SMELL_LEAD_RESPAWNS: "5" }).leadRespawns).toBe(5);
  });
});

describe("doctor: lead-respawns (GH-2398) — advisory by construction", () => {
  const check = (r: ReturnType<typeof doctor>) => r.checks.find((c) => c.name === "lead-respawns")!;
  // Three respawns at ~3 s apart — the cadence GH-2357 measured.
  const loop = (epic: number) => [
    leadSpawn(epic, "2026-07-31T11:59:51Z"),
    leadSpawn(epic, "2026-07-31T11:59:54Z"),
    leadSpawn(epic, "2026-07-31T11:59:57Z"),
  ];

  it("no ledger is ok, quietly", () => {
    const c = check(doctor(ctx()));
    expect(c.level).toBe("ok");
    expect(c.detail).toContain("no herdr ledger");
  });

  it("an unreadable ledger is not evaluated — never ok", () => {
    writeFileSync(dbPath(), "not a database");
    const c = check(doctor(ctx()));
    expect(c.level).toBe("info");
    expect(c.detail).toContain("not evaluated");
  });

  it("under the line is ok, and the count is still shown — a withheld reading is never silent", () => {
    buildDb([leadSpawn(1525, "2026-07-31T11:59:51Z"), leadSpawn(1525, "2026-07-31T11:59:54Z")]);
    const gh = new FakeGh();
    gh.issues.set(1525, { number: 1525, state: "Backlog", priority: "P1" });
    const cx = ctx(gh);
    // The frontier read is spent on a signature only: below the line, doctor
    // costs exactly what it costs with no respawn on the tape at all.
    const quiet = new FakeGh();
    quiet.issues.set(1525, { number: 1525, state: "Backlog", priority: "P1" });
    const c = check(doctor(cx));
    expect(c.level).toBe("ok");
    expect(c.detail).toContain("#1525×2");
    expect(c.detail).toContain("none at the RALPH_SMELL_LEAD_RESPAWNS line (3)");
    const withTape = gh.graphqlCalls;
    rmSync(dbPath());
    doctor(ctx(quiet));
    expect(withTape).toBe(quiet.graphqlCalls);
  });

  it("at the line with an EMPTY frontier under the epic names the GH-2357 signature and the stand-down remedy", () => {
    buildDb(loop(1525));
    const gh = new FakeGh();
    // The epic root alone on the board — every child closed and pruned, the
    // GH-2357 shape. The root itself ranks as a plain leaf, but the root is
    // never "under" itself: nothing staffable beneath the lead.
    gh.issues.set(1525, { number: 1525, state: "Backlog", priority: "P1" });
    const cx = ctx(gh);
    const strictBaseline = doctor(cx, { strict: true }).ok;
    const r = doctor(cx, { strict: true });
    const c = check(r);
    expect(c.level).toBe("info");
    expect(c.detail).toContain("#1525 respawned 3× (last 2026-07-31T11:59:57Z) with an EMPTY ready frontier under it");
    expect(c.detail).toContain("work-team.sh 1525 --stand-down");
    expect(c.detail).toContain("board frontier --epic 1525");
    expect(r.ok).toBe(strictBaseline); // info never touches the exit code
  });

  it("at the line with READY work under the epic is a different fact — NOT a stand-down case", () => {
    buildDb(loop(1525));
    const gh = new FakeGh();
    gh.issues.set(1525, { number: 1525, state: "Backlog", priority: "P1" });
    gh.issues.set(1526, { number: 1526, state: "Backlog", priority: "P2", parent: 1525 });
    const c = check(doctor(ctx(gh)));
    expect(c.level).toBe("info");
    expect(c.detail).toContain("#1525 respawned 3×");
    expect(c.detail).toContain("with 1 ready item(s) under it (#1526)");
    expect(c.detail).toContain("NOT a stand-down case");
    expect(c.detail).not.toContain("--stand-down`");
  });

  it("a ready GRANDCHILD counts as work under the epic — a superset of the fleet's direct-child filter", () => {
    buildDb(loop(1525));
    const gh = new FakeGh();
    gh.issues.set(1525, { number: 1525, state: "Backlog", priority: "P1" });
    gh.issues.set(1526, { number: 1526, state: "Backlog", priority: "P2", parent: 1525 }); // a phase with its own child
    gh.issues.set(1527, { number: 1527, state: "Backlog", priority: "P2", parent: 1526 });
    const c = check(doctor(ctx(gh)));
    expect(c.level).toBe("info");
    expect(c.detail).toContain("with 1 ready item(s) under it (#1527)");
  });

  it("a Done phase between the root and a live grandchild does not hide the grandchild", () => {
    buildDb(loop(1525));
    const gh = new FakeGh();
    gh.issues.set(1525, { number: 1525, state: "Backlog", priority: "P1" });
    gh.issues.set(1526, { number: 1526, state: "Done", issueState: "CLOSED", stateReason: "COMPLETED", parent: 1525 });
    gh.issues.set(1527, { number: 1527, state: "Backlog", priority: "P2", parent: 1526 });
    const c = check(doctor(ctx(gh)));
    expect(c.detail).toContain("with 1 ready item(s) under it (#1527)");
  });

  it("only the epic at the line is joined; a sibling epic under it is counted, not judged", () => {
    buildDb([...loop(1525), leadSpawn(2000, "2026-07-31T11:40:00Z")]);
    const gh = new FakeGh();
    gh.issues.set(1525, { number: 1525, state: "Backlog", priority: "P1" });
    gh.issues.set(2000, { number: 2000, state: "Backlog", priority: "P1" });
    const c = check(doctor(ctx(gh)));
    expect(c.level).toBe("info");
    expect(c.detail).toContain("scheduler lead respawns in the last hour: #1525×3 #2000×1");
    expect(c.detail).toContain("at/over 3: #1525 respawned 3×");
    expect(c.detail).not.toContain("#2000 respawned");
  });

  it("a root that has left the open topology is its own fact — never an empty frontier, never stand-down", () => {
    buildDb(loop(1525));
    const gh = new FakeGh();
    gh.issues.set(7, { number: 7, state: "Backlog", priority: "P0" }); // the board has work; #1525 is simply not on it
    const c = check(doctor(ctx(gh)));
    expect(c.level).toBe("info");
    expect(c.detail).toContain("#1525 respawned 3×");
    expect(c.detail).toContain("#1525 is not on this board's open topology");
    expect(c.detail).not.toContain("EMPTY");
    expect(c.detail).not.toContain("the GH-2357 loop signature");
  });

  it("a CLOSED root with a live grandchild is still on the topology — the pass-through edge counts", () => {
    buildDb(loop(1525));
    const gh = new FakeGh();
    gh.issues.set(1525, { number: 1525, state: "Done", issueState: "CLOSED", stateReason: "COMPLETED" });
    gh.issues.set(1526, { number: 1526, state: "Backlog", priority: "P2", parent: 1525 });
    const c = check(doctor(ctx(gh)));
    expect(c.detail).toContain("with 1 ready item(s) under it (#1526)");
    expect(c.detail).not.toContain("not on this board's open topology");
  });

  it("unit-cost and lead-respawns reduce over ONE tape read — two snapshots of a live ledger are two facts", () => {
    buildDb([...loop(1525), spawn("w1-a#aaaa", 1), usage("w1-a#aaaa", 1.0, 50_000)]);
    const gh = new FakeGh();
    gh.issues.set(1525, { number: 1525, state: "Backlog", priority: "P1" });
    const base = ctx(gh);
    let tapeReads = 0;
    const cx: Ctx = {
      ...base,
      exec: (argv, stdin) => {
        if (argv[0] === "sqlite3" && argv.includes("-json")) tapeReads++;
        return base.exec(argv, stdin);
      },
    };
    const r = doctor(cx);
    expect(r.checks.find((c) => c.name === "unit-cost")!.detail).toContain("1 unit measured");
    expect(check(r).level).toBe("info");
    expect(tapeReads).toBe(1);
  });

  it("honours RALPH_SMELL_LEAD_RESPAWNS", () => {
    buildDb(loop(1525));
    const gh = new FakeGh();
    gh.issues.set(1525, { number: 1525, state: "Backlog", priority: "P1" });
    const cx = ctx(gh);
    expect(check(doctor(cx)).level).toBe("info");
    cx.cfg.smells.leadRespawns = 4;
    expect(check(doctor(cx)).level).toBe("ok");
  });

  it("an unreadable frontier on a hit is `not evaluated`, never rendered as empty", () => {
    buildDb(loop(1525));
    const gh = new FakeGh();
    gh.issues.set(1525, { number: 1525, state: "Backlog", priority: "P1" });
    const base = ctx(gh);
    // The issues-rooted open walk (`states: OPEN`) is the frontier's read;
    // doctor's own sweeps walk the project items, so only the join breaks.
    const cx: Ctx = {
      ...base,
      exec: (argv, stdin) => {
        if ([...argv, stdin ?? ""].some((a) => /states:\s*OPEN/.test(String(a)))) throw new Error("boom: the issues read fell over");
        return base.exec(argv, stdin);
      },
    };
    const c = check(doctor(cx));
    expect(c.level).toBe("info");
    expect(c.detail).toContain("#1525 respawned 3×");
    expect(c.detail).toContain("frontier not evaluated: boom");
    expect(c.detail).not.toContain("EMPTY");
    expect(c.detail).not.toContain("--stand-down");
  });
});

describe("board frontier --epic NNN (GH-2398) — next's ranking restricted to one subtree", () => {
  it("empty under an epic whose only ready item is the root itself", () => {
    const gh = new FakeGh();
    gh.issues.set(1525, { number: 1525, state: "Backlog", priority: "P1" });
    gh.issues.set(7, { number: 7, state: "Backlog", priority: "P0" }); // a flat item elsewhere — not under 1525
    const cap = capture();
    try {
      expect(run(["frontier", "--epic", "1525"], ctx(gh))).toBe(0);
    } finally {
      cap.restore();
    }
    expect(cap.text()).toContain("frontier empty under epic #1525");
    expect(cap.text()).not.toContain("#7");
  });

  it("lists the descendants — grandchildren included — and carries the epic in --json", () => {
    const gh = new FakeGh();
    gh.issues.set(1525, { number: 1525, state: "Backlog", priority: "P1" });
    gh.issues.set(1526, { number: 1526, state: "Backlog", priority: "P2", parent: 1525 });
    gh.issues.set(1527, { number: 1527, state: "Backlog", priority: "P2", parent: 1526 });
    gh.issues.set(7, { number: 7, state: "Backlog", priority: "P0" });
    const cap = capture();
    try {
      expect(run(["frontier", "--epic", "1525", "--json"], ctx(gh))).toBe(0);
    } finally {
      cap.restore();
    }
    const j = JSON.parse(cap.text());
    expect(j.epic).toBe(1525);
    expect(j.frontier.map((f: { number: number }) => f.number)).toEqual([1527]);
    expect(j.blocked).toEqual([]);
  });

  it("a blocked descendant stays visible in the blocked half — the caller can see WHY nothing is ready", () => {
    const gh = new FakeGh();
    gh.issues.set(1525, { number: 1525, state: "Backlog", priority: "P1" });
    gh.issues.set(1526, { number: 1526, state: "Backlog", priority: "P2", parent: 1525, blockedBy: [{ number: 9, state: "OPEN" }] });
    gh.issues.set(9, { number: 9, state: "Backlog", priority: "P3" });
    const cap = capture();
    try {
      expect(run(["frontier", "--epic", "1525", "--json"], ctx(gh))).toBe(0);
    } finally {
      cap.restore();
    }
    const j = JSON.parse(cap.text());
    expect(j.frontier).toEqual([]);
    expect(j.blocked.map((b: { number: number }) => b.number)).toEqual([1526]);
  });

  it("an epic not on the topology is named as such — never a quiet 'frontier empty'", () => {
    const gh = new FakeGh();
    gh.issues.set(7, { number: 7, state: "Backlog", priority: "P0" });
    const cap = capture();
    try {
      expect(run(["frontier", "--epic", "1525"], ctx(gh))).toBe(0);
    } finally {
      cap.restore();
    }
    expect(cap.text()).toContain("epic #1525 is not on this board's open topology");
    expect(cap.text()).not.toContain("frontier empty");
    const cap2 = capture();
    try {
      run(["frontier", "--epic", "1525", "--json"], ctx(gh));
    } finally {
      cap2.restore();
    }
    const j = JSON.parse(cap2.text());
    expect(j.epicOnTopology).toBe(false);
    expect(j.frontier).toEqual([]);
  });

  it("a bare --epic is a usage error, not the whole frontier", () => {
    const gh = new FakeGh();
    gh.issues.set(1525, { number: 1525, state: "Backlog", priority: "P1" });
    const cap = capture();
    try {
      expect(() => run(["frontier", "--epic"], ctx(gh))).toThrow(UsageError);
    } finally {
      cap.restore();
    }
  });
});
