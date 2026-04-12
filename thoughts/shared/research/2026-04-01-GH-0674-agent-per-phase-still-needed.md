---
date: 2026-04-01
github_issue: 674
github_url: https://github.com/cdubiel08/ralph-hero/issues/674
topic: "Is the agent-per-phase architecture (GH-674) still needed?"
tags: [research, codebase, agents, skills, hooks, architecture, platform-constraints]
status: complete
type: research
git_commit: 82c6a48
---

# Research: Is the Agent-Per-Phase Architecture (GH-674) Still Needed?

## Prior Work

- builds_on:: [[2026-03-24-agent-env-propagation-token-scope]]
- builds_on:: [[2026-03-24-GH-0674-agent-per-phase-architecture]]

## Research Question

Re-examine whether the three root causes identified in GH-674 (March 24, 2026) still exist in the current codebase and whether Claude Code platform changes have resolved any of them.

## Summary

**Yes, GH-674 is still needed.** All three root causes remain active. No Claude Code platform changes have resolved them. However, partial implementation progress exists — Phase 1 (hook infrastructure) is ~50% complete with `get_agent_type()` and the `skill-precondition.sh` fallback already landed on main.

| Root Cause | Status | Platform Fix? |
|------------|--------|---------------|
| Sub-agents cannot spawn sub-agents | **Still broken** | No — documented as intentional policy |
| `$VAR` references unexpandable by LLMs | **Still broken** | No — only `${CLAUDE_SKILL_DIR}` added |
| Plugin sub-agent hooks silently ignored | **Still broken** | No — now explicitly documented as security policy |

## Detailed Findings

### Root Cause 1: Nested Sub-Agent Prohibition — Still Active

The wrapper-agent dispatch chain remains unchanged:

```
hero → Agent("ralph-analyst") → Skill("ralph-research")
                                     └── context: fork → SILENTLY FAILS
                                     └── model: opus → IGNORED (runs on sonnet)
```

**Codebase state:**
- All three wrapper agents still exist: `ralph-analyst.md`, `ralph-builder.md`, `ralph-integrator.md`
- No per-phase agents (research-agent, plan-agent, impl-agent, etc.) have been created
- 18 skills declare `context: fork` in frontmatter — all silently fail when called from a sub-agent
- Hero dispatch at `hero/SKILL.md:246-358` still routes through wrapper agents exclusively

**Platform state:**
- Official docs still state: "Subagents cannot spawn other subagents"
- [Issue #16803](https://github.com/anthropics/claude-code/issues/16803) (`context: fork` fails inconsistently) remains OPEN
- A January 2026 comment confirms: works for project-level skills, still broken for plugin-scoped skills
- No changelog entries indicate any change to this restriction

### Root Cause 2: Unexpandable Env Var References — Still Active

Skills still instruct LLMs to pass literal `$RALPH_GH_OWNER` / `$RALPH_GH_REPO` as MCP tool parameters.

**Codebase state:**
- **85 occurrences** of `$RALPH_GH_OWNER` across 17 skill files
- **82 occurrences** of `$RALPH_GH_REPO` across the same files
- **Zero** skills use backtick preprocessing (`` !`echo $RALPH_GH_OWNER` ``)
- **Zero** skills have a `## Configuration` block with resolved values
- Highest concentration: `ralph-review` (12 each), `ralph-impl` (9 each), `ralph-plan` (8 each)

**Platform state:**
- Only new substitution variable since March: `${CLAUDE_SKILL_DIR}` (v2.1.69)
- General `$VAR` expansion still not supported in skill markdown
- `` !`command` `` backtick preprocessing remains the only sanctioned escape hatch
- The MCP server's `resolveConfig()` correctly defaults when params are omitted — the skill prompts' insistence on explicit params creates the failure

### Root Cause 3: Plugin Sub-Agent Hooks Ignored — Still Active

Plugin agents cannot have `hooks` frontmatter. The `RALPH_COMMAND` env var (needed by `skill-precondition.sh`) is never set in sub-agent contexts.

**Codebase state — partial progress:**
- `hook-utils.sh:35-37` — `get_agent_type()` function **exists** (Phase 1 deliverable)
- `skill-precondition.sh:25-31` — agent_type fallback **exists** (Phase 1 deliverable): when `RALPH_COMMAND` is empty but `agent_type` is present in hook input, it allows
- `agent-phase-gate.sh` — **does not exist** (Phase 1 deliverable, not yet created)
- `hooks.json` — **no** agent_type-aware hooks registered (Phase 1 deliverable, not yet done)
- `set-skill-env.sh:13-16` — still guards on `CLAUDE_ENV_FILE`, silently no-ops when unavailable

**Platform state:**
- Official docs now explicitly document the restriction: "For security reasons, plugin subagents do not support the `hooks`, `mcpServers`, or `permissionMode` frontmatter fields"
- [Issue #17688](https://github.com/anthropics/claude-code/issues/17688) (skill-scoped hooks not triggered in plugins) remains OPEN
- This is now documented policy, not a bug — unlikely to change

## Implementation Progress Assessment

### Phase 1: Hook Infrastructure — ~50% Complete

| Deliverable | Status |
|-------------|--------|
| `get_agent_type()` in hook-utils.sh | Done |
| `skill-precondition.sh` agent_type fallback | Done |
| `agent-phase-gate.sh` dispatch script | Not started |
| hooks.json agent_type-aware entries | Not started |

### Phases 2–7: Not Started

No backtick preprocessing in skills, no per-phase agents, no hero dispatch changes, no wrapper agent removal, no docs updates, no integration testing.

## Dispatch Inconsistency Noted

The skill-vs-agent-dispatch fragment (`shared/fragments/skill-vs-agent-dispatch.md:9-11`) assigns `ralph-merge` to `ralph-builder`, but `ralph-integrator.md` also lists `ralph-merge` as one of its skills. The hero SKILL.md does not dispatch `ralph-integrator` at all — it only appears in team mode via `TeamCreate`.

## Architecture Documentation

### Current Agent Inventory (11 files in `plugin/ralph-hero/agents/`)

| Agent | Purpose | Model |
|-------|---------|-------|
| ralph-analyst | Routes to triage/split/research/plan skills | sonnet |
| ralph-builder | Routes to review/impl skills | sonnet |
| ralph-integrator | Routes to val/pr/merge skills | haiku |
| codebase-analyzer | Analyze code with file:line refs | (research helper) |
| codebase-locator | Find files/components | (research helper) |
| codebase-pattern-finder | Find usage patterns | (research helper) |
| github-analyzer | Analyze GitHub findings | (research helper) |
| github-lister | Search GitHub repos/issues | (research helper) |
| thoughts-analyzer | Analyze research docs | (research helper) |
| thoughts-locator | Find docs in thoughts/ | (research helper) |
| web-search-researcher | Web research | (research helper) |

### Active Hero Dispatch Targets

| Line | Phase | Dispatch |
|------|-------|----------|
| 246 | SPLIT | `Agent("ralph-hero:ralph-analyst", "Run /ralph-hero:ralph-split NNN")` |
| 309 | RESEARCH | `Agent("ralph-hero:ralph-analyst", "Run /ralph-hero:ralph-research NNN")` |
| 318-332 | PLAN | `Agent("ralph-hero:ralph-analyst", ...)` — 4 variants |
| 340 | REVIEW | `Agent("ralph-hero:ralph-builder", "Run /ralph-hero:ralph-review NNN ...")` |
| 354-358 | IMPLEMENT | `Agent("ralph-hero:ralph-builder", "Run /ralph-hero:ralph-impl NNN ...")` |

## Code References

- `plugin/ralph-hero/agents/ralph-analyst.md` — Wrapper agent, still active
- `plugin/ralph-hero/agents/ralph-builder.md` — Wrapper agent, still active
- `plugin/ralph-hero/agents/ralph-integrator.md` — Wrapper agent, team-only
- `plugin/ralph-hero/skills/hero/SKILL.md:246-358` — Hero dispatch, all via wrapper agents
- `plugin/ralph-hero/hooks/scripts/hook-utils.sh:35-37` — `get_agent_type()` exists
- `plugin/ralph-hero/hooks/scripts/skill-precondition.sh:25-31` — agent_type fallback exists
- `plugin/ralph-hero/hooks/hooks.json` — No agent_type-aware entries
- `plugin/ralph-hero/hooks/scripts/set-skill-env.sh:13-16` — CLAUDE_ENV_FILE guard unchanged
- `plugin/ralph-hero/skills/shared/fragments/skill-vs-agent-dispatch.md:9-11` — Routing table (inconsistent on ralph-merge)

## Related Research

- [[2026-03-24-agent-env-propagation-token-scope]] — Original root cause investigation
- [[2026-03-24-GH-0674-agent-per-phase-architecture]] — Implementation plan (draft status)

## External References

- [Claude Code Sub-agents Docs](https://code.claude.com/docs/en/sub-agents) — No sub-agent nesting, plugin hooks restriction
- [Issue #16803](https://github.com/anthropics/claude-code/issues/16803) — `context: fork` fails for plugin skills (OPEN)
- [Issue #17688](https://github.com/anthropics/claude-code/issues/17688) — Plugin skill-scoped hooks not triggered (OPEN)
- [Claude Code CHANGELOG.md](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) — March/April 2026 entries

## Open Questions

1. **Should Phase 1 be completed before moving to Phase 2?** The plan says Phases 1 and 2 can run in parallel, but Phase 1 is half-done — finishing it first might simplify validation.
2. **Is the L estimate still accurate?** With Phase 1 partially complete, the remaining work might be closer to M.
3. **Should the plan be split into sub-issues now?** The dashboard flagged #674 as oversized (L in Ready for Plan).
