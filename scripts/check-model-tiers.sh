#!/usr/bin/env bash
#
# check-model-tiers.sh — assert ralph's model pins match .ralph-models.yml (GH-1593)
#
# Mirrors check-doc-rosters.sh's shape: resolve the repo root, run a checker,
# tally PASS/FAIL, exit 0/1. Two sections:
#   1. Pin drift (scripts/model-tiers/render.js --check) — frontmatter
#      equality, dispatch-literal multiset equality, and a completeness
#      sweep that fails on any unmanifested `model:`/`model="..."` pin.
#   2. Doc-table drift (docs/model-tier-policy.md's "| Signal | Tier |
#      Model |" table) — reads expected values via
#      `render.js --print-tier-table`, never a second hand-duplicated
#      tier->model mapping (that would itself be the "two parsers of one
#      YAML" drift risk this config exists to eliminate). This closes the
#      gap CLAUDE.md previously claimed was already covered by
#      check-doc-rosters.sh — it was not (that script checks agent/skill/
#      tool rosters only); GH-1593 builds the guarantee here.
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
# Section 2: doc-table drift (docs/model-tier-policy.md), added GH-1593 Phase 2
# ---------------------------------------------------------------------------
echo ""
echo "=== Model-tier policy doc table (docs/model-tier-policy.md <-> .ralph-models.yml) ==="

POLICY_DOC="docs/model-tier-policy.md"

if [ ! -f "$POLICY_DOC" ]; then
  fail "${POLICY_DOC} not found"
else
  # Expected tier->model mapping for the skill surface, straight from
  # render.js's own resolveTier() — not re-declared here, so there is no
  # third parser of the tier->model relationship to drift.
  expected_table=$(cd "$MODEL_TIERS_DIR" && node render.js --print-tier-table --root "$REPO_ROOT" --surface skill)

  # Extract the "| Signal | Tier | Model |" table's Tier/Model columns (the
  # "## The rule" section). The table's row shape is
  # "| <signal> | <tier> | <model> |"; skip the header separator row and any
  # row whose Tier column isn't a bare tier name (the
  # "capable→frontier" transition row documents a range, not a single
  # resolvable tier, and is intentionally not a doc-table drift site).
  doc_rows=$(
    awk '/^\| Signal /{f=1; next} /^$/{f=0} f' "$POLICY_DOC" \
      | grep -E '^\|' \
      | grep -vE '^\| *-' \
      | awk -F'|' '{gsub(/^[ \t]+|[ \t]+$/, "", $3); gsub(/^[ \t]+|[ \t]+$/, "", $4); print $3 "::" $4}'
  )

  doc_fail=0
  while IFS= read -r row; do
    [ -z "$row" ] && continue
    tier="${row%%::*}"
    model="${row##*::}"
    expected=$(echo "$expected_table" | grep "^${tier}:" | cut -d: -f2 || true)
    [ -z "$expected" ] && continue # not a bare tier name (e.g. "capable→frontier") — skip
    # The doc's Model column uses "/" for a two-value cell (e.g. "best / fable").
    if [[ "$model" != *"$expected"* ]]; then
      fail "docs/model-tier-policy.md: tier '${tier}' documents model '${model}', expected to contain '${expected}' (render.js --print-tier-table, skill surface)"
      doc_fail=1
    fi
  done <<< "$doc_rows"

  if [ "$doc_fail" -eq 0 ]; then
    pass "docs/model-tier-policy.md tier table matches .ralph-models.yml's default harness"
  fi
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
