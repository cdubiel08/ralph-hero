#!/bin/bash
# Host-key pinning hygiene for the release workflows (GH-1770).
#
# Usage: ./scripts/check-host-key-pinning.sh [WORKFLOW_DIR]
#        WORKFLOW_DIR defaults to .github/workflows
#
# `ssh-keyscan` accepts whatever key answers, so it authenticates nothing. In
# the release workflows it guarded the push that carries RELEASE_DEPLOY_KEY —
# the sole ruleset-bypass actor on protected main — which made it a MITM
# window on the one credential that can write to main unreviewed.
#
# That weakness has been fixed twice, in two files, by two PRs:
#
#   PR #1740 (306c13de) — release-knowledge.yml
#   PR #1767 (GH-1765)  — release-ralph.yml, which missed the first port
#
# Two occurrences of the same defect means the fix was a convention held in
# reviewers' heads. This turns the third recurrence into a red check.
#
# COMMENT LINES ARE EXCLUDED ON PURPOSE. Both release workflows explain the
# hazard in prose beside the pinned key, and that prose is what keeps the fix
# understood — a guard that forbade the word would delete its own rationale.
# The rule is therefore about executable lines, not mentions.
#
# The scan is deliberately scoped to WORKFLOW_DIR, which is why this lives in
# scripts/ rather than inline in ci.yml: a guard whose own source is in scope
# matches itself. ci.yml can still discuss the hazard, in comments.
#
# Output contract:
#   HOST KEY PINNING PASS — ...   [0]
#   HOST KEY PINNING FAIL — ...   [1]
#   usage/environment error       [2]

set -euo pipefail

WORKFLOW_DIR="${1:-.github/workflows}"

if [ ! -d "$WORKFLOW_DIR" ]; then
  echo "HOST KEY PINNING ERROR — not a directory: $WORKFLOW_DIR" >&2
  exit 2
fi

# A hit is `path:lineno:text`. The filter drops lines whose first non-space
# character after the line number is `#`, i.e. whole-line comments. A trailing
# comment on a real command still counts as executable, which is the
# conservative direction.
#
# grep's three exit codes must be told apart, and conflating any two of them
# breaks the guard in a different direction:
#
#   0  matches found        -> candidate hits, keep filtering
#   1  no matches           -> the PASSING case
#   2+ the scan itself failed (unreadable file, bad path)
#
# Swallowing 1 with a bare `set -e` fails CLOSED on a clean tree: the guard
# would redden every PR. Swallowing 2 as if it were 1 fails OPEN, which is
# worse — an unreadable workflow carrying a live ssh-keyscan would be reported
# as clean. A guard that cannot read the tree does not know the tree is safe,
# so an unreadable file is an error, never a pass.
scan_status=0
raw="$(grep -rn 'ssh-keyscan' "$WORKFLOW_DIR")" || scan_status=$?
if [ "$scan_status" -gt 1 ]; then
  echo "HOST KEY PINNING ERROR — could not scan $WORKFLOW_DIR (grep exit $scan_status)" >&2
  exit 2
fi

# Guard the empty case explicitly: `printf '%s\n' ""` emits a blank line, and
# a blank line survives the comment filter, so piping an empty scan onward
# would manufacture a phantom hit and fail a clean tree.
hits=''
if [ -n "$raw" ]; then
  filter_status=0
  hits="$(printf '%s\n' "$raw" |
    grep -v '^[^:]*:[0-9][0-9]*:[[:space:]]*#')" || filter_status=$?
  if [ "$filter_status" -gt 1 ]; then
    echo "HOST KEY PINNING ERROR — comment filter failed (grep exit $filter_status)" >&2
    exit 2
  fi
fi

if [ -n "$hits" ]; then
  echo "HOST KEY PINNING FAIL — executable ssh-keyscan under $WORKFLOW_DIR"
  echo
  printf '%s\n' "$hits"
  cat <<'HELP'

ssh-keyscan trusts whatever key answers, so it authenticates nothing.
Pin GitHub's published Ed25519 host key instead, as release-ralph.yml
and release-knowledge.yml both do:

    printf 'github.com ssh-ed25519 %s\n' \
      'AAAAC3NzaC1lZDI1NTE5AAAA...' \
      >> "$HOME/.ssh/known_hosts"

Source of truth: the .ssh_keys array of https://api.github.com/meta
HELP
  exit 1
fi

echo "HOST KEY PINNING PASS — no executable ssh-keyscan under $WORKFLOW_DIR"
