#!/usr/bin/env bash
# ralph-hero/hooks/scripts/load-team-soul.sh
#
# TRIGGER:       SessionStart
# EXPECTED ENV:  RALPH_COMMAND — set by set-skill-env.sh in each team skill's
#                frontmatter (e.g. "set-skill-env.sh RALPH_COMMAND=hero").
#                CLAUDE_ENV_FILE — standard Claude Code SessionStart env file
#                (may be unset when invoked outside a hook context).
#
# EXIT SEMANTICS: Always exits 0. Never fails the session.
#                 - When RALPH_COMMAND is unset or empty: silent exit 0.
#                   No stdout. No $CLAUDE_ENV_FILE mutation.
#                 - When the candidate SOUL file does not exist: silent exit 0.
#                   No stdout. No $CLAUDE_ENV_FILE mutation.
#                 - When a SOUL file is found: emits JSON envelope on stdout
#                   (see OUTPUT CONTRACT below) and optionally appends a line
#                   to $CLAUDE_ENV_FILE (see SIDE EFFECT below).
#
# OUTPUT CONTRACT:
#   When a SOUL is loaded, emits a JSON object on stdout:
#     { "hookSpecificOutput": { "hookEventName": "SessionStart",
#                               "additionalContext": "<SOUL body>" } }
#   The Claude Code runtime parses this JSON and injects "additionalContext"
#   into the model's system context for the session. Raw cat of the SOUL file
#   to stdout is NOT sufficient — it is ignored by the runtime. This pattern
#   mirrors plugin/ralph-hero/hooks/scripts/superpowers-bridge-session.sh.
#
# SIDE EFFECT:
#   When a SOUL is loaded and $CLAUDE_ENV_FILE is set and non-empty, appends:
#     export RALPH_SOUL_LOADED=<team>
#   where <team> is the value of $RALPH_COMMAND (the skill directory name,
#   e.g. "hero", not the plural team name from the SOUL frontmatter).
#   Downstream hooks (Features B/C/F/G) can assert SOUL injection occurred by
#   checking $RALPH_SOUL_LOADED. Mirrors the RALPH_SUPERPOWERS_BRIDGE=true
#   precedent in superpowers-bridge-session.sh.
#
# RUNTIME DEPENDENCY: jq must be on $PATH.
#   set -euo pipefail means a jq failure (e.g. unicode parse error, jq not
#   found) surfaces as a non-zero exit, which Claude Code treats as a hook
#   error and surfaces to the user rather than silently succeeding with no
#   output. This is the desired behavior for a hard dependency.
#
# WIRING: Per-skill frontmatter only. Do NOT add to plugin-level hooks.json.
#   Each team skill wires this in its SessionStart block alongside
#   set-skill-env.sh, so RALPH_COMMAND is already set when load-team-soul.sh
#   runs. Example (hero/SKILL.md frontmatter):
#     SessionStart:
#       - matcher: ""
#         hooks:
#           - { type: command, command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh RALPH_COMMAND=hero" }
#           - { type: command, command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/load-team-soul.sh" }
#
# REFERENCES:
#   Schema:   plugin/ralph-hero/skills/shared/soul-schema.md
#   Pattern:  plugin/ralph-hero/hooks/scripts/superpowers-bridge-session.sh

set -euo pipefail

# Resolve CLAUDE_PLUGIN_ROOT so this works as a registered hook (where the
# runtime sets CLAUDE_PLUGIN_ROOT) and when invoked manually for testing.
CLAUDE_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

# No-op when RALPH_COMMAND is unset or empty.
if [[ -z "${RALPH_COMMAND:-}" ]]; then
  exit 0
fi

# Resolve the candidate SOUL path.
SOUL_PATH="${CLAUDE_PLUGIN_ROOT}/skills/${RALPH_COMMAND}/SOUL.md"

# No-op when the SOUL file does not exist.
if [[ ! -f "$SOUL_PATH" ]]; then
  exit 0
fi

# Emit JSON envelope with SOUL body as additionalContext.
# jq -n --arg ctx prevents shell quoting issues with multi-line content.
# This is the canonical SessionStart context-injection pattern — see
# superpowers-bridge-session.sh:44-49 for the reference implementation.
jq -n --arg ctx "$(cat "$SOUL_PATH")" '{
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: $ctx
  }
}'

# Append RALPH_SOUL_LOADED to CLAUDE_ENV_FILE when the env file is available.
# This lets downstream hooks (Features B/C/F/G) detect SOUL injection.
if [[ -n "${CLAUDE_ENV_FILE:-}" ]]; then
  echo "export RALPH_SOUL_LOADED=${RALPH_COMMAND}" >> "$CLAUDE_ENV_FILE"
fi

exit 0
