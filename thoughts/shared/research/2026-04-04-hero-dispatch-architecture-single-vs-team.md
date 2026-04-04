---
date: 2026-04-04
topic: "Hero dispatch architecture: single-session Skill() vs team-session Agent()"
tags: [architecture, agents, skills, hero-dispatch, team-mode, sub-agents]
status: complete
type: research
git_commit: 19ef3aabd690c2e41276f3dad51fe1e1d88f504d
---

# Research: Hero Dispatch Architecture — Single-Session vs Team-Session

## Prior Work

- tensions:: [[2026-03-24-GH-0674-agent-per-phase-architecture]]
- tensions:: [[2026-04-01-GH-0674-agent-per-phase-still-needed]]
- builds_on:: [[2026-03-19-GH-0637-hero-dispatch-model]]
- builds_on:: [[2026-02-20-GH-0231-skill-subagent-team-context-pollution]]

## Research Question

What is the correct dispatch architecture for ralph-hero's orchestrators, given the empirically confirmed constraint that Agent()-spawned sub-agents cannot themselves dispatch further sub-agents?

## Summary

Empirical testing on 2026-04-04 confirmed that Agent()-spawned sub-agents lose access to the Agent tool at runtime, regardless of what their `tools:` field declares. This means the current hero orchestrator's dispatch pattern — `hero → Agent(research-agent) → research-agent tries Agent(thoughts-locator) → SILENTLY FAILS` — creates a cascade of dead code. The autonomous skills (`ralph-research`, `ralph-plan`, etc.) contain sub-agent dispatch instructions that never execute when preloaded into agents.

The correct architecture uses **two distinct dispatch modes** depending on session type:

- **Single session (95% of use)**: Hero calls **Skills** via `Skill()` tool. Skills run inline in hero's context and CAN dispatch sub-agents via `Agent()`.
- **Team session (dark factory)**: Team spawns **Agents** via Claude Code Agent Teams. Each agent is a full Claude Code session with its own context window and CAN dispatch sub-agents.

## Empirical Evidence

Three tests performed on 2026-04-04:

| Test | Context | Agent() available? |
|------|---------|-------------------|
| `Agent(subagent_type="ralph-hero:research-agent")` — asked to dispatch `codebase-locator` | Agent subprocess | **No** — "I do not have access to an Agent tool" |
| `Agent()` (general purpose) — asked to dispatch `codebase-locator` | Agent subprocess | **No** — "no Agent tool is available in this context" |
| `Skill("ralph-hero:prove-claim")` — asked to dispatch `codebase-locator` | Inline (Skill loads into main context) | **Yes** — successfully dispatched and received results |

Conclusion: The `Agent` tool is only available in the **top-level conversation context**. Any sub-process spawned via `Agent()` loses it, regardless of the `tools:` field in the agent definition.

## The Two Dispatch Modes

### Single Session (Hero Orchestrator)

```
User → /ralph-hero:hero 42
         │
         ├── assess state via get_issue(includePipeline=true)
         │
         ├── Skill("ralph-hero:ralph-triage")     # or ralph-split
         │     └── runs inline, CAN dispatch Agent(thoughts-locator, codebase-analyzer, ...)
         │
         ├── Skill("ralph-hero:ralph-research")
         │     └── runs inline, CAN dispatch Agent(thoughts-locator, codebase-analyzer, ...)
         │
         ├── Skill("ralph-hero:ralph-plan")        # or ralph-plan-epic
         │     └── runs inline, CAN dispatch Agent(codebase-pattern-finder, thoughts-analyzer, ...)
         │
         ├── Skill("ralph-hero:ralph-review")      # optional
         │     └── runs inline
         │
         ├── Skill("ralph-hero:ralph-impl")
         │     └── runs inline, CAN dispatch Agent() for task-level work
         │
         ├── Skill("ralph-hero:ralph-val")
         │     └── runs inline
         │
         └── Skill("ralph-hero:ralph-pr")
               └── runs inline
```

**Tradeoff**: Skills run in hero's context window, consuming tokens. For single-issue pipelines this is fine. For large groups, context pressure is a concern — but sub-agent dispatch actually working is more valuable than context savings from broken agent isolation.

**Skill execution order** (state-machine driven, not all skills run every invocation):
1. `ralph-hero:ralph-triage` / `ralph-hero:ralph-split` — if issue needs triage or splitting
2. `ralph-hero:ralph-research` — if issue needs research
3. `ralph-hero:ralph-plan` or `ralph-hero:ralph-plan-epic` — if issue needs planning
4. `ralph-hero:ralph-review` — if plan needs review (optional, controlled by `RALPH_REVIEW_MODE`)
5. `ralph-hero:ralph-impl` — implementation (one phase per invocation)
6. `ralph-hero:ralph-val` — validation before PR
7. `ralph-hero:ralph-pr` — PR creation

### Team Session (Dark Factory)

```
User → /ralph-hero:team 42
         │
         ├── assess state, create team via TeamCreate()
         │
         ├── Agent("ralph-hero:research-agent", team_name="...")
         │     └── FULL SESSION — CAN dispatch sub-agents
         │
         ├── Agent("ralph-hero:plan-agent", team_name="...")
         │     └── FULL SESSION — CAN dispatch sub-agents
         │
         └── Agent("ralph-hero:impl-agent", team_name="...")
               └── FULL SESSION — CAN dispatch sub-agents
```

**Key difference**: In team mode, agents are created via Claude Code Agent Teams infrastructure. Each agent is a **full Claude Code session** (not a subprocess), so it has complete tool access including `Agent()`. This is the architecture where per-phase agents with preloaded skills are fully functional.

**Team mode is the 5% case** — multi-issue groups, long-running pipelines, situations where context isolation between phases is worth the overhead of multiple sessions.

## Dead Code Inventory

The following Agent() dispatch instructions in autonomous skills are currently dead code when those skills are preloaded into agents via single-session hero dispatch:

### ralph-research/SKILL.md (6 dispatch calls)
- `Agent(subagent_type="ralph-hero:codebase-locator", ...)` — line 151
- `Agent(subagent_type="ralph-hero:codebase-analyzer", ...)` — line 152
- `Agent(subagent_type="ralph-hero:codebase-pattern-finder", ...)` — line 153
- `Agent(subagent_type="ralph-hero:thoughts-locator", ...)` — line 154
- `Agent(subagent_type="ralph-hero:thoughts-analyzer", ...)` — line 155
- `Agent(subagent_type="ralph-hero:web-search-researcher", ...)` — line 156

### ralph-plan/SKILL.md (3 dispatch calls)
- `Agent(subagent_type="ralph-hero:codebase-pattern-finder", ...)` — line 167
- `Agent(subagent_type="ralph-hero:codebase-analyzer", ...)` — line 168
- `Agent(subagent_type="ralph-hero:thoughts-locator", ...)` — line 169
- Plus thoughts-analyzer dispatch after locator returns — line 173

### ralph-impl/SKILL.md
- Task dispatcher pattern spawns subagents by complexity tier — these dispatch calls fail silently when impl-agent can't nest agents

### hello/SKILL.md (6 dispatch calls)
- Lines 117-122: Dispatches triage-agent, review-agent, merge-agent, research-agent, plan-agent
- These WORK because hello runs inline (user-invocable), not inside an agent

## Artifacts That Disagree With This Architecture

The following artifacts describe or implement hero dispatching Agent() calls in single-session mode. This research supersedes their dispatch architecture:

### 1. hero/SKILL.md — Current implementation
- **Location**: `plugin/ralph-hero/skills/hero/SKILL.md:250-358`
- **What it does**: Dispatches `Agent(subagent_type="ralph-hero:research-agent")`, `Agent(subagent_type="ralph-hero:plan-agent")`, etc.
- **Should be**: `Skill("ralph-hero:ralph-research")`, `Skill("ralph-hero:ralph-plan")`, etc.

### 2. GH-674 Agent-Per-Phase Architecture Plan
- **Location**: `thoughts/shared/plans/2026-03-24-GH-0674-agent-per-phase-architecture.md`
- **What it describes**: Migrating from wrapper-agents to per-phase agents, with hero dispatching `Agent("ralph-hero:research-agent")`
- **Status**: The per-phase agent DEFINITIONS are correct and useful for team mode. The plan's assumption that hero should dispatch them via Agent() in single-session mode is incorrect.

### 3. GH-674 Research Update
- **Location**: `thoughts/shared/research/2026-04-01-GH-0674-agent-per-phase-still-needed.md`
- **What it describes**: Validates that per-phase agents are still needed
- **Status**: The agents ARE still needed — for team mode. The research correctly identifies that nested sub-agents are blocked, but doesn't draw the conclusion that this means single-session hero should use Skill() instead.

### 4. CLAUDE.md Per-Phase Agents Section
- **Location**: `CLAUDE.md:58-73`
- **What it describes**: Agent table, dispatch notes, `Agent()` dispatch pattern
- **Status**: The agent table and properties are correct (they exist and are configured properly). The "Agent Dispatch Notes" section (lines 366-376 of hero/SKILL.md) should clarify that Agent dispatch is for team mode; single-session uses Skill().

### 5. hello/SKILL.md Dispatch Table
- **Location**: `plugin/ralph-hero/skills/hello/SKILL.md:113-127`
- **What it does**: Dispatches per-phase agents via Agent()
- **Status**: This actually WORKS correctly because hello runs inline. However, it should be updated to use Skill() for consistency, since the skills would then have sub-agent access.

## Impact on Epic #729 (Cross-Plugin Awareness)

This finding affects the #730 (playwright-aware planning) design:

- **Original design**: Hero dispatches explorer-agent between RESEARCH and PLAN because "agents can't launch agents"
- **Revised understanding**: If hero calls `Skill("ralph-hero:ralph-research")` inline, the research skill CAN dispatch explorer-agent itself
- **Implication**: The autonomous path could work the same as the interactive path — the skill handles its own playwright dispatch, no special hero orchestration needed
- **`ralph-research` CAN be modified** for playwright baseline capture (previously ruled out)

This also affects #725 (knowledge-aware research):
- Sub-agent enrichment (#728) WILL work in single-session mode because ralph-research runs inline and can dispatch enriched thoughts-locator/thoughts-analyzer agents
- The dead code concern is eliminated — those dispatch calls will execute when hero uses Skill()

## Open Questions — RESOLVED

All four questions investigated empirically on 2026-04-04:

### 1. Context pressure — NOT A CONCERN

Measured skill sizes:
- Typical pipeline (research → plan → review → impl → val → pr): ~11k words / ~14k tokens
- Worst case (all 8 skills): ~14k words / ~19k tokens
- Hero itself: ~2.6k words / ~3.4k tokens

With a 1M context model, even 20k tokens of skill instructions is <2% of the window. Skills are loaded one at a time via `Skill()`, not all simultaneously. The real concern would be accumulation of skill *output* (research docs, plan docs, impl diffs), but the context manager compresses prior messages as the conversation grows.

### 2. Model selection — WORKS WITH Skill()

**Empirically tested**: Invoked `Skill("ralph-hero:draft")` which declares `model: sonnet` from an opus session. Claude Code UI confirmed model switch: `Successfully loaded skill · claude-sonnet-4-6`. The `model:` field in skill frontmatter IS honored during inline `Skill()` invocation.

This means Skill() dispatch preserves the cost/speed differentiation:
- ralph-research runs as sonnet (cheaper, faster)
- ralph-plan runs as opus (more capable)
- ralph-pr runs as haiku (cheapest)

### 3. Hook discrimination — WORKS VIA RALPH_COMMAND

Examined `agent-phase-gate.sh` — the hook system has two independent guard mechanisms:
- `RALPH_COMMAND` — set by skill SessionStart hooks (e.g., `RALPH_COMMAND=plan`). When set, `agent-phase-gate.sh` skips (line 20) because the skill's own hooks handle enforcement.
- `agent_type` — populated from hook input JSON when running inside a sub-agent.

When hero calls `Skill("ralph-research")` inline, the skill's SessionStart hook sets `RALPH_COMMAND=research`, and the skill's own hooks (branch-gate, etc.) fire via its `hooks:` frontmatter. No `agent_type` needed.

### 4. Team mode — EXPERIMENTAL BUT FUNCTIONAL FOR NESTING

Claude Code Agent Teams are experimental (require `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`). Docs state teammates cannot spawn teams/teammates, but empirical observation confirms **team agents CAN spawn regular sub-agents via Agent()**. This makes the dark factory architecture viable with one level of nesting:

```
team lead → teammate (full session) → sub-agent via Agent()
```

The current `team/SKILL.md` is deprecated. A new team skill using per-phase agents would need to be written.

## Validated Dispatch Comparison

| Property | `Skill()` inline | `Agent()` sub-agent | Team teammate |
|----------|-----------------|--------------------|--------------| 
| Model selection | Yes (honored from frontmatter) | Yes (from agent def) | Yes (full session) |
| Sub-agent nesting | **Yes** | **No** | **Yes** |
| Hook enforcement | Via `RALPH_COMMAND` | Via `agent_type` | Via `agent_type` |
| Context isolation | No (shares hero's window) | Yes (own window) | Yes (own window) |
| Context pressure | ~14k tokens typical | None | None |

**Sources**:
- Official docs: *"Subagents cannot spawn other subagents, so `Agent(agent_type)` has no effect in subagent definitions."* ([code.claude.com/docs/en/sub-agents](https://code.claude.com/docs/en/sub-agents))
- Official docs: *"No nested teams: teammates cannot spawn their own teams or teammates."* ([code.claude.com/docs/en/agent-teams](https://code.claude.com/docs/en/agent-teams))
- SDK docs: *"Subagents cannot spawn their own subagents. Don't include `Agent` in a subagent's `tools` array."* ([platform.claude.com/docs/en/agent-sdk/subagents](https://platform.claude.com/docs/en/agent-sdk/subagents))
- Empirical: `Skill()` model switch confirmed via Claude Code UI output `Successfully loaded skill · claude-sonnet-4-6`
- Empirical: Team agents spawning sub-agents confirmed by user observation

## Recommendation

**Single-session mode (hero)**: Migrate from `Agent()` dispatch to `Skill()` dispatch. This gives model selection, sub-agent nesting, and hook enforcement — all three properties with no tradeoffs. The only cost is shared context window, which is negligible at <2% for a typical pipeline.

**Team mode (dark factory)**: Rewrite the deprecated `team/SKILL.md` to use per-phase agents as teammates. Each teammate is a full session that can spawn sub-agents. Per-phase agent definitions are preserved for this use case.

**Per-phase agents are still valuable** — they define the model, tool allowlist, and preloaded skills for team-mode dispatch. They just aren't the right dispatch target for single-session hero.

File a new issue to track the hero Skill()-migration. This supersedes the remaining unfinished phases of GH-674 (agent-per-phase architecture) for single-session mode.
