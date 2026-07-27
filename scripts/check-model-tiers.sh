#!/usr/bin/env bash
#
# check-model-tiers.sh — assert ralph's model pins match .ralph-models.yml (GH-1593)
#
# Mirrors check-doc-rosters.sh's shape: resolve the repo root, run a checker,
# tally PASS/FAIL, exit 0/1.
#
# Section 1 (this phase): pin drift (scripts/model-tiers/render.js --check)
# — frontmatter equality, dispatch-literal multiset equality, and a
# completeness sweep that fails on any unmanifested `model:`/`model="..."`
# pin. A Phase 2 doc-table drift section (docs/model-tier-policy.md) is
# added later in the same GH-1593 PR.
#
# Exits 0 when the tree matches the config, 1 otherwise.

set -euo pipefail

REPO_ROOT=$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)
cd "$REPO_ROOT"

PASS=0
FAIL=0

pass() {
  echo "  PASS: $1"
  PASS=$((PASS + 1))
}

fail() {
  echo "  FAIL: $1"
  FAIL=$((FAIL + 1))
}

# ---------------------------------------------------------------------------
# Section 1: pin drift (render.js --check)
# ---------------------------------------------------------------------------
echo "=== Model-tier pin drift (.ralph-models.yml <-> ralph/skills,agents) ==="

MODEL_TIERS_DIR="$REPO_ROOT/scripts/model-tiers"

if [ ! -d "$MODEL_TIERS_DIR/node_modules" ]; then
  ( cd "$MODEL_TIERS_DIR" && npm ci --silent )
fi

if ( cd "$MODEL_TIERS_DIR" && node render.js --check --root "$REPO_ROOT" ); then
  pass "model-tier pins match .ralph-models.yml (default harness)"
else
  fail "model-tier pins diverge from .ralph-models.yml — see render.js --check output above"
fi

# ---------------------------------------------------------------------------
# Results
# ---------------------------------------------------------------------------
echo ""
echo "=== Results ==="
echo "PASS: $PASS"
echo "FAIL: $FAIL"

if [ "$FAIL" -ne 0 ]; then
  echo "Model-tier config diverges from ralph/ pins. Run 'node scripts/model-tiers/render.js --write' to reconcile, or hand-edit the drifted site."
  exit 1
fi
echo "All model-tier checks are consistent with .ralph-models.yml."
exit 0
