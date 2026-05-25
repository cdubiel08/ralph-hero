import { describe, it, expect } from "vitest";
import {
  MatchCriteriaSchema,
  RoutingActionSchema,
  RoutingRuleSchema,
  RoutingConfigSchema,
  validateRoutingConfig,
} from "../lib/routing-types.js";

describe("MatchCriteriaSchema", () => {
  it("accepts repo-only match", () => {
    const result = MatchCriteriaSchema.parse({ repo: "owner/repo" });
    expect(result.repo).toBe("owner/repo");
    expect(result.negate).toBe(false); // default
  });

  it("accepts labels.any match", () => {
    const result = MatchCriteriaSchema.parse({
      labels: { any: ["bug", "critical"] },
    });
    expect(result.labels?.any).toEqual(["bug", "critical"]);
  });

  it("accepts labels.all match", () => {
    const result = MatchCriteriaSchema.parse({
      labels: { all: ["bug", "critical"] },
    });
    expect(result.labels?.all).toEqual(["bug", "critical"]);
  });

  it("accepts issueType match", () => {
    const result = MatchCriteriaSchema.parse({ issueType: "pull_request" });
    expect(result.issueType).toBe("pull_request");
  });

  it("accepts negate flag", () => {
    const result = MatchCriteriaSchema.parse({
      repo: "owner/*",
      negate: true,
    });
    expect(result.negate).toBe(true);
  });

  it("accepts combined criteria", () => {
    const result = MatchCriteriaSchema.parse({
      repo: "org/*",
      labels: { any: ["enhancement"] },
      issueType: "issue",
    });
    expect(result.repo).toBe("org/*");
    expect(result.labels?.any).toEqual(["enhancement"]);
    expect(result.issueType).toBe("issue");
  });

  it("rejects empty match criteria", () => {
    expect(() => MatchCriteriaSchema.parse({})).toThrow(
      /At least one match criterion/,
    );
  });

  it("rejects negate-only without criteria", () => {
    expect(() => MatchCriteriaSchema.parse({ negate: true })).toThrow(
      /At least one match criterion/,
    );
  });

  it("rejects invalid issueType", () => {
    expect(() =>
      MatchCriteriaSchema.parse({ issueType: "invalid" }),
    ).toThrow();
  });
});

describe("RoutingActionSchema", () => {
  it("accepts projectNumber action", () => {
    const result = RoutingActionSchema.parse({ projectNumber: 3 });
    expect(result.projectNumber).toBe(3);
  });

  it("accepts projectNumbers action", () => {
    const result = RoutingActionSchema.parse({ projectNumbers: [3, 5] });
    expect(result.projectNumbers).toEqual([3, 5]);
  });

  it("accepts workflowState action", () => {
    const result = RoutingActionSchema.parse({ workflowState: "Backlog" });
    expect(result.workflowState).toBe("Backlog");
  });

  it("accepts labels action", () => {
    const result = RoutingActionSchema.parse({ labels: ["triaged"] });
    expect(result.labels).toEqual(["triaged"]);
  });

  it("accepts combined actions", () => {
    const result = RoutingActionSchema.parse({
      projectNumber: 3,
      workflowState: "Backlog",
      labels: ["triaged"],
    });
    expect(result.projectNumber).toBe(3);
    expect(result.workflowState).toBe("Backlog");
    expect(result.labels).toEqual(["triaged"]);
  });

  it("rejects empty action", () => {
    expect(() => RoutingActionSchema.parse({})).toThrow(
      /At least one action/,
    );
  });
});

describe("RoutingRuleSchema", () => {
  it("accepts minimal rule", () => {
    const result = RoutingRuleSchema.parse({
      match: { repo: "owner/repo" },
      action: { projectNumber: 3 },
    });
    expect(result.enabled).toBe(true); // default
    expect(result.name).toBeUndefined();
  });

  it("accepts rule with name and enabled=false", () => {
    const result = RoutingRuleSchema.parse({
      name: "Route bugs",
      match: { labels: { any: ["bug"] } },
      action: { workflowState: "Backlog" },
      enabled: false,
    });
    expect(result.name).toBe("Route bugs");
    expect(result.enabled).toBe(false);
  });
});

describe("RoutingConfigSchema", () => {
  it("accepts valid config with version 1", () => {
    const result = RoutingConfigSchema.parse({
      version: 1,
      rules: [
        {
          match: { repo: "owner/repo" },
          action: { projectNumber: 3 },
        },
      ],
    });
    expect(result.version).toBe(1);
    expect(result.stopOnFirstMatch).toBe(true); // default
    expect(result.rules).toHaveLength(1);
  });

  it("accepts config with stopOnFirstMatch=false", () => {
    const result = RoutingConfigSchema.parse({
      version: 1,
      stopOnFirstMatch: false,
      rules: [],
    });
    expect(result.stopOnFirstMatch).toBe(false);
  });

  it("accepts config with empty rules array", () => {
    const result = RoutingConfigSchema.parse({
      version: 1,
      rules: [],
    });
    expect(result.rules).toHaveLength(0);
  });

  it("rejects wrong version number", () => {
    expect(() =>
      RoutingConfigSchema.parse({
        version: 2,
        rules: [],
      }),
    ).toThrow();
  });

  it("rejects missing version", () => {
    expect(() => RoutingConfigSchema.parse({ rules: [] })).toThrow();
  });

  it("rejects missing rules", () => {
    expect(() => RoutingConfigSchema.parse({ version: 1 })).toThrow();
  });
});

describe("validateRoutingConfig", () => {
  it("returns parsed config for valid input", () => {
    const config = validateRoutingConfig({
      version: 1,
      rules: [
        {
          name: "Test rule",
          match: { repo: "owner/repo" },
          action: { projectNumber: 3 },
        },
      ],
    });
    expect(config.version).toBe(1);
    expect(config.rules[0].name).toBe("Test rule");
  });

  it("throws ZodError for invalid input", () => {
    expect(() => validateRoutingConfig({})).toThrow();
  });

  it("applies defaults", () => {
    const config = validateRoutingConfig({
      version: 1,
      rules: [
        {
          match: { repo: "owner/*" },
          action: { projectNumber: 1 },
        },
      ],
    });
    expect(config.stopOnFirstMatch).toBe(true);
    expect(config.rules[0].enabled).toBe(true);
    expect(config.rules[0].match.negate).toBe(false);
  });
});
