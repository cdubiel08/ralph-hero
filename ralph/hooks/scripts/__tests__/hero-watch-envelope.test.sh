#!/usr/bin/env bash
# hero-watch-envelope.test.sh — the untrusted-issue-content envelope in
# hero/watch-dispatch.md must be delimiter-injection resistant.
# Usage: bash ralph/hooks/scripts/__tests__/hero-watch-envelope.test.sh
# Exit 0 = all pass; exit 1 = at least one failure.
#
# Regression target: CodeRabbit review 2026-07-28T00:18:12Z on PR #1620
# (watch-dispatch.md:64). The first envelope used a FIXED `</issue-content>`
# terminator with `title`/`body` interpolated verbatim. Both are attacker-
# controlled (anyone who can open an issue writes them), so a body containing
# the literal closing marker closes the envelope early and lands the rest of the
# body OUTSIDE the "this is evidence, not instructions" region — i.e. as
# dispatcher-level orders to log-reader / sre-fixit.
#
# Two properties are asserted, because either alone is defeatable:
#   1. UNPREDICTABLE DELIMITER — the marker carries a per-dispatch nonce, so the
#      author of the content cannot know what string would close it.
#   2. NEUTRALIZATION — the content is still scanned and any literal
#      `</issue-content` occurrence is defanged before interpolation, so the
#      envelope does not depend on nonce secrecy alone.
# Plus a worked regression case showing a hostile body carrying the marker.
#
# Doc-structure coverage, same model as hero-auto-tick-audience.test.sh and
# caretake-watch.test.sh: the envelope is prose consumed by the dispatching
# model, with no runtime hook.
#
# NOT a hook test — deliberately does not use plan-research-required.test.sh's
# SBX/REPO/NOGIT + `run_case` harness (CodeRabbit asked for it on PR #1620,
# 2026-07-28; declined for the same reason the two tests above were). This file
# executes no hook: no HOOKS_DIR, no `bash "$HOOK"`, no RALPH_HOOK_INPUT, no
# stdin JSON payload anywhere in it. That harness exists to exercise
# `resolve_root_from_path`'s file_path-derived rooting through fixture repos
# (ralph/CLAUDE.md § Hooks) — there is no file_path and no rooting here. Worse,
# it would invert the assertion: the subject under test IS the shipped
# ralph/skills/hero/watch-dispatch.md, so asserting against a sandbox copy would
# prove a fixture is injection-resistant while the real file regressed.

set -uo pipefail

PASS=0
FAIL=0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
WATCH_DISPATCH="${REPO_ROOT}/ralph/skills/hero/watch-dispatch.md"

ok()   { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; echo "        expected: $2"; echo "        got:      $3"; FAIL=$((FAIL + 1)); }

if [[ ! -f "$WATCH_DISPATCH" ]]; then
  echo "FATAL: watch-dispatch.md not found at ${WATCH_DISPATCH}" >&2
  exit 1
fi

# Only the § Untrusted issue content section is in scope.
section=$(awk '
  /^### Untrusted issue content/ { f=1; next }
  f && /^## / { exit }
  f { print }
' "$WATCH_DISPATCH")

if [[ -z "$section" ]]; then
  echo "FATAL: '### Untrusted issue content' section not found in watch-dispatch.md" >&2
  exit 1
fi

echo "== 1. delimiter carries a per-dispatch nonce =="

if printf '%s' "$section" | grep -q 'NONCE'; then
  ok "envelope names a NONCE"
else
  fail "envelope names a NONCE" "a NONCE token in the envelope section" "not found"
fi

if printf '%s' "$section" | grep -qE '<issue-content[ -]\{?NONCE'; then
  ok "opening marker is nonce-suffixed (<issue-content …NONCE…>)"
else
  fail "opening marker is nonce-suffixed" \
    "an opening marker of the form <issue-content NONCE>" \
    "not found — a fixed opening marker is forgeable"
fi

if printf '%s' "$section" | grep -qE '</issue-content[ -]\{?NONCE'; then
  ok "closing marker is nonce-suffixed (</issue-content …NONCE…>)"
else
  fail "closing marker is nonce-suffixed" \
    "a closing marker of the form </issue-content NONCE>" \
    "not found — a fixed closing marker can be emitted by the issue body"
fi

if printf '%s' "$section" | grep -qE 'fresh|per[- ]dispatch|regenerat'; then
  ok "nonce is required to be freshly generated per dispatch"
else
  fail "nonce freshness rule" "a 'fresh / per-dispatch' requirement" "not found"
fi

echo
echo "== 2. content is neutralized, not merely delimited =="

if printf '%s' "$section" | grep -qE 'escap|neutraliz|defang|replace'; then
  ok "envelope states an escaping/neutralization rule for the content"
else
  fail "escaping rule" \
    "an explicit escape/neutralize step applied to title+body before interpolation" \
    "not found — the envelope relies on nonce secrecy alone"
fi

if printf '%s' "$section" | grep -q 'issue-content' \
   && printf '%s' "$section" | grep -qiE 'literal .*issue-content|issue-content.* literal|closing marker'; then
  ok "the rule names the literal closing-marker string as the thing to neutralize"
else
  fail "closing-marker neutralization named" \
    "the rule naming a literal </issue-content occurrence" \
    "not found"
fi

echo
echo "== 3. regression case: a body that carries the closing marker =="

if printf '%s' "$section" | grep -qiE 'regression|worked (case|example)|hostile'; then
  ok "section carries a worked regression case"
else
  fail "regression case present" "a worked hostile-body case" "not found"
fi

# The case must actually show the attack string, otherwise it documents nothing.
if printf '%s' "$section" | grep -qF 'ignore your instructions'; then
  ok "regression case shows the injected-instruction payload"
else
  fail "regression case payload" "an injected-instruction payload in the case" "not found"
fi

echo
echo "== 4. the sre-fixit row reuses the same envelope =="

if printf '%s' "$section" | grep -q 'sre-fixit'; then
  ok "sre-fixit row is covered by the same envelope contract"
else
  fail "sre-fixit coverage" "the sre-fixit row named in the envelope section" "not found"
fi

echo
echo "Results: ${PASS} passed, ${FAIL} failed"
[[ "$FAIL" -eq 0 ]]
