import { describe, it, expect } from "vitest";
import { buildDecomposition } from "../tools/decompose-tools.js";
import { parseRepoRegistry } from "../lib/repo-registry.js";

// ---------------------------------------------------------------------------
// Test fixture: shared registry with two repos and two patterns
// ---------------------------------------------------------------------------

const REGISTRY_YAML = `
version: 1
repos:
  api:
    owner: my-org
    domain: backend
    tech: [typescript, node]
    defaults:
      labels: [backend, api]
      assignees: [api-team]
      estimate: S
    paths: [packages/api]
  frontend:
    domain: ui
    tech: [react, typescript]
    defaults:
      labels: [frontend]
      estimate: M
patterns:
  full-stack:
    description: "Frontend + backend change"
    decomposition:
      - repo: api
        role: Implement REST endpoint
      - repo: frontend
        role: Build UI component
    dependency-flow:
      - "api -> frontend"
  backend-only:
    description: "Backend-only change"
    decomposition:
      - repo: api
        role: Add API logic
`;

const registry = parseRepoRegistry(REGISTRY_YAML);

// ---------------------------------------------------------------------------
// buildDecomposition
// ---------------------------------------------------------------------------

describe("buildDecomposition", () => {
  it("uses the named pattern correctly", () => {
    const result = buildDecomposition(
      { title: "User Auth", description: "Add user authentication", pattern: "full-stack" },
      registry,
    );

    expect(result.matched_pattern).toBe("full-stack");
    expect(result.proposed_issues).toHaveLength(2);
  });

  it("throws on unknown pattern and lists available patterns", () => {
    expect(() =>
      buildDecomposition(
        { title: "Test", description: "Test", pattern: "nonexistent" },
        registry,
      ),
    ).toThrow(/Pattern "nonexistent" not found/);

    let caught: Error | undefined;
    try {
      buildDecomposition(
        { title: "Test", description: "Test", pattern: "nonexistent" },
        registry,
      );
    } catch (err) {
      caught = err as Error;
    }

    expect(caught?.message).toContain("full-stack");
    expect(caught?.message).toContain("backend-only");
  });

  it("generates titles with feature name and role", () => {
    const result = buildDecomposition(
      { title: "User Auth", description: "Add auth", pattern: "full-stack" },
      registry,
    );

    expect(result.proposed_issues[0].title).toBe("[User Auth] Implement REST endpoint");
    expect(result.proposed_issues[1].title).toBe("[User Auth] Build UI component");
  });

  it("resolves owner from registry entry", () => {
    const result = buildDecomposition(
      { title: "User Auth", description: "Add auth", pattern: "full-stack" },
      registry,
    );

    // api entry has owner: my-org
    expect(result.proposed_issues[0].owner).toBe("my-org");
    // frontend entry has no owner — falls back to defaultOwner (undefined in this call)
    expect(result.proposed_issues[1].owner).toBeUndefined();
  });

  it("uses defaultOwner as fallback when registry entry has no owner", () => {
    const result = buildDecomposition(
      { title: "User Auth", description: "Add auth", pattern: "full-stack" },
      registry,
      "fallback-org",
    );

    // frontend entry has no owner — should fall back to defaultOwner
    expect(result.proposed_issues[1].owner).toBe("fallback-org");
    // api entry has explicit owner — still uses its own
    expect(result.proposed_issues[0].owner).toBe("my-org");
  });

  it("applies defaults: labels, assignees, and estimate from registry", () => {
    const result = buildDecomposition(
      { title: "User Auth", description: "Add auth", pattern: "full-stack" },
      registry,
    );

    // api defaults: labels: [backend, api], assignees: [api-team], estimate: S
    const apiIssue = result.proposed_issues[0];
    expect(apiIssue.labels).toContain("backend");
    expect(apiIssue.labels).toContain("api");
    expect(apiIssue.assignees).toEqual(["api-team"]);
    expect(apiIssue.estimate).toBe("S");

    // frontend defaults: labels: [frontend], estimate: M, no assignees
    const frontendIssue = result.proposed_issues[1];
    expect(frontendIssue.labels).toContain("frontend");
    expect(frontendIssue.estimate).toBe("M");
    expect(frontendIssue.assignees).toBeUndefined();
  });

  it("returns the correct dependency chain from the pattern's dependency-flow", () => {
    const result = buildDecomposition(
      { title: "User Auth", description: "Add auth", pattern: "full-stack" },
      registry,
    );

    expect(result.dependency_chain).toEqual(["api -> frontend"]);
  });

  it("returns empty dependency chain for a pattern with no dependency-flow", () => {
    const result = buildDecomposition(
      { title: "Fix Bug", description: "Fix backend bug", pattern: "backend-only" },
      registry,
    );

    expect(result.dependency_chain).toEqual([]);
  });

  it("populates issue body with Context, Scope, and Repo sections", () => {
    const result = buildDecomposition(
      { title: "User Auth", description: "Add authentication", pattern: "full-stack" },
      registry,
    );

    const body = result.proposed_issues[0].body;
    expect(body).toContain("## Context");
    expect(body).toContain("Add authentication");
    expect(body).toContain("## Scope");
    expect(body).toContain("Implement REST endpoint");
    expect(body).toContain("## Repo");
    expect(body).toContain("Domain: backend");
  });

  it("is case-insensitive for pattern name lookup", () => {
    const result = buildDecomposition(
      { title: "Test", description: "Test", pattern: "FULL-STACK" },
      registry,
    );

    expect(result.matched_pattern).toBe("full-stack");
    expect(result.proposed_issues).toHaveLength(2);
  });

  it("sets repoKey to the canonical registry name", () => {
    const result = buildDecomposition(
      { title: "Test", description: "Test", pattern: "full-stack" },
      registry,
    );

    expect(result.proposed_issues[0].repoKey).toBe("api");
    expect(result.proposed_issues[1].repoKey).toBe("frontend");
  });

  it("throws a helpful error when pattern step references unknown repo", () => {
    const yamlWithBadPattern = `
version: 1
repos:
  api:
    domain: backend
patterns:
  bad-pattern:
    description: "References missing repo"
    decomposition:
      - repo: nonexistent-repo
        role: Do something
`;
    const badRegistry = parseRepoRegistry(yamlWithBadPattern);

    expect(() =>
      buildDecomposition(
        { title: "Test", description: "Test", pattern: "bad-pattern" },
        badRegistry,
      ),
    ).toThrow(/unknown repo "nonexistent-repo"/);
  });
});
