# `--mode debug` — RETIRED

This mode is retired. It wrapped a `RALPH_DEBUG`-gated MCP tool that collated
errors from local Langfuse traces into GitHub `debug-auto` issues; **GH-1612
deleted that tool**, so the mode has no implementation behind it.

```bash
export RALPH_SUBCOMMAND=debug
```

## Behavior

Emit exactly:

```text
DEBUG RETIRED — the trace-collation tool was removed in GH-1612.
```

and STOP. Do not attempt to file `debug-auto` issues by hand, and do not
substitute raw `gh` calls for the removed tool.

## What survives

- `RALPH_DEBUG=true` still gates JSONL debug logging (`debug-logger.ts`) and
  OpenTelemetry export (`telemetry.ts`) in the MCP server. Trace capture is
  unaffected — only the GitHub-issue collation step is gone.
- Langfuse-trace investigation remains available through
  `Agent(subagent_type="ralph:log-reader", …)`, which is what
  `hero/watch-dispatch.md` routes trace-bearing alerts to.

## Removal

The mode row, its dispatch sites, and this file are deleted by GH-1603
(skill surface reduction wave 2). This stub exists only so the intermediate
state on `main` does not instruct an agent to call a tool that no longer
exists.
