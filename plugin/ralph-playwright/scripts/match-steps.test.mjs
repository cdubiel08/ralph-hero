#!/usr/bin/env node
// match-steps.test.mjs — unit tests for match-steps.mjs
// Run with: node --test plugin/ralph-playwright/scripts/match-steps.test.mjs
//
// Covers (from Atomic #809 plan §Phase 1 Task 1.3):
//   - normalizeActionTarget: trim, lowercase, whitespace collapse, null fallback
//   - Scenario 1: exact match (2 pairs, 0 added, 0 missing)
//   - Scenario 2: reorder (2 pairs by action-target, 0 added, 0 missing)
//   - Scenario 3: extra step in current (2 pairs, 1 added, 0 missing)
//   - Scenario 4: removed from current (2 pairs, 0 added, 1 missing)
//   - Scenario 5: duplicate (action,target) disambiguated by index
//   - Scenario 6: missing target triggers index fallback
//   - Scenario 7: baseline has extra index-only noise (3 pairs, 1 missing)
//
// Tests are pure-function: no I/O, no fixtures, no cleanup.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  matchSteps,
  normalizeActionTarget,
} from "./match-steps.mjs";

// -------------------------------------------------------------------- //
// normalizeActionTarget
// -------------------------------------------------------------------- //

describe("normalizeActionTarget", () => {
  test("trims both sides", () => {
    assert.equal(
      normalizeActionTarget("  click  ", "  #submit  "),
      "click::#submit",
    );
  });

  test("lowercases both sides", () => {
    assert.equal(
      normalizeActionTarget("CLICK", "#Submit-Button"),
      "click::#submit-button",
    );
  });

  test("collapses internal whitespace runs in target", () => {
    assert.equal(
      normalizeActionTarget("verify", "Welcome    back,   user"),
      "verify::welcome back, user",
    );
  });

  test("collapses internal whitespace runs in action", () => {
    assert.equal(
      normalizeActionTarget("click  twice", "#submit"),
      "click twice::#submit",
    );
  });

  test("null action falls through to empty-string normalization", () => {
    assert.equal(normalizeActionTarget(null, "#submit"), "::#submit");
  });

  test("null target falls through to empty-string normalization", () => {
    assert.equal(normalizeActionTarget("click", null), "click::");
  });

  test("undefined inputs yield empty-string sides", () => {
    assert.equal(normalizeActionTarget(undefined, undefined), "::");
  });

  test("treats tabs and newlines as whitespace", () => {
    assert.equal(
      normalizeActionTarget("\tclick\n", " #submit\t"),
      "click::#submit",
    );
  });
});

// -------------------------------------------------------------------- //
// matchSteps
// -------------------------------------------------------------------- //

describe("matchSteps — Scenario 1: exact match", () => {
  test("identical traces yield 2 pairs, both via action-target", () => {
    const current = {
      steps: [
        { action: "click", target: "#submit", index: 0 },
        { action: "fill", target: "email", index: 1 },
      ],
    };
    const baseline = {
      steps: [
        { action: "click", target: "#submit", index: 0 },
        { action: "fill", target: "email", index: 1 },
      ],
    };

    const result = matchSteps(current, baseline);
    assert.equal(result.pairs.length, 2);
    assert.equal(result.addedInCurrent.length, 0);
    assert.equal(result.missingFromCurrent.length, 0);
    assert.equal(result.pairs[0].via, "action-target");
    assert.equal(result.pairs[1].via, "action-target");
    assert.equal(result.pairs[0].current.target, "#submit");
    assert.equal(result.pairs[0].baseline.target, "#submit");
    assert.equal(result.pairs[1].current.target, "email");
    assert.equal(result.pairs[1].baseline.target, "email");
  });
});

describe("matchSteps — Scenario 2: reorder", () => {
  test("reordered current pairs by action-target, ignoring position", () => {
    const current = {
      steps: [
        { action: "fill", target: "email", index: 0 },
        { action: "click", target: "#submit", index: 1 },
      ],
    };
    const baseline = {
      steps: [
        { action: "click", target: "#submit", index: 0 },
        { action: "fill", target: "email", index: 1 },
      ],
    };

    const result = matchSteps(current, baseline);
    assert.equal(result.pairs.length, 2);
    assert.equal(result.addedInCurrent.length, 0);
    assert.equal(result.missingFromCurrent.length, 0);
    // Both pairs match by primary key.
    for (const p of result.pairs) {
      assert.equal(p.via, "action-target");
    }
    // Verify pairing is by key, not position: current[0] (fill,email) pairs
    // with baseline[1] (fill,email).
    const fillPair = result.pairs.find(
      (p) => p.current.action === "fill",
    );
    assert.ok(fillPair, "fill pair exists");
    assert.equal(fillPair.current.index, 0);
    assert.equal(fillPair.baseline.index, 1);
  });
});

describe("matchSteps — Scenario 3: extra step in current", () => {
  test("3 current vs 2 baseline yields 2 pairs + 1 added + 0 missing", () => {
    const current = {
      steps: [
        { action: "click", target: "#submit", index: 0 },
        { action: "fill", target: "email", index: 1 },
        { action: "verify", target: "thanks page", index: 2 },
      ],
    };
    const baseline = {
      steps: [
        { action: "click", target: "#submit", index: 0 },
        { action: "fill", target: "email", index: 1 },
      ],
    };

    const result = matchSteps(current, baseline);
    assert.equal(result.pairs.length, 2);
    assert.equal(result.addedInCurrent.length, 1);
    assert.equal(result.missingFromCurrent.length, 0);
    assert.equal(result.addedInCurrent[0].action, "verify");
    assert.equal(result.addedInCurrent[0].target, "thanks page");
  });
});

describe("matchSteps — Scenario 4: removed from current", () => {
  test("2 current vs 3 baseline yields 2 pairs + 0 added + 1 missing", () => {
    const current = {
      steps: [
        { action: "click", target: "#submit", index: 0 },
        { action: "fill", target: "email", index: 1 },
      ],
    };
    const baseline = {
      steps: [
        { action: "click", target: "#submit", index: 0 },
        { action: "fill", target: "email", index: 1 },
        { action: "verify", target: "thanks page", index: 2 },
      ],
    };

    const result = matchSteps(current, baseline);
    assert.equal(result.pairs.length, 2);
    assert.equal(result.addedInCurrent.length, 0);
    assert.equal(result.missingFromCurrent.length, 1);
    assert.equal(result.missingFromCurrent[0].action, "verify");
    assert.equal(result.missingFromCurrent[0].target, "thanks page");
  });
});

describe("matchSteps — Scenario 5: duplicate (action,target) disambiguated by index", () => {
  test("duplicates pair by index, second pair via 'index'", () => {
    const current = {
      steps: [
        { action: "click", target: "next", index: 0 },
        { action: "click", target: "next", index: 2 },
      ],
    };
    const baseline = {
      steps: [
        { action: "click", target: "next", index: 0 },
        { action: "click", target: "next", index: 3 },
      ],
    };

    const result = matchSteps(current, baseline);
    assert.equal(result.pairs.length, 2);
    assert.equal(result.addedInCurrent.length, 0);
    assert.equal(result.missingFromCurrent.length, 0);

    // First duplicate: current.index=0 matches baseline.index=0 -> via 'index'
    // (both unconsumed; algorithm marks via 'index' when bucket has multiple
    // un-consumed entries even if one matches exactly).
    const first = result.pairs[0];
    assert.equal(first.via, "index");
    assert.equal(first.current.index, 0);
    assert.equal(first.baseline.index, 0);

    // Second duplicate: current.index=2 has no baseline.index=2 candidate
    // remaining; falls back to first un-consumed (baseline.index=3).
    const second = result.pairs[1];
    assert.equal(second.via, "index");
    assert.equal(second.current.index, 2);
    assert.equal(second.baseline.index, 3);
  });
});

describe("matchSteps — Scenario 6: missing target triggers index fallback", () => {
  test("step with empty target pairs at same index via 'index'", () => {
    const current = {
      steps: [
        { action: "click", target: "#submit", index: 0 },
        // No target — primary-key matching cannot disambiguate this.
        { action: "click", index: 1 },
      ],
    };
    const baseline = {
      steps: [
        { action: "click", target: "#submit", index: 0 },
        { action: "click", target: "#cancel", index: 1 },
      ],
    };

    const result = matchSteps(current, baseline);
    assert.equal(result.pairs.length, 2);
    assert.equal(result.addedInCurrent.length, 0);
    assert.equal(result.missingFromCurrent.length, 0);

    // First step matches by primary key.
    assert.equal(result.pairs[0].via, "action-target");
    assert.equal(result.pairs[0].current.target, "#submit");
    assert.equal(result.pairs[0].baseline.target, "#submit");

    // Second step has no target, so falls to index fallback against
    // baseline[1]. The pair is recorded with via 'index'.
    const fallbackPair = result.pairs.find((p) => p.via === "index");
    assert.ok(fallbackPair, "index-fallback pair exists");
    assert.equal(fallbackPair.current.index, 1);
    assert.equal(fallbackPair.baseline.index, 1);
    assert.equal(fallbackPair.baseline.target, "#cancel");
  });
});

describe("matchSteps — Scenario 7: baseline has extra index-only noise", () => {
  test("3 current all match baseline by action-target; 1 baseline missing", () => {
    const current = {
      steps: [
        { action: "navigate", target: "/", index: 0 },
        { action: "click", target: "#submit", index: 1 },
        { action: "verify", target: "thanks", index: 2 },
      ],
    };
    const baseline = {
      steps: [
        { action: "navigate", target: "/", index: 0 },
        { action: "click", target: "#submit", index: 1 },
        { action: "verify", target: "thanks", index: 2 },
        { action: "click", target: "#orphan", index: 3 },
      ],
    };

    const result = matchSteps(current, baseline);
    assert.equal(result.pairs.length, 3);
    assert.equal(result.addedInCurrent.length, 0);
    assert.equal(result.missingFromCurrent.length, 1);
    for (const p of result.pairs) {
      assert.equal(p.via, "action-target");
    }
    assert.equal(result.missingFromCurrent[0].target, "#orphan");
  });
});

// -------------------------------------------------------------------- //
// Edge cases — defensive contract verification
// -------------------------------------------------------------------- //

describe("matchSteps — edge cases", () => {
  test("empty traces yield empty result with stable shape", () => {
    const result = matchSteps({ steps: [] }, { steps: [] });
    assert.deepEqual(result, {
      pairs: [],
      addedInCurrent: [],
      missingFromCurrent: [],
    });
  });

  test("missing steps array on either side is tolerated", () => {
    const result = matchSteps({}, { steps: [] });
    assert.deepEqual(result, {
      pairs: [],
      addedInCurrent: [],
      missingFromCurrent: [],
    });
  });

  test("normalization treats different casings/whitespace as equal", () => {
    const current = {
      steps: [{ action: "Click", target: "  #submit  ", index: 0 }],
    };
    const baseline = {
      steps: [{ action: "click", target: "#submit", index: 0 }],
    };
    const result = matchSteps(current, baseline);
    assert.equal(result.pairs.length, 1);
    assert.equal(result.pairs[0].via, "action-target");
    assert.equal(result.addedInCurrent.length, 0);
    assert.equal(result.missingFromCurrent.length, 0);
  });

  test("trailing-slash URL targets compare as written (not URL-aware)", () => {
    // Documenting current behavior: the matcher does NOT canonicalize URLs.
    // Callers writing `navigate https://example.com` vs
    // `navigate https://example.com/` get two distinct keys. This is by
    // design — see plan §Out of Scope (no fuzzy matching).
    const current = {
      steps: [
        { action: "navigate", target: "https://example.com", index: 0 },
      ],
    };
    const baseline = {
      steps: [
        { action: "navigate", target: "https://example.com/", index: 0 },
      ],
    };
    const result = matchSteps(current, baseline);
    assert.equal(result.pairs.length, 0);
    assert.equal(result.addedInCurrent.length, 1);
    assert.equal(result.missingFromCurrent.length, 1);
  });

  test("missing key on baseline step keeps it for index-fallback consumption", () => {
    const current = {
      steps: [
        { action: "click", index: 0 }, // missing target
      ],
    };
    const baseline = {
      steps: [
        { action: "click", target: "#submit", index: 0 },
      ],
    };
    const result = matchSteps(current, baseline);
    // Current step has missing key -> index fallback. baseline[0] is at
    // same index and unconsumed -> pair with via 'index'.
    assert.equal(result.pairs.length, 1);
    assert.equal(result.pairs[0].via, "index");
    assert.equal(result.addedInCurrent.length, 0);
    assert.equal(result.missingFromCurrent.length, 0);
  });
});
