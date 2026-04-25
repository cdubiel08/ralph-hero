---
type: eval-scenarios
skill: iterate
date: 2026-04-25
---

# Eval Scenarios — iterate skill

These scenarios define grading criteria for the `iterate` skill. Each scenario specifies an Input, the Expected Behavior, and explicit Assertions a reviewer (human or automated grader) can check. Execution of these scenarios is tracked separately; this file is the rubric.

## Scenario A: Iterate via #NNN with comment-discovered plan

### Input

User invokes the skill with an issue number and feedback:

```
/ralph-hero:iterate #347 add a phase for migration handling between legacy and new schemas
```

Issue #347 is in workflow state "Plan in Review" and has a comment with the header `## Implementation Plan` followed by a GitHub URL pointing at `thoughts/shared/plans/2026-04-10-GH-0347-streaming-pipeline.md`. The plan file exists locally with three phases.

### Expected Behavior

1. Skill matches the `#347` argument and runs Plan Resolution Step 1.
2. Optional: knowledge-graph shortcut returns no high-confidence hit (or is unavailable). Skill falls back to comment search.
3. Skill calls `get_issue` for #347, finds the `## Implementation Plan` comment, extracts the GitHub URL, strips the `https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/` prefix, and reads the local plan file.
4. Plan Resolution Step 2 detects the issue is "Plan in Review" — skill offers (via `AskUserQuestion`) to transition the issue to "Plan in Progress" with `command: "iterate_plan"`. User confirms. Skill calls `save_issue` to update the workflow state.
5. Skill proceeds to Initial Response with both the plan path AND the feedback already parsed.
6. Skill reads the existing plan FULLY (no limit/offset).
7. Skill confirms the requested change (Step 3 — Present Understanding and Approach), gets user confirmation.
8. Skill makes surgical Edit calls to add the new phase, preserving `tags`, `type`, and `## Prior Work` sections.
9. Skill posts a `## Plan Updated` comment on issue #347 with the change summary and reason.

### Assertions

- [ ] Skill calls `get_issue` exactly once for #347.
- [ ] Skill extracts the most-recent `## Implementation Plan` comment (not the first one if multiple exist).
- [ ] Skill calls `save_issue` with `workflowState: "Plan in Progress"` and `command: "iterate_plan"` BEFORE making edits.
- [ ] Skill reads the existing plan file FULLY before editing.
- [ ] All plan edits use `Edit` tool (surgical), not `Write` (wholesale rewrite).
- [ ] Skill does NOT remove `tags`, `type`, or `## Prior Work` from the plan frontmatter or body.
- [ ] Skill posts exactly one `## Plan Updated` comment to #347 via `create_comment`.
- [ ] Final report mentions both the issue URL and the workflow state transition.

## Scenario B: Iterate via direct path arg (self-heal missing artifact comment)

### Input

User invokes the skill with a direct plan path and feedback:

```
/ralph-hero:iterate thoughts/shared/plans/2026-04-12-GH-0412-feature-flags.md change the success criteria to require performance regression tests
```

The plan file exists, has `github_issue: 412` in frontmatter, and is in good shape. Issue #412 is in "Plan in Progress" state. NO `## Implementation Plan` comment exists on #412 (the artifact link was never posted).

### Expected Behavior

1. Skill matches the file-path argument and runs Plan Resolution "If first argument is a file path" branch.
2. Skill verifies the file exists and reads frontmatter — finds `github_issue: 412`.
3. Plan Resolution Step 2 detects the issue is "Plan in Progress" — SKIPS the state transition (already in correct state per the SKILL.md condition).
4. Skill proceeds to Initial Response.
5. Skill reads the plan FULLY and parses the user's feedback ("change success criteria to require performance regression tests").
6. Skill determines no codebase research is needed (Step 2 — only spawn research if changes require new technical understanding).
7. Skill confirms understanding (Step 3) and gets approval.
8. Skill makes surgical Edit to the success criteria section, adding the performance regression test requirement to "Automated Verification".
9. Skill posts `## Plan Updated` comment on #412.

### Assertions

- [ ] Skill correctly takes the file-path branch (does NOT call `get_issue` for issue lookup as the primary resolution).
- [ ] Skill reads the plan frontmatter to discover the linked issue.
- [ ] Skill does NOT call `save_issue` for a state transition (issue is already in "Plan in Progress").
- [ ] Skill does NOT spawn unnecessary research sub-agents for a simple criteria change.
- [ ] Edit preserves the two-category success criteria structure (Automated + Manual).
- [ ] `## Plan Updated` comment is posted on #412 with the change summary and the user's reason ("require performance regression tests").
- [ ] Skill does NOT trigger the artifact self-heal path (that path is only in `ralph-impl`, not `iterate`'s primary resolution).

## Scenario C: Plan-not-found hard stop

### Input

User invokes the skill with an issue number that has no plan:

```
/ralph-hero:iterate #999 add an extra phase
```

Issue #999 exists and is in workflow state "Backlog". It has no comments at all. The local glob `thoughts/shared/plans/*GH-999*` and `thoughts/shared/plans/*GH-0999*` return no matches.

### Expected Behavior

1. Skill matches the `#999` argument and runs Plan Resolution Step 1.
2. Knowledge-graph shortcut (if available) returns no result.
3. Skill calls `get_issue` for #999 — issue exists but no `## Implementation Plan` comment is found.
4. Skill takes the fallback branch and globs for the plan file. Both padded and unpadded patterns return no matches.
5. Skill takes the "If no plan found" branch and STOPS with: "No implementation plan found for #999. Run /ralph-hero:plan first."
6. Skill does NOT prompt the user to keep going. Does NOT proceed to Initial Response. Does NOT spawn research.

### Assertions

- [ ] Skill calls `get_issue` exactly once for #999.
- [ ] Skill attempts the glob fallback after the comment search yields nothing.
- [ ] Skill emits the exact error message "No implementation plan found for #999. Run /ralph-hero:plan first." (or a substantially equivalent message that names #999 and points at `/ralph-hero:plan`).
- [ ] Skill does NOT call `save_issue`, `create_comment`, or `Edit`.
- [ ] Skill does NOT attempt to create a plan from the iterate skill (the SKILL body explicitly forbids this — refer the user to `/ralph-hero:plan`).
- [ ] Skill terminates cleanly without prompting for further input.
