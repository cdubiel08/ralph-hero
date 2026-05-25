import { describe, it, expect } from "vitest";
import {
  buildTransitionComment,
  parseTransitionComments,
  parseAuditComments,
  parseAllTransitions,
  type TransitionRecord,
} from "../lib/transition-comments.js";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeRecord(overrides?: Partial<TransitionRecord>): TransitionRecord {
  return {
    from: overrides?.from ?? "Research Needed",
    to: overrides?.to ?? "Research in Progress",
    command: overrides?.command ?? "ralph_research",
    at: overrides?.at ?? "2026-02-16T12:00:00Z",
  };
}

// ---------------------------------------------------------------------------
// buildTransitionComment
// ---------------------------------------------------------------------------

describe("buildTransitionComment", () => {
  it("produces string starting with <!-- and ending with -->", () => {
    const result = buildTransitionComment(makeRecord());
    expect(result.startsWith("<!-- ralph-transition:")).toBe(true);
    expect(result.endsWith("-->")).toBe(true);
  });

  it("contains valid JSON with all 4 fields", () => {
    const result = buildTransitionComment(makeRecord());
    const jsonMatch = result.match(/<!-- ralph-transition: ({.*}) -->/);
    expect(jsonMatch).not.toBeNull();
    const parsed = JSON.parse(jsonMatch![1]);
    expect(parsed).toHaveProperty("from");
    expect(parsed).toHaveProperty("to");
    expect(parsed).toHaveProperty("command");
    expect(parsed).toHaveProperty("at");
  });

  it("output is a single line (no line breaks)", () => {
    const result = buildTransitionComment(makeRecord());
    expect(result.includes("\n")).toBe(false);
    expect(result.includes("\r")).toBe(false);
  });

  it("special characters in state names are JSON-escaped properly", () => {
    const record = makeRecord({ from: 'State "A"', to: "State\nB" });
    const result = buildTransitionComment(record);
    // Should not throw and should be parseable
    const jsonMatch = result.match(/<!-- ralph-transition: ({.*}) -->/);
    expect(jsonMatch).not.toBeNull();
    const parsed = JSON.parse(jsonMatch![1]);
    expect(parsed.from).toBe('State "A"');
    expect(parsed.to).toBe("State\nB");
  });
});

// ---------------------------------------------------------------------------
// parseTransitionComments
// ---------------------------------------------------------------------------

describe("parseTransitionComments", () => {
  it("extracts single transition from comment body", () => {
    const comment = buildTransitionComment(makeRecord());
    const body = `Some text before\n${comment}\nSome text after`;
    const records = parseTransitionComments(body);
    expect(records).toHaveLength(1);
    expect(records[0].from).toBe("Research Needed");
    expect(records[0].to).toBe("Research in Progress");
    expect(records[0].command).toBe("ralph_research");
    expect(records[0].at).toBe("2026-02-16T12:00:00Z");
  });

  it("extracts multiple transitions from multi-line body", () => {
    const c1 = buildTransitionComment(makeRecord({ from: "A", to: "B" }));
    const c2 = buildTransitionComment(makeRecord({ from: "B", to: "C" }));
    const body = `${c1}\nSome text\n${c2}`;
    const records = parseTransitionComments(body);
    expect(records).toHaveLength(2);
    expect(records[0].from).toBe("A");
    expect(records[1].from).toBe("B");
  });

  it("returns empty array for comment with no transition markers", () => {
    const records = parseTransitionComments("Just a regular comment.");
    expect(records).toEqual([]);
  });

  it("handles malformed JSON gracefully (no throw)", () => {
    const body = "<!-- ralph-transition: {not valid json} -->";
    const records = parseTransitionComments(body);
    expect(records).toEqual([]);
  });

  it("handles partial match (opening without closing) — no match", () => {
    const body = "<!-- ralph-transition: {\"from\":\"A\"";
    const records = parseTransitionComments(body);
    expect(records).toEqual([]);
  });

  it("skips records missing required fields", () => {
    const body = '<!-- ralph-transition: {"from":"A","to":"B"} -->';
    const records = parseTransitionComments(body);
    // Missing command and at — should be skipped
    expect(records).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseAuditComments
// ---------------------------------------------------------------------------

describe("parseAuditComments", () => {
  it("extracts transition from audit format", () => {
    const text =
      "**State transition**: Research Needed → Research in Progress (intent: research)\n**Command**: ralph_research";
    const records = parseAuditComments(text, "2026-02-16T14:00:00Z");
    expect(records).toHaveLength(1);
    expect(records[0].from).toBe("Research Needed");
    expect(records[0].to).toBe("Research in Progress");
    expect(records[0].command).toBe("ralph_research");
    expect(records[0].at).toBe("2026-02-16T14:00:00Z");
  });

  it("uses provided commentCreatedAt as the at timestamp", () => {
    const text =
      "**State transition**: A → B (intent: plan)\n**Command**: ralph_plan";
    const timestamp = "2026-01-01T00:00:00Z";
    const records = parseAuditComments(text, timestamp);
    expect(records[0].at).toBe(timestamp);
  });

  it("returns empty array for non-audit comment text", () => {
    const records = parseAuditComments(
      "Just a regular comment with no audit info.",
      "2026-02-16T14:00:00Z",
    );
    expect(records).toEqual([]);
  });

  it("handles multiple audit transitions in one comment", () => {
    const text = [
      "**State transition**: A → B (intent: research)\n**Command**: ralph_research",
      "",
      "**State transition**: B → C (intent: plan)\n**Command**: ralph_plan",
    ].join("\n");
    const records = parseAuditComments(text, "2026-02-16T14:00:00Z");
    expect(records).toHaveLength(2);
    expect(records[0].from).toBe("A");
    expect(records[0].to).toBe("B");
    expect(records[1].from).toBe("B");
    expect(records[1].to).toBe("C");
  });
});

// ---------------------------------------------------------------------------
// Round-trip tests
// ---------------------------------------------------------------------------

describe("round-trip: build → parse", () => {
  it("produces identical TransitionRecord", () => {
    const original = makeRecord();
    const comment = buildTransitionComment(original);
    const parsed = parseTransitionComments(comment);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual(original);
  });

  it("multiple build outputs concatenated → parse returns all records", () => {
    const r1 = makeRecord({ from: "A", to: "B" });
    const r2 = makeRecord({ from: "C", to: "D" });
    const combined = `${buildTransitionComment(r1)}\n${buildTransitionComment(r2)}`;
    const parsed = parseTransitionComments(combined);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual(r1);
    expect(parsed[1]).toEqual(r2);
  });
});

// ---------------------------------------------------------------------------
// parseAllTransitions
// ---------------------------------------------------------------------------

describe("parseAllTransitions", () => {
  it("prefers HTML comment format when both present", () => {
    const htmlComment = buildTransitionComment(
      makeRecord({ at: "2026-02-16T12:00:00Z" }),
    );
    const auditText =
      "**State transition**: Research Needed → Research in Progress (intent: research)\n**Command**: ralph_research";
    const body = `${htmlComment}\n${auditText}`;
    const records = parseAllTransitions(body, "2026-02-16T14:00:00Z");
    // Should have 1 record (deduplicated), preferring HTML timestamp
    expect(records).toHaveLength(1);
    expect(records[0].at).toBe("2026-02-16T12:00:00Z");
  });

  it("falls back to audit format when no HTML comments found", () => {
    const body =
      "**State transition**: A → B (intent: plan)\n**Command**: ralph_plan";
    const records = parseAllTransitions(body, "2026-02-16T14:00:00Z");
    expect(records).toHaveLength(1);
    expect(records[0].from).toBe("A");
    expect(records[0].at).toBe("2026-02-16T14:00:00Z");
  });

  it("returns empty for comment with neither format", () => {
    const records = parseAllTransitions(
      "No transitions here.",
      "2026-02-16T14:00:00Z",
    );
    expect(records).toEqual([]);
  });

  it("deduplicates if both formats describe the same transition", () => {
    const record = makeRecord({
      from: "A",
      to: "B",
      command: "ralph_research",
    });
    const htmlComment = buildTransitionComment(record);
    const auditText =
      "**State transition**: A → B (intent: research)\n**Command**: ralph_research";
    const body = `${htmlComment}\n${auditText}`;
    const records = parseAllTransitions(body, "2026-02-16T14:00:00Z");
    // Same from+to+command → deduplicated to 1
    expect(records).toHaveLength(1);
  });
});
