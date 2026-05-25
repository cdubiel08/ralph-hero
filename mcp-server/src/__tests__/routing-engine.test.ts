import { describe, it, expect } from "vitest";
import {
  evaluateRules,
  type IssueContext,
  type EvaluationResult,
} from "../lib/routing-engine.js";
import type {
  RoutingConfig,
  RoutingRule,
  RoutingAction,
  MatchCriteria,
} from "../lib/routing-types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIssue(overrides: Partial<IssueContext> = {}): IssueContext {
  return {
    repo: "my-org/my-repo",
    labels: [],
    issueType: "issue",
    ...overrides,
  };
}

function makeRule(overrides: {
  match?: Partial<MatchCriteria>;
  action?: Partial<RoutingAction>;
  name?: string;
  enabled?: boolean;
} = {}): RoutingRule {
  return {
    name: overrides.name ?? "test-rule",
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

// ---------------------------------------------------------------------------
// Basic matching
// ---------------------------------------------------------------------------

describe("evaluateRules - basic matching", () => {
  it("matches rule with repo glob pattern", () => {
    const config = makeConfig([makeRule({ match: { repo: "my-org/*" } })]);
    const result = evaluateRules(config, makeIssue({ repo: "my-org/my-repo" }));
    expect(result.matchedRules).toHaveLength(1);
    expect(result.matchedRules[0].ruleIndex).toBe(0);
  });

  it("matches rule with labels.any criteria", () => {
    const config = makeConfig([
      makeRule({ match: { labels: { any: ["bug", "critical"] } } }),
    ]);
    const result = evaluateRules(config, makeIssue({ labels: ["bug"] }));
    expect(result.matchedRules).toHaveLength(1);
  });

  it("matches rule with labels.all criteria", () => {
    const config = makeConfig([
      makeRule({ match: { labels: { all: ["bug", "critical"] } } }),
    ]);
    const result = evaluateRules(
      config,
      makeIssue({ labels: ["bug", "critical", "p1"] }),
    );
    expect(result.matchedRules).toHaveLength(1);
  });

  it("matches rule with issueType criteria", () => {
    const config = makeConfig([
      makeRule({ match: { issueType: "pull_request" } }),
    ]);
    const result = evaluateRules(
      config,
      makeIssue({ issueType: "pull_request" }),
    );
    expect(result.matchedRules).toHaveLength(1);
  });

  it("returns empty matchedRules when no rules match", () => {
    const config = makeConfig([
      makeRule({ match: { repo: "other-org/*" } }),
    ]);
    const result = evaluateRules(config, makeIssue({ repo: "my-org/my-repo" }));
    expect(result.matchedRules).toHaveLength(0);
    expect(result.stoppedEarly).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Combined criteria (AND logic)
// ---------------------------------------------------------------------------

describe("evaluateRules - AND logic", () => {
  it("requires ALL specified criteria to match (repo + labels)", () => {
    const config = makeConfig([
      makeRule({
        match: { repo: "my-org/*", labels: { any: ["bug"] } },
      }),
    ]);
    // repo matches but labels don't
    const result = evaluateRules(
      config,
      makeIssue({ repo: "my-org/my-repo", labels: ["enhancement"] }),
    );
    expect(result.matchedRules).toHaveLength(0);
  });

  it("treats omitted criteria as 'match anything'", () => {
    // Rule with only repo — should match any labels and any issueType
    const config = makeConfig([makeRule({ match: { repo: "my-org/*" } })]);
    const result = evaluateRules(
      config,
      makeIssue({
        repo: "my-org/my-repo",
        labels: ["anything"],
        issueType: "draft_issue",
      }),
    );
    expect(result.matchedRules).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Label edge cases
// ---------------------------------------------------------------------------

describe("evaluateRules - label edge cases", () => {
  it("labels.any matches if issue has at least one matching label", () => {
    const config = makeConfig([
      makeRule({ match: { labels: { any: ["bug", "critical", "p0"] } } }),
    ]);
    const result = evaluateRules(config, makeIssue({ labels: ["critical"] }));
    expect(result.matchedRules).toHaveLength(1);
  });

  it("labels.all fails if issue is missing any required label", () => {
    const config = makeConfig([
      makeRule({ match: { labels: { all: ["bug", "critical"] } } }),
    ]);
    const result = evaluateRules(config, makeIssue({ labels: ["bug"] }));
    expect(result.matchedRules).toHaveLength(0);
  });

  it("label matching is case-insensitive", () => {
    const config = makeConfig([
      makeRule({ match: { labels: { any: ["Bug"] } } }),
    ]);
    const result = evaluateRules(config, makeIssue({ labels: ["bug"] }));
    expect(result.matchedRules).toHaveLength(1);
  });

  it("both labels.any and labels.all must be satisfied when both specified", () => {
    const config = makeConfig([
      makeRule({
        match: {
          labels: { any: ["enhancement", "feature"], all: ["reviewed"] },
        },
      }),
    ]);
    // has "enhancement" (any satisfied) but missing "reviewed" (all not satisfied)
    const noAll = evaluateRules(
      config,
      makeIssue({ labels: ["enhancement"] }),
    );
    expect(noAll.matchedRules).toHaveLength(0);

    // has "reviewed" (all satisfied) but missing any match
    const noAny = evaluateRules(
      config,
      makeIssue({ labels: ["reviewed", "bug"] }),
    );
    expect(noAny.matchedRules).toHaveLength(0);

    // both satisfied
    const both = evaluateRules(
      config,
      makeIssue({ labels: ["enhancement", "reviewed"] }),
    );
    expect(both.matchedRules).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Negate
// ---------------------------------------------------------------------------

describe("evaluateRules - negate", () => {
  it("negate: true inverts the match result", () => {
    const config = makeConfig([
      makeRule({ match: { repo: "my-org/*", negate: true } }),
    ]);
    // repo matches, but negate inverts -> no match
    const result = evaluateRules(config, makeIssue({ repo: "my-org/my-repo" }));
    expect(result.matchedRules).toHaveLength(0);

    // repo doesn't match, negate inverts -> match
    const result2 = evaluateRules(
      config,
      makeIssue({ repo: "other-org/repo" }),
    );
    expect(result2.matchedRules).toHaveLength(1);
  });

  it("negate: false (default) does not invert", () => {
    const config = makeConfig([
      makeRule({ match: { repo: "my-org/*", negate: false } }),
    ]);
    const result = evaluateRules(config, makeIssue({ repo: "my-org/my-repo" }));
    expect(result.matchedRules).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Enabled/disabled
// ---------------------------------------------------------------------------

describe("evaluateRules - enabled/disabled", () => {
  it("skips rules with enabled: false", () => {
    const config = makeConfig([
      makeRule({ match: { repo: "my-org/*" }, enabled: false }),
    ]);
    const result = evaluateRules(config, makeIssue({ repo: "my-org/my-repo" }));
    expect(result.matchedRules).toHaveLength(0);
  });

  it("includes rules with enabled: true or undefined", () => {
    const explicitTrue = makeRule({ match: { repo: "my-org/*" }, enabled: true });
    const implicitTrue = makeRule({ match: { repo: "my-org/*" } });
    // enabled defaults to true via Zod, but in raw object it could be undefined
    delete (implicitTrue as Record<string, unknown>).enabled;
    const config = makeConfig([explicitTrue, implicitTrue], {
      stopOnFirstMatch: false,
    });
    const result = evaluateRules(config, makeIssue({ repo: "my-org/my-repo" }));
    expect(result.matchedRules).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// stopOnFirstMatch
// ---------------------------------------------------------------------------

describe("evaluateRules - stopOnFirstMatch", () => {
  it("stops after first match when stopOnFirstMatch: true (default)", () => {
    const config = makeConfig([
      makeRule({ match: { repo: "my-org/*" }, name: "rule-1" }),
      makeRule({ match: { repo: "my-org/*" }, name: "rule-2" }),
    ]);
    const result = evaluateRules(config, makeIssue({ repo: "my-org/my-repo" }));
    expect(result.matchedRules).toHaveLength(1);
    expect(result.matchedRules[0].rule.name).toBe("rule-1");
  });

  it("continues evaluating all rules when stopOnFirstMatch: false", () => {
    const config = makeConfig(
      [
        makeRule({ match: { repo: "my-org/*" }, name: "rule-1" }),
        makeRule({ match: { repo: "my-org/*" }, name: "rule-2" }),
      ],
      { stopOnFirstMatch: false },
    );
    const result = evaluateRules(config, makeIssue({ repo: "my-org/my-repo" }));
    expect(result.matchedRules).toHaveLength(2);
  });

  it("sets stoppedEarly: true when stopped early", () => {
    const config = makeConfig([
      makeRule({ match: { repo: "my-org/*" } }),
      makeRule({ match: { repo: "my-org/*" } }),
    ]);
    const result = evaluateRules(config, makeIssue({ repo: "my-org/my-repo" }));
    expect(result.stoppedEarly).toBe(true);
  });

  it("sets stoppedEarly: false when all rules evaluated", () => {
    const config = makeConfig(
      [
        makeRule({ match: { repo: "my-org/*" } }),
        makeRule({ match: { repo: "my-org/*" } }),
      ],
      { stopOnFirstMatch: false },
    );
    const result = evaluateRules(config, makeIssue({ repo: "my-org/my-repo" }));
    expect(result.stoppedEarly).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Repo glob patterns
// ---------------------------------------------------------------------------

describe("evaluateRules - repo glob patterns", () => {
  it("'my-org/*' matches 'my-org/repo-name'", () => {
    const config = makeConfig([makeRule({ match: { repo: "my-org/*" } })]);
    const result = evaluateRules(config, makeIssue({ repo: "my-org/repo-name" }));
    expect(result.matchedRules).toHaveLength(1);
  });

  it("'my-org/*' does not match 'other-org/repo-name'", () => {
    const config = makeConfig([makeRule({ match: { repo: "my-org/*" } })]);
    const result = evaluateRules(
      config,
      makeIssue({ repo: "other-org/repo-name" }),
    );
    expect(result.matchedRules).toHaveLength(0);
  });

  it("'*' matches single-segment repo names", () => {
    const config = makeConfig([makeRule({ match: { repo: "*" } })]);
    const result = evaluateRules(config, makeIssue({ repo: "my-repo" }));
    expect(result.matchedRules).toHaveLength(1);
  });

  it("'**' matches multi-segment paths", () => {
    const config = makeConfig([makeRule({ match: { repo: "**" } })]);
    const result = evaluateRules(
      config,
      makeIssue({ repo: "my-org/my-repo" }),
    );
    expect(result.matchedRules).toHaveLength(1);
  });

  it("exact repo name matches exactly", () => {
    const config = makeConfig([
      makeRule({ match: { repo: "my-org/my-repo" } }),
    ]);
    const match = evaluateRules(config, makeIssue({ repo: "my-org/my-repo" }));
    expect(match.matchedRules).toHaveLength(1);

    const noMatch = evaluateRules(
      config,
      makeIssue({ repo: "my-org/other-repo" }),
    );
    expect(noMatch.matchedRules).toHaveLength(0);
  });

  it("repo matching is case-insensitive", () => {
    const config = makeConfig([
      makeRule({ match: { repo: "My-Org/My-Repo" } }),
    ]);
    const result = evaluateRules(
      config,
      makeIssue({ repo: "my-org/my-repo" }),
    );
    expect(result.matchedRules).toHaveLength(1);
  });
});
