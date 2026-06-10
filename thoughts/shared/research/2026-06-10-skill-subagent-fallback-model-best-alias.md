---
date: 2026-06-10
topic: "Can a skill or subagent declare a fallback model when a user does not have access to Fable?"
tags: [research, model-tiers, skills, agents, claude-code]
status: complete
type: research
---

# Research: Skill/Subagent Fallback Model When User Lacks Fable Access

## Prior Work

- builds_on:: [[2026-06-09-GH-1487-hero-model-pinning-per-phase]] (research — primary evidence; audited every model pin in the hero flow, verified `fable` alias support in frontmatter)
- builds_on:: [[2026-06-09-GH-1487-fable-model-ladder-retiering]] (plan — IMPLEMENTED: merged 2026-06-09 via PR #1488, merge SHA `83534497`, released as ralph-v0.1.37; pins 5 surfaces to `fable` with no provision for users lacking Fable access)
- builds_on:: [[2026-05-13-GH-1250-model-tier-optimization-hero]] (plan — established "complexity drives tier" + escalate-on-BLOCKED-never-preemptively-downgrade philosophy)
- builds_on:: [[2026-05-14-GH-1250-pr1251-elegant-fixes-from-ralph-hero]] (research — documents the env-var override precedent used by triage/split)
- builds_on:: [[2026-05-15-GH-1265-haiku-context-compaction-integrator-agents]] (research — inline `Skill()` vs `Agent()` dispatch model-context semantics)

## Research Question

Is it possible for a skill or subagent to have a fallback model if a user does not have access to Fable?

## Summary

**There is no per-skill/per-subagent fallback *syntax* — the `model:` frontmatter field accepts exactly one value — but Claude Code ships a native entitlement-aware fallback *alias*: `best`**, defined as "Uses Fable 5 where your organization has access to it, otherwise the latest Opus model" ([model-config](https://code.claude.com/docs/en/model-config.md)). Whether `best` is accepted varies by surface:

| Surface | `best` supported? | Confidence | Evidence |
|---|---|---|---|
| `/model best`, `--model`, `ANTHROPIC_MODEL`, settings.json `model` | Yes | High (documented) | model-config alias table; "Sessions use Fable 5 only after you choose it, with `/model fable`, a `model` setting, or the `best` alias where Fable 5 is available" |
| Skill frontmatter `model:` | Likely yes | Medium | skills.md: frontmatter "accepts the same values as [`/model`](/en/model-config)" — open-ended deference; `best` not named explicitly |
| Subagent frontmatter `model:` | Ambiguous, leaning no | Medium | sub-agents.md gives a **closed enumeration**: `sonnet`, `opus`, `haiku`, `fable`, full model ID, or `inherit`. An adjacent line ("Accepts the same values as the `--model` flag") contradicts the enumeration — undocumented gap |
| Per-invocation `Agent(model=...)` param | No | High (empirical) | The Agent tool's `model` parameter is a closed enum `sonnet`/`opus`/`haiku`/`fable` in a live 2026-06-10 session |
| `fallbackModel` chain element | Probably | Medium | "Each element accepts a model name or alias"; `best` never shown as an example |
| `CLAUDE_CODE_SUBAGENT_MODEL=best` | Unknown | Low | No valid-values list documented for this variable |

Secondary mechanisms that simulate a fallback when `best` is unavailable on a surface:

1. **Alias remapping** — `ANTHROPIC_DEFAULT_FABLE_MODEL` controls what the `fable` alias resolves to. A no-Fable user (or admin) sets it to an Opus model ID and every `model: fable` pin silently becomes Opus. This is also the *required* pinning mechanism on Bedrock/Vertex/Foundry.
2. **Session-level fallback chains** — `--fallback-model sonnet,haiku` / `"fallbackModel": [...]` in settings. Triggers on overloaded/unavailable/non-retryable server errors; explicitly **not** on auth, billing, or rate-limit errors. Whether "not entitled" manifests as a chain-triggering "unavailable" is undocumented. Chains are capped at 3 models; elements outside an `availableModels` allowlist are dropped.
3. **`CLAUDE_CODE_SUBAGENT_MODEL`** — forces ALL subagents to one model, overriding both the per-invocation `model` param and frontmatter. Blunt but decisive.

Distinct and easily confused: Fable 5's **automatic model fallback** to Opus is *content-based* (safety classifiers for cybersecurity/biology), not entitlement-based, and its target is fixed (Opus 4.8 on the Anthropic API), not configurable.

**Ralph has zero handling of "requested model unavailable" today** — all 16 agents and 7 of 10 skills carry hard single-value pins, the only wired override is `RALPH_IMPL_MODEL` (read solely by hero dispatch), and the `IMPL BLOCKED needs=<tier>` escalation only moves *up*-tier. **GH-1487 already shipped**: merged 2026-06-09 (PR #1488, merge SHA `83534497`) and released as ralph-v0.1.37, so the five `fable` pins (hero/research/plan SKILL.md + plan-agent/review-agent) and the `needs=fable` escalation are live in the distributed plugin. Any plugin user without Fable access (entitlement or Claude Code < 2.1.170) is exposed to the undocumented model-unavailable path **now**. Substituting `best` on those pins — plus documenting the `ANTHROPIC_DEFAULT_FABLE_MODEL` escape hatch — is the natural graceful-degradation follow-up, pending a one-shot empirical verification of `best` on the agent-frontmatter surface.

## Detailed Findings

### Claude Code platform: model resolution surfaces

- **Subagent frontmatter `model:`** ([sub-agents.md](https://code.claude.com/docs/en/sub-agents.md)) — accepts `sonnet`, `opus`, `haiku`, `fable`, a full model ID (e.g. `claude-opus-4-8`), or `inherit`; defaults to `inherit`. The "Choose a model" section enumerates exactly four aliases, then separately states full-ID support "accepts the same values as the `--model` flag" — the `--model` flag accepts `best`, so the docs are internally ambiguous about `best` in agent frontmatter.
- **Skill frontmatter `model:`** ([skills.md](https://code.claude.com/docs/en/skills.md)) — "Model to use when this skill is active. The override applies for the rest of the current turn… Accepts the same values as `/model`, or `inherit`." Since `/model best` is valid, skill frontmatter likely accepts `best`.
- **Subagent model resolution order** — (1) `CLAUDE_CODE_SUBAGENT_MODEL` env var, (2) per-invocation `model` param on the Agent tool, (3) agent frontmatter `model:`, (4) main-conversation model. No fallback step exists in the chain.
- **`best` alias** ([model-config.md](https://code.claude.com/docs/en/model-config.md)) — "Uses Fable 5 where your organization has access to it, otherwise the latest Opus model." The only alias whose resolution is entitlement-aware. Fable 5 requires Claude Code v2.1.170+; behavior of `best` on older versions is undocumented (presumably resolves to Opus, but no explicit guarantee).
- **What happens when a pinned model is not entitled** — undocumented for the Anthropic API. Third-party providers have partial behavior: Bedrock/Vertex show a notice and fall back to the previous version for the session; Foundry errors (no startup check).
- **`availableModels` allowlist** — managed-settings restriction on which models users can select; fallback-chain elements outside it are dropped. The Default picker option always remains available and resolves per subscription tier.
- **Fable 5 safety fallback** — content-based re-run on Opus when a classifier flags a request; configurable only in *when to ask* (`/config` → "switch models when a message is flagged"), not in target model. Not an entitlement mechanism.

### Ralph: current model-pinning architecture (no fallback anywhere)

> Pin values below were surveyed at local commit `ab23f444`, which predates the GH-1487 merge. As of origin/main `83534497` (ralph-v0.1.37): hero/research/plan `SKILL.md` and `plan-agent`/`review-agent` pin **`fable`** (not opus), escalation reads **`needs=fable`**, and `docs/model-tier-policy.md` exists with the fable→opus→sonnet→haiku ladder. Everything else is unchanged.

- All 16 agents pin a model in frontmatter — none uses `inherit`: 6× haiku (`catch-up-agent`, `codebase-locator`, `codebase-pattern-finder`, `log-reader`, `merge-agent`, `thoughts-locator`), 8× sonnet (`codebase-analyzer`, `impl-agent`, `research-agent`, `sre-fixit`, `thoughts-analyzer`, `triage-agent`, `val-agent`, `web-search-researcher`), 2× opus→**fable** (`plan-agent`, `review-agent`) — `ralph/agents/*.md:4-5`.
- 7 of 10 skills pin: opus on impl/review/caretake, **fable** on hero/research/plan (post-GH-1487), haiku on setup; catch-up/form/using-html omit the field (inherit) — `ralph/skills/*/SKILL.md`.
- The only wired env override is `RALPH_IMPL_MODEL`, read exclusively by hero at `ralph/skills/hero/dispatch.md:32-36` (`impl_model="${RALPH_IMPL_MODEL:-sonnet}"`). `RALPH_SPLIT_MODEL` is documented at `CLAUDE.md:80` but dead — zero reads anywhere.
- The `IMPL BLOCKED model=<current> needs=opus reason=<short>` escalation contract (`ralph/skills/impl/phase-execution.md:38-48`, parsed by `ralph/skills/hero/dispatch.md:42-57` and accepted by `ralph/hooks/scripts/impl-postcondition.sh:26-37`) re-dispatches at most once at the higher tier. It is an *upgrade* path only; there is no downgrade/fallback analog.
- A repo-wide search for unavailable/fallback/access handling around model selection found nothing — the only "unavailable" degradation prose in ralph concerns MCP tools (knowledge graph, playwright), never models.
- Within `/ralph:impl`, plan-task `complexity:` drives inner sub-agent tiers (low→haiku, medium→sonnet, high→opus; `ralph/skills/impl/phase-execution.md:11`), independent of `RALPH_IMPL_MODEL`.

### GH-1487 shipped the exposure: where `best` would and wouldn't slot in

GH-1487 (Done; PR #1488 merged 2026-06-09, released as ralph-v0.1.37) pinned `fable` at five points and retargeted escalation to `needs=fable`. These pins are live in the distributed plugin today. Per-surface viability of swapping to `best`:

| Pin point (now `model: fable`) | Surface type | `best` viability |
|---|---|---|
| `ralph/skills/hero/SKILL.md` | Skill frontmatter | Likely works (defers to `/model` values) |
| `ralph/skills/research/SKILL.md` | Skill frontmatter | Likely works |
| `ralph/skills/plan/SKILL.md` | Skill frontmatter | Likely works |
| `ralph/agents/plan-agent.md` | Agent frontmatter | Ambiguous — docs enumerate only 4 aliases |
| `ralph/agents/review-agent.md` | Agent frontmatter | Ambiguous — same |
| Escalation re-dispatch (`needs=fable` → `RALPH_IMPL_MODEL=fable` / `Agent(model=...)`) | Dispatch param | `best` absent from the Agent tool's model enum — escalation must keep a concrete alias |

For plugin users without Fable access, the working escape hatch regardless of surface is `ANTHROPIC_DEFAULT_FABLE_MODEL=<an Opus model ID>` (remaps the `fable` alias itself), optionally combined with a `fallbackModel` chain. Neither is currently mentioned in `docs/model-tier-policy.md`, `CLAUDE.md`, or `README.md`.

## Code References

- [`ralph/skills/hero/dispatch.md:32-36`](https://github.com/cdubiel08/ralph-hero/blob/ab23f4449ecea066dafd31131c5fcd0f6da00465/ralph/skills/hero/dispatch.md#L32-L36) — sole reader of `RALPH_IMPL_MODEL`; model selection for IMPLEMENT phase
- [`ralph/skills/hero/dispatch.md:42-57`](https://github.com/cdubiel08/ralph-hero/blob/ab23f4449ecea066dafd31131c5fcd0f6da00465/ralph/skills/hero/dispatch.md#L42-L57) — BLOCKED escalation: one re-dispatch at `RALPH_IMPL_MODEL=opus`, then Human Needed
- [`ralph/skills/impl/phase-execution.md:11,38-48`](https://github.com/cdubiel08/ralph-hero/blob/ab23f4449ecea066dafd31131c5fcd0f6da00465/ralph/skills/impl/phase-execution.md#L38-L48) — complexity→tier ladder; `IMPL BLOCKED` token format and emission conditions
- [`ralph/skills/impl/plan-compliance.md:90`](https://github.com/cdubiel08/ralph-hero/blob/ab23f4449ecea066dafd31131c5fcd0f6da00465/ralph/skills/impl/plan-compliance.md#L90) — second BLOCKED emission site (plan-vs-reality mismatch)
- [`ralph/hooks/scripts/impl-postcondition.sh:26-37`](https://github.com/cdubiel08/ralph-hero/blob/ab23f4449ecea066dafd31131c5fcd0f6da00465/ralph/hooks/scripts/impl-postcondition.sh#L26-L37) — Stop hook accepting the BLOCKED token as non-error terminal state
- [`ralph/agents/impl-agent.md:3-10`](https://github.com/cdubiel08/ralph-hero/blob/ab23f4449ecea066dafd31131c5fcd0f6da00465/ralph/agents/impl-agent.md#L3-L10) — sonnet default + BLOCKED verdict-prefix contract
- [`ralph/agents/plan-agent.md:4`](https://github.com/cdubiel08/ralph-hero/blob/ab23f4449ecea066dafd31131c5fcd0f6da00465/ralph/agents/plan-agent.md#L4), [`ralph/agents/review-agent.md:4`](https://github.com/cdubiel08/ralph-hero/blob/ab23f4449ecea066dafd31131c5fcd0f6da00465/ralph/agents/review-agent.md#L4) — the two agent pins flipped opus→fable by GH-1487 (permalinks show pre-merge state at `ab23f444`)
- [`CLAUDE.md:80,227`](https://github.com/cdubiel08/ralph-hero/blob/ab23f4449ecea066dafd31131c5fcd0f6da00465/CLAUDE.md#L80) — `RALPH_IMPL_MODEL` docs; stale `RALPH_SPLIT_MODEL` mention
- [`mcp-server/src/__tests__/skill-frontmatter.test.ts`](https://github.com/cdubiel08/ralph-hero/blob/ab23f4449ecea066dafd31131c5fcd0f6da00465/mcp-server/src/__tests__/skill-frontmatter.test.ts) — CI validation that skill/agent files declare a `model` field

## Architecture Documentation

Ralph's model selection is a three-layer prose contract enforced by the Claude Code runtime, with no participation from `mcp-server/src/`:

1. **Static frontmatter pins** (skills + agents) — the floor when no explicit model is passed at dispatch.
2. **Hero dispatch-time `model=` params** — `${RALPH_IMPL_MODEL:-sonnet}` resolution; explicit param outranks the target's frontmatter.
3. **Verdict-token escalation** — `IMPL BLOCKED needs=<tier>` triggers exactly one up-tier re-dispatch; double-BLOCKED escalates to Human Needed.

The design philosophy from GH-1250 is "never preemptively downgrade; escalate on BLOCKED instead" — it assumes every user has access to the tier each role pins. Entitlement-aware degradation was simply not a design dimension before Fable introduced tier-gated access.

## Historical Context (from thoughts/)

- `thoughts/shared/research/2026-06-09-GH-1487-hero-model-pinning-per-phase.md` — verified `fable` is a documented frontmatter alias (Claude Code v2.1.170+); noted the platform's content-based Fable→Opus fallback but no entitlement fallback in ralph; flagged `RALPH_SPLIT_MODEL` as dead.
- `thoughts/shared/plans/2026-06-09-GH-1487-fable-model-ladder-retiering.md` — APPROVED 4-phase plan (5 fable pins, escalation retarget, resurrect `docs/model-tier-policy.md`, doc updates). Assumes universal Fable availability.
- `thoughts/shared/plans/2026-05-13-GH-1250-model-tier-optimization-hero.md` — origin of the escalation-only override design.
- `thoughts/shared/research/2026-05-14-GH-1250-pr1251-elegant-fixes-from-ralph-hero.md` — env-var signaling identified as ralph's most elegant override pattern; precedent for any future `RALPH_*_MODEL`-style fallback knob.
- `thoughts/shared/research/2026-05-15-GH-1265-haiku-context-compaction-integrator-agents.md` — when a skill omits `model:`, the caller's model applies (inline `Skill()` dispatch) — fallback-via-inheritance is feasible but unused.

## Related Research

- [[2026-06-09-GH-1487-hero-model-pinning-per-phase]]
- [[2026-05-30-GH-1474-dynamic-workflows-vs-ralph-hero]] (Workflow `agent()` opts.model is a free string — a fourth, unvalidated model surface)

## Files Affected

### Will Modify
- None — research only. A graceful-degradation follow-up would touch: `ralph/skills/hero/SKILL.md`, `ralph/skills/research/SKILL.md`, `ralph/skills/plan/SKILL.md` (pins `fable` → `best`), `ralph/agents/plan-agent.md`, `ralph/agents/review-agent.md` (pending `best` verification on agent frontmatter), `docs/model-tier-policy.md`, `README.md`, `CLAUDE.md` (document the `ANTHROPIC_DEFAULT_FABLE_MODEL` escape hatch).

### Will Read (Dependencies)
- `thoughts/shared/plans/2026-06-09-GH-1487-fable-model-ladder-retiering.md` — shipped plan whose pins a follow-up would amend
- `ralph/skills/hero/dispatch.md` — escalation rung that must keep a concrete alias

## Open Questions

1. **Does agent frontmatter actually accept `best`?** Docs enumerate 4 aliases but also defer to `--model` values. One-shot empirical test: pin a throwaway agent to `model: best`, dispatch, observe (in both a Fable-entitled and non-entitled session if possible).
2. **What does a non-entitled user actually see** when dispatching `model: fable` on the Anthropic API — hard error, silent downgrade, or fallback-chain trigger? Docs are silent; needs a no-Fable account to test.
3. **Does `best` work in `fallbackModel` chains and `CLAUDE_CODE_SUBAGENT_MODEL`?** Both surfaces say "alias" without enumerating.
4. **Pre-v2.1.170 behavior of `best`** — resolve-to-Opus or unrecognized-alias error? Matters for plugin distribution to users on older CLIs. GH-1487's plan treated ≥ 2.1.170 as a host requirement but nothing enforces or documents it for plugin installers.
5. Now that GH-1487 has shipped hard `fable` pins in ralph-v0.1.37: should a follow-up flip the three skill pins to `best` and document `ANTHROPIC_DEFAULT_FABLE_MODEL` + `fallbackModel` in `docs/model-tier-policy.md` / `README.md` as the no-Fable path?
