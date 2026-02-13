#!/bin/bash
# ralph-hero/hooks/scripts/post-git-validator.sh
# PostToolUse: Verify git operations completed successfully
#
# Monitors:
#   - git push (check for conflicts, provide rebase guidance)
#   - git commit (verify commit created)

set -e

INPUT=$(cat)

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // "unknown"')

if [[ "$TOOL_NAME" != "Bash" ]]; then
  exit 0
fi

COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // ""')
STDOUT=$(echo "$INPUT" | jq -r '.tool_response.stdout // ""')
STDERR=$(echo "$INPUT" | jq -r '.tool_response.stderr // ""')
EXIT_CODE=$(echo "$INPUT" | jq -r '.tool_response.exitCode // 0')

if [[ "$COMMAND" =~ git\ push ]]; then
  if [[ "$EXIT_CODE" != "0" ]]; then
    if [[ "$STDERR" =~ "non-fast-forward" ]] || [[ "$STDERR" =~ "rejected" ]]; then
      cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "GIT PUSH CONFLICT DETECTED\n\nThe remote has changes not in your local branch.\n\nRECOVERY STEPS:\n1. Pull with rebase: git pull --rebase origin [branch]\n2. Resolve any conflicts if prompted\n3. Retry push: git push origin [branch]\n\nDo NOT use --force unless explicitly instructed."
  }
}
EOF
    else
      cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "GIT PUSH FAILED\n\nError: $STDERR\n\nCheck:\n1. Network connectivity\n2. Authentication (gh auth status)\n3. Branch protection rules"
  }
}
EOF
    fi
    exit 0
  fi

  cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "Git push successful. Changes are now on remote."
  }
}
EOF
  exit 0
fi

if [[ "$COMMAND" =~ git\ commit ]]; then
  if [[ "$EXIT_CODE" != "0" ]]; then
    if [[ "$STDERR" =~ "nothing to commit" ]]; then
      cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "NO CHANGES TO COMMIT\n\nThe working directory is clean. This could mean:\n1. Changes were already committed\n2. Files were not staged (run: git add)\n3. The edit didn't actually change the file"
  }
}
EOF
    elif [[ "$STDERR" =~ "pre-commit hook" ]]; then
      cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "PRE-COMMIT HOOK FAILED\n\nA pre-commit hook blocked the commit.\n\nCheck the output for:\n1. Linting errors (fix with: pnpm lint --fix)\n2. Type errors (fix with: pnpm type-check)\n3. Test failures (run: pnpm test)\n\nFix the issues and commit again."
  }
}
EOF
    fi
    exit 0
  fi

  COMMIT_HASH=$(echo "$STDOUT" | grep -oE '[a-f0-9]{7,40}' | head -1)
  cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "Git commit successful. Commit: ${COMMIT_HASH:-unknown}\n\nNext: Push to remote with: git push"
  }
}
EOF
  exit 0
fi

exit 0
