#!/usr/bin/env bash
# scripts/release-bump-type.sh — decide a release bump type from the commit
# annotations a merge actually carries (GH-2122).
#
# Prints `patch`, `minor` or `major` on stdout and narrates the source on
# stderr. Exit 2 when a source that must be readable could not be read.
#
# Why this reads more than one commit. The release job used to read the
# annotation off `git log -1` — the MERGE commit, whose message `gh pr merge
# --merge` composes from the PR *title*. An author writing `#minor` where an
# author naturally writes it, in the commit message on the branch, produced a
# merge commit that never mentioned it, and the release silently took a patch
# bump (observed: PR #2119 shipped the new `board reap-leases` verb as
# ralph-v0.3.1). The rule was read from a surface nobody writes to.
#
# The fix is at the reader rather than at the merge path: making
# `merge-pr.sh` propagate the annotation would be correct only for merges that
# go through it, leaving the GitHub UI and auto-merge on the original silent
# failure, and would put the release rule in a second file to drift.
#
# Precedence is major over minor across the WHOLE set, never first-commit-wins:
# a branch whose first commit says `#minor` and whose last says `#major` is a
# major release.
#
# What is read: the merge commit's full message, plus the SUBJECT LINE of each
# commit the merge brought in. See find_annotation for why the branch half is
# subject-only — full bodies match prose ABOUT the annotation, which is worse
# than the defect this fixes.
set -euo pipefail

REV="${1:-HEAD}"

if ! git rev-parse -q --verify "${REV}^{commit}" >/dev/null 2>&1; then
  echo "release-bump-type: cannot resolve '${REV}' to a commit" >&2
  exit 2
fi

# The merge commit itself: still authoritative, because the PR title lands in
# its body and that is where the documented rule has always pointed.
shas=("$(git rev-parse "${REV}^{commit}")")

# The commits the PR brought in. `^1..^2` is exactly that set: anything the
# branch merged FROM main is reachable from ^1 and therefore excluded, so an
# old `#major` on main can never leak in and re-major a later release.
#
# No second parent is the expected shape of a non-merge push (an admin push, a
# squash), not a failure — degrade to the merge message and say so. A second
# parent that exists but cannot be walked is the other case: a source we know
# is there and could not read, and answering `patch` there would be this
# issue's own defect relocated into the fix.
if git rev-parse -q --verify "${REV}^2" >/dev/null 2>&1; then
  if ! range=$(git rev-list "${REV}^1..${REV}^2" 2>&1); then
    echo "release-bump-type: ${REV} has a second parent but its commits could not be listed:" >&2
    printf '%s\n' "$range" | sed 's/^/  /' >&2
    exit 2
  fi
  while read -r sha; do
    if [ -n "$sha" ]; then shas+=("$sha"); fi
  done <<<"$range"
else
  echo "release-bump-type: ${REV} is not a merge — reading its own message only" >&2
fi

# Word-bounded and case-insensitive (GH-2102): `#minor` in `refactoring` or
# `#minorly` is not an annotation.
#
# A branch commit is scanned by its SUBJECT LINE ONLY, and that bound is
# load-bearing rather than tidy. An annotation is a subject-line suffix — the
# founding case, PR #2119, wrote `... (GH-2108) #minor` at the end of the
# subject — while a commit *body* is prose, and prose about this rule contains
# the very tokens it describes. Scanning full bodies made the first version of
# this script report `major` for its own merge, off a body line reading
# "`#major` outranks `#minor` across the whole set": strictly worse than the
# defect it fixed, since the old reader only ever saw the short PR title.
#
# The merge commit keeps its full-message scan, unchanged: `gh pr merge
# --merge` puts the PR title in the BODY, so a subject-only rule there would
# discard the one surface the documented rule has always named.
#
# Returns 0 (found, sha on stdout), 1 (absent) or 2 (a message could not be
# read). It may NOT `exit` on that last case: the caller runs it inside a
# command substitution, where `exit` leaves only the subshell and the failure
# would fall through to the `patch` default — this issue's own defect,
# reintroduced by its fix. The caller propagates rc 2 instead.
find_annotation() {
  local kind="$1" i sha fmt msg
  for i in "${!shas[@]}"; do
    sha="${shas[$i]}"
    if [ "$i" -eq 0 ]; then fmt='%B'; else fmt='%s'; fi
    if ! msg=$(git log -1 --pretty="$fmt" "$sha" 2>&1); then
      echo "release-bump-type: could not read the message of ${sha}:" >&2
      printf '%s\n' "$msg" | sed 's/^/  /' >&2
      return 2
    fi
    # A here-string, never a pipe: `grep -q` exits on first match, and under
    # `pipefail` that SIGPIPEs the producer into exit 141.
    if grep -qiE "(^|[[:space:]])#${kind}([[:space:]]|\$)" <<<"$msg"; then
      printf '%s\n' "$sha"
      return 0
    fi
  done
  return 1
}

describe() {
  local sha="$1"
  if [ "$sha" = "${shas[0]}" ]; then
    echo "merge commit ${sha:0:8}"
  else
    echo "branch commit subject ${sha:0:8}"
  fi
}

for kind in major minor; do
  set +e
  found=$(find_annotation "$kind")
  rc=$?
  set -e
  if [ "$rc" -eq 2 ]; then exit 2; fi
  if [ "$rc" -eq 0 ]; then
    echo "Bump type: ${kind} (annotation on $(describe "$found"))" >&2
    echo "$kind"
    exit 0
  fi
done

echo "Bump type: patch (default — no #minor/#major in the merge commit message or in the subject of the $(( ${#shas[@]} - 1 )) commit(s) it brought in)" >&2
echo patch
