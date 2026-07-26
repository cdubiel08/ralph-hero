#!/bin/bash
# Deterministic changed-file → review-class mapping (GH-1589).
#
# Usage:
#   ./scripts/pr-file-classes.sh --pr PR_NUMBER     # classes for a PR's diff
#   ./scripts/pr-file-classes.sh path [path ...]    # classes for given paths
#
# Output: sorted unique class names, one per line.
#
# Single source of truth for the class taxonomy — consumed by
# scripts/attest-pr.sh (declare what was reviewed) and
# .github/workflows/validate-attestation.yml (recompute from the diff and
# fail attestations that under-declare coverage). The review skill selects
# one adversarial reviewer per class present, plus the unconditional
# security floor (see ralph/skills/review/merge-gate.md).
#
# Precedence (first match wins):
#   deps         — lockfiles + package manifests, any directory
#   ci-workflows — .github/**
#   mcp-ts       — mcp-server/**
#   knowledge-ts — plugin/ralph-knowledge/**
#   hooks-shell  — ralph/hooks/**
#   scripts-shell— scripts/**
#   skills-prose — ralph/skills/**, docs/**, thoughts/**, any *.md
#   other        — everything else

set -euo pipefail

classify() { # classify <path> → echoes one class
  local p="$1" base
  base=$(basename "$p")
  case "$base" in
    package-lock.json|pnpm-lock.yaml|yarn.lock|uv.lock|package.json|Cargo.lock|Cargo.toml)
      echo "deps"; return ;;
  esac
  case "$p" in
    .github/*)                 echo "ci-workflows" ;;
    mcp-server/*)              echo "mcp-ts" ;;
    plugin/ralph-knowledge/*)  echo "knowledge-ts" ;;
    ralph/hooks/*)             echo "hooks-shell" ;;
    scripts/*)                 echo "scripts-shell" ;;
    ralph/skills/*|docs/*|thoughts/*|*.md)
                               echo "skills-prose" ;;
    *)                         echo "other" ;;
  esac
}

paths=()
if [[ "${1:-}" == "--pr" ]]; then
  PR_NUMBER="${2:?Usage: $0 --pr PR_NUMBER}"
  while IFS= read -r line; do
    [[ -n "$line" ]] && paths+=("$line")
  done < <(gh pr view "$PR_NUMBER" --json files --jq '.files[].path')
else
  paths=("$@")
fi

if [[ ${#paths[@]} -eq 0 ]]; then
  exit 0
fi

for p in "${paths[@]}"; do
  classify "$p"
done | sort -u
