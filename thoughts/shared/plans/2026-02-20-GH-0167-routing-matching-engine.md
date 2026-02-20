---
date: 2026-02-20
status: draft
github_issues: [167]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/167
primary_issue: 167
---

# Routing Rule Matching Engine - Atomic Implementation Plan

## Overview
1 issue for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-167 | Implement routing rule matching engine (pure function) | S |

## Current State Analysis

GH-166 (routing types) is complete and merged. The file [`plugin/ralph-hero/mcp-server/src/lib/routing-types.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/routing-types.ts) exports `MatchCriteria`, `RoutingAction`, `RoutingRule`, and `RoutingConfig` types derived from Zod schemas. No routing matching logic exists anywhere in the codebase -- this is entirely greenfield.

The codebase's pure-function lib modules follow a consistent pattern (see [`pipeline-detection.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts), [`workflow-states.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts), [`hygiene.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/hygiene.ts)):
1. File-level JSDoc describing purpose
2. Types/interfaces at top
3. Module-scope constants
4. Exported pure functions
5. Private helper functions
6. `.js` extensions on all import paths (ESM)

## Desired End State

### Verification
- [ ] `evaluateRules(config, issue)` returns matched rules with actions for all criteria combinations
- [ ] Custom `matchesGlob` handles `*`, `**`, `?` patterns correctly
- [ ] Case-insensitive matching for labels, repo names, and issue types
- [ ] `stopOnFirstMatch` controls early termination vs fan-out
- [ ] Disabled rules are skipped entirely
- [ ] `negate` inverts combined match result
- [ ] ~20 tests pass covering all criteria types, edge cases, and combinations
- [ ] `npm run build` succeeds with no type errors
- [ ] `npm test` passes with all new tests green

## What We're NOT Doing
- No `picomatch` or `minimatch` dependency -- custom inline glob matching (~10 lines)
- No config file loading (that's GH-168)
- No GitHub API calls -- this is a pure function module
- No brace expansion, extglobs, or POSIX character classes in glob matching
- No exporting individual match helpers (only `evaluateRules` + types exported)

## Implementation Approach

Single phase creating two new files: the engine module and its comprehensive test suite. The module imports types from the existing `routing-types.ts` and follows the established lib module pattern.

---

## Phase 1: GH-167 - Implement Routing Rule Matching Engine
> **Issue**: [GH-167](https://github.com/cdubiel08/ralph-hero/issues/167) | **Research**: [GH-0167 Research](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0167-routing-matching-engine.md)

### Changes Required

#### 1. Create routing engine module
**File**: `plugin/ralph-hero/mcp-server/src/lib/routing-engine.ts` (NEW)

**Structure** (following `pipeline-detection.ts` pattern):

```typescript
/**
 * Routing rule matching engine.
 *
 * Evaluates routing rules against an issue context (repo, labels, type)
 * and returns matched rules with their actions. Pure function -- no I/O,
 * no API calls, fully deterministic.
 *
 * Used by: configure_routing dry_run (#179), Actions routing script (#171).
 */

import type { RoutingConfig, RoutingRule, RoutingAction, MatchCriteria } from "./routing-types.js";
```

**Exported types** (3 new interfaces):
- `IssueContext` -- minimal issue data for routing evaluation: `{ repo: string; labels: string[]; issueType: "issue" | "pull_request" | "draft_issue" }`
- `MatchResult` -- per-rule result: `{ rule: RoutingRule; ruleIndex: number; matched: boolean; actions: RoutingAction }`
- `EvaluationResult` -- overall result: `{ matchedRules: MatchResult[]; stoppedEarly: boolean }`

**Exported function** (1):
- `evaluateRules(config: RoutingConfig, issue: IssueContext): EvaluationResult`

**Logic**:
1. Iterate rules in order (index 0..N)
2. Skip rules with `enabled === false`
3. For each enabled rule, evaluate all criteria (AND logic):
   - `matchesRepo(pattern, repo)` -- case-insensitive glob match
   - `matchesLabels(criteria.labels, issue.labels)` -- `any` = at least one, `all` = every one, both specified = both must hold
   - `matchesIssueType(expected, actual)` -- case-insensitive exact match
4. Omitted criteria are vacuously true
5. If `negate: true`, invert the combined result
6. On match: push to results; if `stopOnFirstMatch` (default `true`), return immediately with `stoppedEarly: true`
7. After all rules: return results with `stoppedEarly: false`

**Private helpers** (5 functions):
- `matchesRule(criteria: MatchCriteria, issue: IssueContext): boolean` -- combines all criteria checks with AND logic
- `matchesRepo(pattern: string, repo: string): boolean` -- normalizes to lowercase, delegates to `matchesGlob`
- `matchesLabels(criteria: NonNullable<MatchCriteria["labels"]>, issueLabels: string[]): boolean` -- handles `any`/`all` modes, case-insensitive
- `matchesIssueType(expected: string, actual: string): boolean` -- case-insensitive comparison
- `matchesGlob(pattern: string, input: string): boolean` -- regex-based glob: escapes special chars, converts `**` to `.*`, `*` to `[^/]*`, `?` to `[^/]`

#### 2. Create routing engine tests
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/routing-engine.test.ts` (NEW)

**Pattern**: Follow [`pipeline-detection.test.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/__tests__/pipeline-detection.test.ts) factory helpers.

**Factory helpers**:
- `makeRule(overrides?)` -- creates a `RoutingRule` with sensible defaults (repo match, projectNumber action)
- `makeIssue(overrides?)` -- creates an `IssueContext` with defaults (repo, empty labels, type "issue")
- `makeConfig(rules, overrides?)` -- creates a `RoutingConfig` with version 1

**Test groups** (~20 tests):

1. **Basic matching** (5 tests):
   - Matches rule with repo glob pattern
   - Matches rule with `labels.any` criteria
   - Matches rule with `labels.all` criteria
   - Matches rule with `issueType` criteria
   - Returns empty `matchedRules` when no rules match

2. **Combined criteria / AND logic** (2 tests):
   - Requires ALL specified criteria to match (repo + labels)
   - Treats omitted criteria as "match anything"

3. **Label edge cases** (4 tests):
   - `labels.any` matches if issue has at least one matching label
   - `labels.all` fails if issue is missing any required label
   - Label matching is case-insensitive
   - Both `labels.any` and `labels.all` must be satisfied when both specified

4. **Negate** (2 tests):
   - `negate: true` inverts the match result
   - `negate: false` (default) does not invert

5. **Enabled/disabled** (2 tests):
   - Skips rules with `enabled: false`
   - Includes rules with `enabled: true` or `undefined`

6. **stopOnFirstMatch** (4 tests):
   - Stops after first match when `stopOnFirstMatch: true` (default)
   - Continues evaluating all rules when `stopOnFirstMatch: false`
   - Sets `stoppedEarly: true` when stopped early
   - Sets `stoppedEarly: false` when all rules evaluated

7. **Repo glob patterns** (6 tests):
   - `my-org/*` matches `my-org/repo-name`
   - `my-org/*` does not match `other-org/repo-name`
   - `*` matches single-segment repo names
   - `**` matches multi-segment paths
   - Exact repo name matches exactly
   - Repo matching is case-insensitive

### Success Criteria
- [ ] Automated: `cd plugin/ralph-hero/mcp-server && npm run build` -- zero type errors
- [ ] Automated: `cd plugin/ralph-hero/mcp-server && npm test` -- all ~20 new tests pass, existing tests unaffected
- [ ] Manual: Review that `routing-engine.ts` imports from `./routing-types.js` (not inline types)
- [ ] Manual: Verify no new runtime dependencies added to `package.json`

---

## Integration Testing
- [ ] Build succeeds: `npm run build` produces `dist/lib/routing-engine.js`
- [ ] All existing tests still pass (no regressions)
- [ ] New `routing-engine.test.ts` tests all pass
- [ ] TypeScript strict mode: no `any` types, all helpers properly typed

## References
- Research: [GH-0167 Routing Matching Engine Research](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0167-routing-matching-engine.md)
- Types: [routing-types.ts (GH-166)](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/routing-types.ts)
- Pattern reference: [pipeline-detection.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts)
- Test pattern: [pipeline-detection.test.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/__tests__/pipeline-detection.test.ts)
- Related issues: [GH-168](https://github.com/cdubiel08/ralph-hero/issues/168) (config loader), [GH-171](https://github.com/cdubiel08/ralph-hero/issues/171) (Actions script), [GH-179](https://github.com/cdubiel08/ralph-hero/issues/179) (dry_run)
