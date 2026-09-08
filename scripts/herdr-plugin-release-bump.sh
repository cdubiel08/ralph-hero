#!/bin/bash
# ralph-herdr release-time version stamp bump (GH-2491).
#
# Companion to scripts/check-herdr-version-bump.sh: that script validates the
# manifest is parseable TOML and reports the behavior-surface diff
# informationally; this script is what actually MOVES the stamp, now that the
# per-PR bump requirement is gone (8-12 ralph-herdr PRs open at once
# collided on it nearly every merge — 16 CI failures and 12 rebase conflicts
# measured 2026-09-02..04). It runs from release-ralph.yml, once per fire of
# that workflow, so the stamp advances at most once per ralph release rather
# than once per PR.
#
# Usage: ./scripts/herdr-plugin-release-bump.sh [BASE_REF] [HEAD_REF]
#   BASE_REF defaults to the highest reachable `ralph-v*` tag — the boundary
#   of the last release this workflow already produced, so "since the last
#   release" needs no separate bookkeeping.
#   HEAD_REF defaults to HEAD.
#
# Run this from the repo root, AFTER release-ralph.yml's `git pull --rebase`
# and immediately BEFORE its `git tag` — never earlier. The diff is by ref, so
# it must see everything the tag is about to cover: a herdr behavior merge
# landing between "Advance to current main" and the rebase would otherwise be
# tagged under a stale stamp and, sitting below the tag, be invisible to every
# later run's diff (Greptile P1 on #2507). The new stamp is WRITTEN INTO THE
# CURRENT WORKING TREE at $MANIFEST/$STAMP (paths relative to cwd, like every
# git command here — never the script's own install location) so the job can
# `git add` both files and amend them into the release commit.
#
# Prints exactly one `key=value` line per line to stdout, GITHUB_OUTPUT-ready:
#   bumped=false                — no ralph-herdr behavior file changed since
#                                  BASE_REF; nothing written
#   bumped=true
#   new=X.Y.Z                   — the manifest/stamp were rewritten in the
#                                  working tree to this version
#
# Exit 2 (same discipline as check-herdr-version-bump.sh): an unreadable ref
# or a manifest with no parseable version line must never read as "nothing to
# do" — a missing signal here is exactly the failure GH-1976 removed for the
# per-PR case, and release time gets no lesser standard.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/herdr-behavior-surface.sh
source "$REPO_ROOT/scripts/lib/herdr-behavior-surface.sh"

MANIFEST="plugin/ralph-herdr/herdr-plugin.toml"
STAMP="ralph/scripts/herdr-plugin-version"

die() { echo "HERDR PLUGIN BUMP ERROR — $1" >&2; exit 2; }

BASE_REF="${1:-}"
HEAD_REF="${2:-HEAD}"

if [ -z "$BASE_REF" ]; then
  latest_tag_ver=$( (git tag --list 'ralph-v*' | sed -E 's/^ralph-v//' \
    | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1) || true)
  [ -n "$latest_tag_ver" ] \
    || die "no ralph-v* tag found to diff from (pass BASE_REF explicitly for a fixture/dry-run)"
  BASE_REF="ralph-v${latest_tag_ver}"
fi

git rev-parse --verify "${BASE_REF}^{commit}" >/dev/null 2>&1 \
  || die "cannot resolve base ref '$BASE_REF'"
git rev-parse --verify "${HEAD_REF}^{commit}" >/dev/null 2>&1 \
  || die "cannot resolve head ref '$HEAD_REF'"

behavior=()
while IFS= read -r p; do
  [ -n "$p" ] || continue
  behavior+=("$p")
done < <(herdr_behavior_files "$BASE_REF" "$HEAD_REF" "$MANIFEST")

if [ "${#behavior[@]}" -eq 0 ]; then
  echo "HERDR PLUGIN BUMP SKIP — no ralph-herdr behavior change since $BASE_REF" >&2
  echo "bumped=false"
  exit 0
fi

[ -f "$MANIFEST" ] || die "$MANIFEST not found in the working tree (run from the repo root)"
current=$( (grep -Eo '^version = "[0-9]+\.[0-9]+\.[0-9]+"' "$MANIFEST" \
  | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -1) || true)
[ -n "$current" ] || die "no parseable 'version = \"x.y.z\"' in $MANIFEST"

IFS='.' read -r MAJOR MINOR PATCH <<<"$current"
NEW_VERSION="${MAJOR}.${MINOR}.$((PATCH + 1))"

perl -pi -e "s/^version = \"[0-9]+\.[0-9]+\.[0-9]+\"/version = \"$NEW_VERSION\"/" "$MANIFEST"
printf '%s\n' "$NEW_VERSION" >"$STAMP"

echo "HERDR PLUGIN BUMP — ${#behavior[@]} behavior file(s) changed since $BASE_REF, version $current → $NEW_VERSION" >&2
printf '    %s\n' "${behavior[@]}" >&2
echo "bumped=true"
echo "new=$NEW_VERSION"
