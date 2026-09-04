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
LIB="$ROOT/scripts/lib/merge-evidence.sh"
[ -r "$LIB" ] || exit 0
# shellcheck source=/dev/null
. "$LIB" 2>/dev/null || exit 0
command -v me_policy_file >/dev/null 2>&1 || exit 0
command -v me_policy_load >/dev/null 2>&1 || exit 0
command -v me_environment_grant >/dev/null 2>&1 || exit 0

POLICY_FILE=$(me_policy_file "$ROOT")
policy=$(me_policy_load "$POLICY_FILE" 2>/dev/null) || exit 0

envs=()
while IFS= read -r env; do
  [ -n "$env" ] || continue
  envs+=("$env")
done < <(jq -r '.environments | keys[]?' <<<"$policy" 2>/dev/null)
[ "${#envs[@]}" -gt 0 ] || exit 0

autonomous=() lead=() human=()
for env in "${envs[@]}"; do
  grant=$(me_environment_grant "$policy" "$env" 2>/dev/null) || continue
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
