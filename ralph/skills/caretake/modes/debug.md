# `--mode debug` — retired

This mode has no implementation. Emit exactly:

```text
DEBUG RETIRED
```

and STOP. Do not file `debug-auto` issues by hand and do not substitute raw `gh`
calls.

For trace investigation, dispatch `Agent(subagent_type="ralph:log-reader", …)` —
the same route `hero/watch-dispatch.md` uses for trace-bearing alerts.
`RALPH_DEBUG=true` still gates JSONL debug logging and OpenTelemetry export in
the MCP server.
