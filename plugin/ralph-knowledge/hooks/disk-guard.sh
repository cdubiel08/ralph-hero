#!/usr/bin/env bash
# SessionStart disk guard: warn when ralph-knowledge caches crowd the disk.
#
# Two historical sources of bloat:
#   1. ~/.npm/_npx — the pre-launcher `npx -y ralph-hero-knowledge-index@X`
#      wiring left one ~500MB-1GB dir per released version, never evicted.
#   2. ~/.claude/plugins/cache/*/ralph-knowledge — old plugin versions with
#      full node_modules (~500MB each).
#
# Emits a warning to stdout (becomes session context) when the combined
# footprint exceeds WARN_MB. Runs at most once per day (stamp file) and is
# otherwise silent so it costs sessions nothing.
set -uo pipefail

WARN_MB="${RALPH_KNOWLEDGE_DISK_WARN_MB:-2048}"
STAMP="${TMPDIR:-/tmp}/ralph-knowledge-disk-guard.stamp"

# At most one scan per day.
if [ -f "$STAMP" ] && find "$STAMP" -mtime -1 2>/dev/null | grep -q .; then
  exit 0
fi
touch "$STAMP"

total_mb=0
npx_dirs=0
stale_plugin_dirs=0

# Legacy npx cache entries.
for d in "$HOME"/.npm/_npx/*/package.json; do
  [ -f "$d" ] || continue
  if grep -q '"ralph-hero-knowledge-index"' "$d" 2>/dev/null; then
    sz=$(du -sm "$(dirname "$d")" 2>/dev/null | cut -f1)
    total_mb=$((total_mb + ${sz:-0}))
    npx_dirs=$((npx_dirs + 1))
  fi
done

# Superseded plugin cache versions (all but the newest per marketplace).
for base in "$HOME"/.claude/plugins/cache/*/ralph-knowledge; do
  [ -d "$base" ] || continue
  newest=$(ls -1 "$base" 2>/dev/null | sort -V | tail -1)
  for v in "$base"/*/; do
    [ -d "$v" ] || continue
    sz=$(du -sm "$v" 2>/dev/null | cut -f1)
    if [ "$(basename "$v")" != "$newest" ]; then
      total_mb=$((total_mb + ${sz:-0}))
      stale_plugin_dirs=$((stale_plugin_dirs + 1))
    fi
  done
done

if [ "$total_mb" -ge "$WARN_MB" ]; then
  cat <<EOF
[ralph-knowledge disk guard] Reclaimable cache detected: ~${total_mb}MB
  - ${npx_dirs} legacy npx cache dir(s) under ~/.npm/_npx (from the old npx-pinned MCP wiring)
  - ${stale_plugin_dirs} superseded plugin version(s) under ~/.claude/plugins/cache
Safe to reclaim: delete the ~/.npm/_npx dirs whose package.json depends on
ralph-hero-knowledge-index, and any plugin cache version dirs except the newest.
Everything re-downloads on demand. Threshold: ${WARN_MB}MB (RALPH_KNOWLEDGE_DISK_WARN_MB).
EOF
fi

exit 0
