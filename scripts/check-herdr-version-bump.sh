#!/bin/bash
# ralph-herdr manifest guard (GH-1976, narrowed by GH-2491).
#
# Usage: ./scripts/check-herdr-version-bump.sh [BASE_REF] [HEAD_REF]
#        defaults: origin/main HEAD
#
# GH-1976 made this a per-PR gate: a diff touching the plugin's behavior
# surface (scripts/**, cockpit/** non-test, herdr-plugin.toml) had to move
# the version stamp in the same PR. With 8-12 ralph-herdr PRs open at once
# that stamp collided on nearly every merge — 16 CI failures and 12 rebase
# conflicts measured 2026-09-02..04 (thoughts/shared/ideas — GH-2491). The
# stamp now moves once, at release time (scripts/herdr-plugin-release-bump.sh,
# run from release-ralph.yml), so this script no longer requires a bump —
# it keeps the two checks that don't depend on WHEN the stamp moves:
#
#   1. the manifest must be valid TOML at HEAD (GH-2431: an unescaped regex
#      literal in the description broke every install for three releases,
#      and the old bump-only check never noticed because it only grepped the
#      version line, which stayed readable while the file around it didn't
#      parse)
#   2. the behavior-surface classifier still runs, informationally — its
#      count is what the release-time bump reads too (scripts/lib/
#      herdr-behavior-surface.sh), so a PR sees here what it will eventually
#      cost at the next release, without being blocked on it now.
#
# Output contract:
#   HERDR VERSION BUMP PASS  — ...   [0]
#   HERDR VERSION BUMP ERROR — ...   [2]
#
# Exit 2 is deliberate for an unreadable ref or an unparseable manifest: this
# guard exists because an absent signal read as "fine" once already, so a scan
# that cannot see the tree must not report the tree as clean.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/herdr-behavior-surface.sh
source "$REPO_ROOT/scripts/lib/herdr-behavior-surface.sh"

BASE_REF="${1:-origin/main}"
HEAD_REF="${2:-HEAD}"

MANIFEST="plugin/ralph-herdr/herdr-plugin.toml"

die() { echo "HERDR VERSION BUMP ERROR — $1" >&2; exit 2; }

git rev-parse --verify "${BASE_REF}^{commit}" >/dev/null 2>&1 \
  || die "cannot resolve base ref '$BASE_REF' (a shallow checkout needs fetch-depth: 0)"
git rev-parse --verify "${HEAD_REF}^{commit}" >/dev/null 2>&1 \
  || die "cannot resolve head ref '$HEAD_REF'"

MERGE_BASE=$(git merge-base "$BASE_REF" "$HEAD_REF") \
  || die "no merge base between '$BASE_REF' and '$HEAD_REF'"

# The manifest must be valid TOML at HEAD, independent of anything else below
# — GH-2431: a description string carrying an unescaped regex literal (`\[`
# `\]`, not a legal TOML basic-string escape) broke `herdr plugin install` for
# every release after 0.51.3, and nothing here noticed because the old
# bump check only greps for the version line, which stays readable even when
# the file around it doesn't parse.
#
# The parser is python3's stdlib tomllib (3.11+). Its absence is its OWN
# reason code, never conflated with a broken manifest: a machine without it
# cannot see the file, and "cannot see" is the exit-2 shape above, not a
# pass — but the message must name the missing parser, or a valid manifest
# on an old python reads as corrupt.
python3 -c 'import tomllib' >/dev/null 2>&1 \
  || die "python3 >= 3.11 (tomllib) is required to validate $MANIFEST; not found on PATH"
manifest_blob=$(git show "${HEAD_REF}:${MANIFEST}" 2>/dev/null) || die "cannot read $MANIFEST at $HEAD_REF"
python3 -c 'import sys, tomllib; tomllib.loads(sys.stdin.read())' <<<"$manifest_blob" \
  || die "$MANIFEST at $HEAD_REF is not valid TOML"

behavior=()
while IFS= read -r p; do
  [ -n "$p" ] || continue
  behavior+=("$p")
done < <(herdr_behavior_files "$MERGE_BASE" "$HEAD_REF" "$MANIFEST")

if [ "${#behavior[@]}" -eq 0 ]; then
  echo "HERDR VERSION BUMP PASS — no ralph-herdr behavior files in ${MERGE_BASE:0:8}..${HEAD_REF}"
  exit 0
fi

echo "HERDR VERSION BUMP PASS — ${#behavior[@]} behavior file(s) changed; the version stamp moves at the next release, not in this PR (GH-2491):"
printf '    %s\n' "${behavior[@]}"
