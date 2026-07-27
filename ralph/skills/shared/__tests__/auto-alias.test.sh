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

# The canonical refusal text, read from auto-alias.md itself rather than
# re-typed here. The fixture previously hard-coded a stale variant ("§ Loop and
# --auto suitability matrix for the canonical table") that no longer existed in
# the source, so the resolver stopped modelling the real refusal while the
# substring assertions below stayed green. Extracting it makes drift impossible.
ALIAS_DOC="$(cd "$(dirname "$0")/.." && pwd)/auto-alias.md"
CANONICAL_REFUSAL="$(grep -m1 '^--auto is not supported for this verb' "$ALIAS_DOC")"
if [[ -z "$CANONICAL_REFUSAL" ]]; then
  echo "FATAL: could not extract the canonical --auto refusal text from $ALIAS_DOC"
  exit 1
fi

# Embed the same rewrite logic the Step-0 stanzas use.
# $1 = verb (research|plan|impl|review|caretake|hero|form|catch-up|setup)
# $2 = raw ARGUMENTS string
# Outputs three lines: "ARGUMENTS=<result>", "MODE=<resolved mode>" and
# "MSG=<conflict/refusal msg, empty if none>". MODE is modelled explicitly
# because rewriting $ARGUMENTS is NOT sufficient — every downstream --loop gate
# branches on MODE, so an alias expansion that leaves MODE=default makes
# `--auto --loop` refuse instead of starting the auto loop.
resolve_auto() {
  local verb="$1"
  local ARGUMENTS="$2"
  local MSG=""
  local MODE="default"

  # Pre-rewrite MODE parse — mirrors the SKILL.md Step 0 ordering that made
  # this bug possible (MODE resolved from the raw args, before alias expansion).
  if [[ "$ARGUMENTS" =~ (^|[[:space:]])--mode[[:space:]]+([a-z-]+) ]]; then
    MODE="${BASH_REMATCH[2]}"
  fi

  # Refusal targets
  case "$verb" in
    form|catch-up|setup)
      if [[ "$ARGUMENTS" =~ (^|[[:space:]])--auto([[:space:]]|$) ]]; then
        MSG="$CANONICAL_REFUSAL"
        printf 'ARGUMENTS=%s\nMODE=%s\nMSG=%s\n' "$ARGUMENTS" "$MODE" "$MSG"
        return
      fi
      ;;
  esac

  # Alias-table verbs
  if [[ "$ARGUMENTS" =~ (^|[[:space:]])--auto([[:space:]]|$) ]]; then
    # Conflict: --auto + explicit --mode
    if [[ "$ARGUMENTS" =~ (^|[[:space:]])--mode[[:space:]] ]]; then
      MSG="--auto cannot be combined with explicit --mode; pick one."
      printf 'ARGUMENTS=%s\nMODE=%s\nMSG=%s\n' "$ARGUMENTS" "$MODE" "$MSG"
      return
    fi

    # Strip --auto token
    local stripped
    stripped="$(printf '%s' "$ARGUMENTS" | sed -E 's/(^|[[:space:]])--auto([[:space:]]|$)/\1/g' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"

    # Prepend resolved mode per alias table AND re-resolve MODE (auto-alias.md
    # § Step-0 stanza: the `MODE=<RESOLVED_MODE>` line).
    case "$verb" in
      research|plan|impl|hero)
        ARGUMENTS="--mode auto${stripped:+ ${stripped}}"
        MODE="auto"
        ;;
      caretake)
        ARGUMENTS="--mode triage${stripped:+ ${stripped}}"
        MODE="triage"
        ;;
      review)
        # No mode prepend; default is already autonomous
        ARGUMENTS="${stripped}"
        ;;
    esac
  fi

  printf 'ARGUMENTS=%s\nMODE=%s\nMSG=%s\n' "$ARGUMENTS" "$MODE" "$MSG"
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

# 10-12. Refusal verbs emit the CANONICAL refusal VERBATIM. Asserted against the
# string extracted from auto-alias.md, not a loose substring — a substring match
# is exactly what let the fixture drift to a stale § heading while staying green.
for verb in form catch-up setup; do
  out=$(resolve_auto "$verb" "--auto")
  msg=$(get_field MSG "$out")
  if [[ "$msg" == "$CANONICAL_REFUSAL" ]]; then
    ok "--auto ($verb) → canonical refusal message, verbatim"
  else
    fail "--auto $verb" "$CANONICAL_REFUSAL" "msg='$msg'"
  fi
done

# 12b. The canonical refusal must point at a § heading that actually exists in
# ralph/CLAUDE.md — the stale fixture named "§ Loop and --auto suitability
# matrix", which is not a heading in that file.
CLAUDE_MD="$(cd "$(dirname "$0")/../../.." && pwd)/CLAUDE.md"
matched_heading=""
while IFS= read -r heading; do
  [[ -z "$heading" ]] && continue
  if [[ "$CANONICAL_REFUSAL" == *"§ ${heading}"* ]]; then
    matched_heading="$heading"
    break
  fi
done < <(sed -n 's/^#\{1,\} \(.*[^[:space:]]\)[[:space:]]*$/\1/p' "$CLAUDE_MD")
if [[ -n "$matched_heading" ]]; then
  ok "refusal cross-ref '§ ${matched_heading}' resolves to a real heading in ralph/CLAUDE.md"
else
  fail "refusal cross-ref resolves" "a '§ <heading>' naming a real heading in $CLAUDE_MD" "refusal='$CANONICAL_REFUSAL'"
fi

# 12c. auto-alias.md claims to be the "sole source of truth ... an alias change
# here cannot silently de-sync six files". That claim is only true if no OTHER
# file under ralph/skills/ carries its own copy of the refusal line. Three
# SKILL.md files did, and they kept emitting a § heading that had been renamed
# out of ralph/CLAUDE.md — the refusal users actually saw pointed at nothing.
# Assert the invariant directly: every `--auto is not supported...` line under
# ralph/skills/ must be byte-identical to the canonical one in auto-alias.md.
SKILLS_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
divergent=""
while IFS= read -r hit; do
  [[ -z "$hit" ]] && continue
  hit_file="${hit%%:*}"
  hit_line="${hit#*:}"
  hit_line="${hit_line#*:}"
  [[ "$hit_file" == "$ALIAS_DOC" ]] && continue
  if [[ "$hit_line" != "$CANONICAL_REFUSAL" ]]; then
    divergent+="${hit_file}: ${hit_line}"$'\n'
  fi
done < <(grep -rn '^--auto is not supported for this verb' "$SKILLS_ROOT" 2>/dev/null)
if [[ -z "$divergent" ]]; then
  ok "no file under ralph/skills/ holds a divergent copy of the --auto refusal"
else
  fail "no divergent --auto refusal copies under ralph/skills/" \
    "every copy byte-identical to auto-alias.md's" "$divergent"
fi

# 12d. Conflict detection makes `--auto` + an explicit `--mode` a hard refusal,
# so any skill prose that DISPATCHES that combination is emitting a guaranteed
# no-op. hero/dispatch.md and hero/state-machine.md both shipped
# `/ralph:plan --auto --mode epic`, which the plan skill refuses on sight.
conflicting=$(grep -rn -- '--auto[[:space:]]\+--mode\|--mode[[:space:]]\+[a-z]\+[[:space:]]\+--auto' \
  "$SKILLS_ROOT" 2>/dev/null | grep -v '/__tests__/' || true)
if [[ -z "$conflicting" ]]; then
  ok "no skill prose dispatches the refused --auto + explicit --mode combination"
else
  fail "no --auto + --mode dispatches in skill prose" "no matches outside __tests__" "$conflicting"
fi

# 13. MODE is re-resolved by the alias expansion (NOT left at its pre-rewrite
# value). This is the `--auto --loop` bug: MODE parsed before the rewrite stays
# `default`, so the --loop gate refuses instead of entering the auto loop.
for verb in research plan impl hero; do
  out=$(resolve_auto "$verb" "--auto --loop")
  mode=$(get_field MODE "$out")
  if [[ "$mode" == "auto" ]]; then
    ok "--auto --loop ($verb) → MODE=auto (loop gate reaches the auto branch)"
  else
    fail "--auto --loop $verb MODE" "auto" "mode='$mode'"
  fi
done
out=$(resolve_auto caretake "--auto --loop")
mode=$(get_field MODE "$out")
if [[ "$mode" == "triage" ]]; then
  ok "--auto --loop (caretake) → MODE=triage (caretake:triage manifest row)"
else
  fail "--auto --loop caretake MODE" "triage" "mode='$mode'"
fi
# review has no mode prepend — its default mode is already the autonomous
# drainer, so MODE legitimately stays `default`.
out=$(resolve_auto review "--auto --loop")
mode=$(get_field MODE "$out")
if [[ "$mode" == "default" ]]; then
  ok "--auto --loop (review) → MODE=default (default mode is already autonomous)"
else
  fail "--auto --loop review MODE" "default" "mode='$mode'"
fi

# ── summary ────────────────────────────────────────────────────────────────────

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
if [[ "$FAIL" -eq 0 ]]; then
  exit 0
else
  exit 1
fi
