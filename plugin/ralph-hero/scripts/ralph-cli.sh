#!/usr/bin/env bash
# ralph -- global CLI for Ralph Hero workflows
# Resolves the latest installed plugin version at runtime.
set -euo pipefail

RALPH_JUSTFILE="${RALPH_JUSTFILE:-}"
RALPH_VERSION=""

# Resolve plugin cache dir and latest version
CACHE_DIR="$HOME/.claude/plugins/cache/ralph-hero/ralph-hero"
if [ -z "$RALPH_JUSTFILE" ]; then
    if [ -d "$CACHE_DIR" ]; then
        LATEST=$(ls "$CACHE_DIR" | sort -V | tail -1)
        RALPH_JUSTFILE="$CACHE_DIR/$LATEST/justfile"
    fi
fi

# Read version from plugin.json if available
if [ -d "$CACHE_DIR" ]; then
    LATEST=$(ls "$CACHE_DIR" | sort -V | tail -1)
    PLUGIN_JSON="$CACHE_DIR/$LATEST/.claude-plugin/plugin.json"
    if [ -f "$PLUGIN_JSON" ] && command -v jq &>/dev/null; then
        RALPH_VERSION=$(jq -r '.version // empty' "$PLUGIN_JSON" 2>/dev/null || echo "")
    fi
    if [ -z "$RALPH_VERSION" ]; then
        RALPH_VERSION="${LATEST:-unknown}"
    fi
fi

# --version flag
if [ "${1:-}" = "--version" ] || [ "${1:-}" = "-V" ]; then
    echo "ralph version ${RALPH_VERSION}"
    exit 0
fi

# --help flag
if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
    cat <<EOF
Usage: ralph <command> [options]

Ralph Hero — autonomous GitHub Projects V2 workflow automation.

Common commands:
  loop        Run the full analyst+builder+integrator loop
  impl        Implement the next In Progress issue
  plan        Write an implementation plan for the next issue
  triage      Triage new issues onto the project board
  research    Run the research phase for an issue
  review      Review an implementation plan
  hygiene     Run project hygiene checks
  doctor      Diagnose your Ralph installation

Options:
  --version, -V   Print the installed Ralph version and exit
  --help,    -h   Print this help message and exit
  -i              Run in interactive mode (opens Claude session)
  -q              Run in quick mode (direct MCP tool call)
  --budget=N      Set spend cap in USD (default: 2.00)
  --timeout=T     Set per-task timeout (default: 15m)

Examples:
  ralph loop                 # Run the full workflow loop
  ralph impl 42              # Implement issue #42
  ralph triage -q            # Quick-triage without AI
  ralph loop --budget=5.00   # Loop with a higher budget cap

Docs: https://github.com/cdubiel08/ralph-hero
EOF
    exit 0
fi

if [ -z "$RALPH_JUSTFILE" ] || [ ! -f "$RALPH_JUSTFILE" ]; then
    echo "Error: Ralph justfile not found."
    echo "Install: claude plugin install https://github.com/cdubiel08/ralph-hero"
    exit 1
fi

# Welcome banner on first run
RALPH_STATE_DIR="${RALPH_STATE_DIR:-$HOME/.ralph}"
WELCOMED_FILE="$RALPH_STATE_DIR/welcomed"
if [ ! -f "$WELCOMED_FILE" ]; then
    mkdir -p "$RALPH_STATE_DIR"
    cat <<EOF

  Welcome to Ralph v${RALPH_VERSION}!
  Autonomous GitHub Projects V2 workflow automation.

  Run 'ralph --help' to see available commands.
  Run 'ralph loop' to start the full workflow.

EOF
    touch "$WELCOMED_FILE"
fi

exec just --justfile "$RALPH_JUSTFILE" "$@"
