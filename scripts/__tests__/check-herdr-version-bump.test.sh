#!/usr/bin/env bash
# Contract tests for scripts/check-herdr-version-bump.sh (GH-1976).
#
# Each case is a throwaway git repo: the guard is a pure function of a commit
# range, so no network, no gh, no herdr. The cases that matter are the two
# directions this guard can be wrong in — a prose-only diff must not redden
# (or people learn to bump for nothing, and the stamp stops meaning anything),
# and an unreadable ref must not read as clean, which is the exact failure
# mode the guard exists to remove.

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

bump() { # bump <repo> <version>
  perl -pi -e "s/^version = \".*\"/version = \"$2\"/" "$1/plugin/ralph-herdr/herdr-plugin.toml"
  echo "$2" >"$1/ralph/scripts/herdr-plugin-version"
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

# 1. script changed, no bump → FAIL. The GH-1808 shape.
d=$(repo unbumped)
echo 'echo changed' >"$d/plugin/ralph-herdr/scripts/spawn.sh"
commit "$d" "change spawn"
expect 1 "changed script without a bump fails" "$d"

# 2. same change, bumped → PASS
d=$(repo bumped)
echo 'echo changed' >"$d/plugin/ralph-herdr/scripts/spawn.sh"
bump "$d" 0.7.0
commit "$d" "change spawn + bump"
expect 0 "changed script with a bump passes" "$d"

# 3. a NEW script counts, not just an edited one — GH-1808 added roles.sh.
d=$(repo newscript)
echo 'echo roles' >"$d/plugin/ralph-herdr/scripts/roles.sh"
commit "$d" "add roles.sh"
expect 1 "a new script without a bump fails" "$d"

# 4. prose only → PASS. A guard that reddened here would teach people to bump
#    for nothing, and a stamp that moves for non-behavior stops being a signal.
d=$(repo prose)
echo '# more readme' >>"$d/plugin/ralph-herdr/README.md"
commit "$d" "docs"
expect 0 "README-only change needs no bump" "$d"

# 5. tests/features are never installed into a cockpit → PASS
d=$(repo tests)
echo 'echo test' >"$d/plugin/ralph-herdr/tests/new.test.sh"
commit "$d" "test only"
expect 0 "tests-only change needs no bump" "$d"

# 6. Go cockpit source counts; its _test.go twin does not.
d=$(repo cockpit)
echo 'package main' >"$d/plugin/ralph-herdr/cockpit/view.go"
commit "$d" "cockpit source"
expect 1 "cockpit Go source without a bump fails" "$d"

d=$(repo cockpittest)
echo 'package main' >"$d/plugin/ralph-herdr/cockpit/view_test.go"
commit "$d" "cockpit test"
expect 0 "cockpit _test.go needs no bump" "$d"

# 7. the manifest is itself behavior — a new action changes what a cockpit
#    does, so editing it without moving the version still fails.
d=$(repo manifest)
printf '\n[[actions]]\nid = "x"\n' >>"$d/plugin/ralph-herdr/herdr-plugin.toml"
commit "$d" "new action"
expect 1 "manifest edit without a bump fails" "$d"

# 8. nothing touched at all → PASS
d=$(repo untouched)
echo hi >"$d/other.txt"
commit "$d" "unrelated"
expect 0 "unrelated change passes" "$d"

# 9. an unreadable base ref is an ERROR, never a pass. The whole point of this
#    guard is that a missing signal was read as "fine" once already.
d=$(repo badref)
expect 2 "unresolvable base ref errors" "$d" nope/such

# 10. the guard reads the plugin's own version, not min_herdr_version.
d=$(repo minver)
echo 'echo changed' >"$d/plugin/ralph-herdr/scripts/spawn.sh"
perl -pi -e 's/^min_herdr_version = ".*"/min_herdr_version = "0.9.0"/' \
  "$d/plugin/ralph-herdr/herdr-plugin.toml"
commit "$d" "bump the wrong line"
expect 1 "moving min_herdr_version is not a bump" "$d"

echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
