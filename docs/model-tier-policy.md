# Ralph Model-Tier Policy

Adapted from superpowers/subagent-driven-development. Updated 2026-06-12: the
GH-1487 fable frontmatter pins were reverted — Claude Code has no access-based
model fallback, so a `model: fable` pin hard-errors for any user whose account
lacks Fable entitlement. Fable became opt-in only (superseded 2026-07-01 for
the two judgment agents — see "Fable defaults and the escape hatch" below).
Original re-tiering research:
thoughts/shared/research/2026-06-09-GH-1487-hero-model-pinning-per-phase.md.

Updated 2026-06-30: on Claude Sonnet 5's launch (which substantially narrows
the capability gap to Opus 4.8, including matching it on some agentic tasks
at higher effort), the `hero`, `research`, `impl`, and `caretake` skill
sessions were re-tiered from opus to sonnet. `plan`/`plan-agent` and
`review`/`review-agent` stayed opus (since moved up — see the 2026-07-01
update below) — they are the two surfaces where the tier's own output IS
the artifact under judgment (a plan or a review verdict), with no
independent mechanism to detect a bad one. `impl` already
carried an explicit BLOCKED→opus escalation contract that made its
sonnet-default safe (see "Escalation contract" below); `hero`, `research`,
and `caretake` do NOT have an equivalent auto-detection mechanism today —
this re-tier accepts that risk on the bet that Sonnet 5 needs it less often,
rather than building the contract first. If quality regressions surface on
these three surfaces, extending the BLOCKED-style contract to them (or
reverting the affected surface to opus) is the fix, not silently
compensating elsewhere.

Updated 2026-07-01: with Fable 5 generally released, the two judgment
surfaces move up-tier. `plan`/`review` **skill sessions** pin `model: best`
(a Claude Code resolver alias: Fable 5 where the account has it, else latest
Opus — graceful, entitlement-aware). `plan-agent`/`review-agent` frontmatter
cannot express `best` (the subagent `model:` enum is
`sonnet|opus|haiku|fable|<full-id>|inherit`), so they pin `model: fable` as
the default; non-Fable users rescue the `Agent()`-fork path with the
harness-native `CLAUDE_CODE_SUBAGENT_MODEL=opus`, which Claude Code documents
as the FIRST step in subagent model resolution — it overrides both the
per-invocation `model` param and frontmatter. Plan doc:
thoughts/shared/plans/2026-07-01-plan-review-best-model-tier.md.

## The rule

Complexity drives tier, not role. The highest tier the plugin pins by default
is `best`/`fable` on the two judgment surfaces (plan, review); every other
default pin is opus or below and must work for users without Fable access.
Non-Fable users get opus on the judgment skills automatically (`best`
resolves down) and set `CLAUDE_CODE_SUBAGENT_MODEL=opus` for the two fable
agents.

| Signal                                                  | Tier      | Model  |
| ------------------------------------------------------- | --------- | ------ |
| 1-2 files, fully-specified spec, mechanical             | cheap     | haiku  |
| Multi-file, integration, pattern matching, debugging, orchestration, research synthesis (see 2026-06-30 update above) | standard | sonnet |
| Architecture, design judgment, plan author/critique — no independent mechanism to detect a bad output | capable→frontier | best / fable |
| Frontier (default on plan/review; elsewhere opt-in — requires Fable entitlement) | frontier  | fable  |

Escalate on BLOCKED, never preemptively.

## Default tier by surface

| Surface | Model | Pin location |
|---|---|---|
| hero parent session (all modes) | sonnet | `ralph/skills/hero/SKILL.md` |
| hero-fable session (experimental rail-free surface, opt-in; requires Fable access) | fable | `ralph/skills/hero-fable/SKILL.md` |
| research skill session | sonnet | `ralph/skills/research/SKILL.md` |
| plan skill session (incl. `--mode review`) | best (fable→opus resolver) | `ralph/skills/plan/SKILL.md` |
| review skill session | best (fable→opus resolver) | `ralph/skills/review/SKILL.md` |
| plan-agent / review-agent (`Agent()`-forked) | fable (escape hatch: `CLAUDE_CODE_SUBAGENT_MODEL=opus`) | `ralph/agents/{plan,review}-agent.md` |
| impl / caretake skill sessions | sonnet | respective `SKILL.md` |
| research / impl / val / triage agents, sre-fixit, analyzers | sonnet | `ralph/agents/*.md` |
| merge / catch-up agents, locators, log-reader | haiku | `ralph/agents/*.md` |
| impl per-phase quality reviewer (`Agent()`-dispatched inline, not a named agent file) | opus | `ralph/skills/impl/phase-execution.md` — kept opus as a review-function surface; not touched by this re-tier |
| impl per-task sub-agents | haiku/sonnet/opus by `complexity:` | `ralph/skills/impl/phase-execution.md` |

## Per-session overrides

`RALPH_IMPL_MODEL=fable|opus|sonnet|haiku` overrides the impl dispatch tier
(default `sonnet`). It is the ONLY wired model env var in the slim plugin —
per-agent `RALPH_<AGENT>_MODEL` vars from the legacy plugin were never wired;
edit frontmatter instead.

`CLAUDE_CODE_SUBAGENT_MODEL` (harness-native, not ralph plumbing) is the
escape hatch for the fable-pinned agents: Claude Code resolves every
subagent's model as env var → per-invocation `model` param → frontmatter →
session model, so `CLAUDE_CODE_SUBAGENT_MODEL=opus` rescues
plan-agent/review-agent on non-Fable accounts. **Blast radius warning:** it
is global to ALL subagents — it also flattens the haiku locators, the impl
complexity ladder, and the hero BLOCKED→opus re-dispatch (it beats the
per-invocation param too). Set it only if your account lacks Fable and you
use the `Agent()`-fork path; unset (or `inherit`) otherwise.

## Escalation contract

When ralph-impl's internal budget exhausts below the top tier it emits a
verdict-prefix line and stops:

```text
IMPL BLOCKED model=<current> needs=opus reason=<short>
```

Hero matches the `IMPL BLOCKED ` prefix (never the full string) and
re-dispatches ONCE with `RALPH_IMPL_MODEL=opus`. A second BLOCKED at opus
escalates to Human Needed via `save_issue(workflowState="__ESCALATE__")`.
`impl-postcondition.sh` also greps only the bare prefix, so the `needs=`
value can change without touching hooks.

## Fable defaults and the escape hatch

History: the GH-1487 blanket fable pins were reverted (2026-06-12) because a
frontmatter `model: fable` hard-errors for any account without Fable
entitlement — Claude Code has no entitlement-based fallback for a bare model
pin, and at the time no rescue existed. Two things have since changed:

1. **Skill frontmatter accepts `best`.** The skill `model:` field mirrors
   `/model`, whose `best` alias resolves to Fable 5 where available, else
   latest Opus — an entitlement-aware resolver, safe as a default. (The
   earlier claim here that "`best` is not a valid value anywhere" was
   overbroad: it remains invalid in SUBAGENT frontmatter and in the Agent
   tool's runtime `model` enum, but is valid in skill frontmatter.)
2. **`CLAUDE_CODE_SUBAGENT_MODEL` is documented as top-precedence.** A
   non-Fable user can neutralize the two fable agent pins without editing
   plugin files. This converts the GH-1487 failure from "broken with no
   recourse" to "one env var" — accepted 2026-07-01 for the two judgment
   agents only.

Cost remains the reason everything else stays at opus-or-below (GH-1250
30-day audit): most impl phases are mechanical when the plan is detailed —
sonnet handles them; failure cases that need a higher tier are detectable
(BLOCKED), and one retry at a higher tier costs less than always paying for
it. Fable's tokenizer also yields ~30% more tokens for the same content.

## Fable 5 surfaces

Default-fable (new 2026-07-01):

- `plan`/`review` skill sessions — `model: best` (fable where entitled).
- `plan-agent`/`review-agent` — `model: fable`; non-Fable users set
  `CLAUDE_CODE_SUBAGENT_MODEL=opus`.

Users WITH Fable access additionally opt in via:

- `/ralph:hero-fable` (or `/ralph:hero --model fable`) — explicitly
  experimental rail-free surface.
- `RALPH_IMPL_MODEL=fable` — per-session impl tier override.
- Running the session itself on Fable (`/model fable`) — skills without a
  pin inherit it.

Operational notes for those surfaces:

- Requires Claude Code v2.1.170+ and Fable entitlement (the `best` alias and
  the documented `CLAUDE_CODE_SUBAGENT_MODEL` precedence verified on
  v2.1.198).
- Priced above opus-tier; its tokenizer yields ~30% more tokens for the same
  content — expect higher per-tick cost.
- 1M context window: pinning fable on inline-`Skill()`-loaded skills never
  shrinks the parent context envelope.

## Context window and inline Skill() calls

Inline `Skill()` runs in the parent session — the called skill's `model:`
frontmatter applies to the parent for the duration, INCLUDING its context
cap. `Agent()` forks an isolated context. Rule (GH-1265): any `model: haiku`
skill that may be called from a parent carrying >200k tokens MUST be
dispatched via `Agent()`. Upward pins (opus → fable) are safe inline.
