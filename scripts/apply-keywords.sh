#!/bin/bash
# Closing-keyword hygiene for apply-kind work (GH-1694, epic GH-1692).
#
# Usage: ./scripts/apply-keywords.sh PR_NUMBER
#
# For infrastructure work a merged PR is not a deployed change. Two rules:
#
#   1. APPLY-CLOSE BAN — a PR may not carry a closing keyword that binds an
#      apply-kind issue. Merging is not applying; letting the merge close the
#      apply unit is precisely the false completion this epic exists to stop.
#
#   2. INFRA-SPLIT — if the PR's diff touches the configured infra surface,
#      every issue it closes must have an apply twin (an apply-labelled
#      sub-issue, or an apply-labelled sibling under the same parent). A PR
#      that changes infrastructure and closes a ship issue with no apply twin
#      is claiming the change is live when only the code has landed.
#
# Closing issues are read from GitHub's own `closingIssuesReferences`, not from
# a regex over the PR body: GitHub honours closing keywords in COMMIT MESSAGES
# too, and a body-only check would be bypassable by accident.
#
# The twin relation is GitHub's own linkage (sub-issue / shared parent), not a
# declarative marker in the PR body. A marker the author writes is not evidence
# that the split happened.
#
# Config: the `apply` block of .github/ralph-merge-policy.json (override path
# for tests via RALPH_MERGE_POLICY_FILE) — the same file board.ts reads, so a
# repo opts in exactly once:
#
#   "apply": { "enabled": true, "label": "ralph:apply",
#              "infraPaths": [".github/**", "terraform/**"] }
#
# No apply block, or enabled != true ⇒ INERT (exit 0, one line saying so).
# An empty infraPaths list disables rule 2 only; rule 1 still applies.
#
# Output contract (merge-pr.sh and validate-attestation parse these):
#   APPLY KEYWORDS PASS — ...      [0]
#   APPLY KEYWORDS INERT — ...     [0]
#   APPLY KEYWORDS FAIL — ...      [1]
#
# Malformed policy fails CLOSED, exactly like merge-pr.sh: a truncated policy
# must not silently disable the gate it configures.

set -euo pipefail

PR_NUMBER="${1:-}"
if [[ -z "$PR_NUMBER" || "$PR_NUMBER" =~ [^0-9] ]]; then
  echo "Usage: $0 PR_NUMBER" >&2
  exit 2
fi

PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || {
  echo "APPLY KEYWORDS FAIL — not in a git repository"
  exit 1
}
POLICY_FILE="${RALPH_MERGE_POLICY_FILE:-$PROJECT_ROOT/.github/ralph-merge-policy.json}"

APPLY_LABEL="ralph:apply"
INFRA_PATHS=()

if [[ ! -f "$POLICY_FILE" ]]; then
  echo "APPLY KEYWORDS INERT — no merge policy at $POLICY_FILE"
  exit 0
fi
if ! jq -e . "$POLICY_FILE" >/dev/null 2>&1; then
  echo "APPLY KEYWORDS FAIL — merge policy file is not valid JSON: $POLICY_FILE (failing closed)"
  exit 1
fi
if [[ "$(jq -r '.apply.enabled // false | tostring' "$POLICY_FILE")" != "true" ]]; then
  echo "APPLY KEYWORDS INERT — apply kind not enabled (no \`apply\` block in $POLICY_FILE)"
  exit 0
fi
APPLY_LABEL=$(jq -r '.apply.label // "ralph:apply"' "$POLICY_FILE")
while IFS= read -r p; do
  [[ -n "$p" ]] && INFRA_PATHS+=("$p")
done < <(jq -r '(.apply.infraPaths // []) | .[] | select(type == "string")' "$POLICY_FILE")

# ---------------------------------------------------------------------------
# Closing issues + their apply-twin linkage — one GraphQL call.
#
# `parent { subIssues }` gives the SIBLINGS of a closing issue; `subIssues`
# gives its own children. Either may carry the apply twin, matching the
# decomposition rule ("a ship issue and one or more apply issues").
# ---------------------------------------------------------------------------
read -r OWNER REPO < <(gh repo view --json owner,name --jq '"\(.owner.login) \(.name)"' 2>/dev/null) || {
  echo "APPLY KEYWORDS FAIL — cannot resolve owner/repo (gh repo view failed)"
  exit 1
}

# shellcheck disable=SC2016  # a GraphQL document, not a shell string to expand
QUERY='query($owner: String!, $repo: String!, $pr: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      closingIssuesReferences(first: 50) {
        nodes {
          number
          labels(first: 30) { nodes { name } }
          subIssues(first: 50) { nodes { number labels(first: 30) { nodes { name } } } }
          parent {
            number
            subIssues(first: 50) { nodes { number labels(first: 30) { nodes { name } } } }
          }
        }
      }
    }
  }
}'

graph_json=$(jq -nc --arg q "$QUERY" --arg owner "$OWNER" --arg repo "$REPO" --argjson pr "$PR_NUMBER" \
  '{query: $q, variables: {owner: $owner, repo: $repo, pr: $pr}}' \
  | gh api graphql --input - 2>&1) || {
  echo "APPLY KEYWORDS FAIL — cannot read closing issues for PR #$PR_NUMBER (gh api graphql failed): $(head -3 <<<"$graph_json")"
  exit 1
}

# GraphQL returns exit 0 with a top-level `errors` array for an unknown field
# or an insufficient token scope, and `data` is then null. A bare
# `.nodes // []` would turn that lookup failure into "closes no issues" — a
# PASS produced by a broken query, which is the worst outcome available.
if [[ "$(jq '(.errors // []) | length' <<<"$graph_json")" -ne 0 ]]; then
  echo "APPLY KEYWORDS FAIL — GraphQL errors reading PR #$PR_NUMBER: $(jq -r '[.errors[].message] | join("; ")' <<<"$graph_json")"
  exit 1
fi
if [[ "$(jq 'if (.data.repository.pullRequest.closingIssuesReferences.nodes | type) == "array" then 1 else 0 end' <<<"$graph_json")" -ne 1 ]]; then
  echo "APPLY KEYWORDS FAIL — PR #$PR_NUMBER's closing-issue list is missing from the API response (not an empty list)"
  exit 1
fi

closing=$(jq -c '.data.repository.pullRequest.closingIssuesReferences.nodes' <<<"$graph_json")
if [[ "$(jq 'length' <<<"$closing")" -eq 0 ]]; then
  echo "APPLY KEYWORDS PASS — PR #$PR_NUMBER closes no issues"
  exit 0
fi

# --- Rule 1: apply-close ban -----------------------------------------------
banned=$(jq -r --arg L "$APPLY_LABEL" '
  [ .[] | select([.labels.nodes[]?.name] | index($L)) | "#\(.number)" ] | join(", ")
' <<<"$closing")
if [[ -n "$banned" ]]; then
  echo "APPLY KEYWORDS FAIL — PR #$PR_NUMBER carries a closing keyword binding apply-kind issue(s) $banned."
  echo "  Merging is not applying. Remove the closing keyword (say \"Refs #N\" instead); the apply unit"
  echo "  closes on a \`ralph-apply-evidence:v1\` comment once the change is actually live."
  exit 1
fi

# --- Rule 2: infra-split ----------------------------------------------------
if [[ ${#INFRA_PATHS[@]} -eq 0 ]]; then
  echo "APPLY KEYWORDS PASS — no closing keyword binds an apply unit (infraPaths empty; split rule off)"
  exit 0
fi

# Paginated, and LOUD on failure: an empty file list must not masquerade as
# "this PR touches no infrastructure" (the pr-file-classes.sh lesson).
files=$(gh api --paginate "repos/$OWNER/$REPO/pulls/$PR_NUMBER/files?per_page=100" --jq '.[].filename') || {
  echo "APPLY KEYWORDS FAIL — cannot list changed files for PR #$PR_NUMBER"
  exit 1
}

# `**` inside a `case` pattern already crosses `/` (bash globs in `case` are
# unanchored path-blind), so ".github/**" matches ".github/workflows/ci.yml".
# The one case that needs help is a leading "**/": "**/Dockerfile" should also
# match a TOP-LEVEL Dockerfile, which "*/Dockerfile" does not.
path_matches() { # path_matches <path> <glob>
  local p="$1" g="$2"
  # shellcheck disable=SC2254  # $g is a glob by design — that is the point
  case "$p" in $g) return 0 ;; esac
  if [[ "$g" == '**/'* ]]; then
    # shellcheck disable=SC2254
    case "$p" in ${g#'**/'}) return 0 ;; esac
  fi
  return 1
}

infra_hits=""
while IFS= read -r f; do
  [[ -n "$f" ]] || continue
  for g in "${INFRA_PATHS[@]}"; do
    if path_matches "$f" "$g"; then
      infra_hits="${infra_hits}$f "
      break
    fi
  done
done <<<"$files"

if [[ -z "$infra_hits" ]]; then
  echo "APPLY KEYWORDS PASS — PR #$PR_NUMBER touches no configured infra path"
  exit 0
fi

# An apply twin is an apply-labelled sub-issue of the closing issue, or an
# apply-labelled sibling under the same parent.
untwinned=$(jq -r --arg L "$APPLY_LABEL" '
  def has_apply: [.labels.nodes[]?.name] | index($L);
  [ .[]
    | select(
        ([ (.subIssues.nodes[]? | select(has_apply)),
           (.parent.subIssues.nodes[]? | select(has_apply)) ] | length) == 0
      )
    | "#\(.number)" ] | join(", ")
' <<<"$closing")

if [[ -n "$untwinned" ]]; then
  echo "APPLY KEYWORDS FAIL — PR #$PR_NUMBER touches infrastructure (${infra_hits% }) and closes $untwinned, which has no apply twin."
  echo "  A merge is not a deploy. File the apply unit and link it, then re-run:"
  echo "    board create --backlog --label $APPLY_LABEL --parent <the unit's parent> \\"
  echo "      --title 'apply: <what must become true in the real world>' --priority P1 --estimate XS"
  echo "  (or, if this diff genuinely deploys itself, drop the infra path from apply.infraPaths in $POLICY_FILE)"
  exit 1
fi

echo "APPLY KEYWORDS PASS — PR #$PR_NUMBER touches infra and every closing issue has an apply twin"
exit 0
