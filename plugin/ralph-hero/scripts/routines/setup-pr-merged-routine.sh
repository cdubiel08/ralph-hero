#!/usr/bin/env bash
# setup-pr-merged-routine.sh — prints one-time setup instructions for the
# ralph-hero-pr-merged cloud Routine. Documentation only; does not call
# any external commands or create the Routine automatically (Routine creation
# requires the interactive claude.ai/code UI).
#
# Usage:
#   bash plugin/ralph-hero/scripts/routines/setup-pr-merged-routine.sh

set -euo pipefail

cat <<'EOF'
# Setup: ralph-hero-pr-merged Cloud Routine

This script documents the one-time steps to create the ralph-hero-pr-merged
cloud Routine on claude.ai/code. The Routine fires on every PR merged to main
and invokes the ralph-pr-merged skill to propagate post-merge observability
surfaces (PushNotification, knowledge_record_outcome) for PRs merged outside
ralph-merge.

## One-time setup

1. Open https://claude.ai/code → Routines → New Routine.

2. In the Routine session, install the ralph-hero plugin (same as local setup):
   - The plugin is NOT auto-installed from settings.json in cloud Routine
     sessions. You must install it once via the Routine's plugin panel.
   - Reference: project memory "project_cloud_routines_plugin_install_gap"
   - Live proof-of-concept: the ralph-hero-pr-drain Routine follows the same
     pattern and is currently in production.

3. Configure the GitHub trigger using the RemoteTrigger invocation below:

RemoteTrigger(
  name: "ralph-hero-pr-merged",
  prompt: "/ralph-hero:ralph-pr-merged --pr {{ pr.number }}",
  trigger: {
    type: "github",
    event: "pull_request",
    filter: {
      action: "closed",
      is_merged: true,
      base_branch: "main"
    }
  },
  model: "haiku",
  repos: ["cdubiel08/ralph-hero"]
)

## Verification commands

After creating the Routine, verify it is working with the following:

(a) Merge a test PR via the GitHub UI, then tail the Routine log:
    tail -f ~/.claude-code/routines/ralph-hero-pr-merged.log

(b) Confirm the outcome event was recorded:
    sqlite3 ~/.ralph-hero/knowledge.db \
      "SELECT * FROM outcome_events WHERE event_type='merge_completed' ORDER BY timestamp DESC LIMIT 5"

(c) Confirm the idempotency label was applied to the PR:
    gh pr view <N> --json labels | jq -r '.labels[].name' | grep pr-merged-handled

## Offline fallback (launchd)

If the cloud Routine is unavailable or you prefer host-local polling, use the
launchd template instead:

    plugin/ralph-hero/scripts/routines/launchd/com.ralph.pr-merged-poll.plist.template

See plugin/ralph-hero/docs/routines.md § Offline fallback (launchd) for
trade-offs and installation steps.

EOF

exit 0
