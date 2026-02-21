---
date: 2026-02-21
github_issue: 292
github_url: https://github.com/cdubiel08/ralph-hero/issues/292
status: complete
type: research
---

# GH-292: Add success banner to `_run_skill`

## Problem Statement

`_run_skill` in the justfile prints a start banner (`>>> Running: ...`) before invoking `claude`, but prints nothing on successful completion. Users cannot distinguish between "the command finished successfully" and "the terminal just stopped scrolling." Failure paths already print messages (timeout: `>>> Timed out after`, other failures: `>>> Exited with code $exit_code`), so success is the only unhandled case.

## Current State

[`plugin/ralph-hero/justfile:284-303`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/justfile#L284-L303):

```bash
_run_skill skill issue budget timeout:
    #!/usr/bin/env bash
    set -eu
    if [ -n "{{issue}}" ]; then
        cmd="/ralph-{{skill}} {{issue}}"
    else
        cmd="/ralph-{{skill}}"
    fi
    echo ">>> Running: $cmd (budget: \${{budget}}, timeout: {{timeout}})"
    timeout "{{timeout}}" claude -p "$cmd" \
        --max-budget-usd "{{budget}}" \
        --dangerously-skip-permissions \
        2>&1 || {
        exit_code=$?
        if [ $exit_code -eq 124 ]; then
            echo ">>> Timed out after {{timeout}}"
        else
            echo ">>> Exited with code $exit_code"
        fi
    }
```

The `|| { ... }` block handles failures. Success falls through with no output.

Note: the skill names used here (`/ralph-{{skill}}`) are being fixed in GH-304 to use fully-qualified names (`/ralph-hero:ralph-{{skill}}`). This issue can be implemented alongside or after GH-304 -- the two changes are on the same function.

## Key Findings

### Minimal change required

Insert one `echo` line immediately after the `timeout ... claude ...` block succeeds:

```bash
    timeout "{{timeout}}" claude -p "$cmd" \
        --max-budget-usd "{{budget}}" \
        --dangerously-skip-permissions \
        2>&1 || {
        exit_code=$?
        if [ $exit_code -eq 124 ]; then
            echo ">>> Timed out after {{timeout}}"
        else
            echo ">>> Exited with code $exit_code"
        fi
    }
    echo ">>> Completed: $cmd"
```

The `echo` runs only when `timeout claude` exits 0 (success) because `set -eu` is active and the `|| { ... }` block handles non-zero exits.

Wait -- with `set -eu` and no explicit exit after the `|| { ... }` block, the script continues after a failure too. Need to add `return` or restructure. The correct pattern:

```bash
    if timeout "{{timeout}}" claude -p "$cmd" \
        --max-budget-usd "{{budget}}" \
        --dangerously-skip-permissions \
        2>&1; then
        echo ">>> Completed: $cmd"
    else
        exit_code=$?
        if [ $exit_code -eq 124 ]; then
            echo ">>> Timed out after {{timeout}}"
        else
            echo ">>> Exited with code $exit_code"
        fi
    fi
```

Or simpler -- keep existing structure, the `|| { }` exits naturally:

Actually, reviewing the code again: the `|| { ... }` block does NOT call `exit`, so after a failure the script continues past the block. Adding `echo ">>> Completed: $cmd"` after the `|| { }` would print "Completed" even on failure. The `if/then/else` restructure is the clean approach.

### Relation to GH-304

GH-304 fixes `_run_skill` to use fully-qualified skill names (`/ralph-hero:ralph-{{skill}}`). Both GH-292 and GH-304 modify the same `_run_skill` function. They should be implemented together or sequentially to avoid merge conflicts.

## Recommended Approach

Restructure `_run_skill` to use `if/then/else` for the `timeout claude` invocation, adding `echo ">>> Completed: $cmd"` on the success branch. Implement together with GH-304 (fully-qualified skill names) since both touch the same function.

```bash
_run_skill skill issue budget timeout:
    #!/usr/bin/env bash
    set -eu
    if [ -n "{{issue}}" ]; then
        cmd="/ralph-hero:ralph-{{skill}} {{issue}}"
    else
        cmd="/ralph-hero:ralph-{{skill}}"
    fi
    echo ">>> Running: $cmd (budget: \${{budget}}, timeout: {{timeout}})"
    if timeout "{{timeout}}" claude -p "$cmd" \
        --max-budget-usd "{{budget}}" \
        --dangerously-skip-permissions \
        2>&1; then
        echo ">>> Completed: $cmd"
    else
        exit_code=$?
        if [ $exit_code -eq 124 ]; then
            echo ">>> Timed out after {{timeout}}"
        else
            echo ">>> Exited with code $exit_code"
        fi
    fi
```

## Risks

- Low. The only behavioral change is printing a completion line on success.
- Coordinating with GH-304 avoids a merge conflict on the same function.
