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
