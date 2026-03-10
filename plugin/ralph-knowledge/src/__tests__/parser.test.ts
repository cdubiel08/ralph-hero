import { describe, it, expect } from "vitest";
import { parseDocument } from "../parser.js";

const FULL_DOC = `---
date: 2026-03-08
github_issue: 560
status: draft
type: research
tags: [caching, mcp-server, performance]
---

# GH-560: Response Cache TTL Strategy

## Prior Work

- builds_on:: [[2026-02-28-GH-0460-cache-invalidation-research]]
- builds_on:: [[2026-03-01-GH-0480-session-cache-architecture]]
- tensions:: [[2026-02-25-GH-0390-aggressive-caching-plan]]

## Problem Statement

The current cache has no TTL configuration.
`;

const SUPERSEDED_DOC = `---
date: 2026-02-20
github_issue: 200
status: superseded
type: plan
tags: [caching]
superseded_by: "[[2026-03-08-GH-0560-cache-ttl]]"
---

# GH-200: Old Caching Strategy

Some old content.
`;

const MINIMAL_DOC = `---
date: 2026-03-01
type: idea
---

# A Simple Idea

No prior work section.
`;

describe("parseDocument", () => {
  it("parses frontmatter fields", () => {
    const doc = parseDocument("2026-03-08-GH-0560-cache-ttl", "thoughts/shared/research/2026-03-08-GH-0560-cache-ttl.md", FULL_DOC);
    expect(doc.id).toBe("2026-03-08-GH-0560-cache-ttl");
    expect(doc.path).toBe("thoughts/shared/research/2026-03-08-GH-0560-cache-ttl.md");
    expect(doc.date).toBe("2026-03-08");
    expect(doc.type).toBe("research");
    expect(doc.status).toBe("draft");
    expect(doc.githubIssue).toBe(560);
    expect(doc.tags).toEqual(["caching", "mcp-server", "performance"]);
  });

  it("extracts title from first heading", () => {
    const doc = parseDocument("test", "test.md", FULL_DOC);
    expect(doc.title).toBe("GH-560: Response Cache TTL Strategy");
  });

  it("extracts builds_on relationships from Prior Work", () => {
    const doc = parseDocument("test", "test.md", FULL_DOC);
    const buildsOn = doc.relationships.filter(r => r.type === "builds_on");
    expect(buildsOn).toHaveLength(2);
    expect(buildsOn[0].targetId).toBe("2026-02-28-GH-0460-cache-invalidation-research");
    expect(buildsOn[1].targetId).toBe("2026-03-01-GH-0480-session-cache-architecture");
  });

  it("extracts tensions relationships from Prior Work", () => {
    const doc = parseDocument("test", "test.md", FULL_DOC);
    const tensions = doc.relationships.filter(r => r.type === "tensions");
    expect(tensions).toHaveLength(1);
    expect(tensions[0].targetId).toBe("2026-02-25-GH-0390-aggressive-caching-plan");
  });

  it("extracts superseded_by from frontmatter", () => {
    const doc = parseDocument("test", "test.md", SUPERSEDED_DOC);
    const superseded = doc.relationships.filter(r => r.type === "superseded_by");
    expect(superseded).toHaveLength(1);
    expect(superseded[0].targetId).toBe("2026-03-08-GH-0560-cache-ttl");
  });

  it("handles documents with no Prior Work section", () => {
    const doc = parseDocument("test", "test.md", MINIMAL_DOC);
    expect(doc.relationships).toEqual([]);
    expect(doc.tags).toEqual([]);
    expect(doc.title).toBe("A Simple Idea");
  });

  it("extracts content body for FTS indexing", () => {
    const doc = parseDocument("test", "test.md", FULL_DOC);
    expect(doc.content).toContain("current cache has no TTL");
    expect(doc.content).not.toContain("---");
  });

  describe("githubIssue fallback chain", () => {
    function makeDoc(frontmatter: string, body = "# Test\n\nContent."): string {
      return `---\n${frontmatter}\n---\n\n${body}`;
    }

    it("falls back to github_issues[0] when github_issue is absent", () => {
      const raw = makeDoc("github_issues: [42, 43, 44]");
      const doc = parseDocument("test", "test.md", raw);
      expect(doc.githubIssue).toBe(42);
    });

    it("falls back to primary_issue when both github_issue and github_issues are absent", () => {
      const raw = makeDoc("primary_issue: 42");
      const doc = parseDocument("test", "test.md", raw);
      expect(doc.githubIssue).toBe(42);
    });

    it("prefers github_issue over github_issues and primary_issue", () => {
      const raw = makeDoc("github_issue: 10\ngithub_issues: [20, 30]\nprimary_issue: 40");
      const doc = parseDocument("test", "test.md", raw);
      expect(doc.githubIssue).toBe(10);
    });

    it("prefers github_issues[0] over primary_issue when github_issue is absent", () => {
      const raw = makeDoc("github_issues: [20, 30]\nprimary_issue: 40");
      const doc = parseDocument("test", "test.md", raw);
      expect(doc.githubIssue).toBe(20);
    });

    it("returns null for empty github_issues array with no other fallbacks", () => {
      const raw = makeDoc("github_issues: []");
      const doc = parseDocument("test", "test.md", raw);
      expect(doc.githubIssue).toBeNull();
    });

    it("returns null when primary_issue is null", () => {
      const raw = makeDoc("primary_issue: null");
      const doc = parseDocument("test", "test.md", raw);
      expect(doc.githubIssue).toBeNull();
    });

    it("returns null when no issue fields are present", () => {
      const raw = makeDoc("status: draft\ntype: plan");
      const doc = parseDocument("test", "test.md", raw);
      expect(doc.githubIssue).toBeNull();
    });

    it("returns null when github_issues contains non-number first element", () => {
      const raw = makeDoc('github_issues: ["not-a-number"]');
      const doc = parseDocument("test", "test.md", raw);
      expect(doc.githubIssue).toBeNull();
    });

    it("handles typical group plan frontmatter with all fields", () => {
      const raw = makeDoc([
        "date: 2026-03-09",
        "status: draft",
        "type: plan",
        "github_issue: 550",
        "github_issues: [550, 551, 552]",
        "primary_issue: 550",
        "tags: [knowledge-graph, metadata]",
      ].join("\n"));
      const doc = parseDocument("test-plan", "thoughts/shared/plans/test-plan.md", raw);
      expect(doc.githubIssue).toBe(550);
      expect(doc.type).toBe("plan");
      expect(doc.tags).toEqual(["knowledge-graph", "metadata"]);
    });

    it("handles plan with only github_issues array (no singular)", () => {
      const raw = makeDoc([
        "date: 2026-03-09",
        "status: draft",
        "type: plan",
        "github_issues: [550, 551, 552]",
        "primary_issue: 550",
        "tags: [knowledge-graph]",
      ].join("\n"));
      const doc = parseDocument("test-plan", "thoughts/shared/plans/test-plan.md", raw);
      expect(doc.githubIssue).toBe(550);
    });
  });
});
