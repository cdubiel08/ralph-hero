---
date: 2026-04-02
status: draft
type: plan
github_issue: 716
github_issues: [716]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/716
primary_issue: 716
parent_plan: thoughts/shared/plans/2026-04-02-GH-0714-skill-mcp-tool-name-fix.md
tags: [skills, mcp, tool-names, bug-fix, frontmatter]
---

# Update allowed-tools Frontmatter to Fully-Qualified MCP Tool Names - Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-04-02-GH-0714-skill-mcp-tool-name-fix]]
- builds_on:: [[2026-04-01-skill-mcp-tool-name-mismatch]]

## Overview

1 issue — mechanical replacement of short-form `ralph_hero__*` entries in `allowed-tools` YAML frontmatter arrays with fully-qualified `mcp__plugin_ralph-hero_ralph-github__ralph_hero__*` names across 26 affected skills, plus fixing one bare `knowledge_record_outcome` entry in `ralph-postmortem`.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-716 | Update allowed-tools frontmatter to fully-qualified MCP tool names across 26 skills | S |

## Shared Constraints

Inherited from parent plan `2026-04-02-GH-0714-skill-mcp-tool-name-fix.md`:

- All skill files live at `plugin/ralph-hero/skills/{skill-name}/SKILL.md`
- Do NOT change built-in tool names (Read, Write, Bash, Glob, Grep, Task, Agent, etc.)
- Do NOT change ralph-knowledge tools that already use fully-qualified long form (in `hero`, `ralph-plan-epic`, `prove-claim`)
- Do NOT change hook `matcher:` fields — hooks receive the short name in their JSON payload
- Do NOT change MCP server registration names (`ralph_hero__*` prefix in server code stays)
- Do NOT change agent definitions in `plugin/ralph-hero/agents/` — already correct
- Changes are limited to `allowed-tools:` frontmatter arrays only in this phase (Phase 2 / issue #717 handles inline body rewrites)

## Current State Analysis

26 skills use short-form `ralph_hero__*` names in `allowed-tools` frontmatter. These names match the MCP server registration names (layer 1) but not the deferred tool names that ToolSearch indexes (layer 3). ToolSearch looks for `mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue` but skills declare `ralph_hero__get_issue` — no match, MCP tools silently skip.

Additionally, `ralph-postmortem` lists `knowledge_record_outcome` as a bare name (neither short form nor long form) in `allowed-tools` — a third broken variant.

Three skills (`prove-claim`, `hero`, `ralph-plan-epic`) already have correctly formed `mcp__plugin_ralph-knowledge_ralph-knowledge__*` entries for knowledge tools. These must not be touched.

## Desired End State

Every `allowed-tools:` array entry that previously read `ralph_hero__*` now reads `mcp__plugin_ralph-hero_ralph-github__ralph_hero__*`. The `ralph-postmortem` bare knowledge entry is also updated.

### Verification
- [x] `grep -rn "^  - ralph_hero__" plugin/ralph-hero/skills/` returns zero matches
- [x] `grep -rn "^  - knowledge_" plugin/ralph-hero/skills/` returns zero matches
- [x] `grep -rn "mcp__plugin_ralph-hero_ralph-github__ralph_hero__" plugin/ralph-hero/skills/` returns 75+ matches
- [ ] Every edited SKILL.md is valid YAML frontmatter (no parse errors when invoked)
- [ ] Manual: invoke `/ralph-hero:status` in a fresh session and confirm MCP tool resolves via ToolSearch

## What We're NOT Doing

- Not touching inline body text tool references (Phase 2 / issue #717)
- Not creating new tools or changing tool behavior
- Not changing hook `matcher:` fields
- Not changing MCP server registration code
- Not updating `specs/skill-permissions.md` (informational only)

## Implementation Approach

Single phase: iterate through the 26 skill files (plus `ralph-postmortem`'s knowledge entry) and apply the exact string substitutions from the tool name mapping table. Each edit is mechanical — no logic or judgment required. The edit scope is strictly the `allowed-tools:` YAML block in each SKILL.md frontmatter.

---

## Phase 1: Replace short-form tool names in allowed-tools frontmatter
- **depends_on**: null

### Overview

Read each of the 26 skill SKILL.md files and replace every `ralph_hero__*` value in the `allowed-tools:` array with its fully-qualified equivalent. Also fix the bare `knowledge_record_outcome` entry in `ralph-postmortem`.

### Tool Name Mapping

Apply these substitutions to every `allowed-tools` entry (frontmatter only):

| Short form | Fully-qualified form |
|-----------|----------------------|
| `ralph_hero__get_issue` | `mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue` |
| `ralph_hero__list_issues` | `mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_issues` |
| `ralph_hero__create_issue` | `mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_issue` |
| `ralph_hero__save_issue` | `mcp__plugin_ralph-hero_ralph-github__ralph_hero__save_issue` |
| `ralph_hero__create_comment` | `mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_comment` |
| `ralph_hero__add_sub_issue` | `mcp__plugin_ralph-hero_ralph-github__ralph_hero__add_sub_issue` |
| `ralph_hero__list_sub_issues` | `mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_sub_issues` |
| `ralph_hero__add_dependency` | `mcp__plugin_ralph-hero_ralph-github__ralph_hero__add_dependency` |
| `ralph_hero__remove_dependency` | `mcp__plugin_ralph-hero_ralph-github__ralph_hero__remove_dependency` |
| `ralph_hero__list_dependencies` | `mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_dependencies` |
| `ralph_hero__advance_issue` | `mcp__plugin_ralph-hero_ralph-github__ralph_hero__advance_issue` |
| `ralph_hero__decompose_feature` | `mcp__plugin_ralph-hero_ralph-github__ralph_hero__decompose_feature` |
| `ralph_hero__detect_stream_positions` | `mcp__plugin_ralph-hero_ralph-github__ralph_hero__detect_stream_positions` |
| `ralph_hero__pick_actionable_issue` | `mcp__plugin_ralph-hero_ralph-github__ralph_hero__pick_actionable_issue` |
| `ralph_hero__pipeline_dashboard` | `mcp__plugin_ralph-hero_ralph-github__ralph_hero__pipeline_dashboard` |
| `ralph_hero__project_hygiene` | `mcp__plugin_ralph-hero_ralph-github__ralph_hero__project_hygiene` |
| `ralph_hero__archive_items` | `mcp__plugin_ralph-hero_ralph-github__ralph_hero__archive_items` |
| `ralph_hero__create_status_update` | `mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_status_update` |
| `ralph_hero__health_check` | `mcp__plugin_ralph-hero_ralph-github__ralph_hero__health_check` |
| `ralph_hero__get_project` | `mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_project` |
| `ralph_hero__setup_project` | `mcp__plugin_ralph-hero_ralph-github__ralph_hero__setup_project` |
| `ralph_hero__sync_plan_graph` | `mcp__plugin_ralph-hero_ralph-github__ralph_hero__sync_plan_graph` |
| `knowledge_record_outcome` (bare, in ralph-postmortem only) | `mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_record_outcome` |

### Tasks

#### Task 1.1: Update bridge-artifact, form, hello, hero, impl, iterate SKILL.md files
- **files**: `plugin/ralph-hero/skills/bridge-artifact/SKILL.md` (modify), `plugin/ralph-hero/skills/form/SKILL.md` (modify), `plugin/ralph-hero/skills/hello/SKILL.md` (modify), `plugin/ralph-hero/skills/hero/SKILL.md` (modify), `plugin/ralph-hero/skills/impl/SKILL.md` (modify), `plugin/ralph-hero/skills/iterate/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] No line matching `^  - ralph_hero__` in any of these 6 files
  - [ ] All `ralph_hero__*` entries in `allowed-tools:` replaced with `mcp__plugin_ralph-hero_ralph-github__ralph_hero__*` equivalent
  - [ ] Built-in tools (Read, Write, Bash, etc.) unchanged
  - [ ] YAML frontmatter structure intact (no indentation breaks)

#### Task 1.2: Update plan, ralph-hygiene, ralph-impl, ralph-merge, ralph-plan, ralph-plan-epic SKILL.md files
- **files**: `plugin/ralph-hero/skills/plan/SKILL.md` (modify), `plugin/ralph-hero/skills/ralph-hygiene/SKILL.md` (modify), `plugin/ralph-hero/skills/ralph-impl/SKILL.md` (modify), `plugin/ralph-hero/skills/ralph-merge/SKILL.md` (modify), `plugin/ralph-hero/skills/ralph-plan/SKILL.md` (modify), `plugin/ralph-hero/skills/ralph-plan-epic/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] No line matching `^  - ralph_hero__` in any of these 6 files
  - [ ] All `ralph_hero__*` entries in `allowed-tools:` replaced with fully-qualified equivalents
  - [ ] Existing correct long-form `mcp__plugin_ralph-knowledge_ralph-knowledge__*` entries in `hero` and `ralph-plan-epic` left untouched
  - [ ] YAML frontmatter structure intact

#### Task 1.3: Update ralph-postmortem, ralph-pr, ralph-research, ralph-review, ralph-split, ralph-triage SKILL.md files (includes bare knowledge fix)
- **files**: `plugin/ralph-hero/skills/ralph-postmortem/SKILL.md` (modify), `plugin/ralph-hero/skills/ralph-pr/SKILL.md` (modify), `plugin/ralph-hero/skills/ralph-research/SKILL.md` (modify), `plugin/ralph-hero/skills/ralph-review/SKILL.md` (modify), `plugin/ralph-hero/skills/ralph-split/SKILL.md` (modify), `plugin/ralph-hero/skills/ralph-triage/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] No line matching `^  - ralph_hero__` in any of these 6 files
  - [ ] `ralph-postmortem` bare `knowledge_record_outcome` entry replaced with `mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_record_outcome`
  - [ ] All other `ralph_hero__*` entries replaced with fully-qualified equivalents
  - [ ] YAML frontmatter structure intact

#### Task 1.4: Update ralph-val, record-demo, report, research, setup, setup-repos, status, team SKILL.md files
- **files**: `plugin/ralph-hero/skills/ralph-val/SKILL.md` (modify), `plugin/ralph-hero/skills/record-demo/SKILL.md` (modify), `plugin/ralph-hero/skills/report/SKILL.md` (modify), `plugin/ralph-hero/skills/research/SKILL.md` (modify), `plugin/ralph-hero/skills/setup/SKILL.md` (modify), `plugin/ralph-hero/skills/setup-repos/SKILL.md` (modify), `plugin/ralph-hero/skills/status/SKILL.md` (modify), `plugin/ralph-hero/skills/team/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] No line matching `^  - ralph_hero__` in any of these 8 files
  - [ ] All `ralph_hero__*` entries in `allowed-tools:` replaced with fully-qualified equivalents
  - [ ] YAML frontmatter structure intact

#### Task 1.5: Run automated verification and confirm zero short-form entries remain
- **files**: (read-only grep verification, no file modifications)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1, 1.2, 1.3, 1.4]
- **acceptance**:
  - [ ] `grep -rn "^  - ralph_hero__" plugin/ralph-hero/skills/` returns zero matches
  - [ ] `grep -rn "^  - knowledge_" plugin/ralph-hero/skills/` returns zero matches
  - [ ] `grep -rn "mcp__plugin_ralph-hero_ralph-github__ralph_hero__" plugin/ralph-hero/skills/` returns 75+ matches
  - [ ] `grep -rn "mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_record_outcome" plugin/ralph-hero/skills/ralph-postmortem/SKILL.md` returns 1 match

### Phase Success Criteria

#### Automated Verification:
- [x] `grep -rn "^  - ralph_hero__" plugin/ralph-hero/skills/` — zero matches
- [x] `grep -rn "^  - knowledge_" plugin/ralph-hero/skills/` — zero matches
- [x] `grep -rn "mcp__plugin_ralph-hero_ralph-github__ralph_hero__" plugin/ralph-hero/skills/` — 75+ matches

#### Manual Verification:
- [ ] Invoke `/ralph-hero:status` in a fresh Claude Code session and confirm the pipeline dashboard MCP tool resolves via ToolSearch (no "tool not found" errors)

**Creates for next phase**: Clean frontmatter that uses fully-qualified names. Phase 2 (issue #717) can then proceed to rewrite inline body text references knowing the permission gate is correct.

---

## Integration Testing

- [ ] Invoke `/ralph-hero:plan` with a valid issue number in a fresh session — confirm `get_issue`, `list_issues`, `save_issue`, and `create_comment` all resolve correctly
- [ ] Invoke `/ralph-hero:status` in a fresh session — confirm `pipeline_dashboard` resolves
- [ ] Invoke `/ralph-hero:research` with a question — confirm `list_issues` or `get_issue` is callable

## References

- Parent plan: [thoughts/shared/plans/2026-04-02-GH-0714-skill-mcp-tool-name-fix.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-04-02-GH-0714-skill-mcp-tool-name-fix.md)
- Research: [thoughts/shared/research/2026-04-01-skill-mcp-tool-name-mismatch.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-01-skill-mcp-tool-name-mismatch.md)
- Parent issue: [#714](https://github.com/cdubiel08/ralph-hero/issues/714)
- This issue: [#716](https://github.com/cdubiel08/ralph-hero/issues/716)
- Sibling issue (Phase 2): [#717](https://github.com/cdubiel08/ralph-hero/issues/717)
- Agent pattern reference: `plugin/ralph-hero/agents/ralph-analyst.md` (correct fully-qualified names)
