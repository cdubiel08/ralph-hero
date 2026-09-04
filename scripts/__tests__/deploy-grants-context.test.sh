#!/usr/bin/env bash
# scripts/__tests__/deploy-grants-context.test.sh
# Tests ralph/hooks/deploy-grants-context.sh (the SessionStart observation,
# GH-2452 — unit 10 of
# thoughts/shared/plans/2026-09-03-approval-gated-hosts-design.md, D7).
#
# The load-bearing property is NON-BLOCKING, same class as every other hook
# in this family: every case below asserts exit 0, whether the policy is
# rich, absent, or malformed. The second property under test is that the
# rendered line reflects the SAME grant scripts/approve-deploy.sh would act
# on — grouped by grant, with "prod"/"production" forced to "human" even
# when the policy lies and calls them "autonomous" (GH-2451's reserved-set
# override, read through me_environment_grant rather than re-derived here).

set -euo pipefail

HOOK="$(cd "$(dirname "$0")/../.." && pwd)/ralph/hooks/deploy-grants-context.sh"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
[ -x "$HOOK" ] || { echo "  FAIL: $HOOK is not executable (hooks.json invokes it directly)"; exit 1; }

TMP_ROOT=$(mktemp -d)
trap 'rm -rf "$TMP_ROOT"' EXIT

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; ((PASS++)) || true; }
fail() { echo "  FAIL: $1"; ((FAIL++)) || true; }

# A fixture repo root carrying the real merge-evidence.sh, so the hook reads
# the actual reader under test rather than a stand-in that could drift from
# scripts/approve-deploy.sh's own behavior.
FIXTURE="$TMP_ROOT/fixture"
mkdir -p "$FIXTURE/scripts/lib" "$FIXTURE/.github"
cp "$REPO_ROOT/scripts/lib/merge-evidence.sh" "$FIXTURE/scripts/lib/merge-evidence.sh"

STUB_BIN="$TMP_ROOT/bin"
mkdir -p "$STUB_BIN"
cat >"$STUB_BIN/git" <<STUB
#!/usr/bin/env bash
if [[ "\${1:-}" == "rev-parse" && "\${2:-}" == "--show-toplevel" ]]; then
  echo "$FIXTURE"
  exit 0
fi
exec /usr/bin/git "\$@"
STUB
chmod +x "$STUB_BIN/git"

run_hook() { # run_hook <policy-json-or-empty>
  local policy="$1"
  if [[ -n "$policy" ]]; then
    echo "$policy" >"$FIXTURE/.github/ralph-merge-policy.json"
  else
    rm -f "$FIXTURE/.github/ralph-merge-policy.json"
  fi
  set +e
  LAST_OUT=$(PATH="$STUB_BIN:$PATH" bash "$HOOK" 2>&1)
  LAST_RC=$?
  set -e
}

# --- no policy file at all: silent, exit 0 ----------------------------------
run_hook ""
if [[ "$LAST_RC" -eq 0 && -z "$LAST_OUT" ]]; then
  pass "no policy file: silent, exit 0"
else
  fail "no policy file: expected silent exit 0, got rc=$LAST_RC out='$LAST_OUT'"
fi

# --- policy present, no environments block: silent, exit 0 -----------------
run_hook '{"attestation":{"required":true}}'
if [[ "$LAST_RC" -eq 0 && -z "$LAST_OUT" ]]; then
  pass "no environments block: silent, exit 0"
else
  fail "no environments block: expected silent exit 0, got rc=$LAST_RC out='$LAST_OUT'"
fi

# --- malformed policy (invalid JSON): silent, exit 0, fails closed ---------
echo '{ not json' >"$FIXTURE/.github/ralph-merge-policy.json"
set +e
LAST_OUT=$(PATH="$STUB_BIN:$PATH" bash "$HOOK" 2>&1)
LAST_RC=$?
set -e
if [[ "$LAST_RC" -eq 0 && -z "$LAST_OUT" ]]; then
  pass "malformed policy: silent, exit 0"
else
  fail "malformed policy: expected silent exit 0, got rc=$LAST_RC out='$LAST_OUT'"
fi

# --- the worked example from the issue body ---------------------------------
run_hook '{"environments":{"dev":"autonomous","qa":"autonomous","staging":"lead","prod":"human"}}'
expected='standing deploy authority in this repo: dev, qa; staging via lead; prod human — `scripts/approve-deploy.sh`'
if [[ "$LAST_RC" -eq 0 && "$LAST_OUT" == "$expected" ]]; then
  pass "worked example renders exactly the documented line"
else
  fail "worked example: rc=$LAST_RC out='$LAST_OUT' (expected '$expected')"
fi

# --- reserved-set override survives into the rendered line -----------------
# A policy that LIES and grants prod "autonomous" must still render "prod
# human" — me_environment_grant forces the override, and this hook must not
# re-derive (and thus be able to disagree with) that rule.
run_hook '{"environments":{"prod":"autonomous"}}'
if [[ "$LAST_RC" -eq 0 && "$LAST_OUT" == *"prod human"* && "$LAST_OUT" != *"standing deploy authority"* ]]; then
  pass "prod forced to human even when the policy lies"
else
  fail "prod override: rc=$LAST_RC out='$LAST_OUT'"
fi

# --- no autonomous envs: the "standing deploy authority" lead-in is dropped -
run_hook '{"environments":{"staging":"lead","prod":"human"}}'
expected='deploy authority in this repo: staging via lead; prod human — `scripts/approve-deploy.sh`'
if [[ "$LAST_RC" -eq 0 && "$LAST_OUT" == "$expected" ]]; then
  pass "no autonomous envs: lead-in adapts, no false 'standing' claim"
else
  fail "no autonomous envs: rc=$LAST_RC out='$LAST_OUT' (expected '$expected')"
fi

# --- an unreadable merge-evidence.sh (kit not installed): silent, exit 0 ---
rm -rf "$FIXTURE/scripts"
echo '{"environments":{"dev":"autonomous"}}' >"$FIXTURE/.github/ralph-merge-policy.json"
set +e
LAST_OUT=$(PATH="$STUB_BIN:$PATH" bash "$HOOK" 2>&1)
LAST_RC=$?
set -e
if [[ "$LAST_RC" -eq 0 && -z "$LAST_OUT" ]]; then
  pass "kit not installed (no merge-evidence.sh): silent, exit 0"
else
  fail "kit not installed: expected silent exit 0, got rc=$LAST_RC out='$LAST_OUT'"
fi
mkdir -p "$FIXTURE/scripts/lib"
cp "$REPO_ROOT/scripts/lib/merge-evidence.sh" "$FIXTURE/scripts/lib/merge-evidence.sh"

# --- outside a git repo entirely: silent, exit 0 ----------------------------
cat >"$STUB_BIN/git" <<'STUB'
#!/usr/bin/env bash
if [[ "${1:-}" == "rev-parse" ]]; then exit 128; fi
exec /usr/bin/git "$@"
STUB
chmod +x "$STUB_BIN/git"
set +e
LAST_OUT=$(PATH="$STUB_BIN:$PATH" bash "$HOOK" 2>&1)
LAST_RC=$?
set -e
if [[ "$LAST_RC" -eq 0 && -z "$LAST_OUT" ]]; then
  pass "not a git repo: silent, exit 0"
else
  fail "not a git repo: expected silent exit 0, got rc=$LAST_RC out='$LAST_OUT'"
fi

echo "deploy-grants-context.test.sh: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
