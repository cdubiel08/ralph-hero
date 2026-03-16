---
date: 2026-03-04
topic: "GH-515: ralph-triage split path should set workflowState: Backlog on child issues"
tags: [research, ralph-triage, workflow-states, state-machine, skills, split]
status: complete
type: research
github_issue: 515
github_url: https://github.com/cdubiel08/ralph-hero/issues/515
---

# Research: GH-515 — `ralph-triage` Split Path workflowState Fix

## Summary

When `ralph-triage` splits an issue, child issues are created with only `estimate` set — no `workflowState`. This leaves them invisible to the triage pipeline. The fix is a one-line addition to the SPLIT path in [`plugin/ralph-hero/skills/ralph-triage/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-triage/SKILL.md).

## Problem Confirmed

The audit research doc (`thoughts/shared/research/2026-03-03-GH-0000-state-machine-transition-audit.md`) identified this gap explicitly. The triage SPLIT path at lines ~187-209 creates sub-issues with:
```
ralph_hero__create_issue(title=..., body=...)
ralph_hero__add_sub_issue(parentNumber=..., childNumber=...)
ralph_hero__save_issue(number=..., estimate="XS")
```
No `workflowState` is set. These children are invisible to the next triage pass because `ralph-triage` queries for `workflowState: "Backlog"`.

## Code Location

[`skills/ralph-triage/SKILL.md:185-209`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-triage/SKILL.md#L185-L209) — the "If no children exist" branch of Step 5 (SPLIT action):

```markdown
3. Set estimate:
   ```
   ralph_hero__save_issue
   - number: [new-issue-number]
   - estimate: "XS"
   ```
```

**Fix**: Add `workflowState: "Backlog"` to this `save_issue` call.

## Reference Implementation

`ralph-split` (the dedicated split skill) correctly sets workflowState on sub-issues. The triage SPLIT path should match this behavior. The parent issue stays in its current state (Backlog), while children should explicitly enter at Backlog so they're visible to the next triage pass.

## Implementation Approach

**Simple**: Add `- workflowState: "Backlog"` to the `save_issue` call in the SPLIT path. One line change in one file.

**Scope**: Only the "If no children exist" path at Step 5 needs updating. The "If children already exist" path doesn't create new issues so no change needed there.

**Why not `__COMPLETE__`**: The semantic intent `__COMPLETE__` with `command="ralph_triage"` is valid but unnecessarily complex. `"Backlog"` is a direct valid state. `ralph_triage`'s `COMMAND_ALLOWED_STATES` permits `"Research Needed"` and `"Done"` as output states, not `"Backlog"`, so a direct state name without `command` is the right approach.

## Files to Change

| File | Location | Change |
|------|----------|--------|
| `plugin/ralph-hero/skills/ralph-triage/SKILL.md` | Line ~205-208 (SPLIT path `save_issue` in Step 5) | Add `- workflowState: "Backlog"` |

## No Risk Areas

- SKILL.md change only — no compiled code affected
- Hook validation: `triage-state-gate.sh` validates `save_issue` calls, but only when `command="ralph_triage"` is used. Setting a direct `"Backlog"` state without the command param bypasses triage-specific command validation (but passes general state validation).
- No test changes required

## Files Affected

### Will Modify

- `plugin/ralph-hero/skills/ralph-triage/SKILL.md` — add `workflowState: "Backlog"` to `save_issue` call in SPLIT path (lines ~205-208)

### Will Read (Dependencies)

- `plugin/ralph-hero/skills/ralph-split/SKILL.md` — reference implementation for workflowState on sub-issues
- `thoughts/shared/research/2026-03-03-GH-0000-state-machine-transition-audit.md` — audit context

## Related Issues

- #514: Same gap in `form-idea` skill (single issue and ticket tree paths)
- #516: Latent gap in `create_issue` MCP handler Status sync
