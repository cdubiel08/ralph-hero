#!/usr/bin/env bash
# cockpit-fzf.sh — rung 3 of the cockpit ladder: the verb-complete fzf
# fallback. Every verb the Go TUI offers exists here over the SAME CLIs
# (board / herdr / gh); what this rung loses is chrome — side-by-side
# columns, live glyph refresh, mouse — never a verb.
#
# Board state is authoritative: a card's column comes ONLY from the item's
# own Workflow State in ONE `board list --json` read, partitioned here into
# the three cockpit columns (In Progress / In Review / Human Needed, board
# states verbatim). The herdr agent state is a decoration overlay joined by
# parsing agent names (grammar-B w<N>-*, legacy gh-N): a failed herdr read
# costs the glyph, never the list.
#
# Loop: read the board once (stdout-only into the parse, fail-closed on
# unparseable — the ralph-answer.sh precedent) → one fzf pick with an
# agent-tail / latest-comment preview → a second fzf menu of verbs
# (observe / peek / reply / answer / spawn / diff / browser / quit) → back
# to a fresh read. No poll timer: RALPH_COCKPIT_INTERVAL is the Go TUI's
# knob; this rung refreshes on every interaction instead.
#
# Secret gate note: pane tails render INTO the terminal only (peek + the
# preview) — allowed. The SECRET_RE gate guards notification channels
# (attend.sh), and nothing here sends a notification.
#
# Knobs:
#   RALPH_HERDR_PEEK_LINES   pane-tail / comment-tail lines for peek and
#                            the preview (default 40)
set -euo pipefail

# ── Preview mode ─────────────────────────────────────────────────────────────
# fzf renders each highlighted card through `bash <this file> __preview {}`:
# the live agent's pane tail when the card has one, else the issue's latest
# comments. Handled BEFORE lib.sh loads — the preview needs no board CLI,
# and a per-cursor-move subshell should not pay board discovery. Guarded end
# to end: a failed read is said, never fatal (the preview is chrome).
if [ "${1:-}" = "__preview" ]; then
  pv_line="${2:-}"
  pv_n=$(printf '%s' "$pv_line" | cut -f2 | tr -d '#[:space:]')
  pv_agent=$(printf '%s' "$pv_line" | cut -f4 | tr -d '[:space:]')
  pv_lines="${RALPH_HERDR_PEEK_LINES:-40}"
  pv_herdr="${HERDR_BIN_PATH:-herdr}"
  if [ -n "$pv_agent" ]; then
    echo "── $pv_agent — pane tail ──"
    "$pv_herdr" agent read "$pv_agent" --source recent-unwrapped --lines "$pv_lines" 2>/dev/null ||
      echo "(agent read failed — herdr down or agent gone; the card itself is board truth)"
  elif [ -n "$pv_n" ] && command -v gh >/dev/null 2>&1; then
    echo "── #$pv_n — latest comments (tail) ──"
    gh issue view "$pv_n" --comments 2>/dev/null | tail -n "$pv_lines" ||
      echo "(gh read failed — open the issue in a browser)"
  else
    echo "(no live agent, and gh is not installed — no preview)"
  fi
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

PEEK_LINES="${RALPH_HERDR_PEEK_LINES:-40}"
validate_pos_int RALPH_HERDR_PEEK_LINES "$PEEK_LINES"
# The preview subshell reads the knob from the environment.
export RALPH_HERDR_PEEK_LINES="$PEEK_LINES"

NL=$'\n'
SELF="$SCRIPT_DIR/cockpit-fzf.sh"

hold() {
  printf '\n(Enter to continue) '
  read -r _ || true
}

# read_board — ONE `board list --json` covering all three cockpit columns
# (GH-1786). `--state` never saved a request: board.ts walks the whole board
# and filters in-process, and its cache is per-process, so three --state reads
# were three identical full walks — ~3x the GraphQL points and ~3x the wall
# time for one refresh. The partition is jq's, over a single payload.
#
# stdout-only into the parse (the board shim's stderr can carry harmless noise
# on a SUCCESSFUL read: npx cold-cache chatter, node ExperimentalWarning
# lines), FAIL-CLOSED: a 0-exit with unparseable stdout is a failed read, never
# an empty board — an empty column and a failed query are different facts.
# Prints one TSV row per card: STATE \t #N \t TITLE (agent decoration joined
# later), the three columns in the LOCKED order and board order within each;
# rc 1 on any failure, with the diagnostics on stderr. Items in any other state
# are not cockpit cards and are dropped. STATE is emitted from the locked list,
# not from the payload, so a board CLI returning odd rows still cannot
# mis-column a card — the same guarantee the per-state read gave.
read_board() {
  local err json
  err=$(mktemp "${TMPDIR:-/tmp}/ralph-cockpit-err.XXXXXX")
  if ! json=$("$BOARD" list --json 2>"$err"); then
    echo "board list --json failed:" >&2
    head -5 "$err" >&2
    rm -f "$err"
    return 1
  fi
  rm -f "$err"
  jq -r '
    .items as $items
    | ("In Progress", "In Review", "Human Needed") as $s
    | $items[]
    | select(.state == $s)
    | [$s, "#\(.number)", .title]
    | @tsv
  ' <<<"$json" 2>/dev/null || {
    echo "board list --json printed unparseable JSON — refusing to render it as an empty board" >&2
    return 1
  }
}

# decorate OVERLAY — stdin: STATE\t#N\tTITLE rows; stdout: the same rows as
# STATE \t #N \t TITLE [<marker> <agent>] \t AGENT (4th field machine-read by
# the preview and the verb menu, hidden from the fzf list via --with-nth).
# OVERLAY is "name<TAB>status" lines from the live agent list; the ASCII
# markers are state_glyph's documented no-color vocabulary (> working,
# ! blocked, . idle/done, ? other) — plain ASCII on purpose, so the rows
# stay parseable by cut and never carry ANSI into fzf.
decorate() {
  local overlay="$1" state num title n agent status marker a_name a_status
  while IFS=$'\t' read -r state num title; do
    [ -n "$num" ] || continue
    n="${num#\#}"
    agent="" status=""
    if [ -n "$overlay" ]; then
      while IFS=$'\t' read -r a_name a_status; do
        [ -n "$a_name" ] || continue
        case "$a_name" in
          "gh-$n" | "w$n-"*)
            agent="$a_name" status="$a_status"
            break
            ;;
        esac
      done <<<"$overlay"
    fi
    if [ -n "$agent" ]; then
      case "$status" in
        working) marker='>' ;;
        blocked) marker='!' ;;
        idle | done) marker='.' ;;
        *) marker='?' ;;
      esac
      printf '%s\t%s\t%s [%s %s]\t%s\n' "$state" "$num" "$title" "$marker" "$agent" "$agent"
    else
      printf '%s\t%s\t%s\t\n' "$state" "$num" "$title"
    fi
  done
}

# cockpit_cards OVERLAY — the three cockpit columns flattened, in the locked
# order, decorated with OVERLAY. rc 1 (diagnostics already on stderr from
# read_board) on a failed/unparseable read — never a silently thinner board.
# Prints nothing (rc 0) on a genuinely calm board.
cockpit_cards() {
  local overlay="$1" cards
  cards=$(read_board) || return 1
  [ -n "$cards" ] || return 0
  decorate "$overlay" <<<"$cards"
}

# run_verb VERB N AGENT — dispatch one picked verb for card #N (AGENT = the
# joined live agent name, empty when none). Interactive input (reply/answer
# text) comes from stdin; rc 0 always except `quit`, which exits the script.
run_verb() {
  local verb="$1" n="$2" agent="$3" text ans pr diff_out rc out code
  case "$verb" in
    observe)
      if [ -z "$agent" ]; then
        echo "no live session for #$n — nothing to observe (the spawn verb starts one)"
        hold
        return 0
      fi
      "$HERDR" agent focus "$agent" >/dev/null || {
        echo "agent focus $agent failed — herdr down or agent gone"
        hold
      }
      ;;

    peek)
      if [ -z "$agent" ]; then
        echo "no live session for #$n — showing the issue's latest comments instead"
        if command -v gh >/dev/null 2>&1; then
          gh issue view "$n" --comments 2>/dev/null | tail -n "$PEEK_LINES" ||
            echo "(gh read failed — open the issue in a browser)"
        else
          echo "(gh not installed — open the issue in a browser)"
        fi
      else
        echo "── $agent — pane tail (last $PEEK_LINES lines) ──"
        "$HERDR" agent read "$agent" --source recent-unwrapped --lines "$PEEK_LINES" ||
          echo "(agent read failed — herdr down or agent gone)"
      fi
      hold
      ;;

    reply)
      if [ -z "$agent" ]; then
        echo "no live session for #$n — nothing to reply to (answer posts to the issue instead)"
        hold
        return 0
      fi
      printf 'reply to %s (one line; empty aborts): ' "$agent"
      IFS= read -r text || text=""
      if [ -z "$(printf '%s' "$text" | tr -d '[:space:]')" ]; then
        echo "empty — nothing sent"
        hold
        return 0
      fi
      # The checkmark ONLY after herdr CONFIRMS delivery: a bare
      # `agent prompt` merely SUBMITS — rc 0 without --wait is an optimistic
      # ack. --wait requires an observed state change (the ralph-answer.sh
      # precedent; 15000ms matches the Go TUI's promptWaitMS). On failure the
      # typed text is preserved on screen, and wait expiry reports "sent but
      # not confirmed", never "delivered".
      rc=0
      out=$("$HERDR" agent prompt "$agent" "$text" \
        --wait --timeout 15000 2>&1) || rc=$?
      if [ "$rc" -eq 0 ]; then
        echo "✓ delivered to $agent"
      else
        code=$(jq -r '.error.code // empty' <<<"$out" 2>/dev/null) || code=""
        if [ -n "$code" ]; then
          echo "NOT delivered — herdr refused ($code). Your text, kept:"
        else
          echo "NOT delivered — sent but not confirmed within 15000ms (check the pane). Your text, kept:"
        fi
        printf '  %s\n' "$text"
        echo "retry by hand: $HERDR agent prompt $agent '<text>' --wait"
      fi
      hold
      ;;

    answer)
      # COMMENT-FIRST (ralph-answer.sh, condensed): `board answer N -m`
      # posts the **Answer** issue comment BEFORE the Human Needed →
      # In Progress move — board.ts owns that ordering, this verb only
      # drives it. A non-Human-Needed card is the board CLI's to refuse.
      printf 'answer for #%s — one line, posts as the **Answer** comment (empty aborts): ' "$n"
      IFS= read -r ans || ans=""
      if [ -z "$(printf '%s' "$ans" | tr -d '[:space:]')" ]; then
        echo "empty — nothing posted"
        hold
        return 0
      fi
      if ! "$BOARD" answer "$n" -m "$ans"; then
        echo "board answer failed — if the **Answer** comment posted (the durable half),"
        echo "retry the MOVE (board claim $n), not the answer; re-answering would duplicate it."
        hold
        return 0
      fi
      # Decorative half: nudge the paused session, honestly. --wait so rc 0
      # means CONFIRMED delivered (bare prompt only submits) — ralph-answer.sh
      # parity, same knob; expiry reports "not confirmed", never "delivered".
      if [ -n "$agent" ]; then
        if "$HERDR" agent prompt "$agent" "answered on issue — re-read #$n and resume" \
          --wait --timeout "${RALPH_HERDR_ANSWER_NUDGE_MS:-15000}"; then
          echo "✓ answered and nudged $agent"
        else
          echo "answered — but the nudge was NOT confirmed delivered; by hand:"
          echo "  $HERDR agent prompt $agent 'answered on issue — re-read #$n and resume'"
        fi
      else
        echo "answered — no live session for #$n: it is now In Progress under your claim;"
        echo "spawn a session for it (the spawn verb) or requeue it with: board move $n Backlog"
      fi
      hold
      ;;

    spawn)
      # Same sanctioned path as work-next: billing guard (in a subshell —
      # its exit must not kill the loop), then spawn_work_session. rc 2 is
      # the already-live skip and prints its own SKIP line.
      if ! (billing_guard); then
        hold
        return 0
      fi
      rc=0
      spawn_work_session "$n" || rc=$?
      [ "$rc" -ne 0 ] && [ "$rc" -ne 2 ] && echo "spawn failed (rc $rc) — see above"
      hold
      ;;

    diff)
      # The TUI opens this in a herdr popup pane; this rung pages inline —
      # same verb, less chrome. PR discovery goes through the board's own
      # read (`board get N --json` carries the linked PRs), preferring the
      # open one.
      if ! command -v gh >/dev/null 2>&1; then
        echo "gh not installed — no diff"
        hold
        return 0
      fi
      pr=$("$BOARD" get "$n" --json 2>/dev/null |
        jq -r '(.prs // []) | (map(select(.state == "OPEN")) + .) | (.[0].number // empty)' 2>/dev/null) || pr=""
      if [ -z "$pr" ]; then
        echo "no PR linked on #$n (board get)"
        hold
        return 0
      fi
      # Fetched before paging: quitting less mid-stream would SIGPIPE gh and
      # turn an honest read into a false "failed".
      if ! diff_out=$(gh pr diff "$pr" --color always 2>&1); then
        echo "gh pr diff $pr failed:"
        printf '%s\n' "$diff_out" | head -5
        hold
        return 0
      fi
      if [ -t 1 ] && command -v less >/dev/null 2>&1; then
        printf '%s\n' "$diff_out" | less -R || true
      else
        printf '%s\n' "$diff_out"
        hold
      fi
      ;;

    browser)
      if ! command -v gh >/dev/null 2>&1; then
        echo "gh not installed — open github.com/<owner>/<repo>/issues/$n yourself"
        hold
        return 0
      fi
      gh issue view "$n" --web >/dev/null 2>&1 || {
        echo "gh issue view $n --web failed — open the issue yourself"
        hold
      }
      ;;

    quit)
      exit 0
      ;;
  esac
  return 0
}

# ── Sourced mode ends here ───────────────────────────────────────────────────
# cockpit.test.sh sources this file for the pure functions above (read_board,
# decorate, cockpit_cards, run_verb) — the fleet.test.sh pattern. The fzf
# requirement and the UI loop below belong to the executed script only: a
# test host without fzf still tests every verb.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  return 0
fi

command -v fzf >/dev/null 2>&1 ||
  die "fzf not on PATH — use scripts/dashboard.sh (rung 4) or the board CLI standalone (rung 5)"

# Ctrl-C is the sanctioned way to close the pane — exit clean.
trap 'exit 0' INT

while :; do
  # Decoration overlay first: name<TAB>status per live ralph agent. A failed
  # herdr read (or no herdr at all) empties the overlay and the loop keeps
  # going — the glyph is chrome, the columns are the verb surface.
  overlay=$(ralph_agents_json 2>/dev/null | jq -r '[.name, .status] | @tsv' 2>/dev/null) || overlay=""

  # The three cockpit columns, in the locked order. Any failed/unparseable
  # read aborts the render — never a silently thinner board.
  cards=$(cockpit_cards "$overlay") || {
    hold
    exit 1
  }

  if [ -z "$cards" ]; then
    printf 'board calm — nothing In Progress / In Review / Human Needed\n(Enter to re-read, q to quit): '
    read -r k || k="q"
    case "$k" in q | Q) exit 0 ;; esac
    continue
  fi

  picked=$(printf '%s\n' "$cards" | fzf \
    --prompt 'ralph cockpit> ' \
    --header 'Enter: verbs for the card · Esc: quit · list re-reads the board after every verb' \
    --delimiter '\t' --with-nth 1,2,3 --no-sort \
    --preview "bash \"$SELF\" __preview {}" \
    --preview-window 'right,55%,wrap') || exit 0

  state=$(printf '%s\n' "$picked" | cut -f1)
  n=$(printf '%s\n' "$picked" | cut -f2 | tr -d '#')
  agent=$(printf '%s\n' "$picked" | cut -f4)
  case "$n" in '' | *[!0-9]*) continue ;; esac

  verb=$(printf '%s\n' \
    "observe   focus the live session's pane (herdr agent focus)" \
    "peek      read the session's pane tail — no focus steal" \
    "reply     type a line into the session (herdr agent prompt)" \
    "answer    Human Needed exit, comment-first (board answer, then nudge)" \
    "spawn     spawn a /ralph:work session for this card" \
    "diff      the card's PR diff (gh pr diff)" \
    "browser   open the issue on GitHub" \
    "quit      leave the cockpit" |
    fzf --prompt "#$n ${agent:+[$agent] }> " \
      --header "$state — Esc: back to the board" --no-sort) || continue
  verb="${verb%% *}"

  run_verb "$verb" "$n" "$agent"
done
