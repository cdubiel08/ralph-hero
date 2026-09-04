/**
 * board.amend.test.ts — `board amend NNN` (D6, GH-2449): a body edit as a
 * metadata verb. Three properties this file exists to defend:
 *
 *   1. --file/--append/--replace-section compose into exactly one of three
 *      edit modes (replace / append / replace-section), and a heading that
 *      is not found refuses rather than silently duplicating a header.
 *   2. Every amend posts a durable `ralph-amend:v1` marker comment recording
 *      {mode, section?, diffHash} — the shape `board get`'s trail depends on.
 *   3. --broadcast reuses `epicDescendantPredicate` (the ONE definition
 *      `frontier --epic` and doctor's `lead-respawns` already share) to
 *      comment once on every OPEN descendant, never the root itself.
 *
 * Refuses on a closed issue: a closed issue's body is the historical record
 * of what shipped, not something amend keeps current.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  AMEND_MARKER,
  amend,
  appendToBody,
  RefusalError,
  replaceMarkdownSection,
  run,
  UsageError,
  type Ctx,
} from "./board.js";
import { FakeGh, makeCtx, NOW } from "./board.testkit.js";

// --- replaceMarkdownSection / appendToBody (pure helpers) ------------------

describe("replaceMarkdownSection", () => {
  const body = [
    "# Title",
    "",
    "## Outcome",
    "old outcome text",
    "more of it",
    "",
    "## Verification",
    "old verification",
    "",
    "### Details",
    "nested, stays under Verification",
  ].join("\n");

  it("replaces a section's body, stopping at the next heading of the same or shallower level", () => {
    // The region between the heading and the next same-or-shallower heading is
    // replaced wholesale, blank-line separator included — the caller's own
    // replacement text controls spacing (e.g. a trailing blank line) if wanted.
    const after = replaceMarkdownSection(body, "## Outcome", "new outcome text");
    expect(after).toBe(
      ["# Title", "", "## Outcome", "new outcome text", "## Verification", "old verification", "", "### Details", "nested, stays under Verification"].join("\n"),
    );
  });

  it("a deeper nested heading does not end the section", () => {
    const after = replaceMarkdownSection(body, "## Verification", "new verification");
    expect(after).toBe(["# Title", "", "## Outcome", "old outcome text", "more of it", "", "## Verification", "new verification"].join("\n"));
  });

  it("a heading not present returns null — the refusal signal", () => {
    expect(replaceMarkdownSection(body, "## Nope", "x")).toBeNull();
  });

  it("a non-heading value is a usage error, not a silent no-match", () => {
    expect(() => replaceMarkdownSection(body, "Outcome", "x")).toThrow(UsageError);
  });

  it("a heading quoted inside a ``` fence is example text — neither a target nor a boundary (Codex P1, #2465)", () => {
    const fenced = [
      "## Usage",
      "run it like so:",
      "```",
      "## Outcome",
      "board create --backlog --body '## Outcome'",
      "```",
      "still Usage",
      "## Outcome",
      "the real outcome",
      "## After",
      "tail",
    ].join("\n");
    expect(replaceMarkdownSection(fenced, "## Outcome", "NEW")).toBe(
      ["## Usage", "run it like so:", "```", "## Outcome", "board create --backlog --body '## Outcome'", "```", "still Usage", "## Outcome", "NEW", "## After", "tail"].join("\n"),
    );
    // And a fenced heading inside the target section does not end it early.
    const inner = ["## Outcome", "text", "```", "## Not a boundary", "```", "more text", "## After", "tail"].join("\n");
    expect(replaceMarkdownSection(inner, "## Outcome", "NEW")).toBe(["## Outcome", "NEW", "## After", "tail"].join("\n"));
    // A heading that exists ONLY inside a fence is not found.
    expect(replaceMarkdownSection(["```", "## Only fenced", "```"].join("\n"), "## Only fenced", "x")).toBeNull();
  });

  it("matches on the trimmed line — trailing/leading whitespace in the heading arg is forgiving", () => {
    expect(replaceMarkdownSection(body, "  ## Outcome  ", "x")).not.toBeNull();
  });
});

describe("appendToBody", () => {
  it("joins with one blank line", () => {
    expect(appendToBody("existing text", "new text")).toBe("existing text\n\nnew text");
  });

  it("an empty body is not padded with a leading blank line", () => {
    expect(appendToBody("", "new text")).toBe("new text");
  });

  it("trims trailing whitespace off the existing body and surrounding whitespace off the addition", () => {
    expect(appendToBody("existing   \n\n", "  new text  \n")).toBe("existing\n\nnew text");
  });
});

// --- amend() -----------------------------------------------------------

describe("amend — body edit modes and the marker comment", () => {
  it("refuses on a closed issue", () => {
    const gh = new FakeGh();
    gh.issues.set(1, { number: 1, state: "Backlog", issueState: "CLOSED", body: "old" });
    const ctx = makeCtx(gh);
    expect(() => amend(ctx, 1, { content: "new" })).toThrow(RefusalError);
    expect(gh.mutations).toEqual([]);
    expect(gh.comments).toEqual([]);
  });

  it("bare --file replaces the whole body", () => {
    const gh = new FakeGh();
    gh.issues.set(1, { number: 1, state: "Backlog", body: "old body" });
    const ctx = makeCtx(gh);
    const res = amend(ctx, 1, { content: "new body" });
    expect(res.mode).toBe("replace");
    expect(res.section).toBeUndefined();
    expect(gh.issues.get(1)!.body).toBe("new body");
    expect(gh.mutations).toEqual(["updateIssue(#1)", "addComment"]);
  });

  it("--append adds to the end of the existing body", () => {
    const gh = new FakeGh();
    gh.issues.set(1, { number: 1, state: "Backlog", body: "old body" });
    const ctx = makeCtx(gh);
    const res = amend(ctx, 1, { content: "extra note", append: true });
    expect(res.mode).toBe("append");
    expect(gh.issues.get(1)!.body).toBe("old body\n\nextra note");
  });

  it("--replace-section replaces only that section", () => {
    const gh = new FakeGh();
    gh.issues.set(1, {
      number: 1, state: "Backlog",
      body: ["## Outcome", "old outcome", "", "## Verification", "old verification"].join("\n"),
    });
    const ctx = makeCtx(gh);
    const res = amend(ctx, 1, { content: "new outcome", section: "## Outcome" });
    expect(res.mode).toBe("replace-section");
    expect(res.section).toBe("## Outcome");
    expect(gh.issues.get(1)!.body).toBe(["## Outcome", "new outcome", "## Verification", "old verification"].join("\n"));
  });

  it("--replace-section refuses when the heading is not found — never a silent duplicate header", () => {
    const gh = new FakeGh();
    gh.issues.set(1, { number: 1, state: "Backlog", body: "## Outcome\nsome text" });
    const ctx = makeCtx(gh);
    expect(() => amend(ctx, 1, { content: "x", section: "## Nope" })).toThrow(RefusalError);
    expect(gh.mutations).toEqual([]);
  });

  it("--append and --replace-section together is a usage error", () => {
    const gh = new FakeGh();
    gh.issues.set(1, { number: 1, state: "Backlog", body: "## Outcome\nx" });
    const ctx = makeCtx(gh);
    expect(() => amend(ctx, 1, { content: "x", append: true, section: "## Outcome" })).toThrow(UsageError);
    expect(gh.mutations).toEqual([]);
  });

  it("posts a durable marker comment recording {mode, section?, diffHash} — the shape is pinned", () => {
    const gh = new FakeGh();
    gh.issues.set(1, {
      number: 1, state: "Backlog",
      body: ["## Outcome", "old"].join("\n"),
    });
    const ctx = makeCtx(gh);
    const res = amend(ctx, 1, { content: "new", section: "## Outcome" });
    expect(gh.comments).toHaveLength(1);
    const body = gh.comments[0].body;
    expect(body).toContain(AMEND_MARKER);
    expect(body).toContain("**Body amended**");
    const fenceMatch = body.match(/```json\n([\s\S]*?)\n```/);
    expect(fenceMatch).not.toBeNull();
    const payload = JSON.parse(fenceMatch![1]);
    expect(payload).toEqual({
      at: NOW.toISOString(),
      by: "me@test",
      mode: "replace-section",
      section: "## Outcome",
      diffHash: res.diffHash,
    });
    expect(res.diffHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("a whole-body replace's marker payload carries no `section` key", () => {
    const gh = new FakeGh();
    gh.issues.set(1, { number: 1, state: "Backlog", body: "old" });
    const ctx = makeCtx(gh);
    amend(ctx, 1, { content: "new" });
    const fenceMatch = gh.comments[0].body.match(/```json\n([\s\S]*?)\n```/);
    const payload = JSON.parse(fenceMatch![1]);
    expect(payload).not.toHaveProperty("section");
    expect(payload.mode).toBe("replace");
  });

  it("no body change still writes and comments (not a special-cased noop)", () => {
    const gh = new FakeGh();
    gh.issues.set(1, { number: 1, state: "Backlog", body: "same" });
    const ctx = makeCtx(gh);
    const res = amend(ctx, 1, { content: "same" });
    expect(res.mode).toBe("replace");
    expect(gh.mutations).toEqual(["updateIssue(#1)", "addComment"]);
  });
});

describe("amend --broadcast — every OPEN descendant, never the root", () => {
  it("comments once on every open descendant, grandchildren included, root excluded", () => {
    const gh = new FakeGh();
    gh.issues.set(1525, { number: 1525, state: "Backlog", priority: "P1", body: "root body" });
    gh.issues.set(1526, { number: 1526, state: "Backlog", priority: "P2", parent: 1525 });
    gh.issues.set(1527, { number: 1527, state: "Backlog", priority: "P2", parent: 1526 });
    gh.issues.set(7, { number: 7, state: "Backlog", priority: "P0" }); // unrelated — not under 1525
    const ctx = makeCtx(gh);
    const res = amend(ctx, 1525, { content: "new root body", broadcast: true });
    expect(res.broadcast).toEqual({ count: 2, numbers: [1526, 1527], failed: [] });
    // 1 marker on the root + 2 broadcast comments
    expect(gh.comments).toHaveLength(3);
    const broadcastBodies = gh.comments.slice(1).map((c) => c.body);
    for (const b of broadcastBodies) {
      expect(b).toBe(`root #1525 amended ${NOW.toISOString()}, re-read before continuing.`);
    }
  });

  it("zero descendants is a clean {count: 0, numbers: []}, no extra comments beyond the marker", () => {
    const gh = new FakeGh();
    gh.issues.set(1525, { number: 1525, state: "Backlog", priority: "P1", body: "root body" });
    const ctx = makeCtx(gh);
    const res = amend(ctx, 1525, { content: "new", broadcast: true });
    expect(res.broadcast).toEqual({ count: 0, numbers: [], failed: [] });
    expect(gh.comments).toHaveLength(1); // the marker only
  });

  it("a descendant that fails to resolve or post is REPORTED in `failed`, never thrown — the amend already landed (Codex P1, #2465)", () => {
    const gh = new FakeGh();
    gh.issues.set(1525, { number: 1525, state: "Backlog", priority: "P1", body: "root body" });
    gh.issues.set(1526, { number: 1526, state: "Backlog", priority: "P2", parent: 1525 });
    gh.issues.set(1527, { number: 1527, state: "Backlog", priority: "P2", parent: 1525 });
    const ctx = makeCtx(gh);
    // #1527 vanishes between the walk and the batched id lookup: the batch
    // throws NOT_FOUND, the per-item fallback resolves #1526 alone.
    const inner = gh.exec;
    gh.exec = (argv, stdin) => {
      const q = [...argv, stdin ?? ""].join(" ");
      if (q.includes("a0: issue(number") && q.includes("$n1")) {
        return { code: 1, stdout: JSON.stringify({ errors: [{ type: "NOT_FOUND", message: "Could not resolve to an Issue with the number of 1527." }] }), stderr: "" };
      }
      if (q.includes("a0: issue(number") && /"n0":1527/.test(q)) {
        return { code: 1, stdout: JSON.stringify({ errors: [{ type: "NOT_FOUND", message: "gone" }] }), stderr: "" };
      }
      return inner(argv, stdin);
    };
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let res;
    try {
      res = amend(ctx, 1525, { content: "new", broadcast: true });
    } finally {
      err.mockRestore();
    }
    expect(gh.issues.get(1525)!.body).toBe("new"); // the amend landed
    expect(res.broadcast).toEqual({ count: 1, numbers: [1526], failed: [1527] });
    expect(gh.comments).toHaveLength(2); // marker + the one that could be posted
  });

  it("no --broadcast flag never walks the board — broadcast is null, not an empty result", () => {
    const gh = new FakeGh();
    gh.issues.set(1525, { number: 1525, state: "Backlog", priority: "P1", body: "root body" });
    gh.issues.set(1526, { number: 1526, state: "Backlog", priority: "P2", parent: 1525 });
    const ctx = makeCtx(gh);
    const res = amend(ctx, 1525, { content: "new" });
    expect(res.broadcast).toBeNull();
    expect(gh.comments).toHaveLength(1); // the marker only — no broadcast comment on 1526
  });
});

// --- CLI wiring --------------------------------------------------------

const tmpDir = mkdtempSync(join(tmpdir(), "board-amend-"));
afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function fileWith(content: string): string {
  const p = join(tmpDir, `body-${Math.random().toString(36).slice(2)}.md`);
  writeFileSync(p, content);
  return p;
}

function capture(argv: string[], ctx: Ctx): { code: number; text: string } {
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
}

describe("board amend NNN — CLI wiring", () => {
  it("--file is required", () => {
    const gh = new FakeGh();
    gh.issues.set(1, { number: 1, state: "Backlog", body: "old" });
    expect(() => run(["amend", "1"], makeCtx(gh))).toThrow(UsageError);
  });

  it("an unreadable --file path is a usage error naming the path", () => {
    const gh = new FakeGh();
    gh.issues.set(1, { number: 1, state: "Backlog", body: "old" });
    expect(() => run(["amend", "1", "--file", join(tmpDir, "does-not-exist.md")], makeCtx(gh))).toThrow(
      UsageError,
    );
  });

  it("reads the file and reports the mode and diff hash", () => {
    const gh = new FakeGh();
    gh.issues.set(1, { number: 1, state: "Backlog", body: "old" });
    const path = fileWith("new body content");
    const { code, text } = capture(["amend", "1", "--file", path], makeCtx(gh));
    expect(code).toBe(0);
    expect(text).toContain("#1: body amended (replace)");
    expect(gh.issues.get(1)!.body).toBe("new body content");
  });

  it("--replace-section threads the heading through to the result and output", () => {
    const gh = new FakeGh();
    gh.issues.set(1, { number: 1, state: "Backlog", body: "## Outcome\nold" });
    const path = fileWith("new outcome");
    const { text } = capture(["amend", "1", "--file", path, "--replace-section", "## Outcome"], makeCtx(gh));
    expect(text).toContain('body amended (replace-section "## Outcome")');
  });

  it("--json reports the full AmendResult shape", () => {
    const gh = new FakeGh();
    gh.issues.set(1525, { number: 1525, state: "Backlog", priority: "P1", body: "old" });
    gh.issues.set(1526, { number: 1526, state: "Backlog", priority: "P2", parent: 1525 });
    const path = fileWith("new");
    const { code, text } = capture(["amend", "1525", "--file", path, "--broadcast", "--json"], makeCtx(gh));
    expect(code).toBe(0);
    const j = JSON.parse(text);
    expect(j).toMatchObject({
      number: 1525,
      mode: "replace",
      broadcast: { count: 1, numbers: [1526], failed: [] },
    });
    expect(j.diffHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("--broadcast reports the descendant count in prose output", () => {
    const gh = new FakeGh();
    gh.issues.set(1525, { number: 1525, state: "Backlog", priority: "P1", body: "old" });
    gh.issues.set(1526, { number: 1526, state: "Backlog", priority: "P2", parent: 1525 });
    const path = fileWith("new");
    const { text } = capture(["amend", "1525", "--file", path, "--broadcast"], makeCtx(gh));
    expect(text).toContain("broadcast: commented on 1 open descendant(s) (#1526)");
  });

  it("refuses on a closed issue at the CLI too", () => {
    const gh = new FakeGh();
    gh.issues.set(1, { number: 1, state: "Backlog", issueState: "CLOSED", body: "old" });
    const path = fileWith("new");
    expect(() => run(["amend", "1", "--file", path], makeCtx(gh))).toThrow(RefusalError);
  });
});
