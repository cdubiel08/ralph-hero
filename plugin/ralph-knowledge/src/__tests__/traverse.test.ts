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
});
