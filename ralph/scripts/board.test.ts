/**
 * board.test.ts — the machine's contract. Every invariant named in the design
 * (thoughts/shared/ideas/2026-07-31-ralph-v2-minimal-harness.md §2) has a test.
 * Pure core + injected exec; no network.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash as cryptoCreateHash } from "node:crypto";
import { join } from "node:path";
import { BRANCH_KIND_CHARS } from "./contracts.js";
import {
  acceptedUnactioned,
  adopt,
  answer,
  DEP_CANDIDATES_DISCLAIMER,
  DEP_FILING_PRINT_CAP,
  DEP_OVERLAP_MIN_DEFAULT,
  depCandidateTerms,
  depFilingThreshold,
  depPairKey,
  depsUnwiredMap,
  dismissedDepPairs,
  parseDepCandidatesCap,
  parseDepOverlapMin,
  scoreDepCandidates,
  TEND_DEP_JUDGED_MARKER,
  APPLY_EVIDENCE_MARKER,
  APPLY_LABEL_DEFAULT,
  applyEvidenceFailure,
  isApplyIssue,
  loadApplyConfig,
  parseApplyEvidence,
  parseVerifyAfter,
  validateApplyEvidence,
  CAPABILITY_FLOORS,
  compareVersions,
  installedPluginReport,
  gateKitReport,
  resolveInstalledPlugin,
  claimExpiry,
  claimHintDue,
  claimIsStale,
  CLAIM_EXPIRY_EVIDENCE,
  type Config,
  countEvidence,
  createIssue,
  type Ctx,
  DECISION_EVIDENCE_MARKER,
  decisionEvidence,
  diagnoseEmptyQueue,
  parseDefer,
  formatDefer,
  doctor,
  parsePrOrphanPolicy,
  prOrphans,
  PR_ORPHAN_DEFAULT_IGNORE,
  PR_ORPHAN_IGNORE_ENV,
  ESCALATION_EVIDENCE,
  encodeClaim,
  fetchIssue,
  formatLocalHm,
  type LeaseHold,
  localSessionLease,
  ghGraphQL,
  instrumentQuery,
  COST_ALIAS,
  legalTransition,
  loadConfig,
  LEGACY_STATES,
  listItems,
  listItemsFull,
  listOwnOpenItems,
  closedTreeEdges,
  ownRepo,
  isState,
  MACHINE,
  parentCheck,
  parseArgs,
  BOOLEAN_FLAGS,
  VALUE_FLAGS,
  parseClaim,
  parseSmellThresholds,
  parseStateArg,
  parseTtlMin,
  type QueueItem,
  QUEUE_SELECT_MINIMAL,
  QUEUE_SELECT_NO_LABELS,
  priorityOptionOrder,
  rankNext,
  backlogReadinessGaps,
  type DoctorReport,
  integrationPolicy,
  readiness,
  realExec,
  reconcile,
  RefusalError,
  reviewStall,
  run,
  scopeMatches,
  setDependency,
  setEstimate,
  setPriority,
  setup,
  SMELL_DEFAULTS,
  STATES,
  transition,
  TransientError,
  UsageError,
  writeBootstrapConfig,
} from "./board.js";

// ---------------------------------------------------------------------------
// Pure logic
// ---------------------------------------------------------------------------

describe("state machine", () => {
  it("encodes exactly the designed transition table — terminal states have no move edges", () => {
    expect(MACHINE).toEqual({
      // Intake (GH-2077) is strictly one-way: approval or rejection, nothing
      // else. No `Intake → In Progress` is what makes `board claim` on an
      // unapproved item refuse via the machine rather than via special code.
      Intake: ["Backlog", "Canceled"],
      Backlog: ["In Progress", "Done", "Canceled"],
      // In Progress → Done: the GH-1777 argument extended — gates key on the
      // destination, so apply/decision units close through the gated lane
      // instead of a fictional In Review hop that drops their --why.
      "In Progress": ["In Review", "Done", "Human Needed", "Backlog", "Canceled"],
      "In Review": ["Done", "In Progress", "Human Needed", "Canceled"],
      // GH-2078: no Backlog edge — an answered item resumes or dies; a
      // parking edge out of an escalation loses the question.
      "Human Needed": ["In Progress", "Canceled"],
      Done: [],
      Canceled: [],
    });
  });

  it("refuses everything not in the table", () => {
    const illegal: Array<[string, string]> = [
      ["Backlog", "In Review"],
      ["Backlog", "Human Needed"],
      ["Backlog", "Intake"], // GH-2077: no demotion edge — a way to hide work from the queue
      ["Intake", "In Progress"], // approval cannot be skipped by claiming
      ["Intake", "In Review"],
      ["Intake", "Human Needed"],
      ["Intake", "Done"],
      ["Human Needed", "In Review"],
      ["Human Needed", "Done"],
      ["Human Needed", "Backlog"], // GH-2078: answered work resumes or dies, never parks
      ["Done", "In Progress"],
      ["Done", "Backlog"], // exit is reopen, never move
      ["Canceled", "Backlog"],
      ["Canceled", "Done"],
    ];
    for (const [from, to] of illegal) {
      expect(legalTransition(from as any, to as any), `${from} → ${to}`).toBe(false);
    }
  });

  // GH-1777. Both halves are load-bearing and pull in opposite directions, so
  // they are asserted together with the reasoning attached.
  it("Backlog closes as delivered but never escalates: Done is legal, Human Needed is not", () => {
    // Legal: the Done GATES key on the destination (merged linked PR or an
    // explicit --why; apply evidence with no escape), so the edge adds a gated
    // path rather than a hole. Without it, close-as-already-delivered had to
    // detour through reconcile(), which writes the state field directly and
    // runs no gate at all.
    expect(legalTransition("Backlog", "Done")).toBe(true);
    // Illegal, deliberately: `answer` moves Human Needed → In Progress and owns
    // that edge alone. A closure proposal against an unstarted item is
    // terminal-answered, not resumed — answering it must not start work. It
    // files as a TEND_PROPOSAL_MARKER comment instead.
    expect(legalTransition("Backlog", "Human Needed")).toBe(false);
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
    expect(c).toEqual({ holders: ["chad@mbp"], since: t0 });
  });

  it("holder may contain | — last separator wins", () => {
    const c = parseClaim(`weird|host|${t0.toISOString()}`);
    expect(c?.holders).toEqual(["weird|host"]);
  });

  it("rejects malformed values instead of guessing", () => {
    expect(parseClaim("")).toBeNull();
    expect(parseClaim(null)).toBeNull();
    expect(parseClaim("no-separator")).toBeNull();
    expect(parseClaim("holder|not-a-date")).toBeNull();
  });

  it("staleness is >= TTL, not >", () => {
    const claim = { holders: ["x"], since: t0 };
    const at = (min: number) => new Date(t0.getTime() + min * 60_000);
    expect(claimIsStale(claim, at(119), 120)).toBe(false);
    expect(claimIsStale(claim, at(120), 120)).toBe(true);
  });

  it("the expiry hint is due strictly past 75% of TTL and only while fresh", () => {
    const claim = { holders: ["x"], since: t0 };
    const at = (min: number) => new Date(t0.getTime() + min * 60_000);
    expect(claimHintDue(claim, at(0), 120)).toBe(false);
    expect(claimHintDue(claim, at(90), 120)).toBe(false); // exactly 75% — not yet
    expect(claimHintDue(claim, at(91), 120)).toBe(true);
    expect(claimHintDue(claim, at(119), 120)).toBe(true);
    expect(claimHintDue(claim, at(120), 120)).toBe(false); // stale — a different refusal
  });

  it("expiry is since + TTL, rendered as local HH:MM", () => {
    const claim = { holders: ["x"], since: t0 };
    const exp = claimExpiry(claim, 120);
    expect(exp.getTime() - t0.getTime()).toBe(120 * 60_000);
    expect(formatLocalHm(exp)).toBe(
      `${String(exp.getHours()).padStart(2, "0")}:${String(exp.getMinutes()).padStart(2, "0")}`,
    );
    expect(formatLocalHm(new Date(2026, 0, 2, 4, 5))).toBe("04:05"); // zero-padded
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
    parentNumber: null,
    openBlockers: [],
    openBlockerLabels: [],
    blockersTruncated: false,
    fieldValuesTruncated: false,
    claim: null,
    claimRaw: null,
    labels: [],
    labelsTruncated: false,
    closedBlockers: [],
    ...over,
  });

  it("priority beats parenthood beats age; blocked excluded but reported; claimed invisible", () => {
    const items = [
      item(10),
      item(2, { priority: "P2" }),
      item(3, { priority: "P0" }),
      item(4, { hasParent: true }),
      item(5, { openBlockers: [3] }),
      item(6, { claim: { holders: ["other"], since: new Date() } }),
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

  it("a host repo's custom scheme is ordered by the field's live option order (GH-1789)", () => {
    // Digit-suffix ranking alone gives "Now" and "Later" the same last place as
    // null — so `next` would hand back an older unprioritized item ahead of the
    // Now work the operator just filed. The option order is the ordering.
    const order = ["Now", "Later"];
    const items = [item(1), item(2, { priority: "Later" }), item(3, { priority: "Now" })];
    expect(rankNext(items, [], order).eligible.map((i) => i.number)).toEqual([3, 2, 1]);
    // Unprioritized still sorts last, the guarantee the ranking always made.
    expect(rankNext([item(9), item(4, { priority: "Later" })], [], order).eligible.map((i) => i.number)).toEqual([4, 9]);
    // Inheritance runs through the same ranker, so it speaks the scheme too.
    const tree = [item(1, { priority: "Now" }), item(2, { priority: "Later" }), child(5, 1)];
    expect(rankNext(tree, [], order).eligible[0].number).toBe(5);
  });

  it("a value the live options no longer hold ranks BEHIND every live option, digits or not", () => {
    // A renamed/removed option still stamped on an item. The digit fallback is
    // offset past the option range, so it cannot share rank space with it: the
    // dangerous case is stale "P0", which at rank 0 would TIE `Now` and take
    // the head on the issue-number tie-break. Lowest numbers here are the
    // stale ones on purpose.
    const order = ["Now", "Later"];
    const items = [
      item(1, { priority: "P0" }), // stale, and would win every tie-break
      item(2, { priority: "URGENT" }), // stale, no digits at all
      item(8, { priority: "Later" }), // live, last option
      item(9, { priority: "Now" }), // live, first option
    ];
    expect(rankNext(items, [], order).eligible.map((i) => i.number)).toEqual([9, 8, 1, 2]);
    // Relative order AMONG stale digit values is still preserved.
    expect(
      rankNext([item(1, { priority: "P3" }), item(2, { priority: "P1" })], [], order).eligible.map((i) => i.number),
    ).toEqual([2, 1]);
  });

  it("null priority sorts LAST, never as a default rank — the decision, not an accident (GH-1796)", () => {
    // The rejected alternative was ranking null as P2-equivalent so that
    // pre-existing unprioritized items stop parking behind P3s. It was rejected
    // because it FABRICATES a judgment: a null item would tie an item someone
    // deliberately called P2, and the tie-break (issue number) would hand the
    // older unjudged item the head of the queue over the newer judged one.
    // Ranking last says the true thing — nobody has judged this — and the
    // remedy is one flag. Visibility is tend's `unformed` category, not a
    // ranking default.
    const items = [item(1), item(2, { priority: "P3" }), item(3, { priority: "P2" })];
    expect(rankNext(items).eligible.map((i) => i.number)).toEqual([3, 2, 1]);
    // Inheritance is the ONE sanctioned way a null item ranks above last: a
    // priority its parent chain actually asserts. That path is unchanged.
    const tree = [item(1, { priority: "P0" }), item(2, { priority: "P3" }), child(5, 1)];
    expect(rankNext(tree).eligible[0].number).toBe(5);
  });

  it("a seeded P0..P3 board ranks identically with and without the live order", () => {
    const items = [item(1, { priority: "P10" }), item(2, { priority: "P2" }), item(3), item(4, { priority: "P0" })];
    const expected = [4, 2, 1, 3];
    expect(rankNext(items).eligible.map((i) => i.number)).toEqual(expected);
    expect(rankNext(items, [], ["P0", "P1", "P2", "P3"]).eligible.map((i) => i.number)).toEqual(expected);
  });

  // -------------------------------------------------------------------------
  // Epic directionality: root→leaf resolution from board-resident parent edges
  // -------------------------------------------------------------------------

  const child = (n: number, parent: number, over: Partial<QueueItem> = {}) =>
    item(n, { hasParent: true, parentNumber: parent, ...over });

  it("an epic root yields to its best open leaf — the leaf inherits the root's priority and carries via", () => {
    // P0 epic 1 with plain children 5,6; a P1 flat item 2 competes.
    const items = [item(1, { priority: "P0" }), item(2, { priority: "P1" }), child(5, 1), child(6, 1)];
    const { eligible, inFlightEpics } = rankNext(items);
    // Children inherit P0 and beat the P1 item; the root never surfaces.
    expect(eligible.map((i) => i.number)).toEqual([5, 6, 2]);
    expect(eligible[0].via).toBe(1);
    expect(inFlightEpics).toEqual([]);
  });

  it("grandchild chains resolve to the deepest actionable leaf, via the nearest demoted ancestor", () => {
    const items = [item(1, { priority: "P0" }), child(2, 1), child(3, 2)];
    const { eligible } = rankNext(items);
    expect(eligible.map((i) => i.number)).toEqual([3]);
    expect(eligible[0].via).toBe(2); // nearest demoted root, not the top
  });

  it("an epic with a child in flight heads nothing — reported as inFlightEpics, not eligible", () => {
    const items = [
      item(1, { priority: "P0" }),
      child(5, 1, { state: "In Progress", claim: { holders: ["other@host"], since: NOW } }),
    ];
    const { eligible, inFlightEpics } = rankNext(items);
    expect(eligible).toEqual([]);
    expect(inFlightEpics).toEqual([{ root: 1, child: 5, holder: "other@host" }]);
  });

  it("a claimed Backlog child also counts as in flight (a claim is work in motion)", () => {
    const items = [item(1), child(5, 1, { claim: { holders: ["w@h"], since: NOW } })];
    const { eligible, inFlightEpics } = rankNext(items);
    expect(eligible).toEqual([]);
    expect(inFlightEpics).toEqual([{ root: 1, child: 5, holder: "w@h" }]);
  });

  it("all children blocked: the root keeps its slot, annotated childrenBlocked — never emptier than flat", () => {
    const items = [item(1), child(5, 1, { openBlockers: [9], openBlockerLabels: ["#9"] })];
    const { eligible, blocked } = rankNext(items);
    expect(eligible.map((i) => i.number)).toEqual([1]);
    expect(eligible[0].childrenBlocked).toEqual([5]);
    expect(blocked.map((i) => i.number)).toEqual([5]);
  });

  it("a cross-repo parent is a null edge — the item ranks as a plain leaf, no foreign tree binding", () => {
    // hasParent true (tie-break keeps working) but parentNumber null (fail closed).
    const items = [item(1), item(7, { hasParent: true, parentNumber: null })];
    const { eligible } = rankNext(items);
    expect(eligible.map((i) => i.number)).toEqual([7, 1]); // parented tie-break only
    expect(eligible[0].via).toBeUndefined();
  });

  it("a closed intermediate node passes tree topology through — the root still demotes for a live grandchild", () => {
    // epic 10 → phase 11 (closed, off the open list) → task 12 (in flight).
    const items = [item(10, { priority: "P0" }), child(12, 11, { state: "In Progress", claim: { holders: ["a@h"], since: NOW } })];
    const withEdge = rankNext(items, [{ number: 11, parentNumber: 10 }]);
    expect(withEdge.eligible).toEqual([]);
    expect(withEdge.inFlightEpics).toEqual([{ root: 10, child: 12, holder: "a@h" }]);
    // And a Backlog grandchild inherits the root's P0 through the closed node.
    const items2 = [item(10, { priority: "P0" }), item(2, { priority: "P1" }), child(12, 11)];
    const r2 = rankNext(items2, [{ number: 11, parentNumber: 10 }]);
    expect(r2.eligible.map((i) => i.number)).toEqual([12, 2]);
    expect(r2.eligible[0].via).toBe(10);
  });

  it("a terminal-on-board (Done/Canceled) open child is reconcile drift, not flight — the root stays eligible", () => {
    const items = [item(10), child(11, 10, { state: "Canceled" })];
    const { eligible, inFlightEpics } = rankNext(items);
    expect(eligible.map((i) => i.number)).toEqual([10]);
    expect(eligible[0].childrenBlocked).toBeUndefined(); // drift is not blockage either
    expect(inFlightEpics).toEqual([]);
  });

  it("a malformed parent cycle degrades to own priority instead of looping", () => {
    const items = [child(1, 2), child(2, 1)];
    const { eligible } = rankNext(items);
    // Both are 'roots' with an eligible descendant (each other) — demoted both,
    // and the cycle must not hang. Neither heads the queue; nothing crashes.
    expect(eligible).toEqual([]);
  });
});

describe("next: epic-aware output", () => {
  it("prints the leaf with its epic context, and epic-in-flight when the tree is being worked", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    gh.issues.set(1, { number: 1, state: "Backlog" });
    gh.issues.set(5, { number: 5, state: "Backlog", parent: 1 });
    const said: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((s) => {
      said.push(String(s));
      return true;
    });
    try {
      run(["next"], ctx);
      expect(said.join("")).toContain("next: #5 Issue 5 (under epic #1)");
      said.length = 0;
      gh.issues.get(5)!.state = "In Progress";
      gh.issues.get(5)!.claim = encodeClaim("w@h", NOW);
      run(["next"], ctx);
      expect(said.join("")).toBe("queue empty — epic #1 is being worked (child #5 claimed by w@h)\n");
      said.length = 0;
      run(["next", "--json"], ctx);
      const parsed = JSON.parse(said.join(""));
      expect(parsed.diagnosis).toBe("epic-in-flight");
      expect(parsed.inFlightEpics).toEqual([{ root: 1, child: 5, holder: "w@h" }]);
    } finally {
      spy.mockRestore();
    }
  });

  it("priority inheritance end-to-end: a P0 epic's plain leaf outranks P1 flat work through run()", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    gh.issues.set(1, { number: 1, state: "Backlog", priority: "P0" });
    gh.issues.set(5, { number: 5, state: "Backlog", parent: 1 });
    gh.issues.set(2, { number: 2, state: "Backlog", priority: "P1" });
    const said: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((s) => {
      said.push(String(s));
      return true;
    });
    try {
      run(["next", "--json"], ctx);
    } finally {
      spy.mockRestore();
    }
    const parsed = JSON.parse(said.join(""));
    expect(parsed.next.number).toBe(5); // inherited P0 beats the flat P1
    expect(parsed.next.via).toBe(1);
    expect(parsed.queue.map((i: any) => i.number)).toEqual([5, 2]);
  });

  it("a foreign-repo parent never rebuilds a tree edge onto the own repo's number", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    gh.issues.set(1, { number: 1, state: "Backlog" }); // own #1, NOT the parent
    gh.issues.set(5, { number: 5, state: "Backlog", parent: 1, parentRepo: "other/repo" });
    const items = listItems(ctx);
    expect(items.find((i) => i.number === 5)?.parentNumber).toBeNull();
    expect(items.find((i) => i.number === 5)?.hasParent).toBe(true);
    const { eligible } = rankNext(items);
    // #1 must rank as a plain item, not as #5's epic root.
    expect(eligible.map((i) => i.number)).toEqual([5, 1]);
    expect(eligible.every((i) => i.via === undefined)).toBe(true);
  });
});

describe("LEGACY_STATES", () => {
  it("names exactly the 5 removed v1 states, none of them a v2 state", () => {
    expect(LEGACY_STATES).toEqual([
      "Research Needed",
      "Research in Progress",
      "Ready for Plan",
      "Plan in Progress",
      "Plan in Review",
    ]);
    for (const s of LEGACY_STATES) expect(isState(s)).toBe(false);
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

  // GH-1826 — `--accept`/`--reject` were absent from the boolean list, so the
  // form `board help` prints swallowed the `-m` and then refused for want of it.
  it("resolve parses identically in both documented flag orders", () => {
    const after = parseArgs(["1777", "--reject", "-m", "not delivered"]);
    const before = parseArgs(["1777", "-m", "not delivered", "--reject"]);
    expect(after.flags).toEqual({ reject: true, m: "not delivered" });
    expect(after).toEqual(before);
    expect(parseArgs(["1777", "--accept", "-m", "yes"]).flags).toEqual({ accept: true, m: "yes" });
  });

  it("a flag never swallows another flag as its value", () => {
    // Structural half of the fix: undeclared flags cannot eat `-m` either.
    expect(parseArgs(["--unknown", "-m", "x"]).flags).toEqual({ unknown: true, m: "x" });
    // A negative number is still a value, not a flag.
    expect(parseArgs(["--limit", "-5"]).flags).toEqual({ limit: "-5" });
  });

  it("every flag run() reads is declared with an arity", () => {
    // The list was deny-by-omission; this is the test that makes it a closed set.
    const src = readFileSync(new URL("./board.ts", import.meta.url), "utf8");
    const read = new Set<string>();
    for (const m of src.matchAll(/flags\.([a-zA-Z][a-zA-Z0-9]*)|flags\["([a-z-]+)"\]/g)) {
      read.add(m[1] ?? m[2]);
    }
    read.delete("m"); // `-m` is parsed by its own branch, not by the tables.
    const undeclared = [...read].filter((f) => !BOOLEAN_FLAGS.has(f) && !VALUE_FLAGS.has(f));
    expect(undeclared).toEqual([]);
  });

  it("there is no --force, by design", () => {
    expect(() => parseArgs(["12", "--force"])).toThrow(UsageError);
    expect(() => parseArgs(["12", "--force"])).toThrow(/no --force/);
  });
});

// A developer shell that exports RALPH_GQL_COST=1 would put EVERY ghGraphQL
// call in this suite into measurement mode — instrumented query text plus a
// stderr write — breaking assertions far from the one test that wants it.
// Clear the inherited value for the process; the measurement test opts in
// locally via vi.stubEnv and cleans up after itself.
delete process.env.RALPH_GQL_COST;

describe("failure diagnostics carry their context", () => {
  it("realExec surfaces the spawn error (gh missing must not report a blank reason)", () => {
    const r = realExec(["board-test-definitely-missing-cmd-7f3a"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/ENOENT|not found/);
  });

  it("ghGraphQL names unparseable stdout instead of a bare SyntaxError", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    ctx.exec = () => ok("<!DOCTYPE html><html>proxy says hi</html>");
    expect(() => ghGraphQL(ctx, "query { x }", {})).toThrow(/unparseable output.*DOCTYPE/);
  });

  it("RALPH_GQL_COST instruments queries, spares mutations, and strips the probe (GH-1801)", () => {
    expect(instrumentQuery("mutation($id: ID!) { updateX(id: $id) { ok } }").instrumented).toBe(
      false,
    );
    expect(instrumentQuery("subscription { onThing { id } }").instrumented).toBe(false);

    const q = instrumentQuery("query($n: Int!) {\n  repository(number: $n) { id }\n}");
    expect(q.instrumented).toBe(true);
    expect(q.query).toContain(`${COST_ALIAS}: rateLimit {`);
    // Injected INSIDE the operation's selection set, after the header brace.
    expect(q.query.indexOf(COST_ALIAS)).toBeGreaterThan(q.query.indexOf("$n: Int!"));
    expect(q.query).toContain("repository(number: $n)");

    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    ctx.exec = () =>
      ok(
        JSON.stringify({
          data: {
            repository: { id: "R1" },
            [COST_ALIAS]: { cost: 3, nodeCount: 301, used: 10, limit: 5000, remaining: 4990, resetAt: "2026-08-11T00:00:00Z" },
          },
        }),
      );
    vi.stubEnv("RALPH_GQL_COST", "1");
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const data = ghGraphQL(ctx, "query($n: Int!) { repository(number: $n) { id } }", { n: 1 });
      expect(data).toEqual({ repository: { id: "R1" } }); // probe stripped
      expect(err.mock.calls[0][0]).toMatch(/\[gql-cost\] repository cost=3 nodes=301/);
    } finally {
      err.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("instrumentQuery finds the SELECTION SET, not the first brace (GH-1801 review)", () => {
    // A variable default value carries its own braces. Splicing at the first
    // `{` would land inside the default and emit an invalid document.
    const dflt = instrumentQuery("query($f: Input = { state: OPEN }) { viewer { login } }");
    expect(dflt.instrumented).toBe(true);
    expect(dflt.query).toContain("$f: Input = { state: OPEN }"); // default intact
    expect(dflt.query.indexOf(COST_ALIAS)).toBeGreaterThan(dflt.query.indexOf("OPEN"));

    // Shorthand IS a query — it must be instrumented, not silently skipped.
    const short = instrumentQuery("{ viewer { login } }");
    expect(short.instrumented).toBe(true);
    expect(short.query).toContain(COST_ALIAS);

    // Leading comments precede the operation keyword.
    const commented = instrumentQuery("# fetch the viewer\nquery { viewer { login } }");
    expect(commented.instrumented).toBe(true);
    expect(commented.query).toContain(COST_ALIAS);

    // A `{` inside a string in the header must not be mistaken for the set.
    const str = instrumentQuery('query($s: String = "a { b") { viewer { login } }');
    expect(str.instrumented).toBe(true);
    expect(str.query).toContain('"a { b"');
    expect(str.query.indexOf(COST_ALIAS)).toBeGreaterThan(str.query.indexOf('"a { b"'));

    // Unreadable input leaves the query untouched rather than corrupting it.
    expect(instrumentQuery("query($f: Input = { oops").instrumented).toBe(false);
  });

  it("the probe is aliased, so a caller-requested rateLimit survives (GH-1801 review)", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    ctx.exec = () =>
      ok(
        JSON.stringify({
          data: {
            rateLimit: { cost: 99 }, // the CALLER's own selection
            [COST_ALIAS]: { cost: 1, nodeCount: 1, used: 1, limit: 5000, remaining: 4999, resetAt: "2026-08-11T00:00:00Z" },
          },
        }),
      );
    vi.stubEnv("RALPH_GQL_COST", "1");
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const data: any = ghGraphQL(ctx, "query { rateLimit { cost } }", {});
      expect(data.rateLimit).toEqual({ cost: 99 }); // caller's data preserved
      expect(data[COST_ALIAS]).toBeUndefined(); // only our alias removed
    } finally {
      err.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("loadConfig names the malformed config file as a UsageError (exit 64, not an anonymous crash)", () => {
    const root = mkdtempSync(join(tmpdir(), "board-cfg-"));
    writeFileSync(join(root, ".ralph.json"), "{ owner: oops,");
    expect(() => loadConfig(root)).toThrow(UsageError);
    expect(() => loadConfig(root)).toThrow(/\.ralph\.json is not valid JSON/);

    const root2 = mkdtempSync(join(tmpdir(), "board-cfg-"));
    mkdirSync(join(root2, ".claude"), { recursive: true });
    writeFileSync(join(root2, ".claude", "settings.json"), "not json");
    expect(() => loadConfig(root2)).toThrow(UsageError);
    expect(() => loadConfig(root2)).toThrow(/settings\.json is not valid JSON/);

    // "null" parses fine and then crashes on property access — same anonymous
    // exit-1 the helper exists to remove, so it must be rejected too.
    const root3 = mkdtempSync(join(tmpdir(), "board-cfg-"));
    writeFileSync(join(root3, ".ralph.json"), "null");
    expect(() => loadConfig(root3)).toThrow(UsageError);
    expect(() => loadConfig(root3)).toThrow(/expected a JSON object/);
  });

  it("loadConfig refuses a RALPH_CLAIM_HOLDER carrying ClaimV2 wire delimiters ('+' or '|')", () => {
    // A "build+deploy@ci" holder would serialize as TWO holders and fail its
    // own read-back membership verify — refuse at the door, naming the var.
    const root = mkdtempSync(join(tmpdir(), "board-cfg-holder-"));
    writeFileSync(join(root, ".ralph.json"), JSON.stringify({ owner: "o", repo: "r", projectNumber: 1 }));
    for (const bad of ["build+deploy@ci", "weird|host", ""]) {
      vi.stubEnv("RALPH_CLAIM_HOLDER", bad);
      try {
        expect(() => loadConfig(root), bad).toThrow(UsageError);
        expect(() => loadConfig(root), bad).toThrow(/RALPH_CLAIM_HOLDER/);
      } finally {
        vi.unstubAllEnvs();
      }
    }
    vi.stubEnv("RALPH_CLAIM_HOLDER", "tick@mbp");
    try {
      expect(loadConfig(root).holder).toBe("tick@mbp");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

// ---------------------------------------------------------------------------
// Command flows against a fake gh
// ---------------------------------------------------------------------------

import {
  FakeGh,
  makeCtx,
  NOW,
  ok,
  refusalMessage,
} from "./board.testkit.js";


describe("fetchIssue parentage (GH-1791)", () => {
  let gh: FakeGh;
  let ctx: Ctx;
  beforeEach(() => {
    gh = new FakeGh();
    ctx = makeCtx(gh);
  });

  it("reports parentNumber under the same name and rule the queue shapes use", () => {
    gh.issues.set(1, { number: 1, state: "Backlog", parent: 7 });
    const issue = fetchIssue(ctx, 1);
    expect(issue.parent?.number).toBe(7);
    expect(issue.parentNumber).toBe(7);
  });

  it("a foreign parent is null in parentNumber while `parent` still shows the edge", () => {
    gh.issues.set(1, { number: 1, state: "Backlog", parent: 7, parentRepo: "other/repo" });
    const issue = fetchIssue(ctx, 1);
    expect(issue.parent?.number).toBe(7);
    expect(issue.parentNumber).toBeNull();
  });

  it("parentNumber is present-and-null for a root, never an absent key", () => {
    gh.issues.set(1, { number: 1, state: "Backlog" });
    const issue = fetchIssue(ctx, 1);
    expect(Object.keys(issue)).toContain("parentNumber");
    expect(issue.parentNumber).toBeNull();
  });
});

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
    expect(after.claim?.holders).toEqual(["me@test"]);
    expect(after.claim?.since).toEqual(NOW);
  });

  it("refuses to mutate when the fieldValues page is truncated — state/claim reads are fiction", () => {
    // A claimed item whose Claim value fell past the page window reads as
    // unclaimed; without the fail-closed check this would double-claim it.
    gh.issues.set(1, { number: 1, state: null, fieldValuesTruncated: true });
    expect(() => transition(ctx, fetchIssue(ctx, 1), "In Progress")).toThrow(RefusalError);
    expect(() => transition(ctx, fetchIssue(ctx, 1), "In Progress")).toThrow(/field values/);
    expect(gh.mutations).toEqual([]); // refused before any write
  });

  it("a fieldValues-truncated item is never eligible in the queue (fail closed like blockers)", () => {
    gh.issues.set(1, { number: 1, state: "Backlog", fieldValuesTruncated: true });
    gh.issues.set(2, { number: 2, state: "Backlog" });
    const { eligible, blocked } = rankNext(listItems(ctx));
    expect(eligible.map((i) => i.number)).toEqual([2]);
    expect(blocked.map((i) => i.number)).toEqual([1]);
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

  it("a fresh foreign claim's refusal carries no expiry hint (racing a live holder is healthy)", () => {
    gh.issues.set(1, {
      number: 1, state: "Backlog",
      claim: encodeClaim("other@host", new Date(NOW.getTime() - 30 * 60_000)),
    });
    const msg = refusalMessage(() => transition(ctx, fetchIssue(ctx, 1), "In Progress"));
    expect(msg).toBe(
      "#1 is claimed by other@host (30 min ago, TTL 120 min). " +
        "Pick other work, or wait for TTL and use `board claim 1 --steal`.",
    );
  });

  it("exactly 75% elapsed is still hint-free — the threshold is strictly greater", () => {
    gh.issues.set(1, {
      number: 1, state: "Backlog",
      claim: encodeClaim("other@host", new Date(NOW.getTime() - 90 * 60_000)),
    });
    const msg = refusalMessage(() => transition(ctx, fetchIssue(ctx, 1), "In Progress"));
    expect(msg).not.toContain("expires");
    expect(msg.split("\n")).toHaveLength(1);
  });

  it("late in the TTL, the refusal appends ONE line naming the expiry clock time", () => {
    const since = new Date(NOW.getTime() - 100 * 60_000);
    gh.issues.set(1, { number: 1, state: "Backlog", claim: encodeClaim("other@host", since) });
    const msg = refusalMessage(() => transition(ctx, fetchIssue(ctx, 1), "In Progress"));
    const lines = msg.split("\n");
    expect(lines).toHaveLength(2);
    // Line 1 is byte-identical to the un-hinted refusal.
    expect(lines[0]).toBe(
      "#1 is claimed by other@host (100 min ago, TTL 120 min). " +
        "Pick other work, or wait for TTL and use `board claim 1 --steal`.",
    );
    expect(lines[1]).toBe(
      `That claim expires ~${formatLocalHm(new Date(since.getTime() + 120 * 60_000))} — ` +
        "`board claim 1 --steal` is honest after that.",
    );
    expect(gh.mutations).toEqual([]); // still refused before any write
  });

  it("the hint rides an unchanged refusal: still RefusalError (exit 2), still no writes", () => {
    gh.issues.set(1, {
      number: 1, state: "Backlog",
      claim: encodeClaim("other@host", new Date(NOW.getTime() - 110 * 60_000)),
    });
    expect(() => transition(ctx, fetchIssue(ctx, 1), "In Progress")).toThrow(RefusalError);
    expect(gh.mutations).toEqual([]);
  });

  it("stale foreign claim: refused without --steal, evicted with it (comment posted)", () => {
    gh.issues.set(1, {
      number: 1, state: "Backlog",
      claim: encodeClaim("other@host", new Date(NOW.getTime() - 300 * 60_000)),
    });
    expect(() => transition(ctx, fetchIssue(ctx, 1), "In Progress")).toThrow(/--steal/);
    const after = transition(ctx, fetchIssue(ctx, 1), "In Progress", { steal: true });
    expect(gh.comments.some((c) => c.body.includes("evicted"))).toBe(true);
    expect(after.claim?.holders).toEqual(["me@test"]);
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
    expect(() => transition(ctx, fetchIssue(ctx, 1), "In Review")).toThrow(
      /Legal: In Progress, Done, Canceled/,
    );
    expect(gh.mutations).toEqual([]);
  });

  it("legacy states are frozen — the fix is a hand edit in the board UI", () => {
    gh.issues.set(1, { number: 1, state: "Ready for Plan" });
    expect(() => transition(ctx, fetchIssue(ctx, 1), "In Progress")).toThrow(
      /legacy state "Ready for Plan".*board UI/,
    );
    // The deleted subcommand must not survive in the guidance.
    expect(() => transition(ctx, fetchIssue(ctx, 1), "In Progress")).not.toThrow(/migrate/);
  });

  it("Human Needed requires --why and posts it as the escalation comment", () => {
    gh.issues.set(1, { number: 1, state: "In Progress", claim: encodeClaim("me@test", NOW) });
    expect(() => transition(ctx, fetchIssue(ctx, 1), "Human Needed")).toThrow(UsageError);
    transition(ctx, fetchIssue(ctx, 1), "Human Needed", { why: "need a decision on X" });
    expect(gh.comments.some((c) => c.body.includes("need a decision on X"))).toBe(true);
  });

  // GH-2078: backward moves are exceptional, not routine — the reason is
  // machine-required and lands as a comment, so demotions are auditable.
  it("In Progress → Backlog requires --why and posts it as the parking comment", () => {
    gh.issues.set(1, { number: 1, state: "In Progress", claim: encodeClaim("me@test", NOW) });
    expect(() => transition(ctx, fetchIssue(ctx, 1), "Backlog")).toThrow(UsageError);
    expect(() => transition(ctx, fetchIssue(ctx, 1), "Backlog")).toThrow(/board release 1 -m/);
    expect(gh.mutations).toEqual([]); // refused before any write
    const after = transition(ctx, fetchIssue(ctx, 1), "Backlog", { why: "tests red on X; next: fix parser" });
    expect(after.state).toBe("Backlog");
    expect(gh.comments.some((c) => c.body.includes("**Parked**") && c.body.includes("tests red on X"))).toBe(true);
  });

  it("In Review → In Progress requires --why and posts it as the demotion comment", () => {
    gh.issues.set(1, { number: 1, state: "In Review" });
    expect(() => transition(ctx, fetchIssue(ctx, 1), "In Progress")).toThrow(UsageError);
    expect(() => transition(ctx, fetchIssue(ctx, 1), "In Progress")).toThrow(/board claim 1 --why/);
    expect(gh.mutations).toEqual([]); // refused before any write
    const after = transition(ctx, fetchIssue(ctx, 1), "In Progress", { why: "review found P0: races on the cache key" });
    expect(after.state).toBe("In Progress");
    expect(gh.comments.some((c) => c.body.includes("**Demoted for rework**") && c.body.includes("races on the cache key"))).toBe(true);
  });

  it("answer's resume (Human Needed → In Progress) needs no --why — it is not a demotion", () => {
    gh.issues.set(1, { number: 1, state: "Human Needed" });
    const after = transition(ctx, fetchIssue(ctx, 1), "In Progress");
    expect(after.state).toBe("In Progress");
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

  it("Done accepts a merged PR reaching the issue through the branch convention (GH-1732)", () => {
    // No closing reference at all — exactly the population deliver's
    // no-open-pr close-out serves, and which used to need --why.
    gh.issues.set(1, { number: 1, state: "In Review", branchPrs: [{ number: 101, merged: true }] });
    const after = transition(ctx, fetchIssue(ctx, 1), "Done");
    expect(after.state).toBe("Done");
    expect(gh.comments).toEqual([]); // evidence, not an unevidenced completion
  });

  it("a merged PR on a branch that merely PREFIXES the digits is not linkage (GH-1996)", () => {
    // `head:` is a prefix match, so search itself returns `feat/10-…` for #1.
    // parseBranchName is what rejects it — the same re-validation the old
    // substring read needed, for the same reason.
    gh.issues.set(1, {
      number: 1,
      state: "In Review",
      branchRefs: [{ name: "feat/10-unrelated-work", prs: [{ number: 101, merged: true }] }],
    });
    expect(() => transition(ctx, fetchIssue(ctx, 1), "Done")).toThrow(/merged linked PR/);
    expect(gh.mutations).toEqual([]);
  });

  it("the linkage read survives a head branch deleted at merge (GH-1996)", () => {
    // The defect: merge-pr.sh deletes the head ref, so a refs-rooted read
    // found nothing for the whole population this gate exists to serve.
    // Search's `head:` qualifier is what survives the deletion.
    gh.issues.set(1, {
      number: 1,
      state: "In Review",
      branchRefs: [{ name: "fix/1-a-deleted-branch", prs: [{ number: 101, merged: true }] }],
    });
    expect(transition(ctx, fetchIssue(ctx, 1), "Done").state).toBe("Done");
    const q = gh.queries.find((s) => s.includes("search(type: ISSUE"))!;
    expect(q).toBeDefined();
    expect(q).not.toContain("refs(refPrefix");
    // One qualifier per grammar: every live kind, plus the legacy shape.
    for (const kind of BRANCH_KIND_CHARS) {
      expect(gh.lastSearchQuery).toContain(`head:${kind}/1`);
    }
    expect(gh.lastSearchQuery).toContain("head:feature/GH-1");
    expect(gh.lastSearchQuery).toContain("is:merged");
  });

  it("an unmerged PR on the convention branch is not evidence", () => {
    gh.issues.set(1, { number: 1, state: "In Review", branchPrs: [{ number: 101, merged: false }] });
    expect(() => transition(ctx, fetchIssue(ctx, 1), "Done")).toThrow(/merged linked PR/);
  });

  it("an unreadable branch-linkage read refuses — it may never manufacture evidence", () => {
    gh.issues.set(1, { number: 1, state: "In Review", branchPrs: [{ number: 101, merged: true }] });
    gh.failBranchLinkage = true;
    expect(() => transition(ctx, fetchIssue(ctx, 1), "Done")).toThrow(/merged linked PR/);
    expect(gh.mutations).toEqual([]);
  });

  it("the branch-linkage read is not made when the closing reference already answers", () => {
    gh.issues.set(1, { number: 1, state: "In Review", prs: [{ number: 101, merged: true }] });
    const referenced = fetchIssue(ctx, 1);
    const a = gh.graphqlCalls;
    transition(ctx, referenced, "Done");
    const referencedCost = gh.graphqlCalls - a;

    gh.issues.set(2, { number: 2, state: "In Review", branchPrs: [{ number: 102, merged: true }] });
    const conventional = fetchIssue(ctx, 2);
    const b = gh.graphqlCalls;
    transition(ctx, conventional, "Done");
    expect(gh.graphqlCalls - b).toBe(referencedCost + 1);
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
    expect(after.claim?.holders).toEqual(["me@test"]);

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
    expect(after.claim?.holders).toEqual(["me@test"]);
    expect(gh.mutations).toContain("setClaim(#1)");
  });
});

describe("fieldValues truncation fails closed on every write path", () => {
  it("transition: a truncated POST-write echo says 'unverifiable', never a fictional race narrative", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    gh.issues.set(1, { number: 1, state: "Backlog" });
    const inner = gh.exec;
    ctx.exec = (argv, stdin) => {
      const r = inner(argv, stdin);
      // The write itself pushes the item past the page: every read AFTER the
      // first field write comes back truncated.
      if (stdin?.includes("updateProjectV2ItemFieldValue")) gh.issues.get(1)!.fieldValuesTruncated = true;
      return r;
    };
    expect(() => transition(ctx, fetchIssue(ctx, 1), "In Progress")).toThrow(RefusalError);
    gh.issues.get(1)!.fieldValuesTruncated = false;
    gh.issues.get(1)!.state = "Backlog";
    gh.issues.get(1)!.claim = null;
    const msg = refusalMessage(() => transition(ctx, fetchIssue(ctx, 1), "In Progress"));
    expect(msg).toMatch(/unverifiable/);
    expect(msg).not.toMatch(/vanished|lost/);
  });

  it("reconcile: refuses to 'correct' a state it cannot read (the cron would demote live WIP every tick)", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    gh.issues.set(1, { number: 1, state: null, fieldValuesTruncated: true });
    expect(reconcile(ctx, 1)).toMatch(/field values truncated.*refusing to reconcile/);
    expect(gh.mutations).toEqual([]);
  });

  it("adopt: never writes Backlog over an on-board item's unreadable state", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    gh.issues.set(1, { number: 1, state: null, fieldValuesTruncated: true });
    adopt(ctx, 1);
    expect(gh.mutations.filter((m) => m.startsWith("setState"))).toEqual([]);
  });

  it("adopt: a fresh OFF-board item still gets added and set to Backlog — a never-added item has no field values to truncate", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    gh.issues.set(1, { number: 1, state: null, onBoard: false });
    adopt(ctx, 1);
    expect(gh.mutations).toContain("addToBoard(#1)");
    expect(gh.mutations.filter((m) => m.startsWith("setState"))).toEqual(["setState(#1, Backlog)"]);
  });

  it("parentCheck: refuses to gate on a parent whose field values are truncated", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    gh.issues.set(10, {
      number: 10, state: "In Progress", fieldValuesTruncated: true,
      children: [{ number: 11, issueState: "CLOSED", state: "Done" }],
    });
    expect(parentCheck(ctx, 10)).toMatch(/field values truncated.*refusing to gate/);
    expect(gh.mutations).toEqual([]);
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

  describe("create is retry-safe (GH-1973)", () => {
    it("a caller retry adopts its own recent twin instead of filing a duplicate", () => {
      const gh = new FakeGh();
      const ctx = makeCtx(gh);
      const first = createIssue(ctx, { title: "same title", state: "Intake" });
      const second = createIssue(ctx, { title: "same title", state: "Intake" });
      expect(second.number).toBe(first.number);
      expect(gh.createdIssues.length).toBe(1);
    });

    it("a lost mutation response is read back, not reported as a failure", () => {
      const gh = new FakeGh();
      const ctx = makeCtx(gh);
      gh.loseCreateResponse = true;
      const issue = createIssue(ctx, { title: "lost response", state: "Intake" });
      expect(gh.createdIssues.length).toBe(1);
      expect(issue.number).toBe(gh.createdIssues[0].number);
    });

    it("a lost response with no readable twin says the write MAY have landed", () => {
      const gh = new FakeGh();
      const ctx = makeCtx(gh);
      gh.loseCreateResponse = true;
      gh.failTwinSearch = true;
      expect(() => createIssue(ctx, { title: "unknowable", state: "Intake" })).toThrow(/may or may not have been created/);
    });

    it("a foreign author's identical title is never adopted", () => {
      const gh = new FakeGh();
      const ctx = makeCtx(gh);
      createIssue(ctx, { title: "shared title", state: "Intake" });
      gh.createdIssues[0].author = { login: "someone-else" };
      const mine = createIssue(ctx, { title: "shared title", state: "Intake" });
      expect(gh.createdIssues.length).toBe(2);
      expect(mine.number).not.toBe(gh.createdIssues[0].number);
    });

    it("an out-of-window twin is not adopted — the guard is bounded, not a title lock", () => {
      const gh = new FakeGh();
      const ctx = makeCtx(gh);
      createIssue(ctx, { title: "old title", state: "Intake" });
      gh.createdIssues[0].createdAt = new Date(Date.now() - 3600_000).toISOString();
      createIssue(ctx, { title: "old title", state: "Intake" });
      expect(gh.createdIssues.length).toBe(2);
    });

    it("--allow-duplicate files anyway", () => {
      const gh = new FakeGh();
      const ctx = makeCtx(gh);
      createIssue(ctx, { title: "on purpose", state: "Intake" });
      createIssue(ctx, { title: "on purpose", allowDuplicate: true, state: "Intake" });
      expect(gh.createdIssues.length).toBe(2);
    });

    it("an unreadable duplicate check warns and files — intake survives the outage", () => {
      const gh = new FakeGh();
      const ctx = makeCtx(gh);
      gh.failTwinSearch = true;
      const issue = createIssue(ctx, { title: "during a flap", state: "Intake" });
      expect(issue.number).toBe(gh.createdIssues[0].number);
    });
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

  it("reconcile: leaves legacy states alone, reports no-drift honestly", () => {
    gh.issues.set(1, { number: 1, state: "Ready for Plan", issueState: "OPEN" });
    expect(reconcile(ctx, 1)).toMatch(/legacy state "Ready for Plan".*board UI/);
    expect(reconcile(ctx, 1)).not.toMatch(/migrate/);
    gh.issues.set(2, { number: 2, state: "In Progress" });
    expect(reconcile(ctx, 2)).toMatch(/no drift/);
  });
});

describe("fetchNodeIds (link/dep/comment id lookups)", () => {
  it("dep/link resolve both ids in ONE aliased id-only query, then mutate", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    gh.issues.set(12, { number: 12, state: "Backlog" });
    gh.issues.set(13, { number: 13, state: "Backlog" });
    let idQueries = 0;
    const inner = gh.exec;
    ctx.exec = (argv, stdin) => {
      if (stdin?.includes("a0: issue(number") && !stdin.includes("comments(last")) {
        idQueries++;
        expect(stdin).not.toMatch(/subIssues|blockedBy\(|fieldValues/); // id-only payload
      }
      return inner(argv, stdin);
    };
    expect(run(["dep", "12", "--on", "13"], ctx)).toBe(0);
    expect(idQueries).toBe(1);
    expect(gh.mutations).toEqual(["dep"]);
  });

  it("a missing issue keeps fetchIssue's contract: UsageError naming the repo (exit 64)", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    gh.issues.set(12, { number: 12, state: "Backlog" });
    expect(() => setDependency(ctx, 12, 999)).toThrow(UsageError);
    expect(() => setDependency(ctx, 12, 999)).toThrow(/cdubiel08\/ralph-hero/);
    expect(gh.mutations).toEqual([]); // refused before the mutation
  });
});

// ---------------------------------------------------------------------------
// Doctor's heartbeat line (GH-1909) — registration is half the predicate.
// ---------------------------------------------------------------------------

describe("doctor heartbeat — registered-but-dead is the only alarm (GH-1909)", () => {
  /** Runs doctor with a heartbeat of the given age (null = no file) and a
   *  faked install-loop.sh verdict (null = the probe could not run). */
  const line = (ageMin: number | null, registered: boolean | null) => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    const home = mkdtempSync(join(tmpdir(), "ralph-hb-"));
    if (ageMin !== null) {
      const secs = Math.round((ctx.now().getTime() - ageMin * 60_000) / 1000);
      writeFileSync(join(home, "heartbeat"), `${secs}\n`);
    }
    const inner = ctx.exec;
    ctx.exec = (argv, stdin) => {
      if (argv.includes("--status")) {
        if (registered === null) return { code: 127, stdout: "", stderr: "boom" };
        return registered
          ? { code: 0, stdout: "loop: registered (launchd com.ralph.tick, every 15m)\n", stderr: "" }
          : { code: 1, stdout: "loop: not registered (no plist)\n", stderr: "" };
      }
      return inner(argv, stdin);
    };
    vi.stubEnv("RALPH_HOME", home);
    vi.stubEnv("RALPH_INSTALL_LOOP_SH", join(home, "install-loop.sh"));
    writeFileSync(join(home, "install-loop.sh"), "#!/bin/sh\n"); // must exist to be probed
    try {
      return doctor(ctx).checks.find((c) => c.name === "heartbeat")!;
    } finally {
      vi.unstubAllEnvs();
    }
  };

  it("no scheduler registered: absent is ok, and a stale leftover is info — never a warning", () => {
    expect(line(null, false).level).toBe("ok");
    const leftover = line(20_144, false);
    expect(leftover.level).toBe("info"); // the observed 14-day cutover leftover
    expect(leftover.detail).toMatch(/leftover/);
    expect(line(5, false).level).toBe("ok"); // a manual tick just ran
  });

  it("scheduler registered: fresh is ok, stale is the alarm, never-fired warns", () => {
    expect(line(5, true).level).toBe("ok");
    const dead = line(20_144, true);
    expect(dead.level).toBe("warn");
    expect(dead.detail).toMatch(/registered but not firing/);
    expect(line(null, true).level).toBe("warn");
  });

  it("an unusable registration probe degrades to the age-only reading, fail-closed", () => {
    expect(line(20_144, null).level).toBe("warn");
    expect(line(20_144, null).detail).toMatch(/not evaluated/);
    expect(line(null, null).level).toBe("ok");
  });
});

describe("doctor (legacy states, archived items)", () => {
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

  it("doctor: a red state-guard window fails outside the workflow, warns inside it (GH-1722)", () => {
    // The reconciler lane's exit code becomes the next window's newest entry:
    // a hard fail on own-history would re-poison the window every cron tick
    // and could never self-heal after an outage.
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    gh.runListJson = JSON.stringify([
      { conclusion: "failure", updatedAt: "2026-08-08T00:00:00Z" },
      { conclusion: "success", updatedAt: "2026-08-07T23:45:00Z" },
    ]);

    const prev = process.env.GITHUB_WORKFLOW;
    try {
      delete process.env.GITHUB_WORKFLOW;
      const outside = doctor(ctx);
      expect(outside.ok).toBe(false);
      expect(outside.checks.find((c) => c.name === "state-guard")?.level).toBe("fail");

      process.env.GITHUB_WORKFLOW = "state-guard";
      const inside = doctor(ctx);
      expect(inside.ok).toBe(true);
      const check = inside.checks.find((c) => c.name === "state-guard");
      expect(check?.level).toBe("warn");
      expect(check?.detail).toMatch(/self-run/);
    } finally {
      if (prev === undefined) delete process.env.GITHUB_WORKFLOW;
      else process.env.GITHUB_WORKFLOW = prev;
    }
  });

  it("doctor: the state-guard check is pinned to the CONFIGURED repo with -R (never cwd's repo)", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    let runListArgv: string[] | null = null;
    const inner = ctx.exec;
    ctx.exec = (argv, stdin) => {
      if (argv[0] === "gh" && argv[1] === "run" && argv[2] === "list") runListArgv = argv;
      return inner(argv, stdin);
    };
    doctor(ctx);
    expect(runListArgv).not.toBeNull();
    const argv: string[] = runListArgv!;
    expect(argv.slice(argv.indexOf("-R"), argv.indexOf("-R") + 2)).toEqual([
      "-R",
      "github.com/cdubiel08/ralph-hero",
    ]);
  });

  it("doctor: a green state-guard window is ok even inside the workflow", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    gh.runListJson = JSON.stringify([{ conclusion: "success", updatedAt: "2026-08-08T00:00:00Z" }]);
    const prev = process.env.GITHUB_WORKFLOW;
    try {
      process.env.GITHUB_WORKFLOW = "state-guard";
      const report = doctor(ctx);
      expect(report.checks.find((c) => c.name === "state-guard")?.level).toBe("ok");
    } finally {
      if (prev === undefined) delete process.env.GITHUB_WORKFLOW;
      else process.env.GITHUB_WORKFLOW = prev;
    }
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

  it("archived items are invisible to list/next — they cannot be written", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    gh.issues.set(1, { number: 1, state: "Backlog", archived: true });
    gh.issues.set(2, { number: 2, state: "Backlog" });
    const numbers = listItems(ctx).map((i) => i.number);
    expect(numbers).toContain(2);
    expect(numbers).not.toContain(1);
    // next ranks off the same page, so it inherits the exclusion.
    const eligible = rankNext(listItemsFull(ctx).open).eligible.map((i) => i.number);
    expect(eligible).toContain(2);
    expect(eligible).not.toContain(1);
  });

  it("direct mutations refuse archived items with a clean message, not a raw API error", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    gh.issues.set(1, { number: 1, state: "Backlog", archived: true });
    expect(() => transition(ctx, fetchIssue(ctx, 1), "In Progress")).toThrow(/ARCHIVED.*Unarchive/);
    expect(reconcile(ctx, 1)).toMatch(/archived — skipped/);
  });

});

describe("bounded queue read (GH-1785) — listOwnOpenItems", () => {
  let gh: FakeGh;
  let ctx: Ctx;
  beforeEach(() => {
    gh = new FakeGh();
    ctx = makeCtx(gh);
  });

  it("agrees with the project scan on every own-repo open item", () => {
    gh.issues.set(1, { number: 1, state: "Backlog", priority: "P1", estimate: "S", labels: ["x"] });
    gh.issues.set(2, {
      number: 2, state: "In Progress", claim: encodeClaim("a@h", NOW), parent: 1,
      blockedBy: [{ number: 3, state: "OPEN" }, { number: 4, state: "CLOSED" }],
    });
    gh.issues.set(3, { number: 3, state: "Backlog" });

    expect(listOwnOpenItems(ctx)).toEqual(ownRepo(ctx, listItems(ctx)).own);
  });

  it("excludes closed, archived, off-board, and foreign items", () => {
    gh.issues.set(1, { number: 1, state: "Backlog" });
    gh.issues.set(2, { number: 2, state: "Done", issueState: "CLOSED", stateReason: "COMPLETED" });
    gh.issues.set(3, { number: 3, state: "Backlog", archived: true });
    gh.issues.set(4, { number: 4, state: null, onBoard: false });
    gh.issues.set(5, { number: 5, state: "Backlog", repo: "other/repo" });

    expect(listOwnOpenItems(ctx).map((i) => i.number)).toEqual([1]);
  });

  it("costs one page per 100 open issues, not one per 100 project items", () => {
    for (let n = 1; n <= 5; n++) gh.issues.set(n, { number: n, state: "Backlog" });
    for (let n = 6; n <= 60; n++)
      gh.issues.set(n, { number: n, state: "Done", issueState: "CLOSED", stateReason: "COMPLETED" });
    gh.itemsPageSize = 10;

    // 5 open issues → a single page; the project scan walks all 60 items.
    const before = gh.graphqlCalls;
    expect(listOwnOpenItems(ctx).map((i) => i.number)).toEqual([1, 2, 3, 4, 5]);
    const bounded = gh.graphqlCalls - before;
    const scanStart = gh.graphqlCalls;
    listItemsFull(ctx);
    expect(bounded).toBeLessThan(gh.graphqlCalls - scanStart);
  });

  it("walks the cursor when open issues exceed one page", () => {
    for (let n = 1; n <= 25; n++) gh.issues.set(n, { number: n, state: "Backlog" });
    gh.itemsPageSize = 10;
    expect(listOwnOpenItems(ctx)).toHaveLength(25);
  });

  it("fails closed when an issue's project membership is truncated", () => {
    gh.issues.set(1, { number: 1, state: null, onBoard: false, projectItemsTruncated: true });
    expect(() => listOwnOpenItems(ctx)).toThrow(/#1.*project membership truncated/);
  });

  it("fails closed on corrupt pagination metadata rather than returning a partial board", () => {
    gh.issues.set(1, { number: 1, state: "Backlog" });

    gh.dropPageInfo = true; // absent pageInfo would read as "last page"
    expect(() => listOwnOpenItems(ctx)).toThrow(/pagination metadata missing/);
    expect(() => listItemsFull(ctx)).toThrow(/pagination metadata missing/);

    gh.dropPageInfo = false;
    gh.dropEndCursor = true; // hasNextPage with no cursor would loop forever
    expect(() => listOwnOpenItems(ctx)).toThrow(/no cursor to fetch them/);
    expect(() => listItemsFull(ctx)).toThrow(/no cursor to fetch them/);
  });

  describe("a cursor that drops a live item (GH-1896)", () => {
    beforeEach(() => {
      for (let n = 1; n <= 5; n++) gh.issues.set(n, { number: n, state: "Backlog" });
      gh.itemsPageSize = 2;
    });

    it("retries once, and serves the retry when the drop was transient", () => {
      gh.cursorDrops = new Set([3]);
      gh.cursorDropWalks = 1; // the second walk sees a healthy cursor
      expect(listItemsFull(ctx, QUEUE_SELECT_MINIMAL).open.map((i) => i.number)).toEqual([1, 2, 3, 4, 5]);
      expect(gh.itemWalks).toBe(2);
    });

    it("raises rather than serving a short board when the drop persists", () => {
      gh.cursorDrops = new Set([3]);
      expect(() => listItemsFull(ctx, QUEUE_SELECT_MINIMAL)).toThrow(/returned 4 of 5 items/);
    });

    it("stays silent on a complete walk", () => {
      expect(listItemsFull(ctx, QUEUE_SELECT_MINIMAL).open).toHaveLength(5);
    });
  });

  describe("through the CLI", () => {
    const capture = (argv: string[]) => {
      const said: string[] = [];
      const spy = vi.spyOn(process.stdout, "write").mockImplementation((s) => {
        said.push(String(s));
        return true;
      });
      try {
        run(argv, ctx);
      } finally {
        spy.mockRestore();
      }
      return said.join("");
    };

    beforeEach(() => {
      gh.issues.set(1, { number: 1, state: "Backlog" });
      gh.issues.set(2, { number: 2, state: "In Review" });
      gh.issues.set(3, { number: 3, state: "Backlog", repo: "other/repo" });
    });

    it("default mode lists own-repo items, filters by state, and says foreign items went unread", () => {
      const text = capture(["list"]);
      expect(text).toContain("#1 [Backlog]");
      expect(text).toContain("#2 [In Review]");
      expect(text).not.toContain("other/repo#3");
      expect(text).toContain("foreign board items not read");

      expect(capture(["list", "--state", "backlog"])).toContain("#1 [Backlog]");
      expect(capture(["list", "--state", "backlog"])).not.toContain("#2 [In Review]");
    });

    it("--json reports foreignEvaluated so \"not read\" cannot be mistaken for \"none there\"", () => {
      const bounded = JSON.parse(capture(["list", "--json"]));
      expect(bounded.foreignEvaluated).toBe(false);
      expect(bounded.foreign).toEqual([]);
      expect(bounded.items.map((i: any) => i.number)).toEqual([1, 2]);

      const full = JSON.parse(capture(["list", "--all-repos", "--json"]));
      expect(full.foreignEvaluated).toBe(true);
      expect(full.foreign.map((f: any) => f.number)).toEqual([3]);
      expect(full.items.map((i: any) => i.number)).toEqual([1, 2]);
    });

    it("--all-repos enumerates foreign items and drops the limitation notice", () => {
      const text = capture(["list", "--all-repos"]);
      expect(text).toContain("other/repo#3 [Backlog] (foreign repo — read-only here)");
      expect(text).not.toContain("foreign board items not read");
    });
  });
});

describe("lean query selection (GH-1803)", () => {
  let gh: FakeGh;
  let ctx: Ctx;
  beforeEach(() => {
    gh = new FakeGh();
    ctx = makeCtx(gh);
  });

  /** The walk's own documents — the deliver lane's per-issue detail fetch has
   *  its own shape and is not what this issue is about. */
  const walkQueries = () =>
    gh.queries.filter(
      (q) => q.includes("items(first: 100") || q.includes("issues(states: OPEN, first: 100"),
    );
  const capture = (argv: string[]) => {
    const said: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((s) => {
      said.push(String(s));
      return true;
    });
    try {
      run(argv, ctx);
    } finally {
      spy.mockRestore();
    }
    return said.join("");
  };

  const seed = () => {
    gh.issues.set(1, {
      number: 1,
      state: "Backlog",
      labels: ["ralph:apply"],
      blockedBy: [{ number: 9, state: "OPEN" }],
    });
    gh.issues.set(2, { number: 2, state: "Backlog" });
  };

  it("the default read is unchanged: both connections in the document, both groups on the item", () => {
    seed();
    const [item] = listItemsFull(ctx).open;
    expect(walkQueries().every((q) => q.includes("labels(first:") && q.includes("blockedBy(first:"))).toBe(true);
    expect(item.labels).toEqual(["ralph:apply"]);
    expect(item.labelsTruncated).toBe(false);
    expect(item.openBlockers).toEqual([9]);
    expect(item.blockersTruncated).toBe(false);
  });

  it("QUEUE_SELECT_NO_LABELS drops `labels` from the DOCUMENT — where the point is charged", () => {
    seed();
    listItemsFull(ctx, QUEUE_SELECT_NO_LABELS);
    expect(walkQueries()).not.toHaveLength(0);
    for (const q of walkQueries()) {
      expect(q).not.toContain("labels(first:");
      expect(q).toContain("blockedBy(first:"); // still charged, still needed
    }
  });

  it("QUEUE_SELECT_MINIMAL drops both — the 1-point floor", () => {
    seed();
    listItemsFull(ctx, QUEUE_SELECT_MINIMAL);
    for (const q of walkQueries()) {
      expect(q).not.toContain("labels(first:");
      expect(q).not.toContain("blockedBy(first:");
    }
  });

  it("an unselected group is ABSENT, never an empty list with a false truncation flag", () => {
    seed();
    const [item] = listItemsFull(ctx, QUEUE_SELECT_MINIMAL).open;
    // The whole safety argument: `blockersTruncated: false` is GitHub saying
    // "the list was complete". A read that never asked must not say it.
    expect("labels" in item).toBe(false);
    expect("labelsTruncated" in item).toBe(false);
    expect("openBlockers" in item).toBe(false);
    expect("blockersTruncated" in item).toBe(false);
    expect("closedBlockers" in item).toBe(false);
    expect("openBlockerLabels" in item).toBe(false);
    // …and it survives the JSON boundary as absence, not as a fabricated false.
    const wire = JSON.parse(JSON.stringify(item));
    expect(Object.keys(wire)).not.toContain("labelsTruncated");
    expect(Object.keys(wire)).not.toContain("blockersTruncated");
    // Core facts are untouched — this is a cost change, not a data change.
    expect(wire.number).toBe(1);
    expect(wire.state).toBe("Backlog");
  });

  it("closed items lose the label group too when it was not selected", () => {
    gh.issues.set(1, {
      number: 1, state: "Done", issueState: "CLOSED", stateReason: "COMPLETED", labels: ["ralph:apply"],
    });
    const [full] = listItemsFull(ctx).closed;
    expect(full.labels).toEqual(["ralph:apply"]);
    const [lean] = listItemsFull(ctx, QUEUE_SELECT_NO_LABELS).closed;
    expect("labels" in lean).toBe(false);
    expect("labelsTruncated" in lean).toBe(false);
    expect(lean.stateReason).toBe("COMPLETED"); // core facts intact
  });

  it("ranking is identical either way — dropping labels changes cost, not answers", () => {
    gh.issues.set(1, { number: 1, state: "Backlog", priority: "P1", labels: ["x"] });
    gh.issues.set(2, { number: 2, state: "Backlog", priority: "P0" });
    gh.issues.set(3, { number: 3, state: "Backlog", blockedBy: [{ number: 1, state: "OPEN" }] });
    const rankOf = (sel?: typeof QUEUE_SELECT_NO_LABELS) => {
      const full = sel ? listItemsFull(ctx, sel) : listItemsFull(ctx);
      const r = rankNext(ownRepo(ctx, full.open).own, ownRepo(ctx, full.closed).own);
      return { eligible: r.eligible.map((i) => i.number), blocked: r.blocked.map((i) => i.number) };
    };
    expect(rankOf(QUEUE_SELECT_NO_LABELS)).toEqual(rankOf());
  });

  it("each lane asks for exactly what it reads", () => {
    seed();
    const walkFor = (argv: string[]) => {
      gh.queries.length = 0;
      capture(argv);
      const qs = walkQueries();
      expect(qs).not.toHaveLength(0);
      return {
        labels: qs.some((q) => q.includes("labels(first:")),
        blockers: qs.some((q) => q.includes("blockedBy(first:")),
      };
    };
    // ranking lanes: dependency edges yes, labels no
    expect(walkFor(["next", "--json"])).toEqual({ labels: false, blockers: true });
    expect(walkFor(["frontier", "--json"])).toEqual({ labels: false, blockers: true });
    expect(walkFor(["tend-queue", "--json"])).toEqual({ labels: false, blockers: true });
    // deliver filters on board state alone
    expect(walkFor(["deliver-queue", "--json"])).toEqual({ labels: false, blockers: false });
    // doctor's apply sweep reads both; `list --json` publishes both
    expect(walkFor(["doctor"])).toEqual({ labels: true, blockers: true });
    expect(walkFor(["list", "--all-repos", "--json"])).toEqual({ labels: true, blockers: true });
  });

  it("`next --json` rows omit the label fields rather than publishing empty ones", () => {
    seed();
    const parsed = JSON.parse(capture(["next", "--json"]));
    expect(parsed.queue.length).toBeGreaterThan(0);
    for (const row of parsed.queue) {
      expect(Object.keys(row)).not.toContain("labels");
      expect(Object.keys(row)).not.toContain("labelsTruncated");
      expect(Array.isArray(row.openBlockers)).toBe(true);
    }
  });
});

describe("inverted ranking walk (GH-1814) — closedTreeEdges", () => {
  let gh: FakeGh;
  let ctx: Ctx;
  beforeEach(() => {
    gh = new FakeGh();
    ctx = makeCtx(gh);
  });

  /** The invariant the whole change rests on: whatever the project scan's
   *  `closed` half contributed to ranking, the upward closure contributes too.
   *  Compared through rankNext rather than by set equality — the scan hands
   *  over every closed board item, the closure only the ones on a path to an
   *  open node, and the surplus is what provably changes no answer. */
  const rankingsAgree = () => {
    const full = listItemsFull(ctx, QUEUE_SELECT_NO_LABELS);
    const own = ownRepo(ctx, full.open).own;
    const viaScan = rankNext(own, ownRepo(ctx, full.closed).own);
    const viaClosure = rankNext(own, closedTreeEdges(ctx, own));
    const shape = (r: ReturnType<typeof rankNext>) => ({
      eligible: r.eligible.map((i) => i.number),
      blocked: r.blocked.map((i) => i.number),
      inFlightEpics: r.inFlightEpics.map((e) => e.root),
    });
    expect(shape(viaClosure)).toEqual(shape(viaScan));
    return shape(viaClosure);
  };

  it("keeps a Done phase from severing an epic root from its live grandchildren", () => {
    gh.issues.set(1, { number: 1, state: "Backlog", priority: "P0" }); // epic root
    gh.issues.set(2, {
      number: 2, state: "Done", issueState: "CLOSED", stateReason: "COMPLETED", parent: 1,
    }); // closed phase — pass-through only
    gh.issues.set(3, { number: 3, state: "Backlog", priority: "P2", parent: 2 }); // grandchild

    expect(closedTreeEdges(ctx, listOwnOpenItems(ctx, QUEUE_SELECT_NO_LABELS))).toEqual([
      { number: 2, parentNumber: 1 },
    ]);
    rankingsAgree();
  });

  it("walks a chain of closed ancestors, not just the first generation", () => {
    gh.issues.set(1, { number: 1, state: "Backlog", priority: "P0" });
    for (const n of [2, 3]) {
      gh.issues.set(n, {
        number: n, state: "Done", issueState: "CLOSED", stateReason: "COMPLETED", parent: n - 1,
      });
    }
    gh.issues.set(4, { number: 4, state: "Backlog", priority: "P2", parent: 3 });

    expect(closedTreeEdges(ctx, listOwnOpenItems(ctx, QUEUE_SELECT_NO_LABELS))).toEqual([
      { number: 3, parentNumber: 2 },
      { number: 2, parentNumber: 1 },
    ]);
    rankingsAgree();
  });

  it("leaves the tree severed at an OFF-BOARD closed parent, exactly as the scan did", () => {
    gh.issues.set(1, { number: 1, state: "Backlog", priority: "P0" });
    gh.issues.set(2, {
      number: 2, state: null, onBoard: false, issueState: "CLOSED", stateReason: "COMPLETED", parent: 1,
    });
    gh.issues.set(3, { number: 3, state: "Backlog", priority: "P2", parent: 2 });

    expect(closedTreeEdges(ctx, listOwnOpenItems(ctx, QUEUE_SELECT_NO_LABELS))).toEqual([]);
    rankingsAgree();
  });

  it("fails closed when a candidate parent's board membership is truncated", () => {
    gh.issues.set(1, {
      number: 1, state: "Done", issueState: "CLOSED", stateReason: "COMPLETED",
      onBoard: false, projectItemsTruncated: true,
    });
    gh.issues.set(2, { number: 2, state: "Backlog", parent: 1 });

    expect(() => closedTreeEdges(ctx, listOwnOpenItems(ctx, QUEUE_SELECT_NO_LABELS)))
      .toThrow(/#1.*project membership truncated/);
  });

  it("spends nothing when every parent is already open — the common board", () => {
    gh.issues.set(1, { number: 1, state: "Backlog", priority: "P0" });
    gh.issues.set(2, { number: 2, state: "Backlog", parent: 1 });

    const open = listOwnOpenItems(ctx, QUEUE_SELECT_NO_LABELS);
    const before = gh.graphqlCalls;
    expect(closedTreeEdges(ctx, open)).toEqual([]);
    expect(gh.graphqlCalls).toBe(before);
  });

  /** Cost SHAPE, pinned (GH-1811's lesson, applied to the inverted walk):
   *  `projectItems` is a second nesting level, so its `first:` multiplies the
   *  whole page and IS the walk's price. Probed at 20 → 21 pts, at 10 → 11.
   *  A future edit raising it doubles every ranking read silently. */
  it("keeps the issues-rooted walk's second nesting level trimmed", () => {
    gh.issues.set(1, { number: 1, state: "Backlog" });
    listOwnOpenItems(ctx, QUEUE_SELECT_NO_LABELS);
    const walk = gh.queries.filter((q) => q.includes("issues(states: OPEN, first: 100"));
    expect(walk).not.toHaveLength(0);
    for (const q of walk) expect(q).toContain("projectItems(first: 10)");
  });

  it("`next` now pages open work, not project history", () => {
    for (let n = 1; n <= 5; n++) gh.issues.set(n, { number: n, state: "Backlog" });
    for (let n = 6; n <= 60; n++)
      gh.issues.set(n, { number: n, state: "Done", issueState: "CLOSED", stateReason: "COMPLETED" });
    gh.itemsPageSize = 10;

    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const before = gh.graphqlCalls;
    try {
      run(["next", "--json"], ctx);
    } finally {
      spy.mockRestore();
    }
    const inverted = gh.graphqlCalls - before;
    const scanStart = gh.graphqlCalls;
    listItemsFull(ctx, QUEUE_SELECT_NO_LABELS);
    expect(inverted).toBeLessThan(gh.graphqlCalls - scanStart);
  });

  // GH-1891 — the Done audit was the last reader holding tend-queue on the
  // project scan. Measured on this repo: 47 pts / 22 calls → 17 / 6.
  const days = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
  it("`tend-queue` pages open work and a closed WINDOW, never the project scan", () => {
    for (let n = 1; n <= 5; n++) gh.issues.set(n, { number: n, state: "Backlog", updatedAt: days(45) });
    for (let n = 6; n <= 60; n++)
      gh.issues.set(n, {
        number: n, state: "Done", issueState: "CLOSED", stateReason: "COMPLETED",
        closedAt: days(400), updatedAt: days(400),
      });
    gh.itemsPageSize = 10;
    tendQueue(ctx, TEND_DEFAULTS);
    expect(gh.queries.filter((q) => q.includes("items(first: 100"))).toHaveLength(0);
  });

  /** The window read's TERMINATION is the whole reason it is cheap, and it is
   *  only sound because closing an issue is an update — so UPDATED_AT DESC
   *  cannot sort an in-window close below an out-of-window one. Pin that it
   *  actually stops rather than paging the repo's whole closed history. */
  it("the closed-window read stops at the first page beyond the cutoff", () => {
    gh.issues.set(1, {
      number: 1, state: "Done", issueState: "CLOSED", closedAt: days(2), updatedAt: days(2),
    });
    for (let n = 2; n <= 40; n++)
      gh.issues.set(n, {
        number: n, state: "Done", issueState: "CLOSED", closedAt: days(300), updatedAt: days(300),
      });
    gh.itemsPageSize = 10;
    const recent = listOwnRecentClosed(ctx, new Date(NOW.getTime() - 14 * 86_400_000));
    expect(recent.map((c) => c.number)).toEqual([1]);
    // One page: the in-window issue sorts first, the rest of that page is
    // already older than the cutoff, so no cursor is ever followed.
    expect(gh.queries.filter((q) => q.includes("issues(states: CLOSED"))).toHaveLength(1);
  });

  /** The audit reads comments and nothing else. `projectItems × fieldValues`
   *  was 200 of the ~280 nodes charged per issue in HISTORY_SELECTION — the
   *  reason the trail fetch, not the walk, became tend-queue's biggest term
   *  once the scan was gone. */
  it("the tend lane's trail fetch asks for comments only, in one large batch", () => {
    for (let n = 1; n <= 60; n++) gh.issues.set(n, { number: n, state: "Backlog" });
    fetchCommentTrails(ctx, [...Array(60)].map((_, i) => i + 1));
    const trail = gh.queries.filter((q) => q.includes("comments(last"));
    expect(trail).toHaveLength(1); // 60 issues, COMMENTS_CHUNK = 100
    for (const q of trail) {
      expect(q).not.toContain("projectItems");
      expect(q).not.toContain("closedByPullRequestsReferences");
    }
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

  it("foreign-repo items under `allow` are an informational ok line, named with their repo", () => {
    gh.issues.set(1, { number: 1, state: "Backlog" });
    gh.issues.set(2, { number: 2, state: "Backlog", repo: "someone-else/theirs" });
    ctx.cfg.foreign = { allow: true, configured: true };

    const check = doctor(ctx).checks.find((c) => c.name === "foreign-items");
    expect(check?.level).toBe("ok"); // the configured shape of the board — never a gate
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

describe("doctor: herdr-cockpit (GH-1759) — advisory by construction", () => {
  // Overlay the herdr-setup.sh call; every other exec stays on the fake.
  const withSetupSh = (gh: FakeGh, result: { code: number; stdout: string; stderr?: string }) => {
    const inner = gh.exec;
    gh.exec = (argv, stdin) =>
      argv[0] === "bash" && argv[1]?.endsWith("herdr-setup.sh")
        ? { code: result.code, stdout: result.stdout, stderr: result.stderr ?? "" }
        : inner(argv, stdin);
  };
  const cockpit = (r: ReturnType<typeof doctor>) =>
    r.checks.find((c) => c.name === "herdr-cockpit")!;

  it("fully wired reads ok", () => {
    const gh = new FakeGh();
    withSetupSh(gh, { code: 0, stdout: "herdr: wired\n" });
    const c = cockpit(doctor(makeCtx(gh)));
    expect(c.level).toBe("ok");
    expect(c.detail).toBe("wired (optional cockpit)");
  });

  it("wired passes the worktree-pile fragment through instead of flattening it (GH-2105)", () => {
    const gh = new FakeGh();
    withSetupSh(gh, {
      code: 0,
      stdout: "herdr: wired; worktree-pile: 47 dir(s) under /u/.herdr/worktrees/r — `bash …/herdr-setup.sh sweep` removes the finished ones (dry run by default)\n",
    });
    const c = cockpit(doctor(makeCtx(gh)));
    expect(c.level).toBe("ok"); // a pile is never a finding
    expect(c.detail).toContain("worktree-pile: 47");
    expect(c.detail).toContain("sweep");
  });

  it("herdr not installed is info and points at /ralph:help herdr — never a finding (weekly CI has no herdr)", () => {
    const gh = new FakeGh();
    const baseline = doctor(makeCtx(new FakeGh()), { strict: true }).ok;
    withSetupSh(gh, { code: 2, stdout: "herdr: not installed\n" });
    const r = doctor(makeCtx(gh), { strict: true });
    expect(cockpit(r).level).toBe("info");
    expect(cockpit(r).detail).toContain("/ralph:help herdr");
    expect(r.ok).toBe(baseline); // info never touches the exit code, strict included
  });

  it("gaps relay the script's one-line verdict at info, even under --strict", () => {
    const gh = new FakeGh();
    const baseline = doctor(makeCtx(new FakeGh()), { strict: true }).ok;
    withSetupSh(gh, { code: 1, stdout: "herdr: 1 gap(s) — gh-auth: not authenticated\n" });
    const r = doctor(makeCtx(gh), { strict: true });
    expect(cockpit(r).level).toBe("info");
    expect(cockpit(r).detail).toContain("gh-auth");
    expect(r.ok).toBe(baseline);
  });

  it("relays the gap's DETAIL whole — no truncation of the payload (GH-1911)", () => {
    const gh = new FakeGh();
    const verdict =
      "herdr: 1 gap(s) — ralph-herdr-version: 0.5.1 < 0.5.2 expected by this ralph, so the cockpit is " +
      "EXECUTING PLUGIN CODE OLDER than this ralph relies on — fixes released since 0.5.2 are not in " +
      "effect in the copy it runs; herdr has no auto-update, reinstall: herdr plugin install " +
      "cdubiel08/ralph-hero/plugin/ralph-herdr --ref main -y";
    withSetupSh(gh, { code: 1, stdout: `${verdict}\n` });
    const c = cockpit(doctor(makeCtx(gh), { strict: true }));
    expect(c.level).toBe("info"); // severity is deliberately unchanged
    expect(c.detail).toContain("0.5.1 < 0.5.2"); // both versions survive the relay
    expect(c.detail).toContain("herdr plugin install cdubiel08/ralph-hero/plugin/ralph-herdr --ref main -y");
  });

  it("a script that fails to run degrades to not-evaluated info (the fake's default exec)", () => {
    const gh = new FakeGh();
    const r = doctor(makeCtx(gh));
    expect(cockpit(r).level).toBe("info");
    expect(cockpit(r).detail).toContain("not evaluated");
    expect(r.ok).toBe(true);
  });
});

describe("doctor: installed-plugin floor (GH-1825) — advisory by construction", () => {
  const saved = process.env.RALPH_INSTALLED_PLUGINS_FILE;
  afterEach(() => {
    if (saved === undefined) delete process.env.RALPH_INSTALLED_PLUGINS_FILE;
    else process.env.RALPH_INSTALLED_PLUGINS_FILE = saved;
  });

  /** Writes an installed copy on disk (manifest version) unless `manifest` is
   *  false — the case where only the registry record can be read. */
  const copyOn = (version: string, manifest: string | false = version) => {
    const dir = join(mkdtempSync(join(tmpdir(), "board-plugin-")), version);
    if (manifest !== false) {
      mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
      writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "ralph", version: manifest }));
    }
    return dir;
  };

  const registry = (content: unknown) => {
    const file = join(mkdtempSync(join(tmpdir(), "board-registry-")), "installed_plugins.json");
    writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
    process.env.RALPH_INSTALLED_PLUGINS_FILE = file;
    return file;
  };
  const ralphAt = (installPath: string, version = "0.0.0") => ({
    plugins: { "ralph@ralph-hero": [{ scope: "user", installPath, version }] },
  });

  const applyRepo = (): Config => {
    const cfg = makeCtx(new FakeGh()).cfg;
    cfg.apply = { ...cfg.apply, enabled: true };
    return cfg;
  };

  it("below the floor names the INERT CAPABILITY, not just an old number", () => {
    const path = copyOn("0.1.74");
    registry(ralphAt(path));
    const r = installedPluginReport(applyRepo());
    expect(r.level).toBe("info");
    expect(r.detail).toContain(path); // the resolved installPath, not a cache glob
    expect(r.detail).toContain("0.1.74 < 0.1.81");
    expect(r.detail).toContain("the apply close gate is NOT enforcing");
  });

  it("at or above the floor is ok", () => {
    registry(ralphAt(copyOn("0.1.81")));
    expect(installedPluginReport(applyRepo()).level).toBe("ok");
    registry(ralphAt(copyOn("0.1.115")));
    expect(installedPluginReport(applyRepo()).level).toBe("ok");
  });

  it("a repo that relies on no plugin-side gate never hears about a floor, however old the install", () => {
    registry(ralphAt(copyOn("0.1.40")));
    const r = installedPluginReport(makeCtx(new FakeGh()).cfg); // apply not enabled
    expect(r.level).toBe("ok");
    expect(r.detail).toContain("no capability floor applies");
    expect(r.detail).not.toContain("NOT enforcing");
  });

  it("absence is not a breach: no registry, garbage registry, or no ralph key all read `not evaluated`", () => {
    process.env.RALPH_INSTALLED_PLUGINS_FILE = join(tmpdir(), "board-registry-absent", "nope.json");
    expect(installedPluginReport(applyRepo())).toMatchObject({ level: "info" });
    expect(installedPluginReport(applyRepo()).detail).toContain("not evaluated");

    registry("{ not json");
    expect(installedPluginReport(applyRepo()).detail).toContain("not evaluated");

    registry({ plugins: { "other@market": [{ installPath: copyOn("0.0.1"), version: "0.0.1" }] } });
    expect(installedPluginReport(applyRepo()).detail).toContain("not evaluated");
    expect(resolveInstalledPlugin("ralph")).toBeNull();
  });

  it("the installed copy's own manifest wins over the registry record, which is a labelled fallback", () => {
    // The record claims 0.1.99; the directory actually holds 0.1.74.
    registry(ralphAt(copyOn("0.1.74"), "0.1.99"));
    const judged = installedPluginReport(applyRepo());
    expect(judged.detail).toContain("ralph 0.1.74");
    expect(judged.level).toBe("info");

    registry(ralphAt(copyOn("gone", false), "0.1.99"));
    const fallback = installedPluginReport(applyRepo());
    expect(fallback.detail).toContain("ralph 0.1.99");
    expect(fallback.detail).toContain("manifest is unreadable");
    expect(fallback.level).toBe("ok");
  });

  it("several installed copies are judged by the LOWEST — any of them may be the one a session resolved", () => {
    registry({
      plugins: {
        "ralph@ralph-hero": [
          { scope: "user", installPath: copyOn("0.1.115") },
          { scope: "local", projectPath: "/repo", installPath: copyOn("0.1.74") },
        ],
      },
    });
    const r = installedPluginReport(applyRepo());
    expect(r.detail).toContain("ralph 0.1.74");
    expect(r.detail).toContain("2 installed copies");
    expect(r.level).toBe("info");
  });

  it("an unparseable version is not evaluated, never assumed stale", () => {
    registry(ralphAt(copyOn("unknown")));
    const r = installedPluginReport(applyRepo());
    expect(r.level).toBe("info");
    expect(r.detail).toContain("not evaluated");
    expect(r.detail).toContain("unknown");
  });

  it("compareVersions orders numerically and refuses non-numeric input", () => {
    expect(compareVersions("0.1.9", "0.1.10")).toBe(-1);
    expect(compareVersions("0.1.81", "0.1.81")).toBe(0);
    expect(compareVersions("0.2", "0.1.99")).toBe(1);
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
    expect(compareVersions("unknown", "0.1.81")).toBeNull();
    expect(compareVersions("0.1.81", "v0.1.81")).toBeNull();
  });

  it("every floor names a capability and a parseable release", () => {
    for (const f of CAPABILITY_FLOORS) {
      expect(f.capability).toBeTruthy();
      expect(compareVersions(f.since, "0.0.0")).not.toBeNull();
    }
  });

  it("--strict never escalates it and --fix never acts on it, stale install included", () => {
    const path = copyOn("0.1.74");
    registry(ralphAt(path));
    const line = (r: ReturnType<typeof doctor>) => r.checks.find((c) => c.name === "installed-plugin")!;
    const ctx = makeCtx(new FakeGh());
    ctx.cfg.apply = { ...ctx.cfg.apply, enabled: true };

    // Baselines: the same sweep with a CURRENT install, so the only difference
    // is this line going stale.
    registry(ralphAt(copyOn("0.1.115")));
    const [okPlain, okStrict, okFixed] = [doctor(ctx).ok, doctor(ctx, { strict: true }).ok, doctor(ctx, { fix: true }).ok];
    registry(ralphAt(path));

    const plain = doctor(ctx);
    const strict = doctor(ctx, { strict: true });
    const fixed = doctor(ctx, { fix: true });
    for (const r of [plain, strict, fixed]) expect(line(r).level).toBe("info");
    expect(plain.ok).toBe(okPlain);
    expect(strict.ok).toBe(okStrict); // info is outside the exit code, --strict included
    expect(fixed.ok).toBe(okFixed);
    // --fix corrects board state; an install is not board state, so the stale
    // copy is reported and left byte-for-byte where it was.
    expect(JSON.parse(readFileSync(join(path, ".claude-plugin", "plugin.json"), "utf8")).version).toBe("0.1.74");
  });

  it("a throwing read degrades to info rather than touching the exit code", () => {
    // A directory where the registry file should be: existsSync passes, the
    // read throws EISDIR.
    process.env.RALPH_INSTALLED_PLUGINS_FILE = mkdtempSync(join(tmpdir(), "board-registry-dir-"));
    const baseline = doctor(makeCtx(new FakeGh()), { strict: true }).ok;
    const r = doctor(makeCtx(new FakeGh()), { strict: true });
    const c = r.checks.find((x) => x.name === "installed-plugin")!;
    expect(c.level).toBe("info");
    expect(c.detail).toContain("not evaluated");
    expect(r.ok).toBe(baseline);
  });
});

describe("doctor: gate-kit drift (GH-2083) — advisory, host-owned files respected", () => {
  const saved = process.env.RALPH_INSTALLED_PLUGINS_FILE;
  afterEach(() => {
    if (saved === undefined) delete process.env.RALPH_INSTALLED_PLUGINS_FILE;
    else process.env.RALPH_INSTALLED_PLUGINS_FILE = saved;
  });

  const sha = (s: string) => cryptoCreateHash("sha256").update(s).digest("hex");

  /** A fake host repo: files on disk + the install stamp recording them. */
  const hostRepo = (opts: {
    files?: Record<string, string>; // dest -> content on disk
    stamp?: Record<string, string>; // dest -> stamped hash
    stampRaw?: string;
    version?: string;
  }) => {
    const root = mkdtempSync(join(tmpdir(), "board-gatekit-host-"));
    for (const [dest, content] of Object.entries(opts.files ?? {})) {
      mkdirSync(join(root, dest, ".."), { recursive: true });
      writeFileSync(join(root, dest), content);
    }
    if (opts.stampRaw !== undefined || opts.stamp) {
      mkdirSync(join(root, ".github"), { recursive: true });
      writeFileSync(
        join(root, ".github", "ralph-kit.json"),
        opts.stampRaw ?? JSON.stringify({ version: opts.version ?? "0.1.100", files: opts.stamp }),
      );
    }
    return root;
  };

  /** A fake installed plugin carrying a kit manifest, registered for resolve. */
  const pluginWithKit = (version: string, kitFiles: Record<string, string> | null) => {
    const dir = mkdtempSync(join(tmpdir(), "board-gatekit-plugin-"));
    mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
    writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "ralph", version }));
    if (kitFiles) {
      mkdirSync(join(dir, "kit"), { recursive: true });
      writeFileSync(join(dir, "kit", "manifest.json"), JSON.stringify({ files: kitFiles }));
    }
    const reg = join(mkdtempSync(join(tmpdir(), "board-gatekit-reg-")), "installed_plugins.json");
    writeFileSync(reg, JSON.stringify({ plugins: { "ralph@ralph-hero": [{ scope: "user", installPath: dir }] } }));
    process.env.RALPH_INSTALLED_PLUGINS_FILE = reg;
    return dir;
  };

  it("no stamp reads ok — not installed from the kit is not a finding", () => {
    const r = gateKitReport(hostRepo({}));
    expect(r.level).toBe("ok");
    expect(r.detail).toContain("no gate-kit stamp");
  });

  it("current kit is ok with the count; behind the plugin is info naming files and the remedy", () => {
    const A = "gate v1";
    pluginWithKit("0.1.101", { "scripts/merge-pr.sh": sha(A) });
    const root = hostRepo({ files: { "scripts/merge-pr.sh": A }, stamp: { "scripts/merge-pr.sh": sha(A) } });
    const ok = gateKitReport(root);
    expect(ok.level).toBe("ok");
    expect(ok.detail).toContain("1 file(s) current");

    const plugin = pluginWithKit("0.1.102", { "scripts/merge-pr.sh": sha("gate v2") });
    const behind = gateKitReport(root);
    expect(behind.level).toBe("info");
    expect(behind.detail).toContain("scripts/merge-pr.sh");
    expect(behind.detail).toContain(`bash ${plugin}/scripts/install-gates.sh`);
  });

  it("a host-modified file is the host's — named, never counted as drift", () => {
    pluginWithKit("0.1.101", { "scripts/pr-file-classes.sh": sha("kit copy") });
    const root = hostRepo({
      files: { "scripts/pr-file-classes.sh": "adapted taxonomy" },
      stamp: { "scripts/pr-file-classes.sh": sha("kit copy") },
    });
    const r = gateKitReport(root);
    expect(r.level).toBe("ok");
    expect(r.detail).toContain("1 locally modified");
  });

  it("a deleted file is an opt-out, and a retired file is named — neither is drift", () => {
    pluginWithKit("0.1.101", { "scripts/merge-pr.sh": sha("gate") });
    const r = gateKitReport(
      hostRepo({
        files: { "scripts/ruleset-contexts.sh": "old" }, // in stamp, gone from the kit
        stamp: { "scripts/merge-pr.sh": sha("gate"), "scripts/ruleset-contexts.sh": sha("old x") },
      }),
    );
    expect(r.level).toBe("ok");
    expect(r.detail).toContain("1 retired");
  });

  it("unreadable stamp, absent registry, and a kit-less plugin all read not evaluated, never clean", () => {
    pluginWithKit("0.1.101", { "scripts/merge-pr.sh": sha("x") });
    const bad = gateKitReport(hostRepo({ stampRaw: "{ not json" }));
    expect(bad.level).toBe("info");
    expect(bad.detail).toContain("not evaluated");

    const stamped = hostRepo({ stamp: { "scripts/merge-pr.sh": sha("x") } });
    process.env.RALPH_INSTALLED_PLUGINS_FILE = join(tmpdir(), "board-gatekit-none", "nope.json");
    expect(gateKitReport(stamped).detail).toContain("not evaluated");

    pluginWithKit("0.1.50", null); // installed, but predates the kit
    const nokit = gateKitReport(stamped);
    expect(nokit.level).toBe("info");
    expect(nokit.detail).toContain("no readable kit manifest");
  });

  it("doctor carries the line, and --strict never escalates it", () => {
    pluginWithKit("0.1.102", { "scripts/merge-pr.sh": sha("v2") });
    const ctx = makeCtx(new FakeGh());
    ctx.repoRoot = hostRepo({ files: { "scripts/merge-pr.sh": "v1" }, stamp: { "scripts/merge-pr.sh": sha("v1") } });
    const r = doctor(ctx, { strict: true });
    const c = r.checks.find((x) => x.name === "gate-kit")!;
    expect(c.level).toBe("info");
    expect(c.detail).toContain("outdated");
    expect(r.ok).toBe(doctor(makeCtx(new FakeGh()), { strict: true }).ok);
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

describe("next: tiered queue-empty diagnosis", () => {
  const lines: string[] = [];
  let restore = () => {};
  beforeEach(() => {
    lines.length = 0;
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((s) => {
      lines.push(String(s));
      return true;
    });
    restore = () => spy.mockRestore();
  });
  afterEach(() => restore());
  const said = () => lines.join("").trimEnd();

  it("tier 2 — an empty board names intake, not just emptiness", () => {
    const ctx = makeCtx(new FakeGh());
    run(["next"], ctx);
    // GH-2077: "nothing approved" and "nothing filed" are different boards, so
    // the empty-queue line names the Intake lane and how to look at it.
    expect(said()).toContain("queue empty — nothing approved");
    expect(said()).toContain("board create --intake");
    expect(said()).toContain("board list --state intake");
  });

  it("tier 3 — Human Needed outranks the blocked report; still exactly one line", () => {
    const gh = new FakeGh();
    gh.issues.set(1, { number: 1, state: "Human Needed" });
    gh.issues.set(2, { number: 2, state: "Human Needed" });
    gh.issues.set(3, { number: 3, state: "Backlog", blockedBy: [{ number: 9, state: "OPEN" }] });
    gh.issues.set(9, { number: 9, state: "In Progress" });

    run(["next"], makeCtx(gh));
    expect(said()).toBe("queue empty — 2 in Human Needed awaiting answers (/ralph:board walks the queue)");
  });

  it("tier 4 — a blocker the board already calls Done reads as a stale edge, with the removal command", () => {
    const gh = new FakeGh();
    gh.issues.set(3, { number: 3, state: "Backlog", blockedBy: [{ number: 9, state: "OPEN" }] });
    gh.issues.set(9, { number: 9, state: "Done" }); // open on GitHub, terminal on the board

    run(["next"], makeCtx(gh));
    expect(said()).toBe(
      "queue empty (1 blocked: #3 — #3's blockers are all resolved on the board; stale edge? board dep 3 --on 9 --rm)",
    );
  });

  it("tier 4 keys on repo-qualified identity — our Done #9 never resolves a foreign #9", () => {
    const gh = new FakeGh();
    gh.issues.set(3, {
      number: 3, state: "Backlog",
      blockedBy: [{ number: 9, state: "OPEN", repo: "other/repo" }],
    });
    gh.issues.set(9, { number: 9, state: "Done" }); // same number, our repo — not the blocker

    run(["next"], makeCtx(gh));
    expect(said()).toBe("queue empty (1 blocked: #3)");
  });

  it("tier 4 fails closed — a truncated blocker list is never called stale", () => {
    const gh = new FakeGh();
    gh.issues.set(3, {
      number: 3, state: "Backlog", blockersTruncated: true,
      blockedBy: [{ number: 9, state: "OPEN" }],
    });
    gh.issues.set(9, { number: 9, state: "Done" });

    run(["next"], makeCtx(gh));
    expect(said()).toBe("queue empty (1 blocked: #3)");
  });

  it("tier 5 — a live blocker prints today's line, unchanged", () => {
    const gh = new FakeGh();
    gh.issues.set(3, { number: 3, state: "Backlog", blockedBy: [{ number: 9, state: "OPEN" }] });
    gh.issues.set(4, { number: 4, state: "Backlog", blockedBy: [{ number: 9, state: "OPEN" }] });
    gh.issues.set(9, { number: 9, state: "In Progress" });

    run(["next"], makeCtx(gh));
    expect(said()).toBe("queue empty (2 blocked: #3 #4)");
  });

  it("a non-empty queue is byte-identical to today's output — no hint on a healthy run", () => {
    const gh = new FakeGh();
    gh.issues.set(1, { number: 1, state: "Backlog" });
    gh.issues.set(2, { number: 2, state: "Backlog" });
    gh.issues.set(3, { number: 3, state: "Backlog", blockedBy: [{ number: 9, state: "OPEN" }] });
    gh.issues.set(4, { number: 4, state: "Human Needed" }); // would fire tier 3 on an empty queue
    gh.issues.set(9, { number: 9, state: "Done" }); // would fire tier 4 on an empty queue

    run(["next"], makeCtx(gh));
    expect(said()).toBe("next: #1 Issue 1\n  then #2 Issue 2\n  blocked: #3←#9");
  });

  it("--json gets the diagnosis as fields, never as prose", () => {
    const gh = new FakeGh();
    gh.issues.set(1, { number: 1, state: "Human Needed" });
    gh.issues.set(3, { number: 3, state: "Backlog", blockedBy: [{ number: 9, state: "OPEN" }] });
    gh.issues.set(9, { number: 9, state: "Done" });

    run(["next", "--json"], makeCtx(gh));
    const parsed = JSON.parse(lines.join(""));
    expect(parsed.diagnosis).toBe("human-needed"); // first match wins here too
    expect(parsed.humanNeededCount).toBe(1);
    expect(parsed.staleBlockedEdges).toEqual([{ number: 3, blockers: [9] }]);
    expect(parsed.next).toBeNull();
    expect(JSON.stringify(parsed)).not.toContain("queue empty");
  });

  it("--json on a healthy queue reports no diagnosis", () => {
    const gh = new FakeGh();
    gh.issues.set(1, { number: 1, state: "Backlog" });
    gh.issues.set(4, { number: 4, state: "Human Needed" });

    run(["next", "--json"], makeCtx(gh));
    const parsed = JSON.parse(lines.join(""));
    expect(parsed.diagnosis).toBeNull();
    expect(parsed.humanNeededCount).toBe(1); // facts stay; only the verdict is gated
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

  it("an existing state field missing v2 options gets them ADDED — every existing id resubmitted", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    gh.omitFields = ["Workflow State"];
    gh.createdFields.push({
      name: "Workflow State", dataType: "SINGLE_SELECT",
      options: ["Backlog", "In Progress"], // pre-existing partial set, not ours
    });
    const { ok, notes } = setup(ctx);
    expect(gh.mutations.filter((m) => m.startsWith("createField"))).toEqual([]);
    // Missing states land in STATES order around the options that were there.
    expect(gh.mutations).toContain(
      "updateFieldOptions(Intake,Backlog,In Progress,In Review,Human Needed,Done,Canceled)",
    );
    expect(notes.some((n) => n.startsWith("MANUAL: add option(s)"))).toBe(false);
    expect(notes.some((n) => n.includes('added option(s) Intake, In Review, Human Needed, Done, Canceled to "Workflow State"'))).toBe(true);
    expect(ok).toBe(true);
  });

  it("the add is verified by ID survival — an option recreated with a fresh id is a named refusal", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    gh.omitFields = ["Workflow State"];
    gh.createdFields.push({
      name: "Workflow State", dataType: "SINGLE_SELECT", options: ["Backlog", "In Progress"],
    });
    gh.reissueOptionIdsOnUpdate = true; // GitHub cleared every item value

    const { ok, notes } = setup(ctx);
    expect(ok).toBe(false);
    const failure = notes.find((n) => n.startsWith("VERIFY FAILED"));
    expect(failure).toContain("lost their original id");
    expect(failure).toContain("Backlog");
    expect(failure).toContain("In Progress");
  });

  it("an unreadable option set refuses the mutation and falls back to the MANUAL line", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    gh.omitFields = ["Workflow State"];
    gh.createdFields.push({
      name: "Workflow State", dataType: "SINGLE_SELECT", options: ["Backlog", "In Progress"],
    });
    gh.unreadableFieldOptions = true;

    const { ok, notes } = setup(ctx);
    expect(gh.mutations.filter((m) => m.startsWith("updateFieldOptions"))).toEqual([]);
    const manual = notes.find((n) => n.startsWith("MANUAL: add option(s)"));
    expect(manual).toContain("could not read the field's current option set");
    expect(manual).toContain("Intake"); // the fail-closed consequence is still named
    expect(ok).toBe(true); // nothing was attempted, so nothing failed to stick
  });

  it("a complete option set is left alone — idempotent, no option-set mutation", () => {
    const gh = new FakeGh(); // default Workflow State carries every v2 state
    const ctx = makeCtx(gh);
    setup(ctx);
    expect(gh.mutations.filter((m) => m.startsWith("updateFieldOptions"))).toEqual([]);
  });

  it("legacy v1 options present get a MANUAL delete note", () => {
    const gh = new FakeGh(); // default Workflow State fixture includes LEGACY_STATES
    const ctx = makeCtx(gh);
    const { notes } = setup(ctx);
    expect(notes.some((n) => n.startsWith("MANUAL: delete legacy option(s)") && n.includes("Ready for Plan"))).toBe(true);
    // Removal stays UI-only: adding is now API-capable, deleting is not attempted.
    expect(gh.mutations.filter((m) => m.startsWith("updateFieldOptions"))).toEqual([]);
    expect(notes.some((n) => n.includes("migrate"))).toBe(false);
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

// ---------------------------------------------------------------------------
// Readiness integration policy (GH-2138) — Level-3 concurrency checks that
// emit a RECOMMENDED POLICY, never a table; unreadable inputs read info,
// never miss; nothing here can move readyFor.
// ---------------------------------------------------------------------------

const RS = "\x1e";

/** Overlay repo metadata, effective branch rules, first-parent history, and
 *  the closed-PR window on the FakeGh exec. Omitted pieces stay unreadable
 *  (FakeGh's base exec answers exit 1), which IS the degraded case. */
function withIntegration(
  gh: FakeGh,
  opts: {
    rules?: Array<Record<string, unknown>>;
    gitLog?: string;
    pulls?: Array<{ created_at: string; merged_at: string | null }>;
  },
) {
  const base = gh.exec;
  gh.exec = (argv, stdin) => {
    const cmd = argv.join(" ");
    if (cmd === "gh api --hostname github.com repos/cdubiel08/ralph-hero")
      return { code: 0, stdout: JSON.stringify({ default_branch: "main" }), stderr: "" };
    if (cmd.endsWith("rules/branches/main")) {
      if (!opts.rules) return { code: 1, stdout: "", stderr: "HTTP 500" };
      return { code: 0, stdout: JSON.stringify(opts.rules), stderr: "" };
    }
    if (argv[0] === "git" && argv.includes("log")) {
      if (opts.gitLog === undefined) return { code: 1, stdout: "", stderr: "bad revision" };
      // Only origin/main answers — the worktree's HEAD is a feature branch.
      return argv.includes("origin/main")
        ? { code: 0, stdout: opts.gitLog, stderr: "" }
        : { code: 1, stdout: "", stderr: "bad revision" };
    }
    if (cmd.includes("/pulls?state=closed") && opts.pulls)
      return { code: 0, stdout: JSON.stringify(opts.pulls), stderr: "" };
    return base(argv, stdin);
  };
}

/** n landings a day apart; files(i) = what landing i touched. */
function landings(n: number, files: (i: number) => string[]): string {
  let out = "";
  for (let i = 0; i < n; i++) {
    out += `${RS}${1_700_000_000 + i * 86_400}\n${files(i).join("\n")}\n`;
  }
  return out;
}

describe("readiness integration policy (GH-2138)", () => {
  const policyCheck = (gh: FakeGh) => {
    const ctx = makeCtx(gh, "me@test", mkdtempSync(join(tmpdir(), "readiness-integ-")));
    const report = readiness(ctx);
    return { report, check: report.checks.find((c) => c.name === "integration-policy")! };
  };

  it("a merge queue reads ok — the recommended policy is already in place", () => {
    const gh = new FakeGh();
    withIntegration(gh, { rules: [{ type: "pull_request" }, { type: "merge_queue" }] });
    const { check } = policyCheck(gh);
    expect(check.level).toBe(3);
    expect(check.status).toBe("ok");
    expect(check.detail).toContain("merge queue active");
    expect(check.recommend).toBeUndefined();
  });

  it("strict without a queue recommends a merge queue by name (the org-standard case)", () => {
    const gh = new FakeGh();
    withIntegration(gh, {
      rules: [
        { type: "pull_request" },
        { type: "required_status_checks", parameters: { strict_required_status_checks_policy: true } },
      ],
    });
    const { check } = policyCheck(gh);
    expect(check.status).toBe("info"); // advisory, never a gap
    expect(check.detail).toContain("require-up-to-date");
    expect(check.recommend).toContain("merge queue");
  });

  it("a hot collision surface with no queue and strict unset names the file and the decision", () => {
    const gh = new FakeGh();
    withIntegration(gh, {
      rules: [{ type: "pull_request" }],
      // 12 landings; package-lock.json in 6 of them (≥ ceil(12·0.3)=4 → hot)
      gitLog: landings(12, (i) => (i % 2 === 0 ? ["package-lock.json", `src/f${i}.ts`] : [`src/f${i}.ts`])),
      pulls: [{ created_at: "2026-08-01T00:00:00Z", merged_at: "2026-08-02T00:00:00Z" }],
    });
    const { check } = policyCheck(gh);
    expect(check.status).toBe("info");
    expect(check.detail).toContain("package-lock.json (6/12)");
    expect(check.detail).toContain("median PR lifetime 24h");
    expect(check.recommend).toContain("substrate, not decomposition");
    expect(check.recommend).toContain("merge queue before narrowing agent concurrency");
  });

  it("a quiet measured repo reads ok with the load it measured — a decision, not a table", () => {
    const gh = new FakeGh();
    withIntegration(gh, {
      rules: [{ type: "pull_request" }],
      gitLog: landings(12, (i) => [`src/f${i}.ts`]), // no shared files at all
    });
    const { check } = policyCheck(gh);
    expect(check.status).toBe("ok");
    expect(check.detail).toContain("no integration pressure measured");
    expect(check.detail).toContain("landings/wk");
  });

  it("an unreadable ruleset degrades to info and recommends nothing — never a manufactured gap", () => {
    const gh = new FakeGh();
    withIntegration(gh, { gitLog: landings(12, (i) => [`src/f${i}.ts`]) }); // rules omitted = unreadable
    const { report, check } = policyCheck(gh);
    expect(check.status).toBe("info");
    expect(check.detail).toContain("not evaluated");
    expect(check.recommend).toBeUndefined();
    // and it can never move readyFor: no "miss" exists for this check
    expect(report.checks.filter((c) => c.name === "integration-policy" && c.status === "miss")).toEqual([]);
  });

  it("too few landings refuses to assess collision rather than guessing", () => {
    const verdict = integrationPolicy({
      mergeQueue: false, strict: false, mergesPerWeek: 2, medianPrHours: null,
      hotFiles: null, mergesMeasured: 3,
    });
    expect(verdict.status).toBe("info");
    expect(verdict.detail).toContain("3 landing(s) measured, need 10");
    expect(verdict.recommend).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Apply kind (GH-1693) — merge ≠ done for infra work.
// ---------------------------------------------------------------------------

describe("loadApplyConfig", () => {
  // loadApplyConfig PREFERS RALPH_MERGE_POLICY_FILE over the repo-root path,
  // and a developer shell or CI job may have it set — which would make every
  // fixture below read the wrong file (CodeRabbit finding, PR #1699).
  const savedPolicyEnv = process.env.RALPH_MERGE_POLICY_FILE;
  beforeEach(() => {
    delete process.env.RALPH_MERGE_POLICY_FILE;
  });
  afterEach(() => {
    if (savedPolicyEnv === undefined) delete process.env.RALPH_MERGE_POLICY_FILE;
    else process.env.RALPH_MERGE_POLICY_FILE = savedPolicyEnv;
  });

  const withPolicy = (contents: string | null): string => {
    const root = mkdtempSync(join(tmpdir(), "apply-cfg-"));
    if (contents !== null) {
      mkdirSync(join(root, ".github"), { recursive: true });
      writeFileSync(join(root, ".github", "ralph-merge-policy.json"), contents);
    }
    return root;
  };

  it("is OFF when the repo has not opted in — no policy file, no apply block, or enabled:false", () => {
    expect(loadApplyConfig(withPolicy(null)).enabled).toBe(false);
    expect(loadApplyConfig(withPolicy(`{"attestation":{"required":true}}`)).enabled).toBe(false);
    expect(loadApplyConfig(withPolicy(`{"apply":{"enabled":false}}`)).enabled).toBe(false);
  });

  it("reads label + infraPaths, defaulting the label", () => {
    const c = loadApplyConfig(
      withPolicy(`{"apply":{"enabled":true,"infraPaths":[".github/**","terraform/**",7]}}`),
    );
    expect(c).toEqual({
      enabled: true,
      label: APPLY_LABEL_DEFAULT,
      infraPaths: [".github/**", "terraform/**"], // non-strings dropped, not coerced
    });
    expect(loadApplyConfig(withPolicy(`{"apply":{"enabled":true,"label":"kind/apply"}}`)).label).toBe("kind/apply");
  });

  it("FAILS CLOSED on a malformed policy file — a truncated policy must not silently disable the gates", () => {
    const c = loadApplyConfig(withPolicy(`{"apply":{"enabled":true`));
    expect(c.enabled).toBe(true);
    expect(c.label).toBe(APPLY_LABEL_DEFAULT);
  });
});

describe("apply evidence — pure shape validation", () => {
  const NOW_E = new Date("2026-08-02T12:00:00Z");
  const comment = (payload: unknown) =>
    `${APPLY_EVIDENCE_MARKER}\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n`;
  const valid = {
    kind: "settings",
    applied_at: "2026-08-02T11:00:00Z",
    actor: "dubiel",
    notes: "ralph:apply label created and the policy block is live",
    checks: [{ cmd: "gh label list", exit_code: 0 }],
  };

  it("accepts a shape-valid settings/observation payload", () => {
    expect(validateApplyEvidence(parseApplyEvidence([comment(valid)]), NOW_E)).toBeNull();
    expect(validateApplyEvidence({ ...valid, kind: "observation" }, NOW_E)).toBeNull();
  });

  it("takes the LAST marker comment, ignores unrelated comments, and treats a shapeless marker as a failure", () => {
    const stale = comment({ ...valid, notes: "stale" });
    const fresh = comment({ ...valid, notes: "fresh" });
    expect((parseApplyEvidence(["chatter", stale, "more chatter", fresh]) as any).notes).toBe("fresh");
    expect(parseApplyEvidence(["nothing here"])).toBeNull();
    expect(parseApplyEvidence([`${APPLY_EVIDENCE_MARKER}\nI applied it, trust me`])).toBeNull();
    expect(parseApplyEvidence([`${APPLY_EVIDENCE_MARKER}\n\`\`\`json\n{not json}\n\`\`\``])).toBeNull();
  });

  it("names the FIRST failing rule for every field it enforces", () => {
    const fails = (over: Record<string, unknown>, want: RegExp) =>
      expect(validateApplyEvidence({ ...valid, ...over }, NOW_E)).toMatch(want);
    expect(validateApplyEvidence(null, NOW_E)).toMatch(/no <!-- ralph-apply-evidence:v1 -->/);
    expect(validateApplyEvidence("just a string", NOW_E)).toMatch(/no <!-- ralph-apply-evidence:v1 -->/);
    fails({ kind: "vibes" }, /"kind" must be one of run\|observation\|settings/);
    fails({ applied_at: "yesterday" }, /"applied_at" must be an ISO-8601 timestamp/);
    fails({ applied_at: "2026-08-03T00:00:00Z" }, /is in the future — the apply has not happened yet/);
    fails({ actor: "  " }, /"actor" must be non-empty/);
    fails({ notes: "" }, /"notes" must state, in words, what is now live/);
    fails({ checks: [] }, /requires a non-empty "checks" array/);
    fails({ checks: [{ cmd: "x", exit_code: 1 }] }, /every checks\[\] entry needs exit_code 0/);
  });

  it("tolerates a few minutes of clock skew rather than rejecting honest evidence", () => {
    expect(validateApplyEvidence({ ...valid, applied_at: "2026-08-02T12:02:00Z" }, NOW_E)).toBeNull();
  });

  it("binds kind=run evidence to the merge SHA — a green run of the pre-merge code is not proof", () => {
    const sha = "a1b2c3d4e5f6a7b8";
    const runEv = {
      kind: "run",
      applied_at: "2026-08-02T11:00:00Z",
      actor: "dubiel",
      notes: "release-ralph fired on the ralph/** merge",
      merge_sha: sha,
      run: { workflow: "release-ralph.yml", id: 42, conclusion: "success", head_sha: sha },
    };
    expect(validateApplyEvidence(runEv, NOW_E)).toBeNull();
    expect(validateApplyEvidence({ ...runEv, run: { ...runEv.run, head_sha: "0000000000000000" } }, NOW_E))
      .toMatch(/!= merge_sha .* that run did not execute the merged code/);
    expect(validateApplyEvidence({ ...runEv, merge_sha: "" }, NOW_E)).toMatch(/requires "merge_sha"/);
    expect(validateApplyEvidence({ ...runEv, run: { ...runEv.run, conclusion: "failure" } }, NOW_E))
      .toMatch(/run\.conclusion must be "success"/);
    expect(validateApplyEvidence({ ...runEv, run: undefined }, NOW_E)).toMatch(/requires a "run" object/);
    // checks[] does NOT substitute for the run binding on kind=run
    expect(validateApplyEvidence({ ...runEv, run: undefined, checks: [{ exit_code: 0 }] }, NOW_E))
      .toMatch(/requires a "run" object/);
  });
});

describe("parseVerifyAfter", () => {
  it("reads the body marker and ignores absent/garbled ones", () => {
    expect(parseVerifyAfter("blah\n<!-- ralph-verify-after: 2026-08-08T00:00:00Z -->\nblah")?.toISOString())
      .toBe("2026-08-08T00:00:00.000Z");
    expect(parseVerifyAfter("no marker")).toBeNull();
    expect(parseVerifyAfter("<!-- ralph-verify-after: soon -->")).toBeNull();
    expect(parseVerifyAfter(null)).toBeNull();
  });
});

describe("apply close gate + reconcile routing", () => {
  const APPLY_ON = { enabled: true, label: APPLY_LABEL_DEFAULT, infraPaths: [".github/**"] };
  const evidenceComment = (over: Record<string, unknown> = {}) =>
    `${APPLY_EVIDENCE_MARKER}\n\n\`\`\`json\n${JSON.stringify({
      kind: "settings",
      applied_at: "2026-07-31T11:00:00Z",
      actor: "dubiel",
      notes: "it is live",
      checks: [{ cmd: "gh label list", exit_code: 0 }],
      ...over,
    })}\n\`\`\`\n`;

  let gh: FakeGh;
  let ctx: Ctx;
  beforeEach(() => {
    gh = new FakeGh();
    ctx = makeCtx(gh);
    ctx.cfg.apply = { ...APPLY_ON };
  });

  it("isApplyIssue is label membership, and is inert while the kind is disabled", () => {
    expect(isApplyIssue(ctx.cfg, ["ralph:apply"])).toBe(true);
    expect(isApplyIssue(ctx.cfg, ["bug"])).toBe(false);
    expect(isApplyIssue({ apply: { enabled: false, label: "ralph:apply", infraPaths: [] } }, ["ralph:apply"]))
      .toBe(false);
  });

  it("refuses Done on an unevidenced apply unit — and --why does NOT bypass it", () => {
    gh.issues.set(1, { number: 1, state: "In Review", labels: ["ralph:apply"], comments: [] });
    const issue = fetchIssue(ctx, 1);
    expect(() => transition(ctx, issue, "Done")).toThrow(RefusalError);
    expect(() => transition(ctx, issue, "Done")).toThrow(/deployed-and-verified evidence/);
    // --why exists for "completed without a merged PR" — the NORMAL case for an
    // apply unit — so honouring it here would be a one-flag bypass of the kind.
    expect(() => transition(ctx, issue, "Done", { why: "I definitely applied it" })).toThrow(RefusalError);
    // a MERGED PR is not an escape either: a merge is exactly what this refuses as proof
    gh.issues.set(2, {
      number: 2, state: "In Review", labels: ["ralph:apply"], comments: [], prs: [{ number: 9, merged: true }],
    });
    expect(() => transition(ctx, fetchIssue(ctx, 2), "Done")).toThrow(/deployed-and-verified evidence/);
    expect(gh.mutations.filter((m) => m.startsWith("setState"))).toEqual([]);
  });

  it("allows Done once shape-valid evidence is posted, with no merged PR and no --why", () => {
    gh.issues.set(1, { number: 1, state: "In Review", labels: ["ralph:apply"], comments: [evidenceComment()] });
    const after = transition(ctx, fetchIssue(ctx, 1), "Done");
    expect(after.state).toBe("Done");
    expect(gh.mutations).toContain("closeIssue(#1, COMPLETED)");
  });

  it("leaves ordinary ship issues exactly as they were — the gate binds to the label alone", () => {
    gh.issues.set(1, { number: 1, state: "In Review", labels: ["enhancement"], comments: [] });
    // still the pre-existing rule: no merged PR ⇒ --why required, and it works
    expect(() => transition(ctx, fetchIssue(ctx, 1), "Done")).toThrow(UsageError);
    expect(transition(ctx, fetchIssue(ctx, 1), "Done", { why: "shipped by hand" }).state).toBe("Done");
  });

  it("is fully inert when the repo has not opted in", () => {
    ctx.cfg.apply = { enabled: false, label: APPLY_LABEL_DEFAULT, infraPaths: [] };
    gh.issues.set(1, { number: 1, state: "In Review", labels: ["ralph:apply"], comments: [] });
    expect(transition(ctx, fetchIssue(ctx, 1), "Done", { why: "no apply kind here" }).state).toBe("Done");
  });

  it("reconcile REOPENS a UI-closed unevidenced apply unit to Human Needed", () => {
    gh.issues.set(1, {
      number: 1, state: "In Progress", issueState: "CLOSED", stateReason: "COMPLETED",
      labels: ["ralph:apply"], comments: [],
    });
    const msg = reconcile(ctx, 1);
    expect(msg).toMatch(/reopened to Human Needed/);
    expect(gh.mutations).toContain("reopenIssue");
    expect(gh.mutations).toContain("setState(#1, Human Needed)");
    // the reason is on the record, and it lands BEFORE the state write
    expect(gh.comments.at(-1)!.body).toMatch(/A merge is not an apply/);
    expect(gh.mutations.indexOf("addComment")).toBeLessThan(gh.mutations.indexOf("setState(#1, Human Needed)"));
  });

  it("reconcile accepts an EVIDENCED close as Done, and never second-guesses a NOT_PLANNED cancel", () => {
    gh.issues.set(1, {
      number: 1, state: "In Progress", issueState: "CLOSED", stateReason: "COMPLETED",
      labels: ["ralph:apply"], comments: [evidenceComment()],
    });
    expect(reconcile(ctx, 1)).toMatch(/→ "Done"/);

    gh.issues.set(2, {
      number: 2, state: "In Progress", issueState: "CLOSED", stateReason: "NOT_PLANNED",
      labels: ["ralph:apply"], comments: [],
    });
    expect(reconcile(ctx, 2)).toMatch(/→ "Canceled"/);
    expect(gh.mutations).not.toContain("setState(#2, Human Needed)");
  });
});

describe("doctor — apply sweep", () => {
  const applyCtx = (gh: FakeGh) => {
    const ctx = makeCtx(gh);
    ctx.cfg.apply = { enabled: true, label: APPLY_LABEL_DEFAULT, infraPaths: [] };
    return ctx;
  };
  const detail = (r: ReturnType<typeof doctor>, name: string) => r.checks.find((c) => c.name === name)!;

  it("flags an apply unit whose blocking work has landed — but not one that was never gated on a merge", () => {
    const gh = new FakeGh();
    gh.issues.set(1, {
      number: 1, state: "Backlog", labels: ["ralph:apply"],
      blockedBy: [{ number: 5, state: "CLOSED" }],
    });
    gh.issues.set(2, { number: 2, state: "Backlog", labels: ["ralph:apply"] }); // no dependency edge
    gh.issues.set(3, {
      number: 3, state: "Backlog", labels: ["ralph:apply"],
      blockedBy: [{ number: 6, state: "OPEN" }], // ship work still open
    });
    const c = detail(doctor(applyCtx(gh)), "merged-unapplied");
    expect(c.level).toBe("warn");
    expect(c.detail).toContain("#1←closed #5");
    expect(c.detail).not.toContain("#2");
    expect(c.detail).not.toContain("#3");
  });

  it("stays quiet until ralph-verify-after elapses, then says so", () => {
    const gh = new FakeGh();
    gh.issues.set(1, {
      number: 1, state: "Backlog", labels: ["ralph:apply"],
      body: "<!-- ralph-verify-after: 2026-08-08T00:00:00Z -->", // NOW is 2026-07-31
    });
    expect(detail(doctor(applyCtx(gh)), "apply-verify-elapsed").level).toBe("ok");

    gh.issues.set(2, {
      number: 2, state: "Backlog", labels: ["ralph:apply"],
      body: "<!-- ralph-verify-after: 2026-07-01T00:00:00Z -->",
    });
    const c = detail(doctor(applyCtx(gh)), "apply-verify-elapsed");
    expect(c.level).toBe("warn");
    expect(c.detail).toContain("#2");
    expect(c.detail).not.toContain("#1(");
  });

  it("merged-unapplied holds an item whose ralph-verify-after has not passed, and warns past it (GH-2124)", () => {
    const gh = new FakeGh();
    gh.issues.set(1, {
      number: 1, state: "Backlog", labels: ["ralph:apply"],
      blockedBy: [{ number: 5, state: "CLOSED" }],
      body: "<!-- ralph-verify-after: 2026-08-08T00:00:00Z -->", // NOW is 2026-07-31
    });
    const holdCheck = detail(doctor(applyCtx(gh)), "merged-unapplied");
    expect(holdCheck.level).toBe("ok");
    // the hold is printed, not silent — the measurement survives, only the marker is withheld
    expect(holdCheck.detail).toContain("#1(until 2026-08-08");

    gh.issues.set(1, {
      number: 1, state: "Backlog", labels: ["ralph:apply"],
      blockedBy: [{ number: 5, state: "CLOSED" }],
      body: "<!-- ralph-verify-after: 2026-07-01T00:00:00Z -->", // past
    });
    const c = detail(doctor(applyCtx(gh)), "merged-unapplied");
    expect(c.level).toBe("warn");
    expect(c.detail).toContain("#1←closed #5");
  });

  it("an unreadable body does NOT hold merged-unapplied — the warning stays loud", () => {
    const gh = new FakeGh();
    gh.issues.set(1, {
      number: 1, state: "Backlog", labels: ["ralph:apply"],
      blockedBy: [{ number: 5, state: "CLOSED" }],
      body: "<!-- ralph-verify-after: 2026-08-08T00:00:00Z -->", // future, but unreadable below
    });
    const inner = gh.exec;
    gh.exec = (argv, stdin) => {
      if (stdin?.includes("comments(last") && stdin.includes('"number":1')) {
        return { code: 1, stdout: "", stderr: "boom" };
      }
      return inner(argv, stdin);
    };
    const c = detail(doctor(applyCtx(gh)), "merged-unapplied");
    expect(c.level).toBe("warn");
    expect(c.detail).toContain("#1←closed #5");
  });

  it("apply-closed-unevidenced FAILS under --strict, excludes cancels, and --fix reopens", () => {
    const gh = new FakeGh();
    gh.issues.set(1, {
      number: 1, state: "Done", issueState: "CLOSED", stateReason: "COMPLETED",
      labels: ["ralph:apply"], comments: [],
    });
    gh.issues.set(2, {
      number: 2, state: "Canceled", issueState: "CLOSED", stateReason: "NOT_PLANNED",
      labels: ["ralph:apply"], comments: [],
    });
    const warn = detail(doctor(applyCtx(gh)), "apply-closed-unevidenced");
    expect(warn.level).toBe("warn");
    expect(warn.detail).toContain("#1");
    expect(warn.detail).not.toContain("#2");

    const strict = doctor(applyCtx(gh), { strict: true });
    expect(detail(strict, "apply-closed-unevidenced").level).toBe("fail");
    expect(strict.ok).toBe(false);

    const gh2 = new FakeGh();
    gh2.issues.set(1, {
      number: 1, state: "Done", issueState: "CLOSED", stateReason: "COMPLETED",
      labels: ["ralph:apply"], comments: [],
    });
    doctor(applyCtx(gh2), { fix: true });
    expect(gh2.mutations).toContain("setState(#1, Human Needed)");
  });

  it("an evidenced close is silent — no false positive on honest work", () => {
    const gh = new FakeGh();
    gh.issues.set(1, {
      number: 1, state: "Done", issueState: "CLOSED", stateReason: "COMPLETED",
      labels: ["ralph:apply"],
      comments: [
        `${APPLY_EVIDENCE_MARKER}\n\`\`\`json\n${JSON.stringify({
          kind: "observation", applied_at: "2026-07-30T00:00:00Z", actor: "me",
          notes: "cron fired", checks: [{ exit_code: 0 }],
        })}\n\`\`\``,
      ],
    });
    expect(detail(doctor(applyCtx(gh), { strict: true }), "apply-closed-unevidenced").level).toBe("ok");
  });
});

describe("doctor — state smells (GH-1715)", () => {
  const smell = (r: ReturnType<typeof doctor>, name: string) => r.checks.find((c) => c.name === name)!;
  const evicted = (holder = "gone@host") =>
    `\`board\`: stale claim by \`${holder}\` (since 2026-07-30T00:00:00Z) ` +
    `evicted by \`me@test\` after TTL 120 min.`;
  const released = (holder = "gone@host") =>
    `\`board doctor --fix\`: stale claim by \`${holder}\` released; returned to Backlog.`;
  const escalated = (why: string) => `**Decision needed** (\`board\` by \`me@test\`):\n\n${why}`;

  // The whole design rests on counting comments the machine itself writes. If
  // those writers change their wording, these patterns go silently blind — so
  // the fixtures above are pinned against text the REAL writers produce here,
  // not against hand-copied strings.
  it("the evidence patterns match what transition() and doctor --fix actually post", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    gh.issues.set(1, {
      number: 1, state: "In Progress",
      claim: encodeClaim("gone@host", new Date(NOW.getTime() - 999 * 60_000)),
    });
    transition(ctx, fetchIssue(ctx, 1), "In Progress", { steal: true });
    const eviction = gh.comments.at(-1)!.body;
    expect(CLAIM_EXPIRY_EVIDENCE.test(eviction), eviction).toBe(true);

    const gh2 = new FakeGh();
    gh2.issues.set(2, {
      number: 2, state: "In Progress",
      claim: encodeClaim("gone@host", new Date(NOW.getTime() - 999 * 60_000)),
    });
    doctor(makeCtx(gh2), { fix: true });
    const release = gh2.comments.at(-1)!.body;
    expect(CLAIM_EXPIRY_EVIDENCE.test(release), release).toBe(true);

    const gh3 = new FakeGh();
    const ctx3 = makeCtx(gh3);
    gh3.issues.set(3, { number: 3, state: "In Progress", claim: encodeClaim("me@test", NOW) });
    transition(ctx3, fetchIssue(ctx3, 3), "Human Needed", { why: "which API?" });
    const escalation = gh3.comments.at(-1)!.body;
    expect(ESCALATION_EVIDENCE.test(escalation), escalation).toBe(true);
    // …and does NOT match the other --why headers, which are not escalations.
    expect(ESCALATION_EVIDENCE.test("**Parked** (`board` by `me@test`):\n\nlater")).toBe(false);
    expect(ESCALATION_EVIDENCE.test("**Canceled** (`board` by `me@test`):\n\nno")).toBe(false);
  });

  it("tend-proposal-stale: fires only past the threshold, counts undated proposals, stays advisory", () => {
    const gh = new FakeGh();
    const at = (n: number) =>
      `${TEND_PROPOSAL_MARKER}\n\`\`\`json\n{"action":"close-as-delivered","at":"${new Date(NOW.getTime() - n * 86_400_000).toISOString()}"}\n\`\`\``;
    gh.issues.set(1, { number: 1, state: "Backlog", comments: [at(9)] }); // past 7d
    gh.issues.set(2, { number: 2, state: "Backlog", comments: [at(2)] }); // still fresh
    gh.issues.set(3, { number: 3, state: "Backlog", comments: [`${TEND_PROPOSAL_MARKER}\nno payload`] });
    gh.issues.set(4, { number: 4, state: "Backlog", comments: ["unrelated"] });
    const r = doctor(makeCtx(gh));
    const c = smell(r, "tend-proposal-stale");
    expect(c.level).toBe("info"); // advisory by construction — never a warn, never a fail
    expect(c.detail).toContain("#1(9d)");
    expect(c.detail).toContain("#3(undated)");
    expect(c.detail).not.toContain("#2");
    expect(c.detail).not.toContain("#4");
    expect(doctor(makeCtx(gh), { strict: true }).checks.find((x) => x.name === "tend-proposal-stale")!.level).toBe(
      "info",
    );
  });

  it("counts repeated claim expiry, and holds fire below the threshold", () => {
    const gh = new FakeGh();
    gh.issues.set(1, { number: 1, state: "Backlog", comments: [evicted(), released()] }); // 2
    gh.issues.set(2, { number: 2, state: "Backlog", comments: [evicted()] }); // 1 — one bad tick happens
    gh.issues.set(3, { number: 3, state: "Backlog", comments: [] });
    const c = smell(doctor(makeCtx(gh)), "repeated-claim-expiry");
    expect(c.level).toBe("info");
    expect(c.detail).toContain("#1(2 expired claims)");
    expect(c.detail).toContain("board create --backlog --parent N");
    expect(c.detail).not.toContain("#2(");
    expect(c.detail).not.toContain("#3(");
  });

  it("counts Human Needed ping-pong, and holds fire below the threshold", () => {
    const gh = new FakeGh();
    gh.issues.set(1, {
      number: 1, state: "Human Needed",
      comments: [escalated("a?"), escalated("b?"), escalated("c?")],
    });
    gh.issues.set(2, { number: 2, state: "Human Needed", comments: [escalated("a?"), escalated("b?")] });
    const c = smell(doctor(makeCtx(gh)), "escalation-ping-pong");
    expect(c.level).toBe("info");
    expect(c.detail).toContain("#1(escalated 3×)");
    expect(c.detail).toContain("not converging");
    expect(c.detail).not.toContain("#2(");
  });

  it("flags a long-quiet In Review, but not a fresh one, a moving PR, or another state", () => {
    const gh = new FakeGh();
    const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
    gh.issues.set(1, { number: 1, state: "In Review", stateUpdatedAt: daysAgo(9), prs: [{ number: 90, merged: false, updatedAt: daysAgo(10) }] });
    gh.issues.set(2, { number: 2, state: "In Review", stateUpdatedAt: daysAgo(3), prs: [{ number: 91, merged: false, updatedAt: daysAgo(3) }] });
    gh.issues.set(3, { number: 3, state: "In Review", stateUpdatedAt: daysAgo(9), prs: [{ number: 92, merged: false, updatedAt: daysAgo(1) }] });
    gh.issues.set(4, { number: 4, state: "Backlog", stateUpdatedAt: daysAgo(90) }); // age alone is not a smell
    gh.issues.set(5, { number: 5, state: "In Review", stateUpdatedAt: daysAgo(20) }); // never got a PR at all
    const c = smell(doctor(makeCtx(gh)), "review-stalled");
    expect(c.level).toBe("info");
    expect(c.detail).toContain("#1(9d, PR quiet)");
    expect(c.detail).toContain("#5(20d, no linked PR)");
    for (const n of ["#2(", "#3(", "#4("]) expect(c.detail).not.toContain(n);
  });

  it("says nothing at all on a board with no observed failures", () => {
    const gh = new FakeGh();
    gh.issues.set(1, { number: 1, state: "Backlog" });
    const r = doctor(makeCtx(gh));
    for (const n of ["repeated-claim-expiry", "escalation-ping-pong", "review-stalled"]) {
      expect(smell(r, n).level, n).toBe("ok");
      expect(smell(r, n).detail, n).toBe("none");
    }
  });

  it("is advisory by construction: the verdict is identical with and without the smells", () => {
    const smelly = new FakeGh();
    smelly.issues.set(1, {
      number: 1, state: "Human Needed",
      comments: [evicted(), evicted(), escalated("a?"), escalated("b?"), escalated("c?")],
    });
    const clean = new FakeGh();
    clean.issues.set(1, { number: 1, state: "Human Needed", comments: [] });
    for (const strict of [false, true]) {
      const r = doctor(makeCtx(smelly), { strict });
      expect(smell(r, "repeated-claim-expiry").level).toBe("info");
      expect(smell(r, "escalation-ping-pong").level).toBe("info");
      expect(r.checks.filter((c) => c.level === "fail").map((c) => c.name)).toEqual(
        doctor(makeCtx(clean), { strict }).checks.filter((c) => c.level === "fail").map((c) => c.name),
      );
    }
    // …and --fix writes nothing on their account
    const gh2 = new FakeGh();
    gh2.issues.set(1, { number: 1, state: "Human Needed", comments: [evicted(), evicted()] });
    doctor(makeCtx(gh2), { fix: true });
    expect(gh2.mutations).toEqual([]);
  });

  it("a history read that fails degrades to info — it must never change the exit code", () => {
    const gh = new FakeGh();
    gh.issues.set(1, { number: 1, state: "Backlog" });
    const ctx = makeCtx(gh);
    const baseline = doctor(makeCtx(gh)).ok;
    const inner = gh.exec;
    gh.exec = (argv, stdin) =>
      stdin?.includes("a0: issue(number")
        ? { code: 1, stdout: "", stderr: "simulated history failure" }
        : inner(argv, stdin);
    const r = doctor(ctx);
    for (const n of ["repeated-claim-expiry", "escalation-ping-pong", "review-stalled"]) {
      expect(smell(r, n).level, n).toBe("info");
      expect(smell(r, n).detail, n).toContain("not evaluated");
    }
    expect(r.ok).toBe(baseline);
    // the sweep itself survived — a history failure is not an item-sweep failure
    expect(r.checks.find((c) => c.name === "item-sweep")).toBeUndefined();
    expect(r.checks.find((c) => c.name === "stale-claims")).toBeDefined();
  });

  it("batches history across round trips — the 25th item is read like the 1st", () => {
    const gh = new FakeGh();
    for (let n = 1; n <= 25; n++) gh.issues.set(n, { number: n, state: "Backlog" });
    gh.issues.get(25)!.comments = [evicted(), released()];
    const ctx = makeCtx(gh);
    let historyQueries = 0;
    const inner = gh.exec;
    gh.exec = (argv, stdin) => {
      if (stdin?.includes("a0: issue(number")) historyQueries++;
      return inner(argv, stdin);
    };
    const c = smell(doctor(ctx), "repeated-claim-expiry");
    expect(c.detail).toContain("#25(2 expired claims)");
    // 25 items: 2 history chunks of 20 (smells) + 1 comments-only trail
    // chunk of 100 (GH-2136 deps-unwired dismissal read) — not 25 round trips
    expect(historyQueries).toBe(3);
  });

  it("one failed history chunk does not kill the others — smells evaluate over surviving chunks", () => {
    const gh = new FakeGh();
    for (let n = 1; n <= 25; n++) gh.issues.set(n, { number: n, state: "Backlog" });
    // The smelly issue sits in chunk 2; chunk 1's round trip fails.
    gh.issues.get(25)!.comments = [evicted(), released()];
    const ctx = makeCtx(gh);
    let historyQueries = 0;
    const inner = gh.exec;
    gh.exec = (argv, stdin) => {
      if (stdin?.includes("a0: issue(number")) {
        historyQueries++;
        if (historyQueries === 1)
          return { code: 1, stdout: "", stderr: "simulated transient failure" };
      }
      return inner(argv, stdin);
    };
    const r = doctor(ctx);
    const c = smell(r, "repeated-claim-expiry");
    expect(c.detail).toContain("#25(2 expired claims)"); // chunk 2's data survived
    expect(c.detail).not.toContain("not evaluated");
  });
});

describe("state-smell thresholds", () => {
  it("defaults are conservative and every one is env-tunable", () => {
    expect(parseSmellThresholds({})).toEqual({
      claimExpiries: 2,
      escalations: 3,
      reviewDays: 7,
      proposalDays: 7,
      intakeDays: 14,
    });
    expect(
      parseSmellThresholds({
        RALPH_SMELL_CLAIM_EXPIRIES: "4",
        RALPH_SMELL_ESCALATIONS: "5",
        RALPH_SMELL_REVIEW_DAYS: "14",
        RALPH_SMELL_PROPOSAL_DAYS: "3",
        RALPH_SMELL_INTAKE_DAYS: "30",
      }),
    ).toEqual({ claimExpiries: 4, escalations: 5, reviewDays: 14, proposalDays: 3, intakeDays: 30 });
  });

  it("a bad value warns and falls back — an advisory threshold never fails the sweep", () => {
    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(parseSmellThresholds({ RALPH_SMELL_REVIEW_DAYS: "one week" })).toEqual(SMELL_DEFAULTS);
    expect(parseSmellThresholds({ RALPH_SMELL_ESCALATIONS: "0" }).escalations).toBe(3);
    expect(warn.mock.calls.map((c) => String(c[0])).join("")).toContain("RALPH_SMELL_REVIEW_DAYS");
    warn.mockRestore();
  });

  it("a raised threshold silences a board that would otherwise be flagged", () => {
    const gh = new FakeGh();
    gh.issues.set(1, {
      number: 1, state: "Backlog",
      comments: ["`board`: stale claim by `a` evicted", "`board`: stale claim by `b` evicted"],
    });
    const ctx = makeCtx(gh);
    ctx.cfg.smells = { ...SMELL_DEFAULTS, claimExpiries: 3 };
    const c = doctor(ctx).checks.find((x) => x.name === "repeated-claim-expiry")!;
    expect(c.level).toBe("ok");
  });
});

describe("countEvidence / reviewStall", () => {
  it("counts comments, not occurrences — one noisy comment is one event", () => {
    expect(countEvidence(["x stale claim by y stale claim by z"], CLAIM_EXPIRY_EVIDENCE)).toBe(1);
    expect(countEvidence([], CLAIM_EXPIRY_EVIDENCE)).toBe(0);
    expect(countEvidence(["nothing here"], ESCALATION_EVIDENCE)).toBe(0);
  });

  it("stays silent when it cannot measure rather than guessing from another clock", () => {
    expect(reviewStall({ stateUpdatedAt: null, prActivityAt: [] }, NOW, 7)).toBeNull();
    expect(reviewStall({ stateUpdatedAt: "not-a-date", prActivityAt: [] }, NOW, 7)).toBeNull();
    // exactly at the threshold counts (>=, like claim staleness)
    const at = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
    expect(reviewStall({ stateUpdatedAt: at(7), prActivityAt: [] }, NOW, 7)).toEqual({ days: 7, prs: 0 });
    expect(reviewStall({ stateUpdatedAt: at(6.9), prActivityAt: [] }, NOW, 7)).toBeNull();
    // an unparseable PR timestamp is not "activity" — it is nothing
    expect(reviewStall({ stateUpdatedAt: at(9), prActivityAt: ["garbage"] }, NOW, 7)).toEqual({ days: 9, prs: 1 });
  });
});

describe("applyEvidenceFailure", () => {
  it("is the one question the close gate and doctor both ask", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    gh.issues.set(1, { number: 1, state: "Backlog", comments: [] });
    expect(applyEvidenceFailure(ctx, 1)).toMatch(/no <!-- ralph-apply-evidence:v1 -->/);
  });
});

describe("priority is writable through the CLI (GH-1789)", () => {
  it("create --priority sets it, so a filed issue is reachable by next", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    const issue = createIssue(ctx, { title: "urgent", priority: "P0", estimate: "S", state: "Backlog" });
    expect(issue.priority).toBe("P0");
    expect(gh.mutations).toContain(`setPriority(#${issue.number}, P0)`);
  });

  it("an unknown priority is refused BEFORE the issue exists", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    expect(() => createIssue(ctx, { title: "x", priority: "P9", state: "Intake" })).toThrow(UsageError);
    expect(gh.mutations.filter((m) => m.startsWith("createIssue"))).toEqual([]);
    expect(gh.issues.size).toBe(0);
  });

  it("validates against the LIVE options, not a hardcoded P0..P3", () => {
    const gh = new FakeGh();
    gh.omitFields = ["Priority"];
    gh.createdFields.push({ name: "Priority", dataType: "SINGLE_SELECT", options: ["Now", "Later"] });
    const ctx = makeCtx(gh);
    const issue = createIssue(ctx, { title: "x", priority: "Now", state: "Intake" }); // a scheme setup never seeded is accepted
    expect(issue.priority).toBe("Now");
    expect(gh.mutations).toContain(`setPriority(#${issue.number}, Now)`);
    expect(() => createIssue(ctx, { title: "y", priority: "P0", state: "Intake" })).toThrow(/Now, Later/);
  });

  it("the setter corrects a mis-filed backlog item, and --clear removes it", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    gh.issues.set(1, { number: 1, state: "Backlog", priority: null });
    expect(setPriority(ctx, 1, "P1").priority).toBe("P1");
    expect(setPriority(ctx, 1, null).priority).toBeNull();
    expect(gh.mutations).toContain("clearField(#1, F_priority)");
  });

  it("the setter refuses an unknown option and an archived item", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    gh.issues.set(1, { number: 1, state: "Backlog" });
    gh.issues.set(2, { number: 2, state: "Backlog", archived: true });
    expect(() => setPriority(ctx, 1, "URGENT")).toThrow(UsageError);
    expect(() => setPriority(ctx, 2, "P0")).toThrow(RefusalError);
    expect(gh.mutations.filter((m) => m.startsWith("setPriority"))).toEqual([]);
  });

  it("`priority` is scope-gated like every other mutation", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    ctx.exec = (argv, stdin) => {
      if (argv.join(" ").includes("remote get-url"))
        return { code: 0, stdout: "git@github.com:someone-else/other.git\n", stderr: "" };
      return gh.exec(argv, stdin);
    };
    gh.issues.set(1, { number: 1, state: "Backlog" });
    expect(() => run(["priority", "1", "P0"], ctx)).toThrow(RefusalError);
  });

  it("--clear never swallows the issue number", () => {
    expect(parseArgs(["--clear", "1789"]).positional).toEqual(["1789"]);
  });

  /** A board whose LIVE Priority options are Now/Later, with a persistent field
   *  cache still holding the seeded P0..P3 — the stale-schema shape. */
  const staleP0P3Cache = (ctx: Ctx) =>
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
          Priority: {
            id: "F_Priority", dataType: "SINGLE_SELECT",
            options: Object.fromEntries(["P0", "P1", "P2", "P3"].map((p) => [p, `P_${p}`])),
          },
        },
        fetchedAt: "2026-01-01T00:00:00Z",
      }),
    );

  it("an option the cache holds but GitHub has REMOVED is caught before the issue exists", () => {
    // The hole a cache-satisfied check cannot see: `satisfied()` only detects a
    // GAINED option. Without the forced refresh, "P0" pre-validates clean and
    // the field write fails after createIssue — the orphan this gate prevents.
    const gh = new FakeGh();
    gh.omitFields = ["Priority"];
    gh.createdFields.push({ name: "Priority", dataType: "SINGLE_SELECT", options: ["Now", "Later"] });
    const ctx = makeCtx(gh);
    staleP0P3Cache(ctx);
    expect(() => createIssue(ctx, { title: "x", priority: "P0", state: "Intake" })).toThrow(/Now, Later/);
    expect(gh.issues.size).toBe(0);
    expect(gh.mutations.filter((m) => m.startsWith("createIssue"))).toEqual([]);
  });

  it("the setter refuses a removed option too, and writes nothing", () => {
    const gh = new FakeGh();
    gh.omitFields = ["Priority"];
    gh.createdFields.push({ name: "Priority", dataType: "SINGLE_SELECT", options: ["Now", "Later"] });
    const ctx = makeCtx(gh);
    gh.issues.set(1, { number: 1, state: "Backlog" });
    staleP0P3Cache(ctx);
    expect(() => setPriority(ctx, 1, "P0")).toThrow(/Now, Later/);
    expect(gh.mutations.filter((m) => m.startsWith("setPriority"))).toEqual([]);
    staleP0P3Cache(ctx);
    expect(setPriority(ctx, 1, "Now").priority).toBe("Now"); // the live option is accepted
  });

  it("an accepted custom priority is ORDERABLE by next, not just writable", () => {
    // End-to-end on the very scheme the write path accepts: if `next` couldn't
    // rank it, accepting it would be a trap.
    const gh = new FakeGh();
    gh.omitFields = ["Priority"];
    gh.createdFields.push({ name: "Priority", dataType: "SINGLE_SELECT", options: ["Now", "Later"] });
    const ctx = makeCtx(gh);
    gh.issues.set(1, { number: 1, state: "Backlog", priority: null }); // oldest, unprioritized
    gh.issues.set(2, { number: 2, state: "Backlog", priority: "Later" });
    gh.issues.set(3, { number: 3, state: "Backlog", priority: "Now" });
    const said: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((s) => {
      said.push(String(s));
      return true;
    });
    try {
      run(["next"], ctx);
    } finally {
      spy.mockRestore();
    }
    expect(said.join("")).toMatch(/^next: #3\b/m);
  });

  /** Live options in a deliberate order, with a cache holding the OPPOSITE. */
  const reorderedBoard = () => {
    const gh = new FakeGh();
    gh.omitFields = ["Priority"];
    gh.createdFields.push({ name: "Priority", dataType: "SINGLE_SELECT", options: ["Later", "Now"] });
    const ctx = makeCtx(gh);
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
          // The obsolete order: Now first. Nothing about a REORDER is visible to
          // a present/absent field check, so only a live read can catch it.
          Priority: {
            id: "F_Priority", dataType: "SINGLE_SELECT",
            options: { Now: "Priority_Now", Later: "Priority_Later" },
          },
        },
        fetchedAt: "2026-01-01T00:00:00Z",
      }),
    );
    gh.issues.set(1, { number: 1, state: "Backlog", priority: "Now" });
    gh.issues.set(2, { number: 2, state: "Backlog", priority: "Later" });
    return { gh, ctx };
  };

  const sayNext = (ctx: Ctx) => {
    const said: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((s) => {
      said.push(String(s));
      return true;
    });
    try {
      run(["next"], ctx);
    } finally {
      spy.mockRestore();
    }
    return said.join("");
  };

  it("next ranks by the LIVE option order — a reorder the field cache cannot notice", () => {
    // Options reordered to [Later, Now] in GitHub; the cache still says
    // [Now, Later]. A cached read would steer the queue by the obsolete scheme
    // indefinitely, since no mutation has to happen to refresh it.
    const { ctx } = reorderedBoard();
    expect(sayNext(ctx)).toMatch(/^next: #2\b/m);
  });

  it("an unrefreshable schema degrades to the cached order and still answers", () => {
    // Fail-soft direction: ordering input is advisory, a `next` that cannot
    // answer stops the loop.
    const { gh, ctx } = reorderedBoard();
    const inner = gh.exec;
    ctx.exec = (argv, stdin) => {
      // Refuse ONLY the schema read (its own fragment names it — and the query
      // text arrives on stdin, not argv); the item walk runs normally, so this
      // isolates the refresh failure.
      if (`${argv.join(" ")} ${stdin ?? ""}`.includes("fragment pf on ProjectV2"))
        return { code: 1, stdout: "", stderr: "simulated schema read failure" };
      return inner(argv, stdin);
    };
    const warns: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((s) => {
      warns.push(String(s));
      return true;
    });
    let text: string;
    try {
      text = sayNext(ctx);
    } finally {
      spy.mockRestore();
    }
    expect(warns.join("")).toMatch(/not refreshed/);
    expect(text).toMatch(/^next: #1\b/m); // the cached [Now, Later] order
  });

  it("integer-like option names keep their DECLARED order, which Object.keys destroys", () => {
    // A board declaring [10, 2] means 10 first. JS enumerates integer-like keys
    // numerically ahead of string keys, so reconstructing the order from the
    // option MAP yields [2, 10] — and no refresh can repair it, because the
    // order is lost the moment options become object properties.
    expect(Object.keys(Object.fromEntries([["10", "a"], ["2", "b"], ["P1", "c"]]))).toEqual(["2", "10", "P1"]);
    const gh = new FakeGh();
    gh.omitFields = ["Priority"];
    gh.createdFields.push({ name: "Priority", dataType: "SINGLE_SELECT", options: ["10", "2", "P1"] });
    const ctx = makeCtx(gh);
    expect(priorityOptionOrder(ctx)).toEqual(["10", "2", "P1"]); // declared, not enumerated
    gh.issues.set(1, { number: 1, state: "Backlog", priority: "2" });
    gh.issues.set(2, { number: 2, state: "Backlog", priority: "10" });
    // #2 holds the board's FIRST option, so it heads the queue despite the
    // higher issue number and the lower-looking name.
    expect(sayNext(ctx)).toMatch(/^next: #2\b/m);
  });

  it("a priority value absent from the cached options is EVIDENCE of a moved schema, and refreshes", () => {
    // The rename half of the freshness problem, closed without a timer: the
    // ranker's own input proves the cache is wrong. The cache here is fresh by
    // age, so only the evidence can trigger the refresh.
    const gh = new FakeGh();
    gh.omitFields = ["Priority"];
    gh.createdFields.push({ name: "Priority", dataType: "SINGLE_SELECT", options: ["Soon", "Later"] });
    const ctx = makeCtx(gh);
    const staleNames = (extra: Record<string, unknown> = {}) =>
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
            // Pre-rename snapshot: "Now" has since become "Soon".
            Priority: {
              id: "F_Priority", dataType: "SINGLE_SELECT",
              options: { Now: "Priority_Now", Later: "Priority_Later" },
              optionOrder: ["Now", "Later"],
              ...extra,
            },
          },
          fetchedAt: NOW.toISOString(), // fresh by age — evidence is the only trigger
        }),
      );
    staleNames();
    expect(priorityOptionOrder(ctx, { values: ["Soon"] })).toEqual(["Soon", "Later"]);
    // Without that evidence, a fresh-by-age cache is served as-is — no refresh,
    // which is what keeps `next` at its pinned warm round-trip count.
    staleNames();
    expect(priorityOptionOrder(ctx, { values: ["Later", null] })).toEqual(["Now", "Later"]);
    // --fresh is the operator's deterministic override of any Δ.
    staleNames();
    expect(priorityOptionOrder(ctx, { values: ["Later"], fresh: true })).toEqual(["Soon", "Later"]);
  });

  it("a CONFIRMED-obsolete value stops being evidence — one refresh, not one per read", () => {
    // The failure mode this closes: an item keeping a removed value is a case
    // the ranker supports on purpose, so "absent from options" stays true even
    // straight after a successful refresh. Left alone, every warm read pays a
    // schema query forever — the exact bound the evidence trigger exists to
    // protect. The assertions here are on COST, not just on the answer.
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    const schemaReads = () => gh.queries.filter((q) => q.includes("fragment pf on ProjectV2")).length;
    const P = ["P0", "P1", "P2", "P3"];

    // Warm the cache, then keep re-stamping it fresh so the AGE trigger can
    // never be what fires — only evidence.
    priorityOptionOrder(ctx);
    const cacheFile = join(ctx.cacheDir, "board-cdubiel08-ralph-hero-13.json");
    const reheat = () => {
      const c = JSON.parse(readFileSync(cacheFile, "utf8"));
      c.fetchedAt = NOW.toISOString();
      writeFileSync(cacheFile, JSON.stringify(c));
    };
    reheat();
    const before = schemaReads();

    // "P9" is not an option and never will be. First sighting is real evidence.
    expect(priorityOptionOrder(ctx, { values: ["P9"] })).toEqual(P);
    expect(schemaReads()).toBe(before + 1);
    expect(JSON.parse(readFileSync(cacheFile, "utf8")).unresolvedPriorities).toEqual(["P9"]);

    // Every subsequent read must be FREE: the value is confirmed obsolete.
    reheat();
    for (let i = 0; i < 5; i++) expect(priorityOptionOrder(ctx, { values: ["P9", "P1", null] })).toEqual(P);
    expect(schemaReads()).toBe(before + 1);

    // A DIFFERENT unexplained value is still news — suppression is per value,
    // never a blanket "stop looking".
    reheat();
    priorityOptionOrder(ctx, { values: ["Whatever"] });
    expect(schemaReads()).toBe(before + 2);
    expect(JSON.parse(readFileSync(cacheFile, "utf8")).unresolvedPriorities).toEqual(["P9", "Whatever"]);

    // The obsolete value still ranks BEHIND every live option (suppressing the
    // refresh must not change the ranking contract).
    const q = (n: number, priority: string): QueueItem => ({
      number: n, repo: "cdubiel08/ralph-hero", title: `t${n}`, state: "Backlog", priority,
      hasParent: false, parentNumber: null, openBlockers: [], openBlockerLabels: [],
      blockersTruncated: false, fieldValuesTruncated: false, claim: null, claimRaw: null,
      labels: [], labelsTruncated: false, closedBlockers: [],
    });
    expect(rankNext([q(1, "P9"), q(9, "P3")], [], P).eligible.map((i) => i.number)).toEqual([9, 1]);
  });

  it("a host repo's TEXT/NUMBER Priority field is never written and never CLEARED", () => {
    // `setup` preserves an existing field, so a board can carry a custom
    // Priority field of another type. The set path merely failed confusingly;
    // --clear ERASED that field's value and then printed "(none)", because
    // issue reads only recognise a single-select Priority. Destructive and
    // invisible — so the guard is on dataType, before either write.
    for (const dataType of ["TEXT", "NUMBER"]) {
      const gh = new FakeGh();
      gh.omitFields = ["Priority"];
      gh.createdFields.push({ name: "Priority", dataType });
      const ctx = makeCtx(gh);
      gh.issues.set(1, { number: 1, state: "Backlog" });

      expect(() => setPriority(ctx, 1, "P0")).toThrow(new RegExp(`${dataType}, not SINGLE_SELECT`));
      expect(() => setPriority(ctx, 1, null)).toThrow(new RegExp(`${dataType}, not SINGLE_SELECT`));
      expect(() => createIssue(ctx, { title: "x", priority: "P0", state: "Intake" })).toThrow(UsageError);
      // Nothing was written, and above all nothing was CLEARED.
      expect(gh.mutations.filter((m) => m.includes("clearField") || m.startsWith("setPriority"))).toEqual([]);
      expect(gh.issues.size).toBe(1); // the create never happened
    }
  });

  it("a suppressed name that becomes an option again stops being suppressed", () => {
    // `Soon` is removed (so it lands in the suppression list), and later an
    // admin renames `Now` to `Soon`. The union would call the now-VALID value
    // known-obsolete, skip the evidence refresh, and rank live work as stale.
    const gh = new FakeGh();
    gh.omitFields = ["Priority"];
    gh.createdFields.push({ name: "Priority", dataType: "SINGLE_SELECT", options: ["Now", "Later"] });
    const ctx = makeCtx(gh);
    const cacheFile = join(ctx.cacheDir, "board-cdubiel08-ralph-hero-13.json");
    const read = () => JSON.parse(readFileSync(cacheFile, "utf8"));

    // Learn "Soon" as obsolete against the Now/Later schema.
    expect(priorityOptionOrder(ctx, { values: ["Soon"] })).toEqual(["Now", "Later"]);
    expect(read().unresolvedPriorities).toEqual(["Soon"]);

    // The admin renames Now → Soon. Any refresh must drop the suppression.
    gh.createdFields.length = 0;
    gh.createdFields.push({ name: "Priority", dataType: "SINGLE_SELECT", options: ["Soon", "Later"] });
    expect(priorityOptionOrder(ctx, { values: ["Soon"], fresh: true })).toEqual(["Soon", "Later"]);
    expect(read().unresolvedPriorities ?? []).toEqual([]); // pruned, not carried

    // And it now ranks as the FIRST option rather than as a stale value.
    const q = (n: number, priority: string): QueueItem => ({
      number: n, repo: "cdubiel08/ralph-hero", title: `t${n}`, state: "Backlog", priority,
      hasParent: false, parentNumber: null, openBlockers: [], openBlockerLabels: [],
      blockersTruncated: false, fieldValuesTruncated: false, claim: null, claimRaw: null,
      labels: [], labelsTruncated: false, closedBlockers: [],
    });
    const order = priorityOptionOrder(ctx, { values: ["Soon", "Later"] });
    expect(rankNext([q(1, "Later"), q(2, "Soon")], [], order).eligible.map((i) => i.number)).toEqual([2, 1]);
  });

  it("the recovery command quotes a custom option name containing spaces", () => {
    // `board priority 7 High Priority` would split, and `board priority` takes
    // only the first word — potentially setting a DIFFERENT valid option.
    const gh = new FakeGh();
    gh.omitFields = ["Priority"];
    gh.createdFields.push({ name: "Priority", dataType: "SINGLE_SELECT", options: ["High Priority", "High"] });
    const ctx = makeCtx(gh);
    const inner = gh.exec;
    ctx.exec = (argv, stdin) => {
      if (stdin?.includes("updateProjectV2ItemFieldValue") && stdin.includes("Priority_High Priority"))
        return { code: 1, stdout: "", stderr: "simulated priority write failure" };
      return inner(argv, stdin);
    };
    let err: Error | null = null;
    try {
      createIssue(ctx, { title: "x", priority: "High Priority", state: "Intake" });
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toContain(`board priority`);
    expect(err!.message).toContain(`'High Priority'`); // quoted, so it round-trips
    expect(err!.message).not.toMatch(/board priority \d+ High Priority`/); // never bare
  });

  it("a cache predating optionOrder is STALE, not usable — the upgrade path integer names would break", () => {
    // The legacy-migration hole: a cache written by the previous version less
    // than an hour ago has no optionOrder, so the map fallback reverses a
    // declared ["10","2"] — and the evidence trigger cannot catch it, because
    // both values ARE in the map, so nothing looks unexplained. `next` would
    // pick the wrong work until the age ceiling expired.
    const gh = new FakeGh();
    gh.omitFields = ["Priority"];
    gh.createdFields.push({ name: "Priority", dataType: "SINGLE_SELECT", options: ["10", "2"] });
    const ctx = makeCtx(gh);
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
          // Previous version's shape: options map, NO optionOrder.
          Priority: { id: "F_Priority", dataType: "SINGLE_SELECT", options: { "10": "P_10", "2": "P_2" } },
        },
        fetchedAt: NOW.toISOString(), // fresh by age, and no value looks unknown
      }),
    );
    // Declared order, because the legacy shape forced a refresh — not the
    // map order ["2","10"] that Object.keys would have produced.
    expect(priorityOptionOrder(ctx, { values: ["10", "2"] })).toEqual(["10", "2"]);
  });

  it("create applies the REST of the requested setup before reporting a priority failure", () => {
    // `create --apply --priority …` used to throw the moment the priority write
    // failed, skipping labels/estimate/parent — so the issue could end up
    // without its apply label while the error told the operator to fix only
    // Priority. Following that recovery would not restore the requested shape.
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    const inner = gh.exec;
    const edits: string[][] = [];
    ctx.exec = (argv, stdin) => {
      if (argv[0] === "gh" && argv[1] === "issue" && argv[2] === "edit") {
        edits.push(argv);
        return { code: 0, stdout: "", stderr: "" }; // the label write SUCCEEDS
      }
      // Fail ONLY the Priority field write.
      if (stdin?.includes("updateProjectV2ItemFieldValue") && stdin.includes("P_P0"))
        return { code: 1, stdout: "", stderr: "simulated priority write failure" };
      return inner(argv, stdin);
    };
    let err: Error | null = null;
    try {
      createIssue(ctx, { title: "infra", priority: "P0", estimate: "S", labels: ["ralph:apply"], state: "Backlog" });
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/was created/);
    expect(err!.message).toMatch(/board priority \d+ P0/); // the repair command
    // The apply label DID land despite the priority failure — the whole point.
    expect(edits[0]).toContain("--add-label");
    expect(edits[0]).toContain("ralph:apply");
    // …and so did the estimate: the failure no longer aborts remaining setup.
    expect(gh.mutations.join(" ")).toMatch(/setEstimate\(#\d+, S\)/);
  });

  it("a create failure names EVERY unapplied write, not just the first", () => {
    // A recovery hint that repairs one of two failures is worse than none: it
    // reads as completeness.
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    const inner = gh.exec;
    ctx.exec = (argv, stdin) => {
      if (argv[0] === "gh" && argv[1] === "issue" && argv[2] === "edit")
        return { code: 1, stdout: "", stderr: "label not found" };
      if (stdin?.includes("updateProjectV2ItemFieldValue") && stdin.includes("P_P0"))
        return { code: 1, stdout: "", stderr: "simulated priority write failure" };
      return inner(argv, stdin);
    };
    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let err: Error | null = null;
    try {
      createIssue(ctx, { title: "infra", priority: "P0", labels: ["ralph:apply"], state: "Intake" });
    } catch (e) {
      err = e as Error;
    }
    warn.mockRestore();
    expect(err!.message).toMatch(/2 requested writes did NOT land/);
    expect(err!.message).toMatch(/Priority/);
    expect(err!.message).toMatch(/labels ralph:apply/);
    expect(err!.message).toMatch(/label not found/);
  });

  it("a failed ESTIMATE is counted in the aggregate too — 'every write' has to mean every write", () => {
    // Estimate stays a warning on its own (an unset estimate does not hide the
    // issue from `next`), but the aggregate error claims completeness, and a
    // claim of completeness that quietly omits one write is worse than none.
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    const inner = gh.exec;
    ctx.exec = (argv, stdin) => {
      if (
        stdin?.includes("updateProjectV2ItemFieldValue") &&
        (stdin.includes("P_P0") || stdin.includes("E_S"))
      )
        return { code: 1, stdout: "", stderr: "simulated field write failure" };
      return inner(argv, stdin);
    };
    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let err: Error | null = null;
    try {
      createIssue(ctx, { title: "x", priority: "P0", estimate: "S", state: "Backlog" });
    } catch (e) {
      err = e as Error;
    }
    warn.mockRestore();
    expect(err!.message).toMatch(/2 requested writes did NOT land/);
    expect(err!.message).toMatch(/Priority/);
    expect(err!.message).toMatch(/Estimate S/);
    // GH-2126: the remedy is the CLI's own verb, never "set it in the board UI".
    expect(err!.message).toMatch(/board estimate \d+ S/);
    expect(err!.message).not.toMatch(/board UI/);
  });

  it("the suppression list survives a refresh, and its cap cannot become a refresh loop", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    gh.issues.set(1, { number: 1, state: "Backlog", priority: "P1" });
    const cacheFile = join(ctx.cacheDir, "board-cdubiel08-ralph-hero-13.json");
    const schemaReads = () => gh.queries.filter((q) => q.includes("fragment pf on ProjectV2")).length;
    const read = () => JSON.parse(readFileSync(cacheFile, "utf8"));
    const reheat = () => {
      const c = read();
      c.fetchedAt = NOW.toISOString();
      writeFileSync(cacheFile, JSON.stringify(c));
    };

    // Learn one obsolete value, then run a priority MUTATION — which force-
    // refreshes the schema. The list must survive that, or every mutation
    // re-arms the repeated-refresh cost the list exists to bound.
    priorityOptionOrder(ctx, { values: ["P9"] });
    expect(read().unresolvedPriorities).toEqual(["P9"]);
    setPriority(ctx, 1, "P0");
    expect(read().unresolvedPriorities).toEqual(["P9"]); // carried through refreshCache
    reheat();
    const afterMutation = schemaReads();
    priorityOptionOrder(ctx, { values: ["P9"] });
    expect(schemaReads()).toBe(afterMutation); // still suppressed, still free

    // Past the cap, eviction would guarantee some observed value is always
    // missing: evidence fires, the refresh drops the same value again, and
    // every warm read pays forever. The truncated flag is what stops that.
    const many = Array.from({ length: 200 }, (_, i) => `GONE-${i}`);
    priorityOptionOrder(ctx, { values: many });
    expect(read().unresolvedPrioritiesTruncated).toBe(true);
    reheat();
    const afterTruncation = schemaReads();
    for (let i = 0; i < 5; i++) priorityOptionOrder(ctx, { values: many });
    expect(schemaReads()).toBe(afterTruncation); // no loop, at any board size

    // Bounded staleness is the honest cost of that: --fresh still forces a read.
    priorityOptionOrder(ctx, { values: many, fresh: true });
    expect(schemaReads()).toBe(afterTruncation + 1);
  });

  it("--clear forces the live schema too — a recreated field's stale ID would fail every clear", () => {
    // A field deleted and recreated keeps its NAME, so satisfied() stays happy
    // while the cached ID is dead. Nothing about clearing validates an option,
    // which was the wrong reason to skip the refresh.
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    gh.issues.set(1, { number: 1, state: "Backlog", priority: "P1" });
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
          Priority: {
            id: "F_priority_DELETED", dataType: "SINGLE_SELECT",
            options: { P0: "P_P0", P1: "P_P1" }, optionOrder: ["P0", "P1"],
          },
        },
        fetchedAt: NOW.toISOString(), // fresh by age: only a forced read saves this
      }),
    );
    expect(setPriority(ctx, 1, null).priority).toBeNull();
    // The live ID, never the dead one the cache was still happy to serve.
    expect(gh.mutations).toContain("clearField(#1, F_priority)");
    expect(gh.mutations.join(" ")).not.toContain("F_priority_DELETED");
  });

  it("a valueless --priority is a usage error, not a silently unprioritized issue", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    expect(parseArgs(["create", "--title", "x", "--priority"]).flags.priority).toBe(true);
    expect(() => run(["create", "--title", "x", "--priority"], ctx)).toThrow(UsageError);
    expect(gh.issues.size).toBe(0);
  });

  it("an EMPTY --priority is refused too — an unset shell variable is not 'no priority'", () => {
    // `board create --title x --priority "$PRIORITY"` with PRIORITY unset. The
    // flag parses as "", which the boolean-only guard missed and every
    // truthiness check downstream then skipped — validation AND the write —
    // filing exactly the unprioritized issue the guard exists to refuse.
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    expect(parseArgs(["create", "--title", "x", "--priority", ""]).flags.priority).toBe("");
    expect(() => run(["create", "--title", "x", "--priority", ""], ctx)).toThrow(UsageError);
    expect(() => run(["create", "--title", "x", "--priority", "   "], ctx)).toThrow(UsageError);
    expect(gh.issues.size).toBe(0);

    // The LIBRARY refuses it too, not just the CLI message: `undefined` is the
    // only way to say "no priority", so an empty string is a request that must
    // fail validation before the issue exists.
    expect(() => createIssue(ctx, { title: "x", priority: "", state: "Intake" })).toThrow(UsageError);
    expect(gh.issues.size).toBe(0);
    // …while omitting it entirely is still the supported unprioritized path.
    expect(createIssue(ctx, { title: "ok", state: "Intake" }).priority).toBeNull();
  });
});

describe("estimate is writable through the CLI (GH-2126)", () => {
  it("the setter sets and --clear removes, same shape as priority", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    gh.issues.set(1, { number: 1, state: "Backlog", estimate: null });
    expect(setEstimate(ctx, 1, "S").estimate).toBe("S");
    expect(gh.mutations).toContain("setEstimate(#1, S)");
    expect(setEstimate(ctx, 1, null).estimate).toBeNull();
    expect(gh.mutations).toContain("clearField(#1, F_estimate)");
  });

  it("refuses an unknown option naming the LIVE options, and writes nothing", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    gh.issues.set(1, { number: 1, state: "Backlog" });
    expect(() => setEstimate(ctx, 1, "XXL")).toThrow(/XS, S, M, L, XL/);
    expect(gh.mutations.filter((m) => m.startsWith("setEstimate"))).toEqual([]);
  });

  it("validates against a host repo's own scheme, never a hardcoded XS..XL", () => {
    const gh = new FakeGh();
    gh.omitFields = ["Estimate"];
    gh.createdFields.push({ name: "Estimate", dataType: "SINGLE_SELECT", options: ["Small", "Big"] });
    const ctx = makeCtx(gh);
    gh.issues.set(1, { number: 1, state: "Backlog" });
    expect(setEstimate(ctx, 1, "Big").estimate).toBe("Big");
    expect(() => setEstimate(ctx, 1, "S")).toThrow(/Small, Big/);
  });

  it("refuses to write or CLEAR a custom non-single-select Estimate", () => {
    // The destructive direction: a host board's NUMBER Estimate (GitHub's own
    // template) holds data `board get` cannot show — clearing it would erase
    // it invisibly. Same rule the Priority setter enforces.
    const gh = new FakeGh();
    gh.omitFields = ["Estimate"];
    gh.createdFields.push({ name: "Estimate", dataType: "NUMBER" });
    const ctx = makeCtx(gh);
    gh.issues.set(1, { number: 1, state: "Backlog" });
    expect(() => setEstimate(ctx, 1, "S")).toThrow(/NUMBER, not SINGLE_SELECT/);
    expect(() => setEstimate(ctx, 1, null)).toThrow(/NUMBER, not SINGLE_SELECT/);
    expect(gh.mutations.filter((m) => m.startsWith("setEstimate") || m.includes("clearField"))).toEqual([]);
  });

  it("`estimate` is scope-gated and refuses an archived item, like every mutation", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    ctx.exec = (argv, stdin) => {
      if (argv.join(" ").includes("remote get-url"))
        return { code: 0, stdout: "git@github.com:someone-else/other.git\n", stderr: "" };
      return gh.exec(argv, stdin);
    };
    gh.issues.set(1, { number: 1, state: "Backlog" });
    expect(() => run(["estimate", "1", "S"], ctx)).toThrow(RefusalError);
    const gh2 = new FakeGh();
    const ctx2 = makeCtx(gh2);
    gh2.issues.set(2, { number: 2, state: "Backlog", archived: true });
    expect(() => setEstimate(ctx2, 2, "S")).toThrow(RefusalError);
  });

  it("the CLI case requires a value or --clear, never both", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    gh.issues.set(1, { number: 1, state: "Backlog" });
    expect(() => run(["estimate", "1"], ctx)).toThrow(/estimate NNN <option>/);
    expect(() => run(["estimate", "1", "S", "--clear"], ctx)).toThrow(/--clear takes no estimate value/);
  });

  it("GH-2126 acceptance: an intake filing is approvable end-to-end with no UI step", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    const filed = createIssue(ctx, { title: "needs sizing", state: "Intake" });
    expect(filed.priority).toBeNull();
    expect(filed.estimate).toBeNull();
    setPriority(ctx, filed.number, "P2");
    expect(setEstimate(ctx, filed.number, "S").estimate).toBe("S");
    expect(run(["move", String(filed.number), "backlog"], ctx)).toBe(0);
    expect(gh.issues.get(filed.number)!.state).toBe("Backlog");
  });
});

describe("the Intake tier (GH-2077)", () => {
  describe("exclusion from the ranking lanes is BY CONSTRUCTION, not by a predicate", () => {
    // The deciding property of the whole design: every eligibility read already
    // filters `state === "Backlog"`, so an Intake item is invisible to `next`
    // and `frontier` with ZERO predicate change — there is no reader to
    // forget. This test exists to make that a pinned fact rather than an
    // argument, because the day someone rewrites the filter as
    // `state !== "Done"` it stops being true and nothing else would notice.
    const mk = (n: number, over: Partial<QueueItem> = {}): QueueItem => ({
      number: n, repo: "cdubiel08/ralph-hero", title: `t${n}`, state: "Backlog",
      priority: "P1", hasParent: false, parentNumber: null, openBlockers: [],
      openBlockerLabels: [], blockersTruncated: false, fieldValuesTruncated: false,
      claim: null, claimRaw: null, labels: [], labelsTruncated: false, closedBlockers: [],
      ...over,
    });

    it("an Intake item is neither eligible NOR blocked NOR deferred — it is simply not in the queue", () => {
      const r = rankNext([mk(1, { state: "Intake" }), mk(2)]);
      expect(r.eligible.map((i) => i.number)).toEqual([2]);
      expect(r.blocked.map((i) => i.number)).toEqual([]);
      expect(r.deferred.map((i) => i.number)).toEqual([]);
      // "Blocked" would be the wrong reading and a worse one: it says a
      // dependency is in the way, when what is missing is a human's approval.
    });

    it("an Intake CHILD does not suppress its epic root — it is upstream of Backlog, not past it", () => {
      // The one place the by-construction argument does NOT hold on its own:
      // the in-flight probe was written as `state !== "Backlog"`, which reads
      // an unapproved child as work in progress, demotes the root out of the
      // queue and reports an "in-flight epic" whose holder cannot exist.
      const r = rankNext([
        mk(1, { priority: "P0" }),
        mk(5, { hasParent: true, parentNumber: 1, state: "Intake" }),
      ]);
      expect(r.inFlightEpics).toEqual([]);
      expect(r.eligible.map((i) => i.number)).toEqual([1]);
    });
  });

  describe("approval is the Intake → Backlog transition, and it has a bar", () => {
    it("refuses without a Priority, naming what to add", () => {
      const gh = new FakeGh();
      const ctx = makeCtx(gh);
      gh.issues.set(1, { number: 1, state: "Intake", estimate: "S" });
      expect(() => run(["move", "1", "backlog"], ctx)).toThrow(/no Priority/);
      expect(gh.issues.get(1)!.state).toBe("Intake"); // refused BEFORE the write
    });

    it("refuses without an Estimate", () => {
      const gh = new FakeGh();
      const ctx = makeCtx(gh);
      gh.issues.set(1, { number: 1, state: "Intake", priority: "P1" });
      expect(() => run(["move", "1", "backlog"], ctx)).toThrow(/no Estimate/);
      expect(gh.issues.get(1)!.state).toBe("Intake");
    });

    it("accepts a formed item — and the bar is the SAME text `create --backlog` uses", () => {
      const gh = new FakeGh();
      const ctx = makeCtx(gh);
      gh.issues.set(1, { number: 1, state: "Intake", priority: "P1", estimate: "S" });
      run(["move", "1", "backlog"], ctx);
      expect(gh.issues.get(1)!.state).toBe("Backlog");
      // One helper, two callers: the approval edge and the create lane are two
      // spellings of "approved and rankable", and a bar living in both places
      // is the GH-1843 drift shape.
      expect(backlogReadinessGaps(null, "S")).toHaveLength(1);
      expect(backlogReadinessGaps("P1", null)).toHaveLength(1);
      expect(backlogReadinessGaps(null, null)).toHaveLength(2);
      expect(backlogReadinessGaps("P1", "S")).toEqual([]);
    });

    it("claiming an Intake item is refused by the MACHINE — no special code to forget", () => {
      const gh = new FakeGh();
      const ctx = makeCtx(gh);
      gh.issues.set(1, { number: 1, state: "Intake", priority: "P1", estimate: "S" });
      expect(() => run(["claim", "1"], ctx)).toThrow(/illegal transition/);
      expect(gh.issues.get(1)!.state).toBe("Intake");
      expect(gh.issues.get(1)!.claim ?? null).toBeNull();
    });

    it("there is no way back to Intake — a demotion edge would be a way to hide work", () => {
      const gh = new FakeGh();
      const ctx = makeCtx(gh);
      gh.issues.set(1, { number: 1, state: "Backlog", priority: "P1", estimate: "S" });
      expect(() => run(["move", "1", "intake"], ctx)).toThrow(/illegal transition/);
    });
  });

  describe("surfaces", () => {
    it("`list` shows Intake by default — hiding a tier from the human surface recreates the invisibility", () => {
      const gh = new FakeGh();
      const ctx = makeCtx(gh);
      gh.issues.set(1, { number: 1, state: "Intake" });
      gh.issues.set(2, { number: 2, state: "Backlog", priority: "P1" });
      const said: string[] = [];
      const spy = vi.spyOn(process.stdout, "write").mockImplementation((x) => {
        said.push(String(x));
        return true;
      });
      try {
        run(["list"], ctx);
      } finally {
        spy.mockRestore();
      }
      expect(said.join("")).toContain("#1 [Intake]");
      expect(said.join("")).toContain("#2 [Backlog]");
    });

    it("doctor surfaces aging intake as an ADVISORY line — never strict-escalated, never fixed", () => {
      const gh = new FakeGh();
      const ctx = makeCtx(gh);
      const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
      gh.issues.set(1, { number: 1, state: "Intake", createdAt: daysAgo(20) });
      gh.issues.set(2, { number: 2, state: "Intake", createdAt: daysAgo(3) }); // young
      // An unreadable createdAt is NOT evidence that anyone has been waiting.
      gh.issues.set(3, { number: 3, state: "Intake", createdAt: null });

      const line = (r: DoctorReport) => r.checks.find((c) => c.name === "intake-stale")!;
      const lax = line(doctor(ctx));
      expect(lax.level).toBe("info");
      expect(lax.detail).toContain("#1");
      expect(lax.detail).not.toContain("#2");
      expect(lax.detail).not.toContain("#3");
      expect(lax.detail).toMatch(/board move N backlog/); // the remedy is named
      // Advisory in full: it neither fails the sweep nor escalates under
      // --strict. The only remedies are a human's approval or rejection, so a
      // check that could go red would be crying wolf about a decision nobody
      // is late on.
      expect(line(doctor(ctx, { strict: true })).level).toBe("info");
    });

    it("doctor says `ok` when nothing has aged — a healthy board gets no marker", () => {
      const gh = new FakeGh();
      const ctx = makeCtx(gh);
      gh.issues.set(1, { number: 1, state: "Backlog", priority: "P1" });
      expect(doctor(ctx).checks.find((c) => c.name === "intake-stale")!.level).toBe("ok");
    });
  });
});

describe("the --backlog lane GATES what GH-1792 could only nudge about (GH-2077)", () => {
  // GH-1792 shipped a stderr HINT because `create` had no lane: a bare filing
  // landed in Backlog, and gating it there would have refused fast human
  // capture that legitimately does not know the priority yet. The intake tier
  // removes that trade — the "I do not know yet" filing has its own lane now —
  // so Backlog can carry the bar the hint only described.
  it("refuses a --backlog filing with no Priority, naming BOTH the flag and the other lane", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    expect(() => run(["create", "--backlog", "--title", "x", "--estimate", "S"], ctx)).toThrow(
      /--priority P0\.\.P3/,
    );
    expect(() => run(["create", "--backlog", "--title", "x", "--estimate", "S"], ctx)).toThrow(
      /--intake/,
    );
    expect(gh.issues.size).toBe(0); // refused BEFORE the issue exists
  });

  it("refuses a --backlog filing with no Estimate", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    expect(() => run(["create", "--backlog", "--title", "x", "--priority", "P1"], ctx)).toThrow(
      /--estimate XS\.\.XL/,
    );
    expect(gh.issues.size).toBe(0);
  });

  it("names EVERY gap at once — fixing one and being refused again is the hint failing", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    let err: Error | null = null;
    try {
      run(["create", "--backlog", "--title", "x"], ctx);
    } catch (e) {
      err = e as Error;
    }
    expect(err!.message).toMatch(/no Priority/);
    expect(err!.message).toMatch(/no Estimate/);
  });

  it("--intake asks for neither — that is the whole point of the lane", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    const code = run(["create", "--intake", "--title", "not formed yet"], ctx);
    expect(code).toBe(0);
    const filed = [...gh.issues.values()].at(-1)!;
    expect(filed.state).toBe("Intake");
    expect(filed.priority ?? null).toBeNull();
  });

  it("a fully-formed --backlog filing is accepted and lands ranked", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    const issue = createIssue(ctx, {
      title: "ready", priority: "P1", estimate: "S", state: "Backlog",
    });
    expect(issue.state).toBe("Backlog");
    expect(issue.priority).toBe("P1");
    expect(gh.mutations.join(" ")).toMatch(/setEstimate\(#\d+, S\)/);
  });
});

describe("create --label", () => {
  it("applies labels via gh issue edit, and a label failure is loud but not fatal", () => {
    const gh = new FakeGh();
    const edits: string[][] = [];
    const inner = gh.exec;
    gh.exec = (argv, stdin) => {
      if (argv[0] === "gh" && argv[1] === "issue" && argv[2] === "edit") {
        edits.push(argv);
        return { code: 1, stdout: "", stderr: "label not found" }; // worst case
      }
      return inner(argv, stdin);
    };
    const ctx = makeCtx(gh);
    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const issue = createIssue(ctx, { title: "apply: turn it on", labels: ["ralph:apply"], state: "Intake" });
    expect(issue.number).toBeGreaterThan(0); // the issue exists regardless
    expect(edits[0]).toContain("--add-label");
    expect(edits[0]).toContain("ralph:apply");
    expect(warn.mock.calls.join("")).toMatch(/labels ralph:apply not applied/);
    warn.mockRestore();
  });

  it("parses a comma-separated --label list", () => {
    expect(parseArgs(["--title", "t", "--label", "ralph:apply,infra"]).flags.label).toBe("ralph:apply,infra");
  });
});

// --- review-hardened edges (CodeRabbit, PR #1699) ---------------------------

describe("apply kind — fail-closed edges", () => {
  const NOW_E = new Date("2026-08-02T12:00:00Z");
  const APPLY_ON = { enabled: true, label: APPLY_LABEL_DEFAULT, infraPaths: [] };

  it("an undefined checks[] entry is an offender, not a pass", () => {
    const base = { kind: "settings", applied_at: "2026-08-02T11:00:00Z", actor: "me", notes: "live" };
    expect(validateApplyEvidence({ ...base, checks: [undefined] }, NOW_E))
      .toMatch(/every checks\[\] entry needs exit_code 0/);
    expect(validateApplyEvidence({ ...base, checks: [null] }, NOW_E))
      .toMatch(/every checks\[\] entry needs exit_code 0/);
    expect(validateApplyEvidence({ ...base, checks: [{ exit_code: 0 }, undefined] }, NOW_E))
      .toMatch(/every checks\[\] entry needs exit_code 0/);
  });

  it("a TRUNCATED label list counts as apply-kind — the one truncation whose open direction is a lie", () => {
    const cfg = { apply: { ...APPLY_ON } };
    expect(isApplyIssue(cfg, ["bug", "enhancement"], true)).toBe(true);
    expect(isApplyIssue(cfg, ["bug", "enhancement"], false)).toBe(false);
    // still inert when the repo has not opted in
    expect(isApplyIssue({ apply: { ...APPLY_ON, enabled: false } }, [], true)).toBe(false);
  });

  it("the close gate refuses an issue whose label list was truncated", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    ctx.cfg.apply = { ...APPLY_ON };
    gh.issues.set(1, { number: 1, state: "In Review", labels: ["bug"], labelsTruncated: true, comments: [] });
    expect(() => transition(ctx, fetchIssue(ctx, 1), "Done", { why: "x" })).toThrow(RefusalError);
  });

  it("merged-unapplied ignores an item whose blocker list was truncated", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    ctx.cfg.apply = { ...APPLY_ON };
    gh.issues.set(1, {
      number: 1, state: "Backlog", labels: ["ralph:apply"],
      blockedBy: [{ number: 5, state: "CLOSED" }], blockersTruncated: true,
    });
    const c = doctor(ctx).checks.find((x) => x.name === "merged-unapplied")!;
    expect(c.level).toBe("ok"); // cannot claim "all the work landed" from a partial list
  });

  it("one unreadable apply body does not hide the OTHER elapsed apply units", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    ctx.cfg.apply = { ...APPLY_ON };
    gh.issues.set(1, {
      number: 1, state: "Backlog", labels: ["ralph:apply"],
      body: "<!-- ralph-verify-after: 2026-07-01T00:00:00Z -->",
    });
    gh.issues.set(2, { number: 2, state: "Backlog", labels: ["ralph:apply"] });
    const inner = gh.exec;
    gh.exec = (argv, stdin) => {
      // only the body/comments query for #2 fails
      if (stdin?.includes("comments(last") && stdin.includes('"number":2')) {
        return { code: 1, stdout: "", stderr: "boom" };
      }
      return inner(argv, stdin);
    };
    const c = doctor(ctx).checks.find((x) => x.name === "apply-verify-elapsed")!;
    expect(c.level).toBe("warn");
    expect(c.detail).toContain("#1(due");        // reported despite #2's failure
    expect(c.detail).toContain("body unreadable");
    expect(c.detail).toContain("#2");
  });
});

describe("readiness — apply kind", () => {
  const rootWithLevel3 = (): string => {
    const root = mkdtempSync(join(tmpdir(), "readiness-apply-"));
    writeFileSync(join(root, "CLAUDE.md"), "# repo\n");
    writeFileSync(join(root, "vitest.config.ts"), "export default {}\n");
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });
    writeFileSync(join(root, ".github", "workflows", "ci.yml"), "on: push\n");
    return root;
  };

  it("reads as INFO, never a gap — a repo whose changes go live on merge needs none of it", () => {
    const ctx = makeCtx(new FakeGh(), "me@test", rootWithLevel3());
    const report = readiness(ctx);
    const c = report.checks.find((x) => x.name === "apply-kind")!;
    expect(c.level).toBe(3);
    expect(c.status).toBe("info");
    expect(c.recommend).toMatch(/Repos whose changes go live on merge need none of it/);
    // and it does not hold any level hostage
    expect(report.readyFor).toBe(2);
  });

  it("reports ok, with the configured label and path count, once the repo opts in", () => {
    const ctx = makeCtx(new FakeGh(), "me@test", rootWithLevel3());
    ctx.cfg.apply = { enabled: true, label: "kind/apply", infraPaths: [".github/**", "terraform/**"] };
    const c = readiness(ctx).checks.find((x) => x.name === "apply-kind")!;
    expect(c.status).toBe("ok");
    expect(c.detail).toContain('label "kind/apply"');
    expect(c.detail).toContain("2 infra path(s)");
    expect(c.recommend).toBeUndefined();
  });
});

describe("create --apply", () => {
  const mkCtx = (gh: FakeGh, label: string | null) => {
    const ctx = makeCtx(gh);
    if (label) ctx.cfg.apply = { enabled: true, label, infraPaths: [] };
    return ctx;
  };

  it("resolves the CONFIGURED label, so a repo that renamed it cannot get an unrecognized apply unit", () => {
    const gh = new FakeGh();
    const edits: string[][] = [];
    const inner = gh.exec;
    gh.exec = (argv, stdin) => {
      if (argv[1] === "issue" && argv[2] === "edit") { edits.push(argv); return { code: 0, stdout: "", stderr: "" }; }
      return inner(argv, stdin);
    };
    const ctx = mkCtx(gh, "kind/apply");
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    run(["create", "--intake", "--title", "apply: it", "--apply", "--label", "infra"], ctx);
    out.mockRestore();
    expect(edits[0]).toContain("kind/apply");
    expect(edits[0]).toContain("infra");
  });

  it("refuses --apply when the repo has not opted in — the label would be decoration", () => {
    const ctx = makeCtx(new FakeGh()); // apply disabled
    expect(() => run(["create", "--intake", "--title", "apply: it", "--apply"], ctx)).toThrow(UsageError);
    expect(() => run(["create", "--intake", "--title", "apply: it", "--apply"], ctx)).toThrow(/apply` block/);
  });
});

// ---------------------------------------------------------------------------
// Deliver lane selector (GH-1712, D3) — spec §4.2 / A1.
// ---------------------------------------------------------------------------

import {
  classifyDeliver,
  DELIVER_DEFAULTS,
  type DeliverCandidate,
  type DeliverMarkerEntry,
  type DeliverPrFacts,
  deliverQueue,
  parseDeliverMarker,
  parseDeliverOpts,
  parseConvergenceVerdict,
  parseMergeGateVerdict,
} from "./board.js";

describe("deliver-queue: classification (spec §4.2)", () => {
  // NOW is 2026-07-31T12:00:00Z. Defaults: settle 5 min, retry 60 min, budget 3.
  const dpr = (n: number, over: Partial<DeliverPrFacts> = {}): DeliverPrFacts => ({
    number: n,
    state: "OPEN",
    headSha: "sha-a",
    checkConclusions: "ci=success",
    reviewCursor: null,
    threadCursor: null,
    lastActivityAt: "2026-07-31T11:00:00Z", // 60 min ago — well settled
    ...over,
  });
  // Fixtures declare `prs` as full facts; `openPrs` is derived the way the
  // two-phase fetch derives it (GH-1811), so a fixture cannot describe an open
  // PR the classifier has no facts for — a state the fetch cannot produce.
  const cand = (
    n: number,
    over: Omit<Partial<DeliverCandidate>, "prs"> & { prs?: DeliverPrFacts[] } = {},
  ): DeliverCandidate => {
    const prs = over.prs ?? [dpr(100 + n)];
    return {
      number: n,
      title: `Issue ${n}`,
      stateUpdatedAt: "2026-07-31T10:00:00Z",
      lastCommentAt: null,
      marker: null,
      ...over,
      prs: prs.map((p) => ({ id: `PR_${p.number}`, number: p.number, state: p.state })),
      openPrs: over.openPrs ?? prs.filter((p) => p.state === "OPEN"),
    };
  };
  const entry = (over: Partial<DeliverMarkerEntry> = {}): DeliverMarkerEntry => ({
    head_sha: "sha-a",
    verdict: "PENDING",
    gate: "external-review",
    check_conclusions: "ci=success",
    review_cursor: null,
    thread_cursor: null,
    at: "2026-07-31T11:30:00Z", // 30 min ago — inside the 60-min retry window
    ...over,
  });
  const classify = (
    cands: DeliverCandidate[],
    probe: Parameters<typeof classifyDeliver>[3] = () => ({ verdict: "PASS", gate: null }),
  ) => classifyDeliver(cands, DELIVER_DEFAULTS, NOW, probe);

  it("quiescence boundary: fresh activity settles; exactly the window's age is quiescent", () => {
    const fresh = classify([cand(1, { prs: [dpr(101, { lastActivityAt: "2026-07-31T11:56:00Z" })] })]);
    expect(fresh.next).toBeNull();
    expect(fresh.blocked[0]).toMatchObject({ number: 1, reason: "settling" });
    expect(fresh.blocked[0].windowExpiresAt).toBe("2026-07-31T12:01:00.000Z");
    // age == settleMin passes the guard (strictly-less-than keeps it settling)
    const edge = classify([cand(1, { prs: [dpr(101, { lastActivityAt: "2026-07-31T11:55:00Z" })] })]);
    expect(edge.next).toMatchObject({ number: 1, reason: "actionable" });
  });

  it("issue-side activity (state change, comment) settles too — not just PR pushes", () => {
    const res = classify([cand(1, { stateUpdatedAt: "2026-07-31T11:58:00Z" })]);
    expect(res.blocked[0]).toMatchObject({ reason: "settling" });
    const res2 = classify([cand(1, { lastCommentAt: "2026-07-31T11:59:00Z" })]);
    expect(res2.blocked[0]).toMatchObject({ reason: "settling" });
  });

  it("zero linked PRs is no-pr — rollup parents and human-placed items are not deliver's business", () => {
    const res = classify([cand(1, { prs: [] })]);
    expect(res.next).toBeNull();
    expect(res.blocked[0]).toMatchObject({ number: 1, reason: "no-pr" });
    expect(res.blocked[0].windowExpiresAt).toBeUndefined(); // only a human clears it
  });

  it("all linked PRs merged/closed is ELIGIBLE (no-open-pr) — the close-out branch un-strands it", () => {
    const merged = classify([cand(1, { prs: [dpr(101, { state: "MERGED" })] })]);
    expect(merged.next).toMatchObject({ number: 1, reason: "no-open-pr" });
    // closed-unmerged is the SAME selector reason — merged-vs-unmerged is the session's judgment
    const closed = classify([cand(2, { prs: [dpr(102, { state: "CLOSED" })] })]);
    expect(closed.next).toMatchObject({ number: 2, reason: "no-open-pr" });
  });

  it("marker-absent PR is trivially actionable once probed; probe verdict/gate land on the row", () => {
    const probed: number[] = [];
    const res = classify([cand(1)], (pr) => {
      probed.push(pr);
      return { verdict: "FAIL", gate: "checks" };
    });
    expect(probed).toEqual([101]);
    expect(res.next).toMatchObject({ number: 1, pr: 101, reason: "actionable", verdict: "FAIL", gate: "checks" });
  });

  it("dry-run verdict mapping: PASS / PENDING-by-gate / FAIL-by-gate all confirm when the tuple differs", () => {
    for (const v of [
      { verdict: "PASS", gate: null },
      { verdict: "PENDING", gate: "mergeable" },
      { verdict: "FAIL", gate: "attestation" },
    ]) {
      const res = classify([cand(1)], () => v);
      expect(res.next).toMatchObject({ reason: "actionable", verdict: v.verdict, gate: v.gate });
    }
  });

  it("cheap re-arm deltas: each of head/checks/review/thread re-arms the probe", () => {
    const deltas: Array<Partial<DeliverMarkerEntry>> = [
      { head_sha: "sha-OLD" },
      { check_conclusions: "ci=failure" },
      { review_cursor: "2026-07-31T09:00:00Z" },
      { thread_cursor: "2026-07-31T09:00:00Z" },
    ];
    for (const d of deltas) {
      const probed: number[] = [];
      const res = classify(
        [cand(1, { marker: { "101": entry(d) } })],
        (pr) => {
          probed.push(pr);
          return { verdict: "PASS", gate: null };
        },
      );
      expect(probed, JSON.stringify(d)).toEqual([101]);
      expect(res.next, JSON.stringify(d)).toMatchObject({ reason: "actionable" });
    }
  });

  it("probed-tuple-equal is marker-current until the window expires — a recorded PASS included", () => {
    // Cheap delta (checks changed) but the probe still returns the recorded tuple.
    const res = classify(
      [cand(1, { marker: { "101": entry({ check_conclusions: "ci=failure", verdict: "PASS", gate: null }) } })],
      () => ({ verdict: "PASS", gate: null }),
    );
    expect(res.next).toBeNull();
    expect(res.blocked[0]).toMatchObject({ number: 1, pr: 101, reason: "marker-current" });
    expect(res.blocked[0].windowExpiresAt).toBe("2026-07-31T12:30:00.000Z"); // at + 60 min
  });

  it("no cheap delta inside the window is retry-window — and the probe is NOT spent on it", () => {
    const probed: number[] = [];
    const res = classify([cand(1, { marker: { "101": entry() } })], (pr) => {
      probed.push(pr);
      return { verdict: "PASS", gate: null };
    });
    expect(probed).toEqual([]);
    expect(res.next).toBeNull();
    expect(res.blocked[0]).toMatchObject({ reason: "retry-window" });
  });

  it("bounded retry re-arms after RALPH_RETRY_MIN for EVERY verdict class — unchanged PENDING and unchanged PASS alike", () => {
    for (const v of [
      { verdict: "PENDING", gate: "external-review" },
      { verdict: "PASS", gate: null }, // the PASS-that-never-merged class
    ]) {
      const probed: number[] = [];
      const res = classify(
        [cand(1, { marker: { "101": entry({ ...v, at: "2026-07-31T10:30:00Z" }) } })], // 90 min ago
        (pr) => {
          probed.push(pr);
          return { verdict: "PASS", gate: null };
        },
      );
      expect(probed, v.verdict).toEqual([]); // retries never consume the dry-run budget
      expect(res.next, v.verdict).toMatchObject({ number: 1, pr: 101, reason: "retry", verdict: v.verdict });
    }
  });

  it("anti-starvation: newest-delta-first budget — persistent old marker-current candidates cannot pin it", () => {
    // 5 cheap-delta candidates; the 3 OLDEST would probe tuple-equal (marker-current).
    // Budget 3, newest-first: the two newest get probed and confirm; the third
    // probe lands on t3 (tuple-equal); t2/t1 are deferred, and the newest item
    // still got its probe.
    const at = (h: number) => `2026-07-31T0${h}:00:00Z`;
    const cands = [1, 2, 3, 4, 5].map((k) =>
      cand(k, {
        prs: [dpr(100 + k, { lastActivityAt: at(k), headSha: "sha-new" })],
        marker: { [String(100 + k)]: entry({ head_sha: "sha-old", verdict: "PASS", gate: null }) },
      }),
    );
    const probed: number[] = [];
    const res = classifyDeliver(cands, DELIVER_DEFAULTS, NOW, (pr) => {
      probed.push(pr);
      return { verdict: "PASS", gate: null };
    });
    expect(probed).toEqual([105, 104, 103]); // newest first, budget 3
    const deferred = res.blocked.filter((b) => b.reason === "deferred").map((b) => b.pr);
    expect(deferred.sort()).toEqual([101, 102]);
    expect(res.queue.filter((r) => r.reason === "actionable").map((r) => r.pr)).toEqual([103, 104, 105]); // oldest-first
  });

  it("anti-starvation with genuinely marker-current elders: the newest delta still gets probed", () => {
    const at = (h: number) => `2026-07-31T0${h}:00:00Z`;
    // Elders 1..3: checks-delta but probe confirms the recorded tuple (marker-current).
    const elders = [1, 2, 3].map((k) =>
      cand(k, {
        prs: [dpr(100 + k, { lastActivityAt: at(k) })],
        marker: { [String(100 + k)]: entry({ check_conclusions: "ci=failure", verdict: "PASS", gate: null }) },
      }),
    );
    // Newcomer 9: newest delta, marker-less.
    const fresh = cand(9, { prs: [dpr(109, { lastActivityAt: at(9) })] });
    const probed: number[] = [];
    const res = classifyDeliver([...elders, fresh], DELIVER_DEFAULTS, NOW, (pr) => {
      probed.push(pr);
      return { verdict: "PASS", gate: null };
    });
    expect(probed[0]).toBe(109); // newest delta first — the fresh PR is never starved
    expect(res.queue.filter((r) => r.reason === "actionable").map((r) => r.pr)).toEqual([109]);
    expect(res.blocked.filter((b) => b.reason === "marker-current").length).toBe(2);
    expect(res.blocked.filter((b) => b.reason === "deferred").length).toBe(1);
  });

  it("queue order: close-outs, then confirmed oldest-first, then retries — retries never starve fresh work", () => {
    const res = classifyDeliver(
      [
        cand(1, { marker: { "101": entry({ at: "2026-07-31T10:00:00Z" }) } }), // retry (120 min old)
        cand(2, { prs: [dpr(102, { lastActivityAt: "2026-07-31T09:00:00Z" })] }), // confirmed, older delta
        cand(3, { prs: [dpr(103, { lastActivityAt: "2026-07-31T11:00:00Z" })] }), // confirmed, newer delta
        cand(4, { prs: [dpr(104, { state: "MERGED" })] }), // close-out
      ],
      DELIVER_DEFAULTS,
      NOW,
      () => ({ verdict: "PASS", gate: null }),
    );
    expect(res.queue.map((r) => [r.number, r.reason])).toEqual([
      [4, "no-open-pr"],
      [2, "actionable"],
      [3, "actionable"],
      [1, "retry"],
    ]);
    expect(res.next).toMatchObject({ number: 4 });
  });

  it("no merge gate in the host repo: cheap-delta candidates are actionable unprobed (native-flow degrade)", () => {
    const res = classifyDeliver([cand(1)], DELIVER_DEFAULTS, NOW, null);
    expect(res.next).toMatchObject({ number: 1, reason: "actionable", verdict: null });
  });

  it("a crashed probe (no parseable verdict) still yields actionable — the session runs the gates itself", () => {
    const res = classify([cand(1)], () => null);
    expect(res.next).toMatchObject({ reason: "actionable", verdict: null });
  });

  // --- convergence stop (GH-1977) ---------------------------------------
  const conv = (verdict: string) => () => ({ verdict, detail: `d:${verdict}` });
  const classifyConv = (
    cands: DeliverCandidate[],
    convergence: Parameters<typeof classifyDeliver>[4],
    opts = DELIVER_DEFAULTS,
  ) =>
    classifyDeliver(cands, opts, NOW, () => ({ verdict: "PASS", gate: null }), convergence);

  it.each(["stalled", "cap-reached"])(
    "%s holds the row OUT of the queue as its own blocked row — never silently withheld",
    (verdict) => {
      const res = classifyConv([cand(1)], conv(verdict));
      expect(res.next).toBeNull();
      expect(res.queue).toHaveLength(0);
      expect(res.blocked).toContainEqual(
        expect.objectContaining({
          number: 1,
          pr: 101,
          reason: "convergence-stalled",
          convergence: verdict,
          detail: `d:${verdict}`,
          windowExpiresAt: null,
        }),
      );
    },
  );

  it.each(["converged", "converging", "insufficient-data", "no-passes"])(
    "%s is a live loop — the row stays in the queue",
    (verdict) => {
      const res = classifyConv([cand(1)], conv(verdict));
      expect(res.next).toMatchObject({ number: 1, reason: "actionable" });
    },
  );

  it("not-evaluated never invents a block: a null convergence probe leaves the queue as it was", () => {
    expect(classifyConv([cand(1)], () => null).next).toMatchObject({ number: 1 });
    // and no probe at all is the pre-GH-1977 selector, unchanged
    expect(classifyConv([cand(1)], null).next).toMatchObject({ number: 1 });
  });

  it("the check is budgeted: rows past the budget keep their classification (the rule gates nothing)", () => {
    const calls: number[] = [];
    const res = classifyConv(
      [1, 2, 3].map((n) => cand(n, { prs: [dpr(100 + n)] })),
      (pr) => {
        calls.push(pr);
        return { verdict: "stalled", detail: "d" };
      },
      { ...DELIVER_DEFAULTS, convergenceMax: 2 },
    );
    expect(calls).toHaveLength(2);
    expect(res.queue).toHaveLength(1);
    expect(res.blocked.filter((b) => b.reason === "convergence-stalled")).toHaveLength(2);
  });

  it("item-level rows carrying no PR are never checked — there is no loop to score", () => {
    const calls: number[] = [];
    const res = classifyConv([cand(1, { prs: [dpr(101, { state: "MERGED" })] })], (pr) => {
      calls.push(pr);
      return { verdict: "stalled", detail: "d" };
    });
    expect(calls).toHaveLength(0);
    expect(res.next).toMatchObject({ reason: "no-open-pr", pr: null });
  });

  // --- local session lease (GH-1929) ------------------------------------
  const hold = (over: Partial<LeaseHold> = {}): LeaseHold => ({
    session: "peer-session",
    worktree: "/wt/feat-1-x",
    since: "2026-07-31T11:00:00Z",
    expiresAt: "2026-07-31T13:00:00.000Z",
    ...over,
  });
  const classifyLease = (
    cands: DeliverCandidate[],
    lease: Parameters<typeof classifyDeliver>[5],
  ) => classifyDeliver(cands, DELIVER_DEFAULTS, NOW, () => ({ verdict: "PASS", gate: null }), null, lease);

  it("a held unit is refused ENTIRELY — surfaced as its own blocked row, never silently withheld", () => {
    const res = classifyLease([cand(1)], () => hold());
    expect(res.next).toBeNull();
    expect(res.queue).toHaveLength(0);
    expect(res.blocked).toHaveLength(1);
    expect(res.blocked[0]).toMatchObject({
      number: 1,
      reason: "local-session-active",
      lease: hold(),
    });
  });

  it("the block is self-clearing: windowExpiresAt is the lock's own TTL expiry, not null", () => {
    const res = classifyLease([cand(1)], () => hold({ expiresAt: "2026-07-31T13:30:00.000Z" }));
    // Unlike convergence-stalled, whose remedy is a human's, this row needs
    // nobody: the lock ages out on RALPH_LOCK_TTL_MIN.
    expect(res.blocked[0].windowExpiresAt).toBe("2026-07-31T13:30:00.000Z");
  });

  it("close-outs are held too — the holder is the session that should close its own merged PR", () => {
    const res = classifyLease([cand(1, { prs: [dpr(101, { state: "MERGED" })] })], () => hold());
    expect(res.next).toBeNull();
    expect(res.blocked[0]).toMatchObject({ number: 1, reason: "local-session-active", pr: null });
  });

  it("a not-evaluated lease never invents a block: a null probe leaves the queue as it was", () => {
    expect(classifyLease([cand(1)], null).next).toMatchObject({ number: 1, reason: "actionable" });
  });

  it("an empty probe is not a block either — only a real hold blocks", () => {
    expect(classifyLease([cand(1)], () => null).next).toMatchObject({ number: 1, reason: "actionable" });
  });

  it("blocks only the held unit — an unheld sibling still reaches the queue", () => {
    const res = classifyLease([cand(1), cand(2)], (n) => (n === 1 ? hold() : null));
    expect(res.next).toMatchObject({ number: 2, reason: "actionable" });
    expect(res.blocked.map((b) => b.number)).toEqual([1]);
  });

  it("the lease is checked BEFORE the merge-gate probe — a held unit costs no dry run", () => {
    const probed: number[] = [];
    const res = classifyDeliver(
      [cand(1)],
      DELIVER_DEFAULTS,
      NOW,
      (pr) => {
        probed.push(pr);
        return { verdict: "PASS", gate: null };
      },
      null,
      () => hold(),
    );
    expect(probed).toHaveLength(0);
    expect(res.blocked[0].reason).toBe("local-session-active");
  });
});

describe("localSessionLease — reading the GH-1956 worktree lock as a lease (GH-1929)", () => {
  const TTL = 120;
  const NOW_MS = Date.parse("2026-07-31T12:00:00Z");
  let dir: string;

  const ctxFor = (id: string | null): Parameters<typeof localSessionLease>[0] =>
    ({
      session: { id, dir },
      cfg: { lockTtlMin: TTL },
      now: () => new Date(NOW_MS),
    }) as unknown as Parameters<typeof localSessionLease>[0];

  const writeLock = (
    file: string,
    body: Record<string, unknown>,
    ageMin = 0,
  ): void => {
    const p = join(dir, file);
    writeFileSync(p, JSON.stringify(body));
    const t = new Date(NOW_MS - ageMin * 60_000);
    utimesSync(p, t, t);
  };
  const lock = (issue: number, over: Record<string, unknown> = {}) => ({
    session: "peer",
    issue,
    worktree: "/wt/peer",
    since: "2026-07-31T11:00:00Z",
    ...over,
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ralph-lease-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("a fresh foreign lock is a hold, and expiresAt is mtime + TTL", () => {
    writeLock("wt-1929-0123456789abcdef.json", lock(1929), 30);
    const probe = localSessionLease(ctxFor("mine"))!;
    expect(probe(1929)).toMatchObject({ session: "peer", worktree: "/wt/peer" });
    // written 30 min ago, TTL 120 → clears 90 min from now
    expect(probe(1929)!.expiresAt).toBe("2026-07-31T13:30:00.000Z");
  });

  it("an aged-out lock is not a hold — the same clock as the board claim", () => {
    writeLock("wt-1929-0123456789abcdef.json", lock(1929), TTL + 1);
    expect(localSessionLease(ctxFor("mine"))!(1929)).toBeNull();
  });

  it("our own lock is never a hold — a session is not racing itself", () => {
    writeLock("wt-1929-0123456789abcdef.json", lock(1929, { session: "mine" }));
    expect(localSessionLease(ctxFor("mine"))!(1929)).toBeNull();
  });

  it("the issue number is matched exactly — wt-19290 is not a hold on 1929", () => {
    // The prefix-match trap GH-1996 hit on search's `head:` qualifier.
    writeLock("wt-19290-0123456789abcdef.json", lock(19290));
    const probe = localSessionLease(ctxFor("mine"))!;
    expect(probe(1929)).toBeNull();
    expect(probe(19290)).not.toBeNull();
  });

  it("ignores files that are not lock records — the session binding beside them is not a lease", () => {
    writeFileSync(join(dir, "some-session-0123456789abcdef.json"), JSON.stringify({ issue: 1929 }));
    writeFileSync(join(dir, "wt-1929-nothex.json"), JSON.stringify(lock(1929)));
    expect(localSessionLease(ctxFor("mine"))!(1929)).toBeNull();
  });

  it("an unparseable record asserts nothing rather than throwing", () => {
    writeFileSync(join(dir, "wt-1929-0123456789abcdef.json"), "{not json");
    expect(localSessionLease(ctxFor("mine"))!(1929)).toBeNull();
  });

  it("two worktrees holding one unit: the LAST expiry wins — a row may not return while any session holds it", () => {
    writeLock("wt-1929-aaaaaaaaaaaaaaaa.json", lock(1929, { worktree: "/wt/old" }), 100);
    writeLock("wt-1929-bbbbbbbbbbbbbbbb.json", lock(1929, { worktree: "/wt/new" }), 10);
    expect(localSessionLease(ctxFor("mine"))!(1929)!.worktree).toBe("/wt/new");
  });

  it("an unreadable sessions dir is NOT evaluated — null, never an empty probe", () => {
    // The whole safety argument: "we could not read the lease" must not render
    // as "no lease is held".
    expect(localSessionLease(ctxFor("mine") && ({
      session: { id: "mine", dir: join(dir, "does-not-exist") },
      cfg: { lockTtlMin: TTL },
      now: () => new Date(NOW_MS),
    } as unknown as Parameters<typeof localSessionLease>[0]))).toBeNull();
  });

  it("no session dir at all is not evaluated", () => {
    expect(
      localSessionLease({ cfg: { lockTtlMin: TTL }, now: () => new Date(NOW_MS) } as unknown as Parameters<
        typeof localSessionLease
      >[0]),
    ).toBeNull();
  });

  it("a session with no id still reads peers' locks — an unidentified reader excludes nothing", () => {
    writeLock("wt-1929-0123456789abcdef.json", lock(1929));
    expect(localSessionLease(ctxFor(null))!(1929)).not.toBeNull();
  });
});

describe("convergence verdict parsing (GH-1977)", () => {
  it("reads the verdict and detail off the script's JSON line", () => {
    expect(
      parseConvergenceVerdict('{"ok":true,"verdict":"stalled","detail":"did not decrease"}\n'),
    ).toEqual({ verdict: "stalled", detail: "did not decrease" });
  });

  it("ok:false is NOT a verdict — an unreadable history must not read as a healthy loop", () => {
    expect(parseConvergenceVerdict('{"ok":false,"verdict":"not-evaluated","detail":"x"}')).toBeNull();
    expect(parseConvergenceVerdict("gh: command not found")).toBeNull();
    expect(parseConvergenceVerdict("")).toBeNull();
  });
});

describe("deliver-queue: marker + verdict parsing", () => {
  it("parses the marker's fenced JSON keyed by PR number; last marker comment wins", () => {
    const mk = (sha: string) =>
      `<!-- ralph-deliver:v1 -->\n\`\`\`json\n{"prs":{"101":{"head_sha":"${sha}","verdict":"PASS","gate":null,"check_conclusions":"","review_cursor":null,"thread_cursor":null,"at":"2026-07-31T11:00:00Z"}}}\n\`\`\``;
    const prs = parseDeliverMarker(["unrelated", mk("old"), mk("new")]);
    expect(prs?.["101"]?.head_sha).toBe("new");
  });

  it("malformed marker JSON reads as no marker — one redundant probe, never a wrong mutation", () => {
    expect(parseDeliverMarker(["<!-- ralph-deliver:v1 -->\n```json\n{not json\n```"])).toBeNull();
    expect(parseDeliverMarker(["<!-- ralph-deliver:v1 --> no fence at all"])).toBeNull();
    expect(parseDeliverMarker([])).toBeNull();
  });

  it("verdict is the LAST non-WARN MERGE GATE line (WARN-then-PASS parses as PASS)", () => {
    expect(
      parseMergeGateVerdict(
        "MERGE GATE WARN — checks: no CI checks reported on PR #9 (continuing)\nMERGE GATE PASS — PR #9 @ abcd1234 (attestation=true external=true exempt=false force=false)\nDry run: no merge attempted.",
      ),
    ).toEqual({ verdict: "PASS", gate: null });
    expect(parseMergeGateVerdict("MERGE GATE FAIL — checks: not green: build=fail\nMERGE BLOCKED — x")).toEqual({
      verdict: "FAIL",
      gate: "checks",
    });
    expect(parseMergeGateVerdict("MERGE GATE PENDING — external-review: no review yet")).toEqual({
      verdict: "PENDING",
      gate: "external-review",
    });
    expect(parseMergeGateVerdict("gh: connection refused")).toBeNull();
  });

  it("parseDeliverOpts: defaults, env overrides, invalid warns to default", () => {
    expect(parseDeliverOpts({})).toEqual({ settleMin: 5, retryMin: 60, dryrunMax: 3, convergenceMax: 3 });
    expect(
      parseDeliverOpts({
        RALPH_SETTLE_MIN: "10",
        RALPH_RETRY_MIN: "30",
        RALPH_DELIVER_DRYRUN_MAX: "1",
        RALPH_DELIVER_CONVERGENCE_MAX: "2",
      }),
    ).toEqual({ settleMin: 10, retryMin: 30, dryrunMax: 1, convergenceMax: 2 });
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(parseDeliverOpts({ RALPH_SETTLE_MIN: "banana" }).settleMin).toBe(5);
    } finally {
      err.mockRestore();
    }
  });
});

describe("board name: the one place a transport reads the convention (GH-1807)", () => {
  const say = (argv: string[], ctx: ReturnType<typeof makeCtx>) => {
    const said: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((s) => {
      said.push(String(s));
      return true;
    });
    try {
      run(argv, ctx);
    } finally {
      spy.mockRestore();
    }
    return said.join("");
  };

  it("derives branch, agent and worktree from one title — same slug on every surface", () => {
    const gh = new FakeGh();
    gh.issues.set(1807, { number: 1807, state: "Backlog", title: "Semantic branch + agent names" });
    const parsed = JSON.parse(say(["name", "1807", "--json"], makeCtx(gh)));
    expect(parsed).toMatchObject({
      number: 1807,
      kind: "feat", // no labels — the stated default, never free text
      lane: "w",
      branch: "feat/1807-semantic-branch-agent",
      agent: "w1807-semantic-branch-agent",
      worktree: "feat-1807-semantic-branch-agent",
      legacyBranch: "feature/GH-1807",
    });
  });

  it("kind comes from labels; the apply label outranks them, but only once armed", () => {
    const gh = new FakeGh();
    gh.issues.set(1, { number: 1, state: "Backlog", title: "Broken thing", labels: ["bug"] });
    gh.issues.set(2, {
      number: 2,
      state: "Backlog",
      title: "Deploy the ruleset",
      labels: ["bug", APPLY_LABEL_DEFAULT],
    });
    const off = makeCtx(gh);
    expect(JSON.parse(say(["name", "1", "--json"], off)).branch).toBe("fix/1-broken-thing");
    // apply.enabled=false: the label is just a label, and the branch says so.
    expect(JSON.parse(say(["name", "2", "--json"], off)).branch).toBe("fix/2-deploy-the-ruleset");
    const on = makeCtx(gh);
    on.cfg.apply = { enabled: true, label: APPLY_LABEL_DEFAULT, infraPaths: [] };
    expect(JSON.parse(say(["name", "2", "--json"], on)).branch).toBe("apply/2-deploy-the-ruleset");
  });

  it("peer resolves the harness-owned address from the unit's own prefix, and exits nonzero rather than guessing", () => {
    const gh = new FakeGh();
    gh.issues.set(1918, { number: 1918, state: "In Progress", title: "One session, two identities" });
    const ctx = makeCtx(gh);
    const prefix = "feat-1918-one-session-two";
    expect(JSON.parse(say(["name", "1918", "--json"], ctx)).peerPrefix).toBe(prefix);

    const hit = JSON.parse(
      say(["peer", "1918", "--candidates", `ralph-hero-23,${prefix}-c6`, "--json"], ctx),
    );
    expect(hit).toMatchObject({ kind: "resolved", address: `${prefix}-c6`, peerPrefix: prefix });

    // Absence and ambiguity are both refusals — a caller reading only stdout
    // must not mistake either for an address.
    const miss = JSON.parse(say(["peer", "1918", "--candidates", "ralph-hero-23", "--json"], ctx));
    expect(miss.kind).toBe("none");
    expect(run(["peer", "1918", "--candidates", "ralph-hero-23", "--json"], ctx)).toBe(1);
    expect(run(["peer", "1918", "--candidates", `${prefix}-c6,${prefix}-3b`, "--json"], ctx)).toBe(1);
    expect(run(["peer", "1918", "--candidates", `${prefix}-c6`, "--json"], ctx)).toBe(0);

    // A session that resumed the legacy branch is running under leaf GH-1918.
    const legacy = JSON.parse(say(["peer", "1918", "--candidates", "GH-1918-3b", "--json"], ctx));
    expect(legacy).toMatchObject({ kind: "resolved", address: "GH-1918-3b" });
    expect(legacy.peerPrefixes).toEqual([prefix, "GH-1918"]);
  });

  it("--lane picks the agent lane and refuses one outside the closed registry", () => {
    const gh = new FakeGh();
    gh.issues.set(1807, { number: 1807, state: "Backlog", title: "Review sweep" });
    const ctx = makeCtx(gh);
    expect(JSON.parse(say(["name", "1807", "--lane", "r", "--json"], ctx)).agent).toBe("r1807-review-sweep");
    expect(() => run(["name", "1807", "--lane", "q"], ctx)).toThrow(/--lane must be one of/);
  });
});

describe("deliver-queue: fetch + CLI wiring", () => {
  const OLD = "2026-07-31T10:00:00Z"; // settled

  it("foreign-repo and archived In Review items never reach the queue; linkage unions refs + branch convention", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    gh.issues.set(1, {
      number: 1,
      state: "In Review",
      stateUpdatedAt: OLD,
      prs: [{ number: 101, merged: false, headSha: "sha-a", pushedAt: OLD }],
    });
    gh.issues.set(2, { number: 2, state: "In Review", repo: "other/repo", stateUpdatedAt: OLD });
    gh.issues.set(3, { number: 3, state: "In Review", archived: true, stateUpdatedAt: OLD });
    gh.issues.set(4, {
      number: 4,
      state: "In Review",
      stateUpdatedAt: OLD,
      branchPrs: [{ number: 104, merged: false, headSha: "sha-b", pushedAt: OLD }], // convention-only linkage
    });
    const res = deliverQueue(ctx, DELIVER_DEFAULTS, () => ({ verdict: "PASS", gate: null }));
    expect(res.queue.map((r) => [r.number, r.pr]).sort()).toEqual([
      [1, 101],
      [4, 104],
    ]);
    expect(res.queue.length + res.blocked.length).toBe(2); // #2 foreign, #3 archived: absent entirely
  });

  it("branch linkage spans BOTH grammars, and rejects the refs GitHub's substring filter throws in (GH-1807)", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    // New shape.
    gh.issues.set(1807, {
      number: 1807,
      state: "In Review",
      stateUpdatedAt: OLD,
      branchRefs: [
        { name: "fix/1807-semantic-branch", prs: [{ number: 901, merged: false, headSha: "s1", pushedAt: OLD }] },
      ],
    });
    // Legacy shape, mid-deprecation-window — same query, no second lookup.
    gh.issues.set(1808, {
      number: 1808,
      state: "In Review",
      stateUpdatedAt: OLD,
      branchPrs: [{ number: 902, merged: false, headSha: "s2", pushedAt: OLD }],
    });
    // Every ref here CONTAINS "1809" and so comes back from GitHub's filter.
    // None of them is #1809's branch: two name other issues, two do not parse.
    gh.issues.set(1809, {
      number: 1809,
      state: "In Review",
      stateUpdatedAt: OLD,
      branchRefs: [
        { name: "feature/GH-18090", prs: [{ number: 903, merged: false, headSha: "s3", pushedAt: OLD }] },
        { name: "fix/18091-other-unit", prs: [{ number: 904, merged: false, headSha: "s4", pushedAt: OLD }] },
        { name: "claude/eager-1809-bun", prs: [{ number: 905, merged: false, headSha: "s5", pushedAt: OLD }] },
        { name: "spike/1809-closed-registry", prs: [{ number: 906, merged: false, headSha: "s6", pushedAt: OLD }] },
      ],
    });
    const res = deliverQueue(ctx, DELIVER_DEFAULTS, () => ({ verdict: "PASS", gate: null }));
    expect(res.queue.map((r) => [r.number, r.pr]).sort()).toEqual([
      [1807, 901],
      [1808, 902],
    ]);
    // #1809 is present but PR-less — the coincidences linked nothing.
    expect(res.blocked.map((r) => [r.number, r.reason])).toContainEqual([1809, "no-pr"]);
  });

  // --- GH-1811: the facts do not belong in the linkage document ------------
  //
  // GraphQL cost tracks the PRODUCT of the `first:` values down a nesting, not
  // the connection count (that model holds for the item walk, where everything
  // sits under one page — it does not generalize). Measured live: with the
  // facts inside `refs` → `associatedPullRequests`, ONE candidate cost 55 pts
  // and 21,310 nodes; the whole 10-candidate document cost 607. Hoisted under
  // `node(id:)` — a single node, so nothing multiplies — the same data costs
  // 2 + 6, measured live on both documents as board.ts emits them. GH-1807
  // reintroduced this silently once, believing it had added 1 point, so the
  // shape is asserted rather than remembered.
  const FACT_FIELDS = ["headRefOid", "statusCheckRollup", "reviewThreads", "reviews("];

  it("the linkage document selects NO per-PR facts — they cost 10-100x under a nested connection", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    gh.issues.set(1, {
      number: 1,
      state: "In Review",
      stateUpdatedAt: OLD,
      prs: [{ number: 101, merged: false, headSha: "sha-a", pushedAt: OLD }],
      branchRefs: [
        { name: "fix/1-thing", prs: [{ number: 102, merged: false, headSha: "sha-b", pushedAt: OLD }] },
      ],
    });
    deliverQueue(ctx, DELIVER_DEFAULTS, () => ({ verdict: "PASS", gate: null }));

    const phaseA = gh.queries.filter((q) => q.includes("d0: issue(number"));
    const phaseB = gh.queries.filter((q) => q.includes("p0: node(id"));
    expect(phaseA).toHaveLength(1);
    expect(phaseB).toHaveLength(1);
    // The expensive nesting is still there — it is what finds the PRs — but it
    // now carries `number state` and nothing else.
    expect(phaseA[0]).toContain("associatedPullRequests");
    for (const field of FACT_FIELDS) expect(phaseA[0]).not.toContain(field);
    // ...and phase B carries the facts with no connection above them at all.
    for (const field of FACT_FIELDS) expect(phaseB[0]).toContain(field);
    expect(phaseB[0]).not.toContain("associatedPullRequests");
    expect(phaseB[0]).not.toContain("closedByPullRequestsReferences");
    // Fetched by NODE ID, and not scoped to a repository: a closing reference
    // can name a PR in another repo, where the same NUMBER is a different PR
    // (or none at all). Both open PRs above are in one document.
    expect(phaseB[0]).toContain("p0: node(id: $p0)");
    expect(phaseB[0]).toContain("p1: node(id: $p1)");
    expect(phaseB[0]).not.toContain("repository(");
    expect(phaseB[0]).not.toContain("pullRequest(number");
  });

  it("an open PR that returns no facts REFUSES the read — it must never read as a close-out", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    gh.issues.set(1, {
      number: 1,
      state: "In Review",
      stateUpdatedAt: OLD,
      prs: [{ number: 101, merged: false, headSha: "sha-a", pushedAt: OLD }],
    });
    gh.vanishBeforePrFacts.add(101); // OPEN in phase A, resolves to nothing in phase B
    // Empty `openPrs` IS the close-out branch, so swallowing this miss would
    // tell the deliver lane to close an issue whose PR is still open. The
    // split must fail loudly instead — a broken read, not a state.
    expect(() => deliverQueue(ctx, DELIVER_DEFAULTS, () => ({ verdict: "PASS", gate: null }))).toThrow(
      /PR #101 .* was OPEN in the linkage read but returned no facts/,
    );
  });

  it("no open PR anywhere in a chunk → the facts call is never made", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    gh.issues.set(1, { number: 1, state: "In Review", stateUpdatedAt: OLD }); // PR-less
    gh.issues.set(2, {
      number: 2,
      state: "In Review",
      stateUpdatedAt: OLD,
      prs: [{ number: 202, merged: true, headSha: "sha-m", pushedAt: OLD }], // merged
    });
    const res = deliverQueue(ctx, DELIVER_DEFAULTS, () => ({ verdict: "PASS", gate: null }));
    expect(gh.queries.filter((q) => q.includes("p0: node(id"))).toHaveLength(0);
    // Both still classify — neither branch ever needed a fact.
    expect(res.blocked.map((r) => [r.number, r.reason])).toContainEqual([1, "no-pr"]);
    expect(res.queue.map((r) => [r.number, r.reason])).toContainEqual([2, "no-open-pr"]);
  });

  it("a PR that merges BETWEEN the two calls reads as a close-out, not an open PR with stale facts", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    gh.issues.set(1, {
      number: 1,
      state: "In Review",
      stateUpdatedAt: OLD,
      prs: [{ number: 101, merged: false, headSha: "sha-a", pushedAt: OLD }],
    });
    gh.mergeBeforePrFacts.add(101); // OPEN in phase A, MERGED in phase B
    const res = deliverQueue(ctx, DELIVER_DEFAULTS, () => ({ verdict: "PASS", gate: null }));
    // Phase B is the fresher read of the two and wins: the item is a close-out,
    // never an `actionable` row against a PR that is already merged.
    expect(res.queue.map((r) => [r.number, r.pr, r.reason])).toEqual([[1, null, "no-open-pr"]]);
  });

  it("run(): deliver-queue --json emits {next,queue,blocked} and prose mode names blocked reasons", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    gh.issues.set(1, {
      number: 1,
      state: "In Review",
      stateUpdatedAt: OLD,
      prs: [{ number: 101, merged: false, headSha: "sha-a", pushedAt: OLD }],
    });
    gh.issues.set(2, { number: 2, state: "In Review", stateUpdatedAt: OLD }); // no PR at all
    const said: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((s) => {
      said.push(String(s));
      return true;
    });
    try {
      // Ambient RALPH_* exports (a real habit on dev machines) must not steer
      // this test: a big RALPH_SETTLE_MIN would flip #1 to `settling`, and
      // RALPH_MERGE_PR_SH would override the /repo fallback below.
      vi.stubEnv("RALPH_SETTLE_MIN", undefined);
      vi.stubEnv("RALPH_RETRY_MIN", undefined);
      vi.stubEnv("RALPH_DELIVER_DRYRUN_MAX", undefined);
      vi.stubEnv("RALPH_MERGE_PR_SH", undefined);
      // repoRoot "/repo" ships no scripts/merge-pr.sh → native-flow degrade, no probe.
      run(["deliver-queue", "--json"], ctx);
      const parsed = JSON.parse(said.join(""));
      expect(parsed.next).toMatchObject({ number: 1, pr: 101, reason: "actionable", verdict: null });
      expect(parsed.blocked).toEqual([expect.objectContaining({ number: 2, reason: "no-pr" })]);
      said.length = 0;
      run(["deliver-queue"], ctx);
      expect(said.join("")).toContain("deliver next: #1 pr#101 [actionable] Issue 1");
      expect(said.join("")).toContain("#2←no-pr");
    } finally {
      vi.unstubAllEnvs();
      spy.mockRestore();
    }
  });

  it("an empty In Review set spawns no detail fetch and no probe (idle-exit is cheap)", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    gh.issues.set(1, { number: 1, state: "Backlog" });
    let probes = 0;
    const res = deliverQueue(ctx, DELIVER_DEFAULTS, () => {
      probes++;
      return { verdict: "PASS", gate: null };
    });
    expect(res).toEqual({ next: null, queue: [], blocked: [] });
    expect(probes).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tend lane selector (GH-1712, D4) — spec §4.3 / A1 (tend portion).
// ---------------------------------------------------------------------------

import {
  classifyTend,
  parseTendOpts,
  TEND_DEFAULTS,
  TEND_MARKER,
  TEND_PROPOSAL_MARKER,
  TEND_RESOLUTION_MARKER,
  pendingProposal,
  lastMarkerIndex,
  resolveProposal,
  tendQueue,
  listOwnRecentClosed,
  fetchCommentTrails,
} from "./board.js";

describe("tend-queue (spec §4.3)", () => {
  // NOW is 2026-07-31T12:00:00Z.
  const days = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
  const item = (n: number, over: Partial<QueueItem> = {}): QueueItem => ({
    number: n,
    repo: "cdubiel08/ralph-hero",
    title: `t${n}`,
    state: "Backlog",
    priority: "P2", // formed by default; absence is opt-in per case (GH-1796)
    hasParent: false,
    parentNumber: null,
    openBlockers: [],
    openBlockerLabels: [],
    blockersTruncated: false,
    fieldValuesTruncated: false,
    claim: null,
    claimRaw: null,
    labels: [],
    labelsTruncated: false,
    closedBlockers: [],
    updatedAt: days(1),
    createdAt: days(2),
    estimate: "S",
    ...over,
  });

  it("stale bodies: Backlog with no updates past RALPH_STALE_DAYS; fresh ones stay out", () => {
    const res = classifyTend(
      [item(1, { updatedAt: days(31) }), item(2, { updatedAt: days(29) })],
      [],
      TEND_DEFAULTS,
      NOW,
    );
    expect(res.queue.map((r) => [r.number, r.category])).toEqual([[1, "stale-body"]]);
  });

  it("dependency anomalies are Backlog-scoped: cleared blockers and truncated blockers queue; In Review never does", () => {
    const res = classifyTend(
      [
        item(1, { closedBlockers: [9] }), // all blockers closed — the wait is over
        item(2, { blockersTruncated: true }), // the board cannot see its own edges
        item(3, { state: "In Review", closedBlockers: [9] }), // not tend's business
        item(4, { openBlockers: [9], openBlockerLabels: ["#9"], closedBlockers: [8] }), // still genuinely blocked
      ],
      [],
      TEND_DEFAULTS,
      NOW,
    );
    expect(res.queue.map((r) => [r.number, r.category])).toEqual([
      [1, "deps-cleared"],
      [2, "deps-truncated"],
    ]);
  });

  it("formation candidates: missing estimate OR priority, no parent, no deps, older than 7 days", () => {
    const res = classifyTend(
      [
        item(1, { estimate: null, createdAt: days(8) }),
        item(2, { estimate: null, createdAt: days(6) }), // too young
        item(3, { estimate: null, createdAt: days(8), hasParent: true }), // parented = formed enough
        item(4, { createdAt: days(8) }), // estimate + priority = formed
        // GH-1796: estimated but unprioritized — `next` ranks it behind every
        // P3, so the lane must name it or it is lost, not deprioritized.
        item(5, { priority: null, createdAt: days(8) }),
        // Field values truncated: the null priority is unasserted, not unset.
        item(6, { priority: null, createdAt: days(8), fieldValuesTruncated: true }),
      ],
      [],
      TEND_DEFAULTS,
      NOW,
    );
    expect(res.queue.map((r) => [r.number, r.category])).toEqual([
      [1, "unformed"],
      [5, "unformed"],
    ]);
  });

  it("done-audit marker cursor: recent closes without the marker queue; marked or old ones don't", () => {
    const res = classifyTend(
      [],
      [
        { number: 1, closedAt: days(3), comments: [] },
        { number: 2, closedAt: days(3), comments: [`${TEND_MARKER}\n{"at":"x","artifacts_checked":1}`] },
        { number: 3, closedAt: days(20), comments: [] }, // outside the audit window
        { number: 4, closedAt: null, comments: [] }, // unknown close time — skipped, not invented
      ],
      TEND_DEFAULTS,
      NOW,
    );
    expect(res.queue.map((r) => [r.number, r.category])).toEqual([[1, "done-audit"]]);
  });

  it("category order is spec order, oldest-first within; one row per issue (first category wins)", () => {
    const res = classifyTend(
      [
        item(5, { estimate: null, createdAt: days(9) }), // unformed
        item(1, { updatedAt: days(40), closedBlockers: [9] }), // stale AND deps-cleared → stale-body wins
        item(2, { updatedAt: days(35) }),
        item(3, { updatedAt: days(50) }),
      ],
      [{ number: 9, closedAt: days(1), comments: [] }],
      TEND_DEFAULTS,
      NOW,
    );
    expect(res.queue.map((r) => [r.number, r.category])).toEqual([
      [3, "stale-body"], // oldest first
      [1, "stale-body"],
      [2, "stale-body"],
      [5, "unformed"],
      [9, "done-audit"],
    ]);
    expect(res.next?.number).toBe(3);
    expect(res.observationSlot).toBe(true); // §4.3.5 — the slot is typed, the skill decides
  });

  it("tendQueue wiring: own-repo scope, archived closes skipped, histories feed the marker cursor", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    gh.issues.set(1, { number: 1, state: "Backlog", updatedAt: days(45), createdAt: days(60), estimate: "M" });
    gh.issues.set(2, { number: 2, state: "Backlog", repo: "other/repo", updatedAt: days(45) }); // foreign
    gh.issues.set(3, {
      number: 3, issueState: "CLOSED", state: "Done", closedAt: days(2), comments: [],
    });
    gh.issues.set(4, {
      number: 4, issueState: "CLOSED", state: "Done", closedAt: days(2),
      comments: [`${TEND_MARKER} audited`],
    });
    gh.issues.set(5, {
      number: 5, issueState: "CLOSED", state: "Done", closedAt: days(2), archived: true,
    });
    const res = tendQueue(ctx, TEND_DEFAULTS);
    expect(res.queue.map((r) => [r.number, r.category])).toEqual([
      [1, "stale-body"],
      [3, "done-audit"],
    ]);
  });

  // GH-1777 — the proposal marker as a two-way cursor, and its resolution.
  const proposal = (at: string | null, action = "close-as-delivered") =>
    `${TEND_PROPOSAL_MARKER}\n\`\`\`json\n{"action":"${action}","at":${at === null ? '"nonsense"' : `"${at}"`}}\n\`\`\``;
  const resolution = (disposition: "accepted" | "rejected") =>
    `${TEND_RESOLUTION_MARKER}\n\`\`\`json\n{"disposition":"${disposition}","at":"${days(1)}"}\n\`\`\``;

  it("pendingProposal: last marker wins; a garbled payload still counts as pending", () => {
    expect(pendingProposal(["nothing here"])).toBeNull();
    expect(pendingProposal([proposal(days(9)), proposal(days(2))])).toEqual({ at: days(2) });
    expect(pendingProposal([proposal(null)])).toEqual({ at: null });
  });

  it("pendingProposal: a resolution answers the proposal, and a later proposal re-arms it", () => {
    // The lifecycle in one line each. Trail order is chronological.
    expect(pendingProposal([proposal(days(9)), resolution("rejected")])).toBeNull();
    expect(pendingProposal([proposal(days(9)), resolution("accepted")])).toBeNull();
    // New evidence → a fresh proposal after the resolution is pending again.
    expect(
      pendingProposal([proposal(days(9)), resolution("rejected"), proposal(days(2))]),
    ).toEqual({ at: days(2) });
    // A resolution that QUOTES the marker it answers still resolves: within one
    // comment the later marker wins, so the quote cannot re-arm the proposal.
    expect(
      pendingProposal([proposal(days(9)), `quoting ${TEND_PROPOSAL_MARKER}\n${resolution("rejected")}`]),
    ).toBeNull();
    // A resolution with nothing to answer is inert, not a pending anything.
    expect(pendingProposal([resolution("rejected")])).toBeNull();
  });

  // GH-1826 — a comment that DISCUSSES the marker is not a comment that speaks
  // it. Fixture is the shape of #1777's own trail: three comments quoting the
  // marker in backticks, which filed a phantom proposal against the very issue
  // that implemented the marker — and it was undated, so it failed closed to
  // pending and no close could ever settle it.
  it("pendingProposal: a marker quoted in prose or a code span is not a proposal", () => {
    // Verbatim from #1777's comments (fetched 2026-08-15) — the acceptance
    // criterion, decision section 3, and the close-out.
    const acceptanceCriterion =
      "- [ ] A `" + TEND_PROPOSAL_MARKER + "` marker comment (fenced JSON payload: proposed action, evidence, recommendation, ISO timestamp) — same shape discipline as the `audited` marker";
    const decisionSection =
      "3. **Proposals get a filing surface**: `" + TEND_PROPOSAL_MARKER + "` marker comment + a `proposed` category in `board tend-queue` (first in spec order, so a pending proposal surfaces as itself and is not re-proposed) + an advisory doctor `i` line for proposals that go unanswered.";
    const closeOut =
      "- Proposals file as `" + TEND_PROPOSAL_MARKER + "` marker comments, re-surfaced by a new `proposed` category in `board tend-queue` (first in spec order — that ordering *is* the do-not-re-propose cursor) and by doctor's advisory `tend-proposal-stale` line (`RALPH_SMELL_PROPOSAL_DAYS`, default 7).";
    const fencedResolution =
      "The disposition marker is\n\n```\n" + TEND_RESOLUTION_MARKER + "\n```\n\nwritten by `board resolve`.";
    expect(pendingProposal([acceptanceCriterion, decisionSection, closeOut, fencedResolution])).toBeNull();
    // Indented and inline-quoted forms are prose too.
    expect(pendingProposal(["  " + TEND_PROPOSAL_MARKER, "see " + TEND_PROPOSAL_MARKER + " above"]))
      .toBeNull();
    // And the real thing still registers alongside all of that noise.
    expect(pendingProposal([acceptanceCriterion, proposal(days(4)), closeOut])).toEqual({
      at: days(4),
    });
  });

  it("lastMarkerIndex: masking preserves offsets, so within-comment ordering survives", () => {
    // The resolution answers the proposal only because its index is LATER; a
    // mask that shortened the quoted span ahead of it would invert that.
    const body = "quoting `" + TEND_PROPOSAL_MARKER + "` here\n" + TEND_PROPOSAL_MARKER + "\n" + TEND_RESOLUTION_MARKER;
    expect(lastMarkerIndex(body, TEND_RESOLUTION_MARKER)).toBeGreaterThan(
      lastMarkerIndex(body, TEND_PROPOSAL_MARKER),
    );
    expect(lastMarkerIndex("nothing", TEND_MARKER)).toBe(-1);
    // A marker inside a fenced block is masked; the fence's own text is not
    // matched even when the fence never closes.
    expect(lastMarkerIndex("```json\n" + TEND_MARKER + "\n", TEND_MARKER)).toBe(-1);
  });

  it("done-audit: an audit marker quoted in prose does not mark the issue audited", () => {
    const closed = { number: 9, closedAt: days(2), comments: ["we write `" + TEND_MARKER + "` on audit"] };
    expect(
      classifyTend([], [closed], TEND_DEFAULTS, NOW, new Map()).queue.map((r) => r.category),
    ).toEqual(["done-audit"]);
    const audited = { number: 9, closedAt: days(2), comments: [TEND_MARKER + "\n```json\n{}\n```"] };
    expect(classifyTend([], [audited], TEND_DEFAULTS, NOW, new Map()).queue).toEqual([]);
  });

  it("proposed: a REJECTED Backlog proposal stops surfacing — the item returns to its own category", () => {
    // Without a durable rejection the human's "no, leave it open" changes
    // nothing observable, so the item sat in `proposed` forever and the lane's
    // clean sweep (acted=0) was unreachable.
    const stale = item(1, { updatedAt: days(31) });
    const map = new Map<number, string | null>();
    for (const trail of [[proposal(days(9)), resolution("rejected")]]) {
      const p = pendingProposal(trail);
      if (p) map.set(1, p.at);
    }
    expect(map.size).toBe(0);
    expect(classifyTend([stale], [], TEND_DEFAULTS, NOW, map).queue.map((r) => r.category)).toEqual([
      "stale-body",
    ]);
  });

  it("done-audit: a pending reopen proposal surfaces as `proposed`, never as done-audit again", () => {
    // The reported non-convergence: classifyTend only promoted markers on open
    // Backlog items, so a `reopen-as-unevidenced` proposal on a CLOSED item
    // came back as done-audit every pass and was proposed again forever.
    const closed = [
      {
        number: 9,
        title: "t9",
        closedAt: days(5),
        comments: [proposal(days(3), "reopen-as-unevidenced")], // filed AFTER the close
      },
    ];
    const res = classifyTend([], closed, TEND_DEFAULTS, NOW);
    expect(res.queue.map((r) => [r.number, r.category, r.at])).toEqual([[9, "proposed", days(3)]]);
  });

  it("done-audit: a proposal the close ANSWERED settles itself; a resolved one does too", () => {
    // close-as-delivered proposed while open, then the human closed the item:
    // the close IS the acceptance, so the item flows on to be audited rather
    // than parking in `proposed` waiting for a disposition already made.
    const answered = [
      { number: 9, title: "t9", closedAt: days(3), comments: [proposal(days(5))] }, // filed BEFORE the close
    ];
    expect(classifyTend([], answered, TEND_DEFAULTS, NOW).queue.map((r) => r.category)).toEqual([
      "done-audit",
    ]);
    // An explicit resolution settles it regardless of ordering.
    const resolved = [
      {
        number: 9,
        title: "t9",
        closedAt: days(5),
        comments: [proposal(days(3), "reopen-as-unevidenced"), resolution("rejected")],
      },
    ];
    expect(classifyTend([], resolved, TEND_DEFAULTS, NOW).queue.map((r) => r.category)).toEqual([
      "done-audit",
    ]);
    // ...and once audited, the item leaves the queue entirely. Convergence.
    const audited = [
      {
        number: 9,
        title: "t9",
        closedAt: days(5),
        comments: [
          proposal(days(3), "reopen-as-unevidenced"),
          resolution("rejected"),
          `${TEND_MARKER} audited`,
        ],
      },
    ];
    expect(classifyTend([], audited, TEND_DEFAULTS, NOW).queue).toEqual([]);
  });

  it("done-audit: an UNDATED proposal on a closed item fails closed to pending", () => {
    // Cannot compare it to the close, so it stays visible rather than being
    // swallowed by the audit path — same discipline as the open-item case.
    const closed = [{ number: 9, title: "t9", closedAt: days(5), comments: [proposal(null)] }];
    expect(classifyTend([], closed, TEND_DEFAULTS, NOW).queue.map((r) => [r.category, r.at])).toEqual(
      [["proposed", null]],
    );
  });

  it("proposed: a pending proposal outranks the category that produced it — the do-not-re-propose cursor", () => {
    const stale = item(1, { updatedAt: days(31) });
    const withProposal = classifyTend([stale], [], TEND_DEFAULTS, NOW, new Map([[1, days(3)]]));
    expect(withProposal.queue.map((r) => [r.number, r.category, r.at])).toEqual([[1, "proposed", days(3)]]);
    // No proposal on file: the item is proposable material again.
    const without = classifyTend([stale], [], TEND_DEFAULTS, NOW);
    expect(without.queue.map((r) => [r.number, r.category])).toEqual([[1, "stale-body"]]);
  });

  it("proposed sorts first across categories and tolerates an undated proposal", () => {
    const res = classifyTend(
      [item(1, { updatedAt: days(60) }), item(2, { updatedAt: days(31) })],
      [],
      TEND_DEFAULTS,
      NOW,
      new Map([[2, null]]),
    );
    expect(res.queue.map((r) => [r.number, r.category])).toEqual([
      [2, "proposed"],
      [1, "stale-body"],
    ]);
    expect(res.next?.number).toBe(2);
  });

  it("tendQueue reads proposal markers off queued open items only", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    gh.issues.set(1, {
      number: 1, state: "Backlog", updatedAt: days(45), createdAt: days(60), estimate: "M",
      comments: [proposal(days(4))],
    });
    gh.issues.set(2, { number: 2, state: "Backlog", updatedAt: days(45), createdAt: days(60), estimate: "M" });
    const res = tendQueue(ctx, TEND_DEFAULTS);
    expect(res.queue.map((r) => [r.number, r.category])).toEqual([
      [1, "proposed"],
      [2, "stale-body"],
    ]);
  });

  it("tendQueue: a closed item's reopen proposal rides the audit trails already fetched", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    gh.issues.set(9, {
      number: 9, issueState: "CLOSED", state: "Done", closedAt: days(5),
      comments: [proposal(days(3), "reopen-as-unevidenced")],
    });
    gh.issues.set(10, {
      number: 10, issueState: "CLOSED", state: "Done", closedAt: days(5),
      comments: [proposal(days(3), "reopen-as-unevidenced"), resolution("rejected")],
    });
    const res = tendQueue(ctx, TEND_DEFAULTS);
    expect(res.queue.map((r) => [r.number, r.category])).toEqual([
      [9, "proposed"],
      [10, "done-audit"],
    ]);
  });

  it("resolveProposal writes the durable marker only when something is pending", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    gh.issues.set(1, { number: 1, state: "Backlog", comments: [proposal(days(4))] });
    gh.issues.set(2, { number: 2, state: "Backlog", comments: [] });

    expect(resolveProposal(ctx, fetchIssue(ctx, 1), "rejected", "still real work")).toEqual({
      at: days(4),
    });
    const posted = gh.comments.at(-1)!.body;
    expect(posted).toContain(TEND_RESOLUTION_MARKER);
    expect(posted).toContain(`"disposition":"rejected"`);
    expect(posted).toContain(`"proposed_at":"${days(4)}"`); // binds the proposal it answers
    expect(posted).toContain("still real work");

    // Nothing pending → no comment, and the caller decides what that means.
    const before = gh.comments.length;
    expect(resolveProposal(ctx, fetchIssue(ctx, 2), "rejected", "n/a")).toBeNull();
    expect(gh.comments.length).toBe(before);
  });

  it("parseTendOpts: defaults and env overrides", () => {
    expect(parseTendOpts({})).toEqual({ staleDays: 30, auditDays: 14 });
    expect(parseTendOpts({ RALPH_STALE_DAYS: "10", RALPH_AUDIT_DAYS: "7" })).toEqual({
      staleDays: 10,
      auditDays: 7,
    });
  });
});

// ---------------------------------------------------------------------------
// Readiness — per-lane rows (GH-1712, D6) — A6.
// ---------------------------------------------------------------------------

describe("readiness — lane rows (GH-1712)", () => {
  it("lane rows are info in ALL states — absent, enabled-but-stale — and never change readyFor", () => {
    const gh = new FakeGh();
    const home = mkdtempSync(join(tmpdir(), "ralph-home-"));
    // Enabled + a stale heartbeat + a non-empty outcomes log: the richest state.
    writeFileSync(join(home, "config"), "autopilot=true\nautopilot.deliver=true\n");
    writeFileSync(join(home, "deliver.heartbeat"), "");
    writeFileSync(join(home, "deliver.outcomes.log"), "2026-07-31T00:00:00Z deliver GH-1 rc=0 checked=1 acted=1\n");
    const root = mkdtempSync(join(tmpdir(), "readiness-lanes-"));
    const ctx = makeCtx(gh, "me@test", root);
    vi.stubEnv("RALPH_HOME", home);
    try {
      const withLanes = readiness(ctx);
      const deliver = withLanes.checks.find((c) => c.name === "lane-deliver");
      const tend = withLanes.checks.find((c) => c.name === "lane-tend");
      expect(deliver?.status).toBe("info");
      expect(deliver?.detail).toContain("unattended opt-in ON");
      expect(deliver?.detail).toContain("heartbeat");
      expect(deliver?.detail).toContain("outcomes log present");
      expect(tend?.status).toBe("info"); // nothing configured for tend — still info
      expect(tend?.detail).toContain("opt-in off");
      expect(tend?.detail).toContain("no tend.heartbeat");

      // readyFor is EXACTLY what it was without any lane state at all.
      vi.stubEnv("RALPH_HOME", mkdtempSync(join(tmpdir(), "ralph-home-empty-")));
      const bare = readiness(ctx);
      expect(withLanes.readyFor).toBe(bare.readyFor);
      expect(bare.checks.find((c) => c.name === "lane-deliver")?.status).toBe("info");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("the per-lane key alone is never sufficient — global-off reads as opt-in off", () => {
    const gh = new FakeGh();
    const home = mkdtempSync(join(tmpdir(), "ralph-home-partial-"));
    writeFileSync(join(home, "config"), "autopilot.deliver=true\n"); // missing the global key
    const ctx = makeCtx(gh, "me@test", mkdtempSync(join(tmpdir(), "readiness-partial-")));
    vi.stubEnv("RALPH_HOME", home);
    try {
      const report = readiness(ctx);
      expect(report.checks.find((c) => c.name === "lane-deliver")?.detail).toContain("opt-in off");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("answer verb (ralph-herdr v2) — comment-first", () => {
  let gh: FakeGh;
  let ctx: Ctx;
  beforeEach(() => {
    gh = new FakeGh();
    ctx = makeCtx(gh);
  });

  it("refuses outside Human Needed before ANY write — no comment, no state", () => {
    gh.issues.set(1, { number: 1, state: "Backlog" });
    expect(() => answer(ctx, 1, { message: "ship it" })).toThrow(RefusalError);
    expect(() => answer(ctx, 1, { message: "ship it" })).toThrow(/--any-state/);
    expect(gh.mutations).toEqual([]); // refused before any write
    expect(gh.comments).toEqual([]);
  });

  it("a truncated fieldValues page refuses before the comment — the state gate would judge fiction", () => {
    gh.issues.set(1, { number: 1, state: "Human Needed", fieldValuesTruncated: true });
    expect(() => answer(ctx, 1, { message: "ship it" })).toThrow(/field values/);
    expect(gh.mutations).toEqual([]);
  });

  it("Human Needed: the **Answer** comment lands BEFORE the state write (durable half first)", () => {
    gh.issues.set(1, { number: 1, state: "Human Needed" });
    const res = answer(ctx, 1, { message: "use option B" });
    expect(res).toEqual({ commented: true, transitioned: true, state: "In Progress" });
    const comment = gh.comments.find((c) => c.body.startsWith("**Answer**"));
    expect(comment?.body).toContain("use option B");
    expect(comment?.body).toContain("`me@test`");
    // The ordering guarantee, on the recorded mutation stream: comment first.
    expect(gh.mutations.indexOf("addComment")).toBeLessThan(gh.mutations.indexOf("setState(#1, In Progress)"));
    // The move rode the transition engine: claim acquired by the answerer.
    expect(gh.issues.get(1)!.claim).toContain("me@test");
  });

  it("--comment-only posts the durable half and skips the transition", () => {
    gh.issues.set(1, { number: 1, state: "Human Needed" });
    const res = answer(ctx, 1, { message: "use option B", commentOnly: true });
    expect(res).toEqual({ commented: true, transitioned: false, state: "Human Needed" });
    expect(gh.mutations).toEqual(["addComment"]); // no state, no claim writes
  });

  it("--any-state answers an item outside Human Needed: comment only, never a move", () => {
    gh.issues.set(1, { number: 1, state: "Backlog" });
    const res = answer(ctx, 1, { message: "context for later", anyState: true });
    expect(res).toEqual({ commented: true, transitioned: false, state: "Backlog" });
    expect(gh.mutations).toEqual(["addComment"]);
  });

  it("transition guards stay intact AFTER the comment: a live fleet co-holder refuses the move, not the answer", () => {
    // Leaving In Progress for Human Needed removes only the mover — a fleet
    // sibling can remain on the claim. The answer's comment must land anyway.
    gh.issues.set(1, {
      number: 1, state: "Human Needed",
      claim: encodeClaim("w1-other", new Date(NOW.getTime() - 10 * 60_000)),
    });
    const msg = refusalMessage(() => answer(ctx, 1, { message: "use option B" }));
    expect(msg).toContain("w1-other");
    expect(msg).toContain("The answer comment IS on the record");
    expect(gh.comments.some((c) => c.body.startsWith("**Answer**"))).toBe(true);
    expect(gh.mutations.filter((m) => m.startsWith("setState"))).toEqual([]);
  });

  it("run(): --message aliases -m; a missing message is a usage error", () => {
    gh.issues.set(1, { number: 1, state: "Human Needed" });
    expect(() => run(["answer", "1"], ctx)).toThrow(UsageError);
    expect(run(["answer", "1", "--message", "use option B"], ctx)).toBe(0);
    expect(gh.comments[0]!.body).toContain("use option B");
  });

  it("run(): --json reports exactly {commented, transitioned, state}", () => {
    gh.issues.set(1, { number: 1, state: "Human Needed" });
    const said: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((s) => {
      said.push(String(s));
      return true;
    });
    try {
      run(["answer", "1", "-m", "use option B", "--json"], ctx);
    } finally {
      spy.mockRestore();
    }
    expect(JSON.parse(said.join(""))).toEqual({
      commented: true,
      transitioned: true,
      state: "In Progress",
    });
  });

  it("run(): --comment-only followed by -m parses as booleans, not a flag value", () => {
    // parseArgs must not eat "-m" as --comment-only's value.
    gh.issues.set(1, { number: 1, state: "Human Needed" });
    const said: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((s) => {
      said.push(String(s));
      return true;
    });
    try {
      run(["answer", "1", "--comment-only", "-m", "use option B", "--json"], ctx);
    } finally {
      spy.mockRestore();
    }
    expect(JSON.parse(said.join(""))).toEqual({
      commented: true,
      transitioned: false,
      state: "Human Needed",
    });
  });

  it("run(): answer is scope-gated like every mutation", () => {
    gh.issues.set(1, { number: 1, state: "Human Needed" });
    const base = gh.exec;
    gh.exec = (argv, stdin) => {
      if (argv.join(" ").startsWith("git") && argv.includes("remote"))
        return { code: 0, stdout: "git@github.com:someone-else/other.git\n", stderr: "" };
      return base(argv, stdin);
    };
    expect(() => run(["answer", "1", "-m", "x"], ctx)).toThrow(RefusalError);
    expect(gh.comments).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Board volume + prune (GH-1788)
// ---------------------------------------------------------------------------

import {
  classifyPrune,
  parseVolumeThresholds,
  VOLUME_DEFAULTS,
  volumeReport,
  type ApplyConfig,
  type ClosedItem,
} from "./board.js";

describe("board volume (GH-1788)", () => {
  const days = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
  const open = (n: number, over: Partial<QueueItem> = {}): QueueItem =>
    ({
      number: n,
      repo: "cdubiel08/ralph-hero",
      title: `t${n}`,
      state: "Backlog",
      priority: null,
      hasParent: false,
      parentNumber: null,
      openBlockers: [],
      openBlockerLabels: [],
      blockersTruncated: false,
      fieldValuesTruncated: false,
      claim: null,
      claimRaw: null,
      labels: [],
      labelsTruncated: false,
      closedBlockers: [],
      updatedAt: days(1),
      createdAt: days(2),
      estimate: "S",
      ...over,
    }) as QueueItem;
  const closed = (n: number, over: Partial<ClosedItem> = {}): ClosedItem => ({
    number: n,
    repo: "cdubiel08/ralph-hero",
    itemId: `PVTI_${n}`,
    state: "Done",
    archived: false,
    labels: [],
    labelsTruncated: false,
    stateReason: "COMPLETED",
    closedAt: days(400),
    parentNumber: null,
    ...over,
  });
  it("reports what the walk measured, not what survived it", () => {
    const v = volumeReport(
      {
        open: [open(1)],
        closed: Array.from({ length: 250 }, (_, i) => closed(i + 100)),
        scan: { nodes: 251, pages: 3, archivedOpen: 0 },
      },
      { ...VOLUME_DEFAULTS, maxItems: 800 },
    );
    expect(v.items).toBe(251);
    expect(v.pages).toBe(3);
    expect(v.open).toBe(1);
    expect(v.closed).toBe(250);
    expect(v.nonIssue).toBe(0);
    expect(v.over).toBe(false);
  });

  // The bug a live dry run caught: PRs and drafts on the board never match the
  // `... on Issue` fragment, so inferring cost from the survivors understated
  // it by ~47% on the real board. Cost is measured, never inferred.
  it("counts nodes the issue fragment dropped — PRs and drafts are paid for too", () => {
    const v = volumeReport(
      { open: [open(1)], closed: [closed(2)], scan: { nodes: 1349, pages: 14, archivedOpen: 0 } },
      { ...VOLUME_DEFAULTS, maxItems: 800 },
    );
    expect(v.items).toBe(1349);
    expect(v.pages).toBe(14);
    expect(v.nonIssue).toBe(1347);
    expect(v.over).toBe(true);
  });

  // Review finding: nonIssue is a RESIDUAL, so any class not subtracted lands
  // in it. Archived OPEN items are dropped by the walk before reaching `open`,
  // so without their own counter doctor called archived issues "PRs/drafts".
  it("archived OPEN items are archived, not non-issue", () => {
    const v = volumeReport(
      { open: [open(1)], closed: [], scan: { nodes: 5, pages: 1, archivedOpen: 4 } },
      VOLUME_DEFAULTS,
    );
    expect(v.archived).toBe(4);
    expect(v.nonIssue).toBe(0); // 5 nodes = 1 open + 4 archived-open, nothing unaccounted
  });

  it("archived counts both sides: closed-archived rides in `closed`, open-archived in the meter", () => {
    const v = volumeReport(
      {
        open: [],
        closed: [closed(1, { archived: true }), closed(2)],
        scan: { nodes: 4, pages: 1, archivedOpen: 2 },
      },
      VOLUME_DEFAULTS,
    );
    expect(v.archived).toBe(3); // 1 closed-archived + 2 open-archived
    expect(v.nonIssue).toBe(0);
  });

  it("a genuine PR/draft still reads as non-issue", () => {
    const v = volumeReport(
      { open: [open(1)], closed: [], scan: { nodes: 10, pages: 1, archivedOpen: 0 } },
      VOLUME_DEFAULTS,
    );
    expect(v.nonIssue).toBe(9);
    expect(v.archived).toBe(0);
  });

  it("archived items still count toward the scan — hiding an item does not stop paying for it", () => {
    const v = volumeReport(
      {
        open: [],
        closed: [closed(1, { archived: true }), closed(2, { archived: true })],
        scan: { nodes: 2, pages: 1, archivedOpen: 0 },
      },
      { ...VOLUME_DEFAULTS, maxItems: 1 },
    );
    expect(v.archived).toBe(2);
    expect(v.items).toBe(2);
    expect(v.over).toBe(true); // the whole point: archiving buys no scan relief
  });

  it("an empty board still reports one page — a scan always costs at least one round trip", () => {
    expect(
      volumeReport({ open: [], closed: [], scan: { nodes: 0, pages: 0, archivedOpen: 0 } }, VOLUME_DEFAULTS).pages,
    ).toBe(1);
  });

  it("thresholds: defaults, override, and a bad value degrading to the default", () => {
    expect(parseVolumeThresholds({})).toEqual(VOLUME_DEFAULTS);
    expect(parseVolumeThresholds({ RALPH_VOLUME_MAX_ITEMS: "300" }).maxItems).toBe(300);
    expect(parseVolumeThresholds({ RALPH_PRUNE_AFTER_DAYS: "30" }).pruneAfterDays).toBe(30);
    // Advisory, so a bad value must not fail the command — it warns and defaults.
    expect(parseVolumeThresholds({ RALPH_VOLUME_MAX_ITEMS: "soon" }).maxItems).toBe(
      VOLUME_DEFAULTS.maxItems,
    );
    expect(parseVolumeThresholds({ RALPH_VOLUME_MAX_ITEMS: "0" }).maxItems).toBe(
      VOLUME_DEFAULTS.maxItems,
    );
  });
});

describe("prune candidates (GH-1788)", () => {
  const days = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
  const closed = (n: number, over: Partial<ClosedItem> = {}): ClosedItem => ({
    number: n,
    repo: "cdubiel08/ralph-hero",
    itemId: `PVTI_${n}`,
    state: "Done",
    archived: false,
    labels: [],
    labelsTruncated: false,
    stateReason: "COMPLETED",
    closedAt: days(400),
    parentNumber: null,
    ...over,
  });
  const openItem = (
    n: number,
    parentNumber: number | null = null,
    over: Partial<QueueItem> = {},
  ): QueueItem =>
    ({
      number: n,
      repo: "cdubiel08/ralph-hero",
      title: `t${n}`,
      state: "Backlog",
      priority: null,
      hasParent: parentNumber !== null,
      parentNumber,
      openBlockers: [],
      openBlockerLabels: [],
      blockersTruncated: false,
      fieldValuesTruncated: false,
      claim: null,
      claimRaw: null,
      labels: [],
      labelsTruncated: false,
      closedBlockers: [],
      updatedAt: days(1),
      createdAt: days(2),
      estimate: "S",
      ...over,
    }) as QueueItem;
  const cfg = (apply: Partial<ApplyConfig> = {}) => ({
    volume: { ...VOLUME_DEFAULTS },
    apply: { enabled: false, label: "ralph:apply", infraPaths: [], ...apply },
  });
  const reasons = (r: ReturnType<typeof classifyPrune>) =>
    Object.fromEntries(r.retained.map((x) => [x.number, x.reason]));

  it("a long-closed terminal leaf is removable", () => {
    const r = classifyPrune([], [closed(1)], cfg(), NOW);
    expect(r.candidates.map((c) => c.number)).toEqual([1]);
    expect(r.candidates[0].itemId).toBe("PVTI_1");
    expect(r.candidates[0].ageDays).toBe(400);
  });

  it("retains everything another reader still depends on, with the reason named", () => {
    const r = classifyPrune(
      [],
      [
        closed(1, { state: "In Review" }), // doctor's closedDrift still has work here
        closed(2, { closedAt: days(10) }), // tend's Done audit still reads it
        closed(3, { closedAt: null }), // cannot prove it is old
        closed(4, { archived: true }),
        closed(5, { itemId: "" }),
        closed(6, { state: "(none)" }),
      ],
      cfg(),
      NOW,
    );
    expect(r.candidates).toEqual([]);
    expect(reasons(r)).toEqual({
      1: "not-terminal",
      2: "too-recent",
      3: "undated",
      4: "archived",
      5: "no-item-id",
      6: "not-terminal",
    });
    expect(r.scanned).toBe(6);
  });

  it("never severs a tree edge an open item walks through — multi-hop, and only for open descendants", () => {
    // 3(open) → 2(closed, old) → 1(closed, old): both closed ancestors are
    // load-bearing for the ranker. 9 is an unrelated closed leaf.
    const r = classifyPrune(
      [openItem(3, 2)],
      [closed(1), closed(2, { parentNumber: 1 }), closed(9)],
      cfg(),
      NOW,
    );
    expect(r.candidates.map((c) => c.number)).toEqual([9]);
    expect(reasons(r)).toEqual({ 1: "tree-edge", 2: "tree-edge" });
  });

  it("a closed parent whose children are all closed is not load-bearing", () => {
    const r = classifyPrune([], [closed(1), closed(2, { parentNumber: 1 })], cfg(), NOW);
    expect(r.candidates.map((c) => c.number).sort()).toEqual([1, 2]);
  });

  it("a parent cycle terminates rather than hanging the sweep", () => {
    const r = classifyPrune(
      [openItem(3, 1)],
      [closed(1, { parentNumber: 2 }), closed(2, { parentNumber: 1 })],
      cfg(),
      NOW,
    );
    expect(r.candidates).toEqual([]);
  });

  it("apply units are the evidence sweep's, and a truncated label list fails closed", () => {
    const armed = cfg({ enabled: true });
    const r = classifyPrune(
      [],
      [
        closed(1, { labels: ["ralph:apply"] }),
        closed(2, { labelsTruncated: true }),
        closed(3, { labels: ["bug"] }),
      ],
      armed,
      NOW,
    );
    expect(r.candidates.map((c) => c.number)).toEqual([3]);
    expect(reasons(r)).toEqual({ 1: "apply-unit", 2: "apply-unit" });
  });

  it("apply gates are inert when the repo has not opted in", () => {
    const r = classifyPrune([], [closed(1, { labels: ["ralph:apply"] })], cfg(), NOW);
    expect(r.candidates.map((c) => c.number)).toEqual([1]);
  });

  it("honours the configured age window", () => {
    const c = { volume: { ...VOLUME_DEFAULTS, pruneAfterDays: 30 }, apply: cfg().apply };
    const r = classifyPrune([], [closed(1, { closedAt: days(31) })], c, NOW);
    expect(r.candidates.map((x) => x.number)).toEqual([1]);
    expect(classifyPrune([], [closed(1, { closedAt: days(29) })], c, NOW).candidates).toEqual([]);
  });

  it("holds a closed item whose own-repo parent still has an open child (GH-1883)", () => {
    // 7(open) and 8(closed, old) share parent 5. 9 is an unrelated closed leaf.
    const r = classifyPrune(
      [openItem(7, 5)],
      [closed(8, { parentNumber: 5 }), closed(9)],
      cfg(),
      NOW,
    );
    expect(r.candidates.map((c) => c.number)).toEqual([9]);
    expect(reasons(r)).toEqual({ 8: "sibling-edge" });
  });

  it("one hop only — a sibling's sibling is not walked (GH-1883)", () => {
    // 7(open) parent 5; 8(closed) parent 5 is held; 8's own child 10 is not.
    const r = classifyPrune(
      [openItem(7, 5)],
      [closed(8, { parentNumber: 5 }), closed(10, { parentNumber: 8 })],
      cfg(),
      NOW,
    );
    expect(r.candidates.map((c) => c.number)).toEqual([10]);
    expect(reasons(r)).toEqual({ 8: "sibling-edge" });
  });

  it("holds a closed item that blocks an open one — the inverse edge (GH-1883)", () => {
    const r = classifyPrune(
      [openItem(7, null, { closedBlockers: [8] })],
      [closed(8), closed(9)],
      cfg(),
      NOW,
    );
    expect(r.candidates.map((c) => c.number)).toEqual([9]);
    expect(reasons(r)).toEqual({ 8: "blocks-edge" });
  });

  it("a truncated blocker list on the open side fails closed for every candidate (GH-1883)", () => {
    const r = classifyPrune(
      [openItem(7, null, { blockersTruncated: true })],
      [closed(8), closed(9)],
      cfg(),
      NOW,
    );
    expect(r.candidates).toEqual([]);
    expect(reasons(r)).toEqual({ 8: "blocks-edge", 9: "blocks-edge" });
  });

  it("divergence is derived from the not-terminal keep, never a second detector (GH-1883)", () => {
    const r = classifyPrune(
      [],
      [closed(1, { state: "In Review" }), closed(2, { state: "(none)", stateReason: null }), closed(3)],
      cfg(),
      NOW,
    );
    expect(r.diverged).toEqual([
      { number: 1, state: "In Review", stateReason: "COMPLETED" },
      { number: 2, state: "(none)", stateReason: null },
    ]);
    // Every diverged item is also retained as not-terminal — one keep, two views.
    expect(reasons(r)).toEqual({ 1: "not-terminal", 2: "not-terminal" });
    expect(r.candidates.map((c) => c.number)).toEqual([3]);
  });

  it("oldest first — a bounded sweep should remove the deadest history", () => {
    const r = classifyPrune(
      [],
      [closed(1, { closedAt: days(200) }), closed(2, { closedAt: days(900) })],
      cfg(),
      NOW,
    );
    expect(r.candidates.map((c) => c.number)).toEqual([2, 1]);
  });
});

describe("doctor board-volume line (GH-1788)", () => {
  const line = (r: ReturnType<typeof doctor>) =>
    r.checks.find((c) => c.name === "board-volume")!;

  it("a small board reads ok and names the scan cost", () => {
    const gh = new FakeGh();
    gh.issues.set(1, { number: 1, state: "Backlog" });
    const c = line(doctor(makeCtx(gh)));
    expect(c.level).toBe("ok");
    expect(c.detail).toContain("page(s) per full scan");
  });

  /** A board that is over threshold AND has something prune can remove. */
  const prunableBoard = () => {
    const gh = new FakeGh();
    gh.issues.set(1, {
      number: 1,
      state: "Done",
      issueState: "CLOSED",
      stateReason: "COMPLETED",
      closedAt: new Date(NOW.getTime() - 400 * 86_400_000).toISOString(),
    });
    return gh;
  };

  it("over threshold WITH a prune candidate is INFO and never touches the exit code, --strict included", () => {
    const ctx = makeCtx(prunableBoard());
    ctx.cfg.volume = { ...ctx.cfg.volume, maxItems: 0 }; // any board is "over"
    const baseline = doctor(makeCtx(new FakeGh()), { strict: true }).ok;
    const r = doctor(ctx, { strict: true });
    expect(line(r).level).toBe("info");
    // The remedy removes items from the project — a human's call, never a gate.
    expect(line(r).detail).toContain("archiving would NOT help");
    expect(line(r).detail).toContain("`board prune` lists 1 closed item(s)");
    expect(r.ok).toBe(baseline);
  });

  // GH-2052. Once #2050 made the count honest the line became permanent on
  // this repo's own board — over threshold, nothing prunable, no action. An
  // `i` marker that can never clear is the check crying wolf about itself.
  it("over threshold with NOTHING prunable reads ok, still reports the scan, and says why", () => {
    const gh = new FakeGh();
    gh.issues.set(1, { number: 1, state: "Backlog" }); // open: never a candidate
    const ctx = makeCtx(gh);
    ctx.cfg.volume = { ...ctx.cfg.volume, maxItems: 0 };
    const c = line(doctor(ctx));
    expect(c.level).toBe("ok");
    // The measurement is never withheld — only the marker asking for action.
    expect(c.detail).toContain("page(s) per full scan");
    expect(c.detail).toContain("over 0 (RALPH_VOLUME_MAX_ITEMS)");
    expect(c.detail).toContain("Nothing is prunable");
    expect(c.detail).toContain(`${ctx.cfg.volume.pruneAfterDays}-day window`);
  });

  it("--fix never acts on it: a board over threshold with candidates produces no fix line", () => {
    const ctx = makeCtx(prunableBoard());
    ctx.cfg.volume = { ...ctx.cfg.volume, maxItems: 0 };
    const r = doctor(ctx, { fix: true });
    expect(line(r).level).toBe("info");
    const fixes = r.checks.filter((c) => c.name === "fix").map((c) => c.detail);
    expect(fixes.some((d) => /prune|remove|volume/i.test(d))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// prune THROUGH THE CLI (GH-1788 rework).
//
// The classifier had tests; the dispatch did not, and both shipped bugs lived
// exactly there: `--apply --json` returned before the apply block (a
// destructive command silently no-opping under the flag automation uses), and
// the removal loop was unbounded. Every test here drives run() end to end.
// ---------------------------------------------------------------------------

import { applyPrune, PRUNE_DEFAULT_LIMIT, PRUNE_MAX_CONSECUTIVE_FAILURES, pruneLimit } from "./board.js";

describe("prune CLI (GH-1788)", () => {
  const OLD = new Date(NOW.getTime() - 400 * 86_400_000).toISOString();

  /** N long-closed, terminal, prunable issues. */
  const boardWith = (n: number) => {
    const gh = new FakeGh();
    for (let i = 1; i <= n; i++) {
      gh.issues.set(i, {
        number: i,
        state: "Done",
        issueState: "CLOSED",
        stateReason: "COMPLETED",
        closedAt: OLD,
      });
    }
    return gh;
  };

  const drive = (argv: string[], ctx: Ctx) => {
    const said: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((s) => {
      said.push(String(s));
      return true;
    });
    let code: number;
    try {
      code = run(argv, ctx);
    } finally {
      spy.mockRestore();
    }
    return { code, text: said.join("") };
  };

  it("dry run removes nothing, in text and in JSON alike", () => {
    const gh = boardWith(3);
    const ctx = makeCtx(gh);

    const text = drive(["prune"], ctx);
    expect(text.code).toBe(0);
    expect(text.text).toContain("DRY RUN");
    expect(gh.removedItems).toEqual([]);

    const asJson = drive(["prune", "--json"], ctx);
    const parsed = JSON.parse(asJson.text);
    expect(parsed.applied).toBe(false);
    expect(parsed.candidates).toHaveLength(3);
    expect(gh.removedItems).toEqual([]);
  });

  // THE BLOCKER: --apply --json used to return `applied: false` with exit 0
  // having removed nothing at all.
  it("--apply --json actually applies and reports real counts", () => {
    const gh = boardWith(3);
    const res = drive(["prune", "--apply", "--json"], makeCtx(gh));

    expect(gh.removedItems).toHaveLength(3); // the removals REALLY happened
    const parsed = JSON.parse(res.text);
    expect(parsed.applied).toBe(true);
    expect(parsed.removed).toBe(3);
    expect(parsed.attempted).toBe(3);
    expect(parsed.failed).toEqual([]);
    expect(parsed.abortedAfterConsecutiveFailures).toBe(false);
    expect(res.code).toBe(0);
  });

  it("--apply in text mode removes and reports", () => {
    const gh = boardWith(2);
    const res = drive(["prune", "--apply"], makeCtx(gh));
    expect(gh.removedItems).toHaveLength(2);
    expect(res.text).toContain("removed 2 of 2 attempted item(s)");
    expect(res.code).toBe(0);
  });

  it("the two flags agree: --apply and --apply --json remove the same items", () => {
    const a = boardWith(4);
    drive(["prune", "--apply"], makeCtx(a));
    const b = boardWith(4);
    drive(["prune", "--apply", "--json"], makeCtx(b));
    expect(b.removedItems.sort()).toEqual(a.removedItems.sort());
  });

  it("a sweep is bounded by --limit; the remainder is reported, not silently dropped", () => {
    const gh = boardWith(10);
    const res = drive(["prune", "--apply", "--limit", "4"], makeCtx(gh));
    expect(gh.removedItems).toHaveLength(4);
    expect(res.text).toContain("6 candidate(s) left for the next run");
  });

  it("--limit is reported in the dry run so the operator knows a sweep will be partial", () => {
    const gh = boardWith(10);
    const res = drive(["prune", "--limit", "4"], makeCtx(gh));
    expect(res.text).toContain("One sweep removes at most 4");
    expect(gh.removedItems).toEqual([]);
  });

  it("a bad --limit is refused, never silently defaulted — it bounds a destructive loop", () => {
    expect(pruneLimit(undefined)).toBe(PRUNE_DEFAULT_LIMIT);
    expect(pruneLimit("5")).toBe(5);
    for (const bad of ["0", "-3", "2.5", "many", true as const]) {
      expect(() => pruneLimit(bad)).toThrow(UsageError);
    }
  });

  // FINDING 2: an unbounded loop kept firing mutations into a wall, burning
  // the exact GraphQL budget this work exists to protect.
  it("stops after consecutive failures instead of spending the budget on a wall", () => {
    const gh = boardWith(50);
    gh.failRemovals = "all";
    const res = drive(["prune", "--apply", "--json"], makeCtx(gh));

    const parsed = JSON.parse(res.text);
    expect(parsed.attempted).toBe(PRUNE_MAX_CONSECUTIVE_FAILURES); // NOT 50
    expect(parsed.removed).toBe(0);
    expect(parsed.abortedAfterConsecutiveFailures).toBe(true);
    expect(res.code).toBe(1);
    expect(gh.removedItems).toEqual([]);
  });

  it("isolated failures do not abort a healthy sweep — the breaker is consecutive", () => {
    const gh = boardWith(10);
    gh.failRemovals = 2; // first two fail, the rest succeed
    const res = drive(["prune", "--apply", "--json"], makeCtx(gh));

    const parsed = JSON.parse(res.text);
    expect(parsed.attempted).toBe(10);
    expect(parsed.removed).toBe(8);
    expect(parsed.failed).toHaveLength(2);
    expect(parsed.abortedAfterConsecutiveFailures).toBe(false);
    expect(res.code).toBe(1); // failures still surface in the exit code
  });

  it("applyPrune's breaker resets on progress", () => {
    const gh = boardWith(12);
    gh.failRemovals = PRUNE_MAX_CONSECUTIVE_FAILURES - 1; // one short of the limit
    const ctx = makeCtx(gh);
    const candidates = classifyPrune(
      [],
      ownRepo(ctx, listItemsFull(ctx).closed).own,
      ctx.cfg,
      NOW,
    ).candidates;
    const res = applyPrune(ctx, candidates);
    expect(res.aborted).toBe(false);
    expect(res.removed).toBe(12 - (PRUNE_MAX_CONSECUTIVE_FAILURES - 1));
  });

  it("--apply shows what it removed, not just a count — a destructive run shows its work", () => {
    const gh = boardWith(3);
    const res = drive(["prune", "--apply"], makeCtx(gh));
    expect(res.text).toContain("board volume:"); // scan cost still reported
    expect(res.text).toContain("#1 Done closed"); // the actual items
    expect(res.text).toContain("removed 3 of 3");
  });

  it("an --apply run under --json still reports zero candidates honestly", () => {
    const gh = new FakeGh();
    gh.issues.set(1, { number: 1, state: "Backlog" });
    const res = drive(["prune", "--apply", "--json"], makeCtx(gh));
    const parsed = JSON.parse(res.text);
    expect(parsed.applied).toBe(true);
    expect(parsed.attempted).toBe(0);
    expect(parsed.removed).toBe(0);
    expect(res.code).toBe(0);
  });

  it("nothing to prune stays exit 0 and removes nothing under --apply", () => {
    const gh = new FakeGh();
    gh.issues.set(1, { number: 1, state: "Backlog" }); // open, not a candidate
    const res = drive(["prune", "--apply"], makeCtx(gh));
    expect(gh.removedItems).toEqual([]);
    expect(res.code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// GH-1815 — foreign-repo items are opt-in, never implicit.
// ---------------------------------------------------------------------------

import {
  assertBoardAddAllowed,
  FOREIGN_REPO_ENV,
  parseForeignRepoPolicy,
  repoFromIssueUrl,
} from "./board.js";

describe("foreign-repo posture (GH-1815)", () => {
  describe("parseForeignRepoPolicy", () => {
    it("defaults to deny, and says it was never configured", () => {
      expect(parseForeignRepoPolicy({})).toEqual({ allow: false, configured: false });
    });

    it("reads an empty value as unset — an exported-but-empty shell var is not a decision", () => {
      expect(parseForeignRepoPolicy({ [FOREIGN_REPO_ENV]: "" })).toEqual({
        allow: false,
        configured: false,
      });
      expect(parseForeignRepoPolicy({ [FOREIGN_REPO_ENV]: "   " })).toEqual({
        allow: false,
        configured: false,
      });
    });

    it("distinguishes an explicit deny from the default — the whole point of `configured`", () => {
      expect(parseForeignRepoPolicy({ [FOREIGN_REPO_ENV]: "false" })).toEqual({
        allow: false,
        configured: true,
      });
    });

    it("accepts the usual truthy and falsy spellings, case-insensitively", () => {
      for (const yes of ["1", "true", "TRUE", "Yes", "on"])
        expect(parseForeignRepoPolicy({ [FOREIGN_REPO_ENV]: yes }).allow).toBe(true);
      for (const no of ["0", "false", "No", "OFF"])
        expect(parseForeignRepoPolicy({ [FOREIGN_REPO_ENV]: no }).allow).toBe(false);
    });

    it("fails CLOSED and warns on a value it cannot read — this one gates a write", () => {
      const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        expect(parseForeignRepoPolicy({ [FOREIGN_REPO_ENV]: "maybe" })).toEqual({
          allow: false,
          configured: true,
        });
        expect(warn.mock.calls.map((c) => String(c[0])).join("")).toContain(FOREIGN_REPO_ENV);
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe("repoFromIssueUrl", () => {
    it("reads owner/repo out of a github.com issue URL", () => {
      expect(repoFromIssueUrl("https://github.com/cdubiel08/ralph-hero/issues/1815")).toBe(
        "cdubiel08/ralph-hero",
      );
    });

    it("is host-agnostic — GHE has a different host and the same path shape", () => {
      expect(repoFromIssueUrl("https://ghe.corp.example/team/svc/issues/7")).toBe("team/svc");
    });

    it("returns null for anything it cannot read, rather than guessing", () => {
      expect(repoFromIssueUrl("u/900")).toBeNull();
      expect(repoFromIssueUrl("")).toBeNull();
      expect(repoFromIssueUrl("https://github.com/cdubiel08/ralph-hero/pull/12")).toBeNull();
    });
  });

  describe("assertBoardAddAllowed", () => {
    const ctxFor = (foreign: { allow: boolean; configured: boolean }): Ctx => {
      const c = makeCtx(new FakeGh());
      c.cfg.foreign = foreign;
      return c;
    };
    const own = "https://github.com/cdubiel08/ralph-hero/issues/5";
    const theirs = "https://github.com/someone-else/theirs/issues/5";

    it("permits an own-repo add under the default deny posture", () => {
      expect(() => assertBoardAddAllowed(ctxFor({ allow: false, configured: false }), own, 5)).not.toThrow();
    });

    it("refuses a foreign-repo add and names the variable that would permit it", () => {
      const msg = refusalMessage(() =>
        assertBoardAddAllowed(ctxFor({ allow: false, configured: false }), theirs, 5),
      );
      expect(msg).toContain("someone-else/theirs");
      expect(msg).toContain("cdubiel08/ralph-hero");
      expect(msg).toContain(FOREIGN_REPO_ENV);
      // Grandfathering is policy: the refusal must not read as "and I removed it".
      expect(msg).toContain("never removed");
    });

    it("refuses an unreadable URL — not knowing what is being added is not permission", () => {
      const msg = refusalMessage(() =>
        assertBoardAddAllowed(ctxFor({ allow: false, configured: false }), "u/5", 5),
      );
      expect(msg).toContain(FOREIGN_REPO_ENV);
    });

    it("compares repo slugs case-insensitively, like ownRepo does", () => {
      const c = ctxFor({ allow: false, configured: false });
      expect(() =>
        assertBoardAddAllowed(c, "https://github.com/CDubiel08/Ralph-Hero/issues/5", 5),
      ).not.toThrow();
    });

    it("under `allow`, permits anything — today's multi-repo behaviour, unchanged", () => {
      const c = ctxFor({ allow: true, configured: true });
      expect(() => assertBoardAddAllowed(c, theirs, 5)).not.toThrow();
      expect(() => assertBoardAddAllowed(c, "u/5", 5)).not.toThrow();
    });
  });

  describe("wired at the mutation, not at the verb", () => {
    it("adopt refuses a foreign issue and adds NOTHING to the board", () => {
      const gh = new FakeGh();
      gh.issues.set(5, { number: 5, state: null, onBoard: false, repo: "someone-else/theirs" });
      const ctx = makeCtx(gh);

      const msg = refusalMessage(() => adopt(ctx, 5));
      expect(msg).toContain(FOREIGN_REPO_ENV);
      expect(gh.issues.get(5)!.onBoard).toBeFalsy();
    });

    it("adopt is a no-op re-read for an issue already on the board — the guard is on the ADD", () => {
      const gh = new FakeGh();
      gh.issues.set(5, { number: 5, state: "Backlog", onBoard: true, repo: "someone-else/theirs" });
      // Grandfathered: a foreign item already on the board is doctor's to report,
      // never something a read path may refuse to look at.
      expect(() => adopt(makeCtx(gh), 5)).not.toThrow();
    });

    it("create still works — its issue is born in the configured repo", () => {
      const gh = new FakeGh();
      const issue = createIssue(makeCtx(gh), { title: "t", body: "b", state: "Intake" });
      expect(issue.number).toBeGreaterThan(0);
      expect(gh.issues.get(issue.number)!.onBoard).toBe(true);
    });
  });

  describe("doctor", () => {
    it("reports the deny posture as info, and says it was defaulted", () => {
      const ctx = makeCtx(new FakeGh());
      const check = doctor(ctx).checks.find((c) => c.name === "foreign-repo-policy");
      expect(check?.level).toBe("info");
      expect(check?.detail).toContain("deny");
      expect(check?.detail).toContain("default");
    });

    it("distinguishes an explicitly configured deny from the default", () => {
      const ctx = makeCtx(new FakeGh());
      ctx.cfg.foreign = { allow: false, configured: true };
      const check = doctor(ctx).checks.find((c) => c.name === "foreign-repo-policy");
      expect(check?.detail).toContain("deny");
      expect(check?.detail).toContain(FOREIGN_REPO_ENV);
      expect(check?.detail).not.toContain("default");
    });

    it("reports the allow posture", () => {
      const ctx = makeCtx(new FakeGh());
      ctx.cfg.foreign = { allow: true, configured: true };
      const check = doctor(ctx).checks.find((c) => c.name === "foreign-repo-policy");
      expect(check?.level).toBe("info");
      expect(check?.detail).toContain("allow");
    });

    it("warns about pre-existing foreign items under deny, naming them and the remedies", () => {
      const gh = new FakeGh();
      gh.issues.set(1, { number: 1, state: "Backlog" });
      gh.issues.set(2, { number: 2, state: "Backlog", repo: "someone-else/theirs" });
      const check = doctor(makeCtx(gh)).checks.find((c) => c.name === "foreign-items");
      expect(check?.level).toBe("warn");
      expect(check?.detail).toContain("someone-else/theirs#2");
      expect(check?.detail).toContain(FOREIGN_REPO_ENV);
      expect(check?.detail).toContain("never removed automatically");
    });

    it("never escalates under --strict and never removes under --fix — they are grandfathered", () => {
      const gh = new FakeGh();
      gh.issues.set(1, { number: 1, state: "Backlog" });
      gh.issues.set(2, { number: 2, state: "Backlog", repo: "someone-else/theirs" });

      const strict = doctor(makeCtx(gh), { strict: true });
      expect(strict.checks.find((c) => c.name === "foreign-items")?.level).toBe("warn");

      const fixed = doctor(makeCtx(gh), { fix: true });
      expect(fixed.checks.find((c) => c.name === "foreign-items")?.level).toBe("warn");
      expect(gh.removedItems).toEqual([]);
      expect(gh.issues.has(2)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Unlinked open PRs (GH-2048)
// ---------------------------------------------------------------------------

describe("pr-orphans", () => {
  const withPolicy = (gh: FakeGh, ignoreAuthors: string[], configured = true) => {
    const ctx = makeCtx(gh);
    return { ...ctx, cfg: { ...ctx.cfg, prOrphans: { ignoreAuthors, configured } } };
  };

  it("selects open PRs whose derived linkage names no issue, oldest first", () => {
    const gh = new FakeGh();
    gh.openPrs = [
      { number: 10, title: "linked", closing: 1, createdAt: "2026-07-30T12:00:00Z" },
      { number: 11, title: "orphan young", createdAt: "2026-07-29T12:00:00Z" },
      { number: 12, title: "orphan old", createdAt: "2026-07-08T12:00:00Z" },
    ];
    const res = prOrphans(makeCtx(gh));
    expect(res.scanned).toBe(3);
    expect(res.orphans.map((o) => o.number)).toEqual([12, 11]);
    expect(res.orphans[0].ageDays).toBe(23);
    expect(res.unreadable).toEqual([]);
  });

  it("skips the configured bot authors and counts them separately", () => {
    const gh = new FakeGh();
    gh.openPrs = [
      { number: 20, author: "dependabot[bot]" },
      { number: 21, author: "Dependabot[Bot]" }, // login case is not identity
      { number: 22, author: "a-human" },
    ];
    const res = prOrphans(withPolicy(gh, ["dependabot[bot]"]));
    expect(res.orphans.map((o) => o.number)).toEqual([22]);
    expect(res.ignored).toBe(2);
  });

  // The defect this line was built to avoid, and shipped with once: GraphQL
  // returns `dependabot`, every doc and the web UI say `dependabot[bot]`, and
  // a list written in either spelling alone matches half the reality. Measured
  // against this repo's own 12 standing dependabot PRs.
  it("matches a bot whichever spelling each side uses — GraphQL drops the [bot] suffix", () => {
    const gh = new FakeGh();
    gh.openPrs = [
      { number: 25, author: "dependabot" }, // as GraphQL actually returns it
      { number: 26, author: "dependabot[bot]" }, // as REST and the UI write it
    ];
    expect(prOrphans(withPolicy(gh, ["dependabot[bot]"])).orphans).toEqual([]);
    expect(prOrphans(withPolicy(gh, ["dependabot"])).orphans).toEqual([]);
    expect(prOrphans(withPolicy(gh, [...PR_ORPHAN_DEFAULT_IGNORE])).orphans).toEqual([]);
  });

  it("an empty ignore list surfaces bot PRs too", () => {
    const gh = new FakeGh();
    gh.openPrs = [{ number: 30, author: "dependabot[bot]" }];
    expect(prOrphans(withPolicy(gh, [])).orphans.map((o) => o.number)).toEqual([30]);
  });

  it("a deleted author is never matched against the ignore list", () => {
    const gh = new FakeGh();
    gh.openPrs = [{ number: 40, author: null }];
    const res = prOrphans(withPolicy(gh, ["dependabot[bot]"]));
    expect(res.orphans.map((o) => o.author)).toEqual([null]);
  });

  it("an unreadable linkage is its own bucket — never counted as linked or orphaned", () => {
    const gh = new FakeGh();
    gh.openPrs = [{ number: 50, unreadableLinkage: true }, { number: 51 }];
    const res = prOrphans(makeCtx(gh));
    expect(res.unreadable).toEqual([50]);
    expect(res.orphans.map((o) => o.number)).toEqual([51]);
  });

  it("pages, and refuses a page whose pagination metadata is missing", () => {
    const gh = new FakeGh();
    gh.itemsPageSize = 1;
    gh.openPrs = [{ number: 60 }, { number: 61, closing: 1 }, { number: 62 }];
    expect(prOrphans(makeCtx(gh)).orphans.map((o) => o.number)).toEqual([60, 62]);

    const broken = new FakeGh();
    broken.openPrs = [{ number: 70 }];
    broken.dropPageInfo = true;
    expect(() => prOrphans(makeCtx(broken))).toThrow(/pagination metadata missing/);
  });

  it("asks for the linkage at first: 1 — only its existence is in question", () => {
    const gh = new FakeGh();
    gh.openPrs = [{ number: 80 }];
    prOrphans(makeCtx(gh));
    const q = gh.queries.find((s) => s.includes("pullRequests(states: OPEN"))!;
    expect(q).toContain("closingIssuesReferences(first: 1)");
    expect(q).not.toContain("body");
  });

  describe("policy", () => {
    it("unset takes the defaults; explicitly empty means ignore nobody", () => {
      expect(parsePrOrphanPolicy({})).toEqual({
        ignoreAuthors: [...PR_ORPHAN_DEFAULT_IGNORE],
        configured: false,
      });
      expect(parsePrOrphanPolicy({ [PR_ORPHAN_IGNORE_ENV]: "" })).toEqual({
        ignoreAuthors: [],
        configured: true,
      });
      expect(
        parsePrOrphanPolicy({ [PR_ORPHAN_IGNORE_ENV]: " Bot-One[bot] , bot-two " }).ignoreAuthors,
      ).toEqual(["bot-one", "bot-two"]);
    });
  });

  describe("doctor line", () => {
    it("is advisory: info when orphans exist, never escalated by --strict, never acted on by --fix", () => {
      const gh = new FakeGh();
      gh.issues.set(1, { number: 1, state: "Backlog" });
      gh.openPrs = [{ number: 90, title: "unlinked" }];

      const rep = doctor(makeCtx(gh));
      const line = rep.checks.find((c) => c.name === "pr-orphans");
      expect(line?.level).toBe("info");
      expect(line?.detail).toContain("#90");

      expect(doctor(makeCtx(gh), { strict: true }).checks.find((c) => c.name === "pr-orphans")?.level).toBe("info");
      const fixed = doctor(makeCtx(gh), { fix: true });
      expect(fixed.checks.find((c) => c.name === "pr-orphans")?.level).toBe("info");
      // It files nothing and closes nothing.
      expect(gh.mutations.filter((m) => m.includes("createIssue"))).toEqual([]);
    });

    it("reads ok when nothing is unlinked", () => {
      const gh = new FakeGh();
      gh.issues.set(1, { number: 1, state: "Backlog" });
      gh.openPrs = [{ number: 91, closing: 1 }];
      expect(doctor(makeCtx(gh)).checks.find((c) => c.name === "pr-orphans")?.level).toBe("ok");
    });
  });
});

// ---------------------------------------------------------------------------
// Card signals (GH-2062) — the viewer's read.
// ---------------------------------------------------------------------------

import { cardSignals, recentDone } from "./board.js";

describe("card-signals (GH-2062)", () => {
  const OLD = "2026-07-31T10:00:00Z";
  let gh: FakeGh;
  let ctx: Ctx;
  beforeEach(() => {
    gh = new FakeGh();
    ctx = makeCtx(gh);
  });

  /** The whole reason this is not `deliver-queue`. That selector shells
   *  `merge-pr.sh --dry-run` per open PR — a merge gate on a viewer's timer,
   *  which contract rule 7 forbids and GH-1817 measured the cost of. */
  it("runs no subprocess at all — a viewer never runs the merge gate", () => {
    gh.issues.set(1, {
      number: 1, state: "In Review", stateUpdatedAt: OLD,
      prs: [{ number: 101, merged: false, prState: "OPEN", rollup: "SUCCESS", mergeable: "MERGEABLE" }],
    });
    const execs: string[][] = [];
    const spied: Ctx = { ...ctx, exec: (argv, stdin) => { execs.push(argv); return ctx.exec(argv, stdin); } };
    cardSignals(spied);
    expect(execs.filter((a) => a[0] !== "gh")).toHaveLength(0);
  });

  /** The rows deliver deliberately drops the PR number from — `no-open-pr`
   *  and `settling` — are exactly the merged and closed populations the purple
   *  and red inks exist for. This read carries the number for every one. */
  it("carries the PR number and fate for merged and closed-unmerged items alike", () => {
    gh.issues.set(1, {
      number: 1, state: "In Review", stateUpdatedAt: OLD,
      prs: [{ number: 101, merged: true, prState: "MERGED" }],
    });
    gh.issues.set(2, {
      number: 2, state: "In Review", stateUpdatedAt: OLD,
      prs: [{ number: 102, merged: false, prState: "CLOSED" }],
    });
    const res = cardSignals(ctx);
    const byIssue = new Map(res.inReview.map((r) => [r.number, r.prs]));
    expect(byIssue.get(1)).toEqual([
      { number: 101, state: "MERGED", merged: true, checks: null, mergeable: null },
    ]);
    expect(byIssue.get(2)?.[0]).toMatchObject({ number: 102, state: "CLOSED", merged: false });
  });

  /** An In Review item with NO linked PR is a real, ordinary state (a
   *  rollup-advanced epic parent). It must appear with an empty list rather
   *  than be omitted: omission is how the renderer spells "not read". */
  it("reports a PR-less In Review item as present-with-none, never as absent", () => {
    gh.issues.set(1, { number: 1, state: "In Review", stateUpdatedAt: OLD });
    const res = cardSignals(ctx);
    expect(res.inReview).toEqual([{ number: 1, prs: [] }]);
  });

  it("unions closing references with the branch convention, and rejects digit coincidences", () => {
    gh.issues.set(1807, {
      number: 1807, state: "In Review", stateUpdatedAt: OLD,
      branchRefs: [
        { name: "fix/1807-real", prs: [{ number: 901, merged: false, prState: "OPEN" }] },
        { name: "fix/18070-other-unit", prs: [{ number: 902, merged: false, prState: "OPEN" }] },
      ],
    });
    const res = cardSignals(ctx);
    expect(res.inReview[0].prs.map((p) => p.number)).toEqual([901]);
  });

  /** Only In Review items are asked about — the chip lives in that column, and
   *  the linkage read is the per-item cost. */
  it("asks about In Review items only", () => {
    gh.issues.set(1, { number: 1, state: "In Progress" });
    gh.issues.set(2, { number: 2, state: "In Review", stateUpdatedAt: OLD });
    gh.issues.set(3, { number: 3, state: "Backlog" });
    expect(cardSignals(ctx).inReview.map((r) => r.number)).toEqual([2]);
  });

  /** The nesting hazard GH-1811 measured at 607 points: cost is the PRODUCT of
   *  the `first:` values down a nesting, so a CONNECTION under
   *  `refs → associatedPullRequests` is enormous. `statusCheckRollup { state }`
   *  is a scalar on a plain object — probed live at cost 1, nodeCount 0 — and
   *  that distinction is what makes this document one call instead of two. */
  it("selects no nested CONNECTION inside the linkage, and makes exactly one call for it", () => {
    gh.issues.set(1, {
      number: 1, state: "In Review", stateUpdatedAt: OLD,
      prs: [{ number: 101, merged: false, prState: "OPEN", rollup: "SUCCESS" }],
    });
    gh.queries.length = 0;
    cardSignals(ctx);
    const linkage = gh.queries.filter((q) => q.includes("c0: issue(number"));
    expect(linkage).toHaveLength(1);
    expect(linkage[0]).toContain("statusCheckRollup { state }");
    // The costly connections deliver's own linkage carries and this one does
    // not: contexts under the rollup, and the comment/field reads a chip never
    // looks at.
    expect(linkage[0]).not.toContain("contexts(");
    expect(linkage[0]).not.toContain("comments(");
    expect(linkage[0]).not.toContain("projectItems");
    expect(linkage[0]).not.toContain("fieldValues");
  });

  /** The three linkage connections are UNPAGINATED, so a `hasNextPage` means
   *  GitHub had more than the page asked for — and the omitted PR is as likely
   *  to be the live one as any other. Answering from the partial list would let
   *  an older merged PR win the chip and paint an in-flight unit as landed.
   *  Same fail-closed rule the blocker, child and label reads apply. */
  it("holds an issue OUT of the answer when any linkage page is truncated", () => {
    for (const cut of ["closing", "refs", "branch-prs"] as const) {
      const g = new FakeGh();
      const c = makeCtx(g);
      g.issues.set(1, {
        number: 1, state: "In Review", stateUpdatedAt: OLD,
        prs: [{ number: 101, merged: true, prState: "MERGED" }],
        branchRefs: [{ name: "fix/1-live", prs: [{ number: 102, merged: false, prState: "OPEN" }] }],
      });
      g.truncateCardLinkage = cut;
      const res = cardSignals(c);
      // Absent from inReview is exactly what the cockpit draws as unread —
      // and NAMED, so a human running the verb sees which, rather than the
      // same silence a deleted issue produces.
      expect(res.inReview).toEqual([]);
      expect(res.unreadable).toEqual([1]);
    }
    // The control: with every page complete, the same fixture answers.
    expect(cardSignals(ctx).unreadable).toEqual([]);
  });

  it("rolls up each DISTINCT parent once, counting closed children", () => {
    gh.issues.set(1994, { number: 1994, title: "Epic: cockpit", state: "In Progress" });
    gh.issues.set(1, { number: 1, state: "Backlog", parent: 1994, issueState: "OPEN" });
    gh.issues.set(2, { number: 2, state: "Backlog", parent: 1994, issueState: "OPEN" });
    gh.issues.set(3, {
      number: 3, state: "Done", parent: 1994, issueState: "CLOSED", stateReason: "COMPLETED",
      closedAt: "2026-07-30T00:00:00Z",
    });
    gh.issues.set(4, {
      number: 4, state: "Done", parent: 1994, issueState: "CLOSED", stateReason: "COMPLETED",
      closedAt: "2026-07-30T00:00:00Z",
    });
    gh.queries.length = 0;
    const res = cardSignals(ctx);
    expect(res.epics).toEqual([
      { number: 1994, title: "Epic: cockpit", done: 2, total: 4, truncated: false },
    ]);
    // Two open children name one parent — one alias, not two.
    expect(gh.queries.filter((q) => q.includes("e0: issue(number"))).toHaveLength(1);
    expect(gh.queries.filter((q) => q.includes("e1: issue(number"))).toHaveLength(0);
  });

  it("makes no rollup call at all when nothing has a parent", () => {
    gh.issues.set(1, { number: 1, state: "Backlog" });
    gh.queries.length = 0;
    expect(cardSignals(ctx).epics).toEqual([]);
    expect(gh.queries.filter((q) => q.includes("subIssues"))).toHaveLength(0);
  });
});

describe("board closed — the Done window (GH-2062)", () => {
  const days = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
  let gh: FakeGh;
  let ctx: Ctx;
  beforeEach(() => {
    gh = new FakeGh();
    ctx = makeCtx(gh);
  });

  /** `reconcile`'s own rule verbatim: closed + NOT_PLANNED is Canceled, and a
   *  Canceled item in a Done column would be a second opinion about what Done
   *  means. */
  it("excludes NOT_PLANNED cancels and orders newest first", () => {
    gh.issues.set(1, {
      number: 1, title: "shipped first", state: "Done", issueState: "CLOSED",
      stateReason: "COMPLETED", closedAt: days(5), updatedAt: days(5),
    });
    gh.issues.set(2, {
      number: 2, title: "shipped second", state: "Done", issueState: "CLOSED",
      stateReason: "COMPLETED", closedAt: days(1), updatedAt: days(1),
    });
    gh.issues.set(3, {
      number: 3, title: "cancelled", state: "Canceled", issueState: "CLOSED",
      stateReason: "NOT_PLANNED", closedAt: days(2), updatedAt: days(2),
    });
    const res = recentDone(ctx, TEND_DEFAULTS);
    expect(res.items.map((c) => c.number)).toEqual([2, 1]);
    expect(res.windowDays).toBe(14);
  });

  /** The title is what the column renders, and it rides free: it is a scalar
   *  on a node the window read already pages. The audit's rows carried an
   *  empty title only because nothing had asked for one. */
  it("carries the title and the own-repo nameWithOwner the card's URL needs", () => {
    gh.issues.set(1, {
      number: 1, title: "Cockpit card markings", state: "Done", issueState: "CLOSED",
      stateReason: "COMPLETED", closedAt: days(1), updatedAt: days(1),
    });
    const [c] = recentDone(ctx, TEND_DEFAULTS).items;
    expect(c).toEqual({
      number: 1, repo: "cdubiel08/ralph-hero",
      title: "Cockpit card markings", closedAt: days(1),
    });
  });

  it("honours the window: a close older than auditDays is out", () => {
    gh.issues.set(1, {
      number: 1, state: "Done", issueState: "CLOSED", stateReason: "COMPLETED",
      closedAt: days(20), updatedAt: days(20),
    });
    expect(recentDone(ctx, { staleDays: 30, auditDays: 14 }).items).toEqual([]);
    expect(recentDone(ctx, { staleDays: 30, auditDays: 30 }).items).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Idempotent terminal transitions + the In Progress → Done edge (v0.2.0)
// ---------------------------------------------------------------------------

describe("same-state moves are retries, not violations", () => {
  let gh: FakeGh;
  let ctx: Ctx;
  beforeEach(() => {
    gh = new FakeGh();
    ctx = makeCtx(gh);
  });

  it("Done → Done with the issue closed is a pure noop — zero mutations", () => {
    gh.issues.set(1, { number: 1, state: "Done", issueState: "CLOSED" });
    const after = transition(ctx, fetchIssue(ctx, 1), "Done");
    expect(after.state).toBe("Done");
    expect(gh.mutations).toEqual([]);
  });

  it("Done → Done with the issue still OPEN re-drives only the close, on evidence", () => {
    // The half-applied shape: the field write landed, the close was lost to
    // the network. The retry completes it — and writes nothing else.
    gh.issues.set(1, { number: 1, state: "Done", issueState: "OPEN", prs: [{ number: 9, merged: true }] });
    const after = transition(ctx, fetchIssue(ctx, 1), "Done");
    expect(gh.mutations).toEqual(["closeIssue(#1, COMPLETED)"]);
    expect(after.issueState).toBe("CLOSED");
  });

  it("the re-drive runs the SAME evidence gates a fresh move would — a UI 'Done' is not evidence", () => {
    gh.issues.set(1, { number: 1, state: "Done", issueState: "OPEN" });
    expect(() => transition(ctx, fetchIssue(ctx, 1), "Done")).toThrow(UsageError);
    expect(gh.mutations).toEqual([]);
  });

  it("Canceled → Canceled with the issue OPEN completes the NOT_PLANNED close", () => {
    gh.issues.set(1, { number: 1, state: "Canceled", issueState: "OPEN" });
    transition(ctx, fetchIssue(ctx, 1), "Canceled");
    expect(gh.mutations).toEqual(["closeIssue(#1, NOT_PLANNED)"]);
  });

  it("Human Needed → Human Needed is a noop and needs no --why (a retry, not a new escalation)", () => {
    gh.issues.set(1, { number: 1, state: "Human Needed" });
    expect(() => transition(ctx, fetchIssue(ctx, 1), "Human Needed")).not.toThrow();
    expect(gh.mutations).toEqual([]);
    expect(gh.comments).toEqual([]);
  });

  it("the CLI reports the noop instead of an issue line", () => {
    gh.issues.set(1, { number: 1, state: "Done", issueState: "CLOSED" });
    let outText = "";
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((s) => {
      outText += String(s);
      return true;
    });
    try {
      expect(run(["move", "1", "done"], ctx)).toBe(0);
    } finally {
      spy.mockRestore();
    }
    expect(outText).toContain('noop: #1 already "Done"');
  });
});

describe("In Progress → Done and decision evidence", () => {
  let gh: FakeGh;
  let ctx: Ctx;
  beforeEach(() => {
    gh = new FakeGh();
    ctx = makeCtx(gh);
  });

  it("In Progress → Done is legal with a merged linked PR; the claim clears", () => {
    gh.issues.set(1, {
      number: 1, state: "In Progress",
      claim: encodeClaim("me@test", NOW),
      prs: [{ number: 9, merged: true }],
    });
    const after = transition(ctx, fetchIssue(ctx, 1), "Done");
    expect(after.state).toBe("Done");
    expect(gh.mutations).toContain("closeIssue(#1, COMPLETED)");
    expect(after.claim).toBeNull();
  });

  it("decisionEvidence: marker + artifact passes; a marker quoted in a code fence does not", () => {
    expect(decisionEvidence([`${DECISION_EVIDENCE_MARKER}\nartifact: thoughts/shared/research/x.md`]))
      .toBe("thoughts/shared/research/x.md");
    expect(decisionEvidence([`discussing the protocol:\n\`\`\`\n${DECISION_EVIDENCE_MARKER}\nartifact: y\n\`\`\``]))
      .toBeNull();
    expect(decisionEvidence([`${DECISION_EVIDENCE_MARKER}\nno artifact line here`])).toBeNull();
    expect(decisionEvidence([])).toBeNull();
  });

  it("a decision-evidence comment satisfies the Done gate for a unit with no PR", () => {
    gh.issues.set(1, {
      number: 1, state: "In Progress",
      claim: encodeClaim("me@test", NOW),
      comments: [`**Decision evidence**\n\n${DECISION_EVIDENCE_MARKER}\nartifact: thoughts/shared/plans/z.md`],
    });
    const after = transition(ctx, fetchIssue(ctx, 1), "Done");
    expect(after.state).toBe("Done");
  });

  it("move --decision posts the marker comment BEFORE the transition, so the record survives a refusal", () => {
    gh.issues.set(1, { number: 1, state: "In Progress", claim: encodeClaim("me@test", NOW) });
    // The fixture's comment list is static (the posted comment is recorded in
    // gh.comments, not served back), so the gate itself still refuses — which
    // is exactly the property under test: evidence lands first.
    expect(() => run(["move", "1", "done", "--decision", "thoughts/shared/research/w.md"], ctx)).toThrow(UsageError);
    expect(gh.comments.some((c) => c.body.includes(DECISION_EVIDENCE_MARKER))).toBe(true);
    expect(gh.comments.some((c) => c.body.includes("artifact: thoughts/shared/research/w.md"))).toBe(true);
  });
});

describe("doctor --fix completes the close the board was ahead of", () => {
  let gh: FakeGh;
  let ctx: Ctx;
  beforeEach(() => {
    gh = new FakeGh();
    ctx = makeCtx(gh);
  });

  it("board Done + issue OPEN + merged PR → close completed, never demoted", () => {
    gh.issues.set(1, { number: 1, state: "Done", issueState: "OPEN", prs: [{ number: 9, merged: true }] });
    doctor(ctx, { fix: true });
    expect(gh.mutations).toContain("closeIssue(#1, COMPLETED)");
    expect(gh.mutations.filter((m) => m.includes("setState(#1, Backlog)"))).toEqual([]);
  });

  it("board Done + issue OPEN with NO evidence → reconcile demotes as before", () => {
    gh.issues.set(1, { number: 1, state: "Done", issueState: "OPEN" });
    doctor(ctx, { fix: true });
    expect(gh.mutations).toContain("setState(#1, Backlog)");
    expect(gh.mutations.filter((m) => m.startsWith("closeIssue"))).toEqual([]);
  });

  it("board Canceled + issue OPEN → the NOT_PLANNED close is completed (cancel has no evidence gate)", () => {
    gh.issues.set(1, { number: 1, state: "Canceled", issueState: "OPEN" });
    doctor(ctx, { fix: true });
    expect(gh.mutations).toContain("closeIssue(#1, NOT_PLANNED)");
  });
});

// ---------------------------------------------------------------------------
// Defer — "the precondition is not met" as a typed parking lane (v0.2.0)
// ---------------------------------------------------------------------------

describe("defer parks an item out of ranking", () => {
  let gh: FakeGh;
  let ctx: Ctx;
  beforeEach(() => {
    gh = new FakeGh();
    ctx = makeCtx(gh);
  });

  it("parseDefer/formatDefer round-trip, condition-only, and garbage tolerance", () => {
    const m = parseDefer("2026-09-01T00:00:00.000Z|model-gate repo goes public")!;
    expect(m.recheck?.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(m.condition).toBe("model-gate repo goes public");
    expect(formatDefer(m)).toBe("2026-09-01T00:00:00.000Z|model-gate repo goes public");
    expect(parseDefer("-|just a condition")).toEqual({ recheck: null, condition: "just a condition" });
    expect(parseDefer("bare condition, no pipe")).toEqual({ recheck: null, condition: "bare condition, no pipe" });
    expect(parseDefer("")).toBeNull();
    expect(parseDefer(null)).toBeNull();
    // A garbled instant degrades to condition-only, never to "not deferred".
    expect(parseDefer("not-a-date|cond")).toEqual({ recheck: null, condition: "cond" });
  });

  it("a deferred item never ranks — its own bucket, not blocked", () => {
    gh.issues.set(1, { number: 1, state: "Backlog", defer: "-|waiting on GH-2088" });
    gh.issues.set(2, { number: 2, state: "Backlog" });
    const { eligible, blocked, deferred } = rankNext(listItems(ctx));
    expect(eligible.map((i) => i.number)).toEqual([2]);
    expect(blocked).toEqual([]);
    expect(deferred.map((i) => i.number)).toEqual([1]);
  });

  it("all-deferred is a typed empty verdict, so a loop terminates honestly", () => {
    gh.issues.set(1, { number: 1, state: "Backlog", defer: "-|precondition" });
    const { eligible, blocked, inFlightEpics, deferred } = rankNext(listItems(ctx));
    const dx = diagnoseEmptyQueue(listItems(ctx), eligible, blocked, inFlightEpics, deferred);
    expect(dx.diagnosis).toBe("all-deferred");
    expect(dx.deferredCount).toBe(1);
  });

  it("defer verb writes comment-then-field; --clear reverses; bad --recheck refused at write time", () => {
    gh.issues.set(1, { number: 1, state: "Backlog" });
    expect(run(["defer", "1", "--until", "sandbox spike lands", "--recheck", "2026-09-01T00:00:00Z"], ctx)).toBe(0);
    expect(gh.comments.some((c) => c.body.includes("parked — sandbox spike lands"))).toBe(true);
    expect(gh.mutations).toContain("setDefer(#1)");
    // comment precedes the field write (interrupted run leaves the reason)
    expect(gh.mutations.indexOf("addComment")).toBeLessThan(gh.mutations.indexOf("setDefer(#1)"));
    expect(run(["defer", "1", "--clear"], ctx)).toBe(0);
    expect(gh.issues.get(1)!.defer).toBeNull();
    expect(() => run(["defer", "1", "--until", "x", "--recheck", "next tuesday"], ctx)).toThrow(UsageError);
    expect(() => run(["defer", "1"], ctx)).toThrow(UsageError);
  });

  it("claiming a deferred unit lifts the mark — the claim IS the assertion the precondition holds", () => {
    gh.issues.set(1, { number: 1, state: "Backlog", defer: "-|waiting" });
    const after = transition(ctx, fetchIssue(ctx, 1), "In Progress");
    expect(after.state).toBe("In Progress");
    expect(gh.mutations).toContain("clearField(#1, F_defer)");
    expect(gh.issues.get(1)!.defer).toBeNull();
  });

  it("doctor: defer-elapsed is info with the remedy; a future recheck stays ok", () => {
    gh.issues.set(1, { number: 1, state: "Backlog", defer: "2026-07-01T00:00:00Z|cond-a" }); // past (NOW is 07-31)
    gh.issues.set(2, { number: 2, state: "Backlog", defer: "2027-01-01T00:00:00Z|cond-b" }); // future
    const rep = doctor(ctx);
    const line = rep.checks.find((c) => c.name === "defer-elapsed")!;
    expect(line.level).toBe("info");
    expect(line.detail).toContain("#1(cond-a)");
    expect(line.detail).not.toContain("#2");
  });

  it("doctor: untriaged-priority counts null-priority Backlog items and names the remedy", () => {
    gh.issues.set(1, { number: 1, state: "Backlog" });
    gh.issues.set(2, { number: 2, state: "Backlog", priority: "P1" });
    gh.issues.set(3, { number: 3, state: "In Progress", claim: encodeClaim("me@test", NOW) });
    const rep = doctor(ctx);
    const line = rep.checks.find((c) => c.name === "untriaged-priority")!;
    expect(line.level).toBe("info");
    expect(line.detail).toContain("1 Backlog item(s)");
    expect(line.detail).toContain("#1");
    expect(line.detail).toContain("board priority");
  });

});

// ---------------------------------------------------------------------------
// Batch 3 (v0.2.0): stale-claim lock consult, stranded worktrees, accepted-
// but-unmoved proposals, reviewer-rate-limited deliver rows
// ---------------------------------------------------------------------------

describe("doctor --fix consults the local worktree lock before releasing a stale claim", () => {
  let gh: FakeGh;
  let ctx: Ctx;
  beforeEach(() => {
    gh = new FakeGh();
    ctx = makeCtx(gh);
  });

  it("a fresh local lock holds the release and reports claim-idle-but-driven", () => {
    const staleSince = new Date(NOW.getTime() - 200 * 60_000);
    gh.issues.set(1, { number: 1, state: "In Progress", claim: encodeClaim("me@test", staleSince) });
    // A live peer session's lock, fresh on the same TTL clock (the network-
    // flap divergence: local heartbeat landed, board write did not).
    const dir = mkdtempSync(join(tmpdir(), "ralph-locks-"));
    writeFileSync(
      join(dir, "wt-1-0123456789abcdef.json"),
      JSON.stringify({ session: "peer-session", worktree: "/tmp/wt", since: NOW.toISOString() }),
    );
    const ctx2: Ctx = { ...ctx, session: { id: "my-session", dir } };
    const rep = doctor(ctx2, { fix: true });
    const line = rep.checks.find((c) => c.name === "claim-idle-but-driven");
    expect(line?.level).toBe("info");
    expect(gh.mutations.filter((m) => m.includes("clearField(#1"))).toEqual([]);
    expect(gh.issues.get(1)!.claim).not.toBeNull();
  });

  it("no lock (or unreadable dir) keeps today's release exactly", () => {
    const staleSince = new Date(NOW.getTime() - 200 * 60_000);
    gh.issues.set(1, { number: 1, state: "In Progress", claim: encodeClaim("me@test", staleSince) });
    doctor(ctx, { fix: true });
    expect(gh.mutations).toContain("clearField(#1, F_claim)");
    expect(gh.mutations).toContain("setState(#1, Backlog)");
  });
});

describe("doctor surfaces stranded worktrees (uncommitted work, no claim)", () => {
  it("dirty issue-branch worktree with no board claim is an info row; claimed or clean ones are not", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    gh.issues.set(7, { number: 7, state: "Backlog" });
    gh.issues.set(8, { number: 8, state: "In Progress", claim: encodeClaim("me@test", NOW) });
    gh.worktreeList = [
      "worktree /repo\nHEAD abc\nbranch refs/heads/main",
      "worktree /wt/feat-7\nHEAD abc\nbranch refs/heads/feat/7-something",
      "worktree /wt/feat-8\nHEAD abc\nbranch refs/heads/feat/8-claimed",
      "worktree /wt/clean-9\nHEAD abc\nbranch refs/heads/fix/9-clean",
    ].join("\n\n");
    gh.dirtyWorktrees = new Set(["/wt/feat-7", "/wt/feat-8"]);
    const rep = doctor(ctx);
    const line = rep.checks.find((c) => c.name === "worktree-uncommitted")!;
    expect(line.level).toBe("info");
    expect(line.detail).toContain("#7(/wt/feat-7)");
    expect(line.detail).not.toContain("#8"); // claimed — someone is driving it
    expect(line.detail).not.toContain("#9"); // clean — nothing stranded
  });
});

describe("accepted-but-unmoved proposals (audit B9)", () => {
  const proposal = `${TEND_PROPOSAL_MARKER}\n\`\`\`json\n{"action":"close-as-delivered","at":"2026-07-20T00:00:00Z"}\n\`\`\``;
  const accepted = (extra = "") =>
    `${TEND_RESOLUTION_MARKER}\n\`\`\`json\n{"disposition":"accepted","at":"2026-07-21T00:00:00Z"${extra}}\n\`\`\``;

  it("acceptedUnactioned: accepted stands; rejected, actioned, reopen-note, and re-armed all clear it", () => {
    expect(acceptedUnactioned([proposal, accepted()])).toEqual({ at: "2026-07-21T00:00:00Z" });
    expect(acceptedUnactioned([proposal, accepted(',"actioned":true')])).toBeNull();
    expect(
      acceptedUnactioned([
        proposal,
        `Resolved by \`board reopen\`.\n${accepted()}`,
      ]),
    ).toBeNull();
    expect(acceptedUnactioned([proposal, accepted(), proposal])).toBeNull(); // re-armed
    expect(
      acceptedUnactioned([proposal, `${TEND_RESOLUTION_MARKER}\n\`\`\`json\n{"disposition":"rejected","at":"x"}\n\`\`\``]),
    ).toBeNull();
  });

  it("the smell line lists an accepted-unactioned Backlog item immediately", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    gh.issues.set(1, { number: 1, state: "Backlog", comments: [proposal, accepted()] });
    const rep = doctor(ctx);
    const line = rep.checks.find((c) => c.name === "tend-proposal-stale")!;
    expect(line.level).toBe("info");
    expect(line.detail).toContain("#1(accepted 2026-07-21, unactioned)");
  });

  it("resolve --accept prints the follow-up disposition commands", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    gh.issues.set(1, { number: 1, state: "Backlog", comments: [proposal] });
    let outText = "";
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((s) => {
      outText += String(s);
      return true;
    });
    try {
      expect(run(["resolve", "1", "--accept"], ctx)).toBe(0);
    } finally {
      spy.mockRestore();
    }
    expect(outText).toContain("complete the disposition");
    expect(outText).toContain("board move 1 done");
  });
});

// ---------------------------------------------------------------------------
// Batch 4 (v0.2.0): typed transport handling + budget machinery (audit B2)
// ---------------------------------------------------------------------------

describe("typed transport handling", () => {
  let gh: FakeGh;
  let ctx: Ctx;
  beforeEach(() => {
    gh = new FakeGh();
    ctx = makeCtx(gh);
  });

  it("a transport-shaped READ failure is retried, then typed TransientError", () => {
    let calls = 0;
    const flaky: Ctx = {
      ...ctx,
      exec: (argv, stdin) => {
        if (argv.join(" ").startsWith("gh api graphql")) {
          calls++;
          return { code: 1, stdout: "", stderr: "net/http: TLS handshake timeout" };
        }
        return ctx.exec(argv, stdin);
      },
    };
    expect(() => ghGraphQL(flaky, "query { viewer { login } }", {})).toThrow(TransientError);
    expect(calls).toBe(3); // initial + 2 bounded retries
  });

  it("a MUTATION never retries on transport failure — read-back over replay (GH-1973)", () => {
    let calls = 0;
    const flaky: Ctx = {
      ...ctx,
      exec: (argv, stdin) => {
        if (argv.join(" ").startsWith("gh api graphql")) {
          calls++;
          return { code: 1, stdout: "", stderr: "connection reset by peer" };
        }
        return ctx.exec(argv, stdin);
      },
    };
    expect(() => ghGraphQL(flaky, "mutation { x }", {})).toThrow(/gh api graphql failed/);
    expect(calls).toBe(1);
  });

  it("a non-transport failure is not retried and stays a plain error", () => {
    let calls = 0;
    const broken: Ctx = {
      ...ctx,
      exec: (argv, stdin) => {
        if (argv.join(" ").startsWith("gh api graphql")) {
          calls++;
          return { code: 1, stdout: "", stderr: "GraphQL: Field 'nope' doesn't exist" };
        }
        return ctx.exec(argv, stdin);
      },
    };
    expect(() => ghGraphQL(broken, "query { viewer { login } }", {})).toThrow(Error);
    expect(() => ghGraphQL(broken, "query { viewer { login } }", {})).not.toThrow(TransientError);
    expect(calls).toBe(2); // one per assertion — no retries
  });

  it("RATE_LIMITED in the body is a TransientError, never a GraphQLError", () => {
    const limited: Ctx = {
      ...ctx,
      exec: (argv, stdin) => {
        if (argv.join(" ").startsWith("gh api graphql"))
          return {
            code: 0,
            stdout: JSON.stringify({ errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] }),
            stderr: "",
          };
        return ctx.exec(argv, stdin);
      },
    };
    expect(() => ghGraphQL(limited, "query { viewer { login } }", {})).toThrow(TransientError);
  });

  it("lane pre-flight defers under the floor (exit 75) and fails OPEN on an unreadable budget", () => {
    gh.issues.set(1, { number: 1, state: "Backlog" });
    const starved: Ctx = {
      ...ctx,
      exec: (argv, stdin) => {
        if (argv.join(" ") === `gh api --hostname github.com rate_limit`)
          return { code: 0, stdout: JSON.stringify({ resources: { graphql: { remaining: 3, reset: 1755600000 } } }), stderr: "" };
        return ctx.exec(argv, stdin);
      },
    };
    const errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const old = process.env.RALPH_GH_BUDGET_FLOOR;
      process.env.RALPH_GH_BUDGET_FLOOR = "500";
      try {
        expect(run(["next"], starved)).toBe(75);
        // Unreadable budget (FakeGh answers code 1 for rate_limit): proceeds.
        expect(run(["next"], ctx)).toBe(0);
      } finally {
        if (old === undefined) delete process.env.RALPH_GH_BUDGET_FLOOR;
        else process.env.RALPH_GH_BUDGET_FLOOR = old;
      }
    } finally {
      errSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Batch 5 (v0.2.0): brief / who / help <verb> / bootstrap / add / C1
// ---------------------------------------------------------------------------

describe("orientation verbs (audit A2/A5)", () => {
  let gh: FakeGh;
  let ctx: Ctx;
  let outText: string;
  let spy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    gh = new FakeGh();
    ctx = makeCtx(gh);
    outText = "";
    spy = vi.spyOn(process.stdout, "write").mockImplementation((s) => {
      outText += String(s);
      return true;
    }) as any;
  });
  afterEach(() => spy.mockRestore());

  it("brief: one read carries next head, queue counts, deliver/tend counts and leases", () => {
    gh.issues.set(1, { number: 1, state: "Backlog", priority: "P1" });
    gh.issues.set(2, { number: 2, state: "In Review", prs: [{ number: 9, merged: false }] });
    gh.issues.set(3, { number: 3, state: "Backlog", defer: "-|later" });
    expect(run(["brief"], ctx)).toBe(0);
    expect(outText).toContain("next: #1");
    expect(outText).toMatch(/1 eligible.*1 deferred/s);
    expect(outText).toContain("deliver");
  });

  it("brief --json is the same facts, typed; leases null ≠ []", () => {
    gh.issues.set(1, { number: 1, state: "Backlog" });
    expect(run(["brief", "--json"], ctx)).toBe(0);
    const j = JSON.parse(outText);
    expect(j.next[0].number).toBe(1);
    expect(j.counts.eligible).toBe(1);
    expect(j.leases).toBeNull(); // makeCtx has no session dir — not evaluated, never "nobody"
  });

  it("who reads the local leases and says 'not evaluated' when the dir is unreadable", () => {
    expect(run(["who"], ctx)).toBe(0);
    expect(outText).toContain("not evaluated");
    outText = "";
    const dir = mkdtempSync(join(tmpdir(), "ralph-who-"));
    writeFileSync(
      join(dir, "wt-42-0123456789abcdef.json"),
      JSON.stringify({ session: "s-1", worktree: "/wt/42", since: NOW.toISOString() }),
    );
    const ctx2: Ctx = { ...ctx, session: { id: "s-1", dir } };
    expect(run(["who"], ctx2)).toBe(0);
    expect(outText).toContain("#42 (this session) in /wt/42");
  });

  it("help <verb> prints the per-verb entry; unknown verb exits 64 with the list", () => {
    expect(run(["help", "defer"], ctx)).toBe(0);
    expect(outText).toContain("board defer <n> --until");
    outText = "";
    expect(run(["help", "no-such-verb"], ctx)).toBe(64);
    expect(outText).toContain("no such verb");
  });
});

describe("bootstrap and add (audit C2/C4)", () => {
  it("writeBootstrapConfig validates flags, writes .ralph.json once, refuses overwrite", () => {
    const dir = mkdtempSync(join(tmpdir(), "ralph-boot-"));
    expect(() => writeBootstrapConfig(dir, {})).toThrow(UsageError);
    expect(() => writeBootstrapConfig(dir, { owner: "o", repo: "r", project: "x" })).toThrow(UsageError);
    const path = writeBootstrapConfig(dir, { owner: "o", repo: "r", project: "7" });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ owner: "o", repo: "r", projectNumber: 7 });
    expect(() => writeBootstrapConfig(dir, { owner: "o", repo: "r", project: "7" })).toThrow(/already exists/);
  });

  it("add refuses a foreign issue under the default deny posture, with the env named", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    expect(() => run(["add", "https://github.com/other/repo/issues/9"], ctx)).toThrow(/RALPH_ALLOW_FOREIGN_REPO_ITEMS|foreign/i);
  });
});

describe("readiness merge-gate checks its stated alternative (audit C1)", () => {
  it("required status checks on the default branch satisfy the rung without a scripted gate", () => {
    const gh = new FakeGh();
    const base = makeCtx(gh);
    const ctx: Ctx = {
      ...base,
      exec: (argv, stdin) => {
        const cmd = argv.join(" ");
        if (cmd === "gh api --hostname github.com repos/cdubiel08/ralph-hero")
          return { code: 0, stdout: JSON.stringify({ default_branch: "main" }), stderr: "" };
        if (cmd === "gh api --hostname github.com repos/cdubiel08/ralph-hero/rules/branches/main")
          return {
            code: 0,
            stdout: JSON.stringify([{ type: "pull_request" }, { type: "required_status_checks" }]),
            stderr: "",
          };
        return base.exec(argv, stdin);
      },
    };
    const rep = readiness(ctx);
    const gate = rep.checks.find((c) => c.name === "merge-gate")!;
    expect(gate.status).toBe("ok");
    expect(gate.detail).toContain("required status checks");
  });

  it("unreadable rules stay a miss — a read we could not make is not 'satisfied'", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh); // FakeGh answers code 1 for the repo API
    const rep = readiness(ctx);
    const gate = rep.checks.find((c) => c.name === "merge-gate")!;
    expect(gate.status).toBe("miss");
  });
});

describe("dep-candidates (GH-2135) — recall-biased dependency selector", () => {
  describe("term scoring (pure)", () => {
    it("keeps hyphenated identifiers whole and drops glue words", () => {
      const t = depCandidateTerms("Extend dep-refs.sh to the refill and work-next surfaces");
      expect(t.has("dep-refs")).toBe(true);
      expect(t.has("work-next")).toBe(true);
      expect(t.has("the")).toBe(false);
      expect(t.has("and")).toBe(false);
      expect(t.has("to")).toBe(false); // length < 3
    });

    it("weighs down board-wide vocabulary without a stopword list", () => {
      // "board" appears in every doc; "cursor" is shared with exactly one.
      const target = { number: 1, title: "board cursor walk", body: "" };
      const pool = [
        { number: 2, title: "board cursor drops", body: "" },
        { number: 3, title: "board colors", body: "" },
        { number: 4, title: "board fonts", body: "" },
      ];
      const { candidates } = scoreDepCandidates(target, pool, 10);
      // The distinctive shared term wins; "board"-only overlap ranks far
      // below but is NOT disqualified — recall bias prices ubiquity in the
      // ranking, never in the qualification.
      expect(candidates[0].number).toBe(2);
      expect(candidates[0].terms).toContain("cursor");
      expect(candidates.map((c) => c.number)).toEqual([2, 3, 4]);
      expect(candidates[0].score).toBeGreaterThan(candidates[1].score * 2);
    });

    it("scores on body terms, not just titles", () => {
      const target = { number: 1, title: "a", body: "the mutationCache refusal path" };
      const pool = [
        { number: 2, title: "b", body: "extend the mutationCache read" },
        { number: 3, title: "c", body: "unrelated prose entirely" },
      ];
      const { candidates } = scoreDepCandidates(target, pool, 10);
      expect(candidates.map((c) => c.number)).toEqual([2]);
    });

    it("honours the cap and reports what it dropped, highest scores kept", () => {
      const target = { number: 1, title: "alpha beta gamma delta", body: "" };
      const pool = [
        { number: 2, title: "alpha beta gamma", body: "" },
        { number: 3, title: "alpha beta", body: "" },
        { number: 4, title: "alpha", body: "" },
      ];
      const { candidates, capped } = scoreDepCandidates(target, pool, 2);
      expect(candidates.map((c) => c.number)).toEqual([2, 3]);
      expect(capped).toBe(1);
    });

    it("ties break by issue number, ascending", () => {
      const target = { number: 1, title: "alpha", body: "" };
      const pool = [
        { number: 9, title: "alpha", body: "" },
        { number: 3, title: "alpha", body: "" },
      ];
      const { candidates } = scoreDepCandidates(target, pool, 10);
      expect(candidates.map((c) => c.number)).toEqual([3, 9]);
    });
  });

  describe("parseDepCandidatesCap", () => {
    it("defaults to 10 and refuses nonsense", () => {
      expect(parseDepCandidatesCap(undefined)).toBe(10);
      expect(parseDepCandidatesCap("25")).toBe(25);
      expect(parseDepCandidatesCap("0")).toBe(10);
      expect(parseDepCandidatesCap("-3")).toBe(10);
      expect(parseDepCandidatesCap("banana")).toBe(10);
    });
  });

  describe("through the CLI", () => {
    let gh: FakeGh;
    let ctx: Ctx;
    beforeEach(() => {
      gh = new FakeGh();
      ctx = makeCtx(gh);
    });

    const capture = (argv: string[]) => {
      const said: string[] = [];
      const spy = vi.spyOn(process.stdout, "write").mockImplementation((s) => {
        said.push(String(s));
        return true;
      });
      try {
        run(argv, ctx);
      } finally {
        spy.mockRestore();
      }
      return said.join("");
    };

    it("excludes self, claimed, non-Backlog, wired (both directions), and parent/child", () => {
      gh.issues.set(1, { number: 1, state: "Backlog", title: "widget frobnicator core", parent: 8 });
      gh.issues.set(2, { number: 2, state: "Backlog", title: "widget frobnicator docs" }); // the one real candidate
      gh.issues.set(3, { number: 3, state: "Backlog", title: "widget frobnicator claimed", claim: encodeClaim("a@h", NOW) });
      gh.issues.set(4, { number: 4, state: "In Progress", title: "widget frobnicator running" });
      gh.issues.set(5, { number: 5, state: "Backlog", title: "widget frobnicator wired", blockedBy: [{ number: 1, state: "OPEN" }] });
      gh.issues.set(6, { number: 6, state: "Backlog", title: "widget frobnicator child", parent: 1 });
      gh.issues.set(7, { number: 7, state: "Intake", title: "widget frobnicator unapproved" });
      gh.issues.set(8, { number: 8, state: "Backlog", title: "widget frobnicator parent epic" });

      const res = JSON.parse(capture(["dep-candidates", "1", "--json"]));
      expect(res.candidates.map((c: any) => c.number)).toEqual([2]);
      expect(res.disclaimer).toBe(DEP_CANDIDATES_DISCLAIMER);
      expect(res.target).toBe(1);
    });

    it("excludes items the target is wired to (target.blockedBy)", () => {
      gh.issues.set(1, { number: 1, state: "Backlog", title: "widget core", blockedBy: [{ number: 2, state: "OPEN" }] });
      gh.issues.set(2, { number: 2, state: "Backlog", title: "widget base" });
      gh.issues.set(3, { number: 3, state: "Backlog", title: "widget extras" });
      const res = JSON.parse(capture(["dep-candidates", "1", "--json"]));
      expect(res.candidates.map((c: any) => c.number)).toEqual([3]);
    });

    it("keeps deferred Backlog items in the pool (recall bias)", () => {
      gh.issues.set(1, { number: 1, state: "Backlog", title: "cache oracle etag" });
      gh.issues.set(2, { number: 2, state: "Backlog", title: "cache oracle recheck", defer: "2099-01-01T00:00:00Z|until the API ships" });
      const res = JSON.parse(capture(["dep-candidates", "1", "--json"]));
      expect(res.candidates.map((c: any) => c.number)).toEqual([2]);
    });

    it("says NOT CHECKED on stderr and keeps the error when the read fails", () => {
      const err: string[] = [];
      const spy = vi.spyOn(process.stderr, "write").mockImplementation((s) => {
        err.push(String(s));
        return true;
      });
      const broken = { ...ctx, exec: () => ({ code: 1, stdout: "", stderr: "boom" }) };
      try {
        expect(() => run(["dep-candidates", "1"], broken)).toThrow();
      } finally {
        spy.mockRestore();
      }
      expect(err.join("")).toContain("NOT CHECKED");
    });

    it("the body batch document carries ZERO nested connections (cost floor)", () => {
      gh.issues.set(1, { number: 1, state: "Backlog", title: "gadget one" });
      gh.issues.set(2, { number: 2, state: "Backlog", title: "gadget two" });
      capture(["dep-candidates", "1", "--json"]);
      const doc = gh.queries.find((q) => q.includes("db0: issue(number"));
      expect(doc).toBeDefined();
      expect(doc!).not.toMatch(/first:/);
    });

    it("text output carries the disclaimer even when nothing overlaps", () => {
      gh.issues.set(1, { number: 1, state: "Backlog", title: "aardvark umbrella" });
      gh.issues.set(2, { number: 2, state: "Backlog", title: "zeppelin quartz" });
      const text = capture(["dep-candidates", "1"]);
      expect(text).toContain("candidates are NOT dependencies");
      expect(text).toContain("absence of overlap is not evidence of independence");
    });
  });
});

describe("filing-path dependency check (GH-2137) — create prints dep-candidates", () => {
  let gh: FakeGh;
  let ctx: Ctx;
  beforeEach(() => {
    gh = new FakeGh();
    ctx = makeCtx(gh);
  });

  /** Run argv capturing BOTH streams — the advisory lives on stderr, and the
   *  create's own output must stay untouched on stdout. */
  const captureBoth = (argv: string[], c: Ctx = ctx) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const so = vi.spyOn(process.stdout, "write").mockImplementation((s) => {
      stdout.push(String(s));
      return true;
    });
    const se = vi.spyOn(process.stderr, "write").mockImplementation((s) => {
      stderr.push(String(s));
      return true;
    });
    let code: number;
    try {
      code = run(argv, c);
    } finally {
      so.mockRestore();
      se.mockRestore();
    }
    return { code, stdout: stdout.join(""), stderr: stderr.join("") };
  };

  it("depFilingThreshold is three fully-distinctive shared terms' weight, population-relative", () => {
    expect(depFilingThreshold(2)).toBeCloseTo(3 * Math.log(3 / 2));
    expect(depFilingThreshold(100)).toBeCloseTo(3 * Math.log(101 / 2));
    // The bar RISES with the population — an absolute score would silently
    // loosen as the backlog grows.
    expect(depFilingThreshold(100)).toBeGreaterThan(depFilingThreshold(2));
  });

  it("prints high-overlap candidates on stderr when the bar clears; filing output untouched", () => {
    gh.issues.set(1, { number: 1, state: "Backlog", title: "cachetoken oracleblade etagfrost walkspine sibling" });
    gh.issues.set(2, { number: 2, state: "Backlog", title: "zeppelin quartz aardvark" });
    const r = captureBoth([
      "create", "--backlog", "--priority", "P1", "--estimate", "S",
      "--title", "cachetoken oracleblade etagfrost walkspine follow-up",
    ]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("possible dependencies");
    expect(r.stderr).toContain("#1");
    expect(r.stderr).toContain(DEP_CANDIDATES_DISCLAIMER);
    expect(r.stderr).toContain("board dep");
    expect(r.stderr).not.toContain("#2"); // low overlap never rides along
    expect(r.stdout).toContain("https://"); // the create's own output survives
  });

  it("prints NOTHING when no candidate clears the bar — an every-filing banner trains readers to skip it", () => {
    gh.issues.set(1, { number: 1, state: "Backlog", title: "zeppelin quartz phosphor" });
    const r = captureBoth([
      "create", "--intake", "--title", "cachetoken oracleblade etagfrost walkspine",
    ]);
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain("possible dependencies");
    expect(r.stderr).not.toContain("NOT CHECKED");
  });

  it("both lanes run the check — --intake prints too", () => {
    gh.issues.set(1, { number: 1, state: "Backlog", title: "cachetoken oracleblade etagfrost walkspine sibling" });
    const r = captureBoth([
      "create", "--intake", "--title", "cachetoken oracleblade etagfrost walkspine follow-up",
    ]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("possible dependencies");
  });

  it("scores the BODY, not just the title (the selector's own contract)", () => {
    gh.issues.set(1, { number: 1, state: "Backlog", title: "unrelated words here", body: "cachetoken oracleblade etagfrost walkspine detail" });
    const r = captureBoth([
      "create", "--intake", "--title", "also unrelated title",
      "--body", "the cachetoken oracleblade etagfrost walkspine mechanism",
    ]);
    expect(r.stderr).toContain("possible dependencies");
    expect(r.stderr).toContain("#1");
  });

  it("the selector is CALLED, not reimplemented — the pool predicate's exclusions hold on the filing path", () => {
    // Massive overlap on every item; only the unclaimed Backlog one may print.
    gh.issues.set(1, { number: 1, state: "Backlog", title: "cachetoken oracleblade etagfrost walkspine open" });
    gh.issues.set(2, { number: 2, state: "Backlog", title: "cachetoken oracleblade etagfrost walkspine claimed", claim: encodeClaim("a@h", NOW) });
    gh.issues.set(3, { number: 3, state: "In Progress", title: "cachetoken oracleblade etagfrost walkspine running" });
    gh.issues.set(4, { number: 4, state: "Intake", title: "cachetoken oracleblade etagfrost walkspine unapproved" });
    const r = captureBoth([
      "create", "--backlog", "--priority", "P1", "--estimate", "S",
      "--title", "cachetoken oracleblade etagfrost walkspine twin",
    ]);
    expect(r.stderr).toContain("#1");
    expect(r.stderr).not.toContain("#2");
    expect(r.stderr).not.toContain("#3");
    expect(r.stderr).not.toContain("#4");
  });

  it("caps the print at DEP_FILING_PRINT_CAP and points at the full list", () => {
    // Each candidate shares FOUR terms unique to it and the target — df=2, so
    // every pair clears the bar on its own distinctive vocabulary. A single
    // shared phrase across all of them would be priced to nothing by df.
    const terms = (n: number) => `dep${n}a dep${n}b dep${n}c dep${n}d`;
    const all: string[] = [];
    for (let n = 1; n <= DEP_FILING_PRINT_CAP + 2; n++) {
      gh.issues.set(n, { number: n, state: "Backlog", title: `${terms(n)} variant` });
      all.push(terms(n));
    }
    const r = captureBoth([
      "create", "--intake", "--title", "umbrella filing", "--body", all.join(" "),
    ]);
    const rows = r.stderr.match(/^ {2}#\d+ /gm) ?? [];
    expect(rows.length).toBe(DEP_FILING_PRINT_CAP);
    expect(r.stderr).toContain("full list: board dep-candidates");
  });

  it("a failed candidates read prints NOT CHECKED and the filing still succeeds (the write outranks the advisory)", () => {
    gh.issues.set(1, { number: 1, state: "Backlog", title: "cachetoken oracleblade sibling" });
    const realExec = gh.exec.bind(gh);
    let created = false;
    const flaky: Ctx = {
      ...ctx,
      exec: (argv, stdin) => {
        if (stdin?.includes("createIssue")) created = true;
        // Break the open-issues walk only AFTER the create landed — the
        // transport failure this test injects is on the advisory's read.
        if (created && stdin?.includes("issues(states: OPEN"))
          return { code: 1, stdout: "", stderr: "boom" };
        return realExec(argv, stdin);
      },
    };
    const r = captureBoth(
      ["create", "--intake", "--title", "cachetoken oracleblade follow-up"],
      flaky,
    );
    expect(r.code).toBe(0); // filing succeeded
    expect(r.stdout).toContain("https://");
    expect(r.stderr).toContain("NOT CHECKED");
    expect(r.stderr).toContain("this is not an empty candidate list");
  });
});

describe("deps-unwired (GH-2136) — tend category + doctor advisory line", () => {
  const days = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
  const dismissalComment = (target: number, dismissed: number[]) =>
    `**Dependency judged: no edge**\n\n${TEND_DEP_JUDGED_MARKER}\n\`\`\`json\n` +
    JSON.stringify({ target, dismissed, at: days(0) }) +
    "\n```";

  describe("overlap coefficient (pure)", () => {
    it("a document contained in a larger one scores overlap 1.0; disjoint docs never qualify", () => {
      const target = { number: 1, title: "alpha beta gamma", body: "" };
      const pool = [
        { number: 2, title: "alpha beta gamma delta epsilon", body: "" },
        { number: 3, title: "zeta eta theta", body: "" },
      ];
      const { candidates } = scoreDepCandidates(target, pool, 10);
      expect(candidates.map((c) => c.number)).toEqual([2]);
      expect(candidates[0].overlap).toBeCloseTo(1.0, 10);
    });

    it("partial overlap lands strictly between 0 and 1", () => {
      const target = { number: 1, title: "alpha beta gamma delta", body: "" };
      const pool = [{ number: 2, title: "alpha beta zeta eta", body: "" }];
      const { candidates } = scoreDepCandidates(target, pool, 10);
      expect(candidates[0].overlap).toBeGreaterThan(0);
      expect(candidates[0].overlap).toBeLessThan(1);
    });
  });

  describe("parseDepOverlapMin", () => {
    it("defaults to 0.2 and refuses out-of-range values with a warning", () => {
      const err: string[] = [];
      const spy = vi.spyOn(process.stderr, "write").mockImplementation((s) => {
        err.push(String(s));
        return true;
      });
      try {
        expect(parseDepOverlapMin(undefined)).toBe(DEP_OVERLAP_MIN_DEFAULT);
        expect(parseDepOverlapMin("0.35")).toBe(0.35);
        expect(parseDepOverlapMin("1")).toBe(1);
        expect(err).toEqual([]); // valid values never warn
        expect(parseDepOverlapMin("0")).toBe(DEP_OVERLAP_MIN_DEFAULT); // 0 = whole backlog
        expect(parseDepOverlapMin("1.5")).toBe(DEP_OVERLAP_MIN_DEFAULT);
        expect(parseDepOverlapMin("banana")).toBe(DEP_OVERLAP_MIN_DEFAULT);
        expect(err.length).toBe(3);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("dismissedDepPairs (marker reader)", () => {
    it("reads the payload's own target, symmetric and cumulative across comments", () => {
      const pairs = dismissedDepPairs([dismissalComment(5, [3]), dismissalComment(2, [7, 9])]);
      expect(pairs.has(depPairKey(3, 5))).toBe(true); // canonical, either order
      expect(pairs.has(depPairKey(5, 3))).toBe(true);
      expect(pairs.has(depPairKey(2, 7))).toBe(true);
      expect(pairs.has(depPairKey(2, 9))).toBe(true);
      expect(pairs.size).toBe(3); // cumulative — a later marker never un-judges an earlier pair
    });

    it("a marker quoted inside a code fence is prose, not a judgment (GH-1826)", () => {
      const quoted = "docs say:\n```\n" + TEND_DEP_JUDGED_MARKER + '\n{"target":1,"dismissed":[2]}\n```';
      expect(dismissedDepPairs([quoted]).size).toBe(0);
    });

    it("a payload with no target contributes nothing", () => {
      expect(dismissedDepPairs([`${TEND_DEP_JUDGED_MARKER}\n\`\`\`json\n{"dismissed":[2]}\n\`\`\``]).size).toBe(0);
    });
  });

  describe("depsUnwiredMap (pure)", () => {
    const poolItem = (
      n: number,
      over: Partial<{
        openBlockers: number[];
        closedBlockers: number[];
        blockersTruncated: boolean;
        parentNumber: number | null;
      }> = {},
    ) => ({
      number: n,
      title: `t${n}`,
      openBlockers: [],
      closedBlockers: [],
      blockersTruncated: false,
      parentNumber: null,
      ...over,
    });
    const twin = (n: number) => [n, { title: "widget frobnicator cache oracle", body: "" }] as const;

    it("both endpoints of an unjudged high-overlap pair surface, candidates attached", () => {
      const map = depsUnwiredMap(
        [poolItem(1), poolItem(2)],
        new Map([twin(1), twin(2)]),
        new Set(),
        0.2,
        10,
      );
      expect([...map.keys()].sort()).toEqual([1, 2]);
      expect(map.get(1)![0].number).toBe(2);
      expect(map.get(1)![0].overlap).toBeCloseTo(1, 10);
    });

    it("wired pairs (either direction), parent/child, and dismissed pairs are excluded", () => {
      const bodies = new Map([twin(1), twin(2), twin(3), twin(4)]);
      expect(
        depsUnwiredMap([poolItem(1, { openBlockers: [2] }), poolItem(2)], bodies, new Set(), 0.2, 10).size,
      ).toBe(0);
      expect(
        depsUnwiredMap([poolItem(1, { closedBlockers: [2] }), poolItem(2)], bodies, new Set(), 0.2, 10).size,
      ).toBe(0);
      expect(
        depsUnwiredMap([poolItem(1, { parentNumber: 2 }), poolItem(2)], bodies, new Set(), 0.2, 10).size,
      ).toBe(0);
      expect(
        depsUnwiredMap(
          [poolItem(1), poolItem(2)],
          bodies,
          new Set([depPairKey(2, 1)]),
          0.2,
          10,
        ).size,
      ).toBe(0);
    });

    it("a truncated blocker list removes the item from BOTH roles — unwired cannot be asserted over unseen edges", () => {
      const map = depsUnwiredMap(
        [poolItem(1, { blockersTruncated: true }), poolItem(2)],
        new Map([twin(1), twin(2)]),
        new Set(),
        0.2,
        10,
      );
      expect(map.size).toBe(0);
    });

    it("below-threshold overlap never qualifies; an unfetched body scores nothing", () => {
      const bodies = new Map([
        [1, { title: "alpha beta gamma delta epsilon zeta", body: "" }],
        [2, { title: "alpha omega psi chi phi upsilon", body: "" }],
      ] as const);
      expect(depsUnwiredMap([poolItem(1), poolItem(2)], new Map(bodies), new Set(), 0.5, 10).size).toBe(0);
      expect(
        depsUnwiredMap([poolItem(1), poolItem(2)], new Map([[1, bodies.get(1)!]]), new Set(), 0.1, 10).size,
      ).toBe(0);
    });

    it("the cap applies to what survives the threshold and exclusions", () => {
      const bodies = new Map([twin(1), twin(2), twin(3), twin(4)]);
      const map = depsUnwiredMap([poolItem(1), poolItem(2), poolItem(3), poolItem(4)], bodies, new Set(), 0.2, 2);
      expect(map.get(1)!.length).toBe(2);
    });
  });

  describe("classifyTend integration", () => {
    const days2 = days;
    const item = (n: number, over: Partial<QueueItem> = {}): QueueItem => ({
      number: n,
      repo: "cdubiel08/ralph-hero",
      title: `t${n}`,
      state: "Backlog",
      priority: "P2",
      hasParent: false,
      parentNumber: null,
      openBlockers: [],
      openBlockerLabels: [],
      blockersTruncated: false,
      fieldValuesTruncated: false,
      claim: null,
      claimRaw: null,
      labels: [],
      labelsTruncated: false,
      closedBlockers: [],
      updatedAt: days2(1),
      createdAt: days2(2),
      estimate: "S",
      ...over,
    });
    const cand = (n: number) => ({ number: n, title: `t${n}`, score: 5, overlap: 0.9, terms: ["shared"] });

    it("deps-unwired rows carry their candidates inline — no second read for the judge", () => {
      const res = classifyTend(
        [item(1), item(2)],
        [],
        TEND_DEFAULTS,
        NOW,
        new Map(),
        new Map([
          [1, [cand(2)]],
          [2, [cand(1)]],
        ]),
      );
      expect(res.queue.map((r) => [r.number, r.category])).toEqual([
        [1, "deps-unwired"],
        [2, "deps-unwired"],
      ]);
      expect(res.queue[0].candidates).toEqual([cand(2)]);
    });

    it("earlier categories win via the seen set; deps-unwired outranks unformed", () => {
      const res = classifyTend(
        [
          item(1, { closedBlockers: [9] }), // deps-cleared AND unwired-candidate → deps-cleared wins
          item(2, { estimate: null, createdAt: days2(9) }), // unformed AND unwired-candidate → deps-unwired wins
        ],
        [],
        TEND_DEFAULTS,
        NOW,
        new Map(),
        new Map([
          [1, [cand(2)]],
          [2, [cand(1)]],
        ]),
      );
      expect(res.queue.map((r) => [r.number, r.category])).toEqual([
        [1, "deps-cleared"],
        [2, "deps-unwired"],
      ]);
      expect(res.queue[0].candidates).toBeUndefined();
    });
  });

  describe("through the CLI", () => {
    let gh: FakeGh;
    let ctx: Ctx;
    beforeEach(() => {
      gh = new FakeGh();
      ctx = makeCtx(gh);
    });
    const fresh = { updatedAt: days(1), createdAt: days(2), estimate: "S", priority: "P2" };
    const twinIssue = (n: number, over: Record<string, unknown> = {}) => {
      gh.issues.set(n, { number: n, state: "Backlog", title: "widget frobnicator cache oracle", ...fresh, ...over });
    };

    it("tend-queue surfaces both endpoints as deps-unwired with candidates inline", () => {
      twinIssue(1);
      twinIssue(2);
      const res = tendQueue(ctx, TEND_DEFAULTS);
      expect(res.queue.map((r) => [r.number, r.category])).toEqual([
        [1, "deps-unwired"],
        [2, "deps-unwired"],
      ]);
      expect(res.queue[0].candidates![0].number).toBe(2);
      expect(res.queue[0].candidates![0].overlap).toBeGreaterThanOrEqual(0.2);
      expect(res.queue[0].candidates![0].terms.length).toBeGreaterThan(0);
    });

    it("a claimed item is out of the pool; a wired pair never surfaces", () => {
      twinIssue(1);
      twinIssue(2, { claim: encodeClaim("a@h", NOW) });
      expect(tendQueue(ctx, TEND_DEFAULTS).queue).toEqual([]);
      gh.issues.get(2)!.claim = undefined;
      gh.issues.set(2, { number: 2, state: "Backlog", title: "widget frobnicator cache oracle", ...fresh, blockedBy: [{ number: 1, state: "OPEN" }] });
      expect(tendQueue(ctx, TEND_DEFAULTS).queue).toEqual([]);
    });

    it("board dep --dismiss writes the marker the classifier reads — one judgment clears BOTH rows", () => {
      twinIssue(1);
      twinIssue(2);
      run(["dep", "1", "--on", "2", "--dismiss", "-m", "shared vocabulary, no build-order edge"], ctx);
      expect(gh.mutations).toContain("addComment");
      const body = gh.comments[0].body;
      expect(body).toContain(TEND_DEP_JUDGED_MARKER);
      expect(body).toContain('"target":1');
      expect(body).toContain("shared vocabulary, no build-order edge");
      // Round-trip: the written comment IS the trail the selector reads.
      gh.issues.get(1)!.comments = [body];
      expect(tendQueue(ctx, TEND_DEFAULTS).queue).toEqual([]);
    });

    it("--dismiss refuses --rm and self-dismissal", () => {
      expect(() => run(["dep", "1", "--on", "2", "--dismiss", "--rm"], ctx)).toThrow(/mutually exclusive/);
      expect(() => run(["dep", "1", "--on", "1", "--dismiss"], ctx)).toThrow(/itself/);
      expect(gh.mutations).toEqual([]);
    });

    it("doctor carries the advisory i line, names tend, and --strict never escalates it", () => {
      twinIssue(1);
      twinIssue(2);
      const baseline = doctor(makeCtx(new FakeGh()), { fix: false, strict: true }).ok;
      const r = doctor(ctx, { fix: false, strict: true });
      const c = r.checks.find((x) => x.name === "deps-unwired")!;
      expect(c.level).toBe("info");
      expect(c.detail).toContain("tend");
      expect(c.detail).toContain("#1 #2");
      expect(r.ok).toBe(baseline); // info never moves the exit code, strict included
    });

    it("doctor reads ok when the pair is judged, and degrades to not evaluated on a failed read", () => {
      twinIssue(1, { comments: [dismissalComment(1, [2])] });
      twinIssue(2);
      const clean = doctor(ctx, { fix: false, strict: false });
      expect(clean.checks.find((x) => x.name === "deps-unwired")!.level).toBe("ok");

      const inner = gh.exec;
      gh.exec = (argv: string[], stdin?: string) =>
        stdin?.includes("db0: issue(number")
          ? { code: 1, stdout: "", stderr: "simulated bodies failure" }
          : inner(argv, stdin);
      const baseline = doctor(makeCtx(new FakeGh()), { fix: false, strict: true }).ok;
      const r = doctor(ctx, { fix: false, strict: true });
      const c = r.checks.find((x) => x.name === "deps-unwired")!;
      expect(c.level).toBe("info");
      expect(c.detail).toContain("not evaluated");
      expect(r.ok).toBe(baseline); // a failed advisory read never changes the exit code
    });
  });
});
