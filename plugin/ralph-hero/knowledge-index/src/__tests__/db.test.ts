import { describe, it, expect, beforeEach } from "vitest";
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
    expect(outgoing[0]).toEqual({ sourceId: "doc-a", targetId: "doc-b", type: "builds_on" });
    expect(db.getRelationshipsTo("doc-b")).toHaveLength(1);
  });

  it("clears all data for rebuild", () => {
    db.upsertDocument({ id: "doc-1", path: "p", title: "t", date: null, type: null, status: null, githubIssue: null, content: "" });
    db.clearAll();
    expect(db.getDocument("doc-1")).toBeUndefined();
  });
});
