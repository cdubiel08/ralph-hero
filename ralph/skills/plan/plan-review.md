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

**Interactive** (default): after Step 3 rubric scoring, present a 4-option `AskUserQuestion` primary picker. "Open in editor" loops (it never produces a verdict); the two change-requesting branches open a follow-up multi-select to capture structured feedback before the verdict is written.

```
question: "Plan review verdict for #NNN?"
header: "Plan Review"
options:
  - "Approve"            → write APPROVED critique → advance to "In Progress"
  - "Approve with edits" → open the Adjustments sub-picker (below) → write APPROVED
                           critique, fold the picked categories into ## Recommended
                           Changes, post a ## Recommended Edits comment → advance to
                           "In Progress"
  - "Request changes"    → open the Issues sub-picker + free-text (below) → write
                           NEEDS_ITERATION critique (free-text = primary feedback,
                           categories = secondary tags), post it as a comment with the
                           gap callouts → return to "Plan in Progress"
  - "Open in editor"     → open the plan file, then re-present this picker (loop)
```

**Open in editor** — open the plan's local path and re-present the primary picker; this branch is never a terminal verdict:

```bash
if [[ "$(uname -s)" == "Darwin" ]]; then open "<plan-local-path>"; else xdg-open "<plan-local-path>"; fi
```

**Adjustments sub-picker** (`Approve with edits`) — `multiSelect: true` over *Clarify success criteria / Add missing details / Fix technical approach / Update scope boundaries*. The picked categories become the body of the `## Recommended Edits` comment and `## Recommended Changes` in the critique.

**Issues sub-picker** (`Request changes`) — `multiSelect: true` over *Insufficient research / Wrong approach / Missing requirements / Scope issues*, then a free-text prompt ("provide specifics the planner must act on; skip to use categories only"). The free-text is the primary feedback in the NEEDS_ITERATION critique + GitHub comment; the categories are a secondary tag list.

> The old 5-label picker (Approve / Minor Changes / Major Changes / Reject / Open in editor) collapses to these 4 outcomes: "Major Changes" and "Reject" routed to the identical Issues sub-flow, so "Request changes" carries both. If the literal 5 labels are ever needed, split into a verdict-tier picker followed by a Minor/Major severity picker (each ≤4 options).

**Auto** (`--review-plan auto` or env `RALPH_REVIEW_PLAN=auto`): dispatch a sub-agent for delegated critique, tier-routed by unit size (GH-1538):

- **Single XS/S plan** — `Agent(subagent_type="ralph:review-agent", model="opus", prompt=...)`. Singles skip fable; opus covers a small plan's rubric pass.
- **Group plan (`github_issues:`), M single, or plan-of-plans** — same call with NO `model` param, so the agent's frontmatter `model: fable` applies (the independent critique of a feature/epic plan is a judgment bookend). Non-Fable accounts rescue via `CLAUDE_CODE_SUBAGENT_MODEL=opus` (it flattens the singles route too — acceptable).

```
Agent(
  subagent_type="ralph:review-agent",
  model="opus",   # single XS/S only — OMIT for group / M / plan-of-plans units
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
| Open in editor | No transition; re-loops the picker | Lets the reviewer read the full plan before deciding |

The `state-gate.sh` hook (registered on `save_issue` with the plan/plan_epic/review command keys) validates the transition against ralph-state-machine.json.

## Anti-patterns

1. **Approving plans with > 2 GAP** — drops the rubric's effective floor. If a plan is GAPpy, ask for iteration.
2. **Rejecting without recommended changes** — a NEEDS_ITERATION verdict without specific edits is unactionable. Always list concrete fixes.
3. **Reviewing without reading the plan FULLY** — common when the plan is long. Read it entirely; do not skim.
4. **Auto-mode rubber-stamping** — the sub-agent prompt MUST emphasize the rubric. Loose prompts produce "looks good" reviews.
5. **Looping on "Open in editor" without ever selecting a verdict** — read the plan, then pick a real outcome. The picker exists to produce APPROVED / NEEDS_ITERATION, not to browse.
