#!/usr/bin/env bash
# scripts/__tests__/release-bump-type.test.sh
# Contract tests for scripts/release-bump-type.sh (GH-2122).
#
# No network and no gh stub — the rule is a pure function of git history, so
# each case is a throwaway repo built in $TMP_ROOT with real merge commits.
#
# The case that matters most is `branch-only-minor`: an annotation written in
# the branch commit and absent from the merge commit. That is what shipped
# ralph-v0.3.1 as a patch, and it is invisible to any test that only exercises
# the merge commit message.

set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/release-bump-type.sh"
TMP_ROOT=$(mktemp -d)
trap 'rm -rf "$TMP_ROOT"' EXIT

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

# repo NAME -> a git repo with one commit on main, path echoed
repo() {
  local name="$1" dir="$TMP_ROOT/$1"
  mkdir -p "$dir"
  git -C "$dir" init -q -b main
  git -C "$dir" config user.email t@example.com
  git -C "$dir" config user.name Test
  echo base > "$dir/f"
  git -C "$dir" add f
  git -C "$dir" commit -qm "base"
  echo "$dir"
}

# branch DIR BRANCH SUBJECT -> commits SUBJECT on a new branch off main
branch() {
  local dir="$1" br="$2" subject="$3" file
  file="${br//\//-}"
  git -C "$dir" checkout -q -b "$br" main
  echo "$br" > "$dir/$file"
  git -C "$dir" add "$file"
  git -C "$dir" commit -qm "$subject"
}

# merge DIR BRANCH MERGE_MSG -> merges BRANCH into main with that message
merge() {
  local dir="$1" br="$2" msg="$3"
  git -C "$dir" checkout -q main
  git -C "$dir" merge -q --no-ff -m "$msg" "$br"
}

# expect WANT_RC WANT_STDOUT DESC DIR [REV]
expect() {
  local want_rc="$1" want_out="$2" desc="$3" dir="$4" rev="${5:-HEAD}" out rc err
  err="$TMP_ROOT/.err"
  set +e
  out="$(cd "$dir" && bash "$SCRIPT" "$rev" 2>"$err")"
  rc=$?
  set -e
  if [ "$rc" -ne "$want_rc" ]; then
    fail "$desc — expected rc=$want_rc, got rc=$rc"
    sed 's/^/        /' "$err"
    return
  fi
  if [ "$out" != "$want_out" ]; then
    fail "$desc — expected '$want_out', got '$out'"
    sed 's/^/        /' "$err"
    return
  fi
  pass "$desc"
}

echo "=== release-bump-type.sh ==="

# The path that already worked: the annotation rides the PR title, which
# `gh pr merge --merge` puts in the merge commit body.
d=$(repo merge-minor)
branch "$d" feat/a "feat: a thing"
merge "$d" feat/a "Merge pull request #1 from feat/a

feat: a thing #minor"
expect 0 minor "annotation in the merge commit body" "$d"

# GH-2122 itself: the author wrote it where authors write it.
d=$(repo branch-minor)
branch "$d" feat/b "feat(board): new verb (GH-2108) #minor"
merge "$d" feat/b "Merge pull request #2 from feat/b

feat(board): new verb (GH-2108)"
expect 0 minor "annotation only on the branch commit" "$d"

# Precedence is across the whole set, not first-commit-wins.
d=$(repo major-beats-minor)
branch "$d" feat/c "feat: start #minor"
echo more > "$d/more"
git -C "$d" add more
git -C "$d" commit -qm "feat!: breaking #major"
merge "$d" feat/c "Merge pull request #3 from feat/c

feat: start #minor"
expect 0 major "#major on a later branch commit outranks #minor" "$d"

d=$(repo none)
branch "$d" feat/d "fix: a typo"
merge "$d" feat/d "Merge pull request #4 from feat/d

fix: a typo"
expect 0 patch "no annotation anywhere" "$d"

# GH-2102's word boundary, now re-asserted across the wider surface.
d=$(repo word-boundary)
branch "$d" feat/e "chore: refactoring, nothing #minorly interesting"
merge "$d" feat/e "Merge pull request #5 from feat/e

chore: refactoring"
expect 0 patch "#minorly is not an annotation" "$d"

d=$(repo case)
branch "$d" feat/f "feat: shout #MINOR"
merge "$d" feat/f "Merge pull request #6 from feat/f

feat: shout"
expect 0 minor "annotation match is case-insensitive" "$d"

# A `#major` already on main must not re-major every later release. `^1..^2`
# excludes it even when the branch merged main in.
d=$(repo main-history-excluded)
git -C "$d" checkout -q main
echo old > "$d/old"
git -C "$d" add old
git -C "$d" commit -qm "feat!: an old release #major"
branch "$d" feat/g "fix: unrelated"
merge "$d" feat/g "Merge pull request #7 from feat/g

fix: unrelated"
expect 0 patch "a #major already on main does not leak into the range" "$d"

# A branch that merged main into itself carries main's commits in its own
# history — they are still reachable from ^1, so still excluded.
d=$(repo merged-main-excluded)
git -C "$d" checkout -q main
echo old > "$d/old"
git -C "$d" add old
git -C "$d" commit -qm "feat!: an old release #major"
git -C "$d" checkout -q -b feat/h HEAD~1
echo h > "$d/h"
git -C "$d" add h
git -C "$d" commit -qm "fix: unrelated"
git -C "$d" merge -q --no-ff -m "Merge main into feat/h" main
merge "$d" feat/h "Merge pull request #8 from feat/h

fix: unrelated"
expect 0 patch "a #major the branch merged FROM main does not leak" "$d"

# The regression this script's own first version shipped: scanning full branch
# commit BODIES matched prose *about* the annotation. Its own merge reported
# `major` off a body line reading "#major outranks #minor across the whole
# set" — strictly worse than the defect it fixed, since the old reader only
# ever saw the short PR title. Branch commits are read by SUBJECT only.
d=$(repo branch-body-prose)
git -C "$d" checkout -q -b feat/i main
echo i > "$d/i"
git -C "$d" add i
git -C "$d" commit -qm "fix(release): read the annotation where authors write it

#major outranks #minor across the whole set, never first-commit-wins."
merge "$d" feat/i "Merge pull request #9 from feat/i

fix(release): read the annotation where authors write it"
expect 0 patch "prose in a branch commit BODY is not an annotation" "$d"

# The other half of that bound: the merge commit keeps its FULL-message scan,
# because that is where `gh pr merge --merge` puts the PR title.
d=$(repo merge-body-still-counts)
branch "$d" feat/j "feat: a thing"
merge "$d" feat/j "Merge pull request #10 from feat/j

feat: a thing #minor"
expect 0 minor "the merge commit body still counts (the PR title lives there)" "$d"

# Not a merge: expected on an admin push, degrades to the commit's own message.
d=$(repo not-a-merge)
git -C "$d" checkout -q main
echo x > "$d/x"
git -C "$d" add x
git -C "$d" commit -qm "chore: direct push #minor"
expect 0 minor "a non-merge HEAD reads its own message" "$d"

# An unreadable source is an error, never a quiet `patch` — the whole point.
d=$(repo bad-rev)
expect 2 "" "an unresolvable rev exits 2" "$d" "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"

echo
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
