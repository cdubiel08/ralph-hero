---
date: 2026-04-30
status: draft
type: plan
github_issue: 921
github_issues: [921, 922, 924]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/921
  - https://github.com/cdubiel08/ralph-hero/issues/922
  - https://github.com/cdubiel08/ralph-hero/issues/924
primary_issue: 921
parent_plan: thoughts/shared/plans/2026-04-29-GH-0918-hello-deterministic-directions.md
tags: [hello, skill, mcp-tool, ranking, determinism, pipeline-dashboard]
---

# Hello Directions Implementation Group (GH-921, GH-922, GH-924) - Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-04-29-GH-0918-hello-deterministic-directions]]
- builds_on:: [[2026-03-03-GH-0480-hello-session-briefing]]
- builds_on:: [[2026-04-22-GH-0838-refine-hello-skill-output-budget]]

## Overview

Three related issues implementing GH-918 in a single PR via three sequential phases:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-921 | Pure ranker library + parent-edge data | S |
| 2 | GH-922 | MCP tool wrapper `ralph_hero__hello_directions` | S |
| 3 | GH-924 | Refactor `SKILL.md` to call `hello_directions` | S |

**Why grouped**: Phase 2 imports from Phase 1's new `lib/directions.ts` module and the extended `DashboardItem` shape. Phase 3 (skill refactor) is the user-visible change and breaks if Phase 2's MCP tool isn't registered. Atomic group landing in a single PR avoids partial MCP server release states (where the auto-publish would ship `pipeline_dashboard` users a `parentNumber`/`parentState` change without the new tool, then a separate release for the tool, then a third for the skill). Phases 1+2 share TypeScript types and tests; Phase 3 has no build impact but exercises the full server. The three issues are linearly dependent: 921 → 922 → 924.

## Shared Constraints

Inherited verbatim from the parent plan-of-plans (`2026-04-29-GH-0918-hello-deterministic-directions.md`):

- **ESM module system**: All internal imports use `.js` extensions (per `CLAUDE.md`).
- **MCP tool naming**: All tools use the `ralph_hero__` prefix and `toolSuccess()`/`toolError()` helpers.
- **Hello is `context: inline`** — must own the `AskUserQuestion` picker; auto mode means no prompts (memory `feedback_auto_mode_no_prompts.md`).
- **Allowlist semantics**: frontmatter `allowed-tools` is for permission auto-approval, not runtime gating (memory `feedback_allowlist_not_blacklist.md`). Update it for consistency, but the skill works either way.
- **MCP server auto-release**: `release.yml` auto-publishes when `mcp-server/` source changes hit `main`. Touching `mcp-server/` source bumps `mcp-server/package.json` + `.claude-plugin/plugin.json`. User has confirmed acceptable.
- **Output-budget rules from GH-0838 must be preserved** in `SKILL.md` after the refactor — explicit regression check via grep.
- **Determinism contract**: byte-identical `directions[]` (modulo `fetchedAt`) across two consecutive calls on the same board state, with `now` injected via `RankConfig` for tests.
- **No new MCP PR-fetching surface**: PRs come from `gh pr list` in the skill and are passed into the new tool as a parameter. No Octokit-in-MCP scope creep.
- **Pure-function-only test reference (`dashboard.test.ts`) is NOT the right pattern for the integration test in Phase 2.** Use `auto-advance-parent.test.ts:81-110` and `repo-inference.test.ts:30-41` as the mock-client pattern reference.
- **Additive GraphQL change**: `trackedInIssues(first: 3)` adds ~30 bytes per item; reused across all consumers (`pipeline_dashboard`, `status`, `report`, `hygiene` silently ignore the new optional fields).

## Current State Analysis

### How `hello` works today

The skill `plugin/ralph-hero/skills/hello/SKILL.md` (151 lines, post-GH-0838) calls `pipeline_dashboard(format=json, includeHealth=true, includeMetrics=false, issuesPerPhase=3)` plus `gh pr list` plus reads `MEMORY.md` in parallel, then asks the LLM to synthesize 3 directions from the truncated dashboard via prose urgency rules. The dashboard payload returns up to 9 phases × 3 issues = up to 27 issues per project plus `health.warnings[]`. With multiple projects this can exceed the LLM context budget ("Dashboard too large" error observed). Ranking is non-deterministic across runs.

### Existing infrastructure that this plan reuses

- `pipeline_dashboard` GraphQL pipeline at [plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts:219-273](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts#L219-L273) — `DASHBOARD_ITEMS_QUERY` and `toDashboardItems` are already exported.
- `paginateConnection` in [plugin/ralph-hero/mcp-server/src/lib/pagination.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/pagination.ts) (imported by `dashboard-tools.ts:13`).
- `resolveProjectOwner` and `resolveProjectNumbers` at [plugin/ralph-hero/mcp-server/src/types.ts:296-310](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/types.ts#L296-L310) — `not` in `helpers.ts` despite the filename suggesting otherwise.
- `LOCK_STATES`, `STATE_ORDER` from [plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts:12-36](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts#L12-L36).
- `DashboardItem` interface at [plugin/ralph-hero/mcp-server/src/lib/dashboard.ts:31-49](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/dashboard.ts#L31-L49).
- Mock-client test pattern at [plugin/ralph-hero/mcp-server/src/__tests__/auto-advance-parent.test.ts:81-110](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/__tests__/auto-advance-parent.test.ts#L81-L110).

### Gap: parent edge missing from `DASHBOARD_ITEMS_QUERY`

`RawDashboardItem.content.trackedInIssues` is **declared** as a type at `dashboard-tools.ts:133` but **not selected** in the GraphQL query (`:228-251`). Adding `trackedInIssues(first: 3) { nodes { number state closedAt } }` is a Phase 1 deliverable. The candidate's own `closedAt` is *already* selected at line 235 (verified during research) — only the parent's `closedAt` is new. `toDashboardItems` (`:168-211`) currently does not populate `parentNumber`/`parentState` because the source field isn't queried.

## Desired End State

After all three phases land:

1. New MCP tool `ralph_hero__hello_directions` exists and returns a fixed-shape JSON payload (≤~50 lines) with up to N (default 3) deterministic directions ranked by an explicit, testable algorithm.
2. Re-running `hello_directions` on the same board state produces byte-identical output (modulo `fetchedAt`).
3. `SKILL.md` calls `hello_directions` instead of `pipeline_dashboard`. Skill is a thin presenter; never sees raw issue arrays larger than the returned `directions[]`.
4. With Priority unset across the board, `hello` still surfaces meaningful directions (phase urgency + stale boost + tree continuity carry the ranking).
5. Tree-continue surfaces in slot 2 whenever criteria match.
6. Lock-state issues surface only when stuck >24h.
7. All new code has unit tests for each ranking criterion; integration tests for the tool wrapper.
8. Output-budget rules from GH-0838 preserved in `SKILL.md`.

### Verification

- [ ] `cd plugin/ralph-hero/mcp-server && npm run build` — no errors
- [ ] `cd plugin/ralph-hero/mcp-server && npm test` — all passing (existing + 13 new ranker tests + 6 new tool tests)
- [ ] `/ralph-hero:hello` produces a ≤40-line briefing with the same top direction across two consecutive runs

## What We're NOT Doing

- Not removing or changing `pipeline_dashboard` (kept for `status`, `report`, `ralph-hygiene`).
- Not changing `pick_actionable_issue`. Team/hero dispatch keeps using it.
- Not changing the Step 4 picker shape or Step 5 Agent() routing in hello (only the data source).
- Not adding rendered-text formatting to the new tool. Output is JSON only — formatting stays in skill prose.
- Not changing the MCP server's PR fetching surface. PRs come from `gh pr list` in the skill.
- Not adding GraphQL changes to `trackedIssues` (children, already fetched). Only `trackedInIssues` (parent) is added.
- Not introducing a separate config file for ranking weights. Weights live as constants in `directions.ts` and as tool params with sensible defaults.
- Not migrating other consumers (`status`, `report`, `team`, `hero`) to the new tool.
- Not adding a Stop hook. Hello stays read-only and produces no artifact.

## Implementation Approach

Three linearly-dependent phases. Phase 1 lands pure functions + GraphQL extension + ranker tests (no MCP surface change). Phase 2 wraps the ranker as the new MCP tool with integration tests. Phase 3 refactors the skill to call the new tool. Each phase has a build/test gate before moving to the next.

The new ranking algorithm in pseudocode (defined in detail in the parent plan, sections 124-156):

```
score(item) =
    priorityScore(item.priority)            // P0=0, none=999
  + phaseScore(item.workflowState)          // Plan in Review=0, In Review=1, Ready for Plan=2, Research Needed=3
  + staleBoost(item, now, stuckThresholdHrs)
  + lockStaleBoost(item, now, lockStaleHrs)
  + treeContinueBoost(item, allItems, now, recentDoneDays)

candidates = items
  .filter(actionable phase OR lock-stale)
  .filter(no open trackedIssues blocking)
  .sort(by score ascending)
  .take(limit)
```

Tree-continue promotion: after sorting, if any tree-continue candidate exists in the top 5 but not in slot 1, it is promoted to slot 2.

PRs scored separately: `prScore(pr) = REVIEW_REQUIRED ? -200 : 0 + ageHoursPenalty(pr)`. Drafts excluded. `headRefName` matching `feature/GH-NNNN` links back to issue numbers in the output.

**Kind precedence**: `lock-stale` > `tree-continue` > `pr` > `issue`.

---

## Phase 1: GH-921 — Pure ranker library + parent-edge data
- **depends_on**: null

### Overview

Land all ranking logic as pure functions with full test coverage and extend the existing GraphQL query with the parent edge. No MCP surface change, no skill change. This is the durable, testable foundation that Phase 2 wraps.

### Tasks

#### Task 1.1: Extend `DASHBOARD_ITEMS_QUERY` with `trackedInIssues`
- **files**: `plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [x] In `DASHBOARD_ITEMS_QUERY` (`:219-273`), the `... on Issue` block contains a new line `trackedInIssues(first: 3) { nodes { number state closedAt } }` after `trackedIssues(first: 10) { nodes { number state } }` at line 239.
  - [x] The candidate's own `closedAt` (line 235) is unchanged — not re-added.
  - [x] `RawDashboardItem.content.trackedInIssues` (line 133) is updated to include `closedAt: string | null`: `trackedInIssues?: { nodes: Array<{ number: number; state: string; closedAt: string | null }> };`
  - [x] No other behavior changes.
  - [x] `grep -q "trackedInIssues(first: 3)" plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts`

#### Task 1.2: Populate `parentNumber`/`parentState` in `toDashboardItems`
- **files**: `plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts` (modify), `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [x] In `lib/dashboard.ts` `DashboardItem` interface (`:31-49`), append two optional fields:
    ```ts
    parentNumber?: number | null;
    parentState?: string | null;
    ```
  - [x] In `toDashboardItems` (`tools/dashboard-tools.ts:168-211`), after the `blockedBy` mapping (`:196-199`), add:
    ```ts
    parentNumber: r.content.trackedInIssues?.nodes?.[0]?.number ?? null,
    parentState: r.content.trackedInIssues?.nodes?.[0]?.state ?? null,
    ```
  - [x] Existing `dashboard.test.ts` and `dashboard-group-by.test.ts` still pass — the change is additive; existing items just gain `null` fields.

#### Task 1.3: Create `src/lib/directions.ts` with ranker types and functions
- **files**: `plugin/ralph-hero/mcp-server/src/lib/directions.ts` (create), `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts` (read), `plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts` (read)
- **tdd**: true
- **complexity**: high
- **depends_on**: [1.2]
- **acceptance**:
  - [x] New file `src/lib/directions.ts` exists with no I/O, no async, no `any` escapes.
  - [x] Imports: `import type { DashboardItem } from "./dashboard.js";` and `import { LOCK_STATES, STATE_ORDER } from "./workflow-states.js";` only — no other imports.
  - [x] Exports: `OpenPR` interface, `Direction` interface (with discriminated `kind: "issue" | "pr" | "tree-continue" | "lock-stale"`), `RankConfig` interface, `DEFAULT_RANK_CONFIG` constant (`limit: 3, stuckThresholdHours: 48, lockStaleHours: 24, treeRecentDoneDays: 7, prStaleHours: 24`), `scoreIssue()`, `detectTreeContinue()`, `detectLockStale()`, `rankDirections()`, `buildReason()`.
  - [x] `Direction` shape: `{ rank: number; kind: ...; issue: {...} | null; pr: {...} | null; reason: string; tags: string[]; score: number }`.
  - [x] `RankConfig.now: Date` is required and injected by callers (no `Date.now()` inside the lib).
  - [x] `scoreIssue` returns winning kind in precedence order: `lock-stale` > `tree-continue` > `issue` (PR ranking happens in `rankDirections`, not here).
  - [x] `detectLockStale`: true when `workflowState in LOCK_STATES` and `(now - updatedAt) >= lockStaleHours`.
  - [x] `detectTreeContinue`: true when `parentNumber != null` AND (a) at least one sibling has `closedAt` within `treeRecentDoneDays` OR (b) item itself has `updatedAt` within window AND parent has any other open siblings AND parent is not closed.
  - [x] `rankDirections`: filters (actionable phase OR lock-stale; not blocked by open `blockedBy`), scores, sorts ascending, applies tree-continue promotion (slot 4 promoted to slot 2 if not already in slot 1), merges PRs (`prScore`), slices to `config.limit`, assigns `rank` 1..N, calls `buildReason`.
  - [x] `buildReason`: returns one-sentence prose, distinct shape per `kind`. No template strings — natural English.
  - [x] `grep -q "rankDirections" plugin/ralph-hero/mcp-server/src/lib/directions.ts`
  - [x] `cd plugin/ralph-hero/mcp-server && npm run build` — no errors.

#### Task 1.4: Write `directions.test.ts` covering all ranking criteria
- **files**: `plugin/ralph-hero/mcp-server/src/__tests__/directions.test.ts` (create), `plugin/ralph-hero/mcp-server/src/lib/directions.ts` (read)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [1.3]
- **acceptance**:
  - [x] New file `src/__tests__/directions.test.ts` exists.
  - [x] Uses `vitest` `describe`/`it` pattern; injects `now: Date` via `RankConfig` for time-stable tests; fabricates `DashboardItem[]` arrays directly (no GraphQL mock).
  - [x] All 13 cases present and passing:
    1. Empty input → `directions: []`.
    2. Pure priority sort (P0/P1/P2 in Plan in Review) → ordered P0, P1, P2.
    3. Phase tiebreaker (all P1 across Plan in Review / In Review / Research Needed) → ordered Plan in Review, In Review, Research Needed.
    4. Stale boost (P1 fresh vs P3 stale `updatedAt 60h ago`) → stale wins.
    5. Lock-stale surfacing — `In Progress` issue at 30h ago appears as `kind: "lock-stale"`; same at 10h ago not surfaced.
    6. Blocked-by dropped — issue with open `blockedBy[]` filtered out; if it's the only candidate, surfaced with `tags: ["blocked"]`.
    7. Tree-continue promotion — top-5 contains tree-continue at rank 4 → promoted to rank 2.
    8. Tree-continue criteria sub-cases:
       - (a) Sibling closed within `treeRecentDoneDays` → positive.
       - (b) Item itself updated within window, parent has other open siblings → positive.
       - (c) No parent → negative.
       - (d) Parent done (closed) → negative.
    9. PR ranking — `REVIEW_REQUIRED` PR ranks above any issue; `APPROVED` PR not surfaced; `isDraft: true` excluded.
    10. PR-issue link — PR with `headRefName: "feature/GH-0042"` produces a direction with `issue: null` and `reason` mentioning issue 42.
    11. Determinism — same input + same `now` → byte-identical output across two `rankDirections` calls (use `JSON.stringify` equality).
    12. Limit honored — `limit: 1` returns at most one direction even with many candidates.
    13. All criteria off — empty Priority, no stale, no tree, no PRs → falls back to phase-rank-only and still picks something if any actionable phase has items.
  - [x] `cd plugin/ralph-hero/mcp-server && npx vitest run src/__tests__/directions.test.ts` — all 13 cases pass.

### Phase Success Criteria

#### Automated Verification:
- [x] `cd plugin/ralph-hero/mcp-server && npm run build` — no errors
- [x] `cd plugin/ralph-hero/mcp-server && npm test` — all passing (existing tests + 13 new)
- [x] `cd plugin/ralph-hero/mcp-server && npx vitest run src/__tests__/directions.test.ts` — 13/13 pass
- [x] `grep -q "trackedInIssues" plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts`
- [x] `grep -q "rankDirections" plugin/ralph-hero/mcp-server/src/lib/directions.ts`
- [x] `dashboard.test.ts` and `dashboard-group-by.test.ts` still pass — additive query change

#### Manual Verification:
- [ ] Spot-check `directions.ts` reads as a single-purpose module (no leaked imports, no I/O, no `any`).
- [ ] Spot-check `buildReason` outputs in test fixtures read as natural English.

**Creates for next phase**: Exports `rankDirections`, `DEFAULT_RANK_CONFIG`, `OpenPR`, `RankConfig` from `src/lib/directions.js`; extends `DashboardItem` shape with `parentNumber?`/`parentState?`; ensures `DASHBOARD_ITEMS_QUERY` returns `trackedInIssues` data needed for tree-continue.

---

## Phase 2: GH-922 — MCP tool wrapper `ralph_hero__hello_directions`
- **depends_on**: [phase-1]

### Overview

Wrap the pure ranker as the MCP tool `ralph_hero__hello_directions`. Single tool call, fixed shape, deterministic. Reuses `paginateConnection` + `DASHBOARD_ITEMS_QUERY`. PRs are passed in as a parameter (no Octokit-in-MCP scope creep).

### Tasks

#### Task 2.1: Verify exports from `dashboard-tools.ts`
- **files**: `plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts` (modify if needed)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [x] `DASHBOARD_ITEMS_QUERY` is `export`ed (already verified at `:219`).
  - [x] `toDashboardItems` is `export`ed (already verified at `:168`).
  - [x] `RawDashboardItem` type is `export`ed (already verified at `:122`).
  - [x] If any are missing `export`, add it. If all present, no edit needed.
  - [x] `grep -q "^export const DASHBOARD_ITEMS_QUERY" plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts`
  - [x] `grep -q "^export function toDashboardItems" plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts`
  - [x] `grep -q "^export interface RawDashboardItem" plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts`

#### Task 2.2: Create `src/tools/directions-tools.ts` with `registerDirectionsTools`
- **files**: `plugin/ralph-hero/mcp-server/src/tools/directions-tools.ts` (create)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [2.1]
- **acceptance**:
  - [x] New file exists with `registerDirectionsTools(server, client, fieldCache)` exported.
  - [x] Imports (verified paths):
    - `ensureFieldCache` and `paginateConnection` from `../lib/helpers.js` — **note**: research shows `paginateConnection` actually lives in `../lib/pagination.js` and `ensureFieldCache` is currently a private helper in `dashboard-tools.ts`. Implementer should:
       - Either import `paginateConnection` from `../lib/pagination.js` (correct path; mirrors `dashboard-tools.ts:13`)
       - And export `ensureFieldCache` from `dashboard-tools.ts` (currently private at `:36`) and import it from there, OR copy the small helper into `directions-tools.ts` (10 lines).
    - `resolveProjectOwner`, `resolveProjectNumbers` from `../types.js` (verified at `types.ts:296,306`).
    - `toolError`, `toolSuccess` from `../types.js`.
    - `DASHBOARD_ITEMS_QUERY`, `toDashboardItems`, `RawDashboardItem` from `./dashboard-tools.js`.
    - `rankDirections`, `DEFAULT_RANK_CONFIG`, `OpenPR`, `RankConfig` from `../lib/directions.js`.
    - `McpServer` from `@modelcontextprotocol/sdk/server/mcp.js`, `z` from `zod`.
    - `GitHubClient` (type) from `../github-client.js`, `FieldOptionCache` (type) from `../lib/cache.js`.
  - [x] Tool name `ralph_hero__hello_directions` registered with the description from the parent plan.
  - [x] Zod schema with optional fields: `owner`, `projectNumbers`, `limit (default 3)`, `stuckThresholdHours (48)`, `lockStaleHours (24)`, `treeRecentDoneDays (7)`, `prStaleHours (24)`, `openPRs[]` (default `[]`) with `{ number, title, url, isDraft, reviewDecision (nullable), headRefName, createdAt }`.
  - [x] Behavior:
    - Resolve `owner` via arg or `resolveProjectOwner(client.config)`; error via `toolError("owner is required")` if missing.
    - Resolve project numbers via arg or `resolveProjectNumbers(client.config)`; error via `toolError("No project numbers configured.")` if empty.
    - For each project number: `await ensureFieldCache(client, fieldCache, owner, pn)`, then `await paginateConnection<RawDashboardItem>(...)` against `DASHBOARD_ITEMS_QUERY` with `{ projectId, first: 100 }`, `"node.items"` path, `{ maxItems: 500 }`.
    - Push `toDashboardItems(result.nodes, pn)` into a flat `allItems` array.
    - Build `RankConfig` from args ?? defaults plus injected `now: new Date()`.
    - Map `args.openPRs` to `OpenPR[]` with computed `ageHours = (now.getTime() - new Date(pr.createdAt).getTime()) / 3_600_000`.
    - Call `rankDirections(allItems, enrichedPRs, config)`.
    - Return `toolSuccess({ directions, fetchedAt: now.toISOString(), totalCandidates: allItems.length })`.
    - Wrap in `try/catch`; on error return `toolError("Failed to compute hello directions: ${message}")`.
  - [x] `grep -q "ralph_hero__hello_directions" plugin/ralph-hero/mcp-server/src/tools/directions-tools.ts`
  - [x] `cd plugin/ralph-hero/mcp-server && npm run build` — no errors.

#### Task 2.3: Register `registerDirectionsTools` in `index.ts`
- **files**: `plugin/ralph-hero/mcp-server/src/index.ts` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [2.2]
- **acceptance**:
  - [x] Add `import { registerDirectionsTools } from "./tools/directions-tools.js";` near the existing `registerDashboardTools` import (currently at `index.ts:24`).
  - [x] Add `registerDirectionsTools(server, client, fieldCache);` adjacent to the existing `registerDashboardTools(server, client, fieldCache);` call (currently at `index.ts:460`).
  - [x] `grep -q "registerDirectionsTools" plugin/ralph-hero/mcp-server/src/index.ts`
  - [x] `cd plugin/ralph-hero/mcp-server && npm run build` — no errors.

#### Task 2.4: Write `directions-tools.test.ts` integration tests
- **files**: `plugin/ralph-hero/mcp-server/src/__tests__/directions-tools.test.ts` (create), `plugin/ralph-hero/mcp-server/src/__tests__/auto-advance-parent.test.ts` (read for pattern), `plugin/ralph-hero/mcp-server/src/__tests__/repo-inference.test.ts` (read for pattern)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [2.3]
- **acceptance**:
  - [x] New file uses the `vi.fn()`-based `mockClient` literal pattern from `auto-advance-parent.test.ts:81-110` and `repo-inference.test.ts:30-41`. Stubs all `GitHubClient` methods: `query`, `projectQuery`, `projectMutate`, `mutate`, `getCache`, `getAuthenticatedUser`. Does **not** mirror `dashboard.test.ts` (pure-function-only).
  - [x] All 6 cases present and passing:
    1. End-to-end happy path (mock returns 5 issues across phases) → tool returns top 3 with correct shape (`directions` array, `fetchedAt` ISO string, `totalCandidates: 5`).
    2. Empty board (mock returns 0 items) → `directions: []`, no error.
    3. Multi-project (mock returns items across 2 project numbers, `RALPH_GH_PROJECT_NUMBERS` style) → tool fetches both projects and merges.
    4. Field cache miss (`ensureFieldCache` throws) → returns `toolError`.
    5. PR injection — `openPRs: [{ REVIEW_REQUIRED, age 30h, isDraft: false }]` → tool returns PR as direction 1.
    6. Defaults applied — call with no config args; verify `config.limit=3, stuckThresholdHours=48, lockStaleHours=24, treeRecentDoneDays=7, prStaleHours=24` actually used (e.g., assert via boundary case behavior or by exposing `RankConfig` if the implementation calls a spy).
  - [x] `cd plugin/ralph-hero/mcp-server && npx vitest run src/__tests__/directions-tools.test.ts` — 6/6 pass.

### Phase Success Criteria

#### Automated Verification:
- [x] `cd plugin/ralph-hero/mcp-server && npm run build` — no errors
- [x] `cd plugin/ralph-hero/mcp-server && npm test` — all passing (existing + 13 + 6)
- [x] `cd plugin/ralph-hero/mcp-server && npx vitest run src/__tests__/directions-tools.test.ts` — 6/6 pass
- [x] `grep -q "registerDirectionsTools" plugin/ralph-hero/mcp-server/src/index.ts`
- [x] `grep -q "ralph_hero__hello_directions" plugin/ralph-hero/mcp-server/src/tools/directions-tools.ts`

#### Manual Verification:
- [ ] After build, invoke `ralph_hero__hello_directions` directly in a fresh Claude Code session. Response is well under 50 lines and matches expected shape.
- [ ] Two consecutive invocations return identical `directions[]` (after stripping `fetchedAt`) — proves determinism.

**Creates for next phase**: Registered MCP tool `ralph_hero__hello_directions` available for the skill to call.

---

## Phase 3: GH-924 — Refactor `SKILL.md` to call `hello_directions`
- **depends_on**: [phase-2]

### Overview

Replace the `pipeline_dashboard` call with `ralph_hero__hello_directions` in the hello skill. The skill becomes a thin presenter over a fixed-shape, deterministic payload. PRs are still fetched via `gh pr list` and passed as a parameter so all ranking happens server-side. This is the user-visible change.

### Tasks

#### Task 3.1: Update `SKILL.md` Step 1 to Wave A + Wave B fetch
- **files**: `plugin/ralph-hero/skills/hello/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] Step 1 (`SKILL.md:27-46`) restructured into two waves:
    - **Wave A (parallel)**: Memory read + `gh pr list --state open --json number,title,url,isDraft,reviewDecision,headRefName,createdAt --limit 10 2>/dev/null || echo '[]'`.
    - **Wave B (after Wave A)**: Call `ralph_hero__hello_directions` with `limit: 3` and parsed PR array as `openPRs`.
  - [ ] Fallback rules documented:
    - Memory read fails → continue without context.
    - `gh pr list` fails → call `hello_directions` with `openPRs: []`.
    - `hello_directions` fails → report error and stop.
  - [ ] `grep -q "Wave A" plugin/ralph-hero/skills/hello/SKILL.md`
  - [ ] `grep -q "Wave B" plugin/ralph-hero/skills/hello/SKILL.md`
  - [ ] `grep -q "ralph_hero__hello_directions" plugin/ralph-hero/skills/hello/SKILL.md`

#### Task 3.2: Update Step 2 orient and Step 3 directions
- **files**: `plugin/ralph-hero/skills/hello/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [3.1]
- **acceptance**:
  - [ ] Step 2 references `totalCandidates` instead of `health.warnings[]` and `phases[]` for the "what changed" line. Tone rules unchanged.
  - [ ] Step 3 instructs: "Render each entry from `directions[]` as a 2-3-sentence paragraph using its `reason` field. Do not re-order, do not skip entries, do not invent new ones. If `directions[]` is empty, end with *'Nothing urgent jumping out — what are you thinking about today?'* and stop."
  - [ ] No references to `health.warnings[]` or `phases[]` remain in the skill body: `! grep -q "health.warnings" plugin/ralph-hero/skills/hello/SKILL.md` and `! grep -qE "phases\[\]" plugin/ralph-hero/skills/hello/SKILL.md`.

#### Task 3.3: Update Step 4 picker (1:1 from `directions[]`)
- **files**: `plugin/ralph-hero/skills/hello/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [3.2]
- **acceptance**:
  - [ ] Step 4 picker maps `directions[]` 1:1 to `AskUserQuestion` options. Each option's `label` is `[Action] [Target]` (e.g., "Review plan #55", "Merge PR #640", "Continue tree #42") and `description` is `direction.reason`.
  - [ ] Empty-directions case handled: when `directions[]` is empty, Step 4 is **skipped entirely** — Step 3 already exits with the *"Nothing urgent jumping out…"* line and stops. No `AskUserQuestion`, no placeholder.

#### Task 3.4: Update Step 5 dispatch table to use `direction.kind`
- **files**: `plugin/ralph-hero/skills/hello/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [3.3]
- **acceptance**:
  - [ ] Step 5 dispatch table (currently `SKILL.md:118-129`) references `direction.kind` instead of "Direction Type" prose.
  - [ ] Mapping per parent plan:
    | `kind` | Agent |
    |---|---|
    | `issue` (workflowState=`Plan in Review`) | `review-agent` |
    | `issue` (workflowState=`Ready for Plan`) | `plan-agent` |
    | `issue` (workflowState=`Research Needed`) | `research-agent` |
    | `pr` | `merge-agent` |
    | `tree-continue` | `triage-agent` |
    | `lock-stale` | `triage-agent` |

#### Task 3.5: Update `allowed-tools` frontmatter
- **files**: `plugin/ralph-hero/skills/hello/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] In `allowed-tools` frontmatter, replace `mcp__plugin_ralph-hero_ralph-github__ralph_hero__pipeline_dashboard` with `mcp__plugin_ralph-hero_ralph-github__ralph_hero__hello_directions`.
  - [ ] `grep -q "mcp__plugin_ralph-hero_ralph-github__ralph_hero__hello_directions" plugin/ralph-hero/skills/hello/SKILL.md`
  - [ ] `! grep -q "mcp__plugin_ralph-hero_ralph-github__ralph_hero__pipeline_dashboard" plugin/ralph-hero/skills/hello/SKILL.md`

#### Task 3.6: Update Constraints section wording
- **files**: `plugin/ralph-hero/skills/hello/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [3.1]
- **acceptance**:
  - [ ] Constraints line updated: "Do not re-fetch data after the initial Wave A + Wave B fetch in Step 1." (was "after the initial parallel fetch").

#### Task 3.7: Verify GH-0838 output-budget regression guard
- **files**: `plugin/ralph-hero/skills/hello/SKILL.md` (read)
- **tdd**: false
- **complexity**: low
- **depends_on**: [3.1, 3.2, 3.3, 3.4, 3.5, 3.6]
- **acceptance**:
  - [ ] `grep -q "Output budget (hard limit)" plugin/ralph-hero/skills/hello/SKILL.md` — preserved.
  - [ ] `grep -q "Do not relay the dispatched agent" plugin/ralph-hero/skills/hello/SKILL.md` — preserved.
  - [ ] Skill file still parses as valid Markdown with intact YAML frontmatter (e.g., `head -20` shows valid frontmatter block).

### Phase Success Criteria

#### Automated Verification:
- [ ] `grep -q "ralph_hero__hello_directions" plugin/ralph-hero/skills/hello/SKILL.md`
- [ ] `! grep -q "mcp__plugin_ralph-hero_ralph-github__ralph_hero__pipeline_dashboard" plugin/ralph-hero/skills/hello/SKILL.md`
- [ ] `grep -q "Wave A" plugin/ralph-hero/skills/hello/SKILL.md` and `grep -q "Wave B" plugin/ralph-hero/skills/hello/SKILL.md`
- [ ] `grep -q "Output budget (hard limit)" plugin/ralph-hero/skills/hello/SKILL.md && grep -q "Do not relay the dispatched agent" plugin/ralph-hero/skills/hello/SKILL.md`
- [ ] `cd plugin/ralph-hero/mcp-server && npm run build` — no errors (regression guard)
- [ ] `cd plugin/ralph-hero/mcp-server && npm test` — all passing (regression guard)

#### Manual Verification:
- [ ] `/ralph-hero:hello` in a fresh session produces a ≤40-line briefing.
- [ ] Two consecutive runs return the identical top direction (determinism).
- [ ] Tree-continue surfaces in slot 2 when criteria match (Priority unset + recent sibling done).
- [ ] Lock-stale surfaces only when a lock-state issue has `updatedAt` >24h.
- [ ] Post-dispatch summary stays ≤3 lines and does not echo agent return (GH-838 budget guard).
- [ ] Briefing reads conversationally — not as a JSON dump or table.

---

## Integration Testing

- [ ] After Phase 3, run `/ralph-hero:hello` end-to-end against the live ralph-hero board. Briefing matches algorithm prediction; ≤40 lines.
- [ ] Run twice in succession — top direction identical (determinism).
- [ ] (Optional) Snapshot the directions JSON via direct MCP tool call for record-keeping.

## References

- Parent plan: [thoughts/shared/plans/2026-04-29-GH-0918-hello-deterministic-directions.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-04-29-GH-0918-hello-deterministic-directions.md)
- Issues: [#921](https://github.com/cdubiel08/ralph-hero/issues/921), [#922](https://github.com/cdubiel08/ralph-hero/issues/922), [#924](https://github.com/cdubiel08/ralph-hero/issues/924), parent [#918](https://github.com/cdubiel08/ralph-hero/issues/918)
- Related research: [thoughts/shared/research/2026-03-03-GH-0480-hello-session-briefing.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-03-GH-0480-hello-session-briefing.md)
- Output-budget plan: [thoughts/shared/plans/2026-04-22-GH-0838-refine-hello-skill-output-budget.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-04-22-GH-0838-refine-hello-skill-output-budget.md)
- Skill: [plugin/ralph-hero/skills/hello/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/hello/SKILL.md)
- Dashboard tool: [plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts)
- Workflow states: [plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts)
- Mock client pattern: [plugin/ralph-hero/mcp-server/src/__tests__/auto-advance-parent.test.ts:81-110](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/__tests__/auto-advance-parent.test.ts#L81-L110)
