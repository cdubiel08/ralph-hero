#!/usr/bin/env bash
# demo-seed.sh -- Seed demo issues for onboarding showcase
#
# Creates an umbrella issue with 3 XS sub-issues for the Ralph Hero
# onboarding demo. Issues are added to the GitHub Project board and
# linked as parent/child relationships.
#
# Usage: ./scripts/demo-seed.sh [--force]
#
# Environment:
#   RALPH_GH_OWNER           GitHub owner (default: cdubiel08)
#   RALPH_GH_REPO            Repository name (default: ralph-hero)
#   RALPH_GH_PROJECT_NUMBER  Project board number (default: 3)
#
# Output: Space-separated issue numbers (umbrella first, then sub-issues)
#         e.g., "42 43 44 45"

set -euo pipefail

# --- Environment variables with defaults ---
OWNER="${RALPH_GH_OWNER:-cdubiel08}"
REPO="${RALPH_GH_REPO:-ralph-hero}"
PROJECT="${RALPH_GH_PROJECT_NUMBER:-3}"
LABEL="ralph-demo"

# --- Argument parsing ---
FORCE=false
for arg in "$@"; do
    case "$arg" in
        --force) FORCE=true ;;
    esac
done

# --- Prerequisite check ---
if ! gh auth status &>/dev/null; then
    echo "Error: gh CLI not authenticated. Run: gh auth login"
    exit 1
fi

# --- Idempotency check ---
if [ "$FORCE" = "false" ]; then
    EXISTING=$(gh issue list --repo "$OWNER/$REPO" \
        --label "$LABEL" --state open \
        --json number --jq 'length')
    if [ "$EXISTING" -gt 0 ]; then
        echo "Demo issues already exist ($EXISTING open with label '$LABEL')."
        echo "Run demo-cleanup.sh first, or use --force to skip this check."
        exit 0
    fi
fi

# --- Ensure label exists ---
if ! gh label list --repo "$OWNER/$REPO" --json name --jq '.[].name' | grep -qx "$LABEL"; then
    gh label create "$LABEL" --repo "$OWNER/$REPO" \
        --description "Demo issues for onboarding showcase" \
        --color "D4C5F9"
fi

# --- Create umbrella issue ---
UMBRELLA_BODY=$(printf 'Umbrella issue for onboarding demo.\n\n### Sub-issues (XS each)\n- [ ] Add Welcome to Ralph banner on first run\n- [ ] Add --version flag to ralph-cli.sh\n- [ ] Add --help flag with usage summary')

UMBRELLA_URL=$(gh issue create --repo "$OWNER/$REPO" \
    --title "Demo: Add greeting message to CLI" \
    --body "$UMBRELLA_BODY" \
    --label "$LABEL")
UMBRELLA_NUM=$(echo "$UMBRELLA_URL" | grep -oE '[0-9]+$')
echo "Created umbrella issue: #$UMBRELLA_NUM"

# --- Create 3 sub-issues ---
SUB_TITLES=(
    "Add Welcome to Ralph banner on first run"
    "Add --version flag to ralph-cli.sh"
    "Add --help flag with usage summary"
)
SUB_NUMS=()
for title in "${SUB_TITLES[@]}"; do
    url=$(gh issue create --repo "$OWNER/$REPO" \
        --title "$title" \
        --body "XS sub-issue for onboarding demo. Part of umbrella #$UMBRELLA_NUM." \
        --label "$LABEL")
    num=$(echo "$url" | grep -oE '[0-9]+$')
    SUB_NUMS+=("$num")
    echo "Created sub-issue: #$num - $title"
done

# --- Link sub-issues to umbrella via GraphQL ---
UMBRELLA_NODE_ID=$(gh api "repos/$OWNER/$REPO/issues/$UMBRELLA_NUM" --jq '.node_id')
for num in "${SUB_NUMS[@]}"; do
    CHILD_NODE_ID=$(gh api "repos/$OWNER/$REPO/issues/$num" --jq '.node_id')
    gh api graphql -f query='
        mutation($parentId: ID!, $childId: ID!) {
            addSubIssue(input: { issueId: $parentId, subIssueId: $childId }) {
                issue { number }
                subIssue { number }
            }
        }' -f parentId="$UMBRELLA_NODE_ID" -f childId="$CHILD_NODE_ID" --silent
    echo "Linked #$num as sub-issue of #$UMBRELLA_NUM"
done

# --- Add all issues to the project board ---
if [ -n "$PROJECT" ]; then
    for num in "$UMBRELLA_NUM" "${SUB_NUMS[@]}"; do
        gh project item-add "$PROJECT" \
            --owner "$OWNER" \
            --url "https://github.com/$OWNER/$REPO/issues/$num" 2>/dev/null || \
            echo "Warning: Could not add #$num to project $PROJECT"
    done
fi

# --- Output results ---
echo ""
echo "=========================================="
echo "  Demo issues created successfully"
echo "=========================================="
echo "Umbrella: #$UMBRELLA_NUM"
for i in "${!SUB_NUMS[@]}"; do
    echo "Sub-issue $((i+1)): #${SUB_NUMS[$i]} - ${SUB_TITLES[$i]}"
done
echo ""
echo "$UMBRELLA_NUM ${SUB_NUMS[*]}"
