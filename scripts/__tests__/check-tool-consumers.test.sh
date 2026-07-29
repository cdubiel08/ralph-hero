#!/usr/bin/env bash
# scripts/__tests__/check-tool-consumers.test.sh
#
# Fixture tests for scripts/check-tool-consumers.sh (GH-1614). Pure
# filesystem — no gh stub, no network. Each case builds a small fixture
# tree under a temp ROOT mirroring the real repo's ralph/skills,
# ralph/agents, mcp-server/src layout, then invokes the script with that
# ROOT as its explicit argument.
#
# A check that cannot fail is worthless — cases 1 and 2 exist specifically
# to prove each direction produces a non-zero exit and names the violation
# when the drift is real, not just that the real repo happens to pass.

set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/check-tool-consumers.sh"
TMP_ROOT=$(mktemp -d)
trap 'rm -rf "$TMP_ROOT"' EXIT

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; ((PASS++)) || true; }
fail() { echo "  FAIL: $1"; ((FAIL++)) || true; }

# skill_md <root> <verb> <allowed_tools_lines> <body>
# Writes a minimal SKILL.md: frontmatter with `allowed-tools:` (one grant
# per line, already prefixed with the mcp__... form, or empty) followed by
# a body below the second `---`.
skill_md() {
  local root="$1" verb="$2" grants="$3" body="$4"
  mkdir -p "$root/ralph/skills/$verb"
  {
    echo "---"
    echo "name: $verb"
    echo "allowed-tools:"
    echo "  - Read"
    if [ -n "$grants" ]; then
      printf '%s\n' "$grants" | sed 's/^/  - /'
    fi
    echo "---"
    echo ""
    printf '%s\n' "$body"
  } >"$root/ralph/skills/$verb/SKILL.md"
}

# tool_ts <root> <module_name> <tool_short_name>
# Writes a minimal source file registering one ralph_hero__<name> tool, in
# the exact quoted-string shape the script's grep pattern matches.
tool_ts() {
  local root="$1" module="$2" name="$3"
  mkdir -p "$root/mcp-server/src/tools"
  cat >"$root/mcp-server/src/tools/$module.ts" <<EOF
export function register${module}Tools(server) {
  server.tool(
    "ralph_hero__${name}",
    "test tool",
    {},
    async () => ({}),
  );
}
EOF
}

fresh_root() {
  local root="$TMP_ROOT/case-$RANDOM-$((PASS + FAIL))"
  mkdir -p "$root/ralph/skills" "$root/ralph/agents" "$root/mcp-server/src/tools"
  echo "$root"
}

# ---------------------------------------------------------------------------
echo "=== check-tool-consumers.sh fixture tests ==="

# 1. Direction A violated: prose names a tool the skill doesn't grant.
root=$(fresh_root)
skill_md "$root" "plan" "" \
  "Call \`ralph_hero__save_issue\` to advance the issue."
tool_ts "$root" "issue" "save_issue"
# Give save_issue a real consumer elsewhere so this case isolates Direction A.
cat >"$root/ralph/agents/plan-agent.md" <<'EOF'
---
name: plan-agent
tools: mcp__plugin_ralph_ralph-github__ralph_hero__save_issue
---
EOF
set +e
out=$(bash "$SCRIPT" "$root" 2>&1)
actual=$?
set -e
if [ "$actual" -eq 1 ]; then pass "Direction A violation exits 1"; else fail "Direction A violation — expected exit 1, got $actual"; fi
if grep -q "FAIL:.*names ralph_hero__save_issue in prose but.*does not grant it" <<<"$out"; then
  pass "Direction A violation names the offending skill + tool"
else
  fail "Direction A FAIL line missing from output: $out"
fi

# 1b. A fully-prefixed tool name in the SKILL.md BODY must not satisfy its own
# grant check. Grants are frontmatter-only; if `granted` were collected from the
# whole file, this fixture would pass and mask a missing allowed-tools entry.
root=$(fresh_root)
skill_md "$root" "plan" "" \
  "This mode calls \`mcp__plugin_ralph_ralph-github__ralph_hero__save_issue\` to advance the issue."
tool_ts "$root" "issue" "save_issue"
cat >"$root/ralph/agents/plan-agent.md" <<'EOF'
---
name: plan-agent
tools: mcp__plugin_ralph_ralph-github__ralph_hero__save_issue
---
EOF
set +e
out=$(bash "$SCRIPT" "$root" 2>&1)
actual=$?
set -e
if [ "$actual" -eq 1 ]; then
  pass "body-only prefixed mention does not self-grant (exits 1)"
else
  fail "body-only prefixed mention self-granted — expected exit 1, got $actual: $out"
fi
# Exit status alone is too weak a signal here: a checker crash or an unrelated
# validation error also exits 1, and would silently satisfy this case. Require
# the same Direction-A diagnostic asserted in test 1.
if grep -q "FAIL:.*names ralph_hero__save_issue in prose but.*does not grant it" <<<"$out"; then
  pass "body-only mention fails for the Direction-A reason, not an incidental error"
else
  fail "body-only case exited 1 without the Direction-A FAIL line: $out"
fi

# 2. Direction B violated: registered tool has zero consumers anywhere.
root=$(fresh_root)
skill_md "$root" "plan" "mcp__plugin_ralph_ralph-github__ralph_hero__get_issue" \
  "Read the issue with \`get_issue\`."
tool_ts "$root" "issue" "get_issue"
tool_ts "$root" "orphan" "orphan_tool"
set +e
out=$(bash "$SCRIPT" "$root" 2>&1)
actual=$?
set -e
if [ "$actual" -eq 1 ]; then pass "Direction B violation exits 1"; else fail "Direction B violation — expected exit 1, got $actual"; fi
if grep -q "FAIL: ralph_hero__orphan_tool is registered.*but has no consumer" <<<"$out"; then
  pass "Direction B violation names the orphaned tool"
else
  fail "Direction B FAIL line missing from output: $out"
fi

# 3. Clean fixture: every prose mention granted, every registration consumed.
root=$(fresh_root)
skill_md "$root" "plan" "mcp__plugin_ralph_ralph-github__ralph_hero__get_issue
mcp__plugin_ralph_ralph-github__ralph_hero__save_issue" \
  "Read via \`get_issue\`, then \`ralph_hero__save_issue\` to advance."
tool_ts "$root" "issue" "get_issue"
tool_ts "$root" "save" "save_issue"
set +e
out=$(bash "$SCRIPT" "$root" 2>&1)
actual=$?
set -e
if [ "$actual" -eq 0 ]; then pass "clean fixture exits 0"; else fail "clean fixture — expected exit 0, got $actual: $out"; fi

# 4. Exemption suppresses a Direction-A hit. Uses the script's own
# hardcoded seed entry (ralph/skills/research/SKILL.md:decompose_feature) —
# research names decompose_feature only to say it does NOT call it.
root=$(fresh_root)
skill_md "$root" "research" "" \
  "Read the file directly (via \`Read\`, not \`decompose_feature\`)."
tool_ts "$root" "decompose" "decompose_feature"
# Give decompose_feature a real consumer elsewhere so Direction B stays
# clean and this case isolates the Direction-A exemption.
cat >"$root/ralph/agents/plan-agent.md" <<'EOF'
---
name: plan-agent
tools: mcp__plugin_ralph_ralph-github__ralph_hero__decompose_feature
---
EOF
set +e
out=$(bash "$SCRIPT" "$root" 2>&1)
actual=$?
set -e
if [ "$actual" -eq 0 ]; then
  pass "exemption suppresses the Direction-A hit"
else
  fail "exemption did not suppress Direction-A hit — expected exit 0, got $actual: $out"
fi
if grep -q "FAIL:.*decompose_feature" <<<"$out"; then
  fail "unexpected FAIL line naming decompose_feature: $out"
else
  pass "no FAIL line naming decompose_feature"
fi

# 5. The real repo passes end-to-end.
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
set +e
out=$(bash "$SCRIPT" "$REPO_ROOT" 2>&1)
actual=$?
set -e
if [ "$actual" -eq 0 ]; then
  pass "real repo passes both directions"
else
  fail "real repo FAILED check-tool-consumers.sh (exit $actual): $out"
fi

# ---------------------------------------------------------------------------
echo
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
