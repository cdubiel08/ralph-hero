#!/bin/bash
# scripts/__tests__/release-bump-detection.test.sh
#
# Guards release.yml's version-bump marker detection.
#
# Why this test exists: the original patterns were `\b#major\b` / `\b#minor\b`.
# `\b` matches only at a word/non-word transition, so a marker written the way
# CLAUDE.md documents it — whitespace, then `#minor` — has non-word followed by
# non-word and NO boundary at that position. The match never fired, and every
# release silently took the patch branch. PR #1624 shipped seven tool removals
# as a patch bump because of it.
#
# The patterns are extracted FROM the workflow (not restated here) so this test
# fails if the workflow's regex regresses. They are used only as grep patterns —
# data passed to grep -E, never evaluated as shell.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
WORKFLOW="$REPO_ROOT/.github/workflows/release.yml"

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

echo "=== release.yml bump-marker detection ==="

[ -f "$WORKFLOW" ] || { echo "FATAL: $WORKFLOW not found"; exit 1; }

# Pull each pattern out of the workflow's grep invocation.
#
# `|| true` is load-bearing: under `set -euo pipefail` a non-matching grep makes
# the pipeline fail, which aborts the script at the MINOR_RE/MAJOR_RE assignment
# below — before the explicit "could not extract" diagnostic can print. Without
# it that failure path is unreachable and a missing pattern surfaces as a bare
# non-zero exit with no explanation.
extract_pattern() {
  local marker="$1"
  grep -oE "grep -qiE '[^']*#${marker}[^']*'" "$WORKFLOW" \
    | head -1 \
    | sed -E "s/^grep -qiE '//; s/'$//" || true
}

# Line number of the grep line for a marker — used to assert branch ORDER.
pattern_line() {
  local marker="$1"
  grep -nE "grep -qiE '[^']*#${marker}[^']*'" "$WORKFLOW" \
    | head -1 | cut -d: -f1 || true
}

MINOR_RE="$(extract_pattern minor)"
MAJOR_RE="$(extract_pattern major)"

if [ -n "$MINOR_RE" ] && [ -n "$MAJOR_RE" ]; then
  pass "extracted both patterns from release.yml"
else
  fail "could not extract patterns (minor='$MINOR_RE' major='$MAJOR_RE')"
  echo "Results: $PASS passed, $FAIL failed"
  exit 1
fi

# expect_match <regex> <should_match: yes|no> <label> <message>
expect_match() {
  local re="$1" want="$2" label="$3" msg="$4" got
  if printf '%s\n' "$msg" | grep -qiE "$re"; then got="yes"; else got="no"; fi
  if [ "$got" = "$want" ]; then
    pass "$label"
  else
    fail "$label (wanted $want, got $got) for message: $(printf '%s' "$msg" | tr '\n' '|')"
  fi
}

# The exact shape a merge commit takes: `gh pr merge --merge` puts the PR title
# in the commit body, so the marker lands at end-of-line after a space. This is
# the case the old \b pattern could not match.
expect_match "$MINOR_RE" yes "trailing marker after a space (the real merge-commit shape)" \
  "Merge pull request #1624 from cdubiel08/feature/x

feat(mcp-server): tool surface 33 -> 22 (GH-1591, GH-1592) #minor"

expect_match "$MINOR_RE" yes "marker at start of line" "#minor bump this"
expect_match "$MINOR_RE" yes "marker followed by punctuation" "bump it #minor."
expect_match "$MINOR_RE" yes "marker on its own line in a multi-line body" "subject

body text
#minor"
expect_match "$MINOR_RE" yes "uppercase marker (grep -i)" "feat: thing #MINOR"

expect_match "$MINOR_RE" no "no marker present" "chore: routine change with no marker"
expect_match "$MINOR_RE" no "substring is not a marker" "fix: handle #minorly odd input"

expect_match "$MAJOR_RE" yes "major marker after a space" "feat!: breaking change #major"
expect_match "$MAJOR_RE" no "minor marker does not trip major" "feat: thing #minor"
expect_match "$MAJOR_RE" no "no marker does not trip major" "chore: routine"

# Precedence: a message carrying BOTH markers must resolve to major. That rests
# on two independent facts, and asserting only the first would still pass if the
# workflow evaluated minor first:
#   (a) both patterns match such a message, so the tie is real, and
#   (b) the major branch is evaluated BEFORE the minor branch in release.yml.
BOTH="feat: big #major and #minor"
expect_match "$MAJOR_RE" yes "both markers: major pattern matches" "$BOTH"
expect_match "$MINOR_RE" yes "both markers: minor pattern also matches (tie is real)" "$BOTH"

MAJOR_LINE="$(pattern_line major)"
MINOR_LINE="$(pattern_line minor)"
if [ -n "$MAJOR_LINE" ] && [ -n "$MINOR_LINE" ] && [ "$MAJOR_LINE" -lt "$MINOR_LINE" ]; then
  pass "major branch is evaluated before minor in release.yml (line $MAJOR_LINE < $MINOR_LINE)"
else
  fail "major branch must precede minor in release.yml (major=$MAJOR_LINE minor=$MINOR_LINE); a both-markers message would resolve to minor"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
