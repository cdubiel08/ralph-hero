#!/bin/bash
# ralph/hooks/scripts/split-size-gate.sh
# Dual-event hook for ralph_hero__create_issue | ralph_hero__create_sub_issues
# under /ralph:plan --mode epic (GH-1605; the atomic-split half was formerly
# caretake's split mode):
#   - PreToolUse: classify which decomposition path this call belongs to and
#     enforce that path's child-estimate contract.
#   - PostToolUse: record how many children were actually created, for
#     split-postcondition.sh.
#
# ---- Scope (GH-1603) ---------------------------------------------------------
# The previous version keyed on `RALPH_SUBCOMMAND=epic-split`, armed by a bare
# `export` in decomposition.md prose. A bare `export` inside a Bash tool call
# does NOT propagate to hook subprocesses — only SessionStart CLAUDE_ENV_FILE
# writes do (set-skill-env.sh) — so that guard was dead in production and the
# XS/S ceiling never fired. Scope now comes from signals the hook can see:
#
#   1. RALPH_COMMAND=plan — SessionStart via CLAUDE_ENV_FILE, the one env
#      signal hooks can trust.
#   2. The tool being called. Only `--mode epic` creates issues; the plan
#      verb's other four modes (default / auto / iterate / review) never call
#      create_issue or create_sub_issues at all. So "plan verb + a child
#      creation payload" already means epic mode — no mode env var needed.
#   3. Which epic path, from the session artifact ledger. The two paths differ
#      in ORDER, and that difference is observable: the plan-of-plans path
#      writes its doc FIRST and creates children after (decomposition.md
#      § Plan-of-plans path, Step 3 → Step 4), while the atomic-split path
#      creates children first and writes the parent plan-of-plans afterwards
#      (§ Atomic split, §Step 6 → §Step 7.5). artifact-write-tracker.sh
#      already records every session Write under thoughts/shared/plans/, keyed
#      by the harness's .session_id. A plans/ doc already written by THIS
#      session ⇒ plan-of-plans path; none ⇒ atomic split.
#   4. RALPH_SUBCOMMAND=epic-split — retained as an ADDITIVE arming signal for
#      environments where an operator exports it before launching. It can only
#      force the tighter (atomic) contract, never relax it.
#
# Ambiguity resolves to the atomic (tighter) contract: the recovery message
# then tells the plan-of-plans path to write its doc before creating children,
# which is the documented order anyway.
#
# GH-1565: create_sub_issues batches N children in a single call, each with its
# own optional .estimate — there is no single scalar estimate to read, so this
# hook branches on whether the payload carries a `children` array and, if so,
# validates every child's estimate instead of the top-level scalar.
#
# Environment:
#   RALPH_VALID_SUB_ESTIMATES     - Atomic-split child ceiling (default: XS,S)
#   RALPH_VALID_FEATURE_ESTIMATES - Plan-of-plans child ceiling (default: S,M)
#
# Exit codes:
#   0 - Estimate(s) valid (or out of scope, or PostToolUse recording pass)
#   2 - Child estimate outside the path's ceiling, missing entirely, the parent
#       is too small to split, or the payload could not be parsed. A missing
#       estimate is refused rather than waved through: neither ceiling may be
#       bypassed by omitting the field.

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

if [[ "${RALPH_COMMAND:-}" != "plan" ]]; then
  allow
fi

read_input > /dev/null

# jq_or_block <jq-args...> — run jq over the hook payload and block on any jq
# failure. GH-1603 F8: these stages used to run bare under `set -euo pipefail`,
# where an unwalkable payload aborted the hook with rc=1 (non-blocking), so a
# malformed create payload sailed past the ceiling. A payload this gate cannot
# read is never a payload it can clear.
jq_or_block() {
  local out
  if ! out=$(printf '%s' "$RALPH_HOOK_INPUT" | jq -r "$@" 2>/dev/null); then
    block "Sub-ticket creation blocked: payload unreadable

The create payload could not be parsed as JSON, so neither the child estimates
nor the parent could be checked against the decomposition contract.

Recovery: re-issue the call with a well-formed children array — each child
needs an explicit XS/S (atomic split) or S/M (plan-of-plans) estimate."
  fi
  printf '%s' "$out"
}

# ---- PostToolUse: record the created count, never block -----------------------
# split-postcondition.sh needs "how many children were really created". The
# `RALPH_SPLIT_COUNT=<N>` export decomposition.md used to prescribe is a bare
# Bash export and never reaches the Stop hook, so the count is taken from the
# tool's own per-child status report instead.
if [[ "$(get_field '.hook_event_name')" == "PostToolUse" ]] || \
   printf '%s' "$RALPH_HOOK_INPUT" | jq -e 'has("tool_response")' >/dev/null 2>&1; then
  response_text=$(get_field '.tool_response.content[0].text')
  if [[ -n "$response_text" ]]; then
    created=$(printf '%s' "$response_text" \
      | jq -r '[.children[]? | select(.created == true)] | length' 2>/dev/null || echo "")
    if [[ -z "$created" || ! "$created" =~ ^[0-9]+$ ]]; then
      created=$(printf '%s' "$response_text" | jq -r '.summary.created // empty' 2>/dev/null || echo "")
    fi
    if [[ "$created" =~ ^[0-9]+$ ]]; then
      split_ledger_put count "$created"
    fi
  fi
  exit 0
fi

# ---- Path classification -----------------------------------------------------
atomic=1
if [[ -n "$(session_artifacts "thoughts/shared/plans")" ]]; then
  atomic=0
fi
if [[ "${RALPH_SUBCOMMAND:-}" == "epic-split" ]]; then
  atomic=1
fi

if [[ "$atomic" -eq 1 ]]; then
  valid_estimates="${RALPH_VALID_SUB_ESTIMATES:-XS,S}"
  path_label="/ralph:plan --mode epic (atomic-split path)"
else
  valid_estimates="${RALPH_VALID_FEATURE_ESTIMATES:-S,M}"
  path_label="/ralph:plan --mode epic (plan-of-plans path)"
fi

# Record the classification for split-estimate-gate.sh, which arms its
# fail-closed enforcement off it. Written on BOTH paths (0 or 1) and written
# even when this call is about to be blocked — a rejected atomic batch still
# establishes that the session is on the atomic path.
split_ledger_put atomic "$atomic"

# Numeric guard: parent_number becomes part of a ledger filename below, and
# `.tool_input.parentNumber` is caller-supplied.
parent_number=$(jq_or_block '.tool_input.parentNumber // empty')
if [[ "$parent_number" =~ ^[0-9]+$ ]]; then
  split_ledger_put parent "$parent_number"
else
  parent_number=""
fi

# ---- Parent-size rule (atomic path only) -------------------------------------
# split-estimate-gate.sh records every issue estimate it reads from a get_issue
# response. If the parent of THIS batch was fetched earlier in the session
# (decomposition.md § Atomic split §Step 2 mandates that fetch), enforce the
# M/L/XL parent contract here — before any child exists. An unrecorded parent
# is not blocked: the estimate is genuinely unknown to the session, and
# refusing every batch whose parent was fetched in another context would break
# legitimate dispatches without catching anything the ceiling below misses.
if [[ "$atomic" -eq 1 && -n "$parent_number" ]]; then
  parent_estimate=$(split_ledger_get "parent-${parent_number}")
  if [[ -n "$parent_estimate" ]] && ! validate_state "$parent_estimate" "$(split_min_estimate_set)"; then
    block "Split blocked: parent too small to split

Parent:   #${parent_number}
Estimate: ${parent_estimate} (read from this session's get_issue response)
Required: one of $(split_min_estimate_set)

The atomic-split path only decomposes M/L/XL parents — an XS/S parent is
already atomic, and splitting it produces trivial children.

Recovery options:
  1. Emit 'SPLIT SKIPPED already-atomic' and stop (decomposition.md
     § Atomic split § Terminal tokens).
  2. If the estimate is wrong, re-estimate the parent to M+ and retry.
  3. If the ticket really is small, dispatch /ralph:impl instead."
  fi
fi

has_children=$(jq_or_block '(.tool_input.children | type) == "array"')

if [[ "$has_children" == "true" ]]; then
  # Batch path (create_sub_issues): one estimate per child, array-shaped.
  # A missing/empty estimate is NOT a pass on EITHER path — the ceiling must
  # not be bypassable by simply omitting the field (decomposition.md gives
  # every child an explicit estimate in both § Child creation and
  # § Atomic split §Step 6).
  #
  # The unestimated check runs FIRST: an empty-string estimate is neither
  # "too large" nor a valid value, and reporting it as "too large" (the old
  # ordering, where `select(.estimate != null)` swept `""` into the offending
  # bucket) named the wrong defect.
  unestimated=$(jq_or_block '
    [.tool_input.children[]
      | select(((.estimate // "") | gsub("^\\s+|\\s+$"; "")) == "")
      | .title // "untitled"]
    | join(", ")
  ')

  if [[ -n "$unestimated" ]]; then
    block "Sub-ticket estimate missing

Children with no estimate: $unestimated
Valid estimates: $valid_estimates

$path_label must give EVERY child an explicit estimate — an omitted estimate is
not a waiver of the ceiling. Set one per child in the same create_sub_issues
call."
  fi

  offending=$(jq_or_block --arg valid "$valid_estimates" '
    ($valid | split(",") | map(gsub("^\\s+|\\s+$"; ""))) as $ok
    | [.tool_input.children[]
        | select(((.estimate // "") | gsub("^\\s+|\\s+$"; "")) as $e
                 | $e != "" and ($ok | index($e)) == null)
        | "\(.title // "untitled"): \(.estimate)"]
    | join(", ")
  ')

  if [[ -n "$offending" ]]; then
    block "Sub-ticket estimate too large

Offending children: $offending
Valid estimates: $valid_estimates

$path_label must create sub-tickets within $valid_estimates only.
If the work is larger, consider further decomposition.

If this IS the plan-of-plans path, write the plan-of-plans doc under
thoughts/shared/plans/ BEFORE creating children (decomposition.md
§ Plan-of-plans path, Step 3 → Step 4) — that write is what tells this gate
which ceiling applies."
  fi

  child_count=$(jq_or_block '.tool_input.children | length')

  # Only NOW record the split attempt for split-postcondition.sh: a permitted
  # atomic `create_sub_issues` batch. Deliberately narrow on three axes —
  #   * allowed, not blocked: a batch this gate refused produced no children, so
  #     the agent's documented `SPLIT SKIPPED` exit must not then be trapped at
  #     Stop by a count it can never satisfy;
  #   * atomic only: plan-of-plans has no ≥2 postcondition;
  #   * batch only: the single-child create_issue path (decomposition.md
  #     § Child creation, incremental addition) is legitimately one child.
  if [[ "$atomic" -eq 1 ]]; then
    split_ledger_put attempted 1
  fi

  allow_with_context "Creating sub-ticket batch ($child_count children) — all estimates within $valid_estimates"
fi

# Scalar path (create_issue). Same rule as the batch path above: an omitted
# estimate is a refusal, not a free pass.
estimate=$(get_field '.tool_input.estimate')
if [[ -z "$estimate" ]]; then
  block "Sub-ticket estimate missing

Valid estimates: $valid_estimates

$path_label must give EVERY sub-ticket an explicit estimate — an omitted
estimate is not a waiver of the ceiling."
fi

if ! validate_state "$estimate" "$valid_estimates"; then
  block "Sub-ticket estimate too large

Attempted estimate: $estimate
Valid estimates: $valid_estimates

$path_label must create sub-tickets within $valid_estimates only.
If the work is larger, consider further decomposition."
fi

allow_with_context "Creating sub-ticket with estimate $estimate (valid: $valid_estimates)"
