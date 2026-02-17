/**
 * Tests for the heuristic estimation engine.
 *
 * All functions under test are pure (no I/O), so no mocking is needed.
 */

import { describe, it, expect } from "vitest";
import {
  extractBodyLength,
  extractCheckboxCount,
  extractCodeBlockCount,
  extractSectionCount,
  extractFilePathCount,
  extractKeywords,
  extractLabelSignals,
  extractRelationshipSignals,
  computeEstimate,
  suggestEstimate,
  type IssueData,
  type EstimationSignal,
} from "../lib/estimation-engine.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIssueData(overrides: Partial<IssueData> = {}): IssueData {
  return {
    title: "Test issue",
    body: "A short body for testing.",
    labels: [],
    subIssueCount: 0,
    dependencyCount: 0,
    commentCount: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// extractBodyLength
// ---------------------------------------------------------------------------

describe("extractBodyLength", () => {
  it("returns negative weight for short body (< 200 chars)", () => {
    const signal = extractBodyLength("Short body");
    expect(signal.weight).toBe(-1);
    expect(signal.factor).toBe("body_length");
  });

  it("returns neutral weight for moderate body (200-500 chars)", () => {
    const body = "x".repeat(300);
    const signal = extractBodyLength(body);
    expect(signal.weight).toBe(0);
  });

  it("returns positive weight for detailed body (500-1000 chars)", () => {
    const body = "x".repeat(750);
    const signal = extractBodyLength(body);
    expect(signal.weight).toBe(0.5);
  });

  it("returns high weight for long body (> 1000 chars)", () => {
    const body = "x".repeat(1500);
    const signal = extractBodyLength(body);
    expect(signal.weight).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// extractCheckboxCount
// ---------------------------------------------------------------------------

describe("extractCheckboxCount", () => {
  it("returns zero weight for no checkboxes", () => {
    const signal = extractCheckboxCount("No checkboxes here");
    expect(signal.weight).toBe(0);
    expect(signal.value).toBe(0);
  });

  it("returns zero weight for 1-2 checkboxes", () => {
    const body = "- [ ] task 1\n- [x] task 2";
    const signal = extractCheckboxCount(body);
    expect(signal.weight).toBe(0);
    expect(signal.value).toBe(2);
  });

  it("returns moderate weight for 3-5 checkboxes", () => {
    const body = "- [ ] a\n- [ ] b\n- [ ] c\n- [x] d";
    const signal = extractCheckboxCount(body);
    expect(signal.weight).toBe(0.5);
    expect(signal.value).toBe(4);
  });

  it("returns high weight for 6-8 checkboxes", () => {
    const body = Array.from({ length: 7 }, (_, i) => `- [ ] task ${i}`).join("\n");
    const signal = extractCheckboxCount(body);
    expect(signal.weight).toBe(1);
    expect(signal.value).toBe(7);
  });

  it("returns very high weight for 9+ checkboxes", () => {
    const body = Array.from({ length: 10 }, (_, i) => `- [ ] task ${i}`).join("\n");
    const signal = extractCheckboxCount(body);
    expect(signal.weight).toBe(1.5);
    expect(signal.value).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// extractCodeBlockCount
// ---------------------------------------------------------------------------

describe("extractCodeBlockCount", () => {
  it("returns zero weight for no code blocks", () => {
    const signal = extractCodeBlockCount("No code here");
    expect(signal.weight).toBe(0);
    expect(signal.value).toBe(0);
  });

  it("returns zero weight for 1 code block", () => {
    const body = "```js\nconsole.log('hi');\n```";
    const signal = extractCodeBlockCount(body);
    expect(signal.weight).toBe(0);
    expect(signal.value).toBe(1);
  });

  it("returns moderate weight for 2-3 code blocks", () => {
    const body = "```\nblock1\n```\n```\nblock2\n```";
    const signal = extractCodeBlockCount(body);
    expect(signal.weight).toBe(0.5);
    expect(signal.value).toBe(2);
  });

  it("returns high weight for 4+ code blocks", () => {
    const body = Array.from({ length: 4 }, (_, i) => `\`\`\`\nblock${i}\n\`\`\``).join("\n");
    const signal = extractCodeBlockCount(body);
    expect(signal.weight).toBe(1);
    expect(signal.value).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// extractSectionCount
// ---------------------------------------------------------------------------

describe("extractSectionCount", () => {
  it("returns zero weight for no sections", () => {
    const signal = extractSectionCount("Just a paragraph");
    expect(signal.weight).toBe(0);
  });

  it("returns zero weight for 1-2 sections", () => {
    const body = "## Overview\nText\n## Details\nMore text";
    const signal = extractSectionCount(body);
    expect(signal.weight).toBe(0);
    expect(signal.value).toBe(2);
  });

  it("returns moderate weight for 3-4 sections", () => {
    const body = "## A\n## B\n## C\n## D";
    const signal = extractSectionCount(body);
    expect(signal.weight).toBe(0.5);
    expect(signal.value).toBe(4);
  });

  it("returns high weight for 5+ sections", () => {
    const body = "## A\n## B\n## C\n## D\n## E\n### F";
    const signal = extractSectionCount(body);
    expect(signal.weight).toBe(1);
    expect(signal.value).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// extractFilePathCount
// ---------------------------------------------------------------------------

describe("extractFilePathCount", () => {
  it("returns zero weight for no file references", () => {
    const signal = extractFilePathCount("No files mentioned");
    expect(signal.weight).toBe(0);
  });

  it("returns zero weight for 1 file reference", () => {
    const signal = extractFilePathCount("Edit the config.json file");
    expect(signal.weight).toBe(0);
  });

  it("returns moderate weight for 2-4 file references", () => {
    const body = "Edit src/index.ts and src/tools/batch-tools.ts and lib/helpers.ts";
    const signal = extractFilePathCount(body);
    expect(signal.weight).toBe(0.5);
  });

  it("returns high weight for 5+ file references", () => {
    const body =
      "Files: src/a.ts, src/b.ts, lib/c.ts, test/d.ts, src/e.ts, config.json";
    const signal = extractFilePathCount(body);
    expect(signal.weight).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// extractKeywords
// ---------------------------------------------------------------------------

describe("extractKeywords", () => {
  it("detects high complexity keywords in title", () => {
    const signals = extractKeywords("Refactor the authentication system", "");
    const highSignal = signals.find((s) => s.factor === "high_complexity_keywords");
    expect(highSignal).toBeDefined();
    expect(highSignal!.weight).toBeGreaterThan(0);
  });

  it("detects high complexity keywords in body", () => {
    const signals = extractKeywords("Update", "Need to migrate the database schema");
    const highSignal = signals.find((s) => s.factor === "high_complexity_keywords");
    expect(highSignal).toBeDefined();
    expect(highSignal!.weight).toBeGreaterThan(0);
  });

  it("detects low complexity keywords", () => {
    const signals = extractKeywords("Fix typo in documentation", "");
    const lowSignal = signals.find((s) => s.factor === "low_complexity_keywords");
    expect(lowSignal).toBeDefined();
    expect(lowSignal!.weight).toBeLessThan(0);
  });

  it("caps high complexity weight at +2", () => {
    const signals = extractKeywords(
      "refactor migrate redesign architecture rewrite",
      "",
    );
    const highSignal = signals.find((s) => s.factor === "high_complexity_keywords");
    expect(highSignal!.weight).toBe(2);
  });

  it("caps low complexity weight at -2", () => {
    const signals = extractKeywords(
      "fix typo rename documentation bump version lint format",
      "",
    );
    const lowSignal = signals.find((s) => s.factor === "low_complexity_keywords");
    expect(lowSignal!.weight).toBe(-2);
  });

  it("returns empty array when no keywords found", () => {
    const signals = extractKeywords("Add new feature", "Create a button");
    expect(signals).toHaveLength(0);
  });

  it("returns both signals when both types found", () => {
    const signals = extractKeywords("Refactor documentation", "");
    expect(signals).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// extractLabelSignals
// ---------------------------------------------------------------------------

describe("extractLabelSignals", () => {
  it("returns negative weight for 'bug' label", () => {
    const signals = extractLabelSignals(["bug"]);
    expect(signals).toHaveLength(1);
    expect(signals[0].weight).toBe(-0.5);
  });

  it("returns positive weight for 'enhancement' label", () => {
    const signals = extractLabelSignals(["enhancement"]);
    expect(signals).toHaveLength(1);
    expect(signals[0].weight).toBe(0.5);
  });

  it("returns strong negative weight for 'documentation' label", () => {
    const signals = extractLabelSignals(["documentation"]);
    expect(signals).toHaveLength(1);
    expect(signals[0].weight).toBe(-1);
  });

  it("returns strong positive weight for 'breaking-change' label", () => {
    const signals = extractLabelSignals(["breaking-change"]);
    expect(signals).toHaveLength(1);
    expect(signals[0].weight).toBe(1.5);
  });

  it("returns multiple signals for multiple labels", () => {
    const signals = extractLabelSignals(["enhancement", "breaking-change"]);
    expect(signals).toHaveLength(2);
    const totalWeight = signals.reduce((sum, s) => sum + s.weight, 0);
    expect(totalWeight).toBe(2.0); // 0.5 + 1.5
  });

  it("ignores unknown labels", () => {
    const signals = extractLabelSignals(["custom-label", "my-tag"]);
    expect(signals).toHaveLength(0);
  });

  it("returns empty array for no labels", () => {
    const signals = extractLabelSignals([]);
    expect(signals).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// extractRelationshipSignals
// ---------------------------------------------------------------------------

describe("extractRelationshipSignals", () => {
  it("returns positive weight when sub-issues exist", () => {
    const signals = extractRelationshipSignals(3, 0);
    expect(signals).toHaveLength(1);
    expect(signals[0].factor).toBe("sub_issues");
    expect(signals[0].weight).toBe(1);
  });

  it("returns positive weight for high dependency count", () => {
    const signals = extractRelationshipSignals(0, 4);
    expect(signals).toHaveLength(1);
    expect(signals[0].factor).toBe("dependencies");
    expect(signals[0].weight).toBe(0.5);
  });

  it("returns no signals for zero relationships", () => {
    const signals = extractRelationshipSignals(0, 0);
    expect(signals).toHaveLength(0);
  });

  it("returns no dependency signal for low dependency count", () => {
    const signals = extractRelationshipSignals(0, 2);
    expect(signals).toHaveLength(0);
  });

  it("returns both signals when both conditions met", () => {
    const signals = extractRelationshipSignals(2, 5);
    expect(signals).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// computeEstimate
// ---------------------------------------------------------------------------

describe("computeEstimate", () => {
  it("returns XS for strongly negative score", () => {
    const signals: EstimationSignal[] = [
      { factor: "a", value: "x", impact: "x", weight: -2 },
    ];
    const result = computeEstimate(signals);
    expect(result.estimate).toBe("XS");
    expect(result.rawScore).toBe(-2);
  });

  it("returns S for mildly negative to mildly positive score", () => {
    const signals: EstimationSignal[] = [
      { factor: "a", value: "x", impact: "x", weight: 0 },
    ];
    const result = computeEstimate(signals);
    expect(result.estimate).toBe("S");
  });

  it("returns M for moderate positive score", () => {
    const signals: EstimationSignal[] = [
      { factor: "a", value: "x", impact: "x", weight: 1 },
    ];
    const result = computeEstimate(signals);
    expect(result.estimate).toBe("M");
  });

  it("returns L for high positive score", () => {
    const signals: EstimationSignal[] = [
      { factor: "a", value: "x", impact: "x", weight: 3 },
    ];
    const result = computeEstimate(signals);
    expect(result.estimate).toBe("L");
  });

  it("returns XL for very high positive score", () => {
    const signals: EstimationSignal[] = [
      { factor: "a", value: "x", impact: "x", weight: 4 },
    ];
    const result = computeEstimate(signals);
    expect(result.estimate).toBe("XL");
  });

  it("returns low confidence for conflicting signals", () => {
    const signals: EstimationSignal[] = [
      { factor: "a", value: "x", impact: "x", weight: -2 },
      { factor: "b", value: "x", impact: "x", weight: 2 },
    ];
    const result = computeEstimate(signals);
    expect(result.confidence).toBeLessThan(0.6);
  });

  it("returns high confidence for agreeing signals", () => {
    const signals: EstimationSignal[] = [
      { factor: "a", value: "x", impact: "x", weight: 1 },
      { factor: "b", value: "x", impact: "x", weight: 1 },
      { factor: "c", value: "x", impact: "x", weight: 0.5 },
    ];
    const result = computeEstimate(signals);
    expect(result.confidence).toBeGreaterThan(0.7);
  });

  it("returns low confidence for empty signals", () => {
    const result = computeEstimate([]);
    expect(result.confidence).toBe(0.3);
  });
});

// ---------------------------------------------------------------------------
// suggestEstimate (end-to-end)
// ---------------------------------------------------------------------------

describe("suggestEstimate", () => {
  it("suggests XS for minimal issue", () => {
    const result = suggestEstimate(
      makeIssueData({
        title: "Fix typo",
        body: "Fix a typo in README",
        labels: ["documentation"],
      }),
    );
    expect(result.suggestedEstimate).toBe("XS");
    expect(result.oversized).toBe(false);
  });

  it("suggests S or M for moderate issue", () => {
    const result = suggestEstimate(
      makeIssueData({
        title: "Add validation to form",
        body: "x".repeat(400) +
          "\n- [ ] validate email\n- [ ] validate phone\n- [ ] validate name\n- [ ] show errors",
        labels: ["enhancement"],
      }),
    );
    expect(["S", "M"]).toContain(result.suggestedEstimate);
  });

  it("suggests L or XL for complex issue", () => {
    const body =
      "x".repeat(1200) +
      "\n" +
      Array.from({ length: 9 }, (_, i) => `- [ ] task ${i}`).join("\n") +
      "\n## Phase 1\n## Phase 2\n## Phase 3\n## Phase 4\n## Phase 5" +
      "\n```ts\ncode1\n```\n```ts\ncode2\n```\n```ts\ncode3\n```\n```ts\ncode4\n```";
    const result = suggestEstimate(
      makeIssueData({
        title: "Refactor authentication and database schema",
        body,
        labels: ["breaking-change", "enhancement"],
        subIssueCount: 3,
        dependencyCount: 4,
      }),
    );
    expect(["L", "XL"]).toContain(result.suggestedEstimate);
    expect(result.oversized).toBe(true);
  });

  it("returns oversized false for XS/S estimates", () => {
    const result = suggestEstimate(
      makeIssueData({
        title: "Fix typo in docs",
        body: "Simple fix",
        labels: ["documentation"],
      }),
    );
    expect(result.oversized).toBe(false);
  });

  it("returns oversized true for M/L/XL estimates", () => {
    const body = "x".repeat(1200) +
      "\n" + Array.from({ length: 8 }, (_, i) => `- [ ] task ${i}`).join("\n");
    const result = suggestEstimate(
      makeIssueData({
        title: "Migrate database",
        body,
        labels: ["breaking-change"],
        subIssueCount: 2,
      }),
    );
    expect(result.oversized).toBe(true);
  });

  it("filters out zero-weight signals", () => {
    const result = suggestEstimate(makeIssueData({ body: "x".repeat(300) }));
    // Body length at 300 chars is neutral (weight 0), should be filtered
    const bodyLengthSignal = result.signals.find(
      (s) => s.factor === "body_length",
    );
    expect(bodyLengthSignal).toBeUndefined();
  });

  it("handles empty body gracefully", () => {
    const result = suggestEstimate(makeIssueData({ body: "" }));
    expect(result.suggestedEstimate).toBeDefined();
    expect(result.confidence).toBeGreaterThan(0);
  });

  it("returns signals array explaining reasoning", () => {
    const result = suggestEstimate(
      makeIssueData({
        title: "Refactor module",
        body: "x".repeat(1200),
        labels: ["enhancement"],
      }),
    );
    expect(result.signals.length).toBeGreaterThan(0);
    for (const signal of result.signals) {
      expect(signal.factor).toBeTruthy();
      expect(signal.impact).toBeTruthy();
      expect(typeof signal.weight).toBe("number");
    }
  });

  it("rounds confidence to 2 decimal places", () => {
    const result = suggestEstimate(makeIssueData());
    const decimalPlaces = result.confidence.toString().split(".")[1]?.length || 0;
    expect(decimalPlaces).toBeLessThanOrEqual(2);
  });
});
