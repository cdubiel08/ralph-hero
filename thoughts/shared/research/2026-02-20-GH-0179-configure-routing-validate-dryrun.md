---
date: 2026-02-20
github_issue: 179
github_url: https://github.com/cdubiel08/ralph-hero/issues/179
status: complete
type: research
---

# GH-179: Add `validate_rules` and `dry_run` Operations to `configure_routing` Tool

## Problem Statement

Extend the `configure_routing` MCP tool (from #178) with two read-only operations:
- **`validate_rules`** — checks all configured routing rules against live GitHub project data (project IDs exist, field option names are valid)
- **`dry_run(issueNumber)`** — simulates rule evaluation for a specific issue without making any mutations, showing which rules match and what actions would be taken

Both operations extend the `operation: z.enum([...])` dispatch in `routing-tools.ts` from #178.

## Parent Context

- Parent: #128 (`configure_routing` MCP tool)
- Blocked by: #178 (CRUD operations, which this issue extends)
- Group: #178 (S, Ready for Plan) → **#179** (XS)
- Siblings also depending on #178: none

## Current State Analysis

### Extending #178's Tool

Both operations are added as new cases in the `switch(args.operation)` block of the existing `ralph_hero__configure_routing` tool from #178. No new tool registration is needed — just:

1. Extend `operation: z.enum([...])` to include `"validate_rules"` and `"dry_run"`
2. Add `issueNumber` as an optional schema parameter (required for `dry_run`)
3. Add two new `case` blocks in the handler

Updated enum:
```typescript
operation: z.enum([
  "list_rules",
  "add_rule",
  "update_rule",
  "remove_rule",
  "validate_rules",  // NEW
  "dry_run",         // NEW
])
```

### `validate_rules` — Uses Existing `FieldOptionCache` Pattern

The `validate_rules` operation needs to verify:
1. **Project IDs exist and are accessible** — directly supported by `ensureFieldCache()` in `lib/helpers.ts:91-113`, which throws `Project #N not found for owner "X"` if the project is unreachable
2. **Field option names are valid** — directly supported by `fieldCache.resolveOptionId(fieldName, optionName)` in `lib/cache.ts:141-143` (returns `undefined` if invalid) and `fieldCache.getOptionNames(fieldName)` (`cache.ts:169-172`) for listing valid options

**Exact validation pattern from `helpers.ts:239-244`:**
```typescript
const optionId = fieldCache.resolveOptionId(fieldName, optionName);
if (optionId === undefined) {
  const validOptions = fieldCache.getOptionNames(fieldName);
  throw new Error(
    `Option "${optionName}" not found for field "${fieldName}". ` +
    `Valid options: ${validOptions.join(", ")}`
  );
}
```

This exact pattern can be adapted to produce per-rule validation errors rather than throwing.

**`validate_rules` does NOT need `fieldCache` as a Zod param** — it receives `fieldCache` via the outer closure of `registerRoutingTools(server, client, fieldCache)`.

### `dry_run` — Depends on #167 (Matching Engine)

The `dry_run` operation needs to:
1. Fetch issue details (labels, repo, type) from GitHub
2. Read rules from `.ralph-routing.yml`
3. Run matching engine from #167 against the issue
4. Return matched rules + proposed actions (no mutations)

**Issue fetching pattern** — existing `get_issue` query or inline GraphQL query. The simplest approach reuses the existing `client.query()` to fetch `number`, `title`, `labels`, `state`, `repository.name`, `type`:

```typescript
const issueResult = await client.query<{ repository: { issue: Issue } }>(
  `query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      issue(number: $number) {
        number title state
        labels(first: 10) { nodes { name } }
        repository { name }
      }
    }
  }`,
  { owner, repo, number: args.issueNumber }
);
```

**Matching engine from #167** — when #167 is implemented, it will export a pure function like:
```typescript
// from #167: lib/routing-matcher.ts (hypothetical)
export function evaluateRules(
  rules: RoutingRule[],
  issue: IssueContext,
): Array<{ rule: RoutingRule; ruleIndex: number; actions: RoutingAction[] }>
```

Until #167 exists, `dry_run` cannot be fully implemented. However, the scaffolding (issue fetch + config read + result formatting) can be written with a stub matcher.

### FieldOptionCache Access in `validate_rules`

For `validate_rules`, each rule's `action` field may reference:
- `projectNumber` — validated by calling `ensureFieldCache(client, fieldCache, owner, projectNumber)` per referenced project
- `workflowState` — validated by `fieldCache.resolveOptionId("Workflow State", value)`
- Any other field option — `fieldCache.resolveOptionId(fieldName, value)`

**Multi-project validation**: If a rule references a project other than the default project, `ensureFieldCache` needs to be called with that project's number. This creates an API call per referenced project. The `FieldOptionCache` is keyed by project context (set during `populate()`), so validating multiple projects requires either:
- Separate `FieldOptionCache` instances per project (complex)
- A validation-specific direct query without caching (simpler for v1)

**Recommendation**: For v1, validate_rules checks:
1. Referenced project exists (via `ensureFieldCache` for the default project, or a simple existence query for non-default projects)
2. Referenced `workflowState`, `estimate`, `priority` values are valid against the default project's field options (most common case)

Cross-project field option validation can be deferred to a follow-up.

## Implementation Plan

### Schema Extension

```typescript
// In routing-tools.ts — extend the existing tool schema:
operation: z.enum([
  "list_rules", "add_rule", "update_rule", "remove_rule",
  "validate_rules",  // NEW
  "dry_run",         // NEW
]).describe("CRUD operation to perform"),

issueNumber: z
  .number()
  .optional()
  .describe("Issue number (required for dry_run)"),
```

### `validate_rules` Handler

```typescript
case "validate_rules": {
  // 1. Load config
  const raw = await fs.promises.readFile(configPath, "utf-8").catch(() => "");
  const config: RoutingConfig = raw ? parse(raw) : { rules: [] };
  const rules = config.rules ?? [];

  const errors: Array<{ ruleIndex: number; field: string; message: string }> = [];

  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];

    // 2. Validate project number if specified in action
    if (rule.action.projectNumber) {
      try {
        const { projectOwner } = resolveFullConfig(client, args);
        await ensureFieldCache(client, fieldCache, projectOwner, rule.action.projectNumber);
      } catch (err) {
        errors.push({
          ruleIndex: i,
          field: "action.projectNumber",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 3. Validate workflowState against field options
    if (rule.action.workflowState) {
      const optionId = fieldCache.resolveOptionId("Workflow State", rule.action.workflowState);
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
    ruleCount: rules.length,
    errors,
  });
}
```

### `dry_run` Handler

```typescript
case "dry_run": {
  if (!args.issueNumber) throw new Error("issueNumber is required for dry_run");

  // 1. Load config
  const raw = await fs.promises.readFile(configPath, "utf-8").catch(() => "");
  const config: RoutingConfig = raw ? parse(raw) : { rules: [] };

  // 2. Fetch issue details
  const { owner, repo } = resolveFullConfig(client, args);
  const issueResult = await client.query<{ repository: { issue: IssueContext } }>(
    DRY_RUN_ISSUE_QUERY,
    { owner, repo, number: args.issueNumber }
  );
  const issue = issueResult.repository?.issue;
  if (!issue) throw new Error(`Issue #${args.issueNumber} not found`);

  // 3. Run matching engine (from #167)
  // TODO: import { evaluateRules } from "../lib/routing-matcher.js" when #167 is done
  // For now, stub:
  const matches = stubEvaluateRules(config.rules ?? [], issue);

  return toolSuccess({
    issueNumber: args.issueNumber,
    matchedRules: matches,
    wouldExecute: matches.flatMap(m => m.actions),
    note: "No mutations performed — dry run only",
  });
}
```

### Dependency Coordination

| Operation | Depends on | Can scaffold? |
|-----------|-----------|---------------|
| `validate_rules` | #178 (tool exists), #166 (types), `FieldOptionCache` | Yes — all patterns exist |
| `dry_run` | #178 (tool exists), #166 (types), #167 (matcher), issue fetch | Partial — can write issue fetch + result shape, stub matcher |

**Recommendation**: Implement `validate_rules` fully when #178 ships. Implement `dry_run` scaffolding immediately after, add `import { evaluateRules }` from #167 once that ships.

### File Changes

| File | Change | Effort |
|------|--------|--------|
| `tools/routing-tools.ts` | Extend `operation` enum, add `issueNumber` param, add 2 `case` blocks | Primary (from #178) |
| No new files needed | Both operations extend the existing tool | — |
| `__tests__/routing-tools.test.ts` | Add tests for `validate_rules` (valid + invalid) and `dry_run` | Secondary |

### Tests

```typescript
// validate_rules tests
it("validate_rules returns valid=true for empty rule set")
it("validate_rules returns valid=true when all referenced projects exist and field values are valid")
it("validate_rules returns errors for invalid workflowState option")
it("validate_rules returns errors for non-existent project number")

// dry_run tests
it("dry_run throws if issueNumber is missing")
it("dry_run returns empty matchedRules for no-match case")
it("dry_run returns matched rules and proposed actions without mutating")
it("dry_run throws if issue not found")
```

## Group Summary

**Group: #178 → #179** (configure_routing tool, parent #128)

| Issue | Title | Estimate | State |
|-------|-------|----------|-------|
| #178 | configure_routing CRUD (list/add/update/remove) | S | Ready for Plan |
| **#179** | validate_rules + dry_run | XS | Research in Progress |

Execution order: #178 must complete before #179 starts (both extend the same tool file).

## Risks

1. **#167 (matching engine) dependency**: `dry_run` requires the rule matcher from #167. If #167 is not done when #179 ships, `dry_run` must either stub the matcher or be gated behind a check. **Mitigation**: Implement `dry_run` with a clearly-marked stub, ship `validate_rules` immediately, merge `dry_run` once #167 is done.

2. **Multi-project field option validation**: `validate_rules` needs `FieldOptionCache` populated for the project referenced in each rule's `action.projectNumber`. The cache is keyed to one project. For v1, validate only against the default project. **Mitigation**: Document the limitation; full cross-project validation deferred to a follow-up.

3. **`FieldOptionCache` not populated before `validate_rules`**: If the cache hasn't been populated (cold start), `fieldCache.resolveOptionId` returns empty maps. **Mitigation**: Call `ensureFieldCache` at the start of `validate_rules` (same as all other tools that need field lookups).

## Recommended Approach

1. Wait for #178 to be implemented (CRUD tool)
2. In the same PR or follow-up: extend `operation` enum + add `issueNumber` param
3. Implement `validate_rules` fully (zero new dependencies beyond what #178 brings)
4. Implement `dry_run` scaffolding with stub matcher; replace stub once #167 ships
5. Tests: 4 for `validate_rules`, 4 for `dry_run` (8 total additions to `routing-tools.test.ts`)
