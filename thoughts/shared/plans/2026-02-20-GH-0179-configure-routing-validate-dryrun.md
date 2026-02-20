---
date: 2026-02-20
status: draft
github_issues: [179]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/179
primary_issue: 179
---

# Add validate_rules and dry_run Operations to configure_routing Tool - Implementation Plan

## Overview
1 issue extending the existing `configure_routing` MCP tool with two read-only operations:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-179 | Add validate_rules and dry_run operations to configure_routing tool | XS |

## Current State Analysis

- `routing-tools.ts` (GH-178, merged) provides the `ralph_hero__configure_routing` tool with 4 CRUD operations: `list_rules`, `add_rule`, `update_rule`, `remove_rule`
- The tool dispatches via `switch(args.operation)` on `z.enum(["list_rules", "add_rule", "update_rule", "remove_rule"])`
- The tool receives `client: GitHubClient` and `fieldCache: FieldOptionCache` via closure from `registerRoutingTools()` -- currently unused (prefixed with `_`)
- `FieldOptionCache.resolveOptionId(fieldName, optionName)` returns `undefined` for non-existent options (`cache.ts:141-143`)
- `FieldOptionCache.getOptionNames(fieldName)` returns all valid option names for a field (`cache.ts:169-172`)
- `ensureFieldCache(client, fieldCache, owner, projectNumber)` in `helpers.ts:91-113` populates the cache from project field data
- The tool uses temporary inline `RoutingRule`/`RoutingConfig` interfaces (should be replaced with GH-166 types from `routing-types.ts`)
- `routing-tools.test.ts` uses pure logic tests without mocks (testing YAML round-trip, array manipulation, index validation)
- GH-167 (matching engine) is now implemented in `lib/routing-engine.ts`, exporting `evaluateRules(config, issue)` with `IssueContext` and `EvaluationResult` types -- `dry_run` can use it directly

## Desired End State

### Verification
- [ ] `validate_rules` operation checks `workflowState` values against `FieldOptionCache` and returns `{ valid, ruleCount, errors }`
- [ ] `validate_rules` calls `ensureFieldCache` to populate cache before checking
- [ ] `dry_run` operation fetches issue details, reads config, runs `evaluateRules()` from GH-167, returns matched rules without mutations
- [ ] `dry_run` returns error if `issueNumber` is not provided
- [ ] Both operations are registered in the `operation` enum
- [ ] `issueNumber` optional parameter is added to the tool schema
- [ ] `npm test` passes with new tests
- [ ] `npm run build` compiles cleanly

## What We're NOT Doing
- No cross-project field option validation (v1 validates against default project only)
- No label validation against GitHub API (labels not cached by `FieldOptionCache`)
- No full routing config loading from GH-168 -- uses same `fs.readFile` + YAML parse as CRUD operations
- No mutations in either operation (both are read-only)
- No changes to existing CRUD operations
- No config file loading from GH-168 -- uses same `fs.readFile` + YAML parse as CRUD operations

## Implementation Approach

Extend the existing `routing-tools.ts` file with two new `case` blocks in the `switch` statement and add `issueNumber` as an optional parameter. The `validate_rules` operation uses the existing `FieldOptionCache` pattern. The `dry_run` operation fetches issue data via GraphQL and uses a stub matcher until GH-167 ships. Remove the `_` prefix from `client` and `fieldCache` parameters since they are now used.

---

## Phase 1: GH-179 -- validate_rules and dry_run Operations
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/179 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0179-configure-routing-validate-dryrun.md

### Changes Required

#### 1. Extend tool schema with new operations and issueNumber parameter
**File**: `plugin/ralph-hero/mcp-server/src/tools/routing-tools.ts`
**Where**: Tool schema definition (lines 38-66)

**Changes**:
- Extend `operation` enum from `["list_rules", "add_rule", "update_rule", "remove_rule"]` to include `"validate_rules"` and `"dry_run"`
- Add `issueNumber` optional parameter: `z.number().optional().describe("Issue number (required for dry_run)")`
- Update tool description to mention validate and dry_run operations

#### 2. Remove underscore prefix from closure parameters
**File**: `plugin/ralph-hero/mcp-server/src/tools/routing-tools.ts`
**Where**: `registerRoutingTools` function signature (line 29-33)

**Changes**: Rename `_client` to `client` and `_fieldCache` to `fieldCache` since both are now used by `validate_rules` and `dry_run`.

#### 3. Add environment variable helpers for owner/repo resolution
**File**: `plugin/ralph-hero/mcp-server/src/tools/routing-tools.ts`
**Where**: After the inline type definitions (line 23)

**Changes**: Add a helper to resolve `owner` and `repo` from environment variables (same pattern used by other tools):

```typescript
function resolveOwnerRepo(): { owner: string; repo: string } {
  const owner = process.env.RALPH_GH_OWNER ?? process.env.GITHUB_OWNER ?? "";
  const repo = process.env.RALPH_GH_REPO ?? process.env.GITHUB_REPO ?? "";
  return { owner, repo };
}
```

#### 4. Update imports
**File**: `plugin/ralph-hero/mcp-server/src/tools/routing-tools.ts`
**Where**: Import section (lines 8-14)

**Changes**:
- Remove inline `RoutingRule`/`RoutingConfig` interfaces
- Add imports:
```typescript
import type { RoutingConfig } from "../lib/routing-types.js";
import { validateRoutingConfig } from "../lib/routing-types.js";
import { evaluateRules, type IssueContext } from "../lib/routing-engine.js";
import { ensureFieldCache, resolveFullConfig } from "../lib/helpers.js";
```

#### 5. Add `validate_rules` case block
**File**: `plugin/ralph-hero/mcp-server/src/tools/routing-tools.ts`
**Where**: After the `remove_rule` case (line 117), before the `catch`

**Changes**: Add new `case "validate_rules"` block:

```typescript
case "validate_rules": {
  const errors: Array<{ ruleIndex: number; ruleName?: string; field: string; message: string }> = [];
  const { owner } = resolveOwnerRepo();

  // Ensure field cache is populated for the default project
  const defaultProjectNumber = parseInt(
    process.env.RALPH_GH_PROJECT_NUMBER ?? "", 10
  );
  if (defaultProjectNumber && !isNaN(defaultProjectNumber)) {
    await ensureFieldCache(client, fieldCache, owner, defaultProjectNumber);
  }

  for (let i = 0; i < config.rules.length; i++) {
    const rule = config.rules[i];

    // Validate workflowState against field options
    if (rule.action.workflowState) {
      const optionId = fieldCache.resolveOptionId(
        "Workflow State", rule.action.workflowState
      );
      if (optionId === undefined) {
        const valid = fieldCache.getOptionNames("Workflow State");
        errors.push({
          ruleIndex: i,
          field: "action.workflowState",
          message: `"${rule.action.workflowState}" is not a valid Workflow State. Valid: ${valid.join(", ")}`,
        });
      }
    }
  }

  return toolSuccess({
    valid: errors.length === 0,
    ruleCount: config.rules.length,
    errors,
    configPath,
  });
}
```

Key design decisions:
- Populate `FieldOptionCache` via `ensureFieldCache` before validation (handles cold start)
- Only validates `workflowState` in v1 (most common field reference in routing rules)
- Returns structured errors with `ruleIndex`, `field`, and `message` for each invalid reference
- Returns `valid: true/false` summary for quick pass/fail check

#### 6. Add `dry_run` case block
**File**: `plugin/ralph-hero/mcp-server/src/tools/routing-tools.ts`
**Where**: After the `validate_rules` case

**Changes**: Add new `case "dry_run"` block:

```typescript
case "dry_run": {
  if (!args.issueNumber) {
    return toolError("issueNumber is required for dry_run operation");
  }

  const { owner, repo } = resolveFullConfig(client, args);

  // Parse config through Zod for proper RoutingConfig type
  const typedConfig = validateRoutingConfig(raw ? parse(raw) : { version: 1, rules: [] });

  // Fetch issue details
  const issueResult = await client.query<{
    repository: {
      issue: {
        number: number;
        title: string;
        labels: { nodes: Array<{ name: string }> };
        repository: { nameWithOwner: string };
      } | null;
    };
  }>(
    `query($owner: String!, $repo: String!, $issueNum: Int!) {
      repository(owner: $owner, name: $repo) {
        issue(number: $issueNum) {
          number
          title
          labels(first: 20) { nodes { name } }
          repository { nameWithOwner }
        }
      }
    }`,
    { owner, repo, issueNum: args.issueNumber },
  );

  const issue = issueResult.repository?.issue;
  if (!issue) {
    return toolError(`Issue #${args.issueNumber} not found in ${owner}/${repo}`);
  }

  // Build IssueContext and run matching engine (GH-167)
  const issueContext: IssueContext = {
    repo: issue.repository.nameWithOwner,
    labels: issue.labels.nodes.map((l) => l.name),
    issueType: "issue",
  };
  const evalResult = evaluateRules(typedConfig, issueContext);

  return toolSuccess({
    issueNumber: args.issueNumber,
    issueTitle: issue.title,
    issueContext,
    matchedRules: evalResult.matchedRules,
    stoppedEarly: evalResult.stoppedEarly,
    note: "No mutations performed -- dry run only",
    configPath,
  });
}
```

Key design decisions:
- Uses `client.query()` to fetch issue details (labels + repo name needed for matching)
- Uses `validateRoutingConfig()` to parse config into proper `RoutingConfig` type for `evaluateRules()`
- Calls `evaluateRules()` from GH-167 matching engine directly -- no stub needed
- Uses `nameWithOwner` for repo context so glob patterns like `my-org/*` work correctly
- GraphQL variable named `issueNum` (not `number`) to avoid Octokit reserved name conflict
- Returns full context: issue title, IssueContext, matched rules, stoppedEarly flag

#### 7. Add tests for validate_rules and dry_run
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/routing-tools.test.ts`
**Where**: After the existing "routing CRUD logic" describe block

**Changes**: Add two new describe blocks following the existing pure-logic test pattern:

```typescript
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
            return { ruleIndex: i, field: "action.workflowState", message: `invalid` };
          }
        }
        return null;
      })
      .filter(Boolean);
    expect(errors).toHaveLength(0);
  });

  it("returns valid=true when workflowState exists in valid options", () => {
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
      { match: { labels: ["bug"] }, action: { projectNumber: 3 } },
    ];
    const errors = rules
      .filter((r) => r.action.workflowState !== undefined)
      .map((r) => r);
    expect(errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// dry_run logic
// ---------------------------------------------------------------------------

describe("dry_run logic", () => {
  it("requires issueNumber parameter", () => {
    const issueNumber = undefined;
    expect(issueNumber).toBeUndefined();
  });

  it("evaluateRules matches rules by label criteria", () => {
    // Uses evaluateRules from routing-engine.ts directly
    const { evaluateRules } = require("../lib/routing-engine.js");
    const config = {
      version: 1, stopOnFirstMatch: true,
      rules: [{ match: { labels: { any: ["bug"] }, negate: false }, action: { projectNumber: 3 }, enabled: true }],
    };
    const issue = { repo: "my-org/my-repo", labels: ["bug"], issueType: "issue" };
    const result = evaluateRules(config, issue);
    expect(result.matchedRules).toHaveLength(1);
  });

  it("evaluateRules returns empty matchedRules when no rules match", () => {
    const { evaluateRules } = require("../lib/routing-engine.js");
    const config = {
      version: 1, stopOnFirstMatch: true,
      rules: [{ match: { labels: { any: ["bug"] }, negate: false }, action: { projectNumber: 3 }, enabled: true }],
    };
    const issue = { repo: "my-org/my-repo", labels: ["enhancement"], issueType: "issue" };
    const result = evaluateRules(config, issue);
    expect(result.matchedRules).toHaveLength(0);
  });

  it("evaluateRules respects stopOnFirstMatch", () => {
    const { evaluateRules } = require("../lib/routing-engine.js");
    const config = {
      version: 1, stopOnFirstMatch: false,
      rules: [
        { match: { labels: { any: ["bug"] }, negate: false }, action: { projectNumber: 3 }, enabled: true },
        { match: { labels: { any: ["bug"] }, negate: false }, action: { projectNumber: 5 }, enabled: true },
      ],
    };
    const issue = { repo: "my-org/my-repo", labels: ["bug"], issueType: "issue" };
    const result = evaluateRules(config, issue);
    expect(result.matchedRules).toHaveLength(2);
    expect(result.stoppedEarly).toBe(false);
  });
});
```

### Success Criteria
- [ ] Automated: `npm test` -- all tests pass including new validate_rules and dry_run tests
- [ ] Automated: `npm run build` -- TypeScript compiles without errors
- [ ] Manual: `validate_rules` on a config with invalid workflowState returns structured errors
- [ ] Manual: `validate_rules` on a valid config returns `{ valid: true }`
- [ ] Manual: `dry_run` with an issue number returns matched rules and proposed actions
- [ ] Manual: `dry_run` without issueNumber returns an error message

---

## Integration Testing
- [ ] `npm run build` compiles `routing-tools.ts` without errors
- [ ] `npm test` passes all existing tests plus 8 new tests
- [ ] Existing CRUD operations (`list_rules`, `add_rule`, `update_rule`, `remove_rule`) are unaffected
- [ ] `validate_rules` gracefully handles empty config files
- [ ] `dry_run` gracefully handles non-existent issue numbers
- [ ] `client` and `fieldCache` closure parameters are properly unwrapped (no `_` prefix)

## References
- Research GH-179: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0179-configure-routing-validate-dryrun.md
- CRUD tool (GH-178): [`tools/routing-tools.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/routing-tools.ts)
- FieldOptionCache API: [`lib/cache.ts:100-170`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/cache.ts#L100) (`resolveOptionId`, `getOptionNames`)
- ensureFieldCache: [`lib/helpers.ts:91-113`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/helpers.ts#L91)
- Test pattern: [`__tests__/routing-tools.test.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/__tests__/routing-tools.test.ts)
- Parent epic: https://github.com/cdubiel08/ralph-hero/issues/128
