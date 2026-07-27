#!/usr/bin/env bash
# loop-refusal.test.sh — Verify refusal-message template and unsuitable-mode coverage
# Usage: bash ralph/skills/shared/__tests__/loop-refusal.test.sh
# Exit 0 = all pass; exit 1 = at least one failure.
#
# Does NOT invoke skills — parses loop-wrapper.md, auto-alias.md, and ralph/CLAUDE.md.
# Validates:
#   1. The --loop refusal message in loop-wrapper.md renders as a single line.
#   2. The unsuitable-mode list now lives in loop-wrapper.md's own
#      `## Unsuitable surfaces` section (GH-1607 retargeted this off
#      ralph/CLAUDE.md, which collapsed its 40-row matrix to a
#      `## Loop suitability` pointer section). Covers every entry in the
#      plan's Current-State unsuitable table:
#        form, plan (default/iterate/epic), impl (default/address),
#        research (default), catch-up (default),
#        setup, hero (pr-drain), caretake (reflect), caretake (unblock --question)
#   3. ralph/CLAUDE.md still carries the `## Loop suitability` heading the
#      canonical refusal string points at (so the pointer resolves).

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

# ── 4. loop-wrapper.md § Unsuitable surfaces covers the interactive/one-shot list ──
# GH-1607 moved the unsuitable-mode list off ralph/CLAUDE.md's 40-row matrix
# (now a `## Loop suitability` pointer section) into loop-wrapper.md's own
# `## Unsuitable surfaces` section — that section is now the canonical source.
# Parse it to confirm every unsuitable surface from the plan is still covered.

if [[ -f "$RALPH_CLAUDE" ]]; then
  ok "ralph/CLAUDE.md exists"
else
  fail "ralph/CLAUDE.md exists" "file present" "not found at ${RALPH_CLAUDE}"
fi

# The canonical refusal string points at "ralph/CLAUDE.md § Loop suitability" —
# verify that heading still exists so the pointer resolves.
if grep -q '^## Loop suitability' "$RALPH_CLAUDE"; then
  ok "ralph/CLAUDE.md has ## Loop suitability heading (refusal-string target resolves)"
else
  fail "## Loop suitability heading in ralph/CLAUDE.md" "≥1 match" "0 matches"
fi

unsuitable_block=$(awk '/^## Unsuitable surfaces/{f=1;next} f&&/^## /{exit} f' "$LOOP_WRAPPER")

if [[ -n "$unsuitable_block" ]]; then
  ok "loop-wrapper.md has non-empty ## Unsuitable surfaces section"
else
  fail "## Unsuitable surfaces section in loop-wrapper.md" "non-empty section" "empty or not found"
fi

# Each entry: label | grep pattern to search within the extracted section
check_unsuitable() {
  local label="$1"
  local pattern="$2"
  if printf '%s' "$unsuitable_block" | grep -qE "$pattern"; then
    ok "unsuitable surface documented in loop-wrapper.md: ${label}"
  else
    fail "unsuitable surface in loop-wrapper.md: ${label}" \
      "pattern '${pattern}' found" \
      "not found"
  fi
}

# Plan's Current-State unsuitable table (§ Where looping is meaningless):
check_unsuitable "form"                         "form"
check_unsuitable "plan default"                 "plan.*default|\`plan\` default"
check_unsuitable "plan iterate"                 "iterate"
check_unsuitable "plan epic"                    "epic"
check_unsuitable "impl default"                 "impl.*default|\`impl\` default"
check_unsuitable "impl address"                 "address"
check_unsuitable "research default"             "research.*default|\`research\` default"
check_unsuitable "catch-up default"             "catch-up"
check_unsuitable "setup"                        "setup"
check_unsuitable "hero default"                 "hero.*default|\`hero\` default"
check_unsuitable "hero pr-drain"                "pr-drain"
check_unsuitable "caretake reflect"             "reflect"
check_unsuitable "caretake unblock --question"  "unblock.*question|--question"
check_unsuitable "caretake enrich"              "enrich"

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
