---
date: 2026-07-21
status: draft
type: plan
tags: [mcp-server, issue-tools, github-search, dedup, project-v2]
github_issue: 1572
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1572
primary_issue: 1572
estimate: S
---

# Repo-wide issue search: close the Project-V2 scoping blind spot in `list_issues`

## Prior Work

- `builds_on:: [[thoughts/shared/research/2026-02-16-GH-0024-smart-duplicate-detection-triage.md]]` — the 2026-02-16 triage doc already flagged "No GitHub search API integration — all matching is client-side after fetching up to 500 items" and noted GitHub's `search` GraphQL API supports `in:title`/`in:body`/boolean qualifiers not available client-side. That doc predates `directions-tools.ts:fetchOpenPRs` and `debug-tools.ts:findExistingDebugIssue`, both of which since integrated `search` — this plan generalizes that now-established pattern into `list_issues` and `create_issue`.
- `builds_on:: [[docs/plans/2026-03-04-multi-repo-portfolio-management-design.md]]` — documents `list_issues`'s existing `repoFilter` param. That param filters *already-fetched project items* client-side; it does not reach issues absent from the project board, so it does not close the gap this plan addresses.
- `tensions:: [[ralph/skills/form/duplicate-detection.md]]` — `/ralph:form`'s dedup step (Step 3, "Existing issues") relies exclusively on `list_issues` with a topic `query` string as its only GitHub-side dedup signal, with no repo-wide fallback. It is a second real consumer exposed to the same blind spot that caused the GH-1572 incident; not a phase in this plan (that skill can adopt `scope: "repo"` separately) but worth flagging so a reviewer doesn't assume `list_issues`'s consumers are limited to ad-hoc dashboard queries.

## Overview

Investigating a downstream duplicate-issue-filing incident, an agent used `ralph_hero__list_issues` as its sole existence check for two candidate bug reports. Both queries came back empty, so the agent concluded no prior issue existed and filed two duplicates plus a false-alarm issue. The premise was false: both issues already existed in the repository (#1523, #1599), filed directly via GitHub's REST API by a GitHub App, correctly labeled — they simply were never added to the repo's Projects V2 board. `list_issues` enumerates Project V2 board items exclusively (`mcp-server/src/tools/issue-tools.ts:218-270`, a full `ProjectV2.items` scan via `client.projectQuery()`); any issue that exists in the repo but isn't a project item is structurally invisible to it, and a clean/empty result reads indistinguishably from "doesn't exist."

This plan closes the gap on three fronts, sized to ship in one PR:

1. Make the scoping limitation loud in the tool description so agents stop reading an empty `list_issues` result as "issue doesn't exist."
2. Add a repo-wide search path (`scope: "repo"` on `list_issues`) that queries GitHub's Issues Search API directly, independent of Project V2 membership — reusing the `search(type: ISSUE, ...)` pattern already established by `directions-tools.ts:fetchOpenPRs` and `debug-tools.ts:findExistingDebugIssue`.
3. Add an opt-out-by-default dedup safety net to `create_issue` that runs an exact-title repo-wide search before creating and refuses (loudly, with the matching issue's number/URL) rather than silently creating a duplicate — the same failure mode as the incident, caught one layer deeper.

Item 4 from the issue (a periodic board-sync utility) is explicitly out of scope — see "What We're NOT Doing."

## Current State Analysis

`list_issues` (`mcp-server/src/tools/issue-tools.ts:63-507`) resolves config via `resolveFullConfigOptionalRepo()` (`helpers.ts:622-640`), which unconditionally requires `projectNumber` and `projectOwner` (throws otherwise, `helpers.ts:628-638`) — there is no code path in the tool that can run without first resolving a Project V2 board. It then fetches `ProjectV2.items` via `client.projectQuery()` with `scanUntilExhausted: true` (`issue-tools.ts:218-270`) — a full, uncapped project scan, but a project scan nonetheless. All 20+ filter blocks (`issue-tools.ts:278-456`, `state`/`reason`/`workflowState`/`estimate`/`priority`/`iteration`/`label`/`repoFilter`/`has`/`no`/`exclude*`/`query`/`updatedSince`/`updatedBefore`) operate client-side on the already-fetched project items; none reach repo issues absent from the board. The tool description (`issue-tools.ts:65-66`) reads as exhaustive ("Fetches all project items (full project scan, no silent 500-cap)") without stating the Project-V2-only scope.

`create_issue` (`issue-tools.ts:931-1184`) has no pre-creation existence check anywhere in its flow: registry owner resolution → `resolveFullConfig` → registry defaults merge → `ensureFieldCache` → Step 1 repo-ID lookup (cached 1h) → Step 2 label-ID resolution (cached 5m) → Step 3 `createIssue` mutation → node-ID cache write → Step 4 add-to-project → Step 5 field writes. A caller (human, agent, or another tool) that believes an issue doesn't exist — because `list_issues` told it so, incorrectly — has nothing else standing between it and a duplicate.

GitHub's `search(type: ISSUE)` GraphQL API is already used twice in this codebase, both via `client.query()` (repo token) rather than `client.projectQuery()`, and both are the concrete template for this plan:

- `directions-tools.ts:367-424` (`fetchOpenPRs`) — `search(query: "is:pr is:open repo:<nameWithOwner>", type: ISSUE, first: 100)`, fragment on `... on PullRequest`, best-effort (`try`/`catch`, errors logged and swallowed so a missing `repo` scope can't block direction computation).
- `debug-tools.ts:64-117` (`findExistingDebugIssue`) — `search(query: "repo:owner/repo is:issue is:open label:debug-auto <hash> in:body updated:>=<date>", type: ISSUE, first: 10)`, fragment on `... on Issue { number id body }`, also `try`/`catch` with a swallowed-and-logged failure mode (caller creates a duplicate on search failure rather than blocking entirely).

Both route through the same `executeGraphQL()` (`github-client.ts:142-268`); `query()` and `projectQuery()` differ only in which bearer token is attached (`github-client.ts:113-129`) — both hit the identical GraphQL endpoint, so a repo-scoped search needs no new client plumbing.

`resolveConfig()` (`helpers.ts:550-566`) requires both `owner` AND `repo` (throws on either missing) with no project dependency at all — this is the correct resolver for the new repo-scope path (`resolveFullConfigOptionalRepo` is wrong here: it demands a project that repo-scope search must not need).

`/ralph:form`'s duplicate-detection step (`ralph/skills/form/duplicate-detection.md:22-23`) calls `list_issues` with a topic `query` string as its only GitHub-side dedup signal today — a second real consumer of the same blind spot, not touched by this plan but worth noting for a reviewer.

### Key Discoveries

- `mcp-server/src/tools/issue-tools.ts:204-216` — `list_issues` calls `resolveFullConfigOptionalRepo()` then unconditionally calls `ensureFieldCache()` and reads `fieldCache.getProjectId()` before any GraphQL fetch — the entire tool is structurally project-gated before line 218.
- `mcp-server/src/lib/helpers.ts:622-640` — `resolveFullConfigOptionalRepo` throws if `projectNumber`/`projectOwner` can't be resolved; there is no "repo only" resolution path reused from elsewhere in this tool today.
- `mcp-server/src/lib/helpers.ts:550-566` — `resolveConfig` (owner + repo required, no project) is the correct resolver to reuse for the new repo-scope branch.
- `mcp-server/src/tools/debug-tools.ts:64-117` — `findExistingDebugIssue` is the closest existing analog: `search(type: ISSUE)` via `client.query()`, qualifier-string construction, `try`/`catch` with logged-and-swallowed failure.
- `mcp-server/src/tools/directions-tools.ts:367-424` — `fetchOpenPRs` is the second analog; same `search`/`client.query()`/swallowed-failure shape, applied to PRs instead of issues.
- `mcp-server/src/github-client.ts:113-129`, `142-268` — `query()` and `projectQuery()` share `executeGraphQL()`; only the bearer token differs. No new client method is needed.
- `mcp-server/src/tools/issue-tools.ts:472-501` — the `list_issues` response shape (`formattedItems` + `{filteredCount, items}`) is the contract downstream consumers already parse; the repo-scope response must stay shape-compatible (project-only fields `null` rather than the field omitted, so existing consumers doing `item.workflowState` don't need an `undefined`-check they don't already have).
- `mcp-server/src/tools/activity-tools.ts:19` — `category: z.enum(["work", "meta", "all"]).default("work")` is the in-file house-style precedent for an enum-with-default scope-like param; `list_issues`'s own `state: z.enum(["OPEN","CLOSED"]).optional()` (`issue-tools.ts:114-120`) is the in-tool precedent for "omitted = broadest."
- `mcp-server/src/__tests__/issue-tools.test.ts:1-16` — structural convention: `fs.readFileSync` the tool source, assert on schema/query substrings, no network calls.
- `mcp-server/src/__tests__/create-issue-defaults.test.ts:1-60` and `mcp-server/src/__tests__/collate-debug-phase3b.test.ts:1-56` — behavioral convention: extract the handler via `server._registeredTools["ralph_hero__<tool>"].handler(args, extra)`, mock `GitHubClient` as a plain object literal with independent per-method response queues (the phase3b test's mock additionally routes by substring-matching the query text, which is the right shape for a test that must distinguish the repo-ID query, the labels query, and the new search query from each other).
- `ralph/skills/form/duplicate-detection.md:22-23` — a second, real, in-repo consumer of `list_issues`'s project-only scoping; not part of this plan's phases, flagged for plan-review awareness only.

## Desired End State

1. `list_issues`'s tool description states plainly, near the front, that the default result set is Project-V2-board membership, not repo membership, and that a clean/empty result does not mean "no matching issue exists in the repo."
2. `list_issues` accepts `scope: "project" | "repo"` (default `"project"`, fully backward compatible). `scope: "repo"` runs a GitHub Issues Search API query against the resolved `owner/repo`, independent of Project V2 membership, honoring the filter params that map cleanly onto GitHub search qualifiers (`label`, `query`, `state`, `reason`, `updatedSince`/`updatedBefore`, `excludeLabels`, `orderBy`, `limit`) and returning a `toolError` (not a silent no-op) when a project-only filter (`workflowState`, `estimate`, `priority`, `iteration`, `has`, `no`, `excludeWorkflowStates`, `excludeEstimates`, `excludePriorities`, `profile`, `repoFilter`) is combined with `scope: "repo"`.
3. `create_issue` accepts `skipDedupeCheck` (default `false`). When not skipped, it runs an exact-title (case-insensitive, normalized) repo-wide search before creating; on a match it returns a `toolError` naming the matching issue's number and URL instead of creating a duplicate. `skipDedupeCheck: true` bypasses the check entirely (explicit opt-out, not a fuzzy-match override).
4. A shared, independently-testable helper (`mcp-server/src/lib/repo-issue-search.ts`) builds the search qualifier string and executes the `search(type: ISSUE)` query — used by both `list_issues`'s `scope: "repo"` path and `create_issue`'s dedup check, so the two stay behaviorally consistent and the qualifier-building logic is unit-testable without going through either tool's handler.
5. Both new code paths fail the way `findExistingDebugIssue` and `fetchOpenPRs` already fail: a GitHub search error is caught, logged via `console.error`, and surfaces as a `toolError` for `list_issues`'s repo scope (the caller explicitly asked for repo-wide data; silently returning nothing would recreate this exact bug) but is swallowed-and-logged for `create_issue`'s dedup pre-check (a dedup-check failure must not block issue creation entirely — the tool falls back to "create without dedup" rather than becoming newly unable to create issues at all).

### Verification

- `npm test` (from `mcp-server/`) passes, including new structural and behavioral suites for both the `scope` param and the dedup check.
- `npx vitest run src/__tests__/issue-tools.test.ts src/__tests__/create-issue-defaults.test.ts src/__tests__/repo-issue-search.test.ts` (and any new dedicated files from Phase 2/3) pass in isolation.
- `npm run build` (tsc) exits 0.
- Manual: call `list_issues` with `scope: "repo"` against a repo issue known to be off the Project V2 board (or a fixture standing in for one) and confirm it is returned; call `list_issues` with `scope: "repo"` plus `workflowState` set and confirm a clear `toolError`, not silent success with an empty/ignored filter.
- Manual: call `create_issue` with a title matching an existing open issue and confirm a `toolError` naming the match; call again with `skipDedupeCheck: true` and confirm it creates normally.

## What We're NOT Doing

- **Periodic "sync untracked issues onto the board" utility (issue item #4)** — explicitly out of scope per triage. This plan makes untracked issues *discoverable on demand* via `scope: "repo"`; it does not reconcile them onto the Project V2 board automatically or on a schedule. Recommend filing a separate follow-up issue for that utility if it's wanted.
- **Fuzzy/similarity-based duplicate matching in `create_issue`** — the dedup safety net in Phase 3 is an exact-title match only (case-insensitive, whitespace-normalized). Body-similarity or fuzzy-title matching is a materially different (and riskier, false-positive-prone) feature; out of scope here.
- **Cross-repo repo-wide search** — `scope: "repo"` targets exactly the resolved `owner/repo` pair (same as `create_issue`'s existing repo resolution). Multi-repo repo-wide search is a different shape of tool and isn't needed to close this gap.
- **Retrofitting `/ralph:form`'s duplicate-detection step to use `scope: "repo"`** — flagged in Prior Work as a real second consumer of this blind spot, but adopting the new capability there is a skill-doc change, not an MCP-server change, and is left for a separate pass so this plan stays inside `mcp-server/`.
- **Reconciling `workflowState`/`estimate`/`priority`/`iteration` for repo-scope results** — these are Project V2 field values with no repo-side equivalent. Repo-scope results return `null` for all four rather than attempting any inference (e.g. "not on board" heuristics); combining a project-only filter with `scope: "repo"` is a hard error (see Desired End State #2), not a silent ignore.

## Design Decisions & Open Ambiguities

- **`scope` param on `list_issues` vs. a new `search_issues` tool** — options: (a) add `scope: "project" | "repo"` to the existing `list_issues` tool; (b) add a standalone `ralph_hero__search_issues` tool. **Decided: (a), a `scope` param on `list_issues`.** Rationale: `list_issues`'s existing filter surface (`label`, `query`, `state`, `reason`, `updatedSince`/`updatedBefore`, `excludeLabels`) already maps directly onto GitHub search qualifiers (`label:`, `in:title`/`in:body`, `is:open`/`is:closed`, `reason:`, `updated:>=`/`updated:<`, `-label:`) — a second tool would either duplicate that filter schema verbatim or offer a narrower one, both worse than reusing it. The house style for "add an enum that changes result scope while keeping one tool surface" is already established in this file (`state: z.enum([...]).optional()`) and in `activity-tools.ts` (`category: z.enum([...]).default("work")`). A `scope` param is also the option the issue body itself lists first. The main cost — the handler now has two structurally different code paths (project-item fetch vs. search-query fetch) inside one `server.tool()` callback — is bounded by extracting the repo-scope path into the shared `repo-issue-search.ts` helper (Phase 2), so the `list_issues` handler itself only gains a branch, not a second implementation.
- **`create_issue` dedup default: on-by-default (`skipDedupeCheck` opt-out) vs. off-by-default (`dedupeCheck` opt-in)** — options: (a) default the check ON, require explicit `skipDedupeCheck: true` to bypass; (b) default the check OFF, require explicit `dedupeCheck: true` to enable. **Decided: (a), on-by-default.** Rationale: the actual incident this issue documents is exactly "an agent trusted an empty existence check and created a duplicate" — an opt-in check protects only callers who already suspect a duplicate risk, which is precisely the set of callers who *don't* trigger this failure mode (they'd have checked manually anyway). An opt-out check protects the whole caller population by default, matching the "silent failure is the enemy" framing of this issue. The cost (one extra `search` call's latency per `create_issue`, and a possible false-positive block on a legitimately-reused title) is bounded by the exact-title-only match criterion (Phase 3) and the always-available `skipDedupeCheck: true` override for callers that know better (e.g. bulk-seeding scripts, tests).
- **Dedup-check failure mode: block `create_issue` vs. fall back to "create anyway"** — options: (a) a search API error during the dedup check blocks issue creation entirely; (b) a search API error is logged and swallowed, falling back to "create without dedup" (matching `findExistingDebugIssue`'s existing failure mode). **Decided: (b), fall back to "create anyway" on search failure.** Rationale: `create_issue` must not become newly incapable of creating issues (e.g. on a token without search scope, or a transient search outage) just because a *best-effort* safety net failed; that would be a worse regression than the bug this plan fixes. This mirrors `findExistingDebugIssue`'s already-established behavior (`debug-tools.ts:109-116`) — "search fails → treat as no-match → proceed" — for exactly the same reason.

All three judgment calls above were resolvable from the research already gathered (house-style precedent, the two existing `search` integrations, and the issue's own priority ordering) — none required an open `#### Decision:` block.

None — no open design decisions.

## Implementation Approach

Three phases, each independently shippable but ordered for dependency reasons: Phase 1 is a pure documentation fix (tool descriptions only, no behavior change) and can land standalone. Phase 2 introduces the shared search helper (`mcp-server/src/lib/repo-issue-search.ts`) and wires `scope: "repo"` into `list_issues` — this is the core deliverable and the load-bearing new code. Phase 3 reuses Phase 2's helper to add the `create_issue` dedup safety net; it is ordered after Phase 2 specifically so it consumes the already-built, already-tested helper rather than duplicating qualifier-building logic. File ownership: Phase 1 and Phase 2 both touch `issue-tools.ts` (different, non-overlapping regions — the tool description string vs. the handler body/schema) so they're listed as parallel-safe (`depends_on: null`) but a human merging both should expect a small textual adjacency; Phase 3 exclusively owns the `create_issue` block of `issue-tools.ts` plus the new dedup test file, and depends on Phase 2 for the helper import.

## Phase 1: Loud scoping disclosure in tool descriptions

depends_on: null

### Overview

Rewrite `list_issues`'s (and briefly, `create_issue`'s) tool description so an agent reading it can't mistake an empty/clean result for "issue doesn't exist in the repo." Pure string change, no schema or behavior change.

### Changes Required

#### 1. `list_issues` tool description
**File**: `mcp-server/src/tools/issue-tools.ts`
**Changes**: Rewrite the description string at `issue-tools.ts:65` to lead with the scoping caveat, e.g.: state plainly that results are drawn from the configured Project V2 board's items by default, that an issue existing in the GitHub repo but absent from the board (bot/App-created via REST API, predates project automation, manually removed from the board) will NOT appear, and that `scope: "repo"` (added in Phase 2) is the way to check repo-wide existence independent of board membership. Keep the existing "no silent 500-cap" framing (still true and still useful) but no longer let it read as "this is exhaustive over the repo."

#### 2. `create_issue` tool description
**File**: `mcp-server/src/tools/issue-tools.ts`
**Changes**: Add one sentence to the description at `issue-tools.ts:933` noting the forthcoming dedup behavior (finalized in Phase 3's wording pass) so the two phases' description edits don't fight each other — Phase 1 adds a forward-reference placeholder sentence; Phase 3 fills in the concrete `skipDedupeCheck` behavior once it exists. (If Phase 3 lands in the same PR/session as Phase 1, this can be done as one edit — call it out here so a partial-Phase-1-only ship doesn't leave a dangling promise.)

### Success Criteria

#### Automated Verification
- [x] `npx vitest run src/__tests__/issue-tools.test.ts` passes (existing structural suite still green — no schema changes in this phase).
- [x] `npm run build` exits 0.
- [x] `grep -q "Project V2 board" mcp-server/src/tools/issue-tools.ts` (or equivalent phrasing check) confirms the new caveat text is present — add as a one-line structural assertion in `issue-tools.test.ts` alongside the existing `describe("list_issues structural", ...)` block. (Implemented as 4 assertions on the stable `scope: "repo"` / `scope: "project"` tokens rather than exact prose, per review feedback.)

#### Manual Verification
- [ ] Read the rendered tool description (e.g. via an MCP client's tool-list output) and confirm the scoping caveat appears near the top, not buried at the end.

## Phase 2: Repo-wide search — `repo-issue-search.ts` helper + `scope` param on `list_issues`

depends_on: null

### Overview

Add a new `mcp-server/src/lib/repo-issue-search.ts` module that builds a GitHub search qualifier string and executes it via `client.query()`, following the `findExistingDebugIssue`/`fetchOpenPRs` pattern. Wire `scope: "project" | "repo"` into `list_issues`'s Zod schema and handler, branching to the new helper when `scope === "repo"` instead of the existing `ProjectV2.items` fetch.

### Changes Required

#### 1. Shared repo search helper (new file)
**File**: `mcp-server/src/lib/repo-issue-search.ts` (create)
**Changes**: Export `buildRepoSearchQuery(owner, repo, filters)` (pure function — takes the subset of `list_issues` filters that map onto GitHub search qualifiers: `label`, `query` → `in:title`/`in:body`, `state` → `is:open`/`is:closed`, `reason` → `reason:completed`/`reason:"not planned"`/`reason:reopened`, `updatedSince`/`updatedBefore` → `updated:>=`/`updated:<` via the existing `parseDateMath` from `date-math.js`, `excludeLabels` → `-label:`, `orderBy` → `sort:created-desc`/`sort:updated-desc`/`sort:comments-desc`; always includes `repo:owner/repo is:issue`) and `searchRepoIssues(client, owner, repo, filters, limit)` (executes the query via `client.query()` with a `search(type: ISSUE, first: $limit)` GraphQL query, fragment on `... on Issue { number title body state stateReason url createdAt updatedAt labels(first: 10) { nodes { name } } assignees(first: 5) { nodes { login } } repository { name nameWithOwner } }`, mirroring the field selection already used by `list_issues`'s project-scope query at `issue-tools.ts:230-241` so the two paths' raw shapes line up before formatting). Wrap the query execution in `try`/`catch`; on failure, `console.error` and re-throw (this path is NOT best-effort like `findExistingDebugIssue` — Phase 2's caller, `list_issues`, must surface the error as a `toolError` rather than silently returning empty results, since a silent-empty-on-error here would recreate the exact bug GH-1572 documents; Phase 3's caller catches and swallows separately, see Phase 3).

#### 2. `list_issues` schema + handler
**File**: `mcp-server/src/tools/issue-tools.ts`
**Changes**: Add `scope: z.enum(["project", "repo"]).optional().default("project")` to the Zod schema (`issue-tools.ts:66-191` region), following the `state` enum's `.describe()` convention to spell out the difference. In the handler (`issue-tools.ts:192-501`): when `args.scope === "repo"`, (a) validate no project-only filter is set (`workflowState`, `estimate`, `priority`, `iteration`, `has`, `no`, `excludeWorkflowStates`, `excludeEstimates`, `excludePriorities`, `profile`, `repoFilter`) — return `toolError` naming the offending param(s) if any are present; (b) resolve `owner`/`repo` via `resolveConfig()` (not `resolveFullConfigOptionalRepo()` — repo-scope search needs no project resolution at all, so skip `ensureFieldCache`/`fieldCache.getProjectId()` entirely for this branch); (c) call `searchRepoIssues()` from the new helper with the request's `label`/`query`/`state`/`reason`/`updatedSince`/`updatedBefore`/`excludeLabels`/`orderBy`/`limit`; (d) format results into the same `{number, title, state, stateReason, url, updatedAt, workflowState: null, estimate: null, priority: null, iteration: null, labels, assignees}` shape as the existing `formattedItems` mapping (`issue-tools.ts:472-496`) so downstream consumers parsing `items[].number` etc. don't need scope-aware branching; (e) wrap the `searchRepoIssues()` call in `try`/`catch` and return `toolError` on failure (per the helper's non-best-effort contract above). When `scope` is omitted or `"project"`, existing behavior is unchanged — the branch is additive, not a rewrite of the project path.

### Success Criteria

#### Automated Verification
- [x] `npx vitest run src/__tests__/repo-issue-search.test.ts` (new file) passes — unit tests `buildRepoSearchQuery` against representative filter combinations (label-only, query+state, reason mapping, updatedSince/Before via `parseDateMath`, excludeLabels) asserting the exact qualifier string, plus a `searchRepoIssues` test with a stubbed `client.query` confirming the GraphQL shape and response mapping.
- [x] `npx vitest run src/__tests__/issue-tools.test.ts` passes, including new structural assertions (`scope: z.enum(` present in schema) and new behavioral tests (model on `create-issue-defaults.test.ts`'s mock-client harness, in a new `list-issues-scope.test.ts` file) covering: `scope: "repo"` routes to `client.query` not `client.projectQuery`; `scope: "repo"` + `workflowState` returns a `toolError`; `scope` omitted preserves existing project-path behavior byte-for-byte (no regression).
- [x] `npm run build` exits 0.
- [x] `npm test` (full suite) passes — 1643 passed, 1 pre-existing skip.

#### Manual Verification
- [ ] Against a real repo/project pair, call `list_issues` with `scope: "repo"` and a `label` filter matching a known repo issue that is NOT on the Project V2 board; confirm it's returned with `workflowState: null`.
- [ ] Call `list_issues` with `scope: "repo", workflowState: "Backlog"` and confirm a clear `toolError` (not empty success) naming `workflowState` as incompatible with `scope: "repo"`.
- [ ] Call `list_issues` with `scope` omitted against the same repo/project and confirm identical output to pre-change behavior (no regression in the default path).

## Phase 3: `create_issue` dedup safety net

depends_on: [phase-2]

### Overview

Add an on-by-default (`skipDedupeCheck` opt-out) exact-title dedup pre-check to `create_issue`, reusing Phase 2's `searchRepoIssues()` helper. On a match, refuse to create and name the existing issue; on a search failure, log and fall back to creating anyway (best-effort, per the Design Decisions section).

### Changes Required

#### 1. `create_issue` schema + handler
**File**: `mcp-server/src/tools/issue-tools.ts`
**Changes**: Add `skipDedupeCheck: zBoolish().optional().default(false)` to the `create_issue` Zod schema (`issue-tools.ts:934-962` region). In the handler, immediately after `resolveFullConfig()` resolves `owner`/`repo` (`issue-tools.ts:975-978`) and before Step 1's repo-ID lookup — owner/repo are resolved by this point and a dedup hit should short-circuit before any further queries/mutations — insert the dedup check: when `!args.skipDedupeCheck`, call `searchRepoIssues(client, owner, repo, { query: args.title, state: "OPEN" }, 10)` from the Phase 2 helper wrapped in its own `try`/`catch` (this call site's failure mode differs from `list_issues`'s: log via `console.error` and treat as no-match, falling through to normal creation — matching `findExistingDebugIssue`'s established best-effort contract, not Phase 2's throw-on-error contract). Among the returned issues, look for an exact case-insensitive, whitespace-normalized title match against `args.title`; on a match, return `toolError` naming the matching issue's `number` and `url` and instructing the caller to pass `skipDedupeCheck: true` to force creation. No match (or a search failure) falls through to the existing Step 1-5 flow unchanged.

#### 2. `create_issue` tool description (completes Phase 1's placeholder)
**File**: `mcp-server/src/tools/issue-tools.ts`
**Changes**: Finalize the description sentence added in Phase 1 to concretely describe the `skipDedupeCheck` behavior and its default.

### Success Criteria

#### Automated Verification
- [ ] `npx vitest run src/__tests__/create-issue-dedup.test.ts` (new file, modeled on `collate-debug-phase3b.test.ts`'s mock-client-with-query-routing pattern and `create-issue-defaults.test.ts`'s independent-per-method-queue pattern) passes: (a) a title-matching existing OPEN issue → `toolError` naming the match, no `createIssue` mutation issued; (b) same scenario with `skipDedupeCheck: true` → creation proceeds normally, no search call issued; (c) a non-matching title → creation proceeds normally after one search call; (d) a search failure (mock throws) → creation proceeds normally (fallback path), confirming the swallowed-failure contract.
- [ ] `npx vitest run src/__tests__/issue-tools.test.ts` passes (existing `create_issue` structural coverage, plus a new assertion that `skipDedupeCheck: zBoolish()` is present in the schema).
- [ ] `npm run build` exits 0.
- [ ] `npm test` (full suite) passes.

#### Manual Verification
- [ ] Call `create_issue` with a title exactly matching an existing open issue's title; confirm a `toolError` naming that issue's number/URL and no new issue is created.
- [ ] Call `create_issue` with the same title and `skipDedupeCheck: true`; confirm a new issue is created despite the title match.
- [ ] Call `create_issue` with a genuinely new title; confirm normal creation with no extra latency-visible failure.

## Testing Strategy

### Unit Tests

- `mcp-server/src/__tests__/repo-issue-search.test.ts` (new) — pure unit tests of `buildRepoSearchQuery` (qualifier-string assembly across filter combinations, including the `reason:` and `sort:` mappings) with no `GitHubClient` involved; a smaller set of `searchRepoIssues` tests with a minimal stubbed `client.query` confirming the GraphQL request shape and response-to-raw-issue mapping.

### Integration Tests

- `mcp-server/src/__tests__/issue-tools.test.ts` — extend with: (a) structural assertions (`fs.readFileSync` substring checks) confirming `scope: z.enum(` and `skipDedupeCheck: zBoolish()` are present in the schemas, and the new scoping-caveat text is present in the `list_issues` description; (b) behavioral tests (mock `GitHubClient`, `server._registeredTools[...].handler()` extraction, per-method response queues per `create-issue-defaults.test.ts`'s pattern) for `list_issues`'s `scope: "repo"` branch — routes to `client.query` not `client.projectQuery`, rejects project-only filters, preserves default-scope behavior unchanged.
- `mcp-server/src/__tests__/create-issue-dedup.test.ts` (new) — behavioral tests for the `create_issue` dedup check, modeled directly on `collate-debug-phase3b.test.ts`'s query-text-routing mock client (needed here too, since the mock must distinguish the new search query from the existing repo-ID and labels queries within one handler invocation).

### Manual Testing Steps

1. Run `list_issues` with `scope: "repo"` against a repo with at least one issue known to be off the Project V2 board; confirm it surfaces.
2. Run `list_issues` with `scope: "repo"` plus a project-only filter; confirm a clear `toolError`, not a silently-ignored filter.
3. Run `create_issue` with a duplicate title; confirm refusal naming the existing issue. Repeat with `skipDedupeCheck: true`; confirm creation proceeds.
4. Read the updated `list_issues` tool description end-to-end and confirm a first-time reader would not conclude an empty result means "doesn't exist in the repo."

## Migration Notes

No data migration. Both schema changes (`scope` on `list_issues`, `skipDedupeCheck` on `create_issue`) are additive with backward-compatible defaults (`scope: "project"`, `skipDedupeCheck: false`) — every existing caller (dashboards, `/ralph:form`, `/ralph:caretake` triage, hero orchestration) continues to see byte-identical behavior unless it opts into the new param. The one caller-visible behavior *change* is `create_issue` now performing one extra `search` GraphQL call per invocation by default (the dedup check) — this adds latency but is not a breaking schema change; callers that need the old zero-search-call behavior pass `skipDedupeCheck: true`. No changes to `~/.ralph-hero/` on-disk state, cache keys, or GraphQL rate-limit accounting beyond the additional search calls (which the existing `RateLimiter` in `github-client.ts` already accounts for uniformly across `query()`-routed calls).

## References

- Issue: `cdubiel08/ralph-hero#1572`
- `mcp-server/src/tools/issue-tools.ts:63-507` (`list_issues`), `:931-1184` (`create_issue`)
- `mcp-server/src/tools/debug-tools.ts:64-117` (`findExistingDebugIssue` — dedup-check template)
- `mcp-server/src/tools/directions-tools.ts:367-424` (`fetchOpenPRs` — second `search()` template)
- `mcp-server/src/github-client.ts:113-129,142-268` (`query()`/`projectQuery()` shared transport)
- `mcp-server/src/lib/helpers.ts:550-566,622-640` (`resolveConfig` vs. `resolveFullConfigOptionalRepo`)
- `mcp-server/src/__tests__/issue-tools.test.ts`, `create-issue-defaults.test.ts`, `collate-debug-phase3b.test.ts` (testing conventions)
- `ralph/skills/form/duplicate-detection.md:22-23` (second real consumer of the scoping blind spot)
- `thoughts/shared/research/2026-02-16-GH-0024-smart-duplicate-detection-triage.md` (prior flag of the missing search-API integration)
- `docs/plans/2026-03-04-multi-repo-portfolio-management-design.md` (`repoFilter` — client-side, not repo-wide)
