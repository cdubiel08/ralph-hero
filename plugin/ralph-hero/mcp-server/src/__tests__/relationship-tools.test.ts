/**
 * Tests for relationship-tools: verifies list_sub_issues depth parameter,
 * buildSubIssueFragment query builder, and mapSubIssueNodes recursive mapper.
 *
 * Combines structural/source-verification tests with direct unit tests
 * for the exported helper functions.
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  buildSubIssueFragment,
  mapSubIssueNodes,
} from "../tools/relationship-tools.js";

const relationshipToolsSrc = fs.readFileSync(
  path.resolve(__dirname, "../tools/relationship-tools.ts"),
  "utf-8",
);

// ---------------------------------------------------------------------------
// Structural: list_sub_issues depth parameter
// ---------------------------------------------------------------------------

describe("list_sub_issues depth parameter structural", () => {
  it("has depth param in Zod schema", () => {
    expect(relationshipToolsSrc).toContain("depth: z.coerce");
  });

  it("depth defaults to 1", () => {
    expect(relationshipToolsSrc).toContain(".default(1)");
  });

  it("depth is capped at 3", () => {
    // The implementation clamps: Math.min(Math.max(args.depth, 1), 3)
    expect(relationshipToolsSrc).toContain("Math.min(Math.max(args.depth, 1), 3)");
  });

  it("tool description mentions depth parameter", () => {
    expect(relationshipToolsSrc).toContain(
      "Use depth parameter (1-3) to fetch nested sub-issue trees",
    );
  });

  it("uses buildSubIssueFragment for dynamic query", () => {
    expect(relationshipToolsSrc).toContain("buildSubIssueFragment(1, depth)");
  });

  it("uses mapSubIssueNodes for response mapping", () => {
    expect(relationshipToolsSrc).toContain("mapSubIssueNodes(");
  });
});

// ---------------------------------------------------------------------------
// Unit: buildSubIssueFragment
// ---------------------------------------------------------------------------

describe("buildSubIssueFragment", () => {
  it("depth=1 returns base fields only (no nested subIssues)", () => {
    const result = buildSubIssueFragment(1, 1);
    expect(result).toBe("id number title state");
    expect(result).not.toContain("subIssues");
    expect(result).not.toContain("subIssuesSummary");
  });

  it("depth=2 returns base fields + one level of nested subIssues", () => {
    const result = buildSubIssueFragment(1, 2);
    expect(result).toContain("id number title state");
    expect(result).toContain("subIssuesSummary { total completed percentCompleted }");
    expect(result).toContain("subIssues(first: 50)");
    // The inner level should have base fields only
    expect(result).toContain("nodes { id number title state }");
  });

  it("depth=3 returns 3 levels of nesting", () => {
    const result = buildSubIssueFragment(1, 3);
    // Count occurrences of "subIssues(first: 50)" - should be 2 (level 1->2 and 2->3)
    const subIssuesMatches = result.match(/subIssues\(first: 50\)/g);
    expect(subIssuesMatches).toHaveLength(2);
    // Count occurrences of "subIssuesSummary" - should be 2 (level 1 and 2)
    const summaryMatches = result.match(/subIssuesSummary/g);
    expect(summaryMatches).toHaveLength(2);
  });

  it("at leaf level returns only base fields", () => {
    // currentDepth == maxDepth should return base fields
    const result = buildSubIssueFragment(3, 3);
    expect(result).toBe("id number title state");
  });
});

// ---------------------------------------------------------------------------
// Unit: mapSubIssueNodes
// ---------------------------------------------------------------------------

describe("mapSubIssueNodes", () => {
  it("depth=1 maps flat array without nested subIssues", () => {
    const nodes = [
      { id: "id1", number: 1, title: "Issue 1", state: "OPEN" },
      { id: "id2", number: 2, title: "Issue 2", state: "CLOSED" },
    ];
    const result = mapSubIssueNodes(nodes, 1, 1);
    expect(result).toEqual([
      { id: "id1", number: 1, title: "Issue 1", state: "OPEN" },
      { id: "id2", number: 2, title: "Issue 2", state: "CLOSED" },
    ]);
    // No subIssues or subIssuesSummary at depth=1
    expect(result[0]).not.toHaveProperty("subIssues");
    expect(result[0]).not.toHaveProperty("subIssuesSummary");
  });

  it("depth=2 includes nested subIssues and subIssuesSummary", () => {
    const nodes = [
      {
        id: "id1",
        number: 1,
        title: "Parent Child",
        state: "OPEN",
        subIssuesSummary: { total: 2, completed: 1, percentCompleted: 50 },
        subIssues: {
          nodes: [
            { id: "id10", number: 10, title: "Grandchild 1", state: "CLOSED" },
            { id: "id11", number: 11, title: "Grandchild 2", state: "OPEN" },
          ],
        },
      },
    ];
    const result = mapSubIssueNodes(nodes, 1, 2);

    expect(result[0].subIssues).toBeDefined();
    expect(result[0].subIssues).toHaveLength(2);
    expect(result[0].subIssuesSummary).toEqual({
      total: 2,
      completed: 1,
      percentCompleted: 50,
    });
    // Grandchildren at depth=2 should NOT have nested subIssues
    expect(result[0].subIssues![0]).not.toHaveProperty("subIssues");
  });

  it("child without subIssues data at depth=2 gets no nested fields", () => {
    const nodes = [
      { id: "id1", number: 1, title: "Leaf Child", state: "OPEN" },
    ];
    // Even at depth=2, if the node has no subIssues.nodes, no nesting is added
    const result = mapSubIssueNodes(nodes, 1, 2);
    expect(result[0]).not.toHaveProperty("subIssues");
    expect(result[0]).not.toHaveProperty("subIssuesSummary");
  });

  it("computes subIssuesSummary from nodes when API summary is missing", () => {
    const nodes = [
      {
        id: "id1",
        number: 1,
        title: "Parent",
        state: "OPEN",
        // No subIssuesSummary from API
        subIssues: {
          nodes: [
            { id: "id10", number: 10, title: "Child A", state: "CLOSED" },
            { id: "id11", number: 11, title: "Child B", state: "OPEN" },
            { id: "id12", number: 12, title: "Child C", state: "CLOSED" },
          ],
        },
      },
    ];
    const result = mapSubIssueNodes(nodes, 1, 2);
    expect(result[0].subIssuesSummary).toEqual({
      total: 3,
      completed: 2,
      percentCompleted: 67,
    });
  });
});
