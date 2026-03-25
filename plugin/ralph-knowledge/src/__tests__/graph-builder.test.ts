import { describe, it, expect, beforeEach } from "vitest";
import { KnowledgeDB } from "../db.js";
import { GraphBuilder } from "../graph-builder.js";
import type { KnowledgeGraph } from "../graph-builder.js";

let db: KnowledgeDB;
let builder: GraphBuilder;

beforeEach(() => {
  db = new KnowledgeDB(":memory:");

  // 5 documents covering all relationship types in the fixture
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
    content: "Revised plan that builds on implementation plan.",
  });

  db.upsertDocument({
    id: "doc-d",
    path: "thoughts/shared/ideas/doc-d.md",
    title: "Contradicting Idea",
    date: "2026-03-05",
    type: "idea",
    status: "draft",
    githubIssue: null,
    content: "An idea that tensions with the foundation.",
  });

  db.upsertDocument({
    id: "doc-e",
    path: "thoughts/shared/research/doc-e.md",
    title: "Updated Research",
    date: "2026-03-10",
    type: "research",
    status: "complete",
    githubIssue: null,
    content: "Research that supersedes the revised plan.",
  });

  // 4 relationships covering all 3 types
  db.addRelationship("doc-b", "doc-a", "builds_on");
  db.addRelationship("doc-c", "doc-b", "builds_on");
  db.addRelationship("doc-d", "doc-a", "tensions");
  db.addRelationship("doc-e", "doc-c", "superseded_by");

  builder = new GraphBuilder(db);
});

describe("GraphBuilder", () => {
  it("graph has correct node count", () => {
    const graph: KnowledgeGraph = builder.buildGraph();
    expect(graph.order).toBe(5);
  });

  it("graph has correct edge count", () => {
    const graph: KnowledgeGraph = builder.buildGraph();
    expect(graph.size).toBe(4);
  });

  it("node attributes match for doc-a", () => {
    const graph: KnowledgeGraph = builder.buildGraph();
    expect(graph.getNodeAttributes("doc-a")).toEqual({
      title: "Foundation Research",
      type: "research",
      date: "2026-02-01",
      status: "approved",
    });
  });

  it("edge type attribute is correct for doc-b", () => {
    const graph: KnowledgeGraph = builder.buildGraph();
    const edges = graph.outEdges("doc-b");
    expect(edges.length).toBeGreaterThanOrEqual(1);
    const buildsOnEdge = edges.find(
      (e) => graph.getEdgeAttributes(e).type === "builds_on",
    );
    expect(buildsOnEdge).toBeDefined();
  });

  it("parallel edges between same pair work", () => {
    // Add a second relationship between doc-d and doc-a (builds_on alongside tensions)
    db.addRelationship("doc-d", "doc-a", "builds_on");
    const graph: KnowledgeGraph = builder.buildGraph();
    // Both edges should exist between doc-d and doc-a
    const edgesFromD = graph.outEdges("doc-d");
    const edgesToA = edgesFromD.filter((e) => graph.target(e) === "doc-a");
    expect(edgesToA).toHaveLength(2);
  });

  it("empty database produces graph with 0 nodes and 0 edges", () => {
    const emptyDb = new KnowledgeDB(":memory:");
    const emptyBuilder = new GraphBuilder(emptyDb);
    const graph = emptyBuilder.buildGraph();
    expect(graph.order).toBe(0);
    expect(graph.size).toBe(0);
    emptyDb.close();
  });

  it("isolated node is included in graph", () => {
    db.upsertDocument({
      id: "doc-orphan",
      path: "thoughts/shared/ideas/orphan.md",
      title: "Orphan Idea",
      date: "2026-03-15",
      type: "idea",
      status: "draft",
      githubIssue: null,
      content: "An isolated idea with no connections.",
    });
    const graph: KnowledgeGraph = builder.buildGraph();
    expect(graph.hasNode("doc-orphan")).toBe(true);
    expect(graph.degree("doc-orphan")).toBe(0);
  });

  it("graph is directed", () => {
    const graph: KnowledgeGraph = builder.buildGraph();
    expect(graph.type).toBe("directed");
  });

  it("graph is multi", () => {
    const graph: KnowledgeGraph = builder.buildGraph();
    expect(graph.multi).toBe(true);
  });

  it("FK constraint prevents dangling edge target", () => {
    // With ON DELETE CASCADE on target_id, inserting a relationship
    // referencing a non-existent target violates the FK constraint
    expect(() => {
      db.db
        .prepare(
          "INSERT OR IGNORE INTO relationships (source_id, target_id, type) VALUES (?, ?, ?)",
        )
        .run("doc-a", "non-existent-doc", "builds_on");
    }).toThrow(/FOREIGN KEY constraint failed/);
  });

  it("directed edges are directed — source and target are correct", () => {
    const graph: KnowledgeGraph = builder.buildGraph();
    // doc-b builds_on doc-a: doc-b is source, doc-a is target
    const outEdgesFromB = graph.outEdges("doc-b");
    expect(outEdgesFromB.length).toBeGreaterThanOrEqual(1);
    const edgeToA = outEdgesFromB.find((e) => graph.target(e) === "doc-a");
    expect(edgeToA).toBeDefined();
    expect(graph.source(edgeToA!)).toBe("doc-b");
  });
});
