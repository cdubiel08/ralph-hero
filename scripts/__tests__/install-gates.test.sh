#!/usr/bin/env bash
# scripts/__tests__/install-gates.test.sh
# Contract tests for ralph/scripts/install-gates.sh (GH-2083).
#
# Harness: a throwaway copy of the plugin dir (so upgrade scenarios can mutate
# the kit without touching the tree) installing into throwaway git repos.
# No network, no gh.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP_ROOT=$(mktemp -d)
trap 'rm -rf "$TMP_ROOT"' EXIT

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; ((PASS++)) || true; }
fail() { echo "  FAIL: $1"; ((FAIL++)) || true; }

# A private copy of the plugin: kit + installer + manifest + plugin.json.
PLUGIN="$TMP_ROOT/plugin"
mkdir -p "$PLUGIN"
cp -R "$REPO_ROOT/ralph/kit" "$PLUGIN/kit"
mkdir -p "$PLUGIN/scripts" "$PLUGIN/.claude-plugin"
cp "$REPO_ROOT/ralph/scripts/install-gates.sh" "$PLUGIN/scripts/"
cp "$REPO_ROOT/ralph/.claude-plugin/plugin.json" "$PLUGIN/.claude-plugin/"
INSTALLER="$PLUGIN/scripts/install-gates.sh"

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

new_host() {
  local d="$TMP_ROOT/$1"
  rm -rf "$d"; mkdir -p "$d"; git -C "$d" init -q
  printf '%s' "$d"
}

echo "install-gates.test.sh"

# --- fresh install ----------------------------------------------------------
HOST="$(new_host host1)"
out="$(cd "$HOST" && bash "$INSTALLER")"
n="$(jq -r '.files | length' "$HOST/.github/ralph-kit.json")"
if [ -x "$HOST/scripts/merge-pr.sh" ] && [ -f "$HOST/.github/workflows/validate-attestation.yml" ] && [ "$n" = 17 ]; then
  pass "fresh install lands 17 files + stamp; scripts executable"
else
  fail "fresh install (files=$n)"
fi
if jq -e '.external_review.required == false and .attestation.required == true and (.exempt_authors | length) == 4' \
    "$HOST/.github/ralph-merge-policy.json" >/dev/null; then
  pass "policy seed: attestation on, external review off, bot authors exempt"
else
  fail "policy seed shape"
fi
if grep -q "CLIENT-SIDE ONLY" <<<"$out" && grep -q "workflow' scope" <<<"$out"; then
  pass "printout carries the ruleset honesty line and the workflow-scope warning"
else
  fail "printout manual steps"
fi

# --- idempotent second run --------------------------------------------------
out="$(cd "$HOST" && bash "$INSTALLER")"
if grep -q "0 installed, 0 updated, 17 already current, 0 skipped" <<<"$out"; then
  pass "second run is a no-op"
else
  fail "second run: $(grep 'installed,' <<<"$out")"
fi

# --- policy is never overwritten -------------------------------------------
echo '{"version":1,"attestation":{"required":true},"external_review":{"required":true,"bot":"x"}}' \
  > "$HOST/.github/ralph-merge-policy.json"
(cd "$HOST" && bash "$INSTALLER" >/dev/null)
if jq -e '.external_review.bot == "x"' "$HOST/.github/ralph-merge-policy.json" >/dev/null; then
  pass "existing policy untouched on re-run"
else
  fail "existing policy was rewritten"
fi

# --- local modification is respected; --force overwrites --------------------
echo "# host adaptation" >> "$HOST/scripts/pr-file-classes.sh"
out="$(cd "$HOST" && bash "$INSTALLER")"
if grep -q "SKIPPED    scripts/pr-file-classes.sh" <<<"$out" && grep -q "# host adaptation" "$HOST/scripts/pr-file-classes.sh"; then
  pass "locally modified file skipped, content preserved"
else
  fail "local modification clobbered or not reported"
fi
(cd "$HOST" && bash "$INSTALLER" --force >/dev/null)
if ! grep -q "# host adaptation" "$HOST/scripts/pr-file-classes.sh"; then
  pass "--force overwrites the modified file"
else
  fail "--force left the modified file"
fi

# --- deleted file = durable opt-out ----------------------------------------
rm "$HOST/scripts/ruleset-contexts.sh"
(cd "$HOST" && bash "$INSTALLER" >/dev/null)   # first run after delete
out="$(cd "$HOST" && bash "$INSTALLER")"        # second — the stamp must still know
if [ ! -f "$HOST/scripts/ruleset-contexts.sh" ] && grep -q "SKIPPED    scripts/ruleset-contexts.sh" <<<"$out"; then
  pass "deleted file stays deleted across repeated runs"
else
  fail "deleted file was reinstalled or not reported"
fi
(cd "$HOST" && bash "$INSTALLER" --force >/dev/null)
if [ -f "$HOST/scripts/ruleset-contexts.sh" ]; then
  pass "--force reinstalls the deleted file"
else
  fail "--force did not reinstall"
fi

# --- upgrade: unmodified old copy is updated, modified copy is not ----------
HOST2="$(new_host host2)"
(cd "$HOST2" && bash "$INSTALLER" >/dev/null)
# Simulate a NEWER plugin: the kit's copy of one file changes.
echo "# gate fix vNext" >> "$PLUGIN/kit/scripts/attest-pr.sh"
newhash="$(sha256 "$PLUGIN/kit/scripts/attest-pr.sh")"
jq --arg h "$newhash" '.files["scripts/attest-pr.sh"] = $h' "$PLUGIN/kit/manifest.json" > "$PLUGIN/kit/manifest.json.new"
mv "$PLUGIN/kit/manifest.json.new" "$PLUGIN/kit/manifest.json"
out="$(cd "$HOST2" && bash "$INSTALLER")"
if grep -q "updated    scripts/attest-pr.sh" <<<"$out" && grep -q "# gate fix vNext" "$HOST2/scripts/attest-pr.sh"; then
  pass "upgrade updates an unmodified older copy in place"
else
  fail "upgrade path did not update"
fi

# --- retired file: named, left in place, record preserved -------------------
jq 'del(.files["scripts/ruleset-contexts.sh"])' "$PLUGIN/kit/manifest.json" > "$PLUGIN/kit/manifest.json.new"
mv "$PLUGIN/kit/manifest.json.new" "$PLUGIN/kit/manifest.json"
out="$(cd "$HOST2" && bash "$INSTALLER")"
if grep -q "retired    scripts/ruleset-contexts.sh" <<<"$out" \
   && [ -f "$HOST2/scripts/ruleset-contexts.sh" ] \
   && jq -e '.files["scripts/ruleset-contexts.sh"]' "$HOST2/.github/ralph-kit.json" >/dev/null; then
  pass "file retired from the kit is named, kept, and stays in the stamp"
else
  fail "retired-file handling"
fi

# --- stamp is valid JSON every time ----------------------------------------
if jq -e . "$HOST2/.github/ralph-kit.json" >/dev/null; then
  pass "stamp parses as JSON"
else
  fail "stamp is malformed"
fi

# --- refusals ---------------------------------------------------------------
HOST3="$(new_host host3)"
mkdir -p "$HOST3/ralph/scripts"; touch "$HOST3/ralph/scripts/kit-sync.sh"
if (cd "$HOST3" && bash "$INSTALLER" >/dev/null 2>&1); then
  fail "canonical repo accepted"
else
  pass "canonical ralph repo refused (exit 2)"
fi
NOGIT="$TMP_ROOT/nogit"; mkdir -p "$NOGIT"
if (cd "$NOGIT" && GIT_CEILING_DIRECTORIES="$TMP_ROOT" bash "$INSTALLER" >/dev/null 2>&1); then
  fail "non-git dir accepted"
else
  pass "non-git target refused"
fi
if (cd "$HOST2" && bash "$INSTALLER" --frobnicate >/dev/null 2>&1); then
  fail "unknown flag accepted"
else
  pass "unknown flag refused"
fi

echo
echo "install-gates.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
