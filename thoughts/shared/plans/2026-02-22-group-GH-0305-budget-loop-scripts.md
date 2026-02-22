---
date: 2026-02-22
status: draft
github_issues: [305, 306]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/305
  - https://github.com/cdubiel08/ralph-hero/issues/306
primary_issue: 305
---

# Thread Budget Through Loop Scripts - Atomic Implementation Plan

## Overview

2 related issues for atomic implementation in a single PR. Both are children of #299 (Thread budget through loop scripts), adding `--max-budget-usd` support to the two loop shell scripts.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-305 | Add --max-budget-usd support to ralph-loop.sh | S |
| 2 | GH-306 | Add --max-budget-usd support to ralph-team-loop.sh | XS |

**Why grouped**: Both issues are siblings under #299, both follow the identical pattern (env var + CLI arg + thread to `claude -p`), and both require updating the same justfile recipes that invoke them. The justfile's `_run_skill` already has `--max-budget-usd` support (from GH-291 group); these issues extend that pattern to the loop scripts.

## Current State Analysis

The justfile's `_run_skill` helper already threads `--max-budget-usd` via a `budget` parameter (added by GH-291 group). However, the two loop scripts call `claude -p` directly without budget control:

- **`ralph-loop.sh`** (203 lines): `run_claude()` on line 73 calls `timeout "$TIMEOUT" claude -p "$command" --dangerously-skip-permissions` — no `--max-budget-usd`. The justfile `loop` recipe (line 86) passes `TIMEOUT` as an env var but has no `budget` parameter.

- **`ralph-team-loop.sh`** (53 lines): Line 40 calls `timeout "$TIMEOUT" claude -p "$COMMAND" --dangerously-skip-permissions` — no `--max-budget-usd`. The justfile `team` recipe (line 76) passes `TIMEOUT` as an env var but has no `budget` parameter.

## Desired End State

### Verification
- [ ] `RALPH_BUDGET` env var controls per-phase budget in `ralph-loop.sh`
- [ ] `--budget=N` CLI flag overrides env var in `ralph-loop.sh`
- [ ] `run_claude()` passes `--max-budget-usd` to `claude -p`
- [ ] Budget value displayed in `ralph-loop.sh` startup banner
- [ ] `RALPH_BUDGET` env var controls team orchestrator budget in `ralph-team-loop.sh`
- [ ] `--budget=N` CLI argument overrides env var in `ralph-team-loop.sh`
- [ ] `ralph-team-loop.sh` `claude -p` call includes `--max-budget-usd`
- [ ] Budget displayed in `ralph-team-loop.sh` startup banner
- [ ] Justfile `loop` recipe accepts and passes `budget` parameter
- [ ] Justfile `team` recipe accepts and passes `budget` parameter

## What We're NOT Doing
- Not adding per-phase budget differentiation in `ralph-loop.sh` (single budget for all phases — keep it simple)
- Not adding budget tracking/accumulation across iterations (each invocation gets independent budget)
- Not modifying `_run_skill` (already has budget support from GH-291 group)

## Implementation Approach

Phase 1 handles the more complex script (`ralph-loop.sh` with arg parsing, multiple phases, and banner). Phase 2 mirrors the same pattern for the simpler script (`ralph-team-loop.sh`). Both phases also update their corresponding justfile recipe to thread the budget parameter.

---

## Phase 1: GH-305 - Add --max-budget-usd support to ralph-loop.sh
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/305 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-cli-ux-improvements.md (finding #6)

### Changes Required

#### 1. Add RALPH_BUDGET env var and --budget CLI arg parsing
**File**: `plugin/ralph-hero/scripts/ralph-loop.sh`
**Changes**: Add `BUDGET` variable with env var default and parse `--budget=N` in the arg loop.

After `TIMEOUT` variable (line 50), add:
```bash
BUDGET="${RALPH_BUDGET:-5.00}"
```

In the `for arg` case statement (lines 27-45), add a new case:
```bash
--budget=*)
    BUDGET="${arg#*=}"
    ;;
```

#### 2. Display budget in startup banner
**File**: `plugin/ralph-hero/scripts/ralph-loop.sh`
**Changes**: Add budget line to the banner block (after line 60 "Timeout per task"):
```bash
echo "Budget per task: \$${BUDGET}"
```

#### 3. Thread --max-budget-usd into run_claude()
**File**: `plugin/ralph-hero/scripts/ralph-loop.sh`
**Changes**: Add `--max-budget-usd "$BUDGET"` to the `claude -p` call in `run_claude()`.

Before (line 73):
```bash
if output=$(timeout "$TIMEOUT" claude -p "$command" --dangerously-skip-permissions 2>&1); then
```

After:
```bash
if output=$(timeout "$TIMEOUT" claude -p "$command" --max-budget-usd "$BUDGET" --dangerously-skip-permissions 2>&1); then
```

#### 4. Update usage comment
**File**: `plugin/ralph-hero/scripts/ralph-loop.sh`
**Changes**: Add `--budget=N` to usage comment at top of file.

Update line 6 to add:
```bash
#        ./scripts/ralph-loop.sh --budget=5.00
```

#### 5. Update justfile loop recipe to accept and pass budget
**File**: `plugin/ralph-hero/justfile`
**Changes**: Add `budget` parameter to `loop` recipe and pass as env var.

Before (line 86):
```just
loop mode="all" review="skip" split="auto" hygiene="auto" timeout="60m":
```

After:
```just
loop mode="all" review="skip" split="auto" hygiene="auto" budget="5.00" timeout="60m":
```

Before (line 92):
```bash
TIMEOUT="{{timeout}}" ./scripts/ralph-loop.sh $args
```

After:
```bash
RALPH_BUDGET="{{budget}}" TIMEOUT="{{timeout}}" ./scripts/ralph-loop.sh $args
```

### Success Criteria
- [x] Automated: `grep 'max-budget-usd' plugin/ralph-hero/scripts/ralph-loop.sh` matches the `claude -p` call
- [x] Automated: `grep 'RALPH_BUDGET' plugin/ralph-hero/scripts/ralph-loop.sh` shows env var and banner
- [x] Automated: `grep 'budget' plugin/ralph-hero/justfile | grep 'loop'` shows budget parameter on loop recipe
- [ ] Manual: `RALPH_BUDGET=2.00 ./scripts/ralph-loop.sh --triage-only` shows "Budget per task: $2.00" in banner and passes `--max-budget-usd 2.00` to claude

**Creates for next phase**: Budget threading pattern established for `ralph-team-loop.sh` to follow.

---

## Phase 2: GH-306 - Add --max-budget-usd support to ralph-team-loop.sh
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/306 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-cli-ux-improvements.md (finding #6) | **Depends on**: Phase 1 (GH-305) for pattern consistency

### Changes Required

#### 1. Add RALPH_BUDGET env var and --budget CLI arg
**File**: `plugin/ralph-hero/scripts/ralph-team-loop.sh`
**Changes**: Add budget support. The team orchestrator is more expensive (spawns multiple agents), so default is higher (10 USD).

After `TIMEOUT` variable (line 17), add:
```bash
BUDGET="${RALPH_BUDGET:-10.00}"
```

Update `ISSUE_NUMBER` parsing to handle optional second arg. Replace line 16:
```bash
ISSUE_NUMBER="${1:-}"
```

With argument parsing:
```bash
ISSUE_NUMBER=""
for arg in "$@"; do
    case "$arg" in
        --budget=*)
            BUDGET="${arg#*=}"
            ;;
        *)
            if [ -z "$ISSUE_NUMBER" ]; then
                ISSUE_NUMBER="$arg"
            fi
            ;;
    esac
done
```

#### 2. Display budget in startup banner
**File**: `plugin/ralph-hero/scripts/ralph-team-loop.sh`
**Changes**: Add budget line to banner (after "Timeout" line 27):
```bash
echo "Budget: \$${BUDGET}"
```

#### 3. Thread --max-budget-usd into claude -p call
**File**: `plugin/ralph-hero/scripts/ralph-team-loop.sh`
**Changes**: Add `--max-budget-usd "$BUDGET"` to the `claude -p` call.

Before (line 40):
```bash
timeout "$TIMEOUT" claude -p "$COMMAND" --dangerously-skip-permissions 2>&1 || {
```

After:
```bash
timeout "$TIMEOUT" claude -p "$COMMAND" --max-budget-usd "$BUDGET" --dangerously-skip-permissions 2>&1 || {
```

#### 4. Update usage comment
**File**: `plugin/ralph-hero/scripts/ralph-team-loop.sh`
**Changes**: Update usage to show budget option.

Before (line 4):
```bash
# Usage: ./scripts/ralph-team-loop.sh [ISSUE_NUMBER]
```

After:
```bash
# Usage: ./scripts/ralph-team-loop.sh [ISSUE_NUMBER] [--budget=N]
```

#### 5. Update justfile team recipe to accept and pass budget
**File**: `plugin/ralph-hero/justfile`
**Changes**: Add `budget` parameter to `team` recipe and pass as env var.

Before (line 76-77):
```just
team issue="" timeout="30m":
    TIMEOUT="{{timeout}}" ./scripts/ralph-team-loop.sh {{issue}}
```

After:
```just
team issue="" budget="10.00" timeout="30m":
    RALPH_BUDGET="{{budget}}" TIMEOUT="{{timeout}}" ./scripts/ralph-team-loop.sh {{issue}}
```

### Success Criteria
- [x] Automated: `grep 'max-budget-usd' plugin/ralph-hero/scripts/ralph-team-loop.sh` matches the `claude -p` call
- [x] Automated: `grep 'RALPH_BUDGET' plugin/ralph-hero/scripts/ralph-team-loop.sh` shows env var and banner
- [x] Automated: `grep 'budget' plugin/ralph-hero/justfile | grep 'team'` shows budget parameter on team recipe
- [ ] Manual: `RALPH_BUDGET=8.00 ./scripts/ralph-team-loop.sh` shows "Budget: $8.00" in banner

---

## File Ownership Summary

| File | Phase |
|------|-------|
| `plugin/ralph-hero/scripts/ralph-loop.sh` | Phase 1 |
| `plugin/ralph-hero/scripts/ralph-team-loop.sh` | Phase 2 |
| `plugin/ralph-hero/justfile` | Phase 1 (loop recipe), Phase 2 (team recipe) |

## Integration Testing
- [ ] `just loop --dry-run 2>&1` succeeds (recipe accepts budget param)
- [ ] `just team --dry-run 2>&1` succeeds (recipe accepts budget param)
- [ ] `just loop budget=3.00 mode=triage-only` passes budget through to ralph-loop.sh
- [ ] `just team 42 budget=8.00` passes budget through to ralph-team-loop.sh
- [ ] Both scripts display budget in startup banner
- [ ] Both scripts pass `--max-budget-usd` to `claude -p`

## References
- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-cli-ux-improvements.md
- Parent issue: https://github.com/cdubiel08/ralph-hero/issues/299
- Related: GH-291 group (justfile `_run_skill` budget support, already implemented)
