---
date: 2026-03-21
status: draft
type: plan
github_issue: 652
github_issues: [652, 653, 654, 655]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/652
  - https://github.com/cdubiel08/ralph-hero/issues/653
  - https://github.com/cdubiel08/ralph-hero/issues/654
  - https://github.com/cdubiel08/ralph-hero/issues/655
primary_issue: 652
tags: [mcp-server, lock-guard, workflow-states, hooks, spec, testing]
---

# Server-Side Lock Guard for save_issue - Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-03-01-GH-0469-lifecycle-and-document-specs]]
- builds_on:: [[2026-02-22-ralph-workflow-v4-architecture-spec]]

## Overview

4 related issues for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-652 | Add server-side lock guard to save_issue | S |
| 2 | GH-653 | Unit tests for server-side lock guard | S |
| 3 | GH-654 | Remove lock-claim-validator hook | XS |
| 4 | GH-655 | Update issue-lifecycle spec for server-side enforcement | XS |

**Why grouped**: These four issues form a complete atomic change: the guard is worthless without tests (652+653), and the client-side hook is confusing noise once the guard is in the server (654). The spec update (655) closes the documentation loop. All four touch related lines of the codebase and should ship as one coherent PR.

## Shared Constraints

- **ESM module system**: All internal imports require `.js` extensions (e.g., `import { foo } from "./bar.js"`). The project uses `"type": "module"` with `"module": "NodeNext"`.
- **`toolError` / `toolSuccess` pattern**: All tool handlers return `toolError(message)` or `toolSuccess(result)` from `types.ts`. No direct exception throwing from within the handler body.
- **`getCurrentFieldValue` helper**: `src/lib/helpers.ts` exports `getCurrentFieldValue(client, fieldCache, owner, repo, issueNumber, fieldName, projectNumber?)`. Use this to fetch the current workflow state before applying mutations.
- **Lock guard placement**: The check MUST occur inside the `hasProjectFields` branch, after `resolveFullConfig` and `ensureFieldCache` complete but BEFORE any mutations execute. The resolved workflow state (`resolvedWorkflowState`) is already computed at that point.
- **Guard scope**: Only block when the caller is trying to SET a lock state (`resolvedWorkflowState` is in `LOCK_STATES`). Non-lock transitions (e.g., moving Done, reverting to Backlog) are exempt.
- **`projectNumber` resolution**: `resolveFullConfig` returns `{ projectNumber, projectOwner }`. Pass `projectNumber` to `getCurrentFieldValue` so it resolves against the correct project.
- **Hook contract**: `lock-claim-validator.sh` uses `RALPH_CURRENT_STATE` env var — it is NOT querying the server. After Phase 1, the server is the source of truth. Phase 3 removes the hook entry from `hooks.json` (the script file may remain as an orphan for historical reference, but it is deregistered).
- **Test pattern**: `save-issue.test.ts` uses structural source-code tests (`expect(issueToolsSrc).toContain(...)`) for integration aspects that cannot be unit-tested without a live GitHub API. The new lock guard logic CAN be unit-tested as a pure function extracted into `lib/lock-guard.ts`.
- **Spec update scope**: Only `specs/issue-lifecycle.md` Section 4 (Lock State Protocol) needs updating — specifically the enablement entry for "Agents MUST NOT claim an issue that is in a lock state". No other sections require changes.

## Current State Analysis

The `lock-claim-validator.sh` hook (registered on `PreToolUse: ralph_hero__save_issue` in `hooks.json`) currently implements lock conflict detection by reading `RALPH_CURRENT_STATE` from the process environment. Skills are expected to set this env var after calling `get_issue` before calling `save_issue` with a lock state.

This approach has two gaps:

1. **Env var dependency**: If a skill forgets to set `RALPH_CURRENT_STATE`, the hook silently allows the lock claim (see `lock-claim-validator.sh:44-47` — when `RALPH_CURRENT_STATE` is empty, the script calls `allow`).
2. **Race window**: Between the skill's `get_issue` call (which sets the env var) and the `save_issue` call, another agent could acquire the lock. The env var reflects a stale snapshot.

The MCP server already has `getCurrentFieldValue` in `lib/helpers.ts` which queries the live GitHub Projects V2 API. It also has `LOCK_STATES` in `lib/workflow-states.ts`. Both are already imported in `issue-tools.ts`. The guard requires no new infrastructure — only a single pre-mutation check.

The `save_issue` handler flow (relevant path):
1. Resolve `workflowState` to `resolvedWorkflowState` (line ~1233)
2. Handle issue-object mutations (close/reopen/metadata) (line ~1280)
3. Enter `hasProjectFields` branch (line ~1408)
   - `resolveFullConfig` → `projectNumber`, `projectOwner`
   - `ensureFieldCache`
   - `resolveProjectItemId` → `projectItemId`
   - **PROPOSED**: fetch current workflow state → block if already locked
   - Execute field mutations
4. Auto-advance parent (line ~1547)

## Desired End State

### Verification
- [ ] When `save_issue` is called with a lock-state target and the issue is already in a *different* lock state, it returns `toolError` with an actionable message (no mutation occurs)
- [ ] When `save_issue` is called with a lock-state target and the issue is already in the *same* lock state, it proceeds normally (idempotent re-lock is allowed)
- [ ] When `save_issue` is called with a lock-state target and the issue is NOT in a lock state, it proceeds normally
- [ ] When `save_issue` is called with a non-lock-state target, the guard is skipped entirely (no extra API call)
- [ ] When `save_issue(force=true)` is called, the lock guard is bypassed entirely regardless of the current state
- [ ] `lock-claim-validator.sh` is deregistered from `hooks.json` (removed from the `ralph_hero__save_issue` PreToolUse matcher)
- [ ] `specs/issue-lifecycle.md` Section 4 enablement entry for lock claim prevention reflects server-side enforcement
- [ ] All existing tests continue to pass
- [ ] New tests cover the lock guard logic: lock blocked, idempotent same-state re-lock, lock allowed from unlocked state, non-lock state bypass, force override bypass

## What We're NOT Doing

- Not deleting `lock-claim-validator.sh` from disk — deregistering from `hooks.json` is sufficient; the script stays as historical reference
- Not adding a lock guard to `batch_update` or `advance_issue` — these tools use dedicated internal helpers and do not accept external lock-state transitions directly
- Not changing the `pre-ticket-lock-validator.sh` hook on `get_issue` — that advisory context remains valuable for skills that list or pick issues
- Not refactoring `LOCK_STATES` or `getCurrentFieldValue` — they are correct as-is
- Not updating any skill prompts to remove `RALPH_CURRENT_STATE` references — that is a separate cleanup

## Implementation Approach

Phase 1 adds the guard logic, including the `force: boolean` parameter and same-state idempotency in `isLockConflict`. Phase 2 adds tests before Phase 1 lands (TDD: tests written against the extracted pure function). Phase 3 removes the now-redundant hook registration. Phase 4 updates the spec. All four phases are staged for a single PR, with Phase 2 tests verifying Phase 1's behavior.

The guard is extracted as a pure helper function `isLockConflict(currentState: string | undefined, targetState: string): boolean` in `lib/lock-guard.ts`. This makes it trivially unit-testable without mocking GitHub API calls. The `save_issue` handler calls `getCurrentFieldValue` then passes the result to `isLockConflict`. The entire guard block is wrapped in `if (!args.force)` so that callers with `force=true` bypass both the `getCurrentFieldValue` call and the conflict check.

---

## Phase 1: Server-Side Lock Guard in save_issue (GH-652)

### Overview

Add a live lock conflict check to `save_issue` that fetches the current workflow state via `getCurrentFieldValue` and returns `toolError` if the issue is already locked and the caller is trying to acquire a lock state.

### Tasks

#### Task 1.1: Create lib/lock-guard.ts with pure isLockConflict function
- **files**: `plugin/ralph-hero/mcp-server/src/lib/lock-guard.ts` (create)
- **tdd**: true
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] File exists at `plugin/ralph-hero/mcp-server/src/lib/lock-guard.ts`
  - [ ] Exports `function isLockConflict(currentState: string | undefined, targetState: string): boolean`
  - [ ] Returns `false` when `currentState === targetState` — same-state re-lock is idempotent and always allowed; this check comes FIRST, before any `LOCK_STATES.includes()` check (e.g., `isLockConflict("In Progress", "In Progress")` returns `false`)
  - [ ] Returns `true` when `currentState` and `targetState` are both in `LOCK_STATES` AND they differ (e.g., current="Research in Progress", target="Plan in Progress")
  - [ ] Returns `false` when `currentState` is undefined or empty string
  - [ ] Returns `false` when `targetState` is NOT in `LOCK_STATES` (non-lock transitions bypass the guard)
  - [ ] Returns `false` when `currentState` is NOT in `LOCK_STATES` (issue not currently locked)
  - [ ] Imports `LOCK_STATES` from `../lib/workflow-states.js`
  - [ ] Uses `.includes()` for membership checks (no external dependencies beyond workflow-states)

#### Task 1.2: Add force parameter to save_issue schema
- **files**: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] The `save_issue` Zod schema includes `force: z.boolean().optional().describe("When true, bypass the lock guard and allow writing to any workflow state regardless of current lock status")`
  - [ ] `force` defaults to `false` when not provided (no behavioral change for existing callers)
  - [ ] `tsc` compiles without errors after the schema change

#### Task 1.3: Integrate lock guard into save_issue handler
- **files**: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts` (modify), `plugin/ralph-hero/mcp-server/src/lib/lock-guard.ts` (read)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [1.1, 1.2]
- **acceptance**:
  - [ ] `issue-tools.ts` imports `isLockConflict` from `"../lib/lock-guard.js"`
  - [ ] `issue-tools.ts` imports `getCurrentFieldValue` from `"../lib/helpers.js"` (already imported — verify it's in the import list)
  - [ ] The entire lock guard block is wrapped in `if (!args.force)` as the outermost condition — when `force=true`, neither `getCurrentFieldValue` nor `isLockConflict` is called
  - [ ] Inside the `!args.force` branch, and ONLY when `resolvedWorkflowState` is in `LOCK_STATES`, the handler calls `getCurrentFieldValue(client, fieldCache, owner, repo, args.number, "Workflow State", projectNumber)` to fetch the current state
  - [ ] The result is passed to `isLockConflict(currentWorkflowState, resolvedWorkflowState)`
  - [ ] If `isLockConflict` returns `true`, the handler returns `toolError` with a message matching the template: `Issue #NNN is locked in '{currentState}'. Another agent has exclusive ownership.\nUse save_issue with force=true to override, or wait for the lock holder to release.`
  - [ ] If `isLockConflict` returns `false`, execution continues unchanged (no behavior change for non-conflicts)
  - [ ] The `getCurrentFieldValue` call is NOT made when `resolvedWorkflowState` is undefined or not in `LOCK_STATES` (avoid unnecessary API roundtrip)
  - [ ] `tsc` compiles the modified `issue-tools.ts` without errors

**Creates for next phase**: `lib/lock-guard.ts` with exported `isLockConflict` function, and `issue-tools.ts` containing the `force` parameter, `!args.force` guard, and integration pattern (used by Phase 2 structural tests).

### Phase Success Criteria

#### Automated Verification:
- [ ] `cd plugin/ralph-hero/mcp-server && npm run build` — no TypeScript errors
- [ ] `cd plugin/ralph-hero/mcp-server && npm test` — all existing tests pass (0 new failures)

#### Manual Verification:
- [ ] `grep -n "isLockConflict" plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts` — shows the import and call site
- [ ] `grep -n "getCurrentFieldValue" plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts` — shows usage in save_issue handler
- [ ] `grep -n "args.force" plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts` — shows the force bypass condition
- [ ] `grep -n "z.boolean" plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts` — shows force parameter in schema

---

## Phase 2: Unit Tests for Lock Guard (GH-653)

### Overview

Write unit tests for `isLockConflict` (pure function tests) and structural tests verifying the integration in `save_issue`.

### Tasks

#### Task 2.1: Unit tests for isLockConflict pure function
- **files**: `plugin/ralph-hero/mcp-server/src/__tests__/lock-guard.test.ts` (create)
- **tdd**: true
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] File exists at `plugin/ralph-hero/mcp-server/src/__tests__/lock-guard.test.ts`
  - [ ] Imports `isLockConflict` from `"../lib/lock-guard.js"`
  - [ ] Imports `LOCK_STATES` from `"../lib/workflow-states.js"`
  - [ ] Test: `isLockConflict("Research in Progress", "Plan in Progress")` returns `true` (current locked, target different lock)
  - [ ] Test: `isLockConflict("Plan in Progress", "Research in Progress")` returns `true` (any cross-lock transition blocked)
  - [ ] Test: `isLockConflict("In Progress", "Research in Progress")` returns `true` (cross-lock transition blocked)
  - [ ] Test: `isLockConflict("In Progress", "In Progress")` returns `false` (same-state re-lock is idempotent — ALLOWED)
  - [ ] Test: `isLockConflict("Research in Progress", "Research in Progress")` returns `false` (same-state re-lock is idempotent — ALLOWED)
  - [ ] Test: `isLockConflict("Plan in Progress", "Plan in Progress")` returns `false` (same-state re-lock is idempotent — ALLOWED)
  - [ ] Test: `isLockConflict(undefined, "In Progress")` returns `false` (unknown current state allows claim)
  - [ ] Test: `isLockConflict("", "In Progress")` returns `false` (empty current state allows claim)
  - [ ] Test: `isLockConflict("Research Needed", "Research in Progress")` returns `false` (non-locked current state allows acquisition)
  - [ ] Test: `isLockConflict("Ready for Plan", "Plan in Progress")` returns `false` (non-locked current state allows acquisition)
  - [ ] Test: `isLockConflict("Research in Progress", "Ready for Plan")` returns `false` (non-lock target bypasses guard)
  - [ ] Test: `isLockConflict("In Progress", "Done")` returns `false` (non-lock target bypasses guard)
  - [ ] All tests pass via `npm test`

#### Task 2.2: Structural tests for save_issue lock guard integration
- **files**: `plugin/ralph-hero/mcp-server/src/__tests__/save-issue.test.ts` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [2.1]
- **acceptance**:
  - [ ] A new `describe("save_issue lock guard integration")` block is added to `save-issue.test.ts`
  - [ ] Test: `issueToolsSrc` contains `"isLockConflict"` (verifies import and call site present)
  - [ ] Test: `issueToolsSrc` contains `"getCurrentFieldValue"` (verifies the API call is present in the handler)
  - [ ] Test: `issueToolsSrc` contains `"force=true to override"` or the exact error message template wording (verifies error message includes force override guidance)
  - [ ] Test: `issueToolsSrc` contains `import { isLockConflict }` (verifies the import from lock-guard)
  - [ ] Test: `issueToolsSrc` contains `"!args.force"` or `"args.force"` (verifies the outermost force bypass condition is present)
  - [ ] Test: `issueToolsSrc` contains `z.boolean` in the save_issue schema section (verifies force parameter is in the schema)
  - [ ] All new tests pass via `npm test`

**Creates for next phase**: No artifacts. Phase 3 is a hook deregistration that proceeds independently once Phase 1+2 are complete.

### Phase Success Criteria

#### Automated Verification:
- [ ] `cd plugin/ralph-hero/mcp-server && npm test` — all tests pass, including the new lock-guard.test.ts and the new structural tests in save-issue.test.ts

#### Manual Verification:
- [ ] `npx vitest run src/__tests__/lock-guard.test.ts` — all tests pass individually
- [ ] Test count for `lock-guard.test.ts` shows at least 12 tests (including 3 same-state idempotency cases)

---

## Phase 3: Remove lock-claim-validator Hook Registration (GH-654)

### Overview

Deregister `lock-claim-validator.sh` from `hooks.json`. The server-side lock guard in Phase 1 makes this client-side hook redundant. The script file stays on disk for historical reference.

### Tasks

#### Task 3.1: Remove lock-claim-validator.sh from hooks.json PreToolUse matcher
- **files**: `plugin/ralph-hero/hooks/hooks.json` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] The entry `"${CLAUDE_PLUGIN_ROOT}/hooks/scripts/lock-claim-validator.sh"` is removed from the `PreToolUse` `ralph_hero__save_issue` matcher's `hooks` array
  - [ ] The remaining hooks in that matcher (`pre-github-validator.sh`, `artifact-discovery.sh`, `human-needed-outbound-block.sh`) are preserved and their order is unchanged
  - [ ] `hooks.json` remains valid JSON: `jq . plugin/ralph-hero/hooks/hooks.json > /dev/null` exits 0
  - [ ] No other hook entries are modified

### Phase Success Criteria

#### Automated Verification:
- [ ] `jq . plugin/ralph-hero/hooks/hooks.json > /dev/null` — valid JSON
- [ ] `grep "lock-claim-validator" plugin/ralph-hero/hooks/hooks.json` — exits non-zero (entry removed)

#### Manual Verification:
- [ ] `jq '.hooks.PreToolUse[] | select(.matcher == "ralph_hero__save_issue") | .hooks[].command' plugin/ralph-hero/hooks/hooks.json` — lists 3 hooks (not 4)
- [ ] `ls plugin/ralph-hero/hooks/scripts/lock-claim-validator.sh` — file still exists on disk (not deleted)

---

## Phase 4: Update issue-lifecycle Spec (GH-655)

### Overview

Update `specs/issue-lifecycle.md` Section 4 (Lock State Protocol) to reflect that lock conflict prevention is now enforced server-side in `save_issue`, not via the client-side hook.

### Tasks

#### Task 4.1: Update Section 4 enablement entry in specs/issue-lifecycle.md
- **files**: `specs/issue-lifecycle.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] The line `| Agents MUST NOT claim an issue that is in a lock state | \`[x]\` \`lock-claim-validator.sh\` (blocks save_issue when RALPH_CURRENT_STATE is a lock state) |` is replaced with a line reflecting server-side enforcement
  - [ ] The new enablement entry reads: `\`[x]\` \`save_issue\` server-side guard (fetches current workflow state via \`getCurrentFieldValue\`, returns \`toolError\` when target is a lock state and issue is already locked)`
  - [ ] All other content in `specs/issue-lifecycle.md` is preserved unchanged
  - [ ] The file remains valid Markdown (no broken tables)

### Phase Success Criteria

#### Automated Verification:
- [ ] `grep "lock-claim-validator.sh" specs/issue-lifecycle.md` — exits non-zero (old reference removed)
- [ ] `grep "getCurrentFieldValue" specs/issue-lifecycle.md` — exits 0 (new reference present)

#### Manual Verification:
- [ ] Section 4 table renders correctly in a Markdown previewer
- [ ] The enablement checkbox `[x]` is marked complete (enforcement exists)

---

## Integration Testing
- [ ] Build and test the MCP server after all phases: `cd plugin/ralph-hero/mcp-server && npm run build && npm test`
- [ ] Verify `hooks.json` is valid JSON with 3 (not 4) hooks on the save_issue matcher
- [ ] Verify `specs/issue-lifecycle.md` Section 4 no longer references `lock-claim-validator.sh`
- [ ] Verify `lock-guard.test.ts` passes in isolation: `npx vitest run src/__tests__/lock-guard.test.ts`

## References
- GH-652: [https://github.com/cdubiel08/ralph-hero/issues/652](https://github.com/cdubiel08/ralph-hero/issues/652)
- GH-653: [https://github.com/cdubiel08/ralph-hero/issues/653](https://github.com/cdubiel08/ralph-hero/issues/653)
- GH-654: [https://github.com/cdubiel08/ralph-hero/issues/654](https://github.com/cdubiel08/ralph-hero/issues/654)
- GH-655: [https://github.com/cdubiel08/ralph-hero/issues/655](https://github.com/cdubiel08/ralph-hero/issues/655)
- Lock guard helper: [plugin/ralph-hero/mcp-server/src/lib/helpers.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/helpers.ts) (`getCurrentFieldValue`)
- Workflow states: [plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts) (`LOCK_STATES`)
- Issue tools: [plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts) (save_issue handler)
- Existing hook: [plugin/ralph-hero/hooks/scripts/lock-claim-validator.sh](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/lock-claim-validator.sh)
- Hooks registry: [plugin/ralph-hero/hooks/hooks.json](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/hooks.json)
- Existing tests: [plugin/ralph-hero/mcp-server/src/__tests__/save-issue.test.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/__tests__/save-issue.test.ts)
- Issue lifecycle spec: [specs/issue-lifecycle.md](https://github.com/cdubiel08/ralph-hero/blob/main/specs/issue-lifecycle.md)
