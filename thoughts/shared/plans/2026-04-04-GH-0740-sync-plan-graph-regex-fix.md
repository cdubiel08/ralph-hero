---
date: 2026-04-04
status: draft
type: plan
github_issue: 740
github_issues: [740]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/740
primary_issue: 740
tags: [ralph-hero, mcp-server, plan-graph, regex, bug]
---

# Fix sync_plan_graph depends_on parsing - Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-04-04-GH-0740-sync-plan-graph-depends-on-parsing]]

## Overview
1 issue for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-740 | sync_plan_graph removes valid dependency edges — plan depends_on parsing failure | S |

## Shared Constraints

- All work in `plugin/ralph-hero/mcp-server/` directory
- Build: `npm run build` (tsc), Test: `npm test` (vitest run) from `plugin/ralph-hero/mcp-server/`
- ESM module system: imports require `.js` extensions
- Pure function change in `plan-graph.ts` — no I/O, no GitHub calls
- Must not break existing tests that use `(GH-NNN)` format

## Current State Analysis

`parsePlanGraph()` uses a regex that requires literal parentheses around `GH-NNN` in phase headings: `/^## Phase (\d+):.*\(GH-(\d+)\)/`. Plans using `## Phase 1: GH-736 — title` format fail to match, causing 0 edges parsed and all existing edges removed as "stale".

## Desired End State
### Verification
- [ ] Phase headings with `(GH-NNN)` still match (existing format)
- [ ] Phase headings with `GH-NNN` (no parens) also match (new format)
- [ ] Feature headings in plan-of-plans also handle both formats
- [ ] All existing tests pass unchanged
- [ ] New test covers the no-parens heading format
- [ ] Build succeeds: `npm run build`

## What We're NOT Doing
- Not changing plan-graph-tools.ts (consumer, no changes needed)
- Not changing the plan skill template format
- Not adding support for other heading variations beyond `GH-NNN`

## Implementation Approach

Remove `\(` and `\)` from both regexes in plan-graph.ts. Add a test case with no-parens headings.

---

## Phase 1: Fix phase/feature heading regexes + add test (GH-740)
- **depends_on**: null

### Overview
Two regex fixes in plan-graph.ts and one new test case in plan-graph.test.ts.

### Tasks

#### Task 1.1: Fix phase heading regex
- **files**: `plugin/ralph-hero/mcp-server/src/lib/plan-graph.ts` (modify)
- **tdd**: true
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] Line 87: regex changes from `/^## Phase (\d+):.*\(GH-(\d+)\)/` to `/^## Phase (\d+):.*GH-(\d+)/`
  - [ ] Matches `## Phase 1: Core data model (GH-660)` (existing format)
  - [ ] Matches `## Phase 1: GH-736 — title` (new format)

#### Task 1.2: Fix feature heading regex
- **files**: `plugin/ralph-hero/mcp-server/src/lib/plan-graph.ts` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] Line 143: regex changes from `/^### Feature [^:]+:.*\(GH-(\d+)\)/` to `/^### Feature [^:]+:.*GH-(\d+)/`
  - [ ] Matches `### Feature A: Auth middleware (GH-44)` (existing format)
  - [ ] Matches `### Feature A: GH-44 — Auth middleware` (new format)

#### Task 1.3: Add test for no-parens heading format
- **files**: `plugin/ralph-hero/mcp-server/src/__tests__/plan-graph.test.ts` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] New test `"parses depends_on from headings without parentheses around GH-NNN"` added
  - [ ] Test uses plan content with `## Phase N: GH-NNN — title` format (no parens)
  - [ ] Test asserts correct `phaseToIssue` mapping and correct dependency edges

### Phase Success Criteria

#### Automated Verification:
- [ ] `npm run build` from `plugin/ralph-hero/mcp-server/` — no errors
- [ ] `npm test` from `plugin/ralph-hero/mcp-server/` — all passing

#### Manual Verification:
- [ ] Verify the regex change doesn't break the existing test fixtures (all use parens format)

---

## Integration Testing
- [ ] Build succeeds: `cd plugin/ralph-hero/mcp-server && npm run build`
- [ ] All tests pass: `cd plugin/ralph-hero/mcp-server && npm test`

## References
- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-04-GH-0740-sync-plan-graph-depends-on-parsing.md
- Issue: https://github.com/cdubiel08/ralph-hero/issues/740
