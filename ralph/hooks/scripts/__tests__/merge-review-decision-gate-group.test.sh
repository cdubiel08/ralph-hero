#!/usr/bin/env bash
# ralph/hooks/scripts/__tests__/merge-review-decision-gate-group.test.sh
# GH-1538 Phase 1: the XS-no-comments carve-out must evaluate EVERY linked
# issue in closingIssuesReferences, not just [0]. A group PR closing a mix
# of XS and S issues previously slipped through when the XS issue happened
# to be listed first.

set -euo pipefail

HOOK="$(cd "$(dirname "$0")/.." && pwd)/merge-review-decision-gate.sh"

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; ((PASS++)) || true; }
fail() { echo "  FAIL: $1"; ((FAIL++)) || true; }

STUB_DIR=$(mktemp -d)
trap 'rm -rf "$STUB_DIR"' EXIT

# Stub gh: pr view serves the fixture in $GH_STUB_PR_JSON; issue view
# serves per-issue estimates from GH_STUB_ESTIMATES ("101=XS 102=S"),
# failing outright for numbers listed in GH_STUB_ISSUE_FAIL; api user /
# repo view are pinned so the solo-repo carve-out never fires (author
# mismatch).
cat >"$STUB_DIR/gh" <<'STUB'
#!/usr/bin/env bash
case "$1 $2" in
  "pr view")
    cat "$GH_STUB_PR_JSON"
    ;;
  "issue view")
    num="$3"
    if [[ " ${GH_STUB_ISSUE_FAIL:-} " == *" $num "* ]]; then
      exit 1
    fi
    for pair in ${GH_STUB_ESTIMATES:-}; do
      if [[ "${pair%%=*}" == "$num" ]]; then
        echo "${pair#*=}"
        exit 0
      fi
    done
    echo "null"
    ;;
  "api user")
    echo "stub-reviewer"
    ;;
  "repo view")
    echo "stub-owner/stub-repo"
    ;;
  *)
    exit 1
    ;;
esac
STUB
chmod +x "$STUB_DIR/gh"

# PR fixture: no review yet, zero comments, author != stub-reviewer so the
# solo-repo carve-out is denied on author mismatch — only the XS carve-out
# can allow.
mk_pr_json() { # $1 = closingIssuesReferences JSON array
  local f="$STUB_DIR/pr.json"
  jq -n --argjson refs "$1" '{
    reviewDecision: null,
    comments: [],
    reviewThreads: [],
    closingIssuesReferences: $refs,
    author: {login: "other-user"}
  }' >"$f"
  echo "$f"
}

# run_case <desc> <expected_exit> <refs_json> [ENV=val ...]
run_case() {
  local desc="$1" expected="$2" refs="$3"; shift 3
  local pr_json_file actual
  pr_json_file=$(mk_pr_json "$refs")
  set +e
  env RALPH_COMMAND=review RALPH_HOOK_INPUT= \
      GH_STUB_PR_JSON="$pr_json_file" "$@" \
      PATH="$STUB_DIR:$PATH" \
      bash "$HOOK" <<<'{"tool_input":{"command":"gh pr merge 42 --squash"}}' >/dev/null 2>&1
  actual=$?
  set -e
  if [[ "$actual" == "$expected" ]]; then
    pass "$desc (exit $actual)"
  else
    fail "$desc — expected exit $expected, got $actual"
  fi
}

echo "=== merge-review-decision-gate group-cardinality tests ==="
echo ""

run_case "single XS issue → carve-out allows" 0 \
  '[{"number":101}]' GH_STUB_ESTIMATES="101=XS"

run_case "group, all members XS → carve-out allows" 0 \
  '[{"number":101},{"number":102},{"number":103}]' \
  GH_STUB_ESTIMATES="101=XS 102=XS 103=XS"

run_case "group, XS first but S member present → blocked" 2 \
  '[{"number":101},{"number":102}]' GH_STUB_ESTIMATES="101=XS 102=S"

run_case "group, S first XS second → blocked" 2 \
  '[{"number":102},{"number":101}]' GH_STUB_ESTIMATES="101=XS 102=S"

run_case "empty closingIssuesReferences → blocked" 2 '[]'

run_case "estimate fetch fails for one member → blocked (fail-closed)" 2 \
  '[{"number":101},{"number":102}]' \
  GH_STUB_ESTIMATES="101=XS" GH_STUB_ISSUE_FAIL="102"

run_case "member with no estimate set → blocked" 2 \
  '[{"number":101},{"number":104}]' GH_STUB_ESTIMATES="101=XS"

echo ""
echo "=== Results: ${PASS} passed, ${FAIL} failed ==="
[[ "$FAIL" -eq 0 ]] || exit 1
exit 0
