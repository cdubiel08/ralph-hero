#!/usr/bin/env bash
# ralph/hooks/scripts/__tests__/doc-structure-validator.test.sh
# Session-scoped doc-structure validation (Stop hook).
#
# Regression pinned here: the validator must ONLY judge docs recorded in this
# session's artifact list. A fresh today-dated doc on disk written by a
# DIFFERENT session must be invisible — the 2026-07-04 incident was a Stop
# blocked on a concurrent session's in-progress research doc.

set -euo pipefail

HOOK_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HOOK="$HOOK_DIR/doc-structure-validator.sh"
TODAY=$(date +%Y-%m-%d)

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; ((PASS++)) || true; }
fail() { echo "  FAIL: $1"; ((FAIL++)) || true; }

SBX="$(mktemp -d)"
trap 'rm -rf "$SBX"' EXIT
mkdir -p "$SBX/tmp" "$SBX/proj/thoughts/shared/research" \
  "$SBX/proj/thoughts/shared/plans" "$SBX/proj/thoughts/shared/reviews"

# record <session_id> <path>  — simulate artifact-write-tracker
record() {
  mkdir -p "$SBX/tmp/ralph-session-$1"
  echo "$2" >> "$SBX/tmp/ralph-session-$1/artifacts.list"
}

# run_hook <session_id> — exit code on stdout
run_hook() {
  local json
  json=$(jq -n --arg sid "$1" '{session_id: $sid, stop_hook_active: false}')
  set +e
  printf '%s' "$json" \
    | env TMPDIR="$SBX/tmp" RALPH_HOOK_INPUT= CLAUDE_PROJECT_DIR="$SBX/proj" \
        bash "$HOOK" >/dev/null 2>&1
  local ec=$?
  set -e
  echo "$ec"
}

VALID_RESEARCH=$'## Research Question\n\nQ?\n\n## Summary\n\nVia `src/x.ts`.\n\n## Files Affected\n\n### Will Modify\n- `src/x.ts`'
INVALID_RESEARCH=$'## Research Question\n\nQ?\n\n## Summary\n\nVia `src/x.ts`.'
VALID_PLAN=$'## Design Decisions & Open Ambiguities\n\nNone — no open design decisions.\n\n## Phase 1: Do it\n\n#### Automated Verification\n\n- [ ] tests pass'
VALID_REVIEW=$'## Verdict\n\n**Verdict**: APPROVED'

echo "=== doc-structure-validator (session-scoped) tests ==="
echo ""

# --- Empty session list → allow -------------------------------------------------
ec=$(run_hook empty-session)
[[ "$ec" == "0" ]] && pass "no session list allows (exit 0)" || fail "no session list — expected 0, got $ec"

# --- THE RACE: another session's fresh doc on disk, not in our list → allow ------
printf '%s' "$INVALID_RESEARCH" > "$SBX/proj/thoughts/shared/research/${TODAY}-other-sessions-doc.md"
ec=$(run_hook race-session)
[[ "$ec" == "0" ]] && pass "another session's fresh invalid doc is ignored (race regression)" \
  || fail "another session's fresh invalid doc is ignored — expected 0, got $ec"

# --- Session-written valid research doc → allow ----------------------------------
doc="$SBX/proj/thoughts/shared/research/${TODAY}-GH-1-mine.md"
printf '%s' "$VALID_RESEARCH" > "$doc"
record s-valid "$doc"
ec=$(run_hook s-valid)
[[ "$ec" == "0" ]] && pass "session-written valid research doc passes" \
  || fail "session-written valid research doc — expected 0, got $ec"

# --- Session-written invalid research doc → block ---------------------------------
doc="$SBX/proj/thoughts/shared/research/${TODAY}-GH-2-bad.md"
printf '%s' "$INVALID_RESEARCH" > "$doc"
record s-invalid "$doc"
ec=$(run_hook s-invalid)
[[ "$ec" == "2" ]] && pass "session-written research doc missing Files Affected blocks" \
  || fail "invalid research doc — expected 2, got $ec"

# --- Plan + review branches, both session-written ----------------------------------
doc="$SBX/proj/thoughts/shared/plans/${TODAY}-GH-3-plan.md"
printf '%s' "$VALID_PLAN" > "$doc"
record s-plan "$doc"
ec=$(run_hook s-plan)
[[ "$ec" == "0" ]] && pass "session-written valid plan doc passes" \
  || fail "valid plan doc — expected 0, got $ec"

doc="$SBX/proj/thoughts/shared/reviews/${TODAY}-GH-4-critique.md"
printf '%s' "$VALID_REVIEW" > "$doc"
record s-review "$doc"
ec=$(run_hook s-review)
[[ "$ec" == "0" ]] && pass "session-written valid critique passes" \
  || fail "valid critique — expected 0, got $ec"

# --- Group plan (github_issues frontmatter) validates as a standard plan (GH-1538) --
doc="$SBX/proj/thoughts/shared/plans/${TODAY}-GH-8-group.md"
printf '%s' $'---\ntype: plan\ngithub_issues: [101, 102, 103]\nprimary_issue: 101\nestimate: S\n---\n\n## Design Decisions & Open Ambiguities\n\nNone — no open design decisions.\n\n## Phase 1: GH-101 — first member\n\n#### Automated Verification\n\n- [ ] tests pass\n\n## Phase 2: GH-102 — second member\n\n#### Automated Verification\n\n- [ ] tests pass' > "$doc"
record s-group "$doc"
ec=$(run_hook s-group)
[[ "$ec" == "0" ]] && pass "group plan (github_issues) validates via the standard plan branch" \
  || fail "group plan — expected 0, got $ec"

# --- Multiple session docs: one invalid blocks -------------------------------------
good="$SBX/proj/thoughts/shared/plans/${TODAY}-GH-5-good.md"
bad="$SBX/proj/thoughts/shared/research/${TODAY}-GH-5-bad.md"
printf '%s' "$VALID_PLAN" > "$good"
printf '%s' "$INVALID_RESEARCH" > "$bad"
record s-multi "$good"
record s-multi "$bad"
ec=$(run_hook s-multi)
[[ "$ec" == "2" ]] && pass "one invalid doc among several session docs blocks" \
  || fail "one invalid among several — expected 2, got $ec"

# --- Old-dated doc in list ignored (iterate-mode edits of legacy docs) -------------
doc="$SBX/proj/thoughts/shared/plans/2020-01-01-GH-6-legacy.md"
printf '%s' "not a structured plan" > "$doc"
record s-legacy "$doc"
ec=$(run_hook s-legacy)
[[ "$ec" == "0" ]] && pass "old-dated session-written doc is not validated" \
  || fail "old-dated doc — expected 0, got $ec"

# --- Deleted file in list tolerated -------------------------------------------------
record s-gone "$SBX/proj/thoughts/shared/plans/${TODAY}-GH-7-gone.md"
ec=$(run_hook s-gone)
[[ "$ec" == "0" ]] && pass "list entry whose file was deleted allows" \
  || fail "deleted file entry — expected 0, got $ec"

echo ""
echo "=== Results: ${PASS} passed, ${FAIL} failed ==="
[[ "$FAIL" -eq 0 ]] || exit 1
exit 0
