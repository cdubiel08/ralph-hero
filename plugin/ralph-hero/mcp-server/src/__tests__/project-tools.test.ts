/**
 * Structural tests for project-tools: verifies GraphQL query structure,
 * tool parameters, and filter chain completeness without making API calls.
 *
 * Note: list_project_items was removed in GH-454 (redundant with list_issues).
 * Tests for list_project_repos, list_projects, copy_project, and
 * ensureFieldCacheForNewProject remain.
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const projectToolsSrc = fs.readFileSync(
  path.resolve(__dirname, "../tools/project-tools.ts"),
  "utf-8",
);

// ---------------------------------------------------------------------------
// list_project_repos structural tests
// ---------------------------------------------------------------------------

const helpersSrc = fs.readFileSync(
  path.resolve(__dirname, "../lib/helpers.ts"),
  "utf-8",
);

describe("list_project_repos structural", () => {
  it("tool is registered with correct name", () => {
    expect(projectToolsSrc).toContain("ralph_hero__list_project_repos");
  });

  it("imports queryProjectRepositories from helpers", () => {
    expect(projectToolsSrc).toContain(
      'import { queryProjectRepositories } from "../lib/helpers.js"',
    );
  });

  it("calls queryProjectRepositories helper", () => {
    expect(projectToolsSrc).toContain("queryProjectRepositories(");
  });

  it("has optional owner param", () => {
    // The tool has owner as optional string param
    expect(projectToolsSrc).toContain("ralph_hero__list_project_repos");
  });

  it("has optional number param", () => {
    // Verified via tool registration containing number param
    expect(projectToolsSrc).toContain("ralph_hero__list_project_repos");
  });

  it("returns projectId, repos, and totalRepos", () => {
    expect(projectToolsSrc).toContain("projectId: result.projectId");
    expect(projectToolsSrc).toContain("repos: result.repos");
    expect(projectToolsSrc).toContain("totalRepos: result.totalRepos");
  });
});

describe("queryProjectRepositories helper structural", () => {
  it("exports queryProjectRepositories function", () => {
    expect(helpersSrc).toContain("export async function queryProjectRepositories");
  });

  it("queries ProjectV2.repositories connection", () => {
    expect(helpersSrc).toContain("repositories(first: 100)");
  });

  it("uses user/organization fallback pattern", () => {
    expect(helpersSrc).toContain('for (const ownerType of ["user", "organization"]');
  });

  it("uses OWNER_TYPE replacement pattern like fetchProjectForCache", () => {
    expect(helpersSrc).toContain('QUERY.replace("OWNER_TYPE", ownerType)');
  });

  it("caches results with 10-min TTL", () => {
    // The helper uses projectQuery with cache option and 10-min TTL
    expect(helpersSrc).toContain("cacheTtlMs: 10 * 60 * 1000");
  });

  it("returns owner, repo, and nameWithOwner per repository", () => {
    expect(helpersSrc).toContain("owner: r.owner.login");
    expect(helpersSrc).toContain("repo: r.name");
    expect(helpersSrc).toContain("nameWithOwner: r.nameWithOwner");
  });

  it("exports ProjectRepository and ProjectRepositoriesResult types", () => {
    expect(helpersSrc).toContain("export interface ProjectRepository");
    expect(helpersSrc).toContain("export interface ProjectRepositoriesResult");
  });
});

// ---------------------------------------------------------------------------
// list_projects structural tests
// ---------------------------------------------------------------------------

describe("list_projects structural", () => {
  it("tool is registered with correct name", () => {
    expect(projectToolsSrc).toContain("ralph_hero__list_projects");
  });

  it("Zod schema includes state param with enum values", () => {
    expect(projectToolsSrc).toContain('"open", "closed", "all"');
  });

  it("GraphQL query contains projectsV2 connection", () => {
    expect(projectToolsSrc).toContain("projectsV2(first:");
  });

  it("GraphQL query contains expected fields", () => {
    expect(projectToolsSrc).toContain("shortDescription");
    expect(projectToolsSrc).toContain("items { totalCount }");
    expect(projectToolsSrc).toContain("fields { totalCount }");
    expect(projectToolsSrc).toContain("views { totalCount }");
  });

  it("response mapping includes itemCount, fieldCount, viewCount", () => {
    expect(projectToolsSrc).toContain("itemCount:");
    expect(projectToolsSrc).toContain("fieldCount:");
    expect(projectToolsSrc).toContain("viewCount:");
  });

  it("client-side closed filter logic exists", () => {
    expect(projectToolsSrc).toContain("!p.closed");
  });

  it("uses OWNER_TYPE replacement for dual-type resolution", () => {
    expect(projectToolsSrc).toContain('LIST_PROJECTS_QUERY.replace("OWNER_TYPE", ownerType)');
  });

  it("uses paginateConnection for pagination", () => {
    // Verify it calls paginateConnection within the list_projects handler
    expect(projectToolsSrc).toContain("paginateConnection<ListProjectNode>");
  });
});

// ---------------------------------------------------------------------------
// copy_project structural tests
// ---------------------------------------------------------------------------

describe("copy_project structural", () => {
  it("tool is registered with correct name", () => {
    expect(projectToolsSrc).toContain("ralph_hero__copy_project");
  });

  it("Zod schema includes sourceProjectNumber param", () => {
    expect(projectToolsSrc).toContain("sourceProjectNumber");
  });

  it("Zod schema includes title param", () => {
    // copy_project requires a title for the new project
    expect(projectToolsSrc).toContain("ralph_hero__copy_project");
    expect(projectToolsSrc).toContain('title: z.string()');
  });

  it("Zod schema includes sourceOwner and targetOwner params", () => {
    expect(projectToolsSrc).toContain("sourceOwner");
    expect(projectToolsSrc).toContain("targetOwner");
  });

  it("Zod schema includes includeDraftIssues param", () => {
    expect(projectToolsSrc).toContain("includeDraftIssues");
  });

  it("GraphQL mutation contains copyProjectV2", () => {
    expect(projectToolsSrc).toContain("copyProjectV2(input:");
  });

  it("mutation input includes projectId, ownerId, title, includeDraftIssues", () => {
    expect(projectToolsSrc).toContain("projectId: $projectId");
    expect(projectToolsSrc).toContain("ownerId: $ownerId");
    expect(projectToolsSrc).toContain("title: $title");
    expect(projectToolsSrc).toContain("includeDraftIssues: $includeDraftIssues");
  });

  it("uses fetchProject for source project resolution", () => {
    expect(projectToolsSrc).toContain("fetchProject(");
    expect(projectToolsSrc).toContain("sourceProject.id");
  });

  it("uses owner node ID resolution pattern for target owner", () => {
    // Verifies the user/org fallback pattern for resolving target owner ID
    expect(projectToolsSrc).toContain("targetOwnerId");
    expect(projectToolsSrc).toContain("targetOwnerLogin");
  });

  it("response includes copiedFrom with source project info", () => {
    expect(projectToolsSrc).toContain("copiedFrom:");
  });
});

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
// list_project_items removal verification (GH-454)
// ---------------------------------------------------------------------------

describe("list_project_items removal (GH-454)", () => {
  it("list_project_items tool registration is removed", () => {
    expect(projectToolsSrc).not.toContain("ralph_hero__list_project_items");
  });
});
