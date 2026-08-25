/**
 * board.claim.test.ts — ClaimV2 (contracts.ts) wired into the board machine.
 *
 * The wire contract: "h1+h2+...|iso8601", 1..8 holders, ONE shared since.
 * A single holder must serialize byte-identically to the v1 "{holder}|{iso}"
 * format — existing boards read back unchanged — and the garbled path
 * (claimRaw non-null with claim null) survives untouched. The transition
 * suite here pins the fleet semantics: any-member heartbeat preserves
 * co-holders, release = removeHolder, and the LAST one out clears the field.
 *
 * GH-1869 split creation from recognition: nothing grows a holder set any
 * more, while every read/report/leave path still handles values already on
 * the board. Both halves are pinned below.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  CLAIM_MAX_HOLDERS,
  type Claim,
  claimMaxEstimate,
  encodeClaim,
  fetchIssue,
  formatClaim,
  guardClaimEstimate,
  heartbeat,
  isMember,
  listItems,
  parseClaim,
  removeHolder,
  transition,
  UsageError,
} from "./board.js";
import * as boardApi from "./board.js";
import * as contractsApi from "./contracts.js";
import { FakeGh, makeCtx, NOW, refusalMessage } from "./board.testkit.js";

const T0 = new Date("2026-08-10T12:00:00Z");
const iso = T0.toISOString();

describe("ClaimV2 wire format (single-holder back-compat)", () => {
  it("one holder serializes byte-identically to the legacy {holder}|{iso} format", () => {
    expect(encodeClaim("chad@mbp", T0)).toBe(`chad@mbp|${iso}`);
    expect(formatClaim({ holders: ["chad@mbp"], since: T0 })).toBe(`chad@mbp|${iso}`);
  });

  it("a v1-written claim round-trips through parse→format unchanged", () => {
    const legacy = `me@host|${iso}`;
    const parsed = parseClaim(legacy);
    expect(parsed).toEqual({ holders: ["me@host"], since: T0 });
    expect(formatClaim(parsed!)).toBe(legacy);
  });

  it("multi-holder round-trips with insertion order preserved", () => {
    const wire = `w1743-claim+r1743-review+me@host|${iso}`;
    const parsed = parseClaim(wire);
    expect(parsed?.holders).toEqual(["w1743-claim", "r1743-review", "me@host"]);
    expect(formatClaim(parsed!)).toBe(wire);
  });

  it("rejects garbled multi-holder text (empty token, >8 holders) as null", () => {
    expect(parseClaim(`a++b|${iso}`)).toBeNull(); // empty holder token
    expect(parseClaim(`+a|${iso}`)).toBeNull(); // leading separator
    const nine = Array.from({ length: 9 }, (_, i) => `w${i}`).join("+");
    expect(parseClaim(`${nine}|${iso}`)).toBeNull(); // over the cap on read
  });
});

describe("ClaimV2 membership operations", () => {
  const base: Claim = { holders: ["w1-a"], since: T0 };
  // Multi-holder values are RECOGNIZED, never CREATED (GH-1869) — so a fleet
  // claim under test comes off the wire, the way a real one now only can.
  const two = parseClaim(`w1-a+w1-b|${iso}`)!;

  it("nothing exported can grow a holder set (GH-1869: creation removed)", () => {
    expect(Object.keys(boardApi)).not.toContain("addHolder");
    expect(Object.keys(boardApi)).not.toContain("claimJoin");
    expect(Object.keys(contractsApi)).not.toContain("addHolder");
  });

  it("removeHolder drops a member; the LAST one out returns null (caller clears the field)", () => {
    expect(removeHolder(two, "w1-a")).toEqual({ holders: ["w1-b"], since: T0 });
    expect(removeHolder(base, "w1-a")).toBeNull();
    expect(removeHolder(base, "stranger")).toBe(base); // non-member: idempotent no-op
  });

  it("heartbeat: ANY member refreshes the shared since; a non-member gets null", () => {
    const later = new Date(T0.getTime() + 5 * 60_000);
    expect(heartbeat(two, "w1-b", later)).toEqual({ holders: ["w1-a", "w1-b"], since: later });
    expect(heartbeat(two, "stranger", later)).toBeNull();
    expect(isMember(two, "w1-b")).toBe(true);
    expect(isMember(two, "stranger")).toBe(false);
  });

  it("the read cap still bounds a recognized fleet at CLAIM_MAX_HOLDERS", () => {
    const eight = Array.from({ length: CLAIM_MAX_HOLDERS }, (_, i) => `w1-h${i}`).join("+");
    expect(parseClaim(`${eight}|${iso}`)?.holders).toHaveLength(CLAIM_MAX_HOLDERS);
    expect(parseClaim(`${eight}+w1-overflow|${iso}`)).toBeNull();
  });
});

describe("ClaimV2 through the board machine", () => {
  it("claim from Backlog writes the exact v1 single-holder bytes (existing boards unchanged)", () => {
    const gh = new FakeGh();
    gh.issues.set(1, { number: 1, state: "Backlog" });
    const ctx = makeCtx(gh);
    transition(ctx, fetchIssue(ctx, 1), "In Progress");
    expect(gh.issues.get(1)!.claim).toBe(`me@test|${NOW.toISOString()}`);
  });

  it("a member's claim refresh heartbeats the fleet — co-holders survive, since refreshes", () => {
    const gh = new FakeGh();
    const old = new Date(NOW.getTime() - 30 * 60_000);
    gh.issues.set(1, { number: 1, state: "In Progress", claim: `me@test+w1-sibling|${old.toISOString()}` });
    const ctx = makeCtx(gh);
    const after = transition(ctx, fetchIssue(ctx, 1), "In Progress");
    expect(gh.issues.get(1)!.claim).toBe(`me@test+w1-sibling|${NOW.toISOString()}`);
    expect(after.claim?.holders).toEqual(["me@test", "w1-sibling"]);
  });

  it("leaving In Progress removes only the leaving member; co-holders keep the claim and its since", () => {
    const gh = new FakeGh();
    const old = new Date(NOW.getTime() - 30 * 60_000);
    gh.issues.set(1, { number: 1, state: "In Progress", claim: `w1-sibling+me@test|${old.toISOString()}` });
    const ctx = makeCtx(gh);
    const after = transition(ctx, fetchIssue(ctx, 1), "In Review");
    expect(gh.issues.get(1)!.claim).toBe(`w1-sibling|${old.toISOString()}`);
    expect(after.claim?.holders).toEqual(["w1-sibling"]); // this session is OUT
  });

  it("the LAST member out clears the field — the single-holder path is byte-for-byte v1 behavior", () => {
    const gh = new FakeGh();
    gh.issues.set(1, { number: 1, state: "In Progress", claim: encodeClaim("me@test", NOW) });
    const ctx = makeCtx(gh);
    const after = transition(ctx, fetchIssue(ctx, 1), "In Review");
    expect(gh.issues.get(1)!.claim).toBeNull();
    expect(after.claim).toBeNull();
  });

  it("a fresh fleet claim refuses a non-member, naming every holder", () => {
    const gh = new FakeGh();
    const fresh = new Date(NOW.getTime() - 10 * 60_000);
    gh.issues.set(1, { number: 1, state: "In Progress", claim: `w1-a+w1-b|${fresh.toISOString()}` });
    const ctx = makeCtx(gh);
    const msg = refusalMessage(() => transition(ctx, fetchIssue(ctx, 1), "In Review"));
    expect(msg).toContain("claimed by w1-a+w1-b");
    expect(gh.issues.get(1)!.claim).toBe(`w1-a+w1-b|${fresh.toISOString()}`); // untouched
  });

  it("garbled Claim text still reads as claimRaw non-null with claim null (fail-closed parse)", () => {
    const gh = new FakeGh();
    gh.issues.set(1, { number: 1, state: "In Progress", claim: "hand-edited note to self" });
    const ctx = makeCtx(gh);
    const [item] = listItems(ctx);
    expect(item.claim).toBeNull();
    expect(item.claimRaw).toBe("hand-edited note to self");
  });
});

// ---------------------------------------------------------------------------
// Claim-size ceiling (GH-2134): RALPH_CLAIM_MAX_ESTIMATE — refuse at/above,
// warn one notch under, not-evaluated on absence, loud on garbage config.
// ---------------------------------------------------------------------------

const CEILING_ENV = "RALPH_CLAIM_MAX_ESTIMATE";
const origCeiling = process.env[CEILING_ENV];

afterEach(() => {
  if (origCeiling === undefined) delete process.env[CEILING_ENV];
  else process.env[CEILING_ENV] = origCeiling;
});

describe("claimMaxEstimate (env parsing)", () => {
  it("unset defaults to XL; empty/whitespace disables; value is case-insensitive", () => {
    expect(claimMaxEstimate(undefined)).toBe("XL");
    expect(claimMaxEstimate("")).toBeNull();
    expect(claimMaxEstimate("   ")).toBeNull();
    expect(claimMaxEstimate("m")).toBe("M");
    expect(claimMaxEstimate("L")).toBe("L");
  });

  it("garbage is a LOUD config error naming the scale — never a silent pass", () => {
    expect(() => claimMaxEstimate("XXL")).toThrow(UsageError);
    expect(() => claimMaxEstimate("huge")).toThrow(/XS, S, M, L, XL/);
    expect(() => claimMaxEstimate("huge")).toThrow(/RALPH_CLAIM_MAX_ESTIMATE/);
  });
});

describe("guardClaimEstimate (the judgment)", () => {
  const silent = () => {};

  it("XL refuses at the default ceiling, naming the remedy verb and the var", () => {
    delete process.env[CEILING_ENV];
    expect(() => guardClaimEstimate({ number: 7, estimate: "XL" }, silent)).toThrow(
      /board estimate 7 L/,
    );
    expect(() => guardClaimEstimate({ number: 7, estimate: "XL" }, silent)).toThrow(
      /RALPH_CLAIM_MAX_ESTIMATE/,
    );
  });

  it("L warns and proceeds at the default ceiling; M and below are silent", () => {
    delete process.env[CEILING_ENV];
    const warned: string[] = [];
    guardClaimEstimate({ number: 7, estimate: "L" }, (m) => warned.push(m));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("one notch under");
    guardClaimEstimate({ number: 7, estimate: "M" }, (m) => warned.push(m));
    guardClaimEstimate({ number: 7, estimate: "XS" }, (m) => warned.push(m));
    expect(warned).toHaveLength(1);
  });

  it("no Estimate, or a value outside the scale, is NOT EVALUATED — never refused (GH-1952 adoption)", () => {
    delete process.env[CEILING_ENV];
    const warned: string[] = [];
    guardClaimEstimate({ number: 7, estimate: null }, (m) => warned.push(m));
    guardClaimEstimate({ number: 7, estimate: "XXL" }, (m) => warned.push(m));
    expect(warned).toHaveLength(0);
  });

  it("a lowered ceiling shifts both tiers: ceiling L refuses L and XL, warns M", () => {
    process.env[CEILING_ENV] = "L";
    const warned: string[] = [];
    expect(() => guardClaimEstimate({ number: 7, estimate: "L" }, silent)).toThrow(/ceiling L/);
    expect(() => guardClaimEstimate({ number: 7, estimate: "XL" }, silent)).toThrow(/ceiling L/);
    guardClaimEstimate({ number: 7, estimate: "M" }, (m) => warned.push(m));
    expect(warned).toHaveLength(1);
  });

  it("empty disables the guard entirely — XL claims without a word", () => {
    process.env[CEILING_ENV] = "";
    const warned: string[] = [];
    guardClaimEstimate({ number: 7, estimate: "XL" }, (m) => warned.push(m));
    expect(warned).toHaveLength(0);
  });
});

describe("claim-size ceiling through the board machine", () => {
  it("a fresh claim on an XL item refuses BEFORE any write — board untouched", () => {
    delete process.env[CEILING_ENV];
    const gh = new FakeGh();
    gh.issues.set(1, { number: 1, state: "Backlog", estimate: "XL" });
    const ctx = makeCtx(gh);
    const msg = refusalMessage(() => transition(ctx, fetchIssue(ctx, 1), "In Progress"));
    expect(msg).toContain("board estimate 1");
    expect(gh.issues.get(1)!.claim ?? null).toBeNull();
    expect(gh.issues.get(1)!.state).toBe("Backlog");
    expect(gh.mutations).toHaveLength(0);
  });

  it("a steal is a fresh acquisition and is judged — the stale claim survives the refusal", () => {
    delete process.env[CEILING_ENV];
    const gh = new FakeGh();
    const stale = new Date(NOW.getTime() - 10 * 60 * 60_000);
    const wire = `gone@elsewhere|${stale.toISOString()}`;
    gh.issues.set(1, { number: 1, state: "In Progress", estimate: "XL", claim: wire });
    const ctx = makeCtx(gh);
    refusalMessage(() => transition(ctx, fetchIssue(ctx, 1), "In Progress", { steal: true }));
    expect(gh.issues.get(1)!.claim).toBe(wire); // no eviction happened
    expect(gh.mutations).toHaveLength(0);
  });

  it("a heartbeat by a current holder passes on an XL item — resume is not relitigated (rule 9)", () => {
    delete process.env[CEILING_ENV];
    const gh = new FakeGh();
    const old = new Date(NOW.getTime() - 30 * 60_000);
    gh.issues.set(1, { number: 1, state: "In Progress", estimate: "XL", claim: `me@test|${old.toISOString()}` });
    const ctx = makeCtx(gh);
    const after = transition(ctx, fetchIssue(ctx, 1), "In Progress");
    expect(after.claim?.since.toISOString()).toBe(NOW.toISOString());
  });

  it("an L item claims, with the warning on stderr", () => {
    delete process.env[CEILING_ENV];
    const gh = new FakeGh();
    gh.issues.set(1, { number: 1, state: "Backlog", estimate: "L" });
    const ctx = makeCtx(gh);
    const orig = process.stderr.write.bind(process.stderr);
    const seen: string[] = [];
    process.stderr.write = ((chunk: string) => {
      seen.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      transition(ctx, fetchIssue(ctx, 1), "In Progress");
    } finally {
      process.stderr.write = orig;
    }
    expect(gh.issues.get(1)!.claim).toBe(`me@test|${NOW.toISOString()}`);
    expect(seen.join("")).toContain("one notch under the claim ceiling XL");
  });

  it("no Estimate claims exactly as today — pinned (GH-1952 adoption path)", () => {
    delete process.env[CEILING_ENV];
    const gh = new FakeGh();
    gh.issues.set(1, { number: 1, state: "Backlog" });
    const ctx = makeCtx(gh);
    transition(ctx, fetchIssue(ctx, 1), "In Progress");
    expect(gh.issues.get(1)!.claim).toBe(`me@test|${NOW.toISOString()}`);
  });

  it("a garbage ceiling refuses the claim loudly instead of silently disarming", () => {
    process.env[CEILING_ENV] = "banana";
    const gh = new FakeGh();
    gh.issues.set(1, { number: 1, state: "Backlog", estimate: "S" });
    const ctx = makeCtx(gh);
    expect(() => transition(ctx, fetchIssue(ctx, 1), "In Progress")).toThrow(UsageError);
    expect(gh.mutations).toHaveLength(0);
  });
});
