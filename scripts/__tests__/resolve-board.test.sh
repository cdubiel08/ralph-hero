#!/usr/bin/env bash
# scripts/__tests__/resolve-board.test.sh
# Tests ralph/scripts/resolve-board.sh (the stable board-CLI resolver, A1) and
# ralph/hooks/resolve-board-context.sh (the SessionStart hook that publishes
# RALPH_BOARD and refreshes the ~/.ralph/bin/board shim).
#
# The resolver's contract is the whole point: exactly ONE path on stdout,
# exit 0 always, every fallback narrated on stderr — never silent, never
# blocking. The hook's contract: <=3 lines of session context, a shim that
# re-resolves at CALL time (so a mid-session release is picked up), and an
# idempotent write-temp+mv regeneration. All fixture paths are injected via
# RALPH_INSTALLED_PLUGINS_FILE / CLAUDE_CONFIG_DIR / RALPH_BIN_DIR so the
# suite never reads the machine's real plugin installs.

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RESOLVER="$ROOT/ralph/scripts/resolve-board.sh"
HOOK="$ROOT/ralph/hooks/resolve-board-context.sh"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; ((PASS++)) || true; }
fail() { echo "  FAIL: $1"; ((FAIL++)) || true; }

# eq <desc> <expected> <actual>
eq() {
  if [ "$2" = "$3" ]; then
    pass "$1"
  else
    fail "$1"
    printf '    want: %s\n    got : %s\n' "$2" "$3"
  fi
}

# run_resolver <registry-file> -> OUT, ERR, RC. CLAUDE_CONFIG_DIR is pointed
# at a fixture dir so the glob-guess never sees a real install.
run_resolver() {
  set +e
  OUT=$(RALPH_INSTALLED_PLUGINS_FILE="$1" CLAUDE_CONFIG_DIR="${2:-$TMP/no-config}" \
    bash "$RESOLVER" 2>"$TMP/err")
  RC=$?
  set -e
  ERR=$(<"$TMP/err")
}

echo "=== resolve-board.sh ==="

# --- Fixtures: two installed copies at different versions -------------------
mkdir -p "$TMP/inst/old/scripts" "$TMP/inst/new/scripts"
printf '#!/bin/sh\necho OLD "$@"\n' >"$TMP/inst/old/scripts/board"
printf '#!/bin/sh\necho NEW "$@"\n' >"$TMP/inst/new/scripts/board"
chmod +x "$TMP/inst/old/scripts/board" "$TMP/inst/new/scripts/board"
cat >"$TMP/registry.json" <<EOF
{"plugins": {"ralph@marketplace": [
  {"version": "0.1.100", "installPath": "$TMP/inst/old"},
  {"version": "0.1.101", "installPath": "$TMP/inst/new"}
]}}
EOF

# 1. Registry present: the NEWEST installed copy wins, silently.
run_resolver "$TMP/registry.json"
eq "registry resolves the highest-version install" "$TMP/inst/new/scripts/board" "$OUT"
eq "registry hit exits 0" 0 "$RC"
eq "registry hit is silent on stderr" "" "$ERR"

# 2. A recorded install whose CLI is gone is skipped, not served.
cat >"$TMP/registry-dangling.json" <<EOF
{"plugins": {"ralph@marketplace": [
  {"version": "0.1.100", "installPath": "$TMP/inst/old"},
  {"version": "0.1.999", "installPath": "$TMP/inst/gone"}
]}}
EOF
run_resolver "$TMP/registry-dangling.json"
eq "a dangling installPath is skipped for the next executable one" "$TMP/inst/old/scripts/board" "$OUT"

# 3. No registry: fall back to the in-tree copy beside the script, WARNED.
run_resolver "$TMP/absent.json"
eq "no registry falls back to the in-tree copy" "$ROOT/ralph/scripts/board" "$OUT"
eq "fallback exits 0 (never blocking)" 0 "$RC"
if [ -n "$ERR" ]; then
  pass "fallback is narrated on stderr (never silent)"
else
  fail "fallback printed no warning"
fi
eq "stdout is exactly one line" 1 "$(printf '%s\n' "$OUT" | wc -l | tr -d ' ')"

# 4. Unparseable registry: same fallback, same contract.
echo 'not json' >"$TMP/garbage.json"
run_resolver "$TMP/garbage.json"
eq "garbage registry still prints one runnable path" "$ROOT/ralph/scripts/board" "$OUT"
eq "garbage registry exits 0" 0 "$RC"

# 5. Registry unreadable but a versioned cache exists: the newest cached
# copy is served and LABELLED a guess.
mkdir -p "$TMP/cfg/plugins/cache/mk/ralph/0.1.90/scripts" "$TMP/cfg/plugins/cache/mk/ralph/0.1.91/scripts"
printf '#!/bin/sh\necho C90\n' >"$TMP/cfg/plugins/cache/mk/ralph/0.1.90/scripts/board"
printf '#!/bin/sh\necho C91\n' >"$TMP/cfg/plugins/cache/mk/ralph/0.1.91/scripts/board"
chmod +x "$TMP/cfg/plugins/cache/mk/ralph/0.1.90/scripts/board" "$TMP/cfg/plugins/cache/mk/ralph/0.1.91/scripts/board"
run_resolver "$TMP/absent.json" "$TMP/cfg"
eq "cache glob picks the newest version" "$TMP/cfg/plugins/cache/mk/ralph/0.1.91/scripts/board" "$OUT"
case "$ERR" in
  *guess*) pass "cache-glob answer is labelled a guess" ;;
  *) fail "cache-glob answer not labelled a guess: $ERR" ;;
esac

echo "=== resolve-board-context.sh (SessionStart) ==="

# run_hook_ctx -> OUT, RC. Not gated on HERDR_ENV — it serves every session.
run_hook_ctx() {
  set +e
  OUT=$(env -u HERDR_ENV \
    RALPH_INSTALLED_PLUGINS_FILE="$TMP/registry.json" \
    CLAUDE_CONFIG_DIR="$TMP/no-config" \
    RALPH_BIN_DIR="$TMP/bin" \
    CLAUDE_PLUGIN_ROOT="$ROOT/ralph" \
    bash "$HOOK" <<<'{}' 2>/dev/null)
  RC=$?
  set -e
}

# 6. Emits the resolved path as RALPH_BOARD=, <=3 lines, exit 0.
run_hook_ctx
eq "hook exits 0" 0 "$RC"
eq "first context line is RALPH_BOARD=<resolved path>" \
  "RALPH_BOARD=$TMP/inst/new/scripts/board" \
  "$(printf '%s\n' "$OUT" | head -1)"
LINES=$(printf '%s\n' "$OUT" | wc -l | tr -d ' ')
if [ "$LINES" -le 3 ]; then
  pass "hook output is <=3 lines ($LINES)"
else
  fail "hook output is $LINES lines"
fi

# 7. The shim exists, is executable, and re-resolves at CALL time — a
# release landing after the shim was written is picked up without rewriting.
if [ -x "$TMP/bin/board" ]; then
  pass "shim written and executable"
else
  fail "shim missing or not executable"
fi
GOT=$(RALPH_INSTALLED_PLUGINS_FILE="$TMP/registry.json" CLAUDE_CONFIG_DIR="$TMP/no-config" "$TMP/bin/board" next --json 2>/dev/null)
eq "shim dispatches to the resolved CLI with args" "NEW next --json" "$GOT"
mkdir -p "$TMP/inst/newer/scripts"
printf '#!/bin/sh\necho NEWER "$@"\n' >"$TMP/inst/newer/scripts/board"
chmod +x "$TMP/inst/newer/scripts/board"
cat >"$TMP/registry.json" <<EOF
{"plugins": {"ralph@marketplace": [
  {"version": "0.1.101", "installPath": "$TMP/inst/new"},
  {"version": "0.1.102", "installPath": "$TMP/inst/newer"}
]}}
EOF
GOT=$(RALPH_INSTALLED_PLUGINS_FILE="$TMP/registry.json" CLAUDE_CONFIG_DIR="$TMP/no-config" "$TMP/bin/board" get 1 2>/dev/null)
eq "a mid-session release is picked up at call time, shim unchanged" "NEWER get 1" "$GOT"

# 8. Regeneration is idempotent: same bytes, still executable, no temp litter.
BEFORE=$(cat "$TMP/bin/board")
run_hook_ctx
eq "second run exits 0" 0 "$RC"
eq "shim regeneration is byte-idempotent" "$BEFORE" "$(cat "$TMP/bin/board")"
if [ -x "$TMP/bin/board" ]; then
  pass "regenerated shim is still executable"
else
  fail "regenerated shim lost its execute bit"
fi
LEFT=$(find "$TMP/bin" -name '.board.*' | wc -l | tr -d ' ')
eq "no temp files left behind" 0 "$LEFT"

# 9. An unwritable shim dir loses the shim, never the context line.
run_hook_ctx_robin() {
  set +e
  OUT=$(env -u HERDR_ENV \
    RALPH_INSTALLED_PLUGINS_FILE="$TMP/registry.json" \
    CLAUDE_CONFIG_DIR="$TMP/no-config" \
    RALPH_BIN_DIR="$TMP/file-not-dir/bin" \
    CLAUDE_PLUGIN_ROOT="$ROOT/ralph" \
    bash "$HOOK" <<<'{}' 2>/dev/null)
  RC=$?
  set -e
}
touch "$TMP/file-not-dir"
run_hook_ctx_robin
eq "unwritable shim dir: hook still exits 0" 0 "$RC"
case "$OUT" in
  RALPH_BOARD=*) pass "unwritable shim dir: context line still emitted" ;;
  *) fail "unwritable shim dir lost the context line: $OUT" ;;
esac

echo
echo "resolve-board: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
