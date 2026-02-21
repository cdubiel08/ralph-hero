---
date: 2026-02-21
github_issue: 294
github_url: https://github.com/cdubiel08/ralph-hero/issues/294
status: complete
type: research
---

# GH-294: Add Early-Exit for Empty Work in ralph-loop.sh

## Problem Statement

`ralph-loop.sh` always runs `MAX_ITERATIONS` (default 10) iterations regardless of whether any work was found. When the board is empty, it spins through all phases 10 times, wasting time and API budget on skills that each report "Queue empty."

## Current State Analysis

**File**: [`plugin/ralph-hero/scripts/ralph-loop.sh`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/scripts/ralph-loop.sh)

### The `work_done` Variable (Lines 93, 102, 112, 120, 130, 139, 152, 162)

- **Line 93**: `work_done=false` set at top of each iteration
- **Lines 102, 112, 120, 130, 139, 152, 162**: `work_done=true` set **unconditionally** whenever a phase runs, regardless of whether the skill found actual work
- **No check**: `work_done` is never read after being set — there is no break condition

### The Loop (Lines 87-173)

```bash
while [ $iteration -lt $MAX_ITERATIONS ]; do
    # ... all phases run ...
    sleep 5
done
```

No early-exit logic exists. The loop always runs `MAX_ITERATIONS` times.

### How Skills Signal "No Work"

All skills output a "Queue empty" message when no eligible issues exist:

| Skill | Empty Message |
|-------|---------------|
| triage | "No untriaged issues in Backlog. Triage complete." |
| split | "No M/L/XL issues need splitting. Queue empty." |
| research | "No XS/Small issues need research. Queue empty." |
| plan | "No XS/Small issues ready for planning. Queue empty." |
| review | "No XS/Small issues in Plan in Review. Queue empty." |
| impl | "No XS/Small issues ready for implementation. Queue empty." |

Skills exit with code 0 in both cases (work found or queue empty), so exit code alone cannot distinguish work vs. no-work.

## Recommended Approach

### Option A: Check `work_done` After Iteration (Simple)

The issue body's proposed fix is correct in principle but requires changing **when** `work_done=true` is set. Two sub-changes:

1. **Don't set `work_done=true` unconditionally** — only set it when a phase actually processes work. Since skills exit 0 either way, the simplest heuristic is to grep `run_claude` output for "Queue empty":

```bash
run_claude() {
    local command="$1"
    local title="$2"
    local output

    echo ">>> Running: $command"
    echo ">>> Timeout: $TIMEOUT"
    echo ""

    output=$(timeout "$TIMEOUT" claude -p "$command" --dangerously-skip-permissions 2>&1) || {
        local exit_code=$?
        if [ $exit_code -eq 124 ]; then
            echo ">>> Task timed out after $TIMEOUT"
        else
            echo ">>> Task exited with code $exit_code"
        fi
    }
    echo "$output"

    echo ""
    echo ">>> Completed: $command"
    echo ""

    # Return 1 if queue was empty (no work done)
    if echo "$output" | grep -q "Queue empty"; then
        return 1
    fi
    return 0
}
```

2. **Break when no work done**:

```bash
    # After all phases in the iteration:
    if [ "$work_done" = "false" ]; then
        echo ">>> No work found in any queue. Stopping."
        break
    fi

    sleep 5
done
```

3. **Update callers** to conditionally set `work_done`:

```bash
    if run_claude "/ralph-triage" "triage"; then
        work_done=true
    fi
```

### Option B: Simpler — Two Consecutive Empty Iterations

A simpler approach that avoids parsing output: track consecutive empty iterations and break after 2.

```bash
empty_iterations=0
while [ $iteration -lt $MAX_ITERATIONS ]; do
    # ...existing phases (keep work_done as-is)...

    if [ "$work_done" = "false" ]; then
        empty_iterations=$((empty_iterations + 1))
        if [ $empty_iterations -ge 2 ]; then
            echo ">>> No work found in $empty_iterations consecutive iterations. Stopping."
            break
        fi
    else
        empty_iterations=0
    fi
done
```

But this still requires fixing `work_done` to accurately reflect reality (same core problem).

### Recommendation

**Option A** is recommended. It requires:
1. Modify `run_claude` to capture output and return 1 on "Queue empty"
2. Update each phase block to check `run_claude` return value before setting `work_done=true`
3. Add the early-exit check after all phases

## Risks

- **Output capture**: Capturing `run_claude` output into a variable delays display to the user. Could use `tee` to both display and capture, but adds complexity.
- **False positives**: If a skill outputs "Queue empty" in a non-terminal context (e.g., within a longer message), it could falsely signal no-work. Low risk given current skill output patterns.
- **Hygiene always "works"**: The hygiene phase always reports findings (even if just "board is clean"), so `work_done` would always be true when hygiene runs. May need to exclude hygiene from the work-done check, or only count phases that have a clear queue-empty signal.

## Scope

- **Single file**: `plugin/ralph-hero/scripts/ralph-loop.sh`
- **XS estimate confirmed**: The fix is ~15 lines changed, all in one file
