#!/usr/bin/env bash
# scripts/__tests__/hooks-manifest-portability.test.sh
# Tests ralph/hooks/hooks.json's dispatch layer (GH-2045).
#
# Every hook command is dispatched through ${CLAUDE_PLUGIN_ROOT}. Where that
# variable is unset — any host running the hooks outside a Claude Code plugin
# context — a bare reference resolves to /hooks/<name>.sh and fails the tool
# invocation. The funnels are courtesy rails, never enforcement, so the correct
# direction is to fail OPEN: skip the hook, let the command run.
#
# Covers, for EVERY command the manifest registers (count derived from the
# manifest, never hardcoded — a new hook must be covered by construction):
#   - unset CLAUDE_PLUGIN_ROOT: exit 0, no output on either stream
#   - set CLAUDE_PLUGIN_ROOT: the script under it is actually dispatched
#   - the referenced script exists in the shipped tree and is executable

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MANIFEST="$ROOT/ralph/hooks/hooks.json"
TMP_ROOT=$(mktemp -d)
trap 'rm -rf "$TMP_ROOT"' EXIT

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; ((PASS++)) || true; }
fail() { echo "  FAIL: $1"; ((FAIL++)) || true; }

COMMANDS=()
while IFS= read -r cmd; do
  COMMANDS+=("$cmd")
done < <(jq -r '.hooks[][].hooks[].command' "$MANIFEST")

if [[ "${#COMMANDS[@]}" -eq 0 ]]; then
  echo "FAIL: no hook commands found in $MANIFEST" >&2
  exit 1
fi
echo "manifest registers ${#COMMANDS[@]} hook commands"

# A fake plugin root whose scripts announce themselves, so "dispatched" is
# proved rather than inferred from a zero exit.
FAKE_ROOT="$TMP_ROOT/plugin"
mkdir -p "$FAKE_ROOT/hooks"

for index in "${!COMMANDS[@]}"; do
  cmd="${COMMANDS[$index]}"

  # The script path the command dispatches to, relative to the plugin root.
  rel=$(sed -n 's|.*\${CLAUDE_PLUGIN_ROOT}\(/hooks/[a-z0-9._-]*\.sh\).*|\1|p' <<<"$cmd")
  if [[ -z "$rel" ]]; then
    fail "command $index references no \${CLAUDE_PLUGIN_ROOT}/hooks/*.sh script: $cmd"
    continue
  fi
  name="$(basename "$rel")"

  # 1. The shipped tree actually carries the script the manifest names.
  if [[ -x "$ROOT/ralph$rel" ]]; then
    pass "$name: shipped and executable"
  else
    fail "$name: manifest references ralph$rel, which is missing or not executable"
  fi

  # 2. Unset root: fail open, silently.
  set +e
  out=$(env -u CLAUDE_PLUGIN_ROOT bash -c "$cmd" <<<'{}' 2>"$TMP_ROOT/err")
  rc=$?
  set -e
  err=$(cat "$TMP_ROOT/err")
  if [[ "$rc" -eq 0 && -z "$out" && -z "$err" ]]; then
    pass "$name: unset CLAUDE_PLUGIN_ROOT skips silently"
  else
    fail "$name: unset CLAUDE_PLUGIN_ROOT gave rc=$rc stdout=[$out] stderr=[$err]"
  fi

  # 3. Set root: the named script is actually dispatched.
  printf '#!/usr/bin/env bash\necho DISPATCHED-%s\n' "$name" >"$FAKE_ROOT$rel"
  chmod +x "$FAKE_ROOT$rel"
  set +e
  out=$(CLAUDE_PLUGIN_ROOT="$FAKE_ROOT" bash -c "$cmd" <<<'{}' 2>/dev/null)
  rc=$?
  set -e
  if [[ "$rc" -eq 0 && "$out" == "DISPATCHED-$name" ]]; then
    pass "$name: dispatched when CLAUDE_PLUGIN_ROOT is set"
  else
    fail "$name: expected DISPATCHED-$name, got rc=$rc out=[$out]"
  fi
done

echo
echo "hooks-manifest-portability: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
