---
date: 2026-02-18
status: draft
github_issue: 60
github_url: https://github.com/cdubiel08/ralph-hero/issues/60
---

# [Bug] Research Skill No Longer Uses Codebase-Analyzer Agents

## Overview

The ralph-research skill (and other skills) reference 5 specialized sub-agents (`codebase-locator`, `codebase-analyzer`, `codebase-pattern-finder`, `thoughts-locator`, `web-search-researcher`) that exist only at the workspace level (`~/projects/.claude/agents/`), not in the plugin's `agents/` directory. When `Task(subagent_type="codebase-locator")` cannot resolve the agent, it silently falls back to `general-purpose` mode, producing shallower research. The fix is to copy these agent definitions into the plugin so it is fully self-contained.

## Current State Analysis

- The plugin ships 4 worker agents: `ralph-analyst`, `ralph-builder`, `ralph-validator`, `ralph-integrator` in [`plugin/ralph-hero/agents/`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/agents/)
- The 5 research-support agents live at `~/projects/.claude/agents/` (workspace level), outside the plugin
- Agent resolution depends on working directory and plugin context -- workspace agents are not reliably accessible
- Multiple skills reference these agents:
  - [`ralph-research/SKILL.md:73-79`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-research/SKILL.md#L73-L79) -- all 5 agents
  - [`ralph-plan/SKILL.md:125-126`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-plan/SKILL.md#L125-L126) -- `codebase-pattern-finder`, `codebase-analyzer`
  - [`ralph-triage/SKILL.md:100`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-triage/SKILL.md#L100) -- `codebase-locator`
  - [`ralph-split/SKILL.md:49,156,158`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-split/SKILL.md#L49) -- `codebase-locator`, `codebase-analyzer`
  - [`ralph-review/SKILL.md:193-194`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-review/SKILL.md#L193-L194) -- `codebase-analyzer`

## Desired End State

All 5 research-support agent definitions are included in the plugin's `agents/` directory, making `Task(subagent_type="codebase-locator")` resolve correctly from any installation context. No SKILL.md changes needed -- agent names already match.

### Verification
- [ ] `plugin/ralph-hero/agents/codebase-locator.md` exists with correct frontmatter
- [ ] `plugin/ralph-hero/agents/codebase-analyzer.md` exists with correct frontmatter
- [ ] `plugin/ralph-hero/agents/codebase-pattern-finder.md` exists with correct frontmatter
- [ ] `plugin/ralph-hero/agents/thoughts-locator.md` exists with correct frontmatter
- [ ] `plugin/ralph-hero/agents/web-search-researcher.md` exists with correct frontmatter
- [ ] All 5 agents have valid `name`, `description`, `tools`, and `model` in frontmatter
- [ ] No workspace-specific paths or references remain in copied agents
- [ ] `Task(subagent_type="codebase-locator")` resolves to the plugin agent (not general-purpose)

## What We're NOT Doing

- Changing any SKILL.md files (agent names already match)
- Adding `thoughts-analyzer` (not referenced by any plugin skill)
- Modifying the workspace-level agents (they remain for non-plugin use)
- Changing agent behavior or instructions (copy as-is with minimal adaptation)
- Updating the plugin manifest (`plugin.json`) -- agents are auto-discovered from the `agents/` directory

## Implementation Approach

Copy 5 agent markdown files from the workspace (`~/projects/.claude/agents/`) into the plugin's `agents/` directory. Review each for workspace-specific references and adapt if needed. The `tools` field in frontmatter must only reference tools available in the plugin context.

---

## Phase 1: Copy and Adapt Agent Definitions

### Overview

Copy all 5 research-support agent definitions into the plugin and verify they are self-contained.

### Changes Required

#### 1. Copy `codebase-locator.md`
**Source**: `~/projects/.claude/agents/codebase-locator.md`
**Destination**: `plugin/ralph-hero/agents/codebase-locator.md`

**Frontmatter**:
```yaml
---
name: codebase-locator
description: Locates files, directories, and components relevant to a feature or task. A "Super Grep/Glob" tool for finding where code lives.
tools: Grep, Glob, Bash
model: sonnet
---
```

**Adaptations needed**:
- Replace `LS` tool with `Bash` in the tools list (LS may not be available in all plugin contexts; Bash with `ls` is universally available)
- No content changes needed -- the agent instructions are generic and portable

#### 2. Copy `codebase-analyzer.md`
**Source**: `~/projects/.claude/agents/codebase-analyzer.md`
**Destination**: `plugin/ralph-hero/agents/codebase-analyzer.md`

**Frontmatter**:
```yaml
---
name: codebase-analyzer
description: Analyzes codebase implementation details with precise file:line references. Use for understanding how specific components work.
tools: Read, Grep, Glob, Bash
model: sonnet
---
```

**Adaptations needed**:
- Replace `LS` with `Bash` in tools list
- No content changes needed

#### 3. Copy `codebase-pattern-finder.md`
**Source**: `~/projects/.claude/agents/codebase-pattern-finder.md`
**Destination**: `plugin/ralph-hero/agents/codebase-pattern-finder.md`

**Frontmatter**:
```yaml
---
name: codebase-pattern-finder
description: Finds similar implementations, usage examples, and existing patterns in the codebase. Returns concrete code examples with file:line references.
tools: Grep, Glob, Read, Bash
model: sonnet
---
```

**Adaptations needed**:
- Replace `LS` with `Bash` in tools list
- No content changes needed

#### 4. Copy `thoughts-locator.md`
**Source**: `~/projects/.claude/agents/thoughts-locator.md`
**Destination**: `plugin/ralph-hero/agents/thoughts-locator.md`

**Frontmatter**:
```yaml
---
name: thoughts-locator
description: Discovers relevant documents in thoughts/ directory -- research docs, plans, tickets, handoffs. Use when researching to find prior context.
tools: Grep, Glob, Bash
model: sonnet
---
```

**Adaptations needed**:
- Replace `LS` with `Bash` in tools list
- The `thoughts/` directory references are specific to the ralph-hero repo structure and are correct for this plugin's context
- No content changes needed

#### 5. Copy `web-search-researcher.md`
**Source**: `~/projects/.claude/agents/web-search-researcher.md`
**Destination**: `plugin/ralph-hero/agents/web-search-researcher.md`

**Frontmatter**:
```yaml
---
name: web-search-researcher
description: Expert web research specialist for finding accurate information from web sources. Use for external API docs, best practices, and modern techniques.
tools: WebSearch, WebFetch, Read, Grep, Glob, Bash
model: sonnet
---
```

**Adaptations needed**:
- Remove `TodoWrite` from tools list (not relevant for sub-agent research tasks)
- Replace `LS` with `Bash` in tools list
- Remove `color: yellow` from frontmatter (not needed for sub-agents)
- No content changes needed

### Success Criteria

#### Automated Verification
- [ ] `ls plugin/ralph-hero/agents/ | wc -l` returns 9 (4 existing workers + 5 new research agents)
- [ ] `grep -l "name: codebase-locator" plugin/ralph-hero/agents/codebase-locator.md` succeeds
- [ ] `grep -l "name: codebase-analyzer" plugin/ralph-hero/agents/codebase-analyzer.md` succeeds
- [ ] `grep -l "name: codebase-pattern-finder" plugin/ralph-hero/agents/codebase-pattern-finder.md` succeeds
- [ ] `grep -l "name: thoughts-locator" plugin/ralph-hero/agents/thoughts-locator.md` succeeds
- [ ] `grep -l "name: web-search-researcher" plugin/ralph-hero/agents/web-search-researcher.md` succeeds
- [ ] `grep "LS" plugin/ralph-hero/agents/codebase-*.md plugin/ralph-hero/agents/thoughts-locator.md plugin/ralph-hero/agents/web-search-researcher.md` returns 0 matches (LS replaced with Bash)
- [ ] `grep "TodoWrite" plugin/ralph-hero/agents/web-search-researcher.md` returns 0 matches

#### Manual Verification
- [ ] Each agent has valid YAML frontmatter with `name`, `description`, `tools`, `model`
- [ ] No workspace-specific paths (e.g., `~/projects/`) in any agent file
- [ ] Agent instructions are generic and portable across installations
- [ ] The 4 existing worker agents are unchanged

---

## Testing Strategy

1. **File presence check**: Verify all 9 agent files exist in `plugin/ralph-hero/agents/`
2. **Frontmatter validation**: Grep for required fields in each new agent
3. **No stale references**: Grep for `LS` and `TodoWrite` in new agents (should be zero matches)
4. **No workspace paths**: Grep for `~/projects` or absolute paths in new agents (should be zero matches)
5. **Functional test**: After implementation, run `/ralph-research` on a test issue and verify that sub-agents are spawned with specialized instructions (not general-purpose fallback)

## References

- [Issue #60](https://github.com/cdubiel08/ralph-hero/issues/60)
- [Research: GH-60](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-18-GH-0060-research-skill-missing-agents.md)
- [ralph-research SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-research/SKILL.md)
- Workspace agents source: `~/projects/.claude/agents/` (not in git -- copy needed)
