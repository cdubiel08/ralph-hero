#!/bin/bash
# ralph-hero/hooks/scripts/gitignore-enforcement.sh
# PreToolUse (Write): Block creation of local-only files not covered by .gitignore
#
# Checks if the Write target matches known local-only file patterns
# (*.local.md, *.local.json, .env, .env.*) and verifies the path is
# covered by .gitignore. Blocks with an actionable message if not.
#
# Exit codes:
#   0 - Allowed (not a local-only pattern, or pattern is gitignored)
#   2 - Blocked (local-only file not covered by .gitignore)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/hook-utils.sh"

read_input > /dev/null

file_path=$(get_field '.tool_input.file_path')

# If no file_path, nothing to check
if [[ -z "$file_path" ]]; then
  allow
fi

# Extract just the filename component for pattern matching
filename=$(basename "$file_path")

# Check if filename matches any local-only pattern
gitignore_entry=""
case "$filename" in
  *.local.md)
    gitignore_entry="*.local.md"
    ;;
  *.local.json)
    gitignore_entry="*.local.json"
    ;;
  .env)
    gitignore_entry=".env"
    ;;
  .env.*)
    gitignore_entry=".env.*"
    ;;
  *)
    # Not a local-only pattern, allow
    allow
    ;;
esac

# File matches a local-only pattern -- verify it is covered by .gitignore
# Use --no-index to check gitignore rules regardless of whether the file
# is already tracked (a tracked file that IS in .gitignore just needs to
# be untracked; the protection layer is still present).
project_dir=$(get_project_root)

if cd "$project_dir" && git check-ignore --no-index -q "$file_path" 2>/dev/null; then
  # File IS covered by .gitignore -- safe to write
  allow
fi

# File is NOT covered by .gitignore -- block the write
block "Write blocked: local-only file not protected by .gitignore

File: $file_path
Pattern: $gitignore_entry

This file matches a local-only pattern that may contain secrets or
machine-specific configuration. It must be covered by .gitignore
before it can be created.

To fix, add this entry to the project root .gitignore:
  $gitignore_entry

Then retry the write. This prevents accidental commits of sensitive
files like tokens, PATs, or local configuration."
