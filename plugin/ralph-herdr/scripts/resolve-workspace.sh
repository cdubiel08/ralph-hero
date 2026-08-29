#!/usr/bin/env bash
# resolve-workspace.sh — GH-2269: the one place every workspace-context
# action resolves its target cwd, so a wrong target is VISIBLE rather than
# spawning to completion in silence.
#
# herdr resolves `workspace_cwd` (and its `focused_pane_cwd` fallback) from
# the FOCUSED workspace — a property of where the human last clicked, never
# of the shell an `herdr plugin action invoke` was typed in, and the CLI
# gives no `--workspace`/`--cwd` to override it. A launch typed from a shell
# in one repo can therefore open its pane in whatever repo currently has
# focus. Herdr owns that resolution and this plugin cannot change it (that
# is explicitly out of scope) — so the fix is to make the resolved target
# loud before anything runs against it, not to prevent the resolution.
#
# Usage, replacing the old inline
#   cwd=$(jq -r '.workspace_cwd // .focused_pane_cwd' <<<"$HERDR_PLUGIN_CONTEXT_JSON")
# with:
#   cwd=$(bash "$HERDR_PLUGIN_ROOT/scripts/resolve-workspace.sh") || exit 1
#
# On success: prints the resolved repo scope to stderr (visible in `herdr
# plugin log`) and the resolved cwd to stdout, for the caller to capture.
# On a resolved cwd with no discoverable board config: refuses (rc 1),
# naming the resolved path on stderr, and prints NOTHING to stdout — the
# caller must not fall back to opening a pane there. That is today's
# accidental "nothing spawned, no board config" near-miss made deliberate
# (acceptance #2).
#
# Board-scope resolution mirrors board.ts's loadConfig exactly (.ralph.json,
# else .claude/settings.json's env block, wholesale per file) via the same
# _ralph_ledger_scope this plugin's ledger already reads — reused rather
# than re-derived, so this check and the ledger's cannot drift apart on what
# "a ralph-configured repo" means (the GH-1843 shape).
set -euo pipefail

_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=ledger.sh
. "$_DIR/ledger.sh"

cwd=$(jq -r '.workspace_cwd // .focused_pane_cwd // empty' <<<"${HERDR_PLUGIN_CONTEXT_JSON:-}" 2>/dev/null) || cwd=""
if [ -z "$cwd" ]; then
  echo "resolve-workspace: no workspace_cwd/focused_pane_cwd in HERDR_PLUGIN_CONTEXT_JSON — refusing to guess a target" >&2
  exit 1
fi

root="$cwd"
if [ ! -f "$root/.ralph.json" ] && [ ! -f "$root/.claude/settings.json" ]; then
  root=$(git -C "$root" rev-parse --show-toplevel 2>/dev/null) || root="$cwd"
fi

if ! scope=$(_ralph_ledger_scope "$root" 2>/dev/null); then
  echo "resolve-workspace: focused workspace '$cwd' has no board config (.ralph.json or .claude/settings.json env RALPH_GH_OWNER/RALPH_GH_REPO) — refusing to spawn here." >&2
  echo "resolve-workspace: this is the FOCUSED workspace, not the shell you invoked from — herdr resolves cwd from focus, with no --workspace/--cwd override." >&2
  echo "resolve-workspace: focus the intended repo's workspace and retry, or run the target script directly by path (e.g. bash plugin/ralph-herdr/scripts/work-fleet.sh), which uses your shell's own cwd." >&2
  exit 1
fi

echo "resolve-workspace: focused workspace '$cwd' -> board scope ${scope%% *}/${scope#* }" >&2
printf '%s\n' "$cwd"
