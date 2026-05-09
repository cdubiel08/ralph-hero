#!/usr/bin/env bash
# logrotate.sh — prune ralph-hero activity log files older than N days.
#
# Walks ~/.ralph-hero/activity/YYYY/MM/DD.jsonl (or RALPH_ACTIVITY_DIR override)
# and deletes files whose date encoded in the path is older than the retention
# window. Empty month/year directories are removed after pruning.
#
# Usage:
#   logrotate.sh              # prune older than 14 days
#   logrotate.sh --dry-run    # show what would be deleted, do nothing
#
# Env:
#   RALPH_ACTIVITY_DIR              — root directory (default: ~/.ralph-hero/activity)
#   RALPH_ACTIVITY_RETENTION_DAYS   — retention window in days (default: 14)
#
# Exit codes:
#   0 — completed (always, unless invariant fails before walk)

set -euo pipefail

ACTIVITY_ROOT="${RALPH_ACTIVITY_DIR:-$HOME/.ralph-hero/activity}"
RETENTION_DAYS="${RALPH_ACTIVITY_RETENTION_DAYS:-14}"
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help)
      sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

if [[ ! -d "$ACTIVITY_ROOT" ]]; then
  echo "No activity dir at $ACTIVITY_ROOT — nothing to prune."
  exit 0
fi

# Compute cutoff in seconds since epoch (portable: macOS BSD date + GNU date)
if date -v-1d +%s >/dev/null 2>&1; then
  CUTOFF_TS=$(date -v-"${RETENTION_DAYS}"d +%s)
else
  CUTOFF_TS=$(date -d "${RETENTION_DAYS} days ago" +%s)
fi

pruned=0
kept=0

# Walk YYYY/MM/DD.jsonl
while IFS= read -r -d '' file; do
  rel="${file#"$ACTIVITY_ROOT"/}"
  # Expected shape: YYYY/MM/DD.jsonl
  if [[ ! "$rel" =~ ^([0-9]{4})/([0-9]{2})/([0-9]{2})\.jsonl$ ]]; then
    continue
  fi
  y="${BASH_REMATCH[1]}"
  m="${BASH_REMATCH[2]}"
  d="${BASH_REMATCH[3]}"

  # Date the file represents (UTC midnight of that day)
  if date -j -f "%Y-%m-%d" "${y}-${m}-${d}" +%s >/dev/null 2>&1; then
    file_ts=$(date -j -f "%Y-%m-%d" "${y}-${m}-${d}" +%s)
  else
    file_ts=$(date -d "${y}-${m}-${d}" +%s)
  fi

  if (( file_ts < CUTOFF_TS )); then
    if (( DRY_RUN )); then
      echo "DRY-RUN would delete: $rel"
    else
      rm -f "$file"
      echo "Pruned: $rel"
    fi
    pruned=$((pruned + 1))
  else
    kept=$((kept + 1))
  fi
done < <(find "$ACTIVITY_ROOT" -type f -name '*.jsonl' -print0 2>/dev/null)

# Tidy: remove empty month and year directories (only when not dry-run)
if (( DRY_RUN == 0 )); then
  find "$ACTIVITY_ROOT" -mindepth 1 -type d -empty -delete 2>/dev/null || true
fi

echo "logrotate complete: pruned=$pruned kept=$kept retention_days=$RETENTION_DAYS"
exit 0
