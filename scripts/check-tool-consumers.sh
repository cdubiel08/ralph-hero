#!/usr/bin/env bash
#
# check-tool-consumers.sh — two-direction tool-surface drift check (GH-1614)
#
# scripts/check-doc-rosters.sh already asserts documented ⊆ source for the
# curated CLAUDE.md/README.md tool tables. Nothing today checks the two
# directions that actually govern whether an autonomous session can call a
# tool at all:
#
#   Direction A (prose -> roster): a skill's prose (SKILL.md body below
#     frontmatter, or any sibling .md under that skill's dir) names a
#     ralph_hero__* tool that skill's own `allowed-tools` frontmatter does
#     NOT grant. `allowed-tools` is what a session can actually call; a
#     tool named only in prose is uncallable on the autonomous path. Real
#     instance this wave: `sync_plan_graph` was referenced (bare, backtick-
#     wrapped) in plan-shapes.md/decomposition.md with no roster grant
#     anywhere — deleted in GH-1612 rather than rostered.
#
#   Direction B (registration -> consumer): a tool registered in
#     mcp-server/src/**/*.ts has zero consumers — no skill grants it in
#     `allowed-tools` and no agent grants it in `tools:`. Real instance
#     this wave: `detect_stream_positions` had exactly one reference in the
#     whole repo (a roster line with no prose caller) — deleted in GH-1609.
#
# Both directions are pure-filesystem checks (no gh/network calls), so they
# run against fixture directories in scripts/__tests__/check-tool-consumers.test.sh
# as well as the real repo.
#
# Usage: check-tool-consumers.sh [ROOT]
#   ROOT defaults to the repo root (via `git rev-parse`, resolved from this
#   script's own location) so the check runs correctly from CI, a worktree,
#   or a plain checkout. Fixture tests pass an explicit ROOT (a temp dir
#   that mirrors the real repo's ralph/skills, ralph/agents, mcp-server/src
#   layout) so the two directions can be exercised without touching the
#   real tree.
#
# Exits 0 when both directions are clean, 1 otherwise.

set -euo pipefail

if [ "${1:-}" != "" ]; then
  ROOT="$1"
else
  ROOT=$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)
fi
cd "$ROOT"

SKILLS_DIR="ralph/skills"
AGENTS_DIR="ralph/agents"
SRC_DIR="mcp-server/src"

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
# GATED_TOOLS — tools registered conditionally (behind an env flag) rather
# than unconditionally. The source grep below cannot tell a gated
# registration from an unconditional one (same blindness noted in
# check-doc-rosters.sh's tool check) — these four pass Direction B today via
# the sre-fixit agent roster regardless, but the list documents the gating
# explicitly so a FUTURE gated tool with no roster grant yet (e.g. added and
# gated in the same PR, agent wiring to follow) can be allowlisted here
# instead of failing the build.
# ---------------------------------------------------------------------------
GATED_TOOLS=(
  "sre__scale"
  "sre__rollout_restart"
  "sre__delete_pod"
  "sre__drain"
)

is_gated() {
  local tool="$1" g
  for g in "${GATED_TOOLS[@]}"; do
    [ "$g" = "$tool" ] && return 0
  done
  return 1
}

# ---------------------------------------------------------------------------
# EXEMPTIONS — per-file allowlist for prose that legitimately NAMES a tool
# without that skill calling it (Direction A false-positive suppression).
# Format: "relative/path/to/file.md:tool_short_name". Keep entries scoped to
# the exact file — a skill-wide exemption would hide a real future drift.
# ---------------------------------------------------------------------------
EXEMPTIONS=(
  # research explicitly does NOT call decompose_feature — it reads
  # .ralph-repos.yml directly via Read and says so in both places.
  "ralph/skills/research/SKILL.md:decompose_feature"
  "ralph/skills/research/research-shapes.md:decompose_feature"
  # triage.md describes catch-up's next_actions picker behavior (a
  # DIFFERENT skill's tool) to explain why a verdict is safe/unsafe; triage
  # itself never calls next_actions.
  "ralph/skills/caretake/modes/triage.md:next_actions"
  # project-fields.md documents that the Priority field feeds next_actions'
  # ranking elsewhere; setup itself never calls next_actions.
  "ralph/skills/setup/project-fields.md:next_actions"
)

is_exempt() {
  local file="$1" tool="$2" entry
  for entry in "${EXEMPTIONS[@]}"; do
    [ "$entry" = "${file}:${tool}" ] && return 0
  done
  return 1
}

# ---------------------------------------------------------------------------
# Source of truth: every ralph_hero__* short name registered in source,
# i.e. `server.tool("ralph_hero__<name>", ...)`. Excludes __tests__ dirs
# (mock fixtures reference tool names too — those are not registrations).
# ---------------------------------------------------------------------------
src_tools=""
if [ -d "$SRC_DIR" ]; then
  src_tools=$(grep -rhoE '"ralph_hero__[a-z_]+"' "$SRC_DIR" --include='*.ts' --exclude-dir=__tests__ 2>/dev/null \
    | tr -d '"' | sed 's/^ralph_hero__//' | sort -u || true)
fi

# ---------------------------------------------------------------------------
# Direction A: prose -> roster
# ---------------------------------------------------------------------------
echo "=== Direction A: prose names a tool the skill does not grant ==="

skill_dirs=""
if [ -d "$SKILLS_DIR" ]; then
  skill_dirs=$(find "$SKILLS_DIR" -mindepth 1 -maxdepth 1 -type d 2>/dev/null \
    | grep -vE '/(shared|using-html)$' | sort || true)
fi

dir_a_before=$FAIL

while IFS= read -r dir; do
  [ -z "$dir" ] && continue
  skill_md="$dir/SKILL.md"
  [ -f "$skill_md" ] || continue

  # Granted set: allowed-tools frontmatter entries of the form
  # mcp__plugin_ralph_ralph-github__ralph_hero__<name>. Grants live only in
  # SKILL.md — the roster is dir-wide even though prose is scanned per-file.
  granted=$(grep -oE 'mcp__plugin_ralph_ralph-github__ralph_hero__[a-z_]+' "$skill_md" 2>/dev/null \
    | sed 's/^.*ralph_hero__//' | sort -u || true)

  # Walk every .md in the dir tree (SKILL.md body below its frontmatter +
  # sibling refs + modes/) one FILE at a time — not concatenated — so an
  # exemption can address the exact file that legitimately names a tool
  # without calling it, rather than blanket-exempting the whole skill.
  prose_files=$(find "$dir" -name '*.md' -type f 2>/dev/null | sort || true)

  while IFS= read -r file; do
    [ -z "$file" ] && continue
    if [ "$file" = "$skill_md" ]; then
      text=$(awk 'BEGIN{d=0} /^---$/{d++; next} d>=2' "$file" 2>/dev/null || true)
    else
      text=$(cat "$file" 2>/dev/null || true)
    fi

    # Two mention shapes: the fully-prefixed `ralph_hero__<name>` form, and
    # a bare backtick-wrapped short name (`sync_plan_graph`-class prose
    # never spelled out the prefix) — the bare form only counts when it
    # matches a name actually registered in source, so ordinary
    # backtick-quoted English words don't produce noise.
    prefixed=$(printf '%s' "$text" | grep -oE 'ralph_hero__[a-z_]+' 2>/dev/null \
      | sed 's/^ralph_hero__//' | sort -u || true)
    bare=$(printf '%s' "$text" | grep -oE '`[a-z][a-z_]*`' 2>/dev/null \
      | tr -d '`' | sort -u || true)
    bare_known=$(comm -12 <(printf '%s\n' "$bare") <(printf '%s\n' "$src_tools") 2>/dev/null || true)

    mentioned=$( { printf '%s\n' "$prefixed"; printf '%s\n' "$bare_known"; } | sort -u | grep -v '^$' || true)

    while IFS= read -r tool; do
      [ -z "$tool" ] && continue
      if printf '%s\n' "$granted" | grep -qx "$tool"; then
        continue
      fi
      if is_exempt "$file" "$tool"; then
        continue
      fi
      fail "${file} names ralph_hero__${tool} in prose but ${skill_md} does not grant it in allowed-tools"
    done <<<"$mentioned"
  done <<<"$prose_files"
done <<<"$skill_dirs"

if [ "$FAIL" -eq "$dir_a_before" ]; then
  pass "no prose->roster drift found"
fi

# ---------------------------------------------------------------------------
# Direction B: registration -> consumer
# ---------------------------------------------------------------------------
echo "=== Direction B: registered tool has zero rostered consumers ==="

granted_all=""
if [ -d "$SKILLS_DIR" ]; then
  granted_all=$(grep -rhoE 'mcp__plugin_ralph_ralph-github__ralph_hero__[a-z_]+' "$SKILLS_DIR" --include='*.md' 2>/dev/null \
    | sed 's/^.*ralph_hero__//' || true)
fi
if [ -d "$AGENTS_DIR" ]; then
  granted_agents=$(grep -rhoE 'mcp__plugin_ralph_ralph-github__ralph_hero__[a-z_]+' "$AGENTS_DIR" --include='*.md' 2>/dev/null \
    | sed 's/^.*ralph_hero__//' || true)
  granted_all=$(printf '%s\n%s\n' "$granted_all" "$granted_agents")
fi
granted_all=$(printf '%s\n' "$granted_all" | sort -u | grep -v '^$' || true)

dir_b_before=$FAIL

while IFS= read -r tool; do
  [ -z "$tool" ] && continue
  if printf '%s\n' "$granted_all" | grep -qx "$tool"; then
    continue
  fi
  if is_gated "$tool"; then
    continue
  fi
  fail "ralph_hero__${tool} is registered in ${SRC_DIR}/ but has no consumer in ${SKILLS_DIR}/*/SKILL.md allowed-tools or ${AGENTS_DIR}/*.md tools:"
done <<<"$src_tools"

if [ "$FAIL" -eq "$dir_b_before" ]; then
  pass "no registration->consumer drift found"
fi

# ---------------------------------------------------------------------------
# Results
# ---------------------------------------------------------------------------
echo ""
echo "=== Results ==="
echo "PASS: $PASS"
echo "FAIL: $FAIL"

if [ "$FAIL" -ne 0 ]; then
  echo "Tool-consumer drift found. Grant the tool where it's used, delete it if it has no consumer, or add a documented exemption if the prose mention is intentionally non-calling."
  exit 1
fi
echo "No tool-consumer drift: every prose mention is granted, every registered tool has a consumer."
exit 0
