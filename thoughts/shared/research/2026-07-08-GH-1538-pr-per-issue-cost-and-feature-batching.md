---
date: 2026-07-08
researcher: Claude (pr-reducer session)
git_commit: 00438a7e056b3837a481b0a4c41cb136fc3494f6
branch: main
repository: cdubiel08/ralph-hero
topic: "One-PR-per-issue cost: where the contract lives, what it costs in GHA minutes, and what a per-feature PR + tiered-model cycle would change"
github_issue: 1538
github_url: https://github.com/cdubiel08/ralph-hero/issues/1538
tags: [research, pr-volume, ci-cost, github-actions, model-tiers, decomposition, batching]
status: complete
last_updated: 2026-07-08
---

# One PR Per Issue: Cost, Contract Location, and the Per-Feature Batching Alternative

## Research Question

ralph-hero's autonomous loop produces one PR per issue. On active autopilot
days this creates enormous PR volume, burning GitHub Actions minutes (a
downstream pilot repo hit its Actions spending limit mid-drain) and human
review attention. Where is the 1-issue-1-PR contract encoded, what does it
actually cost, and what would need to change to make the **feature** (and
epic) the PR/cycle unit instead — with a tiered-model cycle (fable
research/plan/critique/final-validation, sonnet impl, haiku deterministic
tests, opus browser/BDD, fable plan-vs-delivery verification)?

## Summary

1. **The PR unit is the *plan*, not the issue — and the multi-issue plan
   mechanism already exists but is never used by the autonomous paths.** A
   plan with `github_issues:` (array) frontmatter produces ONE
   worktree/branch/PR closing every member (`ralph/skills/impl/pr-creation.md:33-36`),
   and `sync-pr-merge.yml` already advances up to 25 linked issues per merged
   PR independently. But `plan --mode epic` creates one GitHub issue per
   feature and each child is then planned by single-issue `plan --mode auto`,
   so the group lever is effectively dead code on the autopilot path.
2. **Decomposition sizing actively pushes toward many small PRs.** Epic
   decomposition targets 3-10 S children (`ralph/skills/plan/decomposition.md:60-66`);
   `caretake --mode split` fans M/L/XL into XS/S sub-issues; each child →
   own plan → own `feature/GH-NNN` branch → own PR. The hero state machine
   literally documents `PR (per issue)` (`ralph/skills/hero/state-machine.md:35`).
3. **Measured cost is real and front-of-mind.** In a downstream pilot repo,
   one autopilot day (2026-07-07) produced ~40 merged PRs and ~175 workflow
   runs (~2,300+ billed minutes in a single day — roughly half the repo's
   entire pre-autopilot *monthly* baseline of ~5,300 min). Marginal CI cost
   is ~55-75 billed minutes per merged PR (PR-event CI + push-to-main
   re-validation + deploys). Example: one "Feature F" epic shipped as three
   sibling PRs totalling +31/−7 lines — ~180 CI minutes where one grouped PR
   would have cost ~60. The pilot repo separately hit its Actions spending
   limit and has two dedicated CI-cost workstreams; per-PR *count* is the
   remaining multiplier no CI-side optimization can fix.
4. **Model tiers are already ~70% of the proposed target.** plan/review =
   `best`/fable, impl = sonnet, merge/locators = haiku
   (`docs/model-tier-policy.md:58-72`). Gaps: research is sonnet (proposal:
   fable at feature/epic tier), val-agent is sonnet (proposal: fable
   plan-vs-delivery verification), no haiku deterministic-test runner, no
   opus browser/BDD stage wired into the loop, and fable is spent on
   *every* plan/review including XS singles (proposal: singles skip fable).
5. **Downstream infra is N-issue-safe today; upstream never produces N.**
   The only cardinality bug found: `merge-review-decision-gate.sh`'s
   XS-no-comments carve-out reads `closingIssuesReferences[0]` only
   (`ralph/hooks/scripts/merge-review-decision-gate.sh:171-185`), so a
   mixed-estimate group PR is judged by its first-listed issue.

## Detailed Findings

### 1. Where the 1-PR-per-issue contract is encoded

| Layer | Location | Behavior |
|---|---|---|
| Branch/worktree naming | `ralph/skills/impl/worktree-setup.md:59-62` | `WORKTREE_ID = GH-[primary_issue]`; one worktree per plan |
| PR creation | `ralph/skills/impl/SKILL.md:191-199`, `ralph/skills/impl/pr-creation.md:33-36` | One PR per plan; body emits one `Closes #NNN` per member for group plans |
| Hero dispatch loop | `ralph/skills/hero/task-graph.md`, `ralph/skills/hero/dispatch.md:14-15` | One root issue per cycle; `PR` phase = single `/ralph:impl --mode pr NNN` |
| State machine prose | `ralph/skills/hero/state-machine.md:35` | Explicit `PR (per issue)` label — the most direct textual assertion |
| Epic decomposition | `ralph/skills/plan/decomposition.md:52-66` | One `create_issue` + `add_sub_issue` per feature; children planned individually |
| Split decomposition | `ralph/skills/caretake/split-decomposition.md:37-50` | M/L/XL → XS/S sub-issues, each converging on its own plan/PR |
| Merge flow | `ralph/skills/review/SKILL.md:135`, `ralph/skills/review/merge-gate.md:105-115` | Already documents per-child transitions for "group merges" |
| GHA merge sync | `.github/workflows/sync-pr-merge.yml:67-93,173-276` | Collects ALL `closingIssuesReferences` (≤25) + regex fallback; advances each independently |
| Parent advancement | `.github/workflows/advance-parent.yml:95-139` | Sibling-convergence fan-in on issue close; PR-cardinality agnostic |

**Key structural fact:** group membership is fixed once, at plan-authorship
time, via `github_issue` (scalar) vs `github_issues` (array) frontmatter
(`ralph/skills/impl/SKILL.md:125,169`). Every downstream stage — worktree ID,
branch name, PR body, per-child state transitions — inherits that decision.
Nothing in hero, epic mode, or split mode can widen a group after the fact,
and no autonomous path ever authors a multi-issue plan.

The only >1-PR case is the inverse: cross-repo plans create one PR *per repo*
for a single issue (`ralph/skills/impl/pr-creation.md:39-64`).

### 2. Measured cost (downstream pilot repo, 2026-07-05 → 07-08)

- **PR volume:** ~87 autopilot PRs in 3 days; peak day (07-07) ~40 merged.
- **Workflow runs, 3 days:** 322 total; peak day: 62 CI-python + 44 CI-web
  + 40 E2E + 13 drift-check + 21 deploy-web/API runs.
- **Baseline for scale:** the repo's *entire month* of CI before autopilot
  was ~5,300 billed minutes (its own cost-baseline research, 2026-07-05).
  CI-web alone averages 21.4 min/run; deploy-web 20 min; CI-python 5.4.
  Peak autopilot day ≈ 2,300+ billed minutes ≈ half a month's baseline in
  24h — which is what tripped the Actions spending limit mid-drain.
- **Marginal cost per merged PR ≈ 55-75 billed min** (PR-event CI suite +
  post-merge push re-validation + path-triggered deploys), independent of
  diff size. Three sibling "Feature F" responsive-treatment PRs (+31/−7
  lines combined) ⇒ ~180 min; as one feature PR ⇒ ~60 min.
- The pilot repo has already done two rounds of CI-side optimization
  (dedup jobs, sharding, caching, honest-gates rework). Those reduce
  min/PR; only reducing **PRs per unit of work** attacks the multiplier.

Token/attention cost scales the same way: each PR carries its own plan doc,
plan-review verdict, code review, merge-gate evaluation, PR body, and human
notification — mostly fixed-cost per PR, not per line.

### 3. Model tiers: current vs proposed cycle

Current policy (`docs/model-tier-policy.md:58-72`): plan/review skill
sessions `best` (fable→opus); plan-agent/review-agent `fable`; hero,
research, impl, caretake, val/triage agents sonnet; merge/catch-up/locators
haiku; impl per-phase quality reviewer opus; impl per-task ladder
haiku/sonnet/opus by `complexity:`.

Proposed target vs current, by cycle stage:

| Stage | Proposed | Current | Gap |
|---|---|---|---|
| Research (feature/epic) | fable | sonnet (`research/SKILL.md`) | ⬆ retier at feature/epic granularity |
| Plan authoring | fable | best/fable ✓ | none |
| Independent plan critique | fable | best/fable ✓ (`plan --mode review`, review-agent) | none |
| Implementation | sonnet | sonnet ✓ (+ BLOCKED→opus) | none |
| Deterministic test runs | haiku | inside sonnet impl-agent | ➕ new: haiku test-runner sub-agent |
| Browser/BDD verification | opus | not wired into the loop (ralph-playwright exists standalone; impl quality reviewer is opus but code-review-shaped) | ➕ new: opus behavior-verification stage per feature |
| Plan-vs-delivery validation | fable | sonnet val-agent | ⬆ retier at feature/epic close-out |
| Singles (1 issue = 1 PR) | skip fable | best/fable on every plan/review incl. XS | ⬇ tier-by-unit: XS/S singles get sonnet plan / opus review |

Net: the tier *ladder* mostly exists; what's missing is **tier routing by
unit size** (feature/epic cycles get fable bookends; singles don't) and two
new verification stages (haiku deterministic tests, opus behavioral tests).

### 4. What a per-feature PR cycle would need to change

The seams, in dependency order:

1. **Decomposition contract** (`ralph/skills/plan/decomposition.md`,
   `ralph/skills/caretake/split-decomposition.md`): make the FEATURE the
   leaf work unit. XS/S "tasks" become **phases of the feature plan**
   (already a first-class plan concept executed one-per-tick by
   `impl --mode auto`) instead of separate GitHub issues — or, where
   sub-issues are still wanted for board visibility, epic mode authors ONE
   feature plan with `github_issues: [children...]` group frontmatter so
   the existing group machinery produces one PR closing all of them.
2. **Hero task graph / dispatch** (`ralph/skills/hero/task-graph.md`,
   `dispatch.md`, `state-machine.md:35`): cycle unit = plan-group (feature),
   with an epic-level outer cycle (fable research/critique/validation
   bookends around the feature sequence). `PR (per issue)` → `PR (per
   feature plan)`.
3. **Tier routing by unit** (`docs/model-tier-policy.md` + skill/agent
   frontmatter): feature/epic cycle pins fable on research/plan/critique/
   final-validation; single-issue fast path drops plan/review to
   sonnet/opus; add haiku deterministic-test sub-agent and opus
   browser/BDD stage (natural integration point: ralph-playwright
   `test-e2e`/`story-gen` at feature close-out).
4. **Group-cardinality fixes**: `merge-review-decision-gate.sh:171-185`
   must evaluate ALL `closingIssuesReferences` (e.g. carve-out only if
   every linked issue is XS); audit any other `[0]`-style lookups.
5. **No GHA workflow changes required**: `sync-pr-merge.yml` and
   `advance-parent.yml` are already N-issue-per-PR safe — feature PR merge
   closes all children, children's closure converges the parent epic.

Risks / trade-offs observed in current docs, not resolved here:

- Smaller PRs were chosen deliberately for autonomous-loop safety
  ("Smaller children → easier autonomous planning + impl loops",
  `decomposition.md:60-66`) and for revert granularity. A feature PR
  bundles revert scope and lengthens review.
- The XS-no-comments merge carve-out and stacked-branch sequencing
  (`worktree-setup.md:86`) assume small, independent branches; a feature
  branch accumulating multiple phases needs the per-phase checkpoint
  discipline that `impl --mode auto` already has (one phase per tick,
  commit per phase) — the phases just stop being separate PRs.
- Deploy-on-merge repos convert every merged PR into deploy runs; batching
  also batches deploys (fewer, bigger). This is usually the desired
  behavior for "atomic changes across multiple surfaces".

## Prior Work

- `docs/model-tier-policy.md` — canonical tier policy (2026-07-01 state).
- `thoughts/shared/plans/2026-07-01-plan-review-best-model-tier.md` — the
  `best` alias re-tier for the two judgment surfaces.
- `thoughts/shared/research/2026-06-09-GH-1487-hero-model-pinning-per-phase.md`
  and `thoughts/shared/plans/2026-06-09-GH-1487-fable-model-ladder-retiering.md`
  — the earlier (reverted) blanket-fable ladder; explains why entitlement-aware
  pins matter.
- `thoughts/shared/research/2026-07-05-github-actions-ci-minutes-inventory.md`
  — ralph-hero's own CI-minutes inventory.
- Downstream pilot repo: CI cost baseline research (2026-07-05), a 5-phase
  CI cost-reduction plan, and a 4-phase "honest protection vs speed" CI
  ruleset plan — CI-side levers already being pulled; per-PR count is the
  remaining multiplier.
- `thoughts/shared/plans/2026-05-24-GH-1416-split-plan-of-plans-emission.md`
  — plan-of-plans emission for splits (traceability artifact, not a
  shared-PR mechanism).
- No prior document proposes multi-issue-batched PRs; this is the first.

## Files Affected (by any follow-on implementation)

- `ralph/skills/plan/decomposition.md`, `ralph/skills/plan/SKILL.md` (epic mode)
- `ralph/skills/caretake/split-decomposition.md`
- `ralph/skills/hero/task-graph.md`, `ralph/skills/hero/dispatch.md`, `ralph/skills/hero/state-machine.md`
- `ralph/skills/impl/SKILL.md`, `ralph/skills/impl/worktree-setup.md`, `ralph/skills/impl/pr-creation.md`, `ralph/skills/impl/phase-execution.md`
- `ralph/skills/review/SKILL.md`, `ralph/skills/review/merge-gate.md`
- `ralph/hooks/scripts/merge-review-decision-gate.sh` (closingIssuesReferences[0] fix)
- `ralph/agents/{research,plan,review,val}-agent.md`, `docs/model-tier-policy.md` (tier routing by unit)

## Open Questions

1. Phases-as-tasks vs sub-issues-with-group-plan: drop child issues entirely
   (feature = one issue, tasks = plan phases) or keep child issues for board
   granularity and use `github_issues` group plans? The former is simpler and
   cheaper (fewer issues too); the latter preserves per-task board state.
2. Where is the single/feature threshold? Proposal implied: anything that
   arrives as a standalone XS/S issue stays a single (no fable); anything
   decomposed from an epic ships per-feature.
3. Should the opus browser/BDD stage gate merge (blocking) or run
   post-merge (observing)? Blocking doubles its latency impact on the
   feature cycle.
