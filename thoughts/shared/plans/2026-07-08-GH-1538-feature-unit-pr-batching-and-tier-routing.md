---
date: 2026-07-08
status: approved
type: plan
tags: [pr-batching, ci-cost, model-tiers, decomposition, hero, plan, impl, review]
github_issue: 1538
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1538
primary_issue: 1538
estimate: L
research: thoughts/shared/research/2026-07-08-GH-1538-pr-per-issue-cost-and-feature-batching.md
---

# Feature-Unit PR Batching + Tier Routing by Unit Size

## Prior Work

- builds_on:: [[2026-07-08-GH-1538-pr-per-issue-cost-and-feature-batching]] — the research
  doc this plan implements; all file:line evidence lives there.
- builds_on:: [[2026-07-01-plan-review-best-model-tier]] — established the
  `best`/fable pins on the two judgment surfaces; this plan adds *routing by
  unit size* on top rather than changing any skill frontmatter pin.
- tensions:: [[2026-06-09-GH-1487-fable-model-ladder-retiering]] — the reverted
  blanket-fable retier. This plan deliberately avoids frontmatter `model:` pins
  (the failure mode there) by using per-invocation `Agent(model=...)` params,
  which non-Fable accounts already rescue via `CLAUDE_CODE_SUBAGENT_MODEL`.

## Overview

ralph's autonomous loop ships one PR per leaf issue. Measured on a downstream
pilot repo: ~40 merged PRs in one day ≈ 2,300+ billed GHA minutes (half a
month's pre-autopilot baseline in 24h), at ~55–75 min marginal CI cost per PR
regardless of diff size — three sibling feature-part PRs totalling +31/−7
lines burned ~3× what one grouped PR would have. Token and human-attention
costs scale the same way: plan doc, review verdict, merge gate, and
notification are fixed costs per PR.

This plan makes the **feature the PR unit** (one group plan → one worktree →
one branch → one PR closing all member issues) and routes model tiers by
**unit size** (feature/epic cycles get fable bookends: research, plan,
critique, final validation; single XS/S issue-PR pairs skip fable entirely).
It also adds the two missing verification tiers: a haiku deterministic
test-runner and an opus browser/BDD stage at feature close-out.

Nearly all machinery already exists: `github_issues:` group-plan frontmatter
flows through worktree ID, branch, PR body (multi-`Closes #`), per-child
state transitions, and the N-issue-safe `sync-pr-merge.yml` / 
`advance-parent.yml` workflows. **No GitHub Actions workflow changes are
required.** The work is: make the autonomous paths *produce* group plans,
fix one cardinality bug, route tiers by unit, and wire the two test stages.

## Current State Analysis

The PR unit is the *plan*; group membership is fixed once at plan-authoring
time via `github_issue` (scalar) vs `github_issues` (array) frontmatter
(`ralph/skills/plan/plan-shapes.md:27-28`), and no autonomous path ever
authors the array form:

- `plan --mode epic` creates one GitHub issue per feature
  (`ralph/skills/plan/decomposition.md:52-58`), each later planned by
  single-issue `plan --mode auto`.
- `caretake --mode split` fans M/L/XL into XS/S sub-issues
  (`ralph/skills/caretake/split-decomposition.md:37-50`) and emits a
  plan-of-plans that is a traceability artifact, not an executable plan.
- The parent-plan-reuse short-circuit
  (`ralph/skills/plan/intake-routing.md:42-63`) maps a child to a parent-plan
  phase but each child still implements in its own flow → own PR.
- Hero's dispatch table drives one leaf issue per cycle
  (`ralph/skills/hero/dispatch.md:7-16`); the state machine documents
  `PR (per issue)` (`ralph/skills/hero/state-machine.md:35`).

### Key Discoveries

- **Group machinery is complete downstream of plan authoring.**
  `worktree-setup.md:59-62` (group WORKTREE_ID row), `pr-creation.md:33-36`
  (one `Closes #` per member), `impl/SKILL.md` auto Steps 4-6 (issues[] from
  `github_issues`, per-member `__LOCK__`, per-member advance),
  `review/SKILL.md:135` (group merges: per-child transition),
  `sync-pr-merge.yml:67-93,173-276` (advances ALL closingIssuesReferences).
- **Hero's default-mode task graph is already group-shaped** — "Plan group
  GH-[PRIMARY]" → implement members → "Create PR GH-[PRIMARY]" (one PR task)
  (`ralph/skills/hero/task-graph.md:21-56`). The per-issue fan-out comes from
  the *queue-drain* paths (`plan --mode auto`, `impl --mode pr` queue-pick,
  `hero --mode auto` classify loop) where each leaf walks the board alone.
- **Latent inconsistency**: `worktree-setup.md:51-62` routes epic members
  into a shared worktree `GH-[EPIC_NUMBER]`, but `impl --mode pr` queue-pick
  (`impl/SKILL.md` §mode-pr Step 1) checks `worktrees/GH-NNN` per *child* —
  the two halves disagree, and in practice each child ships its own PR.
- **The tier ladder mostly exists**: per-task complexity ladder
  haiku/sonnet/opus + haiku task-reviewer + opus phase-reviewer
  (`ralph/skills/impl/phase-execution.md:11,26-32,51-58`); plan/review skill
  sessions pin `best`; plan-agent/review-agent pin `fable`
  (`docs/model-tier-policy.md:58-72`). Missing: routing by unit size —
  today an XS single burns fable exactly like an epic does.
- **Cardinality bug**: `merge-review-decision-gate.sh` (~line 171-185 in
  `is_xs_no_comments_pr()`) reads `closingIssuesReferences[0]` only — a
  group PR's XS-no-comments carve-out is judged by its first-listed issue.
- **UI-detection heuristic already exists** for the opus BDD stage to reuse:
  `pr-creation.md` §Scout Trigger (frontend glob match on the PR diff).
- **Per-invocation `Agent(model=...)` beats agent frontmatter** (Claude Code
  subagent model resolution: env var → param → frontmatter → session), so
  tier routing can live entirely in dispatch-site prose with zero frontmatter
  churn — avoiding the GH-1487 entitlement failure. `CLAUDE_CODE_SUBAGENT_MODEL`
  remains the non-Fable escape hatch (it flattens params too, documented).

## Desired End State

1. A split or epic feature ships as **one PR closing all its member issues**;
   the board still shows per-child issues and states (group machinery), and
   `sync-pr-merge.yml` closes them all on merge.
2. Standalone XS/S issues (no group) still ship as single-issue PRs — but
   their plan/review runs at sonnet/opus, never fable.
3. Feature and epic cycles get fable bookends: research (feature/epic tier),
   plan authoring, independent plan critique, and final plan-vs-delivery
   validation.
4. Deterministic test suites run via a haiku sub-agent that parses actual
   results (never trusts exit-0 tail output); browser/behavior verification
   runs via an opus stage at feature close-out when the diff has UI surface.
5. The merge-gate XS carve-out evaluates **all** linked issues.
6. `docs/model-tier-policy.md` documents tier-by-unit routing; hero docs no
   longer say `PR (per issue)`.

### Verification

- Hook tests pass: `find ralph/hooks/scripts/__tests__ \( -name '*.test.sh' -o -name 'test-*.sh' \) -print0 | xargs -0 -n1 bash`
- `shellcheck -S error ralph/hooks/scripts/*.sh`
- `bash scripts/check-doc-rosters.sh`
- `cd mcp-server && npx vitest run src/__tests__/skill-frontmatter.test.ts`
- Manual dogfood: run one M-sized split through the full loop on this repo
  and observe exactly ONE PR closing ≥2 child issues, all children Done
  after merge, parent auto-advanced.

## What We're NOT Doing

- **No GitHub Actions workflow changes** — `sync-pr-merge.yml` /
  `advance-parent.yml` are already N-issue-safe.
- **No retro-batching** of issues that were already independently planned;
  grouping is decided at decomposition/planning time, as today.
- **No stacked-PR machinery** — the `base_branch:` stacking path stays as-is.
- **No skill/agent frontmatter `model:` changes** — interactive surfaces keep
  their current pins (`best` on plan/review); routing is per-invocation only.
- **No MCP server (TypeScript) changes** — this is entirely skill prose +
  hooks + docs.
- **Not changing `impl --mode address`** (PR feedback) or cross-repo PR
  fan-out (one PR per repo remains correct).

## Implementation Approach

Seven phases, each independently shippable and verifiable. Phase 1 is a
standalone bug fix. Phases 2–4 flip the PR unit (plan authoring → sizing
guidance → hero/impl consistency). Phase 5 adds tier routing. Phase 6 adds
the two test tiers. Phase 7 adds the epic-level close-out bookend. Per this
plan's own philosophy: **one branch, one PR for the whole plan**, phases as
commits.

Resolved design decisions (flagged for reviewer attention):

- **D1 — grouping mechanism**: keep child issues for board visibility; the
  *feature plan* becomes a phased **group plan** (`github_issues:` array, one
  phase per child). Chosen over "phases only, no child issues" because it
  preserves per-child board state, dependency edges, and `advance-parent`
  convergence with zero workflow changes. Decomposition guidance ALSO steers
  toward fewer child issues at the source (Phase 3), so both levers apply.
- **D2 — tier routing mechanism**: per-invocation `Agent(model=...)` forks at
  dispatch sites; no frontmatter churn (see Key Discoveries).
- **D3 — opus BDD gating**: blocking at feature close-out **only when** the
  PR diff matches the existing Scout-Trigger UI heuristic AND ralph-playwright
  is installed; advisory-skip otherwise. Revisit after dogfooding.

## Phase 1: Merge-gate cardinality fix

- **depends_on**: null

### Overview

Make the XS-no-comments merge carve-out evaluate every linked issue, not
`closingIssuesReferences[0]`.

### Changes Required

#### 1. `ralph/hooks/scripts/merge-review-decision-gate.sh`

In `is_xs_no_comments_pr()`: collect ALL linked issue numbers
(`jq -r '.closingIssuesReferences[]?.number'`); fail-closed (return 1) when
the list is empty; loop the estimate lookup and require **every** linked
issue's estimate to be `XS`. Keep the existing fail-closed idiom on any `gh`
error or unparseable estimate.

#### 2. `ralph/hooks/scripts/__tests__/` — new test file

`merge-review-decision-gate-group.test.sh`: stub `gh`/`jq` inputs covering
(a) single XS → carve-out fires, (b) group all-XS → fires, (c) group XS+S →
denied, (d) empty closingIssuesReferences → denied, (e) gh error → denied.
Model the harness on the existing gate tests in `__tests__/`.

### Success Criteria

#### Automated Verification
- [x] New test file passes standalone: `bash ralph/hooks/scripts/__tests__/merge-review-decision-gate-group.test.sh`
- [x] Full hook test sweep passes
- [x] `shellcheck -S error ralph/hooks/scripts/merge-review-decision-gate.sh`

#### Manual Verification
- [ ] On a real group PR (Phase 2+ dogfood), the carve-out decision reflects the highest member estimate

## Phase 2: Group planning in `plan --mode auto`

- **depends_on**: null

### Overview

Teach the autonomous planner to author ONE phased group plan for a sibling
set instead of one plan per child. This is the core cardinality flip.

### Changes Required

#### 1. `ralph/skills/plan/SKILL.md` — `--mode auto` Step 2 (Select issue) + new Step 4.5

After picking issue #NNN, add **sibling-group detection**: if the issue has a
parent whose plan-of-plans exists (glob `thoughts/shared/plans/*GH-<parent>-*.md`,
`type: plan-of-plans`), fetch `list_sub_issues(parent)` and collect all OPEN
siblings in "Ready for Plan" that are unblocked (per blocker semantics).
If ≥2 members (picked issue included):

- Lock ALL members (`save_issue(workflowState="__LOCK__", command="plan")`
  per member).
- Author ONE plan doc with frontmatter `github_issues: [members...]`,
  `primary_issue: <parent or lowest member>`, one `## Phase N` per member
  (phase `depends_on:` derived from the members' `blockedBy` edges), each
  phase carrying the member's issue number in its heading.
- Post the `## Implementation Plan` artifact comment on EVERY member.
- Advance ALL members to "Plan in Review" (`__COMPLETE__` per member).

If <2 group members, fall through to today's single-issue flow unchanged.
Siblings not yet in "Ready for Plan" (e.g. still in research) are excluded —
they join later via parent-plan reuse against this group plan.

#### 2. `ralph/skills/plan/intake-routing.md` — §Parent-plan reuse

Extend Step 3-4: a matching **group plan** (type `plan` with
`github_issues:` containing the child) also short-circuits — post
`## Plan Reference` pointing at the group plan + phase, advance child to
"In Progress". This lets late-arriving siblings join the existing group PR
train instead of spawning their own plan.

#### 3. `ralph/skills/plan/plan-shapes.md` — §Frontmatter + new §Group plan

Document the group-plan variant: `github_issues:` semantics, phase↔member
mapping convention (`## Phase N: GH-NNN — <name>`), and that
`doc-structure-validator.sh` treats it as a standard plan (phases required).

#### 4. Hook check (verify, likely no change)

Confirm `plan-postcondition.sh`, `plan-tier-validator.sh`,
`doc-structure-validator.sh`, and `lock-release-*` handle a session that
locks/advances multiple issues and writes one plan doc. Fix only if a gate
assumes exactly one `save_issue` target per session.

### Success Criteria

#### Automated Verification
- [x] Hook test sweep + shellcheck pass
- [x] `doc-structure-validator.sh` accepts a fixture group plan (add fixture to its test if one exists)

#### Manual Verification
- [ ] Dogfood: split an M issue into 2-3 children on this repo's board, run `/ralph:plan --auto`, observe ONE plan doc with `github_issues:` covering all children and all children in "Plan in Review"

## Phase 3: Decomposition guidance — phases over sub-issues

- **depends_on**: null

### Overview

Reduce fan-out at the source: decomposition should produce child *issues*
only at boundaries that must ship independently; everything else becomes
phases of one plan.

### Changes Required

#### 1. `ralph/skills/plan/decomposition.md`

- §Child creation + estimate-defaults table: replace "Smaller children →
  easier autonomous planning" guidance with: a feature child is the **PR
  unit** — size features so each is one coherent PR (S or M); its internal
  tasks are plan *phases*, never further sub-issues.
- §Anti-patterns: add "**Task-issues** — creating sub-issues for work that
  will ship in the same PR; use phases."

#### 2. `ralph/skills/caretake/split-decomposition.md`

- §When to split: add a third DO-NOT-split bullet — don't split when children
  would merge in one PR anyway (single surface, shared revert scope); write a
  multi-phase plan instead. Splitting is for independent shipping/parallel
  agents/different surfaces.
- §Sub-issue sizing: note that XS/S children of one feature are planned as
  ONE group plan downstream (Phase 2), so per-child estimates size *phases*.
- §Plan-of-plans emission: unchanged mechanically, but note the group-plan
  handoff (children are batch-planned by `plan --mode auto`).

#### 3. `ralph/skills/hero/state-machine.md`

`PR (per issue)` → `PR (per feature plan — one PR closes all group members)`.

### Success Criteria

#### Automated Verification
- [x] `bash scripts/check-doc-rosters.sh` (docs consistency)

#### Manual Verification
- [ ] A fresh `/ralph:caretake --mode split` on an M issue produces children only at genuinely independent boundaries (spot-check reasoning in the split comment)

## Phase 4: Hero + impl group-cycle consistency

- **depends_on**: [phase-2]

### Overview

Make the queue-drain paths honor the group unit end-to-end and resolve the
worktree-ID inconsistency.

### Changes Required

#### 1. `ralph/skills/impl/SKILL.md` — `--mode pr` Step 1 (queue-pick)

Queue-pick must resolve a candidate issue to its **plan's worktree ID**
(group → `GH-[primary]`) before checking `worktrees/<ID>` and open-PR state,
and must de-duplicate candidates that share a plan (first member wins; PR
closes all). Today it checks `worktrees/GH-NNN` per child.

#### 2. `ralph/skills/impl/worktree-setup.md` — §Auto-mode Step 2

Reconcile the WORKTREE_ID table with group plans: "Group plan" row already
exists; clarify that epic-member row applies only when NO group plan declares
the member (group row wins), so `--mode pr` and worktree setup agree.

#### 3. `ralph/skills/hero/dispatch.md` + `task-graph.md`

- dispatch.md: note that PLAN/IMPLEMENT/PR/INTEGRATE operate on the plan
  group; after a group plan lands, hero treats all members as one pipeline
  unit (already the default-mode shape) — update the classify/auto path to
  skip members whose group is already in-flight (their plan/PR train exists).
- task-graph.md: "Create PR GH-[PRIMARY]" wording already correct; add a line
  that member issues NEVER get their own PR task.

#### 4. `ralph/skills/review/merge-gate.md` (verify, likely small)

Confirm queue-pick and close-out logic key on the PR (not per-issue), and
that per-child `__CLOSE__` transitions cover all `github_issues` members.

### Success Criteria

#### Automated Verification
- [x] Hook test sweep passes (impl-postcondition, merge gates)

#### Manual Verification
- [ ] Dogfood continuation from Phase 2: `/ralph:impl --auto` executes phases in ONE worktree `GH-[primary]`; `/ralph:impl --mode pr` creates ONE PR with N `Closes #` lines; merge moves all children to Done and parent auto-advances

## Phase 5: Tier routing by unit size

- **depends_on**: [phase-2]

### Overview

Fable bookends for feature/epic units; sonnet/opus fast path for singles.
All routing via per-invocation `Agent(model=...)`/dispatch choice — zero
frontmatter changes.

### Changes Required

#### 1. `ralph/skills/plan/SKILL.md` — `--mode auto`

- **Group/feature unit** (Phase 2 branch, or single issue with estimate M):
  author inline as today (skill session is `best` → fable where entitled).
- **Single XS/S**: fork `Agent(subagent_type="ralph:plan-agent",
  model="sonnet", prompt=<planning procedure + issue context>)` and relay its
  plan doc; the skill session does intake/locking/state only. This removes
  fable spend from single-issue planning.

#### 2. `ralph/skills/plan/plan-review.md` + `ralph/skills/hero/dispatch.md` §Plan review gate

- Group/epic plan review: unchanged (inline `best`, or review-agent at its
  fable default).
- Single XS/S review: dispatch `Agent(subagent_type="ralph:review-agent",
  model="opus", ...)`.

#### 3. `ralph/skills/hero/dispatch.md` §Phase → verb mapping

RESEARCH row: for issues with estimate M+ or `kind:epic`/`kind:feature`,
dispatch research via `Agent(subagent_type="ralph:research-agent",
model="fable", ...)` instead of inline Skill(); XS/S singles keep the inline
sonnet path. Note the `CLAUDE_CODE_SUBAGENT_MODEL` flattening caveat.

#### 4. `ralph/skills/review/SKILL.md` — `--mode val`

Group plans and epics: dispatch val-agent with `model="fable"` (plan-vs-
delivery intent judgment); singles stay sonnet.

#### 5. `docs/model-tier-policy.md`

New section "Tier routing by unit size": the unit table (single XS/S →
sonnet plan / opus review / sonnet val; feature group → fable research/plan/
critique/val; epic → fable bookends + per-feature cycles), the
per-invocation-param mechanism, and the escape-hatch caveat. Update the
"Default tier by surface" table footnotes accordingly.

#### 6. Root `CLAUDE.md` model-tier notes

Update the 9-verb table's plan/review/hero rows to mention unit-size routing
(keep it one line each; policy doc carries the detail). Run
`scripts/check-doc-rosters.sh` to confirm roster consistency.

### Success Criteria

#### Automated Verification
- [ ] `bash scripts/check-doc-rosters.sh`
- [ ] `cd mcp-server && npx vitest run src/__tests__/skill-frontmatter.test.ts` (no frontmatter drift)

#### Manual Verification
- [ ] `/ralph:plan --auto` on a single XS issue shows a sonnet plan-agent fork (transcript check); on a group, inline fable authoring
- [ ] Non-Fable simulation: with `CLAUDE_CODE_SUBAGENT_MODEL=opus`, all forks resolve to opus without error

## Phase 6: Haiku deterministic tests + opus browser/BDD stage

- **depends_on**: [phase-4]

### Overview

Add the two missing verification tiers to the feature cycle.

### Changes Required

#### 1. `ralph/skills/impl/phase-execution.md` — §Phase quality review step 6

Replace "run the phase's automated verification commands" (inline) with a
haiku test-runner fork: `Agent(subagent_type="general-purpose",
model="haiku", prompt=<run each Automated Verification command; parse actual
results (never trust exit 0 alone); report PASS/FAIL per command with the
failing output verbatim>)`. On FAIL, the (sonnet) impl session attempts one
fix, re-runs via the same fork, then commits-what-works and stops for human
intervention (existing behavior).

#### 2. `ralph/skills/review/SKILL.md` + new sibling `ralph/skills/review/behavior-verification.md`

New close-out stage between code review and merge, for **group/feature PRs
only** (single XS/S PRs skip it): if the PR diff matches the Scout-Trigger UI
heuristic (`ralph/skills/impl/pr-creation.md` §Scout Trigger globs) AND
ralph-playwright is installed, dispatch an opus agent that: reads the plan's
Manual Verification items + feature acceptance criteria, generates/executes
stories via ralph-playwright (`story-gen` → `test-e2e` pipeline) against the
worktree's running app, and returns PASS / FAIL-with-evidence
(screenshots + console errors). FAIL blocks merge and posts a
`## Behavior Verification` comment with findings; no-UI-match or no
ralph-playwright → skip silently with a one-line note. (Decision D3:
blocking-when-UI; revisit after dogfooding.)

#### 3. `docs/model-tier-policy.md`

Add both stages to the surface table (haiku test-runner; opus behavior
verification).

### Success Criteria

#### Automated Verification
- [ ] Hook test sweep passes (no gate regressions on the extended review flow)
- [ ] `bash scripts/check-doc-rosters.sh`

#### Manual Verification
- [ ] Dogfood a UI-touching feature group: behavior-verification stage runs, produces screenshots, and its verdict gates the merge
- [ ] Dogfood a backend-only group: stage skips with the one-line note

## Phase 7: Epic close-out validation (fable bookend)

- **depends_on**: [phase-5]

### Overview

Close the epic-level cycle: when the last feature child of an epic reaches
Done, validate delivered-vs-intent at fable before the epic is considered
closed.

### Changes Required

#### 1. `ralph/skills/hero/dispatch.md` §Merge gate + `ralph/skills/review/merge-gate.md`

After a merge that closes the LAST open child of an epic (detectable from
`list_sub_issues(parent)` post-merge), dispatch
`Agent(subagent_type="ralph:val-agent", model="fable", prompt=<epic
plan-of-plans + all feature plans + merged PR list; verdict: does the
delivered whole satisfy Strategic Context + Integration Strategy? list
gaps>)`. Post the verdict as `## Epic Close-Out Validation` comment on the
epic. GAPS verdict → move epic to "Human Needed" instead of letting
`advance-parent.yml` close it silently... (note: the workflow advances the
parent on child closure regardless; the validation comment + Human Needed
transition is the guard, applied immediately after).

#### 2. `ralph/skills/hero/state-machine.md`

Document the epic-level outer cycle: fable research/decomposition →
per-feature cycles (fable plan/critique → sonnet impl → haiku tests →
opus behavior → one PR) → fable epic close-out validation.

### Success Criteria

#### Automated Verification
- [ ] Hook test sweep + doc-roster check pass

#### Manual Verification
- [ ] Dogfood: complete a 2-feature epic; observe the close-out validation comment on the epic and correct verdict routing

## Testing Strategy

### Unit Tests
- Hook tests: new `merge-review-decision-gate-group.test.sh` (Phase 1);
  existing sweep must stay green through every phase.
- `skill-frontmatter.test.ts` guards against accidental `model:` frontmatter
  drift (Phase 5 makes zero frontmatter changes — the test proves it).

### Integration Tests
- The dogfood thread that runs through Phases 2→4→6→7 manual criteria: one
  M split → group plan → one PR → merge → children Done → parent advanced,
  then a 2-feature epic for the close-out bookend.

### Manual Testing Steps
1. `RALPH_AUTOPILOT_ENABLE=true /ralph:hero --mode auto` on a seeded board
   with: 1 standalone XS, 1 M-to-split, 1 L epic.
2. Verify PR count = 1 (XS) + 1 (M's group) + N features (epic) — not one
   per leaf.
3. Verify transcript model tiers per `docs/model-tier-policy.md` §Tier
   routing by unit size.

## Performance Considerations

- Expected PR reduction on decomposed work: N children → 1 PR per feature
  (measured example: 3 → 1, ~120 CI minutes saved per feature at downstream
  pilot rates).
- Fable spend shifts from per-leaf to per-feature/epic bookends; singles drop
  from fable to sonnet/opus — net token cost should fall on both ends.
  Fable's tokenizer (~30% token inflation) argues for keeping its contexts
  small: bookends, not inner loops.
- The haiku test-runner adds one cheap fork per phase but removes test-output
  tokens from the sonnet session's context.

## Migration Notes

- In-flight single-issue plans keep working — the single-issue path is
  unchanged; group planning only triggers on ≥2 open Ready-for-Plan siblings
  under a plan-of-plans parent.
- Existing plan-of-plans docs remain valid; parent-plan reuse still matches
  children by number/title, now preferring a group plan when one exists.
- Existing open PRs and their merge gates are unaffected; Phase 1 tightens
  the carve-out (a group PR that previously slipped through on a first-listed
  XS now requires all-XS — strictly safer).
- Plugin release path: these are `ralph/**` + `docs/**` changes → single PR →
  `release-ralph.yml` bumps the plugin version; no MCP server release needed.

## References

- Research: `thoughts/shared/research/2026-07-08-GH-1538-pr-per-issue-cost-and-feature-batching.md`
- `docs/model-tier-policy.md`
- `ralph/skills/plan/{SKILL.md,plan-shapes.md,intake-routing.md,decomposition.md,plan-review.md}`
- `ralph/skills/impl/{SKILL.md,worktree-setup.md,pr-creation.md,phase-execution.md}`
- `ralph/skills/hero/{SKILL.md,dispatch.md,task-graph.md,state-machine.md}`
- `ralph/skills/review/{SKILL.md,merge-gate.md}`
- `ralph/skills/caretake/split-decomposition.md`
- `ralph/hooks/scripts/merge-review-decision-gate.sh`
- `.github/workflows/{sync-pr-merge.yml,advance-parent.yml}` (read-only)
