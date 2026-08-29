#!/usr/bin/env bash
# rh-owned rendering. Delegated board output never passes through this file.

rh_render_help() {
  case "${1:-}" in
    ""|rh)
      cat <<'EOF'
Usage: rh [--color=auto|always|never] COMMAND [ARGS...]

Commands:
  board <args...>       Run the existing board CLI unchanged
  dispatch              Show dispatch status
  dispatch up           Ensure dispatch prerequisites
  dispatch day          Start the configured day
  day                   Alias for "rh dispatch day"
  cockpit               Open the Ralph cockpit
  team EPIC             Ensure one named epic team
  fleet                 Show fleet status
  inbox                 Show operator attention items
  doctor                Diagnose Ralph and Herdr setup
  help [COMMAND]        Show command help
  version               Show the rh version

Run "rh help COMMAND" for command-specific help.
EOF
      ;;
    board)
      printf '%s\n' 'Usage: rh board <existing-board-args...>'
      ;;
    *)
      echo "rh: unknown help topic '$1'; run 'rh help'" >&2
      return 64
      ;;
  esac
}
