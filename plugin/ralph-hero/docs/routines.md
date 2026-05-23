# ralph-hero Cloud Routines

Cloud Routines are external producers that fire ralph-hero skills via `RemoteTrigger`. Each Routine is created once in the `claude.ai/code` UI and then triggers automatically on a schedule or event. Because cloud Routine sessions do not auto-install plugins from `settings.json`, the ralph-hero plugin must be installed manually once per Routine via the Routine session's plugin panel. See project memory `project_cloud_routines_plugin_install_gap` for the root cause; the live `ralph-hero-pr-drain` Routine is the proof-of-concept that this one-time UI install pattern works reliably.

Ralph-hero currently uses three Routines:

| Routine | Trigger | Skill |
|---------|---------|-------|
| `ralph-hero-pr-drain` | `pull_request: opened/reopened/synchronize` | `ralph-pr-drain` |
| `ralph-hero-pr-merged` | `pull_request: closed (merged to main)` | `ralph-pr-merged` |
| `ralph-hero-critical-alert` | Fired by monitoring-bridge on `CRITICAL` severity | `director` (RemoteTrigger payload) |

---

## ralph-hero-pr-drain

Drains pull requests that Director cannot dispatch — typically Dependabot bumps, stale unlinked PRs, or non-ralph-hero-flow opens. Classifies each PR, runs code review as the merge gate for auto-merge candidates, and threads a synthetic Ralph issue through the project board so pipeline dashboards and dream-loop metrics remain accurate.

**Trigger event**

```
pull_request: opened / reopened / synchronize
base_branch: main
repo: cdubiel08/ralph-hero
```

**One-time setup**

```
RemoteTrigger(
  name: "ralph-hero-pr-drain",
  prompt: "/ralph-hero:ralph-pr-drain --pr {{ pr.number }}",
  trigger: {
    type: "github",
    event: "pull_request",
    filter: {
      action: ["opened", "reopened", "synchronize"],
      base_branch: "main"
    }
  },
  model: "sonnet",
  repos: ["cdubiel08/ralph-hero"]
)
```

**Skill invoked**: `plugin/ralph-hero/skills/ralph-pr-drain/SKILL.md`

**Verification commands**

```bash
# Most recent drain events
sqlite3 ~/.ralph-hero/knowledge.db \
  "SELECT * FROM outcome_events WHERE event_type='pr_drain' ORDER BY timestamp DESC LIMIT 5"

# Confirm idempotency label on a drained PR
gh pr view <N> --json labels | jq -r '.labels[].name' | grep pr-drained
```

---

## ralph-hero-pr-merged

Fires post-merge propagation for PRs merged outside `ralph-merge` (GitHub UI, `gh pr merge`, Dependabot auto-merge, teammate merge). Resolves PR to linked issue, applies a 60-second idempotency guard to avoid double Done-transitions when `ralph-merge` already ran, fires `PushNotification`, and records a `merge_completed` outcome event.

**Trigger event**

```
pull_request: closed (merged)
base_branch: main
repo: cdubiel08/ralph-hero
```

**One-time setup**

```
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
```

Run the setup helper to print the full instructions and verification commands:

```bash
bash plugin/ralph-hero/scripts/routines/setup-pr-merged-routine.sh
```

**Skill invoked**: `plugin/ralph-hero/skills/ralph-pr-merged/SKILL.md`

**Idempotency design**

- **`pr-merged-handled` label** (Step 1): checked before any work; re-fires on the same PR exit immediately.
- **60-second `closedAt` window** (Step 4): if the linked issue is already `workflowState=Done` and `closedAt` is within 60 seconds of now, the skill skips `save_issue` but still fires `PushNotification` and records the outcome. This covers the race where `ralph-merge` ran first.
- **`issue_number=0` sentinel**: PRs with no linked issue (e.g., Dependabot bumps, docs PRs) set `issue_number=0`, skip `save_issue`, and still fire `PushNotification` and `knowledge_record_outcome`.
- **Double-write safety**: `knowledge_record_outcome` is append-only; two `merge_completed` rows for the same PR are correctness-safe. The `source: "ralph-pr-merged"` payload field distinguishes Routine-sourced events from `ralph-merge`-sourced events.

**Verification commands**

```bash
# Most recent merge_completed events
sqlite3 ~/.ralph-hero/knowledge.db \
  "SELECT * FROM outcome_events WHERE event_type='merge_completed' ORDER BY timestamp DESC LIMIT 5"

# Confirm idempotency label on a handled PR
gh pr view <N> --json labels | jq -r '.labels[].name' | grep pr-merged-handled

# Tail Routine log after a test merge
tail -f ~/.claude-code/routines/ralph-hero-pr-merged.log
```

---

## ralph-hero-critical-alert

Fires when the Cloud Monitoring bridge (`monitoring-bridge`) detects a CRITICAL-severity alert. The bridge runs as a local `subscribe.py` process that tails Google Cloud Monitoring pubsub; on CRITICAL severity it calls `gh routine fire ralph-hero-critical-alert` with the incident payload. Director receives the RemoteTrigger payload, classifies it as a CRITICAL event, and dispatches the appropriate team.

**Trigger event**

Fired imperatively by `monitoring-bridge/subscribe.py` when `incident.severity == "CRITICAL"` (case-sensitive). Not a GitHub webhook trigger.

**One-time setup**

```
RemoteTrigger(
  name: "ralph-hero-critical-alert",
  prompt: "CRITICAL alert fired: {{ payload }}. Dispatch Director.",
  trigger: { type: "manual" },
  model: "sonnet",
  repos: ["cdubiel08/ralph-hero"]
)
```

See [`scripts/monitoring-bridge/README.md` § CRITICAL-alert RemoteTrigger](../scripts/monitoring-bridge/README.md#critical-alert-remotetrigger) for the full payload shape and rate-of-fire risk notes.

**Skill invoked**: Director (`plugin/ralph-hero/skills/director/SKILL.md`) via the RemoteTrigger payload.

**Verification commands**

```bash
# Tail monitoring-bridge output
tail -f /tmp/ralph-monitoring-bridge.out

# Most recent CRITICAL routing events
sqlite3 ~/.ralph-hero/knowledge.db \
  "SELECT * FROM outcome_events WHERE event_type='critical_alert' ORDER BY timestamp DESC LIMIT 5"
```

---

## Offline fallback (launchd)

When the `ralph-hero-pr-merged` cloud Routine is unavailable (host offline, Routine paused, or preview-period cap hit), the launchd polling fallback provides equivalent coverage at a 5-minute polling cadence.

**Trade-offs**

| | Cloud Routine | launchd fallback |
|---|---|---|
| Latency | ~seconds (webhook push) | up to 5 minutes (poll interval) |
| Host dependency | None — runs on Anthropic infrastructure | Mac must be on and awake |
| Offline support | No — requires cloud connectivity | Yes — uses local `gh` CLI |
| Subscription budget | One Routine invocation per merge | One `claude -p` call per unhandled PR per poll |
| Setup | One-time UI plugin install | Copy plist, replace `__INSTALL_PATH__`, `launchctl load` |

**Installation**

1. Copy the plist template and replace the `__INSTALL_PATH__` placeholder:

```bash
cp plugin/ralph-hero/scripts/routines/launchd/com.ralph.pr-merged-poll.plist.template \
   ~/Library/LaunchAgents/com.ralph.pr-merged-poll.plist

# Edit: replace __INSTALL_PATH__ with the absolute path to poll-merged-prs.sh
# Example: /Users/yourname/projects/ralph-hero/plugin/ralph-hero/scripts/routines/poll-merged-prs.sh
$EDITOR ~/Library/LaunchAgents/com.ralph.pr-merged-poll.plist
```

2. Load the agent:

```bash
launchctl load ~/Library/LaunchAgents/com.ralph.pr-merged-poll.plist
```

3. Verify it registered and monitor output:

```bash
launchctl list | grep pr-merged-poll
tail -f /tmp/ralph-pr-merged-poll.out
```

The poll script (`poll-merged-prs.sh`) uses a 10-minute look-back window on each invocation, so an occasional missed tick does not lose events.

---

## See also

- Parent plan-of-plans: [`thoughts/shared/plans/2026-05-17-claude-code-dispatch-incremental-adoption.md`](../../../thoughts/shared/plans/2026-05-17-claude-code-dispatch-incremental-adoption.md)
- Research (pr-merged design): [`thoughts/shared/research/2026-05-22-GH-1301-pr-merged-routine-design.md`](../../../thoughts/shared/research/2026-05-22-GH-1301-pr-merged-routine-design.md)
- Director external producers contract: [`skills/director/IOS-REMOTE.md` § 5](skills/director/IOS-REMOTE.md#5-external-producers-remotetrigger-payload-shape)
- CRITICAL-alert RemoteTrigger: [`scripts/monitoring-bridge/README.md` § CRITICAL-alert RemoteTrigger](scripts/monitoring-bridge/README.md#critical-alert-remotetrigger)
