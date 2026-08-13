#!/usr/bin/env bash
# hint-pr-linkage — PostToolUse OBSERVATION (Bash). GH-1717, design record #1713.
#
# After a successful `gh pr create` in the ralph-configured repo, note it when
# the new PR closes no issue: without a closing keyword the merge never folds
# back into the board. This is NOT a funnel — it fails the funnel-merge test's
# first question (there is no sanctioned alternative to `gh pr create`; the
# action is legitimate and only a property of it is off). So it never exits 2,
# never gates, and rides an existing branch that healthy runs don't execute.
#
# "Closes no issue" is read from GitHub, never from the Bash command string —
# but GitHub DERIVES that answer asynchronously and this hook runs immediately
# after create, so an empty answer is re-checked against the PR's own body and
# commit messages before anything is said. See the settle note below.
#
# NEVER EXITS NON-ZERO. Every command that can fail is guarded, including the
# final emit: under `set -e` an unguarded last statement makes jq's own status
# the hook's status, and jq exits 2 on a write error — precisely the blocking
# value this design forbids.
#
# APPLY-UNIT CARVE-OUT (mandatory): merge gate 6 (scripts/apply-keywords.sh)
# FORBIDS a closing keyword that binds an apply-kind issue — merging is not
# applying. Hinting "add a keyword" on apply work would push the agent into
# exactly what the gate blocks, so this hook stays silent there.
#
# Scoping mirrors funnel-merge.sh: silent when -R/--repo targets elsewhere,
# silent in repos with no ralph config, silent when origin doesn't match the
# configured host/owner/repo.
set -euo pipefail

INPUT=$(cat)
CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null) || exit 0
[[ "$CMD" == *"gh pr create"* ]] || exit 0

# Another repo's PR is outside this rail's jurisdiction. Attached short form
# (`-Rowner/repo`) needs the slash test so `-R`-prefixed prose in a --body
# string can't false-trip the bypass (GH-1684, same as funnel-merge).
case " $CMD" in *" -R "* | *" --repo "* | *" --repo="*) exit 0 ;; esac
ATTACHED_R_RE=' -R[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+'
if [[ " $CMD" =~ $ATTACHED_R_RE ]]; then exit 0; fi

CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null) || CWD=""
ROOT=$(git -C "${CWD:-$PWD}" rev-parse --show-toplevel 2>/dev/null) || exit 0

# Ralph scope, same precedence as board.ts loadConfig: .ralph.json, else the
# tracked .claude/settings.json env block. No config => not our repo => silent.
CONF="$ROOT/.ralph.json"
[ -f "$CONF" ] || CONF="$ROOT/.claude/settings.json"
[ -f "$CONF" ] || exit 0
SCOPE=$(jq -r '[(.host // .env.RALPH_GH_HOST // "github.com"),
                (.owner // .env.RALPH_GH_OWNER // ""),
                (.repo // .env.RALPH_GH_REPO // "")] | join("/")' "$CONF" 2>/dev/null) || exit 0
[[ "$SCOPE" =~ ^[^/]+/[^/]+/[^/]+$ ]] || exit 0

# Origin must BE the configured repo. Suffix-matching "owner/repo" would accept
# a mirror on another forge, which is the case board.ts scopeMatches() calls out
# by name — so parse host and path the way it does instead.
ORIGIN=$(git -C "$ROOT" remote get-url origin 2>/dev/null) || exit 0
ORIGIN="${ORIGIN%"${ORIGIN##*[![:space:]]}"}"
if [[ "$ORIGIN" =~ ^(https?|ssh|git)://([^@/]+@)?([^/:]+)(:[0-9]+)?/(.+)$ ]]; then
  REMOTE="${BASH_REMATCH[3]}/${BASH_REMATCH[5]}"
elif [[ "$ORIGIN" =~ ^([^@/]+@)?([^/:]+):(.+)$ ]]; then
  REMOTE="${BASH_REMATCH[2]}/${BASH_REMATCH[3]}"
else
  exit 0
fi
while [[ "$REMOTE" == */ ]]; do REMOTE="${REMOTE%/}"; done
REMOTE="${REMOTE%.git}"
shopt -s nocasematch
if [[ "$REMOTE" != "$SCOPE" ]]; then exit 0; fi
shopt -u nocasematch

# Success signal AND the PR number, from the tool result: `gh pr create` prints
# the new PR's URL. Every string in the result is flattened because the payload
# field has drifted across releases (tool_response vs tool_output; string vs
# {stdout,stderr} vs {type,text}) — reading them all outlives the next rename.
# The URL must be OUR repo's: a bare /pull/N would let a PR created elsewhere
# (a `cd` into another clone, GH_REPO=..., gh repo set-default) name an
# unrelated local issue number.
#
# A URL alone doesn't mean the create SUCCEEDED: gh prints the existing PR's
# URL when it fails because the branch already has one. Two guards, because
# neither is sufficient alone — an exit_code is only present if the harness
# sends one (today's Bash tool_response carries stdout/stderr and no exit
# status), and the message text is gh's wording rather than a contract.
RC=$(printf '%s' "$INPUT" | jq -r '(.tool_response // .tool_output // {})
  | if type == "object" then (.exit_code // .exitCode // empty) else empty end
  | tostring' 2>/dev/null) || RC=""
[ -z "$RC" ] || [ "$RC" = "0" ] || exit 0
RESULT=$(printf '%s' "$INPUT" | jq -r '(.tool_response // .tool_output // empty) | [.. | strings] | join("\n")' 2>/dev/null) || exit 0
if grep -qiE 'a pull request for branch .* already exists' <<<"$RESULT"; then exit 0; fi
URL=$(grep -oiE "${SCOPE//./\\.}/pull/[0-9]+" <<<"$RESULT" | head -1 || true)
PR="${URL##*/}"
[ -n "$PR" ] || exit 0

# `-R` rather than gh's implicit resolution: GH_REPO, GH_HOST and
# `gh repo set-default` all override the cwd's remote, so an unpinned lookup
# could read another repo's PR (and, below, another repo's labels — which
# would flip the carve-out) even though the origin check just passed. SCOPE is
# already host/owner/repo, which is exactly gh's [HOST/]OWNER/REPO form.
# Bounded when `timeout` exists (stock macOS has none): these are network calls
# on the PostToolUse path, and a hang would stall the turn until the harness
# timeout fires. Both calls still degrade to silence on any failure.
GH=(gh)
if command -v timeout >/dev/null 2>&1; then GH=(timeout 10 gh); fi
PRJSON=$("${GH[@]}" pr view "$PR" -R "$SCOPE" --json closingIssuesReferences,headRefName,title,body,commits 2>/dev/null) || exit 0
# GitHub's own linkage, not a regex over the body: closing keywords are also
# honoured in commit messages, so a body-only check reports false anomalies.
LINKED=$(jq '(.closingIssuesReferences // []) | length' <<<"$PRJSON" 2>/dev/null) || exit 0
[ "$LINKED" = "0" ] || exit 0

# ...but a ZERO is only authoritative once GitHub has caught up, and here it
# has not. closingIssuesReferences is DERIVED asynchronously, while this hook
# runs within milliseconds of `gh pr create` returning — so a PR whose body
# plainly says "Closes #M" reports zero references for the first moments of its
# life. Observed on #1764 (body carried `Closes #1763`; the same query answers
# 1763 seconds later). Nonzero above stays authoritative-positive; a zero only
# earns the hint after re-reading the two texts GitHub itself honours keywords
# in, both already in the response above at no extra round trip.
#
# Note this subsumes scanning the Bash command string: `--body-file`, `--fill`,
# a heredoc via `$(cat <<'EOF' … EOF)`, and an editor-composed body all land in
# .body regardless of how they reached gh.
#
# Deliberately biased toward silence: a keyword GitHub will NOT honour (an
# already-closed issue, a foreign repo, text inside a code fence) suppresses an
# advisory line. For an observation that never gates, a missed hint is the
# harmless way to be wrong and a false alarm is not.
CLOSE_RE='(^|[^A-Za-z])(close[sd]?|fix(es|ed)?|resolve[sd]?)[[:space:]]*:?[[:space:]]*(#|[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+#|https?://[^[:space:]]+/issues/)[0-9]+'
KEYWORD_TEXT=$(jq -r '[(.body // "" | tostring),
                       ((.commits // []) | map(((.messageHeadline // "") + "\n" + (.messageBody // ""))) | join("\n"))]
                      | join("\n")' <<<"$PRJSON" 2>/dev/null) || KEYWORD_TEXT=""
if grep -qiE "$CLOSE_RE" <<<"$KEYWORD_TEXT"; then exit 0; fi

# --- Apply-unit carve-out ---------------------------------------------------
# Fails CLOSED on a malformed policy, exactly like scripts/apply-keywords.sh:
# a truncated policy must not silently disable the gate it configures.
POLICY="$ROOT/.github/ralph-merge-policy.json"
ARMED=false
LABEL="ralph:apply"
if [ -f "$POLICY" ]; then
  # `jq -e .` proves the file parses; it does NOT prove `.apply` is an object,
  # and indexing a scalar makes jq exit 5. Guarded so a hand-edit typo like
  # `"apply": true` can't turn a hook that promises never to fail into one that
  # prints a raw jq error. Fail closed, same as the unparseable branch below.
  if jq -e . "$POLICY" >/dev/null 2>&1; then
    # A non-boolean `enabled` is malformed, not falsy: `"yes"` or `1` would
    # otherwise stringify into something that isn't "true" and DISARM the
    # carve-out — fail-open, in the one place that must fail closed.
    ARMED=$(jq -r 'if .apply.enabled == null then "false"
                   elif (.apply.enabled | type) == "boolean" then (.apply.enabled | tostring)
                   else "true" end' "$POLICY" 2>/dev/null) || ARMED=true
    LABEL=$(jq -r '(.apply.label | strings) // "ralph:apply"' "$POLICY" 2>/dev/null) || LABEL="ralph:apply"
  else
    ARMED=true
  fi
fi
if [ "$ARMED" = "true" ]; then
  # Check EVERY reference the PR carries, not just the branch and not just the
  # first match: apply units are REQUIRED to say "Refs #N" (gate 6 bans
  # "Closes"), `apply/…` and `claude/<slug>` branches carry no GH-N, and a body
  # routinely names its epic or a superseded issue BEFORE the unit itself.
  # Checking all of them makes over-resolution the only failure mode, and
  # over-resolving can only silence the hint — the safe direction. Capped at 5
  # so a reference-heavy body can't turn one hook into a burst of API calls.
  REFS=$(jq -r '[.headRefName, .title, .body] | map(. // "" | tostring) | join("\n")' <<<"$PRJSON" 2>/dev/null) || REFS=""
  UNITS=$(grep -oiE 'gh-[0-9]+|#[0-9]+' <<<"$REFS" | tr -dc '0-9\n' | grep -v '^$' | awk '!seen[$0]++' | head -5 || true)
  while IFS= read -r UNIT; do
    [ -n "$UNIT" ] || continue
    # Captured, not piped into `grep -q`: -q exits on first match, and under
    # `pipefail` gh's EPIPE would fail the condition and skip the carve-out.
    LABELS=$("${GH[@]}" issue view "$UNIT" -R "$SCOPE" --json labels --jq '.labels[].name' 2>/dev/null || true)
    if grep -qxF "$LABEL" <<<"$LABELS"; then exit 0; fi
  done <<<"$UNITS"
fi

MSG="PR #$PR has no closing keyword — link its issue (Closes #M) so the board can fold the merge in"
# Exit 0 with structured stdout: the non-blocking channel. Exit 2 would feed
# stderr back as a turn error, which is precisely the shape #1713 forbids here.
jq -nc --arg m "$MSG" \
  '{systemMessage: $m, hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $m}}' || true
exit 0
