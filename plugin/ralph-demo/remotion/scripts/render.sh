#!/usr/bin/env bash
# Render the `Demo` composition. The one contract at the mutation path.
#
# Real exit codes, and the printed path is a file that exists: a render that
# exited 0 having written nothing must not read like a delivered artifact
# (GH-1751). Exactly one attempt — deciding whether a failure was the
# chrome-headless-shell flake or a broken composition is the caller's
# judgment, and a script that silently retried would hide the difference.
#
# Usage:
#   render.sh --props <props.json> --out <out.mp4> [--composition Demo]
#
# Exit codes:
#   0  rendered; the output path is on stdout
#   2  usage / missing input (nothing was attempted)
#   1  the render itself failed (remotion's own output is on stderr)
#   3  the render exited 0 but produced no usable file

set -euo pipefail

SCAFFOLD="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

die() {
  printf 'render: %s\n' "$2" >&2
  exit "$1"
}

props=""
out=""
composition="Demo"
while [ $# -gt 0 ]; do
  case "$1" in
    --props) props="${2:-}"; shift 2 || die 2 "--props needs a value" ;;
    --out) out="${2:-}"; shift 2 || die 2 "--out needs a value" ;;
    --composition) composition="${2:-}"; shift 2 || die 2 "--composition needs a value" ;;
    *) die 2 "unknown argument $1" ;;
  esac
done

[ -n "$props" ] || die 2 "usage: render.sh --props <props.json> --out <out.mp4> [--composition Demo]"
[ -n "$out" ] || die 2 "usage: render.sh --props <props.json> --out <out.mp4> [--composition Demo]"
[ -f "$props" ] || die 2 "no such props file: $props"

# The props file carries durationInFrames, which calculateMetadata reads. A
# malformed one fails deep inside the bundler with an opaque message, so it is
# checked here where the remedy is obvious.
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$props" \
  || die 2 "props file is not valid JSON: $props"

[ -d "$SCAFFOLD/node_modules" ] \
  || die 2 "dependencies missing. Remedy: pnpm install in $SCAFFOLD"

mkdir -p "$(dirname "$out")"

# Everything below runs with cwd inside the scaffold, because remotion.config.ts
# is resolved against the CURRENT directory, not against the entry point. So the
# caller's paths are made absolute first: --props and --out are the caller's,
# relative to the caller's cwd, and must not silently re-root (GH-2029).
props_abs="$(cd "$(dirname "$props")" && pwd)/$(basename "$props")"
out_abs="$(cd "$(dirname "$out")" && pwd)/$(basename "$out")"

# The scaffold's own binary, not a bare `npx`: npx resolves against the caller's
# cwd, so from anywhere but the scaffold it found no remotion and reported
# "could not determine executable to run" — which the flake hint below then
# mis-narrated as the chrome-headless-shell download (GH-2029).
REMOTION="$SCAFFOLD/node_modules/.bin/remotion"
[ -x "$REMOTION" ] \
  || die 2 "remotion binary missing at $REMOTION. Remedy: pnpm install in $SCAFFOLD"

# --props takes a path; passing JSON inline hits shell-quoting limits on any
# real narration script.
#
# Remotion writes its progress to STDOUT, so it is redirected to stderr: this
# script's stdout is the output path and nothing else, or `out=$(render.sh …)`
# hands the caller a bundling log.
(cd "$SCAFFOLD" && "$REMOTION" render "$SCAFFOLD/src/index.ts" "$composition" "$out_abs" \
  --props="$props_abs") >&2 \
  || die 1 "remotion render exited non-zero for composition '$composition' (see output above). \
If this is the first render on this machine it may be the chrome-headless-shell download — one retry is warranted."

[ -s "$out_abs" ] || die 3 "render reported success but $out is missing or empty"

printf '%s\n' "$out"
