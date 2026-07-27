#!/usr/bin/env bash
# auto-alias.test.sh — Verify --auto arg-rewrite logic for ralph slim plugin skills
# Usage: bash ralph/skills/shared/__tests__/auto-alias.test.sh
# Exit 0 = all pass; exit 1 = at least one failure.

set -uo pipefail

PASS=0
FAIL=0

# ── helpers ────────────────────────────────────────────────────────────────────

ok()   { echo "PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "FAIL: $1"; echo "      expected: $2"; echo "      got:      $3"; FAIL=$((FAIL + 1)); }

# Embed the same rewrite logic the Step-0 stanzas use.
# $1 = verb (research|plan|impl|review|caretake|hero|form|catch-up|setup)
# $2 = raw ARGUMENTS string
# Outputs two lines: "ARGUMENTS=<result>" and "MSG=<conflict/refusal msg, empty if none>"
resolve_auto() {
  local verb="$1"
  local ARGUMENTS="$2"
  local MSG=""

  # Refusal targets
  case "$verb" in
    form|catch-up|setup)
      if [[ "$ARGUMENTS" =~ (^|[[:space:]])--auto([[:space:]]|$) ]]; then
        MSG="--auto is not supported for this verb (interactive / single-artifact / one-shot). See ralph/CLAUDE.md § Loop and --auto suitability matrix for the canonical table."
        printf 'ARGUMENTS=%s\nMSG=%s\n' "$ARGUMENTS" "$MSG"
        return
      fi
      ;;
  esac

  # Alias-table verbs
  if [[ "$ARGUMENTS" =~ (^|[[:space:]])--auto([[:space:]]|$) ]]; then
    # Conflict: --auto + explicit --mode
    if [[ "$ARGUMENTS" =~ (^|[[:space:]])--mode[[:space:]] ]]; then
      MSG="--auto cannot be combined with explicit --mode; pick one."
      printf 'ARGUMENTS=%s\nMSG=%s\n' "$ARGUMENTS" "$MSG"
      return
    fi

    # Strip --auto token
    local stripped
    stripped="$(printf '%s' "$ARGUMENTS" | sed -E 's/(^|[[:space:]])--auto([[:space:]]|$)/\1/g' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"

    # Prepend resolved mode per alias table
    case "$verb" in
      research|plan|impl|hero)
        ARGUMENTS="--mode auto${stripped:+ ${stripped}}"
        ;;
      caretake)
        ARGUMENTS="--mode triage${stripped:+ ${stripped}}"
        ;;
      review)
        # No mode prepend; default is already autonomous
        ARGUMENTS="${stripped}"
        ;;
    esac
  fi

  printf 'ARGUMENTS=%s\nMSG=%s\n' "$ARGUMENTS" "$MSG"
}

# Helper: extract field from resolve_auto output
get_field() {
  local field="$1"
  local output="$2"
  printf '%s' "$output" | grep "^${field}=" | cut -d= -f2-
}

# ── fixtures ────────────────────────────────────────────────────────────────────

# 1. --auto bare (research verb) → --mode auto
out=$(resolve_auto research "--auto")
args=$(get_field ARGUMENTS "$out"); msg=$(get_field MSG "$out")
if [[ "$args" == "--mode auto" && -z "$msg" ]]; then
  ok "--auto bare → --mode auto (research)"
else
  fail "--auto bare" "--mode auto / no msg" "args='$args' msg='$msg'"
fi

# 2. --auto --loop → mode resolved first, --loop preserved in STRIPPED_ARGS
out=$(resolve_auto impl "--auto --loop")
args=$(get_field ARGUMENTS "$out"); msg=$(get_field MSG "$out")
if [[ "$args" == "--mode auto --loop" && -z "$msg" ]]; then
  ok "--auto --loop → --mode auto --loop (impl)"
else
  fail "--auto --loop" "--mode auto --loop / no msg" "args='$args' msg='$msg'"
fi

# 3. --loop --auto (token order reversed) → same result
out=$(resolve_auto plan "--loop --auto")
args=$(get_field ARGUMENTS "$out"); msg=$(get_field MSG "$out")
if [[ "$args" == "--mode auto --loop" && -z "$msg" ]]; then
  ok "--loop --auto → --mode auto --loop (plan)"
else
  fail "--loop --auto" "--mode auto --loop / no msg" "args='$args' msg='$msg'"
fi

# 4. --auto #1234 → mode prepended, issue number preserved
out=$(resolve_auto research "--auto #1234")
args=$(get_field ARGUMENTS "$out"); msg=$(get_field MSG "$out")
if [[ "$args" == "--mode auto #1234" && -z "$msg" ]]; then
  ok "--auto #1234 → --mode auto #1234 (research)"
else
  fail "--auto #1234" "--mode auto #1234 / no msg" "args='$args' msg='$msg'"
fi

# 5. --auto --mode auto (conflict) → conflict message
out=$(resolve_auto research "--auto --mode auto")
msg=$(get_field MSG "$out")
if [[ "$msg" == "--auto cannot be combined with explicit --mode; pick one." ]]; then
  ok "--auto --mode auto → conflict message"
else
  fail "--auto --mode auto conflict" "conflict msg" "msg='$msg'"
fi

# 6. --auto --mode epic (conflict) → conflict message
out=$(resolve_auto plan "--auto --mode epic")
msg=$(get_field MSG "$out")
if [[ "$msg" == "--auto cannot be combined with explicit --mode; pick one." ]]; then
  ok "--auto --mode epic → conflict message"
else
  fail "--auto --mode epic conflict" "conflict msg" "msg='$msg'"
fi

# 7. No --auto (baseline) → ARGUMENTS unchanged
out=$(resolve_auto impl "--mode auto #5")
args=$(get_field ARGUMENTS "$out"); msg=$(get_field MSG "$out")
if [[ "$args" == "--mode auto #5" && -z "$msg" ]]; then
  ok "no --auto baseline → ARGUMENTS unchanged"
else
  fail "no --auto baseline" "--mode auto #5 / no msg" "args='$args' msg='$msg'"
fi

# 8. caretake --auto → --mode triage
out=$(resolve_auto caretake "--auto")
args=$(get_field ARGUMENTS "$out"); msg=$(get_field MSG "$out")
if [[ "$args" == "--mode triage" && -z "$msg" ]]; then
  ok "--auto (caretake) → --mode triage"
else
  fail "--auto caretake" "--mode triage / no msg" "args='$args' msg='$msg'"
fi

# 9. review --auto → no mode flag added (default is already autonomous)
out=$(resolve_auto review "--auto")
args=$(get_field ARGUMENTS "$out"); msg=$(get_field MSG "$out")
if [[ -z "$args" && -z "$msg" ]]; then
  ok "--auto (review) → no mode flag added (default is autonomous)"
else
  fail "--auto review" "empty args / no msg" "args='$args' msg='$msg'"
fi

# 10. form --auto → refusal
out=$(resolve_auto form "--auto")
msg=$(get_field MSG "$out")
if [[ "$msg" == *"--auto is not supported for this verb"* ]]; then
  ok "--auto (form) → refusal message"
else
  fail "--auto form" "refusal msg" "msg='$msg'"
fi

# 11. catch-up --auto → refusal
out=$(resolve_auto catch-up "--auto")
msg=$(get_field MSG "$out")
if [[ "$msg" == *"--auto is not supported for this verb"* ]]; then
  ok "--auto (catch-up) → refusal message"
else
  fail "--auto catch-up" "refusal msg" "msg='$msg'"
fi

# 12. setup --auto → refusal
out=$(resolve_auto setup "--auto")
msg=$(get_field MSG "$out")
if [[ "$msg" == *"--auto is not supported for this verb"* ]]; then
  ok "--auto (setup) → refusal message"
else
  fail "--auto setup" "refusal msg" "msg='$msg'"
fi

# ── summary ────────────────────────────────────────────────────────────────────

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
if [[ "$FAIL" -eq 0 ]]; then
  exit 0
else
  exit 1
fi
