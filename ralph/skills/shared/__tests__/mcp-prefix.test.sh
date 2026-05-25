#!/usr/bin/env bash
# mcp-prefix.test.sh — Guard: assert zero stale mcp__plugin_ralph-hero_ralph-github
#                       references in ralph/ and that every hooks.json matcher
#                       tool-prefix maps to a tool the MCP server registers.
# Usage: bash ralph/skills/shared/__tests__/mcp-prefix.test.sh
# Exit 0 = all pass; exit 1 = at least one failure.

set -uo pipefail

PASS=0
FAIL=0

# Locate repo root from this script's location (ralph/skills/shared/__tests__)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
RALPH_DIR="${REPO_ROOT}/ralph"
HOOKS_JSON="${RALPH_DIR}/hooks/hooks.json"
MCP_JSON="${RALPH_DIR}/.mcp.json"
MCP_SERVER_SRC="${REPO_ROOT}/plugin/ralph-hero/mcp-server/src"

ok()   { echo "PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "FAIL: $1"; echo "      expected: $2"; echo "      got:      $3"; FAIL=$((FAIL + 1)); }

# ── 1. Zero stale prefix occurrences in ralph/ ──────────────────────────────

# Exclude this test file itself — it necessarily references the old prefix as a literal string.
THIS_FILE="$(realpath "${BASH_SOURCE[0]}")"
# Build the search pattern via variable to avoid this script self-matching.
OLD_PREFIX="mcp__plugin_ralph-hero_ralph-github"
stale_count=$(grep -rn "$OLD_PREFIX" "${RALPH_DIR}/" 2>/dev/null \
  | grep -v "^${THIS_FILE}:" | wc -l | tr -d ' ')
if [[ "$stale_count" -eq 0 ]]; then
  ok "zero stale ${OLD_PREFIX} references in ralph/ (excluding this test file)"
else
  fail "zero stale ${OLD_PREFIX} references in ralph/" \
    "0" \
    "${stale_count} occurrence(s)"
  # Print offending lines to aid debugging
  grep -rn "$OLD_PREFIX" "${RALPH_DIR}/" 2>/dev/null \
    | grep -v "^${THIS_FILE}:" | head -20 >&2
fi

# ── 2. ralph/.mcp.json exists and is valid JSON ──────────────────────────────

if [[ -f "$MCP_JSON" ]]; then
  ok "ralph/.mcp.json exists"
else
  fail "ralph/.mcp.json exists" "file present" "not found at ${MCP_JSON}"
fi

if [[ -f "$MCP_JSON" ]]; then
  if python3 -c "import json, sys; json.load(open('${MCP_JSON}'))" 2>/dev/null; then
    ok "ralph/.mcp.json is valid JSON"
  elif command -v node >/dev/null 2>&1 && node -e "JSON.parse(require('fs').readFileSync('${MCP_JSON}','utf8'))" 2>/dev/null; then
    ok "ralph/.mcp.json is valid JSON"
  else
    fail "ralph/.mcp.json is valid JSON" "valid JSON" "parse error"
  fi
fi

# ── 3. ralph/.mcp.json registers server key "ralph-github" ──────────────────

if [[ -f "$MCP_JSON" ]]; then
  if grep -q '"ralph-github"' "$MCP_JSON"; then
    ok "ralph/.mcp.json registers server key ralph-github"
  else
    fail "ralph/.mcp.json registers server key ralph-github" \
      '"ralph-github" present' "not found in .mcp.json"
  fi
fi

# ── 4. Every hooks.json matcher tool-prefix maps to a registered server tool ─
#
# Extract tool names from matcher values that start with the new prefix.
# Pipe-separated matchers (e.g., "tool_a|tool_b") are split on |.
# Strip the prefix to get the bare tool name, then check it exists in
# the MCP server source (non-debug tools in src/tools/*.ts).

if [[ ! -f "$HOOKS_JSON" ]]; then
  fail "hooks.json exists" "file present" "not found at ${HOOKS_JSON}"
else
  ok "hooks.json exists"

  # Collect registered tool names from MCP server source (non-debug tools)
  registered_tools=""
  if [[ -d "$MCP_SERVER_SRC/tools" ]]; then
    registered_tools=$(grep -rh '"ralph_hero__' "${MCP_SERVER_SRC}/tools/" 2>/dev/null \
      | grep -oE '"ralph_hero__[a-zA-Z0-9_]+"' \
      | tr -d '"' \
      | sort -u)
  fi

  # Also include health_check which is registered directly in index.ts
  if [[ -f "${MCP_SERVER_SRC}/index.ts" ]]; then
    index_tools=$(grep -oE '"ralph_hero__[a-zA-Z0-9_]+"' "${MCP_SERVER_SRC}/index.ts" 2>/dev/null \
      | tr -d '"' \
      | sort -u)
    registered_tools=$(printf '%s\n%s' "$registered_tools" "$index_tools" | sort -u)
  fi

  # Extract all tool names from matcher fields in hooks.json
  # Matchers can be pipe-joined: "toolA|toolB"
  matcher_tools=$(grep -oE '"mcp__plugin_ralph_ralph-github__[a-zA-Z0-9_|]+"' "$HOOKS_JSON" \
    | tr -d '"' \
    | tr '|' '\n' \
    | grep '^mcp__plugin_ralph_ralph-github__' \
    | sed 's/^mcp__plugin_ralph_ralph-github__//' \
    | sort -u)

  # Also sweep SKILL.md files for PreToolUse/PostToolUse matchers
  skill_matcher_tools=$(grep -rh 'matcher.*mcp__plugin_ralph_ralph-github' "${RALPH_DIR}/" 2>/dev/null \
    | grep -oE 'mcp__plugin_ralph_ralph-github__[a-zA-Z0-9_|]+' \
    | tr '|' '\n' \
    | grep '^mcp__plugin_ralph_ralph-github__' \
    | sed 's/^mcp__plugin_ralph_ralph-github__//' \
    | sort -u)

  # Combine both sources
  all_matcher_tools=$(printf '%s\n%s' "$matcher_tools" "$skill_matcher_tools" | sort -u | grep -v '^$')

  if [[ -z "$all_matcher_tools" ]]; then
    # No MCP matchers in hooks.json/SKILL files — that's valid (only one in hooks.json now)
    ok "no MCP tool matchers found (skipping matcher/tool correspondence check)"
  else
    while IFS= read -r tool; do
      [[ -z "$tool" ]] && continue
      if echo "$registered_tools" | grep -qx "$tool"; then
        ok "hooks.json/SKILL matcher tool registered in MCP server: ${tool}"
      else
        fail "hooks.json/SKILL matcher tool registered in MCP server: ${tool}" \
          "tool ${tool} found in server source" \
          "NOT found — possible typo or missing registration"
      fi
    done <<< "$all_matcher_tools"
  fi
fi

# ── 5. New prefix is present (forward-presence sanity check) ─────────────────

new_prefix_count=$(grep -rn 'mcp__plugin_ralph_ralph-github' "${RALPH_DIR}/" 2>/dev/null | wc -l | tr -d ' ')
if [[ "$new_prefix_count" -gt 0 ]]; then
  ok "new prefix mcp__plugin_ralph_ralph-github is present in ralph/ (${new_prefix_count} occurrences)"
else
  fail "new prefix present in ralph/" "at least 1 occurrence" "0 occurrences found"
fi

# ── summary ───────────────────────────────────────────────────────────────────

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
if [[ "$FAIL" -eq 0 ]]; then
  exit 0
else
  exit 1
fi
