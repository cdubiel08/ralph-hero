---
date: 2026-02-13
status: implemented
linear_ticket: null
linear_url: null
---

# Skill Qualification & Context Management Alignment Plan

## Overview

Plugin subagents fail to invoke skills because they use unqualified names (e.g., `ralph-plan`) instead of fully qualified plugin skill names (e.g., `ralph-hero:ralph-plan`). Additionally, the workspace-level Co-Authored-By lines should be removed from commit templates, and plugin agent/skill patterns should align with the working workspace `/ralph_team` context management.

## Current State Analysis

### The Problem

The workspace-level `/ralph_team` works because:
- Agents reference skills as `ralph_plan` (underscores) matching `.claude/commands/ralph_plan.md` filenames
- These are workspace-level commands, directly resolvable by the Skill tool

The plugin's `ralph-team` skill fails because:
- Agents reference skills as `ralph-plan` (hyphens) — this matches nothing
- Plugin skills live at `plugin/ralph-hero/skills/ralph-plan/SKILL.md`
- Plugin skills require fully qualified names: `ralph-hero:ralph-plan`

### Key Discoveries

- Plugin skill directories use hyphens: `ralph-plan/`, `ralph-research/`, `ralph-triage/`, etc.
- Fully qualified format is `{plugin-name}:{skill-directory-name}` → `ralph-hero:ralph-plan`
- The ralph-team SKILL.md has 12 `Skill(skill='ralph-xxx')` invocations that need qualification
- The ralph-hero SKILL.md (solo orchestrator) has 7 `Skill(skill='ralph-xxx')` invocations
- 5 agent definitions each have 1 `Skill(skill="ralph-xxx")` invocation
- Workspace commands have Co-Authored-By lines in 5 files (8 occurrences total)

## Desired End State

1. All plugin skill invocations use fully qualified `ralph-hero:skill-name` format
2. Co-Authored-By lines removed from workspace commands
3. Plugin agent definitions align with workspace agent patterns for context management

## What We're NOT Doing

- Not changing the workspace-level `.claude/commands/` skill names (they work fine with underscores)
- Not changing the workspace-level `.claude/agents/` files (they work fine)
- Not restructuring the plugin's skill directory naming (hyphens are fine)
- Not changing MCP tool references (ralph_hero__ tools are correct for the plugin)

## Implementation Approach

Three phases: plugin skill qualification, co-author removal, and context alignment verification.

---

## Phase 1: Qualify All Plugin Skill Invocations

### Overview
Change all `Skill(skill='ralph-xxx')` to `Skill(skill='ralph-hero:ralph-xxx')` across plugin agents and skills.

### Changes Required:

#### 1. Agent Definitions (5 files)

**File**: `plugin/ralph-hero/agents/ralph-planner.md`
**Change**: Line 28 — `Skill(skill="ralph-plan", args="#NNN")` → `Skill(skill="ralph-hero:ralph-plan", args="#NNN")`

**File**: `plugin/ralph-hero/agents/ralph-triager.md`
**Change**: Line 30 — `Skill(skill="ralph-triage", args="#NNN")` → `Skill(skill="ralph-hero:ralph-triage", args="#NNN")`
**Change**: Line 35 — `Skill(skill="ralph-split", args="#NNN")` → `Skill(skill="ralph-hero:ralph-split", args="#NNN")`

**File**: `plugin/ralph-hero/agents/ralph-researcher.md`
**Change**: Line 36 — `Skill(skill="ralph-research", args="#NNN")` → `Skill(skill="ralph-hero:ralph-research", args="#NNN")`

**File**: `plugin/ralph-hero/agents/ralph-advocate.md`
**Change**: Line 31 — `Skill(skill="ralph-review", args="#NNN")` → `Skill(skill="ralph-hero:ralph-review", args="#NNN")`

**File**: `plugin/ralph-hero/agents/ralph-implementer.md`
**Change**: Line 29 — `Skill(skill="ralph-impl", args="#NNN")` → `Skill(skill="ralph-hero:ralph-impl", args="#NNN")`

#### 2. Ralph-Team SKILL.md (12 invocations in spawn prompts)

**File**: `plugin/ralph-hero/skills/ralph-team/SKILL.md`
**Changes**: All `Skill(skill='ralph-xxx'` → `Skill(skill='ralph-hero:ralph-xxx'` at lines:
- 453: `ralph-triage` → `ralph-hero:ralph-triage`
- 467: `ralph-split` → `ralph-hero:ralph-split`
- 481: `ralph-research` → `ralph-hero:ralph-research`
- 494: `ralph-plan` → `ralph-hero:ralph-plan`
- 507: `ralph-plan` → `ralph-hero:ralph-plan`
- 521: `ralph-review` → `ralph-hero:ralph-review`
- 535: `ralph-review` → `ralph-hero:ralph-review`
- 550: `ralph-impl` → `ralph-hero:ralph-impl`
- 565: `ralph-impl` → `ralph-hero:ralph-impl`
- 582: `ralph-research` → `ralph-hero:ralph-research`

#### 3. Ralph-Hero SKILL.md (solo orchestrator, 7 invocations)

**File**: `plugin/ralph-hero/skills/ralph-hero/SKILL.md`
**Changes**: All `Skill(skill='ralph-xxx'` → `Skill(skill='ralph-hero:ralph-xxx'` at lines:
- 188: `ralph-split` → `ralph-hero:ralph-split`
- 195: `ralph-split` → `ralph-hero:ralph-split`
- 232: `ralph-research` → `ralph-hero:ralph-research`
- 242: `ralph-research` → `ralph-hero:ralph-research`
- 322: `ralph-plan` → `ralph-hero:ralph-plan`
- 332: `ralph-plan` → `ralph-hero:ralph-plan`
- 365: `ralph-review` → `ralph-hero:ralph-review`
- 475: `ralph-impl` → `ralph-hero:ralph-impl`
- 490: `ralph-impl` → `ralph-hero:ralph-impl`

### Success Criteria:

#### Automated Verification:
- [ ] `grep -r "Skill(skill='ralph-" plugin/ralph-hero/ | grep -v "ralph-hero:"` returns NO results (all qualified)
- [ ] `grep -r 'Skill(skill="ralph-' plugin/ralph-hero/ | grep -v "ralph-hero:"` returns NO results (all qualified)
- [ ] `grep -rc "ralph-hero:ralph-" plugin/ralph-hero/` shows expected count (~24 occurrences)
- [ ] `npm run build` in mcp-server still passes (no code changes)

#### Manual Verification:
- [ ] Invoke `/ralph-team` with a test issue and verify the spawned planner can successfully call `Skill(skill='ralph-hero:ralph-plan')`

---

## Phase 2: Remove Co-Authored-By from Workspace Commands

### Overview
Remove all Co-Authored-By trailer lines from workspace-level command files.

### Changes Required:

**File**: `.claude/commands/ralph_plan.md`
- Remove line 363: `Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"`
- Remove line 371: `Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"`

**File**: `.claude/commands/ralph_research.md`
- Remove line 194: `Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"`

**File**: `.claude/commands/ralph_impl.md`
- Remove line 197: `Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"`
- Remove line 387: `Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"`

**File**: `.claude/commands/ralph_review.md`
- Remove line 185: `   Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>'`

**File**: `.claude/commands/ralph_hero_v1.md`
- Remove line 325: `Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"`
- Remove line 444: `   Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"`

### Success Criteria:

#### Automated Verification:
- [ ] `grep -ri "co-authored" .claude/commands/` returns NO results

---

## Phase 3: Context Management Alignment Audit

### Overview
Verify the plugin's ralph-team SKILL.md and agent definitions match the proven patterns from the workspace `/ralph_team` command. Document any remaining discrepancies.

### Comparison Points (already aligned):

| Aspect | Workspace `/ralph_team` | Plugin `ralph-team` | Status |
|--------|------------------------|---------------------|--------|
| Team naming | `ralph-team-LAN-XXX` | `ralph-team-GH-NNN` | OK (different backends) |
| Lead name | `team-lead` hardcoded | `team-lead` hardcoded | OK |
| Dispatch loop | Section 4.4 | Section 4.4 | OK (identical structure) |
| Lifecycle hooks | TaskCompleted + TeammateIdle | TaskCompleted + TeammateIdle | OK |
| Spawn prompt structure | Includes ticket context, skill invocation, SendMessage | Same structure | OK |
| Skill invocation | `Skill(skill='ralph_plan')` | `Skill(skill='ralph-hero:ralph-plan')` (after Phase 1) | OK after fix |

### Remaining Discrepancy to Fix:

The plugin's agent definition for `ralph-planner.md` references `/ralph-plan` with slash notation in prose text. Update these prose references to use the plugin notation consistently.

**Files**: All 5 agent definitions + ralph-team SKILL.md
**Change**: Update prose references like "invoke the `/ralph-plan` skill" to "invoke the `ralph-hero:ralph-plan` skill" for consistency. Only change the `Skill()` invocations and human-readable skill name references — do NOT change user-facing messages like "Run /ralph-plan first" (those are instructions for the end user who may have the workspace commands available).

### Success Criteria:

#### Automated Verification:
- [ ] Diff the plugin's ralph-team SKILL.md sections against workspace `/ralph_team` to confirm structural alignment

#### Manual Verification:
- [ ] Run a full `/ralph-team` session with a test issue through at least the research → plan phases to verify end-to-end skill invocation works

---

## Testing Strategy

### Unit Tests:
- No code changes to MCP server, existing tests remain valid

### Integration Testing:
1. Invoke `/ralph-team NNN` with a GitHub issue
2. Verify the triager/researcher/planner/reviewer/implementer agents all successfully call their respective `ralph-hero:*` skills
3. Verify the dispatch loop correctly advances between phases

## References

- Plugin agents: `plugin/ralph-hero/agents/*.md`
- Plugin skills: `plugin/ralph-hero/skills/*/SKILL.md`
- Workspace commands: `.claude/commands/ralph_*.md`
- Workspace agents: `.claude/agents/ralph-*.md`
