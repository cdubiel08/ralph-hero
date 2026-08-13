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

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$PLUGIN_ROOT"

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

# True (0) when EVERY runtime dependency declared in package.json is present.
#
# Hand-listing a few packages was not enough (codex P2, PR #1755): `zod` is
# imported at the top of src/index.ts and was not among them, so a tree missing
# it — partial cache cleanup, a half-finished delete — passed as complete and
# the final `exec` failed instead of repairing itself. That contradicts the
# recovery invariant the check exists to uphold.
#
# The list therefore comes from package.json itself, so a dependency added
# later is covered without anyone remembering to update this. Only
# `dependencies` are checked: devDependencies are pruned after the build by
# design, and demanding them would force a rebuild on every launch.
#
# If node cannot answer, fail closed and rebuild — a node that cannot run a
# one-liner cannot run the server either.
deps_complete() {
  node -e '
    const fs = require("fs"), path = require("path");
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
    const missing = Object.keys(pkg.dependencies || {})
      .filter((d) => !fs.existsSync(path.join("node_modules", d)));
    if (missing.length) { console.error(missing.join(" ")); process.exit(1); }
  ' 2>/dev/null
}

# True (0) when bootstrap must run.
bootstrap_needed() {
  [ -f dist/index.js ] || return 0
  deps_complete || return 0
  [ -f "$MARKER" ] || return 0
  [ "$(cat "$MARKER" 2>/dev/null)" = "$(fingerprint)" ] || return 0
  return 1
}

# True (0) when some running process is working inside directory $1.
#
# Used to refuse a rebuild that would pull the tree out from under a server
# that is still serving from it. Best-effort by nature: /proc on Linux, lsof on
# macOS/BSD. When NEITHER is available the answer is unknown, and unknown must
# not read as "nobody is using it" — callers treat a non-zero return from an
# unprobeable host as "cannot tell" via dir_use_probe_available.
dir_use_probe_available() {
  [ -d /proc ] || command -v lsof >/dev/null 2>&1
}

dir_in_use() {
  local dir p cwd
  # Compare PHYSICAL paths. macOS symlinks /tmp and /var into /private, and
  # both /proc and lsof report the resolved path — so a literal string compare
  # against the caller's path silently never matches, and every directory would
  # look idle. That failure is invisible: the guard would simply go back to
  # calling in-use directories safe to delete.
  dir=$(cd "$1" 2>/dev/null && pwd -P) || dir="${1%/}"
  dir="${dir%/}"
  # The probe must not see ITSELF. The launcher cd's to the plugin root on line
  # one, so this shell's cwd is $dir — and every helper it spawns (lsof, awk,
  # readlink) inherits that cwd and shows up as another process "using" the
  # directory. Both are excluded: the shell by PID, and the helpers by running
  # the whole probe from / so they are not in $dir at all. Without this every
  # tree looks permanently in use and no cross-identity rebuild could proceed.
  (
    cd / 2>/dev/null || exit 1
    if [ -d /proc ]; then
      for p in /proc/[0-9]*; do
        [ "${p#/proc/}" = "$$" ] && continue
        cwd=$(readlink "$p/cwd" 2>/dev/null) || continue
        case "$cwd" in "$dir"|"$dir"/*) exit 0 ;; esac
      done
      exit 1
    fi
    if command -v lsof >/dev/null 2>&1; then
      lsof -d cwd -Fpn 2>/dev/null | awk -v self="$$" -v d="$dir" '
        /^p/ { pid = substr($0, 2); next }
        /^n/ {
          path = substr($0, 2)
          if (pid != self && (path == d || index(path, d "/") == 1)) { found = 1; exit }
        }
        END { exit(found ? 0 : 1) }
      ' && exit 0
      exit 1
    fi
    exit 1
  )
}

run_bootstrap() {
  echo "[ralph-knowledge] first run: installing and building (one-time, ~1-2 min)..."
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
  fingerprint >"$MARKER"
  node_compat_boundary >"$IDENTITY_FILE" 2>/dev/null || true
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
      built_identity=$(cat "$IDENTITY_FILE" 2>/dev/null || echo "")
      this_identity=$(node_compat_boundary 2>/dev/null || echo "")
      if [ -n "$built_identity" ] && [ -n "$this_identity" ] \
        && [ "$built_identity" != "$this_identity" ]; then
        if ! dir_use_probe_available || dir_in_use "$PLUGIN_ROOT"; then
          echo "[ralph-knowledge] refusing to rebuild: this tree was built for '$built_identity'" >&2
          echo "[ralph-knowledge] and this session is '$this_identity'. Rebuilding would replace" >&2
          echo "[ralph-knowledge] node_modules underneath any session still serving from it." >&2
          if dir_use_probe_available; then
            echo "[ralph-knowledge] a process is currently running in $PLUGIN_ROOT." >&2
          else
            echo "[ralph-knowledge] (this host cannot be probed for running processes)" >&2
          fi
          echo "[ralph-knowledge] close those sessions, or remove $PLUGIN_ROOT/node_modules, then relaunch." >&2
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
