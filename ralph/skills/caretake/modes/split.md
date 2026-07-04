# `--mode split`

Take ONE large issue (M/L/XL), research its scope, and decompose it into XS/S sub-issues that can be implemented atomically. This is the non-epic side of decomposition — epic-tier work (3+ tiers) is handled by `/ralph:plan --mode epic` (Plan 4).

```bash
export RALPH_SUBCOMMAND=split
```

All four `split-*` hooks gate on `RALPH_SUBCOMMAND=split`. See [split-decomposition.md](../split-decomposition.md) for the full hook-contract table + decomposition heuristics.

## §Step 1: Select issue

**If issue number provided as argument**: fetch it directly.

**If no issue number**: find the oldest M+ issue in Research Needed or Backlog. "Oldest" means earliest `createdAt` — pass `orderBy: "CREATED_AT"` ascending. Use a sub-agent to discover candidates:

```
Agent(subagent_type="ralph:codebase-locator",
      prompt="Find issues with M/L/XL estimates in Research Needed or Backlog workflow state. Return oldest first by createdAt.")
```

Or query directly: list Backlog + Research Needed issues filtered by estimate M, then L, then XL (`limit: 50`, `orderBy: "CREATED_AT"` ascending). Pick the oldest across all queries.

Do NOT pass `team_name` to `Agent()` calls.

If no eligible issues found, emit:

```
Queue empty.
```

and STOP.

## §Step 2: Fetch and analyze

1. **Get full issue details** including comments.
2. **Read any linked research documents** from comments.
3. **Verify estimate**: must be M, L, or XL.

The `split-estimate-gate.sh` hook (PreToolUse on `get_issue` surfaces an M/L/XL reminder via stderr; PostToolUse parses `tool_response.content[0].text` and blocks with exit 2 if the estimate is XS or S). If the hook blocks, emit:

```
SPLIT SKIPPED already-atomic
```

and STOP — do NOT attempt to override the gate.

## §Step 3: Discover existing children

`list_sub_issues` on the parent. Record results:

- **No children found**: proceed to §Step 4 (research scope) and §Step 6 (create all new).
- **Children found**: read each child's title, description, estimate, and state. Carry forward to §Step 5 for scope comparison.

If children exist, add a note to the analysis: "Found [N] existing children. Will compare against proposed split before creating new issues."

## §Step 4: Research scope

Spawn parallel sub-tasks to understand the full scope (no `team_name`):

```
Agent(subagent_type="ralph:codebase-locator",
      prompt="Find all files related to [issue topic]. What components are involved?")

Agent(subagent_type="ralph:codebase-analyzer",
      prompt="Analyze [primary component]. What are the distinct pieces of work?")
```

**Goal**: identify natural boundaries — see [split-decomposition.md](../split-decomposition.md) §Decomposition heuristics for the strategy table.

§Step 4 is **optional** if the issue body already enumerates the artifacts to split (a list of skills, fragments, files). Skip it in that case and decompose directly from the body.

## §Step 5: Propose split

Design XS/S sub-issues per the sizing rubric in [split-decomposition.md](../split-decomposition.md) §Sub-issue sizing.

**If existing children were found in §Step 3**, compare proposed sub-issues against them:

- **Match found**: mark the existing child for reuse (update its estimate/description/dependencies if needed).
- **No match**: mark as net-new (will be created in §Step 6).
- **Existing child with no matching proposal**: leave as-is.

When unsure whether an existing child covers a proposed scope, prefer reusing the existing child and adjusting its description rather than creating a duplicate.

Produce a split-plan summary:

| Action | Issue | Title | Estimate |
|---|---|---|---|
| Reuse | #AA | [existing title] | S |
| Update | #BB | [adjusted title] | XS |
| Create | (new) | [new title] | XS |

## §Step 6: Create or update sub-issues

**Reuse**: update the existing child's body and/or estimate if the scope or sizing has been refined.

**Create new** — three-step pattern:

1. **`create_issue`** with descriptive title, scoped body (scope + references + acceptance criteria), labels inherited from parent.
2. **`add_sub_issue`** to link under the parent. Verify the linkage took effect (the tool response echoes the parent link) — if it didn't, retry once; if still failing, document the orphan in a comment on the parent.
3. **Set estimate** per the sizing rubric. The `split-size-gate.sh` hook (PreToolUse on `create_issue`) blocks `M`/`L`/`XL` here — children MUST be XS or S.
4. **Set initial workflow state**: advance to `Ready for Plan` (`command: "ralph_split"`) unless §Step 10's gating applies. Uniform across all children — including those blocked by a sibling via dependency.

Sub-issue body template:

```markdown
## Summary
[What this sub-issue accomplishes]

## Scope
[Specific files/components to modify]

## Acceptance Criteria
- [ ] [Specific criterion 1]
- [ ] [Specific criterion 2]

## References
- Parent: #[parent-number]
- Related: [File paths, documentation]

## Out of Scope
- [What's handled by sibling issues]
```

## §Step 7: Establish dependencies

For each dependency pair, `add_dependency`: the dependent issue is blocked by the earlier-phase issue. See [split-decomposition.md](../split-decomposition.md) §Dependency wiring for rules.

## §Step 7.5: Write parent plan-of-plans

When the split produced **2+ children** (the normal `SPLIT <N>` path — skip on the re-estimate / `SPLIT SKIPPED` path, which creates no children), write a parent plan-of-plans so the children are autonomously plannable. Without it, `/ralph:plan --mode auto` has neither a per-child research doc nor a parent plan to consume, so each child stalls and the cluster escalates to **Human Needed** (GH-1416).

Write to `thoughts/shared/plans/YYYY-MM-DD-GH-<parent>-plan-of-plans.md` — the `<parent>` number is what the parent-plan-reuse glob `*GH-NNNN-*.md` keys on. Shape: [../../plan/decomposition.md](../../plan/decomposition.md) § Plan-of-plans shape — frontmatter `type: plan-of-plans`; sections `## Strategic Context`, `## Shared Constraints`, `## Feature Decomposition`, `## Integration Strategy`, `## Feature Sequencing`, `## What We're NOT Doing`. Model the wording on `/ralph:plan --mode epic` Step 3 (`ralph/skills/plan/SKILL.md`).

One `### Feature` subsection per child under `## Feature Decomposition`, each embedding the child's **real issue number AND title** verbatim, plus its scope + acceptance from the body authored in §Step 6. The parent-plan-reuse short-circuit (`ralph/skills/plan/intake-routing.md`) matches a child to its section **by number or title**, so both must appear.

Keep `## Feature Sequencing` **identical** to the `## Issue Split` dependency chain posted in §Step 8 — same edges, same order; the two artifacts must not diverge.

This write happens in **caretake** context, where the plan skill's `plan-research-required.sh` Write gate is not armed — that is why split can emit a `plans/` doc with no research doc. The doc passes `doc-structure-validator.sh` because that hook recognizes the plan-of-plans shape (GH-1416).

## §Step 8: Update original issue

Add a split-summary comment on the parent:

```markdown
## Issue Split

This issue has been decomposed into [N] sub-issues:

| Order | Issue | Title | Estimate |
|---|---|---|---|
| 1 | #AA | [title] | XS |
| 2 | #BB | [title] | S |
| 3 | #CC | [title] | XS |

**Dependency chain**: #AA -> #BB -> #CC

Original estimate: [M/L/XL]
Total after split: [sum] points across [N] issues

---
*Split by `/ralph:caretake --mode split`*
```

**Keep parent in Backlog** — do NOT change its workflow state. The auto-advance helper inside `save_issue` advances the parent only when ALL children reach a gate state; manually advancing the parent here races with that helper.

Update the original issue body to prepend `## Split into Sub-Issues\nThis issue has been decomposed. See children and comments for details.\n\n` to the existing body. Do NOT call `save_issue` with a `workflowState` argument on the parent.

## §Step 9: Push child-specific research notes

Any context discovered during §Steps 2-5 that is specific to one child must be embedded in that child's body — not left only in the parent split-summary comment. For each child, scan your research output for notes naming a file, function, or fragment that this specific child will touch; append under a `## Research Notes` section via `save_issue`.

## §Step 10: Set sub-issue workflow states

Based on research done during splitting, set the workflow state for **every** child (including children with sibling `blockedBy` dependencies — §Step 7 dependencies are orthogonal to workflow state):

- **Scope clear** → `Ready for Plan` (`command: "ralph_split"`).
- **Scope needs more research** → keep in `Research Needed`.
- **Blocked by issue OUTSIDE this split** → keep in `Backlog`.

**Uniformity check**: after this step, `list_sub_issues` on the parent and verify every child has a non-null `workflowState`. The dependency-chain pattern (repo → service → router) is a common pitfall: agents sometimes advance only the unblocked head and leave the rest with no workflow state.

## §Step 11: Emit terminal token

```
SPLIT <N>
```

Where `<N>` is the total number of children (created + reused). `split-postcondition.sh` (Stop hook) requires `N ≥ 2` — anything less fails the gate.

On the already-atomic short-circuit (from §Step 2):

```
SPLIT SKIPPED already-atomic
```

On other graceful skips (decomposition failed, no natural boundary, parent already fully split):

```
SPLIT SKIPPED <reason>
```

## §Escalation

| Situation | Action |
|---|---|
| Can't identify natural decomposition boundaries | Escalate via `## Escalation` comment: "Unable to decompose GH-NNN. Scope is atomic or unclear — no natural artifact, layer, or phase boundary found." |
| Circular dependencies in proposed split | Escalate: "Proposed split has circular dependency. Need guidance." |
| Issue is actually XS/Small after research | Update estimate instead of splitting (no escalation needed) |

There is **no fixed cap** on sub-issue count. A skill audit epic may legitimately fan out to 10+ children; a fragment-extraction epic may fan out to 4-8. Escalate only when you cannot identify natural boundaries — not when the count is large.

## §Constraints

- **Work on ONE parent per invocation.**
- **M/L/XL parents only** — `split-estimate-gate.sh` enforces.
- **XS/S children only** — `split-size-gate.sh` enforces.
- **No implementation, only issue creation.**
- **Complete within 20 minutes** — rushing produces under-researched children.
- **Parent stays in Backlog** — the auto-advance helper inside `save_issue` owns parent transitions.
- **Sub-agent research is optional** when the issue body already enumerates artifacts (skill audits, fragment extractions).
