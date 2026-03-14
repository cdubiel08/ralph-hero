# Ralph CLI Feedback UX Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Wire cli-dispatch.sh into the justfile with headless-default, output wrapper for streaming feedback and link surfacing, and `-i` flag for interactive mode.

**Architecture:** Update `cli-dispatch.sh` to default to headless, rename `-h` to `-i`, add an awk-based output wrapper that streams output while collecting GitHub URLs, vscode file links, and state transitions for a summary footer. Refactor each justfile recipe from named params + `_run_skill` to variadic `*args` + cli-dispatch.sh sourcing.

**Tech Stack:** bash, awk, just (justfile), claude CLI

---

### Task 1: Update cli-dispatch.sh — flip defaults and rename flags

**Files:**
- Modify: `plugin/ralph-hero/scripts/cli-dispatch.sh:1-24`

**Step 1: Update the header comment**

Change line 3 from:
```
# Modes: interactive (default), headless (-h), quick (-q)
```
to:
```
# Modes: headless (default), interactive (-i), quick (-q)
```

**Step 2: Update parse_mode() to default to headless and use -i flag**

Replace `parse_mode()` (lines 9-24) with:

```bash
parse_mode() {
    MODE="${DEFAULT_MODE:-headless}"
    ARGS=()
    BUDGET="${DEFAULT_BUDGET:-2.00}"
    TIMEOUT="${DEFAULT_TIMEOUT:-15m}"

    for arg in "$@"; do
        case "$arg" in
            -i|--interactive) MODE="interactive" ;;
            -q|--quick) MODE="quick" ;;
            --budget=*) BUDGET="${arg#--budget=}" ;;
            --timeout=*) TIMEOUT="${arg#--timeout=}" ;;
            *) ARGS+=("$arg") ;;
        esac
    done
}
```

**Step 3: Update no_mode() help text**

Replace `no_mode()` (lines 93-103) with:

```bash
no_mode() {
    local command="$1"
    local mode="$2"
    echo "Error: '$command' does not support $mode mode."
    case "$mode" in
        interactive) echo "Try: ralph $command (headless) or ralph $command -q (quick)" ;;
        headless) echo "Try: ralph $command -i (interactive) or ralph $command -q (quick)" ;;
        quick) echo "Try: ralph $command (headless) or ralph $command -i (interactive)" ;;
    esac
    exit 1
}
```

**Step 4: Verify syntax**

Run: `bash -n plugin/ralph-hero/scripts/cli-dispatch.sh`
Expected: no output (clean parse)

**Step 5: Commit**

```bash
git add plugin/ralph-hero/scripts/cli-dispatch.sh
git commit -m "refactor(cli): flip default to headless, rename -h to -i"
```

---

### Task 2: Add output wrapper to run_headless()

**Files:**
- Modify: `plugin/ralph-hero/scripts/cli-dispatch.sh:35-61`

**Step 1: Replace run_headless() with output-wrapped version**

Replace the entire `run_headless()` function (lines 35-61) with:

```bash
# Run headless Claude session with streaming output and summary footer
run_headless() {
    local skill="$1"; shift
    local cmd="/ralph-hero:${skill}"
    if [ $# -gt 0 ] && [ -n "$1" ]; then cmd="$cmd $*"; fi

    local repo_root
    repo_root=$(git rev-parse --show-toplevel 2>/dev/null || echo "")
    local gh_base="https://github.com/${RALPH_GH_OWNER:-}/${RALPH_GH_REPO:-}"

    echo ">>> $cmd (budget: \$$BUDGET, timeout: $TIMEOUT)"
    local start_time
    start_time=$(date +%s)

    local exit_code=0
    timeout "$TIMEOUT" claude -p "$cmd" \
        --max-budget-usd "$BUDGET" \
        --dangerously-skip-permissions \
        </dev/null \
        2>&1 | _output_filter "$repo_root" "$gh_base" || exit_code=${PIPESTATUS[0]:-$?}

    local elapsed=$(( $(date +%s) - start_time ))

    if [ "$exit_code" -eq 0 ]; then
        echo "--- done (${elapsed}s) ---"
    elif [ "$exit_code" -eq 124 ]; then
        echo "--- timed out after $TIMEOUT (${elapsed}s) ---"
        echo "    Try: --timeout=30m"
    else
        echo "--- failed (exit $exit_code, ${elapsed}s) ---"
        echo "    Run: ralph doctor"
    fi

    # Print collected summary from temp file
    if [ -f "${_RALPH_SUMMARY_FILE:-/dev/null}" ]; then
        cat "$_RALPH_SUMMARY_FILE"
        rm -f "$_RALPH_SUMMARY_FILE"
    fi
}
```

**Step 2: Add _output_filter() function after run_headless()**

Add this function right after `run_headless()`:

```bash
# Filter that streams output and collects links/transitions for summary
_output_filter() {
    local repo_root="$1"
    local gh_base="$2"
    _RALPH_SUMMARY_FILE=$(mktemp /tmp/ralph-summary.XXXXXX)
    export _RALPH_SUMMARY_FILE

    awk -v repo_root="$repo_root" -v gh_base="$gh_base" -v summary_file="$_RALPH_SUMMARY_FILE" '
    BEGIN {
        url_count = 0
        file_count = 0
        trans_count = 0
    }
    {
        print  # stream through
        fflush()

        # Capture GitHub URLs (issues, PRs, blobs)
        line = $0
        while (match(line, /https:\/\/github\.com\/[^ ")\]>]+/)) {
            url = substr(line, RSTART, RLENGTH)
            # Deduplicate
            seen = 0
            for (j = 1; j <= url_count; j++) {
                if (urls[j] == url) { seen = 1; break }
            }
            if (!seen) { urls[++url_count] = url }
            line = substr(line, RSTART + RLENGTH)
        }

        # Capture repo-relative file paths (thoughts/shared/*, *.md artifacts)
        line = $0
        while (match(line, /thoughts\/shared\/[^ ")\]>:]+\.(md|yml|yaml)/)) {
            fpath = substr(line, RSTART, RLENGTH)
            seen = 0
            for (j = 1; j <= file_count; j++) {
                if (files[j] == fpath) { seen = 1; break }
            }
            if (!seen) { files[++file_count] = fpath }
            line = substr(line, RSTART + RLENGTH)
        }

        # Capture state transitions (arrows)
        if (match($0, /[A-Z][a-zA-Z ]+[→->]+[A-Z][a-zA-Z ]+/)) {
            trans[++trans_count] = substr($0, RSTART, RLENGTH)
        }
    }
    END {
        if (url_count + file_count + trans_count == 0) exit 0

        # Write summary to temp file
        for (j = 1; j <= url_count; j++) {
            print "  " urls[j] > summary_file
        }
        for (j = 1; j <= file_count; j++) {
            if (repo_root != "") {
                print "  vscode://file/" repo_root "/" files[j] > summary_file
            } else {
                print "  " files[j] > summary_file
            }
        }
        for (j = 1; j <= trans_count; j++) {
            print "  " trans[j] > summary_file
        }
        close(summary_file)
    }
    '
}
```

**Step 3: Verify syntax**

Run: `bash -n plugin/ralph-hero/scripts/cli-dispatch.sh`
Expected: no output (clean parse)

**Step 4: Smoke test the filter with fake input**

Run:
```bash
echo -e 'Starting research...\nhttps://github.com/cdubiel08/ralph-hero/issues/42\nWrote: thoughts/shared/research/2026-03-06-GH-0042-test.md\nResearch Needed → Ready for Plan\nDone.' | (
    source plugin/ralph-hero/scripts/cli-dispatch.sh
    _output_filter "$(pwd)" "https://github.com/cdubiel08/ralph-hero"
    echo "---"
    cat "$_RALPH_SUMMARY_FILE"
    rm -f "$_RALPH_SUMMARY_FILE"
)
```
Expected: all 5 input lines printed, then `---`, then 3 summary lines (github URL, vscode file link, state transition).

**Step 5: Commit**

```bash
git add plugin/ralph-hero/scripts/cli-dispatch.sh
git commit -m "feat(cli): add output wrapper with link surfacing and summary footer"
```

---

### Task 3: Refactor workflow recipes to use cli-dispatch.sh

**Files:**
- Modify: `plugin/ralph-hero/justfile:11-73`

**Step 1: Update aliases**

Replace lines 11-19:
```just
# Aliases for frequently-used recipes
alias t  := triage
alias r  := research
alias p  := plan
alias i  := impl
alias s  := status
alias sp := split
alias h  := hygiene
alias issue := quick-info
```

with:
```just
# Aliases for frequently-used recipes
alias t  := triage
alias r  := research
alias p  := plan
alias sp := split
alias s  := status
alias h  := hygiene
```

Note: removed `alias i := impl` (conflicts with `-i` flag in recipes that take `*args` — just alias collisions are confusing), and removed `alias issue := quick-info`.

**Step 2: Replace the 6 workflow recipes (triage through impl)**

Replace lines 30-58 with:

```just
# Triage a backlog issue - assess validity, close duplicates, route to research
[group('workflow')]
triage *args:
    #!/usr/bin/env bash
    set -eu
    source "{{justfile_directory()}}/scripts/cli-dispatch.sh"
    DEFAULT_BUDGET=1.00 DEFAULT_TIMEOUT=15m
    parse_mode {{args}}
    case "$MODE" in
        headless)    run_headless "ralph-triage" "${ARGS[@]}" ;;
        interactive) run_interactive "ralph-triage" "${ARGS[@]}" ;;
        quick)       no_mode "triage" "quick" ;;
    esac

# Split a large issue into smaller XS/S sub-issues
[group('workflow')]
split *args:
    #!/usr/bin/env bash
    set -eu
    source "{{justfile_directory()}}/scripts/cli-dispatch.sh"
    DEFAULT_BUDGET=1.00 DEFAULT_TIMEOUT=15m
    parse_mode {{args}}
    case "$MODE" in
        headless)    run_headless "ralph-split" "${ARGS[@]}" ;;
        interactive) run_interactive "ralph-split" "${ARGS[@]}" ;;
        quick)       no_mode "split" "quick" ;;
    esac

# Research an issue - investigate codebase, create findings document
[group('workflow')]
research *args:
    #!/usr/bin/env bash
    set -eu
    source "{{justfile_directory()}}/scripts/cli-dispatch.sh"
    DEFAULT_BUDGET=2.00 DEFAULT_TIMEOUT=15m
    parse_mode {{args}}
    case "$MODE" in
        headless)    run_headless "ralph-research" "${ARGS[@]}" ;;
        interactive) run_interactive "research" "${ARGS[@]}" ;;
        quick)       no_mode "research" "quick" ;;
    esac

# Create implementation plan from research findings
[group('workflow')]
plan *args:
    #!/usr/bin/env bash
    set -eu
    source "{{justfile_directory()}}/scripts/cli-dispatch.sh"
    DEFAULT_BUDGET=3.00 DEFAULT_TIMEOUT=15m
    parse_mode {{args}}
    case "$MODE" in
        headless)    run_headless "ralph-plan" "${ARGS[@]}" ;;
        interactive) run_interactive "plan" "${ARGS[@]}" ;;
        quick)       no_mode "plan" "quick" ;;
    esac

# Review and critique an implementation plan
[group('workflow')]
review *args:
    #!/usr/bin/env bash
    set -eu
    source "{{justfile_directory()}}/scripts/cli-dispatch.sh"
    DEFAULT_BUDGET=2.00 DEFAULT_TIMEOUT=15m
    parse_mode {{args}}
    case "$MODE" in
        headless)    run_headless "ralph-review" "${ARGS[@]}" ;;
        interactive) run_interactive "ralph-review" "${ARGS[@]}" ;;
        quick)       no_mode "review" "quick" ;;
    esac

# Implement an issue following its approved plan
[group('workflow')]
impl *args:
    #!/usr/bin/env bash
    set -eu
    source "{{justfile_directory()}}/scripts/cli-dispatch.sh"
    DEFAULT_BUDGET=5.00 DEFAULT_TIMEOUT=15m
    parse_mode {{args}}
    case "$MODE" in
        headless)    run_headless "ralph-impl" "${ARGS[@]}" ;;
        interactive) run_interactive "impl" "${ARGS[@]}" ;;
        quick)       no_mode "impl" "quick" ;;
    esac
```

**Step 3: Replace status, hygiene, report recipes**

Replace lines 60-73 with:

```just
# Run project hygiene check - stale items, archive candidates
[group('workflow')]
hygiene *args:
    #!/usr/bin/env bash
    set -eu
    source "{{justfile_directory()}}/scripts/cli-dispatch.sh"
    DEFAULT_BUDGET=0.50 DEFAULT_TIMEOUT=10m
    parse_mode {{args}}
    case "$MODE" in
        headless)    run_headless "ralph-hygiene" "${ARGS[@]}" ;;
        interactive) run_interactive "ralph-hygiene" "${ARGS[@]}" ;;
        quick)       run_quick "ralph_hero__project_hygiene" '{}' ;;
    esac

# Display pipeline status dashboard with health indicators
[group('workflow')]
status *args:
    #!/usr/bin/env bash
    set -eu
    source "{{justfile_directory()}}/scripts/cli-dispatch.sh"
    DEFAULT_BUDGET=0.50 DEFAULT_TIMEOUT=10m
    parse_mode {{args}}
    case "$MODE" in
        headless)    run_headless "status" "${ARGS[@]}" ;;
        interactive) run_interactive "status" "${ARGS[@]}" ;;
        quick)       run_quick "ralph_hero__pipeline_dashboard" \
                         '{"format":"markdown","includeHealth":true}' ;;
    esac

# Generate and post a project status report
[group('workflow')]
report *args:
    #!/usr/bin/env bash
    set -eu
    source "{{justfile_directory()}}/scripts/cli-dispatch.sh"
    DEFAULT_BUDGET=1.00 DEFAULT_TIMEOUT=10m
    parse_mode {{args}}
    case "$MODE" in
        headless)    run_headless "report" "${ARGS[@]}" ;;
        interactive) run_interactive "report" "${ARGS[@]}" ;;
        quick)       no_mode "report" "quick" ;;
    esac
```

**Step 4: Verify justfile parses**

Run: `just --justfile plugin/ralph-hero/justfile --list`
Expected: all recipes listed with group headers, no parse errors

**Step 5: Commit**

```bash
git add plugin/ralph-hero/justfile
git commit -m "refactor(cli): wire workflow recipes to cli-dispatch.sh with 3-mode routing"
```

---

### Task 4: Refactor orchestrator recipes to use cli-dispatch.sh

**Files:**
- Modify: `plugin/ralph-hero/justfile` (hero, setup recipes — team and loop stay as-is since they use custom scripts)

**Step 1: Update hero recipe**

Replace:
```just
hero issue="" budget="10.00" timeout="30m":
    @just _run_skill "hero" "{{issue}}" "{{budget}}" "{{timeout}}"
```

with:
```just
hero *args:
    #!/usr/bin/env bash
    set -eu
    source "{{justfile_directory()}}/scripts/cli-dispatch.sh"
    DEFAULT_BUDGET=10.00 DEFAULT_TIMEOUT=30m
    parse_mode {{args}}
    case "$MODE" in
        headless)    run_headless "hero" "${ARGS[@]}" ;;
        interactive) run_interactive "hero" "${ARGS[@]}" ;;
        quick)       no_mode "hero" "quick" ;;
    esac
```

**Step 2: Update setup recipe**

Replace:
```just
setup budget="1.00" timeout="10m":
    @just _run_skill "setup" "" "{{budget}}" "{{timeout}}"
```

with:
```just
setup *args:
    #!/usr/bin/env bash
    set -eu
    source "{{justfile_directory()}}/scripts/cli-dispatch.sh"
    DEFAULT_BUDGET=1.00 DEFAULT_TIMEOUT=10m
    parse_mode {{args}}
    case "$MODE" in
        headless)    run_headless "setup" "${ARGS[@]}" ;;
        interactive) run_interactive "setup" "${ARGS[@]}" ;;
        quick)       no_mode "setup" "quick" ;;
    esac
```

**Step 3: Verify justfile parses**

Run: `just --justfile plugin/ralph-hero/justfile --list`
Expected: all recipes listed, no parse errors

**Step 4: Commit**

```bash
git add plugin/ralph-hero/justfile
git commit -m "refactor(cli): wire hero and setup recipes to cli-dispatch.sh"
```

---

### Task 5: Mark _run_skill as deprecated, verify end-to-end

**Files:**
- Modify: `plugin/ralph-hero/justfile` (the `_run_skill` private recipe comment)

**Step 1: Add deprecation comment to _run_skill**

Change the comment above `_run_skill` from `[private]` to:

```just
# [DEPRECATED: recipes now source cli-dispatch.sh directly]
[private]
_run_skill skill issue budget timeout:
```

**Step 2: Verify the full justfile parses and lists correctly**

Run: `just --justfile plugin/ralph-hero/justfile --list`
Expected: grouped output with workflow, orchestrate, quick, setup groups

Run: `just --justfile plugin/ralph-hero/justfile --summary`
Expected: no errors

**Step 3: Verify cli-dispatch.sh syntax is clean**

Run: `bash -n plugin/ralph-hero/scripts/cli-dispatch.sh`
Expected: no output

**Step 4: Dry-run a recipe to verify dispatch routing**

Run:
```bash
cd plugin/ralph-hero && just --justfile justfile --dry-run research 42
```
Expected: shows the bash script that would execute, including `source` of cli-dispatch.sh

**Step 5: Commit**

```bash
git add plugin/ralph-hero/justfile
git commit -m "chore(cli): mark _run_skill as deprecated"
```

---

## Verification Checklist

After all tasks, manually verify:

| Test | Command | Expected |
|------|---------|----------|
| Headless default | `ralph research 42` | Streams output, shows summary footer with links |
| Interactive flag | `ralph research -i 42` | Opens Claude session |
| Quick mode | `ralph status -q` | Instant MCP dashboard |
| Unsupported quick | `ralph research -q` | Helpful error message |
| Budget override | `ralph plan --budget=5.00 42` | Uses $5.00 budget |
| Timeout override | `ralph impl --timeout=30m 42` | Uses 30m timeout |
| No-arg auto-pick | `ralph research` | Headless, auto-picks issue |
| Summary links | (after research completes) | Footer shows vscode:// and github.com links |
