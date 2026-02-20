/**
 * Structural tests for project-tools: verifies GraphQL query structure,
 * tool parameters, and filter chain completeness without making API calls.
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const projectToolsSrc = fs.readFileSync(
  path.resolve(__dirname, "../tools/project-tools.ts"),
  "utf-8",
);

describe("list_project_items profile param", () => {
  it("has profile param in Zod schema", () => {
    expect(projectToolsSrc).toContain("profile: z");
  });

  it("imports expandProfile", () => {
    expect(projectToolsSrc).toContain(
      'import { expandProfile } from "../lib/filter-profiles.js"',
    );
  });

  it("calls expandProfile when profile is set", () => {
    expect(projectToolsSrc).toContain("expandProfile(args.profile)");
  });
});

describe("list_project_items structural", () => {
  it("GraphQL query contains updatedAt in Issue fragment", () => {
    // Verify updatedAt is fetched in the Issue content fragment
    expect(projectToolsSrc).toContain("updatedAt");
  });

  it("tool has updatedSince parameter", () => {
    expect(projectToolsSrc).toContain("updatedSince");
  });

  it("tool has updatedBefore parameter", () => {
    expect(projectToolsSrc).toContain("updatedBefore");
  });

  it("response mapping includes updatedAt", () => {
    expect(projectToolsSrc).toContain("updatedAt: content?.updatedAt");
  });

  it("imports parseDateMath", () => {
    expect(projectToolsSrc).toContain(
      'import { parseDateMath } from "../lib/date-math.js"',
    );
  });

  it("tool has itemType parameter", () => {
    expect(projectToolsSrc).toContain("itemType");
    expect(projectToolsSrc).toContain(
      '"ISSUE", "PULL_REQUEST", "DRAFT_ISSUE"',
    );
  });
});
