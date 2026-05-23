# Iteration

Surgical updates to an existing plan via `/ralph:plan --mode iterate`. Folds `ralph-hero:iterate`. Consumed by Step 4 of the iterate-mode body.

## When iterate-mode applies

- Plan is in any state (Plan in Progress / Plan in Review / Ready for Plan / In Progress / Done).
- Feedback is targeted: clarify scope, add a phase, fix an inaccuracy, extend with a follow-up.
- The plan structure is fundamentally OK — you're refining, not rewriting.

If the user wants a totally different plan (scope shifted, approach was wrong), they should `--mode auto` / default to create a new plan instead. Iterate is for surgical, not wholesale.

## Surgical-update principle

Prefer `Edit` over `Write`. Why:

- `Edit` produces a small diff that's easy to review.
- `Write` rewrites the whole file, hiding what changed.
- Plan docs are referenced by impl agents — wholesale rewrites can break in-flight implementations.

When you genuinely need to restructure, do it in two commits: (1) the structural change with empty-stub content, (2) filling the content. This produces a reviewable diff history.

## Phase numbering preservation

Existing phases keep their numbers. Adding new phases:

- **Insertion** — discouraged. Renumbering downstream phases breaks references from impl agents / sub-issues / comments.
- **Append** — preferred. New phases go at the end (`## Phase N+1: ...`). The dependency order can still be expressed via `## Implementation Approach` prose.
- **Sub-phase** — for additions inside an existing phase, add a new `### Task N.X` rather than a new `## Phase`.

If renumbering is unavoidable, also update:

1. Any `## Implementation Approach` references to the old phase numbers.
2. Any sub-issue titles that reference the phase number.
3. The `## Plan Updated` comment must call out the renumbering explicitly.

## Follow-up sections

For new requirements that surface during execution:

- Add a `## Follow-up: [topic]` section at the end of the plan.
- Don't backfill into existing phases — that masks what was added later.
- Update frontmatter with `last_updated: YYYY-MM-DD` and `last_updated_note: "Added follow-up for X"`.

## State preservation

Iterate does NOT advance workflow state. Reasons:

- The user may be iterating during impl ("we found this edge case; add a phase for it"). Advancing to "Ready for Plan" or back to "Plan in Progress" disrupts impl agents.
- The plan's review status (APPROVED / NEEDS_ITERATION) is owned by `--mode review`, not iterate.

If the iteration changes scope materially (e.g., adds a new feature), prompt the user: *"This iteration adds new scope. Re-review the plan via --mode review before continuing impl?"* — but don't auto-transition.

## Feedback intake heuristics

| Feedback shape | Action |
|---|---|
| "Add a phase for X" | Append `## Phase N+1: X` per shape in `plan-shapes.md` |
| "Phase 3 is too vague" | Edit Phase 3's `### Changes Required` with concrete file paths |
| "We need to support both A and B" | Update `## Desired End State` invariants; add Success Criteria checkboxes |
| "Drop Y from scope" | Move Y from `## Implementation Approach` to `## What We're NOT Doing` |
| "The estimate was wrong" | Update frontmatter `tags` if scope changed; add `## Re-scoped` section explaining |
| "Phase 2 conflicts with Phase 3" | Re-sequence via prose in `## Implementation Approach`; do NOT renumber |

## Update artifact

After applying edits, post on the linked issue:

```markdown
## Plan Updated

https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/[plan-path]

Changes:
- [Section X]: [what changed and why]
- [Section Y]: ...
```

The `## Plan Updated` header is load-bearing — downstream tooling discovers iteration history by grepping for it.

## Anti-patterns

1. **Wholesale rewrite via Write** — loses diff history. Always `Edit`.
2. **Renumbering phases without updating references** — breaks impl-agent dispatch.
3. **Advancing state on iterate** — iterate preserves state; `--mode review` is the gate.
4. **Backfilling new requirements into old phases** — masks the iteration. Use follow-up sections.
5. **Iterating instead of re-planning** — when scope shifted materially, the user should re-plan, not iterate.
