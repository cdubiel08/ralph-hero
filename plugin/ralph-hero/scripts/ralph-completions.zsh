# Zsh completions for the global 'ralph' command
# Source this file or add to ~/.zshrc:
#   source <path>/ralph-completions.zsh

_ralph_completions() {
    local justfile="${RALPH_JUSTFILE:-$HOME/.config/ralph-hero/justfile}"
    if [ ! -f "$justfile" ]; then
        return
    fi
    local recipes
    recipes=(${(f)"$(just --justfile "$justfile" --summary 2>/dev/null | tr ' ' '\n')"})
    compadd -a recipes
}
compdef _ralph_completions ralph
