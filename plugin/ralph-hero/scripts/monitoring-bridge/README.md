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
5. If `incident.severity == "CRITICAL"`, `gh routine fire
   ralph-hero-critical-alert` is invoked immediately after ACK with the new
   issue number and `team=caretakers`. Routine failure is non-fatal — the
   issue was already created and autopilot will pick it up on the next tick.
   See [## CRITICAL-alert RemoteTrigger](#critical-alert-remotetrigger) for
   one-time setup and failure-mode details.

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
| `RALPH_MONITORING_CRITICAL_CAP_PER_DAY` | No | Reserved; not yet active — per-day cap for CRITICAL Routine fires (follow-up issue) |

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

## CRITICAL-alert RemoteTrigger

When `subscribe.py` creates a GitHub Issue for an alert with
`incident.severity == "CRITICAL"`, it immediately fires a cloud Routine via
`gh routine fire ralph-hero-critical-alert`. Director receives the Routine
payload, skips taxonomy classification, and dispatches the caretakers team
directly — routing the alert to triage in seconds rather than waiting for the
next autopilot tick.

**Which alerts fire the Routine:** Only alerts where `incident.severity` is
exactly `"CRITICAL"` (case-sensitive). All other severity values — including
`WARNING`, `ERROR`, or missing — create a GitHub Issue only.

**One-time setup (user runs once in a Claude Code session):**

```
RemoteTrigger(
  name: "ralph-hero-critical-alert",
  prompt: "Run /ralph-hero:director — the harness passes issue_number and team via tool input.",
  trigger: {type: "api"},
  model: "sonnet",
  repos: ["cdubiel08/ralph-hero"]
)
```

After creating the Routine, confirm it appears in claude.ai → Routines. No
further configuration is needed — `subscribe.py` calls
`gh routine fire ralph-hero-critical-alert` automatically.

**Payload shape Director consumes:**

```json
{"issue_number": <int>, "team": "caretakers"}
```

See [`plugin/ralph-hero/skills/director/IOS-REMOTE.md` § "External producers"](../../skills/director/IOS-REMOTE.md#5-external-producers-remotetrigger-payload-shape) for the full payload contract.

**Failure mode:** Two distinct failure paths exist:

1. **`gh routine fire` failure** — If `gh routine fire` returns a non-zero exit
   code, times out, or raises any exception, `subscribe.py` logs a WARNING and
   continues. The GitHub Issue was already created and acknowledged, so the
   worst-case outcome is "autopilot picks it up on the next tick" (matching
   today's default behavior). The `created`/`failed` counters are not adjusted
   on Routine failure.

2. **Issue URL parse failure** — If the issue number cannot be extracted from
   the URL returned by `gh issue create`, `subscribe.py` logs an ERROR with the
   marker `routine_fire_skipped_parse_failure` and increments the `failed`
   counter. This failure is visible in the summary line printed at the end of
   each run (e.g., `Result: 1 created, 0 skipped (duplicate), 1 failed`) and
   causes the script to exit with code 1. The Routine is not fired in this case.

**Rate-of-fire risk:** Every CRITICAL alert fires one Routine invocation, which
consumes Claude Code subscription usage. A spike in CRITICAL alerts (e.g., a
misconfigured alert policy) can fire many Routines in quick succession. A
per-day rate cap is deferred to a follow-up issue; the env var name
`RALPH_MONITORING_CRITICAL_CAP_PER_DAY` is reserved for that future S-sized
change.

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
