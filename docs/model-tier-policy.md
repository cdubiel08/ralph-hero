# Ralph Model-Tier Policy

Adapted from superpowers/subagent-driven-development. Updated 2026-06-12: the
GH-1487 fable frontmatter pins were reverted — Claude Code has no access-based
model fallback, so a `model: fable` pin hard-errors for any user whose account
lacks Fable entitlement. Fable is now opt-in only (see "Fable 5 opt-in
surfaces" below). Original re-tiering research:
thoughts/shared/research/2026-06-09-GH-1487-hero-model-pinning-per-phase.md.

## The rule

Complexity drives tier, not role. The highest tier the plugin pins by default
is opus — every default pin must work for users without Fable access.

| Signal                                                  | Tier      | Model  |
| ------------------------------------------------------- | --------- | ------ |
| 1-2 files, fully-specified spec, mechanical             | cheap     | haiku  |
| Multi-file, integration, pattern matching, debugging    | standard  | sonnet |
| Architecture, design judgment, orchestration, research synthesis, plan author/critique | capable | opus |
| Frontier (opt-in only — requires Fable entitlement)     | frontier  | fable  |

Escalate on BLOCKED, never preemptively.

## Default tier by surface

| Surface | Model | Pin location |
|---|---|---|
| hero parent session (all modes) | opus | `ralph/skills/hero/SKILL.md` |
| hero-fable session (experimental rail-free surface, opt-in; requires Fable access) | fable | `ralph/skills/hero-fable/SKILL.md` |
| research skill session | opus | `ralph/skills/research/SKILL.md` |
| plan skill session (incl. `--mode review`) | opus | `ralph/skills/plan/SKILL.md` |
| plan-agent / review-agent (`Agent()`-forked) | opus | `ralph/agents/{plan,review}-agent.md` |
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
IMPL BLOCKED model=<current> needs=opus reason=<short>
```

Hero matches the `IMPL BLOCKED ` prefix (never the full string) and
re-dispatches ONCE with `RALPH_IMPL_MODEL=opus`. A second BLOCKED at opus
escalates to Human Needed via `save_issue(workflowState="__ESCALATE__")`.
`impl-postcondition.sh` also greps only the bare prefix, so the `needs=`
value can change without touching hooks.

## Why no default Fable pins?

Two reasons:

1. **Entitlement (the blocker).** Claude Code resolves `model:` frontmatter
   with no access-based fallback — `model: fable` is a hard runtime error for
   any user whose plan lacks Fable. The GH-1487 pins broke downstream plugin
   users and were reverted (2026-06-12). The Agent tool likewise rejects
   unavailable tiers at input validation; `best` is not a valid value
   anywhere (it is only a `/model` runtime alias).
2. **Cost (the original opus rationale, GH-1250 30-day audit).** Most impl
   phases are mechanical when the plan is detailed — sonnet handles them.
   Failure cases that need a higher tier are detectable (BLOCKED); one retry
   at a higher tier costs less than always paying for it.

## Fable 5 opt-in surfaces

Users WITH Fable access opt in via:

- `/ralph:hero-fable` (or `/ralph:hero --model fable`) — the only frontmatter
  `model: fable` pin in the plugin, on an explicitly experimental surface.
- `RALPH_IMPL_MODEL=fable` — per-session impl tier override.
- Running the session itself on Fable (`/model fable`) — skills without a
  pin inherit it.

Operational notes for those surfaces:

- Requires Claude Code v2.1.170+ and Fable entitlement.
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
