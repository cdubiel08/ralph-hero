---
date: 2026-03-19
status: draft
type: plan
tags: [skills, hero, context-mode, fix]
---

# Port Hello Skill Fix to Hero Skill

## Prior Work

- builds_on:: commit `7488ef4` — "fix(hello): switch to inline context so AskUserQuestion works (#603)"

## Overview

The hello skill was fixed by switching from `context: fork` to `context: inline`, removing `model: sonnet`, removing hooks, and adding `AskUserQuestion`. Hero needs the same class of fix but must retain its hooks because `RALPH_COMMAND=hero` is required by `skill-precondition.sh` to allow MCP tool calls.

## Current State Analysis

**hero/SKILL.md frontmatter (broken):**
```yaml
model: sonnet              # forces model — likely spawns subprocess like fork
allowed-tools: [...]       # missing AskUserQuestion
hooks:                     # SessionStart sets RALPH_COMMAND=hero; PreToolUse validates tasks
```

No `context:` field (defaults to inline), but `model: sonnet` may cause subprocess behavior that breaks interactive tool access.

**hello/SKILL.md frontmatter (working, post-fix):**
```yaml
context: inline            # explicit inline
allowed-tools:             # includes AskUserQuestion
  - AskUserQuestion
  - ...
```

No `model:`, no `hooks:`.

### Key Constraint

Hero's `hooks.SessionStart` sets `RALPH_COMMAND=hero` via `set-skill-env.sh`. This is **critical** — `skill-precondition.sh` hard-blocks `ralph_hero__get_issue` and `ralph_hero__list_issues` if unset. Hero calls `get_issue` in Step 1 before any sub-skills. The hooks block must be retained.

## What We're NOT Doing

- Removing the hooks block (hero depends on RALPH_COMMAND being set)
- Changing the skill body/logic
- Modifying any other skills

## Implementation Approach

Apply the hello changes that are safe for hero: add explicit `context: inline`, remove `model: sonnet`, add `AskUserQuestion` to allowed-tools. Keep the hooks block intact.

## Phase 1: Update Hero Skill Frontmatter

### Changes Required:

**File**: `plugin/ralph-hero/skills/hero/SKILL.md`

1. Add `context: inline` after `argument-hint`
2. Remove `model: sonnet`
3. Add `AskUserQuestion` to `allowed-tools`

**Before:**
```yaml
---
description: ...
argument-hint: <issue-number>
model: sonnet
allowed-tools:
  - Read
  - Write
  ...
hooks:
  SessionStart: ...
  PreToolUse: ...
---
```

**After:**
```yaml
---
description: ...
argument-hint: <issue-number>
context: inline
allowed-tools:
  - Read
  - Write
  ...
  - AskUserQuestion
hooks:
  SessionStart: ...
  PreToolUse: ...
---
```

### Success Criteria:

#### Automated Verification:
- [ ] `grep -c "context: inline" plugin/ralph-hero/skills/hero/SKILL.md` returns 1
- [ ] `grep -c "model:" plugin/ralph-hero/skills/hero/SKILL.md` returns 0
- [ ] `grep -c "AskUserQuestion" plugin/ralph-hero/skills/hero/SKILL.md` returns 1
- [ ] Hooks block still present: `grep -c "SessionStart" plugin/ralph-hero/skills/hero/SKILL.md` returns 1

#### Manual Verification:
- [ ] `/ralph-hero:hero` invocation works — can reach Step 1 and call MCP tools
- [ ] Interactive prompts (e.g., "Would you like to process this issue?") function correctly

## Testing Strategy

### Manual Testing Steps:
1. Invoke `/ralph-hero:hero` without an issue number — verify it can call `pick_actionable_issue` and present interactive choice
2. Invoke `/ralph-hero:hero 123` with a known issue — verify it reaches pipeline detection and calls `get_issue`
