#!/bin/bash
# ralph/hooks/scripts/postmortem-completeness.sh
# Stop: Validate post-mortem content emitted by /ralph:caretake --mode postmortem.
#
# Reads the artifact path from the RALPH_POSTMORTEM_PATH env var the mode body
# sets directly.
#
#   - Scope-guarded (caretake + postmortem).
#   - grep pipelines append `|| true` so missing-section matches don't crash
#     under set -euo pipefail.
#
# Environment:
#   RALPH_POSTMORTEM_PATH - Absolute path the mode body wrote to
#   RALPH_FORCE_STOP      - If "true", allow stop even if postconditions fail
#
# Exit codes:
#   0 - All required content present (or out of scope, or escape hatch active)
#   2 - Missing required fields/sections, block

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

if [[ "${RALPH_COMMAND:-}" != "caretake" ]]; then
  allow
fi
if [[ "${RALPH_SUBCOMMAND:-}" != "postmortem" ]]; then
  allow
fi

read_input > /dev/null
check_stop_hook_active

if [[ "${RALPH_FORCE_STOP:-}" == "true" ]]; then
  warn "RALPH_FORCE_STOP=true - bypassing postmortem completeness check"
fi

POSTMORTEM="${RALPH_POSTMORTEM_PATH:-}"
if [[ -z "$POSTMORTEM" ]]; then
  # Mode body didn't write a doc — either POSTMORTEM SKIPPED was emitted or
  # the body shortcut without setting the env var. Defer to the terminal-token
  # check; allow here so postcondition checking happens at the token layer.
  allow
fi

if [[ ! -f "$POSTMORTEM" ]]; then
  block "Postmortem completeness: RALPH_POSTMORTEM_PATH points at a non-existent file.

Path: $POSTMORTEM

The mode body set RALPH_POSTMORTEM_PATH but the file is missing — likely a
race or a write failure. Re-run the mode."
fi

# Check required frontmatter fields. The grep | head pipeline appends `|| true`
# so a missing field flows to the array-build path under set -euo pipefail.
MISSING_FIELDS=()
for field in "type:" "status:" "github_issue:"; do
  if ! grep -q "^${field}" "$POSTMORTEM" 2>/dev/null; then
    MISSING_FIELDS+=("$field")
  fi || true
done

# Check required body sections.
MISSING_SECTIONS=()
for section in "## Artifacts" "## Blockers" "## Impediments" "## Issues Processed" "## Worker Summary"; do
  if ! grep -qF "$section" "$POSTMORTEM" 2>/dev/null; then
    MISSING_SECTIONS+=("$section")
  fi || true
done

if [[ ${#MISSING_FIELDS[@]} -gt 0 || ${#MISSING_SECTIONS[@]} -gt 0 ]]; then
  MSG="Post-mortem at ${POSTMORTEM} is incomplete."
  if [[ ${#MISSING_FIELDS[@]} -gt 0 ]]; then
    MSG+=$'\n\n'"Missing frontmatter fields:"
    for f in "${MISSING_FIELDS[@]}"; do
      MSG+=$'\n'"  - ${f}"
    done
  fi
  if [[ ${#MISSING_SECTIONS[@]} -gt 0 ]]; then
    MSG+=$'\n\n'"Missing body sections:"
    for s in "${MISSING_SECTIONS[@]}"; do
      MSG+=$'\n'"  - ${s}"
    done
  fi
  MSG+=$'\n\n'"Regenerate via /ralph:caretake --mode postmortem."
  block "$MSG"
fi

echo "Postmortem completeness passed: $POSTMORTEM"
allow
