// The generated HERDR_BIN_PATH used by the opt-in rh live scenario.

export const RH_LIVE_SESSION = 'ralph-bdd';
export const RH_DISPATCH_LABEL = 'ralph-bdd-rh-dispatch';
export const RH_COCKPIT_LABEL = 'ralph-bdd-rh-cockpit';

export interface LiveHerdrWrapperOptions {
  realHerdr: string;
  callLog: string;
  repo: string;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function renderLiveHerdrWrapper(options: LiveHerdrWrapperOptions): string {
  return [
    '#!/bin/bash',
    'set -u',
    `REAL_HERDR=${shellQuote(options.realHerdr)}`,
    `CALL_LOG=${shellQuote(options.callLog)}`,
    `REPO=${shellQuote(options.repo)}`,
    `DISPATCH_LABEL=${shellQuote(RH_DISPATCH_LABEL)}`,
    `COCKPIT_LABEL=${shellQuote(RH_COCKPIT_LABEL)}`,
    `SESSION=${shellQuote(RH_LIVE_SESSION)}`,
    'refuse() {',
    "  echo 'herdr-ralph-bdd: refusing command outside the live rh allowlist' >&2",
    '  exit 64',
    '}',
    'valid_id() {',
    '  [ -n "${1-}" ] || return 1',
    '  case "$1" in -*) return 1 ;; *) return 0 ;; esac',
    '}',
    'for arg in "$@"; do',
    '  case "$arg" in',
    '    --session|--session=*|--no-session|--remote|--remote=*|--remote-keybindings|--remote-keybindings=*) refuse ;;',
    '  esac',
    'done',
    'allowed=0',
    'if [ "$#" -eq 1 ] && [ "$1" = server ]; then',
    '  allowed=1',
    'elif [ "$#" -eq 3 ] && [ "$1" = status ] && [ "$2" = server ] && [ "$3" = --json ]; then',
    '  allowed=1',
    'elif [ "$#" -eq 2 ] && [ "$1" = workspace ] && [ "$2" = list ]; then',
    '  allowed=1',
    'elif [ "$#" -eq 7 ] && [ "$1" = workspace ] && [ "$2" = create ] &&',
    '  [ "$3" = --cwd ] && [ "$4" = "$REPO" ] && [ "$5" = --label ] &&',
    '  [ "$6" = "$DISPATCH_LABEL" ] && [ "$7" = --no-focus ]; then',
    '  allowed=1',
    'elif [ "$#" -eq 2 ] && [ "$1" = pane ] && [ "$2" = list ]; then',
    '  allowed=1',
    'elif [ "$#" -eq 4 ] && [ "$1" = pane ] && [ "$2" = list ] &&',
    '  [ "$3" = --workspace ] && valid_id "$4"; then',
    '  allowed=1',
    'elif [ "$#" -eq 4 ] && [ "$1" = pane ] && [ "$2" = rename ] && valid_id "$3" &&',
    '  { [ "$4" = "$DISPATCH_LABEL" ] || [ "$4" = "$COCKPIT_LABEL" ]; }; then',
    '  allowed=1',
    'elif [ "$#" -eq 8 ] && [ "$1" = pane ] && [ "$2" = split ] && valid_id "$3" &&',
    '  [ "$4" = --direction ] && [ "$5" = right ] && [ "$6" = --cwd ] &&',
    '  [ "$7" = "$REPO" ] && [ "$8" = --no-focus ]; then',
    '  allowed=1',
    'elif [ "$#" -eq 4 ] && [ "$1" = plugin ] && [ "$2" = pane ] &&',
    '  [ "$3" = focus ] && valid_id "$4"; then',
    '  allowed=1',
    'fi',
    '[ "$allowed" -eq 1 ] || refuse',
    'printf \'%s\\n\' "$*" >>"$CALL_LOG"',
    'exec "$REAL_HERDR" --session "$SESSION" "$@"',
    '',
  ].join('\n');
}
