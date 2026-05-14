#!/usr/bin/env bash
# lint-escalation-contract.sh — verify escalating skills produce a canonical
# `## Escalation` comment so the unblock chain (GH-1247) can discover them.
#
# Background
#   `ralph-unblock` (producer) and `/ralph-hero:unblock` (consumer) discover
#   Human Needed work by searching for a `## Escalation` comment header on
#   the issue. When a skill transitions an issue to Human Needed (via the
#   `__ESCALATE__` semantic intent) it MUST also post a canonical
#   `## Escalation` comment — either inline in the skill body or by
#   including the shared `escalation-steps.md` fragment that posts it.
#
# Heuristic
#   For every `plugin/ralph-hero/skills/<name>/SKILL.md` that mentions
#   `__ESCALATE__`, require one of:
#     (a) the file contains the literal markdown header `## Escalation`
#         (i.e., it posts the comment inline), OR
#     (b) the file `!cat`-includes `shared/fragments/escalation-steps.md`
#         (the canonical inclusion path used by ralph-impl, ralph-plan,
#          ralph-research, ralph-review, ralph-split, ralph-triage,
#          ralph-plan-epic).
#
# Scope
#   This lint is advisory — failing it means a skill is escalating without
#   canonical context (a hygiene issue, not a runtime correctness issue,
#   because `ralph-unblock` has a fallback path that reads the issue body).
#   Catching the drift at PR time keeps the unblock chain rich.
#
# Exit codes
#   0   all escalating skills produce `## Escalation` (inline or via fragment)
#   1   one or more escalating skills are missing the canonical comment
#   2   usage error (wrong invocation, repo layout unrecognized)
#
# Run from anywhere — the script resolves paths relative to its own
# location so CI and local invocations both work.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_DIR="$(cd "$SCRIPT_DIR/../skills" && pwd)"

if [[ ! -d "$SKILLS_DIR" ]]; then
  echo "lint-escalation-contract: cannot locate skills directory at $SKILLS_DIR" >&2
  exit 2
fi

FRAGMENT_REL="shared/fragments/escalation-steps.md"
FRAGMENT_ABS="$SKILLS_DIR/$FRAGMENT_REL"

if [[ ! -f "$FRAGMENT_ABS" ]]; then
  echo "lint-escalation-contract: canonical fragment missing at $FRAGMENT_ABS" >&2
  exit 2
fi

missing=()
checked=0

# Iterate every SKILL.md under skills/ (skip the shared/ tree itself —
# fragments aren't skills, they're includes).
while IFS= read -r -d '' skill_file; do
  # Skip files inside the shared/ helper tree.
  case "$skill_file" in
    *"/skills/shared/"*) continue ;;
  esac

  # Only consider files that actually escalate.
  if ! grep -q '__ESCALATE__' "$skill_file"; then
    continue
  fi

  checked=$((checked + 1))

  has_inline_header=0
  has_fragment_include=0

  # (a) Inline canonical header — must appear at the start of a line and
  # be exactly `## Escalation` (no trailing words). That excludes prose
  # mentions like "the `## Escalation` comment" and documentation section
  # titles like `## Escalation Protocol`, while still matching the literal
  # comment body posted to GitHub.
  if grep -qE '^## Escalation[[:space:]]*$' "$skill_file"; then
    has_inline_header=1
  fi

  # (b) Shared fragment include via the `!cat ... escalation-steps.md`
  # idiom used by every other escalating skill.
  if grep -qE '!cat[[:space:]].*escalation-steps\.md' "$skill_file"; then
    has_fragment_include=1
  fi

  if (( has_inline_header == 0 && has_fragment_include == 0 )); then
    rel="${skill_file#"$SKILLS_DIR/"}"
    missing+=("$rel")
  fi
done < <(find "$SKILLS_DIR" -type f -name 'SKILL.md' -print0)

if (( ${#missing[@]} > 0 )); then
  {
    echo "lint-escalation-contract: FAIL"
    echo ""
    echo "The following skills use __ESCALATE__ but do not produce a"
    echo "canonical \`## Escalation\` comment (inline header or shared"
    echo "fragment include). The unblock chain (GH-1247) needs this header"
    echo "to discover Human Needed work."
    echo ""
    for rel in "${missing[@]}"; do
      echo "  - $rel"
    done
    echo ""
    echo "Fix: either"
    echo "  (a) post a \`## Escalation\` comment inline with the canonical"
    echo "      body (see plugin/ralph-hero/skills/ralph-code-review/SKILL.md"
    echo "      for an example), or"
    echo "  (b) include the shared fragment by adding:"
    echo "        !cat \${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/escalation-steps.md"
    echo "      under the skill's \"Escalation Protocol\" section."
  } >&2
  exit 1
fi

echo "lint-escalation-contract: OK (${checked} escalating skill(s) checked)"
exit 0
