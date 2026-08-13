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
#
# A superseded version is NOT automatically safe to delete (codex P2, PR
# #1755). An older Claude Code session left open keeps serving its MCP server
# out of its own cache directory, and that server loads JavaScript and native
# dependencies lazily for the life of the session. Deleting its root breaks it
# where it stands — an already-running session does not re-download anything.
# So in-use versions are detected, excluded from the reclaimable figure, and
# reported separately; and where in-use detection is impossible the advice
# degrades to "close other sessions first" rather than naming directories.
set -uo pipefail

WARN_MB="${RALPH_KNOWLEDGE_DISK_WARN_MB:-2048}"
STAMP="${TMPDIR:-/tmp}/ralph-knowledge-disk-guard.stamp"

# `sort -V` is GNU coreutils only — BSD/macOS sort rejects it, which would
# leave `newest` empty and make every version dir look superseded. Probe once
# and fall back to a numeric field sort on dotted versions.
if printf '' | sort -V >/dev/null 2>&1; then
  version_sort() { sort -V; }
else
  version_sort() { sort -t. -k1,1n -k2,2n -k3,3n; }
fi

# At most one scan per day.
if [ -f "$STAMP" ] && find "$STAMP" -mtime -1 2>/dev/null | grep -q .; then
  exit 0
fi
touch "$STAMP"

total_mb=0
npx_dirs=0
stale_plugin_dirs=0
in_use_dirs=0

# Legacy npx cache entries.
for d in "$HOME"/.npm/_npx/*/package.json; do
  [ -f "$d" ] || continue
  if grep -q '"ralph-hero-knowledge-index"' "$d" 2>/dev/null; then
    sz=$(du -sm "$(dirname "$d")" 2>/dev/null | cut -f1)
    total_mb=$((total_mb + ${sz:-0}))
    npx_dirs=$((npx_dirs + 1))
  fi
done

# Can this host tell us whether a directory is in use? /proc on Linux, lsof on
# macOS/BSD. When neither answers we must not claim anything is idle.
if [ -d /proc ] || command -v lsof >/dev/null 2>&1; then
  USE_PROBE=yes
else
  USE_PROBE=no
fi

# True (0) when some running process is working inside directory $1 — the
# server's cwd is its own plugin root, because launch-mcp.sh cd's there before
# exec'ing node.
dir_in_use() {
  local dir p cwd
  # Compare PHYSICAL paths. macOS symlinks /tmp and /var into /private, and
  # both /proc and lsof report the resolved path — so a literal string compare
  # against the caller's path silently never matches, and every directory would
  # look idle. That failure is invisible: the guard would simply go back to
  # calling in-use directories safe to delete.
  dir=$(cd "$1" 2>/dev/null && pwd -P) || dir="${1%/}"
  dir="${dir%/}"
  # Run the probe from / so the helpers it spawns cannot themselves be sitting
  # in the directory under test.
  (
    cd / 2>/dev/null || exit 1
    if [ -d /proc ]; then
      for p in /proc/[0-9]*; do
        cwd=$(readlink "$p/cwd" 2>/dev/null) || continue
        case "$cwd" in "$dir"|"$dir"/*) exit 0 ;; esac
      done
      exit 1
    fi
    if command -v lsof >/dev/null 2>&1; then
      lsof -d cwd -Fn 2>/dev/null | grep -q -e "^n${dir}$" -e "^n${dir}/" && exit 0
      exit 1
    fi
    exit 1
  )
}

# Superseded plugin cache versions (all but the newest per marketplace), minus
# any that a live session is still serving from.
for base in "$HOME"/.claude/plugins/cache/*/ralph-knowledge; do
  [ -d "$base" ] || continue
  newest=$(ls -1 "$base" 2>/dev/null | version_sort | tail -1)
  # Fail closed: with no orderable newest we cannot say which dirs are
  # superseded, so claim none rather than claiming all of them.
  [ -n "$newest" ] || continue
  for v in "$base"/*/; do
    [ -d "$v" ] || continue
    [ "$(basename "$v")" != "$newest" ] || continue
    if [ "$USE_PROBE" = yes ] && dir_in_use "$v"; then
      # Superseded but LIVE. Never counted as reclaimable — deleting it breaks
      # the session currently serving from it.
      in_use_dirs=$((in_use_dirs + 1))
      continue
    fi
    sz=$(du -sm "$v" 2>/dev/null | cut -f1)
    total_mb=$((total_mb + ${sz:-0}))
    stale_plugin_dirs=$((stale_plugin_dirs + 1))
  done
done

if [ "$total_mb" -ge "$WARN_MB" ]; then
  cat <<EOF
[ralph-knowledge disk guard] Reclaimable cache detected: ~${total_mb}MB
  - ${npx_dirs} legacy npx cache dir(s) under ~/.npm/_npx (from the old npx-pinned MCP wiring)
  - ${stale_plugin_dirs} superseded plugin version(s) under ~/.claude/plugins/cache
EOF
  if [ "$in_use_dirs" -gt 0 ]; then
    echo "  - ${in_use_dirs} superseded version(s) EXCLUDED: a running session is still serving from them"
  fi
  cat <<EOF
The legacy ~/.npm/_npx dirs whose package.json depends on ralph-hero-knowledge-index
are safe to delete now — nothing launches through npx any more.
EOF
  if [ "$USE_PROBE" = yes ]; then
    cat <<EOF
The superseded plugin version dirs counted above have no process running in them.
Still close any other Claude Code sessions before deleting: a session started
between this check and the delete would be broken by it, and an already-running
session does NOT re-download a removed plugin root.
EOF
  else
    cat <<EOF
This host cannot be probed for running processes, so the plugin version dirs
above are NOT confirmed idle. Close all other Claude Code sessions before
deleting any of them — an already-running session does NOT re-download a
removed plugin root, and its MCP server loads dependencies lazily for the life
of the session.
EOF
  fi
  echo "Threshold: ${WARN_MB}MB (RALPH_KNOWLEDGE_DISK_WARN_MB)."
fi

exit 0
