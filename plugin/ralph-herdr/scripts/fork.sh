#!/usr/bin/env bash
# fork.sh — open a pane holding an existing session's context (GH-1892).
#
# Runs in the ACTION process (the attend.sh pattern), not a plugin pane: the
# fork's whole output IS a real pane with a harness in it, so wrapping the work
# in a plugin pane would leave a second, empty window behind.
#
# WHAT A FORK IS
#   `herdr pane get` reports the live Claude session id of a pane's agent
#   (`agent_session.value`). Starting a harness with `--resume <id>
#   --fork-session` gives a NEW session that begins holding the old one's
#   context — one transcript read, two transcripts written. So the human gets a
#   pane that already knows everything the source knew, without two processes
#   appending to one session file.
#
#   Placement comes from RALPH_FORK_PLACEMENT: right | down (a split beside the
#   source pane) or tab (a new tab in the source's workspace).
#
# WHAT A FORK IS NOT — read this before using one to do work
#   The fork shares the SOURCE PANE'S WORKTREE. Two harnesses editing one
#   checkout is the hazard GH-1774 removed sibling fleets over: they race on
#   the index, the branch, and each other's uncommitted files. Nothing here
#   prevents it — `--fork-session` mints a new session id, so ralph's
#   session->unit binding sees an unbound session, and the board claim holder
#   (`user@host`) is identical for both panes, so `board claim` would succeed
#   from the fork.
#
#   The naming half is honesty: the fork is in lane `d` (disposable), carries
#   `parent=<source>` as a pane token, and the pane's first line says what it
#   is. The ENFORCING half now lives in board.ts (GH-1956), and deliberately
#   not here — it is keyed on the WORKTREE, not on fork-ness, so it also
#   catches a second `claude` started by hand in this checkout, and it cannot
#   be lost to a `/clear` the way an env marker set here would be.
#
#   Net: `board claim <the source's unit>` from a fork is REFUSED while the
#   source is live. Treat a fork as a place to read, ask, and think from a
#   running session's context. If the source is actually gone, `--steal` says
#   so; otherwise the record ages out on the claim TTL.
#
# WHY THE NAME CARRIES ISSUE 0
#   Every issue join in this plugin keys on the issue in an agent's name:
#   refill.sh counts `^w[0-9]+-` for fleet capacity, spawn_work_session skips
#   on `w<N>-*`, the cockpit overlays agents onto issue rows. A fork of
#   w1892-foo named `d1892-…` would read as a second owner of 1892 to every one
#   of them. Lane `d` keeps it out of the `w` joins and issue 0 — already the
#   convention for agents that belong to no unit (s0-watch, x0-relay) — keeps
#   it out of the issue joins by construction, rather than by each reader
#   remembering to exclude a lane.
#
# WHY NO LEDGER RECORD
#   A C7 lineage record requires an issue number, and writing the source's
#   would tell reconcile and claim-recover that a second worker owns the unit.
#   reconcile phase B still DISCOVERS the live agent and writes a `discover`
#   record carrying no shell pid, which ralph_worker_verdict reads as
#   `unknown` — so a fork is visible to the cockpit and can never move the
#   board. That is the right amount of both.
#
# Knobs: RALPH_FORK_PLACEMENT (right|down|tab, default right), plus lib.sh's
# RALPH_HERDR_DRY_RUN / RALPH_HERDR_REPO / RALPH_ALLOW_API_BILLING.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PLACEMENT="${RALPH_FORK_PLACEMENT:-right}"
case "$PLACEMENT" in
  right | down | tab) : ;;
  *)
    echo "fork.sh: RALPH_FORK_PLACEMENT must be right, down or tab (got '$PLACEMENT')" >&2
    exit 2
    ;;
esac

# The source pane comes from the plugin invocation context (a `contexts =
# ["pane"]` action), or from RALPH_FORK_PANE for a direct/dev run. Read BEFORE
# lib.sh, because lib.sh resolves $REPO from $PWD and the source pane's cwd is
# the better answer when we have it.
ctx="${HERDR_PLUGIN_CONTEXT_JSON:-}"
SRC_PANE="${RALPH_FORK_PANE:-}"
if [ -z "$SRC_PANE" ] && [ -n "$ctx" ]; then
  SRC_PANE=$(jq -r '.focused_pane_id // empty' <<<"$ctx" 2>/dev/null || true)
fi
if [ -z "$SRC_PANE" ]; then
  echo "fork.sh: no source pane — this action needs a focused pane (set RALPH_FORK_PANE to run it by hand)" >&2
  exit 2
fi

# The action process is not cwd'd to a repo (it opens no plugin pane), so $REPO
# would otherwise default to wherever herdr launched it — and every scope read
# under lib.sh keys on $REPO. The context's own focused_pane_cwd is the answer,
# and it is available BEFORE the transport is, which is why it is taken from
# here rather than from the `pane get` below.
if [ -z "${RALPH_HERDR_REPO:-}" ] && [ -n "$ctx" ]; then
  ctx_cwd=$(jq -r '.focused_pane_cwd // .workspace_cwd // empty' <<<"$ctx" 2>/dev/null || true)
  [ -n "$ctx_cwd" ] && export RALPH_HERDR_REPO="$ctx_cwd"
fi

# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

# A fork starts a harness, so the same billing guard the spawn paths run
# applies: a stray API key here bills credits exactly as it would there.
billing_guard
ralph_plugin_freshness_notice

# ── Read the source pane ─────────────────────────────────────────────────────
# Through the strict adapter, so what comes back is a validated pane_info and
# the field reads below are reads, not guesses.
src=$(ralph_herdr_call pane_info pane get "$SRC_PANE") || {
  rc=$?
  case "$rc" in
    2) die "herdr refused to read pane $SRC_PANE: $(ralph_herdr_err_code "$src") — $(ralph_herdr_err_message "$src")" ;;
    3) die "herdr did not answer the read of pane $SRC_PANE (unreachable, or the call timed out)" ;;
    *) die "herdr's answer about pane $SRC_PANE was not a response this plugin can read — see the transport error above" ;;
  esac
}

src_agent=$(jq -r '.pane.agent // empty' <<<"$src")
sess_kind=$(jq -r '.pane.agent_session.kind // empty' <<<"$src")
sess_id=$(jq -r '.pane.agent_session.value // empty' <<<"$src")
src_cwd=$(jq -r '.pane.cwd // empty' <<<"$src")
src_ws=$(jq -r '.pane.workspace_id // empty' <<<"$src")
src_depth=$(jq -r '.pane.tokens.depth // empty' <<<"$src")
src_root=$(jq -r '.pane.tokens.root // empty' <<<"$src")
src_name=$(jq -r '.pane.tokens.slug // empty' <<<"$src")

# Three refusals, each naming what it saw. They are separate because they send
# the reader to different places: no agent at all, an agent whose resume
# grammar we do not speak, and a session herdr describes by path.
if [ -z "$src_agent" ]; then
  die "pane $SRC_PANE is not running an agent — there is no session to fork"
fi
if [ "$src_agent" != "claude" ]; then
  die "pane $SRC_PANE runs '$src_agent' — fork only speaks claude's resume grammar (--resume <id> --fork-session); other harnesses need their own"
fi
if [ -z "$sess_id" ]; then
  die "herdr reports no session for the claude in pane $SRC_PANE — nothing to resume from (a session id appears once the agent has been detected and started a conversation)"
fi
if [ "$sess_kind" != "id" ]; then
  die "herdr describes pane $SRC_PANE's session by $sess_kind, not id — \`claude --resume\` takes a session id, and deriving one from a path would be a guess"
fi

# The fork's cwd is the SOURCE pane's, deliberately: a fork that opened
# somewhere else would hold a transcript about files it cannot see.
[ -n "$src_cwd" ] || src_cwd="$REPO"

# ── Name the fork ────────────────────────────────────────────────────────────
# Slug from the source's own slug token when it has one (a ralph-spawned
# worker), else from the pane id — a hand-started `claude` in a plain pane is a
# perfectly good fork source and must not be refused for lacking ralph chrome.
if [ -n "$src_name" ]; then
  base="fork $src_name"
else
  base="fork $SRC_PANE"
fi
name=$(ralph_agent_name d 0 "$base") || die "could not derive a name for a fork of pane $SRC_PANE"

# Generation suffix on collision. Names are unique among LIVE agents only, so
# this asks the herd rather than a registry. A read failure fails CLOSED: an
# unknown herd cannot prove the name is free, and `agent start` on a taken name
# is a refusal, not a silent overwrite.
herd=$(ralph_agents_json 2>/dev/null) || die "cannot read the herd — refusing to fork without proving the name '$name' is free"
gen=2
while printf '%s\n' "$herd" | jq -e --arg n "$name" 'select(.name == $n)' >/dev/null 2>&1; do
  if [ "$gen" -gt 9 ]; then
    die "nine forks of $base are already live — close one before forking again (grammar B reserves --2..--9 for generations)"
  fi
  name=$(ralph_agent_name_collide "$(ralph_agent_name d 0 "$base")" "$gen") ||
    die "could not derive generation $gen of '$base'"
  gen=$((gen + 1))
done

# Depth is recorded, never enforced. ralph_depth_guard caps runaway TREES, and
# only automation makes those; every action in this plugin is a human click on
# a pane they are looking at, so refusing a fork at depth 2 would cost a verb
# to guard against a caller that cannot reach this path. The token stays
# truthful so the lineage view still shows the nesting.
case "$src_depth" in '' | *[!0-9]*) src_depth=0 ;; esac
depth=$((src_depth + 1))
[ "$depth" -gt 3 ] && depth=3
[ -n "$src_root" ] || src_root="$name"

if [ "${RALPH_HERDR_DRY_RUN:-}" = "true" ]; then
  echo "DRY RUN — would fork pane $SRC_PANE ($PLACEMENT):"
  echo "  session: $sess_id   agent: $name   cwd: $src_cwd"
  case "$PLACEMENT" in
    tab) echo "  $HERDR tab create --workspace $src_ws --cwd $src_cwd --label \"$name\" --no-focus" ;;
    *) echo "  $HERDR pane split $SRC_PANE --direction $PLACEMENT --cwd $src_cwd --focus" ;;
  esac
  echo "  $HERDR agent start $name --kind claude --pane <captured> -- --resume $sess_id --fork-session"
  echo "  tokens push (pane <captured>): role=d issue=0 parent=${src_name:-$SRC_PANE} root=$src_root depth=$depth harness=claude"
  exit 0
fi

# ── Open the target pane ─────────────────────────────────────────────────────
# --focus: the human clicked, so the pane they asked for may take focus (the
# same carve-out the manifest's actions document). Pane ids are captured from
# the response, never predicted.
case "$PLACEMENT" in
  tab)
    out=$(ralph_herdr_call tab_created tab create --workspace "$src_ws" --cwd "$src_cwd" --label "$name" --focus) || {
      rc=$?
      case "$rc" in
        2) die "herdr refused to create the fork tab: $(ralph_herdr_err_code "$out") — $(ralph_herdr_err_message "$out")" ;;
        3) die "herdr did not answer the fork tab create (unreachable, or timed out — a timed-out create may still have landed; check the cockpit before retrying)" ;;
        *) die "herdr's answer to the fork tab create was not a response this plugin can read — see the transport error above" ;;
      esac
    }
    pane=$(jq -r '.root_pane.pane_id // empty' <<<"$out")
    ;;
  *)
    out=$(ralph_herdr_call pane_info pane split "$SRC_PANE" --direction "$PLACEMENT" --cwd "$src_cwd" --focus) || {
      rc=$?
      case "$rc" in
        2) die "herdr refused to split pane $SRC_PANE $PLACEMENT: $(ralph_herdr_err_code "$out") — $(ralph_herdr_err_message "$out")" ;;
        3) die "herdr did not answer the $PLACEMENT split of pane $SRC_PANE (unreachable, or timed out — a timed-out split may still have landed; check the cockpit before retrying)" ;;
        *) die "herdr's answer to the $PLACEMENT split was not a response this plugin can read — see the transport error above" ;;
      esac
    }
    pane=$(jq -r '.pane.pane_id // empty' <<<"$out")
    ;;
esac
[ -n "$pane" ] || die "no pane id in herdr's $PLACEMENT response — cannot start the fork"

# ── Start the fork ───────────────────────────────────────────────────────────
# The harness args are the whole feature: --resume takes the SOURCE's session
# id, and --fork-session makes claude mint a new one rather than append to it.
# Without the second flag both panes would write one transcript.
# stdout is the started-agent envelope, which the caller of a fork has no use
# for; stderr — where every refusal lands — is deliberately left alone.
if ! agent_start_when_ready "$name" "$pane" --resume "$sess_id" --fork-session >/dev/null; then
  die "could not start the fork in pane $pane — see the herdr error above; the pane is left open at its shell prompt (start it by hand with: $HERDR agent start $name --kind claude --pane $pane -- --resume $sess_id --fork-session)"
fi

# Display tokens only — the ledger rationale is in the header. `parent` is the
# existing C8 token for "parent agent name or durable ref", which is exactly
# what a fork's source is; no new vocabulary is needed to say this.
ralph_tokens_push "$pane" "role=d" "issue=0" "parent=${src_name:-$SRC_PANE}" \
  "root=$src_root" "depth=$depth" "harness=claude"

echo "forked pane $SRC_PANE -> $pane ($PLACEMENT), agent $name, resuming session $sess_id"
notify "$name" "ralph: forked a session" "$name holds ${src_name:-pane $SRC_PANE}'s context in $src_cwd — same worktree, so do not drive it as a second writer"
