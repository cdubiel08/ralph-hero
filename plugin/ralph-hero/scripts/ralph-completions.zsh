# Zsh completions for the global 'ralph' command
# Source this file or add to ~/.zshrc:
#   source <path>/ralph-completions.zsh

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
    local recipes
    recipes=(${(f)"$(just --justfile "$justfile" --summary 2>/dev/null | tr ' ' '\n')"})
    compadd -a recipes
}
compdef _ralph_completions ralph
