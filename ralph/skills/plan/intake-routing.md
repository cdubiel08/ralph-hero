# Intake routing

How `/ralph:plan` resolves `ARG` into a planning target. Consulted by Step 1 of every mode except `--mode review` (which uses its own resolver in `plan-review.md`).

## Detection rules

Apply in priority order — first match wins. Rules 1-4 apply to `MODE ∈ {default, auto, epic, iterate}`. In `--mode review`, the rules narrow to issue-number / plan-path only.

1. **Issue-number form** — `ARG` matches `#NNN`, `NNN` (digits-only), or `GH-NNNN`. Strip prefix. `get_issue(number, includeGroup: true)` to fetch context (title, body, comments, current workflow state, group data). Set `LINKED_ISSUE=NNN`. Read issue body + comments for any `## Research Document` artifact link and pull that research doc FULLY into the main session.

2. **Research-doc path** — `ARG` is a path under `thoughts/shared/research/*.md` or has `type: research` in its frontmatter. Read FULLY. Extract `github_issue` from frontmatter; set `LINKED_ISSUE`. The research doc is the primary planning input.

3. **Existing-plan path** — `ARG` is a path under `thoughts/shared/plans/*.md`. Prompt explicitly via `AskUserQuestion` (do NOT auto-route — preserving vs overwriting a plan is destructive enough to warrant confirmation):

   ```
   question: "This is an existing plan. What do you want to do?"
   header: "Existing plan detected"
   options:
     - "Iterate on it"        → switch to --mode iterate
     - "Re-plan from scratch" → default flow; will overwrite
     - "Review it"            → switch to --mode review
     - "Cancel"               → STOP
   ```

4. **Free-form description** — anything else not starting with `--`. Treat as a one-line planning prompt. `LINKED_ISSUE` is unset. Useful for ad-hoc planning without prior issue/research.

5. **No `ARG` (default flow only)** — prompt the user: *"What are we planning? Provide an issue number (#NNN), a research-doc path, or a description."* Wait for input, then re-route.

## File reading rule

When `ARG` resolves to a path, or when the user mentions specific files in a free-form description, **read those files FULLY (no `offset` / `limit`) before any sub-agent dispatch**. Sub-agents do not see the main session's prior reads. Reading in the main session also lets you sharpen the sub-agent prompts.

## Linked-research check

If `LINKED_ISSUE` is set and the issue has no linked research doc:

- **Interactive mode** — surface to the user: *"This issue has no linked research. Plan anyway, or research first via `/ralph:research #NNN`?"* If the user chooses "research first", invoke that command and exit. If the user chooses "plan anyway", stamp `research_waived: human-approved — <one-line reason>` into the plan frontmatter so the gate's human-override path allows the Write and the waiver is auditable.
- **Auto mode** — `plan-research-required.sh` is the hook-level enforcement, and it is estimate-aware: research is required only at/above `RALPH_RESEARCH_REQUIRED_MIN_ESTIMATE` (default `M`). If no research doc is found AND the issue's estimate is ≥ that threshold, detect this upfront in Step 3 and escalate to "Human Needed". Otherwise (sub-threshold XS/S), stamp `estimate:` into the frontmatter and proceed — the gate waives the research requirement for sub-threshold work. Auto mode never sets `research_waived:`.
- **Epic mode** — skipped (epics rarely have per-primary linked research; the plan-of-plans IS the research).
- **Iterate / review modes** — skipped (these consume an existing plan; research is upstream).

## Sibling-group planning (auto mode)

Consulted by `--mode auto` Step 2a. The feature is the PR unit (GH-1538):
when a picked issue belongs to a decomposed parent, plan the whole open
sibling set as ONE group plan instead of one plan per child — the group
converges on one worktree, one branch, one PR closing every member.

Detection — all must hold, else fall through to the single-issue flow:

1. The picked issue has a `parent`.
2. A parent plan-of-plans exists: glob `thoughts/shared/plans/*GH-<parent>-*.md`
   with `type: plan-of-plans` frontmatter.
3. `list_sub_issues(parent)` yields ≥ 2 OPEN members (picked issue included)
   currently in "Ready for Plan" AND unblocked (fetch each `blockedBy`
   blocker and check its state — do not infer; a member blocked only by
   fellow group members counts as unblocked, since intra-group ordering
   becomes phase `depends_on` inside the group plan).

When detection succeeds, set `GROUP_MEMBERS=[...]` (ascending issue number;
primary = lowest member) and adjust the remaining auto-mode steps:

- **Lock every member** (`__LOCK__` per member) before writing.
- **Author ONE plan doc** with `github_issues: [members...]` +
  `primary_issue:` per `plan-shapes.md` § Group plans — one `## Phase N:
  GH-NNN — <name>` per member, phase `depends_on:` derived from the
  members' `blockedBy` edges.
- **Post the `## Implementation Plan` artifact comment on EVERY member.**
- **Advance every member** (`__COMPLETE__` per member) to "Plan in Review".

Members NOT yet in "Ready for Plan" (still in research, or blocked by an
issue outside the group) are excluded; they join the group's PR train later
via § Parent-plan reuse matching this group plan.

## Parent-plan reuse

When `LINKED_ISSUE` is set and the issue is a child of a parent issue:

1. Fetch the parent's group via `get_issue(parent, includePipeline: true)`.
2. Search for an existing parent plan: `thoughts/shared/plans/*GH-NNNN-*.md` where NNNN is the parent issue number — AND for an existing **sibling group plan**: any plan with `type: plan` whose `github_issues:` frontmatter contains the child's number (authored by a prior § Sibling-group planning pass over this child's siblings).
3. If found, scan the plan for a phase matching the child by number or title.
4. **If a matching phase exists**: skip child-plan creation. Post a `## Plan Reference` comment on the child issue:

   ```markdown
   ## Plan Reference

   This child issue is implemented by Phase N of the parent plan at `thoughts/shared/plans/[parent-plan-path].md`.

   No separate child plan needed.
   ```

   For a **group-plan** match, additionally append the child to the plan's `github_issues:` frontmatter if absent — the child joins the group's PR train and ships in the group's single PR (one more `Closes #` line at PR time).

   Advance the child issue from "Ready for Plan" → "In Progress" directly (skipping "Plan in Review"). STOP — no more steps.

5. **If no matching phase**: continue with normal child-plan creation.

Parent-plan reuse short-circuits the planning workflow when an epic's plan-of-plans (or a sibling group plan) already specifies how each child is implemented. Avoids duplicate child plans.

## Mode-specific carve-outs

- **`--mode iterate`** — `ARG` MUST be either `#NNN` (resolves to the linked plan via issue comments) or a path to an existing plan doc. Free-form descriptions error: *"--mode iterate requires an issue number or plan path."*
- **`--mode review`** — `ARG` MUST be `#NNN` (review-mode resolves the plan from the issue's `## Implementation Plan` artifact comment). Plan-path is accepted as `--plan-doc <path>` flag in addition.
- **`--mode epic`** — `ARG` SHOULD be `#NNN` of an epic-tier issue (M/L/XL or `kind:epic` labeled). Free-form descriptions work but produce a plan-of-plans not linked to GitHub state.
