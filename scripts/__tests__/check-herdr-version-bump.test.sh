#!/usr/bin/env bash
# Contract tests for scripts/check-herdr-version-bump.sh (GH-1976, narrowed
# by GH-2491).
#
# Each case is a throwaway git repo: the guard is a pure function of a commit
# range, so no network, no gh, no herdr. GH-2491 removed the per-PR bump
# requirement (moved to release time, scripts/herdr-plugin-release-bump.sh),
# so a behavior-surface diff no longer fails this script — the cases that
# matter now are that it still validates the manifest is parseable TOML
# (GH-2431) and that an unreadable ref still errors rather than reading as
# clean.

set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/check-herdr-version-bump.sh"
TMP_ROOT=$(mktemp -d)
trap 'rm -rf "$TMP_ROOT"' EXIT

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1 — $2"; FAIL=$((FAIL + 1)); }

# repo NAME → a git repo with a base commit on `main` and a `topic` branch
# checked out. Echoes the path.
repo() {
  local name="$1"
  local d="$TMP_ROOT/$name"
  mkdir -p "$d/plugin/ralph-herdr/scripts" "$d/plugin/ralph-herdr/tests" \
           "$d/plugin/ralph-herdr/cockpit" "$d/ralph/scripts"
  git -C "$d" init -q -b main
  git -C "$d" config user.email t@example.com
  git -C "$d" config user.name Test
  printf 'id = "ralph-herdr"\nversion = "0.6.0"\nmin_herdr_version = "0.8.0"\n' \
    >"$d/plugin/ralph-herdr/herdr-plugin.toml"
  echo 0.6.0 >"$d/ralph/scripts/herdr-plugin-version"
  echo 'echo hi' >"$d/plugin/ralph-herdr/scripts/spawn.sh"
  echo '# readme' >"$d/plugin/ralph-herdr/README.md"
  git -C "$d" add -A
  git -C "$d" commit -qm base
  git -C "$d" checkout -qb topic
  echo "$d"
}

commit() { git -C "$1" add -A; git -C "$1" commit -qm "$2"; }

# expect WANT_RC DESC REPO [BASE] [HEAD]
expect() {
  local want="$1" desc="$2" d="$3" base="${4:-main}" head="${5:-HEAD}" out rc
  set +e
  out=$(cd "$d" && bash "$SCRIPT" "$base" "$head" 2>&1)
  rc=$?
  set -e
  if [ "$rc" -eq "$want" ]; then pass "$desc (rc=$rc)"
  else fail "$desc" "want rc=$want got $rc: $out"; fi
}

echo "== check-herdr-version-bump.sh =="

# 1. a changed script needs no bump anymore (GH-2491) — the stamp moves at
#    release time, not in this PR.
d=$(repo unbumped)
echo 'echo changed' >"$d/plugin/ralph-herdr/scripts/spawn.sh"
commit "$d" "change spawn"
expect 0 "changed script needs no in-PR bump" "$d"

# 2. a NEW script is still counted in the informational behavior-file list —
#    GH-1808 added roles.sh this way — but still passes.
d=$(repo newscript)
echo 'echo roles' >"$d/plugin/ralph-herdr/scripts/roles.sh"
commit "$d" "add roles.sh"
expect 0 "a new script needs no in-PR bump" "$d"

# 3. prose only → PASS, unchanged from before GH-2491.
d=$(repo prose)
echo '# more readme' >>"$d/plugin/ralph-herdr/README.md"
commit "$d" "docs"
expect 0 "README-only change needs no bump" "$d"

# 4. tests/features are never installed into a cockpit → PASS
d=$(repo tests)
echo 'echo test' >"$d/plugin/ralph-herdr/tests/new.test.sh"
commit "$d" "test only"
expect 0 "tests-only change needs no bump" "$d"

# 5. Go cockpit source and its _test.go twin both pass now; only the
#    classification (not the gate) still tells them apart informationally.
d=$(repo cockpit)
echo 'package main' >"$d/plugin/ralph-herdr/cockpit/view.go"
commit "$d" "cockpit source"
expect 0 "cockpit Go source needs no in-PR bump" "$d"

d=$(repo cockpittest)
echo 'package main' >"$d/plugin/ralph-herdr/cockpit/view_test.go"
commit "$d" "cockpit test"
expect 0 "cockpit _test.go needs no bump" "$d"

# 6. the manifest itself is behavior — still passes without a bump.
d=$(repo manifest)
printf '\n[[actions]]\nid = "x"\n' >>"$d/plugin/ralph-herdr/herdr-plugin.toml"
commit "$d" "new action"
expect 0 "manifest edit needs no in-PR bump" "$d"

# 7. nothing touched at all → PASS
d=$(repo untouched)
echo hi >"$d/other.txt"
commit "$d" "unrelated"
expect 0 "unrelated change passes" "$d"

# 8. an unreadable base ref is an ERROR, never a pass. The whole point of this
#    guard is that a missing signal was read as "fine" once already.
d=$(repo badref)
expect 2 "unresolvable base ref errors" "$d" nope/such

# 9. an unparseable manifest is an ERROR even when nothing else in the diff
#    looks suspicious — the GH-2431 shape: an unescaped regex literal in the
#    description string breaks the TOML parser without touching anything the
#    old bump check (or the current behavior classifier) inspects.
d=$(repo brokentoml)
printf 'description = "bad \\[ \\] escape"\n' >>"$d/plugin/ralph-herdr/herdr-plugin.toml"
commit "$d" "break the manifest"
expect 2 "unparseable TOML manifest errors" "$d"

# 10. no usable tomllib is its OWN error, named as such — never "not valid
#     TOML" (a valid manifest on a pre-3.11 python must not read as corrupt),
#     and never a pass (a parser that cannot see the file is the exit-2 shape).
d=$(repo nopython)
echo 'echo changed' >"$d/plugin/ralph-herdr/scripts/spawn.sh"
commit "$d" "change"
shim="$TMP_ROOT/shim"; mkdir -p "$shim"
printf '#!/bin/sh\nexit 1\n' >"$shim/python3"; chmod +x "$shim/python3"
set +e
out=$(cd "$d" && PATH="$shim:$PATH" bash "$SCRIPT" main HEAD 2>&1); rc=$?
set -e
if [ "$rc" -eq 2 ] && grep -q 'tomllib' <<<"$out" && ! grep -q 'not valid TOML' <<<"$out"; then
  pass "missing tomllib errors and names the parser (rc=$rc)"
else
  fail "missing tomllib errors and names the parser" "want rc=2 naming tomllib, got rc=$rc: $out"
fi

# 11. the informational message still names the changed behavior file(s), so
#     a PR sees what it will eventually cost at the next release.
d=$(repo listed)
echo 'echo changed' >"$d/plugin/ralph-herdr/scripts/spawn.sh"
commit "$d" "change spawn"
out=$(cd "$d" && bash "$SCRIPT" main HEAD 2>&1); rc=$?
if [ "$rc" -eq 0 ] && grep -q 'plugin/ralph-herdr/scripts/spawn.sh' <<<"$out"; then
  pass "PASS message names the changed behavior file"
else
  fail "PASS message names the changed behavior file" "got rc=$rc: $out"
fi

echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
