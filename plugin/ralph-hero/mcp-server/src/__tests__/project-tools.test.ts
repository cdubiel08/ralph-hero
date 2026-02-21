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
