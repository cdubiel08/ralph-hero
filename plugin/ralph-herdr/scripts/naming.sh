#!/usr/bin/env bash
# naming.sh — grammar-B agent naming for the ralph-herdr cockpit. Sourced,
# never run (lib.sh pulls it in; tests source it standalone).
#
# Grammar B:  name = <lane><issue>-<slug>[--<gen>]
#   ^([a-z])([0-9]+)-([a-z][a-z0-9]*(-[a-z0-9]+)*)(--[2-9])?$  and <= 32 chars
#
#   lane   one char from the registry: w=work r=review o=orchestrator
#          d=disposable s=watcher x=relay. Issue 0 is reserved for infra
#          (s0-watch, x0-relay).
#   slug   lowercase alnum words, hyphen-separated, starts with a letter,
#          never contains "--" — so "--" appears ONLY before a generation
#          suffix and parse-back is unambiguous: lane = char 1, issue =
#          leading digits, slug = the rest before any --N.
#   gen    collision suffix --2..--9; 3 chars are reserved for it in the
#          slug budget so a base name can always take one within 32.
#
# Durable refs are name#epoch (ralph_agent_ref) — a pane_id is NEVER a
# durable key. The harness (claude|codex|pi) is a metadata token and never
# appears in a name.
#
# Pure functions only — no top-level side effects, no set/shopt (callers own
# their shell options), no dependency on lib.sh. bash 3.2 compatible.

# ralph_slugify TITLE — print the slug: lowercase, every non-alnum run
# (unicode bytes included) collapsed to a single hyphen, hyphens trimmed at
# both ends, leading non-letters stripped (the grammar requires a letter
# start), and an empty result falling back to "task" (a name must exist to be
# a scan key). MIRRORS contracts.ts slugify() exactly — the two planes derive
# the same name from the same title, and the shared golden table
# (ralph/contracts/examples/naming-golden.tsv) is executed by both this
# file's test suite and contracts.test.ts to keep it that way.
ralph_slugify() {
  local s
  s=$(printf '%s' "${1-}" |
    LC_ALL=C tr '[:upper:]' '[:lower:]' |
    LC_ALL=C tr -cs 'abcdefghijklmnopqrstuvwxyz0123456789' '-' |
    sed -e 's/^-*//' -e 's/-*$//' -e 's/^[^a-z]*//')
  printf '%s' "${s:-task}"
}

# _ralph_slug_budget ISSUE — chars available for the slug within a 32-char
# name: 32 - lane(1) - len(issue) - separator(1) - 3 reserved for --N.
_ralph_slug_budget() { echo $((32 - 1 - ${#1} - 1 - 3)); }

# _ralph_truncate_slug SLUG BUDGET — the spec truncation rule: keep the whole
# slug when it fits; otherwise cut at the last word boundary within BUDGET
# whose final kept word is >= 3 chars; when no such boundary exists, hard-cut
# at BUDGET. A trailing hyphen is always stripped.
_ralph_truncate_slug() {
  local slug="$1" budget="$2" prefix out last
  if [ "${#slug}" -le "$budget" ]; then
    printf '%s\n' "$slug"
    return 0
  fi
  prefix="${slug:0:$budget}"
  out="$prefix"
  # The cut is mid-word unless the NEXT char of the full slug is a hyphen
  # (prefix ends exactly at a word end) or the prefix ends with one itself.
  case "${slug:$budget:1}" in
    -) : ;;
    *) case "$out" in
         *-*) out="${out%-*}" ;; # drop the partial trailing word
         *) out="" ;;            # single word longer than the budget
       esac ;;
  esac
  out="${out%-}"
  # Word-boundary rule: the last kept word must be >= 3 chars — drop shorter
  # trailing words; consuming everything means no valid boundary exists.
  while [ -n "$out" ]; do
    case "$out" in
      *-*) last="${out##*-}" ;;
      *) last="$out" ;;
    esac
    [ "${#last}" -ge 3 ] && break
    case "$out" in
      *-*) out="${out%-*}" ;;
      *) out="" ;;
    esac
  done
  if [ -z "$out" ]; then
    out="${prefix%-}" # hard cut
  fi
  printf '%s\n' "$out"
}

# ralph_agent_name LANE ISSUE TITLE_OR_SLUG — print the grammar-B name
# <lane><issue>-<slug>. TITLE_OR_SLUG is slugified (an already-valid slug
# passes through unchanged) and truncated to the reserved-suffix budget, so
# the result always has room for a --N collision suffix within 32 chars.
# rc 1 with a stderr message on: a lane outside the registry, or a
# non-integer (or leading-zero) issue. The empty/digit-led slug refusals
# below are defense in depth — ralph_slugify's letter-start strip and "task"
# fallback make them unreachable from any title.
ralph_agent_name() {
  local lane="${1-}" issue="${2-}" slug budget
  case "$lane" in
    w | r | o | d | s | x) : ;;
    *)
      echo "ralph_agent_name: unknown lane '$lane' (registry: w r o d s x)" >&2
      return 1
      ;;
  esac
  case "$issue" in
    0 | [1-9] | [1-9][0-9]*)
      case "$issue" in
        *[!0-9]*)
          echo "ralph_agent_name: issue must be a non-negative integer (got '$issue')" >&2
          return 1
          ;;
      esac
      ;;
    *)
      echo "ralph_agent_name: issue must be a non-negative integer without leading zeros (got '$issue')" >&2
      return 1
      ;;
  esac
  slug=$(ralph_slugify "${3-}")
  case "$slug" in
    '')
      echo "ralph_agent_name: title '${3-}' slugifies to nothing — no slug" >&2
      return 1
      ;;
    [0-9]*)
      echo "ralph_agent_name: slug '$slug' must start with a letter" >&2
      return 1
      ;;
  esac
  budget=$(_ralph_slug_budget "$issue")
  if [ "$budget" -lt 1 ]; then
    echo "ralph_agent_name: issue '$issue' leaves no room for a slug within 32 chars" >&2
    return 1
  fi
  slug=$(_ralph_truncate_slug "$slug" "$budget")
  printf '%s%s-%s\n' "$lane" "$issue" "$slug"
}

# ralph_agent_name_collide NAME N — print NAME's generation-N sibling
# (--N, N in 2..9), re-truncating the slug to the reserved budget so the
# result stays within 32 chars even when NAME did not reserve the suffix
# room itself. An existing --N on NAME is replaced. rc 1 on an unparseable
# name, N outside 2..9, or a legacy gh-N name (no slug to suffix).
ralph_agent_name_collide() {
  local name="${1-}" n="${2-}" parsed lane issue slug budget
  case "$n" in
    [2-9]) : ;;
    *)
      echo "ralph_agent_name_collide: generation must be 2..9 (got '$n')" >&2
      return 1
      ;;
  esac
  parsed=$(ralph_agent_parse "$name") || {
    echo "ralph_agent_name_collide: unparseable name '$name'" >&2
    return 1
  }
  # shellcheck disable=SC2086  # intentional: parse output is space-separated
  set -- $parsed
  lane="$1" issue="$2" slug="$3"
  if [ "$slug" = "''" ]; then
    echo "ralph_agent_name_collide: legacy name '$name' has no slug to suffix" >&2
    return 1
  fi
  budget=$(_ralph_slug_budget "$issue")
  slug=$(_ralph_truncate_slug "$slug" "$budget")
  printf '%s%s-%s--%s\n' "$lane" "$issue" "$slug" "$n"
}

# ralph_agent_parse NAME — print "lane issue slug gen" space-separated;
# empty fields print as '' so the field count is stable. Accepts grammar-B
# names (lane restricted to the registry, <= 32 chars) and, for the
# transition, legacy gh-N — which parses as "w N '' ''". rc 1 (silently —
# callers probe with this) on anything else.
ralph_agent_parse() {
  local name="${1-}" re gen
  [ "${#name}" -le 32 ] || return 1
  re='^gh-([0-9]+)$'
  if [[ $name =~ $re ]]; then
    printf "w %s '' ''\n" "${BASH_REMATCH[1]}"
    return 0
  fi
  re='^([wrodsx])([0-9]+)-([a-z][a-z0-9]*(-[a-z0-9]+)*)(--([2-9]))?$'
  [[ $name =~ $re ]] || return 1
  gen="${BASH_REMATCH[6]}"
  [ -n "$gen" ] || gen="''"
  printf '%s %s %s %s\n' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}" "$gen"
}

# ralph_agent_ref NAME — print the durable ref NAME#EPOCH. EPOCH is 4
# lowercase-hex chars hashed cheaply (cksum) from spawn time + pid; it is
# what outlives a pane — pane ids are server-scoped and never durable.
# rc 1 when NAME does not parse.
ralph_agent_ref() {
  local name="${1-}" sum
  ralph_agent_parse "$name" >/dev/null || {
    echo "ralph_agent_ref: unparseable name '$name'" >&2
    return 1
  }
  sum=$(printf '%s' "$(date +%s)$$" | cksum | awk '{print $1}')
  printf '%s#%04x\n' "$name" "$((sum % 65536))"
}
