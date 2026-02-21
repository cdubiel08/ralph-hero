import { describe, it, expect } from "vitest";
import { FieldOptionCache } from "../lib/cache.js";

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
