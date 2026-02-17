/**
 * Tests for estimation-tools: data transformation from GraphQL response
 * to IssueData shape.
 *
 * Tests the extractIssueData function which is a pure transformation.
 */

import { describe, it, expect } from "vitest";
import { extractIssueData } from "../tools/estimation-tools.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIssueResponse(overrides: Record<string, unknown> = {}) {
  return {
    title: "Test issue",
    body: "Test body content",
    labels: { nodes: [{ name: "bug" }] },
    subIssuesSummary: { total: 2 },
    trackedInIssues: { totalCount: 1 },
    trackedIssues: { totalCount: 3 },
    comments: { totalCount: 5 },
    projectItems: {
      nodes: [
        {
          project: { number: 3 },
          fieldValues: {
            nodes: [
              {
                __typename: "ProjectV2ItemFieldSingleSelectValue",
                name: "S",
                field: { name: "Estimate" },
              },
            ],
          },
        },
      ],
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// extractIssueData
// ---------------------------------------------------------------------------

describe("extractIssueData", () => {
  it("extracts title from response", () => {
    const data = extractIssueData(makeIssueResponse({ title: "My title" }));
    expect(data.title).toBe("My title");
  });

  it("extracts body from response", () => {
    const data = extractIssueData(
      makeIssueResponse({ body: "The body text" }),
    );
    expect(data.body).toBe("The body text");
  });

  it("handles null body as empty string", () => {
    const data = extractIssueData(makeIssueResponse({ body: null }));
    expect(data.body).toBe("");
  });

  it("extracts labels as string array", () => {
    const data = extractIssueData(
      makeIssueResponse({
        labels: { nodes: [{ name: "bug" }, { name: "enhancement" }] },
      }),
    );
    expect(data.labels).toEqual(["bug", "enhancement"]);
  });

  it("extracts subIssueCount from summary", () => {
    const data = extractIssueData(
      makeIssueResponse({ subIssuesSummary: { total: 5 } }),
    );
    expect(data.subIssueCount).toBe(5);
  });

  it("handles null subIssuesSummary as 0", () => {
    const data = extractIssueData(
      makeIssueResponse({ subIssuesSummary: null }),
    );
    expect(data.subIssueCount).toBe(0);
  });

  it("computes dependencyCount from tracked issues", () => {
    const data = extractIssueData(
      makeIssueResponse({
        trackedInIssues: { totalCount: 2 },
        trackedIssues: { totalCount: 3 },
      }),
    );
    expect(data.dependencyCount).toBe(5);
  });

  it("extracts commentCount", () => {
    const data = extractIssueData(
      makeIssueResponse({ comments: { totalCount: 10 } }),
    );
    expect(data.commentCount).toBe(10);
  });

  it("handles empty labels", () => {
    const data = extractIssueData(
      makeIssueResponse({ labels: { nodes: [] } }),
    );
    expect(data.labels).toEqual([]);
  });

  it("handles zero dependencies", () => {
    const data = extractIssueData(
      makeIssueResponse({
        trackedInIssues: { totalCount: 0 },
        trackedIssues: { totalCount: 0 },
      }),
    );
    expect(data.dependencyCount).toBe(0);
  });
});
