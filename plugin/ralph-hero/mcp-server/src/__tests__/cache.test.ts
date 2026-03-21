import { describe, it, expect } from "vitest";
import { FieldOptionCache } from "../lib/cache.js";
import { resolveIterationId } from "../lib/helpers.js";

const FIELDS_A = [
  {
    id: "field-1",
    name: "Workflow State",
    options: [
      { id: "opt-1", name: "Backlog" },
      { id: "opt-2", name: "In Progress" },
      { id: "opt-3", name: "Done" },
    ],
  },
  {
    id: "field-2",
    name: "Priority",
    options: [
      { id: "opt-p0", name: "P0" },
      { id: "opt-p1", name: "P1" },
    ],
  },
  { id: "field-3", name: "Title" },
];

const FIELDS_B = [
  {
    id: "field-b1",
    name: "Workflow State",
    options: [
      { id: "opt-b1", name: "Todo" },
      { id: "opt-b2", name: "Done" },
    ],
  },
  {
    id: "field-b2",
    name: "Estimate",
    options: [
      { id: "opt-xs", name: "XS" },
      { id: "opt-s", name: "S" },
    ],
  },
];

describe("FieldOptionCache single-project", () => {
  it("populate + isPopulated() returns true", () => {
    const cache = new FieldOptionCache();
    expect(cache.isPopulated()).toBe(false);
    cache.populate(3, "PVT_proj_a", FIELDS_A);
    expect(cache.isPopulated()).toBe(true);
  });

  it("getProjectId() returns correct ID", () => {
    const cache = new FieldOptionCache();
    cache.populate(3, "PVT_proj_a", FIELDS_A);
    expect(cache.getProjectId()).toBe("PVT_proj_a");
  });

  it("resolveOptionId returns correct option ID", () => {
    const cache = new FieldOptionCache();
    cache.populate(3, "PVT_proj_a", FIELDS_A);
    expect(cache.resolveOptionId("Workflow State", "In Progress")).toBe("opt-2");
    expect(cache.resolveOptionId("Priority", "P0")).toBe("opt-p0");
    expect(cache.resolveOptionId("Workflow State", "Unknown")).toBeUndefined();
  });

  it("getFieldId returns correct field ID", () => {
    const cache = new FieldOptionCache();
    cache.populate(3, "PVT_proj_a", FIELDS_A);
    expect(cache.getFieldId("Workflow State")).toBe("field-1");
    expect(cache.getFieldId("Title")).toBe("field-3");
    expect(cache.getFieldId("Missing")).toBeUndefined();
  });

  it("getOptionNames returns all option names", () => {
    const cache = new FieldOptionCache();
    cache.populate(3, "PVT_proj_a", FIELDS_A);
    expect(cache.getOptionNames("Priority")).toEqual(["P0", "P1"]);
    expect(cache.getOptionNames("Title")).toEqual([]);
  });

  it("getFieldNames returns all field names", () => {
    const cache = new FieldOptionCache();
    cache.populate(3, "PVT_proj_a", FIELDS_A);
    expect(cache.getFieldNames()).toEqual(["Workflow State", "Priority", "Title"]);
  });
});

describe("FieldOptionCache multi-project", () => {
  it("isPopulated(N) returns true for populated project, false for others", () => {
    const cache = new FieldOptionCache();
    cache.populate(3, "PVT_proj_a", FIELDS_A);
    expect(cache.isPopulated(3)).toBe(true);
    expect(cache.isPopulated(5)).toBe(false);
  });

  it("populate second project does NOT overwrite first", () => {
    const cache = new FieldOptionCache();
    cache.populate(3, "PVT_proj_a", FIELDS_A);
    cache.populate(5, "PVT_proj_b", FIELDS_B);

    // Project A data intact
    expect(cache.getProjectId(3)).toBe("PVT_proj_a");
    expect(cache.resolveOptionId("Priority", "P0", 3)).toBe("opt-p0");
    expect(cache.getFieldId("Workflow State", 3)).toBe("field-1");

    // Project B data correct
    expect(cache.getProjectId(5)).toBe("PVT_proj_b");
    expect(cache.resolveOptionId("Workflow State", "Todo", 5)).toBe("opt-b1");
    expect(cache.getFieldId("Estimate", 5)).toBe("field-b2");
  });

  it("getProjectId(N) returns per-project ID", () => {
    const cache = new FieldOptionCache();
    cache.populate(3, "PVT_proj_a", FIELDS_A);
    cache.populate(5, "PVT_proj_b", FIELDS_B);
    expect(cache.getProjectId(3)).toBe("PVT_proj_a");
    expect(cache.getProjectId(5)).toBe("PVT_proj_b");
    expect(cache.getProjectId(99)).toBeUndefined();
  });

  it("resolveOptionId with projectNumber returns per-project data", () => {
    const cache = new FieldOptionCache();
    cache.populate(3, "PVT_proj_a", FIELDS_A);
    cache.populate(5, "PVT_proj_b", FIELDS_B);

    // "Done" exists in both but with different IDs
    expect(cache.resolveOptionId("Workflow State", "Done", 3)).toBe("opt-3");
    expect(cache.resolveOptionId("Workflow State", "Done", 5)).toBe("opt-b2");

    // Fields unique to each project
    expect(cache.resolveOptionId("Priority", "P0", 3)).toBe("opt-p0");
    expect(cache.resolveOptionId("Priority", "P0", 5)).toBeUndefined();
    expect(cache.resolveOptionId("Estimate", "XS", 5)).toBe("opt-xs");
    expect(cache.resolveOptionId("Estimate", "XS", 3)).toBeUndefined();
  });

  it("default (no projectNumber) returns first populated project", () => {
    const cache = new FieldOptionCache();
    cache.populate(3, "PVT_proj_a", FIELDS_A);
    cache.populate(5, "PVT_proj_b", FIELDS_B);

    // Default should be project 3 (first populated)
    expect(cache.getProjectId()).toBe("PVT_proj_a");
    expect(cache.resolveOptionId("Priority", "P0")).toBe("opt-p0");
    expect(cache.getFieldId("Workflow State")).toBe("field-1");
  });
});

describe("FieldOptionCache clear", () => {
  it("clear() removes all project data", () => {
    const cache = new FieldOptionCache();
    cache.populate(3, "PVT_proj_a", FIELDS_A);
    cache.populate(5, "PVT_proj_b", FIELDS_B);

    cache.clear();

    expect(cache.isPopulated()).toBe(false);
    expect(cache.isPopulated(3)).toBe(false);
    expect(cache.isPopulated(5)).toBe(false);
    expect(cache.getProjectId()).toBeUndefined();
    expect(cache.getProjectId(3)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Iteration field support (Phase 1: GH-508)
// ---------------------------------------------------------------------------

const FIELDS_WITH_ITERATION = [
  ...FIELDS_A,
  {
    id: "field-iter-1",
    name: "Sprint",
    configuration: {
      iterations: [
        { id: "iter-1a", title: "Sprint 1", startDate: "2026-02-16", duration: 14 },
        { id: "iter-2a", title: "Sprint 2", startDate: "2026-03-02", duration: 14 },
        { id: "iter-3a", title: "Sprint 3", startDate: "2026-03-16", duration: 14 },
      ],
      completedIterations: [
        { id: "iter-0a", title: "Sprint 0", startDate: "2026-02-02", duration: 14 },
      ],
    },
  },
];

describe("FieldOptionCache iteration fields", () => {
  it("populate() stores iteration title->ID mappings", () => {
    const cache = new FieldOptionCache();
    cache.populate(3, "PVT_proj_a", FIELDS_WITH_ITERATION);

    // Iteration titles should be resolvable via resolveOptionId
    expect(cache.resolveOptionId("Sprint", "Sprint 1", 3)).toBe("iter-1a");
    expect(cache.resolveOptionId("Sprint", "Sprint 2", 3)).toBe("iter-2a");
    expect(cache.resolveOptionId("Sprint", "Sprint 3", 3)).toBe("iter-3a");
    // Completed iterations are also stored
    expect(cache.resolveOptionId("Sprint", "Sprint 0", 3)).toBe("iter-0a");
    // Unknown returns undefined
    expect(cache.resolveOptionId("Sprint", "Sprint 99", 3)).toBeUndefined();
  });

  it("getFieldId returns iteration field ID", () => {
    const cache = new FieldOptionCache();
    cache.populate(3, "PVT_proj_a", FIELDS_WITH_ITERATION);

    expect(cache.getFieldId("Sprint", 3)).toBe("field-iter-1");
  });

  it("getIterations() returns full iteration metadata", () => {
    const cache = new FieldOptionCache();
    cache.populate(3, "PVT_proj_a", FIELDS_WITH_ITERATION);

    const iterations = cache.getIterations("Sprint", 3);
    expect(iterations).toBeDefined();
    expect(iterations!.length).toBe(4); // 3 active + 1 completed

    const sprint1 = iterations!.find((it) => it.title === "Sprint 1");
    expect(sprint1).toEqual({
      id: "iter-1a",
      title: "Sprint 1",
      startDate: "2026-02-16",
      duration: 14,
    });

    // Completed iteration included
    const sprint0 = iterations!.find((it) => it.title === "Sprint 0");
    expect(sprint0).toBeDefined();
    expect(sprint0!.id).toBe("iter-0a");
  });

  it("getIterations() returns undefined for non-iteration fields", () => {
    const cache = new FieldOptionCache();
    cache.populate(3, "PVT_proj_a", FIELDS_WITH_ITERATION);

    expect(cache.getIterations("Workflow State", 3)).toBeUndefined();
    expect(cache.getIterations("Missing", 3)).toBeUndefined();
  });

  it("getOptionNames returns iteration titles", () => {
    const cache = new FieldOptionCache();
    cache.populate(3, "PVT_proj_a", FIELDS_WITH_ITERATION);

    const names = cache.getOptionNames("Sprint", 3);
    expect(names).toContain("Sprint 1");
    expect(names).toContain("Sprint 2");
    expect(names).toContain("Sprint 0");
  });

  it("existing single-select fields still work alongside iteration fields", () => {
    const cache = new FieldOptionCache();
    cache.populate(3, "PVT_proj_a", FIELDS_WITH_ITERATION);

    // Single-select fields unchanged
    expect(cache.resolveOptionId("Workflow State", "In Progress", 3)).toBe("opt-2");
    expect(cache.resolveOptionId("Priority", "P0", 3)).toBe("opt-p0");
  });
});

describe("resolveIterationId", () => {
  function makeCache(): FieldOptionCache {
    const cache = new FieldOptionCache();
    cache.populate(3, "PVT_proj_a", FIELDS_WITH_ITERATION);
    return cache;
  }

  it("resolves @current to the active iteration", () => {
    const cache = makeCache();
    // Sprint 2 runs 2026-03-02 to 2026-03-16
    const during = new Date("2026-03-05T12:00:00Z");
    expect(resolveIterationId(cache, 3, "Sprint", "@current", during)).toBe("iter-2a");
  });

  it("resolves @current to Sprint 1 when date is within Sprint 1", () => {
    const cache = makeCache();
    // Sprint 1 runs 2026-02-16 to 2026-03-02
    const during = new Date("2026-02-20T12:00:00Z");
    expect(resolveIterationId(cache, 3, "Sprint", "@current", during)).toBe("iter-1a");
  });

  it("returns null for @current when no iteration covers today", () => {
    const cache = makeCache();
    // Before any iteration
    const before = new Date("2026-01-01T12:00:00Z");
    expect(resolveIterationId(cache, 3, "Sprint", "@current", before)).toBeNull();
  });

  it("resolves @next to the next upcoming iteration", () => {
    const cache = makeCache();
    // During Sprint 2, @next should be Sprint 3
    const during = new Date("2026-03-05T12:00:00Z");
    expect(resolveIterationId(cache, 3, "Sprint", "@next", during)).toBe("iter-3a");
  });

  it("returns null for @next when no future iterations exist", () => {
    const cache = makeCache();
    // After all iterations
    const after = new Date("2026-12-01T12:00:00Z");
    expect(resolveIterationId(cache, 3, "Sprint", "@next", after)).toBeNull();
  });

  it("resolves iteration title directly", () => {
    const cache = makeCache();
    expect(resolveIterationId(cache, 3, "Sprint", "Sprint 1")).toBe("iter-1a");
    expect(resolveIterationId(cache, 3, "Sprint", "Sprint 3")).toBe("iter-3a");
  });

  it("returns null for unknown title", () => {
    const cache = makeCache();
    expect(resolveIterationId(cache, 3, "Sprint", "Sprint 99")).toBeNull();
  });

  it("returns null for unknown field name", () => {
    const cache = makeCache();
    expect(resolveIterationId(cache, 3, "NoSuchField", "@current")).toBeNull();
  });

  it("returns null for unpopulated project", () => {
    const cache = makeCache();
    expect(resolveIterationId(cache, 99, "Sprint", "@current")).toBeNull();
  });
});
