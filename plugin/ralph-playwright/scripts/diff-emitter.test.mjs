#!/usr/bin/env node
// diff-emitter.test.mjs — unit tests for diff-emitter.mjs
// Run with: node --test plugin/ralph-playwright/scripts/diff-emitter.test.mjs
//
// Covers (from Atomic #813 plan §Phase 1 Task 1.3):
//   - renderPrompt placeholder substitution
//   - renderPrompt produces distinguishable text per noise-floor level
//   - parseDiffResponse: NO-MEANINGFUL-CHANGES sentinel -> []
//   - parseDiffResponse: whitespace-tolerant sentinel -> []
//   - parseDiffResponse: multi-bullet response -> N signals with correct shape
//   - parseDiffResponse: chatty preamble + bullets -> bullets only
//   - parseDiffResponse: schema-conformant signal shape
//   - buildDiffPayloads: iterates pairs, produces payload array
//   - buildDiffPayloads: propagates BaselineNotFoundError
//
// Tests use injected readBaseline (no real I/O on the baseline tree). The
// prompt-template I/O is real but reads a file shipped in the repo, so it
// works without test fixtures.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  buildDiffPayloads,
  parseDiffResponse,
  renderPrompt,
  DiffEmitterError,
} from "./diff-emitter.mjs";
import { BaselineNotFoundError } from "./baseline-store.mjs";

// -------------------------------------------------------------------- //
// renderPrompt
// -------------------------------------------------------------------- //

describe("renderPrompt", () => {
  test("substitutes {{ACTION}}, {{TARGET}}, {{NOISE_FLOOR}} in template", async () => {
    const text = await renderPrompt({
      action: "click",
      target: "#submit",
      noiseFloor: "medium",
    });
    // Placeholders are substituted in the rendered prompt.
    assert.ok(
      !text.includes("{{ACTION}}"),
      "{{ACTION}} placeholder not substituted",
    );
    assert.ok(
      !text.includes("{{TARGET}}"),
      "{{TARGET}} placeholder not substituted",
    );
    assert.ok(
      !text.includes("{{NOISE_FLOOR}}"),
      "{{NOISE_FLOOR}} placeholder not substituted",
    );
    // Substituted values appear in the rendered prompt.
    assert.ok(
      text.includes(`action: "click"`),
      "action value missing from rendered prompt",
    );
    assert.ok(
      text.includes(`target: "#submit"`),
      "target value missing from rendered prompt",
    );
    assert.ok(
      text.includes("Noise floor: medium"),
      "noise-floor value missing from rendered prompt",
    );
  });

  test("each noise-floor level produces distinguishable text", async () => {
    const low = await renderPrompt({
      action: "click",
      target: "x",
      noiseFloor: "low",
    });
    const medium = await renderPrompt({
      action: "click",
      target: "x",
      noiseFloor: "medium",
    });
    const high = await renderPrompt({
      action: "click",
      target: "x",
      noiseFloor: "high",
    });
    // The three rendered prompts must NOT be byte-identical — the
    // {{NOISE_FLOOR}} substitution and the rubric paragraph differ per level.
    assert.notEqual(low, medium, "low and medium prompts should differ");
    assert.notEqual(medium, high, "medium and high prompts should differ");
    assert.notEqual(low, high, "low and high prompts should differ");
    // And the substituted level value should be visible in each.
    assert.ok(low.includes("Noise floor: low"));
    assert.ok(medium.includes("Noise floor: medium"));
    assert.ok(high.includes("Noise floor: high"));
  });

  test("rejects invalid noise-floor levels with DiffEmitterError", async () => {
    await assert.rejects(
      () => renderPrompt({ action: "click", target: "x", noiseFloor: "extreme" }),
      (err) => {
        assert.ok(err instanceof DiffEmitterError);
        assert.equal(err.code, "DIFF_EMITTER_INVALID_NOISE_FLOOR");
        return true;
      },
    );
  });

  test("default noise-floor is 'medium' when omitted", async () => {
    const text = await renderPrompt({ action: "click", target: "x" });
    assert.ok(text.includes("Noise floor: medium"));
  });

  test("empty action/target are tolerated (substituted as empty strings)", async () => {
    const text = await renderPrompt({});
    // Should render without throwing. The prompt will have empty quoted strings.
    assert.ok(text.includes(`action: ""`));
    assert.ok(text.includes(`target: ""`));
  });
});

// -------------------------------------------------------------------- //
// parseDiffResponse — sentinels
// -------------------------------------------------------------------- //

describe("parseDiffResponse — no-change sentinels", () => {
  const ctx = {
    currentStep: { index: 3 },
    currentPath: "03_click.png",
    baselinePath: "/abs/baselines/sess/03.png",
    noiseFloor: "medium",
  };

  test("NO-MEANINGFUL-CHANGES (exact) returns []", () => {
    assert.deepEqual(parseDiffResponse("NO-MEANINGFUL-CHANGES", ctx), []);
  });

  test("whitespace-tolerant sentinel returns []", () => {
    assert.deepEqual(parseDiffResponse("  NO-MEANINGFUL-CHANGES\n", ctx), []);
  });

  test("case-insensitive sentinel returns []", () => {
    assert.deepEqual(parseDiffResponse("no-meaningful-changes", ctx), []);
  });

  test("sentinel wrapped in code fence returns []", () => {
    const wrapped = "```\nNO-MEANINGFUL-CHANGES\n```";
    assert.deepEqual(parseDiffResponse(wrapped, ctx), []);
  });

  test("sentinel with trailing period returns []", () => {
    assert.deepEqual(parseDiffResponse("NO-MEANINGFUL-CHANGES.", ctx), []);
  });

  test("empty string returns []", () => {
    assert.deepEqual(parseDiffResponse("", ctx), []);
  });

  test("whitespace-only string returns []", () => {
    assert.deepEqual(parseDiffResponse("   \n\n  ", ctx), []);
  });

  test("non-string input returns []", () => {
    assert.deepEqual(parseDiffResponse(null, ctx), []);
    assert.deepEqual(parseDiffResponse(undefined, ctx), []);
    assert.deepEqual(parseDiffResponse(42, ctx), []);
  });
});

// -------------------------------------------------------------------- //
// parseDiffResponse — bullet parsing
// -------------------------------------------------------------------- //

describe("parseDiffResponse — bullet parsing", () => {
  const ctx = {
    currentStep: { index: 3 },
    currentPath: "03_click.png",
    baselinePath: "/abs/baselines/sess/03.png",
    noiseFloor: "medium",
  };

  test("multi-bullet response produces N signals", () => {
    const response =
      "- Submit button moved ~40px down and lost its drop shadow.\n" +
      "- Primary navigation collapsed from horizontal tabs to hamburger menu.";
    const signals = parseDiffResponse(response, ctx);
    assert.equal(signals.length, 2);
    assert.ok(signals[0].description.startsWith("Submit button moved"));
    assert.ok(signals[1].description.startsWith("Primary navigation"));
  });

  test("each signal has type='regression', severity='medium' by default", () => {
    const response = "- Submit button shifted 8px right.";
    const signals = parseDiffResponse(response, ctx);
    assert.equal(signals.length, 1);
    assert.equal(signals[0].type, "regression");
    // "shifted right" is not a high-severity keyword -> medium.
    assert.equal(signals[0].severity, "medium");
  });

  test("tags include 'semantic-diff' AND the noise-floor value", () => {
    const response = "- Some change.";
    const signals = parseDiffResponse(response, ctx);
    assert.deepEqual(signals[0].tags, ["semantic-diff", "medium"]);
  });

  test("tags reflect a non-default noise-floor", () => {
    const ctxHigh = { ...ctx, noiseFloor: "high" };
    const response = "- Some change.";
    const signals = parseDiffResponse(response, ctxHigh);
    assert.deepEqual(signals[0].tags, ["semantic-diff", "high"]);
  });

  test("evidence.steps contains [currentStep.index]", () => {
    const response = "- A change.";
    const signals = parseDiffResponse(response, ctx);
    assert.deepEqual(signals[0].evidence.steps, [3]);
  });

  test("evidence.screenshots contains both current and baseline paths", () => {
    const response = "- A change.";
    const signals = parseDiffResponse(response, ctx);
    assert.deepEqual(signals[0].evidence.screenshots, [
      "03_click.png",
      "/abs/baselines/sess/03.png",
    ]);
  });

  test("chatty preamble + bullets -> bullets only", () => {
    const response =
      "After reviewing both screenshots I noticed the following meaningful changes:\n" +
      "\n" +
      "- Submit button moved ~40px down and lost its drop shadow.\n" +
      "\n" +
      "Those are the ones worth flagging at the medium noise floor.";
    const signals = parseDiffResponse(response, ctx);
    assert.equal(signals.length, 1);
    assert.ok(signals[0].description.startsWith("Submit button moved"));
  });

  test("supports `* ` bullet prefix as well as `- `", () => {
    const response = "* Submit button moved.\n* Color shifted.";
    const signals = parseDiffResponse(response, ctx);
    assert.equal(signals.length, 2);
  });

  test("title is short (<=40 chars) and ends on a word boundary when truncated", () => {
    const longBullet = "- " +
      "Primary navigation collapsed from horizontal tabs to hamburger menu, " +
      "removing three secondary links.";
    const signals = parseDiffResponse(longBullet, ctx);
    assert.equal(signals.length, 1);
    // Title is at most ~43 chars (40 + "...").
    assert.ok(signals[0].title.length <= 43);
    // Description is the FULL bullet text, not truncated.
    assert.ok(signals[0].description.length > signals[0].title.length);
  });

  test("severity heuristic upgrades to 'high' on 'off-screen' keyword", () => {
    const response = "- Primary CTA pushed off-screen by promo banner.";
    const signals = parseDiffResponse(response, ctx);
    assert.equal(signals[0].severity, "high");
  });

  test("severity heuristic respects RALPH_PLAYWRIGHT_DIFF_SEVERITY_HEURISTIC=off", () => {
    const prev = process.env.RALPH_PLAYWRIGHT_DIFF_SEVERITY_HEURISTIC;
    process.env.RALPH_PLAYWRIGHT_DIFF_SEVERITY_HEURISTIC = "off";
    try {
      const response = "- Primary CTA is off-screen.";
      const signals = parseDiffResponse(response, ctx);
      assert.equal(signals[0].severity, "medium");
    } finally {
      if (prev === undefined) {
        delete process.env.RALPH_PLAYWRIGHT_DIFF_SEVERITY_HEURISTIC;
      } else {
        process.env.RALPH_PLAYWRIGHT_DIFF_SEVERITY_HEURISTIC = prev;
      }
    }
  });

  test("missing currentStep.index yields empty steps evidence array", () => {
    const ctxNoIndex = { ...ctx, currentStep: {} };
    const response = "- Some change.";
    const signals = parseDiffResponse(response, ctxNoIndex);
    assert.deepEqual(signals[0].evidence.steps, []);
  });

  test("non-bullet lines are ignored even when adjacent to bullets", () => {
    const response =
      "Some thoughts:\n" +
      "First, I noticed:\n" +
      "- Submit button moved.\n" +
      "And second:\n" +
      "- Color changed.\n" +
      "End of analysis.";
    const signals = parseDiffResponse(response, ctx);
    assert.equal(signals.length, 2);
  });
});

// -------------------------------------------------------------------- //
// parseDiffResponse — schema-conformance shape check
// -------------------------------------------------------------------- //

describe("parseDiffResponse — schema-conformance shape", () => {
  test("produced signal has all schema-required fields with correct types", () => {
    const ctx = {
      currentStep: { index: 5 },
      currentPath: "05_click.png",
      baselinePath: "/abs/baselines/foo/05.png",
      noiseFloor: "low",
    };
    const response = "- Submit button moved 40px down.";
    const signals = parseDiffResponse(response, ctx);
    assert.equal(signals.length, 1);
    const sig = signals[0];

    // Required fields per signal-report.schema.yaml signals[] item:
    //   type, severity, title, description, evidence, tags
    assert.equal(typeof sig.type, "string");
    assert.equal(sig.type, "regression");
    assert.ok(
      ["critical", "high", "medium", "low"].includes(sig.severity),
      `severity must be in enum (got ${sig.severity})`,
    );
    assert.equal(typeof sig.title, "string");
    assert.ok(sig.title.length > 0, "title must be non-empty");
    assert.equal(typeof sig.description, "string");
    assert.ok(sig.description.length > 0, "description must be non-empty");
    // evidence must have steps[] (integer[]) and screenshots[] (string[])
    assert.ok(sig.evidence && typeof sig.evidence === "object");
    assert.ok(Array.isArray(sig.evidence.steps));
    for (const s of sig.evidence.steps) {
      assert.ok(Number.isInteger(s), `evidence.steps[] must be integers`);
    }
    assert.ok(Array.isArray(sig.evidence.screenshots));
    for (const s of sig.evidence.screenshots) {
      assert.equal(typeof s, "string");
    }
    // tags must be string[]
    assert.ok(Array.isArray(sig.tags));
    for (const t of sig.tags) {
      assert.equal(typeof t, "string");
    }
  });
});

// -------------------------------------------------------------------- //
// buildDiffPayloads
// -------------------------------------------------------------------- //

describe("buildDiffPayloads", () => {
  test("iterates pairs and returns payload array of matching length", async () => {
    // Inject a fake readBaseline that returns a path string (skipping I/O).
    const fakeReadBaseline = async ({ sessionSlug, stepId }) => {
      return `/fake/baselines/${sessionSlug}/${stepId}.png`;
    };

    const pairs = [
      {
        current: { action: "click", target: "#submit", index: 0, screenshot: "00_click.png" },
        baseline: { action: "click", target: "#submit", index: 0 },
        via: "action-target",
      },
      {
        current: { action: "fill", target: "email", index: 1, screenshot: "01_fill.png" },
        baseline: { action: "fill", target: "email", index: 1 },
        via: "action-target",
      },
    ];

    const payloads = await buildDiffPayloads(pairs, {
      sessionSlug: "explore-checkout",
      readBaseline: fakeReadBaseline,
      noiseFloor: "medium",
    });

    assert.equal(payloads.length, 2);
    assert.equal(payloads[0].currentPath, "00_click.png");
    assert.equal(payloads[0].baselinePath, "/fake/baselines/explore-checkout/00.png");
    assert.equal(payloads[1].currentPath, "01_fill.png");
    assert.equal(payloads[1].baselinePath, "/fake/baselines/explore-checkout/01.png");

    // Each payload carries the rendered prompt with placeholders filled.
    assert.ok(payloads[0].prompt.includes(`action: "click"`));
    assert.ok(payloads[0].prompt.includes(`target: "#submit"`));
    assert.ok(payloads[0].prompt.includes("Noise floor: medium"));

    // Payload preserves both step objects verbatim.
    assert.equal(payloads[0].currentStep.index, 0);
    assert.equal(payloads[0].baselineStep.index, 0);

    // noiseFloor is exposed on the payload.
    assert.equal(payloads[0].noiseFloor, "medium");
  });

  test("propagates BaselineNotFoundError verbatim (does not wrap)", async () => {
    const failingReadBaseline = async ({ sessionSlug, stepId }) => {
      throw new BaselineNotFoundError({
        sessionSlug,
        stepId,
        expectedPath: `/fake/baselines/${sessionSlug}/${stepId}.png`,
      });
    };

    const pairs = [
      {
        current: { action: "click", target: "#submit", index: 0 },
        baseline: { action: "click", target: "#submit", index: 0 },
        via: "action-target",
      },
    ];

    await assert.rejects(
      () =>
        buildDiffPayloads(pairs, {
          sessionSlug: "explore-checkout",
          readBaseline: failingReadBaseline,
        }),
      (err) => {
        assert.ok(
          err instanceof BaselineNotFoundError,
          "must propagate BaselineNotFoundError, not wrap it",
        );
        assert.equal(err.code, "BASELINE_NOT_FOUND");
        return true;
      },
    );
  });

  test("respects custom stepIdFor resolver", async () => {
    const fakeReadBaseline = async ({ sessionSlug, stepId }) => {
      return `/fake/baselines/${sessionSlug}/${stepId}.png`;
    };
    // Custom resolver: prefix step-id with "step-".
    const customStepIdFor = (step) =>
      `step-${String(step.index).padStart(2, "0")}`;

    const pairs = [
      {
        current: { action: "click", target: "x", index: 7 },
        baseline: { action: "click", target: "x", index: 7 },
        via: "action-target",
      },
    ];

    const payloads = await buildDiffPayloads(pairs, {
      sessionSlug: "sess",
      readBaseline: fakeReadBaseline,
      stepIdFor: customStepIdFor,
    });

    assert.equal(payloads[0].baselinePath, "/fake/baselines/sess/step-07.png");
  });

  test("default noise-floor is 'medium' when omitted", async () => {
    const fakeReadBaseline = async ({ sessionSlug, stepId }) => {
      return `/fake/baselines/${sessionSlug}/${stepId}.png`;
    };
    const pairs = [
      {
        current: { action: "click", target: "x", index: 0 },
        baseline: { action: "click", target: "x", index: 0 },
        via: "action-target",
      },
    ];
    const payloads = await buildDiffPayloads(pairs, {
      sessionSlug: "sess",
      readBaseline: fakeReadBaseline,
    });
    assert.equal(payloads[0].noiseFloor, "medium");
    assert.ok(payloads[0].prompt.includes("Noise floor: medium"));
  });

  test("rejects malformed pairs with DiffEmitterError", async () => {
    const fakeReadBaseline = async () => "/fake/path.png";
    await assert.rejects(
      () =>
        buildDiffPayloads([null], {
          sessionSlug: "sess",
          readBaseline: fakeReadBaseline,
        }),
      (err) => {
        assert.ok(err instanceof DiffEmitterError);
        assert.equal(err.code, "DIFF_EMITTER_INVALID_PAIR");
        return true;
      },
    );
    await assert.rejects(
      () =>
        buildDiffPayloads([{ current: { action: "click" } }], {
          sessionSlug: "sess",
          readBaseline: fakeReadBaseline,
        }),
      (err) => {
        assert.ok(err instanceof DiffEmitterError);
        assert.equal(err.code, "DIFF_EMITTER_INVALID_PAIR");
        return true;
      },
    );
  });

  test("rejects non-array pairs with DiffEmitterError", async () => {
    await assert.rejects(
      () => buildDiffPayloads("not-an-array", { sessionSlug: "sess" }),
      (err) => {
        assert.ok(err instanceof DiffEmitterError);
        assert.equal(err.code, "DIFF_EMITTER_INVALID_PAIR");
        return true;
      },
    );
  });

  test("rejects empty sessionSlug with DiffEmitterError", async () => {
    await assert.rejects(
      () => buildDiffPayloads([], { sessionSlug: "" }),
      (err) => {
        assert.ok(err instanceof DiffEmitterError);
        assert.equal(err.code, "DIFF_EMITTER_INVALID_PAIR");
        return true;
      },
    );
  });

  test("empty pairs returns empty payloads array", async () => {
    const payloads = await buildDiffPayloads([], { sessionSlug: "sess" });
    assert.deepEqual(payloads, []);
  });
});
