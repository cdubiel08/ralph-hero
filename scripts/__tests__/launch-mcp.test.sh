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
  -e)
    # Emulates deps_complete(). A directory of the right NAME is not enough —
    # that was the defect — so the manifest must exist and its entry file must
    # be present. Derived from package.json, since hand-listing packages here
    # would defeat the finding this covers.
    miss=0
    for d in $(sed -n '/"dependencies"/,/}/p' package.json 2>/dev/null \
      | grep -oE '"[^"]+"[[:space:]]*:' | sed 's/"//g; s/[[:space:]]*:$//' \
      | grep -v '^dependencies$'); do
      manifest="node_modules/$d/package.json"
      if [ ! -f "$manifest" ]; then miss=1; continue; fi
      entry=$(grep -oE '"main"[[:space:]]*:[[:space:]]*"[^"]+"' "$manifest" \
        | sed 's/.*"main"[[:space:]]*:[[:space:]]*"//; s/"$//')
      [ -n "$entry" ] || entry="index.js"
      [ -f "node_modules/$d/$entry" ] || miss=1
    done
    [ "$miss" -eq 0 ] || exit 1
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
BASE_UTILS="bash env rm mv cat find mkdir sleep date uname cut kill sed grep ls dirname basename pwd stat hostname touch"
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
  mkdir -p "$root/scripts" "$root/dist"
  # Real installations, not bare directories. Empty dirs were the defect the
  # entry-point check exists to catch, so a fixture made of them would let a
  # name-only check pass and prove nothing (codex P2, PR #1755).
  local d
  for d in "@huggingface/transformers" "@modelcontextprotocol/sdk" \
    "better-sqlite3" "zod" "typescript"; do
    mkdir -p "$root/node_modules/$d"
    printf '{"name":"%s","main":"index.js"}\n' "$d" >"$root/node_modules/$d/package.json"
    echo 'module.exports = {}' >"$root/node_modules/$d/index.js"
  done
  cp "$SRC" "$root/scripts/launch-mcp.sh"
  chmod +x "$root/scripts/launch-mcp.sh"
  echo 'console.log("server")' >"$root/dist/index.js"
  # Dependencies are declared, because the completeness check reads them from
  # here rather than from a hand-maintained list in the launcher.
  cat >"$root/package.json" <<'PKG'
{
  "name": "ralph-hero-knowledge-index",
  "dependencies": {
    "@huggingface/transformers": "1",
    "@modelcontextprotocol/sdk": "1",
    "better-sqlite3": "1",
    "zod": "1"
  },
  "devDependencies": { "typescript": "5" }
}
PKG
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
rm -rf "$root/node_modules/better-sqlite3"
log=$(run_launcher "$root")
if grep -q 'npm ci' "$log"; then
  pass "missing dependency re-bootstraps (skip-work never serves a broken tree)"
else
  fail "missing better-sqlite3 did not re-bootstrap" "$(cat "$log")"
fi

# The finding: the check used to name a few packages by hand, and `zod` — which
# src/index.ts imports immediately — was not among them. A tree missing it
# passed as complete and the final exec failed instead of repairing itself.
root=$(fake_root missingzod)
log=$(run_launcher "$root")                       # warm it
rm -rf "$root/node_modules/zod"
log=$(run_launcher "$root")
if grep -q 'npm ci' "$log"; then
  pass "a dependency outside any hand-written list still re-bootstraps (zod)"
else
  fail "missing zod passed as a complete tree — exec would fail instead of repairing" \
    "$(cat "$log")"
fi

# The sharper half of the finding: a directory of the right NAME is not proof
# of a usable installation. Partial cleanup leaves the directory and removes
# its contents, and a name-only check calls that complete — so the marker is
# trusted and the server dies on its static import.
root=$(fake_root emptydep)
log=$(run_launcher "$root")                       # warm it
rm -rf "$root/node_modules/zod"
mkdir -p "$root/node_modules/zod"                 # present, but empty
log=$(run_launcher "$root")
if grep -q 'npm ci' "$log"; then
  pass "an empty dependency directory re-bootstraps (name alone is not enough)"
else
  fail "an EMPTY node_modules/zod passed as installed — exec would fail on its static import" \
    "$(cat "$log")"
fi

# ...and a manifest whose entry point is gone is equally unusable.
root=$(fake_root gonEntry)
log=$(run_launcher "$root")                       # warm it
rm -f "$root/node_modules/zod/index.js"           # manifest stays, entry gone
log=$(run_launcher "$root")
if grep -q 'npm ci' "$log"; then
  pass "a dependency whose entry point is missing re-bootstraps"
else
  fail "a package with no entry file passed as installed" "$(cat "$log")"
fi

# devDependencies are pruned by design; demanding them would rebuild forever.
root=$(fake_root prunedev)
log=$(run_launcher "$root")                       # warm it
rm -rf "$root/node_modules/typescript"
log=$(run_launcher "$root")
if grep -q 'npm ci' "$log"; then
  fail "an absent devDependency forced a rebuild — the prune step guarantees it is absent" \
    "$(cat "$log")"
else
  pass "a pruned devDependency does not trigger a rebuild"
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

if grep -qE "trap '.*rm -rf \"\\\$LOCK\"; exit [0-9]+' INT" "$SRC" \
  && grep -qE "trap '.*rm -rf \"\\\$LOCK\"; exit [0-9]+' TERM" "$SRC"; then
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

echo "=== the launcher never deletes a lock it does not own ==="

# The terminal property, and the reason ~160 lines of reclamation machinery are
# gone (codex P2 x6). Every scheme for detecting and deleting an abandoned lock
# is check-then-delete on a shared pathname, and each serialization layer needed
# its own reclamation in turn. `mkdir` can create atomically but can never
# safely destroy someone else's directory, so the launcher does not try.
#
# Consequence under test: a pre-existing lock is NEVER removed by a waiter,
# whatever it looks like — live owner, dead owner, ancient, ownerless.

# A PID that cannot be running: claim one, then walk until it is genuinely free.
DEAD_PID=$( (bash -c 'echo $$') )
while kill -0 "$DEAD_PID" 2>/dev/null; do DEAD_PID=$((DEAD_PID + 1)); done

for scenario in liveowner deadowner ancient ownerless; do
  root=$(fake_root "noreclaim-$scenario")
  rm -f "$root/dist/index.js"
  mkdir -p "$root/.bootstrap.lock"
  case "$scenario" in
    liveowner) printf '%s %s %s\n' "$$" "$(hostname)" "$(date +%s)" >"$root/.bootstrap.lock/owner" ;;
    deadowner) printf '%s %s %s\n' "$DEAD_PID" "$(hostname)" "$(date +%s)" >"$root/.bootstrap.lock/owner" ;;
    ancient)
      printf '%s %s 0\n' "$DEAD_PID" "$(hostname)" >"$root/.bootstrap.lock/owner"
      touch -t 200001010000 "$root/.bootstrap.lock" 2>/dev/null || true ;;
    ownerless)
      touch -t 200001010000 "$root/.bootstrap.lock" 2>/dev/null || true ;;
  esac

  log="$root/calls.log"; : >"$log"
  RC=0
  CALL_LOG="$log" CLAUDE_PLUGIN_ROOT="$root" PATH="$BIN:$PATH" \
    RALPH_KNOWLEDGE_BOOTSTRAP_WAIT_SEC=4 \
    bash "$root/scripts/launch-mcp.sh" >/dev/null 2>"$root/stderr.log" || RC=$?

  if [ -d "$root/.bootstrap.lock" ] && ! grep -q 'npm ci' "$log"; then
    pass "pre-existing lock ($scenario) is neither deleted nor bypassed"
  else
    fail "a waiter destroyed or bypassed a lock it did not own ($scenario)" \
      "lock_present=$([ -d "$root/.bootstrap.lock" ] && echo yes || echo NO); $(cat "$log")"
  fi
done

# Failing closed is only honest if the operator can act on it: the timeout must
# name the holder and the exact directory to remove.
root=$(fake_root timeoutmsg)
rm -f "$root/dist/index.js"
mkdir -p "$root/.bootstrap.lock"
printf '%s %s %s\n' "$DEAD_PID" "some-other-host" "0" >"$root/.bootstrap.lock/owner"
RC=0
CALL_LOG="$root/calls.log" CLAUDE_PLUGIN_ROOT="$root" PATH="$BIN:$PATH" \
  RALPH_KNOWLEDGE_BOOTSTRAP_WAIT_SEC=4 \
  bash "$root/scripts/launch-mcp.sh" >/dev/null 2>"$root/stderr.log" || RC=$?

if [ "$RC" -ne 0 ]; then
  pass "a wedged lock fails loudly rather than bootstrapping anyway (rc=$RC)"
else
  fail "a wedged lock exited 0 — the caller would think the server started"
fi
if grep -q "remove .*\.bootstrap\.lock and relaunch" "$root/stderr.log"; then
  pass "the timeout names the directory to remove"
else
  fail "no recovery instruction on timeout" "$(cat "$root/stderr.log")"
fi
if grep -q "held by: .*some-other-host" "$root/stderr.log"; then
  pass "the timeout names who holds the lock"
else
  fail "the timeout does not say who holds the lock" "$(cat "$root/stderr.log")"
fi

# And no reclamation machinery may creep back in.
if grep -qE 'reap_abandoned_lock|lock_reclaimable|dir_reclaimable|LOCK_STALE_MIN' "$SRC"; then
  fail "reclamation logic is back — every version of it raced" \
    "$(grep -nE 'reap_abandoned_lock|lock_reclaimable|dir_reclaimable|LOCK_STALE_MIN' "$SRC")"
else
  pass "no lock-reclamation machinery remains"
fi
if grep -qE 'mv "\$LOCK"|rm -rf "\$LOCK/reaping"|\.bootstrap\.reap' "$SRC"; then
  fail "a lock-stealing primitive is back" "$(grep -nE 'mv \"\$LOCK\"|reaping|bootstrap.reap' "$SRC")"
else
  pass "the lock is never moved, and no reap marker exists"
fi

echo "=== signal handlers disarm EXIT before removing their own lock ==="

# Otherwise the handler removes the lock, then `exit` runs the still-armed EXIT
# trap and removes the pathname AGAIN — deleting whatever waiter acquired it in
# between, which lets a third waiter bootstrap concurrently.
if grep -cE "trap 'trap - EXIT; rm -rf \"\\\$LOCK\"; exit [0-9]+' (INT|TERM)" "$SRC" | grep -q '^2$'; then
  pass "both INT and TERM disarm EXIT before removing the lock"
else
  fail "a signal handler removes the lock with EXIT still armed (double removal)" \
    "$(grep -n 'trap' "$SRC")"
fi
if grep -qE "trap 'rm -rf \"\\\$LOCK\"; exit [0-9]+'" "$SRC"; then
  fail "a signal handler still removes the lock without disarming EXIT first" \
    "$(grep -n 'trap' "$SRC")"
else
  pass "no signal handler removes the lock with EXIT armed"
fi
if grep -q 'find "\$LOCK"' "$SRC"; then
  fail "a find(1)-based lock-age probe is still present" "$(grep -n 'find "\$LOCK"' "$SRC")"
else
  pass "no find(1) probe of the lock remains"
fi

# The owner file must actually be written, or every reclaim decision silently
# degrades to the age fallback.
root=$(fake_root ownerfile)
log=$(run_launcher "$root")
if grep -q 'lock_write_owner' "$SRC"; then
  pass "the lock holder records an owner identity"
else
  fail "no owner file is written — liveness could never be checked" "$(grep -n 'owner' "$SRC")"
fi

# ...and the lock is never taken out of its path to be inspected. That absence
# window is what CI's 2-core runner exploited into 3 concurrent installs.
if grep -q 'mv "$LOCK" "$grave"' "$SRC"; then
  fail "the lock is still moved out of its path, opening an absence window"
else
  pass "the lock is never moved out of its path (no absence window)"
fi

echo "=== bootstrap installs dev deps even when the env says to omit them ==="

# `tsc` is a devDependency and `npm run build` runs it immediately after the
# install. Claude Code inheriting NODE_ENV=production (or a user's npm config)
# makes plain `npm ci` skip it, so the build fails on every first launch and
# the completion marker is never written — the bootstrap can never finish.
root=$(fake_root devdeps)
rm -f "$root/dist/index.js"
log="$root/calls.log"; : >"$log"
RC=0
CALL_LOG="$log" CLAUDE_PLUGIN_ROOT="$root" PATH="$BIN:$PATH" NODE_ENV=production \
  bash "$root/scripts/launch-mcp.sh" >/dev/null 2>"$root/stderr.log" || RC=$?

if grep -qE '^npm ci .*--include=dev' "$log"; then
  pass "npm ci forces dev dependencies in (survives NODE_ENV=production)"
else
  fail "npm ci does not force dev deps — tsc would be missing and the build would fail" \
    "$(grep '^npm ' "$log")"
fi

# ...and they are still pruned afterwards, or the disk saving this PR exists
# for would be given straight back.
if grep -qE '^npm prune .*--omit=dev' "$log"; then
  pass "dev dependencies are pruned again after the build"
else
  fail "dev deps are installed but never pruned — that is the disk cost back" \
    "$(grep '^npm ' "$log")"
fi

echo "=== deps_complete runs the REAL node program, not a stub ==="

# Everything above stubs `node`, so those cases exercise the test's own
# reimplementation of deps_complete rather than the launcher's. That is enough
# for the surrounding control flow, but it proves nothing about the check
# itself — a name-only implementation still passes them. (Verified: mutating
# the launcher back to `fs.existsSync(dir)` leaves the stubbed cases green.)
#
# So this section sources the real function and runs it under the real node,
# against real fixtures. It is the only place the shipped JavaScript is
# actually executed.
if ! command -v node >/dev/null 2>&1; then
  echo "  SKIP: no node on PATH, cannot exercise the real deps_complete"
else
  # eval rather than `. <(...)`: process substitution did not reliably deliver
  # the function here, and a silently unsourced function would make every case
  # below fail for the wrong reason.
  eval "$(sed -n '/^deps_complete() {/,/^}/p' "$SRC")"

  if ! type deps_complete >/dev/null 2>&1; then
    fail "deps_complete could not be sourced — the cases below would prove nothing"
  fi

  dep_fixture() {
    local root="$TMP_ROOT/$1"
    mkdir -p "$root/node_modules/zod"
    cat >"$root/package.json" <<'PKG'
{ "name": "t", "dependencies": { "zod": "1" } }
PKG
    printf '{"name":"zod","main":"index.js"}\n' >"$root/node_modules/zod/package.json"
    echo 'module.exports = {}' >"$root/node_modules/zod/index.js"
    echo "$root"
  }

  root=$(dep_fixture real_ok)
  if ( cd "$root" && deps_complete ); then
    pass "a real installation satisfies deps_complete"
  else
    fail "a complete tree was reported incomplete — this would rebuild on every launch"
  fi

  # The exact case codex named: the directory survives, its contents do not.
  root=$(dep_fixture real_empty)
  rm -rf "$root/node_modules/zod"
  mkdir -p "$root/node_modules/zod"
  if ( cd "$root" && deps_complete ); then
    fail "an EMPTY node_modules/zod satisfied the real deps_complete — name-only check"
  else
    pass "an empty dependency directory fails the real deps_complete"
  fi

  # Manifest present, entry point deleted.
  root=$(dep_fixture real_noentry)
  rm -f "$root/node_modules/zod/index.js"
  if ( cd "$root" && deps_complete ); then
    fail "a package with no entry file satisfied the real deps_complete"
  else
    pass "a missing entry point fails the real deps_complete"
  fi

  # A package absent altogether.
  root=$(dep_fixture real_absent)
  rm -rf "$root/node_modules/zod"
  if ( cd "$root" && deps_complete ); then
    fail "an absent dependency satisfied the real deps_complete"
  else
    pass "an absent dependency fails the real deps_complete"
  fi

  # A native package needs its COMPILED ADDON, not just its JavaScript. This is
  # the better-sqlite3 case: the JS entry survives a partial cleanup while
  # build/Release/*.node does not, and startup then dies constructing the
  # database instead of repairing the tree.
  root=$(dep_fixture real_native)
  mkdir -p "$root/node_modules/zod/build/Release"
  echo '{}' >"$root/node_modules/zod/binding.gyp"
  : >"$root/node_modules/zod/build/Release/zod.node"
  if ( cd "$root" && deps_complete ); then
    pass "a native package with its addon present is complete"
  else
    fail "a healthy native package was reported incomplete — this would reinstall every launch"
  fi

  rm -rf "$root/node_modules/zod/build"
  if ( cd "$root" && deps_complete ); then
    fail "a native package with NO compiled addon passed — startup would die on the addon load"
  else
    pass "a native package missing its compiled addon fails deps_complete"
  fi

  # A subpath-only exports map must NOT be enforced. Real packages ship these:
  # @modelcontextprotocol/sdk declares "." -> ./dist/esm/index.js, does not
  # ship that file, and imports fine via ./server/index.js. Enforcing it
  # reported this very repo's tree as broken.
  root=$(dep_fixture real_subpath)
  cat >"$root/node_modules/zod/package.json" <<'PKG'
{ "name": "zod", "exports": { ".": { "import": "./dist/esm/index.js" }, "./sub": "./dist/sub.js" } }
PKG
  rm -f "$root/node_modules/zod/index.js"
  if ( cd "$root" && deps_complete ); then
    pass "a subpath-only exports map is not enforced (no false rebuild)"
  else
    fail "an exports-only package was reported incomplete — a healthy tree would reinstall forever"
  fi

  # Lenient in the documented direction: a manifest with only a conditional
  # exports map, whose entry cannot be reduced to one path, must NOT force a
  # rebuild — a false "missing" costs a destructive reinstall every launch.
  root=$(dep_fixture real_exports)
  cat >"$root/node_modules/zod/package.json" <<'PKG'
{ "name": "zod", "exports": { ".": { "types": "./t.d.ts" } } }
PKG
  rm -f "$root/node_modules/zod/index.js"
  echo 'x' >"$root/node_modules/zod/t.d.ts"
  if ( cd "$root" && deps_complete ); then
    pass "an undeterminable exports map is accepted rather than rebuilt forever"
  else
    fail "a conditional-exports package forced a rebuild — every launch would reinstall"
  fi
fi

echo "=== a rebuild never replaces a tree another runtime may be serving ==="

# One plugin cache can be reached by two Node identities — arm64 native beside
# x64 under Rosetta, or two machines on a shared home. The identity whose
# fingerprint MATCHES skips the lock entirely and execs the server; if the other
# identity then rebuilds, `npm ci` swaps node_modules underneath a live process
# and it dies on its next lazy require (codex P2). Full isolation is per-identity
# trees (#1844); what is enforced here is the other remedy — do not replace a
# tree something is still using.
if ! { [ -d /proc ] || command -v lsof >/dev/null 2>&1; }; then
  echo "  SKIP: no /proc and no lsof, so in-use detection cannot be exercised"
else
  root=$(fake_root identity_busy)
  FAKE_NODE_ID="darwin-arm64-abi127" log=$(run_launcher "$root")   # build as A

  # A realistic live SERVER: cwd in the tree AND `dist/index.js` in argv, which
  # is how launch-mcp.sh execs it. Both signals are required, so a bare `sleep`
  # would not (and must not) count — see the waiting-launcher case below.
  ( cd "$root" && exec /bin/sh -c 'sleep 60; :' "node dist/index.js" ) &
  busy_pid=$!
  sleep 0.3

  RC=0
  log="$root/calls.log"; : >"$log"
  CALL_LOG="$log" CLAUDE_PLUGIN_ROOT="$root" PATH="$BIN:$PATH" \
    FAKE_NODE_ID="darwin-x64-abi127" \
    bash "$root/scripts/launch-mcp.sh" >/dev/null 2>"$root/stderr.log" || RC=$?
  kill "$busy_pid" 2>/dev/null || true

  if grep -q 'npm ci' "$log"; then
    fail "a second runtime rebuilt a tree with a live process in it — node_modules swapped under a running server" \
      "$(cat "$log")"
  else
    pass "a cross-identity rebuild is refused while the tree is in use"
  fi
  if [ "$RC" -ne 0 ]; then
    pass "the refusal exits non-zero rather than serving a mismatched tree"
  else
    fail "the refusal exited 0 — the caller would think the server started"
  fi
  if grep -q 'close every session using this plugin root' "$root/stderr.log"; then
    pass "the refusal tells the operator to close sessions"
  else
    fail "the refusal gives no remedy" "$(cat "$root/stderr.log")"
  fi

  # Deleting node_modules must never be offered as an ALTERNATIVE to closing
  # sessions — it destroys the tree the guard just refused to disrupt. It may
  # only appear as the step AFTER they are closed.
  if grep -qE 'close .*, or remove .*node_modules' "$root/stderr.log"; then
    fail "deletion is offered instead of closing sessions — that breaks the very session being protected" \
      "$(cat "$root/stderr.log")"
  else
    pass "deletion is not offered as an alternative to closing sessions"
  fi
  if grep -q 'once they are closed' "$root/stderr.log"; then
    pass "deletion is sequenced after closing sessions"
  else
    fail "the remedy never says when deletion becomes safe" "$(cat "$root/stderr.log")"
  fi
  # The tree must be left intact, not half-rebuilt.
  if [ -f "$root/.bootstrap-complete" ] && [ -d "$root/node_modules/zod" ]; then
    pass "the refused rebuild left the existing tree untouched"
  else
    fail "the refused rebuild damaged the tree it declined to replace"
  fi
fi

# ...but an IDLE tree must still rebuild, or a permanent arch switch could
# never recover on its own. (The arch-swap cases above cover this: they change
# identity with nothing running and require `npm ci`.)

echo "=== a live server blocks a rebuild even at the SAME identity ==="

if ! { [ -d /proc ] || { command -v lsof >/dev/null 2>&1 && command -v ps >/dev/null 2>&1; }; }; then
  echo "  SKIP: cannot probe for running servers on this host"
else
  # A damaged marker, a changed lockfile or a missing entry point all reach
  # `npm ci` at the SAME identity — and that replaces node_modules underneath a
  # server still serving from the tree (codex P2). Identity is not the only
  # thing worth guarding.
  root=$(fake_root sameid_live)
  log=$(run_launcher "$root")                    # build it, same identity
  rm -f "$root/.bootstrap-complete"              # force the rebuild path
  ( cd "$root" && exec /bin/sh -c 'sleep 60; :' "node dist/index.js" ) &
  live_pid=$!
  sleep 0.3
  RC=0
  log="$root/calls.log"; : >"$log"
  CALL_LOG="$log" CLAUDE_PLUGIN_ROOT="$root" PATH="$BIN:$PATH" \
    bash "$root/scripts/launch-mcp.sh" >/dev/null 2>"$root/stderr.log" || RC=$?
  kill "$live_pid" 2>/dev/null || true

  if grep -q 'npm ci' "$log"; then
    fail "rebuilt at the same identity with a server live in the tree" "$(cat "$log")"
  else
    pass "a live server blocks a same-identity rebuild"
  fi
  if [ "$RC" -ne 0 ] && grep -q 'a server is still running' "$root/stderr.log"; then
    pass "the refusal names the live server and exits non-zero"
  else
    fail "the same-identity refusal is not reported properly (rc=$RC)" "$(cat "$root/stderr.log")"
  fi

  # ...but a merely WAITING LAUNCHER must not block. It also has its cwd in the
  # plugin root, so a probe that matched any process there would turn two
  # simultaneous cold starts into a hard failure instead of a race.
  root=$(fake_root waiter_not_server)
  log=$(run_launcher "$root")
  rm -f "$root/.bootstrap-complete"
  ( cd "$root" && exec /bin/sh -c 'sleep 60; :' "bash scripts/launch-mcp.sh" ) &
  waiter_pid=$!
  sleep 0.3
  RC=0
  log="$root/calls.log"; : >"$log"
  CALL_LOG="$log" CLAUDE_PLUGIN_ROOT="$root" PATH="$BIN:$PATH" \
    bash "$root/scripts/launch-mcp.sh" >/dev/null 2>"$root/stderr.log" || RC=$?
  kill "$waiter_pid" 2>/dev/null || true

  if grep -q 'npm ci' "$log"; then
    pass "another launcher waiting in the tree does not block the rebuild"
  else
    fail "a waiting launcher was mistaken for a live server — concurrent cold starts would deadlock" \
      "$(cat "$root/stderr.log")"
  fi
fi

echo "=== provenance that cannot be verified fails closed ==="

if ! { [ -d /proc ] || command -v lsof >/dev/null 2>&1; }; then
  echo "  SKIP: no /proc and no lsof"
else
  # A tree built on ANOTHER host. Its processes are not in our process table,
  # so a locally idle directory is not globally idle — the local probe simply
  # cannot speak for a shared home (codex P2). Nothing is running here, and it
  # must STILL refuse.
  root=$(fake_root identity_foreignhost)
  FAKE_NODE_ID="darwin-arm64-abi127" log=$(run_launcher "$root")
  printf '%s %s\n' "node-darwin-arm64-abi127" "some-other-host" >"$root/.bootstrap-identity"
  RC=0
  log="$root/calls.log"; : >"$log"
  CALL_LOG="$log" CLAUDE_PLUGIN_ROOT="$root" PATH="$BIN:$PATH" \
    FAKE_NODE_ID="darwin-x64-abi127" \
    bash "$root/scripts/launch-mcp.sh" >/dev/null 2>"$root/stderr.log" || RC=$?
  if grep -q 'npm ci' "$log"; then
    fail "rebuilt a tree built on another host while locally idle — a live remote server would be clobbered" \
      "$(cat "$log")"
  else
    pass "a tree built on another host is never rebuilt from here, idle or not"
  fi
  if grep -q 'process table cannot see it' "$root/stderr.log"; then
    pass "the refusal explains that the other host cannot be probed"
  else
    fail "the refusal does not explain the cross-host limitation" "$(cat "$root/stderr.log")"
  fi

  # Identity metadata missing entirely: provenance is UNKNOWN, not "ours". A
  # deleted or never-written identity file used to skip the guard completely.
  root=$(fake_root identity_missing)
  FAKE_NODE_ID="darwin-arm64-abi127" log=$(run_launcher "$root")
  rm -f "$root/.bootstrap-identity"
  rm -f "$root/.bootstrap-complete"          # force the rebuild path
  ( cd "$root" && exec /bin/sh -c 'sleep 60; :' "node dist/index.js" ) &
  miss_pid=$!
  sleep 0.3
  RC=0
  log="$root/calls.log"; : >"$log"
  CALL_LOG="$log" CLAUDE_PLUGIN_ROOT="$root" PATH="$BIN:$PATH" \
    bash "$root/scripts/launch-mcp.sh" >/dev/null 2>"$root/stderr.log" || RC=$?
  kill "$miss_pid" 2>/dev/null || true
  if grep -q 'npm ci' "$log"; then
    fail "rebuilt a tree of unknown provenance with a live process in it" "$(cat "$log")"
  else
    pass "a tree with no identity record is not rebuilt while in use"
  fi
  # Either refusal is correct here, and the live-server check now fires first —
  # it is the stronger reason, since it observes an actual server rather than
  # inferring risk from absent metadata. What must not happen is a rebuild.
  if grep -qE 'a server is still running|no identity record' "$root/stderr.log"; then
    pass "the refusal states why the rebuild was declined"
  else
    fail "the rebuild was declined with no reason given" "$(cat "$root/stderr.log")"
  fi

  # ...but an IDLE tree of unknown provenance must still rebuild, or every
  # upgrade from a launcher version that wrote no identity would be stuck.
  root=$(fake_root identity_missing_idle)
  FAKE_NODE_ID="darwin-arm64-abi127" log=$(run_launcher "$root")
  rm -f "$root/.bootstrap-identity" "$root/.bootstrap-complete"
  log=$(run_launcher "$root")
  if grep -q 'npm ci' "$log"; then
    pass "an idle tree of unknown provenance still rebuilds (upgrades are not blocked)"
  else
    fail "an idle tree could not be rebuilt — upgrades from an older launcher would wedge" \
      "$(cat "$root/stderr.log")"
  fi
fi

# The identity must be published BEFORE the completion marker, or a tree can
# survive looking complete while carrying no provenance at all — which is the
# state the guard above has to treat as unknown.
# Match the WRITE, not the `rm -f "$MARKER" "$IDENTITY_FILE"` line — anchoring
# on the bare name matched that instead, which made this assertion vacuous
# (a deliberate swap did not fail it).
id_line=$(grep -n '>"\$IDENTITY_FILE"' "$SRC" | head -1 | cut -d: -f1)
marker_line=$(grep -n 'fingerprint >"\$MARKER"' "$SRC" | head -1 | cut -d: -f1)
if [ -n "$id_line" ] && [ -n "$marker_line" ] && [ "$id_line" -lt "$marker_line" ]; then
  pass "the identity record is written before the completion marker"
else
  fail "the marker is written before the identity — a complete tree could carry no provenance" \
    "identity_line=${id_line:-none} marker_line=${marker_line:-none}"
fi

echo "=== waiters leave as soon as the tree is complete ==="

# Losers used to keep polling after the winner finished, each waking on its own
# 2s tick to take a lock it no longer needed — roughly one polling interval per
# waiter on a cold start (codex P2). They must re-check and leave instead.
root=$(fake_root fastwait)
rm -f "$root/dist/index.js"
FW_BIN="$TMP_ROOT/fastwait-bin"
sanitized_bin "$FW_BIN" shasum
cat >"$FW_BIN/npm" <<'STUB'
#!/usr/bin/env bash
case "${1:-} ${2:-}" in
  "ci "*|"ci") sleep 1 ;;
  "run build") echo 'console.log("server")' >dist/index.js ;;
esac
exit 0
STUB
chmod +x "$FW_BIN/npm"

fw_start=$(date +%s)
for _ in $(seq 1 15); do
  CALL_LOG="$root/fw.log" CLAUDE_PLUGIN_ROOT="$root" PATH="$FW_BIN" \
    RALPH_KNOWLEDGE_BOOTSTRAP_WAIT_SEC=120 \
    bash "$root/scripts/launch-mcp.sh" >/dev/null 2>>"$root/fw.stderr" &
done
wait
fw_elapsed=$(( $(date +%s) - fw_start ))

# Serialized, 15 waiters would cost ~15 polling intervals (~30s) on top of the
# install. Leaving early keeps it near the install itself. The bound is loose
# so a slow runner does not make this flaky, while still failing the old shape.
if [ "$fw_elapsed" -le 20 ]; then
  pass "15 waiters cleared a cold start in ${fw_elapsed}s (no per-waiter polling tax)"
else
  fail "15 waiters took ${fw_elapsed}s — waiters are still serializing after the bootstrap" \
    "$(sort "$root/fw.stderr" 2>/dev/null | uniq -c | head -5)"
fi


# The probe must CAPTURE lsof's output before matching it. Piping `lsof` into
# `grep -q`/`awk` is the obvious spelling and is wrong under `pipefail`: the
# matcher exits on the first hit, lsof takes SIGPIPE, and the pipeline reports
# failure — so a positive detection is discarded. It depends on how much lsof
# has written, so it fails intermittently, and it fails in the direction that
# calls an in-use cache safe to delete.
#
# This is a STRUCTURAL check, deliberately: the behaviour is timing-dependent,
# so no assertion catches it reliably. Reverting the fix does NOT fail the
# behavioural cases on a fast machine, which is exactly why the shape is
# pinned here instead.
# Comments in the source explain this hazard and would match the pattern, so
# strip them first. Captured rather than piped, for the same reason the code
# under test is.
src_code=$(grep -v '^[[:space:]]*#' "$SRC")
if grep -qE 'lsof[^|]*\|[[:space:]]*(grep|awk)' <<<"$src_code"; then
  fail "lsof is piped straight into a matcher — a SIGPIPE under pipefail discards the match" \
    "$(grep -nE 'lsof[^|]*\|' "$SRC")"
else
  pass "lsof output is captured before matching (no pipefail/SIGPIPE hazard)"
fi

echo "=== concurrent launchers on a cold tree: exactly one bootstrap ==="

# The property that actually matters, now resting on `mkdir` alone. Several
# Claude Code sessions starting at once must produce ONE destructive install,
# not one-per-session. Counting total `npm ci` runs (not "a winner emerged")
# is deliberate: sequential duplicates are a failure too.
root=$(fake_root concurrent)
rm -f "$root/dist/index.js"

CC_BIN="$TMP_ROOT/concurrent-bin"
sanitized_bin "$CC_BIN" shasum
cat >"$CC_BIN/npm" <<'STUB'
#!/usr/bin/env bash
case "${1:-} ${2:-}" in
  "ci "*|"ci")
    echo "npm-ci pid=$$ t=$(date +%s)" >>"$CALL_LOG"
    sleep 2
    ;;
  "run build")
    # Produce what a real build would; without it the tree stays unbootstrapped
    # and the test measures its own stub rather than the lock.
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
    RALPH_KNOWLEDGE_BOOTSTRAP_WAIT_SEC=60 \
    bash "$root/scripts/launch-mcp.sh" >/dev/null 2>>"$root/concurrent.stderr" &
done
wait

ci_runs=$(grep -c '^npm-ci ' "$CC_LOG" 2>/dev/null) || true
ci_runs=${ci_runs:-0}
if [ "$ci_runs" -eq 1 ]; then
  pass "$WAITERS concurrent launchers produced exactly 1 npm ci"
else
  fail "$WAITERS concurrent launchers produced $ci_runs npm ci runs (want exactly 1)" \
    "$(sort "$CC_LOG")"
fi

if [ -f "$root/.bootstrap-complete" ]; then
  pass "the single winner completed the bootstrap"
else
  fail "no winner completed the bootstrap" "$(tail -5 "$root/concurrent.stderr" 2>/dev/null)"
fi

# The lock must be gone afterwards, or the next cold start wedges for nothing.
if [ ! -d "$root/.bootstrap.lock" ]; then
  pass "the lock is released after a successful bootstrap"
else
  fail "the lock survived a clean run — every later launch would time out"
fi

# Everyone else must have gone on to serve, not failed.
served=$(grep -c 'node dist/index.js' "$CC_LOG" 2>/dev/null) || true
if [ "${served:-0}" -ge $((WAITERS - 1)) ]; then
  pass "the other $((WAITERS - 1)) launchers went on to exec the server"
else
  fail "only ${served:-0} of $WAITERS launchers reached the server" \
    "$(sort "$root/concurrent.stderr" | uniq -c | head -5)"
fi

echo
echo "launch-mcp.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
