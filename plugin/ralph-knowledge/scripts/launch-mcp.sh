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
#     destructive `npm ci` while the others wait and then re-check.
set -euo pipefail

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$PLUGIN_ROOT"

MARKER="$PLUGIN_ROOT/.bootstrap-complete"
LOCK="$PLUGIN_ROOT/.bootstrap.lock"
LOCK_STALE_MIN="${RALPH_KNOWLEDGE_BOOTSTRAP_STALE_MIN:-30}"
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

# True (0) when bootstrap must run. Every dependency the lockfile installs and
# that startup actually needs is checked, not just one scope.
bootstrap_needed() {
  [ -f dist/index.js ] || return 0
  [ -d node_modules/@huggingface ] || return 0
  [ -d node_modules/@modelcontextprotocol/sdk ] || return 0
  [ -d node_modules/better-sqlite3 ] || return 0
  [ -f "$MARKER" ] || return 0
  [ "$(cat "$MARKER" 2>/dev/null)" = "$(fingerprint)" ] || return 0
  return 1
}

run_bootstrap() {
  echo "[ralph-knowledge] first run: installing and building (one-time, ~1-2 min)..."
  # Drop the marker first: if we are interrupted below, the next launch must
  # see an incomplete tree rather than a stale "complete" claim.
  rm -f "$MARKER"
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
  echo "[ralph-knowledge] bootstrap complete."
}

# Age of a directory in whole minutes, on stdout. BSD stat wants -f %m and GNU
# stat wants -c %Y; try both and fail (non-zero, no output) when neither
# answers, so an unreadable age can never be mistaken for "old".
dir_age_min() {
  local now mtime
  now=$(date +%s 2>/dev/null) || return 1
  mtime=$(stat -f %m "$1" 2>/dev/null) || mtime=$(stat -c %Y "$1" 2>/dev/null) || return 1
  [ -n "$mtime" ] || return 1
  echo $(( (now - mtime) / 60 ))
}

lock_age_min() { dir_age_min "$LOCK"; }

# True (0) when the lock may be taken away from whoever holds it.
#
# Age alone does NOT establish that the owner died (codex P2, PR #1755). An
# `npm ci` stalled on a slow registry can legitimately outlive LOCK_STALE_MIN,
# and reclaiming it there starts a second destructive `npm ci` against the same
# tree — the precise race the lock exists to prevent. So when the owner is a
# live process on this machine we ask the kernel instead of guessing, and never
# reclaim; when it is dead we reclaim at once without waiting out the window.
#
# Age remains the fallback for the two cases liveness cannot decide: a lock
# whose owner file is not written yet (the holder is between `mkdir` and the
# write, so the lock is necessarily new), and a lock from another host — a
# shared network home — whose PIDs are not ours to probe.
#
# PID reuse can make a dead owner look alive. That errs toward waiting and then
# timing out, never toward a concurrent install, which is the safe direction.
owner_is_live() {
  local owner="$1" pid host
  [ -n "$owner" ] || return 1
  pid=${owner%% *}
  host=${owner#* }
  [ "$host" = "$THIS_HOST" ] || return 1
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null
}

# The lock's identity record: "pid host born_epoch". Written immediately after
# mkdir. Carrying the birth time IN the file rather than relying on directory
# mtime matters — the reap marker below is created inside the lock, which bumps
# its mtime, and a rename would carry the old one.
lock_write_owner() {
  printf '%s %s %s\n' "$$" "$THIS_HOST" "$(date +%s 2>/dev/null || echo 0)" \
    >"$LOCK/owner" 2>/dev/null || true
}

owner_field() { echo "$1" | cut -d' ' -f"$2"; }

# True (0) when the lock at $1 looks abandoned. TWO conditions, both needed:
#
#   older than LOCK_STALE_MIN — a young lock is NEVER abandoned, whatever its
#     owner record says. Every successor is young by construction, so this is
#     what stops a verdict formed on one instance from condemning its
#     replacement. It also covers the lock whose owner file is not written yet:
#     that is a holder milliseconds old, not a corpse, and reading "no owner
#     recorded" as "no owner alive" measurably produced concurrent installs.
#
#   owner not alive — age alone does not establish death (an `npm ci` stalled
#     on a slow registry outlives the window legitimately). Where the owner is
#     a process on this host we ask the kernel rather than guess.
#
# A foreign host's PIDs are not ours to probe (a shared network home), so there
# age is all there is. PID reuse can make a dead owner look alive, which errs
# toward waiting and timing out — never toward a concurrent install.
dir_reclaimable() {
  local d="$1" owner pid host born now age
  owner=$(cat "$d/owner" 2>/dev/null || echo "")
  if [ -z "$owner" ]; then
    # No identity recorded: fall back to the directory's own age.
    age=$(dir_age_min "$d") || return 1
    [ "$age" -gt "$LOCK_STALE_MIN" ]
    return
  fi
  pid=$(owner_field "$owner" 1)
  host=$(owner_field "$owner" 2)
  born=$(owner_field "$owner" 3)
  case "$born" in
    ''|*[!0-9]*) age=$(dir_age_min "$d") || return 1 ;;
    *)
      now=$(date +%s 2>/dev/null) || return 1
      age=$(( (now - born) / 60 ))
      ;;
  esac
  [ "$age" -gt "$LOCK_STALE_MIN" ] || return 1
  if [ "$host" = "$THIS_HOST" ] && [ -n "$pid" ]; then
    kill -0 "$pid" 2>/dev/null && return 1
  fi
  return 0
}

lock_reclaimable() { dir_reclaimable "$LOCK"; }

# Remove an abandoned lock. Three designs were tried; the first two were
# MEASURED failing, and the reasons are the whole justification for this one
# (codex P2 x4, PR #1755).
#
#   rm by name — 30 waiters all pass the check on the same ancient lock in the
#     same instant, then all run `rm`, deleting the fresh lock whichever one
#     already reclaimed and recreated. 4 concurrent installs.
#
#   an external "reap" lock — only moved the identical race one level up, onto
#     whoever cleared a STALE reap lock.
#
#   capture by rename(2) — atomic and instance-bound, but it leaves $LOCK
#     ABSENT while the captured instance is inspected. Other waiters take that
#     opening, the restore then fails, and a live holder is orphaned. Clean on
#     a fast 10-core machine; CI's 2-core runner produced 3 concurrent installs.
#
# What this does instead: serialize reapers with a marker created INSIDE the
# lock. That is atomic (mkdir), it is scoped to one lock instance, and — unlike
# an external reap lock — it cannot outlive what it guards, so there is no
# stale reaper state to clear and no second race to inherit. The lock is never
# removed from its path to be examined, so no window is ever opened.
#
# The removal is then safe rather than merely narrow: the ONLY way a successor
# could appear between the verdict and the `rm` is for someone to delete this
# lock first, and the only deleter is a reaper holding the marker we are
# holding. The owner record is re-read across the marker to confirm the
# instance did not change hands underneath us.
#
# Returns 0 when this process removed the lock, 1 otherwise.
reap_abandoned_lock() {
  local before after
  # Sample identity and take the verdict BEFORE the marker exists: creating it
  # writes into the lock directory and bumps the mtime some verdicts rest on.
  before=$(cat "$LOCK/owner" 2>/dev/null || echo "__none__")
  lock_reclaimable || return 1

  mkdir "$LOCK/reaping" 2>/dev/null || return 1

  # From here no other reaper can delete this lock, and a successor can only
  # exist if someone deleted it first — so an unchanged owner record proves we
  # are about to remove the same instance we judged.
  after=$(cat "$LOCK/owner" 2>/dev/null || echo "__none__")
  if [ "$after" != "$before" ]; then
    rmdir "$LOCK/reaping" 2>/dev/null || true
    return 1
  fi

  echo "[ralph-knowledge] removing abandoned bootstrap lock ($LOCK)" >&2
  rm -rf "$LOCK" 2>/dev/null || true
  return 0
}

if bootstrap_needed; then
  waited=0
  until mkdir "$LOCK" 2>/dev/null; do
    # Reclaim a lock whose owner is gone. This verdict is only a CHEAP FILTER
    # — it reads a pathname, so it can be stale by the next line. The binding
    # decision is the one reap_abandoned_lock makes on the instance it has
    # captured and holds exclusively.
    if lock_reclaimable; then
      # Only retry immediately if the removal actually worked. Otherwise fall
      # through to the wait accounting below, so a lock we can never delete
      # (permissions, read-only mount) times out instead of spinning forever.
      if reap_abandoned_lock && [ ! -d "$LOCK" ]; then
        continue
      fi
    fi
    if [ "$waited" -ge "$LOCK_WAIT_SEC" ]; then
      echo "[ralph-knowledge] timed out after ${LOCK_WAIT_SEC}s waiting for another process to bootstrap ($LOCK)" >&2
      exit 1
    fi
    [ "$waited" -eq 0 ] && echo "[ralph-knowledge] another process is bootstrapping; waiting..." >&2
    sleep 2
    waited=$((waited + 2))
  done
  # Release the lock however we leave — but a SIGNAL handler must also STOP
  # (codex P2, PR #1755). Bash runs a TERM/INT trap and then RESUMES the
  # script, so a single combined handler would drop the lock and carry on
  # through the rest of the bootstrap: another launcher could then take the
  # lock and run a second destructive `npm ci` against the same tree,
  # concurrently, which is the exact race this lock exists to prevent. Claude
  # Code killing a slow first run makes that an ordinary event, not a corner
  # case. So signals clean up and exit; only normal EXIT merely cleans up.
  trap 'rm -rf "$LOCK"' EXIT
  trap 'rm -rf "$LOCK"; exit 130' INT
  trap 'rm -rf "$LOCK"; exit 143' TERM

  # Record the owner so a later launcher can ask whether we are still alive
  # rather than inferring it from the lock's age. Written after the trap is
  # armed, so a kill in this window still releases the lock; a waiter that
  # arrives before this line sees no owner file and falls back to age, which
  # is correct because the lock is necessarily new at that point.
  lock_write_owner

  # Re-check under the lock: the process we waited on may have finished the
  # work, in which case we must not repeat the destructive `npm ci`.
  if bootstrap_needed; then
    run_bootstrap >&2
  fi

  trap - EXIT INT TERM
  rm -rf "$LOCK"
fi

exec node dist/index.js "$@"
