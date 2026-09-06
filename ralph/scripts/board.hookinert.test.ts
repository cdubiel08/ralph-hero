/**
 * board.hookinert.test.ts — doctor's "hook-inert" advisory (GH-2403, deferred
 * out of GH-2396's fix).
 *
 * GH-2396's incident: watch-event.sh's handle_status fell through to `exit 0`
 * before appending any ledger state, for a full day, while agents kept
 * running — and the existing dispatch-heartbeat advisory did not catch it,
 * because that heartbeat has TWO writers (the event hooks and hero
 * sittings), so a healthy hero sitting kept it fresh regardless. This check
 * isolates the hook's own effect: `ev:"state"` with `via:"event"` is written
 * ONLY by handle_status. GH-2480 also counts its deliberate withhold facts,
 * without interpreting them as lifecycle writes.
 *
 * The distinctions defended: a repo with no open agents is never flagged
 * (zero writes is the expected reading, not a smell); herdr missing or
 * unreadable degrades to "ok" (optional equipment, same as herdr-cockpit and
 * dispatch-heartbeat); the window is honoured on both sides (ledger writes
 * and log firings outside it don't count); and the smell is INFO-only —
 * never escalated by --strict.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctor, readWatchEventFireCount, realExec, reduceHookActivity, type Ctx } from "./board.js";
import { FakeGh, makeCtx, NOW, ok } from "./board.testkit.js";

let root: string;
let saved: Record<string, string | undefined> = {};

function dbPath(): string {
  const dir = join(root, "cdubiel08", "ralph-hero");
  mkdirSync(dir, { recursive: true });
  return join(dir, "ledger.sqlite");
}

function buildDb(payloads: string[]): void {
  const inserts = payloads
    .map((p, i) => `INSERT INTO facts(seq, payload) VALUES(${i + 1}, '${p.replaceAll("'", "''")}');`)
    .join("\n");
  const r = realExec(
    ["sqlite3", dbPath()],
    `PRAGMA user_version=1;\nCREATE TABLE facts(seq INTEGER PRIMARY KEY, payload TEXT NOT NULL);\n${inserts}\n`,
  );
  expect(r.code).toBe(0);
}

const spawn = (ref: string) => JSON.stringify({ ts: "2026-07-31T10:00:00Z", ev: "spawn", agent_ref: ref });
const exitEv = (ref: string, ts = "2026-07-31T10:30:00Z") => JSON.stringify({ ts, ev: "exit", agent_ref: ref, reason: "pane-closed" });
const withholdEv = (ts: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ ts, ev: "hook_withhold", via: "event", reason: "indeterminate",
    agent_name: "w1-a", pane_id: "w1:p1", ...extra });
const stateEv = (ref: string, ts: string, via = "event") =>
  JSON.stringify({ ts, ev: "state", agent_ref: ref, agent_status: "working", pane_id: "w1:p1", via });

/** `herdr plugin log list` fixtures, layered onto sqlite-passthrough exec —
 *  mirrors board.usage.test.ts's ctx() (sqlite3 runs for real) plus
 *  board.roster.test.ts's herdr-overlay pattern (everything else stays fake,
 *  and the default FakeGh answer for an unhandled command models "herdr
 *  missing"). */
function ctxWithLog(
  logEntries: Array<{ event: string; started_unix_ms: number }> | { code: number; stderr: string } | "missing",
): Ctx {
  const gh = new FakeGh();
  const inner = gh.exec.bind(gh);
  gh.exec = (argv, stdin) => {
    if (argv[0] === "sqlite3") return realExec(argv, stdin);
    const cmd = argv.join(" ");
    if (cmd.startsWith("herdr plugin log list")) {
      if (logEntries === "missing") return { code: 1, stdout: "", stderr: "unexpected: herdr plugin log list" };
      if ("code" in (logEntries as object)) {
        const e = logEntries as { code: number; stderr: string };
        return { code: e.code, stdout: "", stderr: e.stderr };
      }
      return ok(JSON.stringify({ result: { logs: logEntries } }));
    }
    return inner(argv, stdin);
  };
  return makeCtx(gh);
}

const iso = (offsetMinFromNow: number) => new Date(NOW.getTime() + offsetMinFromNow * 60_000).toISOString();
const ms = (offsetMinFromNow: number) => NOW.getTime() + offsetMinFromNow * 60_000;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "board-hookinert-"));
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

describe("reduceHookActivity", () => {
  it("counts open agents (spawn minus exit) and via:event state writes within the window", () => {
    const a = reduceHookActivity(
      [spawn("w1-a#aaaa"), stateEv("w1-a#aaaa", iso(-10)), spawn("w2-b#bbbb"), exitEv("w2-b#bbbb")],
      ms(-60),
    );
    expect(a.openAgents).toBe(1); // w1-a open, w2-b exited
    expect(a.eventWrites).toBe(1);
  });

  it("only via:event counts — reconcile's via:orphan does not", () => {
    const a = reduceHookActivity([spawn("w1-a#aaaa"), stateEv("w1-a#aaaa", iso(-10), "orphan")], ms(-60));
    expect(a.eventWrites).toBe(0);
  });

  it("a write before the cutoff does not count", () => {
    const a = reduceHookActivity([spawn("w1-a#aaaa"), stateEv("w1-a#aaaa", iso(-120))], ms(-60));
    expect(a.eventWrites).toBe(0);
  });

  it("counts typed withholds without creating an agent or a state write", () => {
    expect(reduceHookActivity([withholdEv(iso(-10))], ms(-60)))
      .toEqual({ openAgents: 0, eventWrites: 0, withholds: 1 });
  });

  it("ignores old, invalid, other-writer, and unknown-reason withholds", () => {
    const a = reduceHookActivity([
      withholdEv(iso(-120)), withholdEv("bad timestamp"),
      withholdEv(iso(-10), { via: "reconcile" }),
      withholdEv(iso(-10), { reason: "unknown" }),
      withholdEv(iso(-10), { reason: undefined }),
    ], ms(-60));
    expect(a.withholds).toBe(0);
  });

  it("a garbled payload is skipped, not a crash", () => {
    expect(reduceHookActivity(["not json"], ms(-60))).toEqual({ openAgents: 0, eventWrites: 0, withholds: 0 });
  });
});

describe("readWatchEventFireCount", () => {
  it("counts pane.agent_status_changed entries within the window, machine-wide", () => {
    const c = ctxWithLog([
      { event: "pane.agent_status_changed", started_unix_ms: ms(-10) },
      { event: "pane.agent_status_changed", started_unix_ms: ms(-120) }, // outside window
      { event: "pane.exited", started_unix_ms: ms(-5) }, // wrong event type
    ]);
    const r = readWatchEventFireCount(c, ms(-60));
    expect(r).toEqual({ kind: "ok", fired: 1, sinceMs: ms(-60) });
  });

  it("bounds the window by the oldest returned status invocation without relying on log order", () => {
    const c = ctxWithLog([
      { event: "pane.agent_status_changed", started_unix_ms: ms(-5) },
      { event: "pane.exited", started_unix_ms: ms(-40) },
      { event: "pane.agent_status_changed", started_unix_ms: ms(-10) },
      { event: "pane.agent_status_changed", started_unix_ms: ms(-2) },
      { event: "pane.agent_status_changed", started_unix_ms: NaN },
    ]);
    expect(readWatchEventFireCount(c, ms(-60)))
      .toEqual({ kind: "ok", fired: 3, sinceMs: ms(-10) });
  });

  it("an empty log retains a finite configured cutoff", () => {
    expect(readWatchEventFireCount(ctxWithLog([]), ms(-60)))
      .toEqual({ kind: "ok", fired: 0, sinceMs: ms(-60) });
  });

  it("herdr missing or refusing is 'unavailable', not zero", () => {
    expect(readWatchEventFireCount(ctxWithLog("missing"), ms(-60)).kind).toBe("unavailable");
    expect(readWatchEventFireCount(ctxWithLog({ code: 2, stderr: "herdr: not found" }), ms(-60)).kind).toBe("unavailable");
  });
});

describe("doctor: hook-inert (GH-2403) — advisory by construction", () => {
  const check = (r: ReturnType<typeof doctor>) => r.checks.find((c) => c.name === "hook-inert")!;

  it("no ledger is ok, quietly", () => {
    const c = check(doctor(ctxWithLog("missing")));
    expect(c.level).toBe("ok");
    expect(c.detail).toContain("no herdr ledger");
  });

  it("an unreadable ledger is not evaluated — never ok", () => {
    writeFileSync(dbPath(), "not a database");
    const c = check(doctor(ctxWithLog("missing")));
    expect(c.level).toBe("info");
    expect(c.detail).toContain("not evaluated");
  });

  it("zero open agents in this repo's ledger is ok regardless of machine-wide firing", () => {
    buildDb([spawn("w1-a#aaaa"), exitEv("w1-a#aaaa")]);
    const c = check(doctor(ctxWithLog([{ event: "pane.agent_status_changed", started_unix_ms: ms(-10) }])));
    expect(c.level).toBe("ok");
    expect(c.detail).toContain("no open agents");
  });

  it("open agents but herdr unreadable degrades to ok — optional equipment", () => {
    buildDb([spawn("w1-a#aaaa")]);
    const c = check(doctor(ctxWithLog("missing")));
    expect(c.level).toBe("ok");
    expect(c.detail).toContain("herdr plugin log not readable");
  });

  it("open agents, hook silent (fired 0) is ok", () => {
    buildDb([spawn("w1-a#aaaa")]);
    const c = check(doctor(ctxWithLog([])));
    expect(c.level).toBe("ok");
    expect(c.detail).toContain("has not fired");
  });

  it("open agents, hook fired, ledger wrote — ok, both numbers named", () => {
    buildDb([spawn("w1-a#aaaa"), stateEv("w1-a#aaaa", iso(-10))]);
    const c = check(
      doctor(ctxWithLog([{ event: "pane.agent_status_changed", started_unix_ms: ms(-10) }])),
    );
    expect(c.level).toBe("ok");
    expect(c.detail).toContain("fired 1×, wrote 1 ledger state event(s)");
  });

  it("THE smell: fired N times, zero ledger writes, open agents present — info, names GH-2396", () => {
    buildDb([spawn("w1-a#aaaa")]);
    const c = check(
      doctor(
        ctxWithLog([
          { event: "pane.agent_status_changed", started_unix_ms: ms(-5) },
          { event: "pane.agent_status_changed", started_unix_ms: ms(-10) },
          { event: "pane.agent_status_changed", started_unix_ms: ms(-15) },
        ]),
      ),
    );
    expect(c.level).toBe("info");
    expect(c.detail).toContain("watch-event fired 3×");
    expect(c.detail).toContain("zero");
    expect(c.detail).toContain("GH-2396");
  });

  it("credit-exhausted fleet: three deliberate withholds explain three firings", () => {
    buildDb([
      ...Array.from({ length: 7 }, (_, i) => spawn(`w${i}-agent#aaaa`)),
      withholdEv(iso(-5)), withholdEv(iso(-10)), withholdEv(iso(-15)),
    ]);
    const c = check(doctor(ctxWithLog([-5, -10, -15].map((min) => ({
      event: "pane.agent_status_changed", started_unix_ms: ms(min),
    })))));
    expect(c.level).toBe("ok");
    expect(c.detail).toContain("wrote 0 ledger state event(s)");
    expect(c.detail).toContain("3 deliberate withhold(s)");
    expect(c.detail).not.toContain("swallowing");
  });

  it("a partial withhold count still exposes unexplained firings", () => {
    buildDb([spawn("w1-a#aaaa"), withholdEv(iso(-5))]);
    const c = check(doctor(ctxWithLog([-5, -10, -15].map((min) => ({
      event: "pane.agent_status_changed", started_unix_ms: ms(min),
    })))));
    expect(c.level).toBe("info");
    expect(c.detail).toContain("1 deliberate withhold(s), 2 unexplained firing(s)");
    expect(c.detail).toContain("GH-2396");
  });

  it("an old withhold does not excuse a current firing", () => {
    buildDb([spawn("w1-a#aaaa"), withholdEv(iso(-120))]);
    const c = check(doctor(ctxWithLog([
      { event: "pane.agent_status_changed", started_unix_ms: ms(-5) },
    ])));
    expect(c.level).toBe("info");
    expect(c.detail).toContain("0 deliberate withhold(s), 1 unexplained firing(s)");
  });

  it("a withhold omitted by the bounded log cannot cancel an observed unexplained firing", () => {
    // Both events are inside the configured hour, but only the later firing
    // survived the machine-wide log limit. Its predecessor's withhold is not
    // evidence about this observed invocation.
    buildDb([spawn("w1-a#aaaa"), withholdEv(iso(-10))]);
    const c = check(doctor(ctxWithLog([
      { event: "pane.agent_status_changed", started_unix_ms: ms(-5) },
    ])));
    expect(c.level).toBe("info");
    expect(c.detail).toContain("0 deliberate withhold(s), 1 unexplained firing(s)");
  });

  it("a state write outside the observed log window cannot hide a recent inert firing", () => {
    buildDb([spawn("w1-a#aaaa"), stateEv("w1-a#aaaa", iso(-10))]);
    const c = check(doctor(ctxWithLog([
      { event: "pane.agent_status_changed", started_unix_ms: ms(-5) },
    ])));
    expect(c.level).toBe("info");
    expect(c.detail).toContain("1 unexplained firing(s)");
  });

  it("only the in-window withhold offsets a mixed pair of observed firings", () => {
    buildDb([spawn("w1-a#aaaa"), withholdEv(iso(-15)), withholdEv(iso(-10))]);
    const c = check(doctor(ctxWithLog([-5, -10].map((min) => ({
      event: "pane.agent_status_changed", started_unix_ms: ms(min),
    })))));
    expect(c.level).toBe("info");
    expect(c.detail).toContain("1 deliberate withhold(s), 1 unexplained firing(s)");
  });

  it("a bounded log counts only the withhold within its observed window", () => {
    buildDb([spawn("w1-a#aaaa"), withholdEv(iso(-5)), withholdEv(iso(-10))]);
    const c = check(doctor(ctxWithLog([
      { event: "pane.agent_status_changed", started_unix_ms: ms(-5) },
    ])));
    expect(c.level).toBe("ok");
    expect(c.detail).toContain("1 deliberate withhold(s)");
    expect(c.detail).not.toContain("unexplained");
  });

  it("a firing (or write) outside the window is invisible to the check", () => {
    buildDb([spawn("w1-a#aaaa"), stateEv("w1-a#aaaa", iso(-120))]); // write, but stale
    const c = check(
      doctor(ctxWithLog([{ event: "pane.agent_status_changed", started_unix_ms: ms(-200) }])), // fire, but stale
    );
    expect(c.level).toBe("ok");
    expect(c.detail).toContain("has not fired");
  });

  it("the window is env-tunable via RALPH_SMELL_HOOK_MIN", () => {
    buildDb([spawn("w1-a#aaaa")]);
    const cx = ctxWithLog([{ event: "pane.agent_status_changed", started_unix_ms: ms(-90) }]);
    cx.cfg.smells = { ...cx.cfg.smells, hookMin: 120 };
    const c = check(doctor(cx));
    expect(c.level).toBe("info");
    expect(c.detail).toContain("fired 1×");
  });

  it("info never escalates the exit code under --strict", () => {
    buildDb([spawn("w1-a#aaaa")]);
    const cx = ctxWithLog([
      { event: "pane.agent_status_changed", started_unix_ms: ms(-5) },
      { event: "pane.agent_status_changed", started_unix_ms: ms(-10) },
      { event: "pane.agent_status_changed", started_unix_ms: ms(-15) },
    ]);
    const strictBaseline = doctor(cx, { strict: true }).ok;
    const r = doctor(cx, { strict: true });
    expect(check(r).level).toBe("info");
    expect(r.ok).toBe(strictBaseline);
  });
});
