#!/usr/bin/env bash
# scripts/__tests__/launch-mcp.test.sh
# Regression suite for the npx-cache-bloat fix (GH-1756, PR #1755).
#
# The defect: .mcp.json launched the knowledge server as
# `npx -y ralph-hero-knowledge-index@<pinned version>`. npx materializes a
# fresh ~500MB-1GB cache tree under ~/.npm/_npx for EVERY distinct version
# pin, and never evicts one — 33 releases put 20GB on a single machine. The
# fix launches the vendored copy through scripts/launch-mcp.sh instead.
#
# So the load-bearing assertions here are, in order of what actually caused
# the bug:
#   1. .mcp.json names no npx and no version-pinned package — a re-pin is the
#      exact regression, and the release workflow no longer rewrites this file.
#   2. The launcher never reaches the network on a warm tree: a complete
#      install plus a matching marker must exec the built server WITHOUT
#      running `npm ci`. This is what keeps the disk flat run over run.
#   3. The marker's Node fingerprint tracks the native-ABI boundary, not the
#      full version string (codex P2). A patch-level Node bump must NOT
#      invalidate it — each false invalidation is a destructive reinstall.
#   4. A genuinely incomplete or ABI-stale tree DOES re-bootstrap. The point
#      is to skip needless work, never to serve a broken build.
#
# Every case runs the real script against a fake plugin root with `node` and
# `npm` stubbed on PATH, so nothing here installs, builds, or hits a registry.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$REPO_ROOT/plugin/ralph-knowledge/scripts/launch-mcp.sh"
MCP_JSON="$REPO_ROOT/plugin/ralph-knowledge/.mcp.json"
RELEASE_WF="$REPO_ROOT/.github/workflows/release-knowledge.yml"

TMP_ROOT=$(mktemp -d)
trap 'rm -rf "$TMP_ROOT"' EXIT

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); [ -n "${2:-}" ] && echo "$2" | sed 's/^/        /'; return 0; }

[ -f "$SRC" ] || { echo "FATAL: launcher not found at $SRC"; exit 1; }

# --- stubs -------------------------------------------------------------------
# node: records its argv, and answers `-p process.versions.modules` with a
# per-case ABI so the fingerprint boundary is drivable from the test.
BIN="$TMP_ROOT/bin"
mkdir -p "$BIN"
cat >"$BIN/node" <<'STUB'
#!/usr/bin/env bash
echo "node $*" >>"$CALL_LOG"
case "${1:-}" in
  --version) echo "${FAKE_NODE_VERSION:-v22.11.0}" ;;
  -p)
    case "${2:-}" in
      # The launcher's platform+arch+ABI identity probe. FAKE_NODE_ID drives it
      # directly; FAKE_NODE_ABI keeps the older ABI-only cases readable.
      *process.platform*) echo "${FAKE_NODE_ID:-darwin-arm64-abi${FAKE_NODE_ABI:-127}}" ;;
      'process.versions.modules') echo "${FAKE_NODE_ABI:-127}" ;;
      *) exit 1 ;;
    esac
    ;;
  *) exit 0 ;;   # stands in for `exec node dist/index.js`
esac
STUB
cat >"$BIN/npm" <<'STUB'
#!/usr/bin/env bash
echo "npm $*" >>"$CALL_LOG"
exit 0
STUB
# npx must NEVER be invoked — that is the whole bug. Any call fails loudly.
cat >"$BIN/npx" <<'STUB'
#!/usr/bin/env bash
echo "npx $*" >>"$CALL_LOG"
echo "FATAL: launcher invoked npx" >&2
exit 90
STUB
chmod +x "$BIN/node" "$BIN/npm" "$BIN/npx"

# sanitized_bin <dir> [tool...] — a self-contained PATH holding the node/npm/npx
# stubs plus the ordinary utilities the launcher shells out to, and NOTHING
# else. The hashers are deliberately absent unless named in [tool...], which is
# how the no-hasher and cksum-only branches are reached. Without the coreutils
# the launcher would simply die at 127 and every assertion would pass or fail
# for the wrong reason, so each required tool is resolved explicitly and a
# missing one is a hard error rather than a silent hole.
# `bash` and `env` are load-bearing: the stubs' `#!/usr/bin/env bash` shebang
# resolves through this PATH too, and without them every run dies at 127.
BASE_UTILS="bash env rm cat find mkdir sleep date uname cut kill sed grep ls dirname basename pwd stat hostname"
sanitized_bin() {
  local dir="$1"; shift
  mkdir -p "$dir"
  local t src
  for t in $BASE_UTILS "$@"; do
    src=$(PATH="/usr/bin:/bin:/usr/sbin:/sbin" command -v "$t" 2>/dev/null) || {
      echo "FATAL: sanitized_bin cannot resolve '$t'" >&2; exit 1; }
    ln -sf "$src" "$dir/$t"
  done
  for t in node npm npx; do cp "$BIN/$t" "$dir/$t"; done
  # Guard the premise: the hashers must be absent unless explicitly requested.
  local h
  for h in shasum sha256sum cksum; do
    case " $* " in *" $h "*) continue ;; esac
    [ -e "$dir/$h" ] && { echo "FATAL: $h leaked into $dir" >&2; exit 1; }
  done
  return 0
}

# fake_root <name> — a plugin root that looks fully bootstrapped: built output
# plus every dependency bootstrap_needed() checks. No marker is written; each
# case decides that itself.
fake_root() {
  local root="$TMP_ROOT/$1"
  mkdir -p "$root/scripts" "$root/dist" \
    "$root/node_modules/@huggingface" \
    "$root/node_modules/@modelcontextprotocol/sdk" \
    "$root/node_modules/better-sqlite3"
  cp "$SRC" "$root/scripts/launch-mcp.sh"
  chmod +x "$root/scripts/launch-mcp.sh"
  echo 'console.log("server")' >"$root/dist/index.js"
  echo '{"name":"ralph-hero-knowledge-index"}' >"$root/package.json"
  echo '{"lockfileVersion":3}' >"$root/package-lock.json"
  echo "$root"
}

# run_launcher <root> — run the launcher with stubs, capturing the call log.
# Echoes the log path; the launcher's own rc lands in RC.
RC=0
run_launcher() {
  local root="$1" log="$1/calls.log"
  : >"$log"
  RC=0
  CALL_LOG="$log" CLAUDE_PLUGIN_ROOT="$root" \
    PATH="$BIN:$PATH" \
    FAKE_NODE_VERSION="${FAKE_NODE_VERSION:-v22.11.0}" \
    FAKE_NODE_ABI="${FAKE_NODE_ABI:-127}" \
    FAKE_NODE_ID="${FAKE_NODE_ID:-darwin-arm64-abi${FAKE_NODE_ABI:-127}}" \
    bash "$root/scripts/launch-mcp.sh" >/dev/null 2>"$root/stderr.log" || RC=$?
  echo "$log"
}

echo "=== .mcp.json: no npx, no version pin (the actual bloat source) ==="

if grep -q 'npx' "$MCP_JSON"; then
  fail ".mcp.json must not invoke npx" "$(cat "$MCP_JSON")"
else
  pass ".mcp.json invokes no npx"
fi

# A re-pin is the precise regression: every distinct pin is a new npx cache dir.
if grep -qE 'ralph-hero-knowledge-index@[0-9]' "$MCP_JSON"; then
  fail ".mcp.json re-pinned a published version — each pin is a fresh npx cache tree" \
    "$(cat "$MCP_JSON")"
else
  pass ".mcp.json carries no version-pinned package spec"
fi

if grep -q 'launch-mcp.sh' "$MCP_JSON"; then
  pass ".mcp.json launches the vendored launcher"
else
  fail ".mcp.json does not reference scripts/launch-mcp.sh" "$(cat "$MCP_JSON")"
fi

# The release workflow used to rewrite the pin. It must no longer do so, or
# the next release would reintroduce exactly the spec asserted against above.
if grep -q 'ralph-hero-knowledge-index@\[0-9\]' "$RELEASE_WF"; then
  fail "release-knowledge.yml still rewrites a version pin into .mcp.json"
else
  pass "release workflow no longer pins a version into .mcp.json"
fi

echo "=== release workflow ships launcher fixes (codex P2) ==="

# The plugin now STARTS through this script, so a launcher-only commit must
# bump the plugin version — otherwise no installed plugin ever gets the fix.
if awk '/^on:/,/^concurrency:/' "$RELEASE_WF" | grep -q "plugin/ralph-knowledge/scripts/\*\*"; then
  pass "push.paths includes plugin/ralph-knowledge/scripts/**"
else
  fail "push.paths omits plugin/ralph-knowledge/scripts/** — launcher fixes would never release" \
    "$(awk '/^on:/,/^concurrency:/' "$RELEASE_WF")"
fi

echo "=== warm tree: exec the vendored server, install nothing ==="

root=$(fake_root warm)
# Seed the marker with the fingerprint this very script computes, which is what
# a completed bootstrap would have written.
log=$(run_launcher "$root")   # first run bootstraps and writes the marker
log=$(run_launcher "$root")   # second run is the one under test

if [ "$RC" -eq 0 ]; then
  pass "warm launch exits 0"
else
  fail "warm launch exited $RC" "$(cat "$root/stderr.log")"
fi

if grep -q '^npm ' "$log"; then
  fail "warm launch ran npm — the tree was already complete" "$(cat "$log")"
else
  pass "warm launch ran no npm command (no reinstall, no disk growth)"
fi

if grep -q '^npx' "$log"; then
  fail "warm launch invoked npx" "$(cat "$log")"
else
  pass "warm launch invoked no npx"
fi

if grep -q 'node dist/index.js' "$log"; then
  pass "warm launch exec'd the vendored dist/index.js"
else
  fail "warm launch never exec'd dist/index.js" "$(cat "$log")"
fi

echo "=== Node fingerprint tracks the ABI boundary, not the version string ==="

# A patch bump shares the ABI, so the compiled deps still load. Re-installing
# here buys nothing and can strand an offline machine.
root=$(fake_root patchbump)
FAKE_NODE_VERSION="v22.11.0" FAKE_NODE_ABI="127" log=$(run_launcher "$root")
marker_before=$(cat "$root/.bootstrap-complete")

FAKE_NODE_VERSION="v22.14.3" FAKE_NODE_ABI="127" log=$(run_launcher "$root")
if grep -q '^npm ' "$log"; then
  fail "Node patch bump (v22.11.0 -> v22.14.3, same ABI) forced a reinstall" "$(cat "$log")"
else
  pass "Node patch bump does not invalidate the marker"
fi

marker_after=$(cat "$root/.bootstrap-complete")
if [ "$marker_before" = "$marker_after" ]; then
  pass "fingerprint is stable across a Node patch bump"
else
  fail "fingerprint changed on a patch bump ($marker_before -> $marker_after)"
fi

# A major bump moves the ABI, and better-sqlite3's compiled binary genuinely
# stops loading. That IS a rebuild.
root=$(fake_root majorbump)
FAKE_NODE_VERSION="v22.11.0" FAKE_NODE_ABI="127" log=$(run_launcher "$root")
FAKE_NODE_VERSION="v24.0.0" FAKE_NODE_ABI="137" log=$(run_launcher "$root")
if grep -q 'npm ci' "$log"; then
  pass "Node ABI change (127 -> 137) does re-bootstrap"
else
  fail "Node ABI change did not re-bootstrap — compiled deps would fail to load" "$(cat "$log")"
fi

echo "=== incomplete tree still re-bootstraps ==="

root=$(fake_root incomplete)
log=$(run_launcher "$root")                       # warm it
rm -rf "$root/node_modules/better-sqlite3"        # a dep bootstrap_needed checks
log=$(run_launcher "$root")
if grep -q 'npm ci' "$log"; then
  pass "missing dependency re-bootstraps (skip-work never serves a broken tree)"
else
  fail "missing better-sqlite3 did not re-bootstrap" "$(cat "$log")"
fi

root=$(fake_root nodist)
log=$(run_launcher "$root")
rm -f "$root/dist/index.js"
log=$(run_launcher "$root")
if grep -q 'npm run build' "$log"; then
  pass "missing dist/index.js re-bootstraps"
else
  fail "missing dist/index.js did not rebuild" "$(cat "$log")"
fi

# An interrupted bootstrap must not leave a marker claiming success.
root=$(fake_root nomarker)
log=$(run_launcher "$root")
rm -f "$root/.bootstrap-complete"
log=$(run_launcher "$root")
if grep -q 'npm ci' "$log"; then
  pass "absent marker re-bootstraps"
else
  fail "absent marker did not re-bootstrap" "$(cat "$log")"
fi

echo "=== fingerprint identity is platform + arch + ABI, not ABI alone ==="

# arm64 and x64 Node of the same major share NODE_MODULE_VERSION, but
# better-sqlite3 / onnxruntime-node / sqlite-vec binaries are arch-bound. A
# shared plugin cache reached from both must NOT match the marker.
root=$(fake_root archswap)
FAKE_NODE_ID="darwin-arm64-abi127" log=$(run_launcher "$root")
FAKE_NODE_ID="darwin-x64-abi127" log=$(run_launcher "$root")
if grep -q 'npm ci' "$log"; then
  pass "architecture change at a constant ABI re-bootstraps"
else
  fail "arm64 -> x64 at ABI 127 reused the marker — arch-bound binaries would misload" \
    "$(cat "$log")"
fi

root=$(fake_root platformswap)
FAKE_NODE_ID="darwin-arm64-abi127" log=$(run_launcher "$root")
FAKE_NODE_ID="linux-arm64-abi127" log=$(run_launcher "$root")
if grep -q 'npm ci' "$log"; then
  pass "platform change at a constant ABI re-bootstraps"
else
  fail "darwin -> linux at ABI 127 reused the marker" "$(cat "$log")"
fi

echo "=== no-hasher fallback never claims a match ==="

# With neither shasum, sha256sum, nor cksum on PATH the marker cannot describe
# the tree. A CONSTANT sentinel was the bug: the first bootstrap wrote it and
# every later check matched it, so lockfile and Node changes reused a stale
# build. The value must differ per call.
root=$(fake_root nohasher)
NOHASH_BIN="$TMP_ROOT/nohash-bin"
sanitized_bin "$NOHASH_BIN"

run_nohasher() {
  local r="$1" log="$1/calls.log"
  : >"$log"
  RC=0
  CALL_LOG="$log" CLAUDE_PLUGIN_ROOT="$r" PATH="$NOHASH_BIN" \
    bash "$r/scripts/launch-mcp.sh" >/dev/null 2>"$r/stderr.log" || RC=$?
  echo "$log"
}

log=$(run_nohasher "$root")
m1=$(cat "$root/.bootstrap-complete" 2>/dev/null || echo MISSING)
log=$(run_nohasher "$root")
m2=$(cat "$root/.bootstrap-complete" 2>/dev/null || echo MISSING)

if [ "$m1" = "MISSING" ] || [ "$m2" = "MISSING" ]; then
  fail "no-hasher run wrote no marker at all" "m1=$m1 m2=$m2"
elif [ "$m1" != "$m2" ]; then
  pass "no-hasher fingerprint differs per call (cannot self-match)"
else
  fail "no-hasher fingerprint is constant ($m1) — a stale build would be reused forever"
fi

if grep -q 'npm ci' "$log"; then
  pass "no-hasher second launch re-bootstraps rather than trusting the marker"
else
  fail "no-hasher second launch trusted a marker it could not compute" "$(cat "$log")"
fi

echo "=== cksum fallback keeps a real fingerprint when shasum is absent ==="

root=$(fake_root cksumonly)
CK_BIN="$TMP_ROOT/cksum-bin"
sanitized_bin "$CK_BIN" cksum

run_cksum() {
  local r="$1" log="$1/calls.log"
  : >"$log"
  RC=0
  CALL_LOG="$log" CLAUDE_PLUGIN_ROOT="$r" PATH="$CK_BIN" \
    bash "$r/scripts/launch-mcp.sh" >/dev/null 2>"$r/stderr.log" || RC=$?
  echo "$log"
}

log=$(run_cksum "$root")
c1=$(cat "$root/.bootstrap-complete" 2>/dev/null || echo MISSING)
log=$(run_cksum "$root")
c2=$(cat "$root/.bootstrap-complete" 2>/dev/null || echo MISSING)
if [ "$c1" != "MISSING" ] && [ "$c1" = "$c2" ] && ! grep -q 'npm ci' "$log"; then
  pass "cksum fallback yields a stable fingerprint (warm tree stays warm)"
else
  fail "cksum fallback did not produce a stable warm launch" "c1=$c1 c2=$c2"
fi

# ...and still tracks the lockfile, or it would be a constant by another name.
echo '{"lockfileVersion":3,"changed":true}' >"$root/package-lock.json"
log=$(run_cksum "$root")
if grep -q 'npm ci' "$log"; then
  pass "cksum fallback still detects a lockfile change"
else
  fail "cksum fingerprint ignored a lockfile change" "$(cat "$log")"
fi

echo "=== signal traps release the lock AND stop ==="

# Bash resumes after a TERM/INT trap. A handler that only cleaned up would drop
# the lock and then continue the rest of the bootstrap, letting a second
# launcher run `npm ci` concurrently against the same tree.
if grep -qE "trap '.*' INT" "$SRC" && grep -qE "trap '.*' TERM" "$SRC"; then
  pass "INT and TERM have handlers separate from EXIT"
else
  fail "INT/TERM still share the bare EXIT handler" "$(grep -n 'trap' "$SRC")"
fi

if grep -qE "trap 'rm -rf \"\\\$LOCK\"; exit [0-9]+' INT" "$SRC" \
  && grep -qE "trap 'rm -rf \"\\\$LOCK\"; exit [0-9]+' TERM" "$SRC"; then
  pass "signal handlers exit explicitly instead of resuming the script"
else
  fail "a signal handler cleans up but does not exit — bash would resume into a second npm ci" \
    "$(grep -n 'trap' "$SRC")"
fi

# Behavioral: TERM during `npm ci` must leave no lock, no marker, and a
# non-zero rc — not a script that ran on to completion.
root=$(fake_root signal)
SIG_BIN="$TMP_ROOT/sig-bin"
sanitized_bin "$SIG_BIN" shasum
# npm ci kills the launcher mid-install, standing in for Claude Code killing a
# slow first run. Overwrites the stub sanitized_bin just installed.
cat >"$SIG_BIN/npm" <<'STUB'
#!/usr/bin/env bash
echo "npm $*" >>"$CALL_LOG"
if [ "${1:-}" = "ci" ]; then
  kill -TERM "$LAUNCHER_PID"
  sleep 5
fi
exit 0
STUB
chmod +x "$SIG_BIN/npm"

log="$root/calls.log"
: >"$log"
RC=0
CALL_LOG="$log" CLAUDE_PLUGIN_ROOT="$root" PATH="$SIG_BIN" \
  bash -c 'LAUNCHER_PID=$$; export LAUNCHER_PID; exec bash "$1"' _ \
  "$root/scripts/launch-mcp.sh" >/dev/null 2>"$root/stderr.log" || RC=$?

if [ "$RC" -ne 0 ]; then
  pass "TERM during npm ci exits non-zero (rc=$RC)"
else
  fail "TERM during npm ci still exited 0 — the script resumed past the signal"
fi

if [ ! -d "$root/.bootstrap.lock" ]; then
  pass "TERM during npm ci leaves no lock behind"
else
  fail "lock survived a TERM — later launchers would wait out the stale window"
fi

if [ ! -f "$root/.bootstrap-complete" ]; then
  pass "TERM during npm ci writes no completion marker"
else
  fail "an interrupted bootstrap claimed completion"
fi

if ! grep -q 'npm run build' "$log"; then
  pass "TERM during npm ci stops before the build (no resumed bootstrap)"
else
  fail "script resumed past the signal and kept bootstrapping" "$(cat "$log")"
fi

echo "=== lock reclamation asks whether the owner died, not how old it is ==="

# A live owner must keep its lock however long the install takes. `npm ci`
# stalling on a slow registry past LOCK_STALE_MIN is a legitimate long
# bootstrap, and reclaiming there starts a SECOND destructive npm ci against
# the same tree — the race the lock exists to prevent (codex P2).
root=$(fake_root livelock)
rm -f "$root/dist/index.js"          # force the bootstrap path
mkdir -p "$root/.bootstrap.lock"
# Owner: this test process, which is very much alive, on this host.
printf '%s %s\n' "$$" "$(hostname)" >"$root/.bootstrap.lock/owner"
# Backdate the lock far beyond the stale window.
touch -t 200001010000 "$root/.bootstrap.lock" 2>/dev/null || true

log="$root/calls.log"; : >"$log"
RC=0
CALL_LOG="$log" CLAUDE_PLUGIN_ROOT="$root" PATH="$BIN:$PATH" \
  RALPH_KNOWLEDGE_BOOTSTRAP_STALE_MIN=30 RALPH_KNOWLEDGE_BOOTSTRAP_WAIT_SEC=4 \
  bash "$root/scripts/launch-mcp.sh" >/dev/null 2>"$root/stderr.log" || RC=$?

if grep -q 'npm ci' "$log"; then
  fail "reclaimed a 25-year-old lock whose owner is ALIVE — concurrent npm ci" "$(cat "$log")"
else
  pass "live owner keeps its lock regardless of age (no concurrent npm ci)"
fi
if [ "$RC" -ne 0 ] && grep -q "timed out" "$root/stderr.log"; then
  pass "waiter times out rather than stealing a live lock"
else
  fail "expected a wait-timeout against a live owner (rc=$RC)" "$(cat "$root/stderr.log")"
fi

# A dead owner is reclaimed AT ONCE — no need to wait out the stale window.
root=$(fake_root deadlock)
rm -f "$root/dist/index.js"
mkdir -p "$root/.bootstrap.lock"
# A PID that cannot be running: claim one, then make sure it is gone.
DEAD_PID=$( (bash -c 'echo $$') )
while kill -0 "$DEAD_PID" 2>/dev/null; do DEAD_PID=$((DEAD_PID + 1)); done
printf '%s %s\n' "$DEAD_PID" "$(hostname)" >"$root/.bootstrap.lock/owner"
# Deliberately FRESH: age alone would say "wait", liveness says "reclaim".
log="$root/calls.log"; : >"$log"
RC=0
CALL_LOG="$log" CLAUDE_PLUGIN_ROOT="$root" PATH="$BIN:$PATH" \
  RALPH_KNOWLEDGE_BOOTSTRAP_STALE_MIN=30 RALPH_KNOWLEDGE_BOOTSTRAP_WAIT_SEC=4 \
  bash "$root/scripts/launch-mcp.sh" >/dev/null 2>"$root/stderr.log" || RC=$?

if grep -q 'npm ci' "$log"; then
  pass "dead owner's lock is reclaimed immediately, without waiting out the window"
else
  fail "a fresh lock owned by a DEAD pid was not reclaimed — a crash would block for the full window" \
    "$(cat "$root/stderr.log")"
fi

# A foreign host's PID is not ours to probe, so age is the only signal left.
root=$(fake_root foreignlock)
rm -f "$root/dist/index.js"
mkdir -p "$root/.bootstrap.lock"
printf '%s %s\n' "$$" "some-other-host.example" >"$root/.bootstrap.lock/owner"
log="$root/calls.log"; : >"$log"
RC=0
CALL_LOG="$log" CLAUDE_PLUGIN_ROOT="$root" PATH="$BIN:$PATH" \
  RALPH_KNOWLEDGE_BOOTSTRAP_STALE_MIN=30 RALPH_KNOWLEDGE_BOOTSTRAP_WAIT_SEC=4 \
  bash "$root/scripts/launch-mcp.sh" >/dev/null 2>"$root/stderr.log" || RC=$?
if grep -q 'npm ci' "$log"; then
  fail "reclaimed a FRESH lock held by another host" "$(cat "$log")"
else
  pass "fresh foreign-host lock is left alone (falls back to age)"
fi

touch -t 200001010000 "$root/.bootstrap.lock" 2>/dev/null || true
log="$root/calls.log"; : >"$log"
RC=0
CALL_LOG="$log" CLAUDE_PLUGIN_ROOT="$root" PATH="$BIN:$PATH" \
  RALPH_KNOWLEDGE_BOOTSTRAP_STALE_MIN=30 RALPH_KNOWLEDGE_BOOTSTRAP_WAIT_SEC=4 \
  bash "$root/scripts/launch-mcp.sh" >/dev/null 2>"$root/stderr.log" || RC=$?
if grep -q 'npm ci' "$log"; then
  pass "aged foreign-host lock is reclaimed by age"
else
  fail "an ancient foreign lock was never reclaimed — unrecoverable after a crash" \
    "$(cat "$root/stderr.log")"
fi

# The age check must not depend on GNU-only find flags. stat is tried in both
# BSD (-f %m) and GNU (-c %Y) spellings; assert the portable route is present
# and that no find(1) age probe remains.
if grep -q 'stat -f %m' "$SRC" && grep -q 'stat -c %Y' "$SRC"; then
  pass "lock age uses both BSD and GNU stat spellings"
else
  fail "lock age is not portable across BSD/GNU stat" "$(grep -n 'stat ' "$SRC")"
fi
if grep -q 'find "\$LOCK"' "$SRC"; then
  fail "a find(1)-based lock-age probe is still present" "$(grep -n 'find "\$LOCK"' "$SRC")"
else
  pass "no find(1) lock-age probe remains"
fi

# The owner file must actually be written, or every reclaim decision silently
# degrades to the age fallback.
root=$(fake_root ownerfile)
log=$(run_launcher "$root")
if grep -q "printf '%s %s\\\\n' \"\\\$\\\$\" \"\\\$THIS_HOST\" >\"\\\$LOCK/owner\"" "$SRC"; then
  pass "the lock holder records pid + host"
else
  fail "no owner file is written — liveness could never be checked" "$(grep -n 'owner' "$SRC")"
fi

echo "=== concurrent waiters on one abandoned lock: exactly one bootstrap ==="

# Codex's reproduction, as a test. Many launchers meet the SAME lock left by a
# dead owner. Each can validate "owner is dead" before any removal happens, so
# an unserialized reap lets waiter B's stale verdict delete the fresh lock that
# waiter A just reclaimed — and both run a destructive `npm ci` on one tree.
#
# The invariant is not "one winner eventually" but "npm ci ran exactly once".
root=$(fake_root concurrent)
rm -f "$root/dist/index.js"                   # force the bootstrap path
mkdir -p "$root/.bootstrap.lock"
DEAD_PID=$( (bash -c 'echo $$') )
while kill -0 "$DEAD_PID" 2>/dev/null; do DEAD_PID=$((DEAD_PID + 1)); done
printf '%s %s\n' "$DEAD_PID" "$(hostname)" >"$root/.bootstrap.lock/owner"

# A slow `npm ci` widens the window a broken reaper would fall into. Each line
# is short, so appends from concurrent writers stay atomic in practice.
CC_BIN="$TMP_ROOT/concurrent-bin"
sanitized_bin "$CC_BIN" shasum
cat >"$CC_BIN/npm" <<'STUB'
#!/usr/bin/env bash
case "${1:-} ${2:-}" in
  "ci "*|"ci")
    echo "npm-ci pid=$$" >>"$CALL_LOG"
    sleep 2
    ;;
  "run build")
    # Produce the artifact a real build would. Without this the tree stays
    # unbootstrapped, every waiter in turn sees work to do, and the test
    # measures its own stub rather than the lock.
    echo 'console.log("server")' >dist/index.js
    ;;
esac
exit 0
STUB
chmod +x "$CC_BIN/npm"

CC_LOG="$root/concurrent.log"
: >"$CC_LOG"
WAITERS=30
for _ in $(seq 1 "$WAITERS"); do
  CALL_LOG="$CC_LOG" CLAUDE_PLUGIN_ROOT="$root" PATH="$CC_BIN" \
    RALPH_KNOWLEDGE_BOOTSTRAP_STALE_MIN=30 RALPH_KNOWLEDGE_BOOTSTRAP_WAIT_SEC=30 \
    bash "$root/scripts/launch-mcp.sh" >/dev/null 2>>"$root/concurrent.stderr" &
done
wait

# grep -c prints 0 AND exits 1 on no match, so `|| echo 0` would emit two
# lines and break the arithmetic below. Take grep's own count and default only
# when the variable is genuinely empty.
ci_runs=$(grep -c '^npm-ci ' "$CC_LOG" 2>/dev/null) || true
ci_runs=${ci_runs:-0}
if [ "$ci_runs" -eq 1 ]; then
  pass "$WAITERS concurrent waiters on an abandoned lock produced exactly 1 npm ci"
else
  fail "$WAITERS concurrent waiters produced $ci_runs concurrent npm ci runs (want exactly 1)" \
    "$(sort "$CC_LOG" | uniq -c)"
fi

# The reap lock is a critical section, not a leak: nothing may survive the run.
if [ ! -d "$root/.bootstrap.reap" ]; then
  pass "reap lock is released (no leaked critical section)"
else
  fail "reap lock survived the run — reclamation would be wedged forever"
fi

# ...and the tree really did get bootstrapped by the one winner.
if [ -f "$root/.bootstrap-complete" ]; then
  pass "the single winner completed the bootstrap"
else
  fail "no winner completed the bootstrap" "$(tail -5 "$root/concurrent.stderr" 2>/dev/null)"
fi

echo "=== reap lock: serialized, and self-healing when its holder dies ==="

# A reaper holding the reap lock blocks other reapers. With a live reap lock
# held by nobody (fresh, never released), a waiter must NOT delete the lock.
root=$(fake_root reapheld)
rm -f "$root/dist/index.js"
mkdir -p "$root/.bootstrap.lock" "$root/.bootstrap.reap"
printf '%s %s\n' "$DEAD_PID" "$(hostname)" >"$root/.bootstrap.lock/owner"
log="$root/calls.log"; : >"$log"
RC=0
CALL_LOG="$log" CLAUDE_PLUGIN_ROOT="$root" PATH="$BIN:$PATH" \
  RALPH_KNOWLEDGE_BOOTSTRAP_STALE_MIN=30 RALPH_KNOWLEDGE_BOOTSTRAP_WAIT_SEC=4 \
  RALPH_KNOWLEDGE_REAP_STALE_MIN=60 \
  bash "$root/scripts/launch-mcp.sh" >/dev/null 2>"$root/stderr.log" || RC=$?
if grep -q 'npm ci' "$log"; then
  fail "reaped a lock while another reaper held the reap lock" "$(cat "$log")"
else
  pass "a held reap lock serializes reclamation (waiter defers)"
fi

# But a reap lock whose holder died must not wedge reclamation forever.
root=$(fake_root reapstale)
rm -f "$root/dist/index.js"
mkdir -p "$root/.bootstrap.lock" "$root/.bootstrap.reap"
printf '%s %s\n' "$DEAD_PID" "$(hostname)" >"$root/.bootstrap.lock/owner"
touch -t 200001010000 "$root/.bootstrap.reap" 2>/dev/null || true
log="$root/calls.log"; : >"$log"
RC=0
CALL_LOG="$log" CLAUDE_PLUGIN_ROOT="$root" PATH="$BIN:$PATH" \
  RALPH_KNOWLEDGE_BOOTSTRAP_STALE_MIN=30 RALPH_KNOWLEDGE_BOOTSTRAP_WAIT_SEC=4 \
  bash "$root/scripts/launch-mcp.sh" >/dev/null 2>"$root/stderr.log" || RC=$?
if grep -q 'npm ci' "$log"; then
  pass "an abandoned reap lock is cleared (reclamation self-heals)"
else
  fail "a stale reap lock wedged reclamation permanently" "$(cat "$root/stderr.log")"
fi

echo
echo "launch-mcp.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
