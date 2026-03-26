---
date: 2026-03-25
topic: "Why thoughts-locator can use MCP tools but ralph-builder/ralph-analyst cannot — hook gating disparity"
tags: [research, codebase, mcp, sub-agents, hooks, skill-precondition, agent-architecture]
status: complete
type: research
git_commit: 227ad55
---

# Research: Sub-Agent MCP Tool Access Disparity

## Prior Work

- builds_on:: [[2026-03-24-agent-env-propagation-token-scope]]
- builds_on:: [[2026-03-24-GH-0674-agent-per-phase-architecture]]
- builds_on:: [[2026-03-25-token-management-setup-skill-improvement]]

## Research Question

The thoughts-locator agent can successfully use MCP tools (`knowledge_search`, `knowledge_traverse`), but ralph-builder and ralph-analyst agents cannot use ralph-hero MCP tools (`ralph_hero__get_issue`, `ralph_hero__list_issues`, etc.). What are the differences between these agents that explain the disparity?

## Summary

The disparity is caused by `skill-precondition.sh` — a PreToolUse hook registered in `hooks.json` that gates `ralph_hero__get_issue` and `ralph_hero__list_issues`. It blocks when `RALPH_COMMAND` is empty. No equivalent gatekeeper exists for `knowledge_search`/`knowledge_traverse`. Since `RALPH_COMMAND` can only be set by a skill's SessionStart hook (via `set-skill-env.sh`), and sub-agents don't have skill SessionStart context, the precondition always fails for sub-agents calling ralph-hero MCP tools.

This is compounded by two other platform limitations: plugin sub-agent `hooks:` frontmatter is silently ignored, and sub-agents cannot spawn sub-agents (breaking the `Skill()` delegation pattern).

## Detailed Findings

### Agent Comparison Matrix

| Property | thoughts-locator | ralph-builder | ralph-analyst |
|----------|:---:|:---:|:---:|
| **Model** | haiku | sonnet | sonnet |
| **MCP tools in `tools:` field** | `knowledge_search`, `knowledge_traverse` | `ralph_hero__get_issue`, `list_issues`, `save_issue`, `create_comment`, `list_sub_issues` | All ralph-hero tools + `knowledge_search` |
| **PreToolUse hook in hooks.json** | None for knowledge tools | `skill-precondition.sh` matches `get_issue`, `list_issues` | Same |
| **`RALPH_COMMAND` required?** | No | Yes (precondition check) | Yes |
| **`hooks:` in frontmatter** | None | `Stop: worker-stop-gate.sh` | `Stop: worker-stop-gate.sh` |
| **`Skill` in tools?** | No | Yes | Yes |
| **`Agent` in tools?** | No | Yes | Yes |
| **Direct tool execution?** | Yes | No — delegates via Skill() | No — delegates via Skill() |

### Cause 1: Hook Gating Disparity

`hooks.json` registers `skill-precondition.sh` as a PreToolUse hook for two matchers:
- `ralph_hero__get_issue` (hooks.json:49-59)
- `ralph_hero__list_issues` (hooks.json:63-69)

No PreToolUse hook exists for `mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_search` or `knowledge_traverse`.

`skill-precondition.sh` (lines 25-31) checks:
```bash
command="${RALPH_COMMAND:-}"
if [[ -z "$command" ]]; then
  block "Skill precondition failed: RALPH_COMMAND not set..."
fi
```

`RALPH_COMMAND` is set by `set-skill-env.sh` during a skill's SessionStart hook. Sub-agents don't have skill SessionStart context — they're raw agents, not skills. The environment variable is never set, so the precondition always blocks.

**thoughts-locator bypasses this entirely** because its MCP tools have no corresponding precondition hook.

### Cause 2: Plugin Agent `hooks:` Silently Ignored

Both ralph-builder and ralph-analyst declare `hooks: Stop:` in their frontmatter:
```yaml
hooks:
  Stop:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/worker-stop-gate.sh"
```

Per Claude Code documentation: "For security reasons, plugin subagents do not support the `hooks`, `mcpServers`, or `permissionMode` frontmatter fields. These fields are ignored when loading agents from a plugin."

These Stop hooks never fire. The agents believe they have lifecycle control but don't.

thoughts-locator has no `hooks:` field — correct behavior since it wouldn't work anyway.

### Cause 3: Nested Sub-Agent Delegation Pattern

ralph-builder and ralph-analyst include `Skill` and `Agent` in their `tools:` field because they're designed as wrapper agents:
- ralph-builder calls `Skill("ralph-impl")` or `Skill("ralph-review")`
- ralph-analyst calls `Skill("ralph-research")`, `Skill("ralph-plan")`, `Skill("ralph-triage")`, `Skill("ralph-split")`

But "subagents cannot spawn other subagents" (Claude Code platform constraint). When these agents call `Skill()`:
- `context: fork` silently runs inline (no separate process)
- The skill's `model:` override is lost (agent's model is used instead)
- The skill's SessionStart hook may not fire properly in this degraded context

thoughts-locator never delegates — it calls MCP tools directly and does all work itself.

### Cause 4: No `agent_type` Awareness in Hooks

The GH-674 plan proposed adding `get_agent_type()` to `hook-utils.sh` and modifying `skill-precondition.sh` to allow calls when `agent_type` is present (indicating a per-phase agent context). This has not been implemented:
- `hook-utils.sh` has no `get_agent_type()` function
- `skill-precondition.sh` has no agent_type fallback
- `agent-phase-gate.sh` does not exist
- No per-phase agents (research-agent, plan-agent, impl-agent, etc.) have been created

The entire GH-674 agent-per-phase architecture remains in draft plan status.

## Why thoughts-locator Is the Exception, Not the Rule

thoughts-locator works because it accidentally avoids all three failure modes:
1. Its MCP tools (`knowledge_*`) have no precondition hook gating them
2. It has no `hooks:` in frontmatter (nothing to be silently ignored)
3. It doesn't delegate via `Skill()`/`Agent()` — it does everything directly

This pattern — **direct tool execution without delegation** — is the key architectural insight behind the GH-674 agent-per-phase proposal, which replaces wrapper agents (analyst/builder/integrator → Skill()) with per-phase agents that preload skill content via the `skills:` field and call MCP tools directly.

## What Would Fix This

### Quick Fix (Unblock without Full Architecture Change)

Modify `skill-precondition.sh` to allow calls when running inside a sub-agent (check for `agent_type` in hook input JSON):

```bash
command="${RALPH_COMMAND:-}"
if [[ -z "$command" ]]; then
  # Check if running inside a sub-agent (agent_type present in hook input)
  agent_type=$(echo "$RALPH_HOOK_INPUT" | jq -r '.agent_type // empty')
  if [[ -n "$agent_type" ]]; then
    allow
    exit 0
  fi
  block "Skill precondition failed: RALPH_COMMAND not set..."
fi
```

This would unblock ralph-builder/ralph-analyst MCP tool calls without the full GH-674 architecture change. The nested sub-agent and model override issues would remain.

### Full Fix (GH-674 Agent-Per-Phase Architecture)

Replace wrapper agents with per-phase agents that:
- Preload skill content via `skills:` field (no `Skill()` calls needed)
- Use backtick preprocessing for env var resolution
- Rely on plugin-level hooks with `agent_type` discrimination
- Call MCP tools directly (no delegation)

## Code References

- `plugin/ralph-hero/agents/thoughts-locator.md:4` — tools field with knowledge MCP tools (no precondition hook)
- `plugin/ralph-hero/agents/ralph-builder.md:4` — tools field with ralph-hero MCP tools (gated by precondition)
- `plugin/ralph-hero/agents/ralph-analyst.md:4` — tools field with ralph-hero MCP tools (gated by precondition)
- `plugin/ralph-hero/hooks/hooks.json:49-69` — skill-precondition.sh registered for get_issue and list_issues
- `plugin/ralph-hero/hooks/scripts/skill-precondition.sh:25-31` — RALPH_COMMAND check that blocks sub-agents
- `plugin/ralph-hero/hooks/scripts/hook-utils.sh` — no get_agent_type() helper (GH-674 not implemented)
- `plugin/ralph-hero/hooks/scripts/set-skill-env.sh` — sets RALPH_COMMAND via CLAUDE_ENV_FILE (skill context only)

## Related Research

- [[2026-03-24-agent-env-propagation-token-scope]] — full root cause analysis of the three compounding failures
- [[2026-03-24-GH-0674-agent-per-phase-architecture]] — proposed architectural fix (draft, not implemented)
- [[2026-03-25-token-management-setup-skill-improvement]] — broader token management pain points
- [[2026-03-19-GH-0637-hero-dispatch-model]] — Skill() vs Agent() dispatch isolation research

## Claude Code Platform Status (March 2026)

Web research on the latest Claude Code releases and issue tracker reveals:

### Sub-agent MCP Tool Access — Still Broken for Plugin Agents

- Issue [#13605](https://github.com/anthropics/claude-code/issues/13605) ("Custom plugin subagents cannot access MCP tools") was closed as COMPLETED, suggesting a fix shipped.
- However, issue [#21560](https://github.com/anthropics/claude-code/issues/21560) ("Plugin-defined subagents cannot access MCP tools — breaks plugin ecosystem") remains OPEN with no Anthropic staff response. Multiple duplicates (#22535, #23882, #25200, #27968) confirm the bug persists.
- Issue [#19526](https://github.com/anthropics/claude-code/issues/19526) — primary tracking issue for general sub-agent MCP access — was closed as **"NOT PLANNED"** on Feb 28, 2026.

**Key distinction**: The docs say "By default, subagents inherit all tools from the main conversation, including MCP tools" — but this describes design intent, not observed behavior for plugin-defined agents.

### Plugin Agent Frontmatter Constraints — Unchanged

Per v2.1.78 (March 17, 2026), plugin agents gained `effort`, `maxTurns`, and `disallowedTools` support. But `hooks`, `mcpServers`, and `permissionMode` remain explicitly blocked.

The docs note a workaround: copy agent files from the plugin into `.claude/agents/` (project scope) or `~/.claude/agents/` (user scope) to gain full frontmatter support including hooks and mcpServers.

### Sub-agent `mcpServers:` Field — New But Blocked for Plugins

Sub-agents can now declare `mcpServers:` in frontmatter to explicitly connect to MCP servers:
```yaml
---
name: browser-tester
mcpServers:
  - playwright:
      type: stdio
      command: npx
      args: ["-y", "@playwright/mcp@latest"]
  - github    # reference by name
---
```
This would be the "proper" fix — but it's blocked for plugin agents. Only works for `.claude/agents/` or `~/.claude/agents/` agent files.

### Nested Sub-agents — Still Hard-Blocked

v2.1.72 (March 10, 2026) actively prevents nested sub-agent spawning: "Fixed teammates accidentally spawning nested teammates via the Agent tool's name parameter." This is now an enforced constraint, not just a silent failure.

### `skills:` Preloading — Stable

The `skills:` field works in plugin agents and is the recommended pattern for injecting instructions. Recent improvements:
- v2.1.84: Skills paths frontmatter accepts YAML list of globs
- v2.1.81: `--bare` flag skips skill directory walks
- v2.1.80: `effort` frontmatter added for skills

### Env Var Propagation — No Sub-agent-Specific Improvements

v2.1.83 (March 25, 2026) added `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` — strips credentials from subprocess environments (Bash, hooks, MCP). This is security hardening, not an expansion of sub-agent env inheritance.

Sub-agents still have no mechanism to declare or receive custom env vars in their frontmatter.

## Implications for ralph-hero

The web research confirms two things:

1. **The `skill-precondition.sh` hook gating is the primary blocker** — it's our own hook, not a platform limitation, that prevents ralph-builder/ralph-analyst from calling `ralph_hero__get_issue` and `ralph_hero__list_issues`. The quick fix (agent_type check) would resolve this immediately.

2. **The platform limitation is real but secondary** — even with the hook fix, plugin sub-agents may still have degraded MCP access per issue #21560. The `mcpServers:` workaround exists but is blocked for plugin agents. The agent-per-phase architecture (GH-674) with `skills:` preloading remains the right long-term approach, since it avoids the nested sub-agent problem entirely.

3. **Copying agents to `.claude/agents/`** is a documented workaround for gaining full frontmatter support, but breaks plugin portability.

## Open Questions

1. Should the quick fix (agent_type check in skill-precondition.sh) be shipped independently of GH-674?
2. Are there other hooks in hooks.json that would also block sub-agent MCP calls? (pre-github-validator.sh, lock-claim-validator.sh, etc. match on `ralph_hero__save_issue` — these would also fire for sub-agents)
3. Does `agent_type` actually appear in `RALPH_HOOK_INPUT` when hooks.json hooks fire inside plugin sub-agents? This was documented but not empirically verified.
4. Would adding the knowledge tools' precondition hooks break thoughts-locator in the same way? (Yes — this confirms the pattern is inherently fragile)
5. Is issue #21560 (plugin sub-agents can't access MCP tools) a separate problem from the hook gating issue, or are they the same root cause manifesting differently?
6. Should ralph-hero's critical agents be moved to `.claude/agents/` templates that the setup skill copies into consumer repos?
