#!/usr/bin/env bash
# render.sh is the one contract at the mutation path, so its exit codes are
# tested rather than described. The success case renders for real (2 frames):
# a suite that only ever proved the refusals would leave the claim that
# actually matters — the printed path is a file that exists — unchecked.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RENDER="$HERE/render.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fails=0
check() {
  local name="$1" want="$2" got="$3"
  if [ "$want" = "$got" ]; then
    printf 'ok   %s (exit %s)\n' "$name" "$got"
  else
    printf 'FAIL %s: wanted exit %s, got %s\n' "$name" "$want" "$got"
    fails=$((fails + 1))
  fi
}

run() { bash "$RENDER" "$@" >/dev/null 2>&1; printf '%s' "$?"; }

printf '{"title":"render.test","durationInFrames":2}\n' > "$TMP/props.json"
printf 'not json\n' > "$TMP/bad.json"

check "no arguments"          2 "$(run)"
check "missing --out"         2 "$(run --props "$TMP/props.json")"
check "unknown argument"      2 "$(run --props "$TMP/props.json" --out "$TMP/o.mp4" --wat)"
check "props file absent"     2 "$(run --props "$TMP/nope.json" --out "$TMP/o.mp4")"
check "props not valid JSON"  2 "$(run --props "$TMP/bad.json" --out "$TMP/o.mp4")"
check "unknown composition"   1 "$(run --props "$TMP/props.json" --out "$TMP/o.mp4" --composition NoSuchThing)"

# Success: exit 0, stdout is the path, and the path is a real non-empty file.
# Run from $TMP, not the scaffold: every case above passes absolute paths from
# whatever cwd the suite was started in, so a script that only worked from the
# scaffold dir went unnoticed until it was run from the repo root (GH-2029).
out="$TMP/nested/demo.mp4"   # also proves the output directory is created
status=0
printed="$(cd "$TMP" && bash "$RENDER" --props "$TMP/props.json" --out "$out" 2>/dev/null)" || status=$?
check "render succeeds from a foreign cwd" 0 "$status"
if [ "$printed" = "$out" ] && [ -s "$out" ]; then
  printf 'ok   printed path exists and is non-empty\n'
else
  printf 'FAIL printed %s; file present: %s\n' "${printed:-<nothing>}" "$([ -s "$out" ] && echo yes || echo no)"
  fails=$((fails + 1))
fi

# Caller-relative paths stay relative to the CALLER, never re-rooted into the
# scaffold by the cd the render now runs under.
status=0
printed="$(cd "$TMP" && bash "$RENDER" --props props.json --out rel/demo.mp4 2>/dev/null)" || status=$?
check "relative paths resolve against the caller" 0 "$status"
if [ -s "$TMP/rel/demo.mp4" ]; then
  printf 'ok   relative --out landed in the caller directory\n'
else
  printf 'FAIL relative --out did not land in %s/rel\n' "$TMP"
  fails=$((fails + 1))
fi

[ "$fails" -eq 0 ] ||{ printf '\n%d failure(s)\n' "$fails"; exit 1; }
printf '\nall render.sh contract cases pass\n'
