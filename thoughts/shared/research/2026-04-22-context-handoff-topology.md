---
date: 2026-04-22
topic: "Context-handoff topology of the ralph-hero pipeline"
tags: [research, architecture, context-windows, agent-dispatch, hooks, orchestration, consolidation]
status: complete
type: research
git_commit: 8e6bb53
---

# Research: Context-handoff topology of the ralph-hero pipeline

## Prior Work

- builds_on:: [[2026-04-04-hero-dispatch-architecture-single-vs-team]]
- builds_on:: [[2026-04-04-GH-0732-hero-skill-dispatch-migration]]
- builds_on:: [[2026-04-06-haiku-skill-to-agent-dispatch]]
- builds_on:: [[2026-04-01-GH-0674-agent-per-phase-still-needed]]
- builds_on:: [[2026-03-24-GH-0674-agent-per-phase-architecture]]
- builds_on:: [[2026-03-24-agent-env-propagation-token-scope]]
- builds_on:: [[2026-03-20-skill-dispatch-inventory]]
- builds_on:: [[2026-03-19-GH-0637-hero-dispatch-model]]
- builds_on:: [[2026-02-22-ralph-workflow-v4-architecture-spec]]
- builds_on:: [[2026-02-20-GH-0231-skill-subagent-team-context-pollution]]
- builds_on:: [[2026-04-05-hero-pipeline-handoff-ux-inventory]]

## Research Question

Map every point in the ralph-hero pipeline where a fresh agent context starts vs. where state carries forward. For each handoff, document:

1. What persists to disk (thoughts/, GitHub, worktree, plan docs) vs. what is discarded.
2. The rationale for the split, if discoverable.
3. Whether the split is structural (required for resumability/observability) or incidental.

Enumerate (1) phase-to-phase handoffs in the hero orchestrator, (2) agent-to-subagent fan-outs inside each phase, (3) interactive vs. autonomous skill variants, and (4) hook-enforced constraints and their dependency on fresh-context attribution.

## Summary

Ralph-hero already consolidates context aggressively. The hero orchestrator dispatches the three highest-context phases (research, plan, review) as `Skill()` calls that run inline in hero's context; only impl, pr, merge, val, and cross-repo decomposition use `Agent()` fresh-context dispatch. This hybrid is the product of two deliberate migrations in early April 2026: GH-0732 moved Agent-per-phase → Skill() inline for analyst/builder phases; a follow-up (2026-04-06) moved pr/merge haiku phases back to Agent() because a haiku model cannot execute cleanly inside hero's Opus 1M context. Every current split exists for a specific reason documented in prior plans.

Inside each phase, the remaining context-splits are the utility-agent fan-outs — `ralph-research` spawns 5–6 small specialist agents in parallel (codebase-locator, codebase-analyzer, codebase-pattern-finder, thoughts-locator, thoughts-analyzer, web-search-researcher), `ralph-plan` spawns 4, `ralph-plan-epic` spawns 2, `ralph-impl` spawns an implementer + reviewer pair per task plus a phase reviewer. The phase agents in `plugin/ralph-hero/agents/` are thin wrappers (a `skills:` preload); the utility agents are substantial and single-purpose.

Hook enforcement is structured around `$RALPH_COMMAND` (set by each skill's own `SessionStart` hook via `set-skill-env.sh`), not `.agent_type` from the hook JSON payload. Only four scripts read `.agent_type`, and three use it as a fallback when `$RALPH_COMMAND` is empty. This is what made the GH-0732 migration safe — the same enforcement fires whether a phase runs via `Skill()` inline or `Agent()` fresh-context. The one enforcement tier that is unambiguously scoped to a fresh-context agent is the impl worktree gate (`impl-worktree-gate.sh`, `impl-staging-gate.sh`, `impl-plan-required.sh`) — these live in `ralph-impl/SKILL.md` frontmatter and activate whenever that skill is active, regardless of dispatch mode.

Interactive and autonomous skill variants differ along seven dimensions: `context: fork`, `user-invocable: false`, absence of `AskUserQuestion`/`Edit`/`WebSearch`, full hook stack (6–10 hooks) vs. 0–1 hooks, `!cat` fragment loading, model override (only on `ralph-research`), and addition of state-mutation tools (`save_issue`, `sync_plan_graph`, `add_dependency`). The autonomous variants are deliberately narrower, not copy-pasted from the interactive ones.

## Detailed Findings

### 1. Phase-to-phase handoffs in the hero orchestrator

#### 1.1 Dispatch matrix

Source: [`plugin/ralph-hero/skills/hero/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/8e6bb53/plugin/ralph-hero/skills/hero/SKILL.md) (Execution Loop, Step 3, lines 261–464).

| Phase | Dispatch | Model | Inline or fresh? | File:line |
|---|---|---|---|---|
| SPLIT | `Skill("ralph-hero:ralph-split")` | opus | inline | hero/SKILL.md:278 |
| RESEARCH | `Skill("ralph-hero:ralph-research")` | sonnet | inline | hero/SKILL.md:341 |
| PLAN | `Skill("ralph-hero:ralph-plan")` or `ralph-plan-epic` | opus | inline | hero/SKILL.md:357–370 |
| PLAN REVIEW | `Skill("ralph-hero:ralph-review")` | opus | inline | hero/SKILL.md:380 |
| IMPLEMENT | `Agent(subagent_type="ralph-hero:impl-agent")` | opus | **fresh context** | hero/SKILL.md:418 |
| PR | `Skill("ralph-hero:ralph-pr")` — marked for conversion to `Agent()` per 2026-04-06 plan | haiku | currently inline but flagged | hero/SKILL.md:443 |
| FINISH | `Skill("ralph-hero:finish")` | sonnet | inline (orchestrator) | hero/SKILL.md:462 |
| Inside FINISH — VAL | `Agent(subagent_type="ralph-hero:val-agent")` | haiku | **fresh context** | finish/SKILL.md (Step 3) |
| Inside FINISH — MERGE | `Skill("ralph-hero:ralph-merge")` — marked for conversion to `Agent()` per 2026-04-06 plan | haiku | currently inline but flagged | finish/SKILL.md:119 |
| Cross-repo decompose | `Agent(subagent_type="general-purpose")` × 2 (dry-run + create) | (unspecified) | **fresh context** | hero/SKILL.md:291–316 |

Dispatch Architecture section: hero/SKILL.md:425–437 describes the hybrid explicitly. Quote at line 429: "Skills run inline in hero's context window and CAN dispatch sub-agents via `Agent()`."

#### 1.2 What persists across handoffs

| Artifact | Storage | Created by | Consumed by | Self-healing lookup |
|---|---|---|---|---|
| Workflow state | GitHub Project V2 field | Each phase via `save_issue` | `get_issue` in the next phase | Pipeline detection (`get_issue(includePipeline=true)`) |
| Research doc | `thoughts/shared/research/YYYY-MM-DD-GH-NNNN-*.md` | ralph-research | ralph-plan | Artifact Comment Protocol → knowledge search → glob |
| Plan doc | `thoughts/shared/plans/YYYY-MM-DD-GH-NNNN-*.md` | ralph-plan / ralph-plan-epic | ralph-review, ralph-impl, ralph-val, finish | Same as above |
| Critique doc | `thoughts/shared/reviews/YYYY-MM-DD-GH-NNNN-critique.md` | ralph-review (auto) | hero orchestrator (verdict routing) | In-session only |
| Artifact comment | GitHub issue comment with `## Research Document` / `## Implementation Plan` / `## Plan Critique` header | Each artifact-producing phase | Any subsequent phase | `ralph_hero__get_issue` returns comments |
| Worktree | `worktrees/GH-NNN/` under repo | ralph-impl | ralph-pr, finish | Filesystem + `git worktree list` |
| TaskList state | In-session via TaskCreate/Update | Hero at startup | Hero's execution loop | Rebuild from current phase on new session |
| Drift log | Accumulated in commit messages (`DRIFT:` entries) | ralph-impl | ralph-val | `git log` |
| Session env vars | `$CLAUDE_ENV_FILE` (written by `set-skill-env.sh`) | Each skill's SessionStart hook | Phase-specific hooks | Re-set on skill load |

#### 1.3 Direct file-path handoffs (hero → next phase)

The one place hero short-circuits re-fetching is the `--research-doc {path}` and `--plan-doc {path}` flags:

- `Skill("ralph-hero:ralph-plan", args="NNN --review-plan auto --research-doc thoughts/shared/research/...")` — hero/SKILL.md:362
- `Agent(subagent_type="ralph-hero:impl-agent", prompt="Implement GH-NNN. Plan doc: thoughts/shared/plans/...")` — hero/SKILL.md:418
- `Skill("ralph-hero:ralph-review", args="NNN --review-plan auto --plan-doc thoughts/shared/plans/...")` — hero/SKILL.md:380

Hero reads `artifact_path` from the upstream task's `TaskGet` metadata (hero/SKILL.md:349, 415) and injects it into the downstream phase's args/prompt. Absent the flag, each phase falls back to the Artifact Comment Protocol → knowledge search → glob chain. This means the file-path handoff is an optimization, not the system of record — the system of record is GitHub comments + workflow state.

#### 1.4 Rationale for each dispatch choice

From the plan docs:

- **Skill() inline for research/plan/review**: "opus/sonnet and benefit from context sharing" (2026-04-06 plan, line 80). Also: "Agent()-spawned sub-agents cannot dispatch further sub-agents (empirically confirmed 2026-04-04), making all sub-agent dispatch instructions inside autonomous skills dead code in single-session mode. Skill() runs inline and preserves Agent() access" (GH-0732 plan, lines 20–22).
- **Agent() for impl**: worktree isolation is the defining concern — `ralph-impl`'s frontmatter declares a full worktree-enforcement hook stack that is easiest to reason about when the whole phase runs in its own session. CLAUDE.md line 87: "Plugin-level hooks in `hooks.json` discriminate by `agent_type` (e.g., `impl-agent` triggers worktree gates)."
- **Agent() for haiku phases (pr, merge, val)**: "when hero (running in Opus 1M context) invokes `Skill("ralph-hero:ralph-pr")`, the skill content loads into the current context window — then the haiku model tries to execute within a context that was built for 1M tokens, causing context crashes" (2026-04-06 plan, line 12). Val is already on `Agent()`; the 2026-04-06 plan converts pr and merge.

### 2. Agent-to-subagent fan-outs inside each phase

#### 2.1 Per-skill fan-out inventory

Source files under [`plugin/ralph-hero/skills/`](https://github.com/cdubiel08/ralph-hero/tree/8e6bb53/plugin/ralph-hero/skills).

**ralph-research** (Step 4, lines 151–156):
1. `Agent(subagent_type="ralph-hero:codebase-locator", ...)`
2. `Agent(subagent_type="ralph-hero:codebase-analyzer", ...)`
3. `Agent(subagent_type="ralph-hero:codebase-pattern-finder", ...)`
4. `Agent(subagent_type="ralph-hero:thoughts-locator", ...)`
5. `Agent(subagent_type="ralph-hero:thoughts-analyzer", ...)` (after locators)
6. `Agent(subagent_type="ralph-hero:web-search-researcher", ...)` (conditional)
7. `Agent(subagent_type="ralph-playwright:explorer-agent", ...)` (UI baseline, Step 7.5)

Fan-out pattern: parallel dispatch of 1–4 in a single message; thoughts-analyzer serial after locators; playwright conditional.

**ralph-plan** (Step 3, lines 189–197):
1. `Agent(subagent_type="ralph-hero:codebase-pattern-finder", ...)`
2. `Agent(subagent_type="ralph-hero:codebase-analyzer", ...)`
3. `Agent(subagent_type="ralph-hero:thoughts-locator", ...)`
4. `Agent(subagent_type="ralph-hero:thoughts-analyzer", ...)` (serial after locators)

Plus: `Skill("ralph-hero:ralph-split", "GH-NNN")` (line 515) — conditional on M-estimate issues.

**ralph-plan-epic** (Step 2, lines 115–118):
1. `Agent(subagent_type="ralph-hero:codebase-pattern-finder", ...)`
2. `Agent(subagent_type="ralph-hero:codebase-analyzer", ...)`

Plus: `Skill("ralph-hero:ralph-plan", ...)` per feature wave (Step 7, lines 233–256) — sequential per wave, parallel within waves.

**ralph-review (auto mode)** (Step 4B, lines 224–263):
1. `Agent(subagent_type="general-purpose", prompt="[critique instructions]")` — which internally dispatches:
   - `Agent(subagent_type="ralph-hero:codebase-analyzer", prompt="Verify files mentioned in plan exist")`

Nested one level.

**ralph-impl** (Step 7, lines 297–336):
1. Per task: `Agent(subagent_type="general-purpose", model=low→haiku|medium→sonnet|high→opus, prompt=implementer-prompt.md)` — parallel across independent tasks
2. Per task: `Agent(subagent_type="general-purpose", model="haiku", prompt=task-reviewer-prompt.md)` — serial after implementer
3. Per phase: `Agent(subagent_type="general-purpose", model="opus", prompt=phase-reviewer-prompt.md)` — after all tasks complete

Total per phase: `(N_tasks × 2) + 1` dispatches. Max 3 retries per task.

**ralph-split** (lines 72–120):
1. `Agent(subagent_type="ralph-hero:codebase-locator", ...)` — find M/L/XL issues
2. `Agent(subagent_type="ralph-hero:codebase-locator", ...)` — find related files
3. `Agent(subagent_type="ralph-hero:codebase-analyzer", ...)` — analyze primary component

**ralph-triage** (Step 3, lines 102–110):
1. `Agent(subagent_type="ralph-hero:codebase-locator", ...)` — duplication check

**ralph-pr, ralph-val**: no `Agent()` dispatches — pure CLI/git/verification operations.

**ralph-merge** (Step 4, lines 108–177):
- Conditional `Skill("code-review:code-review", ...)` — not an internal sub-agent fan-out.

**finish** (Steps 3–4a, lines 93–127):
1. `Agent(subagent_type="ralph-hero:val-agent", ...)` — Step 3
2. `Agent(subagent_type="ralph-hero:impl-agent", ...)` — Step 4a, conditional on review feedback
3. `Skill("ralph-hero:ralph-merge", args="NNN --pr-url PR_URL")` — Step 4

#### 2.2 Utility agent inventory

Source: [`plugin/ralph-hero/agents/`](https://github.com/cdubiel08/ralph-hero/tree/8e6bb53/plugin/ralph-hero/agents).

| Agent | Model | Skill preload | Tools | Role |
|---|---|---|---|---|
| `research-agent` | sonnet | ralph-research | full | phase wrapper |
| `plan-agent` | opus | ralph-plan | full | phase wrapper |
| `plan-epic-agent` | opus | ralph-plan-epic | full | phase wrapper |
| `review-agent` | opus | ralph-review | full | phase wrapper |
| `impl-agent` | opus | ralph-impl | full | phase wrapper |
| `split-agent` | opus | ralph-split | full | phase wrapper |
| `triage-agent` | sonnet | ralph-triage | full | phase wrapper |
| `pr-agent` | haiku | ralph-pr | minimal | phase wrapper |
| `val-agent` | haiku | ralph-val | minimal | phase wrapper |
| `merge-agent` | haiku | ralph-merge | minimal | phase wrapper |
| `codebase-locator` | haiku | (none) | Grep, Glob, Bash | utility — finds files |
| `codebase-analyzer` | sonnet | (none) | Read, Grep, Glob, Bash | utility — explains how code works |
| `codebase-pattern-finder` | haiku | (none) | Grep, Glob, Read, Bash | utility — finds pattern examples |
| `thoughts-locator` | haiku | (none) | Grep, Glob, Bash, knowledge-mcp | utility — finds docs |
| `thoughts-analyzer` | sonnet | (none) | Read, Grep, Glob, Bash, knowledge-mcp | utility — extracts decisions |
| `web-search-researcher` | sonnet | (none) | WebSearch, WebFetch, Read, Grep, Glob, Bash | utility — external research |

Phase agents (first 10 rows) are thin wrappers — `skills: [ralph-hero:ralph-*]` preloads the skill content into the agent context. Example: [`agents/research-agent.md`](https://github.com/cdubiel08/ralph-hero/blob/8e6bb53/plugin/ralph-hero/agents/research-agent.md) is 11 lines total.

Utility agents (last 6 rows) have no skill preload — their full behavior is in the agent markdown itself. They are standalone specialists.

#### 2.3 Frequency of utility-agent use

| Utility agent | Dispatched by |
|---|---|
| codebase-locator | ralph-research, ralph-split (×2), ralph-triage, research (interactive), plan (interactive) |
| codebase-analyzer | ralph-research, ralph-plan, ralph-plan-epic, ralph-split, ralph-review (nested), research, plan |
| codebase-pattern-finder | ralph-research, ralph-plan, ralph-plan-epic, research |
| thoughts-locator | ralph-research, ralph-plan, research, plan |
| thoughts-analyzer | ralph-research, ralph-plan, research, plan |
| web-search-researcher | ralph-research, research (conditional) |

`codebase-analyzer` and `codebase-locator` are the most-dispatched utilities. `thoughts-locator` and `thoughts-analyzer` always appear together — thoughts-analyzer consumes the output of thoughts-locator in every call site.

Pairing patterns observable in the skills:
- Every skill that calls `thoughts-locator` also calls `thoughts-analyzer` (serial).
- `codebase-locator` + `codebase-analyzer` frequently appear in parallel in the same research wave.
- `codebase-pattern-finder` is only used in analyst-phase skills (research, plan, plan-epic) and their interactive counterparts.

### 3. Interactive vs. autonomous skill variants

Three pairs exist: research / ralph-research, plan / ralph-plan, impl / ralph-impl. Source paths:

- Autonomous: [`plugin/ralph-hero/skills/ralph-research/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/8e6bb53/plugin/ralph-hero/skills/ralph-research/SKILL.md), [`ralph-plan/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/8e6bb53/plugin/ralph-hero/skills/ralph-plan/SKILL.md), [`ralph-impl/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/8e6bb53/plugin/ralph-hero/skills/ralph-impl/SKILL.md).
- Interactive: [`research/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/8e6bb53/plugin/ralph-hero/skills/research/SKILL.md), [`plan/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/8e6bb53/plugin/ralph-hero/skills/plan/SKILL.md), [`impl/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/8e6bb53/plugin/ralph-hero/skills/impl/SKILL.md).

#### 3.1 Frontmatter deltas

| Field | Autonomous | Interactive |
|---|---|---|
| `context: fork` | present (all 3) | absent (all 3) |
| `user-invocable: false` | present (all 3) | absent (defaults true) |
| `model:` | sonnet (research) / opus (plan, impl) | opus (all 3) |
| `!cat` fragments | yes (knowledge-metadata, escalation-steps) | no |

Only `ralph-research` downgrades the model relative to its interactive sibling.

#### 3.2 Tool allowlist deltas

**ralph-research** vs **research**:
- Autonomous adds: `ralph_hero__save_issue`, `ralph_hero__add_dependency`, `ralph_hero__remove_dependency` (state mutation)
- Interactive adds: `Edit`, `AskUserQuestion`

**ralph-plan** vs **plan**:
- Autonomous adds: `ralph_hero__sync_plan_graph` (sync `depends_on` → GitHub `blockedBy`)
- Interactive adds: `Edit`, `WebSearch`, `WebFetch`, `AskUserQuestion`, `ralph_hero__create_issue`

**ralph-impl** vs **impl**:
- Autonomous adds: `ralph_hero__list_sub_issues` (group discovery)
- Interactive adds: `WebSearch`, `WebFetch`, `AskUserQuestion`

Pattern: autonomous variants add state-mutation tools the pipeline needs to advance workflows without human confirmation; interactive variants keep `AskUserQuestion` and add `Edit`/`WebSearch` for human-guided exploration.

#### 3.3 Hook stacks

`ralph-research` frontmatter hooks (lines 7–29):
- SessionStart: `set-skill-env.sh RALPH_COMMAND=research RALPH_REQUIRED_BRANCH=main`
- PreToolUse(Bash): `branch-gate.sh`
- PostToolUse(get_issue): `research-state-gate.sh`
- Stop: `research-postcondition.sh`, `doc-structure-validator.sh`, `lock-release-on-failure.sh`

`ralph-plan` frontmatter hooks (lines 6–41):
- SessionStart: `set-skill-env.sh RALPH_COMMAND=plan RALPH_REQUIRED_BRANCH=main RALPH_REQUIRES_RESEARCH=true RALPH_PLAN_TYPE=plan`
- PreToolUse(Bash): `branch-gate.sh`
- PreToolUse(Write): `plan-research-required.sh`
- PreToolUse(save_issue): `plan-tier-validator.sh`
- PreToolUse(AskUserQuestion): `review-plan-gate.sh`
- PostToolUse(save_issue): `plan-state-gate.sh`
- Stop: `plan-postcondition.sh`, `doc-structure-validator.sh`, `lock-release-on-failure.sh`

`ralph-impl` frontmatter hooks (lines 6–43):
- SessionStart: `set-skill-env.sh RALPH_COMMAND=impl RALPH_VALID_OUTPUT_STATES='In Progress,In Review,Human Needed' RALPH_REQUIRES_PLAN=true`
- PreToolUse(Write|Edit): `impl-plan-required.sh`, `impl-worktree-gate.sh`
- PreToolUse(save_issue): `impl-state-gate.sh`
- PreToolUse(Bash): `impl-staging-gate.sh`, `impl-branch-gate.sh`
- PostToolUse(Write|Edit): `drift-tracker.sh`
- PostToolUse(Bash): `impl-verify-commit.sh`
- Stop: `impl-postcondition.sh`, `lock-release-on-failure.sh`

Interactive `research`: no hooks.
Interactive `plan`: one hook — `PreToolUse(AskUserQuestion)` runs `review-plan-gate.sh`.
Interactive `impl`: no hooks.

The autonomous variants are where enforcement lives.

#### 3.4 Sub-agent fan-out differences

- Interactive `plan` runs **two** research waves (Step 1 initial, Step 2 deeper after user clarification); autonomous `ralph-plan` runs **one** wave.
- Both `research` and `ralph-research` call the same 5–6 utility agents.
- Interactive `impl` mentions sub-agents only "sparingly — mainly for targeted exploration of unfamiliar areas" (impl/SKILL.md:129). No structured sub-agent dispatch protocol. Autonomous `ralph-impl` has the structured implementer/reviewer/phase-reviewer pattern.
- Interactive `impl` suggests worktree as optional ("Would you like me to set up an isolated worktree?" impl/SKILL.md:78–97). Autonomous `ralph-impl` requires it, hook-enforced.

### 4. Hook-enforced constraints and their dependency on fresh-context attribution

#### 4.1 Plugin-wide hooks

Source: [`plugin/ralph-hero/hooks/hooks.json`](https://github.com/cdubiel08/ralph-hero/blob/8e6bb53/plugin/ralph-hero/hooks/hooks.json).

| Matcher | Script(s) | Depends on `agent_type`? | Primary signal |
|---|---|---|---|
| SessionStart | `prune-merged-worktrees.sh`, `superpowers-bridge-session.sh` | no | none |
| PreToolUse(save_issue) | `pre-github-validator.sh`, `artifact-discovery.sh`, `human-needed-outbound-block.sh` | no | `$RALPH_COMMAND`, tool args |
| PreToolUse(get_issue) | `pre-ticket-lock-validator.sh`, `skill-precondition.sh` | yes (fallback only) | `$RALPH_COMMAND` primary |
| PreToolUse(list_issues) | `skill-precondition.sh` | yes (fallback only) | `$RALPH_COMMAND` primary |
| PreToolUse(Write\|Edit\|Bash) | `agent-phase-gate.sh` | **yes (for routing)** | `$RALPH_COMMAND` short-circuits |
| PreToolUse(Write) | `gitignore-enforcement.sh`, `pre-artifact-validator.sh` | no | tool args, filesystem |
| PreToolUse(Bash) | `pre-worktree-validator.sh` | no | tool args |
| PostToolUse(save_issue) | `post-github-validator.sh`, `outcome-collector.sh` | no | tool args |
| PostToolUse(create_comment) | `artifact-comment-validator.sh` | no | tool args |
| PostToolUse(get_issue) | `post-blocker-reminder.sh` | no | tool args |
| PostToolUse(Write) | `superpowers-bridge.sh`, `outcome-collector.sh` | no | env + tool args |
| PostToolUse(Bash) | `post-git-validator.sh` | no | tool args |

#### 4.2 The two identity signals

- **`.agent_type`** is runtime-injected into the hook JSON payload. `hook-utils.sh:36–40` defines `get_agent_type()` which strips the plugin prefix (`ralph-hero:impl-agent` → `impl-agent`).
- **`$RALPH_COMMAND`** is a shell env var written to `$CLAUDE_ENV_FILE` by `set-skill-env.sh`, invoked from each autonomous skill's `SessionStart` hook.

In normal Agent() dispatch, both fire — the agent preloads the skill, the skill's SessionStart sets `$RALPH_COMMAND`, and the runtime also injects `.agent_type`. In Skill() inline dispatch, only `$RALPH_COMMAND` fires (the skill's SessionStart still runs on skill load). `.agent_type` is empty because there's no agent — the skill is just running in the caller's session.

#### 4.3 Scripts that read `.agent_type`

Only four:

1. **`agent-phase-gate.sh`** (plugin-wide, Write|Edit|Bash):
   - Line 20: if `$RALPH_COMMAND` is set → `allow` (short-circuit).
   - Line 23: if `agent_type` is empty → `allow`.
   - Lines 27–38: route to phase-specific sub-scripts based on agent name.
   - Hook-compatibility analysis (GH-0732 plan, lines 60–62): "Checks `RALPH_COMMAND` first; if set, skips and defers to skill's own hooks. The `agent_type` routing is a fallback for team mode only."

2. **`impl-branch-gate.sh`** (declared in ralph-impl frontmatter, Bash):
   - Lines 18–22: primary check `$RALPH_COMMAND == "impl"`; fallback on `agent_type == "impl-agent"`.

3. **`skill-precondition.sh`** (plugin-wide, get_issue|list_issues):
   - Line 25: primary check `$RALPH_COMMAND`.
   - Lines 28–30: if `$RALPH_COMMAND` empty but `agent_type` non-empty → allow.

4. **`hook-utils.sh`**: defines `get_agent_type()` helper used by the above.

#### 4.4 Scripts that do NOT read `agent_type`

`pre-worktree-validator.sh`, `hero-dispatch-gate.sh`, `pre-github-validator.sh`, `human-needed-outbound-block.sh`, `gitignore-enforcement.sh`, `pre-artifact-validator.sh`, `artifact-comment-validator.sh`, `superpowers-bridge.sh`, `branch-gate.sh`, `impl-worktree-gate.sh`, `impl-plan-required.sh`, `impl-staging-gate.sh`, all postcondition scripts, `drift-tracker.sh`, `impl-verify-commit.sh`.

These fire identically regardless of dispatch mode.

#### 4.5 Impl-specific enforcement

The worktree-isolation tier is declared in `ralph-impl/SKILL.md` frontmatter (not in `hooks.json`):

- `impl-worktree-gate.sh` — blocks `Write`/`Edit` outside `$RALPH_WORKTREE_PATHS`; checks `$RALPH_COMMAND == "impl"`.
- `impl-staging-gate.sh` — blocks `git add -A`/`git add .`/`git add --all`.
- `impl-plan-required.sh` — blocks `Write`/`Edit` with no plan loaded.
- `impl-state-gate.sh` — validates state transitions against `RALPH_VALID_OUTPUT_STATES`.
- `impl-verify-commit.sh` — verifies commit conventions.
- `drift-tracker.sh` — records file changes for drift log.
- `impl-postcondition.sh`, `lock-release-on-failure.sh` — session-end checks.

Because these are declared in ralph-impl's frontmatter, they activate when ralph-impl loads — whether via `Agent("impl-agent")` (which preloads ralph-impl) or via `Skill("ralph-impl")` inline. The skill's own `set-skill-env.sh` sets `RALPH_COMMAND=impl`, and the hooks key off that. Per the GH-0732 hook-compatibility analysis, none of these hooks requires fresh-context agent attribution — they require the skill to be active.

#### 4.6 Hero-specific hook

`hero/SKILL.md:10–14` declares:
- `PreToolUse(matcher: Skill)`: `hero-dispatch-gate.sh` — guards that ralph-plan, ralph-plan-epic, and ralph-review are always called with `--review-plan` in their args.

This hook checks `$RALPH_COMMAND == "hero"` (line 17). It fires only inside a hero session.

## Code References

### Orchestrators and skills
- [`plugin/ralph-hero/skills/hero/SKILL.md:261-464`](https://github.com/cdubiel08/ralph-hero/blob/8e6bb53/plugin/ralph-hero/skills/hero/SKILL.md#L261-L464) — execution loop and phase dispatch
- [`plugin/ralph-hero/skills/hero/SKILL.md:425-437`](https://github.com/cdubiel08/ralph-hero/blob/8e6bb53/plugin/ralph-hero/skills/hero/SKILL.md#L425-L437) — Dispatch Architecture section
- [`plugin/ralph-hero/skills/ralph-research/SKILL.md:151-156`](https://github.com/cdubiel08/ralph-hero/blob/8e6bb53/plugin/ralph-hero/skills/ralph-research/SKILL.md#L151-L156) — 5-agent fan-out
- [`plugin/ralph-hero/skills/ralph-plan/SKILL.md:189-197`](https://github.com/cdubiel08/ralph-hero/blob/8e6bb53/plugin/ralph-hero/skills/ralph-plan/SKILL.md#L189-L197) — 4-agent fan-out
- [`plugin/ralph-hero/skills/ralph-plan-epic/SKILL.md:115-118`](https://github.com/cdubiel08/ralph-hero/blob/8e6bb53/plugin/ralph-hero/skills/ralph-plan-epic/SKILL.md#L115-L118) — 2-agent fan-out
- [`plugin/ralph-hero/skills/ralph-impl/SKILL.md:297-336`](https://github.com/cdubiel08/ralph-hero/blob/8e6bb53/plugin/ralph-hero/skills/ralph-impl/SKILL.md#L297-L336) — implementer/reviewer/phase-reviewer pattern
- [`plugin/ralph-hero/skills/finish/SKILL.md:93-127`](https://github.com/cdubiel08/ralph-hero/blob/8e6bb53/plugin/ralph-hero/skills/finish/SKILL.md#L93-L127) — val → optional impl fix → merge chain

### Phase agent wrappers (thin)
- [`plugin/ralph-hero/agents/research-agent.md`](https://github.com/cdubiel08/ralph-hero/blob/8e6bb53/plugin/ralph-hero/agents/research-agent.md) — 11 lines total
- [`plugin/ralph-hero/agents/plan-agent.md`](https://github.com/cdubiel08/ralph-hero/blob/8e6bb53/plugin/ralph-hero/agents/plan-agent.md)
- [`plugin/ralph-hero/agents/impl-agent.md`](https://github.com/cdubiel08/ralph-hero/blob/8e6bb53/plugin/ralph-hero/agents/impl-agent.md)

### Utility agent definitions
- [`plugin/ralph-hero/agents/codebase-locator.md`](https://github.com/cdubiel08/ralph-hero/blob/8e6bb53/plugin/ralph-hero/agents/codebase-locator.md)
- [`plugin/ralph-hero/agents/codebase-analyzer.md`](https://github.com/cdubiel08/ralph-hero/blob/8e6bb53/plugin/ralph-hero/agents/codebase-analyzer.md)
- [`plugin/ralph-hero/agents/codebase-pattern-finder.md`](https://github.com/cdubiel08/ralph-hero/blob/8e6bb53/plugin/ralph-hero/agents/codebase-pattern-finder.md)
- [`plugin/ralph-hero/agents/thoughts-locator.md`](https://github.com/cdubiel08/ralph-hero/blob/8e6bb53/plugin/ralph-hero/agents/thoughts-locator.md)
- [`plugin/ralph-hero/agents/thoughts-analyzer.md`](https://github.com/cdubiel08/ralph-hero/blob/8e6bb53/plugin/ralph-hero/agents/thoughts-analyzer.md)
- [`plugin/ralph-hero/agents/web-search-researcher.md`](https://github.com/cdubiel08/ralph-hero/blob/8e6bb53/plugin/ralph-hero/agents/web-search-researcher.md)

### Hook infrastructure
- [`plugin/ralph-hero/hooks/hooks.json`](https://github.com/cdubiel08/ralph-hero/blob/8e6bb53/plugin/ralph-hero/hooks/hooks.json) — plugin-wide hook registration
- [`plugin/ralph-hero/hooks/scripts/hook-utils.sh:36-40`](https://github.com/cdubiel08/ralph-hero/blob/8e6bb53/plugin/ralph-hero/hooks/scripts/hook-utils.sh#L36-L40) — `get_agent_type()`
- [`plugin/ralph-hero/hooks/scripts/agent-phase-gate.sh:17-38`](https://github.com/cdubiel08/ralph-hero/blob/8e6bb53/plugin/ralph-hero/hooks/scripts/agent-phase-gate.sh#L17-L38) — dual-signal routing
- [`plugin/ralph-hero/hooks/scripts/skill-precondition.sh:25-31`](https://github.com/cdubiel08/ralph-hero/blob/8e6bb53/plugin/ralph-hero/hooks/scripts/skill-precondition.sh#L25-L31) — agent_type fallback
- [`plugin/ralph-hero/hooks/scripts/set-skill-env.sh`](https://github.com/cdubiel08/ralph-hero/blob/8e6bb53/plugin/ralph-hero/hooks/scripts/set-skill-env.sh) — writes `$RALPH_COMMAND` into `$CLAUDE_ENV_FILE`
- [`plugin/ralph-hero/hooks/scripts/hero-dispatch-gate.sh:17`](https://github.com/cdubiel08/ralph-hero/blob/8e6bb53/plugin/ralph-hero/hooks/scripts/hero-dispatch-gate.sh#L17) — `$RALPH_COMMAND == "hero"` guard
- [`plugin/ralph-hero/hooks/scripts/impl-worktree-gate.sh`](https://github.com/cdubiel08/ralph-hero/blob/8e6bb53/plugin/ralph-hero/hooks/scripts/impl-worktree-gate.sh)
- [`plugin/ralph-hero/hooks/scripts/impl-staging-gate.sh`](https://github.com/cdubiel08/ralph-hero/blob/8e6bb53/plugin/ralph-hero/hooks/scripts/impl-staging-gate.sh)

## Architecture Documentation

### Dispatch primitives in current use

1. **`Skill("name", args="...")`** — inline dispatch. Skill content loads into caller's context. Skill's SessionStart hooks fire. Skill's frontmatter `model:` is honored. The skill can dispatch further sub-agents via `Agent()`. Used for analyst/builder opus/sonnet phases.

2. **`Agent(subagent_type="plugin:agent-name", prompt=..., description=...)`** — fresh-context dispatch. Agent preloads its `skills:` field (if present). Agent gets its own context window. Agent cannot dispatch further sub-agents (empirically confirmed 2026-04-04). Used for impl, haiku integrator phases, cross-repo decompose.

3. **`Agent(subagent_type="general-purpose", ...)`** — used by ralph-impl for per-task implementers and reviewers, and by hero for cross-repo `decompose_feature` calls.

### Two-axis taxonomy

Skills in ralph-hero classify along two axes:

**Axis 1: Dispatch level**
- Orchestrators: `hero`, `team` (deprecated), `finish`
- Phase skills: `ralph-split`, `ralph-research`, `ralph-plan`, `ralph-plan-epic`, `ralph-review`, `ralph-impl`, `ralph-pr`, `ralph-val`, `ralph-merge`, `ralph-triage`
- Interactive siblings: `research`, `plan`, `impl`, `iterate`
- Utility skills: `draft`, `form`, `hello`, `status`, `report`, `hygiene`, `prove-claim`, `bridge-artifact`, `idea-hunt`, `record-demo`, `setup*`, `gdrive-*`

**Axis 2: Invocation style**
- User-invocable (runs inline in the calling session)
- Non-user-invocable (runs via orchestrator, declares `user-invocable: false`, requires `context: fork` for team mode)

Autonomous phase skills are always non-user-invocable. Interactive siblings are user-invocable.

### Artifact Comment Protocol

Every artifact-producing phase writes a GitHub issue comment with a canonical header:
- `## Research Document`
- `## Implementation Plan`
- `## Plan Critique`

The comment body contains a permalink to the disk artifact. `artifact-comment-validator.sh` enforces this at PostToolUse on `create_comment` — if the header is present but a URL does not follow within 3 lines, the comment is rejected.

This protocol is the **primary** handoff mechanism between phases. The `--research-doc`/`--plan-doc` flags are optimizations that short-circuit comment lookup when hero has the path in TaskList metadata.

## Historical Context (from thoughts/)

Key decisions driving the current state:

**GH-0637 (2026-03-19) — Hero Dispatch Model**: Original problem statement. Identified that "each ralph-research, ralph-plan, and ralph-impl invocation consumes tokens in hero's context window, making long pipelines increasingly fragile." Proposed Agent() dispatch for all phases.

**GH-0674 (2026-03-24) — Agent-Per-Phase Architecture**: Identified three root causes that motivated dedicated per-phase agents: (1) sub-agents cannot spawn sub-agents, (2) `$VAR` references are unexpandable by LLMs in skill markdown, (3) plugin sub-agent hooks are silently ignored. Implemented `get_agent_type()` and agent_type fallback in `skill-precondition.sh` (Phase 1, ~50% complete).

**2026-04-01 — Agent-Per-Phase Reassessment**: Confirmed all three root causes still active; documented that Claude Code platform changes had not resolved any of them. `context: fork` in plugin-scoped skills still fails inconsistently (GitHub issue #16803 remains OPEN).

**2026-04-04 — Single vs Team Dispatch Research**: Empirically confirmed that `Agent()`-spawned sub-agents lose `Agent` tool access. This meant that in the Agent-per-phase architecture, all the sub-agent dispatch logic inside `ralph-research`, `ralph-plan`, and `ralph-impl` was dead code. Led to GH-0732.

**GH-0732 (2026-04-04) — Hero Skill Dispatch Migration**: Reversed direction. Hero now dispatches analyst/builder phases via `Skill()` inline (not `Agent()`), preserving sub-agent dispatch capability within those skills. Per-phase agents preserved for team mode. Hook-compatibility analysis confirmed all enforcement hooks use `$RALPH_COMMAND` as primary signal and `agent_type` as fallback — making the migration safe. Status: implemented-awaiting-manual-test.

**2026-04-06 — Haiku Skill-to-Agent Dispatch**: Follow-up that found haiku phases (pr, merge, val) crash when invoked as `Skill()` inline in hero's Opus 1M context — the haiku model cannot execute cleanly in that context envelope. Converted pr/merge back to `Agent()` dispatch. Val was already on `Agent()`. Analyst phases (research/plan/review) remain `Skill()` inline because they run on opus/sonnet and benefit from context sharing.

**2026-04-05 — Hero Pipeline Handoff UX Inventory**: Catalogued 8 handoff points between phases; documented AskUserQuestion usage and cost implications of alternative closing UX patterns.

**2026-02-22 — Ralph Workflow v4 Architecture Spec**: Foundational spec defining Claude Code primitive taxonomy (skills/agents/hooks/MCP), concern separation, and dispatch patterns for both hero and team modes. Establishes the Analyst → Builder → Integrator phase groupings.

**2026-02-20 (GH-0231) — Skill/Sub-agent/Team Context Pollution**: Identified that when skills spawn Task() sub-agents inside team context, phantom teammates appear in the roster. Contributed to the decision to keep sub-agent dispatch strictly via `Agent()` without `team_name`.

## Related Research

- [[2026-04-05-hero-pipeline-handoff-ux-inventory]] — 8-handoff inventory, AskUserQuestion usage
- [[2026-03-20-skill-dispatch-inventory]] — classification of all 29 ralph-hero skills by dispatch mode
- [[2026-02-21-debug-mode-observability-spec]] — JSONL session logging and collation MCP tools
- [[2026-02-23-GH-0361-v4-phase-7b-collation-stats-mcp-tools]] — Phase 7b observability metrics
- [[2026-02-17-GH-0044-worker-scope-boundaries]] — worker scope definition
- [[2026-02-17-GH-0045-analyst-worker-agent]] — analyst worker boundaries
- [[2026-02-17-GH-0046-builder-worker-agent]] — builder worker boundaries
- [[2026-02-17-GH-0050-hero-orchestrator-worker-update]] — hero/worker architectural alignment
- [[2026-02-17-GH-0053-teammate-inline-work-vs-skill-invocation]] — HOP (Higher-Order Prompt) pattern

Spec documents (read-only reference):
- [`specs/agent-permissions.md`](https://github.com/cdubiel08/ralph-hero/blob/8e6bb53/specs/agent-permissions.md)
- [`specs/skill-io-contracts.md`](https://github.com/cdubiel08/ralph-hero/blob/8e6bb53/specs/skill-io-contracts.md)
- [`specs/skill-permissions.md`](https://github.com/cdubiel08/ralph-hero/blob/8e6bb53/specs/skill-permissions.md)

## Open Questions

Surface-level observations that a consolidation analysis will need to resolve:

1. **thoughts-locator + thoughts-analyzer always pair**. Every call site dispatches them sequentially (locator first, analyzer after). Is the separation structural (different tool allowlists, knowledge-mcp access) or incidental (easier to reason about in isolation)?

2. **codebase-locator + codebase-pattern-finder overlap**. Both take haiku, both use Grep/Glob/Read/Bash. Pattern-finder returns examples; locator returns file paths. Could one haiku agent serve both needs?

3. **Research wave count asymmetry**. Interactive `plan` runs two research waves; autonomous `ralph-plan` runs one. Was this a deliberate narrowing (autonomy assumes good prior research) or a copy-paste artifact?

4. **`ralph-pr` and `ralph-merge` current vs. target dispatch**. The 2026-04-06 plan converts both from `Skill()` to `Agent()`. Is this migration complete at `8e6bb53`? (Verification: `grep -n 'Skill.*ralph-pr' plugin/ralph-hero/skills/*/SKILL.md` should return zero matches per the plan's verification steps.)

5. **Per-task implementer/reviewer/phase-reviewer nesting in ralph-impl**. Three dispatch tiers per phase (implementer → task reviewer → phase reviewer). Is each tier observably required by the enforcement stack, or could the task-reviewer collapse into the implementer under a single guard?

6. **`$RALPH_COMMAND` env var persistence across Skill() calls**. When hero calls `Skill("ralph-plan")`, ralph-plan's SessionStart sets `RALPH_COMMAND=plan`. When that skill returns to hero, does the env var revert to `hero` automatically, or does it linger? Answer determines whether adjacent inline skill calls can collide on env state.

7. **Interactive variants' hook-less posture**. Interactive `research`, `impl` have zero hooks. Interactive `plan` has one. Was this a deliberate choice to avoid interrupting human flow, or was it just that the autonomous path drove the enforcement investment?

8. **Web-search-researcher and Playwright explorer conditional dispatch**. Both utility agents are conditional. Are the conditions centrally checked, or duplicated across skill call sites?
