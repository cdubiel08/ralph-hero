#!/usr/bin/env bash
# funnel-push — courtesy rail (PreToolUse on Bash): a raw FORCE push to a
# branch that has an open PR is redirected to the lease script
# (ralph/scripts/deliver-push.sh, GH-1917). NOT enforcement — the guarantee is
# that git's ref update is a real compare-and-swap and the lease script is the
# only path that uses it; this only makes the redirect legible at the moment
# someone reaches for the wrong tool (GH-1930).
#
# Scope is deliberately narrow, because the failure mode of a wrong redirect is
# a session that cannot push its own work:
#   * only a FORCE push (--force / -f / --force-with-lease / a leading `+` in
#     the refspec). A fast-forward push is every work session's normal move and
#     is never in scope — GH-1917's hazard is the destructive write.
#   * only a branch with an OPEN PR. That is the "PR branch" the issue names,
#     and it is also the only branch a deliver lane ever touches. Unknown or
#     unreadable PR state fails OPEN: a courtesy rail may not strand a push
#     because `gh` was rate-limited.
#   * only when the plugin actually ships deliver-push.sh — a redirect must
#     name a path the session can run.
#
# Quoted vs run (the defect this issue filed against the funnels themselves):
# a command that merely QUOTES `git push --force` as an argument — filing an
# issue about this rail, writing a doc, grepping for it — is not running it.
# Each segment has its quoted spans stripped before matching, so this funnel
# does not refuse documentation about itself.
set -euo pipefail

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
PUSH_SCRIPT="$PLUGIN_ROOT/scripts/deliver-push.sh"
[ -f "$PUSH_SCRIPT" ] || exit 0

INPUT=$(cat)
CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null) || exit 0
[ -n "$CMD" ] || exit 0
case "$CMD" in *"git push"*) ;; *) exit 0 ;; esac

CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null) || CWD=""
CWD="${CWD:-$PWD}"

# Strip quoted spans: what is quoted is an ARGUMENT, not a command being run.
# Both quote styles, non-greedy, applied per segment.
strip_quotes() {
  printf '%s' "$1" | sed -e "s/'[^']*'//g" -e 's/"[^"]*"//g'
}

# Split on shell separators, same shape as funnel-board.
SEGMENTS=${CMD%%#*}
SEGMENTS=${SEGMENTS//;/$'\n'}
SEGMENTS=${SEGMENTS//&/$'\n'}
SEGMENTS=${SEGMENTS//|/$'\n'}

while IFS= read -r raw_seg; do
  seg=$(strip_quotes "$raw_seg")
  [ -n "${seg//[[:space:]]/}" ] || continue
  # The sanctioned path exempts its own segment.
  case "$seg" in *deliver-push.sh*) continue ;; esac
  case "$seg" in *"git push"*) ;; *) continue ;; esac

  # Force detection. `-f` must be its own token (or bundled in a short cluster
  # like -fu), never a substring of `--follow-tags` or a branch name.
  ARGS=" ${seg#*git push} "
  FORCED=""
  case "$ARGS" in
    *" --force "* | *" --force-with-lease"* | *" --force-if-includes "*) FORCED=1 ;;
  esac
  [[ "$ARGS" =~ [[:space:]]-[A-Za-z]*f[A-Za-z]*[[:space:]] ]] && FORCED=1
  # A leading `+` on the refspec is force in refspec grammar.
  [[ "$ARGS" =~ [[:space:]]\+[^[:space:]]+:[^[:space:]]+[[:space:]] ]] && FORCED=1
  [ -n "$FORCED" ] || continue

  # Which branch? An explicit refspec's DESTINATION wins; otherwise the
  # checked-out branch. Flags and the remote name are skipped.
  BRANCH=""
  read -r -a toks <<< "$ARGS"
  positional=()
  for t in "${toks[@]}"; do
    case "$t" in -*) continue ;; esac
    positional+=("$t")
  done
  if [ "${#positional[@]}" -ge 2 ]; then
    ref="${positional[1]}"
    ref="${ref#+}"
    BRANCH="${ref##*:}"
    BRANCH="${BRANCH#refs/heads/}"
  fi
  if [ -z "$BRANCH" ]; then
    BRANCH=$(git -C "$CWD" rev-parse --abbrev-ref HEAD 2>/dev/null) || BRANCH=""
  fi
  [ -n "$BRANCH" ] && [ "$BRANCH" != "HEAD" ] || continue

  # Open PR? Unreadable answer fails OPEN — see header.
  PRS=$(gh pr list --head "$BRANCH" --state open --json number --jq 'length' 2>/dev/null) || continue
  [[ "$PRS" =~ ^[0-9]+$ ]] || continue
  [ "$PRS" -gt 0 ] || continue

  printf 'Force-pushing a branch with an open PR goes through the lease script:\n  bash %q --branch %q --expect <sha>\nIt pins the expected remote head, so a peer that moved the branch is a typed refusal instead of a silent clobber (GH-1917).\n' \
    "$PUSH_SCRIPT" "$BRANCH" >&2
  exit 2
done <<< "$SEGMENTS"
exit 0
