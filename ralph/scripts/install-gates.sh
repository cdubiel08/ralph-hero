#!/usr/bin/env bash
# install-gates.sh — vendor the ralph merge-gate family into a host repo (GH-2083).
#
# The board machine ships in the plugin; the merge gates do not — they are
# repo-level scripts a host repo runs from its own tree (validate-attestation
# runs them in GitHub Actions, where no plugin install exists, so a shim that
# resolves the installed plugin cannot work there — vendoring is forced).
# This installer is the board-setup shape: idempotent, additive, and it PRINTS
# every step it cannot perform instead of pretending.
#
# Recommendations, never requirements: a file the host repo has modified is
# respected (skipped with a warning) unless --force names the overwrite.
#
# Usage (from the host repo, any subdirectory):
#   bash <plugin>/scripts/install-gates.sh [--force]
#
# Writes:
#   scripts/*.sh + scripts/lib/*.sh        the merge-gate family
#   .github/workflows/validate-attestation.yml
#   .github/ralph-merge-policy.json        seeded ONLY if absent
#   .github/ralph-kit.json                 install stamp (version + sha256 per file)

set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KIT_DIR="$PLUGIN_ROOT/kit"
MANIFEST="$KIT_DIR/manifest.json"

FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    *) echo "install-gates: unknown argument: $arg (only --force is accepted)" >&2; exit 2 ;;
  esac
done

command -v jq >/dev/null 2>&1 || { echo "install-gates: jq is required (the gate scripts require it too)" >&2; exit 2; }
[ -f "$MANIFEST" ] || { echo "install-gates: kit manifest not found at $MANIFEST — is this a complete plugin install?" >&2; exit 2; }

TARGET="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "install-gates: run from inside the host git repository" >&2; exit 2; }

# The canonical repo IS the kit's source — installing over it would overwrite
# canonical files with their own copies at best, and stamp the source at worst.
if [ -f "$TARGET/ralph/scripts/kit-sync.sh" ]; then
  echo "install-gates: $TARGET is the canonical ralph repo (ralph/scripts/kit-sync.sh present) — nothing to install" >&2
  exit 2
fi

VERSION="$(jq -r '.version // "unknown"' "$PLUGIN_ROOT/.claude-plugin/plugin.json" 2>/dev/null || echo unknown)"
STAMP="$TARGET/.github/ralph-kit.json"

# Same mapping kit-sync.sh applies: host-repo destination -> kit-dir path.
kit_path() {
  case "$1" in
    .github/workflows/*) printf 'workflows/%s' "${1#.github/workflows/}" ;;
    *) printf '%s' "$1" ;;
  esac
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

stamped_hash() { # previous install's record for one dest, "" if none
  [ -f "$STAMP" ] || { printf ''; return; }
  jq -r --arg f "$1" '.files[$f] // ""' "$STAMP" 2>/dev/null || printf ''
}

# The board-driven workflows (state-guard + doctor, GH-2088) run the board CLI
# against this repo's OWN board — a repo with no board configured would burn a
# 15-minute cron doing nothing, so they are withheld until a board config
# exists. Withheld is not skipped: never stamped, so configuring .ralph.json
# and re-running installs them cleanly.
BOARD_WORKFLOWS=".github/workflows/state-guard.yml .github/workflows/doctor.yml"
board_configured=0
if { [ -f "$TARGET/.ralph.json" ] && jq -e '.projectNumber' "$TARGET/.ralph.json" >/dev/null 2>&1; } \
   || { [ -f "$TARGET/.claude/settings.json" ] && jq -e '.env.RALPH_GH_PROJECT_NUMBER' "$TARGET/.claude/settings.json" >/dev/null 2>&1; }; then
  board_configured=1
fi

installed=0 updated=0 current=0 skipped=0 withheld=0
declare -a skipped_files=()
new_stamp_entries="" # dest\thash lines for files this run vouches for

while IFS= read -r dest; do
  src="$KIT_DIR/$(kit_path "$dest")"
  [ -f "$src" ] || { echo "install-gates: kit file missing: $src" >&2; exit 2; }
  case " $BOARD_WORKFLOWS " in
    *" $dest "*)
      if [ "$board_configured" != 1 ] && [ ! -f "$TARGET/$dest" ] && [ -z "$(stamped_hash "$dest")" ]; then
        echo "  WITHHELD   $dest — no board configured (.ralph.json with projectNumber); configure one, then re-run"
        withheld=$((withheld + 1))
        continue
      fi
      ;;
  esac
  kit_hash="$(sha256 "$src")"
  out="$TARGET/$dest"
  if [ ! -f "$out" ]; then
    prev="$(stamped_hash "$dest")"
    if [ -n "$prev" ] && [ "$FORCE" != 1 ]; then
      # The kit installed this once and the host deleted it — an opt-out, not
      # a gap. Reinstalling would un-make a decision; --force names it.
      echo "  SKIPPED    $dest — previously installed, deleted by the host (opt-out respected); --force reinstalls"
      skipped=$((skipped + 1))
      skipped_files+=("$dest")
      # Keep the record: dropping it would make the NEXT run read this as a
      # fresh install and quietly un-make the opt-out.
      new_stamp_entries="$new_stamp_entries$dest	$prev
"
      continue
    fi
    mkdir -p "$(dirname "$out")"
    cp "$src" "$out"
    echo "  installed  $dest"
    installed=$((installed + 1))
    new_stamp_entries="$new_stamp_entries$dest	$kit_hash
"
    continue
  fi
  have_hash="$(sha256 "$out")"
  if [ "$have_hash" = "$kit_hash" ]; then
    current=$((current + 1))
    new_stamp_entries="$new_stamp_entries$dest	$kit_hash
"
    continue
  fi
  prev="$(stamped_hash "$dest")"
  if [ "$have_hash" = "$prev" ] || [ "$FORCE" = 1 ]; then
    # An unmodified older kit copy (or an explicit --force): update in place.
    cp "$src" "$out"
    echo "  updated    $dest"
    updated=$((updated + 1))
    new_stamp_entries="$new_stamp_entries$dest	$kit_hash
"
  else
    # Differs from the kit AND from what this kit last installed (or was never
    # installed by the kit): the host owns this file. Respect it.
    echo "  SKIPPED    $dest — locally modified (differs from the kit and from the last install); --force overwrites"
    skipped=$((skipped + 1))
    skipped_files+=("$dest")
    # Preserve the previous stamp entry if there was one, so a later revert to
    # the old kit copy is still recognised as updatable.
    if [ -n "$prev" ]; then
      new_stamp_entries="$new_stamp_entries$dest	$prev
"
    fi
  fi
done < <(jq -r '.files | keys[]' "$MANIFEST")

# Stamp entries for files a past kit shipped that this one no longer does:
# preserved (so doctor can call them retired rather than foreign) and named.
if [ -f "$STAMP" ]; then
  while IFS= read -r retired; do
    [ -n "$retired" ] || continue
    echo "  retired    $retired — no longer in the kit; left in place (remove it yourself if unused)"
    new_stamp_entries="$new_stamp_entries$retired	$(stamped_hash "$retired")
"
  done < <(jq -r --slurpfile m "$MANIFEST" '.files | keys[] | select(. as $k | $m[0].files | has($k) | not)' "$STAMP" 2>/dev/null)
fi

# Seed the minimal policy ONLY if absent — the policy is the host's to own.
# external_review.required:false is the stated default for a repo with no
# reviewer wired (opt-in rule); attestation stays required because the gate
# without it is a script that always says yes.
POLICY="$TARGET/.github/ralph-merge-policy.json"
if [ -f "$POLICY" ]; then
  echo "  kept       .github/ralph-merge-policy.json (already present — not touched)"
else
  mkdir -p "$TARGET/.github"
  cat > "$POLICY" <<'EOF'
{
  "version": 1,
  "attestation": {
    "required": true
  },
  "external_review": {
    "required": false
  },
  "exempt_authors": [
    "dependabot[bot]",
    "app/dependabot",
    "github-actions[bot]",
    "app/github-actions"
  ]
}
EOF
  echo "  installed  .github/ralph-merge-policy.json (minimal seed — see next steps)"
fi

mkdir -p "$TARGET/.github"
{
  printf '{\n  "kit": "ralph merge-gate family (GH-2083)",\n  "version": "%s",\n  "files": {\n' "$VERSION"
  first=1
  while IFS=$'\t' read -r dest hash; do
    [ -n "$dest" ] || continue
    [ "$first" = 1 ] || printf ',\n'
    printf '    "%s": "%s"' "$dest" "$hash"
    first=0
  done <<< "$new_stamp_entries"
  printf '\n  }\n}\n'
} > "$STAMP"

echo
echo "install-gates: ralph $VERSION → $TARGET"
summary="$installed installed, $updated updated, $current already current, $skipped skipped"
[ "$withheld" -gt 0 ] && summary="$summary, $withheld withheld (no board)"
echo "  $summary"
if [ "$skipped" -gt 0 ]; then
  echo "  skipped (host-modified, respected): ${skipped_files[*]}"
fi

cat <<EOF

Installed: the merge gate (scripts/merge-pr.sh + attestation, review-evidence,
apply, watcher scripts) and .github/workflows/validate-attestation.yml, which
republishes the attestation verdict as the 'ralph-attestation' commit status
using only the built-in GITHUB_TOKEN — no secret to configure.

The ralph plugin's funnel hooks condition on scripts/merge-pr.sh existing, so
they arm in this repo on their own from here.

MANUAL steps this installer cannot perform:

1. Branch ruleset (GitHub → Settings → Rules → Rulesets → New branch ruleset):
   - target: the default branch
   - require a pull request before merging
   - require status checks: 'ralph-attestation' plus this repo's CI contexts
   HONEST LIMIT: until this exists the merge gate is CLIENT-SIDE ONLY — the
   scripts refuse on their own verdict and the plugin's funnel hooks redirect,
   but nothing stops a bare 'gh pr merge' server-side. The ruleset is the
   enforcement; everything before it is convention.

2. Commit and push these files via this repo's normal PR flow. Note: pushing
   .github/workflows/** needs the 'workflow' scope on your token — a plain
   'gh auth login' setup may lack it (gh auth refresh -s workflow), and the
   push-time refusal is cryptic. The workflow's issue_comment lane only runs
   once the file is ON the default branch, so the PR that lands it does not
   itself get comment-triggered recomputes.

3. Attestation in a repo with NO external reviewer: attest-pr.sh always
   requires --review-verdict and --reviewer — deliberately, and the seeded
   required:false does not loosen it. The sanctioned form is the driving
   agent's (or human's) own review, attributed as itself (e.g.
   --reviewer "self:<who>"), never a verdict typed on a reviewer's behalf.

4. External review (recommended once a reviewer is wired): edit
   .github/ralph-merge-policy.json — set external_review.required:true with
   the bot's login, and for findings-mode reviewers (no APPROVED verb) add
   "trigger" and "head_marker" (the ralph-hero policy is the worked example).
   For GitHub Copilot code review, set "request_mode": "review-request"
   instead — no trigger or marker; the bot defaults to
   copilot-pull-request-reviewer[bot] and reviews are engaged by requesting
   the reviewer 'Copilot' (GH-2087). Note a request on a repo without Copilot
   code review is silently dropped by GitHub — read the request back.

5. Apply units (optional): if this repo has work whose completion is a DEPLOY
   rather than a merge (terraform, secrets, rulesets, scheduled jobs), add an
   "apply" block ({"enabled": true, "label": ..., "infraPaths": [...]}) to the
   policy — the merge gate's keyword hygiene and the board's Done evidence
   gate arm from that one block.

6. scripts/pr-file-classes.sh ships with ralph-hero's file-class taxonomy and
   degrades harmlessly here (deps/ci-workflows/scripts-shell/other still
   classify). Adapting it to this repo's layout is expected — the installer
   respects the local copy on every future run.

7. state-guard.yml and doctor.yml (the board's server-side corrective wall
   and weekly strict sweep) are installed only when this repo has a board
   configured (.ralph.json with projectNumber, or the settings env block) —
   configure one, then re-run this installer. At run time they fetch the
   board CLI from the kit's source repo at the release tag the kit stamp
   pins (GH-2088), and they need the ROUTING_PAT secret: a classic PAT with
   project scope, created under Settings -> Secrets and variables -> Actions.
   A configured board with a missing PAT fails loudly by design; a repo with
   no board config exits idle.

Re-run this installer after a plugin update to pick up gate fixes; files you
have modified locally are never overwritten without --force. 'board doctor'
reports when the installed kit is behind the plugin's.
EOF
