#!/bin/bash
# Closing-keyword linkage drift — the PR body is app-writable (GH-1940).
#
# Usage: ./scripts/pr-linkage-drift.sh PR_NUMBER
#
# Once a review app with write scope is installed, the pull-request BODY is no
# longer author-controlled: Greptile rewrites it in place, inserting its review
# summary between `<!-- greptile_comment -->` markers (observed on #1939, three
# marker occurrences). Any installed app with the same scope can do the same.
#
# Merge gate 6 (scripts/apply-keywords.sh) deliberately reads GitHub's own
# `closingIssuesReferences` rather than regexing the body, and that is right —
# GitHub honours closing keywords in commit messages too, so a body-only check
# is bypassable by accident. But `closingIssuesReferences` is DERIVED from the
# body (and from commit messages), so the gate's input is downstream of a field
# a third party can rewrite.
#
# The property everything rests on — "a third-party app preserves the author's
# closing keywords when it rewrites the body" — is current observed behaviour
# of an external service, contracted nowhere, and SILENT if it ever changes. A
# dropped `Closes #NNNN` unlinks the PR; gate 6 then evaluates a PR that closes
# nothing and passes it, the merge folds nothing back into the board, and the
# issue simply stays open. The benign reading (the author never linked it) and
# the significant one (an app deleted the linkage) render identically.
#
# This script tells them apart, and does nothing else. It asserts the invariant
# where it is cheap: every closing keyword still VISIBLE in the body or in the
# commit messages must appear in GitHub's derived linkage. A keyword that is
# present in the text and absent from the linkage is drift.
#
# IT IS NOT A GATE. It changes no verdict and blocks no merge — the judgment
# stays with the driver, the same split GH-1945 settled for advisory findings.
# The only thing being fixed is the invisibility.
#
# Biased toward silence, because a false alarm on a non-gating advisory line is
# the expensive way to be wrong and a missed hint is the cheap one:
#   - keywords inside fenced code blocks are stripped before matching (a body
#     quoting `Closes #123` in an example is not a link);
#   - only OWN-REPO references count — a bare `#N`, an `owner/repo#N` naming
#     this repo, or an issue URL under this repo. GitHub does not create
#     closing linkage across repositories, so a foreign reference is expected
#     to be absent and would be pure noise;
#   - a candidate is confirmed to be a real ISSUE before it is reported. `#N`
#     is also how a pull request is written, and a PR number can never appear
#     in closingIssuesReferences — reporting one would be a permanent false
#     positive on any body that cross-references another PR;
#   - at most CANDIDATE_CAP candidates are verified, so a reference-heavy body
#     cannot turn one advisory line into a burst of API calls. Anything past
#     the cap is reported as uncounted rather than dropped silently.
#
# `where` is the load-bearing field, not the count. A keyword the COMMITS still
# carry while the BODY has lost it is the signature of a body rewrite — the
# author wrote it once into both, and only the app-writable copy is gone.
#
# Output: one line of JSON on stdout, always. Exit 0 for every verdict; 2 on
# usage error.
#   {"ok":true,"count":0,"drift":[],"summary":"","detail":""}
#   {"ok":true,"count":1,"drift":[{"issue":1893,"where":"commits"}],
#    "summary":"#1893 (keyword in commits, not in the body)","detail":""}
#   {"ok":false,"count":0,"drift":[],"summary":"","detail":"why not"}
# ok=false is "not evaluated", never "no drift": an unreadable answer rendering
# as a clean one is the exact failure mode this line exists to remove.

set -euo pipefail

PR_NUMBER="${1:-}"
if [[ -z "$PR_NUMBER" || "$PR_NUMBER" =~ [^0-9] ]]; then
  echo "Usage: $0 PR_NUMBER" >&2
  exit 2
fi

CANDIDATE_CAP="${RALPH_LINKAGE_DRIFT_CAP:-5}"

emit() { # emit <ok> <drift-json-array> <detail>
  jq -nc --argjson ok "$1" --argjson d "$2" --arg detail "$3" '
    {ok: $ok, count: ($d | length), drift: $d,
     summary: ($d | map("#\(.issue) (keyword in \(.where), not in GitHub'"'"'s linkage)") | join(", ")),
     detail: $detail}'
  exit 0
}

if ! read -r OWNER REPO < <(gh repo view --json owner,name --jq '"\(.owner.login) \(.name)"' 2>/dev/null); then
  emit false '[]' "cannot resolve owner/repo (gh repo view failed)"
fi

# shellcheck disable=SC2016  # a GraphQL document, not a shell string to expand
QUERY='query($owner:String!,$repo:String!,$pr:Int!){
  repository(owner:$owner,name:$repo){ pullRequest(number:$pr){
    body
    closingIssuesReferences(first:50){ nodes{ number } }
    commits(first:100){
      pageInfo{ hasNextPage }
      nodes{ commit{ messageHeadline messageBody } }
    }
  } } }'

if ! pr_json=$(jq -nc --arg q "$QUERY" --arg owner "$OWNER" --arg repo "$REPO" --argjson pr "$PR_NUMBER" \
                 '{query:$q, variables:{owner:$owner, repo:$repo, pr:$pr}}' \
               | gh api graphql --input - 2>/dev/null); then
  emit false '[]' "gh api graphql failed for PR #$PR_NUMBER"
fi
# GraphQL answers 200 with a top-level `errors` array and a null `data` for an
# unknown field or a short token scope. Reading that as "closes nothing" would
# manufacture the clean answer from a broken query.
if [[ "$(jq '(.errors // []) | length' <<<"$pr_json")" -ne 0 ]]; then
  emit false '[]' "GraphQL errors: $(jq -r '[.errors[].message] | join("; ")' <<<"$pr_json")"
fi
if ! jq -e '.data.repository.pullRequest.closingIssuesReferences.nodes | type == "array"' \
     >/dev/null 2>&1 <<<"$pr_json"; then
  emit false '[]' "PR #$PR_NUMBER's closing-issue list is missing from the response (not an empty list)"
fi

LINKED=$(jq -c '[.data.repository.pullRequest.closingIssuesReferences.nodes[].number]' <<<"$pr_json")

# More than 100 commits: the commit half of the text is incomplete, so a
# keyword present only in commit 101 would read as drift-free. Report the whole
# thing as not evaluated rather than half of it as clean.
if [[ "$(jq -r '.data.repository.pullRequest.commits.pageInfo.hasNextPage' <<<"$pr_json")" == "true" ]]; then
  emit false '[]' "more than 100 commits on PR #$PR_NUMBER — keyword text incomplete"
fi

BODY=$(jq -r '.data.repository.pullRequest.body // ""' <<<"$pr_json")
COMMIT_TEXT=$(jq -r '[.data.repository.pullRequest.commits.nodes[].commit
                      | ((.messageHeadline // "") + "\n" + (.messageBody // ""))] | join("\n")' <<<"$pr_json")

# Fenced code blocks are prose about keywords, not keywords. Toggle on any line
# whose first non-space run is a ``` or ~~~ fence; an unterminated fence eats
# the rest of the body, which is the silent direction.
strip_fences() {
  awk '
    /^[[:space:]]*(```|~~~)/ { infence = !infence; next }
    !infence { print }
  '
}

# Own-repo references only. Three spellings reach the same issue: `#N`,
# `owner/repo#N` for THIS repo, and an issue URL under this repo. A foreign
# `other/repo#N` never produces closing linkage, so it is dropped rather than
# reported as drift forever.
CLOSE_RE='(^|[^A-Za-z])(close[sd]?|fix(es|ed)?|resolve[sd]?)[[:space:]]*:?[[:space:]]*(#|[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+#|https?://[^[:space:]]+/issues/)[0-9]+'

extract_refs() { # stdin -> one own-repo issue number per line
  local text
  text=$(cat)
  grep -oiE "$CLOSE_RE" <<<"$text" 2>/dev/null | while IFS= read -r hit; do
    local num slug
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

BODY_REFS=$(printf '%s\n' "$BODY" | strip_fences | extract_refs || true)
COMMIT_REFS=$(printf '%s\n' "$COMMIT_TEXT" | extract_refs || true)

CANDIDATES=$(printf '%s\n%s\n' "$BODY_REFS" "$COMMIT_REFS" | grep -E '^[0-9]+$' | awk '!seen[$0]++' || true)
[[ -n "$CANDIDATES" ]] || emit true '[]' ""

DRIFT='[]'
TRUNCATED=""
seen_count=0
while IFS= read -r num; do
  [[ -n "$num" ]] || continue
  jq -e --argjson n "$num" 'index($n) != null' >/dev/null <<<"$LINKED" && continue
  seen_count=$((seen_count + 1))
  if [[ "$seen_count" -gt "$CANDIDATE_CAP" ]]; then
    TRUNCATED="more than $CANDIDATE_CAP unlinked candidates — only the first $CANDIDATE_CAP verified"
    break
  fi
  # A `#N` is also how a pull request is spelled, and a PR can never appear in
  # closingIssuesReferences. Verify before reporting; an unreadable answer
  # drops the candidate, since a non-gating line may not shout on a guess.
  issue_json=$(gh api "repos/$OWNER/$REPO/issues/$num" 2>/dev/null) || continue
  jq -e 'has("pull_request") | not' >/dev/null 2>&1 <<<"$issue_json" || continue

  where="body"
  in_body=$(grep -qxF "$num" <<<"$BODY_REFS" && echo yes || echo no)
  in_commits=$(grep -qxF "$num" <<<"$COMMIT_REFS" && echo yes || echo no)
  if [[ "$in_body" == "yes" && "$in_commits" == "yes" ]]; then
    where="the body and the commits"
  elif [[ "$in_commits" == "yes" ]]; then
    where="the commits but NOT the body"
  else
    where="the body"
  fi
  DRIFT=$(jq -c --argjson n "$num" --arg w "$where" '. + [{issue:$n, where:$w}]' <<<"$DRIFT")
done <<<"$CANDIDATES"

emit true "$DRIFT" "$TRUNCATED"
