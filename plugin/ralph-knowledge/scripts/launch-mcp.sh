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
  else
    # No hasher: fall back to a marker that never matches, so bootstrap is
    # driven purely by the artifact checks below rather than by a false match.
    echo "no-hasher"
    return 0
  fi
  {
    node --version 2>/dev/null || echo "node-unknown"
    cat package.json package-lock.json
  } | $hasher | cut -d' ' -f1
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
  trap 'rm -rf "$LOCK"' EXIT INT TERM

  # Re-check under the lock: the process we waited on may have finished the
  # work, in which case we must not repeat the destructive `npm ci`.
  if bootstrap_needed; then
    run_bootstrap >&2
  fi

  trap - EXIT INT TERM
  rm -rf "$LOCK"
fi

exec node dist/index.js "$@"
