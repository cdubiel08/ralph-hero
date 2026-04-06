---
date: 2026-04-05
status: implemented
type: plan
tags: [skills, env-vars, backtick-resolution, review-gates, prompt-injection]
---

# Env Var Backtick Resolution + Review Gate Redesign

## Prior Work

- builds_on:: direct codebase analysis of all 26 SKILL.md files

## Overview

Two intertwined problems:

1. **Unresolved env vars**: Several skills reference `RALPH_*` variables in prompt conditionals without backtick resolution. Claude sees variable names, not values.
2. **Confusing review gate semantics**: `RALPH_REVIEW_MODE` and `RALPH_AUTO_APPROVE` have overlapping, unclear responsibilities.

This plan fixes both: resolve all behavioral env vars via backtick preprocessing, rename and clarify the two review gates into distinct concerns.

## Current State Analysis

### Env var resolution bug (5 skills, 7 variables):
```markdown
#### REVIEW tasks (if RALPH_REVIEW_MODE == "auto")
```
Claude sees this literal string. It cannot evaluate the conditional.

### Confusing gate overlap:
- `RALPH_REVIEW_MODE` — controls automated review-agent dispatch AND post-impl human review (overloaded)
- `RALPH_AUTO_APPROVE` — documented in hero config table but no branching logic exists in the body
- `RALPH_INTERACTIVE` — ralph-review mode switch, only set externally by `ralph-loop.sh`

### Key Discoveries:
- `hero/SKILL.md:74,80,344` — `RALPH_REVIEW_MODE` unresolved in state machine and task dispatch
- `hero/SKILL.md:462` — `RALPH_AUTO_APPROVE` documented, no branching logic
- `ralph-review/SKILL.md:71` — `RALPH_INTERACTIVE` unresolved mode switch
- `ralph-hygiene/SKILL.md:78-79,108` — `RALPH_HYGIENE_THRESHOLD` and `RALPH_HYGIENE_DRY_RUN` unresolved
- `ralph-split/SKILL.md:11` — sets `RALPH_MAX_SUBTICKET_ESTIMATE`, hook reads `RALPH_VALID_SUB_ESTIMATES` (name mismatch)
- `ralph-loop.sh:54,79,199,201` — sets `RALPH_REVIEW_MODE` and `RALPH_INTERACTIVE` for child processes
- `team/SKILL.md:28` — sets `RALPH_AUTO_APPROVE=true` via SessionStart hook
- Escalation prose already exists via shared fragment `escalation-steps.md` (architecture decisions, security, scope concerns)

## Desired End State

Two clearly scoped review gates with distinct names and responsibilities:

| Variable | Controls | Default for `/hero` | Default for `/plan` | Values |
|----------|----------|---------------------|---------------------|--------|
| `RALPH_REVIEW_PLAN` | Plan approval gate — who reviews the plan before implementation | `auto` (review-agent critiques, advances on approval, iterates or escalates on rejection) | `interactive` (human reviews inline) | `auto`, `interactive` |
| `RALPH_REVIEW_MODE` | Merge gate — whether the pipeline stops at PR or auto-merges | `interactive` (stop at PR, human must request merge) | N/A (plan skill doesn't merge) | `interactive`, `auto` |

**Natural stopping points:**
1. Plan approval — human input or automated review-agent gate
2. PR creation — human ensures code is read before merge
3. Out-of-bounds escalation — prose-driven, intentionally gray (architecture changes, service account needs, scope mismatch)

All behavioral env vars resolved via backtick preprocessing. Claude branches on concrete resolved values, never exposes variable names to user.

## What We're NOT Doing

- Changing URL template patterns (`$RALPH_GH_OWNER/$RALPH_GH_REPO`) — Claude interpolates from config section
- Changing the `set-skill-env.sh` → `CLAUDE_ENV_FILE` pipeline for hook-consumed variables
- Adding new hooks for these gates — prose branching in skills is sufficient
- Modifying escalation protocol — existing shared fragment covers out-of-bounds cases

## Implementation Approach

Rename variables, add backtick resolution, rewrite conditionals as natural prose. Update all consumers: hero, ralph-review, ralph-hygiene, ralph-split, ralph-loop.sh, team.

---

## Phase 1: Hero Skill — RALPH_REVIEW_PLAN + RALPH_REVIEW_MODE Redesign

### Overview
Rename `RALPH_AUTO_APPROVE` → `RALPH_REVIEW_PLAN`. Repurpose `RALPH_REVIEW_MODE` as merge gate. Resolve both via backtick. Rewrite state machine and dispatch logic.

### Changes Required:

#### 1. Resolve variables in config section
**File**: `plugin/ralph-hero/skills/hero/SKILL.md`
**Lines**: 33-39

```markdown
## Configuration (resolved at load time)

- Owner: !`echo ${RALPH_GH_OWNER:-NOT_SET}`
- Repo: !`echo ${RALPH_GH_REPO:-NOT_SET}`
- Project: !`echo ${RALPH_GH_PROJECT_NUMBER:-NOT_SET}`
- Plan review: !`echo ${RALPH_REVIEW_PLAN:-auto}`
- Merge review: !`echo ${RALPH_REVIEW_MODE:-interactive}`

Use these resolved values when constructing GitHub URLs or referencing the repository.
```

#### 2. Rewrite state machine diagram
**File**: `plugin/ralph-hero/skills/hero/SKILL.md`
**Lines**: 57-89

Replace the state machine to reflect the new gate semantics:

```
+-------------------------------------------------------------------+
|                     RALPH HERO STATE MACHINE                       |
+-------------------------------------------------------------------+
|  START                                                             |
|    |                                                               |
|    v                                                               |
|  ANALYZE ROOT                                                      |
|    |                                                               |
|    v                                                               |
|  ANALYST PHASE                                                     |
|    |- SPLIT (if M/L/XL) -- loop until all XS/S                    |
|    |- RESEARCH (parallel) -- all "Research Needed" leaves          |
|    | all "Ready for Plan"                                          |
|    v                                                               |
|  BUILDER PHASE                                                     |
|    |- PLAN (per group) -- create implementation plans              |
|    |- PLAN REVIEW GATE                                             |
|    |   | plan review is "auto":                                    |
|    |   |   review-agent critiques plan                             |
|    |   |   APPROVED -> report plan location, advance, continue     |
|    |   |   NEEDS_ITERATION -> return critique to planner           |
|    |   |   ESCALATE -> move to Human Needed, STOP                  |
|    |   | plan review is "interactive":                              |
|    |   |   report plan location, ask human for approval            |
|    |   |   APPROVED -> advance, continue                           |
|    |   |   REJECTED -> STOP                                        |
|    |- IMPLEMENT (sequential) -- execute plan phases                |
|    |- PR (per issue)                                               |
|    v                                                               |
|  MERGE GATE                                                        |
|    | merge review is "interactive" (default):                      |
|    |   report PR URLs, STOP -- human must request merge            |
|    | merge review is "auto":                                       |
|    |   proceed to finish (validate, merge, CI watch)               |
|    v                                                               |
|  INTEGRATOR PHASE                                                  |
|    |- Finish GH-[PRIMARY] (validate, merge, CI watch)              |
|    |- via Skill("ralph-hero:finish", args="NNN")                   |
|    v                                                               |
|  COMPLETE                                                          |
+-------------------------------------------------------------------+
```

#### 3. Rewrite PLAN REVIEW GATE dispatch section
**File**: `plugin/ralph-hero/skills/hero/SKILL.md`
**Lines**: 344-375

Replace the separate "REVIEW tasks" and "HUMAN GATE tasks" sections with a unified plan review gate:

```markdown
#### PLAN REVIEW GATE

After all plans are created, review them based on the resolved plan review mode.

**When plan review is "auto":**

Dispatch the review-agent for each plan. Always pass `--review-plan` with the resolved value. Include the plan document path if available from the completed plan task's metadata:

```
Skill("ralph-hero:ralph-review", args="NNN --review-plan auto --plan-doc thoughts/shared/plans/...")
```

Route based on review-agent verdict:
- **ALL APPROVED** → Report plan locations and state transitions to the user. Batch update all group issues to "In Progress". Continue to implementation.
- **NEEDS_ITERATION** → Return the critique to the planner for revision. Re-dispatch planning, then re-review. Max 2 iterations before escalating to Human Needed.
- **ESCALATE** → The review-agent flagged something beyond automated resolution (architecture decisions, permissions, scope concerns). Move issues to Human Needed and STOP with the critique.

**When plan review is "interactive":**

Report planned groups with plan URLs and state transitions. All issues are in "Plan in Review".

Use AskUserQuestion to offer inline approval:
```
AskUserQuestion(
  questions=[{
    "question": "Plans are ready for review. How would you like to proceed?",
    "header": "Plan Approval",
    "options": [
      {"label": "Approve and implement", "description": "Move all issues to In Progress and begin implementation immediately"},
      {"label": "Open plan in editor", "description": "Review the plan document in your default editor, then decide"},
      {"label": "Stop here", "description": "Review plans in GitHub and re-run /hero later"}
    ],
    "multiSelect": false
  }]
)
```

Route based on response:
- **"Approve and implement"**: Batch update all group issues to "In Progress", continue to implementation.
- **"Open plan in editor"**: Open the plan file with `open` (macOS) or `xdg-open` (Linux), then re-present the same picker.
- **"Stop here"**: STOP with: plan URL, issue numbers, and re-run command.
```

#### 4. Update ALL Skill() dispatch examples to include --review-plan
**File**: `plugin/ralph-hero/skills/hero/SKILL.md`

Every `Skill()` call to a child that accepts `--review-plan` must include it. Update the existing dispatch examples:

```
# PLAN dispatches (lines ~327-341):
Skill("ralph-hero:ralph-plan-epic", args="NNN --review-plan auto --research-doc ...")
Skill("ralph-hero:ralph-plan", args="NNN --review-plan auto --research-doc ...")
Skill("ralph-hero:ralph-plan", args="NNN --review-plan auto")
Skill("ralph-hero:ralph-plan", args="[PRIMARY] --review-plan auto --research-doc {path}")

# REVIEW dispatch (line ~349) — already updated above

# Other dispatches (split, research, impl, pr, finish) do NOT need --review-plan
```

The `hero-dispatch-gate.sh` hook (Phase 2) will block any dispatch that omits this arg.

#### 5. Add MERGE GATE section
**File**: `plugin/ralph-hero/skills/hero/SKILL.md`

After the PR tasks section (around line 407) and before the INTEGRATOR PHASE section, add the merge gate:

```markdown
#### MERGE GATE

After all PRs are created, check the resolved merge review mode.

**When merge review is "interactive" (default):**

Report all PR URLs and issue numbers. Present a clear summary of what was implemented and where to review.

STOP here. The human must review the code and explicitly request merge — either by re-running `/ralph-hero:finish NNN` or by merging the PR manually.

**When merge review is "auto":**

Proceed directly to finish. The pipeline trusts the automated control plane (validation, code review gate in ralph-merge, CI checks) to catch issues.
```

#### 6. Update env vars documentation table
**File**: `plugin/ralph-hero/skills/hero/SKILL.md`
**Lines**: 460-466

Replace the old table:

```markdown
## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `RALPH_REVIEW_PLAN` | `auto` | Plan review: `auto` (review-agent), `interactive` (human approval) |
| `RALPH_REVIEW_MODE` | `interactive` | Merge review: `interactive` (stop at PR), `auto` (trust control plane) |
| `RALPH_COMMAND` | `hero` | Command identifier for hooks |
| `RALPH_GH_OWNER` | required | GitHub repository owner |
| `RALPH_GH_REPO` | required | GitHub repository name |
| `RALPH_GH_PROJECT_NUMBER` | required | GitHub Projects V2 project number |
```

### Success Criteria:

#### Automated Verification:
- [x] `grep -c 'RALPH_AUTO_APPROVE' plugin/ralph-hero/skills/hero/SKILL.md` returns 0
- [x] `grep -c 'RALPH_REVIEW_MODE ==' plugin/ralph-hero/skills/hero/SKILL.md` returns 0
- [x] `grep 'RALPH_REVIEW_PLAN' plugin/ralph-hero/skills/hero/SKILL.md` shows backtick resolution line + config table

#### Manual Verification:
- [ ] Config section resolves to concrete values (e.g., `Plan review: auto`)
- [ ] With `RALPH_REVIEW_PLAN=auto`, hero dispatches review-agent, reports plan location on approval
- [ ] With `RALPH_REVIEW_PLAN=interactive`, hero stops for human plan approval
- [ ] With `RALPH_REVIEW_MODE=interactive` (default), hero stops at PR with summary
- [ ] With `RALPH_REVIEW_MODE=auto`, hero proceeds through finish

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation.

---

## Phase 2: Hook Enforcement — Arg Propagation + Gate Compliance

### Overview
Two new hook scripts enforce the review gate contract at both ends:
1. **`hero-dispatch-gate.sh`** — PreToolUse on `Skill` in the hero skill. Ensures hero always passes `--review-plan` when dispatching child skills that need it.
2. **`review-plan-gate.sh`** — PreToolUse on `AskUserQuestion` in child skills. Blocks human prompts when `RALPH_REVIEW_PLAN=auto`, and blocks state advances without human approval when `RALPH_REVIEW_PLAN=interactive`.

### Changes Required:

#### 1. Create hero-dispatch-gate.sh
**File**: `plugin/ralph-hero/hooks/scripts/hero-dispatch-gate.sh` (new)

```bash
#!/bin/bash
# PreToolUse:Skill — Ensures hero passes --review-plan to child skills
set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

read_input > /dev/null

# Only applies when RALPH_COMMAND=hero
[[ "${RALPH_COMMAND:-}" == "hero" ]] || { allow; }

tool_input=$(get_tool_input)
skill_name=$(echo "$tool_input" | jq -r '.skill // empty')
args=$(echo "$tool_input" | jq -r '.args // empty')

# Skills that need --review-plan context
case "$skill_name" in
  ralph-hero:ralph-plan|ralph-hero:ralph-plan-epic|ralph-hero:ralph-review)
    if ! echo "$args" | grep -q -- '--review-plan'; then
      block "Hero dispatch gate: $skill_name requires --review-plan argument.

Add --review-plan to the Skill() args, e.g.:
  Skill(\"$skill_name\", args=\"NNN --review-plan auto\")"
    fi
    ;;
esac

allow
```

#### 2. Create review-plan-gate.sh
**File**: `plugin/ralph-hero/hooks/scripts/review-plan-gate.sh` (new)

```bash
#!/bin/bash
# PreToolUse:AskUserQuestion — Blocks human prompts when RALPH_REVIEW_PLAN=auto
set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

read_input > /dev/null

review_plan="${RALPH_REVIEW_PLAN:-}"

# If not set, allow (skill hasn't declared a review plan mode)
[[ -n "$review_plan" ]] || { allow; }

if [[ "$review_plan" == "auto" ]]; then
  block "Review plan gate: RALPH_REVIEW_PLAN=auto — use automated review, not human prompts.

If this is an escalation (architecture, permissions, scope), use the escalation protocol instead:
  ralph_hero__save_issue(number=N, workflowState=\"__ESCALATE__\", command=\"...\")

If you need to report results to the user, use text output instead of AskUserQuestion."
fi

allow
```

#### 3. Add hooks to hero skill frontmatter
**File**: `plugin/ralph-hero/skills/hero/SKILL.md`

The hero skill currently has no `hooks:` block. Add one:

```yaml
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh RALPH_COMMAND=hero"
  PreToolUse:
    - matcher: "Skill"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/hero-dispatch-gate.sh"
```

This also fixes the existing gap where `RALPH_COMMAND=hero` was documented but never set.

#### 4. Add review-plan-gate to child skills that have plan review context
**File**: `plugin/ralph-hero/skills/ralph-plan/SKILL.md` — add to existing PreToolUse hooks:
```yaml
    - matcher: "AskUserQuestion"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/review-plan-gate.sh"
```

**File**: `plugin/ralph-hero/skills/ralph-review/SKILL.md` — add to existing PreToolUse hooks:
```yaml
    - matcher: "AskUserQuestion"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/review-plan-gate.sh"
```

**File**: `plugin/ralph-hero/skills/plan/SKILL.md` — no hooks block currently. Add:
```yaml
hooks:
  PreToolUse:
    - matcher: "AskUserQuestion"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/review-plan-gate.sh"
```

#### 5. Update child skill prompts to parse --review-plan and export

Each child skill that accepts `--review-plan` needs prompt instructions to parse and export it. Add to the argument parsing section of each:

**ralph-plan, ralph-plan-epic, ralph-review**:
```markdown
If `--review-plan` is provided in args, export it to persist for hooks:
```bash
export RALPH_REVIEW_PLAN=<value>
```
This overrides the load-time default. If not provided, the backtick-resolved default applies.
```

### Precedence (enforced by hooks):

```
1. --review-plan arg from caller    → Claude exports to CLAUDE_ENV_FILE
2. RALPH_REVIEW_PLAN in settings    → resolved at load time via backtick
3. Skill default in backtick        → ${RALPH_REVIEW_PLAN:-auto} or :-interactive
                                      ↓
                            review-plan-gate.sh reads final value
                            hero-dispatch-gate.sh ensures arg is passed
```

### Success Criteria:

#### Automated Verification:
- [x] `hero-dispatch-gate.sh` exists and is executable
- [x] `review-plan-gate.sh` exists and is executable
- [x] Hero skill has `hooks:` block with SessionStart and PreToolUse:Skill
- [x] `grep 'review-plan-gate' plugin/ralph-hero/skills/ralph-plan/SKILL.md` returns match
- [x] `grep 'review-plan-gate' plugin/ralph-hero/skills/ralph-review/SKILL.md` returns match

#### Manual Verification:
- [ ] Hero dispatching `ralph-plan` without `--review-plan` is blocked by hook
- [ ] `AskUserQuestion` in auto mode is blocked by review-plan-gate
- [ ] `AskUserQuestion` in interactive mode is allowed

**Implementation Note**: Pause after this phase for manual confirmation.

---

## Phase 3: Ralph-Review Skill — Simplify Mode Detection

### Overview
The ralph-review skill has its own `RALPH_INTERACTIVE` variable for mode switching. Align it with the new `RALPH_REVIEW_PLAN` semantics. When hero dispatches ralph-review, it's always in AUTO mode. When invoked interactively, the `--interactive` flag or `RALPH_REVIEW_PLAN=interactive` triggers interactive mode.

### Changes Required:

#### 1. Resolve variable in config section
**File**: `plugin/ralph-hero/skills/ralph-review/SKILL.md`
**Lines**: 51-57

```markdown
## Configuration (resolved at load time)

- Owner: !`echo ${RALPH_GH_OWNER:-NOT_SET}`
- Repo: !`echo ${RALPH_GH_REPO:-NOT_SET}`
- Project: !`echo ${RALPH_GH_PROJECT_NUMBER:-NOT_SET}`
- Plan review mode: !`echo ${RALPH_REVIEW_PLAN:-auto}`

Use these resolved values when constructing GitHub URLs or referencing the repository.
```

#### 2. Rewrite mode detection
**File**: `plugin/ralph-hero/skills/ralph-review/SKILL.md`
**Lines**: 68-77

```markdown
### Step 1: Detect Execution Mode

Parse arguments for mode flag:
- If `--interactive` flag present OR plan review mode is "interactive" → INTERACTIVE mode
- Otherwise → AUTO mode

Report mode:
```
Starting ralph-review in [INTERACTIVE/AUTO] mode
```
```

#### 3. Update review-postcondition.sh
**File**: `plugin/ralph-hero/hooks/scripts/review-postcondition.sh`
**Line**: 16

Change `RALPH_INTERACTIVE` to `RALPH_REVIEW_PLAN`:
```bash
INTERACTIVE="${RALPH_REVIEW_PLAN:-auto}"
# Then change the check: if [[ "$INTERACTIVE" == "interactive" ]]; then ...
```

### Success Criteria:

#### Automated Verification:
- [x] `grep -c 'RALPH_INTERACTIVE' plugin/ralph-hero/skills/ralph-review/SKILL.md` returns 0
- [x] `grep 'RALPH_REVIEW_PLAN' plugin/ralph-hero/skills/ralph-review/SKILL.md` shows backtick line

#### Manual Verification:
- [ ] Review skill enters AUTO mode by default
- [ ] Review skill enters INTERACTIVE mode with `--interactive` flag

**Implementation Note**: Pause after this phase for manual confirmation.

---

## Phase 4: Update Consumers — team skill, ralph-loop.sh, settings

### Overview
Rename `RALPH_AUTO_APPROVE` → `RALPH_REVIEW_PLAN` and `RALPH_INTERACTIVE` → `RALPH_REVIEW_PLAN` in all consumers.

### Changes Required:

#### 1. Team skill SessionStart
**File**: `plugin/ralph-hero/skills/team/SKILL.md`
**Line**: 28

Change:
```
RALPH_AUTO_APPROVE=true
```
To:
```
RALPH_REVIEW_PLAN=auto
```

(Team mode uses auto plan review — review-agent critiques, no human gate.)

#### 2. ralph-loop.sh
**File**: `plugin/ralph-hero/scripts/ralph-loop.sh`

- **Line 54**: Change `REVIEW_MODE="${RALPH_REVIEW_MODE:-skip}"` → `REVIEW_MODE="${RALPH_REVIEW_MODE:-interactive}"`
  (Default changes from `skip` to `interactive` — stop at PR by default)
- **Line 79**: Keep `export RALPH_REVIEW_MODE="$REVIEW_MODE"` (same var name, new default)
- **Line 199**: Change `export RALPH_INTERACTIVE="true"` → `export RALPH_REVIEW_PLAN="interactive"`
- **Line 201**: Change `export RALPH_INTERACTIVE="false"` → `export RALPH_REVIEW_PLAN="auto"`

#### 3. User's settings.local.json
**File**: `.claude/settings.local.json`

Change:
```json
"RALPH_REVIEW_MODE": "auto"
```
To:
```json
"RALPH_REVIEW_MODE": "auto",
"RALPH_REVIEW_PLAN": "auto"
```

(User currently has `RALPH_REVIEW_MODE=auto` meaning they trust the merge pipeline. Add `RALPH_REVIEW_PLAN=auto` to preserve current behavior where review-agent handles plans.)

### Success Criteria:

#### Automated Verification:
- [x] `grep -rc 'RALPH_AUTO_APPROVE' plugin/ralph-hero/` returns 0
- [x] `grep -rc 'RALPH_INTERACTIVE' plugin/ralph-hero/` returns 0

#### Manual Verification:
- [ ] ralph-loop.sh correctly exports the renamed variables

**Implementation Note**: Pause after this phase for manual confirmation.

---

## Phase 5: Ralph-Hygiene — Resolve Threshold + Dry Run

### Overview
Resolve the two configuration variables that control archiving behavior.

### Changes Required:

#### 1. Resolve variables in config section
**File**: `plugin/ralph-hero/skills/ralph-hygiene/SKILL.md`
**Lines**: 25-30

Replace the static config table with resolved values:

```markdown
## Configuration (resolved at load time)

- Hygiene threshold: !`echo ${RALPH_HYGIENE_THRESHOLD:-10}`
- Dry run: !`echo ${RALPH_HYGIENE_DRY_RUN:-true}`
```

#### 2. Rewrite Step 4 to use resolved values
**File**: `plugin/ralph-hero/skills/ralph-hygiene/SKILL.md`
**Lines**: 75-89

```markdown
### Step 4: Auto-Archive (If Configured)

Use the resolved configuration above to determine behavior.

**If dry run is "true"** (default): Report what would be archived. Do not call any archive tools.

**If dry run is "false" AND eligible count exceeds the hygiene threshold**:
1. Check if the archive_items tool is available.
2. If available, call it with the eligible workflow states and threshold.
3. If NOT available, output:
   ```
   Auto-archive requires the archive_items tool.
   ```
```

#### 3. Rewrite constraints
**File**: `plugin/ralph-hero/skills/ralph-hygiene/SKILL.md`
**Line**: 108

Change to: `- Only archives when dry run is "false"`

### Success Criteria:

#### Automated Verification:
- [x] `grep -c 'RALPH_HYGIENE_' plugin/ralph-hero/skills/ralph-hygiene/SKILL.md` — only backtick lines remain

---

## Phase 6: Fix ralph-split Orphaned Variable Name

### Overview
`ralph-split` SessionStart sets `RALPH_MAX_SUBTICKET_ESTIMATE=S`, but `split-size-gate.sh` reads `RALPH_VALID_SUB_ESTIMATES`.

### Changes Required:

#### 1. Fix variable name in SessionStart hook
**File**: `plugin/ralph-hero/skills/ralph-split/SKILL.md`
**Line**: 11

Change `RALPH_MAX_SUBTICKET_ESTIMATE=S` to `RALPH_VALID_SUB_ESTIMATES='XS,S'`.

### Success Criteria:

#### Automated Verification:
- [x] `grep 'RALPH_MAX_SUBTICKET_ESTIMATE' plugin/ralph-hero/skills/ralph-split/SKILL.md` returns 0
- [x] `grep 'RALPH_VALID_SUB_ESTIMATES' plugin/ralph-hero/skills/ralph-split/SKILL.md` returns match

---

## Phase 7: Plan Skill — Resolve RALPH_REVIEW_PLAN for Behavior Toggle

### Overview
The interactive `/plan` skill defaults to `RALPH_REVIEW_PLAN=interactive` (human reviews plan inline). But if a user overrides to `auto`, the plan skill should skip the review step and immediately link to GitHub + advance state.

### Changes Required:

#### 1. Resolve variable in config section
**File**: `plugin/ralph-hero/skills/plan/SKILL.md`
**Lines**: 24-29

Add the plan review mode:

```markdown
## Configuration (resolved at load time)

- Owner: !`echo ${RALPH_GH_OWNER:-NOT_SET}`
- Repo: !`echo ${RALPH_GH_REPO:-NOT_SET}`
- Project: !`echo ${RALPH_GH_PROJECT_NUMBER:-NOT_SET}`
- Plan review: !`echo ${RALPH_REVIEW_PLAN:-interactive}`

Use these resolved values when constructing GitHub URLs or referencing the repository.
```

Note: default is `interactive` for the plan skill (opposite of hero's `auto` default).

#### 2. Add conditional to Step 5 (Review)
**File**: `plugin/ralph-hero/skills/plan/SKILL.md`

In the Review step, add a conditional at the top:

```markdown
### Step 5: Review

If plan review is "auto", skip human review — proceed directly to Step 6 (GitHub Integration) with the plan as-is. Report the plan location but do not ask for feedback.

Otherwise (plan review is "interactive", the default), present the draft for human review:
```

Then the existing review flow continues unchanged.

### Success Criteria:

#### Automated Verification:
- [x] `grep 'RALPH_REVIEW_PLAN' plugin/ralph-hero/skills/plan/SKILL.md` shows backtick line

#### Manual Verification:
- [ ] `/plan` with default config stops for human review
- [ ] `/plan` with `RALPH_REVIEW_PLAN=auto` skips review, links to GitHub directly

---

## Testing Strategy

### Smoke test all affected skills:
1. Load each skill and verify config section resolves (no `NOT_SET` or `${` literals)
2. Verify conditional sections reference resolved values, not variable names
3. Verify no references to `RALPH_AUTO_APPROVE` or `RALPH_INTERACTIVE` remain in `plugin/`

### Integration test hero pipeline:
1. `RALPH_REVIEW_PLAN=auto` + `RALPH_REVIEW_MODE=interactive` (default hero) → review-agent critiques plan, stops at PR
2. `RALPH_REVIEW_PLAN=interactive` (hero override) → human approves plan, stops at PR
3. `RALPH_REVIEW_MODE=auto` (user trusts pipeline) → auto-merges after finish
4. Verify escalation to Human Needed when review-agent flags out-of-bounds concerns

### Integration test plan skill:
1. Default (`RALPH_REVIEW_PLAN=interactive`) → stops for human review
2. Override (`RALPH_REVIEW_PLAN=auto`) → skips review, links to GitHub

## References

- Config resolution pattern: `plugin/ralph-hero/skills/hero/SKILL.md:33-37`
- Escalation protocol: `plugin/ralph-hero/skills/shared/fragments/escalation-steps.md`
- `set-skill-env.sh`: `plugin/ralph-hero/hooks/scripts/set-skill-env.sh`
- `split-size-gate.sh:20`: reads `RALPH_VALID_SUB_ESTIMATES`
- `review-postcondition.sh:16`: reads `RALPH_INTERACTIVE` (to be renamed)
- `ralph-loop.sh:54,79,199,201`: sets review vars for child processes
