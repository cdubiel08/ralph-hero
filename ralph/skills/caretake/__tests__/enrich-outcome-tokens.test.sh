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

# ── 3. Extract the helper, ALLOWLIST it, then run it in an isolated shell —  ─
#      prove it collapses a real multiline diagnostic (git push stderr) to one
#      line, without ever letting Markdown content execute in this shell.
#
# CodeRabbit (PR #1620, 2026-07-27): the previous version ran `eval "$extracted"`
# directly, so any content-only edit to modes/enrich.md executed arbitrary shell
# in every environment that ran this test (ast-grep eval-on-variable-bash,
# CWE-78). Behavioral proof is still worth having — a structural grep cannot
# tell a working `tr`/`cut` pipeline from a broken one — so the execution is
# kept but fenced two ways, which is the remediation the rule itself names
# ("restrict input to a validated allowlist before running it"):
#
#   1. ALLOWLIST. The extracted body must consist only of the shape this helper
#      is allowed to have: a `printf`-fed pipeline of tr/cut/sed. Any command
#      substitution, backtick, redirection, `eval`, or unlisted command fails
#      the test instead of running.
#   2. ISOLATION. What survives the allowlist runs via `bash` in a separate
#      process from a temp file, never sourced into this shell.

extracted=$(awk '/^sanitize_diag\(\) \{/{f=1} f{print} f&&/^\}/{exit}' "$ENRICH")

# allowlist_ok <body> — 0 when every line is a permitted construct.
# Permitted: the `sanitize_diag() {` header, the closing `}`, blank/comment
# lines, and pipeline segments built only from printf/tr/cut/sed with a
# trailing `\` continuation. Explicitly rejected anywhere: $( ), ` `, ${...}
# other than the "$1" positional, >, <, ;, &, and the word `eval`.
allowlist_ok() {
  local body="$1" line
  while IFS= read -r line; do
    [[ -z "${line//[[:space:]]/}" ]] && continue
    [[ "$line" == 'sanitize_diag() {' || "$line" == '}' ]] && continue
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    # Dangerous constructs, checked before the positive match so a permitted
    # command name cannot smuggle one in.
    if [[ "$line" == *'$('* || "$line" == *'`'* || "$line" == *';'* \
       || "$line" == *'>'* || "$line" == *'<'* || "$line" == *'&'* \
       || "$line" == *'eval'* ]]; then
      echo "      rejected line (unsafe construct): $line" >&2
      return 1
    fi
    if [[ ! "$line" =~ ^[[:space:]]*(\|[[:space:]]*)?(printf|tr|cut|sed)[[:space:]] ]]; then
      echo "      rejected line (command not on allowlist): $line" >&2
      return 1
    fi
  done <<< "$body"
  return 0
}

if [[ -z "$extracted" ]]; then
  fail "sanitize_diag() body extracted from modes/enrich.md" "non-empty function body" "empty or not found"
elif ! allowlist_ok "$extracted"; then
  fail "sanitize_diag() body is allowlist-clean" \
    "only printf/tr/cut/sed pipeline segments, no substitution or redirection" \
    "an unsafe or unrecognized construct (see rejected line above)"
else
  ok "sanitize_diag() body extracted from modes/enrich.md"
  ok "sanitize_diag() body is allowlist-clean (no substitution, redirection, or eval)"

  # Isolation: run the allowlisted body in its own bash process. "$1" is the
  # diagnostic under test; nothing from enrich.md enters this shell.
  RUNNER="$(mktemp)"
  trap 'rm -f "$RUNNER"' EXIT
  printf '%s\n\nsanitize_diag "$1"\n' "$extracted" > "$RUNNER"

  run_sanitize() { bash "$RUNNER" "$1"; }

  multiline_input='error: failed to push some refs
hint: Updates were rejected because the remote contains work
hint: that you do not have locally.'

  result="$(run_sanitize "$multiline_input")"
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
  capped="$(run_sanitize "$long_input")"
  capped_len=${#capped}
  if [[ "$capped_len" -le 300 ]]; then
    ok "sanitize_diag() caps output length (<=300 chars; got ${capped_len})"
  else
    fail "sanitize_diag() length cap" "<=300 chars" "${capped_len} chars"
  fi
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
check_sanitized_token "stage-failed"         'stage-failed: \$\(sanitize_diag "\$add_err"\)'
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

# ── 4b. Every state-changing git command in §Step 4 is exit-checked ─────────
# CodeRabbit (PR #1620, 2026-07-27): `git add` was the one unchecked command
# left in an otherwise fully-checked block. A failed stage leaves the index as
# it was, the following `git commit` then succeeds against a STALE index, and
# the mode reports `ENRICHED <N> (PR <url>)` for findings that never got
# staged — unrecoverable, because §Step 3 already flipped those files to
# `status: forming`.

check_guarded_command() {
  local label="$1" pattern="$2"
  if grep -qE "$pattern" "$ENRICH"; then
    ok "modes/enrich.md exit-checks: ${label}"
  else
    fail "modes/enrich.md exit-checks: ${label}" "guarded form '${pattern}' found" "not found (unchecked command)"
  fi
}

check_guarded_command "git add"      'if ! add_err=\$\(git add -- "\$\{SELECTED_FILES\[@\]\}" 2>&1\); then'
check_guarded_command "git commit"   'if ! commit_err=\$\(git commit '
check_guarded_command "git push"     'if ! push_err=\$\(git push origin '
check_guarded_command "git checkout" 'if ! checkout_err=\$\(git checkout main 2>&1\); then'

# Negative: no bare `git add` line may remain in the doc's bash blocks.
bare_add=$(grep -nE '^[[:space:]]*git add ' "$ENRICH" || true)
if [[ -z "$bare_add" ]]; then
  ok "no unchecked bare 'git add' remains in modes/enrich.md"
else
  fail "no unchecked bare 'git add' in modes/enrich.md" "no matches" "$bare_add"
fi

# ── 5. outcome-tokens.md's canonical contract documents sanitized diagnostics ─

if grep -q '<sanitized-stderr>' "$OUTCOME_TOKENS"; then
  ok "outcome-tokens.md uses <sanitized-stderr> placeholder for ENRICH BLOCKED tokens"
else
  fail "outcome-tokens.md <sanitized-stderr> placeholder" "found" "not found"
fi

if grep -q 'ENRICH BLOCKED stage-failed: <sanitized-stderr>' "$OUTCOME_TOKENS"; then
  ok "outcome-tokens.md documents the ENRICH BLOCKED stage-failed token"
else
  fail "outcome-tokens.md stage-failed token" "'ENRICH BLOCKED stage-failed: <sanitized-stderr>' present" "not found"
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
