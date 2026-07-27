#!/bin/bash
# ralph/hooks/scripts/__tests__/plan-research-required.test.sh
# Tests for the estimate-aware plan-research-required.sh gate.
#
# Strategy: invoke the hook with crafted PreToolUse:Write JSON on stdin inside a
# TMPDIR sandbox (CLAUDE_PROJECT_DIR override) so get_project_root /
# find_existing_artifact resolve deterministically, and assert exit codes:
#   0 = allowed (early-allow, waiver, or research-exists)
#   2 = blocked (research required)

set -euo pipefail

HOOK="$(cd "$(dirname "$0")/.." && pwd)/plan-research-required.sh"

PASS=0
FAIL=0

pass() { echo "  PASS: $1"; ((PASS++)) || true; }
fail() { echo "  FAIL: $1"; ((FAIL++)) || true; }

# Sandbox project root. research/ stays empty except for the one fixture below.
# The .git marker makes $SBX a repo root for resolve_root_from_path, so existing
# cases (file paths under $SBX) root at $SBX explicitly, not via env fallback.
SBX="$(mktemp -d)"
# Second sandbox: a distinct repo tree for the path-derived rooting repro (GH-1556).
REPO="$(mktemp -d)"
# Third sandbox: a tree with NO .git ancestor, to exercise the env fallback.
NOGIT="$(mktemp -d)"
trap 'rm -rf "$SBX" "$REPO" "$NOGIT"' EXIT
mkdir -p "$SBX/.git" "$SBX/thoughts/shared/research" "$SBX/thoughts/shared/plans" "$SBX/src"
# Fixture research doc — matches ticket GH-1 only.
touch "$SBX/thoughts/shared/research/2026-05-24-GH-1-research.md"
mkdir -p "$REPO/.git" "$REPO/thoughts/shared/research" "$REPO/thoughts/shared/plans"
# Fixture research doc in the second repo — matches ticket GH-9 only.
touch "$REPO/thoughts/shared/research/2026-07-19-GH-9-research.md"
mkdir -p "$NOGIT/thoughts/shared/plans"

# run_case <desc> <expected_exit> <file_path> <content> [ENV=val ...]
run_case() {
  local desc="$1" expected="$2" fp="$3" content="$4"; shift 4
  local json actual
  json=$(jq -n --arg fp "$fp" --arg c "$content" \
    '{tool_input: {file_path: $fp, content: $c}}')
  set +e
  CLAUDE_PROJECT_DIR="$SBX" env "$@" bash "$HOOK" <<<"$json" >/dev/null 2>&1
  actual=$?
  set -e
  if [[ "$actual" == "$expected" ]]; then
    pass "$desc (exit $actual)"
  else
    fail "$desc — expected exit $expected, got $actual"
  fi
}

PLANS="$SBX/thoughts/shared/plans"

echo "=== plan-research-required gate tests ==="
echo ""

# --- Early-allow paths ---------------------------------------------------------
run_case "non-/plans/ path allows" 0 \
  "$SBX/src/notes.md" $'---\nestimate: M\n---'
run_case "/plans/ path with no GH token allows" 0 \
  "$PLANS/2026-05-24-adhoc.md" $'---\nestimate: M\n---'
run_case "research doc exists allows (even at M)" 0 \
  "$PLANS/2026-05-24-GH-1-x.md" $'---\nestimate: M\n---'
run_case "RALPH_REQUIRES_RESEARCH=false allows" 0 \
  "$PLANS/2026-05-24-GH-2-x.md" $'---\nestimate: M\n---' RALPH_REQUIRES_RESEARCH=false

# --- Estimate-threshold waiver (default threshold M) ---------------------------
run_case "estimate S below default M allows" 0 \
  "$PLANS/2026-05-24-GH-2-x.md" $'---\nestimate: S\n---'
run_case "estimate M at default threshold blocks" 2 \
  "$PLANS/2026-05-24-GH-2-x.md" $'---\nestimate: M\n---'

# --- Human-override waiver -----------------------------------------------------
run_case "research_waived present allows (even at M)" 0 \
  "$PLANS/2026-05-24-GH-2-x.md" $'---\nestimate: M\nresearch_waived: human-approved\n---'

# --- Threshold override --------------------------------------------------------
run_case "MIN=S + estimate S blocks (threshold raised)" 2 \
  "$PLANS/2026-05-24-GH-2-x.md" $'---\nestimate: S\n---' RALPH_RESEARCH_REQUIRED_MIN_ESTIMATE=S
run_case "MIN=S + estimate XS allows" 0 \
  "$PLANS/2026-05-24-GH-2-x.md" $'---\nestimate: XS\n---' RALPH_RESEARCH_REQUIRED_MIN_ESTIMATE=S

# --- Safe-default block --------------------------------------------------------
run_case "no estimate + no waiver + no research blocks" 2 \
  "$PLANS/2026-05-24-GH-2-x.md" $'---\ndate: 2026-05-24\ntype: plan\n---'

# --- Plan-of-plans carve-out (GH-1605) ------------------------------------------
# The fixtures below deliberately KEEP a GH-NNN token in the filename. The hook's
# rule 3 ("no GH-NNNN token in the path -> allow") fires BEFORE the carve-out and
# before the research lookup, so a token-free fixture path would exit 0 at rule 3
# and every exit-2 fence assertion here would become a false green. What the
# fence cases actually need is a token whose research doc does NOT exist (rule 4
# would otherwise allow first). Assert that precondition explicitly rather than
# leaving it to whoever next adds a research fixture.
for tok in GH-3 GH-4 GH-5 GH-6 GH-8 GH-10 GH-11 GH-12 GH-13 GH-14 GH-15; do
  if compgen -G "$SBX/thoughts/shared/research/*${tok}-*" >/dev/null 2>&1; then
    fail "fence-branch precondition: a research doc exists for $tok, so rule 4 allows before the fence parser runs"
  fi
done
pass "fence-branch fixtures carry a GH token with no matching research doc (rules 3 and 4 both fall through)"

run_case "plan-of-plans type: frontmatter allows without research doc" 0 \
  "$PLANS/2026-07-26-GH-3-epic.md" $'---\ntype: plan-of-plans\nestimate: L\n---\n\n## Feature Decomposition\n'
run_case "## Feature Decomposition heading (no type:) allows without research doc" 0 \
  "$PLANS/2026-07-26-GH-4-epic.md" $'---\nestimate: L\n---\n\n## Feature Decomposition\n'
run_case "fence-wrapped plan-of-plans example does NOT carve out (ordinary plan still blocked)" 2 \
  "$PLANS/2026-07-26-GH-5-plan.md" $'---\nestimate: M\n---\n\nExample shape:\n```markdown\ntype: plan-of-plans\n## Feature Decomposition\n```\n'
# Same fixture with the OTHER CommonMark fence style. Stripping only backticks
# left a hole: a ~~~-wrapped example still exposed the marker strings and
# waived research for an ordinary plan.
run_case "TILDE-fenced plan-of-plans example does NOT carve out (ordinary plan still blocked)" 2 \
  "$PLANS/2026-07-26-GH-6-plan.md" $'---\nestimate: M\n---\n\nExample shape:\n~~~markdown\ntype: plan-of-plans\n## Feature Decomposition\n~~~\n'
# Control: an UNFENCED plan-of-plans still carves out — the tilde fix must not
# break the real waiver, only the quoted-example false positive.
run_case "unfenced plan-of-plans still carves out after the tilde fix" 0 \
  "$PLANS/2026-07-26-GH-8-epic.md" $'---\ntype: plan-of-plans\nestimate: L\n---\n\n## Feature Decomposition\n'
# Mixed styles: a ~~~ block containing ``` lines (and vice versa) must not
# desync the fence tracker and leak the inner markers.
run_case "tilde fence wrapping a backtick fence does NOT carve out" 2 \
  "$PLANS/2026-07-26-GH-10-plan.md" $'---\nestimate: M\n---\n\nExample:\n~~~markdown\n```\ntype: plan-of-plans\n```\n~~~\n'
# Malformed closers (CommonMark: a closing fence carries NO info string — only
# trailing whitespace). Closing on any same-character prefix let ```not-a-closer
# end the block early and expose the marker lines that follow it, waiving
# research for an ordinary plan.
run_case "malformed backtick closer (\`\`\`not-a-closer) does NOT end the fence" 2 \
  "$PLANS/2026-07-26-GH-11-plan.md" $'---\nestimate: M\n---\n\nExample:\n```markdown\nsome example body\n```not-a-closer\ntype: plan-of-plans\n```\n'
run_case "malformed tilde closer (~~~not-a-closer) does NOT end the fence" 2 \
  "$PLANS/2026-07-26-GH-12-plan.md" $'---\nestimate: M\n---\n\nExample:\n~~~markdown\nsome example body\n~~~not-a-closer\ntype: plan-of-plans\n~~~\n'
# Mixed-fence nesting where the INNER fence is itself malformed: the inner
# marker is a different character, so it can never close the outer block no
# matter what follows it.
run_case "backtick fence wrapping a malformed tilde fence does NOT carve out" 2 \
  "$PLANS/2026-07-26-GH-13-plan.md" $'---\nestimate: M\n---\n\nExample:\n```markdown\n~~~not-a-closer\ntype: plan-of-plans\n~~~\n```\n'
run_case "tilde fence wrapping a malformed backtick fence does NOT carve out" 2 \
  "$PLANS/2026-07-26-GH-14-plan.md" $'---\nestimate: M\n---\n\nExample:\n~~~markdown\n```not-a-closer\ntype: plan-of-plans\n```\n~~~\n'
# Positive control: the stricter closer must still CLOSE on a well-formed fence
# (bare marker + optional trailing whitespace). A real plan-of-plans marker
# after a properly closed example block must still carve out — otherwise the
# fix would have made fences never close, silently disabling the waiver.
run_case "well-formed closer (trailing whitespace) still closes; later marker carves out" 0 \
  "$PLANS/2026-07-26-GH-15-epic.md" $'---\nestimate: L\n---\n\nExample:\n```markdown\nsome example body\n```   \n\ntype: plan-of-plans\n'

# --- Path-derived rooting (GH-1556) --------------------------------------------
# Workspace-root repro: CLAUDE_PROJECT_DIR points at $SBX, but the target file
# lives in a different repo tree ($REPO) that contains the research doc. The
# hook must root off the file path, not the session env — expect allow.
run_case "target file's repo root wins over CLAUDE_PROJECT_DIR (workspace-root repro)" 0 \
  "$REPO/thoughts/shared/plans/2026-07-19-GH-9-x.md" $'---\nestimate: M\n---'
# Fallback control: target file has no .git ancestor anywhere on its path, and
# no GH-7 research doc exists under $SBX — the walk exhausts and falls back to
# get_project_root() (CLAUDE_PROJECT_DIR), preserving old behavior — expect block.
run_case "no .git ancestor falls back to CLAUDE_PROJECT_DIR root (blocks)" 2 \
  "$NOGIT/thoughts/shared/plans/2026-07-19-GH-7-x.md" $'---\nestimate: M\n---'
# Positive fallback control: no .git ancestor, but the GH-1 research doc DOES
# exist under $SBX — proves the fallback returns CLAUDE_PROJECT_DIR itself
# (a wrong fallback root would block; only $SBX-rooting allows).
run_case "no .git ancestor + doc under CLAUDE_PROJECT_DIR allows (fallback-positive)" 0 \
  "$NOGIT/thoughts/shared/plans/2026-07-19-GH-1-x.md" $'---\nestimate: M\n---'
# Relative file_path: no walkable ancestry — must fall back to
# CLAUDE_PROJECT_DIR (pre-helper behavior), not hang. GH-1 doc exists → allow.
run_case "relative file_path falls back to CLAUDE_PROJECT_DIR (no hang)" 0 \
  "thoughts/shared/plans/2026-07-19-GH-1-x.md" $'---\nestimate: M\n---'

echo ""
echo "=== Results: ${PASS} passed, ${FAIL} failed ==="

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
