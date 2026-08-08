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
# unrelated local issue number. A non-zero exit_code, when the payload carries
# one, is authoritative — gh prints an existing PR's URL when a create FAILS
# because the branch already has one.
RC=$(printf '%s' "$INPUT" | jq -r '(.tool_response // .tool_output // {})
  | if type == "object" then (.exit_code // .exitCode // empty) else empty end
  | tostring' 2>/dev/null) || RC=""
[ -z "$RC" ] || [ "$RC" = "0" ] || exit 0
RESULT=$(printf '%s' "$INPUT" | jq -r '(.tool_response // .tool_output // empty) | [.. | strings] | join("\n")' 2>/dev/null) || exit 0
URL=$(grep -oiE "${SCOPE//./\\.}/pull/[0-9]+" <<<"$RESULT" | head -1 || true)
PR="${URL##*/}"
[ -n "$PR" ] || exit 0

cd "$ROOT" || exit 0
PRJSON=$(gh pr view "$PR" --json closingIssuesReferences,headRefName,title,body 2>/dev/null) || exit 0
# GitHub's own linkage, not a regex over the body: closing keywords are also
# honoured in commit messages, so a body-only check reports false anomalies.
LINKED=$(jq '(.closingIssuesReferences // []) | length' <<<"$PRJSON" 2>/dev/null) || exit 0
[ "$LINKED" = "0" ] || exit 0

# --- Apply-unit carve-out ---------------------------------------------------
# Fails CLOSED on a malformed policy, exactly like scripts/apply-keywords.sh:
# a truncated policy must not silently disable the gate it configures.
POLICY="$ROOT/.github/ralph-merge-policy.json"
ARMED=false
LABEL="ralph:apply"
if [ -f "$POLICY" ]; then
  if jq -e . "$POLICY" >/dev/null 2>&1; then
    ARMED=$(jq -r '.apply.enabled // false | tostring' "$POLICY")
    LABEL=$(jq -r '(.apply.label | strings) // "ralph:apply"' "$POLICY")
  else
    ARMED=true
  fi
fi
if [ "$ARMED" = "true" ]; then
  # Resolve the unit from every reference the PR carries, not the branch alone:
  # apply units are REQUIRED to say "Refs #N" (gate 6 bans "Closes"), and
  # `apply/…` / `claude/<slug>` branches carry no GH-N. GH-N wins over a bare
  # #N. Over-resolving is the safe direction — it can only silence the hint.
  REFS=$(jq -r '[.headRefName, .title, .body] | map(. // "" | tostring) | join("\n")' <<<"$PRJSON" 2>/dev/null) || REFS=""
  UNIT=$(grep -oiE 'gh-[0-9]+' <<<"$REFS" | head -1 | tr -dc '0-9' || true)
  [ -n "$UNIT" ] || UNIT=$(grep -oE '#[0-9]+' <<<"$REFS" | head -1 | tr -dc '0-9' || true)
  if [ -n "$UNIT" ]; then
    # Captured, not piped into `grep -q`: -q exits on first match, and under
    # `pipefail` gh's EPIPE would fail the condition and skip the carve-out.
    LABELS=$(gh issue view "$UNIT" --json labels --jq '.labels[].name' 2>/dev/null || true)
    if grep -qxF "$LABEL" <<<"$LABELS"; then exit 0; fi
  fi
fi

MSG="PR #$PR has no closing keyword — link its issue (Closes #M) so the board can fold the merge in"
# Exit 0 with structured stdout: the non-blocking channel. Exit 2 would feed
# stderr back as a turn error, which is precisely the shape #1713 forbids here.
jq -nc --arg m "$MSG" \
  '{systemMessage: $m, hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $m}}' || true
exit 0
