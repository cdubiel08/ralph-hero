#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MANIFEST="$ROOT/ralph/hooks/hooks.json"
TMP_ROOT=$(mktemp -d)
trap 'rm -rf "$TMP_ROOT"' EXIT

COMMANDS=()
while IFS= read -r command; do
  COMMANDS+=("$command")
done < <(jq -r '.hooks[][] | .hooks[] | .command' "$MANIFEST")

if [[ "${#COMMANDS[@]}" -ne 4 ]]; then
  echo "FAIL: expected 4 registered hook commands, found ${#COMMANDS[@]}" >&2
  exit 1
fi

for index in "${!COMMANDS[@]}"; do
  stdout="$TMP_ROOT/stdout-$index"
  stderr="$TMP_ROOT/stderr-$index"

  set +e
  env -u CLAUDE_PLUGIN_ROOT bash -c "${COMMANDS[$index]}" \
    >"$stdout" 2>"$stderr" <<< '{}'
  rc=$?
  set -e

  if [[ "$rc" -ne 0 ]]; then
    echo "FAIL: command $index exited $rc without CLAUDE_PLUGIN_ROOT" >&2
    exit 1
  fi
  if [[ -s "$stdout" || -s "$stderr" ]]; then
    echo "FAIL: command $index emitted output without CLAUDE_PLUGIN_ROOT" >&2
    exit 1
  fi
done

echo "PASS: all ${#COMMANDS[@]} hook commands fail open without CLAUDE_PLUGIN_ROOT"
