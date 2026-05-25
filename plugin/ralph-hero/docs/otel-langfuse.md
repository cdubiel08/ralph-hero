# OpenTelemetry export to local Langfuse

> Referenced from the root `CLAUDE.md` § Environment Variables. This file holds
> the full setup detail so the top-level guide stays concise.

When `RALPH_DEBUG=true` is set alongside the `OTEL_*` env vars below, Claude Code exports `mcp.tool.*` spans, hook events, and session lifecycle traces over OTLP/HTTP. The MCP server (Phase 2+) attaches `ralph_hero.graphql` child spans inside the same trace context. The local Langfuse harness at `~/projects/langfuse/` (documented in `~/projects/CLAUDE.md` under "Local ADK + Langfuse testing harness") is the default ingestion target.

**`RALPH_DEBUG` is the activation switch.** All four `OTEL_*` vars are no-ops when `RALPH_DEBUG` is unset — the MCP server skips OTel SDK initialization entirely and emits zero outbound traffic to `:3100`.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CLAUDE_CODE_ENABLE_TELEMETRY` | No | unset | Set to `"1"` to enable Claude Code's native OpenTelemetry export. Required for Claude Code to emit `mcp.tool.*` and hook spans. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | No | unset | OTLP/HTTP receiver URL. For the local Langfuse harness, use `http://localhost:3100/api/public/otel/v1/traces`. |
| `OTEL_EXPORTER_OTLP_HEADERS` | No | unset | Comma-separated header list passed on every OTLP export. Use this to inject the Langfuse basic-auth header (see below). |
| `OTEL_SERVICE_NAME` | No | unset | Logical service name attached as a resource attribute on every span. Recommended: `claude-code` for the host process, `ralph-hero` for MCP server child spans. |

**Basic-auth header construction.** Langfuse's public OTLP endpoint requires basic auth with the project's public key as username and secret key as password. The default local-dev credentials are `pk-lf-local-dev:sk-lf-local-dev`. Construct the header value once:

```bash
printf '%s' "pk-lf-local-dev:sk-lf-local-dev" | base64
# -> cGstbGYtbG9jYWwtZGV2OnNrLWxmLWxvY2FsLWRldg==
```

Then set `OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic cGstbGYtbG9jYWwtZGV2OnNrLWxmLWxvY2FsLWRldg==`. The literal header value (key + `=` + base64) is what OTel SDKs expect; do not wrap the value in quotes inside the env var.

**Sample `.claude/settings.local.json` snippet.** Copy-paste the `env` block into `~/.claude/settings.json` (user-scoped) or `<project>/.claude/settings.local.json` (project-scoped, gitignored). The endpoint assumes the local Langfuse harness is running on port 3100 (see `~/projects/CLAUDE.md` for stack bring-up: `cd ~/projects/langfuse && ./scripts/up.sh`).

```json
{
  "env": {
    "RALPH_DEBUG": "true",
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "OTEL_EXPORTER_OTLP_ENDPOINT": "http://localhost:3100/api/public/otel/v1/traces",
    "OTEL_EXPORTER_OTLP_HEADERS": "Authorization=Basic cGstbGYtbG9jYWwtZGV2OnNrLWxmLWxvY2FsLWRldg==",
    "OTEL_SERVICE_NAME": "claude-code"
  }
}
```

After editing the settings file, restart Claude Code so the MCP server inherits the new env. With `RALPH_DEBUG` unset (or absent from the `env` block), the MCP server bypasses OTel init regardless of the `OTEL_*` values.
