/**
 * Tests for view-tools: source inspection and pure-function tests
 * for the create_views tool and toRestLayout converter.
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { toRestLayout } from "../tools/view-tools.js";

const viewToolsSrc = fs.readFileSync(
  path.resolve(__dirname, "../tools/view-tools.ts"),
  "utf-8",
);

describe("view-tools source structure", () => {
  it("registers ralph_hero__create_views tool", () => {
    expect(viewToolsSrc).toContain("ralph_hero__create_views");
  });

  it("has sourceProjectNumber param", () => {
    expect(viewToolsSrc).toContain("sourceProjectNumber");
  });

  it("has targetProjectNumber param", () => {
    expect(viewToolsSrc).toContain("targetProjectNumber");
  });

  it("imports fetchProjectViews from project-tools", () => {
    expect(viewToolsSrc).toContain("fetchProjectViews");
  });

  it("calls restPost on client", () => {
    expect(viewToolsSrc).toContain("client.restPost");
  });
});

describe("toRestLayout", () => {
  it("converts TABLE_LAYOUT to table", () => {
    expect(toRestLayout("TABLE_LAYOUT")).toBe("table");
  });

  it("converts BOARD_LAYOUT to board", () => {
    expect(toRestLayout("BOARD_LAYOUT")).toBe("board");
  });

  it("converts ROADMAP_LAYOUT to roadmap", () => {
    expect(toRestLayout("ROADMAP_LAYOUT")).toBe("roadmap");
  });
});
