---
date: 2026-02-20
github_issue: 167
github_url: https://github.com/cdubiel08/ralph-hero/issues/167
status: complete
type: research
---

# GH-167: Implement Routing Rule Matching Engine (Pure Function)

## Problem Statement

Implement a pure-function matching engine that evaluates routing rules against an issue context (repo, labels, issue type) and returns matched rules with their actions. This is the core logic that powers routing decisions — consumed by the `configure_routing` CRUD tool (#178), the `dry_run` operation (#179), and the Actions routing script (#171). No GitHub API calls — just deterministic input→output matching.

## Current State Analysis

### No Routing Code Exists

Zero routing-related files, types, or matching logic exist in the MCP server. The matching engine is entirely greenfield. The closest structural models are the pure-function lib modules: `workflow-states.ts`, `state-resolution.ts`, `pipeline-detection.ts`, `date-math.ts`, and `hygiene.ts`.

### Types Being Defined by GH-166

The `routing-types.ts` file does not exist yet (GH-166 is in progress, task #65). The authoritative schema from the [GH-166 research doc](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0166-routing-rules-config-schema.md) defines:

```typescript
type MatchCriteria = {
  repo?: string;              // Glob pattern (e.g., "my-org/*")
  labels?: {
    any?: string[];           // Match if issue has ANY of these labels
    all?: string[];           // Match if issue has ALL of these labels
  };
  issueType?: "issue" | "pull_request" | "draft_issue";
  negate?: boolean;           // Invert entire match result (default: false)
};

type RoutingAction = {
  projectNumber?: number;
  projectNumbers?: number[];
  workflowState?: string;
  labels?: string[];
};

type RoutingRule = {
  name?: string;
  match: MatchCriteria;
  action: RoutingAction;
  enabled?: boolean;          // Default: true
};

type RoutingConfig = {
  version: 1;
  stopOnFirstMatch?: boolean; // Default: true
  rules: RoutingRule[];
};
```

### Downstream Consumers

Three systems will call the matching engine:

1. **`dry_run` operation** (#179) — calls with a single issue, expects `Array<{ rule, ruleIndex, actions }>` back
2. **Actions routing script** (#171) — `evaluateRules(rules, issueContext)` returning matched rules to iterate over for project assignment
3. **`configure_routing` CRUD tool** (#178) — may use for validation or preview

### Pure Function Module Pattern

All pure-function lib modules in this codebase follow a consistent structure ([`workflow-states.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts), [`pipeline-detection.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts), [`hygiene.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/hygiene.ts)):

1. File-level JSDoc block describing purpose
2. Types/interfaces at the top
3. Module-scope constants
4. Exported pure functions
5. Private helper functions
6. `.js` extensions on all import paths (ESM)
7. Injectable parameters for testability (e.g., `now: Date = new Date()`)

### Existing Dependencies

`package.json` has 4 runtime dependencies: `@modelcontextprotocol/sdk`, `@octokit/graphql`, `@octokit/plugin-paginate-graphql`, `zod`. No glob matching library exists.

## Key Discoveries

### 1. Function Signature and Input Type

The matching engine needs an `IssueContext` input type representing the issue being evaluated. This is distinct from the existing MCP server types — it's a minimal projection of issue data relevant to routing:

```typescript
/** Minimal issue data needed for routing rule evaluation */
export interface IssueContext {
  repo: string;               // "owner/repo" or just "repo"
  labels: string[];            // Issue label names
  issueType: "issue" | "pull_request" | "draft_issue";
}

/** Result of evaluating a single rule against an issue */
export interface MatchResult {
  rule: RoutingRule;
  ruleIndex: number;
  matched: boolean;
  actions: RoutingAction;
}

/** Result of evaluating all rules against an issue */
export interface EvaluationResult {
  matchedRules: MatchResult[];
  stoppedEarly: boolean;       // true if stopOnFirstMatch terminated evaluation
}
```

**Design decision**: `IssueContext.repo` should accept both `"owner/repo"` format (for cross-repo routing) and just `"repo"` (for single-owner setups). The glob pattern in `MatchCriteria.repo` matches against whatever format the caller provides.

### 2. Matching Logic

The engine evaluates rules in order (top to bottom), applying each rule's match criteria:

```
For each rule (if enabled):
  1. Match repo:    glob match of issue.repo against rule.match.repo
  2. Match labels:  any-mode OR all-mode
  3. Match type:    exact match of issue.issueType against rule.match.issueType
  4. Combine:       ALL criteria must pass (AND logic)
  5. Negate:        if rule.match.negate, invert the combined result
  6. If matched:    add to results
  7. If stopOnFirstMatch and matched: stop evaluating remaining rules
```

**AND logic for criteria**: If a rule specifies both `repo` and `labels`, BOTH must match. Omitted criteria are treated as "match anything" (vacuously true).

**Label matching**:
- `labels.any: ["bug", "critical"]` → issue must have at least one of these labels
- `labels.all: ["bug", "critical"]` → issue must have ALL of these labels
- If both `any` and `all` are specified, BOTH conditions must be satisfied (AND)
- If `labels` is specified but both `any` and `all` are empty/omitted → vacuously true (any labels match)

### 3. Glob Matching for Repo Patterns

Three options for matching `repo` patterns like `"my-org/*"`:

**Option A: `picomatch` library** (recommended by web research)
- Zero dependencies, ~85 kB install size, TypeScript types via `@types/picomatch`
- Battle-tested (used by Jest, Vite, Astro, chokidar)
- API: `picomatch.isMatch('my-org/repo-name', 'my-org/*')` → `true`
- `*` does not cross `/` by default — correct for repo name matching

**Option B: Custom regex-based function** (~10 lines)
```typescript
function matchesGlob(pattern: string, input: string): boolean {
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\x00')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\x00/g, '.*');
  return new RegExp(`^${regexStr}$`).test(input);
}
```

**Option C: `minimatch`** — larger install size, transitive dependency (`brace-expansion`), recent ESM compatibility issues in v10.

**Recommendation: Option B (custom function)** for this codebase. Rationale:
- The MCP server has only 4 runtime dependencies — adding a 5th for a 10-line function is unnecessary
- The repo glob patterns are simple (`*`, `**`, `?` — no brace expansion, no extglobs)
- A custom function is fully testable and auditable
- Follows the codebase's lean dependency philosophy
- If more complex patterns are needed later, `picomatch` can be added as a drop-in replacement

### 4. Case Sensitivity

Label matching should be **case-insensitive** by default. GitHub labels are case-insensitive (`Bug` and `bug` are the same label). The matching engine should normalize both the rule labels and issue labels to lowercase before comparison.

Repo matching should be **case-insensitive** as well — GitHub repo names are case-insensitive.

### 5. `stopOnFirstMatch` Behavior

When `stopOnFirstMatch: true` (default):
- Evaluate rules top to bottom
- On first match, stop and return only that match
- The `EvaluationResult.stoppedEarly` flag indicates this happened

When `stopOnFirstMatch: false`:
- Evaluate ALL rules
- Return ALL matches
- Used for fan-out routing (one issue → multiple projects)

### 6. Disabled Rules

Rules with `enabled: false` are skipped entirely — not evaluated, not included in results. This allows users to temporarily disable rules without removing them from config.

### 7. File Placement and Name

**New file**: `plugin/ralph-hero/mcp-server/src/lib/routing-engine.ts`

This follows the lib module naming convention (`workflow-states.ts`, `pipeline-detection.ts`, `state-resolution.ts`). The name `routing-engine.ts` is preferred over `routing-matcher.ts` because the module handles more than just matching — it also handles rule evaluation order, `stopOnFirstMatch` logic, and result aggregation.

### 8. Test File

**New file**: `plugin/ralph-hero/mcp-server/src/__tests__/routing-engine.test.ts`

Following the 1:1 test file pattern (`workflow-states.test.ts`, `pipeline-detection.test.ts`, `date-math.test.ts`).

### 9. Dependency on GH-166 Types

The matching engine imports types from `routing-types.ts` (#166). If #166 is not yet merged when #167 is implemented, the engine can use inline temporary types (same approach as #178's research doc). Once #166 merges, swap inline types for imports.

However, since #166 is currently being implemented (task #65), it's likely to merge before or around the same time as #167. The recommendation is to wait for #166's types if they'll be available within the same sprint, otherwise use inline types.

### 10. Cross-Repo Routing Edge Case

If `IssueContext.repo` is just `"repo-name"` (no owner prefix) and the rule's `repo` pattern is `"my-org/*"`, the match will fail because the glob expects `owner/repo` format but the input has no owner. The matching engine should document this: callers must provide the full `"owner/repo"` format if cross-repo patterns are used.

## Potential Approaches

### Approach A: Single `evaluateRules` Function with Inline Helpers (Recommended)

One exported function `evaluateRules(config, issue)` with private helpers for each match type:

```typescript
// Exported
export function evaluateRules(config: RoutingConfig, issue: IssueContext): EvaluationResult

// Private helpers
function matchesRule(criteria: MatchCriteria, issue: IssueContext): boolean
function matchesRepo(pattern: string, repo: string): boolean
function matchesLabels(criteria: MatchCriteria["labels"], issueLabels: string[]): boolean
function matchesIssueType(expected: string, actual: string): boolean
function matchesGlob(pattern: string, input: string): boolean
```

**Pros:** Simple, follows `pipeline-detection.ts` pattern (one exported function + private helpers), easy to test.
**Cons:** Only one entry point — if callers need just label matching, they must call the full function.

### Approach B: Multiple Exported Match Functions

Export individual match functions for each criteria type, plus the orchestrator:

```typescript
export function evaluateRules(config: RoutingConfig, issue: IssueContext): EvaluationResult
export function matchesRepo(pattern: string, repo: string): boolean
export function matchesLabels(criteria: Labels, issueLabels: string[]): boolean
export function matchesRule(criteria: MatchCriteria, issue: IssueContext): boolean
```

**Pros:** More granular testing, individual functions reusable by other modules.
**Cons:** Larger public API surface, more to maintain, violates the codebase convention (other lib modules export 1-3 functions max).

### Recommendation: Approach A

A single exported function with private helpers matches the codebase conventions. The `matchesGlob` function could optionally be exported if the config loader (#168) needs it for validation, but this can be deferred.

## Implementation Sketch

```typescript
/**
 * Routing rule matching engine.
 *
 * Evaluates routing rules against an issue context (repo, labels, type)
 * and returns matched rules with their actions. Pure function — no I/O,
 * no API calls, fully deterministic.
 *
 * Used by: configure_routing dry_run (#179), Actions routing script (#171).
 */

import type { RoutingConfig, RoutingRule, RoutingAction, MatchCriteria } from "./routing-types.js";

// --- Types ---

export interface IssueContext {
  repo: string;
  labels: string[];
  issueType: "issue" | "pull_request" | "draft_issue";
}

export interface MatchResult {
  rule: RoutingRule;
  ruleIndex: number;
  matched: boolean;
  actions: RoutingAction;
}

export interface EvaluationResult {
  matchedRules: MatchResult[];
  stoppedEarly: boolean;
}

// --- Public API ---

export function evaluateRules(
  config: RoutingConfig,
  issue: IssueContext,
): EvaluationResult {
  const results: MatchResult[] = [];
  const stopOnFirst = config.stopOnFirstMatch ?? true;

  for (let i = 0; i < config.rules.length; i++) {
    const rule = config.rules[i];
    if (rule.enabled === false) continue;

    let matched = matchesRule(rule.match, issue);
    if (rule.match.negate) matched = !matched;

    if (matched) {
      results.push({ rule, ruleIndex: i, matched: true, actions: rule.action });
      if (stopOnFirst) {
        return { matchedRules: results, stoppedEarly: true };
      }
    }
  }

  return { matchedRules: results, stoppedEarly: false };
}

// --- Private Helpers ---

function matchesRule(criteria: MatchCriteria, issue: IssueContext): boolean {
  if (criteria.repo && !matchesRepo(criteria.repo, issue.repo)) return false;
  if (criteria.labels && !matchesLabels(criteria.labels, issue.labels)) return false;
  if (criteria.issueType && !matchesIssueType(criteria.issueType, issue.issueType)) return false;
  return true;
}

function matchesRepo(pattern: string, repo: string): boolean {
  return matchesGlob(pattern.toLowerCase(), repo.toLowerCase());
}

function matchesLabels(
  criteria: NonNullable<MatchCriteria["labels"]>,
  issueLabels: string[],
): boolean {
  const normalizedIssue = issueLabels.map(l => l.toLowerCase());

  if (criteria.any?.length) {
    const hasAny = criteria.any.some(l => normalizedIssue.includes(l.toLowerCase()));
    if (!hasAny) return false;
  }

  if (criteria.all?.length) {
    const hasAll = criteria.all.every(l => normalizedIssue.includes(l.toLowerCase()));
    if (!hasAll) return false;
  }

  return true;
}

function matchesIssueType(expected: string, actual: string): boolean {
  return expected.toLowerCase() === actual.toLowerCase();
}

function matchesGlob(pattern: string, input: string): boolean {
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\x00")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\x00/g, ".*");
  return new RegExp(`^${regexStr}$`).test(input);
}
```

## Test Plan

```typescript
describe("evaluateRules", () => {
  // Basic matching
  it("matches rule with repo glob pattern")
  it("matches rule with labels.any criteria")
  it("matches rule with labels.all criteria")
  it("matches rule with issueType criteria")
  it("returns empty matchedRules when no rules match")

  // Combined criteria (AND logic)
  it("requires ALL criteria to match (repo + labels)")
  it("treats omitted criteria as 'match anything'")

  // Labels edge cases
  it("labels.any matches if issue has at least one matching label")
  it("labels.all fails if issue is missing any required label")
  it("labels matching is case-insensitive")
  it("both labels.any and labels.all must be satisfied when both specified")

  // Negate
  it("negate: true inverts the match result")
  it("negate: false (default) does not invert")

  // Enabled/disabled
  it("skips rules with enabled: false")
  it("includes rules with enabled: true or undefined")

  // stopOnFirstMatch
  it("stops after first match when stopOnFirstMatch: true (default)")
  it("continues evaluating all rules when stopOnFirstMatch: false")
  it("sets stoppedEarly: true when stopped early")
  it("sets stoppedEarly: false when all rules evaluated")

  // Repo glob patterns
  it("'my-org/*' matches 'my-org/repo-name'")
  it("'my-org/*' does not match 'other-org/repo-name'")
  it("'*' matches single-segment repo names")
  it("'**' matches multi-segment paths")
  it("exact repo name matches exactly")
  it("repo matching is case-insensitive")
});
```

## Group Context

Parent #125 has 6 children in this dependency chain:

| Order | Issue | Title | Estimate | State |
|-------|-------|-------|----------|-------|
| 1 | #166 | Define routing rules config schema and TypeScript types | XS | In Progress (task #65) |
| 2 | **#167** | Implement routing rule matching engine (pure function) | S | **Research in Progress** |
| 3 | #168 | Implement routing config loader and live validation | XS | Backlog |
| 4 | #171 | Implement routing evaluation and project field assignment in Actions | S | Ready for Plan |
| 5 | #178 | Implement configure_routing MCP tool — CRUD operations | S | Ready for Plan |
| 6 | #179 | Add validate_rules and dry_run operations to configure_routing tool | XS | Ready for Plan |

**Dependency refinement**: The GH-166 research doc noted that #167 can proceed in **parallel** with #166 using inline types, then swap to imports once #166 merges. However, since #166 is actively being implemented (task #65), the practical recommendation is to implement #167 immediately after #166 merges to use the real types from day one.

#167 is NOT blocked by #168 (config loader) — the matching engine doesn't load config files. It receives parsed config as input.

## Risks

1. **Glob edge cases**: The custom `matchesGlob` function handles `*`, `**`, and `?` but not brace expansion (`{a,b}`), extglobs (`!(pattern)`), or POSIX classes (`[:alpha:]`). If these are needed later, replace with `picomatch`. The risk is low — the GH-166 schema only documents `*`-style patterns.

2. **Case sensitivity ambiguity**: GitHub labels are case-insensitive, but the matching engine normalizes to lowercase. If a routing rule specifies `labels.any: ["Bug"]` and the issue has label `"bug"`, the engine correctly matches. However, the case-insensitive behavior should be documented.

3. **`negate` semantics with empty criteria**: If a rule has `negate: true` but no criteria (all optional fields omitted), the match would be `true` (vacuously), then negated to `false`. The Zod `.refine()` in GH-166 prevents this by requiring at least one criterion. But the engine should handle it gracefully regardless.

4. **`repo` format inconsistency**: If some callers pass `"owner/repo"` and others pass just `"repo"`, the glob patterns won't match consistently. Document that callers must use a consistent format.

5. **Regex ReDoS**: The custom `matchesGlob` function converts glob patterns to regex. Adversarial patterns like `*****` could theoretically cause regex backtracking. Mitigate by limiting pattern length or using `picomatch` (which has built-in safeguards). The risk is low — config files are author-controlled, not user-input.

## Recommended Next Steps

1. Wait for #166 to merge (provides `RoutingRule`, `MatchCriteria`, `RoutingAction`, `RoutingConfig` types)
2. Create `lib/routing-engine.ts` with `evaluateRules` as the single exported function
3. Include `IssueContext`, `MatchResult`, and `EvaluationResult` as exported types
4. Implement custom `matchesGlob` function (private, ~10 lines)
5. All string comparisons case-insensitive (labels, repo, issueType)
6. Create `__tests__/routing-engine.test.ts` with ~20 test cases covering all criteria types, negate, stopOnFirstMatch, disabled rules
7. Use factory helpers (`makeRule`, `makeIssue`) following the `pipeline-detection.test.ts` pattern
