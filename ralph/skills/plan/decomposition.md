# Decomposition

Epic → feature decomposition for `/ralph:plan --mode epic`. Folds `ralph-plan-epic`'s plan-of-plans shape, the epic-decomposition side of `ralph-split`, AND (GH-1605) the atomic-split side — formerly caretake's split mode — into one surface. § When epic-mode applies below covers the plan-of-plans shape; § Atomic split covers the M/L/XL → XS/S path.

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

`sync_plan_graph` remains the post-hoc reconciliation path: it re-derives dependency edges from a plan document and repairs drift between the plan and the board, independent of which call originally created the edges.

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

## Dispatch order

`plan/SKILL.md` § --mode epic Step 2 runs this sequence. Steps 0-1 (classify, lock) happen there.

2. **Context gathering** — epic body + comments + linked research; `codebase-locator` for affected areas, `thoughts-locator` for prior plans. Wait for ALL.

**Plan-of-plans path:**

3. **Write plan-of-plans** — per § Plan-of-plans shape (required sections listed there). This write must precede Step 4: it is also what tells `split-size-gate.sh` which ceiling applies (§ Hook contract).
4. **Create feature children** — per § Child creation and § Dependency-edge rules.
5. **Update plan-of-plans** — annotate each `### Feature` with its assigned child number + URL.

**Atomic-split path:**

3'. **Research scope + propose split** — per § Atomic split §§Step 1-5.
4'. **Create or update sub-issues** — per § Atomic split §Step 6.
5'. **Establish dependencies + write parent plan-of-plans** — per § Atomic split §§Step 7-7.5. That doc is a *different* artifact from Step 3's: it exists so the new children are autonomously plannable (GH-1416), not as a strategic decomposition of the parent.

6. **Commit the plan-of-plans through a PR** — branch, commit `docs(plan): GH-NNN plan-of-plans`, `gh pr create`, then `bash scripts/attest-pr.sh PR_NUMBER` and `bash scripts/merge-pr.sh PR_NUMBER`, return to `main`. Full recipe and rules: [`../shared/artifact-commit.md`](../shared/artifact-commit.md). **Never `git push origin main`** — the ruleset rejects it (GH-1589) — and never bare `gh pr merge`: `bash scripts/merge-pr.sh PR_NUMBER` is the only merge path, and it is what enforces the attestation + CI + review gates.
7. **Post artifact + advance** — plan-of-plans: `create_comment(## Plan of Plans ...)` on the epic, then `save_issue(workflowState: "Plan in Review", command: "plan")`. Atomic split: per § Atomic split §§Step 8-10 — parent stays in Backlog, child states via `batch_update`. `split-postcondition.sh` reads the created-count from the `create_sub_issues` response itself; nothing to export.
8. **Optional orchestration** (plan-of-plans only) — optionally dispatch `--mode auto` per child in dependency order. Not auto-cascading by default.
9. **Report** — plan-of-plans: *Plan-of-plans complete for #NNN: [Title] / Children: N created / Sequence: A → B → C*. Atomic split: terminal token per § Atomic split § Terminal tokens.

## Atomic split

The non-epic side of decomposition (GH-1605, folded from caretake's retired split mode): take ONE large issue (M/L/XL) that does NOT clear the plan-of-plans bar above and decompose it into XS/S sub-issues that ship atomically. `/ralph:plan --mode epic`'s Step 0 classification selects this path.

**There is nothing to export.** The three `split-*` hooks classify this path themselves from the tool payloads and this session's recorded writes — see § Hook contract below for the signals and the one ordering rule they impose.

### When to split (atomic)

Split when ALL of the following hold:

- Parent estimate is M, L, or XL (XS/S is already atomic — `split-estimate-gate.sh` blocks).
- The body has clear sub-deliverables — distinct files, layers, phases, or artifacts that can be implemented independently or in a defined order.
- A reader can name 2+ children without inventing scope (if you have to invent scope to fill the second child, you're splitting for the sake of splitting).

Do NOT split when:

- The work is genuinely atomic (one file, one PR, one acceptance criterion).
- The scope is unclear (route to `caretake --mode triage` → Research Needed instead).
- The parent is already fully split (children exist that cover the entire scope).
- The children would merge in one PR anyway (single surface, shared revert scope) — that's a multi-phase plan, not a split (GH-1538). Sub-deliverables that land together are plan phases, not issues.

The dominant decomposition signal is the **artifact boundary** named in the issue body — read the body first for an enumerated list (skills, fragments, docs, patterns) before inventing a strategy:

| Original type | Split strategy |
|---|---|
| Database schema | One issue per table/view |
| ETL pipeline | Extract, Transform, Load as separate issues |
| API endpoint | Repository, Service, Router as separate issues |
| Multi-state feature | One issue per state |
| Frontend feature | Component, State, Integration as separate issues |
| Skill audit (multi-skill) | One issue per skill or skill family |
| Fragment extraction | One issue per fragment |
| Documentation update | One issue per document or section |
| Cross-cutting refactor | One issue per pattern instance or call-site cluster |

### §Step 1: Select issue

**If issue number provided**: fetch it directly (this is the common case — `/ralph:plan --mode epic #NNN` was dispatched on a specific M/L/XL issue).

**If no issue number**: find the oldest M+ issue in Research Needed or Backlog (`orderBy: "CREATED_AT"` ascending across estimate M, then L, then XL, `limit: 50` each). If none eligible, emit `Queue empty.` and STOP.

### §Step 2: Fetch and analyze

Get full issue details + comments; read any linked research. Verify the estimate is M, L, or XL. `split-estimate-gate.sh` (PostToolUse on `get_issue`) records what it reads, and `split-size-gate.sh` blocks the later `create_sub_issues` call with exit 2 if the recorded parent estimate is XS/S. On XS/S, emit `SPLIT SKIPPED already-atomic` and STOP — do NOT attempt to override the gate.

### §Step 3: Discover existing children

`list_sub_issues` on the parent. No children → proceed to research + create-all-new. Children found → read each (title, description, estimate, state) and carry forward for scope comparison.

### §Step 4: Research scope (optional)

Spawn parallel sub-agents (`codebase-locator`, `codebase-analyzer`) to find natural decomposition boundaries — skip if the issue body already enumerates the artifacts to split (a list of skills, fragments, files).

### §Step 5: Propose split

Pick from the sizing rubric — do NOT default every child to XS:

| Child scope signal | Estimate |
|---|---|
| Single file, < 2 hours, trivial multi-file edit | XS |
| Multi-file content work (e.g., SKILL.md + eval-scenarios.md + hooks), 2-4 hours | S |
| Service / repository / router layer with tests | S |
| One-pattern audit or refactor with no new files | XS |
| Fragment extraction with consumer-skill rewrites in 3+ files | S |

If existing children were found in §Step 3, compare against the proposal: reuse matches, mark net-new for the rest, leave unmatched existing children as-is.

### §Step 6: Create or update sub-issues

**Create new** — ONE `create_sub_issues` call containing ALL net-new children (not one call per child): the complete `children` array and every sibling-index `dependsOn` edge go in that single call, which is also what makes the created-count `split-size-gate.sh` records a per-batch count:

```text
create_sub_issues(parentNumber: <parent-number>, children: [
  {title, body, estimate: <XS|S>, workflowState: "Ready for Plan" | omit,
   dependsOn: [<sibling indices>], dependsOnIssues: [<existing issue numbers>]},
  ...
])
```

`split-size-gate.sh` (PreToolUse on `create_issue` | `create_sub_issues`) blocks the whole call if ANY child's estimate is not `XS`/`S` — **including a child with no estimate at all**; every child needs an explicit one. Verify via the response's per-child status report (`{index, title, number, url, created, linked, fieldsSet, edgesWired, error}`); repair only children reporting `error`.

Sub-issue body template:

```markdown
## Summary
[What this sub-issue accomplishes]

## Scope
[Specific files/components to modify]

## Acceptance Criteria
- [ ] [Specific criterion 1]

## References
- Parent: #[parent-number]

## Out of Scope
- [What's handled by sibling issues]
```

### §Step 7: Establish dependencies

**New children** (created together in §Step 6): wire each pair inline in the SAME `create_sub_issues` call — `dependsOn` holds sibling indices, `dependsOnIssues` holds pre-existing issue numbers.

**Edges to pre-existing issues** (reused children, or a dependency discovered after §Step 6 ran): use `add_dependency(blocker: <A>, blocked: <B>)`.

### §Step 7.5: Write parent plan-of-plans

When the split produced **2+ children** (skip on the re-estimate / `SPLIT SKIPPED` path — no children created, nothing to plan), write a parent plan-of-plans so the children are autonomously plannable. Without it, `/ralph:plan --mode auto` has neither a per-child research doc nor a parent plan to consume, so each child stalls (GH-1416).

Write to `thoughts/shared/plans/YYYY-MM-DD-GH-<parent>-plan-of-plans.md` — the `<parent>` number is what the parent-plan-reuse glob `*GH-NNNN-*.md` keys on (`intake-routing.md` § Parent-plan reuse). Shape: § Plan-of-plans shape above — frontmatter `type: plan-of-plans`; sections `## Strategic Context`, `## Shared Constraints`, `## Feature Decomposition`, `## Integration Strategy`, `## Feature Sequencing`, `## What We're NOT Doing`.

One `### Feature` subsection per child under `## Feature Decomposition`, each embedding the child's **real issue number AND title** verbatim, plus its scope + acceptance from §Step 6's body. The parent-plan-reuse short-circuit matches a child to its section **by number or title**, so both must appear. Keep `## Feature Sequencing` **identical** to the `## Issue Split` dependency chain posted in §Step 8 — same edges, same order.

This write happens in **plan** context, where `plan-research-required.sh`'s carve-out (this doc's own shape) is what lets it pass without a linked research doc — the decomposition itself is the research artifact. It runs *after* §Step 6 on purpose: that ordering is exactly what tells `split-size-gate.sh` this session is on the atomic path (§ Hook contract, signal 3).

### §Step 8: Update original issue

Add a split-summary comment on the parent:

```markdown
## Issue Split

This issue has been decomposed into [N] sub-issues:

| Order | Issue | Title | Estimate |
|---|---|---|---|
| 1 | #AA | [title] | XS |
| 2 | #BB | [title] | S |

**Dependency chain**: #AA -> #BB

Original estimate: [M/L/XL]
Total after split: [sum] points across [N] issues

---
*Split by `/ralph:plan --mode epic` (atomic-split path)*
```

**Keep parent in Backlog** — do NOT call `save_issue` with a `workflowState` argument on the parent. The `autoAdvanceParent` gate inside `save_issue`/`create_sub_issues` advances it only when ALL children reach a gate state; manually advancing here races with that helper. Update the original issue body to prepend `## Split into Sub-Issues\nThis issue has been decomposed. See children and comments for details.\n\n`.

### §Step 9: Push child-specific research notes

Any context discovered during §§Steps 2-5 that is specific to one child belongs in that child's body, not just the parent comment — append under `## Research Notes` via `save_issue`.

### §Step 10: Set sub-issue workflow states

Determine target state for every child: scope clear → `Ready for Plan`; needs more research → keep `Research Needed`; blocked by an issue outside this split → keep `Backlog`. Group by target state and issue one `batch_update` call per non-empty group. `batch_update` does NOT auto-advance the parent — after the batch calls, if any child now sits at a parent-gate state, call `advance_issue(direction: "parent", number: <any child number>)` once to re-fire the gate check.

### §Step 11: Emit terminal tokens

```text
SPLIT <N>
```

`N` counts **only fully successful children** in this batch's per-child status report: `created:true` **AND** `linked:true` **AND** `edgesWired:true` **AND** no `error` key. Reused (already-existing) children are never added to the count. `create_sub_issues` is partial-failure aware — a child can be created without being linked under the parent, or linked without its dependency edges wired — and a child in either state is not a decomposition, it is an orphan the parent plan would report as success. (`fieldsSet` is deliberately excluded from the conjunction: an unset project field is a cosmetic board defect, not broken parent/child or dependency integration.)

Nothing to export: `split-size-gate.sh`'s PostToolUse pass reads that same status report, applies the **same** conjunction, and records the count for `split-postcondition.sh`, which requires `N ≥ 2`. A split that creates one net-new child and reuses one pre-existing child — or that creates two but links only one — is a re-estimate, not a decomposition, and does not satisfy the gate.

On the already-atomic short-circuit (§Step 2): `SPLIT SKIPPED already-atomic`. On other graceful skips (no natural boundary, parent already fully split): `SPLIT SKIPPED <reason>`. On an empty queue (§Step 1): `Queue empty.`

### §Escalation

| Situation | Action |
|---|---|
| Can't identify natural decomposition boundaries | Escalate via `## Escalation` comment |
| Circular dependencies in proposed split | Escalate: "Proposed split has circular dependency. Need guidance." |
| Issue is actually XS/Small after research | Update estimate instead of splitting (no escalation needed) |

### §Constraints

- Work on ONE parent per invocation.
- **M/L/XL parents only** — `split-estimate-gate.sh` enforces.
- **XS/S children only** — `split-size-gate.sh` enforces.
- No implementation, only issue creation.
- **Parent stays in Backlog** — never advance it manually.

### § Hook contract (re-scoped, GH-1603)

Three hook scripts (five registrations — the estimate gate is Pre+Post, the size gate is Pre+Post) gate this path, registered in `plan/SKILL.md`:

| Hook | Event | Matcher | Purpose |
|---|---|---|---|
| `split-estimate-gate.sh` | PreToolUse | `ralph_hero__get_issue` | Surface the M/L/XL reminder via stderr once the atomic path is known; exit 0 to allow. |
| `split-estimate-gate.sh` | PostToolUse | `ralph_hero__get_issue` | Parse `tool_response.content[0].text` and **record** the issue's estimate in the session split ledger. Exit 2 if the atomic path is already armed and the estimate is XS or S. "Armed" means **the ledger says so** — i.e. `split-size-gate.sh` already classified a real create payload as atomic — never an env var (see signal 4). **Fails closed when armed:** a missing, null, or unparsable estimate (and an empty response body) also exits 2 — "cannot read the estimate" is never "estimate is fine". |
| `split-size-gate.sh` | PreToolUse | `ralph_hero__create_issue` \| `ralph_hero__create_sub_issues` | Classify the path, then block children outside its ceiling — `{XS,S}` atomic, `{S,M}` plan-of-plans — and block any child with **no** estimate on either path. Also blocks when the ledger says this batch's parent is XS/S. |
| `split-size-gate.sh` | PostToolUse | `ralph_hero__create_sub_issues` | Record how many children were **fully successful** — `created` AND `linked` AND `edgesWired` AND no `error` (§Step 11's conjunction; `fieldsSet` excluded). Never blocks. |
| `split-postcondition.sh` | Stop | (matcher-less) | When the ledger records an atomic creation attempt, require a recorded count ≥ 2. No attempt recorded ⇒ allow. |

**Scope comes from what the hooks can observe, never from a mode env var.** A bare `export` inside a Bash tool call does not propagate to hook subprocesses — only `set-skill-env.sh`'s `CLAUDE_ENV_FILE` writes at SessionStart do, and those are static per skill. The signals actually used:

1. `RALPH_COMMAND=plan` — SessionStart via `CLAUDE_ENV_FILE`, the one env value hooks can trust.
2. **Tool identity.** Only `--mode epic` creates issues; `default`/`auto`/`iterate`/`review` never call `create_issue` or `create_sub_issues`. So "plan verb + a child-creation payload" already means epic mode.
3. **Write order, per parent**, read from the session artifact list that `artifact-write-tracker.sh` maintains (keyed by the harness's `.session_id`): the plan-of-plans path writes its doc **before** creating children (§ Plan-of-plans path, Step 3 → Step 4); the atomic-split path creates children first and writes the parent plan-of-plans afterwards (§Step 6 → §Step 7.5). A `thoughts/shared/plans/` doc already written by this session **for this batch's `parentNumber`** ⇒ plan-of-plans ceiling; none ⇒ atomic ceiling. The per-parent scoping is load-bearing: read session-wide, one ticket's plan-of-plans doc would relax the *next* ticket's atomic ceiling for the rest of the session. Both paths name the doc after the parent (`YYYY-MM-DD-GH-NNNN-…`), which is what makes it attributable; matching tolerates zero-padding and respects digit boundaries (a `GH-1002` doc does not answer for parent `100`). The single-child `create_issue` shape carries no `parentNumber` and therefore keeps the session-wide read — the only signal that payload offers.
4. `RALPH_SUBCOMMAND=epic-split` — honored **additively by `split-size-gate.sh` only**, if an operator exports it in the environment before launching. There it can only force the tighter child ceiling, never relax one. It deliberately does **not** arm `split-estimate-gate.sh`: that value can be present before the session starts, so using it to arm a `get_issue` blocker would enforce *before* Step 0 has classified anything (GH-1603 round 9).

**Ordering rule this implies:** on the plan-of-plans path, write the plan-of-plans doc *before* `create_sub_issues`, and name it after the parent. That is already the documented step order and filename; skipping ahead (or naming the doc after something other than the parent) makes the size gate apply the atomic `{XS,S}` ceiling to S/M feature children. Ambiguity resolves to the tighter contract deliberately, and the block message names the fix.

**The Step 0 classification read is unguarded on every path.** `plan/SKILL.md`'s `## --mode epic` Step 0 ("Classify") reads the epic via its own `get_issue` before any path is chosen, and nothing can block that read — including a pre-exported `RALPH_SUBCOMMAND=epic-split`, which no longer arms the estimate gate. The estimate gate only *records* on that read; the M/L/XL parent contract is enforced at the create boundary instead — later than the earliest possible read, but before any child exists, and (unlike the old env-armed check) it actually fires. The same change keeps `/ralph:plan --mode auto`'s legitimate XS/S picker reads unblocked: `RALPH_COMMAND=plan` covers the whole verb, and a `get_issue` payload carries nothing that separates the auto picker from an epic fetch.

## Terminal tokens

- `SPLIT <N>` — `N ≥ 2` net-new XS/S sub-issues **created AND linked AND edge-wired, with no per-child `error`**, this invocation (reused pre-existing children are NOT counted toward `N`; neither are partially-integrated ones — see §Step 11 for the exact conjunction). `split-postcondition.sh` requires N ≥ 2 and reads the count `split-size-gate.sh`'s PostToolUse pass records using that same conjunction.
- `SPLIT SKIPPED already-atomic` — a split gate refused the parent because its estimate was already XS or S. In the common single-parent flow that refusal comes from `split-size-gate.sh` at the create boundary, off the estimate `split-estimate-gate.sh` recorded in §Step 2; `split-estimate-gate.sh` itself refuses the read only once the session is already classified atomic (a re-decomposition or second parent).
- `SPLIT SKIPPED <reason>` — other graceful skips (no natural decomposition boundary found, parent already fully split, etc.).
- `Queue empty.` — no M/L/XL issues exist in Backlog or Research Needed (queue-pick invocation with no issue number).

## Anti-patterns

1. **Over-decomposition** — 10+ children for an L epic. Usually means features are too granular; merge.
2. **Under-decomposition** — 1-2 huge children. Defeats the point of epic-mode; should be a regular plan.
2a. **Task-issues** — creating sub-issues for work that will ship in the same PR anyway. Tasks inside one feature are plan phases, not issues (GH-1538). A child issue is justified only when it must ship independently: separate PR/revert scope, different surface or repo, or genuinely parallel implementation streams.
3. **Cycles** — A → B and B → A. The decomposition is wrong; one feature must subsume the other or be split.
4. **Shared mutable state across children** — if Features A and B both modify the same file, they're not really independent. Either sequence them or merge.
5. **Plan-of-plans without sequencing** — listing features without a dependency order means downstream can't dispatch them. Always include `## Feature Sequencing` even if "all independent" (state that explicitly).
