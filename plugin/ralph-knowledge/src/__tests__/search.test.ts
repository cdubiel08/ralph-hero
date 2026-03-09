import { describe, it, expect, beforeEach } from "vitest";
import { KnowledgeDB } from "../db.js";
import { FtsSearch } from "../search.js";

let db: KnowledgeDB;
let fts: FtsSearch;

beforeEach(() => {
  db = new KnowledgeDB(":memory:");

  db.upsertDocument({
    id: "cache-doc",
    path: "thoughts/shared/research/cache-strategies.md",
    title: "Cache Invalidation Strategies",
    date: "2026-03-01",
    type: "research",
    status: "draft",
    githubIssue: null,
    content: "Analysis of cache invalidation patterns including TTL, event-driven, and write-through approaches.",
  });
  db.setTags("cache-doc", ["caching", "performance"]);

  db.upsertDocument({
    id: "auth-doc",
    path: "thoughts/shared/plans/auth-redesign.md",
    title: "Auth Redesign Plan",
    date: "2026-03-02",
    type: "plan",
    status: "approved",
    githubIssue: 42,
    content: "Redesign authentication to use OAuth2 with PKCE flow for improved security.",
  });
  db.setTags("auth-doc", ["auth", "security"]);

  db.upsertDocument({
    id: "cache-old",
    path: "thoughts/shared/plans/old-cache-plan.md",
    title: "Old Cache Plan",
    date: "2026-01-15",
    type: "plan",
    status: "superseded",
    githubIssue: null,
    content: "Original cache implementation plan using Redis with simple TTL expiry.",
  });
  db.setTags("cache-old", ["caching"]);

  fts = new FtsSearch(db);
  fts.rebuildIndex();
});

describe("FtsSearch", () => {
  it("finds documents by keyword", () => {
    const results = fts.search("cache");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].id).toBe("cache-doc");
    expect(results[0].score).toBeLessThan(0);
    expect(results[0].snippet).toBeTruthy();
  });

  it("returns empty for no matches", () => {
    const results = fts.search("nonexistent");
    expect(results).toHaveLength(0);
  });

  it("filters by type", () => {
    const results = fts.search("cache", { type: "plan" });
    expect(results).toHaveLength(0); // cache-old is superseded (excluded), cache-doc is research
  });

  it("filters by tags", () => {
    const results = fts.search("cache OR auth", { tags: ["security"] });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("auth-doc");
  });

  it("excludes superseded by default", () => {
    const results = fts.search("cache");
    const ids = results.map((r) => r.id);
    expect(ids).not.toContain("cache-old");
  });

  it("includes superseded when requested", () => {
    const results = fts.search("cache", { includeSuperseded: true });
    const ids = results.map((r) => r.id);
    expect(ids).toContain("cache-old");
  });

  it("respects limit", () => {
    const results = fts.search("cache", { includeSuperseded: true, limit: 1 });
    expect(results).toHaveLength(1);
  });
});
