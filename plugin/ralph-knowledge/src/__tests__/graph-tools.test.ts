import { describe, it, expect, beforeEach } from "vitest";
import { KnowledgeDB } from "../db.js";
import { registerGraphTools } from "../graph-tools.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

let db: KnowledgeDB;
let server: McpServer;

/**
 * Helper to call a registered MCP tool by name.
 * McpServer stores handlers as a plain object at _registeredTools.
 */
async function callTool(
  toolServer: McpServer,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const registeredTools = (toolServer as unknown as Record<string, unknown>)
    ._registeredTools as Record<
    string,
    { handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown> }
  >;
  const tool = registeredTools?.[name];
  if (!tool) {
    throw new Error(`Tool "${name}" not registered`);
  }
  return tool.handler(args, {}) as Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

function setupFixtureDocs(testDb: KnowledgeDB): void {
  // Doc A and Doc B connected by builds_on
  testDb.upsertDocument({
    id: "doc-a",
    path: "thoughts/shared/research/doc-a.md",
    title: "Foundation Research",
    date: "2026-02-01",
    type: "research",
    status: "approved",
    githubIssue: null,
    content: "Foundational research document.",
  });
  testDb.upsertDocument({
    id: "doc-b",
    path: "thoughts/shared/plans/doc-b.md",
    title: "Implementation Plan",
    date: "2026-02-15",
    type: "plan",
    status: "draft",
    githubIssue: 10,
    content: "Plan that builds on foundation.",
  });
  testDb.addRelationship("doc-b", "doc-a", "builds_on");

  // Doc C and Doc D connected by tensions
  testDb.upsertDocument({
    id: "doc-c",
    path: "thoughts/shared/ideas/doc-c.md",
    title: "Contradicting Idea",
    date: "2026-03-05",
    type: "idea",
    status: "draft",
    githubIssue: null,
    content: "An idea that tensions with another.",
  });
  testDb.upsertDocument({
    id: "doc-d",
    path: "thoughts/shared/research/doc-d.md",
    title: "Follow-up Research",
    date: "2026-03-10",
    type: "research",
    status: "complete",
    githubIssue: null,
    content: "Research that tensions with doc-c.",
  });
  testDb.addRelationship("doc-c", "doc-d", "tensions");

  // Doc E is isolated (no edges)
  testDb.upsertDocument({
    id: "doc-e",
    path: "thoughts/shared/ideas/doc-e.md",
    title: "Orphan Idea",
    date: "2026-03-15",
    type: "idea",
    status: "draft",
    githubIssue: null,
    content: "An isolated idea with no connections.",
  });
}

beforeEach(() => {
  db = new KnowledgeDB(":memory:");
  server = new McpServer({ name: "test-server", version: "0.0.1" });
  registerGraphTools(server, db);
});

describe("knowledge_communities tool", () => {
  it("returns communities for connected and isolated docs", async () => {
    setupFixtureDocs(db);

    const result = await callTool(server, "knowledge_communities");
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.totalDocuments).toBe(5);
    expect(parsed.communities).toBeInstanceOf(Array);
    // With deterministic rng and the fixture graph:
    // doc-a/doc-b form one community (connected by builds_on)
    // doc-c/doc-d form one community (connected by tensions)
    // doc-e is isolated (own community)
    expect(parsed.communities.length).toBe(3);
    expect(typeof parsed.modularity).toBe("number");
  });

  it("each community has required shape", async () => {
    setupFixtureDocs(db);

    const result = await callTool(server, "knowledge_communities");
    const parsed = JSON.parse(result.content[0].text);

    for (const community of parsed.communities) {
      expect(community).toHaveProperty("communityId");
      expect(typeof community.communityId).toBe("number");
      expect(community).toHaveProperty("members");
      expect(community.members).toBeInstanceOf(Array);
      expect(community).toHaveProperty("size");
      expect(typeof community.size).toBe("number");
      expect(community.size).toBe(community.members.length);
      expect(community).toHaveProperty("label");
      expect(typeof community.label).toBe("string");

      for (const member of community.members) {
        expect(member).toHaveProperty("id");
        expect(typeof member.id).toBe("string");
        expect(member).toHaveProperty("title");
        expect(member).toHaveProperty("type");
      }
    }
  });

  it("returns empty result for empty database", async () => {
    // db has no documents
    const result = await callTool(server, "knowledge_communities");
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.communities).toEqual([]);
    expect(parsed.modularity).toBe(0);
    expect(parsed.totalDocuments).toBe(0);
    expect(result.isError).toBeUndefined();
  });

  it("label is the most common tag among community members", async () => {
    // Insert 2 connected docs with tags
    db.upsertDocument({
      id: "tagged-a",
      path: "thoughts/shared/research/tagged-a.md",
      title: "Tagged A",
      date: "2026-01-01",
      type: "research",
      status: "approved",
      githubIssue: null,
      content: "Tagged document A.",
    });
    db.upsertDocument({
      id: "tagged-b",
      path: "thoughts/shared/research/tagged-b.md",
      title: "Tagged B",
      date: "2026-01-02",
      type: "research",
      status: "approved",
      githubIssue: null,
      content: "Tagged document B.",
    });
    db.addRelationship("tagged-a", "tagged-b", "builds_on");

    // Both have "graphology" tag, tagged-a also has "louvain"
    db.setTags("tagged-a", ["graphology", "louvain"]);
    db.setTags("tagged-b", ["graphology"]);

    const result = await callTool(server, "knowledge_communities");
    const parsed = JSON.parse(result.content[0].text);

    // These two docs should be in the same community
    // Most common tag is "graphology" (appears in both)
    const community = parsed.communities.find(
      (c: { members: Array<{ id: string }> }) =>
        c.members.some((m: { id: string }) => m.id === "tagged-a"),
    );
    expect(community).toBeDefined();
    expect(community!.label).toBe("graphology");
  });

  it("label falls back to most common type when no tags exist", async () => {
    setupFixtureDocs(db);
    // No tags set on any docs; doc-a and doc-b are in a community
    // doc-a type: "research", doc-b type: "plan"
    // Most common type in that community: tie between research and plan,
    // so either is acceptable. The isolated doc-e community has type "idea".

    const result = await callTool(server, "knowledge_communities");
    const parsed = JSON.parse(result.content[0].text);

    // All communities should have a string label (type-based fallback)
    for (const community of parsed.communities) {
      expect(typeof community.label).toBe("string");
      expect(community.label).not.toBe("unknown");
    }
  });

  it("accepts resolution parameter without error", async () => {
    setupFixtureDocs(db);

    const result = await callTool(server, "knowledge_communities", {
      resolution: 2.0,
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.communities).toBeInstanceOf(Array);
    expect(typeof parsed.modularity).toBe("number");
    expect(parsed.totalDocuments).toBe(5);
  });

  it("communities are sorted by size descending", async () => {
    setupFixtureDocs(db);

    const result = await callTool(server, "knowledge_communities");
    const parsed = JSON.parse(result.content[0].text);

    for (let i = 1; i < parsed.communities.length; i++) {
      expect(parsed.communities[i - 1].size).toBeGreaterThanOrEqual(
        parsed.communities[i].size,
      );
    }
  });

  it("single document with no edges returns one community", async () => {
    db.upsertDocument({
      id: "solo",
      path: "thoughts/shared/ideas/solo.md",
      title: "Solo Doc",
      date: "2026-01-01",
      type: "idea",
      status: "draft",
      githubIssue: null,
      content: "Just one doc.",
    });

    const result = await callTool(server, "knowledge_communities");
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.totalDocuments).toBe(1);
    expect(parsed.communities.length).toBe(1);
    expect(parsed.communities[0].members.length).toBe(1);
    expect(parsed.communities[0].members[0].id).toBe("solo");
  });
});

// ---------------------------------------------------------------------------
// knowledge_central tool tests
// ---------------------------------------------------------------------------

describe("knowledge_central tool", () => {
  it("returns empty results for empty database", async () => {
    const result = await callTool(server, "knowledge_central");
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.results).toEqual([]);
    expect(parsed.graphSize.nodes).toBe(0);
    expect(parsed.graphSize.edges).toBe(0);
    expect(result.isError).toBeUndefined();
  });

  it("hub ranks highest in star topology", async () => {
    // Star topology: doc-hub is the target of all 3 leaf edges
    // doc-leaf-a, doc-leaf-b, doc-leaf-c all build on doc-hub
    db.upsertDocument({
      id: "doc-hub",
      path: "thoughts/shared/research/doc-hub.md",
      title: "Hub Document",
      date: "2026-01-01",
      type: "research",
      status: "approved",
      githubIssue: null,
      content: "Central hub document.",
    });
    db.upsertDocument({
      id: "doc-leaf-a",
      path: "thoughts/shared/plans/doc-leaf-a.md",
      title: "Leaf A",
      date: "2026-01-02",
      type: "plan",
      status: "draft",
      githubIssue: null,
      content: "Leaf A builds on hub.",
    });
    db.upsertDocument({
      id: "doc-leaf-b",
      path: "thoughts/shared/plans/doc-leaf-b.md",
      title: "Leaf B",
      date: "2026-01-03",
      type: "plan",
      status: "draft",
      githubIssue: null,
      content: "Leaf B builds on hub.",
    });
    db.upsertDocument({
      id: "doc-leaf-c",
      path: "thoughts/shared/plans/doc-leaf-c.md",
      title: "Leaf C",
      date: "2026-01-04",
      type: "plan",
      status: "draft",
      githubIssue: null,
      content: "Leaf C builds on hub.",
    });
    db.addRelationship("doc-leaf-a", "doc-hub", "builds_on");
    db.addRelationship("doc-leaf-b", "doc-hub", "builds_on");
    db.addRelationship("doc-leaf-c", "doc-hub", "builds_on");

    const result = await callTool(server, "knowledge_central");
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.results).toBeInstanceOf(Array);
    expect(parsed.results.length).toBeGreaterThan(0);

    // Hub should be ranked #1 (highest PageRank)
    expect(parsed.results[0].id).toBe("doc-hub");
    expect(parsed.results[0].score).toBeGreaterThan(0);

    // Verify result shape
    const entry = parsed.results[0];
    expect(entry).toHaveProperty("id");
    expect(entry).toHaveProperty("title");
    expect(entry).toHaveProperty("score");
    expect(entry).toHaveProperty("type");
    expect(entry).toHaveProperty("date");
    expect(parsed.graphSize.nodes).toBe(4);
    expect(parsed.graphSize.edges).toBe(3);
  });

  it("isolated nodes have score 0 and rank last", async () => {
    // doc-conn-a and doc-conn-b have an edge (non-isolated)
    // doc-isolated has no edges
    db.upsertDocument({
      id: "doc-conn-a",
      path: "thoughts/shared/research/doc-conn-a.md",
      title: "Connected A",
      date: "2026-01-01",
      type: "research",
      status: "approved",
      githubIssue: null,
      content: "Connected document A.",
    });
    db.upsertDocument({
      id: "doc-conn-b",
      path: "thoughts/shared/research/doc-conn-b.md",
      title: "Connected B",
      date: "2026-01-02",
      type: "research",
      status: "approved",
      githubIssue: null,
      content: "Connected document B.",
    });
    db.upsertDocument({
      id: "doc-isolated",
      path: "thoughts/shared/ideas/doc-isolated.md",
      title: "Isolated",
      date: "2026-01-03",
      type: "idea",
      status: "draft",
      githubIssue: null,
      content: "Isolated document with no connections.",
    });
    db.addRelationship("doc-conn-a", "doc-conn-b", "builds_on");

    const result = await callTool(server, "knowledge_central");
    const parsed = JSON.parse(result.content[0].text);

    const isolatedEntry = parsed.results.find(
      (r: { id: string }) => r.id === "doc-isolated",
    );
    expect(isolatedEntry).toBeDefined();
    expect(isolatedEntry!.score).toBe(0);

    // Both connected docs have score > 0
    const connectedEntries = parsed.results.filter(
      (r: { id: string; score: number }) =>
        r.id === "doc-conn-a" || r.id === "doc-conn-b",
    );
    expect(connectedEntries.length).toBe(2);
    for (const entry of connectedEntries) {
      expect(entry.score).toBeGreaterThan(0);
    }

    // Isolated node should be last (or tied last) since it has score 0
    const lastEntry = parsed.results[parsed.results.length - 1];
    expect(lastEntry.score).toBe(0);
  });

  it("respects limit parameter", async () => {
    // Insert 5 docs, some connected
    for (let i = 1; i <= 5; i++) {
      db.upsertDocument({
        id: `lim-doc-${i}`,
        path: `thoughts/shared/research/lim-doc-${i}.md`,
        title: `Limit Doc ${i}`,
        date: "2026-01-01",
        type: "research",
        status: "approved",
        githubIssue: null,
        content: `Document ${i}.`,
      });
    }
    db.addRelationship("lim-doc-2", "lim-doc-1", "builds_on");
    db.addRelationship("lim-doc-3", "lim-doc-1", "builds_on");

    const result = await callTool(server, "knowledge_central", { limit: 2 });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.results.length).toBeLessThanOrEqual(2);
  });

  it("results are sorted by score descending", async () => {
    setupFixtureDocs(db);

    const result = await callTool(server, "knowledge_central");
    const parsed = JSON.parse(result.content[0].text);

    for (let i = 1; i < parsed.results.length; i++) {
      expect(parsed.results[i - 1].score).toBeGreaterThanOrEqual(
        parsed.results[i].score,
      );
    }
  });

  it("community-scoped PageRank returns only community members", async () => {
    // 6 docs forming 2 clear clusters (3 nodes each, strongly connected within cluster)
    // Cluster 1: c1-a, c1-b, c1-c with edges between them
    // Cluster 2: c2-a, c2-b, c2-c with edges between them
    for (const id of ["c1-a", "c1-b", "c1-c"]) {
      db.upsertDocument({
        id,
        path: `thoughts/shared/research/${id}.md`,
        title: `Cluster 1 ${id}`,
        date: "2026-01-01",
        type: "research",
        status: "approved",
        githubIssue: null,
        content: `Cluster 1 document ${id}.`,
      });
    }
    for (const id of ["c2-a", "c2-b", "c2-c"]) {
      db.upsertDocument({
        id,
        path: `thoughts/shared/plans/${id}.md`,
        title: `Cluster 2 ${id}`,
        date: "2026-02-01",
        type: "plan",
        status: "draft",
        githubIssue: null,
        content: `Cluster 2 document ${id}.`,
      });
    }
    // Strong cluster 1 edges
    db.addRelationship("c1-b", "c1-a", "builds_on");
    db.addRelationship("c1-c", "c1-a", "builds_on");
    db.addRelationship("c1-c", "c1-b", "builds_on");
    // Strong cluster 2 edges
    db.addRelationship("c2-b", "c2-a", "builds_on");
    db.addRelationship("c2-c", "c2-a", "builds_on");
    db.addRelationship("c2-c", "c2-b", "builds_on");

    // Get community 0
    const result = await callTool(server, "knowledge_central", {
      community: 0,
    });
    const parsed = JSON.parse(result.content[0].text);

    // Results should only contain nodes from one community
    expect(parsed.results.length).toBeGreaterThan(0);
    expect(parsed.results.length).toBeLessThanOrEqual(3);

    // All returned nodes should be from the same cluster (either c1 or c2)
    const c1Ids = new Set(["c1-a", "c1-b", "c1-c"]);
    const c2Ids = new Set(["c2-a", "c2-b", "c2-c"]);
    const resultIds = parsed.results.map((r: { id: string }) => r.id);
    const allInC1 = resultIds.every((id: string) => c1Ids.has(id));
    const allInC2 = resultIds.every((id: string) => c2Ids.has(id));
    expect(allInC1 || allInC2).toBe(true);
  });

  it("non-existent community returns empty results without error", async () => {
    setupFixtureDocs(db);

    const result = await callTool(server, "knowledge_central", {
      community: 9999,
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.results).toEqual([]);
    expect(result.isError).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// knowledge_bridges tool tests
// ---------------------------------------------------------------------------

describe("knowledge_bridges tool", () => {
  it("returns empty results for empty database", async () => {
    const result = await callTool(server, "knowledge_bridges");
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.results).toEqual([]);
    expect(parsed.graphSize.nodes).toBe(0);
    expect(parsed.graphSize.edges).toBe(0);
    expect(result.isError).toBeUndefined();
  });

  it("bridge node ranks highest in barbell graph", async () => {
    // Barbell: cluster1 (doc-a <-> doc-b), bridge (doc-bridge), cluster2 (doc-c <-> doc-d)
    // doc-bridge connects doc-b and doc-c
    for (const [id, title] of [
      ["bar-a", "Barbell A"],
      ["bar-b", "Barbell B"],
      ["bar-bridge", "Bridge Node"],
      ["bar-c", "Barbell C"],
      ["bar-d", "Barbell D"],
    ]) {
      db.upsertDocument({
        id,
        path: `thoughts/shared/research/${id}.md`,
        title,
        date: "2026-01-01",
        type: "research",
        status: "approved",
        githubIssue: null,
        content: `Document ${id}.`,
      });
    }
    // Cluster 1: bar-a and bar-b connected to each other
    db.addRelationship("bar-a", "bar-b", "builds_on");
    // Bridge connects cluster 1 to cluster 2
    db.addRelationship("bar-b", "bar-bridge", "builds_on");
    db.addRelationship("bar-bridge", "bar-c", "builds_on");
    // Cluster 2: bar-c and bar-d connected to each other
    db.addRelationship("bar-c", "bar-d", "builds_on");

    const result = await callTool(server, "knowledge_bridges");
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.results).toBeInstanceOf(Array);
    expect(parsed.results.length).toBeGreaterThan(0);

    // Bridge node should rank highest
    expect(parsed.results[0].id).toBe("bar-bridge");
    expect(parsed.results[0].score).toBeGreaterThan(0);

    // Verify result shape
    const entry = parsed.results[0];
    expect(entry).toHaveProperty("id");
    expect(entry).toHaveProperty("title");
    expect(entry).toHaveProperty("score");
    expect(entry).toHaveProperty("type");

    // graphSize reflects original directed graph
    expect(parsed.graphSize.nodes).toBe(5);
    expect(parsed.graphSize.edges).toBe(4);
  });

  it("fully disconnected graph returns empty results", async () => {
    // 3 isolated docs with no edges - all betweenness scores will be 0
    for (const id of ["iso-1", "iso-2", "iso-3"]) {
      db.upsertDocument({
        id,
        path: `thoughts/shared/ideas/${id}.md`,
        title: `Isolated ${id}`,
        date: "2026-01-01",
        type: "idea",
        status: "draft",
        githubIssue: null,
        content: `Isolated document ${id}.`,
      });
    }

    const result = await callTool(server, "knowledge_bridges");
    const parsed = JSON.parse(result.content[0].text);

    // All scores are 0, so results should be empty (0-score nodes excluded)
    expect(parsed.results).toEqual([]);
    expect(result.isError).toBeUndefined();
  });

  it("inner nodes score higher than endpoints in a linear chain", async () => {
    // Linear chain: chain-a -> chain-b -> chain-c -> chain-d
    for (const id of ["chain-a", "chain-b", "chain-c", "chain-d"]) {
      db.upsertDocument({
        id,
        path: `thoughts/shared/research/${id}.md`,
        title: `Chain ${id}`,
        date: "2026-01-01",
        type: "research",
        status: "approved",
        githubIssue: null,
        content: `Chain document ${id}.`,
      });
    }
    db.addRelationship("chain-a", "chain-b", "builds_on");
    db.addRelationship("chain-b", "chain-c", "builds_on");
    db.addRelationship("chain-c", "chain-d", "builds_on");

    const result = await callTool(server, "knowledge_bridges");
    const parsed = JSON.parse(result.content[0].text);

    // Inner nodes (chain-b, chain-c) should have higher betweenness than endpoints
    // Endpoints (chain-a, chain-d) will have score 0 and be excluded
    const innerIds = new Set(["chain-b", "chain-c"]);
    const endpointIds = new Set(["chain-a", "chain-d"]);

    // All returned results should be inner nodes (endpoints have 0 betweenness)
    for (const entry of parsed.results) {
      expect(innerIds.has(entry.id)).toBe(true);
      expect(endpointIds.has(entry.id)).toBe(false);
    }
    expect(parsed.results.length).toBe(2);
  });

  it("respects limit parameter", async () => {
    // Insert barbell + extra to have enough results
    for (const id of [
      "bl-a",
      "bl-b",
      "bl-bridge",
      "bl-c",
      "bl-d",
      "bl-e",
      "bl-f",
    ]) {
      db.upsertDocument({
        id,
        path: `thoughts/shared/research/${id}.md`,
        title: `Bridge Limit ${id}`,
        date: "2026-01-01",
        type: "research",
        status: "approved",
        githubIssue: null,
        content: `Document ${id}.`,
      });
    }
    db.addRelationship("bl-a", "bl-b", "builds_on");
    db.addRelationship("bl-b", "bl-bridge", "builds_on");
    db.addRelationship("bl-bridge", "bl-c", "builds_on");
    db.addRelationship("bl-c", "bl-d", "builds_on");
    db.addRelationship("bl-d", "bl-e", "builds_on");
    db.addRelationship("bl-e", "bl-f", "builds_on");

    const result = await callTool(server, "knowledge_bridges", { limit: 2 });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.results.length).toBeLessThanOrEqual(2);
  });

  it("results are sorted by score descending", async () => {
    // Use a chain so multiple nodes have non-zero betweenness
    for (const id of ["sort-a", "sort-b", "sort-c", "sort-d", "sort-e"]) {
      db.upsertDocument({
        id,
        path: `thoughts/shared/research/${id}.md`,
        title: `Sort ${id}`,
        date: "2026-01-01",
        type: "research",
        status: "approved",
        githubIssue: null,
        content: `Document ${id}.`,
      });
    }
    db.addRelationship("sort-a", "sort-b", "builds_on");
    db.addRelationship("sort-b", "sort-c", "builds_on");
    db.addRelationship("sort-c", "sort-d", "builds_on");
    db.addRelationship("sort-d", "sort-e", "builds_on");

    const result = await callTool(server, "knowledge_bridges");
    const parsed = JSON.parse(result.content[0].text);

    for (let i = 1; i < parsed.results.length; i++) {
      expect(parsed.results[i - 1].score).toBeGreaterThanOrEqual(
        parsed.results[i].score,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Diamond topology fixture helper
// ---------------------------------------------------------------------------
//
//  doc-a ──builds_on──> doc-b
//  doc-a ──builds_on──> doc-c
//  doc-a ──builds_on──> doc-d
//  doc-d ──builds_on──> doc-b
//  doc-d ──builds_on──> doc-c
//
// Paths from doc-a to doc-b: [doc-a, doc-b] and [doc-a, doc-d, doc-b]
// Common connections of doc-a and doc-d: doc-b and doc-c

function setupDiamondFixture(testDb: KnowledgeDB): void {
  for (const [id, title] of [
    ["doc-a", "Doc A"],
    ["doc-b", "Doc B"],
    ["doc-c", "Doc C"],
    ["doc-d", "Doc D"],
  ]) {
    testDb.upsertDocument({
      id,
      path: `thoughts/shared/research/${id}.md`,
      title,
      date: "2026-01-01",
      type: "research",
      status: "approved",
      githubIssue: null,
      content: `Diamond fixture document ${id}.`,
    });
  }
  testDb.addRelationship("doc-a", "doc-b", "builds_on");
  testDb.addRelationship("doc-a", "doc-c", "builds_on");
  testDb.addRelationship("doc-a", "doc-d", "builds_on");
  testDb.addRelationship("doc-d", "doc-b", "builds_on");
  testDb.addRelationship("doc-d", "doc-c", "builds_on");
}

// ---------------------------------------------------------------------------
// knowledge_paths tool tests
// ---------------------------------------------------------------------------

describe("knowledge_paths tool", () => {
  it("finds multiple paths in diamond topology", async () => {
    setupDiamondFixture(db);

    const result = await callTool(server, "knowledge_paths", {
      source: "doc-a",
      target: "doc-b",
    });
    const parsed = JSON.parse(result.content[0].text) as Array<
      Array<{ id: string; title: string }>
    >;

    expect(parsed).toBeInstanceOf(Array);
    expect(parsed.length).toBeGreaterThanOrEqual(2);

    // Extract path ID sequences for assertion
    const pathIds = parsed.map((path) => path.map((n) => n.id));
    expect(pathIds).toContainEqual(["doc-a", "doc-b"]);
    expect(pathIds).toContainEqual(["doc-a", "doc-d", "doc-b"]);
  });

  it("each path node has id and title", async () => {
    setupDiamondFixture(db);

    const result = await callTool(server, "knowledge_paths", {
      source: "doc-a",
      target: "doc-b",
    });
    const parsed = JSON.parse(result.content[0].text) as Array<
      Array<{ id: string; title: string }>
    >;

    for (const path of parsed) {
      for (const node of path) {
        expect(node).toHaveProperty("id");
        expect(typeof node.id).toBe("string");
        expect(node).toHaveProperty("title");
        expect(typeof node.title).toBe("string");
      }
    }
  });

  it("maxDepth=1 returns only direct path", async () => {
    setupDiamondFixture(db);

    const result = await callTool(server, "knowledge_paths", {
      source: "doc-a",
      target: "doc-b",
      maxDepth: 1,
    });
    const parsed = JSON.parse(result.content[0].text) as Array<
      Array<{ id: string }>
    >;

    // Only [doc-a, doc-b] fits in maxDepth=1; [doc-a, doc-d, doc-b] needs depth 2
    expect(parsed.length).toBe(1);
    expect(parsed[0].map((n) => n.id)).toEqual(["doc-a", "doc-b"]);
  });

  it("returns empty array when no path exists between disconnected docs", async () => {
    // Two disconnected docs
    db.upsertDocument({
      id: "isolated-x",
      path: "thoughts/shared/research/isolated-x.md",
      title: "Isolated X",
      date: "2026-01-01",
      type: "research",
      status: "approved",
      githubIssue: null,
      content: "Isolated doc X.",
    });
    db.upsertDocument({
      id: "isolated-y",
      path: "thoughts/shared/research/isolated-y.md",
      title: "Isolated Y",
      date: "2026-01-01",
      type: "research",
      status: "approved",
      githubIssue: null,
      content: "Isolated doc Y.",
    });

    const result = await callTool(server, "knowledge_paths", {
      source: "isolated-x",
      target: "isolated-y",
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed).toEqual([]);
    expect(result.isError).toBeUndefined();
  });

  it("returns empty array when source equals target", async () => {
    setupDiamondFixture(db);

    const result = await callTool(server, "knowledge_paths", {
      source: "doc-a",
      target: "doc-a",
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed).toEqual([]);
  });

  it("returns empty array when source is not in graph", async () => {
    setupDiamondFixture(db);

    const result = await callTool(server, "knowledge_paths", {
      source: "nonexistent-node",
      target: "doc-b",
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed).toEqual([]);
    expect(result.isError).toBeUndefined();
  });

  it("caps results at 20 paths maximum", async () => {
    // Create a graph with many parallel paths: hub -> many intermediaries -> sink
    db.upsertDocument({
      id: "path-source",
      path: "thoughts/shared/research/path-source.md",
      title: "Path Source",
      date: "2026-01-01",
      type: "research",
      status: "approved",
      githubIssue: null,
      content: "Source node.",
    });
    db.upsertDocument({
      id: "path-sink",
      path: "thoughts/shared/research/path-sink.md",
      title: "Path Sink",
      date: "2026-01-01",
      type: "research",
      status: "approved",
      githubIssue: null,
      content: "Sink node.",
    });
    // 25 intermediary nodes (each creates a distinct path)
    for (let i = 0; i < 25; i++) {
      const id = `path-mid-${i}`;
      db.upsertDocument({
        id,
        path: `thoughts/shared/research/${id}.md`,
        title: `Path Mid ${i}`,
        date: "2026-01-01",
        type: "research",
        status: "approved",
        githubIssue: null,
        content: `Intermediary ${i}.`,
      });
      db.addRelationship("path-source", id, "builds_on");
      db.addRelationship(id, "path-sink", "builds_on");
    }

    const result = await callTool(server, "knowledge_paths", {
      source: "path-source",
      target: "path-sink",
    });
    const parsed = JSON.parse(result.content[0].text);

    // Capped at 20
    expect(parsed.length).toBeLessThanOrEqual(20);
  });
});

// ---------------------------------------------------------------------------
// knowledge_common tool tests
// ---------------------------------------------------------------------------

describe("knowledge_common tool", () => {
  it("returns shared neighbors in diamond topology", async () => {
    setupDiamondFixture(db);

    // doc-a and doc-d both connect to doc-b and doc-c
    const result = await callTool(server, "knowledge_common", {
      docA: "doc-a",
      docB: "doc-d",
    });
    const parsed = JSON.parse(result.content[0].text) as Array<{
      id: string;
      title: string;
      type: string | null;
      connectionToA: string;
      connectionToB: string;
    }>;

    expect(parsed).toBeInstanceOf(Array);
    const ids = parsed.map((e) => e.id).sort();
    expect(ids).toEqual(["doc-b", "doc-c"]);
  });

  it("each shared entry has required shape", async () => {
    setupDiamondFixture(db);

    const result = await callTool(server, "knowledge_common", {
      docA: "doc-a",
      docB: "doc-d",
    });
    const parsed = JSON.parse(result.content[0].text) as Array<
      Record<string, unknown>
    >;

    for (const entry of parsed) {
      expect(entry).toHaveProperty("id");
      expect(typeof entry.id).toBe("string");
      expect(entry).toHaveProperty("title");
      expect(entry).toHaveProperty("type");
      expect(entry).toHaveProperty("connectionToA");
      expect(entry).toHaveProperty("connectionToB");
    }
  });

  it("returns empty array for docs with no shared connections", async () => {
    // Two completely disconnected docs
    db.upsertDocument({
      id: "solo-p",
      path: "thoughts/shared/research/solo-p.md",
      title: "Solo P",
      date: "2026-01-01",
      type: "research",
      status: "approved",
      githubIssue: null,
      content: "Solo doc P.",
    });
    db.upsertDocument({
      id: "solo-q",
      path: "thoughts/shared/research/solo-q.md",
      title: "Solo Q",
      date: "2026-01-01",
      type: "research",
      status: "approved",
      githubIssue: null,
      content: "Solo doc Q.",
    });

    const result = await callTool(server, "knowledge_common", {
      docA: "solo-p",
      docB: "solo-q",
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed).toEqual([]);
    expect(result.isError).toBeUndefined();
  });

  it("returns empty array for nonexistent documents", async () => {
    setupDiamondFixture(db);

    const result = await callTool(server, "knowledge_common", {
      docA: "nonexistent-1",
      docB: "nonexistent-2",
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed).toEqual([]);
    expect(result.isError).toBeUndefined();
  });

  it("connection type reflects edge relationship type", async () => {
    setupDiamondFixture(db);

    const result = await callTool(server, "knowledge_common", {
      docA: "doc-a",
      docB: "doc-d",
    });
    const parsed = JSON.parse(result.content[0].text) as Array<{
      id: string;
      connectionToA: string;
      connectionToB: string;
    }>;

    // Both doc-a->doc-b and doc-d->doc-b are builds_on
    const docBEntry = parsed.find((e) => e.id === "doc-b");
    expect(docBEntry).toBeDefined();
    expect(docBEntry!.connectionToA).toBe("builds_on");
    expect(docBEntry!.connectionToB).toBe("builds_on");
  });
});

// ---------------------------------------------------------------------------
// knowledge_communities limit parameter tests
// ---------------------------------------------------------------------------

describe("knowledge_communities limit parameter", () => {
  it("returns at most `limit` communities", async () => {
    setupFixtureDocs(db);

    // The fixture produces 3 communities (2 pairs + 1 isolated)
    const result = await callTool(server, "knowledge_communities", { limit: 2 });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.communities.length).toBe(2);
    // They should still be sorted by size descending
    expect(parsed.communities[0].size).toBeGreaterThanOrEqual(parsed.communities[1].size);
    // totalDocuments is unchanged (reflects the full graph)
    expect(parsed.totalDocuments).toBe(5);
  });

  it("returns all communities when limit exceeds community count", async () => {
    setupFixtureDocs(db);

    const result = await callTool(server, "knowledge_communities", { limit: 100 });
    const parsed = JSON.parse(result.content[0].text);

    // Fixture has 3 communities
    expect(parsed.communities.length).toBe(3);
  });

  it("limit=1 returns only the largest community", async () => {
    setupFixtureDocs(db);

    const result = await callTool(server, "knowledge_communities", { limit: 1 });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.communities.length).toBe(1);
    expect(parsed.communities[0].size).toBeGreaterThanOrEqual(1);
    // Should have label and all required fields
    expect(typeof parsed.communities[0].label).toBe("string");
  });

  it("limit works on no-edges graph (each node is its own community)", async () => {
    // Insert 3 isolated docs (no edges)
    for (const id of ["iso-a", "iso-b", "iso-c"]) {
      db.upsertDocument({
        id,
        path: `thoughts/shared/ideas/${id}.md`,
        title: `Isolated ${id}`,
        date: "2026-01-01",
        type: "idea",
        status: "draft",
        githubIssue: null,
        content: `Isolated document ${id}.`,
      });
    }

    const result = await callTool(server, "knowledge_communities", { limit: 2 });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.communities.length).toBe(2);
    expect(parsed.totalDocuments).toBe(3);
  });

  it("defers label computation to after slicing (labels only on returned communities)", async () => {
    setupFixtureDocs(db);

    // Set tags on docs in only one community (doc-a/doc-b)
    db.setTags("doc-a", ["graphology"]);
    db.setTags("doc-b", ["graphology"]);

    // Requesting limit=1 should still work and have a label
    const result = await callTool(server, "knowledge_communities", { limit: 1 });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.communities.length).toBe(1);
    // The returned community should have a valid label
    expect(typeof parsed.communities[0].label).toBe("string");
    expect(parsed.communities[0].label.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// knowledge_community (singular) tool tests
// ---------------------------------------------------------------------------

describe("knowledge_community tool", () => {
  it("returns correct members for a valid community ID", async () => {
    setupFixtureDocs(db);

    // First, get all communities to find a valid ID
    const allResult = await callTool(server, "knowledge_communities");
    const allParsed = JSON.parse(allResult.content[0].text);
    const targetCommunity = allParsed.communities[0];

    // Now fetch that single community
    const result = await callTool(server, "knowledge_community", {
      communityId: targetCommunity.communityId,
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.communityId).toBe(targetCommunity.communityId);
    expect(parsed.size).toBe(targetCommunity.size);
    expect(parsed.members.length).toBe(targetCommunity.members.length);
    expect(typeof parsed.label).toBe("string");

    // Member IDs should match
    const expectedIds = targetCommunity.members.map((m: { id: string }) => m.id).sort();
    const actualIds = parsed.members.map((m: { id: string }) => m.id).sort();
    expect(actualIds).toEqual(expectedIds);
  });

  it("returns error for invalid community ID", async () => {
    setupFixtureDocs(db);

    const result = await callTool(server, "knowledge_community", {
      communityId: 9999,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("9999");
    expect(result.content[0].text).toContain("not found");
  });

  it("returns error for empty graph", async () => {
    const result = await callTool(server, "knowledge_community", {
      communityId: 0,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not found");
  });

  it("works with no-edges graph (each node is its own community)", async () => {
    // Single isolated doc
    db.upsertDocument({
      id: "solo-comm",
      path: "thoughts/shared/ideas/solo-comm.md",
      title: "Solo Community",
      date: "2026-01-01",
      type: "idea",
      status: "draft",
      githubIssue: null,
      content: "A lone document.",
    });

    const result = await callTool(server, "knowledge_community", {
      communityId: 0,
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.communityId).toBe(0);
    expect(parsed.size).toBe(1);
    expect(parsed.members[0].id).toBe("solo-comm");
    expect(typeof parsed.label).toBe("string");
  });

  it("returns error for invalid ID in no-edges graph", async () => {
    db.upsertDocument({
      id: "solo-only",
      path: "thoughts/shared/ideas/solo-only.md",
      title: "Only Doc",
      date: "2026-01-01",
      type: "idea",
      status: "draft",
      githubIssue: null,
      content: "Only document.",
    });

    const result = await callTool(server, "knowledge_community", {
      communityId: 5,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not found");
  });

  it("community has correct label from tags", async () => {
    // Two connected docs with one dominant shared tag
    db.upsertDocument({
      id: "tag-x",
      path: "thoughts/shared/research/tag-x.md",
      title: "Tagged X",
      date: "2026-01-01",
      type: "research",
      status: "approved",
      githubIssue: null,
      content: "Tagged document X.",
    });
    db.upsertDocument({
      id: "tag-y",
      path: "thoughts/shared/research/tag-y.md",
      title: "Tagged Y",
      date: "2026-01-02",
      type: "research",
      status: "approved",
      githubIssue: null,
      content: "Tagged document Y.",
    });
    db.upsertDocument({
      id: "tag-z",
      path: "thoughts/shared/research/tag-z.md",
      title: "Tagged Z",
      date: "2026-01-03",
      type: "research",
      status: "approved",
      githubIssue: null,
      content: "Tagged document Z.",
    });
    db.addRelationship("tag-x", "tag-y", "builds_on");
    db.addRelationship("tag-y", "tag-z", "builds_on");
    // "graphology" appears in all 3 docs, "quality" only in 1
    db.setTags("tag-x", ["graphology", "quality"]);
    db.setTags("tag-y", ["graphology"]);
    db.setTags("tag-z", ["graphology"]);

    // Get communities to find the right ID
    const allResult = await callTool(server, "knowledge_communities");
    const allParsed = JSON.parse(allResult.content[0].text);
    const community = allParsed.communities.find(
      (c: { members: Array<{ id: string }> }) =>
        c.members.some((m: { id: string }) => m.id === "tag-x"),
    );

    // Fetch the singular community
    const result = await callTool(server, "knowledge_community", {
      communityId: community.communityId,
    });
    const parsed = JSON.parse(result.content[0].text);

    // "graphology" appears in all 3 docs (count=3), should be the label
    expect(parsed.label).toBe("graphology");
  });
});
