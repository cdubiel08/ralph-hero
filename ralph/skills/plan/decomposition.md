# Decomposition

Epic → feature decomposition for `/ralph:plan --mode epic`. Folds `ralph-plan-epic`'s plan-of-plans shape and the epic-decomposition side of `ralph-split`. Atomic splitting (M/L/XL → S/XS) is NOT here — that's `/ralph:caretake --mode split` (Plan 7).

## When epic-mode applies

- Issue labeled `kind:epic` or `kind:feature` with estimate L or XL.
- Issue body describes 3+ distinct surfaces / capabilities / sub-features.
- An existing parent issue has multiple in-flight children whose dependencies need clarifying.

If the issue is just M and can be implemented as one plan with 5-7 phases, prefer default or auto mode — don't force epic decomposition.

## Plan-of-plans shape

Filename: `thoughts/shared/plans/YYYY-MM-DD-GH-NNNN-epic-<short-name>.md`. Frontmatter `type: plan-of-plans`.

```markdown
# [Epic title]

## Prior Work
[builds_on:: / tensions:: wikilinks]

## Strategic Context
[Why this epic exists; what success looks like at the epic level]

## Shared Constraints
[Cross-feature invariants: data shape, API contract, perf budget, security gates]

## Feature Decomposition

### Feature A: [name] (GH-NNN — to be assigned)
- **Estimate**: S | M
- **Owner files**: `path/to/area-A/...`
- **Scope**: [1-2 sentences]
- **Acceptance**: [bullet list of feature-level criteria]

### Feature B: [name] (GH-NNN — to be assigned)
...

## Integration Strategy
[How features compose. Shared interfaces, contract tests, integration points]

## Feature Sequencing
[Ordered dependency graph. A → B → C, with rationale for each edge]

## What We're NOT Doing
[Scope boundaries — what's deferred to a later epic]

## Design Decisions & Open Ambiguities
[REQUIRED — see plan-shapes.md § Design decisions anatomy. Epic decomposition
is decision-dense: journal resolved decomposition calls as bullets; unsettled
judgment calls become #### Decision: blocks. Sentinel line when none open:]
None — no open design decisions.

## References
```

## Child creation

For a new tree (2+ features from this decomposition), create every child in ONE `create_sub_issues` call:

1. `create_sub_issues(parentNumber: <epic-number>, children: [{title, body, estimate: <S|M>, workflowState: "Backlog", dependsOn: [<sibling indices>], dependsOnIssues: [<existing issue numbers>]}, ...])` — one entry per feature in the Feature Decomposition, in the same order the plan-of-plans lists them. `dependsOn` holds **sibling indices only** (0-based positions in THIS call's children array); pre-existing GitHub issue blockers go in `dependsOnIssues`.
2. Read the per-child status report in the response (`{index, title, number, url, created, linked, fieldsSet, edgesWired, error}`) — repair only the children that report `error` (re-run the failed stage; the tool is partial-failure aware and safe to retry per-child).
3. Record each assigned number in the plan-of-plans (replace `(GH-NNN — to be assigned)` with the real number + URL).

**Single-child incremental addition** (re-decomposition adding one feature to an existing tree, or any case where only one child is created): use `create_issue` + `add_sub_issue` as before — `create_sub_issues` exists to batch the multi-child case, not to replace the two-call path for a lone addition.

Estimate defaults:

| Epic estimate | Typical child estimates |
|---|---|
| L | 3-5 S children |
| XL | 3-5 M children, OR 6-10 S children |

**A feature child is the PR unit** (GH-1538): size each feature so it ships as one coherent PR — S or M is fine. A feature's internal tasks are plan *phases* (executed one per tick by `/ralph:impl --mode auto`, committed per phase on one branch), NEVER further sub-issues. Do not decompose a feature into task-level children to "help the autonomous loop" — smaller issues do not make the loop safer, they multiply PRs, CI runs, and review overhead (~55–75 billed CI minutes per PR regardless of diff size).

## Dependency-edge rules

For a **new tree**, wire dependencies inline in the same `create_sub_issues` call. Two separate arrays per child: `dependsOn` holds **sibling indices** (0-based positions into that call's children array — validated in-range up front, out-of-range values are rejected), `dependsOnIssues` holds **existing GitHub issue numbers** (blockers outside this call). Each entry means the child is blocked by (depends on) the target:

- **Sequential phases** (B requires A's API to exist): give B's entry `dependsOn: [<A's sibling index>]`.
- **Independent features** (can be parallelized): no `dependsOn` entry between them.
- **Shared foundation** (X is a prerequisite for all): give A/B/C's entries `dependsOn: [<X's sibling index>]`.
- **Blocked by a pre-existing issue** (a feature depends on an issue created before this call): give its entry `dependsOnIssues: [<the existing issue number>]`.

For **post-hoc or incremental edges** (wiring a dependency after the tree already exists, or against the single-child `create_issue` path above), use `add_dependency(blocker: <A>, blocked: <B>)`.

Validate the graph for cycles before committing — `create_sub_issues` rejects sibling-index cycles up front (`toolError`, no issues created), but shared-foundation and cross-batch edges still deserve a manual check. If a cycle emerges, rework the feature decomposition (one feature is probably too coarse and should be split).

Post-hoc edge repair (fixing drift between the plan and the board after the fact) is manual: re-check the decomposition against `list_sub_issues`/`list_dependencies` and call `add_dependency`/`remove_dependency` directly.

## Re-decomposition

When an epic was previously decomposed and you're re-running `--mode epic`:

1. `list_sub_issues(epic-number)` — fetch existing children.
2. Compare each existing child against the new Feature Decomposition.
3. **Match by title-similarity** — keep existing children whose scope still aligns.
4. **Mark obsolete children** — if a child is no longer in the decomposition: add a `## Re-scoped` comment on it, do NOT close (the user decides whether to close or salvage).
5. **Create new children** — for features without an existing match.
6. **Rewire dependencies** — `list_dependencies(epic-number)` and reconcile against the new Feature Sequencing.

The plan-of-plans doc is overwritten with the new structure; the old version is in git history.

## Cross-repo epic

When the epic spans multiple repos (`.ralph-repos.yml` present, epic touches multiple registry entries):

- Plan-of-plans includes a `## Cross-Repo Scope` section per `findings-format.md` § Cross-Repo Scope.
- Children inherit the repo-qualified prefix in their `## Files Affected` (e.g., `ralph-hero:src/...`).
- Dependency edges across repos use the same `add_dependency` MCP call — the substrate doesn't distinguish.
- The epic itself may live in only one repo; children may live in others. The MCP `create_issue` call accepts `owner` / `repo` overrides for cross-repo child creation.

## Anti-patterns

1. **Over-decomposition** — 10+ children for an L epic. Usually means features are too granular; merge.
2. **Under-decomposition** — 1-2 huge children. Defeats the point of epic-mode; should be a regular plan.
2a. **Task-issues** — creating sub-issues for work that will ship in the same PR anyway. Tasks inside one feature are plan phases, not issues (GH-1538). A child issue is justified only when it must ship independently: separate PR/revert scope, different surface or repo, or genuinely parallel implementation streams.
3. **Cycles** — A → B and B → A. The decomposition is wrong; one feature must subsume the other or be split.
4. **Shared mutable state across children** — if Features A and B both modify the same file, they're not really independent. Either sequence them or merge.
5. **Plan-of-plans without sequencing** — listing features without a dependency order means downstream can't dispatch them. Always include `## Feature Sequencing` even if "all independent" (state that explicitly).
