#!/usr/bin/env bash
# cli-dispatch.sh — Shared dispatch functions for Ralph CLI
# Modes: headless (default), interactive (-i), quick (-q)

# Source shared env resolution
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/resolve-env.sh"

MCP_VERSION="${RALPH_MCP_VERSION:-latest}"

# portable_timeout — wraps GNU timeout with a perl fallback for macOS BSD userland.
#
# macOS ships without GNU coreutils, so `timeout` is not available by default.
# When `timeout` is absent, this function uses `perl -e 'alarm(...); exec @ARGV'`
# to enforce the deadline. perl ships pre-installed on all supported macOS versions
# (Monterey+). Exit code 124 semantics are preserved in both paths so that callers
# testing `$exit_code -eq 124` continue to work correctly.
#
# Usage: portable_timeout <duration> <command> [args...]
# Duration: supports "Nm" (minutes, e.g. "15m") or bare seconds (e.g. "900").
portable_timeout() {
    local duration="$1"; shift
    if command -v timeout &>/dev/null; then
        timeout "$duration" "$@"
        return $?
    fi
    # No GNU timeout — fall back to perl alarm
    local seconds
    if [[ "$duration" =~ ^([0-9]+)m$ ]]; then
        seconds=$(( ${BASH_REMATCH[1]} * 60 ))
    else
        seconds="$duration"
    fi
    perl -e '
        my $secs = shift @ARGV;
        my $pid = fork // die "fork: $!";
        if ($pid == 0) { exec @ARGV; die "exec: $!" }
        $SIG{ALRM} = sub { kill "TERM", $pid; kill "KILL", $pid; exit 142 };
        alarm($secs);
        waitpid($pid, 0);
        exit($? >> 8);
    ' -- "$seconds" "$@"
    local rc=$?
    if [ "$rc" -eq 142 ]; then
        return 124
    fi
    return "$rc"
}

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

# Open interactive Claude session with a skill
run_interactive() {
    local skill="$1"; shift
    local cmd="/ralph-hero:${skill}"
    if [ $# -gt 0 ] && [ -n "$1" ]; then cmd="$cmd $*"; fi
    echo ">>> Opening: $cmd"
    exec claude "$cmd"
}

# Run headless Claude session with streaming output and summary footer
run_headless() {
    local skill="$1"; shift
    local cmd="/ralph-hero:${skill}"
    if [ $# -gt 0 ] && [ -n "$1" ]; then cmd="$cmd $*"; fi

    local repo_root
    repo_root=$(git rev-parse --show-toplevel 2>/dev/null || echo "")

    echo ">>> $cmd (budget: \$$BUDGET, timeout: $TIMEOUT)"
    local start_time
    start_time=$(date +%s)

    set +e
    portable_timeout "$TIMEOUT" claude -p "$cmd" \
        --max-budget-usd "$BUDGET" \
        --dangerously-skip-permissions \
        </dev/null \
        2>&1 | _output_filter "$repo_root"
    local exit_code=${PIPESTATUS[0]}
    set -e

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

# Filter that streams output and collects links/transitions for summary
_output_filter() {
    local repo_root="$1"
    _RALPH_SUMMARY_FILE=$(mktemp /tmp/ralph-summary.XXXXXX)
    export _RALPH_SUMMARY_FILE

    awk -v repo_root="$repo_root" -v summary_file="$_RALPH_SUMMARY_FILE" '
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
        if (match($0, /[A-Z][a-zA-Z ]+(→|->)[ ]?[A-Z][a-zA-Z ]+/)) {
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

# Dispatch to the correct mode handler
# Usage: dispatch <skill> [args...]
# Pre-set: DEFAULT_BUDGET, DEFAULT_TIMEOUT
# Optional: INTERACTIVE_SKILL (defaults to skill), QUICK_TOOL + QUICK_PARAMS
dispatch() {
    local skill="$1"; shift
    parse_mode "$@"

    case "$MODE" in
        headless)    run_headless "$skill" ${ARGS[@]+"${ARGS[@]}"} ;;
        interactive) run_interactive "${INTERACTIVE_SKILL:-$skill}" ${ARGS[@]+"${ARGS[@]}"} ;;
        quick)
            if [ -n "${QUICK_TOOL:-}" ]; then
                run_quick "$QUICK_TOOL" "${QUICK_PARAMS:-{}}"
            else
                no_mode "${skill#ralph-}" "quick"
            fi
            ;;
    esac
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
    # Bridge env vars from settings files for direct MCP calls
    ralph_bridge_env
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
        interactive) echo "Try: ralph $command (headless) or ralph $command -q (quick)" ;;
        headless) echo "Try: ralph $command -i (interactive) or ralph $command -q (quick)" ;;
        quick) echo "Try: ralph $command (headless) or ralph $command -i (interactive)" ;;
    esac
    exit 1
}
