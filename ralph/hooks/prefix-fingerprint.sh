#!/usr/bin/env bash
# prefix-fingerprint — UserPromptSubmit OBSERVATION (GH-2349, design record
# thoughts/shared/plans/2026-09-01-worker-token-economics.md finding 4).
#
# 120 model calls across the worker fleet showed a full-context cache rewrite
# at a turn boundary (16.1M tokens, $160-320) with no compaction and no TTL
# expiry to explain it. The transcript stores `usage`, never the PROMPT, so
# the byte that moved is unrecoverable after the fact from anything on disk.
# This hook is the only place that can see it: it runs BEFORE the call, so it
# fingerprints the inputs rendered ahead of the transcript on every turn —
# the CLAUDE.md chain, MEMORY.md, installed plugin versions, the MCP server
# config, permission mode — and appends one `prefix` fact per turn to the
# ralph-herdr ledger, keyed by `claude_session` (the same key the GH-2347
# `usage` fact already carries). A later reader joins the two by session and
# time: a `cache_creation_input_tokens` spike lands beside the prefix fact
# whose hash changed since the previous turn, naming the input that moved.
#
# NEVER EXITS NON-ZERO, same discipline as every hook in this directory. This
# one goes further than a courtesy funnel: on the genuinely-applicable path
# (a ralph-configured, ledger-capable repo) a recording failure is reported
# on stderr rather than swallowed — `ralph_ledger_append` already does this
# internally — because a silent gap in telemetry is a defect nobody would
# ever notice. Every path that is a routine "not applicable" (no git repo, no
# ralph board config, no ralph-herdr plugin installed, no jq/sqlite3/hasher)
# stays silent on both streams, matching every other hook here: this fires on
# EVERY user turn, and a stderr line per turn in every host repo that hasn't
# opted into the herdr ledger would be its own kind of noise.
#
# Cross-plugin by construction, not by accident: the ledger this hook writes
# to belongs to the ralph-herdr HERDR plugin, not to the portable `ralph`
# plugin this hook ships in. Its library is resolved from the USER's trust
# boundary only — $RALPH_HERDR_SCRIPTS_DIR (the explicit override
# herdr-setup.sh already honours), else herdr's own plugin registry
# (${XDG_CONFIG_HOME:-~/.config}/herdr/plugins.json → plugin_root, the same
# read herdr-setup.sh makes). NEVER the repository tree: this hook fires on
# every prompt in every checkout the user opens, so sourcing
# `<repo>/plugin/ralph-herdr/scripts/ledger.sh` would hand any cloned repo
# arbitrary code execution as the user (Greptile P1 on #2394). Every file
# under the repo is read as DATA here (jq, cat, hash) — the same rule the
# funnels keep. ralph_ledger_path's scope resolution is a pure function of the
# board config, so no herdr session and no HERDR_ENV is required to resolve
# where the ledger lives; a machine with no ralph-herdr plugin installed has
# nothing to write to, and this hook is a silent no-op there.
#
# Honest limits, stated rather than hidden:
#   - The CLAUDE.md chain is hashed as ONE combined blob, not per file. This
#     hook can say "the CLAUDE.md chain changed", never which file in it did.
#   - The MCP surface cannot be read live (no handshake from a hook) — this
#     hashes the two CONFIG inputs that determine it: the project's .mcp.json
#     and which plugins are enabled (a plugin can bundle an MCP server, and
#     enabledPlugins is what turns it on for this session). A live server
#     that silently changes its own tool list without either input moving is
#     invisible here, same as it would be to any other observer.
#   - MEMORY.md is resolved via the worktree's git-common-dir (the ORIGINAL
#     checkout worktrees share their auto-memory identity with), never via
#     this session's own cwd — a worktree's own slug(cwd) project directory
#     carries no memory/ subdirectory at all.
set -uo pipefail

INPUT=$(cat) || exit 0
SID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)
CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)
PMODE=$(printf '%s' "$INPUT" | jq -r '.permission_mode // empty' 2>/dev/null)
PROMPT_ID=$(printf '%s' "$INPUT" | jq -r '.prompt_id // empty' 2>/dev/null)
[ -n "$SID" ] && [ -n "$CWD" ] || exit 0

if command -v shasum >/dev/null 2>&1; then
  HASHER=(shasum -a 256)
elif command -v sha256sum >/dev/null 2>&1; then
  HASHER=(sha256sum)
else
  exit 0
fi
_hash() { "${HASHER[@]}" 2>/dev/null | awk '{print substr($1,1,16)}'; }

command -v jq >/dev/null 2>&1 || exit 0
command -v sqlite3 >/dev/null 2>&1 || exit 0

ROOT=$(git -C "$CWD" rev-parse --show-toplevel 2>/dev/null) || exit 0

# Ralph scope, same precedence as board.ts loadConfig (mirrors hint-pr-linkage
# and the funnels): no board config discoverable => not our repo => silent.
CONF="$ROOT/.ralph.json"
[ -f "$CONF" ] || CONF="$ROOT/.claude/settings.json"
[ -f "$CONF" ] || exit 0

# The ledger library, from the user's trust boundary only (see header) —
# never from $ROOT. Absent on a machine with no ralph-herdr plugin: silent
# no-op, never a loud "not installed" line on every turn.
LEDGER_LIB=""
if [ -n "${RALPH_HERDR_SCRIPTS_DIR:-}" ]; then
  LEDGER_LIB="$RALPH_HERDR_SCRIPTS_DIR/ledger.sh"
else
  REGISTRY="${RALPH_HERDR_PLUGINS_JSON:-${XDG_CONFIG_HOME:-$HOME/.config}/herdr/plugins.json}"
  [ -f "$REGISTRY" ] || exit 0
  PLUGIN_ROOT=$(jq -r 'if type == "array" then map(select(.plugin_id == "ralph-herdr")) | .[0].plugin_root // empty else empty end' "$REGISTRY" 2>/dev/null)
  [ -n "$PLUGIN_ROOT" ] || exit 0
  LEDGER_LIB="$PLUGIN_ROOT/scripts/ledger.sh"
fi
[ -f "$LEDGER_LIB" ] || exit 0
# shellcheck source=/dev/null
. "$LEDGER_LIB" 2>/dev/null || exit 0
command -v ralph_ledger_path >/dev/null 2>&1 || exit 0
command -v ralph_ledger_append >/dev/null 2>&1 || exit 0

CFG_HOME="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"

# --- claude_md: the global CLAUDE.md plus every CLAUDE.md between the
# worktree root and this session's cwd, root-first, combined into one hash.
CLAUDE_MD_BLOB=""
GLOBAL_MD="$CFG_HOME/CLAUDE.md"
if [ -f "$GLOBAL_MD" ]; then
  CONTENT=$(cat "$GLOBAL_MD" 2>/dev/null)
  CLAUDE_MD_BLOB="${CLAUDE_MD_BLOB}--- ${GLOBAL_MD} ---
${CONTENT}
"
fi

DIRS=("$ROOT")
REL="${CWD#"$ROOT"}"
REL="${REL#/}"
if [ -n "$REL" ] && [ "$REL" != "$CWD" ]; then
  CUR="$ROOT"
  IFS='/' read -r -a PARTS <<<"$REL" || PARTS=()
  for P in "${PARTS[@]}"; do
    [ -n "$P" ] || continue
    CUR="$CUR/$P"
    DIRS+=("$CUR")
  done
fi
for D in "${DIRS[@]}"; do
  F="$D/CLAUDE.md"
  [ -f "$F" ] || continue
  CONTENT=$(cat "$F" 2>/dev/null)
  CLAUDE_MD_BLOB="${CLAUDE_MD_BLOB}--- ${F} ---
${CONTENT}
"
done
CLAUDE_MD_HASH=$(printf '%s' "$CLAUDE_MD_BLOB" | _hash)

# --- memory_md: resolved via the git-common-dir's parent (see header) ---
COMMON=$(git -C "$CWD" rev-parse --git-common-dir 2>/dev/null) || COMMON=""
if [ -n "$COMMON" ]; then
  case "$COMMON" in
    /*) : ;;
    *) COMMON="$CWD/$COMMON" ;;
  esac
  PROJ_DIR=$(cd "$(dirname "$COMMON")" 2>/dev/null && pwd)
  [ -n "$PROJ_DIR" ] || PROJ_DIR="$CWD"
else
  PROJ_DIR="$CWD"
fi
SLUG=$(printf '%s' "$PROJ_DIR" | LC_ALL=C tr -c 'A-Za-z0-9' '-')
MEMORY_MD="$CFG_HOME/projects/$SLUG/memory/MEMORY.md"
if [ -f "$MEMORY_MD" ]; then
  MEMORY_HASH=$(_hash <"$MEMORY_MD")
else
  MEMORY_HASH=$(printf 'absent' | _hash)
fi

# --- plugins: installed name=version pairs, sorted ---
PLUGINS_FILE="$CFG_HOME/plugins/installed_plugins.json"
if [ -f "$PLUGINS_FILE" ]; then
  PLUGINS_HASH=$(jq -r '(.plugins // {}) | to_entries
    | map("\(.key)=\(.value[-1].version // "")") | sort | join(",")' "$PLUGINS_FILE" 2>/dev/null | _hash)
else
  PLUGINS_HASH=""
fi

# --- mcp_tools: the project's .mcp.json plus which plugins are enabled
# (user settings, project settings can override) — see the header's honest
# limit on why this is a config proxy, never the live handshake.
MCP_BLOB=""
for F in "$ROOT/.mcp.json" "$CFG_HOME/settings.json" "$ROOT/.claude/settings.json"; do
  [ -f "$F" ] || continue
  PART=$(jq -c '{mcpServers: (.mcpServers // {}), enabledPlugins: (.enabledPlugins // {})}' "$F" 2>/dev/null)
  [ -n "$PART" ] || continue
  [ "$PART" = '{"mcpServers":{},"enabledPlugins":{}}' ] && continue
  MCP_BLOB="${MCP_BLOB}${F}=${PART}
"
done
MCP_HASH=$(printf '%s' "$MCP_BLOB" | _hash)

# --- permission_mode ---
PMODE_HASH=$(printf '%s' "$PMODE" | _hash)

TS=$(date -u +%FT%TZ)
RECORD=$(jq -nc \
  --arg ts "$TS" \
  --arg sid "$SID" \
  --arg pid "$PROMPT_ID" \
  --arg pmode "$PMODE" \
  --arg cmd "$CLAUDE_MD_HASH" \
  --arg mem "$MEMORY_HASH" \
  --arg plg "$PLUGINS_HASH" \
  --arg mcp "$MCP_HASH" \
  --arg pmh "$PMODE_HASH" \
  '{ts: $ts, ev: "prefix", claude_session: $sid, prompt_id: $pid, via: "hook",
    permission_mode: $pmode,
    hashes: {claude_md: $cmd, memory_md: $mem, plugins: $plg, mcp_tools: $mcp, permission_mode: $pmh}}' \
  2>/dev/null)
[ -n "$RECORD" ] || exit 0

LEDGER=$(ralph_ledger_path "$ROOT" 2>/dev/null) || exit 0
RALPH_HERDR_LEDGER="$LEDGER" ralph_ledger_append "$RECORD" >/dev/null

exit 0
