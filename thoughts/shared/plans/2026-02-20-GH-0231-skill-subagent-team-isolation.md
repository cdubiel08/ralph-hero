---
date: 2026-02-20
status: draft
github_issues: [231]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/231
primary_issue: 231
---

# Skill Sub-Agent Team Isolation - Implementation Plan

## Overview

Single issue implementing prompt-level fixes to prevent skill-internal sub-agents from inheriting team context and polluting the team roster.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-231 | bug: ralph-research skill spawns internal sub-agents into team context, polluting team roster | S |

## Current State Analysis

When the `ralph-team` orchestrator spawns a worker with `team_name`, and that worker invokes a skill (e.g., `ralph-research`), the skill's internal `Task()` calls for sub-agents (`codebase-locator`, `codebase-analyzer`, etc.) inherit the parent's team context. These sub-agents enroll as phantom teammates, generating unrecognizable idle notifications that flood the team lead.

Five skills are affected:
1. **ralph-research** ([`skills/ralph-research/SKILL.md:76-81`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-research/SKILL.md#L76-L81)) -- Step 3 sub-task spawning
2. **ralph-plan** ([`skills/ralph-plan/SKILL.md:127-128`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-plan/SKILL.md#L127-L128)) -- Step 2 sub-task spawning
3. **ralph-split** ([`skills/ralph-split/SKILL.md:50,159-161`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-split/SKILL.md#L50)) -- Steps 1 and 3 sub-task spawning
4. **ralph-triage** ([`skills/ralph-triage/SKILL.md:104`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-triage/SKILL.md#L104)) -- Step 2 sub-task spawning
5. **ralph-review** ([`skills/ralph-review/SKILL.md:183,195`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-review/SKILL.md#L183)) -- Step 3B delegated critique and nested sub-agent

The root cause is that `context: fork` isolates the context window but does NOT isolate the team session environment. Team membership propagates through the fork implicitly.

## Desired End State

### Verification
- [x] `shared/conventions.md` contains a "Sub-Agent Team Isolation" section documenting the rule
- [x] All 5 affected SKILL.md files contain inline reminders near their `Task()` call examples
- [x] No `team_name` parameter appears in any internal `Task()` call within SKILL.md files (already the case -- the fix is adding explicit instructions to NEVER add it)
- [x] The inline reminders reference the conventions.md section for full rationale

## What We're NOT Doing

- Not modifying the MCP server or TypeScript code (this is a prompt-level fix only)
- Not changing how `ralph-team` spawns workers (that is GH-230 scope)
- Not adding hook-based enforcement (no postcondition hook can detect this class of behavioral issue, per prior research on GH-53)
- Not modifying `ralph-impl` (it does not spawn internal sub-agents via `Task()`)
- Not modifying `ralph-hero` orchestrator (it does not run inside a team context)

## Implementation Approach

This is a single-phase change touching 6 markdown files. The approach is "Approach C" from the research: combined inline reminders in each SKILL.md plus a centralized rule in `shared/conventions.md` (defense in depth).

---

## Phase 1: GH-231 - Add team isolation rules to conventions and affected skills

> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/231 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0231-skill-subagent-team-context-pollution.md

### Changes Required

#### 1. Add "Sub-Agent Team Isolation" section to conventions.md
**File**: [`plugin/ralph-hero/skills/shared/conventions.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/shared/conventions.md)
**Location**: After the "Skill Invocation Convention" section (after line 282), before "Artifact Comment Protocol"
**Changes**: Add a new `## Sub-Agent Team Isolation` section with:
- The rule: Never pass `team_name` to internal `Task()` calls within skills
- The rationale: Team context propagates through `context: fork`, causing sub-agents to enroll as phantom teammates
- Example of correct vs incorrect usage

```markdown
## Sub-Agent Team Isolation

Skills that spawn internal sub-agents via `Task()` (e.g., `codebase-locator`, `codebase-analyzer`, `codebase-pattern-finder`) must ensure those sub-agents do NOT inherit team context.

**Rule**: Never pass `team_name` to internal `Task()` calls within skills. Sub-agents are utility workers that return results to the skill -- they are not team members.

**Why**: When a skill runs inside a team worker's session (via `ralph-team`), the `context: fork` setting isolates the context window but does NOT isolate the team session environment. If internal `Task()` calls inherit team context, sub-agents enroll as phantom teammates, generating idle notifications that flood the team lead.

**Correct**:
```
Task(subagent_type="codebase-locator", prompt="Find files related to ...")
Task(subagent_type="codebase-analyzer", prompt="Analyze component ...")
```

**Incorrect**:
```
Task(subagent_type="codebase-locator", team_name=TEAM_NAME, prompt="Find files related to ...")
```

This applies to all skills that spawn internal sub-agents: ralph-research, ralph-plan, ralph-split, ralph-triage, and ralph-review. See individual SKILL.md files for inline reminders.
```

#### 2. Add inline reminder to ralph-research SKILL.md
**File**: [`plugin/ralph-hero/skills/ralph-research/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-research/SKILL.md)
**Location**: Step 3, after line 81 (after the sub-agent list, before "Wait for ALL sub-tasks")
**Changes**: Insert a callout block:

```markdown
> **Team Isolation**: Do NOT pass `team_name` to these sub-agent `Task()` calls. Sub-agents must run outside any team context. See [shared/conventions.md](../shared/conventions.md#sub-agent-team-isolation).
```

#### 3. Add inline reminder to ralph-plan SKILL.md
**File**: [`plugin/ralph-hero/skills/ralph-plan/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-plan/SKILL.md)
**Location**: Step 2 item 3, after line 128 (after the `Task()` examples)
**Changes**: Insert a callout block:

```markdown
> **Team Isolation**: Do NOT pass `team_name` to these sub-agent `Task()` calls. Sub-agents must run outside any team context. See [shared/conventions.md](../shared/conventions.md#sub-agent-team-isolation).
```

#### 4. Add inline reminders to ralph-split SKILL.md
**File**: [`plugin/ralph-hero/skills/ralph-split/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-split/SKILL.md)
**Location 1**: Step 1, after line 50 (after the `Task()` example for finding candidates)
**Location 2**: Step 3, after line 162 (after the `Task()` examples for scope research)
**Changes**: Insert a callout block at each location:

```markdown
> **Team Isolation**: Do NOT pass `team_name` to these sub-agent `Task()` calls. Sub-agents must run outside any team context. See [shared/conventions.md](../shared/conventions.md#sub-agent-team-isolation).
```

#### 5. Add inline reminder to ralph-triage SKILL.md
**File**: [`plugin/ralph-hero/skills/ralph-triage/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-triage/SKILL.md)
**Location**: Step 2, after line 104 (after the `Task()` example for codebase search)
**Changes**: Insert a callout block:

```markdown
> **Team Isolation**: Do NOT pass `team_name` to these sub-agent `Task()` calls. Sub-agents must run outside any team context. See [shared/conventions.md](../shared/conventions.md#sub-agent-team-isolation).
```

#### 6. Add inline reminder to ralph-review SKILL.md
**File**: [`plugin/ralph-hero/skills/ralph-review/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-review/SKILL.md)
**Location**: Step 3B, after line 221 (after the delegated critique `Task()` call, which itself contains a nested `Task()` call to `codebase-analyzer`)
**Changes**: Insert a callout block:

```markdown
> **Team Isolation**: Do NOT pass `team_name` to this critique `Task()` call or any sub-agent `Task()` calls within it. Sub-agents must run outside any team context. See [shared/conventions.md](../shared/conventions.md#sub-agent-team-isolation).
```

### Success Criteria

- [x] Automated: `grep -r "Sub-Agent Team Isolation" plugin/ralph-hero/skills/` returns 6 matches (1 in conventions.md, 5 in SKILL.md files)
- [x] Automated: `grep -r "team_name" plugin/ralph-hero/skills/ralph-research/SKILL.md plugin/ralph-hero/skills/ralph-plan/SKILL.md plugin/ralph-hero/skills/ralph-split/SKILL.md plugin/ralph-hero/skills/ralph-triage/SKILL.md plugin/ralph-hero/skills/ralph-review/SKILL.md` returns only the "Do NOT pass `team_name`" instruction lines (no actual `team_name` parameter usage)
- [x] Manual: Read each modified file and verify the callout is positioned immediately after the relevant `Task()` examples
- [x] Manual: Verify conventions.md section includes correct/incorrect examples

---

## Integration Testing

- [x] Run `npm test` in mcp-server to confirm no TypeScript changes were accidentally introduced
- [x] Verify `git diff --stat` shows exactly 6 files changed, all `.md` files under `plugin/ralph-hero/skills/`
- [x] Verify no changes to files outside `plugin/ralph-hero/skills/` (except plan/research docs in `thoughts/`)

## References

- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0231-skill-subagent-team-context-pollution.md
- Parent issue: https://github.com/cdubiel08/ralph-hero/issues/230 (Redesign ralph-team worker architecture)
- Related research (GH-53): Prior finding that postcondition hooks cannot detect this class of behavioral issue
