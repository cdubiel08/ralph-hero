#!/bin/bash
# ralph/hooks/scripts/__tests__/caretake-watch.test.sh
# Doc-structure assertions for the merged watch mode (GH-1604).
#
# Strategy: assert structural invariants over the skill surface files using grep,
# confirming the mode exists with the correct shape, per-kind tokens, and wiring —
# the same coverage model used by triage-postcondition-palette.test.sh and the CI
# doc-consistency check (#1458). watch has no runtime Stop hook (parity with
# hygiene), so doc-structure is the correct coverage target.
#
# Supersedes caretake-watch-blockers.test.sh: watch-pr / watch-upstream /
# watch-blockers were merged into one `--mode watch --kind {pr,upstream,issue}`
# mode body (GH-1604). Every assertion here targets the merged shape.

set -euo pipefail

PASS=0
FAIL=0

REPO_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
MODE_FILE="${REPO_ROOT}/ralph/skills/caretake/modes/watch.md"
TOKENS_FILE="${REPO_ROOT}/ralph/skills/caretake/outcome-tokens.md"
SKILL_FILE="${REPO_ROOT}/ralph/skills/caretake/SKILL.md"
TRIAGE_FILE="${REPO_ROOT}/ralph/skills/caretake/modes/triage.md"
MODES_DIR="${REPO_ROOT}/ralph/skills/caretake/modes"

pass() {
  echo "  PASS: $1"
  ((PASS++)) || true
}

fail() {
  echo "  FAIL: $1"
  ((FAIL++)) || true
}

assert_file_contains() {
  local desc="$1"
  local file="$2"
  local pattern="$3"
  if grep -q -- "$pattern" "$file"; then
    pass "$desc"
  else
    fail "$desc — pattern not found in $(basename "$file"): '$pattern'"
  fi
}

assert_file_count_ge() {
  local desc="$1"
  local file="$2"
  local pattern="$3"
  local min="$4"
  local count
  count=$(grep -c "$pattern" "$file" || true)
  if [[ "$count" -ge "$min" ]]; then
    pass "$desc (count=$count)"
  else
    fail "$desc — expected ≥$min matches, got $count in $(basename "$file") for pattern: '$pattern'"
  fi
}

assert_file_exists_nonempty() {
  local desc="$1"
  local file="$2"
  if [[ -s "$file" ]]; then
    pass "$desc"
  else
    fail "$desc — file missing or empty: $file"
  fi
}

assert_file_absent() {
  local desc="$1"
  local file="$2"
  if [[ ! -e "$file" ]]; then
    pass "$desc"
  else
    fail "$desc — file still exists: $file"
  fi
}

echo "=== caretake-watch doc-structure tests ==="
echo ""

# -----------------------------------------------------------------------
echo "--- Assertion 1: Merged mode file exists; old per-kind files deleted ---"
assert_file_exists_nonempty "watch.md exists and is non-empty" "$MODE_FILE"
assert_file_absent "modes/watch-pr.md deleted (merged into watch.md)" "${MODES_DIR}/watch-pr.md"
assert_file_absent "modes/watch-upstream.md deleted (merged into watch.md)" "${MODES_DIR}/watch-upstream.md"
assert_file_absent "modes/watch-blockers.md deleted (merged into watch.md)" "${MODES_DIR}/watch-blockers.md"

# -----------------------------------------------------------------------
echo ""
echo "--- Assertion 2: Required headings + subcommand export + kind dispatch ---"
assert_file_contains "§Step 1: Verify branch heading present" "$MODE_FILE" "§Step 1: Verify branch"
assert_file_contains "§Step 2 heading present (kind dispatch)" "$MODE_FILE" "§Step 2"
assert_file_contains "§Constraints heading present" "$MODE_FILE" "§Constraints"
assert_file_contains "export RALPH_SUBCOMMAND=watch" "$MODE_FILE" "export RALPH_SUBCOMMAND=watch"
assert_file_contains "No Stop hook note present (parity)" "$MODE_FILE" "No .Stop. hook"
assert_file_contains "--kind pr|upstream|issue documented" "$MODE_FILE" "--kind <pr|upstream|issue>"

# -----------------------------------------------------------------------
echo ""
echo "--- Assertion 3: Advance behavior documented (issue kind) ---"
assert_file_contains "remove_dependency call present" "$MODE_FILE" "remove_dependency"
assert_file_contains "## Unblocked comment name present" "$MODE_FILE" "## Unblocked"
assert_file_contains "Default advance target Ready for Plan present" "$MODE_FILE" "Ready for Plan"
assert_file_contains "OPEN-blocker leave-untouched branch present" "$MODE_FILE" "leave untouched"
assert_file_contains "blockedNumber param (not blockedByNumber)" "$MODE_FILE" "blockedNumber"
if grep -qE "remove_dependency\([^)]*blockedByNumber[^)]*\)" "$MODE_FILE" 2>/dev/null; then
  fail "remove_dependency must NOT use blockedByNumber param (wrong schema)"
else
  pass "remove_dependency does not use non-existent blockedByNumber param as an argument"
fi

# -----------------------------------------------------------------------
echo ""
echo "--- Assertion 4: Reads the #1472 convention (dual detection signal) ---"
assert_file_contains "list_dependencies (edge signal) present" "$MODE_FILE" "list_dependencies"
assert_file_contains "## Escalation body signal present" "$MODE_FILE" "## Escalation"
assert_file_contains "Blocked by # phrasing present" "$MODE_FILE" "Blocked by #"
assert_file_contains "closes / Move to phrasing present" "$MODE_FILE" "Move to"

# -----------------------------------------------------------------------
echo ""
echo "--- Assertion 5: Per-kind terminal tokens present in mode file, outcome-tokens.md, and SKILL.md ---"
for KIND in PR UPSTREAM ISSUE; do
  assert_file_contains "WATCH-${KIND} token in mode file" "$MODE_FILE" "WATCH-${KIND}"
  assert_file_contains "WATCH-${KIND} token in outcome-tokens.md" "$TOKENS_FILE" "WATCH-${KIND}"
done
assert_file_contains "WATCH-<KIND> token family referenced in SKILL.md" "$SKILL_FILE" 'WATCH-<KIND>'

assert_file_contains "WATCH-PR ADVANCED token" "$MODE_FILE" "WATCH-PR ADVANCED"
assert_file_contains "WATCH-PR IDLE token" "$MODE_FILE" "WATCH-PR IDLE"
assert_file_contains "WATCH-UPSTREAM ADVANCED token" "$MODE_FILE" "WATCH-UPSTREAM ADVANCED"
assert_file_contains "WATCH-UPSTREAM IDLE token" "$MODE_FILE" "WATCH-UPSTREAM IDLE"
assert_file_contains "WATCH-ISSUE ADVANCED token" "$MODE_FILE" "WATCH-ISSUE ADVANCED"
assert_file_contains "WATCH-ISSUE IDLE token" "$MODE_FILE" "WATCH-ISSUE IDLE"
assert_file_contains "WATCH-<KIND> SKIPPED token" "$MODE_FILE" "WATCH-<KIND> SKIPPED"

# -----------------------------------------------------------------------
echo ""
echo "--- Assertion 6: Heartbeat wiring in SKILL.md ---"
assert_file_contains "--mode watch in fan-out dispatch" "$SKILL_FILE" 'mode watch'
assert_file_contains "4 total (fan-out child count updated)" "$SKILL_FILE" "4 total"
assert_file_contains "modes/watch.md in mode-bodies list" "$SKILL_FILE" "modes/watch.md"
assert_file_contains "watch row in mode table with --kind hint" "$SKILL_FILE" "--kind pr"

# Confirm the pre-merge per-kind mode names are fully gone from SKILL.md.
if grep -qE 'watch-pr|watch-upstream|watch-blockers' "$SKILL_FILE"; then
  fail "SKILL.md still references a pre-merge watch-* mode name"
else
  pass "SKILL.md has no residual watch-pr/watch-upstream/watch-blockers references"
fi

# -----------------------------------------------------------------------
echo ""
echo "--- Assertion 7: Token registry in outcome-tokens.md ---"
assert_file_contains "## Watch terminal tokens heading" "$TOKENS_FILE" "## Watch terminal tokens"
assert_file_count_ge "WATCH- appears ≥3 times in outcome-tokens.md" "$TOKENS_FILE" "WATCH-" 3
assert_file_contains "no Stop postcondition hook (parity) note in outcome-tokens.md" "$TOKENS_FILE" \
  "watch has no .Stop. postcondition hook"

# -----------------------------------------------------------------------
echo ""
echo "--- Assertion 8: triage.md cross-ref updated to the merged --kind form ---"
assert_file_contains "triage.md names --kind pr as the live consumer" "$TRIAGE_FILE" \
  "caretake --mode watch --kind pr"
assert_file_contains "triage.md names --kind upstream as the live consumer" "$TRIAGE_FILE" \
  "caretake --mode watch --kind upstream"
assert_file_contains "triage.md names --kind issue as the live consumer" "$TRIAGE_FILE" \
  "caretake --mode watch --kind issue"
if grep -q "no watcher yet" "$TRIAGE_FILE" 2>/dev/null; then
  fail "triage.md still has stale 'no watcher yet' language — should be updated to live"
else
  pass "triage.md no longer has stale 'no watcher yet' language"
fi
if grep -qE 'caretake --mode watch-(pr|upstream|blockers)\b' "$TRIAGE_FILE" 2>/dev/null; then
  fail "triage.md still references a pre-merge watch-* mode name"
else
  pass "triage.md has no residual watch-pr/watch-upstream/watch-blockers references"
fi

# -----------------------------------------------------------------------
echo ""
echo "=== Results: ${PASS} passed, ${FAIL} failed ==="
echo ""

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
