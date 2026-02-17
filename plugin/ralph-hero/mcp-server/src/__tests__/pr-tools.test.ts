import { describe, it, expect } from "vitest";
import {
  buildPrBody,
  parseLinkedIssues,
  summarizeReviews,
  summarizeChecks,
} from "../tools/pr-tools.js";
import type { PullRequest } from "../types.js";

// ---------------------------------------------------------------------------
// buildPrBody - pure function tests
// ---------------------------------------------------------------------------

describe("buildPrBody", () => {
  it("prepends Closes #N for each linked issue with existing body", () => {
    const result = buildPrBody("My PR description", [10, 20]);
    expect(result).toBe("Closes #10\nCloses #20\n\nMy PR description");
  });

  it("returns just Closes #N when no body provided", () => {
    const result = buildPrBody(undefined, [10]);
    expect(result).toBe("Closes #10");
  });

  it("returns just Closes #N when body is empty string", () => {
    const result = buildPrBody("", [42]);
    expect(result).toBe("Closes #42");
  });

  it("returns body unchanged when no linkedIssueNumbers", () => {
    const result = buildPrBody("My PR", undefined);
    expect(result).toBe("My PR");
  });

  it("returns body unchanged when linkedIssueNumbers is empty", () => {
    const result = buildPrBody("My PR", []);
    expect(result).toBe("My PR");
  });

  it("returns null when no body and no linked issues", () => {
    const result = buildPrBody(undefined, undefined);
    expect(result).toBeNull();
  });

  it("returns null when empty body and no linked issues", () => {
    const result = buildPrBody("", []);
    expect(result).toBeNull();
  });

  it("handles single linked issue", () => {
    const result = buildPrBody("Description", [30]);
    expect(result).toBe("Closes #30\n\nDescription");
  });

  it("handles multiple linked issues", () => {
    const result = buildPrBody(undefined, [1, 2, 3, 4]);
    expect(result).toBe("Closes #1\nCloses #2\nCloses #3\nCloses #4");
  });
});

// ---------------------------------------------------------------------------
// parseLinkedIssues - pure function tests
// ---------------------------------------------------------------------------

describe("parseLinkedIssues", () => {
  it('extracts single "Closes #N"', () => {
    expect(parseLinkedIssues("Closes #10")).toEqual([10]);
  });

  it("extracts multiple closing keywords", () => {
    expect(parseLinkedIssues("Fixes #10\nCloses #20")).toEqual([10, 20]);
  });

  it("de-duplicates repeated issue numbers", () => {
    expect(parseLinkedIssues("Resolves #10 and also Closes #10")).toEqual([10]);
  });

  it("is case insensitive", () => {
    expect(parseLinkedIssues("CLOSES #5")).toEqual([5]);
  });

  it("handles singular form (close)", () => {
    expect(parseLinkedIssues("close #7")).toEqual([7]);
  });

  it("returns empty array for null body", () => {
    expect(parseLinkedIssues(null)).toEqual([]);
  });

  it("returns empty array for empty string", () => {
    expect(parseLinkedIssues("")).toEqual([]);
  });

  it("returns empty array when no closing keywords", () => {
    expect(parseLinkedIssues("No issues linked here")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// summarizeReviews - pure function tests
// ---------------------------------------------------------------------------

describe("summarizeReviews", () => {
  it("returns zeros for empty array", () => {
    const result = summarizeReviews([]);
    expect(result).toEqual({
      approved: 0,
      changesRequested: 0,
      pending: 0,
      total: 0,
      details: [],
    });
  });

  it("de-duplicates by author keeping latest review", () => {
    const result = summarizeReviews([
      { state: "COMMENTED", author: { login: "alice" } },
      { state: "APPROVED", author: { login: "alice" } },
    ]);
    expect(result.approved).toBe(1);
    expect(result.total).toBe(1);
    expect(result.details).toEqual([{ login: "alice", state: "APPROVED" }]);
  });

  it("categorizes mixed review states", () => {
    const result = summarizeReviews([
      { state: "APPROVED", author: { login: "alice" } },
      { state: "CHANGES_REQUESTED", author: { login: "bob" } },
      { state: "COMMENTED", author: { login: "charlie" } },
    ]);
    expect(result.approved).toBe(1);
    expect(result.changesRequested).toBe(1);
    expect(result.pending).toBe(1);
    expect(result.total).toBe(3);
  });

  it('uses "unknown" for null author', () => {
    const result = summarizeReviews([{ state: "APPROVED", author: null }]);
    expect(result.total).toBe(1);
    expect(result.details[0].login).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// summarizeChecks - pure function tests
// ---------------------------------------------------------------------------

describe("summarizeChecks", () => {
  it("returns zeros for empty contexts", () => {
    const result = summarizeChecks(null, []);
    expect(result).toEqual({
      overall: null,
      success: 0,
      failure: 0,
      pending: 0,
      total: 0,
    });
  });

  it("counts CheckRun with conclusion SUCCESS as success", () => {
    const result = summarizeChecks("SUCCESS", [
      { name: "ci", conclusion: "SUCCESS" },
    ]);
    expect(result.success).toBe(1);
    expect(result.total).toBe(1);
  });

  it("counts CheckRun with conclusion FAILURE as failure", () => {
    const result = summarizeChecks("FAILURE", [
      { name: "ci", conclusion: "FAILURE" },
    ]);
    expect(result.failure).toBe(1);
  });

  it("counts CheckRun with null conclusion (in progress) as pending", () => {
    const result = summarizeChecks("PENDING", [
      { name: "ci", conclusion: null },
    ]);
    expect(result.pending).toBe(1);
  });

  it("counts StatusContext with state SUCCESS as success", () => {
    const result = summarizeChecks("SUCCESS", [
      { context: "ci/build", state: "SUCCESS" },
    ]);
    expect(result.success).toBe(1);
  });

  it("counts StatusContext with state ERROR as failure", () => {
    const result = summarizeChecks(null, [
      { context: "ci/build", state: "ERROR" },
    ]);
    expect(result.failure).toBe(1);
  });

  it("categorizes mixed contexts correctly", () => {
    const result = summarizeChecks("FAILURE", [
      { name: "lint", conclusion: "SUCCESS" },
      { name: "test", conclusion: "FAILURE" },
      { name: "deploy", conclusion: "NEUTRAL" },
      { context: "coverage", state: "PENDING" },
      { name: "build", conclusion: "TIMED_OUT" },
      { name: "docs", conclusion: "SKIPPED" },
    ]);
    expect(result.overall).toBe("FAILURE");
    expect(result.success).toBe(3); // SUCCESS + NEUTRAL + SKIPPED
    expect(result.failure).toBe(2); // FAILURE + TIMED_OUT
    expect(result.pending).toBe(1); // PENDING
    expect(result.total).toBe(6);
  });

  it("passes through overall state", () => {
    const result = summarizeChecks("SUCCESS", []);
    expect(result.overall).toBe("SUCCESS");
  });
});

// ---------------------------------------------------------------------------
// PullRequest type compatibility
// ---------------------------------------------------------------------------

describe("PullRequest type", () => {
  it("accepts minimal required fields only", () => {
    const pr: PullRequest = {
      __typename: "PullRequest",
      number: 1,
      title: "Test PR",
      url: "https://github.com/owner/repo/pull/1",
      state: "OPEN",
    };
    expect(pr.number).toBe(1);
    expect(pr.body).toBeUndefined();
    expect(pr.isDraft).toBeUndefined();
  });

  it("accepts all extended optional fields", () => {
    const pr: PullRequest = {
      __typename: "PullRequest",
      number: 2,
      title: "Full PR",
      url: "https://github.com/owner/repo/pull/2",
      state: "MERGED",
      body: "PR body",
      isDraft: false,
      headRefName: "feature/GH-30",
      baseRefName: "main",
      createdAt: "2026-02-16T00:00:00Z",
      author: { login: "cdubiel08" },
    };
    expect(pr.isDraft).toBe(false);
    expect(pr.headRefName).toBe("feature/GH-30");
    expect(pr.author?.login).toBe("cdubiel08");
  });
});
