#!/usr/bin/env bash
# ralph -- global CLI for Ralph Hero workflows
# Resolves the latest installed plugin version at runtime.
set -euo pipefail

RALPH_JUSTFILE="${RALPH_JUSTFILE:-}"

if [ -z "$RALPH_JUSTFILE" ]; then
    CACHE_DIR="$HOME/.claude/plugins/cache/ralph-hero/ralph-hero"
    if [ -d "$CACHE_DIR" ]; then
        LATEST=$(ls "$CACHE_DIR" | sort -V | tail -1)
        RALPH_JUSTFILE="$CACHE_DIR/$LATEST/justfile"
    fi
fi

if [ -z "$RALPH_JUSTFILE" ] || [ ! -f "$RALPH_JUSTFILE" ]; then
    echo "Error: Ralph justfile not found."
    echo "Install: claude plugin install https://github.com/cdubiel08/ralph-hero"
    exit 1
fi

exec just --justfile "$RALPH_JUSTFILE" "$@"
