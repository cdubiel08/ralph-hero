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
# APPLY-UNIT CARVE-OUT (mandatory): merge gate 6 (scripts/apply-keywords.sh)
# FORBIDS a closing keyword that binds an apply-kind issue — merging is not
# applying. Hinting "add a keyword" on apply work would push the agent into
# exactly what the gate blocks, so this hook stays silent there.
#
# Scoping mirrors funnel-merge.sh: silent when -R/--repo targets elsewhere,
# silent in repos with no ralph config, silent when origin doesn't match the
# configured owner/repo.
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

# Success signal AND the PR number, from the tool result: `gh pr create` prints
# the new PR's URL. Every string in the result is flattened because the payload
# field has drifted across releases (tool_response vs tool_output; string vs
# {stdout,stderr} vs {type,text}) — reading them all outlives the next rename.
# No URL => the create failed, or wasn't a create. Silent either way.
RESULT=$(printf '%s' "$INPUT" | jq -r '(.tool_response // .tool_output // empty) | [.. | strings] | join("\n")' 2>/dev/null) || exit 0
PR=$(grep -oE '/pull/[0-9]+' <<<"$RESULT" | head -1 | tr -dc '0-9' || true)
[ -n "$PR" ] || exit 0

CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null) || CWD=""
ROOT=$(git -C "${CWD:-$PWD}" rev-parse --show-toplevel 2>/dev/null) || exit 0

# Ralph scope, same precedence as board.ts loadConfig: .ralph.json, else the
# tracked .claude/settings.json env block. No config => not our repo => silent.
CONF="$ROOT/.ralph.json"
[ -f "$CONF" ] || CONF="$ROOT/.claude/settings.json"
[ -f "$CONF" ] || exit 0
SCOPE=$(jq -r '(.owner // .env.RALPH_GH_OWNER // "") + "/" + (.repo // .env.RALPH_GH_REPO // "")' "$CONF" 2>/dev/null) || exit 0
[[ "$SCOPE" =~ ^[^/]+/[^/]+$ ]] || exit 0
ORIGIN=$(git -C "$ROOT" remote get-url origin 2>/dev/null) || exit 0
[[ "${ORIGIN%.git}" == *"$SCOPE" ]] || exit 0

cd "$ROOT" || exit 0
PRJSON=$(gh pr view "$PR" --json closingIssuesReferences,headRefName 2>/dev/null) || exit 0
# GitHub's own linkage, not a regex over the body: closing keywords are also
# honoured in commit messages, so a body-only check reports false anomalies.
LINKED=$(jq '(.closingIssuesReferences // []) | length' <<<"$PRJSON" 2>/dev/null) || exit 0
[ "$LINKED" = "0" ] || exit 0

# Apply-unit carve-out. Only reachable when the repo has armed the apply kind;
# elsewhere the label carries no meaning and this costs no API call. Honest
# limit: the unit is identified from the branch's `GH-N`, so a branch that
# doesn't carry one can still draw the hint — gate 6 is the backstop there,
# and it fails loudly at merge rather than quietly at create.
POLICY="$ROOT/.github/ralph-merge-policy.json"
if [ -f "$POLICY" ] && [ "$(jq -r '.apply.enabled // false' "$POLICY" 2>/dev/null)" = "true" ]; then
  LABEL=$(jq -r '.apply.label // "ralph:apply"' "$POLICY" 2>/dev/null) || LABEL="ralph:apply"
  ISSUE=$(jq -r '.headRefName // ""' <<<"$PRJSON" | grep -oiE 'gh-[0-9]+' | head -1 | tr -dc '0-9' || true)
  if [ -n "$ISSUE" ] && gh issue view "$ISSUE" --json labels --jq '.labels[].name' 2>/dev/null | grep -qxF "$LABEL"; then
    exit 0
  fi
fi

MSG="PR #$PR has no closing keyword — link its issue (Closes #M) so the board can fold the merge in"
# Exit 0 with structured stdout: the non-blocking channel. Exit 2 would feed
# stderr back as a turn error, which is precisely the shape #1713 forbids here.
jq -nc --arg m "$MSG" \
  '{systemMessage: $m, hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $m}}'
exit 0
