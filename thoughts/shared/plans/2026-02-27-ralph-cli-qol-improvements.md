---
type: plan
date: 2026-02-27
status: draft
github_issues: []
github_urls: []
primary_issue: null
---

# Ralph CLI Unified Namespace & 3-Mode Dispatch

## Overview

Refactor the Ralph CLI from two separate command tiers (workflow vs quick-*) into a unified namespace where every command supports up to 3 execution modes: **interactive** (default), **headless** (`-h`), and **quick** (`-q`). Also fix the TTY hanging bug and add new QoL commands for the core research → plan → implement flow.

## Current State Analysis

The justfile has two separate command tiers:
- **Workflow recipes** (triage, research, plan, impl, etc.) always launch `claude -p` via `_run_skill`
- **Quick recipes** (quick-status, quick-info, quick-issue, etc.) always call MCP directly via `_mcp_call`

These are separate namespaces with different aliases. Users must know which tier to use.

### Key Discoveries:
- `_run_skill` (justfile:343) always uses `claude -p` (headless) — there's no way to open an interactive session
- Interactive skills exist (`create-plan`, `research-codebase`, `implement-plan`) but aren't exposed via CLI
- `alias issue := quick-info` (justfile:19) maps to the wrong tool
- `_run_skill` doesn't redirect stdin → Claude process gets SIGTSTP'd (confirmed: PID 2181077 in `T` state)
- `_mcp_call` (justfile:372) hardcodes MCP server version `2.4.88`

### Skill Mapping (Interactive vs Headless):
| Core Flow | Interactive Skill | Headless Skill | Quick MCP Tool |
|-----------|------------------|----------------|----------------|
| research | `research-codebase` | `ralph-research` | — |
| plan | `create-plan` | `ralph-plan` | — |
| review | `ralph-review` (interactive mode) | `ralph-review` (auto mode) | — |
| impl | `implement-plan` | `ralph-impl` | — |
| triage | `ralph-triage` | `ralph-triage` | — |
| split | `ralph-split` | `ralph-split` | — |
| status | `ralph-status` | `ralph-status` | `pipeline_dashboard` |
| hygiene | `ralph-hygiene` | `ralph-hygiene` | `project_hygiene` |

## Desired End State

Every command in a single namespace with 3 modes:

```bash
ralph plan 42          # Interactive: opens Claude session with /ralph-hero:create-plan #42
ralph plan -h 42       # Headless: claude -p "/ralph-hero:ralph-plan 42" (print & exit)
ralph plan -q 42       # Quick: error (no MCP shortcut for planning)

ralph status           # Interactive: opens Claude session with /ralph-hero:ralph-status
ralph status -h        # Headless: claude -p "/ralph-hero:ralph-status"
ralph status -q        # Quick: instant MCP pipeline_dashboard call

ralph issue "fix bug"  # Interactive: opens Claude to create issue with AI help
ralph issue -h "fix"   # Headless: claude -p to create issue
ralph issue -q "fix"   # Quick: instant MCP create_issue call

ralph info 42          # Quick by default (instant MCP get_issue)
ralph info -h 42       # Headless: claude -p to explain issue
ralph ls "In Progress" # Quick-only: instant MCP list_issues
ralph deps 42          # Quick-only: instant MCP list_dependencies
ralph where 42         # Quick-only: instant MCP detect_pipeline_position
ralph approve 42       # Quick by default (instant MCP state transition)
ralph approve -h 42    # Headless: claude -p ralph-review
ralph next             # Quick by default (instant MCP pick_actionable_issue)
ralph kill             # Utility: kill stale MCP processes
```

### Command Map (Complete):

| Command | Default Mode | Interactive Skill | Headless Skill | Quick MCP Tool |
|---------|-------------|-------------------|----------------|----------------|
| **Core Flow** | | | | |
| `triage [N]` | interactive | `ralph-triage` | `ralph-triage` | — |
| `split [N]` | interactive | `ralph-split` | `ralph-split` | — |
| `research [N]` | interactive | `research-codebase` | `ralph-research` | — |
| `plan [N]` | interactive | `create-plan` | `ralph-plan` | — |
| `review [N]` | interactive | `ralph-review` | `ralph-review` | — |
| `impl [N]` | interactive | `implement-plan` | `ralph-impl` | — |
| **Board** | | | | |
| `status` | interactive | `ralph-status` | `ralph-status` | `pipeline_dashboard` |
| `hygiene` | interactive | `ralph-hygiene` | `ralph-hygiene` | `project_hygiene` |
| `report` | interactive | `ralph-report` | `ralph-report` | — |
| **Issue Ops** | | | | |
| `issue "ctx"` | interactive | prompt-based | prompt-based | `create_issue` |
| `info N` | quick | — | prompt-based | `get_issue` |
| `comment N "body"` | interactive | prompt-based | prompt-based | `create_comment` |
| `draft "title"` | quick | — | — | `create_draft_issue` |
| **Pipeline Ops** | | | | |
| `approve N` | quick | — | `ralph-review` | `update_workflow_state` |
| `next [state]` | quick | — | prompt-based | `pick_actionable_issue` |
| `move N "state"` | quick | — | — | `update_workflow_state` |
| `ls [state]` | quick | — | — | `list_issues` |
| `deps N` | quick | — | — | `list_dependencies` |
| `where N` | quick | — | — | `detect_pipeline_position` |
| `assign N user` | quick | — | — | `update_issue` |
| **Orchestrators** | | | | |
| `hero N` | headless | — | `ralph-hero` | — |
| `team N` | headless | — | script-based | — |
| `loop` | headless | — | script-based | — |
| **Utility** | | | | |
| `kill` | utility | — | — | process cleanup |
| `doctor` | utility | — | — | env check |
| `setup` | interactive | `ralph-setup` | `ralph-setup` | — |

### Aliases:
```
t  := triage       s  := status      i  := impl
r  := research     h  := hygiene     sp := split
p  := plan
```

## What We're NOT Doing

- Not modifying the MCP server — all changes are justfile + dispatch script
- Not adding a `ralph go` auto-advance command (future scope)
- Not removing `quick-*` prefixed recipes (keep for backward compat, mark deprecated)
- Not changing skill definitions — dispatch maps to existing skills

## Implementation Approach

1. Create a shared `scripts/cli-dispatch.sh` with three functions: `run_interactive`, `run_headless`, `run_quick`
2. Add a `parse_mode` function that extracts `-h`/`-q` flags from args
3. Refactor each justfile recipe to source the dispatch script and route by mode
4. Keep old `quick-*` and `_run_skill`/`_mcp_call` recipes for backward compat
5. Add new commands (approve, next, ls, deps, where, kill)

---

## Phase 1: Dispatch Infrastructure

### Overview
Create the shared dispatch script that handles 3-mode routing, TTY fix, and timing.

### Changes Required:

#### 1. Create `scripts/cli-dispatch.sh`
**File**: `plugin/ralph-hero/scripts/cli-dispatch.sh`

```bash
#!/usr/bin/env bash
# cli-dispatch.sh — Shared dispatch functions for Ralph CLI
# Modes: interactive (default), headless (-h), quick (-q)

MCP_VERSION="2.4.88"

# Parse -h/-q/--budget/--timeout flags from args
# Sets: MODE, ARGS (array), BUDGET, TIMEOUT
parse_mode() {
    MODE="${DEFAULT_MODE:-interactive}"
    ARGS=()
    BUDGET="${DEFAULT_BUDGET:-2.00}"
    TIMEOUT="${DEFAULT_TIMEOUT:-15m}"

    for arg in "$@"; do
        case "$arg" in
            -h|--headless) MODE="headless" ;;
            -q|--quick) MODE="quick" ;;
            --budget=*) BUDGET="${arg#--budget=}" ;;
            --timeout=*) TIMEOUT="${arg#--timeout=}" ;;
            *) ARGS+=("$arg") ;;
        esac
    done
}

# Open interactive Claude session with a skill
run_interactive() {
    local skill="$1"; shift
    local cmd="/ralph-hero:${skill}"
    if [ $# -gt 0 ] && [ -n "$1" ]; then cmd="$cmd $*"; fi
    echo ">>> Opening: $cmd"
    exec claude "$cmd"
}

# Run headless Claude session (print & exit)
run_headless() {
    local skill="$1"; shift
    local cmd="/ralph-hero:${skill}"
    if [ $# -gt 0 ] && [ -n "$1" ]; then cmd="$cmd $*"; fi
    echo ">>> Running: $cmd (budget: \$$BUDGET, timeout: $TIMEOUT)"
    local start_time
    start_time=$(date +%s)
    if timeout "$TIMEOUT" claude -p "$cmd" \
        --max-budget-usd "$BUDGET" \
        --dangerously-skip-permissions \
        </dev/null \
        2>&1; then
        local elapsed=$(( $(date +%s) - start_time ))
        echo ">>> Completed (${elapsed}s)"
    else
        local exit_code=$?
        local elapsed=$(( $(date +%s) - start_time ))
        if [ "$exit_code" -eq 124 ]; then
            echo ">>> Timed out after $TIMEOUT (${elapsed}s)"
            echo "    Try increasing: --timeout=30m"
        else
            echo ">>> Exited with code $exit_code (${elapsed}s)"
            echo "    Run: ralph doctor"
        fi
    fi
}

# Direct MCP tool call (instant, no AI)
run_quick() {
    local tool="$1"
    local params="$2"
    if ! command -v mcp &>/dev/null; then
        echo "Error: mcptools not installed."
        echo "Install: brew tap f/mcptools && brew install mcp"
        echo "   or: go install github.com/f/mcptools/cmd/mcptools@latest"
        exit 1
    fi
    local raw
    raw=$(mcp call "$tool" --params "$params" \
        npx -y "ralph-hero-mcp-server@${MCP_VERSION}") || {
        echo "Error: MCP call to $tool failed." >&2
        echo "Run: ralph doctor" >&2
        exit 1
    }
    if command -v jq &>/dev/null; then
        if echo "$raw" | jq -e '.isError // false' > /dev/null 2>&1; then
            echo "$raw" | jq -r '.content[0].text' >&2
            exit 1
        fi
        echo "$raw" | jq -r '.content[0].text // .' | jq '.' 2>/dev/null \
            || echo "$raw" | jq -r '.content[0].text // .'
    else
        echo "$raw"
    fi
}

# Error for unsupported mode
no_mode() {
    local command="$1"
    local mode="$2"
    echo "Error: '$command' does not support $mode mode."
    case "$mode" in
        interactive) echo "Try: ralph $command -h (headless) or ralph $command -q (quick)" ;;
        headless) echo "Try: ralph $command (interactive) or ralph $command -q (quick)" ;;
        quick) echo "Try: ralph $command (interactive) or ralph $command -h (headless)" ;;
    esac
    exit 1
}
```

### Success Criteria:

#### Automated Verification:
- [x] `bash -n plugin/ralph-hero/scripts/cli-dispatch.sh` — no syntax errors
- [ ] File is sourced correctly from justfile context

#### Manual Verification:
- [ ] Functions are available after sourcing

**Implementation Note**: After completing this phase, pause for manual confirmation.

---

## Phase 2: Refactor Core Flow Commands

### Overview
Replace the existing workflow recipes with 3-mode dispatched versions. The core flow commands (triage, split, research, plan, review, impl) default to interactive mode.

### Changes Required:

#### 1. Refactor Core Flow Recipes
**File**: `plugin/ralph-hero/justfile`

Replace the existing recipes with dispatched versions. Example for each pattern:

**Pattern A: Different interactive vs headless skill** (research, plan, impl)
```just
# Research an issue - investigate codebase, create findings document
[group('workflow')]
research *args:
    #!/usr/bin/env bash
    set -eu
    source "{{justfile_directory()}}/scripts/cli-dispatch.sh"
    DEFAULT_BUDGET=2.00 DEFAULT_TIMEOUT=15m
    parse_mode {{args}}
    case "$MODE" in
        interactive) run_interactive "research-codebase" "${ARGS[@]}" ;;
        headless)    run_headless "ralph-research" "${ARGS[@]}" ;;
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
        interactive) run_interactive "create-plan" "${ARGS[@]}" ;;
        headless)    run_headless "ralph-plan" "${ARGS[@]}" ;;
        quick)       no_mode "plan" "quick" ;;
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
        interactive) run_interactive "implement-plan" "${ARGS[@]}" ;;
        headless)    run_headless "ralph-impl" "${ARGS[@]}" ;;
        quick)       no_mode "impl" "quick" ;;
    esac
```

**Pattern B: Same skill for both modes** (triage, split, review, status, hygiene, report)
```just
# Triage a backlog issue
[group('workflow')]
triage *args:
    #!/usr/bin/env bash
    set -eu
    source "{{justfile_directory()}}/scripts/cli-dispatch.sh"
    DEFAULT_BUDGET=1.00 DEFAULT_TIMEOUT=15m
    parse_mode {{args}}
    case "$MODE" in
        interactive) run_interactive "ralph-triage" "${ARGS[@]}" ;;
        headless)    run_headless "ralph-triage" "${ARGS[@]}" ;;
        quick)       no_mode "triage" "quick" ;;
    esac

# Split a large issue into smaller sub-issues
[group('workflow')]
split *args:
    #!/usr/bin/env bash
    set -eu
    source "{{justfile_directory()}}/scripts/cli-dispatch.sh"
    DEFAULT_BUDGET=1.00 DEFAULT_TIMEOUT=15m
    parse_mode {{args}}
    case "$MODE" in
        interactive) run_interactive "ralph-split" "${ARGS[@]}" ;;
        headless)    run_headless "ralph-split" "${ARGS[@]}" ;;
        quick)       no_mode "split" "quick" ;;
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
        interactive) run_interactive "ralph-review" "${ARGS[@]}" ;;
        headless)    run_headless "ralph-review" "${ARGS[@]}" ;;
        quick)       no_mode "review" "quick" ;;
    esac
```

**Pattern C: All 3 modes** (status, hygiene)
```just
# Pipeline status dashboard
[group('workflow')]
status *args:
    #!/usr/bin/env bash
    set -eu
    source "{{justfile_directory()}}/scripts/cli-dispatch.sh"
    DEFAULT_BUDGET=0.50 DEFAULT_TIMEOUT=10m
    parse_mode {{args}}
    case "$MODE" in
        interactive) run_interactive "ralph-status" "${ARGS[@]}" ;;
        headless)    run_headless "ralph-status" "${ARGS[@]}" ;;
        quick)       run_quick "ralph_hero__pipeline_dashboard" \
                         '{"format":"markdown","includeHealth":true}' ;;
    esac

# Project hygiene check
[group('workflow')]
hygiene *args:
    #!/usr/bin/env bash
    set -eu
    source "{{justfile_directory()}}/scripts/cli-dispatch.sh"
    DEFAULT_BUDGET=0.50 DEFAULT_TIMEOUT=10m
    parse_mode {{args}}
    case "$MODE" in
        interactive) run_interactive "ralph-hygiene" "${ARGS[@]}" ;;
        headless)    run_headless "ralph-hygiene" "${ARGS[@]}" ;;
        quick)       run_quick "ralph_hero__project_hygiene" '{}' ;;
    esac

# Generate project status report
[group('workflow')]
report *args:
    #!/usr/bin/env bash
    set -eu
    source "{{justfile_directory()}}/scripts/cli-dispatch.sh"
    DEFAULT_BUDGET=1.00 DEFAULT_TIMEOUT=10m
    parse_mode {{args}}
    case "$MODE" in
        interactive) run_interactive "ralph-report" "${ARGS[@]}" ;;
        headless)    run_headless "ralph-report" "${ARGS[@]}" ;;
        quick)       no_mode "report" "quick" ;;
    esac
```

#### 2. Update Aliases
```just
alias t  := triage
alias r  := research
alias p  := plan
alias i  := impl
alias s  := status
alias sp := split
alias h  := hygiene
```

Remove old `alias issue := quick-info`. New `issue` and `info` are standalone recipes (Phase 3).

### Success Criteria:

#### Automated Verification:
- [x] `just --justfile plugin/ralph-hero/justfile --summary` parses without errors
- [x] `just --justfile plugin/ralph-hero/justfile --list` shows all recipes

#### Manual Verification:
- [ ] `ralph plan 42` opens interactive Claude session
- [ ] `ralph plan -h 42` runs headless and completes
- [ ] `ralph status -q` returns instant dashboard
- [ ] `ralph research -q` shows helpful "not supported" error

**Implementation Note**: After completing this phase, pause for manual testing.

---

## Phase 3: Issue Ops & Pipeline Ops Commands

### Overview
Add the new unified commands for issue operations and pipeline operations.

### Changes Required:

#### 1. Issue Operations

```just
# Create a new issue (AI-assisted by default)
[group('issues')]
issue *args:
    #!/usr/bin/env bash
    set -eu
    source "{{justfile_directory()}}/scripts/cli-dispatch.sh"
    DEFAULT_BUDGET=1.00 DEFAULT_TIMEOUT=10m
    parse_mode {{args}}
    context="${ARGS[*]:-}"
    if [ -z "$context" ]; then
        echo "Usage: ralph issue \"description of the issue\""
        echo "Flags: -q (instant, no AI)  -h (headless AI)"
        exit 1
    fi
    case "$MODE" in
        interactive)
            exec claude "Create a GitHub issue from this context: $context. Use ralph_hero__create_issue to create it. Ask me for any missing details (labels, priority, estimate)." ;;
        headless)
            echo ">>> Creating issue: $context"
            timeout "$TIMEOUT" claude -p \
                "Create a GitHub issue with title derived from: $context. Use ralph_hero__create_issue. Set workflowState to Backlog." \
                --max-budget-usd "$BUDGET" \
                --dangerously-skip-permissions \
                </dev/null 2>&1 ;;
        quick)
            # In quick mode, first arg is used as title directly
            title="$context"
            run_quick "ralph_hero__create_issue" \
                "{\"title\":\"$title\",\"workflowState\":\"Backlog\"}" ;;
    esac

# Get issue details
[group('issues')]
info *args:
    #!/usr/bin/env bash
    set -eu
    source "{{justfile_directory()}}/scripts/cli-dispatch.sh"
    DEFAULT_MODE=quick
    parse_mode {{args}}
    issue="${ARGS[0]:-}"
    if [ -z "$issue" ]; then
        echo "Usage: ralph info <issue-number>"
        exit 1
    fi
    case "$MODE" in
        interactive)
            exec claude "Get issue #$issue using ralph_hero__get_issue and explain it to me. Show key details, current state, and any blockers." ;;
        headless)
            DEFAULT_BUDGET=0.50 DEFAULT_TIMEOUT=5m
            run_headless "ralph-status" "$issue" ;;
        quick)
            run_quick "ralph_hero__get_issue" "{\"number\":$issue}" ;;
    esac

# Add a comment to an issue
[group('issues')]
comment *args:
    #!/usr/bin/env bash
    set -eu
    source "{{justfile_directory()}}/scripts/cli-dispatch.sh"
    DEFAULT_BUDGET=0.50 DEFAULT_TIMEOUT=5m
    parse_mode {{args}}
    issue="${ARGS[0]:-}"
    shift_args=("${ARGS[@]:1}")
    body="${shift_args[*]:-}"
    if [ -z "$issue" ] || [ -z "$body" ]; then
        echo "Usage: ralph comment <issue-number> \"comment body\""
        exit 1
    fi
    case "$MODE" in
        interactive)
            exec claude "Add a comment to issue #$issue. The user wants to say: $body. Use ralph_hero__create_comment. Help me refine the comment first." ;;
        headless)
            timeout "$TIMEOUT" claude -p \
                "Add this comment to issue #$issue using ralph_hero__create_comment: $body" \
                --max-budget-usd "$BUDGET" \
                --dangerously-skip-permissions \
                </dev/null 2>&1 ;;
        quick)
            run_quick "ralph_hero__create_comment" \
                "{\"number\":$issue,\"body\":\"$body\"}" ;;
    esac

# Create a draft card on the project board
[group('issues')]
draft *args:
    #!/usr/bin/env bash
    set -eu
    source "{{justfile_directory()}}/scripts/cli-dispatch.sh"
    DEFAULT_MODE=quick
    parse_mode {{args}}
    title="${ARGS[*]:-}"
    if [ -z "$title" ]; then
        echo "Usage: ralph draft \"card title\""
        exit 1
    fi
    case "$MODE" in
        interactive|headless) no_mode "draft" "$MODE" ;;
        quick) run_quick "ralph_hero__create_draft_issue" \
                   "{\"title\":\"$title\",\"workflowState\":\"Backlog\"}" ;;
    esac
```

#### 2. Pipeline Operations

```just
# Approve a plan — move from Plan in Review to In Progress
[group('pipeline')]
approve *args:
    #!/usr/bin/env bash
    set -eu
    source "{{justfile_directory()}}/scripts/cli-dispatch.sh"
    DEFAULT_MODE=quick DEFAULT_BUDGET=2.00 DEFAULT_TIMEOUT=15m
    parse_mode {{args}}
    issue="${ARGS[0]:-}"
    if [ -z "$issue" ]; then
        echo "Usage: ralph approve <issue-number>"
        exit 1
    fi
    case "$MODE" in
        interactive)
            exec claude "Review and approve the plan for issue #$issue. Use ralph_hero__get_issue to read it, then if the plan looks good, use ralph_hero__update_workflow_state to move it to In Progress." ;;
        headless)
            run_headless "ralph-review" "$issue" ;;
        quick)
            run_quick "ralph_hero__update_workflow_state" \
                "{\"number\":$issue,\"state\":\"In Progress\",\"command\":\"ralph_review\"}" ;;
    esac

# Find next actionable issue
[group('pipeline')]
next *args:
    #!/usr/bin/env bash
    set -eu
    source "{{justfile_directory()}}/scripts/cli-dispatch.sh"
    DEFAULT_MODE=quick
    parse_mode {{args}}
    state="${ARGS[0]:-Research Needed}"
    case "$MODE" in
        interactive)
            exec claude "Find the next actionable issue to work on using ralph_hero__pick_actionable_issue. Explain what it is and suggest what to do." ;;
        headless)
            timeout "${TIMEOUT:-5m}" claude -p \
                "Find the next actionable issue using ralph_hero__pick_actionable_issue with workflowState '$state'. Show the result." \
                --max-budget-usd "${BUDGET:-0.50}" \
                --dangerously-skip-permissions \
                </dev/null 2>&1 ;;
        quick)
            run_quick "ralph_hero__pick_actionable_issue" \
                "{\"workflowState\":\"$state\",\"maxEstimate\":\"S\"}" ;;
    esac

# Move issue to a workflow state
[group('pipeline')]
move *args:
    #!/usr/bin/env bash
    set -eu
    source "{{justfile_directory()}}/scripts/cli-dispatch.sh"
    DEFAULT_MODE=quick
    parse_mode {{args}}
    issue="${ARGS[0]:-}"
    state="${ARGS[1]:-}"
    if [ -z "$issue" ] || [ -z "$state" ]; then
        echo "Usage: ralph move <issue-number> \"State Name\""
        exit 1
    fi
    case "$MODE" in
        interactive|headless) no_mode "move" "$MODE" ;;
        quick) run_quick "ralph_hero__update_workflow_state" \
                   "{\"number\":$issue,\"state\":\"$state\",\"command\":\"ralph_cli\"}" ;;
    esac

# List issues by workflow state
[group('pipeline')]
ls *args:
    #!/usr/bin/env bash
    set -eu
    source "{{justfile_directory()}}/scripts/cli-dispatch.sh"
    DEFAULT_MODE=quick
    parse_mode {{args}}
    state="${ARGS[0]:-}"
    case "$MODE" in
        interactive|headless) no_mode "ls" "$MODE" ;;
        quick)
            if [ -n "$state" ]; then
                run_quick "ralph_hero__list_issues" "{\"workflowState\":\"$state\"}"
            else
                run_quick "ralph_hero__list_issues" '{}'
            fi ;;
    esac

# Show dependencies for an issue
[group('pipeline')]
deps *args:
    #!/usr/bin/env bash
    set -eu
    source "{{justfile_directory()}}/scripts/cli-dispatch.sh"
    DEFAULT_MODE=quick
    parse_mode {{args}}
    issue="${ARGS[0]:-}"
    if [ -z "$issue" ]; then echo "Usage: ralph deps <issue-number>"; exit 1; fi
    case "$MODE" in
        interactive|headless) no_mode "deps" "$MODE" ;;
        quick) run_quick "ralph_hero__list_dependencies" "{\"number\":$issue}" ;;
    esac

# Detect pipeline position for an issue
[group('pipeline')]
where *args:
    #!/usr/bin/env bash
    set -eu
    source "{{justfile_directory()}}/scripts/cli-dispatch.sh"
    DEFAULT_MODE=quick
    parse_mode {{args}}
    issue="${ARGS[0]:-}"
    if [ -z "$issue" ]; then echo "Usage: ralph where <issue-number>"; exit 1; fi
    case "$MODE" in
        interactive|headless) no_mode "where" "$MODE" ;;
        quick) run_quick "ralph_hero__detect_pipeline_position" "{\"number\":$issue}" ;;
    esac

# Assign issue to a GitHub user
[group('pipeline')]
assign *args:
    #!/usr/bin/env bash
    set -eu
    source "{{justfile_directory()}}/scripts/cli-dispatch.sh"
    DEFAULT_MODE=quick
    parse_mode {{args}}
    issue="${ARGS[0]:-}"
    user="${ARGS[1]:-}"
    if [ -z "$issue" ] || [ -z "$user" ]; then
        echo "Usage: ralph assign <issue-number> <github-username>"
        exit 1
    fi
    case "$MODE" in
        interactive|headless) no_mode "assign" "$MODE" ;;
        quick) run_quick "ralph_hero__update_issue" \
                   "{\"number\":$issue,\"assignees\":[\"$user\"]}" ;;
    esac
```

#### 3. Utility Commands

```just
# Kill orphaned ralph-hero MCP server processes
[group('setup')]
[confirm('Kill all ralph-hero-mcp-server processes?')]
kill:
    #!/usr/bin/env bash
    set -eu
    pids=$(pgrep -f "ralph-hero-mcp-server" 2>/dev/null || true)
    if [ -z "$pids" ]; then
        echo "No ralph-hero-mcp-server processes found."
        exit 0
    fi
    echo "Found processes:"
    ps -p $(echo "$pids" | tr '\n' ',') -o pid,etime,args --no-headers 2>/dev/null || true
    kill $pids 2>/dev/null || true
    echo "Sent SIGTERM to $(echo "$pids" | wc -w) process(es)."
```

#### 4. Keep Orchestrators As-Is
`hero`, `team`, `loop` keep their current behavior (they're already headless by nature).

#### 5. Deprecate Old Quick-* Recipes
Mark old `quick-*` recipes with deprecation comments but keep them working:
```just
# [DEPRECATED: use 'ralph info -q <N>'] Get issue details
[group('deprecated')]
quick-info issue:
    @just _mcp_call "ralph_hero__get_issue" '{"number":{{issue}}}'
```

#### 6. Update Completions
**File**: `plugin/ralph-hero/scripts/ralph-completions.bash`
**File**: `plugin/ralph-hero/scripts/ralph-completions.zsh`

Update word lists with all new commands:
```
triage split research plan review impl status hygiene report
issue info comment draft approve next move ls deps where assign
hero team loop setup doctor kill
```

### Success Criteria:

#### Automated Verification:
- [x] `just --justfile plugin/ralph-hero/justfile --summary` parses without errors
- [x] `just --justfile plugin/ralph-hero/justfile --list` shows all new recipes grouped correctly
- [x] `bash -n plugin/ralph-hero/scripts/cli-dispatch.sh` passes

#### Manual Verification:
- [ ] `ralph issue "test issue"` opens interactive Claude session
- [ ] `ralph issue -q "test issue"` creates issue instantly via MCP
- [ ] `ralph info 42` returns issue details instantly (default=quick)
- [ ] `ralph approve 42` moves issue state instantly (default=quick)
- [ ] `ralph next` finds next actionable issue
- [ ] `ralph ls "In Progress"` lists issues
- [ ] `ralph deps 42` shows dependencies
- [ ] `ralph where 42` shows pipeline position
- [ ] `ralph kill` cleans up stale processes
- [ ] `ralph plan 42` opens interactive Claude session (default=interactive)
- [ ] `ralph plan -h 42` runs headless and completes
- [ ] `ralph plan -q 42` shows "not supported" error
- [ ] `ralph status -q` returns instant dashboard

**Implementation Note**: After completing this phase, pause for comprehensive manual testing.

---

## Testing Strategy

### Smoke Test Matrix:
| Command | Default | -h | -q |
|---------|---------|----|----|
| `ralph plan 42` | interactive session | headless print | "not supported" error |
| `ralph status` | interactive session | headless print | instant MCP |
| `ralph issue "test"` | interactive session | headless print | instant MCP |
| `ralph info 42` | instant MCP | headless print | instant MCP |
| `ralph approve 42` | instant MCP | headless review | instant MCP |
| `ralph ls` | instant MCP | "not supported" | instant MCP |

### Edge Cases:
- `ralph plan` with no args → interactive session prompts for issue
- `ralph issue` with no args → usage error
- `ralph info abc` (non-numeric) → MCP error
- Missing `mcp` binary → helpful install message for `-q` mode
- Missing `claude` binary → helpful message for interactive/headless modes

## Performance Considerations

- Interactive mode: ~1-2s to open Claude session
- Headless mode: 10-30s typical (Claude startup + API call)
- Quick mode: 2-3s (MCP server startup via npx + API call)
- The TTY fix (`</dev/null`) prevents indefinite hangs in headless mode

## References

- Justfile: `plugin/ralph-hero/justfile`
- Dispatch script: `plugin/ralph-hero/scripts/cli-dispatch.sh` (new)
- CLI wrapper: `plugin/ralph-hero/scripts/ralph-cli.sh`
- Interactive skills: `create-plan`, `research-codebase`, `implement-plan`
- Headless skills: `ralph-triage`, `ralph-research`, `ralph-plan`, `ralph-impl`, etc.
- Workflow states: `mcp-server/src/lib/workflow-states.ts`
- State transitions: `mcp-server/src/lib/state-resolution.ts`
