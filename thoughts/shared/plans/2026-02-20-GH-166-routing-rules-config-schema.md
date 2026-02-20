---
date: 2026-02-20
status: draft
github_issue: 166
github_url: https://github.com/cdubiel08/ralph-hero/issues/166
primary_issue: 166
---

# Routing Rules Config Schema and TypeScript Types - Implementation Plan

## Overview

Single issue implementation: GH-166 — Define routing rules config schema using Zod and derive TypeScript types via `z.infer<>`. This is the foundation for the routing engine group (#125): sibling issues #167 (matching), #168 (config loader), #178 (CRUD tool) all import from this module.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-166 | Define routing rules config schema and TypeScript types | XS |

## Current State Analysis

- No routing-related files, types, or config exist in the MCP server — entirely greenfield.
- Zod is already a dependency, used inline in all `server.tool()` calls. No exported Zod schemas exist yet — GH-166 establishes this as a new pattern.
- Lib modules follow a consistent pattern: `lib/workflow-states.ts` (constants + functions), `lib/cache.ts` (classes), `lib/dashboard.ts` (types + pure functions). The new `lib/routing-types.ts` follows the constants/types pattern.
- Test files for lib modules use `vitest` with `describe`/`it`/`expect` — no mocking needed for pure schema validation tests.

## Desired End State

### Verification
- [x] `lib/routing-types.ts` exists with 4 Zod schemas and 4 inferred TypeScript types
- [x] `validateRoutingConfig()` convenience function exported
- [x] Zod refinements enforce "at least one match criterion" and "at least one action"
- [x] `version: 1` literal enforced for forward compatibility
- [x] Tests pass for valid configs, invalid configs, edge cases
- [x] `npm run build` and `npm test` succeed

## What We're NOT Doing
- No YAML parsing or file loading (GH-168 scope)
- No matching engine or glob evaluation (GH-167 scope)
- No MCP tool registration (GH-178 scope)
- No `js-yaml` dependency addition (GH-168 will add it)
- No GitHub API calls or GraphQL queries
- No changes to existing files (except test file creation)

## Implementation Approach

Single new lib module with exported Zod schemas. Each schema builds on the previous: `MatchCriteriaSchema` + `RoutingActionSchema` compose into `RoutingRuleSchema`, which composes into `RoutingConfigSchema`. TypeScript types are derived via `z.infer<>` — single source of truth. A `validateRoutingConfig()` wrapper provides a clean API for the config loader (#168).

---

## Phase 1: GH-166 — Define routing rules config schema and TypeScript types
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/166 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0166-routing-rules-config-schema.md

### Changes Required

#### 1. Create `lib/routing-types.ts`
**File**: `plugin/ralph-hero/mcp-server/src/lib/routing-types.ts` (new file)

**Contents**:

```typescript
/**
 * Routing rules config schema and TypeScript types.
 *
 * Defines the structure for `.ralph-routing.yml` config files used by
 * the issue routing engine. Zod schemas provide runtime validation;
 * TypeScript types are derived via z.infer<> for compile-time safety.
 *
 * Consumers:
 * - #167 matching engine: imports MatchCriteria, RoutingRule types
 * - #168 config loader: imports RoutingConfigSchema for YAML validation
 * - #178 CRUD tool: imports schemas + types for inline validation
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Match Criteria
// ---------------------------------------------------------------------------

/**
 * Defines conditions for matching an issue to a routing rule.
 *
 * At least one criterion must be specified. Multiple criteria are AND'd:
 * all specified conditions must match for the rule to apply.
 *
 * Example YAML:
 *   match:
 *     repo: "cdubiel08/ralph-hero"
 *     labels:
 *       any: ["enhancement", "bug"]
 */
export const MatchCriteriaSchema = z
  .object({
    repo: z
      .string()
      .optional()
      .describe("Repository glob pattern (e.g., 'my-org/*', 'owner/repo')"),
    labels: z
      .object({
        any: z
          .array(z.string())
          .optional()
          .describe("Match if issue has ANY of these labels"),
        all: z
          .array(z.string())
          .optional()
          .describe("Match if issue has ALL of these labels"),
      })
      .optional()
      .describe("Label matching criteria"),
    issueType: z
      .enum(["issue", "pull_request", "draft_issue"])
      .optional()
      .describe("Match by item type"),
    negate: z
      .boolean()
      .optional()
      .default(false)
      .describe("Invert match result — true means 'NOT matching'"),
  })
  .refine((d) => d.repo || d.labels || d.issueType, {
    message: "At least one match criterion must be specified (repo, labels, or issueType)",
  });

// ---------------------------------------------------------------------------
// Routing Action
// ---------------------------------------------------------------------------

/**
 * Defines what happens when a rule matches.
 *
 * At least one action must be specified. Multiple actions execute together.
 *
 * Example YAML:
 *   action:
 *     projectNumber: 3
 *     workflowState: "Backlog"
 *     labels: ["triaged"]
 */
export const RoutingActionSchema = z
  .object({
    projectNumber: z
      .number()
      .optional()
      .describe("Add issue to this project (shorthand for single project)"),
    projectNumbers: z
      .array(z.number())
      .optional()
      .describe("Add issue to multiple projects"),
    workflowState: z
      .string()
      .optional()
      .describe("Set workflow state after routing"),
    labels: z
      .array(z.string())
      .optional()
      .describe("Add these labels to the issue"),
  })
  .refine(
    (d) => d.projectNumber || d.projectNumbers || d.workflowState || d.labels,
    {
      message: "At least one action must be specified (projectNumber, projectNumbers, workflowState, or labels)",
    },
  );

// ---------------------------------------------------------------------------
// Routing Rule
// ---------------------------------------------------------------------------

/**
 * A single routing rule: match criteria + action.
 *
 * Example YAML:
 *   - name: "Route MCP server issues"
 *     match:
 *       repo: "cdubiel08/ralph-hero"
 *     action:
 *       projectNumber: 3
 */
export const RoutingRuleSchema = z.object({
  name: z
    .string()
    .optional()
    .describe("Human-readable rule name for debugging and audit trail"),
  match: MatchCriteriaSchema,
  action: RoutingActionSchema,
  enabled: z
    .boolean()
    .optional()
    .default(true)
    .describe("Toggle rule on/off without removing it"),
});

// ---------------------------------------------------------------------------
// Routing Config
// ---------------------------------------------------------------------------

/**
 * Top-level routing configuration.
 *
 * Example YAML:
 *   version: 1
 *   stopOnFirstMatch: true
 *   rules:
 *     - name: "Route bugs"
 *       match:
 *         labels:
 *           any: ["bug"]
 *       action:
 *         projectNumber: 3
 */
export const RoutingConfigSchema = z.object({
  version: z
    .literal(1)
    .describe("Schema version for forward compatibility"),
  stopOnFirstMatch: z
    .boolean()
    .optional()
    .default(true)
    .describe("Stop evaluating rules after first match (default: true)"),
  rules: z
    .array(RoutingRuleSchema)
    .describe("Ordered list of routing rules — evaluated top to bottom"),
});

// ---------------------------------------------------------------------------
// Inferred TypeScript Types
// ---------------------------------------------------------------------------

export type MatchCriteria = z.infer<typeof MatchCriteriaSchema>;
export type RoutingAction = z.infer<typeof RoutingActionSchema>;
export type RoutingRule = z.infer<typeof RoutingRuleSchema>;
export type RoutingConfig = z.infer<typeof RoutingConfigSchema>;

// ---------------------------------------------------------------------------
// Convenience Functions
// ---------------------------------------------------------------------------

/**
 * Validate and parse a routing config object (e.g., from YAML parse output).
 * Throws ZodError with detailed messages on validation failure.
 */
export function validateRoutingConfig(data: unknown): RoutingConfig {
  return RoutingConfigSchema.parse(data);
}
```

#### 2. Add tests
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/routing-types.test.ts` (new file)

```typescript
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
```

### Success Criteria
- [ ] Automated: `cd plugin/ralph-hero/mcp-server && npm run build` succeeds
- [ ] Automated: `cd plugin/ralph-hero/mcp-server && npm test` passes
- [ ] Manual: `RoutingConfigSchema`, `MatchCriteriaSchema`, `RoutingActionSchema`, `RoutingRuleSchema` exported
- [ ] Manual: `RoutingConfig`, `MatchCriteria`, `RoutingAction`, `RoutingRule` types exported
- [ ] Manual: `validateRoutingConfig()` function exported

---

## Integration Testing
- [ ] Build succeeds: `cd plugin/ralph-hero/mcp-server && npm run build`
- [ ] All tests pass: `cd plugin/ralph-hero/mcp-server && npm test`
- [ ] No type errors in new code
- [ ] Zod refinement validations work (empty match rejected, empty action rejected)
- [ ] Version literal enforced (version: 2 rejected)
- [ ] Defaults applied correctly (stopOnFirstMatch, enabled, negate)

## References
- Research GH-166: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0166-routing-rules-config-schema.md
- Lib module pattern: `plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts`
- Test pattern: `plugin/ralph-hero/mcp-server/src/__tests__/workflow-states.test.ts`
- Downstream consumers: #167 (matching engine), #168 (config loader), #178 (CRUD tool)
- Parent epic: https://github.com/cdubiel08/ralph-hero/issues/125
