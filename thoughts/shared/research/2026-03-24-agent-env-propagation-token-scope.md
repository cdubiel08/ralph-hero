---
date: 2026-03-24
last_updated: 2026-03-24
last_updated_note: "Completed full architecture investigation — proposed agent-per-phase design with plugin-level hooks"
topic: "How do environment variables and MCP tokens propagate from parent Claude agent to spawned sub-agents and skills?"
tags: [research, codebase, env-vars, mcp, sub-agents, token-scope, plugin-system, multi-repo, architecture]
status: complete
type: research
git_commit: 50d5a95
github_issue: 674
github_url: https://github.com/cdubiel08/ralph-hero/issues/674
---

# Research: Agent Environment Variable Propagation & Token Scope

## Prior Work

- builds_on:: [[2026-03-17-GH-0588-remove-mcp-env-block]]
- builds_on:: [[2026-02-20-GH-0231-skill-subagent-team-context-pollution]]
- builds_on:: [[2026-03-19-GH-0637-hero-dispatch-model]]
- builds_on:: [[2026-03-19-GH-0634-doctor-settings-local-json-fallback]]

## Research Question

When using ralph-hero in the ralph-engine repo, sub-agents encounter token scope issues that don't happen at the parent-level Claude agent. Investigate how env vars propagate from parent → agent → skill, and identify where the chain breaks.

## Summary

The current wrapper-agent architecture (ralph-analyst → Skill("ralph-research")) is fundamentally broken due to Claude Code platform constraints. Three root causes compound:

1. **Sub-agents cannot spawn sub-agents** — skills with `context: fork` silently run inline, losing their `model:` override
2. **Skill prompts use unexpandable `$VAR` references** — LLMs hallucinate wrong repo values, causing "token scope" errors
3. **Plugin sub-agent hooks are silently ignored** — `RALPH_COMMAND` is never set, causing `skill-precondition.sh` to block MCP calls

The fix is a new **agent-per-phase** architecture where:
- **Agents** provide the container (tools, model) and live in the plugin
- **Skills** provide the instructions via the agent `skills:` preload field
- **Backtick preprocessing** (`` !`echo $RALPH_GH_OWNER` ``) resolves env vars before the LLM sees them
- **Plugin-level hooks** (`hooks.json`) fire for all contexts with `agent_type` discrimination

## Root Cause Analysis

### Cause 1: Nested Sub-Agent Prohibition

> "Subagents cannot spawn other subagents." — [Claude Code Docs](https://code.claude.com/docs/en/sub-agents)

The current architecture:
```
hero (inline) → Agent("ralph-analyst") → Skill("ralph-research")
                                              └── context: fork → CAN'T FORK
                                              └── model: opus → IGNORED (agent is sonnet)
```

When `context: fork` fails silently inside a sub-agent, the skill runs inline with the agent's model (sonnet), not the skill's declared model (opus). Implementation, planning, review, and splitting all lose their intended opus-level reasoning.

#### Contradiction Matrix: ralph-builder (most impactful)

| Parameter | ralph-builder | ralph-impl | ralph-review |
|-----------|:---:|:---:|:---:|
| **model** | sonnet | **opus** | **opus** |
| **context** | (agent) | fork → **inline** | fork → **inline** |

#### Contradiction Matrix: ralph-analyst

| Parameter | ralph-analyst | ralph-research | ralph-plan | ralph-triage | ralph-split |
|-----------|:---:|:---:|:---:|:---:|:---:|
| **model** | sonnet | sonnet | **opus** | sonnet | **opus** |
| **context** | (agent) | fork → **inline** | fork → **inline** | fork → **inline** | fork → **inline** |

### Cause 2: Unexpandable Env Var References in Skill Prompts

Skill prompts instruct the LLM to pass `$RALPH_GH_OWNER` and `$RALPH_GH_REPO` as MCP tool params:

```markdown
ralph_hero__get_issue(owner, repo, number)
   - owner: $RALPH_GH_OWNER
   - repo: $RALPH_GH_REPO
```

The LLM sees `$RALPH_GH_OWNER` as **literal text** — it cannot expand env vars. Sub-agents with narrower context windows are especially prone to guessing wrong (e.g., `repo: "ralph-hero"` because the plugin is named "ralph-hero").

The MCP server's `resolveConfig()` correctly defaults to the right repo when `owner`/`repo` params are omitted. The skill prompts' insistence on passing these params explicitly creates the failure mode.

### Cause 3: Plugin Sub-Agent Hooks Are Silently Ignored

> "For security reasons, plugin subagents do not support the `hooks`, `mcpServers`, or `permissionMode` frontmatter fields. These fields are ignored when loading agents from a plugin." — [Plugins Reference](https://code.claude.com/docs/en/plugins-reference)

The current agents (ralph-analyst, ralph-builder, ralph-integrator) are plugin sub-agents with `hooks: Stop:` in their frontmatter. These hooks never fire. When the agent calls `Skill("ralph-impl")`, the skill's SessionStart hook calls `set-skill-env.sh` to set `RALPH_COMMAND`. But `CLAUDE_ENV_FILE` is only available in SessionStart hooks, and it's undocumented whether it exists in sub-agent contexts. If it doesn't, `set-skill-env.sh` silently no-ops and `RALPH_COMMAND` is never set.

The plugin-level `skill-precondition.sh` (in `hooks.json`) blocks all `ralph_hero__get_issue`/`ralph_hero__list_issues` calls when `RALPH_COMMAND` is empty. The sub-agent LLM sees this block and may report it as a "token scope" error.

## Proposed Architecture: Agent-Per-Phase with Skill Preloading

### Design Principles

| Concern | Owned by | Mechanism |
|---------|----------|-----------|
| What tools are available | Agent `tools:` | Hard allowlist (sub-agent `tools` field) |
| What model to use | Agent `model:` | Set on agent frontmatter |
| What to do | Skill content via agent `skills:` | Full content injected at startup |
| Env var resolution | Skill backtick preprocessing | `` !`echo $RALPH_GH_OWNER` `` resolved before LLM sees it |
| Safety gates | Plugin-level `hooks.json` | Fire for all contexts; discriminate via `agent_type` |

### How `skills:` Preloading Works

From the [Claude Code docs](https://code.claude.com/docs/en/sub-agents#preload-skills-into-subagents):

| Approach | System prompt | Task | Also loads |
|----------|---------------|------|------------|
| Skill with `context: fork` | From agent type | SKILL.md content | CLAUDE.md |
| **Subagent with `skills` field** | **Subagent's markdown body** | **Claude's delegation message** | **Preloaded skills + CLAUDE.md** |

> "The full content of each skill is injected into the subagent's context, not just made available for invocation. Subagents don't inherit skills from the parent conversation; you must list them explicitly."

The skill content is reference material injected alongside the agent's system prompt. This is NOT the same as calling `Skill()` — no fork, no nested sub-agent, no separate context. The skill content is just text in the agent's context window.

### Backtick Preprocessing — Tested and Confirmed

Skills support `` !`<command>` `` preprocessing that runs shell commands before content reaches the LLM. We tested this on 2026-03-24:

| Test | Method | Result |
|------|--------|--------|
| Direct skill invocation (`/test-env-inject`) | Skill with `` !`echo $RALPH_GH_OWNER` `` | **Resolved** → `cdubiel08` |
| Preloaded via agent `skills:` field | Agent with `skills: [test-env-inject]` | **Resolved** → `cdubiel08` |

Backtick preprocessing works in both contexts. This is the solution for injecting resolved env var values into skill content that LLMs can read.

**Skill changes needed:**
1. Remove explicit `owner`/`repo` params from MCP tool call instructions — let server defaults handle it
2. Replace `$RALPH_GH_OWNER`/`$RALPH_GH_REPO` in URL templates with `` !`echo $RALPH_GH_OWNER` ``

### Plugin-Level Hooks with `agent_type` Discrimination

Plugin-level hooks in `hooks/hooks.json` fire for all sessions — including sub-agent contexts. When hooks fire inside a sub-agent, the hook input JSON includes `agent_type`:

> "When hooks fire inside a sub-agent, the hook input JSON includes two extra fields: `agent_id` (unique ID for the sub-agent instance) and `agent_type` (the agent type name, e.g., 'Explore')."

Phase-specific hooks currently in skill frontmatter (branch-gate, impl-plan-required, etc.) can be migrated to `hooks.json` with scripts that check `agent_type` to determine which gates to apply:

```bash
# Example: hooks.json PreToolUse hook that discriminates by agent_type
agent_type=$(echo "$RALPH_HOOK_INPUT" | jq -r '.agent_type // empty')

case "$agent_type" in
  research-agent) # apply research-specific gates ;;
  impl-agent)     # apply impl-specific gates ;;
  plan-agent)     # apply plan-specific gates ;;
  *)              # fall back to RALPH_COMMAND check ;;
esac
```

This approach:
- Keeps agents in the plugin (portable across repos)
- Doesn't require hooks on agent frontmatter (which plugin agents can't have)
- Maintains backward compatibility (skills invoked directly still use RALPH_COMMAND)
- Uses `agent_type` as the discriminator for phase-specific behavior

### The Complete Agent Matrix

| Agent | Model | Key Tools | Preloaded Skill | Replaces |
|-------|-------|-----------|-----------------|----------|
| research-agent | sonnet | Read,Write,Glob,Grep,Bash,Agent,WebSearch,WebFetch + MCP | ralph-hero:ralph-research | analyst + ralph-research |
| plan-agent | opus | Read,Write,Glob,Grep,Bash,Agent + MCP | ralph-hero:ralph-plan | analyst + ralph-plan |
| split-agent | opus | Read,Glob,Grep,Bash,Agent + MCP + create_issue | ralph-hero:ralph-split | analyst + ralph-split |
| triage-agent | sonnet | Read,Glob,Grep,Bash + MCP | ralph-hero:ralph-triage | analyst + ralph-triage |
| review-agent | opus | Read,Write,Glob,Grep,Bash,Agent + MCP | ralph-hero:ralph-review | builder + ralph-review |
| impl-agent | opus | Read,Write,Edit,Glob,Grep,Bash,Agent + MCP | ralph-hero:ralph-impl | builder + ralph-impl |
| pr-agent | haiku | Read,Glob,Grep,Bash + MCP | ralph-hero:ralph-pr | integrator + ralph-pr |
| merge-agent | haiku | Read,Glob,Grep,Bash + MCP | ralph-hero:ralph-merge | integrator + ralph-merge |
| val-agent | haiku | Read,Glob,Grep,Bash + MCP | ralph-hero:ralph-val | integrator + ralph-val |

### Example Agent Definition

```yaml
# plugin/ralph-hero/agents/research-agent.md
---
name: research-agent
description: Research issues — investigates codebase, creates findings doc, updates workflow state
tools: Read, Write, Glob, Grep, Bash, Agent, WebSearch, WebFetch,
       ralph_hero__get_issue, ralph_hero__list_issues, ralph_hero__save_issue,
       ralph_hero__create_comment, ralph_hero__add_dependency, ralph_hero__remove_dependency
model: sonnet
skills:
  - ralph-hero:ralph-research
---

You are a research agent. Follow the preloaded ralph-research instructions.
Execute the task described in your prompt.
```

Plugin agents support `name`, `description`, `model`, `tools`, `disallowedTools`, `skills`, `memory`, `background`, `isolation`, `effort`, and `maxTurns`. Only `hooks`, `mcpServers`, and `permissionMode` are excluded.

### Hero Dispatch Changes

Current:
```
Agent(subagent_type="ralph-hero:ralph-analyst", prompt="Run /ralph-hero:ralph-research NNN")
```

Proposed:
```
Agent(subagent_type="ralph-hero:research-agent", prompt="Research issue #42")
```

### Runtime Flow

```
1. User: /ralph-hero:hero 42

2. Hero (inline, main context) dispatches:
   Agent("ralph-hero:research-agent", prompt="Research issue #42")

3. Claude Code creates sub-agent:
   ├── System prompt: "You are a research agent. Follow the preloaded..."
   ├── Preloaded skill: ralph-research SKILL.md body (preprocessed)
   │     └── !`echo $RALPH_GH_OWNER` → "cdubiel08" (resolved)
   │     └── !`echo $RALPH_GH_REPO`  → "ralph-engine" (resolved)
   ├── Tools: hard allowlist from agent frontmatter
   ├── Model: sonnet (from agent frontmatter, honored)
   └── CLAUDE.md: loaded from project

4. Sub-agent calls: ralph_hero__get_issue(number=42)
   └── No owner/repo → MCP server uses settings.local.json defaults ✓
   └── Plugin hooks.json fires → skill-precondition.sh
         └── Checks agent_type="research-agent" → allows ✓

5. Sub-agent completes research, returns results to hero
```

### What Gets Removed

- `agents/ralph-analyst.md` — replaced by research/plan/split/triage agents
- `agents/ralph-builder.md` — replaced by review/impl agents
- `agents/ralph-integrator.md` — replaced by pr/merge/val agents
- `skills/team/SKILL.md` — deprecated (unused)

### What Gets Modified

- **Skills**: Replace `$RALPH_GH_OWNER`/`$RALPH_GH_REPO` with backtick preprocessing; remove explicit `owner`/`repo` from MCP tool call instructions
- **`hooks.json`**: Add `agent_type`-aware discrimination to phase-specific hooks; modify `skill-precondition.sh` to allow agent-type-based invocations
- **`hero/SKILL.md`**: Update dispatch to use new per-phase agents

### What Stays Unchanged

- **MCP server**: No changes needed — `resolveConfig()` defaults already work correctly
- **Skill content** (markdown body): Preserved as-is (just env var reference format changes)
- **Skill frontmatter**: Kept for direct interactive invocation (ignored when preloaded)
- **Plugin-level hooks** in `hooks.json`: Continue to fire for all contexts

## Claude Code Platform Constraints (Documented)

### Skill Frontmatter

| Field | Type | Behavior |
|-------|------|----------|
| `allowed-tools` | list | **Permission grant** — auto-approves tools without prompting. NOT a hard restriction. |
| `model` | string | Model when skill is active (works for direct invocation, ignored when preloaded) |
| `context` | `fork` | Spawns a sub-agent. Cannot work inside a sub-agent (no nesting). |
| `agent` | string | Which sub-agent type for `context: fork`. Built-in or custom from `.claude/agents/`. |
| `hooks` | object | Hooks scoped to skill lifecycle. |

### Sub-Agent Frontmatter

| Field | Type | Behavior |
|-------|------|----------|
| `tools` | list | **Hard allowlist** — sub-agent can ONLY use these tools |
| `model` | string | `sonnet`, `opus`, `haiku`, full model ID, or `inherit` (default) |
| `skills` | list | Preload full skill content into context at startup |
| `hooks` | object | Lifecycle hooks — **ignored for plugin sub-agents** |
| `mcpServers` | list | Scoped MCP servers — **ignored for plugin sub-agents** |
| `permissionMode` | string | Permission mode — **ignored for plugin sub-agents** |

### Plugin Agent Supported Fields

From [plugins-reference](https://code.claude.com/docs/en/plugins-reference):

> Plugin agents support `name`, `description`, `model`, `effort`, `maxTurns`, `tools`, `disallowedTools`, `skills`, `memory`, `background`, and `isolation` frontmatter fields. For security reasons, `hooks`, `mcpServers`, and `permissionMode` are not supported for plugin-shipped agents.

### `CLAUDE_ENV_FILE`

- Available **only** in SessionStart hooks
- Other hook types do not have access
- Undocumented whether it exists in sub-agent SessionStart contexts

### `hookSpecificOutput.additionalContext`

SessionStart hooks can return JSON that injects text into Claude's context:
```python
output = {"hookSpecificOutput": {"additionalContext": "Owner: cdubiel08\nRepo: ralph-engine"}}
```
Pattern from [disler/claude-code-hooks-mastery](https://github.com/disler/claude-code-hooks-mastery). Alternative to backtick preprocessing for env var injection.

## Code References

- `plugin/ralph-hero/mcp-server/src/index.ts:32-37` — `resolveEnv()` filters unexpanded `${VAR}` literals
- `plugin/ralph-hero/mcp-server/src/index.ts:39-124` — `initGitHubClient()` reads RALPH_* tokens from env (once)
- `plugin/ralph-hero/mcp-server/src/github-client.ts:84-201` — GitHubClient config frozen at construction
- `plugin/ralph-hero/mcp-server/src/lib/helpers.ts:550-555` — `resolveConfig()`: `args.owner || client.config.owner`
- `plugin/ralph-hero/mcp-server/src/lib/helpers.ts:491-544` — `resolveRepoFromProject()` inference
- `plugin/ralph-hero/.mcp.json` — No `env` block (inherits process.env)
- `plugin/ralph-hero/hooks/hooks.json` — Plugin-level hooks (fire for all contexts)
- `plugin/ralph-hero/hooks/scripts/skill-precondition.sh:25-31` — Blocks when RALPH_COMMAND empty
- `plugin/ralph-hero/hooks/scripts/set-skill-env.sh:13-16` — Guards on CLAUDE_ENV_FILE
- `plugin/ralph-hero/agents/ralph-analyst.md` — Wrapper agent (to be replaced)
- `plugin/ralph-hero/agents/ralph-builder.md` — Wrapper agent (to be replaced)
- `plugin/ralph-hero/skills/ralph-research/SKILL.md:66-78` — `$RALPH_GH_OWNER` literal references
- `.claude/skills/test-env-inject/SKILL.md` — Test fixture for backtick preprocessing
- `.claude/agents/test-preload.md` — Test fixture for skill preloading

## Related Research

- [[2026-03-17-GH-0588-remove-mcp-env-block]] — Plan to remove .mcp.json env block
- [[2026-02-20-GH-0231-skill-subagent-team-context-pollution]] — Team context leaking through forks
- [[2026-03-19-GH-0637-hero-dispatch-model]] — Skill() vs Agent() dispatch isolation
- [[2026-03-19-GH-0634-doctor-settings-local-json-fallback]] — Doctor can't read settings.local.json

## External References

- [Claude Code Sub-agents Docs](https://code.claude.com/docs/en/sub-agents)
- [Claude Code Skills Docs](https://code.claude.com/docs/en/skills)
- [Claude Code Plugins Reference](https://code.claude.com/docs/en/plugins-reference)
- [Claude Code Hooks Docs](https://code.claude.com/docs/en/hooks)
- [Claude Code Environment Variables](https://code.claude.com/docs/en/env-vars)
- [disler/claude-code-hooks-mastery](https://github.com/disler/claude-code-hooks-mastery) — Hook patterns including additionalContext and CLAUDE_ENV_FILE
- [Issue #13254 — Background subagents cannot access MCP tools](https://github.com/anthropics/claude-code/issues/13254)
- [Issue #17283 — context:fork ignored on Skill() invocation](https://github.com/anthropics/claude-code/issues/17283)
- [Issue #32732 — No modelEnforcement:strict](https://github.com/anthropics/claude-code/issues/32732)
- [Issue #18837 — allowed-tools not enforced as restriction](https://github.com/anthropics/claude-code/issues/18837)
- [Issue #1254 — env block strips process.env](https://github.com/anthropics/claude-code/issues/1254)
- [Issue #2065 — ${VAR} expansion for MCP env](https://github.com/anthropics/claude-code/issues/2065)
- [Issue #24054 — Scoped MCP servers for sub-agents](https://github.com/anthropics/claude-code/issues/24054)
