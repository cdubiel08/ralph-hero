#!/usr/bin/env bash
# MCP launcher for ralph-knowledge.
#
# Runs the vendored copy inside the plugin directory instead of
# `npx -y ralph-hero-knowledge-index@<version>`. The npx form created a fresh
# ~500MB-1GB cache dir under ~/.npm/_npx for every released version pin, and
# npx never evicts — one machine accumulated 20GB across 33 releases.
#
# First run bootstraps: npm ci, build, then prune dev deps and the
# onnxruntime-web wasm binaries (lazy-loaded, unused under Node). All
# bootstrap output goes to stderr — stdout is the MCP stdio channel.
#
# The bootstrap does NOT happen at the plugin root. It happens in a tree keyed
# by the RUNTIME IDENTITY that will serve from it (GH-1844) — see runtime_key()
# below. One plugin cache can be reached by two Node identities (arm64 native
# beside x64 under Rosetta) or by two machines on a shared network home, and a
# single shared tree meant one of them could run a destructive `npm ci` over
# node_modules another was still serving from. Per-identity trees remove the
# sharing rather than guarding it: nothing is shared, so nothing has to be
# reasoned about across identities or hosts.
#
# Bootstrap is guarded two ways, because several Claude Code sessions can
# launch this script at the same instant:
#   * a completion MARKER holding a fingerprint of package.json +
#     package-lock.json + the Node major version. It is deleted before the
#     install and written only after every step succeeds, so an interrupted
#     or half-updated tree re-bootstraps instead of exec'ing a stale build.
# The bootstrap is BOUNDED, not unbounded (GH-1850). It measures ~4.5s cold on
# a normal link, but 155MB has to arrive first and a slow link can push that
# past Claude Code's 30s MCP startup deadline — at which point the server is
# marked failed for the session AND the install it was waiting on is torn down,
# so the next session starts just as cold. Past
# RALPH_KNOWLEDGE_HANDSHAKE_DEADLINE_SEC (15s) the install continues in the
# background and this launcher exec's scripts/handshake-stub.cjs instead: a
# zero-dependency process that answers the handshake and reports no tools. The
# session is degraded and says so; it is not failed, and the work is not lost.
#
# The honest limit: if the session is torn down while the background install is
# still running, that install dies with it. What survives is npm's own cache, so
# the bytes already fetched are not re-fetched — the next launch resumes from a
# warm cache rather than from nothing. Correctness is unaffected either way: the
# marker is removed before the install and written only after it succeeds, so an
# interrupted tree re-bootstraps rather than being served.
#
#   * an inter-process mkdir LOCK, so exactly one process runs the
#     destructive `npm ci` while the others wait and then re-check. The lock is
#     never taken from its holder — see the note on reclamation below.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
# The server's cwd stays the PLUGIN ROOT even though it is built and served out
# of a runtime subtree: hooks/disk-guard.sh identifies an in-use plugin version
# by the cwd of running processes, so moving it would make every live server
# read as idle and reclaimable.
cd "$PLUGIN_ROOT"

# Resolved from the script's own directory, not PLUGIN_ROOT: the two differ when
# CLAUDE_PLUGIN_ROOT is set, and the checker ships beside this launcher.
CHECK_DEPS="$SCRIPT_DIR/deps-complete.cjs"
# Served instead of the real entry point when the bootstrap is still running at
# the handshake deadline (GH-1850).
STUB="$SCRIPT_DIR/handshake-stub.cjs"

LOCK_WAIT_SEC="${RALPH_KNOWLEDGE_BOOTSTRAP_WAIT_SEC:-900}"

# How long we are willing to make Claude Code WAIT for a first bootstrap before
# answering the handshake with the stub instead (GH-1850).
#
# This is a bound on the handshake, not on the install: past the deadline the
# bootstrap keeps running in the background and the next session gets the real
# server. 15s sits under Claude Code's 30s MCP_TIMEOUT with room for the
# handshake itself, and well over the ~4.5s a cold bootstrap measures on a
# normal link — so the ordinary case still exec's the real server on the FIRST
# session and nothing about it changes. Only a bootstrap slow enough to have
# been killed by the deadline anyway reaches the stub.
#
# 0 restores the pre-GH-1850 behaviour: block until the bootstrap finishes,
# however long that takes. That is also the automatic fallback when the stub is
# missing — a launcher that cannot serve a stub must not shorten its wait.
HANDSHAKE_DEADLINE_SEC="${RALPH_KNOWLEDGE_HANDSHAKE_DEADLINE_SEC:-15}"
# A non-numeric setting is a typo, not an instruction to block forever.
case "$HANDSHAKE_DEADLINE_SEC" in
  '' | *[!0-9]*) HANDSHAKE_DEADLINE_SEC=15 ;;
esac
[ -r "$STUB" ] || HANDSHAKE_DEADLINE_SEC=0

# A stable identifier for THIS MACHINE.
#
# `hostname` first, because it is what an operator recognises in a refusal
# message. The fallbacks exist because an empty hostname used to collapse to a
# shared `unknown-host` sentinel, and two machines that both failed to name
# themselves compared EQUAL — so a cross-host check passed them as same-host
# (codex, PR #1755). Since the host is part of the tree key, a collision is no
# longer a guard that fails open but a tree that is genuinely shared, so the
# collision is removed at the source instead of guarded downstream.
#
# The last resort is a uuid persisted under TMPDIR, which is machine-local on
# every real system even when the home directory is not. Losing it costs one
# extra tree; it can never produce a wrong match.
machine_id() {
  local h id idfile
  if h=$(hostname 2>/dev/null) && [ -n "$h" ]; then
    printf '%s' "${h%%.*}"
    return 0
  fi
  if [ -r /etc/machine-id ] && id=$(cat /etc/machine-id 2>/dev/null) && [ -n "$id" ]; then
    printf 'mid-%s' "$(printf '%s' "$id" | cut -c1-12)"
    return 0
  fi
  if command -v ioreg >/dev/null 2>&1 \
    && id=$(ioreg -rd1 -c IOPlatformExpertDevice 2>/dev/null \
      | sed -n 's/.*"IOPlatformUUID" = "\([^"]*\)".*/\1/p') \
    && [ -n "$id" ]; then
    printf 'uuid-%s' "$(printf '%s' "$id" | cut -c1-12)"
    return 0
  fi
  idfile="${TMPDIR:-/tmp}/.ralph-knowledge-machine-id"
  if [ -r "$idfile" ] && id=$(cat "$idfile" 2>/dev/null) && [ -n "$id" ]; then
    printf '%s' "$id"
    return 0
  fi
  id="local-$$-${RANDOM:-0}-$(date +%s 2>/dev/null || echo 0)"
  printf '%s\n' "$id" >"$idfile" 2>/dev/null || true
  printf '%s' "$id"
}

# Filesystem-safe: the key becomes a directory name, and platform strings and
# hostnames are not guaranteed to be.
sanitize_key() {
  printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_'
}

# The directory key for this runtime's tree: native ABI boundary + machine.
#
# Deliberately NOT node_compat_boundary(), even though it answers the same
# question, because that function's no-node fallback returns a value that
# DIFFERS ON EVERY CALL — correct for a fingerprint that must never claim a
# match, fatal for a directory name, which would then mint a fresh tree per
# launch. That is precisely the npx-cache-bloat failure this launcher exists to
# end. So the key has its own resolution and bottoms out at a fixed
# `node-unknown`: one tree that re-bootstraps, never a tree per launch.
runtime_key() {
  local id major node_part
  if id=$(node -p 'process.platform+"-"+process.arch+"-abi"+process.versions.modules' 2>/dev/null) \
    && [ -n "$id" ]; then
    node_part="$id"
  elif major=$(node --version 2>/dev/null) && [ -n "$major" ]; then
    node_part="${major%%.*}-$(uname -s 2>/dev/null || echo unknown-os)-$(uname -m 2>/dev/null || echo unknown-arch)"
  else
    node_part="node-unknown"
  fi
  sanitize_key "$node_part-$(machine_id)"
}

# Identity for lock ownership and provenance messages. A PID only means
# something on the host that issued it, and a plugin directory can live on a
# shared network home.
THIS_HOST="$(machine_id)"

RUNTIME_KEY="$(runtime_key)"
RUNTIME_ROOT="$PLUGIN_ROOT/.runtimes/$RUNTIME_KEY"

MARKER="$RUNTIME_ROOT/.bootstrap-complete"
# Which Node identity built the tree. Kept beside the marker (which is an
# opaque hash) so a refusal can name the runtime that owns the tree. With
# per-identity trees this is provenance, no longer a guard input: a tree inside
# $RUNTIME_ROOT was built by $RUNTIME_KEY by construction.
IDENTITY_FILE="$RUNTIME_ROOT/.bootstrap-identity"
# The lock lives INSIDE the runtime tree, so two identities bootstrapping at
# once do not serialize against each other — they have nothing in common to
# protect.
LOCK="$RUNTIME_ROOT/.bootstrap.lock"
# Written by the backgrounded bootstrap with its exit status, and polled by the
# foreground (GH-1850). It is what distinguishes SLOW from BROKEN: a bootstrap
# still running has written nothing and earns the stub, while one that finished
# non-zero fails the launch exactly as a synchronous one would. Serving a stub
# forever because npm can never succeed is the worst outcome available here, so
# it is the one case that is never allowed to look like patience.
BOOT_STATUS="$RUNTIME_ROOT/.bootstrap.status"

fingerprint() {
  local hasher
  if command -v shasum >/dev/null 2>&1; then
    hasher="shasum -a 256"
  elif command -v sha256sum >/dev/null 2>&1; then
    hasher="sha256sum"
  elif command -v cksum >/dev/null 2>&1; then
    # POSIX, and present on every host that has a shell at all. A CRC is not
    # collision-resistant, but nothing here is adversarial — the input is this
    # machine's own lockfile, and a CRC still detects the accidental edits the
    # marker exists to catch.
    hasher="cksum"
  else
    # No hasher at all. The marker cannot describe the tree, so it must not
    # claim to: return a value that differs on every call (codex P2, PR #1755).
    # A constant here was worse than useless — the first bootstrap wrote it and
    # every later check matched it, so package.json, lockfile, and Node
    # compatibility changes silently reused a stale build. Differing per call
    # means bootstrap is driven purely by the artifact checks in
    # bootstrap_needed(), which is the documented intent.
    echo "no-hasher-$$-${RANDOM:-0}-$(date +%s 2>/dev/null || echo 0)"
    return 0
  fi
  {
    node_compat_boundary
    cat package.json package-lock.json
  } | $hasher | cut -d' ' -f1
}

# The Node identity the built tree is actually bound to — NOT the full
# version string (codex P2, PR #1755). Hashing `node --version` invalidated
# the marker on every Node patch bump, and each invalidation costs a
# destructive `npm ci` + rebuild: multi-minute startup at best, and at worst a
# working offline install taken down because the registry is unreachable.
#
# The real boundary is the native ABI *on this platform*. better-sqlite3,
# onnxruntime-node, and the platform-specific sqlite-vec package ship compiled
# binaries keyed to NODE_MODULE_VERSION, which is stable across every minor and
# patch and changes exactly when a rebuild IS required.
#
# The ABI alone is not enough: it is identical for an arm64 and an x64 Node of
# the same major, while the binaries are architecture-bound (codex P2, PR
# #1755). One plugin cache reached by both — a Rosetta shell, a rebuilt
# machine, a shared network home — would match the marker and then load
# binaries for the wrong architecture. So platform and arch are part of the
# identity too.
#
# Fall back to the major version when `node -p` cannot answer, and to a
# never-matching sentinel when node is missing entirely — an unknown boundary
# must re-bootstrap, never claim a match.
node_compat_boundary() {
  local id major
  if id=$(node -p 'process.platform+"-"+process.arch+"-abi"+process.versions.modules' 2>/dev/null) \
    && [ -n "$id" ]; then
    echo "node-$id"
    return 0
  fi
  if major=$(node --version 2>/dev/null) && [ -n "$major" ]; then
    # v22.11.0 -> v22, qualified by whatever uname can tell us about the host.
    echo "node-major-${major%%.*}-$(uname -s 2>/dev/null || echo unknown-os)-$(uname -m 2>/dev/null || echo unknown-arch)"
    return 0
  fi
  echo "node-unknown-$$-${RANDOM:-0}"
}

# True (0) when the installed tree can actually run the server.
#
# The rules live in scripts/deps-complete.cjs, which documents each one and is
# tested against this package's REAL node_modules (GH-1846) — every version of
# this check validated against fixtures instead shipped a false positive, and a
# false "missing" forces a destructive `npm ci` + rebuild on every launch.
#
# Required set and install paths come from package-lock.json, so the walk
# reaches transitive and platform packages: one removed beneath its wrapper
# (sqlite-vec-<platform>-<arch>, onnxruntime-node under
# @huggingface/transformers) left the wrapper intact and the marker trusted,
# and the server then died resolving a binary instead of repairing the tree.
#
# Fails closed: a node that cannot run this script, or a checker that is
# missing, re-bootstraps rather than claiming the tree is healthy.
#
# Evaluated INSIDE the runtime tree (GH-1844): its package-lock.json is the copy
# this tree was installed from, and its node_modules is the only one the served
# dist can resolve against. A runtime root that does not exist yet fails the
# `cd` and reads as incomplete, which is correct — there is nothing to serve.
# Subshell body, not a brace block: the `cd` must not follow the caller out of
# the function, since the rest of the launcher runs from the plugin root.
deps_complete() (
  cd "$RUNTIME_ROOT" 2>/dev/null || return 1
  node "$CHECK_DEPS" 2>/dev/null
)


# True (0) when bootstrap must run.
bootstrap_needed() {
  [ -f "$RUNTIME_ROOT/dist/index.js" ] || return 0
  deps_complete || return 0
  [ -f "$MARKER" ] || return 0
  [ "$(cat "$MARKER" 2>/dev/null)" = "$(fingerprint)" ] || return 0
  return 1
}

# True (0) when a running MCP SERVER is serving out of the runtime tree $1.
#
# Identified by ARGV, not by cwd. The launcher cd's to the plugin root and
# execs `node <runtime>/dist/index.js` from there, so every process involved —
# servers and waiting launchers alike — shares that cwd, and a cwd test cannot
# tell them apart. The absolute path of the served entry point can: no waiter
# carries it, and it names one runtime tree rather than the plugin as a whole.
# That precision is what per-identity trees need — a server of a DIFFERENT
# identity is not a reason to refuse a rebuild of this one.
#
# Best-effort by nature: /proc on Linux, `ps` elsewhere. It can only speak for
# THIS machine, which per-identity trees make sufficient — the machine is part
# of the tree key, so a tree built elsewhere is a different tree. Callers ask
# dir_use_probe_available first, so that unknown never reads as "nobody is
# there".
dir_use_probe_available() {
  [ -d /proc ] || command -v ps >/dev/null 2>&1
}

server_running_in() {
  # TWO spellings, because argv carries the path as the launcher wrote it while
  # `pwd -P` resolves symlinks — on macOS /var is a symlink to /private/var, so
  # a physical-only match misses every server started through the ordinary
  # path and the probe reports an in-use tree as idle. The literal is what a
  # running server's argv actually contains; the physical form covers a caller
  # that reached the same tree by another name.
  local dir phys entry entry2
  dir="${1%/}"
  phys=$(cd "$1" 2>/dev/null && pwd -P) || phys="$dir"
  entry="$dir/dist/index.js"
  entry2="${phys%/}/dist/index.js"
  (
    # From /, so the helpers spawned below are not themselves inside $dir.
    cd / 2>/dev/null || exit 1

    if [ -d /proc ]; then
      for p in /proc/[0-9]*; do
        pid=${p#/proc/}
        [ "$pid" = "$$" ] && continue
        cmd=$(tr '\0' ' ' <"$p/cmdline" 2>/dev/null) || continue
        case "$cmd" in *"$entry"*|*"$entry2"*) exit 0 ;; esac
      done
      exit 1
    fi

    if command -v ps >/dev/null 2>&1; then
      # Captured before matching — piping into an early-exiting matcher loses
      # the result to SIGPIPE under pipefail.
      pssnap=$(ps -eo pid=,args= 2>/dev/null) || pssnap=""
      [ -n "$pssnap" ] || exit 1
      printf '%s\n' "$pssnap" | awk -v self="$$" -v e="$entry" -v e2="$entry2" '
        {
          pid = $1 + 0
          if (pid != self && (index($0, e) > 0 || index($0, e2) > 0)) { found = 1 }
        }
        END { exit(found ? 0 : 1) }
      ' && exit 0
      exit 1
    fi
    exit 1
  )
}

# Deliberately NOT a subshell, even though it cd's: bash defers a TERM/INT trap
# until the current foreground command returns, and a subshell body makes that
# command the WHOLE bootstrap. A launcher killed during `npm ci` would then run
# the build, the prune and the completion marker before its handler ever fired,
# which is exactly the "interrupted bootstrap claims completion" state the
# marker exists to prevent. It restores the caller's cwd on the way out.
run_bootstrap() {
  # Measured, not guessed: ~4.5s on a cold npm cache and ~3.6s warm (macOS,
  # 155MB fetched). The old "~1-2 min" here was a pessimistic placeholder, and
  # it read as a defect against Claude Code MCP_TIMEOUT (default 30000ms) —
  # for comparison the `npx -y ralph-hero-knowledge-index@X` wiring this
  # replaces took 7.7s cold and fetched 596MB. On a slow link the download can
  # still dominate, which is what the handshake deadline above bounds (GH-1850).
  echo "[ralph-knowledge] first run for runtime '$RUNTIME_KEY': installing and building (one-time, usually a few seconds)..."
  # Drop the marker first: if we are interrupted below, the next launch must
  # see an incomplete tree rather than a stale "complete" claim.
  rm -f "$MARKER" "$IDENTITY_FILE"

  # Materialize the runtime tree. The manifests are COPIED, not symlinked:
  # `npm prune` can rewrite a lockfile, and writing through a symlink would
  # edit the plugin's own source of truth. `src` is SYMLINKED, so a developer
  # editing the plugin sources is not silently served a stale snapshot —
  # verified that tsc compiles a symlinked rootDir, maps outDir correctly, and
  # resolves bare imports against this tree's node_modules rather than the
  # plugin root's.
  cp "$PLUGIN_ROOT/package.json" "$PLUGIN_ROOT/package-lock.json" \
    "$PLUGIN_ROOT/tsconfig.json" "$RUNTIME_ROOT/"
  rm -rf "$RUNTIME_ROOT/src"
  ln -s "$PLUGIN_ROOT/src" "$RUNTIME_ROOT/src"

  cd "$RUNTIME_ROOT"
  # --include=dev is NOT redundant (codex P2, PR #1755). `tsc` is declared only
  # in devDependencies and the very next line runs it. If the environment says
  # to omit dev — Claude Code inheriting NODE_ENV=production, or a user's own
  # npm config — this install silently skips typescript and the build then
  # fails on every first launch, before the completion marker is written.
  # Verified: `NODE_ENV=production npm config get omit` reports `dev`, and
  # --include overrides it. The dev deps are pruned again two lines down, so
  # this costs nothing on disk.
  npm ci --include=dev --no-audit --no-fund
  npm run build
  npm prune --omit=dev --no-audit --no-fund
  # onnxruntime-web must remain importable (transformers.js imports it
  # statically) but its wasm payloads are never loaded under Node. A missing
  # directory is fine (layout change / already pruned); a failure to delete an
  # existing payload is not, and must not be reported as a clean bootstrap.
  if [ -d node_modules/onnxruntime-web ]; then
    find node_modules/onnxruntime-web -name '*.wasm' -delete
  fi
  # Identity BEFORE the marker (codex P2, PR #1755). The marker is the
  # completion signal, so anything that survives with a marker must already
  # carry its provenance — publishing them the other way round leaves a window
  # where a complete-looking tree has no identity at all.
  # The HOST is recorded too: a local /proc/lsof probe can only speak for this
  # machine, so a tree built elsewhere on a shared home must not be judged idle
  # from here.
  printf '%s %s\n' "$(node_compat_boundary 2>/dev/null || echo unknown)" "$THIS_HOST" \
    >"$IDENTITY_FILE" 2>/dev/null || true
  # The fingerprint is taken from the PLUGIN ROOT's manifests, which are the
  # source of truth the copies above were made from — so an upstream change
  # invalidates this tree even though its own copies still agree with its
  # node_modules.
  (cd "$PLUGIN_ROOT" && fingerprint) >"$MARKER"
  cd "$PLUGIN_ROOT"
  echo "[ralph-knowledge] bootstrap complete."
}

# NOTE ON RECLAMATION — deliberately absent (codex P2 x6, PR #1755).
#
# Earlier revisions tried to detect and delete an abandoned lock. Four designs
# were written and MEASURED, and each one failed or spawned the next:
#
#   rm by name                — 30 waiters all pass the same check, then all
#                               delete; whoever already reclaimed loses its
#                               fresh lock. 4 concurrent installs.
#   an external reap lock     — moved the same race onto clearing a STALE reap
#                               lock.
#   capture by rename(2)      — instance-bound, but leaves the lock absent
#                               while inspected; a slow box fills that window.
#                               3 concurrent installs on CI's 2-core runner.
#   a marker inside the lock  — closed that, then deadlocked the tree when a
#                               reaper was SIGKILLed holding it; and recovering
#                               THAT marker is check-then-delete again.
#
# The recursion is the finding: reclamation is check-then-delete on a shared
# pathname, and every serialization layer needs its own reclamation, which
# needs its own serialization. POSIX shell has exactly one atomic primitive
# here — `mkdir` — and it can create, never safely destroy someone else's.
#
# So this launcher NEVER deletes a lock it does not own. `mkdir` alone decides
# who bootstraps, which is airtight, and a lock is released only by the process
# that took it: normally, or via its INT/TERM handlers. Nothing else can
# manufacture a second holder, because nothing else removes the directory.
#
# The cost is stated rather than engineered around: a bootstrap killed with
# SIGKILL (or a machine that dies mid-install) leaves the lock behind, and the
# next launch waits out LOCK_WAIT_SEC and then FAILS with the directory to
# remove. That is a one-line manual recovery in a rare case, traded for the
# removal of an entire class of concurrent-destructive-install bugs. An
# ordinary kill needs no recovery at all — the handlers release the lock.
#
# The owner record is kept, but purely so that message can say WHO holds it.
# Nothing reads it to decide anything.
lock_write_owner() {
  printf '%s %s %s\n' "$$" "$THIS_HOST" "$(date +%s 2>/dev/null || echo 0)" \
    >"$LOCK/owner" 2>/dev/null || true
}

# Set true only where we have positively established that the tree cannot serve
# yet (GH-1850). Never inferred at the exec by re-running bootstrap_needed: that
# is a node subprocess, and paying for it on every warm launch to answer a
# question only the cold path can ask would tax the common case for the rare one.
SERVE_STUB=false

if bootstrap_needed; then
  mkdir -p "$RUNTIME_ROOT"
  waited=0
  acquired=false
  while :; do
    if mkdir "$LOCK" 2>/dev/null; then
      acquired=true
      break
    fi

    # The holder may have finished while we were queued. Once the tree is
    # complete we need nothing from the lock, so leave immediately rather than
    # waiting a turn (codex P2, PR #1755) — otherwise a cold start with N
    # sessions costs roughly one polling interval PER session, each waking,
    # taking a lock it does not need, and dropping it again.
    bootstrap_needed || break

    # Waiting on ANOTHER process's bootstrap is bounded by the same handshake
    # deadline as running our own (GH-1850) — from Claude Code's side the two
    # are indistinguishable, and the peer's install carries on regardless.
    if [ "$HANDSHAKE_DEADLINE_SEC" -gt 0 ] && [ "$waited" -ge "$HANDSHAKE_DEADLINE_SEC" ]; then
      echo "[ralph-knowledge] another process is still bootstrapping after ${waited}s; serving a" >&2
      echo "[ralph-knowledge] stub for this session so the handshake is not lost. Held by:" >&2
      echo "[ralph-knowledge] $(cat "$LOCK/owner" 2>/dev/null || echo 'unknown (no owner recorded)')" >&2
      echo "[ralph-knowledge] if that process is gone, remove $LOCK and relaunch." >&2
      # One last look before committing to the stub: the peer may have finished
      # between the check at the top of this turn and now.
      bootstrap_needed && SERVE_STUB=true
      break
    fi

    if [ "$waited" -ge "$LOCK_WAIT_SEC" ]; then
      echo "[ralph-knowledge] timed out after ${LOCK_WAIT_SEC}s waiting for another process to bootstrap ($LOCK)" >&2
      echo "[ralph-knowledge] held by: $(cat "$LOCK/owner" 2>/dev/null || echo 'unknown (no owner recorded)')" >&2
      echo "[ralph-knowledge] if that process is gone, remove $LOCK and relaunch" >&2
      exit 1
    fi
    [ "$waited" -eq 0 ] && echo "[ralph-knowledge] another process is bootstrapping; waiting..." >&2
    sleep 2
    waited=$((waited + 2))
  done

  if [ "$acquired" = true ]; then
    # Release the lock however we leave — but a SIGNAL handler must also STOP.
    # Bash runs a TERM/INT trap and then RESUMES the script, so a cleanup-only
    # handler would drop the lock and carry on bootstrapping, letting another
    # launcher run a second destructive `npm ci` on the same tree. Handlers
    # also disarm EXIT first: otherwise `exit` runs the still-armed EXIT trap
    # and removes the pathname a second time, deleting whatever waiter
    # acquired it in between. Both are codex P2s from this PR.
    trap 'rm -rf "$LOCK"' EXIT
    trap 'trap - EXIT; rm -rf "$LOCK"; exit 130' INT
    trap 'trap - EXIT; rm -rf "$LOCK"; exit 143' TERM

    # Recorded only so a timed-out waiter can name who holds the lock. Nothing
    # reads it to make a decision — see the note on reclamation above.
    lock_write_owner

    # Re-check under the lock: the process we waited on may have finished the
    # work, in which case we must not repeat the destructive `npm ci`.
    if bootstrap_needed; then
      # Everything below is scoped to THIS runtime tree. A server of another
      # identity, or on another machine, is serving out of a different
      # directory entirely (GH-1844) and is neither disturbed by this rebuild
      # nor a reason to refuse it — which is the whole point of the layout.
      built_line=$(cat "$IDENTITY_FILE" 2>/dev/null || echo "")
      built_host=$(printf '%s' "$built_line" | cut -d' ' -f2)

      # Is there an existing built tree at all? A genuinely empty runtime root
      # has nothing to protect, so a first install is never blocked.
      tree_exists=false
      if [ -f "$MARKER" ] || [ -d "$RUNTIME_ROOT/node_modules" ]; then
        tree_exists=true
      fi

      # A LIVE SERVER on this tree blocks the rebuild (codex P2, PR #1755).
      # Per-identity trees remove the CROSS-identity case, not this one: a
      # same-identity rebuild is just as destructive, and a damaged marker, a
      # changed lockfile, or a missing entry point all reach `npm ci` while a
      # server is still resolving lazy imports out of node_modules. Failing
      # loudly here beats the silent alternative, where that server dies later
      # with nothing to connect it to this rebuild.
      #
      # Unknown must not read as "safe": where the process table cannot be read
      # at all we cannot prove the tree is idle, so an EXISTING tree is refused
      # there too and the operator is told why.
      if [ "$tree_exists" = true ] && dir_use_probe_available \
        && server_running_in "$RUNTIME_ROOT"; then
        echo "[ralph-knowledge] refusing to rebuild: a server is still running out of $RUNTIME_ROOT." >&2
        echo "[ralph-knowledge] Rebuilding would replace node_modules underneath it." >&2
        echo "[ralph-knowledge] close every session using this runtime, then relaunch." >&2
        echo "[ralph-knowledge] once they are closed, removing $RUNTIME_ROOT forces a clean rebuild." >&2
        exit 1
      fi

      if [ "$tree_exists" = true ] && ! dir_use_probe_available; then
        echo "[ralph-knowledge] refusing to rebuild: this host cannot be probed for running" >&2
        echo "[ralph-knowledge] processes, so a server serving out of $RUNTIME_ROOT cannot be" >&2
        echo "[ralph-knowledge] ruled out, and rebuilding would replace node_modules underneath it." >&2
        echo "[ralph-knowledge] close every session using this runtime, then relaunch." >&2
        echo "[ralph-knowledge] once they are closed, removing $RUNTIME_ROOT forces a clean rebuild." >&2
        exit 1
      fi

      # Residual assertion, not a guard that should ever fire: the machine is
      # part of the tree key, so a tree in this directory was built here. If it
      # was not, the machine id is not as stable as it claims and the local
      # process probe above cannot speak for whoever built it — refuse rather
      # than treat an unprovable case as idle (codex, PR #1755).
      if [ "$tree_exists" = true ] && [ -n "$built_host" ] \
        && [ "$built_host" != "$THIS_HOST" ]; then
        echo "[ralph-knowledge] refusing to rebuild: this tree records host '$built_host'" >&2
        echo "[ralph-knowledge] but this machine identifies as '$THIS_HOST', so the local process" >&2
        echo "[ralph-knowledge] table cannot say whether a server there is still serving from it." >&2
        echo "[ralph-knowledge] close every session using this runtime, then relaunch." >&2
        echo "[ralph-knowledge] once they are closed, removing $RUNTIME_ROOT forces a clean rebuild." >&2
        exit 1
      fi

      # A tree left at the plugin root by a pre-GH-1844 launcher is dead weight
      # once this runtime tree exists, and it is large. It is NOT swept: a
      # session started before the upgrade may still be serving out of it, and
      # deleting it would break exactly the process the guards above protect.
      # Named once, at the only moment we are already talking to the operator.
      if [ -d "$PLUGIN_ROOT/node_modules" ]; then
        echo "[ralph-knowledge] note: a pre-per-runtime install is still present at" >&2
        echo "[ralph-knowledge] $PLUGIN_ROOT/node_modules and is no longer used. Once every session" >&2
        echo "[ralph-knowledge] started before this upgrade is closed, it can be removed." >&2
      fi

      if [ "$HANDSHAKE_DEADLINE_SEC" -eq 0 ]; then
        run_bootstrap >&2
        trap - EXIT INT TERM
        rm -rf "$LOCK"
      else
        # Backgrounded, and the LOCK GOES WITH IT (GH-1850). The foreground
        # disarms its own handlers immediately afterwards: two processes with a
        # `rm -rf "$LOCK"` trap means the one that leaves first deletes a lock
        # the other is still bootstrapping under, and the next launcher then
        # takes it and runs a second destructive `npm ci` on the same tree.
        # Ownership is single by construction here, exactly as it was when the
        # bootstrap ran in the foreground.
        #
        # stdout is redirected to stderr for the WHOLE subshell, not just
        # run_bootstrap: after the exec below, that fd is the MCP stdio channel
        # this process is speaking on, and one stray npm line on it corrupts the
        # session. stdin is closed for the same reason in the other direction —
        # a backgrounded npm must never consume bytes meant for the server.
        # The status is published FROM THE EXIT TRAP, and run_bootstrap is
        # called as a plain command — never as an `if`/`||` condition. Every
        # construct that captures a status also disables errexit for the
        # command it captures, and run_bootstrap relies on errexit to stop at
        # the first failed step: written as `if run_bootstrap`, a failed
        # `npm ci` fell through to `npm run build`, the prune, and the
        # completion marker. Caught by this file's own broken-install test.
        #
        # The signal handlers deliberately publish NOTHING. A bootstrap that
        # was killed has reached no verdict — the tree simply needs rebuilding —
        # and the absence reads as "still going", which serves the stub and
        # re-bootstraps next launch. Only a run that finished on its own gets to
        # say whether it worked.
        rm -f "$BOOT_STATUS"
        (
          trap 'st=$?; rm -rf "$LOCK"; printf "%s\n" "$st" >"$BOOT_STATUS"' EXIT
          trap 'trap - EXIT; rm -rf "$LOCK"; exit 130' INT
          trap 'trap - EXIT; rm -rf "$LOCK"; exit 143' TERM
          run_bootstrap
        ) >&2 </dev/null &
        trap - EXIT INT TERM

        waited=0
        while [ ! -f "$BOOT_STATUS" ] && [ "$waited" -lt "$HANDSHAKE_DEADLINE_SEC" ]; do
          sleep 1
          waited=$((waited + 1))
        done

        if [ -f "$BOOT_STATUS" ]; then
          boot_status=$(cat "$BOOT_STATUS" 2>/dev/null || echo 1)
          if [ "$boot_status" != "0" ]; then
            echo "[ralph-knowledge] bootstrap failed (exit $boot_status); see the output above." >&2
            exit 1
          fi
        else
          # Still installing. Say so on the one channel a user can read, since
          # a session with no knowledge tools and no explanation is the thing
          # that gets reported as a broken plugin.
          echo "[ralph-knowledge] bootstrap is still running after ${waited}s (slow link?)." >&2
          echo "[ralph-knowledge] Answering the handshake with a no-tools stub so this session is" >&2
          echo "[ralph-knowledge] not marked failed. The install CONTINUES in the background; a new" >&2
          echo "[ralph-knowledge] session started once it finishes will have the full toolset." >&2
          SERVE_STUB=true
        fi
      fi
    else
      trap - EXIT INT TERM
      rm -rf "$LOCK"
    fi
  fi
fi

# A bootstrap that finished inside the deadline, or one a peer finished while we
# waited, exec's the real server on THIS session. Only a tree we have positively
# established cannot serve yet gets the stub.
if [ "$SERVE_STUB" = true ]; then
  exec node "$STUB"
fi

# cwd stays the plugin root (see the top of this file); the entry point is
# addressed absolutely so it resolves node_modules inside its own runtime tree
# and so the process probe above can recognise it.
exec node "$RUNTIME_ROOT/dist/index.js" "$@"
