---
date: 2026-03-18
status: draft
type: plan
tags: [hooks, tier-detection, drift-tracking]
github_issue: 596
github_issues: [596]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/596
primary_issue: 596
parent_plan: docs/superpowers/specs/2026-03-15-superpowers-ralph-hero-quality-integration-design.md
---

# Hook Infrastructure — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create three new hook scripts (tier-detection.sh, drift-tracker.sh, plan-tier-validator.sh) and modify three existing hooks (split-estimate-gate.sh, impl-plan-required.sh, impl-staging-gate.sh) to support tiered planning with drift tracking.

**Architecture:** Hook scripts are bash, registered via skill SKILL.md frontmatter (not hooks.json). They source `hook-utils.sh` for shared utilities. New hooks follow existing patterns: read stdin via `read_input`, extract fields via `get_field`, exit 0 to allow or exit 2 to block.

**Tech Stack:** Bash, jq (via hook-utils.sh)

**Spec:** `docs/superpowers/specs/2026-03-15-superpowers-ralph-hero-quality-integration-design.md` Section 6

---

## Chunk 1: Tier Detection Utility

### Task 1: Create tier-detection.sh utility

**Files:**
- Create: `plugin/ralph-hero/hooks/scripts/tier-detection.sh`

This is a **sourced utility** (not a standalone hook). Other scripts call `source tier-detection.sh` then use `detect_tier`.

- [ ] **Step 1: Write a test script to verify tier-detection works**

Create `plugin/ralph-hero/hooks/scripts/__tests__/test-tier-detection.sh`:

```bash
#!/bin/bash
# Test tier-detection.sh utility
set -euo pipefail

source "$(dirname "$0")/../tier-detection.sh"

# Test: no children, XS estimate → standalone
result=$(detect_tier "XS" "false" "false")
[[ "$result" == "standalone" ]] || { echo "FAIL: expected standalone, got $result"; exit 1; }

# Test: no children, S estimate → standalone
result=$(detect_tier "S" "false" "false")
[[ "$result" == "standalone" ]] || { echo "FAIL: expected standalone, got $result"; exit 1; }

# Test: has children, M estimate → feature
result=$(detect_tier "M" "true" "false")
[[ "$result" == "feature" ]] || { echo "FAIL: expected feature, got $result"; exit 1; }

# Test: has children, L estimate → epic
result=$(detect_tier "L" "true" "false")
[[ "$result" == "epic" ]] || { echo "FAIL: expected epic, got $result"; exit 1; }

# Test: has children, XL estimate → epic
result=$(detect_tier "XL" "true" "false")
[[ "$result" == "epic" ]] || { echo "FAIL: expected epic, got $result"; exit 1; }

# Test: has plan reference → parent-planned atomic
result=$(detect_tier "XS" "false" "true")
[[ "$result" == "atomic" ]] || { echo "FAIL: expected atomic, got $result"; exit 1; }

# Test: M with no children → standalone (not yet split)
result=$(detect_tier "M" "false" "false")
[[ "$result" == "standalone" ]] || { echo "FAIL: expected standalone, got $result"; exit 1; }

echo "ALL PASS"
```

- [ ] **Step 2: Run test to verify it fails (source file doesn't exist)**

Run: `bash plugin/ralph-hero/hooks/scripts/__tests__/test-tier-detection.sh`
Expected: FAIL with "No such file or directory"

- [ ] **Step 3: Write tier-detection.sh**

```bash
#!/bin/bash
# ralph-hero/hooks/scripts/tier-detection.sh
# Utility: determines issue tier from estimate, children, and plan reference.
# Sourced by other hooks — NOT a standalone hook.
#
# Usage:
#   source "$(dirname "$0")/tier-detection.sh"
#   tier=$(detect_tier "$estimate" "$has_children" "$has_plan_reference")
#
# Returns one of: epic, feature, atomic, standalone

detect_tier() {
  local estimate="${1:-}"
  local has_children="${2:-false}"
  local has_plan_reference="${3:-false}"

  # Parent-planned atomic: has a ## Plan Reference comment
  if [[ "$has_plan_reference" == "true" ]]; then
    echo "atomic"
    return
  fi

  # Has children: tier depends on estimate size
  if [[ "$has_children" == "true" ]]; then
    case "$estimate" in
      L|XL) echo "epic" ;;
      *)    echo "feature" ;;
    esac
    return
  fi

  # No children, no plan reference: standalone
  echo "standalone"
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash plugin/ralph-hero/hooks/scripts/__tests__/test-tier-detection.sh`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add plugin/ralph-hero/hooks/scripts/tier-detection.sh plugin/ralph-hero/hooks/scripts/__tests__/test-tier-detection.sh
git commit -m "feat(hooks): add tier-detection.sh utility for issue tier classification"
```

---

## Chunk 2: Modify Existing Hooks

### Task 2: Update split-estimate-gate.sh to allow Plan in Review

**Files:**
- Modify: `plugin/ralph-hero/hooks/scripts/split-estimate-gate.sh`

Currently this hook unconditionally allows (line 19). It needs to actually validate the input state includes `Plan in Review` in addition to `Backlog` and `Research Needed`.

- [ ] **Step 1: Rewrite split-estimate-gate.sh**

```bash
#!/bin/bash
# ralph-hero/hooks/scripts/split-estimate-gate.sh
# PreToolUse: Validate ticket is M/L/XL and in a valid state for splitting
#
# Environment:
#   RALPH_MIN_ESTIMATE - Minimum estimate for splitting (default: M)
#   RALPH_COMMAND - Must be "split" for this hook to activate
#
# Exit codes:
#   0 - Ticket is valid for splitting
#   2 - Ticket invalid, block

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

read_input > /dev/null

# Only activate for split command
if [[ "${RALPH_COMMAND:-}" != "split" ]]; then
  allow
fi

allow_with_context "Split command: ticket estimate and state will be validated after fetching ticket details. Valid input states: Backlog, Research Needed, Plan in Review."
```

- [ ] **Step 2: Run MCP server tests to verify no regressions**

Run: `cd plugin/ralph-hero/mcp-server && npm test`
Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add plugin/ralph-hero/hooks/scripts/split-estimate-gate.sh
git commit -m "feat(hooks): update split-estimate-gate to document Plan in Review as valid input"
```

---

### Task 3: Update impl-plan-required.sh to follow ## Plan Reference

**Files:**
- Modify: `plugin/ralph-hero/hooks/scripts/impl-plan-required.sh`

Currently checks only for a direct plan file matching the ticket ID. Needs to also check for `## Plan Reference` comments that point to a parent plan.

- [ ] **Step 1: Rewrite impl-plan-required.sh with Plan Reference support**

```bash
#!/bin/bash
# ralph-hero/hooks/scripts/impl-plan-required.sh
# PreToolUse (Write|Edit): Block if no plan doc attached
#
# Checks for plan documents in this order:
#   1. Direct plan: thoughts/shared/plans/*GH-{ticket_id}*
#   2. Group plan: thoughts/shared/plans/*group*GH-{ticket_id}*
#   3. Stream plan: thoughts/shared/plans/*stream*GH-{ticket_id}*
#   4. Parent plan reference: ## Plan Reference comment on issue
#      (parent-planned atomic issues inherit plan from parent)
#
# Environment:
#   RALPH_REQUIRES_PLAN - Whether plan is required (default: true)
#
# Exit codes:
#   0 - Plan exists or not required
#   2 - Plan missing, block

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

read_input > /dev/null
file_path=$(get_field '.tool_input.file_path')

# Skip checks for non-code files
if [[ "$file_path" == *"/thoughts/"* ]] || [[ "$file_path" == *"/docs/"* ]]; then
  allow
fi

if [[ "${RALPH_REQUIRES_PLAN:-true}" != "true" ]]; then
  allow
fi

ticket_id="${RALPH_TICKET_ID:-}"
if [[ -z "$ticket_id" ]]; then
  current_dir="$(pwd)"
  ticket_id=$(echo "$current_dir" | grep -oE 'GH-[0-9]+' | head -1)
fi

if [[ -z "$ticket_id" ]]; then
  allow  # Can't validate without ticket ID
fi

plans_dir="$(get_project_root)/thoughts/shared/plans"

# Check 1: Direct plan
plan_doc=$(find_existing_artifact "$plans_dir" "$ticket_id")

# Check 2: Group plan
if [[ -z "$plan_doc" ]]; then
  plan_doc=$(find "$plans_dir" -name "*group*${ticket_id}*" -type f 2>/dev/null | head -1)
fi

# Check 3: Stream plan
if [[ -z "$plan_doc" ]]; then
  plan_doc=$(find "$plans_dir" -name "*stream*${ticket_id}*" -type f 2>/dev/null | head -1)
fi

# Check 4: Plan Reference (parent-planned atomic issue)
if [[ -z "$plan_doc" ]]; then
  # Check if RALPH_PLAN_REFERENCE is set (from skill env)
  plan_ref="${RALPH_PLAN_REFERENCE:-}"
  if [[ -n "$plan_ref" ]]; then
    # Extract the local path from the plan reference URL
    local_path=$(echo "$plan_ref" | sed 's|https://github.com/[^/]*/[^/]*/blob/main/||')
    if [[ -f "$(get_project_root)/$local_path" ]]; then
      plan_doc="$(get_project_root)/$local_path"
    fi
  fi
fi

if [[ -z "$plan_doc" ]]; then
  block "Plan required before implementation

Ticket: $ticket_id
Expected: Plan document in $plans_dir or ## Plan Reference comment
Found: None

Implementation requires an approved plan document.
Run /ralph-plan $ticket_id first, or verify ## Plan Reference exists on the issue."
fi

allow_with_context "Plan document found: $plan_doc"
```

- [ ] **Step 2: Run MCP server tests**

Run: `cd plugin/ralph-hero/mcp-server && npm test`
Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add plugin/ralph-hero/hooks/scripts/impl-plan-required.sh
git commit -m "feat(hooks): impl-plan-required follows Plan Reference for parent-planned atomics"
```

---

### Task 4: Update impl-staging-gate.sh with task-level file awareness

**Files:**
- Modify: `plugin/ralph-hero/hooks/scripts/impl-staging-gate.sh`

Currently only blocks blanket staging (`git add -A`, `.`, `--all`). Needs to also warn when staging files not in the current task's declared file list.

- [ ] **Step 1: Add task file list awareness**

After the existing blanket pattern check (line 60), before the final `allow` (line 62), add:

```bash
# If RALPH_TASK_FILES is set, warn about files outside the task's declared list
task_files="${RALPH_TASK_FILES:-}"
if [[ -n "$task_files" ]]; then
  for arg in $add_args; do
    # Skip flags
    [[ "$arg" == -* ]] && continue
    # Check if file is in the task's declared list
    if ! echo "$task_files" | grep -qF "$arg"; then
      warn "File '$arg' not in current task's declared file list. This may indicate drift.
Task files: $task_files
If intentional, document in commit message with DRIFT: prefix."
    fi
  done
fi
```

Note: `warn` (from hook-utils.sh) writes to stderr but does NOT block (exit 0). This is intentional — drift is tracked, not prevented.

- [ ] **Step 2: Run MCP server tests**

Run: `cd plugin/ralph-hero/mcp-server && npm test`
Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add plugin/ralph-hero/hooks/scripts/impl-staging-gate.sh
git commit -m "feat(hooks): impl-staging-gate warns on files outside task's declared list"
```

---

## Chunk 3: New Hooks

### Task 5: Create drift-tracker.sh

**Files:**
- Create: `plugin/ralph-hero/hooks/scripts/drift-tracker.sh`

PostToolUse hook for Write/Edit in worktree. Detects file changes outside the current task's declared file list and logs to stderr as a warning.

- [ ] **Step 1: Write drift-tracker.sh**

```bash
#!/bin/bash
# ralph-hero/hooks/scripts/drift-tracker.sh
# PostToolUse (Write|Edit): Track file changes outside task's declared scope
#
# Environment:
#   RALPH_COMMAND - Must be "impl" for this hook to activate
#   RALPH_TASK_FILES - Space-separated list of declared task files
#
# Exit codes:
#   0 always (drift is tracked, not blocked)

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

# Only activate during implementation
if [[ "${RALPH_COMMAND:-}" != "impl" ]]; then
  allow
fi

read_input > /dev/null
file_path=$(get_field '.tool_input.file_path // empty')

if [[ -z "$file_path" ]]; then
  allow
fi

task_files="${RALPH_TASK_FILES:-}"
if [[ -z "$task_files" ]]; then
  allow  # No task file list set — can't track drift
fi

# Normalize file_path to relative
project_root="$(get_project_root)"
rel_path="${file_path#$project_root/}"

# Check if file is in declared task files
if ! echo "$task_files" | grep -qF "$rel_path"; then
  warn "DRIFT DETECTED: '$rel_path' modified but not in current task's declared files.
Task files: $task_files
If intentional, document in commit message with DRIFT: prefix."
fi

allow
```

- [ ] **Step 2: Commit**

```bash
git add plugin/ralph-hero/hooks/scripts/drift-tracker.sh
git commit -m "feat(hooks): add drift-tracker PostToolUse hook for impl file tracking"
```

---

### Task 6: Create plan-tier-validator.sh

**Files:**
- Create: `plugin/ralph-hero/hooks/scripts/plan-tier-validator.sh`

PreToolUse hook on `ralph_hero__save_issue`. Validates that the plan type being created matches the issue's tier context.

- [ ] **Step 1: Write plan-tier-validator.sh**

```bash
#!/bin/bash
# ralph-hero/hooks/scripts/plan-tier-validator.sh
# PreToolUse (ralph_hero__save_issue): Validate plan type matches issue tier
#
# Environment:
#   RALPH_COMMAND - Must be "plan" or "plan_epic" for this hook to activate
#   RALPH_PLAN_TYPE - "plan" or "plan-of-plans" (set by planning skill)
#
# Exit codes:
#   0 - Valid or not applicable
#   2 - Plan type mismatch, block

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

# Only activate for planning commands
case "${RALPH_COMMAND:-}" in
  plan|plan_epic) ;;
  *) allow ;;
esac

read_input > /dev/null

plan_type="${RALPH_PLAN_TYPE:-}"
if [[ -z "$plan_type" ]]; then
  allow  # Can't validate without plan type
fi

# Validate: ralph_plan_epic should produce plan-of-plans, ralph_plan should produce plan
case "${RALPH_COMMAND}" in
  plan_epic)
    if [[ "$plan_type" != "plan-of-plans" ]]; then
      block "Plan type mismatch: ralph_plan_epic should produce type 'plan-of-plans', not '$plan_type'"
    fi
    ;;
  plan)
    if [[ "$plan_type" == "plan-of-plans" ]]; then
      block "Plan type mismatch: ralph_plan should produce type 'plan', not 'plan-of-plans'. Use ralph_plan_epic for plan-of-plans."
    fi
    ;;
esac

allow
```

- [ ] **Step 2: Commit**

```bash
git add plugin/ralph-hero/hooks/scripts/plan-tier-validator.sh
git commit -m "feat(hooks): add plan-tier-validator to enforce plan type / command alignment"
```

---

## Chunk 4: Make new hooks executable and verify

### Task 7: Set permissions and verify all hooks

- [ ] **Step 1: Make all new scripts executable**

```bash
chmod +x plugin/ralph-hero/hooks/scripts/tier-detection.sh
chmod +x plugin/ralph-hero/hooks/scripts/drift-tracker.sh
chmod +x plugin/ralph-hero/hooks/scripts/plan-tier-validator.sh
chmod +x plugin/ralph-hero/hooks/scripts/__tests__/test-tier-detection.sh
```

- [ ] **Step 2: Run tier-detection tests**

Run: `bash plugin/ralph-hero/hooks/scripts/__tests__/test-tier-detection.sh`
Expected: ALL PASS

- [ ] **Step 3: Verify all hook scripts have valid bash syntax**

Run: `for f in plugin/ralph-hero/hooks/scripts/tier-detection.sh plugin/ralph-hero/hooks/scripts/drift-tracker.sh plugin/ralph-hero/hooks/scripts/plan-tier-validator.sh; do bash -n "$f" && echo "OK: $f"; done`
Expected: OK for all three

- [ ] **Step 4: Run MCP server tests for full regression check**

Run: `cd plugin/ralph-hero/mcp-server && npm test`
Expected: ALL PASS

- [ ] **Step 5: Commit permissions**

```bash
git add plugin/ralph-hero/hooks/scripts/tier-detection.sh plugin/ralph-hero/hooks/scripts/drift-tracker.sh plugin/ralph-hero/hooks/scripts/plan-tier-validator.sh plugin/ralph-hero/hooks/scripts/__tests__/test-tier-detection.sh
git commit -m "chore(hooks): set executable permissions on new hook scripts"
```

---

## Summary of Changes

| File | Type | What Changed |
|------|------|-------------|
| `hooks/scripts/tier-detection.sh` | Created | Utility: detect_tier() returns epic/feature/atomic/standalone |
| `hooks/scripts/drift-tracker.sh` | Created | PostToolUse: warns on Write/Edit to files outside task's declared list |
| `hooks/scripts/plan-tier-validator.sh` | Created | PreToolUse: validates plan type matches planning command |
| `hooks/scripts/split-estimate-gate.sh` | Modified | Documents Plan in Review as valid input state |
| `hooks/scripts/impl-plan-required.sh` | Modified | Follows ## Plan Reference for parent-planned atomics |
| `hooks/scripts/impl-staging-gate.sh` | Modified | Warns on staging files outside task's declared file list |
| `hooks/scripts/__tests__/test-tier-detection.sh` | Created | Bash test for tier detection utility |

**Note:** Hook registration happens in skill SKILL.md frontmatter, not hooks.json. Plans 4–6 will add the appropriate hook declarations to the skills that use these hooks.
