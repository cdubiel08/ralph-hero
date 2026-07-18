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
8. **Decision honesty** — does `## Design Decisions & Open Ambiguities` exist with real content (resolved bullets, `#### Decision:` blocks, or the sentinel per `plan-shapes.md` § Design decisions anatomy)? Judgment calls visible in the phases but absent from the section are buried decisions → GAP. A contradiction between a resolved decision and what the phases actually do → FAIL. Grace window: plans authored before 2026-07-31 (pre-contract) missing the section entirely score GAP, not FAIL.

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
- Decision honesty: PASS | GAP | FAIL
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

**Interactive** (default): after Step 3 rubric scoring, the *decisions* are the primary review surface, not a whole-plan verdict.

**Decisions-first pickers** — if the plan has open `#### Decision:` blocks, present one `AskUserQuestion` per decision (max 4 questions per call; batch further calls if more):

```
question: <the block's Context, condensed to one question>
header: "Decision: <short title>"          # MUST be Decision:-prefixed — naming contract below
options: <from the block's Options, agent recommendation FIRST>
                                            # "Other" free-text is the built-in escape hatch
```

Fold each answer into the plan (surgical `Edit`, iterate-mode discipline): move the answered block to the resolved-decisions list as `**<title>** — … **Decided: <choice>.** (human-decided YYYY-MM-DD)`; when no open blocks remain, restore the sentinel `None — no open design decisions.`

**Confirm picker** — after the decisions (or immediately, for decision-free plans), a single 3-option picker replaces the old 4-option whole-plan flow — kept for rubric-level rejections independent of decisions:

```
question: "Plan review verdict for #NNN?"
header: "Plan Review"
options:
  - "Approve"            → write APPROVED critique → advance to "In Progress"
  - "Request changes"    → open the Issues sub-picker + free-text (below) → write
                           NEEDS_ITERATION critique (free-text = primary feedback,
                           categories = secondary tags), post it as a comment with the
                           gap callouts → return to "Plan in Progress"
  - "Open in editor"     → open the plan file, then re-present this picker (loop)
```

**Naming contract (LOAD-BEARING)**: decision pickers MUST use `Decision:`-prefixed headers and MUST NOT pair "Approve"/"Request changes" labels — `review-plan-gate.sh` (detection unchanged) blocks verdict pickers under `RALPH_REVIEW_PLAN=auto` by the header string `"plan review"` or that label pair, so a correctly-named decision picker passes untouched.

**Open in editor** — open the plan's local path and re-present the primary picker; this branch is never a terminal verdict:

```bash
if [[ "$(uname -s)" == "Darwin" ]]; then open "<plan-local-path>"; else xdg-open "<plan-local-path>"; fi
```

**Issues sub-picker** (`Request changes`) — `multiSelect: true` over *Insufficient research / Wrong approach / Missing requirements / Scope issues*, then a free-text prompt ("provide specifics the planner must act on; skip to use categories only"). The free-text is the primary feedback in the NEEDS_ITERATION critique + GitHub comment; the categories are a secondary tag list.

> The old whole-plan pickers (4-option, and the 5-label picker before it) collapse here: plan-shaping feedback that used to ride "Approve with edits" now lives in the decisions section itself — an ambiguity worth human input is a `#### Decision:` block, answered through its own picker, not a post-hoc edit request. "Request changes" carries rubric-level rejections.

**Auto** (`--review-plan auto` or env `RALPH_REVIEW_PLAN=auto`):

**Held-plan idempotency check — BEFORE any critique dispatch.** The autopilot classify tick re-dispatches review for every Plan in Review issue on every pass; without this pre-check a held plan burns a fresh critique sub-agent per tick. Scan the issue's comments for an existing `## Decision Request`:

- Present, with NO later human comment → emit `PLAN AWAITING DECISION` and STOP. No critique dispatch, no re-post, no re-notify.
- Present, with a later human comment → treat the reply as answers: fold into the plan (as in the interactive flow — resolved-decisions list, `human-decided YYYY-MM-DD`, sentinel restored), then proceed with the APPROVED transition to In Progress (the held plan already passed its critique).
- Absent → proceed to the critique dispatch below.

Dispatch a sub-agent for delegated critique, tier-routed by unit size (GH-1538):

- **Single XS/S plan** — `Agent(subagent_type="ralph:review-agent", model="opus", prompt=...)`. Singles skip fable; opus covers a small plan's rubric pass.
- **Group plan (`github_issues:`), M single, or plan-of-plans** — same call with NO `model` param, so the agent's frontmatter `model: fable` applies (the independent critique of a feature/epic plan is a judgment bookend). Non-Fable accounts rescue via `CLAUDE_CODE_SUBAGENT_MODEL=opus` (it flattens the singles route too — acceptable).

```
Agent(
  subagent_type="ralph:review-agent",
  model="opus",   # single XS/S only — OMIT for group / M / plan-of-plans units
  prompt="Review the implementation plan at <path> against the rubric in plan-review.md. Produce a verdict (APPROVED / NEEDS_ITERATION) with per-dimension scoring. Be specific about gaps."
)
```

The sub-agent's output IS the critique doc (with the workflow body fixing the frontmatter + filename — including `decisions_open: <n>`, the count of open `#### Decision:` blocks at review time). Auto mode never opens an AskUserQuestion picker.

**Hold-or-advance routing (after the verdict):**

- **NEEDS_ITERATION** → unchanged: iterate loop (hero's 2-iteration cap applies).
- **APPROVED + sentinel present + no `#### Decision:` blocks** → unchanged APPROVED transition to In Progress — at any estimate. The decisions section is the gate, not size.
- **APPROVED + ≥1 open `#### Decision:` block** → hold: post ONE `## Decision Request` comment — one `### <decision title>` per block with its Context / Options / Recommendation verbatim, closing with answer instructions ("reply here, or run `/ralph:plan --mode review NNN`") — then fire a best-effort `PushNotification(title="Decision needed #NNN", body="<n> design decision(s) — <issue-url>")` (notification failure does NOT fail the mode — the comment is the source of truth), leave the state at Plan in Review, emit `PLAN AWAITING DECISION`. The pre-dispatch idempotency check above guarantees re-invocations never duplicate the comment or notification.

## Transition rules

| Verdict | Transition | Side effect |
|---|---|---|
| APPROVED (decision-free) | `save_issue(workflowState: "In Progress", command: "review")` | Impl can pick it up |
| APPROVED with open decisions (auto) | None — stays Plan in Review | `## Decision Request` comment + PushNotification, once; emits `PLAN AWAITING DECISION` |
| NEEDS_ITERATION | `save_issue(workflowState: "Plan in Progress", command: "review")` | Planner re-engages via `--mode iterate` |
| Open in editor | No transition; re-loops the picker | Lets the reviewer read the full plan before deciding |

The `state-gate.sh` hook (registered on `save_issue` with the plan/plan_epic/review command keys) validates the transition against ralph-state-machine.json.

## Anti-patterns

1. **Approving plans with > 2 GAP** — drops the rubric's effective floor. If a plan is GAPpy, ask for iteration.
2. **Rejecting without recommended changes** — a NEEDS_ITERATION verdict without specific edits is unactionable. Always list concrete fixes.
3. **Reviewing without reading the plan FULLY** — common when the plan is long. Read it entirely; do not skim.
4. **Auto-mode rubber-stamping** — the sub-agent prompt MUST emphasize the rubric. Loose prompts produce "looks good" reviews.
5. **Looping on "Open in editor" without ever selecting a verdict** — read the plan, then pick a real outcome. The picker exists to produce APPROVED / NEEDS_ITERATION, not to browse.
