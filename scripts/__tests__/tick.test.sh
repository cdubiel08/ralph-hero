#!/usr/bin/env bash
# scripts/__tests__/tick.test.sh
# Tests ralph/scripts/tick.sh claim handling (C1): after ANY non-zero runner
# exit the claim is decided by board truth — released only when this machine
# still holds it AND the issue sits In Progress — with a distinct note for
# the timeout (124) case; a failed board read logs and leaves the claim to
# TTL without masking the runner's failure. Also guards the existing zero-exit
# behaviors (ok, and the Backlog no-op detector).
#
# Harness: tick resolves its board CLI as a sibling of the script, so each
# scenario runs a COPY of tick.sh from a temp repo skeleton with a stub
# `board` beside it that logs invocations and serves canned JSON. The
# worktree dir is pre-created so no real git plumbing is exercised.

set -euo pipefail

TICK_SRC="$(cd "$(dirname "$0")/../.." && pwd)/ralph/scripts/tick.sh"
TMP_ROOT=$(mktemp -d)
trap 'rm -rf "$TMP_ROOT"' EXIT

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; ((PASS++)) || true; }
fail() { echo "  FAIL: $1"; ((FAIL++)) || true; }

SELF_HOLDER="tick@$(hostname -s)"

# write_board_stub <repo> — the canned board CLI every scenario runs against.
write_board_stub() {
  local repo="$1"
  cat > "$repo/ralph/scripts/board" <<'EOF'
#!/usr/bin/env bash
echo "BOARD $*" >> "$STUB_LOG"
case "${1:-}" in
  next) printf '{"next":{"number":42}}\n' ;;
  # GH-1807: the branch/agent grammar is derived by the CLI, never rebuilt in
  # shell — tick asks for it, so the stub must answer.
  name) printf '{"number":42,"kind":"feat","lane":"w","branch":"feat/42-stub-unit","worktree":"feat-42-stub-unit","agent":"w42-stub-unit","legacyBranch":"feature/GH-42"}\n' ;;
  get)
    if [ "${STUB_GET_FAIL:-0}" = "1" ]; then echo "stub: get failed" >&2; exit 1; fi
    # ClaimV2 (contracts.ts): get --json serializes .claim.holders as an
    # ARRAY — a single holder is a one-element array. tick.sh checks
    # membership, never string equality against a scalar .holder.
    printf '{"number":42,"state":"%s","claim":{"holders":["%s"],"since":"2026-01-01T00:00:00Z"}}\n' \
      "$STUB_STATE" "$STUB_HOLDER"
    ;;
  *) exit 0 ;;
esac
EOF
  chmod +x "$repo/ralph/scripts/board"
}

# run_tick <name> <runner_rc> <state> <holder> <get_fail(0|1)> [layout]
# layout: which worktree already exists — "legacy" (.claude/worktrees/GH-42,
# the default: a checkout cut before GH-1807) or "new" (the derived leaf).
# Either way NO git plumbing runs: tick only touches git when there is no
# worktree to resume, which is what keeps this skeleton a plain directory.
# -> sets TICK_RC, BOARD_LOG (stub invocations), TICKS_LOG, ISSUE_LOG
run_tick() {
  local name="$1" runner_rc="$2" state="$3" holder="$4" get_fail="$5" layout="${6:-legacy}"
  local scen="$TMP_ROOT/$name" repo home wt
  repo="$scen/repo"; home="$scen/home"
  case "$layout" in
    legacy) wt="GH-42" ;;
    new) wt="feat-42-stub-unit" ;;
    *) echo "run_tick: unknown layout '$layout'" >&2; exit 2 ;;
  esac
  mkdir -p "$repo/ralph/scripts" "$repo/.claude/worktrees/$wt" "$home"
  cp "$TICK_SRC" "$repo/ralph/scripts/tick.sh"
  echo "autopilot=true" > "$home/config"

  write_board_stub "$repo"

  printf '#!/usr/bin/env bash\nexit %s\n' "$runner_rc" > "$scen/runner.sh"
  chmod +x "$scen/runner.sh"

  set +e
  env -u ANTHROPIC_API_KEY -u RALPH_ALLOW_API_BILLING \
    RALPH_HOME="$home" \
    RALPH_TICK_RUNNER="bash $scen/runner.sh" \
    RALPH_TICK_TIMEOUT_MIN=1 \
    STUB_LOG="$scen/board.log" STUB_STATE="$state" STUB_HOLDER="$holder" \
    STUB_GET_FAIL="$get_fail" \
    bash "$repo/ralph/scripts/tick.sh" > "$scen/out" 2>&1
  TICK_RC=$?
  set -e
  BOARD_LOG=$(cat "$scen/board.log" 2>/dev/null || true)
  TICKS_LOG=$(cat "$home/ticks.log" 2>/dev/null || true)
  ISSUE_LOG=$(cat "$home/logs/gh-42.log" 2>/dev/null || true)
}

# expect_contains <desc> <haystack> <needle>
expect_contains() {
  local desc="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    pass "$desc"
  else
    fail "$desc — expected to find '$needle' in: $haystack"
  fi
}

# expect_not_contains <desc> <haystack> <needle>
expect_not_contains() {
  local desc="$1" haystack="$2" needle="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    pass "$desc"
  else
    fail "$desc — expected NO '$needle' in: $haystack"
  fi
}

echo "=== tick.sh claim release by board truth ==="

# 1. Non-timeout failure, claim held by this machine, still In Progress ->
# released with a note carrying the exit code (the C1 fix; previously only
# 124 released and everything else pinned the claim until TTL).
run_tick s1 7 "In Progress" "$SELF_HOLDER" 0
expect_contains "rc=7 + own claim + In Progress -> release invoked" "$BOARD_LOG" "release 42"
expect_contains "rc=7 release note names the exit code" "$BOARD_LOG" "tick runner exited RC=7"
expect_contains "ticks.log records exit=7" "$TICKS_LOG" "GH-42 exit=7"
[ "$TICK_RC" -eq 0 ] && pass "tick itself exits 0" || fail "tick exited $TICK_RC"

# 2. Timeout (rc=124) keeps its distinct note.
run_tick s2 124 "In Progress" "$SELF_HOLDER" 0
expect_contains "rc=124 -> release invoked" "$BOARD_LOG" "release 42"
expect_contains "rc=124 release note says timeout" "$BOARD_LOG" "tick timeout after 1m"
expect_not_contains "rc=124 note is not the generic RC note" "$BOARD_LOG" "runner exited RC="
expect_contains "ticks.log records timeout" "$TICKS_LOG" "GH-42 timeout"

# 3. Claim held by someone else -> never released from here.
run_tick s3 7 "In Progress" "other@elsewhere" 0
expect_not_contains "rc=7 + foreign claim -> no release" "$BOARD_LOG" "release"
expect_contains "ticks.log still records exit=7" "$TICKS_LOG" "GH-42 exit=7"

# 4. Own claim but board already past In Progress -> no release.
run_tick s4 7 "In Review" "$SELF_HOLDER" 0
expect_not_contains "rc=7 + In Review -> no release" "$BOARD_LOG" "release"

# 5. board get fails after a runner failure -> logged, claim left to TTL,
# and the original failure still recorded (not masked by the query hiccup).
run_tick s5 7 "In Progress" "$SELF_HOLDER" 1
expect_not_contains "rc=7 + get failure -> no release" "$BOARD_LOG" "release"
expect_contains "get failure is logged" "$ISSUE_LOG" "leaving claim to TTL"
expect_contains "ticks.log still records exit=7" "$TICKS_LOG" "GH-42 exit=7"
[ "$TICK_RC" -eq 0 ] && pass "tick survives the get failure" || fail "tick exited $TICK_RC"

# 6. Clean exit with board moved on -> ok, no release.
run_tick s6 0 "In Review" "$SELF_HOLDER" 0
expect_not_contains "rc=0 -> no release" "$BOARD_LOG" "release"
expect_contains "ticks.log records ok" "$TICKS_LOG" "GH-42 ok"

# 7. Clean exit but board untouched (Backlog) -> the no-op detector still fires.
run_tick s7 0 "Backlog" "$SELF_HOLDER" 0
expect_contains "rc=0 + Backlog -> no-op detected" "$TICKS_LOG" "no-op"

# ---------------------------------------------------------------------------
echo
echo "=== tick.sh names the branch it actually used (GH-1807) ==="

# 8. The names come from the CLI, not from shell string-building.
run_tick s8 7 "In Progress" "$SELF_HOLDER" 0
expect_contains "tick asks the board for the names" "$BOARD_LOG" "BOARD name 42 --json"

# 9. Legacy resume: a pre-GH-1807 worktree exists, so THAT is the unit's
# checkout and the release note must name the branch that goes with it —
# pointing a human at feat/42-… when the WIP is on feature/GH-42 is a lie.
expect_contains "legacy worktree -> note names the legacy branch" "$BOARD_LOG" "feature/GH-42"
expect_not_contains "legacy worktree -> note does NOT name the derived branch" \
  "$BOARD_LOG" "feat/42-stub-unit"

# 10. New layout: no legacy checkout to resume, so the derived branch wins.
run_tick s9 7 "In Progress" "$SELF_HOLDER" 0 new
expect_contains "derived worktree -> note names the derived branch" "$BOARD_LOG" "feat/42-stub-unit"

# ---------------------------------------------------------------------------
echo
echo "=== tick.sh driver model (GH-2350) ==="

# run_tick_model <name> <ralph_json|""> <settings_json|""> [VAR=value...] — the DEFAULT runner
# (no RALPH_TICK_RUNNER) against a stub `claude` that logs its argv, so the
# --model the tick composes is observable. -> TICK_RC, CLAUDE_LOG, BOARD_LOG
run_tick_model() {
  local name="$1" ralph_json="$2" settings_json="$3"
  shift 3
  local scen="$TMP_ROOT/model-$name" repo home
  repo="$scen/repo"; home="$scen/home"
  mkdir -p "$repo/ralph/scripts" "$repo/.claude/worktrees/feat-42-stub-unit" "$home" "$scen/bin"
  [ -n "$settings_json" ] && printf '%s\n' "$settings_json" > "$repo/.claude/settings.json"
  cp "$TICK_SRC" "$repo/ralph/scripts/tick.sh"
  echo "autopilot=true" > "$home/config"
  write_board_stub "$repo"
  [ -n "$ralph_json" ] && printf '%s\n' "$ralph_json" > "$repo/.ralph.json"
  printf '#!/usr/bin/env bash\necho "$*" >> "$CLAUDE_LOG"\nexit 0\n' > "$scen/bin/claude"
  chmod +x "$scen/bin/claude"
  set +e
  env -u ANTHROPIC_API_KEY -u RALPH_ALLOW_API_BILLING -u RALPH_TICK_RUNNER -u RALPH_MODEL_DRIVER \
    PATH="$scen/bin:$PATH" CLAUDE_LOG="$scen/claude.log" \
    RALPH_HOME="$home" RALPH_TICK_TIMEOUT_MIN=1 \
    STUB_LOG="$scen/board.log" STUB_STATE="In Review" STUB_HOLDER="$SELF_HOLDER" STUB_GET_FAIL=0 \
    "$@" bash "$repo/ralph/scripts/tick.sh" > "$scen/out" 2>&1
  TICK_RC=$?
  set -e
  CLAUDE_LOG=$(cat "$scen/claude.log" 2>/dev/null || true)
  BOARD_LOG=$(cat "$scen/board.log" 2>/dev/null || true)
  TICK_OUT=$(cat "$scen/out" 2>/dev/null || true)
}

run_tick_model default "" ""
expect_contains "no config -> the runner keeps its sonnet default" "$CLAUDE_LOG" "-p --model sonnet --permission-mode acceptEdits /ralph:work 42"

run_tick_model json '{"owner":"o","repo":"r","projectNumber":1,"models":{"driver":"claude-sonnet-5"}}' ""
expect_contains ".ralph.json models.driver -> the runner asks for it" "$CLAUDE_LOG" "-p --model claude-sonnet-5 --permission-mode acceptEdits /ralph:work 42"

run_tick_model env '{"owner":"o","repo":"r","projectNumber":1,"models":{"driver":"claude-sonnet-5"}}' "" RALPH_MODEL_DRIVER=fable
expect_contains "RALPH_MODEL_DRIVER outranks .ralph.json" "$CLAUDE_LOG" "-p --model fable --permission-mode acceptEdits /ralph:work 42"

run_tick_model settings "" '{"env":{"RALPH_MODEL_DRIVER":"claude-haiku-4-5"}}'
expect_contains ".claude/settings.json env.RALPH_MODEL_DRIVER -> the runner asks for it" "$CLAUDE_LOG" "-p --model claude-haiku-4-5 --permission-mode acceptEdits /ralph:work 42"

run_tick_model bad "" "" "RALPH_MODEL_DRIVER=bad value"
[ "$TICK_RC" -eq 64 ] && pass "an unridable driver model is a usage error (exit 64)" || fail "bad model: expected exit 64, got $TICK_RC"
expect_contains "the refusal names the value" "$TICK_OUT" "driver model 'bad value' is not a model name"
expect_not_contains "the refusal happens before any board read" "$BOARD_LOG" "BOARD"
expect_not_contains "the refusal happens before any runner spawn" "$CLAUDE_LOG" "ralph:work"

# ---------------------------------------------------------------------------
echo
echo "Results: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
