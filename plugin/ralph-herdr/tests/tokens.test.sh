#!/usr/bin/env bash
# tokens.test.sh — standalone tests for scripts/tokens.sh (TAP-ish output).
#
#   bash plugin/ralph-herdr/tests/tokens.test.sh   # exits 0 on pass, 1 on fail
#
# No real herdr: HERDR_BIN_PATH points at a stub that records its argv. The
# subject is what ralph_tokens_push DOES with a token — which ones reach the
# CLI and which are dropped — so every assertion reads that recording.
# bash 3.2 compatible.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../scripts/tokens.sh
. "$SCRIPT_DIR/../scripts/tokens.sh"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
ARGV="$TMP/argv"

cat >"$TMP/herdr" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$ARGV_FILE"
echo '{}'
EOF
chmod +x "$TMP/herdr"
export HERDR_BIN_PATH="$TMP/herdr" ARGV_FILE="$ARGV"

n=0 pass=0 fail=0
ok()     { n=$((n + 1)); pass=$((pass + 1)); echo "ok $n - $1"; }
not_ok() { n=$((n + 1)); fail=$((fail + 1)); echo "not ok $n - $1"; }

# push DESC EXPECTED_ARGV TOKEN... — run one push and compare the recorded
# argv (empty string = the CLI was never invoked, i.e. the token was dropped).
push() {
  local desc="$1" want="$2" got
  shift 2
  : >"$ARGV"
  _RALPH_TOKENS_WARNED=""
  ralph_tokens_push p1 "$@" 2>/dev/null
  got=$(cat "$ARGV")
  if [ "$got" = "$want" ]; then ok "$desc"; else not_ok "$desc — expected '$want', got '$got'"; fi
}

BASE="pane report-metadata p1 --source ralph-herdr"

# ── C8 state enum (GH-1880) ─────────────────────────────────────────────────
for s in $RALPH_TOKEN_STATES; do
  push "state=$s (C8 member) is pushed" "$BASE --token state=$s" "state=$s"
done

push "state=sleeping (outside C8) is dropped" "" "state=sleeping"
push "state=Working (C8 is case-sensitive) is dropped" "" "state=Working"
push "state= (empty) is dropped" "" "state="
# Substring safety: the membership test is word-delimited, not a substring match.
push "state=work (prefix of a member) is dropped" "" "state=work"
push "state=orking (suffix of a member) is dropped" "" "state=orking"

# A bad state poisons the whole push — the wrapper's existing all-or-nothing
# rule (any invalid token returns before the CLI call), not a new one.
push "a bad state drops its companions too" "" "role=driver" "state=sleeping"
push "a good state rides with its companions" \
  "$BASE --token role=driver --token state=working" "role=driver" "state=working"

# ── other names stay free-form ──────────────────────────────────────────────
push "non-state names are not enum-checked" \
  "$BASE --token role=sleeping" "role=sleeping"
push "a value that is a state name under another token is fine" \
  "$BASE --token verdict=working" "verdict=working"

# ── the pre-existing wire-shape rules still hold ────────────────────────────
push "bad token name is dropped" "" "bad name=x"
push "missing = is dropped" "" "notakv"

echo "1..$n"
[ "$fail" -eq 0 ] || exit 1
