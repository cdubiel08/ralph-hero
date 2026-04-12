---
date: 2026-03-19
topic: "Model switching in the plan-of-plans (ralph-plan-epic) workflow"
tags: [research, skills, model-routing, plan-of-plans, opus, sonnet]
status: complete
type: research
---

# Research: Model Switching in the Plan-of-Plans Workflow

## Prior Work

None identified.

## Research Question

When working through the plan-of-plans workflow (`ralph-plan-epic`), there are situations where the model switches from opus to sonnet but doesn't switch back to opus for writing plans. The user wants the entire plan-of-plans workflow to always stay on opus.

## Summary

The plan-of-plans workflow involves a chain of skill invocations with mixed model assignments. Two specific switch points drop from opus to sonnet mid-workflow: `ralph-split` (called in Step 6) and the codebase research subagents. Additionally, when the workflow is invoked from `hero` or `team` orchestrators (both sonnet), there's ambiguity about whether the `context: fork` + `model: opus` frontmatter on called skills actually results in a model switch.

## Detailed Findings

### Complete Model Assignment Map

#### Skills

| Skill | Model | Context | Role in plan-of-plans |
|-------|-------|---------|----------------------|
| `hero` | **sonnet** | _(none)_ | Orchestrator entry point |
| `team` | **sonnet** | _(none)_ | Orchestrator entry point |
| `ralph-plan-epic` | **opus** | fork | Core — writes plan-of-plans |
| `ralph-split` | **sonnet** | fork | Step 6 — creates feature children |
| `ralph-plan` | **opus** | fork | Step 7 — plans each feature |
| `ralph-research` | **sonnet** | fork | Pre-requisite — not called by epic planner directly |
| `ralph-review` | **opus** | fork | Post-plan review |
| `ralph-impl` | **opus** | fork | Implementation (post-planning) |
| `ralph-triage` | **sonnet** | fork | Not part of plan-of-plans |

#### Agents (spawned by ralph-plan-epic Steps 2-3)

| Agent | Model | Role |
|-------|-------|------|
| `codebase-pattern-finder` | **haiku** | Context gathering |
| `codebase-analyzer` | **sonnet** | Context gathering |

### Plan-of-Plans Call Chain

```
hero (sonnet, no fork)
  └─ Skill("ralph-plan-epic")      → opus (context: fork)       [SKILL.md:7-8]
       ├─ Agent(codebase-pattern-finder)  → haiku                [agents/codebase-pattern-finder.md:5]
       ├─ Agent(codebase-analyzer)        → sonnet               [agents/codebase-analyzer.md:5]
       ├─ Steps 1-5: plan-of-plans doc    → opus (same context)
       ├─ Step 6: Skill("ralph-split")    → sonnet (context: fork) [skills/ralph-split/SKILL.md:6]
       │   └─ Returns to epic planner context (opus?)
       └─ Step 7: For each wave:
           └─ Skill("ralph-plan")         → opus (context: fork)  [skills/ralph-plan/SKILL.md:6]
               ├─ Agent(codebase-pattern-finder) → haiku
               ├─ Agent(codebase-analyzer)       → sonnet
               └─ Writes feature plan             → opus
```

### Sonnet Switch Points Within the Workflow

1. **`ralph-split`** — `plugin/ralph-hero/skills/ralph-split/SKILL.md:6` — `model: sonnet`
   - Called at Step 6 of `ralph-plan-epic` to create M-sized feature children
   - This is the primary unexpected model downgrade in the planning workflow

2. **`codebase-analyzer` agent** — `plugin/ralph-hero/agents/codebase-analyzer.md:5` — `model: sonnet`
   - Called during context gathering (Step 2) by both `ralph-plan-epic` and `ralph-plan`
   - Runs as a subagent, so model is set by the agent definition, not the calling skill

3. **`codebase-pattern-finder` agent** — `plugin/ralph-hero/agents/codebase-pattern-finder.md:5` — `model: haiku`
   - Also called during context gathering
   - Even lower than sonnet

### Ambiguity: Does `context: fork` Actually Switch Models?

The `hero` skill SKILL.md (line 359) states:

> Skills invoked via `Skill()` run **inline in hero's context**, not as separate agents

This raises the question: when hero (sonnet) calls `Skill("ralph-plan-epic")`, does the `context: fork` + `model: opus` on `ralph-plan-epic` actually create a new context with opus, or does it run inline on sonnet?

Two interpretations:
- **`context: fork` overrides inline behavior**: The skill forks into its own context with its own model. The hero note only applies to skills without `context: fork`.
- **Inline always wins**: Skills always run inline regardless of `context: fork`, and the model stays as the caller's model (sonnet).

If the second interpretation is correct, then `ralph-plan-epic`, `ralph-plan`, and all other skills with `model: opus` would actually run on sonnet when called from hero/team, making the `model:` frontmatter effectively decorative for orchestrator-invoked skills.

### Task Complexity → Model Routing (Implementation Phase)

Separately from skill-level model assignments, `ralph-plan` SKILL.md (lines 349-351) defines a complexity-to-model mapping for individual implementation tasks:

```
- low: → haiku model
- medium: → sonnet model
- high: → opus model
```

This affects the implementation phase (`ralph-impl` dispatching subagents per task), not the planning phase itself.

## Code References

- `plugin/ralph-hero/skills/ralph-plan-epic/SKILL.md:7-8` — `model: opus`, `context: fork`
- `plugin/ralph-hero/skills/ralph-split/SKILL.md:6` — `model: sonnet` (the switch point)
- `plugin/ralph-hero/skills/ralph-plan/SKILL.md:6` — `model: opus`
- `plugin/ralph-hero/skills/hero/SKILL.md:4` — `model: sonnet` (orchestrator)
- `plugin/ralph-hero/skills/hero/SKILL.md:359` — "Skills invoked via Skill() run inline in hero's context"
- `plugin/ralph-hero/skills/ralph-plan/SKILL.md:349-351` — Complexity Decision Guide (task-level model routing)
- `plugin/ralph-hero/agents/codebase-analyzer.md:5` — `model: sonnet`
- `plugin/ralph-hero/agents/codebase-pattern-finder.md:5` — `model: haiku`

## Open Questions

1. Does `context: fork` on a skill actually create a forked context with its own model when invoked via `Skill()` from another skill? Or does the model stay as the caller's?
2. Should `ralph-split` be promoted to `model: opus` only when called from within the plan-of-plans workflow, or globally?
3. Should the codebase research agents (`codebase-analyzer`, `codebase-pattern-finder`) also be promoted to opus for the planning workflow, or is sonnet/haiku acceptable for read-only research?
