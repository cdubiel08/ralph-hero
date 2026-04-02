---
date: 2026-04-01
status: draft
type: plan
github_issue: 707
github_issues: [707, 708, 709, 710, 711, 712, 713]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/707
  - https://github.com/cdubiel08/ralph-hero/issues/708
  - https://github.com/cdubiel08/ralph-hero/issues/709
  - https://github.com/cdubiel08/ralph-hero/issues/710
  - https://github.com/cdubiel08/ralph-hero/issues/711
  - https://github.com/cdubiel08/ralph-hero/issues/712
  - https://github.com/cdubiel08/ralph-hero/issues/713
primary_issue: 707
tags: [architecture, agents, skills, hooks, hero-dispatch, env-vars]
---

# Agent-Per-Phase Architecture — Group Implementation Plan

## Prior Work

- builds_on:: [[2026-04-01-GH-0674-agent-per-phase-still-needed]]
- builds_on:: [[2026-03-24-GH-0674-agent-per-phase-architecture]]
- builds_on:: [[2026-03-24-agent-env-propagation-token-scope]]

## Overview

7 related issues implementing the agent-per-phase architecture in dependency order, all as a single feature branch (`feat/agent-per-phase`):

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-707 | Phase 1 (remainder): Create agent-phase-gate.sh and wire into hooks.json | XS |
| 2 | GH-708 | Phase 2: Skill env var modernization — config block + remove explicit owner/repo params | S |
| 3 | GH-709 | Phase 3: Create 10 per-phase agent files | XS |
| 4 | GH-710 | Phase 4: Update hero dispatch to use per-phase agents | XS |
| 5 | GH-711 | Phase 5: Remove wrapper agents and deprecate team skill | XS |
| 6 | GH-712 | Phase 6: Update CLAUDE.md and specs for agent-per-phase architecture | XS |
| 7 | GH-713 | Phase 7: Manual integration testing — end-to-end verification | XS |

**Why grouped**: These 7 issues are the remaining implementation phases of a single architectural change (GH-674). They form a strict dependency chain (Phase N depends on Phase N-1, with Phase 1 and 2 running in parallel) and must be delivered together in one PR to avoid leaving the codebase in a broken intermediate state.

## Shared Constraints

- **All work MUST happen on a feature branch** `feat/agent-per-phase` — never commit to main until Phase 7 passes. Use a worktree: `git worktree add ../ralph-hero-agent-per-phase feat/agent-per-phase`.
- **MCP server is NOT touched** — `resolveConfig()` in `plugin/ralph-hero/mcp-server/src/lib/helpers.ts` already defaults correctly when `owner`/`repo` are omitted. No server changes in any phase.
- **Plugin agents cannot declare** `hooks`, `mcpServers`, or `permissionMode` in frontmatter — only `name`, `description`, `model`, `tools`, `disallowedTools`, `skills`, `memory`, `background`, `isolation`, `effort`, `maxTurns`.
- **Hook tool names in `hooks.json` matchers are raw tool names** (`Write`, `Edit`, `Bash`) not MCP-prefixed names.
- **`exec` delegation in bash hooks requires `RALPH_HOOK_INPUT` to be exported** by `read_input()` before `exec` is called — the child script calls `read_input()` again but the cached env var is non-empty so stdin (already exhausted) is not re-read.
- **Automated verification command**: `cd plugin/ralph-hero/mcp-server && npm test` — must pass after every phase.
- **Test file pattern**: Hook tests in `plugin/ralph-hero/hooks/scripts/__tests__/` follow the `test-tier-detection.sh` bash assert pattern (no external test framework).
- **Backtick preprocessing syntax**: `!` followed by a backtick command in skill markdown is the only supported env var escape hatch. Use `!`echo ${RALPH_GH_OWNER:-NOT_SET}`` format.

## Current State Analysis

Phase 1 of the original GH-674 plan is ~50% complete. Specifically:
- `plugin/ralph-hero/hooks/scripts/hook-utils.sh:35-37` — `get_agent_type()` function **exists and works**
- `plugin/ralph-hero/hooks/scripts/skill-precondition.sh:25-31` — agent_type fallback **exists and works**
- `plugin/ralph-hero/hooks/scripts/agent-phase-gate.sh` — **does not exist**
- `plugin/ralph-hero/hooks/hooks.json` — has no `agent_type`-aware PreToolUse entry for `Write|Edit|Bash`

All three wrapper agents still exist: `ralph-analyst.md`, `ralph-builder.md`, `ralph-integrator.md`.
Hero dispatch at `plugin/ralph-hero/skills/hero/SKILL.md:246,309,318-332,340,354-358` still routes through wrapper agents.
No per-phase agents exist in `plugin/ralph-hero/agents/`.
85 occurrences of `$RALPH_GH_OWNER` and 82 of `$RALPH_GH_REPO` as unexpandable literals in skill files.

## Desired End State
### Verification
- [x] GH-707: `agent-phase-gate.sh` exists, is executable, correctly delegates to child scripts, and is registered in hooks.json
- [ ] GH-708: All autonomous skills have a `## Configuration` block with backtick preprocessing; no `owner: $RALPH_GH_OWNER` params in MCP tool call instructions
- [ ] GH-709: All 10 per-phase agent files exist with valid frontmatter (`name`, `model`, `tools`, `skills`)
- [ ] GH-710: Hero dispatch uses per-phase agents; zero references to `ralph-analyst`/`ralph-builder`/`ralph-integrator` in hero SKILL.md
- [ ] GH-711: Wrapper agent files deleted; team/SKILL.md has deprecation notice
- [ ] GH-712: CLAUDE.md and specs/ reflect new architecture; no stale wrapper agent references
- [ ] GH-713: All 6 manual test scenarios pass; end-to-end hero pipeline dispatches per-phase agents with correct models

## What We're NOT Doing

- Changing the MCP server (`resolveConfig()` defaults already work)
- Removing skills — they remain for direct interactive invocation
- Compacting skill prompt sizes (context window pressure is a separate effort)
- Adding hooks to agent frontmatter (plugin agents can't have them)
- Automated test coverage of hero end-to-end dispatch (Phase 7 is manual)

## Implementation Approach

Phases 1 and 2 can run in parallel. Phase 3 depends on both. Phases 4-7 are strictly sequential. The full feature lives on `feat/agent-per-phase` and merges as one PR after Phase 7.

---

## Phase 1: GH-707 — Create agent-phase-gate.sh and wire into hooks.json

- **depends_on**: null

### Overview

Complete the two remaining Phase 1 items: create `agent-phase-gate.sh` (the `agent_type`-aware dispatch script) and register it in `hooks.json` for `Write|Edit|Bash` PreToolUse events.

### Tasks

#### Task 1.1: Create agent-phase-gate.sh
- **files**: `plugin/ralph-hero/hooks/scripts/agent-phase-gate.sh` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] File exists at `plugin/ralph-hero/hooks/scripts/agent-phase-gate.sh`
  - [ ] File is executable (`chmod +x` applied)
  - [ ] Shebang is `#!/usr/bin/env bash`
  - [ ] Sources `hook-utils.sh` via `source "$(dirname "$0")/hook-utils.sh"`
  - [ ] Calls `read_input > /dev/null` then `agent_type=$(get_agent_type)`
  - [ ] First guard: `[[ -n "${RALPH_COMMAND:-}" ]] && { allow; exit 0; }`
  - [ ] Second guard: `[[ -z "$agent_type" ]] && { allow; exit 0; }`
  - [ ] Calls `get_tool_name` and uses `case` on `$agent_type`
  - [ ] `impl-agent` routes `Write|Edit` to `impl-plan-required.sh` and `Bash` to `impl-branch-gate.sh` via `exec`
  - [ ] `research-agent|plan-agent|plan-epic-agent|triage-agent|split-agent|review-agent` routes `Bash` to `branch-gate.sh` via `exec`
  - [ ] Falls through to `allow` when no case matches

#### Task 1.2: Write exec-delegation test
- **files**: `plugin/ralph-hero/hooks/scripts/__tests__/test-agent-phase-gate.sh` (create), `plugin/ralph-hero/hooks/scripts/agent-phase-gate.sh` (read)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] Test file is executable
  - [ ] Test case: `RALPH_COMMAND=ralph_plan` set, `agent_type` in input → exits 0 (RALPH_COMMAND guard fires)
  - [ ] Test case: `RALPH_COMMAND` unset, `agent_type` empty in input → exits 0 (empty agent_type guard fires)
  - [ ] Test case: `RALPH_COMMAND` unset, `agent_type=impl-agent`, `tool_name=Write` → `RALPH_HOOK_INPUT` is exported and child script receives it (verify via `printenv RALPH_HOOK_INPUT` stub)
  - [ ] Test case: `RALPH_COMMAND` unset, `agent_type=research-agent`, `tool_name=Read` → exits 0 (no case match, allow)
  - [ ] All assertions use the `assert_eq` pattern matching `test-tier-detection.sh`
  - [ ] `bash plugin/ralph-hero/hooks/scripts/__tests__/test-agent-phase-gate.sh` exits 0

#### Task 1.3: Register agent-phase-gate.sh in hooks.json
- **files**: `plugin/ralph-hero/hooks/hooks.json` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] `hooks.json` has a new PreToolUse entry with `"matcher": "Write|Edit|Bash"` containing `agent-phase-gate.sh`
  - [ ] The new entry appears BEFORE the existing `Write` and `Bash` entries in PreToolUse (gate runs first)
  - [ ] Command value is `"${CLAUDE_PLUGIN_ROOT}/hooks/scripts/agent-phase-gate.sh"`
  - [ ] JSON remains valid (parseable by `jq .`)
  - [ ] Existing PreToolUse entries are untouched

### Phase Success Criteria

#### Automated Verification:
- [x] `bash plugin/ralph-hero/hooks/scripts/__tests__/test-agent-phase-gate.sh` — all assertions pass
- [x] `cd plugin/ralph-hero/mcp-server && npm test` — no errors
- [x] `jq . plugin/ralph-hero/hooks/hooks.json` — valid JSON

#### Manual Verification:
- [x] `ls -la plugin/ralph-hero/hooks/scripts/agent-phase-gate.sh` shows executable bit set

**Creates for next phase**: `agent-phase-gate.sh` (needed by GH-713 for hook discrimination test)

---

## Phase 2: GH-708 — Skill Env Var Modernization

- **depends_on**: null

### Overview

Add a resolved `## Configuration` block to 18 skill files using backtick preprocessing, and remove explicit `owner`/`repo` parameters from MCP tool call instructions in the 8 skills that include them.

### Tasks

#### Task 2.1: Add configuration blocks to skills (batch A — autonomous skills)
- **files**: `plugin/ralph-hero/skills/ralph-research/SKILL.md` (modify), `plugin/ralph-hero/skills/ralph-impl/SKILL.md` (modify), `plugin/ralph-hero/skills/ralph-review/SKILL.md` (modify), `plugin/ralph-hero/skills/ralph-plan/SKILL.md` (modify), `plugin/ralph-hero/skills/ralph-plan-epic/SKILL.md` (modify), `plugin/ralph-hero/skills/ralph-split/SKILL.md` (modify), `plugin/ralph-hero/skills/ralph-triage/SKILL.md` (modify), `plugin/ralph-hero/skills/ralph-merge/SKILL.md` (modify), `plugin/ralph-hero/skills/ralph-pr/SKILL.md` (modify), `plugin/ralph-hero/skills/ralph-val/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] Each of the 10 files gains a `## Configuration (resolved at load time)` section immediately after the frontmatter block
  - [ ] Section contains exactly: `- Owner: !`echo ${RALPH_GH_OWNER:-NOT_SET}`` (backtick syntax), `- Repo: !`echo ${RALPH_GH_REPO:-NOT_SET}``, `- Project: !`echo ${RALPH_GH_PROJECT_NUMBER:-NOT_SET}``
  - [ ] Section ends with: `Use these resolved values when constructing GitHub URLs or referencing the repository.`
  - [ ] No existing content is removed in this task

#### Task 2.2: Add configuration blocks to skills (batch B — interactive and shared)
- **files**: `plugin/ralph-hero/skills/iterate/SKILL.md` (modify), `plugin/ralph-hero/skills/form/SKILL.md` (modify), `plugin/ralph-hero/skills/impl/SKILL.md` (modify), `plugin/ralph-hero/skills/hero/SKILL.md` (modify), `plugin/ralph-hero/skills/plan/SKILL.md` (modify), `plugin/ralph-hero/skills/research/SKILL.md` (modify), `plugin/ralph-hero/skills/bridge-artifact/SKILL.md` (modify), `plugin/ralph-hero/skills/shared/fragments/escalation-steps.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] Each of the 8 files gains the same `## Configuration (resolved at load time)` section
  - [ ] For `escalation-steps.md` (a fragment, no frontmatter): configuration block is inserted at the top of the file
  - [ ] No existing content is removed

#### Task 2.3: Remove explicit owner/repo params from MCP tool call instructions
- **files**: `plugin/ralph-hero/skills/ralph-research/SKILL.md` (modify), `plugin/ralph-hero/skills/ralph-impl/SKILL.md` (modify), `plugin/ralph-hero/skills/ralph-review/SKILL.md` (modify), `plugin/ralph-hero/skills/iterate/SKILL.md` (modify), `plugin/ralph-hero/skills/form/SKILL.md` (modify), `plugin/ralph-hero/skills/impl/SKILL.md` (modify), `plugin/ralph-hero/skills/research/SKILL.md` (modify), `plugin/ralph-hero/skills/setup-repos/SKILL.md` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [2.1, 2.2]
- **acceptance**:
  - [ ] Zero occurrences of `owner: $RALPH_GH_OWNER` as a MCP tool call parameter in any of these files
  - [ ] Zero occurrences of `repo: $RALPH_GH_REPO` as a MCP tool call parameter in any of these files
  - [ ] Tool call instructions use short form: `ralph_hero__get_issue(number=NNN)` not `ralph_hero__get_issue(owner, repo, number)`
  - [ ] URL template references to `$RALPH_GH_OWNER`/`$RALPH_GH_REPO` (e.g., in GitHub link examples) are preserved — only MCP parameter values are removed

### Phase Success Criteria

#### Automated Verification:
- [x] `grep -r "owner: \$RALPH_GH_OWNER" plugin/ralph-hero/skills/` — zero matches
- [x] `grep -r "repo: \$RALPH_GH_REPO" plugin/ralph-hero/skills/` — zero matches
- [x] `cd plugin/ralph-hero/mcp-server && npm test` — no errors

#### Manual Verification:
- [ ] Open one modified skill file and verify the Configuration block appears at the top and shows correct structure

**Creates for next phase**: All skills have resolved config blocks, enabling skill preloading to deliver real env var values to per-phase agents (GH-709 depends on this working correctly at runtime)

---

## Phase 3: GH-709 — Create 10 Per-Phase Agent Files

- **depends_on**: [phase-1, phase-2]

### Overview

Create 10 new agent definition files in `plugin/ralph-hero/agents/`. Each file preloads exactly one skill and declares a tool allowlist appropriate to that phase.

### Tasks

#### Task 3.1: Create analyst-tier agents (research-agent, plan-agent, plan-epic-agent, split-agent, triage-agent)
- **files**: `plugin/ralph-hero/agents/research-agent.md` (create), `plugin/ralph-hero/agents/plan-agent.md` (create), `plugin/ralph-hero/agents/plan-epic-agent.md` (create), `plugin/ralph-hero/agents/split-agent.md` (create), `plugin/ralph-hero/agents/triage-agent.md` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] `research-agent.md`: `model: sonnet`, `skills: [ralph-hero:ralph-research]`, tools include `Read, Write, Glob, Grep, Bash, Agent, WebSearch, WebFetch` plus `ralph_hero__get_issue, ralph_hero__list_issues, ralph_hero__save_issue, ralph_hero__create_comment, ralph_hero__add_dependency, ralph_hero__remove_dependency`
  - [ ] `plan-agent.md`: `model: opus`, `skills: [ralph-hero:ralph-plan]`, tools include `Read, Write, Glob, Grep, Bash, Agent` plus `ralph_hero__get_issue, ralph_hero__list_issues, ralph_hero__save_issue, ralph_hero__create_comment`
  - [ ] `plan-epic-agent.md`: `model: opus`, `skills: [ralph-hero:ralph-plan-epic]`, tools include `Read, Write, Glob, Grep, Bash, Agent` plus `ralph_hero__get_issue, ralph_hero__list_issues, ralph_hero__save_issue, ralph_hero__create_issue, ralph_hero__create_comment, ralph_hero__add_sub_issue, ralph_hero__add_dependency, ralph_hero__remove_dependency, ralph_hero__list_sub_issues, ralph_hero__decompose_feature`
  - [ ] `split-agent.md`: `model: opus`, `skills: [ralph-hero:ralph-split]`, tools include `Read, Glob, Grep, Bash, Agent` plus `ralph_hero__get_issue, ralph_hero__list_issues, ralph_hero__save_issue, ralph_hero__create_issue, ralph_hero__add_sub_issue, ralph_hero__add_dependency, ralph_hero__remove_dependency, ralph_hero__list_sub_issues`
  - [ ] `triage-agent.md`: `model: sonnet`, `skills: [ralph-hero:ralph-triage]`, tools include `Read, Glob, Grep, Bash` plus `ralph_hero__get_issue, ralph_hero__list_issues, ralph_hero__save_issue, ralph_hero__create_comment`
  - [ ] All 5 files have `name:` matching the filename (without `.md`)
  - [ ] No `hooks`, `mcpServers`, or `permissionMode` fields in any file

#### Task 3.2: Create review-agent and impl-agent (builder tier)
- **files**: `plugin/ralph-hero/agents/review-agent.md` (create), `plugin/ralph-hero/agents/impl-agent.md` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] `review-agent.md`: `model: opus`, `skills: [ralph-hero:ralph-review]`, tools include `Read, Write, Glob, Grep, Bash, Agent` plus `ralph_hero__get_issue, ralph_hero__list_issues, ralph_hero__save_issue, ralph_hero__create_comment`
  - [ ] `impl-agent.md`: `model: opus`, `skills: [ralph-hero:ralph-impl]`, tools include `Read, Write, Edit, Glob, Grep, Bash, Agent` plus `ralph_hero__get_issue, ralph_hero__list_issues, ralph_hero__save_issue, ralph_hero__create_comment, ralph_hero__list_sub_issues`
  - [ ] Both files have `name:` matching filename
  - [ ] No `hooks`, `mcpServers`, or `permissionMode` fields

#### Task 3.3: Create integrator-tier agents (pr-agent, merge-agent, val-agent)
- **files**: `plugin/ralph-hero/agents/pr-agent.md` (create), `plugin/ralph-hero/agents/merge-agent.md` (create), `plugin/ralph-hero/agents/val-agent.md` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] `pr-agent.md`: `model: haiku`, `skills: [ralph-hero:ralph-pr]`, tools include `Read, Glob, Grep, Bash` plus `ralph_hero__get_issue, ralph_hero__save_issue, ralph_hero__create_comment, ralph_hero__advance_issue`
  - [ ] `merge-agent.md`: `model: haiku`, `skills: [ralph-hero:ralph-merge]`, tools include `Read, Glob, Grep, Bash` plus `ralph_hero__get_issue, ralph_hero__save_issue, ralph_hero__create_comment, ralph_hero__advance_issue, ralph_hero__list_sub_issues, ralph_hero__list_dependencies`
  - [ ] `val-agent.md`: `model: haiku`, `skills: [ralph-hero:ralph-val]`, tools include `Read, Glob, Grep, Bash` plus `ralph_hero__get_issue, ralph_hero__save_issue, ralph_hero__create_comment, ralph_hero__list_sub_issues`
  - [ ] All 3 files have `name:` matching filename
  - [ ] No `hooks`, `mcpServers`, or `permissionMode` fields

### Phase Success Criteria

#### Automated Verification:
- [x] `ls plugin/ralph-hero/agents/ | grep -E "research-agent|plan-agent|plan-epic-agent|split-agent|triage-agent|review-agent|impl-agent|pr-agent|merge-agent|val-agent" | wc -l` — output is `10`
- [x] `cd plugin/ralph-hero/mcp-server && npm test` — no errors

#### Manual Verification:
- [ ] `/reload-plugins` completes without errors; agent count increases by 10

**Creates for next phase**: All 10 per-phase agent names available for hero dispatch to reference (GH-710)

---

## Phase 4: GH-710 — Update Hero Dispatch

- **depends_on**: [phase-3]

### Overview

Rewrite the 6 dispatch sections in `plugin/ralph-hero/skills/hero/SKILL.md` (lines 246, 309, 318-332, 340, 354-358) to use per-phase agents instead of wrapper agents. Update the Agent Dispatch Notes section.

### Tasks

#### Task 4.1: Update SPLIT dispatch (line 246)
- **files**: `plugin/ralph-hero/skills/hero/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] Line 246 (SPLIT) changes from `subagent_type="ralph-hero:ralph-analyst", prompt="Run /ralph-hero:ralph-split NNN"` to `subagent_type="ralph-hero:split-agent", prompt="Split issue #NNN"`
  - [ ] No other content in the SPLIT section is changed

#### Task 4.2: Update RESEARCH dispatch (line 309)
- **files**: `plugin/ralph-hero/skills/hero/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] Line 309 (RESEARCH) changes from `subagent_type="ralph-hero:ralph-analyst", prompt="Run /ralph-hero:ralph-research NNN"` to `subagent_type="ralph-hero:research-agent", prompt="Research issue #NNN"`

#### Task 4.3: Update PLAN dispatch variants (lines 318-332)
- **files**: `plugin/ralph-hero/skills/hero/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] L/XL epic variant: changes from `ralph-analyst` + `Run /ralph-hero:ralph-plan-epic NNN` to `plan-epic-agent` + `Plan epic issue #NNN`
  - [ ] M/S/XS with research doc: changes from `ralph-analyst` + `Run /ralph-hero:ralph-plan NNN --research-doc ...` to `plan-agent` + `Plan issue #NNN. Research doc: <path>`
  - [ ] M/S/XS without research doc: changes from `ralph-analyst` + `Run /ralph-hero:ralph-plan NNN` to `plan-agent` + `Plan issue #NNN`
  - [ ] Multi-issue group variant: changes from `ralph-analyst` to `plan-agent`, natural language prompt

#### Task 4.4: Update REVIEW dispatch (line 340) and IMPLEMENT dispatch (lines 354-358)
- **files**: `plugin/ralph-hero/skills/hero/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] REVIEW (line 340): changes from `ralph-builder` + `Run /ralph-hero:ralph-review NNN --plan-doc ...` to `review-agent` + `Review plan for issue #NNN. Plan doc: <path>`
  - [ ] IMPLEMENT with doc (line 354): changes from `ralph-builder` + `Run /ralph-hero:ralph-impl NNN --plan-doc ...` to `impl-agent` + `Implement issue #NNN. Plan doc: <path>`
  - [ ] IMPLEMENT without doc (line 358): changes from `ralph-builder` + `Run /ralph-hero:ralph-impl NNN` to `impl-agent` + `Implement issue #NNN`

#### Task 4.5: Update Agent Dispatch Notes section (lines 361-368)
- **files**: `plugin/ralph-hero/skills/hero/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [4.1, 4.2, 4.3, 4.4]
- **acceptance**:
  - [ ] The `### Agent Dispatch Notes` section (currently lines 361-368) is rewritten to describe per-phase agent architecture
  - [ ] New content states: agents preload skill content via `skills:` field, no `Skill()` calls needed
  - [ ] New content documents: `tools:` is the hard allowlist, `model:` is honored, skill content is preprocessed with resolved env vars, plugin-level hooks fire with `agent_type`
  - [ ] New content notes: artifact paths (research docs, plan docs) are passed as natural language in Agent() prompt
  - [ ] Zero remaining references to `ralph-analyst`, `ralph-builder`, or `ralph-integrator` in the entire file

### Phase Success Criteria

#### Automated Verification:
- [x] `grep -n "ralph-analyst\|ralph-builder\|ralph-integrator" plugin/ralph-hero/skills/hero/SKILL.md` — zero matches
- [x] `cd plugin/ralph-hero/mcp-server && npm test` — no errors

#### Manual Verification:
- [ ] Hero SKILL.md dispatch sections read coherently with natural language prompts

**Creates for next phase**: Hero no longer references wrapper agents, safe to delete them (GH-711)

---

## Phase 5: GH-711 — Remove Wrapper Agents and Deprecate Team Skill

- **depends_on**: [phase-4]

### Overview

Delete the three old wrapper agent files and add a deprecation notice to the team skill. Pre-delete grep check ensures nothing else references the removed agents.

### Tasks

#### Task 5.1: Grep check for remaining references before deletion
- **files**: `plugin/ralph-hero/skills/hero/SKILL.md` (read), `plugin/ralph-hero/skills/team/SKILL.md` (read)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] Run: `grep -r "ralph-analyst\|ralph-builder\|ralph-integrator" plugin/ralph-hero/skills/ plugin/ralph-hero/hooks/ specs/`
  - [ ] The only match is `team/SKILL.md` (which still references them in its roster before this phase patches it)
  - [ ] If any other match found in skills/ or hooks/: STOP and fix the reference before proceeding

#### Task 5.2: Add deprecation notice to team/SKILL.md
- **files**: `plugin/ralph-hero/skills/team/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [5.1]
- **acceptance**:
  - [ ] Frontmatter `description:` field updated to: `"[DEPRECATED] Use /ralph-hero:hero instead. Team skill uses the old wrapper-agent architecture which is superseded by per-phase agents."`
  - [ ] Top of content (after frontmatter) has: `> **DEPRECATED**: This skill uses the old wrapper-agent architecture.\n> Use \`/ralph-hero:hero\` for orchestrated pipeline execution.`

#### Task 5.3: Delete wrapper agent files
- **files**: `plugin/ralph-hero/agents/ralph-analyst.md` (delete), `plugin/ralph-hero/agents/ralph-builder.md` (delete), `plugin/ralph-hero/agents/ralph-integrator.md` (delete)
- **tdd**: false
- **complexity**: low
- **depends_on**: [5.1, 5.2]
- **acceptance**:
  - [ ] `plugin/ralph-hero/agents/ralph-analyst.md` no longer exists
  - [ ] `plugin/ralph-hero/agents/ralph-builder.md` no longer exists
  - [ ] `plugin/ralph-hero/agents/ralph-integrator.md` no longer exists
  - [ ] `git rm plugin/ralph-hero/agents/ralph-analyst.md plugin/ralph-hero/agents/ralph-builder.md plugin/ralph-hero/agents/ralph-integrator.md` used (not just `rm`) so deletions are staged

### Phase Success Criteria

#### Automated Verification:
- [x] `ls plugin/ralph-hero/agents/ | grep -E "ralph-analyst|ralph-builder|ralph-integrator"` — zero matches
- [x] `grep -r "ralph-analyst\|ralph-builder\|ralph-integrator" plugin/ralph-hero/skills/ plugin/ralph-hero/hooks/ specs/` — zero matches
- [x] `cd plugin/ralph-hero/mcp-server && npm test` — no errors

#### Manual Verification:
- [ ] `/reload-plugins` loads without errors after deletion

**Creates for next phase**: Codebase is clean of old architecture; docs can now be written to describe final state (GH-712)

---

## Phase 6: GH-712 — Update CLAUDE.md and Specs

- **depends_on**: [phase-5]

### Overview

Update four documentation files to reflect the final agent-per-phase architecture: `CLAUDE.md`, `specs/agent-permissions.md`, `specs/skill-permissions.md`, and `specs/skill-io-contracts.md`.

### Tasks

#### Task 6.1: Update CLAUDE.md architecture section
- **files**: `CLAUDE.md` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] The agent list in the Architecture section replaces `ralph-analyst`, `ralph-builder`, `ralph-integrator` with the 10 per-phase agents and their models
  - [ ] Documents the `skills:` preload pattern: "skill content is injected into agent context with backtick preprocessing"
  - [ ] Notes that plugin agents cannot declare `hooks`, `mcpServers`, or `permissionMode`
  - [ ] No remaining references to `ralph-analyst`, `ralph-builder`, or `ralph-integrator` in the file

#### Task 6.2: Update specs/agent-permissions.md
- **files**: `specs/agent-permissions.md` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] "Agent" definition updated: agents are per-phase containers, not skill orchestrators
  - [ ] Permission layering section updated: Layer 1 = agent `tools:` (hard allowlist), Layer 2 = skill `allowed-tools:` (permission grant, not restriction), Layer 3 = plugin hooks.json discriminating by `agent_type`
  - [ ] Note added: plugin agent frontmatter cannot include `hooks`, `mcpServers`, `permissionMode`
  - [ ] No references to `ralph-analyst`, `ralph-builder`, `ralph-integrator`

#### Task 6.3: Update specs/skill-permissions.md
- **files**: `specs/skill-permissions.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] `allowed-tools` definition corrected to: "permission grant (auto-approve), not an enforced restriction"
  - [ ] Agent tool matrices added alongside skill tool matrices
  - [ ] Note added: when preloaded via `skills:`, the agent's `tools:` field is the enforcement boundary

#### Task 6.4: Update specs/skill-io-contracts.md
- **files**: `specs/skill-io-contracts.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] `RALPH_COMMAND` documentation updated: "set by SessionStart for direct skill invocation; inferred from `agent_type` for agent-based invocations"
  - [ ] Note added about backtick preprocessing resolving env vars at skill load time
  - [ ] `$RALPH_GH_OWNER`/`$RALPH_GH_REPO` contract updated: "skills use `## Configuration` block with backtick preprocessing; MCP tools use server defaults when params are omitted"

### Phase Success Criteria

#### Automated Verification:
- [ ] `grep -r "ralph-analyst\|ralph-builder\|ralph-integrator" CLAUDE.md specs/` — zero matches
- [ ] `cd plugin/ralph-hero/mcp-server && npm test` — no errors

#### Manual Verification:
- [ ] CLAUDE.md agents table lists all 10 per-phase agents with correct models
- [ ] `specs/agent-permissions.md` `allowed-tools` description matches actual runtime behavior

**Creates for next phase**: Accurate documentation required for Phase 7 testers to know what to verify

---

## Phase 7: GH-713 — Manual Integration Testing

- **depends_on**: [phase-6]

### Overview

Six manual test scenarios verify the complete system end-to-end using `--plugin-dir` from a separate repo to simulate production conditions.

### Tasks

#### Task 7.1: Test 1 — Plugin skill namespace resolution
- **files**: (no file changes — testing only)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] From a separate directory (e.g., `~/projects/ralph-engine`): `claude --plugin-dir /Users/dubiel/projects/ralph-hero/plugin/ralph-hero`
  - [ ] Invoke `@research-agent` and ask it to describe itself
  - [ ] Preloaded skill content is visible in context (not empty)
  - [ ] Env vars are resolved: `Owner: cdubiel08` (not `Owner: $RALPH_GH_OWNER`)
  - [ ] PASS documented in issue #713 comment

#### Task 7.2: Test 2 — Per-phase agent model verification
- **files**: (no file changes — testing only)
- **tdd**: false
- **complexity**: low
- **depends_on**: [7.1]
- **acceptance**:
  - [ ] `@research-agent` confirms sonnet model
  - [ ] `@impl-agent` confirms opus model
  - [ ] `@pr-agent` confirms haiku model
  - [ ] PASS documented in issue #713 comment

#### Task 7.3: Test 3 — Hook agent_type discrimination
- **files**: (no file changes — testing only)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [7.1]
- **acceptance**:
  - [ ] Inside `@impl-agent`: attempt a `Write` tool call → `agent-phase-gate.sh` routes to `impl-plan-required.sh`
  - [ ] Inside `@research-agent`: attempt a `Bash` tool call → `branch-gate.sh` fires
  - [ ] PASS documented in issue #713 comment

#### Task 7.4: Test 4 — Hero end-to-end pipeline
- **files**: (no file changes — testing only)
- **tdd**: false
- **complexity**: high
- **depends_on**: [7.2, 7.3]
- **acceptance**:
  - [ ] `/ralph-hero:hero NNN` with a real issue drives at least through the research phase
  - [ ] Dispatch uses `research-agent` (not `ralph-analyst`)
  - [ ] Sonnet model used for research phase
  - [ ] MCP tool calls succeed without explicit `owner`/`repo` params
  - [ ] Research artifact path passed correctly to plan phase via natural language prompt
  - [ ] PASS documented in issue #713 comment

#### Task 7.5: Test 5 — Direct skill backward compatibility
- **files**: (no file changes — testing only)
- **tdd**: false
- **complexity**: low
- **depends_on**: [7.1]
- **acceptance**:
  - [ ] `/ralph-hero:ralph-research NNN` still works via direct RALPH_COMMAND invocation
  - [ ] Skill hooks from frontmatter fire normally
  - [ ] No double-blocking (RALPH_COMMAND set → `agent-phase-gate.sh` allows immediately)
  - [ ] PASS documented in issue #713 comment

#### Task 7.6: Test 6 — Cross-repo env var resolution
- **files**: (no file changes — testing only)
- **tdd**: false
- **complexity**: low
- **depends_on**: [7.1]
- **acceptance**:
  - [ ] From `~/projects/ralph-engine`: `claude --plugin-dir /Users/dubiel/projects/ralph-hero/plugin/ralph-hero`
  - [ ] `@research-agent` config block shows `Owner: cdubiel08`, `Repo: ralph-engine`, `Project: 7` (not ralph-hero values)
  - [ ] PASS documented in issue #713 comment

### Phase Success Criteria

#### Manual Verification:
- [ ] All 6 test scenarios pass
- [ ] All PASS outcomes documented as comments on GitHub issue #713
- [ ] No regression in direct skill invocation

---

## Integration Testing

- [ ] `cd plugin/ralph-hero/mcp-server && npm test` passes after all phases
- [ ] Hero end-to-end pipeline dispatches per-phase agents with correct models (Phase 7, Test 4)
- [ ] Direct skill invocation remains backward compatible (Phase 7, Test 5)
- [ ] Cross-repo env var resolution works correctly (Phase 7, Test 6)

## References

- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-01-GH-0674-agent-per-phase-still-needed.md
- Prior plan (GH-674): https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-03-24-GH-0674-agent-per-phase-architecture.md
- GH-707: https://github.com/cdubiel08/ralph-hero/issues/707
- GH-708: https://github.com/cdubiel08/ralph-hero/issues/708
- GH-709: https://github.com/cdubiel08/ralph-hero/issues/709
- GH-710: https://github.com/cdubiel08/ralph-hero/issues/710
- GH-711: https://github.com/cdubiel08/ralph-hero/issues/711
- GH-712: https://github.com/cdubiel08/ralph-hero/issues/712
- GH-713: https://github.com/cdubiel08/ralph-hero/issues/713
