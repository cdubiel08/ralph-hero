#!/usr/bin/env bash
# scripts/__tests__/herdr-setup.test.sh
# Tests ralph/scripts/herdr-setup.sh's two reads of herdr's own state (GH-1778):
# resolving the herdr plugin root from plugins.json, and comparing the
# registered ralph-herdr version against the stamp this ralph release ships.
#
# Every case runs a COPY of the script under a fake plugin layout with no
# ../../plugin/ralph-herdr sibling — that is the Claude-Code-cache install
# where the old repo-relative path guess silently never resolved.
#
# Load-bearing property: unknowns degrade to `note`, never `gap`. An older
# ralph plugin meeting a newer herdr plugin, a missing registry, an absent
# stamp — none of those may manufacture a false cockpit gap, because
# `board doctor` relays this verdict as an advisory info line.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$REPO_ROOT/ralph/scripts/herdr-setup.sh"
TMP_ROOT=$(mktemp -d)
trap 'rm -rf "$TMP_ROOT"' EXIT

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; ((PASS++)) || true; }
fail() { echo "  FAIL: $1"; ((FAIL++)) || true; echo "$2" | sed 's/^/        /'; }

# --- fake install layout: ralph/scripts only, no plugin/ sibling -------------
FAKE="$TMP_ROOT/cache/ralph-hero/ralph/9.9.9/scripts"
mkdir -p "$FAKE"
cp "$SRC" "$FAKE/herdr-setup.sh"
SCRIPT="$FAKE/herdr-setup.sh"

# --- stub herdr + gh ---------------------------------------------------------
BIN="$TMP_ROOT/bin"
mkdir -p "$BIN"
cat >"$BIN/herdr" <<'STUB'
#!/usr/bin/env bash
case "${1:-} ${2:-}" in
  "--version ") echo "herdr 0.8.0" ;;
  "agent list") echo "[]" ;;
  "plugin list") echo "- ralph-herdr (Ralph Herdr) enabled [github:cdubiel08/ralph-hero/plugin/ralph-herdr@main]" ;;
  "integration status") echo "claude: current (v7)" ;;
  *) exit 1 ;;
esac
STUB
cat >"$BIN/gh" <<'STUB'
#!/usr/bin/env bash
[ "${1:-}" = "auth" ] && { echo "Logged in to github.com; token scopes: 'project', 'repo'"; exit 0; }
exit 1
STUB
chmod +x "$BIN/herdr" "$BIN/gh"

# --- fixtures ----------------------------------------------------------------
# plugins_json <version> <kind> [plugin_root]
plugins_json() {
  local out="$TMP_ROOT/plugins.json"
  jq -n --arg v "$1" --arg k "$2" --arg root "${3:-$TMP_ROOT/plugin-root}" '
    [{ plugin_id: "ralph-herdr", name: "Ralph Herdr", version: $v, plugin_root: $root,
       source: { kind: $k, owner: "cdubiel08", repo: "ralph-hero",
                 subdir: "plugin/ralph-herdr", requested_ref: "main" } }]' >"$out"
  echo "$out"
}

# lineage_root <exit-code> — a plugin root shipping a doctor-lineage.sh stub
lineage_root() {
  local root="$TMP_ROOT/plugin-root"
  mkdir -p "$root/scripts"
  printf '#!/usr/bin/env bash\nexit %s\n' "$1" >"$root/scripts/doctor-lineage.sh"
  chmod +x "$root/scripts/doctor-lineage.sh"
  echo "$root"
}

# run <plugins.json path or ""> [extra env assignments...]
run() {
  local pj="$1"; shift
  env -u RALPH_HERDR_LINEAGE_SH -u RALPH_HERDR_VERSION_STAMP -u RALPH_HERDR_BOARD \
    PATH="$BIN:$PATH" \
    HERDR_BIN_PATH="$BIN/herdr" \
    RALPH_HERDR_REPO="$TMP_ROOT/repo" \
    RALPH_HERDR_PLUGINS_JSON="${pj:-$TMP_ROOT/nonexistent.json}" \
    "$@" bash "$SCRIPT" check 2>&1 || true
}

stamp() { echo "$1" >"$FAKE/herdr-plugin-version"; }

expect() { # expect <desc> <output> <regex>
  if grep -qE "$3" <<<"$2"; then pass "$1"; else fail "$1" "$2"; fi
}
refute() {
  if grep -qE "$3" <<<"$2"; then fail "$1" "$2"; else pass "$1"; fi
}

echo "herdr-setup.sh — plugin root + version stamp (GH-1778)"

# 1. lineage resolves through plugins.json plugin_root on a cache-install layout
stamp 0.5.0
out=$(run "$(plugins_json 0.5.0 github "$(lineage_root 0)")")
expect "lineage evaluates via plugin_root (no repo plugin/ tree)" "$out" 'watcher-lineage — closed'

# 2. lineage findings still relay as a note, never a gap
out=$(run "$(plugins_json 0.5.0 github "$(lineage_root 1)")")
expect "lineage findings relay" "$out" 'note watcher-lineage — .*lineage finding'
refute "lineage never gaps" "$out" 'GAP  watcher-lineage'

# 3. no registry entry and no repo tree → not evaluated (honest degradation)
out=$(run "")
expect "lineage degrades without herdr state" "$out" 'watcher-lineage — not evaluated'

# 4. current plugin → ok
out=$(run "$(plugins_json 0.5.0 github "$(lineage_root 0)")")
expect "current plugin passes" "$out" 'ok   ralph-herdr-version — 0\.5\.0'

# 5. stale github install → GAP naming the exact reinstall command
out=$(run "$(plugins_json 0.4.0 github)")
expect "stale github install gaps" "$out" \
  'GAP  ralph-herdr-version — 0\.4\.0 < 0\.5\.0.*herdr plugin install cdubiel08/ralph-hero/plugin/ralph-herdr --ref main -y'

# 6. stale local link → note (the user updates that checkout with git, not herdr)
out=$(run "$(plugins_json 0.4.0 local)")
expect "stale local link notes" "$out" 'note ralph-herdr-version — 0\.4\.0 < 0\.5\.0'
refute "stale local link never gaps" "$out" 'GAP  ralph-herdr-version'

# 7. newer plugin than this ralph expects → ok, never a gap
out=$(run "$(plugins_json 0.6.0 github)")
expect "newer plugin passes" "$out" 'ok   ralph-herdr-version — 0\.6\.0'

# 8. missing registry → note
out=$(run "")
expect "missing plugins.json notes" "$out" 'note ralph-herdr-version — not evaluated \(no ralph-herdr entry'
refute "missing plugins.json never gaps" "$out" 'GAP  ralph-herdr-version'

# 9. unparseable registry → note
echo 'not json {' >"$TMP_ROOT/broken.json"
out=$(run "$TMP_ROOT/broken.json")
expect "unparseable plugins.json notes" "$out" 'note ralph-herdr-version — not evaluated'
refute "unparseable plugins.json never gaps" "$out" 'GAP  ralph-herdr-version'

# 10. absent stamp (an older ralph plugin) → note
rm -f "$FAKE/herdr-plugin-version"
out=$(run "$(plugins_json 0.4.0 github)")
expect "absent stamp notes" "$out" 'note ralph-herdr-version — not evaluated \(no version stamp'
refute "absent stamp never gaps" "$out" 'GAP  ralph-herdr-version'
stamp 0.5.0

# 11. the shipped stamp tracks the herdr plugin manifest (drift guard)
manifest_ver=$(grep -Eo '^version = "[0-9]+\.[0-9]+\.[0-9]+"' "$REPO_ROOT/plugin/ralph-herdr/herdr-plugin.toml" | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
shipped=$(cat "$REPO_ROOT/ralph/scripts/herdr-plugin-version")
if [ "$manifest_ver" = "$shipped" ]; then
  pass "shipped stamp matches herdr-plugin.toml ($shipped)"
else
  fail "shipped stamp matches herdr-plugin.toml" "stamp=$shipped manifest=$manifest_ver — bump ralph/scripts/herdr-plugin-version"
fi

# 12-13. incomplete github source metadata degrades the REMEDY, not the verdict.
# The drift is known (0.4.0 < 0.5.0), so the gap must stand — but `jq -r` renders
# a missing field as "null" and `//` does not catch an empty ref, so neither may
# leak into a command a human is invited to paste.
partial_json() { # partial_json <jq source object>
  local out="$TMP_ROOT/partial.json"
  jq -n --argjson src "$1" '
    [{ plugin_id: "ralph-herdr", name: "Ralph Herdr", version: "0.4.0",
       plugin_root: "'"$TMP_ROOT"'/plugin-root", source: $src }]' >"$out"
  echo "$out"
}

out=$(run "$(partial_json '{"kind":"github","owner":"cdubiel08"}')")
expect "incomplete coordinates still gap" "$out" 'GAP  ralph-herdr-version — 0\.4\.0 < 0\.5\.0'
refute "incomplete coordinates emit no null command" "$out" 'install .*null'

out=$(run "$(partial_json '{"kind":"github","owner":"cdubiel08","repo":"ralph-hero","subdir":"plugin/ralph-herdr","requested_ref":""}')")
expect "empty ref normalizes to main" "$out" \
  'GAP  ralph-herdr-version — .*herdr plugin install cdubiel08/ralph-hero/plugin/ralph-herdr --ref main -y'

# --- board-cli resolution: the registry, not the cache glob (GH-1865) --------
# The cache holds every ralph version ever installed; installed_plugins.json
# RECORDS the one Claude Code executes. Reporting the glob's highest-versioned
# directory as "the installed copy" is how `check` passes a path the cockpit
# does not run.
BHOME="$TMP_ROOT/bhome"
mk_board() { # mk_board <namespace> <version> -> prints the board path
  local d="$BHOME/.claude/plugins/cache/$1/ralph/$2/scripts"
  mkdir -p "$d"
  printf '#!/bin/sh\n' >"$d/board"
  chmod +x "$d/board"
  echo "$d/board"
}
mk_registry() { # mk_registry <version> <installPath> -> prints the file
  local out="$TMP_ROOT/installed_plugins.json"
  jq -n --arg v "$1" --arg p "$2" '
    { plugins: { "ralph@ralph-hero": [{ installPath: $p, version: $v }],
                 "other@m": [{ installPath: "/nope", version: "9.9.9" }] } }' >"$out"
  echo "$out"
}

recorded=$(mk_board ns 0.1.0)
newest=$(mk_board ns 9.9.9)   # the glob's pick — exists, but is not installed
reg=$(mk_registry 0.1.0 "$(dirname "$(dirname "$recorded")")")

out=$(run "" HOME="$BHOME" RALPH_INSTALLED_PLUGINS_FILE="$reg")
expect "board-cli takes the recorded install, not the newest cache dir" "$out" \
  "ok   board-cli — ${recorded//\//\\/} \(installed plugin copy, recorded in"
refute "board-cli never reports the unrecorded newest dir" "$out" "${newest//\//\\/}"

# An unreadable registry must still find a board — and must SAY the path is a
# guess, so a wrong path is visibly a guess rather than silently a record.
out=$(run "" HOME="$BHOME" RALPH_INSTALLED_PLUGINS_FILE="$TMP_ROOT/absent.json")
expect "unreadable registry falls back to the glob" "$out" "ok   board-cli — ${newest//\//\\/} \(GUESS:"

# A recorded copy whose tree is gone must not win, and must not suppress the glob.
gone=$(mk_registry 5.0.0 "$BHOME/gone")
out=$(run "" HOME="$BHOME" RALPH_INSTALLED_PLUGINS_FILE="$gone")
expect "vanished recorded copy falls through to the glob" "$out" "ok   board-cli — ${newest//\//\\/} \(GUESS:"

# Nothing anywhere is a gap that names both places it looked.
out=$(run "" HOME="$TMP_ROOT/empty-home" RALPH_INSTALLED_PLUGINS_FILE="$TMP_ROOT/absent.json")
expect "no board CLI anywhere gaps, naming the registry" "$out" \
  'GAP  board-cli — no board CLI found .*no ralph install recorded in'

echo
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
