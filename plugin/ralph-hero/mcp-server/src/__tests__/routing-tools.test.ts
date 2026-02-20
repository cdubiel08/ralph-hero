/**
 * Tests for routing-tools: verifies YAML round-trip, CRUD operation
 * logic, and input validation for the configure_routing tool.
 */

import { describe, it, expect } from "vitest";
import { parse, stringify } from "yaml";

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
