#!/usr/bin/env bash
# cmdscan — the one quote-aware reader the courtesy funnels share (GH-2058).
#
# Every funnel asks the same question before it matches anything: which bytes
# of this command are actually being RUN, and where does one command end and
# the next begin? Each rail answered it for itself, with a `sed` pipeline that
# reads a line at a time — and `sed` is the wrong engine for the question,
# because a quoted span in a real command routinely spans newlines. Every
# `gh issue create --body "..."` with a paragraph break is one.
#
# GH-2057 found that in funnel-merge.sh: the opening and closing quotes of a
# multi-line `--body` landed on different lines, so `s/"[^"]*"//g` matched
# nothing, the span survived stripping, and a `gh pr merge` merely QUOTED
# inside it was refused as though it were being run. The rail refused the very
# issue that documented it. It was fixed there and nowhere else, so the three
# siblings kept the defect — which is the shape GH-1843 already named: rules
# living in N places, held together by a comment asking them to stay in sync.
# This file is the mechanism instead of the convention.
#
# Two surfaces over one walk:
#   cs_segments TEXT     — the command split on UNQUOTED separators
#   cs_strip_quotes TEXT — the command with quoted spans removed
#
# The POLICY stays in each rail, because it genuinely differs: funnel-board
# exempts a `gh api` segment from stripping (its GraphQL mutation lives INSIDE
# the quotes), funnel-gate-watch preserves a double-quoted span that contains a
# command substitution (`until [ -z "$(gh pr checks N)" ]` is exactly the loop
# it exists for). Only the reading of shell quoting is shared.
#
# What is deliberately NOT stripped: backticks outside quotes. They are command
# substitution, so what is inside them really does run, and stripping them would
# open the hole these rails exist to close.
#
# Failure direction: stripping and comment-skipping can only ever REMOVE bytes
# from what gets matched, so a bug here under-redirects. That is the safe
# direction for a courtesy rail — CLAUDE.md counts none of these as enforcement,
# and the cost of a wrong refusal (a session that cannot push its own work) is
# far higher than the cost of a missed nudge.

# Segment delimiter. Emitted after EVERY segment including the last, so a
# `read -r -d` loop does not silently drop the final one at EOF.
CS_SEP=$'\x01'

# The shared quote walk, as one awk program. Both entry points below select a
# MODE; everything about recognising a quoted span is written once.
#
# The whole input is accumulated into a single buffer before the walk, which is
# the entire point: the scan must see a quoted span that spans newlines as one
# span. Reading stdin line-by-line and re-joining is portable in a way that
# setting RS to a sentinel byte is not — it assumes nothing about which bytes a
# command cannot contain.
_CS_AWK='
function close_quote(s, i, q,   k, n, ch) {
  # Index of the quote closing the one at position i, or the end of the buffer
  # when it is never closed. An unterminated quote swallows the rest, which
  # under-redirects — the safe direction, and such a command is a syntax error
  # that would not have run anyway.
  n = length(s); k = i + 1
  while (k <= n) {
    ch = substr(s, k, 1)
    # Inside single quotes a backslash is literal (POSIX); inside double quotes
    # it escapes, so \" does not end the span.
    if (q == "\"" && ch == "\\") { k += 2; continue }
    if (ch == q) { return k }
    k++
  }
  return n
}
{ buf = buf $0 "\n" }
END {
  n = length(buf); i = 1; atword = 1
  while (i <= n) {
    c = substr(buf, i, 1)

    # A backslash escapes the next character, so neither can open a quote,
    # end one, or act as a separator. Both bytes pass through untouched.
    if (c == "\\") {
      if (MODE == "seg" || MODE == "strip") printf "%s", substr(buf, i, 2)
      i += 2; atword = 0; continue
    }

    if (c == "'"'"'" || c == "\"") {
      e = close_quote(buf, i, c)
      span = substr(buf, i, e - i + 1)
      if (MODE == "seg") {
        # The segmenter keeps quoted text verbatim: a separator inside it is
        # not a separator, and the caller decides what to do with the content.
        printf "%s", span
      } else if (c == "\"" && KEEP_SUBST == "1" && (index(span, "$(") > 0 || index(span, "`") > 0)) {
        # A double-quoted span carrying a command substitution is execution,
        # not an argument. Single quotes suppress substitution entirely, so
        # they are always dropped.
        printf "%s", span
      }
      i = e + 1; atword = 0; continue
    }

    # `#` opens a comment only at the start of a word, and only to end of line
    # — shell semantics. `curl http://x#frag` is not a comment, and a comment
    # on line 1 does not silence line 2.
    if (c == "#" && atword) {
      while (i <= n && substr(buf, i, 1) != "\n") { i++ }
      continue
    }

    if (MODE == "seg" && (c == ";" || c == "&" || c == "|" || c == "\n")) {
      printf "%s", SEP; i++; atword = 1; continue
    }

    printf "%s", c
    atword = (c == " " || c == "\t" || c == "\n" || c == "(") ? 1 : 0
    i++
  }
  if (MODE == "seg") { printf "%s", SEP }
}
'

# cs_segments TEXT
# Prints TEXT split on UNQUOTED `;`, `&`, `|` and newlines, each segment
# followed by CS_SEP. Quoted spans are preserved verbatim and never split.
# Read them back with:  while IFS= read -r -d "$CS_SEP" seg; do ...; done
cs_segments() {
  printf '%s' "$1" | awk -v MODE=seg -v SEP="$CS_SEP" -v KEEP_SUBST=0 "$_CS_AWK"
}

# cs_strip_quotes TEXT [keep_subst]
# Prints TEXT with quoted spans removed — what is quoted is an argument, not a
# command being run. With keep_subst=1 a double-quoted span containing `$(` or
# a backtick is preserved, because that is execution rather than an argument.
cs_strip_quotes() {
  printf '%s' "$1" | awk -v MODE=strip -v SEP="$CS_SEP" -v KEEP_SUBST="${2:-0}" "$_CS_AWK"
}

# cs_command_word SEGMENT
# Prints the segment's COMMAND WORD — the first token after leading
# whitespace, subshell parens and VAR=value assignment prefixes, with any
# wrapping quote characters removed. Empty output means no command word was
# found.
#
# What a pattern means depends on where it sits: `deleteProjectV2Item` as an
# argument to grep/rg/sed/awk/python is data being read or edited, while the
# same bytes after `gh api graphql -f query=` are a mutation being RUN. The
# rails use this to count a pattern only in segments whose command word can
# actually reach the API it names — text in any other command's arguments is
# never a mutation. A wrapper the reader does not see through (`env`, `xargs`,
# `bash -c`) reads as the wrapper's own name, which UNDER-redirects — the
# library's stated failure direction.
cs_command_word() {
  local tok rest
  # A segment holds no unquoted newline (cs_segments splits on those), so the
  # command word sits on the first line; anything past a quoted multi-line
  # span is arguments.
  rest="${1%%$'\n'*}"
  while [ -n "$rest" ]; do
    tok=""
    read -r tok rest <<<"$rest" || break
    [ -n "$tok" ] || break
    # Wrapping quotes and a subshell's `(` do not change what runs.
    while :; do
      case "$tok" in
        \(* | \'* | \"*) tok="${tok#?}" ;;
        *) break ;;
      esac
    done
    while :; do
      case "$tok" in
        *\' | *\") tok="${tok%?}" ;;
        *) break ;;
      esac
    done
    [ -n "$tok" ] || continue
    case "$tok" in
      # A VAR=value prefix is environment, not the command.
      [A-Za-z_]*=*) continue ;;
      *)
        printf '%s\n' "$tok"
        return 0
        ;;
    esac
  done
  return 0
}
