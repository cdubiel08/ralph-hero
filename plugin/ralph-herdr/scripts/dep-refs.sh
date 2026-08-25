#!/usr/bin/env bash
# dep-refs.sh — prose dependency references an issue's body names and the
# board's `board dep` graph does NOT record (GH-2109).
#
# Usage: dep-refs.sh ISSUE [WIRED]        WIRED = comma/space-separated numbers
#                                         already wired as blocker edges
#
# The fleet's dependency guard is exactly as complete as the dep graph, and
# that graph is sparser than the real dependency structure: dependencies get
# written in prose and only SOMETIMES get wired. Measured on this board
# 2026-08-22, roughly half the open items carried a body reference no edge
# recorded. Every one of those happened to be CLOSED, so nothing was being
# mis-spawned — a latent defect, not a live one. The first time one is OPEN,
# the fleet spawns a session onto work whose input does not exist yet, and a
# claim, a branch, a worktree and a whole /ralph:work session are spent before
# anyone notices.
#
# A prose reference is NOT a dependency — "see GH-2060 for the design" is not
# "blocked by GH-2060" — so this WILL over-report. That is why its caller
# refuses with a named override rather than filtering silently, and why every
# bound below pushes toward silence:
#
# Its sibling runs the OPPOSITE bias on purpose (GH-2135): `board
# dep-candidates NNN` is term-overlap, recall-biased, at the WRITE surfaces
# (filing, tend) — there a MISSED dependency costs a wrong parallel spawn,
# while here a false hit blocks a spawn. Two mechanisms, two biases, because
# the cost asymmetry flips between spawn and filing. Do not merge them.
#
#   * code is prose about references, not references: fenced blocks AND inline
#     spans are stripped before matching (pr-linkage-drift.sh proved the inline
#     half is not hypothetical);
#   * own-repo only — `#N`, `GH-N`, `owner/repo#N` naming THIS repo, or an
#     issue URL under it. A foreign reference cannot be a `board dep` edge on
#     this board, so reporting one would be noise forever;
#   * already-wired numbers are dropped: this line's whole subject is the
#     reference the graph does not have;
#   * a candidate must resolve to an OPEN ISSUE. `#N` also spells a pull
#     request, and a CLOSED issue is not work anything can be waiting on —
#     `repository.issue(number:)` answers both questions in one read, since it
#     returns null for a PR number;
#   * at most CAP candidates are resolved, so a reference-heavy body cannot
#     turn one guard into a burst of API calls. Past the cap is REPORTED, not
#     dropped silently.
#
# Output: one line of JSON on stdout, always. Exit 0 for every verdict; 2 on
# usage error.
#   {"ok":true,"count":0,"unwired":[],"summary":"","detail":""}
#   {"ok":true,"count":1,"unwired":[2134],"summary":"#2134","detail":""}
#   {"ok":false,"count":0,"unwired":[],"summary":"","detail":"why not"}
#
# ok=false is "NOT EVALUATED", never "no unwired references" — an unreadable
# answer rendering as a clean one is the failure this line exists to remove,
# and the caller is required to tell the two apart.
#
# Knobs: RALPH_HERDR_DEP_REF_CAP (candidates resolved, default 10).
set -euo pipefail

ISSUE="${1:-}"
WIRED_RAW="${2:-}"
if [[ -z "$ISSUE" || "$ISSUE" =~ [^0-9] ]]; then
  echo "Usage: $0 ISSUE [WIRED]" >&2
  exit 2
fi

CAP="${RALPH_HERDR_DEP_REF_CAP:-10}"
[[ "$CAP" =~ ^[0-9]+$ ]] || CAP=10

emit() { # emit <ok> <unwired-json-array> <detail>
  jq -nc --argjson ok "$1" --argjson u "$2" --arg detail "$3" '
    {ok: $ok, count: ($u | length), unwired: $u,
     summary: ($u | map("#" + tostring) | join(" ")),
     detail: $detail}'
  exit 0
}

command -v gh >/dev/null 2>&1 || emit false '[]' "gh is not on PATH — body references not checked"
command -v jq >/dev/null 2>&1 || { echo '{"ok":false,"count":0,"unwired":[],"summary":"","detail":"jq is not on PATH"}'; exit 0; }

if ! read -r OWNER REPO < <(gh repo view --json owner,name --jq '"\(.owner.login) \(.name)"' 2>/dev/null); then
  emit false '[]' "cannot resolve owner/repo (gh repo view failed)"
fi

# shellcheck disable=SC2016  # a GraphQL document, not a shell string to expand
BODY_QUERY='query($owner:String!,$repo:String!,$n:Int!){
  repository(owner:$owner,name:$repo){ issue(number:$n){ body } } }'

if ! body_json=$(jq -nc --arg q "$BODY_QUERY" --arg owner "$OWNER" --arg repo "$REPO" --argjson n "$ISSUE" \
                   '{query:$q, variables:{owner:$owner, repo:$repo, n:$n}}' \
                 | gh api graphql --input - 2>/dev/null); then
  emit false '[]' "gh api graphql failed reading the body of #$ISSUE"
fi
# GraphQL answers 200 with a top-level `errors` array and a null `data` for an
# unknown field or a short token scope. Reading that as an empty body would
# manufacture the clean answer out of a broken query.
if [[ "$(jq '(.errors // []) | length' <<<"$body_json")" -ne 0 ]]; then
  emit false '[]' "GraphQL errors reading #$ISSUE: $(jq -r '[.errors[].message] | join("; ")' <<<"$body_json")"
fi
if ! jq -e '.data.repository.issue | type == "object"' >/dev/null 2>&1 <<<"$body_json"; then
  emit false '[]' "#$ISSUE is not readable as an issue in $OWNER/$REPO"
fi
# A genuinely empty body is `null`, and there is nothing to scan in it — that
# is a real clean answer, unlike a missing `issue` object above.
BODY=$(jq -r '.data.repository.issue.body // ""' <<<"$body_json")

# Fences toggle on any line whose first non-space run is ``` or ~~~; an
# unterminated fence eats the rest of the body, which is the silent direction.
# Inline spans are removed AFTER the fence pass, never before: the span pattern
# eats the first two backticks of a ``` marker, so stripping inline first would
# leave the fence unrecognisable and disable the half that already worked.
strip_code() {
  awk '
    /^[[:space:]]*(```|~~~)/ { infence = !infence; next }
    !infence { print }
  ' | sed 's/`[^`]*`//g'
}

# Four spellings reach the same issue. The slug and URL forms are matched
# before the bare forms by being leftmost in the text, so `other/repo#7` is
# classified as foreign rather than read as a bare `#7`.
REF_RE='https?://[^[:space:]]+/issues/[0-9]+|[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+#[0-9]+|(^|[^A-Za-z0-9_-])(#|GH-)[0-9]+'

extract_refs() { # stdin -> one own-repo issue number per line
  local text hit num slug
  text=$(cat)
  grep -oiE "$REF_RE" <<<"$text" 2>/dev/null | while IFS= read -r hit; do
    num="${hit##*[^0-9]}"
    [[ -n "$num" ]] || continue
    case "$hit" in
      *"/issues/"*)
        slug="${hit%/issues/*}"; slug="${slug#*://}"; slug="${slug#*/}"
        [[ "$slug" == "$OWNER/$REPO" ]] && echo "$num"
        ;;
      *"/"*"#"*)
        slug="${hit%%#*}"; slug="${slug##*[[:space:]:]}"
        [[ "$slug" == "$OWNER/$REPO" ]] && echo "$num"
        ;;
      *) echo "$num" ;;
    esac
  done | awk '!seen[$0]++'
}

REFS=$(printf '%s\n' "$BODY" | strip_code | extract_refs || true)

# Wired edges are the graph this line is measuring the gap against, and an
# issue naming itself is not a dependency on itself.
WIRED=$(printf '%s\n' "$WIRED_RAW" | tr ',' '\n' | tr -s ' ' '\n' | grep -E '^[0-9]+$' || true)
CANDIDATES=$(printf '%s\n' "$REFS" | grep -E '^[0-9]+$' | while IFS= read -r num; do
  [[ "$num" == "$ISSUE" ]] && continue
  grep -qxF "$num" <<<"$WIRED" && continue
  echo "$num"
done || true)
[[ -n "$CANDIDATES" ]] || emit true '[]' ""

TRUNCATED=""
CHECK=""
[[ "$CAP" -gt 0 ]] && CHECK=$(printf '%s\n' "$CANDIDATES" | head -n "$CAP")
over=$(printf '%s\n' "$CANDIDATES" | sed -n "$((CAP + 1)),\$p" | grep -cE '^[0-9]+$' || true)
[[ "${over:-0}" -gt 0 ]] && TRUNCATED="$over further body reference(s) past the cap of $CAP were not resolved"
# Nothing left to resolve is a real empty answer only because the cap said so —
# and the cap is carried in `detail`, so a caller can still tell it from a body
# that named nothing.
[[ -n "$CHECK" ]] || emit true '[]' "$TRUNCATED"

# One batched read for every candidate: `repository.issue(number:)` is null for
# a pull-request number and for a number that does not exist, so one field
# answers "is this an issue?" and "is it open?" together.
ALIASES=$(printf '%s\n' "$CHECK" | while IFS= read -r num; do
  [[ -n "$num" ]] && printf '  r%s: issue(number: %s) { number state }\n' "$num" "$num"
done)
STATE_QUERY="query(\$owner:String!,\$repo:String!){ repository(owner:\$owner,name:\$repo){
$ALIASES
} }"

if ! state_json=$(jq -nc --arg q "$STATE_QUERY" --arg owner "$OWNER" --arg repo "$REPO" \
                    '{query:$q, variables:{owner:$owner, repo:$repo}}' \
                  | gh api graphql --input - 2>/dev/null); then
  emit false '[]' "gh api graphql failed resolving $(printf '%s' "$CHECK" | tr '\n' ' ')"
fi
if [[ "$(jq '(.errors // []) | length' <<<"$state_json")" -ne 0 ]]; then
  emit false '[]' "GraphQL errors resolving body references: $(jq -r '[.errors[].message] | join("; ")' <<<"$state_json")"
fi
if ! jq -e '.data.repository | type == "object"' >/dev/null 2>&1 <<<"$state_json"; then
  emit false '[]' "body-reference states are missing from the response (not an empty answer)"
fi

UNWIRED=$(jq -c '[.data.repository | to_entries[]
                  | select(.value != null and .value.state == "OPEN")
                  | .value.number] | sort' <<<"$state_json")

emit true "$UNWIRED" "$TRUNCATED"
