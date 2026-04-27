import { describe, it, expect, beforeEach } from "vitest";
import { KnowledgeDB } from "../db.js";
import { Traverser } from "../traverse.js";

let db: KnowledgeDB;
let traverser: Traverser;

beforeEach(() => {
  db = new KnowledgeDB(":memory:");

  // Chain: doc-c builds_on doc-b builds_on doc-a
  // Plus: doc-c tensions doc-a
  db.upsertDocument({
    id: "doc-a",
    path: "thoughts/shared/research/doc-a.md",
    title: "Foundation Research",
    date: "2026-02-01",
    type: "research",
    status: "approved",
    githubIssue: null,
    content: "Foundational research document.",
  });

  db.upsertDocument({
    id: "doc-b",
    path: "thoughts/shared/plans/doc-b.md",
    title: "Implementation Plan",
    date: "2026-02-15",
    type: "plan",
    status: "draft",
    githubIssue: 10,
    content: "Plan that builds on foundation.",
  });

  db.upsertDocument({
    id: "doc-c",
    path: "thoughts/shared/plans/doc-c.md",
    title: "Revised Plan",
    date: "2026-03-01",
    type: "plan",
    status: "draft",
    githubIssue: 20,
    content: "Revised plan that builds on implementation and tensions with foundation.",
  });

  db.addRelationship("doc-b", "doc-a", "builds_on");
  db.addRelationship("doc-c", "doc-b", "builds_on");
  db.addRelationship("doc-c", "doc-a", "tensions");

  traverser = new Traverser(db);
});

describe("Traverser", () => {
  it("finds direct outgoing relationships", () => {
    const results = traverser.traverse("doc-c", { depth: 1 });
    expect(results).toHaveLength(2);
    const targetIds = results.map((r) => r.targetId).sort();
    expect(targetIds).toEqual(["doc-a", "doc-b"]);
  });

  it("walks multi-hop builds_on chain", () => {
    const results = traverser.traverse("doc-c", { type: "builds_on" });
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ sourceId: "doc-c", targetId: "doc-b", depth: 1 });
    expect(results[1]).toMatchObject({ sourceId: "doc-b", targetId: "doc-a", depth: 2 });
  });

  it("respects depth limit", () => {
    const results = traverser.traverse("doc-c", { type: "builds_on", depth: 1 });
    expect(results).toHaveLength(1);
    expect(results[0].targetId).toBe("doc-b");
  });

  it("filters by relationship type", () => {
    const results = traverser.traverse("doc-c", { type: "tensions" });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ sourceId: "doc-c", targetId: "doc-a", type: "tensions" });
  });

  it("finds incoming relationships", () => {
    const results = traverser.traverseIncoming("doc-a");
    // doc-b builds_on doc-a (depth 1), doc-c tensions doc-a (depth 1), doc-c builds_on doc-b (depth 2)
    expect(results.length).toBeGreaterThanOrEqual(2);
    const depth1 = results.filter((r) => r.depth === 1);
    const sourceIds = depth1.map((r) => r.sourceId).sort();
    expect(sourceIds).toEqual(["doc-b", "doc-c"]);
  });

  it("includes document metadata in results", () => {
    const results = traverser.traverse("doc-c", { type: "builds_on", depth: 1 });
    expect(results).toHaveLength(1);
    expect(results[0].doc).toEqual({
      title: "Implementation Plan",
      status: "draft",
      date: "2026-02-15",
    });
  });

  it("returns empty for document with no relationships", () => {
    db.upsertDocument({
      id: "doc-orphan",
      path: "thoughts/shared/ideas/orphan.md",
      title: "Orphan Idea",
      date: "2026-03-05",
      type: "idea",
      status: "draft",
      githubIssue: null,
      content: "An isolated idea with no connections.",
    });
    const outgoing = traverser.traverse("doc-orphan");
    const incoming = traverser.traverseIncoming("doc-orphan");
    expect(outgoing).toHaveLength(0);
    expect(incoming).toHaveLength(0);
  });

  it("results include context field (null for typed relationships)", () => {
    const results = traverser.traverse("doc-c", { type: "builds_on", depth: 1 });
    expect(results).toHaveLength(1);
    expect(results[0]).toHaveProperty("context");
    expect(results[0].context).toBeNull();
  });
});

describe("Traverser — untyped edges", () => {
  let db: KnowledgeDB;
  let traverser: Traverser;

  beforeEach(() => {
    db = new KnowledgeDB(":memory:");

    db.upsertDocument({
      id: "doc-source",
      path: "thoughts/shared/plans/doc-source.md",
      title: "Source Document",
      date: "2026-03-01",
      type: "plan",
      status: "draft",
      githubIssue: null,
      content: "Source doc with untyped links.",
    });

    db.upsertDocument({
      id: "doc-target",
      path: "thoughts/shared/research/doc-target.md",
      title: "Target Document",
      date: "2026-02-01",
      type: "research",
      status: "approved",
      githubIssue: null,
      content: "Target research document.",
    });

    // Stub document for unresolved link
    db.upsertStubDocument("unresolved-target");

    db.addRelationship("doc-source", "doc-target", "untyped", "See [[doc-target]] for background.");
    db.addRelationship("doc-source", "unresolved-target", "untyped", "Also see [[unresolved-target]].");

    traverser = new Traverser(db);
  });

  it("traversing with type 'untyped' returns only untyped edges", () => {
    // Add a typed relationship too
    db.addRelationship("doc-source", "doc-target", "builds_on");
    const results = traverser.traverse("doc-source", { type: "untyped" });
    for (const r of results) {
      expect(r.type).toBe("untyped");
    }
  });

  it("untyped edge results include non-null context field", () => {
    const results = traverser.traverse("doc-source", { type: "untyped", depth: 1 });
    const toTarget = results.find(r => r.targetId === "doc-target");
    expect(toTarget).toBeTruthy();
    expect(toTarget!.context).toBe("See [[doc-target]] for background.");
  });

  it("traversing with no type filter returns both typed and untyped edges", () => {
    db.addRelationship("doc-source", "doc-target", "builds_on");
    const results = traverser.traverse("doc-source", { depth: 1 });
    const types = results.map(r => r.type);
    expect(types).toContain("untyped");
    expect(types).toContain("builds_on");
  });

  it("stub documents are filtered out of traverse results (regression for GH-897)", () => {
    const results = traverser.traverse("doc-source", { type: "untyped", depth: 1 });
    const toStub = results.find(r => r.targetId === "unresolved-target");
    expect(toStub).toBeUndefined();
    // Real-document edges still surface
    const toReal = results.find(r => r.targetId === "doc-target");
    expect(toReal).toBeTruthy();
  });
});

describe("Traverser — stub filtering (GH-897)", () => {
  let db: KnowledgeDB;
  let traverser: Traverser;

  beforeEach(() => {
    db = new KnowledgeDB(":memory:");

    db.upsertDocument({
      id: "real-a",
      path: "thoughts/shared/research/real-a.md",
      title: "Real A",
      date: "2026-04-01",
      type: "research",
      status: "approved",
      githubIssue: null,
      content: "Real document A.",
    });

    db.upsertDocument({
      id: "real-b",
      path: "thoughts/shared/research/real-b.md",
      title: "Real B",
      date: "2026-04-02",
      type: "research",
      status: "approved",
      githubIssue: null,
      content: "Real document B.",
    });

    // Stubs created via both untyped wikilink and typed relationship paths.
    db.upsertStubDocument("stub-untyped-target");
    db.upsertStubDocument("stub-typed-target");

    db.addRelationship("real-a", "stub-untyped-target", "untyped", "context");
    db.addRelationship("real-a", "stub-typed-target", "builds_on");

    // Stub appears as source_id of an edge to a real doc — exercises incoming filter.
    db.addRelationship("stub-untyped-target", "real-b", "untyped");

    traverser = new Traverser(db);
  });

  it("traverse() drops outgoing hops to stub targets (untyped + typed)", () => {
    const results = traverser.traverse("real-a", { depth: 1 });
    expect(results).toHaveLength(0);
    // Sanity: neither stub id appears
    const targetIds = results.map((r) => r.targetId);
    expect(targetIds).not.toContain("stub-untyped-target");
    expect(targetIds).not.toContain("stub-typed-target");
  });

  it("traverse() with type filter still drops stub targets", () => {
    const buildsOn = traverser.traverse("real-a", { type: "builds_on", depth: 1 });
    expect(buildsOn).toHaveLength(0);
    const untyped = traverser.traverse("real-a", { type: "untyped", depth: 1 });
    expect(untyped).toHaveLength(0);
  });

  it("traverseIncoming() returns no rows when only inbound edge is from a stub", () => {
    const results = traverser.traverseIncoming("real-b", { depth: 1 });
    expect(results).toHaveLength(0);
  });

  it("traverseIncoming() on a stub returns only real-source edges, never stub sources", () => {
    // Asking "who points to this stub?" surfaces real callers (real-a here). The
    // join in traverseIncoming is on chain.source_id, so the predicate filters by
    // source-side stub-ness — real sources are preserved, stub sources dropped.
    const results = traverser.traverseIncoming("stub-untyped-target", { depth: 1 });
    expect(results).toHaveLength(1);
    expect(results[0].sourceId).toBe("real-a");
    // None of the rows have a stub document as source.
    for (const r of results) {
      // doc is hydrated from d.title; stubs would have title === sourceId.
      if (r.doc) {
        expect(r.doc.title).not.toBe(r.sourceId);
      }
    }
  });

  it("non-regression: real-only chain still works after the stub filter is applied", () => {
    // Independent fresh DB to verify the canonical fixture still passes through the
    // updated WHERE clause unchanged.
    const fresh = new KnowledgeDB(":memory:");
    fresh.upsertDocument({
      id: "doc-a",
      path: "doc-a.md",
      title: "Foundation",
      date: "2026-02-01",
      type: "research",
      status: "approved",
      githubIssue: null,
      content: "",
    });
    fresh.upsertDocument({
      id: "doc-b",
      path: "doc-b.md",
      title: "Plan",
      date: "2026-02-15",
      type: "plan",
      status: "draft",
      githubIssue: null,
      content: "",
    });
    fresh.upsertDocument({
      id: "doc-c",
      path: "doc-c.md",
      title: "Revised Plan",
      date: "2026-03-01",
      type: "plan",
      status: "draft",
      githubIssue: null,
      content: "",
    });
    fresh.addRelationship("doc-b", "doc-a", "builds_on");
    fresh.addRelationship("doc-c", "doc-b", "builds_on");

    const t = new Traverser(fresh);
    const chain = t.traverse("doc-c", { type: "builds_on" });
    expect(chain).toHaveLength(2);
    expect(chain[0]).toMatchObject({ sourceId: "doc-c", targetId: "doc-b", depth: 1 });
    expect(chain[1]).toMatchObject({ sourceId: "doc-b", targetId: "doc-a", depth: 2 });
    fresh.close();
  });
});
