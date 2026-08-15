#!/usr/bin/env bash
# scripts/publish-apply-keywords-status.sh PR_NUMBER
#
# Runs gate 6 (scripts/apply-keywords.sh) and republishes the verdict as the
# head-bound `ralph-apply-keywords` commit status. Called by the
# `apply-keywords` job in .github/workflows/validate-attestation.yml.
#
# It is a FILE, not an inline `run:` block, because the inline form could not
# state its own shell flags: GitHub invokes a `run:` body as `bash -e {0}`, and
# a `set -uo pipefail` inside it does not clear that `-e`. A non-zero checker
# therefore aborted the step at the `out=$(...)` assignment — swallowing the
# verdict text and skipping the publish entirely, so a genuine FAIL was
# indistinguishable from a broken runner and left the PR unmergeable with no
# published status at all (GH-1827, observed on PR #1755). A script owns its
# shebang, so the flags here are the flags that run.
#
# `-e` stays OFF deliberately, and now truthfully: the checker's exit code is
# the verdict, so it is inspected rather than propagated. Every other command
# whose failure would corrupt the verdict is checked explicitly below.

set -uo pipefail

PR_NUMBER="${1:?usage: publish-apply-keywords-status.sh PR_NUMBER}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${GITHUB_SERVER_URL:=https://github.com}"
: "${GITHUB_RUN_ID:=}"

pr_version() { gh pr view "$PR_NUMBER" --json headRefOid,updatedAt --jq '"\(.headRefOid)|\(.updatedAt)"'; }

# Capture the PR version BEFORE running the checker. A body edit during the run
# would otherwise let this publish a verdict computed against the previous
# closing keywords — on the SAME head SHA, so nothing downstream could tell it
# was stale.
#
# An unreadable PR is a hard failure, never an empty `before`: with `-e` off,
# a rate-limited read would otherwise sail through, compare equal to an equally
# empty `after`, and publish against an empty SHA.
if ! before=$(pr_version) || [[ -z "$before" ]]; then
  echo "::error::could not read PR #$PR_NUMBER before the check — publishing nothing"
  exit 1
fi

# The checker is the SAME script scripts/merge-pr.sh runs client-side — one
# implementation, two callers, so the server-side backstop cannot drift from
# the local gate.
#
# The workflow checks out the default branch, so the checker is absent on the
# PR that introduces it. That is not an error: the gate is not in effect on the
# trusted branch yet. Reported as success with a description that says exactly
# why, the same convention apply-keywords.sh itself uses for INERT.
if [[ ! -f scripts/apply-keywords.sh ]]; then
  out="APPLY KEYWORDS INERT — checker not present on the default branch (not in effect yet)"
  rc=0
else
  out=$(bash scripts/apply-keywords.sh "$PR_NUMBER" 2>&1)
  rc=$?
fi
# The verdict text is the whole point of a FAIL — it names which apply unit to
# file — so it reaches the log before anything else can go wrong.
echo "$out"

if ! after=$(pr_version) || [[ -z "$after" ]]; then
  echo "::error::could not read PR #$PR_NUMBER after the check — publishing nothing"
  exit 1
fi
if [[ "$before" != "$after" ]]; then
  echo "PR changed during the check ($before -> $after) — publishing nothing."
  echo "The event for that change queues its own run (cancel-in-progress is false)."
  exit 0
fi

head_sha="${before%%|*}"
if [[ ! "$head_sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "::error::unreadable head SHA ('$head_sha') — publishing nothing"
  exit 1
fi

if [[ "$rc" -eq 0 ]]; then state="success"; else state="failure"; fi
desc=$(head -1 <<<"$out")

# Checked explicitly: without this, a failed gh api call would fall through to
# a green step that published no status at all.
if ! gh api "repos/${GITHUB_REPOSITORY}/statuses/$head_sha" \
  -f state="$state" \
  -f context="ralph-apply-keywords" \
  -f description="${desc:0:130}" \
  -f target_url="${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}" \
  >/dev/null; then
  echo "::error::failed to publish the ralph-apply-keywords status on $head_sha"
  exit 1
fi
echo "commit status published: ralph-apply-keywords=$state"

# Exit 0 on a published FAIL: the commit status IS the verdict channel, and
# reddening the job too would make a genuine gate-6 refusal look like the
# broken runner this issue was filed about. A non-zero exit from here means
# the status could not be published — nothing else.
exit 0
