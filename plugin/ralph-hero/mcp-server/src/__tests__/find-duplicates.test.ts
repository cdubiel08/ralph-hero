import { describe, it, expect } from "vitest";
import { scoreCandidates } from "../tools/issue-tools.js";

// ---------------------------------------------------------------------------
// Helper: create a minimal candidate object
// ---------------------------------------------------------------------------

function makeCandidate(
  number: number,
  title: string,
  overrides?: Partial<{
    url: string;
    state: string;
    labels: { nodes: Array<{ name: string }> };
    projectItems: {
      nodes: Array<{
        fieldValues: {
          nodes: Array<{
            __typename?: string;
            name?: string;
            field?: { name: string };
          }>;
        };
      }>;
    };
  }>,
) {
  return {
    number,
    title,
    url: overrides?.url ?? `https://github.com/owner/repo/issues/${number}`,
    state: overrides?.state ?? "OPEN",
    labels: overrides?.labels ?? { nodes: [] },
    projectItems: overrides?.projectItems,
  };
}

// ---------------------------------------------------------------------------
// scoreCandidates
// ---------------------------------------------------------------------------

describe("scoreCandidates", () => {
  it("returns candidates with high title similarity above threshold", () => {
    const candidates = [
      makeCandidate(1, "pipeline analytics dashboard"),
      makeCandidate(2, "user authentication flow"),
    ];
    const result = scoreCandidates(
      "pipeline analytics metrics",
      candidates,
      0.3,
      10,
    );
    // "pipeline analytics dashboard" vs "pipeline analytics metrics" should score > 0.3
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0].number).toBe(1);
    expect(result[0].score).toBeGreaterThan(0.3);
  });

  it("filters out candidates with low similarity score", () => {
    const candidates = [
      makeCandidate(1, "completely unrelated topic xyz"),
    ];
    const result = scoreCandidates(
      "pipeline analytics dashboard",
      candidates,
      0.5,
      10,
    );
    expect(result.length).toBe(0);
  });

  it("sorts results by score descending", () => {
    const candidates = [
      makeCandidate(1, "analytics dashboard"),
      makeCandidate(2, "pipeline analytics dashboard view"),
      makeCandidate(3, "pipeline analytics"),
    ];
    const result = scoreCandidates(
      "pipeline analytics dashboard",
      candidates,
      0.0,
      10,
    );
    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1].score).toBeGreaterThanOrEqual(result[i].score);
    }
  });

  it("limits results to maxCandidates", () => {
    const candidates = Array.from({ length: 20 }, (_, i) =>
      makeCandidate(i + 1, `pipeline issue variant ${i}`),
    );
    const result = scoreCandidates("pipeline issue", candidates, 0.0, 5);
    expect(result.length).toBeLessThanOrEqual(5);
  });

  it("returns empty results for empty candidate list", () => {
    const result = scoreCandidates("some title", [], 0.3, 10);
    expect(result).toEqual([]);
  });

  it("threshold of 0.0 returns all candidates", () => {
    const candidates = [
      makeCandidate(1, "completely different topic"),
      makeCandidate(2, "another unrelated thing"),
    ];
    const result = scoreCandidates("pipeline analytics", candidates, 0.0, 10);
    expect(result.length).toBe(2);
  });

  it("threshold of 1.0 returns only exact title matches", () => {
    const candidates = [
      makeCandidate(1, "pipeline analytics"),
      makeCandidate(2, "pipeline analytics dashboard"),
    ];
    const result = scoreCandidates("pipeline analytics", candidates, 1.0, 10);
    expect(result.length).toBe(1);
    expect(result[0].number).toBe(1);
    expect(result[0].score).toBe(1.0);
  });

  it("extracts workflow state from project field values", () => {
    const candidates = [
      makeCandidate(1, "pipeline analytics", {
        projectItems: {
          nodes: [
            {
              fieldValues: {
                nodes: [
                  {
                    __typename: "ProjectV2ItemFieldSingleSelectValue",
                    name: "In Progress",
                    field: { name: "Workflow State" },
                  },
                ],
              },
            },
          ],
        },
      }),
    ];
    const result = scoreCandidates("pipeline analytics", candidates, 0.0, 10);
    expect(result[0].workflowState).toBe("In Progress");
  });

  it("returns null workflow state when no project items", () => {
    const candidates = [makeCandidate(1, "pipeline analytics")];
    const result = scoreCandidates("pipeline analytics", candidates, 0.0, 10);
    expect(result[0].workflowState).toBeNull();
  });

  it("extracts labels from candidates", () => {
    const candidates = [
      makeCandidate(1, "pipeline analytics", {
        labels: { nodes: [{ name: "enhancement" }, { name: "P1" }] },
      }),
    ];
    const result = scoreCandidates("pipeline analytics", candidates, 0.0, 10);
    expect(result[0].labels).toEqual(["enhancement", "P1"]);
  });

  it("rounds scores to 3 decimal places", () => {
    const candidates = [makeCandidate(1, "pipeline analytics dashboard")];
    const result = scoreCandidates(
      "pipeline analytics metrics",
      candidates,
      0.0,
      10,
    );
    const scoreStr = result[0].score.toString();
    const decimals = scoreStr.split(".")[1] || "";
    expect(decimals.length).toBeLessThanOrEqual(3);
  });
});
