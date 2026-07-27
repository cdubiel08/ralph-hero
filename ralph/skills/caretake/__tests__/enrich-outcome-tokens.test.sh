#!/usr/bin/env bash
# enrich-outcome-tokens.test.sh — Verify enrich.md's BLOCKED tokens cannot be
# split across lines by embedded git/gh stderr.
# Usage: bash ralph/skills/caretake/__tests__/enrich-outcome-tokens.test.sh
# Exit 0 = all pass; exit 1 = at least one failure.
#
# Does NOT invoke caretake --mode enrich (it has no Stop hook and mutates git/
# GitHub state) — parses modes/enrich.md and outcome-tokens.md, and actually
# evaluates the `sanitize_diag()` helper extracted from the doc's own fenced
# bash block to prove it collapses a multiline diagnostic to one line.
#
# Regression target: CodeRabbit review 2026-07-27T14:20:52Z on PR #1620 —
# "Keep failure diagnostics out of multiline terminal tokens" (enrich.md:160).
# The terminal token is the LAST LINE of the transcript (outcome-tokens.md §
# file-level invariant) and must stay verbatim-parseable; embedding raw
# multiline `git`/`gh` stderr in an `ENRICH BLOCKED ...: <stderr>` token would
# split it across several physical lines and break that read.

set -uo pipefail

PASS=0
FAIL=0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
ENRICH="${REPO_ROOT}/ralph/skills/caretake/modes/enrich.md"
OUTCOME_TOKENS="${REPO_ROOT}/ralph/skills/caretake/outcome-tokens.md"

ok()   { echo "PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "FAIL: $1"; echo "      expected: $2"; echo "      got:      $3"; FAIL=$((FAIL + 1)); }

# ── 1. Files exist ──────────────────────────────────────────────────────────

if [[ -f "$ENRICH" ]]; then
  ok "modes/enrich.md exists"
else
  fail "modes/enrich.md exists" "file present" "not found at ${ENRICH}"
fi

if [[ -f "$OUTCOME_TOKENS" ]]; then
  ok "outcome-tokens.md exists"
else
  fail "outcome-tokens.md exists" "file present" "not found at ${OUTCOME_TOKENS}"
fi

# ── 2. enrich.md defines sanitize_diag() ────────────────────────────────────

if grep -q 'sanitize_diag()' "$ENRICH"; then
  ok "modes/enrich.md defines sanitize_diag()"
else
  fail "sanitize_diag() defined in modes/enrich.md" "function definition present" "not found"
fi

# ── 3. Extract and actually evaluate the helper — prove it collapses a real  ─
#      multiline diagnostic (e.g. git push stderr) to a single line.

extracted=$(awk '/^sanitize_diag\(\) \{/{f=1} f{print} f&&/^\}/{exit}' "$ENRICH")

if [[ -n "$extracted" ]]; then
  ok "sanitize_diag() body extracted from modes/enrich.md"
  eval "$extracted"

  multiline_input='error: failed to push some refs
hint: Updates were rejected because the remote contains work
hint: that you do not have locally.'

  result="$(sanitize_diag "$multiline_input")"
  line_count=$(printf '%s' "$result" | wc -l | tr -d '[:space:]')

  if [[ "$line_count" -eq 0 ]]; then
    ok "sanitize_diag() collapses a 3-line diagnostic to a single line"
  else
    fail "sanitize_diag() output line count" "0 embedded newlines" "${line_count} embedded newline(s): ${result}"
  fi

  if [[ "$result" == *$'\n'* ]]; then
    fail "sanitize_diag() output has no literal newline byte" "no \\n in output" "found \\n in: ${result}"
  else
    ok "sanitize_diag() output has no literal newline byte"
  fi

  long_input=$(printf 'x%.0s' {1..500})
  capped="$(sanitize_diag "$long_input")"
  capped_len=${#capped}
  if [[ "$capped_len" -le 300 ]]; then
    ok "sanitize_diag() caps output length (<=300 chars; got ${capped_len})"
  else
    fail "sanitize_diag() length cap" "<=300 chars" "${capped_len} chars"
  fi
else
  fail "sanitize_diag() body extracted from modes/enrich.md" "non-empty function body" "empty or not found"
fi

# ── 4. Every ENRICH BLOCKED *-failed printf routes its diagnostic through   ─
#      sanitize_diag() — not the raw ${..._err} variable directly.

check_sanitized_token() {
  local label="$1"
  local pattern="$2"
  if grep -qE "$pattern" "$ENRICH"; then
    ok "modes/enrich.md sanitizes diagnostic for: ${label}"
  else
    fail "modes/enrich.md sanitizes diagnostic for: ${label}" "pattern '${pattern}' found" "not found"
  fi
}

check_sanitized_token "checkout-main-failed" 'checkout-main-failed: \$\(sanitize_diag "\$checkout_err"\)'
check_sanitized_token "commit-failed"        'commit-failed: \$\(sanitize_diag "\$commit_err"\)'
check_sanitized_token "push-failed"          'push-failed: \$\(sanitize_diag "\$push_err"\)'
check_sanitized_token "pr-create-failed"     'pr-create-failed: \$\(sanitize_diag "\$pr_err"\)'
check_sanitized_token "pr-create-failed (lookup fallback)" 'lookup failed: \$\(sanitize_diag "\$\{view_err:-empty url\}"\)'

# Negative check: no raw `${..._err}` interpolation should remain directly
# inside a printed `ENRICH BLOCKED ...:` token line (that is exactly the
# multiline-token defect this test guards against).
raw_leak=$(grep -nE 'ENRICH BLOCKED [a-z-]+-failed: \$\{[a-z_]+_err\}"' "$ENRICH" || true)
if [[ -z "$raw_leak" ]]; then
  ok "no raw \${..._err} interpolated directly into an ENRICH BLOCKED token"
else
  fail "no raw \${..._err} in ENRICH BLOCKED token" "no matches" "$raw_leak"
fi

# ── 5. outcome-tokens.md's canonical contract documents sanitized diagnostics ─

if grep -q '<sanitized-stderr>' "$OUTCOME_TOKENS"; then
  ok "outcome-tokens.md uses <sanitized-stderr> placeholder for ENRICH BLOCKED tokens"
else
  fail "outcome-tokens.md <sanitized-stderr> placeholder" "found" "not found"
fi

unsanitized_leak=$(grep -nE 'ENRICH BLOCKED [a-z-]+-failed: <stderr>' "$OUTCOME_TOKENS" || true)
if [[ -z "$unsanitized_leak" ]]; then
  ok "outcome-tokens.md has no stale <stderr> (unsanitized) ENRICH BLOCKED token"
else
  fail "no stale <stderr> ENRICH BLOCKED token in outcome-tokens.md" "no matches" "$unsanitized_leak"
fi

# ── summary ──────────────────────────────────────────────────────────────────

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
if [[ "$FAIL" -eq 0 ]]; then
  exit 0
else
  exit 1
fi
