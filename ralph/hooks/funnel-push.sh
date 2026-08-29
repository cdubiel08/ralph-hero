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
#     because `gh` was rate-limited — but it names the blindness on stderr, so
#     that a push the rail could not evaluate does not read like one it cleared
#     (GH-2263). A measured "no open PR" stays silent.
#   * only when the plugin actually ships deliver-push.sh — a redirect must
#     name a path the session can run.
#
# Quoted vs run (the defect this issue filed against the funnels themselves):
# a command that merely QUOTES `git push --force` as an argument — filing an
# issue about this rail, writing a doc, grepping for it — is not running it.
# Segments are derived on UNQUOTED separators and each has its quoted spans
# stripped before matching, both reading the whole command rather than a line
# at a time (GH-2058), so this funnel does not refuse documentation about
# itself — including the multi-line kind, which is all of it.
set -euo pipefail

# The quote-aware command reader every funnel shares (GH-2058). A courtesy rail
# that cannot read its own library must fail OPEN — never block a command
# because a file is missing (the direction hooks.json's CLAUDE_PLUGIN_ROOT
# guard already takes, GH-2045). Resolved beside THIS script rather than from
# CLAUDE_PLUGIN_ROOT: the library is an implementation detail of this file, so
# the copy that ships with it is the one that must be read.
CS_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)/lib/cmdscan.sh"
[ -r "$CS_LIB" ] || exit 0
# shellcheck source=lib/cmdscan.sh
. "$CS_LIB" || exit 0

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
PUSH_SCRIPT="$PLUGIN_ROOT/scripts/deliver-push.sh"
[ -f "$PUSH_SCRIPT" ] || exit 0

INPUT=$(cat)
CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null) || exit 0
[ -n "$CMD" ] || exit 0
case "$CMD" in *"git push"*) ;; *) exit 0 ;; esac

CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null) || CWD=""
CWD="${CWD:-$PWD}"

# Split on UNQUOTED shell separators and strip each segment's quoted spans —
# what is quoted is an ARGUMENT, not a command being run. Both halves read the
# whole command at once (GH-2058, shared with the sibling funnels in
# hooks/lib/cmdscan.sh), which is what the previous line-at-a-time version
# could not do: a multi-line `--body` was split at every newline and separator
# inside it and its bounding quotes then sat in different segments, so nothing
# was stripped and a doc quoting `git push --force` drew a refusal. That is the
# expensive direction here — the cost of a wrong redirect is a session that
# cannot push its own work.
while IFS= read -r -d "$CS_SEP" raw_seg; do
  seg=$(cs_strip_quotes "$raw_seg")
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

  # Open PR? Unreadable answer fails OPEN — see header. It also SPEAKS, which
  # the two facts below are why (GH-2263): by this point the hazard is already
  # established — a force push, in one of the three grammars, on a named branch
  # — so the only thing left is the fact the rail could not read. Blind silence
  # and measured silence rendered identically, and the operator issued the
  # destructive push believing the lease rail had looked. Exit stays 0: this is
  # a courtesy rail, and a transient outage may not strand a session's own push.
  if ! PRS=$(gh pr list --head "$BRANCH" --state open --json number --jq 'length' 2>/dev/null); then
    printf 'funnel-push: could not read open PRs for %s (gh unavailable); the GH-1917 lease rail did NOT evaluate this push.\n' \
      "$BRANCH" >&2
    continue
  fi
  if [[ ! "$PRS" =~ ^[0-9]+$ ]]; then
    printf 'funnel-push: unparseable open-PR count for %s (gh returned %q); the GH-1917 lease rail did NOT evaluate this push.\n' \
      "$BRANCH" "$PRS" >&2
    continue
  fi
  # A measured zero stays SILENT. The rail evaluated and had nothing to say, and
  # a line on every ordinary force push is how the two above stop being read.
  [ "$PRS" -gt 0 ] || continue

  printf 'Force-pushing a branch with an open PR goes through the lease script:\n  bash %q --branch %q --expect <sha>\nIt pins the expected remote head, so a peer that moved the branch is a typed refusal instead of a silent clobber (GH-1917).\n' \
    "$PUSH_SCRIPT" "$BRANCH" >&2
  exit 2
done < <(cs_segments "$CMD")
exit 0
