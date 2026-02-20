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
