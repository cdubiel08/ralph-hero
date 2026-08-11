#!/usr/bin/env bash
# herdr-context — SessionStart observation. When this session is hosted in a
# herdr pane (HERDR_ENV=1 — the ralph-herdr cockpit), emit ONE orientation
# line; SessionStart stdout becomes session context. Outside herdr it is a
# strict no-op: exit 0, no output, stdin untouched. Like every hook here it
# is NOT enforcement — the reference doc and the skills carry the real
# guidance; this line only makes a cockpit-hosted session look before it
# leaps. NEVER exits non-zero.
set -euo pipefail

[ "${HERDR_ENV:-}" = "1" ] || exit 0

# CLAUDE_PLUGIN_ROOT is exported to hook processes; fall back to this script's
# own location (hooks/ and skills/ are siblings under the plugin root).
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

echo "cockpit-hosted session (herdr): self-report lifecycle at the natural checkpoints via the pane state token — herdr pane report-metadata \"\$HERDR_PANE_ID\" --source ralph-herdr --token state=<working|blocked|reporting>; herdr reference: $PLUGIN_ROOT/skills/work/references/herdr-api.md; escalations must be phone-answerable (first line <=240 chars stating the decision, enumerated options with one recommended default)."
exit 0
