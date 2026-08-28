#!/usr/bin/env bash
# work-team.test.sh — executable tests for the TEAM spawn form (GH-2178,
# unit B of #2176): work-team.sh's lead spawn plan, its idempotence against a
# standing lead, the epic-membership validation on a named worker list, and
# the RALPH_HERDR_TEAM_LEAD propagation into spawn_work_session's plan.
#
#   bash plugin/ralph-herdr/tests/work-team.test.sh   # exits 0 pass, 1 fail
#
# All herdr traffic goes through tests/fake-herdr.sh, all board traffic
# through tests/fake-board.sh, gh through fake-gh.sh — no server, no GitHub,
# no writes outside $TMP. bash 3.2 compatible.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS="$SCRIPT_DIR/../scripts"

TMP=$(mktemp -d "${TMPDIR:-/tmp}/ralph-work-team-test.XXXXXX") || exit 1
trap 'rm -rf "$TMP"' EXIT

BIN="$TMP/bin"
mkdir -p "$BIN"
printf '#!/bin/bash\nexec bash "%s" "$@"\n' "$SCRIPT_DIR/fake-herdr.sh" >"$BIN/herdr"
printf '#!/bin/bash\nexec bash "%s" "$@"\n' "$SCRIPT_DIR/fake-board.sh" >"$BIN/board"
printf '#!/bin/bash\nexec bash "%s" "$@"\n' "$SCRIPT_DIR/fake-gh.sh" >"$BIN/gh"
chmod +x "$BIN/herdr" "$BIN/board" "$BIN/gh"
export PATH="$BIN:$PATH"
export HERDR_BIN_PATH="$BIN/herdr"
export FAKE_HERDR_FIXTURES="$TMP/fixtures"
export FAKE_HERDR_LOG="$TMP/herdr.log"
export FAKE_BOARD_FIXTURES="$TMP/board-fixtures"
export FAKE_BOARD_LOG="$TMP/board.log"
export FAKE_GH_FIXTURES="$TMP/gh-fixtures"
mkdir -p "$FAKE_HERDR_FIXTURES" "$FAKE_BOARD_FIXTURES" "$FAKE_GH_FIXTURES"
: >"$FAKE_HERDR_LOG"
export RALPH_HERDR_LEDGER_ROOT="$TMP/guard-root"
export RALPH_HERDR_SESSIONS_DIR="$TMP/sessions"
mkdir -p "$TMP/sessions"

# A real repo with a local origin (spawn paths fetch origin/main; work-fleet's
# delegated dry run reaches ralph_branch_for_issue and the surface read).
ORIGIN="$TMP/origin"
REPO_DIR="$TMP/repo"
git init -q -b main "$ORIGIN" 2>/dev/null || {
  git init -q "$ORIGIN" && git -C "$ORIGIN" checkout -q -b main
}
git -C "$ORIGIN" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
git clone -q "$ORIGIN" "$REPO_DIR"

# shellcheck source=herd-fixture.sh
. "$SCRIPT_DIR/herd-fixture.sh"
herd_fixture '[]' "$REPO_DIR"

n=0 pass=0 fail=0
ok()     { n=$((n + 1)); pass=$((pass + 1)); echo "ok $n - $1"; }
not_ok() { n=$((n + 1)); fail=$((fail + 1)); echo "not ok $n - $1"; }
is() {
  if [ "$2" = "$3" ]; then ok "$1"; else not_ok "$1 — expected '$2', got '$3'"; fi
}
line_has() {
  case "$2" in *"$3"*) ok "$1" ;; *) not_ok "$1 — no '$3' in '$2'" ;; esac
}
line_lacks() {
  case "$2" in *"$3"*) not_ok "$1 — found '$3'" ;; *) ok "$1" ;; esac
}

# The epic and its frontier: #900 is the epic, #901/#902/#903 its children
# (901 and 902 ready on the frontier, 903 not), #77 a ready non-child.
cat >"$FAKE_BOARD_FIXTURES/get.900.json" <<'EOF'
{"number":900,"title":"Teams dispatch and inbox","issueState":"OPEN","state":"In Progress",
 "children":[{"number":901},{"number":902},{"number":903}],"childrenTruncated":false}
EOF
cat >"$FAKE_BOARD_FIXTURES/frontier.json" <<'EOF'
{"frontier":[{"number":901,"title":"Unit A","parentNumber":900},
             {"number":77,"title":"Stranger","parentNumber":null},
             {"number":902,"title":"Unit B","parentNumber":900}],
 "blocked":[]}
EOF

WTL="$TMP/ledger/ledger.jsonl"
mkdir -p "$TMP/ledger"
: >"$WTL"

# WT_FLEET rides a plain variable rather than an env prefix on the call:
# `VAR=x fn` assignments PERSIST after a function call in bash, so a prefix
# would leak into every later test.
run_wt() {
  RC=0
  OUT=$(RALPH_HERDR_REPO="$REPO_DIR" RALPH_HERDR_BOARD="$BIN/board" \
    RALPH_HERDR_LEDGER="$WTL" RALPH_HERDR_DRY_RUN=true ANTHROPIC_API_KEY= \
    RALPH_HERDR_FLEET="${WT_FLEET:-2}" \
    bash "$SCRIPTS/work-team.sh" "$@" </dev/null 2>&1) || RC=$?
}

# ═══ 1. the dry-run lead plan ════════════════════════════════════════════════
run_wt 900 901
is "team dry: exits 0" "0" "$RC"
line_has "team dry: plans the lead spawn" "$OUT" "DRY RUN — would spawn the lead for GH-900"
line_has "team dry: the lead is the o-lane grammar-B name" "$OUT" "agent: o900-teams-dispatch-and-inbox"
line_has "team dry: the pane is a workspace create (the one --env channel)" \
  "$OUT" "workspace create"
line_has "team dry: the lead's own address rides --env RALPH_HERDR_LEAD" \
  "$OUT" "--env RALPH_HERDR_LEAD=o900-teams-dispatch-and-inbox"
line_has "team dry: the lead propagates itself as TEAM_LEAD" \
  "$OUT" "--env RALPH_HERDR_TEAM_LEAD=o900-teams-dispatch-and-inbox"
line_has "team dry: the lead's own spawns will record invoked_by=agent" \
  "$OUT" "--env RALPH_HERDR_INVOKED_BY=agent"
line_has "team dry: the editing tools are cut from the lead's harness" \
  "$OUT" "-- --tools Bash,Read,Grep,Glob"

record=$(printf '%s\n' "$OUT" | sed -n 's/^  ledger append (spawn): //p' | head -1)
if [ -n "$record" ] && jq -e . >/dev/null 2>&1 <<<"$record"; then
  ok "team dry: plan carries a JSON spawn record"
else
  not_ok "team dry: plan carries a JSON spawn record — got '$record'"
fi
jqr() { jq -r "$1" <<<"$record" 2>/dev/null; }
is "lead record: role is orchestrator (lineage)" "orchestrator" "$(jqr '.lineage.role')"
is "lead record: role token too" "orchestrator" "$(jqr '.tokens.role')"
is "lead record: the epic is the lead's issue" "900" "$(jqr '.lineage.issue')"
is "lead record: no parent issue — the epic is the root" "false" "$(jqr '.lineage | has("parent_issue")')"
is "lead record: depth 0" "0" "$(jqr '.tokens.depth')"
# GH-2210: canonical team-space label — `<repo>/t<epic>-<slug>`, the team slug
# byte-identical to the lead's own — and the lead's o-lane address stamped.
line_has "team dry: workspace label is the canonical team address" \
  "$OUT" 'workspace label: fake-repo/t900-teams-dispatch-and-inbox'
is "lead record: workspace_label is the team address" \
  "fake-repo/t900-teams-dispatch-and-inbox" "$(jqr '.lineage.herdr.workspace_label')"
is "lead record: address token is the lead's o-lane address" \
  "fake-repo/t900-teams-dispatch-and-inbox/o900-teams-dispatch-and-inbox" "$(jqr '.tokens.address')"

line_has "team dry: workers are handed to work-fleet" "$OUT" "handing 1 worker issue(s) to work-fleet.sh: GH-901"
line_has "team dry: the worker plan spawns through the one primitive" "$OUT" "DRY RUN — would spawn GH-901"
line_has "team dry: the worker pane gets the lead's address injected" \
  "$OUT" "pane run <captured> export RALPH_HERDR_LEAD=o900-teams-dispatch-and-inbox"
is "team dry: ledger untouched by a plan" "0" "$(wc -c <"$WTL" | tr -d ' ')"
is "team dry: no herdr mutation planned-then-performed" "0" \
  "$(grep -c 'workspace create' "$FAKE_HERDR_LOG" || true)"

# ═══ 2. default pick: ranked frontier ∩ the epic's children, capped ══════════
run_wt 900
is "team default: exits 0" "0" "$RC"
line_has "team default: both ready children picked, ranked order" \
  "$OUT" "handing 2 worker issue(s) to work-fleet.sh: GH-901 GH-902"
line_lacks "team default: a ready non-child is never team work" "$OUT" "GH-77"
line_lacks "team default: a child off the frontier is not picked" "$OUT" "GH-903"

WT_FLEET=1
run_wt 900
unset WT_FLEET
line_has "team default: RALPH_HERDR_FLEET caps the pick" \
  "$OUT" "handing 1 worker issue(s) to work-fleet.sh: GH-901"

# ═══ 3. membership: a named non-child is a skip with the override named ═══════
run_wt 900 77
is "team named non-child: exits 0" "0" "$RC"
line_has "team named non-child: skipped with the epic-scope reason" \
  "$OUT" "SKIP GH-77 — not a child of GH-900"
line_has "team named non-child: the out-of-team lane is named" "$OUT" "work-fleet.sh 77"
line_has "team named non-child: the lead still stands" "$OUT" "the lead stands alone"

# A truncated child list cannot prove membership — operator-named work
# proceeds, loudly.
cat >"$FAKE_BOARD_FIXTURES/get.910.json" <<'EOF'
{"number":910,"title":"Big epic","issueState":"OPEN","children":[{"number":911}],"childrenTruncated":true}
EOF
run_wt 910 912
line_has "team truncated children: membership not proven, named work proceeds" \
  "$OUT" "membership not proven; proceeding because you named it"

# ═══ 4. idempotence: a standing lead is never doubled ════════════════════════
herd_fixture '[{"name":"o900-existing-lead","agent_status":"working","pane_id":"p9"}]' "$REPO_DIR"
run_wt 900 901
is "standing lead: exits 0" "0" "$RC"
line_has "standing lead: named, not doubled" "$OUT" "lead o900-existing-lead already standing for GH-900"
line_lacks "standing lead: no second lead planned" "$OUT" "would spawn the lead"
line_has "standing lead: workers still delegate under the LIVE lead's name" \
  "$OUT" "pane run <captured> export RALPH_HERDR_LEAD=o900-existing-lead"
herd_fixture '[]' "$REPO_DIR"

# ═══ 5. --lead-only: the dispatch pass's respawn form ════════════════════════
run_wt 900 --lead-only
is "lead-only: exits 0" "0" "$RC"
line_has "lead-only: the lead is planned" "$OUT" "would spawn the lead for GH-900"
line_has "lead-only: workers untouched" "$OUT" "workers untouched (--lead-only)"
line_lacks "lead-only: nothing handed to work-fleet" "$OUT" "handing"

run_wt 900 901 --lead-only
is "lead-only with workers: dies" "1" "$RC"
line_has "lead-only with workers: the contradiction is named" "$OUT" "contradiction"

# ═══ 6. refusals ═════════════════════════════════════════════════════════════
cat >"$FAKE_BOARD_FIXTURES/get.920.json" <<'EOF'
{"number":920,"title":"Shipped epic","issueState":"CLOSED","children":[]}
EOF
run_wt 920
is "closed epic: clean refusal (rc 4 — the healer reads it as complete, GH-2212)" "4" "$RC"
line_has "closed epic: the refusal says why" "$OUT" "closed — a team stands for a live epic"

# An epic root In Review means every child is closed (parent-check's rollup):
# a lead respawned into it would only confirm completion. Same clean rc 4.
cat >"$FAKE_BOARD_FIXTURES/get.921.json" <<'EOF'
{"number":921,"title":"Complete epic","issueState":"OPEN","state":"In Review","children":[{"number":922,"title":"done child"}]}
EOF
run_wt 921
is "complete epic (In Review): clean refusal (rc 4)" "4" "$RC"
line_has "complete epic: the refusal says why" "$OUT" "no team to stand up"

run_wt
is "no epic, non-TTY: refuses (64)" "64" "$RC"
line_has "no epic, non-TTY: no default epic exists" "$OUT" "there is no default epic"

run_wt 900 --bogus
is "unknown flag: dies" "1" "$RC"
line_has "unknown flag: named" "$OUT" "unknown argument '--bogus'"

WT_FLEET=9
run_wt 900
unset WT_FLEET
is "fleet cap: above 4 dies" "1" "$RC"
line_has "fleet cap: the refusal names the cap" "$OUT" "hard cap of 4"

RC=0
OUT=$(RALPH_HERDR_REPO="$REPO_DIR" RALPH_HERDR_BOARD="$BIN/board" \
  ANTHROPIC_API_KEY=sk-test bash "$SCRIPTS/work-team.sh" 900 </dev/null 2>&1) || RC=$?
is "billing guard: a stray API key refuses (rc 3)" "3" "$RC"

# ═══ 7. no ready children: the lead stands alone ═════════════════════════════
cat >"$FAKE_BOARD_FIXTURES/frontier.json" <<'EOF'
{"frontier":[{"number":77,"title":"Stranger","parentNumber":null}],"blocked":[]}
EOF
run_wt 900
is "no ready children: exits 0" "0" "$RC"
line_has "no ready children: the lead stands alone, honestly" "$OUT" "the lead stands alone"

# ═══ 8. spawn_work_session ignores a malformed TEAM_LEAD ═════════════════════
# (unit-level, sourced: the injection is parse-gated because the value lands
# on a shell command line.)
export RALPH_HERDR_REPO="$REPO_DIR"
export RALPH_HERDR_BOARD="$BIN/board"
export RALPH_HERDR_LEDGER="$WTL"
# shellcheck source=../scripts/lib.sh
. "$SCRIPTS/lib.sh"
set +e
set +o pipefail
QUEUE='{"next":{"number":901,"title":"Unit A","parentNumber":900},"queue":[]}'
out=$(RALPH_HERDR_DRY_RUN=true RALPH_HERDR_TEAM_LEAD='$(rm -rf /)' spawn_work_session 901 "$QUEUE" 2>&1)
line_lacks "malformed TEAM_LEAD: never printed into the pane-run plan" "$out" "pane run"
out=$(RALPH_HERDR_DRY_RUN=true RALPH_HERDR_TEAM_LEAD='o900-lead' spawn_work_session 901 "$QUEUE" 2>&1)
line_has "grammar-B TEAM_LEAD: injected into the plan" "$out" "export RALPH_HERDR_LEAD=o900-lead RALPH_HERDR_TEAM_LEAD=o900-lead"

echo
echo "# work-team: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
