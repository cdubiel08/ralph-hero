---
date: 2026-05-09
status: draft
type: plan
github_issue: 1159
github_issues: [1159]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1159
primary_issue: 1159
parent_plan: thoughts/shared/plans/2026-05-08-group-GH-1153-shorthand-tools-consistency-pass.md
tags: [mcp-tools, deprecation-removal, breaking-change, next_actions, hello_directions, pick_actionable_issue, ralph-hero]
---

# Remove deprecated `hello_directions` and `pick_actionable_issue` - Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-05-08-shorthand-tools-counts-and-filters]] (research — primary evidence; documents the deprecated-tool inventory and the production callers that must migrate)
- builds_on:: [[2026-05-08-group-GH-1153-shorthand-tools-consistency-pass]] (parent plan — defines the consistency-pass posture; this plan is Phase 6)
- builds_on:: [[2026-04-30-group-GH-0921-hello-directions-implementation]] (plan — the canonical `next_actions` ranking spec the removed tools delegated to)

## Overview

Single XS atomic phase: delete the two deprecated wrapper tools (`ralph_hero__hello_directions` and `ralph_hero__pick_actionable_issue`), migrate the two production callers in `team/SKILL.md` and `hero/SKILL.md` to drop the deprecated tool from their allowed-tools lists (both already include `next_actions`), delete the dedicated test files / blocks, and strip references from `CLAUDE.md` (root) and the `justfile`.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-1159 | Remove deprecated `hello_directions` and `pick_actionable_issue` | XS |

**Why grouped**: Single-issue plan. GH-1159 is a leaf of the GH-1153 group; its prerequisites (Phases 1, 2, 3 of the parent plan) are all CLOSED.

## Shared Constraints

Inherited verbatim from the parent plan ([2026-05-08-group-GH-1153-shorthand-tools-consistency-pass.md](2026-05-08-group-GH-1153-shorthand-tools-consistency-pass.md)):

- **Module system**: ESM with `"module": "NodeNext"`. All internal imports use `.js` extensions on TypeScript source.
- **Build/typecheck gate**: `npm run build` (`tsc`) is the primary code-quality gate; strict mode enabled.
- **Test runner**: vitest 4. Run from `plugin/ralph-hero/mcp-server/`.
- **Tool response shape**: Use `toolSuccess(...)` / `toolError(...)` from `src/types.ts`.
- **Auto-release awareness**: Merges to `main` touching `mcp-server/src/` auto-bump the patch version. Phase 6 (deprecation removal) is BREAKING — commit message MUST include `#minor`.
- **No backwards-compat shims**: Per the project posture, deprecated fields/params are removed cleanly when they go. No `// removed for X` comments or aliased re-exports.

Phase-specific extension:
- The shared helper `makeRunDirections` (exported from `src/tools/directions-tools.ts:363`) is consumed by both the deprecated `pick_actionable_issue` and the live `next_actions`. It MUST remain exported. Only the deprecated tool's `server.tool(...)` registration and its post-filter wrapper code are deleted.
- The shared helper `extractUnblockSignal` (exported from `src/tools/directions-tools.ts:132`) is used by `next_actions` and tested directly. It MUST remain exported.
- The `justfile` has two recipes (`pick`, `quick-pick`) that call `pick_actionable_issue`. They MUST be migrated to `next_actions(limit=1, audience="agent")` as part of this phase — the in-tree `# NOTE: intentional deprecated-alias caller — pick_actionable_issue removed in 2.7.0` comments confirm the migration intent. Skipping the justfile would leave a broken CLI surface after the registration is removed.

## Current State Analysis

Combined evidence from the audit and verified by direct file reads on 2026-05-09:

**Deprecated registrations and their helpers**:
- `ralph_hero__hello_directions` registered at `plugin/ralph-hero/mcp-server/src/tools/directions-tools.ts:477-534`. The handler is one line: `return await runDirections({ ...args, audience: "human" });` — pure wrapper, no helpers exclusive to it.
- `ralph_hero__pick_actionable_issue` registered at `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts:1665-1871`. The handler is ~190 lines: validates state and estimate, calls `runDirections({ audience: "agent", limit: 50 })`, post-filters to `kind="issue"`, applies caller-provided `workflowState` and `maxEstimate`, drops `tags.includes("blocked")`, then runs a best-effort `detectGroup` for group context. No helpers exclusive to this wrapper — `isValidState`, `VALID_STATES`, `resolveFullConfig`, `detectGroup`, and `makeRunDirections` are all consumed by other tools in `issue-tools.ts`.

**Production callers** (verified):
- `plugin/ralph-hero/skills/team/SKILL.md:23` — `mcp__plugin_ralph-hero_ralph-github__ralph_hero__pick_actionable_issue` line in allowed-tools. Line 22 already lists `next_actions`. Skill body has no prose-level references to `pick_actionable_issue`. Migration is line-deletion only.
- `plugin/ralph-hero/skills/hero/SKILL.md:37` — same shape: `pick_actionable_issue` in allowed-tools, `next_actions` already on line 36. Migration is line-deletion only.
- `plugin/ralph-hero/justfile:60` (recipe `pick`) and `plugin/ralph-hero/justfile:637` (private recipe `quick-pick`). Both call the deprecated MCP tool name verbatim. Both have inline `# NOTE: intentional deprecated-alias caller — pick_actionable_issue removed in 2.7.0. Migrate to: ralph_hero__next_actions(limit=1, audience="agent")` comments. Migration is straightforward (rename tool + adjust JSON args; `next_actions` consumes `audience`, `limit`, and ignores `workflowState`/`maxEstimate` so the recipe semantics narrow slightly — the user-supplied `state` and `max-estimate` arguments become advisory; document this in the recipe doc-comment).

**Test files**:
- `plugin/ralph-hero/mcp-server/src/__tests__/pick-actionable-issue.test.ts` exists, 552+ lines, exclusively exercises the deprecated wrapper. Whole-file deletion.
- `plugin/ralph-hero/mcp-server/src/__tests__/directions-tools.test.ts` exercises both the deprecated `hello_directions` and the live `next_actions`. Lines 313-(start of `next_actions` block) and a parity block "hello_directions backwards-compat" at 747-(end of describe) target the deprecated tool. Selective deletion required. The `extractUnblockSignal` test block (line 822 onward) MUST stay.

**Coverage HTML artifacts** (`plugin/ralph-hero/mcp-server/coverage/`) reference the deprecated tools but are generated on each test run. They are NOT committed (per `.gitignore`) and need no plan attention.

**Documentation**:
- `/Users/dubiel/projects/ralph-hero/CLAUDE.md:113` — root CLAUDE.md table row: `| hygiene-tools.ts | pick_actionable_issue, project_hygiene |`. This is wrong on its face (`pick_actionable_issue` lives in `issue-tools.ts`, not `hygiene-tools.ts`) but the row exists; it must be edited to remove the deprecated name. Net result for that row: `| hygiene-tools.ts | pick_actionable_issue, project_hygiene |` becomes `| hygiene-tools.ts | pick_actionable_issue, project_hygiene |` minus `pick_actionable_issue`. Since `pick_actionable_issue` was incorrectly grouped under `hygiene-tools.ts` to begin with, the cleanest result is to drop it entirely (no replacement row needed; `next_actions` is already documented elsewhere in the architecture section).
- `/Users/dubiel/projects/ralph-hero/plugin/ralph-hero/README.md` — verified: NO references to either deprecated tool name. The issue body's mention of `README.md:149` is stale; line 149 references autopilot dry-run, unrelated. No README edit required.
- `/Users/dubiel/projects/ralph-hero/plugin/ralph-hero/CLAUDE.md` — verified: file does not exist. Issue body's reference to `plugin/ralph-hero/CLAUDE.md:113` is stale; the root `/Users/dubiel/projects/ralph-hero/CLAUDE.md:113` is the right target.

**Build / test commands** (discovered via package.json read):
- Build: `npm run build` (tsc) — run from `plugin/ralph-hero/mcp-server/`.
- Test: `npm test` (vitest run --coverage) — same directory.

## Desired End State

After this phase lands:

- `ralph_hero__hello_directions` no longer registered. Calling the MCP method returns "tool not found".
- `ralph_hero__pick_actionable_issue` no longer registered. Same behavior.
- `team/SKILL.md` and `hero/SKILL.md` allowed-tools lists no longer mention `pick_actionable_issue`. Both still list `next_actions` (no addition needed; line removal only).
- `justfile` `pick` and `quick-pick` recipes call `next_actions` instead. Inline migration comments removed; doc comments updated to reflect the new tool.
- Dedicated test file `pick-actionable-issue.test.ts` deleted.
- `directions-tools.test.ts` no longer exercises `hello_directions`; tests for `next_actions` and `extractUnblockSignal` retained.
- Root `CLAUDE.md` no longer lists `pick_actionable_issue` in the tool-modules table.
- Source-tree grep for `pick_actionable_issue` and `hello_directions` returns zero non-historical hits (the parent plan, this plan, and the research doc may legitimately mention the names).

### Verification

- [ ] `npm run build` passes from `plugin/ralph-hero/mcp-server/`
- [ ] `npm test` passes (no orphaned references to deleted tests)
- [ ] `grep -rn "pick_actionable_issue\|hello_directions" plugin/ralph-hero/mcp-server/src/` returns 0 hits
- [ ] `grep -rn "pick_actionable_issue\|hello_directions" plugin/ralph-hero/skills/ plugin/ralph-hero/agents/` returns 0 hits
- [ ] `grep -rn "pick_actionable_issue\|hello_directions" plugin/ralph-hero/justfile` returns 0 hits
- [ ] `grep -rn "pick_actionable_issue\|hello_directions" .github/workflows/` returns 0 hits
- [ ] Root `CLAUDE.md` no longer lists `pick_actionable_issue`
- [ ] Manual: `mcp call ralph_hero__hello_directions` returns "tool not found"
- [ ] Manual: `mcp call ralph_hero__pick_actionable_issue` returns "tool not found"
- [ ] Manual: `/team` and `/hero` skill invocations succeed end-to-end after the change
- [ ] Manual: `just pick` and `just quick-pick` recipes return a picked issue via the migrated `next_actions` call
- [ ] Commit message includes `#minor`

## What We're NOT Doing

- Not removing or renaming `makeRunDirections` (the shared helper) — it stays exported and used by `next_actions`.
- Not removing or renaming `extractUnblockSignal` — it stays exported and tested directly.
- Not modifying any consumer of `next_actions` other than removing the now-redundant `pick_actionable_issue` allowed-tools entries from `team/` and `hero/` skills (no prose changes; the skills already use `next_actions`).
- Not changing the `next_actions` API surface in any way. This phase is pure deletion + redirection.
- Not adding new tests for `next_actions` (the parity tests in `pick-actionable-issue.test.ts` were specifically testing the wrapper's filter semantics, which die with the wrapper; `next_actions` already has its own coverage).
- Not modifying the GitHub Actions workflows — verified there are no references.
- Not editing the README — verified there are no references.
- Not touching the agents/ directory — verified there are no references.

## Implementation Approach

Single phase, executed in a single PR. The order of edits inside the phase matters only because TypeScript would otherwise fail to compile during an in-progress edit; the plan groups edits by file so the working tree stays consistent at the end of each task.

---

## Phase 1: Remove deprecated `hello_directions` and `pick_actionable_issue` (GH-1159)
- **depends_on**: null

### Overview

Delete the two deprecated server.tool registrations, migrate the two skill allowed-tools lists by line removal, migrate the two justfile recipes to `next_actions`, delete the dedicated test file, prune the deprecated test cases from `directions-tools.test.ts`, and remove the deprecated row from the root `CLAUDE.md`.

### Tasks

#### Task 1.1: Delete `hello_directions` server.tool registration
- **files**: `plugin/ralph-hero/mcp-server/src/tools/directions-tools.ts` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] The `server.tool("ralph_hero__hello_directions", ...)` call (lines 477-534) is removed entirely
  - [ ] The shared helpers (`makeRunDirections`, `extractUnblockSignal`, the `runDirections` instantiation inside `registerDirectionsTools`) remain in place because `next_actions` and `pick_actionable_issue`-handler-via-issue-tools-import still use them — note: after Task 1.2 lands the issue-tools.ts import goes away, but `makeRunDirections` is still consumed by the `next_actions` registration at line 537 of the same file
  - [ ] The file-header doc comment at lines 1-10 is updated to remove the `hello_directions` mention; the helper comment at lines 356-360 is updated to drop the "(deprecated)" reference and read like: "Shared implementation — extracted so the `next_actions` tool can route through a single code path."
  - [ ] The library doc comment at `src/lib/directions.ts:2` (`Pure ranker library for the ralph_hero__hello_directions MCP tool.`) is rewritten to reference `ralph_hero__next_actions`
  - [ ] `npm run build` passes after this task in isolation (only `directions-tools.ts` and `directions.ts` doc-comment changes; nothing depends on the deleted tool)

#### Task 1.2: Delete `pick_actionable_issue` server.tool registration
- **files**: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] The block of code at lines 1665-1871 (everything from the `// ralph_hero__pick_actionable_issue [DEPRECATED]` banner comment through the closing `},);` of the `server.tool(...)` registration) is removed
  - [ ] The `import { makeRunDirections } from "./directions-tools.js";` import (line 29) is removed since this was the only consumer of that import inside `issue-tools.ts`
  - [ ] No other imports become unused — `isValidState`, `VALID_STATES`, `resolveFullConfig`, and `detectGroup` are all used by other tools in the file (verified by the 16 occurrences found across the file)
  - [ ] `npm run build` passes after this task in isolation

#### Task 1.3: Migrate `team/SKILL.md` allowed-tools list
- **files**: `plugin/ralph-hero/skills/team/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] Line 23 (`  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__pick_actionable_issue`) is removed
  - [ ] Line 22 (`  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__next_actions`) is preserved unchanged
  - [ ] No other line edits in the frontmatter (the skill body has no prose references to either deprecated tool — verified)

#### Task 1.4: Migrate `hero/SKILL.md` allowed-tools list
- **files**: `plugin/ralph-hero/skills/hero/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] Line 37 (`  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__pick_actionable_issue`) is removed
  - [ ] Line 36 (`  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__next_actions`) is preserved unchanged
  - [ ] No other line edits in the frontmatter

#### Task 1.5: Migrate `justfile` `pick` and `quick-pick` recipes to `next_actions`
- **files**: `plugin/ralph-hero/justfile` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] Recipe `pick` at lines 56-61 is updated:
    - The inline `# NOTE: intentional deprecated-alias caller...` comment is removed
    - The doc comment changes from `# Find next actionable issue` to `# Find next actionable issue (rank-1 from next_actions, audience=agent)`
    - The `_mcp_call` line changes from `"ralph_hero__pick_actionable_issue"` with `'{"workflowState":"{{state}}","maxEstimate":"{{max-estimate}}"}'` to `"ralph_hero__next_actions"` with `'{"limit":1,"audience":"agent"}'`
    - Recipe parameters `state` and `max-estimate` are removed from the recipe signature (they no longer map to anything in `next_actions`); the recipe becomes parameter-less: `pick:`
  - [ ] Recipe `quick-pick` at lines 632-638 receives the equivalent treatment: comment removed, doc comment updated, `_mcp_call` redirected to `next_actions`, recipe signature simplified
  - [ ] Both recipes still execute end-to-end (manual verification step in Phase Success Criteria); the user-visible response shape changes from `pick_actionable_issue`'s `{found, issue, group, alternatives}` to `next_actions`'s `{directions[], fetchedAt, totalCandidates}` — this is acceptable since the `justfile` recipes are non-public CLI surfaces meant for human inspection

#### Task 1.6: Delete `pick-actionable-issue.test.ts`
- **files**: `plugin/ralph-hero/mcp-server/src/__tests__/pick-actionable-issue.test.ts` (delete)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.2]
- **acceptance**:
  - [ ] The file is deleted in its entirety
  - [ ] `git rm` is used (not just rm) so the deletion is staged
  - [ ] No other test file imports from this file — verified by grep before deletion

#### Task 1.7: Prune `directions-tools.test.ts` of `hello_directions` blocks
- **files**: `plugin/ralph-hero/mcp-server/src/__tests__/directions-tools.test.ts` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] The file-header doc comment at lines 1-12 is updated: replace the reference to `ralph_hero__hello_directions` with `ralph_hero__next_actions`
  - [ ] The `describe("ralph_hero__hello_directions", ...)` block starting at line 313 is removed entirely (every `it(...)` inside it through the matching closing `})`)
  - [ ] The "Phase 2.5 — hello_directions backwards-compat parity" block starting at line 747 is removed entirely
  - [ ] The `describe("extractUnblockSignal", ...)` block starting at line 826 is preserved unchanged
  - [ ] All `next_actions` describe/it blocks (if any exist between the deleted ranges) are preserved unchanged
  - [ ] `npm test src/__tests__/directions-tools.test.ts` passes after the prune

#### Task 1.8: Remove deprecated row from root `CLAUDE.md`
- **files**: `/Users/dubiel/projects/ralph-hero/CLAUDE.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] Line 113 changes from `| `hygiene-tools.ts` | pick_actionable_issue, project_hygiene |` to `| `hygiene-tools.ts` | pick_actionable_issue, project_hygiene |` minus `pick_actionable_issue` — concretely: the row reads `| hygiene-tools.ts | project_hygiene |` after the edit (single tool listed)
  - [ ] No other row changes — `next_actions` already lives in a `directions-tools.ts` row elsewhere in the table; if it does NOT exist there, leave the table alone (this plan does not touch documentation outside the deprecated-row scope)

#### Task 1.9: Final consistency grep
- **files**: (read-only verification)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8]
- **acceptance**:
  - [ ] `grep -rn "pick_actionable_issue\|hello_directions" plugin/` returns hits ONLY in: `thoughts/shared/plans/2026-05-08-group-GH-1153-shorthand-tools-consistency-pass.md`, `thoughts/shared/research/2026-05-08-shorthand-tools-counts-and-filters.md`, this plan file. Plus auto-generated coverage HTML which is uncommitted.
  - [ ] `grep -rn "pick_actionable_issue\|hello_directions" .github/workflows/` returns 0 hits
  - [ ] `grep -rn "pick_actionable_issue\|hello_directions" CLAUDE.md` returns 0 hits

### Phase Success Criteria

#### Automated Verification:
- [ ] `npm run build` — no errors
- [ ] `npm test` — all passing, no orphan-test errors, no missing-import errors
- [ ] `grep -rn "pick_actionable_issue\|hello_directions" plugin/ralph-hero/mcp-server/src/` returns 0 hits
- [ ] `grep -rn "pick_actionable_issue\|hello_directions" plugin/ralph-hero/skills/` returns 0 hits
- [ ] `grep -rn "pick_actionable_issue\|hello_directions" plugin/ralph-hero/justfile` returns 0 hits
- [ ] `grep -n "pick_actionable_issue" CLAUDE.md` returns 0 hits

#### Manual Verification:
- [ ] After publishing the change, `mcp list-tools` does not include `ralph_hero__hello_directions` or `ralph_hero__pick_actionable_issue`
- [ ] `/team` skill loads without complaint about the missing-from-allowed-tools entry being absent
- [ ] `/hero` skill loads similarly
- [ ] `just pick` returns a picked issue via the migrated call
- [ ] Commit message contains the literal string `#minor`

**Creates for next phase**: nothing — single-phase plan.

---

## Integration Testing
- [ ] Run `npm test` from `plugin/ralph-hero/mcp-server/` and confirm all suites pass
- [ ] Manual smoke-test: invoke `/team 1160` (the next pending plan) or `/hero 1160` against the live project; confirm the dispatch loop functions without referencing the removed tool

## References
- Issue: https://github.com/cdubiel08/ralph-hero/issues/1159
- Parent group plan: [thoughts/shared/plans/2026-05-08-group-GH-1153-shorthand-tools-consistency-pass.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-05-08-group-GH-1153-shorthand-tools-consistency-pass.md) — Phase 6
- Research: [thoughts/shared/research/2026-05-08-shorthand-tools-counts-and-filters.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-05-08-shorthand-tools-counts-and-filters.md)
- Sibling completed work (Phase 1, GH-1154): widened `next_actions` agent set — prerequisite for safe migration
- Sibling completed work (Phase 3, GH-1156): unified count field names — prerequisite for migration to land against the new shape
- `next_actions` source: [plugin/ralph-hero/mcp-server/src/tools/directions-tools.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/directions-tools.ts)
- Migration target call shape: `ralph_hero__next_actions(audience="agent", limit=1)` then read `directions[0].issue` for the picked entry
