---
date: 2026-02-18
github_issue: 60
github_url: https://github.com/cdubiel08/ralph-hero/issues/60
status: complete
type: research
---

# Research: Research Skill No Longer Uses Codebase-Analyzer Agents

## Problem Statement

The ralph-research skill instructs the agent to spawn specialized sub-agents (`codebase-locator`, `codebase-analyzer`, `codebase-pattern-finder`, `thoughts-locator`, `web-search-researcher`) for parallel codebase investigation, but in practice these agents are not used. The research step falls back to direct searching by the skill agent itself, resulting in potentially shallower research findings.

## Current State Analysis

### What the SKILL.md Says

The ralph-research skill definition at [`skills/ralph-research/SKILL.md:73-81`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-research/SKILL.md#L73-L81) instructs Step 3 to:

```markdown
3. **Spawn parallel sub-tasks** using the Task tool with specialized agents:
   - **codebase-locator**: Find all files related to the issue
   - **codebase-analyzer**: Understand current implementation
   - **codebase-pattern-finder**: Find similar patterns to model after
   - **thoughts-locator**: Find existing research or decisions
   - **web-search-researcher**: External APIs, best practices (if needed)
4. **Wait for ALL sub-tasks** before proceeding
```

### Where the Agents Actually Live

The 5 specialized agents are defined at the **workspace level**:

| Agent | Location | Available to plugin? |
|-------|----------|---------------------|
| `codebase-locator` | `~/projects/.claude/agents/codebase-locator.md` | No |
| `codebase-analyzer` | `~/projects/.claude/agents/codebase-analyzer.md` | No |
| `codebase-pattern-finder` | `~/projects/.claude/agents/codebase-pattern-finder.md` | No |
| `thoughts-locator` | `~/projects/.claude/agents/thoughts-locator.md` | No |
| `web-search-researcher` | `~/projects/.claude/agents/web-search-researcher.md` | No |

### What the Plugin Actually Ships

The plugin's `agents/` directory ([`plugin/ralph-hero/agents/`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/agents/)) contains only the 4 worker agents:

- `ralph-analyst.md` -- Composes triage, split, and research skills
- `ralph-builder.md` -- Composes plan and implement skills
- `ralph-validator.md` -- Plan review quality gate
- `ralph-integrator.md` -- PR merge and git operations

**No research-support agents are included in the plugin.**

### Agent Resolution Scope

When a skill invokes `Task(subagent_type="codebase-locator")`, Claude Code resolves the agent type by searching:

1. The plugin's `agents/` directory (via the plugin manifest)
2. The current repo's `.claude/agents/` directory
3. The workspace-level `.claude/agents/` (parent directories)

For the ralph-hero repo:
- Plugin agents: 4 worker agents (no match for `codebase-locator`)
- Repo `.claude/agents/`: **Does not exist**
- Workspace `~/projects/.claude/agents/`: Contains all 5 agents

The workspace agents MAY be found if Claude Code traverses parent directories. However, this depends on the working directory at invocation time and whether the plugin skill context inherits the workspace agent resolution path. The behavior is inconsistent.

### Why It Worked Before

These agents were originally designed for the `~/projects/` workspace where Ralph was a set of `.claude/commands/` files rather than a standalone plugin. In that context:

- The working directory was inside `~/projects/landcrawler-ai/` or similar
- `~/projects/.claude/agents/` was directly in the agent resolution path
- Skills ran inline (not via plugin system) so they inherited the workspace context

After Ralph was extracted into the `ralph-hero` plugin:
- The plugin runs in its own context
- The working directory may be `~/projects/ralph-hero/` which does NOT have `.claude/agents/`
- Workspace-level agents are no longer reliably accessible

### What Happens When Agent Resolution Fails

When `subagent_type` doesn't match any defined agent, `Task()` falls back to `general-purpose` mode. The sub-task still runs but without the specialized instructions that make these agents valuable (focused toolsets, "only describe what exists" constraints, structured output formats). The agent does its best with generic capabilities, which is why research still produces results -- just potentially shallower ones.

## Potential Approaches

### Approach A: Copy Agents into Plugin (Recommended)

Copy the 5 research-support agent definitions from `~/projects/.claude/agents/` into `plugin/ralph-hero/agents/`:

```
plugin/ralph-hero/agents/
├── ralph-analyst.md           # existing
├── ralph-builder.md           # existing
├── ralph-integrator.md        # existing
├── ralph-validator.md         # existing
├── codebase-analyzer.md       # NEW (copy from workspace)
├── codebase-locator.md        # NEW (copy from workspace)
├── codebase-pattern-finder.md # NEW (copy from workspace)
├── thoughts-locator.md        # NEW (copy from workspace)
└── web-search-researcher.md   # NEW (copy from workspace)
```

**Pros:**
- Self-contained plugin -- no dependency on external workspace configuration
- Agents available to all plugin consumers (not just this workspace)
- Consistent behavior regardless of where the plugin is installed
- No changes to SKILL.md needed -- agent names already match

**Cons:**
- Duplication of agent definitions (workspace copies remain separately)
- Future changes to workspace agents won't automatically propagate to plugin
- Increases plugin size (5 additional markdown files, ~25KB total)

### Approach B: Remove Agent References from SKILL.md

Simplify the SKILL.md to not reference specialized agents. Instead, have the skill do direct `Glob`, `Grep`, `Read` calls itself (which is what currently happens in practice).

**Pros:**
- No agent dependency -- skill is fully self-contained
- Simpler mental model -- one agent doing everything
- Already the de facto behavior

**Cons:**
- Loses the benefits of specialized agents (focused tools, constrained output)
- Loses parallelism (specialized agents run concurrently; direct calls are sequential)
- Regresses the design intent of thorough multi-perspective research
- Contradicts the workspace CLAUDE.md documentation which lists these agents as supporting agents

### Approach C: Add `.claude/agents/` to Ralph-Hero Repo

Create a `.claude/agents/` directory in the ralph-hero repository root with the 5 agent definitions.

**Pros:**
- Agents available when running from the ralph-hero repo context
- Git-tracked, version-controlled with the project

**Cons:**
- Only works when CWD is inside the ralph-hero repo
- Plugin consumers who install via npm/npx won't get these agents
- `.claude/` directory conventions are for Claude Code workspaces, not npm packages

### Approach D: Reference Agents by Full Path in SKILL.md

Instead of `subagent_type="codebase-locator"`, use the full agent definition inline or reference by absolute path.

**Pros:**
- Works regardless of agent resolution scope

**Cons:**
- Brittle (paths vary per installation)
- Not how the `Task` tool is designed to work
- Would break for plugin consumers

## Risks and Considerations

1. **Plugin cache staleness**: The plugin cache at `~/.claude/plugins/cache/ralph-hero/ralph-hero/2.1.0/agents/` contains OLD legacy agents (`ralph-advocate`, `ralph-implementer`, etc.) rather than the current 4 worker agents. This suggests the published npm package (v2.1.0) was built before the agent consolidation (#40). A new publish would fix this but is a separate concern.

2. **Agent scope in team mode**: When running via `/ralph-team`, the analyst worker invokes `Skill(skill="ralph-hero:ralph-research")`. The skill then tries to spawn sub-agents. In team mode, the agent resolution path may differ from direct invocation. Both paths need testing.

3. **`thoughts-locator` relevance**: The `thoughts-locator` agent searches for research documents in `thoughts/shared/`. This is highly relevant for ralph-hero (which has its own `thoughts/` directory). Including this agent in the plugin ensures prior research is discovered.

4. **Plugin size impact**: Adding 5 agent markdown files (~5KB each) has negligible impact on npm package size.

## Recommended Next Steps

1. Use **Approach A** -- copy the 5 research-support agents into `plugin/ralph-hero/agents/`
2. Adapt agent definitions slightly if needed (remove workspace-specific references)
3. Verify `Task(subagent_type="codebase-locator")` resolves correctly from plugin context
4. The SKILL.md does not need changes -- agent names already match
5. Consider also adding `thoughts-analyzer` if plan skills reference it
