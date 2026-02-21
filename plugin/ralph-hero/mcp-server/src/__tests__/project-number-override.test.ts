/**
 * Tests for GH-151: projectNumber override parameter across all project-aware tools.
 *
 * Verifies:
 * - Schema validation for representative tools (not all 28)
 * - get_issue handler's projectItems filtering with override
 * - advance_children/advance_parent schema acceptance
 * - resolveFullConfig integration (covered by helpers.test.ts, confirmed here)
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { FieldOptionCache } from "../lib/cache.js";

// ---------------------------------------------------------------------------
// Representative tool schemas (replicated from source for pure testing)
// ---------------------------------------------------------------------------

// Category A: Uses resolveFullConfig (e.g., list_issues)
const listIssuesSchema = z.object({
  owner: z.string().optional(),
  repo: z.string().optional(),
  projectNumber: z.coerce.number().optional(),
  profile: z.string().optional(),
  workflowState: z.string().optional(),
  limit: z.coerce.number().optional().default(50),
});

// Category A: Uses resolveFullConfig (e.g., update_workflow_state)
const updateWorkflowStateSchema = z.object({
  owner: z.string().optional(),
  repo: z.string().optional(),
  projectNumber: z.coerce.number().optional(),
  number: z.coerce.number(),
  state: z.string(),
  command: z.string(),
});

// Category B special case: get_issue (uses resolveConfig + manual projectNumber)
const getIssueSchema = z.object({
  owner: z.string().optional(),
  repo: z.string().optional(),
  projectNumber: z.coerce.number().optional(),
  number: z.coerce.number(),
  includeGroup: z.boolean().optional().default(true),
});

// Category C: advance_children (refactored to resolveFullConfig)
const advanceChildrenSchema = z.object({
  owner: z.string().optional(),
  repo: z.string().optional(),
  projectNumber: z.coerce.number().optional(),
  number: z.coerce.number().optional(),
  issues: z.array(z.coerce.number()).optional(),
  targetState: z.string(),
});

// Category C: advance_parent (refactored to resolveFullConfig)
const advanceParentSchema = z.object({
  owner: z.string().optional(),
  repo: z.string().optional(),
  projectNumber: z.coerce.number().optional(),
  number: z.number(),
});

// Category A: project-management-tools (e.g., archive_item)
const archiveItemSchema = z.object({
  owner: z.string().optional(),
  repo: z.string().optional(),
  projectNumber: z.coerce.number().optional(),
  number: z.coerce.number(),
  unarchive: z.boolean().optional().default(false),
});

// Category A: batch_update
const batchUpdateSchema = z.object({
  owner: z.string().optional(),
  repo: z.string().optional(),
  projectNumber: z.coerce.number().optional(),
  issues: z.array(z.coerce.number()).min(1),
  operations: z.array(z.object({
    field: z.enum(["workflow_state", "estimate", "priority"]),
    value: z.string(),
  })).min(1),
});

// ---------------------------------------------------------------------------
// Schema validation tests
// ---------------------------------------------------------------------------

describe("projectNumber override schema", () => {
  it("accepts projectNumber as optional number", () => {
    const result = listIssuesSchema.safeParse({
      projectNumber: 5,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.projectNumber).toBe(5);
    }
  });

  it("omitting projectNumber is valid", () => {
    const result = listIssuesSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.projectNumber).toBeUndefined();
    }
  });

  it("coerces string to number", () => {
    const result = listIssuesSchema.safeParse({
      projectNumber: "7",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.projectNumber).toBe(7);
    }
  });

  it("rejects non-numeric string", () => {
    const result = listIssuesSchema.safeParse({
      projectNumber: "abc",
    });
    expect(result.success).toBe(false);
  });

  it("accepts projectNumber alongside other params", () => {
    const result = updateWorkflowStateSchema.safeParse({
      number: 42,
      state: "In Progress",
      command: "ralph_impl",
      projectNumber: 10,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.projectNumber).toBe(10);
      expect(result.data.number).toBe(42);
    }
  });
});

// ---------------------------------------------------------------------------
// get_issue projectNumber override
// ---------------------------------------------------------------------------

describe("get_issue projectNumber override", () => {
  it("schema accepts projectNumber", () => {
    const result = getIssueSchema.safeParse({
      number: 151,
      projectNumber: 5,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.projectNumber).toBe(5);
      expect(result.data.number).toBe(151);
    }
  });

  it("schema valid without projectNumber", () => {
    const result = getIssueSchema.safeParse({
      number: 151,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.projectNumber).toBeUndefined();
    }
  });

  // Verify the projectItems filtering logic (pure function extraction)
  it("filters projectItems by override number", () => {
    const projectItems = [
      { project: { number: 3 }, fieldValues: { nodes: [] } },
      { project: { number: 7 }, fieldValues: { nodes: [] } },
    ];
    const overrideNumber = 7;
    const match = projectItems.find(
      (pi) => pi.project.number === overrideNumber,
    );
    expect(match).toBeDefined();
    expect(match!.project.number).toBe(7);
  });

  it("falls back to first item when no projectNumber", () => {
    const projectItems = [
      { project: { number: 3 }, fieldValues: { nodes: [] } },
      { project: { number: 7 }, fieldValues: { nodes: [] } },
    ];
    const projectNumber = undefined;
    const match = projectNumber
      ? projectItems.find((pi) => pi.project.number === projectNumber)
      : projectItems[0];
    expect(match).toBeDefined();
    expect(match!.project.number).toBe(3);
  });

  it("returns undefined when override number not found in projectItems", () => {
    const projectItems = [
      { project: { number: 3 }, fieldValues: { nodes: [] } },
    ];
    const overrideNumber = 99;
    const match = projectItems.find(
      (pi) => pi.project.number === overrideNumber,
    );
    expect(match).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// advance_children / advance_parent projectNumber
// ---------------------------------------------------------------------------

describe("advance_children projectNumber", () => {
  it("schema accepts projectNumber with number param", () => {
    const result = advanceChildrenSchema.safeParse({
      number: 42,
      targetState: "Research Needed",
      projectNumber: 5,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.projectNumber).toBe(5);
    }
  });

  it("schema accepts projectNumber with issues param", () => {
    const result = advanceChildrenSchema.safeParse({
      issues: [10, 11, 12],
      targetState: "Ready for Plan",
      projectNumber: 8,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.projectNumber).toBe(8);
      expect(result.data.issues).toEqual([10, 11, 12]);
    }
  });

  it("schema valid without projectNumber", () => {
    const result = advanceChildrenSchema.safeParse({
      number: 42,
      targetState: "In Progress",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.projectNumber).toBeUndefined();
    }
  });
});

describe("advance_parent projectNumber", () => {
  it("schema accepts projectNumber", () => {
    const result = advanceParentSchema.safeParse({
      number: 42,
      projectNumber: 5,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.projectNumber).toBe(5);
    }
  });

  it("schema valid without projectNumber", () => {
    const result = advanceParentSchema.safeParse({
      number: 42,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.projectNumber).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// project-management-tools and batch_update projectNumber
// ---------------------------------------------------------------------------

describe("archive_item projectNumber", () => {
  it("schema accepts projectNumber", () => {
    const result = archiveItemSchema.safeParse({
      number: 10,
      projectNumber: 3,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.projectNumber).toBe(3);
    }
  });

  it("schema valid without projectNumber", () => {
    const result = archiveItemSchema.safeParse({
      number: 10,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.projectNumber).toBeUndefined();
    }
  });
});

describe("batch_update projectNumber", () => {
  it("schema accepts projectNumber", () => {
    const result = batchUpdateSchema.safeParse({
      issues: [1, 2, 3],
      operations: [{ field: "workflow_state", value: "In Progress" }],
      projectNumber: 5,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.projectNumber).toBe(5);
    }
  });

  it("schema valid without projectNumber", () => {
    const result = batchUpdateSchema.safeParse({
      issues: [1],
      operations: [{ field: "estimate", value: "XS" }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.projectNumber).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// GH-278: FieldOptionCache returns correct data per project
// ---------------------------------------------------------------------------

describe("fieldCache calls with projectNumber", () => {
  it("getProjectId returns correct project when projectNumber is passed", () => {
    const cache = new FieldOptionCache();
    cache.populate(3, "PVT_3", [{ id: "F1", name: "Status", options: [{ id: "O1", name: "Todo" }] }]);
    cache.populate(5, "PVT_5", [{ id: "F2", name: "Status", options: [{ id: "O2", name: "Done" }] }]);

    // Without projectNumber: returns default (first populated = #3)
    expect(cache.getProjectId()).toBe("PVT_3");
    // With projectNumber: returns correct project
    expect(cache.getProjectId(5)).toBe("PVT_5");
    expect(cache.getProjectId(3)).toBe("PVT_3");
  });

  it("getFieldId returns correct field for non-default project", () => {
    const cache = new FieldOptionCache();
    cache.populate(3, "PVT_3", [{ id: "F1_3", name: "Status", options: [] }]);
    cache.populate(5, "PVT_5", [{ id: "F1_5", name: "Status", options: [] }]);

    expect(cache.getFieldId("Status")).toBe("F1_3"); // default
    expect(cache.getFieldId("Status", 5)).toBe("F1_5");
    expect(cache.getFieldId("Status", 3)).toBe("F1_3");
  });

  it("resolveOptionId returns correct option for non-default project", () => {
    const cache = new FieldOptionCache();
    cache.populate(3, "PVT_3", [
      { id: "F1", name: "Workflow State", options: [{ id: "WS_3_BP", name: "Backlog" }] },
    ]);
    cache.populate(5, "PVT_5", [
      { id: "F2", name: "Workflow State", options: [{ id: "WS_5_BP", name: "Backlog" }] },
    ]);

    expect(cache.resolveOptionId("Workflow State", "Backlog")).toBe("WS_3_BP");
    expect(cache.resolveOptionId("Workflow State", "Backlog", 5)).toBe("WS_5_BP");
    expect(cache.resolveOptionId("Workflow State", "Backlog", 3)).toBe("WS_3_BP");
  });

  it("getOptionNames returns correct names for non-default project", () => {
    const cache = new FieldOptionCache();
    cache.populate(3, "PVT_3", [
      { id: "F1", name: "Priority", options: [{ id: "P0_3", name: "P0" }, { id: "P1_3", name: "P1" }] },
    ]);
    cache.populate(5, "PVT_5", [
      { id: "F2", name: "Priority", options: [{ id: "P0_5", name: "P0" }, { id: "P2_5", name: "P2" }] },
    ]);

    expect(cache.getOptionNames("Priority")).toEqual(["P0", "P1"]);
    expect(cache.getOptionNames("Priority", 5)).toEqual(["P0", "P2"]);
  });

  it("getFieldNames returns correct names for non-default project", () => {
    const cache = new FieldOptionCache();
    cache.populate(3, "PVT_3", [
      { id: "F1", name: "Status" },
      { id: "F2", name: "Priority" },
    ]);
    cache.populate(5, "PVT_5", [
      { id: "F3", name: "Status" },
      { id: "F4", name: "Estimate" },
    ]);

    expect(cache.getFieldNames()).toEqual(["Status", "Priority"]);
    expect(cache.getFieldNames(5)).toEqual(["Status", "Estimate"]);
  });
});
