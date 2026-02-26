---
date: 2026-02-26
status: draft
github_issues: [411, 412, 413, 414, 415]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/411
  - https://github.com/cdubiel08/ralph-hero/issues/412
  - https://github.com/cdubiel08/ralph-hero/issues/413
  - https://github.com/cdubiel08/ralph-hero/issues/414
  - https://github.com/cdubiel08/ralph-hero/issues/415
primary_issue: 411
---

# Fix Invalid Skill Frontmatter

## Overview

All 19+ skills in the ralph-hero plugin use two invalid YAML frontmatter fields: `env:` (not recognized by Claude Code) and `allowed_tools:` (should be `allowed-tools:` with a hyphen). This means environment variables like `RALPH_COMMAND` are never set at runtime, causing hooks to silently skip enforcement. Tool restrictions may also not be applied.

## Current State Analysis

### The Problem

Claude Code skill frontmatter only supports these fields ([source](https://code.claude.com/docs/en/skills)):
- `name`, `description`, `argument-hint`, `disable-model-invocation`, `user-invocable`
- `allowed-tools` (hyphenated), `model`, `context`, `agent`, `hooks`

**Two fields used across all skills are invalid:**

1. **`env:` block** — Used in 19 skills to set `RALPH_COMMAND`, `RALPH_REQUIRED_BRANCH`, `RALPH_REQUIRES_PLAN`, `RALPH_VALID_OUTPUT_STATES`, etc. Claude Code ignores this entirely — these variables are **never set**.

2. **`allowed_tools:` (underscore)** — Used in 16 skills. The correct field name is `allowed-tools:` (hyphen). Tool restrictions may not be enforced.

### Impact

Hooks that check `RALPH_COMMAND` always get empty string:
- `impl-worktree-gate.sh:18` — `if [[ "${RALPH_COMMAND:-}" != "impl" ]]; then allow; fi` → **always skips**
- `impl-branch-gate.sh:18` — same pattern → **always skips**
- `impl-staging-gate.sh:24` — same pattern → **always skips**
- `impl-postcondition.sh:15` — same pattern → **always skips**
- `skill-precondition.sh:25-30` — blocks if RALPH_COMMAND not set → **always blocks** (but this hook may not be wired in)
- `auto-state.sh:50-52` — blocks without RALPH_COMMAND → **always blocks**

Hooks with safe defaults that **happen to work** despite the bug:
- `branch-gate.sh:19` — defaults to `main` ✓
- `impl-plan-required.sh:23` — defaults to `true` ✓
- `plan-research-required.sh:22` — defaults to `true` ✓
- All `*-state-gate.sh` scripts — hardcode correct default valid states ✓

### Key Discoveries

- `skill-precondition.sh` explicitly says "Ensure the skill frontmatter sets RALPH_COMMAND in env" — confirming the design intent was for `env:` to work
- 14 unique `RALPH_*` env vars are used across hooks
- The official env var mechanism is `CLAUDE_ENV_FILE` in `SessionStart` hooks

## Desired End State

1. All skills use `allowed-tools:` (hyphenated) — tool restrictions properly enforced
2. All `RALPH_*` environment variables are set at runtime via `SessionStart` hooks using `CLAUDE_ENV_FILE`
3. `env:` blocks removed from all skill frontmatter
4. All existing hooks work correctly with the env vars they expect
5. No behavioral regressions — skills work exactly as originally intended

### Verification

- `grep -r "allowed_tools:" plugin/ralph-hero/skills/` returns zero matches
- `grep -r "^env:" plugin/ralph-hero/skills/` returns zero matches
- Running `/ralph-hero:ralph-impl 999` with a non-existent issue triggers `skill-precondition.sh` correctly (RALPH_COMMAND is "impl")
- Running `/ralph-hero:ralph-triage` on main branch passes `branch-gate.sh` (RALPH_REQUIRED_BRANCH is "main")

## What We're NOT Doing

- Changing hook logic or behavior — hooks stay exactly as they are
- Refactoring the env var names or reducing them
- Fixing the builder/impl push responsibility conflict (separate issue)
- Adding new env vars or hooks
- Changing any skill prompt content

## Implementation Approach

Add a `SessionStart` hook to each skill that needs env vars. The hook runs a shared script that writes `export` statements to `$CLAUDE_ENV_FILE`. The script receives the env vars as arguments, keeping each skill's frontmatter as the source of truth for its configuration.

## Phase 1: Create the SessionStart env var script

### Overview
Create a single shared script that all skills call from their SessionStart hook. The script writes env var exports to `$CLAUDE_ENV_FILE`.

### Changes Required

#### 1. New script: `plugin/ralph-hero/hooks/scripts/set-skill-env.sh`

**File**: `plugin/ralph-hero/hooks/scripts/set-skill-env.sh`

```bash
#!/usr/bin/env bash
# Sets RALPH_* environment variables for a skill session.
# Called from SessionStart hooks in skill frontmatter.
#
# Usage: set-skill-env.sh KEY=VALUE [KEY=VALUE ...]
# Example: set-skill-env.sh RALPH_COMMAND=impl RALPH_REQUIRES_PLAN=true
#
# Writes export statements to $CLAUDE_ENV_FILE so variables persist
# across all subsequent Bash tool invocations in the session.

set -euo pipefail

if [[ -z "${CLAUDE_ENV_FILE:-}" ]]; then
  # Not in a SessionStart context — CLAUDE_ENV_FILE not available
  exit 0
fi

for arg in "$@"; do
  if [[ "$arg" == *=* ]]; then
    echo "export $arg" >> "$CLAUDE_ENV_FILE"
  fi
done
```

### Success Criteria

#### Automated Verification
- [ ] `test -f plugin/ralph-hero/hooks/scripts/set-skill-env.sh`
- [ ] `test -x plugin/ralph-hero/hooks/scripts/set-skill-env.sh`
- [ ] `bash -n plugin/ralph-hero/hooks/scripts/set-skill-env.sh` — no syntax errors

---

## Phase 2: Rename `allowed_tools` → `allowed-tools` across all skills

### Overview
Simple find-and-replace across 16 skill files.

### Changes Required

Rename in these 16 files:
- `skills/ralph-team/SKILL.md`
- `skills/idea-hunt/SKILL.md`
- `skills/ralph-val/SKILL.md`
- `skills/ralph-triage/SKILL.md`
- `skills/ralph-impl/SKILL.md`
- `skills/ralph-plan/SKILL.md`
- `skills/ralph-research/SKILL.md`
- `skills/ralph-review/SKILL.md`
- `skills/ralph-split/SKILL.md`
- `skills/record-demo/SKILL.md`
- `skills/ralph-hero/SKILL.md`
- `skills/iterate-plan/SKILL.md`
- `skills/research-codebase/SKILL.md`
- `skills/create-plan/SKILL.md`
- `skills/form-idea/SKILL.md`
- `skills/implement-plan/SKILL.md`

**Change**: `allowed_tools:` → `allowed-tools:`

### Success Criteria

#### Automated Verification
- [ ] `grep -r "allowed_tools:" plugin/ralph-hero/skills/` returns zero matches
- [ ] `grep -r "allowed-tools:" plugin/ralph-hero/skills/` returns 16 matches

---

## Phase 3: Replace `env:` blocks with `SessionStart` hooks

### Overview
For each skill that has an `env:` block, remove it and add a `SessionStart` hook that calls `set-skill-env.sh` with the same key-value pairs.

### Changes Required

For each skill, replace the `env:` block with a `SessionStart` hook entry. The pattern is:

**Before:**
```yaml
hooks:
  PreToolUse:
    ...
env:
  RALPH_COMMAND: "impl"
  RALPH_VALID_OUTPUT_STATES: "In Progress,In Review,Human Needed"
  RALPH_REQUIRES_PLAN: "true"
```

**After:**
```yaml
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh RALPH_COMMAND=impl RALPH_VALID_OUTPUT_STATES='In Progress,In Review,Human Needed' RALPH_REQUIRES_PLAN=true"
  PreToolUse:
    ...
```

Note: `SessionStart` should come first in the hooks block for readability, since it runs before any other hooks.

#### Complete list of env vars per skill:

| Skill | Env Vars |
|-------|----------|
| `ralph-team` | `RALPH_COMMAND=team RALPH_AUTO_APPROVE=true CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` |
| `ralph-impl` | `RALPH_COMMAND=impl RALPH_VALID_OUTPUT_STATES='In Progress,In Review,Human Needed' RALPH_REQUIRES_PLAN=true` |
| `ralph-triage` | `RALPH_COMMAND=triage RALPH_REQUIRED_BRANCH=main` |
| `ralph-research` | `RALPH_COMMAND=research RALPH_REQUIRED_BRANCH=main` |
| `ralph-plan` | `RALPH_COMMAND=plan RALPH_REQUIRED_BRANCH=main RALPH_REQUIRES_RESEARCH=true` |
| `ralph-split` | `RALPH_COMMAND=split RALPH_REQUIRED_BRANCH=main RALPH_MIN_ESTIMATE=M RALPH_MAX_SUBTICKET_ESTIMATE=S` |
| `ralph-review` | `RALPH_COMMAND=review RALPH_REQUIRED_BRANCH=main RALPH_VALID_INPUT_STATES='Plan in Review' RALPH_VALID_OUTPUT_STATES='In Progress,Ready for Plan,Human Needed' RALPH_ARTIFACT_DIR=thoughts/shared/reviews RALPH_MAX_ESTIMATE=S RALPH_REQUIRES_PLAN=true` |
| `ralph-val` | `RALPH_COMMAND=val RALPH_REQUIRES_PLAN=true` |
| `ralph-hero` | `RALPH_COMMAND=hero RALPH_AUTO_APPROVE=false` |
| `ralph-hygiene` | `RALPH_COMMAND=hygiene RALPH_REQUIRED_BRANCH=main` |
| `ralph-setup` | `RALPH_COMMAND=setup` |
| `ralph-report` | `RALPH_COMMAND=report` |
| `ralph-status` | `RALPH_COMMAND=status` |
| `idea-hunt` | `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` ⚠️ + `CLAUDE_PLUGIN_ROOT` passthrough (remove — already set) |
| `create-plan` | `RALPH_GH_OWNER`, `RALPH_GH_REPO`, `RALPH_GH_PROJECT_NUMBER` passthroughs (remove — already in settings.local.json) |
| `form-idea` | Same passthroughs as create-plan (remove) |
| `implement-plan` | Same passthroughs as create-plan (remove) |
| `iterate-plan` | Same passthroughs as create-plan (remove) |
| `research-codebase` | Same passthroughs as create-plan (remove) |

**Special cases:**

1. **`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`** (ralph-team, idea-hunt): This is a Claude Code process-level env var. `CLAUDE_ENV_FILE` only affects Bash tool invocations, not Claude Code's own feature flags. This must be set in `settings.local.json` or the system environment. Remove from skill frontmatter and document the requirement.

2. **`CLAUDE_PLUGIN_ROOT` passthrough** (ralph-team, idea-hunt): `${CLAUDE_PLUGIN_ROOT}` is already available in hook `command:` strings via template expansion. Setting it as an env var is redundant. Remove.

3. **`RALPH_GH_*` passthroughs** (create-plan, form-idea, implement-plan, iterate-plan, research-codebase): These are `${VAR}` references that just pass through existing env vars. Since they're already set in `settings.local.json`, these are no-ops. Remove entirely — no SessionStart hook needed for these skills.

For skills without existing `hooks:` blocks, add one:
```yaml
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh RALPH_COMMAND=status"
```

For skills that already have `hooks:` blocks, add `SessionStart` as the first entry.

### Success Criteria

#### Automated Verification
- [ ] `grep -r "^env:" plugin/ralph-hero/skills/` returns zero matches
- [ ] `grep -r "SessionStart" plugin/ralph-hero/skills/` returns 13 matches (skills with RALPH_* vars needing SessionStart)
- [ ] `grep -r "set-skill-env.sh" plugin/ralph-hero/skills/` returns 13 matches
- [ ] All SKILL.md files parse as valid YAML frontmatter (no syntax errors)

**Note**: 6 skills (create-plan, form-idea, implement-plan, iterate-plan, research-codebase, idea-hunt) only have passthrough env vars that are already available from settings.local.json — they just need their `env:` blocks removed, no SessionStart hook added.

---

## Phase 4: Update documentation references

### Overview
Update `skill-precondition.sh` error message and any docs that reference the `env:` pattern.

### Changes Required

#### 1. `plugin/ralph-hero/hooks/scripts/skill-precondition.sh`
**Line 30**: Change error message from "Ensure the skill frontmatter sets RALPH_COMMAND in env." to "Ensure the skill has a SessionStart hook that calls set-skill-env.sh with RALPH_COMMAND."

#### 2. `thoughts/shared/ralph-team-prompt-map.txt`
Update the env var references to reflect the new SessionStart mechanism.

### Success Criteria

#### Automated Verification
- [ ] `grep "frontmatter sets RALPH_COMMAND in env" plugin/ralph-hero/hooks/` returns zero matches

---

## Testing Strategy

### Manual Testing Steps

1. Run `/ralph-hero:ralph-triage` — verify `RALPH_COMMAND` is "triage" by checking that hooks fire correctly
2. Run `/ralph-hero:ralph-impl` on a test issue — verify:
   - `impl-worktree-gate.sh` enforces worktree requirement (no longer skips)
   - `impl-branch-gate.sh` blocks on main branch (no longer skips)
   - `impl-staging-gate.sh` enforces staging (no longer skips)
3. Verify tool restrictions work by confirming a skill with limited tools (e.g., ralph-val with no Write/Edit) doesn't offer those tools

### Risk Assessment

- **Low risk**: `allowed_tools` → `allowed-tools` rename — if Claude Code was already somehow parsing the underscore variant, this would be a no-op or improvement
- **Medium risk**: SessionStart hook mechanism — if `CLAUDE_ENV_FILE` isn't available in the skill context, env vars still won't be set. Mitigation: the script exits cleanly if `CLAUDE_ENV_FILE` is unset
- **Key concern**: `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in ralph-team — this needs to be set as an actual env var for the feature to work. If `CLAUDE_ENV_FILE` only applies to Bash tool invocations (not the Claude Code process itself), this may need to stay in `settings.local.json`. Same concern for any env var that Claude Code reads directly rather than hooks/scripts.

## References

- Official skills docs: https://code.claude.com/docs/en/skills
- Official hooks docs: https://code.claude.com/docs/en/hooks
- Prompt map: `thoughts/shared/ralph-team-prompt-map.txt`
