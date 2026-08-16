/**
 * board.oracle.test.ts — the change oracle that gates the item walk (GH-1804).
 *
 * The oracle only ever EXTENDS a serve past Δ, up to T_max, and only on an
 * unambiguous 304. Every test here is about a failure direction: the whole
 * value of the mechanism is that it is impossible for it to stop the walk
 * happening, because a walk that never runs again is silent and permanent.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type Ctx,
  type ExecResult,
  doctor,
  ITEM_ORACLE_MAX_DEFAULT_SEC,
  ITEM_ORACLE_MAX_LIMIT_SEC,
  listItemsFull,
  parseItemOracleMaxSec,
} from "./board.js";
import { FakeGh, makeCtx, NOW } from "./board.testkit.js";

const TTL = 90;
const TMAX = 600;

describe("change oracle (GH-1804)", () => {
  let gh: FakeGh;
  let dir: string;
  /** Probe responses, oldest first; the last one repeats. */
  let responses: ExecResult[];
  let probes: string[][];

  const REST = ok200('W/"aaa"');

  function ok200(etag: string): ExecResult {
    return { code: 0, stdout: `HTTP/2.0 200 OK\r\nEtag: ${etag}\r\n\r\n[]`, stderr: "" };
  }
  const NOT_MODIFIED: ExecResult = {
    // `gh api` exits 1 on a 304 — the trap this whole mechanism has to survive.
    code: 1,
    stdout: 'HTTP/2.0 304 Not Modified\r\nEtag: W/"aaa"\r\n\r\n',
    stderr: "",
  };

  const proc = (opts: { at?: Date; oracleSec?: number } = {}): Ctx =>
    makeCtx(gh, "me@test", "/repo", {
      cacheDir: dir,
      itemCacheTtlSec: TTL,
      itemOracleMaxSec: opts.oracleSec ?? TMAX,
      now: () => opts.at ?? NOW,
    });
  const later = (sec: number) => new Date(NOW.getTime() + sec * 1000);
  const oraclePath = () => join(dir, "items-oracle-github.com-cdubiel08-ralph-hero-13.json");

  beforeEach(() => {
    gh = new FakeGh();
    // Two Ctx values over ONE cacheDir model two CLI invocations — which is
    // also why the probe memo is keyed by Ctx: each `proc()` is a new process
    // and must ask GitHub for itself.
    dir = mkdtempSync(join(tmpdir(), "board-oracle-"));
    gh.issues.set(1, { number: 1, state: "Backlog" });
    responses = [REST];
    probes = [];
    const inner = gh.exec;
    gh.exec = (argv, stdin) => {
      if (argv[1] === "api" && argv[2] === "-i") {
        probes.push(argv);
        return responses.length > 1 ? responses.shift()! : responses[0];
      }
      return inner(argv, stdin);
    };
  });

  it("extends a serve past Δ when nothing issue-visible changed", () => {
    listItemsFull(proc()); // walk; captures the etag first
    const cost = gh.graphqlCalls;
    responses = [NOT_MODIFIED];

    const hit = listItemsFull(proc({ at: later(TTL + 60) }));
    expect(hit.cached).toBe(true);
    expect(hit.ageSec).toBe(TTL + 60);
    expect(gh.graphqlCalls).toBe(cost); // the walk was skipped, not repeated
  });

  it("captures the etag BEFORE the walk it will later vouch for", () => {
    listItemsFull(proc());
    const mark = JSON.parse(readFileSync(oraclePath(), "utf8"));
    expect(mark.etag).toBe('W/"aaa"');
    // A 304 proves nothing changed after `since`, and says nothing about the
    // window before it — so an etag captured after a walk cannot certify it.
    const entry = JSON.parse(
      readFileSync(join(dir, "items-full-l1b1-github.com-cdubiel08-ralph-hero-13.json"), "utf8"),
    );
    expect(Date.parse(mark.since)).toBeLessThanOrEqual(Date.parse(entry.fetchedAt));
    expect(probes[0].join(" ")).toContain("--hostname github.com");
  });

  it("refuses to certify an entry older than the etag's window", () => {
    listItemsFull(proc());
    const mark = JSON.parse(readFileSync(oraclePath(), "utf8"));
    // An etag captured AFTER the walk: the gap between them is unaudited.
    writeFileSync(oraclePath(), JSON.stringify({ ...mark, since: later(30).toISOString() }));
    responses = [NOT_MODIFIED];
    expect(listItemsFull(proc({ at: later(TTL + 10) })).cached).toBe(false);
  });

  it("walks on a 200 — the board moved", () => {
    listItemsFull(proc());
    const cost = gh.graphqlCalls;
    responses = [ok200('W/"bbb"')];

    expect(listItemsFull(proc({ at: later(TTL + 10) })).cached).toBe(false);
    expect(gh.graphqlCalls).toBeGreaterThan(cost);
    expect(JSON.parse(readFileSync(oraclePath(), "utf8")).etag).toBe('W/"bbb"');
  });

  describe("every failure is toward paying for the walk", () => {
    const unreadable: Record<string, ExecResult> = {
      "a rate-limited probe": { code: 1, stdout: "", stderr: "API rate limit exceeded" },
      "an auth failure": { code: 1, stdout: "HTTP/2.0 401 Unauthorized\r\n\r\n", stderr: "" },
      "a network failure with no status line": { code: 1, stdout: "", stderr: "i/o timeout" },
      "a 500": { code: 1, stdout: "HTTP/2.0 500 Internal Server Error\r\n\r\n", stderr: "" },
      // exit 0 is not a verdict either — only the status line is.
      "exit 0 with no status line": { code: 0, stdout: "[]", stderr: "" },
    };
    for (const [name, r] of Object.entries(unreadable)) {
      it(`walks on ${name}`, () => {
        listItemsFull(proc());
        responses = [r];
        expect(listItemsFull(proc({ at: later(TTL + 10) })).cached).toBe(false);
      });
    }

    it("walks on a 304 it never sent a conditional request for", () => {
      // No stored etag means the 304 answers a question nobody asked.
      responses = [NOT_MODIFIED];
      expect(listItemsFull(proc()).cached).toBe(false);
      listItemsFull(proc()); // still no mark to certify with
      expect(listItemsFull(proc({ at: later(TTL + 10) })).cached).toBe(false);
    });

    it("walks when the mark file is corrupt", () => {
      listItemsFull(proc());
      writeFileSync(oraclePath(), "{not json");
      responses = [NOT_MODIFIED];
      expect(listItemsFull(proc({ at: later(TTL + 10) })).cached).toBe(false);
    });
  });

  it("T_max is a hard ceiling no certification overrides", () => {
    // The writes the oracle CANNOT see — Workflow State, Claim, dependency
    // edges — are bounded by this and by nothing else.
    listItemsFull(proc());
    responses = [NOT_MODIFIED];
    expect(listItemsFull(proc({ at: later(TMAX - 1) })).cached).toBe(true);
    expect(listItemsFull(proc({ at: later(TMAX + 1) })).cached).toBe(false);
  });

  it("is inert when disabled, leaving Δ as the only window", () => {
    listItemsFull(proc({ oracleSec: 0 }));
    const before = probes.length;
    expect(listItemsFull(proc({ at: later(TTL + 10), oracleSec: 0 })).cached).toBe(false);
    expect(probes.length).toBe(before); // not one conditional request either
  });

  it("never lowers Δ, however small T_max is set", () => {
    listItemsFull(proc({ oracleSec: 1 }));
    expect(listItemsFull(proc({ at: later(TTL - 10), oracleSec: 1 })).cached).toBe(true);
  });

  it("doctor never reads a certified-stale walk, even when only reporting", () => {
    listItemsFull(proc());
    responses = [NOT_MODIFIED];
    const cost = gh.graphqlCalls;
    doctor(proc({ at: later(TTL + 10) }));
    expect(gh.graphqlCalls).toBeGreaterThan(cost);
  });

  it("asks GitHub once per process however many reads chain", () => {
    listItemsFull(proc());
    responses = [NOT_MODIFIED];
    const p = proc({ at: later(TTL + 10) });
    const before = probes.length;
    listItemsFull(p);
    listItemsFull(p);
    listItemsFull(p);
    expect(probes.length).toBe(before + 1);
  });

  describe("parseItemOracleMaxSec", () => {
    it("defaults on absent, empty, and unparseable", () => {
      for (const raw of [undefined, "", "  ", "abc", "-1", String(ITEM_ORACLE_MAX_LIMIT_SEC + 1)])
        expect(parseItemOracleMaxSec(raw)).toBe(ITEM_ORACLE_MAX_DEFAULT_SEC);
    });
    it("takes 0 as an explicit disable", () => {
      expect(parseItemOracleMaxSec("0")).toBe(0);
    });
    it("takes a value inside the limit", () => {
      expect(parseItemOracleMaxSec("300")).toBe(300);
    });
  });
});
