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
});
