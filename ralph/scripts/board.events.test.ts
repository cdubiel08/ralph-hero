/**
 * board.events.test.ts — `board events --since SEQ` (GH-2310).
 *
 * A read-only cursor over the herdr ledger's sqlite sibling. The distinctions
 * defended here: an ABSENT db is a normal unconverted machine (exit 0, empty
 * result, named on stderr) while an UNREADABLE db is exit 69 and never an
 * empty result; a future user_version refuses rather than guessing; payload
 * comes back verbatim.
 *
 * Real sqlite databases throughout, built via the sqlite3 CLI — the verb
 * shells out to that binary, so a fake would let the code agree with itself.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realExec, run, UsageError, type Ctx } from "./board.js";
import { FakeGh, makeCtx } from "./board.testkit.js";

let root: string;
let savedRoot: string | undefined;
let savedBin: string | undefined;

/** makeCtx's config pins owner/repo, so the db path under the overridden root
 *  is deterministic. exec is the real one: sqlite3 runs for real. */
function ctx(): Ctx {
  return { ...makeCtx(new FakeGh()), exec: realExec };
}

function dbPath(): string {
  const dir = join(root, "cdubiel08", "ralph-hero");
  mkdirSync(dir, { recursive: true });
  return join(dir, "ledger.sqlite");
}

/** Build a v1-shaped fixture db with the given payloads at seq 1..n. */
function buildDb(payloads: string[], userVersion = 1): string {
  return buildDbAt(dbPath(), payloads, userVersion);
}

function buildDbAt(db: string, payloads: string[], userVersion = 1): string {
  const inserts = payloads
    .map((p, i) => `INSERT INTO facts(seq, payload) VALUES(${i + 1}, '${p.replaceAll("'", "''")}');`)
    .join("\n");
  const r = realExec(
    ["sqlite3", db],
    `PRAGMA user_version=${userVersion};\nCREATE TABLE facts(seq INTEGER PRIMARY KEY, payload TEXT NOT NULL);\n${inserts}\n`,
  );
  expect(r.code).toBe(0);
  return db;
}

function capture() {
  const lines: string[] = [];
  const errs: string[] = [];
  const outSpy = vi.spyOn(process.stdout, "write").mockImplementation((s) => {
    lines.push(String(s));
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((s) => {
    errs.push(String(s));
    return true;
  });
  return { lines, errs, restore: () => (outSpy.mockRestore(), errSpy.mockRestore()) };
}

let savedExplicit: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "board-events-"));
  savedRoot = process.env.RALPH_HERDR_LEDGER_ROOT;
  savedBin = process.env.RALPH_SQLITE3_BIN;
  savedExplicit = process.env.RALPH_HERDR_LEDGER;
  process.env.RALPH_HERDR_LEDGER_ROOT = root;
  delete process.env.RALPH_SQLITE3_BIN;
  delete process.env.RALPH_HERDR_LEDGER;
});

afterEach(() => {
  if (savedRoot === undefined) delete process.env.RALPH_HERDR_LEDGER_ROOT;
  else process.env.RALPH_HERDR_LEDGER_ROOT = savedRoot;
  if (savedBin === undefined) delete process.env.RALPH_SQLITE3_BIN;
  else process.env.RALPH_SQLITE3_BIN = savedBin;
  if (savedExplicit === undefined) delete process.env.RALPH_HERDR_LEDGER;
  else process.env.RALPH_HERDR_LEDGER = savedExplicit;
  try {
    chmodSync(join(root, "cdubiel08"), 0o755); // undo the EACCES fixture so rmSync can sweep
  } catch {
    /* not every test creates it */
  }
  rmSync(root, { recursive: true, force: true });
});

describe("board events --since", () => {
  it("returns facts after the cursor in seq order, seq<TAB>payload", () => {
    buildDb(['{"seq":1,"kind":"a"}', '{"seq":2,"kind":"b"}', '{"seq":3,"kind":"c"}']);
    const c = capture();
    try {
      expect(run(["events", "--since", "1"], ctx())).toBe(0);
    } finally {
      c.restore();
    }
    expect(c.lines).toEqual(['2\t{"seq":2,"kind":"b"}\n', '3\t{"seq":3,"kind":"c"}\n']);
  });

  it("--since 0 reads everything; --json carries cursor = max seq and parsed payloads", () => {
    buildDb(['{"seq":1,"kind":"spawn","agent":"w1"}', '{"seq":2,"kind":"exit","agent":"w1"}']);
    const c = capture();
    try {
      expect(run(["events", "--since", "0", "--json"], ctx())).toBe(0);
    } finally {
      c.restore();
    }
    const v = JSON.parse(c.lines.join(""));
    expect(v.cursor).toBe(2);
    expect(v.facts).toEqual([
      { seq: 1, kind: "spawn", agent: "w1" },
      { seq: 2, kind: "exit", agent: "w1" },
    ]);
  });

  it("an empty window echoes the cursor back rather than regressing it", () => {
    buildDb(['{"seq":1}']);
    const c = capture();
    try {
      expect(run(["events", "--since", "99", "--json"], ctx())).toBe(0);
    } finally {
      c.restore();
    }
    expect(JSON.parse(c.lines.join(""))).toEqual({ cursor: 99, facts: [] });
  });

  it("payload survives verbatim — byte-compare against the inserted line", () => {
    const payload = '{"seq":1,"reason":"quote \\" and unicode — ✓ and a backslash \\\\"}';
    buildDb([payload]);
    const c = capture();
    try {
      expect(run(["events", "--since", "0"], ctx())).toBe(0);
    } finally {
      c.restore();
    }
    expect(c.lines).toEqual([`1\t${payload}\n`]);
  });

  it("refuses a missing, non-numeric, or negative --since (exit 64 semantics)", () => {
    buildDb(['{"seq":1}']);
    for (const argv of [["events"], ["events", "--since"], ["events", "--since", "abc"], ["events", "--since", "-1"]]) {
      expect(() => run(argv, ctx())).toThrow(UsageError);
    }
    // Digits-only but beyond 2^53: a malformed CURSOR, not an unreadable
    // ledger — exit 64 semantics, never 69.
    expect(() => run(["events", "--since", "9".repeat(400)], ctx())).toThrow(UsageError);
  });

  it("absent db is a normal state: exit 0, empty --json result, named on stderr", () => {
    const c = capture();
    let code: number;
    try {
      code = run(["events", "--since", "0", "--json"], ctx());
    } finally {
      c.restore();
    }
    expect(code).toBe(0);
    expect(JSON.parse(c.lines.join(""))).toEqual({ cursor: 0, facts: [] });
    expect(c.errs.join("")).toContain("no ledger.sqlite for cdubiel08/ralph-hero — run ledger-convert.sh");
  });

  it("absent db, plain mode: exit 0 and NOTHING on stdout", () => {
    const c = capture();
    let code: number;
    try {
      code = run(["events", "--since", "0"], ctx());
    } finally {
      c.restore();
    }
    expect(code).toBe(0);
    expect(c.lines).toEqual([]);
  });

  it("an UNREADABLE existing db is exit 69, never an empty result", () => {
    writeFileSync(dbPath(), "this is not a sqlite database, definitely longer than a header\n");
    const c = capture();
    let code: number;
    try {
      code = run(["events", "--since", "0", "--json"], ctx());
    } finally {
      c.restore();
    }
    expect(code).toBe(69);
    expect(c.lines).toEqual([]); // no {cursor, facts} — "could not read" must not render as "nothing happened"
    expect(c.errs.join("")).toContain("could not read");
  });

  it("refuses a db whose user_version is above 1, stating the version seen", () => {
    buildDb(['{"seq":1}'], 2);
    const c = capture();
    let code: number;
    try {
      code = run(["events", "--since", "0"], ctx());
    } finally {
      c.restore();
    }
    expect(code).toBe(69);
    expect(c.errs.join("")).toContain("user_version=2");
  });

  it("the database column seq is authoritative — a payload's own seq may not shadow it", () => {
    buildDb(['{"seq":999,"kind":"a"}']);
    const c = capture();
    try {
      expect(run(["events", "--since", "0", "--json"], ctx())).toBe(0);
    } finally {
      c.restore();
    }
    const v = JSON.parse(c.lines.join(""));
    expect(v.facts).toEqual([{ seq: 1, kind: "a" }]);
    expect(v.cursor).toBe(1);
  });

  it("an explicit RALPH_HERDR_LEDGER wins: the sqlite sibling beside it is read", () => {
    const custom = join(root, "elsewhere");
    mkdirSync(custom, { recursive: true });
    buildDbAt(join(custom, "ledger.sqlite"), ['{"kind":"custom"}']);
    process.env.RALPH_HERDR_LEDGER = join(custom, "ledger.jsonl");
    const c = capture();
    try {
      expect(run(["events", "--since", "0"], ctx())).toBe(0);
    } finally {
      c.restore();
    }
    expect(c.lines).toEqual(['1\t{"kind":"custom"}\n']);
  });

  it("a ledger behind an untraversable directory is exit 69, never 'not converted'", () => {
    buildDb(['{"seq":1}']);
    chmodSync(join(root, "cdubiel08"), 0o000);
    const c = capture();
    let code: number;
    try {
      code = run(["events", "--since", "0", "--json"], ctx());
    } finally {
      c.restore();
      chmodSync(join(root, "cdubiel08"), 0o755);
    }
    expect(code).toBe(69);
    expect(c.lines).toEqual([]);
    expect(c.errs.join("")).toContain("could not read");
  });

  it("a missing sqlite3 binary is a typed refusal (exit 69) naming the install", () => {
    buildDb(['{"seq":1}']);
    process.env.RALPH_SQLITE3_BIN = join(root, "no-such-sqlite3");
    const c = capture();
    let code: number;
    try {
      code = run(["events", "--since", "0"], ctx());
    } finally {
      c.restore();
    }
    expect(code).toBe(69);
    expect(c.errs.join("")).toContain("sqlite3");
  });
});
