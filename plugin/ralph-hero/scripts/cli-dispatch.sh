#!/usr/bin/env bash
# cli-dispatch.sh — Shared dispatch functions for Ralph CLI
# Modes: interactive (default), headless (-h), quick (-q)

MCP_VERSION="2.4.109"

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
