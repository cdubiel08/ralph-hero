#!/bin/bash
# ralph-hero/hooks/scripts/doc-structure-validator.sh
# Stop: Validate required sections in documents created during the skill session
#
# Exit codes:
#   0 - Structure valid or no session-written document found
#   2 - Missing required sections, block

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

read_input > /dev/null

today=$(date +%Y-%m-%d)

# Session-scoped discovery: validate ONLY docs this session actually wrote,
# as recorded by artifact-write-tracker.sh (PostToolUse on Write|Edit).
# The previous heuristic — freshest today-dated doc by mtime across the
# three artifact dirs — raced against concurrent sessions sharing
# thoughts/shared/ and once blocked a Stop on ANOTHER session's in-progress
# doc (2026-07-04 incident). No session-written doc → allow; the
# postcondition hooks own "artifact missing" enforcement.
#
# Validator branch is still discriminated by file PATH, not RALPH_COMMAND
# env: the multi-mode verbs (e.g. /ralph:plan --mode review) can't reliably
# flip RALPH_COMMAND mid-session because Bash-tool exports don't propagate
# to hook subprocesses. A doc under thoughts/shared/plans/ is a plan doc
# regardless of the active mode.
#
# Only today-prefixed docs are validated: iterate-style edits to older docs
# must not retroactively enforce current structure rules on legacy files.

errors=()
validated=()

validate_doc() {
  local doc="$1" command="$2"
  local doc_errors=()

  case "$command" in
    research)
      # Section names match ralph/skills/research/findings-format.md § Section order.
      grep -qiE "^## (Prior Work|Research Question)" "$doc" || doc_errors+=("Missing: '## Prior Work' or '## Research Question' header")
      grep -qiE "^## (Summary|Detailed Findings)" "$doc" || doc_errors+=("Missing: '## Summary' or '## Detailed Findings' header")
      grep -qiE "^## Files Affected" "$doc" || doc_errors+=("Missing: '## Files Affected' header (required by --mode auto per findings-format.md)")
      grep -qE '`[^`]+`' "$doc" || doc_errors+=("Missing: backtick-wrapped file paths (e.g., \`src/file.ts\`) — referenced findings should use code-spans")
      ;;
    plan)
      # Plan-of-plans (epic shape) vs regular plan: self-discriminate by shape, the
      # same way plan-tier-validator.sh does. Strip fenced code blocks first so a
      # doc that documents the sibling shape in a fenced example does not
      # false-positive on EITHER discriminator — both the frontmatter `type:` grep
      # and the '## Feature Decomposition' grep run on the fence-stripped body
      # (real frontmatter lives above any fence, so it survives the strip).
      # Fence semantics (CommonMark-ish): fences may be indented, and a
      # fenced block only closes on a fence at least as long as its opener —
      # so a bare ``` inside a ````-fenced example stays content, and
      # list-indented fenced examples are stripped too.
      local plan_body
      plan_body=$(awk '
        /^[[:space:]]*```/ {
          match($0, /`+/); len = RLENGTH
          if (!f) { f = 1; open = len }
          else if (len >= open) { f = 0 }
          next
        }
        !f { print }' "$doc")
      if grep -qE "^type:[[:space:]]*plan-of-plans" <<< "$plan_body" \
         || grep -qE "^## Feature Decomposition([[:space:]]|$)" <<< "$plan_body"; then
        # Plan-of-plans shape — sections per ralph/skills/plan/decomposition.md § Plan-of-plans shape.
        grep -qE "^## Feature Decomposition([[:space:]]|$)" <<< "$plan_body" || doc_errors+=("Missing: '## Feature Decomposition' section (plan-of-plans shape)")
        grep -qE "^## Feature Sequencing([[:space:]]|$)" <<< "$plan_body" || doc_errors+=("Missing: '## Feature Sequencing' section (plan-of-plans shape)")
      else
        # Regular plan shape. Section names match ralph/skills/plan/plan-shapes.md § Section order.
        grep -qE "^## Phase [0-9]" "$doc" || doc_errors+=("Missing: '## Phase N:' header pattern (e.g., '## Phase 1: ...')")
        grep -qE "^#### (Automated|Manual) Verification" "$doc" || doc_errors+=("Missing: '#### Automated Verification' or '#### Manual Verification' subsections")
        grep -qE "^- \[ \]" "$doc" || doc_errors+=("Missing: success-criteria checkboxes '- [ ] ...'")
      fi
      # Decisions contract (GH-1544) — both plan shapes, fence-stripped body so
      # docs that show the format in fenced examples don't false-positive.
      # The block/sentinel check is scoped to the section itself (sentinel
      # text quoted elsewhere in the doc must not satisfy it), and the
      # sentinel tolerates dash variants (em/en/hyphen) and spacing.
      if ! grep -qE "^## Design Decisions" <<< "$plan_body"; then
        doc_errors+=("Missing: '## Design Decisions & Open Ambiguities' section (see plan-shapes.md § Design decisions anatomy)")
      else
        local decisions_section
        decisions_section=$(printf '%s\n' "$plan_body" | awk '/^## Design Decisions/ { f = 1; next } /^## / { f = 0 } f { print }')
        if ! grep -qE "^#### Decision:" <<< "$decisions_section" \
           && ! grep -qiE "None[[:space:]]*(—|–|-)[[:space:]]*no open design decisions\." <<< "$decisions_section"; then
          doc_errors+=("Missing: decisions section needs either a '#### Decision:' block or the sentinel 'None — no open design decisions.' inside the section itself (see plan-shapes.md § Design decisions anatomy)")
        fi
      fi
      ;;
    review)
      grep -qE "APPROVED|NEEDS_ITERATION" "$doc" || doc_errors+=("Missing: Verdict (APPROVED or NEEDS_ITERATION)")
      ;;
  esac

  if [[ ${#doc_errors[@]} -gt 0 ]]; then
    errors+=("$doc:")
    local e
    for e in "${doc_errors[@]}"; do
      errors+=("  $e")
    done
  else
    validated+=("$doc")
  fi
}

while IFS= read -r doc; do
  [[ -n "$doc" ]] || continue
  # Today-prefixed filenames only (see header comment).
  base=$(basename "$doc")
  [[ "$base" == "${today}-"* ]] || continue

  case "$doc" in
    *thoughts/shared/plans/*)    validate_doc "$doc" "plan" ;;
    *thoughts/shared/reviews/*)  validate_doc "$doc" "review" ;;
    *thoughts/shared/research/*) validate_doc "$doc" "research" ;;
  esac
done < <(session_artifacts "thoughts/shared/" | sort -u)

if [[ ${#errors[@]} -gt 0 ]]; then
  error_list=$(printf '%s\n' "${errors[@]}")
  block "Document structure validation failed

Missing required sections:
$error_list

Fix the document(s) to include all required sections before the skill can complete."
fi

if [[ ${#validated[@]} -gt 0 ]]; then
  echo "Document structure validated: ${validated[*]}"
fi
allow
