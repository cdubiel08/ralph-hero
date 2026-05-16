#!/usr/bin/env bash
# self-improve.sh — nightly cos self-improvement loop (GH-1258)
#
# Grades the last 7 cos morning briefs against the 5-dimension rubric at
# plugin/ralph-hero/skills/cos/rubric.md. When the mean score < 3.5, drafts
# a revised system-prompt.md via cos.sh --role slow and opens a GitHub PR
# labeled cos-self-improvement for human review.
#
# Usage:
#   self-improve.sh [--help|-h]
#
# Environment:
#   RALPH_COS_SELF_IMPROVE       MUST be "1" to enable; any other value (including
#                                unset) exits 0 immediately with a "quarantined" log line.
#   RALPH_COS_SELF_IMPROVE_DRY_RUN  Set to "1" to skip git push and gh pr create.
#                                The script still creates the branch + commit locally,
#                                which allows smoke testing and inspection without
#                                touching the remote.
#   RALPH_COS_THOUGHTS_DIR       Override for the thoughts/ corpus root directory.
#                                Default: ~/projects/thoughts (same resolution as morning-brief.sh).
#   RALPH_COS_DEBUG              Set to "1" for verbose stderr output.
#
# Exit codes:
#   0   Normal exit (quarantined, insufficient briefs, mean >= 3.5, or PR opened)
#   1   Fatal error: too many parse failures, or git/gh operation failed
#   2   Usage error (--help exits 0, not 2)

set -euo pipefail

# ---------------------------------------------------------------------------
# HARD GATE — must be the first executable statement after set -euo pipefail
# ---------------------------------------------------------------------------
if [[ "${RALPH_COS_SELF_IMPROVE:-}" != "1" ]]; then
    echo "[self-improve] quarantined; set RALPH_COS_SELF_IMPROVE=1 to enable" >&2
    exit 0
fi

# ---------------------------------------------------------------------------
# Defensive: ensure state directory exists for first-time installs
# ---------------------------------------------------------------------------
mkdir -p "${HOME}/.ralph-hero/cos/self-improve"

# ---------------------------------------------------------------------------
# Locate this script's directory robustly (works when symlinked)
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd -P)"
REPO_ROOT="$(cd "${PLUGIN_ROOT}/../.." && pwd -P)"

COS_SH="${SCRIPT_DIR}/cos.sh"
RUBRIC_FILE="${PLUGIN_ROOT}/skills/cos/rubric.md"
SYSTEM_PROMPT_FILE="${PLUGIN_ROOT}/skills/cos/system-prompt.md"

# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------
_usage() {
    cat <<'EOF'
self-improve.sh — nightly cos self-improvement loop

Usage:
  self-improve.sh [--help|-h]

Grades the last 7 cos morning briefs against the 5-dimension rubric and,
when the mean score < 3.5, opens a GitHub PR with a revised system prompt.

Environment:
  RALPH_COS_SELF_IMPROVE=1          Required to enable the script.
  RALPH_COS_SELF_IMPROVE_DRY_RUN=1  Skip git push + gh pr create (local-only).
  RALPH_COS_THOUGHTS_DIR            Override the thoughts/ corpus root.
  RALPH_COS_DEBUG=1                 Verbose stderr output.

See plugin/ralph-hero/skills/cos/rubric.md for the grading rubric.
See plugin/ralph-hero/scripts/cos/README.md for the two-manual-verification policy.
EOF
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
for arg in "$@"; do
    case "$arg" in
        --help|-h)
            _usage
            exit 0
            ;;
        *)
            echo "[self-improve] ERROR: Unknown flag: $arg" >&2
            _usage >&2
            exit 2
            ;;
    esac
done

# ---------------------------------------------------------------------------
# Debug helper
# ---------------------------------------------------------------------------
_debug() {
    if [[ "${RALPH_COS_DEBUG:-}" == "1" ]]; then
        echo "[self-improve] DEBUG: $*" >&2
    fi
}

# ---------------------------------------------------------------------------
# Guard: required tools
# ---------------------------------------------------------------------------
if [[ ! -f "$COS_SH" ]]; then
    echo "[self-improve] ERROR: cos.sh not found at: $COS_SH" >&2
    exit 1
fi

if [[ ! -f "$RUBRIC_FILE" ]]; then
    echo "[self-improve] ERROR: rubric.md not found at: $RUBRIC_FILE" >&2
    exit 1
fi

if [[ ! -f "$SYSTEM_PROMPT_FILE" ]]; then
    echo "[self-improve] ERROR: system-prompt.md not found at: $SYSTEM_PROMPT_FILE" >&2
    exit 1
fi

if ! command -v git >/dev/null 2>&1; then
    echo "[self-improve] ERROR: git not found on PATH" >&2
    exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
    echo "[self-improve] ERROR: gh CLI not found on PATH" >&2
    exit 1
fi

if ! command -v awk >/dev/null 2>&1; then
    echo "[self-improve] ERROR: awk not found on PATH" >&2
    exit 1
fi

# ---------------------------------------------------------------------------
# Resolve the thoughts/ corpus root (mirrors morning-brief.sh resolution)
# ---------------------------------------------------------------------------
if [[ -n "${RALPH_COS_THOUGHTS_DIR:-}" ]]; then
    THOUGHTS_DIR="${RALPH_COS_THOUGHTS_DIR}"
else
    THOUGHTS_DIR="${REPO_ROOT}/../thoughts"
    THOUGHTS_DIR="$(cd "${THOUGHTS_DIR}" 2>/dev/null && pwd -P)" \
        || THOUGHTS_DIR="${REPO_ROOT}/../thoughts"
fi

_debug "THOUGHTS_DIR=${THOUGHTS_DIR}"
_debug "RUBRIC_FILE=${RUBRIC_FILE}"
_debug "SYSTEM_PROMPT_FILE=${SYSTEM_PROMPT_FILE}"

# ---------------------------------------------------------------------------
# Glob morning brief files (sorted lexicographically = chronologically)
# ---------------------------------------------------------------------------
BRIEF_DIR="${THOUGHTS_DIR}/shared/research"

if [[ ! -d "$BRIEF_DIR" ]]; then
    echo "[self-improve] insufficient briefs (have 0, need 7); skipping run" >&2
    exit 0
fi

# Build array of brief files sorted lexicographically (bash 3.2 compatible)
BRIEF_FILES=()
while IFS= read -r -d '' f; do
    BRIEF_FILES+=("$f")
done < <(find "$BRIEF_DIR" -maxdepth 1 -name '*-cos-morning-brief.md' -print0 | sort -z)

BRIEF_COUNT="${#BRIEF_FILES[@]}"
_debug "Found ${BRIEF_COUNT} brief files"

if (( BRIEF_COUNT < 7 )); then
    echo "[self-improve] insufficient briefs (have ${BRIEF_COUNT}, need 7); skipping run" >&2
    exit 0
fi

# Take the LAST 7 (most recent by date prefix)
START_IDX=$(( BRIEF_COUNT - 7 ))
SELECTED_BRIEFS=("${BRIEF_FILES[@]:$START_IDX:7}")

_debug "Grading ${#SELECTED_BRIEFS[@]} briefs"

# ---------------------------------------------------------------------------
# Load rubric content once
# ---------------------------------------------------------------------------
RUBRIC_CONTENT="$(cat "$RUBRIC_FILE")"

# ---------------------------------------------------------------------------
# Grade each brief
# ---------------------------------------------------------------------------
PARSE_FAILURES=0
declare -a BRIEF_DATES
declare -a BRIEF_BASENAMES
declare -a BRIEF_SCORES_SPECIFICITY
declare -a BRIEF_SCORES_ACTIONABILITY
declare -a BRIEF_SCORES_SN
declare -a BRIEF_SCORES_NOVELTY
declare -a BRIEF_SCORES_BREVITY
declare -a BRIEF_MEANS
declare -a BRIEF_STATUS

STATE_DIR="${HOME}/.ralph-hero/cos/self-improve"
RUN_DATE="$(date -u +%F)"
SCORE_TMPDIR="${STATE_DIR}/run-${RUN_DATE}"
mkdir -p "$SCORE_TMPDIR"

GRADE_IDX=0
for BRIEF_FILE in "${SELECTED_BRIEFS[@]}"; do
    BRIEF_BASENAME="$(basename "$BRIEF_FILE")"
    # Extract date from filename: YYYY-MM-DD-cos-morning-brief.md
    BRIEF_DATE="${BRIEF_BASENAME%%-cos-morning-brief.md}"

    BRIEF_CONTENT="$(cat "$BRIEF_FILE")"

    GRADE_PROMPT="$(cat <<EOF
You are a grading assistant. Grade the following morning brief against the rubric below.

## Morning Brief to Grade

${BRIEF_CONTENT}

## Rubric

${RUBRIC_CONTENT}

## Instructions

Grade the brief above against each rubric dimension. Output EXACTLY 5 integers, one per line, with no other text, in this order:
1. Specificity
2. Actionability
3. Signal-vs-noise
4. Novelty
5. Brevity

Each integer must be between 1 and 5 inclusive. No explanations, no labels, no preamble.
EOF
)"

    SCORE_FILE="${SCORE_TMPDIR}/scores-${BRIEF_DATE}.txt"
    _debug "Grading ${BRIEF_BASENAME}..."

    # Invoke cos.sh --role slow; capture stdout; failures are tolerated
    GRADE_EXIT=0
    "$COS_SH" --role slow "$GRADE_PROMPT" > "$SCORE_FILE" 2>/dev/null || GRADE_EXIT=$?

    # Parse 5 integer scores from the output file
    PARSE_OK=1
    S1="" S2="" S3="" S4="" S5=""

    LINE_NUM=0
    while IFS= read -r line; do
        # Strip whitespace
        line="${line#"${line%%[![:space:]]*}"}"
        line="${line%"${line##*[![:space:]]}"}"
        # Must be a single integer 1-5
        if [[ "$line" =~ ^[1-5]$ ]]; then
            LINE_NUM=$(( LINE_NUM + 1 ))
            case $LINE_NUM in
                1) S1="$line" ;;
                2) S2="$line" ;;
                3) S3="$line" ;;
                4) S4="$line" ;;
                5) S5="$line" ;;
            esac
        elif [[ -n "$line" ]]; then
            # Non-empty non-integer line found — parse failure
            PARSE_OK=0
            break
        fi
    done < "$SCORE_FILE"

    if [[ $PARSE_OK -eq 1 ]] && [[ $LINE_NUM -eq 5 ]]; then
        BRIEF_DATES+=("$BRIEF_DATE")
        BRIEF_BASENAMES+=("$BRIEF_BASENAME")
        BRIEF_SCORES_SPECIFICITY+=("$S1")
        BRIEF_SCORES_ACTIONABILITY+=("$S2")
        BRIEF_SCORES_SN+=("$S3")
        BRIEF_SCORES_NOVELTY+=("$S4")
        BRIEF_SCORES_BREVITY+=("$S5")
        BRIEF_MEAN="$(awk -v a="$S1" -v b="$S2" -v c="$S3" -v d="$S4" -v e="$S5" \
            'BEGIN { printf "%.2f", (a+b+c+d+e)/5 }')"
        BRIEF_MEANS+=("$BRIEF_MEAN")
        BRIEF_STATUS+=("ok")
        _debug "${BRIEF_BASENAME}: ${S1} ${S2} ${S3} ${S4} ${S5} mean=${BRIEF_MEAN}"
    else
        echo "[self-improve] WARNING: parse failed for ${BRIEF_BASENAME} (grade_exit=${GRADE_EXIT}, lines_parsed=${LINE_NUM})" >&2
        BRIEF_DATES+=("$BRIEF_DATE")
        BRIEF_BASENAMES+=("$BRIEF_BASENAME")
        BRIEF_SCORES_SPECIFICITY+=("-")
        BRIEF_SCORES_ACTIONABILITY+=("-")
        BRIEF_SCORES_SN+=("-")
        BRIEF_SCORES_NOVELTY+=("-")
        BRIEF_SCORES_BREVITY+=("-")
        BRIEF_MEANS+=("-")
        BRIEF_STATUS+=("parse_failed")
        PARSE_FAILURES=$(( PARSE_FAILURES + 1 ))
    fi

    GRADE_IDX=$(( GRADE_IDX + 1 ))
done

# ---------------------------------------------------------------------------
# Abort if too many parse failures
# ---------------------------------------------------------------------------
if (( PARSE_FAILURES >= 3 )); then
    echo "[self-improve] too many parse failures (${PARSE_FAILURES} of 7); aborting before PR" >&2
    exit 1
fi

# ---------------------------------------------------------------------------
# Compute overall mean across all successful datapoints
# ---------------------------------------------------------------------------
TOTAL_SCORE=0
TOTAL_COUNT=0
for i in "${!BRIEF_STATUS[@]}"; do
    if [[ "${BRIEF_STATUS[$i]}" == "ok" ]]; then
        S1="${BRIEF_SCORES_SPECIFICITY[$i]}"
        S2="${BRIEF_SCORES_ACTIONABILITY[$i]}"
        S3="${BRIEF_SCORES_SN[$i]}"
        S4="${BRIEF_SCORES_NOVELTY[$i]}"
        S5="${BRIEF_SCORES_BREVITY[$i]}"
        TOTAL_SCORE=$(( TOTAL_SCORE + S1 + S2 + S3 + S4 + S5 ))
        TOTAL_COUNT=$(( TOTAL_COUNT + 5 ))
    fi
done

if (( TOTAL_COUNT == 0 )); then
    echo "[self-improve] no valid scores to compute mean; aborting" >&2
    exit 1
fi

MEAN="$(awk -v t="$TOTAL_SCORE" -v n="$TOTAL_COUNT" 'BEGIN { printf "%.2f", t/n }')"

# ---------------------------------------------------------------------------
# Emit score table to stdout
# ---------------------------------------------------------------------------
echo "| Date | Brief | Specificity | Actionability | S/N | Novelty | Brevity | Mean |"
echo "|------|-------|-------------|---------------|-----|---------|---------|------|"

for i in "${!BRIEF_DATES[@]}"; do
    DATE_COL="${BRIEF_DATES[$i]}"
    NAME_COL="${BRIEF_BASENAMES[$i]}"
    if [[ "${BRIEF_STATUS[$i]}" == "parse_failed" ]]; then
        echo "| ${DATE_COL} | ${NAME_COL} | parse_failed | - | - | - | - | - |"
    else
        echo "| ${DATE_COL} | ${NAME_COL} | ${BRIEF_SCORES_SPECIFICITY[$i]} | ${BRIEF_SCORES_ACTIONABILITY[$i]} | ${BRIEF_SCORES_SN[$i]} | ${BRIEF_SCORES_NOVELTY[$i]} | ${BRIEF_SCORES_BREVITY[$i]} | ${BRIEF_MEANS[$i]} |"
    fi
done

echo "| | **Overall mean** | | | | | | **${MEAN}** |"

# ---------------------------------------------------------------------------
# Decision: mean >= 3.5 → no revision needed
# ---------------------------------------------------------------------------
if awk -v m="$MEAN" 'BEGIN { exit !(m >= 3.5) }'; then
    echo "[self-improve] mean ${MEAN} >= 3.5; no revision needed" >&2
    exit 0
fi

echo "[self-improve] mean ${MEAN} < 3.5; drafting revised system prompt" >&2

# ---------------------------------------------------------------------------
# Branch guard: idempotent same-day re-run protection
# ---------------------------------------------------------------------------
BRANCH_NAME="cos-self-improvement/${RUN_DATE}"
if git -C "$REPO_ROOT" rev-parse --verify "$BRANCH_NAME" >/dev/null 2>&1; then
    echo "[self-improve] branch already exists (${BRANCH_NAME}); aborting to avoid clobbering existing PR" >&2
    exit 0
fi

# ---------------------------------------------------------------------------
# Draft revised system prompt via cos.sh --role slow
# ---------------------------------------------------------------------------
CURRENT_PROMPT_CONTENT="$(cat "$SYSTEM_PROMPT_FILE")"
CURRENT_PROMPT_LEN="${#CURRENT_PROMPT_CONTENT}"

# Build score table string for the revision prompt
SCORE_TABLE=""
for i in "${!BRIEF_DATES[@]}"; do
    if [[ "${BRIEF_STATUS[$i]}" == "ok" ]]; then
        SCORE_TABLE="${SCORE_TABLE}
- ${BRIEF_DATES[$i]}: specificity=${BRIEF_SCORES_SPECIFICITY[$i]} actionability=${BRIEF_SCORES_ACTIONABILITY[$i]} signal-vs-noise=${BRIEF_SCORES_SN[$i]} novelty=${BRIEF_SCORES_NOVELTY[$i]} brevity=${BRIEF_SCORES_BREVITY[$i]} mean=${BRIEF_MEANS[$i]}"
    else
        SCORE_TABLE="${SCORE_TABLE}
- ${BRIEF_DATES[$i]}: parse_failed"
    fi
done

REVISION_PROMPT="$(cat <<EOF
You are revising a chief-of-staff system prompt for a software project assistant.
The current system prompt produced morning briefs that scored a mean of ${MEAN}/5.0 over the last 7 days.

Per-brief scores (using the 5-dimension rubric):
${SCORE_TABLE}

The current system prompt is:

${CURRENT_PROMPT_CONTENT}

The rubric used for grading is:

${RUBRIC_CONTENT}

Based on the low scores, revise the system prompt to improve the areas where scores were low.
Keep the same overall structure and intent of the prompt.
Output ONLY the revised system-prompt.md content. No preamble, no explanation, no fenced code block.
The output will be written directly to system-prompt.md.
EOF
)"

DRAFT_PROMPT_FILE="${SCORE_TMPDIR}/draft-system-prompt-${RUN_DATE}.md"
_debug "Requesting revised system prompt from cos.sh --role slow..."

REVISION_EXIT=0
"$COS_SH" --role slow "$REVISION_PROMPT" > "$DRAFT_PROMPT_FILE" 2>/dev/null || REVISION_EXIT=$?

if [[ $REVISION_EXIT -ne 0 ]]; then
    echo "[self-improve] ERROR: cos.sh failed during revision drafting (exit ${REVISION_EXIT})" >&2
    exit 1
fi

DRAFT_CONTENT="$(cat "$DRAFT_PROMPT_FILE")"
DRAFT_LEN="${#DRAFT_CONTENT}"

if [[ -z "$DRAFT_CONTENT" ]]; then
    echo "[self-improve] revised prompt indistinguishable from current (empty output); no PR" >&2
    exit 0
fi

# Check for substantial difference: require either >5% length change OR different content
if [[ "$DRAFT_CONTENT" == "$CURRENT_PROMPT_CONTENT" ]]; then
    echo "[self-improve] revised prompt indistinguishable from current (identical content); no PR" >&2
    exit 0
fi

# Float comparison for 5% threshold using awk
if awk -v new_len="$DRAFT_LEN" -v old_len="$CURRENT_PROMPT_LEN" \
    'BEGIN {
        diff = (new_len > old_len) ? (new_len - old_len) : (old_len - new_len);
        threshold = old_len * 0.05;
        exit !(diff <= threshold)
    }'; then
    # Difference is <= 5% — do a sha256 check to see if content changed at all
    OLD_HASH="$(printf '%s' "$CURRENT_PROMPT_CONTENT" | shasum -a 256 | cut -d' ' -f1)"
    NEW_HASH="$(printf '%s' "$DRAFT_CONTENT" | shasum -a 256 | cut -d' ' -f1)"
    if [[ "$OLD_HASH" == "$NEW_HASH" ]]; then
        echo "[self-improve] revised prompt indistinguishable from current; no PR" >&2
        exit 0
    fi
    _debug "Content changed (< 5% length diff but hashes differ) — proceeding with PR"
fi

# ---------------------------------------------------------------------------
# Create branch, commit, push
# ---------------------------------------------------------------------------
git -C "$REPO_ROOT" checkout -b "$BRANCH_NAME"

# Write the drafted prompt to system-prompt.md
printf '%s' "$DRAFT_CONTENT" > "$SYSTEM_PROMPT_FILE"

git -C "$REPO_ROOT" add "plugin/ralph-hero/skills/cos/system-prompt.md"
git -C "$REPO_ROOT" commit -m "docs(cos): self-improvement revision ${RUN_DATE} (mean=${MEAN})"

# ---------------------------------------------------------------------------
# Dry-run gate: skip push + PR if RALPH_COS_SELF_IMPROVE_DRY_RUN=1
# ---------------------------------------------------------------------------
if [[ "${RALPH_COS_SELF_IMPROVE_DRY_RUN:-}" == "1" ]]; then
    echo "[self-improve] DRY RUN: skipping git push and gh pr create" >&2
    echo "[self-improve] Branch ${BRANCH_NAME} created locally with commit. Inspect then: git -C ${REPO_ROOT} branch -D ${BRANCH_NAME}" >&2
    exit 0
fi

git -C "$REPO_ROOT" push -u origin "$BRANCH_NAME"

# ---------------------------------------------------------------------------
# Idempotent label creation
# ---------------------------------------------------------------------------
gh label create cos-self-improvement \
    --description 'Drafted by the nightly cos self-improvement loop' \
    --color 'fbca04' \
    --repo "$(git -C "$REPO_ROOT" remote get-url origin | sed 's|.*github.com[:/]\(.*\)\.git|\1|; s|.*github.com[:/]\(.*\)|\1|')" \
    2>/dev/null || true

# ---------------------------------------------------------------------------
# Build PR body
# ---------------------------------------------------------------------------
FILENAMES_LIST=""
for BRIEF_FILE in "${SELECTED_BRIEFS[@]}"; do
    FILENAMES_LIST="${FILENAMES_LIST}
- $(basename "$BRIEF_FILE")"
done

PR_BODY="$(cat <<EOF
## cos self-improvement revision — ${RUN_DATE}

Mean score across last 7 morning briefs: **${MEAN}/5.0** (threshold: 3.5)

### Per-brief scores

| Date | Brief | Specificity | Actionability | S/N | Novelty | Brevity | Mean |
|------|-------|-------------|---------------|-----|---------|---------|------|
EOF
)"

for i in "${!BRIEF_DATES[@]}"; do
    if [[ "${BRIEF_STATUS[$i]}" == "ok" ]]; then
        PR_BODY="${PR_BODY}
| ${BRIEF_DATES[$i]} | ${BRIEF_BASENAMES[$i]} | ${BRIEF_SCORES_SPECIFICITY[$i]} | ${BRIEF_SCORES_ACTIONABILITY[$i]} | ${BRIEF_SCORES_SN[$i]} | ${BRIEF_SCORES_NOVELTY[$i]} | ${BRIEF_SCORES_BREVITY[$i]} | ${BRIEF_MEANS[$i]} |"
    else
        PR_BODY="${PR_BODY}
| ${BRIEF_DATES[$i]} | ${BRIEF_BASENAMES[$i]} | parse_failed | - | - | - | - | - |"
    fi
done

PR_BODY="${PR_BODY}
| | **Overall mean** | | | | | | **${MEAN}** |

### Graded brief files
${FILENAMES_LIST}

### How to verify

- [ ] Read the diff on this PR: confirm the revised prompt differs meaningfully from the current (not just whitespace).
- [ ] Confirm the revised prompt remains a sensible chief-of-staff instruction set — it should still discourage fabrication, prefer brevity, and cite issue numbers.
- [ ] Optionally: run \`RALPH_COS_SELF_IMPROVE=1 RALPH_COS_SELF_IMPROVE_DRY_RUN=1 plugin/ralph-hero/scripts/cos/self-improve.sh\` locally to reproduce the scores.
- [ ] If the revision looks good, merge. If not, close this PR and adjust the rubric or system prompt manually.

---

*Generated by \`self-improve.sh\` — see \`plugin/ralph-hero/scripts/cos/README.md\` § Self-improvement loop for the two-manual-verification policy.*
EOF
"

# ---------------------------------------------------------------------------
# Open PR
# ---------------------------------------------------------------------------
PR_URL="$(gh pr create \
    --title "cos: self-improvement revision ${RUN_DATE}" \
    --body "$PR_BODY" \
    --label "cos-self-improvement" \
    --repo "$(git -C "$REPO_ROOT" remote get-url origin | sed 's|.*github.com[:/]\(.*\)\.git|\1|; s|.*github.com[:/]\(.*\)|\1|')")"

echo "[self-improve] PR opened: ${PR_URL}" >&2
echo "${PR_URL}"
