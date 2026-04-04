import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { KnowledgeDB } from "../db.js";

let db: KnowledgeDB;

beforeEach(() => {
  db = new KnowledgeDB(":memory:");
});

describe("KnowledgeDB", () => {
  it("creates schema without error", () => {
    expect(db).toBeTruthy();
  });

  it("inserts and retrieves a document", () => {
    db.upsertDocument({ id: "doc-1", path: "thoughts/shared/research/doc-1.md", title: "Test Doc", date: "2026-03-08", type: "research", status: "draft", githubIssue: 100, content: "Some content about caching" });
    const doc = db.getDocument("doc-1");
    expect(doc).toBeTruthy();
    expect(doc!.title).toBe("Test Doc");
    expect(doc!.type).toBe("research");
  });

  it("inserts and retrieves tags", () => {
    db.upsertDocument({ id: "doc-1", path: "p", title: "t", date: null, type: null, status: null, githubIssue: null, content: "" });
    db.setTags("doc-1", ["caching", "performance"]);
    expect(db.getTags("doc-1")).toEqual(["caching", "performance"]);
  });

  it("replaces tags on re-set", () => {
    db.upsertDocument({ id: "doc-1", path: "p", title: "t", date: null, type: null, status: null, githubIssue: null, content: "" });
    db.setTags("doc-1", ["old-tag"]);
    db.setTags("doc-1", ["new-tag"]);
    expect(db.getTags("doc-1")).toEqual(["new-tag"]);
  });

  it("inserts and retrieves relationships", () => {
    db.upsertDocument({ id: "doc-a", path: "a", title: "A", date: null, type: null, status: null, githubIssue: null, content: "" });
    db.upsertDocument({ id: "doc-b", path: "b", title: "B", date: null, type: null, status: null, githubIssue: null, content: "" });
    db.addRelationship("doc-a", "doc-b", "builds_on");
    const outgoing = db.getRelationshipsFrom("doc-a");
    expect(outgoing).toHaveLength(1);
    expect(outgoing[0]).toMatchObject({ sourceId: "doc-a", targetId: "doc-b", type: "builds_on", context: null });
    expect(db.getRelationshipsTo("doc-b")).toHaveLength(1);
  });

  it("clears all data for rebuild", () => {
    db.upsertDocument({ id: "doc-1", path: "p", title: "t", date: null, type: null, status: null, githubIssue: null, content: "" });
    db.clearAll();
    expect(db.getDocument("doc-1")).toBeUndefined();
  });

  it("addRelationship with type 'untyped' succeeds (not rejected by CHECK)", () => {
    db.upsertDocument({ id: "src", path: "a", title: "A", date: null, type: null, status: null, githubIssue: null, content: "" });
    db.upsertDocument({ id: "tgt", path: "b", title: "B", date: null, type: null, status: null, githubIssue: null, content: "" });
    expect(() => db.addRelationship("src", "tgt", "untyped")).not.toThrow();
    const rows = db.getRelationshipsFrom("src");
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("untyped");
  });

  it("addRelationship with type 'post_mortem' succeeds (bug fix verified)", () => {
    db.upsertDocument({ id: "src", path: "a", title: "A", date: null, type: null, status: null, githubIssue: null, content: "" });
    db.upsertDocument({ id: "tgt", path: "b", title: "B", date: null, type: null, status: null, githubIssue: null, content: "" });
    expect(() => db.addRelationship("src", "tgt", "post_mortem")).not.toThrow();
    const rows = db.getRelationshipsFrom("src");
    expect(rows[0].type).toBe("post_mortem");
  });

  it("addRelationship with context parameter stores and retrieves context", () => {
    db.upsertDocument({ id: "src", path: "a", title: "A", date: null, type: null, status: null, githubIssue: null, content: "" });
    db.upsertDocument({ id: "tgt", path: "b", title: "B", date: null, type: null, status: null, githubIssue: null, content: "" });
    db.addRelationship("src", "tgt", "untyped", "This is the paragraph context.");
    const rows = db.getRelationshipsFrom("src");
    expect(rows[0].context).toBe("This is the paragraph context.");
  });

  it("addRelationship without context parameter stores NULL context", () => {
    db.upsertDocument({ id: "src", path: "a", title: "A", date: null, type: null, status: null, githubIssue: null, content: "" });
    db.upsertDocument({ id: "tgt", path: "b", title: "B", date: null, type: null, status: null, githubIssue: null, content: "" });
    db.addRelationship("src", "tgt", "builds_on");
    const rows = db.getRelationshipsFrom("src");
    expect(rows[0].context).toBeNull();
  });

  it("upsertStubDocument creates a document with is_stub=1, path=null, title=id", () => {
    db.upsertStubDocument("stub-target-id");
    const doc = db.getDocument("stub-target-id");
    expect(doc).toBeTruthy();
    expect(doc!.isStub).toBe(1);
    expect(doc!.path).toBeNull();
    expect(doc!.title).toBe("stub-target-id");
  });

  it("upsertStubDocument does not overwrite an existing real document", () => {
    db.upsertDocument({ id: "real-doc", path: "real/path.md", title: "Real Title", date: "2026-01-01", type: "research", status: "draft", githubIssue: null, content: "real content" });
    db.upsertStubDocument("real-doc");
    const doc = db.getDocument("real-doc");
    expect(doc!.isStub).toBe(0);
    expect(doc!.path).toBe("real/path.md");
    expect(doc!.title).toBe("Real Title");
  });

  it("clearAll removes stub documents along with regular documents", () => {
    db.upsertDocument({ id: "real-doc", path: "p", title: "t", date: null, type: null, status: null, githubIssue: null, content: "" });
    db.upsertStubDocument("stub-target");
    db.clearAll();
    expect(db.getDocument("real-doc")).toBeUndefined();
    expect(db.getDocument("stub-target")).toBeUndefined();
  });
});

describe("Outcome Events", () => {
  it("inserts and retrieves an outcome event", () => {
    const result = db.insertOutcomeEvent({
      eventType: "task_complete",
      issueNumber: 42,
      sessionId: "sess-1",
      durationMs: 5000,
      verdict: "success",
      componentArea: "api/auth",
      estimate: "S",
      driftCount: 1,
      model: "opus-4",
      agentType: "coder",
      iterationCount: 3,
      payload: { notes: "all good" },
    });

    expect(result.id).toBeTruthy();
    expect(result.eventType).toBe("task_complete");
    expect(result.issueNumber).toBe(42);
    expect(result.timestamp).toBeTruthy();

    const rows = db.queryOutcomeEvents({ issueNumber: 42 });
    expect(rows).toHaveLength(1);
    expect(rows[0].eventType).toBe("task_complete");
    expect(rows[0].sessionId).toBe("sess-1");
    expect(rows[0].durationMs).toBe(5000);
    expect(rows[0].verdict).toBe("success");
    expect(rows[0].componentArea).toBe("api/auth");
    expect(rows[0].estimate).toBe("S");
    expect(rows[0].driftCount).toBe(1);
    expect(rows[0].model).toBe("opus-4");
    expect(rows[0].agentType).toBe("coder");
    expect(rows[0].iterationCount).toBe(3);
    expect(JSON.parse(rows[0].payload)).toEqual({ notes: "all good" });
  });

  it("filters by event_type and component_area", () => {
    db.insertOutcomeEvent({ eventType: "task_complete", issueNumber: 1, componentArea: "api/auth" });
    db.insertOutcomeEvent({ eventType: "drift", issueNumber: 2, componentArea: "api/billing" });
    db.insertOutcomeEvent({ eventType: "task_complete", issueNumber: 3, componentArea: "ui/dashboard" });

    const byType = db.queryOutcomeEvents({ eventType: "task_complete" });
    expect(byType).toHaveLength(2);

    // component_area uses LIKE prefix match
    const byComponent = db.queryOutcomeEvents({ componentArea: "api" });
    expect(byComponent).toHaveLength(2);

    const combined = db.queryOutcomeEvents({ eventType: "task_complete", componentArea: "api" });
    expect(combined).toHaveLength(1);
    expect(combined[0].issueNumber).toBe(1);
  });

  it("filters by since date", () => {
    // Insert events, then query with a since filter
    db.insertOutcomeEvent({ eventType: "task_complete", issueNumber: 1 });

    // Query with a future date should return nothing
    const futureRows = db.queryOutcomeEvents({ since: "2099-01-01T00:00:00.000Z" });
    expect(futureRows).toHaveLength(0);

    // Query with a past date should return the event
    const pastRows = db.queryOutcomeEvents({ since: "2000-01-01T00:00:00.000Z" });
    expect(pastRows).toHaveLength(1);
  });

  it("filters by verdict and estimate", () => {
    db.insertOutcomeEvent({ eventType: "task_complete", issueNumber: 1, verdict: "success", estimate: "S" });
    db.insertOutcomeEvent({ eventType: "task_complete", issueNumber: 2, verdict: "blocked", estimate: "M" });
    db.insertOutcomeEvent({ eventType: "task_complete", issueNumber: 3, verdict: "success", estimate: "M" });

    const byVerdict = db.queryOutcomeEvents({ verdict: "blocked" });
    expect(byVerdict).toHaveLength(1);
    expect(byVerdict[0].issueNumber).toBe(2);

    const byEstimate = db.queryOutcomeEvents({ estimate: "M" });
    expect(byEstimate).toHaveLength(2);
  });

  it("respects limit parameter", () => {
    for (let i = 0; i < 10; i++) {
      db.insertOutcomeEvent({ eventType: "task_complete", issueNumber: i });
    }

    const limited = db.queryOutcomeEvents({ limit: 3 });
    expect(limited).toHaveLength(3);
  });

  it("returns most recent first", () => {
    // Insert with explicit timestamps via direct SQL to control ordering
    const ids = ["a", "b", "c"];
    for (let i = 0; i < 3; i++) {
      db.db.prepare(`
        INSERT INTO outcome_events (id, event_type, issue_number, timestamp, payload)
        VALUES (?, 'task_complete', 1, ?, '{}')
      `).run(ids[i], `2026-03-0${i + 1}T00:00:00.000Z`);
    }

    const rows = db.queryOutcomeEvents({ issueNumber: 1 });
    expect(rows).toHaveLength(3);
    expect(rows[0].id).toBe("c"); // March 3rd — most recent
    expect(rows[2].id).toBe("a"); // March 1st — oldest
  });

  it("computes aggregation", () => {
    db.insertOutcomeEvent({ eventType: "task_complete", issueNumber: 1, verdict: "success", componentArea: "api/auth", driftCount: 2, iterationCount: 5 });
    db.insertOutcomeEvent({ eventType: "drift", issueNumber: 2, verdict: "blocked", componentArea: "api/auth", driftCount: 4, iterationCount: 3 });
    db.insertOutcomeEvent({ eventType: "task_complete", issueNumber: 3, verdict: "success", componentArea: "ui/dashboard", driftCount: 0, iterationCount: 1 });

    const agg = db.aggregateOutcomeEvents();
    expect(agg.count).toBe(3);
    expect(agg.avgDriftCount).toBe(2); // (2+4+0)/3
    expect(agg.avgIterationCount).toBe(3); // (5+3+1)/3
    expect(agg.verdictDistribution).toEqual({ success: 2, blocked: 1 });
    expect(agg.eventTypeDistribution).toEqual({ task_complete: 2, drift: 1 });
    expect(agg.topComponentAreas).toHaveLength(2);
    expect(agg.topComponentAreas[0]).toEqual({ area: "api/auth", count: 2 });
  });

  it("returns outcome summary for an issue", () => {
    // Use direct SQL inserts with explicit timestamps to ensure deterministic ordering
    db.db.prepare(`
      INSERT INTO outcome_events (id, event_type, issue_number, timestamp, drift_count, payload)
      VALUES (?, 'task_start', 42, '2026-03-01T00:00:00.000Z', 1, '{}')
    `).run("oe-1");
    db.db.prepare(`
      INSERT INTO outcome_events (id, event_type, issue_number, timestamp, drift_count, payload)
      VALUES (?, 'blocker_recorded', 42, '2026-03-02T00:00:00.000Z', 2, '{}')
    `).run("oe-2");
    db.db.prepare(`
      INSERT INTO outcome_events (id, event_type, issue_number, timestamp, verdict, drift_count, payload)
      VALUES (?, 'task_complete', 42, '2026-03-03T00:00:00.000Z', 'success', 0, '{}')
    `).run("oe-3");

    const summary = db.getOutcomeSummary(42);
    expect(summary).not.toBeNull();
    expect(summary!.totalEvents).toBe(3);
    expect(summary!.latestVerdict).toBe("success"); // most recent with a verdict
    expect(summary!.driftCount).toBe(3); // 1+2+0
    expect(summary!.blockers).toBe(1); // blocker_recorded event type
    expect(summary!.eventsByType).toEqual({ task_start: 1, blocker_recorded: 1, task_complete: 1 });
  });

  it("returns null summary for missing issue", () => {
    const summary = db.getOutcomeSummary(9999);
    expect(summary).toBeNull();
  });

  it("clearAll preserves outcome events", () => {
    db.insertOutcomeEvent({ eventType: "task_complete", issueNumber: 1 });
    db.upsertDocument({ id: "doc-1", path: "p", title: "t", date: null, type: null, status: null, githubIssue: null, content: "" });

    db.clearAll();

    expect(db.getDocument("doc-1")).toBeUndefined();
    const rows = db.queryOutcomeEvents({ issueNumber: 1 });
    expect(rows).toHaveLength(1);
  });
});

describe("Sync Table", () => {
  it("inserts and retrieves a sync record", () => {
    db.upsertSyncRecord("/path/to/file.md", 1711234567890);
    const record = db.getSyncRecord("/path/to/file.md");
    expect(record).toBeTruthy();
    expect(record!.path).toBe("/path/to/file.md");
    expect(record!.mtime).toBe(1711234567890);
    expect(record!.indexed_at).toBeGreaterThan(0);
  });

  it("returns undefined for absent sync record", () => {
    const record = db.getSyncRecord("/nonexistent.md");
    expect(record).toBeUndefined();
  });

  it("updates mtime and indexed_at via upsert", () => {
    db.upsertSyncRecord("/path/to/file.md", 1000);
    const first = db.getSyncRecord("/path/to/file.md");
    expect(first!.mtime).toBe(1000);

    // Small delay to ensure indexed_at differs
    db.upsertSyncRecord("/path/to/file.md", 2000);
    const second = db.getSyncRecord("/path/to/file.md");
    expect(second!.mtime).toBe(2000);
    expect(second!.indexed_at).toBeGreaterThanOrEqual(first!.indexed_at);
  });

  it("getAllSyncPaths returns all stored paths", () => {
    db.upsertSyncRecord("/a.md", 100);
    db.upsertSyncRecord("/b.md", 200);
    db.upsertSyncRecord("/c.md", 300);
    const paths = db.getAllSyncPaths();
    expect(paths).toHaveLength(3);
    expect(paths.sort()).toEqual(["/a.md", "/b.md", "/c.md"]);
  });

  it("getAllSyncPaths returns empty array when table is empty", () => {
    const paths = db.getAllSyncPaths();
    expect(paths).toEqual([]);
  });

  it("deleteSyncRecord removes the record", () => {
    db.upsertSyncRecord("/path/to/file.md", 1000);
    db.deleteSyncRecord("/path/to/file.md");
    expect(db.getSyncRecord("/path/to/file.md")).toBeUndefined();
  });

  it("clearAll clears sync table", () => {
    db.upsertSyncRecord("/a.md", 100);
    db.upsertSyncRecord("/b.md", 200);
    db.clearAll();
    expect(db.getAllSyncPaths()).toEqual([]);
  });

  it("clearAll still preserves outcome events after sync addition", () => {
    db.insertOutcomeEvent({ eventType: "task_complete", issueNumber: 1 });
    db.upsertSyncRecord("/a.md", 100);
    db.clearAll();
    const rows = db.queryOutcomeEvents({ issueNumber: 1 });
    expect(rows).toHaveLength(1);
    expect(db.getAllSyncPaths()).toEqual([]);
  });
});

describe("deleteDocument", () => {
  it("deletes a document by id", () => {
    db.upsertDocument({ id: "doc-1", path: "p", title: "t", date: null, type: null, status: null, githubIssue: null, content: "" });
    db.deleteDocument("doc-1");
    expect(db.getDocument("doc-1")).toBeUndefined();
  });

  it("cascades deletion to tags and relationships", () => {
    db.upsertDocument({ id: "doc-a", path: "a", title: "A", date: null, type: null, status: null, githubIssue: null, content: "" });
    db.upsertDocument({ id: "doc-b", path: "b", title: "B", date: null, type: null, status: null, githubIssue: null, content: "" });
    db.setTags("doc-a", ["tag1", "tag2"]);
    db.addRelationship("doc-a", "doc-b", "builds_on");

    db.deleteDocument("doc-a");

    expect(db.getDocument("doc-a")).toBeUndefined();
    expect(db.getTags("doc-a")).toEqual([]);
    expect(db.getRelationshipsFrom("doc-a")).toEqual([]);
  });
});

describe("Schema migration: is_stub column", () => {
  it("adds is_stub column to a database created without it", () => {
    const dir = mkdtempSync(join(tmpdir(), "knowledge-migration-"));
    const dbPath = join(dir, "legacy.db");

    // Create a DB with the old schema (no is_stub column)
    const rawDb = new Database(dbPath);
    rawDb.exec(`
      CREATE TABLE documents (
        id TEXT PRIMARY KEY,
        path TEXT,
        title TEXT,
        date TEXT,
        type TEXT,
        status TEXT,
        github_issue INTEGER,
        content TEXT
      );
    `);
    rawDb.close();

    // Opening via KnowledgeDB should migrate the schema
    const migrated = new KnowledgeDB(dbPath);
    expect(() => migrated.upsertStubDocument("stub-1")).not.toThrow();
    const doc = migrated.getDocument("stub-1");
    expect(doc).toBeTruthy();
    expect(doc!.isStub).toBe(1);
    migrated.close();
  });

  it("is idempotent on a database that already has is_stub", () => {
    const dir = mkdtempSync(join(tmpdir(), "knowledge-migration-"));
    const dbPath = join(dir, "current.db");

    // First open creates the full schema including is_stub
    const db1 = new KnowledgeDB(dbPath);
    db1.upsertStubDocument("stub-1");
    db1.close();

    // Second open should not error (migration is a no-op)
    const db2 = new KnowledgeDB(dbPath);
    const doc = db2.getDocument("stub-1");
    expect(doc).toBeTruthy();
    expect(doc!.isStub).toBe(1);
    db2.close();
  });
});

describe("Schema migration: relationships table rebuild", () => {
  it("rebuilds old schema, preserves data, and enables new features", () => {
    const dir = mkdtempSync(join(tmpdir(), "knowledge-rel-migration-"));
    const dbPath = join(dir, "legacy.db");

    // Create a DB with the old relationships schema (no context, narrow CHECK, no target_id FK)
    const rawDb = new Database(dbPath);
    rawDb.exec(`
      CREATE TABLE documents (
        id TEXT PRIMARY KEY, path TEXT, title TEXT, date TEXT, type TEXT,
        status TEXT, github_issue INTEGER, content TEXT, is_stub INTEGER DEFAULT 0
      );
      CREATE TABLE tags (doc_id TEXT REFERENCES documents(id) ON DELETE CASCADE, tag TEXT, PRIMARY KEY (doc_id, tag));
      CREATE TABLE relationships (
        source_id TEXT REFERENCES documents(id) ON DELETE CASCADE,
        target_id TEXT,
        type TEXT CHECK(type IN ('builds_on', 'tensions', 'superseded_by')),
        PRIMARY KEY (source_id, target_id, type)
      );
      CREATE TABLE outcome_events (
        id TEXT PRIMARY KEY, event_type TEXT NOT NULL, issue_number INTEGER NOT NULL,
        session_id TEXT, timestamp TEXT NOT NULL, duration_ms INTEGER, verdict TEXT,
        component_area TEXT, estimate TEXT, drift_count INTEGER, model TEXT,
        agent_type TEXT, iteration_count INTEGER, payload TEXT DEFAULT '{}'
      );
      CREATE TABLE sync (path TEXT PRIMARY KEY, mtime INTEGER NOT NULL, indexed_at INTEGER NOT NULL);
    `);
    // Insert test data
    rawDb.exec(`
      INSERT INTO documents (id, path, title, content) VALUES ('a', 'a.md', 'Doc A', '');
      INSERT INTO documents (id, path, title, content) VALUES ('b', 'b.md', 'Doc B', '');
      INSERT INTO relationships (source_id, target_id, type) VALUES ('a', 'b', 'builds_on');
    `);
    rawDb.close();

    // Opening via KnowledgeDB should migrate the schema
    const migrated = new KnowledgeDB(dbPath);

    // Existing data preserved with context = null
    const rels = migrated.getRelationshipsFrom("a");
    expect(rels).toHaveLength(1);
    expect(rels[0].targetId).toBe("b");
    expect(rels[0].type).toBe("builds_on");
    expect(rels[0].context).toBeNull();

    // New context column is writable
    migrated.addRelationship("b", "a", "tensions", "disagreement on approach");
    const relsBack = migrated.getRelationshipsFrom("b");
    expect(relsBack[0].context).toBe("disagreement on approach");

    // New CHECK types accepted
    expect(() => migrated.addRelationship("a", "b", "post_mortem")).not.toThrow();
    expect(() => migrated.addRelationship("a", "b", "untyped")).not.toThrow();

    migrated.close();
  });

  it("is idempotent on a database that already has the context column", () => {
    const dir = mkdtempSync(join(tmpdir(), "knowledge-rel-migration-"));
    const dbPath = join(dir, "current.db");

    const db1 = new KnowledgeDB(dbPath);
    db1.upsertDocument({ id: "a", path: "a.md", title: "A", date: null, type: null, status: null, githubIssue: null, content: "" });
    db1.upsertDocument({ id: "b", path: "b.md", title: "B", date: null, type: null, status: null, githubIssue: null, content: "" });
    db1.addRelationship("a", "b", "builds_on", "some context");
    db1.close();

    // Second open should not error and data should be intact
    const db2 = new KnowledgeDB(dbPath);
    const rels = db2.getRelationshipsFrom("a");
    expect(rels).toHaveLength(1);
    expect(rels[0].context).toBe("some context");
    db2.close();
  });

  it("traverse works after migration from old schema", async () => {
    const { Traverser } = await import("../traverse.js");
    const dir = mkdtempSync(join(tmpdir(), "knowledge-rel-migration-"));
    const dbPath = join(dir, "legacy.db");

    // Create old-schema DB with test data
    const rawDb = new Database(dbPath);
    rawDb.exec(`
      CREATE TABLE documents (
        id TEXT PRIMARY KEY, path TEXT, title TEXT, date TEXT, type TEXT,
        status TEXT, github_issue INTEGER, content TEXT, is_stub INTEGER DEFAULT 0
      );
      CREATE TABLE tags (doc_id TEXT REFERENCES documents(id) ON DELETE CASCADE, tag TEXT, PRIMARY KEY (doc_id, tag));
      CREATE TABLE relationships (
        source_id TEXT REFERENCES documents(id) ON DELETE CASCADE,
        target_id TEXT,
        type TEXT CHECK(type IN ('builds_on', 'tensions', 'superseded_by')),
        PRIMARY KEY (source_id, target_id, type)
      );
      CREATE TABLE outcome_events (
        id TEXT PRIMARY KEY, event_type TEXT NOT NULL, issue_number INTEGER NOT NULL,
        session_id TEXT, timestamp TEXT NOT NULL, duration_ms INTEGER, verdict TEXT,
        component_area TEXT, estimate TEXT, drift_count INTEGER, model TEXT,
        agent_type TEXT, iteration_count INTEGER, payload TEXT DEFAULT '{}'
      );
      CREATE TABLE sync (path TEXT PRIMARY KEY, mtime INTEGER NOT NULL, indexed_at INTEGER NOT NULL);
      INSERT INTO documents (id, path, title, content) VALUES ('a', 'a.md', 'Doc A', '');
      INSERT INTO documents (id, path, title, content) VALUES ('b', 'b.md', 'Doc B', '');
      INSERT INTO relationships (source_id, target_id, type) VALUES ('a', 'b', 'builds_on');
    `);
    rawDb.close();

    // Open via KnowledgeDB (triggers migration), then traverse
    const migrated = new KnowledgeDB(dbPath);
    const traverser = new Traverser(migrated);

    const results = traverser.traverse("a");
    expect(results).toHaveLength(1);
    expect(results[0].targetId).toBe("b");
    expect(results[0].context).toBeNull();
    expect(results[0].doc?.title).toBe("Doc B");

    migrated.close();
  });
});

describe("documentExists", () => {
  it("returns true for an existing document", () => {
    db.upsertDocument({ id: "doc-1", path: "p", title: "t", date: null, type: null, status: null, githubIssue: null, content: "" });
    expect(db.documentExists("doc-1")).toBe(true);
  });

  it("returns false for a non-existent document", () => {
    expect(db.documentExists("nonexistent")).toBe(false);
  });

  it("returns true for stub documents", () => {
    db.upsertStubDocument("stub-1");
    expect(db.documentExists("stub-1")).toBe(true);
  });
});
