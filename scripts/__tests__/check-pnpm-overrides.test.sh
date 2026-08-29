#!/usr/bin/env bash
# Contract tests for scripts/check-pnpm-overrides.sh (GH-2257).
#
# The case that matters is the red one: a lockfile with the `overrides:` block
# deleted — the exact shape dependabot produced on #2081 — must fail and must
# NAME the dropped override. A guard that only ever runs green on the healthy
# tree proves nothing, which is why the drop is asserted here rather than left
# to a one-off CI run nobody repeats.

set -uo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/check-pnpm-overrides.sh"
TMP_ROOT=$(mktemp -d)
trap 'rm -rf "$TMP_ROOT"' EXIT

PASS=0
FAILED=0
pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1 — $2"; FAILED=$((FAILED + 1)); }

# fixture NAME PKG_OVERRIDES_JSON LOCK_OVERRIDES_BLOCK → echoes the dir
fixture() {
  local name="$1" pkg_ov="$2" lock_ov="$3"
  local d="$TMP_ROOT/$name"
  mkdir -p "$d"
  cat >"$d/package.json" <<PKG
{
  "name": "fixture",
  "private": true,
  "dependencies": { "remotion": "^4.0.509" }$pkg_ov
}
PKG
  {
    printf "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n\n"
    [ -n "$lock_ov" ] && printf '%s\n\n' "$lock_ov"
    printf 'importers:\n\n  .:\n    dependencies:\n      remotion:\n        specifier: ^4.0.509\n        version: 4.0.509\n'
  } >"$d/pnpm-lock.yaml"
  echo "$d"
}

WS_PKG=',
  "pnpm": { "overrides": { "ws@<8.20.1": "^8.20.1" } }'
WS_LOCK='overrides:
  ws@<8.20.1: ^8.20.1'

run() { bash "$SCRIPT" "$1" 2>&1; }

echo "=== check-pnpm-overrides.sh ==="

# 1. Healthy tree: override present in both.
d=$(fixture healthy "$WS_PKG" "$WS_LOCK")
out=$(run "$d"); rc=$?
if [ "$rc" -eq 0 ] && [[ "$out" == *"PNPM OVERRIDES PASS"* ]]; then
  pass "override present in both -> PASS [0]"
else
  fail "override present in both" "rc=$rc out=$out"
fi

# 2. The #2081 shape: package.json keeps the floor, the lockfile lost it.
d=$(fixture dropped "$WS_PKG" "")
out=$(run "$d"); rc=$?
if [ "$rc" -eq 1 ] && [[ "$out" == *"PNPM OVERRIDES FAIL"* ]]; then
  pass "deleted overrides block -> FAIL [1]"
else
  fail "deleted overrides block" "rc=$rc out=$out"
fi
if [[ "$out" == *'ws@<8.20.1'* ]]; then
  pass "failure names the dropped override"
else
  fail "failure names the dropped override" "out=$out"
fi

# 3. A weakened floor is the same defect as a deleted one.
d=$(fixture weakened "$WS_PKG" 'overrides:
  ws@<8.20.1: ^8.0.0')
out=$(run "$d"); rc=$?
if [ "$rc" -eq 1 ] && [[ "$out" == *'ws@<8.20.1'* ]] && [[ "$out" == *'^8.0.0'* ]]; then
  pass "weakened floor -> FAIL [1] naming both values"
else
  fail "weakened floor" "rc=$rc out=$out"
fi

# 4. No pnpm.overrides at all is a legitimate state, not a failure.
d=$(fixture none "" "")
out=$(run "$d"); rc=$?
if [ "$rc" -eq 0 ] && [[ "$out" == *"no pnpm.overrides declared"* ]]; then
  pass "no overrides declared -> PASS [0]"
else
  fail "no overrides declared" "rc=$rc out=$out"
fi

# 5. YAML may quote the key; the guard compares the key, not its spelling.
d=$(fixture quoted "$WS_PKG" "overrides:
  'ws@<8.20.1': ^8.20.1")
out=$(run "$d"); rc=$?
if [ "$rc" -eq 0 ]; then
  pass "quoted lockfile key -> PASS [0]"
else
  fail "quoted lockfile key" "rc=$rc out=$out"
fi

# 6. A block that ends where the next top-level key begins — a trailing
#    `patchedDependencies:` must not be read as an override, and an override
#    must not be missed because something follows the block.
d=$(fixture bounded "$WS_PKG" "overrides:
  ws@<8.20.1: ^8.20.1

patchedDependencies:
  ws@8.21.0: patches/ws.patch")
out=$(run "$d"); rc=$?
if [ "$rc" -eq 0 ]; then
  pass "block bounded by the next top-level key -> PASS [0]"
else
  fail "block bounded by the next top-level key" "rc=$rc out=$out"
fi

# 7. Unreadable inputs must not read as clean — the failure mode the guard
#    exists to remove, one layer in.
d=$(fixture badjson "$WS_PKG" "$WS_LOCK")
printf '{ not json' >"$d/package.json"
out=$(run "$d"); rc=$?
if [ "$rc" -eq 2 ] && [[ "$out" == *"PNPM OVERRIDES ERROR"* ]]; then
  pass "unparseable package.json -> ERROR [2]"
else
  fail "unparseable package.json" "rc=$rc out=$out"
fi

d=$(fixture nopkg "$WS_PKG" "$WS_LOCK")
rm -f "$d/package.json"
out=$(run "$d"); rc=$?
if [ "$rc" -eq 2 ]; then
  pass "lockfile with no package.json -> ERROR [2]"
else
  fail "lockfile with no package.json" "rc=$rc out=$out"
fi

# 8. The real tree passes — the guard is wired to files that exist.
REPO_ROOT="$(cd "$(dirname "$SCRIPT")/.." && pwd)"
out=$(bash "$SCRIPT" 2>&1); rc=$?
if [ "$rc" -eq 0 ]; then
  pass "repo tree (discovery, no args) -> PASS [0]"
else
  fail "repo tree (discovery, no args)" "rc=$rc out=$out"
fi
if [ -f "$REPO_ROOT/plugin/ralph-demo/remotion/pnpm-lock.yaml" ]; then
  pass "discovery covers the remotion lockfile this guard was filed for"
else
  fail "remotion lockfile present" "not found under $REPO_ROOT"
fi

echo "--- $PASS passed, $FAILED failed ---"
[ "$FAILED" -eq 0 ]
