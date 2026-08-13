#!/usr/bin/env bash
# transport.sh — the strict Herdr protocol-19 boundary. Sourced, never run.
#
# Every Ralph-to-Herdr call goes through ralph_herdr_call. Nothing else in this
# plugin may invoke $HERDR for a response it intends to parse.
#
# The rule this file exists to enforce: a zero exit is not evidence of success.
# Herdr speaks a correlated, discriminated NDJSON protocol — requests carry an
# `id`, successes echo that `id` and a `result.type`, failures echo the `id`
# with `error.code`/`error.message`. A response can therefore exit 0 and still
# be an error envelope, a reply to a different request, the wrong result type,
# a success missing the array we were about to iterate, or trailing garbage
# after a valid object. Each of those is a transport failure.
#
# The adapter NEVER converts any of them into `[]`, `{}`, `done`, or `exited`.
# A caller that can proceed without the answer must say so explicitly by
# checking the return code and choosing its own unavailable branch; a caller
# that mutates state must fail closed. Turning an unparseable response into an
# empty herd is exactly how a transport fault becomes "no agents are running,
# safe to clean up".
#
# Return codes (distinguishable so callers can degrade precisely):
#   0  validated — the result object is on stdout
#   1  transport failure — malformed, uncorrelated, wrong type, missing fields
#   2  herdr refused — a well-formed error envelope; the code is in
#      $RALPH_HERDR_ERR_CODE, the message in $RALPH_HERDR_ERR_MESSAGE
#   3  herdr unreachable — binary missing, server down, or the call timed out
#
# Which pipe carries which: successes come back on stdout, refusals on stderr
# (probed against the installed 0.8.x binary — see the capture below). Both are
# protocol; only the SUCCESS channel is a parsing surface, because stderr also
# carries ordinary diagnostics on calls that worked. So stderr is read for an
# envelope only when stdout is empty and the exit was nonzero, and only when
# the body is a complete protocol-19 error. Getting this wrong in the safe
# direction is what GH-1832 was: stderr discarded, so every refusal in the
# plugin — the linked-worktree cwd error, and the agent_pane_busy race the
# retry logic depends on — reported as "server unreachable".
#
# Knobs:
#   HERDR_BIN_PATH             herdr binary (default: `herdr` on PATH)
#   RALPH_HERDR_TIMEOUT_SEC    per-call wall clock bound (default 30)
#   RALPH_HERDR_MIN_PROTOCOL   minimum accepted protocol (default 19)

# The result types this plugin consumes, each mapped to the fields it must
# carry before any caller is allowed to read it. Taken from the installed
# `herdr api schema --json` (protocol 19 / schema version 1) — the executable
# compatibility boundary, not the prose docs.
#
# Validation is required-fields-only and deliberately additive-tolerant:
# unknown keys are ignored so a future Herdr can add fields without breaking
# this plugin, but a MISSING required field is fatal because every caller
# downstream assumes it. bash 3.2 has no associative arrays; a case statement
# is the portable table.
_ralph_required_fields() {
  case "$1" in
    agent_list)        echo "agents" ;;
    agent_info)        echo "agent" ;;
    agent_started)     echo "agent argv" ;;
    agent_prompted)    echo "agent" ;;
    session_snapshot)  echo "snapshot" ;;
    workspace_created) echo "workspace tab root_pane" ;;
    worktree_created)  echo "workspace tab root_pane worktree" ;;
    worktree_opened)   echo "workspace tab root_pane worktree already_open" ;;
    worktree_list)     echo "source worktrees" ;;
    tab_created)       echo "tab root_pane" ;;
    pane_info)         echo "pane" ;;
    pane_read)         echo "read" ;;
    plugin_pane_opened) echo "plugin_pane" ;;
    notification_show) echo "shown reason" ;;

    ok)                echo "" ;;
    *)                 return 1 ;;
  esac
}

# The fields whose absence would leave a JSON array reader silently iterating
# nothing. Distinguished from the scalar requireds above because "present but
# not an array" is its own corruption — a caller doing `.agents[]` against an
# object or a string gets zero iterations and reads it as an empty herd.
_ralph_array_fields() {
  case "$1" in
    agent_list) echo "agents" ;;
    *) echo "" ;;
  esac
}

RALPH_HERDR_ERR_CODE=""
RALPH_HERDR_ERR_MESSAGE=""

# _ralph_herdr_refusal BODY OP — consume a protocol-19 error envelope.
#
# Shared by both channels because herdr does not use one: successes arrive on
# stdout, refusals on stderr (probed on 0.8.x — `worktree create` from a linked
# worktree and `agent start` at a bogus pane both answer there, exit 1, with
# stdout empty). The envelope means the same thing whichever pipe carried it,
# so the validation must not be written twice and allowed to drift.
#
# rc 2 with the code on stdout, or rc 1 when the body is not shaped like a
# refusal. See the call sites for why the code also travels on stdout.
_ralph_herdr_refusal() {
  local body="$1" op="$2" errc errm

  # A refusal is only a refusal if it is SHAPED like one. Protocol 19 requires
  # a correlated id plus a non-empty string code and message; anything less is
  # a malformed response wearing an error's clothes, and letting it through as
  # rc 2 would hand callers an empty code to branch on. Fail it as rc 1 —
  # which is also the honest answer, since we cannot tell what the server did.
  if ! printf '%s' "$body" | jq -e '
    (.id | type == "string" and length > 0)
    and (.error.code | type == "string" and length > 0)
    and (.error.message | type == "string")' >/dev/null 2>&1; then
    echo "ralph_herdr_call: $op returned a malformed error envelope (needs id + error.code + error.message)" >&2
    return 1
  fi
  if [ -n "${RALPH_HERDR_EXPECT_ID:-}" ] &&
    [ "$(printf '%s' "$body" | jq -r '.id')" != "$RALPH_HERDR_EXPECT_ID" ]; then
    echo "ralph_herdr_call: $op returned an error correlated to a different request" >&2
    return 1
  fi
  errc=$(printf '%s' "$body" | jq -r '.error.code // "unknown"')
  errm=$(printf '%s' "$body" | jq -r '.error.message // ""')
  errc=$(printf '%s' "$errc" | ralph_sanitize)
  errm=$(printf '%s' "$errm" | ralph_sanitize)
  RALPH_HERDR_ERR_CODE="$errc"
  RALPH_HERDR_ERR_MESSAGE="$errm"
  # ALSO on stdout, because the globals do not survive the call shape every
  # caller actually uses: `out=$(ralph_herdr_call …) || rc=$?` runs the
  # function in a subshell, and a variable set there dies with it. A caller
  # that branches on the error code — the agent_pane_busy retry is the whole
  # reason the code is preserved at all — would silently read an empty
  # string and treat a retryable race as a hard failure.
  #
  # rc 2 means there is no result, so stdout is free and unambiguous: a
  # caller either got rc 0 and a result, or rc 2 and this.
  #
  # ralph_herdr_err_code reads it back.
  # jq -n --arg, NOT a printf of `jq -R .` outputs: `jq -R .` emits NOTHING
  # for empty input, so an error whose message is empty (the `// ""` default
  # above, or one that sanitizes to empty) produced
  # `{"error":{"code":"unknown","message":}}` — invalid JSON, which makes
  # every downstream error-code read come back empty and turns a retryable
  # refusal into a fatal one.
  jq -nc --arg code "$errc" --arg message "$errm" '{error: {code: $code, message: $message}}'
  return 2
}

# _ralph_herdr_one_object BODY — true when BODY is exactly one JSON object and
# nothing else. `jq -s` slurps the whole stream and fails outright on trailing
# non-JSON, so this single check covers malformed bodies, truncated writes,
# banner text printed before the envelope, and two envelopes concatenated by a
# confused server.
_ralph_herdr_one_object() {
  printf '%s' "$1" | jq -e -s 'length == 1 and (.[0] | type == "object")' >/dev/null 2>&1
}

# ralph_herdr_err_code BODY — the error code out of an rc-2 body. The reliable
# way to read it: unlike $RALPH_HERDR_ERR_CODE, this works when the call was
# made in a command substitution, which is how nearly every caller writes it.
# Prints nothing for anything that is not an error body.
ralph_herdr_err_code() {
  printf '%s' "${1-}" | jq -r '.error.code // empty' 2>/dev/null || true
}

# ralph_herdr_err_message BODY — the human-readable half, already sanitized by
# the adapter. For display only; never branch on it (prose is not a contract).
ralph_herdr_err_message() {
  printf '%s' "${1-}" | jq -r '.error.message // empty' 2>/dev/null || true
}

# _ralph_herdr_timeout — echo a timeout command prefix, or nothing.
# A hung server must not hang a cockpit action forever, but macOS ships no
# `timeout`; coreutils installs it as `gtimeout`. Where neither exists the call
# runs unbounded rather than not at all — losing the bound is a degradation,
# refusing the call would be an outage.
_ralph_herdr_timeout() {
  local secs="${RALPH_HERDR_TIMEOUT_SEC:-30}"
  case "$secs" in '' | *[!0-9]* | 0) secs=30 ;; esac
  if command -v timeout >/dev/null 2>&1; then
    echo "timeout $secs"
  elif command -v gtimeout >/dev/null 2>&1; then
    echo "gtimeout $secs"
  fi
}

# ralph_herdr_call EXPECTED_TYPE ARG... — invoke herdr and validate the reply.
#
# On rc 0 the validated `.result` object is printed to stdout; callers read
# their fields off THAT, never off the raw envelope, so no call site can
# accidentally consume an unvalidated response.
#
# EXPECTED_TYPE is the protocol result discriminant the caller intends to
# consume ("agent_list", "worktree_created", …). Passing a type this adapter
# has no field table for is a programming error and fails closed: an unknown
# type means nobody decided what "valid" means for it.
ralph_herdr_call() {
  local want="$1"; shift
  local bin="${HERDR_BIN_PATH:-herdr}"
  local required arrays field out rc got_id got_type tmo op errf diag

  # A fixed, sanitized operation label for every diagnostic below. The raw "$*"
  # carries caller-supplied argv — notification titles and prompt bodies among
  # them — straight into stderr, which is the one place these messages are
  # rendered for a human. Terminal-derived text does not get to paint the log
  # that reports on it.
  op="'$(ralph_sanitize "$1 $2")'"

  RALPH_HERDR_ERR_CODE=""
  RALPH_HERDR_ERR_MESSAGE=""

  if ! required=$(_ralph_required_fields "$want"); then
    echo "ralph_herdr_call: no validation table for result type '$want' — refusing to consume an unvalidated response" >&2
    return 1
  fi
  arrays=$(_ralph_array_fields "$want")

  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "ralph_herdr_call: herdr is not installed (looked for '$bin')" >&2
    return 3
  fi

  # stderr is deliberately NOT merged into stdout: herdr prints diagnostics
  # there, and folding them in would turn a valid envelope into trailing
  # garbage. It is captured to a private file instead, because herdr answers a
  # REFUSAL there — probed on 0.8.x: `worktree create` from a linked worktree
  # and `agent start` at a bogus pane both write their error envelope to
  # stderr, exit 1, and leave stdout empty. Discarding it (as this did) turned
  # every refusal in the plugin into "server unreachable", which is how a
  # one-line cwd error read as an outage (GH-1832) and how a retryable
  # agent_pane_busy race read as a dead server.
  errf=$(ralph_diag_file)
  tmo=$(_ralph_herdr_timeout)
  # shellcheck disable=SC2086  # intentional: $tmo is a command prefix or empty
  out=$($tmo "$bin" "$@" 2>"$errf")
  rc=$?
  diag=$(cat "$errf" 2>/dev/null || true)
  # ralph_diag_file degrades to /dev/null when mktemp fails; `rm -f /dev/null`
  # is a permission error, not a no-op, and these scripts are sourced under
  # `set -e`. Skipping it costs nothing — that branch captured no diagnostic to
  # clean up, and the call degrades to exactly the old stderr-discarding
  # behaviour rather than taking the caller down with it.
  [ "$errf" = /dev/null ] || rm -f "$errf" 2>/dev/null || true

  # 124 is the documented timeout(1) exit. Distinguished from a refusal because
  # a timed-out mutation may well have LANDED — the caller must not retry it
  # blindly, and must not read the silence as "it did not happen".
  if [ "$rc" -eq 124 ]; then
    echo "ralph_herdr_call: $op timed out after ${RALPH_HERDR_TIMEOUT_SEC:-30}s — the operation may or may not have been applied" >&2
    return 3
  fi

  if [ -z "$out" ]; then
    # Nothing on stdout. Before claiming the server never answered, look at
    # what it said on stderr — that is where a refusal lands. The predicate is
    # deliberately tight: a nonzero exit (a success exit with an empty stdout
    # is incoherent, not a refusal), exactly one JSON object, and the full
    # protocol-19 error shape. Anything looser and an ordinary diagnostic line
    # would be promoted to a protocol answer.
    #
    # Only consulted when stdout is EMPTY, so this never has to adjudicate
    # between two candidate responses: with a body on stdout, stdout IS the
    # response and stderr is noise, exactly as before.
    if [ "$rc" -ne 0 ] && [ -n "$diag" ] && _ralph_herdr_one_object "$diag" &&
      printf '%s' "$diag" | jq -e 'has("error")' >/dev/null 2>&1; then
      _ralph_herdr_refusal "$diag" "$op"
      return $?
    fi
    if [ -n "$diag" ]; then
      # The server said SOMETHING — just not a protocol answer. Reporting that
      # verbatim beats asserting a reachability verdict we did not test.
      echo "ralph_herdr_call: $op produced no output on stdout (exit $rc); stderr said: $(printf '%s' "$diag" | head -c 200 | tr '\n' ' ' | ralph_sanitize)" >&2
      return 3
    fi
    echo "ralph_herdr_call: $op produced no output (exit $rc) — herdr server unreachable" >&2
    return 3
  fi

  if ! _ralph_herdr_one_object "$out"; then
    echo "ralph_herdr_call: $op did not return exactly one JSON envelope (exit $rc) — refusing to guess at the response" >&2
    return 1
  fi

  # Error envelopes are well-formed protocol, not transport faults: the server
  # understood us and said no. Surfaced as rc 2 with the code preserved so
  # callers can branch on a SPECIFIC refusal (agent_pane_busy is a race worth
  # retrying; agent_name_taken is a real answer). Never branch on the prose.
  #
  # Kept on the stdout path as well as the stderr one above: the channel is an
  # observation about the installed binary, not a guarantee it owes us, and an
  # envelope is an envelope wherever it arrives.
  if printf '%s' "$out" | jq -e 'has("error")' >/dev/null 2>&1; then
    _ralph_herdr_refusal "$out" "$op"
    return $?
  fi

  # Protocol 19 requires `id` on every response. Its absence means we are not
  # talking to a protocol-19 server (or not to Herdr at all), and nothing below
  # can be trusted to mean what its field names suggest.
  got_id=$(printf '%s' "$out" | jq -r '.id // empty')
  if [ -z "$got_id" ]; then
    echo "ralph_herdr_call: $op returned a response with no correlation id — not a protocol-19 envelope" >&2
    return 1
  fi
  # When the caller knows the id it issued, require the reply to be that reply.
  # The CLI mints deterministic ids (cli:agent:list), so this is usually a
  # caller-side assertion rather than a live multiplexing concern — but it is
  # the only thing standing between a delayed reply and a caller that treats it
  # as the answer to the question it just asked.
  if [ -n "${RALPH_HERDR_EXPECT_ID:-}" ] && [ "$got_id" != "$RALPH_HERDR_EXPECT_ID" ]; then
    echo "ralph_herdr_call: $op replied to id '$(printf '%s' "$got_id" | ralph_sanitize)', expected '$RALPH_HERDR_EXPECT_ID' — refusing a response to a different request" >&2
    return 1
  fi

  # A success envelope that arrived with a nonzero exit is incoherent: the real
  # CLI pairs a nonzero exit with an ERROR body, so this combination means the
  # process died partway through writing, or something other than herdr
  # answered. Trusting the body because it parses would be reading a success
  # out of a failed command.
  if [ "$rc" -ne 0 ]; then
    echo "ralph_herdr_call: $op exited $rc but returned a success envelope — refusing a contradictory response" >&2
    return 1
  fi

  got_type=$(printf '%s' "$out" | jq -r '.result.type // empty')
  if [ "$got_type" != "$want" ]; then
    echo "ralph_herdr_call: $op returned result type '$(printf '%s' "${got_type:-<missing>}" | ralph_sanitize)', expected '$want'" >&2
    return 1
  fi

  for field in $required; do
    if ! printf '%s' "$out" | jq -e --arg f "$field" '.result | has($f) and (.[$f] != null)' >/dev/null 2>&1; then
      echo "ralph_herdr_call: $op returned $want without required field '$field'" >&2
      return 1
    fi
  done

  for field in $arrays; do
    if ! printf '%s' "$out" | jq -e --arg f "$field" '.result[$f] | type == "array"' >/dev/null 2>&1; then
      echo "ralph_herdr_call: $op returned $want whose '$field' is not an array — refusing to read it as an empty list" >&2
      return 1
    fi
  done

  printf '%s' "$out" | jq -c '.result'
}

# ralph_diag_file — a private temp file for one call's stderr. Callers that
# want the diagnostic on failure use this instead of `2>&1`.
#
# NEVER capture a snapshot with `2>&1`. It reads as a convenience — the
# diagnostic is right there when the call fails — but on SUCCESS it prepends
# any stray stderr line to the JSON, jq then rejects the whole value, and the
# scoped herd collapses to an empty list. That is the exact failure this file
# exists to prevent, arriving through the back door: "I could not find out"
# rendered as "no agents are running". Downstream, reconcile marks live agents
# lost and doctor reports a herd of gaps.
#
# So: stderr to a file, read only on the failure branch.
#
#   err=$(ralph_diag_file)
#   if ! snap=$(ralph_herdr_snapshot 2>"$err"); then
#     log "... ($(ralph_diag_read "$err"))"
#     rm -f "$err"; return 1
#   fi
#   rm -f "$err"
ralph_diag_file() {
  mktemp "${TMPDIR:-/tmp}/ralph-herdr-diag.XXXXXX" 2>/dev/null || echo /dev/null
}

# ralph_diag_read FILE — the first 200 bytes of a diagnostic, sanitized and
# flattened to one line. Sanitized because herdr's stderr is terminal-derived
# and this lands in a log a human reads.
ralph_diag_read() {
  [ -r "${1:-}" ] || return 0
  head -c 200 "$1" 2>/dev/null | tr '\n' ' ' | ralph_sanitize
}

# ralph_herdr_snapshot — the one validated `session.snapshot` a reconciliation
# cycle is built on. Prints the SessionSnapshot object (not the enclosing
# result) on rc 0; propagates the adapter's codes otherwise.
#
# The snapshot is also the capability probe: protocol 19 has no CLI-reachable
# ping, but SessionSnapshot carries `version` and `protocol` as required
# fields, so the same call that fetches session state proves the server speaks
# a dialect this plugin understands. Every snapshot is checked rather than only
# the first, because the socket can be re-pointed at a different server between
# calls and a downgrade must not slip through a memoized yes.
ralph_herdr_snapshot() {
  local result snapshot proto min="${RALPH_HERDR_MIN_PROTOCOL:-19}" rc

  result=$(ralph_herdr_call session_snapshot api snapshot) || { rc=$?; return "$rc"; }
  snapshot=$(printf '%s' "$result" | jq -c '.snapshot')

  proto=$(printf '%s' "$snapshot" | jq -r '.protocol // empty')
  case "$proto" in
    '' | *[!0-9]*)
      echo "ralph_herdr_snapshot: snapshot reported no usable protocol version" >&2
      return 1
      ;;
  esac
  if [ "$proto" -lt "$min" ]; then
    echo "ralph_herdr_snapshot: server speaks protocol $proto, this plugin requires $min or newer (herdr 0.8.0+)" >&2
    return 1
  fi

  # SessionSnapshot's own required arrays. A snapshot missing `agents` or
  # `workspaces` would join to nothing and read as "this repository has no
  # workers" — the single most dangerous false negative in the whole plugin.
  local field
  for field in workspaces panes agents; do
    if ! printf '%s' "$snapshot" | jq -e --arg f "$field" '.[$f] | type == "array"' >/dev/null 2>&1; then
      echo "ralph_herdr_snapshot: snapshot '$field' is missing or not an array — refusing to reconcile against a partial snapshot" >&2
      return 1
    fi
  done

  printf '%s' "$snapshot"
}
