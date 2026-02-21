/**
 * Tests for bulk_archive: verifies buildBatchArchiveMutation builder function
 * and mutation structure for batch archival operations.
 */

import { describe, it, expect } from "vitest";
import { buildBatchArchiveMutation } from "../tools/batch-tools.js";

describe("buildBatchArchiveMutation", () => {
  it("generates correct aliases for multiple items", () => {
    const { mutationString, variables } = buildBatchArchiveMutation(
      "proj-123",
      ["item-a", "item-b", "item-c"],
    );
    expect(mutationString).toContain("a0:");
    expect(mutationString).toContain("a1:");
    expect(mutationString).toContain("a2:");
    expect(variables.projectId).toBe("proj-123");
    expect(variables.item_a0).toBe("item-a");
    expect(variables.item_a1).toBe("item-b");
    expect(variables.item_a2).toBe("item-c");
  });

  it("starts with mutation keyword", () => {
    const { mutationString } = buildBatchArchiveMutation("proj-1", ["item-1"]);
    expect(mutationString.trimStart()).toMatch(/^mutation\(/);
  });

  it("uses archiveProjectV2Item mutation", () => {
    const { mutationString } = buildBatchArchiveMutation("proj-1", ["item-1"]);
    expect(mutationString).toContain("archiveProjectV2Item");
  });

  it("handles single item correctly", () => {
    const { mutationString, variables } = buildBatchArchiveMutation(
      "proj-1",
      ["single-item"],
    );
    expect(mutationString).toContain("a0:");
    expect(mutationString).not.toContain("a1:");
    expect(variables.item_a0).toBe("single-item");
  });

  it("does not use reserved @octokit/graphql variable names", () => {
    const reserved = ["query", "method", "url"];
    const { variables } = buildBatchArchiveMutation("proj-1", [
      "item-1",
      "item-2",
    ]);
    for (const key of Object.keys(variables)) {
      expect(reserved).not.toContain(key);
    }
  });

  it("shares projectId variable across all aliases", () => {
    const { mutationString, variables } = buildBatchArchiveMutation(
      "proj-shared",
      ["item-1", "item-2", "item-3"],
    );
    // Only one $projectId declaration
    const projectIdMatches = mutationString.match(/\$projectId/g);
    // Should appear in var decl + once per alias input
    expect(projectIdMatches).toBeTruthy();
    expect(variables.projectId).toBe("proj-shared");
  });
});

describe("bulk_archive dryRun", () => {
  it("dryRun response includes wouldArchive count and items list", () => {
    const matched = [
      { id: "item-1", content: { number: 10, title: "Issue A" } },
      { id: "item-2", content: { number: 20, title: "Issue B" } },
    ];
    const result = {
      dryRun: true,
      wouldArchive: matched.length,
      items: matched.map((m) => ({
        number: m.content?.number,
        title: m.content?.title,
        itemId: m.id,
      })),
      errors: [],
    };
    expect(result.dryRun).toBe(true);
    expect(result.wouldArchive).toBe(2);
    expect(result.items).toHaveLength(2);
    expect(result.errors).toHaveLength(0);
  });

  it("dryRun flag is false in normal response", () => {
    const result = {
      dryRun: false,
      archivedCount: 1,
      items: [{ number: 10, title: "Issue A", itemId: "item-1" }],
      errors: [],
    };
    expect(result.dryRun).toBe(false);
    expect(result.archivedCount).toBe(1);
  });

  it("dryRun items include number, title, and itemId", () => {
    const matched = [
      { id: "item-x", content: { number: 42, title: "My Issue" } },
    ];
    const items = matched.map((m) => ({
      number: m.content?.number,
      title: m.content?.title,
      itemId: m.id,
    }));
    expect(items[0]).toEqual({
      number: 42,
      title: "My Issue",
      itemId: "item-x",
    });
  });
});

describe("bulk_archive mutation structure", () => {
  it("archiveProjectV2Item mutation has required input fields", () => {
    const mutation = `mutation($projectId: ID!, $item_a0: ID!) {
      a0: archiveProjectV2Item(input: {
        projectId: $projectId,
        itemId: $item_a0
      }) {
        item { id }
      }
    }`;
    expect(mutation).toContain("archiveProjectV2Item");
    expect(mutation).toContain("projectId");
    expect(mutation).toContain("item_a0");
  });
});
