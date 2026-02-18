#!/bin/bash
# Integration test: verify memory layer works across pipeline phases
#
# Usage: ./scripts/test-memory-layer.sh <issue-number>
#
# Checks:
# 1. Issue has research comment with ## Research Document header
# 2. Issue has plan comment with ## Implementation Plan header
# 3. Issue has review comment with ## Plan Review header (optional)
# 4. Local files match URLs in comments
# 5. File naming follows convention (YYYY-MM-DD-GH-NNNN-*)
#
# Requires: gh CLI authenticated

set -e

ISSUE_NUMBER="${1:?Usage: $0 ISSUE_NUMBER}"
PROJECT_ROOT=$(git rev-parse --show-toplevel)
PADDED=$(printf '%04d' "$ISSUE_NUMBER")

# Resolve owner/repo from environment or git remote
OWNER="${RALPH_GH_OWNER:-$(gh repo view --json owner -q '.owner.login' 2>/dev/null)}"
REPO="${RALPH_GH_REPO:-$(gh repo view --json name -q '.name' 2>/dev/null)}"

PASS=0
FAIL=0
WARN=0

pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }
warn() { echo "  WARN: $1"; WARN=$((WARN + 1)); }

echo "=== Memory Layer Verification for #$ISSUE_NUMBER ==="
echo "Owner: $OWNER | Repo: $REPO"
echo ""

# --- Check GitHub comments ---
echo "Fetching issue comments from GitHub..."
COMMENTS=$(gh api "repos/$OWNER/$REPO/issues/$ISSUE_NUMBER/comments" --jq '.[].body' 2>/dev/null || echo "")

if [[ -z "$COMMENTS" ]]; then
  warn "Could not fetch comments (gh CLI not authenticated or issue has no comments)"
fi

echo ""
echo "--- GitHub Comment Checks ---"

# Check research document comment
if echo "$COMMENTS" | grep -q "## Research Document"; then
  pass "Found '## Research Document' comment on issue"
else
  fail "No '## Research Document' comment found on issue"
fi

# Check implementation plan comment
if echo "$COMMENTS" | grep -q "## Implementation Plan"; then
  pass "Found '## Implementation Plan' comment on issue"
else
  fail "No '## Implementation Plan' comment found on issue"
fi

# Check plan review comment
if echo "$COMMENTS" | grep -q "## Plan Review"; then
  pass "Found '## Plan Review' comment on issue"
else
  warn "No '## Plan Review' comment found (optional - only present after review)"
fi

# Check implementation complete comment
if echo "$COMMENTS" | grep -q "## Implementation Complete"; then
  pass "Found '## Implementation Complete' comment on issue"
else
  warn "No '## Implementation Complete' comment found (only present after implementation)"
fi

echo ""
echo "--- Local Filesystem Checks ---"

# Check research document (try both padded and unpadded)
RESEARCH_FILE=$(find "$PROJECT_ROOT/thoughts/shared/research/" -name "*GH-${ISSUE_NUMBER}*" -o -name "*GH-${PADDED}*" 2>/dev/null | head -1)
if [[ -n "$RESEARCH_FILE" ]]; then
  pass "Research document: $(basename "$RESEARCH_FILE")"
else
  fail "No research document found for GH-$ISSUE_NUMBER (tried GH-${ISSUE_NUMBER} and GH-${PADDED})"
fi

# Check plan document (try both padded and unpadded, also group plans)
PLAN_FILE=$(find "$PROJECT_ROOT/thoughts/shared/plans/" -name "*GH-${ISSUE_NUMBER}*" -o -name "*GH-${PADDED}*" 2>/dev/null | head -1)
if [[ -n "$PLAN_FILE" ]]; then
  pass "Plan document: $(basename "$PLAN_FILE")"
else
  # Try group plan
  PLAN_FILE=$(find "$PROJECT_ROOT/thoughts/shared/plans/" -name "*group*GH-${ISSUE_NUMBER}*" -o -name "*group*GH-${PADDED}*" 2>/dev/null | head -1)
  if [[ -n "$PLAN_FILE" ]]; then
    pass "Group plan document: $(basename "$PLAN_FILE")"
  else
    fail "No plan document found for GH-$ISSUE_NUMBER (tried GH-${ISSUE_NUMBER}, GH-${PADDED}, and group patterns)"
  fi
fi

# Check review document (optional)
REVIEW_FILE=$(find "$PROJECT_ROOT/thoughts/shared/reviews/" -name "*GH-${ISSUE_NUMBER}*" -o -name "*GH-${PADDED}*" 2>/dev/null | head -1)
if [[ -n "$REVIEW_FILE" ]]; then
  pass "Review document: $(basename "$REVIEW_FILE")"
else
  warn "No review document (optional, only present after auto-review)"
fi

echo ""
echo "--- File Naming Convention ---"

# Verify naming convention: YYYY-MM-DD-GH-NNNN-*
for file in $RESEARCH_FILE $PLAN_FILE $REVIEW_FILE; do
  if [[ -n "$file" ]]; then
    basename=$(basename "$file")
    if echo "$basename" | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}-(group-)?GH-[0-9]+-'; then
      pass "Naming convention: $basename"
    else
      fail "Bad naming: $basename (expected YYYY-MM-DD-GH-NNNN-description.md)"
    fi
  fi
done

echo ""
echo "=== Summary ==="
echo "  Passed: $PASS"
echo "  Failed: $FAIL"
echo "  Warnings: $WARN"
echo ""

if [[ $FAIL -gt 0 ]]; then
  echo "RESULT: FAILED ($FAIL failures)"
  exit 1
else
  echo "RESULT: PASSED (with $WARN warnings)"
  exit 0
fi
