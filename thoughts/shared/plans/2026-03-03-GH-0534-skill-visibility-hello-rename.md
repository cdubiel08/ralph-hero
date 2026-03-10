---
date: 2026-03-03
status: draft
type: plan
github_issues: [534]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/534
primary_issue: 534
---

# Skill Visibility & Rename Cleanup

## Overview

Restructure Ralph Hero plugin: rename 12 user-facing skills to shorter names, hide 12 internal pipeline skills from the `/` menu via `user-invocable: false`, and update all cross-references. The justfile CLI (`ralph triage`, `ralph loop`, etc.) continues working.

## Current State Analysis

All 24 skills are user-invocable (visible in `/` menu). Users see a wall of `/ralph-hero:ralph-*` and `/ralph-hero:*-idea` commands. Most `ralph-*` skills are internal pipeline skills invoked by agents and scripts.

Claude Code supports `user-invocable: false` in SKILL.md frontmatter. This hides the skill from the `/` menu but Claude can still invoke it via the Skill tool, `claude -p`, and other skills.

### Key Discoveries:
- justfile `_run_skill` helper at `justfile:343` auto-prepends `ralph-` to skill names — needs updating
- `ralph-team-loop.sh:45-47` hardcodes `/ralph-hero:ralph-team` — needs updating
- MCP server `index.ts:63,96,240` references `/ralph-setup` in error messages — needs updating
- 6 SKILL.md files cross-reference other user-facing skills by old names
- `team-shutdown-validator.sh` uses `ralph-team` in report file glob patterns — leave as-is (report naming convention is separate from skill naming)
- Shell completions (`ralph-completions.bash/zsh`) are dynamic (read from justfile) — no changes needed

## Desired End State

### User-Visible Skills (12) — short, clean names in `/` menu:

| New Name | Old Name | Purpose |
|----------|----------|---------|
| `hello` | `ralph-hello` | Session briefing |
| `draft` | `draft-idea` | Quick idea capture |
| `form` | `form-idea` | Crystallize idea into ticket |
| `plan` | `create-plan` | Interactive implementation planning |
| `iterate` | `iterate-plan` | Refine existing plan |
| `impl` | `implement-plan` | Execute plan phase-by-phase |
| `research` | `research-codebase` | Interactive codebase research |
| `team` | `ralph-team` | Spawn agent team |
| `hero` | `ralph-hero` | Tree-expansion orchestrator |
| `setup` | `ralph-setup` | One-time project setup |
| `status` | `ralph-status` | Pipeline dashboard |
| `report` | `ralph-report` | Generate status report |

### Hidden Skills (12) — `user-invocable: false`, unchanged names:

| Skill | Invoked By |
|-------|-----------|
| `ralph-triage` | ralph-loop.sh, ralph-analyst agent |
| `ralph-split` | ralph-loop.sh, ralph-analyst agent |
| `ralph-research` | ralph-loop.sh, ralph-analyst agent |
| `ralph-plan` | ralph-loop.sh, ralph-analyst agent |
| `ralph-review` | ralph-loop.sh, ralph-builder agent |
| `ralph-impl` | ralph-loop.sh, ralph-builder agent |
| `ralph-hygiene` | ralph-loop.sh |
| `ralph-pr` | ralph-integrator agent |
| `ralph-merge` | ralph-integrator agent |
| `ralph-val` | ralph-integrator agent |
| `record-demo` | available via CLI |
| `idea-hunt` | available via CLI |

### CLI behavior after changes:

```bash
# Justfile recipes still work (dispatch to hidden skills)
ralph triage 42    # -> /ralph-hero:ralph-triage 42
ralph loop         # -> ralph-loop.sh (uses hidden ralph-* skills)

# User-visible skills via / menu
/ralph-hero:hello
/ralph-hero:draft
/ralph-hero:plan
/ralph-hero:team

# Justfile recipes for renamed skills
ralph team 42      # -> /ralph-hero:team 42
ralph hero 42      # -> /ralph-hero:hero 42
ralph status       # -> /ralph-hero:status
ralph setup        # -> /ralph-hero:setup
```

## What We're NOT Doing

- Not renaming hidden pipeline skills (`ralph-triage`, `ralph-impl`, etc.)
- Not changing agent definitions (agents invoke hidden `ralph-*` skills which keep their names)
- Not changing `ralph-loop.sh` (it invokes hidden skills which keep their names)
- Not changing report naming convention (`ralph-team-*.md` patterns in hooks/specs)
- Not changing skill behavior/content, only names and visibility

## Implementation Approach

Four phases: (1) rename directories, (2) add visibility flags, (3) update cross-references in skills and scripts, (4) update specs and docs.

---

## Phase 1: Rename 12 Skill Directories

### Overview
Rename all user-facing skill directories to their new short names.

### Changes Required:

```bash
cd plugin/ralph-hero/skills
mv ralph-hello    hello
mv draft-idea     draft
mv form-idea      form
mv create-plan    plan
mv iterate-plan   iterate
mv implement-plan impl
mv research-codebase research
mv ralph-team     team
mv ralph-hero     hero
mv ralph-setup    setup
mv ralph-status   status
mv ralph-report   report
```

### Success Criteria:

#### Automated Verification:
- [x] All 12 new directories exist:
  ```bash
  for d in hello draft form plan iterate impl research team hero setup status report; do
    test -d "plugin/ralph-hero/skills/$d" || echo "MISSING: $d"
  done
  ```
- [x] All 12 old directories are gone:
  ```bash
  for d in ralph-hello draft-idea form-idea create-plan iterate-plan implement-plan research-codebase ralph-team ralph-hero ralph-setup ralph-status ralph-report; do
    test -d "plugin/ralph-hero/skills/$d" && echo "STILL EXISTS: $d"
  done
  ```

---

## Phase 2: Add `user-invocable: false` to Hidden Skills

### Overview
Add `user-invocable: false` to the YAML frontmatter of 12 hidden skill files.

### Changes Required:

Insert `user-invocable: false` after the `description` line in each file:

**Files** (10 pipeline + 2 non-pipeline):
- `plugin/ralph-hero/skills/ralph-triage/SKILL.md`
- `plugin/ralph-hero/skills/ralph-split/SKILL.md`
- `plugin/ralph-hero/skills/ralph-research/SKILL.md`
- `plugin/ralph-hero/skills/ralph-plan/SKILL.md`
- `plugin/ralph-hero/skills/ralph-review/SKILL.md`
- `plugin/ralph-hero/skills/ralph-impl/SKILL.md`
- `plugin/ralph-hero/skills/ralph-hygiene/SKILL.md`
- `plugin/ralph-hero/skills/ralph-pr/SKILL.md`
- `plugin/ralph-hero/skills/ralph-merge/SKILL.md`
- `plugin/ralph-hero/skills/ralph-val/SKILL.md`
- `plugin/ralph-hero/skills/record-demo/SKILL.md`
- `plugin/ralph-hero/skills/idea-hunt/SKILL.md`

Example for `ralph-triage/SKILL.md`:
```yaml
---
description: Triage GitHub issues from backlog...
user-invocable: false
argument-hint: [optional-issue-number]
...
```

### Success Criteria:

#### Automated Verification:
- [x] All 12 hidden skills have the flag:
  ```bash
  for d in ralph-triage ralph-split ralph-research ralph-plan ralph-review ralph-impl ralph-hygiene ralph-pr ralph-merge ralph-val record-demo idea-hunt; do
    grep -q 'user-invocable: false' "plugin/ralph-hero/skills/$d/SKILL.md" || echo "MISSING: $d"
  done
  ```
- [x] No visible skill has the flag:
  ```bash
  for d in hello draft form plan iterate impl research team hero setup status report; do
    grep -q 'user-invocable: false' "plugin/ralph-hero/skills/$d/SKILL.md" && echo "WRONGLY HIDDEN: $d"
  done
  ```

---

## Phase 3: Update Cross-References in Skills and Scripts

### Overview
Update all `/ralph-hero:old-name` references to `/ralph-hero:new-name` across SKILL.md files, justfile, and shell scripts.

### Changes Required:

#### 1. Skill Cross-References (6 SKILL.md files)

**`skills/draft/SKILL.md`** (was `draft-idea`):
- `description:` field: `/ralph-hero:form-idea` -> `/ralph-hero:form`
- `/ralph-hero:form-idea` -> `/ralph-hero:form` (lines ~112, 120, 123, 124)
- `/ralph-hero:research-codebase` -> `/ralph-hero:research` (lines ~113, 120)
- `/ralph-hero:create-plan` -> `/ralph-hero:plan` (line ~114)

**`skills/form/SKILL.md`** (was `form-idea`):
- `/ralph-hero:form-idea` -> `/ralph-hero:form` (lines ~38-40, 283)
- `/ralph-hero:create-plan` -> `/ralph-hero:plan` (lines ~122, 190, 249, 259)
- `/ralph-hero:research-codebase` -> `/ralph-hero:research` (lines ~123, 250, 259)
- `/ralph-hero:iterate-plan` -> `/ralph-hero:iterate` (line ~191)

**`skills/plan/SKILL.md`** (was `create-plan`):
- `/ralph-hero:create-plan` -> `/ralph-hero:plan` (lines ~42-43)
- `/ralph-hero:implement-plan` -> `/ralph-hero:impl` (line ~361)

**`skills/iterate/SKILL.md`** (was `iterate-plan`):
- `/ralph-hero:create-plan` -> `/ralph-hero:plan` (line ~51)
- `/ralph-hero:iterate-plan` -> `/ralph-hero:iterate` (lines ~92-93, 258)
- `/ralph-hero:implement-plan` -> `/ralph-hero:impl` (line ~259)

**`skills/impl/SKILL.md`** (was `implement-plan`):
- `/ralph-hero:create-plan` -> `/ralph-hero:plan` (line ~39)
- `/ralph-hero:iterate-plan` -> `/ralph-hero:iterate` (line ~211)

**`skills/setup/SKILL.md`** (was `ralph-setup`):
- `/ralph-setup` -> `/ralph-hero:setup` (lines ~47, 167, 523, 579)

**Note**: `skills/hello/SKILL.md` and `skills/hero/SKILL.md` reference hidden `ralph-*` skills which keep their names — no changes needed.

#### 2. Justfile `_run_skill` Helper

**File**: `plugin/ralph-hero/justfile`

Change `_run_skill` to accept the full skill name (stop auto-prepending `ralph-`):

```bash
# Before (justfile:347):
cmd="/ralph-hero:ralph-{{skill}} {{issue}}"
# ...
cmd="/ralph-hero:ralph-{{skill}}"

# After:
cmd="/ralph-hero:{{skill}} {{issue}}"
# ...
cmd="/ralph-hero:{{skill}}"
```

Update all recipe callers to pass full skill names:

```just
# Pipeline recipes (hidden skills — add ralph- prefix in caller)
triage:   @just _run_skill "ralph-triage" ...
split:    @just _run_skill "ralph-split" ...
research: @just _run_skill "ralph-research" ...
plan:     @just _run_skill "ralph-plan" ...
review:   @just _run_skill "ralph-review" ...
impl:     @just _run_skill "ralph-impl" ...
hygiene:  @just _run_skill "ralph-hygiene" ...

# Renamed skills (new short names)
status:   @just _run_skill "status" ...
type: plan
report:   @just _run_skill "report" ...
setup:    @just _run_skill "setup" ...
hero:     @just _run_skill "hero" ...
```

#### 3. `ralph-team-loop.sh`

**File**: `plugin/ralph-hero/scripts/ralph-team-loop.sh`

```bash
# Before (lines 45, 47):
COMMAND="/ralph-hero:ralph-team $ISSUE_NUMBER"
COMMAND="/ralph-hero:ralph-team"

# After:
COMMAND="/ralph-hero:team $ISSUE_NUMBER"
COMMAND="/ralph-hero:team"
```

#### 4. MCP Server Error Messages

**File**: `plugin/ralph-hero/mcp-server/src/index.ts`

```typescript
// Lines 63, 96, 240: Update help text
// Before:
"Run /ralph-setup to configure..."
// After:
"Run /ralph-hero:setup to configure..."
```

### Success Criteria:

#### Automated Verification:
- [x] No old skill names in visible SKILL.md cross-references:
  ```bash
  grep -r 'ralph-hero:draft-idea\|ralph-hero:form-idea\|ralph-hero:create-plan\|ralph-hero:iterate-plan\|ralph-hero:implement-plan\|ralph-hero:research-codebase' plugin/ralph-hero/skills/{draft,form,plan,iterate,impl,research,hello,hero,setup,status,report,team}/ && echo "OLD REFS FOUND" || echo "OK"
  ```
- [x] No old skill names in justfile dispatch:
  ```bash
  grep 'ralph-hero:ralph-team\|ralph-hero:ralph-hero\|ralph-hero:ralph-setup\|ralph-hero:ralph-status\|ralph-hero:ralph-report' plugin/ralph-hero/justfile && echo "OLD REFS FOUND" || echo "OK"
  ```
- [x] ralph-team-loop.sh updated:
  ```bash
  grep -q 'ralph-hero:team' plugin/ralph-hero/scripts/ralph-team-loop.sh || echo "NOT UPDATED"
  ```
- [x] MCP server updated:
  ```bash
  grep -q 'ralph-hero:setup' plugin/ralph-hero/mcp-server/src/index.ts || echo "NOT UPDATED"
  ```
- [x] Build passes: `cd plugin/ralph-hero/mcp-server && npm run build`

#### Manual Verification:
- [ ] `just triage` dispatches correctly to `/ralph-hero:ralph-triage`
- [ ] `just status` dispatches correctly to `/ralph-hero:status`
- [ ] `just hero 42` dispatches correctly to `/ralph-hero:hero 42`

**Implementation Note**: After completing this phase and all automated verification passes, pause for manual confirmation before proceeding.

---

## Phase 4: Update Specs and Documentation

### Overview
Update spec files and documentation to reflect new skill names.

### Changes Required:

#### 1. `specs/skill-io-contracts.md`

Rename skills in the contracts table (lines 55-61):

| Old | New |
|-----|-----|
| `ralph-hero` | `hero` |
| `ralph-team` | `team` |
| `ralph-status` | `status` |
| `ralph-report` | `report` |
| `ralph-setup` | `setup` |
| `ralph-hello` | `hello` |

#### 2. `specs/skill-permissions.md`

Rename skills in the permissions table (lines 50-53, 57-60):

| Old | New |
|-----|-----|
| `ralph-status` | `status` |
| `ralph-report` | `report` |
| `ralph-setup` | `setup` |

#### 3. `specs/team-schema.md`

No changes needed — references `ralph-team` in the context of report naming convention, which stays as-is.

#### 4. `plugin/ralph-hero/README.md`

Update skill name references in feature tables and directory listings.

#### 5. `CLAUDE.md`

No changes needed — only references script names (`ralph-loop.sh`, `ralph-team-loop.sh`) and generic skill patterns, not specific user-facing skill names.

### Success Criteria:

#### Automated Verification:
- [x] Specs updated:
  ```bash
  grep -q '| .hello.' specs/skill-io-contracts.md || echo "MISSING: hello"
  grep -q '| .hero.' specs/skill-io-contracts.md || echo "MISSING: hero"
  grep -q '| .team.' specs/skill-io-contracts.md || echo "MISSING: team"
  grep -q '| .status.' specs/skill-io-contracts.md || echo "MISSING: status"
  grep -q '| .report.' specs/skill-io-contracts.md || echo "MISSING: report"
  grep -q '| .setup.' specs/skill-io-contracts.md || echo "MISSING: setup"
  ```
- [x] No stale old names in specs:
  ```bash
  grep 'ralph-hello\|ralph-status\|ralph-report\|ralph-setup' specs/skill-io-contracts.md specs/skill-permissions.md && echo "STALE REFS" || echo "OK"
  ```

---

## Testing Strategy

### Smoke Tests:
1. Hidden skill via CLI: `just triage` — dispatches to `/ralph-hero:ralph-triage`
2. Renamed skill via CLI: `just status` — dispatches to `/ralph-hero:status`
3. Renamed skill via CLI: `just hero 42` — dispatches to `/ralph-hero:hero 42`
4. Team loop: `./scripts/ralph-team-loop.sh` — dispatches to `/ralph-hero:team`
5. Autonomous loop: `./scripts/ralph-loop.sh --triage-only` — dispatches to hidden skills
6. `/` menu: only 12 short-named skills appear

### Edge Cases:
- Agent skill invocation: agents call hidden `ralph-*` skills — unchanged, should work
- `set-skill-env.sh` RALPH_COMMAND values — unchanged (e.g., `RALPH_COMMAND=team`)
- Report file naming (`ralph-team-*.md`) — unchanged, hook validation still passes

## References

- Claude Code skill docs: `user-invocable` field controls `/` menu visibility
- `plugin/ralph-hero/justfile:342-369` — `_run_skill` helper
- `plugin/ralph-hero/scripts/cli-dispatch.sh` — CLI dispatch (generic, no changes)
- `plugin/ralph-hero/scripts/ralph-team-loop.sh:45-47` — team dispatch
- `plugin/ralph-hero/mcp-server/src/index.ts:63,96,240` — setup references
- Original issue: #534
