#!/usr/bin/env bash
# scripts/__tests__/disk-guard.test.sh
# Tests plugin/ralph-knowledge/hooks/disk-guard.sh (GH-1756, PR #1755).
#
# The guard's whole job is telling a human which caches are safe to delete, so
# the load-bearing property is NOT the size arithmetic — it is that the advice
# is never wrong in the dangerous direction.
#
# The dangerous direction is specific (codex P2): an older Claude Code session
# left open keeps serving its MCP server out of its OWN plugin cache directory,
# loading JavaScript and native dependencies lazily for the life of the
# session. "Superseded" therefore does not mean "unused". Deleting an in-use
# root breaks that session where it stands, and an already-running session does
# not re-download anything — which is precisely the breakage this feature
# exists to prevent, caused by the feature itself.
#
# So: an in-use version must never be counted as reclaimable nor described as
# safe, and on a host where use cannot be probed the advice must degrade to
# "close your sessions first" rather than naming directories.
#
# Every case runs the real hook against a fake $HOME, with a real background
# process parked in a cache dir when a case needs one to look busy.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$REPO_ROOT/plugin/ralph-knowledge/hooks/disk-guard.sh"

TMP_ROOT=$(mktemp -d)
BUSY_PIDS=()
cleanup() {
  local pid
  for pid in ${BUSY_PIDS+"${BUSY_PIDS[@]}"}; do kill "$pid" 2>/dev/null || true; done
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); [ -n "${2:-}" ] && echo "$2" | sed 's/^/        /'; return 0; }

[ -f "$SRC" ] || { echo "FATAL: hook not found at $SRC"; exit 1; }

# fake_home <name> — a $HOME with two plugin cache versions, the older one
# large enough to cross any sane threshold.
fake_home() {
  local home="$TMP_ROOT/$1"
  local base="$home/.claude/plugins/cache/ralph-hero/ralph-knowledge"
  mkdir -p "$base/0.1.58/node_modules" "$base/0.1.59/node_modules"
  # ~6MB of ballast in the OLD version, so it is what the guard would report.
  mkdir -p "$base/0.1.58/node_modules/bulk"
  dd if=/dev/zero of="$base/0.1.58/node_modules/bulk/blob" bs=1024 count=6144 \
    >/dev/null 2>&1
  echo "$home"
}

# run_guard <home> [extra-env...] — run the hook with a fresh stamp so the
# once-a-day gate never suppresses a case.
run_guard() {
  local home="$1"; shift
  HOME="$home" TMPDIR="$home/tmp" RALPH_KNOWLEDGE_DISK_WARN_MB=1 \
    "$@" bash "$SRC" 2>/dev/null
}

# park_process <dir> — a real process whose cwd is <dir>, i.e. exactly what a
# running MCP server looks like (launch-mcp.sh cd's to the plugin root before
# exec'ing node).
park_process() {
  local dir="$1"
  ( cd "$dir" && exec sleep 120 ) &
  local pid=$!
  BUSY_PIDS+=("$pid")
  # Give the subshell a moment to actually chdir before anyone probes it.
  local i=0
  while [ "$i" -lt 50 ]; do
    sleep 0.1
    i=$((i + 1))
    kill -0 "$pid" 2>/dev/null && break
  done
  echo "$pid"
}

probe_available() { [ -d /proc ] || command -v lsof >/dev/null 2>&1; }

echo "=== an idle superseded version is reported as reclaimable ==="

home=$(fake_home idle)
mkdir -p "$home/tmp"
out=$(run_guard "$home")

if grep -q 'Reclaimable cache detected' <<<"$out"; then
  pass "an idle superseded version triggers the warning"
else
  fail "no warning for an idle superseded version" "$out"
fi

if grep -qE '1 superseded plugin version' <<<"$out"; then
  pass "the idle superseded version is counted"
else
  fail "the idle superseded version was not counted" "$out"
fi

# The newest must never be offered up.
if grep -q '0.1.59' <<<"$out"; then
  fail "the guard named the NEWEST version as reclaimable" "$out"
else
  pass "the newest version is never offered for deletion"
fi

echo "=== an IN-USE superseded version is never called safe to delete ==="

if ! probe_available; then
  echo "  SKIP: this host has neither /proc nor lsof, so in-use detection cannot be exercised"
else
  # Three versions: one idle and large (so the warning still fires and the
  # exclusion has something to be reported alongside), one superseded AND live,
  # and the newest. Without the idle one the guard would fall silent and the
  # exclusion notice could not be observed at all.
  home=$(fake_home inuse)
  mkdir -p "$home/tmp"
  base="$home/.claude/plugins/cache/ralph-hero/ralph-knowledge"
  mkdir -p "$base/0.1.57/node_modules/bulk"
  dd if=/dev/zero of="$base/0.1.57/node_modules/bulk/blob" bs=1024 count=6144 \
    >/dev/null 2>&1
  busy_dir="$base/0.1.58"
  park_process "$busy_dir" >/dev/null
  out=$(run_guard "$home")

  # The whole finding: 0.1.58 is superseded AND live. It must not be counted
  # among the reclaimable dirs, while idle 0.1.57 still must be.
  if grep -qE '1 superseded plugin version' <<<"$out"; then
    pass "an in-use superseded version is excluded from the reclaimable count"
  else
    fail "an in-use superseded version was counted as reclaimable — deleting it breaks a live session" \
      "$out"
  fi

  # Its bytes must be excluded too, or the figure invites a delete that cannot
  # safely happen: 0.1.57 alone is ~6MB, both together ~12MB.
  reported=$(sed -n 's/.*Reclaimable cache detected: ~\([0-9]*\)MB.*/\1/p' <<<"$out")
  if [ -n "$reported" ] && [ "$reported" -lt 10 ]; then
    pass "the in-use version's bytes are excluded from the total (~${reported}MB)"
  else
    fail "the total (~${reported:-?}MB) includes bytes that cannot safely be deleted" "$out"
  fi

  if grep -q 'EXCLUDED' <<<"$out"; then
    pass "the in-use version is reported separately rather than silently dropped"
  else
    fail "the exclusion was silent — the user cannot tell why the number is lower" "$out"
  fi

  # And the old unconditional promise must be gone.
  if grep -qi 'Everything re-downloads on demand' <<<"$out"; then
    fail "the guard still claims everything re-downloads — a running session does not"
  else
    pass "no unconditional 're-downloads on demand' claim remains"
  fi
fi

echo "=== the advice always warns about open sessions ==="

home=$(fake_home advice)
mkdir -p "$home/tmp"
out=$(run_guard "$home")

if grep -qi 'close .*session' <<<"$out"; then
  pass "the advice tells the user to close other sessions first"
else
  fail "the advice never mentions closing sessions" "$out"
fi

if grep -qi 'does NOT re-download\|does not re-download' <<<"$out"; then
  pass "the advice states that a running session will not re-download"
else
  fail "the advice omits why an open session is a problem" "$out"
fi

# The legacy npx dirs ARE unconditionally safe — nothing launches through npx
# any more — and the guard should still say so plainly.
if grep -q '_npx' <<<"$out"; then
  pass "the legacy npx cache is still called out"
else
  fail "the legacy npx cache guidance disappeared" "$out"
fi

echo "=== source-level guards ==="

if grep -q 'dir_in_use' "$SRC"; then
  pass "the hook probes for in-use directories"
else
  fail "no in-use detection in the hook" "$(grep -n 'superseded' "$SRC")"
fi

# Unknown must not read as idle.
if grep -q 'USE_PROBE' "$SRC" && grep -q 'cannot be probed' "$SRC"; then
  pass "an unprobeable host degrades to a warning instead of claiming idleness"
else
  fail "no fallback for a host where use cannot be probed" "$(grep -n 'PROBE' "$SRC")"
fi

echo "=== the once-a-day stamp still suppresses repeat runs ==="

home=$(fake_home stamp)
mkdir -p "$home/tmp"
first=$(run_guard "$home")
second=$(run_guard "$home")
if [ -n "$first" ] && [ -z "$second" ]; then
  pass "the second run in a day is silent"
else
  fail "the daily stamp did not suppress the second run" "first=[$first] second=[$second]"
fi

echo
echo "disk-guard.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
