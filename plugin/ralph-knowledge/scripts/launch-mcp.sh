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
  npm ci --no-audit --no-fund
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

if bootstrap_needed; then
  waited=0
  until mkdir "$LOCK" 2>/dev/null; do
    # Reclaim a lock abandoned by a killed process.
    if [ -n "$(find "$LOCK" -maxdepth 0 -mmin "+${LOCK_STALE_MIN}" 2>/dev/null)" ]; then
      echo "[ralph-knowledge] removing stale bootstrap lock ($LOCK)" >&2
      rm -rf "$LOCK"
      continue
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

  # Re-check under the lock: the process we waited on may have finished the
  # work, in which case we must not repeat the destructive `npm ci`.
  if bootstrap_needed; then
    run_bootstrap >&2
  fi

  trap - EXIT INT TERM
  rm -rf "$LOCK"
fi

exec node dist/index.js "$@"
