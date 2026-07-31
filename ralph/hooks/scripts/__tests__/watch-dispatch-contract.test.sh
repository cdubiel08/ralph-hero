#!/bin/bash
# ralph/hooks/scripts/__tests__/watch-dispatch-contract.test.sh
# GH-1590: the SOUL refusal preconditions and the dispatch table in
# ralph/skills/hero/watch-dispatch.md are ONE contract — every trigger the
# table routes on must be accepted by the preconditions, or the precondition
# escalates the issue to Human Needed before its route can ever run.
#
# This drifted three ways before it was caught (CodeRabbit raised the
# langfuse-trace half three times across rounds 1/4/5; applying the stated
# contract then surfaced both watcher-* labels as the same defect):
#   - table routed `langfuse-trace:` -> log-reader, preconditions did not accept it
#   - table routed label `watcher-investigate` -> log-reader, not accepted
#   - table routed label `watcher-remediate`  -> sre-fixit,  not accepted
#
# Strategy: static structural assertion over the doc, the same coverage model
# as caretake-watch.test.sh and triage-postcondition-palette.test.sh. There is
# no runtime hook on this path, so the doc IS the contract.

set -uo pipefail

PASS=0
FAIL=0

REPO_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
DOC="${REPO_ROOT}/ralph/skills/hero/watch-dispatch.md"

pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

echo "=== watch-dispatch precondition/route contract (GH-1590) ==="
echo ""

if [[ ! -s "$DOC" ]]; then
  fail "watch-dispatch.md exists and is non-empty: $DOC"
  echo ""
  echo "=== Results: ${PASS} passed, ${FAIL} failed ==="
  exit 1
fi
pass "watch-dispatch.md exists and is non-empty"

# The preconditions section: from the heading to the next '## '.
# CRITICAL: restrict to the ACCEPTANCE BULLETS (lines starting "- "), not the
# whole section. The section also carries an explanatory paragraph that names
# every trigger by way of describing the bug this contract fixes — matching
# against the full section made the test pass even with an acceptance bullet
# deleted (verified: it did). Bullets only, so removing one actually fails.
PRECONDITIONS="$(awk '/^## SOUL refusal preconditions/{f=1;next} f&&/^## /{exit} f' "$DOC" \
  | grep -E '^- ')"
# The dispatch table section.
TABLE="$(awk '/^## Dispatch table/{f=1;next} f&&/^## /{exit} f' "$DOC")"

if [[ -z "$PRECONDITIONS" ]]; then
  fail "SOUL refusal preconditions section is non-empty (heading renamed?)"
else
  pass "SOUL refusal preconditions section is non-empty"
fi
if [[ -z "$TABLE" ]]; then
  fail "Dispatch table section is non-empty (heading renamed?)"
else
  pass "Dispatch table section is non-empty"
fi

# Each trigger the dispatch table keys on must appear in the preconditions.
# Pairs: "<human label>|<pattern to find in the table>|<pattern to find in preconditions>"
check_trigger() {
  local label="$1" table_pat="$2" pre_pat="$3"

  if ! grep -qE -- "$table_pat" <<< "$TABLE"; then
    # Route absent from the table — nothing to require. Report so a silently
    # deleted route is visible rather than passing as "contract satisfied".
    pass "route not present in dispatch table (nothing to require): ${label}"
    return
  fi
  if grep -qE -- "$pre_pat" <<< "$PRECONDITIONS"; then
    pass "dispatch trigger accepted by preconditions: ${label}"
  else
    fail "dispatch trigger NOT accepted by preconditions: ${label} — the table routes it, so the preconditions would escalate to Human Needed before that route runs"
  fi
}

echo ""
echo "--- every dispatch-table trigger is accepted by the preconditions ---"
check_trigger "gcp-policy marker"   'gcp-policy'            'gcp-policy'
check_trigger "langfuse-trace URL"  'langfuse-trace'        'langfuse-trace'
check_trigger "watcher-investigate" 'watcher-investigate'   'watcher-investigate'
check_trigger "watcher-remediate"   'watcher-remediate'     'watcher-remediate'

echo ""
echo "--- the needs-input message names every accepted form ---"
NEEDS_INPUT="$(grep -m1 'needs input: issue #NNN' "$DOC" || true)"
if [[ -z "$NEEDS_INPUT" ]]; then
  fail "needs-input escalation message is present"
else
  pass "needs-input escalation message is present"
  for token in "trace ID" "langfuse-trace" "watcher-"; do
    if grep -qF -- "$token" <<< "$NEEDS_INPUT"; then
      pass "needs-input message mentions: ${token}"
    else
      fail "needs-input message omits: ${token} — it would tell an operator to supply only some of the accepted forms"
    fi
  done
fi

echo ""
echo "=== Results: ${PASS} passed, ${FAIL} failed ==="
echo ""

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
