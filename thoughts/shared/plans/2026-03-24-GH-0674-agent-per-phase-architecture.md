---
date: 2026-03-24
last_updated: 2026-04-01
last_updated_note: "Updated line references to match current codebase; marked Phase 1 items 1-2 as complete"
status: draft
type: plan
tags: [architecture, agents, skills, hooks, env-vars, hero-dispatch]
github_issue: 674
github_issues: [674]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/674
primary_issue: 674
---

# Agent-Per-Phase Architecture Implementation Plan

## Prior Work

- builds_on:: [[2026-03-24-agent-env-propagation-token-scope]]
- builds_on:: [[2026-04-01-GH-0674-agent-per-phase-still-needed]]
- builds_on:: [[2026-03-19-GH-0637-hero-dispatch-model]]
- builds_on:: [[2026-02-20-GH-0231-skill-subagent-team-context-pollution]]

## Overview

Replace the broken wrapper-agent architecture (ralph-analyst/ralph-builder/ralph-integrator → Skill()) with per-phase agents that preload skill content via the `skills:` field. This fixes three compounding issues: silent model downgrades from nested sub-agent prohibition, unexpandable `$VAR` references causing "token scope" errors, and silently ignored plugin sub-agent hooks.

## Current State Analysis

### What's broken

The current dispatch chain:
```
hero → Agent("ralph-analyst") → Skill("ralph-research")
         ├── context:fork → BLOCKED (no nested sub-agents)
         ├── model:opus → IGNORED (agent is sonnet)
         └── SessionStart → CLAUDE_ENV_FILE may be empty → RALPH_COMMAND not set
```

Three wrapper agents (ralph-analyst, ralph-builder, ralph-integrator) each just check TaskList and call Skill(). This creates nested sub-agent issues:
- Skills with `context: fork` silently run inline, losing model overrides
- Plugin sub-agent hooks in frontmatter are silently ignored
- `$RALPH_GH_OWNER`/`$RALPH_GH_REPO` in skill prompts are literal text LLMs can't expand

### Key Discoveries

- Sub-agent `tools:` is a **hard allowlist** (enforced) vs skill `allowed-tools:` is a **permission grant** (not enforced as restriction)
- Sub-agent `skills:` field **preloads full skill content** into agent context with backtick preprocessing
- Backtick preprocessing (`` !`echo $RALPH_GH_OWNER` ``) **works in preloaded skills** (tested 2026-03-24)
- Plugin agents support `tools`, `model`, `skills`, `memory`, `background`, `isolation` — but NOT `hooks`, `mcpServers`, `permissionMode`
- Plugin-level hooks in `hooks.json` fire for all contexts including sub-agents
- Hook input JSON includes `agent_type` field when firing inside sub-agents

## Desired End State

Hero dispatches per-phase agents directly:
```
hero → Agent("ralph-hero:research-agent", prompt="Research issue #42")
         ├── tools: hard allowlist from agent frontmatter
         ├── model: sonnet (from agent, honored)
         ├── skills: [ralph-hero:ralph-research] (preloaded with resolved env vars)
         └── plugin hooks.json fires with agent_type="research-agent"
```

### Verification

- Hero dispatches to per-phase agents without wrapper agents
- Agents run with correct model (opus for impl/plan/plan-epic/review/split, sonnet for research/triage, haiku for pr/merge/val)
- Skill content is preloaded with resolved env var values (no `$VAR` literals)
- MCP tool calls work without explicit `owner`/`repo` params
- Plugin-level hooks discriminate by `agent_type`
- Skills remain independently invocable for interactive use
- All existing tests pass: `cd plugin/ralph-hero/mcp-server && npm test`

## What We're NOT Doing

- Changing the MCP server — `resolveConfig()` defaults already work correctly
- Removing skills — they're kept for interactive use and as the single source of truth for workflow instructions
- Adding hooks to agent frontmatter — plugin agents can't have them; we use hooks.json instead
- Changing the skill frontmatter (hooks, context, model) — it's ignored when preloaded but still works for direct invocation
- Rewriting hook scripts — we're adding `agent_type` awareness, not replacing existing logic
- Compacting skill prompt sizes — context window pressure from large preloaded skills is a real concern but is a separate effort

## Known Risks

### Risk 1: Artifact path passing via natural language prompts
Hero currently passes `--research-doc` and `--plan-doc` flags via structured Skill() prompts. In the new architecture, these become natural language in the Agent() prompt (e.g., "Research doc: thoughts/shared/research/..."). Whether the preloaded skill instructions reliably extract paths from natural language prompts vs CLI-style flags is untested. Mitigation: monitor during Phase 7 manual testing, consider structured prompt format if unreliable.

### Risk 2: Context window pressure from skill preloading
Some skills are large (ralph-impl ~570 lines, ralph-review ~440 lines). When preloaded via `skills:`, the full content is injected before the agent does any work. For haiku agents with smaller context windows, this could be a problem. Mitigation: monitor during Phase 7, consider a separate skill prompt compaction effort if needed.

### Risk 3: Double hook firing for direct skill invocations
When a user directly invokes a skill (e.g., `/ralph-hero:ralph-research`), both the skill's frontmatter hooks AND the new hooks.json `agent-phase-gate.sh` will fire. The gate script checks `agent_type` — if empty (not in a sub-agent), it allows and exits. This should be harmless but could cause confusing duplicate block messages if both the skill hook and the plugin hook match the same tool. Mitigation: `agent-phase-gate.sh` skips entirely when `RALPH_COMMAND` is set (indicating a skill is handling its own hooks).

## Implementation Approach

**Worktree isolation required** — this is a massive cross-cutting change touching agents, skills, hooks, hero dispatch, and specs. All work MUST be done in a dedicated worktree branch (e.g., `feat/agent-per-phase`) to avoid destabilizing main.

Seven phases. Phases 1 and 2 can run in parallel. Phases 3–7 are sequential.

---

## Phase 1: Hook Infrastructure — `agent_type` Awareness

- **depends_on**: null

### Overview

Add `agent_type` support to hook-utils.sh and skill-precondition.sh so plugin-level hooks can discriminate by agent type. Migrate phase-specific hooks from skill frontmatter to hooks.json with `agent_type` case dispatch.

### Changes Required

#### 1. ~~Add `get_agent_type()` to hook-utils.sh~~ DONE
**File**: `plugin/ralph-hero/hooks/scripts/hook-utils.sh`
**Status**: Already implemented at lines 35-37. Uses `get_field '.agent_type'` (delegating to the `get_field()` helper at lines 19-22). Located after `get_tool_input()` (line 30).

```bash
# Extract agent_type from hook input (present when firing inside a sub-agent)
get_agent_type() {
  get_field '.agent_type'
}
```

#### 2. ~~Modify skill-precondition.sh for agent_type fallback~~ DONE
**File**: `plugin/ralph-hero/hooks/scripts/skill-precondition.sh`
**Status**: Already implemented at lines 25-36. When `RALPH_COMMAND` is empty, it calls `get_agent_type()` (line 28) and allows if non-empty (line 30). Only falls through to `block()` (line 32) if both `RALPH_COMMAND` and `agent_type` are empty. GitHub owner/repo checks follow at lines 38-47, project number check at lines 49-56.

```bash
# Current implementation (lines 25-36):
command="${RALPH_COMMAND:-}"
if [[ -z "$command" ]]; then
  agent_type=$(get_agent_type)
  if [[ -n "$agent_type" ]]; then
    allow
    exit 0
  fi
  block "Skill precondition failed: RALPH_COMMAND not set
  ..."
fi
```

#### 3. Create agent-phase-gate.sh dispatch script
**File**: `plugin/ralph-hero/hooks/scripts/agent-phase-gate.sh`
**Changes**: New file — routes to phase-specific hooks based on `agent_type`

```bash
#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

read_input > /dev/null
agent_type=$(get_agent_type)

# Skip when RALPH_COMMAND is set (skill is handling its own hooks)
[[ -n "${RALPH_COMMAND:-}" ]] && { allow; exit 0; }

# Only apply phase gates when running inside a per-phase agent
[[ -z "$agent_type" ]] && { allow; exit 0; }

tool_name=$(get_tool_name)

case "$agent_type" in
  impl-agent)
    case "$tool_name" in
      Write|Edit)
        exec "$(dirname "$0")/impl-plan-required.sh"
        ;;
      Bash)
        exec "$(dirname "$0")/impl-branch-gate.sh"
        ;;
    esac
    ;;
  research-agent|plan-agent|plan-epic-agent|triage-agent|split-agent|review-agent)
    case "$tool_name" in
      Bash)
        exec "$(dirname "$0")/branch-gate.sh"
        ;;
    esac
    ;;
esac

allow
```

**Important**: The `exec` delegation relies on `RALPH_HOOK_INPUT` being exported by `read_input()`. The child script calls `read_input()` again but sees the cached env var (non-empty guard) rather than re-reading exhausted stdin. This MUST be verified with a test.

#### 4. Add to hooks.json
**File**: `plugin/ralph-hero/hooks/hooks.json`

Add to PreToolUse section:
```json
{
  "matcher": "Write|Edit|Bash",
  "hooks": [
    {
      "type": "command",
      "command": "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/agent-phase-gate.sh"
    }
  ]
}
```

Similarly create `agent-postcondition.sh` for Stop hooks and add to hooks.json.

### Success Criteria

#### Automated Verification:
- [x] `bash plugin/ralph-hero/hooks/scripts/hook-utils.sh` sources without error (confirmed 2026-04-01)
- [x] skill-precondition.sh allows when agent_type is present in mock input (confirmed 2026-04-01)
- [ ] `cd plugin/ralph-hero/mcp-server && npm test` passes (no server changes)
- [ ] **exec delegation test**: `agent-phase-gate.sh` → child script receives `RALPH_HOOK_INPUT` correctly via exported env var (not exhausted stdin)

#### Manual Verification:
- [ ] Direct skill invocation (`/ralph-hero:ralph-research`) still works with RALPH_COMMAND
- [ ] Hook scripts are executable (`chmod +x`)

---

## Phase 2: Skill Env Var Modernization

- **depends_on**: null

### Overview

Add a resolved configuration block to skill content and remove explicit `owner`/`repo` params from MCP tool call instructions. URL templates keep `$RALPH_GH_OWNER`/`$RALPH_GH_REPO` references but the LLM uses resolved values from the config block.

### Changes Required

#### 1. Add resolved config section to autonomous skills

Add a configuration block near the top of each autonomous skill (after the frontmatter) that provides resolved values:

```markdown
## Configuration (resolved at load time)

- Owner: !`echo ${RALPH_GH_OWNER:-NOT_SET}`
- Repo: !`echo ${RALPH_GH_REPO:-NOT_SET}`
- Project: !`echo ${RALPH_GH_PROJECT_NUMBER:-NOT_SET}`

Use these resolved values when constructing GitHub URLs or referencing the repository.
```

This is the single source of truth for env var values. The LLM reads this block and uses the resolved values throughout. No need to replace every `$RALPH_GH_OWNER` inline — the config block provides the values once.

#### 2. Remove explicit `owner`/`repo` from MCP tool call instructions

**Pattern B — MCP tool call instructions** (remove owner/repo params entirely):
```markdown
# Before
ralph_hero__get_issue(owner, repo, number)
   - owner: $RALPH_GH_OWNER
   - repo: $RALPH_GH_REPO
   - number: NNN

# After
ralph_hero__get_issue(number=NNN)
```

The MCP server's `resolveConfig()` (helpers.ts:550-566) correctly defaults to `client.config.owner`/`client.config.repo` from settings.local.json when params are omitted.

#### 3. Files to modify (17 files)

| File | Changes |
|------|---------|
| ralph-research/SKILL.md | Config block + remove owner/repo from tool calls |
| ralph-impl/SKILL.md | Config block + remove owner/repo from tool calls |
| ralph-review/SKILL.md | Config block + remove owner/repo from tool calls |
| ralph-plan/SKILL.md | Config block |
| ralph-plan-epic/SKILL.md | Config block |
| ralph-split/SKILL.md | Config block |
| ralph-triage/SKILL.md | Config block |
| ralph-merge/SKILL.md | Config block |
| ralph-pr/SKILL.md | Config block |
| ralph-val/SKILL.md | Config block |
| iterate/SKILL.md | Config block + remove owner/repo from tool calls |
| form/SKILL.md | Config block + remove owner/repo from tool calls |
| impl/SKILL.md | Config block + remove owner/repo from tool calls |
| hero/SKILL.md | Config block |
| plan/SKILL.md | Config block |
| research/SKILL.md | Config block |
| bridge-artifact/SKILL.md | Config block |
| setup-repos/SKILL.md | Remove owner/repo from tool calls |
| shared/fragments/escalation-steps.md | Config block |

### Success Criteria

#### Automated Verification:
- [ ] No remaining explicit `owner: $RALPH_GH_OWNER` or `repo: $RALPH_GH_REPO` as MCP tool call params in any skill
- [ ] All modified skills have a `## Configuration` block with backtick preprocessing
- [ ] `cd plugin/ralph-hero/mcp-server && npm test` passes

#### Manual Verification:
- [ ] Direct skill invocation resolves config block values (test with `/ralph-hero:status` or similar)

---

## Phase 3: Create Per-Phase Agents

- **depends_on**: [phase-1, phase-2]

### Overview

Create 10 new agent definitions in `plugin/ralph-hero/agents/` that preload skill content via `skills:` and define hard tool allowlists.

### Changes Required

#### 1. Agent definitions

Create the following files in `plugin/ralph-hero/agents/`:

**research-agent.md**
```yaml
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

You are a research agent. Follow the preloaded ralph-research instructions to investigate the issue specified in your task prompt.
```

**plan-agent.md**
```yaml
---
name: plan-agent
description: Create implementation plans — reads research, writes phased plans, updates GitHub
tools: Read, Write, Glob, Grep, Bash, Agent,
       ralph_hero__get_issue, ralph_hero__list_issues, ralph_hero__save_issue,
       ralph_hero__create_comment
model: opus
skills:
  - ralph-hero:ralph-plan
---

You are a planning agent. Follow the preloaded ralph-plan instructions to create an implementation plan for the issue specified in your task prompt.
```

**plan-epic-agent.md**
```yaml
---
name: plan-epic-agent
description: Strategic planning for complex multi-tier work — writes plan-of-plans, creates feature children, orchestrates wave planning
tools: Read, Write, Glob, Grep, Bash, Agent,
       ralph_hero__get_issue, ralph_hero__list_issues, ralph_hero__save_issue,
       ralph_hero__create_issue, ralph_hero__create_comment,
       ralph_hero__add_sub_issue, ralph_hero__add_dependency,
       ralph_hero__remove_dependency, ralph_hero__list_sub_issues,
       ralph_hero__decompose_feature
model: opus
skills:
  - ralph-hero:ralph-plan-epic
---

You are a strategic planning agent. Follow the preloaded ralph-plan-epic instructions to create a plan-of-plans for the issue specified in your task prompt.
```

**split-agent.md**
```yaml
---
name: split-agent
description: Split large issues into smaller sub-issues for atomic implementation
tools: Read, Glob, Grep, Bash, Agent,
       ralph_hero__get_issue, ralph_hero__list_issues, ralph_hero__save_issue,
       ralph_hero__create_issue, ralph_hero__add_sub_issue,
       ralph_hero__add_dependency, ralph_hero__remove_dependency, ralph_hero__list_sub_issues
model: opus
skills:
  - ralph-hero:ralph-split
---

You are a splitting agent. Follow the preloaded ralph-split instructions to decompose the issue specified in your task prompt.
```

**triage-agent.md**
```yaml
---
name: triage-agent
description: Triage issues from backlog — assess validity, route to research or close
tools: Read, Glob, Grep, Bash,
       ralph_hero__get_issue, ralph_hero__list_issues, ralph_hero__save_issue,
       ralph_hero__create_comment
model: sonnet
skills:
  - ralph-hero:ralph-triage
---

You are a triage agent. Follow the preloaded ralph-triage instructions to assess the issue specified in your task prompt.
```

**review-agent.md**
```yaml
---
name: review-agent
description: Review implementation plans before coding begins
tools: Read, Write, Glob, Grep, Bash, Agent,
       ralph_hero__get_issue, ralph_hero__list_issues, ralph_hero__save_issue,
       ralph_hero__create_comment
model: opus
skills:
  - ralph-hero:ralph-review
---

You are a review agent. Follow the preloaded ralph-review instructions to review the plan for the issue specified in your task prompt.
```

**impl-agent.md**
```yaml
---
name: impl-agent
description: Implement one phase of an approved plan in an isolated worktree
tools: Read, Write, Edit, Glob, Grep, Bash, Agent,
       ralph_hero__get_issue, ralph_hero__list_issues, ralph_hero__save_issue,
       ralph_hero__create_comment, ralph_hero__list_sub_issues
model: opus
skills:
  - ralph-hero:ralph-impl
---

You are an implementation agent. Follow the preloaded ralph-impl instructions to implement the issue specified in your task prompt.
```

**pr-agent.md**
```yaml
---
name: pr-agent
description: Create pull requests for completed implementations
tools: Read, Glob, Grep, Bash,
       ralph_hero__get_issue, ralph_hero__save_issue, ralph_hero__create_comment,
       ralph_hero__advance_issue
model: haiku
skills:
  - ralph-hero:ralph-pr
---

You are a PR agent. Follow the preloaded ralph-pr instructions to create a pull request for the issue specified in your task prompt.
```

**merge-agent.md**
```yaml
---
name: merge-agent
description: Merge approved pull requests and clean up
tools: Read, Glob, Grep, Bash,
       ralph_hero__get_issue, ralph_hero__save_issue, ralph_hero__create_comment,
       ralph_hero__advance_issue, ralph_hero__list_sub_issues, ralph_hero__list_dependencies
model: haiku
skills:
  - ralph-hero:ralph-merge
---

You are a merge agent. Follow the preloaded ralph-merge instructions to merge the PR for the issue specified in your task prompt.
```

**val-agent.md**
```yaml
---
name: val-agent
description: Validate implementation against plan requirements
tools: Read, Glob, Grep, Bash,
       ralph_hero__get_issue, ralph_hero__save_issue, ralph_hero__create_comment,
       ralph_hero__list_sub_issues
model: haiku
skills:
  - ralph-hero:ralph-val
---

You are a validation agent. Follow the preloaded ralph-val instructions to validate the implementation for the issue specified in your task prompt.
```

Plugin agents support `name`, `description`, `model`, `tools`, `disallowedTools`, `skills`, `memory`, `background`, `isolation`, `effort`, and `maxTurns`. Only `hooks`, `mcpServers`, and `permissionMode` are excluded.

### Success Criteria

#### Automated Verification:
- [ ] All 10 agent files exist in `plugin/ralph-hero/agents/`
- [ ] All agent files have valid YAML frontmatter
- [ ] `cd plugin/ralph-hero/mcp-server && npm test` passes

#### Manual Verification:
- [ ] `/reload-plugins` picks up new agents (count increases)
- [ ] `@research-agent` is invocable and preloads skill content
- [ ] Preloaded skill content shows resolved env vars (not `$VAR` literals)

---

## Phase 4: Update Hero Dispatch

- **depends_on**: [phase-3]

### Overview

Rewrite hero SKILL.md dispatch sections to use per-phase agents instead of wrapper agents.

### Changes Required

#### 1. Update dispatch patterns in hero/SKILL.md
**File**: `plugin/ralph-hero/skills/hero/SKILL.md`
**Current dispatch lines**: 246 (SPLIT), 309 (RESEARCH), 323-332 (PLAN variants), 340 (REVIEW), 354-358 (IMPLEMENT). Agent Dispatch Notes section at lines 361-368.

Replace all wrapper-agent dispatches:

```markdown
# Before (SPLIT — line 246)
Agent(subagent_type="ralph-hero:ralph-analyst", prompt="Run /ralph-hero:ralph-split NNN", description="Split GH-NNN")

# After
Agent(subagent_type="ralph-hero:split-agent", prompt="Split issue #NNN", description="Split GH-NNN")
```

```markdown
# Before (RESEARCH — line 309)
Agent(subagent_type="ralph-hero:ralph-analyst", prompt="Run /ralph-hero:ralph-research NNN", description="Research GH-NNN")

# After
Agent(subagent_type="ralph-hero:research-agent", prompt="Research issue #NNN", description="Research GH-NNN")
```

```markdown
# Before (PLAN — lines 323-332, four variants: L/XL epic, M/S/XS with doc, M/S/XS without, multi-issue group)
Agent(subagent_type="ralph-hero:ralph-analyst", prompt="Run /ralph-hero:ralph-plan NNN --research-doc ...", description="Plan GH-NNN")

# After
Agent(subagent_type="ralph-hero:plan-agent", prompt="Plan issue #NNN. Research doc: thoughts/shared/research/...", description="Plan GH-NNN")
```

```markdown
# Before (PLAN — L/XL epics, line 323)
Agent(subagent_type="ralph-hero:ralph-analyst", prompt="Run /ralph-hero:ralph-plan-epic NNN", description="Plan epic GH-NNN")

# After
Agent(subagent_type="ralph-hero:plan-epic-agent", prompt="Plan epic issue #NNN", description="Plan epic GH-NNN")
```

```markdown
# Before (REVIEW — line 340)
Agent(subagent_type="ralph-hero:ralph-builder", prompt="Run /ralph-hero:ralph-review NNN --plan-doc ...", description="Review GH-NNN")

# After
Agent(subagent_type="ralph-hero:review-agent", prompt="Review plan for issue #NNN. Plan doc: thoughts/shared/plans/...", description="Review GH-NNN")
```

```markdown
# Before (IMPLEMENT — lines 354/358)
Agent(subagent_type="ralph-hero:ralph-builder", prompt="Run /ralph-hero:ralph-impl NNN --plan-doc ...", description="Implement GH-NNN")

# After
Agent(subagent_type="ralph-hero:impl-agent", prompt="Implement issue #NNN. Plan doc: thoughts/shared/plans/...", description="Implement GH-NNN")
```

#### 2. Update Agent Dispatch Notes section

Replace the existing dispatch notes:
```markdown
### Agent Dispatch Notes

Per-phase agents preload skill content via the `skills:` field — no Skill() calls needed:
- Each agent has a hard tool allowlist in its `tools:` frontmatter
- Each agent's `model:` field is honored (opus for impl/plan/plan-epic/review/split, sonnet for research/triage, haiku for pr/merge/val)
- Skill content is preprocessed: env vars are resolved before the agent sees them
- Plugin-level hooks fire with `agent_type` for phase-specific gating
- Artifact paths (research docs, plan docs) are passed as natural language in the Agent() prompt
```

#### 3. Remove references to ralph-analyst, ralph-builder, ralph-integrator

Search hero SKILL.md for any remaining references to the old wrapper agents and update them.

### Success Criteria

#### Automated Verification:
- [ ] No references to `ralph-analyst`, `ralph-builder`, or `ralph-integrator` in hero SKILL.md
- [ ] All dispatch patterns use new per-phase agent names
- [ ] `cd plugin/ralph-hero/mcp-server && npm test` passes

#### Manual Verification:
- [ ] `/ralph-hero:hero NNN` dispatches to correct per-phase agents
- [ ] Research phase runs on sonnet, impl phase runs on opus

---

## Phase 5: Cleanup — Remove Wrapper Agents & Deprecate Team

- **depends_on**: [phase-4]

### Overview

Remove wrapper agents and deprecate team skill. This happens BEFORE docs update so specs reflect the final state.

### Changes Required

#### 1. Remove wrapper agent files
```
rm plugin/ralph-hero/agents/ralph-analyst.md
rm plugin/ralph-hero/agents/ralph-builder.md
rm plugin/ralph-hero/agents/ralph-integrator.md
```

#### 2. Deprecate team skill
**File**: `plugin/ralph-hero/skills/team/SKILL.md` (roster table at lines 91-93)

Add deprecation notice to frontmatter and top of content:
```yaml
---
description: "[DEPRECATED] Use /ralph-hero:hero instead. ..."
---

> **DEPRECATED**: This skill uses the old wrapper-agent architecture.
> Use `/ralph-hero:hero` for orchestrated pipeline execution.
```

### Success Criteria

#### Automated Verification:
- [ ] `ralph-analyst.md`, `ralph-builder.md`, `ralph-integrator.md` no longer exist
- [ ] `cd plugin/ralph-hero/mcp-server && npm test` passes
- [ ] No remaining references to removed agents in any skill or hook file

#### Manual Verification:
- [ ] `/reload-plugins` loads without errors

---

## Phase 6: Docs & Specs Update

- **depends_on**: [phase-5]

### Overview

Update CLAUDE.md and specs/ to reflect the final architecture (old agents already removed).

### Changes Required

#### 1. Update CLAUDE.md
**File**: `CLAUDE.md`

Update the Architecture section to describe the new agent-per-phase model:
- Replace the description of wrapper agents with per-phase agents
- Document the `skills:` preload pattern
- Document backtick preprocessing for env vars
- Update the agent list with the 10 new agents and their roles/models
- Note that plugin agents can't have `hooks`, `mcpServers`, or `permissionMode`

#### 2. Update specs/agent-permissions.md
**File**: `specs/agent-permissions.md`

- Update "Agent" definition: agents are now per-phase containers, not skill orchestrators
- Update the permission layering model:
  - Layer 1: Agent `tools:` (hard allowlist — this is now the primary enforcement)
  - Layer 2: Skill `allowed-tools:` is a **permission grant** (auto-approve), NOT a hard restriction
  - Layer 3: Plugin-level hooks discriminate by `agent_type` (replaces RALPH_COMMAND for agent invocations)
- Add note about plugin agent frontmatter limitations

#### 3. Update specs/skill-permissions.md
**File**: `specs/skill-permissions.md`

- Correct the `allowed-tools` definition: it's a permission grant, not a whitelist enforced by runtime
- Add agent tool matrices alongside skill tool matrices
- Note that when skills are preloaded via `skills:`, the agent's `tools:` field is the enforcement boundary

#### 4. Update specs/skill-io-contracts.md
**File**: `specs/skill-io-contracts.md`

- Update RALPH_COMMAND documentation: set by SessionStart for direct invocation, inferred from `agent_type` for agent-based invocation
- Add note about backtick preprocessing resolving env vars at load time
- Update the `$RALPH_GH_OWNER`/`$RALPH_GH_REPO` contract: skills use config block with backtick preprocessing, MCP tools use server defaults

### Success Criteria

#### Automated Verification:
- [ ] No stale references to ralph-analyst, ralph-builder, ralph-integrator in CLAUDE.md or specs/

#### Manual Verification:
- [ ] CLAUDE.md architecture section accurately describes current system
- [ ] Specs reflect actual enforcement behavior (permission grant vs hard restriction)

---

## Phase 7: Manual Integration Testing

- **depends_on**: [phase-6]

### Overview

End-to-end manual verification using `--plugin-dir` to test the full plugin outside the development environment before merging.

### Test Procedure

#### 1. Plugin namespace skill reference test
Verify that `skills: [ralph-hero:ralph-research]` in plugin agent frontmatter correctly resolves and preloads the plugin-namespaced skill content.

```bash
# From a separate directory (e.g., ralph-engine repo):
claude --plugin-dir /path/to/ralph-hero/plugin/ralph-hero
```

Then: "Use the research-agent to run diagnostics" — verify skill content is preloaded with resolved env vars.

#### 2. Per-phase agent invocation
Test each agent type can be invoked:
- `@research-agent` — verify sonnet model, skill content present
- `@impl-agent` — verify opus model, skill content present
- `@pr-agent` — verify haiku model, skill content present

#### 3. Hook discrimination
Verify hooks.json hooks fire with correct `agent_type`:
- Inside `@impl-agent`, attempt a Write — verify `agent-phase-gate.sh` routes to `impl-plan-required.sh`
- Inside `@research-agent`, attempt a Bash — verify `branch-gate.sh` fires

#### 4. Hero end-to-end
Run `/ralph-hero:hero NNN` with a real issue through at least the research phase. Verify:
- Correct agent dispatched
- Correct model used
- Env vars resolved in preloaded content
- MCP tools work without owner/repo params
- Hooks fire appropriately

#### 5. Direct skill invocation backward compatibility
Verify interactive skills still work:
- `/ralph-hero:ralph-research NNN` — direct invocation with RALPH_COMMAND via SessionStart
- Hooks from skill frontmatter fire (not double-blocked by hooks.json)

#### 6. Cross-repo verification
Test in the ralph-engine repo to verify env vars resolve to ralph-engine values (not ralph-hero):
```bash
cd /Users/dubiel/projects/ralph-engine
claude --plugin-dir /path/to/ralph-hero/plugin/ralph-hero
# Use research-agent, verify Owner=cdubiel08, Repo=ralph-engine, Project=7
```

### Success Criteria

#### Manual Verification:
- [ ] Plugin skill namespace reference works (`skills: [ralph-hero:ralph-research]`)
- [ ] All 10 agents are invocable with correct models
- [ ] Hook `agent_type` discrimination works
- [ ] Hero dispatches correctly end-to-end
- [ ] Direct skill invocation backward compatible
- [ ] Cross-repo env var resolution correct

---

## Testing Strategy

### Unit Tests
- Hook scripts: mock hook input JSON with/without `agent_type` field, verify correct allow/block behavior
- Exec delegation chain: verify `RALPH_HOOK_INPUT` env var survives exec to child script

### Integration Tests
- Hero dispatch: run `/ralph-hero:hero` with a test issue, verify per-phase agents are invoked
- Skill preloading: verify `@research-agent` sees resolved env vars in preloaded skill content

### Manual Testing Steps (Phase 7)
1. Plugin skill namespace resolution via `--plugin-dir`
2. Per-phase agent invocation with correct models
3. Hook `agent_type` discrimination
4. `/ralph-hero:hero NNN` end-to-end pipeline
5. Direct skill invocation backward compatibility
6. Cross-repo env var resolution in ralph-engine

## References

- Original research: `thoughts/shared/research/2026-03-24-agent-env-propagation-token-scope.md`
- Re-validation (2026-04-01): `thoughts/shared/research/2026-04-01-GH-0674-agent-per-phase-still-needed.md`
- Claude Code Sub-agents Docs: https://code.claude.com/docs/en/sub-agents
- Claude Code Skills Docs: https://code.claude.com/docs/en/skills
- Claude Code Plugins Reference: https://code.claude.com/docs/en/plugins-reference
- Claude Code Hooks Docs: https://code.claude.com/docs/en/hooks
