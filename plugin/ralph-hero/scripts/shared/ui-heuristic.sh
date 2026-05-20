#!/usr/bin/env bash
# ui-heuristic.sh — shared UI-touching file detection helper
#
# Purpose:
#   Provides `is_ui_touching` — a reusable function that detects whether a set
#   of changed file paths includes UI-touching files (components, styles, or
#   Storybook artefacts). Used by scout-heuristic-smoke.sh (smoke test) and by
#   the per-PR producer workflow (Phase 3, playwright-auto.yml) to decide
#   whether to file a scout-auto issue.
#
# Public API:
#   is_ui_touching [file-paths-arg]
#
#   Accepts file paths as:
#     - A newline-separated string passed as the first positional argument, OR
#     - Newline-separated paths on stdin (pipe / heredoc)
#   Returns:
#     0  — at least one path matches the UI heuristic (MATCH)
#     1  — no path matches (NO_MATCH)
#
# Matched patterns (grep -E):
#   \.(tsx|svelte|vue|css|scss)$   — frontend source / style files
#   /components/                   — anything under a components directory
#   (^|/)storybook/                — storybook root or nested storybook dir
#
# Invocation patterns:
#
#   From bash (e.g. scout-heuristic-smoke.sh):
#     SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
#     source "$SCRIPT_DIR/shared/ui-heuristic.sh"
#     if is_ui_touching "$changed_files"; then echo "UI change detected"; fi
#
#   From a GitHub Actions workflow step (Phase 3 / playwright-auto.yml):
#     - run: |
#         source plugin/ralph-hero/scripts/shared/ui-heuristic.sh
#         if echo "${{ steps.changed.outputs.files }}" | is_ui_touching; then
#           echo "ui_touching=true" >> "$GITHUB_OUTPUT"
#         else
#           echo "ui_touching=false" >> "$GITHUB_OUTPUT"
#         fi
#
# Sourcing is idempotent — sourcing this file multiple times in the same shell
# is safe; the function definitions are skipped on subsequent sources.
#
# Note: This file does NOT call `set -euo pipefail` at top level. Sourceable
# libraries must not mutate the caller's shell options. Defensive options may
# be used locally inside individual functions if required.

# Idempotent guard — skip redefinition if already sourced.
if declare -F is_ui_touching >/dev/null 2>&1; then
  return 0 2>/dev/null || true
fi

# ---------------------------------------------------------------------------
# is_ui_touching — detect UI-touching paths
# ---------------------------------------------------------------------------
is_ui_touching() {
  local files
  if [[ $# -gt 0 ]]; then
    files="$1"
    printf '%s\n' "$files" | grep -qE '\.(tsx|svelte|vue|css|scss)$|/components/|(^|/)storybook/'
  else
    grep -qE '\.(tsx|svelte|vue|css|scss)$|/components/|(^|/)storybook/'
  fi
}

# ---------------------------------------------------------------------------
# _ui_heuristic — internal alias that delegates to is_ui_touching
#
# Preserves backward compatibility for scripts that call _ui_heuristic
# directly (e.g. scout-heuristic-smoke.sh internals during transition).
# ---------------------------------------------------------------------------
_ui_heuristic() {
  is_ui_touching "$@"
}
