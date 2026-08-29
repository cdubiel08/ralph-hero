#!/usr/bin/env bash
# install-rh — install Ralph Hero's portable `rh` command shim.
set -euo pipefail

bin_dir="${XDG_BIN_HOME:-${HOME:?HOME must be set when XDG_BIN_HOME is unset}/.local/bin}"

usage() {
  echo "usage: install-rh.sh [--bin-dir DIR]" >&2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --bin-dir)
      [ "$#" -ge 2 ] || {
        usage
        exit 64
      }
      bin_dir="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      usage
      exit 64
      ;;
  esac
done

mkdir -p "$bin_dir"
target="$bin_dir/rh"

refuse_target() {
  echo "install-rh: refusing to replace unrelated executable $target" >&2
  echo "install-rh: choose another directory: bash $0 --bin-dir <directory>" >&2
  exit 1
}

# Never follow a foreign filesystem object while deciding ownership. In
# particular, -e is false for a dangling symlink, -f follows a live symlink,
# and grep on a FIFO blocks waiting for a writer.
if [ -L "$target" ]; then
  refuse_target
fi
if [ -e "$target" ]; then
  [ -f "$target" ] || refuse_target
  grep -Fqx '# ralph-hero-rh-shim:v1' "$target" 2>/dev/null || refuse_target
fi

temporary="$(mktemp "$bin_dir/.rh.XXXXXX")"
trap 'rm -f "$temporary"' EXIT
cat >"$temporary" <<'SHIM'
#!/usr/bin/env bash
# ralph-hero-rh-shim:v1
# Resolve Ralph at invocation time so this command survives plugin upgrades.
set -euo pipefail

if [ -n "${RALPH_RH_ENTRYPOINT:-}" ]; then
  if [ -x "$RALPH_RH_ENTRYPOINT" ]; then
    exec "$RALPH_RH_ENTRYPOINT" "$@"
  fi
  echo "rh: RALPH_RH_ENTRYPOINT is not executable: $RALPH_RH_ENTRYPOINT" >&2
  exit 69
fi

git_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -n "$git_root" ] && [ -x "$git_root/ralph/scripts/rh" ]; then
  exec "$git_root/ralph/scripts/rh" "$@"
fi

config_dir="${CLAUDE_CONFIG_DIR:-${HOME:-}/.claude}"
registry="${RALPH_INSTALLED_PLUGINS_FILE:-$config_dir/plugins/installed_plugins.json}"

version_is_newer() {
  local candidate="$1"
  local incumbent="$2"
  local candidate_core="${candidate%%[-+]*}"
  local incumbent_core="${incumbent%%[-+]*}"
  local candidate_part
  local incumbent_part

  while [ -n "$candidate_core" ] || [ -n "$incumbent_core" ]; do
    candidate_part="${candidate_core%%.*}"
    incumbent_part="${incumbent_core%%.*}"
    case "$candidate_part" in ""|*[!0-9]*) candidate_part=0 ;; esac
    case "$incumbent_part" in ""|*[!0-9]*) incumbent_part=0 ;; esac
    if [ "$candidate_part" -gt "$incumbent_part" ]; then
      return 0
    fi
    if [ "$candidate_part" -lt "$incumbent_part" ]; then
      return 1
    fi
    candidate_core="${candidate_core#*.}"
    incumbent_core="${incumbent_core#*.}"
    [ "$candidate_part" = "$candidate_core" ] && candidate_core=""
    [ "$incumbent_part" = "$incumbent_core" ] && incumbent_core=""
  done
  return 1
}

if [ -r "$registry" ] && command -v jq >/dev/null 2>&1; then
  best=""
  best_version=""
  while IFS=$'\t' read -r version path; do
    [ -x "$path" ] || continue
    if [ -z "$best" ] || version_is_newer "$version" "$best_version"; then
      best="$path"
      best_version="$version"
    fi
  done < <(jq -r '
      (.plugins // {}) | to_entries[]
      | select((.key | split("@")[0]) == "ralph")
      | .value[]? | select(.installPath != null)
      | ((.version // "0") + "\t" + .installPath + "/scripts/rh")' "$registry" 2>/dev/null)
  if [ -n "$best" ]; then
    exec "$best" "$@"
  fi
fi

best=""
best_version=""
for path in "$config_dir"/plugins/cache/*/ralph/*/scripts/rh; do
  [ -x "$path" ] || continue
  version="${path%/scripts/rh}"
  version="${version##*/}"
  if [ -z "$best" ] || version_is_newer "$version" "$best_version"; then
    best="$path"
    best_version="$version"
  fi
done
if [ -n "$best" ]; then
  echo "rh: plugin registry unreadable ($registry) — using the newest cached install (a guess, not a record): $best" >&2
  exec "$best" "$@"
fi

echo "rh: no executable Ralph entrypoint found (registry: $registry) — install the ralph Claude Code plugin, then rerun." >&2
exit 69
SHIM
chmod +x "$temporary"
mv -f "$temporary" "$target"
trap - EXIT

echo "install-rh: installed $target"
case ":${PATH:-}:" in
  *":$bin_dir:"*) ;;
  *) printf 'export PATH="%s:$PATH"\n' "$bin_dir" ;;
esac
