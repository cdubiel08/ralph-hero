/**
 * Structural tests for project-tools: verifies tool registrations and
 * helper structure without making API calls.
 *
 * Note: list_project_items was removed in GH-454 (redundant with list_issues).
 * Note: list_project_repos, list_projects, copy_project removed in GH-455 (admin tools).
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const projectToolsSrc = fs.readFileSync(
  path.resolve(__dirname, "../tools/project-tools.ts"),
  "utf-8",
);

// ---------------------------------------------------------------------------
// ensureFieldCacheForNewProject structural tests (GH-242)
// ---------------------------------------------------------------------------

describe("ensureFieldCacheForNewProject structural (GH-242)", () => {
  it("does NOT call fieldCache.clear()", () => {
    expect(projectToolsSrc).not.toContain("fieldCache.clear()");
  });

  it("uses invalidatePrefix for targeted cache invalidation", () => {
    expect(projectToolsSrc).toContain('invalidatePrefix("query:")');
  });
});

// ---------------------------------------------------------------------------
// Removed tools verification (GH-454, GH-455)
// ---------------------------------------------------------------------------

describe("removed tools not present", () => {
  it("list_project_items was removed (GH-454)", () => {
    expect(projectToolsSrc).not.toContain("ralph_hero__list_project_items");
  });

  it("list_projects was removed (GH-455)", () => {
    expect(projectToolsSrc).not.toContain("ralph_hero__list_projects");
  });

  it("copy_project was removed (GH-455)", () => {
    expect(projectToolsSrc).not.toContain("ralph_hero__copy_project");
  });

  it("list_project_repos was removed (GH-455)", () => {
    expect(projectToolsSrc).not.toContain("ralph_hero__list_project_repos");
  });
});

// ---------------------------------------------------------------------------
// Remaining tools verification
// ---------------------------------------------------------------------------

describe("remaining tools present", () => {
  it("setup_project tool remains", () => {
    expect(projectToolsSrc).toContain("ralph_hero__setup_project");
  });

  it("get_project tool remains", () => {
    expect(projectToolsSrc).toContain("ralph_hero__get_project");
  });
});
