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

Workflow commands (AI-powered):
  triage              Triage backlog issues
  research            Investigate an issue
  plan                Write implementation plan
  impl                Implement from plan
  review              Critique a plan
  hygiene             Run project hygiene
  report              Post status report

Quick commands (instant, no AI cost):
  status              Pipeline dashboard
  issue <title>       Create a new issue
  move <num> <state>  Change workflow state
  info <num>          Get issue details
  comment <num> <body>  Add a comment
  assign <num> <user> Assign to a user
  pick                Find next actionable issue
  draft <title>       Create a draft card

Orchestrators:
  hero                Drive issue through full lifecycle
  team                Spawn multi-agent team
  loop                Sequential autonomous loop

Setup:
  doctor              Diagnose installation
  setup               Create GitHub Project V2

Options:
  --version, -V       Print installed version
  --help, -h          Print this help
  -i                  Interactive mode (opens Claude session)
  -q                  Quick mode (direct MCP call)
  --budget=N          Spend cap in USD (default varies by command)
  --timeout=T         Per-task timeout (default: 15m)

Examples:
  ralph status                              # Pipeline dashboard (instant)
  ralph issue "fix login bug" priority=P1   # Create issue with priority
  ralph triage                              # Triage next backlog issue
  ralph move 42 "In Progress"              # Move issue to new state
  ralph impl -i 42                          # Implement interactively

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

# Export version for cli-dispatch.sh and justfile _mcp_call
export RALPH_MCP_VERSION="${LATEST:-latest}"

# Pre-flight: check if recipe exists before exec (preserves streaming)
if [ $# -gt 0 ]; then
    _recipe="$1"
    # Skip pre-flight for flags (--help, --version already handled above)
    case "$_recipe" in
        -*) ;;  # flags pass through to just
        *)
            _recipes=$(just --justfile "$RALPH_JUSTFILE" --working-directory "$(pwd)" --summary 2>/dev/null)
            if ! echo "$_recipes" | tr ' ' '\n' | grep -qx "$_recipe"; then
                # Try prefix match (e.g., "isue" → "issue") — try 2-char then 3-char prefix
                _suggestion=$(echo "$_recipes" | tr ' ' '\n' | grep "^${_recipe:0:2}" | head -1 || true)
                if [ -z "$_suggestion" ]; then
                    _suggestion=$(echo "$_recipes" | tr ' ' '\n' | grep "^${_recipe:0:3}" | head -1 || true)
                fi
                # Try substring match as fallback
                if [ -z "$_suggestion" ]; then
                    _suggestion=$(echo "$_recipes" | tr ' ' '\n' | grep "$_recipe" | head -1 || true)
                fi
                echo "Error: Unknown command '$_recipe'."
                if [ -n "${_suggestion:-}" ]; then
                    echo "Did you mean '$_suggestion'?"
                fi
                echo ""
                echo "Run 'ralph --help' for available commands."
                exit 1
            fi
            ;;
    esac
fi

exec just --justfile "$RALPH_JUSTFILE" --working-directory "$(pwd)" "$@"
