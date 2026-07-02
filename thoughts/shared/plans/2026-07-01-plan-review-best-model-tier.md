---
date: 2026-07-01
status: complete
type: plan
tags: [model-tier, fable, plan, review, best-alias]
estimate: S
---

# Retier the plan and review surfaces to `best` (Fable-when-available)

> **Iterated 2026-07-01 (user direction):** go deeper than the skill sessions —
> `plan-agent` / `review-agent` get a **default of `model: fable`**, with the
> escape hatch being the **native** `CLAUDE_CODE_SUBAGENT_MODEL` env var rather
> than opus-floor conservatism or custom ralph plumbing. Verified against the
> sub-agents docs: subagent model resolution order is (1)
> `CLAUDE_CODE_SUBAGENT_MODEL` env var → (2) per-invocation `model` param →
> (3) frontmatter `model:` → (4) session model, and the env var accepts
> aliases. So `CLAUDE_CODE_SUBAGENT_MODEL=opus` overrides the fable pins for
> non-Fable users. The original Phase 1 non-Fable gate is superseded: graceful
> entitlement fallback is no longer assumed anywhere — skills get it natively
> via `best`, agents get it via the documented env var. Tradeoff accepted by
> the user: the env var is global (it flattens EVERY subagent tier, including
> the impl complexity ladder and the hero BLOCKED→opus re-dispatch, since it
> also beats the per-invocation param).

## Prior Work

- builds_on:: [[docs/model-tier-policy.md]] — the 2026-06-12 + 2026-06-30 tier
  rules this plan amends.
- builds_on:: `thoughts/shared/research/2026-06-09-GH-1487-hero-model-pinning-per-phase.md`
  — the GH-1487 fable-pin revert whose failure mode (`model: fable` hard-errors
  for non-Fable users) is exactly what `best` is meant to avoid.
- tensions:: the policy doc currently asserts "`best` is not a valid value
  anywhere (it is only a `/model` runtime alias)". This plan corrects that claim
  — it is true for **subagent frontmatter** and the **Agent() runtime param**,
  but not for **skill frontmatter**.

## Overview

With the Fable 5 release, the user wants `/ralph:plan` and `/ralph:review` to run
on Fable 5 when the user's account has it, and fall back gracefully otherwise —
via the `best` model alias (resolves to "Fable 5 where available, else latest
Opus"). This is the exact access-based fallback that the GH-1487 revert said
Claude Code lacked; `best` supplies it.

The catch, verified against the current Claude Code docs (v2.1.198): `best` is
**not** universally accepted as a `model:` value. It works where the field
mirrors the `/model` command (skill frontmatter) but is rejected where the field
uses the restricted model enum (subagent frontmatter, the `Agent()` runtime
`model` param). This plan applies `best` only where it is valid, and — critically
— gates the change on confirming the non-Fable fallback actually resolves to Opus
rather than hard-erroring, because breaking non-Fable downstream users is the one
failure this repo has already paid for once (GH-1487).

## Current State Analysis

Both surfaces are pinned at `opus` today. The policy doc keeps them at opus (not
sonnet, unlike hero/research/impl/caretake) because "the tier's own output IS the
artifact under judgment (a plan or a review verdict), with no independent
mechanism to detect a bad one."

### Key Discoveries

- **Skill frontmatter accepts `best`; subagent frontmatter does not.** The
  Claude Code sub-agents docs list the valid `model:` values as
  `sonnet | opus | haiku | fable | <full-id> | inherit` — `best` is absent. The
  skills docs say the `model:` field "accepts the same values as `/model`", and
  `/model best` is a documented alias. So `best` is valid in `SKILL.md` but
  invalid in `ralph/agents/*.md`.
- **Hero drives plan/review via inline `Skill()`, not `Agent()` forks** —
  `ralph/skills/hero/dispatch.md:24` routes `PLAN` / `REVIEW (plan)` /
  `INTEGRATE` through `Skill("ralph:<verb>", …)` inline, "sharing hero's context
  for resumability." Per the policy doc's "Context window and inline Skill()
  calls" section, an inline `Skill()` applies the **called skill's `model:`
  frontmatter to the parent for its duration**. So a skill-level `best` pin
  governs the actual plan/review work on **both** the direct-invocation path and
  the hero-dispatched path. The `plan-agent`/`review-agent` `.md` shells are the
  non-default Agent()-fork path ("Hero itself prefers `Skill()` dispatch").
- **The four opus-pinned surfaces:** `ralph/skills/plan/SKILL.md:16`,
  `ralph/skills/review/SKILL.md:5`, `ralph/agents/plan-agent.md:4`,
  `ralph/agents/review-agent.md:4`. Only the first two can take `best`.
- **The Agent() runtime `model` param is a fixed enum** (`sonnet|opus|haiku|fable`
  in this session) — so the impl per-phase quality reviewer
  (`ralph/skills/impl/phase-execution.md:55`, `Agent(… model="opus" …)`) cannot
  take `best` either. Out of scope by mechanism, not preference.
- **No CI check validates model *values*.** `scripts/check-doc-rosters.sh` checks
  agent/skill/tool *name* rosters only. Model-tier docs are maintained by hand
  (see commit `3169e642`), so consistency across CLAUDE.md + the policy doc is a
  manual obligation of this change, not an enforced one.
- **Undocumented risk:** the docs confirm `best` is accepted in skill frontmatter
  but do **not** state what happens when the account lacks Fable *entitlement*
  (as opposed to an org `availableModels` restriction). The `best` alias's
  definition ("Fable where available, else latest Opus") strongly implies a safe
  resolve-to-Opus, but this is inference, not a cited guarantee. Phase 1 gates on
  it.

## Desired End State

1. `/ralph:plan` and `/ralph:review` (direct invocation **and** hero-dispatched)
   run on Fable 5 for users who have it, and on latest Opus for users who don't —
   with no hard-error on any account (skill `best` alias resolves natively).
2. `plan-agent` / `review-agent` default to `model: fable` (their frontmatter
   cannot express `best`); non-Fable users rescue the Agent()-fork path with
   `CLAUDE_CODE_SUBAGENT_MODEL=opus`, which is documented to override
   frontmatter. Documented prominently as the escape hatch.
3. `docs/model-tier-policy.md` and `CLAUDE.md` accurately describe the new pins,
   the escape hatch, and correct the now-partially-false "`best` is not valid
   anywhere" claim. The "only fable pin in the plugin" claims (hero-fable) are
   updated — there are now three.

### Verification

- Confirm `model: best` in a skill loads and resolves to Fable on this (Fable)
  account — see Phase 1.
- Confirm the non-Fable path resolves to Opus without a load error (Phase 1 gate).
- `cd mcp-server && npm test` and `scripts/check-doc-rosters.sh` still pass
  (no roster names change; sanity that nothing else broke).
- Grep shows exactly two `model: best` pins in `ralph/` (the two skills), zero in
  `ralph/agents/`.

## What We're NOT Doing

- **Not** setting `model: best` on `plan-agent.md` / `review-agent.md` — subagent
  frontmatter rejects it. They get `model: fable` instead (user-accepted default),
  with `CLAUDE_CODE_SUBAGENT_MODEL=opus` as the documented non-Fable escape hatch.
- **Not** touching the impl per-phase quality reviewer or per-task implementers —
  those select model via the `Agent()` runtime param, whose enum excludes `best`.
- **Not** wiring any custom `RALPH_*_MODEL` override plumbing for plan/review —
  the escape hatch is the harness-native `CLAUDE_CODE_SUBAGENT_MODEL`, zero code.
- **Not** switching any surface to `model: inherit` — under the now-sonnet hero
  session, `inherit` would drop plan/review from opus to **sonnet**, regressing
  the judgment surfaces. `best` never resolves below opus.
- **Not** retiering research/impl/caretake/hero — out of scope; this is the
  plan+review pair only.

## Implementation Approach

Three phases: (1) a hard verification gate on `best`'s fallback behavior, (2) the
two-line skill pin swap, (3) the doc reconciliation. Phase 2 does not proceed
unless Phase 1's gate passes. Phases 2 and 3 can land in the same PR.

## Phase 1: Verify mechanism (gate) — COMPLETE
depends_on: null

### Overview

Prove the two mechanisms before pinning them into a distributed plugin:
(a) `best` is a valid skill-frontmatter value; (b) the native env var overrides
agent frontmatter so `model: fable` agents are rescuable without file edits.

### Changes Required

No source changes — verification only. **Outcome (verified 2026-07-01 against
the live code.claude.com docs, CLI v2.1.198):**

- Skill frontmatter `model:` "accepts the same values as `/model`" → `best` is
  valid there; `/model best` = Fable 5 where available, else latest Opus.
- Subagent frontmatter enum is `sonnet|opus|haiku|fable|<full-id>|inherit` —
  no `best`. Hence fable-with-escape-hatch for the agents.
- Documented subagent resolution order: `CLAUDE_CODE_SUBAGENT_MODEL` env var →
  per-invocation `model` param → frontmatter → session model. Env var accepts
  aliases. **Escape hatch confirmed.**
- Docs are silent on entitlement fallback for a frontmatter `fable` pin; GH-1487
  showed empirically it hard-errors. The design therefore never relies on
  entitlement fallback: skills use the `best` resolver, agents use the env var.
- Repo gate: `skill-frontmatter.test.ts` requires `model:` non-empty but has no
  value allowlist — `best`/`fable` pass.

### Success Criteria

#### Automated Verification
- [x] Docs citations captured for resolution order + alias support.

#### Manual Verification
- [x] Fable account available locally to smoke-test the pins post-merge.

## Phase 2: Pin `best` on the skills, `fable` on the agents
depends_on: [phase-1]

### Overview

Swap the two skill-session pins `opus` → `best` (covers direct invocation and
inline hero dispatch), and the two agent pins `opus` → `fable` (covers the
Agent()-fork path), with the env-var escape hatch documented in Phase 3.

### Changes Required

#### 1. Plan skill session
**File**: `ralph/skills/plan/SKILL.md`
**Changes**: line 16 `model: opus` → `model: best`.

#### 2. Review skill session
**File**: `ralph/skills/review/SKILL.md`
**Changes**: line 5 `model: opus` → `model: best`.

#### 3. Plan agent (Agent()-fork path)
**File**: `ralph/agents/plan-agent.md`
**Changes**: line 4 `model: opus` → `model: fable`.

#### 4. Review agent (Agent()-fork path)
**File**: `ralph/agents/review-agent.md`
**Changes**: line 4 `model: opus` → `model: fable`.

### Success Criteria

#### Automated Verification
- [ ] `grep -rn "model: best" ralph/skills/` returns exactly the plan + review
      SKILL.md matches.
- [ ] `grep -rn "model: fable" ralph/agents/` returns exactly plan-agent +
      review-agent.
- [ ] `cd mcp-server && npm test` passes (incl. skill-frontmatter contract).
- [ ] `bash scripts/check-doc-rosters.sh` passes.

#### Manual Verification
- [ ] On a Fable account, `/ralph:plan` and `/ralph:review` run on Fable 5.
- [ ] On a non-Fable account: skills fall back to Opus via `best`; agents are
      rescued by `CLAUDE_CODE_SUBAGENT_MODEL=opus` (documented; needs a real
      non-Fable run to confirm end-to-end).

## Phase 3: Reconcile the model-tier docs
depends_on: [phase-2]

### Overview

Make `docs/model-tier-policy.md` and `CLAUDE.md` describe reality, and correct the
overbroad "`best` is not valid anywhere" claim.

### Changes Required

#### 1. Model-tier policy doc
**File**: `docs/model-tier-policy.md`
**Changes**:
- Add a dated `Updated 2026-07-01:` note: plan/review **skill sessions** move to
  `best` (Fable-when-available, else Opus); `plan-agent`/`review-agent` move to
  a **default `model: fable`** (frontmatter can't express `best`), with
  `CLAUDE_CODE_SUBAGENT_MODEL=opus` as the native escape hatch for non-Fable
  accounts (documented to override frontmatter; also note its global blast
  radius — it flattens every subagent tier including the impl ladder).
- In "Default tier by surface", change the plan/review session rows to `best`
  and the `plan-agent / review-agent` row to `fable (escape hatch:
  CLAUDE_CODE_SUBAGENT_MODEL)`.
- Rewrite "Why no default Fable pins?" (premise no longer holds) into "Fable
  defaults and the escape hatch": reason 1's entitlement analysis is updated —
  the GH-1487 hard-error is now mitigated by the documented env-var precedence,
  not avoided by never pinning; correct the overbroad "`best` is not a valid
  value anywhere" sentence (valid in skill frontmatter; invalid in subagent
  frontmatter and the Agent() runtime param).
- Update "The rule" table + the "highest tier the plugin pins by default is
  opus" sentence → plan/review surfaces now default to the frontier tier.
- Update "Fable 5 opt-in surfaces" → hero-fable is no longer "the only
  frontmatter `model: fable` pin"; add the two agent pins and the
  `CLAUDE_CODE_SUBAGENT_MODEL` rescue to the operational notes.

#### 2. Top-level CLAUDE.md
**File**: `CLAUDE.md`
**Changes**:
- Verb tier table: `/ralph:plan` and `/ralph:review` rows `opus` →
  `best (fable→opus)`.
- The hero-fable line "the only fable pin in the plugin" → reworded (plan-agent
  and review-agent now also pin fable, with the env-var escape hatch).
- Environment Variables section: add a `CLAUDE_CODE_SUBAGENT_MODEL` row
  (harness-native, not `RALPH_*`): non-Fable escape hatch for the fable agent
  pins; global to all subagents.

### Success Criteria

#### Automated Verification
- [ ] `grep -n "not a valid value anywhere" docs/model-tier-policy.md` returns
      nothing (the overbroad claim is gone).
- [ ] `grep -n "best" CLAUDE.md docs/model-tier-policy.md` shows the plan/review
      rows updated.
- [ ] `bash scripts/check-doc-rosters.sh` passes.

#### Manual Verification
- [ ] The policy doc no longer contradicts the frontmatter (no surface documented
      at a tier it isn't pinned to).

## Testing Strategy

### Unit Tests
- `cd mcp-server && npm test` — sanity only; no server code changes.

### Integration Tests
- None; the change is frontmatter + docs.

### Manual Testing Steps
1. On this (Fable) account, run `/ralph:plan` on a scratch issue; confirm Fable 5.
2. Confirm the non-Fable fallback per Phase 1's gate before merging.

## Migration Notes

- Minimum Claude Code version: `best` frontmatter support must be present in the
  users' CLI. Local is v2.1.198. Confirm the floor version that ships skill
  `best` support and note it in the policy doc's operational notes if it differs
  from the existing Fable floor (v2.1.170).

## References

- `docs/model-tier-policy.md`
- `ralph/skills/hero/dispatch.md` (inline Skill() dispatch of plan/review)
- Claude Code docs: model-config, sub-agents, skills (frontmatter `model` field)
- GH-1487 revert: `thoughts/shared/research/2026-06-09-GH-1487-hero-model-pinning-per-phase.md`
