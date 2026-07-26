#!/usr/bin/env bash
# scripts/__tests__/pr-file-classes.test.sh
# Taxonomy tests for the changed-file → review-class mapper (GH-1589).
# The validator recomputes classes from PR diffs with this script, so the
# mapping must stay deterministic — these tests pin the precedence rules.

set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/pr-file-classes.sh"

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; ((PASS++)) || true; }
fail() { echo "  FAIL: $1"; ((FAIL++)) || true; }

# expect <desc> <expected-newline-list> <paths...>
expect() {
  local desc="$1" expected="$2"
  shift 2
  local actual
  actual=$(bash "$SCRIPT" "$@")
  if [[ "$actual" == "$expected" ]]; then
    pass "$desc"
  else
    fail "$desc — expected [$(tr '\n' ' ' <<<"$expected")], got [$(tr '\n' ' ' <<<"$actual")]"
  fi
}

echo "=== pr-file-classes.sh taxonomy ==="

expect "mcp-server code → mcp-ts" "mcp-ts" "mcp-server/src/tools/issue-tools.ts"
expect "knowledge code → knowledge-ts" "knowledge-ts" "plugin/ralph-knowledge/src/index.ts"
expect "hook script → hooks-shell" "hooks-shell" "ralph/hooks/scripts/merge-review-decision-gate.sh"
expect "repo script → scripts-shell" "scripts-shell" "scripts/merge-pr.sh"
expect "workflow → ci-workflows" "ci-workflows" ".github/workflows/ci.yml"
expect "skill prose → skills-prose" "skills-prose" "ralph/skills/review/merge-gate.md"
expect "docs → skills-prose" "skills-prose" "docs/model-tier-policy.md"
expect "thoughts → skills-prose" "skills-prose" "thoughts/shared/plans/x.md"
expect "loose md anywhere → skills-prose" "skills-prose" "CLAUDE.md"
expect "unclassified → other" "other" "Makefile"

# deps precedence beats directory rules
expect "mcp-server lockfile → deps (not mcp-ts)" "deps" "mcp-server/package-lock.json"
expect "knowledge package.json → deps" "deps" "plugin/ralph-knowledge/package.json"
expect "pnpm lockfile → deps" "deps" "plugin/ralph-demo/remotion/pnpm-lock.yaml"

# .github markdown stays ci-workflows (dir rule precedes *.md)
expect ".github md → ci-workflows" "ci-workflows" ".github/pull_request_template.md"

# multi-path: sorted unique union
expect "multi-path union sorted-unique" "$(printf 'hooks-shell\nmcp-ts\nscripts-shell')" \
  "scripts/merge-pr.sh" "mcp-server/src/index.ts" "ralph/hooks/scripts/a.sh" "mcp-server/src/types.ts"

# empty input → empty output, exit 0
if out=$(bash "$SCRIPT") && [[ -z "$out" ]]; then
  pass "no paths → empty, exit 0"
else
  fail "no paths → expected empty exit-0, got rc=$? out=$out"
fi

echo
echo "Results: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
