#!/usr/bin/env bash
# dirty.sh — the "something happened, come look" channel. Sourced, never run.
#
# Herdr's plugin contract supplies event metadata, but documents no durable
# ordering, no replay cursor, no deduplication key, no exactly-once delivery,
# and no transaction spanning snapshots and events. Status events also omit the
# durable identity Ralph needs. An event is therefore evidence that the world
# moved — not a description of how it moved, and not a record that can be
# replayed to rebuild state.
#
# So events do not mutate durable lifecycle state from their payload. They mark
# the affected scope dirty and let reconciliation — which reads one validated,
# scoped snapshot and compares it against the ledger — decide what actually
# changed. The event's job is to make that happen sooner than the next
# scheduled pass, nothing more.
#
# What this buys, concretely: a delayed event for an agent that already exited
# cannot reopen it, a duplicate event cannot double-append, an event naming a
# reused agent name cannot attach to the newer worker, and an event that
# arrives while a spawn is mid-flight cannot record a state for an identity
# that does not exist yet. All four collapse into "the snapshot decides".
#
# The marker is one file per scope, next to that scope's ledger. It is a
# LEVEL, not a queue: ten events between two reconciles leave one dirty marker,
# because the reconciler does not care how many times it was told — it re-reads
# everything either way. That is what keeps an event storm from becoming a
# snapshot storm.

# ralph_dirty_path LEDGER_FILE — the marker path for a ledger's scope.
ralph_dirty_path() {
  printf '%s/dirty' "$(dirname "$1")"
}

# ralph_dirty_mark LEDGER_FILE REASON — record that this scope needs a look.
#
# Last-write-wins on a single line, deliberately: the marker answers "is there
# anything to do", and the reason is a breadcrumb for a human reading the file,
# not an input to the reconciler. Appending instead would grow without bound
# between passes for exactly zero added information.
#
# Never fails the caller. A marker that cannot be written costs latency — the
# next scheduled reconcile still finds the truth — and an event hook that died
# trying to write a hint would be strictly worse than one that stayed quiet.
ralph_dirty_mark() {
  local file="$1" reason="${2:-event}" dir
  dir=$(dirname "$file")
  [ -d "$dir" ] || return 0
  printf '%s %s\n' "$(date -u +%FT%TZ)" "$reason" >"$(ralph_dirty_path "$file")" 2>/dev/null || true
  return 0
}

# ralph_dirty_check LEDGER_FILE — rc 0 when the scope is marked dirty.
ralph_dirty_check() {
  [ -f "$(ralph_dirty_path "$1")" ]
}

# ralph_dirty_clear LEDGER_FILE — drop the marker. Called by the reconciler
# AFTER its pass, so an event arriving mid-pass leaves the scope dirty and
# earns one more pass rather than being swallowed by the one already running.
ralph_dirty_clear() {
  rm -f "$(ralph_dirty_path "$1")" 2>/dev/null || true
  return 0
}
