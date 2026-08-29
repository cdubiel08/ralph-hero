#!/bin/bash
# pnpm overrides ⊆ lockfile guard (GH-2257).
#
# Usage: ./scripts/check-pnpm-overrides.sh [DIR...]
#        default: every directory holding a committed pnpm-lock.yaml
#
# A `pnpm.overrides` entry in package.json is usually a SECURITY FLOOR — a
# pinned minimum for a vulnerable transitive dependency (here
# `ws@<8.20.1: ^8.20.1`). Dependabot's regenerated lockfile for
# /plugin/ralph-demo/remotion deletes the whole `overrides:` block while
# leaving `pnpm.overrides` in package.json (measured on #2081). The
# regeneration is byte-consistent with a pnpm run against a manifest that had
# no `pnpm.overrides` at all — pnpm 9 and 10 both preserve the block when it
# is present — so the drop comes from the updater's manifest handling, not
# from pnpm.
#
# Something does catch it today: `pnpm install --frozen-lockfile` refuses with
# ERR_PNPM_LOCKFILE_CONFIG_MISMATCH. But that sentence says the overrides
# configuration "doesn't match" — it does not say a security floor was
# deleted, and the reader who needs that sentence is skimming a red leg on a
# bot PR, which is the population every board surface skips by construction
# (RALPH_PR_ORPHAN_IGNORE_AUTHORS, GH-2048). A security control being dropped
# rendered as routine bot noise.
#
# This guard names the override. It runs BEFORE the frozen install so the
# named failure is the first thing in the log, and it survives a future
# decision to relax the frozen check — which would otherwise delete the only
# thing standing between the vulnerable range and a green build.
#
# Output contract:
#   PNPM OVERRIDES PASS  — ...   [0]
#   PNPM OVERRIDES FAIL  — ...   [1]
#   PNPM OVERRIDES ERROR — ...   [2]
#
# Exit 2 for an unreadable manifest, an unreadable lockfile, or a missing
# node: this guard exists because an absent signal read as "fine", so a scan
# that cannot see the files must not report them as clean.

set -uo pipefail

fail_msg() { echo "PNPM OVERRIDES FAIL  — $1"; }
err() { echo "PNPM OVERRIDES ERROR — $1" >&2; exit 2; }

command -v node >/dev/null 2>&1 || err "node not found; cannot read package.json"

repo_root=$(cd "$(dirname "$0")/.." && pwd) || err "cannot resolve repo root"

dirs=("$@")
if [ "${#dirs[@]}" -eq 0 ]; then
  while IFS= read -r lock; do
    dirs+=("$(dirname "$lock")")
  done < <(find "$repo_root" -name pnpm-lock.yaml \
             -not -path '*/node_modules/*' \
             -not -path '*/.git/*' \
             -not -path '*/.claude/worktrees/*' \
             -print | sort)
fi

if [ "${#dirs[@]}" -eq 0 ]; then
  echo "PNPM OVERRIDES PASS  — no pnpm-lock.yaml in the tree; nothing to assert"
  exit 0
fi

# Emits `key<TAB>value` per pnpm.overrides entry. Exits 2 on unparseable JSON
# rather than on an absent block: no overrides is a legitimate state, an
# unreadable manifest is not.
manifest_overrides() {
  node -e '
    const fs = require("fs");
    let pkg;
    try { pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); }
    catch (e) { process.stderr.write(String(e && e.message)); process.exit(2); }
    const ov = pkg && pkg.pnpm && pkg.pnpm.overrides;
    if (!ov || typeof ov !== "object") process.exit(0);
    for (const [k, v] of Object.entries(ov)) {
      process.stdout.write(k + "\t" + String(v) + "\n");
    }
  ' "$1"
}

# Emits `key<TAB>value` per entry in the lockfile's top-level `overrides:`
# block. The block is a flat two-space-indented mapping; the key may carry
# a colon in principle, so the split is on the LAST ": ".
lock_overrides() {
  awk '
    /^overrides:[[:space:]]*$/ { inblock = 1; next }
    inblock && /^[^[:space:]]/ { inblock = 0 }
    inblock && /^  [^[:space:]]/ {
      line = substr($0, 3)
      i = 0
      for (p = 1; p <= length(line) - 1; p++)
        if (substr(line, p, 2) == ": ") i = p
      if (i == 0) next
      k = substr(line, 1, i - 1)
      v = substr(line, i + 2)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", v)
      gsub(/^['\''"]|['\''"]$/, "", k)
      gsub(/^['\''"]|['\''"]$/, "", v)
      print k "\t" v
    }
  ' "$1"
}

rc=0
checked=0

for dir in "${dirs[@]}"; do
  pkg="$dir/package.json"
  lock="$dir/pnpm-lock.yaml"
  rel="${dir#"$repo_root"/}"

  [ -f "$pkg" ] || err "$rel: pnpm-lock.yaml with no package.json beside it"
  [ -r "$lock" ] || err "$rel: pnpm-lock.yaml is not readable"

  want=$(manifest_overrides "$pkg") || err "$rel/package.json is not readable JSON"
  if [ -z "$want" ]; then
    echo "  $rel: no pnpm.overrides declared"
    continue
  fi

  have=$(lock_overrides "$lock")
  checked=$((checked + 1))

  while IFS=$'\t' read -r key val; do
    [ -n "$key" ] || continue
    got=$(printf '%s\n' "$have" | awk -F'\t' -v k="$key" '$1 == k { print $2; exit }')
    if [ -z "$got" ]; then
      fail_msg "$rel: pnpm.overrides entry \"$key\": \"$val\" is declared in package.json but MISSING from pnpm-lock.yaml. This override is a version floor — a lockfile without it can resolve the range it exists to exclude. Restore the \`overrides:\` block in the lockfile (regenerate with the entry present in package.json); do not delete the entry from package.json to make this pass."
      rc=1
    elif [ "$got" != "$val" ]; then
      fail_msg "$rel: pnpm.overrides entry \"$key\" is \"$val\" in package.json but \"$got\" in pnpm-lock.yaml. A silently weakened floor is the same defect as a deleted one."
      rc=1
    fi
  done <<<"$want"
done

if [ "$rc" -eq 0 ]; then
  echo "PNPM OVERRIDES PASS  — every pnpm.overrides entry is present in its lockfile ($checked lockfile(s) with overrides)"
fi
exit "$rc"
