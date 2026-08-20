#!/usr/bin/env bash
# kit-sync.sh — regenerate ralph/kit/ from the canonical merge-gate sources (GH-2083).
#
# The kit is the installable copy of the merge-gate family: the marketplace
# packages only ./ralph, so the repo-root scripts/ the gates actually live in
# never ship unless vendored here. Canonical stays at the repo root — every
# path this repo's docs, hooks and workflows name keeps working — and this
# script is the one writer of the copy. kit.test.ts asserts byte-identity in
# CI, so drift is a red build naming this script, not a convention.
#
# Usage:
#   bash ralph/scripts/kit-sync.sh           # rewrite ralph/kit/ + manifest
#   bash ralph/scripts/kit-sync.sh --check   # verify; exit 1 on drift

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
KIT_DIR="$REPO_ROOT/ralph/kit"

# Destination path in a host repo -> canonical source in this repo.
# One list; kit layout, manifest and installer all derive from it.
KIT_FILES=(
  "scripts/advisory-findings.sh"
  "scripts/apply-evidence.sh"
  "scripts/apply-keywords.sh"
  "scripts/attest-pr.sh"
  "scripts/codex-review-evidence.sh"
  "scripts/merge-pr.sh"
  "scripts/pr-file-classes.sh"
  "scripts/pr-gate-watch.sh"
  "scripts/pr-linkage-drift.sh"
  "scripts/publish-apply-keywords-status.sh"
  "scripts/review-convergence.sh"
  "scripts/review-staleness.sh"
  "scripts/ruleset-contexts.sh"
  "scripts/validate-attestation.sh"
  "scripts/lib/gh-budget.sh"
  "scripts/lib/merge-evidence.sh"
  ".github/workflows/validate-attestation.yml"
  ".github/workflows/state-guard.yml"
  ".github/workflows/doctor.yml"
)

# Where a destination path lives inside the kit dir: scripts/** keeps its
# shape; the workflow moves under workflows/ (a kit dir named .github would
# read as live workflow config to humans and tools alike).
kit_path() {
  case "$1" in
    .github/workflows/*) printf 'workflows/%s' "${1#.github/workflows/}" ;;
    *) printf '%s' "$1" ;;
  esac
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

MODE="write"
[ "${1:-}" = "--check" ] && MODE="check"

drift=0
manifest_entries=""
for dest in "${KIT_FILES[@]}"; do
  src="$REPO_ROOT/$dest"
  kit="$KIT_DIR/$(kit_path "$dest")"
  if [ ! -f "$src" ]; then
    echo "kit-sync: canonical source missing: $dest" >&2
    exit 2
  fi
  if [ "$MODE" = "write" ]; then
    mkdir -p "$(dirname "$kit")"
    cp "$src" "$kit"
  else
    if [ ! -f "$kit" ] || ! cmp -s "$src" "$kit"; then
      echo "kit-sync: DRIFT $dest (kit copy missing or differs)" >&2
      drift=1
    fi
  fi
  hash="$(sha256 "$src")"
  manifest_entries="$manifest_entries    \"$dest\": \"$hash\",\n"
done

manifest="$KIT_DIR/manifest.json"
new_manifest="$(printf '{\n  "kit": "ralph merge-gate family (GH-2083)",\n  "files": {\n%b  }\n}\n' "${manifest_entries%,\\n}\n")"

if [ "$MODE" = "write" ]; then
  printf '%s' "$new_manifest" > "$manifest"
  # Remove strays: a file retired from KIT_FILES must leave the kit too, or
  # kit.test.ts's no-strays assertion reddens with no remedy this script offers.
  while IFS= read -r -d '' f; do
    rel="${f#"$KIT_DIR"/}"
    keep=0
    [ "$rel" = "manifest.json" ] && keep=1
    for dest in "${KIT_FILES[@]}"; do
      [ "$rel" = "$(kit_path "$dest")" ] && { keep=1; break; }
    done
    [ "$keep" = 1 ] || { rm "$f"; echo "kit-sync: removed stray $rel"; }
  done < <(find "$KIT_DIR" -type f -print0)
  echo "kit-sync: wrote ${#KIT_FILES[@]} files + manifest to ralph/kit/"
else
  if [ ! -f "$manifest" ] || [ "$(cat "$manifest")" != "$new_manifest" ]; then
    echo "kit-sync: DRIFT manifest.json is stale" >&2
    drift=1
  fi
  if [ "$drift" -ne 0 ]; then
    echo "kit-sync: remedy — run: bash ralph/scripts/kit-sync.sh" >&2
    exit 1
  fi
  echo "kit-sync: ralph/kit/ is in sync (${#KIT_FILES[@]} files)"
fi
