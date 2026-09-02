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
import { doctor, readLedgerUsage, realExec, reduceLedgerUsage, run, type Ctx } from "./board.js";
import { FakeGh, makeCtx } from "./board.testkit.js";

let root: string;
let saved: Record<string, string | undefined> = {};

/** sqlite3 runs for real; everything else (gh, git) stays on the fake — brief
 *  and doctor walk the board, and a real gh here would be a network call. */
function ctx(): Ctx {
  const base = makeCtx(new FakeGh());
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
