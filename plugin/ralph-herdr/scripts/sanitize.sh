#!/usr/bin/env bash
# sanitize.sh — terminal-derived values are untrusted display data. Sourced,
# never run.
#
# Everything herdr reports about an agent originates in a terminal another
# process controls: names, titles, statuses, foreground commands, pane tails,
# and the prose inside error envelopes. Rendering that straight into a log line
# or a TUI cell hands the remote end our cursor — it can repaint the herd list,
# hide a blocked worker, retitle a window, or forge a whole prompt.
#
# So every value crossing from herdr into human-readable output goes through
# ralph_sanitize first. Structured fields (ids, statuses we compare, the JSON
# we parse) keep their raw form for logic; only the rendered copy is scrubbed.
#
# What gets removed, and why each is separate:
#   CSI/SGR   ESC [ … final       colors, cursor moves, erase-in-display
#   OSC       ESC ] … BEL|ESC \   window/tab titles, hyperlinks, clipboard
#   DCS/APC/PM/SOS  ESC P|_|^|X … ESC \    device strings, kitty/tmux passthrough
#   two-char  ESC <single char>   charset selects, RIS (ESC c) full reset
#   C0        0x00-0x1f minus \t  BEL, backspace-overstrike, and the newline
#                                 that would forge a second log line
#   C1        ESC-encoded + UTF-8 U+0080-U+009F forms of the above
#
# Tabs survive: they carry column meaning in the table output and cannot move
# the cursor backward. Newlines do NOT — a display value is one line by
# definition, and \n is the injection that splits one field into two rows.

# ralph_sanitize [STRING...] — print the arguments (or stdin when none are
# given) with terminal control sequences removed. Always rc 0: sanitizing is
# a rendering step, and a value that scrubs to empty is still a valid value.
#
# Implemented with a single perl pass because the escape grammar needs
# alternation and non-greedy spans that sed's BRE cannot express portably
# across GNU and BSD. Perl is already a hard dependency of the herdr install
# path; when it is somehow absent, fall back to tr, which cannot recognize the
# multi-byte sequences but still strips the C0/C1 bytes that make them
# dangerous — a legible degradation, not a silent pass-through.
ralph_sanitize() {
  if [ "$#" -gt 0 ]; then
    printf '%s' "$*" | ralph_sanitize
    return 0
  fi
  if command -v perl >/dev/null 2>&1; then
    perl -pe '
      s/\e\][^\a\e]*(?:\a|\e\\)//g;         # OSC, terminated by BEL or ST
      s/\e[P_^X][^\e]*(?:\e\\)?//g;         # DCS / APC / PM / SOS
      s/\e\[[0-9;:<=>?]*[ -\/]*[@-~]//g;    # CSI (SGR, cursor, erase)
      s/\xc2\x9b[0-9;:<=>?]*[ -\/]*[@-~]//g; # the same CSI via UTF-8 8-bit U+009B
      s/\e[^\[\]P_^X]//g;                   # any other two-char escape: ESC c
                                            # (full reset), ESC 7/8, charset
                                            # selects. Defined by exclusion so a
                                            # sequence nobody enumerated still
                                            # loses its introducer.
      s/[\x00-\x08\x0a-\x1f\x7f]//g;        # C0 minus tab, plus DEL
      s/\xc2[\x80-\x9f]//g;                 # UTF-8-encoded C1
    '
  else
    tr -d '\000-\010\012-\037\177'
  fi
}

# ralph_sanitize_field JSON FILTER — read one value out of a JSON document with
# jq and print it sanitized. The convenience wrapper for the common shape
# "pull a display string off a herdr response and show it", so no call site has
# to remember to pipe. A filter that yields null or nothing prints nothing.
ralph_sanitize_field() {
  local json="$1" filter="$2"
  printf '%s' "$json" | jq -r "$filter // empty" 2>/dev/null | ralph_sanitize
}
