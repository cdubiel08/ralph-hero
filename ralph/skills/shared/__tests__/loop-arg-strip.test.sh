#!/usr/bin/env bash
# loop-arg-strip.test.sh — Verify arg-parsing snippet from loop-wrapper.md § Arg-parsing snippet
# Usage: bash ralph/skills/shared/__tests__/loop-arg-strip.test.sh
# Exit 0 = all pass; exit 1 = at least one failure.
#
# Embeds an identical copy of the snippet (per loop-wrapper.md guidance: copy-paste,
# not sourced, so each consumer is self-contained). Tests document REAL snippet behavior
# including the --loop dynamic case (dynamic is not a numeric duration so it stays in
# STRIPPED_ARGS).

set -uo pipefail

PASS=0
FAIL=0

# ── helpers ────────────────────────────────────────────────────────────────────

ok()   { echo "PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "FAIL: $1"; echo "      expected: $2"; echo "      got:      $3"; FAIL=$((FAIL + 1)); }

# Run the Phase-1 arg-parsing snippet for the given ARGUMENTS string.
# Outputs three lines: LOOP_RAW=<val>  LOOP_INTERVAL=<val>  STRIPPED_ARGS=<val>
run_snippet() {
  local ARGUMENTS="$1"
  local LOOP_RAW=""
  local LOOP_INTERVAL=""
  local STRIPPED_ARGS="$ARGUMENTS"
  if [[ "$ARGUMENTS" =~ (^|[[:space:]])--loop([[:space:]]+([0-9]+[smhd][0-9smhd]*))?([[:space:]]|$) ]]; then
    LOOP_RAW="1"
    LOOP_INTERVAL="${BASH_REMATCH[3]}"
    STRIPPED_ARGS="$(printf '%s' "$ARGUMENTS" | sed -E 's/(^|[[:space:]])--loop([[:space:]]+[0-9]+[smhd][0-9smhd]*)?([[:space:]]|$)/\1/g' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  fi
  printf 'LOOP_RAW=%s\nLOOP_INTERVAL=%s\nSTRIPPED_ARGS=%s\n' \
    "$LOOP_RAW" "$LOOP_INTERVAL" "$STRIPPED_ARGS"
}

# Extract field from run_snippet output
get_field() {
  local field="$1"
  local output="$2"
  printf '%s' "$output" | grep "^${field}=" | cut -d= -f2-
}

# ── fixtures ────────────────────────────────────────────────────────────────────

# 1. --loop (bare, no duration, no other args)
out=$(run_snippet "--loop")
raw=$(get_field LOOP_RAW "$out"); interval=$(get_field LOOP_INTERVAL "$out"); stripped=$(get_field STRIPPED_ARGS "$out")
if [[ "$raw" == "1" && -z "$interval" && -z "$stripped" ]]; then
  ok "fixture 1: --loop → LOOP_RAW=1, LOOP_INTERVAL='', STRIPPED_ARGS=''"
else
  fail "fixture 1: --loop" "raw=1 interval='' stripped=''" "raw='$raw' interval='$interval' stripped='$stripped'"
fi

# 2. --loop 5m (duration captured, stripped)
out=$(run_snippet "--loop 5m")
raw=$(get_field LOOP_RAW "$out"); interval=$(get_field LOOP_INTERVAL "$out"); stripped=$(get_field STRIPPED_ARGS "$out")
if [[ "$raw" == "1" && "$interval" == "5m" && -z "$stripped" ]]; then
  ok "fixture 2: --loop 5m → LOOP_RAW=1, LOOP_INTERVAL='5m', STRIPPED_ARGS=''"
else
  fail "fixture 2: --loop 5m" "raw=1 interval='5m' stripped=''" "raw='$raw' interval='$interval' stripped='$stripped'"
fi

# 3. --loop dynamic (dynamic is not a numeric duration; documents real behavior)
# Snippet: --loop matches but duration pattern [0-9]+[smhd]* does not match "dynamic"
# → LOOP_RAW=1, LOOP_INTERVAL='', STRIPPED_ARGS='dynamic' (word left behind by sed)
out=$(run_snippet "--loop dynamic")
raw=$(get_field LOOP_RAW "$out"); interval=$(get_field LOOP_INTERVAL "$out"); stripped=$(get_field STRIPPED_ARGS "$out")
if [[ "$raw" == "1" && -z "$interval" && "$stripped" == "dynamic" ]]; then
  ok "fixture 3: --loop dynamic → LOOP_RAW=1, LOOP_INTERVAL='', STRIPPED_ARGS='dynamic'"
else
  fail "fixture 3: --loop dynamic" "raw=1 interval='' stripped='dynamic'" "raw='$raw' interval='$interval' stripped='$stripped'"
fi

# 4. --mode auto --loop (flag at end of args)
out=$(run_snippet "--mode auto --loop")
raw=$(get_field LOOP_RAW "$out"); interval=$(get_field LOOP_INTERVAL "$out"); stripped=$(get_field STRIPPED_ARGS "$out")
if [[ "$raw" == "1" && -z "$interval" && "$stripped" == "--mode auto" ]]; then
  ok "fixture 4: --mode auto --loop → LOOP_RAW=1, LOOP_INTERVAL='', STRIPPED_ARGS='--mode auto'"
else
  fail "fixture 4: --mode auto --loop" "raw=1 interval='' stripped='--mode auto'" "raw='$raw' interval='$interval' stripped='$stripped'"
fi

# 5. --mode auto --loop 1h (flag with duration at end)
out=$(run_snippet "--mode auto --loop 1h")
raw=$(get_field LOOP_RAW "$out"); interval=$(get_field LOOP_INTERVAL "$out"); stripped=$(get_field STRIPPED_ARGS "$out")
if [[ "$raw" == "1" && "$interval" == "1h" && "$stripped" == "--mode auto" ]]; then
  ok "fixture 5: --mode auto --loop 1h → LOOP_RAW=1, LOOP_INTERVAL='1h', STRIPPED_ARGS='--mode auto'"
else
  fail "fixture 5: --mode auto --loop 1h" "raw=1 interval='1h' stripped='--mode auto'" "raw='$raw' interval='$interval' stripped='$stripped'"
fi

# 6. --loop --mode auto (flag at beginning, other args follow)
out=$(run_snippet "--loop --mode auto")
raw=$(get_field LOOP_RAW "$out"); interval=$(get_field LOOP_INTERVAL "$out"); stripped=$(get_field STRIPPED_ARGS "$out")
if [[ "$raw" == "1" && -z "$interval" && "$stripped" == "--mode auto" ]]; then
  ok "fixture 6: --loop --mode auto → LOOP_RAW=1, LOOP_INTERVAL='', STRIPPED_ARGS='--mode auto'"
else
  fail "fixture 6: --loop --mode auto" "raw=1 interval='' stripped='--mode auto'" "raw='$raw' interval='$interval' stripped='$stripped'"
fi

# 7. --mode auto --loop 5m #1234 (flag with duration, issue number preserved)
out=$(run_snippet "--mode auto --loop 5m #1234")
raw=$(get_field LOOP_RAW "$out"); interval=$(get_field LOOP_INTERVAL "$out"); stripped=$(get_field STRIPPED_ARGS "$out")
if [[ "$raw" == "1" && "$interval" == "5m" && "$stripped" == "--mode auto #1234" ]]; then
  ok "fixture 7: --mode auto --loop 5m #1234 → LOOP_RAW=1, LOOP_INTERVAL='5m', STRIPPED_ARGS='--mode auto #1234'"
else
  fail "fixture 7: --mode auto --loop 5m #1234" "raw=1 interval='5m' stripped='--mode auto #1234'" "raw='$raw' interval='$interval' stripped='$stripped'"
fi

# 8. --loop --pr 99 (flag before other flag)
out=$(run_snippet "--loop --pr 99")
raw=$(get_field LOOP_RAW "$out"); interval=$(get_field LOOP_INTERVAL "$out"); stripped=$(get_field STRIPPED_ARGS "$out")
if [[ "$raw" == "1" && -z "$interval" && "$stripped" == "--pr 99" ]]; then
  ok "fixture 8: --loop --pr 99 → LOOP_RAW=1, LOOP_INTERVAL='', STRIPPED_ARGS='--pr 99'"
else
  fail "fixture 8: --loop --pr 99" "raw=1 interval='' stripped='--pr 99'" "raw='$raw' interval='$interval' stripped='$stripped'"
fi

# 9. not-a-loop-flag --loop something (flag in mid-position; documents real behavior)
# Snippet matches --loop; "something" is left in STRIPPED_ARGS (not a numeric duration)
out=$(run_snippet "not-a-loop-flag --loop something")
raw=$(get_field LOOP_RAW "$out"); interval=$(get_field LOOP_INTERVAL "$out"); stripped=$(get_field STRIPPED_ARGS "$out")
if [[ "$raw" == "1" && -z "$interval" && "$stripped" == "not-a-loop-flag something" ]]; then
  ok "fixture 9: not-a-loop-flag --loop something → LOOP_RAW=1, LOOP_INTERVAL='', STRIPPED_ARGS='not-a-loop-flag something'"
else
  fail "fixture 9: not-a-loop-flag --loop something" "raw=1 interval='' stripped='not-a-loop-flag something'" "raw='$raw' interval='$interval' stripped='$stripped'"
fi

# 10. Baseline: no --loop flag present
out=$(run_snippet "--mode auto #5")
raw=$(get_field LOOP_RAW "$out"); interval=$(get_field LOOP_INTERVAL "$out"); stripped=$(get_field STRIPPED_ARGS "$out")
if [[ -z "$raw" && -z "$interval" && "$stripped" == "--mode auto #5" ]]; then
  ok "fixture 10: baseline (no --loop) → LOOP_RAW='', LOOP_INTERVAL='', STRIPPED_ARGS='--mode auto #5'"
else
  fail "fixture 10: baseline" "raw='' interval='' stripped='--mode auto #5'" "raw='$raw' interval='$interval' stripped='$stripped'"
fi

# ── summary ────────────────────────────────────────────────────────────────────

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
if [[ "$FAIL" -eq 0 ]]; then
  exit 0
else
  exit 1
fi
