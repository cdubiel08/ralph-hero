#!/usr/bin/env bash
# bootstrap.sh — one-command setup for the ralph-knowledge dream-loop.
#
# Idempotent. Steps:
#   1. Write ~/.ralph/knowledge.config.json with discovered thoughts roots
#      (SKIP if file already exists).
#   2. Probe http://localhost:12000/v1/models for Gemma (non-blocking;
#      prints a `gemma-up` hint if down but does NOT exit non-zero).
#   3. Render scripts/dream/launchd/com.dubiel.dream-loop.plist.template
#      with __HOME__ / __PROJECTS_DIR__ / __USER__ → user's actual values
#      and write to ~/Library/LaunchAgents/com.$(whoami).dream-loop.plist
#      (SKIP if file already exists).
#   4. launchctl load the plist (silently no-op if already loaded).
#   5. Smoke ingest: uv run ingest.py --since 1h.
#   6. Print tier counts from ~/.ralph-hero/knowledge.db.
#   7. Print next-steps banner.
#
# Each step prints `OK <step>` or `SKIP <step> (already configured)` so
# the user can see exactly what changed. Exit 0 on success.

set -uo pipefail

# Allow override for tests; default to user $HOME.
HOME_DIR="${RALPH_BOOTSTRAP_HOME:-$HOME}"
# Allow override for tests; default to $HOME/projects.
PROJECTS_DIR="${RALPH_BOOTSTRAP_PROJECTS_DIR:-${HOME_DIR}/projects}"
# Allow override for tests; default to $(whoami).
USER_NAME="${RALPH_BOOTSTRAP_USER:-$(whoami)}"

CONFIG_PATH="${HOME_DIR}/.ralph/knowledge.config.json"
LAUNCH_AGENTS_DIR="${HOME_DIR}/Library/LaunchAgents"
PLIST_PATH="${LAUNCH_AGENTS_DIR}/com.${USER_NAME}.dream-loop.plist"
DB_PATH="${RALPH_KNOWLEDGE_DB:-${HOME_DIR}/.ralph-hero/knowledge.db}"

# Resolve repo root from this script's location: scripts/dream/bootstrap.sh
# → repo root is two parents up.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
PLIST_TEMPLATE="${SCRIPT_DIR}/launchd/com.dubiel.dream-loop.plist.template"

# Skip steps that have external side effects (launchctl, uv) when in
# RALPH_BOOTSTRAP_DRY_RUN=1 mode — used by smoke tests in CI.
DRY_RUN="${RALPH_BOOTSTRAP_DRY_RUN:-0}"

ok()   { printf "OK   %s\n" "$1"; }
skip() { printf "SKIP %s (already configured)\n" "$1"; }
warn() { printf "WARN %s\n" "$1" >&2; }

# ----------------------------------------------------------------------
# Step 1: write ~/.ralph/knowledge.config.json
# ----------------------------------------------------------------------
step_write_config() {
    if [[ -f "${CONFIG_PATH}" ]]; then
        skip "knowledge.config.json (${CONFIG_PATH})"
        return 0
    fi

    mkdir -p "$(dirname "${CONFIG_PATH}")"

    # Auto-discover thoughts roots:
    #   - ${PROJECTS_DIR}/thoughts             (global thoughts corpus)
    #   - ${PROJECTS_DIR}/*/thoughts           (per-repo thoughts dirs)
    #   - ${PROJECTS_DIR}/thoughts/dream-memories (dream-loop raw memories)
    local roots=()
    if [[ -d "${PROJECTS_DIR}/thoughts" ]]; then
        roots+=("${PROJECTS_DIR}/thoughts")
    fi
    # shellcheck disable=SC2231
    for dir in ${PROJECTS_DIR}/*/thoughts; do
        if [[ -d "${dir}" ]]; then
            roots+=("${dir}")
        fi
    done
    if [[ -d "${PROJECTS_DIR}/thoughts/dream-memories" ]]; then
        roots+=("${PROJECTS_DIR}/thoughts/dream-memories")
    fi

    # Fallback: if nothing was discovered, default to ${PROJECTS_DIR}/thoughts
    # so the file is still useful — the reindex skips missing roots gracefully.
    if [[ ${#roots[@]} -eq 0 ]]; then
        roots=("${PROJECTS_DIR}/thoughts")
    fi

    # Build a JSON array literal from the roots list.
    local roots_json="["
    local first=1
    for r in "${roots[@]}"; do
        if [[ ${first} -eq 1 ]]; then
            first=0
        else
            roots_json+=","
        fi
        roots_json+=$'\n      '\""${r}"\"
    done
    roots_json+=$'\n    ]'

    cat > "${CONFIG_PATH}" <<EOF
{
  "roots": ${roots_json},
  "ignorePatterns": [
    ".obsidian/**",
    "node_modules/**",
    "dist/**",
    ".git/**",
    "**/_*.md",
    "**/_issues/**",
    "**/Untitled*.canvas",
    "**/*.local.md",
    ".claude/**",
    "worktrees/**",
    ".playwright-cli/**",
    "thoughts/local/baselines/**"
  ],
  "dbPath": "${DB_PATH}"
}
EOF
    ok "knowledge.config.json (${CONFIG_PATH})"
}

# ----------------------------------------------------------------------
# Step 2: probe Gemma — non-blocking.
# ----------------------------------------------------------------------
step_probe_gemma() {
    local gemma_url="${RALPH_LLM_URL:-http://localhost:12000}/v1/models"
    if curl -fsS --max-time 2 "${gemma_url}" >/dev/null 2>&1; then
        ok "gemma probe (${gemma_url})"
    else
        warn "gemma unreachable at ${gemma_url} — run \`gemma-up\` to start the local server. (continuing without blocking)"
    fi
}

# ----------------------------------------------------------------------
# Step 3: render plist template.
# ----------------------------------------------------------------------
step_render_plist() {
    if [[ -f "${PLIST_PATH}" ]]; then
        skip "launchd plist (${PLIST_PATH})"
        return 0
    fi

    if [[ ! -f "${PLIST_TEMPLATE}" ]]; then
        warn "plist template missing: ${PLIST_TEMPLATE}"
        return 1
    fi

    mkdir -p "${LAUNCH_AGENTS_DIR}"

    # Substitute __HOME__ / __PROJECTS_DIR__ / __USER__ → actual values.
    # Use a temp file + mv for atomicity.
    local tmp_path="${PLIST_PATH}.tmp.$$"
    sed \
        -e "s|__HOME__|${HOME_DIR}|g" \
        -e "s|__PROJECTS_DIR__|${PROJECTS_DIR}|g" \
        -e "s|__USER__|${USER_NAME}|g" \
        "${PLIST_TEMPLATE}" > "${tmp_path}"
    mv "${tmp_path}" "${PLIST_PATH}"

    ok "launchd plist (${PLIST_PATH})"
}

# ----------------------------------------------------------------------
# Step 4: launchctl load.
# ----------------------------------------------------------------------
step_launchctl_load() {
    if [[ "${DRY_RUN}" == "1" ]]; then
        skip "launchctl load (RALPH_BOOTSTRAP_DRY_RUN=1)"
        return 0
    fi

    if ! command -v launchctl >/dev/null 2>&1; then
        warn "launchctl not available on this platform; skipping load step"
        return 0
    fi

    if [[ ! -f "${PLIST_PATH}" ]]; then
        warn "plist missing at ${PLIST_PATH}; cannot load"
        return 0
    fi

    # launchctl list returns 0 with the label-status row on success, non-zero
    # if not loaded. Either way we can no-op cleanly.
    local label="com.${USER_NAME}.dream-loop"
    if launchctl list "${label}" >/dev/null 2>&1; then
        skip "launchctl load (${label} already loaded)"
        return 0
    fi

    # `launchctl load` prints "Load failed: 5: Input/output error" if the
    # plist is already loaded — swallow that and treat it as a no-op.
    if launchctl load "${PLIST_PATH}" >/dev/null 2>&1; then
        ok "launchctl load (${label})"
    else
        warn "launchctl load returned non-zero for ${label} — already loaded? Run \`launchctl list | grep dream-loop\` to verify."
    fi
}

# ----------------------------------------------------------------------
# Step 5: smoke ingest.
# ----------------------------------------------------------------------
step_smoke_ingest() {
    if [[ "${DRY_RUN}" == "1" ]]; then
        skip "smoke ingest (RALPH_BOOTSTRAP_DRY_RUN=1)"
        return 0
    fi

    if ! command -v uv >/dev/null 2>&1; then
        warn "uv not on PATH; skipping smoke ingest. Install via \`brew install uv\`."
        return 0
    fi

    # Run from scripts/dream so uv resolves the local pyproject.toml.
    (
        cd "${SCRIPT_DIR}"
        if uv run ingest.py --since 1h; then
            ok "smoke ingest (--since 1h)"
        else
            warn "smoke ingest exited non-zero — see ingest.py output above"
        fi
    )
}

# ----------------------------------------------------------------------
# Step 6: report tier counts.
# ----------------------------------------------------------------------
step_report_tiers() {
    if ! command -v sqlite3 >/dev/null 2>&1; then
        warn "sqlite3 not on PATH; skipping tier-count report"
        return 0
    fi

    if [[ ! -f "${DB_PATH}" ]]; then
        warn "knowledge.db missing at ${DB_PATH}; skipping tier-count report (run reindex first via /ralph-knowledge:setup or \`npm --prefix plugin/ralph-knowledge run reindex\`)"
        return 0
    fi

    echo
    echo "Memory-tier counts (${DB_PATH}):"
    sqlite3 "${DB_PATH}" \
        "SELECT memory_tier, COUNT(*) FROM documents GROUP BY memory_tier" \
        2>/dev/null | sed 's/^/  /'
    ok "tier counts reported"
}

# ----------------------------------------------------------------------
# Step 7: next-steps banner.
# ----------------------------------------------------------------------
step_print_banner() {
    cat <<EOF

----------------------------------------------------------------------
Dream-loop bootstrap complete.
----------------------------------------------------------------------
  Config:     ${CONFIG_PATH}
  Plist:      ${PLIST_PATH}
  DB:         ${DB_PATH}
  Stdout log: ${HOME_DIR}/Library/Logs/ralph-dream-loop.out
  Stderr log: ${HOME_DIR}/Library/Logs/ralph-dream-loop.err

Next steps:
  - Manual run:    \`dream-now\` (or \`uv run scripts/dream/ingest.py --since 24h\`)
  - Verify agent:  \`launchctl list | grep dream-loop\`
  - View logs:     \`tail -f ~/Library/Logs/ralph-dream-loop.out\`
  - Start Gemma:   \`gemma-up\` (reflection synthesis needs the local LLM)
----------------------------------------------------------------------
EOF
}

main() {
    echo "ralph-knowledge dream-loop bootstrap"
    echo "  HOME:         ${HOME_DIR}"
    echo "  PROJECTS_DIR: ${PROJECTS_DIR}"
    echo "  USER:         ${USER_NAME}"
    echo

    step_write_config
    step_probe_gemma
    step_render_plist
    step_launchctl_load
    step_smoke_ingest
    step_report_tiers
    step_print_banner
}

main "$@"
