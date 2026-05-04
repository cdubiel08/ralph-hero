---
date: 2026-04-26
topic: "Subagent nesting in finish → ralph-merge → code-review chain"
tags: [research, architecture, agent-dispatch, context-windows, skill-vs-agent, code-review, finish, ralph-merge, subagent-nesting]
status: complete
type: research
git_commit: 557f2a4389b0e37ce77d2da1d54cf698a6788e6e
github_issue: 895
github_url: https://github.com/cdubiel08/ralph-hero/issues/895
---

# Research: Subagent nesting in `finish → ralph-merge → code-review` chain

## Prior Work

- builds_on:: [[2026-04-22-context-handoff-topology]]
- builds_on:: [[2026-04-06-auto-code-review-impl-fix-loop]]
- builds_on:: [[2026-04-04-GH-0732-hero-skill-dispatch-migration]]
- builds_on:: [[2026-04-06-haiku-skill-to-agent-dispatch]]
- builds_on:: [[2026-04-04-hero-dispatch-architecture-single-vs-team]]
- builds_on:: [[2026-04-01-GH-0674-agent-per-phase-still-needed]]
- builds_on:: [[2026-03-24-GH-0674-agent-per-phase-architecture]]
- builds_on:: [[2026-03-20-skill-dispatch-inventory]]
- builds_on:: [[2026-03-19-GH-0637-hero-dispatch-model]]

## Research Question

Concern about behavior observed when calling `:finish` skill:

- finish is a skill that runs inline and chains multiple skills in sequence
- The merge skill is *thought to* run in a separate context window, and merge calls `code-review:code-review`
- code-review needs to parallelize sub-agents — which can't be done if it itself is already nested as a sub-agent
- So: should finish run inline, and should merge also run inline?
- But if everything runs inline, the chain may switch from a high context window (Opus 4.7 1M) to a lower one

The investigation also covers any recent (March–April 2026) docs/API changes that affect this behavior.

## Summary

Three concrete answers map onto the question:

1. **Subagent nesting is forbidden** by Claude Code. Officially documented: *"Subagents cannot spawn other subagents."* The Agent tool is not present in subagent contexts. This is a hard architectural constraint, not a soft limit. ([code.claude.com/docs/en/sub-agents](https://code.claude.com/docs/en/sub-agents))

2. **Today, ralph-merge does NOT run in a separate context window.** `finish/SKILL.md:112` invokes ralph-merge via `Skill(...)`, which runs inline in finish's context. The `context: fork` annotation on `ralph-merge/SKILL.md:5` is documentation-only — no code in ralph-hero or in Claude Code (per current observation) parses or enforces it when invoked via the Skill tool. So the current chain `finish → ralph-merge → code-review` is fully inline at depth 0, and code-review's "5 parallel Sonnet agents" successfully spawn at depth 1 from the user's main session.

3. **The team is already aware of this tension and has it flagged.** The draft plan `thoughts/shared/plans/2026-04-06-auto-code-review-impl-fix-loop.md` proposes converting ralph-merge to `Agent()` dispatch (so it gets a clean haiku context envelope), and `thoughts/shared/research/2026-04-22-context-handoff-topology.md:64` records ralph-merge as *"currently inline but flagged"*. Shipping that conversion would break code-review's parallel-agent dispatch — exactly the failure mode the question anticipates. The conversion has not landed at commit `557f2a4`.

A separate **latent gap** exists: `agents/merge-agent.md` does not include `Skill` in its tool allowlist, but the preloaded ralph-merge skill calls `Skill("code-review:code-review", ...)`. When `hello/SKILL.md:124` dispatches merge-agent via Agent(), the Skill call is blocked by the agent's hard tool allowlist. This is a pre-existing inconsistency that becomes load-bearing if the planned ralph-merge → Agent conversion ships.

Context-window facts (per platform docs as of 2026-04-26): Opus 4.7 has 1M GA, Sonnet 4.6 has 1M GA, Haiku 4.5 has 200K (no 1M option). Inline dispatch keeps the parent's context window; Agent() dispatch forks to the agent's declared model.

## Detailed Findings

### 1. The official rule: subagents cannot spawn other subagents

The Claude Code sub-agents page states this explicitly, twice:

> "Subagents cannot spawn other subagents. If your workflow requires nested delegation, use Skills or chain subagents from the main conversation."

> *(In the Plan built-in agent description)*: "This prevents infinite nesting (subagents cannot spawn other subagents) while still gathering necessary context."

Source: [code.claude.com/docs/en/sub-agents](https://code.claude.com/docs/en/sub-agents)

Mechanism: the Agent tool (renamed from Task in Claude Code v2.1.63 — `Task(...)` syntax remains as an alias) is simply absent from a subagent's tool list. GitHub issue [anthropics/claude-code#4182](https://github.com/anthropics/claude-code/issues/4182) confirms this and was closed as a duplicate without a fix. The only documented workaround (`claude -p` subprocess via Bash) is explicitly not recommended.

The agent-teams docs add a parallel constraint: *"No nested teams: teammates cannot spawn their own teams or teammates."* ([code.claude.com/docs/en/agent-teams](https://code.claude.com/docs/en/agent-teams))

The ralph-hero team **empirically reconfirmed this constraint on 2026-04-04** — see `thoughts/shared/plans/2026-04-04-GH-0732-hero-skill-dispatch-migration.md`, lines 20–22:

> "Agent()-spawned sub-agents cannot dispatch further sub-agents (empirically confirmed 2026-04-04), making all sub-agent dispatch instructions inside autonomous skills dead code in single-session mode. Skill() runs inline and preserves Agent() access."

This empirical finding is what drove the migration of analyst/builder phases from Agent-per-phase back to Skill-inline dispatch in early April 2026.

### 2. The Skill tool runs inline; the Agent tool forks

| Aspect | `Skill("name", args=...)` | `Agent(subagent_type="name", ...)` |
|--------|--------------------------|-----------------------------------|
| Context | Loads inline into caller's context window | Fresh subagent context window |
| Conversation history | Available | Not inherited (unless fork-mode beta) |
| Tool permissions | Caller's allowlist applies | Agent's `tools:` field is the hard allowlist |
| Model | Caller's model (skill's `model:` may override for the turn) | Agent's `model:` field |
| Sub-agent dispatch within | Allowed if caller has Agent tool | **Forbidden** — Agent tool not present |
| SessionStart hooks | Fire on skill load | Fire on agent session start |

Source: [code.claude.com/docs/en/skills](https://code.claude.com/docs/en/skills), [code.claude.com/docs/en/sub-agents](https://code.claude.com/docs/en/sub-agents), and the convention fragment at [`plugin/ralph-hero/skills/shared/fragments/skill-vs-agent-dispatch.md`](https://github.com/cdubiel08/ralph-hero/blob/557f2a4/plugin/ralph-hero/skills/shared/fragments/skill-vs-agent-dispatch.md).

The fragment summarizes the ralph-hero convention (lines 5–8):

> "Single-session (hero orchestrator): Use `Skill()` — skills run inline and CAN dispatch sub-agents via `Agent()`. ... Team mode (dark factory): Use `Agent()` with per-phase agents — each agent is a full session with its own context window and CAN dispatch sub-agents."

> "The key constraint: Agent()-spawned sub-agents cannot dispatch further sub-agents."

### 3. The `context: fork` skill frontmatter field

`context: fork` is documented in the official Claude Code skills frontmatter reference. Per the docs: when set, *"a new isolated context is created, the skill content becomes the task prompt, the `agent:` field selects the subagent type."* The default (omitted field) is inline behavior. `context: inline` (explicit) is **not** a documented value — ralph-hero uses it as an annotation for clarity, but Claude Code itself only documents `fork`.

**Known bug**: GitHub issue [anthropics/claude-code#17283](https://github.com/anthropics/claude-code/issues/17283) reports that when a skill is invoked via the Skill tool (i.e., Claude calls it programmatically rather than via slash command), `context: fork` and the `agent:` field were ignored and the skill ran inline anyway. The issue is closed (CHANGELOG entry for v2.1.101 introduces the fields), but its full deployment status is not externally verified.

**Within ralph-hero**: zero code reads or enforces the `context:` field. Searched across:

- `plugin/ralph-hero/mcp-server/src/` (TypeScript)
- `plugin/ralph-hero/hooks/scripts/` (shell)
- `plugin/ralph-hero/scripts/` (CLI)
- `plugin/ralph-knowledge/src/parser.ts` (frontmatter parser — reads only `date`, `type`, `status`, `github_issue`, `github_issues`, `primary_issue`, `tags`, `superseded_by`)

So in ralph-hero, `context: fork` is documentation-only intent, not runtime-enforced behavior. The actual control of inline vs fork is the **caller's choice** of `Skill(...)` vs `Agent(...)`.

### 4. The actual `finish → ralph-merge → code-review` chain at commit `557f2a4`

#### 4.1 finish skill

[`plugin/ralph-hero/skills/finish/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/557f2a4/plugin/ralph-hero/skills/finish/SKILL.md) — frontmatter:

- Line 5: `context: inline`
- Lines 17–29: `allowed-tools` includes `Read, Glob, Grep, Bash, Skill, Agent, AskUserQuestion, mcp__plugin_ralph-hero_ralph-github__*`

Body — Step 3 (line 98) dispatches val:

```
Agent(subagent_type="ralph-hero:val-agent", prompt="Validate GH-NNN. Plan doc: ...")
```

Body — Step 4 (line 112) dispatches merge:

```
Skill("ralph-hero:ralph-merge", args="NNN --pr-url PR_URL")
```

The asymmetry is deliberate. Step 4a (line 128) dispatches impl-agent for code review fix cycles via `Agent(subagent_type="ralph-hero:impl-agent", ...)`.

#### 4.2 ralph-merge skill

[`plugin/ralph-hero/skills/ralph-merge/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/557f2a4/plugin/ralph-hero/skills/ralph-merge/SKILL.md) — frontmatter:

- Line 5: `context: fork` *(documentation-only; not runtime-enforced)*
- Line 6: `model: haiku`
- Lines 17–27: `allowed-tools` includes `Read, Glob, Bash, AskUserQuestion, Skill, mcp__plugin_ralph-hero_ralph-github__*`

Body — Step 4 Code Review Gate (line 123, auto path):

```
Skill("code-review:code-review", "PR_NUMBER")
```

Body — Step 4 Code Review Gate (line 160, interactive path):

> "If user selects **'Run code review'**: invoke `Skill("code-review:code-review", "PR_NUMBER")` where PR_NUMBER is the PR number obtained in Step 3 (not the issue number)."

Both paths invoke code-review via the Skill tool.

#### 4.3 code-review:code-review

[`/Users/dubiel/.claude/plugins/cache/claude-plugins-official/code-review/unknown/commands/code-review.md`](https://github.com/anthropics/claude-plugins-official) — frontmatter declares it as a slash command (`allowed-tools: Bash(...)` for various `gh` subcommands), not a skill. Claude Code exposes user-facing slash commands as Skill-tool-invocable in v2.1.111.

Body, step 4 (verbatim):

> "Then, launch 5 parallel Sonnet agents to independently code review the change."

Body, step 5 (verbatim):

> "For each issue found in #4, launch a parallel Haiku agent that takes the PR, issue description, and list of CLAUDE.md files (from step 2), and returns a score..."

The plugin README confirms: *"Multiple independent agents for comprehensive review"* and *"Confidence-based scoring reduces false positives (threshold: 80)"*. The agent dispatch mechanism is the **Agent tool** (the slash command predates the Task→Agent rename but uses the same primitive).

#### 4.4 Resolved chain when `/ralph-hero:finish NNN` runs from the user's session

```
User session                          (depth 0, model = user's, e.g., Opus 4.7 1M)
└── finish SKILL                      (Skill, inline,  depth 0)
    │
    ├── val-agent                     (Agent,  forked, depth 1, haiku 200K)
    │   └── (no further dispatch — val-agent has no Agent tool)
    │
    └── ralph-merge SKILL             (Skill, inline,  depth 0)
        │   ─ frontmatter says context: fork, but Skill() is inline
        │   ─ frontmatter says model: haiku, but inline keeps caller's model
        │
        └── code-review SKILL         (Skill, inline,  depth 0)
            │
            ├── (1) eligibility-check Haiku agent  (Agent, depth 1)
            ├── (2) CLAUDE.md-file-list Haiku       (Agent, depth 1)
            ├── (3) PR-summary Haiku                (Agent, depth 1)
            ├── (4) 5 × parallel Sonnet reviewers   (Agent, depth 1) ✅
            ├── (5) N × parallel Haiku scorers      (Agent, depth 1) ✅
            └── (7) re-eligibility Haiku            (Agent, depth 1)
```

**Every Agent() dispatch lands at depth 1**, which is legal. The "5 parallel Sonnet agents" in step (4) of code-review's instructions actually spawn successfully because the chain above them is all inline (`Skill` calls) and the user's main session has the Agent tool.

### 5. The flagged conversion the team has not yet shipped

`thoughts/shared/plans/2026-04-06-auto-code-review-impl-fix-loop.md` is a **draft** plan (frontmatter `status: draft`) that proposes (among other things) moving haiku-tier integrator phases (`pr`, `merge`) from `Skill()` inline to `Agent()` dispatch. Quote, line 12:

> "haiku phases (pr, merge, val) crash when invoked as `Skill("ralph-hero:ralph-pr")`, the skill content loads into the current context window — then the haiku model tries to execute within a context that was built for 1M tokens, causing context crashes."

`thoughts/shared/research/2026-04-22-context-handoff-topology.md:54-65` records the current dispatch matrix and explicitly marks ralph-merge as `currently inline but flagged`:

| Phase | Dispatch | Model | Inline or fresh? | File:line |
|---|---|---|---|---|
| FINISH | `Skill("ralph-hero:finish")` | sonnet | inline (orchestrator) | hero/SKILL.md:462 |
| Inside FINISH — VAL | `Agent(subagent_type="ralph-hero:val-agent")` | haiku | **fresh context** | finish/SKILL.md (Step 3) |
| Inside FINISH — MERGE | `Skill("ralph-hero:ralph-merge")` — marked for conversion | haiku | currently inline but flagged | finish/SKILL.md:119 |

The conversion has not landed at commit `557f2a4`. Verifying: `grep -n 'Agent.*ralph-merge' plugin/ralph-hero/skills/finish/SKILL.md` returns no matches; `grep -n 'Skill.*ralph-merge' plugin/ralph-hero/skills/finish/SKILL.md` matches lines 112 and 134.

#### 5.1 What changes if the conversion ships

Replacing `Skill("ralph-hero:ralph-merge", ...)` with `Agent(subagent_type="ralph-hero:merge-agent", ...)` in `finish/SKILL.md:112` would change the chain to:

```
User session                          (depth 0)
└── finish SKILL                      (Skill, inline, depth 0)
    │
    ├── val-agent                     (Agent, forked, depth 1, haiku 200K)
    │
    └── merge-agent                   (Agent, forked, depth 1, haiku 200K)
        │   ─ preloads ralph-merge skill via skills: field
        │   ─ fresh haiku-sized context envelope (✅ resolves the crash issue)
        │
        └── code-review SKILL         (Skill, inline, depth 1 inside merge-agent)
            │
            └── 5 × parallel Sonnet reviewers  (Agent, depth 2) ❌ FORBIDDEN
            └── N × parallel Haiku scorers     (Agent, depth 2) ❌ FORBIDDEN
```

Code-review's parallel agents would attempt depth-2 dispatch, which the Claude Code runtime forbids. Code-review would either skip its parallel review (degrading to a single inline review, breaking its design) or fail outright.

### 6. The latent gap in `merge-agent`

[`plugin/ralph-hero/agents/merge-agent.md`](https://github.com/cdubiel08/ralph-hero/blob/557f2a4/plugin/ralph-hero/agents/merge-agent.md), line 5:

```
tools: Read, Glob, Grep, Bash, AskUserQuestion, mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue, mcp__plugin_ralph-hero_ralph-github__ralph_hero__save_issue, mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_comment, mcp__plugin_ralph-hero_ralph-github__ralph_hero__advance_issue, mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_sub_issues, mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_dependencies
```

`Skill` and `Agent` are **absent** from this hard allowlist.

Per the permission layering documented in [`specs/agent-permissions.md:20-23`](https://github.com/cdubiel08/ralph-hero/blob/557f2a4/specs/agent-permissions.md):

> "Layer 1 (agent `tools:` field) is the hard allowlist enforced by the Claude Code runtime. Layer 2 (skill `allowed-tools`) is a permission grant that can only restrict further, not expand beyond layer 1."

So when merge-agent is dispatched (currently from `hello/SKILL.md:124` via `Agent(subagent_type="ralph-hero:merge-agent", ...)`), the preloaded ralph-merge skill's `Skill("code-review:code-review", ...)` instruction at `ralph-merge/SKILL.md:123` cannot execute — `Skill` is not in merge-agent's allowlist. The runtime blocks it.

This is a pre-existing inconsistency that becomes load-bearing if the 2026-04-06 conversion plan ships and `finish/SKILL.md:112` switches from `Skill(ralph-merge)` to `Agent(merge-agent)`. The code-review gate inside ralph-merge would silently no-op (or fail in a confusing way), regardless of the subagent-nesting issue from §5.1.

### 7. Where the model declaration applies

There is some ambiguity in the docs regarding `model:` honoring in inline skills:

- The shared fragment [`skill-vs-agent-dispatch.md:35`](https://github.com/cdubiel08/ralph-hero/blob/557f2a4/plugin/ralph-hero/skills/shared/fragments/skill-vs-agent-dispatch.md): *"The skill runs inline with `model:` honored from frontmatter"*
- The official skills frontmatter reference: *"Inline skill: The `model:` frontmatter field overrides for 'the rest of the current turn' only. Not saved to session settings. Reverts on the next prompt."*
- The 2026-04-06 plan's reasoning (line 12): assumes inline haiku skills run in the **caller's** Opus context envelope (otherwise there would be no "context crash" to solve)

The 2026-04-06 plan's framing implies that even if the Skill tool *technically* honors `model:` for the turn, the surrounding context envelope (built for the parent's model) is what matters at runtime — and a haiku model executing inside an Opus-sized envelope misbehaves. This appears to be an empirical observation that the authors used to justify the proposed Agent() conversion. The exact failure mode is not documented in the plan.

### 8. Context-window facts (per platform docs at 2026-04-26)

| Model | API ID | Context | Default? |
|-------|--------|---------|----------|
| Opus 4.7 | `claude-opus-4-7` | 1M tokens | GA, no beta header |
| Sonnet 4.6 | `claude-sonnet-4-6` | 1M tokens | GA, no beta header |
| Haiku 4.5 | `claude-haiku-4-5-20251001` | 200K tokens | Standard (no 1M option) |

Sources: [platform.claude.com/docs/en/about-claude/models/overview](https://platform.claude.com/docs/en/about-claude/models/overview), [platform.claude.com/docs/en/release-notes/overview](https://platform.claude.com/docs/en/release-notes/overview).

Relevant timeline:
- 2026-03-13: 1M context GA for Opus 4.6 and Sonnet 4.6
- 2026-04-08: Claude Managed Agents launched (server-side, separate from Claude Code subagents)
- 2026-04-16: Opus 4.7 launched

**No subagent-nesting changes in this window.** The Task→Agent rename happened in v2.1.63 (earlier, October 2025-ish based on changelog ordering); no further structural changes have shipped.

### 9. Inline vs forked: the actual tradeoff

**Inline (`Skill(...)`):**
- ✅ Sub-skill can use the parent's tools — including `Agent`, so it can spawn parallel sub-agents
- ✅ Sub-skill inherits the parent's model — keeps you in 1M context if parent is Opus 4.7
- ❌ Adds to parent's context cost (~14k tokens per ralph-hero skill per the 2026-03-20 inventory)
- ❌ Sub-skill's `model:` declaration may not take full effect (debated; see §7)
- ❌ Sub-skill's `context:` annotation is ignored

**Forked (`Agent(subagent_type=...)`):**
- ✅ Fresh context window (no parent baggage); cleanly switches to the agent's model envelope
- ✅ Honors the agent's declared model and tool allowlist as hard constraints
- ❌ Sub-agent **cannot** spawn further sub-agents — code-review-style fan-out dies
- ❌ Loses parent conversation history; communication via prompt + return summary only
- ❌ Hooks must discriminate by `agent_type` (only 4 ralph-hero scripts do; most use `$RALPH_COMMAND`)

The team's current deliberate split (per 2026-04-06 plan + 2026-04-22 research):
- Analyst/builder skills (research, plan, review on opus/sonnet) → **Skill inline** in hero, to preserve sub-agent fan-out
- Integrator skills on haiku (pr, merge, val) → **Agent forked** for clean haiku context envelope (val done; pr/merge still flagged but not converted)
- The code-review-via-Skill inside ralph-merge is the wrinkle that makes the merge conversion non-trivial

### 10. The user's question, answered directly

> "code-review needs to be able to parallelize subagents, which I don't think it can do if it itself is already nesting"

Correct as stated, but the premise ("code-review is already nesting") is not currently true at commit `557f2a4`. The full chain `user → finish → ralph-merge → code-review` runs at depth 0 today because Skill() is inline. Code-review's parallel agents land at depth 1, which is legal.

> "I think finish needs to be run inline and finish should also be running in-line"

Both are true today:
- `finish/SKILL.md:5` declares `context: inline`
- finish/SKILL.md:112 invokes ralph-merge via `Skill(...)` (inline)
- ralph-merge/SKILL.md:123 invokes code-review via `Skill(...)` (inline)

> "But if they run in-line they may switch from a high context window to a low"

Inverted from the actual risk. **Inline keeps you in the parent's context envelope** (e.g., Opus 4.7 1M when you started there). Switching to forked Agent dispatch is what would change the model envelope (e.g., to Haiku 200K).

The real risk of the all-inline path is **context cost accumulation** in the parent's window — every inline skill adds to the parent's context. With Opus 4.7 1M, ~14k tokens per ralph-hero skill (per the 2026-03-20 inventory) means the budget is spacious, but a long pipeline with many phases could still bloat it.

## Code References

### Skills
- `plugin/ralph-hero/skills/finish/SKILL.md:5` — `context: inline`
- `plugin/ralph-hero/skills/finish/SKILL.md:17-29` — allowed-tools (includes Skill, Agent)
- `plugin/ralph-hero/skills/finish/SKILL.md:98` — `Agent(subagent_type="ralph-hero:val-agent", ...)`
- `plugin/ralph-hero/skills/finish/SKILL.md:112` — `Skill("ralph-hero:ralph-merge", args="NNN --pr-url PR_URL")`
- `plugin/ralph-hero/skills/finish/SKILL.md:128` — Step 4a Agent dispatch for impl-agent code review fix
- `plugin/ralph-hero/skills/finish/SKILL.md:134` — Re-invoke ralph-merge after fix cycle
- `plugin/ralph-hero/skills/ralph-merge/SKILL.md:5` — `context: fork` (documentation only)
- `plugin/ralph-hero/skills/ralph-merge/SKILL.md:6` — `model: haiku`
- `plugin/ralph-hero/skills/ralph-merge/SKILL.md:17-27` — allowed-tools (includes Skill)
- `plugin/ralph-hero/skills/ralph-merge/SKILL.md:115-138` — auto-mode code review path
- `plugin/ralph-hero/skills/ralph-merge/SKILL.md:123` — `Skill("code-review:code-review", "PR_NUMBER")` (auto)
- `plugin/ralph-hero/skills/ralph-merge/SKILL.md:160` — `Skill("code-review:code-review", "PR_NUMBER")` (interactive)
- `plugin/ralph-hero/skills/ralph-val/SKILL.md:5` — `context: fork`
- `plugin/ralph-hero/skills/hero/SKILL.md:4` — `context: inline`
- `plugin/ralph-hero/skills/hero/SKILL.md:425-437` — Dispatch Architecture section
- `plugin/ralph-hero/skills/hero/SKILL.md:462` — `Skill("ralph-hero:finish", args="NNN")`
- `plugin/ralph-hero/skills/shared/fragments/skill-vs-agent-dispatch.md:5-8` — convention statement
- `plugin/ralph-hero/skills/shared/fragments/skill-vs-agent-dispatch.md:35` — model honoring claim

### Agents
- `plugin/ralph-hero/agents/finish-agent.md:5` — tools (includes Skill, NOT Agent)
- `plugin/ralph-hero/agents/finish-agent.md:7` — `skills: [ralph-hero:finish]`
- `plugin/ralph-hero/agents/merge-agent.md:5` — tools (does NOT include Skill or Agent)
- `plugin/ralph-hero/agents/merge-agent.md:7` — `skills: [ralph-hero:ralph-merge]`
- `plugin/ralph-hero/agents/val-agent.md:5` — tools (does NOT include Skill or Agent)
- `plugin/ralph-hero/agents/val-agent.md:7` — `skills: [ralph-hero:ralph-val]`

### Code-review plugin
- `/Users/dubiel/.claude/plugins/cache/claude-plugins-official/code-review/unknown/commands/code-review.md:14` — "launch 5 parallel Sonnet agents"
- `/Users/dubiel/.claude/plugins/cache/claude-plugins-official/code-review/unknown/commands/code-review.md:20` — "launch a parallel Haiku agent" (per-issue scoring)
- `/Users/dubiel/.claude/plugins/cache/claude-plugins-official/code-review/unknown/.claude-plugin/plugin.json` — manifest declares it as a slash command

### Hooks (relevant to dispatch attribution)
- `plugin/ralph-hero/hooks/scripts/hook-utils.sh:36-40` — `get_agent_type()` (one of 4 scripts that read `agent_type`)
- `plugin/ralph-hero/hooks/scripts/agent-phase-gate.sh:17-38` — primary `$RALPH_COMMAND` check, agent_type fallback
- `plugin/ralph-hero/hooks/scripts/skill-precondition.sh:25-31` — same pattern

### Specs
- `specs/agent-permissions.md:20-23` — permission layering (agent `tools:` is hard allowlist, skill `allowed-tools` can only restrict further)

## Architecture Documentation

### Today's dispatch primitives in finish

1. `Skill("ralph-hero:ralph-merge", ...)` — inline. ralph-merge runs in finish's context window with finish's tool surface (which includes Skill, Agent, MCP tools).

2. `Agent(subagent_type="ralph-hero:val-agent", ...)` — fresh context. val-agent gets its own session with its declared tools (no Skill, no Agent — but it doesn't need them).

3. `Agent(subagent_type="ralph-hero:impl-agent", ...)` (Step 4a) — fresh context. impl-agent has full tooling for Address Mode.

### Today's dispatch primitives in code-review (when invoked from inline ralph-merge)

Code-review's slash command body invokes the **Agent tool** to launch its review fan-out. Because it runs inline within finish's context, the Agent tool is available (finish has it, ralph-merge doesn't matter because tools are inherited from caller).

### The two dispatch axes of ralph-hero

**Axis 1: dispatch level**
- Orchestrators: `hero`, `team` (deprecated), `finish`
- Phase skills: `ralph-split`, `ralph-research`, `ralph-plan`, `ralph-plan-epic`, `ralph-review`, `ralph-impl`, `ralph-pr`, `ralph-val`, `ralph-merge`, `ralph-triage`
- Interactive siblings: `research`, `plan`, `impl`, `iterate`
- Utility skills: `draft`, `form`, `hello`, `status`, `report`, etc.

**Axis 2: invocation style**
- User-invocable (runs inline)
- Non-user-invocable (runs via orchestrator; declares `user-invocable: false`)

### Identity signals for hooks

Two signals distinguish what's running:

- `$RALPH_COMMAND` (env var, set by each skill's SessionStart hook via `set-skill-env.sh`)
- `.agent_type` (runtime-injected into hook JSON payload; only present when an Agent dispatch is active)

Most hooks (90%+) discriminate via `$RALPH_COMMAND` only. Four scripts read `.agent_type`, three of those use it as a fallback. This is what made the GH-0732 Agent→Skill migration safe: the same enforcement fires whether a phase runs as Skill inline or Agent forked.

## Historical Context (from thoughts/)

Three documents form the spine of the prior decision-making:

**`2026-04-04-GH-0732-hero-skill-dispatch-migration.md`** — empirically reconfirmed that subagents cannot spawn subagents on 2026-04-04. Reversed direction: hero now dispatches analyst/builder phases via `Skill()` inline (not `Agent()`), preserving sub-agent dispatch capability within those skills. Per-phase agents preserved for team mode.

**`2026-04-06-auto-code-review-impl-fix-loop.md`** (status: draft) — found that haiku phases (pr, merge, val) crash when invoked as Skill() inline in hero's Opus 1M context. Proposed converting pr/merge from Skill to Agent. Val was already on Agent. Conversion of pr/merge has not landed at commit `557f2a4` (verified via `grep`).

**`2026-04-22-context-handoff-topology.md`** — exhaustive mapping of all phase-to-phase handoffs and dispatch decisions. Records ralph-merge as "currently inline but flagged" (line 64). Documents the hybrid architecture: opus/sonnet phases stay inline for context sharing; haiku phases fork for clean envelope.

Earlier foundational work:

- **`2026-03-19-GH-0637-hero-dispatch-model.md`** — original problem statement: "each ralph-research, ralph-plan, and ralph-impl invocation consumes tokens in hero's context window, making long pipelines increasingly fragile." Initially proposed Agent() dispatch for all phases.
- **`2026-03-24-GH-0674-agent-per-phase-architecture.md`** — implemented per-phase agents for team mode; identified three root causes (sub-agents can't spawn sub-agents, `$VAR` references unexpandable in skill markdown, plugin sub-agent hooks ignored).
- **`2026-04-01-GH-0674-agent-per-phase-still-needed.md`** — confirmed all three root causes still active; documented that Claude Code platform changes had not resolved any of them. GitHub issue [anthropics/claude-code#16803](https://github.com/anthropics/claude-code/issues/16803) (`context: fork` in plugin-scoped skills) remains OPEN.

## Related Research

- [[2026-04-22-context-handoff-topology]] — full dispatch matrix; the canonical reference for current state
- [[2026-04-06-auto-code-review-impl-fix-loop]] — draft plan that proposes the merge-to-Agent conversion
- [[2026-04-04-GH-0732-hero-skill-dispatch-migration]] — Agent→Skill migration; empirical confirmation of nesting forbidden
- [[2026-04-06-haiku-skill-to-agent-dispatch]] — sibling plan for haiku phases
- [[2026-04-04-hero-dispatch-architecture-single-vs-team]] — single vs team comparison
- [[2026-03-20-skill-dispatch-inventory]] — classification of all 29 ralph-hero skills by dispatch mode
- [[2026-04-05-hero-pipeline-handoff-ux-inventory]] — 8-handoff inventory
- [[2026-02-22-ralph-workflow-v4-architecture-spec]] — foundational spec for the analyst/builder/integrator phase groupings

## Open Questions

1. **Does the Skill tool honor a sub-skill's `model:` field for the duration of the inline call?** The shared fragment claims yes; the official docs say "for the rest of the current turn"; the 2026-04-06 plan's framing implies the parent's context envelope dominates regardless. Needs an empirical test: invoke `Skill("ralph-hero:ralph-merge", ...)` from an Opus session and inspect debug logs (RALPH_DEBUG=true) for the model used during the inline call.

2. **What exactly is the "context crash" for haiku-in-Opus-envelope?** The 2026-04-06 plan asserts it without specifics. Is it OOM? Token-budget enforcement failure? Latency? Reproducer would clarify whether the proposed Agent conversion is necessary or whether a model-pinning fix could keep things inline.

3. **Has GitHub issue #17283 (Skill tool ignoring `context: fork`) actually been fixed?** The CHANGELOG entry for v2.1.101 introduces the fields. Empirical test: declare a trivial test skill with `context: fork`, invoke it via `Skill("test")`, and check whether a separate subagent context starts.

4. **What is the merge-agent intended to do when its preloaded ralph-merge skill calls `Skill("code-review:code-review", ...)`?** The current configuration silently blocks it. Options: (a) add `Skill` to merge-agent tools (then code-review's parallel agents would attempt depth-2 dispatch and fail), (b) move the code-review gate up the call chain so it runs in finish or hero's inline context, (c) make code-review optional inside merge-agent.

5. **Does the planned ralph-merge → Agent conversion have a path to keep code-review's parallel review intact?** Two designs that could:
   - Keep code-review invocation in finish (inline, can fan out), have finish call ralph-merge afterwards in any mode
   - Replace code-review's parallel-agent dispatch with sequential review steps (degrades quality but works inside an agent context)
   The 2026-04-06 plan does not address this directly.

6. **Are there any other skills that nest `Skill()` calls inside skills that the team plans to convert to Agent dispatch?** A grep for `Skill("[a-z-]*:` across all skill bodies would surface them. ralph-pr is the other haiku phase flagged for conversion — does ralph-pr invoke any skills that would lose fan-out?
