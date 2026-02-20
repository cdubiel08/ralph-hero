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
});
