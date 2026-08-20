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
# Entry form: "dest" (canonical source lives AT dest in this repo) or
# "dest|src" (canonical source lives elsewhere — e.g. the advisory hooks,
# whose canonical copies are ralph/hooks/*, and the kit-only sources under
# ralph/scripts/kit-src/). Non-identity pairs are recorded in the manifest's
# "sources" map so kit.test.ts can assert byte-identity against the right file.
KIT_FILES=(
  "scripts/advisory-findings.sh"
  "scripts/apply-evidence.sh"
  "scripts/apply-keywords.sh"
  "scripts/attest-pr.sh"
  "scripts/codex-review-evidence.sh"
  "scripts/copilot-review-evidence.sh"
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
  # Host-repo orientation (audit C3, GH-2074/GH-2075): the advisory
  # SessionStart hook plus the poll-loop rail and the quote-aware reader it
  # sources beside itself. Vendored so a gates-only host (no plugin install)
  # still gets them; install-gates.sh prints the settings registration lines —
  # it never edits host settings.
  ".claude/hooks/ralph-kit-orient.sh|ralph/scripts/kit-src/ralph-kit-orient.sh"
  ".claude/hooks/funnel-gate-watch.sh|ralph/hooks/funnel-gate-watch.sh"
  ".claude/hooks/lib/cmdscan.sh|ralph/hooks/lib/cmdscan.sh"
)

# Fragments are NOT plain file copies: install-gates.sh merges them into a
# host-owned file between BEGIN/END ralph-kit markers rather than replacing
# the file. Entry form: "host-file|canonical-src". Kit copy lands under
# fragments/<host-file>.
KIT_FRAGMENTS=(
  "CLAUDE.md|ralph/scripts/kit-src/claude-md-fragment.md"
)

# Split "dest|src" — src defaults to dest.
entry_dest() { printf '%s' "${1%%|*}"; }
entry_src() { case "$1" in *"|"*) printf '%s' "${1#*|}" ;; *) printf '%s' "$1" ;; esac; }

# Where a destination path lives inside the kit dir: scripts/** keeps its
# shape; the workflow moves under workflows/ (a kit dir named .github would
# read as live workflow config to humans and tools alike), and the host
# .claude/hooks/** moves under hooks/ for the same reason.
kit_path() {
  case "$1" in
    .github/workflows/*) printf 'workflows/%s' "${1#.github/workflows/}" ;;
    .claude/hooks/*) printf 'hooks/%s' "${1#.claude/hooks/}" ;;
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
source_entries=""
for entry in "${KIT_FILES[@]}"; do
  dest="$(entry_dest "$entry")"
  rel_src="$(entry_src "$entry")"
  src="$REPO_ROOT/$rel_src"
  kit="$KIT_DIR/$(kit_path "$dest")"
  if [ ! -f "$src" ]; then
    echo "kit-sync: canonical source missing: $rel_src (for $dest)" >&2
    exit 2
  fi
  if [ "$MODE" = "write" ]; then
    mkdir -p "$(dirname "$kit")"
    cp "$src" "$kit"
  else
    if [ ! -f "$kit" ] || ! cmp -s "$src" "$kit"; then
      echo "kit-sync: DRIFT $dest (kit copy missing or differs from $rel_src)" >&2
      drift=1
    fi
  fi
  hash="$(sha256 "$src")"
  manifest_entries="$manifest_entries    \"$dest\": \"$hash\",\n"
  if [ "$rel_src" != "$dest" ]; then
    source_entries="$source_entries    \"$dest\": \"$rel_src\",\n"
  fi
done

fragment_entries=""
for entry in "${KIT_FRAGMENTS[@]}"; do
  dest="$(entry_dest "$entry")"
  rel_src="$(entry_src "$entry")"
  src="$REPO_ROOT/$rel_src"
  kit_rel="fragments/$dest"
  kit="$KIT_DIR/$kit_rel"
  if [ ! -f "$src" ]; then
    echo "kit-sync: canonical fragment source missing: $rel_src (for $dest)" >&2
    exit 2
  fi
  if [ "$MODE" = "write" ]; then
    mkdir -p "$(dirname "$kit")"
    cp "$src" "$kit"
  else
    if [ ! -f "$kit" ] || ! cmp -s "$src" "$kit"; then
      echo "kit-sync: DRIFT fragment $dest (kit copy missing or differs from $rel_src)" >&2
      drift=1
    fi
  fi
  hash="$(sha256 "$src")"
  fragment_entries="$fragment_entries    \"$dest\": { \"kit\": \"$kit_rel\", \"src\": \"$rel_src\", \"sha256\": \"$hash\" },\n"
done

manifest="$KIT_DIR/manifest.json"
new_manifest="$(printf '{\n  "kit": "ralph merge-gate family (GH-2083)",\n  "files": {\n%b  },\n  "sources": {\n%b  },\n  "fragments": {\n%b  }\n}\n' \
  "${manifest_entries%,\\n}\n" "${source_entries%,\\n}\n" "${fragment_entries%,\\n}\n")"

if [ "$MODE" = "write" ]; then
  printf '%s' "$new_manifest" > "$manifest"
  # Remove strays: a file retired from KIT_FILES must leave the kit too, or
  # kit.test.ts's no-strays assertion reddens with no remedy this script offers.
  while IFS= read -r -d '' f; do
    rel="${f#"$KIT_DIR"/}"
    keep=0
    [ "$rel" = "manifest.json" ] && keep=1
    for entry in "${KIT_FILES[@]}"; do
      [ "$rel" = "$(kit_path "$(entry_dest "$entry")")" ] && { keep=1; break; }
    done
    for entry in "${KIT_FRAGMENTS[@]}"; do
      [ "$rel" = "fragments/$(entry_dest "$entry")" ] && { keep=1; break; }
    done
    [ "$keep" = 1 ] || { rm "$f"; echo "kit-sync: removed stray $rel"; }
  done < <(find "$KIT_DIR" -type f -print0)
  echo "kit-sync: wrote ${#KIT_FILES[@]} files + ${#KIT_FRAGMENTS[@]} fragment(s) + manifest to ralph/kit/"
else
  if [ ! -f "$manifest" ] || [ "$(cat "$manifest")" != "$new_manifest" ]; then
    echo "kit-sync: DRIFT manifest.json is stale" >&2
    drift=1
  fi
  if [ "$drift" -ne 0 ]; then
    echo "kit-sync: remedy — run: bash ralph/scripts/kit-sync.sh" >&2
    exit 1
  fi
  echo "kit-sync: ralph/kit/ is in sync (${#KIT_FILES[@]} files + ${#KIT_FRAGMENTS[@]} fragment(s))"
fi
