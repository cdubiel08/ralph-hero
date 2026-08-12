# Cross-Agent Hook Fail-Open Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Ralph's shared hook manifest silently skip every hook when `CLAUDE_PLUGIN_ROOT` is unavailable.

**Architecture:** Keep the existing hook scripts and Claude behavior unchanged. Add a shell guard at the manifest boundary, where the current failure occurs, and cover every registered command with one manifest-level portability regression test.

**Tech Stack:** JSON hook manifest, Bash, `jq`

## Global Constraints

- Missing or empty `CLAUDE_PLUGIN_ROOT` must produce exit status 0 with no stdout or stderr.
- A defined `CLAUDE_PLUGIN_ROOT` must continue dispatching the existing script.
- Cover all four commands registered in `ralph/hooks/hooks.json`.
- Do not change hook policy, hook output, or `plugin/ralph-playwright` hooks.

---

### Task 1: Guard the shared Ralph hook manifest

**Files:**
- Create: `scripts/__tests__/hooks-manifest-portability.test.sh`
- Modify: `ralph/hooks/hooks.json`

**Interfaces:**
- Consumes: Claude-compatible hook commands stored at `.hooks[][][].command` in `ralph/hooks/hooks.json`.
- Produces: Manifest commands that exit 0 silently without `CLAUDE_PLUGIN_ROOT`, while dispatching the same scripts when it is defined.

- [ ] **Step 1: Write the failing manifest portability test**

Create `scripts/__tests__/hooks-manifest-portability.test.sh`:

```bash
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
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
bash scripts/__tests__/hooks-manifest-portability.test.sh
```

Expected: `FAIL: command 0 exited 127 without CLAUDE_PLUGIN_ROOT` because the current command resolves to `/hooks/herdr-context.sh`.

- [ ] **Step 3: Add the minimal manifest guards**

Replace the four command values in `ralph/hooks/hooks.json` with:

```json
"command": "if [ -z \"${CLAUDE_PLUGIN_ROOT:-}\" ]; then exit 0; fi; exec \"${CLAUDE_PLUGIN_ROOT}/hooks/herdr-context.sh\""
"command": "if [ -z \"${CLAUDE_PLUGIN_ROOT:-}\" ]; then exit 0; fi; exec \"${CLAUDE_PLUGIN_ROOT}/hooks/funnel-board.sh\""
"command": "if [ -z \"${CLAUDE_PLUGIN_ROOT:-}\" ]; then exit 0; fi; exec \"${CLAUDE_PLUGIN_ROOT}/hooks/funnel-merge.sh\""
"command": "if [ -z \"${CLAUDE_PLUGIN_ROOT:-}\" ]; then exit 0; fi; exec \"${CLAUDE_PLUGIN_ROOT}/hooks/hint-pr-linkage.sh\""
```

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run:

```bash
bash scripts/__tests__/hooks-manifest-portability.test.sh
bash scripts/__tests__/funnel-board.test.sh
bash scripts/__tests__/funnel-merge.test.sh
bash scripts/__tests__/hint-pr-linkage.test.sh
```

Expected: all four commands exit 0 and every test reports zero failures.

- [ ] **Step 5: Validate manifest syntax and whitespace**

Run:

```bash
jq empty ralph/hooks/hooks.json
git diff --check
```

Expected: both commands exit 0 without output.

- [ ] **Step 6: Commit the implementation**

```bash
git add ralph/hooks/hooks.json scripts/__tests__/hooks-manifest-portability.test.sh
git commit -m "fix(hooks): fail open outside Claude plugin hosts"
```
