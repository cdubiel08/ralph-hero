#!/usr/bin/env bash
# scripts/__tests__/launch-mcp.test.sh
# Regression suite for the npx-cache-bloat fix (GH-1756, PR #1755), carried
# forward onto the Node launcher (GH-1851).
#
# The defect: .mcp.json launched the knowledge server as
# `npx -y ralph-hero-knowledge-index@<pinned version>`. npx materializes a
# fresh ~500MB-1GB cache tree under ~/.npm/_npx for EVERY distinct version
# pin, and never evicts one — 33 releases put 20GB on a single machine. The
# fix launches the vendored copy through scripts/launch-mcp.mjs instead.
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
# WHAT THE NODE PORT CHANGED IN THIS SUITE (GH-1851). The bash launcher shelled
# out to `node -p` for its identity, so the suite drove identity by stubbing
# `node` on PATH. A Node launcher reads process.platform/arch/versions.modules
# directly and cannot be stubbed that way, so identity is driven by the
# launcher's two documented override vars instead. Two sections are gone rather
# than ported: the no-hasher and cksum-only fallbacks existed because a host may
# lack every shell hasher, and node ships crypto — the ladder they tested no
# longer exists. Every other case is the same assertion against the same
# behaviour.
#
# Every case runs the real script against a fake plugin root with `npm` and
# `npx` stubbed on PATH, so nothing here installs, builds, or hits a registry.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$REPO_ROOT/plugin/ralph-knowledge/scripts/launch-mcp.mjs"
MCP_JSON="$REPO_ROOT/plugin/ralph-knowledge/.mcp.json"
RELEASE_WF="$REPO_ROOT/.github/workflows/release-knowledge.yml"

TMP_ROOT=$(mktemp -d)
trap 'rm -rf "$TMP_ROOT"' EXIT

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); [ -n "${2:-}" ] && echo "$2" | sed 's/^/        /'; return 0; }

[ -f "$SRC" ] || { echo "FATAL: launcher not found at $SRC"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "FATAL: no node on PATH — the launcher IS a node program"; exit 1; }

# --- stubs -------------------------------------------------------------------
# `node` is NOT stubbed: the launcher is a node program, and the server it
# starts runs under process.execPath, which no PATH entry can intercept. The
# served entry point records its own invocation instead — see SERVER_FILE — which
# is a truer signal anyway: it fires only if the launcher really reached the
# built artifact.
BIN="$TMP_ROOT/bin"
mkdir -p "$BIN"
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
chmod +x "$BIN/npm" "$BIN/npx"

# The stand-in for the built server. It appends the line the old `node` stub
# used to append, so every "did it reach dist/index.js" assertion is unchanged.
SERVER_FILE="$TMP_ROOT/server.js"
cat >"$SERVER_FILE" <<'SRV'
require('fs').appendFileSync(process.env.CALL_LOG, 'node ' + __filename + '\n');
SRV
export SERVER_FILE

# The launcher's identity overrides. Left unexported they leaked from one
# section into the fixtures of the next while direct invocations kept the
# default, so a fixture and the launcher under test built in two different
# runtime trees (GH-1844). Sections that vary them reset them when they are done.
export RALPH_KNOWLEDGE_NODE_ID="${RALPH_KNOWLEDGE_NODE_ID:-}"
export RALPH_KNOWLEDGE_MACHINE_ID="${RALPH_KNOWLEDGE_MACHINE_ID:-}"

# sanitized_bin <dir> [tool...] — a self-contained PATH holding the npm/npx
# stubs plus the ordinary utilities the launcher and the stubs shell out to, and
# NOTHING else. Without them a run would die at 127 and every assertion would
# pass or fail for the wrong reason, so each required tool is resolved
# explicitly and a missing one is a hard error rather than a silent hole.
# `bash`, `env` and `sh` are load-bearing: the stubs' `#!/usr/bin/env bash`
# shebang resolves through this PATH, and the launcher's probe-availability
# check runs `sh -c 'command -v ps'`.
BASE_UTILS="bash sh env node ps cp ln tr rm mv cat find mkdir sleep date uname cut kill sed grep ls dirname basename pwd stat touch"
sanitized_bin() {
  local dir="$1"; shift
  mkdir -p "$dir"
  local t src
  for t in $BASE_UTILS "$@"; do
    src=$(command -v "$t" 2>/dev/null) || {
      echo "FATAL: sanitized_bin cannot resolve '$t'" >&2; exit 1; }
    ln -sf "$src" "$dir/$t"
  done
  for t in npm npx; do cp "$BIN/$t" "$dir/$t"; done
  return 0
}

# rt <root> [match] — the runtime tree the launcher chose under <root>.
#
# READ BACK from disk, never recomputed here (GH-1844). The key is
# platform-arch-abi plus a machine id, and a second copy of that rule in the
# test is exactly the thing that drifts away from the launcher it is meant to
# be checking. With [match] the tree whose key contains that substring is
# selected, which is how the arch-swap cases name one of two trees.
rt() {
  local root="$1" match="${2:-}" d
  for d in "$root"/.runtimes/*/; do
    [ -d "$d" ] || continue
    if [ -n "$match" ]; then
      case "${d%/}" in *"$match"*) ;; *) continue ;; esac
    fi
    printf '%s' "${d%/}"
    return 0
  done
  return 1
}

# populate_runtime <root> — make the runtime tree look like a finished install.
#
# npm is stubbed everywhere in this suite, so a bootstrap creates the tree but
# never fills it. One real launcher run materializes the directory (and so
# fixes its key without this file having to know it), and this fills in what
# npm would have.
populate_runtime() {
  local root="$1" rtdir d
  run_launcher "$root" >/dev/null
  rtdir=$(rt "$root") || { echo "FATAL: launcher created no runtime tree in $root" >&2; exit 1; }
  mkdir -p "$rtdir/dist"
  cp "$SERVER_FILE" "$rtdir/dist/index.js"
  # Real installations, not bare directories. Empty dirs were the defect the
  # entry-point check exists to catch, so a fixture made of them would let a
  # name-only check pass and prove nothing (codex P2, PR #1755).
  for d in "@huggingface/transformers" "@modelcontextprotocol/sdk" \
    "better-sqlite3" "zod" "typescript"; do
    mkdir -p "$rtdir/node_modules/$d"
    printf '{"name":"%s","main":"index.js"}\n' "$d" >"$rtdir/node_modules/$d/package.json"
    echo 'module.exports = {}' >"$rtdir/node_modules/$d/index.js"
  done
  # The run above wrote a marker. Remove it: a fixture must not decide whether
  # the tree reads as complete — each case does, and several depend on there
  # being no marker until they make one.
  rm -f "$rtdir/.bootstrap-complete" "$rtdir/.bootstrap-identity"
}

# fake_root <name> — a plugin root plus a runtime tree that looks fully
# bootstrapped: built output and every dependency bootstrap_needed() checks.
fake_root() {
  local root="$TMP_ROOT/$1"
  mkdir -p "$root/scripts" "$root/src"
  cp "$SRC" "$root/scripts/launch-mcp.mjs"
  # The integrity check ships beside the launcher (GH-1846) and the launcher
  # resolves it from its own directory, so a fixture root without it is not the
  # thing being tested — every case would fail closed for the wrong reason.
  cp "$(dirname "$SRC")/deps-complete.cjs" "$root/scripts/deps-complete.cjs"
  echo 'export const x = 1;' >"$root/src/index.ts"
  # Copied into each runtime tree by the bootstrap, so it must be present.
  echo '{"compilerOptions":{"outDir":"dist","rootDir":"src"}}' >"$root/tsconfig.json"
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
  populate_runtime "$root"
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
    node "$root/scripts/launch-mcp.mjs" >/dev/null 2>"$root/stderr.log" || RC=$?
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

if grep -q 'launch-mcp.mjs' "$MCP_JSON"; then
  pass ".mcp.json launches the vendored launcher"
else
  fail ".mcp.json does not reference scripts/launch-mcp.mjs" "$(cat "$MCP_JSON")"
fi

# The command must be `node` (GH-1851). Windows launches an MCP `command` as an
# executable: it can neither run a `.sh` nor honour its shebang, which is why
# the first fix invoked the script through `bash`. That still required bash on
# PATH — conventional on Windows, not guaranteed. `node` is guaranteed by
# construction here, because the thing being launched is a Node MCP server.
if python3 -c "
import json, sys
d = json.load(open('$MCP_JSON'))
s = d['mcpServers']['ralph-knowledge']
sys.exit(0 if s['command'] == 'node'
         and any('launch-mcp.mjs' in a for a in s.get('args', [])) else 1)
" 2>/dev/null; then
  pass ".mcp.json invokes the launcher through node (no bash dependency on Windows)"
else
  fail ".mcp.json does not launch through node — Windows may have no bash on PATH" \
    "$(cat "$MCP_JSON")"
fi

# No shell launcher may come back: it is the dependency this issue removed.
if [ -e "$REPO_ROOT/plugin/ralph-knowledge/scripts/launch-mcp.sh" ]; then
  fail "the bash launcher is back beside the node one — two launchers will drift"
else
  pass "there is exactly one launcher"
fi

# The release workflow used to rewrite the pin. It must no longer do so, or
# the next release would reintroduce exactly the spec asserted against above.
if grep -q 'ralph-hero-knowledge-index@\[0-9\]' "$RELEASE_WF"; then
  fail "release-knowledge.yml still rewrites a version pin into .mcp.json"
else
  pass "release workflow no longer pins a version into .mcp.json"
fi

echo "=== the Windows path, which no runner here exercises ==="

# GH-1851 exists to remove the launcher's dependence on a shell being present.
# Nothing in this repo runs on Windows, so the three places the port would still
# have died there are pinned structurally rather than behaviourally. Each was a
# real defect in the first draft of the port, not a hypothetical.

# 1. npm ships as `npm.cmd`, and since Node 20 spawn refuses to resolve a `.cmd`
#    without a shell. Without this the very first bootstrap fails at ENOENT.
if grep -q 'shell: IS_WINDOWS' "$SRC"; then
  pass "npm is spawned through a shell on Windows (npm.cmd resolves)"
else
  fail "npm is spawned without a shell — `npm.cmd` would not resolve on Windows" \
    "$(grep -n "spawn('npm'\|spawn(cmd" "$SRC")"
fi

# 2. A directory symlink on Windows needs elevation or developer mode; a
#    junction is the same indirection with none. The bootstrap links src/.
if grep -q "'junction'" "$SRC"; then
  pass "the src link is a junction on Windows (no elevation required)"
else
  fail "symlinkSync is called without the junction type — EPERM on an unelevated Windows" \
    "$(grep -n 'symlinkSync' "$SRC")"
fi

# 3. Windows has neither /proc nor `ps`, so the in-use probe would report
#    "cannot be probed" and REFUSE every rebuild of an existing tree — a
#    permanent wedge on the one platform this port is for.
if grep -q 'Win32_Process' "$SRC"; then
  pass "the in-use probe has a Windows listing (rebuilds are not wedged there)"
else
  fail "no Windows process listing — every rebuild of an existing tree would be refused" \
    "$(grep -n 'probeAvailable' "$SRC")"
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

if grep -qE "node .*/dist/index\\.js" "$log"; then
  pass "warm launch ran the vendored dist/index.js"
else
  fail "warm launch never ran dist/index.js" "$(cat "$log")"
fi

echo "=== the launcher serves under its OWN node, not a PATH lookup ==="

# process.execPath, not `node` from PATH: this process is the runtime the tree
# was keyed to, and serving through a different one could load arch-bound
# binaries under the wrong ABI. A PATH `node` that fails loudly proves the
# launcher never consults one.
root=$(fake_root execpath)
log=$(run_launcher "$root")
EP_BIN="$TMP_ROOT/execpath-bin"
sanitized_bin "$EP_BIN"
rm -f "$EP_BIN/node"
cat >"$EP_BIN/node" <<'STUB'
#!/usr/bin/env bash
echo "FATAL: launcher resolved node from PATH" >&2
exit 91
STUB
chmod +x "$EP_BIN/node"
RC=0
log="$root/calls.log"; : >"$log"
CALL_LOG="$log" CLAUDE_PLUGIN_ROOT="$root" PATH="$EP_BIN" \
  "$(command -v node)" "$root/scripts/launch-mcp.mjs" >/dev/null 2>"$root/stderr.log" || RC=$?
if [ "$RC" -eq 0 ] && grep -qE "node .*/dist/index\\.js" "$log"; then
  pass "the server starts under process.execPath even when PATH node is hostile"
else
  fail "the launcher went through PATH to find node (rc=$RC)" "$(cat "$root/stderr.log")"
fi

echo "=== Node fingerprint tracks the ABI boundary, not the version string ==="

# A patch bump shares the ABI, so the compiled deps still load. Re-installing
# here buys nothing and can strand an offline machine. The launcher hashes the
# platform-arch-abi identity and never the version string, so a patch bump is
# not merely tolerated — it is invisible to the fingerprint by construction.
root=$(fake_root patchbump)
log=$(run_launcher "$root")
marker_before=$(cat "$(rt "$root")/.bootstrap-complete")
log=$(run_launcher "$root")
marker_after=$(cat "$(rt "$root")/.bootstrap-complete")
if grep -q '^npm ' "$log"; then
  fail "a relaunch at the same ABI forced a reinstall" "$(cat "$log")"
else
  pass "an unchanged ABI identity does not invalidate the marker"
fi
if [ "$marker_before" = "$marker_after" ]; then
  pass "the fingerprint is stable across relaunches"
else
  fail "the fingerprint changed with nothing else changing ($marker_before -> $marker_after)"
fi

if grep -v '^[[:space:]]*//' "$SRC" | grep -qE 'process\.version[^s]|node --version'; then
  fail "the launcher reads the full Node version — a patch bump would reinstall" \
    "$(grep -nE 'process\.version[^s]|node --version' "$SRC")"
else
  pass "the launcher never reads the full Node version string"
fi

# A major bump moves the ABI, and better-sqlite3's compiled binary genuinely
# stops loading. That IS a rebuild.
# The fixture itself must be built under identity A. Left to the ambient
# identity it is built under whatever this runner really is, and the cases
# below then count one tree too many — or pass vacuously, on a runner whose
# real identity differs from both overrides. macOS hid this; Linux did not.
export RALPH_KNOWLEDGE_NODE_ID="darwin-arm64-abi127"
root=$(fake_root majorbump)
log=$(run_launcher "$root")
export RALPH_KNOWLEDGE_NODE_ID="darwin-arm64-abi137"
log=$(run_launcher "$root")
if grep -q 'npm ci' "$log"; then
  pass "Node ABI change (127 -> 137) does re-bootstrap"
else
  fail "Node ABI change did not re-bootstrap — compiled deps would fail to load" "$(cat "$log")"
fi
export RALPH_KNOWLEDGE_NODE_ID=""

echo "=== incomplete tree still re-bootstraps ==="

root=$(fake_root incomplete)
log=$(run_launcher "$root")                       # warm it
rm -rf "$(rt "$root")/node_modules/better-sqlite3"
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
rm -rf "$(rt "$root")/node_modules/zod"
log=$(run_launcher "$root")
if grep -q 'npm ci' "$log"; then
  pass "a dependency outside any hand-written list still re-bootstraps (zod)"
else
  fail "missing zod passed as a complete tree — the server would fail instead of repairing" \
    "$(cat "$log")"
fi

# The sharper half of the finding: a directory of the right NAME is not proof
# of a usable installation. Partial cleanup leaves the directory and removes
# its contents, and a name-only check calls that complete — so the marker is
# trusted and the server dies on its static import.
root=$(fake_root emptydep)
log=$(run_launcher "$root")                       # warm it
rm -rf "$(rt "$root")/node_modules/zod"
mkdir -p "$(rt "$root")/node_modules/zod"                 # present, but empty
log=$(run_launcher "$root")
if grep -q 'npm ci' "$log"; then
  pass "an empty dependency directory re-bootstraps (name alone is not enough)"
else
  fail "an EMPTY node_modules/zod passed as installed — the server would fail on its static import" \
    "$(cat "$log")"
fi

# ...and a manifest whose entry point is gone is equally unusable.
root=$(fake_root gonEntry)
log=$(run_launcher "$root")                       # warm it
rm -f "$(rt "$root")/node_modules/zod/index.js"           # manifest stays, entry gone
log=$(run_launcher "$root")
if grep -q 'npm ci' "$log"; then
  pass "a dependency whose entry point is missing re-bootstraps"
else
  fail "a package with no entry file passed as installed" "$(cat "$log")"
fi

# devDependencies are pruned by design; demanding them would rebuild forever.
root=$(fake_root prunedev)
log=$(run_launcher "$root")                       # warm it
rm -rf "$(rt "$root")/node_modules/typescript"
log=$(run_launcher "$root")
if grep -q 'npm ci' "$log"; then
  fail "an absent devDependency forced a rebuild — the prune step guarantees it is absent" \
    "$(cat "$log")"
else
  pass "a pruned devDependency does not trigger a rebuild"
fi

root=$(fake_root nodist)
log=$(run_launcher "$root")
rm -f "$(rt "$root")/dist/index.js"
log=$(run_launcher "$root")
if grep -q 'npm run build' "$log"; then
  pass "missing dist/index.js re-bootstraps"
else
  fail "missing dist/index.js did not rebuild" "$(cat "$log")"
fi

# An interrupted bootstrap must not leave a marker claiming success.
root=$(fake_root nomarker)
log=$(run_launcher "$root")
rm -f "$(rt "$root")/.bootstrap-complete"
log=$(run_launcher "$root")
if grep -q 'npm ci' "$log"; then
  pass "absent marker re-bootstraps"
else
  fail "absent marker did not re-bootstrap" "$(cat "$log")"
fi

# The fingerprint must still track the manifests, or it is a constant by
# another name. (This is what the shasum/cksum fallback cases used to prove;
# node's crypto removes the ladder, not the requirement.)
root=$(fake_root lockchange)
log=$(run_launcher "$root")
echo '{"lockfileVersion":3,"changed":true}' >"$root/package-lock.json"
log=$(run_launcher "$root")
if grep -q 'npm ci' "$log"; then
  pass "a lockfile change invalidates the marker"
else
  fail "the fingerprint ignored a lockfile change" "$(cat "$log")"
fi

echo "=== fingerprint identity is platform + arch + ABI, not ABI alone ==="

# arm64 and x64 Node of the same major share NODE_MODULE_VERSION, but
# better-sqlite3 / onnxruntime-node / sqlite-vec binaries are arch-bound. A
# shared plugin cache reached from both must NOT match the marker.
# The fixture itself must be built under identity A. Left to the ambient
# identity it is built under whatever this runner really is, and the cases
# below then count one tree too many — or pass vacuously, on a runner whose
# real identity differs from both overrides. macOS hid this; Linux did not.
export RALPH_KNOWLEDGE_NODE_ID="darwin-arm64-abi127"
root=$(fake_root archswap)
log=$(run_launcher "$root")
export RALPH_KNOWLEDGE_NODE_ID="darwin-x64-abi127"
log=$(run_launcher "$root")
if grep -q 'npm ci' "$log"; then
  pass "architecture change at a constant ABI re-bootstraps"
else
  fail "arm64 -> x64 at ABI 127 reused the marker — arch-bound binaries would misload" \
    "$(cat "$log")"
fi

# The fixture itself must be built under identity A. Left to the ambient
# identity it is built under whatever this runner really is, and the cases
# below then count one tree too many — or pass vacuously, on a runner whose
# real identity differs from both overrides. macOS hid this; Linux did not.
export RALPH_KNOWLEDGE_NODE_ID="darwin-arm64-abi127"
root=$(fake_root platformswap)
log=$(run_launcher "$root")
export RALPH_KNOWLEDGE_NODE_ID="linux-arm64-abi127"
log=$(run_launcher "$root")
if grep -q 'npm ci' "$log"; then
  pass "platform change at a constant ABI re-bootstraps"
else
  fail "darwin -> linux at ABI 127 reused the marker" "$(cat "$log")"
fi

# The identity the launcher uses when nothing overrides it must carry all three
# facts, or the two cases above are testing the override and nothing else.
if node -e "
const s = require('fs').readFileSync('$SRC','utf8');
const m = /return \\\`\\\$\{process\.platform\}-\\\$\{process\.arch\}-abi\\\$\{process\.versions\.modules\}\\\`/.test(s);
process.exit(m ? 0 : 1);
"; then
  pass "the default identity is platform + arch + ABI"
else
  fail "the default identity is not platform+arch+abi — the override cases prove nothing" \
    "$(grep -n 'process.platform' "$SRC")"
fi

export RALPH_KNOWLEDGE_NODE_ID=""   # restore the defaults for the fixtures below

echo "=== signal handlers release the lock AND stop ==="

# Behavioral: TERM during `npm ci` must leave no lock, no marker, and a
# non-zero rc — not a script that ran on to completion.
#
# The hazard the bash launcher documented — a trap that cleans up and then
# RESUMES into the rest of the bootstrap — has a Node twin: a handler cannot run
# at all while the thread is inside a synchronous spawnSync, so a synchronous
# bootstrap would defer it past the build, the prune and the completion marker.
# That is why the bootstrap awaits its children, and why this case is
# behavioural rather than a grep for a trap shape.
root=$(fake_root signal)
SIG_BIN="$TMP_ROOT/sig-bin"
sanitized_bin "$SIG_BIN"
# npm ci kills the launcher mid-install, standing in for Claude Code killing a
# slow first run. Overwrites the stub sanitized_bin just installed.
rm -f "$SIG_BIN/npm"
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

rm -f "$(rt "$root")/dist/index.js"
log="$root/calls.log"
: >"$log"
RC=0
CALL_LOG="$log" CLAUDE_PLUGIN_ROOT="$root" PATH="$SIG_BIN" \
  bash -c 'LAUNCHER_PID=$$; export LAUNCHER_PID; exec node "$1"' _ \
  "$root/scripts/launch-mcp.mjs" >/dev/null 2>"$root/stderr.log" || RC=$?

if [ "$RC" -ne 0 ]; then
  pass "TERM during npm ci exits non-zero (rc=$RC)"
else
  fail "TERM during npm ci still exited 0 — the launcher resumed past the signal"
fi

if [ ! -d "$(rt "$root")/.bootstrap.lock" ]; then
  pass "TERM during npm ci leaves no lock behind"
else
  fail "lock survived a TERM — later launchers would wait out the stale window"
fi

if [ ! -f "$(rt "$root")/.bootstrap-complete" ]; then
  pass "TERM during npm ci writes no completion marker"
else
  fail "an interrupted bootstrap claimed completion"
fi

if ! grep -q 'npm run build' "$log"; then
  pass "TERM during npm ci stops before the build (no resumed bootstrap)"
else
  fail "the launcher resumed past the signal and kept bootstrapping" "$(cat "$log")"
fi

# The structural half: the bootstrap must not block the thread, or no handler
# can fire until it is over. spawnSync anywhere inside the bootstrap path is the
# regression. (spawnSync is fine for the read-only probes, which are not
# interruptible work and hold no lock.)
if node -e "
const s = require('fs').readFileSync('$SRC','utf8');
const body = s.slice(s.indexOf('async function runBootstrap'));
process.exit(/spawnSync/.test(body.slice(0, body.indexOf('\n}'))) ? 1 : 0);
"; then
  pass "the bootstrap awaits its children instead of blocking the event loop"
else
  fail "the bootstrap uses spawnSync — signal handlers could not fire until it finished" \
    "$(grep -n 'spawnSync' "$SRC")"
fi

echo "=== the launcher never deletes a lock it does not own ==="

# The terminal property, and the reason ~160 lines of reclamation machinery are
# gone (codex P2 x6). Every scheme for detecting and deleting an abandoned lock
# is check-then-delete on a shared pathname, and each serialization layer needed
# its own reclamation in turn. Directory creation is atomic but can never safely
# destroy someone else's directory, so the launcher does not try.
#
# Consequence under test: a pre-existing lock is NEVER removed by a waiter,
# whatever it looks like — live owner, dead owner, ancient, ownerless.

# A PID that cannot be running: claim one, then walk until it is genuinely free.
DEAD_PID=$( (bash -c 'echo $$') )
while kill -0 "$DEAD_PID" 2>/dev/null; do DEAD_PID=$((DEAD_PID + 1)); done

for scenario in liveowner deadowner ancient ownerless; do
  root=$(fake_root "noreclaim-$scenario")
  rm -f "$(rt "$root")/dist/index.js"
  mkdir -p "$(rt "$root")/.bootstrap.lock"
  case "$scenario" in
    liveowner) printf '%s %s %s\n' "$$" "$(hostname)" "$(date +%s)" >"$(rt "$root")/.bootstrap.lock/owner" ;;
    deadowner) printf '%s %s %s\n' "$DEAD_PID" "$(hostname)" "$(date +%s)" >"$(rt "$root")/.bootstrap.lock/owner" ;;
    ancient)
      printf '%s %s 0\n' "$DEAD_PID" "$(hostname)" >"$(rt "$root")/.bootstrap.lock/owner"
      touch -t 200001010000 "$(rt "$root")/.bootstrap.lock" 2>/dev/null || true ;;
    ownerless)
      touch -t 200001010000 "$(rt "$root")/.bootstrap.lock" 2>/dev/null || true ;;
  esac

  log="$root/calls.log"; : >"$log"
  RC=0
  CALL_LOG="$log" CLAUDE_PLUGIN_ROOT="$root" PATH="$BIN:$PATH" \
    RALPH_KNOWLEDGE_BOOTSTRAP_WAIT_SEC=4 \
    node "$root/scripts/launch-mcp.mjs" >/dev/null 2>"$root/stderr.log" || RC=$?

  if [ -d "$(rt "$root")/.bootstrap.lock" ] && ! grep -q 'npm ci' "$log"; then
    pass "pre-existing lock ($scenario) is neither deleted nor bypassed"
  else
    fail "a waiter destroyed or bypassed a lock it did not own ($scenario)" \
      "lock_present=$([ -d "$(rt "$root")/.bootstrap.lock" ] && echo yes || echo NO); $(cat "$log")"
  fi
done

# Failing closed is only honest if the operator can act on it: the timeout must
# name the holder and the exact directory to remove.
root=$(fake_root timeoutmsg)
rm -f "$(rt "$root")/dist/index.js"
mkdir -p "$(rt "$root")/.bootstrap.lock"
printf '%s %s %s\n' "$DEAD_PID" "some-other-host" "0" >"$(rt "$root")/.bootstrap.lock/owner"
RC=0
CALL_LOG="$root/calls.log" CLAUDE_PLUGIN_ROOT="$root" PATH="$BIN:$PATH" \
  RALPH_KNOWLEDGE_BOOTSTRAP_WAIT_SEC=4 \
  node "$root/scripts/launch-mcp.mjs" >/dev/null 2>"$root/stderr.log" || RC=$?

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
if grep -qE 'reapAbandonedLock|lockReclaimable|dirReclaimable|LOCK_STALE_MIN' "$SRC"; then
  fail "reclamation logic is back — every version of it raced" \
    "$(grep -nE 'reapAbandonedLock|lockReclaimable|dirReclaimable|LOCK_STALE_MIN' "$SRC")"
else
  pass "no lock-reclamation machinery remains"
fi
# The lock is never moved out of its path to be inspected. That absence window
# is what CI's 2-core runner exploited into 3 concurrent installs.
if grep -qE 'renameSync\([^)]*LOCK|bootstrap\.reap|reaping' "$SRC"; then
  fail "a lock-stealing primitive is back" "$(grep -nE 'renameSync|reaping|bootstrap.reap' "$SRC")"
else
  pass "the lock is never moved out of its path (no absence window)"
fi
# Nothing may inspect the lock's age: an age test is the reclamation decision
# every failed design was built on.
if grep -qE 'statSync\([^)]*LOCK|mtime' "$SRC"; then
  fail "a lock-age probe is present" "$(grep -nE 'statSync|mtime' "$SRC")"
else
  pass "the lock's age is never consulted"
fi

# A signal must not release the lock while the bootstrap child is still alive
# (codex P2, PR #2036). Killing is asynchronous, so releasing immediately hands
# the lock to a relaunch while `npm ci` — or a grandchild such as `tsc`, never
# signalled directly — is still mutating the same tree. The handler awaits the
# child's exit first, and the children are spawned detached so the whole process
# group can be reached.
if node -e "
const s = require('fs').readFileSync('$SRC','utf8');
const h = s.slice(s.indexOf('function onFatalSignal'), s.indexOf('// --- bootstrap'));
process.exit(h.indexOf('await new Promise') < h.indexOf('releaseLock()') ? 0 : 1);
"; then
  pass "a signal awaits the bootstrap child before releasing the lock"
else
  fail "the lock is released before the killed child is gone — a relaunch could install concurrently" \
    "$(sed -n '/function onFatalSignal/,/^}/p' "$SRC")"
fi
if grep -q 'detached: !IS_WINDOWS' "$SRC"; then
  pass "bootstrap children are detached, so the grandchildren can be signalled"
else
  fail "bootstrap children share this process group — tsc would outlive the signal" \
    "$(grep -n 'spawn(cmd' "$SRC")"
fi

# The owner file must actually be written, or a timed-out waiter can name nobody.
if grep -q 'writeLockOwner' "$SRC"; then
  pass "the lock holder records an owner identity"
else
  fail "no owner file is written — a timeout could name no holder" "$(grep -n 'owner' "$SRC")"
fi

# Releasing must be idempotent, which is what makes the exit hook safe beside a
# signal handler that has already released. Without it the handler removes the
# lock and the exit path removes the pathname AGAIN, deleting whatever waiter
# acquired it in between — the bash launcher's "disarm EXIT first" requirement,
# reached structurally instead.
if grep -q 'if (!holdingLock) return;' "$SRC"; then
  pass "releasing the lock is idempotent (no double removal on the exit path)"
else
  fail "releaseLock is not guarded — the exit hook could remove a waiter's lock" \
    "$(grep -n 'releaseLock' "$SRC")"
fi

echo "=== bootstrap installs dev deps even when the env says to omit them ==="

# `tsc` is a devDependency and `npm run build` runs it immediately after the
# install. Claude Code inheriting NODE_ENV=production (or a user's npm config)
# makes plain `npm ci` skip it, so the build fails on every first launch and
# the completion marker is never written — the bootstrap can never finish.
root=$(fake_root devdeps)
rm -f "$(rt "$root")/dist/index.js"
log="$root/calls.log"; : >"$log"
RC=0
CALL_LOG="$log" CLAUDE_PLUGIN_ROOT="$root" PATH="$BIN:$PATH" NODE_ENV=production \
  node "$root/scripts/launch-mcp.mjs" >/dev/null 2>"$root/stderr.log" || RC=$?

if grep -qE '^npm ci .*--include=dev' "$log"; then
  pass "npm ci forces dev dependencies in (survives NODE_ENV=production)"
else
  fail "npm ci does not force dev deps — tsc would be missing and the build would fail" \
    "$(grep '^npm ' "$log")"
fi

# ...and they are still pruned afterwards, or the disk saving this work exists
# for would be given straight back.
if grep -qE '^npm prune .*--omit=dev' "$log"; then
  pass "dev dependencies are pruned again after the build"
else
  fail "dev deps are installed but never pruned — that is the disk cost back" \
    "$(grep '^npm ' "$log")"
fi

echo "=== the shipped integrity check, run for real ==="

# The launcher delegates completeness to scripts/deps-complete.cjs (GH-1846).
# Everything above turns on its verdict indirectly; this section runs the
# shipped program itself, against real fixtures, exactly as the launcher does —
# from inside the tree, with the tree's own manifests.
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
deps_complete() ( cd "$1" && node "$(dirname "$SRC")/deps-complete.cjs" >/dev/null 2>&1 )

root=$(dep_fixture real_ok)
if deps_complete "$root"; then
  pass "a real installation satisfies deps-complete"
else
  fail "a complete tree was reported incomplete — this would rebuild on every launch"
fi

# The exact case codex named: the directory survives, its contents do not.
root=$(dep_fixture real_empty)
rm -rf "$root/node_modules/zod"; mkdir -p "$root/node_modules/zod"
if deps_complete "$root"; then
  fail "an EMPTY node_modules/zod satisfied deps-complete — name-only check"
else
  pass "an empty dependency directory fails deps-complete"
fi

# Manifest present, entry point deleted.
root=$(dep_fixture real_noentry)
rm -f "$root/node_modules/zod/index.js"
if deps_complete "$root"; then
  fail "a package with no entry file satisfied deps-complete"
else
  pass "a missing entry point fails deps-complete"
fi

# A package absent altogether.
root=$(dep_fixture real_absent)
rm -rf "$root/node_modules/zod"
if deps_complete "$root"; then
  fail "an absent dependency satisfied deps-complete"
else
  pass "an absent dependency fails deps-complete"
fi

# `main` may be extensionless, or name a directory — node appends .js and
# falls back to <dir>/index.js. An exact existsSync reported three healthy
# packages in this repo's own tree as missing, and a false "missing" forces a
# destructive reinstall on EVERY launch.
root=$(dep_fixture real_extless)
printf '{"name":"zod","main":"./index"}\n' >"$root/node_modules/zod/package.json"
if deps_complete "$root"; then
  pass "an extensionless main resolves (no false rebuild)"
else
  fail "an extensionless main was reported missing — a healthy tree would reinstall forever"
fi

root=$(dep_fixture real_dirmain)
printf '{"name":"zod","main":"./lib"}\n' >"$root/node_modules/zod/package.json"
mkdir -p "$root/node_modules/zod/lib"
echo 'module.exports = {}' >"$root/node_modules/zod/lib/index.js"
if deps_complete "$root"; then
  pass "a main naming a directory resolves via index.js"
else
  fail "a directory main was reported missing"
fi

# A `binary` field is NOT proof of a native module: napi-build-utils ships
# one whose own note says it is not an N-API module.
root=$(dep_fixture real_binaryfield)
printf '{"name":"zod","main":"index.js","binary":{"note":"not an N-API module"}}\n' \
  >"$root/node_modules/zod/package.json"
if deps_complete "$root"; then
  pass "a 'binary' field alone does not demand a compiled addon"
else
  fail "a package was treated as native on its 'binary' field — reinstalls a healthy tree"
fi

# A native package needs its COMPILED ADDON, not just its JavaScript. This is
# the better-sqlite3 case: the JS entry survives a partial cleanup while
# build/Release/*.node does not, and startup then dies constructing the
# database instead of repairing the tree.
root=$(dep_fixture real_native)
mkdir -p "$root/node_modules/zod/build/Release"
echo '{}' >"$root/node_modules/zod/binding.gyp"
: >"$root/node_modules/zod/build/Release/zod.node"
if deps_complete "$root"; then
  pass "a native package with its addon present is complete"
else
  fail "a healthy native package was reported incomplete — this would reinstall every launch"
fi

rm -rf "$root/node_modules/zod/build"
if deps_complete "$root"; then
  fail "a native package with NO compiled addon passed — startup would die on the addon load"
else
  pass "a native package missing its compiled addon fails deps-complete"
fi

# A subpath-only exports map must NOT be enforced. Real packages ship these:
# @modelcontextprotocol/sdk declares "." -> ./dist/esm/index.js, does not
# ship that file, and imports fine via ./server/index.js. Enforcing it
# reported this very repo's tree as broken. GH-1846 narrowed the leniency: the
# rule is "at least one declared target resolves", because accepting an
# exports-only package unconditionally also accepted one whose dist/ had been
# deleted whole — the damage the check exists to find.
root=$(dep_fixture real_subpath)
cat >"$root/node_modules/zod/package.json" <<'PKG'
{ "name": "zod", "exports": { ".": { "import": "./dist/esm/index.js" }, "./sub": "./dist/sub.js" } }
PKG
rm -f "$root/node_modules/zod/index.js"
mkdir -p "$root/node_modules/zod/dist"
echo 'module.exports = {}' >"$root/node_modules/zod/dist/sub.js"
if deps_complete "$root"; then
  pass "an unshipped root export is not enforced when a subpath resolves"
else
  fail "an exports map with a live subpath was reported incomplete — a healthy tree would reinstall forever"
fi

root=$(dep_fixture real_subpath_gutted)
cat >"$root/node_modules/zod/package.json" <<'PKG'
{ "name": "zod", "exports": { ".": { "import": "./dist/esm/index.js" }, "./sub": "./dist/sub.js" } }
PKG
rm -f "$root/node_modules/zod/index.js"
if deps_complete "$root"; then
  fail "an exports-only package with NO surviving target passed — the static import would fail instead of repairing"
else
  pass "an exports-only package whose targets are all gone re-bootstraps"
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
if deps_complete "$root"; then
  pass "an undeterminable exports map is accepted rather than rebuilt forever"
else
  fail "a conditional-exports package forced a rebuild — every launch would reinstall"
fi

echo "=== two Node identities never share a bootstrap tree (GH-1844) ==="

# The hazard GH-1844 was filed for. One plugin cache reached by two Node
# identities — arm64 native beside x64 under Rosetta, or two machines on a
# shared home — used to mean ONE tree: the identity whose fingerprint matched
# skipped the lock and served, and the other then ran a destructive `npm ci`
# over the node_modules it was still lazily requiring from.
#
# The remedy is isolation rather than a guard. The two identities now build in
# separate trees, so B's install is not merely REFUSED while A is live — it is
# irrelevant to A, which is what lets a second architecture start at all.
# The fixture itself must be built under identity A. Left to the ambient
# identity it is built under whatever this runner really is, and the cases
# below then count one tree too many — or pass vacuously, on a runner whose
# real identity differs from both overrides. macOS hid this; Linux did not.
export RALPH_KNOWLEDGE_NODE_ID="darwin-arm64-abi127"
root=$(fake_root two_identities)
log=$(run_launcher "$root")
export RALPH_KNOWLEDGE_NODE_ID="darwin-x64-abi127"
log=$(run_launcher "$root")

count=$(find "$root/.runtimes" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')
if [ "$count" -eq 2 ]; then
  pass "two Node identities produced two runtime trees"
else
  fail "two identities produced $count runtime tree(s) — they are still sharing one" \
    "$(find "$root/.runtimes" -maxdepth 1 -mindepth 1 2>/dev/null)"
fi

# Not just separate: the FIRST tree must be intact. A rebuild that reached into
# it is the defect, whatever directory it was launched from.
a_dir=$(rt "$root" "arm64-abi127") || a_dir=""
if [ -n "$a_dir" ] && [ -f "$a_dir/.bootstrap-complete" ] && [ -d "$a_dir/node_modules/zod" ]; then
  pass "the first identity's tree survived the second identity's bootstrap"
else
  fail "the second identity damaged the first identity's tree" \
    "$(find "$root/.runtimes" -maxdepth 2 2>/dev/null | head -20)"
fi

# The tree key must be STABLE, or per-identity trees become one tree per
# launch — the npx-cache-bloat failure mode this launcher exists to end.
before=$(rt "$root" "arm64-abi127")
export RALPH_KNOWLEDGE_NODE_ID="darwin-arm64-abi127"
log=$(run_launcher "$root")
count_after=$(find "$root/.runtimes" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')
if [ "$count_after" -eq 2 ] && [ -d "$before" ]; then
  pass "relaunching an existing identity reuses its tree (no per-launch growth)"
else
  fail "a relaunch minted a new tree — $count_after trees after three launches"
fi

# And the served entry point must come from the tree, not from the plugin root.
if grep -qE "node .*/\.runtimes/.*/dist/index\.js" "$log"; then
  pass "the server runs out of its own runtime tree"
else
  fail "the server ran from somewhere other than its runtime tree" "$(cat "$log")"
fi

# The plugin root must not be installed into at all any more: a shared
# node_modules there is precisely what two identities could collide over.
if [ -d "$root/node_modules" ]; then
  fail "the bootstrap installed into the shared plugin root"
else
  pass "nothing is installed at the shared plugin root"
fi

echo "=== a live server of ANOTHER identity does not block a bootstrap ==="

# The other half of isolation, and the reason the interim remedy considered in
# GH-1844 (refuse whenever the recorded identity differs) was rejected: it would
# make a second architecture unable to start at all while the first is running.
if ! { [ -d /proc ] || command -v ps >/dev/null 2>&1; }; then
  echo "  SKIP: cannot probe for running servers on this host"
else
  export RALPH_KNOWLEDGE_NODE_ID="darwin-arm64-abi127"   # the fixture is identity A
  root=$(fake_root cross_identity_live)
  log=$(run_launcher "$root")
  rtdir=$(rt "$root" "arm64-abi127")
  ( exec /bin/sh -c "sleep 60; :" "node $rtdir/dist/index.js" ) &
  busy_pid=$!
  sleep 0.3

  RC=0
  log="$root/calls.log"; : >"$log"
  CALL_LOG="$log" CLAUDE_PLUGIN_ROOT="$root" PATH="$BIN:$PATH" \
    RALPH_KNOWLEDGE_NODE_ID="darwin-x64-abi127" \
    node "$root/scripts/launch-mcp.mjs" >/dev/null 2>"$root/stderr.log" || RC=$?
  kill "$busy_pid" 2>/dev/null || true

  # rc is not asserted: npm is stubbed here, so no dist is ever built and the
  # serve step cannot succeed. Whether the bootstrap was REFUSED is the question.
  if grep -q 'npm ci' "$log" && ! grep -q 'refusing to rebuild' "$root/stderr.log"; then
    pass "a second identity bootstraps while the first is serving"
  else
    fail "a second identity was blocked by an unrelated running server (rc=$RC)" \
      "$(cat "$root/stderr.log")"
  fi
  if [ -f "$rtdir/.bootstrap-complete" ] && [ -d "$rtdir/node_modules/zod" ]; then
    pass "the running server's tree was left untouched"
  else
    fail "the second identity's install reached into the live server's tree"
  fi
fi

export RALPH_KNOWLEDGE_NODE_ID=""   # restore the defaults for the fixtures below

echo "=== a live server blocks a rebuild of ITS OWN tree ==="

if ! { [ -d /proc ] || command -v ps >/dev/null 2>&1; }; then
  echo "  SKIP: cannot probe for running servers on this host"
else
  # Per-identity trees remove the cross-identity case, not this one. A damaged
  # marker, a changed lockfile or a missing entry point all reach `npm ci` at
  # the SAME identity, and that replaces node_modules underneath a server still
  # resolving lazy imports out of it (codex P2, PR #1755).
  root=$(fake_root sameid_live)
  rtdir=$(rt "$root")
  rm -f "$rtdir/.bootstrap-complete"             # force the rebuild path
  ( exec /bin/sh -c "sleep 60; :" "node $rtdir/dist/index.js" ) &
  live_pid=$!
  sleep 0.3
  RC=0
  log="$root/calls.log"; : >"$log"
  CALL_LOG="$log" CLAUDE_PLUGIN_ROOT="$root" PATH="$BIN:$PATH" \
    node "$root/scripts/launch-mcp.mjs" >/dev/null 2>"$root/stderr.log" || RC=$?
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
  if grep -q 'close every session using this runtime' "$root/stderr.log"; then
    pass "the refusal tells the operator to close sessions"
  else
    fail "the refusal gives no remedy" "$(cat "$root/stderr.log")"
  fi
  # Deleting the tree must never be offered as an ALTERNATIVE to closing
  # sessions — it destroys exactly what the guard just refused to disrupt.
  if grep -q 'once they are closed' "$root/stderr.log"; then
    pass "deletion is sequenced after closing sessions"
  else
    fail "the remedy never says when deletion becomes safe" "$(cat "$root/stderr.log")"
  fi
  if [ -d "$rtdir/node_modules/zod" ]; then
    pass "the refused rebuild left the existing tree untouched"
  else
    fail "the refused rebuild damaged the tree it declined to replace"
  fi

  # ...but a merely WAITING LAUNCHER must not block. It shares the plugin root
  # as its cwd with every server, which is why the probe reads argv instead:
  # a cwd test would turn two simultaneous cold starts into a hard failure.
  root=$(fake_root waiter_not_server)
  rtdir=$(rt "$root")
  rm -f "$rtdir/.bootstrap-complete"
  ( cd "$root" && exec /bin/sh -c 'sleep 60; :' "node scripts/launch-mcp.mjs" ) &
  waiter_pid=$!
  sleep 0.3
  RC=0
  log="$root/calls.log"; : >"$log"
  CALL_LOG="$log" CLAUDE_PLUGIN_ROOT="$root" PATH="$BIN:$PATH" \
    node "$root/scripts/launch-mcp.mjs" >/dev/null 2>"$root/stderr.log" || RC=$?
  kill "$waiter_pid" 2>/dev/null || true

  if grep -q 'npm ci' "$log"; then
    pass "another launcher waiting in the tree does not block the rebuild"
  else
    fail "a waiting launcher was mistaken for a live server — concurrent cold starts would deadlock" \
      "$(cat "$root/stderr.log")"
  fi
fi

echo "=== two machines on a shared home never share a tree ==="

# The second half of GH-1844. Two machines can share platform, arch and ABI, in
# which case the Node identity MATCHES while the local process table cannot see
# the remote server at all — so the machine is part of the tree key too, and
# there is nothing left to reason about across hosts.
root=$(fake_root two_hosts)
for h in machine-a machine-b; do
  CALL_LOG="$root/calls.log" CLAUDE_PLUGIN_ROOT="$root" PATH="$BIN:$PATH" \
    RALPH_KNOWLEDGE_MACHINE_ID="$h" \
    node "$root/scripts/launch-mcp.mjs" >/dev/null 2>>"$root/stderr.log" || true
done
if [ -d "$root/.runtimes" ] \
  && find "$root/.runtimes" -maxdepth 1 -mindepth 1 -type d -name '*machine-a*' 2>/dev/null | grep -q . \
  && find "$root/.runtimes" -maxdepth 1 -mindepth 1 -type d -name '*machine-b*' 2>/dev/null | grep -q .; then
  pass "two machines on one plugin cache built separate trees"
else
  fail "two machines shared a tree — a remote server is invisible to the local probe" \
    "$(find "$root/.runtimes" -maxdepth 1 -mindepth 1 2>/dev/null)"
fi

# A machine that cannot name itself must not collapse into a sentinel every
# other nameless machine also uses — that collision made two hosts compare
# EQUAL and pass the cross-host check as same-host (codex, PR #1755). Asserted
# structurally: the fallback ladder must end in a per-machine uuid, never a
# fixed string.
if grep -v '^[[:space:]]*//' "$SRC" | grep -qE "unknown-host|'unknown'"; then
  fail "a colliding host sentinel is back" "$(grep -nE 'unknown-host' "$SRC")"
elif grep -q 'randomUUID' "$SRC"; then
  pass "a nameless machine falls back to a uuid, not a shared sentinel"
else
  fail "the machine-id fallback ladder has no per-machine last resort" \
    "$(grep -n 'machineId' "$SRC")"
fi

echo "=== unprovable safety still fails closed ==="

# Per-identity trees narrow WHO can be affected; they do not make an unreadable
# process table safe. An existing tree that might still be served, on a host
# that cannot be probed at all, is refused rather than rebuilt.
root=$(fake_root unprobeable)
rtdir=$(rt "$root")
rm -f "$rtdir/.bootstrap-complete"
NOPS_BIN="$TMP_ROOT/nops-bin"
sanitized_bin "$NOPS_BIN"
rm -f "$NOPS_BIN/ps"                      # no `ps`, and this host has no /proc
if [ -d /proc ]; then
  echo "  SKIP: /proc exists on this host, so the unprobeable branch cannot be reached"
else
  RC=0
  log="$root/calls.log"; : >"$log"
  CALL_LOG="$log" CLAUDE_PLUGIN_ROOT="$root" PATH="$NOPS_BIN" \
    node "$root/scripts/launch-mcp.mjs" >/dev/null 2>"$root/stderr.log" || RC=$?
  if [ "$RC" -ne 0 ] && ! grep -q 'npm ci' "$log"; then
    pass "an existing tree is not rebuilt on a host that cannot be probed"
  else
    fail "rebuilt an existing tree without being able to rule out a live server (rc=$RC)" \
      "$(cat "$root/stderr.log")"
  fi
  if grep -q 'cannot be probed for running' "$root/stderr.log"; then
    pass "the refusal explains that the host cannot be probed"
  else
    fail "the refusal does not explain itself" "$(cat "$root/stderr.log")"
  fi
fi

# Residual assertion: the machine is part of the key, so a tree here was built
# here. If its record says otherwise the machine id is not as stable as it
# claims, and the local probe cannot speak for whoever did build it.
root=$(fake_root foreign_host_record)
rtdir=$(rt "$root")
printf '%s %s\n' "node-darwin-arm64-abi127" "some-other-host" >"$rtdir/.bootstrap-identity"
rm -f "$rtdir/.bootstrap-complete"
RC=0
log="$root/calls.log"; : >"$log"
CALL_LOG="$log" CLAUDE_PLUGIN_ROOT="$root" PATH="$BIN:$PATH" \
  node "$root/scripts/launch-mcp.mjs" >/dev/null 2>"$root/stderr.log" || RC=$?
if grep -q 'npm ci' "$log"; then
  fail "rebuilt a tree whose record names another machine" "$(cat "$log")"
else
  pass "a tree recording another machine is not rebuilt from here"
fi
if grep -q 'cannot say whether' "$root/stderr.log"; then
  pass "the refusal explains the cross-machine limitation"
else
  fail "the refusal does not explain itself" "$(cat "$root/stderr.log")"
fi

# A pre-GH-1844 install at the plugin root is large and now unused. It is NOT
# swept — a session started before the upgrade may still be serving from it —
# but it must be named, or it is silent dead weight forever.
root=$(fake_root legacy_root)
rtdir=$(rt "$root")
mkdir -p "$root/node_modules/zod"
rm -f "$rtdir/.bootstrap-complete"
CALL_LOG="$root/calls.log" CLAUDE_PLUGIN_ROOT="$root" PATH="$BIN:$PATH" \
  node "$root/scripts/launch-mcp.mjs" >/dev/null 2>"$root/stderr.log" || true
if grep -q 'pre-per-runtime install is still present' "$root/stderr.log"; then
  pass "a legacy plugin-root install is named to the operator"
else
  fail "a legacy install is left silently on disk" "$(cat "$root/stderr.log")"
fi
if [ -d "$root/node_modules/zod" ]; then
  pass "the legacy install is reported, never deleted"
else
  fail "the launcher deleted a tree a pre-upgrade session may still be serving from"
fi

# The identity must be published BEFORE the completion marker, or a tree can
# survive looking complete while carrying no provenance at all — which is the
# state the guard above has to treat as unknown.
# Match the WRITE, not the removal line — anchoring on the bare name matched
# `fs.rmSync(IDENTITY_FILE...)` instead, which made this assertion vacuous.
id_line=$(grep -n 'writeFileSync(IDENTITY_FILE' "$SRC" | head -1 | cut -d: -f1)
marker_line=$(grep -n 'writeFileSync(MARKER' "$SRC" | head -1 | cut -d: -f1)
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
rm -f "$(rt "$root")/dist/index.js"
FW_BIN="$TMP_ROOT/fastwait-bin"
sanitized_bin "$FW_BIN"
rm -f "$FW_BIN/npm"
cat >"$FW_BIN/npm" <<'STUB'
#!/usr/bin/env bash
case "${1:-} ${2:-}" in
  "ci "*|"ci") sleep 1 ;;
  "run build") cp "$SERVER_FILE" dist/index.js ;;
esac
exit 0
STUB
chmod +x "$FW_BIN/npm"

fw_start=$(date +%s)
for _ in $(seq 1 15); do
  CALL_LOG="$root/fw.log" CLAUDE_PLUGIN_ROOT="$root" PATH="$FW_BIN" \
    RALPH_KNOWLEDGE_BOOTSTRAP_WAIT_SEC=120 \
    node "$root/scripts/launch-mcp.mjs" >/dev/null 2>>"$root/fw.stderr" &
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

# The probe must CAPTURE its process listing before matching it. Piping `ps`
# (or `lsof`, which this probe used before GH-1844) straight into `grep -q`/
# `awk` is the obvious spelling in a shell and is wrong under `pipefail`: the
# matcher exits on the first hit, the producer takes SIGPIPE, and the pipeline
# reports failure — so a positive detection is discarded, in the direction that
# calls an in-use tree safe to rebuild.
#
# The Node port makes this structural: spawnSync captures. Pinned anyway, so a
# future edit cannot reintroduce it by shelling the probe back out to a pipe.
src_code=$(grep -v '^[[:space:]]*//' "$SRC")
if grep -qE '(lsof|ps -eo|ps)[^|]*\|[[:space:]]*(grep|awk)' <<<"$src_code"; then
  fail "the process listing is piped straight into a matcher — a SIGPIPE under pipefail discards the match" \
    "$(grep -nE '(lsof|ps)[^|]*\|' "$SRC")"
else
  pass "the process listing is captured before matching (no pipefail/SIGPIPE hazard)"
fi

# A listing that could not be taken must be UNKNOWN, never "nobody is there"
# (codex P2, PR #2036). Splitting "can this host be probed" from "what is
# running" is how that hole appears: a probe-availability check that only proves
# the lister STARTS passes while the listing itself returns nothing, and the
# rebuild then proceeds under a live server. One read answers both.
if grep -q 'return null' "$SRC" && ! grep -q 'function probeAvailable' "$SRC"; then
  pass "a failed process listing is unknown, not an empty process table"
else
  fail "the probe can report an unreadable listing as an idle tree" \
    "$(grep -n 'probeAvailable\|readProcessList' "$SRC")"
fi

echo "=== concurrent launchers on a cold tree: exactly one bootstrap ==="

# The property that actually matters, resting on atomic directory creation
# alone. Several Claude Code sessions starting at once must produce ONE
# destructive install, not one-per-session. Counting total `npm ci` runs (not
# "a winner emerged") is deliberate: sequential duplicates are a failure too.
root=$(fake_root concurrent)
rm -f "$(rt "$root")/dist/index.js"

CC_BIN="$TMP_ROOT/concurrent-bin"
sanitized_bin "$CC_BIN"
rm -f "$CC_BIN/npm"
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
    cp "$SERVER_FILE" dist/index.js
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
    node "$root/scripts/launch-mcp.mjs" >/dev/null 2>>"$root/concurrent.stderr" &
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

if [ -f "$(rt "$root")/.bootstrap-complete" ]; then
  pass "the single winner completed the bootstrap"
else
  fail "no winner completed the bootstrap" "$(tail -5 "$root/concurrent.stderr" 2>/dev/null)"
fi

# The lock must be gone afterwards, or the next cold start wedges for nothing.
if [ ! -d "$(rt "$root")/.bootstrap.lock" ]; then
  pass "the lock is released after a successful bootstrap"
else
  fail "the lock survived a clean run — every later launch would time out"
fi

# Everyone else must have gone on to serve, not failed.
served=$(grep -cE "node .*/dist/index\\.js" "$CC_LOG" 2>/dev/null) || true
if [ "${served:-0}" -ge $((WAITERS - 1)) ]; then
  pass "the other $((WAITERS - 1)) launchers went on to run the server"
else
  fail "only ${served:-0} of $WAITERS launchers reached the server" \
    "$(sort "$root/concurrent.stderr" | uniq -c | head -5)"
fi

echo
echo "launch-mcp.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
