#!/usr/bin/env bash
# loop-arg-strip.test.sh — Verify arg-parsing snippet from loop-wrapper.md § Arg-parsing snippet
# Usage: bash ralph/skills/shared/__tests__/loop-arg-strip.test.sh
# Exit 0 = all pass; exit 1 = at least one failure.
#
# GH-1607: extracts the snippet from loop-wrapper.md at test time instead of keeping
# a third hand-maintained copy (the prior embedded copy had drifted one token —
# printf '%s' vs the canonical echo). Tests document REAL snippet behavior including
# the --loop dynamic case (dynamic is not a numeric duration so it stays in
# STRIPPED_ARGS).

set -uo pipefail

PASS=0
FAIL=0

# Locate repo root from this script's location (ralph/skills/shared/__tests__)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
LOOP_WRAPPER="${REPO_ROOT}/ralph/skills/shared/loop-wrapper.md"

# ── helpers ────────────────────────────────────────────────────────────────────

ok()   { echo "PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "FAIL: $1"; echo "      expected: $2"; echo "      got:      $3"; FAIL=$((FAIL + 1)); }

# Extract the first fenced ```bash block after the "## Arg-parsing snippet" heading.
# This is the canonical snippet text — NOT a copy. If the heading or fence moves,
# or the block comes back empty, fail loudly rather than eval a silently-empty string
# (which would make every fixture below pass trivially on stale local defaults).
SNIPPET="$(awk '
  /^## Arg-parsing snippet/ { found=1 }
  found && /^```bash/ && !in_block { in_block=1; next }
  in_block && /^```/ { exit }
  in_block { print }
' "$LOOP_WRAPPER")"

if [[ -z "$SNIPPET" ]]; then
  echo "FATAL: could not extract a non-empty arg-parsing snippet from ${LOOP_WRAPPER}" >&2
  echo "       (expected a \`\`\`bash fence directly under '## Arg-parsing snippet')" >&2
  exit 1
fi

# Run the extracted arg-parsing snippet for the given ARGUMENTS string.
# Outputs three lines: LOOP_RAW=<val>  LOOP_INTERVAL=<val>  STRIPPED_ARGS=<val>
#
# CodeRabbit (PR #1620, 2026-07-27): `printf` used to be the last command in
# this function, so a snippet that FAILED still returned 0 and the fixtures
# below carried on comparing against the local defaults set just above — a
# verification that cannot fail. The failure is now propagated two ways, both
# needed: `return 1` gives the caller a nonzero status, AND the printf is
# skipped, so `out` comes back empty and every fixture's value assertion fails
# loudly rather than matching a default by accident.
run_snippet() {
  local ARGUMENTS="$1"
  local LOOP_RAW=""
  local LOOP_INTERVAL=""
  local STRIPPED_ARGS="$ARGUMENTS"
  if ! eval "$SNIPPET"; then
    echo "FATAL: extracted arg-parsing snippet failed for ARGUMENTS='$ARGUMENTS'" >&2
    return 1
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
