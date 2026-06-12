import { describe, it, expect, vi } from "vitest";
import { parseDocument, inferTypeFromPath, extractUntypedWikilinks } from "../parser.js";

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

  it("falls back to empty frontmatter on invalid YAML instead of throwing", () => {
    // Real-world breakage: an unquoted title containing a colon-space is
    // a YAML nested-mapping error. One such doc must not abort indexing.
    const raw = `---
title: GH-410 — Permits API: support comma-separated state_code parameter
date: 2026-05-07
---

# GH-410 Permits API plan

Body text here.
`;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const doc = parseDocument("test", "bad-frontmatter.md", raw);
      // Indexed with body-derived title and forgiving defaults.
      expect(doc.title).toBe("GH-410 Permits API plan");
      expect(doc.date).toBeNull();
      expect(doc.tags).toEqual([]);
      expect(doc.memoryTier).toBe("doc");
      expect(doc.content).toContain("Body text here.");
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("bad-frontmatter.md"),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("parses post_mortem relationship from Prior Work", () => {
    const raw = `---
date: 2026-03-18
type: plan
github_issue: 600
---

# My Plan

## Prior Work

- post_mortem:: [[2026-03-19-ralph-team-GH-600-session]]
`;
    const doc = parseDocument("my-plan", "thoughts/shared/plans/my-plan.md", raw);
    const postMortem = doc.relationships.filter(r => r.type === "post_mortem");
    expect(postMortem).toHaveLength(1);
    expect(postMortem[0].targetId).toBe("2026-03-19-ralph-team-GH-600-session");
    expect(postMortem[0].sourceId).toBe("my-plan");
  });

  it("does not parse post_mortem from frontmatter superseded_by path", () => {
    // superseded_by is handled separately; post_mortem must come from body inline fields
    const raw = `---
date: 2026-03-18
type: plan
superseded_by: "[[2026-03-19-ralph-team-GH-600-session]]"
---

# My Plan
`;
    const doc = parseDocument("my-plan", "thoughts/shared/plans/my-plan.md", raw);
    const postMortem = doc.relationships.filter(r => r.type === "post_mortem");
    expect(postMortem).toHaveLength(0);
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

  describe("githubIssues array", () => {
    function makeDoc(frontmatter: string, body = "# Test\n\nContent."): string {
      return `---\n${frontmatter}\n---\n\n${body}`;
    }

    it("populates githubIssues from github_issues array", () => {
      const raw = makeDoc("github_issues: [100, 200, 300]");
      const doc = parseDocument("test", "test.md", raw);
      expect(doc.githubIssues).toEqual([100, 200, 300]);
    });

    it("filters non-number values from github_issues", () => {
      const raw = makeDoc('github_issues: [100, "bad", 200]');
      const doc = parseDocument("test", "test.md", raw);
      expect(doc.githubIssues).toEqual([100, 200]);
    });

    it("returns empty array when github_issues is absent", () => {
      const raw = makeDoc("github_issue: 42");
      const doc = parseDocument("test", "test.md", raw);
      expect(doc.githubIssues).toEqual([]);
    });

    it("returns empty array when github_issues is not an array", () => {
      const raw = makeDoc("github_issues: 42");
      const doc = parseDocument("test", "test.md", raw);
      expect(doc.githubIssues).toEqual([]);
    });

    it("includes all issues in session post-mortem pattern", () => {
      const raw = makeDoc([
        "github_issue: 611",
        "github_issues: [611, 612]",
      ].join("\n"));
      const doc = parseDocument("test", "test.md", raw);
      expect(doc.githubIssues).toEqual([611, 612]);
      expect(doc.githubIssue).toBe(611); // primary unchanged
    });
  });
});

describe("inferTypeFromPath", () => {
  it("infers plan from /plans/ segment", () => {
    expect(inferTypeFromPath("thoughts/shared/plans/foo.md")).toBe("plan");
  });

  it("infers research from /research/ segment", () => {
    expect(inferTypeFromPath("thoughts/shared/research/foo.md")).toBe("research");
  });

  it("infers report from /reports/ segment", () => {
    expect(inferTypeFromPath("thoughts/shared/reports/foo.md")).toBe("report");
  });

  it("infers idea from /ideas/ segment", () => {
    expect(inferTypeFromPath("thoughts/ideas/foo.md")).toBe("idea");
  });

  it("returns null for unknown path", () => {
    expect(inferTypeFromPath("thoughts/misc/foo.md")).toBeNull();
  });
});

describe("parseDocument type inference", () => {
  const NO_TYPE_DOC = `---
date: 2026-03-01
status: draft
---

# My Plan
`;

  const SPEC_DOC = `---
date: 2026-02-21
status: draft
type: spec
---

# Debug Mode Spec
`;

  it("infers type from path when frontmatter type is absent", () => {
    const doc = parseDocument("my-plan", "thoughts/shared/plans/my-plan.md", NO_TYPE_DOC);
    expect(doc.type).toBe("plan");
  });

  it("preserves frontmatter type: spec without aliasing", () => {
    const doc = parseDocument("debug-spec", "thoughts/shared/plans/debug-spec.md", SPEC_DOC);
    expect(doc.type).toBe("spec");
  });

  it("frontmatter type takes priority over path inference", () => {
    // file is in /plans/ but has type: research in frontmatter
    const raw = `---\ndate: 2026-03-01\ntype: research\n---\n\n# Research in plans dir\n`;
    const doc = parseDocument("x", "thoughts/shared/plans/x.md", raw);
    expect(doc.type).toBe("research");
  });

  it("returns null when path gives no hint and type is absent", () => {
    const raw = `---\ndate: 2026-03-01\n---\n\n# Mystery\n`;
    const doc = parseDocument("x", "thoughts/misc/x.md", raw);
    expect(doc.type).toBeNull();
  });
});

describe("extractUntypedWikilinks", () => {
  it("extracts a wikilink from a simple paragraph", () => {
    const body = "Some text referencing [[target-doc]] here.";
    const edges = extractUntypedWikilinks("source-id", body, new Set());
    expect(edges).toHaveLength(1);
    expect(edges[0].sourceId).toBe("source-id");
    expect(edges[0].targetId).toBe("target-doc");
    expect(edges[0].context).toBe("Some text referencing [[target-doc]] here.");
  });

  it("returns context as trimmed paragraph text", () => {
    const body = "\n  Paragraph with [[link-a]] inside.  \n";
    const edges = extractUntypedWikilinks("src", body, new Set());
    expect(edges[0].context).toBe("Paragraph with [[link-a]] inside.");
  });

  it("multiple wikilinks in one paragraph each produce an edge with the same context", () => {
    const body = "See [[doc-a]] and also [[doc-b]] for more.";
    const edges = extractUntypedWikilinks("src", body, new Set());
    expect(edges).toHaveLength(2);
    expect(edges[0].context).toBe(body);
    expect(edges[1].context).toBe(body);
  });

  it("skips wikilinks inside fenced code blocks", () => {
    const body = "Normal text.\n\n```\n[[should-be-skipped]]\n```\n\nMore text.";
    const edges = extractUntypedWikilinks("src", body, new Set());
    expect(edges).toHaveLength(0);
  });

  it("skips wikilinks whose target is in the typedTargets set", () => {
    const body = "See [[typed-target]] and also [[untyped-target]].";
    const edges = extractUntypedWikilinks("src", body, new Set(["typed-target"]));
    expect(edges).toHaveLength(1);
    expect(edges[0].targetId).toBe("untyped-target");
  });

  it("deduplicates targets within the same paragraph", () => {
    const body = "Mentions [[doc-a]] twice: see [[doc-a]] again.";
    const edges = extractUntypedWikilinks("src", body, new Set());
    expect(edges).toHaveLength(1);
    expect(edges[0].targetId).toBe("doc-a");
  });

  it("handles multiple paragraphs independently", () => {
    const body = "Para one mentions [[doc-a]].\n\nPara two also mentions [[doc-a]].";
    const edges = extractUntypedWikilinks("src", body, new Set());
    // doc-a appears in two separate paragraphs — each paragraph gets its own edge
    expect(edges).toHaveLength(2);
    expect(edges[0].context).toBe("Para one mentions [[doc-a]].");
    expect(edges[1].context).toBe("Para two also mentions [[doc-a]].");
  });

  it("returns empty array when body has no wikilinks", () => {
    const body = "No links here at all.";
    const edges = extractUntypedWikilinks("src", body, new Set());
    expect(edges).toHaveLength(0);
  });
});

describe("parseDocument untyped edges", () => {
  it("populates untypedEdges array with correct sourceId, targetId, and context", () => {
    const raw = `---
date: 2026-03-01
type: research
---

# My Research

This references [[some-other-doc]] in the body.
`;
    const doc = parseDocument("my-research", "thoughts/shared/research/my-research.md", raw);
    expect(doc.untypedEdges).toHaveLength(1);
    expect(doc.untypedEdges[0].sourceId).toBe("my-research");
    expect(doc.untypedEdges[0].targetId).toBe("some-other-doc");
    expect(doc.untypedEdges[0].context).toContain("some-other-doc");
  });

  it("returns empty untypedEdges array when no untyped wikilinks exist", () => {
    const raw = `---
date: 2026-03-01
type: research
---

# Clean Doc

No wikilinks here.
`;
    const doc = parseDocument("clean-doc", "thoughts/shared/research/clean-doc.md", raw);
    expect(doc.untypedEdges).toEqual([]);
  });

  it("does not include typed wikilink targets in untypedEdges", () => {
    const raw = `---
date: 2026-03-01
type: plan
---

# My Plan

## Prior Work

- builds_on:: [[typed-target]]

Some prose that also mentions [[typed-target]] and [[untyped-target]].
`;
    const doc = parseDocument("my-plan", "thoughts/shared/plans/my-plan.md", raw);
    const untypedTargets = doc.untypedEdges.map(e => e.targetId);
    expect(untypedTargets).not.toContain("typed-target");
    expect(untypedTargets).toContain("untyped-target");
  });
});

describe("parseDocument memory_tier", () => {
  function makeDoc(frontmatter: string, body = "# Test\n\nContent."): string {
    return `---\n${frontmatter}\n---\n\n${body}`;
  }

  it("extracts memory_tier: raw from frontmatter", () => {
    const raw = makeDoc("date: 2026-04-29\ntype: research\nmemory_tier: raw");
    const doc = parseDocument("test-raw", "thoughts/dream-memories/test-raw.md", raw);
    expect(doc.memoryTier).toBe("raw");
  });

  it("extracts memory_tier: reflection from frontmatter", () => {
    const raw = makeDoc("date: 2026-04-29\ntype: research\nmemory_tier: reflection");
    const doc = parseDocument("test-reflection", "thoughts/dream-memories/reflections/test-reflection.md", raw);
    expect(doc.memoryTier).toBe("reflection");
  });

  it("extracts memory_tier: doc from frontmatter", () => {
    const raw = makeDoc("date: 2026-04-29\ntype: research\nmemory_tier: doc");
    const doc = parseDocument("test-doc", "thoughts/shared/research/test-doc.md", raw);
    expect(doc.memoryTier).toBe("doc");
  });

  it("extracts memory_tier: wiki from frontmatter", () => {
    const raw = makeDoc("date: 2026-05-08\ntype: wiki\nmemory_tier: wiki");
    const doc = parseDocument("test-wiki", "thoughts/wiki/test-wiki.md", raw);
    expect(doc.memoryTier).toBe("wiki");
  });

  it("defaults memory_tier to 'doc' when frontmatter omits the key", () => {
    const raw = makeDoc("date: 2026-04-29\ntype: research");
    const doc = parseDocument("test-default", "thoughts/shared/research/test-default.md", raw);
    expect(doc.memoryTier).toBe("doc");
  });

  it("coerces invalid memory_tier to 'doc' and warns once", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const raw = makeDoc("date: 2026-04-29\ntype: research\nmemory_tier: garbage");
      const doc = parseDocument("test-bad", "thoughts/shared/research/test-bad.md", raw);
      expect(doc.memoryTier).toBe("doc");

      const tierWarnings = warnSpy.mock.calls.filter(args =>
        args.some(a => typeof a === "string" && /memory_tier 'garbage' on 'test-bad'/.test(a)),
      );
      expect(tierWarnings).toHaveLength(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("defaults to 'doc' when memory_tier is null in frontmatter", () => {
    const raw = makeDoc("date: 2026-04-29\ntype: research\nmemory_tier: null");
    const doc = parseDocument("test-null", "thoughts/shared/research/test-null.md", raw);
    expect(doc.memoryTier).toBe("doc");
  });
});
