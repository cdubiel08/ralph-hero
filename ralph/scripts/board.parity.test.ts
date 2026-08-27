/**
 * board.parity.test.ts — the lifecycle-parity rule (GH-2129).
 *
 * THE RULE: every Project field the CLI reads or gates on must have a
 * sanctioned CLI write surface, or an exemption whose reason is stated.
 *
 * The defect class it closes is named in `FIELD_PARITY`'s own header in
 * board.ts: a read acquires enforcement weight while the corrective verb is
 * forgotten, because reads and writes are added by different units. This file
 * is the mechanism — the same move `cmdscan.test.sh` made for the funnels,
 * because a convention that says "add the verb too" is exactly what the two
 * 2026-08-23 instances (GH-2126, GH-2127) each had and each lost.
 *
 * Three interlocking closed sets, so no piece can be added without the others:
 *
 *   1. ENUMERATION — derived from board.ts's `*_FIELD` constants. A new field
 *      is opted in by EXISTING; the table has to answer for it or the suite
 *      names it. This is the half that must not be hand-kept.
 *   2. DISPATCH — every verb the table names is a real `case` in `run()`, and
 *      a `value` verb additionally addresses an EXISTING issue. That second
 *      predicate is the whole GH-2126 discriminator: `create` writes Estimate
 *      too, and writing a field at birth is not a corrective verb.
 *   3. DRIVE — each named verb is RUN against a fake board and observed to
 *      write that field. A table entry pointing at a verb that exists but
 *      writes something else is the failure a paper registry cannot see.
 *
 * HONEST LIMITS, stated rather than discovered later:
 *   - The check is only as good as its enumeration. A gate reading a field
 *     through a bare string literal instead of a `*_FIELD` constant is
 *     invisible here; the remedy is to add the constant, which is also the
 *     house style.
 *   - Parity is not symmetry. Some reads legitimately have no writer, which
 *     is what the exemption reasons are for — a bare name list would rot into
 *     a suppression file.
 *   - DRIVE proves a verb writes a field, never that its semantics are right.
 *     That is what the rest of the suite is for.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { FIELD_PARITY, run, type Ctx, type ParitySurface } from "./board.js";
import { FakeGh, makeCtx } from "./board.testkit.js";

const SRC = readFileSync(new URL("./board.ts", import.meta.url), "utf8");

// --- 1. enumeration ---------------------------------------------------------

/** The fields the CLI knows about, read off the constants themselves. */
function declaredFields(src: string): string[] {
  return [...src.matchAll(/^(?:export )?const [A-Z][A-Z0-9_]*_FIELD = "([^"]+)";$/gm)].map((m) => m[1]);
}

// --- 2. dispatch ------------------------------------------------------------

/** `run()`'s verbs, with each one's body. Consecutive `case` labels sharing
 *  one block (`case "priority": case "estimate": {`) are one group: a
 *  fallthrough label's own slice is a few bytes of nothing, and scoring it
 *  alone would report `priority` as taking no issue number. */
function dispatchVerbs(src: string): Map<string, string> {
  const marks = [...src.matchAll(/^ {4}case "([a-z-]+)":/gm)].map((m) => ({ verb: m[1], at: m.index! }));
  const verbs = new Map<string, string>();
  for (let i = 0; i < marks.length; i++) {
    let end = i + 1 < marks.length ? marks[i + 1].at : src.length;
    // Extend past every label that carries no block of its own.
    for (let j = i + 1; j < marks.length && !src.slice(marks[i].at, end).includes("{"); j++) {
      end = j + 1 < marks.length ? marks[j + 1].at : src.length;
    }
    verbs.set(marks[i].verb, src.slice(marks[i].at, end));
  }
  return verbs;
}

/** The corrective-verb test: does this verb act on an issue that already
 *  exists? `create` is the one that does not, which is the entire reason
 *  GH-2126 could ship a gate on Estimate with no way to set it. */
function addressesExistingIssue(body: string): boolean {
  return body.includes("requireNumber(positional[0])");
}

/** The rule's dispatch arm, as a function of the source, so the failing-first
 *  case below can run THE RULE against a doctored tree rather than a
 *  lookalike. Each violation names the field and the verb that isn't there. */
function phantomVerbs(src: string): string[] {
  const verbs = dispatchVerbs(src);
  return FIELD_PARITY.flatMap((row) =>
    [row.value, row.options]
      .map(surfaceVerb)
      .filter((v): v is string => v !== null && !verbs.has(v))
      .map((v) => `${row.field}: no such verb \`board ${v}\``),
  );
}

// --- 3. drive ---------------------------------------------------------------

/** How to make each verb write its field, against a seeded fake board. Not
 *  the enumeration — that is derived — but the recipes must COVER it: the
 *  suite refuses a table entry with no way to prove itself, so a new writer
 *  arrives with its proof or not at all. */
const DRIVE: Record<string, { argv: string[]; prepare?: (gh: FakeGh) => void }> = {
  move: { argv: ["move", "1", "in-review"], prepare: (gh) => gh.issues.set(1, { number: 1, state: "In Progress" }) },
  claim: { argv: ["claim", "1"] },
  defer: { argv: ["defer", "1", "--until", "the upstream fix lands"] },
  estimate: { argv: ["estimate", "1", "S"] },
  priority: { argv: ["priority", "1", "P1"] },
  // Board-scoped: `setup` writes the Workflow State OPTION SET, not an item's
  // value — so its fixture is a board whose state field is missing an option,
  // which is the deadlock GH-2127 closed.
  setup: {
    argv: ["setup"],
    prepare: (gh) => {
      gh.omitFields = ["Workflow State"];
      gh.createdFields.push({
        name: "Workflow State", dataType: "SINGLE_SELECT",
        options: ["Backlog", "In Progress", "In Review", "Human Needed", "Done", "Canceled"], // no Intake
      });
    },
  },
};

function driveAndCollect(verb: string): { writes: string[]; mutations: string[] } {
  const recipe = DRIVE[verb];
  // Named, not a TypeError: the missing-recipe arm below reports this too, and
  // one legible failure beating two is the whole point of the diagnostics.
  if (!recipe) throw new Error(`no drive recipe for \`board ${verb}\` — add one beside the table entry`);
  const gh = new FakeGh();
  const ctx: Ctx = makeCtx(gh);
  gh.issues.set(1, { number: 1, state: "Backlog" });
  recipe.prepare?.(gh);
  expect(run(recipe.argv, ctx)).toBe(0);
  return { writes: gh.fieldWrites, mutations: gh.mutations };
}

// --- the rule ---------------------------------------------------------------

const surfaceVerb = (s: ParitySurface): string | null => ("verb" in s ? s.verb : null);
const exemption = (s: ParitySurface): string | null => ("exempt" in s ? s.exempt : null);

describe("lifecycle parity: a gated field has a write surface (GH-2129)", () => {
  it("every field constant is answered for — a new field opts in by existing", () => {
    const declared = declaredFields(SRC).sort();
    expect(declared.length).toBeGreaterThan(0); // the regex still matches something
    const tabled = FIELD_PARITY.map((f) => f.field).sort();
    // Named both ways: an unanswered field and a table row for a field that no
    // longer exists are different mistakes with different remedies.
    expect(declared.filter((f) => !tabled.includes(f))).toEqual([]);
    expect(tabled.filter((f) => !declared.includes(f))).toEqual([]);
  });

  it("every exemption carries a reason, not a bare name", () => {
    for (const row of FIELD_PARITY) {
      for (const [axis, surface] of [["value", row.value], ["options", row.options]] as const) {
        const why = exemption(surface);
        if (why === null) continue;
        expect(why.trim().length, `${row.field}.${axis} exemption is empty`).toBeGreaterThan(20);
      }
    }
  });

  it("every named verb is a real verb in run()'s dispatch", () => {
    expect(phantomVerbs(SRC)).toEqual([]);
  });

  it("a VALUE writer addresses an existing issue — creation is not a corrective verb", () => {
    const verbs = dispatchVerbs(SRC);
    for (const row of FIELD_PARITY) {
      const verb = surfaceVerb(row.value);
      if (!verb) continue;
      expect(addressesExistingIssue(verbs.get(verb)!), `${row.field}: \`board ${verb}\` takes no issue number`).toBe(true);
    }
  });

  it("every named verb has a drive recipe — the table may not vouch for itself", () => {
    const named = FIELD_PARITY.flatMap((r) => [surfaceVerb(r.value), surfaceVerb(r.options)]).filter(
      (v): v is string => v !== null,
    );
    expect(named.filter((v) => !(v in DRIVE))).toEqual([]);
  });

  it.each(FIELD_PARITY.filter((r) => surfaceVerb(r.value)))(
    "$field: the named verb actually writes it",
    (row) => {
      const verb = surfaceVerb(row.value)!;
      expect(driveAndCollect(verb).writes).toContain(row.field);
    },
  );

  it("Workflow State's option set has a writer, and it writes options (GH-2127)", () => {
    // The option axis is board-scoped — no item to observe — so it is proved
    // on the option-set mutation instead of on a field write. The verb comes
    // from the table, so retargeting the row retargets the proof.
    const verb = surfaceVerb(FIELD_PARITY.find((r) => r.field === "Workflow State")!.options)!;
    const { mutations } = driveAndCollect(verb);
    expect(mutations.some((m) => m.startsWith("updateFieldOptions(") && m.includes("Intake"))).toBe(true);
  });
});

describe("the failing-first case: the rule bites on the tree that motivated it", () => {
  // GH-2126's acceptance is "run against the tree BEFORE GH-2126 lands, the
  // check names Estimate". That tree cannot be checked out from inside a test,
  // so the demonstration is on the two predicates a maintainer on that tree
  // would have had to satisfy — both of which refuse, mechanically.

  it("with no `estimate` verb, the rule names Estimate", () => {
    // The pre-GH-2126 tree, minus exactly what GH-2126 added.
    const preGH2126 = SRC.replace(/^ {4}case "estimate": \{/m, '    case "estimate-GH2126-NOT-YET-LANDED": {');
    expect(preGH2126).not.toBe(SRC);
    expect(phantomVerbs(SRC)).toEqual([]);
    expect(phantomVerbs(preGH2126)).toEqual(["Estimate: no such verb `board estimate`"]);
  });

  it("`create` is refused as a value writer — writing a field at birth is not parity", () => {
    // The only other row a pre-GH-2126 maintainer could have written. It fails
    // on the predicate, which is why the table cannot be satisfied by a lie.
    const verbs = dispatchVerbs(SRC);
    expect(verbs.has("create")).toBe(true);
    expect(addressesExistingIssue(verbs.get("create")!)).toBe(false);
    // …while every real value writer passes it.
    expect(addressesExistingIssue(verbs.get("estimate")!)).toBe(true);
  });

  it("the enumeration arm names an unanswered field by its own name", () => {
    const declared = declaredFields(SRC + '\nconst SEVERITY_FIELD = "Severity";\n');
    const tabled = FIELD_PARITY.map((f) => f.field);
    expect(declared.filter((f) => !tabled.includes(f))).toEqual(["Severity"]);
  });
});
