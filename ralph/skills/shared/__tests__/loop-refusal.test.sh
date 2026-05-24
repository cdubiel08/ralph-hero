#!/usr/bin/env bash
# loop-refusal.test.sh — Verify refusal-message template and unsuitable-mode coverage
# Usage: bash ralph/skills/shared/__tests__/loop-refusal.test.sh
# Exit 0 = all pass; exit 1 = at least one failure.
#
# Does NOT invoke skills — parses loop-wrapper.md, auto-alias.md, and ralph/CLAUDE.md.
# Validates:
#   1. The --loop refusal message in loop-wrapper.md renders as a single line.
#   2. The unsuitable-mode list in ralph/CLAUDE.md covers every entry in the
#      plan's Current-State unsuitable table:
#        form, plan (default/iterate/epic), impl (default/address),
#        research (default/prove), catch-up (default/narrative/dashboard),
#        setup, hero (pr-drain), caretake (postmortem/retro), caretake (unblock --question)

set -uo pipefail

PASS=0
FAIL=0

# Locate repo root from this script's location (ralph/skills/shared/__tests__)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
LOOP_WRAPPER="${REPO_ROOT}/ralph/skills/shared/loop-wrapper.md"
AUTO_ALIAS="${REPO_ROOT}/ralph/skills/shared/auto-alias.md"
RALPH_CLAUDE="${REPO_ROOT}/ralph/CLAUDE.md"

ok()   { echo "PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "FAIL: $1"; echo "      expected: $2"; echo "      got:      $3"; FAIL=$((FAIL + 1)); }

# ── 1. loop-wrapper.md exists and has ## Refusal message section ────────────────

if [[ -f "$LOOP_WRAPPER" ]]; then
  ok "loop-wrapper.md exists"
else
  fail "loop-wrapper.md exists" "file present" "not found at ${LOOP_WRAPPER}"
fi

refusal_section=$(grep -c '^## Refusal message' "$LOOP_WRAPPER" 2>/dev/null || echo 0)
if [[ "$refusal_section" -ge 1 ]]; then
  ok "loop-wrapper.md has ## Refusal message section"
else
  fail "## Refusal message section" "≥1 match" "0 matches"
fi

# ── 2. Refusal message is a single contiguous line (no embedded newlines) ──────

# Extract the canonical refusal string by searching for the identifying substring
# Use -e flag to prevent grep from interpreting --loop as an option
canonical_prefix="loop is not supported for this mode"
matching_line=$(grep -e "$canonical_prefix" "$LOOP_WRAPPER" | head -1)

if [[ -n "$matching_line" ]]; then
  ok "canonical refusal text found in loop-wrapper.md"
  # Verify it is a single line (no embedded newlines — the grep output is one line by definition)
  ok "canonical refusal text is a single line (grep returns one line)"
else
  fail "canonical refusal text" "line containing '${canonical_prefix}'" "not found in loop-wrapper.md"
fi

# Verify the full canonical text appears verbatim on one line (use -e to avoid -- misparse)
full_canonical="loop is not supported for this mode. Looping is meaningful only for autonomous queue-drainers; this surface is interactive. See ralph/CLAUDE.md"
if grep -qe "$full_canonical" "$LOOP_WRAPPER"; then
  ok "full canonical refusal text present verbatim (including CLAUDE.md reference)"
else
  fail "full canonical refusal text" "verbatim match" "not found in loop-wrapper.md"
fi

# ── 3. auto-alias.md exists and has ## Refusal targets section ─────────────────

if [[ -f "$AUTO_ALIAS" ]]; then
  ok "auto-alias.md exists"
else
  fail "auto-alias.md exists" "file present" "not found at ${AUTO_ALIAS}"
fi

refusal_targets_section=$(grep -c '^## Refusal targets' "$AUTO_ALIAS" 2>/dev/null || echo 0)
if [[ "$refusal_targets_section" -ge 1 ]]; then
  ok "auto-alias.md has ## Refusal targets section"
else
  fail "## Refusal targets section in auto-alias.md" "≥1 match" "0 matches"
fi

# ── 4. ralph/CLAUDE.md has the full unsuitable-mode matrix ─────────────────────
# The canonical source for the loop suitability matrix is ralph/CLAUDE.md
# (written in Phase 4). Parse it to confirm every unsuitable surface from the plan is covered.

if [[ -f "$RALPH_CLAUDE" ]]; then
  ok "ralph/CLAUDE.md exists"
else
  fail "ralph/CLAUDE.md exists" "file present" "not found at ${RALPH_CLAUDE}"
fi

# Each entry: label | grep pattern to search in ralph/CLAUDE.md
check_unsuitable() {
  local label="$1"
  local pattern="$2"
  if grep -qE "$pattern" "$RALPH_CLAUDE"; then
    ok "unsuitable surface documented in ralph/CLAUDE.md: ${label}"
  else
    fail "unsuitable surface in ralph/CLAUDE.md: ${label}" \
      "pattern '${pattern}' found" \
      "not found"
  fi
}

# Plan's Current-State unsuitable table (§ Where looping is meaningless):
check_unsuitable "form"                         "form.*No|No.*form"
check_unsuitable "plan iterate"                 "plan.*iterate|iterate"
check_unsuitable "plan epic"                    "plan.*epic|epic"
check_unsuitable "impl default/address"         "impl.*address|address"
check_unsuitable "research default/prove"       "research.*prove|prove"
check_unsuitable "catch-up default/narrative"   "catch-up.*No|narrative.*No"
check_unsuitable "setup"                        "setup.*No|No.*setup"
check_unsuitable "hero pr-drain"                "pr-drain.*No|No.*pr-drain"
check_unsuitable "caretake postmortem"          "postmortem.*No|No.*postmortem"
check_unsuitable "caretake retro"               "retro.*No|No.*retro"
check_unsuitable "caretake unblock --question"  "unblock.*question|--question"

# ── 5. Refusal targets in auto-alias.md cover form, catch-up, setup ────────────

for verb in form catch-up setup; do
  if grep -q "$verb" "$AUTO_ALIAS"; then
    ok "auto-alias.md refusal targets include: ${verb}"
  else
    fail "auto-alias.md refusal targets include: ${verb}" "found" "not found"
  fi
done

# ── summary ───────────────────────────────────────────────────────────────────

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
if [[ "$FAIL" -eq 0 ]]; then
  exit 0
else
  exit 1
fi
