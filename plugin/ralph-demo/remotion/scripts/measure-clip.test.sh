#!/usr/bin/env bash
# measure-clip.mjs — measured against a real VP8 WebM, not a mock.
#
# The fixture is built at run time from PNG frames using the same vendored
# Remotion ffmpeg, so no binary is committed and the test also proves the
# vendored toolchain is present (GH-2017).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCAFFOLD="$(dirname "$HERE")"
REMOTION="$SCAFFOLD/node_modules/.bin/remotion"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

[ -x "$REMOTION" ] || fail "run pnpm install in $SCAFFOLD first"

# 50 identical PNG frames at 25 fps -> 2.00 s.
node "$HERE/make-png-frames.mjs" "$TMP" 50

"$REMOTION" ffmpeg -v error -framerate 25 -i "$TMP/frame%03d.png" \
  -c:v libvpx -y "$TMP/clip.webm"

out="$(node "$HERE/measure-clip.mjs" "$TMP/clip.webm")"
frames=$(echo "$out" | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).frames))')
secs=$(echo "$out" | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).seconds))')
dif=$(echo "$out" | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).durationInFrames))')

[ "$frames" = "50" ] || fail "frames: expected 50, got $frames"
[ "$secs" = "2" ] || fail "seconds: expected 2, got $secs"
# 2.00 s at the composition's 30 fps.
[ "$dif" = "60" ] || fail "durationInFrames: expected 60, got $dif"

# --fps rescales to the caller's composition rate.
dif25=$(node "$HERE/measure-clip.mjs" "$TMP/clip.webm" --fps 25 \
  | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).durationInFrames))')
[ "$dif25" = "50" ] || fail "--fps 25: expected 50, got $dif25"

# A missing file is an error, never a zero duration.
if node "$HERE/measure-clip.mjs" "$TMP/absent.webm" >"$TMP/o" 2>"$TMP/e"; then
  fail "missing file exited 0"
fi
grep -q "no such file" "$TMP/e" || fail "missing file: unhelpful error: $(cat "$TMP/e")"
[ ! -s "$TMP/o" ] || fail "missing file printed a measurement: $(cat "$TMP/o")"

# A file that is not a video is an error, never a zero duration.
echo "not a video" >"$TMP/bogus.webm"
if node "$HERE/measure-clip.mjs" "$TMP/bogus.webm" >"$TMP/o" 2>/dev/null; then
  fail "unreadable stream exited 0"
fi
[ ! -s "$TMP/o" ] || fail "unreadable stream printed a measurement: $(cat "$TMP/o")"

echo "measure-clip: all assertions passed"
