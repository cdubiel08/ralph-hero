#!/usr/bin/env bash
# Tests for logrotate.sh
# Run: bash plugin/ralph-hero/scripts/activity/__tests__/logrotate.test.sh

set -uo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/logrotate.sh"
TEST_DIR="$(mktemp -d)"
trap "rm -rf $TEST_DIR" EXIT

PASS=0
FAIL=0

assert_eq() {
  local expected="$1"
  local actual="$2"
  local msg="$3"
  if [ "$expected" = "$actual" ]; then
    PASS=$((PASS + 1))
    echo "  PASS: $msg"
  else
    FAIL=$((FAIL + 1))
    echo "  FAIL: $msg"
    echo "    expected: $expected"
    echo "    actual:   $actual"
  fi
}

assert_file_exists() {
  local path="$1"
  local msg="$2"
  if [ -f "$path" ]; then
    PASS=$((PASS + 1))
    echo "  PASS: $msg"
  else
    FAIL=$((FAIL + 1))
    echo "  FAIL: $msg (file missing: $path)"
  fi
}

assert_file_missing() {
  local path="$1"
  local msg="$2"
  if [ ! -e "$path" ]; then
    PASS=$((PASS + 1))
    echo "  PASS: $msg"
  else
    FAIL=$((FAIL + 1))
    echo "  FAIL: $msg (file still exists: $path)"
  fi
}

# Portable "N days ago" — macOS BSD date or GNU date.
days_ago() {
  local n="$1"
  if date -v-1d +%Y-%m-%d >/dev/null 2>&1; then
    date -v-"${n}"d +%Y-%m-%d
  else
    date -d "${n} days ago" +%Y-%m-%d
  fi
}

# Seed a fake jsonl file dated relative to today (N days ago).
# Args: <tree_root> <days_ago>
seed_day_file() {
  local root="$1"
  local n="$2"
  local d
  d=$(days_ago "$n")
  local y="${d:0:4}"
  local m="${d:5:2}"
  local dd="${d:8:2}"
  mkdir -p "$root/$y/$m"
  echo '{"ts":"'"$d"'T00:00:00.000Z","kind":"tool_called","category":"work"}' \
    > "$root/$y/$m/$dd.jsonl"
  # Echo the relative path for callers
  echo "$y/$m/$dd.jsonl"
}

echo "Testing $SCRIPT"
echo "Test dir: $TEST_DIR"

# ----------------------------------------------------------------------------
echo
echo "Test: missing activity dir → exit 0 with friendly message"
NOPE_DIR="$TEST_DIR/does-not-exist"
RALPH_ACTIVITY_DIR="$NOPE_DIR" bash "$SCRIPT" >/tmp/logrotate-out.$$ 2>&1
EXIT_CODE=$?
OUT=$(cat /tmp/logrotate-out.$$)
rm -f /tmp/logrotate-out.$$
assert_eq "0" "$EXIT_CODE" "missing dir: exit code 0"
case "$OUT" in
  *"nothing to prune"*) PASS=$((PASS + 1)); echo "  PASS: missing dir: friendly message printed" ;;
  *) FAIL=$((FAIL + 1)); echo "  FAIL: missing dir: expected 'nothing to prune' message; got: $OUT" ;;
esac

# ----------------------------------------------------------------------------
echo
echo "Test: pruning removes only files older than retention window"
ACT_ROOT="$TEST_DIR/case1/activity"
mkdir -p "$ACT_ROOT"

OLD_REL=$(seed_day_file "$ACT_ROOT" 30)   # 30 days ago — should be pruned
EDGE_REL=$(seed_day_file "$ACT_ROOT" 7)   # 7 days ago — should be kept
TODAY_REL=$(seed_day_file "$ACT_ROOT" 0)  # today — should be kept

RALPH_ACTIVITY_DIR="$ACT_ROOT" RALPH_ACTIVITY_RETENTION_DAYS=14 \
  bash "$SCRIPT" >/dev/null 2>&1
EXIT_CODE=$?
assert_eq "0" "$EXIT_CODE" "prune run: exit 0"
assert_file_missing "$ACT_ROOT/$OLD_REL"   "30-day-old file pruned"
assert_file_exists  "$ACT_ROOT/$EDGE_REL"  "7-day-old file kept (inside 14-day window)"
assert_file_exists  "$ACT_ROOT/$TODAY_REL" "today's file kept"

# ----------------------------------------------------------------------------
echo
echo "Test: --dry-run does not delete anything"
ACT_ROOT="$TEST_DIR/case2/activity"
mkdir -p "$ACT_ROOT"

OLD_REL=$(seed_day_file "$ACT_ROOT" 30)
TODAY_REL=$(seed_day_file "$ACT_ROOT" 0)

OUT=$(RALPH_ACTIVITY_DIR="$ACT_ROOT" RALPH_ACTIVITY_RETENTION_DAYS=14 \
  bash "$SCRIPT" --dry-run 2>&1)
EXIT_CODE=$?
assert_eq "0" "$EXIT_CODE" "dry-run: exit 0"
assert_file_exists "$ACT_ROOT/$OLD_REL"   "dry-run: old file NOT deleted"
assert_file_exists "$ACT_ROOT/$TODAY_REL" "dry-run: today's file NOT deleted"
case "$OUT" in
  *"DRY-RUN would delete"*) PASS=$((PASS + 1)); echo "  PASS: dry-run: announces would-delete files" ;;
  *) FAIL=$((FAIL + 1)); echo "  FAIL: dry-run: expected 'DRY-RUN would delete' marker in output; got: $OUT" ;;
esac

# ----------------------------------------------------------------------------
echo
echo "Test: empty month/year dirs cleaned up after prune"
ACT_ROOT="$TEST_DIR/case3/activity"
mkdir -p "$ACT_ROOT"

# Seed only a single 30-day-old file — its month/year dirs become empty after prune.
OLD_REL=$(seed_day_file "$ACT_ROOT" 30)
OLD_Y="${OLD_REL:0:4}"
OLD_M="${OLD_REL:5:2}"

RALPH_ACTIVITY_DIR="$ACT_ROOT" RALPH_ACTIVITY_RETENTION_DAYS=14 \
  bash "$SCRIPT" >/dev/null 2>&1

if [ ! -d "$ACT_ROOT/$OLD_Y/$OLD_M" ]; then
  PASS=$((PASS + 1))
  echo "  PASS: empty month dir cleaned up"
else
  FAIL=$((FAIL + 1))
  echo "  FAIL: empty month dir survived: $ACT_ROOT/$OLD_Y/$OLD_M"
fi

if [ ! -d "$ACT_ROOT/$OLD_Y" ]; then
  PASS=$((PASS + 1))
  echo "  PASS: empty year dir cleaned up"
else
  FAIL=$((FAIL + 1))
  echo "  FAIL: empty year dir survived: $ACT_ROOT/$OLD_Y"
fi

# Activity root itself MUST survive even when fully empty
if [ -d "$ACT_ROOT" ]; then
  PASS=$((PASS + 1))
  echo "  PASS: activity root preserved (not deleted)"
else
  FAIL=$((FAIL + 1))
  echo "  FAIL: activity root deleted: $ACT_ROOT"
fi

# ----------------------------------------------------------------------------
echo
echo "Test: malformed paths inside tree are ignored"
ACT_ROOT="$TEST_DIR/case4/activity"
mkdir -p "$ACT_ROOT/2026/05"
# Garbage file with .jsonl extension but not matching YYYY/MM/DD.jsonl
echo '{}' > "$ACT_ROOT/2026/05/not-a-day.jsonl"
echo '{}' > "$ACT_ROOT/random.jsonl"

# Plus a real old file that should be pruned
OLD_REL=$(seed_day_file "$ACT_ROOT" 30)

RALPH_ACTIVITY_DIR="$ACT_ROOT" RALPH_ACTIVITY_RETENTION_DAYS=14 \
  bash "$SCRIPT" >/dev/null 2>&1
EXIT_CODE=$?
assert_eq "0" "$EXIT_CODE" "malformed paths: exit 0"
assert_file_exists "$ACT_ROOT/2026/05/not-a-day.jsonl" "malformed day file ignored (kept)"
assert_file_exists "$ACT_ROOT/random.jsonl"            "top-level garbage file ignored (kept)"
assert_file_missing "$ACT_ROOT/$OLD_REL"               "real old file still pruned"

# ----------------------------------------------------------------------------
echo
echo "Test: custom retention window (1 day) prunes more aggressively"
ACT_ROOT="$TEST_DIR/case5/activity"
mkdir -p "$ACT_ROOT"

TWO_DAY_REL=$(seed_day_file "$ACT_ROOT" 2)   # 2 days ago — pruned with 1d retention
TODAY_REL=$(seed_day_file "$ACT_ROOT" 0)     # today — kept

RALPH_ACTIVITY_DIR="$ACT_ROOT" RALPH_ACTIVITY_RETENTION_DAYS=1 \
  bash "$SCRIPT" >/dev/null 2>&1
assert_file_missing "$ACT_ROOT/$TWO_DAY_REL" "1-day retention: 2-day-old file pruned"
assert_file_exists  "$ACT_ROOT/$TODAY_REL"   "1-day retention: today's file kept"

# ----------------------------------------------------------------------------
echo
echo "Test: unknown flag exits non-zero"
RALPH_ACTIVITY_DIR="$TEST_DIR/nope" bash "$SCRIPT" --bogus >/dev/null 2>&1
EXIT_CODE=$?
if [ "$EXIT_CODE" -ne 0 ]; then
  PASS=$((PASS + 1))
  echo "  PASS: unknown flag: non-zero exit"
else
  FAIL=$((FAIL + 1))
  echo "  FAIL: unknown flag: exit was 0 (expected non-zero)"
fi

echo
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
