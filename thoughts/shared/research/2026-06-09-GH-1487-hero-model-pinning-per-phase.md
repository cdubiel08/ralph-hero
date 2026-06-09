---
date: 2026-06-09
github_issue: 1487
github_url: https://github.com/cdubiel08/ralph-hero/issues/1487
topic: "Model pinning per task step in the hero flow — current state + Fable 5 ladder change points"
tags: [research, hero, model-tiering, agent-dispatch, skills]
status: complete
type: research
---

# Research: Model pinning per task step in the hero flow

## Prior Work

- builds_on:: [[2026-05-13-GH-1250-model-tier-optimization-hero]] (plan — implemented & merged as PR #1251; establishes "complexity drives tier, not role" + BLOCKED escalation)
- builds_on:: [[2026-03-19-plan-of-plans-model-switching]] (research — primary evidence; mapped the sonnet switch-points and the Skill()-inline vs Agent()-fork model question)
- builds_on:: [[2026-03-19-GH-0637-hero-dispatch-model]] (research — root mechanism: inline Skill() overrides `context: fork`)
- builds_on:: [[2026-03-24-GH-0674-agent-per-phase-architecture]] (plan — made per-agent `model:` frontmatter actually honored via Agent() dispatch)
- builds_on:: [[2026-05-15-GH-1265-haiku-context-compaction-integrator-agents]] (research — haiku 200k cap applies to parent session on inline Skill() calls)
- builds_on:: [[2026-05-14-GH-1250-pr1251-elegant-fixes-from-ralph-hero]] (research — post-merge review; BLOCKED prefix-match fix, env-var signaling alternative)

## Research Question

Our current model pinning per task step in the hero flow; the user wants the research and planning steps and the parent orchestrator to use Fable 5 (the best model) for the most important steps, then opus, then sonnet, etc.

## Summary

Model selection in the hero flow is **declarative-first, env-override-second, escalation-third**:

1. The **hero parent session** is pinned `model: opus` (`ralph/skills/hero/SKILL.md:5`). No other mechanism sets the parent model.
2. Hero dispatches phases via **inline `Skill()`, not `Agent()`** (`ralph/skills/hero/dispatch.md:20-28`), so each phase session runs at the *phase skill's* frontmatter pin. Research, plan, impl, review, and caretake SKILL.md all pin `model: opus` — phase sessions are uniformly opus today; tiering happens one level down in sub-agents.
3. **All 16 agents pin a model in frontmatter** and inherit nothing: plan-agent/review-agent = opus; research-agent/impl-agent/val-agent/triage-agent/sre-fixit/codebase-analyzer/thoughts-analyzer/web-search-researcher = sonnet; merge-agent/catch-up-agent/codebase-locator/codebase-pattern-finder/thoughts-locator/log-reader = haiku.
4. Inside `/ralph:impl --auto`, **per-task `complexity` drives sub-agent dispatch** (low→haiku, medium→sonnet, high→opus; `ralph/skills/impl/phase-execution.md:11,26`), plus a haiku task-reviewer and an opus phase-reviewer.
5. **`RALPH_IMPL_MODEL` (default sonnet) is the only live env override** (`hero/dispatch.md:32-35`). The `IMPL BLOCKED ... needs=opus` verdict triggers exactly one re-dispatch at opus; a second BLOCKED escalates to Human Needed. `RALPH_SPLIT_MODEL` is documented in CLAUDE.md but dead — nothing reads it.
6. **"fable" appears nowhere in the repo**, and `docs/model-tier-policy.md` — still referenced by `ralph/agents/impl-agent.md:3` — no longer exists on the live tree (deleted with `plugin/ralph-hero/` in GH-1438; only copy is in the orphaned `.git/impl-1318` worktree).

For the desired Fable 5 ladder: `fable` is an officially documented model alias for **both** agent frontmatter and skill SKILL.md frontmatter (and full IDs like `claude-fable-5` are accepted), so the change is mechanically frontmatter edits at the pin points listed under Files Affected, plus retargeting the BLOCKED escalation rung.

## Detailed Findings

### Hero orchestrator (parent + phase dispatch)

- Parent session pin: `model: opus` at `ralph/skills/hero/SKILL.md:5`. No README/CLAUDE.md recommendation exists for the hero session model beyond this pin.
- Phase → verb map at `ralph/skills/hero/dispatch.md:7-16`: SPLIT→`/ralph:caretake --mode split`, RESEARCH→`/ralph:research --auto`, PLAN→`/ralph:plan --auto`, REVIEW(plan)→`/ralph:plan --mode review`, IMPLEMENT→`/ralph:impl --auto`, PR→`/ralph:impl --mode pr`, INTEGRATE→`/ralph:review`.
- These are `Skill()` calls with **no `model=` param** — the dispatched skill's own frontmatter governs (`dispatch.md:20-28`).
- IMPLEMENT model selection: `impl_model="${RALPH_IMPL_MODEL:-sonnet}"` (`dispatch.md:30-38`; surfaced at load time via `hero/SKILL.md:104`).
- BLOCKED escalation (`dispatch.md:40-57`): verdict prefix `IMPL BLOCKED ` (prefix-match only, per the PR #1251 fix) → if current model wasn't opus and no prior retry, re-dispatch once with `RALPH_IMPL_MODEL=opus`; else `save_issue(workflowState="__ESCALATE__")` → Human Needed + PushNotification. At most ONE tier bump.
- Watch mode (`watch-dispatch.md:27-28`) routes to `ralph:log-reader` (haiku) and `ralph:sre-fixit` (sonnet) via `Agent()` with no model override.

### Skill frontmatter pins (govern phase sessions, because dispatch is inline)

| Skill | Pin | Location |
|---|---|---|
| hero | opus | `ralph/skills/hero/SKILL.md:5` |
| research | opus | `ralph/skills/research/SKILL.md:13` |
| plan | opus | `ralph/skills/plan/SKILL.md:16` |
| impl | opus | `ralph/skills/impl/SKILL.md:14` |
| review | opus | `ralph/skills/review/SKILL.md:5` |
| caretake | opus | `ralph/skills/caretake/SKILL.md:5` (all modes; per-mode haiku rejected for arg-routing simplicity, `modes/trends.md:48`) |
| setup | haiku | `ralph/skills/setup/SKILL.md:6` |
| form, catch-up | (no pin — inherit) | — |

### Agent frontmatter pins (govern Agent()-forked sub-agents)

Per-phase agents: research-agent sonnet, plan-agent opus, review-agent opus, impl-agent sonnet, merge-agent haiku, val-agent sonnet, triage-agent sonnet, catch-up-agent haiku (all at `ralph/agents/<name>.md:4`).

Investigators: codebase-analyzer sonnet, codebase-locator haiku, codebase-pattern-finder haiku, thoughts-analyzer sonnet, thoughts-locator haiku, web-search-researcher sonnet (`:5`), log-reader haiku, sre-fixit sonnet (`:4`).

These pins take effect on every `Agent()` dispatch that omits `model=` — which is all of them in research-shapes, review, caretake, and catch-up dispatch recipes (`catch-up/next-action-ranking.md:92-98`).

### Impl auto-mode internal tiering

- `complexity: low|medium|high` per plan task → haiku/sonnet/opus implementer (`ralph/skills/impl/phase-execution.md:11,26`).
- Task reviewer: `model="haiku"` (`phase-execution.md:32`); phase quality reviewer: `model="opus"` (`phase-execution.md:55`).
- Tier exhaustion below opus emits `IMPL BLOCKED model=<current> needs=opus reason=<short>` and STOPs (`phase-execution.md:40-48`, `impl/SKILL.md:172`, `plan-compliance.md:90`).

### Effective per-phase model table (current state)

| Phase | Effective session model | Sub-agent models |
|---|---|---|
| Hero parent | opus | — |
| RESEARCH | opus (skill pin) | investigators haiku/sonnet |
| PLAN | opus (skill pin) | critique sub-agent inherits opus (`plan-review.md:106`) |
| REVIEW (plan) | opus (skill pin) | — |
| IMPLEMENT | opus session; `${RALPH_IMPL_MODEL:-sonnet}` ladder | tasks haiku/sonnet/opus by complexity; reviewers haiku + opus |
| PR | opus (impl skill pin) | — |
| INTEGRATE | opus (review skill pin) | val-agent sonnet, fix-cycle impl-agent sonnet, merge-agent haiku; code-review plugin: 5× sonnet + N× haiku |
| SPLIT / TRIAGE | opus (caretake skill pin) | investigators haiku/sonnet; triage-agent sonnet when Agent()-dispatched |
| CATCH-UP | inherits caller | catch-up-agent haiku |
| WATCH | opus (hero pin) | log-reader haiku, sre-fixit sonnet |

### Override mechanisms

1. Frontmatter `model:` pins — primary mechanism (every agent, most skills).
2. `RALPH_IMPL_MODEL` — the single live env override; default sonnet; set to opus by BLOCKED escalation.
3. `complexity` field in plan task blocks — impl-internal tier routing.
4. `RALPH_SPLIT_MODEL` — **documented but dead** (CLAUDE.md:80 mentions it; zero reads in `ralph/` or `mcp-server/src/`). The old per-agent `RALPH_<AGENT>_MODEL` family from the deleted model-tier-policy.md was never wired into the slim plugin.
5. `CLAUDE_CODE_SUBAGENT_MODEL` (harness-level, unset here) would globally override per-subagent frontmatter — relevant as a footgun/feature when re-tiering.

### Fable 5 feasibility (verified against official docs, 2026-06)

- `fable` is a documented alias in agent frontmatter (`sonnet`/`opus`/`haiku`/`fable`/full-ID/`inherit`, code.claude.com/docs/en/sub-agents) and in skill frontmatter (accepts the same values as `/model`, which lists `fable`; skills.md + model-config.md). Full IDs (`claude-fable-5`) also accepted; `[1m]` suffix works on session model config (not explicitly exemplified for frontmatter).
- Requires Claude Code v2.1.170+. Fable 5 has 1M context — the GH-1265 trap (haiku 200k cap squeezing the parent on inline Skill() loads) does not apply; pinning fable on inline-loaded skills upgrades, never caps, the parent envelope.
- Cost/throughput caveats: pricing above opus-tier; new tokenizer ≈ 30% more tokens for identical content; single turns can run long. Tier ladder: Fable 5 > Opus 4.8 > Sonnet 4.6 > Haiku 4.5.
- Fable 5 auto content fallback can reroute flagged requests to Opus 4.8 — harmless here but worth knowing when reading transcripts.

## Files Affected

### Will Modify (for the Fable-ladder follow-up)

- `ralph/skills/hero/SKILL.md` — parent pin opus → fable (line 5)
- `ralph/skills/research/SKILL.md` — pin opus → fable (line 13)
- `ralph/skills/plan/SKILL.md` — pin opus → fable (line 16)
- `ralph/agents/plan-agent.md` — opus → fable (line 4), if agents follow the ladder up
- `ralph/agents/review-agent.md` — opus → fable (line 4), same decision
- `ralph/skills/hero/dispatch.md` — escalation target `needs=opus` / `RALPH_IMPL_MODEL=opus` → new top rung (lines 42-50)
- `ralph/skills/impl/SKILL.md` + `ralph/skills/impl/phase-execution.md` + `ralph/skills/impl/plan-compliance.md` — `IMPL BLOCKED needs=opus` token + high-complexity tier (whether high→opus stays or shifts)
- `CLAUDE.md` — env-var table + model-tier prose; remove or wire `RALPH_SPLIT_MODEL`
- `docs/model-tier-policy.md` — resurrect (currently referenced by `ralph/agents/impl-agent.md:3` but absent)

### Will Read (Dependencies)

- `ralph/skills/hero/SKILL.md` / `dispatch.md` — dispatch + escalation contract
- `ralph/skills/review/auto-vs-interactive.md` — depth-0 opus rationale (would need re-justification at fable)
- `ralph/skills/catch-up/next-action-ranking.md` — per-state Agent() recipes inherit agent pins
- `ralph/agents/*.md` — remaining tier assignments

## Code References

- `ralph/skills/hero/SKILL.md:5` — hero parent `model: opus`
- `ralph/skills/hero/SKILL.md:104` — `Impl model: ${RALPH_IMPL_MODEL:-sonnet}` surfaced at load
- `ralph/skills/hero/dispatch.md:7-16` — phase → verb map (all inline Skill(), no model param)
- `ralph/skills/hero/dispatch.md:30-38` — IMPLEMENT model selection via `RALPH_IMPL_MODEL`
- `ralph/skills/hero/dispatch.md:40-57` — `IMPL BLOCKED ` prefix detection, one-shot opus re-dispatch, `__ESCALATE__` on second BLOCKED
- `ralph/skills/hero/watch-dispatch.md:27-28` — watch-mode investigator routing
- `ralph/skills/impl/phase-execution.md:11,26,32,55` — complexity→model task dispatch; haiku task-reviewer; opus phase-reviewer
- `ralph/skills/impl/SKILL.md:172` — BLOCKED emit-and-stop contract
- `ralph/skills/plan/plan-review.md:106-109` — critique sub-agent inherits parent opus
- `ralph/skills/review/auto-vs-interactive.md:9,26` — code-review fan-out tiers + depth-0 opus rationale
- `ralph/agents/impl-agent.md:3` — dangling reference to `docs/model-tier-policy.md`
- `CLAUDE.md:80,227` — `RALPH_IMPL_MODEL` / `RALPH_SPLIT_MODEL` documentation

## Architecture Documentation

- **Skill() vs Agent() is the load-bearing axis** (GH-0637/GH-0674/GH-1265): inline `Skill()` applies the skill's `model:` to the parent session (including its context cap); `Agent()` forks an isolated context honoring the agent's pin. Hero deliberately uses inline `Skill()` for phases, so skill pins — not agent pins — govern the hero flow's phase sessions.
- **Policy principle on record** (GH-1250, from the deleted model-tier-policy.md): "Complexity drives tier, not role. Escalate on BLOCKED, never preemptively" — backed by a landcrawler-ai 30-day audit showing most impl phases are mechanical.
- **Escalation signaling** is transcript-grep on the `IMPL BLOCKED ` prefix; an env-var alternative (`RALPH_IMPL_NEEDS_ESCALATION`) was researched (2026-05-14) and left unresolved.

## Historical Context (from thoughts/)

- `thoughts/shared/plans/2026-05-13-GH-1250-model-tier-optimization-hero.md` — the implemented tier policy (PR #1251): impl-agent + split downgraded opus→sonnet; plan/review kept opus; BLOCKED one-shot escalation contract; telemetry deferred ("measurement is by-eye").
- `thoughts/shared/research/2026-03-19-plan-of-plans-model-switching.md` — user's earlier desire to keep plan-of-plans on the top tier; identified `ralph-split` and investigator sub-agents as unexpected downgrades.
- `thoughts/shared/research/2026-05-15-GH-1265-haiku-context-compaction-integrator-agents.md` — inline Skill() + `model: haiku` compacts a 1M parent to 200k; fixed by Agent()-forking the merge step. Context-window facts: Opus/Sonnet 1M, Haiku 200k.
- `thoughts/shared/research/2026-05-14-GH-1250-pr1251-elegant-fixes-from-ralph-hero.md` — BLOCKED verdict prefix mismatch fix; CLAUDE.md env-var gap; transcript-grep vs env-var signaling debate.

## Related Research

- [[2026-03-19-GH-0637-hero-dispatch-model]]
- [[2026-02-21-GH-0257-bough-model-skill-md]]
- [[2026-05-26-harness-engineering-five-pillars-distillation]] (§ per-phase model tiers summary)

## Open Questions

1. ~~Where does the ladder top out per step?~~ → resolved, see Design Decisions.
2. ~~Escalation target~~ → resolved, see Design Decisions.
3. ~~Cost guardrails / env overrides~~ → resolved, see Design Decisions.
4. ~~`docs/model-tier-policy.md` resurrection~~ → resolved, see Design Decisions.
5. **`[1m]` suffix in frontmatter** is not explicitly exemplified in docs (aliases and full IDs are) — verify behavior if a 1M-pinned fable frontmatter value is desired.

## Design Decisions (2026-06-09, with user)

Resolved interactively after the findings review; these are inputs to the implementation plan.

| # | Decision | Choice |
|---|---|---|
| D1 | Fable scope | `hero/SKILL.md`, `research/SKILL.md`, `plan/SKILL.md` pins → `fable`; **plus** `plan-agent.md` and `review-agent.md` frontmatter → `fable` so Agent()-forked entry points (catch-up recipes) match the inline-Skill() tier |
| D2 | BLOCKED escalation rung | Retarget the one-shot escalation to **fable**: `IMPL BLOCKED needs=fable`, hero re-dispatch sets `RALPH_IMPL_MODEL=fable`. One-bump contract unchanged; second BLOCKED still → Human Needed |
| D3 | Env override surface | Keep `RALPH_IMPL_MODEL` as the only override (its escalation value becomes `fable`); **remove** the dead `RALPH_SPLIT_MODEL` mention from CLAUDE.md; no new per-phase vars |
| D4 | Policy doc | **Resurrect `docs/model-tier-policy.md`** with the fable→opus→sonnet→haiku ladder, complexity-drives-tier rule, and the escalation contract; fixes `impl-agent.md:3` dangling reference |

Explicitly out of scope: impl's internal complexity ladder (low→haiku / med→sonnet / high→opus stays), investigator agent tiers (locators haiku / analyzers sonnet stay), review/caretake skill pins (stay opus).
