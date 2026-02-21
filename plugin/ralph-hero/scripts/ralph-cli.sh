#!/usr/bin/env bash
# ralph -- global CLI for Ralph Hero workflows
# Delegates to just --justfile, resolving the justfile via symlink or env var.
set -euo pipefail

RALPH_JUSTFILE="${RALPH_JUSTFILE:-$HOME/.config/ralph-hero/justfile}"

if [ ! -f "$RALPH_JUSTFILE" ]; then
    echo "Error: Ralph justfile not found at $RALPH_JUSTFILE"
    echo "Run 'just install-cli' from the ralph-hero plugin directory to set up."
    exit 1
fi

exec just --justfile "$RALPH_JUSTFILE" "$@"
