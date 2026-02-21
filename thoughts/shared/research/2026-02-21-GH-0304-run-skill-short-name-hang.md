---
date: 2026-02-21
github_issue: 304
github_url: https://github.com/cdubiel08/ralph-hero/issues/304
status: complete
type: research
---

# GH-304: _run_skill uses short skill names causing `claude -p` to hang

## Problem Statement

When `claude -p "/ralph-triage"` is invoked, the short skill name `/ralph-triage` does not resolve to the plugin's fully-qualified skill name. This causes `claude -p` to hang waiting for input instead of executing the skill. The bug affects all LLM-powered recipes invoked via the justfile and loop scripts.

## Current State Analysis

### Affected Files

Three files use the short `/ralph-{skill}` format:

1. **[plugin/ralph-hero/justfile:284-303](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/justfile#L284-L303)** -- `_run_skill` helper
   - Builds command as `/ralph-{{skill}}` (line 288-290)
   - Called by all 8 LLM-powered recipes: triage, split, research, plan, review, impl, hygiene, status, hero, setup, report

2. **[plugin/ralph-hero/scripts/ralph-loop.sh:101-161](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/scripts/ralph-loop.sh#L101-L161)** -- Sequential loop
   - 7 hardcoded short names: `/ralph-hygiene`, `/ralph-triage`, `/ralph-split`, `/ralph-research`, `/ralph-plan`, `/ralph-review`, `/ralph-impl`
   - Plus 1 commented future reference: `/ralph-integrate`

3. **[plugin/ralph-hero/scripts/ralph-team-loop.sh:31-33](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/scripts/ralph-team-loop.sh#L31-L33)** -- Team orchestrator
   - 1 hardcoded short name: `/ralph-team`

### Skill Naming Convention

- Plugin name: `ralph-hero` (from `.claude-plugin/plugin.json`)
- Skill directories: `skills/ralph-triage/`, `skills/ralph-research/`, etc.
- Short name format: `/ralph-triage` (does not resolve in `claude -p` mode)
- Fully-qualified format: `/ralph-hero:ralph-triage` (resolves correctly)

The pattern is `/<plugin-name>:<skill-name>`, i.e., `/ralph-hero:ralph-{phase}`.

### Total Impact

- **12 skill directories** affected (ralph-hero, ralph-hygiene, ralph-impl, ralph-plan, ralph-report, ralph-research, ralph-review, ralph-setup, ralph-split, ralph-status, ralph-team, ralph-triage)
- **All justfile LLM recipes** go through `_run_skill`, so fixing that one helper fixes 8+ recipes
- **ralph-loop.sh** has 7 hardcoded invocations that bypass `_run_skill`
- **ralph-team-loop.sh** has 1 hardcoded invocation that bypasses `_run_skill`

## Root Cause

The `_run_skill` helper and loop scripts were written before the plugin was distributed as an npm package. When skills lived in the local project, short names like `/ralph-triage` resolved correctly. After the plugin was published and consumed via the plugin cache (`~/.claude/plugins/cache/ralph-hero/ralph-hero/`), `claude -p` requires the fully-qualified `/<plugin>:<skill>` format.

## Recommended Fix

### 1. Fix `_run_skill` in justfile (lines 288-290)

Change:
```bash
cmd="/ralph-{{skill}} {{issue}}"
# and
cmd="/ralph-{{skill}}"
```
To:
```bash
cmd="/ralph-hero:ralph-{{skill}} {{issue}}"
# and
cmd="/ralph-hero:ralph-{{skill}}"
```

### 2. Fix ralph-loop.sh (lines 101-161)

Replace all 7 short names with fully-qualified names:
- `/ralph-hygiene` -> `/ralph-hero:ralph-hygiene`
- `/ralph-triage` -> `/ralph-hero:ralph-triage`
- `/ralph-split` -> `/ralph-hero:ralph-split`
- `/ralph-research` -> `/ralph-hero:ralph-research`
- `/ralph-plan` -> `/ralph-hero:ralph-plan`
- `/ralph-review` -> `/ralph-hero:ralph-review`
- `/ralph-impl` -> `/ralph-hero:ralph-impl`

### 3. Fix ralph-team-loop.sh (lines 31-33)

Replace:
- `/ralph-team` -> `/ralph-hero:ralph-team`

## Risks

- **None identified**: This is a mechanical string replacement with no behavioral change. The fully-qualified format is the correct and documented way to invoke plugin skills.
- The fix is backward-compatible -- fully-qualified names always resolve correctly regardless of context.

## Estimate Validation

XS is correct. The fix is a string find-and-replace across 3 files with no logic changes.
