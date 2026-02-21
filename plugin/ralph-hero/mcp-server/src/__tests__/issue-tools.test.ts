/**
 * Structural tests for issue-tools: verifies tool parameters, GraphQL query
 * structure, and filter chain completeness without making API calls.
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const issueToolsSrc = fs.readFileSync(
  path.resolve(__dirname, "../tools/issue-tools.ts"),
  "utf-8",
);

describe("list_issues profile param", () => {
  it("has profile param in Zod schema", () => {
    expect(issueToolsSrc).toContain("profile: z");
  });

  it("imports expandProfile", () => {
    expect(issueToolsSrc).toContain(
      'import { expandProfile } from "../lib/filter-profiles.js"',
    );
  });

  it("calls expandProfile when profile is set", () => {
    expect(issueToolsSrc).toContain("expandProfile(args.profile)");
  });

  it("explicit args override profile defaults", () => {
    expect(issueToolsSrc).toContain("=== undefined");
  });
});

describe("list_issues structural", () => {
  it("tool description mentions updatedSince", () => {
    expect(issueToolsSrc).toContain("updatedSince");
  });

  it("tool description mentions updatedBefore", () => {
    expect(issueToolsSrc).toContain("updatedBefore");
  });

  it("GraphQL query fetches updatedAt", () => {
    expect(issueToolsSrc).toContain("updatedAt");
  });

  it("response mapping includes updatedAt", () => {
    expect(issueToolsSrc).toContain("updatedAt: content?.updatedAt");
  });

  it("imports parseDateMath", () => {
    expect(issueToolsSrc).toContain(
      'import { parseDateMath } from "../lib/date-math.js"',
    );
  });

  it("GraphQL query contains stateReason", () => {
    expect(issueToolsSrc).toContain("stateReason");
  });

  it("tool has reason parameter", () => {
    // Verify the reason enum is defined in the Zod schema
    expect(issueToolsSrc).toContain(
      '"completed", "not_planned", "reopened"',
    );
  });

  it("response mapping includes stateReason", () => {
    expect(issueToolsSrc).toContain("stateReason: content?.stateReason");
  });
});

describe("list_issues has/no presence filters structural", () => {
  it("Zod schema includes has param with enum", () => {
    expect(issueToolsSrc).toContain('"workflowState", "estimate", "priority", "labels", "assignees"');
  });

  it("Zod schema includes both has and no params", () => {
    expect(issueToolsSrc).toMatch(/has:\s*z\s*\.array/);
    expect(issueToolsSrc).toMatch(/no:\s*z\s*\.array/);
  });

  it("has filter applies every() check", () => {
    expect(issueToolsSrc).toContain("args.has!.every");
  });

  it("no filter applies every() with negation", () => {
    expect(issueToolsSrc).toContain("!hasField(item, field");
  });

  it("hasField helper handles all five field types", () => {
    expect(issueToolsSrc).toContain('case "workflowState"');
    expect(issueToolsSrc).toContain('case "estimate"');
    expect(issueToolsSrc).toContain('case "priority"');
    expect(issueToolsSrc).toContain('case "labels"');
    expect(issueToolsSrc).toContain('case "assignees"');
  });
});

describe("list_issues exclude negation filters structural", () => {
  it("Zod schema includes excludeWorkflowStates param", () => {
    expect(issueToolsSrc).toContain("excludeWorkflowStates");
  });

  it("Zod schema includes excludeEstimates param", () => {
    expect(issueToolsSrc).toContain("excludeEstimates");
  });

  it("Zod schema includes excludePriorities param", () => {
    expect(issueToolsSrc).toContain("excludePriorities");
  });

  it("Zod schema includes excludeLabels param", () => {
    expect(issueToolsSrc).toContain("excludeLabels");
  });

  it("negation filters use Array.includes for matching", () => {
    expect(issueToolsSrc).toContain("excludeWorkflowStates!.includes");
    expect(issueToolsSrc).toContain("excludeEstimates!.includes");
    expect(issueToolsSrc).toContain("excludePriorities!.includes");
    expect(issueToolsSrc).toContain("excludeLabels!.includes");
  });

  it("items without field values are not excluded via ?? coercion", () => {
    expect(issueToolsSrc).toContain('?? ""');
  });
});
