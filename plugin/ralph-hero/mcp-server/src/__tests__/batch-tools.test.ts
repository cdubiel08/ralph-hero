/**
 * Tests for batch-tools: aliased GraphQL query/mutation builders
 * and batch_update input validation logic.
 *
 * The query/mutation builders are pure functions and can be tested
 * without mocking. Integration behavior (actual GraphQL execution)
 * is tested manually.
 */

import { describe, it, expect } from "vitest";
import {
  buildBatchResolveQuery,
  buildBatchMutationQuery,
  buildBatchFieldValueQuery,
} from "../tools/batch-tools.js";

// ---------------------------------------------------------------------------
// buildBatchResolveQuery
// ---------------------------------------------------------------------------

describe("buildBatchResolveQuery", () => {
  it("generates correct aliases for N issues", () => {
    const { queryString, variables } = buildBatchResolveQuery(
      "testOwner",
      "testRepo",
      [10, 20, 30],
    );

    // Should have aliases i0, i1, i2
    expect(queryString).toContain("i0:");
    expect(queryString).toContain("i1:");
    expect(queryString).toContain("i2:");
    expect(queryString).not.toContain("i3:");

    // Should reference the variable names
    expect(queryString).toContain("$n0: Int!");
    expect(queryString).toContain("$n1: Int!");
    expect(queryString).toContain("$n2: Int!");

    // Variables should be populated
    expect(variables.owner).toBe("testOwner");
    expect(variables.repo).toBe("testRepo");
    expect(variables.n0).toBe(10);
    expect(variables.n1).toBe(20);
    expect(variables.n2).toBe(30);
  });

  it("includes projectItems in the issue query", () => {
    const { queryString } = buildBatchResolveQuery("o", "r", [1]);
    expect(queryString).toContain("projectItems");
    expect(queryString).toContain("project { id }");
  });

  it("generates a valid query for a single issue", () => {
    const { queryString, variables } = buildBatchResolveQuery("o", "r", [42]);
    expect(queryString).toContain("i0:");
    expect(queryString).toContain("$n0: Int!");
    expect(variables.n0).toBe(42);
    // Should not have i1
    expect(queryString).not.toContain("i1:");
  });
});

// ---------------------------------------------------------------------------
// buildBatchMutationQuery
// ---------------------------------------------------------------------------

describe("buildBatchMutationQuery", () => {
  it("generates correct aliases for N updates", () => {
    const { mutationString, variables } = buildBatchMutationQuery(
      "proj-123",
      [
        { alias: "u10_0", itemId: "item-a", fieldId: "field-ws", optionId: "opt-rn" },
        { alias: "u10_1", itemId: "item-a", fieldId: "field-est", optionId: "opt-xs" },
        { alias: "u20_0", itemId: "item-b", fieldId: "field-ws", optionId: "opt-rn" },
      ],
    );

    // Should have all three aliases
    expect(mutationString).toContain("u10_0:");
    expect(mutationString).toContain("u10_1:");
    expect(mutationString).toContain("u20_0:");

    // Project ID variable
    expect(variables.projectId).toBe("proj-123");

    // Per-alias variables
    expect(variables.item_u10_0).toBe("item-a");
    expect(variables.field_u10_0).toBe("field-ws");
    expect(variables.opt_u10_0).toBe("opt-rn");

    expect(variables.item_u10_1).toBe("item-a");
    expect(variables.field_u10_1).toBe("field-est");
    expect(variables.opt_u10_1).toBe("opt-xs");

    expect(variables.item_u20_0).toBe("item-b");
    expect(variables.field_u20_0).toBe("field-ws");
    expect(variables.opt_u20_0).toBe("opt-rn");
  });

  it("starts with a mutation keyword", () => {
    const { mutationString } = buildBatchMutationQuery("proj", [
      { alias: "u0", itemId: "i", fieldId: "f", optionId: "o" },
    ]);
    expect(mutationString.trimStart()).toMatch(/^mutation\(/);
  });

  it("uses correct GraphQL mutation name", () => {
    const { mutationString } = buildBatchMutationQuery("proj", [
      { alias: "u0", itemId: "i", fieldId: "f", optionId: "o" },
    ]);
    expect(mutationString).toContain("updateProjectV2ItemFieldValue");
  });

  it("references singleSelectOptionId in the value", () => {
    const { mutationString } = buildBatchMutationQuery("proj", [
      { alias: "u0", itemId: "i", fieldId: "f", optionId: "o" },
    ]);
    expect(mutationString).toContain("singleSelectOptionId");
  });
});

// ---------------------------------------------------------------------------
// buildBatchFieldValueQuery
// ---------------------------------------------------------------------------

describe("buildBatchFieldValueQuery", () => {
  it("generates correct aliases for field value queries", () => {
    const { queryString, variables } = buildBatchFieldValueQuery([
      { alias: "fv10", itemId: "item-a" },
      { alias: "fv20", itemId: "item-b" },
    ]);

    // Should have both aliases
    expect(queryString).toContain("fv10:");
    expect(queryString).toContain("fv20:");

    // Variables
    expect(variables.id_fv10).toBe("item-a");
    expect(variables.id_fv20).toBe("item-b");
  });

  it("queries for single select field values", () => {
    const { queryString } = buildBatchFieldValueQuery([
      { alias: "fv1", itemId: "item-x" },
    ]);
    expect(queryString).toContain("ProjectV2ItemFieldSingleSelectValue");
    expect(queryString).toContain("fieldValues");
  });

  it("includes field name in the query", () => {
    const { queryString } = buildBatchFieldValueQuery([
      { alias: "fv1", itemId: "item-x" },
    ]);
    expect(queryString).toContain("ProjectV2FieldCommon");
    expect(queryString).toContain("name");
  });
});

// ---------------------------------------------------------------------------
// Variable naming safety
// ---------------------------------------------------------------------------

describe("variable naming safety", () => {
  it("does not use reserved @octokit/graphql variable names", () => {
    // @octokit/graphql v9 reserves 'query', 'method', and 'url'
    const reserved = ["query", "method", "url"];

    const { variables: resolveVars } = buildBatchResolveQuery("o", "r", [1, 2, 3]);
    for (const key of Object.keys(resolveVars)) {
      expect(reserved).not.toContain(key);
    }

    const { variables: mutVars } = buildBatchMutationQuery("p", [
      { alias: "u0", itemId: "i", fieldId: "f", optionId: "o" },
    ]);
    for (const key of Object.keys(mutVars)) {
      expect(reserved).not.toContain(key);
    }

    const { variables: fvVars } = buildBatchFieldValueQuery([
      { alias: "fv0", itemId: "i" },
    ]);
    for (const key of Object.keys(fvVars)) {
      expect(reserved).not.toContain(key);
    }
  });
});

// ---------------------------------------------------------------------------
// Chunking / large batch tests
// ---------------------------------------------------------------------------

describe("batch mutation chunking", () => {
  it("generates correct number of aliases for large batches", () => {
    // 60 updates should be split into chunks of 50 at the tool level,
    // but the builder itself handles any size — verify it works
    const updates = Array.from({ length: 60 }, (_, i) => ({
      alias: `u${i}_0`,
      itemId: `item-${i}`,
      fieldId: "field-ws",
      optionId: "opt-rn",
    }));

    const { mutationString, variables } = buildBatchMutationQuery("proj", updates);

    // Should contain all 60 aliases
    for (let i = 0; i < 60; i++) {
      expect(mutationString).toContain(`u${i}_0:`);
    }

    // Should have projectId + 3 variables per update (item, field, opt)
    expect(Object.keys(variables).length).toBe(1 + 60 * 3);
  });

  it("generates correct aliases for issues x operations matrix", () => {
    // Simulate 3 issues x 2 operations = 6 aliases
    const updates = [
      { alias: "u10_0", itemId: "item-10", fieldId: "f-ws", optionId: "o-rn" },
      { alias: "u10_1", itemId: "item-10", fieldId: "f-est", optionId: "o-xs" },
      { alias: "u20_0", itemId: "item-20", fieldId: "f-ws", optionId: "o-rn" },
      { alias: "u20_1", itemId: "item-20", fieldId: "f-est", optionId: "o-xs" },
      { alias: "u30_0", itemId: "item-30", fieldId: "f-ws", optionId: "o-rn" },
      { alias: "u30_1", itemId: "item-30", fieldId: "f-est", optionId: "o-xs" },
    ];

    const { mutationString } = buildBatchMutationQuery("proj", updates);

    // All 6 aliases present
    expect(mutationString).toContain("u10_0:");
    expect(mutationString).toContain("u10_1:");
    expect(mutationString).toContain("u20_0:");
    expect(mutationString).toContain("u20_1:");
    expect(mutationString).toContain("u30_0:");
    expect(mutationString).toContain("u30_1:");
  });
});

// ---------------------------------------------------------------------------
// Resolve query edge cases
// ---------------------------------------------------------------------------

describe("buildBatchResolveQuery edge cases", () => {
  it("handles large issue arrays (50 issues)", () => {
    const issues = Array.from({ length: 50 }, (_, i) => i + 1);
    const { queryString, variables } = buildBatchResolveQuery("owner", "repo", issues);

    // Should have 50 aliases (i0 through i49)
    expect(queryString).toContain("i0:");
    expect(queryString).toContain("i49:");
    expect(queryString).not.toContain("i50:");

    // Should have owner, repo + 50 number variables
    expect(variables.n0).toBe(1);
    expect(variables.n49).toBe(50);
  });

  it("preserves exact issue numbers in variables", () => {
    const { variables } = buildBatchResolveQuery("o", "r", [999, 1, 42]);
    expect(variables.n0).toBe(999);
    expect(variables.n1).toBe(1);
    expect(variables.n2).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// Field value query edge cases
// ---------------------------------------------------------------------------

describe("buildBatchFieldValueQuery edge cases", () => {
  it("handles single item", () => {
    const { queryString, variables } = buildBatchFieldValueQuery([
      { alias: "fv1", itemId: "item-only" },
    ]);
    expect(queryString).toContain("fv1:");
    expect(variables.id_fv1).toBe("item-only");
  });

  it("handles many items", () => {
    const items = Array.from({ length: 20 }, (_, i) => ({
      alias: `fv${i}`,
      itemId: `item-${i}`,
    }));
    const { queryString, variables } = buildBatchFieldValueQuery(items);

    expect(queryString).toContain("fv0:");
    expect(queryString).toContain("fv19:");
    expect(variables.id_fv0).toBe("item-0");
    expect(variables.id_fv19).toBe("item-19");
  });
});
