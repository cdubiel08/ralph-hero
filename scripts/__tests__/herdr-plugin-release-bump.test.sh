#!/usr/bin/env bash
# Contract tests for scripts/herdr-plugin-release-bump.sh (GH-2491).
#
# Each case is a throwaway git repo: the script is a pure function of a
# commit range plus the working tree it's run from, so no network, no gh, no
# herdr. The cases that matter: a behavior change since the last ralph-v* tag
# bumps the stamp in the CURRENT working tree (never wherever the script
# itself is installed — the exact bug caught during manual verification: an
# earlier draft resolved paths off the script's own location and silently
# mutated the real repo's manifest while "testing" a fixture); a docs-only or
# absent diff leaves the stamp untouched; an unreadable ref or tag-less repo
# errors rather than reading as "nothing to do".

set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/herdr-plugin-release-bump.sh"
TMP_ROOT=$(mktemp -d)
trap 'rm -rf "$TMP_ROOT"' EXIT

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1 — $2"; FAIL=$((FAIL + 1)); }

# repo NAME -> a git repo with a base commit tagged ralph-v0.1.0, and a second
# commit already checked out on main. Echoes the path.
repo() {
  local name="$1"
  local d="$TMP_ROOT/$name"
  mkdir -p "$d/plugin/ralph-herdr/scripts" "$d/ralph/scripts"
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
  git -C "$d" tag ralph-v0.1.0
  echo "$d"
}

commit() { git -C "$1" add -A; git -C "$1" commit -qm "$2"; }

echo "== herdr-plugin-release-bump.sh =="

# 1. a behavior change since the last tag bumps the stamp in THIS repo's
#    working tree, walking the patch forward from the manifest's own version.
d=$(repo behavior)
echo 'echo changed' >"$d/plugin/ralph-herdr/scripts/spawn.sh"
commit "$d" "change spawn"
out=$(cd "$d" && bash "$SCRIPT" 2>&1); rc=$?
manifest_ver=$(grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' "$d/plugin/ralph-herdr/herdr-plugin.toml" | head -1)
stamp_ver=$(cat "$d/ralph/scripts/herdr-plugin-version")
if [ "$rc" -eq 0 ] && grep -q 'bumped=true' <<<"$out" && grep -q 'new=0.6.1' <<<"$out" \
   && [ "$manifest_ver" = "0.6.1" ] && [ "$stamp_ver" = "0.6.1" ]; then
  pass "behavior change bumps both files in the working tree (rc=$rc)"
else
  fail "behavior change bumps both files" "rc=$rc manifest=$manifest_ver stamp=$stamp_ver out=$out"
fi

# 2. no behavior change since the last tag -> bumped=false, files untouched.
d=$(repo nochange)
echo '# more readme' >>"$d/plugin/ralph-herdr/README.md"
commit "$d" "docs"
out=$(cd "$d" && bash "$SCRIPT" 2>&1); rc=$?
manifest_ver=$(grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' "$d/plugin/ralph-herdr/herdr-plugin.toml" | head -1)
if [ "$rc" -eq 0 ] && grep -q '^bumped=false$' <<<"$out" && ! grep -q '^new=' <<<"$out" \
   && [ "$manifest_ver" = "0.6.0" ]; then
  pass "docs-only change skips the bump (rc=$rc)"
else
  fail "docs-only change skips the bump" "rc=$rc manifest=$manifest_ver out=$out"
fi

# 3. explicit BASE_REF/HEAD_REF (the dry-run shape the release step's own
#    Verification section calls for) works the same as the tag-derived
#    default.
d=$(repo explicitrefs)
echo 'echo changed' >"$d/plugin/ralph-herdr/scripts/spawn.sh"
commit "$d" "change spawn"
out=$(cd "$d" && bash "$SCRIPT" ralph-v0.1.0 HEAD 2>&1); rc=$?
if [ "$rc" -eq 0 ] && grep -q 'bumped=true' <<<"$out"; then
  pass "explicit BASE_REF/HEAD_REF bumps (rc=$rc)"
else
  fail "explicit BASE_REF/HEAD_REF bumps" "rc=$rc out=$out"
fi

# 4. an unresolvable BASE_REF is an ERROR, never a silent skip.
d=$(repo badbase)
set +e
out=$(cd "$d" && bash "$SCRIPT" nope/such HEAD 2>&1); rc=$?
set -e
if [ "$rc" -eq 2 ] && grep -q 'ERROR' <<<"$out"; then
  pass "unresolvable base ref errors (rc=$rc)"
else
  fail "unresolvable base ref errors" "rc=$rc out=$out"
fi

# 5. a repo with no ralph-v* tag and no explicit BASE_REF errors, naming the
#    missing tag rather than silently treating everything as new.
d="$TMP_ROOT/notags"
mkdir -p "$d/plugin/ralph-herdr/scripts" "$d/ralph/scripts"
git -C "$d" init -q -b main
git -C "$d" config user.email t@example.com
git -C "$d" config user.name Test
printf 'id = "ralph-herdr"\nversion = "0.6.0"\n' >"$d/plugin/ralph-herdr/herdr-plugin.toml"
git -C "$d" add -A
git -C "$d" commit -qm base
set +e
out=$(cd "$d" && bash "$SCRIPT" 2>&1); rc=$?
set -e
if [ "$rc" -eq 2 ] && grep -q 'ralph-v' <<<"$out"; then
  pass "no ralph-v* tag to diff from errors (rc=$rc)"
else
  fail "no ralph-v* tag to diff from errors" "rc=$rc out=$out"
fi

# 6. a manifest with no parseable version line errors rather than bumping to
#    a bogus value.
d=$(repo noversion)
printf 'id = "ralph-herdr"\n' >"$d/plugin/ralph-herdr/herdr-plugin.toml"
echo 'echo changed' >"$d/plugin/ralph-herdr/scripts/spawn.sh"
commit "$d" "break the version line"
set +e
out=$(cd "$d" && bash "$SCRIPT" 2>&1); rc=$?
set -e
if [ "$rc" -eq 2 ] && grep -q 'no parseable' <<<"$out"; then
  pass "unparseable manifest version errors (rc=$rc)"
else
  fail "unparseable manifest version errors" "rc=$rc out=$out"
fi

echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
