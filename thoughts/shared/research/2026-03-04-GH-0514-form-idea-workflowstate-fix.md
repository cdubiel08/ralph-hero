---
date: 2026-03-04
topic: "GH-514: form-idea should set workflowState: Backlog on created issues"
tags: [research, form-idea, workflow-states, state-machine, skills]
status: complete
type: research
github_issue: 514
github_url: https://github.com/cdubiel08/ralph-hero/issues/514
---

# Research: GH-514 — `form-idea` workflowState Fix

## Summary

`form-idea` creates GitHub issues without setting `workflowState`, causing them to land on the project board in a stateless limbo invisible to `ralph-triage`. The fix is a one-line addition in three places in [`plugin/ralph-hero/skills/form-idea/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/form-idea/SKILL.md).

## Problem Confirmed

The audit research doc (`thoughts/shared/research/2026-03-03-GH-0000-state-machine-transition-audit.md`) confirmed this gap. `form-idea` has three issue creation paths, all of which call `save_issue` with only `estimate` — never `workflowState`.

The `ralph-triage` skill queries issues via `profile: "analyst-triage"` which expands to `workflowState: "Backlog"`. Issues without a workflowState are invisible to this query.

## Code Locations

### Path 1: Single Issue (Step 5a)

[`skills/form-idea/SKILL.md:159-172`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/form-idea/SKILL.md#L159-L172):

```markdown
   ralph_hero__create_issue
   - owner: $RALPH_GH_OWNER
   - repo: $RALPH_GH_REPO
   - title: [title]
   - body: [description]
   ```

   Then set the estimate:
   ```
   ralph_hero__save_issue
   - number: [created issue number]
   - estimate: "XS"  (or S/M/L/XL as appropriate)
   ```
```

**Fix**: Add `workflowState: "Backlog"` to the `save_issue` call.

### Path 2: Ticket Tree Parent (Step 5b, part a)

[`skills/form-idea/SKILL.md:214-217`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/form-idea/SKILL.md#L214-L217):

```markdown
   a. Create the parent issue:
   ```
   ralph_hero__create_issue(title=..., body=...)
   ralph_hero__save_issue(number=..., estimate="L")
   ```
```

**Fix**: Add `workflowState: "Backlog"` to the parent `save_issue` call.

### Path 3: Ticket Tree Children (Step 5b, part b)

[`skills/form-idea/SKILL.md:220-225`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/form-idea/SKILL.md#L220-L225):

```markdown
   b. Create each child issue:
   ```
   ralph_hero__create_issue(title=..., body=...)
   ralph_hero__add_sub_issue(parentNumber=..., childNumber=...)
   ralph_hero__save_issue(number=..., estimate="XS")
   ```
```

**Fix**: Add `workflowState: "Backlog"` to the child `save_issue` call.

## Reference Implementation

`ralph-split` already does this correctly. From [`skills/ralph-split/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-split/SKILL.md) (lines ~197-230):
```
ralph_hero__save_issue(number=..., estimate="XS", workflowState="Backlog")
```
or via `__COMPLETE__` semantic intent with `command="ralph_split"`.

## Implementation Approach

**Simple**: Add `workflowState: "Backlog"` to each of the three `save_issue` calls in `form-idea/SKILL.md`. No code changes needed — this is a pure markdown skill prompt update.

**Why not `create_issue`**: The `create_issue` MCP tool supports a `workflowState` parameter, but passing it there would bypass the `save_issue` validation pipeline. Using `save_issue` for state transitions is the established convention.

**Why `"Backlog"` specifically**: All new user-created issues should enter the pipeline at Backlog, the first triage stage. This matches `ralph-split`'s behavior and the intended pipeline entry point.

## Files to Change

| File | Location | Change |
|------|----------|--------|
| `plugin/ralph-hero/skills/form-idea/SKILL.md` | Line ~170 (single issue `save_issue`) | Add `- workflowState: "Backlog"` |
| `plugin/ralph-hero/skills/form-idea/SKILL.md` | Line ~217 (ticket tree parent `save_issue`) | Add `- workflowState: "Backlog"` |
| `plugin/ralph-hero/skills/form-idea/SKILL.md` | Line ~224 (ticket tree children `save_issue`) | Add `- workflowState: "Backlog"` |

## No Risk Areas

- SKILL.md changes only affect prompt behavior, not compiled code
- No hook or validation changes needed
- `workflowState: "Backlog"` is a valid direct state (not a semantic intent), so no `command` parameter needed
- No test changes required

## Files Affected

### Will Modify

- `plugin/ralph-hero/skills/form-idea/SKILL.md` — add `workflowState: "Backlog"` to three `save_issue` calls (lines ~170, ~217, ~224)

### Will Read (Dependencies)

- `plugin/ralph-hero/skills/ralph-split/SKILL.md` — reference implementation for workflowState on sub-issues
- `thoughts/shared/research/2026-03-03-GH-0000-state-machine-transition-audit.md` — audit context

## Related Issues

- #515: Same gap in `ralph-triage` SPLIT path
- #516: Latent gap in `create_issue` MCP handler Status sync
