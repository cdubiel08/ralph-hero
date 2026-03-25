import { describe, it, expect } from "vitest";
import { parsePlanGraph } from "../lib/plan-graph.js";

const PLAN_WITH_DEPS = `---
type: plan
github_issues: [660, 661, 662]
primary_issue: 659
---
# Test Plan

## Phase 1: Core data model (GH-660)
- **depends_on**: null

## Phase 2: API integration (GH-661)
- **depends_on**: [phase-1]

## Phase 3: CLI commands (GH-662)
- **depends_on**: [phase-1]
`;

const PLAN_NO_DEPS = `---
type: plan
github_issues: [100]
primary_issue: 100
---
# Simple Plan

## Phase 1: Everything (GH-100)
`;

const PLAN_OF_PLANS = `---
type: plan-of-plans
github_issues: [44, 45, 46]
primary_issue: 43
---
# Epic Plan

## Feature Decomposition

### Feature A: Auth middleware (GH-44)
- **depends_on**: null

### Feature B: Protected routes (GH-45)
- **depends_on**: [GH-44]

### Feature C: Audit logging (GH-46)
- **depends_on**: null
`;

describe("parsePlanGraph", () => {
  it("parses phase-level depends_on from a plan", () => {
    const graph = parsePlanGraph(PLAN_WITH_DEPS);
    expect(graph.type).toBe("plan");
    expect(graph.issues).toEqual([660, 661, 662]);
    expect(graph.edges).toHaveLength(2);
    expect(graph.edges).toContainEqual({ blocked: 661, blocking: 660, source: "phase-level" });
    expect(graph.edges).toContainEqual({ blocked: 662, blocking: 660, source: "phase-level" });
  });

  it("returns empty edges for plan with no depends_on", () => {
    const graph = parsePlanGraph(PLAN_NO_DEPS);
    expect(graph.edges).toHaveLength(0);
    expect(graph.issues).toEqual([100]);
  });

  it("parses feature-level depends_on from plan-of-plans", () => {
    const graph = parsePlanGraph(PLAN_OF_PLANS);
    expect(graph.type).toBe("plan-of-plans");
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toEqual({ blocked: 45, blocking: 44, source: "feature-level" });
  });

  it("handles depends_on: null explicitly", () => {
    const graph = parsePlanGraph(PLAN_WITH_DEPS);
    const edgesBlocking660 = graph.edges.filter(e => e.blocked === 660);
    expect(edgesBlocking660).toHaveLength(0);
  });

  it("handles multiple dependencies on one phase", () => {
    const content = `---
type: plan
github_issues: [10, 11, 12]
primary_issue: 10
---
## Phase 1: A (GH-10)
- **depends_on**: null

## Phase 2: B (GH-11)
- **depends_on**: null

## Phase 3: C (GH-12)
- **depends_on**: [phase-1, phase-2]
`;
    const graph = parsePlanGraph(content);
    expect(graph.edges).toHaveLength(2);
    expect(graph.edges).toContainEqual({ blocked: 12, blocking: 10, source: "phase-level" });
    expect(graph.edges).toContainEqual({ blocked: 12, blocking: 11, source: "phase-level" });
  });

  it("handles GH-NNN references in plan depends_on", () => {
    const content = `---
type: plan
github_issues: [20, 21]
primary_issue: 20
---
## Phase 1: A (GH-20)
- **depends_on**: null

## Phase 2: B (GH-21)
- **depends_on**: [GH-20]
`;
    const graph = parsePlanGraph(content);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toEqual({ blocked: 21, blocking: 20, source: "phase-level" });
  });

  it("handles multi-word feature names in plan-of-plans", () => {
    const content = `---
type: plan-of-plans
github_issues: [50, 51]
primary_issue: 50
---
## Feature Decomposition

### Feature Auth Core: middleware (GH-50)
- **depends_on**: null

### Feature Protected Routes: guards (GH-51)
- **depends_on**: [GH-50]
`;
    const graph = parsePlanGraph(content);
    expect(graph.type).toBe("plan-of-plans");
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toEqual({ blocked: 51, blocking: 50, source: "feature-level" });
  });

  it("does not attribute depends_on from h2 sections to last feature", () => {
    const content = `---
type: plan-of-plans
github_issues: [60, 61]
primary_issue: 60
---
## Feature Decomposition

### Feature A: auth (GH-60)
- **depends_on**: null

### Feature B: routes (GH-61)
- **depends_on**: [GH-60]

## Integration Strategy

This section should not produce edges even if it mentions depends_on patterns.
`;
    const graph = parsePlanGraph(content);
    expect(graph.edges).toHaveLength(1);
    // Only the Feature B → Feature A edge, nothing from Integration Strategy
    expect(graph.edges[0]).toEqual({ blocked: 61, blocking: 60, source: "feature-level" });
  });
});
