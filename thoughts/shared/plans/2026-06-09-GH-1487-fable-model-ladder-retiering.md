---
date: 2026-06-09
status: approved
type: plan
tags: [hero, model-tiering, fable, skills, agents]
github_issue: 1487
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1487
primary_issue: 1487
estimate: S
---

# Fable 5 Model-Ladder Re-Tiering — hero parent, research/plan steps, escalation rung

## Prior Work

- builds_on:: [[2026-06-09-GH-1487-hero-model-pinning-per-phase]] (research — primary evidence; full pin map + verified fable-alias support + resolved design decisions D1–D4)
- builds_on:: [[2026-05-13-GH-1250-model-tier-optimization-hero]] (plan — implemented; established complexity-drives-tier + the one-bump BLOCKED contract this plan retargets)
- builds_on:: [[2026-05-15-GH-1265-haiku-context-compaction-integrator-agents]] (research — inline Skill() model/context semantics that make upward pins safe)

## Overview

Shift the top rung of the ralph model ladder to Fable 5 where output quality compounds downstream: the hero parent orchestrator, the research and plan phase sessions, and the Agent()-forked plan/review agents. Retarget the one-shot `IMPL BLOCKED` escalation from opus to fable so the single retry before Human Needed gets the best model. Resurrect `docs/model-tier-policy.md` (deleted with `plugin/ralph-hero/` in GH-1438 but still referenced by `ralph/agents/impl-agent.md:3`) and bring CLAUDE.md's model documentation back in line with reality.

This is a docs/config-only change: markdown frontmatter pins, prose token updates, and one new doc. Zero TypeScript, zero hook scripts.

## Current State Analysis

Model selection is declarative-first (frontmatter pins), env-override-second (`RALPH_IMPL_MODEL`), escalation-third (`IMPL BLOCKED` one-bump). Hero dispatches phases via inline `Skill()`, so phase-skill frontmatter governs phase sessions; `Agent()` dispatches honor agent frontmatter pins. Full map: `thoughts/shared/research/2026-06-09-GH-1487-hero-model-pinning-per-phase.md`.

### Key Discoveries

- `ralph/skills/hero/SKILL.md:5`, `ralph/skills/research/SKILL.md:13`, `ralph/skills/plan/SKILL.md:16` all pin `model: opus` — these three lines ARE the parent/research/plan model selection.
- `ralph/agents/plan-agent.md:4` and `ralph/agents/review-agent.md:4` pin `model: opus` — the only agents on the Agent()-forked plan/review paths (catch-up dispatch recipes).
- `needs=opus` appears in exactly 5 files under `ralph/` (`hero/dispatch.md:38,42`, `impl/SKILL.md:172`, `impl/phase-execution.md:43`, `impl/plan-compliance.md:90`, `agents/impl-agent.md:10`) plus `CLAUDE.md:80`.
- `ralph/hooks/scripts/impl-postcondition.sh:34` greps the bare prefix `IMPL BLOCKED ` — the `needs=` value can change with **zero hook edits**. Hero's dispatch.md likewise matches on the prefix only (`dispatch.md:42`).
- `fable` is an officially documented frontmatter alias for both agents and skills (code.claude.com docs: sub-agents.md, skills.md, model-config.md); full IDs like `claude-fable-5` also accepted. Requires Claude Code v2.1.170+.
- Fable 5 has a 1M context window — the GH-1265 inline-Skill() context-cap trap (haiku 200k squeezing the parent) does not apply to upward pins.
- `RALPH_SPLIT_MODEL` (CLAUDE.md:80) is dead — zero reads anywhere in `ralph/` or `mcp-server/src/`.
- CLAUDE.md's 9-verbs table model column is stale independent of this change (says hero/caretake = sonnet; frontmatter says opus).

## Desired End State

1. A `/ralph:hero` session (any mode) loads at Fable 5.
2. `/ralph:research` and `/ralph:plan` sessions (all modes, including `--mode review`) load at Fable 5, whether invoked directly or dispatched inline by hero.
3. `plan-agent` / `review-agent` dispatched via `Agent()` run at Fable 5.
4. A sonnet impl dispatch that exhausts its budget emits `IMPL BLOCKED model=sonnet needs=fable reason=…`; hero re-dispatches once with `RALPH_IMPL_MODEL=fable`; a second BLOCKED at fable escalates to Human Needed. At most one bump, unchanged.
5. `docs/model-tier-policy.md` exists with the 4-tier ladder; `impl-agent.md:3`'s reference resolves.
6. CLAUDE.md carries no `RALPH_SPLIT_MODEL` mention, no `needs=opus`, and a verb table matching actual frontmatter pins.

### Verification

- `grep -rn "needs=opus" ralph/ CLAUDE.md` → no matches.
- `grep -l "^model: fable"` over the 5 pin files → all 5 listed.
- `test -f docs/model-tier-policy.md` succeeds.
- Hook test suite passes unchanged.
- Manual: hero session statusline shows Fable 5; `claude --version` ≥ 2.1.170.

## What We're NOT Doing

- NOT changing impl's internal complexity ladder (`low→haiku / medium→sonnet / high→opus` in `phase-execution.md:11,26,32,55` stays — code execution rarely needs fable; BLOCKED covers exceptions).
- NOT changing investigator agent tiers (locators/pattern-finder/log-reader haiku; analyzers/web-search/sre-fixit sonnet).
- NOT changing `review/SKILL.md` or `caretake/SKILL.md` pins (stay opus) or any other per-phase agent pins (research-agent/impl-agent/val-agent/triage-agent sonnet; merge-agent/catch-up-agent haiku).
- NOT adding new env vars (`RALPH_PLAN_MODEL` etc.) — skill frontmatter cannot be env-overridden by the harness; unwired vars are noise (D3).
- NOT touching any hook script, the mcp-server, or `.mcp.json`.
- NOT changing the one-bump escalation contract to a multi-step ladder (D2 kept single bump).

## Implementation Approach

Three phases. Phases 1 and 2 are independent file sets (frontmatter pins vs escalation prose) and can run in parallel; Phase 3 documents the end state and depends on both. Every edit is enumerated below with exact before/after tokens so implementation is mechanical (all tasks `complexity: low`).

## Phase 1: Fable frontmatter pins

depends_on: null

### Overview

Move the five top-rung pins from `opus` to `fable`.

### Changes Required

#### 1. Skill session pins

**File**: `ralph/skills/hero/SKILL.md`
**Changes**: line 5 `model: opus` → `model: fable`

**File**: `ralph/skills/research/SKILL.md`
**Changes**: line 13 `model: opus` → `model: fable`

**File**: `ralph/skills/plan/SKILL.md`
**Changes**: line 16 `model: opus` → `model: fable`

#### 2. Agent pins (Agent()-forked plan/review paths)

**File**: `ralph/agents/plan-agent.md`
**Changes**: line 4 `model: opus` → `model: fable`

**File**: `ralph/agents/review-agent.md`
**Changes**: line 4 `model: opus` → `model: fable`

### Tasks

#### Task 1.1: flip the five model pins
- **files**: `ralph/skills/hero/SKILL.md` (modify), `ralph/skills/research/SKILL.md` (modify), `ralph/skills/plan/SKILL.md` (modify), `ralph/agents/plan-agent.md` (modify), `ralph/agents/review-agent.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] `grep -l "^model: fable" ralph/skills/hero/SKILL.md ralph/skills/research/SKILL.md ralph/skills/plan/SKILL.md ralph/agents/plan-agent.md ralph/agents/review-agent.md | wc -l` prints `5`
  - [ ] `grep -n "^model: opus" ralph/skills/hero/SKILL.md ralph/skills/research/SKILL.md ralph/skills/plan/SKILL.md ralph/agents/plan-agent.md ralph/agents/review-agent.md` prints nothing

### Success Criteria

#### Automated Verification
- [ ] `grep -l "^model: fable" ralph/skills/hero/SKILL.md ralph/skills/research/SKILL.md ralph/skills/plan/SKILL.md ralph/agents/plan-agent.md ralph/agents/review-agent.md | wc -l` → `5`
- [ ] `grep -rn "^model:" ralph/skills/review/SKILL.md ralph/skills/caretake/SKILL.md ralph/skills/impl/SKILL.md` still shows `opus` (out-of-scope pins untouched)

#### Manual Verification
- [ ] `claude --version` ≥ 2.1.170 on the host machine
- [ ] Fresh `/ralph:hero` invocation shows Fable 5 as the active model (statusline or `/model`)
- [ ] `/ralph:plan --mode review` on any plan loads at Fable 5

## Phase 2: Escalation retarget — `needs=opus` → `needs=fable`

depends_on: null

### Overview

Retarget the one-shot BLOCKED escalation token and its surrounding tier prose in the five `ralph/` files. The detection surfaces (hero `dispatch.md:42` prefix match, `impl-postcondition.sh:34` bare-prefix grep) need no edits.

### Changes Required

#### 1. Hero dispatch contract

**File**: `ralph/skills/hero/dispatch.md`
**Changes** (§Model selection + §BLOCKED escalation):
- Line 38: `Default is \`sonnet\`; opus is used on BLOCKED-escalation (when impl returns \`IMPL BLOCKED needs=opus\`).` → `Default is \`sonnet\`; fable is used on BLOCKED-escalation (when impl returns \`IMPL BLOCKED needs=fable\`).`
- Line 42: full-format example `IMPL BLOCKED model=<x> needs=opus reason=<short>` → `needs=fable` (prefix-match note stays verbatim)
- Line 44: `If this dispatch's model was NOT opus AND no prior opus retry` → `was NOT fable AND no prior fable retry`
- Line 45: `re-dispatch the same issue with \`RALPH_IMPL_MODEL=opus\`` → `RALPH_IMPL_MODEL=fable`
- Line 49: `so a second BLOCKED at opus does not loop` → `at fable`
- Line 50: `If this dispatch's model was opus, OR` → `was fable, OR`

#### 2. Impl skill + references

**File**: `ralph/skills/impl/SKILL.md`
**Changes**: line 172 — `If sub-agent budget exhausts at a non-opus tier, emit \`IMPL BLOCKED model=<current> needs=opus reason=<short>\` and STOP (do NOT escalate to Human Needed; hero re-dispatches at opus once).` → `non-fable tier` / `needs=fable` / `re-dispatches at fable once`

**File**: `ralph/skills/impl/phase-execution.md`
**Changes** (§IMPL BLOCKED escalation):
- Line 40: `AND the current dispatching model is NOT opus` → `is NOT fable`
- Line 43 (code block): `IMPL BLOCKED model=<current> needs=opus reason=<short-reason>` → `needs=fable`
- Line 46: `so hero can re-dispatch with \`model="opus"\` once` → `model="fable"`
- Line 48: `If the current dispatching model IS already opus, fall through … A double-BLOCKED at opus is a real escalation` → both `opus` → `fable`

**File**: `ralph/skills/impl/plan-compliance.md`
**Changes**: line 90 — `emit \`IMPL BLOCKED model=<current> needs=opus reason=<mismatch>\`` → `needs=fable`

**File**: `ralph/agents/impl-agent.md`
**Changes**:
- Line 3 (description): `Escalates to opus on BLOCKED.` → `Escalates to fable on BLOCKED.` (keep `Default sonnet per docs/model-tier-policy.md` — the doc returns in Phase 3)
- Line 10: `(e.g. \`IMPL BLOCKED model=<current> needs=opus reason=<short>\` when the internal retry budget is exhausted below opus)` → `needs=fable` / `below fable`

### Tasks

#### Task 2.1: retarget escalation token + tier prose
- **files**: `ralph/skills/hero/dispatch.md` (modify), `ralph/skills/impl/SKILL.md` (modify), `ralph/skills/impl/phase-execution.md` (modify), `ralph/skills/impl/plan-compliance.md` (modify), `ralph/agents/impl-agent.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] `grep -rn "needs=opus" ralph/` prints nothing
  - [ ] `grep -rln "needs=fable" ralph/` lists exactly the 5 files above
  - [ ] `grep -n "IMPL BLOCKED " ralph/hooks/scripts/impl-postcondition.sh` unchanged (file untouched)

### Success Criteria

#### Automated Verification
- [ ] `grep -rn "needs=opus" ralph/` → no matches
- [ ] `grep -rln "needs=fable" ralph/ | sort` → exactly `ralph/agents/impl-agent.md`, `ralph/skills/hero/dispatch.md`, `ralph/skills/impl/SKILL.md`, `ralph/skills/impl/phase-execution.md`, `ralph/skills/impl/plan-compliance.md`
- [ ] `git diff --stat ralph/hooks/` → empty (no hook changes)
- [ ] Hook tests pass: `for t in ralph/hooks/scripts/__tests__/*.test.sh; do bash "$t" || exit 1; done`

#### Manual Verification
- [ ] Read `ralph/skills/hero/dispatch.md` §BLOCKED escalation end-to-end — the narrative is internally consistent (no stray opus references in the escalation path)

## Phase 3: Documentation — policy doc resurrection + CLAUDE.md alignment

depends_on: [phase-1, phase-2]

### Overview

Restore `docs/model-tier-policy.md` with the 4-tier ladder and update every CLAUDE.md model reference. All CLAUDE.md edits live in this phase (file ownership: CLAUDE.md belongs to Phase 3 only).

### Changes Required

#### 1. New policy doc

**File**: `docs/model-tier-policy.md` (create)
**Changes**: create with exactly this content:

```markdown
# Ralph Model-Tier Policy

Adapted from superpowers/subagent-driven-development. Updated 2026-06-09 for
the Fable 5 ladder (see thoughts/shared/research/2026-06-09-GH-1487-hero-model-pinning-per-phase.md).

## The rule

Complexity drives tier, not role — with one refinement: the few steps whose
output every downstream step inherits (orchestration, research findings, plan
content) are pinned at the frontier tier preemptively.

| Signal                                                  | Tier      | Model  |
| ------------------------------------------------------- | --------- | ------ |
| 1-2 files, fully-specified spec, mechanical             | cheap     | haiku  |
| Multi-file, integration, pattern matching, debugging    | standard  | sonnet |
| Architecture, design judgment, broad-codebase review    | capable   | opus   |
| Orchestration, research synthesis, plan author/critique | frontier  | fable  |

Escalate on BLOCKED, never preemptively (frontier pins above are the
exception, justified by downstream compounding).

## Default tier by surface

| Surface | Model | Pin location |
|---|---|---|
| hero parent session (all modes) | fable | `ralph/skills/hero/SKILL.md` |
| research skill session | fable | `ralph/skills/research/SKILL.md` |
| plan skill session (incl. `--mode review`) | fable | `ralph/skills/plan/SKILL.md` |
| plan-agent / review-agent (`Agent()`-forked) | fable | `ralph/agents/{plan,review}-agent.md` |
| impl / review / caretake skill sessions | opus | respective `SKILL.md` |
| research / impl / val / triage agents, sre-fixit, analyzers | sonnet | `ralph/agents/*.md` |
| merge / catch-up agents, locators, log-reader | haiku | `ralph/agents/*.md` |
| impl per-task sub-agents | haiku/sonnet/opus by `complexity:` | `ralph/skills/impl/phase-execution.md` |

## Per-session overrides

`RALPH_IMPL_MODEL=fable|opus|sonnet|haiku` overrides the impl dispatch tier
(default `sonnet`). It is the ONLY wired model env var in the slim plugin —
per-agent `RALPH_<AGENT>_MODEL` vars from the legacy plugin were never wired;
edit frontmatter instead.

## Escalation contract

When ralph-impl's internal budget exhausts below the top tier it emits a
verdict-prefix line and stops:

```text
IMPL BLOCKED model=<current> needs=fable reason=<short>
```

Hero matches the `IMPL BLOCKED ` prefix (never the full string) and
re-dispatches ONCE with `RALPH_IMPL_MODEL=fable`. A second BLOCKED at fable
escalates to Human Needed via `save_issue(workflowState="__ESCALATE__")`.
`impl-postcondition.sh` also greps only the bare prefix, so the `needs=`
value can change without touching hooks.

## Why not preemptive Fable everywhere?

From the landcrawler-ai 30-day audit (GH-1250):

1. Most impl phases are mechanical when the plan is detailed — sonnet handles
   them. A frontier default wastes tokens on the common case.
2. Failure cases that need a higher tier are detectable (BLOCKED). One retry
   at the top tier costs less than always paying for it.

Fable 5 is pinned preemptively only where quality compounds: hero decisions,
research findings, and plan content feed every downstream phase.

## Fable 5 operational notes

- Requires Claude Code v2.1.170+.
- Priced above opus-tier; its tokenizer yields ~30% more tokens for the same
  content — expect higher per-tick cost on hero/research/plan sessions.
- 1M context window: pinning fable on inline-`Skill()`-loaded skills never
  shrinks the parent context envelope.

## Context window and inline Skill() calls

Inline `Skill()` runs in the parent session — the called skill's `model:`
frontmatter applies to the parent for the duration, INCLUDING its context
cap. `Agent()` forks an isolated context. Rule (GH-1265): any `model: haiku`
skill that may be called from a parent carrying >200k tokens MUST be
dispatched via `Agent()`. Upward pins (opus → fable) are safe inline.
```

#### 2. CLAUDE.md alignment

**File**: `CLAUDE.md`
**Changes**:
- Line 80: `On \`IMPL BLOCKED needs=opus\` verdict, the hero re-dispatches \`impl-agent\` once at \`model="opus"\`. Override default models via \`RALPH_IMPL_MODEL\`, \`RALPH_SPLIT_MODEL\`.` → `On \`IMPL BLOCKED needs=fable\` verdict, the hero re-dispatches \`impl-agent\` once at \`model="fable"\`. Override the default impl tier via \`RALPH_IMPL_MODEL\`. Model-tier rationale: [\`docs/model-tier-policy.md\`](docs/model-tier-policy.md).`
- Env table `RALPH_IMPL_MODEL` row (line ~227): description → `Override model for \`impl-agent\` (e.g. \`sonnet\`, \`opus\`, \`fable\`). Defaults to \`sonnet\`; BLOCKED escalation re-dispatches once at \`fable\`.`
- 9-verbs table (lines ~62-72) "Model tier" column — refresh to match frontmatter reality: `catch-up` → `inherit (haiku narrative agent)`, `form` → `inherit`, `research` → `fable`, `plan` → `fable`, `impl` → `opus session / sonnet ladder`, `review` → `opus`, `caretake` → `opus`, `hero` → `fable`, `setup` → `haiku`.

### Tasks

#### Task 3.1: create docs/model-tier-policy.md
- **files**: `docs/model-tier-policy.md` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] `test -f docs/model-tier-policy.md` succeeds
  - [ ] `grep -c "fable" docs/model-tier-policy.md` ≥ 5
  - [ ] `grep -n "needs=fable" docs/model-tier-policy.md` ≥ 1 hit

#### Task 3.2: align CLAUDE.md
- **files**: `CLAUDE.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] `grep -n "RALPH_SPLIT_MODEL" CLAUDE.md` prints nothing
  - [ ] `grep -n "needs=opus" CLAUDE.md` prints nothing
  - [ ] `grep -n "needs=fable" CLAUDE.md` ≥ 1 hit
  - [ ] 9-verbs table shows `fable` for research, plan, hero rows

### Success Criteria

#### Automated Verification
- [ ] `test -f docs/model-tier-policy.md`
- [ ] `grep -rn "needs=opus" ralph/ CLAUDE.md docs/` → no matches
- [ ] `grep -n "RALPH_SPLIT_MODEL" CLAUDE.md` → no matches
- [ ] `grep -rn "model-tier-policy" ralph/agents/impl-agent.md` still present and now resolves to an existing file

#### Manual Verification
- [ ] `docs/model-tier-policy.md` renders cleanly (tables, nested code block)
- [ ] CLAUDE.md verb-table model column matches every `SKILL.md` frontmatter pin spot-checked

## Testing Strategy

### Unit Tests
None — no TypeScript changes. `cd mcp-server && npm test` should pass untouched (sanity only).

### Integration Tests
Hook test suite: `for t in ralph/hooks/scripts/__tests__/*.test.sh; do bash "$t" || exit 1; done` — proves the `IMPL BLOCKED ` prefix contract survived the token change.

### Manual Testing Steps
1. `claude --version` ≥ 2.1.170.
2. Launch `/ralph:hero` (no args) — confirm session model is Fable 5.
3. Run `/ralph:plan --mode review` against an existing plan — confirm Fable 5 + APPROVED/NEEDS_ITERATION flow unchanged.
4. (Opportunistic) Next time an impl BLOCKED fires in autopilot, confirm hero re-dispatches with `RALPH_IMPL_MODEL=fable` and the retry runs at fable.

## Performance Considerations

Fable 5 costs more than opus per token AND tokenizes ~30% heavier; hero/research/plan sessions are exactly the long-context surfaces, so expect a real per-tick cost increase. This is the intent (D1/D2: best model where quality compounds). If cost becomes a concern, the rollback is the same five one-line frontmatter edits in reverse — no contract changes needed.

## Migration Notes

- Merges touching `ralph/**` auto-bump the plugin via `release-ralph.yml` — no manual version/tag work.
- Local dev picks up edits immediately via the `~/.claude/plugins/cache/ralph/HEAD` symlink; hooks unaffected (none changed).
- Hosts on Claude Code < 2.1.170 won't resolve the `fable` alias — upgrade before pulling, or sessions on those hosts will fail to select the model.
- In-flight `IMPL BLOCKED needs=opus` verdicts (emitted before upgrade, consumed after) still match hero's prefix-only detection; hero will simply re-dispatch at fable per the new dispatch.md. No drain/quiesce needed.

## References

- Research: `thoughts/shared/research/2026-06-09-GH-1487-hero-model-pinning-per-phase.md` (incl. Design Decisions D1–D4)
- Prior tier policy: `thoughts/shared/plans/2026-05-13-GH-1250-model-tier-optimization-hero.md` (PR #1251)
- Skill()/Agent() model semantics: `thoughts/shared/research/2026-05-15-GH-1265-haiku-context-compaction-integrator-agents.md`
- Frontmatter alias docs: code.claude.com/docs/en/sub-agents.md, skills.md, model-config.md
