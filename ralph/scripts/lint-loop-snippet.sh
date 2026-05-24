#!/usr/bin/env bash
# lint-loop-snippet.sh — Extract and syntax-check the bash arg-parsing snippet
# from ralph/skills/shared/loop-wrapper.md.
#
# Usage: bash ralph/scripts/lint-loop-snippet.sh
# Exits 0 on success, non-zero if the snippet has a syntax error or cannot be found.

set -euo pipefail

WRAPPER_MD="$(dirname "$0")/../skills/shared/loop-wrapper.md"

if [[ ! -f "$WRAPPER_MD" ]]; then
  echo "ERROR: loop-wrapper.md not found at: $WRAPPER_MD" >&2
  exit 1
fi

# Extract the bash block immediately following "## Arg-parsing snippet".
# Strategy: find the heading line, skip to the opening ```bash fence,
# collect lines until the closing ``` fence, write to a temp file.

TMPFILE="$(mktemp /tmp/lint-loop-snippet.XXXXXX.sh)"
trap 'rm -f "$TMPFILE"' EXIT

in_target_section=0
in_code_block=0

while IFS= read -r line; do
  if [[ "$line" == "## Arg-parsing snippet" ]]; then
    in_target_section=1
    continue
  fi

  # Stop scanning if we hit the next top-level section.
  if [[ "$in_target_section" -eq 1 && "$line" =~ ^##[[:space:]] && "$line" != "## Arg-parsing snippet" ]]; then
    break
  fi

  if [[ "$in_target_section" -eq 1 ]]; then
    if [[ "$in_code_block" -eq 0 && "$line" == '```bash' ]]; then
      in_code_block=1
      continue
    fi
    if [[ "$in_code_block" -eq 1 && "$line" == '```' ]]; then
      break
    fi
    if [[ "$in_code_block" -eq 1 ]]; then
      echo "$line" >> "$TMPFILE"
    fi
  fi
done < "$WRAPPER_MD"

if [[ ! -s "$TMPFILE" ]]; then
  echo "ERROR: could not extract bash snippet from ## Arg-parsing snippet section." >&2
  exit 1
fi

echo "Extracted snippet ($(wc -l < "$TMPFILE") lines). Running bash -n syntax check..."

if bash -n "$TMPFILE"; then
  echo "OK: snippet passed bash -n syntax check."
  exit 0
else
  echo "FAIL: snippet has a bash syntax error. See above for details." >&2
  exit 1
fi
