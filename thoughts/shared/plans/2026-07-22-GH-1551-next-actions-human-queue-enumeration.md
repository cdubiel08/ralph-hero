---
date: 2026-07-22
status: draft
type: plan
tags: [mcp-server, next-actions, directions, enumeration, ways-of-working]
github_issue: 1551
github_issues: [1551]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1551
primary_issue: 1551
estimate: S
---

# next_actions human-queue enumeration — exhaustive, tested, one canonical caller

## Prior Work

- builds_on:: [[2026-07-19-GH-1550-ways-of-working-action-surfaces]] — the research this feature implements (gap table: "what's happening" requires reading a 60KB dashboard; enumeration is the fix for the daily-brief job).
- builds_on:: [[2026-07-19-GH-1550-epic-ways-of-working-surfaces]] — plan-of-plans, Feature A. Resolved epic-level decisions this plan inherits verbatim: enumeration home is `next_actions` (not a new `decision_queue` tool); brief scope is the full human queue, not just design decisions; A → C is load-bearing ("the brief renders exactly what enumeration returns; no second scan, no skill-side re-ranking").

## Overview

`ralph_hero__next_actions` already runs a full, unsliced board scan internally (`paginateConnection(..., { scanUntilExhausted: true })`) and computes a fully ranked candidate list before truncating it to `limit` (default 3) for the picker/autopilot use case. This feature adds a second access mode — `enumerate: "human-queue"` — that returns that same ranked list *without* the truncation, so a future caller (`catch-up --mode brief`, GH-1553) can render the entire human queue (plan-decision holds, human-needed unblocks, stale locks, stale PRs, and any other actionable issue) in one sitting instead of drip-feeding it 3 items at a time.

The change is additive at both the lib layer (`mcp-server/src/lib/directions.ts`) and the tool boundary (`mcp-server/src/tools/directions-tools.ts`): the existing ranked-top-N path is refactored to share its candidate-building and Direction-mapping logic with a new `enumerateDirections()` entry point, rather than duplicated. One gap surfaced while reading the code that the issue body didn't fully specify: the "source comment pointer" the contract requires does not exist in today's shape — the comments GraphQL query never selects `url`, and `UnblockSignal`/`DecisionSignal` never carry one. This plan adds it (a small, load-bearing addition — without it, a human-queue enumeration presenting a plan-decision or unblock item has no direct link to click) and treats it as in-scope, not follow-on work.

## Current State Analysis

The full-board scan and ranking pipeline already exists and is already comprehensive — nothing about candidate *discovery* needs to change. The only thing standing between today's code and enumeration is the truncation at the very end of `rankDirections`, and the missing comment-pointer field on the two comment-anchored kinds.

### Key Discoveries

- Tool registration: `registerDirectionsTools()` at `mcp-server/src/tools/directions-tools.ts:573-645`; factory `makeRunDirections(client, fieldCache)` at `:452-567`. Input schema at `:584-639` (owner, projectNumbers, limit default 3, audience default "human", stuckThresholdHours, lockStaleHours, treeRecentDoneDays, prStaleHours). Handler at `:641-643` forces `audience: args.audience ?? "human"`.
- Full-board scan is already exhaustive: `paginateConnection(..., { scanUntilExhausted: true })` at `:484-490`, invoked per configured project number in a loop (`:474-493`).
- Signal maps are already comprehensive (no pre-slice truncation): `buildUnblockSignalMap` (`:254-283`, Human Needed candidates) and `buildDecisionSignalMap` (`:290-317`, Plan in Review candidates), both invoked in `runDirections` at `:498-507` before `rankDirections` is called.
- The slice is the ONLY truncation point: `mcp-server/src/lib/directions.ts:1069` — `const sliced = merged.slice(0, Math.max(0, config.limit));` inside `rankDirections()` (`:930-1173`). Everything before that line (`merged`, built across steps 1-5: phase filter + decision/unblock exclusion at `:939-962`, agent-Backlog fallback at `:971-991`, blocked-item drop-unless-empty at `:993-1004`, PR scoring + merge at `:1006-1027`, sort at `:1029-1043`, tree-continue promotion at `:1045-1066`) is the full ranked list — the reuse target for enumeration.
- Step 6 (`:1069-1129`) does the Entry → `Direction` mapping: computes `tiedCount` over the (already sliced) list (`:1074-1081`), maps `ScoredCandidate`/`PRScored` rows to `Direction` objects via `buildReason`, and marks `directions[0].recommended = true` at `:1134-1136`. This mapping logic must be shared (not duplicated) between the sliced default path and the new unsliced enumeration path.
- Step 7 (`:1150-1170`): human-audience aggregate `kind: "triage"` fallback fires when `merged.length === 0` (checked pre-slice, so a small `limit` can't fake an empty board) and at least one board item has a null `workflowState`. This already reads `merged`, not `sliced` — it requires no change to keep working identically for enumeration.
- `Direction` interface (`directions.ts:130-176`): `rank`, `recommended`, `kind` ("issue" | "pr" | "tree-continue" | "lock-stale" | "human-needed-unblock" | "plan-decision" | "triage"), `issue` (number/title/workflowState/priority/estimate — no `updatedAt`), `pr` (number/title/url/ageHours/reviewDecision), `signals` (`DirectionSignals`, `:68-128`), `reason` (@deprecated), `tags` (@deprecated), `score`.
- **Gap: no source-comment pointer today.** `IssueCommentNode` (`directions-tools.ts:72-75`) is `{ body, createdAt }` only — the GraphQL query at `:100-108` never selects `url`. `UnblockSignal` (`directions.ts:199-202`) and `DecisionSignal` (`:223-226`) carry only age/count fields. `scoreIssue` (`:554-706`) attaches `decisionRequestAgeDays`/`decisionCount` (`:594-596`) and `unblockRequestAgeDays`/`questionCount` (`:621-623`) to `DirectionSignals` but nothing pointing at the comment itself. This must be added for the "source comment pointer" contract requirement to mean anything concrete.
- `audience: "agent"` excludes plan-decision items (`directions.ts:955`, `hasDecisionSignal && config.audience === "agent"` → `continue`); `PLAN_DECISION_BOOST = -150` at `:325` (scores sort ascending — lower is higher priority, same tier as `HUMAN_NEEDED_UNBLOCK_BOOST = -150` at `:316`).
- Tests: `mcp-server/src/__tests__/directions.test.ts` — pure lib, fixtures `makeItem`/`makePR`/`makeConfig` (`:31-69`), injected `NOW`; "limit honored" describe at `:712-730`; "plan-decision directions" describe at `:1244-1366`; "rankDirections — human-needed-unblock" describe at `:1120-1243`. `mcp-server/src/__tests__/directions-tools.test.ts` — tool boundary via `createMockClient`/`getTool`/`buildArgs`/`parsePayload` harness (`:222-334`); `describe("ralph_hero__next_actions")` at `:338-473`; `describe("extractUnblockSignal")` at `:480-577`; `describe("extractDecisionSignal")` at `:578-675`; comment-query mocking in `createMockClient` today only routes `isFieldCacheQuery`/`isDashboardItemsQuery`/`isOpenPRsSearchQuery` (`:187-197`) — any comments query falls through to the generic `query` mock which throws, caught by `fetchIssueCommentsForUnblock`'s try/catch (`:112-114`) and silently returns `[]`. No existing test exercises the full pipeline (tool → comment fetch → decision/unblock signal → ranked output) end-to-end; Phase 2 adds the missing mock route.
- Build/test commands: `cd mcp-server && npm run build`, `npm test`, `npx vitest run src/__tests__/directions.test.ts`, `npx vitest run src/__tests__/directions-tools.test.ts`.

## Desired End State

1. `ralph_hero__next_actions` accepts an optional `enumerate: "human-queue"` param. When set, the tool returns every direction that would ever appear across any `limit` value for `audience: "human"` — the full ranked `merged` list, unsliced — instead of the top-N.
2. The default call shape (no `enumerate`) is byte-identical to today for existing fields: same ranking, same slicing, same existing field values, same `recommended` placement — with one documented additive exception: `plan-decision` / `human-needed-unblock` directions on the default path additionally carry `signals.sourceCommentUrl` (per the Byte-compat scope Design Decision). Verified by a regression test, not just "tests still pass."
3. Every enumerated direction whose `kind` is `"plan-decision"` or `"human-needed-unblock"` carries `signals.sourceCommentUrl` pointing at the specific `## Decision Request` / `## Unblock Request` GitHub comment it was derived from. Other kinds do not carry this field (they have no anchoring comment).
4. `rankDirections()` and `enumerateDirections()` share one candidate-building implementation — no duplicated phase-filter / scoring / sort / tree-continue-promotion logic between the sliced and unsliced paths.
5. The tool description names `catch-up --mode brief` (#1553, future) as the one canonical caller of `enumerate: "human-queue"` — documented so no second caller invents its own enumeration/re-ranking logic later (epic constraint: "no second scan, no skill-side re-ranking").
6. `rank` numbering and the `recommended` flag on an enumerated response span the FULL list (rank 1..N over every returned item, `recommended` true only on rank 1) — identical semantics to the sliced path, just not truncated.

### Verification

- `cd mcp-server && npm run build` succeeds with no new TypeScript errors.
- `npx vitest run src/__tests__/directions.test.ts` and `npx vitest run src/__tests__/directions-tools.test.ts` pass, including new enumeration + byte-compat regression tests.
- `npm test` (full suite) passes — confirms no cross-file regression (e.g. other tools importing `directions.ts` exports).
- Manual: invoke `ralph_hero__next_actions` with `enumerate: "human-queue"` against a project with at least one Plan in Review item holding an unanswered `## Decision Request` comment; confirm the response includes that item with a `sourceCommentUrl` that resolves to the actual comment when opened in a browser.

## What We're NOT Doing

- Not building `catch-up --mode brief` (GH-1553) — that's a separate feature/PR, downstream of this one.
- Not adding a universal "age" field to every direction kind. Age/staleness signals already exist for every kind where staleness is actually decision-relevant (`staleDays` for stale/lock-stale issues, `prAgeDays` for PRs, `unblockRequestAgeDays`/`decisionRequestAgeDays` for the two held-on-comment kinds). A fresh `Ready for Plan` issue with no stale signal does not get a manufactured age — that would require plumbing `updatedAt` through `toDirectionIssue`, which is out of scope for an S-sized enumeration feature and not something the issue body actually asks for beyond "age" meaning "how long has this been waiting."
- Not changing `audience: "agent"` behavior at all — enumeration is a human-queue concept only; the tool forces `audience: "human"` server-side whenever `enumerate` is set, ignoring any conflicting `audience` argument.
- Not changing the `limit` param's existing semantics (including its `limit: 0` early-exit interaction with the aggregate triage fallback) for the default path — `enumerate` is a wholly separate access mode, not a repurposing of `limit`.
- Not filtering enumeration down to a subset of kinds (e.g., "only plan-decision + human-needed-unblock"). See Design Decisions below — the epic already decided the brief scope is the full human queue, and `merged` (pre-slice) is already the actionable-only candidate set (it already excludes non-actionable phases, closed items, and — for `audience: "agent"` only — held decisions), so no additional filtering step is needed or wanted.
- Not adding a new MCP tool (`decision_queue` or similar) — the epic already decided enumeration extends `next_actions`.

## Design Decisions & Open Ambiguities

- **Param shape** — options: `enumerate: "human-queue"` enum param (per issue body); `limit: 0` sentinel repurposed to mean "return everything." **Decided: add `enumerate: z.enum(["human-queue"]).optional()`.** `limit: 0` already has an established, tested meaning today (skip the aggregate triage fallback / return literally nothing — see `directions.ts:1150`, "never fires when the caller asked for zero directions"); repurposing it to mean the opposite (everything) would silently invert existing, relied-upon behavior for any caller passing `limit: 0` today. A dedicated param is unambiguous and matches the issue body's own suggestion.
- **What "every human-actionable item" means concretely** — options: (a) every kind already present in the pre-slice `merged` ranked list (issue, pr, tree-continue, lock-stale, human-needed-unblock, plan-decision); (b) only the "held on a human" kinds (plan-decision, human-needed-unblock, lock-stale, pr). **Decided: (a), the full `merged` list, no further kind-filtering.** `merged` is already actionable-only — it only contains items that passed the phase filter (`ACTIONABLE_PHASES`: Plan in Review, In Review, Ready for Plan, Research Needed), lock-stale items, unblock-signaled items, and scored PRs; non-actionable board noise (Backlog, In Progress, Done, Canceled) is never in `merged` to begin with. The epic already resolved "Brief scope" as "the full human queue... not just design decisions" (`2026-07-19-GH-1550-epic-ways-of-working-surfaces.md`, Design Decisions), which rules out option (b). Filtering `merged` down further would also violate the "reusing the existing comprehensive signal scans" requirement in the issue body — the scan output IS the human queue.
- **`sourceCommentUrl` scope** — options: attach to every direction kind (would require a synthetic/null value for kinds with no anchoring comment); attach only to the two comment-anchored kinds. **Decided: only `plan-decision` and `human-needed-unblock` carry `signals.sourceCommentUrl`.** Only those two kinds are literally derived from a specific GitHub comment; a `lock-stale` or plain `issue` direction has no comment to point at, and forcing a `null` placeholder onto every kind adds noise without adding information the issue body actually asked for ("the source comment pointer" — singular, implying per-kind-relevant, not universal).
- **Rank numbering across the unsliced list** — options: re-derive `rank` per returned item across the full list (1..N); keep `rank` values as if the item were in a top-N call at some hypothetical `limit`. **Decided: rank spans the full returned list, 1..N, `recommended` only on rank 1.** Matches "ranked order preserved" from the issue body and keeps `rank` meaningful as a simple ordinal a renderer can use directly, without needing to know what `limit` "would have been."
- **Byte-compat scope for the additive `sourceCommentUrl` field** — options: treat any new field on any `Direction` as a compatibility break requiring a version bump / opt-in; treat purely additive optional fields as compatible (existing precedent: `DirectionSignals` has grown several optional fields over time — `tiedAtScore`, `estimateWeight`, `decisionRequestAgeDays`, etc. — without being called compatibility breaks). **Decided: additive-only.** The "byte-compatible" epic constraint is about the default (no-`enumerate`) call producing the identical ranking, slicing, and field values it produces today for existing fields — not about freezing the schema against ever adding a new optional field. The regression test in Phase 2 asserts existing fields/ordering are unchanged; it does not assert the total field set is frozen.

None — no open design decisions.

## Implementation Approach

Two phases. Phase 1 is pure-library work in `mcp-server/src/lib/directions.ts`: add the `sourceCommentUrl` field to the two signal types and `DirectionSignals`, refactor `rankDirections` so its candidate-building (steps 1-5) and Direction-mapping (step 6, plus the step-7 fallback) are shared helper functions, and add the new exported `enumerateDirections()` entry point that calls those helpers without the slice. This phase is fully unit-testable with fabricated `DashboardItem[]`/`OpenPR[]` — no GraphQL involved. Phase 2 is tool-boundary work in `mcp-server/src/tools/directions-tools.ts`: extend the comments GraphQL query to select `url`, thread it through `extractUnblockSignal`/`extractDecisionSignal`, add the `enumerate` schema param + description update, and wire the handler to call `enumerateDirections()` when `enumerate === "human-queue"` (forcing `audience: "human"`). Phase 2 also extends the `createMockClient` test harness with a comments-query route so the new end-to-end tests aren't limited to catching the mock's throw-and-swallow path.

File ownership: Phase 1 owns `mcp-server/src/lib/directions.ts` and `mcp-server/src/__tests__/directions.test.ts`. Phase 2 owns `mcp-server/src/tools/directions-tools.ts` and `mcp-server/src/__tests__/directions-tools.test.ts`. No file is touched by both phases.

## Phase 1: Lib-level enumeration + source-comment signal plumbing

depends_on: null

### Overview

Add `sourceCommentUrl` to the signal types, refactor `rankDirections` into shared helpers, and export `enumerateDirections()` — the full ranked list, unsliced, human-audience semantics, sharing 100% of its candidate-building and mapping logic with the existing sliced path.

### Changes Required

#### 1. Signal type additions

**File**: `mcp-server/src/lib/directions.ts`
**Changes**:
- Add `sourceCommentUrl: string;` to `UnblockSignal` (`:199-202`) and `DecisionSignal` (`:223-226`).
- Add `sourceCommentUrl?: string;` to `DirectionSignals` (`:68-128`), documented as "For `kind: 'plan-decision'` / `kind: 'human-needed-unblock'` only: URL of the source `## Decision Request` / `## Unblock Request` comment."
- In `scoreIssue` (`:554-706`), when building signals for the `plan-decision` branch (`:592-596`), add `signals.sourceCommentUrl = decisionSignal.sourceCommentUrl;`. Same for the `human-needed-unblock` branch (`:619-623`): `signals.sourceCommentUrl = unblockSignal.sourceCommentUrl;`.

#### 2. Refactor `rankDirections` into shared helpers

**File**: `mcp-server/src/lib/directions.ts`
**Changes**:
- Extract steps 1-5 of `rankDirections` (`:939-1066`: scoring/filtering, agent-Backlog fallback, blocked-item drop-unless-empty, PR scoring, merge, sort, tree-continue promotion) into an internal (non-exported, or exported for test convenience — implementer's call, no test currently needs direct access) helper, e.g. `buildMergedEntries(items, openPRs, config): Entry[]`, returning the pre-slice `merged` array exactly as it exists today at line 1066.
- Extract step 6 (the Entry → `Direction` mapping including tie-count computation and `recommended` assignment, `:1069-1136`) into a shared helper, e.g. `mapMergedToDirections(merged: Entry[], config: RankConfig): Direction[]`, parameterized on whatever slice of `merged` is passed in (the tie-count and recommended-flag logic must operate correctly on both a sliced and an unsliced array — verify by re-reading `:1074-1136` before extracting, since `tiedCount` and `recommended` are computed relative to `sliced[0]`, which generalizes fine to any array's `[0]`).
- Extract step 7 (the human aggregate triage fallback, `:1150-1170`) into a shared helper, e.g. `appendTriageFallbackIfNeeded(directions: Direction[], merged: Entry[], items: DashboardItem[], config: RankConfig): void` (or return a new array) — it already reads `merged` (pre-slice), so it must be invoked identically for both the sliced and unsliced (enumeration) callers.
- `rankDirections()` becomes: `buildMergedEntries` → `merged.slice(0, Math.max(0, config.limit))` → `mapMergedToDirections` → `appendTriageFallbackIfNeeded`. Behaviorally identical to today — this is a pure refactor, verified by the regression test below.
- Add new exported function `enumerateDirections(items: DashboardItem[], openPRs: OpenPR[], config: RankConfig): Direction[]`: `buildMergedEntries` → (no slice — use the full `merged` array) → `mapMergedToDirections` → `appendTriageFallbackIfNeeded`.

### Success Criteria

#### Automated Verification

- [x] `cd mcp-server && npm run build` exits 0 with no new TypeScript errors.
- [x] `npx vitest run src/__tests__/directions.test.ts` passes, including:
  - [x] New `describe("enumerateDirections — human-queue")` block asserting: the full unsliced list is returned for a fixture set spanning at least `plan-decision`, `human-needed-unblock`, `lock-stale`, `tree-continue`, `pr`, and plain `issue` kinds; ranked order matches manual expectation; `recommended` is `true` only on the first entry; `rank` values are sequential 1..N across the full list.
  - [x] New regression test asserting prefix identity: for a fixed input + `config`, `enumerateDirections(items, prs, config).slice(0, config.limit)` deep-equals `rankDirections(items, prs, config)` on every field EXCEPT `signals.tiedAtScore`, which is list-relative by design (`rankDirections` computes the tie count over the sliced list at `directions.ts:1074-1081`; `enumerateDirections` computes it over the full list — a top-score tie crossing the `limit` boundary legitimately yields different values). Either exclude `tiedAtScore` from the deep-equality or use a fixture with no top-score tie crossing the `limit` boundary.
  - [x] Dedicated tie-semantics test: with a fixture whose top-score tie extends past `config.limit`, assert enumerate's `tiedAtScore` reflects the FULL tie count while the sliced path's reflects only the sliced count — pinning the intended divergence so an implementer does not "fix" a red prefix test by altering default-path tie semantics.
  - [x] `sourceCommentUrl` is present and correct on `plan-decision` and `human-needed-unblock` directions (test fixtures supply `UnblockSignal`/`DecisionSignal` objects with a `sourceCommentUrl`), and ABSENT (`undefined`, no key or `signals.sourceCommentUrl === undefined`) on every other kind.
  - [x] Existing "plan-decision directions" (`:1244-1366`) and "rankDirections — human-needed-unblock" (`:1120-1243`) describe blocks updated to supply `sourceCommentUrl` in their `DecisionSignal`/`UnblockSignal` fixtures and assert it round-trips onto `signals.sourceCommentUrl`.
  - [x] All pre-existing tests in this file continue to pass unmodified in behavior (only fixture additions for the two updated describe blocks above; no other test's expected values change).

#### Manual Verification

- [ ] Read the diff of `rankDirections` before/after the refactor side-by-side and confirm no logic changed — only extraction into named helpers.

## Phase 2: Tool-boundary wiring — `enumerate` param, comment URL, description

depends_on: [phase-1]

### Overview

Thread `sourceCommentUrl` from the GitHub comments GraphQL query through `extractUnblockSignal`/`extractDecisionSignal`, add the `enumerate: "human-queue"` schema param to `ralph_hero__next_actions`, wire the handler to call `enumerateDirections()` when set (forcing `audience: "human"`), and update the tool description to name `catch-up --mode brief` as the canonical caller.

### Changes Required

#### 1. Comment URL plumbing

**File**: `mcp-server/src/tools/directions-tools.ts`
**Changes**:
- Add `url: string;` to `IssueCommentNode` (`:72-75`).
- Add `url` to the GraphQL selection set in `fetchIssueCommentsForUnblock` (`:100-108`): `comments(last: 20) { nodes { body createdAt url } }`.
- `extractUnblockSignal` (`:131-181`): when returning a non-null `UnblockSignal`, populate `sourceCommentUrl: latestUnblock.url`.
- `extractDecisionSignal` (`:199-234`): when returning a non-null `DecisionSignal`, populate `sourceCommentUrl: latestRequest.url`.

#### 2. `enumerate` param + handler wiring

**File**: `mcp-server/src/tools/directions-tools.ts`
**Changes**:
- Add `enumerate?: "human-queue";` to `RunDirectionsArgs` (`:436-445`).
- Add `enumerate: z.enum(["human-queue"]).optional().describe(...)` to the schema in `registerDirectionsTools` (`:584-639`), describing: ignores `limit`; forces `audience: "human"`; returns the full ranked human queue instead of top-N; the canonical caller is `catch-up --mode brief` (#1553, future).
- In `makeRunDirections`'s returned function (`:453-566`): after computing `config` (`:510-524`) and `enrichedPRs` (`:534-549`), branch on `args.enumerate === "human-queue"` — if set, force `config.audience = "human"` (regardless of `args.audience`) and call `enumerateDirections(allItems, enrichedPRs, config)` instead of `rankDirections(allItems, enrichedPRs, config)` (`:551`). Response envelope (`:553-561`) is unchanged: `{ directions, fetchedAt, boardItems }`.

#### 3. Tool description update

**File**: `mcp-server/src/tools/directions-tools.ts`
**Changes**: Extend the `ralph_hero__next_actions` description string (`:582`) with a paragraph documenting `enumerate: "human-queue"`: what it returns (every ranked human-queue direction, unsliced), that it ignores `limit` and forces human audience, and that `catch-up --mode brief` (#1553, future) is the one canonical caller — other callers should use the default ranked-top-N path, not invent their own enumeration or re-ranking.

#### 4. Test harness extension

**File**: `mcp-server/src/__tests__/directions-tools.test.ts`
**Changes**:
- Add a `commentsByIssue` bucket to `MockClientOptions` (`:209-220`) and an `isIssueCommentsQuery(q)` detector (alongside `:187-197`) so `createMockClient`'s `query` mock (`:263-276`) can route the comments query to per-issue fixtures instead of falling through to the throw-and-swallow path.
- New tests in `describe("ralph_hero__next_actions")` (`:338-473`):
  - [x] Calling the tool with `enumerate: "human-queue"` and a small `limit` (e.g. `1`) against a fixture set with 4+ actionable items returns all 4+ directions, not just 1 — proves `limit` is ignored in enumerate mode.
  - [x] A Plan in Review fixture with a mocked `## Decision Request` comment (via the new `commentsByIssue` bucket) surfaces `kind: "plan-decision"` with `signals.sourceCommentUrl` matching the mocked comment's `url`, when called with `enumerate: "human-queue"`.
  - [x] Calling with `enumerate: "human-queue", audience: "agent"` still returns human-audience semantics (plan-decision items included) — proves the server-side audience override.
- New byte-compat regression test: capture the full JSON response (minus `fetchedAt`) of a call WITHOUT `enumerate` against a fixed fixture set both before and after this phase's changes are applied (in practice: assert the response shape/values against a hard-coded expected object) — proves the default path is unaffected by the `enumerate` param's addition.
- Existing `describe("extractUnblockSignal")` (`:480-577`) and `describe("extractDecisionSignal")` (`:578-675`) fixtures updated to include a `url` field on comment nodes, with new assertions that the returned signal's `sourceCommentUrl` matches.

### Success Criteria

#### Automated Verification

- [x] `cd mcp-server && npm run build` exits 0.
- [x] `npx vitest run src/__tests__/directions-tools.test.ts` passes, including all new tests listed above.
- [x] `npm test` (full suite, from `mcp-server/`) passes.
- [x] `grep -n "openPRs:\s*z\." mcp-server/src/tools/directions-tools.ts` still returns nothing (existing GH-1155 regression guard at `:686-694` unaffected by this change).

#### Manual Verification

- [ ] Run the MCP server locally (or via an existing ralph session) and call `ralph_hero__next_actions` with `enumerate: "human-queue"` against a real project containing at least one Plan in Review issue holding on an unanswered `## Decision Request` comment; open the returned `signals.sourceCommentUrl` in a browser and confirm it lands on the exact comment.
- [ ] Confirm a call WITHOUT `enumerate` against the same project still returns exactly 3 directions (default `limit`) with the same top-3 ordering as before this change.

## Testing Strategy

### Unit Tests

- `mcp-server/src/__tests__/directions.test.ts`: pure-lib coverage of `enumerateDirections` (full-list return, kind coverage, `sourceCommentUrl` presence/absence, rank/recommended semantics) and the prefix-identity regression against `rankDirections`.

### Integration Tests

- `mcp-server/src/__tests__/directions-tools.test.ts`: tool-boundary coverage of the `enumerate` param (ignoring `limit`, forcing human audience), the comments-query URL plumbing end-to-end, and the byte-compat regression for the default (no-`enumerate`) call.

### Manual Testing Steps

1. `cd mcp-server && npm run build && npm test` — full green run.
2. Call `ralph_hero__next_actions` with `enumerate: "human-queue"` against a live project; spot-check the returned list against the project board manually (does every Plan in Review / Human Needed / stale-lock / stale-PR item appear exactly once?).
3. Call `ralph_hero__next_actions` without `enumerate` against the same project; confirm the top-N output is unchanged from pre-change behavior.

## Migration Notes

Purely additive: one new optional tool param (`enumerate`), one new optional signal field (`sourceCommentUrl`, populated only for two kinds), one new exported lib function (`enumerateDirections`). No existing param, response field, or default-path behavior is removed or altered. Mcp-server minor version bump (consistent with prior additive changes to this tool, e.g. GH-1544's `decisionRequestAgeDays`/`decisionCount`). Rollback is trivial: revert the two files; no state-machine or schema-migration involved.

## References

- Issue: https://github.com/cdubiel08/ralph-hero/issues/1551
- Epic: https://github.com/cdubiel08/ralph-hero/issues/1550 (plan-of-plans: `thoughts/shared/plans/2026-07-19-GH-1550-epic-ways-of-working-surfaces.md`)
- Research: `thoughts/shared/research/2026-07-19-GH-1550-ways-of-working-action-surfaces.md`
- Downstream consumer (future, not this plan): GH-1553, `catch-up --mode brief`
- Sibling contract this feature must not duplicate: `ralph/skills/plan/plan-review.md` (decision pickers), `ralph/skills/caretake/modes/unblock.md` (unblock Q&A) — enumeration surfaces these items; it does not re-implement their answer flows.
- Lib: `mcp-server/src/lib/directions.ts`
- Tool: `mcp-server/src/tools/directions-tools.ts`
- Tests: `mcp-server/src/__tests__/directions.test.ts`, `mcp-server/src/__tests__/directions-tools.test.ts`
