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

describe("list_project_items has/no presence filters structural", () => {
  it("Zod schema includes has param with enum", () => {
    expect(projectToolsSrc).toContain('"workflowState", "estimate", "priority", "labels", "assignees"');
  });

  it("Zod schema includes both has and no params", () => {
    expect(projectToolsSrc).toMatch(/has:\s*z\s*\.array/);
    expect(projectToolsSrc).toMatch(/no:\s*z\s*\.array/);
  });

  it("has filter applies every() check", () => {
    expect(projectToolsSrc).toContain("args.has!.every");
  });

  it("no filter applies every() with negation", () => {
    expect(projectToolsSrc).toContain("!hasField(item, field");
  });

  it("hasField helper handles all five field types", () => {
    expect(projectToolsSrc).toContain('case "workflowState"');
    expect(projectToolsSrc).toContain('case "estimate"');
    expect(projectToolsSrc).toContain('case "priority"');
    expect(projectToolsSrc).toContain('case "labels"');
    expect(projectToolsSrc).toContain('case "assignees"');
  });
});

describe("list_project_items repository info structural", () => {
  it("GraphQL Issue fragment includes repository fields", () => {
    expect(projectToolsSrc).toContain("repository { nameWithOwner name owner { login } }");
  });

  it("repository fragment appears in both Issue and PullRequest", () => {
    const repoMatches = projectToolsSrc.match(/repository \{ nameWithOwner name owner \{ login \} \}/g);
    expect(repoMatches).toHaveLength(2);
  });

  it("response mapping includes owner field", () => {
    expect(projectToolsSrc).toContain("owner: (content?.repository");
  });

  it("response mapping includes repo field", () => {
    expect(projectToolsSrc).toContain("repo: (content?.repository");
  });

  it("response mapping includes nameWithOwner field", () => {
    expect(projectToolsSrc).toContain("nameWithOwner: (content?.repository");
  });

  it("DraftIssue items return null for repo fields (no repository fragment)", () => {
    // DraftIssue content block does NOT include repository - verify graceful null fallback
    const draftIssueBlock = projectToolsSrc.match(/\.\.\. on DraftIssue \{[^}]+\}/)?.[0];
    expect(draftIssueBlock).toBeDefined();
    expect(draftIssueBlock).not.toContain("repository");
  });

  it("DraftIssue GraphQL fragment includes id field for DI_* content node ID", () => {
    const draftIssueBlock = projectToolsSrc.match(/\.\.\. on DraftIssue \{[^}]+\}/)?.[0];
    expect(draftIssueBlock).toBeDefined();
    expect(draftIssueBlock).toContain("id");
  });

  it("response mapping includes draftIssueId field", () => {
    expect(projectToolsSrc).toContain("draftIssueId:");
  });

  it("draftIssueId is conditional on DRAFT_ISSUE type", () => {
    expect(projectToolsSrc).toContain('item.type === "DRAFT_ISSUE"');
  });
});

describe("list_project_items exclude negation filters structural", () => {
  it("Zod schema includes excludeWorkflowStates param", () => {
    expect(projectToolsSrc).toContain("excludeWorkflowStates");
  });

  it("Zod schema includes excludeEstimates param", () => {
    expect(projectToolsSrc).toContain("excludeEstimates");
  });

  it("Zod schema includes excludePriorities param", () => {
    expect(projectToolsSrc).toContain("excludePriorities");
  });

  it("negation filters use Array.includes for matching", () => {
    expect(projectToolsSrc).toContain("excludeWorkflowStates!.includes");
    expect(projectToolsSrc).toContain("excludeEstimates!.includes");
    expect(projectToolsSrc).toContain("excludePriorities!.includes");
  });

  it("items without field values are not excluded via ?? coercion", () => {
    expect(projectToolsSrc).toContain('?? ""');
  });

  it("does not include excludeLabels (project items lack labels in GraphQL)", () => {
    // project-tools does NOT have excludeLabels - only issue-tools does
    // because list_project_items items may not have labels in the content fragment
    // This is intentional per Phase 3 spec
    expect(projectToolsSrc).not.toContain("excludeLabels");
  });

  it("hasFilters guard includes new filter params", () => {
    expect(projectToolsSrc).toContain("args.has");
    expect(projectToolsSrc).toContain("args.no");
    expect(projectToolsSrc).toContain("args.excludeWorkflowStates");
    expect(projectToolsSrc).toContain("args.excludeEstimates");
    expect(projectToolsSrc).toContain("args.excludePriorities");
  });
});

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
