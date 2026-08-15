#!/bin/bash
# ralph-herdr version-stamp guard (GH-1976).
#
# Usage: ./scripts/check-herdr-version-bump.sh [BASE_REF] [HEAD_REF]
#        defaults: origin/main HEAD
#
# The herdr half of the cockpit does not auto-update — herdr has no
# `plugin update` — so the version in plugin/ralph-herdr/herdr-plugin.toml
# (mirrored by ralph/scripts/herdr-plugin-version) is the ONLY signal that
# tells an installed cockpit to reinstall. GH-1808 shipped a new script and a
# changed spawn path without moving it, and nothing noticed: the existing
# check compares the two stamps to EACH OTHER, which says nothing about
# whether either tracks the code. A behavior change that leaves the stamp
# alone is therefore invisible by construction.
#
# This guard closes that gap from the other side: if the diff touches the
# plugin's behavior surface, the manifest version must have moved.
#
# What counts as behavior (the interesting half of this issue):
#
#   yes — scripts/**            the plugin IS its scripts
#   yes — cockpit/** (non-test) the TUI a reinstall would replace
#   yes — herdr-plugin.toml     actions, panes, events, link handlers
#   no  — *.md                  README/CHEATSHEET describe, never run
#   no  — tests/**, features/** never installed into a cockpit
#
# The rule is "would a cockpit installed yesterday behave differently after
# reinstalling?" Prose and test scaffolding never ship into the install, so a
# guard that reddened on them would train people to bump for nothing — and a
# stamp that moves for reasons unrelated to behavior stops meaning anything.
#
# Output contract:
#   HERDR VERSION BUMP PASS  — ...   [0]
#   HERDR VERSION BUMP FAIL  — ...   [1]
#   HERDR VERSION BUMP ERROR — ...   [2]
#
# Exit 2 is deliberate for an unreadable ref or an unparseable manifest: this
# guard exists because an absent signal read as "fine" once already, so a scan
# that cannot see the tree must not report the tree as clean.

set -euo pipefail

BASE_REF="${1:-origin/main}"
HEAD_REF="${2:-HEAD}"

MANIFEST="plugin/ralph-herdr/herdr-plugin.toml"
STAMP="ralph/scripts/herdr-plugin-version"

die() { echo "HERDR VERSION BUMP ERROR — $1" >&2; exit 2; }

git rev-parse --verify "${BASE_REF}^{commit}" >/dev/null 2>&1 \
  || die "cannot resolve base ref '$BASE_REF' (a shallow checkout needs fetch-depth: 0)"
git rev-parse --verify "${HEAD_REF}^{commit}" >/dev/null 2>&1 \
  || die "cannot resolve head ref '$HEAD_REF'"

MERGE_BASE=$(git merge-base "$BASE_REF" "$HEAD_REF") \
  || die "no merge base between '$BASE_REF' and '$HEAD_REF'"

changed=$(git diff --name-only "$MERGE_BASE" "$HEAD_REF") \
  || die "cannot diff ${MERGE_BASE}..${HEAD_REF}"

# Behavior surface, per the table above.
behavior=()
while IFS= read -r p; do
  [ -n "$p" ] || continue
  case "$p" in
    *.md)                              continue ;;
    plugin/ralph-herdr/tests/*)        continue ;;
    plugin/ralph-herdr/features/*)     continue ;;
    *_test.go)                         continue ;;
    plugin/ralph-herdr/scripts/*)      behavior+=("$p") ;;
    plugin/ralph-herdr/cockpit/*)      behavior+=("$p") ;;
    "$MANIFEST")                       behavior+=("$p") ;;
  esac
done <<<"$changed"

if [ "${#behavior[@]}" -eq 0 ]; then
  echo "HERDR VERSION BUMP PASS — no ralph-herdr behavior files in ${MERGE_BASE:0:8}..${HEAD_REF}"
  exit 0
fi

# `version = "x.y.z"` at the top level of the manifest. Restricted to the
# line's start so the min_herdr_version line beneath it can never be read as
# the plugin's own version.
read_version() { # read_version <ref> → x.y.z, empty when the file is absent
  local ref="$1" blob
  blob=$(git show "${ref}:${MANIFEST}" 2>/dev/null) || return 0
  printf '%s\n' "$blob" \
    | grep -Eo '^version = "[0-9]+\.[0-9]+\.[0-9]+"' \
    | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' \
    | head -1
}

base_ver=$(read_version "$MERGE_BASE")
head_ver=$(read_version "$HEAD_REF")

[ -n "$head_ver" ] || die "no parseable 'version = \"x.y.z\"' in $MANIFEST at $HEAD_REF"
# An absent base version means the manifest is new in this diff — the plugin
# is being introduced, so there is no prior install to signal. Nothing to
# compare, and a demand to bump would be nonsense.
if [ -z "$base_ver" ]; then
  echo "HERDR VERSION BUMP PASS — $MANIFEST is new in this diff (version $head_ver)"
  exit 0
fi

if [ "$base_ver" = "$head_ver" ]; then
  echo "HERDR VERSION BUMP FAIL — ralph-herdr behavior changed but the version stamp is still $head_ver." >&2
  echo "  An installed cockpit does not auto-update; the stamp is its only reinstall signal." >&2
  echo "  Bump BOTH (they must stay equal):" >&2
  echo "    $MANIFEST   version = \"...\"" >&2
  echo "    $STAMP" >&2
  echo "  Behavior files in this diff:" >&2
  printf '    %s\n' "${behavior[@]}" >&2
  exit 1
fi

echo "HERDR VERSION BUMP PASS — ${#behavior[@]} behavior file(s) changed, version $base_ver → $head_ver"
