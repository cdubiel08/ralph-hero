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
set -euo pipefail

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$PLUGIN_ROOT"

if [ ! -f dist/index.js ] || [ ! -d node_modules/@huggingface ]; then
  {
    echo "[ralph-knowledge] first run: installing and building (one-time, ~1-2 min)..."
    npm ci --no-audit --no-fund
    npm run build
    npm prune --omit=dev --no-audit --no-fund
    # onnxruntime-web must remain importable (transformers.js imports it
    # statically) but its wasm payloads are never loaded under Node.
    find node_modules/onnxruntime-web -name '*.wasm' -delete 2>/dev/null || true
    echo "[ralph-knowledge] bootstrap complete."
  } >&2
fi

exec node dist/index.js "$@"
