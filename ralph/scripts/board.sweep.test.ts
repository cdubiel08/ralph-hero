/**
 * board.sweep.test.ts — `sweep-non-issues` (GH-2050).
 *
 * The one-time removal of the PULL_REQUEST/DRAFT_ISSUE items the project's
 * built-in "Auto-add to project" workflow deposited before its filter was
 * narrowed to `is:issue`. These items are invisible to every other board
 * surface — the item walk's content union has only an `... on Issue` fragment
 * — so this suite is the only place their handling is pinned.
 *
 * The gh harness here is deliberately hand-rolled rather than an extension of
 * FakeGh: this walk selects a shape no other reader asks for (`type`,
 * `creator`, a PR fragment), and teaching the shared fake about it would let a
 * bug in the shape pass by agreeing with itself.
 */

import { describe, expect, it } from "vitest";
import {
  classifyNonIssueSweep,
  type Ctx,
  type ExecResult,
  type NonIssueWalk,
  RefusalError,
  removeProjectItems,
  run,
  UsageError,
  walkNonIssueItems,
} from "./board.js";
import { FakeGh, makeCtx } from "./board.testkit.js";

interface FakeNode {
  id: string;
  type?: string | null;
  isArchived?: boolean;
  createdAt?: string | null;
  creator?: string | null;
  prNumber?: number;
  draftTitle?: string;
}

/** Wraps a FakeGh so the project-id round trip stays real while the items
 *  walk and the removal mutation are served from the fixture. */
function sweepCtx(
  nodes: FakeNode[],
  opts: {
    totalCount?: number;
    pageSize?: number;
    failItemIds?: Set<string>;
    capture?: string[]; // every walk document sent, verbatim — for the cost test
  } = {},
): { ctx: Ctx; gh: FakeGh; removed: string[]; pages: () => number } {
  const gh = new FakeGh();
  const base = gh.exec;
  const removed: string[] = [];
  const pageSize = opts.pageSize ?? 100;
  let pages = 0;
  gh.exec = (argv: string[], stdin?: string): ExecResult => {
    const body = stdin ? JSON.parse(stdin) : null;
    const q: string = body?.query ?? "";
    if (q.includes("deleteProjectV2Item")) {
      const id = body.variables.itemId as string;
      if (opts.failItemIds?.has(id)) {
        return { code: 0, stdout: JSON.stringify({ errors: [{ message: "nope" }] }), stderr: "" };
      }
      removed.push(id);
      return { code: 0, stdout: JSON.stringify({ data: { deleteProjectV2Item: { deletedItemId: id } } }), stderr: "" };
    }
    // The sweep's own walk is the only reader that selects `type` at the item
    // level — that is what distinguishes it from listItemsFull's query.
    if (q.includes("items(first:") && q.includes("creator { login }")) {
      pages++;
      opts.capture?.push(q);
      const after = body.variables.after as string | null;
      const start = after ? Number(after) : 0;
      const slice = nodes.slice(start, start + pageSize);
      const end = start + slice.length;
      return {
        code: 0,
        stdout: JSON.stringify({
          data: {
            node: {
              items: {
                totalCount: opts.totalCount ?? nodes.length,
                pageInfo: { hasNextPage: end < nodes.length, endCursor: String(end) },
                nodes: slice.map((n) => ({
                  id: n.id,
                  type: n.type === undefined ? "ISSUE" : n.type,
                  isArchived: !!n.isArchived,
                  createdAt: n.createdAt ?? null,
                  creator: n.creator === null ? null : { login: n.creator ?? "someone" },
                  content:
                    n.prNumber !== undefined
                      ? { number: n.prNumber }
                      : n.draftTitle !== undefined
                        ? { title: n.draftTitle }
                        : {},
                })),
              },
            },
          },
        }),
        stderr: "",
      };
    }
    return base(argv, stdin);
  };
  return { ctx: makeCtx(gh), gh, removed, pages: () => pages };
}

const pr = (id: string, number: number, extra: Partial<FakeNode> = {}): FakeNode => ({
  id,
  type: "PULL_REQUEST",
  prNumber: number,
  createdAt: "2026-08-16T01:00:00Z",
  creator: "github-project-automation",
  ...extra,
});

function capture(fn: () => number): { code: number; out: string } {
  const chunks: string[] = [];
  const orig = process.stdout.write;
  (process.stdout as any).write = (s: string) => {
    chunks.push(s);
    return true;
  };
  try {
    return { code: fn(), out: chunks.join("") };
  } finally {
    (process.stdout as any).write = orig;
  }
}

describe("walkNonIssueItems — the walk listItemsFull cannot do", () => {
  it("separates issues from PRs and drafts, and never returns an issue as a candidate", () => {
    const { ctx } = sweepCtx([
      { id: "i1" },
      pr("p1", 2049),
      { id: "d1", type: "DRAFT_ISSUE", draftTitle: "a draft" },
      { id: "i2" },
    ]);
    const walk = walkNonIssueItems(ctx);
    expect(walk.issues).toBe(2);
    expect(walk.scanned).toBe(4);
    expect(walk.nonIssue.map((n) => n.itemId)).toEqual(["p1", "d1"]);
    expect(walk.short).toBe(false);
    const report = classifyNonIssueSweep(walk);
    expect(report.candidates.map((c) => c.itemId)).toEqual(["p1", "d1"]);
    // The labels are what a failure line prints — an opaque node id there is
    // a failure nobody can act on.
    expect(report.candidates.map((c) => c.label)).toEqual(["PR #2049", 'draft "a draft"']);
  });

  it("pages the whole project", () => {
    const nodes = Array.from({ length: 250 }, (_, i) => pr(`p${i}`, 1000 + i));
    const { ctx, pages } = sweepCtx(nodes, { pageSize: 100 });
    const walk = walkNonIssueItems(ctx);
    expect(walk.scanned).toBe(250);
    expect(walk.nonIssue).toHaveLength(250);
    expect(pages()).toBe(3);
  });

  it("reports a SHORT walk rather than letting an incomplete sweep read as a finished one", () => {
    // GH-1896's question, asked of this walk: the cursor is not stable across
    // a board being mutated underneath it, so paging fewer nodes than the
    // project claims must be visible.
    const { ctx } = sweepCtx([pr("p1", 1), pr("p2", 2)], { totalCount: 900 });
    expect(walkNonIssueItems(ctx).short).toBe(true);
  });

  it("costs one connection page per 100 items — no nested connection rides along", () => {
    const docs: string[] = [];
    const { ctx } = sweepCtx([pr("p1", 1)], { capture: docs });
    walkNonIssueItems(ctx);
    expect(docs).toHaveLength(1);
    // `items` is the only connection in the document. A nested `first:` here
    // would multiply nodeCount and cost real points (GH-1811) — the mistake
    // GH-1807 made believing it had added 1 point.
    expect(docs[0].match(/first:/g) ?? []).toHaveLength(1);
  });
});

describe("classifyNonIssueSweep — fails closed", () => {
  const walkOf = (nonIssue: any[]): NonIssueWalk => ({
    nonIssue,
    issues: 0,
    scanned: nonIssue.length,
    pages: 1,
    short: false,
  });

  it("RETAINS an item whose kind did not come back — a guess here is the only way an issue could be removed", () => {
    const { ctx } = sweepCtx([{ id: "x1", type: null }]);
    const report = classifyNonIssueSweep(walkNonIssueItems(ctx));
    expect(report.candidates).toHaveLength(0);
    expect(report.retained).toEqual([{ label: "unknown item x1", reason: "unknown-kind" }]);
  });

  it("retains an archived item — archived items reject writes", () => {
    const { ctx } = sweepCtx([pr("p1", 1, { isArchived: true }), pr("p2", 2)]);
    const report = classifyNonIssueSweep(walkNonIssueItems(ctx));
    expect(report.candidates.map((c) => c.itemId)).toEqual(["p2"]);
    expect(report.retained).toEqual([{ label: "PR #1", reason: "archived" }]);
  });

  it("names the NEWEST non-issue item — the only observable of whether the auto-add source is live", () => {
    const report = classifyNonIssueSweep(
      walkOf([
        { itemId: "a", kind: "PULL_REQUEST", isArchived: false, createdAt: "2026-08-01T00:00:00Z", creator: "bot", label: "PR #1" },
        { itemId: "b", kind: "PULL_REQUEST", isArchived: false, createdAt: "2026-08-16T05:47:00Z", creator: "github-project-automation", label: "PR #2049" },
        { itemId: "c", kind: "PULL_REQUEST", isArchived: false, createdAt: "2026-08-10T00:00:00Z", creator: "bot", label: "PR #3" },
      ]),
    );
    expect(report.newest?.label).toBe("PR #2049");
    expect(report.newest?.creator).toBe("github-project-automation");
  });

  it("a set with no timestamps leaves newest null — never a fabricated 'source is closed'", () => {
    const report = classifyNonIssueSweep(
      walkOf([{ itemId: "a", kind: "PULL_REQUEST", isArchived: false, createdAt: null, creator: null, label: "PR #1" }]),
    );
    expect(report.newest).toBeNull();
  });
});

describe("removeProjectItems — the loop prune and the sweep share", () => {
  it("removes every candidate and reports the tally", () => {
    const { ctx, removed } = sweepCtx([]);
    const r = removeProjectItems(ctx, [
      { itemId: "a", label: "PR #1" },
      { itemId: "b", label: "PR #2" },
    ]);
    expect(r).toMatchObject({ attempted: 2, removed: 2, failed: [], aborted: false });
    expect(removed).toEqual(["a", "b"]);
  });

  it("isolates a per-item fault and keeps going — the label, not the node id, reaches the operator", () => {
    const { ctx, removed } = sweepCtx([], { failItemIds: new Set(["b"]) });
    const r = removeProjectItems(ctx, [
      { itemId: "a", label: "PR #1" },
      { itemId: "b", label: "PR #2" },
      { itemId: "c", label: "PR #3" },
    ]);
    expect(r.removed).toBe(2);
    expect(r.aborted).toBe(false);
    expect(r.failed[0]).toContain("PR #2");
    expect(removed).toEqual(["a", "c"]);
  });

  it("ABORTS after 5 consecutive failures rather than spending mutations against a wall", () => {
    const ids = Array.from({ length: 20 }, (_, i) => `x${i}`);
    const { ctx } = sweepCtx([], { failItemIds: new Set(ids) });
    const r = removeProjectItems(ctx, ids.map((id) => ({ itemId: id, label: id })));
    expect(r.aborted).toBe(true);
    expect(r.attempted).toBe(5);
  });
});

describe("board sweep-non-issues — the CLI", () => {
  it("is a DRY RUN by default: it names what it would remove and mutates nothing", () => {
    const { ctx, removed } = sweepCtx([{ id: "i1" }, pr("p1", 2049)]);
    const { code, out } = capture(() => run(["sweep-non-issues"], ctx));
    expect(code).toBe(0);
    expect(removed).toEqual([]);
    expect(out).toContain("DRY RUN");
    expect(out).toContain("PULL_REQUEST 1");
    // The verification gate is printed, not asserted by the tool.
    expect(out).toContain("newest non-issue item: PR #2049");
    expect(out).toContain("github-project-automation");
  });

  it("--apply removes them, and says the pull requests are untouched", () => {
    const { ctx, removed } = sweepCtx([{ id: "i1" }, pr("p1", 1), pr("p2", 2)]);
    const { code, out } = capture(() => run(["sweep-non-issues", "--apply"], ctx));
    expect(code).toBe(0);
    expect(removed).toEqual(["p1", "p2"]);
    expect(out).toContain("removed 2 of 2");
    expect(out).toContain("the PRs are untouched");
  });

  it("--limit bounds one sweep and says how many are left", () => {
    const nodes = Array.from({ length: 5 }, (_, i) => pr(`p${i}`, i));
    const { ctx, removed } = sweepCtx(nodes);
    const { out } = capture(() => run(["sweep-non-issues", "--apply", "--limit", "2"], ctx));
    expect(removed).toHaveLength(2);
    expect(out).toContain("3 candidate(s) left");
  });

  it("--json under --apply reports the run it PERFORMED, never a dry run", () => {
    const { ctx, removed } = sweepCtx([pr("p1", 1)]);
    const { out } = capture(() => run(["sweep-non-issues", "--apply", "--json"], ctx));
    const j = JSON.parse(out);
    expect(j.applied).toBe(true);
    expect(j.removed).toBe(1);
    expect(removed).toEqual(["p1"]);
  });

  it("an empty board says so and exits 0", () => {
    const { ctx } = sweepCtx([{ id: "i1" }, { id: "i2" }]);
    const { code, out } = capture(() => run(["sweep-non-issues"], ctx));
    expect(code).toBe(0);
    expect(out).toContain("nothing to sweep");
  });

  it("surfaces a short walk so 'none left' is never concluded from an incomplete read", () => {
    const { ctx } = sweepCtx([pr("p1", 1)], { totalCount: 900 });
    const { out } = capture(() => run(["sweep-non-issues"], ctx));
    expect(out).toContain("INCOMPLETE");
  });

  it("--apply is behind the scope gate; the dry run is a read and works anywhere", () => {
    // The gate is what keeps a sweep in one clone from emptying another
    // repo's board. `--apply` opts this verb into `writes`; without that line
    // in the predicate a destructive command would run ungated.
    const { ctx, removed } = sweepCtx([pr("p1", 1)]);
    const inner = ctx.exec;
    ctx.exec = (argv, stdin) =>
      argv.join(" ").includes("remote get-url")
        ? { code: 0, stdout: "git@github.com:someone-else/other.git\n", stderr: "" }
        : inner(argv, stdin);
    expect(() => run(["sweep-non-issues", "--apply"], ctx)).toThrow(RefusalError);
    expect(removed).toEqual([]);
    expect(capture(() => run(["sweep-non-issues"], ctx)).code).toBe(0);
  });

  it("refuses a bare --limit rather than silently widening the blast radius", () => {
    const { ctx } = sweepCtx([pr("p1", 1)]);
    expect(() => run(["sweep-non-issues", "--apply", "--limit"], ctx)).toThrow(UsageError);
  });

  it("exits 1 when an item could not be removed", () => {
    const { ctx } = sweepCtx([pr("p1", 1)], { failItemIds: new Set(["p1"]) });
    const { code, out } = capture(() => run(["sweep-non-issues", "--apply"], ctx));
    expect(code).toBe(1);
    expect(out).toContain("failed: PR #1");
  });
});
