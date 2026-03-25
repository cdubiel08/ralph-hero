import { describe, it, expect } from "vitest";
import { diffDependencyEdges } from "../tools/plan-graph-tools.js";
import type { DependencyEdge } from "../lib/plan-graph.js";

// ---------------------------------------------------------------------------
// Helper: create a DependencyEdge shorthand
// ---------------------------------------------------------------------------

function edge(
  blocked: number,
  blocking: number,
  source: "phase-level" | "feature-level" = "phase-level",
): DependencyEdge {
  return { blocked, blocking, source };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("diffDependencyEdges", () => {
  it("dryRun semantics — 2 declared, 0 existing → added: 2, removed: 0", () => {
    const declared = [edge(661, 660), edge(662, 660)];
    const existing: DependencyEdge[] = [];
    const planIssues = new Set([660, 661, 662]);

    const diff = diffDependencyEdges(declared, existing, planIssues);

    expect(diff.added).toHaveLength(2);
    expect(diff.removed).toHaveLength(0);
    expect(diff.unchanged).toHaveLength(0);
  });

  it("adds missing edges — declared A→B, existing empty → added: [A→B]", () => {
    const declared = [edge(661, 660)];
    const existing: DependencyEdge[] = [];
    const planIssues = new Set([660, 661]);

    const diff = diffDependencyEdges(declared, existing, planIssues);

    expect(diff.added).toEqual([edge(661, 660)]);
    expect(diff.removed).toHaveLength(0);
    expect(diff.unchanged).toHaveLength(0);
  });

  it("removes stale edges — declared empty, existing A→B between plan issues → removed: [A→B]", () => {
    const declared: DependencyEdge[] = [];
    const existing = [edge(661, 660)];
    const planIssues = new Set([660, 661]);

    const diff = diffDependencyEdges(declared, existing, planIssues);

    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toEqual([edge(661, 660)]);
    expect(diff.unchanged).toHaveLength(0);
  });

  it("leaves external edges alone — existing A→C where C not in plan issues → not in removed", () => {
    const declared: DependencyEdge[] = [];
    // 999 is NOT a plan issue — this edge should not be removed
    const existing = [edge(661, 999)];
    const planIssues = new Set([660, 661]);

    const diff = diffDependencyEdges(declared, existing, planIssues);

    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.unchanged).toHaveLength(0);
  });

  it("idempotent — declared A→B, existing A→B → unchanged: [A→B], added: [], removed: []", () => {
    const declared = [edge(661, 660)];
    const existing = [edge(661, 660)];
    const planIssues = new Set([660, 661]);

    const diff = diffDependencyEdges(declared, existing, planIssues);

    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.unchanged).toHaveLength(1);
    expect(diff.unchanged[0]).toEqual(edge(661, 660));
  });

  it("handles plan with no edges — declared empty, existing empty → all arrays empty", () => {
    const declared: DependencyEdge[] = [];
    const existing: DependencyEdge[] = [];
    const planIssues = new Set([100]);

    const diff = diffDependencyEdges(declared, existing, planIssues);

    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.unchanged).toHaveLength(0);
  });
});
