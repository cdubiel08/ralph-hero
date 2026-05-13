---
description: Collate debug errors from Langfuse — run a dry-run, present grouped error signatures, and on confirmation file `debug-auto` issues (or comment on existing ones) for self-healing observability. Closes the OTel → Langfuse → GitHub feedback loop with a single command.
argument-hint: "[optional: --since 24h] [--min-occurrences 3]"
context: fork
model: sonnet
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh RALPH_COMMAND=debug-collate"
allowed-tools:
  - Bash
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__collate_debug
---

# Ralph Debug Collate

Wrap the `ralph_hero__collate_debug` MCP tool with a preflight → dry-run → confirm → file → summarize workflow. Interactive: requires a human confirm before mutating GitHub.

## Workflow

### Step 1: Preflight

Verify the local environment is ready:

1. **Check `RALPH_DEBUG=true`** is active in the MCP-server environment. The `collate_debug` tool is only registered when this env var is `"true"` (see `src/index.ts`). If the tool is not available, instruct the user to add the following to `~/.claude/settings.json` (or `<project>/.claude/settings.local.json`) and restart Claude Code:

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

   Then STOP — the user must restart Claude Code to pick up the env vars.

2. **Check Langfuse reachability** with:

   ```bash
   curl -fsS http://localhost:3100/api/public/health || exit 2
   ```

   If the health probe fails, instruct the user to start the local Langfuse stack:

   ```bash
   cd ~/projects/langfuse && ./scripts/up.sh
   ```

   Then STOP.

### Step 2: Parse Arguments

Parse the argument string for optional flags:

- `--since <window>`: Lower bound for the trace window. Accepts ISO dates (e.g., `2026-05-01`) or shorthand (`24h`, `7d`). Default: `24h`.
- `--min-occurrences <n>`: Minimum number of occurrences for a signature to be reported. Default: `3`.

Resolve `--since` to an ISO timestamp before calling the tool (e.g., `24h` → 24 hours before now).

### Step 3: Dry-Run

Call `ralph_hero__collate_debug` with:

- `since`: resolved ISO timestamp from Step 2
- `dryRun`: `true`
- `minOccurrences`: parsed value (or default `3`)

The tool returns:

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

### Step 4: Render the Report

If `errorGroups === 0`:

```
No errors in window — nothing to file.
```

Then STOP.

Otherwise, pretty-print the **top 5 by `count`**, one block per signature:

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

### Step 5: Confirm

Ask the user explicitly:

```
File `debug-auto` issues for these <errorGroups> signatures? [y/N]
```

This skill is **interactive** — it is not part of autopilot and must not auto-confirm. If the user declines (any answer that is not `y` / `yes`), exit cleanly:

```
Skipped — no issues filed.
```

Then STOP.

### Step 6: File Issues

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

### Step 7: Summarize

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

### Step 8: Suggest Next Step

Print:

```
Next: run `/ralph-hero:ralph-triage` to prioritize the freshly-filed `debug-auto` issues.
```

## Constraints

- Interactive only — do not run from autopilot or unattended loops.
- Read-only on Langfuse — the tool only queries observations, never mutates traces.
- Tool-gated by `RALPH_DEBUG=true`. If the tool is not registered, the skill cannot proceed (Step 1 handles this).
- One Langfuse host: defaults to `http://localhost:3100`. To target a different host, set `LANGFUSE_HOST` / `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` in the MCP-server environment.
