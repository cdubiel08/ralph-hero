#!/usr/bin/env bash
# doctor-labels.test.sh — tests for scripts/doctor-labels.sh (TAP-ish).
#
#   bash plugin/ralph-herdr/tests/doctor-labels.test.sh
#
# Uses the shared fake herdr with hand-built snapshot fixtures (the herd
# builder pins one workspace label, and the label IS this suite's subject)
# plus RALPH_HERDR_LEDGER fixtures under $TMP. bash 3.2 compatible.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOCTOR="$SCRIPT_DIR/../scripts/doctor-labels.sh"

TMP=$(mktemp -d "${TMPDIR:-/tmp}/ralph-labels-test.XXXXXX") || exit 1
trap 'rm -rf "$TMP"' EXIT

export HERDR_BIN_PATH="$SCRIPT_DIR/fake-herdr.sh"
export FAKE_HERDR_FIXTURES="$TMP/fixtures"
mkdir -p "$FAKE_HERDR_FIXTURES"

REPO_DIR="$TMP/repo"
mkdir -p "$REPO_DIR"
printf '{"owner":"acme","repo":"demo","projectNumber":1}\n' >"$REPO_DIR/.ralph.json"

export RALPH_HERDR_LEDGER="$TMP/ledger.jsonl"

n=0 pass=0 fail=0
ok()     { n=$((n + 1)); pass=$((pass + 1)); echo "ok $n - $1"; }
not_ok() { n=$((n + 1)); fail=$((fail + 1)); echo "not ok $n - $1"; }
is() {
  if [ "$2" = "$3" ]; then ok "$1"; else not_ok "$1 — expected '$2', got '$3'"; fi
}
has_line() {
  if printf '%s\n' "$OUT" | grep -q "$2"; then ok "$1"; else not_ok "$1 — no line matching '$2' in: $OUT"; fi
}

# snapshot AGENTS_JSON WORKSPACES_JSON — a protocol-valid snapshot whose
# workspaces carry the LABELS under test. Every workspace gets in-scope
# worktree provenance (repo_root = $REPO_DIR) so the scoped join keeps its
# agents; agents name their workspace_id explicitly.
snapshot() {
  jq -nc --argjson agents "$1" --argjson wss "$2" --arg root "$REPO_DIR" '
    def complete($i):
      {name: null, agent_status: "unknown", workspace_id: "wR",
       pane_id: ("p" + ($i | tostring)), tab_id: "t1",
       terminal_id: ("term" + ($i | tostring)), focused: false, revision: 1};
    {snapshot: {
      version: 1, protocol: 19,
      workspaces: [$wss[] | {workspace_id: .id, number: 1, label: .label,
                             focused: false, pane_count: 1, tab_count: 1,
                             active_tab_id: "t1", agent_status: "unknown",
                             worktree: {repo_key: "test/repo", repo_name: "repo",
                                        repo_root: $root, checkout_path: $root,
                                        is_linked_worktree: false}}],
      tabs: [{tab_id: "t1"}],
      panes: [$agents | to_entries[] | (complete(.key) + .value)
              | {pane_id, terminal_id, workspace_id, tab_id, focused,
                 agent_status, revision, cwd: $root, tokens: {}}],
      layouts: [],
      agents: [$agents | to_entries[] | complete(.key) + .value]
    }}' >"$FAKE_HERDR_FIXTURES/api-snapshot.json"
}
run() {
  RC=0
  OUT=$(bash "$DOCTOR" 2>&1) || RC=$?
}

NOW=$(date -u +%FT%TZ)

# ── canonical: worker label equals the stamped address ───────────────────────
cat >"$RALPH_HERDR_LEDGER" <<EOF
{"ts":"$NOW","ev":"spawn","agent_ref":"w123-fix#aaaa","pane_id":"p0","tokens":{"issue":"123","address":"demo/w123-fix"}}
EOF
snapshot '[{"name":"w123-fix","agent_status":"working","workspace_id":"w1"}]' \
  '[{"id":"w1","label":"demo/w123-fix"}]'
run
is "canonical worker label exits 0" "0" "$RC"
has_line "canonical worker label is ok" '^  ok   label-w123-fix '

# ── canonical: lead in the team space (label = the address team prefix) ──────
cat >"$RALPH_HERDR_LEDGER" <<EOF
{"ts":"$NOW","ev":"spawn","agent_ref":"o9-epic#bbbb","pane_id":"p0","tokens":{"issue":"9","address":"demo/t9-epic/o9-epic"}}
EOF
snapshot '[{"name":"o9-epic","agent_status":"working","workspace_id":"w2"}]' \
  '[{"id":"w2","label":"demo/t9-epic"}]'
run
is "team-space lead label exits 0" "0" "$RC"
has_line "team prefix matches the lead's derivation" '^  ok   label-o9-epic '

# ── divergence: a legacy label against a stamped address → GAP, exit 1 ───────
cat >"$RALPH_HERDR_LEDGER" <<EOF
{"ts":"$NOW","ev":"spawn","agent_ref":"w123-fix#aaaa","pane_id":"p0","tokens":{"issue":"123","address":"demo/w123-fix"}}
EOF
snapshot '[{"name":"w123-fix","agent_status":"working","workspace_id":"w1"}]' \
  '[{"id":"w1","label":"GH-123 via GH-45"}]'
run
is "diverged label exits 1" "1" "$RC"
has_line "diverged label is a GAP naming both spellings" \
  "^  GAP  label-w123-fix .*'GH-123 via GH-45' diverges from the derived address 'demo/w123-fix'"
has_line "the remedy names the respawn" 'a respawn under the current plugin re-derives'

# ── a flat address never accepts a bare-repo label as its team prefix ────────
snapshot '[{"name":"w123-fix","agent_status":"working","workspace_id":"w1"}]' \
  '[{"id":"w1","label":"demo"}]'
run
is "bare repo segment is not a canonical flat label" "1" "$RC"

# ── pre-grammar record: no address token → counted, never flagged ────────────
cat >"$RALPH_HERDR_LEDGER" <<EOF
{"ts":"$NOW","ev":"spawn","agent_ref":"w7-old#cccc","pane_id":"p0","tokens":{"issue":"7"}}
EOF
snapshot '[{"name":"w7-old","agent_status":"working","workspace_id":"w1"}]' \
  '[{"id":"w1","label":"GH-7 via GH-2"}]'
run
is "pre-grammar record exits 0" "0" "$RC"
has_line "pre-grammar record is counted, not flagged" 'predate the address grammar'

# ── a dead agent's workspace label is moot ───────────────────────────────────
cat >"$RALPH_HERDR_LEDGER" <<EOF
{"ts":"$NOW","ev":"spawn","agent_ref":"w99-gone#dddd","pane_id":"p0","tokens":{"issue":"99","address":"demo/w99-gone"}}
EOF
snapshot '[]' '[{"id":"w1","label":"whatever"}]'
run
is "no live agent exits 0" "0" "$RC"

# ── no herdr → not evaluable, exit 2 ─────────────────────────────────────────
RC=0
OUT=$(HERDR_BIN_PATH="$TMP/does-not-exist" bash "$DOCTOR" 2>&1) || RC=$?
is "missing herdr exits 2" "2" "$RC"
has_line "missing herdr is not evaluable" 'not evaluable'

# ── arguments are refused ────────────────────────────────────────────────────
RC=0
OUT=$(bash "$DOCTOR" --nope 2>&1) || RC=$?
is "arguments are refused with 64" "64" "$RC"

echo "1..$n"
echo "# doctor-labels: $pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
