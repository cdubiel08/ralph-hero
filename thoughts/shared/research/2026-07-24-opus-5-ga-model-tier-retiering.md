---
date: 2026-07-24
researcher: Chad Dubiel
git_commit: 948f1ab915a3f2eec134397edc92245c53af14d9
branch: worktree-opus5-retiering-research
repository: ralph-hero
topic: "Opus 5 GA: current model tiering across ralph and what re-tiering should change"
tags: [research, model-tiering, opus-5, fable, cost, entitlement, subagents]
status: complete
type: research
---

# Research: Opus 5 GA and the ralph Model-Tier Scheme

## Research Question

Opus 5 is generally available and positioned as the new default model. What is
the current model-tiering scheme across the ralph codebase, and what should
change to re-tier around Opus 5?

## Summary

Three findings drive the plan.

1. **The premise needs one correction.** Opus 5 is **not cheaper than the Opus
   tier ralph already uses** — `claude-opus-5` is $5/$25 per MTok, identical to
   Opus 4.8. What it *is*: **half the price of Fable 5** ($10/$50) while being a
   step-change over Opus 4.8 on exactly the axes ralph reserves fable for —
   deep reasoning, agentic work, long-horizon execution. So the re-tiering
   opportunity is **fable → opus**, not opus → anything.

2. **The fable tier's cost is not its main cost.** Every fable pin in the plugin
   carries an entitlement liability: `model: fable` in agent frontmatter
   hard-errors for accounts without Fable, and the documented rescue
   (`CLAUDE_CODE_SUBAGENT_MODEL=opus`) has a blast radius that flattens *every*
   subagent tier — the haiku locators, the impl complexity ladder, and the
   BLOCKED→opus re-dispatch included. Retiring the two fable agent pins removes
   the need for that env var entirely. That is a correctness win, not just a
   cost one.

3. **The risk is behavioral, not structural.** No hook, CI check, test, or
   MCP-server source file reads model names — the tier surface is markdown
   only, so the mechanical change is small. The real work is that Opus 5's
   documented behavior **reverses two things ralph's prompts were written
   against**: it delegates to subagents *more* readily than Opus 4.8 (which
   under-delegated), and it self-verifies without being told (so explicit
   "verify your work" instructions now cause over-verification). ralph is a
   fan-out-heavy harness with verification scaffolding throughout. Those
   prompts need auditing in the same change, or the re-tier will make the
   plugin slower and more expensive while looking like a pure upgrade.

## Prior Work

The tier scheme is the accumulated result of five prior efforts. The plan must
land on top of two that are still in flight.

| Effort | Doc | Status |
|---|---|---|
| GH-1250 — complexity-driven tiers, impl/split downgraded to sonnet, BLOCKED→opus contract | `plans/2026-05-13-GH-1250-model-tier-optimization-hero.md` | Implemented (PR #1251) |
| GH-1265 — merge dispatch inline `Skill()` → `Agent()` fork so a haiku 200k cap can't compact a 1M parent | `plans/2026-05-15-GH-1265-ralph-merge-agent-dispatch.md` | Implemented |
| GH-1487 — blanket `model: fable` frontmatter pins | `research/2026-06-09-GH-1487-hero-model-pinning-per-phase.md` | **REVERTED** — hard-errors without entitlement |
| `best`-alias re-tier of plan/review | `plans/2026-07-01-plan-review-best-model-tier.md` | **Phases 1–2 complete; Phase 3 (docs) pending** |
| GH-1538 — feature-unit PR batching + tier routing by unit size | `plans/2026-07-08-GH-1538-feature-unit-pr-batching-and-tier-routing.md` | **In flight — Phase 1 complete, 2–7 in progress** |

**The GH-1487 lesson is the central constraint and the central opportunity.**
Blanket fable frontmatter pins were reverted because Claude Code has no
entitlement-based fallback for a bare model pin. GH-1538's workaround was to
express tiering exclusively through per-invocation `Agent(model=...)` params
and touch zero frontmatter. Opus 5 does not have this problem — `opus` is
universally available — so a fable→opus move is the one re-tier that can
*safely* go back into frontmatter.

Two open threads from that history are directly answered by this research:

- *"Should old hero's pins revert to `opus` or `best` now that GH-1538 tier
  routing is active?"* (deferred, `ideas/2026-06-10-fable-native-ralph-artifact-contracts.md` D4)
- *"Token spend per merged issue before/after GH-1250/1265/1538"* — still not
  established. This re-tier should not be the thing that finally forces
  measurement, but it makes measurement more valuable.

## Opus 5 Facts That Matter Here

Sourced from the bundled `claude-api` skill reference (models table, Opus 5
migration section), not from recall.

| Model | ID | Input $/MTok | Output $/MTok | Context |
|---|---|---|---|---|
| Fable 5 | `claude-fable-5` | $10.00 | $50.00 | 1M |
| **Opus 5** | `claude-opus-5` | **$5.00** | **$25.00** | 1M |
| Opus 4.8 | `claude-opus-4-8` | $5.00 | $25.00 | 1M |
| Sonnet 5 | `claude-sonnet-5` | $3.00 ($2.00 intro to 2026-08-31) | $15.00 ($10.00 intro) | 1M |
| Haiku 4.5 | `claude-haiku-4-5` | $1.00 | $5.00 | 200K |

- Positioned as "a step-change over Claude Opus 4.8, strongest on deep
  reasoning, agentic and long-horizon work, at **half the cost of Claude Fable
  5**" — with Fable 5 explicitly retained as the highest-capability tier.
- **"Faster"** resolves to two distinct things: fast mode (`speed: "fast"`, up
  to 2.5× output tok/s, $10/$50, Claude API only — surfaced in Claude Code as
  `/fast`), and unusually strong quality at `low`/`medium` effort, which is the
  primary latency/cost lever.
- Prompt-cache minimum halves to **512 tokens** (from 1024 on Opus 4.8).
- **Separate rate-limit bucket** — Opus 5 does not draw from the combined Opus
  4.x pool.
- Elevated cybersecurity safeguards: can return `stop_reason: "refusal"`.
  Not applicable to ralph (see Non-Findings).

## Current Tiering — Complete Inventory

### Mechanism 1: static frontmatter pins

Nine skill sessions and sixteen agents. This is the fallback tier whenever an
`Agent()` call omits a `model` param.

| Tier | Skill sessions | Agents |
|---|---|---|
| `haiku` | `setup` | `catch-up-agent`, `merge-agent`, `log-reader`, `codebase-locator`, `thoughts-locator`, `codebase-pattern-finder` |
| `sonnet` | `hero`, `research`, `impl`, `caretake` | `impl-agent`, `research-agent`, `val-agent`, `triage-agent`, `sre-fixit`, `codebase-analyzer`, `thoughts-analyzer`, `web-search-researcher` |
| `best` | `plan`, `review` | — |
| `fable` | `hero-fable` | **`plan-agent`, `review-agent`** |

### Mechanism 2: per-invocation `Agent(model=...)` — where the branching lives

| Site | Branch condition | Tier |
|---|---|---|
| `ralph/skills/hero/dispatch.md:26-27` | estimate M+ or `kind:epic`/`kind:feature` | `model="fable"` (overrides research-agent's sonnet pin); XS/S stays inline `Skill()` |
| `ralph/skills/plan/SKILL.md:160` | single XS/S, no group | `model="sonnet"` (downgrade from plan-agent's fable pin); group/M authored inline at `best` |
| `ralph/skills/plan/plan-review.md:142` | single XS/S plan | `model="opus"`; group/M/plan-of-plans omit the param → falls through to review-agent's fable pin |
| `ralph/skills/review/SKILL.md:92` | group plan or plan-of-plans | `model="fable"` (upgrade from val-agent's sonnet pin); XS/S keeps sonnet |
| `ralph/skills/review/merge-gate.md:124` | — | `model="fable"` |
| `ralph/skills/review/behavior-verification.md:33` | 3-condition eligibility gate | `model="opus"` — opus-or-skip, no cheaper else-branch |
| `ralph/skills/impl/phase-execution.md:46` | unconditional | `model="haiku"` (task reviewer) |
| `ralph/skills/impl/phase-execution.md:69` | unconditional | `model="opus"` (phase quality reviewer) |
| `ralph/skills/impl/phase-execution.md:73` | unconditional | `model="haiku"` (deterministic test-runner) |
| `ralph/skills/impl/phase-execution.md:25` | per-task `complexity:` field | haiku / sonnet / opus — **mapping never written down** (see Findings) |

### Mechanism 3: BLOCKED → opus re-dispatch

A verdict-string contract, not config. impl-agent emits
`IMPL BLOCKED model=<current> needs=opus reason=<short>`
(`phase-execution.md:57`); `impl-postcondition.sh:34` greps the unanchored
prefix in the JSONL transcript and exits 0; `dispatch.md:43-60` prefix-matches
the returned verdict and re-dispatches once with `RALPH_IMPL_MODEL=opus`,
escalating to Human Needed on a second BLOCKED.

### Mechanism 4: env vars

`RALPH_IMPL_MODEL` (default `sonnet`, read at `dispatch.md:38`) — the only wired
model env var in the plugin. `CLAUDE_CODE_SUBAGENT_MODEL` is harness-native, not
ralph plumbing, and sits **above** everything: it overrides frontmatter *and*
per-invocation params for every subagent.

## Detailed Findings

### F1 — The fable bookends are the re-tiering target, and the argument is entitlement before cost

`docs/model-tier-policy.md:49-56` states the rule: the only surfaces that
justify a frontier tier are those where *"the tier's own output IS the artifact
under judgment... with no independent mechanism to detect a bad one"* — plan
authoring and review verdicts. GH-1538 then concentrated fable spend on four
judgment bookends of feature/epic cycles (research, plan, critique, plan-vs-
delivery val) on the rationale that *"singles are small enough that sonnet/opus
+ the deterministic gates catch failures"* (`model-tier-policy.md:107-111`).

Opus 5 attacks that rationale directly: it is the tier explicitly characterized
as a step-change on deep reasoning and long-horizon agentic work, at half
fable's price. The judgment-surface argument for a frontier tier does not
disappear — it just gets satisfied at a lower rung.

The stronger argument is entitlement. Today:

- `plan-agent.md:4` and `review-agent.md:4` pin `model: fable`.
- Non-Fable accounts must set `CLAUDE_CODE_SUBAGENT_MODEL=opus` to use the
  `Agent()`-fork path at all.
- That env var is documented (`model-tier-policy.md:120-128`, CLAUDE.md) as
  having a **blast radius across every subagent** — it beats the per-invocation
  param, so it simultaneously flattens the haiku locators, the impl complexity
  ladder, and the BLOCKED→opus re-dispatch.

So on any non-Fable account, the currently-shipped configuration is either
*broken* (no env var → fork path hard-errors) or *silently un-tiered* (env var
set → every tier in the plugin collapses to opus). Moving the two agent pins
`fable` → `opus` deletes that whole failure mode. **`CLAUDE_CODE_SUBAGENT_MODEL`
stops being required at all**, and the documented blast-radius warning can be
removed rather than merely restated.

The per-invocation `model="fable"` sites (`dispatch.md:27`,
`review/SKILL.md:92`, `merge-gate.md:124`) carry the same entitlement exposure
and are the same decision.

### F2 — `best` already silently upgraded, and that is the free half of the change

`plan` and `review` skill sessions pin `model: best`, which resolves to Fable 5
where entitled and **latest Opus otherwise**. Since Opus 5 is now latest Opus,
every non-Fable account's plan and review sessions already moved from Opus 4.8
to Opus 5 with no code change. No action required — but the policy doc's
framing of `best` as a graceful *degradation* is now wrong, and should be
restated: for most accounts `best` is now a genuinely strong tier, not a
consolation prize.

This also reframes the fable-vs-opus decision. If plan/review *sessions* on
non-Fable accounts are already producing acceptable artifacts at Opus 5, the
case for keeping the *agents* on fable is correspondingly weaker.

### F3 — Opus 5 reverses the subagent-delegation behavior ralph's prompts were tuned against

This is the highest-risk finding and the one most likely to be missed.

The migration guidance is explicit that Opus 4.8 **under**-reached for subagents
and needed prompting to delegate, while Opus 5 "reaches for them freely, which
multiplies cost and latency," with the instruction: *"any 'delegate more'
guidance you added for Opus 4.8 should come out, and you likely want an explicit
cap."*

ralph is unusually exposed here — fan-out is the architecture:

- `ralph/skills/research/research-shapes.md` — the investigator palette,
  dispatched in parallel.
- `ralph/skills/impl/phase-execution.md` — per-task sub-agents plus a task
  reviewer plus a phase reviewer plus a test-runner fork.
- `ralph/skills/plan/` — critique forks.
- The `research-investigators` Dynamic Workflow behind `RALPH_USE_WORKFLOWS`.

Any surface that moves to Opus 5 needs its delegation prose audited in the same
change: remove encouragement written for 4.8, and add an explicit spawn cap.
Note the exposure is not limited to surfaces we re-tier — the `best`-pinned
plan/review sessions from F2 are *already* on Opus 5 on non-Fable accounts, so
this audit is owed regardless of whether the fable pins move.

### F4 — Over-verification: delete prompt-level self-checks, keep harness gates

Opus 5 "verifies its own work without being asked," and the guidance is that
instructions telling it to verify now cause over-verification — *"removing them
reduces over-verification with no capability regression."* This is called out as
inverting a standard prompting best practice, and applies to per-prompt
phrasing like "double-check your answer" as well as harness-level duplicate
verification steps.

ralph has verification language across `plan-vs-impl-rubric.md`,
`phase-execution.md` (phase quality review), `val-agent`, and `review/SKILL.md`.

**The plan must draw a line here, and it is not the obvious one.** ralph's
verification comes in two kinds:

- **Deterministic gates** — hook scripts, postcondition validators, the haiku
  test-runner fork, `VALIDATION PASS/FIX/FAIL` verdict parsing. These are
  harness control flow. They are *not* model self-checks and must **stay**;
  deleting them would remove the independent detector that the entire tier
  policy is justified on (`model-tier-policy.md:49-56`).
- **Prompt-level self-check instructions** — "double-check", "re-verify before
  responding", "include a final verification step". These are what the guidance
  says to delete.

Conflating the two would be the most damaging possible misreading of the
migration guide in this codebase. The audit must be per-instruction, not
per-file.

### F5 — Scope expansion collides with ralph's phase discipline

Opus 5 "can add steps the user didn't request, or apply its own judgment about
what the task should be without making that clear." ralph's impl contract is
built on the opposite: one phase per invocation, plan compliance, file
ownership. The migration guide supplies a scope-discipline instruction that
reduced scope changes to near zero in testing.

`impl-agent` is currently `sonnet` and would only be exposed via
`RALPH_IMPL_MODEL=opus` or the BLOCKED escalation — but that escalation path is
exactly where a model is already struggling, and is the worst place to also
introduce scope drift. If the BLOCKED rung remains opus (it should), the
scope-discipline instruction belongs in `impl-agent` or
`phase-execution.md` regardless of whether impl's default tier changes.

### F6 — The complexity ladder's model mapping is undocumented

`phase-execution.md:25` states that `complexity: low | medium | high` "selects
the sub-agent model (haiku / sonnet / opus)" but **the literal mapping is never
written as a table in any file**. The intended low→haiku, medium→sonnet,
high→opus reading is inferable only from the parenthetical's ordering.

This is a latent defect independent of Opus 5, and the re-tier is the natural
moment to fix it — especially since Opus 5's strength at `low`/`medium` effort
makes the `high` rung materially more capable at unchanged price.

### F7 — Tiering policy is duplicated across files with no shared constant

The "single XS/S → cheap, group/M+ → fable" pattern is re-implemented
independently in three places, with three *different* cheap-branch choices:

- `plan/SKILL.md:160` — XS/S plan authoring forks at `sonnet`
- `plan-review.md:142` — XS/S plan critique forks at `opus`
- `review/SKILL.md:92` — XS/S validation stays at val-agent's `sonnet` pin

Each states its own branch condition in prose and its own literal model string.
`docs/model-tier-policy.md` is cross-referenced **by name** from
`dispatch.md:27`, `plan-review.md:143`, `behavior-verification.md`,
`impl-agent.md`, `state-machine.md`, `intake-routing.md`, and `CLAUDE.md` — but
it is documentation, never programmatically consulted. A policy change touches
one file; a change to the *unit-size threshold* would need consistent manual
edits across four.

Implication for sequencing: a fable→opus re-tier is a find-and-replace across
known sites, but it does nothing to reduce this duplication. Consolidating the
routing table is a separate, larger change that should not be bundled in.

### F8 — Rate-limit bucket separation

Opus 5 does not draw from the combined Opus 4.x pool. Moving fable bookends to
opus concentrates autonomous drain traffic onto the Opus 5 bucket — while
simultaneously *relieving* the fable bucket. Worth confirming tier limits before
a full autopilot drain, but this is a pre-flight check, not a blocker.

## Non-Findings (deliberately out of scope)

Several prominent Opus 5 migration items **do not apply** and should not appear
in the plan:

- **API-level breaking changes** — thinking-on-by-default, the
  `thinking: {type: "disabled"}` + `xhigh`/`max` 400, `max_tokens` headroom,
  `budget_tokens` removal, sampling-parameter rejection. ralph never calls the
  Messages API; `mcp-server/src` contains no model references. Claude Code
  manages all of this. Confirmed by grep across `mcp-server/src`.
- **`stop_reason: "refusal"` handling and `fallbacks`** — same reason.
- **Fast mode** — a Claude Code `/fast` session toggle, not something a skill
  frontmatter pin can express. Worth mentioning in the policy doc as an
  operator lever; not a plugin change.
- **Prompt-cache 512-token minimum** — a free improvement, no action.

## Files Affected

If the plan proceeds along F1/F2's fable→opus line:

**Pins (mechanical):**
- `ralph/agents/plan-agent.md:4` — `model: fable` → `opus`
- `ralph/agents/review-agent.md:4` — `model: fable` → `opus`
- `ralph/skills/hero/dispatch.md:27` — RESEARCH fork `model="fable"`
- `ralph/skills/review/SKILL.md:92` — val-agent fork `model="fable"`
- `ralph/skills/review/merge-gate.md:124` — `model="fable"`
- `ralph/skills/plan/plan-review.md:142-151` — reconcile the XS/S `model="opus"`
  branch, which becomes identical to the group branch and can collapse

**Behavioral audit (the real work — F3/F4/F5):**
- `ralph/skills/research/research-shapes.md` — delegation caps
- `ralph/skills/impl/phase-execution.md` — delegation caps, complexity-mapping
  table (F6), scope discipline
- `ralph/skills/review/plan-vs-impl-rubric.md` — prompt-level self-checks only
- `ralph/agents/impl-agent.md` — scope discipline
- `ralph/agents/plan-agent.md`, `ralph/agents/review-agent.md` — verification prose

**Docs (CI-checked rosters — must be same PR):**
- `docs/model-tier-policy.md` — the tier table, the `best` framing (F2), the
  `CLAUDE_CODE_SUBAGENT_MODEL` blast-radius section (removable per F1), a new
  Opus 5 behavioral-notes section
- `CLAUDE.md` — verb/tier table, env-var table
- Cross-referencing files: `ralph/skills/hero/state-machine.md`,
  `ralph/skills/plan/intake-routing.md`,
  `ralph/skills/review/behavior-verification.md`

**Not affected:** `mcp-server/**` (no model references), `ralph/hooks/**` (no
hook greps model names), `.github/workflows/**`, any test file.

## Open Questions for the Plan

1. **Does fable survive anywhere?** `hero-fable` is explicitly the experimental
   opt-in rail-free surface and should keep its `fable` pin regardless. The
   question is whether the *judgment bookends* keep fable as an opt-in upgrade
   (e.g. behind an env var) or drop it entirely. Dropping it entirely is what
   eliminates `CLAUDE_CODE_SUBAGENT_MODEL`.
2. **Do the sonnet surfaces move?** `hero`, `research`, `impl`, `caretake` were
   re-tiered opus→sonnet on 2026-06-30 on the bet that Sonnet 5 needed opus
   less often — explicitly accepting risk, since only impl has a BLOCKED-style
   detector. Opus 5 widens the capability gap again, but at 1.67× sonnet's
   price. This is a cost judgment, not a correctness one, and should probably
   be deferred to a separate change with measurement behind it.
3. **Sequencing against GH-1538.** GH-1538 phases 2–7 are in flight and are the
   source of most `model="fable"` dispatch sites. Re-tiering those sites while
   the plan that creates them is mid-execution risks conflicts. Options: land
   after GH-1538 completes, or fold the tier change into its remaining phases.
4. **Measurement.** Token spend per merged issue was never baselined across
   GH-1250/1265/1538. A fable→opus move has a clean predicted effect (≈50% on
   affected bookends), making it an unusually good candidate for a first
   measurement — but only if a baseline is captured before the change.

## Recommendation

Split into two changes.

**Change A (high confidence, self-contained):** fable → opus on the two agent
pins and the per-invocation fable dispatch sites; delete the
`CLAUDE_CODE_SUBAGENT_MODEL` requirement; update `docs/model-tier-policy.md` and
`CLAUDE.md`; document the complexity-ladder mapping (F6). Justified primarily by
entitlement correctness, with cost as a secondary benefit.

**Change B (needed regardless of A):** the Opus 5 behavioral audit — delegation
caps, prompt-level self-check removal, scope discipline. This is owed *now*,
before any re-tier, because `best`-pinned plan/review sessions on non-Fable
accounts are already running on Opus 5 (F2).

Change B should arguably land first. A alone makes more surfaces Opus 5 without
the prompts being ready for it.
