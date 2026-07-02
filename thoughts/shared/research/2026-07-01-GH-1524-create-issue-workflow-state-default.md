---
date: 2026-07-01
github_issue: 1524
github_url: https://github.com/cdubiel08/ralph-hero/issues/1524
topic: "create_issue silently leaves Workflow State null — default to \"Backlog\" when omitted"
tags: [research, mcp-tools, issue-tools, workflow-state, field-defaults]
status: complete
type: research
---

# Research: `create_issue` silently leaves Workflow State null — default to "Backlog" when omitted

## Prior Work

- builds_on:: [[2026-03-04-GH-0516-create-issue-status-sync]] (plan — added the `syncStatusField` call on the create path, but only inside the `if (args.workflowState)` block; GH-1524 closes the remaining gap)
- builds_on:: [[2026-03-04-group-GH-0514-skill-workflowstate-enforcement]] (plan — enforced `workflowState: "Backlog"` in skill prose, which is exactly the layer direct MCP callers bypass)

## Research Question

`create_issue` only writes the Workflow State field when the caller passes it, with no default and no warning. Any caller invoking the MCP tool directly (outside the `ralph:form` skill whose prose mandates `workflowState: "Backlog"`) creates board items invisible to `next_actions(audience='human')` and untracked by hygiene. Fix: mirror the `effectiveEstimate` pattern and default to `"Backlog"`.

## Summary

The issue's claim is confirmed at every point. The `create_issue` handler (`mcp-server/src/tools/issue-tools.ts:931-1181`) gates the Workflow State field write behind `if (args.workflowState)` at `issue-tools.ts:1124-1140` — no `else`, no fallback, no warning — and `fieldsSet.workflowState` echoes the raw arg (`args.workflowState || null`) at `issue-tools.ts:1164-1175`, so omission is reported but never corrected. The `effectiveEstimate` pattern the issue cites as the model lives in the same handler at `issue-tools.ts:977-993`; note it defaults only from repo-registry `mergeDefaults`, whose type (`repo-registry.ts:273-276`) has no `workflowState` field, so a simple `args.workflowState ?? "Backlog"` local default (not a registry merge) is the closest faithful mirror. `"Backlog"` exists only as a state-machine constant (`workflow-states.ts:12`, first entry of `STATE_ORDER`, maps to Status `"Todo"` at `workflow-states.ts:134`) — nothing assigns it automatically today.

One design consideration surfaced: if a target project's Workflow State field has no option literally named `"Backlog"` (exact-string lookup, `cache.ts:188-195`), `updateProjectItemField` throws (`helpers.ts:313-320`) *after* the issue is already created and added to the project, and the handler's outer catch converts the whole call to `toolError` (`issue-tools.ts:1176-1178`). Defaulting therefore turns today's silently-successful stateless creates on such projects into reported failures with an orphan issue behind them — the plan should decide strict vs. best-effort semantics for the defaulted write (explicit values should stay strict to preserve current behavior).

## Detailed Findings

### The gap: `create_issue` Workflow State handling

- Tool `ralph_hero__create_issue` registered at `mcp-server/src/tools/issue-tools.ts:931-1181`; `workflowState` is declared optional with no default in the zod schema (`issue-tools.ts:952-955`).
- Field write is conditional (`issue-tools.ts:1124-1140`):

  ```ts
  // Step 5: Set field values
  if (args.workflowState) {
    await updateProjectItemField(client, fieldCache, projectItemId,
      "Workflow State", args.workflowState, projectNumber);
    await syncStatusField(client, fieldCache, projectItemId,
      args.workflowState, projectNumber);
  }
  ```

  When `args.workflowState` is falsy the block is skipped entirely — the fresh project item keeps GitHub's unset/null single-select value.
- Response reporting (`issue-tools.ts:1164-1175`): `fieldsSet.workflowState: args.workflowState || null`. The defaulted fix must also switch this to report the effective value per the acceptance criteria.
- `syncStatusField` (GH-516's addition) only runs inside the same conditional, so omitted-state items also never get the Status=Todo sync.

### The pattern to mirror: `effectiveEstimate`

- `let effectiveEstimate = args.estimate` plus optional repo-registry merge at `issue-tools.ts:977-993`; consumed via `if (effectiveEstimate)` at `issue-tools.ts:1142-1151`; reported as `estimate: effectiveEstimate || null` (`issue-tools.ts:1172`).
- `mergeDefaults` (`mcp-server/src/lib/repo-registry.ts:272-300`) handles only `labels`/`assignees`/`estimate` — there is structurally no registry default for `workflowState`. The faithful mirror is `const effectiveState = args.workflowState ?? "Backlog"` declared alongside the other `effective*` locals, with the Step-5 block switched to use it unconditionally.

### Write mechanics and failure mode

- `updateProjectItemField` (`mcp-server/src/lib/helpers.ts:295-335`) resolves project ID → field ID → option ID via `FieldOptionCache`; a missing option name throws `Option "X" not found for field "Workflow State"` (`helpers.ts:313-320`).
- `FieldOptionCache.resolveOptionId` is an exact-string map lookup (`mcp-server/src/lib/cache.ts:188-195`) — no fuzzy matching.
- The handler's outer try/catch (`issue-tools.ts:1176-1178`) returns `toolError("Failed to create issue: ...")`, but Steps 3–4 (issue creation `issue-tools.ts:1041-1075`, project add `issue-tools.ts:1096-1112`) have already run — no rollback. This partial-failure shape already exists today for explicit bad state names; defaulting extends the exposure to all plain `create_issue` calls on projects lacking a "Backlog" option.
- `syncStatusField` (`mcp-server/src/lib/helpers.ts:650-678`) is best-effort by design: missing mapping / field / option → early return; its inner update is wrapped in try/catch. Safe to call unconditionally with the defaulted value; `WORKFLOW_STATE_TO_STATUS["Backlog"] === "Todo"` (`workflow-states.ts:133-145`).

### Adjacent create paths (out of scope, for completeness)

- `create_draft_issue` (`mcp-server/src/tools/project-management-tools.ts:44-140`) has the same conditional gate (`project-management-tools.ts:92-95`) and never calls `syncStatusField` even when state is passed.
- `convert_draft_issue` (`project-management-tools.ts:201-262`) never touches the field (the GraphQL mutation takes only `itemId`/`repositoryId`).
- `save_issue` has no Backlog default either (state resolution at `issue-tools.ts:1236-1254`, reverse-close inference at `issue-tools.ts:1283-1291`) — intentional: it mutates existing items and defaulting there would clobber real states. GH-1524 scopes to `create_issue` only; the belt-and-braces nets are filed separately (GH-1525 hygiene fieldGap, GH-1526 next_actions aggregate direction).

### Test patterns for the required unit test

- Closest model: `mcp-server/src/__tests__/cross-tool-consistency.test.ts:306-317` (`getTool` handler extraction via `_registeredTools`), `:434-489` (register → invoke → `parsePayload` → assert).
- Mock shapes: sequential-response mock `GitHubClient` + `FieldOptionCache.populate(3, "project-id-123", [{ id, name: "Workflow State", options: [{ id: "opt-backlog", name: "Backlog" }, ...] }])` per `mcp-server/src/__tests__/auto-advance-parent.test.ts:81-139`.
- The new test: invoke `create_issue` with no `workflowState`, assert the Workflow State field mutation fired with the Backlog option and `fieldsSet.workflowState === "Backlog"`; a companion assertion that an explicit value still wins.

## Code References

- `mcp-server/src/tools/issue-tools.ts:952-955` — `workflowState` zod schema (optional, no default)
- `mcp-server/src/tools/issue-tools.ts:977-993` — `effectiveEstimate` pattern to mirror
- `mcp-server/src/tools/issue-tools.ts:1124-1140` — the conditional Workflow State write + `syncStatusField`
- `mcp-server/src/tools/issue-tools.ts:1164-1175` — `fieldsSet` response (must report defaulted value)
- `mcp-server/src/tools/issue-tools.ts:1176-1178` — outer catch; partial-failure surface
- `mcp-server/src/lib/helpers.ts:295-335` — `updateProjectItemField` (throws on unknown option)
- `mcp-server/src/lib/helpers.ts:650-678` — `syncStatusField` (best-effort)
- `mcp-server/src/lib/workflow-states.ts:12` — `"Backlog"` = `STATE_ORDER[0]`
- `mcp-server/src/lib/workflow-states.ts:133-145` — `WORKFLOW_STATE_TO_STATUS` (`Backlog → Todo`)
- `mcp-server/src/lib/cache.ts:188-195` — exact-string option lookup
- `mcp-server/src/lib/repo-registry.ts:272-300` — `mergeDefaults` (no `workflowState` support)

## Architecture Documentation

The handler already uses an `effective*` local-variable convention for arg-with-default resolution (`effectiveLabels` / `effectiveAssignees` / `effectiveEstimate`), and `fieldsSet` reports effective values. The fix extends both conventions to `workflowState` without introducing new structure. Status-field sync is one-way, best-effort, and shared between create (`syncStatusField` helper) and save (inlined batch) paths.

## Historical Context (from thoughts/)

- `thoughts/shared/plans/2026-03-04-GH-0516-create-issue-status-sync.md` — added `syncStatusField()` on the create path; explicitly noted "currently no skill passes workflowState to create_issue" as a latent inconsistency.
- `thoughts/shared/plans/2026-03-04-group-GH-0514-skill-workflowstate-enforcement.md` — pushed `workflowState: "Backlog"` mandates into skill prose (`ralph/skills/form/SKILL.md:132`), the prose-only enforcement layer whose bypass caused the 2026-07-01 incident (27 stateless meta-plan issues from a direct-MCP research session).

## Related Research

- `thoughts/shared/plans/2026-05-12-GH-1169-list-issues-state-default-alignment.md` — prior alignment of state-visibility defaults across the dashboard family (same "invisible items" failure class).

## Open Questions

- Strict vs. best-effort for the *defaulted* write: should a missing "Backlog" option fail the call (current explicit-value behavior) or degrade to a warning in the response? Recommendation for the plan: keep explicit values strict (unchanged), make the defaulted write strict too for simplicity — projects created by `setup_project` always have "Backlog", and a loud failure beats silent statelessness, which is the bug being fixed. Worth a one-line decision in the plan.

## Files Affected

### Will Modify
- `mcp-server/src/tools/issue-tools.ts` — default `workflowState` to `"Backlog"` via `effectiveState` local; always run the Step-5 Workflow State write + `syncStatusField`; report the effective value in `fieldsSet`
- `mcp-server/src/__tests__/issue-tools.test.ts` — unit test for the defaulted path (and explicit-value-wins)

### Will Read (Dependencies)
- `mcp-server/src/lib/helpers.ts` — `updateProjectItemField` / `syncStatusField` behavior
- `mcp-server/src/lib/workflow-states.ts` — `"Backlog"` constant + Status mapping
- `mcp-server/src/lib/cache.ts` — `FieldOptionCache` option resolution
- `mcp-server/src/__tests__/cross-tool-consistency.test.ts` — handler-invocation test pattern
- `mcp-server/src/__tests__/auto-advance-parent.test.ts` — mock client / field-cache fixtures
