#!/usr/bin/env bash
# deploy-grants-context — SessionStart observation (GH-2452, unit 10 of
# thoughts/shared/plans/2026-09-03-approval-gated-hosts-design.md, D7).
#
# GH-2451 added `environments.<name>: autonomous | lead | human` to
# .github/ralph-merge-policy.json, read by scripts/lib/merge-evidence.sh's
# me_environment_grant (the same reader scripts/approve-deploy.sh runs). This
# hook renders that table as ONE session-context line so an agent learns its
# standing deploy authority before hitting approve-deploy.sh cold, instead of
# discovering per-environment grants one refusal at a time. Courtesy, never
# enforcement (ralph/CLAUDE.md's Enforcement layers) — approve-deploy.sh is
# the gate; this only narrates what it will decide, and "prod"/"production"
# read "human" here exactly as they do there (the reserved-set override lives
# in me_environment_grant, not duplicated in this hook).
#
# Silent (no output, exit 0) when: this isn't a git repo, the host repo has
# not installed the merge-gate kit (no scripts/lib/merge-evidence.sh), the
# policy file is absent or malformed, or the policy carries no `environments`
# block at all — matching every hook in this family, this NEVER exits
# non-zero, so a broken or unconfigured host never blocks a session start.
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0

# This hook DELIBERATELY does not source scripts/lib/merge-evidence.sh, even
# though that library owns the two rules below (greptile P1, PR #2479).
#
# SessionStart hooks are registered by the PLUGIN, so this runs in EVERY repo
# a session opens, before the human types anything. Sourcing a shell library
# out of the checkout would execute arbitrary repository-provided code on the
# strength of `[ -r "$LIB" ]` alone -- a path any repository can contain, and
# an unverified one. Reading a path is not executing it; the whole hook is a
# jq read now, and nothing from the checkout is ever evaluated as code.
#
# The cost is that the reserved-environment rule is stated in two places.
# scripts/__tests__/deploy-grants-context.test.sh pins them together by
# reading me_reserved_environments out of the library AS TEXT, so drift fails
# a test rather than silently changing what a session is told.
#
# The line this hook prints names `scripts/approve-deploy.sh` as the gate, so
# it is gated on that script being PRESENT in the host checkout -- the same
# rule the funnel hooks follow ("only when the host repo ships the target").
# A marketplace-installed host receives the merge-evidence.sh reader through
# the kit but not (yet) approve-deploy.sh (codex P1, PR #2479); advertising a
# command that would fail with "No such file" is worse than silence. Presence
# is a read (`-r`), never an execution.
LIB="$ROOT/scripts/lib/merge-evidence.sh"
GATE="$ROOT/scripts/approve-deploy.sh"
[ -r "$LIB" ] || exit 0
[ -r "$GATE" ] || exit 0

# Same path rule as me_policy_file, same override variable.
POLICY_FILE="${RALPH_MERGE_POLICY_FILE:-$ROOT/.github/ralph-merge-policy.json}"
[ -r "$POLICY_FILE" ] || exit 0
policy=$(jq -e . "$POLICY_FILE" 2>/dev/null) || exit 0

# Same semantic bar as me_policy_load (codex P2, PR #2479): a policy the
# deploy gate refuses to LOAD -- an unknown request_mode, or a grant value
# outside autonomous|lead|human ("autonomus") -- must not have this hook
# announcing authority approve-deploy.sh will then refuse to exercise. Both
# checks are restated here as jq, never sourced (see above); a non-object
# `environments` fails the same way. Silent, matching every other refusal.
jq -e '((.external_review.request_mode // "comment") | IN("comment", "review-request"))
       and ((.environments // {}) | type == "object")
       and ((.environments // {}) | to_entries
            | all(.value | IN("autonomous", "lead", "human")))' \
  <<<"$policy" >/dev/null 2>&1 || exit 0

# Same rule as me_environment_grant: the reserved set is always "human"
# regardless of what the policy says, and an unlisted environment defaults to
# "human" rather than to anything weaker.
RESERVED_ENVIRONMENTS='["prod", "production"]'

# An environment NAME is repository-controlled text that lands verbatim in
# the session's context (greptile P1, PR #2479). Only a name shaped like a
# GitHub deployment environment is carried through; anything else -- control
# characters, whitespace, instruction-like prose -- is dropped, never
# rendered, so a policy file cannot smuggle a sentence into the session
# through a key. Dropped silently: this hook narrates, it never diagnoses.
ENV_NAME_SHAPE='^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'

envs=()
while IFS= read -r env; do
  [ -n "$env" ] || continue
  envs+=("$env")
done < <(jq -r --arg shape "$ENV_NAME_SHAPE" \
  '.environments | keys[]? | select(test($shape))' <<<"$policy" 2>/dev/null)
[ "${#envs[@]}" -gt 0 ] || exit 0

autonomous=() lead=() human=()
for env in "${envs[@]}"; do
  grant=$(jq -r --arg e "$env" --argjson reserved "$RESERVED_ENVIRONMENTS" \
    'if ($reserved | index($e | ascii_downcase)) != null then "human"
     else (.environments[$e] // "human") end' <<<"$policy" 2>/dev/null) || continue
  case "$grant" in
    autonomous) autonomous+=("$env") ;;
    lead)       lead+=("$env") ;;
    *)          human+=("$env") ;;
  esac
done

# bash 3.2 (macOS's /usr/bin/bash, and this repo's floor) treats
# "${arr[@]}" on a genuinely empty array as an unbound-variable error under
# `set -u`, so every expansion below is guarded by a length check first —
# never expanded unconditionally on the strength of `arr=()` alone.
join_with() {
  local sep="$1" out="" first=1
  shift
  for x in "$@"; do
    if [ "$first" = 1 ]; then out="$x"; first=0; else out="$out$sep$x"; fi
  done
  printf '%s' "$out"
}

clauses=()
if [ "${#autonomous[@]}" -gt 0 ]; then
  auto_csv=$(join_with ", " "${autonomous[@]}")
  clauses+=("standing deploy authority in this repo: $auto_csv")
fi
if [ "${#lead[@]}" -gt 0 ]; then
  for env in "${lead[@]}"; do clauses+=("$env via lead"); done
fi
if [ "${#human[@]}" -gt 0 ]; then
  for env in "${human[@]}"; do clauses+=("$env human"); done
fi

[ "${#clauses[@]}" -gt 0 ] || exit 0

line=$(join_with "; " "${clauses[@]}")
[ "${#autonomous[@]}" -gt 0 ] || line="deploy authority in this repo: $line"

echo "$line — \`scripts/approve-deploy.sh\`"
exit 0
