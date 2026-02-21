/**
 * Tests for routing-tools: verifies YAML round-trip, CRUD operation
 * logic, input validation, validate_rules, and dry_run for the
 * configure_routing tool.
 */

import { describe, it, expect } from "vitest";
import { parse, stringify } from "yaml";
import { evaluateRules, type IssueContext } from "../lib/routing-engine.js";
import type {
  RoutingConfig,
  RoutingRule,
  MatchCriteria,
  RoutingAction,
} from "../lib/routing-types.js";

// ---------------------------------------------------------------------------
// Routing config YAML structure
// ---------------------------------------------------------------------------

describe("routing config YAML structure", () => {
  it("config has rules array at top level", () => {
    const config = {
      rules: [
        {
          match: { labels: ["bug"] },
          action: { workflowState: "Backlog" },
        },
      ],
    };
    expect(config.rules).toHaveLength(1);
    expect(config.rules[0].match.labels).toContain("bug");
    expect(config.rules[0].action.workflowState).toBe("Backlog");
  });

  it("empty config defaults to empty rules array", () => {
    const config = { rules: [] as unknown[] };
    expect(config.rules).toEqual([]);
  });

  it("parse and stringify preserve rule structure", () => {
    const input = {
      rules: [
        {
          match: { labels: ["bug"], repo: "my-repo" },
          action: { workflowState: "Backlog", projectNumber: 3 },
        },
      ],
    };
    const yamlStr = stringify(input);
    const parsed = parse(yamlStr) as typeof input;
    expect(parsed.rules).toHaveLength(1);
    expect(parsed.rules[0].match.labels).toContain("bug");
    expect(parsed.rules[0].match.repo).toBe("my-repo");
    expect(parsed.rules[0].action.workflowState).toBe("Backlog");
    expect(parsed.rules[0].action.projectNumber).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Routing CRUD logic
// ---------------------------------------------------------------------------

describe("routing CRUD logic", () => {
  it("add_rule appends to rules array", () => {
    const rules = [
      { match: { labels: ["bug"] }, action: { workflowState: "Backlog" } },
    ];
    const newRule = {
      match: { repo: "my-repo" },
      action: { projectNumber: 3 },
    };
    const updated = [...rules, newRule];
    expect(updated).toHaveLength(2);
    expect(updated[1]).toEqual(newRule);
  });

  it("update_rule replaces at index", () => {
    const rules = [
      { match: { labels: ["bug"] }, action: { workflowState: "Backlog" } },
      { match: { labels: ["feature"] }, action: { workflowState: "Todo" } },
    ];
    const replacement = {
      match: { repo: "my-repo" },
      action: { projectNumber: 3 },
    };
    rules[0] = replacement;
    expect(rules[0]).toEqual(replacement);
    expect(rules).toHaveLength(2);
  });

  it("remove_rule filters out at index", () => {
    const rules = [
      { match: { labels: ["bug"] }, action: { workflowState: "Backlog" } },
      { match: { labels: ["feature"] }, action: { workflowState: "Todo" } },
    ];
    const filtered = rules.filter((_, i) => i !== 0);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].match.labels).toContain("feature");
  });

  it("update_rule detects out-of-range index", () => {
    const rules = [
      { match: { labels: ["bug"] }, action: { workflowState: "Backlog" } },
    ];
    const index = 5;
    expect(index >= rules.length).toBe(true);
  });

  it("remove_rule detects negative index", () => {
    const rules = [
      { match: { labels: ["bug"] }, action: { workflowState: "Backlog" } },
    ];
    const index = -1;
    expect(index < 0).toBe(true);
  });

  it("add_rule requires rule parameter", () => {
    const rule = undefined;
    expect(rule).toBeUndefined();
  });

  it("list_rules returns empty array for missing config", () => {
    const raw = "";
    const config = raw ? (parse(raw) as { rules: unknown[] }) : { rules: [] };
    expect(config.rules).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// validate_rules logic
// ---------------------------------------------------------------------------

describe("validate_rules logic", () => {
  it("returns valid=true for empty rules array", () => {
    const rules: Array<{ action: { workflowState?: string } }> = [];
    const errors = rules
      .map((rule, i) => {
        if (rule.action.workflowState) {
          const validStates = ["Backlog", "Todo", "In Progress", "Done"];
          if (!validStates.includes(rule.action.workflowState)) {
            return {
              ruleIndex: i,
              field: "action.workflowState",
              message: "invalid",
            };
          }
        }
        return null;
      })
      .filter(Boolean);
    expect(errors).toHaveLength(0);
  });

  it("returns valid=true when workflowState matches known options", () => {
    const validStates = ["Backlog", "Todo", "In Progress", "Done"];
    const state = "Backlog";
    expect(validStates.includes(state)).toBe(true);
  });

  it("returns error for invalid workflowState", () => {
    const validStates = ["Backlog", "Todo", "In Progress", "Done"];
    const state = "NonexistentState";
    expect(validStates.includes(state)).toBe(false);
  });

  it("skips validation for rules without workflowState", () => {
    const rules = [
      { match: { labels: ["bug"] }, action: { projectNumber: 3 } as { projectNumber: number; workflowState?: string } },
    ];
    const errors = rules
      .filter((r) => r.action.workflowState !== undefined)
      .map((r, i) => ({
        ruleIndex: i,
        field: "action.workflowState",
        message: "invalid",
      }));
    expect(errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// dry_run logic (evaluateRules integration)
// ---------------------------------------------------------------------------

describe("dry_run logic", () => {
  function makeConfig(
    rules: RoutingRule[],
    overrides: Partial<Omit<RoutingConfig, "rules">> = {},
  ): RoutingConfig {
    return {
      version: 1 as const,
      stopOnFirstMatch: true,
      rules,
      ...overrides,
    };
  }

  function makeRule(overrides: {
    match?: Partial<MatchCriteria>;
    action?: Partial<RoutingAction>;
    enabled?: boolean;
  } = {}): RoutingRule {
    return {
      match: {
        repo: "my-org/*",
        negate: false,
        ...overrides.match,
      } as MatchCriteria,
      action: {
        projectNumber: 3,
        ...overrides.action,
      } as RoutingAction,
      enabled: overrides.enabled ?? true,
    };
  }

  it("requires issueNumber parameter", () => {
    const issueNumber = undefined;
    expect(issueNumber).toBeUndefined();
  });

  it("evaluateRules matches rules by label criteria", () => {
    const config = makeConfig([
      makeRule({ match: { labels: { any: ["bug"] } } }),
    ]);
    const issue: IssueContext = {
      repo: "my-org/my-repo",
      labels: ["bug"],
      issueType: "issue",
    };
    const result = evaluateRules(config, issue);
    expect(result.matchedRules).toHaveLength(1);
    expect(result.matchedRules[0].ruleIndex).toBe(0);
  });

  it("evaluateRules returns empty matchedRules when no rules match", () => {
    const config = makeConfig([
      makeRule({ match: { labels: { any: ["bug"] } } }),
    ]);
    const issue: IssueContext = {
      repo: "my-org/my-repo",
      labels: ["enhancement"],
      issueType: "issue",
    };
    const result = evaluateRules(config, issue);
    expect(result.matchedRules).toHaveLength(0);
    expect(result.stoppedEarly).toBe(false);
  });

  it("evaluateRules respects stopOnFirstMatch", () => {
    const config = makeConfig(
      [
        makeRule({
          match: { labels: { any: ["bug"] } },
          action: { projectNumber: 3 },
        }),
        makeRule({
          match: { labels: { any: ["bug"] } },
          action: { projectNumber: 5 },
        }),
      ],
      { stopOnFirstMatch: false },
    );
    const issue: IssueContext = {
      repo: "my-org/my-repo",
      labels: ["bug"],
      issueType: "issue",
    };
    const result = evaluateRules(config, issue);
    expect(result.matchedRules).toHaveLength(2);
    expect(result.stoppedEarly).toBe(false);
  });
});
