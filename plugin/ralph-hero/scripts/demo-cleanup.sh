#!/usr/bin/env bash
# demo-cleanup.sh -- tear down demo environment after onboarding showcase
#
# Usage: ./demo-cleanup.sh [--hard] [--yes] [ISSUE_NUMBER ...]
#        ./demo-seed.sh | ./demo-cleanup.sh          (pipe mode)
#        ./demo-cleanup.sh                            (auto-detect by 'demo' label)
#
# Stages:
#   1. Close all target issues (gh issue close --reason completed)
#   2. Delete demo branches (feature/demo-* on remote)
#   3. Archive issues from the GitHub Project board
#   4. (--hard only) Delete issues entirely (gh issue delete --yes)
#
# Environment:
#   RALPH_GH_OWNER           GitHub owner (default: cdubiel08)
#   RALPH_GH_REPO            Repository name (default: ralph-hero)
#   RALPH_GH_PROJECT_NUMBER  Project board number (default: 3)

set -euo pipefail

# --- Environment defaults ---------------------------------------------------
OWNER="${RALPH_GH_OWNER:-cdubiel08}"
REPO="${RALPH_GH_REPO:-ralph-hero}"
PROJECT_NUMBER="${RALPH_GH_PROJECT_NUMBER:-3}"

# --- Argument parsing --------------------------------------------------------
HARD_DELETE=false
AUTO_YES=false
ISSUES=()

for arg in "$@"; do
    case "$arg" in
        --hard)
            HARD_DELETE=true
            ;;
        --yes)
            AUTO_YES=true
            ;;
        --help|-h)
            sed -n '2,/^$/{ s/^# \{0,1\}//; p }' "$0"
            exit 0
            ;;
        *)
            # Positional arg: issue number
            if [[ "$arg" =~ ^[0-9]+$ ]]; then
                ISSUES+=("$arg")
            else
                echo "Error: unexpected argument '$arg'" >&2
                echo "Usage: ./demo-cleanup.sh [--hard] [--yes] [ISSUE_NUMBER ...]" >&2
                exit 1
            fi
            ;;
    esac
done

# --- Stdin detection (pipe mode) ---------------------------------------------
if [[ ${#ISSUES[@]} -eq 0 ]] && [[ ! -t 0 ]]; then
    while IFS= read -r line; do
        for word in $line; do
            if [[ "$word" =~ ^[0-9]+$ ]]; then
                ISSUES+=("$word")
            fi
        done
    done
fi

# --- Auto-detect by label ----------------------------------------------------
if [[ ${#ISSUES[@]} -eq 0 ]]; then
    echo "No issue numbers provided. Auto-detecting by 'demo' label..."
    mapfile -t ISSUES < <(
        gh issue list --repo "$OWNER/$REPO" --label "demo" --state open \
            --json number --jq '.[].number' 2>/dev/null
    )
fi

# --- Pre-flight check --------------------------------------------------------
if [[ ${#ISSUES[@]} -eq 0 ]]; then
    echo "Nothing to clean up."
    exit 0
fi

echo "Demo cleanup targets: ${ISSUES[*]}"
echo "  Owner:   $OWNER"
echo "  Repo:    $REPO"
echo "  Project: $PROJECT_NUMBER"
echo "  Hard delete: $HARD_DELETE"
echo ""

if [[ "$AUTO_YES" != true ]]; then
    read -r -p "Proceed? [y/N] " confirm
    if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
        echo "Aborted."
        exit 0
    fi
fi

# --- Counters ----------------------------------------------------------------
CLOSED=0
BRANCHES_DELETED=0
ARCHIVED=0
DELETED=0

# --- Stage 1: Close issues ---------------------------------------------------
echo ""
echo "Stage 1: Closing issues..."
for num in "${ISSUES[@]}"; do
    if gh issue close "$num" --repo "$OWNER/$REPO" --reason completed 2>/dev/null; then
        echo "  Closed #$num"
        ((CLOSED++)) || true
    else
        echo "  Skipped #$num (already closed or not found)"
    fi
done

# --- Stage 2: Delete demo branches -------------------------------------------
echo ""
echo "Stage 2: Deleting demo branches..."

# Delete branches matching issue numbers
for num in "${ISSUES[@]}"; do
    if git push origin --delete "feature/demo-$num" 2>/dev/null; then
        echo "  Deleted branch feature/demo-$num"
        ((BRANCHES_DELETED++)) || true
    fi
done

# Also glob-delete any remaining feature/demo-* branches on the remote
for branch in $(git ls-remote --heads origin 'refs/heads/feature/demo-*' 2>/dev/null | awk '{print $2}' | sed 's|refs/heads/||'); do
    if git push origin --delete "$branch" 2>/dev/null; then
        echo "  Deleted branch $branch"
        ((BRANCHES_DELETED++)) || true
    fi
done

if [[ $BRANCHES_DELETED -eq 0 ]]; then
    echo "  No demo branches found."
fi

# --- Stage 3: Archive from project board -------------------------------------
echo ""
echo "Stage 3: Archiving from project board..."
for num in "${ISSUES[@]}"; do
    ITEM_ID=$(gh project item-list "$PROJECT_NUMBER" --owner "$OWNER" \
        --format json 2>/dev/null | jq -r ".items[] | select(.content.number == $num) | .id" 2>/dev/null || echo "")
    if [[ -n "$ITEM_ID" ]]; then
        if gh project item-archive "$PROJECT_NUMBER" --owner "$OWNER" --id "$ITEM_ID" 2>/dev/null; then
            echo "  Archived #$num from project board"
            ((ARCHIVED++)) || true
        fi
    else
        echo "  Skipped #$num (not on project board)"
    fi
done

# --- Stage 4: Hard delete (conditional) --------------------------------------
if [[ "$HARD_DELETE" == true ]]; then
    echo ""
    echo "Stage 4: Deleting issues (--hard)..."
    for num in "${ISSUES[@]}"; do
        if gh issue delete "$num" --repo "$OWNER/$REPO" --yes 2>/dev/null; then
            echo "  Deleted #$num"
            ((DELETED++)) || true
        else
            echo "  Skipped #$num (could not delete)"
        fi
    done
fi

# --- Summary -----------------------------------------------------------------
echo ""
echo "========================================"
echo "  Demo Cleanup Complete"
echo "========================================"
echo "Issues closed:          $CLOSED"
echo "Branches deleted:       $BRANCHES_DELETED"
echo "Board items archived:   $ARCHIVED"
if [[ "$HARD_DELETE" == true ]]; then
    echo "Issues deleted:         $DELETED"
fi
echo ""
