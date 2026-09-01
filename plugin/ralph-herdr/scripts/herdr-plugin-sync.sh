#!/usr/bin/env bash
# herdr-plugin-sync.sh — bring the INSTALLED ralph-herdr herdr plugin up to
# this source tree, and prove it (2026-08-19 audit, D4).
#
# Why this exists: herdr has no `plugin update` and no refresh-on-launch, and
# the version string is not evidence — trees were measured DIFFERENT while
# both sides reported the same version (f96286a7; four merged≠installed
# incidents: #1705 #1739 #1823 #2016). So the subject here is CONTENT: a
# sorted sha256 over the plugin's behavior surface (scripts/**, cockpit's
# non-test Go source + go.mod/go.sum, herdr-plugin.toml — the same surface
# scripts/check-herdr-version-bump.sh gates on), computed identically on both
# trees. `ralph/scripts/herdr-setup.sh check` runs the same hash as its
# `ralph-herdr-content` line — change the two together.
#
# What it does, in order, each step printed BEFORE it runs:
#   1. hash the source tree (this checkout) and the installed tree (herdr's
#      registered plugin_root); equal → nothing to do, exit 0
#   2. reinstall: for a github-sourced install, the exact
#      `herdr plugin install owner/repo/subdir --ref … -y` herdr's own registry
#      records; for a linked/local install there is nothing to fetch — the
#      link already serves this tree, so a mismatch means the LINK points at a
#      different checkout, and that is reported, not "fixed"
#   3. verify by re-hashing. Still different → exit 1 with the honest reading:
#      a github reinstall serves the pinned ref, so a source tree carrying
#      UNRELEASED changes will legitimately keep differing — the remedy is
#      `herdr plugin link <this tree>` for development, or merging first.
#
#   --check        hash and report only (steps 1 and 3's comparison), no mutation
#   --source DIR   hash DIR as the source tree instead of the tree this script
#                  sits in. The tree is READ, never executed — this is how the
#                  installed copy measures a checkout without running that
#                  checkout's code (GH-2340)
#
# Exit: 0 in sync (or brought into sync) · 1 still different / failed ·
#       2 not evaluable (no herdr, no registry entry, unreadable tree) ·
#       64 usage.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_TREE="$(cd "$SCRIPT_DIR/.." && pwd)"
HERDR="${HERDR_BIN_PATH:-herdr}"
PLUGINS_JSON="${RALPH_HERDR_PLUGINS_JSON:-${XDG_CONFIG_HOME:-$HOME/.config}/herdr/plugins.json}"

CHECK_ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK_ONLY=1 ;;
    --source)
      [ $# -ge 2 ] && [ -n "$2" ] || { echo "herdr-plugin-sync.sh: --source needs a directory" >&2; exit 64; }
      SRC_TREE="$(cd "$2" 2>/dev/null && pwd)" || { echo "herdr-plugin-sync.sh: --source '$2' is not a directory" >&2; exit 2; }
      shift
      ;;
    -h | --help) sed -n '2,36p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "herdr-plugin-sync.sh: unknown argument '$1' (accepts --check, --source DIR)" >&2; exit 64 ;;
  esac
  shift
done

_sha256() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 | cut -d' ' -f1; else sha256sum | cut -d' ' -f1; fi
}

# tree_hash DIR — sorted sha256 over the behavior surface. Prints nothing on
# an unreadable tree (the caller renders that "not evaluable", never a match
# and never a mismatch). MIRRORED in ralph/scripts/herdr-setup.sh
# (ralph-herdr-content check) — change both together.
tree_hash() {
  local dir="$1"
  [ -d "$dir/scripts" ] || return 1
  (
    cd "$dir" 2>/dev/null || exit 1
    {
      find scripts -type f 2>/dev/null
      find cockpit -type f \( -name '*.go' ! -name '*_test.go' -o -name 'go.mod' -o -name 'go.sum' \) 2>/dev/null
      [ -f herdr-plugin.toml ] && printf 'herdr-plugin.toml\n'
    } | LC_ALL=C sort | while IFS= read -r f; do
      [ -f "$f" ] || continue
      printf '%s ' "$f"
      _sha256 <"$f"
    done
  ) | _sha256
}

command -v jq >/dev/null 2>&1 || { echo "herdr-plugin-sync: jq is required" >&2; exit 2; }
[ -f "$PLUGINS_JSON" ] || { echo "herdr-plugin-sync: no herdr plugin registry at $PLUGINS_JSON — is herdr installed?" >&2; exit 2; }
entry=$(jq -c 'map(select(.plugin_id == "ralph-herdr")) | .[0] // empty' "$PLUGINS_JSON" 2>/dev/null) || entry=""
[ -n "$entry" ] || { echo "herdr-plugin-sync: herdr records no ralph-herdr install — install first: herdr plugin install cdubiel08/ralph-hero/plugin/ralph-herdr --yes" >&2; exit 2; }
root=$(jq -r '.plugin_root // empty' <<<"$entry")
[ -n "$root" ] && [ -d "$root" ] || { echo "herdr-plugin-sync: registered plugin_root '$root' is not a directory" >&2; exit 2; }

src_hash=$(tree_hash "$SRC_TREE") || src_hash=""
inst_hash=$(tree_hash "$root") || inst_hash=""
[ -n "$src_hash" ] || { echo "herdr-plugin-sync: could not hash the source tree $SRC_TREE" >&2; exit 2; }
[ -n "$inst_hash" ] || { echo "herdr-plugin-sync: could not hash the installed tree $root" >&2; exit 2; }

echo "source    $SRC_TREE  $src_hash"
echo "installed $root  $inst_hash"
if [ "$src_hash" = "$inst_hash" ]; then
  echo "in sync — the installed cockpit runs this tree's code."
  exit 0
fi
echo "DIFFERENT — the installed cockpit is executing plugin code that does not match this tree."

if [ -n "$CHECK_ONLY" ]; then
  exit 1
fi

kind=$(jq -r '.source.kind // empty' <<<"$entry")
if [ "$kind" != "github" ]; then
  echo "the install is a local link ($kind) at $root — there is nothing to fetch; the link serves whatever"
  echo "that checkout holds. If this tree is the one that should run: herdr plugin link $SRC_TREE"
  exit 1
fi
sf() { jq -r --arg f "$1" '.source[$f] // empty | tostring' <<<"$entry"; }
owner=$(sf owner); repo=$(sf repo); subdir=$(sf subdir); ref=$(sf requested_ref)
[ -n "$ref" ] || ref="main"
if [ -z "$owner" ] || [ -z "$repo" ] || [ -z "$subdir" ]; then
  echo "herdr records incomplete source coordinates — reinstall by hand: herdr plugin install cdubiel08/ralph-hero/plugin/ralph-herdr --yes" >&2
  exit 1
fi

echo "→ $HERDR plugin install $owner/$repo/$subdir --ref $ref -y"
"$HERDR" plugin install "$owner/$repo/$subdir" --ref "$ref" -y || {
  echo "herdr-plugin-sync: the install command failed — see herdr's error above" >&2
  exit 1
}

# Verify by RE-HASHING, never by trusting the install's exit code: "reported
# success and changed nothing" is this line's founding incident. The root may
# have moved on reinstall — re-read it.
root=$(jq -r 'map(select(.plugin_id == "ralph-herdr")) | .[0].plugin_root // empty' "$PLUGINS_JSON" 2>/dev/null) || root=""
inst_hash=""
[ -n "$root" ] && [ -d "$root" ] && inst_hash=$(tree_hash "$root") || inst_hash=""
if [ -n "$inst_hash" ] && [ "$src_hash" = "$inst_hash" ]; then
  echo "verified — installed tree now matches this source tree ($inst_hash)."
  exit 0
fi
echo "still different after reinstall (installed ${inst_hash:-unreadable})." >&2
echo "The github install serves ref '$ref' — if this tree carries UNRELEASED changes it will keep differing" >&2
echo "until they merge; for development, serve this tree directly: herdr plugin link $SRC_TREE" >&2
exit 1
