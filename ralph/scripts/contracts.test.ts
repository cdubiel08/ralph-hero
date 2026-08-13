/**
 * contracts.test.ts — the wire's contract. Every locked decision in the
 * ralph-herdr v2 plan (thoughts/shared/plans/2026-08-10-ralph-herdr-v2-implementation.md)
 * has a test: naming grammar B, ClaimV2, the C1–C9 refinements, lints L1–L13,
 * and the example corpus under ralph/contracts/examples as executable
 * fixtures. Pure functions + JSON files; no network.
 */

import { describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeClaim } from "./board.js";
import {
  addHolder,
  BRANCH_KIND_CHARS,
  type BranchKind,
  branchIssue,
  branchKindFor,
  CLAIM_MAX_HOLDERS,
  type ClaimV2,
  collideName,
  CONTRACT_IDS,
  type ContractId,
  DEFAULT_BRANCH_KIND,
  emitJsonSchemas,
  formatBranchName,
  parseBranchName,
  worktreeLeaf,
  expectedSkillInvocation,
  formatAgentName,
  formatClaim,
  formatRef,
  GEN_RESERVE,
  heartbeat,
  isContractId,
  isMember,
  isValidHolder,
  type Lane,
  LANE_CHARS,
  LANES,
  LINT_IDS,
  LINTS,
  lintL1ReplyToShape,
  lintL2AgentNameIssue,
  lintL3CommitInRepo,
  lintL4OutcomeEvidence,
  lintL5ClaimReadback,
  lintL6ContractVersion,
  lintL7ParentOpen,
  lintL8BranchConvention,
  lintL9QueueRank,
  lintL10Live,
  lintL11EscalationResume,
  lintL12NoSecretLeak,
  lintL13Timestamps,
  LIVE_LINT_IDS,
  type BoardItemView,
  type LiveLintDeps,
  NAME_MAX,
  parseAgentName,
  parseClaim,
  parseRef,
  removeHolder,
  SLUG_RE,
  slugBudget,
  slugify,
  truncateSlug,
  runLints,
  validateContract,
} from "./contracts.js";

// ---------------------------------------------------------------------------
// Example corpus — the fixtures ARE the documentation
// ---------------------------------------------------------------------------

const EXAMPLES_DIR = fileURLToPath(new URL("../contracts/examples", import.meta.url));

function loadExample(kind: "good" | "bad", id: ContractId): unknown {
  return JSON.parse(readFileSync(join(EXAMPLES_DIR, kind, `${id}.json`), "utf8"));
}

type Parsed = ReturnType<typeof validateContract>;
const issuesOf = (res: Parsed): string =>
  res.success ? "" : res.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");

/** What each bad example's failure must SAY, tied to its .reason.txt — a bad
 *  fixture failing for some unrelated shape error would be a lying fixture. */
const REASON_PROBES: Record<ContractId, RegExp> = {
  // reason: depth 4 exceeds the herdr-plane cap of 3
  "ralph.spawn_request": /depth: .*less than or equal to 3/i,
  // reason: completed without pr AND without commit_sha
  "ralph.completion_report": /outcome=completed requires pr[\s\S]*outcome=completed requires commit_sha/,
  // reason: lane w must invoke exactly /ralph:work 1743
  "ralph.fleet_brief": /must invoke "\/ralph:work 1743"/,
  // reason: kind=question with no options is not phone-answerable
  "ralph.fleet_reply": /kind=question requires options/,
  // reason: issue 1601 appears twice in the queue
  "ralph.board_queue": /queue numbers must be unique/,
  // reason: pane_id "%17" used as the ref epoch — never a durable key
  "ralph.lineage": /agent_ref: not a durable ref/,
  // reason: state token "sleeping" is outside the lifecycle enum
  "ralph.token_vocabulary": /tokens\.state: invalid value for token state/,
  // reason: two recommended options — the phone default is ambiguous
  "ralph.escalation": /exactly one option must be recommended/,
};

describe("example corpus", () => {
  it("covers every contract id — a good file, a bad file, and a bad reason each", () => {
    const ids = (kind: string) =>
      readdirSync(join(EXAMPLES_DIR, kind))
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.replace(/\.json$/, ""))
        .sort();
    expect(ids("good")).toEqual([...CONTRACT_IDS].sort());
    expect(ids("bad")).toEqual([...CONTRACT_IDS].sort());
    for (const id of CONTRACT_IDS) {
      expect(isContractId(id)).toBe(true);
      const reason = readFileSync(join(EXAMPLES_DIR, "bad", `${id}.reason.txt`), "utf8");
      expect(reason.trim().length, `${id}.reason.txt is empty`).toBeGreaterThan(0);
    }
    expect(isContractId("ralph.unknown")).toBe(false);
  });

  for (const id of CONTRACT_IDS) {
    it(`good/${id} validates strict (producer) AND loose (consumer)`, () => {
      const data = loadExample("good", id);
      const strict = validateContract(id, data);
      expect(strict.success, issuesOf(strict)).toBe(true);
      expect(validateContract(id, data, { loose: true }).success).toBe(true);
    });
  }

  for (const id of CONTRACT_IDS) {
    it(`bad/${id} fails for its DOCUMENTED reason — and semantically, not by mere strictness`, () => {
      const data = loadExample("bad", id);
      const strict = validateContract(id, data);
      expect(strict.success).toBe(false);
      expect(issuesOf(strict)).toMatch(REASON_PROBES[id]);
      // The consumer refuses it too: the defect is in the payload, not the mode.
      expect(validateContract(id, data, { loose: true }).success).toBe(false);
    });
  }

  it("unknown keys: the producer refuses, the consumer rides along (additive-only evolution)", () => {
    const v = loadExample("good", "ralph.spawn_request") as Record<string, unknown>;
    v.future_field = "added in some v1.1";
    expect(validateContract("ralph.spawn_request", v).success).toBe(false);
    expect(validateContract("ralph.spawn_request", v, { loose: true }).success).toBe(true);
  });

  it("emitJsonSchemas: one self-contained schema per contract, $id ralph:contracts/<id>", () => {
    const schemas = emitJsonSchemas();
    expect(Object.keys(schemas).sort()).toEqual([...CONTRACT_IDS].sort());
    for (const id of CONTRACT_IDS) expect(schemas[id].$id).toBe(`ralph:contracts/${id}`);
  });
});

// ---------------------------------------------------------------------------
// Naming grammar B
// ---------------------------------------------------------------------------

describe("naming: format/parse round-trips", () => {
  it("round-trips across every lane in the registry", () => {
    for (const lane of LANE_CHARS) {
      const name = formatAgentName(lane, 1743, "Claim V2: multi-holder!");
      expect(name).toBe(`${lane}1743-claim-v2-multi-holder`);
      expect(name.length).toBeLessThanOrEqual(NAME_MAX - GEN_RESERVE);
      expect(parseAgentName(name)).toEqual({
        kind: "v2",
        lane,
        issue: 1743,
        slug: "claim-v2-multi-holder",
        gen: null,
      });
    }
    expect(Object.keys(LANES).sort()).toEqual(["d", "o", "r", "s", "w", "x"]);
  });

  it("issue 0 is the infra reservation — s0-watch and x0-relay parse", () => {
    expect(formatAgentName("s", 0, "watch")).toBe("s0-watch");
    expect(parseAgentName("s0-watch")).toEqual({ kind: "v2", lane: "s", issue: 0, slug: "watch", gen: null });
    expect(parseAgentName("x0-relay")).toEqual({ kind: "v2", lane: "x", issue: 0, slug: "relay", gen: null });
  });

  it("a gen-suffixed name parses back to the same slug, with the generation", () => {
    expect(parseAgentName("w1743-claim--2")).toEqual({ kind: "v2", lane: "w", issue: 1743, slug: "claim", gen: 2 });
  });

  it("accepts exactly 32 chars and refuses 33 — with and without a gen suffix", () => {
    const slug29 = "abcdefghijklmnopqrstuvwxyzabc"; // 29 chars, one word
    const at32 = `w1-${slug29}`;
    expect(at32).toHaveLength(32);
    expect(parseAgentName(at32)).toEqual({ kind: "v2", lane: "w", issue: 1, slug: slug29, gen: null });
    expect(parseAgentName(`${at32}d`)).toBeNull(); // 33 — one char too many
    const gen32 = `w1-${slug29.slice(0, 26)}--2`;
    expect(gen32).toHaveLength(32);
    expect(parseAgentName(gen32)).toEqual({ kind: "v2", lane: "w", issue: 1, slug: slug29.slice(0, 26), gen: 2 });
  });
});

describe("naming: slugify + truncation", () => {
  it("slugify: lowercase, non-alnum runs → one hyphen, trimmed, letter-led, 'task' fallback", () => {
    expect(slugify("Claim V2: multi-holder!")).toBe("claim-v2-multi-holder");
    expect(slugify("  123 Fix the thing ")).toBe("fix-the-thing"); // leading digits stripped — slug must start with a letter
    expect(slugify("🎉🎉🎉")).toBe("task");
    expect(slugify("")).toBe("task");
  });

  it("the slug budget reserves lane, digits, hyphen and 3 chars of gen suffix", () => {
    expect(slugBudget(1743)).toBe(NAME_MAX - 1 - 4 - 1 - GEN_RESERVE); // = 23
    expect(slugBudget(7)).toBe(NAME_MAX - 1 - 1 - 1 - GEN_RESERVE); // = 26
  });

  it("truncates at the last full word of >=3 chars within budget; short trailing words drop", () => {
    // budget(1743) = 23: "implement-the-claim-v2" fits, but its last word "v2"
    // is <3 chars — the cut recedes to "...-claim".
    expect(truncateSlug("implement-the-claim-v2-multi-holder-wire", 1743)).toBe("implement-the-claim");
    // Fits entirely: untouched.
    expect(truncateSlug("claim-v2-multi-holder", 1743)).toBe("claim-v2-multi-holder");
  });

  it("hard-cuts when no word of >=3 chars fits, stripping any trailing hyphen", () => {
    const oneWord = "s" + "x".repeat(30); // a single 31-char word
    expect(truncateSlug(oneWord, 1743)).toBe(oneWord.slice(0, 23));
    // All words <3 chars AND the cut lands on a hyphen — the hyphen is stripped
    // and the result is still a legal slug.
    const shortWords = "a-" + "bc-".repeat(7) + "defgh"; // hyphen at index 22
    const cut = truncateSlug(shortWords, 1743);
    expect(cut).toBe("a-bc-bc-bc-bc-bc-bc-bc");
    expect(SLUG_RE.test(cut)).toBe(true);
  });

  it("formatAgentName always leaves the gen reserve free, even for long titles", () => {
    const name = formatAgentName("w", 1743, "Implement the claim v2 multi holder wire format for herdr");
    expect(name.length).toBeLessThanOrEqual(NAME_MAX - GEN_RESERVE);
    expect(parseAgentName(name)?.kind).toBe("v2");
  });

  it("formatAgentName refuses unknown lanes and non-natural issues", () => {
    expect(() => formatAgentName("q" as Lane, 1, "x")).toThrow(RangeError);
    expect(() => formatAgentName("w", -1, "x")).toThrow(RangeError);
    expect(() => formatAgentName("w", 1.5, "x")).toThrow(RangeError);
  });
});

describe("naming: collision suffixes", () => {
  const slug23 = "abcdefghijklmnopqrstuvw"; // exactly the budget for a 4-digit issue
  const base = `w1743-${slug23}`;

  it("a full-budget base collides into --2..--9 WITHOUT re-truncation — the reserve absorbs it", () => {
    expect(base).toHaveLength(NAME_MAX - GEN_RESERVE);
    expect(collideName(base, new Set())).toBe(base);
    expect(collideName(base, new Set([base]))).toBe(`${base}--2`);
    const third = collideName(base, new Set([base, `${base}--2`]));
    expect(third).toBe(`${base}--3`);
    expect(third).toHaveLength(NAME_MAX); // exactly 32 — never over
    expect(parseAgentName(third)).toEqual({ kind: "v2", lane: "w", issue: 1743, slug: slug23, gen: 3 });
  });

  it("nine live generations is a runaway spawner — collision space exhausts loudly", () => {
    const taken = new Set([base, ...Array.from({ length: 8 }, (_, i) => `${base}--${i + 2}`)]);
    expect(() => collideName(base, taken)).toThrow(RangeError);
  });
});

describe("naming: legacy + rejects", () => {
  it("parses the legacy transition names (gh-N, ralph-deliver, ralph-tend)", () => {
    expect(parseAgentName("gh-1743")).toEqual({ kind: "legacy", name: "gh-1743", issue: 1743 });
    expect(parseAgentName("ralph-deliver")).toEqual({ kind: "legacy", name: "ralph-deliver", issue: null });
    expect(parseAgentName("ralph-tend")).toEqual({ kind: "legacy", name: "ralph-tend", issue: null });
  });

  it("rejects what the grammar forbids", () => {
    const rejects = [
      "", // empty
      "W1743-claim", // uppercase lane
      "w1743-Claim", // uppercase in slug
      "z1743-claim", // regex-shaped but the lane registry is closed
      "w1743-claim--v2", // double hyphen inside the slug
      "w1743--claim", // slug may not start with a hyphen
      "w1743-2fast", // slug must start with a letter
      "w1743claim", // missing separator
      "w1743-claim-", // trailing hyphen
      "w1743-claim--1", // gen range is 2..9
      "w-claim", // no issue digits
      `w1-${"a".repeat(30)}`, // 33 chars
    ];
    for (const name of rejects) expect(parseAgentName(name), JSON.stringify(name)).toBeNull();
  });
});

describe("naming: branches (GH-1807)", () => {
  it("the branch slug is BYTE-IDENTICAL to the agent slug for the same unit", () => {
    const title = "Semantic branch + agent names: fix/NNNN-thing-doing";
    const branch = formatBranchName("fix", 1807, title);
    const agent = formatAgentName("w", 1807, title);
    const b = parseBranchName(branch);
    const a = parseAgentName(agent);
    expect(b).toMatchObject({ kind: "v2", branchKind: "fix", issue: 1807 });
    expect(a).toMatchObject({ kind: "v2", lane: "w", issue: 1807 });
    // The whole point of reusing slugBudget: one vocabulary on both surfaces.
    expect(b?.kind === "v2" && b.slug).toBe(a?.kind === "v2" && a.slug);
  });

  it("round-trips every kind, and truncates on the agent budget", () => {
    for (const kind of BRANCH_KIND_CHARS) {
      const branch = formatBranchName(kind, 1743, "Claim V2: multi-holder!");
      expect(branch).toBe(`${kind}/1743-claim-v2-multi-holder`);
      expect(parseBranchName(branch)).toEqual({
        kind: "v2",
        branchKind: kind,
        issue: 1743,
        slug: "claim-v2-multi-holder",
      });
    }
    // Same truncation as the agent name: word boundary, no trailing hyphen.
    const long = formatBranchName("feat", 1743, "Implement the claim v2 multi holder wire format for herdr");
    expect(long).toBe("feat/1743-implement-the-claim");
    // Non-ASCII / digit-leading titles fall back exactly as slugify does.
    expect(formatBranchName("chore", 1, "🎉🎉🎉")).toBe("chore/1-task");
    expect(formatBranchName("chore", 5, "4x speedup")).toBe("chore/5-x-speedup");
  });

  it("parses the legacy shape and rejects what neither grammar names", () => {
    expect(parseBranchName("feature/GH-1743")).toEqual({
      kind: "legacy",
      branch: "feature/GH-1743",
      issue: 1743,
    });
    const rejects = [
      "",
      "main",
      "feature/gh-1743", // lowercase GH is not the legacy shape
      "feature/1743-slug", // `feature` is the LEGACY prefix, never a live kind
      "Fix/1743-slug", // uppercase kind
      "fix/1743-Slug", // uppercase slug
      "spike/1743-slug", // regex-shaped, but the kind registry is closed
      "fix/1743-slug-", // trailing hyphen
      "fix/1743-2fast", // slug must start with a letter
      "fix/1743", // no slug
      "fix/slug", // no issue digits
      "fix/1743/slug", // nesting is not the grammar
    ];
    for (const b of rejects) expect(parseBranchName(b), JSON.stringify(b)).toBeNull();
  });

  it("branchIssue rejects the substring coincidences GitHub's ref filter returns", () => {
    // `refs(query: "1807")` returns all three; only the first is linkage.
    expect(branchIssue("fix/1807-branch-names")).toBe(1807);
    expect(branchIssue("feature/GH-18070")).toBe(18070);
    expect(branchIssue("chore/1807-typo")).toBe(1807);
    expect(branchIssue("claude/eager-1807-bun")).toBeNull();
    expect(branchIssue("dependabot/npm_and_yarn/typescript-1807")).toBeNull();
  });

  it("branchKindFor: apply label wins, labels map, everything else is the default", () => {
    expect(branchKindFor([])).toBe(DEFAULT_BRANCH_KIND);
    expect(branchKindFor(["type: bug"])).toBe("fix");
    expect(branchKindFor(["kind/bug"])).toBe("fix");
    expect(branchKindFor(["Documentation"])).toBe("docs");
    expect(branchKindFor(["dependencies"])).toBe("chore");
    expect(branchKindFor(["enhancement"])).toBe("feat");
    expect(branchKindFor(["needs-triage"])).toBe(DEFAULT_BRANCH_KIND);
    // The apply label is configured per repo and outranks every other label.
    expect(branchKindFor(["bug", "ralph:apply"], { applyLabel: "ralph:apply" })).toBe("apply");
    expect(branchKindFor(["bug"], { applyLabel: "ralph:apply" })).toBe("fix");
    // Fails closed exactly like isApplyIssue: a truncated list cannot prove
    // the apply label absent, so the branch says apply rather than guessing.
    expect(branchKindFor(["bug"], { applyLabel: "ralph:apply", labelsTruncated: true })).toBe("apply");
    // No apply label configured — truncation is not evidence of anything.
    expect(branchKindFor(["bug"], { labelsTruncated: true })).toBe("fix");
  });

  it("worktreeLeaf flattens the new shape and preserves the legacy one", () => {
    expect(worktreeLeaf("fix/1807-branch-names")).toBe("fix-1807-branch-names");
    // An existing .claude/worktrees/GH-N must stay findable across the window.
    expect(worktreeLeaf("feature/GH-1807")).toBe("GH-1807");
  });

  it("formatBranchName refuses unknown kinds and non-natural issues", () => {
    expect(() => formatBranchName("spike" as BranchKind, 1, "x")).toThrow(RangeError);
    expect(() => formatBranchName("fix", -1, "x")).toThrow(RangeError);
    expect(() => formatBranchName("fix", 1.5, "x")).toThrow(RangeError);
  });
});

describe("naming: golden table — the executable TS/bash mirror", () => {
  it("every naming-golden.tsv row formats identically here (naming.test.sh runs the same rows through naming.sh)", () => {
    const rows = readFileSync(join(EXAMPLES_DIR, "naming-golden.tsv"), "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "" && !l.startsWith("#"));
    expect(rows.length).toBeGreaterThanOrEqual(10); // a thinned table is a weakened mirror
    for (const row of rows) {
      const [lane, issue, title, expected] = row.split("\t");
      expect(formatAgentName(lane as Lane, Number(issue), title), row).toBe(expected);
    }
  });
});

describe("naming: durable refs", () => {
  it("name#epoch round-trips; the epoch is 4-8 lowercase hex", () => {
    const ref = formatRef("w1743-claim", "a3f2");
    expect(ref).toBe("w1743-claim#a3f2");
    expect(parseRef(ref)).toEqual({ name: "w1743-claim", epoch: "a3f2" });
    expect(parseRef("w1743-claim#deadbeef")).toEqual({ name: "w1743-claim", epoch: "deadbeef" });
  });

  it("pane ids, legacy names and bad hex never form a durable ref", () => {
    expect(parseRef("w1743-claim#%17")).toBeNull(); // pane_id is NEVER a durable key
    expect(parseRef("gh-1743#a3f2")).toBeNull(); // legacy names carry no epoch
    expect(parseRef("w1743-claim#A3F2")).toBeNull(); // uppercase hex
    expect(parseRef("w1743-claim#a3f")).toBeNull(); // 3 chars
    expect(parseRef("w1743-claim#a3f2b1c4d")).toBeNull(); // 9 chars
    expect(parseRef("w1743-claim")).toBeNull(); // no epoch at all
    expect(() => formatRef("gh-1743", "a3f2")).toThrow(RangeError);
    expect(() => formatRef("w1743-claim", "%17")).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// ClaimV2 — multi-holder, byte-compatible with the v1 wire
// ---------------------------------------------------------------------------

describe("ClaimV2", () => {
  const t0 = new Date("2026-08-10T14:00:00Z");
  const t1 = new Date("2026-08-10T15:00:00Z");

  it("one holder serializes byte-for-byte as today's board wire — v1 compatibility is exact", () => {
    const holder = "w1743-claim-v2-multi-holder";
    const wire = formatClaim({ holders: [holder], since: t0 });
    expect(wire).toBe(`${holder}|${t0.toISOString()}`);
    expect(wire).toBe(encodeClaim(holder, t0)); // board.ts's own writer agrees, byte for byte
  });

  it("a v1-written claim parses here as a single-holder ClaimV2", () => {
    expect(parseClaim(encodeClaim("gh-1743", t0))).toEqual({ holders: ["gh-1743"], since: t0 });
  });

  it("multi-holder round-trips with insertion order preserved", () => {
    const claim: ClaimV2 = { holders: ["w1743-wire", "r1743-review"], since: t0 };
    const wire = formatClaim(claim);
    expect(wire).toBe(`w1743-wire+r1743-review|${t0.toISOString()}`);
    expect(parseClaim(wire)).toEqual(claim);
  });

  it("membership is exact holder identity", () => {
    const claim: ClaimV2 = { holders: ["w1743-wire", "gh-1743"], since: t0 };
    expect(isMember(claim, "w1743-wire")).toBe(true);
    expect(isMember(claim, "gh-1743")).toBe(true);
    expect(isMember(claim, "w1743-wir")).toBe(false);
  });

  it("addHolder joins the fleet and refreshes the ONE shared since; inputs stay untouched", () => {
    const claim: ClaimV2 = { holders: ["w1743-wire"], since: t0 };
    const joined = addHolder(claim, "r1743-review", t1);
    expect(joined).toEqual({ holders: ["w1743-wire", "r1743-review"], since: t1 });
    expect(claim).toEqual({ holders: ["w1743-wire"], since: t0 }); // no mutation
    // Re-joining an existing member never duplicates, but still heartbeats.
    expect(addHolder(joined, "w1743-wire", t0)).toEqual({ holders: ["w1743-wire", "r1743-review"], since: t0 });
  });

  it("the 8-holder cap refuses loudly; wire delimiters in a holder refuse at the door", () => {
    const eight = Array.from({ length: CLAIM_MAX_HOLDERS }, (_, i) => `w${i + 1}-agent`);
    expect(addHolder({ holders: eight.slice(0, 7), since: t0 }, "w8-agent", t1).holders).toHaveLength(8);
    expect(() => addHolder({ holders: eight, since: t0 }, "w9-agent", t1)).toThrow(RangeError);
    expect(() => addHolder({ holders: [], since: t0 }, "a+b", t1)).toThrow(RangeError);
    expect(() => addHolder({ holders: [], since: t0 }, "a|b", t1)).toThrow(RangeError);
  });

  it("removeHolder: order preserved, non-member is a no-op, last-out clears (null)", () => {
    const claim: ClaimV2 = { holders: ["w1743-a", "r1743-b", "d1743-c"], since: t0 };
    expect(removeHolder(claim, "r1743-b")).toEqual({ holders: ["w1743-a", "d1743-c"], since: t0 });
    expect(removeHolder(claim, "o1743-stranger")).toEqual(claim);
    expect(removeHolder({ holders: ["w1743-a"], since: t0 }, "w1743-a")).toBeNull();
  });

  it("heartbeat: any member refreshes the shared since; a non-member gets null", () => {
    const claim: ClaimV2 = { holders: ["w1743-a", "r1743-b"], since: t0 };
    expect(heartbeat(claim, "r1743-b", t1)).toEqual({ holders: ["w1743-a", "r1743-b"], since: t1 });
    expect(heartbeat(claim, "o1700-stranger", t1)).toBeNull();
  });

  it("holder validation: grammar B and the legacy trio pass; arbitrary strings do not", () => {
    for (const ok of ["w1743-wire", "s0-watch", "gh-1743", "ralph-deliver", "ralph-tend"])
      expect(isValidHolder(ok), ok).toBe(true);
    for (const bad of ["user@host", "W1743-wire", "ralph-work", ""]) expect(isValidHolder(bad), bad).toBe(false);
  });

  it("formatClaim refuses holders carrying wire delimiters — a 'a+b' holder would read back as two members", () => {
    for (const bad of ["a+b", "a|b", ""])
      expect(() => formatClaim({ holders: [bad], since: t0 }), bad).toThrow(RangeError);
    // The failure mode being prevented: the misparse makes the writer a
    // non-member of its own claim.
    const misparsed = parseClaim(`build+deploy@ci|${t0.toISOString()}`);
    expect(misparsed?.holders).toEqual(["build", "deploy@ci"]);
    expect(isMember(misparsed!, "build+deploy@ci")).toBe(false);
  });

  it("garbled wires read as null instead of guessing; duplicates dedupe on read", () => {
    expect(parseClaim("")).toBeNull();
    expect(parseClaim(null)).toBeNull();
    expect(parseClaim("no-separator")).toBeNull();
    expect(parseClaim(`|${t0.toISOString()}`)).toBeNull(); // empty holder list
    expect(parseClaim("w1743-a|not-a-date")).toBeNull();
    expect(parseClaim(`w1743-a++w1743-b|${t0.toISOString()}`)).toBeNull(); // empty token
    const nine = Array.from({ length: 9 }, (_, i) => `w${i + 1}-x`).join("+");
    expect(parseClaim(`${nine}|${t0.toISOString()}`)).toBeNull(); // over the cap
    expect(parseClaim(`w1743-a+w1743-a|${t0.toISOString()}`)).toEqual({ holders: ["w1743-a"], since: t0 });
  });
});

// ---------------------------------------------------------------------------
// Contract refinements (beyond the example corpus)
// ---------------------------------------------------------------------------

describe("C2 CompletionReport refinements", () => {
  const base = () => loadExample("good", "ralph.completion_report") as Record<string, unknown>;

  it("completed demands BOTH pr and commit_sha — dropping either refuses", () => {
    for (const key of ["pr", "commit_sha"] as const) {
      const r = base();
      delete r[key];
      const res = validateContract("ralph.completion_report", r);
      expect(res.success, key).toBe(false);
      expect(issuesOf(res)).toContain(`outcome=completed requires ${key}`);
    }
  });

  it("blocked demands at least one blocker; with one it passes", () => {
    const r = base();
    r.outcome = "blocked";
    r.blockers = [];
    const res = validateContract("ralph.completion_report", r);
    expect(res.success).toBe(false);
    expect(issuesOf(res)).toContain("outcome=blocked requires at least one blocker");
    r.blockers = ["waiting on #1745 wire decision"];
    expect(validateContract("ralph.completion_report", r).success).toBe(true);
  });

  it("failed and abandoned carry no evidence duty", () => {
    for (const outcome of ["failed", "abandoned"]) {
      const r = base();
      r.outcome = outcome;
      delete r.pr;
      delete r.commit_sha;
      expect(validateContract("ralph.completion_report", r).success, outcome).toBe(true);
    }
  });

  it("finished_at may not precede started_at; equality is legal", () => {
    const r = base();
    r.finished_at = "2026-08-10T13:59:59Z";
    const res = validateContract("ralph.completion_report", r);
    expect(res.success).toBe(false);
    expect(issuesOf(res)).toContain("finished_at must be >= started_at");
    r.finished_at = r.started_at as string;
    expect(validateContract("ralph.completion_report", r).success).toBe(true);
  });
});

describe("C3 FleetBrief refinement", () => {
  it("w lane derives /ralph:work N; every other lane is free-form (null)", () => {
    expect(expectedSkillInvocation("w", 1743)).toBe("/ralph:work 1743");
    for (const lane of LANE_CHARS.filter((l) => l !== "w")) expect(expectedSkillInvocation(lane, 1743)).toBeNull();
  });

  it("a non-w lane may carry any nonempty invocation", () => {
    const b = loadExample("good", "ralph.fleet_brief") as Record<string, unknown>;
    b.role = "r";
    b.skill_invocation = "review PR #1760 against the C6 shape";
    expect(validateContract("ralph.fleet_brief", b).success).toBe(true);
  });
});

describe("C4 FleetReply refinements", () => {
  const base = () => loadExample("good", "ralph.fleet_reply") as Record<string, unknown>;

  it("question demands exactly one recommended option — zero or two refuse", () => {
    const zero = base();
    (zero.options as Array<{ recommended?: boolean }>).forEach((o) => delete o.recommended);
    const resZero = validateContract("ralph.fleet_reply", zero);
    expect(resZero.success).toBe(false);
    expect(issuesOf(resZero)).toContain("exactly one recommended option");
    const two = base();
    (two.options as Array<{ recommended?: boolean }>).forEach((o) => (o.recommended = true));
    expect(validateContract("ralph.fleet_reply", two).success).toBe(false);
  });

  it("non-question kinds need no options at all", () => {
    const r = base();
    r.kind = "progress";
    delete r.options;
    expect(validateContract("ralph.fleet_reply", r).success).toBe(true);
  });

  it("body caps at 2000 chars", () => {
    const r = base();
    r.body = "x".repeat(2001);
    expect(validateContract("ralph.fleet_reply", r).success).toBe(false);
  });
});

describe("C6 BoardQueue refinements", () => {
  it("next must deep-equal queue[0] when both are present", () => {
    const v = loadExample("good", "ralph.board_queue") as any;
    v.result.queue[0].priority = "P0"; // next still says P1
    const res = validateContract("ralph.board_queue", v);
    expect(res.success).toBe(false);
    expect(issuesOf(res)).toContain("next must deep-equal queue[0]");
    // null next beside a nonempty queue is outside the refinement's bind.
    const w = loadExample("good", "ralph.board_queue") as any;
    w.result.next = null;
    expect(validateContract("ralph.board_queue", w).success).toBe(true);
  });

  it("queue numbers must be unique — one row per issue", () => {
    const v = loadExample("good", "ralph.board_queue") as any;
    v.result.queue.push(JSON.parse(JSON.stringify(v.result.queue[0])));
    const res = validateContract("ralph.board_queue", v);
    expect(res.success).toBe(false);
    expect(issuesOf(res)).toContain("queue numbers must be unique");
  });
});

describe("C8 TokenVocabulary", () => {
  it("unknown token names: the producer refuses, the consumer ignores strangers", () => {
    const v = loadExample("good", "ralph.token_vocabulary") as any;
    v.tokens.mystery = "x";
    const res = validateContract("ralph.token_vocabulary", v);
    expect(res.success).toBe(false);
    expect(issuesOf(res)).toContain("unknown token name");
    expect(validateContract("ralph.token_vocabulary", v, { loose: true }).success).toBe(true);
  });

  it("values cap at 80 chars in both modes", () => {
    const v = loadExample("good", "ralph.token_vocabulary") as any;
    v.tokens.branch = "x".repeat(81);
    expect(validateContract("ralph.token_vocabulary", v).success).toBe(false);
    expect(validateContract("ralph.token_vocabulary", v, { loose: true }).success).toBe(false);
  });
});

describe("C9 EscalationPayload refinements", () => {
  const base = () => loadExample("good", "ralph.escalation") as Record<string, unknown>;

  it("exactly one recommended option — zero refuses (two is the bad fixture)", () => {
    const r = base();
    (r.options as Array<{ recommended?: boolean }>).forEach((o) => delete o.recommended);
    const res = validateContract("ralph.escalation", r);
    expect(res.success).toBe(false);
    expect(issuesOf(res)).toContain("exactly one option must be recommended");
  });

  it("fewer than two options is not a choice", () => {
    const r = base();
    r.options = [{ id: "only", label: "The only way", recommended: true }];
    expect(validateContract("ralph.escalation", r).success).toBe(false);
  });

  it("the body must be a single line — a phone notification has no scrollback", () => {
    const r = base();
    r.body = "line one\nline two";
    const res = validateContract("ralph.escalation", r);
    expect(res.success).toBe(false);
    expect(issuesOf(res)).toContain("single line");
  });
});

// ---------------------------------------------------------------------------
// C6 parity with the LIVE board CLI — the schema claims to name what board.ts
// REALLY emits, so prove it: drive the real selectors over FakeGh and validate
// the captured JSON. A field renamed or added on the board.ts side fails here
// the same day, not when a live payload first hits a validator. board.ts
// emits the BARE result; the {contract, selector, result} envelope is the
// Phase-2 consumer's wrap (see the C6 note in contracts.ts) — added here
// exactly as that consumer would add it.
// ---------------------------------------------------------------------------

import { run } from "./board.js";
import { FakeGh, makeCtx } from "./board.testkit.js";

describe("C6 parity: real `board … --json` output validates against the schema", () => {
  const capture = (argv: string[], ctx: ReturnType<typeof makeCtx>): unknown => {
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
    return JSON.parse(said.join(""));
  };
  const envelope = (selector: string, result: unknown) => ({
    contract: "ralph.board_queue",
    contract_version: 1,
    selector,
    result,
  });

  it("next --json (queue rows, a blocked row) is exactly the declared shape", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    gh.issues.set(1, { number: 1, state: "Backlog", priority: "P1" });
    gh.issues.set(2, { number: 2, state: "Backlog", blockedBy: [{ number: 1, state: "OPEN" }] });
    gh.issues.set(3, { number: 3, state: "Backlog" });
    const parsed = capture(["next", "--json"], ctx) as { queue: unknown[]; blocked: unknown[] };
    expect(parsed.queue.length).toBeGreaterThan(0); // non-vacuous: real QueueItem rows
    expect(parsed.blocked.length).toBeGreaterThan(0);
    const res = validateContract("ralph.board_queue", envelope("next", parsed));
    expect(res.success, issuesOf(res)).toBe(true);
  });

  it("deliver-queue --json (an actionable row, a no-pr blocked row) is exactly the declared shape", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    const OLD = "2026-07-31T10:00:00Z"; // settled relative to testkit NOW
    gh.issues.set(1, {
      number: 1,
      state: "In Review",
      stateUpdatedAt: OLD,
      prs: [{ number: 101, merged: false, headSha: "sha-a", pushedAt: OLD }],
    });
    gh.issues.set(2, { number: 2, state: "In Review", stateUpdatedAt: OLD }); // no PR at all
    try {
      // Ambient RALPH_* exports must not steer classification (board.test.ts parity).
      vi.stubEnv("RALPH_SETTLE_MIN", undefined);
      vi.stubEnv("RALPH_RETRY_MIN", undefined);
      vi.stubEnv("RALPH_DELIVER_DRYRUN_MAX", undefined);
      vi.stubEnv("RALPH_MERGE_PR_SH", undefined);
      const parsed = capture(["deliver-queue", "--json"], ctx) as { queue: unknown[]; blocked: unknown[] };
      expect(parsed.queue.length).toBeGreaterThan(0);
      expect(parsed.blocked.length).toBeGreaterThan(0);
      const res = validateContract("ralph.board_queue", envelope("deliver-queue", parsed));
      expect(res.success, issuesOf(res)).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("tend-queue --json is exactly the declared shape (observationSlot rides along)", () => {
    const gh = new FakeGh();
    const ctx = makeCtx(gh);
    gh.issues.set(1, { number: 1, state: "Backlog" });
    const parsed = capture(["tend-queue", "--json"], ctx) as { observationSlot: unknown };
    expect(parsed.observationSlot).toBe(true);
    const res = validateContract("ralph.board_queue", envelope("tend-queue", parsed));
    expect(res.success, issuesOf(res)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Lints
// ---------------------------------------------------------------------------

describe("lints", () => {
  it("L1: reply_to must be a routable herdr agent — v2 name under herdr_agent kind", () => {
    expect(lintL1ReplyToShape(loadExample("good", "ralph.fleet_brief"))).toEqual({ rule: "L1", ok: true });
    expect(lintL1ReplyToShape({ reply_to: { kind: "email", name: "o1700-x" } })).toMatchObject({ rule: "L1", ok: false });
    expect(lintL1ReplyToShape({ reply_to: { kind: "herdr_agent", name: "gh-1743" } })).toMatchObject({ ok: false }); // legacy is not routable
    expect(lintL1ReplyToShape({ reply_to: "o1700-x" })).toMatchObject({ ok: false });
    expect(lintL1ReplyToShape({})).toMatchObject({ rule: "L1", skipped: expect.stringContaining("not applicable") });
  });

  it("L2: the agent name parses and its baked-in issue matches the payload's", () => {
    expect(lintL2AgentNameIssue({ agent: "w1743-wire", issue: 1743 })).toEqual({ rule: "L2", ok: true });
    expect(lintL2AgentNameIssue({ agent_ref: "w1743-wire#a3f2", issue: 1743 })).toEqual({ rule: "L2", ok: true });
    expect(lintL2AgentNameIssue({ agent: "w1743-wire", issue: 1800 })).toMatchObject({
      ok: false,
      message: expect.stringContaining("1800"),
    });
    expect(lintL2AgentNameIssue({ agent: "W1743-wire", issue: 1743 })).toMatchObject({ ok: false });
    expect(lintL2AgentNameIssue({ agent: "ralph-deliver", issue: 1743 })).toEqual({ rule: "L2", ok: true }); // legacy bakes no issue
    expect(lintL2AgentNameIssue({})).toMatchObject({ rule: "L2", skipped: expect.any(String) });
  });

  it("L4: outcome-evidence coherence, schema-independent", () => {
    expect(lintL4OutcomeEvidence(loadExample("good", "ralph.completion_report"))).toEqual({ rule: "L4", ok: true });
    const bad = lintL4OutcomeEvidence({ outcome: "completed" });
    expect(bad).toMatchObject({ ok: false });
    expect((bad as { message: string }).message).toContain("completed without pr");
    expect((bad as { message: string }).message).toContain("completed without a valid commit_sha");
    expect(lintL4OutcomeEvidence({ outcome: "blocked", blockers: [] })).toMatchObject({ ok: false });
    expect(lintL4OutcomeEvidence({ outcome: "blocked", blockers: ["#1745"] })).toEqual({ rule: "L4", ok: true });
    expect(lintL4OutcomeEvidence({ outcome: "abandoned" })).toEqual({ rule: "L4", ok: true });
    expect(lintL4OutcomeEvidence({})).toMatchObject({ rule: "L4", skipped: expect.any(String) });
  });

  it("L6: version 1 is known; higher versions refuse LOUDLY; non-integers refuse plainly", () => {
    expect(lintL6ContractVersion({ contract_version: 1 })).toEqual({ rule: "L6", ok: true });
    expect(lintL6ContractVersion({ contract_version: 2 })).toMatchObject({
      ok: false,
      message: expect.stringContaining("REFUSING contract_version 2"),
    });
    expect(lintL6ContractVersion({ contract_version: "1" })).toMatchObject({ ok: false });
    expect(lintL6ContractVersion({})).toMatchObject({ rule: "L6", skipped: expect.any(String) });
  });

  it("L8: the branch is derived, not chosen — <kind>/<issue>-<slug> or the legacy shape", () => {
    expect(lintL8BranchConvention({ issue: 1743, branch: "fix/1743-claim-v2" })).toEqual({ rule: "L8", ok: true });
    expect(lintL8BranchConvention({ issue: 1743, branch: "feature/GH-1743" })).toEqual({ rule: "L8", ok: true });
    expect(lintL8BranchConvention(loadExample("good", "ralph.fleet_brief"))).toEqual({ rule: "L8", ok: true });
    expect(lintL8BranchConvention({ issue: 1743, branch: "feature/gh-1743" })).toMatchObject({ ok: false });
    expect(lintL8BranchConvention({ issue: 1743, branch: "spike/1743-x" })).toMatchObject({ ok: false });
    // Parses, but names another unit — the failure this rule exists for.
    expect(lintL8BranchConvention({ issue: 1743, branch: "fix/1744-claim-v2" })).toMatchObject({
      ok: false,
      message: expect.stringContaining("#1744"),
    });
    // The message names BOTH live shapes, so a refusal is actionable.
    const msg = (lintL8BranchConvention({ issue: 1743, branch: "nope" }) as { message: string }).message;
    expect(msg).toContain("<kind>/1743-<slug>");
    expect(msg).toContain("feature/GH-1743");
    expect(lintL8BranchConvention({ issue: 1743 })).toMatchObject({ rule: "L8", skipped: expect.any(String) });
    expect(lintL8BranchConvention({ branch: "feature/GH-1743" })).toMatchObject({ rule: "L8", skipped: expect.any(String) });
  });

  it("L9: queue-rank integrity on envelopes and bare results alike", () => {
    expect(lintL9QueueRank(loadExample("good", "ralph.board_queue"))).toEqual({ rule: "L9", ok: true });
    expect(lintL9QueueRank(loadExample("bad", "ralph.board_queue"))).toMatchObject({
      ok: false,
      message: expect.stringContaining("not unique"),
    });
    expect(lintL9QueueRank({ result: { next: { number: 2 }, queue: [{ number: 1 }] } })).toMatchObject({
      ok: false,
      message: expect.stringContaining("deep-equal"),
    });
    expect(lintL9QueueRank({ next: null, queue: [] })).toEqual({ rule: "L9", ok: true }); // bare result form
    expect(lintL9QueueRank({})).toMatchObject({ rule: "L9", skipped: expect.any(String) });
  });

  it("L11: the resume path must be machine-actionable for its kind", () => {
    const ok = (target: string, kind = "board_comment") => lintL11EscalationResume({ resume: { kind, target } });
    expect(ok("o1700-herdr-v2-rollout", "herdr_prompt")).toEqual({ rule: "L11", ok: true });
    expect(ok("w1743-wire#a3f2", "herdr_prompt")).toEqual({ rule: "L11", ok: true });
    expect(ok("pane %17", "herdr_prompt")).toMatchObject({ ok: false });
    expect(ok("#1743")).toEqual({ rule: "L11", ok: true });
    expect(ok("1743")).toEqual({ rule: "L11", ok: true });
    expect(ok("https://github.com/cdubiel08/ralph-hero/issues/1743")).toEqual({ rule: "L11", ok: true });
    expect(ok("see the issue")).toMatchObject({ ok: false });
    expect(ok("#1743", "carrier_pigeon")).toMatchObject({ ok: false });
    expect(lintL11EscalationResume({})).toMatchObject({ rule: "L11", skipped: expect.any(String) });
  });

  it("L12: no secret pattern anywhere in the serialized payload", () => {
    expect(lintL12NoSecretLeak(loadExample("good", "ralph.escalation"))).toEqual({ rule: "L12", ok: true });
    expect(lintL12NoSecretLeak({ body: "use sk-ant-api03-abc" })).toMatchObject({ ok: false });
    expect(lintL12NoSecretLeak({ tok: "ghp_abc123" })).toMatchObject({ ok: false });
    expect(lintL12NoSecretLeak({ env: "ANTHROPIC_API_KEY=deadbeef" })).toMatchObject({ ok: false });
    // Merely NAMING the env var (docs, billing guard prose) is not a leak.
    expect(lintL12NoSecretLeak({ note: "unset ANTHROPIC_API_KEY before ticking" })).toEqual({ rule: "L12", ok: true });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(lintL12NoSecretLeak(circular)).toMatchObject({ ok: false, message: expect.stringContaining("JSON") });
  });

  it("L13: timestamps are UTC-Z and ordered; deadline-in-future deliberately unchecked", () => {
    const good = lintL13Timestamps(loadExample("good", "ralph.completion_report"));
    expect(good).toMatchObject({ rule: "L13", ok: true, note: expect.stringContaining("deadline") });
    expect(
      lintL13Timestamps({ started_at: "2026-08-10T15:00:00Z", finished_at: "2026-08-10T14:00:00Z" }),
    ).toMatchObject({ ok: false, message: expect.stringContaining("precedes") });
    expect(lintL13Timestamps({ deadline: "2026-08-10T18:00:00+00:00" })).toMatchObject({
      ok: false,
      message: expect.stringContaining("not UTC-Z"),
    });
    expect(lintL13Timestamps({ lineage: { spawned_at: "yesterdayish" } })).toMatchObject({ ok: false }); // nested walk
    expect(lintL13Timestamps({ nothing: "here" })).toMatchObject({ rule: "L13", skipped: expect.any(String) });
  });

  it("runLints runs every rule in id order and finds nothing wrong with a good payload", () => {
    const results = runLints(loadExample("good", "ralph.completion_report"));
    expect(results.map((r) => r.rule)).toEqual([...LINT_IDS]);
    expect(results.filter((r) => "ok" in r && r.ok === false)).toEqual([]);
    for (const id of ["L3", "L5", "L7"] as const)
      expect(results.find((r) => r.rule === id)).toEqual({ rule: id, skipped: "requires --live" });
    expect(results.find((r) => r.rule === "L10")).toMatchObject({
      skipped: expect.stringContaining("doctor-lineage.sh"),
    });
  });
});

// ---------------------------------------------------------------------------
// Live lints L3/L5/L7 — deps-injected unit level. The effect functions are
// fakes here; board.lint.test.ts drives the same rules through the real CLI
// (`contract lint --live`) over FakeGh and a real temp git repo.
// ---------------------------------------------------------------------------

describe("live lints (deps-injected)", () => {
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  const t0 = new Date("2026-08-10T14:00:00Z");
  const gitSaying = (code: number): LiveLintDeps => ({ execGit: () => ({ code }) });
  const board = (items: Record<number, BoardItemView>): LiveLintDeps => ({
    readBoardItem: (n) => items[n] ?? null,
  });
  const open = (claim: BoardItemView["claim"] = null, state: string | null = "In Progress"): BoardItemView => ({
    issueState: "OPEN",
    state,
    claim,
  });

  it("without deps — or without the specific effect function — every live rule skips: requires --live", () => {
    expect(lintL3CommitInRepo({ commit_sha: SHA })).toEqual({ rule: "L3", skipped: "requires --live" });
    expect(lintL5ClaimReadback({ agent: "w7-wire", issue: 7 })).toEqual({ rule: "L5", skipped: "requires --live" });
    expect(lintL7ParentOpen({ parent_issue: 5 })).toEqual({ rule: "L7", skipped: "requires --live" });
    // Wrong dep present: L3 needs execGit, L5/L7 need readBoardItem.
    expect(lintL3CommitInRepo({ commit_sha: SHA }, board({}))).toEqual({ rule: "L3", skipped: "requires --live" });
    expect(lintL5ClaimReadback({ agent: "w7-wire", issue: 7 }, gitSaying(0))).toEqual({ rule: "L5", skipped: "requires --live" });
    expect(lintL7ParentOpen({ parent_issue: 5 }, gitSaying(0))).toEqual({ rule: "L7", skipped: "requires --live" });
  });

  it("L3: probes `git cat-file -e <sha>^{commit}` — exit 0 passes, nonzero fails with the sha named", () => {
    const calls: string[][] = [];
    const deps: LiveLintDeps = { execGit: (args) => (calls.push(args), { code: 0 }) };
    expect(lintL3CommitInRepo({ commit_sha: SHA }, deps)).toEqual({ rule: "L3", ok: true });
    expect(calls).toEqual([["cat-file", "-e", `${SHA}^{commit}`]]);
    expect(lintL3CommitInRepo({ commit_sha: SHA }, gitSaying(1))).toMatchObject({
      ok: false,
      message: expect.stringContaining(SHA),
    });
  });

  it("L3: a non-sha commit_sha never reaches a git argv — refused before the probe", () => {
    const execGit = vi.fn(() => ({ code: 0 }));
    for (const bad of ["--help", "HEAD", SHA.toUpperCase(), SHA.slice(0, 39), 7]) {
      expect(lintL3CommitInRepo({ commit_sha: bad }, { execGit })).toMatchObject({
        ok: false,
        message: expect.stringContaining("refusing to probe"),
      });
    }
    expect(execGit).not.toHaveBeenCalled();
  });

  it("L3: no commit_sha stays not-applicable even live", () => {
    expect(lintL3CommitInRepo({ outcome: "blocked" }, gitSaying(0))).toMatchObject({
      rule: "L3",
      skipped: expect.stringContaining("not applicable"),
    });
  });

  it("L5: the agent must be a live claim holder — sole or fleet member", () => {
    const claim = { holders: ["w7-wire"], since: t0 };
    expect(lintL5ClaimReadback({ agent: "w7-wire", issue: 7 }, board({ 7: open(claim) }))).toEqual({ rule: "L5", ok: true });
    // agent_ref's name half is the holder identity, same as L2's source rule.
    expect(lintL5ClaimReadback({ agent_ref: "w7-wire#a3f2", issue: 7 }, board({ 7: open(claim) }))).toEqual({ rule: "L5", ok: true });
    const fleet = { holders: ["w7-wire", "r7-review"], since: t0 };
    expect(lintL5ClaimReadback({ agent: "r7-review", issue: 7 }, board({ 7: open(fleet) }))).toEqual({ rule: "L5", ok: true });
  });

  it("L5 fails closed: missing issue, unclaimed issue, and non-member all refuse", () => {
    expect(lintL5ClaimReadback({ agent: "w7-wire", issue: 7 }, board({}))).toMatchObject({
      ok: false,
      message: expect.stringContaining("does not exist"),
    });
    expect(lintL5ClaimReadback({ agent: "w7-wire", issue: 7 }, board({ 7: open() }))).toMatchObject({
      ok: false,
      message: expect.stringContaining("carries no claim"),
    });
    const other = { holders: ["r7-review"], since: t0 };
    expect(lintL5ClaimReadback({ agent: "w7-wire", issue: 7 }, board({ 7: open(other) }))).toMatchObject({
      ok: false,
      message: expect.stringContaining("r7-review"),
    });
  });

  it("L5: a payload without agent + issue is not applicable even live", () => {
    expect(lintL5ClaimReadback({ issue: 7 }, board({}))).toMatchObject({ rule: "L5", skipped: expect.any(String) });
    expect(lintL5ClaimReadback({ agent: "w7-wire" }, board({}))).toMatchObject({ rule: "L5", skipped: expect.any(String) });
  });

  it("L7: parent_issue resolves top-level (C7) and under lineage (C2); open parents pass", () => {
    const items = { 5: open(null, "In Progress") };
    expect(lintL7ParentOpen({ parent_issue: 5 }, board(items))).toEqual({ rule: "L7", ok: true });
    expect(lintL7ParentOpen({ lineage: { parent_issue: 5 } }, board(items))).toEqual({ rule: "L7", ok: true });
    // No state on the board but the issue is open: still legal parent work.
    expect(lintL7ParentOpen({ parent_issue: 5 }, board({ 5: open(null, null) }))).toEqual({ rule: "L7", ok: true });
  });

  it("L7 fails closed: absent, Done/Canceled, and GitHub-closed parents all refuse", () => {
    expect(lintL7ParentOpen({ parent_issue: 5 }, board({}))).toMatchObject({
      ok: false,
      message: expect.stringContaining("orphan parent ref"),
    });
    for (const state of ["Done", "Canceled"]) {
      expect(lintL7ParentOpen({ parent_issue: 5 }, board({ 5: open(null, state) }))).toMatchObject({
        ok: false,
        message: expect.stringContaining(state),
      });
    }
    expect(
      lintL7ParentOpen({ parent_issue: 5 }, board({ 5: { issueState: "CLOSED", state: "In Review", claim: null } })),
    ).toMatchObject({ ok: false, message: expect.stringContaining("closed on GitHub") });
  });

  it("L7: no parent_issue anywhere is not applicable even live", () => {
    expect(lintL7ParentOpen({ issue: 7 }, board({}))).toMatchObject({ rule: "L7", skipped: expect.any(String) });
  });

  it("L10 stays a ledger-side stub pointing at doctor-lineage.sh, deps or not", () => {
    expect(lintL10Live({})).toMatchObject({ rule: "L10", skipped: expect.stringContaining("doctor-lineage.sh") });
    expect(lintL10Live({}, { ...gitSaying(0), ...board({}) })).toMatchObject({
      rule: "L10",
      skipped: expect.stringContaining("doctor-lineage.sh"),
    });
  });

  it("runLints threads deps through to the live rules — a good payload over an agreeing world is all-green", () => {
    const payload = loadExample("good", "ralph.completion_report") as Record<string, unknown>;
    const deps: LiveLintDeps = {
      ...gitSaying(0),
      ...board({
        1743: open({ holders: ["w1743-claim-v2-multi-holder"], since: t0 }),
        1700: open(),
      }),
    };
    const results = runLints(payload, deps);
    expect(results.filter((r) => "ok" in r && r.ok === false)).toEqual([]);
    for (const id of ["L3", "L5", "L7"] as const)
      expect(results.find((r) => r.rule === id)).toEqual({ rule: id, ok: true });
    // The registry agrees with the direct functions — LIVE_LINT_IDS names them.
    expect(LIVE_LINT_IDS).toEqual(["L3", "L5", "L7", "L10"]);
    for (const id of ["L3", "L5", "L7"] as const) expect(LINTS[id](payload, deps)).toEqual({ rule: id, ok: true });
  });
});
