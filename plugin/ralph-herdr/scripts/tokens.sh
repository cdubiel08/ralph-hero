#!/usr/bin/env bash
# tokens.sh — best-effort pane metadata tokens for the ralph-herdr watcher.
# Sourced, never run.
#
# Tokens are DECORATION: cockpit chrome on a pane's sidebar entry. Nothing may
# ever gate on them — the board is authoritative, the ledger is the record,
# and every failure path here warns (once) and returns 0 so degradation loses
# chrome, never verbs.
#
# DISCOVERED CLI (herdr 0.8.0, probed 2026-08-10 against a NONEXISTENT pane —
# read-only: the server answered pane_not_found, proving the parse):
#
#   herdr pane report-metadata <PANE_ID> --source <ID> --token NAME=VALUE [--token NAME=VALUE ...]
#
# Argument ORDER matters: the pane id must come FIRST. `--help` prints
# "[OPTIONS] --source <ID> <PANE_ID>", but the installed parser rejects
# space-separated option values before the positional ("unknown option:
# <value>") and rejects --opt=value entirely — positional first, then
# space-separated options, is the one form that parses. `--title` is used for
# the address-as-title rule (GH-2210/D6.2, below). Sibling flags that
# exist but are unused here: --agent, --applies-to-source,
# --state-label STATUS=TEXT, --clear-token NAME, --seq N, --ttl-ms N (TTL is
# deliberately omitted — tokens should persist until overwritten; reconcile.sh
# re-pushes them after a server restart anyway). Tokens merge per-name on the
# server: last write wins, other names survive.
#
# On a server refusal the CLI prints an .error JSON body AND exits nonzero
# (re-probed 2026-08-10: report-metadata against a nonexistent pane →
# pane_not_found body, rc 1). Failure detection below checks BOTH — the rc
# for transport failures, the body in case a future CLI version reports a
# refusal with rc 0.
#
# Token vocabulary (names, value shapes) is C8 in ralph/scripts/contracts.ts.
# This wrapper enforces the wire shape (NAME=VALUE, name <=32 [A-Za-z0-9_-],
# value <=80, no newlines) AND, for `state`, the C8 lifecycle enum (GH-1880).
#
# Why `state` and nothing else: it is the only token with a closed vocabulary —
# every other name is free-form by declaration, so there is nothing to check.
# The enum is spelled once here, as a bash literal, and cross-checked against
# contracts.ts's AGENT_STATES by ralph/scripts/contracts.test.ts, the same
# executable-parity shape the naming golden table uses across the two planes:
# a value added on either side and not the other fails CI. A bad state token is
# bookkeeping, never the one-writer invariant — so an unknown value DROPS the
# push with a warning and still returns 0, like every other failure path here.
#
# No top-level side effects, no set/shopt (callers own their shell options).
# bash 3.2 compatible.

_RALPH_TOKENS_WARNED=""

# The C8 `state` enum (contracts.ts AGENT_STATES). Space-delimited, bash 3.2:
# no arrays. Cross-checked against contracts.ts in CI — edit both or neither.
RALPH_TOKEN_STATES="spawned briefed working blocked reporting interrupted indeterminate orphaned adopted"

# _ralph_title_glyph STATE — the plain-text state glyph for a pane TITLE
# (GH-2210/D6.2). Deliberately not lib.sh's state_glyph: titles cannot carry
# ANSI color, so this is the ASCII-fallback vocabulary extended to the C8
# lifecycle enum. Three attention states get distinct marks; the pre-work
# states share one; the post-mortem states share the question mark, because a
# title's job is "does this pane need me", not the full enum.
_ralph_title_glyph() {
  case "${1-}" in
    working) printf '>' ;;
    blocked) printf '!' ;;
    reporting) printf '.' ;;
    spawned | briefed | adopted) printf '*' ;;
    *) printf '?' ;;
  esac
}

_ralph_tokens_warn_once() {
  if [ -z "$_RALPH_TOKENS_WARNED" ]; then
    _RALPH_TOKENS_WARNED=1
    echo "ralph_tokens_push: $* — tokens are decorative; continuing without them (further token warnings suppressed)" >&2
  fi
}

# ralph_tokens_push PANE_ID NAME=VALUE... — push metadata tokens onto a pane.
# Always returns 0: a bad argument, a missing CLI, or a server refusal costs
# the chrome, never the caller.
ralph_tokens_push() {
  local pane="${1-}" kv name value n herdr src out addr state
  if [ -z "$pane" ]; then
    _ralph_tokens_warn_once "called with no pane id"
    return 0
  fi
  shift || true
  [ "$#" -ge 1 ] || return 0
  addr="" state=""
  for kv in "$@"; do
    case "$kv" in
      *$'\n'* | *$'\r'*)
        _ralph_tokens_warn_once "token value contains a newline ('${kv%%=*}')"
        return 0
        ;;
      *=*) : ;;
      *)
        _ralph_tokens_warn_once "bad token '$kv' (want NAME=VALUE)"
        return 0
        ;;
    esac
    name="${kv%%=*}"
    value="${kv#*=}"
    case "$name" in
      '' | *[!A-Za-z0-9_-]*)
        _ralph_tokens_warn_once "bad token name '$name' (want 1-32 chars of [A-Za-z0-9_-])"
        return 0
        ;;
    esac
    if [ "${#name}" -gt 32 ] || [ "${#value}" -gt 80 ]; then
      _ralph_tokens_warn_once "token '$name' out of size budget (name <=32, value <=80)"
      return 0
    fi
    if [ "$name" = state ]; then
      case " $RALPH_TOKEN_STATES " in
        *" $value "*) : ;;
        *)
          _ralph_tokens_warn_once "state '$value' is outside the C8 lifecycle enum ($RALPH_TOKEN_STATES)"
          return 0
          ;;
      esac
    fi
    # Address-as-title (GH-2210/D6.2): remember the pair the title composes
    # from. Values are already validated above (no newlines, <=80 chars).
    case "$name" in
      address) addr="$value" ;;
      state) state="$value" ;;
    esac
  done
  # Rebuild the positional params as --token pairs: the for-loop list is
  # snapshotted before the first iteration, so appending via set -- is safe;
  # the shift then drops the original NAME=VALUE args (bash 3.2, no arrays).
  n=$#
  for kv in "$@"; do
    set -- "$@" --token "$kv"
  done
  shift "$n"
  # Pane title = address + state glyph (GH-2210/D6.2), composed only when this
  # push carries the address — the one token whose writer (the spawner, or a
  # watcher re-attaching it from the ledger) provably knows which agent the
  # pane hosts. A state-only push never invents a title: half a title is a
  # wrong pane identity, and the previous title survives token merges anyway.
  if [ -n "$addr" ]; then
    set -- "$@" --title "$addr $(_ralph_title_glyph "${state:-spawned}")"
  fi
  herdr="${HERDR_BIN_PATH:-herdr}"
  src="${HERDR_PLUGIN_ID:-ralph-herdr}"
  if ! out=$("$herdr" pane report-metadata "$pane" --source "$src" "$@" 2>&1); then
    _ralph_tokens_warn_once "herdr pane report-metadata failed (${out:0:120})"
    return 0
  fi
  if jq -e '.error' <<<"$out" >/dev/null 2>&1; then
    _ralph_tokens_warn_once "server refused metadata for pane $pane ($(jq -r '.error.code // "unknown"' <<<"$out" 2>/dev/null))"
  fi
  return 0
}
