import { describe, it, expect } from "vitest";
import { buildPrBody } from "../tools/pr-tools.js";
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
