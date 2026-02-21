# Bash completions for the global 'ralph' command
# Source this file or add to ~/.bashrc:
#   source <path>/ralph-completions.bash

_ralph_completions() {
    local justfile="${RALPH_JUSTFILE:-}"
    if [ -z "$justfile" ]; then
        local cache_dir="$HOME/.claude/plugins/cache/ralph-hero/ralph-hero"
        if [ -d "$cache_dir" ]; then
            local latest
            latest=$(ls "$cache_dir" | sort -V | tail -1)
            justfile="$cache_dir/$latest/justfile"
        fi
    fi
    if [ ! -f "$justfile" ]; then
        return
    fi
    COMPREPLY=($(compgen -W "$(just --justfile "$justfile" --summary 2>/dev/null)" -- "${COMP_WORDS[COMP_CWORD]}"))
}
complete -F _ralph_completions ralph
