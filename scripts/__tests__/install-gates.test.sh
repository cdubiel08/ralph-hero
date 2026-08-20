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
if [ -x "$HOST/scripts/merge-pr.sh" ] && [ -f "$HOST/.github/workflows/validate-attestation.yml" ] && [ "$n" = 21 ]; then
  pass "fresh install lands 21 files + stamp; scripts executable"
else
  fail "fresh install (files=$n)"
fi
# Advisory hooks (audit C3): installed under .claude/hooks/, never registered.
if [ -x "$HOST/.claude/hooks/ralph-kit-orient.sh" ] && [ -x "$HOST/.claude/hooks/funnel-gate-watch.sh" ] \
   && [ -f "$HOST/.claude/hooks/lib/cmdscan.sh" ] && [ ! -f "$HOST/.claude/settings.json" ] \
   && grep -q "SessionStart" <<<"$out"; then
  pass "advisory hooks installed; settings.json never written; registration printed"
else
  fail "advisory hook install"
fi
# CLAUDE.md fragment: created with the marker block, stamped under .fragments.
if grep -q "BEGIN ralph-kit" "$HOST/CLAUDE.md" && grep -q "pr-gate-watch.sh" "$HOST/CLAUDE.md" \
   && jq -e '.fragments["CLAUDE.md"]' "$HOST/.github/ralph-kit.json" >/dev/null; then
  pass "CLAUDE.md created with the ralph-kit block and stamped"
else
  fail "CLAUDE.md fragment on fresh install"
fi
# Board workflows are withheld from a boardless host (GH-2088): not installed,
# not stamped, named with the remedy.
if grep -q "WITHHELD   .github/workflows/state-guard.yml" <<<"$out" \
   && grep -q "WITHHELD   .github/workflows/doctor.yml" <<<"$out" \
   && [ ! -f "$HOST/.github/workflows/state-guard.yml" ] \
   && [ ! -f "$HOST/.github/workflows/doctor.yml" ] \
   && ! jq -e '.files[".github/workflows/state-guard.yml"]' "$HOST/.github/ralph-kit.json" >/dev/null; then
  pass "board workflows withheld from a boardless host, never stamped"
else
  fail "board-workflow withholding"
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
# 22 = 21 files + the CLAUDE.md fragment block (fragments count in the same
# summary; they are units of installed content, just merged not copied).
if grep -q "0 installed, 0 updated, 22 already current, 0 skipped" <<<"$out"; then
  pass "second run is a no-op (fragment included)"
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

# --- fresh install into a board-configured host lands everything ------------
HOST4="$(new_host host4)"
echo '{"owner":"o","repo":"r","projectNumber":7}' > "$HOST4/.ralph.json"
(cd "$HOST4" && bash "$INSTALLER" >/dev/null)
n4="$(jq -r '.files | length' "$HOST4/.github/ralph-kit.json")"
if [ "$n4" = 23 ] && [ -f "$HOST4/.github/workflows/state-guard.yml" ]; then
  pass "fresh install into a board-configured host lands all 23 files"
else
  fail "board-configured fresh install (files=$n4)"
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

# --- board workflows install once a board is configured (GH-2088) -----------
echo '{"owner":"o","repo":"r","projectNumber":7}' > "$HOST/.ralph.json"
out="$(cd "$HOST" && bash "$INSTALLER")"
if [ -f "$HOST/.github/workflows/state-guard.yml" ] && [ -f "$HOST/.github/workflows/doctor.yml" ] \
   && jq -e '.files[".github/workflows/doctor.yml"]' "$HOST/.github/ralph-kit.json" >/dev/null \
   && ! grep -q "WITHHELD" <<<"$out"; then
  pass "configuring .ralph.json then re-running installs the board workflows"
else
  fail "board workflows not installed after board config"
fi

# --- CLAUDE.md fragment lifecycle (audit C3) ---------------------------------
HOST5="$(new_host host5)"
printf '# Host guidance\n\nOur own rules.\n' > "$HOST5/CLAUDE.md"
(cd "$HOST5" && bash "$INSTALLER" >/dev/null)
if grep -q "Our own rules." "$HOST5/CLAUDE.md" && grep -q "BEGIN ralph-kit" "$HOST5/CLAUDE.md"; then
  pass "pre-existing CLAUDE.md gets the block appended, host prose untouched"
else
  fail "fragment append into existing CLAUDE.md"
fi
# Host edits INSIDE the markers: respected on re-run, replaced under --force.
perl -pi -e 's/never bare/HOST EDIT never bare/' "$HOST5/CLAUDE.md"
out="$(cd "$HOST5" && bash "$INSTALLER")"
if grep -q "SKIPPED    CLAUDE.md" <<<"$out" && grep -q "HOST EDIT" "$HOST5/CLAUDE.md"; then
  pass "host-edited fragment block skipped, edit preserved"
else
  fail "host-edited fragment block clobbered or not reported"
fi
(cd "$HOST5" && bash "$INSTALLER" --force >/dev/null)
if ! grep -q "HOST EDIT" "$HOST5/CLAUDE.md" && grep -q "Our own rules." "$HOST5/CLAUDE.md"; then
  pass "--force replaces the block; host prose outside the markers still untouched"
else
  fail "--force fragment replace"
fi
# Host deletes the block after an install: an opt-out, respected until --force.
printf '# Host guidance\n\nOur own rules.\n' > "$HOST5/CLAUDE.md"
out="$(cd "$HOST5" && bash "$INSTALLER")"
if grep -q "SKIPPED    CLAUDE.md" <<<"$out" && ! grep -q "BEGIN ralph-kit" "$HOST5/CLAUDE.md"; then
  pass "removed fragment block stays removed across runs"
else
  fail "removed fragment block was re-added or not reported"
fi

# --- orient hook behavior (advisory, one line, exit 0) -----------------------
line="$(cd "$HOST5" && bash .claude/hooks/ralph-kit-orient.sh)"
if [ $? -eq 0 ] && grep -q "bash scripts/pr-gate-watch.sh <PR> --watch" <<<"$line"; then
  pass "orient hook names the gate family and the after-push command"
else
  fail "orient hook (gates installed): $line"
fi
HOST6="$(new_host host6)"
echo '{"owner":"o","repo":"r","projectNumber":7}' > "$HOST6/.ralph.json"
mkdir -p "$HOST6/.claude/hooks"
cp "$HOST5/.claude/hooks/ralph-kit-orient.sh" "$HOST6/.claude/hooks/"
line="$(cd "$HOST6" && bash .claude/hooks/ralph-kit-orient.sh)"
if grep -q "board configured, gates not installed" <<<"$line"; then
  pass "orient hook flags a board-configured repo with no gates"
else
  fail "orient hook (board, no gates): $line"
fi
NOREPO="$TMP_ROOT/norepo"; mkdir -p "$NOREPO"
line="$(cd "$NOREPO" && GIT_CEILING_DIRECTORIES="$TMP_ROOT" bash "$HOST5/.claude/hooks/ralph-kit-orient.sh")"
if [ $? -eq 0 ] && [ -z "$line" ]; then
  pass "orient hook prints nothing outside a git repo and still exits 0"
else
  fail "orient hook (no repo) printed: $line"
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
