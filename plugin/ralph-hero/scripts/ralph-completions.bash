# Bash completions for the global 'ralph' command
# Source this file or add to ~/.bashrc:
#   source <path>/ralph-completions.bash

_ralph_completions() {
    local justfile="${RALPH_JUSTFILE:-$HOME/.config/ralph-hero/justfile}"
    if [ ! -f "$justfile" ]; then
        return
    fi
    COMPREPLY=($(compgen -W "$(just --justfile "$justfile" --summary 2>/dev/null)" -- "${COMP_WORDS[COMP_CWORD]}"))
}
complete -F _ralph_completions ralph
