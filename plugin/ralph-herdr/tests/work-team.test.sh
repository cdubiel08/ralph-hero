#!/usr/bin/env bash
# work-team.test.sh — executable tests for TEAM LAUNCH (GH-2214, unit F of
# #2208; supersedes the GH-2178 lead+fleet form): the lead-only spawn plan,
# its idempotence against a standing lead, the refusal of a worker issue
# list (D3.2 — the lead staffs its own workers), the chain-of-command env
# (SPAWNER_ROLE, TEAM_LEAD_REF), and spawn_work_session's lineage stamping
# from a lead's env.
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

# A real repo with a local origin (lib.sh resolves REPO; the lineage unit
# tests below reach ralph_branch_for_issue).
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

# The epic. No frontier read happens here any more — staffing is the lead's
# act (work-fleet --epic), not this script's.
cat >"$FAKE_BOARD_FIXTURES/get.900.json" <<'EOF'
{"number":900,"title":"Teams dispatch and inbox","issueState":"OPEN","state":"In Progress",
 "children":[{"number":901},{"number":902},{"number":903}],"childrenTruncated":false}
EOF
# The chain-of-command addresses, derived from `board name` (GH-2209): the
# lead's own o-lane address and the dispatch seat's.
cat >"$FAKE_BOARD_FIXTURES/name.900.json" <<'EOF'
{"number":900,"kind":"feat","lane":"o","branch":"feat/900-teams-dispatch-and-inbox",
 "worktree":"feat-900-teams-dispatch-and-inbox","agent":"o900-teams-dispatch-and-inbox",
 "legacyBranch":"feature/GH-900","team":"t900-teams-dispatch-and-inbox","teamEpic":900,
 "address":"fake-repo/t900-teams-dispatch-and-inbox/o900-teams-dispatch-and-inbox"}
EOF
cat >"$FAKE_BOARD_FIXTURES/name.dispatch.json" <<'EOF'
{"repo":"fake-repo","address":"fake-repo/dispatch"}
EOF

WTL="$TMP/ledger/ledger.jsonl"
mkdir -p "$TMP/ledger"
: >"$WTL"

run_wt() {
  RC=0
  OUT=$(RALPH_HERDR_REPO="$REPO_DIR" RALPH_HERDR_BOARD="$BIN/board" \
    RALPH_HERDR_LEDGER="$WTL" RALPH_HERDR_DRY_RUN=true ANTHROPIC_API_KEY= \
    bash "$SCRIPTS/work-team.sh" "$@" </dev/null 2>&1) || RC=$?
}

# ═══ 1. the dry-run lead plan — lead only, chain-of-command env ══════════════
run_wt 900
is "team dry: exits 0" "0" "$RC"
line_has "team dry: plans the lead spawn" "$OUT" "DRY RUN — would spawn the lead for GH-900"
line_has "team dry: the lead is the o-lane grammar-B name" "$OUT" "agent: o900-teams-dispatch-and-inbox"
line_has "team dry: the pane is a workspace create (the one --env channel)" \
  "$OUT" "workspace create"
line_has "team dry: the lead's own address rides --env RALPH_HERDR_LEAD" \
  "$OUT" "--env RALPH_HERDR_LEAD=o900-teams-dispatch-and-inbox"
line_has "team dry: the lead propagates itself as TEAM_LEAD" \
  "$OUT" "--env RALPH_HERDR_TEAM_LEAD=o900-teams-dispatch-and-inbox"
line_has "team dry: the lead's durable ref rides the env (worker lineage, GH-2214)" \
  "$OUT" "--env RALPH_HERDR_TEAM_LEAD_REF=o900-teams-dispatch-and-inbox#"
line_has "team dry: the dispatch seat rides the env (chain of command, GH-2217)" \
  "$OUT" "--env WHO_DISPATCH=fake-repo/dispatch"
line_has "team dry: the lead states its role for the fleet's spawn-edge guard" \
  "$OUT" "--env RALPH_HERDR_SPAWNER_ROLE=orchestrator"
line_has "team dry: the lead's own spawns will record invoked_by=agent" \
  "$OUT" "--env RALPH_HERDR_INVOKED_BY=agent"
line_has "team dry: the editing tools are cut from the lead's harness (GH-2265, read from the role registry)" \
  "$OUT" "-- --disallowedTools Edit,Write,NotebookEdit"
line_has "team dry: the prompt names the lead's own staffing path" \
  "$OUT" "work-fleet.sh --epic 900"
line_has "team dry: the prompt names the self-dissolve final act (D3.3, GH-2215)" \
  "$OUT" "on epic Done, self-dissolve via workspace close"

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
# GH-2210/GH-2235: the team-space label is the team address's DISPLAY suffix
# — `t<epic>-<slug>`, the repo segment dropped (the sidebar's container shows
# it) — while the lead's o-lane ADDRESS stays absolute in the token.
line_has "team dry: workspace label is the team display suffix" \
  "$OUT" 'workspace label: t900-teams-dispatch-and-inbox'
is "lead record: workspace_label is the team display suffix" \
  "t900-teams-dispatch-and-inbox" "$(jqr '.lineage.herdr.workspace_label')"
is "lead record: address token is the lead's o-lane address (D0.4)" \
  "fake-repo/t900-teams-dispatch-and-inbox/o900-teams-dispatch-and-inbox" "$(jqr '.tokens.address')"

line_lacks "team dry: no workers spawned — the lead staffs its own (D3.2)" "$OUT" "handing"
line_lacks "team dry: no work-fleet delegation from here" "$OUT" "would spawn GH-901"
is "team dry: ledger untouched by a plan" "0" "$(wc -c <"$WTL" | tr -d ' ')"
is "team dry: no herdr mutation planned-then-performed" "0" \
  "$(grep -c 'workspace create' "$FAKE_HERDR_LOG" || true)"

# ═══ 2. a worker issue list is REFUSED (D3.2) ════════════════════════════════
run_wt 900 901
is "worker list: dies" "1" "$RC"
line_has "worker list: the refusal names the lead's own staffing path" \
  "$OUT" "work-fleet.sh --epic 900"
line_has "worker list: the out-of-team lane is named" "$OUT" "work-fleet.sh 901"

# ═══ 3. --lead-only: accepted for compatibility, same behavior ═══════════════
run_wt 900 --lead-only
is "lead-only: exits 0" "0" "$RC"
line_has "lead-only: the lead is planned" "$OUT" "would spawn the lead for GH-900"
line_lacks "lead-only: nothing handed to work-fleet" "$OUT" "handing"

# ═══ 4. idempotence: a standing lead is never doubled ════════════════════════
herd_fixture '[{"name":"o900-existing-lead","agent_status":"working","pane_id":"p9"}]' "$REPO_DIR"
run_wt 900
is "standing lead: exits 0" "0" "$RC"
line_has "standing lead: named, not doubled" "$OUT" "lead o900-existing-lead already standing"
line_lacks "standing lead: no second lead planned" "$OUT" "would spawn the lead"
herd_fixture '[]' "$REPO_DIR"

# ═══ 5. refusals ═════════════════════════════════════════════════════════════
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

RC=0
OUT=$(RALPH_HERDR_REPO="$REPO_DIR" RALPH_HERDR_BOARD="$BIN/board" \
  ANTHROPIC_API_KEY=sk-test bash "$SCRIPTS/work-team.sh" 900 </dev/null 2>&1) || RC=$?
is "billing guard: a stray API key refuses (rc 3)" "3" "$RC"

# ═══ 6. address degradation: an older board copy costs chrome, never spawn ═══
rm -f "$FAKE_BOARD_FIXTURES/name.900.json" "$FAKE_BOARD_FIXTURES/name.dispatch.json"
printf '' >"$FAKE_BOARD_FIXTURES/name.dispatch.json" # unparseable → no address
run_wt 900
is "no derivable addresses: the spawn still plans (rc 0)" "0" "$RC"
line_has "no derivable addresses: the lead is still planned" "$OUT" "would spawn the lead for GH-900"
cat >"$FAKE_BOARD_FIXTURES/name.900.json" <<'EOF'
{"number":900,"kind":"feat","lane":"o","branch":"feat/900-teams-dispatch-and-inbox",
 "worktree":"feat-900-teams-dispatch-and-inbox","agent":"o900-teams-dispatch-and-inbox",
 "legacyBranch":"feature/GH-900","team":"t900-teams-dispatch-and-inbox","teamEpic":900,
 "address":"fake-repo/t900-teams-dispatch-and-inbox/o900-teams-dispatch-and-inbox"}
EOF

# ═══ 7. spawn_work_session lineage from a lead's env (GH-2214) ═══════════════
# (unit-level, sourced: TEAM_LEAD injection is parse-gated because the value
# lands on a shell command line; TEAM_LEAD_REF is ref-gated because it lands
# in a ledger record.)
export RALPH_HERDR_REPO="$REPO_DIR"
export RALPH_HERDR_BOARD="$BIN/board"
export RALPH_HERDR_LEDGER="$WTL"
# shellcheck source=../scripts/lib.sh
. "$SCRIPTS/lib.sh"
set +e
set +o pipefail
QUEUE='{"next":{"number":901,"title":"Unit A","parentNumber":900},"queue":[]}'
out=$(RALPH_HERDR_DRY_RUN=true RALPH_HERDR_TEAM_LEAD='$(rm -rf /)' spawn_work_session 901 "$QUEUE" 2>&1)
line_lacks "malformed TEAM_LEAD: never printed into the pane-run plan" "$out" "RALPH_HERDR_LEAD="
line_lacks "malformed TEAM_LEAD: no WHO_LEAD invented from it" "$out" "WHO_LEAD="
out=$(RALPH_HERDR_DRY_RUN=true RALPH_HERDR_TEAM_LEAD='o900-lead' spawn_work_session 901 "$QUEUE" 2>&1)
line_has "grammar-B TEAM_LEAD: injected into the plan" "$out" "export RALPH_HERDR_LEAD=o900-lead RALPH_HERDR_TEAM_LEAD=o900-lead"
# Chain of command (GH-2217): the pane env carries the worker's own address
# and the dispatch seat, derived from the one `board name` read. The canned
# fixture's address is FLAT (no team segment), so no WHO_LEAD is derivable —
# a lead address minted for a team the address does not name would be wrong.
line_has "chain of command: own address rides the pane env" "$out" "RALPH_HERDR_ADDRESS=fake-repo/w901-fake-issue"
line_has "chain of command: dispatch derived from the repo segment" "$out" "WHO_DISPATCH=fake-repo/dispatch"
line_lacks "flat address: no WHO_LEAD minted without a matching team segment" "$out" "WHO_LEAD="
# A team-segment address whose epic MATCHES the lead's number derives WHO_LEAD.
cat >"$FAKE_BOARD_FIXTURES/name.901.json" <<'EOF'
{"number":901,"kind":"feat","lane":"w","branch":"feat/901-unit-a","worktree":"feat-901-unit-a",
 "agent":"w901-unit-a","legacyBranch":"feature/GH-901","team":"t900-teams","teamEpic":900,
 "address":"fake-repo/t900-teams/w901-unit-a"}
EOF
out=$(RALPH_HERDR_DRY_RUN=true RALPH_HERDR_TEAM_LEAD='o900-lead' spawn_work_session 901 "$QUEUE" 2>&1)
line_has "team address + matching lead: WHO_LEAD derived from the team segment" \
  "$out" "WHO_LEAD=fake-repo/t900-teams/o900-lead"
# Out-vars need the CURRENT shell (a $() capture is a subshell): the brief
# writer reads these, so the pane env and the brief share one derivation.
RALPH_HERDR_DRY_RUN=true RALPH_HERDR_TEAM_LEAD='o900-lead' spawn_work_session 901 "$QUEUE" >/dev/null 2>&1
is "who out-var: brief writer sees the same lead derivation" \
  "fake-repo/t900-teams/o900-lead" "$RALPH_HERDR_SPAWNED_WHO_LEAD"
is "who out-var: brief writer sees the same dispatch derivation" \
  "fake-repo/dispatch" "$RALPH_HERDR_SPAWNED_WHO_DISPATCH"
# An epic/lead mismatch (a lead staffing an out-of-team unit) mints nothing.
out=$(RALPH_HERDR_DRY_RUN=true RALPH_HERDR_TEAM_LEAD='o777-other' spawn_work_session 901 "$QUEUE" 2>&1)
line_lacks "epic/lead mismatch: no WHO_LEAD minted" "$out" "WHO_LEAD="
rm -f "$FAKE_BOARD_FIXTURES/name.901.json"

# A lead-spawned worker records the lead's ref as parent AND root, depth 1 —
# the C8 lineage unit I's readers read (D4.1).
out=$(RALPH_HERDR_DRY_RUN=true RALPH_HERDR_TEAM_LEAD_REF='o900-lead#0000abcd' spawn_work_session 901 "$QUEUE" 2>&1)
wrec=$(printf '%s\n' "$out" | sed -n 's/^  ledger append (spawn): //p' | head -1)
is "lead-spawned worker: parent is the lead's ref" "o900-lead#0000abcd" \
  "$(jq -r '.tokens.parent // empty' <<<"$wrec" 2>/dev/null)"
is "lead-spawned worker: root is the lead's ref" "o900-lead#0000abcd" \
  "$(jq -r '.tokens.root // empty' <<<"$wrec" 2>/dev/null)"
is "lead-spawned worker: depth 1" "1" "$(jq -r '.tokens.depth // empty' <<<"$wrec" 2>/dev/null)"

# A ref whose name half does not parse, or with no epoch, stamps nothing —
# the spawn proceeds as a depth-0 root (lineage is chrome, never the spawn).
out=$(RALPH_HERDR_DRY_RUN=true RALPH_HERDR_TEAM_LEAD_REF='not a ref' spawn_work_session 901 "$QUEUE" 2>&1)
wrec=$(printf '%s\n' "$out" | sed -n 's/^  ledger append (spawn): //p' | head -1)
line_has "malformed TEAM_LEAD_REF: warned, not fatal" "$out" "not a durable ref"
is "malformed TEAM_LEAD_REF: worker stays a depth-0 root" "0" \
  "$(jq -r '.tokens.depth // empty' <<<"$wrec" 2>/dev/null)"
is "malformed TEAM_LEAD_REF: no parent token invented" "" \
  "$(jq -r '.tokens.parent // empty' <<<"$wrec" 2>/dev/null)"

echo
echo "# work-team: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
