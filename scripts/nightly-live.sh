#!/bin/bash
# nightly-live.sh — the nightly live+chaos pass for the ralph-herdr BDD layer
# (Phase 6, D6: replay per-PR, live nightly).
#
# What it runs, in order (first failure propagates, later suites still run):
#   1. test:bdd:live  — the @live cucumber scenarios against a REAL herdr
#      server in the named test session `ralph-bdd` (never the operator's
#      default session; plain shell panes only — nothing that bills; the
#      steps stop AND delete the session after every scenario, even a failed
#      one, and this script re-tears-down by name on EXIT/INT/TERM to cover
#      the case the steps cannot: the node process being killed outright).
#   2. the chaos rows — the failure-injection scenarios (@chaos, replay
#      world: one-worktree-fails fleet resilience, the sick-server reconcile
#      refusal), re-run nightly beside the live suite so the injected-failure
#      paths stay exercised on the machine that actually runs fleets.
#
# Intended transport: LOCAL launchd (this is a laptop job — CI never runs
# @live). Wiring, NOT installed by this script or by any repo automation:
#
#   ~/Library/LaunchAgents/com.ralph.bdd-nightly.plist
#     ProgramArguments: ["/bin/bash", "<this repo>/scripts/nightly-live.sh"]
#     StartCalendarInterval: { Hour = 2; Minute = 30; }
#     StandardOutPath/StandardErrorPath: ~/.ralph/logs/bdd-nightly.log
#     EnvironmentVariables: { RALPH_BDD_LIVE = "1"; }
#   load with:   launchctl load ~/Library/LaunchAgents/com.ralph.bdd-nightly.plist
#   verify with: launchctl list | grep com.ralph.bdd-nightly
#
# Usage:
#   RALPH_BDD_LIVE=1 bash scripts/nightly-live.sh
#
# The RALPH_BDD_LIVE=1 gate is deliberate and NOT defaulted here: the same
# fail-closed opt-in every live surface in this repo uses. Without it the
# live half refuses (test:bdd:live's own guard) and this script exits
# nonzero — a nightly that silently skipped its live half would report
# green while testing nothing.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 1

log() { echo "$(date -u +%FT%TZ) nightly-live: $*"; }

# --- Backstop teardown for the live session. The @live After hook stops and
# deletes `ralph-bdd` on step failure, but it cannot run if the node process
# DIES (OOM kill, `launchctl kill -9`, sleep watchdog): the live server is
# spawned detached + unref'd, so it would outlive the job and the next night's
# run would ADOPT it (the start step skips an already-running session) and test
# against accumulated state. Unattended is exactly where nobody notices, so
# teardown is repeated here. BY NAME ONLY — never `herdr server stop`, which is
# unscoped and would kill the operator's default session; by-name stop+delete
# is idempotent, so the normal-exit case is a silent no-op.
LIVE_SESSION=ralph-bdd
teardown_live() {
  herdr session stop "$LIVE_SESSION" >/dev/null 2>&1 || true
  herdr session delete "$LIVE_SESSION" >/dev/null 2>&1 || true
}
trap teardown_live EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

rc=0

log "live suite (test:bdd:live — named session ralph-bdd, plain shell panes)"
if ! npm run test:bdd:live; then
  log "live suite FAILED"
  rc=1
fi

log "chaos rows (replay world, @chaos failure-injection scenarios)"
if ! NODE_OPTIONS="--import tsx" npx cucumber-js --profile chaos; then
  log "chaos rows FAILED"
  rc=1
fi

if [ "$rc" -eq 0 ]; then
  log "nightly pass green"
else
  log "nightly pass FAILED (see above)"
fi
exit "$rc"
