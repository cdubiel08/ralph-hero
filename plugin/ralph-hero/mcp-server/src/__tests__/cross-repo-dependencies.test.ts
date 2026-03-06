/**
 * Tests for cross-repo dependency tooling (GH-539):
 * - add_dependency / remove_dependency cross-repo param resolution
 * - list_dependencies response shape
 * - decompose_feature addBlockedBy wiring
 * - group-detection cross-repo expansion
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const relationshipSrc = fs.readFileSync(
  path.resolve(__dirname, "../tools/relationship-tools.ts"),
  "utf-8",
);

const decomposeSrc = fs.readFileSync(
  path.resolve(__dirname, "../tools/decompose-tools.ts"),
  "utf-8",
);

const groupDetectionSrc = fs.readFileSync(
  path.resolve(__dirname, "../lib/group-detection.ts"),
  "utf-8",
);

// ---------------------------------------------------------------------------
// add_dependency cross-repo
// ---------------------------------------------------------------------------

describe("add_dependency cross-repo (GH-539)", () => {
  it("has blockedOwner parameter", () => {
    expect(relationshipSrc).toContain("blockedOwner:");
  });

  it("has blockedRepo parameter", () => {
    expect(relationshipSrc).toContain("blockedRepo:");
  });

  it("has blockingOwner parameter", () => {
    expect(relationshipSrc).toContain("blockingOwner:");
  });

  it("has blockingRepo parameter", () => {
    expect(relationshipSrc).toContain("blockingRepo:");
  });

  it("resolves blocked issue with per-side owner/repo", () => {
    expect(relationshipSrc).toContain("args.blockedOwner || owner");
    expect(relationshipSrc).toContain("args.blockedRepo || repo");
  });

  it("resolves blocking issue with per-side owner/repo", () => {
    expect(relationshipSrc).toContain("args.blockingOwner || owner");
    expect(relationshipSrc).toContain("args.blockingRepo || repo");
  });

  it("returns repository in response", () => {
    // Verify the addBlockedBy mutation selects repository { nameWithOwner }
    expect(relationshipSrc).toContain(
      "issue { id number title repository { nameWithOwner } }",
    );
  });

  it("describes cross-repo support in tool description", () => {
    expect(relationshipSrc).toContain(
      "Supports cross-repo",
    );
  });
});

// ---------------------------------------------------------------------------
// remove_dependency cross-repo
// ---------------------------------------------------------------------------

describe("remove_dependency cross-repo (GH-539)", () => {
  it("has blockedOwner parameter", () => {
    // Verify remove_dependency section also has per-side params
    const removeSection = relationshipSrc.slice(
      relationshipSrc.indexOf("ralph_hero__remove_dependency"),
    );
    expect(removeSection).toContain("blockedOwner:");
    expect(removeSection).toContain("blockedRepo:");
    expect(removeSection).toContain("blockingOwner:");
    expect(removeSection).toContain("blockingRepo:");
  });

  it("resolves per-side owner/repo with fallback", () => {
    const removeSection = relationshipSrc.slice(
      relationshipSrc.indexOf("ralph_hero__remove_dependency"),
    );
    expect(removeSection).toContain("args.blockedOwner || owner");
    expect(removeSection).toContain("args.blockingOwner || owner");
  });

  it("returns repository in remove_dependency response", () => {
    const removeSection = relationshipSrc.slice(
      relationshipSrc.indexOf("ralph_hero__remove_dependency"),
    );
    expect(removeSection).toContain("repository { nameWithOwner }");
  });
});

// ---------------------------------------------------------------------------
// list_dependencies
// ---------------------------------------------------------------------------

describe("list_dependencies (GH-539)", () => {
  it("is registered as ralph_hero__list_dependencies", () => {
    expect(relationshipSrc).toContain('"ralph_hero__list_dependencies"');
  });

  it("queries blocking(first: 50) and blockedBy(first: 50)", () => {
    expect(relationshipSrc).toContain("blocking(first: 50)");
    expect(relationshipSrc).toContain("blockedBy(first: 50)");
  });

  it("selects repository { nameWithOwner } on dependency nodes", () => {
    // The list_dependencies query should include repo info
    const listSection = relationshipSrc.slice(
      relationshipSrc.indexOf("ralph_hero__list_dependencies"),
    );
    expect(listSection).toContain("repository { nameWithOwner }");
  });

  it("returns summary with blockingCount and blockedByCount", () => {
    const listSection = relationshipSrc.slice(
      relationshipSrc.indexOf("ralph_hero__list_dependencies"),
    );
    expect(listSection).toContain("blockingCount");
    expect(listSection).toContain("blockedByCount");
    expect(listSection).toContain("isBlocked");
    expect(listSection).toContain("isBlocking");
  });

  it("returns issue info with repository field", () => {
    const listSection = relationshipSrc.slice(
      relationshipSrc.indexOf("ralph_hero__list_dependencies"),
    );
    expect(listSection).toContain("repository:");
  });
});

// ---------------------------------------------------------------------------
// decompose_feature: addBlockedBy wiring
// ---------------------------------------------------------------------------

describe("decompose_feature blockedBy wiring (GH-539)", () => {
  it("uses addBlockedBy instead of addSubIssue for dependency wiring", () => {
    expect(decomposeSrc).toContain("addBlockedBy");
    // Should NOT contain addSubIssue in the wiring section
    const wiringSection = decomposeSrc.slice(
      decomposeSrc.indexOf("Step 5"),
    );
    expect(wiringSection).not.toContain("addSubIssue");
  });

  it("wiring results include type: blockedBy", () => {
    expect(decomposeSrc).toContain('type: "blockedBy"');
  });

  it("maps edge direction correctly: blockingRepo blocks blockedRepo", () => {
    // "a -> b" means a blocks b, so b is blocked by a
    // Variables should be: blockedId = b, blockingId = a
    const wiringSection = decomposeSrc.slice(
      decomposeSrc.indexOf("Step 5"),
    );
    expect(wiringSection).toContain("blockingRepo, blockedRepo");
    expect(wiringSection).toContain("blockedId: blockedIssue.id, blockingId: blockingIssue.id");
  });

  it("JSDoc describes blocking dependency edges", () => {
    expect(decomposeSrc).toContain(
      "Blocking dependency edges from the pattern",
    );
  });
});

// ---------------------------------------------------------------------------
// group-detection cross-repo
// ---------------------------------------------------------------------------

describe("group-detection cross-repo (GH-539)", () => {
  it("IssueRelationData includes repoOwner and repoName", () => {
    expect(groupDetectionSrc).toContain("repoOwner: string;");
    expect(groupDetectionSrc).toContain("repoName: string;");
  });

  it("GroupIssue includes optional repository field", () => {
    expect(groupDetectionSrc).toContain('repository?: string;');
  });

  it("SEED_QUERY includes repository info on blocking/blockedBy nodes", () => {
    // Check that the seed query fetches repo info for dependency nodes
    expect(groupDetectionSrc).toContain(
      "repository { owner { login } name }",
    );
  });

  it("tracks cross-repo info in depRepoInfo map", () => {
    expect(groupDetectionSrc).toContain("depRepoInfo");
    expect(groupDetectionSrc).toContain(
      "new Map<number, { owner: string; repo: string }>()",
    );
  });

  it("uses cross-repo info for expand queries", () => {
    expect(groupDetectionSrc).toContain("depRepoInfo.get(num)");
    expect(groupDetectionSrc).toContain("crossRepoInfo?.owner ?? owner");
    expect(groupDetectionSrc).toContain("crossRepoInfo?.repo ?? repo");
  });

  it("addIssueToMap merges repoOwner and repoName", () => {
    expect(groupDetectionSrc).toContain(
      "if (!existing.repoOwner && data.repoOwner) existing.repoOwner = data.repoOwner;",
    );
    expect(groupDetectionSrc).toContain(
      "if (!existing.repoName && data.repoName) existing.repoName = data.repoName;",
    );
  });

  it("populates repository on GroupIssue only for cross-repo issues", () => {
    expect(groupDetectionSrc).toContain(
      "issue.repoOwner !== owner || issue.repoName !== repo",
    );
  });

  it("EXPAND_QUERY also includes repository info on dep nodes", () => {
    // Both queries should have repository info
    const expandSection = groupDetectionSrc.slice(
      groupDetectionSrc.indexOf("EXPAND_QUERY"),
    );
    expect(expandSection).toContain("repository { owner { login } name }");
  });
});
