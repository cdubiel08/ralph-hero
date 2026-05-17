---
description: Heartbeat registration guide for the Watcher team entrypoint. Documents /schedule installation, cadence configuration, and troubleshooting.
---

# Watcher Heartbeat — Registration Guide

The Watcher heartbeat runs `ralph-hero:watch` on a recurring schedule. When invoked with no argument, Watch queries the board for open `watcher-auto`, `watcher-investigate`, and `watcher-remediate` labelled issues and dispatches the appropriate sub-skill or subagent for each.

## Registration

### Interactive (recommended for first-time setup)

```
Skill("schedule", "every ${RALPH_WATCH_HEARTBEAT_MIN:-15}m /ralph-hero:watch")
```

### Cron syntax

```
Skill("schedule", "cron */15 * * * * /ralph-hero:watch")
```

Replace `15` with your preferred cadence in minutes (must be a positive integer).

### With a custom cadence

Set `RALPH_WATCH_HEARTBEAT_MIN` in your Claude Code settings before registering:

```json
{
  "env": {
    "RALPH_WATCH_HEARTBEAT_MIN": "30"
  }
}
```

Then register:

```
Skill("schedule", "every 30m /ralph-hero:watch")
```

## Cadence configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `RALPH_WATCH_HEARTBEAT_MIN` | `15` | Heartbeat interval in minutes. Accepts a positive integer. The schedule registration command must use this value explicitly — the env var is not read by the `/schedule` runtime itself. |

## Verifying the routine is registered

After registration, confirm the entry appears in the schedule list:

```
Skill("schedule", "list")
```

Expected entry shape:

```
id: watch-heartbeat
schedule: every 15m
skill: /ralph-hero:watch
last_run: <timestamp or "never">
next_run: <timestamp>
```

The `id` field is assigned by the `/schedule` runtime. Note it for pause/delete operations.

## Pausing and disabling

To pause the heartbeat temporarily:

```
Skill("schedule", "pause <id>")
```

To delete the heartbeat entirely:

```
Skill("schedule", "delete <id>")
```

Where `<id>` is the value from `Skill("schedule", "list")`.

## Troubleshooting

### Feature A hook not installed (SOUL not loaded)

**Symptom**: Watch runs but the paranoid-but-disciplined refusals are absent — the orchestrator accepts claims without trace IDs.

**Cause**: `load-team-soul.sh` is not present at `${CLAUDE_PLUGIN_ROOT}/hooks/scripts/load-team-soul.sh`, or the SessionStart hook did not fire.

**Fix**: Verify Feature A (GH-1268) has landed:

```bash
ls "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/load-team-soul.sh"
ls "${CLAUDE_PLUGIN_ROOT}/skills/shared/soul-schema.md"
```

If either file is missing, the SOUL framework (Feature A) has not been installed. Re-run the GH-1268 implementation before using Watch.

### gcp-incident-triage skill not present

**Symptom**: Watch dispatches to `gcp-incident-triage` but the skill invocation fails with "skill not found".

**Cause**: `gcp-incident-triage` is an operator-local skill installed at `~/.claude/skills/gcp-incident-triage/`. It is not part of this repository.

**Fix**: Confirm the skill is installed:

```bash
ls ~/.claude/skills/gcp-incident-triage/SKILL.md
```

If missing, install the skill from its source. The Watch orchestrator wraps but does not include it.
