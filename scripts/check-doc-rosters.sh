#!/usr/bin/env bash
#
# check-doc-rosters.sh — assert documented rosters match source (GH-1458)
#
# Guards against the drift fixed by hand in GH-1452: agent/skill/tool rosters
# documented in CLAUDE.md / README.md silently diverging from the source files.
#
# Three checks, each with a direction chosen for its roster:
#   - Agents (bidirectional): the `### ralph Plugin — 16 Agents` section in
#     CLAUDE.md lists every agent, so documented set == ralph/agents/*.md set.
#   - Skills (bidirectional): the `### ralph Plugin — 9 Verbs` table lists every
#     verb, so documented set == ralph/skills/*/ dirs minus shared & using-html.
#   - Tools (one-directional, documented ⊆ source): the CLAUDE.md / README.md
#     tool tables are an explicitly curated subset, so every documented
#     `ralph_hero__*` name must exist in source, but source may have more.
#
# Exits 0 when all checks pass, 1 otherwise. Designed to pass on current `main`.

set -euo pipefail

# Resolve repo root so the script works from anywhere (CI, worktree, local).
REPO_ROOT=$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)
cd "$REPO_ROOT"

CLAUDE_MD="CLAUDE.md"
README_MD="README.md"
AGENTS_DIR="ralph/agents"
SKILLS_DIR="ralph/skills"
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
# Check 1: Agents (bidirectional)
# ---------------------------------------------------------------------------
# Documented: backtick names on the **N per-phase agents** / **N investigators**
# bullet lines under the `### ralph Plugin — 16 Agents` heading. We restrict to
# those bullet lines so trailing prose (e.g. `impl-agent`/`RALPH_IMPL_MODEL` in
# the paragraph below) does not pollute the set.
echo "=== Agents (CLAUDE.md <-> ${AGENTS_DIR}/) ==="

doc_agents=$(
  awk '/^### ralph Plugin — 16 Agents/{f=1; next} /^### /{f=0} f' "$CLAUDE_MD" \
    | grep -E '^\*\*[0-9]+ (per-phase agents|investigators)\*\*' \
    | grep -oE '`[a-z][a-z0-9-]+`' \
    | tr -d '`' \
    | sort -u
)

src_agents=$(
  find "$AGENTS_DIR" -mindepth 1 -maxdepth 1 -name '*.md' -type f \
    -exec basename {} .md \; \
    | sort -u
)

# Documented but not in source -> phantom agent name in the docs.
while IFS= read -r name; do
  [ -z "$name" ] && continue
  fail "Documented agent '${name}' not found in ${AGENTS_DIR}/"
done < <(comm -23 <(echo "$doc_agents") <(echo "$src_agents"))

# In source but not documented -> agent missing from CLAUDE.md roster.
while IFS= read -r name; do
  [ -z "$name" ] && continue
  fail "Agent '${name}' in ${AGENTS_DIR}/ is undocumented in ${CLAUDE_MD}"
done < <(comm -13 <(echo "$doc_agents") <(echo "$src_agents"))

if [ -z "$(comm -3 <(echo "$doc_agents") <(echo "$src_agents"))" ]; then
  pass "agent roster matches source ($(echo "$src_agents" | grep -c .) agents)"
fi

# ---------------------------------------------------------------------------
# Check 2: Skills (bidirectional)
# ---------------------------------------------------------------------------
# Documented: /ralph:<verb> names from the `### ralph Plugin — 9 Verbs` table.
# Source: ralph/skills/*/ dir names, excluding non-verb utility dirs.
echo "=== Skills (CLAUDE.md <-> ${SKILLS_DIR}/) ==="

doc_skills=$(
  awk '/^### ralph Plugin — 9 Verbs/{f=1; next} /^### /{f=0} f' "$CLAUDE_MD" \
    | grep -oE '/ralph:[a-z-]+' \
    | sed 's#/ralph:##' \
    | sort -u
)

src_skills=$(
  find "$SKILLS_DIR" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; \
    | grep -vxE 'shared|using-html' \
    | sort -u
)

# Documented but not a real skill dir -> phantom verb in the docs.
while IFS= read -r name; do
  [ -z "$name" ] && continue
  fail "Documented skill '/ralph:${name}' has no dir in ${SKILLS_DIR}/"
done < <(comm -23 <(echo "$doc_skills") <(echo "$src_skills"))

# Skill dir not in the docs -> verb missing from the 9-verbs table.
while IFS= read -r name; do
  [ -z "$name" ] && continue
  fail "Skill dir '${SKILLS_DIR}/${name}/' is undocumented in ${CLAUDE_MD}"
done < <(comm -13 <(echo "$doc_skills") <(echo "$src_skills"))

if [ -z "$(comm -3 <(echo "$doc_skills") <(echo "$src_skills"))" ]; then
  pass "skill roster matches source ($(echo "$src_skills" | grep -c .) verbs)"
fi

# ---------------------------------------------------------------------------
# Check 3: Tools (one-directional, documented ⊆ source)
# ---------------------------------------------------------------------------
# Documented: short tool names from the CLAUDE.md "Tool modules" table (col 2,
# comma-separated) and the README.md "### Tools" table (col 1), prefixed with
# ralph_hero__. The CLAUDE.md extraction is bounded to the Tool modules table
# (it precedes a structurally identical Lib modules table) and the prose-only
# debug-tools.ts row is dropped.
#
# Source: the literal quoted pattern "ralph_hero__[a-z_]+" across
# mcp-server/src/**/*.ts (excluding __tests__). NOTE: we do NOT anchor on
# server.tool( — that call puts the tool name on the *next* line, so a
# line-anchored regex matches nothing. Scope includes src/index.ts, where
# ralph_hero__health_check is registered.
echo "=== Tools (CLAUDE.md + README.md docs ⊆ ${SRC_DIR}/) ==="

doc_tools=$(
  {
    # CLAUDE.md Tool modules table, second column, comma-split.
    awk '/\*\*Tool modules\*\*/{f=1; next} /\*\*GitHub client\*\*/{f=0} f' "$CLAUDE_MD" \
      | grep -E '^\| `[a-z-]+\.ts` \|' \
      | grep -v 'debug-tools.ts' \
      | sed -E 's/^\| `[a-z-]+\.ts` \| //; s/ \|$//' \
      | tr ',' '\n' \
      | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//' \
      | grep -E '^[a-z_]+$'
    # README.md Tools table, first column backtick names.
    awk '/^### Tools/{f=1; next} /^### /{f=0} f' "$README_MD" \
      | grep -oE '^\| `[a-z_]+`' \
      | tr -d '`|' \
      | sed -E 's/[[:space:]]+//g'
  } | sed 's/^/ralph_hero__/' | sort -u
)

src_tools=$(
  grep -rhoE '"ralph_hero__[a-z_]+"' "$SRC_DIR" --include='*.ts' \
    | grep -v __tests__ \
    | tr -d '"' \
    | sort -u
)

# Documented tool absent from source -> phantom/typo/renamed tool in the docs.
# (We intentionally do NOT flag source tools missing from docs — the docs are a
# curated subset.)
while IFS= read -r name; do
  [ -z "$name" ] && continue
  fail "Documented tool '${name}' not found in ${SRC_DIR}/ (phantom/typo/renamed?)"
done < <(comm -23 <(echo "$doc_tools") <(echo "$src_tools"))

if [ -z "$(comm -23 <(echo "$doc_tools") <(echo "$src_tools"))" ]; then
  pass "all $(echo "$doc_tools" | grep -c .) documented tools exist in source ($(echo "$src_tools" | grep -c .) source tools)"
fi

# ---------------------------------------------------------------------------
# Results
# ---------------------------------------------------------------------------
echo ""
echo "=== Results ==="
echo "PASS: $PASS"
echo "FAIL: $FAIL"

if [ "$FAIL" -ne 0 ]; then
  echo "Doc rosters diverge from source. Update CLAUDE.md/README.md (or the source) to reconcile."
  exit 1
fi
echo "All doc rosters are consistent with source."
exit 0
