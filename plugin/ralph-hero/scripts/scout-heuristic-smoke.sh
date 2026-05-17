#!/usr/bin/env bash
# scout-heuristic-smoke.sh — smoke test for the UI-touching heuristic used by pr-agent
#
# Mirrors the shape of plugin/ralph-hero/scripts/cos/smoke.sh and soul/smoke.sh.
#
# The heuristic fires when ANY file path matches one of:
#   *.tsx  *.svelte  *.vue  */components/*  *.css  *.scss  */storybook/*
#
# Usage:
#   bash plugin/ralph-hero/scripts/scout-heuristic-smoke.sh
#
# The script also accepts file paths as arguments or on stdin for ad-hoc checks:
#   echo "src/components/Button.tsx" | bash plugin/ralph-hero/scripts/scout-heuristic-smoke.sh --check
#   bash plugin/ralph-hero/scripts/scout-heuristic-smoke.sh --check src/pages/index.svelte
#
# Exit codes:
#   0   All built-in test cases passed (or --check mode: printed MATCH/NO_MATCH)
#   1   One or more built-in test cases failed

set -euo pipefail

PASS=0
FAIL=0

_pass() { echo "[PASS] $1"; (( PASS++ )) || true; }
_fail() { echo "[FAIL] $1" >&2; (( FAIL++ )) || true; }

# ---------------------------------------------------------------------------
# Core heuristic function — returns 0 (MATCH) or 1 (NO_MATCH)
# Accepts a newline-separated list of file paths on stdin.
# ---------------------------------------------------------------------------
_ui_heuristic() {
  local files="$1"
  if printf '%s\n' "$files" | grep -qE '\.(tsx|svelte|vue|css|scss)$|/components/|(^|/)storybook/'; then
    return 0
  fi
  return 1
}

# ---------------------------------------------------------------------------
# --check mode: print MATCH or NO_MATCH for provided file paths
# ---------------------------------------------------------------------------
if [[ "${1:-}" == "--check" ]]; then
  shift
  if [[ $# -gt 0 ]]; then
    INPUT="$(printf '%s\n' "$@")"
  else
    INPUT="$(cat)"
  fi
  if _ui_heuristic "$INPUT"; then
    echo "MATCH"
  else
    echo "NO_MATCH"
  fi
  exit 0
fi

# ---------------------------------------------------------------------------
# Built-in test suite
# ---------------------------------------------------------------------------
echo "=== scout-heuristic smoke test ==="
echo ""

_assert_match() {
  local label="$1"
  local files="$2"
  if _ui_heuristic "$files"; then
    _pass "$label → MATCH (expected)"
  else
    _fail "$label → NO_MATCH (expected MATCH)"
  fi
}

_assert_no_match() {
  local label="$1"
  local files="$2"
  if ! _ui_heuristic "$files"; then
    _pass "$label → NO_MATCH (expected)"
  else
    _fail "$label → MATCH (expected NO_MATCH)"
  fi
}

# --- MATCH cases ---
echo "--- Match cases ---"
_assert_match "*.tsx file"                   "src/components/Button.tsx"
_assert_match "*.svelte file"                "src/pages/index.svelte"
_assert_match "*.css file"                   "src/styles/main.css"
_assert_match "*.scss file"                  "src/styles/theme.scss"
_assert_match "*.vue file"                   "src/views/Dashboard.vue"
_assert_match "path with /components/"       "lib/ui/components/Card/index.ts"
_assert_match "path with /storybook/"        "storybook/stories/Button.stories.js"
_assert_match "nested /components/ path"     "packages/design-system/src/components/Input.tsx"
_assert_match "multiple files, one matches"  "$(printf 'src/server/api.ts\nsrc/components/Nav.tsx')"

# --- NO_MATCH cases ---
echo ""
echo "--- No-match cases ---"
_assert_no_match "TypeScript MCP tool"        "mcp-server/src/tools/issue-tools.ts"
_assert_no_match "Markdown file"              "README.md"
_assert_no_match "Plain TS file"              "src/lib/helpers.ts"
_assert_no_match "Python script"              "scripts/dream/ingest.py"
_assert_no_match "JSON config"                "package.json"
_assert_no_match "Empty input"                ""
_assert_no_match "Backend-only files"         "$(printf 'src/server/routes.ts\nsrc/db/migrations/001.sql')"
_assert_no_match "YAML skills file"           "plugin/ralph-hero/skills/ralph-pr/SKILL.md"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "=== scout-heuristic: PASS=${PASS} FAIL=${FAIL} ==="

if (( FAIL > 0 )); then
  exit 1
fi

echo "Smoke test PASSED."
exit 0
