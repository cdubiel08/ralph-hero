---
date: 2026-07-19
status: draft
type: plan
tags: [mcp-tools, toolspace, batch, tree-creation, pruning]
github_issue: 1565
github_issues: [1565, 1566]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1565
  - https://github.com/cdubiel08/ralph-hero/issues/1566
primary_issue: 1565
estimate: S
---

# Group plan: `create_sub_issues` batch tool + zero-reference tool prune (GH-1565 + GH-1566)

## Prior Work

- builds_on:: [[2026-07-19-GH-1563-mcp-tool-surface-pruning-and-tree-creation]] — the research doc this plan executes (full 38-tool inventory, live-reference counts, tree-creation cost analysis)
- builds_on:: [[2026-07-19-GH-1563-plan-of-plans]] — parent sequencing artifact (GH-1565 → GH-1566)
- builds_on:: GH-451 toolspace consolidation (53→26, 2026-02) — this is the follow-up prune for the re-grown surface
- tensions:: GH-1552 (open `pipeline_status_summary` proposal) — adds a tool while this pass prunes; no file conflict, but the net-surface accounting in the CHANGELOG should mention it

## Overview

Two coupled changes to the `ralph-hero-mcp-server` tool surface, shipping as one PR (GH-1538 group unit). First, a new `create_sub_issues` batch tool that creates a parent's child issues, project items, field values, sub-issue links, and dependency edges in a bounded number of aliased-GraphQL round trips — replacing the ~3N+M sequential tool-call loop that all three tree-building skills (epic decomposition, form tree shape, caretake split) currently drive (observed: 23 calls for a 4-child tree in the GH-1550 session). Second, removal of the 7 zero-live-reference tools (draft-issue quartet, `list_groups`, `create_views`, plus the RALPH_DEBUG-gated `debug_stats`) and wiring `batch_update` into its intended consumer (`split.md` §Step 10), so ~20% of the schema/description token weight carried by every session and agent is dropped. (The parent plan-of-plans and GH-1566's title say "6" — that count is stale; 6 always-on + 1 debug-gated = 7.)

## Current State Analysis

The three tree-creation call sites all instruct the same two-pass loop: `create_issue` + `add_sub_issue` per child, then `add_dependency` per edge — `ralph/skills/plan/decomposition.md:58-83`, `ralph/skills/form/SKILL.md:137-146`, `ralph/skills/caretake/modes/split.md:93-127`. No MCP tool can emit a parent+children+edges subtree in one call; `decompose_feature` (kept) comes closest but produces flat sibling sets locked to `.ralph-repos.yml` registry patterns.

### Key Discoveries

- **Two batch precedents exist.** `batch-tools.ts:47-196` uses pure builder functions producing one multi-alias mutation string (`u{num}_{opIdx}:` aliases, per-alias variable names to avoid collisions, `MUTATION_CHUNK_SIZE = 50` chunks at `batch-tools.ts:213`, executed via a single `client.projectMutate()` at `:504`). `decompose-tools.ts:276-489` instead loops per-item sequential `client.mutate()` calls. The builder-function pattern is the right precedent — it's the whole point of the new tool.
- **Creation is inherently multi-stage.** Child issue IDs don't exist until `createIssue` returns, so the new tool needs ~4 sequential stages, each internally aliased: (1) aliased `createIssue` mutations, (2) aliased `addSubIssue` + `addProjectV2ItemById`, (3) aliased field updates (workflow state/estimate/priority — reusing `buildBatchMutationQuery`-style builders), (4) aliased `addBlockedBy` dependency edges. That's O(1) network round trips per stage vs O(N) tool calls today.
- **The 7 prune targets have clean deletion boundaries** (per-tool line ranges verified 2026-07-19): draft quartet at `project-management-tools.ts:44-473` (partial edit; `create_status_update`/`archive_items` and the shared `../lib/helpers.js` imports stay); `list_groups` at `relationship-tools.ts:1062-1290` plus its exclusive helpers `RawProjectItem` (`:121-133`) and `getFieldValue` (`:135-145`) and the then-unused `paginateConnection` import (`:35`); `create_views` = whole-file deletion of `view-tools.ts` + its `index.ts:33,535` wiring + the then-dead `fetchProjectViews` in `project-tools.ts:653`; `debug_stats` at `debug-tools.ts:762-812` plus its exclusive JSONL machinery (`LogEvent`/`ErrorGroup`/`StatsGroup`, `readLogEvents`, `isErrorEvent`, `normalizeErrorMessage`, `getEventName`, `getErrorType`, `buildSignature`, `hashSignature`, `groupErrors`, `aggregateStats`, `logDir`, and the `readdir`/`readFile`/`createHash` imports — `platform`/`release` stay for `collate_debug`).
- **Test surface is mapped**: `tool-registration.test.ts:162-199` `EXPECTED_TOOLS` manifest needs 6 entries removed; `view-tools.test.ts` and `debug-tools.test.ts` delete wholesale; `project-management-tools.test.ts` needs surgical removal of draft-issue blocks (`:157-224`, `:451-518`) while keeping the draft-*shaped*-ID tests at `:547`/`:592` and the `PROTECTED_FIELDS` block; `relationship-tools.test.ts:196-266` drops the two `list_groups` describes; `cross-tool-consistency.test.ts:923-946` drops the `list_groups` regression pin; `cross-tool-pagination-consistency.test.ts` needs a full read before edit (references `list_groups` at least in a comment at `:25`).
- **CLAUDE.md roster is already partially silent**: the draft quartet and `list_groups` were never in the Tool modules table (`CLAUDE.md:107-126`) — only `create_views` (`:123`), `debug_stats` (`:126`, as "debug tools"), and the `batch_update`/`decompose_feature`/`sync_plan_graph` rows need touching, plus a new row for the tree-tools module.
- **`split-size-gate.sh` gates `create_issue` by name** (PreToolUse matcher) — the new batch tool bypasses it unless the hook's matcher is extended to cover `create_sub_issues` and validate every child spec's estimate.

## Desired End State

1. `ralph_hero__create_sub_issues` is registered: input = parent issue number + 1-50 child specs (`title`, `body?`, `estimate?`, `priority?`, `workflowState?`, `dependsOn?: (sibling index | issue number)[]`); output = created tree (per-child number/URL/projectItemId, linked status, wired edges); `dependsOn` cycle-validated before any mutation; per-stage partial-failure reporting (a failed stage reports which children succeeded and what remains, so the caller can repair incrementally).
2. All three tree-creation skill call sites instruct `create_sub_issues` for multi-child creation, keeping single-child `create_issue` + `add_sub_issue` for incremental additions.
3. Edge-wiring has one owner at creation time: `create_sub_issues` wires intra-tree edges; `sync_plan_graph` remains the post-hoc reconciliation tool; no skill instructs a manual `add_dependency` loop for a fresh tree.
4. The 7 zero-reference tools are gone (registration, handlers, exclusive helpers, tests, wiring); `mcp-server` builds and all tests pass.
5. `batch_update` has a live reference: `split.md` §Step 10 instructs it for the state-uniformity pass.
6. `split-size-gate.sh` covers `create_sub_issues` child estimates (XS/S only, same rule as `create_issue`).
7. CLAUDE.md rosters match the live surface; `scripts/check-doc-rosters.sh` passes; CHANGELOG notes the net surface change (38 → 32: −7 pruned (6 always-on + 1 debug-gated), +1 added).

### Verification

- `cd mcp-server && npm run build && npm test` — green, including new `tree-tools` tests and updated `tool-registration` manifest
- `bash scripts/check-doc-rosters.sh` — passes
- `grep -rE "create_draft_issue|update_draft_issue|convert_draft_issue|get_draft_issue|list_groups|create_views|debug_stats" ralph/ plugin/ mcp-server/src/` — zero hits (excluding CHANGELOG)
- `grep -rn "batch_update" ralph/skills/caretake/modes/split.md` — ≥1 hit
- Manual: a live `create_sub_issues` call against the board creates a 2-child tree with one dependency edge in one tool call

## What We're NOT Doing

- Not touching `decompose_feature` (kept: registry/multi-repo path, 8 live refs) or `sync_plan_graph` (kept: post-hoc reconciliation + hook integration) beyond prose clarifying their roles.
- Not inlining `detect_stream_positions` or refactoring the scan family (`list_issues`/`pipeline_dashboard`/`next_actions`/`project_hygiene`/`health_check` shared-fetch) — internal-refactor opportunities noted in research §4, out of scope.
- Not addressing the `advance_issue` vs `save_issue` parent-gate duplication.
- Not coordinating implementation with GH-1552 beyond a CHANGELOG mention.
- Not removing `PROTECTED_FIELDS` (`project-management-tools.ts:30`) — unrelated to the draft tools, test-pinned, independent cleanup.

## Design Decisions & Open Ambiguities

- **Where the new tool lives** — options: new `tree-tools.ts` module; append to `relationship-tools.ts`; append to `batch-tools.ts`. **Decided: new `mcp-server/src/tools/tree-tools.ts` with `registerTreeTools()`.** `relationship-tools.ts` is already ~1300 lines, and a dedicated module matches the one-module-per-concern registration pattern and gives the roster table a clean row.
- **Batch mechanics** — options: aliased builder functions (batch_update pattern); sequential per-item loop (decompose_feature pattern). **Decided: aliased builder functions in ~4 stages** (create → link+add-to-project → field values → edges). Sequential looping would reproduce the latency problem server-side; staging is unavoidable because later stages consume IDs from earlier ones.
- **`batch_update` fate** — options: wire into `split.md` §Step 10; delete. **Decided: wire in.** Its use case (bulk field updates on *existing* issues, including reused children on the re-split path) is distinct from `create_sub_issues` (creation-time fields on *new* children), so the capability isn't subsumed; the fix is a one-line skill instruction, far cheaper than deleting and re-adding later.
- **Edge-wiring ownership** — options: `create_sub_issues` wires edges at creation with `sync_plan_graph` for post-hoc drift; switch skills to `sync_plan_graph` everywhere. **Decided: creation-time edges belong to `create_sub_issues`; `sync_plan_graph` stays the reconciliation path.** `sync_plan_graph` requires a plan doc with `depends_on:` annotations, which form/split call sites don't have at tree-creation time.
- **`fetchProjectViews` cleanup** — deleting `view-tools.ts` orphans `fetchProjectViews` in `project-tools.ts:653`. **Decided: remove it in the same pass** — leaving verified-dead code contradicts the point of the prune.
- **Hook coverage for the new tool** — `split-size-gate.sh` currently matches `create_issue` only. **Decided: extend its matcher to `create_sub_issues`** and validate every element of the child-spec array (XS/S only), so the batch path can't smuggle oversized children past the gate.

None — no open design decisions.

## Implementation Approach

Two phases mapping to the two group members in dependency order (GH-1565 → GH-1566), one shared branch/worktree, one PR closing both. Phase 1 adds the tool and rewires the skills; Phase 2 prunes with full knowledge of Phase 1's shape. Doc-roster and CHANGELOG edits land with the phase that motivates them.

## Phase 1: GH-1565 — `create_sub_issues` batch tool + call-site rewiring

depends_on: null

### Overview

Add `registerTreeTools()` with the `create_sub_issues` tool, register it, cover it with tests, extend the size-gate hook, and rewire the three skill call sites.

### Changes Required

#### Task 1.1: `tree-tools.ts` — builders + tool registration
- **files**: `mcp-server/src/tools/tree-tools.ts` (create), `mcp-server/src/index.ts` (modify)
- **tdd**: true
- **complexity**: high
- **depends_on**: null
- **acceptance**:
  - [x] Zod input schema: `parentNumber` + `children[]` (1-50) with `title` (required), `body`, `estimate` (XS-XL passthrough — policy gating stays in the hook), `priority`, `workflowState`, `dependsOn` (array of sibling indexes or issue numbers)
  - [x] Cycle validation over `dependsOn` runs before ANY mutation; a cycle returns `toolError` naming the cycle members
  - [x] Stage 1 aliased `createIssue`; Stage 2 aliased `addSubIssue` + `addProjectV2ItemById`; Stage 3 aliased field updates (reuse/extend `buildBatchMutationQuery`-style builders from `batch-tools.ts`); Stage 4 aliased `addBlockedBy` edges — each stage one `client.mutate()`/`projectMutate()` call (chunked at 50 aliases)
  - [x] Partial-failure semantics: stage failure returns per-child status (created/linked/fields/edges) so callers can repair without re-creating
  - [x] `registerTreeTools(server, client, fieldCache)` wired in `src/index.ts`

#### Task 1.2: tests
- **files**: `mcp-server/src/__tests__/tree-tools.test.ts` (create), `mcp-server/src/__tests__/tool-registration.test.ts` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [1.1]
- **acceptance**:
  - [x] Builder unit tests: alias/variable-name shape for each stage (mirroring `batch-tools.test.ts` style)
  - [x] Cycle-detection tests: self-reference, 2-cycle, mixed sibling-index/issue-number refs
  - [x] Partial-failure test: stage-2 failure reports created-but-unlinked children
  - [x] `EXPECTED_TOOLS` manifest gains `ralph_hero__create_sub_issues`

#### Task 1.3: hook + skill rewiring
- **files**: `ralph/hooks/scripts/split-size-gate.sh` (modify), `ralph/hooks/scripts/__tests__/split-size-gate.test.sh` (create), `ralph/skills/caretake/SKILL.md` (modify), `ralph/skills/caretake/split-decomposition.md` (modify), `ralph/skills/plan/decomposition.md` (modify), `ralph/skills/form/SKILL.md` (modify), `ralph/skills/caretake/modes/split.md` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [1.1]
- **acceptance**:
  - [x] `split-size-gate.sh` covers `create_sub_issues`: hook matcher extended in `ralph/skills/caretake/SKILL.md` frontmatter (currently `ralph_hero__create_issue` only) AND the hook-roster table row in `split-decomposition.md` (§Hook contracts, `create_issue` matcher row) updated; the script iterates every `children[].estimate` (it currently reads a scalar `.tool_input.estimate`) and blocks any child spec with estimate M/L/XL
  - [x] New `ralph/hooks/scripts/__tests__/split-size-gate.test.sh` covers both the scalar `create_issue` path and the child-array `create_sub_issues` path (no test file exists today; CI discovers `*.test.sh` via find — ci.yml)
  - [x] `decomposition.md` § Child creation + § Dependency-edge rules instruct one `create_sub_issues` call (single-child incremental additions keep `create_issue`+`add_sub_issue`); prose notes `sync_plan_graph` is post-hoc reconciliation
  - [x] `form/SKILL.md` Step 6b instructs `create_sub_issues` for the child set
  - [x] `split.md` §Step 6-7 instruct `create_sub_issues` (verify/retry prose adapts to the tool's per-child status report)

#### Task 1.4: roster docs
- **files**: `CLAUDE.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [x] Tool modules table gains a `tree-tools.ts` row with `create_sub_issues`
  - [x] `bash scripts/check-doc-rosters.sh` passes

### Success Criteria

#### Automated Verification
- [x] `cd mcp-server && npm run build` exits 0
- [x] `cd mcp-server && npm test` passes (new tree-tools tests included)
- [x] `bash scripts/check-doc-rosters.sh` passes
- [x] `bash ralph/hooks/scripts/__tests__/split-size-gate.test.sh` passes (new file; CI runs each `*.test.sh` via its find loop in ci.yml)

#### Manual Verification
- [ ] Live call: `create_sub_issues` with 2 children + 1 edge against the board produces the full tree in one tool call; `get_issue` on the parent shows both children linked

## Phase 2: GH-1566 — prune 7 zero-reference tools + wire `batch_update`

depends_on: [phase-1]

### Overview

Delete the 7 dead tools with their exclusive helpers, wiring, and tests; give `batch_update` its live reference in split §Step 10; finish the roster/CHANGELOG pass.

### Changes Required

#### Task 2.1: draft quartet removal
- **files**: `mcp-server/src/tools/project-management-tools.ts` (modify), `mcp-server/src/__tests__/project-management-tools.test.ts` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [x] `server.tool` blocks at `:44-473` (create/update/convert/get_draft_issue) removed; `create_status_update` + `archive_items` intact
  - [x] Test blocks `:157-224` and `:451-518` removed; draft-shaped-ID tests (`:547`, `:592`) and `PROTECTED_FIELDS` block kept

#### Task 2.2: `list_groups` removal
- **files**: `mcp-server/src/tools/relationship-tools.ts` (modify), `mcp-server/src/__tests__/relationship-tools.test.ts` (modify), `mcp-server/src/__tests__/cross-tool-consistency.test.ts` (modify), `mcp-server/src/__tests__/cross-tool-pagination-consistency.test.ts` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [x] Tool block `:1062-1290` + exclusive helpers `RawProjectItem` (`:121-133`), `getFieldValue` (`:135-145`) + now-unused `paginateConnection` import removed; `buildSubIssueFragment`/`mapSubIssueNodes` untouched
  - [x] `list_groups` describes (`:196-238`, `:244-266`) and the regression pin (`cross-tool-consistency.test.ts:923-946`) removed; pagination-consistency suite read fully and cleaned of any `list_groups` assertions

#### Task 2.3: `create_views` + `debug_stats` removal
- **files**: `mcp-server/src/tools/view-tools.ts` (delete), `mcp-server/src/__tests__/view-tools.test.ts` (delete), `mcp-server/src/tools/project-tools.ts` (modify), `mcp-server/src/tools/debug-tools.ts` (modify), `mcp-server/src/__tests__/debug-tools.test.ts` (delete), `mcp-server/src/index.ts` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [x] `view-tools.ts` + its test deleted; `index.ts:33,535` import/registration removed; orphaned `fetchProjectViews` removed from `project-tools.ts`
  - [x] `debug_stats` block (`debug-tools.ts:762-812`) + exclusive JSONL machinery + `logDir` + now-unused imports removed; the file-header comment mentioning `debug_stats` ("preserved for backward compat", lines 9-10) updated so the zero-hits grep passes; `collate_debug` and its 4 test files untouched; `registerDebugTools` call in `index.ts` stays (still RALPH_DEBUG-gated)

#### Task 2.4: `batch_update` wire-in + roster/CHANGELOG
- **files**: `ralph/skills/caretake/modes/split.md` (modify), `CLAUDE.md` (modify), `CHANGELOG.md` (modify — root, `## [Unreleased]`; `mcp-server/CHANGELOG.md` does not exist)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [x] `split.md` §Step 10 instructs `batch_update(issues: [all children], operations: [workflow_state])` for the uniformity pass instead of per-child `save_issue`
  - [x] CLAUDE.md rows for `view-tools.ts` and `debug_stats` removed/adjusted; `scripts/check-doc-rosters.sh` passes
  - [x] CHANGELOG entry: −7 tools (named), +1 `create_sub_issues`, `batch_update` now referenced by split; note GH-1552 may add one more; acknowledge `debug_stats` removal reverses the "preserved for backward compat" header note in `debug-tools.ts` (that header comment is cleaned in Task 2.3)

### Success Criteria

#### Automated Verification
- [x] `cd mcp-server && npm run build && npm test` — green with 6 manifest entries removed
- [x] `grep -rE "create_draft_issue|update_draft_issue|convert_draft_issue|get_draft_issue|list_groups|create_views|debug_stats" ralph/ plugin/ mcp-server/src/` — zero hits
- [x] `bash scripts/check-doc-rosters.sh` passes

#### Manual Verification
- [ ] MCP server starts and lists 31 tools (32 with RALPH_DEBUG, which adds `collate_debug`); no startup errors

## Testing Strategy

### Unit Tests
- New `tree-tools.test.ts`: builder shapes, cycle detection, chunking at 50, partial-failure status reporting.
- Updated `tool-registration.test.ts` manifest is the single source of truth for the surviving surface (add 1, remove 6).

### Integration Tests
- Existing cross-tool consistency suites re-run green after `list_groups` removal — they double as the regression net for accidental collateral edits in `relationship-tools.ts`.

### Manual Testing Steps
1. Rebuild, restart the MCP server, run one live `create_sub_issues` call (2 children, 1 edge) against project 3; verify tree via `get_issue`.
2. Confirm a child spec with estimate `M` is blocked by `split-size-gate.sh` in a split-mode session.

## Performance Considerations

Stage-chunked aliased mutations keep worst-case GraphQL requests at `ceil(N/50)` per stage (4 stages) — for typical 2-8-child trees that is 4 requests total vs today's 3N+M tool round trips. Rate-limiter accounting is unchanged (each stage is one tracked request).

## Migration Notes

- No data migration. Removed tools were verifiably uncalled by any live skill/agent/hook; any external caller of the draft-issue tools (none known) would see "unknown tool" and should use `create_issue`.
- Release flows automatically: merging to main bumps `mcp-server` (release.yml), publishes to npm, and pins `ralph/.mcp.json`; the ralph plugin bump (release-ralph.yml) picks up the skill/hook edits. No manual publish.
- The `EXPECTED_TOOLS` manifest change makes the prune loud in review — any tool missing from the manifest fails CI.

## References

- Research: `thoughts/shared/research/2026-07-19-GH-1563-mcp-tool-surface-pruning-and-tree-creation.md`
- Parent plan-of-plans: `thoughts/shared/plans/2026-07-19-GH-1563-plan-of-plans.md`
- Precedents: `mcp-server/src/tools/batch-tools.ts` (aliased builders), `mcp-server/src/tools/decompose-tools.ts` (issue+edge creation)
- Issues: #1563 (parent), #1565, #1566
