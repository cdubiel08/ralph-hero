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
