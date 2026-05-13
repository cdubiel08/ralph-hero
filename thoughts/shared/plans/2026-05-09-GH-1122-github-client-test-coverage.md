---
date: 2026-05-09
status: draft
type: plan
github_issue: 1122
github_issues: [1122]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1122
primary_issue: 1122
parent_plan: thoughts/shared/plans/2026-05-07-GH-1118-test-coverage-hardening-epic.md
tags: [testing, mcp-server, github-client, coverage]
---

# Deepen github-client.ts Test Coverage - Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-05-07-GH-1118-test-coverage-hardening-epic]]

## Overview

Single XS issue, single-PR atomic implementation:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-1122 | Phase 4: Deepen github-client.ts test coverage | XS |

## Shared Constraints

Inherited from parent plan-of-plans (`2026-05-07-GH-1118-test-coverage-hardening-epic.md`):

- Tests live under `plugin/ralph-hero/mcp-server/src/__tests__/`.
- Vitest is the test runner; `vi.mock` is used at module scope to stub `@octokit/graphql`.
- ESM imports require `.js` extensions on relative paths.
- `@octokit/graphql` v9 reserves `query`, `method`, and `url` as option keys — never use these as GraphQL variable names.
- Existing test file uses `vi.mock("@octokit/graphql", ...)` at top of file with `mockGraphql.defaults = vi.fn().mockReturnValue(mockGraphql)`. Preserve this pattern; extend, do not replace.
- Coverage thresholds enforced via `vitest.config.ts` (set in Phase 2 of the epic).

Feature-specific:

- Do not refactor `github-client.ts` — tests only.
- The "project-owner fallback" between `user` and `organization` GraphQL shapes lives in `lib/helpers.ts::fetchProjectForCache`, not `github-client.ts`. For this phase, the `project-owner fallback` describe block asserts that `clientConfig.projectOwner` is preserved on `client.config` and that omission leaves it `undefined` (callers fall back to `owner`). The dual-shape lookup is covered in Phase 3's helpers tests.

## Current State Analysis

`plugin/ralph-hero/mcp-server/src/__tests__/github-client.test.ts` (102 lines) currently asserts:

- Single-token construction returns a client with all four method-shaped properties.
- Config fields are preserved (including `projectToken`, `projectOwner`).
- Same-token-for-both is treated as single-token mode at construction time.

It does NOT assert:

- That `query` and `mutate` route through the repo-token graphql instance, while `projectQuery` and `projectMutate` route through the project-token instance (verifiable via `vi.mocked(graphql.defaults).mock.calls`).
- That `rateLimit` fragment is injected into non-mutation queries but not mutations (`github-client.ts:119-134`).
- That `mutate` / `projectMutate` invalidate `query:` cache entries before executing.
- That `projectOwner` is preserved/optional on `config`.

`github-client.ts:84-104` calls `graphql.defaults` exactly once when `projectToken === token` (or undefined), and twice when they differ. Calls 0 and 1 carry `Authorization: token <repoToken>` and `Authorization: token <projectToken>` respectively. The returned `graphqlWithAuth` and `projectGraphqlWithAuth` functions are the closure that `executeGraphQL` switches between based on its third arg.

## Desired End State

- Four new `describe` blocks added to `github-client.test.ts`, each containing one or more named `it(...)` cases.
- `lib/github-client.ts` line coverage exceeds 85% (currently dominated by construction; new tests exercise `executeGraphQL`, `query`, `mutate`, `projectQuery`, `projectMutate`).
- Toggling rateLimit injection off in `github-client.ts` (e.g., commenting out the `if (!isMutation && ...)` block) causes the rateLimit injection test to fail.
- `npm test` passes.

### Verification

- [ ] `npm test` passes from `plugin/ralph-hero/mcp-server/`.
- [ ] Coverage report shows `src/github-client.ts` line coverage > 85%.
- [ ] Removing the rateLimit injection block in source breaks the new injection test.
- [ ] All four behaviors covered by named `it(...)` cases in named `describe(...)` blocks.

## What We're NOT Doing

- Refactoring `github-client.ts`.
- Lib-module tests (covered by Phase 3 / GH-1121).
- Changing existing tests in `github-client.test.ts`.
- Testing the `restPost` fetch path (out of scope for this phase per issue body).
- Testing project-owner user/organization GraphQL dual-shape resolution (lives in `helpers.ts`, covered by Phase 3).

## Implementation Approach

Single phase, single file. Extend the existing `vi.mock` setup to allow per-test inspection of `graphql.defaults` calls and the `mockGraphql` callable's call args. Add four `describe` blocks. Each uses fresh `vi.clearAllMocks()` in `beforeEach` to keep call-count assertions hermetic.

The mock currently returns `mockGraphql` from `graphql.defaults`. We need to assert that:
1. `graphql.defaults` was called once per distinct token at construction.
2. The function returned by each `graphql.defaults` call is what gets invoked when `query` / `projectQuery` / `mutate` / `projectMutate` are called.

Since the same `mockGraphql` is returned for every `defaults` call, distinguishing routing requires inspecting `graphql.defaults.mock.calls[i][0].headers.authorization`. Test design pivots on that.

---

## Phase 1: Extend github-client.test.ts with four behavior describe blocks
- **depends_on**: null

### Overview

Extend `github-client.test.ts` with four new `describe` blocks covering split-token routing, project-owner fallback, mutate/projectMutate behavior, and rateLimit fragment injection. Preserve all existing tests.

### Tasks

#### Task 1.1: Add `beforeEach` cleanup and shared mock helpers
- **files**: `plugin/ralph-hero/mcp-server/src/__tests__/github-client.test.ts` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] A top-level `beforeEach(() => { vi.clearAllMocks(); })` is added so per-test call-count assertions are hermetic.
  - [ ] Existing tests still pass after this change (no behavior change for them).
  - [ ] Import `beforeEach` from `vitest`.

#### Task 1.2: Add `split-token routing` describe block
- **files**: `plugin/ralph-hero/mcp-server/src/__tests__/github-client.test.ts` (modify), `plugin/ralph-hero/mcp-server/src/github-client.ts` (read)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] New `describe("split-token routing", ...)` block exists.
  - [ ] `it("calls graphql.defaults twice with distinct authorization headers when token !== projectToken")` asserts `vi.mocked(graphql.defaults).mock.calls.length === 2` and that the two `headers.authorization` values are `token repo-tok` and `token project-tok`.
  - [ ] `it("calls graphql.defaults once when token === projectToken")` asserts only one call.
  - [ ] `it("calls graphql.defaults once when projectToken is omitted")` asserts only one call.
  - [ ] All three tests pass.

#### Task 1.3: Add `project-owner fallback` describe block
- **files**: `plugin/ralph-hero/mcp-server/src/__tests__/github-client.test.ts` (modify)
- **tdd**: true
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] New `describe("project-owner fallback", ...)` block exists.
  - [ ] `it("preserves projectOwner on config when provided")` asserts `client.config.projectOwner === "alt-owner"` when supplied.
  - [ ] `it("leaves projectOwner undefined when omitted so callers fall back to owner")` asserts `client.config.projectOwner === undefined` and `client.config.owner` is set.
  - [ ] Block contains an inline comment noting that user/organization GraphQL dual-shape resolution is tested in `helpers.test.ts`.

#### Task 1.4: Add `mutate / projectMutate` describe block
- **files**: `plugin/ralph-hero/mcp-server/src/__tests__/github-client.test.ts` (modify), `plugin/ralph-hero/mcp-server/src/github-client.ts` (read)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] New `describe("mutate / projectMutate", ...)` block exists.
  - [ ] `it("mutate passes mutation string and variables through to the underlying graphql callable")` invokes `await client.mutate("mutation Foo($x: Int!) { ... }", { x: 1 })` and asserts the mock was called with the same mutation string and variables.
  - [ ] `it("projectMutate routes through the project graphql instance when split tokens are configured")` asserts that after `await client.projectMutate(...)`, the most recent call was made through the function returned by the second `graphql.defaults` call (i.e., split-token mode produces two separate callables; test by inspecting which `defaults` invocation produced the callable, or by configuring `mockGraphql.defaults` to return distinguishable spies per call).
  - [ ] `it("mutate invalidates cached query: prefix entries before executing")` pre-seeds `client.getCache().set("query:abc", "stale")`, calls `await client.mutate("mutation { x }")`, then asserts `client.getCache().get("query:abc") === undefined`.
  - [ ] All three tests pass.

#### Task 1.5: Add `rateLimit fragment injection` describe block
- **files**: `plugin/ralph-hero/mcp-server/src/__tests__/github-client.test.ts` (modify), `plugin/ralph-hero/mcp-server/src/github-client.ts` (read)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] New `describe("rateLimit fragment injection", ...)` block exists.
  - [ ] `it("injects rateLimit fragment into non-mutation queries that lack it")` calls `await client.query("query GetThing { thing { id } }")` and asserts the underlying mock callable received a query string containing both `rateLimit` and `remaining`.
  - [ ] `it("does not inject rateLimit fragment into mutations")` calls `await client.mutate("mutation DoThing { doThing { id } }")` and asserts the received mutation string does NOT contain `rateLimit`.
  - [ ] `it("does not double-inject when query already contains rateLimit")` calls `await client.query("query { rateLimit { remaining } thing { id } }")` and asserts the received query contains exactly one occurrence of `rateLimit {`.
  - [ ] Manually verified: temporarily commenting out `github-client.ts:122-134` (the injection block) causes the first test in this block to fail.

### Phase Success Criteria

#### Automated Verification:
- [x] `npm run build` (from `plugin/ralph-hero/mcp-server/`) — no errors
- [x] `npm test` (from `plugin/ralph-hero/mcp-server/`) — all passing (1 pre-existing failure in `tool-registration.test.ts` unrelated to GH-1122)
- [x] `npx vitest run src/__tests__/github-client.test.ts --coverage` — `src/github-client.ts` line coverage 90.41% (>85%)

#### Manual Verification:
- [x] Comment out the `if (!isMutation && !queryString.includes("rateLimit"))` block in `github-client.ts` and confirm the rateLimit injection test fails. Restore the block. — Verified: toggling the predicate to `if (false && ...)` made the "injects rateLimit fragment into non-mutation queries that lack it" test fail; source restored.
- [x] Inspect new test output — four new `describe` blocks visible with named `it(...)` cases.

**Creates for next phase**: N/A (atomic single-phase plan).

---

## Integration Testing

- [ ] Full mcp-server test suite (`npm test`) passes, including pre-existing `github-client.test.ts` cases.
- [ ] Coverage thresholds set in Phase 2 of epic (GH-1120) still pass.

## References

- Issue: https://github.com/cdubiel08/ralph-hero/issues/1122
- Parent epic: https://github.com/cdubiel08/ralph-hero/issues/1118
- Parent plan: [thoughts/shared/plans/2026-05-07-GH-1118-test-coverage-hardening-epic.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-05-07-GH-1118-test-coverage-hardening-epic.md)
- File under test: `plugin/ralph-hero/mcp-server/src/github-client.ts`
- Existing tests: `plugin/ralph-hero/mcp-server/src/__tests__/github-client.test.ts`
