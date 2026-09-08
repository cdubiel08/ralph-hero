#!/usr/bin/env bash
# scripts/lib/herdr-behavior-surface.sh — the one classifier for ralph-herdr's
# *behavior surface*: which changed paths would make an installed cockpit
# behave differently after a reinstall.
#
# GH-1976 introduced this table as a per-PR CI gate; GH-2491 moved the stamp
# bump itself to release time, but the question "did this diff touch
# behavior?" is unchanged and now has two callers — the release-time bump
# (scripts/herdr-plugin-release-bump.sh) and the manifest-validity check
# (scripts/check-herdr-version-bump.sh, which still reports this count
# informationally). One table, sourced by both, so the rule can't drift
# between the two the way GH-1976 found the two version stamps had.
#
#   yes — scripts/**            the plugin IS its scripts
#   yes — cockpit/** (non-test) the TUI a reinstall would replace
#   yes — herdr-plugin.toml     actions, panes, events, link handlers
#   no  — *.md                  README/CHANGELOG describe, never run
#   no  — tests/**, features/** never installed into a cockpit

# herdr_behavior_files BASE_REF HEAD_REF MANIFEST_PATH
# Echoes changed paths (one per line) that count as behavior surface between
# BASE_REF and HEAD_REF; empty output means nothing behavior-relevant changed.
herdr_behavior_files() {
  local base_ref="$1" head_ref="$2" manifest="$3"
  local changed
  changed=$(git diff --name-only "$base_ref" "$head_ref") || return 1
  local p
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    case "$p" in
      *.md)                          continue ;;
      plugin/ralph-herdr/tests/*)    continue ;;
      plugin/ralph-herdr/features/*) continue ;;
      *_test.go)                     continue ;;
      plugin/ralph-herdr/scripts/*)  echo "$p" ;;
      plugin/ralph-herdr/cockpit/*)  echo "$p" ;;
      "$manifest")                   echo "$p" ;;
    esac
  done <<<"$changed"
}
