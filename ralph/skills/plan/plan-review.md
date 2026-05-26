# Plan review

Critique-with-verdict for `/ralph:plan --mode review`. Consulted by Steps 3-5 of the review-mode body.

## Purpose

Produce a structured critique of an implementation plan + a binary verdict (APPROVED / NEEDS_ITERATION) that gates whether impl can begin. Reviews are the human's escape valve from autonomous-mode plan drift.

## Review rubric

Score each dimension as PASS / GAP / FAIL. The final verdict aggregates:

- Any **FAIL** → NEEDS_ITERATION.
- More than 2 **GAP** → NEEDS_ITERATION.
- 0-2 GAP + 0 FAIL → APPROVED.

### Dimensions

1. **Phase clarity** — does each `## Phase N:` have a clear Overview + Changes Required + Success Criteria? Vague phases ("clean up the code") fail.
2. **File ownership** — does each phase name specific files? Phases that don't name files can't be implemented atomically.
3. **Verification quality** — Automated Verification commands must be runnable as-is. Manual Verification must specify what the human is looking for (not just "test the feature").
4. **Risk coverage** — does the plan call out at least one risk in `## What We're NOT Doing` or `## Migration Notes`? Risk-blind plans miss edge cases.
5. **Plan-of-plans alignment** — for child plans, does it match the parent's Feature Decomposition + Sequencing? Misaligned child plans break the epic.
6. **Estimate sanity** — does the plan size match the issue estimate? An L plan on an XS issue means scope crept; an XS plan on an L issue means the plan is under-scoped.
7. **Linked research present** — `## Prior Work` references real research / review / plan docs? A plan with `None identified.` and no linked research is suspicious unless the issue is genuinely novel.

## Verdict shape

```markdown
**Verdict**: APPROVED | NEEDS_ITERATION

**Confidence**: high | medium | low — [1-sentence calibration]

**Score**:
- Phase clarity: PASS | GAP | FAIL
- File ownership: PASS | GAP | FAIL
- Verification quality: PASS | GAP | FAIL
- Risk coverage: PASS | GAP | FAIL
- Plan-of-plans alignment: PASS | GAP | FAIL | n/a
- Estimate sanity: PASS | GAP | FAIL
- Linked research present: PASS | GAP | FAIL | n/a
```

## Critique-doc structure

Filename: `thoughts/shared/reviews/YYYY-MM-DD-GH-NNNN-critique.md`. Frontmatter:

```yaml
---
date: YYYY-MM-DD
github_issue: NNN
github_url: https://github.com/OWNER/REPO/issues/NNN
type: review
status: complete
verdict: APPROVED | NEEDS_ITERATION
plan_doc: thoughts/shared/plans/[plan-path].md
---
```

Sections:

```markdown
# Review: [Plan title]

## Plan Reference
[Link to the plan doc reviewed]

## Strengths
[2-4 bullets — what the plan gets right]

## Gaps
[Bulleted GAP findings, each with: dimension, what's missing, where in the plan to fix]

## Failures
[Bulleted FAIL findings — only if any]

## Recommended Changes
[Concrete edits the planner should apply to address gaps / failures]

## Verdict
[Per "Verdict shape" template above]

## Caveats
[Reviewer uncertainty: areas where you couldn't fully assess due to missing context]
```

The `doc-structure-validator.sh` review-branch checks for `APPROVED|NEEDS_ITERATION` in the doc body. The verdict line at the top of `## Verdict` satisfies this.

## Interactive vs auto

**Interactive** (default): `AskUserQuestion` after Step 3 rubric scoring:

```
question: "Plan review verdict?"
header: "Plan Review"
options:
  - "Approve"             → write APPROVED critique, advance to "In Progress"
  - "Approve with edits"  → write APPROVED critique, post specific edits as a comment, advance
  - "Reject"              → write NEEDS_ITERATION critique, return to "Plan in Progress"
  - "Need more info"      → STOP without writing; post a question comment
```

**Auto** (`--review-plan auto` or env `RALPH_REVIEW_PLAN=auto`): dispatch a sub-agent for delegated critique:

```
Agent(
  subagent_type="general-purpose",
  prompt="Review the implementation plan at <path> against the rubric in plan-review.md. Produce a verdict (APPROVED / NEEDS_ITERATION) with per-dimension scoring. Be specific about gaps."
)
```

The sub-agent's output IS the critique doc (with the workflow body fixing the frontmatter + filename). Auto mode never opens an AskUserQuestion picker.

## Transition rules

| Verdict | Transition | Side effect |
|---|---|---|
| APPROVED | `save_issue(workflowState: "In Progress", command: "review")` | Impl can pick it up |
| APPROVED with edits | Same as APPROVED, plus post `## Recommended Edits` comment | Impl agent should address before merge |
| NEEDS_ITERATION | `save_issue(workflowState: "Plan in Progress", command: "review")` | Planner re-engages via `--mode iterate` |
| Need more info | No transition; post `## Review Question` comment | Caller picks up the question |

The `review-state-gate.sh` hook validates that the transition matches the verdict.

## Anti-patterns

1. **Approving plans with > 2 GAP** — drops the rubric's effective floor. If a plan is GAPpy, ask for iteration.
2. **Rejecting without recommended changes** — a NEEDS_ITERATION verdict without specific edits is unactionable. Always list concrete fixes.
3. **Reviewing without reading the plan FULLY** — common when the plan is long. Read it entirely; do not skim.
4. **Auto-mode rubber-stamping** — the sub-agent prompt MUST emphasize the rubric. Loose prompts produce "looks good" reviews.
5. **Letting "Need more info" loop indefinitely** — if asked twice and not resolved, escalate to "Human Needed".
