#!/usr/bin/env bash
# MCP launcher for ralph-knowledge.
#
# Runs the vendored copy inside the plugin directory instead of
# `npx -y ralph-hero-knowledge-index@<version>`. The npx form created a fresh
# ~500MB-1GB cache dir under ~/.npm/_npx for every released version pin, and
# npx never evicts — one machine accumulated 20GB across 33 releases.
#
# First run bootstraps in place: npm ci, build, then prune dev deps and the
# onnxruntime-web wasm binaries (lazy-loaded, unused under Node). All
# bootstrap output goes to stderr — stdout is the MCP stdio channel.
#
# Bootstrap is guarded two ways, because several Claude Code sessions can
# launch this script at the same instant:
#   * a completion MARKER holding a fingerprint of package.json +
#     package-lock.json + the Node major version. It is deleted before the
#     install and written only after every step succeeds, so an interrupted
#     or half-updated tree re-bootstraps instead of exec'ing a stale build.
#   * an inter-process mkdir LOCK, so exactly one process runs the
#     destructive `npm ci` while the others wait and then re-check. The lock is
#     never taken from its holder — see the note on reclamation below.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
cd "$PLUGIN_ROOT"

# Resolved from the script's own directory, not PLUGIN_ROOT: the two differ when
# CLAUDE_PLUGIN_ROOT is set, and the checker ships beside this launcher.
CHECK_DEPS="$SCRIPT_DIR/deps-complete.cjs"

MARKER="$PLUGIN_ROOT/.bootstrap-complete"
# Which Node identity built the tree. Kept beside the marker (which is an
# opaque hash) so a launcher can tell "needs rebuilding" from "belongs to a
# different runtime that may still be serving from it".
IDENTITY_FILE="$PLUGIN_ROOT/.bootstrap-identity"
LOCK="$PLUGIN_ROOT/.bootstrap.lock"
LOCK_WAIT_SEC="${RALPH_KNOWLEDGE_BOOTSTRAP_WAIT_SEC:-900}"
# Identity for lock ownership. A PID only means something on the host that
# issued it, and a plugin directory can live on a shared network home.
THIS_HOST="$(hostname 2>/dev/null || echo unknown-host)"

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
deps_complete() {
  node "$CHECK_DEPS" 2>/dev/null
}


# True (0) when bootstrap must run.
bootstrap_needed() {
  [ -f dist/index.js ] || return 0
  deps_complete || return 0
  [ -f "$MARKER" ] || return 0
  [ "$(cat "$MARKER" 2>/dev/null)" = "$(fingerprint)" ] || return 0
  return 1
}

# True (0) when a running MCP SERVER is serving out of directory $1.
#
# Deliberately narrower than "any process in the directory" (codex P2, PR
# #1755). The launcher cd's to the plugin root, so every WAITING launcher also
# has its cwd there — a broad probe would make two simultaneous cold starts
# refuse each other, turning an ordinary race into a hard failure. What must
# not be disturbed is a live SERVER, so both signals are required: cwd inside
# the tree AND `dist/index.js` in the argv, which is exactly how this script
# execs it.
#
# Best-effort by nature: /proc on Linux, lsof + ps on macOS/BSD. It can only
# speak for THIS machine — see the host check at the guard for why that
# matters. Callers ask dir_use_probe_available first, so that unknown never
# reads as "nobody is there".
dir_use_probe_available() {
  [ -d /proc ] || { command -v lsof >/dev/null 2>&1 && command -v ps >/dev/null 2>&1; }
}

server_running_in() {
  local dir
  dir=$(cd "$1" 2>/dev/null && pwd -P) || dir="${1%/}"
  dir="${dir%/}"
  (
    # From /, so the helpers spawned below are not themselves inside $dir.
    cd / 2>/dev/null || exit 1

    if [ -d /proc ]; then
      for p in /proc/[0-9]*; do
        pid=${p#/proc/}
        [ "$pid" = "$$" ] && continue
        cwd=$(readlink "$p/cwd" 2>/dev/null) || continue
        case "$cwd" in "$dir"|"$dir"/*) ;; *) continue ;; esac
        cmd=$(tr '\0' ' ' <"$p/cmdline" 2>/dev/null) || continue
        case "$cmd" in *dist/index.js*) exit 0 ;; esac
      done
      exit 1
    fi

    if command -v lsof >/dev/null 2>&1 && command -v ps >/dev/null 2>&1; then
      # Captured before matching — piping into an early-exiting matcher loses
      # the result to SIGPIPE under pipefail.
      cwdsnap=$(lsof -d cwd -Fpn 2>/dev/null) || cwdsnap=""
      pssnap=$(ps -eo pid=,args= 2>/dev/null) || pssnap=""
      [ -n "$cwdsnap" ] && [ -n "$pssnap" ] || exit 1
      printf '%s\n===\n%s\n' "$pssnap" "$cwdsnap" | awk -v self="$$" -v d="$dir" '
        $0 == "===" { second = 1; next }
        !second { args[$1 + 0] = $0; next }
        /^p/ { cur = substr($0, 2) + 0; next }
        /^n/ {
          path = substr($0, 2)
          if (cur != self && (path == d || index(path, d "/") == 1)) {
            if (index(args[cur], "dist/index.js") > 0) { found = 1 }
          }
        }
        END { exit(found ? 0 : 1) }
      ' && exit 0
      exit 1
    fi
    exit 1
  )
}

run_bootstrap() {
  # Measured, not guessed: ~4.5s on a cold npm cache and ~3.6s warm (macOS,
  # 155MB fetched). The old "~1-2 min" here was a pessimistic placeholder, and
  # it read as a defect against Claude Code MCP_TIMEOUT (default 30000ms) —
  # for comparison the `npx -y ralph-hero-knowledge-index@X` wiring this
  # replaces took 7.7s cold and fetched 596MB. On a slow link the download can
  # still dominate; see the follow-up issue on decoupling it from the
  # handshake.
  echo "[ralph-knowledge] first run: installing and building (one-time, usually a few seconds)..."
  # Drop the marker first: if we are interrupted below, the next launch must
  # see an incomplete tree rather than a stale "complete" claim.
  rm -f "$MARKER" "$IDENTITY_FILE"
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
  fingerprint >"$MARKER"
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

if bootstrap_needed; then
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
      # Refuse to rebuild a tree another RUNTIME may still be serving from
      # (codex P2, PR #1755). One plugin cache can be reached by two Node
      # identities — arm64 native beside x64 under Rosetta, or two machines on
      # a shared home. The identity whose fingerprint matches skips the lock
      # entirely and execs the server; if the other identity then rebuilds,
      # `npm ci` replaces node_modules underneath a live process and it dies on
      # its next lazy require.
      #
      # A full fix is per-identity trees, which is a layout change tracked in
      # #1844. What is enforced here is the other remedy: never replace a tree
      # that a different identity may still be using. When nothing is running
      # in the directory the rebuild proceeds, so an ordinary permanent
      # arch switch still recovers by itself.
      #
      # Unknown must not read as "safe": on a host where neither /proc nor
      # lsof can answer, we cannot prove the tree is idle, so a cross-identity
      # rebuild is refused there too and the operator is told why.
      built_line=$(cat "$IDENTITY_FILE" 2>/dev/null || echo "")
      built_identity=$(printf '%s' "$built_line" | cut -d' ' -f1)
      built_host=$(printf '%s' "$built_line" | cut -d' ' -f2)
      this_identity=$(node_compat_boundary 2>/dev/null || echo "")

      # Is there an existing built tree at all? A genuinely empty root has
      # nothing to protect, so a first install is never blocked.
      tree_exists=false
      if [ -f "$MARKER" ] || [ -d node_modules ]; then
        tree_exists=true
      fi

      # A LIVE SERVER on this tree blocks any rebuild, whatever the identity
      # (codex P2, PR #1755). The earlier guard only covered missing or
      # differing identities, but a same-identity rebuild is just as
      # destructive: a damaged marker, a changed lockfile, or a missing entry
      # point all reach `npm ci`, and node_modules is replaced underneath a
      # server that is still serving from it. Failing loudly here is better
      # than the silent alternative, where that server dies later on a lazy
      # import with nothing to connect it to this rebuild.
      if [ "$tree_exists" = true ] && dir_use_probe_available \
        && server_running_in "$PLUGIN_ROOT"; then
        echo "[ralph-knowledge] refusing to rebuild: a server is still running in $PLUGIN_ROOT." >&2
        echo "[ralph-knowledge] Rebuilding would replace node_modules underneath it." >&2
        echo "[ralph-knowledge] close every session using this plugin root, then relaunch." >&2
        echo "[ralph-knowledge] once they are closed, removing $PLUGIN_ROOT/node_modules forces a clean rebuild." >&2
        exit 1
      fi

      # A tree built on ANOTHER HOST is refused for every rebuild, not only when
      # the identities differ (codex P2, PR #1755). Two machines on a shared
      # home can easily share platform, arch and ABI, in which case identities
      # MATCH and the old placement of this check never ran — while the local
      # probe cannot see the remote server either. So it is evaluated here,
      # independently, alongside the live-server check.
      if [ "$tree_exists" = true ] && [ -n "$built_host" ] \
        && [ "$built_host" != "$THIS_HOST" ]; then
        echo "[ralph-knowledge] refusing to rebuild: this tree was built on host '$built_host'" >&2
        echo "[ralph-knowledge] and this is '$THIS_HOST', whose process table cannot see whether" >&2
        echo "[ralph-knowledge] a server there is still serving from it." >&2
        echo "[ralph-knowledge] close every session using this plugin root, then relaunch." >&2
        echo "[ralph-knowledge] once they are closed, removing $PLUGIN_ROOT/node_modules forces a clean rebuild." >&2
        exit 1
      fi

      # Beyond that, provenance we cannot verify is also a reason to stop.
      guard_needed=false
      guard_why=""
      if [ "$tree_exists" = true ]; then
        if [ -z "$built_identity" ]; then
          # Missing identity metadata is UNKNOWN, not "ours" (codex P2, PR
          # #1755). A deleted or never-written identity file previously skipped
          # this guard entirely and let the rebuild proceed over a live server.
          guard_needed=true
          guard_why="this tree carries no identity record, so its provenance is unknown"
        elif [ "$built_identity" != "$this_identity" ]; then
          guard_needed=true
          guard_why="this tree was built for '$built_identity' and this session is '$this_identity'"
        fi
      fi

      if [ "$guard_needed" = true ]; then
        refuse=""
        if [ -n "$built_host" ] && [ "$built_host" != "$THIS_HOST" ]; then
          # A shared home reached from two machines. The other host's processes
          # are not in our process table, so a locally idle directory is NOT
          # globally idle (codex P2, PR #1755) — and there is no cross-host
          # signal to consult. Refuse rather than treat unprovable as safe.
          refuse="it was built on host '$built_host' and this is '$THIS_HOST', whose process table cannot see it"
        elif dir_use_probe_available && server_running_in "$PLUGIN_ROOT"; then
          refuse="a process is currently running in $PLUGIN_ROOT"
        elif ! dir_use_probe_available && [ -n "$built_identity" ]; then
          # Two runtimes are positively indicated and we cannot check for a
          # live server, so this refuses. The missing-identity case below is
          # NOT treated this harshly on purpose: a tree written by an older
          # launcher carries no identity at all, so refusing there would block
          # every ordinary upgrade on a host without /proc or lsof. That case
          # probes when it can, and says so plainly when it cannot.
          refuse="this host cannot be probed for running processes"
        elif ! dir_use_probe_available; then
          echo "[ralph-knowledge] note: rebuilding a tree of unknown provenance, and this host" >&2
          echo "[ralph-knowledge] cannot be probed for running processes. Close other sessions" >&2
          echo "[ralph-knowledge] using this plugin root if any are open." >&2
        fi

        if [ -n "$refuse" ]; then
          echo "[ralph-knowledge] refusing to rebuild: $guard_why." >&2
          echo "[ralph-knowledge] Rebuilding would replace node_modules underneath any session" >&2
          echo "[ralph-knowledge] still serving from it, and $refuse." >&2
          # Deleting node_modules is NOT an alternative to closing sessions
          # (codex P2, PR #1755) — it destroys exactly the tree the guard just
          # refused to disrupt. It is only safe once nothing is serving from
          # this root, so it is presented as the step AFTER, never instead.
          echo "[ralph-knowledge] close every session using this plugin root, then relaunch." >&2
          echo "[ralph-knowledge] once they are closed, removing $PLUGIN_ROOT/node_modules forces a clean rebuild." >&2
          exit 1
        fi
      fi
      run_bootstrap >&2
    fi

    trap - EXIT INT TERM
    rm -rf "$LOCK"
  fi
fi

exec node dist/index.js "$@"
