# `--mode debug`

Collate errors from local Langfuse traces into GitHub `debug-auto` issues. Wraps the `ralph_hero__collate_debug` MCP tool with a preflight → dry-run → confirm → file → summarize workflow.

Interactive by default: requires a human confirm before mutating GitHub. The `--auto-confirm` flag is opt-in and reserved for unattended schedules (Watcher heartbeat). Closes the OTel → Langfuse → GitHub feedback loop with a single command.

```bash
export RALPH_SUBCOMMAND=debug
```

## §Step 1: Preflight

Verify the local environment is wired up before doing anything else.

1. **`RALPH_DEBUG=true` must be active in the MCP-server environment.** The `ralph_hero__collate_debug` tool is only registered when this env var is `"true"` — see `mcp-server/src/index.ts`. If the tool is not available, instruct the user to add the following to `~/.claude/settings.json` (or `<project>/.claude/settings.local.json`) and restart Claude Code:

   ```json
   {
     "env": {
       "RALPH_DEBUG": "true",
       "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
       "OTEL_EXPORTER_OTLP_ENDPOINT": "http://localhost:3100/api/public/otel/v1/traces",
       "OTEL_EXPORTER_OTLP_HEADERS": "Authorization=Basic cGstbGYtbG9jYWwtZGV2OnNrLWxmLWxvY2FsLWRldg==",
       "OTEL_SERVICE_NAME": "ralph-hero"
     }
   }
   ```

   Then emit `DEBUG SKIPPED preflight: RALPH_DEBUG not active` and STOP — the user must restart Claude Code.

2. **Langfuse reachability.** Probe the local stack:

   ```bash
   curl -fsS http://localhost:3100/api/public/health || exit 2
   ```

   If the health probe fails, instruct the user to start the local Langfuse stack:

   ```bash
   cd ~/projects/langfuse && ./scripts/up.sh
   ```

   Then emit `DEBUG SKIPPED preflight: Langfuse unreachable` and STOP.

## §Step 2: Parse arguments

Parse `$ARGUMENTS` for optional flags:

- `--since <window>` — lower bound for the trace window. Accepts ISO dates (e.g., `2026-05-01`) or shorthand (`24h`, `7d`). Default: `24h`.
- `--min-occurrences <n>` — minimum number of occurrences for a signature to be reported. Default: `3`.
- `--auto-confirm` — skip the `AskUserQuestion` prompt in §Step 5 and proceed directly to filing. Reserved for the Watcher heartbeat. Do not use in interactive sessions.

Resolve `--since` to an ISO timestamp before calling the tool (e.g., `24h` → 24 hours before now).

## §Step 3: Dry-run

Call `ralph_hero__collate_debug` with:

- `since`: resolved ISO timestamp from §Step 2
- `dryRun`: `true`
- `minOccurrences`: parsed value (or default `3`)

The tool returns a shape like:

```json
{
  "since": "<ISO>",
  "errorGroups": <number>,
  "totalOccurrences": <number>,
  "dryRun": true,
  "groups": [
    {
      "signature": "...",
      "hash": "...",
      "count": <n>,
      "firstSeen": "<ISO>",
      "lastSeen": "<ISO>",
      "exampleTraceUrl": "...",
      "sampleSpans": [...]
    }
  ]
}
```

## §Step 4: Render the dry-run report

If `errorGroups === 0`, emit:

```
DEBUG SKIPPED no-errors-in-window
```

and STOP.

Otherwise pretty-print the **top 5 by `count`**, one block per signature:

```
## Debug Collate — dry run

Window: <since> → now
Total error groups: <errorGroups>
Total occurrences: <totalOccurrences>

### Top 5 by occurrence

1. `<hash>` (count: <n>, first: <firstSeen>, last: <lastSeen>)
   Signature: <signature snippet, truncated to ~120 chars>
   Trace: <exampleTraceUrl>

2. ...
```

If there are more than 5 groups, append:

```
(+<errorGroups - 5> more not shown)
```

## §Step 5: Confirm

**Auto-confirm path.** If `--auto-confirm` is present, skip the prompt and proceed directly to §Step 6. Emit a single line so the transcript records the intent:

```
auto-confirm active — filing debug-auto issues for <errorGroups> signature(s)
```

This path is exercised by the Watcher heartbeat. Interactive sessions must not pass `--auto-confirm` unless the intent is truly unattended.

**Interactive path.** Otherwise invoke `AskUserQuestion` with a single question:

- **question**: `File debug-auto issues for these <errorGroups> signatures?`
- **header**: `File issues?`
- **options**: `Yes — file all <errorGroups>` / `Skip — no issues filed`
- **multiSelect**: `false`

If the user picks `Skip`, emit:

```
DEBUG SKIPPED user-declined
```

and STOP. Do NOT call the tool with `dryRun: false`.

## §Step 6: File issues + summarize

On confirm, call `ralph_hero__collate_debug` again with the same `since` and `minOccurrences`, but `dryRun: false`. The tool returns:

```json
{
  "since": "...",
  "errorGroups": <n>,
  "totalOccurrences": <n>,
  "dryRun": false,
  "issuesCreated": <n>,
  "issuesUpdated": <n>,
  "results": [...],
  "groups": [...]
}
```

Print a one-paragraph summary:

```
## Debug Collate — filed

- <issuesCreated> new `debug-auto` issues created
- <issuesUpdated> existing `debug-auto` issues commented

### Top 3 by occurrence
1. `<hash>` — <count> occurrences — <issue URL or "new">
2. ...
```

Pull issue URLs from `results[]` when available.

Then emit the terminal token (the harness reads this directly — see [outcome-tokens.md](../outcome-tokens.md)):

```
DEBUG FILED <issuesCreated + issuesUpdated>
```

Finally, suggest the next step:

```
Next: run `/ralph:caretake --mode triage` to prioritize the freshly-filed `debug-auto` issues.
```

## §Constraints

- **Interactive by default.** Do not run from autopilot or unattended loops without `--auto-confirm`.
- **Read-only on Langfuse.** The tool only queries observations; never mutates traces.
- **Tool-gated by `RALPH_DEBUG=true`.** If the tool is not registered, §Step 1 STOPs.
- **One Langfuse host.** Defaults to `http://localhost:3100`. To target a different host, set `LANGFUSE_HOST` / `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` in the MCP-server environment.
- **No hook gates this mode.** Debug mode mutates GitHub only via `create_issue` (filtered by `split-size-gate.sh` — but `debug-auto` issues are XS by construction and pass the gate trivially). No state-transition hooks apply.
