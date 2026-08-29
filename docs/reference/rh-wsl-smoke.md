# `rh` WSL smoke checklist

Linux CI is not WSL proof. Run this checklist in the WSL environment itself and record the evidence table at the end. Use a configured nonproduction Ralph repository and a Herdr test session; steps 5–7 can create local Herdr topology, and step 7 intentionally starts the lead for the named test epic.

Set the two repository locations first. The second checkout must really live on the Windows-mounted filesystem:

```bash
LINUX_REPO="$HOME/src/ralph-hero"
WIN_HOME=$(wslpath "$(cmd.exe /c echo %USERPROFILE% 2>/dev/null | tr -d '\r')")
WINDOWS_REPO="$WIN_HOME/src/ralph-hero"
test -d "$LINUX_REPO/.git"
test -d "$WINDOWS_REPO/.git"
```

Create one absolute wrapper for a disposable named Herdr session. All direct Herdr checks below use `"$WSL_HERDR"`; all `rh` calls go through `rh_wsl`, which supplies that same wrapper plus scratch Ralph state. The only calls made through the real binary are exact named-session lifecycle cleanup:

```bash
readonly WSL_RH_SESSION="ralph-wsl-smoke"
WSL_RH_TMP=$(mktemp -d /tmp/ralph-wsl-smoke.XXXXXX)
readonly WSL_RH_TMP
WSL_HERDR_REAL=$(command -v herdr)
readonly WSL_HERDR_REAL
case "$WSL_HERDR_REAL" in /*) ;; *) echo "herdr did not resolve absolutely: $WSL_HERDR_REAL" >&2; false ;; esac
WSL_HERDR="$WSL_RH_TMP/herdr-$WSL_RH_SESSION"
readonly WSL_HERDR
"$WSL_HERDR_REAL" session stop "$WSL_RH_SESSION" >/dev/null 2>&1 || true
"$WSL_HERDR_REAL" session delete "$WSL_RH_SESSION" >/dev/null 2>&1 || true
{
  printf '%s\n' '#!/bin/bash' 'for arg in "$@"; do' \
    '  case "$arg" in --session|--session=*|--no-session|--remote|--remote=*|--remote-keybindings|--remote-keybindings=*) echo "refusing session override" >&2; exit 64 ;; esac' \
    'done' \
    'case "${1-}" in session) echo "refusing session lifecycle through pinned wrapper" >&2; exit 64 ;; esac'
  printf 'exec %q --session %q "$@"\n' "$WSL_HERDR_REAL" "$WSL_RH_SESSION"
} > "$WSL_HERDR"
chmod 700 "$WSL_HERDR"
case "$WSL_HERDR" in /*) ;; *) echo "wrapper is not absolute: $WSL_HERDR" >&2; false ;; esac
mkdir -p "$WSL_RH_TMP/ralph-home" "$WSL_RH_TMP/ledger-root"
rh_wsl() {
  HERDR_BIN_PATH="$WSL_HERDR" \
    RALPH_HOME="$WSL_RH_TMP/ralph-home" \
    RALPH_HERDR_LEDGER_ROOT="$WSL_RH_TMP/ledger-root" \
    rh "$@"
}
rh_wsl_cleanup() {
  "$WSL_HERDR_REAL" session stop "$WSL_RH_SESSION" >/dev/null 2>&1 || true
  "$WSL_HERDR_REAL" session delete "$WSL_RH_SESSION" >/dev/null 2>&1 || true
  if "$WSL_HERDR" status server --json >/dev/null 2>&1; then
    echo "named session still answers after cleanup: $WSL_RH_SESSION" >&2
    return 1
  fi
  case "$WSL_RH_TMP" in /tmp/ralph-wsl-smoke.*) ;; *)
    echo "refusing scratch cleanup outside the validated wrapper root: $WSL_RH_TMP" >&2
    return 1
  esac
  [ "$WSL_HERDR" = "$WSL_RH_TMP/herdr-$WSL_RH_SESSION" ] || return 1
  rm -rf "$WSL_RH_TMP"
}
trap rh_wsl_cleanup EXIT
```

Expected: `WSL_HERDR_REAL` and `WSL_HERDR` are absolute, the prior disposable session is absent, and no command below can select the default Herdr session.

## 1. Install under `~/.local/bin`

```bash
cd "$LINUX_REPO"
unset XDG_BIN_HOME
bash ralph/scripts/install-rh.sh
export PATH="$HOME/.local/bin:$PATH"
command -v rh
test "$(command -v rh)" = "$HOME/.local/bin/rh"
```

Expected: installation succeeds, `command -v rh` prints `$HOME/.local/bin/rh`, and the final `test` exits 0. An unrelated existing `rh` at the target is a refusal, not an overwrite; move it deliberately or choose `--bin-dir DIR` before continuing.

## 2. Discover a Git root on the Linux filesystem

```bash
cd "$LINUX_REPO/ralph/scripts"
test "$(git rev-parse --show-toplevel)" = "$LINUX_REPO"
NO_COLOR=1 rh_wsl
```

Expected: the root check exits 0 and `rh` renders the read-only operator home for `$(basename "$LINUX_REPO")`, even though it was invoked from a nested directory. It must not report “not inside a Git repository.”

## 3. Discover a Git root under `/mnt/c`

```bash
case "$WINDOWS_REPO" in /mnt/c/*) ;; *) echo "not under /mnt/c: $WINDOWS_REPO" >&2; false ;; esac
cd "$WINDOWS_REPO/plugin/ralph-herdr"
test "$(git rev-parse --show-toplevel)" = "$WINDOWS_REPO"
NO_COLOR=1 rh_wsl
```

Expected: both checks exit 0 and `rh` renders the operator home for `$(basename "$WINDOWS_REPO")`. This confirms that `rh` follows Git’s root discovery across DrvFs rather than assuming a Linux-only path shape.

## 4. Verify `NO_COLOR`

```bash
cd "$LINUX_REPO"
NO_COLOR=1 rh_wsl 2>&1 | sed -n l | tee /tmp/rh-wsl-no-color.txt
! grep -E '\\033|\\x1[bB]' /tmp/rh-wsl-no-color.txt
```

Expected: `sed -n l` shows line endings as `$` but no `\033` or `\x1b` escape sequence; the final grep exits 0.

## 5. Distinguish dispatch read from dispatch ensure

```bash
cd "$LINUX_REPO"
set +e
"$WSL_HERDR" status server --json > /tmp/rh-wsl-server-before.json 2>&1
server_before_rc=$?
rh_wsl dispatch | tee /tmp/rh-wsl-dispatch.txt
dispatch_rc=${PIPESTATUS[0]}
"$WSL_HERDR" status server --json > /tmp/rh-wsl-server-after-read.json 2>&1
server_after_read_rc=$?
set -e
test "$server_before_rc" -eq "$server_after_read_rc"
rh_wsl dispatch up | tee /tmp/rh-wsl-dispatch-up.txt
"$WSL_HERDR" status server --json | jq -e '.status == "running"'
```

Expected: `rh dispatch` only reports status. If Herdr was down it may return attention/nonzero, but it must remain down; if Herdr was already up it must remain up without creating another dispatch seat. `rh dispatch up` is the ensure operation: it leaves the server running and creates or reuses exactly one dispatch seat.

## 6. Run naked `rh day` twice

Use a scoped test repository whose ledger has no dead historical team waiting to resume. The first run must say `resume teams: none recorded` (or report only already-live proven teams); otherwise classify that durable evidence before using this no-new-team check.

```bash
cd "$LINUX_REPO"
"$WSL_HERDR" workspace list | jq -S '[.result.workspaces[] | select((.label // "") | test("^t[0-9]+-")) | .label]' > /tmp/rh-wsl-teams-before.json
rh_wsl day | tee /tmp/rh-wsl-day-1.txt
"$WSL_HERDR" workspace list | jq -S '[.result.workspaces[] | select((.label // "") | test("^t[0-9]+-")) | .label]' > /tmp/rh-wsl-teams-after-1.json
rh_wsl day | tee /tmp/rh-wsl-day-2.txt
"$WSL_HERDR" workspace list | jq -S '[.result.workspaces[] | select((.label // "") | test("^t[0-9]+-")) | .label]' > /tmp/rh-wsl-teams-after-2.json
diff -u /tmp/rh-wsl-teams-before.json /tmp/rh-wsl-teams-after-1.json
diff -u /tmp/rh-wsl-teams-after-1.json /tmp/rh-wsl-teams-after-2.json
! grep -E 'team GH-[0-9]+[[:space:]]+started' /tmp/rh-wsl-day-1.txt /tmp/rh-wsl-day-2.txt
```

Expected: both diffs are empty, neither naked run reports an explicitly started team, and the second run reports unchanged/reused dispatch, teams, and cockpit topology. Naked `rh day` may resume only teams with durable prior evidence; it must never invent a never-before-existing team.

## 7. Prove explicit team intent with a disposable epic

Set `TEST_EPIC` only to an open, disposable epic on the configured test board. Do not point this at production work.

```bash
: "${TEST_EPIC:?set TEST_EPIC to an open disposable test epic number}"
case "$TEST_EPIC" in *[!0-9]*|'') false ;; *[1-9]*) ;; *) false ;; esac
rh_wsl board get "$TEST_EPIC" --json | tee /tmp/rh-wsl-test-epic.json
jq -e --argjson epic "$TEST_EPIC" '.number == $epic and .issueState == "OPEN"' /tmp/rh-wsl-test-epic.json
if env | grep -q '^ANTHROPIC_API_KEY='; then echo 'remove ANTHROPIC_API_KEY before the test launch' >&2; false; fi
rh_wsl day --team "$TEST_EPIC" | tee /tmp/rh-wsl-day-team.txt
```

Expected: the board preflight identifies the intended open disposable epic, the billing guard sees no API key, and `rh day --team "$TEST_EPIC"` explicitly ensures that one team while completing the normal day phases. No other new team is created.

## Cleanup

After recording evidence, delete the exact named session and scratch wrapper. The `EXIT` trap does the same if an earlier command fails:

```bash
rh_wsl_cleanup
trap - EXIT
test ! -e "$WSL_HERDR"
```

Expected: cleanup first verifies through the wrapper that the named session no longer answers, then removes the wrapper and scratch state. The final path check exits 0, and the default Herdr session was never selected or stopped.

## Evidence record

Copy this table into the verification report when the checklist is actually executed. Do not mark it passed from Linux CI output.

| Field | Recorded value |
|---|---|
| Date (ISO 8601) | |
| `wsl --version` | |
| `wsl.exe --status` | |
| Distro (`cat /etc/os-release`) | |
| Linux filesystem location | |
| `/mnt/c` filesystem location | |
| Steps 1–7 result | |
| Notes / captured artifact paths | |
