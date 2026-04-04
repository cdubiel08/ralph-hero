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

  describe("deleteFtsEntry", () => {
    it("removes document from FTS results", () => {
      // Verify the document is searchable before deletion
      const before = fts.search("authentication");
      expect(before.some(r => r.id === "auth-doc")).toBe(true);

      // Delete FTS entry (must happen before document deletion)
      fts.deleteFtsEntry("auth-doc");

      // Document should no longer appear in FTS results
      const after = fts.search("authentication");
      expect(after.some(r => r.id === "auth-doc")).toBe(false);
    });

    it("is a no-op for non-existent document", () => {
      // Should not throw
      fts.deleteFtsEntry("nonexistent-id");
    });
  });

  describe("upsertFtsEntry", () => {
    it("makes a new document searchable via FTS", () => {
      // Insert a new document into the documents table
      db.upsertDocument({
        id: "new-doc",
        path: "thoughts/shared/research/new-topic.md",
        title: "New Topic Research",
        date: "2026-04-01",
        type: "research",
        status: "draft",
        githubIssue: null,
        content: "Exploring quantum computing patterns for distributed systems.",
      });

      // Not searchable yet (no FTS entry)
      const before = fts.search("quantum");
      expect(before.some(r => r.id === "new-doc")).toBe(false);

      // Add FTS entry
      fts.upsertFtsEntry("new-doc");

      // Now searchable
      const after = fts.search("quantum");
      expect(after.some(r => r.id === "new-doc")).toBe(true);
    });

    it("is a no-op for non-existent document", () => {
      // Should not throw
      fts.upsertFtsEntry("nonexistent-id");
    });
  });

  describe("delete and re-insert cycle", () => {
    it("document is still searchable after delete-then-upsert cycle", () => {
      // Verify searchable initially
      const initial = fts.search("cache invalidation");
      expect(initial.some(r => r.id === "cache-doc")).toBe(true);

      // Delete FTS entry, update document, re-insert FTS entry
      fts.deleteFtsEntry("cache-doc");
      db.upsertDocument({
        id: "cache-doc",
        path: "thoughts/shared/research/cache-strategies.md",
        title: "Cache Invalidation Strategies Updated",
        date: "2026-03-01",
        type: "research",
        status: "draft",
        githubIssue: null,
        content: "Updated analysis of cache invalidation patterns with new LRU strategies.",
      });
      fts.upsertFtsEntry("cache-doc");

      // Should be searchable with old terms
      const afterOld = fts.search("cache invalidation");
      expect(afterOld.some(r => r.id === "cache-doc")).toBe(true);

      // Should be searchable with new terms
      const afterNew = fts.search("LRU");
      expect(afterNew.some(r => r.id === "cache-doc")).toBe(true);
    });
  });

  describe("ensureTable", () => {
    it("creates FTS table if it does not exist", () => {
      // Create a fresh DB without FTS table
      const freshDb = new KnowledgeDB(":memory:");
      freshDb.upsertDocument({
        id: "test-doc",
        path: "test.md",
        title: "Test Document",
        date: "2026-04-01",
        type: "research",
        status: "draft",
        githubIssue: null,
        content: "Test content for FTS.",
      });

      const freshFts = new FtsSearch(freshDb);

      // ensureTable should create the table without error
      freshFts.ensureTable();

      // Now per-document operations should work
      freshFts.upsertFtsEntry("test-doc");
      const results = freshFts.search("test");
      expect(results.some(r => r.id === "test-doc")).toBe(true);
    });

    it("is idempotent when table already exists", () => {
      // Table already exists from rebuildIndex in beforeEach
      // Calling ensureTable should be a no-op
      fts.ensureTable();

      // Existing data should still be searchable
      const results = fts.search("cache");
      expect(results.length).toBeGreaterThanOrEqual(1);
    });
  });
});
