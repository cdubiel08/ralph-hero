# monitoring-bridge

Cloud Monitoring → GitHub Projects board bridge. Pulls messages from a Cloud
Monitoring → Pub/Sub subscription and normalises each alert payload into a
`watcher-auto`-labeled draft issue on the GitHub Projects V2 board.

Part of **Feature D** of the Unified Agent System epic (GH-1271). The Director
skill (Feature B) routes `watcher-auto` issues to the Watcher team; this
script is the producer side.

## How it works

1. On each launchd tick (every 5 minutes), `subscribe.py` pulls up to 10
   messages from the configured Pub/Sub subscription.
2. Each message is decoded and normalised into a GitHub issue payload:
   - Title: `[gcp-alert] <condition displayName>`
   - Labels: `["watcher-auto"]`
   - Body: iOS-friendly one-paragraph summary, `## Source` block with the
     alert console URL and policy id, `## Suggested Team: watchers`, and the
     full alert JSON in a collapsed `<details>` block.
   - Marker: `<!-- gcp-policy: <policy-id> -->` in the body — matches the
     shape that `gcp-incident-triage` already keys off.
3. Before creating an issue, the subscriber checks for an existing open issue
   with the same `<!-- gcp-policy: <id> -->` marker (via `gh issue list
   --search`). Duplicate alerts are skipped.
4. On successful creation, the Pub/Sub message is acknowledged so it is not
   re-delivered.

No LLM calls are made. The mapping from alert fields to issue fields is
deterministic.

## Setup

### Prerequisites

- Python ≥ 3.11 (managed by `uv`)
- `uv` installed (`brew install uv` or `pip install uv`)
- `gh` CLI authenticated (`gh auth login -s repo,project,read:org`)
- GCP credentials with `pubsub.subscriptions.consume` permission
  (`gcloud auth application-default login`)
- Environment variables set (see Configuration below)

### Install

```bash
cd plugin/ralph-hero/scripts/monitoring-bridge
uv sync
```

### Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `RALPH_MONITORING_SUBSCRIPTION` | Yes | Pub/Sub subscription name or full resource path |
| `GOOGLE_CLOUD_PROJECT` | Yes | GCP project id |

Set these in your shell profile or in the launchd plist's `EnvironmentVariables`
block before loading the agent.

## Install launchd agent

```bash
cp plugin/ralph-hero/scripts/monitoring-bridge/launchd/com.ralph.monitoring-bridge.plist.template \
   ~/Library/LaunchAgents/com.ralph.monitoring-bridge.plist
# Edit the plist to set RALPH_MONITORING_SUBSCRIPTION and GOOGLE_CLOUD_PROJECT
launchctl load ~/Library/LaunchAgents/com.ralph.monitoring-bridge.plist
```

The agent fires every 300 seconds (5 minutes) via `StartInterval`. It does not
run at load time (`RunAtLoad = false`).

## Verification

```bash
# Confirm the launchd job is registered (PID column "-" when idle)
launchctl list | grep monitoring-bridge

# Tail output and error logs
tail -f /tmp/ralph-monitoring-bridge.out
tail -f /tmp/ralph-monitoring-bridge.err

# Run a dry-run against the fixture (no Pub/Sub or GitHub access needed)
cd plugin/ralph-hero/scripts/monitoring-bridge
python3 subscribe.py --dry-run --subscription dummy --project dummy

# Full smoke test (static assertions + dry-run)
bash plugin/ralph-hero/scripts/monitoring-bridge/smoke.sh
```

## Dry-run mode

`--dry-run` reads from `fixtures/sample-alert.json` instead of Pub/Sub and
prints the normalised issue payload to stdout without creating any GitHub
issues. Use this to verify the normalisation logic and the `<!-- gcp-policy:
... -->` marker shape before enabling the live launchd agent.

## Relation to gcp-incident-triage

This subscriber is **not** a replacement for the `gcp-incident-triage` skill.
The skill performs delta analysis, deduplication against existing issues, and
root-cause triage. The subscriber's role is narrower: ensure issues exist on
the board so the Director → Watch pipeline can act on them even when no human
is at the terminal. The `<!-- gcp-policy: <id> -->` marker shape is shared so
`gcp-incident-triage` can pick up subscriber-created issues and enrich them.

## What is NOT done here

- No new alert policies or Pub/Sub topics are created. Those are
  terraform-managed; this script reads from an existing topic.
- No Cloud Run deployment. The launchd-scheduled pull model is preferred for
  parity with the dream-loop. A Cloud Run path is a valid follow-up if
  multi-machine reliability is needed.
- No LLM calls. The mapping is deterministic.
