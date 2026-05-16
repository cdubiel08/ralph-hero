# /schedule routines

Scripts in this directory are harness-executable bodies for `/schedule` routines —
nightly or periodic automations registered via Claude Code's built-in `/schedule create`
command.

## How to register a routine

```bash
/schedule create <routine-name> --cron "<cron-expression>" \
  --script plugin/ralph-hero/scripts/schedule/<script>.sh
```

## How to confirm registration

```bash
/schedule list
```

## How to remove a routine

```bash
/schedule remove <routine-name>
```

---

## scout-nightly

**Script**: `plugin/ralph-hero/scripts/schedule/scout-nightly.sh`

**Purpose**: Nightly Scout sweep — runs `/ralph-playwright:test-e2e` against the latest
deployed build URL and files any critical/high findings as GitHub issues with the
`scout-auto` label. Director routes `scout-auto`-labeled issues to the Scout team
(see `plugin/ralph-hero/skills/director/event-classes.md`).

**Registration**:

```bash
/schedule create scout-nightly --cron "0 3 * * *" \
  --script plugin/ralph-hero/scripts/schedule/scout-nightly.sh
```

Runs at 03:00 UTC every night. Adjust the cron expression to match your team's timezone.

**Required environment**:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `RALPH_DEPLOYED_BUILD_URL` | No | `http://localhost:3100` | URL of the deployed build to test against. Set this to your staging/production URL. |
| `RALPH_SCOUT_LABEL` | No | `scout-auto` | Label applied to issues filed by this run. Change only if your Director taxonomy uses a different label. |

Set these in `~/.claude/settings.json` or `<project>/.claude/settings.local.json`
(gitignored) under the `env` key:

```json
{
  "env": {
    "RALPH_DEPLOYED_BUILD_URL": "https://staging.example.com"
  }
}
```

**Confirm after registration**:

```bash
/schedule list
# Expected output includes:
#   scout-nightly   0 3 * * *   plugin/ralph-hero/scripts/schedule/scout-nightly.sh
```

**Manual test run**:

```bash
RALPH_DEPLOYED_BUILD_URL=https://staging.example.com \
  bash plugin/ralph-hero/scripts/schedule/scout-nightly.sh
```

**Logs**: Written to `~/.ralph-hero/schedule/scout-nightly-YYYYMMDD.log`.

**No regression**: Manual `/ralph-playwright:test-e2e` invocations are unaffected.
The `--label` flag is only passed by this script; omitting it leaves existing behavior
unchanged.
