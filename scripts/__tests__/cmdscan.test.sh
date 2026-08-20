#!/usr/bin/env bash
# scripts/__tests__/cmdscan.test.sh
# Tests ralph/hooks/lib/cmdscan.sh — the quote-aware command reader the four
# courtesy funnels share (GH-2058).
#
# Two things are asserted here, and the second is the reason the library
# exists at all:
#
#   1. The WALK itself: what counts as quoted, what counts as a separator,
#      what a comment is. Every one of these was previously answered by a
#      line-at-a-time `sed` or a chain of bash substitutions in four separate
#      files, and every real command is multi-line.
#
#   2. That the four funnels actually READ it — and that none of them still
#      carries a hand-rolled stripper beside it. GH-2057 fixed this defect in
#      funnel-merge.sh alone and the three siblings kept it for exactly the
#      reason GH-1843 named: a rule living in N places held together by a
#      comment asking the copies to stay in sync. A shared file that a fifth
#      copy can silently appear beside buys nothing, so the anti-drift check
#      is a test rather than a convention.

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LIB="$ROOT/ralph/hooks/lib/cmdscan.sh"

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

if [ ! -r "$LIB" ]; then
  echo "FAIL: $LIB is not readable" >&2
  exit 1
fi
# shellcheck source=../../ralph/hooks/lib/cmdscan.sh
. "$LIB"

# eq <desc> <expected> <actual>
eq() {
  local desc="$1" want="$2" got="$3"
  if [ "$want" = "$got" ]; then
    pass "$desc"
  else
    fail "$desc"
    printf '    want: %s\n    got : %s\n' "$(printf '%s' "$want" | cat -v)" "$(printf '%s' "$got" | cat -v)"
  fi
}

# Render segments with a visible delimiter so a diff is readable.
segs() { cs_segments "$1" | sed -e 's/\x01/|/g'; }

echo "== cs_strip_quotes: the whole command, not a line at a time =="

eq "a double-quoted span across newlines is stripped" \
  'gh issue create --body  --title X' \
  "$(cs_strip_quotes 'gh issue create --body "line one
gh pr merge 5 and more" --title X')"

eq "a single-quoted span across newlines is stripped" \
  'gh api graphql -f query= --tail' \
  "$(cs_strip_quotes "gh api graphql -f query='mutation {
  addSubIssue(x)
}' --tail")"

eq "a backslash-escaped quote does not end the span" \
  'echo  done' \
  "$(cs_strip_quotes 'echo "he said \"gh pr merge\" once" done')"

# An unterminated quote is a syntax error the shell would refuse anyway, so
# swallowing the rest under-redirects — the safe direction for a courtesy rail.
eq "an unterminated quote consumes the rest" \
  'echo ' \
  "$(cs_strip_quotes 'echo "gh pr merge 5')"

# Load-bearing: outside quotes, backticks are command substitution, so what is
# inside them really does run. Stripping them would open the hole the rails
# exist to close.
eq "backticks outside quotes are NOT stripped" \
  'echo `gh pr merge 5`' \
  "$(cs_strip_quotes 'echo `gh pr merge 5`')"

echo "== cs_strip_quotes keep_subst: substitution is execution, not an argument =="

eq "a double-quoted span carrying \$( ) is preserved" \
  'until [ -z "$(gh pr checks 5)" ]; do sleep 3; done' \
  "$(cs_strip_quotes 'until [ -z "$(gh pr checks 5)" ]; do sleep 3; done' 1)"

eq "a double-quoted span carrying a backtick is preserved" \
  'x="`gh pr checks 5`"' \
  "$(cs_strip_quotes 'x="`gh pr checks 5`"' 1)"

eq "a plain double-quoted span is still stripped under keep_subst" \
  'echo ; sleep 1' \
  "$(cs_strip_quotes 'echo "plain gh pr checks text"; sleep 1' 1)"

# Single quotes suppress substitution entirely, so they are always dropped.
eq "a single-quoted span is dropped even under keep_subst" \
  'echo ' \
  "$(cs_strip_quotes "echo '\$(gh pr checks 5)'" 1)"

eq "keep_subst is off by default" \
  'echo ' \
  "$(cs_strip_quotes 'echo "$(gh pr checks 5)"')"

echo "== cs_segments: separators are only separators when unquoted =="

# `&&` and `||` yield an empty segment between their two halves. Harmless —
# every caller skips a blank segment — and pinned so the shape is deliberate.
eq "unquoted ; & | and newlines split" \
  'a |b ||c ||d |e||' \
  "$(segs 'a ;b &&c ||d |e')"

eq "a newline is a separator too" \
  'git status|board get 1||' \
  "$(segs 'git status
board get 1')"

eq "separators inside a quoted span do not split it" \
  'gh issue create --body "a; b && c | d
e" | board get 1||' \
  "$(segs 'gh issue create --body "a; b && c | d
e" ; board get 1')"

eq "a comment runs to end of LINE, not end of command" \
  'git push --force |board get 1||' \
  "$(segs 'git push --force # note
board get 1')"

eq "a hash inside a quoted span is not a comment" \
  'gh issue create --body "fix #2058 now"| echo hi||' \
  "$(segs 'gh issue create --body "fix #2058 now"; echo hi')"

eq "a hash mid-word is not a comment" \
  'curl http://x#frag| board get 1||' \
  "$(segs 'curl http://x#frag; board get 1')"

# A delimiter follows EVERY segment including the last, so a `read -r -d` loop
# does not drop the final one at EOF — which is how funnel-push silently
# stopped redirecting a single-line force push during this fix.
eq "the last segment is delimited too" \
  'git push --force origin feat/x||' \
  "$(segs 'git push --force origin feat/x')"

echo "== cs_command_word: where a pattern sits decides what it means =="

# The command-position rule (ways-of-working audit B4): a mutation name in an
# argument to grep/rg/sed/awk/python is data, the same bytes after `gh` in
# command position are a mutation being run. The POLICY (which words count)
# stays in each rail; only the reading of "which token is the command" is
# shared here.

eq "a plain command word" \
  'gh' \
  "$(cs_command_word 'gh api graphql -f query=x')"

eq "a pathed command word is returned whole (callers match */gh)" \
  '/usr/local/bin/gh' \
  "$(cs_command_word '/usr/local/bin/gh api graphql')"

eq "VAR=value prefixes are environment, not the command" \
  'gh' \
  "$(cs_command_word 'GH_PAGER= GH_TOKEN=x gh api graphql')"

eq "a subshell paren does not hide the command word" \
  'gh' \
  "$(cs_command_word '(gh pr list)')"

eq "wrapping quotes are removed" \
  '$RALPH_BOARD' \
  "$(cs_command_word '"$RALPH_BOARD" move 1 done')"

eq "grep with an unquoted mutation-name argument reads as grep" \
  'grep' \
  "$(cs_command_word 'grep -n deleteProjectV2Item board.ts')"

eq "a python heredoc opener reads as python" \
  'python3' \
  "$(cs_command_word "python3 - <<'EOF'")"

eq "leading whitespace is skipped" \
  'curl' \
  "$(cs_command_word '   curl -d x https://api.github.com/graphql')"

eq "an empty segment yields an empty command word" \
  '' \
  "$(cs_command_word '   ')"

# A wrapper the reader does not see through reads as itself — which can only
# UNDER-redirect, the library's stated failure direction.
eq "a wrapper reads as the wrapper" \
  'env' \
  "$(cs_command_word 'env gh api graphql')"

echo "== every funnel reads the shared library, and none keeps a copy =="

FUNNELS=()
while IFS= read -r f; do FUNNELS+=("$f"); done < <(find "$ROOT/ralph/hooks" -maxdepth 1 -name 'funnel-*.sh' -type f | sort)
if [ "${#FUNNELS[@]}" -eq 0 ]; then
  fail "no funnel-*.sh found to check"
fi
echo "  (${#FUNNELS[@]} funnels)"

for f in "${FUNNELS[@]}"; do
  name=$(basename "$f")
  if grep -q 'lib/cmdscan.sh' "$f"; then
    pass "$name sources the shared reader"
  else
    fail "$name does not source lib/cmdscan.sh"
  fi
  # A hand-rolled quote stripper beside the shared one is the drift this
  # library exists to remove: the two would answer differently and only one
  # would get fixed next time. Matched on the QUOTED-SPAN REGEX rather than on
  # `sed`, because GH-2057's funnel-merge fix was written in awk — a check
  # spelling only the tool it last saw would have missed it.
  if grep -qF -e '[^'"'"']*'"'"'' -e '[^"]*"' "$f"; then
    fail "$name still carries its own quoted-span regex"
  else
    pass "$name keeps no private quote stripper"
  fi
done

echo
echo "cmdscan: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
